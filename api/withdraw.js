import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = {
  runtime: 'edge',
};

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
  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  // Resolve session -> linkingKey
  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide' });

  const playerKey = `player:${linkingKey}`;
  const txKey = `transactions:${linkingKey}`;

  // Rate limiting - max 1 retrait par minute (per linkingKey = per identity)
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

  if (!invoice) {
    return json(400, { error: 'Invoice manquante' });
  }

  if (!invoice.startsWith('lnbc')) {
    return json(400, { error: 'Invoice invalide (doit commencer par lnbc)' });
  }

  if (invoice.length < 20 || invoice.length > 10000) {
    return json(400, { error: 'Invoice invalide (longueur incorrecte)' });
  }

  const amountSat = decodeInvoiceAmount(invoice);

  if (amountSat === null || amountSat <= 0) {
    return json(400, { error: 'Invoice sans montant ou montant invalide. Utilisez une invoice avec montant fixe.' });
  }

  const MAX_WITHDRAW = 1000000;
  if (amountSat > MAX_WITHDRAW) {
    return json(400, { error: `Montant maximum de retrait: ${MAX_WITHDRAW} sats` });
  }

  // Verrou joueur (par linkingKey = par identite)
  const lockKey = `lock:player:${linkingKey}`;
  const lock = await kv.set(lockKey, Date.now(), { nx: true, ex: 60 });

  if (!lock) {
    return json(423, { error: 'Une autre operation est en cours' });
  }

  let debited = false;
  const attemptId = `withdraw:${linkingKey}:${Date.now()}`;

  try {
    const player = await kv.get(playerKey);

    if (!player) {
      return json(404, { error: 'Joueur non trouve' });
    }

    const currentBalance = player.balance || 0;

    if (currentBalance <= 0) {
      return json(400, { error: 'Solde insuffisant' });
    }

    if (amountSat > currentBalance) {
      return json(400, { error: `Solde insuffisant. Disponible: ${currentBalance} sats, Demande: ${amountSat} sats` });
    }

    const lnbitsUrl = process.env.LNBITS_URL?.replace(/\/$/, '');
    const adminKey = process.env.LNBITS_ADMIN_KEY;

    if (!lnbitsUrl) {
      return json(500, { error: 'LNBITS_URL non configuree' });
    }

    if (!adminKey) {
      return json(500, { error: 'LNBITS_ADMIN_KEY non configuree' });
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(`${lnbitsUrl}/api/v1/payments`, {
        method: 'POST',
        headers: {
          'X-Api-Key': adminKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          out: true,
          bolt11: invoice
        }),
        signal: controller.signal
      });
    } catch (fetchError) {
      if (fetchError.name === 'AbortError') {
        await kv.set(`attempt:${attemptId}`, {
          invoice: invoice.substring(0, 50),
          amount: amountSat,
          status: 'timeout_pending',
          timestamp: Date.now()
        }, { ex: 604800 });

        try {
          const checkResp = await fetch(`${lnbitsUrl}/api/v1/payments?limit=5`, {
            headers: { 'X-Api-Key': adminKey }
          });
          if (checkResp.ok) {
            const payments = await checkResp.json();
            const found = Array.isArray(payments) && payments.find(p =>
              p.bolt11 === invoice && p.pending === false
            );
            if (!found) {
              await atomicRefund(playerKey, amountSat);
              debited = false;
              await kv.set(`attempt:${attemptId}`, {
                invoice: invoice.substring(0, 50),
                amount: amountSat,
                status: 'refunded_after_timeout',
                timestamp: Date.now()
              }, { ex: 3600 });
              return json(504, { error: 'Timeout LNbits - paiement non envoye. Solde rembourse.' });
            }
          }
        } catch(checkErr) {}

        return json(504, { error: 'Timeout LNbits - statut du paiement incertain. Contactez le support si le paiement n\'est pas recu. Ref: ' + attemptId });
      }

      await atomicRefund(playerKey, amountSat);
      debited = false;
      await kv.set(`attempt:${attemptId}`, {
        invoice: invoice.substring(0, 50),
        amount: amountSat,
        status: 'refunded',
        error: 'network',
        timestamp: Date.now()
      }, { ex: 3600 });
      return json(502, { error: 'Erreur reseau LNbits. Solde rembourse.' });
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText = await response.text();

    let payment;
    try {
      payment = JSON.parse(responseText);
    } catch (e) {
      await atomicRefund(playerKey, amountSat);
      debited = false;
      return json(502, { error: 'Reponse LNbits invalide. Solde rembourse.' });
    }

    if (!response.ok) {
      await atomicRefund(playerKey, amountSat);
      debited = false;

      await kv.set(`attempt:${attemptId}`, {
        invoice: invoice.substring(0, 50),
        amount: amountSat,
        status: 'failed',
        error: payment.detail || payment.message || 'unknown',
        timestamp: Date.now()
      }, { ex: 3600 });

      const errMsg = payment.detail || payment.message || `Erreur LNbits ${response.status}`;
      return json(400, { error: `Paiement refuse: ${errMsg}. Solde rembourse.` });
    }

    if (!payment.payment_hash) {
      await atomicRefund(playerKey, amountSat);
      debited = false;
      return json(502, { error: 'Reponse LNbits invalide (payment_hash manquant). Solde rembourse.' });
    }

    // === PAIEMENT REUSSI ===

    const freshPlayer = await kv.get(playerKey);
    if (freshPlayer) {
      freshPlayer.total_withdrawn = (freshPlayer.total_withdrawn || 0) + amountSat;
      freshPlayer.last_activity = Date.now();
      await kv.set(playerKey, freshPlayer, { ex: 2592000 });
    }

    await kv.set(processedKey, {
      payment_hash: payment.payment_hash,
      amount: amountSat,
      timestamp: Date.now()
    }, { ex: 604800 });

    await kv.set(rateLimitKey, Date.now(), { ex: 120 });

    await kv.rpush(txKey, {
      type: 'withdraw',
      amount: amountSat,
      timestamp: Date.now(),
      description: `Retrait Lightning ${payment.payment_hash.substring(0, 8)}...`,
      payment_hash: payment.payment_hash,
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
      payment_hash: payment.payment_hash,
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

    let errorMessage = 'Erreur lors du paiement';
    let statusCode = 500;

    if (error.message?.includes('insufficient balance')) {
      statusCode = 400;
      errorMessage = 'Solde LNbits insuffisant pour ce paiement';
    } else if (error.message?.includes('self-payment')) {
      statusCode = 400;
      errorMessage = 'Auto-paiement non autorise';
    }

    return json(statusCode, { error: errorMessage });

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
