/**
 * duplicateScanner.js
 * 
 * Handles scanning device photos for exact duplicates using pixel-based hashing.
 * Moved from App.js to keep codebase clean and modular.
 */

import { Platform, NativeModules } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { sha256 } from 'js-sha256';
import naclUtil from 'tweetnacl-util';

const { PixelHash, MediaDelete, ExifExtractor } = NativeModules;

// ============================================================================
// SIMILAR PHOTOS - Simplified perceptual hashing (like image-hash library)
// ============================================================================

// Hamming distance for 64-char hex hash (256 bits)
const hammingDistance256 = (a, b) => {
  if (!a || !b || a.length !== 64 || b.length !== 64) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  // Process 16 chars (64 bits) at a time to avoid BigInt overflow
  for (let i = 0; i < 64; i += 16) {
    const chunkA = BigInt('0x' + a.substring(i, i + 16));
    const chunkB = BigInt('0x' + b.substring(i, i + 16));
    let x = chunkA ^ chunkB;
    while (x) {
      dist++;
      x &= x - 1n;
    }
  }
  return dist;
};

// Similar detection thresholds (like image-hash library)
const SIMILAR_THRESHOLD = 24; // Max hamming distance for similar (out of 256 bits)
const SIMILAR_TIME_WINDOW_MS = 60000; // 60 seconds - burst shots are usually within this

// Hamming distance for 16-char hex hash (64 bits) - for dHash cross-platform deduplication
// Different JPEG decoders (iOS vs Android) produce slightly different pixel values
// so we need fuzzy matching instead of exact hash comparison
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

// Cross-platform deduplication threshold for 64-bit dHash
// 2 bits = ~3% difference tolerance for cross-device image encoding differences
const CROSS_PLATFORM_DHASH_THRESHOLD = 2;
const SUPPORTED_VIDEO_RE = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|3g2|wmv|flv|mpg|mpeg|mts|m2ts)$/i;

// Extract base filename for cross-platform variant deduplication
// Handles iOS, Android/Google Photos, Windows, and Linux naming patterns:
// iOS: IMG_1234_1_105_c.jpeg, IMG_1234_4_5005_c.jpeg
// Android/Google: IMG_20231225_123456_1.jpg, PXL_20231225_123456~2.jpg
// Windows: IMG_1234 (2).jpg, IMG_1234 - Copy.jpg
// Linux: IMG_1234 (copy).jpg, IMG_1234_copy.jpg
const extractBaseFilename = (name) => {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  
  // Remove extension first
  const extMatch = trimmed.match(/^(.+)\.(\w+)$/);
  if (!extMatch) return trimmed;
  let nameWithoutExt = extMatch[1];
  
  // iOS variant patterns: _1_105_c, _4_5005_c, _1_201_a, _2_100_a, etc.
  nameWithoutExt = nameWithoutExt.replace(/_\d+_\d+_[a-z]$/, '');
  
  // Android/Google Photos burst/edit patterns:
  // Only strip _1, _2 after 6+ digit timestamp (not image numbers like _5730)
  nameWithoutExt = nameWithoutExt.replace(/(_\d{6,})_\d{1,2}$/, '$1');
  nameWithoutExt = nameWithoutExt.replace(/~\d+$/, '');           // ~2, ~3 (Google edited)
  nameWithoutExt = nameWithoutExt.replace(/-(edit|edited|collage|animation)$/i, '');
  nameWithoutExt = nameWithoutExt.replace(/_burst\d*$/i, '');     // _BURST001
  
  // Windows patterns:
  nameWithoutExt = nameWithoutExt.replace(/ \(\d+\)$/, '');       // " (2)" with space
  nameWithoutExt = nameWithoutExt.replace(/\(\d+\)$/, '');        // "(2)" no space
  nameWithoutExt = nameWithoutExt.replace(/ - copy( \(\d+\))?$/i, ''); // " - Copy", " - Copy (2)"
  nameWithoutExt = nameWithoutExt.replace(/ copy( \d+)?$/i, '');  // " copy", " copy 1", " copy 2"
  nameWithoutExt = nameWithoutExt.replace(/_\(\d+\)$/, '');       // "_(1)", "_(2)"
  nameWithoutExt = nameWithoutExt.replace(/ _\d+$/, '');          // " _1", " _2"
  
  // Linux patterns:
  nameWithoutExt = nameWithoutExt.replace(/ \(copy\)$/i, '');     // " (copy)"
  nameWithoutExt = nameWithoutExt.replace(/ \(copy \d+\)$/i, ''); // " (copy 1)", " (copy 2)"
  nameWithoutExt = nameWithoutExt.replace(/_copy\d*$/i, '');      // "_copy", "_copy2"
  nameWithoutExt = nameWithoutExt.replace(/\.bak$/i, '');         // ".bak"
  
  // Generic duplicate suffixes (standalone _1, _2 at end):
  nameWithoutExt = nameWithoutExt.replace(/_\d{1,2}$/, '');       // "_1", "_2", "_12" (but not _123456 timestamps)
  nameWithoutExt = nameWithoutExt.replace(/ \d{1,2}$/, '');       // " 1", " 2" at end
  
  // Generic patterns:
  nameWithoutExt = nameWithoutExt.replace(/_backup$/i, '');
  nameWithoutExt = nameWithoutExt.replace(/-backup$/i, '');
  nameWithoutExt = nameWithoutExt.replace(/_original$/i, '');
  
  return nameWithoutExt.trim();
};

// Normalize date for comparison - extracts YYYY-MM-DD format
const normalizeDateForCompare = (dateVal) => {
  if (!dateVal) return null;
  try {
    let date;
    if (typeof dateVal === 'number') {
      date = new Date(dateVal > 9999999999 ? dateVal : dateVal * 1000);
    } else if (typeof dateVal === 'string') {
      date = new Date(dateVal);
    } else if (dateVal instanceof Date) {
      date = dateVal;
    } else {
      return null;
    }
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  } catch (e) {
    return null;
  }
};

// Normalize full timestamp for HEIC deduplication - extracts YYYY-MM-DDTHH:MM:SS format
// This provides second-level precision for matching identical photos across platforms
// HEIC files from iPhone and desktop have same EXIF timestamp even if bytes differ
const normalizeFullTimestamp = (dateVal) => {
  if (!dateVal) return null;
  try {
    let date;
    if (typeof dateVal === 'number') {
      date = new Date(dateVal > 9999999999 ? dateVal : dateVal * 1000);
    } else if (typeof dateVal === 'string') {
      date = new Date(dateVal);
    } else if (dateVal instanceof Date) {
      date = dateVal;
    } else {
      return null;
    }
    if (isNaN(date.getTime())) return null;
    // Return YYYY-MM-DDTHH:MM:SS format (second precision, no milliseconds)
    return date.toISOString().replace(/\.\d{3}Z$/, '');
  } catch (e) {
    return null;
  }
};

// ============================================================================
// EXIF-BASED DEDUPLICATION - Extract real EXIF data for cross-platform matching
// ============================================================================

/**
 * Extract EXIF data from assetInfo for deduplication.
 * Returns normalized EXIF fields: captureTime, make (manufacturer), model (camera/phone)
 * @param {Object} assetInfo - expo-media-library AssetInfo with exif property
 * @param {Object} asset - expo-media-library Asset with creationTime
 * @returns {Object} { captureTime, make, model } - normalized EXIF data
 */
const extractExifForDedup = (assetInfo, asset) => {
  const result = {
    captureTime: null,  // EXIF DateTimeOriginal (second precision)
    make: null,         // EXIF Make (e.g., "Apple", "Samsung")
    model: null,        // EXIF Model (e.g., "iPhone 14 Pro", "SM-G998B")
  };

  try {
    const exif = assetInfo?.exif;
    
    // Extract capture time from EXIF DateTimeOriginal or DateTimeDigitized
    // Format: "YYYY:MM:DD HH:MM:SS" -> normalize to "YYYY-MM-DDTHH:MM:SS"
    let captureTimeStr = exif?.DateTimeOriginal || exif?.DateTimeDigitized || exif?.DateTime;
    if (captureTimeStr && typeof captureTimeStr === 'string') {
      // EXIF format: "2024:01:15 14:32:45" -> ISO: "2024-01-15T14:32:45"
      const normalized = captureTimeStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(normalized)) {
        result.captureTime = normalized.slice(0, 19); // Trim to second precision
      }
    }
    
    // Fallback to asset.creationTime if no EXIF timestamp
    if (!result.captureTime && asset?.creationTime) {
      result.captureTime = normalizeFullTimestamp(asset.creationTime);
    }

    // Extract make (manufacturer) - normalize to lowercase for comparison
    if (exif?.Make && typeof exif.Make === 'string') {
      result.make = exif.Make.trim().toLowerCase();
    }

    // Extract model - normalize to lowercase for comparison
    if (exif?.Model && typeof exif.Model === 'string') {
      result.model = exif.Model.trim().toLowerCase();
    }
  } catch (e) {
    // Silently fail - EXIF extraction is best-effort
  }

  return result;
};

/**
 * Extract EXIF data using native module for reliable extraction.
 * expo-media-library's assetInfo.exif is incomplete on iOS - missing Make/Model fields
 * This function uses the native ExifExtractor module for reliable extraction
 * @param {string} filePath - Path to the image file
 * @param {Object} assetInfo - expo-media-library AssetInfo (fallback)
 * @param {Object} asset - expo-media-library Asset (fallback for creationTime)
 * @returns {Promise<{captureTime: string|null, make: string|null, model: string|null}>}
 */
const extractExifForDedupNative = async (filePath, assetInfo, asset) => {
  const result = {
    captureTime: null,
    make: null,
    model: null,
  };

  // Try native ExifExtractor first (more reliable on iOS)
  if (ExifExtractor && typeof ExifExtractor.extractExif === 'function' && filePath) {
    try {
      const nativeExif = await ExifExtractor.extractExif(filePath);
      if (nativeExif) {
        if (nativeExif.captureTime) {
          // Normalize to ISO format
          let ct = nativeExif.captureTime;
          if (/^\d{4}:\d{2}:\d{2}/.test(ct)) {
            ct = ct.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          }
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ct)) {
            result.captureTime = ct.slice(0, 19);
          }
        }
        if (nativeExif.make && typeof nativeExif.make === 'string') {
          result.make = nativeExif.make.trim().toLowerCase();
        }
        if (nativeExif.model && typeof nativeExif.model === 'string') {
          result.model = nativeExif.model.trim().toLowerCase();
        }
      }
    } catch (e) {
      console.warn('Native EXIF extraction failed:', e?.message);
    }
  }

  // Fallback to assetInfo.exif if native extraction didn't get everything
  if (!result.captureTime || !result.make || !result.model) {
    const fallback = extractExifForDedup(assetInfo, asset);
    if (!result.captureTime && fallback.captureTime) result.captureTime = fallback.captureTime;
    if (!result.make && fallback.make) result.make = fallback.make;
    if (!result.model && fallback.model) result.model = fallback.model;
  }

  // Final fallback for captureTime from asset.creationTime
  if (!result.captureTime && asset?.creationTime) {
    result.captureTime = normalizeFullTimestamp(asset.creationTime);
  }

  return result;
};

/**
 * Generate EXIF-based deduplication key for matching across platforms.
 * Priority: captureTime+make+model > captureTime+model > captureTime+make > captureTime only
 * @param {Object} exifData - { captureTime, make, model } from extractExifForDedup
 * @returns {Object} { full, timeModel, timeMake, timeOnly } - dedup keys at different precision levels
 */
const generateExifDedupKeys = (exifData) => {
  const { captureTime, make, model } = exifData || {};
  
  return {
    // Highest confidence: all 3 fields match
    full: (captureTime && make && model) ? `${captureTime}|${make}|${model}` : null,
    // High confidence: captureTime + model (different makes can have same model name, rare)
    timeModel: (captureTime && model) ? `${captureTime}|${model}` : null,
    // Medium confidence: captureTime + make
    timeMake: (captureTime && make) ? `${captureTime}|${make}` : null,
    // Lower confidence: captureTime only (still useful with baseFilename)
    timeOnly: captureTime || null,
  };
};

// Hamming distance for 8-char hex hash (32 bits) - for edge hash
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

// Edge hash threshold - if edges match within 4 bits, same scene/background
const EDGE_MATCH_THRESHOLD = 4;

// Hamming distance for 4-char hex hash (16 bits) - for corner hash
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

// Corner hash threshold - if corners match within 2 bits, same scene/background (grayscale)
const CORNER_MATCH_THRESHOLD = 2;

// ============================================================================
// EXACT DUPLICATES - Full file hashing for upload deduplication
// ============================================================================

/**
 * Compute exact file hash (SHA-256 of full file contents) for deduplication.
 * Used by StealthCloud upload to skip files that already exist on server regardless of filename.
 * @param {string} filePath - Path to the file
 * @returns {Promise<string|null>} SHA-256 hex string or null on error
 */
/**
 * Compute perceptual hash (visual content hash) for images.
 * This hash is based on image pixels and is resistant to transcoding, compression, metadata changes.
 * Used to detect visually identical images even if file bytes differ.
 * @param {string} filePath - Path to the image file
 * @param {Object} asset - MediaLibrary asset object (optional, for type checking)
 * @param {Object} info - Asset info object (optional, for type checking)
 * @returns {Promise<string|null>} Perceptual hash hex string or null if not an image or error
 */
/**
 * Find a matching perceptual hash in a set using Hamming distance
 * Returns true if any hash in the set is within threshold distance
 * @param {string} hash - The hash to check
 * @param {Set<string>} hashSet - Set of existing hashes
 * @param {number} threshold - Max Hamming distance for match (default 5)
 * @returns {boolean} True if a close match exists
 */
export { extractBaseFilename, normalizeDateForCompare, normalizeFullTimestamp, extractExifForDedup, extractExifForDedupNative, generateExifDedupKeys, CROSS_PLATFORM_DHASH_THRESHOLD };

export const findPerceptualHashMatch = (hash, hashSet, threshold = CROSS_PLATFORM_DHASH_THRESHOLD) => {
  if (!hash || hash.length !== 16 || !hashSet || hashSet.size === 0) return false;
  
  // First check exact match (fast path)
  if (hashSet.has(hash)) return true;
  
  // Check Hamming distance for fuzzy match
  for (const existingHash of hashSet) {
    if (existingHash && existingHash.length === 16) {
      const dist = hammingDistance64(hash, existingHash);
      if (dist <= threshold) {
        return true;
      }
    }
  }
  return false;
};

export const computePerceptualHash = async (filePath, asset = null, info = null) => {
  try {
    // Check if PixelHash native module is available
    if (!PixelHash || typeof PixelHash.hashImagePixels !== 'function') {
      console.warn('PixelHash native module not available for perceptual hashing');
      return null;
    }

    // Only compute for reliably perceptual-hashable image formats
    if (!isReliablyPerceptualHashable(filePath, asset, info)) {
      return null;
    }

    // Normalize path exactly like getHashTarget does for scanSimilarPhotos
    // This ensures backup dedup uses identical path handling as clean duplicates
    let hashTarget = filePath;
    if (hashTarget && typeof hashTarget === 'string') {
      // Strip file:// prefix
      if (hashTarget.startsWith('file://')) {
        hashTarget = hashTarget.replace('file://', '');
      }
      // Remove query params and fragments
      const hashIdx = hashTarget.indexOf('#');
      if (hashIdx !== -1) hashTarget = hashTarget.slice(0, hashIdx);
      const qIdx = hashTarget.indexOf('?');
      if (qIdx !== -1) hashTarget = hashTarget.slice(0, qIdx);
      // Decode URI-encoded characters (important for filenames with special chars)
      try { hashTarget = decodeURI(hashTarget); } catch (e) {}
    }

    // Compute pixel-based perceptual hash (same as scanSimilarPhotos)
    const hashHex = await PixelHash.hashImagePixels(hashTarget);
    console.log(`[PixelHash-JS] Native module returned: ${hashHex ? hashHex.length : 0} chars for ${hashTarget}`);
    return hashHex || null;
  } catch (e) {
    console.warn('computePerceptualHash failed:', e?.message);
    return null;
  }
};

export const computeExactFileHash = async (filePath) => {
  try {
    const hashCtx = sha256.create();
    const HASH_CHUNK_BYTES = 1024 * 1024; // 1MB chunks reduce I/O overhead 4x vs 256KB

    if (Platform.OS === 'ios') {
      const fileUri = filePath.startsWith('/') ? `file://${filePath}` : filePath;
      let position = 0;
      let chunkCount = 0;
      const YIELD_EVERY = 10; // Yield every N chunks to prevent UI blocking on large videos
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
          // Fallback: try smaller chunks instead of loading entire file (prevents OOM on large videos)
          let fallbackB64 = '';
          let tryChunk = effectiveBytes;
          while (tryChunk >= 8192) {
            tryChunk = Math.floor(tryChunk / 4);
            try {
              fallbackB64 = await FileSystem.readAsStringAsync(fileUri, {
                encoding: FileSystem.EncodingType.Base64,
                position,
                length: tryChunk - (tryChunk % 3)
              });
              if (fallbackB64) break;
            } catch (_) {}
          }
          nextB64 = fallbackB64;
        }
        if (!nextB64) break;
        const plaintext = naclUtil.decodeBase64(nextB64);
        if (!plaintext || plaintext.length === 0) break;
        hashCtx.update(plaintext);
        position += plaintext.length;
        if (plaintext.length < effectiveBytes) break;
        // Yield to UI thread periodically so large video hashes don't freeze the app
        chunkCount++;
        if (chunkCount % YIELD_EVERY === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
    } else {
      let ReactNativeBlobUtil = null;
      try {
        const mod = require('react-native-blob-util');
        ReactNativeBlobUtil = mod && (mod.default || mod);
      } catch (e) {}
      if (!ReactNativeBlobUtil || !ReactNativeBlobUtil.fs || typeof ReactNativeBlobUtil.fs.readStream !== 'function') {
        throw new Error('Exact file hash requires react-native-blob-util on Android.');
      }
      const stream = await ReactNativeBlobUtil.fs.readStream(filePath, 'base64', HASH_CHUNK_BYTES);
      await new Promise((resolve, reject) => {
        let pending = 0;
        stream.open();
        stream.onData((chunkB64) => {
          pending++;
          try {
            const plaintext = naclUtil.decodeBase64(chunkB64);
            hashCtx.update(plaintext);
          } catch (e) {
            reject(e);
            return;
          }
          pending--;
        });
        stream.onError((e) => reject(e));
        stream.onEnd(() => {
          const checkEnd = () => {
            if (pending === 0) resolve();
            else setTimeout(checkEnd, 10);
          };
          checkEnd();
        });
      });
    }
    return hashCtx.hex();
  } catch (e) {
    console.warn('computeExactFileHash failed:', e?.message || e);
    return null;
  }
};

// ============================================================================
// EXACT DUPLICATES - Pixel hashing helpers
// ============================================================================

/**
 * Resolves a readable file path for an asset.
 * Handles ph://, content://, file:// URIs.
 * @param {Object} params
 * @param {string} params.assetId - The asset ID
 * @param {Object} params.assetInfo - The asset info object
 * @param {Function} params.resolveReadableFilePath - Function to resolve readable file path
 * @returns {Promise<{filePath: string|null, tmpCopied: boolean, tmpUri: string|null}>}
 */
const getHashTarget = async ({ asset, info, resolveReadableFilePath }) => {
  let hashTarget = null;
  let tmpCopied = false;
  let tmpUri = null;
  const rawUri = (info && (info.localUri || info.uri)) || null;
  
  // Helper to try resolving with shouldDownloadFromNetwork on iOS
  const tryIosDownload = async () => {
    if (Platform.OS !== 'ios') return null;
    try {
      const infoDownloaded = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true });
      const dlUri = (infoDownloaded && (infoDownloaded.localUri || infoDownloaded.uri)) || null;
      if (dlUri && typeof dlUri === 'string' && (dlUri.startsWith('file://') || dlUri.startsWith('/'))) {
        let path = dlUri.startsWith('file://') ? dlUri.replace('file://', '') : dlUri;
        const hashIdx = path.indexOf('#');
        if (hashIdx !== -1) path = path.slice(0, hashIdx);
        const qIdx = path.indexOf('?');
        if (qIdx !== -1) path = path.slice(0, qIdx);
        try { path = decodeURI(path); } catch (e) {}
        return { hashTarget: path, tmpCopied: false, tmpUri: null, infoDownloaded };
      }
      // Try staging
      const resolved = await resolveReadableFilePath({ assetId: asset.id, assetInfo: infoDownloaded });
      if (resolved && resolved.filePath) {
        return { hashTarget: resolved.filePath, tmpCopied: resolved.tmpCopied || false, tmpUri: resolved.tmpUri || null, infoDownloaded };
      }
    } catch (e) {
      // Failed
    }
    return null;
  };
  
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
      // Need to stage to temp file
      try {
        const resolved = await resolveReadableFilePath({ assetId: asset.id, assetInfo: info });
        hashTarget = resolved && resolved.filePath ? resolved.filePath : null;
        tmpCopied = resolved && resolved.tmpCopied ? resolved.tmpCopied : false;
        tmpUri = resolved && resolved.tmpUri ? resolved.tmpUri : null;
      } catch (e) {
        // iOS fallback: try with shouldDownloadFromNetwork
        const iosResult = await tryIosDownload();
        if (iosResult) {
          hashTarget = iosResult.hashTarget;
          tmpCopied = iosResult.tmpCopied;
          tmpUri = iosResult.tmpUri;
        }
      }
    } else {
      // Unknown URI scheme - try iOS download fallback
      const iosResult = await tryIosDownload();
      if (iosResult) {
        hashTarget = iosResult.hashTarget;
        tmpCopied = iosResult.tmpCopied;
        tmpUri = iosResult.tmpUri;
      }
    }
  } else {
    // No rawUri at all - iOS often returns null localUri for iCloud photos
    // Try to get it with shouldDownloadFromNetwork
    const iosResult = await tryIosDownload();
    if (iosResult) {
      hashTarget = iosResult.hashTarget;
      tmpCopied = iosResult.tmpCopied;
      tmpUri = iosResult.tmpUri;
    }
  }
  
  return { hashTarget, tmpCopied, tmpUri, rawUri };
};

/**
 * Checks if an asset is an image based on mediaType or filename.
 * @param {Object} info - Asset info
 * @param {Object} asset - Asset object
 * @returns {boolean}
 */
const isImageAsset = (info, asset) => {
  const mt = (info && info.mediaType) || asset.mediaType;
  if (mt === 'photo' || mt === 'image') return true;
  const name = (info && info.filename) || asset.filename || '';
  return /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?|raw|cr2|nef|arw|dng|orf|rw2|pef|srw|raf|psd|psb|exr|hdr|avif)$/i.test(name);
};

const RELIABLE_VISUAL_HASH_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif']);
const IOS_RELIABLE_VISUAL_HASH_EXTS = new Set(['dng']);

const getVisualHashFilename = (filePath, info, asset) => {
  const named = (info && info.filename) || asset?.filename || '';
  if (named) return named;
  if (!filePath || typeof filePath !== 'string') return '';
  let normalized = filePath;
  if (normalized.startsWith('file://')) normalized = normalized.replace('file://', '');
  const hashIdx = normalized.indexOf('#');
  if (hashIdx !== -1) normalized = normalized.slice(0, hashIdx);
  const qIdx = normalized.indexOf('?');
  if (qIdx !== -1) normalized = normalized.slice(0, qIdx);
  const base = normalized.split('/').pop() || '';
  try { return decodeURI(base); } catch (e) { return base; }
};

const isReliablyPerceptualHashable = (filePath, asset = null, info = null) => {
  const mt = (info && info.mediaType) || asset?.mediaType || null;
  if (mt === 'video') return false;
  if (asset || info) {
    if (!isImageAsset(info || null, asset || {})) return false;
  }
  const filename = getVisualHashFilename(filePath, info, asset);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (RELIABLE_VISUAL_HASH_EXTS.has(ext)) return true;
  if (Platform.OS === 'ios' && IOS_RELIABLE_VISUAL_HASH_EXTS.has(ext)) return true;
  return false;
};

/**
 * Checks if an asset is a video based on mediaType or filename.
 * @param {Object} info - Asset info
 * @param {Object} asset - Asset object
 * @returns {boolean}
 */
const isVideoAsset = (info, asset) => {
  const mt = (info && info.mediaType) || asset.mediaType;
  if (mt === 'video') return true;
  const name = (info && info.filename) || asset.filename || '';
  return SUPPORTED_VIDEO_RE.test(name);
};

/**
 * Collects all photo assets from device, including all albums.
 * @param {Object} options - Options
 * @param {boolean} options.includeVideos - Whether to include videos (default: false for backward compat)
 * @returns {Promise<Array>} Array of assets
 */
export const collectAllPhotoAssets = async (options = {}) => {
  const { includeVideos = false, onProgress } = options;
  const allAssetsArray = [];
  const seenIds = new Set();
  
  const mediaTypes = includeVideos ? ['photo', 'video'] : ['photo'];
  
  // Get estimated total count first for progress calculation
  let estimatedTotal = 0;
  try {
    const countPage = await MediaLibrary.getAssetsAsync({ first: 1, mediaType: mediaTypes });
    estimatedTotal = countPage?.totalCount || 1000;
  } catch (e) {
    estimatedTotal = 1000;
  }

  if (Platform.OS === 'android' && estimatedTotal > 0) {
    estimatedTotal = Math.max(0, estimatedTotal - 1);
  }
  
  // Show initial progress
  if (onProgress) onProgress({ collected: 0, estimated: estimatedTotal, message: `Collecting 0/${estimatedTotal} items...` });
  
  // First get assets without album filter (main camera roll)
  let mainAssets = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    mainAssets = await MediaLibrary.getAssetsAsync({
      first: 10000,
      mediaType: mediaTypes,
    });
    if (mainAssets && mainAssets.assets && mainAssets.assets.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (mainAssets && mainAssets.assets) {
    for (const asset of mainAssets.assets) {
      if (!seenIds.has(asset.id)) {
        seenIds.add(asset.id);
        allAssetsArray.push(asset);
      }
    }
  }
  
  // Yield to UI after main collection
  await new Promise(r => setTimeout(r, 16));
  if (onProgress) onProgress({ collected: allAssetsArray.length, estimated: estimatedTotal, message: `Collecting ${allAssetsArray.length}/${estimatedTotal} items...` });
  
  // Scan all albums to catch Screenshots, Downloads, WhatsApp, etc.
  try {
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    for (let i = 0; i < albums.length; i++) {
      const album = albums[i];
      
      // Skip PhotoLynkDeleted album to avoid scanning deleted duplicates
      if (album.title === 'PhotoLynkDeleted') {
        continue;
      }
      
      try {
        const albumAssets = await MediaLibrary.getAssetsAsync({
          first: 5000,
          album: album.id,
          mediaType: mediaTypes,
        });
        if (albumAssets && albumAssets.assets) {
          for (const asset of albumAssets.assets) {
            if (!seenIds.has(asset.id)) {
              seenIds.add(asset.id);
              allAssetsArray.push(asset);
            }
          }
        }
        // Yield to UI every few albums
        if (i % 3 === 0) {
          await new Promise(r => setTimeout(r, 16));
          if (onProgress) onProgress({ collected: allAssetsArray.length, estimated: Math.max(estimatedTotal, allAssetsArray.length), message: `Collecting ${allAssetsArray.length} items...` });
        }
      } catch (e) {
        // Skip albums that fail
      }
    }
  } catch (e) {
    console.log('DuplicateScanner: Could not scan albums:', e?.message || e);
  }
  
  return allAssetsArray;
};

/**
 * Scans for exact duplicate photos/videos using pixel-based hashing (images) or file hash (videos).
 * 
 * @param {Object} params
 * @param {Array} params.assets - Array of assets to scan
 * @param {Function} params.resolveReadableFilePath - Function to resolve readable file path
 * @param {Function} params.onProgress - Progress callback (hashedCount, totalCount, lastHash)
 * @param {boolean} params.includeVideos - Whether to include videos in scan (default: false)
 * @returns {Promise<{duplicateGroups: Array, stats: Object}>}
 */
export const scanExactDuplicates = async ({ assets, resolveReadableFilePath, onProgress, abortRef, includeVideos = false }) => {
  console.log('DuplicateScanner: Starting exact duplicate scan with pixel hashing (images) and file hash (videos)');
  
  // Check if PixelHash native module is available (required for images)
  const hasPixelHash = PixelHash && typeof PixelHash.hashImagePixels === 'function';
  if (!hasPixelHash) {
    console.warn('PixelHash native module not available - will only scan videos with file hash');
  }
  
  const allHashedItems = []; // Collect all items with hashes for Union-Find clustering
  let hashedCount = 0;
  let inspectFailed = 0;
  let hashSkipped = 0;
  let skippedNoUri = 0;
  let hashFailed = 0;
  let videoCount = 0;
  let photoCount = 0;
  const sampleSkipped = [];

  // Show initial progress immediately
  if (onProgress) onProgress(0, assets.length, '');
  
  for (let i = 0; i < assets.length; i++) {
    // Check abort signal
    if (abortRef && abortRef.current) {
      console.log('DuplicateScanner: Exact duplicate scan aborted by user');
      return { duplicateGroups: [], stats: {}, aborted: true };
    }

    const asset = assets[i];
    let info;
    try {
      // On iOS, request download from network to get local file
      info = Platform.OS === 'ios' 
        ? await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true })
        : await MediaLibrary.getAssetInfoAsync(asset.id);
      
      // Debug: log first few assets to see if iCloud download worked
      if (hashedCount < 5 && Platform.OS === 'ios') {
        const ext = (info?.filename || '').split('.').pop()?.toLowerCase() || '';
        console.log('[DupScanner] iOS asset info:', {
          filename: info?.filename,
          ext,
          localUri: info?.localUri ? info.localUri.substring(0, 60) + '...' : 'null',
          uri: info?.uri ? info.uri.substring(0, 60) + '...' : 'null',
          width: info?.width,
          height: info?.height,
          mediaSubtypes: info?.mediaSubtypes, // Live Photo detection
        });
      }
    } catch (e) {
      inspectFailed++;
      continue;
    }

    const isVideo = isVideoAsset(info, asset);
    const isImage = isImageAsset(info, asset);

    // Skip if not image or video
    if (!isImage && !isVideo) {
      hashSkipped++;
      if (sampleSkipped.length < 5) {
        sampleSkipped.push({ filename: info?.filename || asset.filename, reason: 'not an image or video' });
      }
      continue;
    }

    // Skip videos if not requested
    if (isVideo && !includeVideos) {
      hashSkipped++;
      continue;
    }

    // Get a readable file path
    const { hashTarget, tmpCopied, tmpUri, rawUri } = await getHashTarget({ 
      asset, 
      info, 
      resolveReadableFilePath 
    });
    
    if (!hashTarget) {
      hashSkipped++;
      skippedNoUri++;
      if (sampleSkipped.length < 5 && !sampleSkipped.find(s => s.filename === (info?.filename || asset.filename))) {
        sampleSkipped.push({ filename: info?.filename || asset.filename, reason: 'no readable path', uri: rawUri || '' });
      }
      continue;
    }

    try {
      let fileHashHex = null;
      let dHashHex = null;
      
      const filename = info?.filename || asset.filename || '';
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const reliablePerceptual = isReliablyPerceptualHashable(hashTarget, asset, info);
      
      if (isVideo) {
        // Videos: use exact file hash (SHA-256) only
        fileHashHex = await computeExactFileHash(hashTarget);
        if (fileHashHex) {
          fileHashHex = 'video:' + fileHashHex;
          videoCount++;
        }
        if (hashedCount < 6 || videoCount <= 3) {
          console.log('[DupScanner] Video hash computed:', { filename, hashStart: fileHashHex ? fileHashHex.substring(0, 30) + '...' : 'none' });
        }
      } else if (hasPixelHash && reliablePerceptual) {
        // Images: use perceptual dHash only (catches visually identical photos)
        // dHash is resistant to compression, re-encoding, and minor edits
        try {
          const dHash = await PixelHash.hashImagePixels(hashTarget);
          if (dHash) {
            dHashHex = 'dhash:' + dHash;
            photoCount++;
          }
        } catch (e) {
          // dHash failed
        }

        // Log HEIC/HEIF files specifically + first few of any type
        if (hashedCount < 6 || (ext === 'heic' || ext === 'heif') && photoCount <= 10) {
          console.log('[DupScanner] Image dHash computed:', { 
            filename, ext, 
            dHash: dHashHex || 'none'
          });
        }
      } else {
        // Unsupported image formats fall back to exact file hash only
        fileHashHex = await computeExactFileHash(hashTarget);
        if (fileHashHex) {
          fileHashHex = 'imagefile:' + fileHashHex;
          photoCount++;
        }
      }

      hashedCount++;

      // Progress callback
      if (hashedCount % 10 === 0 && onProgress) {
        onProgress(hashedCount, assets.length, fileHashHex ? fileHashHex.substring(0, 12) : '');
      }

      // Group by BOTH hashes - an image can be in multiple groups
      // This allows matching by either file hash OR perceptual hash
      if (!fileHashHex && !dHashHex) {
        hashSkipped++;
        hashFailed++;
        if (sampleSkipped.length < 5) {
          sampleSkipped.push({ filename: info?.filename || asset.filename, reason: 'hash returned empty' });
        }
        continue;
      }
      
      // Store item with both hashes for later Union-Find grouping
      const rawDHash = dHashHex ? dHashHex.substring(6) : null;
      const rawFileHash = fileHashHex ? fileHashHex.substring(fileHashHex.indexOf(':') + 1) : null;
      
      allHashedItems.push({
        asset,
        info,
        fileHashHex,
        rawFileHash,
        rawDHash,
        isVideo: fileHashHex && fileHashHex.startsWith('video:'),
      });

    } catch (e) {
      hashSkipped++;
      hashFailed++;
      if (sampleSkipped.length < 5) {
        sampleSkipped.push({ filename: info?.filename || asset.filename, reason: 'hash failed: ' + (e?.message || e) });
      }
    } finally {
      // Clean up temp file if created
      if (tmpCopied && tmpUri) {
        try {
          await FileSystem.deleteAsync(tmpUri, { idempotent: true });
        } catch (e2) {
          // ignore
        }
      }
    }
  }

  console.log('DuplicateScanner: Scan complete', {
    totalAssets: assets.length,
    hashedCount,
    photoCount,
    videoCount,
    hashSkipped,
    hashFailed,
    inspectFailed,
    skippedNoUri,
    allHashedItems: allHashedItems.length,
    sampleSkipped: sampleSkipped.slice(0, 10) // Show first 10 skipped items with reasons
  });

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
        union(group[0].asset.id, group[i].asset.id);
      }
    }
  }

  // Fuzzy dHash comparison (O(n²) but only for images with dHash)
  const itemsWithDHash = allHashedItems.filter(item => item.rawDHash && !item.isVideo);
  let comparisons = 0;
  
  for (let i = 0; i < itemsWithDHash.length; i++) {
    for (let j = i + 1; j < itemsWithDHash.length; j++) {
      const dist = hammingDistance64(itemsWithDHash[i].rawDHash, itemsWithDHash[j].rawDHash);
      if (dist <= CROSS_PLATFORM_DHASH_THRESHOLD) {
        union(itemsWithDHash[i].asset.id, itemsWithDHash[j].asset.id);
      }
      comparisons++;
      // Thermal cooldown every 2000 comparisons to reduce heat
      if (comparisons % 2000 === 0) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  // Build groups from Union-Find
  const groupMap = new Map();
  for (const item of allHashedItems) {
    const root = find(item.asset.id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root).push(item);
  }

  // Convert to duplicate groups (only groups with >1 item)
  const duplicateGroups = [];
  for (const group of groupMap.values()) {
    if (group.length > 1) {
      // Sort by creation time (oldest first)
      group.sort((a, b) => {
        const aTime = a.info?.creationTime || a.asset.creationTime || 0;
        const bTime = b.info?.creationTime || b.asset.creationTime || 0;
        return aTime - bTime;
      });
      duplicateGroups.push(group);
      
      console.log('DuplicateScanner: Found duplicate group, size:', group.length, 
        'keeping oldest:', (group[0].info?.filename || group[0].asset.filename));
    }
  }

  console.log('DuplicateScanner: Union-Find complete', {
    itemsWithDHash: itemsWithDHash.length,
    comparisons,
    duplicateGroups: duplicateGroups.length,
  });

  return {
    duplicateGroups,
    stats: {
      totalAssets: assets.length,
      hashedCount,
      hashSkipped,
      hashFailed,
      inspectFailed,
      skippedNoUri,
      sampleSkipped
    }
  };
};

/**
 * Formats duplicate groups for review UI.
 * @param {Array} duplicateGroups - Array of duplicate groups
 * @returns {Array} Formatted review groups
 */
export const formatDuplicateGroupsForReview = (duplicateGroups) => {
  return duplicateGroups.map((group, idx) => {
    const sorted = [...group].sort((a, b) => {
      const at = a.info?.creationTime || a.asset.creationTime || 0;
      const bt = b.info?.creationTime || b.asset.creationTime || 0;
      return at - bt;
    });
    const items = sorted.map((it, itemIdx) => ({
      id: it.asset.id,
      filename: it.info?.filename || it.asset.filename || it.asset.id,
      created: it.info?.creationTime || it.asset.creationTime || 0,
      size: it.info?.fileSize || null,
      uri: it.info?.localUri || it.info?.uri || it.asset.uri || '',
      delete: itemIdx > 0 // keep oldest (index 0)
    }));
    return { type: 'exact', groupIndex: idx + 1, items };
  });
};

/**
 * Counts total duplicates (items to delete) from groups.
 * @param {Array} duplicateGroups - Array of duplicate groups
 * @returns {number} Total duplicate count
 */
export const countDuplicates = (duplicateGroups) => {
  let count = 0;
  duplicateGroups.forEach(group => {
    count += (group.length - 1); // Keep 1, delete rest
  });
  return count;
};

/**
 * Builds a summary note for when no duplicates are found.
 * @param {Object} stats - Stats from scanExactDuplicates
 * @returns {string} Summary note
 */
export const buildNoResultsNote = (stats) => {
  const noteParts = [];
  noteParts.push(`Analyzed ${stats.hashedCount} photos.`);
  if (stats.hashSkipped > 0) noteParts.push(`Skipped: ${stats.hashSkipped}`);
  if (stats.hashFailed > 0) noteParts.push(`Analysis failures: ${stats.hashFailed}`);
  if (stats.inspectFailed > 0) noteParts.push(`Asset-info failures: ${stats.inspectFailed}`);
  if (stats.sampleSkipped && stats.sampleSkipped.length > 0) {
    noteParts.push('Examples (max 3):');
    stats.sampleSkipped.slice(0, 3).forEach(s => {
      noteParts.push(`- ${s.filename}${s.reason ? ' — ' + s.reason : ''}`);
    });
  }
  return noteParts.length > 0 ? `\n${noteParts.join('\n')}` : '';
};

// ============================================================================
// SIMILAR PHOTOS - Main scanning function (simplified like image-hash library)
// ============================================================================

/**
 * Scans for similar photos/videos using perceptual hash (images) + file hash (videos) + time proximity.
 * Detects burst shots: same scene, slight differences (hand moved, posture, emotion, wind, etc.)
 * For videos: detects exact duplicates (same file hash)
 * 
 * @param {Object} params
 * @param {Function} params.resolveReadableFilePath - Function to resolve readable file path
 * @param {Function} params.onProgress - Progress callback (current, total, status)
 * @param {boolean} params.includeVideos - Whether to include videos (default: false)
 * @returns {Promise<Array>} Array of similar photo/video groups (each group is array of assets)
 */
export const scanSimilarPhotos = async ({ resolveReadableFilePath, onProgress, onFindingMatches, onCollecting, abortRef, includeVideos = false }) => {
  console.log('DuplicateScanner: Starting similar photos/videos scan...');
  
  // Check if PixelHash native module is available (required for images)
  const hasPixelHash = PixelHash && typeof PixelHash.hashImagePixels === 'function';
  if (!hasPixelHash) {
    console.warn('PixelHash native module not available - will only scan videos with file hash');
  }
  
  // Notify collecting phase started
  if (onCollecting) onCollecting();
  
  const MAX_SCAN = 2000;
  let after = null;
  let scanned = 0;
  let all = [];
  
  const mediaTypes = includeVideos ? ['photo', 'video'] : ['photo'];
  
  // Get estimated total for progress calculation
  let estimatedTotal = MAX_SCAN;
  try {
    const countPage = await MediaLibrary.getAssetsAsync({ first: 1, mediaType: mediaTypes });
    estimatedTotal = Math.min(countPage?.totalCount || MAX_SCAN, MAX_SCAN);
  } catch (e) {
    // Use MAX_SCAN as fallback
  }

  if (Platform.OS === 'android' && estimatedTotal > 0) {
    estimatedTotal = Math.max(0, estimatedTotal - 1);
  }
  
  // Show initial collecting progress
  if (onProgress) onProgress(0, estimatedTotal, `Collecting 0/${estimatedTotal} items...`);

  while (scanned < MAX_SCAN) {
    // Check abort signal
    if (abortRef && abortRef.current) {
      console.log('DuplicateScanner: Similar photos scan aborted by user');
      return [];
    }
    const page = await MediaLibrary.getAssetsAsync({
      first: Math.min(500, MAX_SCAN - scanned),
      after: after || undefined,
      mediaType: mediaTypes,
    });
    const assets = page && Array.isArray(page.assets) ? page.assets : [];
    all = all.concat(assets);
    scanned += assets.length;
    after = page && page.endCursor ? page.endCursor : null;
    
    // Yield to UI thread and update progress during collection (collecting is ~10% of total)
    await new Promise(r => setTimeout(r, 16));
    const collectProgress = estimatedTotal > 0 ? Math.min(scanned / estimatedTotal, 1) : 0;
    if (onProgress) onProgress(collectProgress * 0.1, 1, `Collecting ${scanned}/${Math.min(estimatedTotal, page?.totalCount || estimatedTotal)} items...`);
    
    if (!page || page.hasNextPage !== true) break;
    if (assets.length === 0) break;
  }

  console.log('DuplicateScanner: Loaded', all.length, 'photos/videos for similar scan');

  // Filter and sort by creation time (important for burst detection)
  all = all.filter(a => a && a.id && typeof a.creationTime === 'number');
  all.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));

  // Compute perceptual hash for photos, file hash for videos
  const items = [];
  let hashed = 0;
  let hashFailed = 0;
  let videoCount = 0;
  let photoCount = 0;

  // Show initial progress immediately (10% already filled from collecting phase)
  // Analyzing phase is 10-95% of total progress
  if (onProgress) onProgress(0.1, 1, `Analyzing 1/${all.length} items...`);
  
  for (let i = 0; i < all.length; i++) {
    // Check abort signal
    if (abortRef && abortRef.current) {
      console.log('DuplicateScanner: Similar photos scan aborted by user');
      return { groups: [], aborted: true };
    }

    const asset = all[i];
    // Update progress every 20 items (analyzing is 10-95% of total)
    if (i % 20 === 0 && onProgress) {
      const analyzeProgress = all.length > 0 ? (i / all.length) * 0.85 : 0;
      onProgress(0.1 + analyzeProgress, 1, `Analyzing ${i + 1}/${all.length} items...`);
    }
    
    let info = null;
    let hash = null;
    let edgeHash = null;
    let cornerHash = null;
    let isVideo = false;
    
    try {
      info = await MediaLibrary.getAssetInfoAsync(asset.id, Platform.OS === 'ios' ? { shouldDownloadFromNetwork: true } : undefined);
      
      isVideo = isVideoAsset(info, asset);
      const isImage = isImageAsset(info, asset);
      
      // Skip if neither image nor video
      if (!isImage && !isVideo) continue;
      
      const reliablePerceptual = isImage ? isReliablyPerceptualHashable(null, asset, info) : false;

      // Similar scan only supports reliably perceptual-hashable images
      if (isImage && (!hasPixelHash || !reliablePerceptual)) continue;

      // Get readable file path
      const { hashTarget, tmpCopied, tmpUri } = await getHashTarget({ 
        asset, 
        info, 
        resolveReadableFilePath 
      });

      if (hashTarget) {
        try {
          if (isVideo) {
            // Videos: use exact file hash (SHA-256)
            hash = await computeExactFileHash(hashTarget);
            if (hash) {
              hash = 'video:' + hash; // Prefix to identify as video hash
              videoCount++;
              hashed++;
            }
          } else if (hasPixelHash && reliablePerceptual) {
            // Images: use perceptual hash
            hash = await PixelHash.hashImagePixels(hashTarget);
            if (hash) {
              hash = 'image:' + hash; // Prefix to identify as image hash
              photoCount++;
              hashed++;
            }
            // Also compute edge hash (5% border from all 4 sides)
            if (PixelHash.hashImageEdges) {
              try {
                edgeHash = await PixelHash.hashImageEdges(hashTarget);
              } catch (e) {
                // Edge hash is optional, continue without it
              }
            }
            // Also compute corner hash (4 corners, grayscale)
            if (PixelHash.hashImageCorners) {
              try {
                cornerHash = await PixelHash.hashImageCorners(hashTarget);
              } catch (e) {
                // Corner hash is optional, continue without it
              }
            }
          }
        } catch (e) {
          hashFailed++;
        } finally {
          if (tmpCopied && tmpUri) {
            try { await FileSystem.deleteAsync(tmpUri, { idempotent: true }); } catch (e2) {}
          }
        }
      }
    } catch (e) {
      hashFailed++;
    }
    
    if (hash) {
      // Extract EXIF capture time (actual photo taken time) instead of file system creation time
      // This prevents false positives when photos are copied to device (all get same fs creation time)
      const exifData = extractExifForDedup(info, asset);
      let captureTs = asset.creationTime || 0;
      let hasExifTime = false;
      if (exifData.captureTime) {
        const parsed = Date.parse(exifData.captureTime);
        if (!isNaN(parsed)) {
          captureTs = parsed;
          hasExifTime = true;
        }
      }
      
      items.push({
        asset,
        info,
        hash,
        isVideo,
        edgeHash: edgeHash || null,
        cornerHash: cornerHash || null,
        createdTs: captureTs,
        hasExifTime, // Track if we have reliable EXIF timestamp
        filename: (info && info.filename) || asset.filename || '',
      });
    }
  }

  console.log('DuplicateScanner: Similar hash summary', { total: all.length, hashed, photoCount, videoCount, hashFailed });
  
  // Debug: log first 5 items with their hashes and timestamps
  if (items.length > 0) {
    console.log('[SimilarScan] First 5 items with hashes:');
    items.slice(0, 5).forEach((it, idx) => {
      console.log(`  [${idx}] ${it.filename}: hash=${it.hash?.substring(0, 20)}..., ts=${it.createdTs}, isVideo=${it.isVideo}`);
    });
  }
  
  if (onFindingMatches) onFindingMatches();
  if (onProgress) onProgress(all.length, all.length, 'Finding similar groups...');

  // Find similar pairs using hamming distance + time proximity + edge matching
  // Similar shots: same lighting/colors but slight differences (hand moved, posture, emotion, wind, leaves, water)
  // Videos: exact hash match only (no fuzzy matching)
  const similarPairs = [];
  const seen = new Set();

  console.log(`[SimilarScan] Starting comparison loop with ${items.length} items`);
  let comparisonCount = 0;
  
  for (let i = 0; i < items.length; i++) {
    // Check abort signal in comparison loop
    if (abortRef && abortRef.current) {
      console.log('DuplicateScanner: Similar photos comparison aborted by user');
      return { groups: [], aborted: true };
    }
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      comparisonCount++;
      
      // Videos: only match if exact same hash (both must be videos with same file hash)
      if (a.isVideo || b.isVideo) {
        // Both must be videos with exact same hash
        if (a.isVideo && b.isVideo && a.hash === b.hash) {
          const key = [a.asset.id, b.asset.id].sort().join('|');
          if (!seen.has(key)) {
            seen.add(key);
            similarPairs.push({ a, b, dist: 0, dt: 0, edgeDist: 0, edgesMatch: true, cornerDist: 0, cornersMatch: true, isVideoMatch: true });
            if (similarPairs.length <= 5) {
              console.log('DuplicateScanner: Video duplicate found', {
                aName: a.filename,
                bName: b.filename,
              });
            }
          }
        }
        continue; // Skip fuzzy matching for videos
      }
      
      // Images: use perceptual hash comparison with fuzzy matching
      // Extract the actual hash (remove 'image:' prefix)
      const aHash = a.hash.startsWith('image:') ? a.hash.substring(6) : a.hash;
      const bHash = b.hash.startsWith('image:') ? b.hash.substring(6) : b.hash;
      
      // Time difference
      const dt = Math.abs((b.createdTs || 0) - (a.createdTs || 0));
      
      // Hamming distance between 64-bit dHash (16-char hex from native module)
      const dist = hammingDistance64(aHash, bHash);
      
      // Debug: log first 30 comparisons to see what's happening
      if (comparisonCount <= 30) {
        console.log(`[SimilarScan] #${comparisonCount} ${a.filename} vs ${b.filename}: dist=${dist}, dt=${Math.round(dt/1000)}s, exif=${a.hasExifTime && b.hasExifTime}`);
      }
      
      // Determine threshold based on time proximity (scaled for 64-bit dHash)
      // More lenient for burst shots, stricter for photos taken far apart
      const bothHaveExif = a.hasExifTime && b.hasExifTime;
      
      let threshold;
      if (bothHaveExif) {
        // Both have reliable EXIF timestamps - use full time-based thresholds
        if (dt <= 5000) {
          // Within 5 seconds - burst shots
          threshold = 24;
        } else if (dt <= 30000) {
          // Within 30 seconds
          threshold = 18;
        } else if (dt <= 60000) {
          // Within 1 minute
          threshold = 12;
        } else {
          // More than 1 minute apart
          threshold = 6;
        }
      } else {
        // No EXIF - use system timestamp with stricter fallback thresholds
        if (dt <= 5000) {
          // Within 5 seconds
          threshold = 12;
        } else if (dt <= 30000) {
          // Within 30 seconds
          threshold = 9;
        } else if (dt <= 60000) {
          // Within 1 minute
          threshold = 6;
        } else {
          // More than 1 minute apart
          threshold = 3;
        }
      }
      
      // Debug: log threshold decisions for first few low-distance pairs
      if (dist <= 15 && similarPairs.length < 20) {
        console.log(`[SimilarScan] ${a.filename} vs ${b.filename}: dist=${dist}, threshold=${threshold}, bothExif=${bothHaveExif}, dt=${Math.round(dt/1000)}s, ${dist <= threshold ? 'MATCH' : 'SKIP'}`);
      }
      
      if (dist > threshold) continue;
      
      const key = [a.asset.id, b.asset.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      
      similarPairs.push({ a, b, dist, dt });
      
      if (similarPairs.length <= 5) {
        console.log('DuplicateScanner: Similar pair found', {
          dist,
          dt: Math.round(dt / 1000) + 's',
          threshold,
          aName: a.filename,
          bName: b.filename
        });
      }
    }
  }
  
  console.log('DuplicateScanner: Found', similarPairs.length, 'similar pairs');

  // Union-Find clustering to group all connected similar photos
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
  
  const assetMap = new Map();
  for (const item of items) { assetMap.set(item.asset.id, item.asset); }
  
  for (const pair of similarPairs) { union(pair.a.asset.id, pair.b.asset.id); }
  
  const groupMap = new Map();
  for (const pair of similarPairs) {
    const rootA = find(pair.a.asset.id);
    if (!groupMap.has(rootA)) groupMap.set(rootA, new Set());
    groupMap.get(rootA).add(pair.a.asset.id);
    groupMap.get(rootA).add(pair.b.asset.id);
  }
  
  const finalGroups = [];
  for (const [root, idSet] of groupMap) {
    const group = [];
    for (const id of idSet) {
      const asset = assetMap.get(id);
      if (asset) group.push(asset);
    }
    if (group.length >= 2) {
      // Sort by creation time (oldest first - keep oldest, delete newer)
      group.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));
      finalGroups.push(group);
    }
  }
  
  // Sort groups by size (largest first)
  finalGroups.sort((a, b) => b.length - a.length);
  console.log('DuplicateScanner: Final similar groups:', finalGroups.length);
  return { groups: finalGroups, aborted: false };
};

// ============================================================================
// DELETE ASSETS HELPER
// ============================================================================

/**
 * Deletes assets using native MediaDelete on Android, MediaLibrary on iOS.
 * @param {Array<string>} ids - Array of asset IDs to delete
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
export const deleteAssets = async (ids) => {
  if (!ids || ids.length === 0) {
    return { success: true, deleted: 0 };
  }
  
  try {
    if (Platform.OS === 'android' && MediaDelete && typeof MediaDelete.deleteAssets === 'function') {
      console.log('DuplicateScanner: Using native MediaDelete for', ids.length, 'items');
      const result = await MediaDelete.deleteAssets(ids);
      if (result === true) {
        return { success: true, deleted: ids.length };
      } else {
        return { success: false, deleted: 0 };
      }
    } else {
      // iOS or fallback
      const result = await MediaLibrary.deleteAssetsAsync(ids);
      if (result === true || typeof result === 'undefined') {
        return { success: true, deleted: ids.length };
      } else {
        return { success: false, deleted: 0 };
      }
    }
  } catch (e) {
    console.log('DuplicateScanner: Delete error', e?.message || e);
    throw e;
  }
};

export default {
  collectAllPhotoAssets,
  scanExactDuplicates,
  scanSimilarPhotos,
  formatDuplicateGroupsForReview,
  countDuplicates,
  buildNoResultsNote,
  deleteAssets
};
