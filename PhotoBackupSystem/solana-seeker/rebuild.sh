#!/bin/bash

# Clean build script for PhotoLynk Solana app
# Usage: ./rebuild.sh [android|ios|both]

set -e

PLATFORM=${1:-both}
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$PROJECT_DIR"

echo "🚀 Building PhotoLynk Solana App ($PLATFORM)"
echo "📁 Directory: $PROJECT_DIR"
echo ""

echo "🛑 Killing Metro bundler and related processes..."
lsof -ti:8081 | xargs kill -9 2>/dev/null || true
lsof -ti:8082 | xargs kill -9 2>/dev/null || true
lsof -ti:8083 | xargs kill -9 2>/dev/null || true
pkill -f "react-native" 2>/dev/null || true
pkill -f "metro" 2>/dev/null || true

echo "🧹 Clearing watchman..."
watchman watch-del-all 2>/dev/null || true

echo "🧹 Cleaning project..."
rm -rf /tmp/metro-* 2>/dev/null || true
rm -rf ~/.expo/cache 2>/dev/null || true

# Do NOT delete android/ios to preserve custom native modules (PixelHash)
# If you need a full regen, run: npx expo prebuild --clean

echo "📦 Installing dependencies..."
npm install --legacy-peer-deps

echo "🔧 Fixing dependency versions for SDK compatibility..."
npx expo install --fix

echo "🔧 Preserving android/ios (no prebuild). If you need full regen: npx expo prebuild --clean"

echo "🔧 Android: cleaning build cache..."
(cd android && ./gradlew clean)

echo "🔧 Android: ensuring gradle properties..."
echo "android.kotlinVersion=1.9.25" >> android/gradle.properties

if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "both" ]; then
  if [ -d "ios" ]; then
    echo "🔧 iOS: cleaning build cache..."
    (cd ios && rm -rf build Pods Podfile.lock)
    echo "🔧 iOS: running pod install..."
    (cd ios && pod install)
  else
    echo "⚠️  iOS directory not found, skipping iOS setup"
  fi
fi

if [ "$PLATFORM" = "android" ]; then
  echo "🏗️ Building Android..."
  (cd android && ./gradlew assembleDebug)
  echo "📲 Installing to Android device..."
  npx expo run:android --device
elif [ "$PLATFORM" = "ios" ]; then
  echo "🏗️ Building iOS..."
  npx expo run:ios --device --no-install
else
  echo "🏗️ Building Android..."
  (cd android && ./gradlew assembleDebug)
  echo "📲 Installing to Android device..."
  npx expo run:android --device
  echo "🏗️ Building iOS..."
  npx expo run:ios --device
fi

# Set up adb reverse for Android
if [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "both" ]; then
  echo "🔌 Setting up adb reverse..."
  adb reverse tcp:8081 tcp:8081 2>/dev/null || true
fi

echo "✅ Done! App installed."
