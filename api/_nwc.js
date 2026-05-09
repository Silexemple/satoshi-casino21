/**
 * Minimal NWC (NIP-47) client using only @noble/secp256k1 v3 + Web Crypto API
 * Compatible with Vercel Node.js runtime.
 *
 * Strategy: subscribe + publish on ALL relays in parallel, first valid response wins.
 * Per Alby docs (https://docs.nwc.dev), wallets may listen on any of the relays
 * advertised in the connection URL — using only relays[0] silently fails when the
 * wallet is bound to relays[1+], producing the symptom we hit (504 / NWC timeout).
 */
import { getSharedSecret, schnorr } from '@noble/secp256k1';

// WebSocket: native on Node 22+ / Edge runtime, fallback to 'ws' package on older Node.
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
  const pubkeyBytes = hexToBytes('02' + pubkeyHex);
  const shared = getSharedSecret(secretKeyBytes, pubkeyBytes); // 33 bytes (compressed)
  return shared.slice(1, 33); // x-coordinate only (NIP-04 spec)
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
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(secretKeyBytes)); // 32-byte x-only
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 23194;
  const tags = [['p', walletPubkeyHex]];
  const serialized = JSON.stringify([0, pubkeyHex, created_at, kind, tags, content]);

  const id = await sha256Hex(serialized);
  const sig = bytesToHex(await schnorr.signAsync(hexToBytes(id), secretKeyBytes));

  return { id, pubkey: pubkeyHex, created_at, kind, tags, content, sig };
}

// ---------- Per-relay worker ----------
// Returns a promise that resolves with the decrypted NWC response, or rejects on
// connection failure. The caller cancels via abort() on timeout / sibling success.

function relayWorker({ relayUrl, event, myPubkey, walletPubkey, secretKeyBytes, abortSignal }) {
  return new Promise(async (resolve, reject) => {
    let ws;
    let settled = false;

    const cleanup = () => {
      try { ws?.close(); } catch (_) {}
    };

    const settle = (ok, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      ok ? resolve(val) : reject(val);
    };

    abortSignal.addEventListener('abort', () => settle(false, new Error('aborted')), { once: true });

    try {
      ws = await getWebSocket(relayUrl);
    } catch (err) {
      settle(false, new Error(`relay ${relayUrl}: init failed (${err.message})`));
      return;
    }

    ws.onopen = () => {
      try {
        // Subscribe to responses tied to THIS request id via the NIP-47 'e' tag.
        // Without this filter the relay can replay a recent response from a
        // previous request (since-window) and we'd take it for ours.
        ws.send(JSON.stringify(['REQ', 'sub1', {
          kinds: [23195],
          '#p': [myPubkey],
          '#e': [event.id],
          since: event.created_at,
          limit: 1
        }]));
        ws.send(JSON.stringify(['EVENT', event]));
      } catch (err) {
        settle(false, new Error(`relay ${relayUrl}: send failed (${err.message})`));
      }
    };

    ws.onmessage = async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] !== 'EVENT' || data[2]?.kind !== 23195) return;

        const responseEvent = data[2];
        if (responseEvent.pubkey !== walletPubkey) return;
        const tags = responseEvent.tags || [];
        // Must reply to OUR request id (NIP-47 correlation).
        if (!tags.some(t => t[0] === 'e' && t[1] === event.id)) return;
        // And be addressed to us.
        if (!tags.some(t => t[0] === 'p' && t[1] === myPubkey)) return;

        const decrypted = await nip04Decrypt(secretKeyBytes, walletPubkey, responseEvent.content);
        const response = JSON.parse(decrypted);

        if (response.error) {
          settle(false, new Error(response.error.message || JSON.stringify(response.error)));
        } else {
          settle(true, response.result);
        }
      } catch (_) {
        // ignore parse errors, keep waiting on this relay
      }
    };

    ws.onerror = (err) => {
      settle(false, new Error(`relay ${relayUrl}: ws error (${err?.message || 'unknown'})`));
    };

    ws.onclose = (e) => {
      if (!settled && e?.code !== 1000) {
        settle(false, new Error(`relay ${relayUrl}: closed (code=${e?.code})`));
      }
    };
  });
}

// ---------- Public API ----------

export async function nwcRequest(nwcUrl, method, params, timeoutMs = 9000) {
  const { pubkey, relays, secret } = parseNWCUrl(nwcUrl);

  if (!pubkey || !/^[a-f0-9]{64}$/i.test(pubkey)) throw new Error('NWC: pubkey invalide');
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new Error('NWC: secret invalide');
  if (!relays || relays.length === 0) throw new Error('NWC: aucun relay configuré');

  const secretKeyBytes = hexToBytes(secret);
  const myPubkey = bytesToHex(schnorr.getPublicKey(secretKeyBytes));

  const content = await nip04Encrypt(secretKeyBytes, pubkey, JSON.stringify({ method, params }));
  const event = await createEvent(secretKeyBytes, pubkey, content);

  const abortController = new AbortController();
  const workers = relays.map(relayUrl =>
    relayWorker({
      relayUrl,
      event,
      myPubkey,
      walletPubkey: pubkey,
      secretKeyBytes,
      abortSignal: abortController.signal
    })
  );

  // Race: first relay to deliver a valid response (or NWC error) wins.
  // Promise.any rejects only if EVERY relay fails before timeout.
  const winnerPromise = Promise.any(workers);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`NWC timeout (${timeoutMs}ms, tried ${relays.length} relay${relays.length > 1 ? 's' : ''})`)), timeoutMs);
  });

  try {
    const result = await Promise.race([winnerPromise, timeoutPromise]);
    abortController.abort(); // close the losing sockets
    return result;
  } catch (err) {
    abortController.abort();
    if (err instanceof AggregateError) {
      // All relays failed — surface the first concrete error.
      const messages = err.errors.map(e => e.message).join('; ');
      throw new Error(`NWC all relays failed: ${messages}`);
    }
    throw err;
  }
}
