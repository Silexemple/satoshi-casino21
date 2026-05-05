import { kv } from '@vercel/kv';
import { json, rateLimit } from './_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // Rate limit IP avant vérif token (anti brute-force)
  const rl = await rateLimit(req, 'admin', 20, 60);
  if (rl) return rl;

  const adminToken = req.headers.get('x-admin-token');
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return json(401, { error: 'Non autorise' });
  }

  // kv.scan() est préférable à kv.keys() en Edge runtime (non-bloquant, paginé)
  async function scanKeys(pattern) {
    const keys = [];
    let cursor = 0;
    do {
      const [nextCursor, batch] = await kv.scan(cursor, { match: pattern, count: 100 });
      keys.push(...batch);
      cursor = nextCursor;
    } while (cursor !== 0);
    return keys;
  }

  const [bankroll, tableKeys, tournamentKeys] = await Promise.all([
    kv.get('house:bankroll'),
    scanKeys('table:*').catch(() => []),
    scanKeys('tournament:*').catch(() => [])
  ]);

  const activeTables = tableKeys;
  const activeTournaments = tournamentKeys;

  // Get recent deposits/withdraws from last 100 transaction logs
  const recentTx = [];
  try {
    const txKeys = await scanKeys('transactions:*');
    const sample = txKeys.slice(0, 5);
    for (const key of sample) {
      const txs = await kv.lrange(key, -5, -1);
      if (txs) recentTx.push(...txs.map(t => ({ ...t, player: key.split(':')[1]?.slice(0, 8) })));
    }
    recentTx.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } catch (_) {}

  // Pending invoices count
  let pendingInvoices = 0;
  try {
    const invoiceKeys = await scanKeys('invoice:*');
    pendingInvoices = invoiceKeys.length;
  } catch (_) {}

  return json(200, {
    bankroll: bankroll || 0,
    activeTables: activeTables?.length || 0,
    activeTournaments: activeTournaments?.length || 0,
    pendingInvoices,
    recentTransactions: recentTx.slice(0, 20)
  });
}
