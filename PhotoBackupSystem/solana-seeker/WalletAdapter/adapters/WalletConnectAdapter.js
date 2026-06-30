// WalletConnect Adapter - Universal wallet protocol
// Supports: Tangem, Trust Wallet, and other WalletConnect-compatible wallets
// Uses WalletConnect v2 protocol for Solana

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
  console.log('[WalletConnectAdapter] Solana web3 not available:', e.message);
}

// WalletConnect imports - optional dependency
let SignClient = null;
let wcAvailable = false;

try {
  // Try to load WalletConnect
  const wc = require('@walletconnect/sign-client');
  SignClient = wc.SignClient || wc.default;
  wcAvailable = true;
  console.log('[WalletConnectAdapter] WalletConnect loaded');
} catch (e) {
  console.log('[WalletConnectAdapter] WalletConnect not available:', e.message);
}

// Configuration
const SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

// WalletConnect Project ID - Get yours at https://cloud.walletconnect.com
const WC_PROJECT_ID = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID';

const WC_METADATA = {
  name: 'PhotoLynk',
  description: 'Encrypted Photo Backup with NFT Ownership',
  url: 'https://stealthlynk.io',
  icons: ['https://stealthlynk.io/favicon.ico'],
};

// Solana chain for WalletConnect
const SOLANA_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // mainnet-beta

// Storage keys
const WC_SESSION_KEY = 'walletconnect_session';

// State
let connection = null;
let signClient = null;
let currentSession = null;
let connectedAddress = null;

// ============================================================================
// ADAPTER INTERFACE
// ============================================================================

/**
 * Check if WalletConnect is available
 */
export const isAvailable = async () => {
  return wcAvailable && solanaAvailable && WC_PROJECT_ID !== 'YOUR_PROJECT_ID';
};

/**
 * Get adapter name
 */
export const getName = () => 'WalletConnect';

/**
 * Initialize WalletConnect SignClient
 */
const initializeClient = async () => {
  if (signClient) return signClient;
  
  if (!wcAvailable || !SignClient) {
    throw new Error('WalletConnect not available');
  }
  
  signClient = await SignClient.init({
    projectId: WC_PROJECT_ID,
    metadata: WC_METADATA,
  });
  
  // Set up event listeners
  signClient.on('session_event', (event) => {
    console.log('[WalletConnectAdapter] Session event:', event);
  });
  
  signClient.on('session_update', ({ topic, params }) => {
    console.log('[WalletConnectAdapter] Session updated:', topic);
  });
  
  signClient.on('session_delete', () => {
    console.log('[WalletConnectAdapter] Session deleted');
    currentSession = null;
    connectedAddress = null;
  });
  
  return signClient;
};

/**
 * Connect to wallet via WalletConnect
 * @returns {Object} { success, address, error }
 */
export const connect = async () => {
  try {
    const client = await initializeClient();
    
    // Create connection request
    const { uri, approval } = await client.connect({
      requiredNamespaces: {
        solana: {
          methods: ['solana_signTransaction', 'solana_signMessage'],
          chains: [SOLANA_CHAIN],
          events: [],
        },
      },
    });
    
    if (!uri) {
      return { success: false, error: 'Failed to create connection URI' };
    }
    
    console.log('[WalletConnectAdapter] Connection URI:', uri);
    
    // Open wallet app with WalletConnect URI
    // This will show the wallet selection modal on the device
    const wcUrl = `wc:${uri.split('wc:')[1]}`;
    
    const canOpen = await Linking.canOpenURL(wcUrl);
    if (canOpen) {
      await Linking.openURL(wcUrl);
    } else {
      // Try universal link
      await Linking.openURL(`https://walletconnect.com/wc?uri=${encodeURIComponent(uri)}`);
    }
    
    // Wait for approval
    console.log('[WalletConnectAdapter] Waiting for wallet approval...');
    const session = await approval();
    
    currentSession = session;
    
    // Extract Solana address from session
    const solanaAccounts = session.namespaces.solana?.accounts || [];
    if (solanaAccounts.length === 0) {
      return { success: false, error: 'No Solana accounts found' };
    }
    
    // Account format: solana:chainId:address
    const accountParts = solanaAccounts[0].split(':');
    connectedAddress = accountParts[accountParts.length - 1];
    
    // Store session
    await SecureStore.setItemAsync(WC_SESSION_KEY, JSON.stringify({
      topic: session.topic,
      address: connectedAddress,
    }));
    
    console.log('[WalletConnectAdapter] Connected:', connectedAddress);
    return { success: true, address: connectedAddress };
  } catch (e) {
    if (e.message?.includes('rejected') || e.message?.includes('User rejected')) {
      return { success: false, error: 'User rejected', userCancelled: true };
    }
    console.error('[WalletConnectAdapter] Connection failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Disconnect wallet
 */
export const disconnect = async () => {
  try {
    if (signClient && currentSession) {
      await signClient.disconnect({
        topic: currentSession.topic,
        reason: { code: 6000, message: 'User disconnected' },
      });
    }
  } catch (e) {
    console.log('[WalletConnectAdapter] Disconnect error:', e.message);
  }
  
  currentSession = null;
  connectedAddress = null;
  
  await SecureStore.deleteItemAsync(WC_SESSION_KEY);
  console.log('[WalletConnectAdapter] Disconnected');
};

/**
 * Sign and send a transaction via WalletConnect
 * @param {Object} transaction - Solana VersionedTransaction
 * @returns {Object} { success, signature, error }
 */
export const signAndSendTransaction = async (transaction) => {
  if (!signClient || !currentSession) {
    return { success: false, error: 'Not connected' };
  }
  
  try {
    // Serialize transaction to base64
    const serializedTx = Buffer.from(transaction.serialize()).toString('base64');
    
    // Request signature via WalletConnect
    const result = await signClient.request({
      topic: currentSession.topic,
      chainId: SOLANA_CHAIN,
      request: {
        method: 'solana_signTransaction',
        params: {
          transaction: serializedTx,
        },
      },
    });
    
    // The wallet returns the signed transaction
    // We need to send it to the network
    if (!connection) {
      connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    }
    
    const signedTx = Buffer.from(result.signature, 'base64');
    const signature = await connection.sendRawTransaction(signedTx);
    
    console.log('[WalletConnectAdapter] Transaction sent:', signature);
    return { success: true, signature };
  } catch (e) {
    if (e.message?.includes('rejected') || e.message?.includes('User rejected')) {
      return { success: false, error: 'User rejected', userCancelled: true };
    }
    console.error('[WalletConnectAdapter] Transaction failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Sign a message via WalletConnect
 * @param {string|Uint8Array} message - Message to sign
 * @returns {Object} { success, signature, error }
 */
export const signMessage = async (message) => {
  if (!signClient || !currentSession) {
    return { success: false, error: 'Not connected' };
  }
  
  try {
    const messageStr = typeof message === 'string' 
      ? message 
      : Buffer.from(message).toString('utf8');
    
    const result = await signClient.request({
      topic: currentSession.topic,
      chainId: SOLANA_CHAIN,
      request: {
        method: 'solana_signMessage',
        params: {
          message: Buffer.from(messageStr).toString('base64'),
          pubkey: connectedAddress,
        },
      },
    });
    
    return { success: true, signature: result.signature };
  } catch (e) {
    if (e.message?.includes('rejected') || e.message?.includes('User rejected')) {
      return { success: false, error: 'User rejected', userCancelled: true };
    }
    console.error('[WalletConnectAdapter] Message signing failed:', e);
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
    console.error('[WalletConnectAdapter] Balance fetch failed:', e);
    return 0;
  }
};

/**
 * Restore session from storage
 */
export const restoreSession = async () => {
  try {
    const stored = await SecureStore.getItemAsync(WC_SESSION_KEY);
    if (!stored) return { success: false };
    
    const { topic, address } = JSON.parse(stored);
    
    const client = await initializeClient();
    const sessions = client.session.getAll();
    
    const session = sessions.find(s => s.topic === topic);
    if (session) {
      currentSession = session;
      connectedAddress = address;
      console.log('[WalletConnectAdapter] Session restored:', address);
      return { success: true, address };
    }
    
    // Session expired, clean up
    await SecureStore.deleteItemAsync(WC_SESSION_KEY);
    return { success: false };
  } catch (e) {
    console.log('[WalletConnectAdapter] Session restore failed:', e.message);
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
  restoreSession,
};
