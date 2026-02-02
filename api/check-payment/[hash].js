import { kv } from '@vercel/kv';
import cookie from 'cookie';
import axios from 'axios';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  const sessionId = cookies.session_id;
  
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Session invalide' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Extraire payment_hash de l'URL
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const paymentHash = pathParts[pathParts.length - 1];
  
  if (!paymentHash) {
    return new Response(JSON.stringify({ error: 'Payment hash manquant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Vérifier que l'invoice appartient à ce joueur
  const invoice = await kv.get(`invoice:${paymentHash}`);
  
  if (!invoice || invoice.session_id !== sessionId) {
    return new Response(JSON.stringify({ error: 'Invoice non trouvée' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    // Vérifier le statut sur LNbits
    const response = await axios.get(
      `${process.env.LNBITS_URL}/api/v1/payments/${paymentHash}`,
      {
        headers: {
          'X-Api-Key': process.env.LNBITS_INVOICE_KEY
        }
      }
    );
    
    const status = response.data;
    
    if (status.paid) {
      // Créditer le joueur
      const player = await kv.get(`player:${sessionId}`);
      const newBalance = player.balance + invoice.amount;
      
      player.balance = newBalance;
      player.last_activity = Date.now();
      await kv.set(`player:${sessionId}`, player);
      
      // Logger la transaction
      await kv.rpush(`transactions:${sessionId}`, {
        type: 'deposit',
        amount: invoice.amount,
        timestamp: Date.now(),
        description: `Dépôt Lightning ${paymentHash.substring(0, 8)}`
      });
      
      // Supprimer l'invoice
      await kv.del(`invoice:${paymentHash}`);
      
      return new Response(
        JSON.stringify({ paid: true, new_balance: newBalance }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    return new Response(
      JSON.stringify({ paid: false }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('Erreur vérification invoice:', error);
    return new Response(JSON.stringify({ error: 'Erreur vérification' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
