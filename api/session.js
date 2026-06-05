import { kv } from '@vercel/kv';
import cookie from 'cookie';
import { rateLimit, withPlayerLock } from './_helpers.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'session', 30, 60);
  if (rl) return rl;

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

  // POST: valider les updates pseudo/avatar AVANT d'acquérir le verrou (pure).
  let pendingNickname; // undefined = pas de changement
  let pendingAvatar;
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch(e) {
      return new Response(JSON.stringify({ error: 'Body JSON invalide' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (body.nickname !== undefined) {
      const nick = (body.nickname || '').trim().slice(0, 16);
      const sanitized = nick.replace(/[^a-zA-Z0-9 _\-]/g, '').trim();
      if (sanitized.length < 2 || sanitized.length > 16) {
        // Avant: silent no-op si invalide, le frontend croyait avoir reussi
        // l'update et l'utilisateur ne comprenait pas pourquoi son pseudo ne
        // changeait pas.
        return new Response(JSON.stringify({
          error: 'Pseudo invalide (2-16 caracteres alphanumeriques, espaces, _ ou -)'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      pendingNickname = sanitized;
    }
    if (body.avatar !== undefined) {
      const validAvatars = ['💀','👑','♠️','💎','🔥','🚀','🎯','🐺','⚡','🦅','🎰','🃏'];
      if (!validAvatars.includes(body.avatar)) {
        return new Response(JSON.stringify({ error: 'Avatar invalide' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      pendingAvatar = body.avatar;
    }
  }

  // Verrou solde: on RELIT le joueur frais pour ne pas écraser un crédit/débit
  // concurrent (jeu, dépôt, tournoi…) en réécrivant le blob entier.
  const fresh = await withPlayerLock(linkingKey, async () => {
    const p = await kv.get(playerKey) || player;
    if (pendingNickname !== undefined) p.nickname = pendingNickname;
    if (pendingAvatar !== undefined) p.avatar = pendingAvatar;
    p.last_activity = Date.now();
    await kv.set(playerKey, p, { ex: 2592000 });
    return p;
  });

  // Refresh session TTL (hors verrou solde)
  await kv.set(`session:${sessionId}`, linkingKey, { ex: 2592000 });

  return new Response(
    JSON.stringify({
      session_id: sessionId,
      balance: fresh.balance,
      nickname: fresh.nickname,
      avatar: fresh.avatar
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
