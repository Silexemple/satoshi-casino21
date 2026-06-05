/**
 * Tests provably-fair — importe le VRAI code de api/_game-helpers.js
 * (ce module n'a aucune dépendance externe, juste le Web Crypto global).
 *
 * Vérifie: déterminisme, intégrité du deck, absence de biais grossier, et la
 * boucle commit-reveal (hash d'engagement == sha256(serverSeed), deck
 * recalculable depuis les graines révélées).
 */
import {
  buildProvablyFairDeck, sha256Hex, createOrderedDeck,
  shuffleDeckProvablyFair, randomSeedHex
} from '../api/_game-helpers.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m||''}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
const fingerprint = (deck) => deck.map(c => c.suit + c.value).join(',');

await test('déterminisme: mêmes graines → deck identique', async () => {
  const args = { serverSeed: 'aa'.repeat(32), clientSeed: 'player-seed', nonce: 7 };
  const d1 = await buildProvablyFairDeck(args);
  const d2 = await buildProvablyFairDeck(args);
  assertEqual(fingerprint(d1), fingerprint(d2), 'reproductible');
});

await test('sensibilité: nonce différent → deck différent', async () => {
  const base = { serverSeed: 'bb'.repeat(32), clientSeed: 'c' };
  const d1 = await buildProvablyFairDeck({ ...base, nonce: 1 });
  const d2 = await buildProvablyFairDeck({ ...base, nonce: 2 });
  assert(fingerprint(d1) !== fingerprint(d2), 'nonce doit changer le mélange');
});

await test('sensibilité: clientSeed différent → deck différent', async () => {
  const base = { serverSeed: 'cc'.repeat(32), nonce: 0 };
  const d1 = await buildProvablyFairDeck({ ...base, clientSeed: 'alice' });
  const d2 = await buildProvablyFairDeck({ ...base, clientSeed: 'bob' });
  assert(fingerprint(d1) !== fingerprint(d2), 'clientSeed doit changer le mélange');
});

await test('intégrité: 52 cartes, permutation exacte du deck ordonné', async () => {
  const deck = await buildProvablyFairDeck({ serverSeed: randomSeedHex(), clientSeed: 'x', nonce: 0 });
  assertEqual(deck.length, 52, 'taille');
  const ordered = createOrderedDeck();
  const sortKey = a => [...a].map(c => c.suit + c.value).sort().join(',');
  assertEqual(sortKey(deck), sortKey(ordered), 'même multiset que le deck ordonné (aucune carte perdue/dupliquée)');
});

await test('commit-reveal: hash d\'engagement == sha256(serverSeed) et deck recalculable', async () => {
  const serverSeed = randomSeedHex();
  const clientSeed = 'joueur-123';
  const nonce = 42;
  // Engagement publié AVANT la main:
  const commitment = await sha256Hex(serverSeed);
  const dealtDeck = await buildProvablyFairDeck({ serverSeed, clientSeed, nonce });
  // Révélation APRÈS: le joueur vérifie le hash puis recalcule le deck
  const recomputedCommitment = await sha256Hex(serverSeed);
  assertEqual(recomputedCommitment, commitment, 'le serverSeed révélé correspond à l\'engagement');
  const verifyDeck = await buildProvablyFairDeck({ serverSeed, clientSeed, nonce });
  assertEqual(fingerprint(verifyDeck), fingerprint(dealtDeck), 'deck recalculé identique → équité prouvée');
});

await test('pas de biais grossier: la 1re carte varie largement sur 120 graines', async () => {
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    const deck = await buildProvablyFairDeck({ serverSeed: randomSeedHex(), clientSeed: 's', nonce: i });
    seen.add(deck[0].value);
  }
  // 13 rangs possibles; un mélange sain en montre largement plus que quelques-uns.
  assert(seen.size >= 9, `1re carte trop concentrée (seulement ${seen.size}/13 rangs vus)`);
});

await test('rejection sampling: shuffle d\'un petit tableau reste une permutation', async () => {
  const arr = [{ suit: 's', value: 'A', num: 11 }, { suit: 'h', value: '2', num: 2 }, { suit: 'd', value: '3', num: 3 }];
  const seed = await sha256Hex('petit-test');
  await shuffleDeckProvablyFair(arr, seed);
  assertEqual(arr.length, 3, 'taille préservée');
  assertEqual([...arr].map(c => c.value).sort().join(''), '23A', 'mêmes éléments');
});

await test('golden vector: empreinte figée (verrou anti-drift de l\'algorithme)', async () => {
  // Si ce vecteur change, /verify.html et TOUS les anciens reveals deviennent
  // invérifiables → changement cassant à assumer explicitement.
  const deck = await buildProvablyFairDeck({
    serverSeed: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    clientSeed: 'golden', nonce: 1
  });
  const expected = 'Q♣,10♥,9♦,5♣,9♥,J♥,Q♠,3♦,K♠,5♦,4♣,7♥,6♥,A♥,Q♥,10♦,10♠,K♦,7♠,3♣,4♠,6♣,J♦,3♠,A♦,9♣,6♠,J♣,2♠,7♦,2♦,7♣,8♣,9♠,K♣,A♣,5♥,A♠,4♦,8♠,K♥,4♥,2♣,J♠,10♣,5♠,8♦,2♥,6♦,3♥,8♥,Q♦';
  assertEqual(deck.map(c => c.value + c.suit).join(','), expected, 'empreinte golden');
});

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
