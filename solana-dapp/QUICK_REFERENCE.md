# PhotoSync Solana dApp - Quick Reference Card

## 🚀 One-Command Build
```bash
./build-for-solana-store.sh
```

## 📱 App Details
| Property | Value |
|----------|-------|
| **Name** | PhotoSync - Solana dApp |
| **Package** | com.photosync.solana.dapp |
| **Version** | 1.0.0 (Code: 1) |
| **Category** | Utilities |
| **Min SDK** | 23 (Android 6.0) |
| **Target SDK** | 34 (Android 14) |

## 🔗 Essential Links
- **Publisher Portal**: https://publish.solanamobile.com
- **Documentation**: https://docs.solanamobile.com/dapp-publishing/intro
- **Discord**: https://discord.gg/solanamobile
- **Policy**: https://docs.solanamobile.com/dapp-publishing/publisher-policy

## 💰 Costs
- **Storage**: ~0.05-0.1 SOL (ArDrive)
- **Fees**: ~0.01 SOL (transactions)
- **Total**: ~0.1-0.2 SOL per release

## ✅ Pre-Submission Checklist
- [ ] APK built and tested
- [ ] APK signed with release key
- [ ] 4-8 screenshots ready
- [ ] App description written
- [ ] Wallet has 0.2+ SOL
- [ ] KYC completed
- [ ] Publisher profile filled

## 📋 Required Assets
1. **Icon**: 512x512 PNG (✅ in assets/)
2. **Screenshots**: 4-8 images (1080x1920)
3. **APK**: Signed and optimized
4. **Description**: Short + Full

## 🔨 Build Commands
```bash
# Install dependencies
npm install

# Clean build
cd android && ./gradlew clean

# Build release
./gradlew assembleRelease

# Sign APK
jarsigner -verbose -sigalg SHA256withRSA \
  -keystore your-key.keystore \
  app-release.apk your-alias

# Optimize
zipalign -v 4 app-release.apk final.apk

# Install for testing
adb install final.apk
```

## 📝 Submission Steps
1. Build APK → `./build-for-solana-store.sh`
2. Sign & optimize APK
3. Go to Publisher Portal
4. Add dApp details
5. Upload APK + assets
6. Submit & sign transactions
7. Wait for review (1-3 days)

## 🎯 Key Features to Highlight
- ✅ Decentralized storage
- ✅ Self-hosted option
- ✅ Device-bound security
- ✅ Smart deduplication
- ✅ Cross-platform support
- ✅ Privacy-first design

## ⚠️ Critical Reminders
- **Publisher Wallet**: Keep secure! Required for updates
- **Keystore**: Backup! Can't update without it
- **Package Name**: Can't change after submission
- **Min SOL**: Keep 0.2 SOL for updates

## 📊 Store Description Templates

### Short (80 chars)
```
Decentralized photo backup powered by Solana. Private, secure cloud storage.
```

### Tags
```
Photo Backup, Decentralized, Privacy, Cloud Storage, Solana Mobile, Self-Hosted
```

## 🐛 Common Issues

### Build Fails
```bash
cd android
./gradlew clean
./gradlew assembleRelease --stacktrace
```

### APK Won't Install
- Check signature
- Verify package name
- Uninstall old version

### Submission Rejected
- Review feedback carefully
- Check Publisher Policy
- Fix issues and resubmit

## 📞 Support Contacts
- **Technical**: Discord #dev-support
- **Policy**: Publisher Portal support
- **Community**: Stack Exchange

## 🎉 After Approval
1. Verify app in store
2. Test download
3. Monitor feedback
4. Respond to reviews
5. Plan updates

---

**Need More Info?**
- Full Guide: `SOLANA_DAPP_STORE.md`
- Checklist: `SUBMISSION_CHECKLIST.md`
- README: `README.md`

**Status**: 🟢 Ready to Submit!
