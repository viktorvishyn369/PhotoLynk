// BackupManager - Handles backup operations for Local, Remote, and StealthCloud
// Supports both "Backup All" and "Choose Files" modes

import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import axios from 'axios';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { sha256 } from 'js-sha256';

import {
  sleep,
  withRetries,
  shouldRetryChunkUpload,
  makeChunkNonce,
  normalizeFilenameForCompare,
  sanitizeHeaders,
  stripContentType,
  computeFileIdentity,
} from './utils';

import {
  MB,
  resolveReadableFilePath,
  getStealthCloudMasterKey,
  chooseStealthCloudChunkBytes,
  chooseStealthCloudMaxParallelChunkUploads,
  createConcurrencyLimiter,
  trackInFlightPromise,
  drainInFlightPromises,
  getDeviceCapability,
} from './backgroundTask';

import {
  getMediaLibraryAccessPrivileges,
  findFirstAlbumByTitle,
} from './autoUpload';

// ============================================================================
// CONSTANTS
// ============================================================================

const PHOTO_ALBUM_NAME = 'PhotoLynk';
const LEGACY_PHOTO_ALBUM_NAME = 'PhotoSync';

// ============================================================================
// HELPERS
// ============================================================================

const formatBytesHumanDecimal = (bytes) => {
  if (typeof bytes !== 'number' || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  return `${(bytes / (1000 * 1000 * 1000)).toFixed(2)} GB`;
};

const yieldToUi = () => new Promise(r => setTimeout(r, 0));

// Throttle functions now respect fastMode parameter
// Fast Mode: no delays for maximum speed
// Normal Mode: delays to prevent phone overheating
const getThrottleAssetCooldownMs = (fastMode) => fastMode ? 0 : (Platform.OS === 'ios' ? 300 : 200);
const getThrottleBatchLimit = (fastMode) => fastMode ? 999999 : (Platform.OS === 'ios' ? 25 : 30);
const thermalCooldownPause = async (batchNumber, fastMode) => {
  if (fastMode) return; // No cooldown in fast mode
  await sleep(Platform.OS === 'ios' ? 3000 : 2000);
};
const throttleEncryption = async (chunkIndex, fastMode) => {
  if (fastMode) return; // No throttling in fast mode
  // Minimal micro-sleep every 10 chunks to prevent ANR on weak devices
  if (chunkIndex > 0 && chunkIndex % 10 === 0) await sleep(Platform.OS === 'ios' ? 15 : 10);
};

const buildLocalAssetIdSetPaged = async ({ album }) => {
  const ids = new Set();
  let after = null;
  while (true) {
    const page = await MediaLibrary.getAssetsAsync({
      first: 500, after: after || undefined, album: album.id, mediaType: ['photo', 'video'],
    });
    const assets = page && Array.isArray(page.assets) ? page.assets : [];
    for (const a of assets) { if (a && a.id) ids.add(a.id); }
    after = page && page.endCursor ? page.endCursor : null;
    if (!page || page.hasNextPage !== true) break;
  }
  return ids;
};

// ============================================================================
// STEALTHCLOUD CHUNK UPLOAD
// ============================================================================

const stealthCloudUploadEncryptedChunk = async ({ SERVER_URL, config, chunkId, encryptedBytes }) => {
  const tmpUri = `${FileSystem.cacheDirectory}sc_${chunkId}.bin`;
  const b64 = naclUtil.encodeBase64(encryptedBytes);
  await FileSystem.writeAsStringAsync(tmpUri, b64, { encoding: FileSystem.EncodingType.Base64 });

  const url = `${SERVER_URL}/api/cloud/chunks`;
  const baseHeaders = sanitizeHeaders({
    'X-Chunk-Id': chunkId,
    ...(config && config.headers ? config.headers : {})
  });

  if (Platform.OS === 'ios') {
    const headers = { ...stripContentType(baseHeaders), 'Content-Type': 'application/octet-stream' };
    await withRetries(async () => {
      const isHttpsChunk = url.startsWith('https://');
      const sessionTypeChunk = (Platform.OS === 'ios' && !isHttpsChunk) 
        ? FileSystem.FileSystemSessionType.FOREGROUND 
        : FileSystem.FileSystemSessionType.BACKGROUND;
      const res = await FileSystem.uploadAsync(url, tmpUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        sessionType: sessionTypeChunk,
        headers
      });
      const status = res && typeof res.status === 'number' ? res.status : 0;
      if (status >= 300) {
        const err = new Error(`StealthCloud chunk upload failed: HTTP ${status}`);
        err.httpStatus = status;
        throw err;
      }
      return res;
    }, { retries: 20, baseDelayMs: 2000, maxDelayMs: 30000, shouldRetry: shouldRetryChunkUpload });
    await FileSystem.deleteAsync(tmpUri, { idempotent: true });
    return;
  }

  // Android: try react-native-blob-util first
  let ReactNativeBlobUtil = null;
  try {
    const mod = require('react-native-blob-util');
    ReactNativeBlobUtil = mod && (mod.default || mod);
  } catch (e) {
    ReactNativeBlobUtil = null;
  }

  const headers = stripContentType(baseHeaders);

  if (ReactNativeBlobUtil && ReactNativeBlobUtil.fetch && ReactNativeBlobUtil.wrap) {
    const filePath = tmpUri.startsWith('file://') ? tmpUri.replace('file://', '') : tmpUri;
    try {
      const rawHeaders = { ...headers, 'Content-Type': 'application/octet-stream' };
      await withRetries(async () => {
        const r = await ReactNativeBlobUtil.config({ timeout: 5 * 60 * 1000 }).fetch('POST', url, rawHeaders, ReactNativeBlobUtil.wrap(filePath));
        const status = typeof r?.info === 'function' ? r.info().status : undefined;
        if (typeof status === 'number' && status >= 300) {
          let body = '';
          try { body = typeof r?.text === 'function' ? await r.text() : ''; } catch (e) {}
          throw new Error(`Chunk upload failed: HTTP ${status}${body ? ` ${body}` : ''}`);
        }
        return r;
      }, { retries: 20, baseDelayMs: 2000, maxDelayMs: 30000, shouldRetry: shouldRetryChunkUpload });
      await FileSystem.deleteAsync(tmpUri, { idempotent: true });
      return;
    } catch (e) {
      console.warn('StealthCloud chunk upload failed (blob-util raw), trying multipart/axios:', e?.message || String(e));
      try {
        const mpHeaders = stripContentType(baseHeaders);
        await withRetries(async () => {
          const r2 = await ReactNativeBlobUtil.config({ timeout: 5 * 60 * 1000 }).fetch('POST', url, mpHeaders, [
            { name: 'chunk', filename: `${chunkId}.bin`, type: 'application/octet-stream', data: ReactNativeBlobUtil.wrap(filePath) }
          ]);
          const status2 = typeof r2?.info === 'function' ? r2.info().status : undefined;
          if (typeof status2 === 'number' && status2 >= 300) {
            let body2 = '';
            try { body2 = typeof r2?.text === 'function' ? await r2.text() : ''; } catch (e3) {}
            throw new Error(`Chunk upload failed (multipart): HTTP ${status2}${body2 ? ` ${body2}` : ''}`);
          }
          return r2;
        }, {
          retries: 20, baseDelayMs: 2000, maxDelayMs: 30000,
          shouldRetry: (e2) => {
            const msg = (e2 && e2.message ? e2.message : '').toLowerCase();
            if (msg.includes(' 429') || msg.includes(' 503') || msg.includes(' 500') || msg.includes(' 502') || msg.includes(' 504')) return true;
            if (msg.includes('timeout') || msg.includes('canceled') || msg.includes('cancelled') || msg.includes('network') || msg.includes('connection')) return true;
            return false;
          }
        });
        await FileSystem.deleteAsync(tmpUri, { idempotent: true });
        return;
      } catch (e2) {
        console.warn('StealthCloud chunk upload failed (blob-util multipart), falling back to axios:', e2?.message || String(e2));
      }
    }
  }

  // Fallback to axios FormData
  const formData = new FormData();
  formData.append('chunk', { uri: tmpUri, name: `${chunkId}.bin`, type: 'application/octet-stream' });
  try {
    await axios.post(url, formData, { headers: stripContentType(baseHeaders), timeout: 5 * 60 * 1000 });
    await FileSystem.deleteAsync(tmpUri, { idempotent: true });
  } catch (e) {
    console.warn('StealthCloud chunk upload failed (axios):', e?.message || String(e));
    throw e;
  }
};

// ============================================================================
// STEALTHCLOUD SINGLE ASSET UPLOAD (shared by All and Selected)
// ============================================================================

const uploadOneAssetToStealthCloud = async ({
  asset, config, SERVER_URL, masterKey, already, fastModeEnabled,
  processedIndex, totalCount, onStatus, onProgress,
}) => {
  // Prime device capability cache so concurrency helpers use correct tier
  await getDeviceCapability();

  onStatus(`Backing up ${processedIndex} of ${totalCount || '?'}`);

  let assetInfo;
  try {
    assetInfo = await withRetries(async () => {
      return Platform.OS === 'android'
        ? await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true })
        : await MediaLibrary.getAssetInfoAsync(asset.id);
    }, { retries: 5, baseDelayMs: 1000, maxDelayMs: 15000, shouldRetry: () => true });
  } catch (e) {
    console.warn('getAssetInfoAsync failed:', asset.id, e?.message);
    return { uploaded: 0, skipped: 0, failed: 1 };
  }

  let filePath, tmpCopied, tmpUri;
  try {
    const resolved = await resolveReadableFilePath({ assetId: asset.id, assetInfo });
    filePath = resolved.filePath; tmpCopied = resolved.tmpCopied; tmpUri = resolved.tmpUri;
  } catch (e) {
    console.warn('resolveReadableFilePath failed:', asset.id, e?.message);
    return { uploaded: 0, skipped: 0, failed: 1 };
  }

  const fileKey = new Uint8Array(32); global.crypto.getRandomValues(fileKey);
  const baseNonce16 = new Uint8Array(16); global.crypto.getRandomValues(baseNonce16);
  const wrapNonce = new Uint8Array(24); global.crypto.getRandomValues(wrapNonce);
  const wrappedKey = nacl.secretbox(fileKey, wrapNonce, masterKey);

  let chunkIndex = 0;
  const chunkIds = [], chunkSizes = [];
  let originalSize = null;
  const chunkUploadsInFlight = new Set();

  if (Platform.OS === 'ios') {
    const fileUri = filePath.startsWith('/') ? `file://${filePath}` : (filePath || tmpUri);
    try { const info = await FileSystem.getInfoAsync(fileUri); originalSize = info?.size || null; } catch (e) {}
  } else {
    // Android: get file size first
    let ReactNativeBlobUtil = null;
    try { const mod = require('react-native-blob-util'); ReactNativeBlobUtil = mod?.default || mod; } catch (e) {}
    if (ReactNativeBlobUtil?.fs?.stat) {
      try { const stat = await ReactNativeBlobUtil.fs.stat(filePath); originalSize = stat?.size || null; } catch (e) {}
    }
  }

  // Compute stable cross-device manifestId from filename + size
  const filename = assetInfo.filename || asset.filename || null;
  const fileIdentity = computeFileIdentity(filename, originalSize);
  const manifestId = fileIdentity ? sha256(`file:${fileIdentity}`) : sha256(`asset:${asset.id}`);
  
  // Skip if already uploaded (by stable manifestId)
  if (already.has(manifestId)) {
    if (tmpCopied && tmpUri) await FileSystem.deleteAsync(tmpUri, { idempotent: true });
    return { uploaded: 0, skipped: 1, failed: 0, manifestId };
  }

  if (Platform.OS === 'ios') {
    const fileUri = filePath.startsWith('/') ? `file://${filePath}` : (filePath || tmpUri);
    const maxChunkUploadsInFlight = Math.max(1, chooseStealthCloudMaxParallelChunkUploads({ platform: 'ios', originalSize, fastMode: fastModeEnabled }));
    const runChunkUpload = createConcurrencyLimiter(maxChunkUploadsInFlight);
    const chunkPlainBytes = chooseStealthCloudChunkBytes({ platform: 'ios', originalSize, fastMode: fastModeEnabled });
    const effectiveBytes = chunkPlainBytes - (chunkPlainBytes % 3);

    let position = 0;
    while (true) {
      let nextB64 = '';
      try {
        nextB64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64, position, length: effectiveBytes });
      } catch (e) {
        // Fallback: only safe for files under 50MB to avoid OOM crash on large videos
        if (originalSize && originalSize < 50 * 1024 * 1024) {
          const allB64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
          nextB64 = allB64.slice(Math.floor((position / 3) * 4), Math.floor((position / 3) * 4) + (effectiveBytes / 3) * 4);
        } else {
          console.warn(`[BackupManager] Chunk read failed for large file, skipping fallback to avoid OOM`);
          break;
        }
      }
      if (!nextB64) break;
      const plaintext = naclUtil.decodeBase64(nextB64);
      if (!plaintext || plaintext.length === 0) break;

      const nonce = makeChunkNonce(baseNonce16, chunkIndex);
      await throttleEncryption(chunkIndex, fastModeEnabled);
      const boxed = nacl.secretbox(plaintext, nonce, fileKey);
      const chunkId = sha256.create().update(boxed).hex();
      // Status already set at start of file processing
      await trackInFlightPromise(chunkUploadsInFlight, runChunkUpload(() => stealthCloudUploadEncryptedChunk({ SERVER_URL, config, chunkId, encryptedBytes: boxed })), maxChunkUploadsInFlight);
      chunkIds.push(chunkId); chunkSizes.push(plaintext.length);
      chunkIndex++; position += plaintext.length;
      if (totalCount && originalSize) {
        const fileProgress = (processedIndex - 1) / totalCount;
        onProgress(Math.min(fileProgress + (position / originalSize) / totalCount, 1));
      }
      // Thermal safety: micro-pause in fast mode every 20 chunks
      if (fastModeEnabled && chunkIndex > 0 && chunkIndex % 20 === 0) {
        await sleep(10);
      }
      if (plaintext.length < effectiveBytes) break;
    }
  } else {
    // Android
    let ReactNativeBlobUtil = null;
    try { const mod = require('react-native-blob-util'); ReactNativeBlobUtil = mod?.default || mod; } catch (e) {}
    if (!ReactNativeBlobUtil?.fs?.readStream) throw new Error('StealthCloud backup requires react-native-blob-util.');

    const maxChunkUploadsInFlight = Math.max(1, chooseStealthCloudMaxParallelChunkUploads({ platform: 'android', originalSize, fastMode: fastModeEnabled }));
    const runChunkUpload = createConcurrencyLimiter(maxChunkUploadsInFlight);
    const chunkPlainBytes = chooseStealthCloudChunkBytes({ platform: 'android', originalSize, fastMode: fastModeEnabled });
    const stream = await ReactNativeBlobUtil.fs.readStream(filePath, 'base64', chunkPlainBytes);

    await new Promise((resolve, reject) => {
      const queue = []; let draining = false, ended = false;
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
              const nonce = makeChunkNonce(baseNonce16, chunkIndex);
              await throttleEncryption(chunkIndex, fastModeEnabled);
              const boxed = nacl.secretbox(plaintext, nonce, fileKey);
              const chunkId = sha256.create().update(boxed).hex();
              // Status already set at start of file processing
              await trackInFlightPromise(chunkUploadsInFlight, runChunkUpload(() => stealthCloudUploadEncryptedChunk({ SERVER_URL, config, chunkId, encryptedBytes: boxed })), maxChunkUploadsInFlight);
              chunkIds.push(chunkId); chunkSizes.push(plaintext.length); chunkIndex++;
              if (totalCount) onProgress(processedIndex / totalCount);
              // Thermal safety: micro-pause in fast mode every 20 chunks
              if (fastModeEnabled && chunkIndex > 0 && chunkIndex % 20 === 0) {
                await sleep(10);
              }
            }
          } catch (e) { reject(e); return; } finally { draining = false; }
          if (ended && queue.length === 0) resolve();
        })();
      });
      stream.onError(reject);
      stream.onEnd(() => { ended = true; if (!draining && queue.length === 0) resolve(); });
    });
  }

  await drainInFlightPromises(chunkUploadsInFlight);
  if (!chunkIds.length) throw new Error('StealthCloud backup read 0 bytes.');

  const manifest = {
    v: 1, assetId: asset.id, filename: assetInfo.filename || asset.filename || null,
    mediaType: asset.mediaType || null, originalSize,
    baseNonce16: naclUtil.encodeBase64(baseNonce16), wrapNonce: naclUtil.encodeBase64(wrapNonce),
    wrappedFileKey: naclUtil.encodeBase64(wrappedKey), chunkIds, chunkSizes
  };
  const manifestPlain = naclUtil.decodeUTF8(JSON.stringify(manifest));
  const manifestNonce = new Uint8Array(24); global.crypto.getRandomValues(manifestNonce);
  const manifestBox = nacl.secretbox(manifestPlain, manifestNonce, masterKey);
  const encryptedManifest = JSON.stringify({ manifestNonce: naclUtil.encodeBase64(manifestNonce), manifestBox: naclUtil.encodeBase64(manifestBox) });

  await withRetries(async () => {
    await axios.post(`${SERVER_URL}/api/cloud/manifests`, { manifestId, encryptedManifest, chunkCount: chunkIds.length }, { headers: config.headers, timeout: 30000 });
  }, { retries: 20, baseDelayMs: 2000, maxDelayMs: 30000, shouldRetry: shouldRetryChunkUpload });

  if (tmpCopied && tmpUri) await FileSystem.deleteAsync(tmpUri, { idempotent: true });
  return { uploaded: 1, skipped: 0, failed: 0 };
};

// ============================================================================
// EXPORTS - Main backup functions
// ============================================================================

export {
  stealthCloudUploadEncryptedChunk,
  uploadOneAssetToStealthCloud,
  buildLocalAssetIdSetPaged,
  formatBytesHumanDecimal,
  yieldToUi,
  getThrottleAssetCooldownMs,
  getThrottleBatchLimit,
  thermalCooldownPause,
  throttleEncryption,
  PHOTO_ALBUM_NAME,
  LEGACY_PHOTO_ALBUM_NAME,
};

export default {
  stealthCloudUploadEncryptedChunk,
  uploadOneAssetToStealthCloud,
  buildLocalAssetIdSetPaged,
  formatBytesHumanDecimal,
  PHOTO_ALBUM_NAME,
  LEGACY_PHOTO_ALBUM_NAME,
};
