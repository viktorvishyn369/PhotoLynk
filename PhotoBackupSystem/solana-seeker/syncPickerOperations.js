// PhotoLynk Mobile App - Sync Picker Operations
// Handles fetching and decrypting manifests for the sync picker UI

import axios from 'axios';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import * as FileSystem from 'expo-file-system';

/**
 * Decrypts a single manifest and returns a picker item
 * @param {string} manifestId - The manifest ID
 * @param {Object} config - Auth config with headers
 * @param {string} SERVER_URL - Server URL
 * @param {Uint8Array} masterKey - Decryption master key
 * @returns {Promise<{item: Object, success: boolean}>}
 */
export const decryptManifestForPicker = async (manifestId, config, SERVER_URL, masterKey, legacyKey) => {
  const mid = manifestId ? String(manifestId) : '';
  if (!mid) return { item: null, success: false };

  try {
    const manRes = await axios.get(`${SERVER_URL}/api/cloud/manifests/${mid}`, { 
      headers: config.headers, 
      timeout: 15000 
    });
    const payload = manRes.data;
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const enc = JSON.parse(parsed.encryptedManifest);
    const manifestNonce = naclUtil.decodeBase64(enc.manifestNonce);
    const manifestBox = naclUtil.decodeBase64(enc.manifestBox);
    let manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, masterKey);
    if (!manifestPlain && legacyKey) {
      manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, legacyKey);
    }

    if (!manifestPlain) {
      console.log(`Sync picker: decrypt returned null for ${mid} (wrong key?)`);
      return {
        item: { 
          manifestId: mid, 
          filename: `[encrypted] ${mid.slice(0, 12)}...`, 
          size: null, 
          mediaType: 'photo', 
          assetId: null, 
          decryptFailed: true 
        },
        success: false
      };
    }
    
    const manifest = JSON.parse(naclUtil.encodeUTF8(manifestPlain));
    const originalFilename = manifest.filename || manifest.name || manifest.originalFilename || null;
    const ext = (originalFilename || '').split('.').pop()?.toLowerCase() || '';
    const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext);
    const detectedMediaType = manifest.mediaType || (isVideo ? 'video' : 'photo');
    
    return {
      item: { 
        manifestId: mid, 
        filename: originalFilename || mid, 
        size: manifest.originalSize || manifest.size || null, 
        mediaType: detectedMediaType, 
        assetId: manifest.assetId || null 
      },
      success: true
    };
  } catch (e) {
    console.log('Sync picker: manifest fetch/parse failed for', mid, e.message);
    return {
      item: { 
        manifestId: mid, 
        filename: `[error] ${mid.slice(0, 12)}...`, 
        size: null, 
        mediaType: 'photo', 
        assetId: null, 
        decryptFailed: true 
      },
      success: false
    };
  }
};

/**
 * Fetches and decrypts a page of StealthCloud manifests for the sync picker
 * @param {Object} params
 * @param {Object} params.config - Auth config with headers
 * @param {string} params.SERVER_URL - Server URL
 * @param {Uint8Array} params.masterKey - Decryption master key
 * @param {number} params.offset - Page offset
 * @param {number} params.limit - Page size
 * @returns {Promise<{items: Array, total: number, nextOffset: number, decryptSuccess: number, decryptFail: number}>}
 */
export const fetchStealthCloudPickerPage = async ({
  config,
  SERVER_URL,
  masterKey,
  legacyKey,
  offset,
  limit,
}) => {
  const listRes = await axios.get(`${SERVER_URL}/api/cloud/manifests`, {
    ...config,
    params: { offset, limit, meta: 'true' }
  });
  const manifests = (listRes.data && listRes.data.manifests) || [];
  const total = typeof listRes.data?.total === 'number' ? listRes.data.total : manifests.length;

  const items = [];
  let decryptSuccess = 0;
  let decryptFail = 0;

  for (const m of manifests) {
    const mid = m && m.manifestId ? String(m.manifestId) : '';
    if (!mid) continue;

    const filename = m && typeof m.filename === 'string' ? m.filename : null;
    if (filename) {
      items.push({
        manifestId: mid,
        filename,
        size: (typeof m.originalSize === 'number' ? m.originalSize : null),
        mediaType: (m && typeof m.mediaType === 'string' ? m.mediaType : 'photo'),
        assetId: null,
        thumbChunkId: (m && typeof m.thumbChunkId === 'string' ? m.thumbChunkId : null),
        thumbNonce: (m && typeof m.thumbNonce === 'string' ? m.thumbNonce : null),
        thumbW: (typeof m.thumbW === 'number' ? m.thumbW : null),
        thumbH: (typeof m.thumbH === 'number' ? m.thumbH : null),
        thumbMime: (m && typeof m.thumbMime === 'string' ? m.thumbMime : null),
        thumbSize: (typeof m.thumbSize === 'number' ? m.thumbSize : null),
        thumbUri: null,
      });
      continue;
    }

    const result = await decryptManifestForPicker(mid, config, SERVER_URL, masterKey, legacyKey);
    if (result.item) {
      items.push({ ...result.item, thumbChunkId: null, thumbNonce: null, thumbW: null, thumbH: null, thumbMime: null, thumbSize: null, thumbUri: null });
      if (result.success) decryptSuccess++;
      else decryptFail++;
    }
  }

  const nextOffset = offset + manifests.length;
  return { items, total, nextOffset, decryptSuccess, decryptFail };
};

export const fetchStealthCloudThumbFileUri = async ({
  config,
  SERVER_URL,
  masterKey,
  legacyKey,
  thumbChunkId,
  thumbNonce,
  thumbMime,
}) => {
  const chunkId = thumbChunkId ? String(thumbChunkId).toLowerCase() : '';
  if (!chunkId || !thumbNonce || !masterKey) return null;
  if (!chunkId.match(/^[a-f0-9]{64}$/i)) return null;

  try {
    const url = `${SERVER_URL}/api/cloud/chunks/${chunkId}`;
    const response = await axios.get(url, {
      ...config,
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    const encryptedBytes = new Uint8Array(response.data);
    const nonce = naclUtil.decodeBase64(String(thumbNonce));
    let plain = nacl.secretbox.open(encryptedBytes, nonce, masterKey);
    if (!plain && legacyKey) {
      plain = nacl.secretbox.open(encryptedBytes, nonce, legacyKey);
    }
    if (!plain) return null;

    const ext = (thumbMime && String(thumbMime).includes('png')) ? 'png' : 'jpg';
    const fileUri = `${FileSystem.cacheDirectory}sc_thumb_${chunkId}.${ext}`;
    const b64 = Buffer.from(plain).toString('base64');
    await FileSystem.writeAsStringAsync(fileUri, b64, { encoding: FileSystem.EncodingType.Base64 });
    return fileUri;
  } catch (e) {
    return null;
  }
};

/**
 * Fetches a thumbnail for a file from the server and returns base64 data URI
 * Uses the /thumb endpoint which returns a resized 150px image
 * @param {string} filename - The filename to fetch thumbnail for
 * @param {Object} config - Auth config with headers
 * @param {string} SERVER_URL - Server URL
 * @returns {Promise<string|null>} - Base64 data URI or null on failure
 */
export const fetchThumbnailBase64 = async (filename, config, SERVER_URL, retryCount = 0) => {
  if (!filename) {
    console.log('Thumbnail fetch skipped: no filename');
    return null;
  }
  
  // HEIC files may need longer timeout as server converts them
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  const isHeic = ['heic', 'heif'].includes(ext);
  const timeout = isHeic ? 30000 : 10000; // Increased timeout for HEIC conversion
  
  try {
    // Add cache-busting parameter to ensure fresh thumbnails after server fixes
    const cacheBuster = Date.now();
    const url = `${SERVER_URL}/api/files/${encodeURIComponent(filename)}/thumb?_=${cacheBuster}`;
    const response = await axios.get(url, {
      ...config,
      responseType: 'arraybuffer',
      timeout,
    });
    // Check we got actual data
    if (!response.data || response.data.byteLength < 100) {
      console.log('[THUMB] Too small:', filename, response.data?.byteLength || 0);
      // Retry once for small responses (server may have returned placeholder)
      if (retryCount < 1) {
        await new Promise(r => setTimeout(r, 500));
        return fetchThumbnailBase64(filename, config, SERVER_URL, retryCount + 1);
      }
      return null;
    }
    const base64 = Buffer.from(new Uint8Array(response.data)).toString('base64');
    console.log('[THUMB] OK:', filename, 'size:', response.data.byteLength);
    return `data:image/jpeg;base64,${base64}`;
  } catch (e) {
    console.log('[THUMB] FAIL:', filename, e?.message || 'unknown');
    // Retry up to 2 times on timeout for HEIC files
    if (retryCount < 2 && isHeic && (e?.code === 'ECONNABORTED' || e?.message?.includes('timeout'))) {
      console.log('[THUMB] Retrying HEIC:', filename, 'attempt:', retryCount + 2);
      await new Promise(r => setTimeout(r, 2000));
      return fetchThumbnailBase64(filename, config, SERVER_URL, retryCount + 1);
    }
    return null;
  }
};

/**
 * Fetches a page of local/remote server files for the sync picker
 * @param {Object} params
 * @param {Object} params.config - Auth config with headers
 * @param {string} params.SERVER_URL - Server URL
 * @param {number} params.offset - Page offset
 * @param {number} params.limit - Page size
 * @param {boolean} params.fetchThumbnails - Whether to fetch thumbnails (default true)
 * @returns {Promise<{items: Array, total: number, nextOffset: number}>}
 */
export const fetchLocalRemotePickerPage = async ({
  config,
  SERVER_URL,
  offset,
  limit,
  fetchThumbnails = true,
}) => {
  const res = await axios.get(`${SERVER_URL}/api/files`, { 
    ...config, 
    params: { offset, limit } 
  });
  const serverFiles = res?.data?.files || [];
  const total = typeof res?.data?.total === 'number' ? res.data.total : serverFiles.length;

  // Fetch thumbnails sequentially in small batches to avoid memory pressure
  let items = serverFiles.map(f => ({ ...f, thumbUri: null }));
  if (fetchThumbnails && serverFiles.length > 0) {
    const BATCH_SIZE = 4; // Process 4 at a time to limit memory
    for (let i = 0; i < serverFiles.length; i += BATCH_SIZE) {
      const batch = serverFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (file, batchIdx) => {
        const ext = (file.filename || '').split('.').pop()?.toLowerCase() || '';
        const isImage = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'orf', 'rw2', 'pef', 'srw', 'raf', 'psd', 'psb', 'exr', 'hdr', 'avif'].includes(ext);
        const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext);
        if (isImage || isVideo) {
          const thumbUri = await fetchThumbnailBase64(file.filename, config, SERVER_URL);
          return { index: i + batchIdx, thumbUri };
        }
        return { index: i + batchIdx, thumbUri: null };
      }));
      // Update items with batch results
      for (const r of batchResults) {
        items[r.index] = { ...items[r.index], thumbUri: r.thumbUri };
      }
      // Small delay between batches to let memory settle
      if (i + BATCH_SIZE < serverFiles.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  const nextOffset = offset + serverFiles.length;
  console.log(`Sync picker: loaded ${items.length} items (offset ${nextOffset}/${total})`);

  return { items, total, nextOffset };
};

export default {
  decryptManifestForPicker,
  fetchStealthCloudPickerPage,
  fetchLocalRemotePickerPage,
};
