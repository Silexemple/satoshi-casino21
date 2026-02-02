import { kv } from '@vercel/kv';
import { nanoid } from 'nanoid';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  let sessionId = cookies.session_id;
  
  // Créer ou récupérer la session
  if (!sessionId || !(await kv.exists(`player:${sessionId}`))) {
    sessionId = nanoid(32);
    
    // Créer le joueur dans KV
    await kv.set(`player:${sessionId}`, {
      balance: 0,
      created_at: Date.now(),
      last_activity: Date.now()
    });
  } else {
    // Mettre à jour last_activity
    const player = await kv.get(`player:${sessionId}`);
    player.last_activity = Date.now();
    await kv.set(`player:${sessionId}`, player);
  }
  
  const player = await kv.get(`player:${sessionId}`);
  
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
