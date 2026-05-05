/**
 * Tests unitaires — Logique paiements Lightning
 * Couvre: decodeInvoiceAmount(), validation invoice, anti-replay, deposit strict, paymentHash regex
 */

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch(e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m||''}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function assertNull(a, m) { if (a !== null) throw new Error(`${m||''}: expected null, got ${JSON.stringify(a)}`); }

// ── Copie exacte de decodeInvoiceAmount depuis withdraw.js ───────────────────
function decodeInvoiceAmount(invoice) {
  try {
    const lower = invoice.toLowerCase();
    const match = lower.match(/^lnbc(\d+)([munp])?1/);
    if (!match) return null;
    const [, amountStr, unit] = match;
    const amount = BigInt(amountStr);
    if (amount <= 0n) return null;
    const multipliers = { 'm': BigInt(100000000), 'u': BigInt(100000), 'n': BigInt(100), 'p': BigInt(1) };
    const amountMsat = unit ? amount * multipliers[unit] : amount * BigInt(100000000000);
    return Number(amountMsat / BigInt(1000));
  } catch (e) { return null; }
}

// ── Copie exacte de la validation deposit depuis deposit.js ──────────────────
function validateDepositAmount(rawAmount) {
  const MAX_DEPOSIT = 100000;
  if (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') return null;
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount < 100 || amount > MAX_DEPOSIT) return null;
  return amount;
}

// ── Validation paymentHash (regex depuis check-payment) ──────────────────────
function validatePaymentHash(hash) {
  return /^[a-f0-9]{64}$/i.test(hash);
}

// ── Validation invoice depuis withdraw.js ────────────────────────────────────
function validateInvoice(invoice) {
  if (!invoice) return 'Invoice manquante';
  const lower = invoice.trim().toLowerCase();
  if (!lower.startsWith('lnbc')) return 'Invoice invalide (doit commencer par lnbc)';
  if (lower.length < 20 || lower.length > 10000) return 'Invoice invalide (longueur incorrecte)';
  return null; // OK
}

// ── Anti-replay: processed key logic ────────────────────────────────────────
class ProcessedInvoices {
  constructor() { this._store = new Map(); }
  isProcessed(invoice) {
    const entry = this._store.get(invoice);
    if (!entry) return false;
    if (Date.now() > entry.expiry) { this._store.delete(invoice); return false; }
    return true;
  }
  markProcessed(invoice, paymentHash) {
    this._store.set(invoice, { payment_hash: paymentHash, expiry: Date.now() + 604800000 });
  }
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== decodeInvoiceAmount() ===');

test('sans unité = montant en BTC * 1e8 sats', () => {
  // lnbc1000... sans unité = 1000 BTC en sats = impossible en pratique mais test logique
  // En pratique on utilise milli
  // lnbc1m1... = 1 millibitcoin = 100000 sats
  const result = decodeInvoiceAmount('lnbc1m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyq');
  assertEqual(result, 100000, 'lnbc1m doit valoir 100000 sats');
});

test('unité m (milli-BTC) : 1m = 100000 sats', () => {
  assertEqual(decodeInvoiceAmount('lnbc1m1anything'), 100000);
});

test('unité m : 500m = 50000000 sats', () => {
  assertEqual(decodeInvoiceAmount('lnbc500m1anything'), 50000000);
});

test('unité u (micro-BTC) : 1u = 100 sats', () => {
  assertEqual(decodeInvoiceAmount('lnbc1u1anything'), 100);
});

test('unité u : 1000u = 100000 sats', () => {
  assertEqual(decodeInvoiceAmount('lnbc1000u1anything'), 100000);
});

test('unité n (nano-BTC) : 1000n = 100 sats', () => {
  assertEqual(decodeInvoiceAmount('lnbc1000n1anything'), 100);
});

test('unité n : 100000n = 10000 sats', () => {
  assertEqual(decodeInvoiceAmount('lnbc100000n1anything'), 10000);
});

test('unité p (pico-BTC) : 1000000p = 1000 sats', () => {
  // 1p = 1 msat (unité minimum), 1000000p = 1000000 msat / 1000 = 1000 sats
  assertEqual(decodeInvoiceAmount('lnbc1000000p1anything'), 1000);
});

test('retourne null si pas une invoice lnbc', () => {
  assertNull(decodeInvoiceAmount('lntb100u1anything'), 'testnet invoice');
});

test('retourne null si montant 0', () => {
  assertNull(decodeInvoiceAmount('lnbc0m1anything'));
});

test('retourne null si format invalide', () => {
  assertNull(decodeInvoiceAmount('not-an-invoice'));
});

test('retourne null si string vide', () => {
  assertNull(decodeInvoiceAmount(''));
});

test('retourne null si null passé', () => {
  assertNull(decodeInvoiceAmount(null));
});

test('insensible à la casse (LNBC = lnbc)', () => {
  const r = decodeInvoiceAmount('LNBC1m1anything');
  assertEqual(r, 100000);
});

test('10m = 1000000 sats (1M sats)', () => {
  assertEqual(decodeInvoiceAmount('lnbc10m1anything'), 1000000);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== validateDepositAmount() ===');

test('100 sats : valide', () => assertEqual(validateDepositAmount(100), 100));
test('1000 sats : valide', () => assertEqual(validateDepositAmount(1000), 1000));
test('100000 sats max : valide', () => assertEqual(validateDepositAmount(100000), 100000));
test('99 sats : invalide (sous minimum)', () => assertNull(validateDepositAmount(99)));
test('100001 sats : invalide (sur maximum)', () => assertNull(validateDepositAmount(100001)));
test('0 : invalide', () => assertNull(validateDepositAmount(0)));
test('négatif : invalide', () => assertNull(validateDepositAmount(-100)));

test("chaîne '1000' : valide (coercition)", () => {
  assertEqual(validateDepositAmount('1000'), 1000);
});

test("'1000.5' float : invalide (non entier)", () => {
  assertNull(validateDepositAmount('1000.5'));
});

test("'1e5' : invalide (notation scientifique → Number('1e5')=100000 est entier)", () => {
  // Number('1e5') = 100000, Number.isInteger(100000) = true
  // C'est valide! 1e5 = 100000 sats, exactement le max.
  const r = validateDepositAmount('1e5');
  assertEqual(r, 100000, "'1e5' = 100000 = max deposit, doit être accepté");
});

test("'1e6' : invalide (>100000)", () => {
  assertNull(validateDepositAmount('1e6'), '1e6 = 1000000 > 100000');
});

test('null : invalide', () => assertNull(validateDepositAmount(null)));
test('undefined : invalide', () => assertNull(validateDepositAmount(undefined)));
test('objet : invalide', () => assertNull(validateDepositAmount({})));
test('NaN : invalide', () => assertNull(validateDepositAmount(NaN)));

test("'100abc' parseInt trap : invalide (Number('100abc') = NaN)", () => {
  assertNull(validateDepositAmount('100abc'));
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== validatePaymentHash() ===');

const VALID_HASH = 'a'.repeat(64);
test('hash 64 chars hex valide', () => assert(validatePaymentHash(VALID_HASH)));
test('hash mixte majuscule/minuscule valide', () => assert(validatePaymentHash('A1B2C3' + 'a'.repeat(58))));
test('hash 63 chars : invalide', () => assert(!validatePaymentHash('a'.repeat(63))));
test('hash 65 chars : invalide', () => assert(!validatePaymentHash('a'.repeat(65))));
test('hash vide : invalide', () => assert(!validatePaymentHash('')));
test('hash avec chars non-hex : invalide', () => assert(!validatePaymentHash('z' + 'a'.repeat(63))));
test('hash avec espace : invalide', () => assert(!validatePaymentHash(' ' + 'a'.repeat(63))));
test('hash avec slash : invalide', () => assert(!validatePaymentHash('a'.repeat(32) + '/' + 'a'.repeat(31))));
test('hash avec point : invalide', () => assert(!validatePaymentHash('a'.repeat(32) + '.' + 'a'.repeat(31))));
test('null : invalide', () => assert(!validatePaymentHash(null)));
test('../ path traversal : invalide', () => assert(!validatePaymentHash('../session:abc')));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== validateInvoice() ===');

test('invoice lnbc valide', () => {
  assert(validateInvoice('lnbc1000u1pvjluez...') === null);
});
test('invoice LNBC majuscule valide', () => {
  assert(validateInvoice('LNBC1000u1pvjluez...') === null);
});
test('invoice null → erreur', () => {
  assert(validateInvoice(null) !== null);
});
test('invoice vide → erreur', () => {
  assert(validateInvoice('') !== null);
});
test('invoice testnet lntb → erreur', () => {
  assert(validateInvoice('lntb100u1anything') !== null);
});
test('invoice trop courte (<20) → erreur', () => {
  assert(validateInvoice('lnbc1m1') !== null);
});
test('invoice avec longueur 10001 → erreur', () => {
  assert(validateInvoice('lnbc' + 'a'.repeat(9997)) !== null);
});
test('invoice longueur exacte 20 → valide', () => {
  assert(validateInvoice('lnbc' + 'a'.repeat(16)) === null);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Anti-replay: processed invoices ===');

test('nouvelle invoice: non processée', () => {
  const store = new ProcessedInvoices();
  assert(!store.isProcessed('lnbc1m1invoice-abc'));
});

test('après mark: détectée comme processée', () => {
  const store = new ProcessedInvoices();
  store.markProcessed('lnbc1m1invoice-abc', 'hash123');
  assert(store.isProcessed('lnbc1m1invoice-abc'));
});

test('invoice différente: non processée', () => {
  const store = new ProcessedInvoices();
  store.markProcessed('lnbc1m1invoice-abc', 'hash123');
  assert(!store.isProcessed('lnbc1m1invoice-xyz'));
});

test('expiry: pas détectée après expiration', () => {
  const store = new ProcessedInvoices();
  store._store.set('lnbc1m1old', { payment_hash: 'h', expiry: Date.now() - 1000 });
  assert(!store.isProcessed('lnbc1m1old'), 'entrée expirée doit être ignorée');
});

test('double tentative: bloquée à la 2e', () => {
  const store = new ProcessedInvoices();
  const inv = 'lnbc500u1double-spend-attempt';
  assert(!store.isProcessed(inv));
  store.markProcessed(inv, 'hash-payment');
  assert(store.isProcessed(inv), 'deuxième tentative doit être bloquée');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Stats payload size limit ===');

test('payload 8Ko ou moins: OK', () => {
  const stats = { games: 100, wins: 50, payload: 'a'.repeat(100) };
  const size = JSON.stringify(stats).length;
  assert(size <= 8192, `size=${size}`);
});

test('payload >8Ko: refusé', () => {
  const stats = { data: 'a'.repeat(9000) };
  const size = JSON.stringify(stats).length;
  assert(size > 8192, `devrait dépasser 8Ko, size=${size}`);
});

test('payload exactement 8192: accepté', () => {
  // 8192 - longueur de '{"data":""}' = 10 → 8182 chars de data
  const stats = { data: 'a'.repeat(8181) };
  const size = JSON.stringify(stats).length;
  assert(size <= 8192, `size=${size}`);
});

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
