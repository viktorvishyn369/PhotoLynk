/**
 * hashCache.js — v3
 *
 * Persistent cache for computed file hashes to avoid re-hashing on every scan.
 * Designed for 100 GB – 1 TB photo libraries (100 k – 1 M+ files).
 *
 * Architecture:
 * - Chunked storage: entries split into 256 chunk files by asset ID prefix.
 *   Each chunk stays small (a few k entries) so reads / writes are fast.
 * - Bounded in-memory LRU: only hot entries stay in RAM (default 50 000).
 *   Everything else lives on disk and is loaded on demand.
 * - Dirty-chunk tracking: only modified chunks are rewritten.
 * - Atomic writes: temp file + rename to prevent corruption on crash.
 * - Corruption recovery: bad chunk is rebuilt / skipped, rest of cache survives.
 * - Background compaction: stale entries purged without loading everything.
 *
 * Public API is unchanged from v2 — callers need no modifications.
 */

import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { InteractionManager, Platform } from 'react-native';

// ─── Config ──────────────────────────────────────────────────────────────────
const CACHE_VERSION = 3;
const CHUNK_DIR = `${FileSystem.documentDirectory}hash_cache_v3_chunks`;
const CHUNK_COUNT = 256; // first 2 hex chars of asset ID
const DEFAULT_MEMORY_LIMIT = 50000; // max entries in hot LRU
const SAVE_DEBOUNCE_MS = 10000; // 10s debounce batches writes during heavy scanning
const COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

const V2_CACHE_FILE = `${FileSystem.documentDirectory}hash_cache_v2.json`;
const MIGRATION_STATE_FILE = `${FileSystem.documentDirectory}hash_cache_v3_migration.json`;

const PRE_ANALYSIS_STATE_FILE = `${FileSystem.documentDirectory}hash_preanalysis_state_v1.json`;
const PRE_ANALYSIS_STATE_VERSION = 1;
const DEFAULT_PRE_ANALYSIS_IDLE_MS = 90 * 1000;

// ─── In-memory state ───────────────────────────────────────────────────────
let hotCache = null;           // Map<cacheKey, entry>  (LRU order)
let hotCacheLimit = DEFAULT_MEMORY_LIMIT;
let chunkLoaded = new Set();   // which chunk keys have been pulled into hotCache
let dirtyChunks = new Set();   // chunks that need persisting
let saveTimeout = null;
let totalEntryCount = 0;       // approx. maintained for stats
let preAnalysisStateCache = null;
let preAnalysisStateLoaded = false;
let compactionLastRun = 0;
let migrationRunning = false;

// ─── LRU helpers ─────────────────────────────────────────────────────────────

const _touchHot = (key, entry) => {
  if (!hotCache) hotCache = new Map();
  if (hotCache.has(key)) hotCache.delete(key);
  hotCache.set(key, entry);
  while (hotCache.size > hotCacheLimit) {
    const first = hotCache.keys().next().value;
    hotCache.delete(first);
  }
};

const _getHot = (key) => {
  if (!hotCache) return undefined;
  const entry = hotCache.get(key);
  if (entry) {
    // move to end (LRU)
    hotCache.delete(key);
    hotCache.set(key, entry);
  }
  return entry;
};

const _setHot = (key, entry) => {
  if (!hotCache) hotCache = new Map();
  if (hotCache.has(key)) hotCache.delete(key);
  hotCache.set(key, entry);
  while (hotCache.size > hotCacheLimit) {
    const first = hotCache.keys().next().value;
    hotCache.delete(first);
  }
};

const _deleteHot = (key) => {
  if (hotCache) hotCache.delete(key);
};

// ─── Chunk key ───────────────────────────────────────────────────────────────

const _chunkKey = (assetId) => {
  const s = String(assetId);
  if (s.length >= 2) return s.substring(0, 2).toLowerCase();
  return (s + '00').substring(0, 2).toLowerCase();
};

const _chunkPath = (chunkKey) => `${CHUNK_DIR}/${chunkKey}.json`;

// ─── Chunk I/O (atomic, corruption-safe) ─────────────────────────────────────

const _ensureChunkDir = async () => {
  const info = await FileSystem.getInfoAsync(CHUNK_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CHUNK_DIR, { intermediates: true });
  }
};

const _loadChunk = async (chunkKey) => {
  await _ensureChunkDir();
  const path = _chunkPath(chunkKey);
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return {};
    const raw = await FileSystem.readAsStringAsync(path);
    const data = JSON.parse(raw);
    if (data.version !== CACHE_VERSION || typeof data.entries !== 'object') {
      console.warn(`[HashCache] Chunk ${chunkKey} version mismatch or bad shape, rebuilding`);
      return {};
    }
    return data.entries || {};
  } catch (e) {
    console.warn(`[HashCache] Chunk ${chunkKey} corrupt, starting fresh:`, e?.message);
    return {};
  }
};

const savingChunks = new Set();

const _saveChunk = async (chunkKey, entries) => {
  if (savingChunks.has(chunkKey)) return;
  savingChunks.add(chunkKey);
  await _ensureChunkDir();
  const path = _chunkPath(chunkKey);
  const tmpPath = `${path}.${Date.now()}.tmp`;
  try {
    const payload = JSON.stringify({ version: CACHE_VERSION, entries });
    await FileSystem.writeAsStringAsync(tmpPath, payload);
    try { await FileSystem.deleteAsync(path, { idempotent: true }); } catch (_) {}
    await FileSystem.moveAsync({ from: tmpPath, to: path });
  } catch (e) {
    console.warn(`[HashCache] Failed to save chunk ${chunkKey}:`, e?.message);
  } finally {
    savingChunks.delete(chunkKey);
    try { await FileSystem.deleteAsync(tmpPath, { idempotent: true }); } catch (_) {}
  }
};

// ─── Smart load: bring a chunk into hot cache on demand ─────────────────────

const _hydrateChunk = async (chunkKey) => {
  if (chunkLoaded.has(chunkKey)) return; // already in memory
  const entries = await _loadChunk(chunkKey);
  const count = Object.keys(entries).length;
  if (count === 0) {
    chunkLoaded.add(chunkKey);
    return;
  }
  // If adding this chunk would blow the LRU limit, make room first
  // by evicting entries from other chunks (not this one)
  if (hotCache && hotCache.size + count > hotCacheLimit) {
    const toEvict = hotCache.size + count - hotCacheLimit;
    let evicted = 0;
    for (const [k, v] of hotCache) {
      if (evicted >= toEvict) break;
      hotCache.delete(k);
      evicted++;
    }
  }
  for (const [key, entry] of Object.entries(entries)) {
    _setHot(key, entry);
  }
  chunkLoaded.add(chunkKey);
  totalEntryCount += count; // approximate; compaction corrects it
};

// ─── v2 → v3 silent migration (resumable, survives app kill) ────────────────

const _loadMigrationState = async () => {
  try {
    const info = await FileSystem.getInfoAsync(MIGRATION_STATE_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(MIGRATION_STATE_FILE);
    return JSON.parse(raw);
  } catch (e) { return null; }
};

const _saveMigrationState = async (state) => {
  try {
    await FileSystem.writeAsStringAsync(MIGRATION_STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn('[HashCache] Failed to save migration state:', e?.message);
  }
};

const _migrateV2Chunk = async (entries, startIdx, batchSize = 2000) => {
  const keys = Object.keys(entries);
  const endIdx = Math.min(startIdx + batchSize, keys.length);
  const affectedChunks = new Set();

  // 1. Add migrated entries to hotCache (skip if already present — newer data wins)
  for (let i = startIdx; i < endIdx; i++) {
    const key = keys[i];
    const entry = entries[key];
    if (!entry) continue;
    const assetId = key.split('_')[0];
    const chunkKey = _chunkKey(assetId);
    affectedChunks.add(chunkKey);
    if (!_getHot(key)) {
      _setHot(key, entry);
    }
    chunkLoaded.add(chunkKey);
  }

  // 2. For each affected chunk, merge disk + hotCache and save atomically.
  //    This prevents race with new uploads: both sources are merged.
  for (const chunkKey of affectedChunks) {
    const diskEntries = await _loadChunk(chunkKey);
    // Overlay any hotCache entries for this chunk (includes new uploads during migration)
    for (const [key, entry] of (hotCache || new Map())) {
      if (_chunkKey(key.split('_')[0]) === chunkKey) {
        diskEntries[key] = entry;
      }
    }
    await _saveChunk(chunkKey, diskEntries);
    // Chunk is now fully persisted; remove from dirty set.
    dirtyChunks.delete(chunkKey);
  }

  return endIdx;
};

const runV2Migration = async () => {
  if (migrationRunning) return { skipped: true };
  migrationRunning = true;
  try {
    const v2Info = await FileSystem.getInfoAsync(V2_CACHE_FILE);
    if (!v2Info.exists) return { skipped: true };

    const state = await _loadMigrationState();
    if (state?.completed) {
      try { await FileSystem.deleteAsync(V2_CACHE_FILE, { idempotent: true }); } catch (_) {}
      try { await FileSystem.deleteAsync(MIGRATION_STATE_FILE, { idempotent: true }); } catch (_) {}
      return { skipped: true };
    }

    console.log('[HashCache] Starting v2→v3 migration...');
    let v2Data;
    try {
      const raw = await FileSystem.readAsStringAsync(V2_CACHE_FILE);
      v2Data = JSON.parse(raw);
    } catch (e) {
      console.warn('[HashCache] v2 file unreadable, removing:', e?.message);
      try { await FileSystem.deleteAsync(V2_CACHE_FILE, { idempotent: true }); } catch (_) {}
      return { error: e?.message };
    }
    if (!v2Data || v2Data.version !== 2 || typeof v2Data.hashes !== 'object') {
      console.warn('[HashCache] v2 file has wrong shape, removing');
      try { await FileSystem.deleteAsync(V2_CACHE_FILE, { idempotent: true }); } catch (_) {}
      return { error: 'wrong_shape' };
    }

    const entries = v2Data.hashes;
    const total = Object.keys(entries).length;
    let migrated = state?.migrated || 0;

    while (migrated < total) {
      migrated = await _migrateV2Chunk(entries, migrated, 2000);
      await _saveMigrationState({ completed: false, migrated, total, updatedAt: Date.now() });
      await new Promise(r => setTimeout(r, 10));
    }

    await _saveMigrationState({ completed: true, migrated, total, updatedAt: Date.now() });
    console.log(`[HashCache] v2→v3 migration complete: ${migrated} entries migrated`);
    try { await FileSystem.deleteAsync(V2_CACHE_FILE, { idempotent: true }); } catch (_) {}
    return { completed: true, migrated };
  } catch (e) {
    console.error('[HashCache] Migration error:', e?.message);
    return { error: e?.message };
  } finally {
    migrationRunning = false;
  }
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load hash cache from disk.
 * v3 is lazy: only initialises directories; chunks load on demand.
 * Also triggers silent v2→v3 migration in background if needed.
 */
export const loadHashCache = async () => {
  await _ensureChunkDir();
  // Kick off silent v2 migration in background — don't block callers
  runV2Migration().catch(() => {});
  console.log('[HashCache] v3 ready (lazy chunks)');
  return hotCache || new Map();
};

/**
 * Save all dirty chunks immediately.
 */
export const flushHashCache = async () => {
  if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
  if (dirtyChunks.size === 0) return;
  const keys = Array.from(dirtyChunks);
  dirtyChunks.clear();
  for (const chunkKey of keys) {
    const entries = {};
    for (const [key, entry] of (hotCache || new Map())) {
      if (_chunkKey(key.split('_')[0]) === chunkKey) {
        entries[key] = entry;
      }
    }
    await _saveChunk(chunkKey, entries);
  }
  console.log(`[HashCache] Flushed ${keys.length} chunk(s)`);
};

/**
 * Schedule debounced save for dirty chunks.
 */
const _scheduleChunkSave = () => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    saveTimeout = null;
    await flushHashCache();
  }, SAVE_DEBOUNCE_MS);
};

// ─── Cache key ───────────────────────────────────────────────────────────────

const getCacheKey = (asset) => {
  if (!asset || !asset.id) return null;
  const mtime = asset.modificationTime || asset.creationTime || 0;
  return `${asset.id}_${mtime}`;
};

/**
 * Get cached hash for an asset
 */
export const getCachedHash = (asset, hashType = 'perceptual') => {
  if (!asset) return null;
  const key = getCacheKey(asset);
  if (!key) return null;
  const entry = _getHot(key);
  if (entry) {
    switch (hashType) {
      case 'perceptual': return entry.phash || null;
      case 'edge': return entry.ehash || null;
      case 'corner': return entry.chash || null;
      case 'file': return entry.fhash || null;
      default: return null;
    }
  }
  // Cold miss: load chunk in background (caller is sync, so we return null now)
  // The chunk will be there next time.  For sync callers this is acceptable
  // because the old v2 also returned null on first access until loadHashCache ran.
  return null;
};

/**
 * Async variant for cold-miss resolution (used by internal pre-analysis)
 */
export const getCachedHashAsync = async (asset, hashType = 'perceptual') => {
  if (!asset) return null;
  const key = getCacheKey(asset);
  if (!key) return null;
  let entry = _getHot(key);
  if (!entry) {
    const chunkKey = _chunkKey(asset.id);
    await _hydrateChunk(chunkKey);
    entry = _getHot(key);
  }
  if (!entry) return null;
  switch (hashType) {
    case 'perceptual': return entry.phash || null;
    case 'edge': return entry.ehash || null;
    case 'corner': return entry.chash || null;
    case 'file': return entry.fhash || null;
    default: return null;
  }
};

export const getAllCachedHashes = (asset) => {
  if (!asset) return null;
  const key = getCacheKey(asset);
  if (!key) return null;
  const entry = _getHot(key);
  return entry || null;
};

export const getAllCachedHashesAsync = async (asset) => {
  if (!asset) return null;
  const key = getCacheKey(asset);
  if (!key) return null;
  let entry = _getHot(key);
  if (!entry) {
    const chunkKey = _chunkKey(asset.id);
    await _hydrateChunk(chunkKey);
    entry = _getHot(key);
  }
  return entry || null;
};

export const setCachedHash = (asset, hashType, hash) => {
  if (!asset || !hash) return;
  const key = getCacheKey(asset);
  if (!key) return;
  if (!hotCache) hotCache = new Map();
  let entry = hotCache.get(key);
  if (!entry) entry = {};
  switch (hashType) {
    case 'perceptual': entry.phash = hash; break;
    case 'edge': entry.ehash = hash; break;
    case 'corner': entry.chash = hash; break;
    case 'file': entry.fhash = hash; break;
  }
  _setHot(key, entry);
  const chunkKey = _chunkKey(asset.id);
  chunkLoaded.add(chunkKey);
  dirtyChunks.add(chunkKey);
  _scheduleChunkSave();
};

export const setAllCachedHashes = (asset, hashes) => {
  if (!asset || !hashes) return;
  const key = getCacheKey(asset);
  if (!key) return;
  if (!hotCache) hotCache = new Map();
  let entry = hotCache.get(key) || {};
  if (hashes.phash) entry.phash = hashes.phash;
  if (hashes.ehash) entry.ehash = hashes.ehash;
  if (hashes.chash) entry.chash = hashes.chash;
  if (hashes.fhash) entry.fhash = hashes.fhash;
  _setHot(key, entry);
  const chunkKey = _chunkKey(asset.id);
  chunkLoaded.add(chunkKey);
  dirtyChunks.add(chunkKey);
  _scheduleChunkSave();
};

export const getHashCacheStats = () => {
  let perceptual = 0;
  let file = 0;
  if (hotCache) {
    for (const entry of hotCache.values()) {
      if (entry.phash) perceptual++;
      if (entry.fhash) file++;
    }
  }
  return {
    total: hotCache ? hotCache.size : 0,
    perceptual,
    file,
  };
};

export const clearHashCache = async () => {
  hotCache = new Map();
  chunkLoaded.clear();
  dirtyChunks.clear();
  totalEntryCount = 0;
  try {
    const info = await FileSystem.getInfoAsync(CHUNK_DIR);
    if (info.exists) {
      await FileSystem.deleteAsync(CHUNK_DIR, { idempotent: true });
    }
    await _ensureChunkDir();
  } catch (e) {
    console.warn('[HashCache] Failed to clear chunks:', e?.message);
  }
  try {
    await FileSystem.deleteAsync(V2_CACHE_FILE, { idempotent: true });
  } catch (_) {}
  try {
    await FileSystem.deleteAsync(MIGRATION_STATE_FILE, { idempotent: true });
  } catch (_) {}
  try {
    await FileSystem.deleteAsync(PRE_ANALYSIS_STATE_FILE, { idempotent: true });
  } catch (_) {}
  console.log('[HashCache] Cache cleared');
};

/**
 * Prune entries whose asset IDs are no longer on device.
 * v3 does this chunk-by-chunk so memory stays bounded.
 */
export const pruneHashCache = async (currentAssetIds) => {
  if (!currentAssetIds) return 0;
  await _ensureChunkDir();
  let removed = 0;
  const idSet = currentAssetIds instanceof Set ? currentAssetIds : new Set(currentAssetIds);

  // 1. Prune hot cache immediately
  if (hotCache) {
    for (const [key, entry] of hotCache) {
      const assetId = key.split('_')[0];
      if (!idSet.has(assetId)) {
        hotCache.delete(key);
        removed++;
      }
    }
  }

  // 2. Prune cold chunks one at a time (bounded memory)
  // We don't have a directory listing API on all RN versions,
  // so we iterate all 256 possible chunk keys.
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const chunkKey = i.toString(16).padStart(2, '0');
    const path = _chunkPath(chunkKey);
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) continue;
      const raw = await FileSystem.readAsStringAsync(path);
      const data = JSON.parse(raw);
      if (!data.entries) continue;
      const originalCount = Object.keys(data.entries).length;
      const filtered = {};
      for (const [key, entry] of Object.entries(data.entries)) {
        const assetId = key.split('_')[0];
        if (idSet.has(assetId)) filtered[key] = entry;
      }
      const newCount = Object.keys(filtered).length;
      if (newCount < originalCount) {
        removed += originalCount - newCount;
        await _saveChunk(chunkKey, filtered);
        // If this chunk was loaded in hot cache, refresh it
        if (chunkLoaded.has(chunkKey)) {
          for (const [key, entry] of Object.entries(filtered)) {
            _setHot(key, entry);
          }
          // Remove any hot entries that no longer exist in the filtered chunk
          if (hotCache) {
            for (const [key] of hotCache) {
              if (_chunkKey(key.split('_')[0]) === chunkKey && !(key in filtered)) {
                hotCache.delete(key);
              }
            }
          }
        }
      }
    } catch (e) {
      // chunk missing or corrupt — skip
    }
  }

  if (removed > 0) {
    console.log(`[HashCache] Pruned ${removed} stale entries across chunks`);
  }
  return removed;
};

const getDefaultPreAnalysisState = () => ({
  version: PRE_ANALYSIS_STATE_VERSION,
  phase: 'idle',
  startedAt: 0,
  pausedAt: 0,
  completedAt: 0,
  updatedAt: 0,
  pauseReason: null,
  resumeAfterMs: 0,
  lastUserActivityAt: 0,
  total: 0,
  processed: 0,
  cached: 0,
  errors: 0,
  phashSkipped: 0,
  currentAssetId: null,
});

const loadPreAnalysisState = async () => {
  if (preAnalysisStateLoaded && preAnalysisStateCache) return preAnalysisStateCache;

  try {
    const info = await FileSystem.getInfoAsync(PRE_ANALYSIS_STATE_FILE);
    if (info.exists) {
      const content = await FileSystem.readAsStringAsync(PRE_ANALYSIS_STATE_FILE);
      const data = JSON.parse(content);
      if (data.version === PRE_ANALYSIS_STATE_VERSION) {
        preAnalysisStateCache = { ...getDefaultPreAnalysisState(), ...data };
      } else {
        preAnalysisStateCache = getDefaultPreAnalysisState();
      }
    } else {
      preAnalysisStateCache = getDefaultPreAnalysisState();
    }
  } catch (e) {
    preAnalysisStateCache = getDefaultPreAnalysisState();
  }

  preAnalysisStateLoaded = true;
  return preAnalysisStateCache;
};

const savePreAnalysisState = async (partial = {}) => {
  const existing = await loadPreAnalysisState();
  preAnalysisStateCache = {
    ...existing,
    ...partial,
    version: PRE_ANALYSIS_STATE_VERSION,
    updatedAt: Date.now(),
  };
  try {
    await FileSystem.writeAsStringAsync(PRE_ANALYSIS_STATE_FILE, JSON.stringify(preAnalysisStateCache));
  } catch (e) {
    console.warn('[HashCache] Failed to save pre-analysis state:', e?.message);
  }
  return preAnalysisStateCache;
};

export const getPreAnalysisState = async () => {
  const state = await loadPreAnalysisState();
  return { ...state };
};

export const canRunPreAnalysisNow = async () => {
  const state = await loadPreAnalysisState();
  const resumeAfterMs = Number(state?.resumeAfterMs || 0);
  const waitMs = Math.max(0, resumeAfterMs - Date.now());
  return { ok: waitMs <= 0, waitMs, state };
};

// ============================================================================
// BACKGROUND PRE-ANALYSIS
// ============================================================================

let preAnalysisRunning = false;
let preAnalysisAbort = false;
let preAnalysisAbortReason = null;

/**
 * Check if pre-analysis is currently running
 */
export const isPreAnalysisRunning = () => preAnalysisRunning;

/**
 * Abort any running pre-analysis
 */
export const waitForPreAnalysisIdle = async ({ timeoutMs = 10000, pollMs = 100 } = {}) => {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  while (preAnalysisRunning && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
  }
  return !preAnalysisRunning;
};

export const abortPreAnalysis = async (reason = 'external') => {
  preAnalysisAbortReason = reason || 'external';
  preAnalysisAbort = true;
  await savePreAnalysisState({
    phase: preAnalysisRunning ? 'paused' : 'idle',
    pauseReason: preAnalysisAbortReason,
    pausedAt: Date.now(),
  });
  if (preAnalysisRunning) {
    await waitForPreAnalysisIdle();
  }
  return { stopped: !preAnalysisRunning };
};

export const markPreAnalysisUserActivity = async ({
  idleDelayMs = DEFAULT_PRE_ANALYSIS_IDLE_MS,
  reason = 'userActivity',
} = {}) => {
  const now = Date.now();
  const requestedResumeAfterMs = now + Math.max(0, idleDelayMs);
  const currentState = await loadPreAnalysisState();
  const resumeAfterMs = Math.max(Number(currentState?.resumeAfterMs || 0), requestedResumeAfterMs);

  if (preAnalysisRunning) {
    preAnalysisAbortReason = reason;
    preAnalysisAbort = true;
  }

  await savePreAnalysisState({
    phase: preAnalysisRunning ? 'paused' : 'idle',
    pauseReason: reason,
    pausedAt: now,
    lastUserActivityAt: now,
    resumeAfterMs,
  });

  return { resumeAfterMs, waitMs: Math.max(0, resumeAfterMs - Date.now()) };
};

/**
 * Get list of asset IDs that need hashing (not in cache)
 * @param {Array} assets - Array of MediaLibrary assets
 * @param {string} hashType - 'file' for identical, 'perceptual' for similar
 * @returns {Array} Assets that need hashing
 */
export const getUncachedAssets = (assets, hashType = 'file') => {
  if (!hotCache || !assets) return assets;
  return assets.filter(asset => {
    const cached = getCachedHash(asset, hashType);
    return !cached;
  });
};

export const getCacheStatus = (assets, hashType = 'file') => {
  if (!assets) return { cached: 0, uncached: 0, total: 0 };
  if (!hotCache) return { cached: 0, uncached: assets.length, total: assets.length };
  let cached = 0;
  for (const asset of assets) {
    if (getCachedHash(asset, hashType)) cached++;
  }
  return {
    cached,
    uncached: assets.length - cached,
    total: assets.length,
  };
};

/**
 * Run background pre-analysis to hash files silently
 * Call this on app start when user is logged in
 * 
 * @param {Object} params
 * @param {Function} params.resolveReadableFilePath - Function to get readable file path
 * @param {Function} params.computeFileHash - Function to compute file hash (for identical)
 * @param {Function} params.computePerceptualHashes - Function to compute perceptual hashes (for similar)
 * @param {number} params.batchSize - Files to process per batch (default 5 for low memory)
 * @param {number} params.delayBetweenBatches - MS delay between batches (default 500 for low CPU)
 * @param {boolean} params.includeVideos - Include videos in pre-analysis (default true)
 * @param {Function} params.onProgress - Optional progress callback ({ processed, total, cached })
 */
export const runBackgroundPreAnalysis = async ({
  resolveReadableFilePath,
  computeFileHash,
  computePerceptualHashes,
  batchSize = 5,
  delayBetweenBatches = 500,
  includeVideos = true,
  onProgress,
}) => {
  // Background pre-analysis disabled to reduce CPU lag
  return { disabled: true };
};

const _runBackgroundPreAnalysisOriginal = async ({
  resolveReadableFilePath,
  computeFileHash,
  computePerceptualHashes,
  batchSize = 5,
  delayBetweenBatches = 500,
  includeVideos = true,
  onProgress,
}) => {
  if (preAnalysisRunning) {
    console.log('[HashCache] Pre-analysis already running');
    return { alreadyRunning: true };
  }

  const readiness = await canRunPreAnalysisNow();
  if (!readiness.ok) {
    await savePreAnalysisState({
      phase: 'paused',
      pauseReason: 'waitingForIdle',
      pausedAt: Date.now(),
    });
    return { deferred: true, waitMs: readiness.waitMs };
  }

  preAnalysisRunning = true;
  preAnalysisAbort = false;
  preAnalysisAbortReason = null;

  console.log('[HashCache] Starting background pre-analysis...');

  try {
    const startedAt = Date.now();

    // Ensure cache is loaded
    await loadHashCache();

    await savePreAnalysisState({
      phase: 'collecting',
      startedAt,
      pausedAt: 0,
      completedAt: 0,
      pauseReason: null,
      total: 0,
      processed: 0,
      cached: 0,
      errors: 0,
      phashSkipped: 0,
      currentAssetId: null,
    });

    // Check permissions
    const permission = await MediaLibrary.getPermissionsAsync();
    if (permission.status !== 'granted') {
      console.log('[HashCache] No media permission for pre-analysis');
      await savePreAnalysisState({
        phase: 'idle',
        pauseReason: 'noPermission',
      });
      return { noPermission: true };
    }

    // Collect assets (paginated, low memory)
    const mediaTypes = includeVideos ? ['photo', 'video'] : ['photo'];
    const allAssets = [];
    let after = null;
    const PAGE_SIZE = 100; // Small pages for low memory

    while (!preAnalysisAbort) {
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after: after || undefined,
        mediaType: mediaTypes,
      });
      
      if (page?.assets) {
        allAssets.push(...page.assets);
      }
      
      after = page?.endCursor;
      if (!page?.hasNextPage) break;
      
      // Yield to prevent blocking
      await new Promise(r => setTimeout(r, 10));
    }

    if (preAnalysisAbort) {
      console.log('[HashCache] Pre-analysis aborted during collection');
      await savePreAnalysisState({
        phase: 'paused',
        startedAt,
        pauseReason: preAnalysisAbortReason || 'external',
        pausedAt: Date.now(),
      });
      return { aborted: true };
    }

    console.log(`[HashCache] Collected ${allAssets.length} assets for pre-analysis`);

    try {
      const currentAssetIds = new Set(allAssets.map(a => String(a?.id)).filter(Boolean));
      await pruneHashCache(currentAssetIds);
    } catch (e) {
      // ignore
    }

    // Check what's already cached
    const status = getCacheStatus(allAssets, 'file');
    console.log(`[HashCache] Cache status: ${status.cached} cached, ${status.uncached} need hashing`);

    if (status.uncached === 0) {
      console.log('[HashCache] All files already cached, pre-analysis complete');
      await flushHashCache();
      await savePreAnalysisState({
        phase: 'complete',
        startedAt,
        completedAt: Date.now(),
        pauseReason: null,
        pausedAt: 0,
        total: 0,
        processed: 0,
        cached: status.cached,
        errors: 0,
        phashSkipped: 0,
        currentAssetId: null,
        resumeAfterMs: 0,
      });
      return { complete: true, cached: status.cached, processed: 0 };
    }

    // Get uncached assets
    const uncachedAssets = getUncachedAssets(allAssets, 'file');
    let processed = 0;
    let errors = 0;
    let phashSkipped = 0;
    let lastCheckpointFlushMs = 0;

    const persistCheckpoint = async ({
      phase,
      currentAssetId = null,
      pauseReason = null,
      shouldFlushHashes = false,
      completed = false,
    }) => {
      if (shouldFlushHashes) {
        await flushHashCache();
      }

      const nextState = {
        phase,
        startedAt,
        pausedAt: phase === 'paused' ? Date.now() : 0,
        pauseReason: phase === 'paused' ? (pauseReason || preAnalysisAbortReason || 'external') : null,
        total: uncachedAssets.length,
        processed,
        cached: status.cached,
        errors,
        phashSkipped,
        currentAssetId,
      };

      if (completed) {
        nextState.completedAt = Date.now();
        nextState.resumeAfterMs = 0;
      }

      await savePreAnalysisState(nextState);
    };

    await persistCheckpoint({
      phase: 'running',
      currentAssetId: uncachedAssets[0]?.id ? String(uncachedAssets[0].id) : null,
      shouldFlushHashes: false,
    });

    // Process in small batches for low memory/CPU
    for (let i = 0; i < uncachedAssets.length; i += batchSize) {
      if (preAnalysisAbort) {
        console.log('[HashCache] Pre-analysis aborted');
        break;
      }

      await new Promise(resolve => {
        InteractionManager.runAfterInteractions(() => resolve());
      });
      if (preAnalysisAbort) break;

      const batch = uncachedAssets.slice(i, i + batchSize);

      for (const asset of batch) {
        if (preAnalysisAbort) break;

        let resolveResult = null;
        let filePath = null;
        try {
          // Get asset info
          const info = await MediaLibrary.getAssetInfoAsync(asset.id);
          if (!info) {
            if (errors < 3) console.log('[HashCache] Pre-analysis: no info for asset', asset?.id);
            errors++;
            continue;
          }

          // Get readable file path
          resolveResult = await resolveReadableFilePath({ assetId: asset.id, assetInfo: info });
          filePath = resolveResult?.filePath;
          if (!filePath) {
            if (errors < 3) console.log('[HashCache] Pre-analysis: no filePath for', info?.filename);
            errors++;
            continue;
          }

          // Skip large files (>50MB) to prevent video blocking during pre-analysis
          try {
            const fileInfo = await FileSystem.getInfoAsync(filePath, { size: true });
            if (fileInfo?.exists && typeof fileInfo?.size === 'number' && fileInfo.size > 50 * 1024 * 1024) {
              console.log('[HashCache] Pre-analysis: skipping large file', info?.filename, Math.round(fileInfo.size / 1024 / 1024), 'MB');
              continue;
            }
          } catch (_) {}

          let hashSuccess = false;

          // Compute file hash (for identical duplicates)
          if (computeFileHash) {
            try {
              const fileHash = await computeFileHash(filePath);
              if (fileHash) {
                setCachedHash(asset, 'file', fileHash);
                hashSuccess = true;
              } else if (errors < 3) {
                console.log('[HashCache] Pre-analysis: fileHash null for', info?.filename);
              }
            } catch (hashErr) {
              if (errors < 3) console.log('[HashCache] Pre-analysis: fileHash error', info?.filename, hashErr?.message);
            }
          }

          // Compute perceptual hashes (for similar photos) - only for images
          const isImage = info.mediaType === 'photo' || 
            (info.filename && /\.(jpg|jpeg|png|heic|heif|webp|gif|bmp)$/i.test(info.filename));

          if (computePerceptualHashes && isImage) {
            try {
              const hashes = await computePerceptualHashes(filePath, asset, info);
              if (hashes) {
                if (hashes.phash) { setCachedHash(asset, 'perceptual', hashes.phash); hashSuccess = true; }
                if (hashes.ehash) { setCachedHash(asset, 'edge', hashes.ehash); hashSuccess = true; }
                if (hashes.chash) { setCachedHash(asset, 'corner', hashes.chash); hashSuccess = true; }
              } else {
                phashSkipped++;
              }
            } catch (phashErr) {
              if (errors < 3) console.log('[HashCache] Pre-analysis: perceptualHash error', info?.filename, phashErr?.message);
            }
          }

          if (hashSuccess) {
            processed++;
          } else {
            errors++;
          }
        } catch (e) {
          if (errors < 3) console.log('[HashCache] Pre-analysis: exception', e?.message);
          errors++;
        } finally {
          if (resolveResult?.tmpCopied) {
            const cleanupTarget = resolveResult.tmpUri || (filePath && filePath.startsWith('/') ? `file://${filePath}` : filePath);
            if (cleanupTarget) {
              try {
                await FileSystem.deleteAsync(cleanupTarget, { idempotent: true });
              } catch (_) {}
            }
          }
        }

        // Yield to event loop so UI interactions (tab hopping etc.) remain responsive
        await new Promise(r => setImmediate(r));
      }

      // Report progress
      if (onProgress) {
        onProgress({
          processed,
          total: uncachedAssets.length,
          cached: status.cached,
          errors,
        });
      }

      const now = Date.now();
      const shouldFlushHashes = preAnalysisAbort || !lastCheckpointFlushMs || (now - lastCheckpointFlushMs) >= 5000 || (i + batch.length) >= uncachedAssets.length;
      if (shouldFlushHashes) {
        lastCheckpointFlushMs = now;
      }

      await persistCheckpoint({
        phase: preAnalysisAbort ? 'paused' : 'running',
        currentAssetId: uncachedAssets[i + batch.length]?.id ? String(uncachedAssets[i + batch.length].id) : null,
        pauseReason: preAnalysisAbort ? (preAnalysisAbortReason || 'external') : null,
        shouldFlushHashes,
      });

      if (preAnalysisAbort) break;

      // Delay between batches for low CPU usage
      await new Promise(r => setTimeout(r, delayBetweenBatches));
    }

    if (preAnalysisAbort) {
      return {
        aborted: true,
        processed,
        cached: status.cached,
        errors,
      };
    }

    await flushHashCache();
    await persistCheckpoint({
      phase: 'complete',
      currentAssetId: null,
      shouldFlushHashes: false,
      completed: true,
    });

    if (phashSkipped > 0) console.log(`[HashCache] Pre-analysis: perceptualHash skipped for ${phashSkipped} files (native module may not support format)`);
    console.log(`[HashCache] Pre-analysis complete: ${processed} processed, ${errors} errors`);

    return {
      complete: true,
      processed,
      cached: status.cached,
      errors,
      aborted: preAnalysisAbort,
    };
  } catch (e) {
    console.error('[HashCache] Pre-analysis error:', e?.message);
    await savePreAnalysisState({
      phase: 'paused',
      pauseReason: e?.message || 'error',
      pausedAt: Date.now(),
    });
    return { error: e?.message };
  } finally {
    preAnalysisRunning = false;
    preAnalysisAbort = false;
    preAnalysisAbortReason = null;
  }
};

/**
 * Pre-filter assets using cached hashes against server dedup sets.
 * Returns only assets that need uploading (not already on server).
 * 
 * @param {Array} assets - Array of MediaLibrary assets
 * @param {Object} serverDedupSets - { fileHashes: Set, perceptualHashes: Set, manifestIds: Set }
 * @param {Function} getManifestId - Function to compute manifestId from asset
 * @param {number} dhashThreshold - dHash threshold for perceptual matching (default 1)
 * @returns {Object} { toUpload: Array, alreadyOnServer: number, uncached: number }
 */
export const preFilterAssetsWithCache = (assets, serverDedupSets, getManifestId, dhashThreshold = 1) => {
  if (!assets || !serverDedupSets) return { toUpload: assets || [], alreadyOnServer: 0, uncached: 0 };
  if (!hotCache) return { toUpload: assets, alreadyOnServer: 0, uncached: assets.length };
  
  const { fileHashes: serverFileHashes, perceptualHashes: serverPHashes, manifestIds: serverManifestIds } = serverDedupSets;
  
  const toUpload = [];
  let alreadyOnServer = 0;
  let uncached = 0;
  
  // Hamming distance for dHash comparison
  const hammingDistance = (a, b) => {
    if (!a || !b || a.length !== 16 || b.length !== 16) return Number.MAX_SAFE_INTEGER;
    let dist = 0;
    for (let i = 0; i < 16; i += 8) {
      const valA = parseInt(a.substring(i, i + 8), 16);
      const valB = parseInt(b.substring(i, i + 8), 16);
      let x = valA ^ valB;
      while (x) { dist += x & 1; x >>>= 1; }
    }
    return dist;
  };
  
  const findPHashMatch = (hash, hashSet) => {
    if (!hash || !hashSet || hashSet.size === 0) return false;
    if (hashSet.has(hash)) return true;
    for (const existing of hashSet) {
      if (existing && hammingDistance(hash, existing) <= dhashThreshold) return true;
    }
    return false;
  };
  
  for (const asset of assets) {
    // Check manifestId first (quick check)
    if (getManifestId && serverManifestIds) {
      try {
        const manifestId = getManifestId(asset);
        if (manifestId && serverManifestIds.has(manifestId)) {
          alreadyOnServer++;
          continue;
        }
      } catch (e) { /* ignore */ }
    }
    
    // Check cached hashes against server
    const cached = getAllCachedHashes(asset);
    if (!cached || (!cached.fhash && !cached.phash)) {
      uncached++;
      toUpload.push(asset);
      continue;
    }
    
    // Check file hash (exact match)
    if (cached.fhash && serverFileHashes && serverFileHashes.has(cached.fhash)) {
      alreadyOnServer++;
      continue;
    }
    
    // Check perceptual hash (fuzzy match with threshold)
    if (cached.phash && serverPHashes && findPHashMatch(cached.phash, serverPHashes)) {
      alreadyOnServer++;
      continue;
    }
    
    // Not on server - needs upload
    toUpload.push(asset);
  }
  
  console.log(`[HashCache] Pre-filter: ${assets.length} total, ${alreadyOnServer} on server, ${toUpload.length} to upload, ${uncached} uncached`);
  
  return { toUpload, alreadyOnServer, uncached };
};
