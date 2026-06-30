#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Regenerate iOS app icon + splash screen logo from source icon
#
# Xcode 14+ single-size icon: only App-Icon-1024x1024@1x.png is needed.
# Old multi-size icon-20x20@1x.png etc. are NOT referenced by Contents.json.
#
# Splash screen logo: 3 scales (1x=200, 2x=400, 3x=600) for SplashScreenLogo.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer platform-specific icon, fall back to generic icon.png
if [ -f "$SCRIPT_DIR/assets/ios.png" ]; then
  SOURCE_ICON="$SCRIPT_DIR/assets/ios.png"
else
  SOURCE_ICON="$SCRIPT_DIR/assets/icon.png"
fi
ICON_DIR="$SCRIPT_DIR/ios/PhotoLynk/Images.xcassets/AppIcon.appiconset"
SPLASH_DIR="$SCRIPT_DIR/ios/PhotoLynk/Images.xcassets/SplashScreenLogo.imageset"

if [ ! -f "$SOURCE_ICON" ]; then
  echo "ERROR: Source icon not found: $SOURCE_ICON"
  exit 1
fi

if ! command -v magick &>/dev/null; then
  echo "ERROR: ImageMagick 7 (magick) is required. Install with: brew install imagemagick"
  exit 1
fi

echo "=== Regenerating iOS icons from $SOURCE_ICON ==="

# ── App Icon (single 1024x1024) ───────────────────────────────────────────
# Apple requires opaque icons (no alpha channel) for large app icon
echo "App icon: 1024x1024 (removing alpha channel)"
magick "$SOURCE_ICON" -resize 1024x1024 -background white -alpha remove -alpha off -quality 100 "$ICON_DIR/App-Icon-1024x1024@1x.png"

# ── Write Xcode 14+ single-icon Contents.json ───────────────────────────
cat > "$ICON_DIR/Contents.json" << 'CJSON'
{
  "images": [
    {
      "filename": "App-Icon-1024x1024@1x.png",
      "idiom": "universal",
      "platform": "ios",
      "size": "1024x1024"
    }
  ],
  "info": {
    "author": "xcode",
    "version": 1
  }
}
CJSON
echo "Contents.json: Xcode 14+ single-icon format"

# ── Remove old multi-size icons that are no longer referenced ──────────────
echo "Cleaning up unused old-style icon files..."
find "$ICON_DIR" -name "icon-*" -delete 2>/dev/null || true
rm -f "$ICON_DIR/App-Icon-1024x1024-Dark@1x.png" 2>/dev/null || true
rm -f "$ICON_DIR/App-Icon-1024x1024-Tinted@1x.png" 2>/dev/null || true

# ── Splash Screen Logo (3 scales) ─────────────────────────────────────────
echo "Splash logo: 200 / 400 / 600"
magick "$SOURCE_ICON" -resize 200x200 -quality 100 "$SPLASH_DIR/image.png"
magick "$SOURCE_ICON" -resize 400x400 -quality 100 "$SPLASH_DIR/image@2x.png"
magick "$SOURCE_ICON" -resize 600x600 -quality 100 "$SPLASH_DIR/image@3x.png"

# ── Expo assets (icon.png) ──────────────────────────────────────────────
echo "Expo assets:"
cp "$SOURCE_ICON" "$SCRIPT_DIR/assets/icon.png"
echo "  assets/icon.png  (copied from $(basename "$SOURCE_ICON"))"

# ── Verify ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Verification ==="
for f in "$ICON_DIR"/*.png; do
  [ -f "$f" ] && echo "  $(basename "$f")  $(identify -format '%wx%h' "$f" 2>/dev/null)"
done
for f in "$SPLASH_DIR"/*.png; do
  [ -f "$f" ] && echo "  $(basename "$f")  $(identify -format '%wx%h' "$f" 2>/dev/null)"
done

echo ""
echo "All iOS icons regenerated successfully."
