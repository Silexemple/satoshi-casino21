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

// ── Handler ──────────────────────────────────────────────────────────────────
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

    const challenge = await KV.get(`lnauth:k1:${k1}`);

    if (!challenge) return J({ status: 'expired' });
    if (challenge.status !== 'authenticated') return J({ status: 'pending' });

    // Auth confirmée — créer session
    const sessionId = crypto.randomUUID();
    const linkingKey = challenge.linkingKey;

    await KV.set(`session:${sessionId}`, linkingKey, 2592000);
    await KV.del(`lnauth:k1:${k1}`);

    const player = await KV.get(`player:${linkingKey}`);

    // Cookie sans dépendance 'cookie' — format manuel RFC6265
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
