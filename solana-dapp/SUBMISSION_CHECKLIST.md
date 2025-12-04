# Solana dApp Store Submission Checklist

## Pre-Submission Checklist

### ✅ Technical Requirements
- [ ] APK built and tested on physical device
- [ ] APK signed with release keystore
- [ ] APK optimized with zipalign
- [ ] App works on Android 6.0+ (API 23+)
- [ ] App works on Solana Saga/Seeker devices
- [ ] No crashes or critical bugs
- [ ] All permissions properly documented
- [ ] Package name: `com.photosync.solana.dapp`
- [ ] Version code: 1
- [ ] Version name: 1.0.0

### ✅ Assets Prepared
- [ ] App icon (512x512 PNG) - in assets/icon.png
- [ ] Screenshots (4-8 images, 1080x1920 or 1440x2560)
  - [ ] Login screen
  - [ ] Main dashboard
  - [ ] Backup in progress
  - [ ] Settings screen
  - [ ] Restore functionality
- [ ] Feature graphic (1024x500 PNG) - optional
- [ ] App description written (short & full)
- [ ] Release notes prepared

### ✅ Publisher Account Setup
- [ ] Signed up at https://publish.solanamobile.com
- [ ] KYC/KYB verification completed
- [ ] Solana wallet connected (Phantom/Solflare/Backpack)
- [ ] Wallet has at least 0.2 SOL
- [ ] Publisher profile filled out
- [ ] Support email configured

### ✅ Legal & Compliance
- [ ] Reviewed Solana dApp Store Publisher Policy
- [ ] Reviewed Developer Agreement
- [ ] Privacy policy prepared (if collecting user data)
- [ ] Terms of service prepared
- [ ] App complies with all policies
- [ ] No prohibited content

### ✅ App Metadata
- [ ] App name: PhotoSync - Solana dApp
- [ ] Short description (80 chars max)
- [ ] Full description (4000 chars max)
- [ ] Category selected: Utilities
- [ ] Website/GitHub URL
- [ ] Support email
- [ ] Contact information

## Submission Steps

### Step 1: Build APK ✅
```bash
cd solana-dapp
./build-for-solana-store.sh
```
- [ ] Build completed successfully
- [ ] APK size noted: _____ MB

### Step 2: Sign APK ✅
```bash
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore your-release-key.keystore \
  photosync-solana-v1.0.0.apk your-key-alias
```
- [ ] APK signed successfully
- [ ] Signature verified

### Step 3: Optimize APK ✅
```bash
zipalign -v 4 photosync-solana-v1.0.0.apk photosync-solana-v1.0.0-final.apk
```
- [ ] APK optimized
- [ ] Final APK ready

### Step 4: Test APK ✅
```bash
adb install photosync-solana-v1.0.0-final.apk
```
- [ ] Installs without errors
- [ ] App launches successfully
- [ ] All features work correctly
- [ ] No crashes during testing

### Step 5: Publisher Portal ✅
1. Navigate to https://publish.solanamobile.com
2. Click "Add a dApp" > "New dApp"
3. Fill in app details:
   - [ ] Name entered
   - [ ] Package name entered
   - [ ] Category selected
   - [ ] Description added
   - [ ] Website/contact info added
4. Save draft

### Step 6: Upload Assets ✅
- [ ] App icon uploaded
- [ ] Screenshots uploaded (4-8 images)
- [ ] Feature graphic uploaded (optional)
- [ ] All assets preview correctly

### Step 7: Set Storage Provider ✅
- [ ] ArDrive selected (recommended)
- [ ] Storage cost estimated: _____ SOL
- [ ] Wallet has sufficient SOL

### Step 8: Submit Release ✅
1. Click "New Version"
2. Upload APK: photosync-solana-v1.0.0-final.apk
3. Add release notes:
   - [ ] Version 1.0.0 notes written
   - [ ] Key features listed
   - [ ] Known issues documented (if any)
4. Review all information
5. Click "Submit"
6. Sign all transactions:
   - [ ] Asset upload transaction signed
   - [ ] NFT minting transaction signed
   - [ ] All confirmations approved

### Step 9: Post-Submission ✅
- [ ] Submission confirmation received
- [ ] App enters review queue
- [ ] Publisher Portal shows "Under Review" status
- [ ] Notification email received

## Review Process

### During Review
- [ ] Monitor Publisher Portal daily
- [ ] Check email for feedback
- [ ] Respond to any questions within 48 hours
- [ ] Make requested changes if needed

### Expected Timeline
- Review time: 1-3 business days
- Status updates via email and portal

### Possible Outcomes
1. **Approved** ✅
   - [ ] App goes live automatically
   - [ ] Appears in dApp Store
   - [ ] Listed under Utilities category
   - [ ] Announcement made (optional)

2. **Changes Requested** ⚠️
   - [ ] Review feedback received
   - [ ] Changes implemented
   - [ ] Resubmitted for review

3. **Rejected** ❌
   - [ ] Rejection reason reviewed
   - [ ] Issues addressed
   - [ ] New submission prepared

## Post-Approval

### After Going Live
- [ ] Verify app appears in store
- [ ] Test download and installation
- [ ] Monitor user feedback
- [ ] Respond to reviews
- [ ] Track analytics (if available)

### For Future Updates
- [ ] Increment versionCode in app.json
- [ ] Update version name
- [ ] Build new APK
- [ ] Submit "New Version" in portal
- [ ] Use same publisher wallet

## Important Notes

### ⚠️ Critical Reminders
- **Publisher Wallet**: Keep it secure! Required for ALL future updates
- **Minimum SOL**: Maintain 0.2 SOL for updates and fees
- **Keystore**: Backup your release keystore - losing it means no updates
- **Package Name**: Cannot be changed after submission
- **Response Time**: Reply to review feedback within 48 hours

### 💰 Cost Breakdown
- ArDrive storage: ~0.05-0.1 SOL (one-time per release)
- Transaction fees: ~0.001-0.01 SOL
- NFT minting: ~0.01 SOL
- **Total per release**: ~0.1-0.2 SOL

### 📊 Success Metrics
- Downloads
- Active users
- User ratings
- Review feedback
- Crash reports

## Support Resources

- **Documentation**: https://docs.solanamobile.com/dapp-publishing/intro
- **Publisher Portal**: https://publish.solanamobile.com
- **Discord**: https://discord.gg/solanamobile
- **Stack Exchange**: https://solana.stackexchange.com
- **Email Support**: Available through Publisher Portal

---

## Quick Reference

### Essential Links
- Publisher Portal: https://publish.solanamobile.com
- Documentation: https://docs.solanamobile.com
- Policy: https://docs.solanamobile.com/dapp-publishing/publisher-policy
- Agreement: https://docs.solanamobile.com/dapp-publishing/agreement

### App Details
- **Name**: PhotoSync - Solana dApp
- **Package**: com.photosync.solana.dapp
- **Version**: 1.0.0
- **Category**: Utilities
- **Min SDK**: 23 (Android 6.0)
- **Target SDK**: 34 (Android 14)

---

**Last Updated**: December 2025
**Submission Status**: ⬜ Not Started | ⏳ In Progress | ✅ Submitted | 🎉 Live
