import { kv } from '@vercel/kv';
import cookie from 'cookie';

export function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function getSessionId(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  return cookies.session_id || null;
}

// Resolve session UUID -> linkingKey (compressed secp256k1 pubkey hex)
export async function getLinkingKey(sessionId) {
  return kv.get(`session:${sessionId}`);
}

// Get player data via session UUID
export async function getPlayer(sessionId) {
  const linkingKey = await getLinkingKey(sessionId);
  if (!linkingKey) return null;
  return kv.get(`player:${linkingKey}`);
}

// Get the player's KV key (player:{linkingKey})
export async function getPlayerKey(sessionId) {
  const linkingKey = await getLinkingKey(sessionId);
  if (!linkingKey) return null;
  return `player:${linkingKey}`;
}

// Save player data via session
export async function savePlayer(sessionId, data, options = { ex: 2592000 }) {
  const linkingKey = await getLinkingKey(sessionId);
  if (!linkingKey) return false;
  await kv.set(`player:${linkingKey}`, data, options);
  return true;
}

// Get transactions key via session
export async function getTxKey(sessionId) {
  const linkingKey = await getLinkingKey(sessionId);
  return linkingKey ? `transactions:${linkingKey}` : null;
}

// ═══ RATE LIMIT IP GLOBAL ═══
// Limite configurable par route: ex. rateLimit(req, 'game', 60, 60)
// = max 60 actions par 60 secondes par IP pour la route 'game'
export async function rateLimit(req, route, maxRequests = 30, windowSeconds = 60) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';

  if (ip === 'unknown') return null; // pas de rate limit si IP inconnue

  const key = `ratelimit:global:${route}:${ip}`;
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, windowSeconds);

  if (count > maxRequests) {
    const retryAfter = windowSeconds;
    return new Response(JSON.stringify({
      error: `Trop de requêtes. Réessayez dans ${retryAfter}s.`,
      retryAfter
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(maxRequests),
        'X-RateLimit-Remaining': '0'
      }
    });
  }

  return null; // pas de blocage
}
