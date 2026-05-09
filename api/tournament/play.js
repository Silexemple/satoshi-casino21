import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit } from '../_helpers.js';
import { createAndShuffleDeck, handScore, isBlackjack, cardForClient, drawCard } from '../_game-helpers.js';

export const config = { runtime: 'edge' };

// Tournament blackjack: simplified single-player rounds against the house
// Each round, player bets a fixed amount (10% of chips), plays blackjack
// After all rounds, ranking by chips remaining

const BET_PERCENT = 10; // 10% of current chips per round

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'tplay', 60, 60);
  if (rl) return rl;

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const body = await req.json();
  const { tournamentId, action } = body;

  if (!tournamentId) return json(400, { error: 'ID tournoi manquant' });
  // Validation stricte: format `tourney-${ms}-${4chars}` (cf. create.js & finishTournament)
  // Évite l'usage d'un ID arbitraire comme clé KV (defense in depth, KV ne parse pas les
  // clés mais on ne veut pas qu'un ID malformé pollue les locks ou clés transverses).
  if (!/^tourney-\d{10,}-[a-z0-9]{4}$/.test(tournamentId)) {
    return json(400, { error: 'ID tournoi invalide' });
  }

  // Resoudre linkingKey une seule fois
  const currentLinkingKey = await kv.get(`session:${sessionId}`);

  // Chercher le joueur par sessionId OU linkingKey (pour compatibilite re-login)
  function findPlayer(players) {
    return players.findIndex(p =>
      p.sessionId === sessionId ||
      (currentLinkingKey && p.linkingKey === currentLinkingKey)
    );
  }

  // Status check - no lock needed, read-only
  if (action === 'status') {
    const tKey = `tournament:${tournamentId}`;
    const tournament = await kv.get(tKey);
    if (!tournament) return json(404, { error: 'Tournoi non trouve' });

    const pIdx = findPlayer(tournament.players);
    const tPlayer = pIdx >= 0 ? tournament.players[pIdx] : null;

    return json(200, {
      tournamentStatus: tournament.status,
      chips: tPlayer ? tPlayer.chips : 0,
      roundsPlayed: tPlayer ? tPlayer.roundsPlayed : 0,
      totalRounds: tournament.totalRounds,
      busted: tPlayer ? tPlayer.busted : false,
      leaderboard: tournament.status === 'finished' ? tournament.leaderboard : null,
      myRank: tPlayer ? tPlayer.rank : null,
      myPrize: tPlayer ? (tPlayer.prize || 0) : 0
    });
  }

  // Lock par tournoi (pas par-session) : les actions modifient un document
  // partagé (tournament.players[]) avec read-modify-write. Un lock par-session
  // permettait à 2 joueurs concurrents de lost-update mutuellement, et de
  // skip finishTournament() (chacun voit l'autre comme pas-encore-fini dans
  // sa copie locale stale). Sérialise tous les writes du tournoi.
  // 8 joueurs × 1s/action ≈ 8s d'attente max — acceptable au temps humain.
  const lockKey = `lock:tplay:${tournamentId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!locked) return json(429, { error: 'Action en cours, réessayez' });

  try {
    const tKey = `tournament:${tournamentId}`;
    const tournament = await kv.get(tKey);
    if (!tournament) return json(404, { error: 'Tournoi non trouve' });

    if (tournament.status !== 'running') {
      return json(400, { error: 'Tournoi pas en cours' });
    }

    const pIdx = findPlayer(tournament.players);
    if (pIdx < 0) return json(400, { error: 'Vous n\'etes pas inscrit' });

    const tPlayer = tournament.players[pIdx];
    if (tPlayer.busted) return json(400, { error: 'Vous etes elimine' });

    // Game state for this player in this tournament (use linkingKey for cross-session stability)
    const gsKey = `tgame:${tournamentId}:${currentLinkingKey || sessionId}`;

    // ===================== DEAL =====================
    if (action === 'deal') {
      if (tPlayer.roundsPlayed >= tournament.totalRounds) {
        await checkTournamentEnd(tournament);
        await kv.set(tKey, tournament, { ex: 86400 });
        return json(400, { error: 'Tous vos rounds sont termines', tournamentStatus: tournament.status });
      }

      const existing = await kv.get(gsKey);
      if (existing && existing.status === 'playing') {
        return json(400, { error: 'Round en cours' });
      }

      const bet = Math.max(10, Math.floor(tPlayer.chips * BET_PERCENT / 100));
      if (tPlayer.chips < bet) {
        tPlayer.busted = true;
        await checkTournamentEnd(tournament);
        await kv.set(tKey, tournament, { ex: 86400 });
        return json(200, {
          status: 'busted', chips: tPlayer.chips, message: 'Plus assez de jetons!',
          tournamentStatus: tournament.status,
          leaderboard: tournament.status === 'finished' ? tournament.leaderboard : null,
          myRank: tPlayer.rank, myPrize: tPlayer.prize || 0
        });
      }

      const deck = createAndShuffleDeck();
      const pHand = [drawCard(deck), drawCard(deck)];
      const dHand = [drawCard(deck), drawCard(deck)];

      tPlayer.chips -= bet;

      const gs = {
        deck, bet,
        playerHand: pHand,
        dealerHand: dHand,
        status: 'playing'
      };

      // Dealer BJ
      if (dHand[0].num >= 10 && isBlackjack(dHand)) {
        if (isBlackjack(pHand)) {
          tPlayer.chips += bet;
          gs.status = 'finished'; gs.result = 'push';
        } else {
          tPlayer.totalLost += bet;
          gs.status = 'finished'; gs.result = 'loss';
        }
        tPlayer.roundsPlayed++;
        if (tPlayer.chips <= 0) tPlayer.busted = true;
        await checkTournamentEnd(tournament);
        await kv.set(tKey, tournament, { ex: 86400 });
        await kv.set(gsKey, gs, { ex: 3600 });
        return json(200, tournamentGameResponse(gs, tPlayer, tournament));
      }

      // Player BJ
      if (isBlackjack(pHand)) {
        const payout = Math.floor(bet * 2.5);
        tPlayer.chips += payout;
        tPlayer.totalWon += payout - bet;
        gs.status = 'finished'; gs.result = 'bj';
        tPlayer.roundsPlayed++;
        await checkTournamentEnd(tournament);
        await kv.set(tKey, tournament, { ex: 86400 });
        await kv.set(gsKey, gs, { ex: 3600 });
        return json(200, tournamentGameResponse(gs, tPlayer, tournament));
      }

      await kv.set(tKey, tournament, { ex: 86400 });
      await kv.set(gsKey, gs, { ex: 3600 });
      return json(200, tournamentGameResponse(gs, tPlayer, tournament));
    }

    // ===================== HIT / STAND =====================
    const gs = await kv.get(gsKey);
    if (!gs || gs.status !== 'playing') {
      return json(400, { error: 'Pas de round en cours' });
    }

    if (action === 'hit') {
      gs.playerHand.push(drawCard(gs.deck));
      const score = handScore(gs.playerHand);
      if (score > 21) {
        gs.status = 'finished'; gs.result = 'bust';
        tPlayer.totalLost += gs.bet;
        tPlayer.roundsPlayed++;
        if (tPlayer.chips <= 0) tPlayer.busted = true;
        await checkTournamentEnd(tournament);
        await kv.set(tKey, tournament, { ex: 86400 });
        await kv.set(gsKey, gs, { ex: 3600 });
        return json(200, tournamentGameResponse(gs, tPlayer, tournament));
      }
      if (score === 21) {
        return finishDealerPlay(gs, tPlayer, tournament, tKey, gsKey);
      }
      await kv.set(gsKey, gs, { ex: 3600 });
      return json(200, tournamentGameResponse(gs, tPlayer, tournament));
    }

    if (action === 'stand') {
      return finishDealerPlay(gs, tPlayer, tournament, tKey, gsKey);
    }

    return json(400, { error: 'Action invalide (deal, hit, stand, status)' });
  } finally {
    await kv.del(lockKey);
  }
}

async function finishDealerPlay(gs, tPlayer, tournament, tKey, gsKey) {
  // Dealer plays - H17: hits on soft 17
  const isSoft17 = (hand) => {
    const score = handScore(hand);
    if (score !== 17) return false;
    const hardScore = hand.reduce((s,c) => s + (c.value==='A' ? 1 : c.num), 0);
    return hand.some(c => c.value==='A') && hardScore !== 17;
  };
  while (handScore(gs.dealerHand) < 17 || isSoft17(gs.dealerHand)) {
    gs.dealerHand.push(drawCard(gs.deck));
  }

  const pScore = handScore(gs.playerHand);
  const dScore = handScore(gs.dealerHand);

  if (dScore > 21 || pScore > dScore) {
    gs.result = 'win';
    tPlayer.chips += gs.bet * 2;
    tPlayer.totalWon += gs.bet;
  } else if (pScore === dScore) {
    gs.result = 'push';
    tPlayer.chips += gs.bet;
  } else {
    gs.result = 'loss';
    tPlayer.totalLost += gs.bet;
  }

  gs.status = 'finished';
  tPlayer.roundsPlayed++;

  if (tPlayer.chips <= 0) {
    tPlayer.busted = true;
  }

  await checkTournamentEnd(tournament);

  await kv.set(tKey, tournament, { ex: 86400 });
  await kv.set(gsKey, gs, { ex: 3600 });
  return json(200, tournamentGameResponse(gs, tPlayer, tournament));
}

async function checkTournamentEnd(tournament) {
  const allDone = tournament.players.every(p =>
    p.busted || p.roundsPlayed >= tournament.totalRounds
  );

  if (allDone) {
    await finishTournament(tournament);
  }
}

async function finishTournament(tournament) {
  // Rank players by chips
  const ranked = [...tournament.players]
    .sort((a, b) => b.chips - a.chips);

  ranked.forEach((p, i) => { p.rank = i + 1; });
  tournament.leaderboard = ranked.map(p => ({
    nickname: p.nickname,
    chips: p.chips,
    rank: p.rank,
    roundsPlayed: p.roundsPlayed
  }));

  // Distribute prizes based on player count
  const prizePool = tournament.players.length * tournament.buyIn;
  let prizes;

  if (ranked.length === 1) {
    prizes = [prizePool];
  } else if (ranked.length === 2) {
    prizes = [Math.floor(prizePool * 0.7), prizePool - Math.floor(prizePool * 0.7)];
  } else {
    // 60% first, 30% second, 10% third
    const p1 = Math.floor(prizePool * 0.6);
    const p2 = Math.floor(prizePool * 0.3);
    prizes = [p1, p2, prizePool - p1 - p2];
  }

  for (let i = 0; i < Math.min(prizes.length, ranked.length); i++) {
    const p = ranked[i];
    if (prizes[i] <= 0) continue;

    // Resoudre linkingKey (stocke a l'inscription, fallback session)
    const lk = p.linkingKey || await kv.get(`session:${p.sessionId}`);
    if (!lk) {
      // Session expiree ET pas de linkingKey: impossible de creditrer.
      // On NE met PAS p.prize pour ne pas mentir au frontend (le joueur
      // verrait "vous avez gagne X sats" sans credit BDD).
      console.error(`[TOURNAMENT] cannot credit prize: no linkingKey for player rank ${i+1} in ${tournament.id} (prize=${prizes[i]})`);
      p.prizeUncredited = prizes[i]; // marqueur pour audit/recovery offline
      continue;
    }

    const pk = `player:${lk}`;
    try {
      const player = await kv.get(pk);
      if (!player) {
        console.error(`[TOURNAMENT] player ${lk} not found, prize ${prizes[i]} uncredited (tournament=${tournament.id})`);
        p.prizeUncredited = prizes[i];
        continue;
      }
      player.balance += prizes[i];
      player.last_activity = Date.now();
      await kv.set(pk, player, { ex: 2592000 });

      const txKey = `transactions:${lk}`;
      await kv.rpush(txKey, {
        type: 'tournament_prize',
        amount: prizes[i],
        timestamp: Date.now(),
        description: `${tournament.name} - ${i + 1}${i === 0 ? 'er' : 'eme'} place`
      });
      await kv.expire(txKey, 2592000);

      // Marquer le prix UNIQUEMENT apres credit reussi.
      // Le frontend lit p.prize pour afficher "VOUS AVEZ GAGNE X SATS" — ne le
      // setter qu'en cas de succes evite le mensonge UI/BDD.
      p.prize = prizes[i];
    } catch (err) {
      console.error(`[TOURNAMENT] credit failed for ${lk}, prize ${prizes[i]} uncredited:`, err);
      p.prizeUncredited = prizes[i];
    }
  }

  tournament.status = 'finished';
  tournament.finishedAt = Date.now();

  // Auto-archiver et relancer un nouveau tournoi du même template
  try {
    // Retirer de la liste active
    await kv.srem('tournaments:active', tournament.id);

    // Archiver les résultats (7 jours)
    await kv.set(`tournament:archive:${tournament.id}`, {
      name: tournament.name,
      finishedAt: tournament.finishedAt,
      prizePool: tournament.players.length * tournament.buyIn,
      leaderboard: tournament.leaderboard
    }, { ex: 604800 });

    // Créer un nouveau tournoi du même template dans 5 minutes
    const newId = `tourney-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const newTournament = {
      id: newId,
      name: tournament.name,
      buyIn: tournament.buyIn,
      startingChips: tournament.startingChips,
      totalRounds: tournament.totalRounds,
      maxPlayers: tournament.maxPlayers,
      minPlayers: tournament.minPlayers || 2,
      players: [],
      leaderboard: [],
      status: 'registering',
      startTime: null,
      currentRound: 0,
      createdAt: Date.now()
    };
    await kv.set(`tournament:${newId}`, newTournament, { ex: 86400 });
    await kv.sadd('tournaments:active', newId);
  } catch(e) {
    console.error('Auto-restart tournament failed:', e);
  }
}

function tournamentGameResponse(gs, tPlayer, tournament) {
  const resp = {
    status: gs.status,
    result: gs.result || null,
    playerHand: gs.playerHand.map(cardForClient),
    playerScore: handScore(gs.playerHand),
    bet: gs.bet,
    chips: tPlayer.chips,
    roundsPlayed: tPlayer.roundsPlayed,
    totalRounds: tournament.totalRounds,
    busted: tPlayer.busted || false,
    tournamentStatus: tournament.status
  };

  if (gs.status === 'finished') {
    resp.dealerHand = gs.dealerHand.map(cardForClient);
    resp.dealerScore = handScore(gs.dealerHand);
  } else {
    resp.dealerUpCard = cardForClient(gs.dealerHand[0]);
  }

  if (tournament.status === 'finished') {
    resp.leaderboard = tournament.leaderboard;
    const me = tournament.players.find(p => p.sessionId === tPlayer.sessionId);
    resp.myRank = me ? me.rank : null;
    resp.myPrize = me ? me.prize : 0;
  }

  return resp;
}
