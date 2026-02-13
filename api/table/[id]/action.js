import { kv } from '@vercel/kv';
import { json, getSessionId } from '../../_helpers.js';
import { handScore, isPair } from '../../_game-helpers.js';
import { checkTimeouts, advanceToNextPlayer, creditPlayers, tableStateForClient } from '../[id].js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const tableId = pathParts[pathParts.length - 2];

  const body = await req.json();
  const { action } = body;

  if (!['hit', 'stand', 'double', 'split'].includes(action)) {
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
      return json(400, { error: 'Vous n\'êtes pas à cette table' });
    }
    if (seatIdx !== table.currentSeatIdx) {
      return json(400, { error: 'Ce n\'est pas votre tour' });
    }

    const seat = table.seats[seatIdx];
    const hand = seat.hands[seat.currentHandIdx];

    if (!hand || hand.finished) {
      return json(400, { error: 'Main déjà terminée' });
    }

    // ===================== HIT =====================
    if (action === 'hit') {
      hand.cards.push(table.deck.pop());
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
      const score = handScore(hand.cards);
      if (score < 9 || score > 11) {
        return json(400, { error: 'Double seulement sur 9-11' });
      }

      // Vérifier le solde
      const playerKey = `player:${sessionId}`;
      const player = await kv.get(playerKey);
      if (!player || player.balance < hand.bet) {
        return json(400, { error: 'Solde insuffisant pour doubler' });
      }

      // Débiter le supplément
      player.balance -= hand.bet;
      await kv.set(playerKey, player, { ex: 2592000 });

      hand.bet *= 2;
      hand.cards.push(table.deck.pop());
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

      const playerKey = `player:${sessionId}`;
      const player = await kv.get(playerKey);
      const originalBet = seat.bet; // bet initial de la table

      if (!player || player.balance < originalBet) {
        return json(400, { error: 'Solde insuffisant pour split' });
      }

      // Débiter
      player.balance -= originalBet;
      await kv.set(playerKey, player, { ex: 2592000 });

      const card1 = hand.cards[0];
      const card2 = hand.cards[1];

      seat.hands[seat.currentHandIdx] = {
        cards: [card1, table.deck.pop()],
        bet: originalBet,
        finished: false,
        result: null
      };

      seat.hands.splice(seat.currentHandIdx + 1, 0, {
        cards: [card2, table.deck.pop()],
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
    await kv.set(tableKey, table, { ex: 86400 });

    // Si la round est finie, créditer les joueurs
    if (table.status === 'finished') {
      await creditPlayers(table);
      await kv.set(tableKey, table, { ex: 86400 });
    }

    return json(200, tableStateForClient(table, sessionId));
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
