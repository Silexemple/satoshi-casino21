/**
 * Minimal NWC (NIP-47) client using only Web APIs + @noble/secp256k1
 * Compatible with Vercel Edge runtime
 */
import * as secp from '@noble/secp256k1';

// ---------- Helpers ----------

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
  return {
    pubkey,
    relays: params.getAll('relay'),
    secret: params.get('secret')
  };
}

// ---------- NIP-04 Encryption ----------

async function nip04Encrypt(secretKey, pubkey, text) {
  const shared = secp.getSharedSecret(secretKey, '02' + pubkey);
  const sharedX = shared.slice(1, 33); // x coordinate

  const key = await crypto.subtle.importKey(
    'raw', sharedX, { name: 'AES-CBC' }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const encoded = new TextEncoder().encode(text);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, encoded);

  return btoa(String.fromCharCode(...new Uint8Array(cipher))) +
    '?iv=' + btoa(String.fromCharCode(...iv));
}

async function nip04Decrypt(secretKey, pubkey, data) {
  const [cipherB64, ivB64] = data.split('?iv=');
  const cipherBytes = Uint8Array.from(atob(cipherB64), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));

  const shared = secp.getSharedSecret(secretKey, '02' + pubkey);
  const sharedX = shared.slice(1, 33);

  const key = await crypto.subtle.importKey(
    'raw', sharedX, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipherBytes);
  return new TextDecoder().decode(plain);
}

// ---------- Nostr Event ----------

async function sha256(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(hash);
}

async function createEvent(secretKey, pubkey, content, kind = 23194) {
  const created_at = Math.floor(Date.now() / 1000);
  const tags = [['p', pubkey]];
  const serialized = JSON.stringify([0, bytesToHex(secp.schnorr.getPublicKey(secretKey)), created_at, kind, tags, content]);

  const id = bytesToHex(await sha256(serialized));
  const sig = bytesToHex(await secp.schnorr.sign(hexToBytes(id), secretKey));

  return {
    id,
    pubkey: bytesToHex(secp.schnorr.getPublicKey(secretKey)),
    created_at,
    kind,
    tags,
    content,
    sig
  };
}

// ---------- NWC Request ----------

export async function nwcRequest(nwcUrl, method, params, timeoutMs = 9000) {
  const { pubkey, relays, secret } = parseNWCUrl(nwcUrl);

  const content = await nip04Encrypt(hexToBytes(secret), pubkey, JSON.stringify({ method, params }));
  const event = await createEvent(hexToBytes(secret), pubkey, content);
  const myPubkey = bytesToHex(secp.schnorr.getPublicKey(hexToBytes(secret)));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('NWC timeout'));
    }, timeoutMs);

    const ws = new WebSocket(relays[0]);

    ws.onopen = () => {
      // Subscribe for responses
      ws.send(JSON.stringify(['REQ', 'sub1', { kinds: [23195], '#p': [myPubkey], limit: 1 }]));
      // Send request
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.onmessage = async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] !== 'EVENT' || data[2]?.kind !== 23195) return;

        const responseEvent = data[2];
        const decrypted = await nip04Decrypt(hexToBytes(secret), pubkey, responseEvent.content);
        const response = JSON.parse(decrypted);

        clearTimeout(timeout);
        ws.close();

        if (response.error) {
          reject(new Error(response.error.message || JSON.stringify(response.error)));
        } else {
          resolve(response.result);
        }
      } catch (e) {
        // ignore parse errors, wait for next message
      }
    };

    ws.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error'));
    };
  });
}
