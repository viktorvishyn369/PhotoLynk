#!/bin/bash
# Sync public files (server-tray) to public GitHub repo

set -e

cd "$(dirname "$0")"

echo "🔄 Syncing public files to GitHub (PhotoLynk)..."

# Navigate to server-tray
cd server-tray

# Check if there are changes
if [[ -z $(git status -s) ]]; then
  echo "✅ No changes to sync in server-tray"
  exit 0
fi

# Stage all changes
git add -A

# Commit with timestamp
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
git commit -m "Auto-sync: $TIMESTAMP" || echo "Nothing to commit"

# Push to public repo
git push origin main

echo "✅ Synced to https://github.com/viktorvishyn369/PhotoLynk (public)"
