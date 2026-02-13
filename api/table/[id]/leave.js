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
  const tableId = pathParts[pathParts.length - 2];

  const lockKey = `lock:table:${tableId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 10 });
  if (!locked) return json(429, { error: 'Table occupée, réessayez' });

  try {
    const tableKey = `table:${tableId}`;
    const table = await kv.get(tableKey);
    if (!table) return json(404, { error: 'Table non trouvée' });

    const seatIdx = table.seats.findIndex(s => s && s.sessionId === sessionId);
    if (seatIdx < 0) {
      return json(400, { error: 'Vous n\'êtes pas assis à cette table' });
    }

    const seat = table.seats[seatIdx];

    // Interdire de quitter en pleine partie si on a misé et pas fini
    if (table.status === 'playing' && seat.bet > 0 && !seat.finished) {
      return json(400, { error: 'Impossible de quitter pendant votre tour' });
    }

    // Rembourser la mise si le joueur quitte pendant la phase de mises
    let refunded = 0;
    if (['betting', 'waiting'].includes(table.status) && seat.bet > 0) {
      const playerKey = `player:${sessionId}`;
      const player = await kv.get(playerKey);
      if (player) {
        player.balance += seat.bet;
        await kv.set(playerKey, player, { ex: 2592000 });
        refunded = seat.bet;
      }
    }

    table.seats[seatIdx] = null;
    table.lastUpdate = Date.now();

    await kv.set(tableKey, table, { ex: 86400 });

    return json(200, { success: true, refunded });
  } finally {
    await kv.del(lockKey);
  }
}
