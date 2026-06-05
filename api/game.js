import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit } from './_helpers.js';
import { createAndShuffleDeck, handScore, isBlackjack, isPair, cardForClient, drawCard, buildProvablyFairDeck, sha256Hex, randomSeedHex } from './_game-helpers.js';

export const config = {
  runtime: 'edge',
};

const RAKE_PERCENT = 2; // 2% commission on net winnings

function applyRake(netGain) {
  if (netGain <= 0) return netGain;
  const rake = Math.max(1, Math.floor(netGain * RAKE_PERCENT / 100));
  return netGain - rake;
}

function getRake(netGain) {
  if (netGain <= 0) return 0;
  return Math.max(1, Math.floor(netGain * RAKE_PERCENT / 100));
}

// --- Handler ---

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'game', 60, 60);
  if (rl) return rl;

  const sessionId = getSessionId(req);
  if (!sessionId) {
    return json(401, { error: 'Session invalide', auth_required: true });
  }

  // Resolve session -> linkingKey
  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide', auth_required: true });

  const playerKey = `player:${linkingKey}`;
  const txKey = `transactions:${linkingKey}`;
  const gameKey = `game_state:${sessionId}`; // ephemeral, keyed by session is fine

  // GET: reprendre une partie en cours
  if (req.method === 'GET') {
    const gs = await kv.get(gameKey);
    const player = await kv.get(playerKey);
    if (!player) return json(404, { error: 'Joueur non trouve' });
    if (!gs || gs.status !== 'playing') {
      return json(200, { status: 'idle', balance: player.balance });
    }
    return json(200, playingResponse(gs, player));
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Rate limit: max 60 actions/min par session
  const rlKey = `ratelimit:game:${sessionId}`;
  await kv.set(rlKey, 0, { nx: true, ex: 60 });
  const rlCount = await kv.incr(rlKey);
  if (rlCount > 60) {
    return json(429, { error: 'Trop de requetes, attendez un instant' });
  }

  // Verrou SOLDE par-joueur (et non par-session): le solde mute ici (mise,
  // payouts) doit être sérialisé avec TOUS les autres sous-systèmes (table,
  // tournoi, dépôt, retrait, tip, session) qui partagent lock:player:{linkingKey}.
  // Un lock par-session laissait 2 sessions du même joueur (ou un retrait
  // concurrent) se lost-update → double dépense.
  const lockKey = `lock:player:${linkingKey}`;
  const lockAcquired = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!lockAcquired) {
    return json(429, { error: 'Action en cours, reessayez' });
  }

  try {
    const body = await req.json();
    const { action, bet_amount } = body;

    if (!['deal', 'hit', 'stand', 'double', 'split', 'insurance', 'surrender'].includes(action)) {
      return json(400, { error: 'Action invalide' });
    }

    const player = await kv.get(playerKey);

    if (!player) {
      return json(404, { error: 'Joueur non trouve' });
    }

    // ===================== DEAL =====================
    if (action === 'deal') {
      const bet = parseInt(bet_amount);
      if (!bet || bet < 100 || bet > 2500) {
        return json(400, { error: 'Mise invalide (100-2500 sats)' });
      }
      if (player.balance < bet) {
        return json(400, { error: 'Solde insuffisant', balance: player.balance });
      }

      const existing = await kv.get(gameKey);
      if (existing && existing.status === 'playing') {
        return json(400, { error: 'Partie déjà en cours' });
      }

      // ── Provably fair: engagement avant la main ──
      // clientSeed fourni par le joueur (sinon aléatoire), nonce monotone par
      // joueur, serverSeed secret jusqu'à la fin. Le deck est mélangé de façon
      // déterministe et vérifiable depuis sha256(serverSeed:clientSeed:nonce).
      const clientSeed = (body.client_seed || '').toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || randomSeedHex(8);
      const nonce = await kv.incr(`pf_nonce:${linkingKey}`);
      const serverSeed = randomSeedHex(32);
      const serverSeedHash = await sha256Hex(serverSeed);
      const deck = await buildProvablyFairDeck({ serverSeed, clientSeed, nonce });
      const pHand = [drawCard(deck), drawCard(deck)];
      const dHand = [drawCard(deck), drawCard(deck)];

      player.balance -= bet;

      const gs = {
        deck, bet,
        pf: { serverSeed, serverSeedHash, clientSeed, nonce },
        playerHands: [{ cards: pHand, bet, finished: false, result: null }],
        dealerHand: dHand,
        currentHandIdx: 0,
        totalBet: bet,
        insuranceBet: 0,
        insuranceResult: null,
        surrendered: false,
        status: 'playing',
        createdAt: Date.now()
      };

      // Check if dealer up card is Ace -> offer insurance
      const dealerUpIsAce = dHand[0].value === 'A';

      // Dealer blackjack check (only if no insurance offered, or handle after insurance)
      if (!dealerUpIsAce && dHand[0].num >= 10 && isBlackjack(dHand)) {
        if (isBlackjack(pHand)) {
          player.balance += bet;
          gs.status = 'finished';
          gs.playerHands[0].result = 'push';
          await save(playerKey, player, gameKey, gs, txKey, 'push', 0);
          return json(200, finishResponse(gs, player, 'push'));
        } else {
          gs.status = 'finished';
          gs.playerHands[0].result = 'loss';
          await save(playerKey, player, gameKey, gs, txKey, 'loss', -bet);
          return json(200, finishResponse(gs, player, 'loss'));
        }
      }

      // Player blackjack (no insurance scenario)
      if (!dealerUpIsAce && isBlackjack(pHand)) {
        const bjPayout = Math.floor(bet * 2.5);
        const netGain = bjPayout - bet;
        const rake = getRake(netGain);
        player.balance += bjPayout - rake;
        gs.status = 'finished';
        gs.playerHands[0].result = 'bj';
        await save(playerKey, player, gameKey, gs, txKey, 'bj', netGain - rake);
        await kv.incrby('house:bankroll', rake);
        return json(200, finishResponse(gs, player, 'bj'));
      }

      // If dealer shows Ace, set phase to 'insurance_offered'
      if (dealerUpIsAce) {
        gs.phase = 'insurance_offered';
      }

      await kv.set(playerKey, player, { ex: 2592000 });
      await kv.set(gameKey, gs, { ex: 3600 });

      const score = handScore(pHand);
      const resp = {
        action: 'deal',
        playerHands: [{ cards: pHand.map(cardForClient), bet, score }],
        dealerUpCard: cardForClient(dHand[0]),
        balance: player.balance,
        canDouble: player.balance >= bet,
        canSplit: isPair(pHand) && player.balance >= bet,
        canInsurance: dealerUpIsAce && player.balance >= Math.floor(bet / 2),
        canSurrender: true,
        status: 'playing',
        provablyFair: { serverSeedHash, clientSeed, nonce } // engagement (serverSeed révélé à la fin)
      };
      return json(200, resp);
    }

    // ===================== INSURANCE =====================
    if (action === 'insurance') {
      const gs = await kv.get(gameKey);
      if (!gs || gs.status !== 'playing') {
        return json(400, { error: 'Aucune partie en cours' });
      }
      if (gs.phase !== 'insurance_offered') {
        return json(400, { error: 'Assurance non disponible' });
      }

      const accept = body.accept !== false; // default true
      const insuranceCost = Math.floor(gs.bet / 2);

      if (accept) {
        if (player.balance < insuranceCost) {
          return json(400, { error: 'Solde insuffisant pour l\'assurance' });
        }
        player.balance -= insuranceCost;
        gs.insuranceBet = insuranceCost;
      }

      gs.phase = null;

      // Now check dealer blackjack
      if (isBlackjack(gs.dealerHand)) {
        // Insurance pays 2:1
        if (gs.insuranceBet > 0) {
          const insurancePayout = gs.insuranceBet * 3; // original bet + 2:1
          player.balance += insurancePayout;
          gs.insuranceResult = 'win';
        }

        // Check player blackjack for push
        if (isBlackjack(gs.playerHands[0].cards)) {
          player.balance += gs.bet; // push on main bet
          gs.status = 'finished';
          gs.playerHands[0].result = 'push';
          const netGain = gs.insuranceBet > 0 ? gs.insuranceBet * 2 : 0;
          await save(playerKey, player, gameKey, gs, txKey,'push', netGain);
          return json(200, finishResponse(gs, player, 'push'));
        } else {
          gs.status = 'finished';
          gs.playerHands[0].result = 'loss';
          const netGain = gs.insuranceBet > 0 ? (gs.insuranceBet * 2 - gs.bet) : -gs.bet;
          await save(playerKey, player, gameKey, gs, txKey,'loss', netGain);
          return json(200, finishResponse(gs, player, 'loss'));
        }
      }

      // Dealer doesn't have blackjack - insurance lost
      if (gs.insuranceBet > 0) {
        gs.insuranceResult = 'loss';
        gs.totalBet += gs.insuranceBet;
      }

      // Check player blackjack
      if (isBlackjack(gs.playerHands[0].cards)) {
        const bjPayout = Math.floor(gs.bet * 2.5);
        const netGain = bjPayout - gs.bet - (gs.insuranceBet || 0);
        const rake = getRake(Math.max(0, netGain));
        player.balance += bjPayout - rake;
        gs.status = 'finished';
        gs.playerHands[0].result = 'bj';
        await save(playerKey, player, gameKey, gs, txKey, 'bj', netGain - rake);
        if (rake > 0) await kv.incrby('house:bankroll', rake);
        return json(200, finishResponse(gs, player, 'bj'));
      }

      await kv.set(playerKey, player, { ex: 2592000 });
      await kv.set(gameKey, gs, { ex: 3600 });
      return json(200, playingResponse(gs, player));
    }

    // ===================== SURRENDER =====================
    if (action === 'surrender') {
      const gs = await kv.get(gameKey);
      if (!gs || gs.status !== 'playing') {
        return json(400, { error: 'Aucune partie en cours' });
      }

      const hand = gs.playerHands[gs.currentHandIdx];
      // Surrender only on initial 2 cards, first hand, no splits
      if (hand.cards.length !== 2 || gs.playerHands.length > 1) {
        return json(400, { error: 'Surrender seulement sur les 2 premières cartes' });
      }

      // Return half the bet
      const refund = Math.floor(hand.bet / 2);
      player.balance += refund;
      hand.finished = true;
      hand.result = 'surrender';
      gs.surrendered = true;
      gs.status = 'finished';

      const netGain = -(hand.bet - refund);
      await save(playerKey, player, gameKey, gs, txKey,'surrender', netGain);
      return json(200, finishResponse(gs, player, 'surrender'));
    }

    // ===================== HIT / STAND / DOUBLE / SPLIT =====================
    const gs = await kv.get(gameKey);
    if (!gs || gs.status !== 'playing') {
      return json(400, { error: 'Aucune partie en cours' });
    }

    // If insurance is still offered, auto-decline
    if (gs.phase === 'insurance_offered') {
      gs.phase = null;
      // Check dealer BJ
      if (isBlackjack(gs.dealerHand)) {
        if (isBlackjack(gs.playerHands[0].cards)) {
          player.balance += gs.bet;
          gs.status = 'finished';
          gs.playerHands[0].result = 'push';
          await save(playerKey, player, gameKey, gs, txKey, 'push', 0);
          return json(200, finishResponse(gs, player, 'push'));
        } else {
          gs.status = 'finished';
          gs.playerHands[0].result = 'loss';
          await save(playerKey, player, gameKey, gs, txKey,'loss', -gs.bet);
          return json(200, finishResponse(gs, player, 'loss'));
        }
      }
      // Check player BJ
      if (isBlackjack(gs.playerHands[0].cards)) {
        const bjPayout = Math.floor(gs.bet * 2.5);
        const netGain = bjPayout - gs.bet;
        const rake = getRake(netGain);
        player.balance += bjPayout - rake;
        gs.status = 'finished';
        gs.playerHands[0].result = 'bj';
        await save(playerKey, player, gameKey, gs, txKey, 'bj', netGain - rake);
        if (rake > 0) await kv.incrby('house:bankroll', rake);
        return json(200, finishResponse(gs, player, 'bj'));
      }
    }

    const hand = gs.playerHands[gs.currentHandIdx];

    if (action === 'hit') {
      hand.cards.push(drawCard(gs.deck));
      const score = handScore(hand.cards);

      if (score > 21) {
        hand.finished = true;
        hand.result = 'bust';
        return await advanceOrFinish(gs, player, playerKey, gameKey, txKey);
      }
      if (score === 21) {
        hand.finished = true;
        return await advanceOrFinish(gs, player, playerKey, gameKey, txKey);
      }

      await kv.set(gameKey, gs, { ex: 3600 });
      return json(200, playingResponse(gs, player));
    }

    if (action === 'stand') {
      hand.finished = true;
      return await advanceOrFinish(gs, player, playerKey, gameKey, txKey);
    }

    if (action === 'double') {
      if (hand.cards.length !== 2) {
        return json(400, { error: 'Double seulement sur 2 cartes' });
      }
      if (player.balance < hand.bet) {
        return json(400, { error: 'Solde insuffisant pour doubler' });
      }

      player.balance -= hand.bet;
      gs.totalBet += hand.bet;
      hand.bet *= 2;
      hand.cards.push(drawCard(gs.deck));
      hand.finished = true;

      if (handScore(hand.cards) > 21) {
        hand.result = 'bust';
      }

      return await advanceOrFinish(gs, player, playerKey, gameKey, txKey);
    }

    if (action === 'split') {
      if (!isPair(hand.cards)) {
        return json(400, { error: 'Split seulement sur une paire' });
      }
      if (gs.playerHands.length >= 4) {
        return json(400, { error: 'Maximum 4 mains' });
      }
      if (player.balance < gs.bet) {
        return json(400, { error: 'Solde insuffisant pour split' });
      }

      player.balance -= gs.bet;
      gs.totalBet += gs.bet;

      const card1 = hand.cards[0];
      const card2 = hand.cards[1];

      gs.playerHands[gs.currentHandIdx] = {
        cards: [card1, drawCard(gs.deck)],
        bet: gs.bet,
        finished: false,
        result: null
      };

      gs.playerHands.splice(gs.currentHandIdx + 1, 0, {
        cards: [card2, drawCard(gs.deck)],
        bet: gs.bet,
        finished: false,
        result: null
      });

      if (handScore(gs.playerHands[gs.currentHandIdx].cards) === 21) {
        gs.playerHands[gs.currentHandIdx].finished = true;
        return await advanceOrFinish(gs, player, playerKey, gameKey, txKey);
      }

      await kv.set(playerKey, player, { ex: 2592000 });
      await kv.set(gameKey, gs, { ex: 3600 });
      return json(200, playingResponse(gs, player));
    }

  } catch (error) {
    console.error('Erreur game:', error);
    return json(500, { error: 'Erreur serveur' });
  } finally {
    await kv.del(lockKey);
  }
}

// --- Avancer à la main suivante ou finir ---

async function advanceOrFinish(gs, player, playerKey, gameKey, txKey) {
  let nextIdx = gs.currentHandIdx + 1;
  while (nextIdx < gs.playerHands.length && gs.playerHands[nextIdx].finished) {
    nextIdx++;
  }

  if (nextIdx < gs.playerHands.length) {
    gs.currentHandIdx = nextIdx;

    if (handScore(gs.playerHands[nextIdx].cards) === 21) {
      gs.playerHands[nextIdx].finished = true;
      return await advanceOrFinish(gs, player, playerKey, gameKey, txKey);
    }

    await kv.set(playerKey, player, { ex: 2592000 });
    await kv.set(gameKey, gs, { ex: 3600 });
    return json(200, playingResponse(gs, player));
  }

  // Toutes les mains finies -> dealer joue
  // H17: dealer tire sur soft 17 (règle standard)
  const isSoft17 = (hand) => {
    const score = handScore(hand);
    if (score !== 17) return false;
    const hardScore = hand.reduce((s,c) => s + (c.value==='A' ? 1 : c.num), 0);
    return hand.some(c => c.value==='A') && hardScore !== 17;
  };
  while (handScore(gs.dealerHand) < 17 || isSoft17(gs.dealerHand)) {
    gs.dealerHand.push(drawCard(gs.deck));
  }

  const dScore = handScore(gs.dealerHand);
  let totalPayout = 0;

  for (const h of gs.playerHands) {
    if (h.result === 'bust') continue;
    const pScore = handScore(h.cards);

    if (dScore > 21 || pScore > dScore) {
      h.result = 'win';
      totalPayout += h.bet * 2;
    } else if (pScore === dScore) {
      h.result = 'push';
      totalPayout += h.bet;
    } else {
      h.result = 'loss';
    }
  }

  // Apply rake on net winnings
  const grossGain = totalPayout - gs.totalBet;
  const rake = getRake(grossGain);
  const finalPayout = totalPayout - rake;

  player.balance += finalPayout;
  player.last_activity = Date.now();
  gs.status = 'finished';

  const globalResult = resolveGlobalResult(gs.playerHands);
  const netGain = finalPayout - gs.totalBet;

  if (rake > 0) {
    await kv.incrby('house:bankroll', rake);
  }

  await save(playerKey, player, gameKey, gs, txKey,globalResult, netGain);

  return json(200, finishResponse(gs, player, globalResult));
}

function resolveGlobalResult(hands) {
  const results = hands.map(h => h.result);
  if (results.includes('bj')) return 'bj';
  if (results.every(r => r === 'bust' || r === 'loss')) return 'loss';
  if (results.every(r => r === 'push')) return 'push';
  if (results.some(r => r === 'win')) return 'win';
  return 'loss';
}

function playingResponse(gs, player) {
  const hand = gs.playerHands[gs.currentHandIdx];
  const score = handScore(hand.cards);
  const isFirstAction = hand.cards.length === 2 && gs.playerHands.length === 1;
  return {
    status: 'playing',
    currentHandIdx: gs.currentHandIdx,
    playerHands: gs.playerHands.map((h, i) => ({
      cards: h.cards.map(cardForClient),
      score: handScore(h.cards),
      bet: h.bet,
      finished: h.finished,
      result: h.result,
      active: i === gs.currentHandIdx
    })),
    dealerUpCard: cardForClient(gs.dealerHand[0]),
    balance: player.balance,
    canDouble: hand.cards.length === 2 && player.balance >= hand.bet,
    canSplit: isPair(hand.cards) && player.balance >= gs.bet && gs.playerHands.length < 4,
    canInsurance: gs.phase === 'insurance_offered' && player.balance >= Math.floor(gs.bet / 2),
    canSurrender: isFirstAction && !gs.phase,
    insuranceResult: gs.insuranceResult,
    // Engagement provably-fair (serverSeed PAS encore révélé pendant le jeu)
    provablyFair: gs.pf ? { serverSeedHash: gs.pf.serverSeedHash, clientSeed: gs.pf.clientSeed, nonce: gs.pf.nonce } : undefined
  };
}

function finishResponse(gs, player, globalResult) {
  return {
    status: 'finished',
    result: globalResult,
    playerHands: gs.playerHands.map(h => ({
      cards: h.cards.map(cardForClient),
      score: handScore(h.cards),
      bet: h.bet,
      result: h.result
    })),
    dealerHand: gs.dealerHand.map(cardForClient),
    dealerScore: handScore(gs.dealerHand),
    balance: player.balance,
    totalBet: gs.totalBet,
    insuranceResult: gs.insuranceResult,
    surrendered: gs.surrendered,
    // Révélation provably-fair: serverSeed dévoilé → le joueur vérifie sur /verify.html
    provablyFair: gs.pf ? {
      serverSeed: gs.pf.serverSeed,
      serverSeedHash: gs.pf.serverSeedHash,
      clientSeed: gs.pf.clientSeed,
      nonce: gs.pf.nonce
    } : undefined
  };
}

async function save(playerKey, player, gameKey, gs, txKey, result, netGain) {
  await Promise.all([
    kv.set(playerKey, player, { ex: 2592000 }),
    kv.set(gameKey, gs, { ex: 3600 })
  ]);

  if (result && txKey) {
    await kv.rpush(txKey, {
      type: result,
      amount: netGain,
      timestamp: Date.now(),
      description: `Blackjack (${result})`
    });
    await kv.expire(txKey, 2592000);
  }
}
