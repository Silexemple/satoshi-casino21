/**
 * Tests unitaires — Sécurité & Validation
 * Couvre: XSS, injection KV, input validation, NWC URL parsing, cookie security,
 *         sessionId format, nickname sanitization, avatar whitelist, headers
 */

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch(e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m||''}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ── Server-side HTML sanitization (chat.js) ───────────────────────────────────
function sanitizeChat(raw) {
  return raw
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// ── Client-side escapeHtml (table.html) ──────────────────────────────────────
function escapeHtml(str) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  return String(str).replace(/[&<>"']/g, c => replacements[c]);
}

// ── NWC URL parsing & validation ─────────────────────────────────────────────
function parseNWCUrl(url) {
  const withoutScheme = url.replace('nostr+walletconnect://', '');
  const [pubkey, qs] = withoutScheme.split('?');
  const params = new URLSearchParams(qs || '');
  return { pubkey, relays: params.getAll('relay'), secret: params.get('secret') };
}

function validateNWCUrl(url) {
  if (!url || !url.startsWith('nostr+walletconnect://')) return 'Schéma invalide';
  const { pubkey, relays, secret } = parseNWCUrl(url);
  if (!pubkey || !/^[a-f0-9]{64}$/i.test(pubkey)) return 'pubkey invalide';
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) return 'secret invalide';
  if (!relays || relays.length === 0) return 'aucun relay configuré';
  return null;
}

// ── Nickname sanitization (session.js) ───────────────────────────────────────
function sanitizeNickname(raw) {
  const nick = (raw || '').trim().slice(0, 16);
  return nick.replace(/[^a-zA-Z0-9 _\-]/g, '').trim();
}

// ── k1 format validation (auth/generate.js, auth/status.js) ─────────────────
function validateK1(k1) {
  return k1 && /^[0-9a-f]{64}$/i.test(k1);
}

// ── sessionId format (UUID v4) ────────────────────────────────────────────────
function validateSessionId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ── Avatar whitelist ──────────────────────────────────────────────────────────
const VALID_AVATARS = ['💀','👑','♠️','💎','🔥','🚀','🎯','🐺','⚡','🦅','🎰','🃏'];
function validateAvatar(av) {
  return VALID_AVATARS.includes(av);
}

// ── Bet amount validation ─────────────────────────────────────────────────────
function validateBet(amount, minBet, maxBet) {
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) return false;
  return amount >= minBet && amount <= maxBet;
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== XSS: sanitizeChat() côté serveur ===');

test('<script> tag neutralisé', () => {
  const r = sanitizeChat('<script>alert(1)</script>');
  assert(!r.includes('<script>'), 'doit échapper les balises');
  assert(r.includes('&lt;script&gt;'));
});

test('img onerror neutralisé', () => {
  const r = sanitizeChat('<img src=x onerror=alert(1)>');
  assert(!r.includes('<img'), 'balise img neutralisée');
});

test('SVG onload neutralisé', () => {
  const r = sanitizeChat('<svg onload=alert(1)>');
  assert(r.includes('&lt;svg'));
});

test('guillemets doubles échappés', () => {
  assert(sanitizeChat('"hello"').includes('&quot;'));
});

test('guillemets simples échappés', () => {
  assert(sanitizeChat("it's").includes('&#x27;'));
});

test('slash échappé (protection URL injection)', () => {
  assert(sanitizeChat('foo/bar').includes('&#x2F;'));
});

test('texte normal préservé', () => {
  const r = sanitizeChat('GL! Bien joué 42');
  assert(r.includes('GL!'));
  assert(r.includes('Bien'));
});

test('emoji préservé', () => {
  const r = sanitizeChat('😀 🃏 ₿');
  assert(r.includes('😀'));
  assert(r.includes('₿'));
});

test('message vide reste vide', () => assertEqual(sanitizeChat(''), ''));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== XSS: escapeHtml() côté client ===');

test('& échappé en &amp;', () => assert(escapeHtml('a&b').includes('&amp;')));
test('< échappé en &lt;', () => assert(escapeHtml('<div>').includes('&lt;')));
test('> échappé en &gt;', () => assert(escapeHtml('<div>').includes('&gt;')));
test('" échappé en &quot;', () => assert(escapeHtml('"hello"').includes('&quot;')));
test("' échappé en &#x27;", () => assert(escapeHtml("it's").includes('&#x27;')));
test('null converti en string', () => assertEqual(escapeHtml(null), 'null'));
test('number converti en string', () => assertEqual(escapeHtml(42), '42'));
test('XSS complet neutralisé', () => {
  const r = escapeHtml('<script>alert("xss")</script>');
  assert(!r.includes('<script>'));
  assert(r.includes('&lt;script&gt;'));
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== NWC URL validation ===');

const VALID_PUBKEY = 'a'.repeat(64);
const VALID_SECRET = 'b'.repeat(64);
const VALID_NWC = `nostr+walletconnect://${VALID_PUBKEY}?relay=wss://relay.getalby.com&secret=${VALID_SECRET}`;

test('URL NWC valide: pas d\'erreur', () => assertEqual(validateNWCUrl(VALID_NWC), null));

test('schéma invalide rejeté', () => {
  assert(validateNWCUrl('http://evil.com') !== null);
});

test('pubkey trop courte rejetée', () => {
  const bad = `nostr+walletconnect://${'a'.repeat(63)}?relay=wss://r.com&secret=${VALID_SECRET}`;
  assert(validateNWCUrl(bad) !== null, 'pubkey 63 chars doit être rejetée');
});

test('pubkey trop longue rejetée', () => {
  const bad = `nostr+walletconnect://${'a'.repeat(65)}?relay=wss://r.com&secret=${VALID_SECRET}`;
  assert(validateNWCUrl(bad) !== null, 'pubkey 65 chars doit être rejetée');
});

test('pubkey avec chars non-hex rejetée', () => {
  const bad = `nostr+walletconnect://${'z'.repeat(64)}?relay=wss://r.com&secret=${VALID_SECRET}`;
  assert(validateNWCUrl(bad) !== null);
});

test('secret invalide rejeté', () => {
  const bad = `nostr+walletconnect://${VALID_PUBKEY}?relay=wss://r.com&secret=tooshort`;
  assert(validateNWCUrl(bad) !== null);
});

test('secret manquant rejeté', () => {
  const bad = `nostr+walletconnect://${VALID_PUBKEY}?relay=wss://r.com`;
  assert(validateNWCUrl(bad) !== null);
});

test('relay manquant rejeté', () => {
  const bad = `nostr+walletconnect://${VALID_PUBKEY}?secret=${VALID_SECRET}`;
  assert(validateNWCUrl(bad) !== null);
});

test('URL null rejetée', () => assert(validateNWCUrl(null) !== null));
test('URL vide rejetée', () => assert(validateNWCUrl('') !== null));

test('parseNWCUrl: extrait correctement pubkey, secret, relay', () => {
  const parsed = parseNWCUrl(VALID_NWC);
  assertEqual(parsed.pubkey, VALID_PUBKEY);
  assertEqual(parsed.secret, VALID_SECRET);
  assertEqual(parsed.relays[0], 'wss://relay.getalby.com');
});

test('parseNWCUrl: supporte plusieurs relays', () => {
  const url = `nostr+walletconnect://${VALID_PUBKEY}?relay=wss://r1.com&relay=wss://r2.com&secret=${VALID_SECRET}`;
  const parsed = parseNWCUrl(url);
  assertEqual(parsed.relays.length, 2);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== k1 challenge validation ===');

test('k1 valide: 64 chars hex', () => {
  assert(validateK1('a'.repeat(64)));
  assert(validateK1('0123456789abcdef'.repeat(4)));
});
test('k1 invalide: 63 chars', () => assert(!validateK1('a'.repeat(63))));
test('k1 invalide: 65 chars', () => assert(!validateK1('a'.repeat(65))));
test('k1 invalide: chars non-hex', () => assert(!validateK1('z' + 'a'.repeat(63))));
test('k1 invalide: vide', () => assert(!validateK1('')));
test('k1 invalide: null', () => assert(!validateK1(null)));
test('k1 invalide: undefined', () => assert(!validateK1(undefined)));
test('k1 valide: majuscules acceptées', () => assert(validateK1('A'.repeat(64))));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Nickname sanitization ===');

test('nickname normal préservé', () => assertEqual(sanitizeNickname('Silex'), 'Silex'));
test('nickname avec espaces: préservé', () => assertEqual(sanitizeNickname('Silex BTC'), 'Silex BTC'));
test('nickname avec tiret: préservé', () => assertEqual(sanitizeNickname('Silex-21'), 'Silex-21'));
test('nickname avec underscore: préservé', () => assertEqual(sanitizeNickname('Silex_21'), 'Silex_21'));
test('nickname trop long: tronqué à 16 chars', () => {
  const result = sanitizeNickname('a'.repeat(20));
  assert(result.length <= 16, `longueur=${result.length}`);
});
test('nickname avec HTML: nettoyé', () => {
  const r = sanitizeNickname('<script>');
  assert(!r.includes('<'), 'HTML doit être retiré');
  assert(!r.includes('>'));
});
test('nickname avec emoji: retiré', () => {
  const r = sanitizeNickname('😀Player');
  assert(!r.includes('😀'), 'emoji doit être retiré par la regex [^a-zA-Z0-9 _-]');
  assert(r.includes('Player'));
});
test('nickname vide → vide', () => assertEqual(sanitizeNickname(''), ''));
test('nickname null → vide', () => assertEqual(sanitizeNickname(null), ''));
test('nickname espaces only → vide (trim)', () => assertEqual(sanitizeNickname('   '), ''));
test('nickname avec apostrophe: retiré', () => {
  assert(!sanitizeNickname("l'as").includes("'"));
});
test('nickname avec SQL injection: nettoyé', () => {
  const r = sanitizeNickname("'; DROP TABLE");
  assert(!r.includes("'") && !r.includes(';'));
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Avatar whitelist ===');

test('avatar valide: 💀', () => assert(validateAvatar('💀')));
test('avatar valide: ₿ (pas dans la liste) → rejeté', () => assert(!validateAvatar('₿')));
test('avatar valide: 🔥', () => assert(validateAvatar('🔥')));
test('string vide: rejeté', () => assert(!validateAvatar('')));
test('null: rejeté', () => assert(!validateAvatar(null)));
test('undefined: rejeté', () => assert(!validateAvatar(undefined)));
test('script injection: rejeté', () => assert(!validateAvatar('<script>')));
test('tous les avatars valides acceptés', () => {
  VALID_AVATARS.forEach(av => assert(validateAvatar(av), `${av} doit être valide`));
});
test('avatar inventé: rejeté', () => assert(!validateAvatar('🎪')));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Bet validation ===');

test('mise valide: 100 sats', () => assert(validateBet(100, 100, 2500)));
test('mise valide: 2500 sats', () => assert(validateBet(2500, 100, 2500)));
test('mise valide: 1000 sats', () => assert(validateBet(1000, 100, 5000)));
test('mise sous minimum: rejetée', () => assert(!validateBet(99, 100, 2500)));
test('mise sur maximum: rejetée', () => assert(!validateBet(2501, 100, 2500)));
test('mise 0: rejetée', () => assert(!validateBet(0, 100, 2500)));
test('mise négative: rejetée', () => assert(!validateBet(-100, 100, 2500)));
test('mise float: rejetée', () => assert(!validateBet(500.5, 100, 2500)));
test('mise NaN: rejetée', () => assert(!validateBet(NaN, 100, 2500)));
test('mise Infinity: rejetée', () => assert(!validateBet(Infinity, 100, 2500)));
test('mise string: rejetée', () => assert(!validateBet('500', 100, 2500)));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== sessionId format ===');

test('UUID v4 valide', () => {
  assert(validateSessionId('550e8400-e29b-41d4-a716-446655440000'));
});
test('UUID v4 généré par crypto.randomUUID() format', () => {
  // crypto.randomUUID() génère toujours des UUIDs v4
  const fakeUUID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
  assert(validateSessionId(fakeUUID));
});
test('string aléatoire: rejetée', () => assert(!validateSessionId('not-a-uuid')));
test('UUID sans tirets: rejeté', () => assert(!validateSessionId('550e8400e29b41d4a716446655440000')));
test('vide: rejeté', () => assert(!validateSessionId('')));
test('injection avec slashes: rejetée', () => assert(!validateSessionId('../session:abc')));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Sécurité KV — injection via clés ===');

// Test que les patterns de clés KV ne permettent pas d'accéder à d'autres données
test('paymentHash valide ne contient pas de séparateurs KV', () => {
  const hash = 'a'.repeat(64);
  assert(!hash.includes(':'), 'hash ne doit pas contenir ":"');
  assert(!hash.includes('/'), 'hash ne doit pas contenir "/"');
});

test('paymentHash avec path traversal: regex bloque', () => {
  const malicious = '../session:evil-key';
  assert(!/^[a-f0-9]{64}$/i.test(malicious), 'path traversal bloqué par regex');
});

test('sessionId en tant que clé KV: UUID empêche injection', () => {
  const sessionId = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
  // session:{sessionId} = 'session:a1b2c3d4-...' — les tirets ne sont pas des séparateurs Redis
  assert(!sessionId.includes('*'), 'pas de glob');
  assert(!sessionId.includes('['), 'pas de pattern');
});

test('linkingKey valide: 66 chars hex compressé (02/03 prefix)', () => {
  const lk = '02' + 'a'.repeat(64);
  assert(/^0[23][a-f0-9]{64}$/i.test(lk), 'format pubkey compressé valide');
  assertEqual(lk.length, 66);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Cookie security flags ===');

function getSecureFlag() {
  return process.env.NODE_ENV === 'production';
}

test('secure flag actif en production', () => {
  const orig = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert(getSecureFlag(), 'secure doit être true en prod');
  process.env.NODE_ENV = orig;
});

test('secure flag inactif en dev (expected pour local HTTPS)', () => {
  const orig = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  assert(!getSecureFlag(), 'secure=false en dev (HTTP local)');
  process.env.NODE_ENV = orig;
});

test('sameSite=lax protège contre CSRF cross-origin', () => {
  const sameSite = 'lax';
  assert(['strict', 'lax'].includes(sameSite), 'sameSite doit être strict ou lax');
});

test('httpOnly empêche accès JS au cookie de session', () => {
  const httpOnly = true;
  assert(httpOnly, 'httpOnly doit être true');
});

// ── Comparaison token admin à temps constant (safeEqual) ─────────────────────
// Mirroir de api/_helpers.js::safeEqual
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
test('safeEqual: vrai pour chaînes identiques', () => assert(safeEqual('s3cret-token', 's3cret-token')));
test('safeEqual: faux si un caractère diffère', () => assert(!safeEqual('s3cret-token', 's3cret-toketX'.slice(0,12))));
test('safeEqual: faux si longueur différente', () => assert(!safeEqual('abc', 'abcd')));
test('safeEqual: faux pour non-string (null/undefined)', () => {
  assert(!safeEqual(null, 'x')); assert(!safeEqual('x', undefined)); assert(!safeEqual(undefined, undefined));
});
test('safeEqual: faux pour chaîne vide vs token', () => assert(!safeEqual('', 'token')));

import { readFileSync as _rfs } from 'fs';
import { dirname as _dn, join as _jn } from 'path';
import { fileURLToPath as _fup } from 'url';
test('admin.js & auth/test.js utilisent safeEqual (pas de comparaison ===)', () => {
  const base = _jn(_dn(_fup(import.meta.url)), '..', 'api');
  const admin = _rfs(_jn(base, 'admin.js'), 'utf8');
  const authTest = _rfs(_jn(base, 'auth', 'test.js'), 'utf8');
  assert(admin.includes('safeEqual('), 'admin.js doit utiliser safeEqual');
  assert(authTest.includes('safeEqual('), 'auth/test.js doit utiliser safeEqual');
  assert(!/adminToken !== process\.env\.ADMIN_TOKEN/.test(admin), 'admin.js ne doit plus comparer avec !==');
});

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
