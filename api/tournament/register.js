import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit, withPlayerLock } from '../_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'treg', 5, 60);
  if (rl) return rl;

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const body = await req.json();
  const { tournamentId } = body;

  if (!tournamentId) return json(400, { error: 'ID tournoi manquant' });
  if (!/^tourney-\d{10,}-[a-z0-9]{4}$/.test(tournamentId)) {
    return json(400, { error: 'ID tournoi invalide' });
  }

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

    // Resoudre session -> linkingKey (necessaire pour le check doublon cross-session)
    const linkingKey = await kv.get(`session:${sessionId}`);
    if (!linkingKey) return json(401, { error: 'Session invalide', auth_required: true });

    // Check already registered (par sessionId OU linkingKey pour eviter les doublons cross-session)
    if (tournament.players.some(p => p.sessionId === sessionId || p.linkingKey === linkingKey)) {
      return json(400, { error: 'Deja inscrit' });
    }

    if (tournament.players.length >= tournament.maxPlayers) {
      return json(400, { error: 'Tournoi plein' });
    }

    // Débit buy-in sous VERROU SOLDE (check + debit atomiques, sérialisé avec
    // jeu/table/retrait/dépôt). buyIn est figé pour le rollback éventuel.
    const playerKey = `player:${linkingKey}`;
    const buyIn = tournament.buyIn;
    let balanceAfter;
    try {
      const dbres = await withPlayerLock(linkingKey, async () => {
        const player = await kv.get(playerKey);
        if (!player) return { code: 404 };
        if (player.balance < buyIn) return { code: 400 };
        player.balance -= buyIn;
        player.last_activity = Date.now();
        await kv.set(playerKey, player, { ex: 2592000 });
        return { balance: player.balance };
      });
      if (dbres.code === 404) return json(404, { error: 'Joueur non trouve' });
      if (dbres.code === 400) return json(400, { error: `Solde insuffisant (buy-in: ${buyIn} sats)` });
      balanceAfter = dbres.balance;
    } catch (e) {
      if (e.code === 'PLAYER_LOCKED') return json(429, { error: 'Action en cours, réessayez' });
      throw e;
    }

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

    // Sauvegarde du tournoi sous try/catch pour rollback du debit en cas
    // d'echec. KV n'est pas transactionnel: si on debite puis kv.set du
    // tournoi throw (timeout, erreur reseau), le joueur perd ses sats sans
    // etre inscrit. Le rollback restaure le solde best-effort, et on log
    // un message critique si meme le rollback echoue (necessite reconciliation
    // manuelle).
    try {
      await kv.set(tKey, tournament, { ex: 86400 });
    } catch (err) {
      console.error(`[TOURNAMENT] register save failed for ${tournamentId}, rolling back debit ${buyIn} sats for ${linkingKey}:`, err);
      try {
        await withPlayerLock(linkingKey, async () => {
          const fresh = await kv.get(playerKey);
          if (fresh) {
            fresh.balance = (fresh.balance || 0) + buyIn;
            fresh.last_activity = Date.now();
            await kv.set(playerKey, fresh, { ex: 2592000 });
          }
        });
      } catch (rollbackErr) {
        console.error(`[TOURNAMENT] CRITICAL: rollback FAILED for ${linkingKey}, lost ${buyIn} sats:`, rollbackErr);
      }
      return json(500, { error: 'Inscription échouée, solde restauré. Réessayez.' });
    }

    // Log transaction (post-success: si rpush echoue, on a tout de meme le
    // tournoi a jour et le solde debite — non-bloquant pour le user)
    const txKey = `transactions:${linkingKey}`;
    try {
      await kv.rpush(txKey, {
        type: 'tournament_buyin',
        amount: -tournament.buyIn,
        timestamp: Date.now(),
        description: `Buy-in: ${tournament.name}`
      });
      await kv.expire(txKey, 2592000);
    } catch (err) {
      console.error(`[TOURNAMENT] tx log failed for ${linkingKey} (non-blocking):`, err);
    }

    return json(200, {
      success: true,
      balance: balanceAfter,
      chips: tournament.startingChips,
      playerCount: tournament.players.length,
      startTime: tournament.startTime
    });
  } finally {
    await kv.del(lockKey);
  }
}
