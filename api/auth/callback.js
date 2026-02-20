import { kv } from '@vercel/kv';
import * as secp from '@noble/secp256k1';

export const config = { runtime: 'edge' };

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// @noble/secp256k1 v3 ne supporte pas DER — conversion DER -> compact (64 bytes)
// Format DER: 30 <len> 02 <rLen> <r> 02 <sLen> <s>
function derToCompact(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('Not a DER SEQUENCE');
  i++; // skip total length
  if (der[i++] !== 0x02) throw new Error('Expected INTEGER for r');
  const rLen = der[i++];
  const r = der.slice(i, i + rLen); i += rLen;
  if (der[i++] !== 0x02) throw new Error('Expected INTEGER for s');
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);
  // Strip leading 0x00 DER padding, right-align to 32 bytes
  const rClean = r[0] === 0 ? r.slice(1) : r;
  const sClean = s[0] === 0 ? s.slice(1) : s;
  const compact = new Uint8Array(64);
  compact.set(rClean, 32 - rClean.length);
  compact.set(sClean, 64 - sClean.length);
  return compact;
}

function errResp(reason) {
  return new Response(
    JSON.stringify({ status: 'ERROR', reason }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

export default async function handler(req) {
  const url = new URL(req.url);
  const k1  = url.searchParams.get('k1');
  const sig = url.searchParams.get('sig');
  const key = url.searchParams.get('key');
  const tag = url.searchParams.get('tag');

  if (tag !== 'login') return errResp('Invalid tag');
  if (!k1 || !/^[0-9a-f]{64}$/i.test(k1)) return errResp('Invalid k1 format');

  // ── Etape 1 (LUD-04) : wallet fait un GET sans sig/key pour obtenir les infos du service ──
  if (!sig && !key) {
    const challenge = await kv.get(`lnauth:k1:${k1}`);
    if (!challenge) return errResp('Unknown or expired challenge');

    const callbackBase = `https://${url.hostname}/api/auth/callback`;
    return new Response(JSON.stringify({
      tag: 'login',
      callback: callbackBase,
      k1,
      action: 'login'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── Etape 2 (LUD-04) : wallet soumet la signature ──
  if (!sig || !key) return errResp('Missing parameters');
  if (!/^[0-9a-f]+$/i.test(sig)) return errResp('Invalid signature format');
  if (!/^[0-9a-f]{66}$/i.test(key)) return errResp('Invalid public key format');

  const challenge = await kv.get(`lnauth:k1:${k1}`);
  if (!challenge) return errResp('Unknown or expired challenge');
  if (challenge.status !== 'pending') return errResp('Challenge already used');

  // Verification secp256k1
  // - Les wallets signent k1 directement (k1 = message hash 32 bytes)
  // - Format signature : DER -> convertir en compact 64 bytes pour noble v3
  // - verifyAsync + prehash:false : evite d'appeler sha256 sync (undefined en Edge)
  try {
    const k1Bytes  = hexToBytes(k1);
    const sigDer   = hexToBytes(sig);
    const sigCompact = derToCompact(sigDer);
    const pubKey   = hexToBytes(key);

    const isValid = await secp.verifyAsync(sigCompact, k1Bytes, pubKey, { prehash: false });
    if (!isValid) return errResp('Signature invalide');
  } catch (e) {
    return errResp('Erreur verification signature');
  }

  // Creer ou rafraichir le compte joueur
  const playerKey = `player:${key}`;
  const existing = await kv.get(playerKey);
  if (!existing) {
    await kv.set(playerKey, {
      balance: 0,
      nickname: null,
      avatar: null,
      created_at: Date.now(),
      last_activity: Date.now()
    }, { ex: 2592000 });
  } else {
    existing.last_activity = Date.now();
    await kv.set(playerKey, existing, { ex: 2592000 });
  }

  // Marquer k1 comme authentifie (usage unique)
  await kv.set(`lnauth:k1:${k1}`, {
    status: 'authenticated',
    linkingKey: key,
    authenticated_at: Date.now()
  }, { ex: 600 });

  return new Response(JSON.stringify({ status: 'OK' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
