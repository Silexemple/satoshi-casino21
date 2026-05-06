import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

// Bech32 encoding inline — évite la dépendance CJS bech32 incompatible avec Edge Runtime
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32CreateChecksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0,0,0,0,0,0]);
  const polymod = bech32Polymod(values) ^ 1;
  return Array.from({length: 6}, (_, i) => (polymod >> (5 * (5 - i))) & 31);
}

function bech32ConvertBits(data, fromBits, toBits, pad = true) {
  let acc = 0, bits = 0;
  const result = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) result.push((acc << (toBits - bits)) & maxv);
  return result;
}

function bech32Encode(hrp, data) {
  const combined = data.concat(bech32CreateChecksum(hrp, data));
  return hrp + '1' + combined.map(d => BECH32_ALPHABET[d]).join('');
}

function urlToBech32(url) {
  const encoded = new TextEncoder().encode(url);
  const words = bech32ConvertBits(Array.from(encoded), 8, 5);
  return bech32Encode('lnurl', words).toUpperCase();
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Rate limit by IP
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const rlKey = `ratelimit:lnauth:${ip}`;
  await kv.set(rlKey, 0, { nx: true, ex: 60 }); // atomique SET NX
  const rlCount = await kv.incr(rlKey);
  if (rlCount > 10) {
    return new Response(JSON.stringify({ error: 'Trop de requetes' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Generate 32 random bytes for k1 challenge
  const k1Bytes = crypto.getRandomValues(new Uint8Array(32));
  const k1 = Array.from(k1Bytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Build LNURL callback URL
  const url = new URL(req.url);
  const domain = url.hostname;
  const callbackUrl = `https://${domain}/api/auth/callback?tag=login&k1=${k1}&action=login`;

  // Encode as bech32 LNURL (implémentation native Edge-compatible)
  const lnurl = urlToBech32(callbackUrl);

  // Store k1 challenge with 10-minute TTL
  await kv.set(`lnauth:k1:${k1}`, {
    status: 'pending',
    created_at: Date.now(),
    domain
  }, { ex: 600 });

  return new Response(JSON.stringify({ k1, lnurl }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
