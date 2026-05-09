import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit } from '../../_helpers.js';

export const config = { runtime: 'edge' };

const MAX_MSG_LENGTH = 100;
const MAX_MESSAGES = 30;
const RATE_LIMIT_MS = 2000;

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'chat', 15, 60);
  if (rl) return rl;

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const tableId = pathParts[pathParts.length - 2];

  const body = await req.json();
  // Stocker le message en TEXTE BRUT. Le client est responsable de
  // l'echappement HTML au rendu (cf. addChatMessage / escapeHtml dans
  // public/table.html). Encoder ici cassait l'UX: un user tapant "<3"
  // voyait "&lt;3" affiche, parce que escapeHtml cote client re-encodait
  // le "&" du "&lt;" → "&amp;lt;3".
  // On filtre uniquement les caracteres de controle (newlines, NUL, etc.)
  // qui n'ont aucun usage en chat et peuvent casser le rendu.
  const rawMsg = (body.message || '');
  if (typeof rawMsg !== 'string') return json(400, { error: 'Message invalide' });
  // Strip control chars (sauf espace), trim, puis tronquer.
  const message = rawMsg.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, MAX_MSG_LENGTH);

  if (!message) return json(400, { error: 'Message vide' });

  const table = await kv.get(`table:${tableId}`);
  if (!table) return json(404, { error: 'Table non trouvee' });

  const seatIdx = table.seats.findIndex(s => s && s.sessionId === sessionId);
  if (seatIdx < 0) return json(400, { error: "Vous n'etes pas a cette table" });

  // Rate limiting: SET NX atomique. L'ancien GET-puis-SET creait une race
  // ou 2 requetes paralleles passaient toutes les deux le check (lastMsg
  // identique pour les deux), permettant de spammer N messages en parallele.
  // Le NX ne reussit qu'une seule fois par fenetre TTL, peu importe la
  // concurrence.
  const rateLimitKey = `chat_rate:${sessionId}`;
  const acquired = await kv.set(rateLimitKey, '1', {
    nx: true,
    ex: Math.ceil(RATE_LIMIT_MS / 1000)
  });
  if (!acquired) return json(429, { error: 'Trop rapide' });

  const chatKey = `chat:${tableId}`;
  const chatMsg = {
    seatIdx,
    playerName: table.seats[seatIdx].playerName || `Joueur ${seatIdx + 1}`,
    message,
    timestamp: Date.now()
  };

  await kv.rpush(chatKey, chatMsg);
  const chatLen = await kv.llen(chatKey);
  if (chatLen > MAX_MESSAGES) await kv.ltrim(chatKey, chatLen - MAX_MESSAGES, -1);
  await kv.expire(chatKey, 3600);

  return json(200, { success: true });
}
