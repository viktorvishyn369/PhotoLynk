// Phantom Wallet Adapter - iOS and Android
// Uses Phantom's deeplink protocol for wallet connection
// Supports: Phantom mobile app on iOS and Android

import { Platform, Linking } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

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
  console.log('[PhantomAdapter] Solana web3 not available:', e.message);
}

// Configuration
const SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const PHANTOM_DEEPLINK_BASE = 'phantom://';
const PHANTOM_CONNECT_URL = 'https://phantom.app/ul/v1/connect';
const PHANTOM_SIGN_URL = 'https://phantom.app/ul/v1/signAndSendTransaction';

// App scheme for redirect (must match app.json scheme)
const APP_SCHEME = 'photolynk';
const APP_REDIRECT_URL = `${APP_SCHEME}://phantom-callback`;

// Storage keys
const PHANTOM_SESSION_KEY = 'phantom_session';
const PHANTOM_PUBKEY_KEY = 'phantom_pubkey';
const PHANTOM_SHARED_SECRET_KEY = 'phantom_shared_secret';

// State
let connection = null;
let connectedAddress = null;
let sharedSecret = null;
let session = null;
let dappKeyPair = null;

// ============================================================================
// ENCRYPTION HELPERS
// ============================================================================

/**
 * Generate a new keypair for dApp encryption
 */
const generateDappKeyPair = () => {
  if (!dappKeyPair) {
    dappKeyPair = nacl.box.keyPair();
  }
  return dappKeyPair;
};

/**
 * Encrypt payload for Phantom
 */
const encryptPayload = (payload, sharedSecretKey) => {
  if (!sharedSecretKey) throw new Error('No shared secret');
  
  const nonce = nacl.randomBytes(24);
  const encryptedPayload = nacl.box.after(
    Buffer.from(JSON.stringify(payload)),
    nonce,
    sharedSecretKey
  );
  
  return {
    nonce: bs58.encode(nonce),
    payload: bs58.encode(encryptedPayload),
  };
};

/**
 * Decrypt response from Phantom
 */
const decryptPayload = (data, nonce, sharedSecretKey) => {
  if (!sharedSecretKey) throw new Error('No shared secret');
  
  const decryptedData = nacl.box.open.after(
    bs58.decode(data),
    bs58.decode(nonce),
    sharedSecretKey
  );
  
  if (!decryptedData) {
    throw new Error('Unable to decrypt data');
  }
  
  return JSON.parse(Buffer.from(decryptedData).toString('utf8'));
};

// ============================================================================
// ADAPTER INTERFACE
// ============================================================================

/**
 * Check if Phantom is available
 */
export const isAvailable = async () => {
  if (!solanaAvailable) return false;
  
  try {
    // Check if Phantom app is installed
    const canOpen = await Linking.canOpenURL(PHANTOM_DEEPLINK_BASE);
    return canOpen;
  } catch (e) {
    return false;
  }
};

/**
 * Get adapter name
 */
export const getName = () => 'Phantom';

/**
 * Connect to Phantom wallet via deeplink
 * @returns {Object} { success, address, error }
 */
export const connect = async () => {
  try {
    // Generate dApp keypair for encryption
    const keyPair = generateDappKeyPair();
    const dappPublicKey = bs58.encode(keyPair.publicKey);
    
    // Build connect URL
    const params = new URLSearchParams({
      dapp_encryption_public_key: dappPublicKey,
      cluster: 'mainnet-beta',
      app_url: 'https://stealthlynk.io',
      redirect_link: APP_REDIRECT_URL,
    });
    
    const connectUrl = `${PHANTOM_CONNECT_URL}?${params.toString()}`;
    
    console.log('[PhantomAdapter] Opening Phantom for connection...');
    
    // Open Phantom app
    const supported = await Linking.canOpenURL(connectUrl);
    if (!supported) {
      return { success: false, error: 'Phantom app not installed' };
    }
    
    // Set up listener for callback using subscription pattern (newer RN API)
    return new Promise((resolve) => {
      let subscription = null;
      let timeoutId = null;
      let resolved = false;
      
      const cleanup = () => {
        if (subscription) {
          subscription.remove();
          subscription = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
      
      const handleUrl = async (event) => {
        if (resolved) return;
        
        try {
          const url = new URL(event.url);
          
          // Check if this is our callback
          if (!url.href.startsWith(APP_SCHEME)) return;
          
          resolved = true;
          cleanup();
          
          // Check for error
          const errorCode = url.searchParams.get('errorCode');
          if (errorCode) {
            const errorMessage = url.searchParams.get('errorMessage') || 'Connection failed';
            resolve({ success: false, error: errorMessage, userCancelled: errorCode === '4001' });
            return;
          }
          
          // Get response data
          const phantomPubkey = url.searchParams.get('phantom_encryption_public_key');
          const data = url.searchParams.get('data');
          const nonce = url.searchParams.get('nonce');
          
          if (!phantomPubkey || !data || !nonce) {
            resolve({ success: false, error: 'Invalid response from Phantom' });
            return;
          }
          
          // Compute shared secret
          sharedSecret = nacl.box.before(
            bs58.decode(phantomPubkey),
            keyPair.secretKey
          );
          
          // Decrypt response
          const decrypted = decryptPayload(data, nonce, sharedSecret);
          
          connectedAddress = decrypted.public_key;
          session = decrypted.session;
          
          // Store session for later
          await SecureStore.setItemAsync(PHANTOM_SESSION_KEY, session);
          await SecureStore.setItemAsync(PHANTOM_PUBKEY_KEY, connectedAddress);
          await SecureStore.setItemAsync(PHANTOM_SHARED_SECRET_KEY, bs58.encode(sharedSecret));
          
          console.log('[PhantomAdapter] Connected:', connectedAddress);
          resolve({ success: true, address: connectedAddress });
        } catch (e) {
          console.error('[PhantomAdapter] Callback error:', e);
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({ success: false, error: e.message });
          }
        }
      };
      
      // Use subscription pattern (works in newer RN)
      subscription = Linking.addEventListener('url', handleUrl);
      
      // Open Phantom
      Linking.openURL(connectUrl);
      
      // Timeout after 2 minutes
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ success: false, error: 'Connection timeout' });
        }
      }, 120000);
    });
  } catch (e) {
    console.error('[PhantomAdapter] Connection failed:', e);
    return { success: false, error: e.message };
  }
};

/**
 * Disconnect wallet
 */
export const disconnect = async () => {
  connectedAddress = null;
  session = null;
  sharedSecret = null;
  
  await SecureStore.deleteItemAsync(PHANTOM_SESSION_KEY);
  await SecureStore.deleteItemAsync(PHANTOM_PUBKEY_KEY);
  await SecureStore.deleteItemAsync(PHANTOM_SHARED_SECRET_KEY);
  
  console.log('[PhantomAdapter] Disconnected');
};

/**
 * Sign and send a transaction via Phantom deeplink
 * @param {Object} transaction - Solana VersionedTransaction
 * @returns {Object} { success, signature, error }
 */
export const signAndSendTransaction = async (transaction) => {
  if (!session || !sharedSecret) {
    // Try to restore session
    try {
      session = await SecureStore.getItemAsync(PHANTOM_SESSION_KEY);
      const storedSecret = await SecureStore.getItemAsync(PHANTOM_SHARED_SECRET_KEY);
      if (storedSecret) {
        sharedSecret = bs58.decode(storedSecret);
      }
    } catch (e) {
      return { success: false, error: 'Not connected to Phantom' };
    }
    
    if (!session || !sharedSecret) {
      return { success: false, error: 'Not connected to Phantom' };
    }
  }
  
  try {
    // Serialize transaction
    const serializedTransaction = bs58.encode(transaction.serialize());
    
    // Encrypt payload
    const payload = {
      session,
      transaction: serializedTransaction,
    };
    
    const encrypted = encryptPayload(payload, sharedSecret);
    
    // Build sign URL
    const params = new URLSearchParams({
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      nonce: encrypted.nonce,
      payload: encrypted.payload,
      redirect_link: `${APP_REDIRECT_URL}/sign`,
    });
    
    const signUrl = `${PHANTOM_SIGN_URL}?${params.toString()}`;
    
    console.log('[PhantomAdapter] Opening Phantom for signing...');
    
    // Open Phantom and wait for callback
    return new Promise((resolve) => {
      let subscription = null;
      let timeoutId = null;
      let resolved = false;
      
      const cleanup = () => {
        if (subscription) {
          subscription.remove();
          subscription = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
      
      const handleUrl = async (event) => {
        if (resolved) return;
        
        try {
          const url = new URL(event.url);
          
          // Check if this is our callback
          if (!url.href.startsWith(APP_SCHEME)) return;
          
          resolved = true;
          cleanup();
          
          // Check for error
          const errorCode = url.searchParams.get('errorCode');
          if (errorCode) {
            const errorMessage = url.searchParams.get('errorMessage') || 'Signing failed';
            resolve({ success: false, error: errorMessage, userCancelled: errorCode === '4001' });
            return;
          }
          
          // Get response
          const data = url.searchParams.get('data');
          const nonce = url.searchParams.get('nonce');
          
          if (!data || !nonce) {
            resolve({ success: false, error: 'Invalid response from Phantom' });
            return;
          }
          
          // Decrypt response
          const decrypted = decryptPayload(data, nonce, sharedSecret);
          
          console.log('[PhantomAdapter] Transaction signed:', decrypted.signature);
          resolve({ success: true, signature: decrypted.signature });
        } catch (e) {
          console.error('[PhantomAdapter] Sign callback error:', e);
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({ success: false, error: e.message });
          }
        }
      };
      
      // Use subscription pattern (works in newer RN)
      subscription = Linking.addEventListener('url', handleUrl);
      Linking.openURL(signUrl);
      
      // Timeout after 2 minutes
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ success: false, error: 'Signing timeout' });
        }
      }, 120000);
    });
  } catch (e) {
    console.error('[PhantomAdapter] Transaction failed:', e);
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
    console.error('[PhantomAdapter] Balance fetch failed:', e);
    return 0;
  }
};

/**
 * Restore session from storage
 */
export const restoreSession = async () => {
  try {
    session = await SecureStore.getItemAsync(PHANTOM_SESSION_KEY);
    connectedAddress = await SecureStore.getItemAsync(PHANTOM_PUBKEY_KEY);
    const storedSecret = await SecureStore.getItemAsync(PHANTOM_SHARED_SECRET_KEY);
    
    if (storedSecret) {
      sharedSecret = bs58.decode(storedSecret);
    }
    
    if (session && connectedAddress) {
      console.log('[PhantomAdapter] Session restored:', connectedAddress);
      return { success: true, address: connectedAddress };
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
  getBalance,
  restoreSession,
};
