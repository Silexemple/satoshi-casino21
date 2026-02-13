import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = { runtime: 'edge' };

const DEFAULT_TABLES = [
  { id: 'table-1', name: 'Table Bronze', minBet: 100, maxBet: 1000, maxPlayers: 5 },
  { id: 'table-2', name: 'Table Silver', minBet: 500, maxBet: 2500, maxPlayers: 5 },
  { id: 'table-3', name: 'Table Gold', minBet: 1000, maxBet: 5000, maxPlayers: 3 },
];

function createEmptyTable(def) {
  return {
    id: def.id,
    name: def.name,
    minBet: def.minBet,
    maxBet: def.maxBet,
    maxPlayers: def.maxPlayers,
    status: 'waiting',
    deck: [],
    dealerHand: [],
    seats: Array(def.maxPlayers).fill(null),
    currentSeatIdx: -1,
    roundNumber: 0,
    bettingStartedAt: null,
    turnStartedAt: null,
    lastUpdate: Date.now()
  };
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const sessionId = getSessionId(req);
  if (!sessionId) {
    return json(401, { error: 'Session invalide' });
  }

  // Lazy init: créer les tables si elles n'existent pas
  const tables = [];
  for (const def of DEFAULT_TABLES) {
    let table = await kv.get(`table:${def.id}`);
    if (!table) {
      table = createEmptyTable(def);
      await kv.set(`table:${def.id}`, table, { ex: 86400 }); // 24h TTL
    }

    const playerCount = table.seats.filter(s => s !== null).length;
    tables.push({
      id: table.id,
      name: table.name,
      minBet: table.minBet,
      maxBet: table.maxBet,
      maxPlayers: table.maxPlayers,
      playerCount,
      status: table.status
    });
  }

  return json(200, { tables });
}
