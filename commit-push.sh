#!/bin/bash

# Interactive commit and push script for PhotoBackupSystem
# Excludes: mobile-v2/ and install-server-PhotoLynk.sh

set -e

echo "=========================================="
echo "  PhotoLynk Commit & Push Script"
echo "=========================================="
echo ""

# Show current status (excluding mobile-v2 and install script)
echo "📋 Changed files (excluding mobile-v2 and install-server-PhotoLynk.sh):"
echo ""
git status --short | grep -v "^.. mobile-v2/" | grep -v "install-server-PhotoLynk.sh" || echo "  (no changes)"
echo ""

# Check if there are any changes to commit
CHANGES=$(git status --short | grep -v "^.. mobile-v2/" | grep -v "install-server-PhotoLynk.sh" | grep -v "^??" || true)
if [ -z "$CHANGES" ]; then
    echo "❌ No tracked changes to commit (excluding mobile-v2 and install script)"
    exit 0
fi

# Show diff summary
echo "📝 Changes summary:"
git diff --stat -- . ':!mobile-v2' ':!install-server-PhotoLynk.sh' 2>/dev/null || true
echo ""

# Ask for commit message
echo "Enter commit message (or 'q' to quit):"
read -r COMMIT_MSG

if [ "$COMMIT_MSG" = "q" ] || [ -z "$COMMIT_MSG" ]; then
    echo "❌ Aborted"
    exit 0
fi

# Stage all changes except excluded paths
echo ""
echo "📦 Staging changes..."
git add --all -- . ':!mobile-v2' ':!install-server-PhotoLynk.sh'

# Show what will be committed
echo ""
echo "📋 Files to be committed:"
git diff --cached --name-only
echo ""

# Confirm
echo "Proceed with commit and push? (y/n)"
read -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "❌ Aborted - unstaging changes"
    git reset HEAD -- . 2>/dev/null || true
    exit 0
fi

# Commit
echo ""
echo "💾 Committing..."
git commit -m "$COMMIT_MSG"

# Push
echo ""
echo "🚀 Pushing to origin..."
git push origin main

echo ""
echo "✅ Done! Changes committed and pushed."

# Ask about building a release
echo ""
echo "=========================================="
echo "  Build Release?"
echo "=========================================="
echo ""
echo "Want to create a tagged release and build for all platforms? (y/n)"
read -r BUILD_CONFIRM

if [ "$BUILD_CONFIRM" != "y" ] && [ "$BUILD_CONFIRM" != "Y" ]; then
    echo "👋 Skipping build. Goodbye!"
    exit 0
fi

# Get current tags for reference
echo ""
echo "📋 Recent tags:"
git tag --sort=-creatordate | head -5 || echo "  (no tags)"
echo ""

# Ask for tag version
echo "Enter new tag version (e.g., v1.1.2):"
read -r TAG_VERSION

if [ -z "$TAG_VERSION" ]; then
    echo "❌ No tag provided. Aborted."
    exit 0
fi

# Check if tag already exists
if git rev-parse "$TAG_VERSION" >/dev/null 2>&1; then
    echo "❌ Tag $TAG_VERSION already exists. Aborted."
    exit 1
fi

# Ask for tag message/release notes
echo ""
echo "Enter tag message (release notes):"
read -r TAG_MSG

if [ -z "$TAG_MSG" ]; then
    TAG_MSG="Release $TAG_VERSION"
fi

# Create and push tag
echo ""
echo "🏷️  Creating tag $TAG_VERSION..."
git tag -a "$TAG_VERSION" -m "$TAG_MSG"

echo "🚀 Pushing tag to trigger build..."
git push origin "$TAG_VERSION"

echo ""
echo "✅ Tag $TAG_VERSION pushed!"
echo "🔨 GitHub Actions will now build releases for all platforms."
echo ""
echo "📦 Check build status at:"
echo "   https://github.com/viktorvishyn369/PhotoLynk/actions"
echo ""
echo "📥 Releases will appear at:"
echo "   https://github.com/viktorvishyn369/PhotoLynk/releases"
