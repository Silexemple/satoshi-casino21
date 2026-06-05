import { safeEqual } from '../_helpers.js';

export const config = { runtime: 'edge' };

// Endpoint de debug — exige le ADMIN_TOKEN. Avant: accessible publiquement
// et leakait la LONGUEUR exacte de chaque secret (ADMIN_TOKEN, NWC_URL,
// tokens KV). Connaitre la longueur d'un secret reduit drastiquement
// l'espace de recherche brute-force.
export default async function handler(req) {
  const adminToken = req.headers.get('x-admin-token');
  if (!process.env.ADMIN_TOKEN || !safeEqual(adminToken || '', process.env.ADMIN_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Non autorise' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const envKeys = [
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'KV_REST_API_READ_ONLY_TOKEN',
    'KV_URL',
    'REDIS_URL',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'NWC_URL',
    'ADMIN_TOKEN'
  ];
  const detected = {};
  for (const key of envKeys) {
    const val = process.env[key];
    detected[key] = val ? `✓ présente (${val.length} chars)` : '✗ absente';
  }
  
  return new Response(
    JSON.stringify({
      ok: true,
      version: 'v2026.05.06.17h15',
      timestamp: Date.now(),
      env_vars: detected,
      runtime: 'edge'
    }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
