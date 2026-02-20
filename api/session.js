import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  const sessionId = cookies.session_id;

  if (!sessionId) {
    return new Response(
      JSON.stringify({ error: 'Authentification requise', auth_required: true }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Resolve session -> linkingKey
  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) {
    return new Response(
      JSON.stringify({ error: 'Session expiree, reconnectez-vous', auth_required: true }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const playerKey = `player:${linkingKey}`;
  let player = await kv.get(playerKey);
  if (!player) {
    return new Response(
      JSON.stringify({ error: 'Joueur non trouve, reconnectez-vous', auth_required: true }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // POST: update nickname/avatar
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (body.nickname !== undefined) {
        const nick = (body.nickname || '').trim().slice(0, 16);
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
    } catch(e) {}
  }

  player.last_activity = Date.now();
  await kv.set(playerKey, player, { ex: 2592000 });
  // Refresh session TTL
  await kv.set(`session:${sessionId}`, linkingKey, { ex: 2592000 });

  return new Response(
    JSON.stringify({
      session_id: sessionId,
      balance: player.balance,
      nickname: player.nickname,
      avatar: player.avatar
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
