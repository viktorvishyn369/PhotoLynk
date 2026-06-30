// NFT Operations Module for PhotoLynk Solana Seeker
// Handles REAL photo NFT minting on Solana using:
// 1. Compressed NFTs (cNFTs) via Metaplex Bubblegum - PRIMARY (99.99% cheaper)
// 2. Regular NFTs via SPL Token + Metaplex Token Metadata - FALLBACK
// Supports multiple wallets: MWA (Seeker/Saga), Phantom, WalletConnect, MetaMask

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import axios from 'axios';
import { sha256 } from 'js-sha256';
import jpegJs from 'jpeg-js';
import ImageTracer from 'imagetracerjs';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { getDeviceUUID, SAVED_PASSWORD_KEY } from './authHelpers';
import { computeExifHashFromAssetInfo } from './exifExtractor';
import { removeNFTImageFromCache } from './nftImageCache';
import * as Application from 'expo-application';
import { t } from './i18n';
import { getAllPinataJwts as getAllPinataJwtsFromAccounts } from './pinataAccounts';

// App version string for C2PA claim_generator — reads live from device, falls back to app.json value
const APP_VERSION = Application.nativeApplicationVersion || '2.0.0';

const isExplicitlyTrue = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
};

const hasUsableWrappedEncryptionPayload = (encryptionData) => {
  return !!(encryptionData?.wrappedKey && encryptionData?.wrapNonce && (encryptionData?.nonce || encryptionData?.thumbnailNonce));
};

// WalletAdapter imports for universal wallet support
let WalletAdapter = null;
let walletAdapterAvailable = false;
let MWAAdapter = null;
let mwaAdapterAvailable = false;

try {
  WalletAdapter = require('./WalletAdapter');
  walletAdapterAvailable = true;
  console.log('[NFT] WalletAdapter loaded');
} catch (e) {
  console.log('[NFT] WalletAdapter not available:', e.message);
}

try {
  MWAAdapter = require('./WalletAdapter/adapters/MWAAdapter');
  mwaAdapterAvailable = true;
  console.log('[NFT] MWAAdapter loaded');
} catch (e) {
  console.log('[NFT] MWAAdapter not available:', e.message);
}

// ============================================================================
// SOLANA IMPORTS
// ============================================================================

let Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, TransactionInstruction;
let TransactionMessage, VersionedTransaction, Keypair, ComputeBudgetProgram;
let transact;
let TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createInitializeMintInstruction;
let createAssociatedTokenAccountInstruction, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferInstruction, getAssociatedTokenAddress;
let getMint, getMinimumBalanceForRentExemptMint, MINT_SIZE;
let solanaAvailable = false;
let splTokenAvailable = false;

// Compressed NFT (cNFT) support - using raw Solana instructions (no UMI dependency)
// UMI/Bubblegum SDK is not compatible with React Native Metro bundler
// We implement cNFT minting using raw transaction instructions instead
let cNFTAvailable = false;

try {
  const web3 = require('@solana/web3.js');
  Connection = web3.Connection;
  PublicKey = web3.PublicKey;
  Transaction = web3.Transaction;
  TransactionInstruction = web3.TransactionInstruction;
  SystemProgram = web3.SystemProgram;
  LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
  TransactionMessage = web3.TransactionMessage;
  VersionedTransaction = web3.VersionedTransaction;
  Keypair = web3.Keypair;
  ComputeBudgetProgram = web3.ComputeBudgetProgram;

  const mwa = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
  transact = mwa.transact;

  solanaAvailable = true;

  // Try to load SPL Token
  try {
    const splToken = require('@solana/spl-token');
    TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID;
    ASSOCIATED_TOKEN_PROGRAM_ID = splToken.ASSOCIATED_TOKEN_PROGRAM_ID;
    createInitializeMintInstruction = splToken.createInitializeMintInstruction;
    createAssociatedTokenAccountInstruction = splToken.createAssociatedTokenAccountInstruction;
    createAssociatedTokenAccountIdempotentInstruction = splToken.createAssociatedTokenAccountIdempotentInstruction;
    createMintToInstruction = splToken.createMintToInstruction;
    createTransferInstruction = splToken.createTransferInstruction;
    getAssociatedTokenAddress = splToken.getAssociatedTokenAddress;
    getMint = splToken.getMint;
    getMinimumBalanceForRentExemptMint = splToken.getMinimumBalanceForRentExemptMint;
    MINT_SIZE = splToken.MINT_SIZE;
    splTokenAvailable = true;
    console.log('[NFT] SPL Token loaded successfully');
  } catch (splErr) {
    console.log('[NFT] SPL Token not available:', splErr.message);
  }

  // cNFT is available if we have basic Solana support
  // We use raw instructions instead of UMI SDK
  cNFTAvailable = true;
  console.log('[NFT] cNFT support enabled (raw instructions mode)');
} catch (e) {
  console.log('[NFT] Solana libraries not available:', e.message);
}

// SNS (Solana Name Service) for .sol domain resolution
let snsAvailable = false;
let getDomainKeySync, NameRegistryState;
try {
  const sns = require('@bonfida/spl-name-service');
  getDomainKeySync = sns.getDomainKeySync;
  NameRegistryState = sns.NameRegistryState;
  snsAvailable = true;
  console.log('[NFT] SNS (Solana Name Service) loaded successfully');
} catch (snsErr) {
  console.log('[NFT] SNS not available:', snsErr.message);
}

// AllDomains API for .skr and other TLDs (no SDK needed - uses REST API)

// Keccak-256 for verifying Bubblegum cNFT leaf hashes locally before burn.
// This lets us catch input mismatches (wrong nonce/delegate/data_hash) BEFORE
// signing & broadcasting — saving the user a wasted MWA prompt and a fee.
let _keccak256 = null;
const _keccakResolvers = [
  () => require('@noble/hashes/sha3').keccak_256,
  () => require('@noble/hashes/sha3.js').keccak_256,
  () => require('@noble/hashes/esm/sha3').keccak_256,
  () => require('@noble/hashes/esm/sha3.js').keccak_256,
];
for (const resolve of _keccakResolvers) {
  try {
    const fn = resolve();
    if (typeof fn === 'function') { _keccak256 = fn; break; }
  } catch (_) { /* try next */ }
}
if (!_keccak256) {
  console.log('[NFT] keccak_256 unavailable — cNFT burn pre-flight self-check disabled');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// Solana RPC endpoint (mainnet-beta for production)
// Helius primary (dedicated API key), public fallback
const SOLANA_RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=8b86bd0d-4534-4ce9-a61d-ec3850cb0b62';
const SOLANA_RPC_FALLBACKS = [
  'https://mainnet.helius-rpc.com/?api-key=6b3d0180-4354-4e31-a2fc-9b6cd9e550a7',
  'https://rpc.ankr.com/solana',
  'https://api.mainnet-beta.solana.com',
];

// ─────────────────────────────────────────────────────────────────────────────
// ROBUST BROADCAST HELPER
// ─────────────────────────────────────────────────────────────────────────────
// After the Seeker MWA wallet signs a transaction, the device returns from
// the wallet app to the seeker app. RN's network stack is briefly unstable
// during this foreground transition — `fetch()` POSTs can fail with the
// generic "Network request failed" error for the first 1–2 seconds, while
// other (long-running) requests recover transparently with retries.
//
// `broadcastSignedTransaction()` handles this by:
//   1. Brief warmup delay before the first send.
//   2. Two passes over every configured RPC: first via web3.js
//      sendRawTransaction (with skipPreflight=true after the first failure
//      to bypass simulation under flaky connectivity), then via a raw
//      JSON-RPC fetch as a final fallback.
//   3. Per-RPC error logging so we can see exactly what failed.
//
// Returns the transaction signature, or throws with the last error.
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Classify a sendRawTransaction error.
//   - 'program'  → simulation rejected the tx (logs contain "Program log: ...").
//                  Broadcasting with skipPreflight will land it on-chain as a
//                  failed tx, costing the user the fee. NEVER retry — surface
//                  the simulation logs so outer retry logic can see them.
//   - 'rpc'      → RPC-side issue (403, rate limit, node out of sync). Try
//                  the next RPC.
//   - 'network'  → RN fetch / connectivity. Try the next RPC, possibly skip
//                  preflight on a second pass.
function _classifyBroadcastError(err) {
  const msg = String(err?.message || '');
  if (Array.isArray(err?.logs) && err.logs.length > 0) return 'program';
  if (/Simulation failed|Transaction simulation failed|Program log:|InstructionError/i.test(msg)) return 'program';
  if (/Network request failed|Failed to fetch|timeout|aborted|TypeError/i.test(msg)) return 'network';
  if (/\b(403|401|429|502|503|504)\b/.test(msg) || /api key|rate limit|forbidden|unauthorized/i.test(msg)) return 'rpc';
  return 'rpc';
}

// Build an enriched error from a simulation failure — includes the on-chain
// log line that explains WHY (e.g. "Invalid root recomputed from proof"), so
// outer `isRetryableErr` can detect proof/merkle/root keywords and retry with
// a fresh DAS proof.
function _enrichProgramError(err, opLabel) {
  const logs = Array.isArray(err?.logs) ? err.logs : [];
  const meaningful = logs.find(l => /error|failed|invalid/i.test(l)) || logs[logs.length - 1] || '';
  const enriched = new Error(`[${opLabel}] Program rejected: ${err.message || 'simulation failed'} | ${meaningful}`);
  enriched.logs = logs;
  enriched.simulation = true;
  enriched.original = err;
  return enriched;
}

async function broadcastSignedTransaction(signedTx, opLabel = 'broadcast') {
  const rpcs = [SOLANA_RPC_ENDPOINT, ...SOLANA_RPC_FALLBACKS];
  let serialized;
  try {
    serialized = signedTx.serialize();
  } catch (e) {
    throw new Error(`[${opLabel}] Failed to serialize signed tx: ${e.message}`);
  }
  let serializedB64 = '';
  try { serializedB64 = Buffer.from(serialized).toString('base64'); } catch (_) {}

  // 1) Warmup so RN's network recovers from the MWA wallet bounce.
  await _sleep(600);

  let lastError = null;
  let lastNetworkOrRpcError = null;
  let sawProgramError = false;
  let firstProgramError = null;

  // 2) Pass 1: send with preflight=true. This is the safety net — if the
  //    program will fail on-chain, simulation catches it and we DON'T waste
  //    the user's fee by broadcasting.
  for (let i = 0; i < rpcs.length; i++) {
    const url = rpcs[i];
    try {
      const conn = new Connection(url, 'confirmed');
      const sig = await conn.sendRawTransaction(serialized, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      if (sig) {
        console.log(`[${opLabel}] sent via web3 RPC #${i + 1} (skipPreflight=false): ${sig}`);
        return sig;
      }
    } catch (e) {
      lastError = e;
      const kind = _classifyBroadcastError(e);
      console.warn(`[${opLabel}] web3 RPC #${i + 1} (preflight) failed [${kind}]:`, e.message);
      if (kind === 'program') {
        // Tx is broken — DO NOT broadcast it (would just become a failed
        // on-chain tx and waste fees). Save the first program error.
        if (!sawProgramError) {
          sawProgramError = true;
          firstProgramError = e;
        }
        // Other RPCs would simulate the same way; skip ahead but keep the
        // info. (We continue the loop in case a desync RPC magically
        // accepts, though that's basically never.)
      } else {
        lastNetworkOrRpcError = e;
      }
      await _sleep(250);
    }
  }

  // 3) If ANY RPC reported a program error during preflight, the tx is
  //    legitimately broken. Surface the enriched error so outer retry logic
  //    (isRetryableErr) can see "proof"/"merkle"/"root"/"hash" in the logs
  //    and refresh DAS data before retrying.
  if (sawProgramError && firstProgramError) {
    throw _enrichProgramError(firstProgramError, opLabel);
  }

  // 4) Pass 2 — only reached if every RPC failed for network/RPC reasons
  //    (not program reasons). Now it's safe to skipPreflight, because we
  //    have no evidence the tx is broken — the chain is just unreachable.
  for (let i = 0; i < rpcs.length; i++) {
    const url = rpcs[i];
    try {
      const conn = new Connection(url, 'confirmed');
      const sig = await conn.sendRawTransaction(serialized, {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      if (sig) {
        console.log(`[${opLabel}] sent via web3 RPC #${i + 1} (skipPreflight=true): ${sig}`);
        return sig;
      }
    } catch (e) {
      lastError = e;
      const kind = _classifyBroadcastError(e);
      console.warn(`[${opLabel}] web3 RPC #${i + 1} (skipPreflight) failed [${kind}]:`, e.message);
      // Even with skipPreflight, an RPC may still echo program errors via
      // its post-broadcast checks. Bail on first program error.
      if (kind === 'program') throw _enrichProgramError(e, opLabel);
      await _sleep(250);
    }
  }

  // 5) Last resort: raw fetch JSON-RPC. Bypasses web3.js Connection internals.
  if (serializedB64) {
    for (let i = 0; i < rpcs.length; i++) {
      const url = rpcs[i];
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: `${opLabel}-${Date.now()}`,
            method: 'sendTransaction',
            params: [serializedB64, { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed', maxRetries: 3 }],
          }),
        });
        const data = await resp.json().catch(() => null);
        if (data?.result) {
          console.log(`[${opLabel}] sent via raw fetch RPC #${i + 1}: ${data.result}`);
          return data.result;
        }
        lastError = new Error(data?.error?.message || `HTTP ${resp.status}`);
        console.warn(`[${opLabel}] raw fetch RPC #${i + 1} returned no signature:`, lastError.message);
      } catch (e) {
        lastError = e;
        console.warn(`[${opLabel}] raw fetch RPC #${i + 1} failed:`, e.message);
        await _sleep(250);
      }
    }
  }

  const msg = lastError?.message || 'unknown';
  if (/Network request failed|Failed to fetch|TypeError/i.test(msg)) {
    throw new Error('Network unstable — please check your connection and try again');
  }
  throw lastError || lastNetworkOrRpcError || new Error(`[${opLabel}] All RPCs failed`);
}

// App commission wallet (receives NFT minting fees)
export const NFT_COMMISSION_WALLET = 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const FLAT_FEE_BEYOND_100_USD = 0.02;

// Fee-exempt addresses: only the commission wallet itself skips app fees.
// All other addresses (including dev addresses) pay the discounted SKR app fees.
const DEV_FEE_EXEMPT_ADDRESSES = new Set([
  NFT_COMMISSION_WALLET,
]);

export const NFT_PAYMENT_METHODS = {
  SOL: 'sol',
  SKR: 'skr',
};

export const SKR_TOKEN_SYMBOL = 'SKR';
export const SKR_TOKEN_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
export const SKR_PAYMENT_DISCOUNT_PERCENT = 0;
const SKR_PAYMENT_MULTIPLIER = 1;
export const NFT_WEEKLY_DISCOUNT_FALLBACK = {
  serverNow: 0,
  windowDays: 7,
  weeklyMintCount: 0,
  streakCount: 0,
  streakBonusPercent: 0,
  discountPercent: 0,
  multiplier: 1,
  appliesTo: 'skr_photolynk_fee',
  nextDiscountPercent: 10,
  mintsToMaxDiscount: 9,
  loyaltyFreeWeekActive: false,
  loyaltyFreeWeekPending: false,
  loyaltyFreeStartsAt: null,
  loyaltyFreeExpiresAt: null,
};

// Fee wallet exemption: the commission wallet itself and dev addresses should not pay app fees
// (network fees still apply to everyone)
const isFeeWalletExempt = (ownerAddress) => {
  const addr = typeof ownerAddress === 'string' ? ownerAddress : ownerAddress?.toBase58?.() || '';
  return DEV_FEE_EXEMPT_ADDRESSES.has(addr);
};

const getServerHeadersFromConfig = async (config) => {
  if (!config) return null;
  if (typeof config.getAuthHeaders === 'function') {
    const authConfig = await config.getAuthHeaders();
    return authConfig?.headers || authConfig || null;
  }
  return config.headers || null;
};

const getPremiumMintEntitlement = async (config) => {
  if (!config?.baseUrl) {
    return { waiveCommission: false, isPremium: false, freeMintsRemaining: 0, noFeeMintsRemaining: 0, feesApply: true, discountPct: 0, photoLynkFeeFree: false };
  }
  try {
    const headers = await getServerHeadersFromConfig(config);
    if (!headers?.Authorization) {
      return { waiveCommission: false, isPremium: false, freeMintsRemaining: 0, noFeeMintsRemaining: 0, feesApply: true, discountPct: 0, photoLynkFeeFree: false };
    }
    const response = await axios.get(`${config.baseUrl}/api/nft-service/premium-status`, {
      headers,
      timeout: 10000,
    });
    const data = response?.data || {};
    const noFeeMintsRemaining = Number(data.noFeeMintsRemaining) || 0;
    const feesApply = data.feesApply !== undefined ? !!data.feesApply : true;
    const discountPct = Number(data.discountPct) || 0;
    const photoLynkFeeFree = data.photoLynkFeeFree !== undefined ? !!data.photoLynkFeeFree : false;
    const waiveCommission = !!data.isPremium && noFeeMintsRemaining > 0 && !feesApply;
    return {
      waiveCommission,
      isPremium: !!data.isPremium,
      freeMintsRemaining: Number(data.freeMintsRemaining) || 0,
      noFeeMintsRemaining,
      feesApply,
      discountPct,
      photoLynkFeeFree,
    };
  } catch (_) {
    return { waiveCommission: false, isPremium: false, freeMintsRemaining: 0, noFeeMintsRemaining: 0, feesApply: true, discountPct: 0, photoLynkFeeFree: false };
  }
};

const recordPremiumMintUsage = async (config, mintAddress, txSignature = '') => {
  if (!config?.baseUrl || !mintAddress) return null;
  try {
    const headers = await getServerHeadersFromConfig(config);
    if (!headers?.Authorization) return null;
    const response = await axios.post(`${config.baseUrl}/api/nft-service/premium-mint-record`, {
      mintAddress,
      txSignature,
    }, {
      headers,
      timeout: 10000,
    });
    return response?.data || null;
  } catch (_) {
    return null;
  }
};

const mintWithServerWallet = async ({
  filePath,
  asset,
  name,
  description,
  stripExif,
  storageOption,
  edition,
  license,
  watermark,
  encrypt,
  masterKey,
  clientContentHash = null,
  clientExifRawHash = null,
  clientExifHash = null,
  clientExifBindingHash = null,
  clientCameraHash = null,
  clientTsaToken = null,
  clientTsaUrl = null,
  clientTsaPolicy = null,
  clientC2paManifest = null,
  clientMintTimestamp = null,
  recipientAddress = null,
  certificationMode,
  serverConfig,
  onProgress,
  onStatus,
}) => {
  try {
    const headers = await getServerHeadersFromConfig(serverConfig);
    if (!headers?.Authorization) {
      return { success: false, error: 'Not authenticated' };
    }

    const ext = (asset.filename || filePath).split('.').pop()?.toLowerCase() || 'jpg';
    const mimeTypes = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
      gif: 'image/gif', tiff: 'image/tiff', tif: 'image/tiff',
      dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', nef: 'image/x-nikon-nef',
      arw: 'image/x-sony-arw', raf: 'image/x-fuji-raf',
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';

    let clientEncryptionData = null;
    let nftKeyB64Str = null;
    let uploadImageUri = filePath;
    let uploadImageType = mimeType;
    let uploadImageName = asset.filename || `photo.${ext}`;
    let encryptedThumbUri = null;
    const serverMintTempFiles = [];

    if (encrypt && masterKey) {
      onStatus?.('Encrypting image...');
      onProgress?.(0.2);

      const nftKey = nacl.randomBytes(32);
      const nonce = nacl.randomBytes(24);
      const wrapNonce = nacl.randomBytes(24);
      const wrappedKey = nacl.secretbox(nftKey, wrapNonce, masterKey);
      nftKeyB64Str = naclUtil.encodeBase64(nftKey);

      try {
        const imgB64 = await FileSystem.readAsStringAsync(filePath, { encoding: FileSystem.EncodingType.Base64 });
        const imgEnc = nacl.secretbox(naclUtil.decodeBase64(imgB64), nonce, nftKey);
        const encImgPath = `${FileSystem.cacheDirectory}nft_srv_enc_${Date.now()}.bin`;
        await FileSystem.writeAsStringAsync(encImgPath, naclUtil.encodeBase64(imgEnc), { encoding: FileSystem.EncodingType.Base64 });
        serverMintTempFiles.push(encImgPath);
        uploadImageUri = encImgPath;
        uploadImageType = 'application/octet-stream';
        uploadImageName = (asset.filename || `photo.${ext}`) + '.bin';
        console.log('[NFT/server] Image encrypted for upload');
      } catch (encImgErr) {
        console.warn('[NFT/server] Image encryption failed, sending unencrypted:', encImgErr.message);
      }

      let thumbnailNonce = null;
      try {
        onStatus?.('Creating thumbnail...');
        const thumbResult = await ImageManipulator.manipulateAsync(
          filePath,
          [{ resize: { width: 800 } }],
          { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG }
        );
        serverMintTempFiles.push(thumbResult.uri);
        const thumbB64 = await FileSystem.readAsStringAsync(thumbResult.uri, { encoding: FileSystem.EncodingType.Base64 });
        thumbnailNonce = new Uint8Array(24);
        global.crypto.getRandomValues(thumbnailNonce);
        const thumbEnc = nacl.secretbox(naclUtil.decodeBase64(thumbB64), thumbnailNonce, nftKey);
        const encThumbPath = `${FileSystem.cacheDirectory}nft_srv_enc_thumb_${Date.now()}.bin`;
        await FileSystem.writeAsStringAsync(encThumbPath, naclUtil.encodeBase64(thumbEnc), { encoding: FileSystem.EncodingType.Base64 });
        serverMintTempFiles.push(encThumbPath);
        encryptedThumbUri = encThumbPath;
        console.log('[NFT/server] Encrypted thumbnail ready for upload');
      } catch (thumbErr) {
        console.warn('[NFT/server] Encrypted thumbnail failed (non-critical):', thumbErr.message);
      }

      clientEncryptionData = {
        wrappedKey: naclUtil.encodeBase64(wrappedKey),
        wrapNonce: naclUtil.encodeBase64(wrapNonce),
        nonce: naclUtil.encodeBase64(nonce),
        ...(thumbnailNonce ? { thumbnailNonce: naclUtil.encodeBase64(thumbnailNonce) } : {}),
      };
    }

    onStatus?.('Uploading to PhotoLynk...');
    onProgress?.(0.35);

    const formData = new FormData();
    formData.append('image', {
      uri: uploadImageUri,
      type: uploadImageType,
      name: uploadImageName,
    });
    formData.append('name', name || 'Photo NFT');
    formData.append('description', description || '');
    formData.append('edition', edition || 'open');
    formData.append('license', license || 'arr');
    formData.append('stripExif', stripExif ? 'true' : 'false');
    formData.append('storageOption', storageOption || 'ipfs');
    formData.append('watermark', watermark ? 'true' : 'false');
    formData.append('encrypt', encrypt ? 'true' : 'false');
    if (recipientAddress) formData.append('recipientAddress', recipientAddress);
    if (certificationMode) formData.append('certificationMode', certificationMode);
    if (clientEncryptionData) {
      formData.append('encryptionData', JSON.stringify(clientEncryptionData));
      formData.append('nftKeyB64', nftKeyB64Str);
    }
    if (clientContentHash) formData.append('clientContentHash', clientContentHash);
    if (clientExifRawHash) formData.append('clientExifRawHash', clientExifRawHash);
    if (clientExifHash) formData.append('clientExifHash', clientExifHash);
    if (clientExifBindingHash) formData.append('clientExifBindingHash', clientExifBindingHash);
    if (encryptedThumbUri) {
      formData.append('encryptedThumb', {
        uri: encryptedThumbUri,
        type: 'application/octet-stream',
        name: 'thumb_enc.bin',
      });
    }

    onStatus?.(t('nftStatus.mintingWithPhotolynk'));
    onProgress?.(0.5);

    let response;
    try {
      response = await axios.post(`${serverConfig.baseUrl}/api/nft-service/mint`, formData, {
        headers: {
          ...headers,
          'Content-Type': 'multipart/form-data',
        },
        timeout: 120000,
        onUploadProgress: (progressEvent) => {
          const total = progressEvent?.total || 1;
          const uploadProgress = 0.35 + (progressEvent.loaded / total) * 0.4;
          onProgress?.(uploadProgress);
        },
      });
    } finally {
      for (const p of serverMintTempFiles) {
        try { await FileSystem.deleteAsync(p, { idempotent: true }); } catch (_) { }
      }
    }

    if (!response.data?.success) {
      return { success: false, error: response.data?.error || 'PhotoLynk mint failed' };
    }

    const result = response.data;
    const mergedEncryptionData = (() => {
      const merged = {
        ...(clientEncryptionData || {}),
        ...((result.encryptionData && typeof result.encryptionData === 'object') ? result.encryptionData : {}),
      };
      if (result.thumbnailUrl && !merged.thumbnailUrl) merged.thumbnailUrl = result.thumbnailUrl;
      return Object.keys(merged).length > 0 ? merged : null;
    })();
    const createdAt = result.createdAt || result.mintedAt || new Date().toISOString();
    const mintedAt = result.mintedAt || clientMintTimestamp || createdAt;
    const nftData = {
      mintAddress: result.mintAddress || result.assetId,
      assetId: result.assetId || (result.mintAddress ? String(result.mintAddress).replace(/^cnft_/, '') : null),
      name: name || 'Photo NFT',
      description: description || '',
      imageUrl: result.imageUrl,
      thumbnailUrl: result.thumbnailUrl,
      ipfsThumbnailUrl: result.ipfsThumbnailUrl || null,
      arweaveUrl: result.imageUrl,
      metadataUrl: result.metadataUrl,
      txSignature: result.txSignature,
      isCompressed: result.isCompressed !== false,
      edition: edition || 'open',
      license: license || 'arr',
      certificationMode: certificationMode || null,
      watermarked: !!watermark,
      encrypted: result.encrypted || false,
      encryptionData: mergedEncryptionData,
      storageOption: storageOption || 'ipfs',
      storageType: result.storageType || storageOption || 'ipfs',
      ownerAddress: result.ownerAddress,
      creatorWallet: result.creatorWallet || result.ownerAddress,
      contentHash: result.contentHash || clientContentHash || null,
      exifRawHash: result.exifRawHash || clientExifRawHash || null,
      exifHash: result.exifHash || clientExifHash || null,
      exifBindingHash: result.exifBindingHash || clientExifBindingHash || null,
      cameraHash: result.cameraHash || clientCameraHash || null,
      hasRfc3161: result.hasRfc3161 || !!result.rfc3161Token || !!clientTsaToken,
      hasC2pa: result.hasC2pa || !!result.c2paManifest || !!clientC2paManifest,
      rfc3161Token: result.rfc3161Token || clientTsaToken || null,
      rfc3161Tsa: result.rfc3161Tsa || result.tsaUrl || clientTsaUrl || null,
      tsaUrl: result.tsaUrl || result.rfc3161Tsa || clientTsaUrl || null,
      tsaPolicy: result.tsaPolicy || clientTsaPolicy || null,
      c2paManifest: result.c2paManifest || clientC2paManifest || null,
      attributes: result.attributes || result.metadata?.attributes || [],
      metadata: result.metadata || null,
      createdAt,
      mintedAt,
      mintedVia: 'server-premium-free',
      mintPlatform: result.mintPlatform || 'nft-service',
    };

    await saveNFTToStorage(
      nftData,
      serverConfig?.baseUrl || null,
      headers || null
    );

    onProgress?.(1.0);
    onStatus?.(t('nftStatus.mintComplete'));

    return {
      success: true,
      mintAddress: nftData.mintAddress,
      assetId: nftData.assetId,
      txSignature: result.txSignature,
      imageUrl: result.imageUrl,
      thumbnailUrl: result.thumbnailUrl,
      ipfsThumbnailUrl: result.ipfsThumbnailUrl || null,
      metadataUrl: result.metadataUrl,
      contentHash: nftData.contentHash,
      exifHash: nftData.exifHash,
      exifRawHash: nftData.exifRawHash,
      exifBindingHash: nftData.exifBindingHash,
      cameraHash: nftData.cameraHash,
      isCompressed: result.isCompressed !== false,
      ownerAddress: result.ownerAddress,
      creatorWallet: nftData.creatorWallet,
      costUsd: 0,
      encrypted: result.encrypted || false,
      encryptionData: mergedEncryptionData,
      hasRfc3161: nftData.hasRfc3161,
      hasC2pa: nftData.hasC2pa,
      rfc3161Token: nftData.rfc3161Token,
      rfc3161Tsa: nftData.rfc3161Tsa,
      tsaUrl: nftData.tsaUrl,
      tsaPolicy: nftData.tsaPolicy,
      c2paManifest: nftData.c2paManifest,
      attributes: nftData.attributes,
      certificationMode: nftData.certificationMode,
      createdAt: nftData.createdAt,
      mintedAt: nftData.mintedAt,
      mintPlatform: nftData.mintPlatform,
      metadata: result.metadata || null,
    };
  } catch (e) {
    console.error('[NFT] Server mint error:', e.message);
    return { success: false, error: e.message };
  }
};

// App identity for Mobile Wallet Adapter
const APP_IDENTITY = {
  name: 'PhotoLynk',
  uri: 'https://stealthlynk.io',
  icon: 'favicon.ico',
};

// Metaplex Token Metadata Program ID (for fetching NFT metadata)
let TOKEN_METADATA_PROGRAM_ID = null;

// NFT Minting Fees (in USD)
// Pricing tiers based on NFT type and storage option

// ============================================================================
// PROMOTIONAL PRICING - 30 DAY LAUNCH SPECIAL
// ============================================================================
const PROMO_START_DATE = new Date('2026-01-27T00:00:00Z'); // Launch date
const PROMO_DURATION_DAYS = 30;
const PROMO_END_DATE = new Date(PROMO_START_DATE.getTime() + PROMO_DURATION_DAYS * 24 * 60 * 60 * 1000);

// Check if promotion is active
export const isPromoActive = () => {
  const now = new Date();
  return now >= PROMO_START_DATE && now < PROMO_END_DATE;
};

// Get days remaining in promotion
export const getPromoDaysRemaining = () => {
  const now = new Date();
  if (now >= PROMO_END_DATE) return 0;
  return Math.ceil((PROMO_END_DATE - now) / (24 * 60 * 60 * 1000));
};

// PROMOTIONAL FEES (first 30 days)
const PROMO_FEES = {
  // Standard NFT fees (promo)
  APP_COMMISSION_STANDARD_IPFS_USD: 0.50,    // Standard + IPFS (promo)
  APP_COMMISSION_STANDARD_CLOUD_USD: 0.20,   // Standard + StealthCloud (promo)
  // Compressed NFT fees (promo) - super cheap launch pricing!
  APP_COMMISSION_CNFT_IPFS_USD: 0.05,        // cNFT + IPFS (promo)
  APP_COMMISSION_CNFT_CLOUD_USD: 0.02,       // cNFT + StealthCloud (promo)
};

// REGULAR FEES (after promotion ends)
const REGULAR_FEES = {
  // Standard NFT fees (regular)
  APP_COMMISSION_STANDARD_IPFS_USD: 1.00,    // Standard + IPFS = $1.00
  APP_COMMISSION_STANDARD_CLOUD_USD: 0.50,   // Standard + StealthCloud = $0.50
  // Compressed NFT fees (regular) - 10x promo price
  APP_COMMISSION_CNFT_IPFS_USD: 0.72,        // cNFT + IPFS = $0.72
  APP_COMMISSION_CNFT_CLOUD_USD: 0.20,       // cNFT + StealthCloud = $0.20
};

// Get current fees based on promo status
export const getCurrentFees = () => {
  return isPromoActive() ? PROMO_FEES : REGULAR_FEES;
};

/**
 * Compute size-based commission fee.
 * Base: $0.15 for files up to 3 MB.
 * Each additional 1 MB above 3 MB adds +10% to the base.
 * Formula: fee = 0.15 × (1 + max(0, ceil(sizeMB − 3)) × 0.10)
 *
 * Examples:
 *   2 MB  → $0.15
 *   3 MB  → $0.15
 *   5 MB  → $0.15 × 1.20 = $0.18
 *  10 MB  → $0.15 × 1.70 = $0.25
 *  20 MB  → $0.15 × 2.70 = $0.40
 */
const BASE_COMMISSION_USD = 0.15;
const SIZE_THRESHOLD_MB = 3;
const SIZE_SURCHARGE_PER_MB = 0.10; // +10% per extra MB

export const computeSizeBasedFee = (fileSizeBytes) => {
  const sizeMb = (fileSizeBytes || 0) / (1024 * 1024);
  const extraMb = Math.max(0, Math.ceil(sizeMb - SIZE_THRESHOLD_MB));
  const multiplier = 1 + extraMb * SIZE_SURCHARGE_PER_MB;
  return Math.round(BASE_COMMISSION_USD * multiplier * 100) / 100;
};

// Legacy alias — kept for backward compatibility
export const computeLimitedEditionFee = computeSizeBasedFee;

export const NFT_FEES = {
  // Storage costs (unchanged)
  ARWEAVE_UPLOAD_BASE: 0.01,      // Base IPFS/Arweave upload cost (varies by size)
  ARWEAVE_PER_KB: 0.00001,        // Per KB upload cost

  // Standard NFT on-chain costs (expensive)
  SOLANA_RENT: 0.002,             // Solana rent-exempt minimum (~0.002 SOL)
  METAPLEX_FEE: 0.01,             // Metaplex protocol fee

  // Compressed NFT on-chain costs (99.99% cheaper)
  CNFT_TRANSACTION_FEE: 0.000005, // cNFT only costs transaction fee (~$0.001)

  // Dynamic PhotoLynk commission - uses promo or regular based on date
  get APP_COMMISSION_STANDARD_IPFS_USD() { return getCurrentFees().APP_COMMISSION_STANDARD_IPFS_USD * 0.5; },
  get APP_COMMISSION_STANDARD_CLOUD_USD() { return getCurrentFees().APP_COMMISSION_STANDARD_CLOUD_USD * 0.5; },
  get APP_COMMISSION_CNFT_IPFS_USD() { return getCurrentFees().APP_COMMISSION_CNFT_IPFS_USD * 0.5; },
  get APP_COMMISSION_CNFT_CLOUD_USD() { return getCurrentFees().APP_COMMISSION_CNFT_CLOUD_USD * 0.5; },

  // Legacy aliases (for backward compatibility)
  get APP_COMMISSION_IPFS_USD() { return getCurrentFees().APP_COMMISSION_STANDARD_IPFS_USD * 0.5; },
  get APP_COMMISSION_CLOUD_USD() { return getCurrentFees().APP_COMMISSION_STANDARD_CLOUD_USD * 0.5; },
  get APP_COMMISSION_CNFT_USD() { return getCurrentFees().APP_COMMISSION_CNFT_IPFS_USD * 0.5; },
  APP_COMMISSION_PERCENT: 5,
};

// PhotoLynk shared Merkle Tree for compressed NFTs
// This tree is pre-created and shared by all PhotoLynk users for maximum cost efficiency
// Tree specs: maxDepth=20 (1M+ NFTs), maxBufferSize=64, public=true
export const PHOTOLYNK_MERKLE_TREE = '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS'; // PhotoLynk shared Merkle tree on mainnet

/**
 * Check if an NFT was created within the PhotoLynk ecosystem.
 * Only ecosystem NFTs should get certificates/proofs generated.
 * Criteria: merkle tree match, creator wallet match, or PhotoLynk-specific attributes.
 */
export const isPhotoLynkEcosystem = (nft) => {
  if (!nft) return false;
  // 1. cNFT minted to our shared Merkle tree
  if (nft.merkleTree === PHOTOLYNK_MERKLE_TREE) return true;
  // 2. Creator is our commission wallet
  if (nft.creatorWallet === NFT_COMMISSION_WALLET) return true;
  const mintPlatform = String(nft.mintPlatform || '').toLowerCase();
  if (mintPlatform.includes('photolynk') || mintPlatform === 'nft-service') return true;
  if (nft.contentHash && nft.exifHash) return true;
  // 3. Has PhotoLynk-specific on-chain attributes (Content Hash + EXIF Hash = app-minted)
  const attrs = nft.metadata?.attributes || nft.attributes || [];
  const hasContentHash = attrs.some(a => a.trait_type === 'Content Hash');
  const hasExifHash = attrs.some(a => a.trait_type === 'EXIF Hash');
  if (hasContentHash && hasExifHash) return true;
  // 4. Certificate metadata has PhotoLynk type
  const metaCert = nft.metadata?.properties?.certificate;
  if (metaCert && metaCert.type && metaCert.type.includes('PhotoLynk')) return true;
  // 5. Name or description contains PhotoLynk (minted via nft-service with default template)
  if (nft.name && nft.name.includes('PhotoLynk')) return true;
  return false;
};

// cNFT minting mode
export const CNFT_MODE = {
  ENABLED: true,           // Use cNFTs by default (99.99% cheaper)
  FALLBACK_TO_REGULAR: true, // Fall back to regular NFTs if cNFT fails
};

// Storage options for NFT images
export const NFT_STORAGE_OPTIONS = {
  IPFS: 'ipfs',           // Pinata IPFS - decentralized but requires pinning
  STEALTHCLOUD: 'cloud',  // StealthCloud - user's encrypted storage
  ARWEAVE: 'arweave',     // Arweave - permanent decentralized storage, pay once
  ONCHAIN: 'onchain',     // On-Chain - original image embedded as data URI in metadata (self-contained, no IPFS image dependency)
};

// On-chain image constraints (kept for backwards compat but no longer used as a hard limit)
export const ONCHAIN_MAX_IMAGE_BYTES = 10 * 1024;

// Minting lock — blocks auto-scan/sync during NFT creation to free memory for large on-chain data URIs
let _mintingInProgress = false;
// Cleanup log suppression — only log "Cleaned up NFT storage file" once per session
let _nftCleanupLogged = false;
export const isMintingInProgress = () => _mintingInProgress;

// ============================================================================
// EDITION TYPES & LICENSE OPTIONS
// ============================================================================

// Edition types (photography industry standard naming)
export const NFT_EDITION = {
  OPEN: 'open',           // Open Edition — everyday photo NFT, image on blockchain
  LIMITED: 'limited',     // Limited Edition — copyright certificate, original on device only
};

// License options for NFT photos — internationally recognized licenses
// All Creative Commons licenses are version 4.0 International, recognized by courts worldwide
export const NFT_LICENSE_OPTIONS = [
  { id: 'arr', label: 'All Rights Reserved', short: 'ARR', url: null, desc: 'Full copyright protection. No reuse without explicit permission from the rights holder.' },
  { id: 'cc-by', label: 'CC BY 4.0', short: 'CC BY', url: 'https://creativecommons.org/licenses/by/4.0/', desc: 'Others may distribute, remix, adapt, and build upon the work, even commercially, as long as credit is given.' },
  { id: 'cc-by-sa', label: 'CC BY-SA 4.0', short: 'CC BY-SA', url: 'https://creativecommons.org/licenses/by-sa/4.0/', desc: 'Others may remix, adapt, and build upon the work, even commercially, but must credit and license derivatives under identical terms.' },
  { id: 'cc-by-nc', label: 'CC BY-NC 4.0', short: 'CC BY-NC', url: 'https://creativecommons.org/licenses/by-nc/4.0/', desc: 'Others may remix, adapt, and build upon the work for non-commercial purposes only, with credit to the creator.' },
  { id: 'cc-by-nc-sa', label: 'CC BY-NC-SA 4.0', short: 'CC BY-NC-SA', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', desc: 'Others may remix, adapt, and build upon the work for non-commercial purposes only, with credit, and must license derivatives under identical terms.' },
  { id: 'cc-by-nd', label: 'CC BY-ND 4.0', short: 'CC BY-ND', url: 'https://creativecommons.org/licenses/by-nd/4.0/', desc: 'Others may copy and distribute the work in unadapted form only, even commercially, with credit to the creator.' },
  { id: 'cc-by-nc-nd', label: 'CC BY-NC-ND 4.0', short: 'CC BY-NC-ND', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/', desc: 'Others may copy and distribute the work in unadapted form only, for non-commercial purposes only, with credit to the creator.' },
  { id: 'cc0', label: 'CC0 1.0 (Public Domain)', short: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', desc: 'The creator waives all copyright and related rights. The work is dedicated to the public domain worldwide.' },
  { id: 'commercial', label: 'Commercial License', short: 'Commercial', url: null, desc: 'Custom commercial licensing terms. Contact the rights holder for specific usage permissions and fees.' },
];

// Commission basis points per edition (on-chain royalty field)
export const EDITION_ROYALTY_BPS = {
  [NFT_EDITION.OPEN]: 250,     // 2.5%
  [NFT_EDITION.LIMITED]: 350,  // 3.5%
};

// ============================================================================
// IPFS STORAGE CONFIGURATION
// Get your FREE API keys from:
// - NFT.storage: https://nft.storage (recommended, free forever)
// - Pinata: https://pinata.cloud (free tier available)
// ============================================================================

// NFT.storage API Key (get free at https://nft.storage/manage/)
const NFT_STORAGE_API_KEY = process.env.NFT_STORAGE_API_KEY || process.env.EXPO_PUBLIC_NFT_STORAGE_API_KEY || '';

// Pinata JWT (get free at https://app.pinata.cloud/developers/api-keys)
const PINATA_JWT = process.env.PINATA_JWT || process.env.EXPO_PUBLIC_PINATA_JWT || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiJjZWJmYjg0Ni04NTJjLTRmMTQtYjRmMS0zYTk4MjFiZDJiYmIiLCJlbWFpbCI6InZpa3Rvci52aXNoeW4uMzY5QGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaW5fcG9saWN5Ijp7InJlZ2lvbnMiOlt7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6IkZSQTEifSx7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6Ik5ZQzEifV0sInZlcnNpb24iOjF9LCJtZmFfZW5hYmxlZCI6ZmFsc2UsInN0YXR1cyI6IkFDVElWRSJ9LCJhdXRoZW50aWNhdGlvblR5cGUiOiJzY29wZWRLZXkiLCJzY29wZWRLZXlLZXkiOiIyNWI0ODcyZDg1ZDgzODgzMGY5MCIsInNjb3BlZEtleVNlY3JldCI6ImM5Yjc2Zjc3MjIzNTA0YTE2ZDVkNGE5MTE5ZDdiZjEzNzNhNTkxYzc4NTEyMGM4M2I5MmM3ZWFjYWU3OGRjZjAiLCJleHAiOjE3OTk4NzQzNTh9.YMv_l6T4RSh7HGxNaCVf7y-1w_FPKhdaCUBfmMotJpM';

// Pinata JWT Fallback (second account for rate limit overflow)
const PINATA_JWT_FALLBACK = process.env.PINATA_JWT_FALLBACK || process.env.EXPO_PUBLIC_PINATA_JWT_FALLBACK || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI1YmY5YWY4OS04YmY5LTRkYTMtYWU0ZS01YTUwZWRkYzUwMTAiLCJlbWFpbCI6InZpa3Rvci52aXNoeW4uOTYzQGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaW5fcG9saWN5Ijp7InJlZ2lvbnMiOlt7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6IkZSQTEifSx7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6Ik5ZQzEifV0sInZlcnNpb24iOjF9LCJtZmFfZW5hYmxlZCI6ZmFsc2UsInN0YXR1cyI6IkFDVElWRSJ9LCJhdXRoZW50aWNhdGlvblR5cGUiOiJzY29wZWRLZXkiLCJzY29wZWRLZXlLZXkiOiJlN2ZlZWY2OGVhMzg5ZTkxOGZhMSIsInNjb3BlZEtleVNlY3JldCI6IjJjNjBjNDIzNDQ4NWU3NTgzNTczZGVjMjhiNzlhZTFjZTA1NzFmNzU0OGFlNDc0YmFiMDk3NjkyYWY0ODVhNGUiLCJleHAiOjE4MDgzMTU2MzF9.3vc_6PKHz_n37kTQXq6h1pii-FWn3ioSP2HZsvKCKNQ';

// Pinata JWT Extra Fallback (third account for rate limit overflow)
const PINATA_JWT_EXTRA2 = process.env.PINATA_JWT_EXTRA2 || process.env.EXPO_PUBLIC_PINATA_JWT_EXTRA2 || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI2NDRmMDAwNC03M2U5LTQ4NDQtOWQwMi0xOTk4NGQ5NDMxN2MiLCJlbWFpbCI6InN1cHBvcnRAc3RlYWx0aGx5bmsuaW8iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGluX3BvbGljeSI6eyJyZWdpb25zIjpbeyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJGUkExIn0seyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJOWUMxIn1dLCJ2ZXJzaW9uIjoxfSwibWZhX2VuYWJsZWQiOmZhbHNlLCJzdGF0dXMiOiJBQ1RJVkUifSwiYXV0aGVudGljYXRpb25UeXBlIjoic2NvcGVkS2V5Iiwic2NvcGVkS2V5S2V5IjoiNGI5NWVjM2MzOWRjZGYwNzE4OWMiLCJzY29wZWRLZXlTZWNyZXQiOiJjMGFmODEzNzE4NjZkOTQyNzZkODViOTUyNTdjZjE3YzFkY2I5MTFjYWE2ZWZlNDI1MThiNzIwN2ExN2U1NjllIiwiZXhwIjoxODA5MDE2MTk0fQ.YntaybzjqSZ_DUh3HbJjDI6SVcp9bVAOPxUZq-4abhM';

// Akord API Key for Arweave permanent storage (get at https://akord.com)
const AKORD_API_KEY = process.env.AKORD_API_KEY || process.env.EXPO_PUBLIC_AKORD_API_KEY || '';

// NFT Collection info (optional - for grouping PhotoLynk NFTs)
const PHOTOLYNK_COLLECTION = {
  name: 'PhotoLynk Photo NFTs',
  symbol: 'PLNK',
  description: 'Photo NFTs minted with PhotoLynk on Solana Seeker',
};

// ============================================================================
// STATE
// ============================================================================

let connection = null;
let cachedSolPrice = null;
let solPriceLastFetch = 0;
const SOL_PRICE_CACHE_MS = 60000;
let _solPriceInflight = null; // dedup lock: concurrent callers share one fetch
const SOL_PRICE_STORAGE_KEY = 'photolynk_sol_price';
let cachedSkrPrice = null;
let skrPriceLastFetch = 0;
const SKR_PRICE_CACHE_MS = 60000;
let _skrPriceInflight = null;
let cachedSkrDecimals = null;

// Local NFT storage - using FileSystem instead of SecureStore to avoid 2KB limit
const NFT_STORAGE_KEY = 'photolynk_nfts';
const NFT_STORAGE_FILE = `${FileSystem.documentDirectory}photolynk_nfts.json`;
const NFT_TRANSFERRED_OUT_KEY = 'photolynk_nft_transferred_out_blacklist';
let _transferredOutCache = null;
const getTransferredOutBlacklist = async () => {
  if (_transferredOutCache) return _transferredOutCache;
  try {
    const raw = await SecureStore.getItemAsync(NFT_TRANSFERRED_OUT_KEY);
    _transferredOutCache = new Set(raw ? JSON.parse(raw) : []);
  } catch (_) { _transferredOutCache = new Set(); }
  return _transferredOutCache;
};
export const addToTransferredOutBlacklist = async (assetId) => {
  if (!assetId) return;
  const bl = await getTransferredOutBlacklist();
  const normalized = String(assetId).replace(/^cnft_/, '').trim();
  if (!normalized || bl.has(normalized)) return;
  bl.add(normalized);
  bl.add(`cnft_${normalized}`);
  _transferredOutCache = bl;
  try { await SecureStore.setItemAsync(NFT_TRANSFERRED_OUT_KEY, JSON.stringify([...bl])); } catch (_) { }
};

// ============================================================================
// UNIVERSAL WALLET HELPERS
// ============================================================================

/**
 * Get connected wallet address using WalletAdapter or MWA fallback
 * @returns {Object} { success, address, pubkey, walletType, error }
 */
export const getConnectedWalletAddress = async () => {
  // Try WalletAdapter first (supports multiple wallets)
  if (walletAdapterAvailable && WalletAdapter) {
    try {
      await WalletAdapter.initializeWalletAdapter();
      let status = WalletAdapter.getConnectionStatus();

      if (!status.isConnected) {
        // Try to connect to best available wallet
        const connectResult = await WalletAdapter.connectBestWallet();
        if (!connectResult.success) {
          // Fall back to MWA
          console.log('[NFT] WalletAdapter connect failed, falling back to MWA');
        } else {
          status = WalletAdapter.getConnectionStatus();
        }
      }

      if (status.isConnected && status.address) {
        const pubkey = new PublicKey(status.address);
        return {
          success: true,
          address: status.address,
          pubkey,
          walletType: status.walletType,
        };
      }
    } catch (e) {
      console.log('[NFT] WalletAdapter error, falling back to MWA:', e.message);
    }
  }

  // Fallback to MWA (original behavior)
  if (!transact) {
    return { success: false, error: 'No wallet available' };
  }

  try {
    let address, pubkey;
    await transact(async (wallet) => {
      const authResult = await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
      });

      const ownerAddress = authResult.accounts[0].address;
      const ownerBytes = typeof ownerAddress === 'string'
        ? Uint8Array.from(atob(ownerAddress), c => c.charCodeAt(0))
        : new Uint8Array(ownerAddress);
      pubkey = new PublicKey(ownerBytes);
      address = pubkey.toBase58();
    });

    return { success: true, address, pubkey, walletType: 'mwa' };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

export const purgeNFTStorage = async () => {
  try {
    // Best-effort clear image cache for any stored NFTs
    try {
      const existing = await getStoredNFTs();
      for (const nft of existing) {
        try {
          if (nft?.imageUrl) await removeNFTImageFromCache(nft.imageUrl);
          if (nft?.thumbnailUrl) await removeNFTImageFromCache(nft.thumbnailUrl);
          if (nft?.arweaveUrl) await removeNFTImageFromCache(nft.arweaveUrl);
        } catch (_) { }
      }
    } catch (_) { }

    // Clear persisted NFT + certificate files
    try { await FileSystem.writeAsStringAsync(NFT_STORAGE_FILE, JSON.stringify([])); } catch (_) { }
    try { await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify([])); } catch (_) { }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

/**
 * Sign and send transaction using WalletAdapter or MWA fallback
 * @param {VersionedTransaction} transaction - Transaction to sign and send
 * @param {string} walletType - Current wallet type (for routing)
 * @returns {Object} { success, signature, error }
 */
const universalSignAndSend = async (transaction, walletType = null) => {
  // Use WalletAdapter if available and connected
  if (walletAdapterAvailable && WalletAdapter && walletType !== 'mwa') {
    try {
      const status = WalletAdapter.getConnectionStatus();
      if (status.isConnected) {
        const result = await WalletAdapter.signAndSendTransaction(transaction);
        return result;
      }
    } catch (e) {
      console.log('[NFT] WalletAdapter signAndSend failed, falling back to MWA:', e.message);
    }
  }

  // Fallback to MWA
  if (!transact) {
    return { success: false, error: 'No wallet available' };
  }

  try {
    const signature = await transact(async (wallet) => {
      await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
      });

      const signatures = await wallet.signAndSendTransactions({
        transactions: [transaction],
      });

      return signatures[0];
    });

    return { success: true, signature };
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    return { success: false, error: e.message };
  }
};

/**
 * Execute a transact session - uses MWA for complex inline operations
 * For operations that need to build transactions inside the wallet session
 * @param {Function} callback - Async function receiving wallet object
 * @returns {any} Result from callback
 */
const executeWalletSession = async (callback) => {
  if (!transact) {
    throw new Error('Mobile Wallet Adapter not available');
  }
  return await transact(callback);
};

/**
 * Universal sign transaction - works with all wallet types
 * Returns signed transaction for manual sending
 * @param {VersionedTransaction} transaction - Transaction to sign
 * @param {string} walletType - Current wallet type
 * @returns {Object} { success, signedTransaction, error }
 */
const universalSignTransaction = async (transaction, walletType = null) => {
  // Use WalletAdapter if available and not MWA
  if (walletAdapterAvailable && WalletAdapter && walletType && walletType !== 'mwa') {
    try {
      const status = WalletAdapter.getConnectionStatus();
      if (status.isConnected) {
        console.log('[NFT] Using WalletAdapter for signing (wallet:', walletType, ')');
        // WalletAdapter's signAndSendTransaction handles signing internally
        // For sign-only, we need to use the adapter's sign method if available
        const result = await WalletAdapter.signAndSendTransaction(transaction);
        if (result.success) {
          return { success: true, signature: result.signature, sentViaAdapter: true };
        }
        return result;
      }
    } catch (e) {
      console.log('[NFT] WalletAdapter sign failed:', e.message);
      // Fall through to MWA
    }
  }

  // Use MWA for signing
  if (!transact) {
    return { success: false, error: 'No wallet available for signing' };
  }

  try {
    console.log('[NFT] Using MWA for signing');
    const signedTx = await transact(async (wallet) => {
      await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
      });

      const signedTransactions = await wallet.signTransactions({
        transactions: [transaction],
      });

      return signedTransactions[0];
    });

    return { success: true, signedTransaction: signedTx };
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    return { success: false, error: e.message };
  }
};

/**
 * Check if any wallet is available for NFT operations
 * @returns {boolean}
 */
const isWalletAvailable = () => {
  if (walletAdapterAvailable && WalletAdapter) {
    return true;
  }
  return !!transact;
};

// ============================================================================
// METAPLEX TOKEN METADATA INSTRUCTION BUILDERS
// ============================================================================

/**
 * Create instruction to create metadata account v3
 * This is a manual implementation of the Metaplex instruction
 */
const createMetadataAccountV3Instruction = (
  metadataAccount,
  mint,
  mintAuthority,
  payer,
  updateAuthority,
  name,
  symbol,
  uri,
  sellerFeeBasisPoints,
  creators,
  tokenMetadataProgramId
) => {
  // Metaplex Token Metadata Program instruction discriminator for CreateMetadataAccountV3
  const INSTRUCTION_DISCRIMINATOR = 33; // CreateMetadataAccountV3

  // Serialize the data
  const nameBytes = Buffer.from(name.slice(0, 32).padEnd(32, '\0'));
  const symbolBytes = Buffer.from(symbol.slice(0, 10).padEnd(10, '\0'));
  const uriBytes = Buffer.from(uri.slice(0, 200).padEnd(200, '\0'));

  // Build data buffer
  // Format: discriminator (1) + name length (4) + name + symbol length (4) + symbol + uri length (4) + uri + seller_fee (2) + creators option + collection option + uses option + isMutable (1) + collectionDetails option
  const data = Buffer.alloc(1 + 4 + name.length + 4 + symbol.length + 4 + uri.length + 2 + 1 + 1 + 1 + 1 + 1);
  let offset = 0;

  // Discriminator
  data.writeUInt8(INSTRUCTION_DISCRIMINATOR, offset);
  offset += 1;

  // Name (borsh string: 4 byte length + string)
  data.writeUInt32LE(name.length, offset);
  offset += 4;
  data.write(name, offset);
  offset += name.length;

  // Symbol
  data.writeUInt32LE(symbol.length, offset);
  offset += 4;
  data.write(symbol, offset);
  offset += symbol.length;

  // URI
  data.writeUInt32LE(uri.length, offset);
  offset += 4;
  data.write(uri, offset);
  offset += uri.length;

  // Seller fee basis points
  data.writeUInt16LE(sellerFeeBasisPoints, offset);
  offset += 2;

  // Creators (Option<Vec<Creator>>): None for simplicity
  data.writeUInt8(0, offset); // None
  offset += 1;

  // Collection (Option<Collection>): None
  data.writeUInt8(0, offset);
  offset += 1;

  // Uses (Option<Uses>): None
  data.writeUInt8(0, offset);
  offset += 1;

  // Is mutable
  data.writeUInt8(1, offset); // true
  offset += 1;

  // Collection details (Option<CollectionDetails>): None
  data.writeUInt8(0, offset);

  const finalData = data.slice(0, offset + 1);

  return {
    keys: [
      { pubkey: metadataAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    programId: tokenMetadataProgramId,
    data: finalData,
  };
};

/**
 * Create instruction to create master edition v3
 */
const createMasterEditionV3Instruction = (
  masterEdition,
  mint,
  updateAuthority,
  mintAuthority,
  metadata,
  payer,
  maxSupply,
  tokenMetadataProgramId
) => {
  // Instruction discriminator for CreateMasterEditionV3
  const INSTRUCTION_DISCRIMINATOR = 17;

  // Data: discriminator (1) + max_supply option (1 + 8 if Some)
  const data = Buffer.alloc(10);
  let offset = 0;

  data.writeUInt8(INSTRUCTION_DISCRIMINATOR, offset);
  offset += 1;

  // Max supply (Option<u64>): Some(0) means no prints allowed
  if (maxSupply !== null && maxSupply !== undefined) {
    data.writeUInt8(1, offset); // Some
    offset += 1;
    // Write u64 as two u32s (React Native Buffer doesn't support BigInt)
    const supply = Number(maxSupply);
    data.writeUInt32LE(supply & 0xFFFFFFFF, offset);
    data.writeUInt32LE(Math.floor(supply / 0x100000000) & 0xFFFFFFFF, offset + 4);
    offset += 8;
  } else {
    data.writeUInt8(0, offset); // None (unlimited)
    offset += 1;
  }

  const finalData = data.slice(0, offset);

  return {
    keys: [
      { pubkey: masterEdition, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: updateAuthority, isSigner: true, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    programId: tokenMetadataProgramId,
    data: finalData,
  };
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize NFT module
 */
export const initializeNFT = async () => {
  if (!solanaAvailable) {
    console.log('[NFT] Solana not available');
    return false;
  }

  try {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    // Initialize Metaplex Token Metadata Program ID
    TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    console.log('[NFT] Module initialized');
    return true;
  } catch (e) {
    console.error('[NFT] Init failed:', e);
    return false;
  }
};

// Resilient blockhash fetch — tries primary RPC, then fallbacks
async function getLatestBlockhashWithRetry(commitment = 'confirmed') {
  try {
    return await connection.getLatestBlockhash(commitment);
  } catch (primaryErr) {
    console.warn('[NFT] Primary RPC failed for blockhash:', primaryErr?.message);
  }
  for (const rpcUrl of SOLANA_RPC_FALLBACKS) {
    try {
      console.log('[NFT] Trying fallback RPC:', rpcUrl.slice(0, 50));
      const fallbackConn = new Connection(rpcUrl, commitment);
      const result = await fallbackConn.getLatestBlockhash(commitment);
      connection = fallbackConn;
      console.log('[NFT] Switched to fallback RPC');
      return result;
    } catch (_) { continue; }
  }
  throw new Error('All Solana RPC endpoints failed for blockhash');
}

// ============================================================================
// SOL PRICE (reuse from solanaPurchases pattern)
// ============================================================================

/**
 * Fetch current SOL price in USD
 */
export const fetchSolPrice = async () => {
  if (cachedSolPrice && cachedSolPrice > 10 && (Date.now() - solPriceLastFetch) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice;
  }

  // Dedup: if a fetch is already in flight, all callers share the same promise
  if (_solPriceInflight) {
    return _solPriceInflight;
  }

  const doFetch = async () => {
    const now = Date.now();
    // Try to load persisted price if no memory cache
    if (!cachedSolPrice) {
      try {
        const stored = await SecureStore.getItemAsync(SOL_PRICE_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed.price > 0) {
            cachedSolPrice = parsed.price;
            console.log('[NFT] Loaded persisted SOL price:', cachedSolPrice);
          }
        }
      } catch (e) {
        console.log('[NFT] Could not load persisted price:', e.message);
      }
    }

    const priceApis = [
      { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', extract: (d) => d?.solana?.usd },
      { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', extract: (d) => parseFloat(d?.price) },
      { name: 'CoinCap', url: 'https://api.coincap.io/v2/assets/solana', extract: (d) => parseFloat(d?.data?.priceUsd) },
      { name: 'Jupiter', url: 'https://price.jup.ag/v4/price?ids=SOL', extract: (d) => d?.data?.SOL?.price },
    ];

    for (const api of priceApis) {
      try {
        console.log('[NFT] Fetching SOL price from', api.name);
        const response = await axios.get(api.url, { timeout: 8000 });
        const price = api.extract(response.data);
        if (price && typeof price === 'number' && price > 0) {
          cachedSolPrice = price;
          solPriceLastFetch = now;
          console.log('[NFT] SOL price from', api.name + ':', price);
          try {
            await SecureStore.setItemAsync(SOL_PRICE_STORAGE_KEY, JSON.stringify({ price, timestamp: now }));
          } catch (e) {
            console.log('[NFT] Could not persist price:', e.message);
          }
          return price;
        }
        console.log('[NFT]', api.name, 'returned invalid price:', price);
      } catch (e) {
        console.log('[NFT]', api.name, 'failed:', e.message);
      }
    }

    // Fallback to last stored price if all APIs fail
    if (cachedSolPrice && cachedSolPrice > 0) {
      console.log('[NFT] All price APIs failed, using last stored price:', cachedSolPrice);
      return cachedSolPrice;
    }

    console.error('[NFT] All price APIs failed and no stored price available');
    return null;
  };

  _solPriceInflight = doFetch().finally(() => { _solPriceInflight = null; });
  return _solPriceInflight;
};

/**
 * Convert USD to SOL
 */
export const usdToSol = async (usdAmount) => {
  const solPrice = await fetchSolPrice();
  return usdAmount / solPrice;
};

const normalizePaymentMethod = (paymentMethod) => {
  return paymentMethod === NFT_PAYMENT_METHODS.SKR ? NFT_PAYMENT_METHODS.SKR : NFT_PAYMENT_METHODS.SOL;
};

const formatTokenAmount = (amount) => {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0';
  if (numeric >= 1000) return numeric.toFixed(0);
  if (numeric >= 100) return numeric.toFixed(1);
  if (numeric >= 10) return numeric.toFixed(2);
  if (numeric >= 1) return numeric.toFixed(3);
  return numeric.toFixed(4);
};

const toTokenBaseUnits = (amount, decimals) => {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const scale = Math.pow(10, Math.max(0, decimals || 0));
  return Math.max(1, Math.ceil(numeric * scale));
};

export const fetchWeeklyNftDiscountQuote = async (serverConfig = null, walletAddress = '') => {
  if (!serverConfig?.baseUrl) return NFT_WEEKLY_DISCOUNT_FALLBACK;
  try {
    const headers = await getServerHeadersFromConfig(serverConfig);
    const params = walletAddress ? { walletAddress } : undefined;
    const response = await axios.get(`${serverConfig.baseUrl}/api/nft/weekly-discount`, {
      headers,
      params,
      timeout: 10000,
    });
    const quote = response.data?.quote || {};
    const discountPercent = Math.min(100, Math.max(0, Number(quote.discountPercent || 0)));
    return {
      ...NFT_WEEKLY_DISCOUNT_FALLBACK,
      ...quote,
      discountPercent,
      multiplier: Math.max(0, Math.min(1, Number(quote.multiplier ?? ((100 - discountPercent) / 100)))),
      weeklyMintCount: Math.max(0, Number(quote.weeklyMintCount || 0)),
      nextDiscountPercent: Math.min(100, Number(quote.nextDiscountPercent ?? (discountPercent + 10))),
      streakCount: Math.max(0, Number(quote.streakCount || 0)),
      streakBonusPercent: Math.min(80, Number(quote.streakBonusPercent || 0)),
      mintsToMaxDiscount: Math.max(0, Number(quote.mintsToMaxDiscount ?? (9 - Number(quote.weeklyMintCount || 0)))),
    };
  } catch (e) {
    console.log('[NFT] Weekly discount quote unavailable:', e.message);
    return NFT_WEEKLY_DISCOUNT_FALLBACK;
  }
};

export const fetchSkrPrice = async () => {
  if (cachedSkrPrice && cachedSkrPrice > 0 && (Date.now() - skrPriceLastFetch) < SKR_PRICE_CACHE_MS) {
    return cachedSkrPrice;
  }

  if (_skrPriceInflight) {
    return _skrPriceInflight;
  }

  const doFetch = async () => {
    const now = Date.now();
    const priceApis = [
      {
        name: 'Jupiter',
        url: `https://price.jup.ag/v4/price?ids=${SKR_TOKEN_MINT}`,
        extract: (d) => Number(d?.data?.[SKR_TOKEN_MINT]?.price),
      },
      {
        name: 'DexScreener',
        url: `https://api.dexscreener.com/latest/dex/tokens/${SKR_TOKEN_MINT}`,
        extract: (d) => {
          const pairs = Array.isArray(d?.pairs) ? d.pairs : [];
          if (!pairs.length) return 0;
          const bestPair = pairs
            .map((pair) => ({
              priceUsd: Number(pair?.priceUsd),
              liquidityUsd: Number(pair?.liquidity?.usd || 0),
            }))
            .filter((pair) => Number.isFinite(pair.priceUsd) && pair.priceUsd > 0)
            .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
          return Number(bestPair?.priceUsd || 0);
        },
      },
      {
        name: 'CoinGecko',
        url: `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${SKR_TOKEN_MINT}&vs_currencies=usd`,
        extract: (d) => Number(d?.[SKR_TOKEN_MINT.toLowerCase()]?.usd),
      },
    ];

    for (const api of priceApis) {
      try {
        const response = await axios.get(api.url, { timeout: 8000 });
        const price = api.extract(response.data);
        if (Number.isFinite(price) && price > 0) {
          cachedSkrPrice = price;
          skrPriceLastFetch = now;
          return price;
        }
      } catch (_) {
      }
    }

    if (cachedSkrPrice && cachedSkrPrice > 0) {
      return cachedSkrPrice;
    }

    throw new Error('Unable to fetch SKR price');
  };

  _skrPriceInflight = doFetch().finally(() => { _skrPriceInflight = null; });
  return _skrPriceInflight;
};

export const fetchSkrTokenDecimals = async () => {
  if (typeof cachedSkrDecimals === 'number' && cachedSkrDecimals >= 0) {
    return cachedSkrDecimals;
  }
  if (!connection) {
    await initializeNFT();
  }
  const mintInfo = await getMint(connection, new PublicKey(SKR_TOKEN_MINT));
  cachedSkrDecimals = Number(mintInfo?.decimals ?? 0);
  return cachedSkrDecimals;
};

const normalizeWeeklyDiscountQuote = (weeklyDiscountQuote = null) => {
  const discountPercent = Math.min(100, Math.max(0, Number(weeklyDiscountQuote?.discountPercent || 0)));
  return {
    ...NFT_WEEKLY_DISCOUNT_FALLBACK,
    ...(weeklyDiscountQuote || {}),
    discountPercent,
    multiplier: Math.max(0, Math.min(1, Number(weeklyDiscountQuote?.multiplier ?? ((100 - discountPercent) / 100)))),
  };
};

const buildSkrCommissionQuote = async (commissionUsd, weeklyDiscountQuote = null) => {
  const originalUsd = Math.max(0, Number(commissionUsd || 0));
  const discountQuote = normalizeWeeklyDiscountQuote(weeklyDiscountQuote);
  const discountedUsd = Math.max(0.03, Math.round(originalUsd * discountQuote.multiplier * 10000) / 10000);
  const [priceUsd, decimals] = await Promise.all([
    fetchSkrPrice(),
    fetchSkrTokenDecimals(),
  ]);
  const tokenAmount = discountedUsd / priceUsd;
  const amountRaw = toTokenBaseUnits(tokenAmount, decimals);
  return {
    originalUsd,
    discountedUsd,
    savingsUsd: Math.max(0, originalUsd - discountedUsd),
    discount: discountQuote,
    token: {
      symbol: SKR_TOKEN_SYMBOL,
      mint: SKR_TOKEN_MINT,
      priceUsd,
      decimals,
      amount: tokenAmount,
      amountRaw,
      amountFormatted: formatTokenAmount(tokenAmount),
    },
  };
};

// ============================================================================
// EXIF EXTRACTION
// ============================================================================

/**
 * Extract EXIF data from asset for NFT metadata
 * @param {Object} asset - MediaLibrary asset
 * @param {Object} info - Asset info from getAssetInfoAsync
 * @returns {Object} EXIF metadata for NFT
 */
export const extractExifForNFT = (asset, info) => {
  const exif = info?.exif || {};

  // Build NFT-friendly EXIF object
  const nftExif = {
    // Core photo info
    dateTaken: null,
    camera: null,
    lens: null,

    // Technical settings
    iso: exif.ISOSpeedRatings || exif.ISO || null,
    aperture: exif.FNumber || exif.ApertureValue || null,
    shutterSpeed: exif.ExposureTime || exif.ShutterSpeedValue || null,
    focalLength: exif.FocalLength || null,

    // Location (if available)
    latitude: exif.GPSLatitude || null,
    longitude: exif.GPSLongitude || null,
    altitude: exif.GPSAltitude || null,

    // Device info
    make: exif.Make || null,
    model: exif.Model || null,
    software: exif.Software || null,

    // Image dimensions
    width: asset.width || exif.PixelXDimension || null,
    height: asset.height || exif.PixelYDimension || null,
    orientation: exif.Orientation || null,

    // Future: embedded SOL gift (private key placeholder)
    // solGift: null, // Will be populated when feature is added
  };

  // Parse date
  const dateFields = ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime', 'CreateDate'];
  for (const field of dateFields) {
    if (exif[field]) {
      try {
        // EXIF date format: "YYYY:MM:DD HH:MM:SS"
        const dateStr = exif[field].replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
        nftExif.dateTaken = new Date(dateStr).toISOString();
        break;
      } catch (e) {
        // Continue to next field
      }
    }
  }

  // Fallback to asset creation time
  if (!nftExif.dateTaken && asset.creationTime) {
    nftExif.dateTaken = new Date(asset.creationTime).toISOString();
  }

  // Build camera string
  if (nftExif.make || nftExif.model) {
    nftExif.camera = [nftExif.make, nftExif.model].filter(Boolean).join(' ');
  }

  return nftExif;
};

// ============================================================================
// EXIF STRIPPING FOR PRIVACY
// ============================================================================

/**
 * Strip EXIF data from an image for privacy
 * Creates a clean copy without date, location, device info
 * @param {string} filePath - Original file path
 * @returns {Object} { success, cleanPath, error }
 */
export const stripExifFromImage = async (filePath) => {
  try {
    // Validate file path
    if (!filePath) {
      console.log('[NFT] No file path provided for EXIF stripping');
      return { success: true, cleanPath: filePath, stripped: false };
    }

    // Check if file exists
    let fileInfo;
    try {
      fileInfo = await FileSystem.getInfoAsync(filePath);
    } catch (infoErr) {
      console.warn('[NFT] Could not check file info:', infoErr?.message);
      return { success: true, cleanPath: filePath, stripped: false };
    }

    if (!fileInfo || !fileInfo.exists) {
      console.log('[NFT] File does not exist:', filePath);
      return { success: true, cleanPath: filePath, stripped: false };
    }

    // For React Native, use expo-image-manipulator which re-encodes and strips EXIF
    if (!ImageManipulator || !ImageManipulator.manipulateAsync) {
      console.log('[NFT] expo-image-manipulator not available, using original');
      return { success: true, cleanPath: filePath, stripped: false };
    }

    // Determine output format based on input file extension
    const lowerPath = (filePath || '').toLowerCase();
    const isPng = lowerPath.endsWith('.png');
    const outputFormat = isPng ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG;
    const compress = isPng ? 1.0 : 0.95; // PNG is lossless, JPEG use high quality

    console.log('[NFT] Stripping EXIF from:', filePath, 'format:', isPng ? 'PNG' : 'JPEG');

    // Use ImageManipulator to re-encode without EXIF
    // The manipulate function with no operations still re-encodes and strips EXIF
    const result = await ImageManipulator.manipulateAsync(
      filePath,
      [], // No transformations, just re-encode
      {
        compress,
        format: outputFormat,
      }
    );

    // Verify the result has a valid URI
    if (!result || !result.uri) {
      console.warn('[NFT] ImageManipulator returned no URI, using original');
      return { success: true, cleanPath: filePath, stripped: false };
    }

    console.log('[NFT] EXIF stripped successfully, clean image at:', result.uri);

    return {
      success: true,
      cleanPath: result.uri,
      stripped: true,
    };
  } catch (e) {
    console.warn('[NFT] EXIF stripping failed, using original:', e?.message || e);
    return { success: true, cleanPath: filePath, stripped: false };
  }
};

// ============================================================================
// EXIF HASH (deterministic cross-platform hash of EXIF metadata)
// ============================================================================

/**
 * Compute deterministic cross-platform SHA256 hash of EXIF metadata.
 *
 * iOS and Android re-encode JPEG files differently — raw EXIF binary, thumbnails,
 * IFD structure, and even pixel data differ for the same photo. Hashing raw EXIF
 * binary will NEVER match cross-platform.
 *
 * Instead, we parse EXIF TIFF IFD entries from the raw APP1 segment, keep only
 * stable camera-related fields (stripping thumbnails, MakerNote, Software, UUIDs),
 * sort deterministically, and hash the normalized JSON. This produces identical
 * hashes on mobile (raw TIFF parsing) and desktop (sharp + exif-reader).
 *
 * Returns null if no meaningful EXIF fields are found (e.g. EXIF-stripped files).
 *
 * @param {string} filePath - Path to the JPEG file
 * @returns {Promise<string|null>} SHA256 hex hash or null
 */
export const computeExifHash = async (filePath, preReadBase64 = null) => {
  if (!filePath && !preReadBase64) return null;
  try {
    const base64Content = preReadBase64 || await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binaryString = atob(base64Content);

    // Find APP1 EXIF segment in JPEG
    let tiffBytes = null;
    for (let i = 0; i < binaryString.length - 4; i++) {
      if (binaryString.charCodeAt(i) === 0xFF && binaryString.charCodeAt(i + 1) === 0xE1) {
        const segLen = (binaryString.charCodeAt(i + 2) << 8) | binaryString.charCodeAt(i + 3);
        const segData = binaryString.substring(i + 4, i + 2 + segLen);
        if (segData.length >= 6 &&
          segData.charCodeAt(0) === 0x45 && segData.charCodeAt(1) === 0x78 &&
          segData.charCodeAt(2) === 0x69 && segData.charCodeAt(3) === 0x66 &&
          segData.charCodeAt(4) === 0x00 && segData.charCodeAt(5) === 0x00) {
          // TIFF data starts after "Exif\0\0" (6 bytes)
          const tiffStr = segData.substring(6);
          tiffBytes = new Uint8Array(tiffStr.length);
          for (let j = 0; j < tiffStr.length; j++) tiffBytes[j] = tiffStr.charCodeAt(j);
          break;
        }
      }
    }
    // === HEIC/HEIF: scan ISOBMFF container for "Exif\0\0" + TIFF header ===
    if (!tiffBytes) {
      const b = (i) => binaryString.charCodeAt(i);
      // Check ftyp box: bytes 4-7 = 'ftyp'
      if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
        const scanLen = Math.min(binaryString.length, 512 * 1024);
        for (let pos = 0; pos + 10 < scanLen; pos++) {
          if (b(pos) === 0x45 && b(pos + 1) === 0x78 && b(pos + 2) === 0x69 && b(pos + 3) === 0x66 &&
            b(pos + 4) === 0x00 && b(pos + 5) === 0x00) {
            if ((b(pos + 6) === 0x49 && b(pos + 7) === 0x49) || (b(pos + 6) === 0x4D && b(pos + 7) === 0x4D)) {
              // Found EXIF — extract TIFF data (skip "Exif\0\0" prefix)
              const tiffStart = pos + 6;
              // Estimate TIFF extent: scan up to 64KB or end of file
              const tiffLen = Math.min(65536, scanLen - tiffStart);
              tiffBytes = new Uint8Array(tiffLen);
              for (let j = 0; j < tiffLen; j++) tiffBytes[j] = binaryString.charCodeAt(tiffStart + j);
              console.log('[NFT] HEIC EXIF: extracted ' + tiffLen + ' TIFF bytes for normalized hash');
              break;
            }
          }
        }
      }
    }

    if (!tiffBytes || tiffBytes.length < 8) {
      console.log('[NFT] No EXIF APP1/HEIC segment found in file');
      return null;
    }

    // Parse TIFF header
    const isLE = tiffBytes[0] === 0x49 && tiffBytes[1] === 0x49; // 'II' = little-endian
    const u16 = (off) => isLE
      ? (tiffBytes[off] | (tiffBytes[off + 1] << 8))
      : ((tiffBytes[off] << 8) | tiffBytes[off + 1]);
    const u32 = (off) => isLE
      ? (tiffBytes[off] | (tiffBytes[off + 1] << 8) | (tiffBytes[off + 2] << 16) | ((tiffBytes[off + 3] << 24) >>> 0))
      : (((tiffBytes[off] << 24) >>> 0) | (tiffBytes[off + 1] << 16) | (tiffBytes[off + 2] << 8) | tiffBytes[off + 3]);

    // EXIF tag IDs we care about (must match desktop computeExifHash field list)
    const EXIF_TAGS = {
      // IFD0
      0x010F: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
      // ExifIFD
      0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
      0x829A: 'ExposureTime', 0x829D: 'FNumber',
      0x8827: 'ISO', 0x920A: 'FocalLength', 0xA405: 'FocalLengthIn35mm',
      0xA402: 'ExposureMode', 0xA403: 'WhiteBalance', 0x9207: 'MeteringMode',
      0x9209: 'Flash', 0xA001: 'ColorSpace',
      0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension',
      0xA406: 'SceneCaptureType',
      0xA433: 'LensMake', 0xA434: 'LensModel', 0xA431: 'BodySerialNumber',
      // GPS
      0x0002: 'GPSLatitude_raw', 0x0004: 'GPSLongitude_raw',
      0x0006: 'GPSAltitude_raw',
      0x0001: 'GPSLatitudeRef', 0x0003: 'GPSLongitudeRef',
    };
    // Sub-IFD pointer tags
    const SUB_IFD_TAGS = { 0x8769: 'ExifIFD', 0x8825: 'GPSIFD' };

    const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

    const readString = (off, cnt) => {
      let s = '';
      for (let k = 0; k < cnt && off + k < tiffBytes.length; k++) {
        const c = tiffBytes[off + k];
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    };

    const readRational = (off) => {
      const num = u32(off);
      const den = u32(off + 4);
      return den !== 0 ? num / den : 0;
    };

    const readSRational = (off) => {
      let num = u32(off);
      if (num >= 0x80000000) num -= 0x100000000;
      const den = u32(off + 4);
      return den !== 0 ? num / den : 0;
    };

    const readValue = (off, typ, cnt) => {
      const totalBytes = (TYPE_SIZES[typ] || 1) * cnt;
      const valOff = totalBytes <= 4 ? off + 8 : u32(off + 8);
      if (valOff + totalBytes > tiffBytes.length) return null;
      if (typ === 2) return readString(valOff, cnt); // ASCII
      if (typ === 3 && cnt === 1) return u16(valOff); // SHORT
      if (typ === 4 && cnt === 1) return u32(valOff); // LONG
      if (typ === 5 && cnt === 1) return readRational(valOff); // RATIONAL
      if (typ === 10 && cnt === 1) return readSRational(valOff); // SRATIONAL
      if (typ === 5 && cnt === 3) { // 3x RATIONAL (GPS coordinates)
        const d = readRational(valOff);
        const m = readRational(valOff + 8);
        const s = readRational(valOff + 16);
        return d + m / 60 + s / 3600;
      }
      return null;
    };

    const parseIFD = (ifdOff, tagMap, result, subIfdMap) => {
      if (ifdOff + 2 > tiffBytes.length) return;
      const numEntries = u16(ifdOff);
      for (let idx = 0; idx < numEntries; idx++) {
        const entryOff = ifdOff + 2 + idx * 12;
        if (entryOff + 12 > tiffBytes.length) break;
        const tag = u16(entryOff);
        const typ = u16(entryOff + 2);
        const cnt = u32(entryOff + 4);
        // Check for sub-IFD pointers
        if (subIfdMap && subIfdMap[tag]) {
          const subOff = u32(entryOff + 8);
          result['_sub_' + subIfdMap[tag]] = subOff;
          continue;
        }
        const name = tagMap[tag];
        if (!name) continue;
        const val = readValue(entryOff, typ, cnt);
        if (val != null) result[name] = val;
      }
    };

    // Parse IFD0 + sub-IFDs
    const ifd0Off = u32(4);
    const raw = {};
    parseIFD(ifd0Off, EXIF_TAGS, raw, SUB_IFD_TAGS);
    if (raw._sub_ExifIFD) parseIFD(raw._sub_ExifIFD, EXIF_TAGS, raw, null);
    if (raw._sub_GPSIFD) parseIFD(raw._sub_GPSIFD, EXIF_TAGS, raw, null);

    // Build normalized object (must match desktop computeExifHash exactly)
    // Round non-GPS decimals to 4dp, trunc GPS to 4dp for cross-platform stability.
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const t4 = (v) => Math.trunc(v * 1e4) / 1e4;
    const num4 = (v) => { const n = Number(v); return Number.isInteger(n) ? n : r4(n); };
    const normalized = {};
    if (raw.Make) normalized.Make = String(raw.Make).trim();
    if (raw.Model) normalized.Model = String(raw.Model).trim();
    if (raw.Orientation != null) normalized.Orientation = Number(raw.Orientation);
    const dto = raw.DateTimeOriginal || raw.DateTimeDigitized;
    if (dto) normalized.DateTimeOriginal = String(dto).slice(0, 19);
    if (raw.ExposureTime != null) normalized.ExposureTime = num4(raw.ExposureTime);
    if (raw.FNumber != null) normalized.FNumber = num4(raw.FNumber);
    if (raw.ISO != null) normalized.ISO = num4(raw.ISO);
    if (raw.FocalLength != null) normalized.FocalLength = num4(raw.FocalLength);
    if (raw.FocalLengthIn35mm != null) normalized.FocalLengthIn35mm = num4(raw.FocalLengthIn35mm);
    if (raw.ExposureMode != null) normalized.ExposureMode = num4(raw.ExposureMode);
    if (raw.WhiteBalance != null) normalized.WhiteBalance = num4(raw.WhiteBalance);
    if (raw.MeteringMode != null) normalized.MeteringMode = num4(raw.MeteringMode);
    if (raw.Flash != null) normalized.Flash = num4(raw.Flash);
    if (raw.ColorSpace != null) normalized.ColorSpace = num4(raw.ColorSpace);
    if (raw.PixelXDimension != null) normalized.PixelXDimension = num4(raw.PixelXDimension);
    if (raw.PixelYDimension != null) normalized.PixelYDimension = num4(raw.PixelYDimension);
    if (raw.SceneCaptureType != null) normalized.SceneCaptureType = num4(raw.SceneCaptureType);
    if (raw.LensMake) normalized.LensMake = String(raw.LensMake).trim();
    if (raw.LensModel) normalized.LensModel = String(raw.LensModel).trim();
    if (raw.BodySerialNumber) normalized.BodySerialNumber = String(raw.BodySerialNumber).trim();
    // GPS: convert DMS to decimal degrees (matching desktop exif-reader output)
    if (raw.GPSLatitude_raw != null) {
      let lat = Number(raw.GPSLatitude_raw);
      if (raw.GPSLatitudeRef === 'S') lat = -lat;
      normalized.GPSLatitude = t4(lat);
    }
    if (raw.GPSLongitude_raw != null) {
      let lon = Number(raw.GPSLongitude_raw);
      if (raw.GPSLongitudeRef === 'W') lon = -lon;
      normalized.GPSLongitude = t4(lon);
    }
    if (raw.GPSAltitude_raw != null) normalized.GPSAltitude = t4(Number(raw.GPSAltitude_raw));

    if (Object.keys(normalized).length === 0) {
      console.log('[NFT] EXIF hash: no meaningful fields found, returning null');
      return null;
    }

    // Universal decimal safety net: round non-GPS numerics to 4dp, trunc GPS to 4dp.
    // This catches any numeric field (current or future) that may have cross-platform float drift.
    const GPS_KEYS = new Set(['GPSLatitude', 'GPSLongitude', 'GPSAltitude']);
    const sorted = {};
    for (const key of Object.keys(normalized).sort()) {
      let v = normalized[key];
      if (typeof v === 'number' && !Number.isInteger(v)) {
        v = GPS_KEYS.has(key) ? t4(v) : r4(v);
      }
      sorted[key] = v;
    }
    const json = JSON.stringify(sorted);
    const hash = sha256(json);
    console.log('[NFT] Normalized EXIF hash (' + Object.keys(sorted).length + ' fields):', hash.substring(0, 16) + '...');
    return hash;
  } catch (e) {
    console.warn('[NFT] EXIF hash computation failed:', e?.message);
    return null;
  }
};

/**
 * Extract camera body serial number from EXIF for device-binding proof
 * @param {Object} info - Asset info from MediaLibrary.getAssetInfoAsync
 * @returns {string|null} SHA256 hash of serial or null
 */
export const computeCameraSerialHash = (info) => {
  const exif = info?.exif || {};
  const serial = exif.BodySerialNumber || exif.SerialNumber || exif.CameraSerialNumber || null;
  if (!serial) return null;
  const hash = sha256(String(serial));
  console.log('[NFT] Camera serial hash computed:', hash.substring(0, 16) + '...');
  return hash;
};

// ============================================================================
// RAW EXIF BINARY HASH (Hash1 — exact camera EXIF bytes, no parsing)
// ============================================================================

/**
 * Extract raw EXIF binary bytes from any image file.
 * No parsing, no library interpretation — exact bytes as the camera wrote them.
 * Returns a Uint8Array of the raw EXIF segment.
 *
 * For JPEG: extracts the entire APP1 Exif segment ("Exif\0\0" + TIFF header + all IFDs).
 *   Desktop equivalent: scanBuf.slice(pos + 4, pos + 2 + segLen) in nftDesktop.js
 * For PNG: extracts eXIf chunk data.
 * For WebP: extracts EXIF chunk data from RIFF container.
 * For HEIC/TIFF/RAW: not directly scannable on mobile — returns null (these formats
 *   don't have a simple binary header scan pattern on React Native without native libs).
 *
 * @param {string} filePath - Path to the image file
 * @param {string|null} preReadBase64 - Pre-read base64 content (avoids double disk read)
 * @returns {Promise<Uint8Array|null>} Raw EXIF binary bytes or null
 */
const extractTiffLikeExifBytes = (binaryString, startOffset, scanLen, prefixLen = 0) => {
  const b = (i) => binaryString.charCodeAt(i);
  const tiffBase = startOffset + prefixLen;
  if (tiffBase + 8 > scanLen) return null;
  const le = b(tiffBase) === 0x49 && b(tiffBase + 1) === 0x49;
  const be = b(tiffBase) === 0x4D && b(tiffBase + 1) === 0x4D;
  if (!le && !be) return null;

  const u16 = (off) => le ? (b(off) | (b(off + 1) << 8))
    : ((b(off) << 8) | b(off + 1));
  const u32 = (off) => le ? (b(off) | (b(off + 1) << 8) | (b(off + 2) << 16) | ((b(off + 3) << 24) >>> 0))
    : (((b(off) << 24) >>> 0) | (b(off + 1) << 16) | (b(off + 2) << 8) | b(off + 3));
  const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  const EXCLUDED_DATA_TAGS = new Set([0x0111, 0x0117, 0x0144, 0x0145, 0x014A, 0x0201, 0x0202]);
  const ifdQueue = [];
  const visited = new Set();

  try {
    const ifd0Rel = u32(tiffBase + 4);
    if (ifd0Rel > 0) ifdQueue.push(ifd0Rel);
  } catch (_) {
    return null;
  }

  let maxExtent = 8;
  while (ifdQueue.length > 0) {
    const ifdRel = ifdQueue.shift();
    if (!ifdRel || visited.has(ifdRel)) continue;
    visited.add(ifdRel);

    const ifdAbs = tiffBase + ifdRel;
    if (ifdAbs + 2 > scanLen) continue;
    let count = 0;
    try {
      count = u16(ifdAbs);
    } catch (_) {
      continue;
    }
    const ifdEndAbs = ifdAbs + 2 + count * 12 + 4;
    if (ifdEndAbs > scanLen) continue;
    const ifdEndRel = ifdRel + 2 + count * 12 + 4;
    if (ifdEndRel > maxExtent) maxExtent = ifdEndRel;

    for (let i = 0; i < count; i++) {
      const entryAbs = ifdAbs + 2 + i * 12;
      const tag = u16(entryAbs);
      const type = u16(entryAbs + 2);
      const valueCount = u32(entryAbs + 4);
      const dataRel = u32(entryAbs + 8);

      if ((tag === 0x8769 || tag === 0x8825 || tag === 0xA005) && dataRel > 0 && !visited.has(dataRel)) {
        ifdQueue.push(dataRel);
      }

      const typeSize = TYPE_SIZES[type] || 1;
      const totalBytes = typeSize * valueCount;
      if (totalBytes > 4 && dataRel > 0 && !EXCLUDED_DATA_TAGS.has(tag)) {
        const dataEndRel = dataRel + totalBytes;
        if (dataEndRel > maxExtent) maxExtent = dataEndRel;
      }
    }

    const nextIfdRel = u32(ifdAbs + 2 + count * 12);
    if (nextIfdRel > 0 && !visited.has(nextIfdRel)) {
      ifdQueue.push(nextIfdRel);
    }
  }

  const totalLen = Math.min(prefixLen + maxExtent, scanLen - startOffset);
  if (totalLen <= prefixLen + 8) return null;
  const rawBytes = new Uint8Array(totalLen);
  for (let i = 0; i < totalLen; i++) rawBytes[i] = b(startOffset + i);
  return rawBytes;
};

export const extractRawExifBytes = async (filePath, preReadBase64 = null) => {
  if (!filePath && !preReadBase64) return null;
  try {
    const base64Content = preReadBase64 || await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binaryString = atob(base64Content);
    const len = binaryString.length;
    if (len < 12) return null;

    const b = (i) => binaryString.charCodeAt(i);

    // === JPEG: Find APP1 marker (FF E1) containing "Exif\0\0" ===
    if (b(0) === 0xFF && b(1) === 0xD8) {
      const scanLen = Math.min(len, 256 * 1024);
      let pos = 2; // skip SOI
      while (pos + 4 < scanLen) {
        if (b(pos) !== 0xFF) break;
        const marker = b(pos + 1);
        const segLen = (b(pos + 2) << 8) | b(pos + 3);
        if (marker === 0xE1 && segLen > 8) {
          if (b(pos + 4) === 0x45 && b(pos + 5) === 0x78 &&
            b(pos + 6) === 0x69 && b(pos + 7) === 0x66 &&
            b(pos + 8) === 0x00 && b(pos + 9) === 0x00) {
            // Extract: "Exif\0\0" + TIFF header + all IFDs — identical to desktop
            const rawStr = binaryString.substring(pos + 4, pos + 2 + segLen);
            const rawBytes = new Uint8Array(rawStr.length);
            for (let j = 0; j < rawStr.length; j++) rawBytes[j] = rawStr.charCodeAt(j);
            return rawBytes;
          }
        }
        if (marker === 0xDA) break; // SOS — stop scanning
        pos += 2 + segLen;
      }
      return null;
    }

    // === PNG: Find eXIf chunk ===
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) {
      const scanLen = Math.min(len, 512 * 1024);
      let pos = 8; // skip PNG signature
      while (pos + 12 < scanLen) {
        const chunkLen = ((b(pos) << 24) | (b(pos + 1) << 16) | (b(pos + 2) << 8) | b(pos + 3)) >>> 0;
        const ct0 = b(pos + 4), ct1 = b(pos + 5), ct2 = b(pos + 6), ct3 = b(pos + 7);
        // 'eXIf' = 0x65 0x58 0x49 0x66
        if (ct0 === 0x65 && ct1 === 0x58 && ct2 === 0x49 && ct3 === 0x66 && chunkLen > 0) {
          const rawStr = binaryString.substring(pos + 8, pos + 8 + chunkLen);
          const rawBytes = new Uint8Array(rawStr.length);
          for (let j = 0; j < rawStr.length; j++) rawBytes[j] = rawStr.charCodeAt(j);
          return rawBytes;
        }
        // 'IEND' = 0x49 0x45 0x4E 0x44
        if (ct0 === 0x49 && ct1 === 0x45 && ct2 === 0x4E && ct3 === 0x44) break;
        pos += 12 + chunkLen; // 4 len + 4 type + data + 4 CRC
      }
      return null;
    }

    // === WebP: Find EXIF chunk in RIFF container ===
    // 'RIFF' = 0x52 0x49 0x46 0x46, 'WEBP' = 0x57 0x45 0x42 0x50
    if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
      b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) {
      const scanLen = Math.min(len, 512 * 1024);
      let pos = 12;
      while (pos + 8 < scanLen) {
        const id0 = b(pos), id1 = b(pos + 1), id2 = b(pos + 2), id3 = b(pos + 3);
        const chunkSize = (b(pos + 4) | (b(pos + 5) << 8) | (b(pos + 6) << 16) | ((b(pos + 7) << 24) >>> 0));
        // 'EXIF' = 0x45 0x58 0x49 0x46
        if (id0 === 0x45 && id1 === 0x58 && id2 === 0x49 && id3 === 0x46 && chunkSize > 0) {
          const rawStr = binaryString.substring(pos + 8, pos + 8 + chunkSize);
          const rawBytes = new Uint8Array(rawStr.length);
          for (let j = 0; j < rawStr.length; j++) rawBytes[j] = rawStr.charCodeAt(j);
          return rawBytes;
        }
        pos += 8 + chunkSize + (chunkSize % 2); // RIFF chunks are word-aligned
      }
      return null;
    }

    if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2A && b(3) === 0x00) ||
      (b(0) === 0x4D && b(1) === 0x4D && b(2) === 0x00 && b(3) === 0x2A)) {
      return extractTiffLikeExifBytes(binaryString, 0, Math.min(len, 512 * 1024), 0);
    }

    // === HEIC/HEIF: ISOBMFF container with Exif item ===
    // Check for ftyp box: bytes 4-7 = 'ftyp'
    if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
      const scanLen = Math.min(len, 512 * 1024);
      // Scan ISOBMFF boxes for 'Exif' data
      // HEIC stores EXIF in an 'iloc'-referenced item or directly in 'meta' > 'iinf' > 'Exif'
      // The simplest reliable method: scan for "Exif\0\0" + TIFF header anywhere in the file
      for (let pos = 0; pos + 10 < scanLen; pos++) {
        if (b(pos) === 0x45 && b(pos + 1) === 0x78 && b(pos + 2) === 0x69 && b(pos + 3) === 0x66 &&
          b(pos + 4) === 0x00 && b(pos + 5) === 0x00) {
          // Verify TIFF header follows: II (0x4949) or MM (0x4D4D)
          if ((b(pos + 6) === 0x49 && b(pos + 7) === 0x49) || (b(pos + 6) === 0x4D && b(pos + 7) === 0x4D)) {
            const rawBytes = extractTiffLikeExifBytes(binaryString, pos, scanLen, 6);
            if (rawBytes && rawBytes.length > 14) {
              return rawBytes;
            }
          }
        }
      }
      return null;
    }

    return null;
  } catch (e) {
    console.warn('[NFT] extractRawExifBytes failed:', e?.message);
    return null;
  }
};

/**
 * Strip IFD1 thumbnail data from raw TIFF/EXIF bytes for cross-platform stability.
 * iOS regenerates the embedded JPEG thumbnail with different compression artifacts
 * each time getAssetInfoAsync exports the photo, causing the raw EXIF binary to differ
 * even though all actual camera fields (IFD0, ExifIFD, GPSIFD) are identical.
 *
 * Zeroes out: IFD1 pointer, IFD1 entries, thumbnail JPEG blob.
 * Operates on a COPY — does not mutate the input.
 * Identical logic to desktop/nft-service stripThumbnailFromTiff but uses Uint8Array.
 *
 * @param {Uint8Array} raw - Raw EXIF bytes
 * @returns {Uint8Array} Copy with thumbnail data zeroed out
 */
const stripThumbnailFromTiff = (raw) => {
  if (!raw || raw.length < 16) return raw;

  const buf = new Uint8Array(raw); // copy

  // TIFF start: "Exif\0\0" prefix → TIFF at byte 6
  let t = 0;
  if (buf[0] === 0x45 && buf[1] === 0x78 && buf[2] === 0x69 && buf[3] === 0x66 &&
    buf[4] === 0x00 && buf[5] === 0x00) {
    t = 6;
  }
  if (t + 8 > buf.length) return buf;

  const le = (buf[t] === 0x49 && buf[t + 1] === 0x49);
  const be = (buf[t] === 0x4D && buf[t + 1] === 0x4D);
  if (!le && !be) return buf;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (off) => dv.getUint16(off, le);
  const u32 = (off) => dv.getUint32(off, le);
  const w32 = (off, v) => dv.setUint32(off, v, le);

  const ifd0Abs = t + u32(t + 4);
  if (ifd0Abs + 2 > buf.length) return buf;
  const ifd0Count = u16(ifd0Abs);
  const ifd0End = ifd0Abs + 2 + ifd0Count * 12;
  if (ifd0End + 4 > buf.length) return buf;

  const ifd1Rel = u32(ifd0End);
  if (ifd1Rel === 0) return buf; // no IFD1

  const ifd1Abs = t + ifd1Rel;
  if (ifd1Abs + 2 > buf.length) return buf;
  const ifd1Count = u16(ifd1Abs);
  if (ifd1Abs + 2 + ifd1Count * 12 + 4 > buf.length) return buf;

  // Zero IFD1 pointer from IFD0
  w32(ifd0End, 0);

  // Find thumbnail offset/length in IFD1
  let thOff = 0, thLen = 0, thOffTag = 0, thLenTag = 0;
  for (let i = 0; i < ifd1Count; i++) {
    const e = ifd1Abs + 2 + i * 12;
    const tag = u16(e);
    if (tag === 0x0201) { thOff = u32(e + 8); thOffTag = e + 8; }
    else if (tag === 0x0202) { thLen = u32(e + 8); thLenTag = e + 8; }
  }

  // Zero thumbnail JPEG blob
  if (thOff > 0 && thLen > 0) {
    const s = t + thOff;
    const e = Math.min(s + thLen, buf.length);
    if (s < buf.length) buf.fill(0, s, e);
  }

  // Zero tag values
  if (thOffTag) w32(thOffTag, 0);
  if (thLenTag) w32(thLenTag, 0);

  // Zero entire IFD1 block
  const ifd1End = Math.min(ifd1Abs + 2 + ifd1Count * 12 + 4, buf.length);
  buf.fill(0, ifd1Abs, ifd1End);

  return buf;
};

/**
 * Compute Hash1: SHA-256 of raw EXIF binary bytes from the original file.
 * Strips IFD1 thumbnail before hashing for cross-platform stability.
 * Identical to desktop computeExifRawHash — the thumbnail (which iOS re-renders)
 * is zeroed out deterministically so the hash is stable across all platforms.
 * @param {string} filePath - Path to the image file
 * @param {string|null} preReadBase64 - Pre-read base64 content (avoids double disk read)
 * @returns {Promise<string|null>} SHA-256 hex hash or null
 */
export const computeExifRawHash = async (filePath, preReadBase64 = null) => {
  const rawBytes = await extractRawExifBytes(filePath, preReadBase64);
  if (!rawBytes || rawBytes.length === 0) return null;
  const stable = stripThumbnailFromTiff(rawBytes);
  const hash = sha256(stable);
  console.log(`[NFT] EXIF Raw Hash (${stable.length} bytes, thumb-stripped): ${hash.substring(0, 16)}...`);
  return hash;
};

/**
 * Compute Hash3: Binding proof — SHA-256(Hash1 + "|" + Hash2).
 * Cryptographically binds the exact raw hash and the normalized dedup hash.
 * Identical to desktop computeExifBindingHash.
 * @param {string} rawHash - Hash1 (exact raw EXIF binary)
 * @param {string} normalizedHash - Hash2 (normalized/rounded for dedup)
 * @returns {string|null} SHA-256 hex binding hash or null
 */
export const computeExifBindingHash = (rawHash, normalizedHash) => {
  if (!rawHash && !normalizedHash) return null;
  const input = `${rawHash || 'none'}|${normalizedHash || 'none'}`;
  return sha256(input);
};

// ============================================================================
// RFC 3161 TRUSTED TIMESTAMP + C2PA PROVENANCE
// ============================================================================

/**
 * Request an RFC 3161 trusted timestamp with multi-TSA fallback.
 * Tries FreeTSA first, then DigiCert, then Sectigo. Returns first success.
 * Builds a minimal DER-encoded TimeStampReq, POSTs to TSA, returns base64 TSR.
 * @param {string} hexHash - SHA-256 hex hash of the content to timestamp
 * @returns {Promise<{success:boolean, tsaToken:string|null, tsaUrl:string, tsaPolicy:string, error:string|null}>}
 */
export const requestRFC3161Timestamp = async (hexHash) => {
  const TSA_SERVERS = [
    { url: 'https://freetsa.org/tsr', policy: '1.2.840.113549.1.9.16.1.4', name: 'FreeTSA' },
    { url: 'http://timestamp.digicert.com', policy: '2.16.840.1.101.3.4.2.1', name: 'DigiCert' },
    { url: 'http://timestamp.sectigo.com', policy: '1.3.6.1.4.1.6449.2.1.1', name: 'Sectigo' },
  ];

  // Build DER-encoded TimeStampReq manually
  const hashHex = hexHash;
  const hashBytes = new Uint8Array(hashHex.match(/.{2}/g).map(b => parseInt(b, 16)));

  // AlgorithmIdentifier: SEQUENCE { OID sha256, NULL }
  const sha256Oid = new Uint8Array([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
  const nullParam = new Uint8Array([0x05, 0x00]);
  const algIdContent = new Uint8Array([...sha256Oid, ...nullParam]);
  const algId = new Uint8Array([0x30, algIdContent.length, ...algIdContent]);

  // hashedMessage OCTET STRING
  const hashedMsg = new Uint8Array([0x04, hashBytes.length, ...hashBytes]);

  // MessageImprint SEQUENCE
  const msgImprintContent = new Uint8Array([...algId, ...hashedMsg]);
  const msgImprint = new Uint8Array([0x30, msgImprintContent.length, ...msgImprintContent]);

  // version INTEGER 1, certReq BOOLEAN TRUE
  const version = new Uint8Array([0x02, 0x01, 0x01]);
  const certReq = new Uint8Array([0x01, 0x01, 0xff]);

  // TimeStampReq SEQUENCE
  const tsqContent = new Uint8Array([...version, ...msgImprint, ...certReq]);
  const tsq = new Uint8Array([0x30, tsqContent.length, ...tsqContent]);

  // Convert to base64 for axios binary POST
  const tsqBase64 = btoa(String.fromCharCode(...tsq));

  let lastError = null;
  for (const tsa of TSA_SERVERS) {
    try {
      const response = await axios.post(tsa.url, tsqBase64, {
        headers: { 'Content-Type': 'application/timestamp-query' },
        responseType: 'arraybuffer',
        timeout: 10000,
        transformRequest: [(data) => {
          const binary = atob(data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return bytes.buffer;
        }],
      });

      if (!response.data || response.data.byteLength < 10) {
        throw new Error(`Empty response from ${tsa.name}`);
      }

      // Convert ArrayBuffer to base64
      const bytes = new Uint8Array(response.data);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const tsaToken = btoa(binary);

      console.log(`[RFC3161] Timestamp obtained from ${tsa.name}, token size: ${bytes.length} bytes`);
      return { success: true, tsaToken, tsaUrl: tsa.url, tsaPolicy: tsa.policy, error: null };
    } catch (e) {
      lastError = e.message;
      console.warn(`[RFC3161] ${tsa.name} failed: ${e.message}, trying next...`);
    }
  }

  console.warn('[RFC3161] All TSA servers failed, last error:', lastError);
  return { success: false, tsaToken: null, tsaUrl: TSA_SERVERS[0].url, tsaPolicy: TSA_SERVERS[0].policy, error: lastError };
};

/**
 * Build a C2PA-compatible provenance manifest for a Limited Edition photo NFT.
 * Follows the C2PA claim schema (https://c2pa.org) — backed by Adobe, Microsoft, Google, BBC, Sony.
 * @param {Object} params
 * @returns {Object} C2PA-compatible manifest object
 */
export const buildC2PAManifest = ({ contentHash, exifHash, cameraSerialHash, creatorWallet, fileName, fileSize, originalFormat, originalResolution, tsaToken, tsaUrl, mintTimestamp }) => ({
  '@context': 'https://c2pa.org/statements/v1',
  'claim_generator': `PhotoLynk/${APP_VERSION}`,
  'title': fileName || 'PhotoLynk Certified Original',
  'format': originalFormat || 'image/jpeg',
  'instance_id': `urn:photolynk:${contentHash}`,
  'claim': {
    'dc:title': fileName || 'PhotoLynk Certified Original',
    'dc:format': originalFormat || 'image/jpeg',
    'created': mintTimestamp || new Date().toISOString(),
    'claim_generator': `PhotoLynk/${APP_VERSION} (Solana Seeker)`,
    'assertions': [
      { 'label': 'c2pa.hash.data', 'data': { 'algorithm': 'sha256', 'hash': contentHash, 'name': 'jumbf=c2pa.assertions/c2pa.hash.data' } },
      ...(exifHash ? [{ 'label': 'stealthlynk.hash.exif', 'data': { 'algorithm': 'sha256', 'hash': exifHash } }] : []),
      ...(cameraSerialHash ? [{ 'label': 'stealthlynk.hash.camera_serial', 'data': { 'algorithm': 'sha256', 'hash': cameraSerialHash } }] : []),
      { 'label': 'c2pa.actions', 'data': { 'actions': [{ 'action': 'c2pa.created', 'when': mintTimestamp || new Date().toISOString(), 'softwareAgent': 'PhotoLynk Solana Seeker' }] } },
      { 'label': 'stealthlynk.blockchain', 'data': { 'chain': 'Solana', 'creator_wallet': creatorWallet, 'edition': 'Limited' } },
      ...(tsaToken ? [{ 'label': 'stealthlynk.rfc3161_timestamp', 'data': { 'tsa_url': tsaUrl, 'tsa_token_base64': tsaToken, 'algorithm': 'sha256', 'hash': contentHash, 'standard': 'RFC 3161' } }] : []),
    ],
    'signature_info': { 'issuer': 'PhotoLynk', 'cert_serial_number': creatorWallet, 'time': mintTimestamp || new Date().toISOString() },
  },
  'ingredients': [{ 'title': fileName || 'original', 'format': originalFormat || 'image/jpeg', 'instance_id': `urn:photolynk:original:${contentHash}`, 'relationship': 'parentOf', 'hash': { 'algorithm': 'sha256', 'value': contentHash }, 'size_bytes': fileSize || null, 'resolution': originalResolution || null }],
});

// ============================================================================
// ON-CHAIN IMAGE COMPRESSION (max 10KB embedded in metadata)
// ============================================================================

const ONCHAIN_VECTOR_SIZE = 128;   // resize to this before vectorizing

/**
 * Convert a photo to SVG vector art for on-chain embedding.
 * Process: resize tiny → decode to pixels → trace to SVG → encode as data URI.
 * The SVG is resolution-independent and typically 3-8KB for a 128px source.
 * @param {string} imagePath - Path to original image
 * @returns {Object} { success, dataUri, svgString, sizeBytes, error }
 */
export const generateOnChainImage = async (imagePath) => {
  try {
    if (!imagePath) return { success: false, error: 'No image path' };
    const fileInfo = await FileSystem.getInfoAsync(imagePath);
    if (!fileInfo.exists) return { success: false, error: 'File not found' };

    // Embed original image as base64 data URI — no compression or vector tracing.
    // On-chain is the ONLY storage for the image (no separate IPFS/Arweave upload),
    // so the full original must be preserved for integrity hash verification.
    // OOM during auto-scan is handled by fetch-side size guards (512KB limit).
    const base64 = await FileSystem.readAsStringAsync(imagePath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const ext = imagePath.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tiff: 'image/tiff', tif: 'image/tiff', dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw', raf: 'image/x-fuji-raf', orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2', pef: 'image/x-pentax-pef', srw: 'image/x-samsung-srw' };
    const mime = mimeMap[ext] || 'image/jpeg';
    const dataUri = `data:${mime};base64,${base64}`;
    const sizeBytes = Math.ceil(base64.length * 0.75);
    console.log(`[NFT] On-chain: embedded original ~${Math.round(sizeBytes / 1024)}KB (${mime}) as data URI`);
    return { success: true, dataUri, sizeBytes };
  } catch (e) {
    console.error('[NFT] On-chain image embedding failed:', e.message);
    return { success: false, error: e.message };
  }
};

// OPTIMIZED PREVIEW GENERATION (Open Edition)
// ============================================================================

const OPEN_EDITION_PREVIEW_SIZE = 1200;  // max dimension for Open Edition preview
const OPEN_EDITION_COMPRESS = 0.75;      // JPEG quality for preview (<50KB target)

/**
 * Generate optimized preview image for Open Edition NFTs
 * @param {string} imagePath - Path to original image
 * @returns {Object} { success, previewPath, error }
 */
export const generateOptimizedPreview = async (imagePath) => {
  try {
    if (!imagePath) return { success: false, error: 'No image path' };
    const fileInfo = await FileSystem.getInfoAsync(imagePath);
    if (!fileInfo.exists) return { success: false, error: 'File not found' };

    const result = await ImageManipulator.manipulateAsync(
      imagePath,
      [{ resize: { width: OPEN_EDITION_PREVIEW_SIZE } }],
      { compress: OPEN_EDITION_COMPRESS, format: ImageManipulator.SaveFormat.JPEG }
    );

    console.log('[NFT] Preview generated:', result.width, 'x', result.height);
    return { success: true, previewPath: result.uri };
  } catch (e) {
    console.error('[NFT] Preview generation failed:', e.message);
    return { success: false, error: e.message };
  }
};

// Limited Edition thumbnail size (higher quality than gallery thumb)
const LIMITED_EDITION_THUMB_SIZE = 1600;
const LIMITED_EDITION_COMPRESS = 0.80;

/**
 * Generate high-quality thumbnail for Limited Edition NFTs
 * @param {string} imagePath - Path to original image
 * @returns {Object} { success, thumbPath, error }
 */
export const generateLimitedEditionThumb = async (imagePath) => {
  try {
    if (!imagePath) return { success: false, error: 'No image path' };
    const fileInfo = await FileSystem.getInfoAsync(imagePath);
    if (!fileInfo.exists) return { success: false, error: 'File not found' };

    const result = await ImageManipulator.manipulateAsync(
      imagePath,
      [{ resize: { width: LIMITED_EDITION_THUMB_SIZE } }],
      { compress: LIMITED_EDITION_COMPRESS, format: ImageManipulator.SaveFormat.JPEG }
    );

    console.log('[NFT] Limited Edition thumb generated:', result.width, 'x', result.height);
    return { success: true, thumbPath: result.uri };
  } catch (e) {
    console.error('[NFT] Limited Edition thumb failed:', e.message);
    return { success: false, error: e.message };
  }
};

// ============================================================================
// WATERMARK (visible text overlay burned into preview/thumbnail)
// ============================================================================

/**
 * Burn a visible watermark into an image
 * Uses ImageManipulator to overlay text via a canvas-style approach:
 * Since expo-image-manipulator doesn't support text overlay directly,
 * we create a semi-transparent watermark by compositing a small repeated pattern.
 * For React Native, we use a simpler approach: resize + slight quality reduction
 * that embeds "PHOTOLYNK" in the metadata and reduces quality slightly as a deterrent.
 * 
 * NOTE: True visible watermark requires expo-image-manipulator v12+ with canvas,
 * or a native module. For now we apply a subtle quality reduction + metadata flag.
 * The watermark flag in on-chain metadata is the primary indicator.
 * 
 * @param {string} imagePath - Path to image to watermark
 * @param {string} watermarkText - Text to use (default: '© PhotoLynk')
 * @returns {Object} { success, watermarkedPath, error }
 */
export const burnWatermark = async (imagePath, watermarkText = '© PhotoLynk') => {
  try {
    if (!imagePath) return { success: false, error: 'No image path' };

    // Re-encode at slightly lower quality as a visual deterrent
    // The on-chain metadata "Watermarked: true" is the authoritative flag
    const result = await ImageManipulator.manipulateAsync(
      imagePath,
      [], // No transform — just re-encode
      { compress: 0.60, format: ImageManipulator.SaveFormat.JPEG }
    );

    console.log('[NFT] Watermark applied (quality reduction + metadata flag)');
    return { success: true, watermarkedPath: result.uri };
  } catch (e) {
    console.warn('[NFT] Watermark failed, using original:', e?.message);
    return { success: false, error: e.message };
  }
};

// ============================================================================
// NFT IMAGE ENCRYPTION / DECRYPTION (NaCl secretbox — same as StealthCloud)
// ============================================================================

/**
 * Encrypt an image file for NFT storage
 * Uses NaCl secretbox (XSalsa20-Poly1305) with a random per-NFT key
 * The per-NFT key is wrapped with the user's master key for later decryption
 * @param {string} imagePath - Path to image file
 * @param {Uint8Array} masterKey - User's StealthCloud master key (32 bytes)
 * @returns {Object} { success, encryptedPath, wrappedKey, wrapNonce, nonce, error }
 */
export const encryptNFTImage = async (imagePath, masterKey) => {
  try {
    if (!imagePath || !masterKey) return { success: false, error: 'Missing params' };

    let b64 = await FileSystem.readAsStringAsync(imagePath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const plaintext = naclUtil.decodeBase64(b64);
    b64 = null; // free ~3MB base64 string
    if (!plaintext || plaintext.length === 0) return { success: false, error: 'Empty file' };
    const originalSize = plaintext.length;

    // Generate per-NFT encryption key
    const nftKey = new Uint8Array(32);
    global.crypto.getRandomValues(nftKey);

    // Encrypt image with per-NFT key
    const nonce = new Uint8Array(24);
    global.crypto.getRandomValues(nonce);
    let encrypted = nacl.secretbox(plaintext, nonce, nftKey);
    // plaintext is const but goes out of scope after this block — GC will collect

    // Wrap per-NFT key with master key (so only this user can decrypt)
    const wrapNonce = new Uint8Array(24);
    global.crypto.getRandomValues(wrapNonce);
    const wrappedKey = nacl.secretbox(nftKey, wrapNonce, masterKey);

    // Write encrypted blob to temp file
    const encPath = `${FileSystem.cacheDirectory}nft_enc_${Date.now()}.bin`;
    let encB64 = naclUtil.encodeBase64(encrypted);
    console.log('[NFT] Image encrypted:', originalSize, '→', encrypted.length, 'bytes');
    encrypted = null; // free ~2.3MB — now in encB64
    await FileSystem.writeAsStringAsync(encPath, encB64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    encB64 = null; // free ~3MB base64 string — now on disk

    return {
      success: true,
      encryptedPath: encPath,
      wrappedKey: naclUtil.encodeBase64(wrappedKey),
      wrapNonce: naclUtil.encodeBase64(wrapNonce),
      nonce: naclUtil.encodeBase64(nonce),
      nftKeyB64: naclUtil.encodeBase64(nftKey), // raw key for metadata encryption (held in memory only)
      originalSize,
    };
  } catch (e) {
    console.error('[NFT] Encryption failed:', e.message);
    return { success: false, error: e.message };
  }
};

/**
 * Decrypt encrypted metadata JSON fetched from IPFS/Arweave
 * @param {Uint8Array|string} encryptedData - Encrypted metadata (Uint8Array or base64 string)
 * @param {Object} encryptionData - { wrappedKey, wrapNonce, metadataNonce } from local storage
 * @param {Uint8Array} masterKey - User's StealthCloud master key (32 bytes)
 * @returns {Object|null} Parsed metadata object or null on failure
 */
export const decryptMetadataJSON = (encryptedData, encryptionData, masterKey, fallbackMasterKey = null) => {
  try {
    if (!encryptedData || !encryptionData?.wrappedKey || !encryptionData?.wrapNonce || !encryptionData?.metadataNonce || !masterKey) {
      return null;
    }
    const wrappedKey = naclUtil.decodeBase64(encryptionData.wrappedKey);
    const wrapNonce = naclUtil.decodeBase64(encryptionData.wrapNonce);

    // Try primary master key first
    let nftKey = nacl.secretbox.open(wrappedKey, wrapNonce, masterKey);
    if (!nftKey && fallbackMasterKey) {
      console.log('[NFT] Metadata: primary key failed, trying legacy fallback key');
      nftKey = nacl.secretbox.open(wrappedKey, wrapNonce, fallbackMasterKey);
    }
    if (!nftKey) return null;

    const metadataNonce = naclUtil.decodeBase64(encryptionData.metadataNonce);
    const ciphertext = (typeof encryptedData === 'string') ? naclUtil.decodeBase64(encryptedData) : encryptedData;
    const plaintext = nacl.secretbox.open(ciphertext, metadataNonce, nftKey);
    if (!plaintext) return null;

    const jsonStr = naclUtil.encodeUTF8(plaintext);
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[NFT] Metadata decryption failed:', e.message);
    return null;
  }
};

/**
 * Decrypt an encrypted NFT image
 * @param {string} encryptedB64 - Base64-encoded encrypted data (or file path)
 * @param {string} wrappedKeyB64 - Base64-encoded wrapped per-NFT key
 * @param {string} wrapNonceB64 - Base64-encoded wrap nonce
 * @param {string} nonceB64 - Base64-encoded encryption nonce
 * @param {Uint8Array} masterKey - User's StealthCloud master key (32 bytes)
 * @returns {Object} { success, decryptedPath, error }
 */
export const decryptNFTImage = async (encryptedB64, wrappedKeyB64, wrapNonceB64, nonceB64, masterKey, fallbackMasterKey = null, transferNftKeyB64 = null) => {
  try {
    if (!encryptedB64 || !nonceB64) return { success: false, error: 'Missing params' };
    if (!transferNftKeyB64 && (!wrappedKeyB64 || !wrapNonceB64 || !masterKey)) return { success: false, error: 'Missing params' };

    // Unwrap per-NFT key — try primary master key first, then legacy fallback
    let nftKey = null;
    if (masterKey && wrappedKeyB64 && wrapNonceB64) {
      const wrappedKey = naclUtil.decodeBase64(wrappedKeyB64);
      const wrapNonce = naclUtil.decodeBase64(wrapNonceB64);
      nftKey = nacl.secretbox.open(wrappedKey, wrapNonce, masterKey);
      if (!nftKey && fallbackMasterKey) {
        console.log('[NFT] Image: primary key failed, trying legacy fallback key');
        nftKey = nacl.secretbox.open(wrappedKey, wrapNonce, fallbackMasterKey);
      }
    }
    // Fallback: use transferNftKey (raw per-NFT key included in transferred encrypted NFTs)
    if (!nftKey && transferNftKeyB64) {
      try { nftKey = naclUtil.decodeBase64(transferNftKeyB64); console.log('[NFT] Image: using transferNftKey for decryption'); } catch (_) { }
    }
    if (!nftKey) return { success: false, error: 'Key unwrap failed (wrong master key?)' };

    // If encryptedB64 is a file path, read it
    let encData;
    if (encryptedB64.startsWith('/') || encryptedB64.startsWith('file://')) {
      let raw = await FileSystem.readAsStringAsync(encryptedB64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      encData = naclUtil.decodeBase64(raw);
      raw = null; // Free base64 string
    } else {
      encData = naclUtil.decodeBase64(encryptedB64);
    }

    // Decrypt
    const nonce = naclUtil.decodeBase64(nonceB64);
    let plaintext = nacl.secretbox.open(encData, nonce, nftKey);
    const encLen = encData.length;
    encData = null; // Free encrypted data
    if (!plaintext) return { success: false, error: 'Decryption failed' };

    // Write decrypted image to temp file
    const decPath = `${FileSystem.cacheDirectory}nft_dec_${Date.now()}.jpg`;
    let decB64 = naclUtil.encodeBase64(plaintext);
    const plainLen = plaintext.length;
    plaintext = null; // Free plaintext
    await FileSystem.writeAsStringAsync(decPath, decB64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    decB64 = null; // Free base64 output

    console.log('[NFT] Image decrypted:', encLen, '→', plainLen, 'bytes');
    return { success: true, decryptedPath: decPath };
  } catch (e) {
    console.error('[NFT] Decryption failed:', e.message);
    return { success: false, error: e.message };
  }
};

// ============================================================================
// THUMBNAIL GENERATION
// ============================================================================

const THUMBNAIL_SIZE = 800; // 800px for balanced quality, storage cost, and device safety

/**
 * Generate a thumbnail from an image file
 * @param {string} imagePath - Path to the original image
 * @returns {Object} { success, thumbnailPath, error }
 */
const generateThumbnail = async (imagePath) => {
  try {
    console.log('[NFT] Generating thumbnail from:', imagePath);

    // Validate image path
    if (!imagePath) {
      console.log('[NFT] No image path provided for thumbnail');
      return { success: false, error: 'No image file provided' };
    }

    // Check if file exists
    const fileInfo = await FileSystem.getInfoAsync(imagePath);
    if (!fileInfo.exists) {
      console.log('[NFT] Image file does not exist:', imagePath);
      return { success: false, error: 'Image file not found' };
    }

    // Resize to max width (height auto) to preserve aspect ratio
    const result = await ImageManipulator.manipulateAsync(
      imagePath,
      [{ resize: { width: THUMBNAIL_SIZE } }],
      { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG }
    );

    console.log('[NFT] Thumbnail generated:', result.uri, 'size:', result.width, 'x', result.height);
    return { success: true, thumbnailPath: result.uri };
  } catch (e) {
    console.error('[NFT] Thumbnail generation failed:', e.message);
    return { success: false, error: e.message };
  }
};

/**
 * Upload thumbnail to StealthCloud
 * @param {string} thumbnailPath - Path to thumbnail file
 * @param {string} nftName - NFT name for filename
 * @param {Object} config - Server config
 * @returns {Object} { success, thumbnailUrl, error }
 */
const uploadThumbnailToStealthCloud = async (thumbnailPath, nftName, config) => {
  try {
    if (!config?.baseUrl) {
      return { success: false, error: 'No server config' };
    }

    // Get auth headers
    let headers = {};
    if (typeof config.getAuthHeaders === 'function') {
      const authConfig = await config.getAuthHeaders();
      headers = authConfig?.headers || authConfig || {};
    } else if (config.headers) {
      headers = config.headers;
    }

    if (!headers.Authorization) {
      return { success: false, error: 'Not authenticated' };
    }

    // Ensure device UUID header is present (server requires X-Device-UUID)
    if (!headers['X-Device-UUID'] && !headers['x-device-uuid']) {
      try {
        const storedUuid = await SecureStore.getItemAsync('device_uuid');
        if (storedUuid) {
          headers['X-Device-UUID'] = storedUuid;
        }
      } catch (e) {
        // ignore
      }

      if (!headers['X-Device-UUID']) {
        try {
          const email = await SecureStore.getItemAsync('user_email');
          const password = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, { requireAuthentication: false });
          if (email && password) {
            const derived = await getDeviceUUID(email, password);
            if (derived) headers['X-Device-UUID'] = derived;
          }
        } catch (e) {
          // ignore
        }
      }

      if (!headers['X-Device-UUID']) {
        return { success: false, error: 'Device UUID missing' };
      }
    }

    // Read thumbnail as base64
    const fileBase64 = await FileSystem.readAsStringAsync(thumbnailPath, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Generate unique filename
    const timestamp = Date.now();
    const safeName = (nftName || 'nft').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const filename = `thumb_${safeName}_${timestamp}.jpg`;

    // Decode base64 to binary for multipart upload
    const binaryStr = atob(fileBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Build multipart form data (same format as main image upload)
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const headerStr = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`,
      `Content-Type: image/jpeg\r\n\r\n`,
    ].join('');
    const footerStr = `\r\n--${boundary}--\r\n`;

    const headerBytes = new TextEncoder().encode(headerStr);
    const footerBytes = new TextEncoder().encode(footerStr);

    const body = new Uint8Array(headerBytes.length + bytes.length + footerBytes.length);
    body.set(headerBytes, 0);
    body.set(bytes, headerBytes.length);
    body.set(footerBytes, headerBytes.length + bytes.length);

    // Upload to StealthCloud NFT endpoint using multipart form-data
    const response = await fetch(`${config.baseUrl}/api/nft/upload`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Upload failed: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      const thumbnailUrl = `${config.baseUrl}${result.fallbackUrl}`;
      console.log('[NFT] Thumbnail uploaded to StealthCloud:', thumbnailUrl);
      return { success: true, thumbnailUrl };
    }

    throw new Error(result.error || 'Upload failed');
  } catch (e) {
    console.error('[NFT] Thumbnail upload failed:', e.message);
    return { success: false, error: e.message };
  }
};

// ============================================================================
// STEALTHCLOUD NFT STORAGE
// ============================================================================

/**
 * Check if user is eligible for StealthCloud NFT storage
 * @param {Object} config - Server config with baseUrl and getAuthHeaders function
 * @param {number} fileSizeBytes - Estimated file size
 * @returns {Object} { eligible, reason, quotaBytes, usedBytes, availableBytes }
 */
export const checkStealthCloudEligibility = async (config, fileSizeBytes = 5 * 1024 * 1024) => {
  try {
    if (!config?.baseUrl) {
      return { eligible: false, reason: 'Not connected to StealthCloud' };
    }

    // Get auth headers (can be object or function)
    let headers = {};
    if (typeof config.getAuthHeaders === 'function') {
      const authConfig = await config.getAuthHeaders();
      headers = authConfig?.headers || {};
    } else if (config.headers) {
      headers = config.headers;
    }

    if (!headers.Authorization) {
      return { eligible: false, reason: 'Not logged in' };
    }

    const response = await axios.get(
      `${config.baseUrl}/api/nft/eligibility?size=${fileSizeBytes}`,
      { headers, timeout: 10000 }
    );

    return response.data;
  } catch (e) {
    console.log('[NFT] StealthCloud eligibility check failed:', e.message);
    return { eligible: false, reason: 'Could not verify StealthCloud status' };
  }
};

/**
 * Upload NFT image to StealthCloud
 * @param {string} filePath - Local file path
 * @param {Object} config - Server config with baseUrl and getAuthHeaders function
 * @returns {Object} { success, publicUrl, imageId, error }
 */
export const uploadToStealthCloud = async (filePath, config) => {
  try {
    if (!config?.baseUrl) {
      return { success: false, error: 'Not connected to StealthCloud' };
    }

    // Get auth headers (can be object or function)
    let headers = {};
    if (typeof config.getAuthHeaders === 'function') {
      const authConfig = await config.getAuthHeaders();
      headers = authConfig?.headers || {};
    } else if (config.headers) {
      headers = config.headers;
    }

    if (!headers.Authorization) {
      return { success: false, error: 'Not logged in to StealthCloud' };
    }
    // Ensure device UUID header is present (server requires X-Device-UUID)
    if (!headers['X-Device-UUID'] && !headers['x-device-uuid']) {
      // 1) Try persisted device_uuid
      try {
        const storedUuid = await SecureStore.getItemAsync('device_uuid');
        if (storedUuid) {
          headers['X-Device-UUID'] = storedUuid;
        }
      } catch (e) {
        // ignore
      }

      // 2) If still missing, derive from email+password (same as login path)
      if (!headers['X-Device-UUID']) {
        try {
          const email = await SecureStore.getItemAsync('user_email');
          const password = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, { requireAuthentication: false });
          if (email && password) {
            const derived = await getDeviceUUID(email, password);
            if (derived) headers['X-Device-UUID'] = derived;
          }
        } catch (e) {
          // ignore
        }
      }

      if (!headers['X-Device-UUID']) {
        return { success: false, error: 'Device UUID missing. Please login again.' };
      }
    }

    // Read file as base64
    const fileBase64 = await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const fileSize = Math.ceil(fileBase64.length * 0.75);
    console.log(`[NFT] Uploading ${fileSize} bytes to StealthCloud...`);

    // Determine content type from file extension
    const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeTypes = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
      tiff: 'image/tiff', tif: 'image/tiff', dng: 'image/x-adobe-dng',
      cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef',
      arw: 'image/x-sony-arw', raf: 'image/x-fuji-raf', orf: 'image/x-olympus-orf',
      rw2: 'image/x-panasonic-rw2', pef: 'image/x-pentax-pef', srw: 'image/x-samsung-srw',
      bin: 'application/octet-stream',
    };
    const contentType = mimeTypes[ext] || 'image/jpeg';

    // Build multipart form data
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const uploadExt = ext === 'bin' ? 'bin' : ext;
    const filename = `nft_${Date.now()}.${uploadExt}`;

    // Decode base64 to binary
    const binaryStr = atob(fileBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Build multipart body
    const headerStr = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`,
      `Content-Type: ${contentType}\r\n\r\n`,
    ].join('');
    const footerStr = `\r\n--${boundary}--\r\n`;

    const headerBytes = new TextEncoder().encode(headerStr);
    const footerBytes = new TextEncoder().encode(footerStr);

    const body = new Uint8Array(headerBytes.length + bytes.length + footerBytes.length);
    body.set(headerBytes, 0);
    body.set(bytes, headerBytes.length);
    body.set(footerBytes, headerBytes.length + bytes.length);

    const response = await fetch(`${config.baseUrl}/api/nft/upload`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Upload failed: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      // Use fallback URL with full base URL since nft.stealthlynk.io subdomain may not be configured
      const fullFallbackUrl = `${config.baseUrl}${result.fallbackUrl}`;
      console.log('[NFT] Uploaded to StealthCloud:', fullFallbackUrl);
      return {
        success: true,
        arweaveUrl: fullFallbackUrl, // Use fallback URL for reliable access
        publicUrl: result.publicUrl,
        fallbackUrl: fullFallbackUrl,
        imageId: result.imageId,
        size: result.size,
      };
    }

    throw new Error('Upload failed');
  } catch (e) {
    console.error('[NFT] StealthCloud upload failed:', e.message);
    return { success: false, error: e.message };
  }
};

// ============================================================================
// IPFS UPLOAD (via Pinata)
// ============================================================================

/**
 * Estimate Arweave upload cost
 * @param {number} fileSizeBytes - File size in bytes
 * @returns {Object} { arweaveUsd, arweaveSol }
 */
export const estimateArweaveUploadCost = async (fileSizeBytes) => {
  const sizeKb = fileSizeBytes / 1024;
  const baseCost = NFT_FEES.ARWEAVE_UPLOAD_BASE;
  const sizeCost = sizeKb * NFT_FEES.ARWEAVE_PER_KB;
  const totalUsd = baseCost + sizeCost;
  const totalSol = await usdToSol(totalUsd);

  return {
    arweaveUsd: totalUsd,
    arweaveSol: totalSol,
  };
};

 const shouldTryPinataFallback = (error) => {
  const status = Number(error?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  const responseText = String(error?.responseText || '').toLowerCase();
  const details = `${message} ${responseText}`;
  if ([400, 401, 402, 403, 409, 429].includes(status) || status >= 500) {
    return true;
  }
  return details.includes('429')
    || details.includes('rate limit')
    || details.includes('too many requests')
    || details.includes('quota')
    || details.includes('usage limit')
    || details.includes('plan limit')
    || details.includes('limit reached')
    || details.includes('exceeded')
    || details.includes('forbidden')
    || details.includes('unauthorized');
 };

// Source of truth for Pinata accounts: ./pinataAccounts.js (paste-and-go list).
// `getAllPinataJwtsFromAccounts()` merges env-var overrides + the static list
// in priority order and de-duplicates.
const uploadToPinataWithFallback = async (filePath, contentType, preReadBase64 = null) => {
  const candidates = getAllPinataJwtsFromAccounts();
  if (candidates.length === 0) {
    throw new Error('No Pinata JWTs configured. Add one to pinataAccounts.js.');
  }

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const { label, jwt } = candidates[i];
    try {
      console.log(`[NFT] Uploading to IPFS via Pinata [${i + 1}/${candidates.length}: ${label}]...`);
      return await uploadToPinata(filePath, contentType, preReadBase64, jwt);
    } catch (pinataError) {
      lastError = pinataError;
      console.error(`[NFT] Pinata ${label} failed:`, pinataError.message, pinataError.responseText || '');
      // Stop only on a fatal (non-rate-limit/quota/auth) error. Otherwise auto-rotate.
      if (i === candidates.length - 1 || !shouldTryPinataFallback(pinataError)) {
        break;
      }
    }
  }

  throw lastError || new Error('All Pinata JWTs exhausted');
 };

// Backwards-compatible flag so existing code paths that gate on "is any Pinata
// configured at all?" keep working without referencing individual constants.
const HAS_ANY_PINATA = getAllPinataJwtsFromAccounts().length > 0;

/**
 * Upload image to IPFS via Pinata (primary) or NFT.storage (fallback)
 * @param {string} filePath - Local file path
 * @param {string} contentType - MIME type
 * @param {Object} tags - Metadata tags
 * @returns {Object} { success, arweaveUrl, transactionId, error }
 */
 export const uploadToArweave = async (filePath, contentType = 'image/jpeg', tags = {}, preReadBase64 = null) => {
  if (HAS_ANY_PINATA) {
    try {
      return await uploadToPinataWithFallback(filePath, contentType, preReadBase64);
    } catch (pinataError) {
      console.error('[NFT] Pinata upload failed, falling through to NFT.storage:', pinataError.message);
    }
  }

  // Try NFT.storage as fallback
  if (NFT_STORAGE_API_KEY) {
    try {
      // Reuse pre-read buffer when available (read-once optimization)
      const fileBase64 = preReadBase64 || await FileSystem.readAsStringAsync(filePath, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const fileSize = Math.ceil(fileBase64.length * 0.75);
      console.log(`[NFT] Uploading ~${fileSize} bytes to IPFS via NFT.storage...`);

      const blob = await fetch(`data:${contentType};base64,${fileBase64}`).then(r => r.blob());

      const response = await fetch('https://api.nft.storage/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NFT_STORAGE_API_KEY}`,
        },
        body: blob,
      });

      if (!response.ok) {
        throw new Error(`NFT.storage upload failed: ${response.status}`);
      }

      const result = await response.json();

      if (result.ok && result.value?.cid) {
        const cid = result.value.cid;
        console.log('[NFT] Uploaded to IPFS with CID:', cid);

        return {
          success: true,
          arweaveUrl: `https://nftstorage.link/ipfs/${cid}`,
          ipfsUrl: `ipfs://${cid}`,
          transactionId: cid,
          size: fileSize,
        };
      }

      throw new Error('No CID returned from NFT.storage');
    } catch (e) {
      console.error('[NFT] NFT.storage upload failed:', e.message);
    }
  }

  return { success: false, error: 'No IPFS upload service configured. Add PINATA_JWT or NFT_STORAGE_API_KEY.' };
};

/**
 * Upload to Pinata IPFS using base64 approach for React Native
 * @param {string} jwt - Pinata JWT token (defaults to PINATA_JWT if not provided)
 */
const uploadToPinata = async (filePath, contentType, preReadBase64 = null, jwt = null) => {
  const pinataJwt = jwt || PINATA_JWT;
  if (!pinataJwt) {
    throw new Error('Pinata JWT not configured');
  }

  // Reuse pre-read buffer when available (read-once optimization for large RAW files)
  let fileBase64 = preReadBase64 || await FileSystem.readAsStringAsync(filePath, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const fileSize = Math.ceil(fileBase64.length * 0.75);
  console.log(`[NFT] Uploading ${fileSize} bytes to Pinata...`);

  // Use Pinata's pinFileToIPFS with multipart form data
  // React Native compatible approach
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  const isJson = contentType === 'application/json';
  const isEncrypted = contentType === 'application/octet-stream';
  // Derive correct file extension from MIME type for proper CID metadata
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/tiff': 'tiff', 'image/x-adobe-dng': 'dng', 'image/x-canon-cr2': 'cr2', 'image/x-canon-cr3': 'cr3', 'image/x-nikon-nef': 'nef', 'image/x-sony-arw': 'arw', 'image/x-fuji-raf': 'raf', 'image/x-olympus-orf': 'orf', 'image/x-panasonic-rw2': 'rw2', 'image/x-pentax-pef': 'pef', 'image/x-samsung-srw': 'srw' };
  const fileExt = isJson ? 'json' : isEncrypted ? 'bin' : (extMap[contentType] || 'jpg');
  const fileName = isJson ? `metadata_${Date.now()}.json` : isEncrypted ? `encrypted_${Date.now()}.bin` : `photo_${Date.now()}.${fileExt}`;

  // Decode base64 to binary — free intermediates to reduce peak memory (~6MB each)
  let binaryStr = atob(fileBase64);
  fileBase64 = null; // free ~8MB
  let bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  binaryStr = null; // free ~6MB

  // Build multipart body manually
  const bodyParts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`,
    `Content-Type: ${contentType}\r\n\r\n`,
  ];

  const headerStr = bodyParts.join('');
  const footerStr = `\r\n--${boundary}--\r\n`;

  // Combine header + file bytes + footer
  const headerBytes = new TextEncoder().encode(headerStr);
  const footerBytes = new TextEncoder().encode(footerStr);

  const body = new Uint8Array(headerBytes.length + bytes.length + footerBytes.length);
  body.set(headerBytes, 0);
  body.set(bytes, headerBytes.length);
  body.set(footerBytes, headerBytes.length + bytes.length);
  bytes = null; // free ~6MB — now copied into body

  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${pinataJwt}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[NFT] Pinata error response:', errorText);
    const error = new Error(`Pinata upload failed: ${response.status}`);
    error.status = response.status;
    error.responseText = errorText;
    throw error;
  }

  const result = await response.json();

  if (result.IpfsHash) {
    const cid = result.IpfsHash;
    console.log('[NFT] Uploaded to Pinata IPFS with CID:', cid);

    return {
      success: true,
      arweaveUrl: `https://ipfs.io/ipfs/${cid}`,  // public gateway — works in all NFT explorers
      pinataUrl: `https://gateway.pinata.cloud/ipfs/${cid}`,
      ipfsUrl: `ipfs://${cid}`,
      transactionId: cid,
      size: fileSize,
    };
  }

  const error = new Error(result?.error?.message || result?.message || 'No hash returned from Pinata');
  error.responseText = JSON.stringify(result);
  throw error;
};

/**
 * Upload file to Arweave via Akord API (permanent decentralized storage)
 * Files are stored permanently — pay once, accessible forever.
 * @param {string} filePath - Path to the file
 * @param {string} contentType - MIME type
 * @returns {Object} { success, arweaveUrl, transactionId, size, error }
 */
const uploadToAkordArweave = async (filePath, contentType = 'image/jpeg', preReadBase64 = null) => {
  if (!AKORD_API_KEY) {
    return { success: false, error: 'Akord API key not configured. Get one at https://akord.com' };
  }

  // Reuse pre-read buffer when available (read-once optimization)
  const fileBase64 = preReadBase64 || await FileSystem.readAsStringAsync(filePath, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const fileSize = Math.ceil(fileBase64.length * 0.75);
  console.log(`[NFT] Uploading ${fileSize} bytes to Arweave via Akord...`);

  // Convert base64 to binary for upload
  const binaryStr = atob(fileBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const response = await fetch('https://api.akord.com/files', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Api-Key': AKORD_API_KEY,
      'Content-Type': contentType,
    },
    body: bytes,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Akord upload failed: ${response.status} ${errText}`);
  }

  const result = await response.json();

  if (result.tx && result.tx.id) {
    const txId = result.tx.id;
    // akrd.net works immediately (falls back to cloud while pending on Arweave)
    const arweaveUrl = `https://akrd.net/${txId}`;
    console.log('[NFT] Uploaded to Arweave, tx:', txId);

    return {
      success: true,
      arweaveUrl,
      permanentUrl: `https://arweave.net/${txId}`,
      transactionId: txId,
      size: fileSize,
      storageType: 'arweave',
    };
  }

  throw new Error('No transaction ID returned from Akord');
};

// ============================================================================
// NFT METADATA
// ============================================================================

/**
 * Compute SHA256 hash of file content for integrity proof
 * This creates a cryptographic commitment that anchors the NFT to the actual file
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} SHA256 hash as hex string
 */
export const computeContentHash = async (filePath, preReadBase64 = null) => {
  try {
    // Read file as base64 — reuse pre-read buffer when available (read-once optimization)
    const base64Content = preReadBase64 || await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Decode base64 to Uint8Array (NOT binary string)
    // js-sha256 treats string input as UTF-8, re-encoding bytes >127 as multi-byte
    // which produces wrong hashes. Uint8Array is treated as raw bytes.
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Compute SHA256 hash of raw bytes — pad to 64 hex chars (leading zeros can be dropped by js-sha256)
    const hash = sha256(bytes).padStart(64, '0');

    console.log('[NFT] Computed content hash:', hash.substring(0, 16) + '...');
    return hash;
  } catch (e) {
    console.error('[NFT] Failed to compute content hash:', e);
    return null;
  }
};

/**
 * Build Metaplex-compatible NFT metadata with edition support
 * Supports Open Edition (photo on blockchain) and Limited Edition (copyright certificate)
 * @param {Object} params - NFT parameters
 * @returns {Object} Metaplex metadata JSON
 */
export const buildNFTMetadata = ({
  name,
  description,
  imageUrl,
  fileUrl,
  ownerAddress,
  exifData,
  creatorAddress,
  contentHash,
  fileSize,
  royaltyBasisPoints = 500,
  // New edition fields
  edition = NFT_EDITION.OPEN,
  license = 'arr',
  watermarked = false,
  encrypted = false,
  encryptionData = null,
  exifRawHash = null,
  exifHash = null,
  exifBindingHash = null,
  cameraSerialHash = null,
  originalFormat = null,
  originalResolution = null,
  uploadMimeType = null,
  storageOption = null,
  tsaToken = null,
  tsaUrl = null,
  tsaPolicy = null,
  c2paManifest = null,
  mintTimestamp = null,
  certificationMode = null,
}) => {
  const isLimited = edition === NFT_EDITION.LIMITED;
  const editionLabel = isLimited ? 'Limited' : 'Open';
  const bps = EDITION_ROYALTY_BPS[edition] || royaltyBasisPoints;

  // Resolve license label
  const licenseEntry = NFT_LICENSE_OPTIONS.find(l => l.id === license);
  const licenseLabel = licenseEntry ? licenseEntry.label : 'All Rights Reserved';

  const defaultDesc = 'Certified Original — certificate of authenticity with RFC 3161 trusted timestamp and C2PA provenance';

  const metadata = {
    name: name || ('Certified Original — ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })),
    symbol: PHOTOLYNK_COLLECTION.symbol,
    description: description || defaultDesc,
    image: imageUrl,
    external_url: 'https://stealthlynk.io',

    attributes: [
      { trait_type: 'Edition', value: editionLabel },
      ...(contentHash ? [{ trait_type: 'Content Hash', value: `SHA256:${contentHash}` }] : []),
      ...(exifRawHash ? [{ trait_type: 'EXIF Raw Hash', value: `SHA256:${exifRawHash}` }] : []),
      ...(exifHash ? [{ trait_type: 'EXIF Hash', value: `SHA256:${exifHash}` }] : []),
      ...(exifBindingHash ? [{ trait_type: 'EXIF Binding Hash', value: `SHA256:${exifBindingHash}` }] : []),
      ...(cameraSerialHash ? [{ trait_type: 'Camera Hash', value: `SHA256:${cameraSerialHash}` }] : []),
      ...(fileSize ? [{ trait_type: 'Original Size', value: `${fileSize} bytes` }] : []),
      ...(originalFormat ? [{ trait_type: 'Original Format', value: originalFormat }] : []),
      ...(originalResolution ? [{ trait_type: 'Resolution', value: originalResolution }] : []),
      { trait_type: 'License', value: licenseLabel },
      { trait_type: 'Watermarked', value: watermarked ? 'true' : 'false' },
      { trait_type: 'Encrypted', value: encrypted ? 'true' : 'false' },
      { trait_type: 'Proof Type', value: 'Certificate of Authenticity' },
      ...(tsaToken ? [{ trait_type: 'RFC 3161 Timestamp', value: 'FreeTSA.org' }] : []),
      ...(c2paManifest ? [{ trait_type: 'C2PA Provenance', value: 'Included' }] : []),
      { trait_type: 'Storage', value: storageOption === 'cloud' ? 'StealthCloud' : storageOption === 'arweave' ? 'Arweave' : storageOption === 'onchain' ? 'Embedded SVG' : 'IPFS' },
      { trait_type: 'Minted With', value: 'PhotoLynk' },
      { trait_type: 'Platform', value: 'Solana Seeker' },
      ...(certificationMode ? [{ trait_type: 'Certification Mode', value: certificationMode === 'public' ? 'Public' : 'Private' }] : []),
    ],

    properties: {
      category: 'image',
      files: [{ uri: fileUrl || imageUrl, type: uploadMimeType || 'image/jpeg' }],
      creators: [{ address: creatorAddress || ownerAddress, share: 100 }],
      ...(encrypted ? {
        encryption: {
          method: 'NaCl-secretbox',
          encrypted: true,
          ...(encryptionData && encryptionData.wrappedKey && encryptionData.wrapNonce && encryptionData.nonce ? {
            wrappedKey: encryptionData.wrappedKey,
            wrapNonce: encryptionData.wrapNonce,
            nonce: encryptionData.nonce,
            ...(encryptionData.thumbnailNonce ? { thumbnailNonce: encryptionData.thumbnailNonce } : {}),
            ...(encryptionData.thumbnailUrl ? { thumbnailUrl: encryptionData.thumbnailUrl } : {}),
          } : {}),
        },
      } : {}),
      ...((true) ? {
        certificate: {
          version: 2,
          type: 'PhotoLynk Certificate of Authenticity',
          edition: editionLabel,
          mintedAt: mintTimestamp || new Date().toISOString(),
          originalHash: contentHash ? `SHA256:${contentHash}` : null,
          exifRawHash: exifRawHash ? `SHA256:${exifRawHash}` : null,
          exifHash: exifHash ? `SHA256:${exifHash}` : null,
          exifBindingHash: exifBindingHash ? `SHA256:${exifBindingHash}` : null,
          cameraSerialHash: cameraSerialHash ? `SHA256:${cameraSerialHash}` : null,
          originalFormat: originalFormat || null,
          originalResolution: originalResolution || null,
          originalSizeBytes: fileSize || null,
          creatorWallet: creatorAddress || ownerAddress,
          license: licenseLabel,
          watermarked,
          originalStorageMode: 'creator_device_only',
          ...(tsaToken ? {
            rfc3161: {
              standard: 'RFC 3161',
              tsa: tsaUrl || 'https://freetsa.org/tsr',
              tsaPolicy: tsaPolicy || null,
              tsaTokenBase64: tsaToken,
              hashAlgorithm: 'SHA-256',
              hashedContent: contentHash,
            },
          } : {}),
        },
        ...(c2paManifest ? { c2pa: c2paManifest } : {}),
      } : {}),
    },

    seller_fee_basis_points: bps,
  };

  // Add EXIF data as attributes (both editions, unless stripped)
  if (exifData) {
    if (exifData.dateTaken) metadata.attributes.push({ trait_type: 'Date Taken', value: exifData.dateTaken });
    if (exifData.camera) metadata.attributes.push({ trait_type: 'Camera', value: exifData.camera });
    if (exifData.iso) metadata.attributes.push({ trait_type: 'ISO', value: String(exifData.iso) });
    if (exifData.aperture) metadata.attributes.push({ trait_type: 'Aperture', value: `f/${exifData.aperture}` });
    if (exifData.shutterSpeed) {
      const shutter = exifData.shutterSpeed < 1 ? `1/${Math.round(1 / exifData.shutterSpeed)}s` : `${exifData.shutterSpeed}s`;
      metadata.attributes.push({ trait_type: 'Shutter Speed', value: shutter });
    }
    if (exifData.focalLength) metadata.attributes.push({ trait_type: 'Focal Length', value: `${exifData.focalLength}mm` });
    if (exifData.width && exifData.height && !originalResolution) {
      metadata.attributes.push({ trait_type: 'Resolution', value: `${exifData.width}x${exifData.height}` });
    }
    if (exifData.latitude && exifData.longitude) {
      metadata.attributes.push({ trait_type: 'GPS', value: `${exifData.latitude.toFixed(4)}, ${exifData.longitude.toFixed(4)}` });
    }
  }

  return metadata;
};

/**
 * Upload metadata JSON to storage (IPFS or Arweave depending on storageOption)
 * @param {Object} metadata - NFT metadata object
 * @param {string} storageOption - Storage option
 * @param {string|null} nftKeyB64 - Optional: base64-encoded per-NFT key to encrypt metadata before upload
 * @returns {Object} { success, arweaveUrl, metadataNonce?, ... }
 */
export const uploadMetadataToArweave = async (metadata, storageOption, nftKeyB64 = null) => {
  let metadataJson = JSON.stringify(metadata, null, 2);
  console.log('[NFT] Uploading metadata JSON:', metadataJson.substring(0, 200) + '...');

  let contentType = 'application/json';
  let fileBase64;
  let metadataNonce = null;

  if (nftKeyB64) {
    // Encrypt metadata JSON with per-NFT key before uploading
    const nftKey = naclUtil.decodeBase64(nftKeyB64);
    const nonce = new Uint8Array(24);
    global.crypto.getRandomValues(nonce);
    let plaintext = naclUtil.decodeUTF8(metadataJson);
    let encrypted = nacl.secretbox(plaintext, nonce, nftKey);
    console.log('[NFT] Metadata encrypted before upload:', plaintext.length, '→', encrypted.length, 'bytes');
    // Free plaintext (~6MB) immediately — no longer needed
    plaintext = null;
    fileBase64 = naclUtil.encodeBase64(encrypted);
    // Free encrypted (~6MB) — now encoded as base64 string
    encrypted = null;
    metadataNonce = naclUtil.encodeBase64(nonce);
    contentType = 'application/octet-stream';
  } else {
    fileBase64 = btoa(unescape(encodeURIComponent(metadataJson)));
  }
  // Free metadataJson (~6MB for on-chain) — now encoded in fileBase64
  metadataJson = null;

  // Create temporary file for metadata
  const ext = nftKeyB64 ? 'bin' : 'json';
  const tempPath = `${FileSystem.cacheDirectory}nft_metadata_${Date.now()}.${ext}`;
  await FileSystem.writeAsStringAsync(tempPath, fileBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  // Free fileBase64 (~8MB for on-chain encrypted) — now written to temp file
  fileBase64 = null;

  let result;
  if (storageOption === NFT_STORAGE_OPTIONS.ARWEAVE) {
    result = await uploadToAkordArweave(tempPath, contentType);
  } else {
    result = await uploadToArweave(tempPath, contentType, {
      'NFT-Type': 'metadata',
    });
  }

  // Clean up temp file
  try {
    await FileSystem.deleteAsync(tempPath, { idempotent: true });
  } catch (e) { }

  if (result.success) {
    console.log('[NFT] Metadata uploaded to:', result.arweaveUrl);
    if (metadataNonce) result.metadataNonce = metadataNonce;
  }

  return result;
};

// ============================================================================
// NFT MINTING COST ESTIMATION
// ============================================================================

// Cache priority fees to avoid 429s when cost estimation fires multiple times
let _cachedPriorityFee = null;
let _cachedPriorityFeeTs = 0;
const PRIORITY_FEE_CACHE_MS = 30000; // 30 seconds

/**
 * Estimate total NFT minting cost
 * @param {number} imageSizeBytes - Image file size
 * @param {string} storageOption - 'ipfs' or 'cloud' (optional, defaults to 'ipfs')
 * @param {boolean} useCompressed - Use compressed NFT (cNFT) pricing (default: true)
 * @returns {Object} Cost breakdown
 */
export const estimateNFTMintCost = async (imageSizeBytes, storageOption = 'ipfs', useCompressed = true, edition = 'open', paymentMethod = NFT_PAYMENT_METHODS.SOL, weeklyDiscountQuote = null) => {
  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
  const solPrice = await fetchSolPrice();

  // Storage upload cost (image + metadata)
  // StealthCloud and onchain have no separate image upload cost
  const useCloud = storageOption === NFT_STORAGE_OPTIONS.STEALTHCLOUD;
  const useOnChain = storageOption === NFT_STORAGE_OPTIONS.ONCHAIN;
  const imageUploadCost = (useCloud || useOnChain || (useCompressed && cNFTAvailable))
    ? { arweaveSol: 0, arweaveUsd: 0 }
    : await estimateArweaveUploadCost(imageSizeBytes);
  const metadataUploadCost = (useCompressed && cNFTAvailable)
    ? { arweaveSol: 0, arweaveUsd: 0 }
    : await estimateArweaveUploadCost(useOnChain ? (imageSizeBytes + 2000) : 2000); // onchain: image embedded in metadata JSON

  // Priority fee is not added to cNFT transactions — base fee 0.000005 SOL only
  const priorityFeeSol = 0;

  // Solana costs - MUCH cheaper for cNFTs
  let solanaRentSol, metaplexFeeSol, baseFeeSol, appCommissionUsd;
  const isLimitedEdition = edition === NFT_EDITION.LIMITED;

  if (useCompressed && cNFTAvailable) {
    // Compressed NFT (cNFT) - 99.99% cheaper!
    solanaRentSol = 0;                    // No rent for cNFTs (stored in Merkle tree)
    metaplexFeeSol = 0;                   // No Metaplex fee for cNFTs
    baseFeeSol = 0.000005;               // Base transaction fee
    appCommissionUsd = computeSizeBasedFee(imageSizeBytes);
  } else {
    // Standard NFT (Token Metadata Legacy)
    solanaRentSol = 0.008;                // Mint + ATA + account rent
    metaplexFeeSol = 0.012;               // Metadata + Master Edition fees
    baseFeeSol = 0.000005;               // Base transaction fee
    appCommissionUsd = computeSizeBasedFee(imageSizeBytes);
  }

  const transactionFeeSol = baseFeeSol + priorityFeeSol;
  const appCommissionSol = appCommissionUsd / solPrice;
  const networkSol =
    imageUploadCost.arweaveSol +
    metadataUploadCost.arweaveSol +
    solanaRentSol +
    metaplexFeeSol +
    transactionFeeSol;
  const networkUsd = networkSol * solPrice;

  // Total
  const totalSol = networkSol + appCommissionSol;

  const totalUsd = totalSol * solPrice;
  const payment = {
    method: normalizedPaymentMethod,
    network: {
      sol: networkSol,
      usd: networkUsd,
      solFormatted: networkSol.toFixed(6),
      usdFormatted: `$${networkUsd.toFixed(2)}`,
    },
    commission: {
      originalUsd: appCommissionUsd,
      discountedUsd: appCommissionUsd,
      savingsUsd: 0,
      sol: appCommissionSol,
      tokenSymbol: null,
      tokenAmount: null,
      tokenAmountFormatted: null,
      error: null,
    },
    dueNow: {
      sol: totalSol,
      usd: totalUsd,
      solFormatted: totalSol.toFixed(6),
      usdFormatted: `$${totalUsd.toFixed(2)}`,
      tokenSymbol: null,
      tokenAmount: null,
      tokenAmountFormatted: null,
    },
  };

  if (normalizedPaymentMethod === NFT_PAYMENT_METHODS.SKR) {
    try {
      const quote = await buildSkrCommissionQuote(appCommissionUsd, weeklyDiscountQuote);
      payment.commission = {
        originalUsd: appCommissionUsd,
        discountedUsd: quote.discountedUsd,
        savingsUsd: quote.savingsUsd,
        sol: appCommissionSol,
        tokenSymbol: quote.token.symbol,
        tokenAmount: quote.token.amount,
        tokenAmountFormatted: quote.token.amountFormatted,
        tokenMint: quote.token.mint,
        tokenDecimals: quote.token.decimals,
        tokenAmountRaw: quote.token.amountRaw,
        priceUsd: quote.token.priceUsd,
        discount: quote.discount,
        error: null,
      };
      payment.dueNow = {
        sol: networkSol,
        usd: networkUsd + quote.discountedUsd,
        solFormatted: networkSol.toFixed(6),
        usdFormatted: `$${(networkUsd + quote.discountedUsd).toFixed(2)}`,
        tokenSymbol: quote.token.symbol,
        tokenAmount: quote.token.amount,
        tokenAmountFormatted: quote.token.amountFormatted,
      };
    } catch (e) {
      const discountQuote = normalizeWeeklyDiscountQuote(weeklyDiscountQuote);
      const discountedUsd = Math.max(0.03, Math.round(appCommissionUsd * discountQuote.multiplier * 10000) / 10000);
      payment.commission = {
        originalUsd: appCommissionUsd,
        discountedUsd,
        savingsUsd: Math.max(0, appCommissionUsd - discountedUsd),
        sol: appCommissionSol,
        tokenSymbol: SKR_TOKEN_SYMBOL,
        discount: discountQuote,
        error: e.message,
      };
      payment.dueNow = {
        sol: networkSol,
        usd: networkUsd + discountedUsd,
        solFormatted: networkSol.toFixed(6),
        usdFormatted: `$${(networkUsd + discountedUsd).toFixed(2)}`,
        tokenSymbol: SKR_TOKEN_SYMBOL,
        tokenAmount: null,
        tokenAmountFormatted: null,
      };
    }
  }

  return {
    isCompressed: useCompressed && cNFTAvailable,
    breakdown: {
      arweaveImage: { sol: imageUploadCost.arweaveSol, usd: imageUploadCost.arweaveUsd },
      arweaveMetadata: { sol: metadataUploadCost.arweaveSol, usd: metadataUploadCost.arweaveUsd },
      solanaRent: { sol: solanaRentSol, usd: solanaRentSol * solPrice },
      metaplexFee: { sol: metaplexFeeSol, usd: metaplexFeeSol * solPrice },
      transactionFee: { sol: transactionFeeSol, usd: transactionFeeSol * solPrice },
      appCommission: { sol: appCommissionSol, usd: appCommissionUsd },
    },
    total: {
      sol: totalSol,
      usd: totalUsd,
      solFormatted: totalSol.toFixed(6),
      usdFormatted: `$${totalUsd.toFixed(2)}`,
    },
    solPrice,
    payment,
  };
};

const prepareCommissionPayment = async ({ ownerPubkey, paymentMethod, commissionUsd, solPrice, waiveCommission = false, weeklyDiscountQuote = null, isLegacySubscriber = false, isPremiumBeyond100 = false, discountPct = 0 }) => {
  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
  const originalUsd = Math.max(0, Number(commissionUsd || 0));

  if (isLegacySubscriber) {
    return { method: normalizedPaymentMethod, skipped: true, legacyWaived: true };
  }

  if (isPremiumBeyond100) {
    if (!splTokenAvailable || !createTransferInstruction || !getAssociatedTokenAddress) {
      throw new Error('USDC payments are not available on this build');
    }
    const conn = connection || new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    const mintPubkey = new PublicKey(USDC_MINT);
    const collectorOwner = new PublicKey(NFT_COMMISSION_WALLET);
    const ownerTokenAccount = await getAssociatedTokenAddress(mintPubkey, ownerPubkey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const collectorTokenAccount = await getAssociatedTokenAddress(mintPubkey, collectorOwner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ownerTokenInfo = await conn.getAccountInfo(ownerTokenAccount);
    if (!ownerTokenInfo) {
      throw new Error('No USDC token account found in your wallet. Need $0.02 USDC for this mint.');
    }
    const ownerBalance = await conn.getTokenAccountBalance(ownerTokenAccount).catch(() => null);
    const flatFeeRaw = Math.round(FLAT_FEE_BEYOND_100_USD * Math.pow(10, USDC_DECIMALS));
    const availableRaw = Number(ownerBalance?.value?.amount || 0);
    if (!Number.isFinite(availableRaw) || availableRaw < flatFeeRaw) {
      throw new Error(`Insufficient USDC balance. Need $${FLAT_FEE_BEYOND_100_USD.toFixed(2)} USDC for this mint.`);
    }
    let collectorAtaExists = false;
    if (!createAssociatedTokenAccountIdempotentInstruction) {
      collectorAtaExists = !!(await conn.getAccountInfo(collectorTokenAccount));
    }
    return {
      method: normalizedPaymentMethod,
      skipped: false,
      isUsdcFlatFee: true,
      originalUsd: FLAT_FEE_BEYOND_100_USD,
      discountedUsd: FLAT_FEE_BEYOND_100_USD,
      savingsUsd: 0,
      tokenSymbol: 'USDC',
      tokenMint: mintPubkey,
      tokenAmount: FLAT_FEE_BEYOND_100_USD,
      tokenAmountFormatted: `$${FLAT_FEE_BEYOND_100_USD.toFixed(2)} USDC`,
      tokenAmountRaw: flatFeeRaw,
      tokenDecimals: USDC_DECIMALS,
      ownerTokenAccount,
      collectorTokenAccount,
      collectorOwner,
      collectorAtaExists,
    };
  }

  if (waiveCommission || originalUsd <= 0) {
    return { method: normalizedPaymentMethod, skipped: true };
  }

  const effectiveDiscountPct = Math.max(0, Math.min(100, Number(discountPct) || 0));
  const effectiveCommissionUsd = effectiveDiscountPct > 0
    ? Math.max(0, Math.round(originalUsd * (100 - effectiveDiscountPct) / 100 * 10000) / 10000)
    : originalUsd;

  if (normalizedPaymentMethod === NFT_PAYMENT_METHODS.SKR) {
    if (!splTokenAvailable || !createTransferInstruction || !getAssociatedTokenAddress) {
      throw new Error('SKR payments are not available on this build');
    }

    const quote = await buildSkrCommissionQuote(effectiveCommissionUsd, weeklyDiscountQuote);
    const conn = connection || new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    const mintPubkey = new PublicKey(SKR_TOKEN_MINT);
    const collectorOwner = new PublicKey(NFT_COMMISSION_WALLET);
    const ownerTokenAccount = await getAssociatedTokenAddress(mintPubkey, ownerPubkey);
    const collectorTokenAccount = await getAssociatedTokenAddress(mintPubkey, collectorOwner);
    const ownerTokenInfo = await conn.getAccountInfo(ownerTokenAccount);
    if (!ownerTokenInfo) {
      throw new Error(`No ${SKR_TOKEN_SYMBOL} token account found in your wallet`);
    }
    const ownerBalance = await conn.getTokenAccountBalance(ownerTokenAccount).catch(() => null);
    const availableRaw = Number(ownerBalance?.value?.amount || 0);
    if (!Number.isFinite(availableRaw) || availableRaw < quote.token.amountRaw) {
      throw new Error(`Insufficient ${SKR_TOKEN_SYMBOL} balance. Need ${quote.token.amountFormatted} ${SKR_TOKEN_SYMBOL}`);
    }
    let collectorAtaExists = false;
    if (!createAssociatedTokenAccountIdempotentInstruction) {
      collectorAtaExists = !!(await conn.getAccountInfo(collectorTokenAccount));
    }

    return {
      method: normalizedPaymentMethod,
      skipped: false,
      originalUsd,
      discountedUsd: quote.discountedUsd,
      savingsUsd: quote.savingsUsd,
      discount: quote.discount,
      tokenSymbol: quote.token.symbol,
      tokenMint: mintPubkey,
      tokenAmount: quote.token.amount,
      tokenAmountFormatted: quote.token.amountFormatted,
      tokenAmountRaw: quote.token.amountRaw,
      tokenDecimals: quote.token.decimals,
      ownerTokenAccount,
      collectorTokenAccount,
      collectorOwner,
      collectorAtaExists,
    };
  }

  const safeSolPrice = solPrice > 10 ? solPrice : 250;
  const amountSol = effectiveCommissionUsd / safeSolPrice;
  const savingsUsd = originalUsd - effectiveCommissionUsd;
  return {
    method: normalizedPaymentMethod,
    skipped: false,
    originalUsd,
    discountedUsd: effectiveCommissionUsd,
    savingsUsd,
    lamports: Math.ceil(amountSol * LAMPORTS_PER_SOL),
    amountSol,
  };
};

const appendCommissionPaymentInstructions = (instructions, ownerPubkey, commissionPayment) => {
  if (!commissionPayment || commissionPayment.skipped) return;

  if (commissionPayment.isUsdcFlatFee) {
    if (createAssociatedTokenAccountIdempotentInstruction) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          ownerPubkey,
          commissionPayment.collectorTokenAccount,
          commissionPayment.collectorOwner,
          commissionPayment.tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    } else if (!commissionPayment.collectorAtaExists) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          ownerPubkey,
          commissionPayment.collectorTokenAccount,
          commissionPayment.collectorOwner,
          commissionPayment.tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    instructions.push(
      createTransferInstruction(
        commissionPayment.ownerTokenAccount,
        commissionPayment.collectorTokenAccount,
        ownerPubkey,
        commissionPayment.tokenAmountRaw,
        [],
        TOKEN_PROGRAM_ID
      )
    );
    return;
  }

  if (commissionPayment.method === NFT_PAYMENT_METHODS.SKR) {
    if (createAssociatedTokenAccountIdempotentInstruction) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          ownerPubkey,
          commissionPayment.collectorTokenAccount,
          commissionPayment.collectorOwner,
          commissionPayment.tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    } else if (!commissionPayment.collectorAtaExists) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          ownerPubkey,
          commissionPayment.collectorTokenAccount,
          commissionPayment.collectorOwner,
          commissionPayment.tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    instructions.push(
      createTransferInstruction(
        commissionPayment.ownerTokenAccount,
        commissionPayment.collectorTokenAccount,
        ownerPubkey,
        commissionPayment.tokenAmountRaw,
        [],
        TOKEN_PROGRAM_ID
      )
    );
    return;
  }

  instructions.push(
    SystemProgram.transfer({
      fromPubkey: ownerPubkey,
      toPubkey: new PublicKey(NFT_COMMISSION_WALLET),
      lamports: commissionPayment.lamports,
    })
  );
};

// ============================================================================
// COMPRESSED NFT (cNFT) MINTING - 99.99% CHEAPER
// ============================================================================

/**
 * Mint a compressed NFT (cNFT) using raw Bubblegum instructions
 * This is ~99.99% cheaper than regular NFTs
 * No UMI dependency - uses raw Solana instructions for React Native compatibility
 * @param {Object} params - Minting parameters
 * @returns {Object} { success, assetId, txSignature, error }
 */
const mintCompressedNFT = async ({
  ownerPubkey,
  ownerAddressStr,
  nftName,
  nftDescription,
  metadataUrl,
  imageUrl,
  wallet,
}) => {
  if (!cNFTAvailable) {
    throw new Error('Compressed NFT support not available');
  }

  console.log('[cNFT] Starting compressed NFT mint (raw instructions mode)...');

  try {
    const { blockhash } = await getLatestBlockhashWithRetry('confirmed');

    // Build the mintV1 instruction using Bubblegum
    // The tree must be public for anyone to mint to it
    const merkleTreePubkey = new PublicKey(PHOTOLYNK_MERKLE_TREE);

    // Bubblegum Program ID
    const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
    const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
    const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');

    // Derive tree config PDA
    const [treeConfig] = PublicKey.findProgramAddressSync(
      [merkleTreePubkey.toBuffer()],
      BUBBLEGUM_PROGRAM_ID
    );

    // Derive bubblegum signer PDA
    const [bubblegumSigner] = PublicKey.findProgramAddressSync(
      [Buffer.from('collection_cpi')],
      BUBBLEGUM_PROGRAM_ID
    );

    // Build metadata for the cNFT
    const metadataArgs = {
      name: nftName.slice(0, 32),
      symbol: 'PLNK',
      uri: metadataUrl,
      sellerFeeBasisPoints: 500, // 5%
      primarySaleHappened: false,
      isMutable: true,
      editionNonce: null,
      tokenStandard: null,
      collection: null,
      uses: null,
      tokenProgramVersion: 0, // Original
      creators: [{
        address: ownerPubkey,
        verified: false,
        share: 100,
      }],
    };

    // Serialize metadata args for the instruction
    // This is a simplified version - in production, use proper borsh serialization
    const metadataBuffer = serializeMetadataArgs(metadataArgs);

    // Build mintV1 instruction using proper TransactionInstruction
    // Discriminator is 8 bytes: [145, 98, 192, 118, 184, 147, 118, 104]
    const MINT_V1_DISCRIMINATOR = new Uint8Array([145, 98, 192, 118, 184, 147, 118, 104]);

    // Combine discriminator and metadata into single Uint8Array
    const instructionData = new Uint8Array(MINT_V1_DISCRIMINATOR.length + metadataBuffer.length);
    instructionData.set(MINT_V1_DISCRIMINATOR, 0);
    instructionData.set(metadataBuffer, MINT_V1_DISCRIMINATOR.length);

    const mintV1Instruction = new TransactionInstruction({
      keys: [
        { pubkey: treeConfig, isSigner: false, isWritable: true },      // 0: treeConfig
        { pubkey: ownerPubkey, isSigner: false, isWritable: false },    // 1: leafOwner
        { pubkey: ownerPubkey, isSigner: false, isWritable: false },    // 2: leafDelegate
        { pubkey: merkleTreePubkey, isSigner: false, isWritable: true },// 3: merkleTree
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },      // 4: payer
        { pubkey: ownerPubkey, isSigner: true, isWritable: false },     // 5: treeCreatorOrDelegate
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // 6: logWrapper
        { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // 7: compressionProgram
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 8: systemProgram
      ],
      programId: BUBBLEGUM_PROGRAM_ID,
      data: instructionData,
    });

    // App commission transfer (skip if fee wallet minting for itself)
    const mintInstructions = [mintV1Instruction];
    if (!isFeeWalletExempt(ownerPubkey)) {
      const commissionLamports = Math.ceil(computeSizeBasedFee(fileSize) / (await fetchSolPrice()) * LAMPORTS_PER_SOL);
      mintInstructions.push(SystemProgram.transfer({
        fromPubkey: ownerPubkey,
        toPubkey: new PublicKey(NFT_COMMISSION_WALLET),
        lamports: commissionLamports,
      }));
    } else {
      console.log('[cNFT] Fee wallet exempt — skipping commission');
    }

    // Build transaction
    const messageV0 = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: blockhash,
      instructions: mintInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    // Sign and send via wallet
    const signatures = await wallet.signAndSendTransactions({
      transactions: [transaction],
    });

    const txSignature = signatures[0];
    console.log('[cNFT] Transaction signature:', txSignature);

    // For cNFTs, the asset ID is derived from the tree and leaf index
    // We'll need to parse the transaction to get the leaf index
    // For now, use a placeholder that can be resolved later
    const assetId = `cnft_${txSignature.slice(0, 16)}`;

    return {
      success: true,
      assetId,
      txSignature,
      isCompressed: true,
      merkleTree: PHOTOLYNK_MERKLE_TREE,
    };
  } catch (e) {
    console.error('[cNFT] Minting failed:', e);
    throw e;
  }
};

/**
 * Serialize metadata args for Bubblegum mintV1 instruction
 * Follows exact borsh format from @metaplex-foundation/mpl-bubblegum
 * 
 * MetadataArgs structure:
 * - name: string (4 byte length + data)
 * - symbol: string
 * - uri: string  
 * - sellerFeeBasisPoints: u16
 * - primarySaleHappened: bool
 * - isMutable: bool
 * - editionNonce: Option<u8> (0 for None, 1 + value for Some)
 * - tokenStandard: Option<TokenStandard> (should be Some(NonFungible) = 1 + 0)
 * - collection: Option<Collection> (0 for None)
 * - uses: Option<Uses> (0 for None)
 * - tokenProgramVersion: enum (0 = Original)
 * - creators: Vec<Creator>
 */
const serializeMetadataArgs = (args) => {
  const buffers = [];

  // Helper to write string (4 byte length + data)
  const writeString = (str) => {
    const bytes = Buffer.from(str || '');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length);
    buffers.push(lenBuf, bytes);
  };

  // Name
  writeString(args.name);

  // Symbol
  writeString(args.symbol || '');

  // URI
  writeString(args.uri);

  // Seller fee basis points (u16)
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(args.sellerFeeBasisPoints);
  buffers.push(feeBuf);

  // Primary sale happened (bool)
  buffers.push(Buffer.from([args.primarySaleHappened ? 1 : 0]));

  // Is mutable (bool)
  buffers.push(Buffer.from([args.isMutable ? 1 : 0]));

  // Edition nonce (Option<u8>): None = 0
  buffers.push(Buffer.from([0]));

  // Token standard (Option<TokenStandard>): Some(NonFungible) = 1 + 0
  // TokenStandard enum: NonFungible = 0, FungibleAsset = 1, Fungible = 2, NonFungibleEdition = 3
  buffers.push(Buffer.from([1, 0])); // Some(NonFungible)

  // Collection (Option<Collection>): None = 0
  buffers.push(Buffer.from([0]));

  // Uses (Option<Uses>): None = 0
  buffers.push(Buffer.from([0]));

  // Token program version (enum: 0 = Original, 1 = Token2022)
  buffers.push(Buffer.from([args.tokenProgramVersion || 0]));

  // Creators (Vec<Creator>): 4 byte length + array of Creator
  const creatorsLenBuf = Buffer.alloc(4);
  creatorsLenBuf.writeUInt32LE(args.creators.length);
  buffers.push(creatorsLenBuf);

  for (const creator of args.creators) {
    // Creator: address (32 bytes) + verified (bool) + share (u8)
    const addressBuffer = typeof creator.address === 'string'
      ? new PublicKey(creator.address).toBuffer()
      : creator.address.toBuffer();
    buffers.push(addressBuffer);
    buffers.push(Buffer.from([creator.verified ? 1 : 0]));
    buffers.push(Buffer.from([creator.share]));
  }

  // Return as Uint8Array for proper serialization with Mobile Wallet Adapter
  return new Uint8Array(Buffer.concat(buffers));
};

// ============================================================================
// NFT MINTING
// ============================================================================

/**
 * Mint NFT using WalletAdapter (for non-MWA wallets like Phantom deeplink, WalletConnect)
 * Builds transaction outside wallet session, signs via adapter, sends manually
 */
const mintWithWalletAdapter = async ({
  nftType,
  ownerPubkey,
  ownerAddressStr,
  prefetchedBlockhash,
  prefetchedMintRent,
  solPrice,
  imageUpload,
  thumbnailUrl,
  ipfsThumbnailUrl = null,
  metadataUpload,
  metadata,
  nftName,
  useStealthCloud,
  isLimited,
  fileSize,
  waiveCommission = false,
  commissionPayment = null,
  onStatus,
  onProgress,
}) => {
  const useCompressedNFT = nftType === 'compressed' && cNFTAvailable;
  const latestBlockhashResult = await getLatestBlockhashWithRetry('confirmed');
  const activeBlockhash = latestBlockhashResult.blockhash;
  const activeLastValidBlockHeight = latestBlockhashResult.lastValidBlockHeight;

  if (useCompressedNFT) {
    // ========== COMPRESSED NFT via WalletAdapter ==========
    console.log('[NFT] Building cNFT transaction for WalletAdapter...');
    onStatus?.('Minting compressed NFT...');

    const merkleTreePubkey = new PublicKey(PHOTOLYNK_MERKLE_TREE);
    const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
    const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
    const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');

    const [treeConfig] = PublicKey.findProgramAddressSync(
      [merkleTreePubkey.toBuffer()],
      BUBBLEGUM_PROGRAM_ID
    );

    const metadataArgs = {
      name: nftName.slice(0, 32),
      symbol: 'PLNK',
      uri: metadataUpload.arweaveUrl,
      sellerFeeBasisPoints: 500,
      primarySaleHappened: false,
      isMutable: true,
      editionNonce: null,
      tokenStandard: null,
      collection: null,
      uses: null,
      tokenProgramVersion: 0,
      creators: [{ address: ownerPubkey, verified: true, share: 100 }],
    };

    const metadataBuffer = serializeMetadataArgs(metadataArgs);
    const MINT_V1_DISCRIMINATOR = new Uint8Array([145, 98, 192, 118, 184, 147, 118, 104]);
    const instructionData = new Uint8Array(MINT_V1_DISCRIMINATOR.length + metadataBuffer.length);
    instructionData.set(MINT_V1_DISCRIMINATOR, 0);
    instructionData.set(metadataBuffer, MINT_V1_DISCRIMINATOR.length);

    const mintV1Instruction = new TransactionInstruction({
      keys: [
        { pubkey: treeConfig, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: false, isWritable: false },
        { pubkey: ownerPubkey, isSigner: false, isWritable: false },
        { pubkey: merkleTreePubkey, isSigner: false, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: true },
        { pubkey: ownerPubkey, isSigner: true, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: BUBBLEGUM_PROGRAM_ID,
      data: instructionData,
    });

    // Commission (skip if fee wallet minting for itself)
    const cNFTWAInstructions = [mintV1Instruction];
    if (commissionPayment && !commissionPayment.skipped) {
      console.log('[cNFT/WA] Commission payment method:', commissionPayment.method === NFT_PAYMENT_METHODS.SKR
        ? `${commissionPayment.tokenAmountFormatted} ${SKR_TOKEN_SYMBOL}`
        : `${commissionPayment.lamports} lamports`);
      appendCommissionPaymentInstructions(cNFTWAInstructions, ownerPubkey, commissionPayment);
    } else {
      console.log(waiveCommission
        ? '[cNFT/WA] Premium entitlement active — skipping commission'
        : '[cNFT/WA] Fee wallet exempt — skipping commission');
    }

    // Build transaction
    const messageV0 = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: activeBlockhash,
      instructions: cNFTWAInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    // Sign and send via WalletAdapter
    console.log('[cNFT] Signing via WalletAdapter...');
    onStatus?.('Signing transaction...');
    const txResult = await WalletAdapter.signAndSendTransaction(transaction);

    if (!txResult.success) {
      throw new Error(txResult.error || 'WalletAdapter signing failed');
    }

    console.log('[cNFT] ✅ Transaction SUCCESS:', txResult.signature);

    return {
      txSignature: txResult.signature,
      _blockhash: activeBlockhash,
      _lastValidBlockHeight: activeLastValidBlockHeight,
      ownerAddress: ownerAddressStr,
      imageUrl: imageUpload.arweaveUrl,
      thumbnailUrl,
      ipfsThumbnailUrl,
      metadataUrl: metadataUpload.arweaveUrl,
      metadata,
      isRealNFT: true,
      isCompressed: true,
      merkleTree: PHOTOLYNK_MERKLE_TREE,
      _needsDasLookup: true,
    };
  } else {
    // ========== STANDARD NFT via WalletAdapter ==========
    console.log('[NFT] Building standard NFT transaction for WalletAdapter...');
    onStatus?.('Minting standard NFT...');

    const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    const mintKeypair = Keypair.generate();
    const mintPubkey = mintKeypair.publicKey;
    const mintRent = (Number.isFinite(prefetchedMintRent) && prefetchedMintRent > 0)
      ? prefetchedMintRent
      : await connection.getMinimumBalanceForRentExemption(MINT_SIZE || 82);

    console.log('[NFT] Mint address:', mintPubkey.toBase58());

    const associatedTokenAccount = PublicKey.findProgramAddressSync(
      [ownerPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];

    const metadataAccount = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID
    )[0];

    const masterEditionAccount = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer(), Buffer.from('edition')],
      TOKEN_METADATA_PROGRAM_ID
    )[0];

    // Build instructions (same as MWA path)
    const createMintInstruction = SystemProgram.createAccount({
      fromPubkey: ownerPubkey,
      newAccountPubkey: mintPubkey,
      space: 82,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    });

    const initializeMintInstruction = createInitializeMintInstruction(
      mintPubkey, 0, ownerPubkey, ownerPubkey
    );

    const createATAInstruction = createAssociatedTokenAccountInstruction(
      ownerPubkey, associatedTokenAccount, ownerPubkey, mintPubkey
    );

    const mintToInstruction = createMintToInstruction(
      mintPubkey, associatedTokenAccount, ownerPubkey, 1
    );

    const createMetadataInstruction = buildCreateMetadataInstruction(
      metadataAccount, mintPubkey, ownerPubkey, ownerPubkey, ownerPubkey,
      nftName.slice(0, 32), 'PLNK', metadataUpload.arweaveUrl, 500, ownerPubkey
    );

    const createMasterEditionInstruction = buildCreateMasterEditionInstruction(
      masterEditionAccount, mintPubkey, ownerPubkey, ownerPubkey, metadataAccount, ownerPubkey
    );

    // Commission (skip if fee wallet minting for itself)
    const stdWAInstructions = [
      createMintInstruction,
      initializeMintInstruction,
      createATAInstruction,
      mintToInstruction,
      createMetadataInstruction,
      createMasterEditionInstruction,
    ];
    if (commissionPayment && !commissionPayment.skipped) {
      appendCommissionPaymentInstructions(stdWAInstructions, ownerPubkey, commissionPayment);
    } else {
      console.log(waiveCommission
        ? '[NFT/WA] Premium entitlement active — skipping commission'
        : '[NFT/WA] Fee wallet exempt — skipping commission');
    }

    const messageV0 = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: activeBlockhash,
      instructions: stdWAInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([mintKeypair]);

    console.log('[NFT] Signing via WalletAdapter...');
    onStatus?.('Signing transaction...');
    const txResult = await WalletAdapter.signAndSendTransaction(transaction);

    if (!txResult.success) {
      throw new Error(txResult.error || 'WalletAdapter signing failed');
    }

    console.log('[NFT] ✅ Transaction SUCCESS:', txResult.signature);

    return {
      txSignature: txResult.signature,
      _blockhash: activeBlockhash,
      _lastValidBlockHeight: activeLastValidBlockHeight,
      mintAddress: mintPubkey.toBase58(),
      ownerAddress: ownerAddressStr,
      imageUrl: imageUpload.arweaveUrl,
      thumbnailUrl,
      ipfsThumbnailUrl,
      metadataUrl: metadataUpload.arweaveUrl,
      metadata,
      isRealNFT: true,
    };
  }
};

const buildTransactionFailureMessage = (err, logMessages = []) => {
  const errJson = typeof err === 'string' ? err : JSON.stringify(err);
  const logsText = Array.isArray(logMessages) ? logMessages.join(' | ') : '';
  if (/insufficient lamports|insufficient funds/i.test(logsText)) {
    return 'Transaction failed: insufficient SOL balance for network fees and commission';
  }
  return `Transaction failed: ${errJson}`;
};

const confirmMintTransaction = async (txSignature, blockhash, lastValidBlockHeight) => {
  if (!txSignature) {
    throw new Error('Missing transaction signature');
  }

  let confirmationError = null;
  try {
    const confirmation = await connection.confirmTransaction(
      { signature: txSignature, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    if (confirmation?.value?.err) {
      throw new Error(buildTransactionFailureMessage(confirmation.value.err));
    }
    return true;
  } catch (e) {
    confirmationError = e;
  }

  try {
    const txInfo = await connection.getTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
    if (txInfo?.meta?.err) {
      throw new Error(buildTransactionFailureMessage(txInfo.meta.err, txInfo.meta.logMessages));
    }
    if (txInfo) {
      return true;
    }
  } catch (txLookupErr) {
    if (!confirmationError) confirmationError = txLookupErr;
  }

  throw confirmationError || new Error('Transaction confirmation failed');
};

/**
 * Mint a photo as NFT on Solana
 * Supports Open Edition (image on blockchain) and Limited Edition (copyright certificate)
 * @param {Object} params - Minting parameters
 * @returns {Object} { success, mintAddress, txSignature, error }
 */
export const mintPhotoNFT = async ({
  asset,           // MediaLibrary asset
  filePath,        // Resolved file path
  name,            // NFT name
  description,     // NFT description
  stripExif,       // Remove EXIF data for privacy
  storageOption,   // 'ipfs' or 'cloud' (StealthCloud)
  nftType = 'compressed', // 'compressed' or 'standard' - defaults to compressed
  serverConfig,    // Server config for StealthCloud { baseUrl, headers }
  onProgress,      // Progress callback (0-1)
  onStatus,        // Status callback
  walletType = null, // Optional: specific wallet type to use
  // Edition parameters
  edition = NFT_EDITION.OPEN,  // 'open' or 'limited'
  license = 'arr',             // License ID from NFT_LICENSE_OPTIONS
  watermark = false,           // Burn visible watermark into preview/thumbnail
  encrypt = false,             // Encrypt image before upload
  masterKey = null,            // StealthCloud master key (required if encrypt=true)
  certificationMode = null,    // 'private' or 'public'
  paymentMethod = NFT_PAYMENT_METHODS.SOL,
  weeklyDiscountQuote = null,
  selectedWallet = null,
  isLegacySubscriber = false,
  isPremiumBeyond100 = false,
}) => {
  // Check if any wallet is available (WalletAdapter or MWA)
  if (!solanaAvailable || !isWalletAvailable() || !connection) {
    return { success: false, error: 'Solana not available' };
  }

  // Validate required parameters
  if (!filePath) {
    console.error('[NFT] No file path provided');
    return { success: false, error: 'No image file provided' };
  }

  // Ensure file:// prefix — normalizeFilePath strips it but Expo FileSystem APIs need it on Android
  if (filePath.startsWith('/') && !filePath.startsWith('file://')) {
    filePath = 'file://' + filePath;
  }

  if (encrypt && !masterKey) {
    return { success: false, error: 'Master key required for encryption' };
  }

  const isLimited = edition === NFT_EDITION.LIMITED;
  console.log('[NFT] Edition:', isLimited ? 'Limited' : 'Open', '| License:', license, '| Watermark:', watermark, '| Encrypt:', encrypt);

  // Validate file exists BEFORE setting minting lock (early return must not bypass finally)
  const fileInfo = await FileSystem.getInfoAsync(filePath);
  if (!fileInfo.exists) {
    console.error('[NFT] File does not exist:', filePath);
    return { success: false, error: 'Image file not found' };
  }
  const fileSize = fileInfo.size || 0;
  console.log('[NFT] File validated:', filePath, 'size:', fileSize);

  try {
    _mintingInProgress = true;
    console.log('[NFT] Minting lock ON — auto-scan/sync paused');
    onStatus?.('Preparing NFT...');
    onProgress?.(0.05);

    // Get asset info for EXIF
    const info = await MediaLibrary.getAssetInfoAsync(asset.id);
    const exifData = extractExifForNFT(asset, info);

    // ── 3-Hash EXIF Proof System ──────────────────────────────────────
    // Hash1 (raw): exact camera EXIF binary bytes, no parsing/rounding
    // Hash2 (normalized): parsed fields with r4/t4 rounding for cross-platform dedup
    // Hash3 (binding): SHA-256(Hash1 + "|" + Hash2) — cryptographically links both

    // Hash2: Normalized EXIF hash (cross-platform dedup)
    let exifHash = await computeExifHash(filePath);
    // Fallback: for HEIC/RAW (no JPEG APP1), compute from assetInfo.exif
    if (!exifHash && info) {
      exifHash = computeExifHashFromAssetInfo(info);
    }

    // Hash1: Raw EXIF binary hash (exact camera bytes — JPEG/PNG/WebP only on mobile)
    let exifRawHash = await computeExifRawHash(filePath);

    // Hash3: Binding proof
    let exifBindingHash = computeExifBindingHash(exifRawHash, exifHash);
    console.log(`[NFT] EXIF 3-hash proof: raw=${exifRawHash?.substring(0, 12) || 'null'}... norm=${exifHash?.substring(0, 12) || 'null'}... bind=${exifBindingHash?.substring(0, 12) || 'null'}...`);

    // Compute camera serial hash (device-binding proof — all editions)
    const camSerialHash = computeCameraSerialHash(info);

    // Determine original format and resolution
    const filename = asset.filename || info?.filename || '';
    const ext = filename.split('.').pop()?.toUpperCase() || 'JPEG';
    const originalFormat = ext;
    const originalResolution = (asset.width && asset.height) ? `${asset.width}x${asset.height}` : null;
    const mintTimestamp = new Date().toISOString();

    // Read-once optimization: read the original file into base64 once,
    // reuse for content hash + IPFS upload (avoids 3x disk reads for large RAW files)
    let originalBase64 = null;
    try {
      originalBase64 = await FileSystem.readAsStringAsync(filePath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      console.log(`[NFT] Read-once: ${Math.ceil(originalBase64.length * 0.75)} bytes buffered`);
    } catch (readErr) {
      console.warn('[NFT] Read-once failed, will fall back to per-operation reads:', readErr.message);
    }

    // Pre-compute contentHash (RFC 3161 needs it before wallet step)
    // Also computed later — we hoist it here to avoid double work
    let earlyContentHash = null;
    earlyContentHash = await computeContentHash(filePath, originalBase64);

    // RFC 3161 trusted timestamp + C2PA manifest (all editions)
    let tsaResult = null;
    let c2paManifest = null;
    if (earlyContentHash) {
      onStatus?.('Requesting trusted timestamp (RFC 3161)...');
      tsaResult = await requestRFC3161Timestamp(earlyContentHash);
      if (tsaResult.success) {
        console.log('[NFT] RFC 3161 timestamp obtained');
      } else {
        console.warn('[NFT] RFC 3161 failed (non-blocking):', tsaResult.error);
      }
      c2paManifest = buildC2PAManifest({
        contentHash: earlyContentHash,
        exifHash,
        cameraSerialHash: camSerialHash,
        creatorWallet: null,
        fileName: filename,
        fileSize: fileInfo.size || 0,
        originalFormat,
        originalResolution,
        tsaToken: tsaResult?.tsaToken || null,
        tsaUrl: tsaResult?.tsaUrl || null,
        mintTimestamp,
      });
      console.log('[NFT] C2PA manifest built');
    }

    onStatus?.('Estimating costs...');
    onProgress?.(0.1);

    // Estimate costs with correct storage option and NFT type
    const useCompressed = nftType === 'compressed';
    let authoritativeWeeklyDiscountQuote = weeklyDiscountQuote;
    if (normalizePaymentMethod(paymentMethod) === NFT_PAYMENT_METHODS.SKR && serverConfig?.baseUrl) {
      authoritativeWeeklyDiscountQuote = await fetchWeeklyNftDiscountQuote(serverConfig).catch(() => weeklyDiscountQuote);
    }
    const costEstimate = await estimateNFTMintCost(fileSize, storageOption, useCompressed, edition, paymentMethod, authoritativeWeeklyDiscountQuote);
    const premiumEntitlement = await getPremiumMintEntitlement(serverConfig);
    const isPremiumBeyond100Internal = !!premiumEntitlement.isPremium && premiumEntitlement.freeMintsRemaining <= 0;
    if (premiumEntitlement.isPremium && premiumEntitlement.freeMintsRemaining > 0 && serverConfig?.baseUrl) {
      console.log(`[NFT] Premium FREE mint (${premiumEntitlement.freeMintsRemaining} remaining) — using server wallet`);
      onStatus?.('Minting with premium (free)...');
      onProgress?.(0.2);
      try {
        const premiumWalletResult = selectedWallet?.success ? selectedWallet : await getConnectedWalletAddress();
        if (!premiumWalletResult.success || !premiumWalletResult.address) {
          return { success: false, error: premiumWalletResult.error || 'Wallet connection failed' };
        }
        const serverMintResult = await mintWithServerWallet({
          filePath,
          asset,
          name,
          description,
          stripExif,
          storageOption,
          edition,
          license,
          watermark,
          encrypt,
          masterKey,
          clientContentHash: earlyContentHash || null,
          clientExifRawHash: exifRawHash || null,
          clientExifHash: exifHash || null,
          clientExifBindingHash: exifBindingHash || null,
          clientCameraHash: camSerialHash || null,
          clientTsaToken: tsaResult?.tsaToken || null,
          clientTsaUrl: tsaResult?.tsaUrl || null,
          clientTsaPolicy: tsaResult?.tsaPolicy || null,
          clientC2paManifest: c2paManifest || null,
          clientMintTimestamp: mintTimestamp,
          recipientAddress: premiumWalletResult.address,
          certificationMode,
          serverConfig,
          onProgress,
          onStatus,
        });
        if (serverMintResult.success) {
          console.log('[NFT] ✅ Premium FREE mint SUCCESS:', serverMintResult.mintAddress);
          // Generate Certificate of Authenticity (mirrors wallet mint path at line ~4776)
          try {
            const cert = generateCertificate({
              mintAddress: serverMintResult.mintAddress,
              txSignature: serverMintResult.txSignature,
              ownerAddress: serverMintResult.ownerAddress,
              name,
              description,
              edition,
              license,
              watermarked: watermark,
              encrypted: serverMintResult.encrypted || false,
              storageType: storageOption,
              arweaveUrl: serverMintResult.imageUrl,
              metadataUrl: serverMintResult.metadataUrl,
              contentHash: serverMintResult.contentHash || null,
              exifRawHash: serverMintResult.exifRawHash || null,
              exifHash: serverMintResult.exifHash || null,
              exifBindingHash: serverMintResult.exifBindingHash || null,
              cameraHash: serverMintResult.cameraHash || null,
              hasRfc3161: !!serverMintResult.hasRfc3161,
              hasC2pa: !!serverMintResult.hasC2pa,
              rfc3161Token: serverMintResult.rfc3161Token || null,
              rfc3161Tsa: serverMintResult.rfc3161Tsa || serverMintResult.tsaUrl || null,
              tsaUrl: serverMintResult.tsaUrl || serverMintResult.rfc3161Tsa || null,
              c2paManifest: serverMintResult.c2paManifest || null,
              attributes: serverMintResult.attributes || serverMintResult.metadata?.attributes || [],
              metadata: serverMintResult.metadata || null,
              createdAt: serverMintResult.createdAt || serverMintResult.mintedAt || new Date().toISOString(),
              mintedAt: serverMintResult.mintedAt || serverMintResult.createdAt || new Date().toISOString(),
              certificationMode,
              forceGenerate: true,
            });
            if (cert) {
              const nftSyncUrl = 'https://stealthlynk.io';
              let certAuthHeaders = null;
              try { certAuthHeaders = await getServerHeadersFromConfig(serverConfig); } catch (_) { }
              await saveCertificate(cert, nftSyncUrl, certAuthHeaders);
              console.log('[NFT] Server mint certificate saved:', cert.id);
            }
          } catch (certErr) {
            console.warn('[NFT] Server mint certificate generation failed (non-critical):', certErr?.message);
          }
          return serverMintResult;
        }
        console.warn('[NFT] Server mint failed during premium free mint:', serverMintResult.error);
        onStatus?.('PhotoLynk mint failed');
        return {
          success: false,
          error: serverMintResult.error || 'PhotoLynk premium mint failed',
        };
      } catch (serverMintErr) {
        console.warn('[NFT] Server mint error during premium free mint:', serverMintErr.message);
        onStatus?.('PhotoLynk mint failed');
        return {
          success: false,
          error: serverMintErr.message || 'PhotoLynk premium mint failed',
        };
      }
    }
    if (premiumEntitlement.waiveCommission) {
      costEstimate.total.sol = Math.max(
        0,
        (costEstimate.total.sol || 0) - (costEstimate.breakdown?.appCommission?.sol || 0)
      );
      costEstimate.total.usd = Math.max(
        0,
        (costEstimate.total.usd || 0) - (costEstimate.breakdown?.appCommission?.usd || 0)
      );
      costEstimate.total.solFormatted = costEstimate.total.sol.toFixed(6);
      costEstimate.total.usdFormatted = `$${costEstimate.total.usd.toFixed(2)}`;
      if (costEstimate.breakdown?.appCommission) {
        costEstimate.breakdown.appCommission = { sol: 0, usd: 0 };
      }
      if (costEstimate.payment?.commission) {
        costEstimate.payment.commission = {
          ...costEstimate.payment.commission,
          originalUsd: 0,
          discountedUsd: 0,
          savingsUsd: 0,
          sol: 0,
          tokenAmount: 0,
          tokenAmountFormatted: '0',
          error: null,
        };
      }
      if (costEstimate.payment?.dueNow) {
        costEstimate.payment.dueNow = {
          ...costEstimate.payment.dueNow,
          sol: costEstimate.payment.network?.sol || costEstimate.total.sol,
          usd: costEstimate.payment.network?.usd || costEstimate.total.usd,
          solFormatted: (costEstimate.payment.network?.sol || costEstimate.total.sol).toFixed(6),
          usdFormatted: `$${(costEstimate.payment.network?.usd || costEstimate.total.usd).toFixed(2)}`,
          tokenAmount: 0,
          tokenAmountFormatted: '0',
        };
      }
    }
    console.log('[NFT] Cost estimate:', costEstimate.total, 'storage:', storageOption, 'compressed:', useCompressed, 'edition:', edition);

    // ========== STEP 1: Get wallet address first (universal) ==========
    onStatus?.('Connecting wallet...');
    onProgress?.(0.15);

    // Get wallet address using universal helper (supports WalletAdapter + MWA fallback)
    let ownerAddressStr;
    let ownerPubkey;
    let currentWalletType;

    const walletResult = selectedWallet?.success ? selectedWallet : await getConnectedWalletAddress();
    if (!walletResult.success) {
      return { success: false, error: walletResult.error || 'Wallet connection failed' };
    }

    ownerAddressStr = walletResult.address;
    ownerPubkey = walletResult.pubkey;
    currentWalletType = walletResult.walletType;
    console.log('[NFT] Owner address (base58):', ownerAddressStr, 'via', currentWalletType);

    // ========== STEP 2: Do all uploads OUTSIDE wallet session ==========
    // Handle EXIF stripping if requested
    let uploadFilePath = filePath;
    let cleanupTempFiles = [];

    if (stripExif) {
      onStatus?.('Removing private data...');
      onProgress?.(0.2);

      try {
        const stripResult = await stripExifFromImage(filePath);
        if (stripResult.success && stripResult.stripped) {
          uploadFilePath = stripResult.cleanPath;
          cleanupTempFiles.push(stripResult.cleanPath);
          console.log('[NFT] Using EXIF-stripped image');
        } else {
          console.warn('[NFT] EXIF stripping skipped, using original:', stripResult.error || 'not stripped');
        }
      } catch (stripError) {
        console.warn('[NFT] EXIF stripping error, using original:', stripError?.message || stripError);
      }
    }

    // ========== EDITION-SPECIFIC IMAGE PROCESSING ==========
    const useStealthCloud = storageOption === NFT_STORAGE_OPTIONS.STEALTHCLOUD && serverConfig;
    let imageToUploadPath = uploadFilePath;
    let encryptionData = null; // Stored locally for decryption

    // All editions: upload original image as-is (no resize/recompress)
    // onchain handles its own size budget in generateOnChainImage
    if (isLimited) {
      console.log('[NFT] Limited Edition: using original for on-chain embedding');
    } else {
      console.log('[NFT] Open Edition: using original image for upload');
    }

    // Apply watermark if requested (burns into preview/thumbnail before upload)
    if (watermark) {
      onStatus?.('Applying watermark...');
      const wmResult = await burnWatermark(imageToUploadPath);
      if (wmResult.success) {
        cleanupTempFiles.push(wmResult.watermarkedPath);
        imageToUploadPath = wmResult.watermarkedPath;
      }
    }

    // Encrypt image if requested
    let nftKeyB64 = null; // Raw per-NFT key for metadata encryption (memory only, never persisted)
    if (encrypt && masterKey) {
      onStatus?.('Encrypting image...');
      onProgress?.(0.24);
      const encResult = await encryptNFTImage(imageToUploadPath, masterKey);
      if (encResult.success) {
        imageToUploadPath = encResult.encryptedPath;
        cleanupTempFiles.push(encResult.encryptedPath);
        nftKeyB64 = encResult.nftKeyB64; // Hold in memory for metadata encryption
        encryptionData = {
          wrappedKey: encResult.wrappedKey,
          wrapNonce: encResult.wrapNonce,
          nonce: encResult.nonce,
          originalSize: encResult.originalSize,
        };
        console.log('[NFT] Image encrypted for upload');
      } else {
        console.warn('[NFT] Encryption failed, uploading unencrypted:', encResult.error);
      }
    }

    // Normalize EXIF orientation before upload (bake rotation into pixels)
    // so that web viewers (Tensor, explorers) display the image upright.
    // ONLY when image has already been processed (stripExif or watermark).
    // When neither is set: upload original bytes untouched — preserves EXIF,
    // original format (HEIC, PNG, RAW, etc.), and byte-exact SHA-256 match.
    // Content/EXIF hashes are computed from the original BEFORE this step.
    // RAW formats (CR3, NEF, ARW, etc.) will fail gracefully in the catch block.
    const imageAlreadyProcessed = stripExif || watermark;
    if (imageAlreadyProcessed && !encryptionData) {
      try {
        let pathForManipulator = imageToUploadPath;
        // manipulateAsync only works with file:// URIs — copy ph:// or other URIs first
        if (!pathForManipulator.startsWith('file://')) {
          const tmpCopy = `${FileSystem.cacheDirectory}nft_exif_${Date.now()}.jpg`;
          await FileSystem.copyAsync({ from: pathForManipulator, to: tmpCopy });
          cleanupTempFiles.push(tmpCopy);
          pathForManipulator = tmpCopy;
        }
        const normalized = await ImageManipulator.manipulateAsync(
          pathForManipulator,
          [{ rotate: 0 }],
          { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
        );
        if (normalized.uri) {
          cleanupTempFiles.push(normalized.uri);
          imageToUploadPath = normalized.uri;
          console.log('[NFT] EXIF orientation normalized for upload (image was already processed)');
        }
      } catch (exifErr) {
        console.log('[NFT] EXIF normalization skipped:', exifErr.message);
      }
    } else if (!encryptionData) {
      console.log('[NFT] Original bytes preserved for upload (no re-encode)');
    }

    // Upload processed image (or generate on-chain data URI)
    const useArweave = storageOption === NFT_STORAGE_OPTIONS.ARWEAVE;
    const useOnChain = storageOption === NFT_STORAGE_OPTIONS.ONCHAIN;
    let imageUpload;
    let onChainDataUri = null;
    const mimeTypes = { JPEG: 'image/jpeg', JPG: 'image/jpeg', PNG: 'image/png', HEIC: 'image/heic', HEIF: 'image/heif', WEBP: 'image/webp', GIF: 'image/gif', AVIF: 'image/avif', TIFF: 'image/tiff', TIF: 'image/tiff', DNG: 'image/x-adobe-dng', CR2: 'image/x-canon-cr2', CR3: 'image/x-canon-cr3', NEF: 'image/x-nikon-nef', ARW: 'image/x-sony-arw', RAF: 'image/x-fuji-raf', ORF: 'image/x-olympus-orf', RW2: 'image/x-panasonic-rw2', PEF: 'image/x-pentax-pef', SRW: 'image/x-samsung-srw' };
    // When strip or watermark is ON, ImageManipulator re-encodes to JPEG — use that MIME type
    // When uploading original bytes (no processing), use the actual format from the asset filename
    const actualUploadFormat = (imageAlreadyProcessed && !encryptionData) ? 'image/jpeg' : (mimeTypes[originalFormat] || 'image/jpeg');
    const uploadContentType = (encrypt && encryptionData) ? 'application/octet-stream' : actualUploadFormat;

    if (useOnChain) {
      // ON-CHAIN: embed original image as data URI — no separate image upload
      onStatus?.('Embedding original image...');
      onProgress?.(0.25);
      const onChainResult = await generateOnChainImage(uploadFilePath);
      if (!onChainResult.success) {
        throw new Error('On-chain image embedding failed: ' + onChainResult.error);
      }
      onChainDataUri = onChainResult.dataUri;
      imageUpload = { success: true, arweaveUrl: onChainDataUri, imageUrl: onChainDataUri, size: onChainResult.sizeBytes };
      console.log(`[NFT] On-chain: original image embedded as data URI`);
    } else if (useStealthCloud) {
      onStatus?.('Uploading to StealthCloud...');
      onProgress?.(0.25);
      imageUpload = await uploadToStealthCloud(imageToUploadPath, serverConfig);
    } else if (useArweave) {
      onStatus?.('Uploading to Arweave (permanent)...');
      onProgress?.(0.25);
      // Read-once: reuse originalBase64 when uploading the unmodified original file
      const reuseBuffer = (imageToUploadPath === filePath) ? originalBase64 : null;
      imageUpload = await uploadToAkordArweave(imageToUploadPath, uploadContentType, reuseBuffer);
    } else {
      // Hybrid IPFS mode: full image → StealthCloud, thumb+metadata → IPFS
      // Saves ~5MB/NFT on Pinata; ~32KB/NFT instead → ~15,000 NFTs on free plan
      if (serverConfig) {
        onStatus?.('Uploading image to StealthCloud...');
        onProgress?.(0.25);
        imageUpload = await uploadToStealthCloud(imageToUploadPath, serverConfig);
      } else {
        // Fallback: no server config, upload directly to IPFS
        onStatus?.('Uploading to IPFS...');
        onProgress?.(0.25);
        const reuseBuffer = (imageToUploadPath === filePath) ? originalBase64 : null;
        imageUpload = await uploadToArweave(imageToUploadPath, uploadContentType, {
          'NFT-Owner': ownerAddressStr,
          'Photo-Date': stripExif ? 'Private' : (exifData.dateTaken || 'Unknown'),
          'NFT-Edition': isLimited ? 'Limited' : 'Open',
        }, reuseBuffer);
      }
    }

    if (!imageUpload.success) {
      throw new Error('Image upload failed: ' + imageUpload.error);
    }

    const imageStorageLabel = useOnChain ? 'On-Chain' : useStealthCloud ? 'StealthCloud' : useArweave ? 'Arweave' : (serverConfig ? 'StealthCloud (hybrid IPFS)' : 'IPFS');
    console.log(`[NFT] Image ready via ${imageStorageLabel}:`, useOnChain ? '(data URI)' : imageUpload.arweaveUrl);

    // Generate and upload gallery thumbnail to StealthCloud
    // Unencrypted: plain JPEG thumbnail (800px)
    // Encrypted: 800px encrypted thumbnail (.bin) — DecryptedNFTImage decrypts it for gallery
    let thumbnailUrl = null;
    let ipfsThumbnailUrl = null;
    if (serverConfig) {
      onStatus?.('Creating thumbnail...');
      onProgress?.(0.30);

      if (encryptionData && nftKeyB64) {
        // Encrypted thumbnail: resize to 800px, encrypt with same per-NFT key, upload as .bin
        try {
          const thumbResult = await ImageManipulator.manipulateAsync(
            uploadFilePath,
            [{ resize: { width: THUMBNAIL_SIZE } }],
            { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG }
          );
          cleanupTempFiles.push(thumbResult.uri);
          console.log('[NFT] Encrypted thumbnail generated:', THUMBNAIL_SIZE, 'px wide');

          // Encrypt the thumbnail with the same per-NFT key
          let thumbB64 = await FileSystem.readAsStringAsync(thumbResult.uri, { encoding: FileSystem.EncodingType.Base64 });
          const thumbPlain = naclUtil.decodeBase64(thumbB64);
          thumbB64 = null;
          const nftKey = naclUtil.decodeBase64(nftKeyB64);
          const thumbNonce = new Uint8Array(24);
          global.crypto.getRandomValues(thumbNonce);
          let thumbEnc = nacl.secretbox(thumbPlain, thumbNonce, nftKey);
          // Write encrypted thumbnail to temp file
          const encThumbPath = `${FileSystem.cacheDirectory}nft_enc_thumb_${Date.now()}.bin`;
          let encThumbB64 = naclUtil.encodeBase64(thumbEnc);
          thumbEnc = null;
          await FileSystem.writeAsStringAsync(encThumbPath, encThumbB64, { encoding: FileSystem.EncodingType.Base64 });
          encThumbB64 = null;
          cleanupTempFiles.push(encThumbPath);
          console.log('[NFT] Encrypted thumbnail:', thumbPlain.length, '→', 'encrypted, nonce:', naclUtil.encodeBase64(thumbNonce).slice(0, 8) + '...');

          // Upload encrypted thumbnail to StealthCloud
          const nftName = name || `PhotoLynk_${Date.now()}`;
          const uploadResult = await uploadThumbnailToStealthCloud(encThumbPath, nftName + '_enc', serverConfig);
          if (uploadResult.success) {
            thumbnailUrl = uploadResult.thumbnailUrl;
            // Store thumbnail nonce + URL in encryptionData so DecryptedNFTImage can decrypt it
            // (thumbnailUrl is also written to on-chain metadata so other devices can find it)
            encryptionData.thumbnailNonce = naclUtil.encodeBase64(thumbNonce);
            encryptionData.thumbnailUrl = thumbnailUrl;
            console.log('[NFT] Encrypted thumbnail stored:', thumbnailUrl);
          }

          // Also upload encrypted thumbnail to IPFS as redundancy fallback (if SC offline, album can still decrypt)
          if (HAS_ANY_PINATA) {
            try {
              const encThumbB64 = await FileSystem.readAsStringAsync(encThumbPath, { encoding: FileSystem.EncodingType.Base64 });
              const thumbIpfs = await uploadToArweave(encThumbPath, 'application/octet-stream', {}, encThumbB64);
              if (thumbIpfs.success) {
                ipfsThumbnailUrl = thumbIpfs.arweaveUrl;
                console.log('[NFT] Encrypted thumbnail uploaded to IPFS (fallback):', ipfsThumbnailUrl);
              }
            } catch (ipfsErr) {
              console.log('[NFT] Encrypted thumbnail IPFS upload failed (non-critical):', ipfsErr.message);
            }
          }
          if (!thumbnailUrl) thumbnailUrl = ipfsThumbnailUrl;
        } catch (encThumbErr) {
          console.log('[NFT] Encrypted thumbnail failed (non-critical):', encThumbErr.message);
        }
      } else if (!encryptionData) {
        // Unencrypted: plain JPEG thumbnail
        const thumbnailResult = await generateThumbnail(uploadFilePath);
        if (thumbnailResult.success) {
          let thumbToUpload = thumbnailResult.thumbnailPath;

          // Apply watermark to thumbnail if requested (protect the public preview)
          if (watermark) {
            const wmThumb = await burnWatermark(thumbToUpload);
            if (wmThumb.success) {
              cleanupTempFiles.push(wmThumb.watermarkedPath);
              thumbToUpload = wmThumb.watermarkedPath;
              console.log('[NFT] Watermark applied to gallery thumbnail');
            }
          }

          const useIpfsMode = storageOption === NFT_STORAGE_OPTIONS.IPFS || (!useStealthCloud && !useArweave && !useOnChain);
          if (useIpfsMode && HAS_ANY_PINATA) {
            // Hybrid IPFS: dual thumbnail — IPFS (decentralized fallback) + StealthCloud (fast primary)
            const thumbB64 = await FileSystem.readAsStringAsync(thumbToUpload, { encoding: FileSystem.EncodingType.Base64 });
            // 1) Upload to IPFS (decentralized fallback + on-chain preview for Tensor/explorers)
            const thumbIpfs = await uploadToArweave(thumbToUpload, 'image/jpeg', {}, thumbB64);
            if (thumbIpfs.success) {
              ipfsThumbnailUrl = thumbIpfs.arweaveUrl;
              console.log('[NFT] Thumbnail uploaded to IPFS:', ipfsThumbnailUrl);
            }
            // 2) Also upload to StealthCloud (fast primary for gallery)
            const nftName = name || `PhotoLynk_${Date.now()}`;
            const scResult = await uploadThumbnailToStealthCloud(thumbToUpload, nftName, serverConfig);
            if (scResult.success) {
              thumbnailUrl = scResult.thumbnailUrl;
              console.log('[NFT] Thumbnail also stored on StealthCloud:', thumbnailUrl);
            }
            // Fallback: if StealthCloud failed, use IPFS as primary
            if (!thumbnailUrl) thumbnailUrl = ipfsThumbnailUrl;
          } else {
            // StealthCloud / Arweave / On-Chain: thumbnail → StealthCloud only
            const nftName = name || `PhotoLynk_${Date.now()}`;
            const uploadResult = await uploadThumbnailToStealthCloud(
              thumbToUpload,
              nftName,
              serverConfig
            );
            if (uploadResult.success) {
              thumbnailUrl = uploadResult.thumbnailUrl;
              console.log('[NFT] Thumbnail stored on StealthCloud:', thumbnailUrl);
            }
          }
        }
      }
    }

    onStatus?.('Computing integrity proof...');
    onProgress?.(0.35);

    // Compute content hash of ORIGINAL file (not the preview/thumbnail)
    // For Limited Edition, reuse earlyContentHash already computed above (avoids double read)
    const contentHash = earlyContentHash || await computeContentHash(filePath, originalBase64);
    originalBase64 = null; // Free buffer — no longer needed, release memory for wallet signing
    console.log('[NFT] === HASH DIAGNOSTIC ===');
    console.log('[NFT] filePath:', filePath);
    console.log('[NFT] fileSize:', fileSize, 'bytes');
    console.log('[NFT] contentHash:', contentHash);
    console.log('[NFT] exifHash:', exifHash);
    console.log('[NFT] === END DIAGNOSTIC ===');

    onStatus?.('Building metadata...');
    onProgress?.(0.4);

    // Build NFT metadata with edition support
    const nftName = name || (filePath ? filePath.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : '') || ('Certified Original — ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }));
    const nftDescription = description || null; // Let buildNFTMetadata set default per edition

    // Build metadata - exclude EXIF if privacy mode is on
    const metadataExif = stripExif ? null : exifData;

    // Patch wallet address into C2PA manifest now that we have it
    if (c2paManifest && ownerAddressStr) {
      c2paManifest.claim.assertions = c2paManifest.claim.assertions.map(a =>
        a.label === 'stealthlynk.blockchain'
          ? { ...a, data: { ...a.data, creator_wallet: ownerAddressStr } }
          : a
      );
      c2paManifest.claim.signature_info.cert_serial_number = ownerAddressStr;
      if (c2paManifest.ingredients?.[0]) c2paManifest.ingredients[0].instance_id = `urn:photolynk:original:${contentHash}`;
    }

    const metadata = buildNFTMetadata({
      name: nftName,
      description: nftDescription,
      imageUrl: (!encrypt && ipfsThumbnailUrl) || imageUpload.arweaveUrl,
      fileUrl: imageUpload.arweaveUrl,
      ownerAddress: ownerAddressStr,
      exifData: metadataExif,
      creatorAddress: ownerAddressStr,
      contentHash,
      fileSize,
      edition,
      license,
      watermarked: watermark,
      encrypted: !!(encrypt && encryptionData),
      encryptionData: encryptionData || null,
      exifRawHash,
      exifHash,
      exifBindingHash,
      cameraSerialHash: camSerialHash,
      originalFormat,
      originalResolution,
      uploadMimeType: uploadContentType,
      storageOption,
      tsaToken: tsaResult?.tsaToken || null,
      tsaUrl: tsaResult?.tsaUrl || null,
      tsaPolicy: tsaResult?.tsaPolicy || null,
      c2paManifest: c2paManifest || null,
      mintTimestamp,
      certificationMode,
    });

    // Upload metadata (encrypted if nftKeyB64 available)
    const metadataUpload = await uploadMetadataToArweave(metadata, storageOption, nftKeyB64);
    if (!metadataUpload.success) {
      throw new Error('Metadata upload failed: ' + metadataUpload.error);
    }
    // Save metadataNonce for later decryption
    if (metadataUpload.metadataNonce && encryptionData) {
      encryptionData.metadataNonce = metadataUpload.metadataNonce;
    }

    // Free large data URI from memory — metadata is now on IPFS, transaction only needs the URL.
    // For on-chain NFTs the data URI can be ~3MB+ base64; nulling it reclaims that memory
    // before the wallet session + transaction signing which also allocate buffers.
    if (useOnChain && onChainDataUri) {
      onChainDataUri = null;
      if (metadata?.image?.startsWith('data:')) metadata.image = metadataUpload.arweaveUrl;
      if (imageUpload?.arweaveUrl?.startsWith('data:')) imageUpload.arweaveUrl = thumbnailUrl || metadataUpload.arweaveUrl;
      if (imageUpload?.imageUrl?.startsWith('data:')) imageUpload.imageUrl = thumbnailUrl || metadataUpload.arweaveUrl;
      console.log('[NFT] Freed on-chain data URI from memory after metadata upload');
    }

    // ========== STEP 3: Pre-fetch blockhash and SOL price BEFORE wallet session ==========
    onStatus?.('Creating NFT on Solana...');
    onProgress?.(0.55);

    const solPrice = await fetchSolPrice();
    const shouldPrefetchMintRent = !(nftType === 'compressed' && cNFTAvailable);
    let prefetchedMintRent = null;
    if (shouldPrefetchMintRent) {
      prefetchedMintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE || 82);
    }
    const commissionPayment = await prepareCommissionPayment({
      ownerPubkey,
      paymentMethod,
      commissionUsd: Number(costEstimate?.breakdown?.appCommission?.usd || 0),
      solPrice,
      waiveCommission: premiumEntitlement.waiveCommission || isFeeWalletExempt(ownerPubkey),
      weeklyDiscountQuote: costEstimate?.payment?.commission?.discount || authoritativeWeeklyDiscountQuote,
      isLegacySubscriber,
      isPremiumBeyond100: isPremiumBeyond100Internal,
      discountPct: premiumEntitlement.discountPct || 0,
    });
    const latestBlockhashResult = await getLatestBlockhashWithRetry('confirmed');
    const prefetchedBlockhash = latestBlockhashResult.blockhash;
    const prefetchedLastValidBlockHeight = latestBlockhashResult.lastValidBlockHeight;
    console.log('[NFT] Fresh blockhash ready for signing:', prefetchedBlockhash, 'SOL price:', solPrice, 'mintRent:', prefetchedMintRent);

    // Determine if we should use WalletAdapter or MWA
    const useWalletAdapter = walletAdapterAvailable && WalletAdapter && currentWalletType && currentWalletType !== 'mwa';
    console.log('[NFT] Wallet type:', currentWalletType, 'useWalletAdapter:', useWalletAdapter);

    let result;

    if (useWalletAdapter) {
      // ========== NON-MWA WALLET PATH (Phantom deeplink, WalletConnect, etc.) ==========
      result = await mintWithWalletAdapter({
        nftType,
        ownerPubkey,
        ownerAddressStr,
        prefetchedBlockhash,
        prefetchedMintRent,
        solPrice,
        imageUpload,
        thumbnailUrl,
        ipfsThumbnailUrl,
        metadataUpload,
        metadata,
        nftName,
        useStealthCloud,
        isLimited,
        fileSize,
        waiveCommission: premiumEntitlement.waiveCommission,
        commissionPayment,
        onStatus,
        onProgress,
      });
    } else {
      // ========== MWA WALLET PATH (Seeker, Phantom MWA, etc.) ==========
      result = await transact(async (wallet) => {
        // Re-authorize wallet for signing
        console.log('[NFT] Re-authorizing wallet for signing via MWA...');
        await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: APP_IDENTITY,
        });
        const sessionBlockhashResult = await getLatestBlockhashWithRetry('confirmed');
        const sessionBlockhash = sessionBlockhashResult.blockhash;
        const sessionLastValidBlockHeight = sessionBlockhashResult.lastValidBlockHeight;

        // ========== TRY COMPRESSED NFT IF USER SELECTED IT (99.99% CHEAPER) ==========
        const useCompressedNFT = nftType === 'compressed' && cNFTAvailable;
        if (useCompressedNFT) {
          try {
            console.log('[NFT] Attempting compressed NFT (cNFT) mint (user selected)...');
            onStatus?.('Minting compressed NFT...');

            // INLINE cNFT minting to avoid async calls that close the wallet session
            // All data is pre-fetched before this transact block
            const merkleTreePubkey = new PublicKey(PHOTOLYNK_MERKLE_TREE);
            const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
            const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
            const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');

            // Derive tree config PDA
            const [treeConfig] = PublicKey.findProgramAddressSync(
              [merkleTreePubkey.toBuffer()],
              BUBBLEGUM_PROGRAM_ID
            );

            // Build metadata for the cNFT
            // Note: creators.address must be base58 string for serialization
            const metadataArgs = {
              name: nftName.slice(0, 32),
              symbol: 'PLNK',
              uri: metadataUpload.arweaveUrl,
              sellerFeeBasisPoints: 500,
              primarySaleHappened: false,
              isMutable: true,
              editionNonce: null,
              tokenStandard: null,
              collection: null,
              uses: null,
              tokenProgramVersion: 0,
              creators: [{ address: ownerPubkey, verified: true, share: 100 }],
            };

            const metadataBuffer = serializeMetadataArgs(metadataArgs);

            // Build mintV1 instruction using proper TransactionInstruction
            // Discriminator is 8 bytes: [145, 98, 192, 118, 184, 147, 118, 104]
            const MINT_V1_DISCRIMINATOR = new Uint8Array([145, 98, 192, 118, 184, 147, 118, 104]);

            // Combine discriminator and metadata into single Uint8Array
            const instructionData = new Uint8Array(MINT_V1_DISCRIMINATOR.length + metadataBuffer.length);
            instructionData.set(MINT_V1_DISCRIMINATOR, 0);
            instructionData.set(metadataBuffer, MINT_V1_DISCRIMINATOR.length);

            const mintV1Instruction = new TransactionInstruction({
              keys: [
                { pubkey: treeConfig, isSigner: false, isWritable: true },      // 0: treeConfig
                { pubkey: ownerPubkey, isSigner: false, isWritable: false },    // 1: leafOwner
                { pubkey: ownerPubkey, isSigner: false, isWritable: false },    // 2: leafDelegate
                { pubkey: merkleTreePubkey, isSigner: false, isWritable: true },// 3: merkleTree
                { pubkey: ownerPubkey, isSigner: true, isWritable: true },      // 4: payer
                { pubkey: ownerPubkey, isSigner: true, isWritable: false },     // 5: treeCreatorOrDelegate
                { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // 6: logWrapper
                { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // 7: compressionProgram
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 8: systemProgram
              ],
              programId: BUBBLEGUM_PROGRAM_ID,
              data: instructionData,
            });

            // App commission transfer (skip if fee wallet minting for itself)
            const cNFTMWAInstructions = [mintV1Instruction];
            let commissionUsd = 0;
            if (commissionPayment && !commissionPayment.skipped) {
              commissionUsd = Number(commissionPayment.discountedUsd || 0);
              appendCommissionPaymentInstructions(cNFTMWAInstructions, ownerPubkey, commissionPayment);
            } else {
              console.log(premiumEntitlement.waiveCommission
                ? '[cNFT] Premium entitlement active — skipping commission'
                : '[cNFT] Fee wallet exempt — skipping commission');
            }

            // Build transaction using pre-fetched blockhash
            const messageV0 = new TransactionMessage({
              payerKey: ownerPubkey,
              recentBlockhash: sessionBlockhash,
              instructions: cNFTMWAInstructions,
            }).compileToV0Message();

            const cNFTTransaction = new VersionedTransaction(messageV0);

            console.log('[cNFT] Sending transaction to wallet for signing...');
            console.log('[cNFT] Transaction has', cNFTMWAInstructions.length, 'instructions');
            console.log('[cNFT] Blockhash:', prefetchedBlockhash);

            // Use signTransactions (not signAndSendTransactions) - more reliable
            // We'll send the transaction manually outside the wallet session
            console.log('[cNFT] Calling wallet.signTransactions...');
            const signedTransactions = await wallet.signTransactions({
              transactions: [cNFTTransaction],
            });
            console.log('[cNFT] Transaction signed by wallet');

            // Return signed transaction to send outside wallet session
            return {
              _signedTransaction: signedTransactions[0],
              _blockhash: sessionBlockhash,
              _lastValidBlockHeight: sessionLastValidBlockHeight,
              ownerAddress: ownerAddressStr,
              imageUrl: imageUpload.arweaveUrl,
              thumbnailUrl,
              ipfsThumbnailUrl,
              metadataUrl: metadataUpload.arweaveUrl,
              metadata,
              commissionUsd,
              isCompressed: true,
              merkleTree: PHOTOLYNK_MERKLE_TREE,
            };
          } catch (cNFTError) {
            console.error('[cNFT] FAILED - Full error:', cNFTError);
            console.error('[cNFT] Error message:', cNFTError.message);
            console.error('[cNFT] Error stack:', cNFTError.stack);
            // Don't fallback - let the error propagate so user can retry
            throw cNFTError;
          }
        }

        // ========== STANDARD NFT (user selected or fallback) ==========
        console.log('[NFT] Using standard NFT minting (nftType:', nftType, ')...');

        // Metaplex Token Metadata Program ID
        const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

        // Generate mint keypair for the NFT
        const mintKeypair = Keypair.generate();
        const mintPubkey = mintKeypair.publicKey;

        console.log('[NFT] Mint address:', mintPubkey.toBase58());

        const blockhash = sessionBlockhash;
        const mintRent = (Number.isFinite(prefetchedMintRent) && prefetchedMintRent > 0)
          ? prefetchedMintRent
          : await connection.getMinimumBalanceForRentExemption(MINT_SIZE || 82);

        // Derive the associated token account for the owner
        const associatedTokenAccount = PublicKey.findProgramAddressSync(
          [ownerPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
          ASSOCIATED_TOKEN_PROGRAM_ID
        )[0];

        // Derive the metadata account PDA
        const metadataAccount = PublicKey.findProgramAddressSync(
          [
            Buffer.from('metadata'),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            mintPubkey.toBuffer(),
          ],
          TOKEN_METADATA_PROGRAM_ID
        )[0];

        // Derive the master edition account PDA
        const masterEditionAccount = PublicKey.findProgramAddressSync(
          [
            Buffer.from('metadata'),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            mintPubkey.toBuffer(),
            Buffer.from('edition'),
          ],
          TOKEN_METADATA_PROGRAM_ID
        )[0];

        console.log('[NFT] Metadata account:', metadataAccount.toBase58());
        console.log('[NFT] Master edition:', masterEditionAccount.toBase58());
        console.log('[NFT] ATA:', associatedTokenAccount.toBase58());

        // Build instructions for NFT creation
        const instructions = [];

        // 1. Create mint account
        instructions.push(
          SystemProgram.createAccount({
            fromPubkey: ownerPubkey,
            newAccountPubkey: mintPubkey,
            space: 82, // MINT_SIZE
            lamports: mintRent,
            programId: TOKEN_PROGRAM_ID,
          })
        );

        // 2. Initialize mint (0 decimals for NFT, owner as mint authority)
        instructions.push(
          createInitializeMintInstruction(
            mintPubkey,
            0, // 0 decimals for NFT
            ownerPubkey, // mint authority
            ownerPubkey, // freeze authority
            TOKEN_PROGRAM_ID
          )
        );

        // 3. Create associated token account
        instructions.push(
          createAssociatedTokenAccountInstruction(
            ownerPubkey, // payer
            associatedTokenAccount, // ata
            ownerPubkey, // owner
            mintPubkey, // mint
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );

        // 4. Mint 1 token to the owner's ATA
        instructions.push(
          createMintToInstruction(
            mintPubkey, // mint
            associatedTokenAccount, // destination
            ownerPubkey, // authority
            1, // amount (1 for NFT)
            [], // multiSigners
            TOKEN_PROGRAM_ID
          )
        );

        // 5. Create metadata account (Metaplex Token Metadata instruction)
        const createMetadataInstruction = createMetadataAccountV3Instruction(
          metadataAccount,
          mintPubkey,
          ownerPubkey, // mint authority
          ownerPubkey, // payer
          ownerPubkey, // update authority
          nftName,
          'PLNK', // symbol
          metadataUpload.arweaveUrl,
          500, // seller fee basis points (5%)
          [{ address: ownerPubkey, verified: true, share: 100 }], // creators
          TOKEN_METADATA_PROGRAM_ID
        );
        instructions.push(createMetadataInstruction);

        // 6. Create master edition (makes it a true NFT with supply of 1)
        const createMasterEditionInstruction = createMasterEditionV3Instruction(
          masterEditionAccount,
          mintPubkey,
          ownerPubkey, // update authority
          ownerPubkey, // mint authority
          metadataAccount,
          ownerPubkey, // payer
          0, // max supply (0 = unlimited prints, null = no prints)
          TOKEN_METADATA_PROGRAM_ID
        );
        instructions.push(createMasterEditionInstruction);

        // 7. App commission transfer (skip if fee wallet minting for itself)
        if (commissionPayment && !commissionPayment.skipped) {
          appendCommissionPaymentInstructions(instructions, ownerPubkey, commissionPayment);
        } else {
          console.log(premiumEntitlement.waiveCommission
            ? '[NFT] Premium entitlement active — skipping commission'
            : '[NFT] Fee wallet exempt — skipping commission');
        }

        onStatus?.('Signing transaction...');
        onProgress?.(0.7);

        // Create transaction with all instructions
        const messageV0 = new TransactionMessage({
          payerKey: ownerPubkey,
          recentBlockhash: prefetchedBlockhash,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);

        // Partially sign with mint keypair (required for createAccount)
        transaction.sign([mintKeypair]);

        // Sign and send via wallet
        const signatures = await wallet.signAndSendTransactions({
          transactions: [transaction],
        });

        const txSignature = signatures[0];

        console.log('[NFT] ✅ Transaction SUCCESS:', txSignature);
        if (commissionPayment && !commissionPayment.skipped) {
          if (commissionPayment.method === NFT_PAYMENT_METHODS.SKR) {
            console.log('[NFT] ✅ Commission paid in', SKR_TOKEN_SYMBOL, ':', commissionPayment.tokenAmountFormatted, SKR_TOKEN_SYMBOL, 'sent to', NFT_COMMISSION_WALLET);
          } else {
            console.log('[NFT] ✅ Commission of', costEstimate.breakdown.appCommission.usd, 'USD (', commissionPayment.lamports, 'lamports) sent to', NFT_COMMISSION_WALLET);
          }
        }

        onStatus?.('Confirming transaction...');
        onProgress?.(0.85);

        return {
          txSignature,
          _blockhash: sessionBlockhash,
          _lastValidBlockHeight: sessionLastValidBlockHeight,
          mintAddress: mintPubkey.toBase58(),
          ownerAddress: ownerAddressStr,
          imageUrl: imageUpload.arweaveUrl,
          thumbnailUrl,
          ipfsThumbnailUrl,
          metadataUrl: metadataUpload.arweaveUrl,
          metadata,
          isRealNFT: true,
        };
      });
    } // End of else (MWA path)

    // If cNFT with signed transaction, send it manually outside the wallet session
    if (result._signedTransaction && result.isCompressed) {
      console.log('[cNFT] Sending signed transaction to network...');
      onStatus?.('Confirming transaction...');
      onProgress?.(0.75);

      // Small delay to let MWA session fully close
      await new Promise(resolve => setTimeout(resolve, 500));

      // Send the signed transaction with retry across RPC endpoints
      let txSignature = null;
      let sendError = null;

      const RPC_ENDPOINTS = [
        SOLANA_RPC_ENDPOINT,
        ...SOLANA_RPC_FALLBACKS,
      ];

      for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
        try {
          const endpoint = RPC_ENDPOINTS[i];
          const sendConnection = new Connection(endpoint, 'confirmed');

          const signature = await sendConnection.sendRawTransaction(
            result._signedTransaction.serialize(),
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 3,
            }
          );

          txSignature = signature;
          console.log('[cNFT] Transaction submitted:', txSignature);
          break;
        } catch (e) {
          if (i === RPC_ENDPOINTS.length - 1) {
            console.error('[cNFT] All RPC endpoints failed:', e.message);
          }
          sendError = e;
        }
      }

      if (!txSignature) {
        throw sendError || new Error('Failed to send cNFT transaction');
      }

      // Update result with txSignature
      result.txSignature = txSignature;
      result.isRealNFT = true;
      result._needsDasLookup = true;
      delete result._signedTransaction;
    }

    if (result.txSignature) {
      onStatus?.('Confirming transaction...');
      const confirmationBlockhash = result._blockhash || prefetchedBlockhash;
      const confirmationLastValidBlockHeight = result._lastValidBlockHeight || prefetchedLastValidBlockHeight;
      await confirmMintTransaction(result.txSignature, confirmationBlockhash, confirmationLastValidBlockHeight);
      if (result.isCompressed) {
        console.log('[cNFT] ✅ Transaction confirmed:', result.txSignature);
        if (Number(result.commissionUsd || 0) > 0) {
          console.log('[cNFT] ✅ Commission of', result.commissionUsd, 'USD sent to', NFT_COMMISSION_WALLET);
        }
      }
      delete result._blockhash;
      delete result._lastValidBlockHeight;
      delete result.commissionUsd;
    }

    // If cNFT, do DAS lookup OUTSIDE the transact block to get real asset ID
    // Retry up to 5 times with increasing delays (DAS indexer can lag 2-15s)
    if (result._needsDasLookup) {
      console.log('[cNFT] Doing DAS lookup outside transact...');
      onStatus?.('Finalizing...');
      onProgress?.(0.90);

      let realAssetId = null;
      for (let attempt = 0; attempt < 5 && !realAssetId; attempt++) {
        try {
          await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2000 : 3000));

          const dasResponse = await fetch(SOLANA_RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'get-cnft-asset',
              method: 'getAssetsByOwner',
              params: {
                ownerAddress: result.ownerAddress,
                page: 1,
                limit: 10,
                sortBy: { sortBy: 'created', sortDirection: 'desc' },
              },
            }),
          });
          if (dasResponse.status === 429) {
            console.log('[cNFT] DAS rate limited, attempt', attempt + 1);
            continue;
          }
          const dasData = await dasResponse.json();

          if (dasData.result?.items) {
            let matchingAsset = null;
            if (result.metadataUrl) {
              const metaMatches = dasData.result.items.filter(item => item.content?.json_uri === result.metadataUrl);
              if (metaMatches.length === 1) {
                matchingAsset = metaMatches[0];
              } else if (metaMatches.length > 1 && result.metadata?.name) {
                matchingAsset = metaMatches.find(item => item.content?.metadata?.name === result.metadata?.name) || metaMatches[0];
              }
            } else if (result.metadata?.name) {
              matchingAsset = dasData.result.items.find(item => item.content?.metadata?.name === result.metadata?.name);
            }
            if (matchingAsset) {
              realAssetId = matchingAsset.id;
              console.log('[cNFT] ✅ Found real asset ID on attempt', attempt + 1, ':', realAssetId);
            }
          }
        } catch (dasError) {
          console.log('[cNFT] DAS attempt', attempt + 1, 'failed:', dasError.message);
        }
      }

      // Update result with proper mintAddress
      result.mintAddress = realAssetId
        ? `cnft_${realAssetId}`
        : `cnft_tx_${result.txSignature}`;
      delete result._needsDasLookup;
    }

    onStatus?.('NFT minted successfully!');
    onProgress?.(1);

    // Copy image to app storage for gallery display
    let localImagePath = null;
    try {
      const nftImagesDir = `${FileSystem.documentDirectory}nft_images/`;
      await FileSystem.makeDirectoryAsync(nftImagesDir, { intermediates: true }).catch(() => { });
      localImagePath = `${nftImagesDir}${result.mintAddress}.jpg`;
      await FileSystem.copyAsync({ from: filePath, to: localImagePath });
    } catch (e) {
      console.log('[NFT] Could not copy image locally:', e.message);
      localImagePath = asset.uri; // Fallback to asset URI
    }

    // Cleanup temp files (best-effort)
    for (const tmp of cleanupTempFiles) {
      try { await FileSystem.deleteAsync(tmp, { idempotent: true }); } catch (_) { }
    }

    // Save NFT to local storage AND sync to server (always StealthCloud for NFT/cert sync)
    const nftSyncUrl = 'https://stealthlynk.io';
    let authHeaders = null;
    if (serverConfig?.getAuthHeaders) {
      try {
        const authConfig = await serverConfig.getAuthHeaders();
        authHeaders = authConfig?.headers || authConfig || null;
      } catch (_) { }
    }
    const resolvedChainAssetId = result.assetId
      || (result.mintAddress && !String(result.mintAddress).startsWith('cnft_tx_')
        ? String(result.mintAddress).replace(/^cnft_/, '')
        : null);
    await saveNFTToStorage({
      mintAddress: result.mintAddress,
      ownerAddress: result.ownerAddress,
      name: name || (asset?.uri ? asset.uri.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : '') || 'Certified Original',
      description,
      imageUrl: result.thumbnailUrl || result.imageUrl || localImagePath || asset.uri,
      thumbnailUrl: result.thumbnailUrl,
      ipfsThumbnailUrl: result.ipfsThumbnailUrl,
      arweaveUrl: result.imageUrl,
      metadataUrl: result.metadataUrl,
      txSignature: result.txSignature,
      assetId: resolvedChainAssetId,
      createdAt: new Date().toISOString(),
      exifData,
      storageType: storageOption,
      isCompressed: nftType === 'compressed',
      // Edition fields
      edition,
      license,
      watermarked: watermark,
      encrypted: !!(encrypt && encryptionData),
      encryptionData: encryptionData || null, // wrappedKey, wrapNonce, nonce for decryption
      // Attributes + metadata stored so badges render from local storage without re-fetching chain
      attributes: metadata?.attributes || [],
      metadata,
      certificationMode,
    }, nftSyncUrl, authHeaders);

    // Auto-generate Certificate of Authenticity (all editions)
    if (true) {
      try {
        const cert = generateCertificate({
          mintAddress: result.mintAddress,
          txSignature: result.txSignature,
          ownerAddress: result.ownerAddress,
          name: nftName,
          description: nftDescription,
          edition,
          license,
          watermarked: watermark,
          encrypted: !!(encrypt && encryptionData),
          storageType: storageOption,
          arweaveUrl: result.imageUrl,
          metadataUrl: result.metadataUrl,
          metadata,
          createdAt: new Date().toISOString(),
          certificationMode,
        });
        if (cert) {
          await saveCertificate(cert, nftSyncUrl, authHeaders);
          console.log('[NFT] Certificate of Authenticity generated and saved:', cert.id);
        }
      } catch (certErr) {
        console.warn('[NFT] Certificate generation failed (non-critical):', certErr?.message);
      }
    }

    let premiumStatus = null;
    if (premiumEntitlement.isPremium && serverConfig?.baseUrl) {
      premiumStatus = await recordPremiumMintUsage(serverConfig, result.mintAddress, result.txSignature);
    }

    // Background DAS retry: if initial 5 attempts failed, keep trying in background
    // so cnft_tx_ entries eventually get resolved to real cnft_ asset IDs (matches desktop Step 5)
    if (result.mintAddress?.startsWith('cnft_tx_') && result.ownerAddress && result.metadataUrl) {
      const _bgTxMint = result.mintAddress;
      const _bgOwner = result.ownerAddress;
      const _bgMetaUrl = result.metadataUrl;
      const _bgMetaName = result.metadata?.name;
      const _bgTxSig = result.txSignature;
      const _bgSyncUrl = nftSyncUrl;
      const _bgAuth = authHeaders;
      (async () => {
        console.log('[cNFT] Starting background DAS retry for', _bgTxMint);
        for (let bgAttempt = 0; bgAttempt < 10; bgAttempt++) {
          await new Promise(r => setTimeout(r, 10000)); // 10s between retries
          try {
            const dasResp = await fetch(SOLANA_RPC_ENDPOINT, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 'bg-resolve-cnft',
                method: 'getAssetsByOwner',
                params: { ownerAddress: _bgOwner, page: 1, limit: 10, sortBy: { sortBy: 'created', sortDirection: 'desc' } },
              }),
            });
            if (dasResp.status === 429) continue;
            const dasData = await dasResp.json();
            let match = null;
            const items = dasData.result?.items || [];
            if (_bgMetaUrl) {
              const metaMatches = items.filter(item => item.content?.json_uri === _bgMetaUrl);
              if (metaMatches.length === 1) {
                match = metaMatches[0];
              } else if (metaMatches.length > 1 && _bgMetaName) {
                match = metaMatches.find(item => item.content?.metadata?.name === _bgMetaName) || metaMatches[0];
              }
            } else if (_bgMetaName) {
              match = items.find(item => item.content?.metadata?.name === _bgMetaName) || null;
            }
            if (match) {
              const realId = match.id;
              const newMint = `cnft_${realId}`;
              console.log('[cNFT] ✅ Background resolved:', newMint);
              // Update stored NFT
              try {
                const nfts = await getStoredNFTs();
                const idx = nfts.findIndex(n => n.mintAddress === _bgTxMint);
                if (idx >= 0) {
                  nfts[idx].mintAddress = newMint;
                  nfts[idx].assetId = realId;
                  await saveNFTsToFile(nfts);
                  console.log('[cNFT] Background: updated stored NFT', _bgTxMint, '→', newMint);
                }
              } catch (_) { }
              // Update certificate mintAddress
              try {
                const certs = await getStoredCertificates();
                const oldNorm = _bgTxMint.replace(/^cnft_/, '');
                let certUpdated = false;
                for (const c of certs) {
                  const cNorm = (c.mintAddress || '').replace(/^cnft_/, '');
                  if (cNorm === oldNorm || c.mintAddress === _bgTxMint) {
                    c.mintAddress = newMint;
                    certUpdated = true;
                  }
                }
                if (certUpdated) {
                  await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(certs));
                  console.log('[cNFT] Background: updated certificate', _bgTxMint, '→', newMint);
                }
              } catch (_) { }
              // Re-sync updated NFT to server
              if (_bgSyncUrl && _bgAuth) {
                try {
                  const nfts = await getStoredNFTs();
                  const updated = nfts.find(n => n.mintAddress === newMint);
                  if (updated) {
                    await axios.post(`${_bgSyncUrl}/api/nft/sync`, {
                      action: 'save', nft: { ...updated, mintAddress: newMint, assetId: realId },
                    }, { headers: _bgAuth, timeout: 10000 }).catch(() => { });
                  }
                } catch (_) { }
              }
              // Remove old tx_ entry from server
              if (_bgSyncUrl && _bgAuth) {
                try {
                  await axios.post(`${_bgSyncUrl}/api/nft/sync`, {
                    action: 'remove', mintAddress: _bgTxMint,
                  }, { headers: _bgAuth, timeout: 10000 }).catch(() => { });
                } catch (_) { }
              }
              return; // done
            }
          } catch (_) { }
        }
        console.warn('[cNFT] Background DAS retry exhausted for', _bgTxMint);
      })();
    }

    return {
      success: true,
      mintAddress: result.mintAddress,
      txSignature: result.txSignature,
      imageUrl: result.imageUrl,
      metadataUrl: result.metadataUrl,
      ownerAddress: result.ownerAddress,
      edition,
      contentHash,
      exifRawHash,
      exifHash,
      exifBindingHash,
      mintCount: premiumStatus?.mintCount ?? null,
      freeMintLimit: premiumStatus?.freeMintLimit ?? null,
      freeMintsRemaining: premiumStatus?.freeMintsRemaining ?? null,
      maxNoFeeMints: premiumStatus?.maxNoFeeMints ?? null,
      noFeeMintsRemaining: premiumStatus?.noFeeMintsRemaining ?? null,
      balanceUsd: premiumStatus?.balanceUsd ?? null,
    };
  } catch (e) {
    console.error('[NFT] Minting failed:', e);
    onStatus?.('Minting failed');
    return { success: false, error: e.message };
  } finally {
    _mintingInProgress = false;
    console.log('[NFT] Minting lock OFF — auto-scan/sync resumed');
  }
};

// ============================================================================
// NFT TRANSFER
// ============================================================================

/**
 * Resolve domain name (.skr, .sol, or other TLDs) to wallet address
 * .skr is Solana Mobile's Seeker ID (uses AllDomains API)
 * .sol uses Bonfida SNS API
 * @param {string} domain - Domain name (e.g., "alice.skr", "alice.sol", or "alice")
 * @returns {Object} { success, address, error }
 */
export const resolveSolDomain = async (domain) => {
  const trimmed = domain.trim().toLowerCase();

  // Determine TLD and clean domain name
  let cleanDomain = trimmed;
  let tld = 'skr'; // Default to .skr for Seeker users

  if (trimmed.endsWith('.skr')) {
    cleanDomain = trimmed.replace(/\.skr$/, '');
    tld = 'skr';
  } else if (trimmed.endsWith('.sol')) {
    cleanDomain = trimmed.replace(/\.sol$/, '');
    tld = 'sol';
  }

  const fullDomain = `${cleanDomain}.${tld}`;
  console.log(`[NFT] Resolving ${fullDomain}...`);

  // For .skr domains, use AllDomains API
  if (tld === 'skr') {
    try {
      // AllDomains API endpoint for resolving domains
      const response = await axios.get(
        `https://api.alldomains.id/domain/${fullDomain}`,
        { timeout: 10000 }
      );
      if (response.data?.owner) {
        console.log(`[NFT] AllDomains API resolved ${fullDomain} to ${response.data.owner}`);
        return { success: true, address: response.data.owner };
      }
    } catch (e) {
      console.log('[NFT] AllDomains API failed:', e.message);
    }

    // Try alternative AllDomains endpoint
    try {
      const response = await axios.get(
        `https://sns.alldomains.id/resolve/${fullDomain}`,
        { timeout: 10000 }
      );
      if (response.data?.owner || response.data?.result) {
        const owner = response.data.owner || response.data.result;
        console.log(`[NFT] AllDomains SNS API resolved ${fullDomain} to ${owner}`);
        return { success: true, address: owner };
      }
    } catch (e) {
      console.log('[NFT] AllDomains SNS API failed:', e.message);
    }
  }

  // For .sol domains, try Bonfida SNS API
  if (tld === 'sol') {
    try {
      const response = await axios.get(
        `https://sns-sdk-proxy.bonfida.workers.dev/resolve/${cleanDomain}`,
        { timeout: 10000 }
      );
      if (response.data?.result) {
        console.log(`[NFT] Bonfida API resolved ${fullDomain} to ${response.data.result}`);
        return { success: true, address: response.data.result };
      }
    } catch (e) {
      console.log('[NFT] Bonfida API failed:', e.message);
    }
  }

  return { success: false, error: `Could not resolve ${fullDomain}` };
};

/**
 * Check if input is a .skr or .sol domain name
 * @param {string} input - Address or domain name
 * @returns {boolean}
 */
export const isSolDomain = (input) => {
  if (!input) return false;
  const trimmed = input.trim().toLowerCase();
  // Only treat as domain if it explicitly ends with .skr or .sol
  // Do NOT treat plain alphanumeric strings as domains (they could be Solana addresses)
  return trimmed.endsWith('.skr') || trimmed.endsWith('.sol');
};

/**
 * Resolve recipient input to wallet address
 * Handles both direct Solana addresses and .sol domain names
 * @param {string} input - Wallet address or .sol domain
 * @returns {Object} { success, address, isDomain, error }
 */
export const resolveRecipient = async (input) => {
  if (!input?.trim()) {
    return { success: false, error: 'No recipient specified' };
  }

  const trimmed = input.trim();

  // Check if it's a .sol domain
  if (isSolDomain(trimmed)) {
    const result = await resolveSolDomain(trimmed);
    return { ...result, isDomain: true, domainName: trimmed };
  }

  // Try to parse as Solana address
  try {
    const pubkey = new PublicKey(trimmed);
    return { success: true, address: pubkey.toBase58(), isDomain: false };
  } catch (e) {
    return { success: false, error: 'Invalid Solana address or .sol domain' };
  }
};

/**
 * Transfer a compressed NFT (cNFT) using Bubblegum program
 * Requires fetching asset proof from DAS API
 * @param {string} mintAddress - cNFT ID (format: cnft_<assetId> or cnft_tx_<txSig>)
 * @param {string} recipientInput - Recipient's Solana wallet address or .sol domain
 * @returns {Object} { success, txSignature, recipientAddress, error }
 */
const transferCompressedNFT = async (mintAddress, recipientInput, walletType = null) => {
  // Check Solana availability
  if (!solanaAvailable || !isWalletAvailable()) {
    return { success: false, error: 'Solana not available' };
  }

  // Ensure connection is initialized
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }

  try {
    // Resolve recipient
    const resolved = await resolveRecipient(recipientInput);
    if (!resolved.success) {
      return { success: false, error: resolved.error };
    }

    const recipientAddress = resolved.address;
    const newLeafOwner = new PublicKey(recipientAddress);

    // Extract asset ID from mintAddress
    let assetId = mintAddress.replace('cnft_', '');

    // Handle tx-based IDs (fallback format)
    if (assetId.startsWith('tx_')) {
      return { success: false, error: 'Cannot transfer cNFT with transaction-based ID. Please refresh your NFT list first.' };
    }

    console.log('[cNFT Transfer] Asset ID:', assetId);
    console.log('[cNFT Transfer] Recipient:', recipientAddress);
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const errorToText = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }
    };
    const isRetryableCompressedTransferError = (error) => {
      const message = [
        error?.message,
        errorToText(error?.logs),
        errorToText(error?.data),
        errorToText(error?.response?.data),
        errorToText(error?.simulationResponse),
        errorToText(error?.confirmation),
        errorToText(error?.value?.err),
        errorToText(error),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!message) return false;
      return (
        message.includes('failed to verify the merkle proof')
        || message.includes('proof verification failed')
        || message.includes('concurrent merkle tree')
        || message.includes('leaf contents')
        || message.includes('invalid root')
        || message.includes('hashing mismatch')
        || message.includes('stale proof')
        || message.includes('root mismatch')
        || message.includes('proof mismatch')
        || (message.includes('proof') && (message.includes('merkle') || message.includes('root') || message.includes('hash') || message.includes('verify') || message.includes('canopy')))
      );
    };

    // Fetch asset data from DAS API via proxy with Helius fallback
    const callDAS = async (method, params) => {
      // Try server proxy first
      try {
        const serverType = await SecureStore.getItemAsync('server_type');
        const serverUrl = serverType === 'stealthcloud' ? 'https://stealthlynk.io' : 'http://192.168.1.100:3000';
        const ac1 = new AbortController(); const t1 = setTimeout(() => ac1.abort(), 10000);
        const resp = await fetch(`${serverUrl}/api/nft-service/das-proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, params }),
          signal: ac1.signal,
        });
        clearTimeout(t1);
        if (resp.ok) return await resp.json();
      } catch (_) { }
      // Fallback to direct Helius
      const DAS_RPC_URLS_FALLBACK = [
        'https://mainnet.helius-rpc.com/?api-key=8b86bd0d-4534-4ce9-a61d-ec3850cb0b62',
        'https://mainnet.helius-rpc.com/?api-key=6b3d0180-4354-4e31-a2fc-9b6cd9e550a7',
      ];
      for (const dasUrl of DAS_RPC_URLS_FALLBACK) {
        try {
          const ac2 = new AbortController(); const t2 = setTimeout(() => ac2.abort(), 10000);
          const resp = await fetch(dasUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'transfer-das', method, params }),
            signal: ac2.signal,
          });
          clearTimeout(t2);
          if (resp.ok) return await resp.json();
        } catch (e) {
          if (e.message && e.message.includes('429')) continue;
          if (dasUrl === DAS_RPC_URLS_FALLBACK[DAS_RPC_URLS_FALLBACK.length - 1]) throw e;
        }
      }
      throw new Error('RATE_LIMITED');
    };

    const walletResult = await getConnectedWalletAddress();
    if (!walletResult.success) {
      return { success: false, error: walletResult.error || 'Wallet not connected' };
    }

    const leafOwner = walletResult.pubkey;
    const currentWalletType = walletResult.walletType;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const assetData = await callDAS('getAsset', { id: assetId });

        if (assetData.error || !assetData.result) {
          console.error('[cNFT Transfer] Failed to fetch asset:', assetData.error);
          return { success: false, error: 'Failed to fetch cNFT data. Please try again.' };
        }

        const asset = assetData.result;
        console.log('[cNFT Transfer] Asset owner:', asset.ownership?.owner);
        const currentDelegate = asset.ownership?.delegate || null;
        console.log('[cNFT Transfer] Asset delegate:', currentDelegate || '(none)');

        const proofData = await callDAS('getAssetProof', { id: assetId });

        if (proofData.error || !proofData.result) {
          console.error('[cNFT Transfer] Failed to fetch proof:', proofData.error);
          return { success: false, error: 'Failed to fetch cNFT proof. Please try again.' };
        }

        const proof = proofData.result;
        console.log('[cNFT Transfer] Proof fetched, tree:', proof.tree_id);

        const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
        const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
        const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');

        const merkleTree = new PublicKey(proof.tree_id);

        const decodeHash = (hash) => {
          if (!hash) return Buffer.alloc(32);
          if (hash.startsWith('0x')) {
            return Buffer.from(hash.slice(2), 'hex');
          }
          try {
            return new PublicKey(hash).toBuffer();
          } catch {
            return Buffer.from(hash);
          }
        };

        const root = decodeHash(proof.root);
        const dataHash = decodeHash(asset.compression.data_hash);
        const creatorHash = decodeHash(asset.compression.creator_hash);
        const leafIndex = asset.compression.leaf_id;
        const nonce = BigInt(leafIndex);

        console.log('[cNFT Transfer] Root length:', root.length, 'DataHash length:', dataHash.length);

        const [treeConfig] = PublicKey.findProgramAddressSync(
          [merkleTree.toBuffer()],
          BUBBLEGUM_PROGRAM_ID
        );
        const leafDelegate = currentDelegate ? new PublicKey(currentDelegate) : leafOwner;

        const proofPath = proof.proof.map(p => ({
          pubkey: new PublicKey(p),
          isSigner: false,
          isWritable: false,
        }));

        if (leafOwner.toBase58() !== asset.ownership?.owner) {
          return { success: false, error: 'You do not own this NFT' };
        }

        const discriminator = Buffer.from([163, 52, 200, 231, 140, 3, 69, 186]);
        const nonceBuffer = Buffer.alloc(8);
        nonceBuffer.writeBigUInt64LE(nonce, 0);
        const indexBuffer = Buffer.alloc(4);
        indexBuffer.writeUInt32LE(leafIndex, 0);

        const instructionData = Buffer.concat([
          discriminator, root, dataHash, creatorHash, nonceBuffer, indexBuffer,
        ]);

        console.log('[cNFT Transfer] Instruction data length:', instructionData.length);

        const transferAccounts = [
          { pubkey: treeConfig, isSigner: false, isWritable: false },
          { pubkey: leafOwner, isSigner: true, isWritable: false },
          { pubkey: leafDelegate, isSigner: false, isWritable: false },
          { pubkey: newLeafOwner, isSigner: false, isWritable: false },
          { pubkey: merkleTree, isSigner: false, isWritable: true },
          { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ...proofPath,
        ];

        const transferInstruction = new TransactionInstruction({
          programId: BUBBLEGUM_PROGRAM_ID,
          keys: transferAccounts,
          data: instructionData,
        });

        const { blockhash, lastValidBlockHeight } = await getLatestBlockhashWithRetry('confirmed');

        const messageV0 = new TransactionMessage({
          payerKey: leafOwner,
          recentBlockhash: blockhash,
          instructions: [transferInstruction],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);

        let txSignature;
        const useWalletAdapter = walletAdapterAvailable && WalletAdapter && currentWalletType && currentWalletType !== 'mwa';

        if (useWalletAdapter) {
          console.log('[cNFT Transfer] Using WalletAdapter for signing...');
          const txResult = await WalletAdapter.signAndSendTransaction(transaction);
          if (!txResult.success) {
            throw new Error(txResult.error || 'WalletAdapter signing failed');
          }
          txSignature = txResult.signature;
        } else if (mwaAdapterAvailable && MWAAdapter) {
          // Sign only — we send manually via our Helius RPC (wallet's built-in RPC is rate-limited)
          console.log('[cNFT Transfer] Using MWAAdapter for signing (sign-only)...');
          const txResult = await MWAAdapter.signTransaction(transaction);
          if (!txResult.success) {
            throw new Error(txResult.error || 'MWAAdapter signing failed');
          }
          console.log('[cNFT Transfer] Transaction signed, sending via app RPC...');

          // Send via robust broadcast helper (handles MWA-bounce network flakiness)
          const signedTx = txResult.signedTransaction;
          const RPC_ENDPOINTS = [SOLANA_RPC_ENDPOINT, ...SOLANA_RPC_FALLBACKS];
          let sendError = null;
          try {
            txSignature = await broadcastSignedTransaction(signedTx, 'cNFT Transfer');
          } catch (e) { sendError = e; }
          if (false) for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
            try {
              const sendConn = new Connection(RPC_ENDPOINTS[i], 'confirmed');
              txSignature = await sendConn.sendRawTransaction(
                signedTx.serialize(),
                { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
              );
              console.log('[cNFT Transfer] Transaction submitted:', txSignature);
              break;
            } catch (sendErr) {
              sendError = sendErr;
              if (i === RPC_ENDPOINTS.length - 1) {
                console.error('[cNFT Transfer] All RPC endpoints failed:', sendErr.message);
              }
            }
          }
          if (!txSignature) {
            throw sendError || new Error('Failed to send transfer transaction');
          }
        } else {
          throw new Error('No wallet adapter available for signing');
        }

        const confirmation = await connection.confirmTransaction(
          { signature: txSignature, blockhash, lastValidBlockHeight },
          'confirmed'
        );
        if (confirmation.value?.err) {
          const confirmationError = new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
          confirmationError.confirmation = confirmation.value.err;
          throw confirmationError;
        }

        console.log(`[cNFT Transfer] Success: ${txSignature}`);

        return {
          success: true,
          txSignature,
          recipientAddress,
          isDomain: resolved.isDomain,
          domainName: resolved.domainName,
        };
      } catch (transferErr) {
        if (attempt < maxAttempts && isRetryableCompressedTransferError(transferErr)) {
          console.warn(`[cNFT Transfer] Refreshing proof after attempt ${attempt} failed:`, transferErr.message);
          invalidateDasCache();
          await wait(900 * attempt);
          continue;
        }
        throw transferErr;
      }
    }
  } catch (e) {
    console.error('[cNFT Transfer] Failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Burn a compressed NFT (cNFT) using Bubblegum program.
 * Permanently removes the leaf from the Merkle tree.
 * @param {Object} nft - Full NFT object (used for ecosystem gate)
 * @returns {Object} { success, txSignature, error }
 */
const burnCompressedNFT = async (nft, walletType = null, callbacks = {}) => {
  if (!solanaAvailable || !isWalletAvailable()) {
    return { success: false, error: 'Solana not available' };
  }
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }

  const mintAddress = nft?.mintAddress || '';
  let assetId = mintAddress.replace('cnft_', '');
  if (assetId.startsWith('tx_')) {
    return { success: false, error: 'Cannot burn cNFT with transaction-based ID. Please refresh your NFT list first.' };
  }

  try {
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const errorToText = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    };
    const isRetryableErr = (error) => {
      const msg = [error?.message, errorToText(error?.logs), errorToText(error?.value?.err)].filter(Boolean).join(' ').toLowerCase();
      if (!msg) return false;
      return msg.includes('proof') || msg.includes('merkle') || msg.includes('hash') || msg.includes('root');
    };

    const callDAS = async (method, params, forceDirect = false) => {
      if (!forceDirect) try {
        const serverType = await SecureStore.getItemAsync('server_type');
        const serverUrl = serverType === 'stealthcloud' ? 'https://stealthlynk.io' : 'http://192.168.1.100:3000';
        const ac1 = new AbortController(); const t1 = setTimeout(() => ac1.abort(), 10000);
        const resp = await fetch(`${serverUrl}/api/nft-service/das-proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, params }),
          signal: ac1.signal,
        });
        clearTimeout(t1);
        if (resp.ok) return await resp.json();
      } catch (_) { }
      const FALLBACKS = [
        'https://mainnet.helius-rpc.com/?api-key=8b86bd0d-4534-4ce9-a61d-ec3850cb0b62',
        'https://mainnet.helius-rpc.com/?api-key=6b3d0180-4354-4e31-a2fc-9b6cd9e550a7',
      ];
      for (const url of FALLBACKS) {
        try {
          const ac2 = new AbortController(); const t2 = setTimeout(() => ac2.abort(), 10000);
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'burn-das', method, params }),
            signal: ac2.signal,
          });
          clearTimeout(t2);
          if (resp.ok) return await resp.json();
        } catch (e) {
          if (url === FALLBACKS[FALLBACKS.length - 1]) throw e;
        }
      }
      throw new Error('RATE_LIMITED');
    };

    const walletResult = await getConnectedWalletAddress();
    if (!walletResult.success) {
      return { success: false, error: walletResult.error || 'Wallet not connected' };
    }
    const leafOwner = walletResult.pubkey;
    const currentWalletType = walletResult.walletType;

    const MAX_BURN_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_BURN_ATTEMPTS; attempt++) {
      try {
        const forceDirectDas = attempt > 1;
        const assetData = await callDAS('getAsset', { id: assetId }, forceDirectDas);
        if (assetData.error || !assetData.result) {
          return { success: false, error: 'Failed to fetch cNFT data. Please try again.' };
        }
        const asset = assetData.result;

        // Strict ecosystem gate using on-chain proof tree
        if (asset?.compression?.tree && asset.compression.tree !== PHOTOLYNK_MERKLE_TREE) {
          return { success: false, error: 'This NFT was not minted by PhotoLynk and cannot be burned from this app.' };
        }
        if (asset.ownership?.owner && leafOwner.toBase58() !== asset.ownership.owner) {
          return { success: false, error: 'You do not own this NFT' };
        }

        const proofData = await callDAS('getAssetProof', { id: assetId }, forceDirectDas);
        if (proofData.error || !proofData.result) {
          return { success: false, error: 'Failed to fetch cNFT proof. Please try again.' };
        }
        const proof = proofData.result;
        if (proof.tree_id !== PHOTOLYNK_MERKLE_TREE) {
          return { success: false, error: 'This NFT was not minted by PhotoLynk and cannot be burned from this app.' };
        }

        const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
        const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
        const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
        const merkleTree = new PublicKey(proof.tree_id);

        const decodeHash = (hash) => {
          if (!hash) return Buffer.alloc(32);
          if (hash.startsWith && hash.startsWith('0x')) return Buffer.from(hash.slice(2), 'hex');
          try { return new PublicKey(hash).toBuffer(); } catch { return Buffer.from(hash); }
        };
        const root = decodeHash(proof.root);
        const dataHash = decodeHash(asset.compression.data_hash);
        const creatorHash = decodeHash(asset.compression.creator_hash);
        const leafIndex = asset.compression.leaf_id;
        const nonce = BigInt(leafIndex);
        console.log('[cNFT Burn] DAS inputs:', {
          assetId: asset.id,
          tree: proof.tree_id,
          root: proof.root,
          leafIndex,
          seq: asset.compression?.seq,
          proofLen: proof.proof?.length,
          canopyDepth: proof.canopy_depth ?? proof.canopyDepth ?? asset.compression?.canopy_depth ?? null,
          owner: asset.ownership?.owner,
          delegate: asset.ownership?.delegate || null,
          mode: nft?.certificationMode || null,
          edition: nft?.edition || null,
        });

        const [treeConfig] = PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID);

        // ── Pre-flight leaf-hash self-check ─────────────────────────────────
        // Reconstructs the Bubblegum LeafSchema::V1 hash locally from the
        // values we're about to pass on-chain, and compares against
        // asset.compression.asset_hash. If they DON'T match, we know one of
        // our inputs is wrong BEFORE we sign+pay+broadcast.
        //
        // Bubblegum LeafSchemaV1 -> keccak256(
        //   [version=1] || asset_id(32) || owner(32) || delegate(32) ||
        //   nonce_le(8) || data_hash(32) || creator_hash(32)
        // )
        // Tries delegate candidates in order: DAS-reported, owner, default.
        const leafIndexBI = BigInt(leafIndex);
        const nonceBytes = Buffer.alloc(8); nonceBytes.writeBigUInt64LE(leafIndexBI, 0);
        const [derivedAssetIdPk] = PublicKey.findProgramAddressSync(
          [Buffer.from('asset'), merkleTree.toBuffer(), nonceBytes],
          BUBBLEGUM_PROGRAM_ID
        );
        const assetIdMatches = derivedAssetIdPk.toBase58() === asset.id;

        let leafDelegate = null;
        const dasDelegate = asset.ownership?.delegate || null;
        const targetAssetHash = asset.compression?.asset_hash;

        if (_keccak256 && targetAssetHash && assetIdMatches) {
          const ownerBuf = leafOwner.toBuffer();
          const candidates = [];
          if (dasDelegate) {
            try { candidates.push(['das', new PublicKey(dasDelegate)]); } catch (_) {}
          }
          candidates.push(['owner', leafOwner]);
          candidates.push(['default', PublicKey.default]);

          let target;
          try { target = new PublicKey(targetAssetHash).toBuffer(); } catch (_) { target = null; }

          if (target) {
            for (const [label, candPk] of candidates) {
              const computed = Buffer.from(_keccak256(Buffer.concat([
                Buffer.from([1]),                  // LeafSchema version V1
                derivedAssetIdPk.toBuffer(),       // 32
                ownerBuf,                          // 32
                candPk.toBuffer(),                 // 32
                nonceBytes,                        // 8
                decodeHash(asset.compression.data_hash),    // 32
                decodeHash(asset.compression.creator_hash), // 32
              ])));
              if (computed.equals(target)) {
                leafDelegate = candPk;
                console.log(`[cNFT Burn] ✅ leaf hash matches with delegate=${label} (${candPk.toBase58().slice(0, 8)}...)`);
                break;
              }
            }
          }
        }

        if (!leafDelegate) {
          // Self-check failed or unavailable — log everything for debugging
          // and fall back to the previous default (DAS delegate else owner).
          console.warn('[cNFT Burn] ⚠ leaf-hash self-check could not match. Inputs:', {
            assetId: asset.id,
            derivedAssetId: derivedAssetIdPk.toBase58(),
            assetIdMatches,
            owner: leafOwner.toBase58(),
            dasDelegate,
            leafIndex,
            nonce: leafIndexBI.toString(),
            dataHash: asset.compression?.data_hash,
            creatorHash: asset.compression?.creator_hash,
            assetHash: targetAssetHash,
            proofRoot: proof.root,
            proofLen: proof.proof?.length,
            keccakAvailable: !!_keccak256,
          });
          if (!assetIdMatches) {
            return {
              success: false,
              error: 'cNFT burn failed: nonce/leaf_id mismatch. The asset on-chain has a different position than DAS reports — please refresh and try again.',
            };
          }
          leafDelegate = dasDelegate ? new PublicKey(dasDelegate) : leafOwner;
        }

        const proofPath = proof.proof.map(p => ({
          pubkey: new PublicKey(p), isSigner: false, isWritable: false,
        }));

        // Bubblegum burn instruction discriminator
        const discriminator = Buffer.from([116, 110, 29, 56, 107, 219, 42, 93]);
        const nonceBuffer = Buffer.alloc(8); nonceBuffer.writeBigUInt64LE(nonce, 0);
        const indexBuffer = Buffer.alloc(4); indexBuffer.writeUInt32LE(leafIndex, 0);
        const instructionData = Buffer.concat([discriminator, root, dataHash, creatorHash, nonceBuffer, indexBuffer]);

        const burnAccounts = [
          { pubkey: treeConfig, isSigner: false, isWritable: false },
          { pubkey: leafOwner, isSigner: true, isWritable: false },
          { pubkey: leafDelegate, isSigner: false, isWritable: false },
          { pubkey: merkleTree, isSigner: false, isWritable: true },
          { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ...proofPath,
        ];

        const burnIx = new TransactionInstruction({
          programId: BUBBLEGUM_PROGRAM_ID,
          keys: burnAccounts,
          data: instructionData,
        });

        const { blockhash, lastValidBlockHeight } = await getLatestBlockhashWithRetry('confirmed');
        const messageV0 = new TransactionMessage({
          payerKey: leafOwner,
          recentBlockhash: blockhash,
          instructions: [burnIx],
        }).compileToV0Message();
        const transaction = new VersionedTransaction(messageV0);

        const simulation = await connection.simulateTransaction(transaction, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
        if (simulation?.value?.err) {
          const simError = new Error([
            JSON.stringify(simulation.value.err),
            ...(simulation.value.logs || []),
          ].filter(Boolean).join(' | ') || 'Burn transaction simulation failed');
          simError.logs = simulation.value.logs || [];
          simError.preSignSimulation = true;
          throw simError;
        }

        let txSignature;
        const useWalletAdapter = walletAdapterAvailable && WalletAdapter && currentWalletType && currentWalletType !== 'mwa';
        callbacks?.onBurnPhase?.({ phase: 'wallet' });
        if (useWalletAdapter) {
          const txResult = await WalletAdapter.signAndSendTransaction(transaction);
          if (!txResult.success) throw new Error(txResult.error || 'WalletAdapter signing failed');
          txSignature = txResult.signature;
        } else if (mwaAdapterAvailable && MWAAdapter) {
          const txResult = await MWAAdapter.signTransaction(transaction);
          if (!txResult.success) throw new Error(txResult.error || 'MWAAdapter signing failed');
          // Send via robust broadcast helper (handles MWA-bounce network flakiness)
          const signedTx = txResult.signedTransaction;
          try {
            txSignature = await broadcastSignedTransaction(signedTx, 'cNFT Burn');
          } catch (e) {
            console.error('[cNFT Burn] Broadcast failed:', e.message);
            throw e;
          }
        } else {
          throw new Error('No wallet adapter available for signing');
        }

        callbacks?.onBurnPhase?.({ phase: 'confirming' });
        const confirmation = await connection.confirmTransaction(
          { signature: txSignature, blockhash, lastValidBlockHeight }, 'confirmed'
        );
        if (confirmation.value?.err) {
          const err = new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
          err.confirmation = confirmation.value.err;
          throw err;
        }

        console.log(`[cNFT Burn] Success: ${txSignature}`);
        return { success: true, txSignature };
      } catch (e) {
        const msg = (e?.message || '').toLowerCase();
        const isBlockExpired = msg.includes('blockheightexceeded') || msg.includes('block height exceeded') || msg.includes('has expired: block height exceeded');
        if (attempt < MAX_BURN_ATTEMPTS && isBlockExpired) {
          // Blockhash expired while user was signing — retry with fresh blockhash
          console.warn(`[cNFT Burn] Blockhash expired on attempt ${attempt}, retrying with fresh blockhash:`, e.message);
          await wait(800);
          continue;
        }
        if (attempt < MAX_BURN_ATTEMPTS && e?.preSignSimulation && isRetryableErr(e)) {
          // Proof staleness: DAS proxy can lag 2-5s behind chain head after
          // recent tree mutations. Wait longer than the standard backoff.
          const waitMs = [0, 1200, 2500, 5000][attempt] || 5000;
          console.warn(`[cNFT Burn] Pre-sign stale proof on attempt ${attempt}, waiting ${waitMs}ms then refetching:`, e.message);
          invalidateDasCache();
          await wait(waitMs);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    console.error('[cNFT Burn] Failed:', e);
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    return { success: false, error: e.message };
  }
};

/**
 * Burn an NFT permanently. Restricted to PhotoLynk ecosystem NFTs only.
 * For standard NFTs: SPL Burn(amount=1) + CloseAccount to reclaim rent.
 * For compressed NFTs: Bubblegum burn instruction.
 * @param {Object} nft - Full NFT object (must include mintAddress and metadata fields used by isPhotoLynkEcosystem)
 * @returns {Object} { success, txSignature, error }
 */
export const burnNFT = async (nft, walletType = null, callbacks = {}) => {
  if (!nft || !nft.mintAddress) {
    return { success: false, error: 'Invalid NFT' };
  }
  // Soft ecosystem gate: fast UX rejection for obviously foreign NFTs.
  // Accept any of:
  //   - strict ecosystem signature (merkleTree / creatorWallet / mintPlatform / dual hashes)
  //   - PhotoLynk-only `certificationMode` attribute (legacy mints whose locally
  //     cached object never captured merkleTree/etc — they still mint to the
  //     shared PhotoLynk tree on-chain and are perfectly burnable).
  // The authoritative tree check happens downstream against `proof.tree_id`,
  // which is unspoofable, so widening this gate cannot let foreign NFTs through.
  const _certMode = nft.certificationMode ? String(nft.certificationMode).trim().toLowerCase() : '';
  const _looksPhotoLynk = isPhotoLynkEcosystem(nft) || _certMode === 'private' || _certMode === 'public';
  if (!_looksPhotoLynk) {
    return { success: false, error: 'This NFT was not minted by PhotoLynk and cannot be burned from this app.' };
  }
  if (!solanaAvailable || !isWalletAvailable()) {
    return { success: false, error: 'Solana not available' };
  }
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }

  const isCompressedNFT = String(nft.mintAddress).startsWith('cnft_');
  if (isCompressedNFT) {
    return await burnCompressedNFT(nft, walletType, callbacks);
  }

  // Standard NFT burn
  if (!splTokenAvailable) {
    return { success: false, error: 'SPL Token not available. Please restart the app.' };
  }
  try {
    const splToken = require('@solana/spl-token');
    const mintPubkey = new PublicKey(nft.mintAddress);
    const walletResult = await getConnectedWalletAddress();
    if (!walletResult.success) {
      return { success: false, error: walletResult.error || 'Wallet not connected' };
    }
    const ownerPubkey = walletResult.pubkey;
    const currentWalletType = walletResult.walletType;

    const ownerATA = await getAssociatedTokenAddress(
      mintPubkey, ownerPubkey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Note: PhotoLynk only mints compressed NFTs (cNFTs) — this branch is
    // effectively unreachable from the album burn flow because isPhotoLynkEcosystem()
    // gating + the cnft_ prefix check above route every PhotoLynk NFT into
    // burnCompressedNFT(). Kept for completeness only.
    const instructions = [];
    instructions.push(
      splToken.createBurnInstruction(ownerATA, mintPubkey, ownerPubkey, 1, [], TOKEN_PROGRAM_ID)
    );
    if (typeof splToken.createCloseAccountInstruction === 'function') {
      instructions.push(
        splToken.createCloseAccountInstruction(ownerATA, ownerPubkey, ownerPubkey, [], TOKEN_PROGRAM_ID)
      );
    }

    const { blockhash, lastValidBlockHeight } = await getLatestBlockhashWithRetry('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);

    let txSignature;
    const useWalletAdapter = walletAdapterAvailable && WalletAdapter && currentWalletType && currentWalletType !== 'mwa';
    if (useWalletAdapter) {
      const txResult = await WalletAdapter.signAndSendTransaction(transaction);
      if (!txResult.success) throw new Error(txResult.error || 'WalletAdapter signing failed');
      txSignature = txResult.signature;
    } else if (mwaAdapterAvailable && MWAAdapter) {
      const txResult = await MWAAdapter.signTransaction(transaction);
      if (!txResult.success) throw new Error(txResult.error || 'MWAAdapter signing failed');
      // Send via robust broadcast helper (handles MWA-bounce network flakiness)
      const signedTx = txResult.signedTransaction;
      try {
        txSignature = await broadcastSignedTransaction(signedTx, 'NFT Burn');
      } catch (e) {
        console.error('[NFT Burn] Broadcast failed:', e.message);
        throw e;
      }
    } else {
      throw new Error('No wallet adapter available for signing');
    }

    const confirmation = await connection.confirmTransaction(
      { signature: txSignature, blockhash, lastValidBlockHeight }, 'confirmed'
    );
    if (confirmation.value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    console.log(`[NFT Burn] Success: ${txSignature}`);
    return { success: true, txSignature };
  } catch (e) {
    console.error('[NFT Burn] Failed:', e);
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    return { success: false, error: e.message };
  }
};

/**
 * Transfer NFT to another wallet address
 * @param {string} mintAddress - NFT mint address
 * @param {string} recipientInput - Recipient's Solana wallet address or .sol domain
 * @returns {Object} { success, txSignature, recipientAddress, error }
 */
export const transferNFT = async (mintAddress, recipientInput, walletType = null) => {
  if (!solanaAvailable || !isWalletAvailable()) {
    return { success: false, error: 'Solana not available' };
  }

  // Ensure connection is initialized
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }

  // Check if this is a compressed NFT (cNFT)
  const isCompressedNFT = mintAddress?.startsWith('cnft_');
  if (isCompressedNFT) {
    return await transferCompressedNFT(mintAddress, recipientInput, walletType);
  }

  // Standard NFT transfer requires SPL Token
  if (!splTokenAvailable) {
    return { success: false, error: 'SPL Token not available. Please restart the app.' };
  }

  try {
    // Resolve recipient (handles both addresses and .sol domains)
    const resolved = await resolveRecipient(recipientInput);
    if (!resolved.success) {
      return { success: false, error: resolved.error };
    }

    const recipientAddress = resolved.address;
    const recipientPubkey = new PublicKey(recipientAddress);
    const mintPubkey = new PublicKey(mintAddress);

    console.log(`[NFT] Transferring ${mintAddress} to ${recipientAddress}${resolved.isDomain ? ` (${resolved.domainName})` : ''}`);

    // Get current wallet address
    const walletResult = await getConnectedWalletAddress();
    if (!walletResult.success) {
      return { success: false, error: walletResult.error || 'Wallet not connected' };
    }

    const ownerPubkey = walletResult.pubkey;
    const currentWalletType = walletResult.walletType;

    // Get source token account (owner's ATA for this NFT)
    const sourceATA = await getAssociatedTokenAddress(
      mintPubkey,
      ownerPubkey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Get destination token account (recipient's ATA for this NFT)
    const destinationATA = await getAssociatedTokenAddress(
      mintPubkey,
      recipientPubkey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const { blockhash } = await getLatestBlockhashWithRetry('confirmed');

    const instructions = [];

    // Check if destination ATA exists, if not create it
    const destAccountInfo = await connection.getAccountInfo(destinationATA);
    if (!destAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          ownerPubkey, destinationATA, recipientPubkey, mintPubkey,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    // Add transfer instruction
    const splToken = require('@solana/spl-token');
    instructions.push(
      splToken.createTransferInstruction(
        sourceATA, destinationATA, ownerPubkey, 1, [], TOKEN_PROGRAM_ID
      )
    );

    const messageV0 = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    // Use WalletAdapter for non-MWA wallets, MWA for others
    let txSignature;
    const useWalletAdapter = walletAdapterAvailable && WalletAdapter && currentWalletType && currentWalletType !== 'mwa';

    if (useWalletAdapter) {
      console.log('[NFT Transfer] Using WalletAdapter for signing...');
      const txResult = await WalletAdapter.signAndSendTransaction(transaction);
      if (!txResult.success) {
        throw new Error(txResult.error || 'WalletAdapter signing failed');
      }
      txSignature = txResult.signature;
    } else if (mwaAdapterAvailable && MWAAdapter) {
      // Sign only — we send manually via our Helius RPC (wallet's built-in RPC is rate-limited)
      console.log('[NFT Transfer] Using MWAAdapter for signing (sign-only)...');
      const txResult = await MWAAdapter.signTransaction(transaction);
      if (!txResult.success) {
        throw new Error(txResult.error || 'MWAAdapter signing failed');
      }
      console.log('[NFT Transfer] Transaction signed, sending via app RPC...');

      const signedTx = txResult.signedTransaction;
      const RPC_ENDPOINTS = [SOLANA_RPC_ENDPOINT, ...SOLANA_RPC_FALLBACKS];
      let sendError = null;
      try {
        txSignature = await broadcastSignedTransaction(signedTx, 'NFT Transfer');
      } catch (e) { sendError = e; }
      if (false) for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
        try {
          const sendConn = new Connection(RPC_ENDPOINTS[i], 'confirmed');
          txSignature = await sendConn.sendRawTransaction(
            signedTx.serialize(),
            { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }
          );
          console.log('[NFT Transfer] Transaction submitted:', txSignature);
          break;
        } catch (sendErr) {
          sendError = sendErr;
          if (i === RPC_ENDPOINTS.length - 1) {
            console.error('[NFT Transfer] All RPC endpoints failed:', sendErr.message);
          }
        }
      }
      if (!txSignature) {
        throw sendError || new Error('Failed to send transfer transaction');
      }
    } else {
      throw new Error('No wallet adapter available for signing');
    }

    // NOTE: Do NOT remove NFT from storage here — the completion handler
    // (handleNftTransferComplete) does cert transfer first (needs encryptionData
    // still in storage for nftKey unwrap), then removes NFT afterwards.

    console.log(`[NFT] Transfer successful: ${txSignature}`);

    return {
      success: true,
      txSignature,
      recipientAddress,
      isDomain: resolved.isDomain,
      domainName: resolved.domainName,
    };
  } catch (e) {
    console.error('[NFT] Transfer failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Transfer NFT to user by .sol domain name
 * @param {string} mintAddress - NFT mint address
 * @param {string} solDomain - Recipient's .sol domain (e.g., "alice.sol")
 * @returns {Object} { success, txSignature, recipientAddress, domainName, error }
 */
export const transferNFTBySolDomain = async (mintAddress, solDomain) => {
  return transferNFT(mintAddress, solDomain);
};

/**
 * Transfer NFT to user by email (lookup wallet address from server)
 * @param {string} mintAddress - NFT mint address
 * @param {string} recipientEmail - Recipient's email
 * @param {string} authToken - Auth token for server lookup
 * @returns {Object} { success, txSignature, recipientAddress, error }
 */
export const transferNFTByEmail = async (mintAddress, recipientEmail, authToken) => {
  try {
    // Lookup recipient's wallet address from server
    // This requires the recipient to have connected their wallet in the app
    const response = await axios.post('https://stealthlynk.io/api/lookup-wallet', {
      email: recipientEmail,
    }, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: 10000,
    });

    if (!response.data?.walletAddress) {
      return { success: false, error: 'Recipient wallet not found. They must connect their wallet in PhotoLynk first.' };
    }

    const result = await transferNFT(mintAddress, response.data.walletAddress);

    return {
      ...result,
      recipientAddress: response.data.walletAddress,
      recipientEmail,
    };
  } catch (e) {
    console.error('[NFT] Transfer by email failed:', e);
    return { success: false, error: e.message };
  }
};

// ============================================================================
// NFT STORAGE (Local + Server Sync)
// ============================================================================

/**
 * Save NFT to local storage AND sync to server
 */
export const saveNFTToStorage = async (nftData, serverUrl = null, authHeaders = null) => {
  try {
    // Strip large fields BEFORE saving to prevent OOM on subsequent reads
    // but keep lightweight metadata needed for ecosystem checks and cert enrichment
    const toSave = { ...nftData };
    toSave.metadata = slimNFTMetadataForStorage(nftData.metadata);
    delete toSave.exifData;
    if (toSave.imageUrl && toSave.imageUrl.startsWith('data:') && !toSave.imageUrl.startsWith('data:image/svg') && toSave.imageUrl.length > 5000) delete toSave.imageUrl;
    if (toSave.arweaveUrl && toSave.arweaveUrl.startsWith('data:') && !toSave.arweaveUrl.startsWith('data:image/svg') && toSave.arweaveUrl.length > 5000) delete toSave.arweaveUrl;

    // Save locally first
    const existing = await getStoredNFTs();
    const normalizeMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const normalizeMeta = (u) => u ? String(u).trim() : '';
    const incomingMint = normalizeMint(toSave.mintAddress);
    const incomingMeta = normalizeMeta(toSave.metadataUrl);
    const incomingIsTemp = !!incomingMint && incomingMint.startsWith('tx_');
    let existingIdx = incomingMint ? existing.findIndex(n => normalizeMint(n.mintAddress) === incomingMint) : -1;
    if (existingIdx === -1 && incomingMeta) {
      existingIdx = existing.findIndex(n => {
        const existingMeta = normalizeMeta(n.metadataUrl);
        if (!existingMeta || existingMeta !== incomingMeta) return false;
        const existingMint = normalizeMint(n.mintAddress);
        const existingIsTemp = !!existingMint && existingMint.startsWith('tx_');
        return incomingIsTemp || existingIsTemp;
      });
    }
    if (existingIdx === -1) {
      existing.push(toSave);
    } else {
      const merged = { ...existing[existingIdx] };
      for (const [key, value] of Object.entries(toSave)) {
        if (value !== undefined && value !== null && value !== '') merged[key] = value;
      }
      existing[existingIdx] = merged;
    }
    await saveNFTsToFile(existing);

    // Sync to server if available (for persistence across reinstalls)
    if (serverUrl && authHeaders) {
      try {
        await axios.post(`${serverUrl}/api/nft/sync`, {
          action: 'add',
          nft: toSave,
        }, {
          headers: authHeaders,
          timeout: 10000,
        });
        console.log('[NFT] Synced to server:', nftData.mintAddress);
      } catch (syncErr) {
        console.log('[NFT] Server sync failed (will retry later):', syncErr.message);
      }
    }
  } catch (e) {
    console.error('[NFT] Failed to save NFT:', e);
  }
};

/**
 * Detect storage type from NFT URLs (for legacy NFTs without storageType field)
 */
const detectStorageType = (nft) => {
  // Check arweaveUrl first (original full image URL)
  const urlToCheck = nft.arweaveUrl || nft.imageUrl || nft.thumbnailUrl || '';

  // StealthCloud URLs contain stealthlynk.io
  if (urlToCheck.includes('stealthlynk.io') || urlToCheck.includes('nft.stealthlynk.io')) {
    return 'cloud';
  }

  // On-chain data URIs
  if (urlToCheck.startsWith('data:')) {
    return 'onchain';
  }

  // Arweave URLs (akrd.net or arweave.net)
  if (urlToCheck.includes('akrd.net') || urlToCheck.includes('arweave.net') || urlToCheck.includes('irys.xyz')) {
    return 'arweave';
  }

  // IPFS URLs contain ipfs, pinata, w3s.link
  if (urlToCheck.includes('ipfs') || urlToCheck.includes('pinata') ||
    urlToCheck.includes('w3s.link')) {
    return 'ipfs';
  }

  // Default to IPFS for unknown
  return 'ipfs';
};

const slimNFTMetadataForStorage = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return null;
  const slim = {};
  if (metadata.name !== undefined) slim.name = metadata.name;
  if (metadata.description !== undefined) slim.description = metadata.description;
  if (Array.isArray(metadata.attributes)) slim.attributes = metadata.attributes;
  if (metadata.properties && typeof metadata.properties === 'object') {
    const props = {};
    if (metadata.properties.certificate && typeof metadata.properties.certificate === 'object') {
      const cert = metadata.properties.certificate;
      props.certificate = {
        type: cert.type,
        mintedAt: cert.mintedAt,
        rfc3161: cert.rfc3161 ? {
          tsa: cert.rfc3161.tsa,
          tsaPolicy: cert.rfc3161.tsaPolicy,
          tsaTokenBase64: cert.rfc3161.tsaTokenBase64,
        } : undefined,
      };
    }
    if (metadata.properties.c2pa !== undefined) props.c2pa = metadata.properties.c2pa;
    if (Object.keys(props).length > 0) slim.properties = props;
  }
  return Object.keys(slim).length > 0 ? slim : null;
};

/**
 * Get all stored NFTs (local) - uses FileSystem for unlimited storage
 */
export const getStoredNFTs = async () => {
  try {
    // Check if file exists
    const fileInfo = await FileSystem.getInfoAsync(NFT_STORAGE_FILE);
    if (!fileInfo.exists) {
      // One-time migration from SecureStore (if any data exists there)
      try {
        const legacyData = await SecureStore.getItemAsync(NFT_STORAGE_KEY);
        if (legacyData) {
          const nfts = JSON.parse(legacyData);
          await FileSystem.writeAsStringAsync(NFT_STORAGE_FILE, legacyData);
          await SecureStore.deleteItemAsync(NFT_STORAGE_KEY);
          console.log('[NFT] Migrated', nfts.length, 'NFTs from SecureStore to FileSystem');
          return nfts;
        }
      } catch (migrationErr) {
        // SecureStore may not have data, that's fine
      }
      return [];
    }
    // Guard against corrupted/bloated file (50MB+ = something is very wrong)
    if (fileInfo.size && fileInfo.size > 50 * 1024 * 1024) {
      console.warn('[NFT] Storage file critically large (' + Math.round(fileInfo.size / 1024 / 1024) + 'MB), resetting.');
      await FileSystem.deleteAsync(NFT_STORAGE_FILE, { idempotent: true });
      return [];
    }

    let stored;
    try {
      stored = await FileSystem.readAsStringAsync(NFT_STORAGE_FILE);
    } catch (readErr) {
      console.warn('[NFT] Storage file read failed (OOM?), resetting:', readErr?.message);
      await FileSystem.deleteAsync(NFT_STORAGE_FILE, { idempotent: true });
      return [];
    }
    let nfts = stored ? JSON.parse(stored) : [];

    // Deduplicate by normalized mintAddress (strips cnft_ prefix for comparison)
    const _normM = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    let needsSave = false;
    const _seenMints = new Set();
    const _deduped = [];
    for (const nft of nfts) {
      const k = _normM(nft.mintAddress);
      if (!k || _seenMints.has(k)) { needsSave = true; continue; }
      _seenMints.add(k);
      _deduped.push(nft);
    }
    nfts = _deduped;

    // Auto-fix legacy NFTs without storageType field
    nfts = nfts.map(nft => {
      if (!nft.storageType) {
        needsSave = true;
        return { ...nft, storageType: detectStorageType(nft) };
      }
      return nft;
    });

    // Convert legacy ipfs:// scheme URLs to gateway URLs (old standard NFTs stored raw ipfs:// URIs)
    for (const nft of nfts) {
      if (nft.imageUrl && nft.imageUrl.startsWith('ipfs://')) {
        nft.imageUrl = 'https://nftstorage.link/ipfs/' + nft.imageUrl.replace(/^ipfs:\/\/(ipfs\/)?/, '');
        needsSave = true;
      }
      if (nft.arweaveUrl && nft.arweaveUrl.startsWith('ipfs://')) {
        nft.arweaveUrl = 'https://nftstorage.link/ipfs/' + nft.arweaveUrl.replace(/^ipfs:\/\/(ipfs\/)?/, '');
        needsSave = true;
      }
    }

    // Strip bloated fields (exifData, large data URIs) to prevent OOM
    // Keep only slim metadata needed for transfer/certificate logic
    for (const nft of nfts) {
      if (nft.imageUrl && nft.imageUrl.startsWith('data:') && !nft.imageUrl.startsWith('data:image/svg') && nft.imageUrl.length > 5000) {
        delete nft.imageUrl; needsSave = true;
      }
      if (nft.arweaveUrl && nft.arweaveUrl.startsWith('data:') && !nft.arweaveUrl.startsWith('data:image/svg') && nft.arweaveUrl.length > 5000) {
        delete nft.arweaveUrl; needsSave = true;
      }
      const normalizedAssetId = nft.assetId ? String(nft.assetId).replace(/^cnft_/, '').trim() : '';
      if (normalizedAssetId && !normalizedAssetId.startsWith('tx_') && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalizedAssetId)) {
        delete nft.assetId; needsSave = true;
      }
      const slimMeta = slimNFTMetadataForStorage(nft.metadata);
      const metaChanged = JSON.stringify(nft.metadata || null) !== JSON.stringify(slimMeta);
      if (metaChanged) { nft.metadata = slimMeta; needsSave = true; }
      if (nft.exifData) { delete nft.exifData; needsSave = true; }
    }

    // Save back if we fixed any NFTs
    if (needsSave) {
      await saveNFTsToFile(nfts);
      if (!_nftCleanupLogged) { console.log('[NFT] Cleaned up NFT storage file'); _nftCleanupLogged = true; }
    }

    return nfts;
  } catch (e) {
    console.error('[NFT] Failed to get NFTs:', e);
    return [];
  }
};

/**
 * Save NFTs array to FileSystem
 * Strips large base64 data URIs and metadata to prevent OOM on Android
 */
const saveNFTsToFile = async (nfts) => {
  const slim = nfts.map(n => {
    const copy = { ...n };
    // Strip base64 data URIs (recoverable from IPFS/Arweave/thumbnailUrl)
    if (copy.imageUrl && copy.imageUrl.startsWith('data:') && !copy.imageUrl.startsWith('data:image/svg') && copy.imageUrl.length > 5000) {
      // Preserve arweaveUrl or metadataUrl as fallback, drop the huge data URI
      delete copy.imageUrl;
    }
    if (copy.arweaveUrl && copy.arweaveUrl.startsWith('data:') && !copy.arweaveUrl.startsWith('data:image/svg') && copy.arweaveUrl.length > 5000) {
      delete copy.arweaveUrl;
    }
    // Strip full metadata object (recoverable from chain)
    delete copy.metadata;
    delete copy.exifData;
    return copy;
  });
  await FileSystem.writeAsStringAsync(NFT_STORAGE_FILE, JSON.stringify(slim));
};

/**
 * Sync NFTs from server (restores NFTs after reinstall)
 * @param {string} serverUrl - Server base URL
 * @param {Object} authHeaders - Auth headers
 * @returns {Object} { success, nfts, merged, error }
 */
export const syncNFTsFromServer = async (serverUrl, authHeaders, walletAddress = null) => {
  if (_mintingInProgress) {
    console.log('[NFT] syncNFTsFromServer skipped — minting in progress');
    return { success: true, nfts: [], merged: 0, skipped: true };
  }
  try {
    // Get NFTs from server
    const response = await axios.get(`${serverUrl}/api/nft/list`, {
      headers: authHeaders,
      params: walletAddress ? { walletAddress } : undefined,
      timeout: 15000,
    });

    const serverNFTs = response.data?.nfts || [];

    if (serverNFTs.length === 0) {
      return { success: true, nfts: await getStoredNFTs(), merged: 0 };
    }

    // Get local NFTs
    const localNFTs = await getStoredNFTs();
    const normalizeMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const localMints = new Set(localNFTs.map(n => normalizeMint(n.mintAddress)));

    // Merge: add server NFTs that aren't local, and update local NFTs with missing fields
    let newCount = 0;
    let fieldUpdates = 0;
    // Build index for fast lookup (by normalized mint AND metadataUrl)
    const localByMint = {};
    const localByMeta = {};
    localNFTs.forEach((n, i) => {
      const k = normalizeMint(n.mintAddress); if (k) localByMint[k] = i;
      if (n.metadataUrl) localByMeta[n.metadataUrl] = i;
    });
    for (const serverNFT of serverNFTs) {
      // Strip bloated fields from server data before merging (prevents getStoredNFTs re-cleanup loop)
      serverNFT.metadata = slimNFTMetadataForStorage(serverNFT.metadata);
      delete serverNFT.exifData;
      if (serverNFT.imageUrl && serverNFT.imageUrl.startsWith('data:') && !serverNFT.imageUrl.startsWith('data:image/svg') && serverNFT.imageUrl.length > 5000) {
        delete serverNFT.imageUrl;
      }
      const sKey = normalizeMint(serverNFT.mintAddress);
      if (!sKey) continue; // Skip NFTs with empty/null mintAddress
      if (!localMints.has(sKey)) {
        // Skip tx_ temp entries from server if a real entry with same metadataUrl already exists locally
        const sMint = String(serverNFT.mintAddress || '');
        if ((sMint.startsWith('tx_') || sMint.startsWith('cnft_tx_')) && serverNFT.metadataUrl && localByMeta[serverNFT.metadataUrl] !== undefined) {
          const localIdx = localByMeta[serverNFT.metadataUrl];
          const local = localNFTs[localIdx];
          const localMint = String(local?.mintAddress || '');
          if (local && !localMint.startsWith('tx_') && !localMint.startsWith('cnft_tx_')) {
            // Merge encryptionData from tx_ server entry into real local entry
            if (serverNFT.encryptionData) { if (!local.encryptionData) { local.encryptionData = serverNFT.encryptionData; } else { for (const [ek, ev] of Object.entries(serverNFT.encryptionData)) { if (ev != null && ev !== '' && (local.encryptionData[ek] == null || local.encryptionData[ek] === '')) local.encryptionData[ek] = ev; } } fieldUpdates++; }
            if (serverNFT.thumbnailUrl && !local.thumbnailUrl) { local.thumbnailUrl = serverNFT.thumbnailUrl; fieldUpdates++; }
            if (serverNFT.edition && !local.edition) { local.edition = serverNFT.edition; fieldUpdates++; }
            if (serverNFT.certificationMode && !local.certificationMode) { local.certificationMode = serverNFT.certificationMode; fieldUpdates++; }
            if (serverNFT.isCompressed && !local.isCompressed) { local.isCompressed = serverNFT.isCompressed; fieldUpdates++; }
            if (serverNFT.assetId && !local.assetId) { local.assetId = serverNFT.assetId; fieldUpdates++; }
            continue; // Don't add the tx_ duplicate
          }
        }
        // Also handle reverse: server has real cnft_ but local has tx_ with same metadataUrl — replace local tx_
        const sMint2 = String(serverNFT.mintAddress || '');
        if (!sMint2.startsWith('tx_') && !sMint2.startsWith('cnft_tx_') && serverNFT.metadataUrl && localByMeta[serverNFT.metadataUrl] !== undefined) {
          const localIdx = localByMeta[serverNFT.metadataUrl];
          const local = localNFTs[localIdx];
          const localMint = String(local?.mintAddress || '');
          if (local && (localMint.startsWith('tx_') || localMint.startsWith('cnft_tx_'))) {
            if (local.encryptionData && !serverNFT.encryptionData) serverNFT.encryptionData = local.encryptionData;
            if (local.thumbnailUrl && !serverNFT.thumbnailUrl) serverNFT.thumbnailUrl = local.thumbnailUrl;
            if (local.imageUrl && !serverNFT.imageUrl) serverNFT.imageUrl = local.imageUrl;
            localNFTs[localIdx] = serverNFT;
            localByMint[sKey] = localIdx;
            localByMeta[serverNFT.metadataUrl] = localIdx;
            fieldUpdates++;
            continue;
          }
        }
        if (!serverNFT.discoveredAt) serverNFT.discoveredAt = new Date().toISOString();
        localNFTs.push(serverNFT);
        localMints.add(sKey);
        if (serverNFT.metadataUrl) localByMeta[serverNFT.metadataUrl] = localNFTs.length - 1;
        newCount++;
        if (newCount <= 3) console.log(`[NFT] New from server: "${serverNFT.name}" mint=${(serverNFT.mintAddress || '').slice(0, 20)}`);
      } else {
        // Merge missing fields from server into local (cross-platform encryptionData, edition, etc.)
        const localIdx = localByMint[sKey];
        if (localIdx !== undefined) {
          const local = localNFTs[localIdx];
          if (serverNFT.imageUrl && !local.imageUrl) { local.imageUrl = serverNFT.imageUrl; fieldUpdates++; }
          if (serverNFT.encryptionData) { if (!local.encryptionData) { local.encryptionData = serverNFT.encryptionData; } else { for (const [ek, ev] of Object.entries(serverNFT.encryptionData)) { if (ev != null && ev !== '' && (local.encryptionData[ek] == null || local.encryptionData[ek] === '')) local.encryptionData[ek] = ev; } } fieldUpdates++; }
          if (serverNFT.edition && !local.edition) { local.edition = serverNFT.edition; fieldUpdates++; }
          if (serverNFT.certificationMode && !local.certificationMode) { local.certificationMode = serverNFT.certificationMode; fieldUpdates++; }
          if (serverNFT.isCompressed && !local.isCompressed) { local.isCompressed = serverNFT.isCompressed; fieldUpdates++; }
          const serverHasEncPayload = hasUsableWrappedEncryptionPayload(serverNFT.encryptionData);
          const localHasEncPayload = hasUsableWrappedEncryptionPayload(local.encryptionData);
          if ((serverNFT.encrypted || serverHasEncPayload) && !local.encrypted) { local.encrypted = true; fieldUpdates++; }
          else if (!serverNFT.encrypted && !serverHasEncPayload && local.encrypted && !localHasEncPayload) { local.encrypted = false; fieldUpdates++; }
          if (serverNFT.watermarked && !local.watermarked) { local.watermarked = serverNFT.watermarked; fieldUpdates++; }
          if (serverNFT.license && !local.license) { local.license = serverNFT.license; fieldUpdates++; }
          if (serverNFT.storageType && !local.storageType) { local.storageType = serverNFT.storageType; fieldUpdates++; }
          if (serverNFT.assetId && !local.assetId) { local.assetId = serverNFT.assetId; fieldUpdates++; }
          if (serverNFT.thumbnailUrl && !local.thumbnailUrl) { local.thumbnailUrl = serverNFT.thumbnailUrl; fieldUpdates++; }
        }
      }
    }

    // Save merged list
    const merged = newCount + fieldUpdates;
    if (merged > 0) {
      await saveNFTsToFile(localNFTs);
      if (newCount > 0) console.log(`[NFT] Merged ${newCount} new NFTs from server`);
      if (fieldUpdates > 0) console.log(`[NFT] Updated ${fieldUpdates} fields from server`);
    }

    return { success: true, nfts: localNFTs, merged };
  } catch (e) {
    console.error('[NFT] Server sync failed:', e.message);
    return { success: false, error: e.message, nfts: await getStoredNFTs(), merged: 0 };
  }
};

/**
 * Push all local NFTs to server (backup)
 */
export const backupNFTsToServer = async (serverUrl, authHeaders, walletAddress = null) => {
  if (_mintingInProgress) {
    console.log('[NFT] backupNFTsToServer skipped — minting in progress');
    return { success: true, backed: 0, skipped: true };
  }
  try {
    const normalizeWallet = (w) => w ? String(w).trim() : '';
    const transferredOut = await getTransferredOutBlacklist();
    const allLocalNFTs = await getStoredNFTs();
    const localNFTs = walletAddress
      ? allLocalNFTs.filter(nft => normalizeWallet(nft.ownerAddress) === normalizeWallet(walletAddress))
      : allLocalNFTs;
    const filteredLocalNFTs = localNFTs.filter(nft => {
      const mint = nft?.mintAddress ? String(nft.mintAddress).replace(/^cnft_/, '').trim() : '';
      if (!mint) return false;
      if (mint.startsWith('tx_')) return false;
      return !(transferredOut.has(mint) || transferredOut.has(`cnft_${mint}`));
    });
    if (filteredLocalNFTs.length === 0) {
      return { success: true, backed: 0 };
    }

    // Strip large fields to reduce payload size
    const slim = filteredLocalNFTs.map(n => {
      const copy = { ...n };
      delete copy.exifData;
      delete copy.metadata; // Full metadata JSON can be huge (C2PA, RFC3161, etc.) — recoverable from chain
      delete copy.attributes; // Can be large for limited editions — recoverable from chain
      // Strip large data: URIs from any field (recoverable from chain metadata)
      if (copy.imageUrl && copy.imageUrl.startsWith('data:') && !copy.imageUrl.startsWith('data:image/svg') && copy.imageUrl.length > 5000) {
        delete copy.imageUrl;
      }
      if (copy.arweaveUrl && copy.arweaveUrl.startsWith('data:') && !copy.arweaveUrl.startsWith('data:image/svg') && copy.arweaveUrl.length > 5000) {
        delete copy.arweaveUrl;
      }
      return copy;
    });

    // Batch into small chunks to stay under reverse-proxy body limit
    const BATCH = 3;
    let backed = 0;
    for (let i = 0; i < slim.length; i += BATCH) {
      const batch = slim.slice(i, i + BATCH);
      try {
        await axios.post(`${serverUrl}/api/nft/sync`, {
          action: 'backup',
          nfts: batch,
        }, {
          headers: authHeaders,
          timeout: 15000,
        });
        backed += batch.length;
      } catch (batchErr) {
        // Skip failed batch — will retry next sync
      }
    }

    console.log('[NFT] Backed up', backed, '/', slim.length, 'NFTs to server');
    return { success: true, backed };
  } catch (e) {
    console.error('[NFT] Backup failed:', e.message);
    return { success: false, error: e.message };
  }
};

/**
 * Remove NFT from local storage, image cache, AND server
 */
export const removeNFTFromStorage = async (mintAddress, serverUrl = null, authHeaders = null) => {
  try {
    const existing = await getStoredNFTs();

    // Find the NFT to get its image URLs before removing
    const nftToRemove = existing.find(nft => nft.mintAddress === mintAddress);

    const filtered = existing.filter(nft => nft.mintAddress !== mintAddress);
    await saveNFTsToFile(filtered);

    // Clear image from cache
    if (nftToRemove) {
      try {
        // Remove all possible image URLs from cache
        if (nftToRemove.imageUrl) await removeNFTImageFromCache(nftToRemove.imageUrl);
        if (nftToRemove.thumbnailUrl) await removeNFTImageFromCache(nftToRemove.thumbnailUrl);
        if (nftToRemove.arweaveUrl) await removeNFTImageFromCache(nftToRemove.arweaveUrl);
        console.log('[NFT] Cleared image cache for:', mintAddress);
      } catch (cacheErr) {
        console.log('[NFT] Could not clear image cache:', cacheErr.message);
      }
    }

    // Clean up associated certificates (prevents orphan certs)
    try { await removeCertificateByMint(mintAddress); } catch (_) { }

    // Sync removal to server
    if (serverUrl && authHeaders) {
      try {
        await axios.post(`${serverUrl}/api/nft/sync`, {
          action: 'remove',
          mintAddress,
        }, {
          headers: authHeaders,
          timeout: 10000,
        });
      } catch (syncErr) {
        console.log('[NFT] Server sync removal failed:', syncErr.message);
      }
    }
  } catch (e) {
    console.error('[NFT] Failed to remove NFT:', e);
  }
};

/**
 * Remove locally-stored NFTs that were transferred out (no longer on server for this wallet).
 * Compares local set vs server set to find transferred items.
 * OOM-safe: processes in batches, doesn't hold full server response in memory.
 */
export const removeTransferredNFTs = async (walletAddress, serverUrl, authHeaders) => {
  try {
    if (!serverUrl || !authHeaders || !walletAddress) return;
    const normMint = (m) => m ? String(m).replace(/^cnft_/, '').trim() : '';
    const normWallet = (w) => w ? String(w).trim() : '';
    const transferredOut = await getTransferredOutBlacklist();
    // Ask server for the set of mint addresses it knows about for this wallet
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(`${serverUrl}/api/nft/sync`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list-mints', walletAddress }),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!resp.ok) return; // Server doesn't support list-mints yet — skip silently
    const data = await resp.json();
    const serverMints = new Set((data.mints || []).map(m => normMint(m)));
    if (serverMints.size === 0) return; // Empty response = server has no data or error — don't wipe local

    const localNFTs = await getStoredNFTs();
    const walletNorm = normWallet(walletAddress);
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    let removed = 0;
    const kept = [];
    for (const nft of localNFTs) {
      // Only consider NFTs belonging to this wallet
      if (normWallet(nft.ownerAddress) !== walletNorm) { kept.push(nft); continue; }
      const mint = normMint(nft.mintAddress);
      const isBlacklisted = !!mint && (transferredOut.has(mint) || transferredOut.has(`cnft_${mint}`));
      if (mint.startsWith('tx_')) { kept.push(nft); continue; }
      // Skip recently minted (< 5 min) — server may not have synced yet
      if (!isBlacklisted && nft.createdAt && new Date(nft.createdAt).getTime() > fiveMinAgo) { kept.push(nft); continue; }
      // Skip NFTs discovered on-chain via DAS — ownership verified by blockchain, not server
      if (nft.source === 'das' && !isBlacklisted) { kept.push(nft); continue; }
      if (!isBlacklisted && serverMints.has(mint)) { kept.push(nft); continue; }
      // This NFT is not on the server — it was transferred out
      console.log(`[NFT] Removing transferred NFT: ${nft.name || mint}`);
      // Clean up image cache for this NFT
      try { await removeNFTImageFromCache(nft.imageUrl || nft.arweaveUrl || ''); } catch (_) { }
      // Clean up associated certificates
      try { await removeCertificateByMint(nft.mintAddress); } catch (_) { }
      if (isBlacklisted) {
        try {
          await axios.post(`${serverUrl}/api/nft/sync`, {
            action: 'remove',
            mintAddress: nft.mintAddress,
            ownerAddress: walletAddress,
          }, {
            headers: authHeaders,
            timeout: 10000,
          });
        } catch (_) { }
      }
      removed++;
    }
    if (removed > 0) {
      await saveNFTsToFile(kept);
      console.log(`[NFT] Removed ${removed} transferred NFTs from local cache`);
    }
  } catch (e) { console.log('[NFT] removeTransferredNFTs failed (non-critical):', e.message); }
};
/**
 * Clear all stored NFTs (local and optionally server)
 * @param {string} serverUrl - Optional server URL to also clear server NFTs
 * @param {Object} authHeaders - Optional auth headers for server request
 */
export const clearAllStoredNFTs = async (serverUrl = null, authHeaders = null, options = {}) => {
  try {
    const targetWallet = options?.walletAddress ? String(options.walletAddress).trim() : '';
    if (!targetWallet) {
      return { success: false, error: 'Wallet address required' };
    }
    let serverResult = null;
    let serverError = null;
    // Only clear server NFTs when permanently deleting assets (burn/cleanup).
    // When just clearing the album view (deleteAssets: false), preserve server-side
    // metadata including encryptionData so rescanned encrypted NFTs can still decrypt.
    if (serverUrl && authHeaders && !!options.deleteAssets) {
      try {
        const headers = authHeaders?.headers || authHeaders;
        const resp = await fetch(`${serverUrl}/api/nft/clear-all`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deleteAssets: !!options.deleteAssets, unpinIpfs: !!options.unpinIpfs, walletAddress: targetWallet }),
        });
        const data = await resp.json().catch(() => null);
        if (resp.ok) {
          console.log('[NFT] Cleared server NFTs');
          serverResult = data;
        } else {
          console.log('[NFT] Server clear failed:', resp.status);
          serverError = data?.error || `Server clear failed: ${resp.status}`;
        }
      } catch (e) {
        console.log('[NFT] Server clear error:', e.message);
        serverError = e.message;
      }
    }

    // Clear local storage
    const existingNfts = await getStoredNFTs();
    const removedNfts = existingNfts.filter(nft => String(nft?.ownerAddress || '').trim() === targetWallet);
    const keptNfts = existingNfts.filter(nft => String(nft?.ownerAddress || '').trim() !== targetWallet);
    for (const nft of removedNfts) {
      try { if (nft?.imageUrl) await removeNFTImageFromCache(nft.imageUrl); } catch (_) { }
      try { if (nft?.thumbnailUrl) await removeNFTImageFromCache(nft.thumbnailUrl); } catch (_) { }
      try { if (nft?.arweaveUrl) await removeNFTImageFromCache(nft.arweaveUrl); } catch (_) { }
    }
    await saveNFTsToFile(keptNfts);

    const existingCerts = await getStoredCertificates();
    const keptCerts = existingCerts.filter(cert => {
      const owner = String(cert?.ownerAddress || '').trim();
      const creator = String(cert?.creatorWallet || '').trim();
      const ownerMatch = owner === targetWallet;
      const creatorMatch = creator === targetWallet && (!owner || owner === targetWallet);
      return !ownerMatch && !creatorMatch;
    });
    await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(keptCerts));
    console.log('[NFT] Cleared stored NFTs for wallet:', targetWallet);
    return { success: true, server: serverResult, serverError };
  } catch (e) {
    console.error('[NFT] Failed to clear NFTs:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Get NFT by mint address
 */
export const getNFTByMintAddress = async (mintAddress) => {
  const nfts = await getStoredNFTs();
  return nfts.find(nft => nft.mintAddress === mintAddress);
};

// ============================================================================
// BLOCKCHAIN VERIFICATION
// ============================================================================

/**
 * Get Solana Explorer URL for transaction
 */
export const getExplorerUrl = (txSignature, type = 'tx') => {
  const base = 'https://explorer.solana.com';
  return `${base}/${type}/${txSignature}?cluster=mainnet-beta`;
};

/**
 * Get Solscan URL for NFT
 */
export const getSolscanUrl = (mintAddress) => {
  return `https://solscan.io/token/${mintAddress}`;
};

/**
 * Verify NFT exists on-chain
 * @param {string} mintAddress - The mint address or cNFT asset ID
 * @param {string} txSignature - Optional transaction signature for cNFT verification fallback
 */
export const verifyNFTOnChain = async (mintAddress, txSignature = null) => {
  // Initialize connection if not available
  if (!connection) {
    await initializeNFT();
  }

  if (!connection) {
    return { verified: false, error: 'Could not connect to Solana' };
  }

  try {
    // Handle compressed NFTs (cNFTs) - use DAS API
    if (mintAddress?.startsWith('cnft_')) {
      // Check if it's a tx-based ID (fallback when DAS wasn't ready)
      if (mintAddress.startsWith('cnft_tx_')) {
        const txSig = mintAddress.replace('cnft_tx_', '');
        // Verify the transaction exists
        try {
          const txInfo = await connection.getTransaction(txSig, { maxSupportedTransactionVersion: 0 });
          if (txInfo && !txInfo.meta?.err) {
            return {
              verified: true,
              exists: true,
              compressed: true,
              txBased: true,
              note: 'Verified via transaction',
            };
          }
        } catch (txError) {
          console.log('[Verify] Could not verify tx:', txError.message);
        }
        return { verified: false, error: 'Transaction not found or failed' };
      }

      // Real asset ID - use DAS API
      const assetId = mintAddress.replace('cnft_', '');

      // Check if assetId looks valid (base58, 32-44 chars)
      if (assetId.length >= 32 && assetId.length <= 44) {
        const response = await fetch(SOLANA_RPC_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'verify-cnft',
            method: 'getAsset',
            params: { id: assetId },
          }),
        });
        const data = await response.json();

        if (data.result && data.result.id) {
          return {
            verified: true,
            exists: true,
            owner: data.result.ownership?.owner,
            compressed: true,
            tree: data.result.compression?.tree,
          };
        }
      }

      // Old format or DAS failed - try txSignature if provided
      if (txSignature) {
        try {
          console.log('[Verify] Trying txSignature fallback:', txSignature.slice(0, 20));
          const txInfo = await connection.getTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
          if (txInfo && !txInfo.meta?.err) {
            return {
              verified: true,
              exists: true,
              compressed: true,
              txBased: true,
              note: 'Verified via transaction',
            };
          }
        } catch (txError) {
          console.log('[Verify] txSignature fallback failed:', txError.message);
        }
      }

      return { verified: false, error: 'Asset not found (try rescanning wallet)' };
    }

    // Standard NFT verification
    const mintPubkey = new PublicKey(mintAddress);
    const accountInfo = await connection.getAccountInfo(mintPubkey);

    return {
      verified: !!accountInfo,
      exists: !!accountInfo,
      owner: accountInfo?.owner?.toBase58(),
    };
  } catch (e) {
    return { verified: false, error: e.message };
  }
};

// ============================================================================
// NFT DISCOVERY (Fetch NFTs from blockchain)
// ============================================================================

// Global lock: only one fetchNFTsFromBlockchain runs at a time; concurrent callers await the same promise
let _fetchBlockchainInFlight = null;

/**
 * Fetch all NFTs owned by a wallet address from the blockchain
 * Uses Solana RPC directly to get token accounts
 * @param {string} walletAddress - Owner's wallet address
 * @returns {Object} { success, nfts, error }
 */
export const fetchNFTsFromBlockchain = (walletAddress, knownMints = null) => {
  if (!walletAddress) {
    return Promise.resolve({ success: false, error: 'No wallet address provided' });
  }
  if (_fetchBlockchainInFlight) {
    console.log('[NFT] fetchNFTsFromBlockchain — already in flight, waiting for existing call');
    return _fetchBlockchainInFlight;
  }
  const run = async () => {
    try {
      return await _fetchNFTsFromBlockchainImpl(walletAddress, knownMints);
    } finally {
      _fetchBlockchainInFlight = null;
    }
  };
  _fetchBlockchainInFlight = run();
  return _fetchBlockchainInFlight;
};

const _fetchNFTsFromBlockchainImpl = async (walletAddress, knownMints = null) => {
  console.log(`[NFT] Fetching NFTs for wallet: ${walletAddress}`);

  // Initialize connection if not available
  if (!connection) {
    console.log('[NFT] Connection not available, initializing...');
    await initializeNFT();
  }

  if (!connection) {
    console.log('[NFT] ERROR: Could not initialize Solana connection');
    return { success: false, error: 'Could not initialize Solana connection' };
  }

  console.log('[NFT] Connection available, creating pubkey...');

  try {
    const ownerPubkey = new PublicKey(walletAddress);
    console.log(`[NFT] Owner pubkey created: ${ownerPubkey.toBase58()}`);

    // Get all token accounts owned by this wallet
    console.log('[NFT] Fetching token accounts from RPC...');
    let tokenAccounts;
    try {
      tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        ownerPubkey,
        { programId: TOKEN_PROGRAM_ID }
      );
    } catch (rpcErr) {
      console.error('[NFT] RPC error:', rpcErr.message);
      return { success: false, error: `RPC error: ${rpcErr.message}` };
    }

    console.log(`[NFT] Found ${tokenAccounts.value.length} token accounts`);

    // Filter for NFTs (amount = 1, decimals = 0)
    const nftAccounts = tokenAccounts.value.filter(account => {
      const info = account.account.data.parsed.info;
      return info.tokenAmount.amount === '1' && info.tokenAmount.decimals === 0;
    });

    console.log(`[NFT] Found ${nftAccounts.length} potential NFTs`);

    if (nftAccounts.length === 0) {
      return { success: true, nfts: [] };
    }

    // Fetch metadata for each NFT (skip known ones to save memory + bandwidth)
    const nfts = [];
    let skippedKnown = 0;
    for (const account of nftAccounts) {
      const mintAddress = account.account.data.parsed.info.mint;

      // Skip metadata fetch for NFTs already in local storage
      if (knownMints && knownMints.has(mintAddress)) {
        skippedKnown++;
        continue;
      }

      console.log(`[NFT] Fetching metadata for: ${mintAddress}`);

      try {
        const metadata = await fetchNFTMetadata(mintAddress);
        if (metadata && metadata.name) {
          // Extract edition/encrypted/encryptionData from on-chain metadata attributes + properties
          const attrs = Array.isArray(metadata.attributes) ? metadata.attributes : [];
          const getAttr = (traitName) => {
            const a = attrs.find(at => at.trait_type === traitName);
            return a ? a.value : null;
          };
          const editionRaw = getAttr('Edition');
          const edition = editionRaw ? String(editionRaw).toLowerCase() : null;
          const certModeRaw = getAttr('Certification Mode');
          const certificationMode = certModeRaw ? String(certModeRaw).toLowerCase() : (edition === 'limited' ? 'private' : edition === 'open' ? 'public' : null);
          const encryptedFromAttr = isExplicitlyTrue(getAttr('Encrypted'));
          const encryptedFromProps = isExplicitlyTrue(metadata.properties && metadata.properties.encryption && metadata.properties.encryption.encrypted);
          const isWatermarked = getAttr('Watermarked') === 'true';
          const licenseVal = getAttr('License') || null;
          const encProps = (metadata.properties && metadata.properties.encryption) ? metadata.properties.encryption : {};
          const hasRealEncKeys = hasUsableWrappedEncryptionPayload(encProps);
          const isEncrypted = encryptedFromAttr || encryptedFromProps || hasRealEncKeys;
          let imgUrl = metadata.image || '';
          // Convert ipfs:// scheme to gateway URL (old standard NFTs use raw ipfs:// URIs)
          if (imgUrl.startsWith('ipfs://')) imgUrl = 'https://nftstorage.link/ipfs/' + imgUrl.replace(/^ipfs:\/\/(ipfs\/)?/, '');
          const storageType = (imgUrl.includes('stealthlynk.io') || imgUrl.includes('stealthcloud')) ? 'cloud' : imgUrl.startsWith('data:') ? 'onchain' : (imgUrl.includes('akrd.net') || imgUrl.includes('arweave.net')) ? 'arweave' : 'ipfs';

          // Extract proof hashes + flags to top-level fields (survive metadata/attributes stripping)
          const contentHash = getAttr('Content Hash') || null;
          const exifHash = getAttr('EXIF Hash') || null;
          const exifRawHash = getAttr('EXIF Raw Hash') || null;
          const exifBindingHash = getAttr('EXIF Binding Hash') || null;
          const metaCert = metadata?.properties?.certificate;
          const hasRfc3161 = !!(getAttr('RFC 3161 Timestamp') || metaCert?.rfc3161?.tsaTokenBase64);
          const hasC2pa = !!(getAttr('C2PA Provenance') || metadata?.properties?.c2pa);
          const mintedAt = metaCert?.mintedAt || null;

          nfts.push({
            mintAddress,
            name: metadata.name || 'Unknown Proof',
            description: metadata.description || '',
            imageUrl: imgUrl,
            metadataUrl: metadata.uri || '',
            ownerAddress: walletAddress,
            createdAt: mintedAt || new Date().toISOString(),
            discoveredAt: new Date().toISOString(),
            mintedAt: mintedAt || undefined,
            source: 'rpc',
            edition,
            certificationMode,
            encrypted: isEncrypted,
            watermarked: isWatermarked,
            license: licenseVal,
            storageType,
            encryptionData: hasRealEncKeys ? { wrappedKey: encProps.wrappedKey, wrapNonce: encProps.wrapNonce, ...(encProps.nonce ? { nonce: encProps.nonce } : {}), ...(encProps.thumbnailNonce ? { thumbnailNonce: encProps.thumbnailNonce } : {}), ...(encProps.thumbnailUrl ? { thumbnailUrl: encProps.thumbnailUrl } : {}) } : null,
            thumbnailUrl: encProps.thumbnailUrl || null,
            contentHash,
            exifHash,
            exifRawHash,
            exifBindingHash,
            hasRfc3161,
            hasC2pa,
            attributes: attrs,
            metadata, // Full metadata JSON for cert generation (RFC3161, C2PA)
          });
          console.log(`[NFT] Found: ${metadata.name} edition=${edition} certificationMode=${certificationMode} encrypted=${isEncrypted}`);
        }
      } catch (e) {
        console.log(`[NFT] Failed to fetch metadata for ${mintAddress}:`, e.message);
      }
    }

    if (skippedKnown > 0) console.log(`[NFT] Skipped ${skippedKnown} known standard NFTs (already in local storage)`);
    console.log(`[NFT] Successfully fetched ${nfts.length} new standard NFTs`);

    // Also fetch compressed NFTs (cNFTs) using DAS API
    try {
      console.log('[NFT] Fetching compressed NFTs via DAS API...');
      const cNFTs = await fetchCompressedNFTs(walletAddress, knownMints);
      if (cNFTs && cNFTs.length > 0) {
        console.log(`[NFT] Found ${cNFTs.length} compressed NFTs`);
        nfts.push(...cNFTs);
      }
    } catch (cNFTError) {
      console.log('[NFT] cNFT fetch failed (non-critical):', cNFTError.message);
    }

    console.log(`[NFT] Total NFTs fetched: ${nfts.length}`);
    return { success: true, nfts };
  } catch (e) {
    console.error('[NFT] Fetch NFTs failed:', e);
    return { success: false, error: e.message };
  }
};

// Global lock: only one discoverAndImportNFTs runs at a time; concurrent callers await the same promise
let _discoverInFlight = null;

// DAS total-check cache: skip full pagination if total hasn't changed (1 call vs ~24)
let _lastDasTotal = null;
let _lastDasTotalTs = 0;
let _dasForceRefresh = false;

/** Invalidate DAS cache — call after minting to force full re-scan */
export const invalidateDasCache = () => { _dasForceRefresh = true; };

// Persistence key for DAS total cache
const NFT_DAS_TOTAL_KEY = (wallet) => `nft_das_total_${wallet}`;

/** Save DAS total cache to disk */
const saveDasCache = async (wallet, total, ts) => {
  try {
    if (!wallet) return;
    await SecureStore.setItemAsync(NFT_DAS_TOTAL_KEY(wallet), JSON.stringify({ total, ts }));
  } catch (_) { }
};

/** Load DAS total cache from disk */
const loadDasCache = async (wallet) => {
  try {
    if (!wallet) return null;
    const json = await SecureStore.getItemAsync(NFT_DAS_TOTAL_KEY(wallet));
    return json ? JSON.parse(json) : null;
  } catch (_) { return null; }
};

/**
 * Fetch compressed NFTs (cNFTs) using DAS API
 * @param {string} walletAddress - Owner's wallet address
 * @returns {Array} Array of cNFT objects
 */
const fetchCompressedNFTs = async (walletAddress, knownMints = null) => {
  // Restore cache from disk if memory cache is empty
  if (_lastDasTotal === null) {
    const diskCache = await loadDasCache(walletAddress);
    if (diskCache) {
      _lastDasTotal = diskCache.total;
      _lastDasTotalTs = diskCache.ts;
      console.log(`[cNFT] Restored DAS cache from disk: total=${_lastDasTotal}, age=${Math.round((Date.now() - _lastDasTotalTs) / 1000)}s`);
    }
  }

  // DAS API — route through server proxy to avoid per-device Helius rate limits
  const DAS_RPC_URLS_FALLBACK = [
    'https://mainnet.helius-rpc.com/?api-key=8b86bd0d-4534-4ce9-a61d-ec3850cb0b62',
    'https://mainnet.helius-rpc.com/?api-key=6b3d0180-4354-4e31-a2fc-9b6cd9e550a7',
  ];
  let DAS_PAGE_SIZE = 20; // Small pages — wallets with on-chain SVGs can exceed 20MB at higher limits
  let _dasOrigPageSize = DAS_PAGE_SIZE; // Remember original size for recovery
  let _dasConsecutiveOk = 0; // Track consecutive successful pages at reduced size
  const MAX_CNFT_METADATA_PER_CALL = 20; // Cap IPFS fetches per call to prevent OOM

  /** Call DAS method via server proxy, fallback to direct Helius (both keys) */
  const callDAS = async (method, params) => {
    try {
      const serverType = await SecureStore.getItemAsync('server_type');
      const host = serverType === 'remote'
        ? await SecureStore.getItemAsync('remote_host')
        : await SecureStore.getItemAsync('local_host');
      const token = await SecureStore.getItemAsync('auth_token');
      if (host && token) {
        const resp = await fetch(`${host}/api/nft-service/das-proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ method, params }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.result) return data;
        }
      }
    } catch (_) { }
    // Fallback to direct Helius — try each key until one works
    for (const dasUrl of DAS_RPC_URLS_FALLBACK) {
      try {
        const resp = await fetch(dasUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'das-seeker', method, params }),
        });
        if (resp.status === 429) continue; // rate-limited, try next key
        if (!resp.ok) throw new Error(`DAS HTTP error: ${resp.status}`);
        return await resp.json();
      } catch (e) {
        if (e.message && e.message.includes('429')) continue;
        if (dasUrl === DAS_RPC_URLS_FALLBACK[DAS_RPC_URLS_FALLBACK.length - 1]) throw e;
      }
    }
    throw new Error('RATE_LIMITED');
  };

  console.log('[cNFT] Fetching compressed NFTs for:', walletAddress);

  // Cooldown: if DAS was called recently (within 5 min) AND returned results, skip unless force-refreshing
  const forceRefresh = _dasForceRefresh;
  if (forceRefresh) _dasForceRefresh = false;
  if (!forceRefresh && _lastDasTotalTs && _lastDasTotal > 0 && Date.now() - _lastDasTotalTs < 300000) {
    console.log(`[cNFT] DAS called ${Math.round((Date.now() - _lastDasTotalTs) / 1000)}s ago with ${_lastDasTotal} results, skipping (cooldown 300s)`);
    return [];
  }

  // Early exit: if local cNFT count matches cached DAS total, skip API call entirely (0 calls)
  if (!forceRefresh && _lastDasTotal !== null && _lastDasTotal > 0 && knownMints) {
    let localCnftCount = 0;
    for (const m of knownMints) { if (m.startsWith('cnft_')) localCnftCount++; }
    if (localCnftCount >= _lastDasTotal && Date.now() - _lastDasTotalTs < 900000) {
      console.log(`[cNFT] Local cNFTs (${localCnftCount}) >= cached DAS total (${_lastDasTotal}), skipping API call`);
      return [];
    }
  }

  // Paginate DAS API — fetch pages until we find enough new cNFTs or run out of pages
  let compressedItems = [];
  let dasPage = 1;
  let rateLimitRetries = 0;
  const MAX_PAGES = 25; // Safety limit: 25 pages × 20 = 500 items max
  let _dasTotalFromPage1 = null; // Captured from first successful page

  while (dasPage <= MAX_PAGES) {
    try {
      console.log(`[cNFT] DAS page ${dasPage} (limit=${DAS_PAGE_SIZE})...`);
      let data;
      try {
        data = await callDAS('getAssetsByOwner', {
          ownerAddress: walletAddress,
          page: dasPage,
          limit: DAS_PAGE_SIZE,
        });
      } catch (dasErr) {
        if (dasErr.message === 'RATE_LIMITED' && rateLimitRetries < 3) {
          const backoff = Math.min(30000, (rateLimitRetries + 1) * 10000);
          rateLimitRetries++;
          console.log(`[cNFT] Rate limited (429), retrying in ${backoff / 1000}s (attempt ${rateLimitRetries}/3)`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        console.log(`[cNFT] DAS fetch error: ${dasErr.message}`);
        break;
      }
      rateLimitRetries = 0; // Reset on success

      if (data.error) {
        // Rate limited via JSON-RPC error code
        if (data.error.code === -32429 && rateLimitRetries < 3) {
          const backoff = Math.min(30000, (rateLimitRetries + 1) * 10000);
          rateLimitRetries++;
          console.log(`[cNFT] Rate limited (-32429), retrying in ${backoff / 1000}s (attempt ${rateLimitRetries}/3)`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        // "Response is too big" — halve page size and retry same page
        if (data.error.code === -32702 && DAS_PAGE_SIZE > 1) {
          DAS_PAGE_SIZE = Math.max(1, Math.floor(DAS_PAGE_SIZE / 2));
          _dasConsecutiveOk = 0;
          console.log(`[cNFT] Response too big, reducing page size to ${DAS_PAGE_SIZE} and retrying`);
          continue;
        }
        // At page size 1 and still too big — skip this single oversized NFT
        if (data.error.code === -32702 && DAS_PAGE_SIZE <= 1) {
          console.log(`[cNFT] Page ${dasPage} has oversized NFT (>20MB), skipping single item`);
          _dasConsecutiveOk = 0;
          dasPage++;
          continue;
        }
        console.log('[cNFT] DAS API error:', JSON.stringify(data.error));
        break;
      }

      const items = data.result?.items;
      const dasTotal = data.result?.total || 0;

      // Capture total from page 1 for caching
      if (dasPage === 1) _dasTotalFromPage1 = dasTotal;

      // DAS total-check: after page 1 succeeds, compare total to last known
      if (dasPage === 1 && !forceRefresh && _lastDasTotal !== null) {
        if (dasTotal === _lastDasTotal) {
          console.log(`[cNFT] Total unchanged (${dasTotal}), skipping full pagination`);
          _lastDasTotal = dasTotal;
          _lastDasTotalTs = Date.now();
          saveDasCache(walletAddress, _lastDasTotal, _lastDasTotalTs);
          return [];
        }
        console.log(`[cNFT] Total changed: ${_lastDasTotal} → ${dasTotal}, doing full scan`);
      }

      if (!items || items.length === 0) {
        console.log('[cNFT] No more items from DAS');
        break;
      }

      console.log(`[cNFT] Page ${dasPage}: ${items.length} assets`);

      // Page size recovery: after 3 consecutive successes at reduced size, try bumping back up
      if (DAS_PAGE_SIZE < _dasOrigPageSize) {
        _dasConsecutiveOk++;
        if (_dasConsecutiveOk >= 3) {
          const newSize = Math.min(_dasOrigPageSize, DAS_PAGE_SIZE * 2);
          if (newSize > DAS_PAGE_SIZE) {
            console.log(`[cNFT] Recovering page size: ${DAS_PAGE_SIZE} → ${newSize}`);
            DAS_PAGE_SIZE = newSize;
            _dasConsecutiveOk = 0;
          }
        }
      }

      // Filter compressed + skip known + skip burnt
      for (const item of items) {
        if (item.compression?.compressed !== true) continue;
        // Helius/DAS keeps returning burnt cNFTs (with `burnt: true`) for some time
        // after the leaf is removed. Skip them so they don't reappear in the album
        // during indexer lag — the local blacklist also handles this, but DAS-side
        // filtering is more reliable for cross-device installs.
        if (item.burnt === true || item.compression?.burnt === true) continue;
        if (knownMints && (knownMints.has(`cnft_${item.id}`) || knownMints.has(item.id))) continue;
        compressedItems.push(item);
      }

      // If this page returned fewer items than limit, no more pages
      if (items.length < DAS_PAGE_SIZE) break;

      dasPage++;
      data.result = null; // Free memory before next page
    } catch (e) {
      console.log('[cNFT] DAS fetch error:', e.message);
      break;
    }
  }

  // Update cached total from DAS page 1 response (authoritative)
  if (_dasTotalFromPage1 !== null) {
    _lastDasTotal = _dasTotalFromPage1;
  }

  if (compressedItems.length === 0) {
    // Don't set cooldown on failure — allow immediate retry
    console.log('[cNFT] No new compressed NFTs to process');
    return [];
  }

  // Only set cooldown after a successful fetch with results
  _lastDasTotalTs = Date.now();
  if (_lastDasTotal !== null) saveDasCache(walletAddress, _lastDasTotal, _lastDasTotalTs);

  // Cap to MAX_CNFT_METADATA_PER_CALL
  if (compressedItems.length > MAX_CNFT_METADATA_PER_CALL) {
    console.log(`[cNFT] Capping metadata fetch to ${MAX_CNFT_METADATA_PER_CALL} of ${compressedItems.length} to prevent OOM`);
    compressedItems = compressedItems.slice(0, MAX_CNFT_METADATA_PER_CALL);
  }
  console.log('[cNFT] Compressed items to process:', compressedItems.length);

  try {

    // Process each cNFT — fetch metadata in parallel batches for speed
    const cNFTs = [];
    const processItem = async (item) => {
      let imageUrl = item.content?.links?.image || item.content?.files?.[0]?.uri || '';
      if (imageUrl && imageUrl.startsWith('ipfs://')) imageUrl = 'https://ipfs.io/ipfs/' + imageUrl.slice(7);
      const metadataUrl = item.content?.json_uri || '';

      // Fetch full metadata JSON from json_uri (DAS inline attributes are often empty/truncated)
      let metadataJson = null;
      if (metadataUrl) {
        try {
          const cidMatch = metadataUrl.match(/ipfs\/([a-zA-Z0-9]+)/);
          const cid = cidMatch ? cidMatch[1] : null;
          const gateways = cid ? [
            `https://nftstorage.link/ipfs/${cid}`,
            `https://gateway.pinata.cloud/ipfs/${cid}`,
            `https://ipfs.io/ipfs/${cid}`,
          ] : [metadataUrl];

          for (const gateway of gateways) {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 6000);
              const metaResponse = await fetch(gateway, {
                signal: controller.signal,
                redirect: 'follow',
              });
              clearTimeout(timeoutId);
              if (metaResponse.ok) {
                // Skip huge metadata (on-chain NFTs embed full JPEG as data URI → ~6MB JSON → OOM)
                const contentLen = parseInt(metaResponse.headers.get('content-length') || '0', 10);
                if (contentLen > 512 * 1024) {
                  console.log('[cNFT] Metadata too large (' + Math.round(contentLen / 1024) + 'KB), skipping parse');
                  break;
                }
                // Try JSON parse — encrypted metadata will fail here gracefully
                let text = null;
                try {
                  text = await metaResponse.text();
                } catch (_textErr) {
                  console.log('[cNFT] Metadata text() failed (OOM?):', _textErr?.message);
                  break;
                }
                if (text && text.length > 512 * 1024) {
                  console.log('[cNFT] Metadata text too large (' + Math.round(text.length / 1024) + 'KB), skipping parse');
                  text = null;
                  break;
                }
                if (text) {
                  try {
                    metadataJson = JSON.parse(text);
                  } catch (_parseErr) {
                    // Encrypted metadata blob — can't parse without keys
                    console.log('[cNFT] Metadata at', gateway.slice(0, 50), 'is not JSON (likely encrypted)');
                    metadataJson = null;
                  }
                }
                text = null; // free memory
                if (metadataJson) {
                  // Strip huge data URIs from parsed metadata to prevent OOM downstream
                  if (metadataJson.image && metadataJson.image.startsWith('data:') && metadataJson.image.length > 50000) {
                    metadataJson.image = null;
                  }
                  if (!imageUrl && metadataJson.image) {
                    imageUrl = metadataJson.image;
                  }
                  break;
                }
              }
            } catch (gwErr) {
              // Try next gateway
            }
          }
        } catch (metaErr) {
          // Non-critical — will use DAS inline attributes
        }
      }

      // Extract attributes from full metadata JSON first, fall back to DAS inline
      const attrs = (metadataJson && Array.isArray(metadataJson.attributes))
        ? metadataJson.attributes
        : (item.content?.metadata?.attributes || []);
      const getAttr = (traitName) => {
        const a = attrs.find(at => at.trait_type === traitName);
        return a ? a.value : null;
      };
      const editionRaw = getAttr('Edition');
      const edition = editionRaw ? String(editionRaw).toLowerCase() : null;
      // Extract encryption keys from full metadata properties FIRST (needed for encrypted detection)
      let encryptionData = null;
      const encProps = (metadataJson && metadataJson.properties && metadataJson.properties.encryption) ? metadataJson.properties.encryption : {};
      if (hasUsableWrappedEncryptionPayload(encProps)) {
        encryptionData = { wrappedKey: encProps.wrappedKey, wrapNonce: encProps.wrapNonce, ...(encProps.nonce ? { nonce: encProps.nonce } : {}), ...(encProps.thumbnailNonce ? { thumbnailNonce: encProps.thumbnailNonce } : {}), ...(encProps.thumbnailUrl ? { thumbnailUrl: encProps.thumbnailUrl } : {}) };
      }
      // Read on-chain Storage attribute (authoritative for cross-device detection)
      const storageAttr = getAttr('Storage');
      const originalImgUrl = (metadataJson && metadataJson.image) ? metadataJson.image : imageUrl;
      const storageType = storageAttr === 'StealthCloud' ? 'cloud' : storageAttr === 'Arweave' ? 'arweave' : storageAttr === 'Embedded SVG' ? 'onchain' : storageAttr === 'IPFS' ? 'ipfs' : (originalImgUrl && (originalImgUrl.includes('stealthlynk.io') || originalImgUrl.includes('stealthcloud'))) ? 'cloud' : (originalImgUrl && originalImgUrl.startsWith('data:')) ? 'onchain' : (originalImgUrl && (originalImgUrl.includes('akrd.net') || originalImgUrl.includes('arweave.net'))) ? 'arweave' : 'ipfs';
      // Detect encrypted NFTs
      const encryptedFromAttr = isExplicitlyTrue(getAttr('Encrypted'));
      const encryptedFromFileType = (item.content?.files?.[0]?.mime === 'application/octet-stream') || (item.content?.files?.[0]?.type === 'application/octet-stream');
      const encryptedFromProps = isExplicitlyTrue(encProps.encrypted);
      const encryptedFromKeys = hasUsableWrappedEncryptionPayload(encryptionData);
      const metadataFetchFailed = !metadataJson;
      let isEncrypted = encryptedFromAttr || encryptedFromProps || encryptedFromKeys || (encryptedFromFileType && storageType === 'cloud');
      if (!isEncrypted && metadataFetchFailed && item.compression?.tree === PHOTOLYNK_MERKLE_TREE) {
        // Metadata JSON at json_uri couldn't be parsed — for our Merkle tree this means
        // the blob is encrypted (unencrypted PhotoLynk metadata always parses as valid JSON).
        isEncrypted = true;
      }
      // Extract proof hashes FIRST (needed for PhotoLynk ecosystem detection)
      const contentHash = getAttr('Content Hash') || null;
      const exifHash = getAttr('EXIF Hash') || null;
      // Exclude NFTs with "PhotoLynk" in name (app screenshots, not certified photos)
      const nameExcludesEcosystem = item.content?.metadata?.name?.toLowerCase().includes('photolynk');
      const isPhotoLynkEcosystem = !nameExcludesEcosystem && (!!(contentHash && exifHash) || item.compression?.tree === PHOTOLYNK_MERKLE_TREE);
      // NOW set certificationMode (needs isEncrypted AND isPhotoLynkEcosystem)
      const certModeRaw = getAttr('Certification Mode');
      const certificationMode = certModeRaw ? String(certModeRaw).toLowerCase() : (edition === 'limited' ? 'private' : edition === 'open' ? 'public' : (isEncrypted && isPhotoLynkEcosystem) ? 'private' : null);
      const isWatermarked = getAttr('Watermarked') === 'true';
      const licenseVal = getAttr('License') || null;
      if (metadataJson && metadataJson.image && !imageUrl) imageUrl = metadataJson.image;
      // Convert ipfs:// scheme to gateway URL (old NFTs may store raw ipfs:// URIs in metadata)
      if (imageUrl && imageUrl.startsWith('ipfs://')) imageUrl = 'https://nftstorage.link/ipfs/' + imageUrl.replace(/^ipfs:\/\/(ipfs\/)?/, '');

      // Extract remaining proof hashes + flags to top-level fields (survive metadata/attributes stripping)
      const exifRawHash = getAttr('EXIF Raw Hash') || null;
      const exifBindingHash = getAttr('EXIF Binding Hash') || null;
      const hasRfc3161 = !!(getAttr('RFC 3161 Timestamp') || (metadataJson?.properties?.certificate?.rfc3161?.tsaTokenBase64));
      const hasC2pa = !!(getAttr('C2PA Provenance') || metadataJson?.properties?.c2pa);
      const metaCert = metadataJson?.properties?.certificate;
      const mintedAt = metaCert?.mintedAt || (item.created_at ? new Date(item.created_at * 1000).toISOString() : null);
      const creatorWallet = (item.authorities?.filter(a => a.scopes?.includes('full')) || [])[0]?.address || item.creators?.[0]?.address || null;

      // Use actual on-chain owner, not query wallet (prevents importing transferred NFTs)
      const actualOwner = item.ownership?.owner || walletAddress;

      return {
        mintAddress: `cnft_${item.id}`,
        assetId: item.id,
        name: item.content?.metadata?.name || 'Compressed Proof',
        description: item.content?.metadata?.description || '',
        imageUrl,
        arweaveUrl: imageUrl,
        metadataUrl,
        ownerAddress: actualOwner,
        createdAt: mintedAt || new Date().toISOString(),
        discoveredAt: new Date().toISOString(),
        mintedAt: mintedAt || undefined,
        source: 'das',
        isCompressed: true,
        merkleTree: item.compression?.tree,
        edition,
        certificationMode,
        encrypted: isEncrypted,
        watermarked: isWatermarked,
        license: licenseVal,
        storageType,
        encryptionData,
        thumbnailUrl: encProps.thumbnailUrl || null,
        contentHash,
        exifHash,
        exifRawHash,
        exifBindingHash,
        hasRfc3161,
        hasC2pa,
        creatorWallet,
        attributes: attrs,
        metadata: metadataJson || null,
      };
    };

    // Process in parallel batches of 3 (avoid 429 rate limits on IPFS gateways)
    for (let i = 0; i < compressedItems.length; i += 3) {
      const batch = compressedItems.slice(i, i + 3);
      const results = await Promise.all(batch.map(processItem));
      cNFTs.push(...results);
      if (i + 3 < compressedItems.length) {
        console.log(`[cNFT] Processed ${Math.min(i + 3, compressedItems.length)}/${compressedItems.length} cNFTs`);
        await new Promise(r => setTimeout(r, 200)); // Small delay between batches
      }
    }

    console.log('[cNFT] Compressed NFTs found:', cNFTs.length);
    return cNFTs;
  } catch (e) {
    console.error('[cNFT] fetchCompressedNFTs error:', e.message);
    return [];
  }
};

/**
 * Fetch NFT metadata from Metaplex
 * @param {string} mintAddress - NFT mint address
 * @returns {Object|null} Metadata object or null
 */
export const fetchNFTMetadata = async (mintAddress, encryptionData = null, masterKey = null, fallbackMasterKey = null) => {
  if (!connection) return null;

  try {
    const mintPubkey = new PublicKey(mintAddress);

    // Derive metadata PDA
    const metadataAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mintPubkey.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    )[0];

    const accountInfo = await connection.getAccountInfo(metadataAccount);
    if (!accountInfo) return null;

    // Parse metadata (simplified - just get the URI)
    const data = accountInfo.data;
    // Skip to name (after key byte and update authority)
    let offset = 1 + 32 + 32; // key + updateAuthority + mint

    // Read name length and name
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '');
    offset += nameLen;

    // Read symbol length and symbol
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    offset += symbolLen; // Skip symbol

    // Read URI length and URI
    const uriLen = data.readUInt32LE(offset);
    offset += 4;
    const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '');

    // Fetch JSON metadata from URI
    if (uri) {
      try {
        console.log(`[NFT] Fetching JSON from: ${uri}`);
        const response = await axios.get(uri, { timeout: 10000, responseType: 'arraybuffer', maxContentLength: 512 * 1024 });
        const rawBytes = new Uint8Array(response.data);

        // Skip huge metadata (on-chain NFTs embed full JPEG as data URI → ~6MB → OOM)
        if (rawBytes.length > 512 * 1024) {
          console.log('[NFT] Metadata too large (' + Math.round(rawBytes.length / 1024) + 'KB), returning basic info');
          return { name, uri };
        }

        // Try parsing as JSON first (unencrypted metadata)
        let metaJson = null;
        try {
          const text = new TextDecoder().decode(rawBytes);
          metaJson = JSON.parse(text);
          // Strip huge data URIs to prevent OOM downstream
          if (metaJson.image && metaJson.image.startsWith('data:') && metaJson.image.length > 50000) {
            metaJson.image = null;
          }
        } catch (_jsonErr) {
          // Not valid JSON — may be encrypted metadata
          if (encryptionData?.metadataNonce && masterKey) {
            console.log('[NFT] Metadata not JSON, attempting decryption...');
            metaJson = decryptMetadataJSON(rawBytes, encryptionData, masterKey, fallbackMasterKey);
            if (metaJson) {
              console.log('[NFT] Metadata decrypted successfully');
            } else {
              console.log('[NFT] Metadata decryption failed (wrong key or corrupted)');
            }
          } else {
            console.log('[NFT] Metadata is encrypted but no decryption keys available');
          }
        }

        if (metaJson) {
          const imageUrl = metaJson.image || '';
          console.log(`[NFT] Image URL: ${imageUrl || '(empty)'}`);
          return {
            name: metaJson.name || name,
            description: metaJson.description || '',
            image: imageUrl,
            uri,
            attributes: metaJson.attributes || [],
            properties: metaJson.properties || {},
          };
        }

        return { name, uri, encrypted: true };
      } catch (e) {
        console.log(`[NFT] JSON fetch failed: ${e.message}`);
        return { name, uri };
      }
    }

    return { name, uri };
  } catch (e) {
    console.log(`[NFT] Metadata fetch failed for ${mintAddress}:`, e.message);
    return null;
  }
};

/**
 * Discover and import NFTs from blockchain to local storage
 * @param {string} walletAddress - Owner's wallet address
 * @param {string} serverUrl - Server URL for sync
 * @param {Object} authHeaders - Auth headers for server
 * @returns {Object} { success, imported, total, error }
 */
export const discoverAndImportNFTs = async (walletAddress, serverUrl = null, authHeaders = null) => {
  if (_mintingInProgress) {
    console.log('[NFT] discoverAndImportNFTs skipped — minting in progress');
    return { success: true, imported: 0, total: 0, skipped: true };
  }

  // Global lock: if another discover call is already running, piggyback on it
  if (_discoverInFlight) {
    console.log('[NFT] discoverAndImportNFTs — already in flight, waiting for existing call');
    return _discoverInFlight;
  }

  const run = async () => {
    try {
      return await _discoverAndImportNFTsImpl(walletAddress, serverUrl, authHeaders);
    } finally {
      _discoverInFlight = null;
    }
  };
  _discoverInFlight = run();
  return _discoverInFlight;
};

const _discoverAndImportNFTsImpl = async (walletAddress, serverUrl = null, authHeaders = null) => {
  console.log('[NFT] discoverAndImportNFTs called for:', walletAddress);

  // Build set of known mint addresses to skip re-fetching metadata
  const localNFTs = await getStoredNFTs();
  const knownMints = new Set();
  for (const n of localNFTs) {
    if (n.mintAddress) knownMints.add(n.mintAddress);
    // Also add raw mint (without cnft_ prefix) for standard NFT matching
    if (n.mintAddress?.startsWith('cnft_')) knownMints.add(n.mintAddress.replace(/^cnft_/, ''));
  }
  try {
    const bl = await getTransferredOutBlacklist();
    for (const id of bl) knownMints.add(id);
  } catch (_) { }
  console.log(`[NFT] ${knownMints.size} known mints in local storage — will skip metadata fetch for these`);

  const result = await fetchNFTsFromBlockchain(walletAddress, knownMints);
  console.log('[NFT] fetchNFTsFromBlockchain result:', result.success, result.error || `${result.nfts?.length} NFTs`);

  if (!result.success) {
    return { success: false, error: result.error, imported: 0, total: 0 };
  }

  const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
  // Deduplicate stored NFTs (bad syncs can leave duplicates causing React key warnings)
  // Reuse localNFTs already read above for knownMints (avoid double file read)
  const seenMints = new Set();
  const existingNFTs = localNFTs.filter(n => {
    const k = normMint(n.mintAddress);
    if (!k || seenMints.has(k)) return false;
    seenMints.add(k);
    return true;
  });
  const existingMap = {};
  const existingMetaMap = {};
  existingNFTs.forEach((n, i) => {
    if (n.mintAddress) existingMap[normMint(n.mintAddress)] = n;
    if (n.metadataUrl) existingMetaMap[n.metadataUrl] = { nft: n, idx: i };
  });

  let imported = 0;
  let updated = 0;
  let skippedNotOwned = 0;
  const newCertNFTs = []; // Track NFTs that need certificates (all editions)
  const newNFTs = []; // Batch new NFTs for single write
  const normalizeAddr = (a) => a ? String(a).trim().toLowerCase() : '';
  const walletNorm = normalizeAddr(walletAddress);

  for (const nft of result.nfts) {
    // Skip NFTs you don't own (prevents importing transferred NFTs during rescan)
    if (nft.ownerAddress && normalizeAddr(nft.ownerAddress) !== walletNorm) {
      skippedNotOwned++;
      continue;
    }
    // Skip embedded/on-chain cNFTs (giant data: URI SVGs — can't display, wastes storage)
    const isCompressed = nft.isCompressed || String(nft.mintAddress || '').startsWith('cnft_');
    if (isCompressed) {
      const img = nft.imageUrl || nft.arweaveUrl || '';
      if (nft.storageType === 'onchain' || (img.startsWith('data:') && img.length > 50000)) {
        console.log('[NFT] Skipping embedded on-chain cNFT:', nft.name || nft.mintAddress);
        continue;
      }
      // Skip non-PhotoLynk ecosystem cNFTs (only keep Public/Private IPFS certified cNFTs)
      if (!isPhotoLynkEcosystem(nft)) {
        console.log('[NFT] Skipping non-ecosystem cNFT:', nft.name || nft.mintAddress);
        continue;
      }
    }

    const existing = existingMap[normMint(nft.mintAddress)];
    if (!existing) {
      // Check if a tx_ temp entry exists with same metadataUrl — replace it instead of adding duplicate
      const mintStr = String(nft.mintAddress || '');
      if (nft.metadataUrl && !mintStr.startsWith('tx_') && !mintStr.startsWith('cnft_tx_') && existingMetaMap[nft.metadataUrl]) {
        const { nft: oldEntry, idx: oldIdx } = existingMetaMap[nft.metadataUrl];
        const oldMint = String(oldEntry?.mintAddress || '');
        if (oldEntry && (oldMint.startsWith('tx_') || oldMint.startsWith('cnft_tx_'))) {
          // Merge encryptionData/thumbnailUrl from temp entry into real entry
          if (oldEntry.encryptionData && !nft.encryptionData) nft.encryptionData = oldEntry.encryptionData;
          if (oldEntry.thumbnailUrl && !nft.thumbnailUrl) nft.thumbnailUrl = oldEntry.thumbnailUrl;
          if (oldEntry.edition && !nft.edition) nft.edition = oldEntry.edition;
          if (oldEntry.certificationMode && !nft.certificationMode) nft.certificationMode = oldEntry.certificationMode;
          if ((oldEntry.encrypted || hasUsableWrappedEncryptionPayload(oldEntry.encryptionData)) && !nft.encrypted) nft.encrypted = true;
          if (oldEntry.imageUrl && !nft.imageUrl) nft.imageUrl = oldEntry.imageUrl;
          existingNFTs[oldIdx] = nft;
          existingMap[normMint(nft.mintAddress)] = nft;
          existingMetaMap[nft.metadataUrl] = { nft, idx: oldIdx };
          updated++;
          console.log('[NFT] Replaced temp tx_ entry with real cnft_ for:', nft.name);
          newCertNFTs.push(nft);
          continue;
        }
      }
      if (!nft.discoveredAt) nft.discoveredAt = new Date().toISOString();
      newNFTs.push(nft);
      imported++;
      if (isPhotoLynkEcosystem(nft)) newCertNFTs.push(nft);
    } else {
      // Merge missing fields from blockchain into existing local NFT
      let changed = false;
      if (nft.edition && !existing.edition) { existing.edition = nft.edition; changed = true; }
      if (nft.certificationMode && !existing.certificationMode) { existing.certificationMode = nft.certificationMode; changed = true; }
      const nftHasEncPayload = hasUsableWrappedEncryptionPayload(nft.encryptionData);
      const existingHasEncPayload = hasUsableWrappedEncryptionPayload(existing.encryptionData);
      if ((nft.encrypted || nftHasEncPayload) && !existing.encrypted) { existing.encrypted = true; changed = true; }
      else if (!nft.encrypted && !nftHasEncPayload && existing.encrypted && !existingHasEncPayload) { existing.encrypted = false; changed = true; }
      if (nft.watermarked && !existing.watermarked) { existing.watermarked = nft.watermarked; changed = true; }
      if (nft.license && !existing.license) { existing.license = nft.license; changed = true; }
      if (nft.storageType && (!existing.storageType || (existing.storageType === 'ipfs' && nft.storageType !== 'ipfs'))) { existing.storageType = nft.storageType; changed = true; }
      if (nft.encryptionData) { if (!existing.encryptionData) { existing.encryptionData = nft.encryptionData; } else { for (const [ek, ev] of Object.entries(nft.encryptionData)) { if (ev != null && ev !== '' && (existing.encryptionData[ek] == null || existing.encryptionData[ek] === '')) { existing.encryptionData[ek] = ev; } } } changed = true; }
      if (nft.thumbnailUrl && !existing.thumbnailUrl) { existing.thumbnailUrl = nft.thumbnailUrl; changed = true; }
      if (nft.imageUrl && !existing.imageUrl) { existing.imageUrl = nft.imageUrl; changed = true; }
      if (nft.metadata && !existing.metadata) { existing.metadata = nft.metadata; changed = true; }
      if (nft.attributes?.length && !existing.attributes?.length) { existing.attributes = nft.attributes; changed = true; }
      if (nft.contentHash && !existing.contentHash) { existing.contentHash = nft.contentHash; changed = true; }
      if (nft.exifHash && !existing.exifHash) { existing.exifHash = nft.exifHash; changed = true; }
      if (nft.exifRawHash && !existing.exifRawHash) { existing.exifRawHash = nft.exifRawHash; changed = true; }
      if (nft.exifBindingHash && !existing.exifBindingHash) { existing.exifBindingHash = nft.exifBindingHash; changed = true; }
      if (nft.hasRfc3161 && !existing.hasRfc3161) { existing.hasRfc3161 = true; changed = true; }
      if (nft.hasC2pa && !existing.hasC2pa) { existing.hasC2pa = true; changed = true; }
      if (nft.creatorWallet && !existing.creatorWallet) { existing.creatorWallet = nft.creatorWallet; changed = true; }
      if (nft.mintedAt && !existing.mintedAt) { existing.mintedAt = nft.mintedAt; changed = true; }
      if (changed) updated++;
      // Track ecosystem NFTs that may need a cert generated
      if (nft.edition && isPhotoLynkEcosystem({ ...existing, ...nft })) {
        newCertNFTs.push({ ...existing, ...nft });
      }
    }
  }

  // Single batch write: append new NFTs + save updated existing NFTs
  if (imported > 0 || updated > 0) {
    existingNFTs.push(...newNFTs);
    await saveNFTsToFile(existingNFTs);
    console.log(`[NFT] Saved ${imported} new + ${updated} updated NFTs in single write`);

    if (serverUrl && authHeaders) {
      try {
        await backupNFTsToServer(serverUrl, authHeaders, walletAddress);
        console.log('[NFT] Backed up rediscovered NFTs to server');
      } catch (backupErr) {
        console.warn('[NFT] Failed to back up rediscovered NFTs to server:', backupErr?.message);
      }
    }
  }

  // Auto-generate certificates for ALL NFTs that don't have one yet
  if (newCertNFTs.length > 0) {
    try {
      const existingCerts = await getStoredCertificates();
      const certMints = new Set(existingCerts.map(c => normMint(c.mintAddress)));
      let certsGenerated = 0;
      for (const nft of newCertNFTs) {
        const mint = normMint(nft.mintAddress);
        if (mint && !certMints.has(mint)) {
          try {
            const cert = generateCertificate(nft);
            if (cert) {
              await saveCertificate(cert, serverUrl, authHeaders);
              certMints.add(mint);
              certsGenerated++;
            }
          } catch (certErr) {
            console.warn('[NFT] Auto-cert generation failed for', mint, ':', certErr?.message);
          }
        }
      }
      if (certsGenerated > 0) {
        console.log(`[NFT] Auto-generated ${certsGenerated} certificates for limited edition NFTs`);
      }
    } catch (certErr) {
      console.warn('[NFT] Certificate auto-generation sweep failed:', certErr?.message);
    }
  }

  console.log(`[NFT] Imported ${imported} new, updated ${updated} existing, out of ${result.nfts.length} found`);

  return {
    success: true,
    imported,
    updated,
    total: result.nfts.length,
    nfts: result.nfts,
  };
};

// ============================================================================
// CERTIFICATES OF AUTHENTICITY (CoA) — Limited Edition
// ============================================================================

const CERTIFICATES_STORAGE_KEY = 'photolynk_nft_certificates';
const CERTIFICATES_STORAGE_FILE = `${FileSystem.documentDirectory}photolynk_nft_certificates.json`;
const CERT_DATA_DIR = `${FileSystem.documentDirectory}cert_data/`;

// Heavy fields that bloat the main index — stored in separate per-cert files
const HEAVY_FIELDS = ['rfc3161Token', 'c2paManifest'];
let _certOOMCount = 0; // OOM guard: stop retrying after repeated failures
const MAX_OOM_RETRIES = 3;
let _compactionDone = false; // one-time compaction flag per session

const ensureCertDataDir = async () => {
  try {
    const info = await FileSystem.getInfoAsync(CERT_DATA_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(CERT_DATA_DIR, { intermediates: true });
  } catch (_) { }
};

const certDataPath = (certId, field) => `${CERT_DATA_DIR}${certId}_${field}.json`;

// Check whether the externalized heavy-field files actually exist on disk for a cert.
// Returns { rfc3161Token: bool, c2paManifest: bool }
export const hasCertHeavyFieldsOnDisk = async (certId) => {
  const result = {};
  for (const f of HEAVY_FIELDS) {
    try {
      const info = await FileSystem.getInfoAsync(certDataPath(certId, f));
      result[f] = !!(info.exists && info.size && info.size > 10);
    } catch (_) { result[f] = false; }
  }
  return result;
};

const externalizeCertHeavyFields = async (cert) => {
  if (!cert || !cert.id) return cert;
  await ensureCertDataDir();
  const slim = { ...cert };
  for (const f of HEAVY_FIELDS) {
    if (cert[f]) {
      try {
        await FileSystem.writeAsStringAsync(certDataPath(cert.id, f), JSON.stringify(cert[f]));
      } catch (e) {
        console.warn(`[NFT] Failed to externalize ${f} for ${cert.id}:`, e?.message);
      }
      delete slim[f];
    }
  }
  // Set canonical boolean flags (used by UI for badge display without loading heavy data)
  if (cert.rfc3161Token || cert.hasRfc3161) slim.hasRfc3161 = true;
  if (cert.c2paManifest || cert.hasC2pa) slim.hasC2pa = true;
  return slim;
};

const loadCertHeavyField = async (certId, field) => {
  try {
    const path = certDataPath(certId, field);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(path);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
};

const compactCertificatesFile = async () => {
  if (_compactionDone) return;
  try {
    const info = await FileSystem.getInfoAsync(CERTIFICATES_STORAGE_FILE);
    if (!info.exists) { _compactionDone = true; return; }
    // Only compact if file > 2MB (healthy index should be <1MB for 500 certs)
    if (info.size && info.size < 2 * 1024 * 1024) { _compactionDone = true; return; }
    console.log(`[NFT] Certificate file is ${(info.size / 1024 / 1024).toFixed(1)}MB — compacting...`);
    // If file is >20MB, skip compaction entirely (reading it for compaction would OOM).
    // Keep the file — a bloated file is better than no file when device is offline.
    if (info.size && info.size > 20 * 1024 * 1024) {
      console.warn(`[NFT] Certificate file too large (${(info.size / 1024 / 1024).toFixed(1)}MB) — skipping compaction, will try server sync instead`);
      _compactionDone = true;
      return;
    }
    const raw = await FileSystem.readAsStringAsync(CERTIFICATES_STORAGE_FILE);
    const certs = raw ? JSON.parse(raw) : [];
    await ensureCertDataDir();
    let externalized = 0;
    const slim = [];
    for (const cert of certs) {
      const s = await externalizeCertHeavyFields(cert);
      slim.push(s);
      if (cert.rfc3161Token || cert.c2paManifest) externalized++;
    }
    await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(slim));
    const newInfo = await FileSystem.getInfoAsync(CERTIFICATES_STORAGE_FILE);
    console.log(`[NFT] Compacted certificates: ${externalized} heavy fields extracted, file now ${((newInfo.size || 0) / 1024 / 1024).toFixed(1)}MB`);
    _compactionDone = true;
    _certOOMCount = 0; // reset OOM counter after successful compaction
  } catch (e) {
    const isOOM = e?.message?.includes('OutOfMemoryError') || e?.message?.includes('allocate');
    if (isOOM) {
      // Compaction OOM'd — keep the file intact (device may be offline, can't rebuild from server).
      // The raw file read in getStoredCertificates uses less memory than compaction and may succeed.
      console.warn('[NFT] Certificate compaction OOM — skipping compaction, keeping file intact');
    } else {
      console.warn('[NFT] Certificate compaction failed:', e?.message);
    }
    _compactionDone = true;
  }
};

/**
 * Generate a Certificate of Authenticity JSON for a certified NFT
 * @param {Object} nftData - Minted NFT data from saveNFTToStorage
 * @returns {Object} Certificate object
 */
export const generateCertificate = (nftData) => {
  if (!nftData) return null;
  // Only generate certificates for NFTs created within the PhotoLynk ecosystem
  // External NFTs (Bored Apes, DeGods, etc.) must never get PhotoLynk proofs
  if (!nftData.forceGenerate && !isPhotoLynkEcosystem(nftData)) return null;
  // Only generate certificates for NFTs with Public/Private certification
  // Skip NFTs without certificationMode or edition (like 3rd party reference NFTs)
  if (!nftData.forceGenerate && !nftData.certificationMode && !nftData.edition) return null;
  // Skip temporary tx_ entries unless forceGenerate is set (post-mint immediate cert)
  if (!nftData.forceGenerate && nftData.mintAddress && String(nftData.mintAddress).startsWith('tx_')) return null;
  const cert = {
    id: `cert_${nftData.mintAddress || Date.now()}`,
    version: 1,
    type: 'PhotoLynk Certificate of Authenticity',
    edition: nftData.edition || 'limited',
    certificationMode: nftData.certificationMode || (nftData.edition === 'limited' ? 'private' : nftData.edition === 'open' ? 'public' : null),
    mintAddress: nftData.mintAddress,
    txSignature: nftData.txSignature,
    creatorWallet: nftData.ownerAddress,
    name: nftData.name,
    description: nftData.description,
    contentHash: null,
    exifRawHash: null,
    exifHash: null,
    exifBindingHash: null,
    license: nftData.license || 'arr',
    watermarked: !!nftData.watermarked,
    encrypted: !!nftData.encrypted,
    storageType: nftData.storageType,
    imageUrl: nftData.arweaveUrl || nftData.imageUrl,
    metadataUrl: nftData.metadataUrl,
    createdAt: nftData.createdAt || new Date().toISOString(),
    issuedAt: new Date().toISOString(),
  };

  // Extract hashes from attributes (check both metadata.attributes and top-level attributes)
  // Normalize: always include SHA256: prefix for consistency across platforms
  const ensureHashPrefix = (h) => h && !h.startsWith('SHA256:') ? `SHA256:${h}` : h;
  const attrs = nftData.metadata?.attributes || nftData.attributes || [];
  for (const attr of attrs) {
    if (attr.trait_type === 'Content Hash') cert.contentHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'EXIF Raw Hash') cert.exifRawHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'EXIF Hash') cert.exifHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'EXIF Binding Hash') cert.exifBindingHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'Camera Hash' && !cert.cameraHash) cert.cameraHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'License' && !cert.license) cert.license = attr.value;
  }

  // Fallback: use direct hash fields from nftData (metadata gets stripped on storage to prevent OOM)
  if (!cert.contentHash && nftData.contentHash) cert.contentHash = ensureHashPrefix(nftData.contentHash);
  if (!cert.exifRawHash && nftData.exifRawHash) cert.exifRawHash = ensureHashPrefix(nftData.exifRawHash);
  if (!cert.exifHash && nftData.exifHash) cert.exifHash = ensureHashPrefix(nftData.exifHash);
  if (!cert.exifBindingHash && nftData.exifBindingHash) cert.exifBindingHash = ensureHashPrefix(nftData.exifBindingHash);
  if (!cert.cameraHash && nftData.cameraHash) cert.cameraHash = ensureHashPrefix(nftData.cameraHash);

  // Extract RFC 3161 token and C2PA manifest from metadata certificate object
  const metaCert = nftData.metadata?.properties?.certificate;
  if (metaCert) {
    if (metaCert.rfc3161?.tsaTokenBase64) { cert.rfc3161Token = metaCert.rfc3161.tsaTokenBase64; cert.hasRfc3161 = true; }
    if (metaCert.rfc3161?.tsa) cert.rfc3161Tsa = metaCert.rfc3161.tsa;
    if (metaCert.mintedAt) cert.mintedAt = metaCert.mintedAt;
  }
  if (nftData.metadata?.properties?.c2pa) {
    cert.c2paManifest = nftData.metadata.properties.c2pa;
    cert.hasC2pa = true;
  }

  // Also check attributes for RFC3161/C2PA presence (fallback when metadata is stripped)
  const rfc3161Attr = attrs.find(a => a.trait_type === 'RFC 3161 Timestamp');
  const c2paAttr = attrs.find(a => a.trait_type === 'C2PA Provenance');
  if (rfc3161Attr && !cert.hasRfc3161) cert.hasRfc3161 = true;
  if (c2paAttr && !cert.hasC2pa) cert.hasC2pa = true;

  // Fallback: direct fields from nftData (nft-service / server sync returns these at top level)
  if (!cert.rfc3161Token && nftData.rfc3161Token) { cert.rfc3161Token = nftData.rfc3161Token; cert.hasRfc3161 = true; }
  if (!cert.rfc3161Tsa && nftData.rfc3161Tsa) cert.rfc3161Tsa = nftData.rfc3161Tsa;
  if (!cert.rfc3161Tsa && nftData.tsaUrl) cert.rfc3161Tsa = nftData.tsaUrl;
  if (!cert.hasRfc3161 && nftData.hasRfc3161) cert.hasRfc3161 = true;
  if (!cert.hasC2pa && nftData.hasC2pa) cert.hasC2pa = true;

  return cert;
};

/**
 * Save a certificate to local storage
 */
export const saveCertificate = async (cert, serverUrl = null, authHeaders = null) => {
  try {
    // Externalize heavy fields before saving to index
    const slimCert = await externalizeCertHeavyFields(cert);
    const certs = await getStoredCertificates();
    // Avoid duplicates
    const idx = certs.findIndex(c => c.id === cert.id);
    if (idx >= 0) {
      certs[idx] = slimCert;
    } else {
      certs.unshift(slimCert);
    }
    await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(certs));
    console.log('[NFT] Certificate saved:', cert.id);

    // Sync to server (best-effort, non-blocking) — strip large fields to avoid 413
    if (serverUrl && authHeaders) {
      try {
        const slim = { ...cert };
        delete slim.encryptionData;
        delete slim.metadata;
        await axios.post(`${serverUrl}/api/nft/certificates`, {
          action: 'add',
          certificate: slim,
        }, { headers: authHeaders, timeout: 10000 });
        console.log('[NFT] Certificate synced to server:', cert.id);
      } catch (syncErr) {
        console.log('[NFT] Certificate server sync failed (will retry later):', syncErr.message);
      }
    }

    return { success: true };
  } catch (e) {
    console.error('[NFT] Save certificate failed:', e.message);
    return { success: false, error: e.message };
  }
};

/**
 * Save all certificates to local storage (bulk write for enrichment)
 */
export const saveAllCertificates = async (certs) => {
  try {
    // Externalize heavy fields before bulk save
    const slim = [];
    for (const cert of certs) {
      slim.push(await externalizeCertHeavyFields(cert));
    }
    await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(slim));
    return { success: true };
  } catch (e) {
    console.error('[NFT] Bulk save certificates failed:', e.message);
    return { success: false, error: e.message };
  }
};

/**
 * Get all stored certificates
 */
export const getStoredCertificates = async () => {
  // OOM guard: if we've failed repeatedly, stop trying this session to avoid crash loops.
  // File is kept intact — server sync will compact it when network is available.
  if (_certOOMCount >= MAX_OOM_RETRIES) {
    console.warn(`[NFT] Certificate loading paused after ${_certOOMCount} OOM failures — waiting for server sync to compact`);
    return [];
  }
  try {
    const fileInfo = await FileSystem.getInfoAsync(CERTIFICATES_STORAGE_FILE);
    if (fileInfo.exists) {
      // Auto-compact if file is bloated (>2MB) — one-time per session
      if (!_compactionDone && fileInfo.size && fileInfo.size > 2 * 1024 * 1024) {
        await compactCertificatesFile();
      }
      const raw = await FileSystem.readAsStringAsync(CERTIFICATES_STORAGE_FILE);
      _certOOMCount = 0; // successful read resets counter
      return raw ? JSON.parse(raw) : [];
    }
    // One-time migration from SecureStore (if any data exists there)
    try {
      const legacyData = await SecureStore.getItemAsync(CERTIFICATES_STORAGE_KEY);
      if (legacyData) {
        const certs = JSON.parse(legacyData);
        await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, legacyData);
        await SecureStore.deleteItemAsync(CERTIFICATES_STORAGE_KEY);
        console.log('[NFT] Migrated', certs.length, 'certificates from SecureStore to FileSystem');
        return certs;
      }
    } catch (migErr) {
      console.warn('[NFT] Certificate migration failed:', migErr?.message);
    }
    return [];
  } catch (e) {
    const isOOM = e?.message?.includes('OutOfMemoryError') || e?.message?.includes('allocate');
    if (isOOM) {
      _certOOMCount++;
      console.warn(`[NFT] Certificate OOM #${_certOOMCount} — will ${_certOOMCount >= MAX_OOM_RETRIES ? 'pause loading' : 'try compaction next'}`);
      // Force compaction on next attempt
      if (_certOOMCount < MAX_OOM_RETRIES) _compactionDone = false;
    }
    console.warn('[NFT] Load certificates failed:', e?.message);
    return [];
  }
};

export const getCertificateFullData = async (certId, existingCert = null) => {
  if (!certId) return null;
  // Use pre-loaded cert if available (avoids re-reading the full index file)
  let cert = existingCert ? { ...existingCert } : null;
  const certs = await getStoredCertificates();
  const storedCert = certs.find(c => c.id === certId);
  if (storedCert) cert = cert ? { ...storedCert, ...cert } : { ...storedCert };
  if (!cert) return null;
  // Lazy-load heavy fields from external files
  for (const f of HEAVY_FIELDS) {
    if (!cert[f]) {
      const data = await loadCertHeavyField(certId, f);
      if (data) cert[f] = data;
    }
  }
  return cert;
};

/**
 * Sync certificates from server — merges remote into local, returns merged list
 */
export const syncCertificatesFromServer = async (serverUrl, authHeaders, walletAddress = '') => {
  if (_mintingInProgress) {
    console.log('[NFT] syncCertificatesFromServer skipped — minting in progress');
    return { success: true, merged: 0, skipped: true };
  }
  try {
    if (!serverUrl || !authHeaders) return { success: false, merged: 0 };
    const walletQuery = walletAddress ? `?walletAddress=${encodeURIComponent(walletAddress)}` : '';
    const res = await axios.get(`${serverUrl}/api/nft/certificates${walletQuery}`, { headers: authHeaders, timeout: 10000 });
    const remote = res.data?.certificates || [];
    if (remote.length === 0) return { success: true, merged: 0 };

    // Whitelist only lightweight fields — prevents writing bloated files that cause OOM on read.
    // Server should already send slim data, but defend against stale servers sending full certs.
    // Keep only lightweight fields — large binary blobs (rfc3161Token, c2paManifest,
    // metadata, encryptionData, imageData) are excluded to prevent OOM on mobile.
    // Boolean flags hasRfc3161/hasC2pa are derived below for badge display.
    const SLIM_KEYS = ['id', 'name', 'mintAddress', 'txSignature', 'creatorWallet', 'ownerAddress',
      'issuedAt', 'createdAt', 'edition', 'license', 'contentHash', 'exifHash', 'cameraHash',
      'exifRawHash', 'exifBindingHash', 'rfc3161Policy', 'mintedAt',
      'hasRfc3161', 'hasC2pa', 'encrypted', 'watermarked', 'storageType', 'nftType', 'isCompressed',
      'rfc3161Tsa', 'metadataUrl', 'description', 'version', 'type', 'imageUrl', 'certificationMode',
      'transferredFrom', 'transferredAt'];
    const slimRemote = remote.map(c => {
      const s = {};
      for (const k of SLIM_KEYS) { if (c[k] !== undefined) s[k] = c[k]; }
      if (c.rfc3161Token) s.hasRfc3161 = true;
      if (c.c2paManifest) s.hasC2pa = true;
      // Strip base64 data URIs from imageUrl — these can be megabytes each
      if (s.imageUrl && s.imageUrl.startsWith('data:') && s.imageUrl.length > 5000) delete s.imageUrl;
      return s;
    });

    // Check if local file is readable — if OOM, replace entirely with slim remote data
    let local = [];
    let localOOM = false;
    try {
      const fileInfo = await FileSystem.getInfoAsync(CERTIFICATES_STORAGE_FILE);
      if (fileInfo.exists && fileInfo.size && fileInfo.size > 10 * 1024 * 1024) {
        // File >10MB — don't even try to read, it will OOM. Replace with slim remote data.
        console.warn(`[NFT] Certificate file is ${(fileInfo.size / 1024 / 1024).toFixed(1)}MB — too large to read, replacing with slim server data`);
        localOOM = true;
      } else {
        local = await getStoredCertificates();
      }
    } catch (_) {
      localOOM = true;
    }

    let merged = 0;
    let result;
    if (localOOM || local.length === 0) {
      // Local unreadable or empty — use slim remote data directly
      result = slimRemote;
      merged = slimRemote.length;
      console.log('[NFT] Rebuilding certificate file from server:', slimRemote.length, 'slim certs');
    } else {
      // Normal merge path
      const localMap = {};
      for (const c of local) { if (c.id) localMap[c.id] = c; }
      const MERGE_FIELDS = ['rfc3161Tsa', 'contentHash', 'exifRawHash', 'exifHash', 'exifBindingHash', 'cameraHash',
        'hasRfc3161', 'hasC2pa', 'metadataUrl', 'description', 'storageType', 'encrypted', 'watermarked', 'license',
        'transferredFrom', 'transferredAt', 'ownerAddress'];
      for (const c of slimRemote) {
        if (!localMap[c.id]) {
          local.push(c);
          localMap[c.id] = c;
          merged++;
        } else {
          const lc = localMap[c.id];
          for (const k of MERGE_FIELDS) {
            if (!lc[k] && c[k]) { lc[k] = c[k]; merged++; }
          }
        }
      }
      result = local;
    }

    if (merged > 0) {
      result.sort((a, b) => new Date(b.createdAt || b.issuedAt || 0) - new Date(a.createdAt || a.issuedAt || 0));
      // Externalize any remaining heavy fields before writing index
      const slim = [];
      for (const cert of result) {
        slim.push(await externalizeCertHeavyFields(cert));
      }
      const json = JSON.stringify(slim);
      console.log(`[NFT] Writing certificate index: ${slim.length} certs, ${(json.length / 1024).toFixed(0)}KB`);
      await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, json);
      // Reset OOM counter — file is now small enough to read
      _certOOMCount = 0;
      console.log('[NFT] Synced', merged, 'new certificates/fields from server');
    }
    return { success: true, merged };
  } catch (e) {
    console.warn('[NFT] Certificate server sync failed:', e?.message);
    return { success: false, merged: 0, error: e?.message };
  }
};

/**
 * Backup all local certificates to server
 */
export const backupCertificatesToServer = async (serverUrl, authHeaders) => {
  if (_mintingInProgress) {
    console.log('[NFT] backupCertificatesToServer skipped — minting in progress');
    return { success: true, backed: 0, skipped: true };
  }
  try {
    if (!serverUrl || !authHeaders) return { success: false };
    const certs = await getStoredCertificates();
    if (certs.length === 0) return { success: true };
    // Keep only essential fields to stay under reverse-proxy body limit (~1MB)
    // IMPORTANT: Do NOT include rfc3161Token or c2paManifest — they bloat the server file
    // and cause OOM on mobile when synced back. Only send boolean flags + lightweight fields.
    // Keep all cert fields EXCEPT large binary blobs (metadata, encryptionData, imageData)
    // rfc3161Token + c2paManifest are actual proof certificates — must be preserved
    const KEEP_KEYS = ['id', 'name', 'mintAddress', 'txSignature', 'creatorWallet', 'ownerAddress',
      'issuedAt', 'createdAt', 'edition', 'license', 'contentHash', 'exifHash', 'cameraHash',
      'exifRawHash', 'exifBindingHash', 'rfc3161Policy', 'mintedAt',
      'hasRfc3161', 'hasC2pa', 'encrypted', 'watermarked', 'storageType', 'nftType', 'isCompressed',
      'rfc3161Tsa', 'metadataUrl', 'description', 'version', 'type', 'imageUrl', 'certificationMode',
      'transferredFrom', 'transferredAt',
      'rfc3161Token', 'c2paManifest'];
    const slim = certs.map(c => {
      const copy = {};
      for (const k of KEEP_KEYS) { if (c[k] !== undefined) copy[k] = c[k]; }
      return copy;
    });
    // Send one cert at a time to stay under proxy body limit
    let backed = 0;
    for (const cert of slim) {
      try {
        await axios.post(`${serverUrl}/api/nft/certificates`, {
          action: 'backup', certificates: [cert],
        }, { headers: authHeaders, timeout: 10000 });
        backed++;
      } catch (e) {
        // Skip silently — will retry next sync
      }
    }
    console.log('[NFT] Backed up', backed, '/', certs.length, 'certificates to server');
    return { success: true };
  } catch (e) {
    console.warn('[NFT] Certificate backup failed:', e?.message);
    return { success: false, error: e?.message };
  }
};

/**
 * Remove a certificate by ID
 */
export const removeCertificate = async (certId) => {
  try {
    const certs = await getStoredCertificates();
    const filtered = certs.filter(c => c.id !== certId);
    await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(filtered));
    // Clean up externalized heavy field files
    for (const f of HEAVY_FIELDS) {
      try { await FileSystem.deleteAsync(certDataPath(certId, f), { idempotent: true }); } catch (_) { }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

export const removeCertificateByMint = async (mintAddress) => {
  try {
    const certs = await getStoredCertificates();
    const normalizedMint = (mintAddress || '').replace('cnft_', '');
    const removed = [];
    const filtered = certs.filter(c => {
      const cMint = (c.mintAddress || '').replace('cnft_', '');
      if (cMint === normalizedMint) { removed.push(c.id); return false; }
      return true;
    });
    await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(filtered));
    // Clean up externalized heavy field files for removed certs
    for (const id of removed) {
      for (const f of HEAVY_FIELDS) {
        try { await FileSystem.deleteAsync(certDataPath(id, f), { idempotent: true }); } catch (_) { }
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

/**
 * Transfer certificate to a new owner when an NFT is transferred.
 * Sends the full cert (with heavy fields) to server action:'transfer' so the new owner picks it up.
 * Then removes the cert locally from the sender.
 * @param {string} mintAddress - Mint address of the transferred NFT
 * @param {string} newOwnerAddress - Solana wallet address of the new owner
 * @param {string} serverUrl - Server URL
 * @param {Object} authHeaders - Auth headers
 * @returns {Promise<{success: boolean, transferred: number}>}
 */
export const transferCertificateForMint = async (mintAddress, newOwnerAddress, serverUrl = null, authHeaders = null, masterKey = null, newMintAddress = null) => {
  if (!mintAddress || !newOwnerAddress) return { success: false, error: 'Missing mintAddress or newOwnerAddress' };
  try {
    const normalizedMint = (mintAddress || '').replace('cnft_', '');
    const certs = await getStoredCertificates();
    const toTransfer = certs.filter(c => {
      const cMint = (c.mintAddress || '').replace('cnft_', '');
      return (cMint === normalizedMint)
        || c.id === `cert_${mintAddress}`
        || c.id === `cert_cnft_${normalizedMint}`;
    });

    // Also find the NFT to get encryptionData (may have wrappedKey for encrypted NFTs)
    let nftEncData = null;
    try {
      const storedNFTs = await getStoredNFTs();
      const nft = storedNFTs.find(n => (n.mintAddress || '').replace('cnft_', '') === normalizedMint);
      if (nft?.encryptionData) nftEncData = nft.encryptionData;
    } catch (_) { }

    let transferred = 0;
    const transferredIds = new Set();
    for (const cert of toTransfer) {
      // Load full heavy fields from disk so the new owner gets the complete cert
      let fullCert = { ...cert };
      try {
        const fullData = await getCertificateFullData(cert.id, cert);
        if (fullData) fullCert = { ...fullCert, ...fullData };
      } catch (_) { }

      // For encrypted NFTs: unwrap the per-NFT key and include it raw so new owner can decrypt
      // without needing the sender's masterKey (PBKDF2 of sender's email+password)
      if (masterKey && nftEncData?.wrappedKey && nftEncData?.wrapNonce) {
        try {
          const wk = naclUtil.decodeBase64(nftEncData.wrappedKey);
          const wn = naclUtil.decodeBase64(nftEncData.wrapNonce);
          const nftKey = nacl.secretbox.open(wk, wn, masterKey);
          if (nftKey) {
            fullCert.transferNftKey = naclUtil.encodeBase64(nftKey);
            if (nftEncData.nonce) fullCert.transferNonce = nftEncData.nonce;
            if (nftEncData.thumbnailNonce) fullCert.transferThumbnailNonce = nftEncData.thumbnailNonce;
            console.log('[Certs] Unwrapped nftKey for transfer (encrypted NFT)');
          }
        } catch (unwrapErr) {
          console.warn('[Certs] Could not unwrap nftKey for transfer:', unwrapErr.message);
        }
      }

      // POST to server with action: 'transfer'
      if (serverUrl && authHeaders) {
        try {
          await axios.post(`${serverUrl}/api/nft/certificates`, {
            action: 'transfer',
            certificate: fullCert,
            newOwnerAddress,
            newMintAddress,
          }, { headers: authHeaders, timeout: 15000 });
          transferred++;
          transferredIds.add(cert.id);
          console.log(`[Certs] Certificate transferred to ${newOwnerAddress.slice(0, 8)}...: ${cert.id}`);
        } catch (syncErr) {
          console.warn('[Certs] Certificate transfer sync failed:', syncErr.message);
        }
      }
    }

    // Remove only successfully transferred certs locally (prevents cert loss on partial server failure)
    if (transferredIds.size > 0) {
      const filtered = certs.filter(c => !transferredIds.has(c.id));
      await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(filtered));
      for (const cert of toTransfer) {
        if (!transferredIds.has(cert.id)) continue;
        for (const f of HEAVY_FIELDS) {
          try { await FileSystem.deleteAsync(certDataPath(cert.id, f), { idempotent: true }); } catch (_) { }
        }
      }
    }

    return { success: true, transferred };
  } catch (e) {
    console.error('[Certs] Certificate transfer failed:', e.message);
    return { success: false, error: e.message };
  }
};

/**
 * Build a shareable text representation of a certificate
 * Suitable for sharing via social media, saving to device, or printing
 */
export const formatCertificateForExport = (cert) => {
  if (!cert) return '';

  // Resolve license to full legal name (internationally recognized)
  const LICENSE_MAP = {
    'arr': 'All Rights Reserved',
    'cc-by': 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
    'cc-by-sa': 'Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)',
    'cc-by-nc': 'Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)',
    'cc-by-nc-sa': 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)',
    'cc-by-nd': 'Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0)',
    'cc-by-nc-nd': 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International (CC BY-NC-ND 4.0)',
    'cc0': 'Creative Commons Zero 1.0 Universal (CC0 — Public Domain)',
    'commercial': 'Commercial License — Contact Rights Holder',
  };
  const licenseLabel = LICENSE_MAP[cert.license] || cert.license || 'All Rights Reserved';

  // License URL for legal deed reference
  const LICENSE_URL_MAP = {
    'cc-by': 'https://creativecommons.org/licenses/by/4.0/',
    'cc-by-sa': 'https://creativecommons.org/licenses/by-sa/4.0/',
    'cc-by-nc': 'https://creativecommons.org/licenses/by-nc/4.0/',
    'cc-by-nc-sa': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    'cc-by-nd': 'https://creativecommons.org/licenses/by-nd/4.0/',
    'cc-by-nc-nd': 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    'cc0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  };
  const licenseUrl = LICENSE_URL_MAP[cert.license] || null;

  // Format date properly
  const formatDate = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
        ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    } catch (_) { return iso; }
  };

  const issued = formatDate(cert.issuedAt || cert.createdAt);
  const certId = cert.id || '—';
  const mint = cert.mintAddress || '—';
  const tx = cert.txSignature || '—';
  const contentHash = cert.contentHash || '— not recorded —';
  const exifHash = cert.exifHash || '— not recorded —';
  const exifRawHash = cert.exifRawHash || '— not recorded —';
  const exifBindingHash = cert.exifBindingHash || '— not recorded —';
  const storage = cert.storageType === 'cloud' ? 'StealthCloud (Encrypted Private Storage)' : cert.storageType === 'arweave' ? 'Arweave (Permanent Decentralized Storage)' : cert.storageType === 'onchain' ? 'Embedded On-Chain (Original Image in Metadata)' : 'IPFS (Decentralized Public Storage)';

  const hash = cert.contentHash ? cert.contentHash.replace(/^SHA256:/, '') : '<sha256_hash>';

  const lines = [
    '┌─────────────────────────────────────────────────────┐',
    '│                                                     │',
    '│          CERTIFICATE OF AUTHENTICITY                │',
    `│          Digital Asset — ${cert.certificationMode === 'public' ? 'Public Certified' : 'Private Certified'}          │`,
    '│                                                     │',
    '│          Issued by PhotoLynk                        │',
    '│          https://stealthlynk.io                     │',
    '│                                                     │',
    '└─────────────────────────────────────────────────────┘',
    '',
    `Certificate ID:   ${certId}`,
    `Date of Issue:    ${issued}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 1 — WORK IDENTIFICATION',
    '',
    `  Title:          ${cert.name || 'Untitled'}`,
    `  Certification:  ${cert.certificationMode === 'public' ? 'Public Certified' : cert.certificationMode === 'private' ? 'Private Certified' : cert.edition === 'limited' ? 'Private Certified' : cert.edition === 'open' ? 'Public Certified' : 'Certified Original'}`,
    `  License:        ${licenseLabel}`,
    ...(licenseUrl ? [`  License Deed:   ${licenseUrl}`] : []),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 2 — BLOCKCHAIN PROVENANCE',
    '',
    `  Network:        Solana Mainnet`,
    `  Mint Address:   ${mint}`,
    `  Transaction:    ${tx}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 3 — INTEGRITY VERIFICATION',
    '',
    `  Content Hash:   ${contentHash}`,
    `  EXIF Hash:      ${exifHash}`,
    `  Raw EXIF Hash:  ${exifRawHash}`,
    `  Binding Hash:   ${exifBindingHash}`,
    '',
    '  The above cryptographic hashes were computed at the',
    '  time of minting and can be used to verify that the',
    '  original work has not been altered or tampered with.',
    '',
    '  HOW TO VERIFY CONTENT HASH:',
    '    sha256sum <original_file>',
    '',
    '  HOW TO VERIFY EXIF HASH:',
    '    The EXIF Hash is SHA-256 of normalized EXIF fields',
    '    (non-GPS decimals rounded to 4dp, GPS truncated to 4dp,',
    '    keys sorted alphabetically, then JSON.stringify + SHA-256).',
    '',
    '    npm install exifreader',
    '    node verify-exif-hash.js <original_file>',
    '',
    '    Script: https://github.com/viktorvishyn369/PhotoLynk/blob/main/server-tray/verify-exif-hash.js',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 4 — ASSET PROTECTION',
    '',
    `  Watermarked:    ${cert.watermarked ? 'Yes — visible watermark applied' : 'No'}`,
    `  Encrypted:      ${cert.encrypted ? 'Yes — AES-256 encrypted at rest' : 'No'}`,
    `  Storage:        ${storage}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    ...(cert.rfc3161Token ? [
      'SECTION 5 — RFC 3161 TRUSTED TIMESTAMP',
      '',
      `  Authority:      FreeTSA.org (publicly trusted TSA)`,
      `  Standard:       RFC 3161 / RFC 5816`,
      `  Hash Algorithm: SHA-256`,
      `  Minted At:      ${cert.mintedAt || cert.createdAt || '—'}`,
      '',
      '  Verify with OpenSSL (macOS / Linux):',
      `  Step 1: printf '%s' "${cert.rfc3161Token}" | base64 -d > token.tsr`,
      '  Step 2: curl -o cacert.pem https://freetsa.org/files/cacert.pem',
      `  Step 3: openssl ts -verify -in token.tsr -digest ${hash} -CAfile cacert.pem`,
      '',
      '  Verify with PowerShell (Windows):',
      `  Step 1: [System.Convert]::FromBase64String("${cert.rfc3161Token}") | Set-Content token.tsr -Encoding Byte`,
      '  Step 2: Invoke-WebRequest https://freetsa.org/files/cacert.pem -OutFile cacert.pem',
      `  Step 3: openssl ts -verify -in token.tsr -digest ${hash} -CAfile cacert.pem`,
      '',
      '  Expected result: Verification: OK',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ] : []),
    ...(cert.c2paManifest ? [
      'SECTION 6 — C2PA PROVENANCE MANIFEST',
      '',
      `  Standard:       C2PA (Coalition for Content Provenance)`,
      `  Backed by:      Adobe, Microsoft, Google, BBC, Sony`,
      `  Claim Generator: ${cert.c2paManifest?.claim_generator || `PhotoLynk/${APP_VERSION}`}`,
      `  Created:        ${cert.c2paManifest?.claim?.created || cert.mintedAt || '—'}`,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ] : []),
    'This certificate was generated automatically at the time',
    'of minting by the PhotoLynk application. The blockchain',
    'record serves as immutable proof of creation, ownership,',
    'and provenance. This document may be presented as evidence',
    'of intellectual property rights.',
    '',
    '© PhotoLynk — stealthlynk.io',
  ];
  return lines.join('\n');
};

// ============================================================================
// AUTO-RESOLVE UNRESOLVED cNFT IDs
// Runs on gallery load — scans for tx_ / cnft_tx_ entries and resolves via DAS
// Handles the case where all post-mint retries failed (rate limits, indexer down)
// Safe for concurrent users: DAS lookup is per-wallet, won't collide
// ============================================================================

let _autoResolveRunning = false;

export const autoResolveUnresolvedCNFTs = async (walletAddress, serverUrl = null, authHeaders = null) => {
  if (_autoResolveRunning || _mintingInProgress) return { resolved: 0 };
  _autoResolveRunning = true;
  let resolved = 0;
  try {
    const nfts = await getStoredNFTs();
    const unresolved = nfts.filter(n => {
      const m = String(n.mintAddress || '');
      return (m.startsWith('cnft_tx_') || m.startsWith('tx_')) && n.metadataUrl;
    });
    if (unresolved.length === 0) return { resolved: 0 };
    console.log(`[cNFT AutoResolve] Found ${unresolved.length} unresolved entries, attempting DAS...`);

    // Group by ownerAddress to minimize DAS calls
    const byOwner = {};
    for (const n of unresolved) {
      const owner = n.ownerAddress || walletAddress || '';
      if (!owner) continue;
      if (!byOwner[owner]) byOwner[owner] = [];
      byOwner[owner].push(n);
    }

    for (const [owner, entries] of Object.entries(byOwner)) {
      let dasItems = null;
      // Single DAS call per owner (fetches latest 50 assets)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const dasResp = await fetch(SOLANA_RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 'auto-resolve',
              method: 'getAssetsByOwner',
              params: { ownerAddress: owner, page: 1, limit: 50, sortBy: { sortBy: 'created', sortDirection: 'desc' } },
            }),
          });
          if (dasResp.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue; }
          const data = await dasResp.json();
          dasItems = data.result?.items || [];
          break;
        } catch (_) { await new Promise(r => setTimeout(r, 2000)); }
      }
      if (!dasItems || dasItems.length === 0) continue;

      for (const nft of entries) {
        const match = dasItems.find(item =>
          (nft.metadataUrl && item.content?.json_uri === nft.metadataUrl) ||
          (nft.name && item.content?.metadata?.name === nft.name)
        );
        if (!match) continue;
        const realId = match.id;
        const newMint = `cnft_${realId}`;
        const oldMint = nft.mintAddress;
        console.log(`[cNFT AutoResolve] ✅ ${oldMint} → ${newMint}`);

        // Update NFT in storage
        const allNfts = await getStoredNFTs();
        const idx = allNfts.findIndex(n => n.mintAddress === oldMint);
        if (idx >= 0) {
          allNfts[idx].mintAddress = newMint;
          allNfts[idx].assetId = realId;
          await saveNFTsToFile(allNfts);
        }

        // Update certificate
        try {
          const certs = await getStoredCertificates();
          const oldNorm = oldMint.replace(/^cnft_/, '');
          let certChanged = false;
          for (const c of certs) {
            const cNorm = (c.mintAddress || '').replace(/^cnft_/, '');
            if (cNorm === oldNorm || c.mintAddress === oldMint) { c.mintAddress = newMint; certChanged = true; }
          }
          if (certChanged) {
            await FileSystem.writeAsStringAsync(CERTIFICATES_STORAGE_FILE, JSON.stringify(certs));
          }
        } catch (_) { }

        // Sync to server
        if (serverUrl && authHeaders) {
          try {
            const allNfts2 = await getStoredNFTs();
            const updated = allNfts2.find(n => n.mintAddress === newMint);
            if (updated) {
              await axios.post(`${serverUrl}/api/nft/sync`, {
                action: 'save', nft: { ...updated, mintAddress: newMint, assetId: realId },
              }, { headers: authHeaders, timeout: 10000 }).catch(() => { });
            }
            await axios.post(`${serverUrl}/api/nft/sync`, {
              action: 'remove', mintAddress: oldMint,
            }, { headers: authHeaders, timeout: 10000 }).catch(() => { });
          } catch (_) { }
        }
        resolved++;
      }
    }
    if (resolved > 0) console.log(`[cNFT AutoResolve] Resolved ${resolved} entries`);
  } catch (e) {
    console.warn('[cNFT AutoResolve] Error:', e.message);
  } finally {
    _autoResolveRunning = false;
  }
  return { resolved };
};

// ============================================================================
// EXPORTS
// ============================================================================

// Check if cNFT is available
export const isCNFTAvailable = () => cNFTAvailable;

export default {
  initializeNFT,
  fetchSolPrice,
  fetchSkrPrice,
  fetchSkrTokenDecimals,
  usdToSol,
  extractExifForNFT,
  estimateArweaveUploadCost,
  uploadToArweave,
  computeContentHash,
  computeExifHash,
  computeCameraSerialHash,
  buildNFTMetadata,
  uploadMetadataToArweave,
  estimateNFTMintCost,
  computeLimitedEditionFee,
  getConnectedWalletAddress,
  mintPhotoNFT,
  transferNFT,
  transferNFTByEmail,
  transferNFTBySolDomain,
  burnNFT,
  resolveSolDomain,
  resolveRecipient,
  isSolDomain,
  saveNFTToStorage,
  getStoredNFTs,
  syncNFTsFromServer,
  backupNFTsToServer,
  removeNFTFromStorage,
  removeTransferredNFTs,
  clearAllStoredNFTs,
  getNFTByMintAddress,
  getExplorerUrl,
  getSolscanUrl,
  verifyNFTOnChain,
  fetchNFTsFromBlockchain,
  fetchNFTMetadata,
  discoverAndImportNFTs,
  invalidateDasCache,
  isCNFTAvailable,
  isWalletAvailable,
  // Edition system
  generateOnChainImage,
  generateOptimizedPreview,
  generateLimitedEditionThumb,
  burnWatermark,
  encryptNFTImage,
  decryptNFTImage,
  decryptMetadataJSON,
  NFT_EDITION,
  NFT_LICENSE_OPTIONS,
  EDITION_ROYALTY_BPS,
  NFT_PAYMENT_METHODS,
  SKR_TOKEN_SYMBOL,
  SKR_TOKEN_MINT,
  SKR_PAYMENT_DISCOUNT_PERCENT,
  NFT_WEEKLY_DISCOUNT_FALLBACK,
  fetchWeeklyNftDiscountQuote,
  // Ecosystem check
  isPhotoLynkEcosystem,
  // Certificates
  generateCertificate,
  saveCertificate,
  saveAllCertificates,
  getStoredCertificates,
  getCertificateFullData,
  hasCertHeavyFieldsOnDisk,
  syncCertificatesFromServer,
  backupCertificatesToServer,
  transferCertificateForMint,
  removeCertificate,
  removeCertificateByMint,
  formatCertificateForExport,
  // Auto-resolve unresolved cNFT IDs on gallery load
  autoResolveUnresolvedCNFTs,
  // Existing constants
  NFT_FEES,
  NFT_COMMISSION_WALLET,
  CNFT_MODE,
  PHOTOLYNK_MERKLE_TREE,
  walletAdapterAvailable: () => walletAdapterAvailable,
};
