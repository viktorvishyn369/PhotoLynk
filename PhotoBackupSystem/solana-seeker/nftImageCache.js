// NFT Image Cache Utilities
// Separated to avoid circular dependencies between nftOperations.js and NFTGallery.js

import * as FileSystem from 'expo-file-system';

// Image cache directory and index file
const IMAGE_CACHE_DIR = `${FileSystem.cacheDirectory}nft_images/`;
const CACHE_INDEX_FILE = `${FileSystem.documentDirectory}nft_image_cache_index.json`;

// In-memory cache of local paths (CID -> local file path)
const imageCache = new Map();
let cacheLoaded = false;

// Helper to extract CID from IPFS URL
const extractCidFromUrl = (url) => {
  if (!url) return null;
  const match = url.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
};

// Load cache index from disk on startup
export const loadCacheIndex = async () => {
  if (cacheLoaded) return;
  try {
    const info = await FileSystem.getInfoAsync(CACHE_INDEX_FILE);
    if (info.exists) {
      const data = await FileSystem.readAsStringAsync(CACHE_INDEX_FILE);
      const index = JSON.parse(data);
      // Verify each cached file still exists
      for (const [cid, path] of Object.entries(index)) {
        const fileInfo = await FileSystem.getInfoAsync(path);
        if (fileInfo.exists) {
          imageCache.set(cid, path);
        }
      }
      console.log(`[NFTCache] Loaded ${imageCache.size} cached images`);
    }
  } catch (e) {
    console.log('[NFTCache] Could not load cache index:', e.message);
  }
  cacheLoaded = true;
};

// Save cache index to disk
export const saveCacheIndex = async () => {
  try {
    const index = Object.fromEntries(imageCache);
    await FileSystem.writeAsStringAsync(CACHE_INDEX_FILE, JSON.stringify(index));
  } catch (e) {
    console.log('[NFTCache] Could not save cache index:', e.message);
  }
};

// Get cached path for a CID
export const getCachedPath = (cid) => {
  return imageCache.get(cid);
};

// Set cached path for a CID
export const setCachedPath = (cid, path) => {
  imageCache.set(cid, path);
};

// Check if CID is cached
export const hasCachedPath = (cid) => {
  return imageCache.has(cid);
};

// Get cache directory
export const getCacheDir = () => IMAGE_CACHE_DIR;

// Remove a specific NFT image from cache (called after transfer)
export const removeNFTImageFromCache = async (imageUrl) => {
  if (!imageUrl) return;

  try {
    // Extract CID from URL
    const cid = extractCidFromUrl(imageUrl);
    if (cid && imageCache.has(cid)) {
      const localPath = imageCache.get(cid);
      // Delete the cached file
      await FileSystem.deleteAsync(localPath, { idempotent: true }).catch(() => { });
      // Remove from in-memory cache
      imageCache.delete(cid);
      // Update cache index
      await saveCacheIndex();
      console.log('[NFTCache] Removed from cache:', cid);
    }

    // Also try to remove from nft_images directory if it's a local path
    if (imageUrl.includes('nft_images/')) {
      await FileSystem.deleteAsync(imageUrl, { idempotent: true }).catch(() => { });
    }
  } catch (e) {
    console.log('[NFTCache] Error removing from cache:', e.message);
  }
};

export default {
  loadCacheIndex,
  saveCacheIndex,
  getCachedPath,
  setCachedPath,
  hasCachedPath,
  getCacheDir,
  removeNFTImageFromCache,
  extractCidFromUrl,
};
