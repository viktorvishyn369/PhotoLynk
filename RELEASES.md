# PhotoSync - Release Guide

This guide explains how to create and publish releases on GitHub for users to download.

## 📦 What to Release

### Mobile App (Android)
- `PhotoSync-v1.0.0.apk` - Signed APK for Android devices
- Location: Root directory after building

### Desktop Server Apps (GUI)
- **macOS Intel**: `PhotoSync Server-1.0.0.dmg`
- **macOS Apple Silicon**: `PhotoSync Server-1.0.0-arm64.dmg`
- **macOS Intel ZIP**: `PhotoSync Server-1.0.0-mac.zip`
- **macOS ARM ZIP**: `PhotoSync Server-1.0.0-arm64-mac.zip`
- Location: `server-app/dist/`

### Command-Line Server (for Linux servers)
- Users clone the repo and run: `cd server && node server.js`
- Or use install scripts

## 🚀 Creating a GitHub Release

### Step 1: Build All Apps

**Mobile App:**
```bash
cd mobile-v2
npx eas-cli build --platform android --profile preview --local
# Sign the APK
~/Library/Android/sdk/build-tools/36.0.0/apksigner sign \
  --ks ../photosync-release.keystore \
  --ks-key-alias photosync \
  --out ../PhotoSync-v1.0.0.apk \
  build-*.apk
```

**Desktop Server Apps:**
```bash
cd server-app
npm install
npm run build-mac    # macOS (Intel + Apple Silicon)
# For Windows/Linux, build on respective platforms or use CI/CD
```

### Step 2: Create Git Tag

```bash
git tag -a v1.0.0 -m "PhotoSync v1.0.0 - Initial Release"
git push origin v1.0.0
```

### Step 3: Create GitHub Release

1. Go to: https://github.com/viktorvishyn369/PhotoSync/releases
2. Click "Draft a new release"
3. Choose tag: `v1.0.0`
4. Release title: `PhotoSync v1.0.0`
5. Description (see template below)
6. Upload files:
   - `PhotoSync-v1.0.0.apk`
   - `PhotoSync Server-1.0.0.dmg`
   - `PhotoSync Server-1.0.0-arm64.dmg`
   - `PhotoSync Server-1.0.0-mac.zip`
   - `PhotoSync Server-1.0.0-arm64-mac.zip`
7. Click "Publish release"

## 📝 Release Description Template

```markdown
# PhotoSync v1.0.0

Self-hosted photo backup system with end-to-end encryption and device-bound security.

## 📱 Mobile App (Android)

**Download:** `PhotoSync-v1.0.0.apk` (55 MB)

- Android 5.0+ (API 21+)
- Works on all Android devices
- No Google Play Services required
- Can be sideloaded

**Installation:**
1. Download APK
2. Enable "Install from Unknown Sources" in Settings
3. Open APK file to install
4. Launch PhotoSync

## 💻 Desktop Server Apps (GUI)

### macOS

**Intel Macs:**
- Download: `PhotoSync Server-1.0.0.dmg` (99 MB)
- For: MacBook Pro, iMac, Mac Mini (pre-2020)

**Apple Silicon (M1/M2/M3):**
- Download: `PhotoSync Server-1.0.0-arm64.dmg` (92 MB)
- For: M1, M2, M3 Macs

**Installation:**
1. Download appropriate DMG for your Mac
2. Open DMG file
3. Drag PhotoSync Server to Applications
4. Launch from Applications folder
5. Allow in Security & Privacy if prompted

### Windows

**Coming Soon** - Build on Windows platform

### Linux

**Coming Soon** - Build on Linux platform or use command-line server

## 🖥️ Command-Line Server (All Platforms)

For Linux servers or advanced users:

```bash
git clone https://github.com/viktorvishyn369/PhotoSync.git
cd PhotoSync/server
npm install
node server.js
```

Or use automated install scripts:
- `install-linux.sh` - Linux Desktop (GUI)
- `install-ubuntu-server.sh` - Ubuntu Server (CLI)
- `install-macos.sh` - macOS
- `install-windows.ps1` - Windows

## ✨ Features

- ✅ Self-hosted - Your data stays on your server
- ✅ End-to-end encrypted
- ✅ Device-bound authentication
- ✅ UUID-based security
- ✅ Automatic backup
- ✅ Restore to any device
- ✅ No cloud dependencies
- ✅ Works offline (after setup)

## 📚 Documentation

- [README.md](README.md) - Main documentation
- [GLOBAL_INSTALL.md](GLOBAL_INSTALL.md) - Worldwide installation guide
- [MIGRATION.md](MIGRATION.md) - UUID migration guide
- [server/QUICK_START.md](server/QUICK_START.md) - Server quick start
- [server-app/BUILD.md](server-app/BUILD.md) - Build guide

## 🆘 Support

- GitHub Issues: https://github.com/viktorvishyn369/PhotoSync/issues
- Documentation: https://github.com/viktorvishyn369/PhotoSync

## 📋 Changelog

### v1.0.0 (Initial Release)

**Mobile App:**
- Android app with backup and restore
- Device UUID-based authentication
- Secure photo/video backup
- Restore to any device

**Server:**
- Node.js/Express backend
- SQLite database
- UUID-based folder structure
- Multi-device support
- GUI desktop apps for macOS
- Command-line server for Linux

**Security:**
- Deterministic UUID generation (email + password + hardware ID)
- Device-bound JWT tokens
- Multi-layer authentication
- Path traversal protection

**Features:**
- Accurate file counting
- Per-file error handling
- Progress tracking
- Partial success reporting
- Offline operation
```

## 🔄 Update Process

### For New Versions:

1. Update version in:
   - `mobile-v2/app.json`
   - `server-app/package.json`
   
2. Build all apps

3. Create new tag:
   ```bash
   git tag -a v1.1.0 -m "PhotoSync v1.1.0 - New Features"
   git push origin v1.1.0
   ```

4. Create GitHub release with new files

5. Update changelog in release description

## 📊 Download Statistics

GitHub automatically tracks:
- Total downloads per release
- Downloads per asset
- Download trends over time

View at: https://github.com/viktorvishyn369/PhotoSync/releases

## 🌍 Distribution

Users can download from:
1. **GitHub Releases** (primary)
2. **Direct links** to specific assets
3. **Clone repository** for source code

All downloads work globally, no geo-restrictions!

## ✅ Pre-Release Checklist

Before publishing a release:
- [ ] All apps built successfully
- [ ] APK signed and verified
- [ ] Desktop apps tested on target platforms
- [ ] Version numbers updated
- [ ] Changelog written
- [ ] Documentation updated
- [ ] Git tag created
- [ ] All files uploaded
- [ ] Release description complete
- [ ] Links tested

## 🎯 Post-Release

After publishing:
1. Test download links
2. Verify file sizes are correct
3. Test installation on clean systems
4. Monitor GitHub issues for problems
5. Update README with release link
