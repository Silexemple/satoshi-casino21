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
    sessionId = crypto.randomUUID();
    player = {
      balance: 0,
      nickname: null,
      created_at: Date.now(),
      last_activity: Date.now()
    };
    await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
  } else {
    player.last_activity = Date.now();
    // Ensure nickname field exists for older sessions
    if (!player.nickname) player.nickname = null;
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
          await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
        }
      }
    } catch(e) {
      // Ignore parse errors for backward compat with GET-like calls
    }
  }

  return new Response(
    JSON.stringify({
      session_id: sessionId,
      balance: player.balance,
      nickname: player.nickname
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
