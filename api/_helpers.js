import cookie from 'cookie';

export function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function getSessionId(req) {
  const cookies = cookie.parse(req.headers.get('cookie') || '');
  return cookies.session_id || null;
}
