# ⚡ Lightning Casino 21

> Casino Blackjack Bitcoin multi-joueurs, déployé sur Vercel. Authentification via Lightning Network (LNAuth), dépôts et retraits en sats.

**[🎰 Jouer maintenant →](https://satoshi-casino21.vercel.app)**

---

## Fonctionnalités

### 🔐 Authentification Lightning (LNAuth)
- Connexion via **n'importe quel wallet Lightning** compatible LNAuth (Phoenix, Breez, Zeus, Blixt, etc.)
- Scan du QR code → signature cryptographique secp256k1 → session créée automatiquement
- **Aucun compte, aucun mot de passe** — ton wallet Lightning est ton identité
- Session persistante 30 jours via cookie httpOnly
- Profil permanent lié à ta clé publique Lightning (retrouve ton solde même après réinstallation du wallet)
- Nickname personnalisé (2-16 caractères) + avatar emoji

---

### 🃏 Mode Solo — Blackjack Classique

Joue seul contre la maison à tout moment.

| Paramètre | Valeur |
|-----------|--------|
| Mise min / max | 100 — 2 500 sats |
| Blackjack | Paie 2.5x |
| Dealer tire jusqu'à | 17 |
| Rake (commission) | 2% sur gains nets (min 1 sat) |

**Actions disponibles :**

| Action | Condition |
|--------|-----------|
| **Hit** | Toujours disponible |
| **Stand** | Toujours disponible |
| **Double Down** | Sur 2 premières cartes (total 9, 10 ou 11) |
| **Split** | Paire identique — jusqu'à 4 mains simultanées |
| **Insurance** | Quand le dealer montre un As — paie 2:1 |
| **Surrender** | Sur 2 premières cartes — récupère 50% de la mise |

---

### 🎮 Mode Multiplayer — Tables en Direct

Joue contre d'autres joueurs en temps réel, même deck, même dealer.

**3 tables permanentes :**

| Table | Mise min | Mise max | Joueurs max |
|-------|----------|----------|-------------|
| 🥉 Bronze | 100 sats | 1 000 sats | 5 |
| 🥈 Silver | 500 sats | 2 500 sats | 5 |
| 🥇 Gold | 1 000 sats | 5 000 sats | 3 |

**Fonctionnalités multiplayer :**
- Jusqu'à 5 joueurs simultanés autour de la même table
- Tours synchronisés : 20s pour miser, 30s pour jouer (timeout automatique = Stand)
- Hit, Stand, Double, Split disponibles
- **Chat rapide** : GL!, Nice!, Ouch!, GG, Bad Beat!, Let's Go! entre joueurs
- **Pourboires** : Envoie 10 — 1 000 sats à n'importe quel joueur à la table
- Remboursement automatique si la table se vide avant le début de la partie
- Détection des tables inactives (nettoyage après 5 min)
- **Bankroll check** : La maison refuse les mises qu'elle ne peut pas couvrir (exposition max 8x)

---

### 🏆 Mode Tournoi

Affronte d'autres joueurs sur un nombre de rounds fixé — le plus de jetons gagne.

**3 types de tournois :**

| Tournoi | Buy-in | Jetons départ | Rounds | Joueurs | Prizes |
|---------|--------|---------------|--------|---------|--------|
| 🎯 Freeroll Débutant | 100 sats | 1 000 jetons | 10 | 8 max | 60/30/10% |
| ⚡ Standard | 500 sats | 5 000 jetons | 15 | 8 max | 60/30/10% |
| 💎 High Roller | 2 000 sats | 10 000 jetons | 20 | 6 max | 60/30/10% |

**Règles tournoi :**
- Mise automatique : **10% de tes jetons actuels** à chaque round (min 10 jetons)
- Blackjack paie 2.5x, le dealer tire jusqu'à 17
- Pas d'actions avancées (double/split/insurance) — rounds rapides
- Si tu tombes à 0 jeton → **éliminé (busted)**
- Classement final par jetons restants
- **Distribution des prix automatique** : virée directement sur ton solde Lightning Casino
- Les tournois se recréent automatiquement dès qu'ils sont terminés
- Démarrage : 5 min après la première inscription, ou instantané si la table est pleine

**Distribution des prix :**
```
1 joueur  → 100% du prize pool
2 joueurs → 70% / 30%
3+ joueurs → 60% / 30% / 10%
```

---

### 💸 Économie Lightning

**Dépôts :**
- Montant : 100 — 100 000 sats
- Via invoice Lightning (LNbits)
- Vérification automatique du paiement (polling)
- Solde max : 1 000 000 sats

**Retraits :**
- Colle une invoice BOLT11 de ton wallet
- Décodage automatique du montant
- Débit-first + remboursement automatique si LNbits échoue
- Rate limit : 1 retrait/min

**Rake (commission maison) :**
- 2% sur les gains nets (min 1 sat)
- Prélevé en solo et en multiplayer
- Pas de rake en tournoi (buy-in = prize pool)

**Bankroll maison :**
- Suivi du solde de la banque (`house:bankroll`)
- Refus des mises si la maison ne peut pas payer (exposition max 8x par joueur)

---

### 🎨 Interface

- Background **Three.js** animé : particules dorées, sphères Bitcoin wireframe, éclairs
- Bordures plasma animées sur les 4 côtés
- Cartes 3D avec animations de distribution et effets hover
- **Effets sonores** : deal, victoire, défaite, blackjack
- **Confetti** sur victoires et blackjack
- Toast notifications
- Scan lines et effets shimmer
- Design responsive mobile
- Thème cohérent sur les 3 pages (solo, table, tournoi)

---

## Architecture

```
satoshi-casino21/
├── api/                              # Edge Functions (Vercel)
│   ├── _helpers.js                   # json(), getSessionId(), getLinkingKey()...
│   ├── _game-helpers.js              # Deck, score, isBlackjack, drawCard
│   ├── auth/
│   │   ├── generate.js               # Génère k1 + LNURL (LUD-04 étape 1)
│   │   ├── callback.js               # Vérifie signature wallet (LUD-04 étape 2)
│   │   └── status.js                 # Polling auth + création session cookie
│   ├── session.js                    # Vérifie session / met à jour nickname/avatar
│   ├── balance.js                    # Retourne le solde
│   ├── game.js                       # Jeu solo (deal/hit/stand/double/split/...)
│   ├── deposit.js                    # Crée invoice Lightning
│   ├── withdraw.js                   # Paie invoice BOLT11
│   ├── transactions.js               # Historique (50 dernières)
│   ├── check-payment/[hash].js       # Vérifie un paiement Lightning
│   ├── table/
│   │   ├── list.js                   # Liste des tables
│   │   ├── leaderboard.js            # Classement global
│   │   └── [id]/
│   │       ├── join.js               # Rejoindre une table
│   │       ├── leave.js              # Quitter (remboursement si avant la partie)
│   │       ├── bet.js                # Placer une mise
│   │       ├── action.js             # hit/stand/double/split/insurance/surrender
│   │       ├── chat.js               # Messages rapides
│   │       └── tip.js                # Pourboires entre joueurs
│   └── tournament/
│       ├── create.js                 # Création automatique des tournois
│       ├── list.js                   # Liste des tournois actifs
│       ├── register.js               # Inscription + débit buy-in
│       └── play.js                   # deal/hit/stand/status en tournoi
├── public/
│   ├── index.html                    # Page principale (solo + LNAuth modal)
│   ├── table.html                    # Page multiplayer
│   └── tournament.html               # Page tournoi
├── tests/
│   ├── game-logic.test.js
│   └── table-logic.test.js
└── package.json
```

---

## Flux d'authentification LNAuth (LUD-04)

```
Browser                    Serveur                    Wallet Lightning
   |                          |                              |
   |── GET /api/auth/generate ─>|                             |
   |<─ { k1, lnurl } ─────────|                             |
   |                          |                              |
   |  [affiche QR code LNURL] |                              |
   |                          |<── GET /api/auth/callback ───|
   |                          |    ?tag=login&k1=...         |
   |                          |── { tag, callback, k1 } ───>|
   |                          |                              |
   |                          |<── GET /api/auth/callback ───|
   |                          |    ?k1=...&sig=...&key=...   |
   |                          |  [verify secp256k1 sig]      |
   |                          |── { status: "OK" } ─────────>|
   |                          |                              |
   |── GET /api/auth/status ──>|                             |
   |<─ { authenticated, balance, nickname } + cookie ──────|
   |                          |                              |
```

---

## Sécurité

| Mécanisme | Description |
|-----------|-------------|
| **LNAuth** | Pas de mot de passe — preuve cryptographique secp256k1 |
| **Locks distribués** | `kv.set(lockKey, nx: true)` sur toutes les opérations sensibles |
| **Debit-first** | Les retraits débitent avant de payer, remboursement auto si échec |
| **Rate limiting** | Dépôts : 3/min — Retraits : 1/min — Chat : 1/2s — LNAuth : 10/min |
| **TTL sur toutes les clés** | Aucune donnée ne reste indéfiniment en KV |
| **Validation serveur** | Toute la logique de jeu est côté serveur |
| **Deck cryptographique** | Fisher-Yates avec `crypto.getRandomValues()` |
| **Cookies httpOnly** | Sessions inaccessibles par JavaScript client |
| **Bankroll check** | La maison refuse les mises qu'elle ne peut pas couvrir |
| **Identité persistante** | Solde lié à la clé publique du wallet, pas à une session |

---

## Données KV (Redis)

| Clé | Contenu | TTL |
|-----|---------|-----|
| `player:{linkingKey}` | Solde, nickname, avatar | 30 jours |
| `session:{sessionId}` | linkingKey associé | 30 jours |
| `lnauth:k1:{k1}` | Challenge LNAuth (pending/authenticated) | 10 min |
| `game_state:{sessionId}` | Partie solo en cours | 1 heure |
| `table:{tableId}` | État complet de la table | 24 heures |
| `tournament:{id}` | Tournoi (joueurs, rounds, statut) | 24 heures |
| `tgame:{tournamentId}:{linkingKey}` | État de jeu tournoi par joueur | 1 heure |
| `transactions:{linkingKey}` | Historique des transactions | 30 jours |
| `invoice:{hash}` | Invoice Lightning en attente | 2 heures |
| `house:bankroll` | Solde de la banque maison | Permanent |
| `lock:*` | Verrous distribués anti race-condition | 5-30 secondes |
| `chat:{tableId}` | Messages de chat | 1 heure |
| `ratelimit:*` | Compteurs rate limiting | 60 secondes |

---

## Déploiement

### Prérequis
- Compte [Vercel](https://vercel.com) (gratuit)
- Instance [LNbits](https://lnbits.com) (pour dépôts/retraits Lightning)

### 1. Fork et import

```bash
# Clone le repo
git clone https://github.com/Silexemple/satoshi-casino21.git
cd satoshi-casino21
```

Va sur [vercel.com/new](https://vercel.com/new) → importe le repo GitHub.

### 2. Vercel KV

Dans le projet Vercel : **Storage** → **Create Database** → **KV**

Les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN` sont ajoutées automatiquement.

### 3. Variables d'environnement

Dans **Settings** → **Environment Variables** :

| Variable | Description | Exemple |
|----------|-------------|---------|
| `LNBITS_URL` | URL de ton instance LNbits | `https://lnbits.example.com` |
| `LNBITS_ADMIN_KEY` | Clé Admin (retraits) | `abc123...` |
| `LNBITS_INVOICE_KEY` | Clé Invoice/read (dépôts) | `def456...` |

### 4. Redeploy

Clique **Redeploy** dans le dashboard Vercel. Le casino est live sur `https://ton-projet.vercel.app`.

### Dev local

```bash
npm install
npx vercel dev
# → http://localhost:3000
```

> En local, le QR code LNAuth pointe vers `localhost` — utilise un tunnel (ngrok) pour tester avec un vrai wallet.

---

## Limites Vercel (plan gratuit)

| Ressource | Limite |
|-----------|--------|
| Bandwidth | 100 GB/mois |
| Edge Functions | 100 GB-hrs/mois |
| KV Requests | 3 000/jour |
| KV Storage | 256 MB |

---

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Hosting & API | Vercel Edge Runtime |
| Base de données | Vercel KV (Redis) |
| Auth | LNURL-auth / LUD-04 (secp256k1) |
| Lightning | LNbits (dépôts + retraits) |
| Crypto | `@noble/secp256k1` v3, `bech32` v2 |
| Frontend | HTML/CSS/JS vanilla + Three.js |
| Sessions | Cookie httpOnly, 30 jours |

---

## Wallets compatibles LNAuth

| Wallet | Plateforme | Testé |
|--------|-----------|-------|
| Phoenix | iOS / Android | ✅ |
| Breez | iOS / Android | ✅ |
| Zeus | iOS / Android | ✅ |
| Blixt | iOS / Android | ✅ |
| BlueWallet | iOS / Android | ✅ |
| Mutiny | Web / Mobile | ✅ |
| Alby | Browser extension | ✅ |

Tout wallet implémentant [LUD-04](https://github.com/lnurl/luds/blob/legacy/lnurl-auth.md) est compatible.

---

## Licence

MIT — fais-en ce que tu veux.
