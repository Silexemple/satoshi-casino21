import { kv } from '@vercel/kv';
import { json, getSessionId } from './_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide', auth_required: true });

  const linkingKey = await kv.get(`session:${sessionId}`);
  if (!linkingKey) return json(401, { error: 'Session invalide', auth_required: true });

  const player = await kv.get(`player:${linkingKey}`);
  if (!player) return json(404, { error: 'Joueur non trouve' });

  const txKey = `transactions:${linkingKey}`;
  const len = await kv.llen(txKey);
  // Charger les 200 dernières (pour filtres côté client 7j/30j)
  const start = Math.max(0, len - 200);
  const transactions = await kv.lrange(txKey, start, -1);

  const url = new URL(req.url);
  const format = url.searchParams.get('format');

  if (format === 'csv') {
    // Export CSV côté serveur (fallback si client ne peut pas)
    const header = 'Date,Type,Description,Montant (sats)';
    const rows = (transactions || []).map(tx => {
      const d = new Date(tx.timestamp || 0).toISOString();
      const desc = (tx.description || '').replace(/"/g, "''");
      return `"${d}","${tx.type}","${desc}",${tx.amount}`;
    });
    const csv = [header, ...rows.reverse()].join('\n');
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="sats21_transactions.csv"`
      }
    });
  }

  return json(200, {
    transactions: transactions.reverse(),
    balance: player.balance
  });
}
