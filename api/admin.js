import { kv } from '@vercel/kv';
import { json } from './_helpers.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const adminToken = req.headers.get('x-admin-token');
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return json(401, { error: 'Non autorise' });
  }

  const [bankroll, activeTables, activeTournaments] = await Promise.all([
    kv.get('house:bankroll'),
    kv.keys('table:*'),
    kv.keys('tournament:*')
  ]);

  // Get recent deposits/withdraws from last 100 transaction logs
  const recentTx = [];
  try {
    const txKeys = await kv.keys('transactions:*');
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
    const invoiceKeys = await kv.keys('invoice:*');
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
