import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

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
        // Refund all players
        for (const p of t.players) {
          const pk = `player:${p.sessionId}`;
          const player = await kv.get(pk);
          if (player) {
            player.balance += t.buyIn;
            await kv.set(pk, player, { ex: 2592000 });
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
