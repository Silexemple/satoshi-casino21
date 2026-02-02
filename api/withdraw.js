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
  const invoice = body.invoice;
  
  if (!invoice || !invoice.startsWith('lnbc')) {
    return new Response(JSON.stringify({ error: 'Invoice invalide' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Vérifier le solde
  const player = await kv.get(`player:${sessionId}`);
  
  if (!player || player.balance === 0) {
    return new Response(JSON.stringify({ error: 'Solde insuffisant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const currentBalance = player.balance;
  
  try {
    // Payer l'invoice via LNbits - UTILISER FETCH au lieu d'axios
    const lnbitsUrl = process.env.LNBITS_URL || 'https://legend.lnbits.com';
    const adminKey = process.env.LNBITS_ADMIN_KEY;
    
    if (!adminKey) {
      throw new Error('LNBITS_ADMIN_KEY non configurée');
    }
    
    const response = await fetch(`${lnbitsUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'X-Api-Key': adminKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        out: true,
        bolt11: invoice
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('LNbits error:', response.status, errorText);
      throw new Error(`LNbits API error: ${response.status}`);
    }
    
    const payment = await response.json();
    
    // Calculer le montant (LNbits retourne en millisats)
    const amountPaid = payment.amount ? Math.floor(payment.amount / 1000) : currentBalance;
    
    // Vérifier que le joueur a assez
    if (amountPaid > currentBalance) {
      throw new Error('Solde insuffisant pour cette invoice');
    }
    
    // Paiement réussi, mettre à jour le solde
    player.balance = Math.max(0, currentBalance - amountPaid);
    player.last_activity = Date.now();
    await kv.set(`player:${sessionId}`, player);
    
    // Logger la transaction
    await kv.rpush(`transactions:${sessionId}`, {
      type: 'withdraw',
      amount: amountPaid,
      timestamp: Date.now(),
      description: 'Retrait Lightning'
    });
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        amount: amountPaid,
        payment_hash: payment.payment_hash
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('Erreur paiement:', error);
    
    const errorMessage = error.message || 'Erreur lors du paiement';
    
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
