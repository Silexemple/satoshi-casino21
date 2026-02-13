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
