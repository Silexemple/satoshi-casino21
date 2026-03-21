import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';


// Decoder le montant d'une invoice BOLT11 (en satoshis)
function decodeInvoiceAmount(invoice) {
  try {
    const lower = invoice.toLowerCase();
    const match = lower.match(/^lnbc(\d+)([munp])?1/);
    if (!match) return null;

    const [, amountStr, unit] = match;
    const amount = BigInt(amountStr);

    if (amount <= 0n) return null;

    const multipliers = {
      'm': BigInt(100000000),
      'u': BigInt(100000),
      'n': BigInt(100),
      'p': BigInt(1)
    };

    let amountMsat;
    if (unit) {
      amountMsat = amount * multipliers[unit];
    } else {
      amountMsat = amount * BigInt(100000000000);
    }

    return Number(amountMsat / BigInt(1000));
  } catch (e) {
    return null;
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide' });

  const playerKey = `player:${linkingKey}`;
  const txKey = `transactions:${linkingKey}`;

  // Rate limiting - max 1 retrait par minute
  const rateLimitKey = `ratelimit:withdraw:${linkingKey}`;
  const lastWithdraw = await kv.get(rateLimitKey);
  if (lastWithdraw && (Date.now() - lastWithdraw) < 60000) {
    const waitSeconds = Math.ceil((60000 - (Date.now() - lastWithdraw)) / 1000);
    return json(429, { error: `Veuillez attendre ${waitSeconds}s entre les retraits` });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { error: 'Body JSON invalide' });
  }

  const invoice = body.invoice?.trim()?.toLowerCase();

  if (!invoice) return json(400, { error: 'Invoice manquante' });
  if (!invoice.startsWith('lnbc')) return json(400, { error: 'Invoice invalide (doit commencer par lnbc)' });
  if (invoice.length < 20 || invoice.length > 10000) return json(400, { error: 'Invoice invalide (longueur incorrecte)' });

  const amountSat = decodeInvoiceAmount(invoice);
  if (amountSat === null || amountSat <= 0) {
    return json(400, { error: 'Invoice sans montant ou montant invalide. Utilisez une invoice avec montant fixe.' });
  }

  const MAX_WITHDRAW = 1000000;
  if (amountSat > MAX_WITHDRAW) {
    return json(400, { error: `Montant maximum de retrait: ${MAX_WITHDRAW} sats` });
  }

  if (!process.env.NWC_URL) {
    return json(500, { error: 'NWC_URL non configuree' });
  }

  // Verrou joueur
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
      return json(400, { error: `Solde insuffisant. Disponible: ${currentBalance} sats, Demande: ${amountSat} sats` });
    }

    // Idempotence - eviter les doubles paiements
    const processedKey = `processed:${invoice}`;
    const alreadyProcessed = await kv.get(processedKey);
    if (alreadyProcessed) {
      return json(409, { error: 'Cette invoice a deja ete payee', payment_hash: alreadyProcessed.payment_hash });
    }

    // Debiter le joueur
    player.balance = currentBalance - amountSat;
    player.last_activity = Date.now();
    await kv.set(playerKey, player, { ex: 2592000 });
    debited = true;

    await kv.set(`attempt:${attemptId}`, {
      invoice: invoice.substring(0, 50),
      amount: amountSat,
      status: 'pending',
      timestamp: Date.now()
    }, { ex: 3600 });

    // Paiement via NWC
    let nwcClient;
    let payment;
    try {
      const { nwc } = await import('@getalby/sdk');
      nwcClient = new nwc.NWCClient({ nostrWalletConnectUrl: process.env.NWC_URL });
      payment = await nwcClient.payInvoice({ invoice });
    } catch (payError) {
      await atomicRefund(playerKey, amountSat);
      debited = false;
      await kv.set(`attempt:${attemptId}`, {
        invoice: invoice.substring(0, 50),
        amount: amountSat,
        status: 'failed',
        error: payError.message,
        timestamp: Date.now()
      }, { ex: 3600 });
      return json(400, { error: `Paiement refuse: ${payError.message}. Solde rembourse.` });
    } finally {
      if (nwcClient) nwcClient.close();
    }

    // === PAIEMENT REUSSI ===
    const paymentHash = payment.payment_hash || invoice.substring(4, 20);

    const freshPlayer = await kv.get(playerKey);
    if (freshPlayer) {
      freshPlayer.total_withdrawn = (freshPlayer.total_withdrawn || 0) + amountSat;
      freshPlayer.last_activity = Date.now();
      await kv.set(playerKey, freshPlayer, { ex: 2592000 });
    }

    await kv.set(processedKey, {
      payment_hash: paymentHash,
      amount: amountSat,
      timestamp: Date.now()
    }, { ex: 604800 });

    await kv.set(rateLimitKey, Date.now(), { ex: 120 });

    await kv.rpush(txKey, {
      type: 'withdraw',
      amount: amountSat,
      timestamp: Date.now(),
      description: `Retrait Lightning ${paymentHash.substring(0, 8)}...`,
      payment_hash: paymentHash,
      invoice: invoice.substring(0, 50),
      balance_before: currentBalance,
      balance_after: currentBalance - amountSat
    });
    await kv.expire(txKey, 2592000);
    await kv.del(`attempt:${attemptId}`);

    const finalPlayer = await kv.get(playerKey);
    const finalBalance = finalPlayer ? finalPlayer.balance : (currentBalance - amountSat);

    return json(200, {
      success: true,
      amount: amountSat,
      new_balance: finalBalance,
      payment_hash: paymentHash,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Erreur retrait:', error);

    if (debited) {
      try {
        await atomicRefund(playerKey, amountSat);
      } catch (refundError) {
        console.error('CRITIQUE: refund echoue!', refundError, { linkingKey, amountSat, attemptId });
        await kv.set(`refund_failed:${attemptId}`, {
          linkingKey, amount: amountSat, timestamp: Date.now(), error: refundError.message
        }, { ex: 604800 });
      }
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
