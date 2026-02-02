import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  const sessionId = cookies.session_id;
  
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Session invalide' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const player = await kv.get(`player:${sessionId}`);
  
  if (!player) {
    return new Response(JSON.stringify({ error: 'Joueur non trouvé' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(
    JSON.stringify({ balance: player.balance }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
