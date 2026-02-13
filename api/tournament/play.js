import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';
import { createAndShuffleDeck, handScore, isBlackjack, cardForClient } from '../_game-helpers.js';

export const config = { runtime: 'edge' };

// Tournament blackjack: simplified single-player rounds against the house
// Each round, player bets a fixed amount (10% of chips), plays blackjack
// After all rounds, ranking by chips remaining

const BET_PERCENT = 10; // 10% of current chips per round

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const body = await req.json();
  const { tournamentId, action } = body;

  if (!tournamentId) return json(400, { error: 'ID tournoi manquant' });

  const lockKey = `lock:tplay:${tournamentId}:${sessionId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!locked) return json(429, { error: 'Action en cours' });

  try {
    const tKey = `tournament:${tournamentId}`;
    const tournament = await kv.get(tKey);
    if (!tournament) return json(404, { error: 'Tournoi non trouve' });

    if (tournament.status !== 'running') {
      return json(400, { error: 'Tournoi pas en cours' });
    }

    const pIdx = tournament.players.findIndex(p => p.sessionId === sessionId);
    if (pIdx < 0) return json(400, { error: 'Vous n\'etes pas inscrit' });

    const tPlayer = tournament.players[pIdx];
    if (tPlayer.busted) return json(400, { error: 'Vous etes elimine' });

    // Game state for this player in this tournament
    const gsKey = `tgame:${tournamentId}:${sessionId}`;

    // ===================== DEAL =====================
    if (action === 'deal') {
      if (tPlayer.roundsPlayed >= tournament.totalRounds) {
        return json(400, { error: 'Tous vos rounds sont termines' });
      }

      const existing = await kv.get(gsKey);
      if (existing && existing.status === 'playing') {
        return json(400, { error: 'Round en cours' });
      }

      const bet = Math.max(10, Math.floor(tPlayer.chips * BET_PERCENT / 100));
      if (tPlayer.chips < bet) {
        tPlayer.busted = true;
        await kv.set(tKey, tournament, { ex: 86400 });
        return json(200, { status: 'busted', chips: tPlayer.chips, message: 'Plus assez de jetons!' });
      }

      const deck = createAndShuffleDeck();
      const pHand = [deck.pop(), deck.pop()];
      const dHand = [deck.pop(), deck.pop()];

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
      gs.playerHand.push(gs.deck.pop());
      const score = handScore(gs.playerHand);
      if (score > 21) {
        gs.status = 'finished'; gs.result = 'bust';
        tPlayer.totalLost += gs.bet;
        tPlayer.roundsPlayed++;
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

    return json(400, { error: 'Action invalide (deal, hit, stand)' });
  } finally {
    await kv.del(lockKey);
  }
}

async function finishDealerPlay(gs, tPlayer, tournament, tKey, gsKey) {
  // Dealer plays
  while (handScore(gs.dealerHand) < 17) {
    gs.dealerHand.push(gs.deck.pop());
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

  // Distribute prizes: 60% first, 30% second, 10% third
  const prizePool = tournament.players.length * tournament.buyIn;
  const prizes = [
    Math.floor(prizePool * 0.6),
    Math.floor(prizePool * 0.3),
    prizePool - Math.floor(prizePool * 0.6) - Math.floor(prizePool * 0.3)
  ];

  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const p = ranked[i];
    if (prizes[i] > 0) {
      const pk = `player:${p.sessionId}`;
      const player = await kv.get(pk);
      if (player) {
        player.balance += prizes[i];
        await kv.set(pk, player, { ex: 2592000 });
        await kv.rpush(`transactions:${p.sessionId}`, {
          type: 'tournament_prize',
          amount: prizes[i],
          timestamp: Date.now(),
          description: `${tournament.name} - ${i + 1}${i === 0 ? 'er' : 'eme'} place`
        });
      }
      p.prize = prizes[i];
    }
  }

  tournament.status = 'finished';
  tournament.finishedAt = Date.now();
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
    busted: tPlayer.busted,
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
