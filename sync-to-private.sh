#!/bin/bash
# Sync private files (mobile-v2 + install script) to private GitHub repo

set -e

cd "$(dirname "$0")"

echo "🔄 Syncing private files to GitHub (PhotoLynk-Mobile)..."

# First, sync mobile-v2
cd mobile-v2

if [[ ! -z $(git status -s) ]]; then
  git add -A
  TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
  git commit -m "Auto-sync mobile: $TIMESTAMP" || echo "Nothing to commit in mobile-v2"
  git push origin master
  echo "✅ Synced mobile-v2"
else
  echo "✅ No changes in mobile-v2"
fi

cd ..

# Now sync install script to private repo
# We'll create a separate branch in the private repo for server scripts
cd mobile-v2

# Check if install-scripts branch exists
if ! git show-ref --verify --quiet refs/heads/install-scripts; then
  git checkout -b install-scripts
  git push -u origin install-scripts
  git checkout master
fi

# Switch to install-scripts branch
git checkout install-scripts

# Copy install script
cp ../install-server-PhotoLynk.sh .

if [[ ! -z $(git status -s) ]]; then
  git add install-server-PhotoLynk.sh
  TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
  git commit -m "Auto-sync install script: $TIMESTAMP" || echo "Nothing to commit"
  git push origin install-scripts
  echo "✅ Synced install-server-PhotoLynk.sh to install-scripts branch"
else
  echo "✅ No changes in install script"
fi

# Switch back to master
git checkout master

echo "✅ All private files synced to https://github.com/viktorvishyn369/PhotoLynk-Mobile"
