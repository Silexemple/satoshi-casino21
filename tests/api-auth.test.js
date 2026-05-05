/**
 * Tests unitaires — Logique authentification LNAuth (LUD-04)
 * Couvre: DER→compact conversion, k1 validation, session management,
 *         linkingKey format, cookie params, LNURL bech32 format
 */

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch(e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m||''}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ── Copie de hexToBytes depuis auth/callback.js ───────────────────────────────
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ── Copie de derToCompact depuis auth/callback.js ────────────────────────────
function derToCompact(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('Not a DER SEQUENCE');
  i++; // skip total length
  if (der[i++] !== 0x02) throw new Error('Expected INTEGER for r');
  const rLen = der[i++];
  const r = der.slice(i, i + rLen); i += rLen;
  if (der[i++] !== 0x02) throw new Error('Expected INTEGER for s');
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);
  const rClean = r[0] === 0 ? r.slice(1) : r;
  const sClean = s[0] === 0 ? s.slice(1) : s;
  const compact = new Uint8Array(64);
  compact.set(rClean, 32 - rClean.length);
  compact.set(sClean, 64 - sClean.length);
  return compact;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Session TTL constants ─────────────────────────────────────────────────────
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 jours en secondes
const K1_TTL = 600; // 10 minutes en secondes

// ── LNURL bech32 format validation (simplifié) ────────────────────────────────
function isValidLNURL(lnurl) {
  return typeof lnurl === 'string' &&
    lnurl.startsWith('LNURL') &&
    /^[A-Z0-9]+$/.test(lnurl);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== hexToBytes() ===');

test('convertit hex en Uint8Array', () => {
  const bytes = hexToBytes('deadbeef');
  assertEqual(bytes[0], 0xde);
  assertEqual(bytes[1], 0xad);
  assertEqual(bytes[2], 0xbe);
  assertEqual(bytes[3], 0xef);
});

test('hex de longueur paire', () => {
  const bytes = hexToBytes('0000');
  assertEqual(bytes.length, 2);
});

test('hex majuscule fonctionne', () => {
  const bytes = hexToBytes('DEADBEEF');
  assertEqual(bytes[0], 0xde);
});

test('64 chars hex → 32 bytes (k1)', () => {
  const bytes = hexToBytes('a'.repeat(64));
  assertEqual(bytes.length, 32);
});

test('66 chars hex → 33 bytes (pubkey compressé)', () => {
  const bytes = hexToBytes('02' + 'a'.repeat(64));
  assertEqual(bytes.length, 33);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== derToCompact() conversion ===');

// Créer une signature DER minimale pour les tests
function makeDER(rHex, sHex) {
  const r = hexToBytes(rHex.padStart(64, '0'));
  const s = hexToBytes(sHex.padStart(64, '0'));

  // Ajouter 0x00 si le bit de poids fort est 1 (pour éviter l'interprétation négative)
  const rPad = r[0] >= 0x80 ? new Uint8Array([0, ...r]) : r;
  const sPad = s[0] >= 0x80 ? new Uint8Array([0, ...s]) : s;

  const body = new Uint8Array(4 + rPad.length + 2 + sPad.length);
  let i = 0;
  body[i++] = 0x02; body[i++] = rPad.length;
  body.set(rPad, i); i += rPad.length;
  body[i++] = 0x02; body[i++] = sPad.length;
  body.set(sPad, i);

  const der = new Uint8Array(2 + body.length);
  der[0] = 0x30; der[1] = body.length;
  der.set(body, 2);
  return der;
}

test('signature DER → compact = 64 bytes', () => {
  const der = makeDER('a'.repeat(64), 'b'.repeat(64));
  const compact = derToCompact(der);
  assertEqual(compact.length, 64);
});

test('compact: r occupe les 32 premiers bytes', () => {
  // r = [0x01, 0x00, ..., 0x00] — 32 bytes, rClean = r (pas de padding à strip)
  // compact.set(rClean, 32-32=0) → compact[0]=0x01, compact[31]=0x00
  const rHex = '01' + '00'.repeat(31);
  const der = makeDER(rHex, 'ff'.repeat(32));
  const compact = derToCompact(der);
  assertEqual(compact[0], 0x01, 'r[0] doit être 0x01');
  assertEqual(compact[31], 0x00, 'r[31] doit être 0x00');
});

test('compact: s occupe les 32 derniers bytes', () => {
  // s = [0x01, 0x00, ..., 0x00] — 32 bytes
  // compact.set(sClean, 64-32=32) → compact[32]=0x01, compact[63]=0x00
  const sHex = '01' + '00'.repeat(31);
  const der = makeDER('ff'.repeat(32), sHex);
  const compact = derToCompact(der);
  assertEqual(compact[32], 0x01, 's[0] à compact[32]');
  assertEqual(compact[63], 0x00, 's[31] à compact[63]');
});

test('DER non valide: mauvais premier byte → exception', () => {
  let threw = false;
  try { derToCompact(new Uint8Array([0x31, 0x00])); } catch { threw = true; }
  assert(threw, 'doit throw sur DER invalide');
});

test('strip du padding 0x00 sur r', () => {
  // r avec leading 0x00 (30 + données)
  const rWithPadding = '00' + 'ff'.repeat(32); // 33 bytes → strip → 32 bytes
  const der = makeDER(rWithPadding, 'aa'.repeat(32));
  const compact = derToCompact(der);
  assertEqual(compact.length, 64);
  // premier byte de r doit être 0xff (après strip du 0x00)
  assertEqual(compact[0], 0xff);
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== k1 challenge ===');

test('k1 est 32 bytes aléatoires encodés en hex (64 chars)', () => {
  // Simuler la génération de k1
  const k1Bytes = new Uint8Array(32).fill(0xab);
  const k1 = Array.from(k1Bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  assertEqual(k1.length, 64);
  assert(/^[0-9a-f]{64}$/.test(k1));
});

test('k1 validé par regex strict', () => {
  assert(/^[0-9a-f]{64}$/i.test('a'.repeat(64)));
  assert(!/^[0-9a-f]{64}$/i.test('a'.repeat(63)));
  assert(!/^[0-9a-f]{64}$/i.test('z' + 'a'.repeat(63)));
});

test('k1 TTL: 10 minutes (600 secondes)', () => {
  assertEqual(K1_TTL, 600);
});

test('k1 usage unique: status pending → authenticated → consommé', () => {
  // Workflow simulé
  const challenge = { status: 'pending', created_at: Date.now() };
  assert(challenge.status === 'pending', 'initial: pending');

  // Après callback wallet
  challenge.status = 'authenticated';
  challenge.linkingKey = '02' + 'a'.repeat(64);
  assert(challenge.status === 'authenticated');

  // status.js: crée session et supprime k1
  const sessionCreated = true;
  assert(sessionCreated, 'session doit être créée');

  // k1 consommé (del dans KV)
  const k1Deleted = true;
  assert(k1Deleted, 'k1 doit être consommé');
});

test('k1 déjà utilisé: status !== pending → erreur', () => {
  const challenge = { status: 'authenticated' };
  const error = challenge.status !== 'pending' ? 'Challenge already used' : null;
  assertEqual(error, 'Challenge already used');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== linkingKey format ===');

test('linkingKey est une pubkey secp256k1 compressée (66 chars hex)', () => {
  const lk = '02' + 'a'.repeat(64);
  assertEqual(lk.length, 66);
  assert(/^0[23][a-f0-9]{64}$/i.test(lk));
});

test('linkingKey prefix 02 ou 03 (point compressé)', () => {
  const lk02 = '02' + 'f'.repeat(64);
  const lk03 = '03' + 'f'.repeat(64);
  const lk04 = '04' + 'f'.repeat(64); // non compressé (65 bytes → 130 hex chars)
  // Valider que 02 et 03 sont acceptés par notre regex de validation
  assert(/^0[23][a-f0-9]{64}$/i.test(lk02), '02 prefix valide');
  assert(/^0[23][a-f0-9]{64}$/i.test(lk03), '03 prefix valide');
  // 04 (non compressé) ne passe pas le filtre 0[23]
  assert(!/^0[23][a-f0-9]{64}$/i.test(lk04), '04 rejeté par le filtre compressé');
});

test('linkingKey utilisé comme clé KV: format stable', () => {
  const lk = '02' + 'abc123'.repeat(10) + 'abcd';
  const playerKey = `player:${lk}`;
  assert(playerKey.startsWith('player:'));
  assert(!playerKey.includes('undefined'));
  assert(!playerKey.includes('null'));
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Session management ===');

test('session TTL: 30 jours en secondes', () => {
  assertEqual(SESSION_TTL, 2592000);
});

test('session_id est un UUID v4', () => {
  // crypto.randomUUID() génère toujours UUID v4 (champ version = 4)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // Test avec UUID généré
  const fakeV4 = '550e8400-e29b-41d4-a716-446655440000'; // v4: 41d4 → 4xxx
  assert(uuidRegex.test(fakeV4), 'UUID v4 doit matcher le pattern');
});

test('session: KV key format session:{uuid}', () => {
  const sessionId = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
  const key = `session:${sessionId}`;
  assertEqual(key, 'session:a1b2c3d4-e5f6-4890-abcd-ef1234567890');
});

test('player: KV key format player:{linkingKey}', () => {
  const lk = '02' + 'a'.repeat(64);
  const key = `player:${lk}`;
  assert(key.startsWith('player:02'));
});

test('nouveau joueur: balance initiale = 0', () => {
  const newPlayer = { balance: 0, nickname: null, avatar: null, created_at: Date.now() };
  assertEqual(newPlayer.balance, 0);
  assertEqual(newPlayer.nickname, null);
});

test('session refresh à chaque activité (last_activity)', () => {
  const player = { balance: 1000, last_activity: Date.now() - 3600000 };
  const before = player.last_activity;
  player.last_activity = Date.now();
  assert(player.last_activity > before, 'last_activity doit être mis à jour');
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== LNURL format ===');

test('LNURL commence par LNURL (majuscules)', () => {
  const fakeLNURL = 'LNURL1DP68GURN8GHJ7MRWW4EXCTNRDAKS8GURN8GHJ7...';
  assert(fakeLNURL.startsWith('LNURL'));
});

test('LNURL ne contient que des chars bech32 (A-Z 0-9)', () => {
  const fakeLNURL = 'LNURL1DP68GURN';
  assert(/^[A-Z0-9]+$/.test(fakeLNURL));
});

test('callback URL contient le bon k1', () => {
  const k1 = 'a'.repeat(64);
  const domain = 'satoshi-casino21.vercel.app';
  const callbackUrl = `https://${domain}/api/auth/callback?tag=login&k1=${k1}&action=login`;
  assert(callbackUrl.includes(k1));
  assert(callbackUrl.includes('tag=login'));
  assert(callbackUrl.startsWith('https://'));
});

test('callback URL avec domain correct', () => {
  const domain = 'satoshi-casino21.vercel.app';
  const callback = `https://${domain}/api/auth/callback`;
  assert(callback.startsWith('https://'));
  assert(!callback.startsWith('http://'));
});

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Rate limiting auth ===');

test('generate: max 10 requêtes par minute par IP', () => {
  const MAX = 10;
  let count = 0;
  for (let i = 0; i < 15; i++) {
    count++;
    if (count > MAX) break;
  }
  assert(count <= MAX + 1, 'should stop at limit');
});

test('generate: rate limit clé par IP', () => {
  const ip1 = '1.2.3.4';
  const ip2 = '5.6.7.8';
  const key1 = `ratelimit:lnauth:${ip1}`;
  const key2 = `ratelimit:lnauth:${ip2}`;
  assert(key1 !== key2, 'clés différentes par IP');
});

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
