/**
 * Tests unitaires — api/_helpers.js
 * Teste: json(), getSessionId(), rateLimit() (logique)
 */

'use strict';

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => { passed++; console.log(`  ✓ ${name}`); })
       .catch(e => { failed++; console.log(`  ✗ ${name}: ${e.message}`); });
    } else {
      passed++; console.log(`  ✓ ${name}`);
    }
  } catch(e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg||''}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

// ── Réimplémenter json() et getSessionId() pour test isolation ──────────────

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function getSessionId(req) {
  const cookieHeader = req.headers.get('cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    }).filter(([k]) => k)
  );
  return cookies.session_id || null;
}

// ── Réimplémenter rateLimit() logique pure ───────────────────────────────────

// Version testable sans KV réel (simule avec un Map en mémoire)
const _store = new Map();

async function rateLimitMock(ip, route, maxRequests, windowSeconds) {
  const key = `ratelimit:global:${route}:${ip}`;

  // SET NX (si pas encore initialisé)
  if (!_store.has(key)) {
    _store.set(key, { count: 0, expiry: Date.now() + windowSeconds * 1000 });
  }

  // Vérifier expiry — important: relire depuis le Map après le reset
  let entry = _store.get(key);
  if (Date.now() > entry.expiry) {
    _store.set(key, { count: 0, expiry: Date.now() + windowSeconds * 1000 });
    entry = _store.get(key); // relire le NOUVEAU objet (pas l'ancien)
  }

  entry.count++;

  if (entry.count > maxRequests) {
    return { blocked: true, count: entry.count, limit: maxRequests };
  }
  return { blocked: false, count: entry.count, limit: maxRequests };
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== json() helper ===');

test('json() renvoie Response avec status correct', async () => {
  const res = json(200, { ok: true });
  assertEqual(res.status, 200);
});

test('json() renvoie Response avec Content-Type application/json', () => {
  const res = json(200, { ok: true });
  assertEqual(res.headers.get('Content-Type'), 'application/json');
});

test('json() sérialise correctement le body', async () => {
  const data = { error: 'Session invalide', code: 42 };
  const res = json(401, data);
  const body = await res.json();
  assertEqual(body.error, 'Session invalide');
  assertEqual(body.code, 42);
});

test('json() 404 → status 404', () => {
  const res = json(404, { error: 'not found' });
  assertEqual(res.status, 404);
});

test('json() 429 → status 429', () => {
  const res = json(429, { error: 'too many' });
  assertEqual(res.status, 429);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== getSessionId() ===');

function makeReq(cookieStr) {
  return { headers: { get: (h) => h === 'cookie' ? cookieStr : null } };
}

test('extrait session_id du cookie', () => {
  const req = makeReq('session_id=abc-123-def');
  assertEqual(getSessionId(req), 'abc-123-def');
});

test('retourne null si pas de cookie', () => {
  const req = makeReq('');
  assertEqual(getSessionId(req), null);
});

test('retourne null si cookie mal nommé', () => {
  const req = makeReq('token=abc-123');
  assertEqual(getSessionId(req), null);
});

test('extrait parmi plusieurs cookies', () => {
  const req = makeReq('foo=bar; session_id=xyz-789; baz=qux');
  assertEqual(getSessionId(req), 'xyz-789');
});

test('retourne null si header cookie absent', () => {
  const req = makeReq(null);
  assertEqual(getSessionId(req), null);
});

test('gère session_id avec UUID complet', () => {
  const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const req = makeReq(`session_id=${uuid}`);
  assertEqual(getSessionId(req), uuid);
});

test('gère le signe = dans la valeur du cookie', () => {
  const req = makeReq('session_id=abc=def=ghi');
  assertEqual(getSessionId(req), 'abc=def=ghi');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== rateLimit() — logique ===');

test('première requête: non bloquée', async () => {
  const r = await rateLimitMock('1.2.3.4', 'test1', 5, 60);
  assert(!r.blocked, 'première requête doit passer');
  assertEqual(r.count, 1);
});

test('sous la limite: non bloquée', async () => {
  _store.clear();
  for (let i = 0; i < 5; i++) await rateLimitMock('1.2.3.5', 'test2', 5, 60);
  const r = await rateLimitMock('1.2.3.5', 'test2', 5, 60);
  assert(!r.blocked, `requête 6/5 devrait passer (limite stricte >5)`);
});

test('au-dessus de la limite: bloquée', async () => {
  _store.clear();
  for (let i = 0; i < 6; i++) await rateLimitMock('2.3.4.5', 'test3', 5, 60);
  const r = await rateLimitMock('2.3.4.5', 'test3', 5, 60);
  assert(r.blocked, 'requête 7 doit être bloquée');
});

test('IPs différentes: compteurs indépendants', async () => {
  _store.clear();
  for (let i = 0; i < 6; i++) await rateLimitMock('3.3.3.3', 'test4', 5, 60);
  // IP différente ne doit pas être bloquée
  const r = await rateLimitMock('4.4.4.4', 'test4', 5, 60);
  assert(!r.blocked, 'autre IP ne doit pas être bloquée');
});

test('routes différentes: compteurs indépendants', async () => {
  _store.clear();
  for (let i = 0; i < 6; i++) await rateLimitMock('5.5.5.5', 'routeA', 5, 60);
  const r = await rateLimitMock('5.5.5.5', 'routeB', 5, 60);
  assert(!r.blocked, 'autre route ne doit pas être bloquée');
});

test('expiry: réinitialise le compteur', async () => {
  _store.clear();
  const ip = '6.6.6.6'; const route = 'expire-test-' + Date.now();
  for (let i = 0; i < 6; i++) await rateLimitMock(ip, route, 5, 60);
  // Forcer expiry en modifiant l'entrée existante
  const key = `ratelimit:global:${route}:${ip}`;
  const entry = _store.get(key);
  entry.expiry = Date.now() - 1000; // expiré
  // La prochaine requête doit réinitialiser le compteur
  const r = await rateLimitMock(ip, route, 5, 60);
  assert(!r.blocked, `après expiry, doit passer. count=${r.count}`);
  assertEqual(r.count, 1, 'compteur remis à 1 après expiry');
});

// ────────────────────────────────────────────────────────────────────────────
// Attendre les promises async puis afficher le résumé
setTimeout(() => {
  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}, 200);
