import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const body = await req.json();
  const { tournamentId } = body;

  if (!tournamentId) return json(400, { error: 'ID tournoi manquant' });

  const lockKey = `lock:tournament:${tournamentId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!locked) return json(429, { error: 'Action en cours' });

  try {
    const tKey = `tournament:${tournamentId}`;
    const tournament = await kv.get(tKey);
    if (!tournament) return json(404, { error: 'Tournoi non trouve' });

    if (tournament.status !== 'registering') {
      return json(400, { error: 'Inscriptions fermees' });
    }

    // Check already registered
    if (tournament.players.some(p => p.sessionId === sessionId)) {
      return json(400, { error: 'Deja inscrit' });
    }

    if (tournament.players.length >= tournament.maxPlayers) {
      return json(400, { error: 'Tournoi plein' });
    }

    // Resoudre session -> linkingKey
    const linkingKey = await kv.get(`session:${sessionId}`);
    if (!linkingKey) return json(401, { error: 'Session invalide' });

    // Check balance
    const playerKey = `player:${linkingKey}`;
    const player = await kv.get(playerKey);
    if (!player) return json(404, { error: 'Joueur non trouve' });

    if (player.balance < tournament.buyIn) {
      return json(400, { error: `Solde insuffisant (buy-in: ${tournament.buyIn} sats)` });
    }

    // Debit buy-in
    player.balance -= tournament.buyIn;
    await kv.set(playerKey, player, { ex: 2592000 });

    // Register player (stocker linkingKey pour distribution des prix)
    tournament.players.push({
      sessionId,
      linkingKey,
      nickname: player.nickname || `Joueur ${tournament.players.length + 1}`,
      chips: tournament.startingChips,
      roundsPlayed: 0,
      totalWon: 0,
      totalLost: 0,
      busted: false,
      rank: null
    });

    // Set start time when first player registers
    if (tournament.players.length === 1) {
      tournament.startTime = Date.now() + tournament.startDelay;
    }

    // Auto-start if full
    if (tournament.players.length >= tournament.maxPlayers) {
      tournament.status = 'running';
      tournament.currentRound = 1;
      tournament.startTime = Date.now();
    }

    await kv.set(tKey, tournament, { ex: 86400 });

    // Log transaction
    const txKey = `transactions:${linkingKey}`;
    await kv.rpush(txKey, {
      type: 'tournament_buyin',
      amount: -tournament.buyIn,
      timestamp: Date.now(),
      description: `Buy-in: ${tournament.name}`
    });
    await kv.expire(txKey, 2592000);

    return json(200, {
      success: true,
      balance: player.balance,
      chips: tournament.startingChips,
      playerCount: tournament.players.length,
      startTime: tournament.startTime
    });
  } finally {
    await kv.del(lockKey);
  }
}
