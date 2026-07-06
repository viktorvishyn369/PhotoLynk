#!/usr/bin/env node
/**
 * PhotoLynk Recovery Script
 * ========================
 * Standalone CLI tool for users to recover their encrypted files from
 * StealthCloud without revealing their encryption key to anyone.
 *
 * The user runs this script on their own computer. They provide:
 * - Server URL (e.g. https://stealthlynk.io)
 * - Their login email + password (same as app login)
 * - Their master encryption key (exported from Settings, optional if password is provided)
 *
 * The script authenticates, downloads encrypted chunks, decrypts them locally,
 * and writes the original files to disk. The admin never sees the key.
 *
 * Usage:
 *   node photolynk-recover.js \
 *     --server https://stealthlynk.io \
 *     --email user@seeker.photolynk.local \
 *     --password <password> \
 *     --master-key <base64_key_from_settings> \
 *     --output ./recovered-files
 *
 * For wallet users:
 *   Email:    walletAddress@seeker.photolynk.local
 *   Password: either legacy (SHA-512 of address+salt) or secure (from wallet signature)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2).replace(/-/g, '_');
    const next = arr[i + 1];
    acc[key] = next && !next.startsWith('--') ? next : 'true';
  }
  return acc;
}, {});

const SERVER_URL = args.server;
const EMAIL = args.email;
const PASSWORD = args.password;
const MASTER_KEY_B64 = args.master_key;
const LEGACY_KEY_B64 = args.legacy_master_key;
const OUTPUT_DIR = args.output || './photolynk-recovered';

if (!SERVER_URL || !EMAIL) {
  console.error(`
PhotoLynk Recovery Script
=========================

Required:
  --server     StealthCloud server URL (e.g. https://stealthlynk.io)
  --email      Your PhotoLynk login email
  --password   Your login password (or omit if using --master-key with manual auth)

Optional:
  --master-key        Base64 master key exported from Settings (secure signature-derived key)
  --legacy-master-key Base64 legacy key for old files (public-address-derived key)
  --output            Output directory (default: ./photolynk-recovered)

For wallet users, your email is: <walletAddress>@seeker.photolynk.local
Your password can be the legacy public-address-derived one or the secure signature-derived one.
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Crypto primitives (TweetNaCl-compatible)
// ---------------------------------------------------------------------------

// PBKDF2-HMAC-SHA256
function pbkdf2Sha256(password, salt, iterations, keyLen) {
  const passwordBytes = typeof password === 'string' ? Buffer.from(password, 'utf8') : Buffer.from(password);
  const saltBytes = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : Buffer.from(salt);

  const hmacSha256 = (key, data) => {
    const blockSize = 64;
    let keyBuf = Buffer.from(key);
    if (keyBuf.length > blockSize) {
      keyBuf = crypto.createHash('sha256').update(keyBuf).digest();
    }
    if (keyBuf.length < blockSize) {
      keyBuf = Buffer.concat([keyBuf, Buffer.alloc(blockSize - keyBuf.length)]);
    }
    const oKeyPad = Buffer.alloc(blockSize);
    const iKeyPad = Buffer.alloc(blockSize);
    for (let i = 0; i < blockSize; i++) {
      oKeyPad[i] = keyBuf[i] ^ 0x5c;
      iKeyPad[i] = keyBuf[i] ^ 0x36;
    }
    const inner = crypto.createHmac('sha256', iKeyPad).update(data).digest();
    return crypto.createHmac('sha256', oKeyPad).update(inner).digest();
  };

  const hashLen = 32;
  const numBlocks = Math.ceil(keyLen / hashLen);
  const result = Buffer.alloc(numBlocks * hashLen);

  for (let blockNum = 1; blockNum <= numBlocks; blockNum++) {
    const blockBytes = Buffer.alloc(4);
    blockBytes.writeUInt32BE(blockNum);
    const saltBlock = Buffer.concat([saltBytes, blockBytes]);
    let u = hmacSha256(passwordBytes, saltBlock);
    const block = Buffer.from(u);
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(passwordBytes, u);
      for (let j = 0; j < hashLen; j++) {
        block[j] ^= u[j];
      }
    }
    block.copy(result, (blockNum - 1) * hashLen);
  }

  return result.slice(0, keyLen);
}

// XSalsa20-Poly1305 secretbox (using Node.js crypto for XSalsa20 + Poly1305)
// TweetNaCl's secretbox uses XSalsa20 + Poly1305 with 24-byte nonce
function secretboxOpen(box, nonce, key) {
  // Node.js doesn't have native XSalsa20, but we can use chacha20-poly1305 or
  // implement XSalsa20 from scratch. For recovery, we'll use a simple approach:
  // Since the server stores tweetnacl-encrypted data, we need tweetnacl.
  // We require the user to install tweetnacl and tweetnacl-util.
  if (!tweetnacl) {
    throw new Error('tweetnacl is required. Run: npm install tweetnacl tweetnacl-util');
  }
  return tweetnacl.secretbox.open(box, nonce, key);
}

// ---------------------------------------------------------------------------
// Try to load tweetnacl (required for decryption)
// ---------------------------------------------------------------------------
let tweetnacl = null;
let tweetnaclUtil = null;
try {
  tweetnacl = require('tweetnacl');
  tweetnaclUtil = require('tweetnacl-util');
} catch (e) {
  console.error('ERROR: tweetnacl and tweetnacl-util are required for decryption.');
  console.error('Please install them:');
  console.error('  npm install tweetnacl tweetnacl-util');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function request(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https:') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main recovery flow
// ---------------------------------------------------------------------------
async function main() {
  console.log('PhotoLynk Recovery Script');
  console.log('=========================\n');

  // 1. Derive or use provided master key(s)
  let masterKey;
  let legacyKey = null;
  if (MASTER_KEY_B64) {
    masterKey = tweetnaclUtil.decodeBase64(MASTER_KEY_B64);
    console.log('Using provided secure master key from Settings.');
  } else if (PASSWORD) {
    const salt = EMAIL.toLowerCase().trim();
    masterKey = pbkdf2Sha256(PASSWORD, salt, 30000, 32);
    console.log('Derived master key from email + password.');
  } else {
    console.error('ERROR: Provide either --password or --master-key.');
    process.exit(1);
  }
  if (LEGACY_KEY_B64) {
    legacyKey = tweetnaclUtil.decodeBase64(LEGACY_KEY_B64);
    console.log('Using provided legacy master key for old files.');
  }

  // 2. Authenticate
  console.log('\nAuthenticating to', SERVER_URL, '...');
  let token = null;
  try {
    const loginRes = await request('POST', `${SERVER_URL}/api/login`, {}, {
      email: EMAIL,
      password: PASSWORD || 'dummy',
    });
    if (loginRes.status === 200 && loginRes.data?.token) {
      token = loginRes.data.token;
      console.log('Authentication successful.');
    } else {
      console.error('Authentication failed:', loginRes.data?.error || `HTTP ${loginRes.status}`);
      process.exit(1);
    }
  } catch (e) {
    console.error('Login request failed:', e.message);
    process.exit(1);
  }

  // 3. Get device UUID (needed for storage path)
  let deviceUuid = null;
  try {
    const { v5: uuidv5 } = require('uuid');
    const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    deviceUuid = uuidv5(`${EMAIL.toLowerCase().trim()}:${PASSWORD}`, namespace);
  } catch (e) {
    console.warn('Could not derive device UUID. Will attempt without it.');
  }

  // 4. Fetch manifests
  console.log('\nFetching file manifests...');
  const authHeaders = { Authorization: `Bearer ${token}` };
  let manifests = [];
  try {
    const listRes = await request('GET', `${SERVER_URL}/api/cloud/manifests`, authHeaders);
    if (listRes.status === 200 && Array.isArray(listRes.data)) {
      manifests = listRes.data;
    }
  } catch (e) {
    console.warn('Manifest list endpoint not available or failed:', e.message);
  }

  if (manifests.length === 0) {
    console.log('No manifests found. Trying alternative listing...');
    // Try device-specific path if available
    if (deviceUuid) {
      try {
        const altRes = await request('GET', `${SERVER_URL}/api/cloud/manifests?device=${deviceUuid}`, authHeaders);
        if (altRes.status === 200 && Array.isArray(altRes.data)) {
          manifests = altRes.data;
        }
      } catch (e) {}
    }
  }

  if (manifests.length === 0) {
    console.error('No manifests found on server. Check your credentials and server URL.');
    process.exit(1);
  }

  console.log(`Found ${manifests.length} file(s) to recover.`);

  // 5. Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 6. Download and decrypt each file
  let recoveredCount = 0;
  let failedCount = 0;

  for (let i = 0; i < manifests.length; i++) {
    const manifestEntry = manifests[i];
    const manifestId = manifestEntry.manifestId || manifestEntry.id || manifestEntry;
    if (typeof manifestId !== 'string') continue;

    console.log(`\n[${i + 1}/${manifests.length}] Processing: ${manifestId}`);

    try {
      // Fetch encrypted manifest
      const manifestRes = await request('GET', `${SERVER_URL}/api/cloud/manifests/${manifestId}`, authHeaders);
      if (manifestRes.status !== 200) {
        console.warn(`  Failed to fetch manifest: HTTP ${manifestRes.status}`);
        failedCount++;
        continue;
      }

      const encryptedManifest = manifestRes.data;
      if (!encryptedManifest.encryptedManifest) {
        console.warn('  Manifest missing encryptedManifest field');
        failedCount++;
        continue;
      }

      // Parse encrypted manifest wrapper
      let wrapper;
      try {
        wrapper = typeof encryptedManifest.encryptedManifest === 'string'
          ? JSON.parse(encryptedManifest.encryptedManifest)
          : encryptedManifest.encryptedManifest;
      } catch (e) {
        console.warn('  Failed to parse manifest wrapper:', e.message);
        failedCount++;
        continue;
      }

      const manifestNonce = tweetnaclUtil.decodeBase64(wrapper.manifestNonce);
      const manifestBox = tweetnaclUtil.decodeBase64(wrapper.manifestBox);

      // Decrypt manifest — try secure key first, then legacy fallback
      let manifestPlain = tweetnacl.secretbox.open(manifestBox, manifestNonce, masterKey);
      if (!manifestPlain && legacyKey) {
        manifestPlain = tweetnacl.secretbox.open(manifestBox, manifestNonce, legacyKey);
      }
      if (!manifestPlain) {
        console.warn('  Manifest decryption failed with all available keys.');
        failedCount++;
        continue;
      }

      const manifest = JSON.parse(tweetnaclUtil.encodeUTF8(manifestPlain));
      const filename = manifest.filename || `${manifestId}.bin`;
      const chunkIds = manifest.chunkIds || [];
      const chunkSizes = manifest.chunkSizes || [];
      const baseNonce16 = tweetnaclUtil.decodeBase64(manifest.baseNonce16);
      const wrapNonce = tweetnaclUtil.decodeBase64(manifest.wrapNonce);
      const wrappedFileKey = tweetnaclUtil.decodeBase64(manifest.wrappedFileKey);

      console.log(`  File: ${filename} | Chunks: ${chunkIds.length}`);

      // Unwrap file key — try secure key first, then legacy fallback
      let fileKey = tweetnacl.secretbox.open(wrappedFileKey, wrapNonce, masterKey);
      if (!fileKey && legacyKey) {
        fileKey = tweetnacl.secretbox.open(wrappedFileKey, wrapNonce, legacyKey);
      }
      if (!fileKey) {
        console.warn('  File key unwrap failed with all available keys.');
        failedCount++;
        continue;
      }

      // Download and decrypt chunks
      const chunks = [];
      for (let ci = 0; ci < chunkIds.length; ci++) {
        const chunkId = chunkIds[ci];
        process.stdout.write(`  Chunk ${ci + 1}/${chunkIds.length}... `);

        try {
          const chunkUrl = `${SERVER_URL}/api/cloud/chunks/${chunkId}`;
          const chunkRes = await request('GET', chunkUrl, authHeaders);
          if (chunkRes.status !== 200) {
            console.log('download failed');
            throw new Error(`HTTP ${chunkRes.status}`);
          }

          // Chunk data may be in various formats
          let encryptedBytes;
          if (chunkRes.data && chunkRes.data.encryptedData) {
            encryptedBytes = tweetnaclUtil.decodeBase64(chunkRes.data.encryptedData);
          } else if (typeof chunkRes.data === 'string') {
            encryptedBytes = tweetnaclUtil.decodeBase64(chunkRes.data);
          } else {
            console.log('unknown format');
            throw new Error('Unknown chunk format');
          }

          // Decrypt chunk
          const nonce = makeChunkNonce(baseNonce16, ci);
          const plaintext = tweetnacl.secretbox.open(encryptedBytes, nonce, fileKey);
          if (!plaintext) {
            console.log('decrypt failed');
            throw new Error('Chunk decryption failed');
          }

          chunks.push(Buffer.from(plaintext));
          console.log('ok');
        } catch (e) {
          console.log(`error: ${e.message}`);
          throw e;
        }
      }

      // Reassemble file
      const fileBuffer = Buffer.concat(chunks);
      const outputPath = path.join(OUTPUT_DIR, filename);

      // Avoid overwriting
      let finalPath = outputPath;
      let suffix = 1;
      while (fs.existsSync(finalPath)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        finalPath = path.join(OUTPUT_DIR, `${base}_${suffix}${ext}`);
        suffix++;
      }

      fs.writeFileSync(finalPath, fileBuffer);
      console.log(`  Saved: ${finalPath} (${fileBuffer.length} bytes)`);
      recoveredCount++;

    } catch (e) {
      console.error(`  Failed to recover ${manifestId}: ${e.message}`);
      failedCount++;
    }
  }

  console.log(`\n=========================`);
  console.log(`Recovery complete.`);
  console.log(`Recovered: ${recoveredCount} file(s)`);
  console.log(`Failed:    ${failedCount} file(s)`);
  console.log(`Output:    ${path.resolve(OUTPUT_DIR)}`);
  console.log(`\nYour files have been decrypted locally. The encryption key never left this computer.`);
}

// ---------------------------------------------------------------------------
// Chunk nonce generation (must match app logic)
// ---------------------------------------------------------------------------
function makeChunkNonce(baseNonce16, chunkIndex) {
  const nonce = new Uint8Array(24);
  nonce.set(baseNonce16);
  nonce[16] = (chunkIndex >>> 0) & 0xff;
  nonce[17] = (chunkIndex >>> 8) & 0xff;
  nonce[18] = (chunkIndex >>> 16) & 0xff;
  nonce[19] = (chunkIndex >>> 24) & 0xff;
  return nonce;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().catch(e => {
  console.error('\nFatal error:', e.message);
  process.exit(1);
});
