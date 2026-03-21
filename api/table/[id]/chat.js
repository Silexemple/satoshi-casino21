import { kv } from '@vercel/kv';
import { json, getSessionId } from '../../_helpers.js';

export const config = { runtime: 'edge' };

const MAX_MSG_LENGTH = 100;
const MAX_MESSAGES = 30;
const RATE_LIMIT_MS = 2000;

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const tableId = pathParts[pathParts.length - 2];

  const body = await req.json();
  const message = (body.message || '').trim().slice(0, MAX_MSG_LENGTH);

  if (!message) return json(400, { error: 'Message vide' });

  const table = await kv.get(`table:${tableId}`);
  if (!table) return json(404, { error: 'Table non trouvee' });

  const seatIdx = table.seats.findIndex(s => s && s.sessionId === sessionId);
  if (seatIdx < 0) return json(400, { error: "Vous n'etes pas a cette table" });

  // Rate limiting
  const rateLimitKey = `chat_rate:${sessionId}`;
  const lastMsg = await kv.get(rateLimitKey);
  if (lastMsg && Date.now() - lastMsg < RATE_LIMIT_MS) {
    return json(429, { error: 'Trop rapide' });
  }
  await kv.set(rateLimitKey, Date.now(), { ex: 10 });

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
