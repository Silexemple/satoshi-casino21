export const config = { runtime: 'edge' };

export default async function handler(req) {
  // Lister toutes les env vars qui contiennent KV, REDIS, UPSTASH (sans valeurs)
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
