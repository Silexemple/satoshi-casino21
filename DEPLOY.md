# 🚀 Déploiement en Copier-Coller

## Option 1 : Script automatique (LE PLUS SIMPLE)

```bash
cd satoshi_casino_vercel
./deploy.sh
```

**C'est tout !** Le script fait tout pour toi. ✅

---

## Option 2 : Commandes manuelles (si le script bug)

### 1️⃣ Push sur GitHub

```bash
cd satoshi_casino_vercel

# Init Git
git init
git add .
git commit -m "🎰 Satoshi Casino"
git branch -M main

# REMPLACE TON_USERNAME et TON_REPO par tes vraies valeurs
git remote add origin https://github.com/TON_USERNAME/TON_REPO.git
git push -u origin main
```

**⚠️ GitHub va demander authentification :**
- Username + Personal Access Token
- OU utilise GitHub CLI : `gh auth login`

### 2️⃣ Installer Vercel CLI

```bash
npm install -g vercel
```

### 3️⃣ Déployer sur Vercel

```bash
vercel --prod
```

**La CLI va poser des questions, réponds :**
- Setup and deploy? → `YES`
- Link to existing project? → `NO`
- Project name? → `satoshi-casino` (ou ce que tu veux)
- In which directory? → `./` (appuie ENTRÉE)
- Override settings? → `NO`

### 4️⃣ Créer Vercel KV

**Va sur [vercel.com](https://vercel.com) :**
1. Ouvre ton projet
2. Storage → Create Database
3. Choisis **KV**
4. Nom : `satoshi-casino-kv`
5. Create

### 5️⃣ Ajouter les variables LNbits

**Settings → Environment Variables :**

Ajoute ces 3 variables :

| Variable | Valeur |
|----------|--------|
| `LNBITS_URL` | `https://legend.lnbits.com` |
| `LNBITS_ADMIN_KEY` | Ta clé admin LNbits |
| `LNBITS_INVOICE_KEY` | Ta clé invoice LNbits |

**Récupérer tes clés :**
→ LNbits > API (icône) > Copier les clés

### 6️⃣ Redéployer

**Deployments → ... (3 points) → Redeploy**

---

## ✅ C'est fini !

Ton casino est sur : `https://ton-projet.vercel.app`

---

## 🆘 En cas d'erreur

### "git push" ne marche pas

**Solution 1 - Personal Access Token :**
1. GitHub > Settings > Developer Settings
2. Personal Access Tokens > Tokens (classic)
3. Generate new token
4. Donne-lui accès `repo`
5. Utilise ce token comme mot de passe

**Solution 2 - GitHub CLI :**
```bash
# Installer GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh

# Se connecter
gh auth login
```

### "vercel command not found"

```bash
npm install -g vercel
```

Si ça ne marche toujours pas :
```bash
sudo npm install -g vercel
```

### Paiements ne marchent pas

Vérifie que :
1. Tu as bien créé Vercel KV
2. Les 3 variables LNbits sont ajoutées
3. Tu as redéployé après avoir ajouté les variables

---

## 💡 Astuce

**Pour mettre à jour plus tard :**

```bash
# Modifie ton code
nano public/index.html

# Commit + push
git add .
git commit -m "Update"
git push

# Vercel redéploie automatiquement !
```

Pas besoin de relancer `vercel --prod` ! 🎉
