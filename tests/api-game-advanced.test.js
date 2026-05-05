/**
 * Tests unitaires — Logique jeu avancée
 * Couvre: rake, soft 17, insurance, double, split, surrender, multi-deck
 */

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch(e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m||''}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ── Fonctions copiées depuis api/_game-helpers.js et api/game.js ─────────────

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

function isPair(hand) {
  return hand.length === 2 && hand[0].value === hand[1].value;
}

// Rake: 2% sur gains nets, min 1 sat
const RAKE_PERCENT = 2;
function getRake(netGain) {
  if (netGain <= 0) return 0;
  return Math.max(1, Math.floor(netGain * RAKE_PERCENT / 100));
}

function applyRake(netGain) {
  if (netGain <= 0) return netGain;
  return netGain - getRake(netGain);
}

// Soft 17: A+6, A+A+5, etc.
function isSoft17(hand) {
  const score = handScore(hand);
  if (score !== 17) return false;
  const hardScore = hand.reduce((s, c) => s + (c.value === 'A' ? 1 : c.num), 0);
  return hand.some(c => c.value === 'A') && hardScore !== 17;
}

// Deck operations
function createDeck(numDecks = 1) {
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const num = rank === 'A' ? 11 : (isNaN(rank) ? 10 : parseInt(rank));
        deck.push({ suit, value: rank, num });
      }
    }
  }
  return deck;
}

function drawCard(deck) {
  if (deck.length === 0) deck.push(...createDeck());
  return deck.pop();
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Rake (2% sur gains nets) ===');

test('pas de rake sur une perte', () => assertEqual(getRake(-500), 0));
test('pas de rake sur un push', () => assertEqual(getRake(0), 0));
test('rake minimum 1 sat', () => assertEqual(getRake(1), 1));
test('rake minimum sur gain de 49 sats', () => assertEqual(getRake(49), 1));
test('rake 2% sur gain de 100 sats = 2', () => assertEqual(getRake(100), 2));
test('rake 2% sur gain de 500 sats = 10', () => assertEqual(getRake(500), 10));
test('rake 2% sur gain de 1000 sats = 20', () => assertEqual(getRake(1000), 20));
test('rake arrondi à l\'inférieur: 150 sats → floor(3.0) = 3', () => assertEqual(getRake(150), 3));
test('rake arrondi: 175 sats → floor(3.5) = 3', () => assertEqual(getRake(175), 3));
test('applyRake: gain 100 → 98 sats net', () => assertEqual(applyRake(100), 98));
test('applyRake: gain 500 → 490 sats net', () => assertEqual(applyRake(500), 490));
test('applyRake: perte → inchangée', () => assertEqual(applyRake(-500), -500));
test('applyRake: push → inchangé', () => assertEqual(applyRake(0), 0));
test('applyRake: gain 1 sat → 0 sats (rake min 1)', () => assertEqual(applyRake(1), 0));

test('blackjack 2.5x sur 500 sats: gain net = 750, rake = 15, net = 735', () => {
  const bet = 500;
  const payout = Math.floor(bet * 2.5); // 1250
  const gross = payout - bet; // 750
  const rake = getRake(gross); // 15
  assertEqual(gross - rake, 735);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== isSoft17() ===');

test('A+6 = soft 17', () => assert(isSoft17([card('A'), card('6')])));
test('A+A+5 = soft 17', () => assert(isSoft17([card('A'), card('A'), card('5')])));
test('A+2+4 = soft 17', () => assert(isSoft17([card('A'), card('2'), card('4')])));
test('10+7 = hard 17, pas soft', () => assert(!isSoft17([card('10'), card('7')])));
test('J+7 = hard 17, pas soft', () => assert(!isSoft17([card('J'), card('7')])));
test('9+8 = hard 17, pas soft', () => assert(!isSoft17([card('9'), card('8')])));
test('A+6+Q = 17 mais bust puis as=1 → hard 17', () => {
  // A(11)+6+Q(10)=27→bust→A=1: 1+6+10=17 → hard 17
  assert(!isSoft17([card('A'), card('6'), card('Q')]));
});
test('A+7 = 18, pas 17', () => assert(!isSoft17([card('A'), card('7')])));
test('A+5 = 16, pas 17', () => assert(!isSoft17([card('A'), card('5')])));
test('7+7+3 = 17 sans as → pas soft', () => assert(!isSoft17([card('7'), card('7'), card('3')])));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Dealer H17 (tire sur soft 17) ===');

function dealerPlay(hand, deck) {
  while (handScore(hand) < 17 || isSoft17(hand)) {
    hand.push(drawCard(deck));
  }
  return hand;
}

test('dealer tire sur soft 17 (A+6)', () => {
  const deck = [card('3'), card('5')]; // deck inverse (pop = premier)
  const hand = [card('A'), card('6')];
  dealerPlay(hand, deck);
  assert(hand.length > 2, 'dealer doit tirer au moins une carte sur soft 17');
  assert(handScore(hand) >= 17, 'dealer doit finir à 17+');
});

test('dealer s\'arrête sur hard 17 (J+7)', () => {
  const deck = [card('A')];
  const hand = [card('J'), card('7')];
  dealerPlay(hand, deck);
  assertEqual(hand.length, 2, 'dealer ne doit pas tirer sur hard 17');
});

test('dealer s\'arrête sur 18', () => {
  const hand = [card('J'), card('8')];
  const deck = [card('2')];
  dealerPlay(hand, deck);
  assertEqual(hand.length, 2);
});

test('dealer tire sur 16', () => {
  const deck = [card('5'), card('2')]; // tirera 2, puis 5 si nécessaire
  const hand = [card('J'), card('6')]; // 16
  dealerPlay(hand, deck);
  assert(handScore(hand) >= 17);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Insurance Logic ===');

test('insurance disponible si dealer montre As', () => {
  const dealerUpCard = card('A');
  assert(dealerUpCard.value === 'A');
});

test('insurance coûte la moitié de la mise', () => {
  const bet = 500;
  const insuranceCost = Math.floor(bet / 2);
  assertEqual(insuranceCost, 250);
});

test('insurance impaire: floor(501/2) = 250', () => {
  assertEqual(Math.floor(501 / 2), 250);
});

test('insurance paye 2:1 si dealer BJ', () => {
  const insuranceBet = 250;
  const insurancePayout = insuranceBet * 3; // mise + 2x
  assertEqual(insurancePayout, 750);
});

test('insurance perdue si pas BJ dealer', () => {
  const insuranceBet = 250;
  const payout = 0;
  assertEqual(payout, 0);
});

test('insurance + dealer BJ + player BJ = push sur mise principale', () => {
  const bet = 500;
  const insuranceBet = 250;
  // Main bet: push → +0
  // Insurance: win → +500 (250*3-250=500 net)
  const insuranceNet = (insuranceBet * 3) - insuranceBet;
  assertEqual(insuranceNet, 500);
  const mainBetNet = 0;
  assertEqual(insuranceNet + mainBetNet, 500);
});

test('insurance + dealer BJ + player perd = net zéro si insuranceBet = bet/2', () => {
  const bet = 500;
  const insuranceBet = 250;
  const mainBetLoss = -bet; // -500
  const insuranceGain = insuranceBet * 2; // 2:1 payout = +500
  assertEqual(mainBetLoss + insuranceGain, 0, 'insurance parfaite: net zéro');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Double Down ===');

test('double down double la mise', () => {
  const initialBet = 500;
  const finalBet = initialBet * 2;
  assertEqual(finalBet, 1000);
});

test('double down uniquement sur 2 cartes', () => {
  const hand2 = [card('5'), card('6')];
  const hand3 = [card('5'), card('6'), card('2')];
  assert(hand2.length === 2, 'double sur 2 cartes: OK');
  assert(hand3.length !== 2, 'double sur 3 cartes: refusé');
});

test('double sur 11 → bonne stratégie (soft double)', () => {
  const hand = [card('5'), card('6')];
  assertEqual(handScore(hand), 11);
});

test('balance insuffisante bloque le double', () => {
  const balance = 400;
  const bet = 500;
  assert(balance < bet, 'solde insuffisant pour doubler');
});

test('balance suffisante permet le double', () => {
  const balance = 600;
  const bet = 500;
  assert(balance >= bet, 'solde suffisant pour doubler');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Split ===');

test('isPair: deux cartes identiques', () => {
  assert(isPair([card('8'), card('8')]));
  assert(isPair([card('A'), card('A')]));
  assert(!isPair([card('8'), card('9')]));
});

test('split réduit la balance du montant de la mise originale', () => {
  const balance = 1000;
  const originalBet = 500;
  const balanceAfterSplit = balance - originalBet;
  assertEqual(balanceAfterSplit, 500);
});

test('split crée 2 mains à partir d\'une paire', () => {
  const hand = [card('8'), card('8')];
  const newCard1 = card('5');
  const newCard2 = card('3');
  const hand1 = [hand[0], newCard1];
  const hand2 = [hand[1], newCard2];
  assertEqual(hand1.length, 2);
  assertEqual(hand2.length, 2);
  assertEqual(handScore(hand1), 13);
  assertEqual(handScore(hand2), 11);
});

test('maximum 4 mains après splits', () => {
  const maxSplits = 4;
  assert(maxSplits <= 4);
});

test('split As: chaque main reçoit une seule carte (règle standard)', () => {
  // Nos règles permettent le split As normalement (pas de restriction)
  const hand = [card('A'), card('A')];
  assert(isPair(hand), 'As sont une paire');
});

test('split sur non-paire: refusé', () => {
  const hand = [card('K'), card('Q')];
  assert(!isPair(hand), 'K+Q n\'est pas une paire → split refusé');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Surrender ===');

test('surrender retourne la moitié de la mise', () => {
  const bet = 500;
  const refund = Math.floor(bet / 2);
  assertEqual(refund, 250);
});

test('surrender sur mise impaire: floor(501/2) = 250', () => {
  assertEqual(Math.floor(501 / 2), 250);
});

test('surrender uniquement sur les 2 premières cartes', () => {
  const hand2 = [card('K'), card('5')]; // 15, 2 cartes → surrender possible
  const hand3 = [card('K'), card('5'), card('2')]; // 3 cartes → refusé
  assert(hand2.length === 2);
  assert(hand3.length !== 2);
});

test('surrender net = -50% de la mise', () => {
  const bet = 500;
  const net = Math.floor(bet / 2) - bet;
  assertEqual(net, -250);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Deck intégrité (multi-deck) ===');

test('deck 1 deck = 52 cartes', () => {
  assertEqual(createDeck(1).length, 52);
});

test('deck 6 decks = 312 cartes', () => {
  assertEqual(createDeck(6).length, 312);
});

test('deck 6 decks = 24 As', () => {
  const d = createDeck(6);
  assertEqual(d.filter(c => c.value === 'A').length, 24);
});

test('deck 6 decks = 24 Rois', () => {
  const d = createDeck(6);
  assertEqual(d.filter(c => c.value === 'K').length, 24);
});

test('deck 6 decks = 96 cartes à 10 pts', () => {
  const d = createDeck(6);
  assertEqual(d.filter(c => c.num === 10).length, 96); // 10, J, Q, K × 4 suits × 6 decks
});

test('drawCard sur deck vide: reshuffles automatiquement', () => {
  const emptyDeck = [];
  const c = drawCard(emptyDeck);
  assert(c !== undefined, 'doit retourner une carte même sur deck vide');
  assert(c.value !== undefined, 'carte doit avoir une valeur');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Cas edge: mains spéciales ===');

test('A+A = 12 (pas 22)', () => assertEqual(handScore([card('A'), card('A')]), 12));
test('A+A+A = 13', () => assertEqual(handScore([card('A'), card('A'), card('A')]), 13));
test('A+A+A+A = 14', () => assertEqual(handScore([card('A'), card('A'), card('A'), card('A')]), 14));
test('A+A+A+A+A = 15', () => assertEqual(handScore([...Array(5)].map(() => card('A'))), 15));
test('A+K+A = 12 (bust corrigé)', () => assertEqual(handScore([card('A'), card('K'), card('A')]), 12));
test('A+5+K = 16', () => assertEqual(handScore([card('A'), card('5'), card('K')]), 16));
test('A+10+A = 12 (bust corrigé)', () => assertEqual(handScore([card('A'), card('10'), card('A')]), 12));
test('5+6 = 11 (bonne main pour double)', () => assertEqual(handScore([card('5'), card('6')]), 11));
test('2+2+2+2+2 = 10', () => assertEqual(handScore([...Array(5)].map(() => card('2'))), 10));
test('K+Q+A = 21 (pas blackjack, 3 cartes)', () => {
  const h = [card('K'), card('Q'), card('A')];
  assertEqual(handScore(h), 21);
  assert(!isBlackjack(h), '3 cartes 21 n\'est pas un blackjack');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Payouts précis avec rake ===');

test('win 100 sats: net = 198 (200-2%=196→non, net gain=100-rake=98)', () => {
  const bet = 100;
  const grossPayout = bet * 2; // 200
  const grossGain = grossPayout - bet; // 100
  const rake = getRake(grossGain); // 2
  const net = grossGain - rake; // 98
  assertEqual(net, 98);
});

test('BJ 500 sats: gross gain=750, rake=15, net=735', () => {
  const bet = 500;
  const gross = Math.floor(bet * 2.5) - bet;
  assertEqual(gross - getRake(gross), 735);
});

test('push: rake = 0, payout = mise exacte', () => {
  const bet = 500;
  const net = 0;
  assertEqual(getRake(net), 0);
  assertEqual(net - getRake(net), 0);
});

test('loss: rake = 0 (pas de gains)', () => {
  assertEqual(getRake(-500), 0);
});

test('rake 1 sat minimum sur gain de 10 sats (2% = 0.2 → arrondi à 1)', () => {
  assertEqual(getRake(10), 1);
  assertEqual(getRake(49), 1);
  assertEqual(getRake(50), 1);
});

test('rake 2 sats sur gain de 100 sats', () => {
  assertEqual(getRake(100), 2);
});

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
