import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit, normalizePlayer, withPlayerLock } from '../../_helpers.js';
import { handScore, isPair, drawCard, isBlackjack } from '../../_game-helpers.js';
import { checkTimeouts, advanceToNextPlayer, creditPlayers, tableStateForClient } from '../[id].js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'action', 60, 60);
  if (rl) return rl;

  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const tableId = pathParts[pathParts.length - 2];

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { error: 'Body JSON invalide' });
  }
  const { action } = body;

  if (!['hit', 'stand', 'double', 'split', 'insurance', 'surrender'].includes(action)) {
    return json(400, { error: 'Action invalide' });
  }

  const lockKey = `lock:table:${tableId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!locked) return json(429, { error: 'Action en cours, réessayez' });

  try {
    const tableKey = `table:${tableId}`;
    const table = await kv.get(tableKey);
    if (!table) return json(404, { error: 'Table non trouvée' });

    // Check timeouts (peut changer le currentSeatIdx)
    checkTimeouts(table);

    if (table.status !== 'playing') {
      return json(400, { error: 'Pas en phase de jeu' });
    }

    // Vérifier que c'est bien le tour de ce joueur
    const seatIdx = table.seats.findIndex(s => s && s.sessionId === sessionId);
    if (seatIdx < 0) {
      return json(400, { error: 'Vous n\'etes pas a cette table' });
    }
    if (seatIdx !== table.currentSeatIdx) {
      return json(400, { error: 'Ce n\'est pas votre tour' });
    }

    const seat = table.seats[seatIdx];
    // Resoudre linkingKey pour acces au solde
    const linkingKey = seat.linkingKey || await kv.get(`session:${sessionId}`);
    if (!linkingKey) return json(401, { error: 'Session invalide', auth_required: true });
    const resolvedPlayerKey = `player:${linkingKey}`;

    const hand = seat.hands[seat.currentHandIdx];

    if (!hand || hand.finished) {
      return json(400, { error: 'Main déjà terminée' });
    }

    // Tracker des debits/credits pour rollback si le kv.set du tableau echoue
    // a la fin. Sans ca, un debit (insurance, double, split, surrender) cote
    // player KV pouvait reussir alors que le tableau n'etait pas sauvegarde
    // → joueur paie deux fois sur retry.
    let netDebit = 0; // delta a annuler en cas de rollback (positif = debit)

    // ===================== INSURANCE =====================
    if (action === 'insurance') {
      // L'assurance doit être sur les 2 premières cartes, dealer montre un As
      if (hand.cards.length !== 2 || seat.hands.length > 1) {
        return json(400, { error: 'Assurance non disponible' });
      }
      if (!table.dealerHand || table.dealerHand[0].value !== 'A') {
        return json(400, { error: 'Assurance seulement quand le dealer montre un As' });
      }
      if (seat.insuranceBet !== undefined) {
        return json(400, { error: 'Assurance déjà prise/refusée' });
      }

      const accept = body.accept !== false;
      const insuranceCost = Math.floor(hand.bet / 2);

      if (accept) {
        const ok = await withPlayerLock(linkingKey, async () => {
          const player = normalizePlayer(await kv.get(resolvedPlayerKey));
          if (!player || player.balance < insuranceCost) return false;
          player.balance -= insuranceCost;
          await kv.set(resolvedPlayerKey, player, { ex: 2592000 });
          return true;
        });
        if (!ok) return json(400, { error: 'Solde insuffisant pour l\'assurance' });
        seat.insuranceBet = insuranceCost;
        netDebit += insuranceCost;
      } else {
        seat.insuranceBet = 0; // refusé
      }

      // Vérifier si le dealer a blackjack
      if (isBlackjack(table.dealerHand)) {
        // Insurance gagne 2:1
        if (seat.insuranceBet > 0) {
          const insurancePayout = seat.insuranceBet * 3;
          const applied = await withPlayerLock(linkingKey, async () => {
            const player = normalizePlayer(await kv.get(resolvedPlayerKey));
            if (!player) return 0;
            player.balance += insurancePayout;
            await kv.set(resolvedPlayerKey, player, { ex: 2592000 });
            return insurancePayout;
          });
          netDebit -= applied; // un credit reduit la dette de rollback
          seat.insuranceResult = 'win';
        }
        // Main perd (ou push si joueur aussi BJ)
        if (isBlackjack(hand.cards)) {
          hand.result = 'push';
        } else {
          hand.result = 'loss';
        }
        hand.finished = true;
        seat.finished = true;
        advanceToNextPlayer(table);
      }

      table.turnStartedAt = Date.now();
    }

    // ===================== SURRENDER =====================
    if (action === 'surrender') {
      if (hand.cards.length !== 2 || seat.hands.length > 1) {
        return json(400, { error: 'Abandon seulement sur les 2 premières cartes' });
      }

      // Rembourser la moitié de la mise
      const refund = Math.floor(hand.bet / 2);
      const applied = await withPlayerLock(linkingKey, async () => {
        const player = normalizePlayer(await kv.get(resolvedPlayerKey));
        if (!player) return 0;
        player.balance += refund;
        await kv.set(resolvedPlayerKey, player, { ex: 2592000 });
        return refund;
      });
      netDebit -= applied; // refund est un credit

      hand.finished = true;
      hand.result = 'surrender';
      seat.finished = true;
      advanceToNextPlayer(table);
    }

    // ===================== HIT =====================
    if (action === 'hit') {
      hand.cards.push(drawCard(table.deck));
      const score = handScore(hand.cards);

      if (score > 21) {
        hand.finished = true;
        hand.result = 'bust';
        advanceHandOrPlayer(table, seat);
      } else if (score === 21) {
        hand.finished = true;
        advanceHandOrPlayer(table, seat);
      }

      table.turnStartedAt = Date.now();
    }

    // ===================== STAND =====================
    if (action === 'stand') {
      hand.finished = true;
      advanceHandOrPlayer(table, seat);
    }

    // ===================== DOUBLE =====================
    if (action === 'double') {
      if (hand.cards.length !== 2) {
        return json(400, { error: 'Double seulement sur 2 cartes' });
      }

      // Débiter le supplément sous verrou solde (check + debit atomiques)
      const doubleDebit = hand.bet;
      const okDouble = await withPlayerLock(linkingKey, async () => {
        const player = normalizePlayer(await kv.get(resolvedPlayerKey));
        if (!player || player.balance < doubleDebit) return false;
        player.balance -= doubleDebit;
        await kv.set(resolvedPlayerKey, player, { ex: 2592000 });
        return true;
      });
      if (!okDouble) return json(400, { error: 'Solde insuffisant pour doubler' });
      netDebit += doubleDebit;

      hand.bet *= 2;
      hand.cards.push(drawCard(table.deck));
      hand.finished = true;

      if (handScore(hand.cards) > 21) {
        hand.result = 'bust';
      }

      advanceHandOrPlayer(table, seat);
    }

    // ===================== SPLIT =====================
    if (action === 'split') {
      if (!isPair(hand.cards)) {
        return json(400, { error: 'Split seulement sur une paire' });
      }
      if (seat.hands.length >= 4) {
        return json(400, { error: 'Maximum 4 mains' });
      }

      const originalBet = seat.bet; // bet initial de la table

      // Débit du split sous verrou solde (check + debit atomiques)
      const okSplit = await withPlayerLock(linkingKey, async () => {
        const player = normalizePlayer(await kv.get(resolvedPlayerKey));
        if (!player || player.balance < originalBet) return false;
        player.balance -= originalBet;
        await kv.set(resolvedPlayerKey, player, { ex: 2592000 });
        return true;
      });
      if (!okSplit) return json(400, { error: 'Solde insuffisant pour split' });
      netDebit += originalBet;

      const card1 = hand.cards[0];
      const card2 = hand.cards[1];

      seat.hands[seat.currentHandIdx] = {
        cards: [card1, drawCard(table.deck)],
        bet: originalBet,
        finished: false,
        result: null
      };

      seat.hands.splice(seat.currentHandIdx + 1, 0, {
        cards: [card2, drawCard(table.deck)],
        bet: originalBet,
        finished: false,
        result: null
      });

      // Si la première main fait 21, passer à la suivante
      if (handScore(seat.hands[seat.currentHandIdx].cards) === 21) {
        seat.hands[seat.currentHandIdx].finished = true;
        advanceHandOrPlayer(table, seat);
      }

      table.turnStartedAt = Date.now();
    }

    table.lastUpdate = Date.now();
    // Sauvegarde du tableau avec rollback du netDebit cumule pour cette
    // action (insurance/double/split/surrender debitent/creditent le joueur
    // AVANT la sauvegarde du tableau). Sans ce filet, un kv.set qui throw
    // laisse les KV joueur+tableau desynchronisees: les sats sortent du
    // solde mais l'action n'est pas enregistree → joueur peut rejouer
    // l'action et payer 2x.
    try {
      await kv.set(tableKey, table, { ex: 604800 });
    } catch (err) {
      console.error(`[ACTION] table save failed for ${tableId} (action=${action}), rolling back netDebit=${netDebit} for ${linkingKey}:`, err);
      if (netDebit !== 0) {
        try {
          await withPlayerLock(linkingKey, async () => {
            const freshPlayer = await kv.get(resolvedPlayerKey);
            if (freshPlayer) {
              freshPlayer.balance = (freshPlayer.balance || 0) + netDebit;
              await kv.set(resolvedPlayerKey, freshPlayer, { ex: 2592000 });
            }
          });
        } catch (rollbackErr) {
          console.error(`[ACTION] CRITICAL: rollback FAILED for ${linkingKey}, netDebit=${netDebit} sats incoherent:`, rollbackErr);
        }
      }
      return json(500, { error: 'Action échouée, solde restauré. Réessayez.' });
    }

    // Si la round est finie, créditer les joueurs (idempotent via creditKey)
    if (table.status === 'finished') {
      try {
        await creditPlayers(table);
        await kv.set(tableKey, table, { ex: 604800 });
      } catch (err) {
        // Non-fatal: creditPlayers est idempotent, le prochain GET re-tentera
        console.error(`[ACTION] post-finish credit failed (will retry on next GET):`, err);
      }
    }

    return json(200, tableStateForClient(table, sessionId));
  } catch (e) {
    if (e?.code === 'PLAYER_LOCKED') return json(429, { error: 'Solde occupé par une autre action, réessayez' });
    throw e;
  } finally {
    await kv.del(lockKey);
  }
}

function advanceHandOrPlayer(table, seat) {
  // Essayer la main suivante du même joueur
  let nextHandIdx = seat.currentHandIdx + 1;
  while (nextHandIdx < seat.hands.length && seat.hands[nextHandIdx].finished) {
    nextHandIdx++;
  }

  if (nextHandIdx < seat.hands.length) {
    seat.currentHandIdx = nextHandIdx;
    table.turnStartedAt = Date.now();

    if (handScore(seat.hands[nextHandIdx].cards) === 21) {
      seat.hands[nextHandIdx].finished = true;
      advanceHandOrPlayer(table, seat);
    }
  } else {
    // Toutes les mains de ce joueur finies
    seat.finished = true;
    advanceToNextPlayer(table);
  }
}
