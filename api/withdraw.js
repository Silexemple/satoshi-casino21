import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = {
  runtime: 'edge',
};

// Décoder le montant d'une invoice BOLT11 (en satoshis)
function decodeInvoiceAmount(invoice) {
  try {
    // Format: lnbc[montant][unité]1...
    // unités: m=milli (10^-3), u=micro (10^-6), n=nano (10^-9), p=pico (10^-12)
    const match = invoice.match(/^lnbc(\d+)([munp])?1/);
    if (!match) return null;
    
    const [, amountStr, unit] = match;
    const amount = BigInt(amountStr);
    
    // Conversion en millisatoshis d'abord, puis en satoshis
    const multipliers = {
      '': BigInt(100000000000), // BTC -> msat (1 BTC = 10^11 msat)
      'm': BigInt(100000000),   // milliBTC -> msat
      'u': BigInt(100000),      // microBTC -> msat  
      'n': BigInt(100),         // nanoBTC -> msat
      'p': BigInt(1)            // picoBTC -> msat
    };
    
    const amountMsat = amount * (multipliers[unit] || multipliers['']);
    return Number(amountMsat / BigInt(1000)); // Convertir en satoshis
  } catch (e) {
    return null;
  }
}

// Générer un ID unique pour l'idempotence
function generateIdempotencyKey(sessionId) {
  return `${sessionId}:${Date.now()}:${Math.random().toString(36).substring(2, 15)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const idempotencyKey = generateIdempotencyKey('req');

  try {
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

    const invoice = body.invoice?.trim();
    
    // Validation stricte de l'invoice
    if (!invoice) {
      return json(400, { error: 'Invoice manquante' });
    }

    if (!invoice.startsWith('lnbc')) {
      return json(400, { error: 'Invoice invalide (doit commencer par lnbc)' });
    }

    if (invoice.length < 20 || invoice.length > 10000) {
      return json(400, { error: 'Invoice invalide (longueur incorrecte)' });
    }

    // Décoder et vérifier le montant
    const amountSat = decodeInvoiceAmount(invoice);
    
    if (amountSat === null || amountSat <= 0) {
      return json(400, { error: 'Impossible de décoder le montant de l\'invoice' });
    }

    // Limite de retrait (optionnel - ajuster selon tes besoins)
    const MAX_WITHDRAW = 1000000; // 1M sats max par retrait
    if (amountSat > MAX_WITHDRAW) {
      return json(400, { error: `Montant maximum de retrait: ${MAX_WITHDRAW} sats` });
    }

    // Récupérer le joueur avec verrou pour éviter les race conditions
    const lockKey = `lock:player:${sessionId}`;
    const lock = await kv.set(lockKey, Date.now(), { nx: true, ex: 30 }); // 30s TTL
    
    if (!lock) {
      return json(423, { error: 'Une autre opération est en cours' });
    }

    try {
      const player = await kv.get(`player:${sessionId}`);
      
      if (!player) {
        return json(404, { error: 'Joueur non trouvé' });
      }

      const currentBalance = player.balance || 0;

      if (currentBalance <= 0) {
        return json(400, { error: 'Solde insuffisant' });
      }

      if (amountSat > currentBalance) {
        return json(400, { error: `Solde insuffisant. Disponible: ${currentBalance} sats, Demandé: ${amountSat} sats` });
      }

      // Vérifier les variables d'environnement
      const lnbitsUrl = process.env.LNBITS_URL?.replace(/\/$/, '');
      const adminKey = process.env.LNBITS_ADMIN_KEY;

      if (!lnbitsUrl) {
        return json(500, { error: 'LNBITS_URL non configurée' });
      }

      if (!adminKey) {
        return json(500, { error: 'LNBITS_ADMIN_KEY non configurée' });
      }

      // Vérifier l'idempotence - éviter les doubles paiements
      const processedKey = `processed:${invoice}`;
      const alreadyProcessed = await kv.get(processedKey);
      
      if (alreadyProcessed) {
        return json(409, { error: 'Cette invoice a déjà été payée', payment_hash: alreadyProcessed.payment_hash });
      }

      // DEBIT-FIRST: débiter le solde AVANT le paiement LNbits
      const newBalance = currentBalance - amountSat;
      player.balance = newBalance;
      player.last_activity = Date.now();
      await kv.set(`player:${sessionId}`, player, { ex: 2592000 });

      // Logger la tentative (pour audit)
      const attemptId = `withdraw:${sessionId}:${Date.now()}`;
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
        // REFUND: rembourser si l'appel réseau échoue
        player.balance = currentBalance;
        await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
        await kv.set(`attempt:${attemptId}`, {
          invoice: invoice.substring(0, 50),
          amount: amountSat,
          status: 'refunded',
          error: fetchError.name,
          timestamp: Date.now()
        }, { ex: 3600 });
        throw fetchError;
      } finally {
        clearTimeout(timeoutId);
      }

      // Lire la réponse
      const responseText = await response.text();

      let payment;
      try {
        payment = JSON.parse(responseText);
      } catch (e) {
        // REFUND: réponse illisible = paiement échoué
        player.balance = currentBalance;
        await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
        throw new Error('Réponse LNbits invalide');
      }

      // Vérifier le succès du paiement
      if (!response.ok) {
        // REFUND: paiement refusé par LNbits
        player.balance = currentBalance;
        await kv.set(`player:${sessionId}`, player, { ex: 2592000 });

        await kv.set(`attempt:${attemptId}`, {
          invoice: invoice.substring(0, 50),
          amount: amountSat,
          status: 'failed',
          error: payment.detail || payment.message || 'unknown',
          timestamp: Date.now()
        }, { ex: 3600 });

        throw new Error(`LNbits erreur ${response.status}`);
      }

      if (!payment.payment_hash) {
        player.balance = currentBalance;
        await kv.set(`player:${sessionId}`, player, { ex: 2592000 });
        throw new Error('Réponse LNbits invalide: payment_hash manquant');
      }

      // Paiement réussi - finaliser
      player.total_withdrawn = (player.total_withdrawn || 0) + amountSat;
      
      // Marquer comme traité pour idempotence (7 jours)
      await kv.set(processedKey, {
        payment_hash: payment.payment_hash,
        amount: amountSat,
        timestamp: Date.now()
      }, { ex: 604800 });

      // Mettre à jour le rate limit
      await kv.set(rateLimitKey, Date.now(), { ex: 120 }); // 2min TTL

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
        balance_after: newBalance
      });
      await kv.expire(txKey, 2592000);

      // Mettre à jour le statut de la tentative
      await kv.del(`attempt:${attemptId}`);

      return json(200, {
        success: true,
        amount: amountSat,
        new_balance: newBalance,
        payment_hash: payment.payment_hash,
        timestamp: Date.now()
      });

    } finally {
      // Toujours libérer le verrou
      await kv.del(lockKey);
    }

  } catch (error) {
    console.error('Erreur retrait:', error);
    
    let errorMessage = 'Erreur lors du paiement';
    let statusCode = 500;

    if (error.name === 'AbortError') {
      errorMessage = 'Timeout - LNbits ne répond pas';
      statusCode = 504;
    } else if (error.message?.includes('insufficient balance')) {
      statusCode = 400;
      errorMessage = 'Solde LNbits insuffisant pour ce paiement';
    } else if (error.message?.includes('self-payment')) {
      statusCode = 400;
      errorMessage = 'Auto-paiement non autorisé';
    }

    return json(statusCode, { error: errorMessage, balance_unchanged: true, id: idempotencyKey });
  }
}
