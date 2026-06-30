// Mobile Wallet Adapter (MWA) - Android Solana Wallets
// Supports: Seeker/Saga hardware wallet, Phantom, Solflare, and other MWA-compatible wallets
// Platform: Android only

import { Platform } from 'react-native';

// Solana imports
let Connection, PublicKey, LAMPORTS_PER_SOL;
let transact;
let mwaAvailable = false;

try {
  const web3 = require('@solana/web3.js');
  Connection = web3.Connection;
  PublicKey = web3.PublicKey;
  LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
  
  const mwa = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
  transact = mwa.transact;
  
  mwaAvailable = true;
  console.log('[MWAAdapter] Mobile Wallet Adapter loaded');
} catch (e) {
  console.log('[MWAAdapter] MWA not available:', e.message);
}

// Configuration
const SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

const APP_IDENTITY = {
  name: 'PhotoLynk',
  uri: 'https://stealthlynk.io',
  icon: 'favicon.ico',
};

// Known MWA-compatible wallets (display only — URI comes from authorize response).
export const KNOWN_MWA_WALLETS = [
  { id: 'seedvault', name: 'Seed Vault' },
  { id: 'phantom', name: 'Phantom' },
  { id: 'solflare', name: 'Solflare' },
];

// Per MWA 2.0 spec: wallet returns `wallet_uri_base` in authorize response.
// We save it and pass as `baseUri` config to subsequent transact() calls so
// Android skips the chooser and routes directly to the same wallet.
let _savedWalletUriBase = null;
export const getSavedWalletUriBase = () => _savedWalletUriBase;
export const clearSavedWalletUriBase = () => { _savedWalletUriBase = null; };

// State
let connection = null;
let authToken = null;
let connectedAddress = null;

// ============================================================================
// ADAPTER INTERFACE
// ============================================================================

/**
 * Check if MWA is available on this device
 */
export const isAvailable = async () => {
  // MWA only works on Android
  if (Platform.OS !== 'android') {
    return false;
  }
  return mwaAvailable;
};

/**
 * Get adapter name
 */
export const getName = () => 'Mobile Wallet Adapter';

/**
 * Connect to wallet via MWA
 * @returns {Object} { success, address, error }
 */
/**
 * Legacy compat stubs — replaced by _savedWalletUriBase auto-save.
 */
export const setWalletUriBase = () => {};
export const getWalletUriBase = () => _savedWalletUriBase;

/**
 * Connect to wallet via MWA.
 * @param {Object} opts
 * @param {boolean} opts.forceChooser - Clear saved URI to show Android chooser again.
 */
export const connect = async ({ forceChooser = false } = {}) => {
  if (!mwaAvailable || !transact) {
    return { success: false, error: 'MWA not available' };
  }
  
  if (forceChooser) _savedWalletUriBase = null;
  const config = _savedWalletUriBase ? { baseUri: _savedWalletUriBase } : undefined;
  
  const run = async (cfg) => {
    // Initialize connection if needed
    if (!connection) {
      connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    }
    
    const result = await transact(async (wallet) => {
      const authResult = await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
      });
      
      // Per MWA 2.0 spec: save wallet_uri_base for subsequent connections.
      if (authResult.wallet_uri_base) _savedWalletUriBase = authResult.wallet_uri_base;
      
      // MWA returns address as base64, convert to string
      const addressBytes = typeof authResult.accounts[0].address === 'string'
        ? Uint8Array.from(atob(authResult.accounts[0].address), c => c.charCodeAt(0))
        : new Uint8Array(authResult.accounts[0].address);
      const pubkey = new PublicKey(addressBytes);
      
      return {
        address: pubkey.toBase58(),
        authToken: authResult.auth_token,
        label: authResult.accounts[0].label || null,
      };
    }, cfg);
    
    connectedAddress = result.address;
    authToken = result.authToken;
    
    console.log('[MWAAdapter] Connected:', result.address, 'label:', result.label);
    return { success: true, address: result.address, label: result.label || null };
  };
  
  try {
    return await run(config);
  } catch (e) {
    // If saved URI fails (wallet uninstalled?), retry without it (shows chooser).
    if (config) { _savedWalletUriBase = null; try { return await run(undefined); } catch (_) {} }
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    console.error('[MWAAdapter] Connection failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Disconnect wallet
 */
export const disconnect = async () => {
  connectedAddress = null;
  authToken = null;
  _savedWalletUriBase = null;
  console.log('[MWAAdapter] Disconnected');
};

/**
 * Sign and send a transaction
 * @param {Object} transaction - Solana VersionedTransaction
 * @returns {Object} { success, signature, error }
 */
export const signAndSendTransaction = async (transaction) => {
  if (!mwaAvailable || !transact) {
    return { success: false, error: 'MWA not available' };
  }
  
  const config = _savedWalletUriBase ? { baseUri: _savedWalletUriBase } : undefined;
  try {
    const signature = await transact(async (wallet) => {
      // Re-authorize for signing (reuse cached auth_token to skip biometric popup)
      await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
        ...(authToken ? { auth_token: authToken } : {}),
      });
      
      const signatures = await wallet.signAndSendTransactions({
        transactions: [transaction],
      });
      
      return signatures[0];
    }, config);
    
    console.log('[MWAAdapter] Transaction sent:', signature);
    return { success: true, signature };
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    console.error('[MWAAdapter] Transaction failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Sign a transaction without sending it
 * @param {Object} transaction - Solana VersionedTransaction
 * @returns {Object} { success, signedTransaction, error }
 */
export const signTransaction = async (transaction) => {
  if (!mwaAvailable || !transact) {
    return { success: false, error: 'MWA not available' };
  }
  
  const config = _savedWalletUriBase ? { baseUri: _savedWalletUriBase } : undefined;
  try {
    const signedTx = await transact(async (wallet) => {
      await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
        ...(authToken ? { auth_token: authToken } : {}),
      });
      
      const signedTransactions = await wallet.signTransactions({
        transactions: [transaction],
      });
      
      return signedTransactions[0];
    }, config);
    
    console.log('[MWAAdapter] Transaction signed (not sent)');
    return { success: true, signedTransaction: signedTx };
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    console.error('[MWAAdapter] Transaction signing failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Sign a message
 * @param {Uint8Array} message - Message bytes to sign
 * @returns {Object} { success, signature, error }
 */
export const signMessage = async (message) => {
  if (!mwaAvailable || !transact) {
    return { success: false, error: 'MWA not available' };
  }
  
  const config = _savedWalletUriBase ? { baseUri: _savedWalletUriBase } : undefined;
  try {
    const signature = await transact(async (wallet) => {
      await wallet.authorize({
        cluster: 'mainnet-beta',
        identity: APP_IDENTITY,
        ...(authToken ? { auth_token: authToken } : {}),
      });
      
      const messageBytes = typeof message === 'string' 
        ? new TextEncoder().encode(message)
        : message;
      
      const signatures = await wallet.signMessages({
        addresses: [connectedAddress],
        payloads: [messageBytes],
      });
      
      return signatures[0];
    }, config);
    
    return { success: true, signature };
  } catch (e) {
    if (e.message?.includes('User rejected') || e.message?.includes('cancelled')) {
      return { success: false, error: 'User cancelled', userCancelled: true };
    }
    console.error('[MWAAdapter] Message signing failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Get wallet balance in SOL
 * @param {string} address - Wallet address
 * @returns {number} Balance in SOL
 */
export const getBalance = async (address) => {
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }
  
  try {
    const pubkey = new PublicKey(address);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error('[MWAAdapter] Balance fetch failed:', e);
    return 0;
  }
};

/**
 * Execute a transact session with callback
 * This allows external code to use MWA directly for complex operations
 * @param {Function} callback - Async function receiving wallet object
 * @returns {any} Result from callback
 */
export const executeTransaction = async (callback) => {
  if (!mwaAvailable || !transact) {
    throw new Error('MWA not available');
  }
  const config = _savedWalletUriBase ? { baseUri: _savedWalletUriBase } : undefined;
  return await transact(callback, config);
};

/**
 * Get the APP_IDENTITY for external use
 */
export const getAppIdentity = () => APP_IDENTITY;

/**
 * Get connection instance
 */
export const getConnection = () => {
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }
  return connection;
};

export default {
  isAvailable,
  getName,
  connect,
  disconnect,
  signAndSendTransaction,
  signTransaction,
  signMessage,
  getBalance,
  executeTransaction,
  getAppIdentity,
  getConnection,
  setWalletUriBase,
  getWalletUriBase,
  getSavedWalletUriBase,
  clearSavedWalletUriBase,
  KNOWN_MWA_WALLETS,
};
