import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = {
  runtime: 'edge',
};

// Decoder le montant d'une invoice BOLT11 (en satoshis)
// Format BOLT11: lnbc[montant][unite]1[donnees bech32][checksum]
// Le "1" separateur est celui juste apres le montant+unite
function decodeInvoiceAmount(invoice) {
  try {
    const lower = invoice.toLowerCase();

    // Regex: lnbc + chiffres + unite optionnelle + separateur "1"
    const match = lower.match(/^lnbc(\d+)([munp])?1/);
    if (!match) return null;

    const [, amountStr, unit] = match;
    const amount = BigInt(amountStr);

    if (amount <= 0n) return null;

    // Conversion en millisatoshis puis en satoshis
    // 1 BTC = 100_000_000 sat = 100_000_000_000 msat
    const multipliers = {
      'm': BigInt(100000000),   // milliBTC -> msat (1 mBTC = 100_000 sat)
      'u': BigInt(100000),      // microBTC -> msat (1 uBTC = 100 sat)
      'n': BigInt(100),         // nanoBTC -> msat
      'p': BigInt(1)            // picoBTC -> msat
    };

    let amountMsat;
    if (unit) {
      amountMsat = amount * multipliers[unit];
    } else {
      // Pas d'unite = BTC entier
      amountMsat = amount * BigInt(100000000000);
    }

    return Number(amountMsat / BigInt(1000)); // msat -> sat
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

  // Rate limiting - max 1 retrait par minute
  const rateLimitKey = `ratelimit:withdraw:${sessionId}`;
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

  // Normaliser l'invoice en minuscules (QR codes et wallets envoient souvent en majuscules)
  const invoice = body.invoice?.trim()?.toLowerCase();

  // Validation de l'invoice
  if (!invoice) {
    return json(400, { error: 'Invoice manquante' });
  }

  if (!invoice.startsWith('lnbc')) {
    return json(400, { error: 'Invoice invalide (doit commencer par lnbc)' });
  }

  if (invoice.length < 20 || invoice.length > 10000) {
    return json(400, { error: 'Invoice invalide (longueur incorrecte)' });
  }

  // Decoder et verifier le montant
  const amountSat = decodeInvoiceAmount(invoice);

  if (amountSat === null || amountSat <= 0) {
    return json(400, { error: 'Invoice sans montant ou montant invalide. Utilisez une invoice avec montant fixe.' });
  }

  // Limite de retrait
  const MAX_WITHDRAW = 1000000; // 1M sats max par retrait
  if (amountSat > MAX_WITHDRAW) {
    return json(400, { error: `Montant maximum de retrait: ${MAX_WITHDRAW} sats` });
  }

  // Verrou joueur pour eviter les race conditions
  // TTL 60s > timeout LNbits 30s pour eviter expiration pendant le call
  const lockKey = `lock:player:${sessionId}`;
  const lock = await kv.set(lockKey, Date.now(), { nx: true, ex: 60 });

  if (!lock) {
    return json(423, { error: 'Une autre operation est en cours' });
  }

  // Variable pour tracker si le debit a ete fait (pour savoir si on doit refund)
  let debited = false;
  const playerKey = `player:${sessionId}`;
  const attemptId = `withdraw:${sessionId}:${Date.now()}`;

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

    // Verifier les variables d'environnement
    const lnbitsUrl = process.env.LNBITS_URL?.replace(/\/$/, '');
    const adminKey = process.env.LNBITS_ADMIN_KEY;

    if (!lnbitsUrl) {
      return json(500, { error: 'LNBITS_URL non configuree' });
    }

    if (!adminKey) {
      return json(500, { error: 'LNBITS_ADMIN_KEY non configuree' });
    }

    // Verifier l'idempotence - eviter les doubles paiements
    const processedKey = `processed:${invoice}`;
    const alreadyProcessed = await kv.get(processedKey);

    if (alreadyProcessed) {
      return json(409, { error: 'Cette invoice a deja ete payee', payment_hash: alreadyProcessed.payment_hash });
    }

    // DEBIT: on debite via l'objet player sous verrou
    // En cas d'echec, le refund re-lira le player frais (atomicRefund)
    player.balance = currentBalance - amountSat;
    player.last_activity = Date.now();
    await kv.set(playerKey, player, { ex: 2592000 });
    debited = true;

    // Logger la tentative (pour audit)
    await kv.set(`attempt:${attemptId}`, {
      invoice: invoice.substring(0, 50),
      amount: amountSat,
      status: 'pending',
      timestamp: Date.now()
    }, { ex: 3600 });

    // Appel LNbits avec timeout
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
        // TIMEOUT: LNbits n'a pas repondu a temps
        // Le paiement a PEUT-ETRE ete envoye - on ne peut pas rembourser aveuglément
        // Marquer comme "pending_verification" pour verification manuelle
        await kv.set(`attempt:${attemptId}`, {
          invoice: invoice.substring(0, 50),
          amount: amountSat,
          status: 'timeout_pending',
          timestamp: Date.now()
        }, { ex: 604800 }); // garder 7 jours

        // Essayer de verifier le statut du paiement via LNbits
        try {
          // Chercher le paiement par l'invoice dans les paiements recents
          const checkResp = await fetch(`${lnbitsUrl}/api/v1/payments?limit=5`, {
            headers: { 'X-Api-Key': adminKey }
          });
          if (checkResp.ok) {
            const payments = await checkResp.json();
            const found = Array.isArray(payments) && payments.find(p =>
              p.bolt11 === invoice && p.pending === false
            );
            if (!found) {
              // Paiement non trouve = probablement pas parti, on peut rembourser
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
        } catch(checkErr) {
          // Impossible de verifier - on ne rembourse PAS pour eviter la double depense
        }

        // Pas pu confirmer que le paiement n'est pas parti -> on garde le debit
        // Le joueur doit contacter le support
        return json(504, { error: 'Timeout LNbits - statut du paiement incertain. Contactez le support si le paiement n\'est pas recu. Ref: ' + attemptId });
      }

      // Erreur reseau (pas timeout) - on peut rembourser
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

    // Lire la reponse
    const responseText = await response.text();

    let payment;
    try {
      payment = JSON.parse(responseText);
    } catch (e) {
      // REFUND ATOMIQUE: reponse illisible = paiement echoue
      await atomicRefund(playerKey, amountSat);
      debited = false;
      return json(502, { error: 'Reponse LNbits invalide. Solde rembourse.' });
    }

    // Verifier le succes du paiement
    if (!response.ok) {
      // REFUND ATOMIQUE: paiement refuse par LNbits
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
      // REFUND ATOMIQUE: reponse sans payment_hash
      await atomicRefund(playerKey, amountSat);
      debited = false;
      return json(502, { error: 'Reponse LNbits invalide (payment_hash manquant). Solde rembourse.' });
    }

    // === PAIEMENT REUSSI ===

    // FIX BUG 2: sauvegarder total_withdrawn (re-lire player frais pour ne pas ecraser)
    const freshPlayer = await kv.get(playerKey);
    if (freshPlayer) {
      freshPlayer.total_withdrawn = (freshPlayer.total_withdrawn || 0) + amountSat;
      freshPlayer.last_activity = Date.now();
      await kv.set(playerKey, freshPlayer, { ex: 2592000 });
    }

    // Marquer comme traite pour idempotence (7 jours)
    await kv.set(processedKey, {
      payment_hash: payment.payment_hash,
      amount: amountSat,
      timestamp: Date.now()
    }, { ex: 604800 });

    // Mettre a jour le rate limit
    await kv.set(rateLimitKey, Date.now(), { ex: 120 });

    // Logger la transaction
    const txKey = `transactions:${sessionId}`;
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

    // Nettoyer la tentative
    await kv.del(`attempt:${attemptId}`);

    // Lire le solde reel apres tout (peut avoir change entre-temps)
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

    // Si le debit a ete fait mais le paiement a echoue, rembourser
    if (debited) {
      try {
        await atomicRefund(playerKey, amountSat);
      } catch (refundError) {
        // Log critique: refund echoue, le joueur a perdu des sats
        console.error('CRITIQUE: refund echoue!', refundError, { sessionId, amountSat, attemptId });
        await kv.set(`refund_failed:${attemptId}`, {
          sessionId, amount: amountSat, timestamp: Date.now(), error: refundError.message
        }, { ex: 604800 }); // garder 7 jours pour correction manuelle
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
    // Toujours liberer le verrou
    await kv.del(lockKey);
  }
}

// FIX BUG 1: Refund atomique - re-lit le player frais et ajoute le montant
// Au lieu d'ecraser avec l'ancien objet (qui peut etre stale)
async function atomicRefund(playerKey, amount) {
  const player = await kv.get(playerKey);
  if (player) {
    player.balance = (player.balance || 0) + amount;
    player.last_activity = Date.now();
    await kv.set(playerKey, player, { ex: 2592000 });
  }
}
