// LNURL-auth callback (LUD-04)
// Refactor: signature verification via @noble/secp256k1 (was 110 lines of hand-rolled BigInt math).
import { verify } from '@noble/secp256k1';

export const config = { runtime: 'edge' };

// ── Upstash KV REST (pipeline officiel) ─────────────────────────────────────
async function kvCommand(...command) {
  const url = process.env.KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_URL
    || process.env.REDIS_URL;
  const token = process.env.KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.KV_REST_API_READ_ONLY_TOKEN;
  if (!url || !token) {
    throw new Error('KV env vars manquantes (vérifié: KV_REST_API_URL, UPSTASH_REDIS_REST_URL, REDIS_URL)');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`KV ${command[0]} failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}
async function kvGet(key) {
  const r = await kvCommand('GET', key);
  if (r === null || r === undefined) return null;
  try { return JSON.parse(r); } catch { return r; }
}
async function kvSet(key, value, ttl) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (ttl) return await kvCommand('SET', key, v, 'EX', ttl);
  return await kvCommand('SET', key, v);
}

// ── Helpers DER → compact 64 bytes (noble v3 ne supporte que compact) ───────
function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

function derToCompact(der) {
  // Format DER ECDSA: 0x30 [len] 0x02 [rLen] [r...] 0x02 [sLen] [s...]
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('DER: missing sequence tag');
  const seqLen = der[i++];
  if (seqLen + 2 !== der.length) throw new Error('DER: bad sequence length');
  if (der[i++] !== 0x02) throw new Error('DER: missing r tag');
  const rLen = der[i++];
  let r = der.slice(i, i + rLen); i += rLen;
  if (der[i++] !== 0x02) throw new Error('DER: missing s tag');
  const sLen = der[i++];
  let s = der.slice(i, i + sLen);
  // Strip leading zero (encodage DER signé) si présent
  if (r.length > 32 && r[0] === 0x00) r = r.slice(1);
  if (s.length > 32 && s[0] === 0x00) s = s.slice(1);
  if (r.length > 32 || s.length > 32) throw new Error('DER: r/s too large for 256-bit curve');
  // Pad à gauche pour atteindre 32 bytes chacun
  const compact = new Uint8Array(64);
  compact.set(r, 32 - r.length);
  compact.set(s, 64 - s.length);
  return compact;
}

// ── Handler ──────────────────────────────────────────────────────────────────
const J = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'Content-Type': 'application/json' }
});
const err = (reason) => J({ status: 'ERROR', reason });

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const k1  = url.searchParams.get('k1');
    const sig = url.searchParams.get('sig');
    const key = url.searchParams.get('key');
    const tag = url.searchParams.get('tag');

    if (tag !== 'login') return err('Invalid tag');
    if (!k1 || !/^[0-9a-f]{64}$/i.test(k1)) return err('Invalid k1');

    // Phase 1: GET sans sig/key → renvoyer les paramètres LNURL-auth (LUD-04)
    if (!sig && !key) {
      const challenge = await kvGet(`lnauth:k1:${k1}`);
      if (!challenge) return err('Unknown or expired challenge');
      return J({ tag: 'login', callback: `https://${url.hostname}/api/auth/callback`, k1, action: 'login' });
    }

    // Phase 2: vérification de la signature
    if (!sig || !key) return err('Missing parameters');
    if (!/^[0-9a-f]+$/i.test(sig)) return err('Invalid signature format');
    if (sig.length < 16 || sig.length > 144) return err('Invalid signature length');
    if (!/^[0-9a-f]{66}$/i.test(key)) return err('Invalid public key format');
    // Compressed pubkey doit commencer par 02 ou 03
    const pubPrefix = key.slice(0, 2).toLowerCase();
    if (pubPrefix !== '02' && pubPrefix !== '03') return err('Invalid public key prefix');

    const challenge = await kvGet(`lnauth:k1:${k1}`);
    if (!challenge) return err('Unknown or expired challenge');
    if (challenge.status !== 'pending') return err('Challenge already used');

    // Verify ECDSA: signature DER → compact, puis verify(sig, k1, pub) sans prehash
    let valid = false;
    try {
      const compactSig = derToCompact(hexToBytes(sig));
      const k1Bytes = hexToBytes(k1);
      const pubBytes = hexToBytes(key);
      // prehash: false car k1 est déjà un challenge de 32 bytes (la "message hash")
      // lowS: false car la spec LNURL-auth n'impose pas low-S
      valid = verify(compactSig, k1Bytes, pubBytes, { prehash: false, lowS: false });
    } catch (e) {
      console.warn('[auth/callback] signature verify exception:', e?.message);
      return err('Signature invalide (parsing)');
    }
    if (!valid) return err('Signature invalide');

    // Créer ou rafraîchir le joueur
    const playerKey = `player:${key}`;
    const existing = await kvGet(playerKey);
    if (!existing) {
      await kvSet(playerKey, {
        balance: 0, nickname: null, avatar: null,
        created_at: Date.now(), last_activity: Date.now()
      }, 2592000);
    } else {
      existing.last_activity = Date.now();
      await kvSet(playerKey, existing, 2592000);
    }

    // Marquer le challenge comme authentifié — sera consommé par /api/auth/status
    await kvSet(`lnauth:k1:${k1}`, {
      status: 'authenticated', linkingKey: key, authenticated_at: Date.now()
    }, 600);

    return J({ status: 'OK' });

  } catch (e) {
    console.error('[auth/callback]', e?.message, e?.stack);
    return J({ status: 'ERROR', reason: e?.message || 'Erreur interne' });
  }
}
