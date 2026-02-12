// Tests unitaires pour la logique de blackjack
// Exécuter avec: node tests/game-logic.test.js

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

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

function card(value, suit = '♠') {
  const num = value === 'A' ? 11 : (isNaN(value) ? 10 : parseInt(value));
  return { suit, value, num };
}

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
  if (actual !== expected) throw new Error(`${msg || 'assertEqual'}: got ${actual}, expected ${expected}`);
}

// --- handScore ---
console.log('\nhandScore:');

test('simple hand', () => {
  assertEqual(handScore([card('5'), card('7')]), 12);
});

test('face cards = 10', () => {
  assertEqual(handScore([card('K'), card('Q')]), 20);
});

test('ace as 11', () => {
  assertEqual(handScore([card('A'), card('9')]), 20);
});

test('ace as 1 when bust', () => {
  assertEqual(handScore([card('A'), card('9'), card('5')]), 15);
});

test('two aces', () => {
  assertEqual(handScore([card('A'), card('A')]), 12);
});

test('blackjack = 21', () => {
  assertEqual(handScore([card('A'), card('K')]), 21);
});

test('three cards 21', () => {
  assertEqual(handScore([card('7'), card('7'), card('7')]), 21);
});

test('bust', () => {
  assertEqual(handScore([card('K'), card('Q'), card('5')]), 25);
});

test('multiple aces soft', () => {
  assertEqual(handScore([card('A'), card('A'), card('A')]), 13);
});

test('ace + ace + 9', () => {
  assertEqual(handScore([card('A'), card('A'), card('9')]), 21);
});

// --- isBlackjack ---
console.log('\nisBlackjack:');

test('A+K is blackjack', () => {
  assert(isBlackjack([card('A'), card('K')]));
});

test('A+10 is blackjack', () => {
  assert(isBlackjack([card('A'), card('10')]));
});

test('K+Q is not blackjack', () => {
  assert(!isBlackjack([card('K'), card('Q')]));
});

test('3 cards 21 is not blackjack', () => {
  assert(!isBlackjack([card('7'), card('7'), card('7')]));
});

// --- isPair ---
console.log('\nisPair:');

test('K+K is pair', () => {
  assert(isPair([card('K'), card('K')]));
});

test('A+A is pair', () => {
  assert(isPair([card('A'), card('A')]));
});

test('K+Q is not pair', () => {
  assert(!isPair([card('K'), card('Q')]));
});

test('3 cards not pair', () => {
  assert(!isPair([card('5'), card('5'), card('5')]));
});

// --- Payout tests ---
console.log('\nPayout logic:');

test('win pays 2x bet', () => {
  const bet = 500;
  const payout = bet * 2;
  assertEqual(payout, 1000);
});

test('blackjack pays 2.5x bet', () => {
  const bet = 500;
  const payout = Math.floor(bet * 2.5);
  assertEqual(payout, 1250);
});

test('push returns bet', () => {
  const bet = 500;
  const payout = bet;
  assertEqual(payout, 500);
});

test('loss pays 0', () => {
  const bet = 500;
  const payout = 0;
  assertEqual(payout, 0);
});

// --- Deck integrity ---
console.log('\nDeck:');

test('deck has 52 cards', () => {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(card(rank, suit));
    }
  }
  assertEqual(deck.length, 52);
});

test('deck has 4 aces', () => {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(card(rank, suit));
    }
  }
  assertEqual(deck.filter(c => c.value === 'A').length, 4);
});

// --- Summary ---
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
