/**
 * duplicateScannerOptimized.js
 * 
 * Optimized duplicate scanning with proper yielding, progress updates, and UI responsiveness.
 * Handles 100s to 10,000s of files without freezing.
 * 
 * Key optimizations:
 * - requestAnimationFrame yielding for true UI responsiveness
 * - Paginated asset collection (250 per page)
 * - Per-file progress updates with throttling
 * - Batched comparison with yields
 * - Proper abort handling
 * - Thermal cooldowns for heavy operations
 */

import { Platform, NativeModules } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { sha256 } from 'js-sha256';
import naclUtil from 'tweetnacl-util';
import { t } from './i18n';
import {
  extractExifForDedup,
  generateExifDedupKeys,
  extractBaseFilename,
  normalizeDateForCompare,
} from './duplicateScanner';
import {
  loadHashCache,
  getCachedHash,
  setCachedHash,
  getAllCachedHashes,
  setAllCachedHashes,
  getCacheStatus,
  flushHashCache,
  abortPreAnalysis,
} from './hashCache';
const { PixelHash, MediaDelete } = NativeModules;

// ============================================================================
// CONSTANTS
// ============================================================================

const PAGE_SIZE = 500; // Assets per page for collection (larger = fewer API calls)
const PROGRESS_THROTTLE_MS = 300; // Throttle progress updates (less frequent = faster)
const YIELD_EVERY_N_FILES = 12; // Yield to UI every N files (lower = more responsive)
const YIELD_EVERY_N_COMPARISONS = 800; // Yield during O(n²) comparison (lower = more responsive)
const THERMAL_COOLDOWN_MS = 10; // Cooldown after heavy batches (shorter = faster)
const MAX_VIDEO_HASH_SIZE = 2 * 1024 * 1024 * 1024; // 2GB — skip hashing larger videos to avoid 30s+ stalls

// Hash thresholds
const SIMILAR_THRESHOLD = 24;
const CROSS_PLATFORM_DHASH_THRESHOLD = 2; // 2 bits = ~3% tolerance for cross-device image encoding differences
const SUPPORTED_VIDEO_RE = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|3g2|wmv|flv|mpg|mpeg|mts|m2ts)$/i;
const EDGE_MATCH_THRESHOLD = 4;
const CORNER_MATCH_THRESHOLD = 3;

// ============================================================================
// YIELDING UTILITIES
// ============================================================================

/**
 * Yield to UI — use setTimeout(0) for reliable event-loop yielding.
 * requestAnimationFrame defers to the next frame and fails to break up
 * long tasks when the JS thread is continuously busy.
 */
const yieldToUi = () => new Promise(resolve => {
  setTimeout(resolve, 0);
});

/**
 * Quick yield for tight loops
 */
const quickYield = () => new Promise(resolve => {
  if (typeof setImmediate !== 'undefined') {
    setImmediate(resolve);
  } else {
    setTimeout(resolve, 0);
  }
});

/**
 * Thermal cooldown after heavy operations
 */
const thermalCooldown = (ms = THERMAL_COOLDOWN_MS) => new Promise(r => setTimeout(r, ms));

/**
 * Wrap a promise with a timeout to prevent indefinite hanging on a single file.
 */
const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  promise.then((res) => { clearTimeout(timer); resolve(res); }, (err) => { clearTimeout(timer); reject(err); });
});

// ============================================================================
// PROGRESS UTILITIES
// ============================================================================

let lastProgressUpdate = 0;
let lastStatusUpdate = 0;

const updateProgress = (onProgress, value, force = false) => {
  if (!onProgress) return;
  const now = Date.now();
  if (force || now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
    lastProgressUpdate = now;
    onProgress(Math.min(1, Math.max(0, value)));
  }
};

const updateStatus = (onStatus, message, force = false) => {
  if (!onStatus) return;
  const now = Date.now();
  if (force || now - lastStatusUpdate >= PROGRESS_THROTTLE_MS) {
    lastStatusUpdate = now;
    onStatus(message);
  }
};

// ============================================================================
// TIMESTAMP PARSER
// ============================================================================

const parseTs = (val) => {
  if (!val) return 0;
  if (typeof val === 'number') {
    if (val > 0 && val < 946684800000) return val * 1000;
    return val > 0 ? val : 0;
  }
  const parsed = new Date(val).getTime();
  return (!isNaN(parsed) && parsed > 0) ? parsed : 0;
};

// ============================================================================
// HASH UTILITIES (copied from original)
// ============================================================================

const hammingDistance64 = (a, b) => {
  if (!a || !b || a.length !== 16 || b.length !== 16) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < 16; i += 8) {
    const valA = parseInt(a.substring(i, i + 8), 16);
    const valB = parseInt(b.substring(i, i + 8), 16);
    let x = valA ^ valB;
    while (x) {
      dist += x & 1;
      x >>>= 1;
    }
  }
  return dist;
};

const hammingDistance32 = (a, b) => {
  if (!a || !b || a.length !== 8 || b.length !== 8) return Number.MAX_SAFE_INTEGER;
  const valA = parseInt(a, 16);
  const valB = parseInt(b, 16);
  let x = valA ^ valB;
  let dist = 0;
  while (x) {
    dist += x & 1;
    x >>>= 1;
  }
  return dist;
};

const hammingDistance16 = (a, b) => {
  if (!a || !b || a.length !== 4 || b.length !== 4) return Number.MAX_SAFE_INTEGER;
  const valA = parseInt(a, 16);
  const valB = parseInt(b, 16);
  let x = valA ^ valB;
  let dist = 0;
  while (x) {
    dist += x & 1;
    x >>>= 1;
  }
  return dist;
};

// ============================================================================
// FILE UTILITIES (copied from original)
// ============================================================================

const isImageAsset = (info, asset) => {
  const mt = (info && info.mediaType) || asset.mediaType;
  if (mt === 'photo' || mt === 'image') return true;
  const name = (info && info.filename) || asset.filename || '';
  return /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?|raw|cr2|nef|arw|dng|orf|rw2|pef|srw|raf|psd|psb|exr|hdr|avif)$/i.test(name);
};

const isVideoAsset = (info, asset) => {
  const mt = (info && info.mediaType) || asset.mediaType;
  if (mt === 'video') return true;
  const name = (info && info.filename) || asset.filename || '';
  return SUPPORTED_VIDEO_RE.test(name);
};

/**
 * Fast video fingerprint — hashes only the first 8KB + uses file size.
 * Full-file SHA-256 of multi-GB videos blocks the JS thread for minutes.
 * Two identical videos will always have identical size and first 8KB.
 */
const computeFastVideoFingerprint = async (filePath, fileSize, filename = '') => {
  // 8KB is enough for unique video headers (moov, ftyp, etc.) and avoids
  // slow content-provider I/O on Android that can buffer the entire file.
  const HEAD_BYTES = 8 * 1024;
  const fileUri = filePath.startsWith('/') ? `file://${filePath}` : filePath;
  const basename = (filename || '').replace(/\.[^/.]+$/, '');

  // On Android, expo-file-system may allocate the entire file in memory
  // before slicing, causing OOM even with length: 64KB. Catch gracefully.
  try {
    const b64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      length: HEAD_BYTES,
    });
    const plaintext = naclUtil.decodeBase64(b64);
    const headHash = sha256(plaintext);
    // Prefix with size so different-size files never collide
    return `${fileSize}:${headHash}`;
  } catch (e) {
    // OOM or read failure — fall back to size+basename fingerprint.
    // Same video renamed or converted to different format will still match.
    return basename ? `sizeonly:${fileSize}.${basename}` : `sizeonly:${fileSize}`;
  }
};

/**
 * Compute exact file hash using chunked streaming (handles large videos)
 */
const computeExactFileHash = async (filePath) => {
  try {
    const hashCtx = sha256.create();
    const HASH_CHUNK_BYTES = 256 * 1024; // 256KB chunks

    if (Platform.OS === 'ios') {
      const fileUri = filePath.startsWith('/') ? `file://${filePath}` : filePath;
      let position = 0;
      // Ensure chunk size is divisible by 3 for base64
      const effectiveBytes = HASH_CHUNK_BYTES - (HASH_CHUNK_BYTES % 3);
      
      while (true) {
        let nextB64 = '';
        try {
          nextB64 = await FileSystem.readAsStringAsync(fileUri, {
            encoding: FileSystem.EncodingType.Base64,
            position,
            length: effectiveBytes
          });
        } catch (e) {
          // Fallback: read entire file (for older expo-file-system)
          const allB64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
          const b64Offset = Math.floor((position / 3) * 4);
          const chunkB64Len = (effectiveBytes / 3) * 4;
          nextB64 = allB64.slice(b64Offset, b64Offset + chunkB64Len);
        }
        if (!nextB64) break;
        const plaintext = naclUtil.decodeBase64(nextB64);
        if (!plaintext || plaintext.length === 0) break;
        hashCtx.update(plaintext);
        position += plaintext.length;
        if (plaintext.length < effectiveBytes) break;
        
        // Yield between chunks for large files
        await quickYield();
      }
    } else {
      // Android: use react-native-blob-util for streaming
      let ReactNativeBlobUtil = null;
      try {
        const mod = require('react-native-blob-util');
        ReactNativeBlobUtil = mod && (mod.default || mod);
      } catch (e) {}
      
      if (!ReactNativeBlobUtil || !ReactNativeBlobUtil.fs || typeof ReactNativeBlobUtil.fs.readStream !== 'function') {
        // Fallback: read entire file (only for small files to avoid OOM / hang)
        const fileUri = filePath.startsWith('/') ? `file://${filePath}` : filePath;
        const info = await FileSystem.getInfoAsync(fileUri, { size: true });
        const fileSize = info?.size || 0;
        if (fileSize > 50 * 1024 * 1024) {
          console.warn('[DupScanner] File too large for fallback hash (>50MB):', filePath);
          return null;
        }
        const b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
        const bytes = naclUtil.decodeBase64(b64);
        return sha256(bytes);
      }

      const stream = await ReactNativeBlobUtil.fs.readStream(filePath, 'base64', HASH_CHUNK_BYTES);
      let chunkCount = 0;
      await new Promise((resolve, reject) => {
        const queue = [];
        let draining = false;
        let ended = false;
        stream.open();
        stream.onData((chunkB64) => {
          queue.push(chunkB64);
          if (draining) return;
          draining = true;
          (async () => {
            try {
              while (queue.length) {
                const nextB64 = queue.shift();
                const plaintext = naclUtil.decodeBase64(nextB64);
                hashCtx.update(plaintext);
                chunkCount++;
                // Yield every 20 chunks to prevent JS thread blocking on large videos
                if (chunkCount % 20 === 0) {
                  await quickYield();
                }
              }
            } catch (e) {
              reject(e);
              return;
            } finally {
              draining = false;
            }
            if (ended && queue.length === 0) resolve();
          })();
        });
        stream.onError((e) => reject(e));
        stream.onEnd(() => {
          ended = true;
          if (!draining && queue.length === 0) resolve();
        });
      });
    }
    return hashCtx.hex();
  } catch (e) {
    console.warn('[DupScanner] computeExactFileHash failed:', e?.message || e);
    return null;
  }
};

/**
 * Resolve readable file path for an asset
 * Handles ph://, content://, file:// URIs properly
 */
const getHashTarget = async ({ asset, info, resolveReadableFilePath }) => {
  let hashTarget = null;
  let tmpCopied = false;
  let tmpUri = null;
  const rawUri = (info && (info.localUri || info.uri)) || asset.uri || null;

  const asFileUri = (p) => {
    if (!p || typeof p !== 'string') return null;
    if (p.startsWith('file://')) return p;
    if (p.startsWith('/')) return `file://${p}`;
    return p;
  };

  const hasNonEmptyFile = async (p) => {
    try {
      const uri = asFileUri(p);
      if (!uri) return false;
      const inf = await FileSystem.getInfoAsync(uri, { size: true });
      if (!inf?.exists) return false;
      if (typeof inf?.size === 'number' && inf.size <= 0) return false;
      return true;
    } catch (e) {
      return true;
    }
  };

  try {
    if (rawUri && typeof rawUri === 'string') {
      if (rawUri.startsWith('file://') || rawUri.startsWith('/')) {
        // Direct file path - use as-is
        hashTarget = rawUri.startsWith('file://') ? rawUri.replace('file://', '') : rawUri;
        // Clean up query/fragment
        const hashIdx = hashTarget.indexOf('#');
        if (hashIdx !== -1) hashTarget = hashTarget.slice(0, hashIdx);
        const qIdx = hashTarget.indexOf('?');
        if (qIdx !== -1) hashTarget = hashTarget.slice(0, qIdx);
        try { hashTarget = decodeURI(hashTarget); } catch (e) {}
      } else if (rawUri.startsWith('ph://') || rawUri.startsWith('content://')) {
        // Need to stage to temp file via resolveReadableFilePath
        if (resolveReadableFilePath && typeof resolveReadableFilePath === 'function') {
          try {
            const resolved = await resolveReadableFilePath({ assetId: asset.id, assetInfo: info });
            if (resolved && resolved.filePath) {
              hashTarget = resolved.filePath;
              tmpCopied = !!resolved.tmpCopied;
              tmpUri = resolved.tmpUri || null;
            }
          } catch (e) {
            // iOS fallback: try with shouldDownloadFromNetwork
            if (Platform.OS === 'ios') {
              try {
                const infoDownloaded = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true });
                const dlUri = infoDownloaded?.localUri || infoDownloaded?.uri;
                if (dlUri && typeof dlUri === 'string' && (dlUri.startsWith('file://') || dlUri.startsWith('/'))) {
                  hashTarget = dlUri.startsWith('file://') ? dlUri.replace('file://', '') : dlUri;
                } else {
                  const resolved2 = await resolveReadableFilePath({ assetId: asset.id, assetInfo: infoDownloaded });
                  if (resolved2 && resolved2.filePath) {
                    hashTarget = resolved2.filePath;
                    tmpCopied = !!resolved2.tmpCopied;
                    tmpUri = resolved2.tmpUri || null;
                  }
                }
              } catch (e2) {
                // Failed to get readable path
              }
            }
          }
        }
      }
    }
    
    // Fallback: try resolveReadableFilePath directly
    if (!hashTarget && resolveReadableFilePath && typeof resolveReadableFilePath === 'function') {
      try {
        const resolved = await resolveReadableFilePath({ assetId: asset.id, assetInfo: info });
        if (resolved && resolved.filePath) {
          hashTarget = resolved.filePath;
          tmpCopied = !!resolved.tmpCopied;
          tmpUri = resolved.tmpUri || null;
        }
      } catch (e) {
        // Silent fail
      }
    }
  } catch (e) {
    // Silent fail
  }

  if (hashTarget) {
    const ok = await hasNonEmptyFile(hashTarget);
    if (!ok && resolveReadableFilePath && typeof resolveReadableFilePath === 'function') {
      try {
        const resolved = await resolveReadableFilePath({ assetId: asset.id, assetInfo: info });
        if (resolved && resolved.filePath) {
          hashTarget = resolved.filePath;
          tmpCopied = !!resolved.tmpCopied;
          tmpUri = resolved.tmpUri || null;
        }
      } catch (e) {
        // Silent fail
      }
    }
    const ok2 = await hasNonEmptyFile(hashTarget);
    if (!ok2) {
      hashTarget = null;
      tmpCopied = false;
      tmpUri = null;
    }
  }

  return { hashTarget, tmpCopied, tmpUri, rawUri };
};

// ============================================================================
// OPTIMIZED ASSET COLLECTION
// ============================================================================

/**
 * Collect assets with pagination and proper yielding
 * Excludes PhotoLynkDeleted album (Android only) to avoid re-detecting moved duplicates
 * Matches backup collection logic exactly for consistent file counts
 */
const collectAssetsPaged = async ({
  includeVideos = false,
  onStatus,
  onProgress,
  progressStart = 0,
  progressEnd = 0.1,
  analyzingTotalStatusKey = 'status.scanningAnalyzingTotal',
  abortRef,
  statusPrefix = 'Comparing',
}) => {
  const mediaTypes = includeVideos ? ['photo', 'video'] : ['photo'];
  const allAssets = [];
  const seenIds = new Set();
  let after = null;
  
  // Get PhotoLynkDeleted album asset IDs to exclude (Android only - iOS uses Recently Deleted which is auto-excluded)
  let photoLynkDeletedAssetIds = new Set();
  if (Platform.OS === 'android') {
    try {
      // Try both includeSmartAlbums false and true — some Android ROMs classify
      // app-created folders differently and the album may be missing in one query.
      const albumsNoSmart = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
      const albumsWithSmart = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
      const allAlbums = [...albumsNoSmart, ...albumsWithSmart];
      const deletedAlbum = allAlbums.find(a => a.title && a.title.toLowerCase() === 'photolynkdeleted');
      if (deletedAlbum) {
        let deletedAfter = null;
        while (true) {
          const deletedPage = await MediaLibrary.getAssetsAsync({
            first: PAGE_SIZE,
            after: deletedAfter || undefined,
            album: deletedAlbum.id,
            mediaType: mediaTypes,
          });
          if (deletedPage?.assets) {
            for (const asset of deletedPage.assets) {
              photoLynkDeletedAssetIds.add(asset.id);
            }
          }
          deletedAfter = deletedPage?.endCursor;
          if (!deletedPage?.hasNextPage) break;
          if (!deletedPage?.assets?.length) break;
        }
        console.log('[DupScanner] Excluding', photoLynkDeletedAssetIds.size, 'assets from PhotoLynkDeleted');
      } else {
        console.log('[DupScanner] PhotoLynkDeleted album not found');
      }
    } catch (e) {
      console.log('[DupScanner] Could not get PhotoLynkDeleted album:', e?.message);
    }
  }
  
  // Show scanning status
  updateStatus(onStatus, t('status.scanningCollecting'), true);
  updateProgress(onProgress, progressStart, true);

  // Phase 1: Collect from main library (paged) - matches backup exactly
  let excludedCount = 0;
  while (true) {
    if (abortRef?.current) return { assets: allAssets, aborted: true };

    const page = await MediaLibrary.getAssetsAsync({
      first: PAGE_SIZE,
      after: after || undefined,
      mediaType: mediaTypes,
      sortBy: Platform.OS === 'ios' ? [MediaLibrary.SortBy.creationTime] : undefined,
    });

    const assets = page?.assets || [];
    for (const asset of assets) {
      // Skip assets in PhotoLynkDeleted album (Android) — album IDs
      if (photoLynkDeletedAssetIds.has(asset.id)) {
        excludedCount++;
        continue;
      }
      // Belt-and-suspenders: also skip by URI path if album lookup failed
      const uri = asset?.uri || '';
      const localUri = asset?.localUri || '';
      if (uri.toLowerCase().includes('/photolynkdeleted/') || localUri.toLowerCase().includes('/photolynkdeleted/')) {
        excludedCount++;
        continue;
      }
      if (!seenIds.has(asset.id)) {
        seenIds.add(asset.id);
        allAssets.push(asset);
      }
    }

    // Update status with actual collected count
    updateStatus(onStatus, t(analyzingTotalStatusKey, { total: allAssets.length }));

    after = page?.endCursor;
    if (!page?.hasNextPage) break;
    if (assets.length === 0) break;
    await yieldToUi();
  }

  // Phase 2: Scan ALL albums to catch Screenshots, Downloads, WhatsApp, user folders, etc.
  try {
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    for (let i = 0; i < albums.length; i++) {
      if (abortRef?.current) return { assets: allAssets, aborted: true };

      const album = albums[i];

      // Skip PhotoLynkDeleted album entirely (Android)
      if (album.title && album.title.toLowerCase() === 'photolynkdeleted') continue;

      try {
        let albumAfter = null;
        while (true) {
          const albumPage = await MediaLibrary.getAssetsAsync({
            first: PAGE_SIZE,
            after: albumAfter || undefined,
            album: album.id,
            mediaType: mediaTypes,
          });

          const albumAssets = albumPage?.assets || [];
          for (const asset of albumAssets) {
            // Skip assets in PhotoLynkDeleted album (Android) — album IDs
            if (photoLynkDeletedAssetIds.has(asset.id)) {
              excludedCount++;
              continue;
            }
            // Belt-and-suspenders: also skip by URI path if album lookup failed
            const uri = asset?.uri || '';
            const localUri = asset?.localUri || '';
            if (uri.toLowerCase().includes('/photolynkdeleted/') || localUri.toLowerCase().includes('/photolynkdeleted/')) {
              excludedCount++;
              continue;
            }
            if (!seenIds.has(asset.id)) {
              seenIds.add(asset.id);
              allAssets.push(asset);
            }
          }
          
          albumAfter = albumPage?.endCursor;
          if (!albumPage?.hasNextPage || albumAssets.length === 0) break;
        }
      } catch (e) {
        // Skip failed albums
      }

      // Yield every few albums and update status
      if (i % 5 === 0) {
        await yieldToUi();
        updateStatus(onStatus, t(analyzingTotalStatusKey, { total: allAssets.length }));
      }
    }
  } catch (e) {
    console.log('[DupScanner] Album scan error:', e?.message);
  }

  // Final status with actual total
  updateStatus(onStatus, t(analyzingTotalStatusKey, { total: allAssets.length }));
  updateProgress(onProgress, progressEnd, true);
  console.log('[DupScanner] Total assets collected:', allAssets.length, '(excluded', excludedCount, 'PhotoLynkDeleted)');
  return { assets: allAssets, aborted: false };
};

// ============================================================================
// OPTIMIZED EXACT DUPLICATES SCAN
// ============================================================================

/**
 * Scan for exact duplicates with proper yielding and progress
 * 
 * Progress phases:
 * - 0-10%: Collecting assets
 * - 10-90%: Hashing files (per-file progress)
 * - 90-95%: Grouping duplicates
 * - 95-100%: Finalizing
 */
export const scanExactDuplicates = async ({
  resolveReadableFilePath,
  onProgress,
  onStatus,
  abortRef,
  includeVideos = false,
}) => {
  console.log('[DupScanner] Starting optimized exact duplicate scan');
  
  // Abort any running background pre-analysis to avoid race conditions
  await abortPreAnalysis('scanExactDuplicates');
  
  // Load hash cache for faster subsequent runs
  await loadHashCache();
  
  const hasPixelHash = PixelHash && typeof PixelHash.hashImagePixels === 'function';
  if (!hasPixelHash) {
    console.warn('[DupScanner] PixelHash not available - videos only');
  }

  // Reset throttle timestamps
  lastProgressUpdate = 0;
  lastStatusUpdate = 0;

  // ========== PHASE 1: Collect Assets (0-10%) ==========
  updateStatus(onStatus, t('status.scanningCollecting'), true);
  updateProgress(onProgress, 0.01, true);

  const { assets: allAssets, aborted: collectAborted } = await collectAssetsPaged({
    includeVideos,
    onStatus,
    onProgress,
    progressStart: 0.01,
    progressEnd: 0.10,
    analyzingTotalStatusKey: 'status.scanningAnalyzingTotalPhotos',
    abortRef,
    statusPrefix: 'Scanning',
  });

  if (collectAborted) {
    return { duplicateGroups: [], stats: {}, aborted: true };
  }

  const totalAssets = allAssets.length;
  console.log('[DupScanner] Collected', totalAssets, 'assets');

  if (totalAssets === 0) {
    updateProgress(onProgress, 1, true);
    return { duplicateGroups: [], stats: { totalAssets: 0, hashedCount: 0 }, aborted: false };
  }

  // ========== PHASE 2: Hash Files (10-90%) ==========
  updateStatus(onStatus, t('status.scanningAnalyzingTotalPhotos', { total: totalAssets }), true);
  updateProgress(onProgress, 0.10, true);

  // Memory-optimized: Store only minimal data needed for grouping
  // Full asset/info objects are fetched only for final duplicate groups
  const allHashedItems = []; // Minimal items: { id, fileHashHex, rawDHash, isVideo, exifKeys, baseName, originalSize, dateStr, filename, creationTime }
  const assetLookup = new Map(); // id -> { asset, info } - only populated for items in duplicate groups later
  let hashedCount = 0;
  let hashSkipped = 0;
  let hashFailed = 0;
  let inspectFailed = 0;
  let photoCount = 0;
  let videoCount = 0;

  let icloudDownloadCount = 0;

  for (let i = 0; i < totalAssets; i++) {
    if (abortRef?.current) {
      return { duplicateGroups: [], stats: {}, aborted: true };
    }

    const asset = allAssets[i];
    const current = i + 1;

    // Update progress every 5 files, yield every 25 (fast but responsive)
    // Progress: 10% to 90% during hashing
    if (i % 5 === 0 || i === totalAssets - 1) {
      const fileProgress = 0.10 + (i / totalAssets) * 0.80;
      updateProgress(onProgress, fileProgress);
      // Show iCloud download count if any files are being downloaded
      if (Platform.OS === 'ios' && icloudDownloadCount > 0) {
        updateStatus(onStatus, t('status.scanningWithICloud', { current, total: totalAssets, icloudCount: icloudDownloadCount }));
      } else {
        updateStatus(onStatus, t('status.scanningAnalyzingProgress', { current, total: totalAssets }));
      }
      if (i % 25 === 0) await yieldToUi();
    }

    // --- FAST CACHE PATH ---
    // Skip expensive getAssetInfoAsync + getHashTarget when hash is already cached.
    const quickIsVideo = isVideoAsset(null, asset);
    const quickIsImage = isImageAsset(null, asset);

    if (!quickIsImage && !quickIsVideo) {
      hashSkipped++;
      continue;
    }
    if (quickIsVideo && !includeVideos) {
      hashSkipped++;
      continue;
    }
    if (quickIsImage && !hasPixelHash) {
      hashSkipped++;
      continue;
    }

    const cachedFileHash = getCachedHash(asset, 'file');
    const cachedDHash = getCachedHash(asset, 'perceptual');

    // Videos: skip if file hash cached. Images: skip if dHash cached, or if file
    // hash cached (meaning dHash failed previously, so we use file hash fallback).
    const canSkip = quickIsVideo
      ? !!cachedFileHash
      : !!(cachedDHash || cachedFileHash);

    if (canSkip) {
      hashedCount++;
      if (quickIsVideo) videoCount++;
      else photoCount++;

      const creationTime = parseTs(asset.creationTime) || parseTs(asset.modificationTime) || 0;
      const filename = asset.filename || '';
      const originalSize = asset.fileSize || 0;
      const itemId = asset.id;

      const fileHashHex = quickIsVideo
        ? 'video:' + cachedFileHash
        : (cachedFileHash ? 'file:' + cachedFileHash : null);
      const dHashHex = cachedDHash ? 'dhash:' + cachedDHash : null;
      const rawDHash = cachedDHash || null;
      const rawFileHash = cachedFileHash || null;

      allHashedItems.push({
        id: itemId,
        fileHashHex,
        rawFileHash,
        rawDHash,
        isVideo: quickIsVideo,
        creationTime,
      });

      assetLookup.set(itemId, {
        id: itemId,
        uri: asset.uri || '',
        filename,
        creationTime,
        fileSize: originalSize,
      });

      if (hashedCount % 100 === 0) {
        await flushHashCache();
      }
      continue;
    }

    // Get asset info
    let info;
    try {
      // First check if file is local (quick check without download)
      if (Platform.OS === 'ios') {
        const quickInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
        if (!quickInfo?.localUri && quickInfo?.uri) {
          // File needs iCloud download
          icloudDownloadCount++;
          updateStatus(onStatus, t('status.scanningWithICloud', { current, total: totalAssets, icloudCount: icloudDownloadCount }));
          await yieldToUi();
        }
        // Now download if needed
        info = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true });
      } else {
        info = await MediaLibrary.getAssetInfoAsync(asset.id);
      }
    } catch (e) {
      inspectFailed++;
      continue;
    }

    const isVideo = isVideoAsset(info, asset);
    const isImage = isImageAsset(info, asset);

    if (!isImage && !isVideo) {
      hashSkipped++;
      continue;
    }

    if (isVideo && !includeVideos) {
      hashSkipped++;
      continue;
    }

    if (isImage && !hasPixelHash) {
      hashSkipped++;
      continue;
    }

    // Get readable file path (with timeout to avoid hanging on iCloud / temp copy)
    let hashTarget = null;
    let tmpCopied = false;
    let tmpUri = null;
    try {
      const resolved = await withTimeout(
        getHashTarget({ asset, info, resolveReadableFilePath }),
        10000,
        'getHashTarget'
      );
      hashTarget = resolved.hashTarget;
      tmpCopied = resolved.tmpCopied;
      tmpUri = resolved.tmpUri;
    } catch (e) {
      console.warn('[DupScanner] getHashTarget timeout/error:', info?.filename || asset.filename, e?.message);
      hashFailed++;
      continue;
    }

    if (!hashTarget) {
      hashSkipped++;
      continue;
    }

    try {
      let fileHashHex = null;
      let dHashHex = null;

      // Check cache first for faster subsequent runs
      const cachedFileHashSlow = getCachedHash(asset, 'file');
      const cachedDHashSlow = getCachedHash(asset, 'perceptual');

      if (isVideo) {
        // Videos: fast fingerprint (first 64KB + file size). Full-file SHA-256 of
        // multi-GB videos blocks the JS thread for minutes and the promise can't
        // be cancelled, freezing the whole app.
        const videoSize = info?.fileSize || asset.fileSize || 0;
        if (cachedFileHashSlow) {
          fileHashHex = 'video:' + cachedFileHashSlow;
          videoCount++;
        } else if (videoSize > MAX_VIDEO_HASH_SIZE) {
          // Too large to read safely — use size+basename fallback so video still participates in dedup
          const basename = (info?.filename || asset.filename || '').replace(/\.[^/.]+$/, '');
          const fallback = basename ? `sizeonly:${videoSize}.${basename}` : `sizeonly:${videoSize}`;
          setCachedHash(asset, 'file', fallback);
          fileHashHex = 'video:' + fallback;
          videoCount++;
          if (hashSkipped <= 5) {
            console.log('[DupScanner] Size-only fallback for large video:', info?.filename || asset.filename,
              `(${(videoSize / (1024 * 1024 * 1024)).toFixed(2)}GB > 2GB)`);
          }
          hashSkipped++;
        } else {
          try {
            const fingerprint = await withTimeout(
              computeFastVideoFingerprint(hashTarget, videoSize, info?.filename || asset.filename),
              20000,
              'computeFastVideoFingerprint'
            );
            if (fingerprint) {
              setCachedHash(asset, 'file', fingerprint); // Cache for next run
              fileHashHex = 'video:' + fingerprint;
              videoCount++;
            }
          } catch (e) {
            console.warn('[DupScanner] Video fingerprint timeout:', info?.filename || asset.filename, e?.message);
            // Use size+basename fallback so the video still participates in dedup
            const basename = (info?.filename || asset.filename || '').replace(/\.[^/.]+$/, '');
            const fallback = basename ? `sizeonly:${videoSize}.${basename}` : `sizeonly:${videoSize}`;
            setCachedHash(asset, 'file', fallback);
            fileHashHex = 'video:' + fallback;
            videoCount++;
            hashFailed++;
          }
        }
      } else {
        // Images: use perceptual dHash only (catches visually identical photos)
        // dHash is resistant to compression, re-encoding, and minor edits
        if (hasPixelHash) {
          if (cachedDHashSlow) {
            dHashHex = 'dhash:' + cachedDHashSlow;
            photoCount++;
          } else {
            try {
              const dHash = await PixelHash.hashImagePixels(hashTarget);
              if (dHash) {
                setCachedHash(asset, 'perceptual', dHash); // Cache for next run
                dHashHex = 'dhash:' + dHash;
                photoCount++;
              }
            } catch (e) {
              // dHash failed
            }
          }
        }

        if (!dHashHex) {
          if (cachedFileHashSlow) {
            fileHashHex = 'file:' + cachedFileHashSlow;
          } else {
            try {
              const fh = await withTimeout(
                computeExactFileHash(hashTarget),
                15000,
                'computeExactFileHash(image)'
              );
              if (fh) {
                setCachedHash(asset, 'file', fh);
                fileHashHex = 'file:' + fh;
              }
            } catch (e) {
              console.warn('[DupScanner] Image hash timeout:', info?.filename || asset.filename);
            }
          }
        }
      }

      // Group by BOTH hashes - an image can be in multiple groups
      // This allows matching by either file hash OR perceptual hash
      if (!fileHashHex && !dHashHex) {
        hashFailed++;
        // Debug log for hash failures
        if (hashFailed <= 5) {
          console.log('[DupScanner] Hash failed for:', info?.filename || asset.filename, isVideo ? '(video)' : '(image)');
        }
      } else {
        hashedCount++;
        
        // Store item with both hashes for later grouping
        const rawDHash = dHashHex ? dHashHex.substring(6) : null;
        const rawFileHash = fileHashHex ? fileHashHex.substring(fileHashHex.indexOf(':') + 1) : null;
        const filename = info?.filename || asset.filename || '';
        const creationTime = info?.creationTime || asset.creationTime || 0;
        const originalSize = info?.fileSize || asset.fileSize || 0;
        const itemId = asset.id;
        
        allHashedItems.push({
          id: itemId,
          fileHashHex,
          rawFileHash,
          rawDHash,
          isVideo: fileHashHex && fileHashHex.startsWith('video:'),
          creationTime,
        });
        
        // Store minimal asset reference for later (only id and uri needed for review)
        assetLookup.set(itemId, {
          id: itemId,
          uri: info?.localUri || info?.uri || asset.uri || '',
          filename,
          creationTime,
          fileSize: originalSize,
        });
      }
    } catch (e) {
      hashFailed++;
      console.warn('[DupScanner] Hash error:', info?.filename || asset.filename, e?.message);
    } finally {
      if (tmpCopied && tmpUri) {
        try { await FileSystem.deleteAsync(tmpUri, { idempotent: true }); } catch (e) {}
      }
    }

    // Flush cache to disk every 200 items so uncached tail can resume if killed
    if (i > 0 && i % 200 === 0) {
      await flushHashCache();
    }

    // Thermal cooldown every 100 files
    if (i > 0 && i % 100 === 0) {
      await thermalCooldown();
    }
  }

  // ========== PHASE 3: Group Duplicates using Union-Find (90-95%) ==========
  updateStatus(onStatus, t('status.scanningFindingGroups'), true);
  updateProgress(onProgress, 0.90, true);
  await yieldToUi();

  // Union-Find for proper transitive grouping
  const parent = new Map();
  const rank = new Map();
  
  const find = (x) => {
    if (!parent.has(x)) { parent.set(x, x); rank.set(x, 0); }
    if (parent.get(x) !== x) { parent.set(x, find(parent.get(x))); }
    return parent.get(x);
  };
  
  const union = (x, y) => {
    const px = find(x);
    const py = find(y);
    if (px === py) return;
    const rx = rank.get(px) || 0;
    const ry = rank.get(py) || 0;
    if (rx < ry) { parent.set(px, py); }
    else if (rx > ry) { parent.set(py, px); }
    else { parent.set(py, px); rank.set(px, rx + 1); }
  };

  // Group by exact file hash first (O(n) - fast)
  const fileHashGroups = {};
  for (const item of allHashedItems) {
    if (item.fileHashHex) {
      if (!fileHashGroups[item.fileHashHex]) fileHashGroups[item.fileHashHex] = [];
      fileHashGroups[item.fileHashHex].push(item);
    }
  }
  
  // Union items with same file hash
  for (const group of Object.values(fileHashGroups)) {
    if (group.length > 1) {
      for (let i = 1; i < group.length; i++) {
        union(group[0].id, group[i].id);
      }
    }
  }

  await quickYield();

  // Fuzzy dHash comparison — time-window sliding window for ALL photos with dHash.
  // Re-encoded/synced photos typically share the same original capture timestamp,
  // so a 24-hour window catches cross-device duplicates while keeping comparison
  // counts manageable (O(n * window_size) instead of O(n²)).
  const itemsWithDHash = allHashedItems.filter(item => item.rawDHash && !item.isVideo);
  console.log('[DupScanner] Items with dHash for comparison:', itemsWithDHash.length, 'out of', allHashedItems.length, 'total');

  // Sort by creation time for sliding window
  itemsWithDHash.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));

  let comparisons = 0;
  let matchesFound = 0;
  const MAX_DHASH_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

  for (let i = 0; i < itemsWithDHash.length; i++) {
    if (abortRef?.current) break;

    const a = itemsWithDHash[i];
    const aTs = a.creationTime || 0;

    // Compare only to subsequent items within 24-hour window
    for (let j = i + 1; j < itemsWithDHash.length; j++) {
      const b = itemsWithDHash[j];
      const dt = (b.creationTime || 0) - aTs;
      if (dt > MAX_DHASH_WINDOW_MS) break;

      const dist = hammingDistance64(a.rawDHash, b.rawDHash);
      comparisons++;

      if (dist <= CROSS_PLATFORM_DHASH_THRESHOLD) {
        union(a.id, b.id);
        matchesFound++;
        if (matchesFound <= 5) {
          console.log('[DupScanner] dHash match:', a.id, 'vs', b.id, 'dist:', dist);
        }
      }

      // Yield frequently
      if (comparisons % 2000 === 0) {
        await quickYield();
      }
    }

    // Progress update
    if (i % 500 === 0) {
      const batchProgress = 0.90 + (i / itemsWithDHash.length) * 0.05;
      updateProgress(onProgress, batchProgress);
      await yieldToUi();
    }
  }

  console.log('[DupScanner] dHash comparisons:', comparisons, 'Matches found:', matchesFound, 'Threshold:', CROSS_PLATFORM_DHASH_THRESHOLD);

  // Build groups from Union-Find
  const groupMap = new Map();
  
  for (const item of allHashedItems) {
    const root = find(item.id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root).push(item);
  }

  // Convert to duplicate groups (only groups with >1 item)
  const duplicateGroups = [];
  for (const group of groupMap.values()) {
    if (group.length > 1) {
      // Sort by creation time (oldest first)
      group.sort((a, b) => {
        const aTime = a.creationTime || 0;
        const bTime = b.creationTime || 0;
        return aTime - bTime;
      });
      
      // Enrich with asset lookup data for review UI
      // assetLookup contains: { id, uri, filename, creationTime, fileSize }
      const enrichedGroup = group.map(item => {
        const lookup = assetLookup.get(item.id);
        return {
          asset: { id: item.id, uri: lookup?.uri || '' },
          info: {
            filename: lookup?.filename || item.filename,
            creationTime: lookup?.creationTime || item.creationTime,
            fileSize: lookup?.fileSize || item.originalSize,
            uri: lookup?.uri || '',
            localUri: lookup?.uri || '',
          },
          creationTime: item.creationTime,
        };
      });
      duplicateGroups.push(enrichedGroup);
      
      // Debug: log first few duplicate groups found
      if (duplicateGroups.length <= 3) {
        console.log('[DupScanner] Duplicate group found:', {
          count: group.length,
          files: group.map(g => g.filename).join(', '),
        });
      }
    }
  }

  // ========== PHASE 4: Finalize (95-100%) ==========
  updateStatus(onStatus, t('status.scanningFinalizing'), true);
  updateProgress(onProgress, 0.95, true);
  await yieldToUi();
  
  // Memory cleanup: clear large arrays/maps before UI renders
  // This frees significant memory with large photo libraries
  allHashedItems.length = 0;
  assetLookup.clear();
  groupMap.clear();
  parent.clear();
  rank.clear();
  itemsWithDHash.length = 0;
  
  // Small delay before final result for smooth UX
  await new Promise(r => setTimeout(r, 200));
  
  updateStatus(onStatus, duplicateGroups.length > 0 ? t('status.scanningFoundDuplicates', { count: duplicateGroups.length }) : t('status.scanningNoDuplicates'), true);
  updateProgress(onProgress, 1, true);

  const dHashCount = comparisons > 0 ? Math.ceil(Math.sqrt(comparisons * 2)) : 0; // Approximate from comparisons
  console.log('[DupScanner] Exact scan complete:', {
    totalAssets,
    hashedCount,
    photoCount,
    videoCount,
    hashSkipped,
    hashFailed,
    dHashCompared: dHashCount,
    comparisons,
    duplicateGroups: duplicateGroups.length,
  });

  // Flush cache to disk
  await flushHashCache();

  return {
    duplicateGroups,
    stats: {
      totalAssets,
      hashedCount,
      hashSkipped,
      hashFailed,
      inspectFailed,
      photoCount,
      videoCount,
    },
    aborted: false,
  };
};

// ============================================================================
// OPTIMIZED SIMILAR PHOTOS SCAN
// ============================================================================

/**
 * Scan for similar photos with proper yielding and progress
 * 
 * Progress phases:
 * - 0-10%: Collecting assets
 * - 10-60%: Hashing files (per-file progress)
 * - 60-90%: Comparing hashes (O(n²) with yields)
 * - 90-100%: Clustering and finalizing
 */
export const scanSimilarPhotos = async ({
  resolveReadableFilePath,
  onProgress,
  onStatus,
  onCollecting,
  onFindingMatches,
  abortRef,
  includeVideos = false,
}) => {
  console.log('[DupScanner] Starting optimized similar photos scan');

  // Abort any running background pre-analysis to avoid race conditions
  await abortPreAnalysis('scanSimilarPhotos');

  // Load hash cache for faster subsequent runs
  await loadHashCache();

  const hasPixelHash = PixelHash && typeof PixelHash.hashImagePixels === 'function';
  if (!hasPixelHash) {
    console.warn('[DupScanner] PixelHash not available - videos only');
  }

  // Reset throttle timestamps
  lastProgressUpdate = 0;
  lastStatusUpdate = 0;

  // ========== PHASE 1: Collect Assets (0-10%) ==========
  if (onCollecting) onCollecting();
  updateStatus(onStatus, t('status.scanningCollecting'), true);
  updateProgress(onProgress, 0.01, true);

  const { assets: allAssets, aborted: collectAborted } = await collectAssetsPaged({
    includeVideos,
    onStatus,
    onProgress,
    progressStart: 0.01,
    progressEnd: 0.10,
    analyzingTotalStatusKey: 'status.scanningAnalyzingTotalPhotos',
    abortRef,
    statusPrefix: 'Scanning',
  });

  if (collectAborted) {
    return { groups: [], aborted: true };
  }

  // Process ALL assets — no hard limit. The comparison phase uses a
  // time-window sliding window, so even 100k+ photos are manageable.
  let assets = allAssets;

  // Sort by creation time ascending for burst detection
  assets.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));

  const totalAssets = assets.length;
  console.log('[DupScanner] Processing', totalAssets, 'assets for similar scan');

  if (totalAssets === 0) {
    updateProgress(onProgress, 1, true);
    return { groups: [], aborted: false };
  }

  // ========== PHASE 2: Hash Files (10-60%) ==========
  updateStatus(onStatus, t('status.scanningAnalyzingTotalPhotos', { total: totalAssets }), true);
  updateProgress(onProgress, 0.10, true);

  const items = [];
  let hashed = 0;
  let hashFailed = 0;

  for (let i = 0; i < totalAssets; i++) {
    if (abortRef?.current) {
      return { groups: [], aborted: true };
    }

    const asset = assets[i];

    // Update progress every 5 files, yield every 25 (fast but responsive)
    // Progress: 10% to 60% during hashing
    if (i % 5 === 0) {
      const fileProgress = 0.10 + (i / totalAssets) * 0.50;
      updateProgress(onProgress, fileProgress);
      updateStatus(onStatus, t('status.scanningAnalyzingProgressPhotos', { current: i + 1, total: totalAssets }));
      if (i % 25 === 0) await yieldToUi();
    }

    // --- FAST CACHE PATH ---
    // Skip expensive getAssetInfoAsync + getHashTarget when hash is already cached.
    // We can determine photo/video type from the collected asset's mediaType/filename.
    const quickIsVideo = isVideoAsset(null, asset);
    const quickIsImage = isImageAsset(null, asset);
    if ((quickIsImage || quickIsVideo) && !(quickIsImage && !hasPixelHash)) {
      const cacheType = quickIsVideo ? 'file' : 'perceptual';
      const cachedHash = getCachedHash(asset, cacheType);
      if (cachedHash) {
        const hash = quickIsVideo ? 'video:' + cachedHash : 'image:' + cachedHash;
        hashed++;
        const createdTs = parseTs(asset.creationTime) || parseTs(asset.modificationTime) || 0;
        items.push({
          asset,
          info: null,
          hash,
          isVideo: quickIsVideo,
          edgeHash: null,
          cornerHash: null,
          createdTs,
          hasExifTime: false,
          filename: asset.filename || '',
        });

        // Flush cache to disk every 100 cache hits
        if (hashed % 100 === 0) {
          await flushHashCache();
        }
        continue;
      }
    }

    let info = null;
    let hash = null;
    let edgeHash = null;
    let cornerHash = null;
    let isVideo = false;

    try {
      info = await MediaLibrary.getAssetInfoAsync(
        asset.id,
        Platform.OS === 'ios' ? { shouldDownloadFromNetwork: true } : undefined
      );

      isVideo = isVideoAsset(info, asset);
      const isImage = isImageAsset(info, asset);

      if (!isImage && !isVideo) continue;
      if (isImage && !hasPixelHash) continue;

      let hashTarget = null;
      let tmpCopied = false;
      let tmpUri = null;
      try {
        const resolved = await withTimeout(
          getHashTarget({ asset, info, resolveReadableFilePath }),
          10000,
          'getHashTarget(similar)'
        );
        hashTarget = resolved.hashTarget;
        tmpCopied = resolved.tmpCopied;
        tmpUri = resolved.tmpUri;
      } catch (e) {
        console.warn('[DupScanner] getHashTarget timeout (similar):', info?.filename || asset.filename);
        hashFailed++;
        continue;
      }

      if (hashTarget) {
        try {
          // Check cache first for faster subsequent runs
          const cachedHash = isVideo ? getCachedHash(asset, 'file') : getCachedHash(asset, 'perceptual');

          if (cachedHash) {
            hash = isVideo ? 'video:' + cachedHash : 'image:' + cachedHash;
            hashed++;
          } else if (isVideo) {
            const videoSize = info?.fileSize || asset.fileSize || 0;
            try {
              const fingerprint = await withTimeout(
                computeFastVideoFingerprint(hashTarget, videoSize, info?.filename || asset.filename),
                20000,
                'computeFastVideoFingerprint(similar)'
              );
              if (fingerprint) {
                setCachedHash(asset, 'file', fingerprint); // Cache for next run
                hash = 'video:' + fingerprint;
                hashed++;
              }
            } catch (e) {
              console.warn('[DupScanner] Video fingerprint timeout (similar):', info?.filename || asset.filename);
              // Use size+basename fallback so the video still participates in dedup
              const basename = (info?.filename || asset.filename || '').replace(/\.[^/.]+$/, '');
              const fallback = basename ? `sizeonly:${videoSize}.${basename}` : `sizeonly:${videoSize}`;
              setCachedHash(asset, 'file', fallback);
              hash = 'video:' + fallback;
              hashed++;
              hashFailed++;
            }
          } else if (hasPixelHash) {
            hash = await PixelHash.hashImagePixels(hashTarget);
            if (hash) {
              setCachedHash(asset, 'perceptual', hash); // Cache for next run
              hash = 'image:' + hash;
              hashed++;
              
            }
          }
        } catch (e) {
          hashFailed++;
        } finally {
          if (tmpCopied && tmpUri) {
            try { await FileSystem.deleteAsync(tmpUri, { idempotent: true }); } catch (e) {}
          }
        }
      }
    } catch (e) {
      hashFailed++;
    }

    if (hash) {
      // Try to get EXIF DateTimeOriginal for accurate capture time
      // Falls back to asset.creationTime (OS file time) if EXIF not available
      let createdTs = 0;
      let hasExifTime = false; // Only true if we found actual EXIF date fields
      const exif = info?.exif;
      if (exif) {
        // Try various EXIF date fields (different naming conventions on iOS/Android)
        const exifDate = exif.DateTimeOriginal || exif.DateTimeDigitized || exif.DateTime ||
                         exif.dateTimeOriginal || exif.dateTimeDigitized || exif.dateTime ||
                         exif['{Exif}']?.DateTimeOriginal || exif['{Exif}']?.DateTimeDigitized ||
                         exif.CreateDate || exif.createDate;
        if (exifDate && typeof exifDate === 'string') {
          // EXIF format: "2024:01:15 14:30:00" or "2024-01-15T14:30:00"
          try {
            const parsed = new Date(exifDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
            if (!isNaN(parsed.getTime())) {
              createdTs = parsed.getTime();
              hasExifTime = true; // Only set true when actual EXIF date found
            }
          } catch (e) {}
        }
      }
      // Fallback to info.creationTime (NOT reliable EXIF - just file system time)
      if (!createdTs && info?.creationTime) {
        const ct = typeof info.creationTime === 'number' ? info.creationTime : 
                   (info.creationTime ? new Date(info.creationTime).getTime() : 0);
        if (ct > 0) createdTs = ct;
        // hasExifTime stays false - this is file system time, not EXIF
      }
      
      // Try multiple timestamp sources (different Android manufacturers use different fields)
      // Priority: asset.creationTime -> info.modificationTime -> asset.modificationTime
      if (!createdTs) createdTs = parseTs(asset.creationTime);
      if (!createdTs) createdTs = parseTs(info?.modificationTime);
      if (!createdTs) createdTs = parseTs(asset.modificationTime);
      
      // Debug log first few items to verify timestamp detection
      if (hashed <= 3) {
        console.log(`[DupScanner] Time debug for ${info?.filename || asset.filename}: hasExifTime=${hasExifTime}, createdTs=${createdTs}, asset.creationTime=${asset.creationTime}, asset.modificationTime=${asset.modificationTime}`);
      }
      
      items.push({
        asset,
        info,
        hash,
        isVideo,
        edgeHash: edgeHash || null,
        cornerHash: cornerHash || null,
        createdTs,
        hasExifTime, // Track if we have reliable EXIF timestamp
        filename: info?.filename || asset.filename || '',
      });
    }

    // Flush cache to disk every 200 items so uncached tail can resume if killed
    if (i > 0 && i % 200 === 0) {
      await flushHashCache();
    }

    // Thermal cooldown every 100 files
    if (i > 0 && i % 100 === 0) {
      await thermalCooldown();
    }
  }

  console.log('[DupScanner] Hashed', hashed, 'items, failed', hashFailed);

  // ========== PHASE 3: Compare Hashes (60-90%) ==========
  // Time-window sliding window: each photo is only compared to photos taken
  // within the next 4 hours. This eliminates O(n²) and scales to any library
  // size — a 100k library with 50 photos per 4h window needs ~5M comparisons
  // instead of 5B.
  if (onFindingMatches) onFindingMatches();
  updateStatus(onStatus, t('status.scanningComparingSimilar'), true);
  updateProgress(onProgress, 0.60, true);

  // --- Timestamp reliability check ---
  // Photos batch-copied between devices often get identical or missing timestamps.
  // When timestamps are unreliable, we must use stricter hash-only mode to avoid
  // comparing every photo to every other photo (O(n²)) and grouping unrelated images.
  const totalItems = items.length;
  const validTsCount = items.filter(it => (it.createdTs || 0) > 0).length;
  const tsHistogram = new Map();
  for (const it of items) {
    const ts = it.createdTs || 0;
    if (ts > 0) tsHistogram.set(ts, (tsHistogram.get(ts) || 0) + 1);
  }
  let maxSameTs = 0;
  for (const count of tsHistogram.values()) {
    if (count > maxSameTs) maxSameTs = count;
  }
  const tsReliable = validTsCount > totalItems * 0.5 && maxSameTs < totalItems * 0.3;
  console.log(`[DupScanner] Timestamp reliability: ${tsReliable} (valid=${validTsCount}/${totalItems}, maxSameTs=${maxSameTs})`);

  // Ensure strict sort by createdTs so the sliding window break works
  items.sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0));

  const similarPairs = [];
  const seen = new Set();
  let comparisonsDone = 0;
  const MAX_COMPARE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const MAX_NEIGHBORS_UNRELIABLE = 30; // cap inner loop when timestamps are bad

  for (let i = 0; i < items.length; i++) {
    if (abortRef?.current) {
      return { groups: [], aborted: true };
    }

    const a = items[i];
    const aTs = a.createdTs || 0;
    if (!aTs) continue;

    // Inner loop: compare only to subsequent items within the time window.
    // Because items are sorted by createdTs, once dt > window we can break.
    let neighborsChecked = 0;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      const bTs = b.createdTs || 0;
      if (!bTs) continue;
      const dt = bTs - aTs;

      if (tsReliable) {
        // Normal mode: time-window break
        if (dt > MAX_COMPARE_WINDOW_MS) break;
      } else {
        // Unreliable timestamps: cap neighbors to prevent O(n²) when all
        // photos share the same import timestamp. Still use time as a
        // coarse filter (skip if >5min apart), but mainly rely on strict hash.
        neighborsChecked++;
        if (neighborsChecked > MAX_NEIGHBORS_UNRELIABLE) break;
        if (dt > MAX_COMPARE_WINDOW_MS) break;
      }

      comparisonsDone++;

      // Yield & progress every N comparisons
      if (comparisonsDone % YIELD_EVERY_N_COMPARISONS === 0) {
        await quickYield();
        const compareProgress = 0.60 + (i / items.length) * 0.30;
        updateProgress(onProgress, compareProgress);
        updateStatus(onStatus, t('status.scanningComparingPairs', { current: i + 1, total: items.length }));
      }

      // Videos: exact match only
      if (a.isVideo || b.isVideo) {
        if (a.isVideo && b.isVideo && a.hash === b.hash) {
          const key = [a.asset.id, b.asset.id].sort().join('|');
          if (!seen.has(key)) {
            seen.add(key);
            similarPairs.push({ a, b, dist: 0, isVideoMatch: true });
          }
        }
        continue;
      }

      // Images: perceptual hash comparison
      const aHash = a.hash.startsWith('image:') ? a.hash.substring(6) : a.hash;
      const bHash = b.hash.startsWith('image:') ? b.hash.substring(6) : b.hash;

      const dist = hammingDistance64(aHash, bHash);

      let threshold;
      if (tsReliable) {
        if (dt <= 30000) threshold = 10;        // burst: ≤30s
        else if (dt <= 300000) threshold = 8;     // same session: ≤5min
        else threshold = 6;                     // >5min up to window limit
      } else {
        // Strict mode: only visually nearly-identical photos.
        // Real burst photos have dHash distance 0-5 even across device copies.
        threshold = 5;
      }

      if (dist > threshold) continue;

      if (similarPairs.length < 5) {
        console.log(`[DupScanner] MATCH: ${a.filename} vs ${b.filename} dist=${dist} threshold=${threshold} dt=${Math.round(dt/1000)}s reliable=${tsReliable}`);
      }

      const key = [a.asset.id, b.asset.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      similarPairs.push({ a, b, dist, dt });
    }

    // Thermal cooldown every 500 outer iterations
    if (i > 0 && i % 500 === 0) {
      await thermalCooldown();
    }
  }

  console.log('[DupScanner] Found', similarPairs.length, 'similar pairs');

  // ========== PHASE 4: Cluster Groups (90-100%) ==========
  updateStatus(onStatus, t('status.scanningGroupingSimilar'), true);
  updateProgress(onProgress, 0.90, true);
  await yieldToUi();

  // Union-Find clustering
  const parent = new Map();
  const rank = new Map();

  const find = (x) => {
    if (!parent.has(x)) { parent.set(x, x); rank.set(x, 0); }
    if (parent.get(x) !== x) { parent.set(x, find(parent.get(x))); }
    return parent.get(x);
  };

  const union = (x, y) => {
    const px = find(x);
    const py = find(y);
    if (px === py) return;
    const rx = rank.get(px) || 0;
    const ry = rank.get(py) || 0;
    if (rx < ry) parent.set(px, py);
    else if (rx > ry) parent.set(py, px);
    else { parent.set(py, px); rank.set(px, rx + 1); }
  };

  await quickYield();

  // Union-Find clustering: transitive closure of all similar pairs.
  // A~B and B~C and C~D => all in one group {A,B,C,D}.
  // Clique-based grouping would break this chain because it requires every
  // member to match every other member directly.
  for (const pair of similarPairs) {
    union(pair.a.asset.id, pair.b.asset.id);
  }

  const rootToGroup = new Map();
  for (const item of items) {
    const root = find(item.asset.id);
    if (!rootToGroup.has(root)) rootToGroup.set(root, []);
    rootToGroup.get(root).push(item); // Store scan item to preserve createdTs
  }

  // Post-grouping time-gap split: union-find transitive closure can bridge
  // two separate events via a single false positive. Split at >60s gaps
  // so each burst or quick photo session stays in its own clean group.
  // 60s catches real bursts even with short pauses, but splits genuinely
  // separate events (minutes/hours apart) that got bridged by a false match.
  const MAX_GROUP_SIZE = 50; // Prevent UI crash from too many concurrent image loads
  const BURST_GAP_MS = 60000; // 60 seconds

  const rebuiltGroups = [];
  for (const group of rootToGroup.values()) {
    if (group.length < 2) continue;
    // Use createdTs (same source as comparison loop) not asset.creationTime,
    // because EXIF-corrected timestamps and file-import timestamps can differ.
    group.sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0));

    let chunk = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const gap = (group[i].createdTs || 0) - (group[i - 1].createdTs || 0);
      if (gap > BURST_GAP_MS) {
        if (chunk.length >= 2) rebuiltGroups.push(chunk);
        chunk = [group[i]];
      } else {
        chunk.push(group[i]);
      }
    }
    if (chunk.length >= 2) rebuiltGroups.push(chunk);
  }

  // Apply MAX_GROUP_SIZE to each sub-group, then extract raw assets for UI
  const finalGroups = [];
  for (const group of rebuiltGroups) {
    const assets = group.map(it => it.asset);
    if (assets.length > MAX_GROUP_SIZE) {
      for (let i = 0; i < assets.length; i += MAX_GROUP_SIZE) {
        const chunk = assets.slice(i, i + MAX_GROUP_SIZE);
        if (chunk.length >= 2) finalGroups.push(chunk);
      }
    } else {
      finalGroups.push(assets);
    }
  }

  finalGroups.sort((a, b) => b.length - a.length);

  updateProgress(onProgress, 0.95, true);
  await yieldToUi();
  
  // Small delay before final result for smooth UX
  await new Promise(r => setTimeout(r, 200));
  
  updateStatus(onStatus, finalGroups.length > 0 ? t('status.scanningFoundSimilarGroups', { count: finalGroups.length }) : t('status.scanningNoSimilarPhotos'), true);
  updateProgress(onProgress, 1, true);

  console.log('[DupScanner] Similar scan complete:', finalGroups.length, 'groups');

  // Flush cache to disk
  await flushHashCache();

  return { groups: finalGroups, aborted: false };
};

// ============================================================================
// HELPER EXPORTS (same as original)
// ============================================================================

export const formatDuplicateGroupsForReview = (duplicateGroups) => {
  return duplicateGroups.map((group, idx) => {
    const sorted = [...group].sort((a, b) => {
      const at = a.info?.creationTime || a.asset?.creationTime || a.creationTime || 0;
      const bt = b.info?.creationTime || b.asset?.creationTime || b.creationTime || 0;
      return at - bt;
    });
    const items = sorted.map((it, itemIdx) => ({
      id: it.asset?.id || it.id,
      filename: it.info?.filename || it.asset?.filename || it.filename || it.id,
      created: it.info?.creationTime || it.asset?.creationTime || it.creationTime || 0,
      size: it.info?.fileSize || null,
      uri: it.info?.localUri || it.info?.uri || it.asset?.uri || it.uri || '',
      delete: itemIdx > 0,
    }));
    return { type: 'exact', groupIndex: idx + 1, items };
  });
};

export const countDuplicates = (duplicateGroups) => {
  let count = 0;
  duplicateGroups.forEach(group => {
    count += (group.length - 1);
  });
  return count;
};

export const buildNoResultsNote = (stats) => {
  const noteParts = [];
  noteParts.push(`Analyzed ${stats.hashedCount || 0} items.`);
  if (stats.hashSkipped > 0) noteParts.push(`Skipped: ${stats.hashSkipped}`);
  if (stats.hashFailed > 0) noteParts.push(`Analysis failures: ${stats.hashFailed}`);
  return noteParts.length > 0 ? `\n${noteParts.join('\n')}` : '';
};

export const deleteAssets = async (ids, onProgress) => {
  if (!ids || ids.length === 0) {
    return { success: true, deleted: 0 };
  }

  // Batch deletions to avoid crashes with large numbers of files
  // iOS and Android can timeout/crash when deleting 100+ files at once
  const BATCH_SIZE = 20;
  let totalDeleted = 0;
  let hasError = false;

  try {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(ids.length / BATCH_SIZE);
      
      console.log(`[DupScanner] Deleting batch ${batchNum}/${totalBatches} (${batch.length} items)`);
      
      // Report progress if callback provided
      if (onProgress) {
        onProgress(i / ids.length, totalDeleted, ids.length);
      }

      try {
        // Use native MediaDelete module on both iOS and Android for proper deletion
        // iOS: moves to Recently Deleted (30-day recovery)
        // Android: moves to PhotoLynkDeleted album
        if (MediaDelete && typeof MediaDelete.deleteAssets === 'function') {
          const result = await MediaDelete.deleteAssets(batch);
          // iOS returns count of deleted assets, Android returns boolean
          if (typeof result === 'number') {
            totalDeleted += result;
          } else if (result === true) {
            totalDeleted += batch.length;
          }
        } else {
          // Fallback to MediaLibrary (less reliable on iOS)
          const result = await MediaLibrary.deleteAssetsAsync(batch);
          if (result === true || typeof result === 'undefined') {
            totalDeleted += batch.length;
          }
        }
      } catch (batchError) {
        console.log(`[DupScanner] Batch ${batchNum} error:`, batchError?.message);
        hasError = true;
        // Continue with next batch instead of failing completely
      }

      // Small delay between batches to prevent overwhelming the system
      if (i + BATCH_SIZE < ids.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Final progress update
    if (onProgress) {
      onProgress(1, totalDeleted, ids.length);
    }

    return { 
      success: totalDeleted > 0, 
      deleted: totalDeleted,
      partial: hasError && totalDeleted > 0,
    };
  } catch (e) {
    console.log('[DupScanner] Delete error:', e?.message);
    throw e;
  }
};

export default {
  scanExactDuplicates,
  scanSimilarPhotos,
  formatDuplicateGroupsForReview,
  countDuplicates,
  buildNoResultsNote,
  deleteAssets,
};
