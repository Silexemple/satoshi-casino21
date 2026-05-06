export const config = { runtime: 'edge' };

export default async function handler(req) {
  return new Response(
    JSON.stringify({
      ok: true,
      version: 'v2026.05.06.16h50',
      hasKvUrl: !!process.env.KV_REST_API_URL,
      hasKvToken: !!process.env.KV_REST_API_TOKEN,
      timestamp: Date.now()
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
