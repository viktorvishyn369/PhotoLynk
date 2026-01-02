#!/bin/bash
# Master sync script - syncs all files to their respective GitHub repos

set -e

cd "$(dirname "$0")"

echo "🚀 Syncing all PhotoLynk files to GitHub..."
echo ""

# Sync public files (server-tray)
echo "📦 PUBLIC FILES (server-tray)"
./sync-to-public.sh
echo ""

# Sync private files (mobile-v2 + install script)
echo "🔒 PRIVATE FILES (mobile-v2 + install script)"
./sync-to-private.sh
echo ""

echo "✅ All files synced successfully!"
echo "   Public:  https://github.com/viktorvishyn369/PhotoLynk"
echo "   Private: https://github.com/viktorvishyn369/PhotoLynk-Mobile"
