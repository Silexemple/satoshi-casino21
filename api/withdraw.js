import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';
import { nwcRequest } from './_nwc.js';

export const config = { runtime: 'edge' };

function decodeInvoiceAmount(invoice) {
  try {
    const lower = invoice.toLowerCase();
    const match = lower.match(/^lnbc(\d+)([munp])?1/);
    if (!match) return null;
    const [, amountStr, unit] = match;
    const amount = BigInt(amountStr);
    if (amount <= 0n) return null;
    const multipliers = { 'm': BigInt(100000000), 'u': BigInt(100000), 'n': BigInt(100), 'p': BigInt(1) };
    const amountMsat = unit ? amount * multipliers[unit] : amount * BigInt(100000000000);
    return Number(amountMsat / BigInt(1000));
  } catch (e) { return null; }
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide' });

  const playerKey = `player:${linkingKey}`;
  const txKey = `transactions:${linkingKey}`;

  const rateLimitKey = `ratelimit:withdraw:${linkingKey}`;
  const lastWithdraw = await kv.get(rateLimitKey);
  if (lastWithdraw && (Date.now() - lastWithdraw) < 60000) {
    const waitSeconds = Math.ceil((60000 - (Date.now() - lastWithdraw)) / 1000);
    return json(429, { error: `Veuillez attendre ${waitSeconds}s entre les retraits` });
  }

  let body;
  try { body = await req.json(); } catch (e) { return json(400, { error: 'Body JSON invalide' }); }

  const invoice = body.invoice?.trim()?.toLowerCase();
  if (!invoice) return json(400, { error: 'Invoice manquante' });
  if (!invoice.startsWith('lnbc')) return json(400, { error: 'Invoice invalide (doit commencer par lnbc)' });
  if (invoice.length < 20 || invoice.length > 10000) return json(400, { error: 'Invoice invalide (longueur incorrecte)' });

  const amountSat = decodeInvoiceAmount(invoice);
  if (amountSat === null || amountSat <= 0) {
    return json(400, { error: 'Invoice sans montant ou montant invalide.' });
  }

  if (amountSat > 1000000) return json(400, { error: 'Montant maximum de retrait: 1000000 sats' });

  const lockKey = `lock:player:${linkingKey}`;
  const lock = await kv.set(lockKey, Date.now(), { nx: true, ex: 60 });
  if (!lock) return json(423, { error: 'Une autre operation est en cours' });

  let debited = false;
  const attemptId = `withdraw:${linkingKey}:${Date.now()}`;

  try {
    const player = await kv.get(playerKey);
    if (!player) return json(404, { error: 'Joueur non trouve' });

    const currentBalance = player.balance || 0;
    if (currentBalance <= 0) return json(400, { error: 'Solde insuffisant' });
    if (amountSat > currentBalance) {
      return json(400, { error: `Solde insuffisant. Disponible: ${currentBalance} sats` });
    }

    const processedKey = `processed:${invoice}`;
    const alreadyProcessed = await kv.get(processedKey);
    if (alreadyProcessed) {
      return json(409, { error: 'Cette invoice a deja ete payee', payment_hash: alreadyProcessed.payment_hash });
    }

    player.balance = currentBalance - amountSat;
    player.last_activity = Date.now();
    await kv.set(playerKey, player, { ex: 2592000 });
    debited = true;

    let payment;
    try {
      payment = await nwcRequest(process.env.NWC_URL, 'pay_invoice', { invoice });
    } catch (payError) {
      await atomicRefund(playerKey, amountSat);
      debited = false;
      return json(400, { error: `Paiement refuse: ${payError.message}. Solde rembourse.` });
    }

    const paymentHash = payment.payment_hash || invoice.substring(4, 20);

    const freshPlayer = await kv.get(playerKey);
    if (freshPlayer) {
      freshPlayer.total_withdrawn = (freshPlayer.total_withdrawn || 0) + amountSat;
      freshPlayer.last_activity = Date.now();
      await kv.set(playerKey, freshPlayer, { ex: 2592000 });
    }

    await kv.set(processedKey, { payment_hash: paymentHash, amount: amountSat, timestamp: Date.now() }, { ex: 604800 });
    await kv.set(rateLimitKey, Date.now(), { ex: 120 });

    await kv.rpush(txKey, {
      type: 'withdraw', amount: amountSat, timestamp: Date.now(),
      description: `Retrait Lightning ${paymentHash.substring(0, 8)}...`,
      payment_hash: paymentHash, invoice: invoice.substring(0, 50),
      balance_before: currentBalance, balance_after: currentBalance - amountSat
    });
    await kv.expire(txKey, 2592000);

    const finalPlayer = await kv.get(playerKey);
    return json(200, {
      success: true, amount: amountSat,
      new_balance: finalPlayer ? finalPlayer.balance : (currentBalance - amountSat),
      payment_hash: paymentHash, timestamp: Date.now()
    });

  } catch (error) {
    console.error('Erreur retrait:', error);
    if (debited) {
      try { await atomicRefund(playerKey, amountSat); }
      catch (re) { console.error('CRITIQUE: refund echoue!', re); }
    }
    return json(500, { error: 'Erreur lors du paiement' });
  } finally {
    await kv.del(lockKey);
  }
}

async function atomicRefund(playerKey, amount) {
  const player = await kv.get(playerKey);
  if (player) {
    player.balance = (player.balance || 0) + amount;
    player.last_activity = Date.now();
    await kv.set(playerKey, player, { ex: 2592000 });
  }
}
