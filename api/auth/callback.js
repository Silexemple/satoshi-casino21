export const config = { runtime: 'edge' };

// ── KV REST helpers (zero external imports) ──────────────────────────────────
const KV = {
  async get(key) {
    const { url, token } = KV._env();
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const { result } = await res.json();
    if (result === null || result === undefined) return null;
    try { return JSON.parse(result); } catch { return result; }
  },
  async set(key, value, ttl) {
    const { url, token } = KV._env();
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const path = ttl
      ? `/set/${encodeURIComponent(key)}?EX=${ttl}`
      : `/set/${encodeURIComponent(key)}`;
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
  },
  async del(key) {
    const { url, token } = KV._env();
    await fetch(`${url}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
  },
  _env() {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) throw new Error('KV env vars manquantes');
    return { url, token };
  }
};

// ── secp256k1 signature verification (pure JS, zero imports) ─────────────────
// Courbe secp256k1
const P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a, m = P) { return ((a % m) + m) % m; }
function inv(n, m = P) {
  if (n === 0n) return 0n;
  let [a, b, x, y] = [mod(n, m), m, 1n, 0n];
  while (b > 0n) { const q = a / b; [a, b] = [b, a - q * b]; [x, y] = [y, x - q * y]; }
  return mod(x, m);
}

function pointAdd(P1, P2) {
  if (!P1) return P2; if (!P2) return P1;
  const [x1, y1, x2, y2] = [P1[0], P1[1], P2[0], P2[1]];
  if (x1 === x2) return y1 === y2 ? pointDouble(P1) : null;
  const l = mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}
function pointDouble(p) {
  const [x, y] = p;
  const l = mod(3n * x * x * inv(2n * y));
  const x3 = mod(l * l - 2n * x);
  return [x3, mod(l * (x - x3) - y)];
}
function pointMul(scalar, point = [Gx, Gy]) {
  let r = null, q = [point[0], point[1]];
  let k = mod(scalar, N);
  while (k > 0n) { if (k & 1n) r = pointAdd(r, q); q = pointDouble(q); k >>= 1n; }
  return r;
}

function parsePoint(bytes) {
  const prefix = bytes[0];
  const x = BigInt('0x' + Array.from(bytes.slice(1)).map(b => b.toString(16).padStart(2,'0')).join(''));
  if (prefix === 4) {
    const y = BigInt('0x' + Array.from(bytes.slice(33)).map(b => b.toString(16).padStart(2,'0')).join(''));
    return [x, y];
  }
  // Compressed point
  const ySq = mod(x * x * x + 7n);
  let y = modSqrt(ySq);
  if ((y % 2n) !== BigInt(prefix - 2)) y = P - y;
  return [x, y];
}
function modSqrt(n) {
  return modPow(n, (P + 1n) / 4n);
}
function modPow(base, exp, m = P) {
  let r = 1n; base = mod(base, m);
  while (exp > 0n) { if (exp & 1n) r = r * base % m; base = base * base % m; exp >>= 1n; }
  return r;
}

function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i/2] = parseInt(hex.slice(i,i+2), 16);
  return b;
}

function derToCompact(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('Bad DER');
  i++; // skip length
  if (der[i++] !== 0x02) throw new Error('Bad r marker');
  const rLen = der[i++]; const r = der.slice(i, i + rLen); i += rLen;
  if (der[i++] !== 0x02) throw new Error('Bad s marker');
  const sLen = der[i++]; const s = der.slice(i, i + sLen);
  const compact = new Uint8Array(64);
  const rClean = r[0] === 0 ? r.slice(1) : r;
  const sClean = s[0] === 0 ? s.slice(1) : s;
  compact.set(rClean, 32 - rClean.length);
  compact.set(sClean, 64 - sClean.length);
  return compact;
}

function verifySignature(sigCompact, msgBytes, pubBytes) {
  try {
    const r = BigInt('0x' + Array.from(sigCompact.slice(0, 32)).map(b => b.toString(16).padStart(2,'0')).join(''));
    const s = BigInt('0x' + Array.from(sigCompact.slice(32)).map(b => b.toString(16).padStart(2,'0')).join(''));
    if (r <= 0n || r >= N || s <= 0n || s >= N) return false;

    const z = BigInt('0x' + Array.from(msgBytes).map(b => b.toString(16).padStart(2,'0')).join(''));
    const Q = parsePoint(pubBytes);
    const sInv = inv(s, N);
    const u1 = mod(z * sInv, N);
    const u2 = mod(r * sInv, N);
    const pt = pointAdd(pointMul(u1), pointMul(u2, Q));
    if (!pt) return false;
    return mod(pt[0], N) === r;
  } catch { return false; }
}

// ── Handler ──────────────────────────────────────────────────────────────────
const J = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'Content-Type': 'application/json' }
});
const err = (reason) => J({ status: 'ERROR', reason });

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const k1  = url.searchParams.get('k1');
    const sig = url.searchParams.get('sig');
    const key = url.searchParams.get('key');
    const tag = url.searchParams.get('tag');

    if (tag !== 'login') return err('Invalid tag');
    if (!k1 || !/^[0-9a-f]{64}$/i.test(k1)) return err('Invalid k1');

    // Étape 1: wallet demande les infos du service (sans sig)
    if (!sig && !key) {
      const challenge = await KV.get(`lnauth:k1:${k1}`);
      if (!challenge) return err('Unknown or expired challenge');
      return J({ tag: 'login', callback: `https://${url.hostname}/api/auth/callback`, k1, action: 'login' });
    }

    // Étape 2: wallet soumet la signature
    if (!sig || !key) return err('Missing parameters');
    if (!/^[0-9a-f]+$/i.test(sig)) return err('Invalid signature format');
    if (!/^[0-9a-f]{66}$/i.test(key)) return err('Invalid public key format');

    const challenge = await KV.get(`lnauth:k1:${k1}`);
    if (!challenge) return err('Unknown or expired challenge');
    if (challenge.status !== 'pending') return err('Challenge already used');

    // Vérifier la signature secp256k1 (pur JS, zéro import)
    const k1Bytes   = hexToBytes(k1);
    const sigBytes  = hexToBytes(sig);
    const sigCompact = derToCompact(sigBytes);
    const pubBytes  = hexToBytes(key);
    const valid = verifySignature(sigCompact, k1Bytes, pubBytes);
    if (!valid) return err('Signature invalide');

    // Créer/mettre à jour le profil joueur
    const playerKey = `player:${key}`;
    const existing = await KV.get(playerKey);
    if (!existing) {
      await KV.set(playerKey, { balance: 0, nickname: null, avatar: null, created_at: Date.now(), last_activity: Date.now() }, 2592000);
    } else {
      existing.last_activity = Date.now();
      await KV.set(playerKey, existing, 2592000);
    }

    // Marquer k1 comme authentifié (usage unique)
    await KV.set(`lnauth:k1:${k1}`, { status: 'authenticated', linkingKey: key, authenticated_at: Date.now() }, 600);

    return J({ status: 'OK' });

  } catch (e) {
    console.error('[auth/callback]', e?.message);
    return J({ status: 'ERROR', reason: e?.message || 'Erreur interne' });
  }
}
