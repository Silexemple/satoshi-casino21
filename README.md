# ⚡ Lightning Casino 21

> Casino Blackjack Bitcoin multi-joueurs, déployé sur Vercel. Authentification via Lightning Network (LNAuth), dépôts et retraits en sats via **Nostr Wallet Connect (NWC)**.

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

| Paramètre | Valeur |
|-----------|--------|
| Mise min / max | 100 — 2 500 sats |
| Blackjack | Paie 2.5x |
| Dealer tire jusqu'à | 17 |
| Rake (commission) | 2% sur gains nets (min 1 sat) |

**Actions :** Hit, Stand, Double Down, Split, Insurance, Surrender

---

### 🎮 Mode Multiplayer — Tables en Direct

**3 tables permanentes :**

| Table | Mise min | Mise max | Joueurs max |
|-------|----------|----------|-------------|
| 🥉 Bronze | 100 sats | 1 000 sats | 5 |
| 🥈 Silver | 500 sats | 2 500 sats | 5 |
| 🥇 Gold | 1 000 sats | 5 000 sats | 3 |

- Tours synchronisés : 20s pour miser, 30s pour jouer
- Chat rapide + Pourboires entre joueurs (10 — 1 000 sats)

---

### 🏆 Mode Tournoi

| Tournoi | Buy-in | Jetons | Rounds | Joueurs |
|---------|--------|--------|--------|---------|
| 🎯 Freeroll | 100 sats | 1 000 | 10 | 8 max |
| ⚡ Standard | 500 sats | 5 000 | 15 | 8 max |
| 💎 High Roller | 2 000 sats | 10 000 | 20 | 6 max |

Distribution des prix automatique : 60% / 30% / 10%

---

### 💸 Économie Lightning via NWC

**Dépôts :**
- Montant : 100 — 100 000 sats
- Invoice générée directement via ton wallet NWC
- Vérification automatique du paiement (polling)
- Solde max : 1 000 000 sats

**Retraits :**
- Colle une invoice BOLT11 de ton wallet
- Paiement direct via NWC
- Rate limit : 1 retrait/min
- Débit-first + remboursement automatique si le paiement échoue

---

## Architecture

```
satoshi-casino21/
├── api/
│   ├── _helpers.js              # json(), getSessionId()...
│   ├── _game-helpers.js         # Deck, score, drawCard
│   ├── _nwc.js                  # Client NWC (NIP-47) natif — Edge compatible
│   ├── auth/
│   │   ├── generate.js          # Génère k1 + LNURL (LUD-04 étape 1)
│   │   ├── callback.js          # Vérifie signature wallet (LUD-04 étape 2)
│   │   └── status.js            # Polling auth + session cookie
│   ├── session.js
│   ├── balance.js
│   ├── game.js                  # Jeu solo
│   ├── deposit.js               # Crée invoice via NWC make_invoice
│   ├── withdraw.js              # Paie invoice via NWC pay_invoice
│   ├── transactions.js
│   ├── check-payment/[hash].js  # Vérifie paiement via NWC lookup_invoice
│   ├── table/                   # Multiplayer
│   └── tournament/              # Tournois
├── public/
│   ├── index.html
│   ├── table.html
│   └── tournament.html
└── package.json
```

---

## Déploiement

### Prérequis
- Compte [Vercel](https://vercel.com)
- Wallet Lightning avec **Nostr Wallet Connect (NWC)** : [Alby Hub](https://albyhub.com), Mutiny, ou tout wallet compatible NIP-47

### 1. Cloner et déployer

```bash
git clone https://github.com/Silexemple/satoshi-casino21.git
cd satoshi-casino21
```

Va sur [vercel.com/new](https://vercel.com/new) → importe le repo GitHub.

### 2. Vercel KV

**Storage** → **Create Database** → **KV** (les variables sont ajoutées automatiquement)

### 3. Variables d'environnement

Dans **Settings** → **Environment Variables** :

| Variable | Description | Exemple |
|----------|-------------|---------|
| `NWC_URL` | Connection string NWC de ton wallet | `nostr+walletconnect://pubkey?relay=wss://...&secret=...` |

**Obtenir ta NWC URL :**
- **Alby Hub** : Settings → Nostr Wallet Connect → New Connection → copie l'URL
- **Mutiny** : Settings → Nostr Wallet Connect → copie l'URL
- Assure-toi que les permissions `make_invoice`, `pay_invoice`, `lookup_invoice` sont activées

### 4. Redeploy

Clique **Redeploy** après avoir ajouté les variables.

### Dev local

```bash
npm install
npx vercel dev
```

---

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Hosting & API | Vercel Edge Runtime |
| Base de données | Vercel KV (Redis) |
| Auth | LNURL-auth / LUD-04 (secp256k1) |
| Lightning | NWC / NIP-47 (Nostr Wallet Connect) |
| Crypto | `@noble/secp256k1` v3, Web Crypto API, `bech32` v2 |
| Frontend | HTML/CSS/JS vanilla + Three.js |
| Sessions | Cookie httpOnly, 30 jours |

---

## Sécurité

| Mécanisme | Description |
|-----------|-------------|
| **LNAuth** | Pas de mot de passe — preuve cryptographique secp256k1 |
| **NWC natif** | Implémentation NIP-47 directe, pas de dépendance SDK externe |
| **Locks distribués** | `kv.set(lockKey, nx: true)` sur toutes les opérations sensibles |
| **Debit-first** | Les retraits débitent avant de payer, remboursement auto si échec |
| **Rate limiting** | Dépôts : 3/min — Retraits : 1/min |
| **Cookies httpOnly** | Sessions inaccessibles par JavaScript client |
| **Deck cryptographique** | Fisher-Yates avec `crypto.getRandomValues()` |

---

## Wallets NWC compatibles

| Wallet | Support NWC |
|--------|-------------|
| [Alby Hub](https://albyhub.com) | ✅ Recommandé |
| Mutiny Wallet | ✅ |
| Zeus (avec Olympus) | ✅ |
| Cashu.me | ✅ |

Tout wallet implémentant [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) est compatible.

---

## Licence

MIT
