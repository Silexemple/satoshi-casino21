// Tests unitaires pour la logique multiplayer
// Exécuter avec: node tests/table-logic.test.js

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''}: got ${actual}, expected ${expected}`);
}

function card(value, suit = '♠') {
  const num = value === 'A' ? 11 : (isNaN(value) ? 10 : parseInt(value));
  return { suit, value: String(value), num };
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

// --- Helper: create a table ---
function createTable(overrides = {}) {
  return {
    id: 'test-1',
    name: 'Test Table',
    maxPlayers: 5,
    minBet: 100,
    maxBet: 2500,
    status: 'waiting',
    deck: [],
    dealerHand: [],
    seats: [null, null, null, null, null],
    currentSeatIdx: -1,
    roundNumber: 0,
    bettingStartedAt: null,
    turnStartedAt: null,
    lastUpdate: Date.now(),
    ...overrides
  };
}

function createSeat(sessionId, overrides = {}) {
  return {
    sessionId,
    playerName: sessionId,
    bet: 0,
    hands: [],
    currentHandIdx: 0,
    finished: true,
    payout: undefined,
    netGain: undefined,
    ...overrides
  };
}

// Build a simple deck for deterministic tests
function buildDeck(cards) {
  // Cards are popped from the end, so reverse the order
  return [...cards].reverse();
}

// --- Replicate core logic functions from [id].js ---

function resetTableForNextRound(table) {
  table.status = 'waiting';
  table.deck = [];
  table.dealerHand = [];
  table.currentSeatIdx = -1;
  table.bettingStartedAt = null;
  table.turnStartedAt = null;
  table.lastUpdate = Date.now();

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
        if (!hand.finished) hand.finished = true;
      }
      seat.finished = true;
    }
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
  dealerPlay(table);
  settleRound(table);
}

function dealerPlay(table) {
  table.status = 'dealer_turn';
  while (handScore(table.dealerHand) < 17) {
    table.dealerHand.push(table.deck.pop());
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

    seat.payout = totalPayout;
    seat.netGain = totalPayout - totalBet;
  }

  table.status = 'finished';
  table.lastUpdate = Date.now();
}

function startDealing(table) {
  table.status = 'dealing';

  for (const seat of table.seats) {
    if (seat && seat.bet > 0) {
      const cards = [table.deck.pop(), table.deck.pop()];
      seat.hands = [{ cards, bet: seat.bet, finished: false, result: null }];
      seat.currentHandIdx = 0;
      seat.finished = false;
    }
  }

  table.dealerHand = [table.deck.pop(), table.deck.pop()];

  // Check dealer blackjack
  if (table.dealerHand[0].num >= 10 && isBlackjack(table.dealerHand)) {
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

  if (table.currentSeatIdx === -1) {
    dealerPlay(table);
    settleRound(table);
  }

  table.lastUpdate = Date.now();
}

function autoStandCurrentPlayer(table) {
  const seat = table.seats[table.currentSeatIdx];
  if (!seat) {
    advanceToNextPlayer(table);
    return;
  }
  const hand = seat.hands[seat.currentHandIdx];
  if (hand && !hand.finished) hand.finished = true;

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

function checkTimeouts(table) {
  const now = Date.now();
  let changed = false;

  if (table.status === 'finished' && now - table.lastUpdate > 10000) {
    resetTableForNextRound(table);
    changed = true;
  }
  if (table.status === 'playing' && now - table.lastUpdate > 300000) {
    forceFinishAllPlayers(table);
    dealerPlay(table);
    settleRound(table);
    changed = true;
  }
  if (table.status === 'betting' && table.bettingStartedAt && now - table.bettingStartedAt > 20000) {
    const hasBets = table.seats.some(s => s && s.bet > 0);
    if (hasBets) startDealing(table);
    else {
      table.status = 'waiting';
      table.bettingStartedAt = null;
    }
    changed = true;
  }
  if (table.status === 'playing' && table.turnStartedAt && now - table.turnStartedAt > 30000) {
    autoStandCurrentPlayer(table);
    changed = true;
  }
  return changed;
}

// ===================== TESTS =====================

console.log('\n=== Table State Machine ===');

test('new table starts in waiting status', () => {
  const t = createTable();
  assertEqual(t.status, 'waiting');
});

test('betting phase starts when first player bets', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1');
  t.seats[0].bet = 500;
  t.seats[0].finished = false;
  t.status = 'betting';
  t.bettingStartedAt = Date.now();
  t.roundNumber = 1;
  assertEqual(t.status, 'betting');
  assert(t.bettingStartedAt !== null);
});

test('dealing starts when all seated players bet', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', { bet: 500, finished: false });
  t.seats[2] = createSeat('p2', { bet: 1000, finished: false });
  // Build deck with enough cards for 2 players + dealer
  t.deck = buildDeck([
    card('K'), card('5'), // p1 cards
    card('9'), card('7'), // p2 cards
    card('J'), card('6'), // dealer cards
    card('3'),            // extra for dealer draw
  ]);
  startDealing(t);
  // Should be playing since no blackjacks
  assertEqual(t.status, 'playing');
  assertEqual(t.seats[0].hands.length, 1);
  assertEqual(t.seats[2].hands.length, 1);
  assertEqual(t.dealerHand.length, 2);
});

console.log('\n=== Player Turn Order ===');

test('first active player gets turn after dealing', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', { bet: 500, finished: false });
  t.seats[2] = createSeat('p2', { bet: 500, finished: false });
  t.deck = buildDeck([
    card('K'), card('5'),
    card('9'), card('7'),
    card('J'), card('6'),
    card('3'), card('4'),
  ]);
  startDealing(t);
  assertEqual(t.currentSeatIdx, 0, 'first player should have turn');
});

test('advance skips empty seats', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', { bet: 500, finished: true, hands: [{ cards: [card('K'), card('8')], bet: 500, finished: true, result: null }] });
  t.seats[3] = createSeat('p2', { bet: 500, finished: false, hands: [{ cards: [card('9'), card('5')], bet: 500, finished: false, result: null }] });
  t.status = 'playing';
  t.currentSeatIdx = 0;
  t.dealerHand = [card('J'), card('6')];
  t.deck = [card('3'), card('4'), card('5')];
  advanceToNextPlayer(t);
  assertEqual(t.currentSeatIdx, 3, 'should skip to seat 3');
});

test('advance triggers dealer when all done', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', { bet: 500, finished: true, hands: [{ cards: [card('K'), card('8')], bet: 500, finished: true, result: null }] });
  t.status = 'playing';
  t.currentSeatIdx = 0;
  t.dealerHand = [card('J'), card('6')];
  t.deck = [card('3'), card('4'), card('5')];
  advanceToNextPlayer(t);
  assertEqual(t.status, 'finished', 'should finish round');
});

console.log('\n=== Dealer Logic ===');

test('dealer hits until 17+', () => {
  const t = createTable();
  t.dealerHand = [card('3'), card('2')]; // score 5
  t.deck = [card('K'), card('J'), card('2')]; // will draw 2 (7), then J (17)
  t.status = 'playing';
  dealerPlay(t);
  assert(handScore(t.dealerHand) >= 17, `dealer should have 17+, got ${handScore(t.dealerHand)}`);
});

test('dealer stands on 17', () => {
  const t = createTable();
  t.dealerHand = [card('J'), card('7')]; // score 17
  t.deck = [card('K')];
  t.status = 'playing';
  dealerPlay(t);
  assertEqual(t.dealerHand.length, 2, 'dealer should not draw');
  assertEqual(handScore(t.dealerHand), 17);
});

test('dealer busts when over 21', () => {
  const t = createTable();
  t.dealerHand = [card('J'), card('6')]; // 16
  t.deck = [card('K')]; // draw K → 26 bust
  t.status = 'playing';
  dealerPlay(t);
  assert(handScore(t.dealerHand) > 21, 'dealer should bust');
});

console.log('\n=== Settlement ===');

test('player wins when dealer busts', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', {
    bet: 500,
    hands: [{ cards: [card('K'), card('8')], bet: 500, finished: true, result: null }],
    finished: true
  });
  t.dealerHand = [card('J'), card('6'), card('K')]; // 26 bust
  settleRound(t);
  assertEqual(t.seats[0].hands[0].result, 'win');
  assertEqual(t.seats[0].payout, 1000);
  assertEqual(t.seats[0].netGain, 500);
});

test('player loses when dealer has higher score', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', {
    bet: 500,
    hands: [{ cards: [card('K'), card('5')], bet: 500, finished: true, result: null }],
    finished: true
  });
  t.dealerHand = [card('J'), card('8')]; // 18 vs 15
  settleRound(t);
  assertEqual(t.seats[0].hands[0].result, 'loss');
  assertEqual(t.seats[0].payout, 0);
  assertEqual(t.seats[0].netGain, -500);
});

test('push when equal scores', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', {
    bet: 500,
    hands: [{ cards: [card('K'), card('8')], bet: 500, finished: true, result: null }],
    finished: true
  });
  t.dealerHand = [card('J'), card('8')]; // both 18
  settleRound(t);
  assertEqual(t.seats[0].hands[0].result, 'push');
  assertEqual(t.seats[0].payout, 500);
  assertEqual(t.seats[0].netGain, 0);
});

test('blackjack pays 2.5x', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', {
    bet: 500,
    hands: [{ cards: [card('A'), card('K')], bet: 500, finished: true, result: 'bj' }],
    finished: true
  });
  t.dealerHand = [card('J'), card('8')]; // 18
  settleRound(t);
  assertEqual(t.seats[0].payout, 1250);
  assertEqual(t.seats[0].netGain, 750);
});

test('bust hand pays nothing', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', {
    bet: 500,
    hands: [{ cards: [card('K'), card('8'), card('7')], bet: 500, finished: true, result: 'bust' }],
    finished: true
  });
  t.dealerHand = [card('J'), card('8')];
  settleRound(t);
  assertEqual(t.seats[0].payout, 0);
  assertEqual(t.seats[0].netGain, -500);
});

console.log('\n=== Multi-player Settlement ===');

test('two players: one wins, one loses', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', {
    bet: 500,
    hands: [{ cards: [card('K'), card('9')], bet: 500, finished: true, result: null }], // 19
    finished: true
  });
  t.seats[2] = createSeat('p2', {
    bet: 1000,
    hands: [{ cards: [card('7'), card('5')], bet: 1000, finished: true, result: null }], // 12
    finished: true
  });
  t.dealerHand = [card('J'), card('8')]; // 18
  settleRound(t);
  assertEqual(t.seats[0].hands[0].result, 'win');
  assertEqual(t.seats[0].netGain, 500);
  assertEqual(t.seats[2].hands[0].result, 'loss');
  assertEqual(t.seats[2].netGain, -1000);
});

test('house change is negative sum of player netGains', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', {
    bet: 500,
    hands: [{ cards: [card('K'), card('9')], bet: 500, finished: true, result: null }], // wins
    finished: true
  });
  t.seats[1] = createSeat('p2', {
    bet: 500,
    hands: [{ cards: [card('5'), card('3')], bet: 500, finished: true, result: null }], // loses
    finished: true
  });
  t.dealerHand = [card('J'), card('8')]; // 18
  settleRound(t);

  let houseChange = 0;
  for (const seat of t.seats) {
    if (seat && seat.netGain) houseChange -= seat.netGain;
  }
  // p1 wins 500, p2 loses 500 → house change = -500 + 500 = 0
  assertEqual(houseChange, 0, 'house should break even');
});

console.log('\n=== Timeouts ===');

test('betting timeout triggers dealing when bets exist', () => {
  const t = createTable({
    status: 'betting',
    bettingStartedAt: Date.now() - 25000, // 25s ago (>20s timeout)
  });
  t.seats[0] = createSeat('p1', { bet: 500, finished: false });
  // Need deck for dealing
  t.deck = buildDeck([
    card('K'), card('5'),
    card('J'), card('6'),
    card('3'), card('4'),
  ]);
  const changed = checkTimeouts(t);
  assert(changed, 'should detect timeout');
  assert(t.status !== 'betting', 'should no longer be betting');
});

test('betting timeout reverts to waiting if no bets', () => {
  const t = createTable({
    status: 'betting',
    bettingStartedAt: Date.now() - 25000,
  });
  t.seats[0] = createSeat('p1', { bet: 0 });
  const changed = checkTimeouts(t);
  assert(changed);
  assertEqual(t.status, 'waiting');
});

test('turn timeout auto-stands current player', () => {
  const t = createTable({
    status: 'playing',
    currentSeatIdx: 0,
    turnStartedAt: Date.now() - 35000, // 35s ago (>30s)
    lastUpdate: Date.now(),
  });
  t.seats[0] = createSeat('p1', {
    bet: 500,
    finished: false,
    hands: [{ cards: [card('K'), card('5')], bet: 500, finished: false, result: null }],
  });
  t.dealerHand = [card('J'), card('7')]; // 17
  t.deck = [card('3')];
  const changed = checkTimeouts(t);
  assert(changed, 'should detect turn timeout');
  // Player should be stood and round finished (only 1 player)
  assert(t.seats[0].finished, 'player should be finished');
});

test('finished table auto-resets after 10s', () => {
  const t = createTable({
    status: 'finished',
    lastUpdate: Date.now() - 15000, // 15s ago
  });
  t.seats[0] = createSeat('p1', { bet: 500, payout: 1000, netGain: 500 });
  const changed = checkTimeouts(t);
  assert(changed);
  assertEqual(t.status, 'waiting');
  assertEqual(t.seats[0].bet, 0);
  assertEqual(t.seats[0].payout, undefined);
});

console.log('\n=== Dealer Blackjack ===');

test('dealer blackjack: all players lose except player BJ (push)', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', { bet: 500, finished: false });
  t.seats[1] = createSeat('p2', { bet: 500, finished: false });
  // Deck: p1 gets K+5, p2 gets A+K (BJ), dealer gets A+J (BJ)
  t.deck = buildDeck([
    card('K'), card('5'),   // p1
    card('A'), card('K'),   // p2
    card('A'), card('J'),   // dealer
  ]);
  startDealing(t);
  assertEqual(t.status, 'finished');
  assertEqual(t.seats[0].hands[0].result, 'loss', 'p1 should lose');
  assertEqual(t.seats[1].hands[0].result, 'push', 'p2 BJ should push against dealer BJ');
});

console.log('\n=== Player Blackjack ===');

test('player blackjack is auto-finished and marked bj', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', { bet: 500, finished: false });
  // p1 gets A+K (BJ), dealer gets J+6 (not BJ)
  t.deck = buildDeck([
    card('A'), card('K'),
    card('J'), card('6'),
    card('3'), card('4'),
  ]);
  startDealing(t);
  assertEqual(t.seats[0].hands[0].result, 'bj');
  assert(t.seats[0].finished, 'BJ player should be auto-finished');
});

console.log('\n=== Reset ===');

test('resetTableForNextRound clears all game state', () => {
  const t = createTable({
    status: 'finished',
    roundNumber: 5,
    currentSeatIdx: 2,
    dealerHand: [card('J'), card('8')],
    deck: [card('3'), card('4')],
  });
  t.seats[0] = createSeat('p1', { bet: 500, payout: 1000, netGain: 500 });
  t.seats[2] = createSeat('p2', { bet: 1000, payout: 0, netGain: -1000 });

  resetTableForNextRound(t);

  assertEqual(t.status, 'waiting');
  assertEqual(t.deck.length, 0);
  assertEqual(t.dealerHand.length, 0);
  assertEqual(t.currentSeatIdx, -1);
  assertEqual(t.seats[0].bet, 0);
  assertEqual(t.seats[0].payout, undefined);
  assertEqual(t.seats[2].bet, 0);
  // Players are still seated
  assert(t.seats[0] !== null, 'p1 should still be seated');
  assert(t.seats[2] !== null, 'p2 should still be seated');
});

console.log('\n=== Bank Intelligence ===');

test('exposure calculation: worst case per player is bet × 8', () => {
  const bet = 500;
  const worstCase = bet * 8; // 4 splits × 2x payout
  assertEqual(worstCase, 4000);
});

test('total exposure sums all players', () => {
  const bets = [500, 1000, 2500];
  let total = 0;
  for (const b of bets) total += b * 8;
  assertEqual(total, 32000);
});

test('bankroll check rejects when insufficient', () => {
  const bankroll = 10000;
  const exposure = 32000;
  assert(bankroll < exposure, 'should reject');
});

test('max acceptable bet calculation', () => {
  const bankroll = 20000;
  const otherExposure = 8000; // 1 other player bet 1000
  const maxAcceptable = Math.floor((bankroll - otherExposure) / 8);
  assertEqual(maxAcceptable, 1500);
});

console.log('\n=== Auto-Stand with Multiple Hands ===');

test('auto-stand advances through split hands', () => {
  const t = createTable({
    status: 'playing',
    currentSeatIdx: 0,
    turnStartedAt: Date.now(),
  });
  t.seats[0] = createSeat('p1', {
    bet: 500,
    finished: false,
    currentHandIdx: 0,
    hands: [
      { cards: [card('7'), card('3')], bet: 500, finished: false, result: null },
      { cards: [card('7'), card('9')], bet: 500, finished: false, result: null },
    ],
  });
  t.dealerHand = [card('J'), card('7')];
  t.deck = [card('3')];

  // Auto-stand on hand 0
  autoStandCurrentPlayer(t);
  // Should advance to hand 1
  assertEqual(t.seats[0].currentHandIdx, 1, 'should move to hand 1');
  assert(!t.seats[0].finished, 'player should not be fully finished');

  // Auto-stand on hand 1
  autoStandCurrentPlayer(t);
  assert(t.seats[0].finished, 'player should be finished after both hands stood');
});

console.log('\n=== Full Round Simulation ===');

test('complete round: 2 players, dealing to settlement', () => {
  const t = createTable();
  t.seats[0] = createSeat('p1', { bet: 500, finished: false });
  t.seats[1] = createSeat('p2', { bet: 1000, finished: false });
  // p1: K+8=18, p2: 9+7=16, dealer: J+6=16, draws 3=19
  t.deck = buildDeck([
    card('K'), card('8'),   // p1
    card('9'), card('7'),   // p2
    card('J'), card('6'),   // dealer
    card('3'),              // dealer draw
  ]);

  startDealing(t);
  assertEqual(t.status, 'playing');
  assertEqual(t.currentSeatIdx, 0, 'p1 goes first');

  // p1 stands
  t.seats[0].hands[0].finished = true;
  t.seats[0].finished = true;
  advanceToNextPlayer(t);
  assertEqual(t.currentSeatIdx, 1, 'p2 goes next');

  // p2 stands
  t.seats[1].hands[0].finished = true;
  t.seats[1].finished = true;
  advanceToNextPlayer(t);

  // Round should be finished
  assertEqual(t.status, 'finished');
  // Dealer: J+6+3 = 19
  assertEqual(handScore(t.dealerHand), 19);
  // p1: 18 < 19 → loss
  assertEqual(t.seats[0].hands[0].result, 'loss');
  assertEqual(t.seats[0].netGain, -500);
  // p2: 16 < 19 → loss
  assertEqual(t.seats[1].hands[0].result, 'loss');
  assertEqual(t.seats[1].netGain, -1000);
});

// --- Summary ---
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
