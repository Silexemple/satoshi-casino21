import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  // Get active tournament IDs
  const tournamentIds = await kv.smembers('tournaments:active') || [];
  const tournaments = [];

  for (const id of tournamentIds) {
    const t = await kv.get(`tournament:${id}`);
    if (!t) continue;

    // Auto-close expired tournaments (only if startTime is set = someone registered)
    if (t.status === 'registering' && t.startTime && Date.now() > t.startTime) {
      if (t.players.length >= t.minPlayers) {
        t.status = 'running';
        t.currentRound = 1;
        await kv.set(`tournament:${id}`, t, { ex: 86400 });
      } else {
        // Refund all players (utiliser linkingKey stocké à l'inscription, pas sessionId)
        for (const p of t.players) {
          const lk = p.linkingKey || await kv.get(`session:${p.sessionId}`);
          if (!lk) {
            // Session expirée ET pas de linkingKey: refund impossible. Logger
            // pour audit/recovery manuel — un `continue` silencieux faisait
            // disparaitre les sats sans trace.
            console.error(`[TOURNAMENT] refund SKIPPED (no linkingKey) for ${t.id}, lost ${t.buyIn} sats for player ${p.nickname || p.sessionId}`);
            continue;
          }
          const pk = `player:${lk}`;
          try {
            const player = await kv.get(pk);
            if (!player) {
              console.error(`[TOURNAMENT] refund SKIPPED (player not found) for ${t.id}, ${lk}, lost ${t.buyIn} sats`);
              continue;
            }
            player.balance += t.buyIn;
            player.last_activity = Date.now();
            await kv.set(pk, player, { ex: 2592000 });
            const txKey = `transactions:${lk}`;
            await kv.rpush(txKey, {
              type: 'deposit',
              amount: t.buyIn,
              timestamp: Date.now(),
              description: `Remboursement tournoi annulé: ${t.name}`
            });
            await kv.expire(txKey, 2592000);
          } catch (err) {
            console.error(`[TOURNAMENT] refund FAILED for ${lk} on ${t.id}, lost ${t.buyIn} sats:`, err);
          }
        }
        t.status = 'cancelled';
        await kv.set(`tournament:${id}`, t, { ex: 3600 });
        await kv.srem('tournaments:active', id);
        continue;
      }
    }

    const isRegistered = t.players.some(p => p.sessionId === sessionId);

    tournaments.push({
      id: t.id,
      name: t.name,
      buyIn: t.buyIn,
      startingChips: t.startingChips,
      totalRounds: t.totalRounds,
      currentRound: t.currentRound || 0,
      status: t.status,
      playerCount: t.players.length,
      maxPlayers: t.maxPlayers,
      minPlayers: t.minPlayers,
      prizePool: t.players.length * t.buyIn,
      startTime: t.startTime,
      isRegistered
    });
  }

  return json(200, { tournaments });
}
