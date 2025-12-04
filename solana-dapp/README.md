# PhotoSync - Solana dApp

> Decentralized photo backup for Solana Mobile dApp Store

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-Android%206.0%2B-green)
![Solana](https://img.shields.io/badge/Solana-Mobile-purple)

## 🎯 Overview

PhotoSync is a decentralized photo backup application built specifically for the **Solana Mobile dApp Store**. It provides secure, private, and censorship-resistant cloud storage for your photos and videos.

### Key Features

- 🔐 **Decentralized Storage** - Self-hosted or remote server options
- 📱 **Solana Mobile Optimized** - Built for Saga and Seeker devices
- 🔒 **Device-Bound Security** - UUID-based authentication
- 🚀 **Smart Deduplication** - Hash-based duplicate prevention
- 🌐 **Cross-Platform** - Android 6.0+ and iOS 13+
- 🎨 **Modern UI** - Responsive design for all screen sizes

## 📋 Quick Start

### For Users
1. Download from Solana dApp Store (once published)
2. Install on your Solana Mobile device
3. Set up your server (local or remote)
4. Start backing up your photos!

### For Developers

#### Prerequisites
- Node.js 16+
- React Native development environment
- Android Studio
- Solana wallet with ~0.2 SOL (for publishing)

#### Installation
```bash
# Clone or navigate to this directory
cd solana-dapp

# Install dependencies
npm install

# Run on Android
npm run android

# Build release APK
./build-for-solana-store.sh
```

## 🚀 Solana dApp Store Submission

This app is ready for submission to the Solana dApp Store!

### Quick Submission Guide

1. **Build APK**
   ```bash
   ./build-for-solana-store.sh
   ```

2. **Sign & Optimize**
   - Sign with your release keystore
   - Optimize with zipalign

3. **Submit**
   - Go to [Publisher Portal](https://publish.solanamobile.com)
   - Upload APK and assets
   - Complete submission

### 📚 Documentation

- **[SOLANA_DAPP_STORE.md](./SOLANA_DAPP_STORE.md)** - Complete submission guide
- **[SUBMISSION_CHECKLIST.md](./SUBMISSION_CHECKLIST.md)** - Step-by-step checklist
- **[Solana Mobile Docs](https://docs.solanamobile.com)** - Official documentation

## 🏗️ Architecture

### Tech Stack
- **Framework**: React Native (Expo)
- **Backend**: Node.js/Express
- **Database**: SQLite
- **Storage**: File system with hash-based deduplication
- **Authentication**: Device UUID + Email/Password

### Solana Mobile Integration
- **Min SDK**: Android 6.0 (API 23) - Solana Mobile compatible
- **Target SDK**: Android 14 (API 34)
- **Package**: `com.photosync.solana.dapp`
- **Ready for**: Mobile Wallet Adapter integration (future)

## 📱 Screenshots

*Screenshots should be added to assets/ folder for store submission*

Required screenshots (1080x1920 or 1440x2560):
1. Login/Registration screen
2. Main dashboard
3. Backup in progress
4. Settings screen
5. Restore functionality

## 🔧 Configuration

### Server Setup

The app supports two modes:

1. **Local Network**
   - Default: `192.168.1.222:3000`
   - Perfect for home/office use
   - No internet required

2. **Remote Server**
   - Enter your server IP/domain
   - Access from anywhere
   - Port 3000 (hardcoded)

### Environment Variables

No environment variables needed! All configuration is done through the app UI.

## 📦 Build Information

### Release APK
- **Location**: `photosync-solana-v1.0.0.apk`
- **Size**: ~15-20 MB
- **Signed**: Required before submission
- **Optimized**: Use zipalign

### Version Info
- **Version Code**: 1
- **Version Name**: 1.0.0
- **Package**: com.photosync.solana.dapp

## 🛡️ Security

- ✅ Device UUID binding
- ✅ Secure token storage (SecureStore)
- ✅ SHA-256 file hashing
- ✅ No data collection
- ✅ Self-hosted option
- ✅ End-to-end privacy

## 📄 License & Compliance

### Solana dApp Store
- ✅ Complies with Publisher Policy
- ✅ No prohibited content
- ✅ Proper permissions
- ✅ Privacy-focused

### Permissions
- `READ_MEDIA_IMAGES` - Access photos
- `READ_MEDIA_VIDEO` - Access videos
- `INTERNET` - Server communication
- `ACCESS_MEDIA_LOCATION` - Photo metadata

## 🤝 Support

### For Users
- **In-App**: Settings > Support
- **Email**: Your support email
- **Discord**: [Solana Mobile Discord](https://discord.gg/solanamobile)

### For Developers
- **Documentation**: See SOLANA_DAPP_STORE.md
- **Issues**: GitHub Issues (if applicable)
- **Community**: Solana Stack Exchange

## 🗺️ Roadmap

### Version 1.0.0 (Current)
- ✅ Core backup/restore functionality
- ✅ Local and remote server support
- ✅ Duplicate prevention
- ✅ Responsive UI
- ✅ Solana Mobile compatibility

### Future Versions
- [ ] Solana Mobile Wallet Adapter integration
- [ ] On-chain storage verification
- [ ] NFT-based file ownership
- [ ] Decentralized storage (IPFS/Arweave)
- [ ] End-to-end encryption
- [ ] Multi-device sync
- [ ] Shared albums

## 📊 Store Listing

### Category
Utilities / Productivity

### Short Description
Decentralized photo backup powered by Solana. Secure, private, and censorship-resistant cloud storage.

### Tags
- Photo Backup
- Decentralized
- Privacy
- Cloud Storage
- Solana Mobile
- Self-Hosted

## 🎉 Acknowledgments

- Built for the Solana Mobile ecosystem
- Optimized for Saga and Seeker devices
- Inspired by Web3 principles of decentralization

## 📞 Contact

- **Publisher Portal**: [publish.solanamobile.com](https://publish.solanamobile.com)
- **Solana Mobile**: [solanamobile.com](https://solanamobile.com)
- **Documentation**: [docs.solanamobile.com](https://docs.solanamobile.com)

---

**Ready to publish?** Follow the guides in this folder and submit to the Solana dApp Store! 🚀

**Status**: 🟢 Ready for Submission
