import { kv } from '@vercel/kv';
import { bech32 } from 'bech32';

export const config = { runtime: 'edge' };

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
  const rlCount = await kv.incr(rlKey);
  if (rlCount === 1) await kv.expire(rlKey, 60);
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

  // Encode as bech32 LNURL
  const urlBytes = new TextEncoder().encode(callbackUrl);
  const words = bech32.toWords(urlBytes);
  const lnurl = bech32.encode('lnurl', words, 1023).toUpperCase();

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
