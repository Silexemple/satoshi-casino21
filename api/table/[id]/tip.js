import { kv } from '@vercel/kv';
import { json, getSessionId } from '../../_helpers.js';

export const config = { runtime: 'edge' };

const MIN_TIP = 10;
const MAX_TIP = 1000;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const tableId = pathParts[pathParts.length - 2];

  const body = await req.json();
  const targetSeatIdx = parseInt(body.seatIdx);
  const amount = parseInt(body.amount);

  if (!amount || amount < MIN_TIP || amount > MAX_TIP) {
    return json(400, { error: `Pourboire invalide (${MIN_TIP}-${MAX_TIP} sats)` });
  }

  const lockKey = `lock:tip:${sessionId}`;
  const locked = await kv.set(lockKey, '1', { nx: true, ex: 5 });
  if (!locked) return json(429, { error: 'Action en cours' });

  try {
    const table = await kv.get(`table:${tableId}`);
    if (!table) return json(404, { error: 'Table non trouvee' });

    // Find sender seat
    const senderIdx = table.seats.findIndex(s => s && s.sessionId === sessionId);
    if (senderIdx < 0) return json(400, { error: 'Vous n\'etes pas a cette table' });

    // Validate target
    if (isNaN(targetSeatIdx) || targetSeatIdx < 0 || targetSeatIdx >= table.seats.length) {
      return json(400, { error: 'Siege invalide' });
    }
    if (targetSeatIdx === senderIdx) {
      return json(400, { error: 'Impossible de vous envoyer un pourboire' });
    }

    const targetSeat = table.seats[targetSeatIdx];
    if (!targetSeat) return json(400, { error: 'Siege vide' });

    // Resoudre les linkingKeys des deux joueurs
    const senderSeat = table.seats[senderIdx];
    const senderLk = senderSeat.linkingKey || await kv.get(`session:${sessionId}`);
    if (!senderLk) return json(401, { error: 'Session invalide', auth_required: true });

    const receiverLk = targetSeat.linkingKey || await kv.get(`session:${targetSeat.sessionId}`);
    if (!receiverLk) return json(400, { error: 'Destinataire non trouve' });

    // Check sender balance
    const senderKey = `player:${senderLk}`;
    const sender = await kv.get(senderKey);
    if (!sender || sender.balance < amount) {
      return json(400, { error: 'Solde insuffisant' });
    }

    // Check receiver exists
    const receiverKey = `player:${receiverLk}`;
    const receiver = await kv.get(receiverKey);
    if (!receiver) return json(400, { error: 'Destinataire non trouve' });

    // Transfert sequentiel avec rollback si le credit echoue. Promise.all sur
    // les 2 kv.set creait un risque de creation/destruction de sats: si le
    // debit du sender succede et le credit du receiver echoue (timeout reseau),
    // les sats etaient detruits. L'inverse creait des sats du neant.
    sender.balance -= amount;
    await kv.set(senderKey, sender, { ex: 2592000 });

    receiver.balance += amount;
    try {
      await kv.set(receiverKey, receiver, { ex: 2592000 });
    } catch (err) {
      // Credit failed: rollback sender debit (best-effort).
      console.error(`[TIP] credit failed for ${receiverLk}, rolling back ${amount} sats from ${senderLk}:`, err);
      try {
        const freshSender = await kv.get(senderKey);
        if (freshSender) {
          freshSender.balance = (freshSender.balance || 0) + amount;
          await kv.set(senderKey, freshSender, { ex: 2592000 });
        } else {
          sender.balance += amount;
          await kv.set(senderKey, sender, { ex: 2592000 });
        }
      } catch (rollbackErr) {
        console.error(`[TIP] CRITICAL: rollback FAILED for ${senderLk}, lost ${amount} sats:`, rollbackErr);
      }
      return json(500, { error: 'Transfert échoué, solde restauré. Réessayez.' });
    }

    // Log transactions (best-effort, non-bloquant: si rpush echoue, le tip
    // a deja ete effectue cote balance — on log et on continue)
    const senderTxKey = `transactions:${senderLk}`;
    const receiverTxKey = `transactions:${receiverLk}`;
    try {
      await Promise.all([
        kv.rpush(senderTxKey, {
          type: 'tip_sent',
          amount: -amount,
          timestamp: Date.now(),
          description: `Pourboire a ${targetSeat.playerName}`
        }),
        kv.rpush(receiverTxKey, {
          type: 'tip_received',
          amount: amount,
          timestamp: Date.now(),
          description: `Pourboire de ${table.seats[senderIdx].playerName}`
        })
      ]);
      await Promise.all([
        kv.expire(senderTxKey, 2592000),
        kv.expire(receiverTxKey, 2592000)
      ]);
    } catch (err) {
      console.error(`[TIP] tx log failed (non-blocking, transfer succeeded):`, err);
    }

    // Post a chat message about the tip (avec TTL — sans expire la cle pouvait
    // survivre indefiniment si elle etait creee par cet rpush sur cle vide)
    const chatKey = `chat:${tableId}`;
    try {
      await kv.rpush(chatKey, {
        seatIdx: senderIdx,
        playerName: table.seats[senderIdx].playerName,
        message: `a envoye ${amount} sats a ${targetSeat.playerName}!`,
        timestamp: Date.now(),
        isSystem: true
      });
      await kv.expire(chatKey, 3600);
    } catch (err) {
      console.error('[TIP] chat post failed (non-blocking):', err);
    }

    return json(200, {
      success: true,
      balance: sender.balance,
      amount,
      to: targetSeat.playerName
    });
  } finally {
    await kv.del(lockKey);
  }
}
