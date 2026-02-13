import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  const player = await kv.get(`player:${sessionId}`);
  if (!player) {
    return json(404, { error: 'Joueur non trouvé' });
  }

  return json(200, { balance: player.balance });
}
