/**
 * EXIF Backfill Module (temporary — remove once all users have upgraded)
 *
 * Background task that uploads missing EXIF sidecar metadata for files
 * already backed up to StealthCloud by older app versions (< 1.6.0).
 *
 * Flow:
 * 1. Fetch all StealthCloud manifest metadata (filename, fileHash, size)
 * 2. Batch-check which fileHashes are missing EXIF on server
 * 3. For each missing: match to local photo by filename+size, extract EXIF, upload
 * 4. Persist cursor in AsyncStorage so it resumes from where it left off
 *
 * Design:
 * - Non-disruptive: 2s pause between files, yields to UI, pauses when backgrounded
 * - Resumable: cursor stored per serverUrl so survives app restart/update
 * - Idempotent: server's /api/exif/store is first-write-wins
 * - Self-disabling: marks itself complete when all manifests processed
 */

import { Platform, AppState, NativeModules } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
// AsyncStorage not available in solana-seeker — use FileSystem for cursor persistence
import axios from 'axios';
import { extractFullExif } from './exifExtractor';
import { resolveReadableFilePath } from './backgroundTask';

const TAG = '[ExifBackfill]';
const STORAGE_KEY_PREFIX = 'exif_backfill_cursor_';
const BATCH_SIZE = 50; // check 50 hashes at a time
const INTER_FILE_DELAY_MS = 2000; // 2s between files
const INTER_BATCH_DELAY_MS = 500; // 0.5s between batch checks
const MAX_ERRORS_BEFORE_PAUSE = 5; // pause after 5 consecutive errors
const ERROR_PAUSE_MS = 30000; // 30s pause after error streak

let _running = false;
let _cancelled = false;
let _appState = 'active';
let _busy = false; // true when backup/sync/mint is active — backfill pauses
let _currentServerUrl = null;
let _currentProcessedIds = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const quickYield = () => new Promise(r => (typeof setImmediate !== 'undefined' ? setImmediate(r) : setTimeout(r, 0)));

const waitWhileBusy = async (serverUrl = null, cursor = null) => {
  while ((_appState !== 'active' || _busy) && !_cancelled) {
    if (serverUrl && cursor?.processedManifestIds) {
      await persistCurrentCursor(serverUrl, cursor, null);
    }
    await sleep(2000);
  }
  return !_cancelled;
};

// Listen to app state changes
const appStateListener = AppState.addEventListener('change', (nextState) => {
  _appState = nextState;
});

/**
 * Call when a heavy operation starts (backup, sync, mint, dup cleanup)
 * Backfill will pause its loop until signalIdle() is called.
 */
export const signalBusy = () => { _busy = true; };
export const signalIdle = () => { _busy = false; };

/**
 * Get the storage key for a specific server URL
 */
const getStorageKey = (serverUrl) => {
  const safe = (serverUrl || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64);
  return `${STORAGE_KEY_PREFIX}${safe}`;
};

/**
 * Load cursor state from AsyncStorage
 * Returns: { processedManifestIds: Set, completedAt: string|null }
 */
const _cursorFile = (serverUrl) => `${FileSystem.documentDirectory}${getStorageKey(serverUrl)}.json`;

const loadCursor = async (serverUrl) => {
  try {
    const path = _cursorFile(serverUrl);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return { processedManifestIds: new Set(), completedAt: null };
    const raw = await FileSystem.readAsStringAsync(path);
    if (!raw) return { processedManifestIds: new Set(), completedAt: null };
    const parsed = JSON.parse(raw);
    return {
      processedManifestIds: new Set(parsed.processedManifestIds || []),
      completedAt: parsed.completedAt || null,
    };
  } catch (e) {
    console.warn(TAG, 'loadCursor error:', e?.message);
    return { processedManifestIds: new Set(), completedAt: null };
  }
};

/**
 * Save cursor state to AsyncStorage
 */
const saveCursor = async (serverUrl, processedManifestIds, completedAt = null) => {
  try {
    const data = {
      processedManifestIds: [...processedManifestIds].slice(-5000), // cap at 5000 to limit storage
      completedAt,
      updatedAt: new Date().toISOString(),
    };
    await FileSystem.writeAsStringAsync(_cursorFile(serverUrl), JSON.stringify(data));
  } catch (e) {
    console.warn(TAG, 'saveCursor error:', e?.message);
  }
};

const persistCurrentCursor = async (serverUrl, cursor, completedAt = cursor?.completedAt || null) => {
  if (!serverUrl || !cursor?.processedManifestIds) return;
  await saveCursor(serverUrl, cursor.processedManifestIds, completedAt);
  cursor.completedAt = completedAt;
};

const markManifestDone = (cursor, manifestId) => {
  if (!cursor?.processedManifestIds || !manifestId) return;
  cursor.processedManifestIds.add(manifestId);
};

/**
 * Build a lookup map: normalizedFilename+size → asset
 * from the local media library (lightweight — no getAssetInfoAsync)
 */
const buildLocalAssetLookup = async ({ serverUrl = null, cursor = null } = {}) => {
  // Check media library permission first — backfill cannot work without it
  const { status } = await MediaLibrary.getPermissionsAsync();
  if (status !== 'granted') {
    console.log(TAG, 'MEDIA_LIBRARY permission not granted, skipping backfill');
    return null;
  }

  const lookup = new Map(); // key: "filename_lower|size" → asset
  const PAGE = 500;
  let after = undefined;
  let total = 0;

  while (true) {
    if (!(await waitWhileBusy(serverUrl, cursor))) return null;
    await quickYield();
    const page = await MediaLibrary.getAssetsAsync({
      first: PAGE,
      after,
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });

    for (const asset of page.assets) {
      const fn = (asset.filename || '').toLowerCase();
      const size = asset.fileSize ? Number(asset.fileSize) : 0;
      if (fn && size > 0) {
        const key = `${fn}|${size}`;
        if (!lookup.has(key)) lookup.set(key, asset);
      }
    }

    total += page.assets.length;
    if (!page.hasNextPage || !page.endCursor) break;
    after = page.endCursor;

    // Yield every 2000 assets
    if (total % 2000 === 0) {
      await quickYield();
      console.log(TAG, `Scanning local library: ${total} assets...`);
    }
  }

  console.log(TAG, `Local lookup built: ${lookup.size} unique filename+size entries from ${total} assets`);
  return lookup;
};

/**
 * Main backfill runner. Call once when app connects to StealthCloud.
 * Safe to call multiple times — only one instance runs.
 *
 * @param {string} serverUrl - StealthCloud server URL
 * @param {Object} config - axios config with auth headers
 */
export const runExifBackfill = async (serverUrl, config) => {
  if (_running) {
    console.log(TAG, 'Already running, skipping');
    return;
  }
  _running = true;
  _cancelled = false;

  try {
    // Check if already completed
    const cursor = await loadCursor(serverUrl);
    if (cursor.completedAt) {
      console.log(TAG, `Previous run completed at ${cursor.completedAt}; checking for newly syncable manifests...`);
    }

    console.log(TAG, `Starting backfill. Previously processed: ${cursor.processedManifestIds.size}`);
    _currentServerUrl = serverUrl;
    _currentProcessedIds = cursor.processedManifestIds;

    if (!(await waitWhileBusy(serverUrl, cursor))) {
      _running = false;
      return;
    }

    // 1. Fetch all manifest metadata from StealthCloud
    console.log(TAG, 'Fetching manifest list...');
    const PAGE_LIMIT = 500;
    const allManifests = [];
    let offset = 0;
    while (!_cancelled) {
      if (!(await waitWhileBusy(serverUrl, cursor))) { _running = false; return; }
      const resp = await axios.get(`${serverUrl}/api/cloud/manifests`, {
        ...config,
        params: { offset, limit: PAGE_LIMIT, meta: true },
        timeout: 30000,
      });
      const batch = resp.data?.manifests || [];
      allManifests.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
      offset += batch.length;
      await quickYield();
    }
    if (_cancelled) { _running = false; return; }

    console.log(TAG, `Total manifests: ${allManifests.length}`);

    // 2. Filter to image manifests with fileHash that haven't been processed yet
    const imageExts = /\.(jpg|jpeg|png|heic|heif|gif|bmp|webp|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|avif|psd|psb|exr|hdr)$/i;
    const candidates = allManifests.filter(m => {
      if (!m.fileHash) return false; // no fileHash in meta → can't check EXIF (very old manifest)
      if (!m.filename || !imageExts.test(m.filename)) return false; // not an image
      if (cursor.processedManifestIds.has(m.manifestId)) return false; // already processed
      return true;
    });

    console.log(TAG, `Candidates to check: ${candidates.length} (skipped ${allManifests.length - candidates.length} already processed/non-image/no-hash)`);

    if (candidates.length === 0) {
      await persistCurrentCursor(serverUrl, cursor, new Date().toISOString());
      console.log(TAG, 'Nothing to backfill — marking complete');
      _running = false;
      return;
    }

    if (cursor.completedAt) {
      cursor.completedAt = null;
      await persistCurrentCursor(serverUrl, cursor, null);
    }

    // 3. Batch-check which fileHashes are missing or have short/incomplete EXIF on server
    console.log(TAG, 'Checking which files are missing or have short EXIF...');
    const missingSet = new Set();
    const shortSet = new Set(); // hashes where EXIF exists but is incomplete — will send upgrade=true
    for (let i = 0; i < candidates.length && !_cancelled; i += BATCH_SIZE) {
      if (!(await waitWhileBusy(serverUrl, cursor))) { _running = false; return; }
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const hashes = batch.map(m => m.fileHash);
      try {
        const resp = await axios.post(`${serverUrl}/api/exif/check-missing`, { fileHashes: hashes, checkShort: true }, {
          headers: config.headers,
          timeout: 15000,
        });
        for (const h of (resp.data?.missing || [])) missingSet.add(h);
        for (const h of (resp.data?.short || [])) { missingSet.add(h); shortSet.add(h); }
      } catch (e) {
        console.warn(TAG, 'check-missing batch error:', e?.message);
        // On error, assume all in batch are missing (will be checked individually)
        for (const h of hashes) missingSet.add(h);
      }
      await sleep(INTER_BATCH_DELAY_MS);
    }
    if (_cancelled) { _running = false; return; }

    // Filter candidates to only those with missing or short EXIF
    const toBackfill = candidates.filter(m => missingSet.has(m.fileHash));
    console.log(TAG, `Missing EXIF: ${toBackfill.length} of ${candidates.length} checked (${shortSet.size} short/upgradeable)`);

    if (toBackfill.length === 0) {
      // Mark all candidates as processed
      for (const m of candidates) markManifestDone(cursor, m.manifestId);
      await persistCurrentCursor(serverUrl, cursor, new Date().toISOString());
      console.log(TAG, 'All EXIF present — marking complete');
      _running = false;
      return;
    }

    // 4. Build local asset lookup (lightweight scan)
    console.log(TAG, 'Building local asset lookup...');
    const localLookup = await buildLocalAssetLookup({ serverUrl, cursor });
    if (!localLookup) { _running = false; return; }
    if (_cancelled) { _running = false; return; }

    // 5. Process each missing file
    let processed = 0;
    let stored = 0;
    let notFound = 0;
    let errors = 0;
    let consecutiveErrors = 0;

    for (const manifest of toBackfill) {
      if (_cancelled) break;

      // Pause while app is backgrounded or a heavy operation is active
      await waitWhileBusy(serverUrl, cursor);
      if (_cancelled) break;

      processed++;
      const { manifestId, filename, fileHash, originalSize } = manifest;

      try {
        // Match to local asset by filename + size
        const fn = (filename || '').toLowerCase();
        const size = originalSize ? Number(originalSize) : 0;
        const key = size > 0 ? `${fn}|${size}` : null;
        const localAsset = key ? localLookup.get(key) : null;

        if (!localAsset) {
          notFound++;
          markManifestDone(cursor, manifestId);
          if (processed % 20 === 0) {
            await persistCurrentCursor(serverUrl, cursor, null);
          }
          if (processed % 50 === 0) {
            console.log(TAG, `Progress: ${processed}/${toBackfill.length}, stored=${stored}, notFound=${notFound}`);
          }
          continue;
        }

        // Get full asset info (needed for EXIF extraction)
        await quickYield();
        let assetInfo;
        try {
          assetInfo = await MediaLibrary.getAssetInfoAsync(localAsset.id);
        } catch (e) {
          console.warn(TAG, `getAssetInfoAsync failed for ${filename}:`, e?.message);
          notFound++;
          markManifestDone(cursor, manifestId);
          if (processed % 20 === 0) {
            await persistCurrentCursor(serverUrl, cursor, null);
          }
          continue;
        }

        // Extract EXIF
        let fullExif = null;
        if (Platform.OS === 'ios') {
          fullExif = extractFullExif(assetInfo, localAsset);
        } else {
          // Android: try native ExifExtractor first
          try {
            const { ExifExtractor } = NativeModules;
            if (ExifExtractor?.extractExif) {
              const resolved = await resolveReadableFilePath({ assetId: localAsset.id, assetInfo });
              if (resolved?.filePath) {
                fullExif = await ExifExtractor.extractExif(resolved.filePath);
                // Clean up temp file if copied
                if (resolved.tmpCopied && resolved.tmpUri) {
                  try { await FileSystem.deleteAsync(resolved.tmpUri, { idempotent: true }); } catch (_) {}
                }
              }
            }
          } catch (_) {}
          // Fallback to JS extraction
          if (!fullExif || (!fullExif.captureTime && !fullExif.make)) {
            fullExif = extractFullExif(assetInfo, localAsset);
          }
        }

        if (!fullExif || (!fullExif.captureTime && !fullExif.make && fullExif.gpsLatitude == null)) {
          // No meaningful EXIF to store
          markManifestDone(cursor, manifestId);
          if (processed % 20 === 0) {
            await persistCurrentCursor(serverUrl, cursor, null);
          }
          continue;
        }

        // Upload EXIF sidecar to server (upgrade=true for short/incomplete existing EXIF)
        await axios.post(`${serverUrl}/api/exif/store`, {
          fileHash,
          exif: fullExif,
          platform: Platform.OS,
          upgrade: shortSet.has(fileHash),
        }, {
          headers: config.headers,
          timeout: 10000,
        });

        stored++;
        consecutiveErrors = 0;
        markManifestDone(cursor, manifestId);

        if (stored % 10 === 0 || processed % 50 === 0) {
          console.log(TAG, `Progress: ${processed}/${toBackfill.length}, stored=${stored}, notFound=${notFound}, errors=${errors}`);
        }

        // Save cursor every 20 stored
        if (stored % 20 === 0) {
          await persistCurrentCursor(serverUrl, cursor, null);
        }

      } catch (e) {
        errors++;
        consecutiveErrors++;
        console.warn(TAG, `Error processing ${filename}:`, e?.message);
        if (processed % 10 === 0) {
          await persistCurrentCursor(serverUrl, cursor, null);
        }

        if (consecutiveErrors >= MAX_ERRORS_BEFORE_PAUSE) {
          await persistCurrentCursor(serverUrl, cursor, null);
          console.log(TAG, `${consecutiveErrors} consecutive errors, pausing ${ERROR_PAUSE_MS / 1000}s...`);
          await sleep(ERROR_PAUSE_MS);
          consecutiveErrors = 0;
        }
      }

      // Throttle
      await sleep(INTER_FILE_DELAY_MS);
    }

    // Save final cursor
    const isComplete = processed >= toBackfill.length && !_cancelled;
    await persistCurrentCursor(serverUrl, cursor, isComplete ? new Date().toISOString() : null);

    console.log(TAG, `Done. processed=${processed}, stored=${stored}, notFound=${notFound}, errors=${errors}, complete=${isComplete}`);

  } catch (e) {
    console.error(TAG, 'Fatal error:', e?.message);
  } finally {
    _running = false;
  }
};

/**
 * Cancel a running backfill (e.g., when user disconnects from StealthCloud)
 */
export const cancelExifBackfill = async () => {
  if (_running) {
    console.log(TAG, 'Cancelling...');
    _cancelled = true;
    // Persist cursor so progress isn't lost
    if (_currentServerUrl && _currentProcessedIds) {
      try { await saveCursor(_currentServerUrl, _currentProcessedIds, null); } catch (_) {}
    }
  }
};

/**
 * Reset backfill state for a server (forces re-run from scratch)
 */
export const resetExifBackfill = async (serverUrl) => {
  await FileSystem.deleteAsync(_cursorFile(serverUrl), { idempotent: true });
  console.log(TAG, 'Reset cursor for', serverUrl);
};

/**
 * Check if backfill has already completed for a server
 */
export const isExifBackfillComplete = async (serverUrl) => {
  const cursor = await loadCursor(serverUrl);
  return !!cursor.completedAt;
};

/**
 * Clean up listener on module unload
 */
export const cleanupExifBackfill = () => {
  try { appStateListener?.remove(); } catch (_) {}
};
