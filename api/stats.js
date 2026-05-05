import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit } from './_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'stats', 30, 60);
  if (rl) return rl;

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide' });

  const statsKey = `stats:${linkingKey}`;

  if (req.method === 'GET') {
    const stats = await kv.get(statsKey);
    return json(200, { stats: stats || null });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    if (!body.stats) return json(400, { error: 'stats manquants' });
    // Limite taille payload (attaque de stockage KV)
    const statsStr = JSON.stringify(body.stats);
    if (statsStr.length > 8192) return json(400, { error: 'Payload stats trop grand (max 8Ko)' });
    await kv.set(statsKey, body.stats, { ex: 2592000 }); // 30 days
    return json(200, { success: true });
  }

  return json(405, { error: 'Method not allowed' });
}
