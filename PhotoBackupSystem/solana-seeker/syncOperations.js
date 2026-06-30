/**
 * syncOperations.js - Optimized Sync/Restore Operations
 * 
 * Handles sync/restore operations for StealthCloud and Local/Remote servers.
 * Features:
 * - Proper phased progress (fetch server, scan local, analyze, download)
 * - Per-file status messages
 * - UI yielding with requestAnimationFrame
 * - Handles 100s to 10000s of files efficiently
 * - Uses server-side hash metadata for fast deduplication (no decrypt needed)
 * - Proper temp/cache cleanup
 * - No race conditions (sequential analysis, parallel downloads with limits)
 */

import { Platform, AppState, InteractionManager, NativeModules } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import axios from 'axios';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { sha256 } from 'js-sha256';

// Safely import native modules with fallback
let ExifExtractor = null;
try {
  ExifExtractor = NativeModules.ExifExtractor;
  if (ExifExtractor) {
    console.log('[Sync] ExifExtractor native module loaded');
  } else {
    console.warn('[Sync] ExifExtractor native module not available');
  }
} catch (e) {
  console.error('[Sync] Failed to load ExifExtractor:', e?.message);
}

import { t } from './i18n';
import {
  sleep,
  withRetries,
  shouldRetryChunkUpload,
  makeChunkNonce,
  normalizeFilenameForCompare,
  normalizeFilePath,
  computeFileIdentity,
  formatFilenameForStatus,
} from './utils';

import {
  computeExactFileHash,
  computePerceptualHash,
  findPerceptualHashMatch,
  extractBaseFilename,
  normalizeDateForCompare,
  normalizeFullTimestamp,
} from './duplicateScanner';

import { getCachedHash, getAllCachedHashesAsync, setCachedHash, loadHashCache, flushHashCache, abortPreAnalysis, getHashCacheStats } from './hashCache';

// Sync dHash threshold — 2 bits = ~3% tolerance.
// Cross-device JPEG encoders (iOS vs Android vs desktop) produce slightly
// different pixel values, so 1-bit was too strict and caused files to leak
// through on every sync. 2 bits catches same-photo-different-device while
// keeping false positives extremely low.
const SYNC_DHASH_THRESHOLD = 2;
const SUPPORTED_VIDEO_RE = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|3g2|wmv|flv|mpg|mpeg|mts|m2ts)$/i;

import {
  chooseStealthCloudMaxParallelChunkUploads,
  createConcurrencyLimiter,
  chooseFileParallelDownloads,
  getDeviceCapability,
} from './backgroundTask';

import { getMediaLibraryAccessPrivileges } from './autoUpload';
import { isBackgroundServiceRunning } from './serviceController';

const waitForActiveApp = async (appStateRef) => {
  if (!appStateRef) return true;
  // With foreground service active, Android keeps the process alive — don't pause
  if (Platform.OS === 'android' && isBackgroundServiceRunning()) return true;
  while (appStateRef.current !== 'active') {
    await sleep(1000);
  }
  return true;
};

const isBackgroundInterruptedError = (error, appStateRef) => {
  if (!appStateRef || appStateRef.current === 'active') return false;
  if (Platform.OS === 'android' && isBackgroundServiceRunning()) return false;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('network request failed')
    || message.includes('failed to connect')
    || message.includes('cancel')
    || message.includes('timed out')
    || message.includes('connection abort')
    || message.includes('connection lost');
};

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const PROGRESS_THROTTLE_MS = 200; // Slower updates to reduce UI load
const PAGE_SIZE = 250; // Assets per page when scanning

// Throttle settings for thermal management
const getAssetCooldownMs = (fastMode) => fastMode ? 0 : (Platform.OS === 'ios' ? 300 : 200);
const getBatchLimit = (fastMode) => fastMode ? 100 : 25;
const getBatchCooldownMs = (fastMode) => fastMode ? 0 : 5000;


// ============================================================================
// ASSET COLLECTION (All Albums + iCloud/Google Cloud Download)
// ============================================================================

/**
 * Collect all assets from device including all albums (Screenshots, Downloads, WhatsApp, etc.)
 * Also triggers iCloud/Google Cloud download for cloud-only items before dedup
 * @returns {Promise<Array>} Array of all assets
 */
const collectAllAssetsFromAllAlbums = async (onStatus, onProgress, progressStart, progressEnd, abortRef) => {
  const mediaTypes = Platform.OS === 'ios'
    ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
    : ['photo', 'video'];
  
  const allAssets = [];
  const seenIds = new Set();
  let after = null;
  
  // Get PhotoLynkDeleted album asset IDs to exclude from sync (Android only - iOS uses Recently Deleted)
  let photoLynkDeletedAssetIds = new Set();
  if (Platform.OS === 'android') {
    try {
      const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
      const deletedAlbum = albums.find(a => a.title === 'PhotoLynkDeleted');
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
        console.log('[Sync] Excluding', photoLynkDeletedAssetIds.size, 'assets from PhotoLynkDeleted');
      }
    } catch (e) {
      console.log('[Sync] Could not get PhotoLynkDeleted album:', e?.message);
    }
  }
  
  // Get total count first
  let totalCount = 0;
  try {
    const countPage = await MediaLibrary.getAssetsAsync({ first: 1, mediaType: mediaTypes });
    totalCount = countPage?.totalCount || 0;
  } catch (e) {
    totalCount = 1000;
  }

  if (Platform.OS === 'android' && photoLynkDeletedAssetIds && photoLynkDeletedAssetIds.size > 0 && totalCount > 0) {
    totalCount = Math.max(0, totalCount - photoLynkDeletedAssetIds.size);
  }

  updateStatus(onStatus, t('status.syncScanning', { current: 0, total: totalCount }), true);
  updateProgress(onProgress, progressStart, true);
  await quickYield(); // Yield to let UI show initial status

  // Phase 1: Collect from main library (paged)
  let pageNum = 0;
  while (true) {
    const page = await MediaLibrary.getAssetsAsync({
      first: PAGE_SIZE,
      after: after || undefined,
      mediaType: mediaTypes,
    });

    const assets = page?.assets || [];
    for (let j = 0; j < assets.length; j++) {
      if (abortRef?.current) return allAssets;
      const asset = assets[j];
      // Skip assets in PhotoLynkDeleted album (Android)
      if (photoLynkDeletedAssetIds.has(asset.id)) continue;
      if (!seenIds.has(asset.id)) {
        seenIds.add(asset.id);
        allAssets.push(asset);

        // If MediaLibrary totalCount estimate was low, bump it so UI never shows X of (X-1)
        if (allAssets.length > totalCount) {
          totalCount = allAssets.length;
        }
        
        // Update progress per file (like backup does)
        const scanProgress = progressStart + (allAssets.length / Math.max(totalCount, 1)) * (progressEnd - progressStart) * 0.6;
        updateProgress(onProgress, Math.min(scanProgress, progressEnd), true);
        updateStatus(onStatus, t('status.syncScanning', { current: allAssets.length, total: totalCount }), true);
        
        // Yield every 10 files to let UI update
        if (allAssets.length % 10 === 0) {
          await quickYield();
        }
      }
    }

    pageNum++;
    after = page?.endCursor;
    if (!page?.hasNextPage) break;
    if (assets.length === 0) break;
    await quickYield();
  }

  // Phase 2: Scan all albums to catch Screenshots, Downloads, WhatsApp, user folders, etc.
  try {
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    updateStatus(onStatus, t('status.syncScanningAlbums', { count: albums.length }));
    
    for (let i = 0; i < albums.length; i++) {
      if (abortRef?.current) return allAssets;
      const album = albums[i];
      
      // Skip PhotoLynkDeleted album entirely (Android)
      if (album.title === 'PhotoLynkDeleted') continue;
      
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
          for (let ai = 0; ai < albumAssets.length; ai++) {
            const asset = albumAssets[ai];
            // Skip assets in PhotoLynkDeleted album (Android)
            if (photoLynkDeletedAssetIds.has(asset.id)) continue;
            if (!seenIds.has(asset.id)) {
              seenIds.add(asset.id);
              allAssets.push(asset);

              // Update progress per file (like backup does) - force update to bypass throttle
              const albumProgress = progressStart + (progressEnd - progressStart) * (0.6 + 0.2 * (i / albums.length));
              updateProgress(onProgress, Math.min(albumProgress, progressEnd), true);
              updateStatus(onStatus, t('status.syncScanningAlbumsFound', { count: allAssets.length }), true);
            }
            // Yield every 50 assets inside album to keep UI responsive
            if (ai > 0 && ai % 50 === 0) await quickYield();
          }
          
          albumAfter = albumPage?.endCursor;
          if (!albumPage?.hasNextPage || albumAssets.length === 0) break;
        }
      } catch (e) {
        // Skip failed albums
      }

      // Yield every few albums
      if (i % 5 === 0) {
        await quickYield();
      }
    }
  } catch (e) {
    console.log('[Sync] Album scan error:', e?.message);
  }

  // Phase 3: Trigger iCloud/Google Cloud download for cloud-only items (iOS mainly)
  // Also store localUri back into asset objects for later hash computation
  if (Platform.OS === 'ios') {
    updateStatus(onStatus, t('status.syncCheckingCloud', { count: allAssets.length }));
    let cloudDownloadCount = 0;
    let localUriCount = 0;
    
    for (let i = 0; i < allAssets.length; i++) {
      try {
        const asset = allAssets[i];
        // getAssetInfoAsync triggers iCloud download if needed and returns localUri
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        
        // Store localUri back into asset for later use in hash computation
        if (info?.localUri) {
          asset.localUri = info.localUri;
          localUriCount++;
        } else if (info?.uri) {
          asset.uri = info.uri;
          cloudDownloadCount++;
        }
      } catch (e) {
        // Skip items that fail
        if (i < 5) console.log(`[Sync] iOS asset ${i} info error: ${e.message}`);
      }
      
      // Yield and update progress periodically
      if (i % 50 === 0) {
        await quickYield();
        const dlProgress = progressStart + (progressEnd - progressStart) * (0.8 + 0.2 * (i / allAssets.length));
        updateProgress(onProgress, Math.min(dlProgress, progressEnd));
        if (cloudDownloadCount > 0) {
          updateStatus(onStatus, t('status.syncDownloadingICloud', { count: cloudDownloadCount }));
        }
      }
    }
    
    console.log(`[Sync] iOS: ${localUriCount} local files, ${cloudDownloadCount} cloud-only items`);
  }

  updateProgress(onProgress, progressEnd, true);
  console.log(`[Sync] Collected ${allAssets.length} assets from all albums`);
  return allAssets;
};

// ============================================================================
// PROGRESS TRACKING (Module-level, reset per operation)
// ============================================================================

let lastProgressValue = 0;
let lastProgressTime = 0;
let lastStatusTime = 0;
let lastStatusText = null;

const resetProgress = () => {
  lastProgressValue = 0;
  lastProgressTime = 0;
  lastStatusTime = 0;
  lastStatusText = null;
};

const HARD_MIN_INTERVAL_MS = 50; // Absolute floor — never fire setState faster than this

const updateProgress = (onProgress, value, force = false) => {
  if (value < lastProgressValue) return; // Never go backwards
  const now = Date.now();
  const elapsed = now - lastProgressTime;
  if (elapsed < HARD_MIN_INTERVAL_MS) return; // Hard floor — prevent React setState spam
  if (force || elapsed >= PROGRESS_THROTTLE_MS) {
    lastProgressTime = now;
    lastProgressValue = value;
    onProgress(value);
  }
};

const updateStatus = (onStatus, text, force = false) => {
  if (text === lastStatusText) return;
  const now = Date.now();
  const elapsed = now - lastStatusTime;
  if (elapsed < HARD_MIN_INTERVAL_MS) return; // Hard floor — prevent React setState spam
  if (force || elapsed >= PROGRESS_THROTTLE_MS) {
    lastStatusTime = now;
    lastStatusText = text;
    onStatus(text);
  }
};

// ============================================================================
// UI YIELDING
// ============================================================================

// Yield to UI - use InteractionManager + setImmediate for best React Native responsiveness
const yieldToUi = () => new Promise(resolve => {
  InteractionManager.runAfterInteractions(() => {
    if (typeof setImmediate !== 'undefined') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
});

// Quick yield for inside tight loops
// In fast mode, yield only every 10 calls for safety (prevents ANR)
let fastModeEnabled = false;
let fastModeYieldCounter = 0;
const setFastMode = (enabled) => { fastModeEnabled = enabled; fastModeYieldCounter = 0; };

const quickYield = () => {
  if (fastModeEnabled) {
    fastModeYieldCounter++;
    const threshold = Platform.OS === 'android' ? 3 : 10;
    if (fastModeYieldCounter < threshold) return Promise.resolve(); // Skip most yields in fast mode
    fastModeYieldCounter = 0; // Reset counter, do actual yield
  }
  return new Promise(r => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => r());
    } else {
      setTimeout(r, 0);
    }
  });
};

// ============================================================================
// SERVER COMMUNICATION
// ============================================================================

/**
 * Fetch all StealthCloud manifests with metadata (no decryption needed for dedup)
 * Uses ?meta=true to get filename, size, hashes in single request
 */
const fetchManifestsWithMeta = async (serverUrl, config, onProgress) => {
  const PAGE_LIMIT = 500;
  const allManifests = [];
  let offset = 0;
  let estimatedTotal = null;

  while (true) {
    const response = await axios.get(`${serverUrl}/api/cloud/manifests`, {
      ...config,
      params: { offset, limit: PAGE_LIMIT, meta: true }
    });

    const manifests = response.data?.manifests || [];
    allManifests.push(...manifests);

    if (estimatedTotal === null && typeof response.data?.total === 'number') {
      estimatedTotal = response.data.total;
    }

    if (onProgress) {
      onProgress(allManifests.length, estimatedTotal || allManifests.length);
    }

    if (!manifests || manifests.length < PAGE_LIMIT) break;
    offset += manifests.length;
    if (typeof estimatedTotal === 'number' && offset >= estimatedTotal) break;
    
    await quickYield();
  }

  return allManifests;
};

/**
 * Fetch all Local/Remote server files with pagination
 */
const fetchServerFilesPaged = async (serverUrl, config, onProgress, includeMeta = true) => {
  const PAGE_LIMIT = 500;
  const allFiles = [];
  let offset = 0;
  let estimatedTotal = null;

  while (true) {
    const params = { offset, limit: PAGE_LIMIT };
    if (includeMeta) params.meta = 'true';
    
    const response = await axios.get(`${serverUrl}/api/files`, {
      ...config,
      params
    });

    const files = response.data?.files || [];
    allFiles.push(...files);

    if (estimatedTotal === null && typeof response.data?.total === 'number') {
      estimatedTotal = response.data.total;
    }

    if (onProgress) {
      onProgress(allFiles.length, estimatedTotal || allFiles.length);
    }

    if (!files || files.length < PAGE_LIMIT) break;
    offset += files.length;
    if (typeof estimatedTotal === 'number' && offset >= estimatedTotal) break;
    
    await quickYield();
  }

  return allFiles;
};

// ============================================================================
// DEDUPLICATION HELPERS
// ============================================================================

const decodeServerFilename = (value) => {
  try {
    if (!value || typeof value !== 'string') return value;
    if (value.indexOf('%') === -1) return value;
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
};

/**
 * Build dedup sets from server manifests metadata (instant, no decryption)
 */
const buildDedupSetsFromServerMeta = (manifests) => {
  const manifestIds = new Set();
  const filenames = new Set();
  const fileHashes = new Set();
  const perceptualHashes = new Set();
  const baseNameSizes = new Map();
  const baseNameDates = new Map();

  for (const m of manifests) {
    if (m.manifestId) manifestIds.add(m.manifestId);
    
    if (m.filename) {
      const decodedFilename = decodeServerFilename(m.filename);
      const normalized = normalizeFilenameForCompare(decodedFilename);
      if (normalized) filenames.add(normalized);
      
      const baseName = extractBaseFilename(decodedFilename);
      if (baseName) {
        if (m.originalSize) {
          if (!baseNameSizes.has(baseName)) baseNameSizes.set(baseName, new Set());
          baseNameSizes.get(baseName).add(m.originalSize);
        }
        if (m.creationTime) {
          const dateStr = normalizeDateForCompare(m.creationTime);
          if (dateStr) {
            if (!baseNameDates.has(baseName)) baseNameDates.set(baseName, new Set());
            baseNameDates.get(baseName).add(dateStr);
          }
        }
      }
    }
    
    if (m.fileHash) fileHashes.add(m.fileHash);
    if (m.perceptualHash) perceptualHashes.add(m.perceptualHash);
  }

  return { manifestIds, filenames, fileHashes, perceptualHashes, baseNameSizes, baseNameDates };
};

/**
 * Check if a server file should be skipped (already exists locally)
 * Uses same dedup logic as backup: manifestId, fileHash, perceptualHash (1-bit)
 * Plus filename match as fallback (critical for sync-selected where hashes aren't computed)
 */
const shouldSkipServerFile = (serverFile, localSets) => {
  const { manifestId, fileHash, perceptualHash } = serverFile;
  const filename = decodeServerFilename(serverFile?.originalName || serverFile?.filename || '');
  
  // Check by manifestId (filename + size hash)
  if (manifestId && localSets.manifestIds.has(manifestId)) {
    return { skip: true, reason: 'manifestId' };
  }
  
  // Check by normalized filename (same device: exact filename match is reliable)
  if (filename && localSets.filenames.size > 0) {
    const normalized = normalizeFilenameForCompare(filename);
    if (normalized && localSets.filenames.has(normalized)) {
      return { skip: true, reason: 'filename' };
    }
  }

  // Check by file hash (exact byte match - images and videos)
  if (fileHash && localSets.fileHashes.has(fileHash)) {
    return { skip: true, reason: 'fileHash' };
  }
  
  // Check by perceptual hash (images - 1-bit tolerance)
  if (perceptualHash && localSets.perceptualHashes.size > 0) {
    if (findPerceptualHashMatch(perceptualHash, localSets.perceptualHashes, SYNC_DHASH_THRESHOLD)) {
      return { skip: true, reason: 'perceptualHash' };
    }
  }
  
  return { skip: false };
};

const makeRestoreAssetKey = (manifestId, assetId) => `sc_asset:${manifestId}:${assetId}`;

const makeLocalServerRestoreId = (file) => {
  const id = file?.manifestId || file?.id || file?.fileId;
  if (id) return String(id);
  const filename = decodeServerFilename(file?.originalName || file?.filename || '');
  const size = file?.size || file?.fileSize || file?.bytes || '';
  const hash = file?.fileHash || file?.perceptualHash || '';
  if (!filename && !size && !hash) return null;
  return sha256(`local:${filename}:${size}:${hash}`);
};

const getRestoreAssetIds = (restoreHistory, manifestId) => {
  const prefix = `sc_asset:${manifestId}:`;
  const assetIds = [];
  for (const entry of restoreHistory) {
    if (typeof entry === 'string' && entry.startsWith(prefix)) {
      const assetId = entry.slice(prefix.length);
      if (assetId) assetIds.push(assetId);
    }
  }
  return assetIds;
};

const removeRestoreHistoryEntries = (restoreHistory, manifestId, makeHistoryKey) => {
  restoreHistory.delete(makeHistoryKey('sc', manifestId));
  const prefix = `sc_asset:${manifestId}:`;
  for (const entry of [...restoreHistory]) {
    if (typeof entry === 'string' && entry.startsWith(prefix)) {
      restoreHistory.delete(entry);
    }
  }
};

const hasExistingRestoreAsset = async (assetIds) => {
  for (const assetId of assetIds) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(assetId, Platform.OS === 'ios' ? { shouldDownloadFromNetwork: false } : undefined);
      if (info?.id) return true;
    } catch (_) {}
  }
  return false;
};

// ============================================================================
// LOCAL DEVICE SCANNING
// ============================================================================

/**
 * Scan local device files and build dedup sets
 * Scans ALL albums (Screenshots, Downloads, WhatsApp, user folders) + triggers iCloud download
 */
const buildLocalDedupFast = async (onStatus, onProgress, progressStart, progressEnd, abortRef) => {
  await loadHashCache();
  const stats = getHashCacheStats();

  // Always build localSets from MediaLibrary metadata (fast, zero file I/O).
  // Cached hashes are added as a bonus when available. This prevents sync from
  // ever falling back to buildLocalHashIndex which copies every file and takes hours.
  console.log(`[Sync] Fast dedup: building from metadata + ${stats.total} cached hashes (${stats.perceptual} phash, ${stats.file} fhash)`);
  updateStatus(onStatus, t('status.syncBuildingIndex', { count: stats.total }), true);
  updateProgress(onProgress, progressStart + (progressEnd - progressStart) * 0.1, true);

  const localSets = {
    manifestIds: new Set(),
    filenames: new Set(),
    fileHashes: new Set(),
    perceptualHashes: new Set(),
    baseNameSizes: new Map(),
    baseNameDates: new Map(),
  };

  const mediaTypes = Platform.OS === 'ios'
    ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
    : ['photo', 'video'];

  let photoLynkDeletedAssetIds = new Set();
  if (Platform.OS === 'android') {
    try {
      const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
      const deletedAlbum = albums.find(a => a.title === 'PhotoLynkDeleted');
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
      }
    } catch (e) {
      console.log('[Sync] Fast dedup could not get PhotoLynkDeleted album:', e?.message);
    }
  }

  let after = null;
  let scanned = 0;
  let cacheHits = 0;

  if (abortRef?.current) return localSets;

  let totalCount = 0;
  try {
    const countPage = await MediaLibrary.getAssetsAsync({ first: 1, mediaType: mediaTypes });
    totalCount = countPage?.totalCount || 0;
  } catch (e) {
    totalCount = 1000;
  }

  if (Platform.OS === 'android' && photoLynkDeletedAssetIds.size > 0 && totalCount > 0) {
    totalCount = Math.max(0, totalCount - photoLynkDeletedAssetIds.size);
  }

  updateStatus(onStatus, t('status.syncScanning', { current: 0, total: totalCount }), true);

  while (true) {
    const page = await MediaLibrary.getAssetsAsync({
      first: 500,
      after: after || undefined,
      mediaType: mediaTypes,
    });

    const assets = page?.assets || [];
    for (const asset of assets) {
      if (abortRef?.current) return localSets;
      if (photoLynkDeletedAssetIds.has(asset.id)) continue;
      scanned++;
      const filename = asset.filename;

      if (filename) {
        const normalized = normalizeFilenameForCompare(filename);
        if (normalized) localSets.filenames.add(normalized);

        const fileSize = asset.fileSize ? Number(asset.fileSize) : 0;
        if (fileSize) {
          const fileIdentity = computeFileIdentity(filename, fileSize);
          if (fileIdentity) localSets.manifestIds.add(sha256(`file:${fileIdentity}`));

          const baseName = extractBaseFilename(filename);
          if (baseName) {
            if (!localSets.baseNameSizes.has(baseName)) localSets.baseNameSizes.set(baseName, new Set());
            localSets.baseNameSizes.get(baseName).add(fileSize);
          }
        }

        const cached = await getAllCachedHashesAsync(asset);
        const cachedFileHash = cached?.fhash || null;
        const cachedPhash = cached?.phash || null;

        if (cachedFileHash) { localSets.fileHashes.add(cachedFileHash); cacheHits++; }
        if (cachedPhash) localSets.perceptualHashes.add(cachedPhash);

        if (asset.creationTime) {
          const baseName = extractBaseFilename(filename);
          const dateStr = normalizeDateForCompare(asset.creationTime);
          if (baseName && dateStr) {
            if (!localSets.baseNameDates.has(baseName)) localSets.baseNameDates.set(baseName, new Set());
            localSets.baseNameDates.get(baseName).add(dateStr);
          }
        }
      }

      if (scanned % 500 === 0) {
        const progress = progressStart + (progressEnd - progressStart) * (scanned / Math.max(totalCount, 1));
        updateProgress(onProgress, Math.min(progress, progressEnd), true);
        updateStatus(onStatus, t('status.syncScanning', { current: scanned, total: totalCount }), true);
        await quickYield();
      }
    }

    after = page?.endCursor;
    if (!page?.hasNextPage || assets.length === 0) break;
    await quickYield();
  }

  updateProgress(onProgress, progressEnd, true);

  console.log(`[Sync] Fast dedup: ${scanned} files scanned, ${cacheHits} cache hits, ` +
    `${localSets.filenames.size} filenames, ${localSets.manifestIds.size} manifestIds, ` +
    `${localSets.fileHashes.size} fileHashes, ${localSets.perceptualHashes.size} perceptualHashes`);

  return localSets;
};

const scanLocalPhotosForDedup = async (onStatus, onProgress, progressStart, progressEnd, abortRef) => {
  const localSets = {
    manifestIds: new Set(),
    filenames: new Set(),
    fileHashes: new Set(),
    perceptualHashes: new Set(),
    baseNameSizes: new Map(),
    baseNameDates: new Map(),
  };

  // Collect all assets from all albums + trigger iCloud download
  const allAssets = await collectAllAssetsFromAllAlbums(onStatus, onProgress, progressStart, progressStart + (progressEnd - progressStart) * 0.7, abortRef);
  
  // Build dedup sets from collected assets
  updateStatus(onStatus, t('status.syncBuildingIndex', { count: allAssets.length }), true);
  
  for (let i = 0; i < allAssets.length; i++) {
    if (abortRef?.current) return localSets;
    const asset = allAssets[i];
    const filename = asset.filename;
    
    if (filename) {
      const normalized = normalizeFilenameForCompare(filename);
      if (normalized) localSets.filenames.add(normalized);
      
      // Compute manifestId (filename + size) - must match how backup computes it
      // Backup uses actual file size in bytes (assetInfo.fileSize), so we must use the same
      const fileSize = asset.fileSize ? Number(asset.fileSize) : 0;
      
      const fileIdentity = computeFileIdentity(filename, fileSize);
      if (fileIdentity) {
        const manifestId = sha256(`file:${fileIdentity}`);
        localSets.manifestIds.add(manifestId);
      }
      
      // Base name + size/date for fallback dedup
      const baseName = extractBaseFilename(filename);
      if (baseName) {
        if (fileSize) {
          if (!localSets.baseNameSizes.has(baseName)) localSets.baseNameSizes.set(baseName, new Set());
          localSets.baseNameSizes.get(baseName).add(fileSize);
        }
        
        if (asset.creationTime) {
          const dateStr = normalizeDateForCompare(asset.creationTime);
          if (dateStr) {
            if (!localSets.baseNameDates.has(baseName)) localSets.baseNameDates.set(baseName, new Set());
            localSets.baseNameDates.get(baseName).add(dateStr);
          }
        }
      }
    }
    
    // Progress update every 100 files
    if (i % 100 === 0) {
      const progress = progressStart + (progressEnd - progressStart) * (0.7 + 0.3 * (i / allAssets.length));
      updateProgress(onProgress, Math.min(progress, progressEnd));
      updateStatus(onStatus, t('status.syncIndexing', { current: i, total: allAssets.length }));
      await quickYield();
    }
  }

  // Final progress update
  updateProgress(onProgress, progressEnd, true);
  updateStatus(onStatus, t('status.syncIndexed', { count: allAssets.length }), true);

  console.log(`[Sync] Local scan: ${localSets.filenames.size} filenames, ${localSets.manifestIds.size} manifestIds`);
  return localSets;
};

/**
 * Build local dedup index for StealthCloud restore
 * Scans ALL albums (Screenshots, Downloads, WhatsApp, user folders) + triggers iCloud download
 * Computes actual file hashes for cross-device dedup
 */
const buildLocalHashIndex = async (resolveReadableFilePath, onStatus, onProgress, progressStart, progressEnd, abortRef) => {
  const localSets = {
    manifestIds: new Set(),
    filenames: new Set(),
    fileHashes: new Set(),
    perceptualHashes: new Set(),
    baseNameSizes: new Map(),
    baseNameDates: new Map(),
  };

  // Load hash cache for faster dedup (avoids re-hashing files)
  await loadHashCache();

  // Collect all assets from all albums + trigger iCloud download
  const allAssets = await collectAllAssetsFromAllAlbums(onStatus, onProgress, progressStart, progressStart + (progressEnd - progressStart) * 0.3, abortRef);
  
  // Build dedup sets from collected assets - compute hashes for cross-device dedup
  console.log(`[Sync] ${Platform.OS}: Starting hash computation for ${allAssets.length} assets`);
  updateStatus(onStatus, t('status.syncBuildingIndex', { count: allAssets.length }), true);
  
  let hashedCount = 0;
  let hashErrors = 0;
  let resolveErrors = 0;
  
  let cacheHitCount = 0;
  
  for (let i = 0; i < allAssets.length; i++) {
    if (abortRef?.current) return localSets;
    const asset = allAssets[i];
    const filename = asset.filename;
    
    if (filename) {
      // Primary dedup: exact filename match (fast and reliable)
      const normalized = normalizeFilenameForCompare(filename);
      if (normalized) localSets.filenames.add(normalized);
      
      // Base name for cross-platform variant matching
      const baseName = extractBaseFilename(filename);
      
      // FAST PATH: If ANY hash is already cached, skip expensive file resolution
      // After local backup, images may only have phash (not fhash) — still use fast path
      const isVideo = asset.mediaType === 'video' || (asset.duration && asset.duration > 0);
      const cachedFileHash = getCachedHash(asset, 'file');
      const cachedPhash = isVideo ? null : getCachedHash(asset, 'perceptual');
      const anyCached = !!(cachedFileHash || cachedPhash);
      
      if (anyCached) {
        // Add cached hashes directly — no file I/O needed
        if (cachedFileHash) localSets.fileHashes.add(cachedFileHash);
        if (cachedPhash) localSets.perceptualHashes.add(cachedPhash);
        hashedCount++;
        cacheHitCount++;
        
        // Use asset.fileSize from MediaLibrary metadata for manifestId (avoids getInfoAsync)
        const metaSize = asset.fileSize ? Number(asset.fileSize) : null;
        if (metaSize) {
          const fileIdentity = computeFileIdentity(filename, metaSize);
          if (fileIdentity) localSets.manifestIds.add(sha256(`file:${fileIdentity}`));
          if (baseName) {
            if (!localSets.baseNameSizes.has(baseName)) localSets.baseNameSizes.set(baseName, new Set());
            localSets.baseNameSizes.get(baseName).add(metaSize);
          }
        }
        
        if (baseName && asset.creationTime) {
          const dateStr = normalizeDateForCompare(asset.creationTime);
          if (dateStr) {
            if (!localSets.baseNameDates.has(baseName)) localSets.baseNameDates.set(baseName, new Set());
            localSets.baseNameDates.get(baseName).add(dateStr);
          }
        }
        
        // Progress update every 100 cached files
        if (cacheHitCount % 100 === 0) {
          const progress = progressStart + (progressEnd - progressStart) * (0.3 + 0.7 * (i / allAssets.length));
          updateProgress(onProgress, Math.min(progress, progressEnd));
          updateStatus(onStatus, t('status.syncHashing', { current: i + 1, total: allAssets.length, filename: formatFilenameForStatus(filename) }));
          await quickYield();
        }
        continue;
      }
      
      // SLOW PATH: use localUri directly — avoid expensive file copy.
      // resolveReadableFilePath copies every file to app cache (200-500ms each).
      // For 2600 files that's 10+ minutes of pure copying. Instead get content://
      // URI directly and hash via react-native-blob-util / PixelHash (native modules
      // can read content URIs directly without copying).
      let localUri = null;
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        localUri = info?.localUri || info?.uri || null;
      } catch (e) {
        if (i < 3) console.log(`[Sync] File ${i}: getAssetInfoAsync failed: ${e.message}`);
      }

      if (localUri) {
        if (i < 3) console.log(`[Sync] File ${i}: ${filename} -> ${localUri.substring(0, 80)}...`);

        // Use asset.fileSize from MediaLibrary metadata — already in memory, zero I/O
        const fileSize = asset.fileSize ? Number(asset.fileSize) : null;
        if (fileSize) {
          const fileIdentity = computeFileIdentity(filename, fileSize);
          if (fileIdentity) localSets.manifestIds.add(sha256(`file:${fileIdentity}`));
          if (baseName) {
            if (!localSets.baseNameSizes.has(baseName)) localSets.baseNameSizes.set(baseName, new Set());
            localSets.baseNameSizes.get(baseName).add(fileSize);
          }
        }

        // Compute file hash using localUri directly (react-native-blob-util handles content URIs)
        try {
          let fileHash = cachedFileHash;
          if (!fileHash) {
            fileHash = await computeExactFileHash(localUri);
            if (fileHash) setCachedHash(asset, 'file', fileHash);
          }
          if (fileHash) {
            localSets.fileHashes.add(fileHash);
            hashedCount++;
          }
        } catch (e) {
          if (i < 10) console.log(`[Sync] File ${i}: fileHash error: ${e.message}`);
          hashErrors++;
        }

        // Perceptual hash: try with localUri. On iOS localUri is file:// so it works.
        // On Android content:// may or may not work with PixelHash — if it fails we
        // still have filename + fileHash + size dedup which catches 95%+ of duplicates.
        if (!isVideo) {
          try {
            let phash = cachedPhash;
            if (!phash) {
              phash = await computePerceptualHash(localUri, asset, { filename, mediaType: asset.mediaType });
              if (phash) setCachedHash(asset, 'perceptual', phash);
            }
            if (phash) {
              localSets.perceptualHashes.add(phash);
              hashedCount++;
            }
          } catch (e) {
            hashErrors++;
          }
        }
      } else {
        resolveErrors++;
        // Fallback: use pixel dimensions as approximate size
        const approxSize = asset.width && asset.height ? (asset.width * asset.height) : 0;
        if (baseName && approxSize > 0) {
          if (!localSets.baseNameSizes.has(baseName)) localSets.baseNameSizes.set(baseName, new Set());
          localSets.baseNameSizes.get(baseName).add(approxSize);
        }
      }
      
      // Base name + date for fallback dedup
      if (baseName && asset.creationTime) {
        const dateStr = normalizeDateForCompare(asset.creationTime);
        if (dateStr) {
          if (!localSets.baseNameDates.has(baseName)) localSets.baseNameDates.set(baseName, new Set());
          localSets.baseNameDates.get(baseName).add(dateStr);
        }
      }
    }
    
    // Progress update every file (hashing can be slow for large files)
    const progress = progressStart + (progressEnd - progressStart) * (0.3 + 0.7 * (i / allAssets.length));
    updateProgress(onProgress, Math.min(progress, progressEnd));
    updateStatus(onStatus, t('status.syncHashing', { current: i + 1, total: allAssets.length, filename: formatFilenameForStatus(filename || 'file') }));
    await quickYield();
  }
  
  console.log(`[Sync] Cache fast-path: ${cacheHitCount}/${allAssets.length} assets skipped file I/O`);

  // Final progress update
  updateProgress(onProgress, progressEnd, true);
  updateStatus(onStatus, t('status.syncIndexed', { count: allAssets.length }), true);

  // Flush hash cache to disk
  await flushHashCache();

  console.log(`[Sync] Local index: ${localSets.filenames.size} filenames, ${localSets.manifestIds.size} manifestIds, ${localSets.fileHashes.size} fileHashes, ${localSets.perceptualHashes.size} perceptualHashes (hashed=${hashedCount}, hashErrors=${hashErrors}, resolveErrors=${resolveErrors})`);
  return localSets;
};

// ============================================================================
// STEALTHCLOUD RESTORE
// ============================================================================

/**
 * Optimized StealthCloud restore
 * 
 * Phases:
 * 1. Permissions (0%)
 * 2. Fetch server manifests with metadata (0-5%)
 * 3. Scan local photos for dedup (5-15%)
 * 4. Filter files to download (15-20%)
 * 5. Download, decrypt, save each file (20-100%)
 */
export const stealthCloudRestoreCore = async ({
  config,
  SERVER_URL,
  masterKey,
  legacyKey,
  resolveReadableFilePath,
  restoreHistory,
  saveRestoreHistory,
  makeHistoryKey,
  manifestIds = null, // Optional: specific manifests to restore (Choose Files mode)
  fastMode = false,
  onStatus = () => {},
  onProgress = () => {},
  abortRef,
  appStateRef,
}) => {
  resetProgress();
  setFastMode(!!fastMode); // Enable fast mode optimizations (skip most yields)

  // Avoid concurrent hashing work with background pre-analysis
  await abortPreAnalysis('sync');

  // Prime device capability cache so concurrency helpers use correct tier
  await getDeviceCapability();

  // ========== PHASE 1: Setup (0-1%) ==========
  onStatus(t('status.syncPreparing'));
  onProgress(0.01);
  await yieldToUi();

  // ========== PHASE 2: Fetch Server Manifests (1-5%) ==========
  onStatus(t('status.fetchingServerState'));

  let serverManifests = [];
  try {
    serverManifests = await fetchManifestsWithMeta(SERVER_URL, config, (fetched, total) => {
      const progress = 0.01 + (fetched / (total || fetched)) * 0.04;
      updateProgress(onProgress, progress);
      updateStatus(onStatus, total > fetched ? t('status.syncFetching', { fetched, total }) : t('status.syncFetchingSimple', { fetched }));
    });
  } catch (e) {
    console.error('Failed to fetch manifests:', e?.message);
    return { restored: 0, skipped: 0, failed: 0, error: e?.message };
  }

  updateProgress(onProgress, 0.05, true);
  await yieldToUi();

  // Filter to specific manifests if provided
  if (manifestIds && Array.isArray(manifestIds) && manifestIds.length > 0) {
    const allowed = new Set(manifestIds.map(v => String(v)));
    serverManifests = serverManifests.filter(m => m?.manifestId && allowed.has(String(m.manifestId)));
  }

  if (serverManifests.length === 0) {
    // No backups - animate to 100%
    for (let p = 0.05; p <= 1.0; p += 0.15) {
      onProgress(Math.min(p, 1.0));
      await sleep(40);
    }
    onProgress(1);
    return { restored: 0, skipped: 0, failed: 0, noBackups: true };
  }

  onStatus(t('status.syncFoundFiles', { count: serverManifests.length }));
  await yieldToUi();

  // ========== PHASE 3: Scan Local Photos (1-10%) ==========
  onStatus(t('status.syncScanningLocal'));
  updateProgress(onProgress, 0.01, true); // Start at 1% so user sees action

  let localSets = await buildLocalDedupFast(onStatus, onProgress, 0.01, 0.10, abortRef);
  if (!localSets) {
    localSets = await buildLocalHashIndex(resolveReadableFilePath, onStatus, onProgress, 0.01, 0.10, abortRef);
  }
  
  updateProgress(onProgress, 0.10, true);
  await yieldToUi();

  // Auto-prune restoreHistory: remove entries for files no longer on device
  // This allows re-downloading files that were previously synced but then deleted
  let pruned = 0;
  for (const manifest of serverManifests) {
    const manifestId = manifest?.manifestId;
    if (!manifestId) continue;
    const hk = makeHistoryKey('sc', manifestId);
    if (!restoreHistory.has(hk)) continue;

    const assetIds = getRestoreAssetIds(restoreHistory, manifestId);
    if (assetIds.length > 0) {
      const exists = await hasExistingRestoreAsset(assetIds);
      if (!exists) {
        removeRestoreHistoryEntries(restoreHistory, manifestId, makeHistoryKey);
        pruned++;
      }
      continue;
    }

    // Legacy fallback: old history entries have no asset marker yet.
    if (!shouldSkipServerFile(manifest, localSets).skip) {
      removeRestoreHistoryEntries(restoreHistory, manifestId, makeHistoryKey);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[Sync] Pruned ${pruned} stale history entries (files no longer on device)`);
    await saveRestoreHistory(restoreHistory);
  }

  // ========== PHASE 4: Filter Files to Download (10-15%) ==========
  onStatus(t('status.syncComparing', { current: 0, total: serverManifests.length }));

  const toDownload = [];
  let skipped = 0;

  const skipReasons = {};
  let historySkipped = 0;
  
  for (let i = 0; i < serverManifests.length; i++) {
    const manifest = serverManifests[i];
    
    // Check restore history
    const historyKey = makeHistoryKey('sc', manifest.manifestId);
    if (restoreHistory.has(historyKey)) {
      historySkipped++;
      skipped++;
      continue;
    }
    
    // Check local dedup
    const check = shouldSkipServerFile(manifest, localSets);
    if (check.skip) {
      skipped++;
      skipReasons[check.reason] = (skipReasons[check.reason] || 0) + 1;
      if (i < 10) console.log(`[Sync] Skip ${manifest.filename}: ${check.reason}`);
      continue;
    }
    
    // Log files that will be downloaded
    if (toDownload.length < 5) console.log(`[Sync] Will download: ${manifest.filename} (no local match)`);
    toDownload.push(manifest);
    
    if (i % 100 === 0) {
      updateStatus(onStatus, t('status.syncComparing', { current: i + 1, total: serverManifests.length }));
      await quickYield();
    }
  }
  
  console.log(`[Sync] Comparison done: toDownload=${toDownload.length}, skipped=${skipped} (history=${historySkipped})`, skipReasons);

  updateProgress(onProgress, 0.15, true);

  if (toDownload.length === 0) {
    // All files already synced - animate progress 15% to 100% smoothly
    onStatus(t('status.allFilesSynced', { count: skipped }));
    for (let p = 0.20; p <= 1.0; p += 0.10) {
      onProgress(Math.min(p, 1.0));
      await sleep(30);
    }
    onProgress(1);
    await sleep(100);
    return { restored: 0, skipped, failed: 0, allSynced: true };
  }

  // ========== PHASE 5: Download Each File (15-100%) ==========
  let restored = 0;
  let failed = 0;
  let historyWrites = 0;

  const shouldRetryDownload = (e) => {
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('404') || msg.includes('not found')) return false;
    return shouldRetryChunkUpload(e);
  };

  for (let i = 0; i < toDownload.length; i++) {
    // Check abort
    if (abortRef?.current) {
      console.log('Sync aborted by user');
      return { restored, skipped, failed, aborted: true };
    }

    const manifest = toDownload[i];
    const fileNum = i + 1;
    const mid = manifest.manifestId;

    // Progress: 15-100%
    const progress = 0.15 + (fileNum / toDownload.length) * 0.85;
    updateProgress(onProgress, progress);
    updateStatus(onStatus, t('status.syncDownloadingFile', { current: fileNum, total: toDownload.length, filename: formatFilenameForStatus(manifest.filename || 'file') }), true);

    // Yield every few files
    if (i % 3 === 0) await yieldToUi();

    await waitForActiveApp(appStateRef);

    try {
      // Fetch full manifest (need encrypted data)
      const manRes = await withRetries(async () => {
        return await axios.get(`${SERVER_URL}/api/cloud/manifests/${mid}`, { 
          headers: config.headers, 
          timeout: 30000 
        });
      }, { retries: 10, baseDelayMs: 1000, maxDelayMs: 30000, shouldRetry: shouldRetryDownload });

      const payload = manRes.data;
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const enc = JSON.parse(parsed.encryptedManifest);
      
      // Decrypt manifest — try secure key first, then legacy fallback
      const manifestNonce = naclUtil.decodeBase64(enc.manifestNonce);
      const manifestBox = naclUtil.decodeBase64(enc.manifestBox);
      let manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, masterKey);
      if (!manifestPlain && legacyKey) {
        manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, legacyKey);
      }

      if (!manifestPlain) {
        failed++;
        continue;
      }

      const fullManifest = JSON.parse(naclUtil.encodeUTF8(manifestPlain));
      const filename = fullManifest.filename || `${mid}.bin`;
      
      // Decrypt file key — try secure key first, then legacy fallback
      const wrapNonce = naclUtil.decodeBase64(fullManifest.wrapNonce);
      const wrappedFileKey = naclUtil.decodeBase64(fullManifest.wrappedFileKey);
      let fileKey = nacl.secretbox.open(wrappedFileKey, wrapNonce, masterKey);
      if (!fileKey && legacyKey) {
        fileKey = nacl.secretbox.open(wrappedFileKey, wrapNonce, legacyKey);
      }

      if (!fileKey) {
        failed++;
        continue;
      }

      const baseNonce16 = naclUtil.decodeBase64(fullManifest.baseNonce16);

      // Prepare output file - sanitize for local storage
      const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      const outUri = `${FileSystem.cacheDirectory}${safeFilename}`;
      const outPath = normalizeFilePath(outUri);
      await FileSystem.deleteAsync(outUri, { idempotent: true });
      await FileSystem.writeAsStringAsync(outUri, '', { encoding: FileSystem.EncodingType.Base64 });

      // Get blob util for appending
      let ReactNativeBlobUtil = null;
      try {
        const mod = require('react-native-blob-util');
        ReactNativeBlobUtil = mod?.default || mod;
      } catch (e) {}
      
      if (!ReactNativeBlobUtil?.fs?.appendFile) {
        throw new Error('StealthCloud restore requires a development build (react-native-blob-util).');
      }

      // Download and decrypt chunks (adaptive parallelism based on device capability)
      const maxParallel = Math.max(1, chooseFileParallelDownloads({ platform: Platform.OS, fastMode }));
      const chunkIds = fullManifest.chunkIds || [];

      for (let batchStart = 0; batchStart < chunkIds.length; batchStart += maxParallel) {
        if (abortRef?.current) {
          console.log('Sync aborted during chunk download');
          return { restored, skipped, failed, aborted: true };
        }
        const batchEnd = Math.min(batchStart + maxParallel, chunkIds.length);
        const batchMap = new Map();

        // Download batch in parallel
        const batchPromises = [];
        for (let c = batchStart; c < batchEnd; c++) {
          batchPromises.push((async () => {
            const chunkId = chunkIds[c];
            const tmpPath = `${FileSystem.cacheDirectory}sc_dl_${chunkId}.bin`;
            await FileSystem.deleteAsync(tmpPath, { idempotent: true });
            
            await withRetries(async () => {
              await FileSystem.downloadAsync(`${SERVER_URL}/api/cloud/chunks/${chunkId}`, tmpPath, { 
                headers: config.headers 
              });
            }, { retries: 20, baseDelayMs: 2000, maxDelayMs: 30000, shouldRetry: shouldRetryDownload });
            
            const chunkB64 = await FileSystem.readAsStringAsync(tmpPath, { encoding: FileSystem.EncodingType.Base64 });
            await FileSystem.deleteAsync(tmpPath, { idempotent: true });
            batchMap.set(c, chunkB64);
          })());
        }
        await Promise.all(batchPromises);

        // Decrypt and append in order
        for (let c = batchStart; c < batchEnd; c++) {
          await quickYield();
          
          const chunkB64 = batchMap.get(c);
          const boxed = naclUtil.decodeBase64(chunkB64);
          const nonce = makeChunkNonce(baseNonce16, c);
          const plaintext = nacl.secretbox.open(boxed, nonce, fileKey);
          
          if (!plaintext) throw new Error('Chunk decrypt failed');

          const p64 = naclUtil.encodeBase64(plaintext);
          await ReactNativeBlobUtil.fs.appendFile(outPath, p64, 'base64');
        }
      }

      // Retrieve and apply EXIF if available (for cross-platform preservation)
      const fileHash = fullManifest.fileHash;
      if (fileHash && /\.(jpg|jpeg|png|heic|heif|gif|bmp|webp|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|avif|psd|psb|exr|hdr)$/i.test(filename || '')) {
        try {
          const exifRes = await axios.get(`${SERVER_URL}/api/exif/${fileHash}`, {
            headers: config.headers,
            timeout: 10000,
            validateStatus: (status) => status < 500, // Don't throw on 404
          });
          if (exifRes.status === 200 && exifRes.data?.exif) {
            // Apply EXIF to file using native module
            // ONLY if the file doesn't already have EXIF — writeExif re-encodes
            // the JPEG, destroying original file bytes & SHA256.
            if (ExifExtractor?.writeExif) {
              let hasExif = false;
              try {
                if (ExifExtractor.extractExif) {
                  const existing = await ExifExtractor.extractExif(outPath);
                  if (existing?.captureTime || existing?.make) hasExif = true;
                }
              } catch (_) {}
              if (!hasExif) {
                try {
                  await ExifExtractor.writeExif(outPath, exifRes.data.exif);
                  console.log(`[EXIF] Applied EXIF to ${filename}`);
                } catch (writeErr) {
                  console.log('[EXIF] Write failed (non-critical):', writeErr?.message);
                }
              } else {
                console.log(`[EXIF] File already has EXIF, skipping re-write: ${filename}`);
              }
            } else {
              console.log(`[EXIF] Retrieved EXIF for ${filename} (writeExif not available)`);
            }
          }
        } catch (e) {
          // Non-critical - don't fail restore if EXIF retrieval fails
          console.log('[EXIF] Retrieve failed (non-critical):', e?.message);
        }
      }

      // Save to media library
      // iOS: use native methods to preserve original file bytes (MediaLibrary.saveToLibraryAsync re-encodes JPEGs and strips EXIF)
      const isRawFormat = /\.(dng|cr2|cr3|nef|arw|orf|rw2|pef|srw|raf)$/i.test(filename || '');
      const isMovFile = /\.mov$/i.test(filename || '');
      const isVideoFile = SUPPORTED_VIDEO_RE.test(filename || '');
      const savePath = outUri.startsWith('file://') ? outUri.replace('file://', '') : outUri;
      let savedAssetId = null;
      if (Platform.OS === 'ios' && isRawFormat && ExifExtractor?.saveRawToLibrary) {
        try {
          const saveResult = await ExifExtractor.saveRawToLibrary(savePath);
          savedAssetId = saveResult?.assetId || null;
          console.log(`[Sync] Saved RAW to library via native module: ${filename}`);
        } catch (rawErr) {
          console.warn(`[Sync] saveRawToLibrary failed, falling back: ${rawErr?.message}`);
          await MediaLibrary.saveToLibraryAsync(outUri);
        }
      } else if (Platform.OS === 'ios' && ExifExtractor?.saveFileToLibrary) {
        try {
          const saveResult = await ExifExtractor.saveFileToLibrary(savePath);
          savedAssetId = saveResult?.assetId || null;
          console.log(`[Sync] Saved to library via saveFileToLibrary (byte-preserving): ${filename}`);
        } catch (saveErr) {
          console.warn(`[Sync] saveFileToLibrary failed, falling back: ${saveErr?.message}`);
          await MediaLibrary.saveToLibraryAsync(outUri);
        }
      } else if (Platform.OS === 'android' && isVideoFile && ExifExtractor?.saveVideoToLibrary) {
        try {
          await ExifExtractor.saveVideoToLibrary(savePath);
          console.log(`[Sync] Saved video to gallery via MediaStore: ${filename}`);
        } catch (vidErr) {
          console.warn(`[Sync] saveVideoToLibrary failed, falling back: ${vidErr?.message}`);
          if (isMovFile && ExifExtractor?.saveQuickTimeToLibrary) {
            try {
              await ExifExtractor.saveQuickTimeToLibrary(savePath);
              console.log(`[Sync] Saved .mov to gallery via legacy path: ${filename}`);
            } catch (movErr) {
              console.warn(`[Sync] saveQuickTimeToLibrary failed, final fallback: ${movErr?.message}`);
              await MediaLibrary.saveToLibraryAsync(outUri);
            }
          } else {
            await MediaLibrary.saveToLibraryAsync(outUri);
          }
        }
      } else if (Platform.OS === 'android' && isMovFile && ExifExtractor?.saveQuickTimeToLibrary) {
        try {
          await ExifExtractor.saveQuickTimeToLibrary(savePath);
          console.log(`[Sync] Saved .mov to gallery via native module: ${filename}`);
        } catch (movErr) {
          console.warn(`[Sync] saveQuickTimeToLibrary failed, falling back: ${movErr?.message}`);
          await MediaLibrary.saveToLibraryAsync(outUri);
        }
      } else {
        await MediaLibrary.saveToLibraryAsync(outUri);
      }
      await FileSystem.deleteAsync(outUri, { idempotent: true });
      
      restored++;

      // Update history
      const historyKey = makeHistoryKey('sc', mid);
      restoreHistory.add(historyKey);
      if (savedAssetId) {
        restoreHistory.add(makeRestoreAssetKey(mid, savedAssetId));
      }
      historyWrites++;
      
      if (historyWrites % 10 === 0) {
        await saveRestoreHistory(restoreHistory);
      }

      // Thermal management
      const cooldown = getAssetCooldownMs(fastMode);
      if (cooldown > 0) await sleep(cooldown);

      const batchLimit = getBatchLimit(fastMode);
      if (restored > 0 && restored % batchLimit === 0) {
        const batchCooldown = getBatchCooldownMs(fastMode);
        if (batchCooldown > 0) {
          onStatus(`Sync: Cooling down (batch ${Math.floor(restored / batchLimit)})...`);
          await sleep(batchCooldown);
        }
      }

    } catch (e) {
      console.warn('Restore failed for manifest:', mid, e?.message);
      failed++;
    }
  }

  // Final history save
  if (historyWrites > 0) {
    try {
      await saveRestoreHistory(restoreHistory);
    } catch (e) {}
  }

  updateProgress(onProgress, 1.0, true);
  updateStatus(onStatus, t('status.syncCompleteStats', { restored, skipped, failed }), true);

  return { restored, skipped, failed };
};

// ============================================================================
// LOCAL/REMOTE RESTORE
// ============================================================================

/**
 * Optimized Local/Remote restore
 * 
 * Phases:
 * 1. Fetch server files (progress hidden)
 * 2. Scan local photos (progress hidden)
 * 3. Filter files to download (progress hidden)
 * 4. Download and save each file (0-100%)
 */
export const localRemoteRestoreCore = async ({
  config,
  SERVER_URL,
  resolveReadableFilePath, // Required for hash computation
  onlyFilenames = null, // Optional: specific filenames to restore
  fastMode = false,
  onStatus = () => {},
  onProgress = () => {},
  abortRef,
  appStateRef, // For pausing when backgrounded
  restoreHistory = null,
  saveRestoreHistory = null,
  makeHistoryKey = null,
}) => {
  resetProgress();
  setFastMode(!!fastMode); // Enable fast mode optimizations (skip most yields)

  // Avoid concurrent hashing work with background pre-analysis
  await abortPreAnalysis('syncSelected');

  // Prime device capability cache so concurrency helpers use correct tier
  await getDeviceCapability();

  // ========== PHASE 1: Fetch Server Files (0-5%) ==========
  onStatus(t('status.fetchingServerState'));
  onProgress(0.01);

  let serverFiles = [];
  try {
    // Fetch with meta=true to get hash metadata for cross-device dedup
    serverFiles = await fetchServerFilesPaged(SERVER_URL, config, (fetched, total) => {
      const progress = 0.01 + (fetched / (total || fetched)) * 0.04;
      updateProgress(onProgress, progress);
      updateStatus(onStatus, total > fetched ? t('status.syncFetching', { fetched, total }) : t('status.syncFetchingSimple', { fetched }));
    }, true); // includeMeta=true
  } catch (e) {
    console.error('Failed to fetch server files:', e?.message);
    return { restored: 0, skipped: 0, failed: 0, error: e?.message };
  }

  updateProgress(onProgress, 0.05, true);
  await yieldToUi();

  // Filter to specific filenames if provided
  if (onlyFilenames && Array.isArray(onlyFilenames) && onlyFilenames.length > 0) {
    const allowed = new Set(onlyFilenames.map(v => normalizeFilenameForCompare(v)).filter(Boolean));
    serverFiles = serverFiles.filter(f => {
      const nf = normalizeFilenameForCompare(f?.filename);
      return nf ? allowed.has(nf) : false;
    });
  }

  if (serverFiles.length === 0) {
    // No files - animate to 100%
    for (let p = 0.05; p <= 1.0; p += 0.15) {
      onProgress(Math.min(p, 1.0));
      await sleep(40);
    }
    onProgress(1);
    return { restored: 0, skipped: 0, failed: 0, noFiles: true };
  }

  onStatus(t('status.syncFoundFiles', { count: serverFiles.length }));
  await yieldToUi();

  // ========== PHASE 2: Scan Local Photos (1-10%) ==========
  onStatus(t('status.syncScanningLocal'));
  updateProgress(onProgress, 0.01, true); // Start at 1% so user sees action

  let localSets = await buildLocalDedupFast(onStatus, onProgress, 0.01, 0.10, abortRef);
  if (!localSets) {
    localSets = await buildLocalHashIndex(resolveReadableFilePath, onStatus, onProgress, 0.01, 0.10, abortRef);
  }
  
  updateProgress(onProgress, 0.10, true);
  await yieldToUi();

  // ========== PHASE 3: Filter Files to Download (10-15%) ==========
  onStatus(t('status.syncComparing', { current: 0, total: serverFiles.length }));
  
  // Debug: count server files with hashes
  const serverWithPhash = serverFiles.filter(f => f?.perceptualHash).length;
  const serverWithFhash = serverFiles.filter(f => f?.fileHash).length;
  console.log(`[Sync] Server files: ${serverFiles.length} total, ${serverWithPhash} with perceptualHash, ${serverWithFhash} with fileHash`);
  console.log(`[Sync] Local sets: ${localSets.perceptualHashes?.size || 0} perceptualHashes, ${localSets.fileHashes?.size || 0} fileHashes`);
  
  const toDownload = [];
  let skipped = 0;
  const skipReasons = {};

  for (let i = 0; i < serverFiles.length; i++) {
    const file = serverFiles[i];

    // Log first few files for debugging
    if (i < 5) {
      console.log(`[Sync] Server file ${i}: "${file?.filename}" phash: ${file?.perceptualHash || 'none'}, fhash: ${file?.fileHash?.substring(0, 16) || 'none'}`);
    }

    const localRestoreId = makeLocalServerRestoreId(file);
    if (restoreHistory && makeHistoryKey && localRestoreId && restoreHistory.has(makeHistoryKey('ls', localRestoreId))) {
      skipped++;
      skipReasons.restoreHistory = (skipReasons.restoreHistory || 0) + 1;
      if (i < 10) console.log(`[Sync] Skip ${file?.filename}: restoreHistory`);
    } else {
      const check = shouldSkipServerFile(file, localSets);
      if (check.skip) {
        skipped++;
        skipReasons[check.reason] = (skipReasons[check.reason] || 0) + 1;
        if (i < 10) console.log(`[Sync] Skip ${file?.filename}: ${check.reason}`);
      } else {
        if (toDownload.length < 5) console.log(`[Sync] Will download: ${file?.filename} (no local match)`);
        toDownload.push(file);
      }
    }

    // Yield every 100 files to keep UI responsive during large server lists
    if (i > 0 && i % 100 === 0) await quickYield();
  }

  console.log(`[Sync] Comparison done: toDownload=${toDownload.length}, skipped=${skipped}`, skipReasons);

  console.log(`[Sync] About to update progress to 0.15`);
  updateProgress(onProgress, 0.15, true);
  console.log(`[Sync] Progress updated, about to yield`);
  await yieldToUi(); // Yield after comparison phase
  console.log(`[Sync] Yielded, checking if toDownload is empty`);

  if (toDownload.length === 0) {
    // All files already synced - animate progress 15% to 100% smoothly
    onStatus(t('status.allFilesSynced', { count: skipped }));
    for (let p = 0.20; p <= 1.0; p += 0.10) {
      onProgress(Math.min(p, 1.0));
      await sleep(30);
    }
    onProgress(1);
    await sleep(100);
    return { restored: 0, skipped, failed: 0, allSynced: true, serverTotal: serverFiles.length };
  }

  // ========== PHASE 4: Download Each File (15-100%) ==========
  console.log(`[Sync] Entering Phase 4: Download ${toDownload.length} files`);
  let restored = 0;
  let failed = 0;
  
  // Collect computed hashes to submit to server for future fast dedup
  const computedPlatformHashes = [];

  const maxParallel = chooseFileParallelDownloads({ platform: Platform.OS, fastMode });
  console.log(`[Sync] Creating concurrency limiters: maxParallel=${maxParallel}`);
  const runDownload = createConcurrencyLimiter(maxParallel);
  // Serialize saves was limit=1, but that creates a pipeline bottleneck:
  // when N downloads finish they all queue for save, blocking the download pool.
  // 2 concurrent saves is still safe on modern Android and halves the stall.
  const runSave = createConcurrencyLimiter(Platform.OS === 'android' ? 2 : 1);
  let processed = 0;

  console.log(`[Sync] Starting download phase: ${toDownload.length} files, maxParallel=${maxParallel}`);
  await yieldToUi(); // Yield before creating download tasks

  const serverTotal = serverFiles.length;
  // Create download tasks in batches to avoid blocking UI with huge .map() on large libraries
  const downloadTasks = [];
  const BATCH_CREATE_SIZE = 500;
  for (let batchStart = 0; batchStart < toDownload.length; batchStart += BATCH_CREATE_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_CREATE_SIZE, toDownload.length);
    for (let bi = batchStart; bi < batchEnd; bi++) {
      const file = toDownload[bi];
      downloadTasks.push(runDownload(async () => {
    console.log(`[Sync] Download task ${bi} started: ${file.filename}`);
    // Check abort
    if (abortRef?.current) {
      console.log(`[Sync] Download task ${bi} aborted`);
      return;
    }
    
    // Wait if app is backgrounded (pause instead of failing)
    await waitForActiveApp(appStateRef);

    const downloadUrl = `${SERVER_URL}/api/files/${encodeURIComponent(file.filename)}`;
    const originalFilename = String((file && (file.originalName || file.filename)) || 'file');
    const parts = originalFilename.split('.');
    const ext = parts.length > 1 ? `.${parts.pop()}` : '';
    const base = parts.join('.') || 'file';
    // Sanitize filename for filesystem and URL safety. Characters like %, +, ?, &, #
    // can break FileSystem operations or get double-encoded/decoded on Android.
    const safeBase = base.replace(/[\\/\u0000-\u001F%+,?&#=;:@\[\]<>|"]/g, '_');
    const suffixSource = String(file.fileHash || file.perceptualHash || file.manifestId || bi || '');
    const suffix = suffixSource ? `_${suffixSource}` : '';
    const safeFilename = `${safeBase}${suffix}${ext}`;
    const localUri = `${FileSystem.cacheDirectory}${safeFilename}`;

    try {
      await FileSystem.deleteAsync(localUri, { idempotent: true });

      // Timeout wrapper: FileSystem.downloadAsync has no built-in timeout.
      // A stalled TCP connection can hang forever. 120s is generous for local WiFi.
      const _downloadWithTimeout = async (url, uri, opts) => {
        return Promise.race([
          FileSystem.downloadAsync(url, uri, opts),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Download timeout after 120s')), 120_000)
          )
        ]);
      };

      let result;
      try {
        result = await _downloadWithTimeout(downloadUrl, localUri, {
          headers: config.headers
        });
      } catch (downloadErr) {
        if (String(downloadErr?.message || '').includes('timeout')) {
          console.warn(`[Sync] Download timeout for ${file.filename}, retrying once...`);
          await FileSystem.deleteAsync(localUri, { idempotent: true });
          try {
            result = await _downloadWithTimeout(downloadUrl, localUri, {
              headers: config.headers
            });
          } catch (retryErr) {
            throw retryErr;
          }
        } else if (!isBackgroundInterruptedError(downloadErr, appStateRef)) {
          throw downloadErr;
        } else {
          console.log(`[Sync] Download paused (backgrounded): ${file.filename}, waiting to retry...`);
          await waitForActiveApp(appStateRef);
          await FileSystem.deleteAsync(localUri, { idempotent: true });
          result = await _downloadWithTimeout(downloadUrl, localUri, {
            headers: config.headers
          });
        }
      }
      await quickYield(); // Yield after download

      if (result.status === 200) {
        // Check perceptual hash BEFORE saving to detect duplicates (handles iOS renaming)
        const filePath = localUri.startsWith('file://') ? localUri.slice(7) : localUri;
        const isVideo = SUPPORTED_VIDEO_RE.test(file.filename || '');
        const localRestoreId = makeLocalServerRestoreId(file);

        // Guard: skip hash for very large files (>1GB) to prevent OOM crash
        let fileSize = 0;
        try {
          const info = await FileSystem.getInfoAsync(localUri);
          fileSize = info?.size || 0;
        } catch (_) {}
        const MAX_HASH_SIZE = 1024 * 1024 * 1024; // 1 GB
        const skipHash = fileSize > MAX_HASH_SIZE;
        if (skipHash && bi < 10) {
          console.log(`[Sync] Skip hash for large file ${file.filename} (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)}GB > 1GB)`);
        }

        let isDuplicate = false;
        let computedHash = null;
        await quickYield(); // Yield before hash computation
        // Hash videos post-download so their fileHash can be cached locally.
        // Without this, video dedup depends only on manifestId/filename which
        // may change after gallery save (Android renames, size shifts).
        const shouldHashVideo = true;

        try {
          if (isVideo && !skipHash && shouldHashVideo) {
            computedHash = await computeExactFileHash(filePath);
            await quickYield(); // Yield after heavy hash computation
            const hasMatch = computedHash && localSets.fileHashes.has(computedHash);
            if (bi < 10) console.log(`[Sync] Video ${file.filename}: hash=${computedHash?.substring(0,16)}..., localHashes=${localSets.fileHashes.size}, match=${hasMatch}`);
            if (hasMatch) {
              isDuplicate = true;
            }
          } else if (!isVideo) {
            computedHash = await computePerceptualHash(filePath, null, { filename: file.filename, mediaType: 'photo' });
            await quickYield(); // Yield after heavy hash computation
            // Use exact match for session dedup (hashes added during this sync session)
            // Use threshold match only for pre-existing local files
            const hasExactMatch = computedHash && localSets.perceptualHashes.has(computedHash);
            if (bi < 10) console.log(`[Sync] Image ${file.filename}: phash=${computedHash}, localPhashes=${localSets.perceptualHashes.size}, exactMatch=${hasExactMatch}`);
            if (hasExactMatch) {
              isDuplicate = true;
            }
          }
        } catch (hashErr) {
          // Hash computation failed, proceed with save
          if (bi < 5) console.log(`[Sync] Hash check failed for ${file.filename}: ${hashErr.message}`);
        }
        
        if (isDuplicate) {
          if (computedHash) {
            if (isVideo) {
              localSets.fileHashes.add(computedHash);
              computedPlatformHashes.push({ filename: file.filename, fileHash: computedHash });
            } else {
              localSets.perceptualHashes.add(computedHash);
              computedPlatformHashes.push({ filename: file.filename, perceptualHash: computedHash });
            }
          }
          await FileSystem.deleteAsync(localUri, { idempotent: true });
          if (restoreHistory && makeHistoryKey && localRestoreId) restoreHistory.add(makeHistoryKey('ls', localRestoreId));
          await quickYield(); // Yield after file deletion
          skipped++;
          skipReasons.hashMatch = (skipReasons.hashMatch || 0) + 1;
        } else {
          // Retrieve and apply EXIF if available (for cross-platform preservation)
          const fileHash = file.fileHash || computedHash;
          if (fileHash && /\.(jpg|jpeg|png|heic|heif|gif|bmp|webp|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|avif|psd|psb|exr|hdr)$/i.test(file.filename || '')) {
            try {
              const exifRes = await axios.get(`${SERVER_URL}/api/exif/${fileHash}`, {
                headers: config.headers,
                timeout: 10000,
                validateStatus: (status) => status < 500,
              });
              await quickYield(); // Yield after network request
              if (exifRes.status === 200 && exifRes.data?.exif) {
                // Apply EXIF to file using native module
                // ONLY if the file doesn't already have EXIF — writeExif re-encodes
                // the JPEG, destroying original file bytes & SHA256.
                if (ExifExtractor?.writeExif) {
                  const filePath = localUri.replace('file://', '');
                  let hasExif = false;
                  try {
                    if (ExifExtractor.extractExif) {
                      const existing = await ExifExtractor.extractExif(filePath);
                      if (existing?.captureTime || existing?.make) hasExif = true;
                    }
                  } catch (_) {}
                  if (!hasExif) {
                    try {
                      await ExifExtractor.writeExif(filePath, exifRes.data.exif);
                      await quickYield(); // Yield after native module call
                      console.log(`[EXIF] Applied EXIF to ${file.filename}`);
                    } catch (writeErr) {
                      console.log('[EXIF] Write failed (non-critical):', writeErr?.message);
                    }
                  } else {
                    console.log(`[EXIF] File already has EXIF, skipping re-write: ${file.filename}`);
                  }
                } else {
                  console.log(`[EXIF] Retrieved EXIF for ${file.filename} (writeExif not available)`);
                }
              }
            } catch (e) {
              // Non-critical
            }
          }
          
          const isMovFile = /\.mov$/i.test(`${safeBase}${ext}`);
          const isVideoFile = SUPPORTED_VIDEO_RE.test(`${safeBase}${ext}`);
          let saveError = null;
          await runSave(async () => {
            // Rename to original filename before saving (removes hash suffix from cache filename)
            const originalName = `${safeBase}${ext}`;
            const finalUri = `${FileSystem.cacheDirectory}${originalName}`;
            if (finalUri !== localUri) {
              await FileSystem.deleteAsync(finalUri, { idempotent: true });
              await FileSystem.moveAsync({ from: localUri, to: finalUri });
            }
            // iOS: use native methods to preserve original file bytes (MediaLibrary.saveToLibraryAsync re-encodes JPEGs and strips EXIF)
            const isRawFile = /\.(dng|cr2|cr3|nef|arw|orf|rw2|pef|srw|raf)$/i.test(originalName || '');
            const savePath = finalUri.startsWith('file://') ? finalUri.replace('file://', '') : finalUri;
            try {
              if (Platform.OS === 'ios' && isRawFile && ExifExtractor?.saveRawToLibrary) {
                try {
                  await ExifExtractor.saveRawToLibrary(savePath);
                  console.log(`[Sync] Saved RAW to library via native module: ${originalName}`);
                } catch (rawErr) {
                  console.warn(`[Sync] saveRawToLibrary failed, falling back: ${rawErr?.message}`);
                  await MediaLibrary.saveToLibraryAsync(finalUri);
                }
              } else if (Platform.OS === 'ios' && ExifExtractor?.saveFileToLibrary) {
                try {
                  await ExifExtractor.saveFileToLibrary(savePath);
                  console.log(`[Sync] Saved to library via saveFileToLibrary (byte-preserving): ${originalName}`);
                } catch (saveErr) {
                  console.warn(`[Sync] saveFileToLibrary failed, falling back: ${saveErr?.message}`);
                  await MediaLibrary.saveToLibraryAsync(finalUri);
                }
              } else if (Platform.OS === 'android' && isVideoFile && ExifExtractor?.saveVideoToLibrary) {
                // Primary: direct MediaStore insert — bypasses scanner that fails on unsupported codecs
                try {
                  await ExifExtractor.saveVideoToLibrary(savePath);
                  console.log(`[Sync] Saved video to gallery via MediaStore: ${originalName}`);
                } catch (vidErr) {
                  console.warn(`[Sync] saveVideoToLibrary failed, falling back: ${vidErr?.message}`);
                  if (isMovFile && ExifExtractor?.saveQuickTimeToLibrary) {
                    try {
                      await ExifExtractor.saveQuickTimeToLibrary(savePath);
                      console.log(`[Sync] Saved .mov to gallery via legacy path: ${originalName}`);
                    } catch (movErr) {
                      console.warn(`[Sync] saveQuickTimeToLibrary failed, final fallback: ${movErr?.message}`);
                      await MediaLibrary.saveToLibraryAsync(finalUri);
                    }
                  } else {
                    await MediaLibrary.saveToLibraryAsync(finalUri);
                  }
                }
              } else if (Platform.OS === 'android' && isMovFile && ExifExtractor?.saveQuickTimeToLibrary) {
                // Legacy fallback for older builds without saveVideoToLibrary
                try {
                  await ExifExtractor.saveQuickTimeToLibrary(savePath);
                  console.log(`[Sync] Saved .mov to gallery via native module: ${originalName}`);
                } catch (movErr) {
                  console.warn(`[Sync] saveQuickTimeToLibrary failed, falling back: ${movErr?.message}`);
                  await MediaLibrary.saveToLibraryAsync(finalUri);
                }
              } else {
                await MediaLibrary.saveToLibraryAsync(finalUri);
              }

              // After successful save: hash large files that were skipped pre-save
              // Temp file still exists here; finally block deletes it next
              if (!saveError && skipHash && fileSize > MAX_HASH_SIZE) {
                try {
                  const hashPath = finalUri.startsWith('file://') ? finalUri.slice(7) : finalUri;
                  const hash = await computeExactFileHash(hashPath);
                  if (hash) {
                    localSets.fileHashes.add(hash);
                    computedPlatformHashes.push({ filename: file.filename, fileHash: hash });
                    if (bi < 10) console.log(`[Sync] Post-save hash for large file ${file.filename}: ${hash.substring(0,16)}...`);
                    // Persist large-file hash to local cache immediately
                  }
                } catch (hashErr) {
                  console.log(`[Sync] Post-save hash failed for ${file.filename}: ${hashErr?.message}`);
                }
              }
            } catch (saveErr) {
              saveError = saveErr;
              // Video files may fail on some Android devices (unsupported codec, QuickTime, etc.)
              if (isVideoFile) {
                console.warn(`[Sync] Video save failed (gallery may not support codec/format): ${originalName} — ${saveErr?.message}`);
              } else {
                console.warn(`[Sync] saveToLibraryAsync failed: ${saveErr?.message}`);
              }
            } finally {
              // Always clean up temp file after save attempt
              try {
                await FileSystem.deleteAsync(finalUri, { idempotent: true });
              } catch (_) {}
            }
          });
          if (saveError) {
            // Don't count library-save failures as download failures for video files.
            // The file was already downloaded; it just can't be saved to the gallery
            // because the device doesn't support its codec/container format.
            if (isVideoFile) {
              skipped++;
              skipReasons.unsupportedFormat = (skipReasons.unsupportedFormat || 0) + 1;
              await quickYield(); // Yield after skip
              // Don't add to restored — video was skipped, not restored
            } else {
              throw saveError;
            }
          } else {
            await quickYield(); // Yield after save
            restored++;
          }
          
          // Add computed hash to localSets to prevent duplicate downloads in same session
          if (computedHash) {
            if (isVideo) {
              localSets.fileHashes.add(computedHash);
              // Collect for server submission
              computedPlatformHashes.push({ filename: file.filename, fileHash: computedHash });
            } else {
              localSets.perceptualHashes.add(computedHash);
              // Collect for server submission
              computedPlatformHashes.push({ filename: file.filename, perceptualHash: computedHash });
            }
          }
          
          if (restoreHistory && makeHistoryKey && localRestoreId && saveError === null) restoreHistory.add(makeHistoryKey('ls', localRestoreId));

          // Add filename to local set
          const normalized = normalizeFilenameForCompare(file.filename);
          if (normalized) localSets.filenames.add(normalized);
        }
      } else {
        console.warn(`Download failed for ${file.filename}: HTTP ${result.status}`);
        failed++;
      }
    } catch (e) {
      console.warn(`[Sync] Failed to download ${file.filename}:`, e?.message);
      console.error(`[Sync] Download error stack:`, e);
      failed++;
    } finally {
      // Always clean up temp files to prevent cache bloat and crashes
      try {
        await FileSystem.deleteAsync(localUri, { idempotent: true });
      } catch (_) {}
      try {
        const originalName = `${safeBase}${ext}`;
        const finalUri = `${FileSystem.cacheDirectory}${originalName}`;
        if (finalUri !== localUri) {
          await FileSystem.deleteAsync(finalUri, { idempotent: true });
        }
      } catch (_) {}

      processed++;
      console.log(`[Sync] Download task ${bi} completed: ${file.filename} (processed=${processed}/${toDownload.length})`);
      // Progress: 15-100%
      const progress = 0.15 + (processed / toDownload.length) * 0.85;
      updateProgress(onProgress, progress);
      updateStatus(onStatus, t('status.syncDownloadingProgress', { current: processed, total: toDownload.length }));
    }
  }));
    }
    await quickYield();
  }

  console.log(`[Sync] Waiting for ${downloadTasks.length} download tasks...`);
  await Promise.all(downloadTasks);
  console.log(`[Sync] All download tasks completed`);

  if (abortRef?.current) {
    return { restored, skipped, failed, aborted: true };
  }

  if (restoreHistory && saveRestoreHistory) {
    try {
      await saveRestoreHistory(restoreHistory);
    } catch (e) {
      console.warn('[Sync] Failed to save local restore history:', e?.message);
    }
  }

  try {
    await flushHashCache();
  } catch (_) {}

  // Submit computed platform hashes to server for future fast dedup
  if (computedPlatformHashes.length > 0) {
    try {
      const platform = Platform.OS;
      console.log(`[Sync] Submitting ${computedPlatformHashes.length} platform hashes to server (${platform})`);
      await axios.post(`${SERVER_URL}/api/files/platform-hashes`, {
        platform,
        hashes: computedPlatformHashes
      }, config);
    } catch (e) {
      console.warn('[Sync] Failed to submit platform hashes:', e?.message);
      // Non-fatal, continue
    }
  }

  updateProgress(onProgress, 1.0, true);
  updateStatus(onStatus, t('status.syncCompleteStats', { restored, skipped, failed }), true);

  return { restored, skipped, failed, serverTotal: serverFiles.length };
};

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  stealthCloudRestoreCore,
  localRemoteRestoreCore,
};
