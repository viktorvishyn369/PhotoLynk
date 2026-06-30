// PhotoLynk Mobile App - Utility Functions

// Sleep helper
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry with exponential backoff (capped at maxDelayMs)
export const withRetries = async (fn, { retries, baseDelayMs, shouldRetry, maxDelayMs = 30000 }) => {
  const n = Math.max(0, Number(retries) || 0);
  const base = Math.max(0, Number(baseDelayMs) || 0);
  const maxDelay = Math.max(base, Number(maxDelayMs) || 30000);
  let lastErr = null;
  for (let attempt = 0; attempt <= n; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const ok = attempt < n && (typeof shouldRetry === 'function' ? shouldRetry(e) : true);
      if (!ok) break;
      // Exponential backoff with jitter, capped at maxDelay
      const expDelay = base * Math.pow(2, attempt);
      const jitter = Math.random() * 0.3 * expDelay; // 0-30% jitter
      const delay = Math.min(expDelay + jitter, maxDelay);
      await sleep(delay);
    }
  }
  throw lastErr;
};

// Check if chunk upload error is retryable - very aggressive, retry almost everything
export const shouldRetryChunkUpload = (e) => {
  const msg = (e && e.message ? e.message : '').toLowerCase();
  // Only give up on authentication errors (401/403) or permanent client errors (400)
  if (msg.includes(' 401') || msg.includes(' 403') || msg.includes('unauthorized') || msg.includes('forbidden')) return false;
  if (msg.includes(' 400') && !msg.includes('timeout')) return false;
  // Retry everything else: network issues, server errors, timeouts, etc.
  return true;
};

// Normalize file path (strip file:// prefix and query params)
export const normalizeFilePath = (uri) => {
  if (!uri || typeof uri !== 'string') return null;
  let s = uri;
  if (s.startsWith('file://')) s = s.replace('file://', '');
  s = s.split('#')[0];
  s = s.split('?')[0];
  return s;
};

// Create chunk nonce from base nonce and chunk index
export const makeChunkNonce = (baseNonce16, chunkIndex) => {
  const nonce = new Uint8Array(24);
  nonce.set(baseNonce16, 0);
  let x = BigInt(chunkIndex);
  for (let i = 0; i < 8; i++) {
    nonce[16 + i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return nonce;
};

// Sanitize headers object (remove null/undefined values)
export const sanitizeHeaders = (headers) => {
  const out = {};
  const src = headers && typeof headers === 'object' ? headers : {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
};

// Strip Content-Type header
export const stripContentType = (headers) => {
  const out = { ...(headers || {}) };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === 'content-type') delete out[k];
  }
  return out;
};

// Normalize host input (strip protocol, port, path)
export const normalizeHostInput = (value) => {
  const raw = (value || '').trim();
  if (!raw) return '';
  let cleaned = raw.replace(/^https?:\/\//i, '');
  cleaned = cleaned.split('/')[0].split('?')[0].split('#')[0].replace(/:\d+$/, '');
  return cleaned;
};

// Compute server URL from type and host values
export const computeServerUrl = (type, localHostValue, remoteHostValue) => {
  const PORT = '3000';
  if (type === 'stealthcloud') return 'https://stealthlynk.io';
  const rawRemote = (remoteHostValue || '').trim();
  const remoteProtocol = /^https:\/\//i.test(rawRemote)
    ? 'https'
    : /^http:\/\//i.test(rawRemote)
      ? 'http'
      : 'https'; // default to HTTPS for domain hosts
  const host = normalizeHostInput(type === 'remote' ? remoteHostValue : localHostValue);
  if (type === 'remote') {
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host || '');
    const proto = isIpv4 ? 'http' : remoteProtocol;
    // For domain+HTTPS, omit :3000 (use 443). For IP or HTTP, keep port.
    if (proto === 'https' && !isIpv4) {
      return host ? `${proto}://${host}` : `${proto}://localhost`;
    }
    return host ? `${proto}://${host}:${PORT}` : `${proto}://localhost:${PORT}`;
  }
  return `http://${host || 'localhost'}:${PORT}`;
};

// Format bytes to human readable (MB/GB/TB)
export const formatBytes = (bytes, decimal = false) => {
  const n = typeof bytes === 'number' ? bytes : (bytes ? Number(bytes) : 0);
  if (!n || Number.isNaN(n) || n <= 0) return '0 MB';
  const divisor = decimal ? 1000 : 1024;
  const mb = n / (divisor * divisor);
  if (mb < divisor) return `${mb.toFixed(2)} MB`;
  const gb = mb / divisor;
  if (gb < divisor) return `${gb.toFixed(2)} GB`;
  const tb = gb / divisor;
  return `${tb.toFixed(2)} TB`;
};

// Normalize filename for comparison
export const normalizeFilenameForCompare = (name) => {
  if (!name || typeof name !== 'string') return null;
  const raw = name.split('?')[0].split('#')[0];
  const parts = raw.split('/');
  let base = parts.length ? parts[parts.length - 1] : raw;
  if (base && typeof base === 'string' && base.indexOf('%') !== -1) {
    try { base = decodeURIComponent(base); } catch (e) {}
  }
  if (base && typeof base === 'string' && typeof base.normalize === 'function') {
    try { base = base.normalize('NFC'); } catch (e) {}
  }
  const trimmed = base.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
};

export const formatFilenameForStatus = (name, maxLen = 32) => {
  const max = Math.max(10, Number(maxLen) || 32);
  const raw = name == null ? '' : String(name);
  const s = raw.split('?')[0].split('#')[0];
  const parts = s.split('/');
  const base = (parts.length ? parts[parts.length - 1] : s).trim();
  if (!base) return 'file';
  if (base.length <= max) return base;

  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0 && (base.length - dot) <= 8;
  const ext = hasExt ? base.slice(dot) : '';
  const core = hasExt ? base.slice(0, dot) : base;

  const room = max - ext.length - 3;
  const front = Math.max(6, Math.floor(room * 0.6));
  const back = Math.max(3, room - front);
  return `${core.slice(0, front)}...${core.slice(-back)}${ext}`;
};

// Check if value is a Seeker ID (.skr domain or plain username)
export const isSeekerIdFormat = (value) => {
  if (!value) return false;
  const trimmed = String(value).trim().toLowerCase();
  if (trimmed.includes('@')) return false;
  if (trimmed.endsWith('.skr')) return true;
  const nicknamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,28}[a-zA-Z0-9]$/;
  return nicknamePattern.test(trimmed);
};

// Just lowercase the input - keep as-is
export const normalizeSeekerIdForStorage = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim().toLowerCase();
  return trimmed || null;
};

// Convert email / nickname / Seeker ID to display format: alice.skr
export const emailToSeekerId = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.endsWith('.skr')) return trimmed;
  if (trimmed.includes('@')) {
    const local = trimmed.split('@')[0];
    return local ? local + '.skr' : null;
  }
  return trimmed + '.skr';
};

// Sanitize a string for use as an expo-secure-store key.
// Android SecureStore only allows alphanumeric characters, ".", "-", and "_".
// We replace common illegal chars: ":" → "_", "@" → "_at_", and any other
// non-allowed char → "_".
export const sanitizeStoreKey = (key) => {
  if (!key) return key;
  return String(key)
    .replace(/@/g, '_at_')
    .replace(/:/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
};

// Normalize for device UUID - just lowercase, keep as-is
export const normalizeEmailForDeviceUuid = (value) => {
  const raw = value == null ? '' : String(value);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
};

// Compute a stable cross-device file identity string from filename and size
// This is used to generate manifestId that is the same across iOS/Android for the same file
export const computeFileIdentity = (filename, originalSize) => {
  const normalizedFilename = normalizeFilenameForCompare(filename);
  if (!normalizedFilename) return null;
  const sizeStr = typeof originalSize === 'number' && !Number.isNaN(originalSize) ? String(originalSize) : '';
  return `${normalizedFilename}:${sizeStr}`;
};

// Check if a URL is valid
export const isValidUrl = (string) => {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
};

// Detect real file format from magic bytes and fix extension if mismatched
// Android sometimes reports screenshots as .jpg when they're actually PNG
export const detectRealFormatFromMagic = async (filePath, filename) => {
  try {
    const FileSystem = require('expo-file-system');
    // Read first 12 bytes to detect format
    const base64 = await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.Base64,
      length: 12,
      position: 0,
    });
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    
    // Magic byte signatures
    const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
    const isJPEG = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    const isGIF = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
    const isWEBP = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
                   bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    const isBMP = bytes[0] === 0x42 && bytes[1] === 0x4D;
    // HEIC/HEIF: ftyp box with heic/heix/hevc/mif1 brand
    const isFTYP = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    
    const ext = (filename || '').split('.').pop()?.toLowerCase();
    let correctedFilename = filename;
    
    if (isPNG && ext !== 'png') {
      correctedFilename = filename.replace(/\.[^.]+$/, '.png');
      console.log(`[Format] Corrected ${filename} -> ${correctedFilename} (PNG magic bytes)`);
    } else if (isJPEG && ext !== 'jpg' && ext !== 'jpeg') {
      correctedFilename = filename.replace(/\.[^.]+$/, '.jpg');
      console.log(`[Format] Corrected ${filename} -> ${correctedFilename} (JPEG magic bytes)`);
    } else if (isGIF && ext !== 'gif') {
      correctedFilename = filename.replace(/\.[^.]+$/, '.gif');
      console.log(`[Format] Corrected ${filename} -> ${correctedFilename} (GIF magic bytes)`);
    } else if (isWEBP && ext !== 'webp') {
      correctedFilename = filename.replace(/\.[^.]+$/, '.webp');
      console.log(`[Format] Corrected ${filename} -> ${correctedFilename} (WEBP magic bytes)`);
    } else if (isBMP && ext !== 'bmp') {
      correctedFilename = filename.replace(/\.[^.]+$/, '.bmp');
      console.log(`[Format] Corrected ${filename} -> ${correctedFilename} (BMP magic bytes)`);
    }
    // Don't correct HEIC - it's complex and usually correct
    
    return correctedFilename;
  } catch (e) {
    // If detection fails, return original filename
    return filename;
  }
};

// MIME type detection from filename (case-insensitive)
export const getMimeFromFilename = (filename, fallbackMediaType) => {
  const ext = (filename || '').split('.').pop()?.toLowerCase();
  const mimeMap = {
    // Photos
    'heic': 'image/heic', 'heif': 'image/heif',
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
    'png': 'image/png', 'gif': 'image/gif',
    'webp': 'image/webp', 'tiff': 'image/tiff', 'tif': 'image/tiff',
    'bmp': 'image/bmp', 'ico': 'image/x-icon',
    'svg': 'image/svg+xml', 'avif': 'image/avif',
    // RAW formats
    'raw': 'image/raw', 'dng': 'image/dng',
    'cr2': 'image/x-canon-cr2', 'cr3': 'image/x-canon-cr3',
    'nef': 'image/x-nikon-nef', 'nrw': 'image/x-nikon-nrw',
    'arw': 'image/x-sony-arw', 'srf': 'image/x-sony-srf',
    'orf': 'image/x-olympus-orf', 'pef': 'image/x-pentax-pef',
    'raf': 'image/x-fuji-raf', 'rw2': 'image/x-panasonic-rw2',
    'srw': 'image/x-samsung-srw', 'x3f': 'image/x-sigma-x3f',
    // Videos
    'mp4': 'video/mp4', 'mov': 'video/quicktime',
    'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska',
    'm4v': 'video/x-m4v', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
    'webm': 'video/webm', 'wmv': 'video/x-ms-wmv',
    'flv': 'video/x-flv', 'mpg': 'video/mpeg', 'mpeg': 'video/mpeg',
    'mts': 'video/mp2t', 'm2ts': 'video/mp2t',
  };
  if (mimeMap[ext]) return mimeMap[ext];
  return fallbackMediaType === 'video' ? 'video/mp4' : 'application/octet-stream';
};
