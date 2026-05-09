/**
 * Minimal NWC (NIP-47) client using only @noble/secp256k1 v3 + Web Crypto API
 * Compatible with Vercel Edge runtime and Node.js runtime
 */
import { getSharedSecret, schnorr } from '@noble/secp256k1';

// WebSocket: natif sur Edge runtime, sinon importer le package 'ws' (Node.js)
async function getWebSocket(url) {
  if (typeof globalThis.WebSocket !== 'undefined') {
    return new globalThis.WebSocket(url);
  }
  const { default: WS } = await import('ws');
  return new WS(url);
}

// ---------- Byte Helpers ----------

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseNWCUrl(url) {
  const withoutScheme = url.replace('nostr+walletconnect://', '');
  const [pubkey, qs] = withoutScheme.split('?');
  const params = new URLSearchParams(qs);
  return { pubkey, relays: params.getAll('relay'), secret: params.get('secret') };
}

// ---------- NIP-04 Encryption ----------

async function sharedKey(secretKeyBytes, pubkeyHex) {
  // getSharedSecret requires Uint8Array for both args
  const pubkeyBytes = hexToBytes('02' + pubkeyHex);
  const shared = getSharedSecret(secretKeyBytes, pubkeyBytes); // returns 33 bytes (compressed)
  return shared.slice(1, 33); // x-coordinate only
}

async function nip04Encrypt(secretKeyBytes, pubkeyHex, text) {
  const sharedX = await sharedKey(secretKeyBytes, pubkeyHex);
  const key = await crypto.subtle.importKey('raw', sharedX, { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(cipher))) + '?iv=' + btoa(String.fromCharCode(...iv));
}

async function nip04Decrypt(secretKeyBytes, pubkeyHex, data) {
  const [cipherB64, ivB64] = data.split('?iv=');
  const cipherBytes = Uint8Array.from(atob(cipherB64), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const sharedX = await sharedKey(secretKeyBytes, pubkeyHex);
  const key = await crypto.subtle.importKey('raw', sharedX, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipherBytes);
  return new TextDecoder().decode(plain);
}

// ---------- Nostr Event (NIP-47) ----------

async function sha256Hex(str) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return bytesToHex(new Uint8Array(hash));
}

async function createEvent(secretKeyBytes, walletPubkeyHex, content) {
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(secretKeyBytes)); // 32-byte x-only pubkey
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 23194;
  const tags = [['p', walletPubkeyHex]];
  const serialized = JSON.stringify([0, pubkeyHex, created_at, kind, tags, content]);

  const id = await sha256Hex(serialized);
  // schnorr.sign(msg: Uint8Array, secretKey: Uint8Array) - both must be Uint8Array
  const sig = bytesToHex(await schnorr.signAsync(hexToBytes(id), secretKeyBytes));

  return { id, pubkey: pubkeyHex, created_at, kind, tags, content, sig };
}

// ---------- NWC Request ----------

export async function nwcRequest(nwcUrl, method, params, timeoutMs = 12000) {
  const { pubkey, relays, secret } = parseNWCUrl(nwcUrl);

  // Validation défensive de la NWC URL
  if (!pubkey || !/^[a-f0-9]{64}$/i.test(pubkey)) throw new Error('NWC: pubkey invalide');
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new Error('NWC: secret invalide');
  if (!relays || relays.length === 0) throw new Error('NWC: aucun relay configuré');

  const secretKeyBytes = hexToBytes(secret);
  const myPubkey = bytesToHex(schnorr.getPublicKey(secretKeyBytes));

  const content = await nip04Encrypt(secretKeyBytes, pubkey, JSON.stringify({ method, params }));
  const event = await createEvent(secretKeyBytes, pubkey, content);

  return new Promise(async (resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(val);
    };

    const timeout = setTimeout(() => {
      try { ws?.close(); } catch (_) {}
      settle(reject, new Error('NWC timeout'));
    }, timeoutMs);

    let ws;
    try {
      ws = await getWebSocket(relays[0]);
    } catch (err) {
      settle(reject, new Error(`WebSocket init failed: ${err.message}`));
      return;
    }

    ws.onopen = () => {
      const since = Math.floor(Date.now() / 1000) - 30;
      ws.send(JSON.stringify(['REQ', 'sub1', { kinds: [23195], '#p': [myPubkey], since, limit: 1 }]));
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.onmessage = async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] !== 'EVENT' || data[2]?.kind !== 23195) return;

        const responseEvent = data[2];
        if (responseEvent.pubkey !== pubkey) return;

        const decrypted = await nip04Decrypt(secretKeyBytes, pubkey, responseEvent.content);
        const response = JSON.parse(decrypted);

        try { ws.close(); } catch (_) {}
        if (response.error) {
          settle(reject, new Error(response.error.message || JSON.stringify(response.error)));
        } else {
          settle(resolve, response.result);
        }
      } catch (_) {
        // ignore parse errors, keep waiting
      }
    };

    ws.onerror = (err) => {
      settle(reject, new Error(`WebSocket connection failed: ${err?.message || ''}`));
    };

    ws.onclose = (e) => {
      if (!settled && e.code !== 1000) {
        settle(reject, new Error(`WebSocket closed unexpectedly: ${e.code}`));
      }
    };
  });
}
