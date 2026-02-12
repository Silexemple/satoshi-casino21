import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  const body = await req.json();
  const amount = parseInt(body.amount);

  const MAX_DEPOSIT = 100000;
  const MAX_BALANCE = 1000000;

  if (!amount || amount < 100 || amount > MAX_DEPOSIT) {
    return json(400, { error: `Montant invalide (100-${MAX_DEPOSIT} sats)` });
  }

  const player = await kv.get(`player:${sessionId}`);
  if (!player) {
    return json(404, { error: 'Joueur non trouvé' });
  }

  if (player.balance + amount > MAX_BALANCE) {
    return json(400, { error: `Balance max atteinte (${MAX_BALANCE} sats)` });
  }

  try {
    const response = await fetch(`${process.env.LNBITS_URL}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.LNBITS_INVOICE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        out: false,
        amount: amount,
        memo: `Satoshi BJ - Dépôt ${amount} sats`,
        expiry: 3600
      })
    });

    if (!response.ok) {
      throw new Error(`LNbits error: ${response.status}`);
    }

    const invoice = await response.json();

    await kv.set(`invoice:${invoice.payment_hash}`, {
      session_id: sessionId,
      amount: amount,
      payment_request: invoice.payment_request,
      created_at: Date.now()
    }, { ex: 7200 });

    return json(200, {
      payment_hash: invoice.payment_hash,
      payment_request: invoice.payment_request
    });

  } catch (error) {
    console.error('Erreur création invoice:', error);
    return json(500, { error: 'Erreur création invoice' });
  }
}
