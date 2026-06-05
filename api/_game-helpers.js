// Helpers blackjack partagés entre mode solo (game.js) et multi (table/)

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

export function createAndShuffleDeck(numDecks = 1) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const num = rank === 'A' ? 11 : (isNaN(rank) ? 10 : parseInt(rank));
        deck.push({ suit, value: rank, num });
      }
    }
  }
  const arr = new Uint32Array(deck.length);
  crypto.getRandomValues(arr);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = arr[i] % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Tire une carte du deck, reshuffle un deck frais si vide (securite)
export function drawCard(deck) {
  if (deck.length === 0) {
    const fresh = createAndShuffleDeck();
    deck.push(...fresh);
  }
  return deck.pop();
}

export function handScore(hand) {
  let score = hand.reduce((s, c) => s + c.num, 0);
  let aces = hand.filter(c => c.value === 'A').length;
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
}

export function isBlackjack(hand) {
  return hand.length === 2 && handScore(hand) === 21;
}

export function isPair(hand) {
  return hand.length === 2 && hand[0].value === hand[1].value;
}

export function cardForClient(card) {
  return { suit: card.suit, value: card.value, num: card.num };
}

// ═══ PROVABLY FAIR (commit-reveal) ═══
// Le casino s'engage AVANT la main sur serverSeedHash = sha256(serverSeed), puis
// révèle serverSeed APRÈS. Le joueur recalcule le deck depuis
// sha256(serverSeed:clientSeed:nonce) et vérifie qu'il correspond → preuve que
// le casino n'a pas changé les cartes. Le RNG reste crypto-sûr; ceci ajoute la
// VÉRIFIABILITÉ (transparence), pas juste la confiance.

// Deck ordonné, non mélangé (ordre canonique déterministe pour la vérification).
export function createOrderedDeck(numDecks = 1) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const num = rank === 'A' ? 11 : (isNaN(rank) ? 10 : parseInt(rank));
        deck.push({ suit, value: rank, num });
      }
    }
  }
  return deck;
}

export async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mélange Fisher-Yates déterministe piloté par un keystream SHA-256(seed:counter),
// avec rejection sampling → AUCUN biais modulo (chaque position uniforme).
export async function shuffleDeckProvablyFair(deck, seedHex) {
  let counter = 0;
  let pool = [];
  const nextByte = async () => {
    if (pool.length === 0) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${seedHex}:${counter++}`));
      pool = Array.from(new Uint8Array(buf));
    }
    return pool.shift();
  };
  const randInt = async (maxExclusive) => {
    if (maxExclusive <= 1) return 0;
    const limit = 256 - (256 % maxExclusive); // plus grand multiple de max ≤ 256
    let b;
    do { b = await nextByte(); } while (b >= limit);
    return b % maxExclusive;
  };
  for (let i = deck.length - 1; i > 0; i--) {
    const j = await randInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Construit le deck mélangé de façon vérifiable à partir des 3 graines.
export async function buildProvablyFairDeck({ serverSeed, clientSeed, nonce, numDecks = 1 }) {
  const seedHex = await sha256Hex(`${serverSeed}:${clientSeed}:${nonce}`);
  const deck = createOrderedDeck(numDecks);
  await shuffleDeckProvablyFair(deck, seedHex);
  return deck;
}

// Génère un serverSeed aléatoire (32 octets hex) — secret jusqu'à la révélation.
export function randomSeedHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}
