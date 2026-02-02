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
  const amount = parseInt(body.amount);
  
  if (!amount || amount < 100 || amount > 10000) {
    return new Response(JSON.stringify({ error: 'Montant invalide (100-10000 sats)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const player = await kv.get(`player:${sessionId}`);
  if (player.balance + amount > 10000) {
    return new Response(JSON.stringify({ error: 'Balance max atteinte (10000 sats)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    // Créer l'invoice sur LNbits
    const response = await axios.post(
      `${process.env.LNBITS_URL}/api/v1/payments`,
      {
        out: false,
        amount: amount,
        memo: `Satoshi BJ - Dépôt ${amount} sats`,
        expiry: 3600
      },
      {
        headers: {
          'X-Api-Key': process.env.LNBITS_INVOICE_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const invoice = response.data;
    
    // Sauvegarder dans KV
    await kv.set(`invoice:${invoice.payment_hash}`, {
      session_id: sessionId,
      amount: amount,
      payment_request: invoice.payment_request,
      created_at: Date.now()
    }, { ex: 7200 }); // Expire dans 2 heures
    
    return new Response(
      JSON.stringify({
        payment_hash: invoice.payment_hash,
        payment_request: invoice.payment_request
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('Erreur création invoice:', error);
    return new Response(JSON.stringify({ error: 'Erreur création invoice' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
