// encryptionMigration.js
// Background upgrade of file manifest encryption to wallet-signature-derived keys.
// NO chunks are re-uploaded — only the manifest wrapper is re-encrypted.
// This is fast, network-light, and phone-friendly.
//
// User-facing message: "Enhancing your file encryption security"
// The upgrade provides stronger security and enables self-service recovery
// on any device with the same wallet — no support ticket needed.

import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import axios from 'axios';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { AppState, Platform } from 'react-native';

import {
  getStealthCloudMasterKey,
  getWalletLegacyMasterKey,
} from './backgroundTask';
import { clearWalletLegacyPassword } from './walletAuth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Migration version — bump if protocol changes
const MIGRATION_VERSION = 'v1';

// SecureStore keys are scoped per-user so multiple accounts on one device
// don't see each other's migration progress.
const getUserPrefix = async () => {
  try {
    const email = await SecureStore.getItemAsync('user_email');
    return email ? email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').slice(0, 64) : 'anonymous';
  } catch (e) {
    return 'anonymous';
  }
};

const getMigrationStateKey = async () => `enc_mig_${MIGRATION_VERSION}_state_${await getUserPrefix()}`;
const getMigrationProgressKey = async () => `enc_mig_${MIGRATION_VERSION}_progress_${await getUserPrefix()}`;
const getMigrationProgressFile = async () => `${FileSystem.documentDirectory}enc_mig_${MIGRATION_VERSION}_progress_${await getUserPrefix()}.json`;

// Throttling: ms between manifest re-encryption operations
const INTER_FILE_DELAY_MS = 300;
const INTER_BATCH_DELAY_MS = 800;

// Batch size: how many manifests to process in one "session" before yielding
const BATCH_SIZE = 3;

// Max consecutive network errors before pausing for this session
const MAX_CONSECUTIVE_ERRORS = 5;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _migrationActive = false;
let _migrationPaused = false;
let _abortRequested = false;
let _lastProgress = null;

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

const loadProgress = async () => {
  try {
    const file = await getMigrationProgressFile();
    const info = await FileSystem.getInfoAsync(file);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(file);
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch (parseErr) {
          console.warn('[Migration] Corrupted progress file, resetting');
          await FileSystem.deleteAsync(file, { idempotent: true });
        }
      }
    }

    // Fallback: migrate from old SecureStore to FileSystem
    try {
      const key = await getMigrationProgressKey();
      const raw = await SecureStore.getItemAsync(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        await FileSystem.writeAsStringAsync(file, raw);
        console.log('[Migration] Migrated progress from SecureStore to FileSystem');
        return parsed;
      }
    } catch (_) {}
  } catch (e) {}
  return { completed: [], failed: [], total: 0, startedAt: null, lastRunAt: null };
};

const saveProgress = async (progress) => {
  const file = await getMigrationProgressFile();
  const data = JSON.stringify(progress);
  await FileSystem.writeAsStringAsync(file, data);
  _lastProgress = progress;
};

const loadMigrationState = async () => {
  try {
    const key = await getMigrationStateKey();
    const raw = await SecureStore.getItemAsync(key);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { needed: false, started: false, completed: false, pausedByUser: false };
};

const saveMigrationState = async (state) => {
  try {
    const key = await getMigrationStateKey();
    await SecureStore.setItemAsync(key, JSON.stringify(state));
  } catch (e) {
    console.warn('[Migration] Failed to save state:', e.message);
  }
};

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

const getAuthHeaders = async () => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
};

const getServerUrl = async () => {
  try {
    const serverType = await SecureStore.getItemAsync('server_type');
    const localHost = await SecureStore.getItemAsync('local_host');
    const remoteHost = await SecureStore.getItemAsync('remote_host');

    if (serverType === 'local' && localHost) {
      return localHost.startsWith('http') ? localHost : `http://${localHost}`;
    }
    if ((serverType === 'remote' || !serverType) && remoteHost) {
      return remoteHost.startsWith('https') ? remoteHost : `https://${remoteHost}`;
    }
    // Default fallback
    return 'https://stealthlynk.io';
  } catch (e) {
    return 'https://stealthlynk.io';
  }
};

// ---------------------------------------------------------------------------
// Core migration logic
// ---------------------------------------------------------------------------

/**
 * Check if migration is needed.
 * Needed when: secure key exists AND legacy key exists AND there are manifests on server.
 * If already migrated (secure key decrypts manifests), mark complete.
 */
export const checkMigrationNeeded = async () => {
  const state = await loadMigrationState();
  if (state.completed) return { needed: false, reason: 'already_complete' };
  if (state.pausedByUser) return { needed: false, reason: 'user_paused' };

  const secureKey = await getStealthCloudMasterKey();
  const legacyKey = await getWalletLegacyMasterKey();

  if (!secureKey) {
    return { needed: false, reason: 'no_secure_key' };
  }

  if (!legacyKey) {
    // No legacy key means nothing to migrate, or user is fresh
    await saveMigrationState({ ...state, needed: false, completed: true });
    return { needed: false, reason: 'no_legacy_key' };
  }

  // Both keys exist — check if there are actually old manifests
  const headers = await getAuthHeaders();
  if (!headers) return { needed: false, reason: 'not_authenticated' };

  const serverUrl = await getServerUrl();
  try {
    const res = await axios.get(`${serverUrl}/api/cloud/manifests`, { headers, timeout: 15000 });
    const manifests = res.data?.manifests || [];
    if (manifests.length === 0) {
      await saveMigrationState({ ...state, needed: false, completed: true });
      return { needed: false, reason: 'no_manifests' };
    }

    // Check if there are any legacy-encrypted manifests that need migration.
    // We test a small sample. If ALL tested are already secure AND either
    // (a) the progress says all are done, or (b) we test enough to be confident,
    // we mark complete. Otherwise migration is needed.
    const SAMPLE_SIZE = Math.min(5, manifests.length);
    let legacyFound = false;
    let secureFound = false;

    for (let s = 0; s < SAMPLE_SIZE; s++) {
      const sample = manifests[s];
      try {
        const sampleRes = await axios.get(`${serverUrl}/api/cloud/manifests/${sample.manifestId}`, { headers, timeout: 15000 });
        const sampleData = sampleRes.data;
        if (sampleData?.encryptedManifest) {
          let wrapper;
          try {
            wrapper = typeof sampleData.encryptedManifest === 'string'
              ? JSON.parse(sampleData.encryptedManifest)
              : sampleData.encryptedManifest;
          } catch (e) {
            wrapper = null;
          }

          if (wrapper?.manifestBox && wrapper?.manifestNonce) {
            const manifestBox = naclUtil.decodeBase64(wrapper.manifestBox);
            const manifestNonce = naclUtil.decodeBase64(wrapper.manifestNonce);
            const testPlain = nacl.secretbox.open(manifestBox, manifestNonce, secureKey);
            if (testPlain) {
              secureFound = true;
            } else {
              // Try legacy key — if it decrypts, this is definitely legacy
              if (legacyKey) {
                const legacyPlain = nacl.secretbox.open(manifestBox, manifestNonce, legacyKey);
                if (legacyPlain) {
                  legacyFound = true;
                  break; // Confirmed legacy, no need to sample more
                }
              }
            }
          }
        }
      } catch (e) {
        // Sample check failed, keep sampling
      }
    }

    // If no legacy found in sample AND secure manifests decrypt OK, mark complete
    const progress = await loadProgress();
    const allDone = progress.completed.length >= manifests.length;

    if (!legacyFound && secureFound) {
      // Sample shows everything is already secure — mark complete
      await saveMigrationState({ ...state, needed: false, completed: true, total: manifests.length });
      return { needed: false, total: manifests.length, reason: 'all_secure' };
    }

    await saveMigrationState({ ...state, needed: true, total: manifests.length });
    return { needed: true, total: manifests.length, reason: legacyFound ? 'legacy_manifests_found' : 'checking_remaining' };

  } catch (e) {
    console.warn('[Migration] Check failed:', e.message);
    return { needed: false, reason: 'check_failed', error: e.message };
  }
};

/**
 * Migrate a single manifest from legacy key to secure key.
 * Returns { ok: boolean, alreadySecure: boolean, error?: string }
 */
const migrateOneManifest = async (manifestId, secureKey, legacyKey, headers, serverUrl) => {
  try {
    // 1. Fetch manifest
    const res = await axios.get(`${serverUrl}/api/cloud/manifests/${manifestId}`, {
      headers,
      timeout: 15000,
    });
    const data = res.data;
    if (!data?.encryptedManifest) {
      return { ok: false, error: 'missing_encryptedManifest' };
    }

    // 2. Parse wrapper
    let wrapper;
    try {
      wrapper = typeof data.encryptedManifest === 'string'
        ? JSON.parse(data.encryptedManifest)
        : data.encryptedManifest;
    } catch (e) {
      return { ok: false, error: 'invalid_wrapper' };
    }

    if (!wrapper.manifestBox || !wrapper.manifestNonce) {
      return { ok: false, error: 'missing_box_or_nonce' };
    }

    const manifestBox = naclUtil.decodeBase64(wrapper.manifestBox);
    const manifestNonce = naclUtil.decodeBase64(wrapper.manifestNonce);

    // 3. Try decrypt with secure key first (maybe already migrated)
    let manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, secureKey);
    if (manifestPlain) {
      return { ok: true, alreadySecure: true };
    }

    // 4. Decrypt with legacy key
    manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, legacyKey);
    if (!manifestPlain) {
      return { ok: false, error: 'legacy_decrypt_failed' };
    }

    // 5. Re-encrypt with secure key (same nonce is fine, new ciphertext)
    const newManifestBox = nacl.secretbox(manifestPlain, manifestNonce, secureKey);
    if (!newManifestBox) {
      return { ok: false, error: 're_encrypt_failed' };
    }

    const newWrapper = {
      manifestBox: naclUtil.encodeBase64(newManifestBox),
      manifestNonce: wrapper.manifestNonce, // same nonce
    };

    // 6. PATCH manifest with new encrypted wrapper
    await axios.patch(
      `${serverUrl}/api/cloud/manifests/${manifestId}`,
      { encryptedManifest: JSON.stringify(newWrapper) },
      { headers, timeout: 15000 }
    );

    return { ok: true, alreadySecure: false };

  } catch (e) {
    return { ok: false, error: e.message };
  }
};

/**
 * Run migration in batches, with throttling and interruption handling.
 * @param {Object} options
 * @param {Function} options.onProgress - ({ completed, total, manifestId, status }) => void
 * @param {Function} options.onComplete - ({ migrated, alreadySecure, failed, total }) => void
 * @param {Function} options.onError - ({ manifestId, error }) => void
 */
export const runMigration = async ({ onProgress, onComplete, onError } = {}) => {
  if (_migrationActive) {
    console.log('[Migration] Already running');
    return;
  }

  const needed = await checkMigrationNeeded();
  if (!needed.needed) {
    console.log('[Migration] Not needed:', needed.reason);
    onComplete?.({ migrated: 0, alreadySecure: 0, failed: 0, total: 0, reason: needed.reason });
    return;
  }

  const secureKey = await getStealthCloudMasterKey();
  const legacyKey = await getWalletLegacyMasterKey();
  if (!secureKey || !legacyKey) {
    console.warn('[Migration] Missing keys');
    onComplete?.({ migrated: 0, alreadySecure: 0, failed: 0, total: 0, reason: 'missing_keys' });
    return;
  }

  const headers = await getAuthHeaders();
  if (!headers) {
    onComplete?.({ migrated: 0, alreadySecure: 0, failed: 0, total: 0, reason: 'not_authenticated' });
    return;
  }

  const serverUrl = await getServerUrl();
  _migrationActive = true;
  _migrationPaused = false;
  _abortRequested = false;

  let state = await loadMigrationState();
  state = { ...state, started: true, paused: false };
  await saveMigrationState(state);

  let progress = await loadProgress();
  if (!progress.startedAt) progress.startedAt = Date.now();

  // Fetch manifest list
  let allManifests = [];
  try {
    const res = await axios.get(`${serverUrl}/api/cloud/manifests`, { headers, timeout: 15000 });
    allManifests = (res.data?.manifests || []).map(m => m.manifestId).filter(Boolean);
    progress.total = allManifests.length;
  } catch (e) {
    console.error('[Migration] Failed to fetch manifest list:', e.message);
    _migrationActive = false;
    onComplete?.({ migrated: 0, alreadySecure: 0, failed: 0, total: 0, reason: 'list_fetch_failed' });
    return;
  }

  const toProcess = allManifests.filter(id => !progress.completed.includes(id));
  console.log(`[Migration] Starting: ${toProcess.length}/${allManifests.length} manifests to process`);

  let migrated = 0;
  let alreadySecureCount = 0;
  let failed = 0;
  let consecutiveErrors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    // Check for abort / pause / app state
    if (_abortRequested) {
      console.log('[Migration] Aborted by request');
      break;
    }
    if (_migrationPaused) {
      console.log('[Migration] Paused by user');
      break;
    }
    if (AppState.currentState !== 'active' && Platform.OS === 'ios') {
      console.log('[Migration] Paused: app not active');
      break;
    }

    const manifestId = toProcess[i];

    const result = await migrateOneManifest(manifestId, secureKey, legacyKey, headers, serverUrl);

    if (result.ok) {
      consecutiveErrors = 0;
      if (result.alreadySecure) {
        alreadySecureCount++;
      } else {
        migrated++;
      }
      if (!progress.completed.includes(manifestId)) {
        progress.completed.push(manifestId);
      }
    } else {
      failed++;
      consecutiveErrors++;
      if (!progress.failed.includes(manifestId)) {
        progress.failed.push(manifestId);
      }
      onError?.({ manifestId, error: result.error });
      console.warn(`[Migration] Failed ${manifestId}: ${result.error}`);
    }

    progress.lastRunAt = Date.now();
    try {
      await saveProgress(progress);
    } catch (saveErr) {
      console.warn('[Migration] Progress save failed (continuing):', saveErr.message);
    }

    // Report global progress after each file (real-time UI update)
    onProgress?.({
      completed: progress.completed.length,
      total: allManifests.length,
      manifestId,
      status: result.ok ? (result.alreadySecure ? 'already_secure' : 'migrated') : 'failed',
    });

    // Throttle
    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, INTER_FILE_DELAY_MS));
    }

    // Batch break
    if ((i + 1) % BATCH_SIZE === 0) {
      await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
    }

    // Too many consecutive errors → pause this session, retry next time
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.warn('[Migration] Too many consecutive errors, pausing session');
      break;
    }
  }

  // Check if fully complete
  const remaining = allManifests.filter(id => !progress.completed.includes(id));
  const isComplete = remaining.length === 0;

  if (isComplete) {
    state = { ...state, completed: true, needed: false };
    await saveMigrationState(state);
    console.log('[Migration] Complete!');
  } else {
    state = { ...state, paused: false };
    await saveMigrationState(state);
    console.log(`[Migration] Session ended. ${remaining.length} remaining.`);
  }

  _migrationActive = false;
  onComplete?.({ migrated, alreadySecure: alreadySecureCount, failed, total: allManifests.length, remaining: remaining.length });
};

// ---------------------------------------------------------------------------
// Control interface
// ---------------------------------------------------------------------------

export const pauseMigration = () => {
  _migrationPaused = true;
};

export const resumeMigration = async () => {
  _migrationPaused = false;
  const state = await loadMigrationState();
  if (state.pausedByUser) {
    await saveMigrationState({ ...state, pausedByUser: false });
  }
};

export const abortMigration = () => {
  _abortRequested = true;
};

export const isMigrationActive = () => _migrationActive;

export const getMigrationProgress = async () => {
  // When migration is actively running, use in-memory _lastProgress to avoid
  // disk-read race conditions where the file may not have flushed yet.
  const progress = (_migrationActive && _lastProgress)
    ? _lastProgress
    : await loadProgress();
  const state = await loadMigrationState();
  return {
    ...progress,
    ...state,
    completedManifests: progress.completed || [],
    failedManifests: progress.failed || [],
    isComplete: state.completed || false,
  };
};

/**
 * Reset migration state (for testing or re-run)
 */
export const resetMigration = async () => {
  _abortRequested = true;
  await new Promise(r => setTimeout(r, 500));
  try {
    const stateKey = await getMigrationStateKey();
    const progressFile = await getMigrationProgressFile();
    await SecureStore.deleteItemAsync(stateKey);
    const info = await FileSystem.getInfoAsync(progressFile);
    if (info.exists) await FileSystem.deleteAsync(progressFile, { idempotent: true });
  } catch (e) {}
  _migrationActive = false;
  _migrationPaused = false;
  _abortRequested = false;
  _lastProgress = null;
};

/**
 * User-toggle: pause migration permanently until user un-pauses
 */
export const setUserPaused = async (paused) => {
  const state = await loadMigrationState();
  await saveMigrationState({ ...state, pausedByUser: paused });
};

export const isUserPaused = async () => {
  const state = await loadMigrationState();
  return state.pausedByUser || false;
};

// ---------------------------------------------------------------------------
// Opportunistic trigger
// ---------------------------------------------------------------------------

/**
 * Call this periodically (e.g. on app focus, or every few minutes when idle)
 * to opportunistically continue migration.
 */
export const maybeContinueMigration = async ({ onProgress, onComplete, onError } = {}) => {
  if (_migrationActive) return;
  if (_migrationPaused) return;

  const state = await loadMigrationState();
  if (state.completed || state.pausedByUser) return;

  // Only run if app is active and we're not in the middle of something important
  if (AppState.currentState !== 'active') return;

  // Re-check current state from server — manifest list may have changed
  const needed = await checkMigrationNeeded();
  if (!needed.needed) {
    console.log('[Migration] No work needed:', needed.reason);
    return;
  }

  console.log('[Migration] Opportunistic continue...');
  await runMigration({ onProgress, onComplete, onError });
};
