import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = { runtime: 'edge' };

// Classement des meilleurs gains du jour sur une table
export default async function handler(req) {
  if (req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const url = new URL(req.url);
  const tableId = url.searchParams.get('tableId');

  if (!tableId) return json(400, { error: 'tableId requis' });

  const today = new Date().toISOString().slice(0, 10);
  const lbKey = `leaderboard:${tableId}:${today}`;

  try {
    // zrange avec rev et withScores - format Upstash: [member, score, member, score...]
    // ou [{score, value}, ...] selon la version
    const raw = await kv.zrange(lbKey, 0, 4, { rev: true, withScores: true });

    const entries = [];
    if (Array.isArray(raw) && raw.length > 0) {
      // Detecter le format: objets ou array plat
      if (typeof raw[0] === 'object' && raw[0] !== null && 'score' in raw[0]) {
        // Format objet: [{score, value/member}, ...]
        for (const item of raw) {
          const score = parseInt(item.score) || 0;
          if (score <= 0) continue;
          const member = item.value || item.member || '';
          const [name, avatar] = member.split('|');
          entries.push({ name: name || '???', avatar: avatar || '', score });
        }
      } else {
        // Format array plat: [member, score, member, score, ...]
        for (let i = 0; i < raw.length; i += 2) {
          const member = String(raw[i] || '');
          const score = parseInt(raw[i + 1]) || 0;
          if (score <= 0) continue;
          const [name, avatar] = member.split('|');
          entries.push({ name: name || '???', avatar: avatar || '', score });
        }
      }
    }

    return json(200, { leaderboard: entries.slice(0, 5) });
  } catch(e) {
    return json(200, { leaderboard: [] });
  }
}
