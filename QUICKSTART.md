# 🚀 Guide Ultra-Rapide - Vercel

## En 5 minutes chrono

### 1️⃣ Créer compte Vercel (1 min)
- Va sur [vercel.com](https://vercel.com)
- **Sign Up** avec GitHub (gratuit)

### 2️⃣ Upload sur GitHub (2 min)
```bash
# Extraire le ZIP
unzip satoshi_casino_vercel.zip
cd satoshi_casino_vercel

# Push sur GitHub
git init
git add .
git commit -m "Casino Lightning"
git branch -M main
git remote add origin https://github.com/TON_USERNAME/satoshi-casino.git
git push -u origin main
```

### 3️⃣ Déployer (30 secondes)
- Sur Vercel : [vercel.com/new](https://vercel.com/new)
- **Import** ton repo `satoshi-casino`
- **Deploy**

### 4️⃣ Créer Vercel KV (30 secondes)
- Dans ton projet : **Storage** → **Create Database**
- Choisis **KV** → **Create**

### 5️⃣ Config LNbits (1 min)
1. LNbits > API > Copier tes clés
2. Vercel > Settings > Environment Variables
3. Ajouter :
   - `LNBITS_URL` = `https://legend.lnbits.com`
   - `LNBITS_ADMIN_KEY` = ta clé admin
   - `LNBITS_INVOICE_KEY` = ta clé invoice
4. **Redeploy**

## ✅ Fini !

Ton casino est sur : **https://ton-projet.vercel.app**

---

## 🎯 En cas de problème

**Erreur KV :**
→ Va dans Storage, crée une base KV

**Paiements ne marchent pas :**
→ Vérifie les clés LNbits dans Environment Variables

**Voir les logs :**
→ Vercel > Functions > Logs

---

**C'est tout ! 🎰⚡**
