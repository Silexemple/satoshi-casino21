import { kv } from '@vercel/kv';
import { json, getSessionId } from '../../_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  // /api/table/{id}/join → id is pathParts[pathParts.length - 2]
  const tableId = pathParts[pathParts.length - 2];

  const body = await req.json();
  const seatIdx = parseInt(body.seatIdx);

  const lockKey = `lock:table:${tableId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!locked) return json(429, { error: 'Table occupée, réessayez' });

  try {
    const tableKey = `table:${tableId}`;
    const table = await kv.get(tableKey);
    if (!table) return json(404, { error: 'Table non trouvée' });

    // Vérifier si le joueur est déjà assis
    const alreadySeated = table.seats.findIndex(s => s && s.sessionId === sessionId);
    if (alreadySeated >= 0) {
      return json(400, { error: 'Vous êtes déjà assis', seatIdx: alreadySeated });
    }

    // Vérifier le siège
    if (isNaN(seatIdx) || seatIdx < 0 || seatIdx >= table.maxPlayers) {
      return json(400, { error: 'Siège invalide' });
    }
    if (table.seats[seatIdx] !== null) {
      return json(400, { error: 'Siège occupé' });
    }

    // Vérifier que le joueur existe
    const player = await kv.get(`player:${sessionId}`);
    if (!player) return json(404, { error: 'Joueur non trouvé' });

    // Asseoir le joueur (utiliser nickname si défini)
    table.seats[seatIdx] = {
      seatIdx,
      sessionId,
      playerName: player.nickname || `Joueur ${seatIdx + 1}`,
      bet: 0,
      hands: [],
      currentHandIdx: 0,
      finished: true
    };
    table.lastUpdate = Date.now();

    await kv.set(tableKey, table, { ex: 86400 });

    return json(200, { success: true, seatIdx });
  } finally {
    await kv.del(lockKey);
  }
}
