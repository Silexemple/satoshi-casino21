# ⚡ Satoshi Casino 21

> Casino Blackjack Bitcoin multi-joueurs déployé sur Vercel Edge.  
> Authentification via **Lightning Network (LNAuth)**, paiements en sats via **Nostr Wallet Connect (NWC/NIP-47)**.  
> Zéro compte. Zéro mot de passe. Ton wallet Lightning est ton identité.

**[🎰 Jouer maintenant →](https://satoshi-casino21.vercel.app)**

---

## Sommaire

- [Modes de jeu](#-modes-de-jeu)
- [Interface & UX](#-interface--ux)
- [Économie Lightning](#-économie-lightning)
- [Sécurité](#-sécurité)
- [Architecture](#-architecture)
- [Déploiement](#-déploiement)
- [Stack technique](#-stack-technique)

---

## 🎮 Modes de jeu

### 🃏 Mode Solo — Blackjack Classique

Jeu solo contre le dealer, sans attendre d'autres joueurs.

| Règle | Valeur |
|-------|--------|
| Mise | 100 — 2 500 sats |
| Blackjack | Paie **2.5×** |
| Dealer | Tire sur soft 17 (H17) |
| Rake | 2% sur gains nets (min 1 sat) |
| Deck | 1 deck, reshuffled si vide |

**Actions disponibles :** Hit · Stand · Double Down · Split (jusqu'à 4 mains) · Insurance · Surrender  
**Toutes les variantes sont validées côté serveur** — impossible de tricher via les devtools.

---

### 🏟️ Mode Multiplayer — Tables en Direct

3 tables permanentes avec tours synchronisés en temps réel.

| Table | Mise min | Mise max | Joueurs |
|-------|----------|----------|---------|
| 🥉 Bronze | 100 sats | 1 000 sats | 5 max |
| 🥈 Silver | 500 sats | 2 500 sats | 5 max |
| 🥇 Gold | 1 000 sats | 5 000 sats | 3 max |

**Mécaniques :**
- Shoe de **6 decks** (312 cartes)
- **20 secondes** pour miser, **30 secondes** pour jouer (auto-stand si timeout)
- Leaderboard filtrable **1 jour / 7 jours / 30 jours** avec médailles 🥇🥈🥉
- Chat libre (100 chars max) avec **sanitisation XSS serveur + client**
- **Pourboires entre joueurs** : 10 — 1 000 sats, clic sur le pseudo pour ouvrir le modal

**Raccourcis clavier :**

| Touche | Action |
|--------|--------|
| `H` | Hit |
| `S` | Stand |
| `D` | Double |
| `P` | Split |
| `↵` / `Espace` | Miser |
| `R` | Re-bet (rejouer même mise) |
| `1` `2` `3` `4` | Ajouter jeton 100 / 500 / 1K / 5K |
| `Backspace` | Reset mise |
| `C` | Ouvrir/fermer le chat |

---

### 🏆 Mode Tournoi

Tournois automatiques en rotation continue — un nouveau tournoi se crée dès que le précédent se termine.

| Tournoi | Buy-in | Jetons départ | Rounds | Joueurs |
|---------|--------|---------------|--------|---------|
| 🎯 Freeroll | 100 sats | 1 000 | 10 | 8 max |
| ⚡ Standard | 500 sats | 5 000 | 15 | 8 max |
| 💎 High Roller | 2 000 sats | 10 000 | 20 | 6 max |

- Mise automatique = **10% des jetons restants** à chaque round
- Distribution des prix : **60% / 30% / 10%** — versés directement en sats sur le solde
- Remboursement automatique du buy-in si le tournoi est annulé (< joueurs min)
- Archivage des résultats 7 jours

---

## 🎨 Interface & UX

### Visuels
- **Flip 3D des cartes** — animation CSS `rotateY` avec perspective, recto/verso Bitcoin
- **Timer circulaire SVG** — anneau qui se vide, passe en rouge sous 25%
- **Chips visuels** — 52px, gradient radial, anneau pointillé, glow au hover
- **+Sats flottants** — texte qui monte après chaque résultat
- **Bitcoin Burst BJ** — canvas particles ₿ ⚡ 🔥 + triple vague confetti sur blackjack

### Animations immersives
- **Felt tremble** sur défaite (`feltShake`)
- **Flash rouge** sur toute l'interface pour les grosses pertes (≥ 500 sats)
- **Flash doré** sur blackjack
- **Flash orange** quand c'est votre tour
- **Avatars animés** : bounce sur victoire, spin 720° sur BJ, shake sur défaite

### Audio (Web Audio API — zéro fichier externe)
| Son | Déclencheur |
|-----|-------------|
| Montée mélodique 3 notes | Victoire |
| Fanfare 4 notes + punch | Blackjack |
| Descente sawtooth | Défaite |
| Bruit court | Bust |
| Clic | Distribution de carte |
| Clic aigu | Jeton ajouté |

Bouton 🔊/🔇 dans la topbar pour muter, persisté en `localStorage`.

### Thème jour/nuit
Bouton 🌙/☀️ dans la topbar. Bascule CSS variables sur `:root`, persisté en `localStorage`.

### Notifications browser
Bouton 🔔 demande la permission `Notification API`.  
Alertes OS quand l'onglet est en arrière-plan : votre tour, victoire, blackjack.  
Vibration mobile pattern `[80, 40, 80, 40, 120]` sur les moments clés.

### Autres
- **Bouton RECHARGER** dans les contrôles de table si solde insuffisant → ouvre le modal dépôt
- **Export CSV** de l'historique de transactions (filtrable 7j / 30j / tout)
- **PWA installable** : `manifest.json` — ajoute le casino à ton écran d'accueil
- **Page Admin** (`/admin.html`) : bankroll maison, tables actives, tournois, transactions récentes

---

## 💸 Économie Lightning

### Dépôts

1. Ouvre le modal **+ DÉPOSER** depuis l'accueil
2. Entre le montant (100 — 100 000 sats)
3. Scanne le QR ou colle l'invoice dans ton wallet
4. Le solde est crédité automatiquement après confirmation

| Paramètre | Valeur |
|-----------|--------|
| Min / Max | 100 — 100 000 sats |
| Solde max | 1 000 000 sats |
| Expiry invoice | 1 heure |
| Rate limit | 5 dépôts/min par IP |

### Retraits

1. Génère une invoice dans ton wallet Lightning
2. Colle-la dans **RETIRER**
3. Paiement NWC instantané, solde débité avant envoi

| Paramètre | Valeur |
|-----------|--------|
| Max retrait | 1 000 000 sats |
| Rate limit | 1 retrait/min par compte |
| Anti-replay | Invoice marquée `processed` 7 jours |

**Garantie anti double-dépense** : débit avant paiement + remboursement automatique si la transaction NWC échoue.

---

## 🔒 Sécurité

### Authentification

| Mécanisme | Détail |
|-----------|--------|
| **LNAuth (LUD-04)** | Preuve cryptographique secp256k1 — jamais de mot de passe |
| **k1 usage unique** | Challenge supprimé après la première signature valide |
| **Cookie httpOnly** | Session inaccessible par JavaScript client |
| **Cookie secure** | Transmis uniquement en HTTPS (production) |
| **TTL session** | 30 jours, refresh à chaque activité |

### Protection des données

| Vecteur | Protection |
|---------|------------|
| **Injection KV** | `paymentHash` validé `/^[a-f0-9]{64}$/i` avant toute lecture |
| **XSS chat** | Sanitisation `&lt;` `&gt;` `&quot;` côté **serveur** ET client |
| **Payload oversized** | Stats limitées à 8Ko, longueur invoice vérifiée |
| **linkingKey** | Jamais exposé dans les réponses client de `tableStateForClient` |
| **NWC URL** | pubkey, secret, et relay validés avant toute connexion WebSocket |
| **`parseInt` injection** | `Number.isInteger()` strict sur tous les montants |

### Concurrence et race conditions

| Scénario | Protection |
|----------|------------|
| **Double credit gains** | `kv.set(creditKey, nx: true)` — atomique |
| **Double retrait** | Lock `player:{linkingKey}` avec NX + EX 60s |
| **Double paiement invoice** | Clé `processed:{invoice}` écrite avant de retourner OK |
| **Actions simultanées table** | Lock `table:{id}` avec NX + EX 10s |
| **Race condition rateLimit** | `SET NX EX` atomique **avant** `INCR` (pas INCR+EXPIRE) |

### Rate limiting (IP global + par compte)

| Route | Limite IP | Limite compte |
|-------|-----------|---------------|
| `/api/auth/generate` | 10/min | — |
| `/api/deposit` | 5/min | 3/min |
| `/api/withdraw` | 5/min | 1/min |
| `/api/game` | 60/min | 60/min |
| `/api/table/*/action` | 60/min | — |
| `/api/table/*/bet` | 20/min | — |
| `/api/table/*/chat` | 15/min | 1/2s |
| `/api/admin` | 20/min | — |
| Toutes autres routes | 30/min | — |

### Headers HTTP (Vercel)

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cache-Control: no-store (routes /api/*)
```

---

## 🏗️ Architecture

```
satoshi-casino21/
├── api/
│   ├── _helpers.js              # json(), getSessionId(), rateLimit()
│   ├── _game-helpers.js         # Deck, handScore(), isSoft17, drawCard()
│   ├── _nwc.js                  # Client NWC/NIP-47 natif Edge (NIP-04 + WebSocket)
│   ├── auth/
│   │   ├── generate.js          # k1 challenge + LNURL bech32 (LUD-04 step 1)
│   │   ├── callback.js          # Vérifie signature DER→compact secp256k1 (LUD-04 step 2)
│   │   └── status.js            # Polling + Set-Cookie session httpOnly
│   ├── session.js               # GET profil + POST nickname/avatar
│   ├── balance.js               # GET solde
│   ├── game.js                  # Blackjack solo (deal/hit/stand/double/split/insurance/surrender)
│   ├── stats.js                 # Sync stats KV (limite 8Ko)
│   ├── transactions.js          # Historique + export CSV
│   ├── deposit.js               # make_invoice via NWC
│   ├── withdraw.js              # pay_invoice via NWC (debit-first + refund)
│   ├── check-payment/[hash].js  # lookup_invoice via NWC (hash validé regex)
│   ├── balance.js
│   ├── admin.js                 # Dashboard bankroll/tables (ADMIN_TOKEN + RL)
│   ├── table/
│   │   ├── list.js              # Lobby + lazy-init tables (TTL 7j)
│   │   ├── leaderboard.js       # Top 5 par période (1j/7j/30j, agrégation multi-jours)
│   │   ├── [id].js              # État table + timeout management + creditPlayers atomique
│   │   └── [id]/
│   │       ├── action.js        # hit/stand/double/split/insurance/surrender
│   │       ├── bet.js           # Mise + bankroll check + dealing trigger
│   │       ├── join.js          # Rejoindre un siège
│   │       ├── leave.js         # Quitter + remboursement si betting phase
│   │       ├── chat.js          # Message sanitisé serveur + rate limit 2s
│   │       └── tip.js           # Pourboire P2P entre joueurs
│   └── tournament/
│       ├── create.js            # Init tournois depuis templates
│       ├── list.js              # Liste + auto-start + remboursement annulation
│       ├── register.js          # Inscription + débit buy-in
│       └── play.js              # deal/hit/stand + auto-restart après fin
├── public/
│   ├── index.html               # Accueil : LNAuth, solo, dépôt/retrait, stats, transactions
│   ├── table.html               # Tables multi : 3D cards, timer SVG, chat, leaderboard
│   ├── tournament.html          # Tournois
│   ├── admin.html               # Dashboard admin
│   └── manifest.json            # PWA
├── tests/
│   ├── game-logic.test.js       # 24 tests logique blackjack (handScore, isBlackjack, etc.)
│   └── table-logic.test.js
├── vercel.json                  # maxDuration + security headers
└── package.json
```

### Modèle de données KV (Upstash Redis)

| Clé | TTL | Contenu |
|-----|-----|---------|
| `session:{uuid}` | 30j | linkingKey |
| `player:{linkingKey}` | 30j | `{balance, nickname, avatar, ...}` |
| `game_state:{sessionId}` | 1h | État partie solo |
| `table:{id}` | 7j | État table multi complet |
| `lnauth:k1:{k1}` | 10min | `{status, linkingKey}` |
| `invoice:{hash}` | 2h | `{linking_key, amount, ...}` |
| `processed:{invoice}` | 7j | Anti-replay retrait |
| `transactions:{linkingKey}` | 30j | Liste FIFO (200 max) |
| `chat:{tableId}` | 1h | 30 derniers messages |
| `leaderboard:{tableId}:{date}` | 24h | Sorted set gains |
| `lock:*` | 5-60s | Locks distribués NX |
| `ratelimit:global:{route}:{ip}` | variable | Compteur IP |
| `credited:{tableId}:{round}` | 1h | Idempotence crédit |
| `tournament:{id}` | 24h | État tournoi |
| `tournament:archive:{id}` | 7j | Résultats archivés |
| `tournaments:active` | — | Set IDs actifs |
| `house:bankroll` | — | Bankroll maison (sats) |

---

## 🚀 Déploiement

### Prérequis
- Compte [Vercel](https://vercel.com) (plan Hobby suffisant)
- Wallet Lightning avec **NWC** : [Alby Hub](https://albyhub.com), Mutiny, Zeus + Olympus, etc.

### 1. Fork et déployer

```bash
git clone https://github.com/Silexemple/satoshi-casino21.git
cd satoshi-casino21
```

Importe sur [vercel.com/new](https://vercel.com/new) → sélectionne le repo → Deploy.

### 2. Créer la base KV

**Vercel Dashboard** → **Storage** → **Create Database** → **KV**  
Les variables `KV_REST_API_URL`, `KV_REST_API_TOKEN`, etc. sont injectées automatiquement.

### 3. Variables d'environnement

**Settings** → **Environment Variables** :

| Variable | Obligatoire | Description |
|----------|-------------|-------------|
| `NWC_URL` | ✅ | String NWC de ton wallet |
| `ADMIN_TOKEN` | ✅ | Secret pour `/admin.html` |

**Format NWC_URL :**
```
nostr+walletconnect://<pubkey>?relay=wss://relay.getalby.com&secret=<secret>
```

**Obtenir la NWC_URL :**
- **Alby Hub** : Settings → Connections → New Connection → Permissions : `make_invoice` + `pay_invoice` + `lookup_invoice`
- **Mutiny** : Settings → Nostr Wallet Connect → Copy URL

### 4. Redeploy

Clique **Redeploy** dans l'onglet Deployments après avoir ajouté les variables.

### Dev local

```bash
npm install
npx vercel dev   # nécessite Vercel CLI et un projet lié
```

---

## 🧰 Stack technique

| Composant | Technologie |
|-----------|-------------|
| Hosting & API | Vercel **Edge Runtime** (Node.js Edge) |
| Base de données | Vercel KV / **Upstash Redis** |
| Auth Lightning | **LNURL-auth / LUD-04** (secp256k1 DER→compact) |
| Paiements | **NWC / NIP-47** (NIP-04 AES-CBC + Nostr events) |
| Crypto | `@noble/secp256k1` v3, **Web Crypto API**, `bech32` v2 |
| Frontend | HTML / CSS / JS **vanilla** — zéro framework |
| Sessions | Cookie `httpOnly; secure; sameSite=lax` |
| Audio | **Web Audio API** — zéro fichier externe |
| Animations | CSS 3D transforms + Canvas API (burst BJ) |

---

## 🧪 Tests

```bash
node tests/game-logic.test.js
```

**24 tests** — logique blackjack pure (handScore, isBlackjack, isPair, isSoft17, payout, deck distribution).

```
24 tests, 24 passed, 0 failed
```

---

## Wallets compatibles

### NWC (dépôts / retraits)

| Wallet | NWC |
|--------|-----|
| [Alby Hub](https://albyhub.com) | ✅ Recommandé |
| Mutiny | ✅ |
| Zeus + Olympus | ✅ |
| Cashu.me | ✅ |

Tout wallet implémentant [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) est compatible.

### LNAuth (connexion)

| Wallet | LNAuth |
|--------|--------|
| Phoenix | ✅ |
| Breez | ✅ |
| Zeus | ✅ |
| Blixt | ✅ |
| Blue Wallet | ✅ |

---

## Licence

MIT — Silexperience 2025
