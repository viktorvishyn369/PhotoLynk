// WalletContext - React Context for Wallet State Management
// Provides wallet connection state and methods throughout the app

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  initializeWalletAdapter,
  getAvailableWallets,
  connectWallet,
  connectBestWallet,
  disconnectWallet,
  getConnectionStatus,
  signAndSendTransaction,
  signMessage,
  getBalance,
  WALLET_TYPES,
  WALLET_INFO,
} from './index';

// ============================================================================
// CONTEXT
// ============================================================================

const WalletContext = createContext(null);

// ============================================================================
// PROVIDER
// ============================================================================

export const WalletProvider = ({ children }) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [address, setAddress] = useState(null);
  const [walletType, setWalletType] = useState(null);
  const [walletInfo, setWalletInfo] = useState(null);
  const [balance, setBalance] = useState(0);
  const [availableWallets, setAvailableWallets] = useState([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Initialize on mount
  useEffect(() => {
    initialize();
  }, []);

  // Refresh balance periodically when connected
  useEffect(() => {
    if (!isConnected || !address) return;

    const refreshBalance = async () => {
      const bal = await getBalance();
      setBalance(bal);
    };

    refreshBalance();
    const interval = setInterval(refreshBalance, 30000); // Every 30 seconds

    return () => clearInterval(interval);
  }, [isConnected, address]);

  /**
   * Initialize wallet adapter and restore previous connection
   */
  const initialize = async () => {
    try {
      await initializeWalletAdapter();
      
      // Get available wallets
      const wallets = await getAvailableWallets();
      setAvailableWallets(wallets);
      
      // Check for existing connection
      const status = getConnectionStatus();
      if (status.isConnected) {
        setIsConnected(true);
        setAddress(status.address);
        setWalletType(status.walletType);
        setWalletInfo(status.walletInfo);
        
        // Fetch balance
        const bal = await getBalance();
        setBalance(bal);
      }
      
      setIsInitialized(true);
    } catch (e) {
      console.error('[WalletContext] Initialization failed:', e);
      setError(e.message);
      setIsInitialized(true);
    }
  };

  /**
   * Connect to a specific wallet
   */
  const connect = useCallback(async (type) => {
    setIsConnecting(true);
    setError(null);

    try {
      const result = await connectWallet(type);

      if (result.success) {
        setIsConnected(true);
        setAddress(result.address);
        setWalletType(type);
        setWalletInfo(WALLET_INFO[type]);
        
        // Fetch balance
        const bal = await getBalance();
        setBalance(bal);
      } else {
        setError(result.error);
      }

      setIsConnecting(false);
      return result;
    } catch (e) {
      setError(e.message);
      setIsConnecting(false);
      return { success: false, error: e.message };
    }
  }, []);

  /**
   * Connect to the best available wallet automatically
   */
  const connectAuto = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const result = await connectBestWallet();

      if (result.success) {
        setIsConnected(true);
        setAddress(result.address);
        setWalletType(result.walletType);
        setWalletInfo(WALLET_INFO[result.walletType]);
        
        const bal = await getBalance();
        setBalance(bal);
      } else {
        setError(result.error);
      }

      setIsConnecting(false);
      return result;
    } catch (e) {
      setError(e.message);
      setIsConnecting(false);
      return { success: false, error: e.message };
    }
  }, []);

  /**
   * Disconnect current wallet
   */
  const disconnect = useCallback(async () => {
    await disconnectWallet();
    setIsConnected(false);
    setAddress(null);
    setWalletType(null);
    setWalletInfo(null);
    setBalance(0);
    setError(null);
  }, []);

  /**
   * Sign and send a transaction
   */
  const sendTransaction = useCallback(async (transaction) => {
    if (!isConnected) {
      return { success: false, error: 'Not connected' };
    }

    try {
      const result = await signAndSendTransaction(transaction);
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }, [isConnected]);

  /**
   * Sign a message
   */
  const sign = useCallback(async (message) => {
    if (!isConnected) {
      return { success: false, error: 'Not connected' };
    }

    try {
      const result = await signMessage(message);
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }, [isConnected]);

  /**
   * Refresh balance
   */
  const refreshBalance = useCallback(async () => {
    if (!isConnected) return 0;
    const bal = await getBalance();
    setBalance(bal);
    return bal;
  }, [isConnected]);

  /**
   * Refresh available wallets
   */
  const refreshWallets = useCallback(async () => {
    const wallets = await getAvailableWallets();
    setAvailableWallets(wallets);
    return wallets;
  }, []);

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Context value
  const value = {
    // State
    isInitialized,
    isConnected,
    isConnecting,
    address,
    walletType,
    walletInfo,
    balance,
    availableWallets,
    error,
    
    // Methods
    connect,
    connectAuto,
    disconnect,
    sendTransaction,
    sign,
    refreshBalance,
    refreshWallets,
    clearError,
    
    // Constants
    WALLET_TYPES,
    WALLET_INFO,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
};

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to access wallet context
 * @returns {Object} Wallet context value
 */
export const useWallet = () => {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
};

export default WalletContext;
