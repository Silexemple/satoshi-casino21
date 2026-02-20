import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(req.url);
  const k1 = url.searchParams.get('k1');
  if (!k1 || !/^[0-9a-f]{64}$/i.test(k1)) {
    return new Response(JSON.stringify({ error: 'k1 invalide' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const challenge = await kv.get(`lnauth:k1:${k1}`);
  if (!challenge) {
    return new Response(JSON.stringify({ status: 'expired' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (challenge.status !== 'authenticated') {
    return new Response(JSON.stringify({ status: 'pending' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Authentication confirmed — create session
  const sessionId = crypto.randomUUID();
  const linkingKey = challenge.linkingKey;

  // session:{sessionId} -> linkingKey (30-day TTL)
  await kv.set(`session:${sessionId}`, linkingKey, { ex: 2592000 });

  // Consume k1 (one-time use)
  await kv.del(`lnauth:k1:${k1}`);

  // Get player data to return balance/nickname
  const player = await kv.get(`player:${linkingKey}`);

  return new Response(
    JSON.stringify({
      status: 'authenticated',
      balance: player ? player.balance : 0,
      nickname: player ? player.nickname : null,
      avatar: player ? player.avatar : null
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie.serialize('session_id', sessionId, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAge: 30 * 24 * 60 * 60,
          path: '/'
        })
      }
    }
  );
}
