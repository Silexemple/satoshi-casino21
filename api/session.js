import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  let sessionId = cookies.session_id;
  
  // Récupérer ou créer la session (1 seul appel KV au lieu de 3)
  let player = sessionId ? await kv.get(`player:${sessionId}`) : null;

  if (!player) {
    sessionId = crypto.randomUUID();
    player = {
      balance: 0,
      created_at: Date.now(),
      last_activity: Date.now()
    };
    await kv.set(`player:${sessionId}`, player, { ex: 2592000 }); // 30 jours TTL
  } else {
    player.last_activity = Date.now();
    await kv.set(`player:${sessionId}`, player, { ex: 2592000 }); // renouveler TTL
  }
  
  return new Response(
    JSON.stringify({
      session_id: sessionId,
      balance: player.balance
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie.serialize('session_id', sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 30 * 24 * 60 * 60, // 30 jours
          path: '/'
        })
      }
    }
  );
}
