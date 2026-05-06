import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const url = new URL(req.url);
  const tableId = url.searchParams.get('tableId');
  const period = url.searchParams.get('period') || '1d'; // 1d|7d|30d

  if (!tableId) return json(400, { error: 'tableId requis' });

  // Calculer les jours à agréger
  const today = new Date();
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 1;
  const dayKeys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dayKeys.push(`leaderboard:${tableId}:${d.toISOString().slice(0, 10)}`);
  }

  try {
    // Agréger les scores sur la période
    const aggregated = {};
    for (const key of dayKeys) {
      const raw = await kv.zrange(key, 0, 9, { rev: true, withScores: true });
      if (!Array.isArray(raw) || raw.length === 0) continue;

      if (typeof raw[0] === 'object' && 'score' in raw[0]) {
        for (const item of raw) {
          const member = item.value || item.member || '';
          const score = parseInt(item.score) || 0;
          if (score > 0) aggregated[member] = (aggregated[member] || 0) + score;
        }
      } else {
        for (let i = 0; i < raw.length; i += 2) {
          const member = String(raw[i] || '');
          const score = parseInt(raw[i + 1]) || 0;
          if (score > 0) aggregated[member] = (aggregated[member] || 0) + score;
        }
      }
    }

    const entries = Object.entries(aggregated)
      .map(([member, score]) => {
        const [name, avatar] = member.split('|');
        return { name: name || '???', avatar: avatar || '', score };
      })
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return json(200, { leaderboard: entries, period });
  } catch(e) {
    return json(200, { leaderboard: [], period });
  }
}
