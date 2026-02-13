import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  let sessionId = cookies.session_id;

  let player = sessionId ? await kv.get(`player:${sessionId}`) : null;

  if (!player) {
    // Rate limit: max 5 nouvelles sessions par IP par minute
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const rlKey = `ratelimit:session:${ip}`;
    const rlCount = await kv.incr(rlKey);
    if (rlCount === 1) await kv.expire(rlKey, 60);
    if (rlCount > 5) {
      return new Response(JSON.stringify({ error: 'Trop de sessions creees, attendez' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    sessionId = crypto.randomUUID();
    player = {
      balance: 0,
      nickname: null,
      avatar: null,
      created_at: Date.now(),
      last_activity: Date.now()
    };
    await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
  } else {
    player.last_activity = Date.now();
    // Ensure nickname field exists for older sessions
    if (!player.nickname) player.nickname = null;
    if (!player.avatar) player.avatar = null;
    await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
  }

  // POST: update nickname
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (body.nickname !== undefined) {
        const nick = (body.nickname || '').trim().slice(0, 16);
        // Sanitize: only allow alphanumeric, spaces, underscores, dashes
        const sanitized = nick.replace(/[^a-zA-Z0-9 _\-]/g, '').trim();
        if (sanitized.length >= 2 && sanitized.length <= 16) {
          player.nickname = sanitized;
        }
      }
      if (body.avatar !== undefined) {
        const validAvatars = ['💀','👑','♠️','💎','🔥','🚀','🎯','🐺','⚡','🦅','🎰','🃏'];
        if (validAvatars.includes(body.avatar)) {
          player.avatar = body.avatar;
        }
      }
      await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
    } catch(e) {
      // Ignore parse errors for backward compat with GET-like calls
    }
  }

  return new Response(
    JSON.stringify({
      session_id: sessionId,
      balance: player.balance,
      nickname: player.nickname,
      avatar: player.avatar
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie.serialize('session_id', sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 30 * 24 * 60 * 60,
          path: '/'
        })
      }
    }
  );
}
