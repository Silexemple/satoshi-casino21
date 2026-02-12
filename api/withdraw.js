import { kv } from '@vercel/kv';
import cookie from 'cookie';

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
  // Vérifier la méthode
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const idempotencyKey = generateIdempotencyKey('req');
  
  try {
    // Parse le cookie
    const cookies = cookie.parse(req.headers.get('cookie') || '');
    const sessionId = cookies.session_id;
    
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'Session invalide' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Rate limiting - max 1 retrait par minute
    const rateLimitKey = `ratelimit:withdraw:${sessionId}`;
    const lastWithdraw = await kv.get(rateLimitKey);
    
    if (lastWithdraw && (Date.now() - lastWithdraw) < 60000) {
      const waitSeconds = Math.ceil((60000 - (Date.now() - lastWithdraw)) / 1000);
      return new Response(JSON.stringify({ 
        error: `Veuillez attendre ${waitSeconds}s entre les retraits` 
      }), {
        status: 429,
        headers: { 
          'Content-Type': 'application/json',
          'Retry-After': String(waitSeconds)
        }
      });
    }

    // Parse le body
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Body JSON invalide' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const invoice = body.invoice?.trim();
    
    // Validation stricte de l'invoice
    if (!invoice) {
      return new Response(JSON.stringify({ error: 'Invoice manquante' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!invoice.startsWith('lnbc')) {
      return new Response(JSON.stringify({ error: 'Invoice invalide (doit commencer par lnbc)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (invoice.length < 20 || invoice.length > 10000) {
      return new Response(JSON.stringify({ error: 'Invoice invalide (longueur incorrecte)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Décoder et vérifier le montant
    const amountSat = decodeInvoiceAmount(invoice);
    
    if (amountSat === null || amountSat <= 0) {
      return new Response(JSON.stringify({ error: 'Impossible de décoder le montant de l\'invoice' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Limite de retrait (optionnel - ajuster selon tes besoins)
    const MAX_WITHDRAW = 1000000; // 1M sats max par retrait
    if (amountSat > MAX_WITHDRAW) {
      return new Response(JSON.stringify({ 
        error: `Montant maximum de retrait: ${MAX_WITHDRAW} sats` 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Récupérer le joueur avec verrou pour éviter les race conditions
    const lockKey = `lock:player:${sessionId}`;
    const lock = await kv.set(lockKey, Date.now(), { nx: true, ex: 30 }); // 30s TTL
    
    if (!lock) {
      return new Response(JSON.stringify({ error: 'Une autre opération est en cours' }), {
        status: 423,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const player = await kv.get(`player:${sessionId}`);
      
      if (!player) {
        return new Response(JSON.stringify({ error: 'Joueur non trouvé' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const currentBalance = player.balance || 0;

      if (currentBalance <= 0) {
        return new Response(JSON.stringify({ error: 'Solde insuffisant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (amountSat > currentBalance) {
        return new Response(JSON.stringify({ 
          error: `Solde insuffisant. Disponible: ${currentBalance} sats, Demandé: ${amountSat} sats` 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Vérifier les variables d'environnement
      const lnbitsUrl = process.env.LNBITS_URL?.replace(/\/$/, '');
      const adminKey = process.env.LNBITS_ADMIN_KEY;

      if (!lnbitsUrl) {
        return new Response(JSON.stringify({ error: 'LNBITS_URL non configurée' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!adminKey) {
        return new Response(JSON.stringify({ error: 'LNBITS_ADMIN_KEY non configurée' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Vérifier l'idempotence - éviter les doubles paiements
      const processedKey = `processed:${invoice}`;
      const alreadyProcessed = await kv.get(processedKey);
      
      if (alreadyProcessed) {
        return new Response(JSON.stringify({ 
          error: 'Cette invoice a déjà été payée',
          payment_hash: alreadyProcessed.payment_hash 
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Calculer le nouveau solde AVANT le paiement
      const newBalance = currentBalance - amountSat;

      // Logger la tentative (pour audit)
      const attemptId = `withdraw:${sessionId}:${Date.now()}`;
      await kv.set(`attempt:${attemptId}`, {
        invoice: invoice.substring(0, 50),
        amount: amountSat,
        status: 'pending',
        timestamp: Date.now()
      }, { ex: 3600 }); // 1h TTL

      // Appel LNbits avec timeout
      console.log('Tentative paiement LNbits:', {
        url: `${lnbitsUrl}/api/v1/payments`,
        amount: amountSat,
        invoice: invoice.substring(0, 30) + '...'
      });

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
      } finally {
        clearTimeout(timeoutId);
      }

      // Lire la réponse
      const responseText = await response.text();
      console.log('LNbits response:', response.status, responseText.substring(0, 200));

      // Traiter la réponse
      let payment;
      try {
        payment = JSON.parse(responseText);
      } catch (e) {
        throw new Error(`Réponse LNbits invalide: ${responseText.substring(0, 100)}`);
      }

      // Vérifier le succès du paiement
      if (!response.ok) {
        const errorDetail = payment.detail || payment.message || responseText;
        
        // Mettre à jour le statut de la tentative
        await kv.set(`attempt:${attemptId}`, {
          invoice: invoice.substring(0, 50),
          amount: amountSat,
          status: 'failed',
          error: errorDetail,
          timestamp: Date.now()
        }, { ex: 3600 });

        throw new Error(`LNbits erreur ${response.status}: ${errorDetail}`);
      }

      if (!payment.payment_hash) {
        throw new Error('Réponse LNbits invalide: payment_hash manquant');
      }

      // ✅ Paiement réussi - mettre à jour le solde
      player.balance = newBalance;
      player.last_activity = Date.now();
      player.total_withdrawn = (player.total_withdrawn || 0) + amountSat;
      
      await kv.set(`player:${sessionId}`, player);
      
      // Marquer comme traité pour idempotence (7 jours)
      await kv.set(processedKey, {
        payment_hash: payment.payment_hash,
        amount: amountSat,
        timestamp: Date.now()
      }, { ex: 604800 });

      // Mettre à jour le rate limit
      await kv.set(rateLimitKey, Date.now(), { ex: 120 }); // 2min TTL

      // Logger la transaction
      await kv.rpush(`transactions:${sessionId}`, {
        type: 'withdraw',
        amount: amountSat,
        timestamp: Date.now(),
        description: `Retrait Lightning ${payment.payment_hash.substring(0, 8)}...`,
        payment_hash: payment.payment_hash,
        invoice: invoice.substring(0, 50),
        balance_before: currentBalance,
        balance_after: newBalance
      });

      // Mettre à jour le statut de la tentative
      await kv.del(`attempt:${attemptId}`);

      return new Response(
        JSON.stringify({ 
          success: true,
          amount: amountSat,
          new_balance: newBalance,
          payment_hash: payment.payment_hash,
          timestamp: Date.now()
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );

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

    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        balance_unchanged: true,
        id: idempotencyKey
      }),
      {
        status: statusCode,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
