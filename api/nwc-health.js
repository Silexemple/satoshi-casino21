import { json, safeEqual, sendNodeResponse } from './_helpers.js';
import { nwcRequest } from './_nwc.js';

// Runtime Node.js: WebSocket sortant requis pour NWC (Edge ne le supporte pas).
// Sonde la connexion NWC du casino (le wallet Alby Hub est-il en ligne ?).
// Protégé par ADMIN_TOKEN. Utile pour le monitoring: si "ok:false", les dépôts
// échoueront en "NWC timeout".
export default async function handler(req, res) {
  let out;
  try {
    out = await impl(req);
  } catch (err) {
    out = json(500, { ok: false, error: err.message });
  }
  return sendNodeResponse(res, out);
}

async function impl(req) {
  const token = req.headers?.['x-admin-token'] || (typeof req.headers?.get === 'function' ? req.headers.get('x-admin-token') : null);
  if (!process.env.ADMIN_TOKEN || !safeEqual(token || '', process.env.ADMIN_TOKEN)) {
    return json(401, { error: 'Non autorise' });
  }
  if (!process.env.NWC_URL) {
    return json(200, { ok: false, reason: 'NWC_URL non configurée' });
  }

  const started = Date.now();
  try {
    // get_info (NIP-47) est léger et n'engage aucun paiement; timeout court.
    const info = await nwcRequest(process.env.NWC_URL, 'get_info', {}, 7000);
    return json(200, {
      ok: true,
      latency_ms: Date.now() - started,
      alias: info?.alias ?? null,
      methods: info?.methods ?? null
    });
  } catch (err) {
    return json(200, {
      ok: false,
      latency_ms: Date.now() - started,
      reason: err.message,
      hint: 'Wallet du casino probablement hors-ligne (Alby Hub) ou connexion NWC révoquée/épuisée.'
    });
  }
}
