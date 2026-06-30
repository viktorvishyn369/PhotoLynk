// WalletAdapter Utilities
// Shared helper functions for wallet operations

import { Platform } from 'react-native';

// Solana imports
let Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram;
let TransactionMessage, VersionedTransaction;
let solanaAvailable = false;

try {
  const web3 = require('@solana/web3.js');
  Connection = web3.Connection;
  PublicKey = web3.PublicKey;
  LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
  SystemProgram = web3.SystemProgram;
  TransactionMessage = web3.TransactionMessage;
  VersionedTransaction = web3.VersionedTransaction;
  solanaAvailable = true;
} catch (e) {
  console.log('[WalletUtils] Solana web3 not available:', e.message);
}

// Configuration
const SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

// Shared connection instance
let connection = null;

// ============================================================================
// CONNECTION
// ============================================================================

/**
 * Get or create Solana connection
 */
export const getConnection = () => {
  if (!solanaAvailable) {
    throw new Error('Solana web3 not available');
  }
  
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }
  return connection;
};

/**
 * Check if Solana is available
 */
export const isSolanaAvailable = () => solanaAvailable;

// ============================================================================
// ADDRESS UTILITIES
// ============================================================================

/**
 * Validate a Solana address
 * @param {string} address - Address to validate
 * @returns {boolean} Whether address is valid
 */
export const isValidSolanaAddress = (address) => {
  if (!solanaAvailable || !address) return false;
  
  try {
    new PublicKey(address);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Shorten an address for display
 * @param {string} address - Full address
 * @param {number} startChars - Characters to show at start
 * @param {number} endChars - Characters to show at end
 * @returns {string} Shortened address
 */
export const shortenAddress = (address, startChars = 4, endChars = 4) => {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
};

/**
 * Convert base64 address to PublicKey
 * @param {string} base64Address - Base64 encoded address
 * @returns {PublicKey} Solana PublicKey
 */
export const base64ToPublicKey = (base64Address) => {
  if (!solanaAvailable) throw new Error('Solana not available');
  
  const bytes = typeof base64Address === 'string'
    ? Uint8Array.from(atob(base64Address), c => c.charCodeAt(0))
    : new Uint8Array(base64Address);
  return new PublicKey(bytes);
};

// ============================================================================
// TRANSACTION UTILITIES
// ============================================================================

/**
 * Create a SOL transfer transaction
 * @param {string} fromAddress - Sender address
 * @param {string} toAddress - Recipient address
 * @param {number} solAmount - Amount in SOL
 * @returns {Object} { transaction, blockhash }
 */
export const createTransferTransaction = async (fromAddress, toAddress, solAmount) => {
  if (!solanaAvailable) {
    throw new Error('Solana not available');
  }
  
  const conn = getConnection();
  const fromPubkey = new PublicKey(fromAddress);
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.ceil(solAmount * LAMPORTS_PER_SOL);
  
  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  
  // Create transfer instruction
  const transferInstruction = SystemProgram.transfer({
    fromPubkey,
    toPubkey,
    lamports,
  });
  
  // Create transaction message
  const messageV0 = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [transferInstruction],
  }).compileToV0Message();
  
  // Create versioned transaction
  const transaction = new VersionedTransaction(messageV0);
  
  return {
    transaction,
    blockhash,
    lastValidBlockHeight,
  };
};

/**
 * Confirm a transaction
 * @param {string} signature - Transaction signature
 * @param {string} blockhash - Blockhash used
 * @param {number} lastValidBlockHeight - Last valid block height
 * @returns {Object} Confirmation result
 */
export const confirmTransaction = async (signature, blockhash, lastValidBlockHeight) => {
  const conn = getConnection();
  
  const confirmation = await conn.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  }, 'confirmed');
  
  return confirmation;
};

/**
 * Get transaction status
 * @param {string} signature - Transaction signature
 * @returns {Object} Transaction status
 */
export const getTransactionStatus = async (signature) => {
  const conn = getConnection();
  
  try {
    const status = await conn.getSignatureStatus(signature);
    return {
      found: !!status.value,
      confirmed: status.value?.confirmationStatus === 'confirmed' || 
                 status.value?.confirmationStatus === 'finalized',
      error: status.value?.err,
    };
  } catch (e) {
    return { found: false, confirmed: false, error: e.message };
  }
};

// ============================================================================
// BALANCE UTILITIES
// ============================================================================

/**
 * Get SOL balance for an address
 * @param {string} address - Wallet address
 * @returns {number} Balance in SOL
 */
export const getSolBalance = async (address) => {
  if (!solanaAvailable || !address) return 0;
  
  try {
    const conn = getConnection();
    const pubkey = new PublicKey(address);
    const balance = await conn.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error('[WalletUtils] Balance fetch failed:', e);
    return 0;
  }
};

/**
 * Format SOL amount for display
 * @param {number} sol - Amount in SOL
 * @param {number} decimals - Decimal places
 * @returns {string} Formatted amount
 */
export const formatSol = (sol, decimals = 4) => {
  if (typeof sol !== 'number' || isNaN(sol)) return '0';
  return sol.toFixed(decimals);
};

/**
 * Convert lamports to SOL
 * @param {number} lamports - Amount in lamports
 * @returns {number} Amount in SOL
 */
export const lamportsToSol = (lamports) => {
  return lamports / LAMPORTS_PER_SOL;
};

/**
 * Convert SOL to lamports
 * @param {number} sol - Amount in SOL
 * @returns {number} Amount in lamports
 */
export const solToLamports = (sol) => {
  return Math.ceil(sol * LAMPORTS_PER_SOL);
};

// ============================================================================
// PRICE UTILITIES
// ============================================================================

let cachedSolPrice = null;
let solPriceLastFetch = 0;
const SOL_PRICE_CACHE_MS = 60000;

/**
 * Fetch current SOL price in USD
 * @returns {number} SOL price in USD
 */
export const fetchSolPrice = async () => {
  const now = Date.now();
  
  // Return cached price if still valid
  if (cachedSolPrice && (now - solPriceLastFetch) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice;
  }
  
  const priceApis = [
    {
      name: 'CoinGecko',
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      extract: (data) => data?.solana?.usd,
    },
    {
      name: 'Binance',
      url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
      extract: (data) => parseFloat(data?.price),
    },
  ];
  
  for (const api of priceApis) {
    try {
      const response = await fetch(api.url, { timeout: 8000 });
      const data = await response.json();
      const price = api.extract(data);
      
      if (price && typeof price === 'number' && price > 0) {
        cachedSolPrice = price;
        solPriceLastFetch = now;
        return price;
      }
    } catch (e) {
      console.warn(`[WalletUtils] ${api.name} price fetch failed:`, e.message);
    }
  }
  
  // Return cached price if available
  if (cachedSolPrice) return cachedSolPrice;
  
  throw new Error('Failed to fetch SOL price');
};

/**
 * Convert USD to SOL
 * @param {number} usd - Amount in USD
 * @returns {number} Amount in SOL
 */
export const usdToSol = async (usd) => {
  const price = await fetchSolPrice();
  return usd / price;
};

/**
 * Convert SOL to USD
 * @param {number} sol - Amount in SOL
 * @returns {number} Amount in USD
 */
export const solToUsd = async (sol) => {
  const price = await fetchSolPrice();
  return sol * price;
};

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  getConnection,
  isSolanaAvailable,
  isValidSolanaAddress,
  shortenAddress,
  base64ToPublicKey,
  createTransferTransaction,
  confirmTransaction,
  getTransactionStatus,
  getSolBalance,
  formatSol,
  lamportsToSol,
  solToLamports,
  fetchSolPrice,
  usdToSol,
  solToUsd,
};
