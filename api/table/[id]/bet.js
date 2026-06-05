import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit, normalizePlayer, withPlayerLock } from '../../_helpers.js';
import { checkTimeouts, startDealing, creditPlayers, BETTING_TIMEOUT } from '../[id].js';

export const config = { runtime: 'edge' };

const DEFAULT_BANKROLL = 500000; // 500K sats par défaut

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'bet', 20, 60);
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
  const amount = parseInt(body.amount);

  const lockKey = `lock:table:${tableId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!locked) return json(429, { error: 'Table occupée, réessayez' });

  try {
    const tableKey = `table:${tableId}`;
    const table = await kv.get(tableKey);
    if (!table) return json(404, { error: 'Table non trouvée' });

    // Vérifier timeouts
    checkTimeouts(table);

    // Vérifier phase
    if (!['waiting', 'betting'].includes(table.status)) {
      return json(400, { error: 'Impossible de miser maintenant' });
    }

    // Trouver le siège du joueur
    const seatIdx = table.seats.findIndex(s => s && s.sessionId === sessionId);
    if (seatIdx < 0) {
      return json(400, { error: 'Vous n\'êtes pas assis' });
    }

    const seat = table.seats[seatIdx];
    if (seat.bet > 0) {
      return json(400, { error: 'Vous avez déjà misé' });
    }

    // Valider le montant
    if (!amount || amount < table.minBet || amount > table.maxBet) {
      return json(400, { error: `Mise invalide (${table.minBet}-${table.maxBet} sats)` });
    }

    // Resoudre session -> linkingKey
    const linkingKey = seat.linkingKey || await kv.get(`session:${sessionId}`);
    if (!linkingKey) return json(401, { error: 'Session invalide', auth_required: true });

    // Pré-vérification du solde (UX rapide; le check autoritaire est refait
    // sous verrou au moment du débit).
    const playerKey = `player:${linkingKey}`;
    const preview = normalizePlayer(await kv.get(playerKey));
    if (!preview || preview.balance < amount) {
      return json(400, { error: 'Solde insuffisant' });
    }

    // ---- INTELLIGENCE BANQUE ----
    // Calculer l'exposition totale si on accepte cette mise
    let totalExposure = amount * 8; // worst case: 4 splits × 2x payout
    for (const s of table.seats) {
      if (s && s.bet > 0) {
        totalExposure += s.bet * 8;
      }
    }

    // Vérifier la bankroll de la maison. Init race-safe via SET NX (deux bets
    // concurrents ne peuvent plus initialiser deux valeurs différentes).
    // NOTE: ce gate vérifie l'exposition mais ne RÉSERVE pas la bankroll —
    // deux grosses mises sur deux tables peuvent passer simultanément (TOCTOU
    // inter-tables, risque de solvabilité maison, pas de vol joueur). Une vraie
    // réservation nécessiterait un ledger house:reserved libéré sur tous les
    // chemins de settle/timeout — à concevoir séparément.
    await kv.set('house:bankroll', DEFAULT_BANKROLL, { nx: true });
    let bankroll = await kv.get('house:bankroll');
    if (bankroll === null) bankroll = DEFAULT_BANKROLL;

    if (bankroll < totalExposure) {
      // Calculer la mise max acceptable
      const otherExposure = totalExposure - amount * 8;
      const maxAcceptable = Math.floor((bankroll - otherExposure) / 8);
      if (maxAcceptable < table.minBet) {
        return json(400, { error: 'La banque ne peut pas couvrir cette mise actuellement' });
      }
      return json(400, { error: `Mise max acceptée: ${maxAcceptable} sats (bankroll limitée)` });
    }

    // Débit sous VERROU SOLDE (check + debit atomiques). On NE tient PAS ce
    // verrou pendant creditPlayers() plus bas (qui acquiert lock:player:*) —
    // withPlayerLock relâche avant de rendre la main → pas de self-deadlock.
    let playerBalanceAfter;
    try {
      const dres = await withPlayerLock(linkingKey, async () => {
        const player = normalizePlayer(await kv.get(playerKey));
        if (!player || player.balance < amount) return { insufficient: true };
        player.balance -= amount;
        await kv.set(playerKey, player, { ex: 2592000 });
        return { balance: player.balance };
      });
      if (dres.insufficient) return json(400, { error: 'Solde insuffisant' });
      playerBalanceAfter = dres.balance;
    } catch (e) {
      if (e.code === 'PLAYER_LOCKED') return json(429, { error: 'Solde occupé par une autre action, réessayez' });
      throw e;
    }

    // Enregistrer la mise
    seat.bet = amount;
    seat.finished = false;

    // Si c'est la première mise, démarrer le timer de betting
    if (table.status === 'waiting') {
      table.status = 'betting';
      table.bettingStartedAt = Date.now();
      table.roundNumber++;
    }

    // Vérifier si tous les joueurs assis ont misé → démarrer immédiatement
    const seatedPlayers = table.seats.filter(s => s !== null);
    const allBet = seatedPlayers.every(s => s.bet > 0);
    if (allBet && seatedPlayers.length > 0) {
      startDealing(table);
    }

    table.lastUpdate = Date.now();
    // Sauvegarde du tableau sous try/catch avec rollback du debit. Si la
    // sauvegarde echoue (timeout, KV down), le joueur est debite mais sa
    // mise n'est pas enregistree → sur retry il rebet et est debite 2x.
    try {
      await kv.set(tableKey, table, { ex: 604800 });
    } catch (err) {
      console.error(`[BET] table save failed for ${tableId}, rolling back ${amount} sats for ${linkingKey}:`, err);
      try {
        await withPlayerLock(linkingKey, async () => {
          const freshPlayer = await kv.get(playerKey);
          if (freshPlayer) {
            freshPlayer.balance = (freshPlayer.balance || 0) + amount;
            await kv.set(playerKey, freshPlayer, { ex: 2592000 });
          }
        });
      } catch (rollbackErr) {
        console.error(`[BET] CRITICAL: rollback FAILED for ${linkingKey}, lost ${amount} sats:`, rollbackErr);
      }
      return json(500, { error: 'Mise échouée, solde restauré. Réessayez.' });
    }

    // Si le round s'est terminé pendant la distribution (BJ dealer/joueur)
    if (table.status === 'finished') {
      await creditPlayers(table);
      await kv.set(tableKey, table, { ex: 604800 });

      // Relire le solde mis à jour après crédit
      const updatedPlayer = await kv.get(playerKey);
      if (updatedPlayer) {
        playerBalanceAfter = updatedPlayer.balance;
      }
    }

    return json(200, { success: true, bet: amount, balance: playerBalanceAfter });
  } finally {
    await kv.del(lockKey);
  }
}
