export const config = { runtime: 'edge' };

async function kvCommand(...command) {
  // Essayer plusieurs noms de variables (Vercel KV, Upstash Redis, custom)
  const url = process.env.KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_URL
    || process.env.REDIS_URL;
  const token = process.env.KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.KV_REST_API_READ_ONLY_TOKEN;
  if (!url || !token) {
    throw new Error('KV env vars manquantes (vérifié: KV_REST_API_URL, UPSTASH_REDIS_REST_URL, REDIS_URL)');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`KV ${command[0]} failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}
async function kvGet(key) {
  const r = await kvCommand('GET', key);
  if (r === null || r === undefined) return null;
  try { return JSON.parse(r); } catch { return r; }
}
async function kvSet(key, value, ttl) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (ttl) return await kvCommand('SET', key, v, 'EX', ttl);
  return await kvCommand('SET', key, v);
}
async function kvDel(key) { return await kvCommand('DEL', key); }

export default async function handler(req) {
  const J = (d, s = 200, headers = {}) => new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', ...headers }
  });

  try {
    if (req.method !== 'GET') return J({ error: 'Method not allowed' }, 405);

    const url = new URL(req.url);
    const k1 = url.searchParams.get('k1');
    if (!k1 || !/^[0-9a-f]{64}$/i.test(k1)) return J({ error: 'k1 invalide' }, 400);

    const challenge = await kvGet(`lnauth:k1:${k1}`);
    if (!challenge) return J({ status: 'expired' });
    if (challenge.status !== 'authenticated') return J({ status: 'pending' });

    const sessionId = crypto.randomUUID();
    const linkingKey = challenge.linkingKey;
    await kvSet(`session:${sessionId}`, linkingKey, 2592000);
    await kvDel(`lnauth:k1:${k1}`);
    const player = await kvGet(`player:${linkingKey}`);

    const maxAge = 30 * 24 * 60 * 60;
    const cookieStr = `session_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`;

    return J(
      {
        status: 'authenticated',
        balance: player?.balance ?? 0,
        nickname: player?.nickname ?? null,
        avatar: player?.avatar ?? null
      },
      200,
      { 'Set-Cookie': cookieStr }
    );

  } catch (e) {
    console.error('[auth/status]', e?.message);
    return J({ error: e?.message || 'Erreur interne' }, 500);
  }
}
