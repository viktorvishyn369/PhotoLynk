#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Regenerate ALL Android icon assets for the PhotoLynk app
#
# Generates:
#   1. ic_launcher.png        — legacy launcher icon (pre-API 26 fallback)
#   2. ic_launcher_round.png  — legacy round launcher icon
#   3. ic_launcher_foreground.png — adaptive icon foreground (used by anydpi-v26)
#   4. ic_launcher_monochrome.png — themed/monochrome icon (Android 13+)
#   5. splashscreen_logo.png  — splash screen centered logo
#
# Android adaptive icon spec:
#   Total canvas: 108dp.  Safe zone (visible): 72dp (inner 66.67%).
#   Foreground must have ~18dp padding on each side so no content is clipped
#   when the system applies circle / squircle / rounded-rect masks.
#
# Splash screen:
#   Logo centered on dark (#121212) background with generous padding so the
#   icon floats nicely. About 40% of the drawable size is the actual logo.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer platform-specific icon, fall back to generic icon.png
if [ -f "$SCRIPT_DIR/assets/android.png" ]; then
  SOURCE_ICON="$SCRIPT_DIR/assets/android.png"
else
  SOURCE_ICON="$SCRIPT_DIR/assets/icon.png"
fi
ANDROID_RES="$SCRIPT_DIR/android/app/src/main/res"

if [ ! -f "$SOURCE_ICON" ]; then
  echo "ERROR: Source icon not found: $SOURCE_ICON"
  exit 1
fi

if ! command -v magick &>/dev/null; then
  echo "ERROR: ImageMagick 7 (magick) is required. Install with: brew install imagemagick"
  exit 1
fi

echo "=== Regenerating Android icons from $SOURCE_ICON ==="

# ── Create directories ─────────────────────────────────────────────────────
for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  mkdir -p "$ANDROID_RES/mipmap-$density"
  mkdir -p "$ANDROID_RES/drawable-$density"
done

# ── Android mipmap sizes (dp * density multiplier) ─────────────────────────
# Density:  mdpi=1x  hdpi=1.5x  xhdpi=2x  xxhdpi=3x  xxxhdpi=4x
#
# ic_launcher / ic_launcher_round:  48dp → 48, 72, 96, 144, 192 px
# ic_launcher_foreground:          108dp → 108, 162, 216, 324, 432 px
# ic_launcher_monochrome:          108dp → same as foreground
#
# splashscreen_logo (drawable-*):
#   Sized to look good centered on full screen. Using 288dp base:
#   288, 432, 576, 864, 1152 px

DENSITIES=(mdpi hdpi xhdpi xxhdpi xxxhdpi)

LAUNCHER_SIZES=(48 72 96 144 192)
FOREGROUND_SIZES=(108 162 216 324 432)
SPLASH_SIZES=(288 432 576 864 1152)

# ── Helper: generate legacy launcher icon (with padding) ───────────────────
generate_launcher() {
  local size=$1 output=$2
  # 80% of canvas = logo, 10% padding each side (safe zone for legacy icons)
  local logo_size=$(( size * 80 / 100 ))
  magick "$SOURCE_ICON" \
    -resize "${logo_size}x${logo_size}" \
    -background '#121212' \
    -gravity center \
    -extent "${size}x${size}" \
    -quality 100 \
    "$output"
}

# ── Helper: generate adaptive foreground (with 18dp safe-zone padding) ─────
generate_foreground() {
  local size=$1 output=$2
  # Adaptive foreground: logo occupies inner 66.67% (72/108), rest is transparent padding
  local logo_size=$(( size * 667 / 1000 ))
  magick "$SOURCE_ICON" \
    -resize "${logo_size}x${logo_size}" \
    -background none \
    -gravity center \
    -extent "${size}x${size}" \
    -quality 100 \
    PNG32:"$output"
}

# ── Helper: generate monochrome icon (grayscale silhouette, same padding as foreground)
generate_monochrome() {
  local size=$1 output=$2
  local logo_size=$(( size * 667 / 1000 ))
  # Convert to grayscale: the icon has a baked-in dark bg so we can't use alpha.
  # Instead, convert to grayscale and use as-is — Android applies tinting on top.
  magick "$SOURCE_ICON" \
    -resize "${logo_size}x${logo_size}" \
    -colorspace Gray \
    -background '#000000' \
    -gravity center \
    -extent "${size}x${size}" \
    -quality 100 \
    "$output"
}

# ── Helper: generate splash logo (centered on dark bg, generous padding) ───
generate_splash() {
  local size=$1 output=$2
  # Splash logo: icon is 40% of canvas for a clean, floating look
  local logo_size=$(( size * 40 / 100 ))
  magick "$SOURCE_ICON" \
    -resize "${logo_size}x${logo_size}" \
    -background '#121212' \
    -gravity center \
    -extent "${size}x${size}" \
    -quality 100 \
    "$output"
}

# ── Generate all densities ─────────────────────────────────────────────────
for i in "${!DENSITIES[@]}"; do
  d="${DENSITIES[$i]}"
  ls="${LAUNCHER_SIZES[$i]}"
  fs="${FOREGROUND_SIZES[$i]}"
  ss="${SPLASH_SIZES[$i]}"

  echo "[$d] launcher=${ls}px  foreground=${fs}px  splash=${ss}px"

  generate_launcher   "$ls" "$ANDROID_RES/mipmap-$d/ic_launcher.png"
  generate_launcher   "$ls" "$ANDROID_RES/mipmap-$d/ic_launcher_round.png"
  generate_foreground  "$fs" "$ANDROID_RES/mipmap-$d/ic_launcher_foreground.png"
  generate_monochrome  "$fs" "$ANDROID_RES/mipmap-$d/ic_launcher_monochrome.png"
  generate_splash      "$ss" "$ANDROID_RES/drawable-$d/splashscreen_logo.png"
done

# ── Expo Android assets ──────────────────────────────────────────────────
echo "Expo Android assets:"
cp "$SOURCE_ICON" "$SCRIPT_DIR/assets/adaptive-icon.png"
echo "  assets/adaptive-icon.png  (copied from $(basename "$SOURCE_ICON"))"
cp "$SOURCE_ICON" "$SCRIPT_DIR/assets/splash-icon.png"
echo "  assets/splash-icon.png  (copied from $(basename "$SOURCE_ICON"))"
magick "$SOURCE_ICON" -resize 48x48 -quality 100 "$SCRIPT_DIR/assets/favicon.png"
echo "  assets/favicon.png  48x48"

# ── Clean up WebP duplicates ───────────────────────────────────────────────
find "$ANDROID_RES" -name "ic_launcher*.webp" -delete 2>/dev/null || true

# ── Verify sizes ───────────────────────────────────────────────────────────
echo ""
echo "=== Verification ==="
for i in "${!DENSITIES[@]}"; do
  d="${DENSITIES[$i]}"
  for f in ic_launcher ic_launcher_round ic_launcher_foreground ic_launcher_monochrome; do
    p="$ANDROID_RES/mipmap-$d/$f.png"
    if [ -f "$p" ]; then
      actual=$(identify -format '%wx%h' "$p" 2>/dev/null || echo "???")
      echo "  mipmap-$d/$f.png  $actual"
    fi
  done
  sp="$ANDROID_RES/drawable-$d/splashscreen_logo.png"
  if [ -f "$sp" ]; then
    actual=$(identify -format '%wx%h' "$sp" 2>/dev/null || echo "???")
    echo "  drawable-$d/splashscreen_logo.png  $actual"
  fi
done

echo ""
echo "All Android icons regenerated successfully."
