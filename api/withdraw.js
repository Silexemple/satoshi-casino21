import { kv } from '@vercel/kv';
import cookie from 'cookie';
import axios from 'axios';

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
    // Payer l'invoice via LNbits
    const response = await axios.post(
      `${process.env.LNBITS_URL}/api/v1/payments`,
      {
        out: true,
        bolt11: invoice
      },
      {
        headers: {
          'X-Api-Key': process.env.LNBITS_ADMIN_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    // Paiement réussi, mettre à jour le solde
    player.balance = 0;
    player.last_activity = Date.now();
    await kv.set(`player:${sessionId}`, player);
    
    // Logger la transaction
    await kv.rpush(`transactions:${sessionId}`, {
      type: 'withdraw',
      amount: currentBalance,
      timestamp: Date.now(),
      description: 'Retrait Lightning'
    });
    
    return new Response(
      JSON.stringify({ success: true, amount: currentBalance }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('Erreur paiement:', error);
    
    const errorMessage = error.response?.data?.detail || 'Erreur lors du paiement';
    
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
