# Satoshi Blackjack Casino - Vercel Edition

Casino Blackjack Lightning multi-joueurs deploye sur **Vercel** (100% gratuit).

## Fonctionnalites

### Mode Solo (Blackjack classique)
- Blackjack complet : Hit, Stand, Double (9-11), Split (jusqu'a 4 mains)
- **Assurance** : Proposee quand le dealer montre un As, paie 2:1
- **Surrender** : Abandonner sur les 2 premieres cartes, recuperer 50% de la mise
- Dealer tire jusqu'a 17, Blackjack paie 2.5x
- Mise : 100 - 2500 sats

### Mode Multiplayer (Tables)
- 3 tables predefinies : Bronze (100-1000), Silver (500-2500), Gold (1000-5000)
- Jusqu'a 5 joueurs simultanes par table
- Systeme de tours avec timeouts (20s pour miser, 30s par tour)
- Hit, Stand, Double, Split en multiplayer
- Detection automatique des tables inactives (5 min)
- **Chat predetermine** : Messages rapides entre joueurs (GL!, Nice!, GG, etc.)
- **Pourboires** : Envoyer 10-1000 sats a un autre joueur a la table
- **Bankroll maison** : Verification d'exposition maximale avant d'accepter les mises

### Mode Tournoi
- 3 types : Freeroll (100 sats), Standard (500 sats), High Roller (2000 sats)
- Inscription avec buy-in, jetons de depart dedies
- Rounds fixes avec mise automatique (10% des jetons)
- Classement par jetons restants a la fin
- Distribution des prix : 1er 60%, 2eme 30%, 3eme 10%
- Lobby avec countdown, polling temps reel, statut en direct
- Creation automatique des tournois si aucun n'existe

### Systeme economique
- **Rake/Commission** : 2% preleve sur les gains nets (min 1 sat), applique en solo et en multiplayer
- **Bankroll maison** : Suivi du solde de la banque, refus des mises si exposition trop elevee
- **Depots Lightning** : 100 - 100,000 sats via LNbits
- **Retraits Lightning** : Decodage BOLT11, debit-first avec refund automatique en cas d'echec
- **Historique des transactions** : Dernieres 50 transactions consultables

### Joueurs
- **Pseudos personnalises** : Chaque joueur peut choisir son nickname
- Sessions persistantes 30 jours via cookies httpOnly
- Solde max : 1,000,000 sats

### Interface
- Background Three.js anime (particules, spheres Bitcoin wireframe, eclairs)
- Bordures plasma animees (4 cotes)
- Cartes 3D avec animations de distribution et hover
- Effets sonores : deal, victoire, defaite, blackjack
- Confetti sur victoires et blackjack
- Toast notifications
- Scan lines et shimmer effects
- Design responsive mobile
- Theme coherent sur les 3 pages (solo, table, tournoi)

## Architecture

```
satoshi-casino21/
├── api/                            # Serverless Functions (Edge Runtime)
│   ├── _helpers.js                 # Helpers partages (json, getSessionId)
│   ├── _game-helpers.js            # Logique blackjack (deck, score, BJ)
│   ├── session.js                  # Creation/recuperation session + nickname
│   ├── balance.js                  # Obtenir solde
│   ├── game.js                     # Jeu solo (deal/hit/stand/double/split/insurance/surrender)
│   ├── deposit.js                  # Creer invoice Lightning (depot)
│   ├── withdraw.js                 # Payer invoice Lightning (retrait)
│   ├── transactions.js             # Historique des transactions
│   ├── check-payment/
│   │   └── [hash].js               # Verifier paiement Lightning
│   ├── table/
│   │   ├── list.js                 # Liste des tables multiplayer
│   │   ├── [id].js                 # Etat de la table (GET) + gestion timeouts
│   │   └── [id]/
│   │       ├── join.js             # Rejoindre une table
│   │       ├── leave.js            # Quitter une table (avec remboursement)
│   │       ├── bet.js              # Placer une mise
│   │       ├── action.js           # Actions de jeu (hit/stand/double/split)
│   │       ├── chat.js             # Chat predetermine
│   │       └── tip.js              # Pourboires entre joueurs
│   └── tournament/
│       ├── create.js               # Creation automatique des tournois
│       ├── list.js                 # Liste des tournois actifs
│       ├── register.js             # Inscription (buy-in)
│       └── play.js                 # Jeu en tournoi (deal/hit/stand/status)
├── public/
│   ├── index.html                  # Page principale (solo + navigation)
│   ├── table.html                  # Page multiplayer
│   └── tournament.html             # Page tournoi
├── package.json
├── vercel.json
└── README.md
```

## Securite et fiabilite

- **Locks distribues** : Toutes les operations sensibles (mises, actions, retraits, tips) utilisent `kv.set(lockKey, nx: true)` pour eviter les race conditions
- **Idempotence** : Les retraits et credits de depots sont proteges contre les doubles executions
- **Debit-first** : Les retraits debitent d'abord, puis remboursent automatiquement si LNbits echoue
- **Rate limiting** : 60 actions/min en solo, 1 retrait/min, 1 message chat/2s
- **TTL sur toutes les cles** : Player (30j), game state (1h), tables (24h), transactions (30j), invoices (2h)
- **Validation serveur** : Toute la logique de jeu est cote serveur, le client n'envoie que des actions
- **Deck cryptographique** : Fisher-Yates shuffle avec `crypto.getRandomValues()`
- **Cookies httpOnly** : Sessions non accessibles par JavaScript client
- **Bankroll check** : La maison refuse les mises qu'elle ne peut pas couvrir (exposition max 8x par joueur)

## Deploiement sur Vercel

### 1. Compte Vercel
1. Va sur [vercel.com](https://vercel.com)
2. Connecte-toi avec **GitHub**

### 2. Import du repo
1. Va sur [vercel.com/new](https://vercel.com/new)
2. Importe le repo `satoshi-casino21`

### 3. Configurer Vercel KV
1. Dans le projet Vercel > **Storage** > **Create Database** > **KV**
2. Les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN` sont ajoutees automatiquement

### 4. Configurer LNbits
Ajouter dans **Settings** > **Environment Variables** :

| Variable | Description |
|----------|-------------|
| `LNBITS_URL` | URL de ton instance LNbits |
| `LNBITS_ADMIN_KEY` | Cle Admin (pour les retraits) |
| `LNBITS_INVOICE_KEY` | Cle Invoice/read (pour les depots) |

### 5. Redeploy
Le casino est accessible sur `https://ton-projet.vercel.app`

## Donnees KV (Redis)

| Cle | Description | TTL |
|-----|-------------|-----|
| `player:{sessionId}` | Solde, nickname, activite | 30 jours |
| `game_state:{sessionId}` | Partie solo en cours | 1 heure |
| `table:{tableId}` | Etat complet de la table | 24 heures |
| `tournament:{id}` | Tournoi (joueurs, rounds, statut) | 24 heures |
| `transactions:{sessionId}` | Historique des transactions | 30 jours |
| `invoice:{hash}` | Invoice Lightning en attente | 2 heures |
| `house:bankroll` | Solde de la banque | Permanent |
| `lock:*` | Verrous distribues | 5-30 secondes |
| `chat:{tableId}` | Messages de chat | 1 heure |

## Test local

```bash
npm install
npm install -g vercel
vercel dev
```

Ouvre http://localhost:3000

## Limites gratuites Vercel

| Ressource | Limite gratuite |
|-----------|----------------|
| Bandwidth | 100 GB/mois |
| Functions | 100 GB-hrs |
| KV Requests | 3,000/jour |
| KV Storage | 256 MB |
