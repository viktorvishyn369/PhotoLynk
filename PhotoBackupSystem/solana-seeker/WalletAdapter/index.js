// WalletAdapter Module - Universal Wallet Connection for Solana
// Supports multiple wallet providers: MWA (Seeker/Saga), Phantom, WalletConnect (Tangem), MetaMask
// All payments are in SOL only

import { Platform, Linking } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Wallet adapter imports - loaded dynamically based on availability
let MWAAdapter = null;
let PhantomAdapter = null;
let WalletConnectAdapter = null;
let MetaMaskAdapter = null;

// Storage keys
const WALLET_STORAGE_KEY = 'photolynk_connected_wallet';
const WALLET_TYPE_KEY = 'photolynk_wallet_type';
const WALLET_LABEL_KEY = 'photolynk_wallet_label';

// Wallet types enum — each MWA-compatible wallet gets its own type.
export const WALLET_TYPES = {
  MWA: 'mwa',
  MWA_SEEDVAULT: 'mwa_seedvault',
  MWA_PHANTOM: 'mwa_phantom',
  MWA_SOLFLARE: 'mwa_solflare',
  MWA_BACKPACK: 'mwa_backpack',
  MWA_ULTIMATE: 'mwa_ultimate',
  PHANTOM: 'phantom',
  WALLETCONNECT: 'walletconnect',
  METAMASK: 'metamask',
};

// MWA auto-discovers installed wallets via system intent resolver on Android.
// No URI routing needed — the system shows a chooser if multiple wallets are installed.

// Wallet metadata for UI
export const WALLET_INFO = {
  [WALLET_TYPES.MWA_SEEDVAULT]: {
    name: 'Seed Vault',
    description: 'Seeker built-in hardware wallet',
    icon: 'wallet',
    platforms: ['android'],
    priority: 1,
    isMwa: true,
  },
  [WALLET_TYPES.MWA_PHANTOM]: {
    name: 'Phantom',
    description: 'Popular Solana wallet (MWA)',
    icon: 'ghost',
    platforms: ['android'],
    priority: 2,
    isMwa: true,
    playStoreUrl: 'https://play.google.com/store/apps/details?id=app.phantom',
  },
  [WALLET_TYPES.MWA_SOLFLARE]: {
    name: 'Solflare',
    description: 'Full-featured Solana wallet (MWA)',
    icon: 'hexagon',
    platforms: ['android'],
    priority: 3,
    isMwa: true,
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.solflare.mobile',
  },
  [WALLET_TYPES.MWA_BACKPACK]: {
    name: 'Backpack',
    description: 'Multi-chain wallet (MWA)',
    icon: 'box',
    platforms: ['android'],
    priority: 4,
    isMwa: true,
    playStoreUrl: 'https://play.google.com/store/apps/details?id=app.backpack.mobile',
  },
  [WALLET_TYPES.MWA_ULTIMATE]: {
    name: 'Ultimate',
    description: 'Solana wallet (MWA)',
    icon: 'credit-card',
    platforms: ['android'],
    priority: 5,
    isMwa: true,
  },
  [WALLET_TYPES.PHANTOM]: {
    name: 'Phantom (deeplink)',
    description: 'iOS deeplink connection',
    icon: 'ghost',
    platforms: ['ios'],
    priority: 6,
    appStoreUrl: 'https://apps.apple.com/app/phantom-solana-wallet/id1598432977',
    deepLink: 'phantom://',
  },
  [WALLET_TYPES.WALLETCONNECT]: {
    name: 'WalletConnect',
    description: 'Tangem, Trust Wallet, and more',
    icon: 'link',
    platforms: ['ios', 'android'],
    priority: 7,
  },
  [WALLET_TYPES.METAMASK]: {
    name: 'MetaMask',
    description: 'Via Solana bridge',
    icon: 'hexagon',
    platforms: ['ios', 'android'],
    priority: 8,
    appStoreUrl: 'https://apps.apple.com/app/metamask/id1438144202',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=io.metamask',
    deepLink: 'metamask://',
  },
};

// ============================================================================
// STATE
// ============================================================================

let currentWalletType = null;
let currentAdapter = null;
let connectedAddress = null;
let connectedLabel = null;
let isInitialized = false;

// Subscribers for wallet change events
const walletChangeListeners = new Set();

export const onWalletChanged = (listener) => {
  if (typeof listener !== 'function') return () => {};
  walletChangeListeners.add(listener);
  return () => walletChangeListeners.delete(listener);
};

const emitWalletChanged = (nextAddress, prevAddress, label) => {
  try {
    for (const l of walletChangeListeners) {
      try { l(nextAddress, prevAddress, label); } catch (_) {}
    }
  } catch (_) {}
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the wallet adapter system
 * Loads available adapters based on platform and installed packages
 */
export const initializeWalletAdapter = async () => {
  if (isInitialized) return true;
  
  console.log('[WalletAdapter] Initializing...');
  
  // Try to load each adapter
  try {
    const mwa = require('./adapters/MWAAdapter');
    MWAAdapter = mwa;
    console.log('[WalletAdapter] MWA adapter loaded');
  } catch (e) {
    console.log('[WalletAdapter] MWA adapter not available:', e.message);
  }
  
  try {
    const phantom = require('./adapters/PhantomAdapter');
    PhantomAdapter = phantom;
    console.log('[WalletAdapter] Phantom adapter loaded');
  } catch (e) {
    console.log('[WalletAdapter] Phantom adapter not available:', e.message);
  }
  
  try {
    const wc = require('./adapters/WalletConnectAdapter');
    WalletConnectAdapter = wc;
    console.log('[WalletAdapter] WalletConnect adapter loaded');
  } catch (e) {
    console.log('[WalletAdapter] WalletConnect adapter not available:', e.message);
  }
  
  try {
    const mm = require('./adapters/MetaMaskAdapter');
    MetaMaskAdapter = mm;
    console.log('[WalletAdapter] MetaMask adapter loaded');
  } catch (e) {
    console.log('[WalletAdapter] MetaMask adapter not available:', e.message);
  }
  
  // Restore previous connection if any
  await restoreConnection();
  
  isInitialized = true;
  console.log('[WalletAdapter] Initialization complete');
  return true;
};

/**
 * Restore previous wallet connection from storage
 */
const restoreConnection = async () => {
  try {
    const storedType = await SecureStore.getItemAsync(WALLET_TYPE_KEY);
    const storedAddress = await SecureStore.getItemAsync(WALLET_STORAGE_KEY);
    
    if (storedType && storedAddress) {
      const prev = connectedAddress;
      currentWalletType = storedType;
      currentAdapter = getAdapterForType(storedType);
      if (!currentAdapter) {
        currentWalletType = null;
        connectedAddress = null;
        connectedLabel = null;
        await SecureStore.deleteItemAsync(WALLET_TYPE_KEY).catch(() => {});
        await SecureStore.deleteItemAsync(WALLET_STORAGE_KEY).catch(() => {});
        await SecureStore.deleteItemAsync(WALLET_LABEL_KEY).catch(() => {});
        return;
      }
      let restoredAddress = storedAddress;
      if (typeof currentAdapter.restoreSession === 'function') {
        const restoreResult = await currentAdapter.restoreSession();
        if (!restoreResult?.success) {
          currentWalletType = null;
          currentAdapter = null;
          connectedAddress = null;
          connectedLabel = null;
          await SecureStore.deleteItemAsync(WALLET_TYPE_KEY).catch(() => {});
          await SecureStore.deleteItemAsync(WALLET_STORAGE_KEY).catch(() => {});
          await SecureStore.deleteItemAsync(WALLET_LABEL_KEY).catch(() => {});
          return;
        }
        restoredAddress = restoreResult.address || storedAddress;
      }
      connectedAddress = restoredAddress;
      try { connectedLabel = await SecureStore.getItemAsync(WALLET_LABEL_KEY); } catch (_) {}
      console.log('[WalletAdapter] Restored connection:', storedType, connectedAddress, 'label:', connectedLabel);
      if (connectedAddress && connectedAddress !== prev) {
        emitWalletChanged(connectedAddress, prev, connectedLabel);
      }
    }
  } catch (e) {
    console.log('[WalletAdapter] Could not restore connection:', e.message);
  }
};

// ============================================================================
// WALLET DETECTION
// ============================================================================

/**
 * Get adapter instance for wallet type
 */
const getAdapterForType = (type) => {
  switch (type) {
    case WALLET_TYPES.MWA:
    case WALLET_TYPES.MWA_SEEDVAULT:
    case WALLET_TYPES.MWA_PHANTOM:
    case WALLET_TYPES.MWA_SOLFLARE:
    case WALLET_TYPES.MWA_BACKPACK:
    case WALLET_TYPES.MWA_ULTIMATE:
      return MWAAdapter;
    case WALLET_TYPES.PHANTOM:
      return PhantomAdapter;
    case WALLET_TYPES.WALLETCONNECT:
      return WalletConnectAdapter;
    case WALLET_TYPES.METAMASK:
      return MetaMaskAdapter;
    default:
      return null;
  }
};

/**
 * Check if a specific wallet app is installed
 */
const isWalletInstalled = async (walletType) => {
  const info = WALLET_INFO[walletType];
  if (!info?.deepLink) return false;
  
  try {
    return await Linking.canOpenURL(info.deepLink);
  } catch (e) {
    return false;
  }
};

/**
 * Get list of available wallets for current platform
 * @returns {Array} List of available wallet types with metadata
 */
export const getAvailableWallets = async () => {
  const platform = Platform.OS;
  const available = [];
  
  // Show all MWA wallet entries so the user can pick which installed wallet to use.
  const ENABLED_WALLET_TYPES = [
    WALLET_TYPES.MWA_SEEDVAULT,
    WALLET_TYPES.MWA_PHANTOM,
    WALLET_TYPES.MWA_SOLFLARE,
    WALLET_TYPES.MWA_BACKPACK,
    WALLET_TYPES.MWA_ULTIMATE,
  ];
  
  for (const [type, info] of Object.entries(WALLET_INFO)) {
    // Skip wallets that are not enabled (hidden for now)
    if (!ENABLED_WALLET_TYPES.includes(type)) continue;
    
    // Check platform compatibility
    if (!info.platforms.includes(platform)) continue;
    
    // Check if adapter is loaded
    const adapter = getAdapterForType(type);
    if (!adapter) continue;
    
    // Check if adapter reports as available
    const isAvailable = adapter.isAvailable ? await adapter.isAvailable() : true;
    if (!isAvailable) continue;
    
    // Check if wallet app is installed (for deep link wallets)
    const isInstalled = info.deepLink ? await isWalletInstalled(type) : true;
    
    available.push({
      type,
      ...info,
      isInstalled,
      adapter,
    });
  }
  
  // Sort by priority
  available.sort((a, b) => a.priority - b.priority);
  
  return available;
};

/**
 * Get the best available wallet for current platform
 * Prioritizes: MWA on Android Solana devices > Phantom > WalletConnect > MetaMask
 */
export const getBestAvailableWallet = async () => {
  const available = await getAvailableWallets();
  
  // Prefer installed wallets
  const installed = available.filter(w => w.isInstalled);
  if (installed.length > 0) {
    return installed[0];
  }
  
  // Fall back to any available
  return available[0] || null;
};

// ============================================================================
// CONNECTION
// ============================================================================

/**
 * Connect to a specific wallet
 * @param {string} walletType - Wallet type from WALLET_TYPES
 * @returns {Object} { success, address, error }
 */
export const connectWallet = async (walletType) => {
  console.log('[WalletAdapter] Connecting to:', walletType);
  
  const adapter = getAdapterForType(walletType);
  if (!adapter) {
    return { success: false, error: 'Wallet adapter not available' };
  }
  
  try {
    const prev = connectedAddress;
    const result = await adapter.connect();
    
    if (result.success) {
      currentWalletType = walletType;
      currentAdapter = adapter;
      connectedAddress = result.address;
      connectedLabel = result.label || null;
      
      // Persist connection
      await SecureStore.setItemAsync(WALLET_TYPE_KEY, walletType);
      await SecureStore.setItemAsync(WALLET_STORAGE_KEY, result.address);
      if (connectedLabel) {
        await SecureStore.setItemAsync(WALLET_LABEL_KEY, connectedLabel);
      } else {
        await SecureStore.deleteItemAsync(WALLET_LABEL_KEY).catch(() => {});
      }
      
      console.log('[WalletAdapter] Connected:', result.address, 'label:', connectedLabel);

      if (result.address && result.address !== prev) {
        emitWalletChanged(result.address, prev, connectedLabel);
      }
    }
    
    return result;
  } catch (e) {
    console.error('[WalletAdapter] Connection failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Connect to the best available wallet automatically
 * @returns {Object} { success, address, walletType, error }
 */
export const connectBestWallet = async () => {
  const best = await getBestAvailableWallet();
  if (!best) {
    return { success: false, error: 'No wallet available' };
  }
  
  const result = await connectWallet(best.type);
  return { ...result, walletType: best.type };
};

/**
 * Disconnect current wallet
 */
export const disconnectWallet = async () => {
  console.log('[WalletAdapter] Disconnecting...');
  
  if (currentAdapter?.disconnect) {
    try {
      await currentAdapter.disconnect();
    } catch (e) {
      console.log('[WalletAdapter] Disconnect error:', e.message);
    }
  }
  
  currentWalletType = null;
  currentAdapter = null;
  connectedAddress = null;
  connectedLabel = null;
  
  await SecureStore.deleteItemAsync(WALLET_TYPE_KEY);
  await SecureStore.deleteItemAsync(WALLET_STORAGE_KEY);
  await SecureStore.deleteItemAsync(WALLET_LABEL_KEY).catch(() => {});
  
  console.log('[WalletAdapter] Disconnected');
};

/**
 * Get current connection status
 * @returns {Object} { isConnected, address, walletType }
 */
export const getConnectionStatus = () => {
  return {
    isConnected: !!connectedAddress,
    address: connectedAddress,
    label: connectedLabel,
    walletType: currentWalletType,
    walletInfo: currentWalletType ? WALLET_INFO[currentWalletType] : null,
  };
};

// ============================================================================
// TRANSACTIONS
// ============================================================================

/**
 * Sign and send a Solana transaction
 * @param {Object} transaction - Solana VersionedTransaction or Transaction
 * @returns {Object} { success, signature, error }
 */
export const signAndSendTransaction = async (transaction) => {
  if (!currentAdapter) {
    return { success: false, error: 'No wallet connected' };
  }
  
  try {
    const result = await currentAdapter.signAndSendTransaction(transaction);
    return result;
  } catch (e) {
    console.error('[WalletAdapter] Transaction failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Sign a message
 * @param {string|Uint8Array} message - Message to sign
 * @returns {Object} { success, signature, error }
 */
export const signMessage = async (message) => {
  if (!currentAdapter) {
    return { success: false, error: 'No wallet connected' };
  }
  
  if (!currentAdapter.signMessage) {
    return { success: false, error: 'Wallet does not support message signing' };
  }
  
  try {
    const result = await currentAdapter.signMessage(message);
    return result;
  } catch (e) {
    console.error('[WalletAdapter] Message signing failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Get wallet balance in SOL
 * @returns {number} Balance in SOL
 */
export const getBalance = async () => {
  if (!currentAdapter || !connectedAddress) {
    return 0;
  }
  
  try {
    if (currentAdapter.getBalance) {
      return await currentAdapter.getBalance(connectedAddress);
    }
    return 0;
  } catch (e) {
    console.error('[WalletAdapter] Balance fetch failed:', e);
    return 0;
  }
};

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  WALLET_TYPES,
  WALLET_INFO,
  initializeWalletAdapter,
  getAvailableWallets,
  getBestAvailableWallet,
  connectWallet,
  connectBestWallet,
  disconnectWallet,
  getConnectionStatus,
  signAndSendTransaction,
  signMessage,
  getBalance,
};
