import { kv } from '@vercel/kv';
import { json, getSessionId } from '../../_helpers.js';
import { checkTimeouts, startDealing, BETTING_TIMEOUT } from '../[id].js';

export const config = { runtime: 'edge' };

const DEFAULT_BANKROLL = 500000; // 500K sats par défaut

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

    // Vérifier le solde du joueur
    const playerKey = `player:${sessionId}`;
    const player = await kv.get(playerKey);
    if (!player || player.balance < amount) {
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

    // Vérifier la bankroll de la maison
    let bankroll = await kv.get('house:bankroll');
    if (bankroll === null) {
      bankroll = DEFAULT_BANKROLL;
      await kv.set('house:bankroll', bankroll);
    }

    if (bankroll < totalExposure) {
      // Calculer la mise max acceptable
      const otherExposure = totalExposure - amount * 8;
      const maxAcceptable = Math.floor((bankroll - otherExposure) / 8);
      if (maxAcceptable < table.minBet) {
        return json(400, { error: 'La banque ne peut pas couvrir cette mise actuellement' });
      }
      return json(400, { error: `Mise max acceptée: ${maxAcceptable} sats (bankroll limitée)` });
    }

    // Débiter le joueur
    player.balance -= amount;
    await kv.set(playerKey, player, { ex: 2592000 });

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
    await kv.set(tableKey, table, { ex: 86400 });

    return json(200, { success: true, bet: amount, balance: player.balance });
  } finally {
    await kv.del(lockKey);
  }
}
