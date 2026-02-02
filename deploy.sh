#!/bin/bash

# ⚡ Script de déploiement automatique - Satoshi Casino Vercel
# Ce script fait TOUT : GitHub + Vercel en une seule commande

set -e

echo "🎰 Satoshi Casino - Déploiement automatique Vercel"
echo "=================================================="
echo ""

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================
# ÉTAPE 1 : Configuration
# ============================================

echo -e "${YELLOW}📋 Configuration${NC}"
echo ""

# Demander le nom du repo GitHub
read -p "Nom du repo GitHub (ex: satoshi-casino) : " REPO_NAME
if [ -z "$REPO_NAME" ]; then
    echo -e "${RED}❌ Nom du repo requis${NC}"
    exit 1
fi

# Demander le username GitHub
read -p "Ton username GitHub : " GITHUB_USER
if [ -z "$GITHUB_USER" ]; then
    echo -e "${RED}❌ Username GitHub requis${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Configuration OK${NC}"
echo ""

# ============================================
# ÉTAPE 2 : Vérifier Git
# ============================================

echo -e "${YELLOW}🔍 Vérification Git...${NC}"

if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git n'est pas installé${NC}"
    exit 1
fi

# Vérifier si déjà un repo git
if [ -d ".git" ]; then
    echo -e "${YELLOW}⚠️  Repo Git existant détecté${NC}"
    read -p "Supprimer et réinitialiser ? (y/n) : " REINIT
    if [ "$REINIT" = "y" ]; then
        rm -rf .git
        echo -e "${GREEN}✅ Repo réinitialisé${NC}"
    fi
fi

echo ""

# ============================================
# ÉTAPE 3 : Init Git et premier commit
# ============================================

echo -e "${YELLOW}📦 Initialisation Git...${NC}"

git init
git add .
git commit -m "🎰 Initial commit - Satoshi Casino"
git branch -M main

echo -e "${GREEN}✅ Commit créé${NC}"
echo ""

# ============================================
# ÉTAPE 4 : Créer le repo GitHub (si pas existe)
# ============================================

echo -e "${YELLOW}🐙 Configuration GitHub...${NC}"
echo ""
echo "📝 Tu dois maintenant créer le repo sur GitHub :"
echo "   1. Va sur https://github.com/new"
echo "   2. Nom du repo : ${REPO_NAME}"
echo "   3. NE PAS initialiser avec README/gitignore/licence"
echo "   4. Clique sur 'Create repository'"
echo ""
read -p "Appuie sur ENTRÉE quand c'est fait..."

# ============================================
# ÉTAPE 5 : Push sur GitHub
# ============================================

echo ""
echo -e "${YELLOW}⬆️  Push sur GitHub...${NC}"

REPO_URL="https://github.com/${GITHUB_USER}/${REPO_NAME}.git"

git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

echo ""
echo "🔑 GitHub va te demander de t'authentifier..."
echo "   Option 1: Username + Personal Access Token"
echo "   Option 2: GitHub CLI (gh auth login)"
echo ""

git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Code poussé sur GitHub !${NC}"
    echo "   🔗 ${REPO_URL}"
else
    echo -e "${RED}❌ Erreur lors du push${NC}"
    exit 1
fi

echo ""

# ============================================
# ÉTAPE 6 : Déploiement Vercel
# ============================================

echo -e "${YELLOW}☁️  Déploiement Vercel${NC}"
echo ""

# Vérifier si Vercel CLI est installé
if ! command -v vercel &> /dev/null; then
    echo "📦 Installation de Vercel CLI..."
    npm install -g vercel
fi

echo ""
echo "🚀 Lancement du déploiement Vercel..."
echo ""
echo "   La CLI Vercel va te demander :"
echo "   1. De te connecter (navigateur)"
echo "   2. Setup and deploy ? → YES"
echo "   3. Which scope ? → Ton compte perso"
echo "   4. Link to existing project ? → NO"
echo "   5. Project name ? → ${REPO_NAME}"
echo "   6. In which directory ? → ./"
echo "   7. Override settings ? → NO"
echo ""

vercel --prod

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Déploiement Vercel réussi !${NC}"
else
    echo -e "${RED}❌ Erreur déploiement Vercel${NC}"
    echo ""
    echo "Déploie manuellement sur https://vercel.com/new"
    exit 1
fi

echo ""

# ============================================
# ÉTAPE 7 : Configuration finale
# ============================================

echo -e "${YELLOW}⚙️  Configuration finale${NC}"
echo ""
echo "Il reste 2 choses à faire sur Vercel :"
echo ""
echo "1️⃣  Créer Vercel KV (base de données) :"
echo "   → Va sur ton projet Vercel"
echo "   → Storage → Create Database → KV"
echo "   → Nom : satoshi-casino-kv → Create"
echo ""
echo "2️⃣  Ajouter les variables LNbits :"
echo "   → Settings → Environment Variables"
echo "   → Ajoute ces 3 variables :"
echo "      • LNBITS_URL = https://legend.lnbits.com"
echo "      • LNBITS_ADMIN_KEY = ta_clé_admin"
echo "      • LNBITS_INVOICE_KEY = ta_clé_invoice"
echo "   → Save"
echo ""
echo "3️⃣  Redéployer :"
echo "   → Deployments → ... → Redeploy"
echo ""

read -p "Appuie sur ENTRÉE pour ouvrir Vercel dans le navigateur..."

# Ouvrir Vercel dans le navigateur
if command -v xdg-open &> /dev/null; then
    xdg-open "https://vercel.com/dashboard" &
elif command -v open &> /dev/null; then
    open "https://vercel.com/dashboard" &
fi

echo ""
echo -e "${GREEN}=================================================="
echo "🎉 DÉPLOIEMENT TERMINÉ !"
echo "==================================================${NC}"
echo ""
echo "📋 Récapitulatif :"
echo "   ✅ Code sur GitHub : ${REPO_URL}"
echo "   ✅ Déployé sur Vercel"
echo ""
echo "⚠️  N'oublie pas de :"
echo "   1. Créer Vercel KV"
echo "   2. Ajouter les variables LNbits"
echo "   3. Redéployer"
echo ""
echo "🎰 Ton casino sera ensuite sur : https://${REPO_NAME}.vercel.app"
echo ""
