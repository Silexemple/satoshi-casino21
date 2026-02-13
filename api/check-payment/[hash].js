import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const paymentHash = pathParts[pathParts.length - 1];

  if (!paymentHash) {
    return json(400, { error: 'Payment hash manquant' });
  }

  const invoice = await kv.get(`invoice:${paymentHash}`);
  if (!invoice || invoice.session_id !== sessionId) {
    return json(404, { error: 'Invoice non trouvée' });
  }

  try {
    // Lock pour éviter le double crédit (polling concurrent)
    const lockKey = `lock:payment:${paymentHash}`;
    const lockAcquired = await kv.set(lockKey, '1', { nx: true, ex: 10 });
    if (!lockAcquired) {
      return json(200, { paid: false, status: 'processing' });
    }

    try {
      const freshInvoice = await kv.get(`invoice:${paymentHash}`);
      if (!freshInvoice) {
        await kv.del(lockKey);
        return json(200, { paid: true });
      }

      const response = await fetch(
        `${process.env.LNBITS_URL}/api/v1/payments/${paymentHash}`,
        { headers: { 'X-Api-Key': process.env.LNBITS_INVOICE_KEY } }
      );

      if (!response.ok) {
        await kv.del(lockKey);
        throw new Error(`LNbits error: ${response.status}`);
      }

      const status = await response.json();

      if (status.paid) {
        let player = await kv.get(`player:${sessionId}`);

        // Si le player a expire, recreer un profil minimal pour ne pas perdre le depot
        if (!player) {
          player = {
            balance: 0,
            nickname: null,
            created_at: Date.now(),
            last_activity: Date.now()
          };
        }

        const newBalance = player.balance + freshInvoice.amount;
        player.balance = newBalance;
        player.last_activity = Date.now();
        await kv.set(`player:${sessionId}`, player, { ex: 2592000 });

        const txKey = `transactions:${sessionId}`;
        await kv.rpush(txKey, {
          type: 'deposit',
          amount: freshInvoice.amount,
          timestamp: Date.now(),
          description: `Dépôt Lightning ${paymentHash.substring(0, 8)}`
        });
        await kv.expire(txKey, 2592000);

        await kv.del(`invoice:${paymentHash}`);
        await kv.del(lockKey);

        return json(200, { paid: true, new_balance: newBalance });
      }

      await kv.del(lockKey);
    } catch (innerError) {
      await kv.del(lockKey);
      throw innerError;
    }

    return json(200, { paid: false });

  } catch (error) {
    console.error('Erreur vérification invoice:', error);
    return json(500, { error: 'Erreur vérification' });
  }
}
