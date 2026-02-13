import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';
import { handScore, cardForClient, isBlackjack, createAndShuffleDeck, drawCard } from '../_game-helpers.js';

export const config = { runtime: 'edge' };

const BETTING_TIMEOUT = 20000;  // 20s
const TURN_TIMEOUT = 30000;     // 30s
const STALE_TIMEOUT = 300000;   // 5min
const RAKE_PERCENT = 2;         // 2% commission on net winnings

function getRake(netGain) {
  if (netGain <= 0) return 0;
  return Math.max(1, Math.floor(netGain * RAKE_PERCENT / 100));
}

// ===================== TIMEOUT MANAGEMENT =====================

function checkTimeouts(table) {
  const now = Date.now();
  let changed = false;

  // Finished round: auto-reset après 10s
  if (table.status === 'finished' && now - table.lastUpdate > 10000) {
    resetTableForNextRound(table);
    changed = true;
  }

  // Stale table: inactive >5min during play → force finish
  if (table.status === 'playing' && now - table.lastUpdate > STALE_TIMEOUT) {
    forceFinishAllPlayers(table);
    dealerPlay(table);
    settleRound(table);
    changed = true;
  }

  // Betting timeout
  if (table.status === 'betting' && table.bettingStartedAt && now - table.bettingStartedAt > BETTING_TIMEOUT) {
    const hasBets = table.seats.some(s => s && s.bet > 0);
    if (hasBets) {
      startDealing(table);
    } else {
      table.status = 'waiting';
      table.bettingStartedAt = null;
    }
    changed = true;
  }

  // Player turn timeout
  if (table.status === 'playing' && table.turnStartedAt && now - table.turnStartedAt > TURN_TIMEOUT) {
    autoStandCurrentPlayer(table);
    changed = true;
  }

  return changed;
}

function resetTableForNextRound(table) {
  table.status = 'waiting';
  table.deck = [];
  table.dealerHand = [];
  table.currentSeatIdx = -1;
  table.bettingStartedAt = null;
  table.turnStartedAt = null;
  table.lastUpdate = Date.now();

  // Reset les sièges (garder les joueurs assis mais reset leur état)
  for (let i = 0; i < table.seats.length; i++) {
    if (table.seats[i]) {
      table.seats[i].bet = 0;
      table.seats[i].hands = [];
      table.seats[i].currentHandIdx = 0;
      table.seats[i].finished = true;
      table.seats[i].payout = undefined;
      table.seats[i].netGain = undefined;
    }
  }
}

function forceFinishAllPlayers(table) {
  for (const seat of table.seats) {
    if (seat && !seat.finished) {
      for (const hand of seat.hands) {
        if (!hand.finished) {
          hand.finished = true;
        }
      }
      seat.finished = true;
    }
  }
}

function autoStandCurrentPlayer(table) {
  const seat = table.seats[table.currentSeatIdx];
  if (!seat) {
    advanceToNextPlayer(table);
    return;
  }

  // Stand on current hand
  const hand = seat.hands[seat.currentHandIdx];
  if (hand && !hand.finished) {
    hand.finished = true;
  }

  // Advance to next hand or next player
  let nextHandIdx = seat.currentHandIdx + 1;
  while (nextHandIdx < seat.hands.length && seat.hands[nextHandIdx].finished) {
    nextHandIdx++;
  }

  if (nextHandIdx < seat.hands.length) {
    seat.currentHandIdx = nextHandIdx;
    table.turnStartedAt = Date.now();
  } else {
    seat.finished = true;
    advanceToNextPlayer(table);
  }
}

function advanceToNextPlayer(table) {
  let nextSeat = table.currentSeatIdx + 1;
  while (nextSeat < table.seats.length) {
    const s = table.seats[nextSeat];
    if (s && s.bet > 0 && !s.finished) {
      table.currentSeatIdx = nextSeat;
      table.turnStartedAt = Date.now();
      return;
    }
    nextSeat++;
  }

  // Tous les joueurs ont fini → dealer joue
  dealerPlay(table);
  settleRound(table);
}

function startDealing(table) {
  table.deck = createAndShuffleDeck(6); // Shoe de 6 decks (312 cartes)
  table.status = 'dealing';

  // Distribuer 2 cartes à chaque joueur qui a misé
  for (const seat of table.seats) {
    if (seat && seat.bet > 0) {
      const cards = [drawCard(table.deck), drawCard(table.deck)];
      seat.hands = [{ cards, bet: seat.bet, finished: false, result: null }];
      seat.currentHandIdx = 0;
      seat.finished = false;
    }
  }

  // Dealer: 2 cartes
  table.dealerHand = [drawCard(table.deck), drawCard(table.deck)];

  // Check dealer blackjack
  if (table.dealerHand[0].num >= 10 && isBlackjack(table.dealerHand)) {
    // Dealer blackjack - résoudre immédiatement
    for (const seat of table.seats) {
      if (seat && seat.bet > 0) {
        const pHand = seat.hands[0];
        if (isBlackjack(pHand.cards)) {
          pHand.result = 'push';
          pHand.finished = true;
        } else {
          pHand.result = 'loss';
          pHand.finished = true;
        }
        seat.finished = true;
      }
    }
    settleRound(table);
    return;
  }

  // Check player blackjacks
  for (const seat of table.seats) {
    if (seat && seat.bet > 0) {
      if (isBlackjack(seat.hands[0].cards)) {
        seat.hands[0].result = 'bj';
        seat.hands[0].finished = true;
        seat.finished = true;
      }
    }
  }

  // Trouver le premier joueur actif
  table.status = 'playing';
  table.currentSeatIdx = -1;

  for (let i = 0; i < table.seats.length; i++) {
    const s = table.seats[i];
    if (s && s.bet > 0 && !s.finished) {
      table.currentSeatIdx = i;
      table.turnStartedAt = Date.now();
      break;
    }
  }

  // Tous les joueurs ont fini (tous blackjack ou dealer blackjack)
  if (table.currentSeatIdx === -1) {
    dealerPlay(table);
    settleRound(table);
  }

  table.lastUpdate = Date.now();
}

function dealerPlay(table) {
  table.status = 'dealer_turn';
  // Dealer tire jusqu'à 17+
  while (handScore(table.dealerHand) < 17) {
    table.dealerHand.push(drawCard(table.deck));
  }
}

function settleRound(table) {
  const dScore = handScore(table.dealerHand);
  table.status = 'settling';

  for (const seat of table.seats) {
    if (!seat || seat.bet <= 0) continue;

    let totalPayout = 0;
    let totalBet = 0;

    for (const hand of seat.hands) {
      totalBet += hand.bet;

      if (hand.result === 'bust') continue;
      if (hand.result === 'bj') {
        totalPayout += Math.floor(hand.bet * 2.5);
        continue;
      }
      if (hand.result === 'push') {
        totalPayout += hand.bet;
        continue;
      }

      const pScore = handScore(hand.cards);
      if (dScore > 21 || pScore > dScore) {
        hand.result = 'win';
        totalPayout += hand.bet * 2;
      } else if (pScore === dScore) {
        hand.result = 'push';
        totalPayout += hand.bet;
      } else {
        hand.result = 'loss';
      }
    }

    const grossGain = totalPayout - totalBet;
    const rake = getRake(grossGain);
    seat.payout = totalPayout - rake;
    seat.netGain = grossGain - rake;
    seat.rake = rake;
  }

  table.status = 'finished';
  table.lastUpdate = Date.now();
}

// ===================== FILTER STATE FOR CLIENT =====================

function tableStateForClient(table, sessionId) {
  const now = Date.now();

  const seats = table.seats.map((seat, idx) => {
    if (!seat) return { seatIdx: idx, empty: true };

    const isMe = seat.sessionId === sessionId;
    return {
      seatIdx: idx,
      empty: false,
      playerName: seat.playerName || `Joueur ${idx + 1}`,
      isMe,
      bet: seat.bet || 0,
      finished: seat.finished,
      hands: (seat.hands || []).map(h => ({
        cards: h.cards.map(cardForClient),
        score: handScore(h.cards),
        bet: h.bet,
        finished: h.finished,
        result: h.result
      })),
      currentHandIdx: seat.currentHandIdx || 0,
      payout: seat.payout,
      netGain: seat.netGain
    };
  });

  // Dealer: montrer le hole card seulement si la phase est dealer_turn ou finished
  let dealerCards = [];
  let dealerScore = null;
  const showDealerHole = ['dealer_turn', 'finished', 'settling'].includes(table.status);

  if (table.dealerHand && table.dealerHand.length > 0) {
    if (showDealerHole) {
      dealerCards = table.dealerHand.map(cardForClient);
      dealerScore = handScore(table.dealerHand);
    } else {
      dealerCards = [cardForClient(table.dealerHand[0]), { hidden: true }];
      dealerScore = table.dealerHand[0].num;
    }
  }

  // Timer info
  let timerSeconds = null;
  if (table.status === 'betting' && table.bettingStartedAt) {
    timerSeconds = Math.max(0, Math.ceil((BETTING_TIMEOUT - (now - table.bettingStartedAt)) / 1000));
  } else if (table.status === 'playing' && table.turnStartedAt) {
    timerSeconds = Math.max(0, Math.ceil((TURN_TIMEOUT - (now - table.turnStartedAt)) / 1000));
  }

  // Check si c'est le tour du joueur
  const mySeat = table.seats.findIndex(s => s && s.sessionId === sessionId);
  const isMyTurn = table.status === 'playing' && table.currentSeatIdx === mySeat;

  // Can actions
  let canHit = false, canStand = false, canDouble = false, canSplit = false;
  if (isMyTurn && mySeat >= 0) {
    const seat = table.seats[mySeat];
    const hand = seat.hands[seat.currentHandIdx];
    if (hand && !hand.finished) {
      const score = handScore(hand.cards);
      canHit = score < 21;
      canStand = true;
      canDouble = hand.cards.length === 2 && score >= 9 && score <= 11;
      // Split: besoin de vérifier le solde du joueur (pas dispo ici, sera vérifié côté action)
      canSplit = hand.cards.length === 2 && hand.cards[0].value === hand.cards[1].value && seat.hands.length < 4;
    }
  }

  // Can bet
  const canBet = ['waiting', 'betting'].includes(table.status) &&
    mySeat >= 0 &&
    table.seats[mySeat] &&
    (!table.seats[mySeat].bet || table.seats[mySeat].bet === 0);

  return {
    id: table.id,
    name: table.name,
    minBet: table.minBet,
    maxBet: table.maxBet,
    maxPlayers: table.maxPlayers,
    status: table.status,
    roundNumber: table.roundNumber,
    seats,
    dealerCards,
    dealerScore,
    currentSeatIdx: table.currentSeatIdx,
    timerSeconds,
    isMyTurn,
    mySeat,
    canBet,
    canHit, canStand, canDouble, canSplit,
    lastUpdate: table.lastUpdate
  };
}

// ===================== HANDLER =====================

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const tableId = pathParts[pathParts.length - 1];

  const tableKey = `table:${tableId}`;
  let table = await kv.get(tableKey);

  if (!table) {
    return json(404, { error: 'Table non trouvée' });
  }

  // Check timeouts - acquire lock only if state needs modification
  const changed = checkTimeouts(table);
  if (changed) {
    const lockKey = `lock:table:${tableId}`;
    const locked = await kv.set(lockKey, '1', { nx: true, ex: 5 });
    if (locked) {
      try {
        // Re-read table under lock to avoid race conditions
        const freshTable = await kv.get(tableKey);
        if (freshTable) {
          table = freshTable;
          const stillChanged = checkTimeouts(table);
          if (stillChanged) {
            await kv.set(tableKey, table, { ex: 86400 });
            if (table.status === 'finished') {
              await creditPlayers(table);
            }
          }
        }
      } finally {
        await kv.del(lockKey);
      }
    }
  }

  const clientState = tableStateForClient(table, sessionId);

  // Include player balance to avoid extra API call
  const player = await kv.get(`player:${sessionId}`);
  if (player) {
    clientState.balance = player.balance;
  }

  // Include recent chat messages
  const chatKey = `chat:${tableId}`;
  const sinceParam = url.searchParams.get('chat_since');
  const since = sinceParam ? parseInt(sinceParam) : Date.now() - 30000; // last 30s by default
  try {
    const allChat = await kv.lrange(chatKey, -10, -1) || [];
    clientState.chatMessages = allChat.filter(m => m && m.timestamp > since && m.seatIdx !== undefined);
  } catch(e) {
    clientState.chatMessages = [];
  }

  return json(200, clientState);
}

async function creditPlayers(table) {
  const creditKey = `credited:${table.id}:${table.roundNumber}`;
  const alreadyCredited = await kv.get(creditKey);
  if (alreadyCredited) return;

  await kv.set(creditKey, true, { ex: 3600 });

  for (const seat of table.seats) {
    if (!seat || !seat.payout) continue;

    const playerKey = `player:${seat.sessionId}`;
    const player = await kv.get(playerKey);
    if (player) {
      player.balance += seat.payout;
      player.last_activity = Date.now();
      await kv.set(playerKey, player, { ex: 2592000 });

      const txKey = `transactions:${seat.sessionId}`;
      await kv.rpush(txKey, {
        type: seat.netGain > 0 ? 'win' : (seat.netGain < 0 ? 'loss' : 'push'),
        amount: seat.netGain,
        timestamp: Date.now(),
        description: `Table ${table.name} (round ${table.roundNumber})`
      });
      await kv.expire(txKey, 2592000);
    }
  }

  // Mettre à jour bankroll maison (losses + rake)
  let houseChange = 0;
  for (const seat of table.seats) {
    if (!seat) continue;
    if (seat.netGain) {
      houseChange -= seat.netGain; // si joueur gagne, maison perd
    }
    if (seat.rake) {
      houseChange += seat.rake; // la maison gagne le rake
    }
  }
  await kv.incrby('house:bankroll', houseChange);
}

export { checkTimeouts, startDealing, advanceToNextPlayer, dealerPlay, settleRound, tableStateForClient, creditPlayers, resetTableForNextRound, BETTING_TIMEOUT, TURN_TIMEOUT };
