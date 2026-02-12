import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  const sessionId = cookies.session_id;

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Session invalide' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const paymentHash = pathParts[pathParts.length - 1];

  if (!paymentHash) {
    return new Response(JSON.stringify({ error: 'Payment hash manquant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Vérifier que l'invoice appartient à ce joueur
  const invoice = await kv.get(`invoice:${paymentHash}`);

  if (!invoice || invoice.session_id !== sessionId) {
    return new Response(JSON.stringify({ error: 'Invoice non trouvée' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Lock pour éviter le double crédit (polling concurrent)
    const lockKey = `lock:payment:${paymentHash}`;
    const lockAcquired = await kv.set(lockKey, '1', { nx: true, ex: 10 });
    if (!lockAcquired) {
      return new Response(JSON.stringify({ paid: false, status: 'processing' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      // Re-vérifier l'invoice après le lock (peut avoir été supprimée)
      const freshInvoice = await kv.get(`invoice:${paymentHash}`);
      if (!freshInvoice) {
        await kv.del(lockKey);
        return new Response(JSON.stringify({ paid: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Vérifier le statut sur LNbits
      const response = await fetch(
        `${process.env.LNBITS_URL}/api/v1/payments/${paymentHash}`,
        {
          headers: {
            'X-Api-Key': process.env.LNBITS_INVOICE_KEY
          }
        }
      );

      if (!response.ok) {
        await kv.del(lockKey);
        throw new Error(`LNbits error: ${response.status}`);
      }

      const status = await response.json();

      if (status.paid) {
        const player = await kv.get(`player:${sessionId}`);
        const newBalance = player.balance + freshInvoice.amount;

        player.balance = newBalance;
        player.last_activity = Date.now();
        await kv.set(`player:${sessionId}`, player);

        await kv.rpush(`transactions:${sessionId}`, {
          type: 'deposit',
          amount: freshInvoice.amount,
          timestamp: Date.now(),
          description: `Dépôt Lightning ${paymentHash.substring(0, 8)}`
        });

        // Supprimer l'invoice APRÈS avoir crédité
        await kv.del(`invoice:${paymentHash}`);
        await kv.del(lockKey);

        return new Response(
          JSON.stringify({ paid: true, new_balance: newBalance }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      await kv.del(lockKey);
    } catch (innerError) {
      await kv.del(lockKey);
      throw innerError;
    }

    return new Response(
      JSON.stringify({ paid: false }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('Erreur vérification invoice:', error);
    return new Response(JSON.stringify({ error: 'Erreur vérification' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
