import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit, normalizePlayer } from './_helpers.js';
import { nwcRequest } from './_nwc.js';

// ── Politique de frais Lightning ──
// Réserve = max(FEE_RESERVE_PERCENT * montant, FEE_RESERVE_MIN_SAT)
// Couvre les fees de routage Lightning. La différence non-utilisée
// est remboursée au joueur après que le paiement réussisse.
const FEE_RESERVE_PERCENT = 0.01;   // 1%
const FEE_RESERVE_MIN_SAT = 10;     // plancher pour petits retraits
const MAX_WITHDRAW_SAT = 1000000;

function computeFeeReserve(amountSat) {
  return Math.max(FEE_RESERVE_MIN_SAT, Math.ceil(amountSat * FEE_RESERVE_PERCENT));
}

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
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'withdraw', 5, 60);
  if (rl) return rl;

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide', auth_required: true });

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

  if (amountSat > MAX_WITHDRAW_SAT) {
    return json(400, { error: `Montant maximum de retrait: ${MAX_WITHDRAW_SAT} sats` });
  }

  // ── Calcul de la réserve frais (joueur paie ses propres fees) ──
  const feeReserve = computeFeeReserve(amountSat);
  const totalDebit = amountSat + feeReserve;

  const lockKey = `lock:player:${linkingKey}`;
  const lock = await kv.set(lockKey, Date.now(), { nx: true, ex: 60 });
  if (!lock) return json(423, { error: 'Une autre operation est en cours' });

  let debited = false;
  let debitedAmount = 0; // montant réellement débité (utilisé pour refund en cas d'erreur)

  try {
    const player = normalizePlayer(await kv.get(playerKey));
    if (!player) return json(404, { error: 'Joueur non trouve' });

    const currentBalance = player.balance;
    if (currentBalance <= 0) return json(400, { error: 'Solde insuffisant' });
    if (totalDebit > currentBalance) {
      return json(400, {
        error: `Solde insuffisant. Disponible: ${currentBalance} sats. Requis: ${amountSat} sats + ${feeReserve} sats de réserve frais Lightning`,
        amount: amountSat,
        fee_reserve: feeReserve,
        total_required: totalDebit,
        balance: currentBalance
      });
    }

    const processedKey = `processed:${invoice}`;
    const alreadyProcessed = await kv.get(processedKey);
    if (alreadyProcessed) {
      return json(409, { error: 'Cette invoice a deja ete payee', payment_hash: alreadyProcessed.payment_hash });
    }

    // Débit avec réserve frais incluse
    player.balance = currentBalance - totalDebit;
    player.last_activity = Date.now();
    await kv.set(playerKey, player, { ex: 2592000 });
    debited = true;
    debitedAmount = totalDebit;

    // Paiement Lightning via NWC
    let payment;
    try {
      payment = await nwcRequest(process.env.NWC_URL, 'pay_invoice', { invoice });
    } catch (payError) {
      // Refund total (montant + réserve)
      await atomicRefund(playerKey, totalDebit);
      debited = false;
      return json(400, {
        error: `Paiement refusé: ${payError.message}. Solde rembourse (${totalDebit} sats).`,
        hint: 'Si "fees insuffisants" : augmenter le budget de fees dans la connexion NWC côté Alby Hub, ou demander un montant plus grand (la réserve scale avec le montant).'
      });
    }

    const paymentHash = payment.payment_hash || invoice.substring(4, 20);

    // ── Calculer fees réellement consommés et rembourser la différence ──
    // NIP-47 retourne fees_paid en MILLISATS. Convertir en sats (round up = sécuritaire pour le casino).
    const actualFeesMsat = Number(payment.fees_paid || 0);
    const actualFeesSat = Math.ceil(actualFeesMsat / 1000);

    // Si fees réels < réserve → on rembourse la différence au joueur
    // Si fees réels > réserve (cas rare, wallet a outrepassé le budget) → le casino absorbe l'écart
    const refundSat = Math.max(0, feeReserve - actualFeesSat);

    const freshPlayer = await kv.get(playerKey);
    if (freshPlayer) {
      if (refundSat > 0) {
        freshPlayer.balance = (freshPlayer.balance || 0) + refundSat;
      }
      freshPlayer.total_withdrawn = (freshPlayer.total_withdrawn || 0) + amountSat;
      freshPlayer.total_fees_paid = (freshPlayer.total_fees_paid || 0) + actualFeesSat;
      freshPlayer.last_activity = Date.now();
      await kv.set(playerKey, freshPlayer, { ex: 2592000 });
    }

    await kv.set(processedKey, { payment_hash: paymentHash, amount: amountSat, fees_sat: actualFeesSat, timestamp: Date.now() }, { ex: 604800 });
    await kv.set(rateLimitKey, Date.now(), { ex: 120 });

    await kv.rpush(txKey, {
      type: 'withdraw',
      amount: amountSat,
      fees_sat: actualFeesSat,
      fee_reserve: feeReserve,
      refunded: refundSat,
      timestamp: Date.now(),
      description: `Retrait Lightning ${paymentHash.substring(0, 8)}... (fees: ${actualFeesSat} sats)`,
      payment_hash: paymentHash,
      invoice: invoice.substring(0, 50),
      balance_before: currentBalance,
      balance_after: (finalPlayer ? finalPlayer.balance : (currentBalance - amountSat - actualFeesSat + refundSat))
    });
    await kv.expire(txKey, 2592000);

    const finalPlayer = await kv.get(playerKey);
    return json(200, {
      success: true,
      amount: amountSat,
      fees_sat: actualFeesSat,
      fee_reserve: feeReserve,
      refunded_sat: refundSat,
      new_balance: finalPlayer ? finalPlayer.balance : (currentBalance - amountSat - actualFeesSat),
      payment_hash: paymentHash,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Erreur retrait:', error);
    if (debited) {
      try { await atomicRefund(playerKey, debitedAmount); }
      catch (re) { console.error('CRITIQUE: refund echoue!', re); }
    }
    return json(500, { error: 'Erreur lors du paiement' });
  } finally {
    await kv.del(lockKey);
  }
}

async function atomicRefund(playerKey, amount) {
  const player = normalizePlayer(await kv.get(playerKey));
  if (player) {
    player.balance += amount;
    player.last_activity = Date.now();
    await kv.set(playerKey, player, { ex: 2592000 });
  }
}
