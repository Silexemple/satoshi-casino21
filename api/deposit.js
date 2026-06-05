import { kv } from '@vercel/kv';
import { json, getSessionId, rateLimit, normalizePlayer, parseBody, sendNodeResponse } from './_helpers.js';
import { nwcRequest } from './_nwc.js';

// Runtime Node.js (default): WebSocket sortant requis pour NWC.
// Edge runtime ne supporte pas les WebSocket sortants vers les relays nostr.
// Node runtime attend (req, res) — on garde la logique en "return Response"
// puis on bridge vers res via sendNodeResponse à la fin.

export default async function handler(req, res) {
  let out;
  try {
    out = await impl(req);
  } catch (err) {
    console.error('deposit unhandled:', err);
    out = json(500, { error: `Erreur interne: ${err.message}` });
  }
  return sendNodeResponse(res, out);
}

async function impl(req) {
  // ── Rate limit IP global ──
  const rl = await rateLimit(req, 'deposit', 5, 60);
  if (rl) return rl;

  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const rlKey = `ratelimit:deposit:${sessionId}`;
  await kv.set(rlKey, 0, { nx: true, ex: 60 });
  const rlCount = await kv.incr(rlKey);
  if (rlCount > 3) return json(429, { error: 'Trop de demandes de depot, attendez un instant' });

  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide', auth_required: true });

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return json(400, { error: 'Body JSON invalide' });
  }
  // Lightning Network: les fees de routage sont quasi-fixes par hop (~1 sat × 3-4 hops),
  // donc en % ils explosent sur les micro-montants. Sous 1000 sats, les wallets payeurs
  // refusent fréquemment les routes (fees > leur budget max de 1-3%).
  const MIN_DEPOSIT = 1000;
  const MAX_DEPOSIT = 100000;
  const MAX_BALANCE = 1000000;
  // Validation stricte: entier pur, pas de float/exponentielle
  const rawAmount = body.amount;
  if (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') {
    return json(400, { error: 'Montant invalide' });
  }
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
    return json(400, {
      error: `Montant invalide (${MIN_DEPOSIT}-${MAX_DEPOSIT} sats). Minimum ${MIN_DEPOSIT} sats car les frais de routage Lightning rendent les paiements plus petits non-viables (>3% de fees).`
    });
  }

  const player = normalizePlayer(await kv.get(`player:${linkingKey}`));
  if (!player) return json(404, { error: 'Joueur non trouve' });

  if (player.balance + amount > MAX_BALANCE) {
    return json(400, { error: `Balance max atteinte (${MAX_BALANCE} sats)` });
  }

  if (!process.env.NWC_URL) return json(500, { error: 'NWC_URL non configuree' });

  try {
    const result = await nwcRequest(process.env.NWC_URL, 'make_invoice', {
      amount: amount * 1000,
      description: `Satoshi BJ - Depot ${amount} sats`,
      expiry: 3600
    });

    await kv.set(`invoice:${result.payment_hash}`, {
      session_id: sessionId,
      linking_key: linkingKey,
      amount: amount,
      payment_request: result.invoice,
      created_at: Date.now()
    }, { ex: 7200 });

    return json(200, {
      payment_hash: result.payment_hash,
      payment_request: result.invoice
    });

  } catch (error) {
    console.error('Erreur creation invoice:', error);
    const m = error.message || '';
    // NWC timeout / relays injoignables = le wallet du casino (ex. Alby Hub) est
    // hors-ligne ou ne répond pas. Message utilisateur clair plutôt que la stack
    // technique opaque "NWC timeout (9000ms…)".
    const walletDown = /timeout|relays? failed|aucun relay|ws error|closed|init failed/i.test(m);
    if (walletDown) {
      return json(503, {
        error: 'Le wallet du casino est momentanément indisponible. Réessayez dans un instant.',
        detail: m
      });
    }
    return json(500, { error: `Erreur creation invoice: ${m}` });
  }
}
