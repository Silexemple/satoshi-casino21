# ⚡ Satoshi Blackjack Casino - Vercel Edition

Casino Lightning multi-joueurs déployé sur **Vercel** (100% gratuit).

## 🎯 Pourquoi Vercel ?

- ✅ **Totalement gratuit** (pas de carte bancaire requise)
- ✅ **Déploiement en 1 clic** depuis GitHub
- ✅ **HTTPS automatique** + domaine gratuit
- ✅ **Serverless functions** (scalabilité infinie)
- ✅ **Vercel KV** (base de données Redis incluse)
- ✅ **Variables d'environnement sécurisées**

## 📦 Architecture

```
satoshi_casino_vercel/
├── api/                       # Serverless Functions (Edge Runtime)
│   ├── session.js            # Créer/récupérer session
│   ├── deposit.js            # Créer invoice Lightning
│   ├── check-payment/        
│   │   └── [hash].js         # Vérifier paiement
│   ├── withdraw.js           # Payer invoice
│   ├── game.js               # Enregistrer partie
│   └── balance.js            # Obtenir solde
├── public/
│   └── index.html            # Frontend (HTML/CSS/JS)
├── package.json              # Dépendances Node.js
├── vercel.json               # Configuration Vercel
└── README.md                 # Ce fichier
```

## 🚀 Déploiement sur Vercel (5 minutes)

### Étape 1 : Créer un compte Vercel

1. Va sur [vercel.com](https://vercel.com)
2. Clique sur **Sign Up**
3. Connecte-toi avec **GitHub** (gratuit)

### Étape 2 : Créer un repo GitHub

**Option A - Via GitHub Web :**

1. Va sur [github.com/new](https://github.com/new)
2. Nom du repo : `satoshi-casino`
3. Clique sur **Create repository**
4. Upload tous les fichiers de ce dossier

**Option B - Via Git CLI :**

```bash
cd satoshi_casino_vercel
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TON_USERNAME/satoshi-casino.git
git push -u origin main
```

### Étape 3 : Déployer sur Vercel

1. Va sur [vercel.com/new](https://vercel.com/new)
2. Clique sur **Import Project**
3. Sélectionne ton repo `satoshi-casino`
4. Clique sur **Import**

### Étape 4 : Configurer Vercel KV

**Vercel KV = Redis gratuit pour stocker les données**

1. Dans ton projet Vercel, va dans **Storage**
2. Clique sur **Create Database**
3. Sélectionne **KV** (Redis)
4. Nom : `satoshi-casino-kv`
5. Clique sur **Create**

Vercel va automatiquement ajouter les variables :
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `KV_REST_API_READ_ONLY_TOKEN`

### Étape 5 : Configurer LNbits

**A. Récupérer tes clés LNbits :**

1. Va sur ton wallet LNbits
2. Clique sur l'icône **API** (en haut à droite)
3. Copie **Invoice/read key**
4. Copie **Admin key**

**B. Ajouter les variables d'environnement :**

1. Dans ton projet Vercel, va dans **Settings** > **Environment Variables**
2. Ajoute ces 3 variables :

| Variable | Valeur | Exemple |
|----------|--------|---------|
| `LNBITS_URL` | URL de ton LNbits | `https://legend.lnbits.com` |
| `LNBITS_ADMIN_KEY` | Ta clé Admin | `a1b2c3...` |
| `LNBITS_INVOICE_KEY` | Ta clé Invoice | `x9y8z7...` |

3. Clique sur **Save**

### Étape 6 : Redéployer

1. Va dans **Deployments**
2. Clique sur les 3 points `...` du dernier déploiement
3. Clique sur **Redeploy**

**✅ C'est prêt !** Ton casino est en ligne sur : `https://ton-projet.vercel.app`

## 🔧 Personnalisation

### Changer le domaine

**Option 1 - Sous-domaine Vercel (gratuit) :**

1. Va dans **Settings** > **Domains**
2. Clique sur **Edit** à côté de ton domaine
3. Change le nom : `satoshi-casino.vercel.app`

**Option 2 - Ton propre domaine :**

1. Va dans **Settings** > **Domains**
2. Ajoute ton domaine : `casino.ton-domaine.com`
3. Suis les instructions DNS

### Modifier les limites

Dans chaque fichier API (`api/*.js`), tu peux changer :
- Mise minimale (100 sats)
- Mise maximale (1000 sats)
- Balance maximale (10000 sats)

### Changer le design

Édite `public/index.html` :
- Couleurs
- Texte
- Animations

Puis commit et push :

```bash
git add public/index.html
git commit -m "Update design"
git push
```

Vercel redéploie automatiquement ! 🚀

## 📊 Monitoring

### Voir les logs

1. Va sur ton projet Vercel
2. Clique sur **Functions**
3. Sélectionne une function
4. Onglet **Logs**

### Voir les données KV

1. Va dans **Storage** > `satoshi-casino-kv`
2. Tu peux voir toutes les clés :
   - `player:{session_id}` - Données des joueurs
   - `invoice:{hash}` - Invoices en attente
   - `transactions:{session_id}` - Historique

## 🐛 Troubleshooting

### "Error: KV_REST_API_URL is not defined"

→ Tu n'as pas créé la base Vercel KV. Retourne à l'étape 4.

### "Invoice creation failed"

→ Vérifie que tes clés LNbits sont correctes dans les variables d'environnement.

### "Session not found"

→ Les cookies ne fonctionnent pas. Vérifie que tu es sur `https://` et pas `http://`.

### Les paiements ne sont pas détectés

→ Vérifie que ta clé **Invoice/read** est correcte.

## 🔐 Sécurité

✅ **Déjà implémenté :**
- Clés API stockées dans variables d'env Vercel (jamais exposées)
- Edge Runtime (ultra rapide et sécurisé)
- Cookies httpOnly pour les sessions
- Validation côté serveur

✅ **Gratuit inclus dans Vercel :**
- HTTPS automatique
- DDoS protection
- Rate limiting (100 requêtes/minute par IP)
- Logs et monitoring

## 📈 Limites gratuites Vercel

**Tu es largement dans les clous :**

| Ressource | Limite gratuite | Ton usage estimé |
|-----------|----------------|------------------|
| Bandwidth | 100 GB/mois | ~1-5 GB |
| Functions | 100 GB-hrs | ~5-10 GB-hrs |
| KV Requests | 3,000/jour | ~500-1000 |
| KV Storage | 256 MB | ~1-10 MB |

**Conclusion :** Plusieurs milliers de joueurs peuvent jouer gratuitement !

## 🎮 Test local (optionnel)

Si tu veux tester en local avant de déployer :

```bash
# Installer les dépendances
npm install

# Installer Vercel CLI
npm install -g vercel

# Créer .env local
cp .env.example .env
nano .env  # Ajouter tes clés

# Lancer en dev
vercel dev
```

Ouvre http://localhost:3000

## 🆕 Mettre à jour

Après avoir modifié le code :

```bash
git add .
git commit -m "Update feature"
git push
```

Vercel redéploie automatiquement en ~30 secondes ! 🚀

## ⚡ Fonctionnalités

- ✅ Multi-joueurs simultanés
- ✅ Sessions persistantes (30 jours)
- ✅ Paiements Lightning instantanés
- ✅ Dépôt : 100-10000 sats
- ✅ Blackjack truqué (RTP 45%)
- ✅ Retrait Lightning
- ✅ Responsive mobile

## 🎯 Prochaines étapes

Après déploiement, tu peux ajouter :

1. **Stats page** - Créer `/api/stats.js` pour afficher les stats globales
2. **Leaderboard** - Top des joueurs
3. **Multi-tables** - Plusieurs tables en parallèle
4. **Bonus** - Missions quotidiennes

## 📞 Support

Des questions ? Regarde les logs Vercel ou teste en local avec `vercel dev`.

---

**🎰 Enjoy ton casino Lightning sur Vercel !**

*Coût total : 0€ pour toujours* 💰
