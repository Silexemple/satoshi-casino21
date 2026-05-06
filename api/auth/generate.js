export const config = { runtime: 'edge' };

// ── KV via Upstash REST pipeline (format officiel) ──────────────────────────
async function kvCommand(...command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env vars manquantes');
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  
  if (!res.ok) {
    throw new Error(`KV ${command[0]} failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  
  const data = await res.json();
  return data.result;
}

// ── Bech32 inline ────────────────────────────────────────────────────────────
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(v) {
  let c = 1;
  for (const x of v) {
    const t = c >> 25;
    c = ((c & 0x1ffffff) << 5) ^ x;
    for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= GEN[i];
  }
  return c;
}
function expand(hrp) {
  const r = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}
function checksum(hrp, data) {
  const p = polymod(expand(hrp).concat(data, [0,0,0,0,0,0])) ^ 1;
  return Array.from({length:6}, (_,i) => (p >> (5*(5-i))) & 31);
}
function convert8to5(bytes) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of bytes) {
    acc = (acc << 8) | v; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5-bits)) & 31);
  return out;
}
function toLNURL(url) {
  const bytes = Array.from(new TextEncoder().encode(url));
  const words = convert8to5(bytes);
  const all = words.concat(checksum('lnurl', words));
  return ('lnurl1' + all.map(d => B32[d]).join('')).toUpperCase();
}

// ── Handler ──────────────────────────────────────────────────────────────────
const J = (s, d) => new Response(JSON.stringify(d), {
  status: s, headers: { 'Content-Type': 'application/json' }
});

export default async function handler(req) {
  try {
    if (req.method !== 'GET') return J(405, { error: 'Method not allowed' });

    // Rate limit (non-fatal)
    try {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'x';
      const rlKey = `ratelimit:lnauth:${ip}`;
      const count = await kvCommand('INCR', rlKey);
      if (count === 1) await kvCommand('EXPIRE', rlKey, 60);
      if (count > 10) return J(429, { error: 'Trop de requêtes. Réessayez dans 60s.' });
    } catch (rlErr) {
      console.log('[rate limit skip]', rlErr.message);
    }

    // Générer k1
    const k1 = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Construire LNURL
    const domain = new URL(req.url).hostname;
    const callback = `https://${domain}/api/auth/callback?tag=login&k1=${k1}&action=login`;
    const lnurl = toLNURL(callback);

    // Stocker le challenge (CRITIQUE pour l'auth)
    const challengeJson = JSON.stringify({
      status: 'pending',
      created_at: Date.now(),
      domain
    });
    await kvCommand('SET', `lnauth:k1:${k1}`, challengeJson, 'EX', 600);

    return J(200, { k1, lnurl });

  } catch (err) {
    console.error('[auth/generate]', err?.message, err?.stack);
    return J(500, {
      error: 'Erreur serveur: ' + (err?.message || 'inconnue'),
      hint: 'Vérifiez les variables KV_REST_API_URL et KV_REST_API_TOKEN sur Vercel'
    });
  }
}
