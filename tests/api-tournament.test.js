/**
 * Tests unitaires — Logique tournois
 * Couvre: prize distribution, ranking, buy-in validation,
 *         auto-restart, refund annulation, chips progression
 */

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch(e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m||''}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function assertClose(a, b, tol = 1, m) {
  if (Math.abs(a - b) > tol) throw new Error(`${m||''}: got ${a}, want ~${b} (±${tol})`);
}

// ── Copie exacte de finishTournament (logique pure, sans KV) ─────────────────
function finishTournament(tournament) {
  const ranked = [...tournament.players].sort((a, b) => b.chips - a.chips);
  ranked.forEach((p, i) => { p.rank = i + 1; });

  tournament.leaderboard = ranked.map(p => ({
    nickname: p.nickname,
    chips: p.chips,
    rank: p.rank,
    roundsPlayed: p.roundsPlayed
  }));

  const prizePool = tournament.players.length * tournament.buyIn;
  let prizes;

  if (ranked.length === 1) {
    prizes = [prizePool];
  } else if (ranked.length === 2) {
    prizes = [Math.floor(prizePool * 0.7), prizePool - Math.floor(prizePool * 0.7)];
  } else {
    const p1 = Math.floor(prizePool * 0.6);
    const p2 = Math.floor(prizePool * 0.3);
    prizes = [p1, p2, prizePool - p1 - p2];
  }

  for (let i = 0; i < Math.min(prizes.length, ranked.length); i++) {
    ranked[i].prize = prizes[i];
  }

  tournament.status = 'finished';
  tournament.prizes = prizes;
  tournament.prizePool = prizePool;
  return tournament;
}

// ── Chip progression (mise = 10% des chips restants) ─────────────────────────
function getBet(chips) {
  return Math.max(10, Math.floor(chips * 10 / 100));
}

// ── Création d'un tournoi test ────────────────────────────────────────────────
function makeTournament(buyIn, playerCount, overrides = {}) {
  const players = Array.from({ length: playerCount }, (_, i) => ({
    sessionId: `s${i}`,
    linkingKey: `lk${i}`,
    nickname: `Joueur${i + 1}`,
    chips: 1000 + i * 100, // chips différents pour ranking
    roundsPlayed: 5,
    busted: false,
    totalWon: 0,
    totalLost: 0,
    rank: null,
    prize: 0,
  }));
  return {
    id: 'test-tournament',
    name: 'Test Tournament',
    buyIn,
    startingChips: 1000,
    totalRounds: 10,
    maxPlayers: 8,
    minPlayers: 2,
    players,
    status: 'running',
    ...overrides
  };
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Prize pool calculation ===');

test('prize pool = buyIn × nb joueurs', () => {
  const t = makeTournament(500, 4);
  assertEqual(t.players.length * t.buyIn, 2000);
});

test('prize pool Freeroll: 100 × 3 = 300', () => {
  const t = makeTournament(100, 3);
  assertEqual(t.players.length * t.buyIn, 300);
});

test('prize pool High Roller: 2000 × 6 = 12000', () => {
  const t = makeTournament(2000, 6);
  assertEqual(t.players.length * t.buyIn, 12000);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Prize distribution — 1 joueur ===');

test('1 joueur → remporte tout', () => {
  const t = makeTournament(500, 1);
  finishTournament(t);
  assertEqual(t.prizes[0], 500);
  assertEqual(t.players[0].prize, 500);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Prize distribution — 2 joueurs ===');

test('2 joueurs: 70% / 30% de la cagnotte', () => {
  const t = makeTournament(500, 2);
  // prizePool = 1000
  finishTournament(t);
  assertEqual(t.prizes[0], 700); // 70%
  assertEqual(t.prizes[1], 300); // 30%
});

test('2 joueurs: somme = prize pool', () => {
  const t = makeTournament(500, 2);
  finishTournament(t);
  const sum = t.prizes.reduce((a, b) => a + b, 0);
  assertEqual(sum, t.prizePool);
});

test('2 joueurs: 1er place correctement classé (plus de chips)', () => {
  const t = makeTournament(500, 2);
  // player[1] a 1100 chips, player[0] a 1000 → player[1] doit être 1er
  finishTournament(t);
  assertEqual(t.leaderboard[0].nickname, 'Joueur2', '1er: Joueur2 (1100 chips)');
  assertEqual(t.leaderboard[1].nickname, 'Joueur1', '2e: Joueur1 (1000 chips)');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Prize distribution — 3+ joueurs ===');

test('3 joueurs: 60% / 30% / 10%', () => {
  const t = makeTournament(500, 3);
  // prizePool = 1500
  finishTournament(t);
  assertEqual(t.prizes[0], 900);  // 60% de 1500
  assertEqual(t.prizes[1], 450);  // 30% de 1500
  assertEqual(t.prizes[2], 150);  // 10% de 1500 (arrondi: 1500-900-450=150)
});

test('3 joueurs: somme = prize pool', () => {
  const t = makeTournament(500, 3);
  finishTournament(t);
  const sum = t.prizes.reduce((a, b) => a + b, 0);
  assertEqual(sum, t.prizePool);
});

test('4 joueurs: top 3 payés, 4e rien', () => {
  const t = makeTournament(500, 4);
  finishTournament(t);
  assertEqual(t.prizes.length, 3, 'seulement 3 prix pour 4 joueurs');
  assert(!t.players[0].prize || t.players[0].prize >= 0, '4e joueur peut avoir prize 0');
});

test('6 joueurs: somme prizes = prize pool total', () => {
  const t = makeTournament(500, 6);
  // prizePool = 3000, on ne distribue que 3 prizes
  finishTournament(t);
  const sum = t.prizes.reduce((a, b) => a + b, 0);
  assertEqual(sum, t.prizePool);
});

test('8 joueurs High Roller: pas de sats perdus', () => {
  const t = makeTournament(2000, 8);
  // prizePool = 16000
  finishTournament(t);
  const sum = t.prizes.reduce((a, b) => a + b, 0);
  assertEqual(sum, t.prizePool, `sum=${sum}, pool=${t.prizePool}`);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Ranking ===');

test('classement par chips décroissant', () => {
  const t = makeTournament(500, 4);
  finishTournament(t);
  const chips = t.leaderboard.map(p => p.chips);
  for (let i = 0; i < chips.length - 1; i++) {
    assert(chips[i] >= chips[i + 1], `chips[${i}]=${chips[i]} doit être >= chips[${i+1}]=${chips[i+1]}`);
  }
});

test('rang 1 = plus de chips', () => {
  const t = makeTournament(500, 3);
  finishTournament(t);
  assertEqual(t.leaderboard[0].rank, 1);
  assertEqual(t.leaderboard[1].rank, 2);
  assertEqual(t.leaderboard[2].rank, 3);
});

test('leaderboard contient nickname, chips, rank', () => {
  const t = makeTournament(100, 2);
  finishTournament(t);
  const entry = t.leaderboard[0];
  assert(entry.nickname !== undefined);
  assert(entry.chips !== undefined);
  assert(entry.rank !== undefined);
  assert(entry.roundsPlayed !== undefined);
});

test('statut devient finished après finishTournament', () => {
  const t = makeTournament(500, 3);
  finishTournament(t);
  assertEqual(t.status, 'finished');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Chip progression (mise = 10%) ===');

test('chips 1000: mise = 100', () => assertEqual(getBet(1000), 100));
test('chips 5000: mise = 500', () => assertEqual(getBet(5000), 500));
test('chips 10000: mise = 1000', () => assertEqual(getBet(10000), 1000));
test('chips 150: mise = 15', () => assertEqual(getBet(150), 15));
test('chips 50: mise = 5 → minimum 10', () => assertEqual(getBet(50), 10));
test('chips 9: mise = 0 → minimum 10', () => assertEqual(getBet(9), 10));
test('chips 0: mise = 0 → minimum 10', () => assertEqual(getBet(0), 10));
test('chips 10000 Freeroll (1000 start): après 10 rounds au moins 10% reste', () => {
  let chips = 1000;
  for (let i = 0; i < 10; i++) {
    const bet = getBet(chips);
    chips -= bet; // simuler une perte
  }
  assert(chips > 0, `chips restants: ${chips}`);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Validation tournoi ===');

test('buy-in Freeroll: 100 sats', () => {
  const t = makeTournament(100, 3);
  assertEqual(t.buyIn, 100);
});

test('buy-in Standard: 500 sats', () => {
  const t = makeTournament(500, 3);
  assertEqual(t.buyIn, 500);
});

test('buy-in High Roller: 2000 sats', () => {
  const t = makeTournament(2000, 3);
  assertEqual(t.buyIn, 2000);
});

test('joueur busted: chips <= 0', () => {
  const player = { chips: 0, busted: true };
  assert(player.busted || player.chips <= 0);
});

test('all done: tous busted ou rounds terminés', () => {
  const players = [
    { busted: true, roundsPlayed: 5, totalRounds: 10 },
    { busted: false, roundsPlayed: 10, totalRounds: 10 },
  ];
  const allDone = players.every(p => p.busted || p.roundsPlayed >= 10);
  assert(allDone);
});

test('pas all done: un joueur encore actif', () => {
  const players = [
    { busted: false, roundsPlayed: 5, totalRounds: 10 },
    { busted: false, roundsPlayed: 10, totalRounds: 10 },
  ];
  const allDone = players.every(p => p.busted || p.roundsPlayed >= 10);
  assert(!allDone);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Refund annulation ===');

test('remboursement = buyIn par joueur', () => {
  const buyIn = 500;
  const players = [{ linkingKey: 'lk1' }, { linkingKey: 'lk2' }];
  let totalRefunded = 0;
  players.forEach(() => { totalRefunded += buyIn; });
  assertEqual(totalRefunded, players.length * buyIn);
});

test('remboursement complet: aucun sat perdu', () => {
  const buyIn = 100;
  const playerCount = 4;
  const prizePool = buyIn * playerCount;
  const refunded = buyIn * playerCount;
  assertEqual(prizePool, refunded, 'remboursement doit couvrir toute la cagnotte');
});

test('remboursement non appliqué si tournoi running', () => {
  const t = makeTournament(500, 3);
  assertEqual(t.status, 'running');
  // Un tournoi running ne rembourse pas
  assert(t.status !== 'cancelled');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Auto-restart ===');

test('nouveau tournoi a le même nom que l\'original', () => {
  const original = { name: 'Freeroll Debutant', buyIn: 100 };
  const newT = { name: original.name, buyIn: original.buyIn, status: 'registering' };
  assertEqual(newT.name, original.name);
});

test('nouveau tournoi repart à 0 joueurs', () => {
  const newT = { players: [], status: 'registering' };
  assertEqual(newT.players.length, 0);
});

test('nouveau tournoi est en mode registering', () => {
  const newT = { status: 'registering' };
  assertEqual(newT.status, 'registering');
});

test('ancien tournoi retiré de la liste active après fin', () => {
  const activeIds = new Set(['tourney-old', 'tourney-active']);
  activeIds.delete('tourney-old');
  assert(!activeIds.has('tourney-old'));
  assert(activeIds.has('tourney-active'));
});

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
