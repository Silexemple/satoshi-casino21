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
  if (!sessionId) return json(401, { error: 'Session invalide' });

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

    // Check sender balance
    const senderKey = `player:${sessionId}`;
    const sender = await kv.get(senderKey);
    if (!sender || sender.balance < amount) {
      return json(400, { error: 'Solde insuffisant' });
    }

    // Check receiver exists
    const receiverKey = `player:${targetSeat.sessionId}`;
    const receiver = await kv.get(receiverKey);
    if (!receiver) return json(400, { error: 'Destinataire non trouve' });

    // Transfer
    sender.balance -= amount;
    receiver.balance += amount;

    await Promise.all([
      kv.set(senderKey, sender, { ex: 2592000 }),
      kv.set(receiverKey, receiver, { ex: 2592000 })
    ]);

    // Log transactions
    await Promise.all([
      kv.rpush(`transactions:${sessionId}`, {
        type: 'tip_sent',
        amount: -amount,
        timestamp: Date.now(),
        description: `Pourboire a ${targetSeat.playerName}`
      }),
      kv.rpush(`transactions:${targetSeat.sessionId}`, {
        type: 'tip_received',
        amount: amount,
        timestamp: Date.now(),
        description: `Pourboire de ${table.seats[senderIdx].playerName}`
      })
    ]);

    // Post a chat message about the tip
    const chatKey = `chat:${tableId}`;
    await kv.rpush(chatKey, {
      seatIdx: senderIdx,
      playerName: table.seats[senderIdx].playerName,
      message: `a envoye ${amount} sats a ${targetSeat.playerName}!`,
      timestamp: Date.now(),
      isSystem: true
    });

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
