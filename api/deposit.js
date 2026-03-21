import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';
import { nwc } from '@getalby/sdk';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const rlKey = `ratelimit:deposit:${sessionId}`;
  const rlCount = await kv.incr(rlKey);
  if (rlCount === 1) await kv.expire(rlKey, 60);
  if (rlCount > 3) return json(429, { error: 'Trop de demandes de depot, attendez un instant' });

  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide' });

  const body = await req.json();
  const amount = parseInt(body.amount);
  const MAX_DEPOSIT = 100000;
  const MAX_BALANCE = 1000000;

  if (!amount || amount < 100 || amount > MAX_DEPOSIT) {
    return json(400, { error: `Montant invalide (100-${MAX_DEPOSIT} sats)` });
  }

  const player = await kv.get(`player:${linkingKey}`);
  if (!player) return json(404, { error: 'Joueur non trouve' });

  if (player.balance + amount > MAX_BALANCE) {
    return json(400, { error: `Balance max atteinte (${MAX_BALANCE} sats)` });
  }

  let client;
  try {
    client = new nwc.NWCClient({ nostrWalletConnectUrl: process.env.NWC_URL });

    const invoice = await client.makeInvoice({
      amount: amount * 1000,
      description: `Satoshi BJ - Depot ${amount} sats`,
      expiry: 3600
    });

    await kv.set(`invoice:${invoice.payment_hash}`, {
      session_id: sessionId,
      linking_key: linkingKey,
      amount: amount,
      payment_request: invoice.payment_request,
      created_at: Date.now()
    }, { ex: 7200 });

    return json(200, {
      payment_hash: invoice.payment_hash,
      payment_request: invoice.payment_request
    });

  } catch (error) {
    console.error('Erreur creation invoice:', error);
    return json(500, { error: `Erreur creation invoice: ${error.message}` });
  } finally {
    if (client) client.close();
  }
}
