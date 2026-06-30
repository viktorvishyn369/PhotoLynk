// PhotoLynk Mobile App - Media Library Helpers
// Functions for building local asset sets and fetching server files

import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import axios from 'axios';
import { normalizeFilenameForCompare } from './utils';

const quickYield = () => new Promise(r => {
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => r());
  } else {
    setTimeout(r, 0);
  }
});

/**
 * Build a set of local filenames from device media library (paged)
 * @param {Object} params
 * @param {Array} params.mediaType - Media types to include ['photo', 'video']
 * @param {Object} params.album - Optional album to filter by
 * @param {number} params.maxInitialEmptyWaitMs - Max wait time for initial empty results (iOS)
 * @returns {Promise<{set: Set, totalCount: number, scanned: number}>}
 */
export const buildLocalFilenameSetPaged = async ({ mediaType, album = null, maxInitialEmptyWaitMs = 30000 }) => {
  const PAGE_SIZE = 500;
  let after = null;
  const set = new Set();
  let totalCount = null;
  let scanned = 0;
  const maxAttempts = Math.max(1, Math.ceil((Number(maxInitialEmptyWaitMs) || 0) / 500));

  while (true) {
    let page = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after: after || undefined,
        mediaType,
        album: album || undefined,
      });

      const assetsNow = page && Array.isArray(page.assets) ? page.assets : [];
      if (!after && scanned === 0 && assetsNow.length === 0 && Platform.OS === 'ios' && attempt < (maxAttempts - 1)) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break;
    }

    if (totalCount === null && page && typeof page.totalCount === 'number') {
      totalCount = page.totalCount;
    }

    const assets = page && Array.isArray(page.assets) ? page.assets : [];
    if (assets.length === 0) break;

    for (const a of assets) {
      const n1 = normalizeFilenameForCompare(a && a.filename ? a.filename : null);
      if (n1) {
        set.add(n1);
        scanned += 1;
        continue;
      }

      try {
        const info = await MediaLibrary.getAssetInfoAsync(a.id);
        const n2 = normalizeFilenameForCompare(info && info.filename ? info.filename : null);
        if (n2) set.add(n2);
      } catch (e) {
        // ignore
      }
      scanned += 1;
    }

    after = page && page.endCursor ? page.endCursor : null;
    if (!page || page.hasNextPage !== true) break;
  }

  return { set, totalCount, scanned };
};

/**
 * Build a set of local asset IDs from device media library (paged)
 * @param {Object} params
 * @param {Object} params.album - Album to filter by
 * @param {number} params.maxInitialEmptyWaitMs - Max wait time for initial empty results (iOS)
 * @returns {Promise<Set>}
 */
export const buildLocalAssetIdSetPaged = async ({ album, maxInitialEmptyWaitMs = 30000 }) => {
  const PAGE_SIZE = 500;
  let after = null;
  const set = new Set();
  const maxAttempts = Math.max(1, Math.ceil((Number(maxInitialEmptyWaitMs) || 0) / 500));

  while (true) {
    let page = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after: after || undefined,
        album,
      });

      const assetsNow = page && Array.isArray(page.assets) ? page.assets : [];
      if (!after && set.size === 0 && assetsNow.length === 0 && Platform.OS === 'ios' && attempt < (maxAttempts - 1)) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break;
    }

    const assets = page && Array.isArray(page.assets) ? page.assets : [];
    if (assets.length === 0) break;
    for (let ai = 0; ai < assets.length; ai++) {
      const a = assets[ai];
      if (a && a.id) set.add(a.id);
      // Yield to UI every 100 items to keep app responsive
      if (ai > 0 && ai % 100 === 0) await quickYield();
    }
    // Yield between pages so the event loop can process touches
    await quickYield();

    after = page && page.endCursor ? page.endCursor : null;
    if (!page || page.hasNextPage !== true) break;
  }

  return set;
};

/**
 * Fetch all server files with pagination
 * @param {string} serverUrl - Server base URL
 * @param {Object} config - Axios config with auth headers
 * @param {Function} onFetchProgress - Optional callback (fetchedCount, estimatedTotal) for progress
 * @param {boolean} includeMeta - Whether to include hash metadata (for cross-device dedup)
 * @returns {Promise<Array>}
 */
export const fetchAllServerFilesPaged = async (serverUrl, config, onFetchProgress = null, includeMeta = false) => {
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

    const files = (response.data && response.data.files) ? response.data.files : [];
    allFiles.push(...files);
    
    // Get total from response if available
    if (estimatedTotal === null && typeof response.data?.total === 'number') {
      estimatedTotal = response.data.total;
    }
    
    // Report progress during fetch
    if (onFetchProgress) {
      onFetchProgress(allFiles.length, estimatedTotal || allFiles.length);
    }

    offset += files.length;
    if (typeof estimatedTotal === 'number') {
      if (allFiles.length >= estimatedTotal) break;
      if (!files || files.length === 0) break;
      await quickYield();
      continue;
    }

    if (!files || files.length < PAGE_LIMIT) break;
    await quickYield();
  }

  return allFiles;
};

/**
 * Fetch all StealthCloud manifests with pagination
 * @param {string} serverUrl - Server base URL
 * @param {Object} config - Axios config with auth headers
 * @param {Function} onFetchProgress - Optional callback (fetchedCount, estimatedTotal) for progress
 * @param {boolean} includeMeta - Whether to include hash metadata (for fast dedup)
 * @returns {Promise<Array>}
 */
export const fetchAllManifestsPaged = async (serverUrl, config, onFetchProgress = null, includeMeta = false) => {
  const PAGE_LIMIT = 500;
  const allManifests = [];
  let offset = 0;
  let estimatedTotal = null;

  while (true) {
    const response = await axios.get(`${serverUrl}/api/cloud/manifests`, {
      ...config,
      params: { offset, limit: PAGE_LIMIT, ...(includeMeta ? { meta: 'true' } : {}) }
    });

    const manifests = (response.data && response.data.manifests) ? response.data.manifests : [];
    allManifests.push(...manifests);
    
    // Get total from response if available
    if (estimatedTotal === null && typeof response.data?.total === 'number') {
      estimatedTotal = response.data.total;
    }
    
    // Report progress during fetch
    if (onFetchProgress) {
      onFetchProgress(allManifests.length, estimatedTotal || allManifests.length);
    }

    if (!manifests || manifests.length < PAGE_LIMIT) break;
    offset += manifests.length;
    if (typeof estimatedTotal === 'number' && offset >= estimatedTotal) break;
    await quickYield();
  }

  return allManifests;
};
