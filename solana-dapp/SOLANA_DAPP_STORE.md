# PhotoSync - Solana dApp Store Submission Guide

## Overview
PhotoSync is a decentralized photo backup application built for the Solana Mobile dApp Store. It provides secure, private, and censorship-resistant cloud storage for photos and videos.

## Key Features
- ✅ **Decentralized Storage**: Self-hosted or remote server options
- ✅ **Solana Mobile Compatible**: Built with React Native for Solana Mobile Stack
- ✅ **Secure**: Device-bound authentication with UUID binding
- ✅ **Cross-Platform**: Works on Android 6.0+ (API 23+) and iOS 13+
- ✅ **Responsive Design**: Optimized for all screen sizes including Solana Saga and Seeker

## Solana dApp Store Requirements

### 1. Technical Requirements
- ✅ **Android APK**: Release-ready, signed APK
- ✅ **Min SDK**: Android 6.0 (API 23) - Solana Mobile compatible
- ✅ **Target SDK**: Android 14 (API 34)
- ✅ **Package Name**: `com.photosync.solana.dapp`
- ✅ **Permissions**: Media access, Internet (documented in manifest)

### 2. App Metadata Required
- **App Name**: PhotoSync - Solana dApp
- **Short Description**: Decentralized photo backup powered by Solana
- **Full Description**: See below
- **Category**: Utilities / Productivity
- **Screenshots**: 4-8 screenshots (1080x1920 or 1440x2560)
- **App Icon**: 512x512 PNG (already in assets/)
- **Feature Graphic**: 1024x500 PNG (optional)

### 3. Publisher Requirements
- Solana wallet with ~0.2 SOL for:
  - Transaction fees
  - ArDrive storage costs
  - NFT minting
- KYC/KYB verification
- Publisher profile

## Building the APK

### Step 1: Install Dependencies
```bash
cd solana-dapp
npm install
```

### Step 2: Generate Android Build
```bash
# For development
npm run android

# For release APK
cd android
./gradlew assembleRelease
```

### Step 3: Sign the APK
The release APK will be at:
```
android/app/build/outputs/apk/release/app-release.apk
```

Sign it with your release keystore:
```bash
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore your-release-key.keystore \
  app-release.apk your-key-alias
```

### Step 4: Optimize with zipalign
```bash
zipalign -v 4 app-release.apk photosync-solana-v1.0.0.apk
```

## Submission Process

### 1. Publisher Portal Setup
1. Go to [https://publish.solanamobile.com](https://publish.solanamobile.com)
2. Sign up and complete KYC/KYB
3. Connect your Solana wallet (Phantom, Solflare, etc.)
4. Ensure wallet has ~0.2 SOL

### 2. Add Your dApp
1. Click "Add a dApp" > "New dApp"
2. Fill in the details:
   - **Name**: PhotoSync - Solana dApp
   - **Package**: com.photosync.solana.dapp
   - **Category**: Utilities
   - **Description**: (see below)
   - **Website**: Your server URL or GitHub
   - **Support Email**: Your email

### 3. Upload Assets
- **Icon**: 512x512 PNG (assets/icon.png)
- **Screenshots**: 4-8 images showing app features
- **Feature Graphic**: Optional banner image

### 4. Submit Release
1. Click "New Version"
2. Upload signed APK: `photosync-solana-v1.0.0.apk`
3. Add release notes
4. Submit and sign all transactions

### 5. App Review
- Automatic entry to review queue
- Goes live once approved
- Check status in Publisher Portal

## App Description (for Store Listing)

### Short Description
Decentralized photo backup powered by Solana. Secure, private, and censorship-resistant cloud storage for your memories.

### Full Description
```
PhotoSync is a revolutionary decentralized photo backup solution built for the Solana Mobile ecosystem. Take control of your data with self-hosted or remote server options, ensuring your memories are always secure and accessible.

🔐 KEY FEATURES:
• Decentralized Storage: Choose between local network or remote server
• Device-Bound Security: UUID-based authentication prevents unauthorized access
• Automatic Backup: Seamlessly sync photos and videos to your private cloud
• Easy Restore: Download and restore your media anytime, anywhere
• Duplicate Prevention: Smart hash-based deduplication saves storage space
• Cross-Platform: Works on any Android device (6.0+) and iOS (13+)
• Privacy First: Your data, your server, your control

📱 PERFECT FOR:
• Solana Saga and Seeker users
• Privacy-conscious individuals
• Anyone wanting true data ownership
• Users seeking censorship-resistant storage

🌐 HOW IT WORKS:
1. Set up your own server or use a remote one
2. Register with email and password
3. Backup photos/videos with one tap
4. Access your media from any device
5. Restore files to PhotoSync album

💎 SOLANA MOBILE OPTIMIZED:
Built specifically for the Solana Mobile Stack, PhotoSync leverages the power of decentralized technology to give you complete control over your digital memories.

No subscriptions. No data mining. Just pure, decentralized storage.
```

## Storage Cost Estimation
Use the Solana dApp Store cost calculator:
- APK size: ~15-20 MB
- Icon + Screenshots: ~5 MB
- Estimated cost: ~0.05-0.1 SOL for ArDrive storage

## Post-Submission

### Monitor Status
- Check Publisher Portal for review status
- Respond to any feedback within 48 hours
- Update app as needed

### Updates
For future updates:
1. Increment versionCode in app.json
2. Build new APK
3. Submit "New Version" in Publisher Portal
4. Use same publisher wallet

## Support & Resources
- **Solana Mobile Docs**: https://docs.solanamobile.com
- **Publisher Portal**: https://publish.solanamobile.com
- **Discord**: https://discord.gg/solanamobile
- **Stack Exchange**: https://solana.stackexchange.com

## Compliance
✅ Complies with Solana dApp Store Publisher Policy
✅ No prohibited content
✅ Proper permissions documentation
✅ Privacy policy included (if collecting data)
✅ Terms of service available

## Notes
- Keep your publisher wallet secure - it's required for all future updates
- Maintain at least 0.2 SOL in publisher wallet for updates
- Review times typically 1-3 business days
- App will appear in "Utilities" category once approved

---

**Ready to Submit?** Follow the steps above and join the Solana Mobile dApp ecosystem! 🚀
