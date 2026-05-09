import { kv } from '@vercel/kv';
import { json, getSessionId } from '../../_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

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
    // Interdire de quitter pendant la distribution des cartes
    if (table.status === 'dealing') {
      return json(400, { error: 'Impossible de quitter pendant la distribution' });
    }

    // Rembourser la mise si le joueur quitte pendant la phase de mises.
    // Ordre: ZERO seat.bet AVANT refund pour eviter un double-refund si on
    // crash entre le refund et le table.save (sur retry de leave, seat.bet
    // serait toujours > 0 dans le KV → refund deja fait + nouveau refund).
    // En zeroant d'abord, on perd au pire le refund (recoverable via log)
    // mais on ne paie jamais 2x.
    let refunded = 0;
    let refundIntent = 0;
    let refundLk = null;
    if (['betting', 'waiting'].includes(table.status) && seat.bet > 0) {
      refundIntent = seat.bet;
      refundLk = seat.linkingKey || await kv.get(`session:${sessionId}`);
      seat.bet = 0; // marqueur "refund traite" — sauvegarde dans le table.save plus bas
    }

    table.seats[seatIdx] = null;
    table.lastUpdate = Date.now();

    // Sauvegarder d'abord la liberation du siege (avec seat.bet=0 implicite via
    // seats[i]=null), puis crediter. Si le credit echoue apres la sauvegarde,
    // on log loud — mieux qu'un double-refund ou un siege bloque.
    await kv.set(tableKey, table, { ex: 604800 });

    if (refundIntent > 0) {
      if (!refundLk) {
        console.error(`[LEAVE] cannot refund ${refundIntent} sats: no linkingKey for ${sessionId} on ${tableId}`);
      } else {
        try {
          const playerKey = `player:${refundLk}`;
          const player = await kv.get(playerKey);
          if (player) {
            player.balance += refundIntent;
            player.last_activity = Date.now();
            await kv.set(playerKey, player, { ex: 2592000 });
            refunded = refundIntent;
          } else {
            console.error(`[LEAVE] player ${refundLk} not found, lost refund ${refundIntent} sats on ${tableId}`);
          }
        } catch (err) {
          console.error(`[LEAVE] refund FAILED for ${refundLk}, lost ${refundIntent} sats on ${tableId}:`, err);
        }
      }
    }

    return json(200, { success: true, refunded });
  } finally {
    await kv.del(lockKey);
  }
}
