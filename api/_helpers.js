import { kv } from '@vercel/kv';
import cookie from 'cookie';

export function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Adapter: deposit/withdraw/check-payment must run on the Vercel Node.js
// runtime (outbound WebSocket to nostr relays — Edge doesn't allow it
// reliably). The Node runtime expects (req, res) => res.send(...) — a
// returned Web Response is silently dropped and the function 504s at
// maxDuration. This bridges a Web Response back to Vercel's res object.
export async function sendNodeResponse(res, webResponse) {
  if (!webResponse || typeof webResponse.text !== 'function') {
    return res.status(500).send('Internal error: no response');
  }
  res.status(webResponse.status);
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  const body = await webResponse.text();
  res.send(body);
}

// Compatible Node.js IncomingMessage (headers plain object) and Edge Request (Headers instance)
function getHeader(req, name) {
  if (typeof req.headers?.get === 'function') return req.headers.get(name);
  return req.headers?.[name.toLowerCase()] ?? null;
}

// Compatible Web API (Edge / Vercel Node fluid compute) ET Node Express-style.
// Trois chemins, dans cet ordre:
//   1. req.json() — Web Request (Edge runtime ou Node runtime en mode Web Handler)
//   2. req.body  — Vercel Node.js runtime: pré-parse JSON/urlencoded et CONSOMME le stream.
//                  Sans ce check on se retrouvait à attendre 'data'/'end' qui n'arrivent
//                  jamais → 504 timeout (cause du retour à Edge runtime auparavant).
//   3. Stream raw — IncomingMessage non-Vercel ou body non auto-parsé (ex: Content-Type
//                   exotique). 64KB max pour bloquer les DoS.
export async function parseBody(req, maxBytes = 65536) {
  if (typeof req.json === 'function') return req.json();
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      data += c;
      if (data.length > maxBytes) {
        aborted = true;
        reject(new Error('Body too large'));
        req.destroy?.();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function getSessionId(req) {
  const cookies = cookie.parse(getHeader(req, 'cookie') || '');
  return cookies.session_id || null;
}

// Normalise le solde d'un joueur pour éviter NaN/undefined
export function normalizePlayer(player) {
  if (!player) return null;
  if (typeof player.balance !== 'number' || Number.isNaN(player.balance)) {
    player.balance = 0;
  }
  return player;
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

// Comparaison de chaînes à temps (quasi) constant — évite la timing attack sur
// les secrets (ADMIN_TOKEN). `!==` court-circuite au premier octet différent, ce
// qui fuit la position de divergence; ici on parcourt toujours la longueur max.
// Pas de crypto.timingSafeEqual en Edge runtime, d'où l'implémentation manuelle.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ═══ VERROU SOLDE JOUEUR (sérialise TOUTES les mutations de balance) ═══
//
// Le solde est stocké dans un blob JSON `player:{linkingKey}` et muté en
// read-modify-write. Sans un verrou COMMUN à tous les sous-systèmes (jeu solo,
// tables, tournois, dépôt, retrait, tip, session), deux requêtes concurrentes
// du même joueur lisent le même solde et s'écrasent (lost update) → double
// dépense exploitable. Tout site qui modifie `player:{linkingKey}.balance` DOIT
// passer par withPlayerLock(linkingKey, ...).
//
// IMPORTANT anti-deadlock: ne JAMAIS appeler creditPlayers()/un autre code qui
// acquiert lock:player:* pendant qu'on tient déjà ce verrou. withPlayerLock
// relâche en finally avant de rendre la main, donc enchaîner les sections
// verrouillées séquentiellement est sûr; les imbriquer ne l'est pas.
export async function withPlayerLock(linkingKey, fn, { retries = 25, delayMs = 200, ttlSec = 10 } = {}) {
  if (!linkingKey) throw new Error('withPlayerLock: linkingKey manquant');
  const lockKey = `lock:player:${linkingKey}`;
  let acquired = false;
  for (let attempt = 0; attempt < retries; attempt++) {
    acquired = await kv.set(lockKey, '1', { nx: true, ex: ttlSec });
    if (acquired) break;
    await new Promise(r => setTimeout(r, delayMs));
  }
  if (!acquired) {
    const err = new Error('player_locked');
    err.code = 'PLAYER_LOCKED';
    throw err;
  }
  try {
    return await fn();
  } finally {
    try { await kv.del(lockKey); } catch (_) {}
  }
}

// Verrou sur DEUX joueurs (ex. tip émetteur→destinataire). Acquiert dans un
// ordre canonique (tri lexicographique des linkingKeys) pour éviter le deadlock
// croisé A→B / B→A. Si les deux clés sont identiques, un seul verrou est pris.
export async function withTwoPlayerLocks(linkingKeyA, linkingKeyB, fn, opts) {
  if (linkingKeyA === linkingKeyB) return withPlayerLock(linkingKeyA, fn, opts);
  const [first, second] = [linkingKeyA, linkingKeyB].sort();
  return withPlayerLock(first, () => withPlayerLock(second, fn, opts), opts);
}

// ═══ RATE LIMIT IP GLOBAL ═══
// Limite configurable par route: ex. rateLimit(req, 'game', 60, 60)
// = max 60 actions par 60 secondes par IP pour la route 'game'
export async function rateLimit(req, route, maxRequests = 30, windowSeconds = 60) {
  const ip = getHeader(req, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getHeader(req, 'x-real-ip')
    || 'unknown';

  if (ip === 'unknown') return null; // pas de rate limit si IP inconnue

  const key = `ratelimit:global:${route}:${ip}`;
  // Atomique: SET NX avec EX pour initialiser, puis INCR
  // Évite la race condition INCR+EXPIRE (clé sans TTL si crash entre les deux)
  await kv.set(key, 0, { nx: true, ex: windowSeconds });
  const count = await kv.incr(key);

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
