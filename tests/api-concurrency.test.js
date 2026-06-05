/**
 * Tests de concurrence — verrou solde joueur (withPlayerLock / withTwoPlayerLocks)
 *
 * Démontre l'invariant corrigé par le hardening "money-locks":
 *  - SANS verrou, N crédits concurrents sur un read-modify-write perdent des
 *    updates (lost update → double dépense exploitable).
 *  - AVEC le verrou, le solde final est exact.
 *  - withTwoPlayerLocks (tip) ne deadlock pas en transferts croisés A↔B et
 *    conserve la somme totale.
 *
 * Le harnais réimplémente withPlayerLock à l'identique de api/_helpers.js (les
 * tests de ce repo n'importent pas les handlers, qui dépendent de @vercel/kv).
 * Un test structurel vérifie que le vrai helper existe toujours et porte la
 * bonne clé de verrou, pour éviter qu'une régression supprime la protection.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => { passed++; console.log(`  ✓ ${name}`); })
      .catch(e => { failed++; console.log(`  ✗ ${name}: ${e.message}`); });
    passed++; console.log(`  ✓ ${name}`);
  } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m||''}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const tick = () => new Promise(r => setImmediate(r));

// KV mock fidèle au modèle Redis utilisé en prod:
//  - SET avec {nx} est ATOMIQUE (check+set synchrone, un seul tick) → mutex valide.
//  - GET et SET simple sont async (yield) → le read-modify-write applicatif
//    n'est PAS atomique, exactement la fenêtre de race qu'on corrige.
function makeKV() {
  const store = new Map();
  return {
    async get(k) { await tick(); return store.has(k) ? store.get(k) : null; },
    set(k, v, opts = {}) {
      if (opts.nx) { // chemin verrou: atomique, pas d'await avant le check
        if (store.has(k)) return Promise.resolve(null);
        store.set(k, v); return Promise.resolve('OK');
      }
      return (async () => { await tick(); store.set(k, v); return 'OK'; })();
    },
    async del(k) { await tick(); store.delete(k); return 1; },
    _store: store,
  };
}

// Réimplémentation IDENTIQUE à api/_helpers.js::withPlayerLock (kv injecté).
function makeLockHelpers(kv) {
  async function withPlayerLock(linkingKey, fn, { retries = 100000, delayMs = 1, ttlSec = 10 } = {}) {
    if (!linkingKey) throw new Error('withPlayerLock: linkingKey manquant');
    const lockKey = `lock:player:${linkingKey}`;
    let acquired = false;
    for (let attempt = 0; attempt < retries; attempt++) {
      acquired = await kv.set(lockKey, '1', { nx: true, ex: ttlSec });
      if (acquired) break;
      await new Promise(r => setTimeout(r, delayMs));
    }
    if (!acquired) { const e = new Error('player_locked'); e.code = 'PLAYER_LOCKED'; throw e; }
    try { return await fn(); } finally { try { await kv.del(lockKey); } catch (_) {} }
  }
  async function withTwoPlayerLocks(a, b, fn, opts) {
    if (a === b) return withPlayerLock(a, fn, opts);
    const [first, second] = [a, b].sort();
    return withPlayerLock(first, () => withPlayerLock(second, fn, opts), opts);
  }
  return { withPlayerLock, withTwoPlayerLocks };
}

// ── Test 1: SANS verrou, les crédits concurrents perdent des updates ──────────
await test('sans verrou: 50 crédits concurrents → solde final < 50 (lost update)', async () => {
  const kv = makeKV();
  await kv.set('player:X', { balance: 0 });
  const credit = async () => {
    const p = await kv.get('player:X');
    await tick(); // fenêtre de race entre read et write
    await kv.set('player:X', { balance: p.balance + 1 });
  };
  await Promise.all(Array.from({ length: 50 }, () => credit()));
  const final = (await kv.get('player:X')).balance;
  assert(final < 50, `attendu < 50 (race), obtenu ${final}`);
});

// ── Test 2: AVEC verrou, le solde final est exact ─────────────────────────────
await test('avec withPlayerLock: 50 crédits concurrents → solde final = 50 exact', async () => {
  const kv = makeKV();
  const { withPlayerLock } = makeLockHelpers(kv);
  await kv.set('player:X', { balance: 0 });
  const credit = async () => withPlayerLock('X', async () => {
    const p = await kv.get('player:X');
    await tick();
    await kv.set('player:X', { balance: p.balance + 1 });
  });
  await Promise.all(Array.from({ length: 50 }, () => credit()));
  const final = (await kv.get('player:X')).balance;
  assertEqual(final, 50, 'solde final sous verrou');
});

// ── Test 3: débit concurrent ne peut pas passer le solde sous zéro ────────────
await test('avec withPlayerLock: débits concurrents respectent le solde (pas de double-dépense)', async () => {
  const kv = makeKV();
  const { withPlayerLock } = makeLockHelpers(kv);
  await kv.set('player:X', { balance: 100 });
  let succeeded = 0;
  const tryDebit = async (cost) => withPlayerLock('X', async () => {
    const p = await kv.get('player:X');
    await tick();
    if (p.balance < cost) return;        // refus atomique
    await kv.set('player:X', { balance: p.balance - cost });
    succeeded++;
  });
  // 10 débits de 30 concurrents; seuls 3 peuvent réussir (3×30=90 ≤ 100)
  await Promise.all(Array.from({ length: 10 }, () => tryDebit(30)));
  const final = (await kv.get('player:X')).balance;
  assertEqual(succeeded, 3, 'exactement 3 débits de 30 réussissent');
  assertEqual(final, 10, 'solde final = 100 - 90');
  assert(final >= 0, 'solde jamais négatif');
});

// ── Test 4: withTwoPlayerLocks — transferts croisés A↔B sans deadlock ─────────
await test('withTwoPlayerLocks: tips croisés A→B et B→A ne deadlock pas et conservent la somme', async () => {
  const kv = makeKV();
  const { withTwoPlayerLocks } = makeLockHelpers(kv);
  await kv.set('player:A', { balance: 1000 });
  await kv.set('player:B', { balance: 1000 });
  const transfer = async (from, to, amt) => withTwoPlayerLocks(from, to, async () => {
    const s = await kv.get(`player:${from}`);
    await tick();
    if (s.balance < amt) return;
    const r = await kv.get(`player:${to}`);
    await tick();
    await kv.set(`player:${from}`, { balance: s.balance - amt });
    await kv.set(`player:${to}`, { balance: r.balance + amt });
  });
  // 20 transferts dans les deux sens, ordre d'acquisition canonique (tri) → pas de deadlock
  const ops = [];
  for (let i = 0; i < 20; i++) { ops.push(transfer('A', 'B', 10)); ops.push(transfer('B', 'A', 10)); }
  await Promise.race([
    Promise.all(ops),
    new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: timeout 5s')), 5000)),
  ]);
  const sum = (await kv.get('player:A')).balance + (await kv.get('player:B')).balance;
  assertEqual(sum, 2000, 'somme conservée (aucun sat créé/détruit)');
});

// ── Test 5: structurel — le vrai helper existe et porte la bonne clé ──────────
test('api/_helpers.js exporte withPlayerLock + withTwoPlayerLocks avec lock:player:', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '..', 'api', '_helpers.js'), 'utf8');
  assert(/export async function withPlayerLock\(/.test(src), 'withPlayerLock exporté');
  assert(/export async function withTwoPlayerLocks\(/.test(src), 'withTwoPlayerLocks exporté');
  assert(src.includes('`lock:player:${linkingKey}`'), 'clé de verrou lock:player:{linkingKey}');
});

// ── Footer (format attendu par run-all.js) ────────────────────────────────────
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
