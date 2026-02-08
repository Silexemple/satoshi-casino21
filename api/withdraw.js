import { kv } from '@vercel/kv';
import cookie from 'cookie';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  const sessionId = cookies.session_id;
  
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Session invalide' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const body = await req.json();
  const invoice = body.invoice?.trim();
  
  if (!invoice || !invoice.startsWith('lnbc')) {
    return new Response(JSON.stringify({ error: 'Invoice invalide (doit commencer par lnbc)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Récupérer le joueur
  const player = await kv.get(`player:${sessionId}`);
  
  if (!player) {
    return new Response(JSON.stringify({ error: 'Joueur non trouvé' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (player.balance <= 0) {
    return new Response(JSON.stringify({ error: 'Solde insuffisant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const currentBalance = player.balance;
  
  // Vérifier les variables d'environnement
  const lnbitsUrl = process.env.LNBITS_URL?.replace(/\/$/, ''); // Supprime le slash final si présent
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
  
  try {
    console.log('Tentative paiement LNbits:', {
      url: `${lnbitsUrl}/api/v1/payments`,
      invoice: invoice.substring(0, 30) + '...',
      balance: currentBalance
    });
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
    
    const response = await fetch(`${lnbitsUrl}/api/v1/payments`, {
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
    
    clearTimeout(timeoutId);
    
    // Log la réponse brute pour debug
    const responseText = await response.text();
    console.log('LNbits raw response:', response.status, responseText);
    
    if (!response.ok) {
      let errorDetail = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorDetail = errorJson.detail || errorJson.message || responseText;
      } catch (e) {
        // Pas du JSON, garder le texte brut
      }
      
      throw new Error(`LNbits erreur ${response.status}: ${errorDetail}`);
    }
    
    let payment;
    try {
      payment = JSON.parse(responseText);
    } catch (e) {
      throw new Error('Réponse LNbits invalide (pas du JSON)');
    }
    
    if (!payment.payment_hash) {
      throw new Error('Réponse LNbits invalide: pas de payment_hash');
    }
    
    // Le montant payé est dans l'invoice, LNbits le déduit automatiquement
    // On met le solde à 0 (retrait complet)
    const newBalance = 0;
    
    // Mettre à jour le joueur
    player.balance = newBalance;
    player.last_activity = Date.now();
    await kv.set(`player:${sessionId}`, player);
    
    // Logger la transaction
    await kv.rpush(`transactions:${sessionId}`, {
      type: 'withdraw',
      amount: currentBalance, // Montant total retiré
      timestamp: Date.now(),
      description: `Retrait Lightning ${payment.payment_hash.substring(0, 8)}`,
      payment_hash: payment.payment_hash,
      invoice: invoice.substring(0, 50)
    });
    
    return new Response(
      JSON.stringify({ 
        success: true,
        amount: currentBalance,
        new_balance: newBalance,
        payment_hash: payment.payment_hash
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('Erreur complète:', error);
    
    // Ne PAS déduire le solde en cas d'erreur
    // Le solde reste inchangé
    
    let errorMessage = 'Erreur lors du paiement';
    
    if (error.name === 'AbortError') {
      errorMessage = 'Timeout - LNbits ne répond pas (30s)';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        balance_unchanged: true
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
