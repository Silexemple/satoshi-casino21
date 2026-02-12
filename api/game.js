import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

// --- Blackjack helpers ---

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function createAndShuffleDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const num = rank === 'A' ? 11 : (isNaN(rank) ? 10 : parseInt(rank));
      deck.push({ suit, value: rank, num });
    }
  }
  // Fisher-Yates avec crypto.getRandomValues
  const arr = new Uint32Array(deck.length);
  crypto.getRandomValues(arr);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = arr[i] % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handScore(hand) {
  let score = hand.reduce((s, c) => s + c.num, 0);
  let aces = hand.filter(c => c.value === 'A').length;
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
}

function isBlackjack(hand) {
  return hand.length === 2 && handScore(hand) === 21;
}

function isPair(hand) {
  return hand.length === 2 && hand[0].value === hand[1].value;
}

function cardForClient(card) {
  return { suit: card.suit, value: card.value, num: card.num };
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// --- Handler ---

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const cookies = cookie.parse(req.headers.get('cookie') || '');
  const sessionId = cookies.session_id;

  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  // Lock pour éviter les race conditions
  const lockKey = `lock:game:${sessionId}`;
  const lockAcquired = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!lockAcquired) {
    return json(429, { error: 'Action en cours, réessayez' });
  }

  try {
    const body = await req.json();
    const { action, bet_amount } = body;

    if (!['deal', 'hit', 'stand', 'double', 'split'].includes(action)) {
      return json(400, { error: 'Action invalide (deal, hit, stand, double, split)' });
    }

    const playerKey = `player:${sessionId}`;
    const gameKey = `game_state:${sessionId}`;
    const player = await kv.get(playerKey);

    if (!player) {
      return json(404, { error: 'Joueur non trouvé' });
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

      const deck = createAndShuffleDeck();
      const pHand = [deck.pop(), deck.pop()];
      const dHand = [deck.pop(), deck.pop()];

      player.balance -= bet;

      const gs = {
        deck, bet,
        playerHands: [{ cards: pHand, bet, finished: false, result: null }],
        dealerHand: dHand,
        currentHandIdx: 0,
        totalBet: bet,
        status: 'playing',
        createdAt: Date.now()
      };

      // Dealer blackjack check
      if (dHand[0].num >= 10 && isBlackjack(dHand)) {
        if (isBlackjack(pHand)) {
          player.balance += bet;
          gs.status = 'finished';
          gs.playerHands[0].result = 'push';
          await save(playerKey, player, gameKey, gs, sessionId, 'push', 0);
          return json(200, finishResponse(gs, player, 'push'));
        } else {
          gs.status = 'finished';
          gs.playerHands[0].result = 'loss';
          await save(playerKey, player, gameKey, gs, sessionId, 'loss', -bet);
          return json(200, finishResponse(gs, player, 'loss'));
        }
      }

      // Player blackjack
      if (isBlackjack(pHand)) {
        const bjPayout = Math.floor(bet * 2.5);
        player.balance += bjPayout;
        gs.status = 'finished';
        gs.playerHands[0].result = 'bj';
        await save(playerKey, player, gameKey, gs, sessionId, 'bj', bjPayout - bet);
        return json(200, finishResponse(gs, player, 'bj'));
      }

      await kv.set(playerKey, player);
      await kv.set(gameKey, gs, { ex: 3600 });

      const score = handScore(pHand);
      return json(200, {
        action: 'deal',
        playerHands: [{ cards: pHand.map(cardForClient), bet, score }],
        dealerUpCard: cardForClient(dHand[0]),
        balance: player.balance,
        canDouble: score >= 9 && score <= 11 && player.balance >= bet,
        canSplit: isPair(pHand) && player.balance >= bet,
        status: 'playing'
      });
    }

    // ===================== HIT / STAND / DOUBLE / SPLIT =====================
    const gs = await kv.get(gameKey);
    if (!gs || gs.status !== 'playing') {
      return json(400, { error: 'Aucune partie en cours' });
    }

    const hand = gs.playerHands[gs.currentHandIdx];

    if (action === 'hit') {
      hand.cards.push(gs.deck.pop());
      const score = handScore(hand.cards);

      if (score > 21) {
        hand.finished = true;
        hand.result = 'bust';
        return await advanceOrFinish(gs, player, playerKey, gameKey, sessionId);
      }
      if (score === 21) {
        hand.finished = true;
        return await advanceOrFinish(gs, player, playerKey, gameKey, sessionId);
      }

      await kv.set(gameKey, gs, { ex: 3600 });
      return json(200, playingResponse(gs, player));
    }

    if (action === 'stand') {
      hand.finished = true;
      return await advanceOrFinish(gs, player, playerKey, gameKey, sessionId);
    }

    if (action === 'double') {
      if (hand.cards.length !== 2) {
        return json(400, { error: 'Double seulement sur 2 cartes' });
      }
      const score = handScore(hand.cards);
      if (score < 9 || score > 11) {
        return json(400, { error: 'Double seulement sur 9-11' });
      }
      if (player.balance < hand.bet) {
        return json(400, { error: 'Solde insuffisant pour doubler' });
      }

      player.balance -= hand.bet;
      gs.totalBet += hand.bet;
      hand.bet *= 2;
      hand.cards.push(gs.deck.pop());
      hand.finished = true;

      if (handScore(hand.cards) > 21) {
        hand.result = 'bust';
      }

      return await advanceOrFinish(gs, player, playerKey, gameKey, sessionId);
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
        cards: [card1, gs.deck.pop()],
        bet: gs.bet,
        finished: false,
        result: null
      };

      gs.playerHands.splice(gs.currentHandIdx + 1, 0, {
        cards: [card2, gs.deck.pop()],
        bet: gs.bet,
        finished: false,
        result: null
      });

      if (handScore(gs.playerHands[gs.currentHandIdx].cards) === 21) {
        gs.playerHands[gs.currentHandIdx].finished = true;
        return await advanceOrFinish(gs, player, playerKey, gameKey, sessionId);
      }

      await kv.set(playerKey, player);
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

async function advanceOrFinish(gs, player, playerKey, gameKey, sessionId) {
  let nextIdx = gs.currentHandIdx + 1;
  while (nextIdx < gs.playerHands.length && gs.playerHands[nextIdx].finished) {
    nextIdx++;
  }

  if (nextIdx < gs.playerHands.length) {
    gs.currentHandIdx = nextIdx;

    if (handScore(gs.playerHands[nextIdx].cards) === 21) {
      gs.playerHands[nextIdx].finished = true;
      return await advanceOrFinish(gs, player, playerKey, gameKey, sessionId);
    }

    await kv.set(playerKey, player);
    await kv.set(gameKey, gs, { ex: 3600 });
    return json(200, playingResponse(gs, player));
  }

  // Toutes les mains finies -> dealer joue
  while (handScore(gs.dealerHand) < 17) {
    gs.dealerHand.push(gs.deck.pop());
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

  player.balance += totalPayout;
  player.last_activity = Date.now();
  gs.status = 'finished';

  const globalResult = resolveGlobalResult(gs.playerHands);
  const netGain = totalPayout - gs.totalBet;

  await save(playerKey, player, gameKey, gs, sessionId, globalResult, netGain);

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
    canDouble: hand.cards.length === 2 && score >= 9 && score <= 11 && player.balance >= hand.bet,
    canSplit: isPair(hand.cards) && player.balance >= gs.bet && gs.playerHands.length < 4
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
    totalBet: gs.totalBet
  };
}

async function save(playerKey, player, gameKey, gs, sessionId, result, netGain) {
  await Promise.all([
    kv.set(playerKey, player),
    kv.set(gameKey, gs, { ex: 3600 })
  ]);

  if (result) {
    await kv.rpush(`transactions:${sessionId}`, {
      type: result,
      amount: netGain,
      timestamp: Date.now(),
      description: `Blackjack (${result})`
    });
  }
}
