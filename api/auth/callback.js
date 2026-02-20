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

function errResp(reason) {
  return new Response(
    JSON.stringify({ status: 'ERROR', reason }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
}

export default async function handler(req) {
  const url = new URL(req.url);
  const k1 = url.searchParams.get('k1');
  const sig = url.searchParams.get('sig');
  const key = url.searchParams.get('key'); // linking key = compressed pubkey hex
  const tag = url.searchParams.get('tag');

  if (tag !== 'login') return errResp('Invalid tag');
  if (!k1 || !sig || !key) return errResp('Missing parameters');

  // Validate formats
  if (!/^[0-9a-f]{64}$/i.test(k1)) return errResp('Invalid k1 format');
  if (!/^[0-9a-f]+$/i.test(sig)) return errResp('Invalid signature format');
  if (!/^[0-9a-f]{66}$/i.test(key)) return errResp('Invalid public key format');

  // Look up k1 challenge
  const challenge = await kv.get(`lnauth:k1:${k1}`);
  if (!challenge) return errResp('Unknown or expired challenge');
  if (challenge.status !== 'pending') return errResp('Challenge already used');

  // Verify secp256k1 signature: sig over SHA256(k1_bytes)
  try {
    const k1Bytes = hexToBytes(k1);
    const hashBuf = await crypto.subtle.digest('SHA-256', k1Bytes);
    const msgHash = new Uint8Array(hashBuf);
    const sigBytes = hexToBytes(sig);
    const pubKeyBytes = hexToBytes(key);

    const isValid = secp.verify(sigBytes, msgHash, pubKeyBytes);
    if (!isValid) return errResp('Signature invalide');
  } catch (e) {
    return errResp('Erreur verification signature');
  }

  // Create or refresh player record
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

  // Mark k1 as authenticated (wallet has proven ownership)
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
