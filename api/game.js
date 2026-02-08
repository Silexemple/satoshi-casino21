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
  const betAmount = parseInt(body.bet_amount);
  const result = body.result;
  
  if (!betAmount || !result) {
    return new Response(JSON.stringify({ error: 'Données invalides' }), {
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
  
  // Vérifier que le joueur a assez de fonds
  if (player.balance < betAmount) {
    return new Response(JSON.stringify({ error: 'Solde insuffisant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // ✅ DÉDUIRE LA MISE D'ABORD
  let newBalance = player.balance - betAmount;
  
  if (result === 'win') {
    // Victoire : rend mise + gain (total = mise x2)
    newBalance += betAmount * 2;
    
    await kv.rpush(`transactions:${sessionId}`, {
      type: 'win',
      amount: betAmount,
      timestamp: Date.now(),
      description: 'Victoire'
    });
    
  } else if (result === 'bj') {
    // Blackjack : paie 3:2 (mise x2.5)
    newBalance += Math.floor(betAmount * 2.5);
    
    await kv.rpush(`transactions:${sessionId}`, {
      type: 'blackjack',
      amount: Math.floor(betAmount * 1.5),
      timestamp: Date.now(),
      description: 'Blackjack!'
    });
    
  } else if (result === 'push') {
    // Égalité : rendre la mise
    newBalance += betAmount;
    
    await kv.rpush(`transactions:${sessionId}`, {
      type: 'push',
      amount: 0,
      timestamp: Date.now(),
      description: 'Égalité (Push)'
    });
    
  } else if (result === 'loss' || result === 'bust') {
    // Défaite : garder la mise déduite (ne rien ajouter)
    await kv.rpush(`transactions:${sessionId}`, {
      type: 'loss',
      amount: -betAmount,
      timestamp: Date.now(),
      description: `Défaite (${result})`
    });
  }
  
  // Mettre à jour le joueur
  player.balance = newBalance;
  player.last_activity = Date.now();
  await kv.set(`player:${sessionId}`, player);
  
  return new Response(
    JSON.stringify({ new_balance: newBalance }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
