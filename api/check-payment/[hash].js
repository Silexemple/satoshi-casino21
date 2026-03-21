import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';
import { nwcRequest } from '../_nwc.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const paymentHash = pathParts[pathParts.length - 1];

  if (!paymentHash) return json(400, { error: 'Payment hash manquant' });

  const invoice = await kv.get(`invoice:${paymentHash}`);
  if (!invoice || invoice.session_id !== sessionId) {
    return json(404, { error: 'Invoice non trouvee' });
  }

  try {
    const lockKey = `lock:payment:${paymentHash}`;
    const lockAcquired = await kv.set(lockKey, '1', { nx: true, ex: 10 });
    if (!lockAcquired) return json(200, { paid: false, status: 'processing' });

    try {
      const freshInvoice = await kv.get(`invoice:${paymentHash}`);
      if (!freshInvoice) {
        await kv.del(lockKey);
        return json(200, { paid: true });
      }

      let isPaid = false;
      try {
        const status = await nwcRequest(process.env.NWC_URL, 'lookup_invoice', {
          payment_hash: paymentHash
        });
        isPaid = status.settled_at != null || status.state === 'settled';
      } catch (e) {
        // invoice not found or not paid yet
      }

      if (isPaid) {
        const linkingKey = freshInvoice.linking_key;
        if (!linkingKey) {
          await kv.del(lockKey);
          return json(500, { error: 'Impossible de crediter: cle de joueur introuvable' });
        }

        const playerKey = `player:${linkingKey}`;
        let player = await kv.get(playerKey) || {
          balance: 0, nickname: null,
          created_at: Date.now(), last_activity: Date.now()
        };

        const newBalance = player.balance + freshInvoice.amount;
        player.balance = newBalance;
        player.last_activity = Date.now();
        await kv.set(playerKey, player, { ex: 2592000 });

        const txKey = `transactions:${linkingKey}`;
        await kv.rpush(txKey, {
          type: 'deposit',
          amount: freshInvoice.amount,
          timestamp: Date.now(),
          description: `Depot Lightning ${paymentHash.substring(0, 8)}`
        });
        await kv.expire(txKey, 2592000);

        await kv.del(`invoice:${paymentHash}`);
        await kv.del(lockKey);
        return json(200, { paid: true, new_balance: newBalance });
      }

      await kv.del(lockKey);
      return json(200, { paid: false });

    } catch (innerError) {
      await kv.del(lockKey);
      throw innerError;
    }

  } catch (error) {
    console.error('Erreur verification invoice:', error);
    return json(500, { error: 'Erreur verification' });
  }
}
