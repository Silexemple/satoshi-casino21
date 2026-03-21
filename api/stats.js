import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
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
    await kv.set(statsKey, body.stats, { ex: 2592000 }); // 30 days
    return json(200, { success: true });
  }

  return json(405, { error: 'Method not allowed' });
}
