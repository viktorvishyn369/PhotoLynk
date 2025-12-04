# PhotoSync - App Versions Summary

## 📱 Two Versions Available

### 1. **mobile-v2** - Universal Android/iOS App
- **Location**: `/mobile-v2/`
- **Package**: `com.photosync.app`
- **Target**: All Android 5.0+ and iOS 13+ devices
- **Distribution**: Google Play Store, Apple App Store, or direct APK

### 2. **solana-dapp** - Solana Mobile dApp Store Version
- **Location**: `/solana-dapp/`
- **Package**: `com.photosync.solana.dapp`
- **Target**: Solana Mobile devices (Saga, Seeker) + all Android 6.0+
- **Distribution**: Solana dApp Store

## ✅ Identical Features in Both Versions

Both versions have **exactly the same functionality and UI**:

### Core Features
- ✅ Photo/Video backup to self-hosted server
- ✅ Restore files to device gallery
- ✅ Device-bound authentication (UUID + email/password)
- ✅ Hash-based duplicate prevention
- ✅ Local/Remote server configuration
- ✅ Responsive design for all screen sizes

### Settings Screen Content
Both versions include identical settings with:

1. **📖 Quick Setup Guide**
   - Step 1: Download Server from GitHub
   - Step 2: Run Server on your computer
   - Step 3: Configure & Sync

2. **💡 How It Works**
   - Explanation of self-hosted backup
   - Privacy and security benefits
   - Feature breakdown

3. **🔗 Resources**
   - GitHub Repository link
   - Server Requirements info
   - Open Source badge

4. **Server Configuration**
   - Local/Remote toggle
   - IP/Domain input
   - Port 3000 (hardcoded)

### UI/UX
- ✅ Modern dark theme
- ✅ Purple accent color (#5E35B1)
- ✅ Responsive layouts
- ✅ SafeAreaView for all devices
- ✅ KeyboardAvoidingView for forms

## 🔄 Key Differences

| Feature | mobile-v2 | solana-dapp |
|---------|-----------|-------------|
| **Package Name** | com.photosync.app | com.photosync.solana.dapp |
| **App Name** | PhotoSync | PhotoSync - Solana dApp |
| **Min SDK** | 21 (Android 5.0) | 23 (Android 6.0) |
| **Dependencies** | Standard Expo | + Solana Mobile SDK |
| **Distribution** | Play Store, App Store | Solana dApp Store |
| **Future Features** | Standard updates | + Wallet Adapter, On-chain |

## 📦 Build Commands

### mobile-v2 (Universal)
```bash
cd mobile-v2/android
./gradlew assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

### solana-dapp (Solana Store)
```bash
cd solana-dapp
./build-for-solana-store.sh
# APK: photosync-solana-v1.0.0.apk
```

## 🎯 When to Use Which Version

### Use **mobile-v2** for:
- ✅ Google Play Store submission
- ✅ Apple App Store submission
- ✅ Direct APK distribution
- ✅ Wider device compatibility (Android 5.0+)
- ✅ Standard app stores

### Use **solana-dapp** for:
- ✅ Solana dApp Store submission
- ✅ Solana Mobile ecosystem (Saga, Seeker)
- ✅ Web3-focused distribution
- ✅ Future Solana blockchain integration
- ✅ Crypto-friendly app store

## 📝 Important Notes

### Both Versions:
- Share the same codebase (App.js is identical)
- Work with the same server backend
- Have the same security model
- Provide the same user experience
- Include GitHub link and setup instructions

### To Update Both:
1. Make changes to `mobile-v2/App.js`
2. Copy to `solana-dapp/App.js`:
   ```bash
   cp mobile-v2/App.js solana-dapp/App.js
   ```
3. Build both versions

### GitHub URL:
Both versions reference the same GitHub repository. Update line 627 in both files:
```javascript
const githubUrl = 'https://github.com/viktorvishyn369/PhotoSync';
```

## 🚀 Deployment Strategy

### Recommended Approach:
1. **Develop in mobile-v2** - Test on physical devices
2. **Copy to solana-dapp** - When ready for Solana Store
3. **Submit to both stores** - Maximize reach

### Version Management:
- Keep version numbers in sync
- Update both app.json files together
- Test on both Android and iOS (for mobile-v2)
- Test on Solana devices (for solana-dapp)

## 📊 Compatibility Matrix

| Device Type | mobile-v2 | solana-dapp |
|-------------|-----------|-------------|
| Android 5.0-5.9 | ✅ | ❌ |
| Android 6.0+ | ✅ | ✅ |
| iOS 13+ | ✅ | ✅ |
| Solana Saga | ✅ | ✅ ⭐ |
| Solana Seeker | ✅ | ✅ ⭐ |
| Samsung Phones | ✅ | ✅ |
| Google Pixel | ✅ | ✅ |
| Xiaomi/Huawei | ✅ | ✅ |
| iPhone 6s+ | ✅ | ✅ |

⭐ = Optimized for this platform

## 🔗 Resources

- **Main App**: `/mobile-v2/`
- **Solana dApp**: `/solana-dapp/`
- **Server**: `/server/`
- **Solana Docs**: `solana-dapp/SOLANA_DAPP_STORE.md`
- **Submission Checklist**: `solana-dapp/SUBMISSION_CHECKLIST.md`

---

**Summary**: Both versions are functionally identical with the same features, UI, and settings. The only differences are package names and distribution channels. Choose based on your target audience and distribution strategy! 🎯
