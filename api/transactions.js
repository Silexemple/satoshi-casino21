import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  const player = await kv.get(`player:${sessionId}`);
  if (!player) {
    return json(404, { error: 'Joueur non trouvé' });
  }

  const txKey = `transactions:${sessionId}`;
  const len = await kv.llen(txKey);
  const start = Math.max(0, len - 50);
  const transactions = await kv.lrange(txKey, start, -1);

  return json(200, {
    transactions: transactions.reverse(),
    balance: player.balance
  });
}
