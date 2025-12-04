#!/bin/bash

# PhotoSync - Solana dApp Store Build Script
# This script builds a release APK ready for Solana dApp Store submission

set -e

echo "🚀 Building PhotoSync for Solana dApp Store..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the solana-dapp directory."
    exit 1
fi

# Step 1: Install dependencies
echo "${BLUE}📦 Step 1: Installing dependencies...${NC}"
npm install
echo "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Step 2: Clean previous builds
echo "${BLUE}🧹 Step 2: Cleaning previous builds...${NC}"
cd android
./gradlew clean
echo "${GREEN}✅ Clean complete${NC}"
echo ""

# Step 3: Build release APK
echo "${BLUE}🔨 Step 3: Building release APK...${NC}"
./gradlew assembleRelease
echo "${GREEN}✅ APK built successfully${NC}"
echo ""

# Step 4: Copy APK to root
echo "${BLUE}📋 Step 4: Copying APK...${NC}"
cd ..
cp android/app/build/outputs/apk/release/app-release.apk ./photosync-solana-v1.0.0.apk
echo "${GREEN}✅ APK copied to: photosync-solana-v1.0.0.apk${NC}"
echo ""

# Get APK size
APK_SIZE=$(du -h photosync-solana-v1.0.0.apk | cut -f1)

echo "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${GREEN}✨ Build Complete!${NC}"
echo "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "📱 APK Location: ${BLUE}photosync-solana-v1.0.0.apk${NC}"
echo "📊 APK Size: ${BLUE}${APK_SIZE}${NC}"
echo ""
echo "${YELLOW}⚠️  IMPORTANT: This APK is unsigned!${NC}"
echo ""
echo "Next steps:"
echo "1. Sign the APK with your release keystore"
echo "2. Optimize with zipalign"
echo "3. Submit to Solana dApp Store Publisher Portal"
echo ""
echo "See SOLANA_DAPP_STORE.md for detailed submission instructions."
echo ""
echo "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
