// PhotoLynk Mobile App - Background Task & Crypto Helpers

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as MediaLibrary from 'expo-media-library';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as Device from 'expo-device';
import axios from 'axios';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { sha256 } from 'js-sha256';

import {
  normalizeFilePath,
  makeChunkNonce,
  sanitizeHeaders,
  stripContentType,
  withRetries,
  shouldRetryChunkUpload,
  computeFileIdentity,
} from './utils';

import {
  computeExactFileHash,
  computePerceptualHash,
  findPerceptualHashMatch,
  CROSS_PLATFORM_DHASH_THRESHOLD,
} from './duplicateScanner';

import {
  AUTO_UPLOAD_BACKGROUND_TASK,
  autoUploadEligibilityForBackground,
  autoUploadGetAuthHeadersFromSecureStore
} from './autoUpload';

// Constants
export const MB = 1024 * 1024;
export const AUTO_UPLOAD_CURSOR_KEY = 'auto_upload_cursor_v1';

// Resolve readable file path (stages asset if needed)
export const resolveReadableFilePath = async ({ assetId, assetInfo }) => {
  // iOS: try to get the original RAW/DNG resource from the photo library
  // localUri returns the JPEG preview for RAW+JPEG assets; getOriginalResource
  // uses PHAssetResource to extract the actual DNG/RAW bytes.
  if (Platform.OS === 'ios' && assetId) {
    try {
      const { NativeModules } = require('react-native');
      const ExifExtractor = NativeModules.ExifExtractor;
      if (ExifExtractor?.getOriginalResource) {
        const rawResult = await ExifExtractor.getOriginalResource(assetId);
        if (rawResult && rawResult.filePath) {
          console.log(`[Resolve] Got original RAW resource: ${rawResult.filename}`);
          return { filePath: rawResult.filePath, tmpCopied: true, tmpUri: rawResult.filePath, isRaw: true, rawFilename: rawResult.filename };
        }
      }
    } catch (e) {
      // Non-critical — fall through to normal path
      console.log('[Resolve] getOriginalResource failed (non-critical):', e?.message);
    }
  }

  let localUri = (assetInfo && (assetInfo.localUri || assetInfo.uri)) || null;
  
  // If no localUri, try to get it via getAssetInfoAsync (needed for Android)
  if (!localUri && assetId) {
    try {
      const fullInfo = await MediaLibrary.getAssetInfoAsync(assetId);
      localUri = fullInfo?.localUri || fullInfo?.uri || null;
    } catch (e) {
      // Fall through to error
    }
  }
  
  if (!localUri) throw new Error('Missing localUri');
  if (localUri.startsWith('file://') || localUri.startsWith('/')) {
    const p = normalizeFilePath(localUri);
    if (!p) throw new Error('Invalid file path');
    return { filePath: p, tmpCopied: false };
  }
  const ext = (assetInfo && (assetInfo.filename || '').includes('.'))
    ? `.${assetInfo.filename.split('.').pop()}`
    : '';
  const tmpUri = `${FileSystem.cacheDirectory}sc_src_${assetId}${ext}`;
  await FileSystem.deleteAsync(tmpUri, { idempotent: true });
  const writeViaBase64 = async () => {
    // Prevent OOM: check asset size before loading entire file into JS memory
    const estimatedSize = assetInfo?.fileSize || 0;
    if (estimatedSize > 50 * 1024 * 1024) {
      // For large files, retry copyAsync with delays instead of base64 fallback
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          await FileSystem.copyAsync({ from: localUri, to: tmpUri });
          const tmpInfo = await FileSystem.getInfoAsync(tmpUri, { size: true });
          if (tmpInfo?.exists && tmpInfo.size > 0) return;
        } catch (_) {}
      }
      throw new Error('Failed to stage large file after retries');
    }
    const data = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    await FileSystem.writeAsStringAsync(tmpUri, data, { encoding: FileSystem.EncodingType.Base64 });
  };
  if (typeof FileSystem.copyAsync === 'function') {
    try {
      await FileSystem.copyAsync({ from: localUri, to: tmpUri });
      const tmpInfo = await FileSystem.getInfoAsync(tmpUri, { size: true });
      if (!tmpInfo?.exists || (typeof tmpInfo?.size === 'number' && tmpInfo.size <= 0)) {
        await writeViaBase64();
      }
    } catch (e) {
      await writeViaBase64();
    }
  } else {
    await writeViaBase64();
  }
  const tmpInfo2 = await FileSystem.getInfoAsync(tmpUri, { size: true });
  if (!tmpInfo2?.exists || (typeof tmpInfo2?.size === 'number' && tmpInfo2.size <= 0)) {
    throw new Error('Failed to stage asset (empty file)');
  }
  const p = normalizeFilePath(tmpUri);
  if (!p) throw new Error('Failed to stage asset');
  return { filePath: p, tmpCopied: true, tmpUri };
};

// PBKDF2-HMAC-SHA256 implementation using js-sha256
// Matches Node.js crypto.pbkdf2Sync(password, salt, iterations, keylen, 'sha256')
export const pbkdf2Sha256 = (password, salt, iterations, keyLen) => {
  const encoder = new TextEncoder();
  const passwordBytes = typeof password === 'string' ? encoder.encode(password) : password;
  const saltBytes = typeof salt === 'string' ? encoder.encode(salt) : salt;
  
  // HMAC-SHA256 helper
  const hmacSha256 = (key, data) => {
    const blockSize = 64;
    let keyBytes = key;
    if (keyBytes.length > blockSize) {
      keyBytes = new Uint8Array(sha256.arrayBuffer(keyBytes));
    }
    if (keyBytes.length < blockSize) {
      const padded = new Uint8Array(blockSize);
      padded.set(keyBytes);
      keyBytes = padded;
    }
    const oKeyPad = new Uint8Array(blockSize);
    const iKeyPad = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      oKeyPad[i] = keyBytes[i] ^ 0x5c;
      iKeyPad[i] = keyBytes[i] ^ 0x36;
    }
    const inner = new Uint8Array(iKeyPad.length + data.length);
    inner.set(iKeyPad);
    inner.set(data, iKeyPad.length);
    const innerHash = new Uint8Array(sha256.arrayBuffer(inner));
    const outer = new Uint8Array(oKeyPad.length + innerHash.length);
    outer.set(oKeyPad);
    outer.set(innerHash, oKeyPad.length);
    return new Uint8Array(sha256.arrayBuffer(outer));
  };
  
  const hashLen = 32; // SHA-256 output length
  const numBlocks = Math.ceil(keyLen / hashLen);
  const result = new Uint8Array(numBlocks * hashLen);
  
  for (let blockNum = 1; blockNum <= numBlocks; blockNum++) {
    // U1 = HMAC(password, salt || INT_32_BE(blockNum))
    const blockBytes = new Uint8Array(4);
    blockBytes[0] = (blockNum >>> 24) & 0xff;
    blockBytes[1] = (blockNum >>> 16) & 0xff;
    blockBytes[2] = (blockNum >>> 8) & 0xff;
    blockBytes[3] = blockNum & 0xff;
    const saltBlock = new Uint8Array(saltBytes.length + 4);
    saltBlock.set(saltBytes);
    saltBlock.set(blockBytes, saltBytes.length);
    
    let u = hmacSha256(passwordBytes, saltBlock);
    const block = new Uint8Array(u);
    
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(passwordBytes, u);
      for (let j = 0; j < hashLen; j++) {
        block[j] ^= u[j];
      }
    }
    
    result.set(block, (blockNum - 1) * hashLen);
  }
  
  return result.slice(0, keyLen);
};

// Derive StealthCloud master encryption key from user credentials
// Uses PBKDF2 with email as salt, matching desktop app's deriveMasterKey()
// This ensures same user on different devices gets the same encryption key
// Cache the derived master key in SecureStore so we don't need biometrics on every backup
const DERIVED_MASTER_KEY_CACHE = 'stealthcloud_derived_key_v2';
// Secure cache for wallet signature-derived key. Separate so we can keep
// both the legacy (public-address-derived) and secure (signature-derived)
// keys available for decrypting old vs new files.
const SECURE_DERIVED_KEY_CACHE = 'stealthcloud_secure_derived_key_v1';
// Separate cache for the pre-migration (legacy email+password) derived key.
// This survives independently so old encrypted NFTs can always be decrypted
// even if the user migrates to wallet auth and legacy_mk_email/password are lost.
const LEGACY_DERIVED_KEY_CACHE = 'stealthcloud_legacy_derived_key';

// Get the legacy (pre-migration) master key for decrypt fallback.
// Returns null if the user never migrated (was always wallet-only).
export const getLegacyMasterKey = async () => {
  try {
    const cached = await SecureStore.getItemAsync(LEGACY_DERIVED_KEY_CACHE);
    if (cached) {
      console.log('StealthCloud: legacy master key available for decrypt fallback');
      return naclUtil.decodeBase64(cached);
    }
  } catch (e) {}
  // If no cached derived key, try deriving from stored legacy credentials
  try {
    const mkEmail = await SecureStore.getItemAsync('legacy_mk_email');
    const mkPassword = await SecureStore.getItemAsync('legacy_mk_password');
    if (mkEmail && mkPassword) {
      const salt = mkEmail.toLowerCase().trim();
      const derivedKey = pbkdf2Sha256(mkPassword, salt, 30000, 32);
      await SecureStore.setItemAsync(LEGACY_DERIVED_KEY_CACHE, naclUtil.encodeBase64(derivedKey));
      console.log('StealthCloud: derived and cached legacy key from stored creds');
      return derivedKey;
    }
  } catch (e) {}
  return null;
};

// Get the wallet legacy (public-address-derived) master key for old file fallback.
export const getWalletLegacyMasterKey = async () => {
  try {
    const cached = await SecureStore.getItemAsync(LEGACY_DERIVED_KEY_CACHE);
    if (cached) {
      return naclUtil.decodeBase64(cached);
    }
  } catch (e) {}
  // Try deriving from stored legacy wallet password
  try {
    const legacyPw = await SecureStore.getItemAsync('wallet_legacy_password_v1');
    const email = await SecureStore.getItemAsync('user_email');
    if (legacyPw && email) {
      const salt = email.toLowerCase().trim();
      const derivedKey = pbkdf2Sha256(legacyPw, salt, 30000, 32);
      await SecureStore.setItemAsync(LEGACY_DERIVED_KEY_CACHE, naclUtil.encodeBase64(derivedKey));
      return derivedKey;
    }
  } catch (e) {}
  return null;
};

/**
 * Get both decryption keys: secure (signature-derived) and legacy (public-address-derived).
 * Decryption code should try secure first, then fall back to legacy.
 * The legacy key is kept available until ALL files are confirmed re-encrypted.
 * @returns {Promise<{secureKey: Uint8Array|null, legacyKey: Uint8Array|null}>}
 */
export const getDecryptionMasterKeys = async () => {
  const [secureKey, legacyKey] = await Promise.all([
    getStealthCloudMasterKey(),
    getWalletLegacyMasterKey(),
  ]);
  return { secureKey, legacyKey };
};

export const getStealthCloudMasterKey = async () => {
  // 1. Try secure (signature-derived) key first
  try {
    const secureCached = await SecureStore.getItemAsync(SECURE_DERIVED_KEY_CACHE);
    if (secureCached) {
      console.log('StealthCloud: using secure signature-derived key');
      return naclUtil.decodeBase64(secureCached);
    }
  } catch (e) {}

  // 2. Fall back to legacy cached key
  try {
    const cached = await SecureStore.getItemAsync(DERIVED_MASTER_KEY_CACHE);
    if (cached) {
      console.log('StealthCloud: using cached derived key');
      return naclUtil.decodeBase64(cached);
    }
  } catch (e) {
    // Ignore
  }

  // 3. For migrated legacy→wallet users, the master key must be derived from the
  // ORIGINAL email+password (not the wallet-derived ones). Check for stored
  // legacy master key credentials first.
  let email = null;
  let password = null;
  try {
    const mkEmail = await SecureStore.getItemAsync('legacy_mk_email');
    const mkPassword = await SecureStore.getItemAsync('legacy_mk_password');
    if (mkEmail && mkPassword) {
      email = mkEmail;
      password = mkPassword;
    }
  } catch (e) {}

  // 4. If no legacy MK credentials, use current user credentials
  if (!email || !password) {
    email = await SecureStore.getItemAsync('user_email');
    // Password may be stored with requireAuthentication: true (biometric-protected).
    // On Android, even a plain getItemAsync can trigger biometric for such keys.
    // Use requireAuthentication: false explicitly to avoid bio prompt.
    try {
      password = await SecureStore.getItemAsync('user_password_v1', {
        requireAuthentication: false
      });
    } catch (e) {
      // Ignore — key may not be readable without biometric on this device
    }
  }

  console.log('StealthCloud masterKey: email=', email ? 'present' : 'missing', 'password=', password ? 'present' : 'missing');

  if (!email || !password) {
    console.log('StealthCloud: no credentials available, cannot derive master key');
    return null;
  }

  // Derive key from credentials using PBKDF2 (same as desktop app)
  const salt = email.toLowerCase().trim();
  console.log('StealthCloud: deriving key from credentials, salt=', salt);
  const derivedKey = pbkdf2Sha256(password, salt, 30000, 32);

  // Cache the derived key so we don't need password again (avoids biometrics prompt)
  try {
    await SecureStore.setItemAsync(DERIVED_MASTER_KEY_CACHE, naclUtil.encodeBase64(derivedKey));
    console.log('StealthCloud: cached derived key');
  } catch (e) {
    console.log('StealthCloud: failed to cache derived key', e.message);
  }

  return derivedKey;
};

// Call this during login to pre-derive and cache the master key
// Returns a Promise that resolves after key derivation completes
// Uses setTimeout to yield to the UI thread during heavy PBKDF2 computation
export const cacheStealthCloudMasterKey = async (email, password, isLegacyCreds = false, isSecure = false) => {
  if (!email || !password) return;

  // If this is being called with legacy (pre-migration) credentials,
  // also persist the derived key in the separate legacy cache so it
  // survives even if legacy_mk_email/password are later wiped.
  if (isLegacyCreds) {
    try {
      const existingLegacy = await SecureStore.getItemAsync(LEGACY_DERIVED_KEY_CACHE);
      if (!existingLegacy) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const legacySalt = email.toLowerCase().trim();
        const legacyKey = pbkdf2Sha256(password, legacySalt, 30000, 32);
        await new Promise(resolve => setTimeout(resolve, 10));
        await SecureStore.setItemAsync(LEGACY_DERIVED_KEY_CACHE, naclUtil.encodeBase64(legacyKey));
        console.log('StealthCloud: persisted legacy master key for future decrypt fallback');
      }
    } catch (e) {
      console.log('StealthCloud: failed to persist legacy key', e.message);
    }
  }

  // Determine which cache to use based on whether this is a secure derivation
  const targetCache = isSecure ? SECURE_DERIVED_KEY_CACHE : DERIVED_MASTER_KEY_CACHE;

  // If already cached, skip re-deriving to avoid extra PBKDF2 cost
  try {
    const existing = await SecureStore.getItemAsync(targetCache);
    if (existing) {
      console.log('StealthCloud: derived key already cached, skipping PBKDF2');
      return;
    }
  } catch (e) {
    // ignore and derive below
  }

  // Yield to UI thread before starting heavy computation
  await new Promise(resolve => setTimeout(resolve, 50));

  const salt = email.toLowerCase().trim();
  const derivedKey = pbkdf2Sha256(password, salt, 30000, 32);

  // Yield again after computation
  await new Promise(resolve => setTimeout(resolve, 10));

  try {
    await SecureStore.setItemAsync(targetCache, naclUtil.encodeBase64(derivedKey));
    console.log('StealthCloud: pre-cached', isSecure ? 'secure' : 'legacy', 'derived key during login');
  } catch (e) {
    console.log('StealthCloud: failed to pre-cache derived key', e.message);
  }
};

// Export the cached master key as base64 for user recovery
// Returns the secure key if available, otherwise the legacy key.
export const getCachedMasterKeyBase64 = async () => {
  try {
    const secureCached = await SecureStore.getItemAsync(SECURE_DERIVED_KEY_CACHE);
    if (secureCached) return secureCached;
  } catch (e) {}
  try {
    const cached = await SecureStore.getItemAsync(DERIVED_MASTER_KEY_CACHE);
    if (cached) return cached;
  } catch (e) {}
  return null;
};

// Export the cached LEGACY master key as base64 (for old file recovery)
export const getCachedLegacyMasterKeyBase64 = async () => {
  try {
    const cached = await SecureStore.getItemAsync(LEGACY_DERIVED_KEY_CACHE);
    if (cached) return cached;
  } catch (e) {}
  try {
    const cached = await SecureStore.getItemAsync(DERIVED_MASTER_KEY_CACHE);
    if (cached) return cached;
  } catch (e) {}
  return null;
};

// Call this on logout to clear all cached keys
export const clearStealthCloudMasterKeyCache = async () => {
  try {
    await SecureStore.deleteItemAsync(DERIVED_MASTER_KEY_CACHE);
    await SecureStore.deleteItemAsync(SECURE_DERIVED_KEY_CACHE);
    await SecureStore.deleteItemAsync(LEGACY_DERIVED_KEY_CACHE);
    console.log('StealthCloud: cleared cached derived keys');
  } catch (e) {
    // Ignore
  }
};

// Upload encrypted chunk (background task version - simpler)
export const uploadEncryptedChunk = async ({ SERVER_URL, config, chunkId, encryptedBytes }) => {
  const tmpUri = `${FileSystem.cacheDirectory}sc_${chunkId}.bin`;
  const b64 = naclUtil.encodeBase64(encryptedBytes);
  await FileSystem.writeAsStringAsync(tmpUri, b64, { encoding: FileSystem.EncodingType.Base64 });
  const url = `${SERVER_URL}/api/cloud/chunks`;
  const baseHeaders = sanitizeHeaders({ 'X-Chunk-Id': chunkId, ...(config && config.headers ? config.headers : {}) });
  const headers = { ...stripContentType(baseHeaders), 'Content-Type': 'application/octet-stream' };
  await withRetries(async () => {
    const res = await FileSystem.uploadAsync(url, tmpUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      sessionType: Platform.OS === 'ios' ? FileSystem.FileSystemSessionType.BACKGROUND : FileSystem.FileSystemSessionType.FOREGROUND,
      headers
    });
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (status >= 300) throw new Error(`Chunk upload failed: HTTP ${status}`);
    return res;
  }, { retries: 10, baseDelayMs: 1000, maxDelayMs: 30000, shouldRetry: shouldRetryChunkUpload });
  await FileSystem.deleteAsync(tmpUri, { idempotent: true });
};

// Upload single asset to StealthCloud (background task version)
export const autoUploadStealthCloudUploadOneAsset = async ({ 
  asset, config, SERVER_URL, existingManifestIds, 
  alreadyFilenames, alreadyBaseNameSizes, alreadyBaseNameDates, alreadyBaseNameTimestamps,
  alreadyPerceptualHashes, alreadyFileHashes,
  onStatus, fastMode = false 
}) => {
  const logStep = (step, extra = '') => console.log(`[AutoUpload:${asset?.id?.substring(0,8)}] ${step}${extra ? ': ' + extra : ''}`);
  
  if (!asset || !asset.id) return { uploaded: 0, skipped: 0, failed: 0 };

  // FAST PATH: Check filename dedup BEFORE any heavy operations (getAssetInfo, resolveFilePath)
  // This prevents memory buildup from processing files that will be skipped anyway
  const { normalizeFilenameForCompare } = require('./utils');
  const quickFilename = asset.filename || null;
  if (quickFilename && alreadyFilenames) {
    const normalizedQuick = normalizeFilenameForCompare(quickFilename);
    if (normalizedQuick && alreadyFilenames.has(normalizedQuick)) {
      logStep('SKIP-FAST', `filename already on server: ${quickFilename}`);
      return { uploaded: 0, skipped: 1, failed: 0 };
    }
  }

  logStep('START', `mediaType=${asset.mediaType}, fastMode=${fastMode}`);
  
  if (onStatus) onStatus('encrypting');
  
  logStep('STEP1', 'Getting master key');
  const masterKey = await getStealthCloudMasterKey();
  logStep('STEP1', 'Master key obtained');

  logStep('STEP2', 'Getting asset info');
  let assetInfo = null;
  try {
    // Retry getAssetInfoAsync up to 6 times (iCloud/network issues)
    assetInfo = await withRetries(async () => {
      return Platform.OS === 'android'
        ? await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true })
        : await MediaLibrary.getAssetInfoAsync(asset.id);
    }, { retries: 5, baseDelayMs: 1000, maxDelayMs: 15000, shouldRetry: () => true });
    logStep('STEP2', `Asset info obtained: filename=${assetInfo?.filename}`);
  } catch (e) {
    logStep('STEP2', `FAILED: ${e?.message}`);
    console.warn('Background: getAssetInfoAsync failed after retries:', asset.id, e?.message);
    return { uploaded: 0, skipped: 0, failed: 1 };
  }

  logStep('STEP3', 'Resolving file path');
  let staged = null;
  try {
    staged = await resolveReadableFilePath({ assetId: asset.id, assetInfo });
    logStep('STEP3', `File path resolved: ${staged?.filePath?.substring(0, 50)}...`);
  } catch (e) {
    logStep('STEP3', `FAILED: ${e?.message}`);
    return { uploaded: 0, skipped: 0, failed: 1 };
  }

  const filePath = staged && staged.filePath ? staged.filePath : null;
  if (!filePath) return { uploaded: 0, skipped: 0, failed: 1 };

  // Get file size for stable manifestId
  // CRITICAL: Use original asset size from MediaLibrary, not temporary copy size
  // Temporary copies may have different sizes (metadata stripped, compression, etc.)
  // which would create different manifestIds and cause duplicate uploads
  let originalSize = null;
  try {
    originalSize = assetInfo && typeof assetInfo.fileSize === 'number' ? Number(assetInfo.fileSize) : null;
  } catch (e) {
    originalSize = null;
  }
  
  // Fallback to file system size if assetInfo.fileSize not available
  if (!originalSize) {
    const fileUri = filePath.startsWith('/') ? `file://${filePath}` : filePath;
    try {
      const info = await FileSystem.getInfoAsync(fileUri);
      originalSize = info?.size || null;
    } catch (e) {}
  }

  // Compute stable cross-device manifestId from filename + size
  const filename = assetInfo.filename || asset.filename || null;
  const { extractBaseFilename, normalizeDateForCompare } = require('./duplicateScanner');
  const fileIdentity = computeFileIdentity(filename, originalSize);
  const manifestId = fileIdentity ? sha256(`file:${fileIdentity}`) : sha256(`asset:${asset.id}`);
  
  logStep('DEDUP', 'Checking deduplication');
  
  // Skip if already uploaded (by stable manifestId)
  if (existingManifestIds && existingManifestIds.has(manifestId)) {
    logStep('SKIP', 'manifestId already exists');
    if (staged && staged.tmpCopied && staged.tmpUri) {
      try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
    }
    return { uploaded: 0, skipped: 1, failed: 0, manifestId };
  }

  // Skip if filename already exists on server (double-check with assetInfo filename)
  const normalizedFilename = filename ? normalizeFilenameForCompare(filename) : null;
  if (normalizedFilename && alreadyFilenames && alreadyFilenames.has(normalizedFilename)) {
    logStep('SKIP', `filename already on server: ${filename}`);
    if (staged && staged.tmpCopied && staged.tmpUri) {
      try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
    }
    return { uploaded: 0, skipped: 1, failed: 0, manifestId };
  }

  // Cross-platform variant matching using base filename
  const baseFilename = filename ? extractBaseFilename(filename) : null;

  // HEIC PRIORITY: Full timestamp match (most reliable for cross-platform HEIC dedup)
  // HEIC files from iPhone and desktop have identical EXIF timestamps even if bytes differ
  const { normalizeFullTimestamp } = require('./duplicateScanner');
  const assetTimestamp = asset.creationTime ? normalizeFullTimestamp(asset.creationTime) : null;
  if (baseFilename && assetTimestamp && alreadyBaseNameTimestamps && alreadyBaseNameTimestamps.has(baseFilename)) {
    const existingTimestamps = alreadyBaseNameTimestamps.get(baseFilename);
    if (existingTimestamps.has(assetTimestamp)) {
      console.log(`AutoUpload: Skipping ${filename} - baseFilename+timestamp match (${baseFilename}, ${assetTimestamp})`);
      if (staged && staged.tmpCopied && staged.tmpUri) {
        try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
      }
      return { uploaded: 0, skipped: 1, failed: 0, manifestId };
    }
  }
  
  // NOTE: EXIF-based dedup removed - causes false positives when photos taken in same second with same make/model
  
  // Fallback 1: base filename + size match (within 20% tolerance for re-compression)
  if (baseFilename && alreadyBaseNameSizes && alreadyBaseNameSizes.has(baseFilename)) {
    const existingSizes = alreadyBaseNameSizes.get(baseFilename);
    for (const existingSize of existingSizes) {
      const sizeDiff = Math.abs(originalSize - existingSize) / Math.max(originalSize, existingSize);
      if (sizeDiff < 0.20) {
        console.log(`AutoUpload: Skipping ${filename} - baseFilename+size match (${baseFilename}, size diff ${(sizeDiff * 100).toFixed(1)}%)`);
        if (staged && staged.tmpCopied && staged.tmpUri) {
          try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
        }
        return { uploaded: 0, skipped: 1, failed: 0, manifestId };
      }
    }
  }

  // Fallback 2: base filename + creation date match
  const assetDate = asset.creationTime ? normalizeDateForCompare(asset.creationTime) : null;
  if (baseFilename && assetDate && alreadyBaseNameDates && alreadyBaseNameDates.has(baseFilename)) {
    const existingDates = alreadyBaseNameDates.get(baseFilename);
    if (existingDates.has(assetDate)) {
      console.log(`AutoUpload: Skipping ${filename} - baseFilename+date match (${baseFilename}, ${assetDate})`);
      if (staged && staged.tmpCopied && staged.tmpUri) {
        try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
      }
      return { uploaded: 0, skipped: 1, failed: 0, manifestId };
    }
  }

  // Compute hashes for deduplication (same as main upload)
  const isImage = asset.mediaType === 'photo';
  let exactFileHash = null;
  let perceptualHash = null;

  logStep('STEP4', `Computing hashes (isImage=${isImage})`);
  if (isImage) {
    // Images: compute perceptual hash for transcoding-resistant deduplication
    try {
      logStep('STEP4a', 'Computing perceptual hash');
      perceptualHash = await computePerceptualHash(filePath, asset, assetInfo);
      logStep('STEP4a', `Perceptual hash: ${perceptualHash ? 'computed' : 'null'}`);
    } catch (e) {
      logStep('STEP4a', `FAILED: ${e?.message}`);
      console.warn('Background: computePerceptualHash failed:', asset.id, e?.message);
    }
    // Skip if perceptual hash already exists on server
    if (perceptualHash && alreadyPerceptualHashes && findPerceptualHashMatch(perceptualHash, alreadyPerceptualHashes, CROSS_PLATFORM_DHASH_THRESHOLD)) {
      console.log(`AutoUpload: Skipping ${filename} - perceptual hash match on server`);
      if (staged && staged.tmpCopied && staged.tmpUri) {
        try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
      }
      return { uploaded: 0, skipped: 1, failed: 0, manifestId };
    }
    // Also compute exact hash for manifest storage and byte-identical dedup (AirDrop)
    try {
      logStep('STEP4b', 'Computing exact file hash');
      exactFileHash = await computeExactFileHash(filePath);
      logStep('STEP4b', `Exact hash: ${exactFileHash ? 'computed' : 'null'}`);
    } catch (e) {
      logStep('STEP4b', `FAILED: ${e?.message}`);
    }
    // Skip if exact file hash already exists on server (byte-identical, e.g. AirDrop)
    if (exactFileHash && alreadyFileHashes && alreadyFileHashes.has(exactFileHash)) {
      console.log(`AutoUpload: Skipping ${filename} - exact file hash match on server`);
      if (staged && staged.tmpCopied && staged.tmpUri) {
        try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
      }
      return { uploaded: 0, skipped: 1, failed: 0, manifestId };
    }
  } else {
    // Videos: compute exact file hash
    try {
      logStep('STEP4c', 'Computing exact file hash for video');
      exactFileHash = await computeExactFileHash(filePath);
      logStep('STEP4c', `Exact hash: ${exactFileHash ? 'computed' : 'null'}`);
    } catch (e) {
      logStep('STEP4c', `FAILED: ${e?.message}`);
      console.warn('Background: computeExactFileHash failed:', asset.id, e?.message);
    }
    // Skip if exact file hash already exists on server
    if (exactFileHash && alreadyFileHashes && alreadyFileHashes.has(exactFileHash)) {
      console.log(`AutoUpload: Skipping ${filename} - exact file hash match on server`);
      if (staged && staged.tmpCopied && staged.tmpUri) {
        try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
      }
      return { uploaded: 0, skipped: 1, failed: 0, manifestId };
    }
  }

  const fileKey = new Uint8Array(32);
  global.crypto.getRandomValues(fileKey);
  const baseNonce16 = new Uint8Array(16);
  global.crypto.getRandomValues(baseNonce16);
  const wrapNonce = new Uint8Array(24);
  global.crypto.getRandomValues(wrapNonce);
  const wrappedKey = nacl.secretbox(fileKey, wrapNonce, masterKey);

  // Convert filePath to file:// URI for FileSystem operations
  const fileUri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
  if (!fileUri) return { uploaded: 0, skipped: 0, failed: 1 };

  logStep('STEP5', `Starting chunked upload, size=${originalSize}, chunks=${Math.ceil(originalSize / (fastMode ? 4 * MB : 2 * MB))}`);

  let chunkIndex = 0;
  const chunkIds = [];
  const chunkSizes = [];
  const chunkPlainBytes = chooseStealthCloudChunkBytes({ platform: Platform.OS, originalSize, fastMode });
  const effectiveBytes = chunkPlainBytes - (chunkPlainBytes % 3);
  let position = 0;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const quickYield = () => new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 0));

  // Concurrency for fast mode: parallel chunk uploads
  const maxParallel = chooseStealthCloudMaxParallelChunkUploads({ platform: Platform.OS, originalSize, fastMode });
  const runChunkUpload = createConcurrencyLimiter(maxParallel);
  const inFlightUploads = [];

  while (true) {
    let nextB64 = '';
    try {
      nextB64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64, position, length: effectiveBytes });
    } catch (e) { nextB64 = ''; }
    if (!nextB64) break;

    const plaintext = naclUtil.decodeBase64(nextB64);
    if (!plaintext || plaintext.length === 0) break;

    const nonce = makeChunkNonce(baseNonce16, chunkIndex);
    const boxed = nacl.secretbox(plaintext, nonce, fileKey);
    const chunkId = sha256.create().update(boxed).hex();

    if (onStatus) onStatus('uploading');

    // Use concurrent upload via limiter
    console.log(`AutoUpload: Uploading chunk ${chunkIndex + 1}, size=${plaintext.length} bytes, position=${position}`);
    const uploadPromise = runChunkUpload(() => uploadEncryptedChunk({ SERVER_URL, config, chunkId, encryptedBytes: boxed }));
    inFlightUploads.push(uploadPromise);

    chunkIds.push(chunkId);
    chunkSizes.push(plaintext.length);
    chunkIndex += 1;
    position += plaintext.length;

    // Single yield to event loop per chunk (read/encrypt/upload already yield natively)
    await quickYield();

    // Thermal safety: micro-pause in fast mode every 20 chunks (~10ms adds ~0.25s to 500MB)
    if (fastMode && chunkIndex > 0 && chunkIndex % 20 === 0) {
      await sleep(10);
    }

    // Memory relief: hint GC every 20 chunks to prevent memory buildup
    if (chunkIndex % 20 === 0) {
      try { if (global.gc) global.gc(); } catch (e) {}
    }

    if (plaintext.length < effectiveBytes) break;
  }

  // Wait for all in-flight uploads to complete
  logStep('STEP5', `Waiting for ${inFlightUploads.length} in-flight uploads`);
  try {
    await Promise.all(inFlightUploads);
    logStep('STEP5', `All chunks uploaded: ${chunkIds.length} chunks`);
  } catch (e) {
    logStep('STEP5', `CHUNK UPLOAD FAILED: ${e?.message}`);
    return { uploaded: 0, skipped: 0, failed: 1 };
  }

  if (!chunkIds.length) {
    logStep('STEP5', 'FAILED: No chunks uploaded');
    return { uploaded: 0, skipped: 0, failed: 1 };
  }

  logStep('STEP6', 'Extracting EXIF data');
  // Extract EXIF data for all images to store in manifest for cross-platform deduplication
  let exifCaptureTime = null, exifMake = null, exifModel = null;
  if (isImage) {
    try {
      // On iOS, assetInfo.exif is populated; on Android, we need native module
      if (Platform.OS === 'ios') {
        const { extractExifForDedup } = require('./duplicateScanner');
        const exifData = extractExifForDedup(assetInfo, asset);
        if (exifData) {
          exifCaptureTime = exifData.captureTime || null;
          exifMake = exifData.make || null;
          exifModel = exifData.model || null;
        }
      } else {
        // Android: use native ExifExtractor module
        const { NativeModules } = require('react-native');
        const ExifExtractor = NativeModules.ExifExtractor;
        if (ExifExtractor && typeof ExifExtractor.extractExif === 'function') {
          const result = await ExifExtractor.extractExif(filePath);
          if (result) {
            exifCaptureTime = result.captureTime || null;
            exifMake = result.make ? result.make.trim().toLowerCase() : null;
            exifModel = result.model ? result.model.trim().toLowerCase() : null;
          }
        }
      }
    } catch (e) {
      logStep('STEP6', `EXIF extraction failed (non-critical): ${e?.message}`);
      console.warn('AutoUpload: EXIF extraction failed (non-critical):', filename, e?.message);
    }
  }
  logStep('STEP6', `EXIF done: captureTime=${exifCaptureTime}, make=${exifMake}, model=${exifModel}`);

  logStep('STEP7', 'Generating thumbnail');
  // Generate and upload encrypted thumbnail for Sync Select previews (best-effort, matches manual backup)
  let thumbChunkId = null;
  let thumbNonceB64 = null;
  let thumbSize = null;
  let thumbW = null;
  let thumbH = null;
  const thumbMime = 'image/jpeg';
  try {
    const THUMB_WIDTH = 220;
    const THUMB_COMPRESS = 0.6;
    const isVideo = (asset && asset.mediaType === 'video') || /\.(mp4|mov|avi|mkv|m4v|3gp|webm)$/i.test(filename || '');
    const isPhoto = !isVideo;
    let thumbSourceUri = null;
    let tempVideoFrameUri = null;

    if (isVideo) {
      const videoFileUri = filePath && filePath.startsWith('/') ? `file://${filePath}` : filePath;
      if (videoFileUri) {
        for (const time of [0, 500, 1000, 2000]) {
          try {
            const frame = await VideoThumbnails.getThumbnailAsync(videoFileUri, { time });
            if (frame?.uri) {
              thumbSourceUri = frame.uri;
              tempVideoFrameUri = frame.uri;
              break;
            }
          } catch (e) {
            // Try another timestamp
          }
        }
      }
    } else if (isPhoto) {
      thumbSourceUri = filePath && filePath.startsWith('/') ? `file://${filePath}` : filePath;
    }

    if (thumbSourceUri) {
      const manip = await ImageManipulator.manipulateAsync(
        thumbSourceUri,
        [{ resize: { width: THUMB_WIDTH } }],
        { compress: THUMB_COMPRESS, format: ImageManipulator.SaveFormat.JPEG }
      );
      if (manip?.uri) {
        thumbW = typeof manip.width === 'number' ? manip.width : null;
        thumbH = typeof manip.height === 'number' ? manip.height : null;

        const b64 = await FileSystem.readAsStringAsync(manip.uri, { encoding: FileSystem.EncodingType.Base64 });
        const plain = naclUtil.decodeBase64(b64);
        thumbSize = plain?.length || null;
        if (plain && plain.length > 0) {
          const thumbNonce = new Uint8Array(24);
          global.crypto.getRandomValues(thumbNonce);
          const boxed = nacl.secretbox(plain, thumbNonce, masterKey);
          thumbChunkId = sha256.create().update(boxed).hex();
          thumbNonceB64 = naclUtil.encodeBase64(thumbNonce);
          await uploadEncryptedChunk({ SERVER_URL, config, chunkId: thumbChunkId, encryptedBytes: boxed });
          console.log(`AutoUpload: uploaded thumbnail for ${filename}, size=${thumbSize}`);
        }

        try { await FileSystem.deleteAsync(manip.uri, { idempotent: true }); } catch (e) {}
      }
    }

    if (tempVideoFrameUri) {
      try { await FileSystem.deleteAsync(tempVideoFrameUri, { idempotent: true }); } catch (e) {}
    }
  } catch (e) {
    // Best-effort: thumbnail failures must not fail backup
    logStep('STEP7', `Thumbnail FAILED (non-fatal): ${e?.message}`);
    console.warn('AutoUpload: thumbnail generation failed (non-fatal):', filename, e?.message);
  }
  logStep('STEP7', `Thumbnail done: ${thumbChunkId ? 'uploaded' : 'skipped'}, ${thumbW}x${thumbH}`);

  logStep('STEP8', 'Building and uploading manifest');
  const manifest = {
    v: 1, assetId: asset.id, filename: assetInfo.filename || asset.filename || null,
    mediaType: asset.mediaType || null, originalSize: originalSize,
    creationTime: asset.creationTime || null,
    baseNonce16: naclUtil.encodeBase64(baseNonce16), wrapNonce: naclUtil.encodeBase64(wrapNonce),
    wrappedFileKey: naclUtil.encodeBase64(wrappedKey), chunkIds, chunkSizes,
    fileHash: exactFileHash, perceptualHash: perceptualHash,
    exifCaptureTime, exifMake, exifModel,
    thumbChunkId, thumbNonce: thumbNonceB64, thumbSize, thumbW, thumbH, thumbMime
  };
  const manifestPlain = naclUtil.decodeUTF8(JSON.stringify(manifest));
  const manifestNonce = new Uint8Array(24);
  global.crypto.getRandomValues(manifestNonce);
  const manifestBox = nacl.secretbox(manifestPlain, manifestNonce, masterKey);
  const encryptedManifest = JSON.stringify({ manifestNonce: naclUtil.encodeBase64(manifestNonce), manifestBox: naclUtil.encodeBase64(manifestBox) });

  try {
    // Retry manifest upload up to 11 times with exponential backoff
    await withRetries(async () => {
      await axios.post(`${SERVER_URL}/api/cloud/manifests`, { 
        manifestId, 
        encryptedManifest, 
        chunkCount: chunkIds.length,
        // Include metadata for fast dedup (matches manual backup)
        filename,
        mediaType: asset?.mediaType || null,
        originalSize,
        fileHash: exactFileHash,
        perceptualHash,
        creationTime: asset.creationTime,
        // EXIF metadata for cross-platform HEIC deduplication
        exifCaptureTime,
        exifMake,
        exifModel,
        thumbChunkId,
        thumbNonce: thumbNonceB64,
        thumbSize,
        thumbW,
        thumbH,
        thumbMime
      }, { headers: config.headers, timeout: 30000 });
    }, { retries: 10, baseDelayMs: 1000, maxDelayMs: 30000, shouldRetry: shouldRetryChunkUpload });
  } catch (e) {
    logStep('STEP8', `Manifest upload FAILED: ${e?.message}`);
    console.warn('Background: manifest upload failed after retries:', manifestId, e?.message);
    return { uploaded: 0, skipped: 0, failed: 1 };
  }
  logStep('STEP8', 'Manifest uploaded successfully');

  logStep('STEP9', 'Storing full EXIF (fire-and-forget)');
  // Store full EXIF to server for universal cross-platform preservation (matches manual backup)
  // Fire-and-forget, non-blocking - store full EXIF to server
  const isImageForExif = asset.mediaType === 'photo' || /\.(jpg|jpeg|png|heic|heif|gif|bmp|webp|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|avif|psd|psb|exr|hdr)$/i.test(filename || '');
  if (exactFileHash && isImageForExif) {
    try {
      let fullExif = null;
      if (Platform.OS === 'ios') {
        const { extractFullExif } = require('./exifExtractor');
        fullExif = extractFullExif(assetInfo, asset);
      } else {
        // Android: use native ExifExtractor for full EXIF
        const { NativeModules } = require('react-native');
        const ExifExtractor = NativeModules.ExifExtractor;
        if (ExifExtractor && typeof ExifExtractor.extractExif === 'function') {
          const nativeExif = await ExifExtractor.extractExif(filePath);
          if (nativeExif) {
            fullExif = {
              captureTime: nativeExif.captureTime || null,
              make: nativeExif.make || null,
              model: nativeExif.model || null,
              offsetTimeOriginal: nativeExif.offsetTimeOriginal || null,
              subSecTimeOriginal: nativeExif.subSecTimeOriginal || null,
              exposureTime: nativeExif.exposureTime || null,
              fNumber: nativeExif.fNumber || null,
              iso: nativeExif.iso || null,
              focalLength: nativeExif.focalLength || null,
              focalLengthIn35mm: nativeExif.focalLengthIn35mm || null,
              flash: nativeExif.flash || null,
              whiteBalance: nativeExif.whiteBalance || null,
              meteringMode: nativeExif.meteringMode || null,
              exposureProgram: nativeExif.exposureProgram || null,
              exposureBias: nativeExif.exposureBias || null,
              width: nativeExif.width || null,
              height: nativeExif.height || null,
              orientation: nativeExif.orientation || null,
              colorSpace: nativeExif.colorSpace || null,
              gpsLatitude: nativeExif.gpsLatitude || asset.location?.latitude || null,
              gpsLongitude: nativeExif.gpsLongitude || asset.location?.longitude || null,
              gpsAltitude: nativeExif.gpsAltitude || null,
              gpsDateStamp: nativeExif.gpsDateStamp || null,
              gpsTimestamp: nativeExif.gpsTimestamp || null,
              software: nativeExif.software || null,
              lensMake: nativeExif.lensMake || null,
              lensModel: nativeExif.lensModel || null,
            };
          }
        }
      }
      if (fullExif && (fullExif.captureTime || fullExif.make || fullExif.gpsLatitude != null)) {
        axios.post(
          `${SERVER_URL}/api/exif/store`,
          { fileHash: exactFileHash, exif: fullExif, platform: Platform.OS },
          { headers: config.headers, timeout: 10000 }
        ).catch(e => console.log('[AutoUpload EXIF] Store failed (non-critical):', e?.message));
      }
    } catch (e) {
      // Non-critical - don't fail upload if EXIF storage fails
    }
  }

  // Cleanup temp file
  if (staged && staged.tmpCopied && staged.tmpUri) {
    try { await FileSystem.deleteAsync(staged.tmpUri, { idempotent: true }); } catch (e) {}
  }

  logStep('COMPLETE', `Successfully uploaded ${filename}`);
  return { uploaded: 1, skipped: 0, failed: 0, manifestId, perceptualHash, fileHash: exactFileHash, filename };
};

// Concurrency helpers
export const chooseStealthCloudChunkBytes = ({ platform, originalSize, fastMode = false }) => {
  const size = typeof originalSize === 'number' && originalSize > 0 ? originalSize : 0;
  if (fastMode) {
    if (size >= 1024 * MB) return 4 * MB;       // >=1GB: 4MB
    if (size >= 200 * MB) return 2 * MB;         // 200MB-1GB: 2MB
    if (size >= 50 * MB) return 1 * MB;          // 50-200MB: 1MB
    return 512 * 1024;                             // <50MB: 512KB
  }
  // Normal mode: larger chunks for large files to reduce per-chunk overhead
  if (size >= 1024 * MB) return 2 * MB;          // >=1GB: 2MB
  if (size >= 200 * MB) return 1 * MB;           // 200MB-1GB: 1MB
  if (size >= 50 * MB) return 768 * 1024;        // 50-200MB: 768KB
  return 512 * 1024;                              // <50MB: 512KB
};

let _deviceCapabilityCache = null;

export const getDeviceCapability = async () => {
  if (_deviceCapabilityCache) return _deviceCapabilityCache;

  let tier = 'medium';

  try {
    if (Platform.OS === 'android') {
      const totalMem = Device.totalMemory;
      if (totalMem) {
        const gb = totalMem / (1024 * 1024 * 1024);
        if (gb < 3) tier = 'low';
        else if (gb < 6) tier = 'medium';
        else tier = 'high';
      }
    } else {
      const model = Device.modelName || '';
      if (/Pro\s*Max|15\s*Pro|16\s*Pro/.test(model)) tier = 'high';
      else if (/12|13|14|15|16|iPhone\s*SE\s*3/.test(model)) tier = 'medium';
      else tier = 'low';
    }
  } catch (e) {
    console.warn('[Concurrency] Device capability check failed:', e?.message);
  }

  _deviceCapabilityCache = tier;
  console.log(`[Concurrency] Device capability: ${tier}`);
  return tier;
};

const _getCachedCapability = () => _deviceCapabilityCache || 'medium';

export const chooseStealthCloudMaxParallelChunkUploads = ({ platform, originalSize, fastMode = false }) => {
  const capability = _getCachedCapability();
  const base = fastMode
    ? (platform === 'android' ? 10 : 8)
    : (platform === 'android' ? 4 : 3);

  const multipliers = { low: 0.5, medium: 1.0, high: 1.5 };
  const cap = Math.max(1, Math.round(base * (multipliers[capability] || 1.0)));
  const maxCap = fastMode ? 14 : 7;
  return Math.min(cap, maxCap);
};

export const chooseFileParallelUploads = ({ platform, fastMode = false }) => {
  const capability = _getCachedCapability();
  const base = fastMode
    ? (platform === 'android' ? 6 : 5)
    : (platform === 'android' ? 4 : 3);

  const multipliers = { low: 0.5, medium: 1.0, high: 1.75 };
  const cap = Math.max(1, Math.round(base * (multipliers[capability] || 1.0)));
  const maxCap = fastMode ? 10 : 6;
  return Math.min(cap, maxCap);
};

export const chooseFileParallelDownloads = ({ platform, fastMode = false }) => {
  const capability = _getCachedCapability();
  const base = fastMode
    ? (platform === 'android' ? 4 : 3)
    : (platform === 'android' ? 3 : 1);

  const multipliers = { low: 0.5, medium: 1.0, high: 1.5 };
  const cap = Math.max(1, Math.round(base * (multipliers[capability] || 1.0)));
  const maxCap = fastMode ? 6 : 4;
  return Math.min(cap, maxCap);
};

export const createConcurrencyLimiter = (maxParallel) => {
  const max = Math.max(1, Number(maxParallel) || 1);
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < max && queue.length) {
      const next = queue.shift();
      if (!next) break;
      active += 1;
      Promise.resolve().then(next.fn).then(next.resolve, next.reject).finally(() => { active -= 1; pump(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
};

export const trackInFlightPromise = async (inFlight, p, maxInFlight) => {
  inFlight.add(p);
  const cleanup = () => { try { inFlight.delete(p); } catch (e) {} };
  p.then(cleanup, cleanup);
  if (inFlight.size >= maxInFlight) await Promise.race(inFlight);
};

export const drainInFlightPromises = async (inFlight) => {
  if (!inFlight || inFlight.size === 0) return;
  await Promise.all(Array.from(inFlight));
};

// Register background task
export const registerBackgroundTask = () => {
  TaskManager.defineTask(AUTO_UPLOAD_BACKGROUND_TASK, async () => {
    try {
      console.log('Background task called');
      const enabled = await SecureStore.getItemAsync('auto_upload_enabled');
      if (enabled !== 'true') return BackgroundFetch.BackgroundFetchResult.NoData;

      const serverType = await SecureStore.getItemAsync('server_type');
      console.log('Server type:', serverType);
      if (serverType !== 'stealthcloud') return BackgroundFetch.BackgroundFetchResult.NoData;

      const perm = await MediaLibrary.getPermissionsAsync();
      console.log('Perm:', perm);
      if (!perm || perm.status !== 'granted') return BackgroundFetch.BackgroundFetchResult.NoData;

      const el = await autoUploadEligibilityForBackground();
      console.log('Eligibility:', el);
      if (!el.ok) return BackgroundFetch.BackgroundFetchResult.NoData;

      const config = await autoUploadGetAuthHeadersFromSecureStore();
      console.log('Config:', config ? 'ok' : 'null');
      if (!config) return BackgroundFetch.BackgroundFetchResult.NoData;

      console.log('Policy ok, starting background upload');

      const SERVER_URL = 'https://stealthlynk.io';

      const startedAt = Date.now();
      const timeBudgetMs = Platform.OS === 'ios' ? 25000 : 4 * 60 * 1000;
      const maxUploadsPerRun = Platform.OS === 'ios' ? 8 : 1000000;
      const pageSize = Platform.OS === 'ios' ? 60 : 120;

      let existingManifests = [];
      try {
        const listRes = await axios.get(`${SERVER_URL}/api/cloud/manifests`, config);
        existingManifests = (listRes.data && listRes.data.manifests) ? listRes.data.manifests : [];
      } catch (e) {
        existingManifests = [];
      }
      console.log('Existing manifests:', existingManifests.length);
      const already = new Set(existingManifests.map(m => m.manifestId));

      // Get PhotoLynkDeleted album asset IDs to exclude from auto-upload (Android only)
      let photoLynkDeletedAssetIds = new Set();
      if (Platform.OS === 'android') {
        try {
          const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
          const deletedAlbum = albums.find(a => a.title === 'PhotoLynkDeleted');
          if (deletedAlbum) {
            const deletedPage = await MediaLibrary.getAssetsAsync({
              first: 10000,
              album: deletedAlbum.id,
              mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
            });
            if (deletedPage?.assets) {
              for (const asset of deletedPage.assets) {
                photoLynkDeletedAssetIds.add(asset.id);
              }
            }
            console.log('[AutoUpload] Excluding', photoLynkDeletedAssetIds.size, 'assets from PhotoLynkDeleted');
          }
        } catch (e) {
          console.log('[AutoUpload] Could not get PhotoLynkDeleted album:', e?.message);
        }
      }

      let after = null;
      try {
        const savedCursor = await SecureStore.getItemAsync(AUTO_UPLOAD_CURSOR_KEY);
        after = savedCursor ? savedCursor : null;
      } catch (e) {
        after = null;
      }
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      console.log('Starting upload loop');
      while (true) {
        if (uploaded >= maxUploadsPerRun) break;
        if (Date.now() - startedAt >= timeBudgetMs) break;

        const page = await MediaLibrary.getAssetsAsync({
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          first: pageSize,
          after: after || undefined,
          sortBy: [MediaLibrary.SortBy.creationTime]
        });
        const assets = page && Array.isArray(page.assets) ? page.assets : [];
        if (!assets.length) break;

        for (const asset of assets) {
          if (uploaded >= maxUploadsPerRun) break;
          if (Date.now() - startedAt >= timeBudgetMs) break;
          if (!asset || !asset.id) continue;
          // Skip assets in PhotoLynkDeleted album (Android)
          if (photoLynkDeletedAssetIds.has(asset.id)) {
            skipped += 1;
            continue;
          }
          const manifestId = sha256(`asset:${asset.id}`);
          if (already.has(manifestId)) {
            skipped += 1;
            continue;
          }
          const r = await autoUploadStealthCloudUploadOneAsset({ asset, config, SERVER_URL, existingManifestIds: already });
          if (r && r.uploaded) {
            uploaded += 1;
            already.add(manifestId);
          } else if (r && r.skipped) {
            skipped += 1;
            already.add(manifestId);
          } else {
            failed += 1;
          }
        }

        after = page && page.endCursor ? page.endCursor : null;
        try {
          if (after) await SecureStore.setItemAsync(AUTO_UPLOAD_CURSOR_KEY, after);
        } catch (e) {}
        if (!page || page.hasNextPage !== true || !after) break;
      }

      try {
        if (!after) await SecureStore.deleteItemAsync(AUTO_UPLOAD_CURSOR_KEY);
      } catch (e) {}

      try {
        await SecureStore.setItemAsync('auto_upload_last_run', new Date().toISOString());
        await SecureStore.setItemAsync('auto_upload_last_summary', JSON.stringify({ uploaded, skipped, failed }));
      } catch (e) {}

      if (uploaded > 0) return BackgroundFetch.BackgroundFetchResult.NewData;
      return BackgroundFetch.BackgroundFetchResult.NoData;
    } catch (e) {
      try {
        await SecureStore.setItemAsync('auto_upload_last_run', new Date().toISOString());
        await SecureStore.setItemAsync('auto_upload_last_summary', JSON.stringify({ error: (e && e.message) ? e.message : 'failed' }));
      } catch (err) {}
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
};

// Call this at module load to register the task
registerBackgroundTask();
