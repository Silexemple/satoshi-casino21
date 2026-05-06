import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

// ── JSON helper ─────────────────────────────────────────────────────────────
const jsonResp = (status, data) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

// ── Bech32 inline — zéro dépendance externe, 100% Edge compatible ────────────
const B32_ABC = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const B32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function b32Polymod(v) {
  let c = 1;
  for (const x of v) {
    const t = c >> 25;
    c = ((c & 0x1ffffff) << 5) ^ x;
    for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= B32_GEN[i];
  }
  return c;
}
function b32Expand(hrp) {
  const r = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}
function b32Checksum(hrp, data) {
  const p = b32Polymod(b32Expand(hrp).concat(data, [0,0,0,0,0,0])) ^ 1;
  return Array.from({length:6}, (_,i) => (p >> (5*(5-i))) & 31);
}
function b32Convert(data) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << 8) | v; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5-bits)) & 31);
  return out;
}
function toLnurl(url) {
  const bytes = Array.from(new TextEncoder().encode(url));
  const words = b32Convert(bytes);
  const all = words.concat(b32Checksum('lnurl', words));
  return ('lnurl1' + all.map(d => B32_ABC[d]).join('')).toUpperCase();
}

// ── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req) {
  // Tout dans un try/catch global — jamais de 500 non-structuré
  try {
    if (req.method !== 'GET') return jsonResp(405, { error: 'Method not allowed' });

    // Rate limit IP — non-fatal si KV indisponible
    try {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || 'unknown';
      const rlKey = `ratelimit:lnauth:${ip}`;
      // SET NX avec string '0' (plus compatible que integer 0)
      await kv.set(rlKey, '0', { nx: true, ex: 60 });
      const rlCount = await kv.incr(rlKey);
      if (rlCount > 10) return jsonResp(429, { error: 'Trop de requêtes. Réessayez dans 60s.' });
    } catch (_) {
      // KV indisponible → on continue sans rate limit plutôt que de crasher
    }

    // Générer k1 (32 bytes aléatoires)
    const k1Bytes = crypto.getRandomValues(new Uint8Array(32));
    const k1 = Array.from(k1Bytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // Construire l'URL callback et l'encoder en LNURL bech32
    const url = new URL(req.url);
    const domain = url.hostname;
    const callbackUrl = `https://${domain}/api/auth/callback?tag=login&k1=${k1}&action=login`;
    const lnurl = toLnurl(callbackUrl);

    // Stocker le challenge k1 en KV (10 minutes)
    await kv.set(`lnauth:k1:${k1}`, {
      status: 'pending',
      created_at: Date.now(),
      domain
    }, { ex: 600 });

    return jsonResp(200, { k1, lnurl });

  } catch (err) {
    // Erreur inattendue → JSON structuré au lieu de la page 500 Vercel
    console.error('[auth/generate] Error:', err?.message || err);
    return jsonResp(500, { error: 'Erreur interne. Réessayez.', detail: err?.message });
  }
}
