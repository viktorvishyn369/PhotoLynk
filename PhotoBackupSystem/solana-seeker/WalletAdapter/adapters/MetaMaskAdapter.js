// MetaMask Adapter - Cross-chain wallet with Solana support via Snaps
// Supports: MetaMask mobile app on iOS and Android
// Note: MetaMask requires Solana Snap or uses wrapped SOL on EVM chains
// For native Solana, we use MetaMask's deeplink protocol

import { Platform, Linking } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Solana imports
let Connection, PublicKey, LAMPORTS_PER_SOL;
let solanaAvailable = false;

try {
  const web3 = require('@solana/web3.js');
  Connection = web3.Connection;
  PublicKey = web3.PublicKey;
  LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
  solanaAvailable = true;
} catch (e) {
  console.log('[MetaMaskAdapter] Solana web3 not available:', e.message);
}

// Configuration
const SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const METAMASK_DEEPLINK_BASE = 'metamask://';

// MetaMask SDK - optional dependency
let MetaMaskSDK = null;
let mmsdkAvailable = false;

try {
  const mmsdk = require('@metamask/sdk-react-native');
  MetaMaskSDK = mmsdk.MetaMaskSDK || mmsdk.default;
  mmsdkAvailable = true;
  console.log('[MetaMaskAdapter] MetaMask SDK loaded');
} catch (e) {
  console.log('[MetaMaskAdapter] MetaMask SDK not available:', e.message);
}

// Storage keys
const MM_SESSION_KEY = 'metamask_session';
const MM_ADDRESS_KEY = 'metamask_address';

// State
let connection = null;
let sdk = null;
let connectedAddress = null;
let ethereum = null;

// ============================================================================
// ADAPTER INTERFACE
// ============================================================================

/**
 * Check if MetaMask is available
 */
export const isAvailable = async () => {
  if (!solanaAvailable) return false;
  
  try {
    // Check if MetaMask app is installed
    const canOpen = await Linking.canOpenURL(METAMASK_DEEPLINK_BASE);
    return canOpen;
  } catch (e) {
    return false;
  }
};

/**
 * Get adapter name
 */
export const getName = () => 'MetaMask';

/**
 * Initialize MetaMask SDK
 */
const initializeSDK = async () => {
  if (sdk) return sdk;
  
  if (!mmsdkAvailable || !MetaMaskSDK) {
    console.log('[MetaMaskAdapter] SDK not available, using deeplinks');
    return null;
  }
  
  try {
    sdk = new MetaMaskSDK({
      dappMetadata: {
        name: 'PhotoLynk',
        url: 'https://stealthlynk.io',
      },
      // Enable mobile linking
      openDeeplink: (link) => {
        Linking.openURL(link);
      },
    });
    
    await sdk.init();
    ethereum = sdk.getProvider();
    
    return sdk;
  } catch (e) {
    console.error('[MetaMaskAdapter] SDK init failed:', e);
    return null;
  }
};

/**
 * Connect to MetaMask wallet
 * Note: MetaMask primarily supports EVM chains. For Solana, we use:
 * 1. MetaMask Snaps (if available) for native Solana
 * 2. Fallback to EVM address for wrapped SOL payments
 * @returns {Object} { success, address, chainType, error }
 */
export const connect = async () => {
  try {
    // Try SDK first
    await initializeSDK();
    
    if (ethereum) {
      // Request accounts via SDK
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      
      if (accounts && accounts.length > 0) {
        connectedAddress = accounts[0];
        
        // Store connection
        await SecureStore.setItemAsync(MM_ADDRESS_KEY, connectedAddress);
        
        console.log('[MetaMaskAdapter] Connected (EVM):', connectedAddress);
        
        // Note: This is an EVM address, not Solana
        // For Solana payments, we'll need to use a bridge or Snaps
        return { 
          success: true, 
          address: connectedAddress,
          chainType: 'evm',
          warning: 'MetaMask connected with EVM address. Solana payments require bridging.',
        };
      }
    }
    
    // Fallback to deeplink
    console.log('[MetaMaskAdapter] Opening MetaMask via deeplink...');
    
    const deeplink = `${METAMASK_DEEPLINK_BASE}connect?scheme=photolynk&redirect=photolynk://metamask-callback`;
    
    const canOpen = await Linking.canOpenURL(deeplink);
    if (!canOpen) {
      return { success: false, error: 'MetaMask app not installed' };
    }
    
    // Open MetaMask
    await Linking.openURL(deeplink);
    
    // Wait for callback
    return new Promise((resolve) => {
      const handleUrl = async (event) => {
        try {
          const url = new URL(event.url);
          
          if (!url.href.includes('metamask-callback')) return;
          
          Linking.removeEventListener('url', handleUrl);
          
          // Extract address from callback
          const address = url.searchParams.get('address');
          
          if (address) {
            connectedAddress = address;
            await SecureStore.setItemAsync(MM_ADDRESS_KEY, address);
            
            console.log('[MetaMaskAdapter] Connected via deeplink:', address);
            resolve({ 
              success: true, 
              address,
              chainType: 'evm',
              warning: 'MetaMask connected with EVM address. Solana payments require bridging.',
            });
          } else {
            resolve({ success: false, error: 'No address returned' });
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      };
      
      Linking.addEventListener('url', handleUrl);
      
      // Timeout
      setTimeout(() => {
        Linking.removeEventListener('url', handleUrl);
        resolve({ success: false, error: 'Connection timeout' });
      }, 120000);
    });
  } catch (e) {
    if (e.message?.includes('rejected') || e.message?.includes('User rejected')) {
      return { success: false, error: 'User rejected', userCancelled: true };
    }
    console.error('[MetaMaskAdapter] Connection failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Disconnect wallet
 */
export const disconnect = async () => {
  if (sdk) {
    try {
      await sdk.terminate();
    } catch (e) {
      console.log('[MetaMaskAdapter] SDK terminate error:', e.message);
    }
  }
  
  connectedAddress = null;
  ethereum = null;
  sdk = null;
  
  await SecureStore.deleteItemAsync(MM_ADDRESS_KEY);
  await SecureStore.deleteItemAsync(MM_SESSION_KEY);
  
  console.log('[MetaMaskAdapter] Disconnected');
};

/**
 * Sign and send a Solana transaction via MetaMask
 * Note: MetaMask doesn't natively support Solana transactions
 * This requires either:
 * 1. Solana Snap installed in MetaMask
 * 2. Using a bridge service (Wormhole, etc.)
 * 
 * For now, we return an error indicating Solana is not directly supported
 * @param {Object} transaction - Solana VersionedTransaction
 * @returns {Object} { success, signature, error }
 */
export const signAndSendTransaction = async (transaction) => {
  // MetaMask doesn't natively support Solana
  // Users should use Phantom, MWA, or WalletConnect for Solana transactions
  
  console.log('[MetaMaskAdapter] Solana transactions not directly supported');
  
  return { 
    success: false, 
    error: 'MetaMask does not natively support Solana transactions. Please use Phantom or another Solana wallet.',
    requiresAlternativeWallet: true,
  };
  
  // Future: Implement Solana Snap support
  // const snapId = 'npm:@solana/snap';
  // try {
  //   await ethereum.request({
  //     method: 'wallet_requestSnaps',
  //     params: { [snapId]: {} },
  //   });
  //   // Use snap for Solana transaction
  // } catch (e) {
  //   return { success: false, error: 'Solana Snap not available' };
  // }
};

/**
 * Sign a message via MetaMask
 * @param {string|Uint8Array} message - Message to sign
 * @returns {Object} { success, signature, error }
 */
export const signMessage = async (message) => {
  if (!ethereum || !connectedAddress) {
    return { success: false, error: 'Not connected' };
  }
  
  try {
    const messageStr = typeof message === 'string' 
      ? message 
      : Buffer.from(message).toString('utf8');
    
    const signature = await ethereum.request({
      method: 'personal_sign',
      params: [messageStr, connectedAddress],
    });
    
    return { success: true, signature };
  } catch (e) {
    if (e.message?.includes('rejected') || e.code === 4001) {
      return { success: false, error: 'User rejected', userCancelled: true };
    }
    console.error('[MetaMaskAdapter] Message signing failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Get wallet balance
 * Note: Returns ETH balance, not SOL
 * @param {string} address - Wallet address
 * @returns {number} Balance in ETH
 */
export const getBalance = async (address) => {
  if (!ethereum) {
    return 0;
  }
  
  try {
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [address, 'latest'],
    });
    
    // Convert from wei to ETH
    return parseInt(balance, 16) / 1e18;
  } catch (e) {
    console.error('[MetaMaskAdapter] Balance fetch failed:', e);
    return 0;
  }
};

/**
 * Get Solana balance (if using bridge)
 * @param {string} solanaAddress - Solana wallet address
 * @returns {number} Balance in SOL
 */
export const getSolanaBalance = async (solanaAddress) => {
  if (!connection) {
    connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }
  
  try {
    const pubkey = new PublicKey(solanaAddress);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error('[MetaMaskAdapter] Solana balance fetch failed:', e);
    return 0;
  }
};

/**
 * Check if Solana Snap is installed
 * @returns {boolean} Whether Solana Snap is available
 */
export const hasSolanaSnap = async () => {
  if (!ethereum) return false;
  
  try {
    const snaps = await ethereum.request({ method: 'wallet_getSnaps' });
    return !!snaps['npm:@solana/snap'];
  } catch (e) {
    return false;
  }
};

/**
 * Restore session from storage
 */
export const restoreSession = async () => {
  try {
    const address = await SecureStore.getItemAsync(MM_ADDRESS_KEY);
    
    if (address) {
      connectedAddress = address;
      console.log('[MetaMaskAdapter] Session restored:', address);
      return { success: true, address, chainType: 'evm' };
    }
    
    return { success: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

export default {
  isAvailable,
  getName,
  connect,
  disconnect,
  signAndSendTransaction,
  signMessage,
  getBalance,
  getSolanaBalance,
  hasSolanaSnap,
  restoreSession,
};
