// NFT Service Configuration
// Matches solana-seeker/nftOperations.js and server-tray/nftDesktop.js constants

const path = require('path');

// ============================================================================
// SOLANA
// ============================================================================

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const SOLANA_RPC_FALLBACKS = [
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://rpc.ankr.com/solana',
];

// Server wallet keypair path (signs and pays for cNFT transactions)
const WALLET_KEYPAIR_PATH = process.env.WALLET_KEYPAIR_PATH || path.join(__dirname, 'wallet-keypair.json');

// PhotoLynk shared Merkle Tree for compressed NFTs (same as mobile)
const MERKLE_TREE = process.env.MERKLE_TREE || '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS';

// Commission wallet (receives SOL from minting fees)
const COMMISSION_WALLET = process.env.COMMISSION_WALLET || 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU';

// ============================================================================
// IPFS / STORAGE
// ============================================================================

const PINATA_JWT = process.env.PINATA_JWT || '';
const NFT_STORAGE_API_KEY = process.env.NFT_STORAGE_API_KEY || '';
const AKORD_API_KEY = process.env.AKORD_API_KEY || '';

// ============================================================================
// PRICING & FEES
// ============================================================================

// Promotional pricing (matches mobile exactly)
const PROMO_START_DATE = new Date(process.env.PROMO_START_DATE || '2026-01-27T00:00:00Z');
const PROMO_DURATION_DAYS = parseInt(process.env.PROMO_DURATION_DAYS) || 30;
const PROMO_END_DATE = new Date(PROMO_START_DATE.getTime() + PROMO_DURATION_DAYS * 24 * 60 * 60 * 1000);

function isPromoActive() {
  const now = new Date();
  return now >= PROMO_START_DATE && now < PROMO_END_DATE;
}

// Promo fees (first 30 days) — matches solana-seeker/nftOperations.js
const PROMO_FEES = {
  APP_COMMISSION_CNFT_IPFS_USD: 0.05,
  APP_COMMISSION_CNFT_CLOUD_USD: 0.02,
  APP_COMMISSION_STANDARD_IPFS_USD: 0.50,
  APP_COMMISSION_STANDARD_CLOUD_USD: 0.20,
};

// Regular fees (after promo) — matches solana-seeker/nftOperations.js
const REGULAR_FEES = {
  APP_COMMISSION_CNFT_IPFS_USD: 0.50,
  APP_COMMISSION_CNFT_CLOUD_USD: 0.20,
  APP_COMMISSION_STANDARD_IPFS_USD: 1.00,
  APP_COMMISSION_STANDARD_CLOUD_USD: 0.50,
};

// IPFS upload cost estimation (matches mobile)
const ARWEAVE_UPLOAD_BASE_USD = 0.01;
const ARWEAVE_PER_KB_USD = 0.00001;

function getCurrentFees() {
  return isPromoActive() ? PROMO_FEES : REGULAR_FEES;
}

/**
 * Limited Edition fee: 0.1% of file size in KB, floored, minimum $1.
 * e.g. 5000 KB → $5, 1500 KB → $1, 500 KB → $1 (minimum)
 * Matches solana-seeker/nftOperations.js computeLimitedEditionFee
 */
function computeLimitedEditionFee(fileSizeBytes) {
  const sizeKb = (fileSizeBytes || 0) / 1024;
  const fee = Math.floor(sizeKb * 0.001);
  return Math.max(fee, 1);
}

// ============================================================================
// NFT METADATA CONSTANTS (matches mobile)
// ============================================================================

const NFT_EDITION = {
  OPEN: 'open',
  LIMITED: 'limited',
};

const NFT_STORAGE_OPTIONS = {
  IPFS: 'ipfs',
  STEALTHCLOUD: 'cloud',
  ARWEAVE: 'arweave',
  ONCHAIN: 'onchain',
};

const NFT_LICENSE_OPTIONS = [
  { id: 'arr', label: 'All Rights Reserved', short: 'ARR' },
  { id: 'cc-by', label: 'CC BY 4.0', short: 'CC BY' },
  { id: 'cc-by-sa', label: 'CC BY-SA 4.0', short: 'CC BY-SA' },
  { id: 'cc-by-nc', label: 'CC BY-NC 4.0', short: 'CC BY-NC' },
  { id: 'cc-by-nc-sa', label: 'CC BY-NC-SA 4.0', short: 'CC BY-NC-SA' },
  { id: 'cc-by-nd', label: 'CC BY-ND 4.0', short: 'CC BY-ND' },
  { id: 'cc-by-nc-nd', label: 'CC BY-NC-ND 4.0', short: 'CC BY-NC-ND' },
  { id: 'cc0', label: 'CC0 1.0 (Public Domain)', short: 'CC0' },
  { id: 'commercial', label: 'Commercial License', short: 'Commercial' },
];

// ============================================================================
// DATABASE
// ============================================================================

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'nft-service.db');

// ============================================================================
// BUBBLEGUM / METAPLEX PROGRAM IDS
// ============================================================================

const PROGRAM_IDS = {
  BUBBLEGUM: 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY',
  SPL_NOOP: 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV',
  SPL_ACCOUNT_COMPRESSION: 'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK',
  TOKEN_METADATA: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
};

module.exports = {
  SOLANA_RPC_URL,
  SOLANA_RPC_FALLBACKS,
  WALLET_KEYPAIR_PATH,
  MERKLE_TREE,
  COMMISSION_WALLET,
  PINATA_JWT,
  NFT_STORAGE_API_KEY,
  AKORD_API_KEY,
  PROMO_START_DATE,
  PROMO_END_DATE,
  isPromoActive,
  PROMO_FEES,
  REGULAR_FEES,
  ARWEAVE_UPLOAD_BASE_USD,
  ARWEAVE_PER_KB_USD,
  getCurrentFees,
  computeLimitedEditionFee,
  NFT_EDITION,
  NFT_STORAGE_OPTIONS,
  NFT_LICENSE_OPTIONS,
  DB_PATH,
  PROGRAM_IDS,
};
