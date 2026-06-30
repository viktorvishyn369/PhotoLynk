// Solana Blockchain Purchases Integration for StealthCloud
// Handles subscription payments via SOL transfers on Solana blockchain
// Supports multiple wallets: MWA (Seeker/Saga), Phantom, WalletConnect, MetaMask

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import axios from 'axios';

// WalletAdapter imports for universal wallet support
let WalletAdapter = null;
let walletAdapterAvailable = false;

try {
  WalletAdapter = require('./WalletAdapter');
  walletAdapterAvailable = true;
  console.log('[SolanaPurchases] WalletAdapter loaded');
} catch (e) {
  console.log('[SolanaPurchases] WalletAdapter not available:', e.message);
}

// Solana imports - will be available after npm install
let Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, TransactionMessage, VersionedTransaction;
let transact, Web3MobileWallet;
let solanaAvailable = false;

try {
  const web3 = require('@solana/web3.js');
  Connection = web3.Connection;
  PublicKey = web3.PublicKey;
  Transaction = web3.Transaction;
  SystemProgram = web3.SystemProgram;
  LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
  TransactionMessage = web3.TransactionMessage;
  VersionedTransaction = web3.VersionedTransaction;
  
  const mwa = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
  transact = mwa.transact;
  Web3MobileWallet = mwa.Web3MobileWallet;
  
  solanaAvailable = true;
} catch (e) {
  console.log('Solana libraries not available (run npm install):', e.message);
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// Payment recipient wallet address (your business wallet)
export const PAYMENT_WALLET = 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU';

// Solana RPC endpoints with fallbacks — Helius primary, public RPCs as fallback
const SOLANA_RPC_ENDPOINTS = [
  'https://mainnet.helius-rpc.com/?api-key=8b86bd0d-4534-4ce9-a61d-ec3850cb0b62',
  'https://mainnet.helius-rpc.com/?api-key=6b3d0180-4354-4e31-a2fc-9b6cd9e550a7',
  'https://rpc.ankr.com/solana',
  'https://api.mainnet-beta.solana.com',
];
let currentRpcIndex = 0;
const SOLANA_RPC_ENDPOINT = SOLANA_RPC_ENDPOINTS[0];
// For testing, use devnet:
// const SOLANA_RPC_ENDPOINT = 'https://api.devnet.solana.com';

// StealthCloud server base URL
const STEALTHCLOUD_BASE_URL = 'https://stealthlynk.io';

// App identity for Mobile Wallet Adapter
const APP_IDENTITY = {
  name: 'PhotoLynk',
  uri: 'https://stealthlynk.io',
  icon: 'favicon.ico',
};

// Plan pricing in USD (monthly)
export const PLAN_PRICES_USD = {
  100: 1.75,   // 100 GB
  200: 2.45,   // 200 GB
  400: 3.99,   // 400 GB
  1000: 7.99,  // 1 TB
};

// Plan durations in days
export const PLAN_DURATIONS = {
  monthly: 30,
  yearly: 365,
};

// Grace period in days (matches server SUBSCRIPTION_GRACE_DAYS)
export const GRACE_PERIOD_DAYS = 3;

// Premium tier pricing (one-time purchase)
export const PREMIUM_PRICE_USD = 49.99;

// SKR Token configuration for subscription payments
export const SKR_TOKEN_SYMBOL = 'SKR';
export const SKR_TOKEN_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
export const SKR_TOKEN_DECIMALS = 6;
export const SKR_SUBSCRIPTION_DISCOUNT_PERCENT = 50;
// Discount disabled: SKR subscription/premium payments charge the full USD-equivalent.
// To re-enable the promotional 50% off, change this back to 0.50.
const SKR_SUBSCRIPTION_MULTIPLIER = 1.0;

// ============================================================================
// STATE
// ============================================================================

let connection = null;
let cachedSolPrice = null;
let cachedSkrPrice = null;
let solPriceLastFetch = 0;
let skrPriceLastFetch = 0;
const SOL_PRICE_CACHE_MS = 60000; // Cache SOL price for 1 minute
const SOL_PRICE_STORAGE_KEY = 'solana_purchases_sol_price';
const PENDING_PREMIUM_KEY = 'solana_pending_premium_verification';
const PENDING_SUBSCRIPTION_KEY = 'solana_pending_subscription_verification';

let connectedWallet = null;
let authToken = null;

const savePendingPremiumVerification = async (txSignature, amount, paymentMethod = 'sol') => {
  try {
    await SecureStore.setItemAsync(PENDING_PREMIUM_KEY, JSON.stringify({
      txSignature,
      paymentMethod,
      solAmount: paymentMethod === 'sol' ? amount : undefined,
      skrAmount: paymentMethod === 'skr' ? amount : undefined,
      retryCount: 0,
      savedAt: Date.now(),
    }));
  } catch (_) {}
};

const clearPendingPremiumVerification = async () => {
  try {
    await SecureStore.deleteItemAsync(PENDING_PREMIUM_KEY);
  } catch (_) {}
};

const savePendingSubscriptionVerification = async (txSignature, tierGb, duration, amount, paymentMethod = 'sol') => {
  try {
    await SecureStore.setItemAsync(PENDING_SUBSCRIPTION_KEY, JSON.stringify({
      txSignature,
      tierGb,
      duration,
      paymentMethod,
      solAmount: paymentMethod === 'sol' ? amount : undefined,
      skrAmount: paymentMethod === 'skr' ? amount : undefined,
      retryCount: 0,
      savedAt: Date.now(),
    }));
  } catch (_) {}
};

const clearPendingSubscriptionVerification = async () => {
  try {
    await SecureStore.deleteItemAsync(PENDING_SUBSCRIPTION_KEY);
  } catch (_) {}
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Solana connection with fallback RPC endpoints
 */
export const initializeSolana = async () => {
  if (!solanaAvailable) {
    console.log('Solana not available (native rebuild required)');
    return false;
  }
  
  // Try each RPC endpoint until one works
  for (let i = 0; i < SOLANA_RPC_ENDPOINTS.length; i++) {
    try {
      const endpoint = SOLANA_RPC_ENDPOINTS[i];
      const testConnection = new Connection(endpoint, 'confirmed');
      
      // Test the connection with a simple call
      await testConnection.getLatestBlockhash('confirmed');
      
      connection = testConnection;
      currentRpcIndex = i;
      console.log('Solana connection initialized with:', endpoint);
      return true;
    } catch (e) {
      console.log(`RPC ${SOLANA_RPC_ENDPOINTS[i]} failed:`, e.message);
    }
  }
  
  // Fallback: use first endpoint anyway (might work later)
  connection = new Connection(SOLANA_RPC_ENDPOINTS[0], 'confirmed');
  console.log('Solana connection initialized (fallback)');
  return true;
};

/**
 * Get a working connection, trying fallback RPCs if needed
 */
const getWorkingConnection = async () => {
  if (!connection) {
    await initializeSolana();
  }
  
  // Try current connection first
  try {
    await connection.getLatestBlockhash('confirmed');
    return connection;
  } catch (e) {
    console.log('[SolanaPurchases] Current RPC failed, trying fallbacks...');
  }
  
  // Try other endpoints
  for (let i = 0; i < SOLANA_RPC_ENDPOINTS.length; i++) {
    if (i === currentRpcIndex) continue;
    
    try {
      const endpoint = SOLANA_RPC_ENDPOINTS[i];
      const testConnection = new Connection(endpoint, 'confirmed');
      await testConnection.getLatestBlockhash('confirmed');
      
      connection = testConnection;
      currentRpcIndex = i;
      console.log('[SolanaPurchases] Switched to RPC:', endpoint);
      return connection;
    } catch (e) {
      console.log(`[SolanaPurchases] RPC ${SOLANA_RPC_ENDPOINTS[i]} failed`);
    }
  }
  
  // Return current connection as last resort
  return connection;
};

// ============================================================================
// WALLET CONNECTION (Mobile Wallet Adapter)
// ============================================================================

/**
 * Connect to a Solana wallet using Mobile Wallet Adapter
 * @returns {Object} { success, publicKey, error }
 */
export const connectWallet = async () => {
  if (!solanaAvailable || !transact) {
    return { success: false, error: 'Solana not available' };
  }
  
  try {
    const result = await transact(async (wallet) => {
      // Request authorization from the wallet
      const authResult = await wallet.authorize({
        cluster: 'mainnet-beta', // Use 'devnet' for testing
        identity: APP_IDENTITY,
      });
      
      return {
        publicKey: authResult.accounts[0].address,
        authToken: authResult.auth_token,
      };
    });
    
    connectedWallet = result.publicKey;
    authToken = result.authToken;
    
    // Store wallet address for future sessions
    await SecureStore.setItemAsync('solana_wallet', result.publicKey);
    
    console.log('Wallet connected:', result.publicKey);
    return { success: true, publicKey: result.publicKey };
  } catch (e) {
    console.error('Wallet connection failed:', e);
    return { success: false, error: e.message || 'Connection failed' };
  }
};

/**
 * Disconnect wallet
 */
export const disconnectWallet = async () => {
  connectedWallet = null;
  authToken = null;
  await SecureStore.deleteItemAsync('solana_wallet');
  console.log('Wallet disconnected');
};

/**
 * Get connected wallet address
 * @returns {string|null} Wallet public key or null
 */
export const getConnectedWallet = async () => {
  if (connectedWallet) return connectedWallet;
  
  // Try to restore from secure storage
  try {
    const stored = await SecureStore.getItemAsync('solana_wallet');
    if (stored) {
      connectedWallet = stored;
      return stored;
    }
  } catch (e) {
    console.error('Failed to get stored wallet:', e);
  }
  
  return null;
};

/**
 * Get wallet SOL balance
 * @param {string} walletAddress - Wallet public key
 * @returns {number} Balance in SOL
 */
export const getWalletBalance = async (walletAddress = null) => {
  if (!solanaAvailable || !connection) {
    return 0;
  }
  
  try {
    const address = walletAddress || connectedWallet;
    if (!address) return 0;
    
    const pubkey = new PublicKey(address);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error('Failed to get balance:', e);
    return 0;
  }
};

// ============================================================================
// SOL PRICE CONVERSION
// ============================================================================

/**
 * Fetch current SOL price in USD from multiple APIs with fallbacks
 * @returns {number} SOL price in USD
 */
export const fetchSolPrice = async () => {
  const now = Date.now();
  
  // Return cached price if still valid
  if (cachedSolPrice && cachedSolPrice > 0 && (now - solPriceLastFetch) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice;
  }
  
  // Try to load persisted price if no memory cache
  if (!cachedSolPrice) {
    try {
      const stored = await SecureStore.getItemAsync(SOL_PRICE_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.price > 0) {
          cachedSolPrice = parsed.price;
          console.log('[SolanaPurchases] Loaded persisted SOL price:', cachedSolPrice);
        }
      }
    } catch (e) {
      console.log('[SolanaPurchases] Could not load persisted price:', e.message);
    }
  }
  
  // Try multiple price APIs with fallbacks
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
    {
      name: 'CoinCap',
      url: 'https://api.coincap.io/v2/assets/solana',
      extract: (data) => parseFloat(data?.data?.priceUsd),
    },
  ];
  
  for (const api of priceApis) {
    try {
      const response = await axios.get(api.url, { timeout: 8000 });
      const price = api.extract(response.data);
      
      if (price && typeof price === 'number' && price > 0) {
        cachedSolPrice = price;
        solPriceLastFetch = now;
        console.log(`[SolanaPurchases] SOL price from ${api.name}:`, price);
        // Persist successful price for future fallback
        try {
          await SecureStore.setItemAsync(SOL_PRICE_STORAGE_KEY, JSON.stringify({ price, timestamp: now }));
        } catch (e) {
          console.log('[SolanaPurchases] Could not persist price:', e.message);
        }
        return price;
      }
    } catch (e) {
      console.warn(`[SolanaPurchases] ${api.name} price fetch failed:`, e.message);
      // Continue to next API
    }
  }
  
  // Fallback to last stored price if all APIs fail
  if (cachedSolPrice && cachedSolPrice > 0) {
    console.log('[SolanaPurchases] All price APIs failed, using last stored price:', cachedSolPrice);
    return cachedSolPrice;
  }
  
  console.error('[SolanaPurchases] All price APIs failed and no stored price available');
  return null;
};

/**
 * Convert USD to SOL
 * @param {number} usdAmount - Amount in USD
 * @returns {number} Amount in SOL
 */
export const usdToSol = async (usdAmount) => {
  const solPrice = await fetchSolPrice();
  return usdAmount / solPrice;
};

/**
 * Get plan price in SOL
 * @param {number} tierGb - Plan tier in GB (100, 200, 400, 1000)
 * @returns {Object} { usd, sol, solPrice }
 */
export const getPlanPriceInSol = async (tierGb) => {
  const usdPrice = PLAN_PRICES_USD[tierGb];
  if (!usdPrice) {
    return { usd: 0, sol: 0, solPrice: 0 };
  }
  
  const solPrice = await fetchSolPrice();
  const solAmount = usdPrice / solPrice;
  
  return {
    usd: usdPrice,
    sol: solAmount,
    solFormatted: solAmount.toFixed(6),
    solPrice,
  };
};

// ============================================================================
// SKR PRICE & SUBSCRIPTION PRICING
// ============================================================================

/**
 * Fetch current SKR token price in USD from Jupiter API
 * @returns {number} SKR price in USD
 */
export const fetchSkrPrice = async () => {
  const now = Date.now();
  const SKR_PRICE_CACHE_MS = 60000; // Cache for 1 minute

  // Return cached price if still valid
  if (cachedSkrPrice && cachedSkrPrice > 0 && (now - skrPriceLastFetch) < SKR_PRICE_CACHE_MS) {
    return cachedSkrPrice;
  }

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
        const solPair = pairs.find(p => p.quoteToken?.symbol === 'SOL');
        return solPair?.priceNative ? parseFloat(solPair.priceUsd) : parseFloat(pairs[0].priceUsd);
      },
    },
  ];

  for (const api of priceApis) {
    try {
      const response = await axios.get(api.url, { timeout: 8000 });
      const price = api.extract(response.data);
      if (price && typeof price === 'number' && price > 0) {
        cachedSkrPrice = price;
        skrPriceLastFetch = now;
        console.log(`[SolanaPurchases] SKR price from ${api.name}:`, price);
        return price;
      }
    } catch (e) {
      console.warn(`[SolanaPurchases] ${api.name} SKR price fetch failed:`, e.message);
    }
  }

  console.error('[SolanaPurchases] All SKR price APIs failed');
  return null;
};

/**
 * Get plan price with SKR payment option (50% discount)
 * @param {number} tierGb - Plan tier in GB (100, 200, 400, 1000)
 * @param {string} duration - 'monthly' or 'yearly'
 * @returns {Object} { usd, sol, skr, skrAmount, skrFormatted, discountPercent }
 */
export const getPlanPriceWithSkr = async (tierGb, duration = 'monthly') => {
  const baseUsd = PLAN_PRICES_USD[tierGb];
  if (!baseUsd) {
    return { usd: 0, sol: 0, skr: 0, skrAmount: 0, skrFormatted: '0', discountPercent: 0 };
  }

  // Calculate duration multiplier
  const durationMultiplier = duration === 'yearly' ? 12 : 1;
  const totalUsd = baseUsd * durationMultiplier;
  
  // SKR subscription discount disabled — multiplier is 1.0 (full USD price).
  const discountedUsd = totalUsd * SKR_SUBSCRIPTION_MULTIPLIER;
  
  const [solPrice, skrPrice] = await Promise.all([fetchSolPrice(), fetchSkrPrice()]);
  
  const solAmount = totalUsd / (solPrice || 1);
  const skrAmount = skrPrice && skrPrice > 0 ? discountedUsd / skrPrice : 0;
  
  return {
    usd: totalUsd,
    discountedUsd,
    sol: solAmount,
    solFormatted: solAmount.toFixed(6),
    skr: skrAmount,
    skrFormatted: skrAmount > 0 ? skrAmount.toFixed(2) : '—',
    skrAmountFormatted: skrAmount > 0 ? `${skrAmount.toFixed(2)} ${SKR_TOKEN_SYMBOL}` : `— ${SKR_TOKEN_SYMBOL}`,
    skrPrice,
    solPrice,
    discountPercent: SKR_SUBSCRIPTION_DISCOUNT_PERCENT,
    savingsUsd: totalUsd - discountedUsd,
  };
};

// ============================================================================
// PAYMENT PROCESSING
// ============================================================================

/**
 * Create a payment memo with user info for tracking
 * @param {string} userUuid - User's unique identifier
 * @param {number} tierGb - Plan tier
 * @param {string} duration - 'monthly' or 'yearly'
 * @returns {string} Memo string
 */
const createPaymentMemo = (userUuid, tierGb, duration = 'monthly') => {
  // Format: PHOTOLYNK|<uuid>|<tier>|<duration>
  return `PHOTOLYNK|${userUuid}|${tierGb}GB|${duration}`;
};

/**
 * Purchase a subscription plan using SOL
 * @param {number} tierGb - Plan tier in GB (100, 200, 400, 1000)
 * @param {string} authToken - User's auth token for server authentication
 * @param {string} duration - 'monthly' or 'yearly'
 * @returns {Object} { success, txSignature, error }
 */
export const purchaseWithSol = async (tierGb, authToken, duration = 'monthly') => {
  if (!solanaAvailable || !transact) {
    return { success: false, error: 'Solana not available' };
  }
  
  if (!authToken) {
    return { success: false, error: 'Auth token required' };
  }
  
  try {
    // Ensure we have a working connection with fallback RPCs
    const workingConnection = await getWorkingConnection();
    if (!workingConnection) {
      return { success: false, error: 'Cannot connect to Solana network' };
    }
    
    // Get price in SOL
    const priceInfo = await getPlanPriceInSol(tierGb);
    if (!priceInfo.sol || priceInfo.sol <= 0) {
      return { success: false, error: 'Invalid plan tier' };
    }
    
    // Convert SOL to lamports (1 SOL = 1,000,000,000 lamports)
    const lamports = Math.ceil(priceInfo.sol * LAMPORTS_PER_SOL);
    
    console.log(`Initiating payment: ${priceInfo.sol.toFixed(6)} SOL ($${priceInfo.usd}) for ${tierGb}GB ${duration}`);
    
    // Pre-fetch blockhash BEFORE opening wallet session to avoid timeout
    console.log('[SolanaPurchases] Pre-fetching blockhash...');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    console.log('[SolanaPurchases] Blockhash ready:', blockhash.slice(0, 16) + '...');
    
    const recipientPubkey = new PublicKey(PAYMENT_WALLET);
    
    // Execute transaction via Mobile Wallet Adapter
    console.log('[SolanaPurchases] Opening MWA session...');
    const txSignature = await transact(async (wallet) => {
      // Authorize if needed
      console.log('[SolanaPurchases] Requesting authorization...');
      const authResult = await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
      });
      console.log('[SolanaPurchases] Authorization received, building transaction...');
      
      // Get payer's public key - MWA returns address as base64 string, convert to bytes then PublicKey
      const payerAddress = authResult.accounts[0].address;
      // Decode base64 to bytes, then create PublicKey
      const payerBytes = typeof payerAddress === 'string'
        ? Uint8Array.from(atob(payerAddress), c => c.charCodeAt(0))
        : new Uint8Array(payerAddress);
      const payerPubkey = new PublicKey(payerBytes);
      console.log('[SolanaPurchases] Payer:', payerPubkey.toBase58());
      
      // Create transfer instruction
      const transferInstruction = SystemProgram.transfer({
        fromPubkey: payerPubkey,
        toPubkey: recipientPubkey,
        lamports,
      });
      
      // Create transaction message
      const messageV0 = new TransactionMessage({
        payerKey: payerPubkey,
        recentBlockhash: blockhash,
        instructions: [transferInstruction],
      }).compileToV0Message();
      
      // Create versioned transaction
      const transaction = new VersionedTransaction(messageV0);
      console.log('[SolanaPurchases] Transaction built, requesting signature...');
      console.log('[SolanaPurchases] From:', payerPubkey.toBase58(), 'To:', recipientPubkey.toBase58());
      
      // Use signTransactions + manual send (more reliable than signAndSendTransactions on some wallets)
      console.log('[SolanaPurchases] Calling wallet.signTransactions...');
      const signedTransactions = await wallet.signTransactions({
        transactions: [transaction],
      });
      console.log('[SolanaPurchases] Transaction signed by wallet');
      
      // Return signed transaction to send outside wallet session
      return signedTransactions[0];
    });
    
    // Small delay to let MWA session fully close before network call
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Send the signed transaction outside the MWA session with retry
    console.log('[SolanaPurchases] Sending signed transaction to network...');
    let txSignatureFinal = null;
    let sendError = null;
    
    // Try each RPC endpoint silently
    for (let i = 0; i < SOLANA_RPC_ENDPOINTS.length; i++) {
      try {
        const endpoint = SOLANA_RPC_ENDPOINTS[i];
        const sendConnection = new Connection(endpoint, 'confirmed');
        
        const signature = await sendConnection.sendRawTransaction(txSignature.serialize(), {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
        
        txSignatureFinal = signature;
        console.log('[SolanaPurchases] Transaction sent successfully');
        break;
      } catch (e) {
        // Silent retry - only log on last attempt
        if (i === SOLANA_RPC_ENDPOINTS.length - 1) {
          console.log('[SolanaPurchases] All RPC endpoints failed');
        }
        sendError = e;
      }
    }
    
    if (!txSignatureFinal) {
      throw sendError || new Error('Failed to send transaction to all RPC endpoints');
    }
    
    console.log('Transaction submitted:', txSignatureFinal);
    
    // Notify server about the payment immediately - server will verify on-chain
    // Don't wait for client-side confirmation as MWA session may timeout
    const serverResult = await notifyServerOfPayment(txSignatureFinal, authToken, tierGb, duration, priceInfo.sol);
    
    if (serverResult.success) {
      console.log('Payment verified by server:', txSignatureFinal);
      return {
        success: true,
        txSignature: txSignatureFinal,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        serverNotified: true,
      };
    } else {
      // Server couldn't verify - might still be pending, return partial success
      console.log('Server verification pending:', serverResult.error);
      return {
        success: true,
        txSignature: txSignatureFinal,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        serverNotified: false,
        pendingVerification: true,
      };
    }
  } catch (e) {
    // User cancelled or rejected the transaction
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled') || e.message?.includes('CancellationException')) {
      return { success: false, error: 'cancelled', userCancelled: true };
    }
    // Check if we got a txSignature before the error (timeout after send)
    if (e.message?.includes('timeout') || e.message?.includes('TimeoutException')) {
      console.log('Transaction may have been sent, check wallet for confirmation');
      return { success: false, errorKey: 'transactionTimeout', timeout: true };
    }
    console.log('[SolanaPurchases] Payment failed:', e.message);
    return { success: false, errorKey: 'paymentFailed' };
  }
};

/**
 * Purchase a subscription plan using SOL via WalletAdapter (Universal)
 * Supports multiple wallets: MWA, Phantom, WalletConnect, MetaMask
 * @param {number} tierGb - Plan tier in GB (100, 200, 400, 1000)
 * @param {string} authToken - User's auth token for server authentication
 * @param {string} duration - 'monthly' or 'yearly'
 * @param {string} walletType - Optional: specific wallet type to use
 * @returns {Object} { success, txSignature, error }
 */
export const purchaseWithWallet = async (tierGb, authToken, duration = 'monthly', walletType = null) => {
  // For MWA (Android), use the original purchaseWithSol which handles everything in one session
  // MWA requires building and signing transaction in the SAME wallet session to avoid timeouts
  if (Platform.OS === 'android' && (!walletType || walletType === 'mwa')) {
    console.log('[SolanaPurchases] Using MWA single-session flow for Android');
    return purchaseWithSol(tierGb, authToken, duration);
  }
  
  // Check if WalletAdapter is available for non-MWA wallets (Phantom deeplinks, etc.)
  if (!walletAdapterAvailable || !WalletAdapter) {
    console.log('[SolanaPurchases] WalletAdapter not available, falling back to MWA');
    return purchaseWithSol(tierGb, authToken, duration);
  }
  
  if (!solanaAvailable || !connection) {
    return { success: false, error: 'Solana not available' };
  }
  
  if (!authToken) {
    return { success: false, error: 'Auth token required' };
  }
  
  try {
    // Initialize WalletAdapter if needed
    await WalletAdapter.initializeWalletAdapter();
    
    // Check connection status
    let status = WalletAdapter.getConnectionStatus();
    
    // Determine which wallet to use
    const targetWalletType = walletType || (Platform.OS === 'ios' ? 'phantom' : 'mwa');
    
    // If MWA is selected, use the original flow
    if (targetWalletType === 'mwa') {
      console.log('[SolanaPurchases] MWA selected, using single-session flow');
      return purchaseWithSol(tierGb, authToken, duration);
    }
    
    // If not connected, connect to wallet
    if (!status.isConnected || status.walletType !== targetWalletType) {
      const connectResult = await WalletAdapter.connectWallet(targetWalletType);
      
      if (!connectResult.success) {
        if (connectResult.userCancelled) {
          return { success: false, error: 'cancelled', userCancelled: true };
        }
        // Fall back to MWA if other wallet fails
        console.log('[SolanaPurchases] Wallet connection failed, falling back to MWA');
        return purchaseWithSol(tierGb, authToken, duration);
      }
      
      status = WalletAdapter.getConnectionStatus();
    }
    
    if (!status.address) {
      return { success: false, error: 'No wallet address' };
    }
    
    // Get price in SOL
    const priceInfo = await getPlanPriceInSol(tierGb);
    if (!priceInfo.sol || priceInfo.sol <= 0) {
      return { success: false, error: 'Invalid plan tier' };
    }
    
    const lamports = Math.ceil(priceInfo.sol * LAMPORTS_PER_SOL);
    
    console.log(`[SolanaPurchases] Initiating payment via ${status.walletType}: ${priceInfo.sol.toFixed(6)} SOL ($${priceInfo.usd}) for ${tierGb}GB ${duration}`);
    
    // Create transaction
    const payerPubkey = new PublicKey(status.address);
    const recipientPubkey = new PublicKey(PAYMENT_WALLET);
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: payerPubkey,
      toPubkey: recipientPubkey,
      lamports,
    });
    
    const messageV0 = new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: blockhash,
      instructions: [transferInstruction],
    }).compileToV0Message();
    
    const transaction = new VersionedTransaction(messageV0);
    
    // Sign and send via WalletAdapter
    const txResult = await WalletAdapter.signAndSendTransaction(transaction);
    
    if (!txResult.success) {
      if (txResult.userCancelled) {
        return { success: false, error: 'cancelled', userCancelled: true };
      }
      return { success: false, error: txResult.error || 'Transaction failed' };
    }
    
    const txSignature = txResult.signature;
    console.log('[SolanaPurchases] Transaction submitted:', txSignature);
    
    // Notify server about the payment
    const serverResult = await notifyServerOfPayment(txSignature, authToken, tierGb, duration, priceInfo.sol);
    
    if (serverResult.success) {
      console.log('[SolanaPurchases] Payment verified by server:', txSignature);
      return {
        success: true,
        txSignature,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        walletType: status.walletType,
        serverNotified: true,
      };
    } else {
      console.log('[SolanaPurchases] Server verification pending:', serverResult.error);
      return {
        success: true,
        txSignature,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        walletType: status.walletType,
        serverNotified: false,
        pendingVerification: true,
      };
    }
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled') || e.message?.includes('CancellationException')) {
      return { success: false, error: 'cancelled', userCancelled: true };
    }
    if (e.message?.includes('timeout') || e.message?.includes('TimeoutException')) {
      console.log('[SolanaPurchases] Transaction may have been sent, check wallet for confirmation');
      return { success: false, errorKey: 'transactionTimeout', timeout: true };
    }
    console.log('[SolanaPurchases] Payment failed:', e.message);
    return { success: false, errorKey: 'paymentFailed', error: e.message };
  }
};

/**
 * Purchase a subscription plan using SKR token (50% discount)
 * @param {number} tierGb - Plan tier in GB (100, 200, 400, 1000)
 * @param {string} authToken - User's auth token for server authentication
 * @param {string} duration - 'monthly' or 'yearly'
 * @param {string} walletType - Optional: specific wallet type to use
 * @returns {Object} { success, txSignature, error }
 */
export const purchaseWithSkr = async (tierGb, authToken, duration = 'monthly', walletType = null) => {
  // Dynamically import SPL Token libraries
  let splTokenAvailable = false;
  let createTransferInstruction = null;
  let getAssociatedTokenAddress = null;
  let getAccount = null;
  let createAssociatedTokenAccountInstruction = null;
  let ASSOCIATED_TOKEN_PROGRAM_ID = null;
  let TOKEN_PROGRAM_ID = null;

  try {
    const splModule = require('@solana/spl-token');
    createTransferInstruction = splModule.createTransferInstruction;
    getAssociatedTokenAddress = splModule.getAssociatedTokenAddress;
    getAccount = splModule.getAccount;
    createAssociatedTokenAccountInstruction = splModule.createAssociatedTokenAccountInstruction;
    ASSOCIATED_TOKEN_PROGRAM_ID = splModule.ASSOCIATED_TOKEN_PROGRAM_ID;
    TOKEN_PROGRAM_ID = splModule.TOKEN_PROGRAM_ID;
    splTokenAvailable = true;
  } catch (e) {
    console.log('[SolanaPurchases] SPL Token library not available:', e.message);
  }

  if (!splTokenAvailable || !createTransferInstruction || !getAssociatedTokenAddress) {
    return { success: false, error: 'SKR payments are not available on this build' };
  }

  if (!solanaAvailable || !connection) {
    return { success: false, error: 'Solana not available' };
  }

  if (!authToken) {
    return { success: false, error: 'Auth token required' };
  }

  try {
    // Initialize WalletAdapter if needed
    if (walletAdapterAvailable && WalletAdapter) {
      await WalletAdapter.initializeWalletAdapter();
    }

    // Check connection status
    let status = walletAdapterAvailable && WalletAdapter
      ? WalletAdapter.getConnectionStatus()
      : { isConnected: !!connectedWallet, address: connectedWallet, walletType: 'mwa' };

    // Determine wallet type
    const targetWalletType = walletType || (Platform.OS === 'ios' ? 'phantom' : 'mwa');

    // If not connected, connect to wallet
    if (!status.isConnected) {
      if (targetWalletType === 'mwa' || !walletAdapterAvailable) {
        // Use MWA for Android
        if (!transact) {
          return { success: false, error: 'Mobile Wallet Adapter not available' };
        }
      } else {
        const connectResult = await WalletAdapter.connectWallet(targetWalletType);
        if (!connectResult.success) {
          if (connectResult.userCancelled) {
            return { success: false, error: 'cancelled', userCancelled: true };
          }
          return { success: false, error: connectResult.error || 'Wallet connection failed' };
        }
        status = WalletAdapter.getConnectionStatus();
      }
    }

    // Get price with SKR discount
    const priceInfo = await getPlanPriceWithSkr(tierGb, duration);
    if (!priceInfo.skr || priceInfo.skr <= 0 || !priceInfo.skrPrice) {
      return { success: false, error: 'Could not calculate SKR price' };
    }

    const workingConnection = await getWorkingConnection();
    const mintPubkey = new PublicKey(SKR_TOKEN_MINT);
    const collectorOwner = new PublicKey(PAYMENT_WALLET);

    // Execute transaction via wallet
    let txSignature = null;

    if (targetWalletType === 'mwa' && transact) {
      // MWA flow
      txSignature = await transact(async (wallet) => {
        const authResult = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: APP_IDENTITY,
        });

        const payerAddress = authResult.accounts[0].address;
        const payerBytes = typeof payerAddress === 'string'
          ? Uint8Array.from(atob(payerAddress), c => c.charCodeAt(0))
          : new Uint8Array(payerAddress);
        const payerPubkey = new PublicKey(payerBytes);

        // Get token accounts
        const ownerTokenAccount = await getAssociatedTokenAddress(mintPubkey, payerPubkey);
        const collectorTokenAccount = await getAssociatedTokenAddress(mintPubkey, collectorOwner);

        // Check balance
        const ownerBalance = await workingConnection.getTokenAccountBalance(ownerTokenAccount).catch(() => null);
        const amountRaw = Math.ceil(priceInfo.skr * Math.pow(10, 6)); // Assuming 6 decimals
        if (!ownerBalance || Number(ownerBalance.value.amount) < amountRaw) {
          throw new Error(`Insufficient ${SKR_TOKEN_SYMBOL} balance. Need ${priceInfo.skrAmountFormatted}`);
        }

        // Build instructions
        const instructions = [];

        // Check if collector ATA exists
        const collectorAtaInfo = await workingConnection.getAccountInfo(collectorTokenAccount);
        if (!collectorAtaInfo) {
          // Create ATA for collector if needed
          instructions.push(
            createAssociatedTokenAccountInstruction(
              payerPubkey,
              collectorTokenAccount,
              collectorOwner,
              mintPubkey,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }

        // Add transfer instruction
        instructions.push(
          createTransferInstruction(
            ownerTokenAccount,
            collectorTokenAccount,
            payerPubkey,
            amountRaw,
            [],
            TOKEN_PROGRAM_ID
          )
        );

        // Build transaction
        const { blockhash } = await workingConnection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
          payerKey: payerPubkey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);

        // Sign transaction
        const signedTransactions = await wallet.signTransactions({
          transactions: [transaction],
        });

        return signedTransactions[0];
      });

      // Send transaction outside MWA session
      await new Promise(resolve => setTimeout(resolve, 500));
      for (let i = 0; i < SOLANA_RPC_ENDPOINTS.length; i++) {
        try {
          const endpoint = SOLANA_RPC_ENDPOINTS[i];
          const sendConnection = new Connection(endpoint, 'confirmed');
          txSignature = await sendConnection.sendRawTransaction(txSignature.serialize(), {
            skipPreflight: true,
            preflightCommitment: 'confirmed',
            maxRetries: 3,
          });
          break;
        } catch (e) {
          if (i === SOLANA_RPC_ENDPOINTS.length - 1) throw e;
        }
      }
    } else {
      // WalletAdapter flow (Phantom, etc.)
      if (!status.address) {
        return { success: false, error: 'No wallet address' };
      }

      const payerPubkey = new PublicKey(status.address);
      const ownerTokenAccount = await getAssociatedTokenAddress(mintPubkey, payerPubkey);
      const collectorTokenAccount = await getAssociatedTokenAddress(mintPubkey, collectorOwner);

      // Check balance
      const ownerBalance = await workingConnection.getTokenAccountBalance(ownerTokenAccount).catch(() => null);
      const amountRaw = Math.ceil(priceInfo.skr * Math.pow(10, 6));
      if (!ownerBalance || Number(ownerBalance.value.amount) < amountRaw) {
        return { success: false, error: `Insufficient ${SKR_TOKEN_SYMBOL} balance. Need ${priceInfo.skrAmountFormatted}` };
      }

      // Build instructions
      const instructions = [];

      // Check if collector ATA exists
      const collectorAtaInfo = await workingConnection.getAccountInfo(collectorTokenAccount);
      if (!collectorAtaInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            payerPubkey,
            collectorTokenAccount,
            collectorOwner,
            mintPubkey,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      // Add transfer instruction
      instructions.push(
        createTransferInstruction(
          ownerTokenAccount,
          collectorTokenAccount,
          payerPubkey,
          amountRaw,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      // Build and sign transaction
      const { blockhash } = await workingConnection.getLatestBlockhash('confirmed');
      const messageV0 = new TransactionMessage({
        payerKey: payerPubkey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);

      const txResult = await WalletAdapter.signAndSendTransaction(transaction);
      if (!txResult.success) {
        if (txResult.userCancelled) {
          return { success: false, error: 'cancelled', userCancelled: true };
        }
        return { success: false, error: txResult.error || 'Transaction failed' };
      }
      txSignature = txResult.signature;
    }

    console.log('[SolanaPurchases] SKR transaction submitted:', txSignature);

    // Wait for RPC to index token transfer metadata before asking server to verify
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Notify server about the payment with SKR flag
    const serverResult = await notifyServerOfSkrPayment(txSignature, authToken, tierGb, duration, priceInfo.skr);

    if (serverResult.success) {
      console.log('[SolanaPurchases] SKR payment verified by server:', txSignature);
      return {
        success: true,
        txSignature,
        skrAmount: priceInfo.skr,
        usdAmount: priceInfo.discountedUsd,
        walletType: status.walletType,
        paymentMethod: 'skr',
        serverNotified: true,
      };
    } else {
      console.log('[SolanaPurchases] SKR server verification pending:', serverResult.error);
      return {
        success: true,
        txSignature,
        skrAmount: priceInfo.skr,
        usdAmount: priceInfo.discountedUsd,
        walletType: status.walletType,
        paymentMethod: 'skr',
        serverNotified: false,
        pendingVerification: true,
      };
    }
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled') || e.message?.includes('CancellationException')) {
      return { success: false, error: 'cancelled', userCancelled: true };
    }
    if (e.message?.includes('timeout') || e.message?.includes('TimeoutException')) {
      return { success: false, errorKey: 'transactionTimeout', timeout: true };
    }
    console.log('[SolanaPurchases] SKR payment failed:', e.message);
    return { success: false, error: e.message || 'Payment failed' };
  }
};

/**
 * Notify server about SKR payment
 */
const notifyServerOfSkrPayment = async (txSignature, authToken, tierGb, duration, skrAmount) => {
  const maxAttempts = 3;
  const retryDelays = [0, 5000, 10000]; // 1st immediate, 2nd after 5s, 3rd after 10s
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      console.log(`[SolanaPurchases] SKR verify retry ${attempt}/${maxAttempts - 1} in ${retryDelays[attempt] / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelays[attempt]));
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const response = await axios.post(`${STEALTHCLOUD_BASE_URL}/api/solana/verify-skr-payment`, {
        txSignature,
        tierGb,
        duration,
        skrAmount,
        paymentWallet: PAYMENT_WALLET,
        tokenMint: SKR_TOKEN_MINT,
        tokenSymbol: SKR_TOKEN_SYMBOL,
      }, {
        timeout: 30000,
        headers,
      });

      if (response.data?.success) {
        console.log('[SolanaPurchases] Server verified SKR payment');
        await clearPendingSubscriptionVerification();
        return { success: true };
      }

      lastError = response.data?.error || 'Verification failed';
    } catch (e) {
      if (e.response?.status === 409) {
        await clearPendingSubscriptionVerification();
        return { success: true };
      }
      lastError = e.message;
      console.log(`[SolanaPurchases] SKR verify attempt ${attempt + 1} failed:`, e.response?.status || e.message);
    }
  }

  console.log('[SolanaPurchases] SKR server notification pending after all attempts, will retry later');
  await savePendingSubscriptionVerification(txSignature, tierGb, duration, skrAmount, 'skr');
  return { success: false, error: lastError };
};

/**
 * Get available wallets for payment
 * @returns {Array} List of available wallet types
 */
export const getAvailablePaymentWallets = async () => {
  if (!walletAdapterAvailable || !WalletAdapter) {
    // Fallback: only MWA available on Android
    if (Platform.OS === 'android' && solanaAvailable) {
      return [{
        type: 'mwa',
        name: 'Mobile Wallet',
        description: 'Seeker, Phantom, Solflare',
        isInstalled: true,
      }];
    }
    return [];
  }
  
  try {
    await WalletAdapter.initializeWalletAdapter();
    return await WalletAdapter.getAvailableWallets();
  } catch (e) {
    console.error('[SolanaPurchases] Failed to get available wallets:', e);
    return [];
  }
};

/**
 * Get current wallet connection status
 * @returns {Object} { isConnected, address, walletType }
 */
export const getWalletConnectionStatus = () => {
  if (!walletAdapterAvailable || !WalletAdapter) {
    return { isConnected: !!connectedWallet, address: connectedWallet, walletType: 'mwa' };
  }
  return WalletAdapter.getConnectionStatus();
};

/**
 * Disconnect current wallet (universal)
 */
export const disconnectCurrentWallet = async () => {
  if (walletAdapterAvailable && WalletAdapter) {
    await WalletAdapter.disconnectWallet();
  }
  await disconnectWallet();
};

/**
 * Notify the StealthCloud server about a successful payment
 * Server will verify the transaction on-chain and activate the subscription
 */
const notifyServerOfPayment = async (txSignature, authToken, tierGb, duration, solAmount) => {
  const maxAttempts = 3;
  const retryDelays = [0, 5000, 10000]; // 1st immediate, 2nd after 5s, 3rd after 10s
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      console.log(`[SolanaPurchases] SOL verify retry ${attempt}/${maxAttempts - 1} in ${retryDelays[attempt] / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelays[attempt]));
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      
      const response = await axios.post(`${STEALTHCLOUD_BASE_URL}/api/solana/verify-payment`, {
        txSignature,
        tierGb,
        duration,
        solAmount,
        paymentWallet: PAYMENT_WALLET,
      }, {
        timeout: 30000,
        headers,
      });
      
      if (response.data?.success) {
        console.log('[SolanaPurchases] Server verified payment');
        await clearPendingSubscriptionVerification();
        return { success: true };
      }
      
      lastError = response.data?.error || 'Verification failed';
    } catch (e) {
      if (e.response?.status === 409) {
        await clearPendingSubscriptionVerification();
        return { success: true };
      }
      lastError = e.message;
      console.log(`[SolanaPurchases] SOL verify attempt ${attempt + 1} failed:`, e.response?.status || e.message);
    }
  }

  console.log('[SolanaPurchases] Server notification pending after all attempts, will retry later');
  await savePendingSubscriptionVerification(txSignature, tierGb, duration, solAmount, 'sol');
  return { success: false, error: lastError };
};

// ============================================================================
// PREMIUM PURCHASE (one-time, $49.99 in SOL)
// ============================================================================

/**
 * Get premium price in SOL
 * @returns {Object} { usd, sol, solFormatted, solPrice }
 */
export const getPremiumPriceInSol = async () => {
  const solPrice = await fetchSolPrice();
  if (!solPrice || solPrice <= 0) return { usd: PREMIUM_PRICE_USD, sol: 0, solFormatted: '—', solPrice: 0 };
  const solAmount = PREMIUM_PRICE_USD / solPrice;
  return {
    usd: PREMIUM_PRICE_USD,
    sol: solAmount,
    solFormatted: solAmount.toFixed(6),
    solPrice,
  };
};

/**
 * Get premium price with SKR discount
 * @returns {Object} { usd, sol, skr, skrAmount, skrFormatted, discountPercent, savingsUsd }
 */
export const getPremiumPriceWithSkr = async () => {
  const baseUsd = PREMIUM_PRICE_USD;
  const discountedUsd = baseUsd * SKR_SUBSCRIPTION_MULTIPLIER; // discount disabled (multiplier = 1.0)

  // Fetch prices
  const [solPrice, skrPrice] = await Promise.all([
    fetchSolPrice(),
    fetchSkrPrice(),
  ]);

  if (!solPrice || solPrice <= 0 || !skrPrice || skrPrice <= 0) {
    return { usd: baseUsd, sol: 0, skr: 0, skrAmount: 0, skrFormatted: '0', discountPercent: 0, savingsUsd: 0 };
  }

  const solAmount = discountedUsd / solPrice;
  const skrAmount = discountedUsd / skrPrice;

  return {
    usd: baseUsd,
    sol: solAmount,
    solFormatted: solAmount.toFixed(6),
    solPrice,
    skr: skrAmount,
    skrAmount,
    skrAmountFormatted: skrAmount > 0 ? `${skrAmount.toFixed(2)} ${SKR_TOKEN_SYMBOL}` : `— ${SKR_TOKEN_SYMBOL}`,
    skrPrice,
    discountPercent: SKR_SUBSCRIPTION_DISCOUNT_PERCENT,
    savingsUsd: baseUsd - discountedUsd,
    discountedUsd,
  };
};

/**
 * Purchase premium using SKR tokens (50% discount)
 * @param {string} userAuthToken - User's auth token for server authentication
 * @returns {Object} { success, txSignature, error }
 */
export const purchasePremiumWithSkr = async (userAuthToken) => {
  if (!solanaAvailable || !transact) {
    return { success: false, error: 'Solana not available' };
  }
  if (!userAuthToken) {
    return { success: false, error: 'Auth token required' };
  }

  // Dynamically import SPL Token libraries
  let splTokenAvailable = false;
  let createTransferInstruction = null;
  let getAssociatedTokenAddress = null;
  let createAssociatedTokenAccountInstruction = null;
  let ASSOCIATED_TOKEN_PROGRAM_ID = null;
  let TOKEN_PROGRAM_ID = null;

  try {
    const splModule = require('@solana/spl-token');
    createTransferInstruction = splModule.createTransferInstruction;
    getAssociatedTokenAddress = splModule.getAssociatedTokenAddress;
    createAssociatedTokenAccountInstruction = splModule.createAssociatedTokenAccountInstruction;
    ASSOCIATED_TOKEN_PROGRAM_ID = splModule.ASSOCIATED_TOKEN_PROGRAM_ID;
    TOKEN_PROGRAM_ID = splModule.TOKEN_PROGRAM_ID;
    splTokenAvailable = true;
  } catch (e) {
    console.log('[SolanaPurchases] SPL Token library not available:', e.message);
  }

  if (!splTokenAvailable || !createTransferInstruction || !getAssociatedTokenAddress || !createAssociatedTokenAccountInstruction || !TOKEN_PROGRAM_ID) {
    return { success: false, error: 'SKR payments are not available on this build' };
  }

  try {
    const priceInfo = await getPremiumPriceWithSkr();
    if (!priceInfo.skrAmount || priceInfo.skrAmount <= 0 || !priceInfo.skrPrice) {
      return { success: false, error: 'Could not calculate SKR price' };
    }

    const workingConnection = await getWorkingConnection();
    if (!workingConnection) {
      return { success: false, error: 'Cannot connect to Solana network' };
    }

    const skrTokenAmount = priceInfo.skrAmount;
    const skrAmountRaw = Math.ceil(skrTokenAmount * Math.pow(10, SKR_TOKEN_DECIMALS));
    const collectorOwner = new PublicKey(PAYMENT_WALLET);
    const mintPubkey = new PublicKey(SKR_TOKEN_MINT);

    console.log(`[SolanaPurchases] Premium SKR payment: ${skrTokenAmount.toFixed(2)} ${SKR_TOKEN_SYMBOL} (~$${priceInfo.discountedUsd.toFixed(2)}, ${SKR_SUBSCRIPTION_DISCOUNT_PERCENT}% off)`);

    const signedTransaction = await transact(async (wallet) => {
      const authResult = await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
      });

      const payerAddress = authResult.accounts[0].address;
      const payerBytes = typeof payerAddress === 'string'
        ? Uint8Array.from(atob(payerAddress), c => c.charCodeAt(0))
        : new Uint8Array(payerAddress);
      const payerPubkey = new PublicKey(payerBytes);

      const ownerTokenAccount = await getAssociatedTokenAddress(mintPubkey, payerPubkey);
      const collectorTokenAccount = await getAssociatedTokenAddress(mintPubkey, collectorOwner);

      const ownerBalance = await workingConnection.getTokenAccountBalance(ownerTokenAccount).catch(() => null);
      if (!ownerBalance || Number(ownerBalance.value.amount) < skrAmountRaw) {
        throw new Error(`Insufficient ${SKR_TOKEN_SYMBOL} balance. Need ${priceInfo.skrAmountFormatted}`);
      }

      const instructions = [];

      const collectorAtaInfo = await workingConnection.getAccountInfo(collectorTokenAccount);
      if (!collectorAtaInfo) {
        console.log('[SolanaPurchases] Creating recipient ATA for premium SKR payment');
        instructions.push(
          createAssociatedTokenAccountInstruction(
            payerPubkey,
            collectorTokenAccount,
            collectorOwner,
            mintPubkey,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      instructions.push(
        createTransferInstruction(
          ownerTokenAccount,
          collectorTokenAccount,
          payerPubkey,
          skrAmountRaw,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      const { blockhash } = await workingConnection.getLatestBlockhash('confirmed');

      const messageV0 = new TransactionMessage({
        payerKey: payerPubkey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      const signedTransactions = await wallet.signTransactions({
        transactions: [transaction],
      });
      return signedTransactions[0];
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    // Send the signed transaction with RPC fallbacks
    let txSignatureFinal = null;
    let sendError = null;
    for (let i = 0; i < SOLANA_RPC_ENDPOINTS.length; i++) {
      try {
        const endpoint = SOLANA_RPC_ENDPOINTS[i];
        const sendConnection = new Connection(endpoint, 'confirmed');
        const signature = await sendConnection.sendRawTransaction(signedTransaction.serialize(), {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
        txSignatureFinal = signature;
        break;
      } catch (e) {
        if (i === SOLANA_RPC_ENDPOINTS.length - 1) console.log('[SolanaPurchases] All RPC endpoints failed for premium SKR tx');
        sendError = e;
      }
    }

    if (!txSignatureFinal) {
      return { success: false, error: `Failed to send transaction: ${sendError?.message || 'Unknown error'}` };
    }

    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 1500));

    const serverResult = await notifyServerOfPremiumSkrPayment(txSignatureFinal, userAuthToken, priceInfo.skrAmount);

    if (serverResult.success) {
      return {
        success: true,
        txSignature: txSignatureFinal,
        skrAmount: priceInfo.skrAmount,
        usdAmount: priceInfo.discountedUsd,
        paymentMethod: 'skr',
        discountPercent: SKR_SUBSCRIPTION_DISCOUNT_PERCENT,
        walletType: 'mwa',
        isPremium: serverResult.isPremium,
        serverNotified: true,
      };
    } else {
      return {
        success: true,
        pendingVerification: true,
        txSignature: txSignatureFinal,
        skrAmount: priceInfo.skrAmount,
        usdAmount: priceInfo.discountedUsd,
        paymentMethod: 'skr',
        warning: 'Payment sent but server verification pending. Your Premium will activate shortly.',
        serverNotified: false,
      };
    }
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled') || e.message?.includes('CancellationException')) {
      return { success: false, error: 'cancelled', userCancelled: true };
    }
    if (e.message?.includes(`Insufficient ${SKR_TOKEN_SYMBOL} balance`)) {
      return { success: false, error: e.message, insufficientBalance: true };
    }
    if (e.message?.includes('timeout') || e.message?.includes('TimeoutException')) {
      return { success: false, errorKey: 'transactionTimeout', timeout: true };
    }
    console.log('[SolanaPurchases] Premium SKR purchase error:', e.message);
    return { success: false, error: e.message || 'Transaction failed' };
  }
};

/**
 * Purchase premium using SOL via MWA (Android hardware wallet)
 * @param {string} userAuthToken - User's auth token for server authentication
 * @returns {Object} { success, txSignature, error }
 */
export const purchasePremiumWithSol = async (userAuthToken) => {
  if (!solanaAvailable || !transact) {
    return { success: false, error: 'Solana not available' };
  }
  if (!userAuthToken) {
    return { success: false, error: 'Auth token required' };
  }

  try {
    const workingConnection = await getWorkingConnection();
    if (!workingConnection) {
      return { success: false, error: 'Cannot connect to Solana network' };
    }

    const priceInfo = await getPremiumPriceInSol();
    if (!priceInfo.sol || priceInfo.sol <= 0) {
      return { success: false, error: 'Could not fetch SOL price' };
    }

    const lamports = Math.ceil(priceInfo.sol * LAMPORTS_PER_SOL);
    console.log(`[SolanaPurchases] Premium payment: ${priceInfo.sol.toFixed(6)} SOL ($${priceInfo.usd})`);

    // Pre-fetch blockhash BEFORE opening wallet session to avoid timeout
    const { blockhash } = await workingConnection.getLatestBlockhash('confirmed');
    const recipientPubkey = new PublicKey(PAYMENT_WALLET);

    // Execute transaction via Mobile Wallet Adapter
    const txSignature = await transact(async (wallet) => {
      const authResult = await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
      });

      const payerAddress = authResult.accounts[0].address;
      const payerBytes = typeof payerAddress === 'string'
        ? Uint8Array.from(atob(payerAddress), c => c.charCodeAt(0))
        : new Uint8Array(payerAddress);
      const payerPubkey = new PublicKey(payerBytes);

      const transferInstruction = SystemProgram.transfer({
        fromPubkey: payerPubkey,
        toPubkey: recipientPubkey,
        lamports,
      });

      const messageV0 = new TransactionMessage({
        payerKey: payerPubkey,
        recentBlockhash: blockhash,
        instructions: [transferInstruction],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      const signedTransactions = await wallet.signTransactions({
        transactions: [transaction],
      });
      return signedTransactions[0];
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    // Send the signed transaction with RPC fallbacks
    let txSignatureFinal = null;
    let sendError = null;
    for (let i = 0; i < SOLANA_RPC_ENDPOINTS.length; i++) {
      try {
        const endpoint = SOLANA_RPC_ENDPOINTS[i];
        const sendConnection = new Connection(endpoint, 'confirmed');
        const signature = await sendConnection.sendRawTransaction(txSignature.serialize(), {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
        txSignatureFinal = signature;
        break;
      } catch (e) {
        if (i === SOLANA_RPC_ENDPOINTS.length - 1) console.log('[SolanaPurchases] All RPC endpoints failed for premium tx');
        sendError = e;
      }
    }

    if (!txSignatureFinal) {
      throw sendError || new Error('Failed to send premium transaction to all RPC endpoints');
    }

    console.log('[SolanaPurchases] Premium transaction submitted:', txSignatureFinal);

    const serverResult = await notifyServerOfPremiumPayment(txSignatureFinal, userAuthToken, priceInfo.sol);

    if (serverResult.success) {
      return {
        success: true,
        txSignature: txSignatureFinal,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        isPremium: serverResult.isPremium,
        serverNotified: true,
      };
    } else {
      return {
        success: true,
        txSignature: txSignatureFinal,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        serverNotified: false,
        pendingVerification: true,
      };
    }
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled') || e.message?.includes('CancellationException')) {
      return { success: false, error: 'cancelled', userCancelled: true };
    }
    if (e.message?.includes('timeout') || e.message?.includes('TimeoutException')) {
      return { success: false, errorKey: 'transactionTimeout', timeout: true };
    }
    console.log('[SolanaPurchases] Premium payment failed:', e.message);
    return { success: false, errorKey: 'paymentFailed' };
  }
};

/**
 * Purchase premium using SOL via WalletAdapter (Universal)
 * Supports multiple wallets: MWA, Phantom, WalletConnect, MetaMask
 * @param {string} userAuthToken - User's auth token for server authentication
 * @param {string} walletType - Optional: specific wallet type to use
 * @returns {Object} { success, txSignature, error }
 */
export const purchasePremiumWithWallet = async (userAuthToken, walletType = null) => {
  // For MWA (Android), use single-session flow
  if (Platform.OS === 'android' && (!walletType || walletType === 'mwa')) {
    return purchasePremiumWithSol(userAuthToken);
  }

  if (!walletAdapterAvailable || !WalletAdapter) {
    return purchasePremiumWithSol(userAuthToken);
  }

  if (!solanaAvailable) {
    return { success: false, error: 'Solana not available' };
  }
  if (!userAuthToken) {
    return { success: false, error: 'Auth token required' };
  }

  try {
    const workingConnection = await getWorkingConnection();
    if (!workingConnection) {
      return { success: false, error: 'Cannot connect to Solana network' };
    }

    await WalletAdapter.initializeWalletAdapter();
    let status = WalletAdapter.getConnectionStatus();
    const targetWalletType = walletType || (Platform.OS === 'ios' ? 'phantom' : 'mwa');

    if (targetWalletType === 'mwa') {
      return purchasePremiumWithSol(userAuthToken);
    }

    if (!status.isConnected || status.walletType !== targetWalletType) {
      const connectResult = await WalletAdapter.connectWallet(targetWalletType);
      if (!connectResult.success) {
        if (connectResult.userCancelled) return { success: false, error: 'cancelled', userCancelled: true };
        return purchasePremiumWithSol(userAuthToken);
      }
      status = WalletAdapter.getConnectionStatus();
    }

    if (!status.address) return { success: false, error: 'No wallet address' };

    const priceInfo = await getPremiumPriceInSol();
    if (!priceInfo.sol || priceInfo.sol <= 0) {
      return { success: false, error: 'Could not fetch SOL price' };
    }

    const lamports = Math.ceil(priceInfo.sol * LAMPORTS_PER_SOL);
    console.log(`[SolanaPurchases] Premium payment via ${status.walletType}: ${priceInfo.sol.toFixed(6)} SOL ($${priceInfo.usd})`);

    const payerPubkey = new PublicKey(status.address);
    const recipientPubkey = new PublicKey(PAYMENT_WALLET);
    const { blockhash } = await workingConnection.getLatestBlockhash('confirmed');

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: payerPubkey,
      toPubkey: recipientPubkey,
      lamports,
    });

    const messageV0 = new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: blockhash,
      instructions: [transferInstruction],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    const txResult = await WalletAdapter.signAndSendTransaction(transaction);

    if (!txResult.success) {
      if (txResult.userCancelled) return { success: false, error: 'cancelled', userCancelled: true };
      return { success: false, error: txResult.error || 'Transaction failed' };
    }

    const txSig = txResult.signature;
    const serverResult = await notifyServerOfPremiumPayment(txSig, userAuthToken, priceInfo.sol);

    if (serverResult.success) {
      return {
        success: true,
        txSignature: txSig,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        walletType: status.walletType,
        isPremium: serverResult.isPremium,
        serverNotified: true,
      };
    } else {
      return {
        success: true,
        txSignature: txSig,
        solAmount: priceInfo.sol,
        usdAmount: priceInfo.usd,
        walletType: status.walletType,
        serverNotified: false,
        pendingVerification: true,
      };
    }
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled') || e.message?.includes('CancellationException')) {
      return { success: false, error: 'cancelled', userCancelled: true };
    }
    if (e.message?.includes('timeout') || e.message?.includes('TimeoutException')) {
      return { success: false, errorKey: 'transactionTimeout', timeout: true };
    }
    console.log('[SolanaPurchases] Premium payment failed:', e.message);
    return { success: false, errorKey: 'paymentFailed', error: e.message };
  }
};

/**
 * Purchase premium using SKR via Wallet Adapter (iOS Phantom or Android MWA)
 * @param {string} userAuthToken - User's auth token for server authentication
 * @param {string} walletType - Optional: specific wallet type to use
 * @returns {Object} { success, txSignature, error }
 */
export const purchasePremiumWithWalletSkr = async (userAuthToken, walletType = null) => {
  // Dynamically import SPL Token libraries
  let splTokenAvailable = false;
  let createTransferInstruction = null;
  let getAssociatedTokenAddress = null;
  let createAssociatedTokenAccountInstruction = null;
  let ASSOCIATED_TOKEN_PROGRAM_ID = null;
  let TOKEN_PROGRAM_ID = null;

  try {
    const splModule = require('@solana/spl-token');
    createTransferInstruction = splModule.createTransferInstruction;
    getAssociatedTokenAddress = splModule.getAssociatedTokenAddress;
    createAssociatedTokenAccountInstruction = splModule.createAssociatedTokenAccountInstruction;
    ASSOCIATED_TOKEN_PROGRAM_ID = splModule.ASSOCIATED_TOKEN_PROGRAM_ID;
    TOKEN_PROGRAM_ID = splModule.TOKEN_PROGRAM_ID;
    splTokenAvailable = true;
  } catch (e) {
    console.log('[SolanaPurchases] SPL Token library not available:', e.message);
  }

  if (!splTokenAvailable || !createTransferInstruction || !getAssociatedTokenAddress || !createAssociatedTokenAccountInstruction || !TOKEN_PROGRAM_ID) {
    return { success: false, error: 'SKR payments are not available on this build' };
  }

  // For MWA (Android), use single-session flow
  if (Platform.OS === 'android' && (!walletType || walletType === 'mwa')) {
    return purchasePremiumWithSkr(userAuthToken);
  }

  if (!walletAdapterAvailable || !WalletAdapter) {
    return purchasePremiumWithSkr(userAuthToken);
  }

  if (!solanaAvailable) {
    return { success: false, error: 'Solana not available' };
  }
  if (!userAuthToken) {
    return { success: false, error: 'Auth token required' };
  }

  try {
    const priceInfo = await getPremiumPriceWithSkr();
    if (!priceInfo.skrAmount || priceInfo.skrAmount <= 0 || !priceInfo.skrPrice) {
      return { success: false, error: 'Could not calculate SKR price' };
    }

    const skrTokenAmount = priceInfo.skrAmount;
    const skrAmountRaw = Math.ceil(skrTokenAmount * Math.pow(10, SKR_TOKEN_DECIMALS));
    console.log(`[SolanaPurchases] Premium SKR wallet payment: ${skrTokenAmount.toFixed(2)} ${SKR_TOKEN_SYMBOL} (~$${priceInfo.discountedUsd.toFixed(2)}, ${SKR_SUBSCRIPTION_DISCOUNT_PERCENT}% off)`);

    const workingConnection = await getWorkingConnection();
    if (!workingConnection) {
      return { success: false, error: 'Cannot connect to Solana network' };
    }

    await WalletAdapter.initializeWalletAdapter();
    let status = WalletAdapter.getConnectionStatus();
    const targetWalletType = walletType || (Platform.OS === 'ios' ? 'phantom' : 'mwa');

    if (targetWalletType === 'mwa') {
      return purchasePremiumWithSkr(userAuthToken);
    }

    if (!status.isConnected || status.walletType !== targetWalletType) {
      const connectResult = await WalletAdapter.connectWallet(targetWalletType);
      if (!connectResult.success) {
        if (connectResult.userCancelled) return { success: false, error: 'cancelled', userCancelled: true };
        return purchasePremiumWithSkr(userAuthToken);
      }
      status = WalletAdapter.getConnectionStatus();
    }

    if (!status.address) return { success: false, error: 'No wallet address' };

    const payerPubkey = new PublicKey(status.address);
    const collectorOwner = new PublicKey(PAYMENT_WALLET);
    const mintPubkey = new PublicKey(SKR_TOKEN_MINT);
    const { blockhash } = await workingConnection.getLatestBlockhash('confirmed');

    const ownerTokenAccount = await getAssociatedTokenAddress(mintPubkey, payerPubkey);
    const collectorTokenAccount = await getAssociatedTokenAddress(mintPubkey, collectorOwner);

    const ownerBalance = await workingConnection.getTokenAccountBalance(ownerTokenAccount).catch(() => null);
    if (!ownerBalance || Number(ownerBalance.value.amount) < skrAmountRaw) {
      return { success: false, error: `Insufficient ${SKR_TOKEN_SYMBOL} balance. Need ${priceInfo.skrAmountFormatted}`, insufficientBalance: true };
    }

    const instructions = [];

    const collectorAtaInfo = await workingConnection.getAccountInfo(collectorTokenAccount);
    if (!collectorAtaInfo) {
      console.log('[SolanaPurchases] Creating recipient ATA for premium SKR wallet payment');
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payerPubkey,
          collectorTokenAccount,
          collectorOwner,
          mintPubkey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    instructions.push(
      createTransferInstruction(
        ownerTokenAccount,
        collectorTokenAccount,
        payerPubkey,
        skrAmountRaw,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    const messageV0 = new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    const txResult = await WalletAdapter.signAndSendTransaction(transaction);

    if (!txResult.success) {
      if (txResult.userCancelled) return { success: false, error: 'cancelled', userCancelled: true };
      return { success: false, error: txResult.error || 'Transaction failed' };
    }

    const txSig = txResult.signature;

    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 1500));

    const serverResult = await notifyServerOfPremiumSkrPayment(txSig, userAuthToken, priceInfo.skrAmount);

    if (serverResult.success) {
      return {
        success: true,
        txSignature: txSig,
        skrAmount: priceInfo.skrAmount,
        usdAmount: priceInfo.discountedUsd,
        paymentMethod: 'skr',
        discountPercent: SKR_SUBSCRIPTION_DISCOUNT_PERCENT,
        walletType: status.walletType,
        isPremium: serverResult.isPremium,
        serverNotified: true,
      };
    } else {
      return {
        success: true,
        pendingVerification: true,
        txSignature: txSig,
        skrAmount: priceInfo.skrAmount,
        usdAmount: priceInfo.discountedUsd,
        paymentMethod: 'skr',
        discountPercent: SKR_SUBSCRIPTION_DISCOUNT_PERCENT,
        walletType: status.walletType,
        warning: 'Payment sent but server verification pending. Your Premium will activate shortly.',
        serverNotified: false,
      };
    }
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled') || e.message?.includes('CancellationException')) {
      return { success: false, error: 'cancelled', userCancelled: true };
    }
    if (e.message?.includes('timeout') || e.message?.includes('TimeoutException')) {
      return { success: false, errorKey: 'transactionTimeout', timeout: true };
    }
    console.log('[SolanaPurchases] Premium SKR wallet payment failed:', e.message);
    return { success: false, errorKey: 'paymentFailed', error: e.message };
  }
};

/**
 * Notify the StealthCloud server about a successful premium payment
 * Server verifies on-chain and activates premium in nft-service + main DB
 */
const notifyServerOfPremiumPayment = async (txSignature, userAuthToken, solAmount) => {
  const maxAttempts = 3;
  const retryDelays = [0, 5000, 10000];
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      console.log(`[SolanaPurchases] Premium SOL verify retry ${attempt}/${maxAttempts - 1} in ${retryDelays[attempt] / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelays[attempt]));
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;

      const response = await axios.post(`${STEALTHCLOUD_BASE_URL}/api/solana/verify-premium-payment`, {
        txSignature,
        solAmount,
        paymentWallet: PAYMENT_WALLET,
      }, {
        timeout: 30000,
        headers,
      });

      if (response.data?.success) {
        console.log('[SolanaPurchases] Server verified premium payment');
        await clearPendingPremiumVerification();
        return { success: true, isPremium: response.data.isPremium };
      }
      lastError = response.data?.error || 'Verification failed';
    } catch (e) {
      if (e.response?.status === 409 && (e.response?.data?.isPremium || e.response?.data?.error === 'Transaction already processed')) {
        await clearPendingPremiumVerification();
        return { success: true, isPremium: true };
      }
      lastError = e.message;
      console.log(`[SolanaPurchases] Premium SOL verify attempt ${attempt + 1} failed:`, e.response?.status || e.message);
    }
  }

  console.log('[SolanaPurchases] Premium server notification pending after all attempts, will retry later');
  await savePendingPremiumVerification(txSignature, solAmount, 'sol');
  return { success: false, error: lastError };
};

const notifyServerOfPremiumSkrPayment = async (txSignature, userAuthToken, skrAmount) => {
  const maxAttempts = 3;
  const retryDelays = [0, 5000, 10000];
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      console.log(`[SolanaPurchases] Premium SKR verify retry ${attempt}/${maxAttempts - 1} in ${retryDelays[attempt] / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelays[attempt]));
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;

      const response = await axios.post(`${STEALTHCLOUD_BASE_URL}/api/solana/verify-premium-skr-payment`, {
        txSignature,
        skrAmount,
        paymentWallet: PAYMENT_WALLET,
        tokenMint: SKR_TOKEN_MINT,
        tokenSymbol: SKR_TOKEN_SYMBOL,
      }, {
        timeout: 30000,
        headers,
      });

      if (response.data?.success) {
        await clearPendingPremiumVerification();
        return { success: true, isPremium: response.data.isPremium };
      }
      lastError = response.data?.error || 'Verification failed';
    } catch (e) {
      if (e.response?.status === 409 && (e.response?.data?.isPremium || e.response?.data?.error === 'Transaction already processed')) {
        await clearPendingPremiumVerification();
        return { success: true, isPremium: true };
      }
      lastError = e.message;
      console.log(`[SolanaPurchases] Premium SKR verify attempt ${attempt + 1} failed:`, e.response?.status || e.message);
    }
  }

  console.log('[SolanaPurchases] Premium SKR server notification pending after all attempts');
  await savePendingPremiumVerification(txSignature, skrAmount, 'skr');
  return { success: false, error: lastError };
};

export const retryPendingPremiumVerification = async (userAuthToken) => {
  try {
    const pendingStr = await SecureStore.getItemAsync(PENDING_PREMIUM_KEY);
    if (!pendingStr) {
      return { success: true, hadPending: false };
    }

    const pending = JSON.parse(pendingStr);
    const { txSignature, solAmount, skrAmount, paymentMethod = 'sol', retryCount = 0 } = pending || {};
    if (!txSignature) {
      await clearPendingPremiumVerification();
      return { success: false, hadPending: true, error: 'Missing transaction signature' };
    }

    if (retryCount >= 50) {
      return { success: false, hadPending: true, maxRetriesReached: true, txSignature };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;

    const isSkrPayment = paymentMethod === 'skr' || (!!skrAmount && !solAmount);
    const response = await axios.post(
      `${STEALTHCLOUD_BASE_URL}${isSkrPayment ? '/api/solana/verify-premium-skr-payment' : '/api/solana/verify-premium-payment'}`,
      isSkrPayment
        ? {
            txSignature,
            skrAmount,
            paymentWallet: PAYMENT_WALLET,
            tokenMint: SKR_TOKEN_MINT,
            tokenSymbol: SKR_TOKEN_SYMBOL,
          }
        : {
            txSignature,
            solAmount,
            paymentWallet: PAYMENT_WALLET,
          },
      {
      timeout: 30000,
      headers,
      }
    );

    if (response.data?.success || response.data?.error === 'Already premium') {
      await clearPendingPremiumVerification();
      return { success: true, hadPending: true, isPremium: true };
    }

    pending.retryCount = retryCount + 1;
    await SecureStore.setItemAsync(PENDING_PREMIUM_KEY, JSON.stringify(pending));
    return { success: false, hadPending: true, error: response.data?.error || 'Verification failed' };
  } catch (e) {
    if (e.response?.status === 409 && e.response?.data?.isPremium) {
      await clearPendingPremiumVerification();
      return { success: true, hadPending: true, isPremium: true };
    }
    try {
      const pendingStr = await SecureStore.getItemAsync(PENDING_PREMIUM_KEY);
      if (pendingStr) {
        const pending = JSON.parse(pendingStr);
        pending.retryCount = (pending.retryCount || 0) + 1;
        await SecureStore.setItemAsync(PENDING_PREMIUM_KEY, JSON.stringify(pending));
      }
    } catch (_) {}
    return { success: false, hadPending: true, error: e.message };
  }
};

export const retryPendingSubscriptionVerification = async (userAuthToken) => {
  try {
    const pendingStr = await SecureStore.getItemAsync(PENDING_SUBSCRIPTION_KEY);
    if (!pendingStr) {
      return { success: true, hadPending: false };
    }

    const pending = JSON.parse(pendingStr);
    const { txSignature, tierGb, duration, solAmount, skrAmount, paymentMethod = 'sol', retryCount = 0 } = pending || {};
    if (!txSignature || !tierGb) {
      await clearPendingSubscriptionVerification();
      return { success: false, hadPending: true, error: 'Missing transaction data' };
    }

    if (retryCount >= 50) {
      return { success: false, hadPending: true, maxRetriesReached: true, txSignature };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;

    const isSkrPayment = paymentMethod === 'skr' || (!!skrAmount && !solAmount);
    const response = await axios.post(
      `${STEALTHCLOUD_BASE_URL}${isSkrPayment ? '/api/solana/verify-skr-payment' : '/api/solana/verify-payment'}`,
      isSkrPayment
        ? { txSignature, tierGb, duration, skrAmount, paymentWallet: PAYMENT_WALLET, tokenMint: SKR_TOKEN_MINT, tokenSymbol: SKR_TOKEN_SYMBOL }
        : { txSignature, tierGb, duration, solAmount, paymentWallet: PAYMENT_WALLET },
      { timeout: 30000, headers }
    );

    if (response.data?.success) {
      await clearPendingSubscriptionVerification();
      console.log('[SolanaPurchases] Pending subscription verification succeeded:', txSignature);
      return { success: true, hadPending: true, tierGb };
    }

    pending.retryCount = retryCount + 1;
    await SecureStore.setItemAsync(PENDING_SUBSCRIPTION_KEY, JSON.stringify(pending));
    return { success: false, hadPending: true, error: response.data?.error || 'Verification failed' };
  } catch (e) {
    if (e.response?.status === 409) {
      await clearPendingSubscriptionVerification();
      return { success: true, hadPending: true };
    }
    try {
      const pendingStr = await SecureStore.getItemAsync(PENDING_SUBSCRIPTION_KEY);
      if (pendingStr) {
        const pending = JSON.parse(pendingStr);
        pending.retryCount = (pending.retryCount || 0) + 1;
        await SecureStore.setItemAsync(PENDING_SUBSCRIPTION_KEY, JSON.stringify(pending));
      }
    } catch (_) {}
    return { success: false, hadPending: true, error: e.message };
  }
};

// ============================================================================
// SUBSCRIPTION STATUS
// ============================================================================

/**
 * Get current subscription status from server
 * @param {string} token - Auth token
 * @param {string} deviceUuid - Device UUID
 * @returns {Object} Subscription status
 */
export const getSubscriptionStatus = async (token, deviceUuid) => {
  try {
    const response = await axios.get(`${STEALTHCLOUD_BASE_URL}/api/cloud/usage`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Device-UUID': deviceUuid,
      },
      timeout: 30000,
    });
    
    const data = response.data || {};
    const subscription = data.subscription || {};
    
    const premiumGb = Number(data.premiumGb) || 0;
    return {
      isActive: subscription.status === 'active' || subscription.status === 'trial',
      isInGracePeriod: subscription.status === 'grace',
      status: subscription.status || 'none',
      tierGb: data.planGb || null,
      expiresAt: subscription.expiresAt ? new Date(subscription.expiresAt) : null,
      usedBytes: data.usedBytes || 0,
      remainingBytes: data.remainingBytes || 0,
      quotaBytes: data.quotaBytes || 0,
      purchasedVia: subscription.purchased_via || subscription.purchasedVia || subscription.paymentType || null,
      paymentType: subscription.paymentType || subscription.purchased_via || subscription.purchasedVia || null,
      isPremium: premiumGb > 0 || subscription.status === 'premium_only',
      premiumGb,
    };
  } catch (e) {
    // Silently fail - don't spam console with subscription errors
    return {
      isActive: false,
      isInGracePeriod: false,
      status: 'unknown',
      tierGb: null,
      expiresAt: null,
    };
  }
};

/**
 * Check if user can upload (active subscription or in grace period)
 * @param {string} token - Auth token
 * @param {string} deviceUuid - Device UUID
 * @returns {Object} { canUpload, reason, message }
 */
export const checkUploadAccess = async (token, deviceUuid) => {
  const status = await getSubscriptionStatus(token, deviceUuid);
  
  if (status.isActive) {
    return { canUpload: true, reason: 'active' };
  }
  
  if (status.isInGracePeriod) {
    return {
      canUpload: false,
      canSync: true,
      reason: 'grace',
      message: 'Subscription expired. You have a few days to sync your data.',
    };
  }
  
  return {
    canUpload: false,
    canSync: false,
    reason: 'expired',
    message: 'Subscription expired. Please renew with SOL to continue.',
  };
};

// ============================================================================
// AVAILABLE PLANS
// ============================================================================

/**
 * Get all available plans with current SOL prices
 * @returns {Array} [{ tierGb, usd, sol, solFormatted, title }]
 */
export const getAvailablePlans = async () => {
  const solPrice = await fetchSolPrice();
  
  const plans = [];
  for (const [tierGb, usdPrice] of Object.entries(PLAN_PRICES_USD)) {
    const tier = parseInt(tierGb);
    const solAmount = usdPrice / solPrice;
    
    plans.push({
      tierGb: tier,
      usd: usdPrice,
      sol: solAmount,
      solFormatted: solAmount.toFixed(6),
      solPrice,
      title: tier === 1000 ? '1 TB' : `${tier} GB`,
      description: 'Monthly subscription',
      priceString: `${solAmount.toFixed(4)} SOL (~$${usdPrice})`,
    });
  }
  
  // Sort by tier size
  plans.sort((a, b) => a.tierGb - b.tierGb);
  
  return plans;
};

// ============================================================================
// TRANSACTION HISTORY
// ============================================================================

/**
 * Get recent payment transactions for the connected wallet
 * @param {number} limit - Number of transactions to fetch
 * @returns {Array} Transaction history
 */
export const getPaymentHistory = async (limit = 10) => {
  if (!solanaAvailable || !connection || !connectedWallet) {
    return [];
  }
  
  try {
    const pubkey = new PublicKey(connectedWallet);
    const recipientPubkey = new PublicKey(PAYMENT_WALLET);
    
    // Get recent signatures
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 50 });
    
    const payments = [];
    for (const sig of signatures) {
      try {
        const tx = await connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        
        if (!tx || !tx.meta) continue;
        
        // Check if this is a payment to our wallet
        const accountKeys = tx.transaction.message.staticAccountKeys || 
                           tx.transaction.message.accountKeys;
        
        const recipientIndex = accountKeys.findIndex(
          (key) => key.toBase58() === PAYMENT_WALLET
        );
        
        if (recipientIndex === -1) continue;
        
        // Get the transfer amount
        const preBalance = tx.meta.preBalances[recipientIndex];
        const postBalance = tx.meta.postBalances[recipientIndex];
        const amount = (postBalance - preBalance) / LAMPORTS_PER_SOL;
        
        if (amount > 0) {
          payments.push({
            signature: sig.signature,
            amount,
            timestamp: sig.blockTime ? new Date(sig.blockTime * 1000) : null,
            status: tx.meta.err ? 'failed' : 'confirmed',
          });
        }
        
        if (payments.length >= limit) break;
      } catch (e) {
        // Skip failed transaction fetches
      }
    }
    
    return payments;
  } catch (e) {
    console.error('Failed to get payment history:', e);
    return [];
  }
};

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  initializeSolana,
  connectWallet,
  disconnectWallet,
  getConnectedWallet,
  getWalletBalance,
  fetchSolPrice,
  usdToSol,
  getPlanPriceInSol,
  getPlanPriceWithSkr,
  getPremiumPriceInSol,
  getPremiumPriceWithSkr,
  purchaseWithSol,
  purchaseWithWallet,
  purchaseWithSkr,
  purchasePremiumWithSol,
  purchasePremiumWithWallet,
  purchasePremiumWithSkr,
  purchasePremiumWithWalletSkr,
  retryPendingSubscriptionVerification,
  getAvailablePaymentWallets,
  getWalletConnectionStatus,
  disconnectCurrentWallet,
  getSubscriptionStatus,
  checkUploadAccess,
  getAvailablePlans,
  getPaymentHistory,
  PAYMENT_WALLET,
  PLAN_PRICES_USD,
  PLAN_DURATIONS,
  GRACE_PERIOD_DAYS,
  PREMIUM_PRICE_USD,
  SKR_TOKEN_SYMBOL,
  SKR_TOKEN_DECIMALS,
  SKR_SUBSCRIPTION_DISCOUNT_PERCENT,
  solanaAvailable: () => solanaAvailable,
  walletAdapterAvailable: () => walletAdapterAvailable,
};
