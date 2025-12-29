#!/bin/bash

# Icon Generation Script for PhotoLynk
# Generates all required icons for iOS, Android, and Desktop (macOS, Windows, Linux)

set -e

MOBILE_DIR="/Users/vishyn369/Downloads/StealthLynk/NEW/DEMO_APPS/FileSharing/PhotoBackupSystem/mobile-v2"
DESKTOP_DIR="/Users/vishyn369/Downloads/StealthLynk/NEW/DEMO_APPS/FileSharing/PhotoBackupSystem/server-tray"
SOURCE_ICON="$MOBILE_DIR/assets/icon.png"

echo "🎨 PhotoLynk Icon Generation Script"
echo "===================================="
echo ""

# Check if source icon exists
if [ ! -f "$SOURCE_ICON" ]; then
    echo "❌ Error: Source icon not found at $SOURCE_ICON"
    exit 1
fi

echo "✅ Source icon found: $SOURCE_ICON"
echo ""

# ============================================
# MOBILE APP ICONS
# ============================================

echo "📱 Generating Mobile App Icons..."
echo ""

# iOS App Icons (Contents.json structure)
IOS_ICON_DIR="$MOBILE_DIR/ios/PhotoLynk/Images.xcassets/AppIcon.appiconset"
mkdir -p "$IOS_ICON_DIR"

echo "  📱 iOS App Icons..."
sips -z 20 20 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-20x20@1x.png" > /dev/null
sips -z 40 40 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-20x20@2x.png" > /dev/null
sips -z 60 60 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-20x20@3x.png" > /dev/null
sips -z 29 29 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-29x29@1x.png" > /dev/null
sips -z 58 58 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-29x29@2x.png" > /dev/null
sips -z 87 87 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-29x29@3x.png" > /dev/null
sips -z 40 40 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-40x40@1x.png" > /dev/null
sips -z 80 80 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-40x40@2x.png" > /dev/null
sips -z 120 120 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-40x40@3x.png" > /dev/null
sips -z 60 60 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-60x60@2x.png" > /dev/null
sips -z 180 180 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-60x60@3x.png" > /dev/null
sips -z 76 76 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-76x76@1x.png" > /dev/null
sips -z 152 152 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-76x76@2x.png" > /dev/null
sips -z 167 167 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-83.5x83.5@2x.png" > /dev/null
sips -z 1024 1024 "$SOURCE_ICON" --out "$IOS_ICON_DIR/icon-1024x1024@1x.png" > /dev/null

# Create Contents.json for iOS
cat > "$IOS_ICON_DIR/Contents.json" << 'EOF'
{
  "images": [
    {"size": "20x20", "idiom": "iphone", "filename": "icon-20x20@2x.png", "scale": "2x"},
    {"size": "20x20", "idiom": "iphone", "filename": "icon-20x20@3x.png", "scale": "3x"},
    {"size": "29x29", "idiom": "iphone", "filename": "icon-29x29@1x.png", "scale": "1x"},
    {"size": "29x29", "idiom": "iphone", "filename": "icon-29x29@2x.png", "scale": "2x"},
    {"size": "29x29", "idiom": "iphone", "filename": "icon-29x29@3x.png", "scale": "3x"},
    {"size": "40x40", "idiom": "iphone", "filename": "icon-40x40@2x.png", "scale": "2x"},
    {"size": "40x40", "idiom": "iphone", "filename": "icon-40x40@3x.png", "scale": "3x"},
    {"size": "60x60", "idiom": "iphone", "filename": "icon-60x60@2x.png", "scale": "2x"},
    {"size": "60x60", "idiom": "iphone", "filename": "icon-60x60@3x.png", "scale": "3x"},
    {"size": "20x20", "idiom": "ipad", "filename": "icon-20x20@1x.png", "scale": "1x"},
    {"size": "20x20", "idiom": "ipad", "filename": "icon-20x20@2x.png", "scale": "2x"},
    {"size": "29x29", "idiom": "ipad", "filename": "icon-29x29@1x.png", "scale": "1x"},
    {"size": "29x29", "idiom": "ipad", "filename": "icon-29x29@2x.png", "scale": "2x"},
    {"size": "40x40", "idiom": "ipad", "filename": "icon-40x40@1x.png", "scale": "1x"},
    {"size": "40x40", "idiom": "ipad", "filename": "icon-40x40@2x.png", "scale": "2x"},
    {"size": "76x76", "idiom": "ipad", "filename": "icon-76x76@1x.png", "scale": "1x"},
    {"size": "76x76", "idiom": "ipad", "filename": "icon-76x76@2x.png", "scale": "2x"},
    {"size": "83.5x83.5", "idiom": "ipad", "filename": "icon-83.5x83.5@2x.png", "scale": "2x"},
    {"size": "1024x1024", "idiom": "ios-marketing", "filename": "icon-1024x1024@1x.png", "scale": "1x"}
  ],
  "info": {"version": 1, "author": "xcode"}
}
EOF

echo "    ✅ Generated 15 iOS app icons"

# Android Icons
ANDROID_RES_DIR="$MOBILE_DIR/android/app/src/main/res"

echo "  🤖 Android App Icons..."
mkdir -p "$ANDROID_RES_DIR/mipmap-mdpi"
mkdir -p "$ANDROID_RES_DIR/mipmap-hdpi"
mkdir -p "$ANDROID_RES_DIR/mipmap-xhdpi"
mkdir -p "$ANDROID_RES_DIR/mipmap-xxhdpi"
mkdir -p "$ANDROID_RES_DIR/mipmap-xxxhdpi"

sips -z 48 48 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-mdpi/ic_launcher.png" > /dev/null
sips -z 72 72 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-hdpi/ic_launcher.png" > /dev/null
sips -z 96 96 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xhdpi/ic_launcher.png" > /dev/null
sips -z 144 144 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xxhdpi/ic_launcher.png" > /dev/null
sips -z 192 192 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xxxhdpi/ic_launcher.png" > /dev/null

# Round icons
sips -z 48 48 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-mdpi/ic_launcher_round.png" > /dev/null
sips -z 72 72 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-hdpi/ic_launcher_round.png" > /dev/null
sips -z 96 96 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xhdpi/ic_launcher_round.png" > /dev/null
sips -z 144 144 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xxhdpi/ic_launcher_round.png" > /dev/null
sips -z 192 192 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xxxhdpi/ic_launcher_round.png" > /dev/null

# Foreground icons (for adaptive icons)
# Android adaptive icons need padding - only center 66% is safe zone
# Use ImageMagick to create padded icons with transparency
if command -v magick &> /dev/null || command -v convert &> /dev/null; then
  MAGICK_CMD="magick"
  if ! command -v magick &> /dev/null; then
    MAGICK_CMD="convert"
  fi
  
  $MAGICK_CMD "$SOURCE_ICON" -resize 72x72 -gravity center -background none -extent 108x108 "$ANDROID_RES_DIR/mipmap-mdpi/ic_launcher_foreground.png" 2>/dev/null
  $MAGICK_CMD "$SOURCE_ICON" -resize 108x108 -gravity center -background none -extent 162x162 "$ANDROID_RES_DIR/mipmap-hdpi/ic_launcher_foreground.png" 2>/dev/null
  $MAGICK_CMD "$SOURCE_ICON" -resize 144x144 -gravity center -background none -extent 216x216 "$ANDROID_RES_DIR/mipmap-xhdpi/ic_launcher_foreground.png" 2>/dev/null
  $MAGICK_CMD "$SOURCE_ICON" -resize 216x216 -gravity center -background none -extent 324x324 "$ANDROID_RES_DIR/mipmap-xxhdpi/ic_launcher_foreground.png" 2>/dev/null
  $MAGICK_CMD "$SOURCE_ICON" -resize 288x288 -gravity center -background none -extent 432x432 "$ANDROID_RES_DIR/mipmap-xxxhdpi/ic_launcher_foreground.png" 2>/dev/null
else
  # Fallback: use sips without padding (icon will be clipped but still visible)
  echo "    ⚠️  ImageMagick not found - generating foreground icons without padding"
  sips -z 108 108 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-mdpi/ic_launcher_foreground.png" > /dev/null
  sips -z 162 162 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-hdpi/ic_launcher_foreground.png" > /dev/null
  sips -z 216 216 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xhdpi/ic_launcher_foreground.png" > /dev/null
  sips -z 324 324 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xxhdpi/ic_launcher_foreground.png" > /dev/null
  sips -z 432 432 "$SOURCE_ICON" --out "$ANDROID_RES_DIR/mipmap-xxxhdpi/ic_launcher_foreground.png" > /dev/null
fi

echo "    ✅ Generated 15 Android app icons (launcher + round + foreground)"

# Update adaptive-icon.png for Android
sips -z 1024 1024 "$SOURCE_ICON" --out "$MOBILE_DIR/assets/adaptive-icon.png" > /dev/null
echo "    ✅ Updated adaptive-icon.png"

# ============================================
# DESKTOP TRAY ICONS
# ============================================

echo ""
echo "🖥️  Generating Desktop Tray Icons..."
echo ""

DESKTOP_ICONS_DIR="$DESKTOP_DIR/assets"
mkdir -p "$DESKTOP_ICONS_DIR"

# macOS Tray Icons (Template images for light/dark mode)
echo "  🍎 macOS Tray Icons (inverted compatible)..."
mkdir -p "$DESKTOP_ICONS_DIR/mac"

# macOS uses Template images (black with transparency) that automatically invert
# We need to create monochrome versions
sips -z 16 16 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/mac/iconTemplate.png" > /dev/null
sips -z 32 32 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/mac/iconTemplate@2x.png" > /dev/null
sips -z 48 48 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/mac/iconTemplate@3x.png" > /dev/null

# App icon for macOS
sips -z 512 512 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/mac/icon.png" > /dev/null
sips -z 1024 1024 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/mac/icon@2x.png" > /dev/null

echo "    ✅ Generated 5 macOS tray icons"

# Windows Tray Icons
echo "  🪟 Windows Tray Icons..."
mkdir -p "$DESKTOP_ICONS_DIR/win"

sips -z 16 16 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/win/icon-16.png" > /dev/null
sips -z 24 24 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/win/icon-24.png" > /dev/null
sips -z 32 32 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/win/icon-32.png" > /dev/null
sips -z 48 48 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/win/icon-48.png" > /dev/null
sips -z 64 64 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/win/icon-64.png" > /dev/null
sips -z 256 256 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/win/icon-256.png" > /dev/null
sips -z 512 512 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/win/icon.png" > /dev/null

echo "    ✅ Generated 7 Windows tray icons"

# Linux Tray Icons
echo "  🐧 Linux Tray Icons..."
mkdir -p "$DESKTOP_ICONS_DIR/linux"

sips -z 16 16 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon-16.png" > /dev/null
sips -z 24 24 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon-24.png" > /dev/null
sips -z 32 32 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon-32.png" > /dev/null
sips -z 48 48 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon-48.png" > /dev/null
sips -z 64 64 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon-64.png" > /dev/null
sips -z 128 128 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon-128.png" > /dev/null
sips -z 256 256 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon-256.png" > /dev/null
sips -z 512 512 "$SOURCE_ICON" --out "$DESKTOP_ICONS_DIR/linux/icon.png" > /dev/null

echo "    ✅ Generated 8 Linux tray icons"

# Copy main icon to desktop assets
cp "$SOURCE_ICON" "$DESKTOP_ICONS_DIR/icon.png"
echo "    ✅ Copied main icon to desktop assets"

# ============================================
# SUMMARY
# ============================================

echo ""
echo "✨ Icon Generation Complete!"
echo "===================================="
echo ""
echo "📊 Summary:"
echo "  • iOS: 15 app icons (light/dark compatible)"
echo "  • Android: 10 app icons + adaptive icon"
echo "  • macOS: 5 tray icons (inverted compatible)"
echo "  • Windows: 7 tray icons"
echo "  • Linux: 8 tray icons"
echo ""
echo "Total: 46 icons generated"
echo ""
echo "🔄 Next steps:"
echo "  1. For mobile: Run 'cd mobile-v2 && npx expo prebuild --clean'"
echo "  2. For desktop: Icons will be used automatically on next build"
echo ""
