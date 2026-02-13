import { kv } from '@vercel/kv';
import { json, getSessionId } from '../_helpers.js';

export const config = { runtime: 'edge' };

// Pre-defined tournament templates (auto-created)
const TEMPLATES = [
  {
    name: 'Freeroll Debutant',
    buyIn: 100,
    startingChips: 1000,
    totalRounds: 10,
    maxPlayers: 8,
    minPlayers: 3,
    startDelay: 300000 // 5min after first registration
  },
  {
    name: 'Tournoi Standard',
    buyIn: 500,
    startingChips: 5000,
    totalRounds: 15,
    maxPlayers: 8,
    minPlayers: 3,
    startDelay: 300000
  },
  {
    name: 'High Roller',
    buyIn: 2000,
    startingChips: 10000,
    totalRounds: 20,
    maxPlayers: 6,
    minPlayers: 2,
    startDelay: 300000
  }
];

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const sessionId = getSessionId(req);
  if (!sessionId) return json(401, { error: 'Session invalide' });

  // Auto-create tournaments from templates if none exist
  const activeIds = await kv.smembers('tournaments:active') || [];

  for (const template of TEMPLATES) {
    // Check if a tournament with this name already exists
    let exists = false;
    for (const id of activeIds) {
      const t = await kv.get(`tournament:${id}`);
      if (t && t.name === template.name && ['registering', 'running'].includes(t.status)) {
        exists = true;
        break;
      }
    }

    if (!exists) {
      const id = `tourney-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const tournament = {
        id,
        ...template,
        players: [],
        leaderboard: [],
        status: 'registering',
        startTime: null,
        currentRound: 0,
        createdAt: Date.now()
      };
      await kv.set(`tournament:${id}`, tournament, { ex: 86400 });
      await kv.sadd('tournaments:active', id);
    }
  }

  return json(200, { success: true });
}
