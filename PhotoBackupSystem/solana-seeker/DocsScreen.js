/**
 * DocsScreen.js
 *
 * PhotoLynk Documentation — Dark glass aesthetic, premium palette.
 * Explains the app, encryption, Web3 album, and pricing.
 */

import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  Dimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const MIN_DIMENSION = Math.min(SCREEN_WIDTH, SCREEN_HEIGHT);
const isTablet = MIN_DIMENSION >= 600;
const isLargeTablet = MIN_DIMENSION >= 768;

const scale = (size) => {
  let result = size;
  if (isLargeTablet) result = size * 1.3;
  else if (isTablet) result = size * 1.15;
  return result;
};

const scaleSpacing = (size) => {
  let result = size;
  if (isLargeTablet) result = size * 1.2;
  else if (isTablet) result = size * 1.1;
  return result;
};

const COLORS = {
  bg: '#030308',
  card: '#0A0A14',
  cardLight: '#12121E',
  text: '#EEEEF6',
  textMuted: '#7676A0',
  textDim: '#5C5C80',
  primary: '#8899AA',
  secondary: '#6B8A8A',
  accent: '#9A9AAA',
  gold: '#B8A080',
  border: 'rgba(140,150,170,0.12)',
  borderLight: 'rgba(140,150,170,0.18)',
};

// ─── Reusable Components ──────────────────────────────────────────

const Card = ({ children, style }) => (
  <View style={[styles.card, style]}>{children}</View>
);

const SectionTitle = ({ icon, children, color = COLORS.accent }) => (
  <View style={styles.sectionTitleWrap}>
    <Feather name={icon} size={scale(16)} color={color} style={{ marginRight: scaleSpacing(8) }} />
    <Text style={[styles.sectionTitle, { color }]}>{children}</Text>
  </View>
);

const BodyText = ({ children, style }) => (
  <Text style={[styles.bodyText, style]}>{children}</Text>
);

const Highlight = ({ children, color = COLORS.secondary }) => (
  <Text style={{ color, fontWeight: '700' }}>{children}</Text>
);

const Bullet = ({ children }) => (
  <View style={styles.bulletRow}>
    <Text style={styles.bulletDot}>•</Text>
    <Text style={styles.bulletText}>{children}</Text>
  </View>
);

const Step = ({ number, children }) => (
  <View style={styles.stepRow}>
    <View style={styles.stepNumber}>
      <Text style={styles.stepNumberText}>{number}</Text>
    </View>
    <Text style={styles.stepText}>{children}</Text>
  </View>
);

// ─── Main Screen ──────────────────────────────────────────────────

export const DocsScreen = ({ appVersion }) => {
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'android' ? (insets.top || 24) : insets.top;
  const bottomInset = insets.bottom || 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topInset + scaleSpacing(12) }]}>
        <Text style={styles.headerTitle}>PhotoLynk Docs</Text>
        <Text style={styles.headerSubtitle}>How it works</Text>
        <LinearGradient
          colors={['transparent', `${COLORS.border}60`, 'transparent']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth }}
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: scaleSpacing(24) + bottomInset }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>

          {/* ── WHAT IS PHOTOLYNK ── */}
          <Card>
            <SectionTitle icon="image" color={COLORS.primary}>What is PhotoLynk?</SectionTitle>
            <BodyText>
              PhotoLynk is a mobile app for Android and iOS that backs up your photos and videos to encrypted cloud storage, with an optional feature to create on-chain photo records (cNFTs) on the Solana blockchain.
            </BodyText>
            <BodyText style={{ marginTop: scaleSpacing(10) }}>
              You log in with either an email and password, or a Solana hardware wallet via Mobile Wallet Adapter (MWA) or WalletAdapter-supported wallets like Phantom. Every file is encrypted on your device with XSalsa20-Poly1305 before uploading to StealthCloud. The server stores only ciphertext.
            </BodyText>
            <BodyText style={{ marginTop: scaleSpacing(10) }}>
              Optionally, you can add individual photos to your Web3 Album. This mints a compressed NFT (cNFT) on Solana mainnet using a shared Merkle tree. The app also includes tools to clean duplicate and burst photos from your device.
            </BodyText>
            <View style={styles.whoForBox}>
              <Text style={styles.whoForTitle}>Built for</Text>
              <Bullet>Anyone who wants encrypted cloud backups of their camera roll</Bullet>
              <Bullet>Users who want on-chain proof of photo ownership and authenticity</Bullet>
              <Bullet>People who need verifiable timestamps and content hashes for legal or journalistic use</Bullet>
              <Bullet>Anyone who wants to clean duplicate and near-duplicate photos from their device</Bullet>
            </View>
          </Card>

          {/* ── SAFETY & ENCRYPTION ── */}
          <Card style={{ marginTop: scaleSpacing(14) }}>
            <SectionTitle icon="shield" color={COLORS.secondary}>Safety &amp; Encryption</SectionTitle>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Authentication &amp; Credentials</Text>
              <Bullet>Email/password users: your password is stored in device secure storage (iOS Keychain / Android Keystore) via expo-secure-store. It may be biometric-protected depending on device settings.</Bullet>
              <Bullet>Wallet users: your private keys NEVER leave the hardware wallet or wallet app. PhotoLynk never sees, stores, or transmits your seed phrase or private key. All Solana transactions are signed inside the wallet app.</Bullet>
              <Bullet>Supported wallets: Mobile Wallet Adapter (MWA) for Solana Seeker/Saga, plus WalletAdapter-compatible wallets like Phantom.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>How the Encryption Key Is Derived</Text>
              <Bullet>Email/password: the master key is derived with PBKDF2-HMAC-SHA256. Your password is the PBKDF2 key, your email (lowercased and trimmed) is the salt, 30,000 iterations, producing a 32-byte key. This matches the desktop PhotoLynk app for cross-device recovery.</Bullet>
              <Bullet>Wallet (legacy method): a deterministic password is derived from SHA-512(walletAddress + appSalt), base64-encoding the first 32 bytes. This does not require signing and is reproducible from public data alone.</Bullet>
              <Bullet>Wallet (secure method): you sign the fixed message "PhotoLynk-MasterKey-v1" with your wallet. The signature is hashed with SHA-256 and the first 32 bytes become your master key. This requires your private key and cannot be forged from public information. Cached in secure storage after the first sign.</Bullet>
              <Bullet>The derived key is cached in expo-secure-store so you are not prompted for biometrics on every backup. The cache is cleared on logout.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>File Encryption (Before Upload)</Text>
              <Bullet>Each file gets a random 32-byte key generated with crypto.getRandomValues. That file key is encrypted (wrapped) with your master key using XSalsa20-Poly1305.</Bullet>
              <Bullet>Files are read in chunks. Each chunk is encrypted with its own unique nonce. Chunk size is platform and device-capability adaptive.</Bullet>
              <Bullet>Encrypted chunks are uploaded in parallel with concurrency limits that adapt to device capability and thermal state.</Bullet>
              <Bullet>The manifest (file list, chunk IDs, wrapped file key) is also encrypted with your master key before upload.</Bullet>
              <Bullet>Original file bytes are staged temporarily, encrypted, and then the staging file is deleted. Only ciphertext ever leaves the device.</Bullet>
              <Bullet>All EXIF metadata is preserved inside the encrypted file. The server cannot read it.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>What the Server Sees</Text>
              <Bullet>The server receives only encrypted chunks (ciphertext blobs) and an encrypted manifest. It cannot read photo contents, metadata, or file names from the encrypted data.</Bullet>
              <Bullet>The server does store unencrypted metadata for deduplication: a content hash (SHA-256 of filename + size), the file name, and the media type. This lets the server skip already-uploaded files, but it cannot decrypt the actual image.</Bullet>
              <Bullet>Files are stored in a device-isolated folder scoped to your account UUID.</Bullet>
              <Bullet>There is no master key, backdoor, or admin override. PhotoLynk cannot decrypt your files even if compelled.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Recovery — New Device or Lost Phone</Text>
              <Bullet>Your encryption key is derived deterministically from your credentials. The same email+password or wallet signature always produces the same key on any device.</Bullet>
              <Bullet>Install PhotoLynk on a new phone, log in with the same credentials, and use Sync to download and decrypt all your photos automatically.</Bullet>
              <Bullet>Wallet users: connect the same wallet and sign once. Your key regenerates automatically.</Bullet>
              <Bullet>Recovery kit: in Settings you can create a recovery kit. Your credentials are encrypted with a PIN-derived key (PBKDF2, 100,000 iterations). If you forget your password, paste the kit and enter your PIN on a new device to restore. The kit is a point-in-time snapshot; changing your password invalidates the old kit.</Bullet>
              <Bullet>Hard truth: if you forget your password, lose your wallet, AND have no recovery kit, your encrypted files are unrecoverable. The encryption is real. PhotoLynk does not have a copy of your key. Create a recovery kit before you need it.</Bullet>
            </View>
          </Card>

          {/* ── FUNCTIONS ── */}
          <Card style={{ marginTop: scaleSpacing(14) }}>
            <SectionTitle icon="tool" color={COLORS.accent}>App Functions</SectionTitle>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Backup All / Backup Selected</Text>
              <Bullet>Scans your device media library (all albums the app has access to, including Screenshots, Downloads, WhatsApp, etc.). On iOS, access depends on the photo library permission you granted. Android excludes items in the PhotoLynkDeleted album.</Bullet>
              <Bullet>Computes a stable manifest ID from filename + file size. Checks against server manifests. Already-uploaded files are skipped instantly — no re-reading, no re-encrypting, no re-uploading.</Bullet>
              <Bullet>First-time uploads: reads file in chunks, encrypts each chunk with XSalsa20-Poly1305 using a random file key, uploads encrypted chunks to StealthCloud.</Bullet>
              <Bullet>Fast Mode is available as a UI toggle that reduces thermal throttling cooldowns. There is no separate code path.</Bullet>
              <Bullet>Auto Upload exists in the codebase but the feature flag is disabled in the current build.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Sync All / Sync Selected</Text>
              <Bullet>Fetches your encrypted file manifests from StealthCloud. Compares against local device files using the same deduplication logic (perceptual hash for photos, SHA-256 for videos).</Bullet>
              <Bullet>Downloads missing encrypted chunks, decrypts them with your master key, and saves them back to your device media library.</Bullet>
              <Bullet>Skipped files are those already present on device. Failed files are retried with backoff.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Clean Duplicates — Exact Match</Text>
              <Bullet>Scans all device photos and videos. Photos are compared using a perceptual dHash (difference hash) with a cross-platform threshold of 2 bits — this catches the same photo even if re-saved or re-compressed by different devices. It does not match photos that have been cropped, filtered, or otherwise edited. Videos are compared by exact SHA-256 file content.</Bullet>
              <Bullet>Groups exact duplicates together. You review the groups and select which copies to delete.</Bullet>
              <Bullet>On iOS, deleted items go to the system Recently Deleted album (30-day recovery). On Android, they go to a PhotoLynkDeleted album within your media library. Nothing leaves your device.</Bullet>
              <Bullet>Your StealthCloud backup is never touched by Clean Duplicates. This only cleans your local device storage.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Clean Duplicates — Burst Photos</Text>
              <Bullet>Uses the same perceptual hashing engine to group visually similar photos (burst shots, multiple angles, etc.). Only photos are scanned, not videos.</Bullet>
              <Bullet>Presents each group for your review. You choose which shots to keep. Nothing is deleted without explicit approval.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Add to Web3 Album</Text>
              <Bullet>Select a photo from your device. The app creates either a Public or Private cNFT on Solana mainnet.</Bullet>
              <Bullet>Public cNFT: the original image is uploaded to IPFS (Pinata) unencrypted. The metadata URI is public. Anyone can view the image and verify ownership on Solana.</Bullet>
              <Bullet>Private cNFT: the image is encrypted with a random NFT key before IPFS upload. The NFT key is wrapped with your master key. Only you can decrypt the image.</Bullet>
              <Bullet>Both types include in the on-chain metadata: SHA-256 content hash of the original, EXIF metadata hash, capture timestamp, and creator wallet.</Bullet>
              <Bullet>Optional extras: RFC 3161 trusted timestamp (from FreeTSA.org), and C2PA provenance manifest. These are embedded in the NFT metadata.</Bullet>
              <Bullet>The cNFT is minted on Solana mainnet via the PhotoLynk shared Merkle tree. This makes it a compressed NFT (cNFT) which costs roughly the Solana transaction fee only (~$0.001).</Bullet>
              <Bullet>Adding a photo to your Web3 Album is a per-transaction action with no duplicate check — each mint creates a new on-chain record.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Web3 Album &amp; Proof Records</Text>
              <Bullet>Each cNFT on Solana contains a metadata URI that links to the image on IPFS and includes content hashes, timestamps, and creator info.</Bullet>
              <Bullet>Proof records are viewable inside the app. They show: mint address, transaction signature, content hash, EXIF hash, creator wallet, optional RFC 3161 timestamp, and optional C2PA manifest.</Bullet>
              <Bullet>You can verify a proof record independently: the content hash is a SHA-256 of the original file. The EXIF hash is a SHA-256 of normalized EXIF fields. Verification scripts are published on GitHub.</Bullet>
              <Bullet>cNFTs are supported by most major Solana wallets, but not all. If a wallet does not show your PhotoLynk record, use a compatible viewer or Solana explorer.</Bullet>
            </View>
          </Card>

          {/* ── PRICING ── */}
          <Card style={{ marginTop: scaleSpacing(14) }}>
            <SectionTitle icon="credit-card" color={COLORS.gold}>Pricing</SectionTitle>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Cloud Storage Plans</Text>
              <Bullet>Free tier: backup and sync without subscription. Upload access may be restricted based on server policy.</Bullet>
              <Bullet>Paid plans: 100 GB, 200 GB, 400 GB, and 1 TB. Paid monthly or yearly.</Bullet>
              <Bullet>Plans are purchased with SOL or SKR (a Solana SPL token) via your connected wallet. Prices are quoted in USD and converted to SOL/SKR at live rates from Jupiter or DexScreener APIs.</Bullet>
              <Bullet>Subscriptions do not auto-renew. You pay manually each period.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Web3 Album Mint Fees</Text>
              <Bullet>PhotoLynk charges a size-based commission. Base fee is $0.15 for files up to 3 MB. Each additional 1 MB above 3 MB adds +10% to the base fee.</Bullet>
              <Bullet>Example: 2 MB = $0.15. 5 MB = $0.18. 10 MB = $0.25. 20 MB = $0.40.</Bullet>
              <Bullet>There is also a promotional pricing period and regular pricing period defined in the app, with different fee tiers for cNFT + IPFS vs cNFT + StealthCloud storage.</Bullet>
              <Bullet>Solana network fees are always paid in SOL and are separate from the PhotoLynk commission. You need SOL in your wallet for every mint regardless of which token you use for the commission.</Bullet>
              <Bullet>Commissions can be paid in SOL or SKR. Both cost the same in USD terms. Higher SKR price = fewer tokens needed. Lower SKR price = more tokens needed.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Loyalty Discounts</Text>
              <Bullet>Every addition to your Web3 Album in a week increases your loyalty discount for the next mint.</Bullet>
              <Bullet>Maximum discount: 80% off the commission fee.</Bullet>
              <Bullet>Discounts apply to both SOL and SKR payment methods.</Bullet>
            </View>

            <View style={styles.subSection}>
              <Text style={styles.subTitle}>Premium Perks</Text>
              <Bullet>Premium is a one-time purchase, not a recurring subscription. Once purchased, your Premium plan remains on your account indefinitely.</Bullet>
              <Bullet>Includes 1 TB encrypted cloud storage for 1 year from purchase date.</Bullet>
              <Bullet>Includes 100 fully free Web3 Album additions (no app commission, no network fees paid by you).</Bullet>
              <Bullet>Beyond 100 additions: flat $0.02 USDC per mint at current network rates. This rate applies to your account as long as Premium is on your account. Future fee adjustments (if any) apply only to new mints and do not retroactively change your plan terms.</Bullet>
              <Bullet>Use across all your devices with the same account.</Bullet>
              <Bullet>Legacy premium subscribers (pre-2.2): all Web3 Album additions remain fully free with no limits.</Bullet>
              <Bullet>Any active paid plan (monthly subscriber, not just Premium) gives an 80% discount on mint fees.</Bullet>
            </View>

            <BodyText style={{ marginTop: scaleSpacing(8) }}>
              <Highlight color={COLORS.gold}>Fee Policy:</Highlight> Mint fees and commissions are based on current Solana network costs and may be adjusted if network conditions change significantly. Any fee changes apply to new mints only — they do not affect already-minted cNFTs or previously purchased plans. Premium is a one-time purchase; once on your account, the plan remains. Fee changes, if any, would apply to future mints beyond your plan's included allocations.
            </BodyText>
          </Card>

          {/* Footer */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>PhotoLynk v{appVersion || '2.2.0'}</Text>
          </View>

        </View>
      </ScrollView>
    </View>
  );
};

// ─── Styles ───────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    paddingHorizontal: scaleSpacing(18),
    paddingBottom: scaleSpacing(14),
    backgroundColor: COLORS.bg,
    position: 'relative',
  },
  headerTitle: {
    fontSize: scale(22),
    fontWeight: '900',
    color: COLORS.text,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: scale(13),
    color: COLORS.textMuted,
    marginTop: scaleSpacing(2),
  },
  content: {
    paddingHorizontal: scaleSpacing(16),
    paddingTop: scaleSpacing(12),
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: scale(16),
    padding: scaleSpacing(16),
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sectionTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: scaleSpacing(12),
  },
  sectionTitle: {
    fontSize: scale(15),
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  bodyText: {
    fontSize: scale(13),
    color: COLORS.textMuted,
    lineHeight: scale(20),
  },
  whoForBox: {
    marginTop: scaleSpacing(12),
    backgroundColor: COLORS.cardLight,
    borderRadius: scale(12),
    padding: scaleSpacing(12),
    borderWidth: 1,
    borderColor: COLORS.borderLight,
  },
  whoForTitle: {
    fontSize: scale(13),
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: scaleSpacing(8),
  },
  subSection: {
    marginTop: scaleSpacing(12),
  },
  subTitle: {
    fontSize: scale(13),
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: scaleSpacing(6),
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: scaleSpacing(5),
    paddingLeft: scaleSpacing(2),
  },
  bulletDot: {
    fontSize: scale(12),
    color: COLORS.accent,
    marginRight: scaleSpacing(8),
    lineHeight: scale(18),
  },
  bulletText: {
    flex: 1,
    fontSize: scale(12),
    color: COLORS.textMuted,
    lineHeight: scale(18),
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: scaleSpacing(10),
  },
  stepNumber: {
    width: scale(22),
    height: scale(22),
    borderRadius: scale(11),
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: scaleSpacing(10),
    marginTop: scaleSpacing(1),
  },
  stepNumberText: {
    color: '#FFF',
    fontSize: scale(11),
    fontWeight: '800',
  },
  stepText: {
    flex: 1,
    fontSize: scale(12),
    color: COLORS.textMuted,
    lineHeight: scale(18),
  },
  footer: {
    alignItems: 'center',
    paddingVertical: scaleSpacing(24),
    gap: scaleSpacing(4),
  },
  footerText: {
    fontSize: scale(11),
    color: COLORS.textDim,
  },
});

export default DocsScreen;
