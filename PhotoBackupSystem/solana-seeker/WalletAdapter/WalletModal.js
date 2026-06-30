// WalletModal - Wallet Selection UI Component
// Shows available wallets and handles connection

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
  Platform,
  Linking,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';

import {
  getAvailableWallets,
  connectWallet,
  disconnectWallet,
  getConnectionStatus,
  WALLET_INFO,
} from './index';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ============================================================================
// WALLET MODAL COMPONENT
// ============================================================================

const WalletModal = ({
  visible,
  onClose,
  onConnect,
  onDisconnect,
  title,
  subtitle,
  t = (key) => key, // Translation function, defaults to returning key
}) => {
  // Use translations with fallbacks
  const modalTitle = title || t('walletModal.title') || 'Connect Wallet';
  const modalSubtitle = subtitle || t('walletModal.subtitle') || 'Choose a wallet to connect';
  const [availableWallets, setAvailableWallets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(null);
  const [error, setError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState(null);

  useEffect(() => {
    if (visible) {
      loadWallets();
      setConnectionStatus(getConnectionStatus());
    }
  }, [visible]);

  const loadWallets = async () => {
    setLoading(true);
    setError(null);
    try {
      const wallets = await getAvailableWallets();
      setAvailableWallets(wallets);
    } catch (e) {
      setError('Failed to load wallets');
      console.error('[WalletModal] Load error:', e);
    }
    setLoading(false);
  };

  const handleConnect = async (walletType) => {
    setConnecting(walletType);
    setError(null);

    try {
      const result = await connectWallet(walletType);

      if (result.success) {
        setConnectionStatus(getConnectionStatus());
        onConnect?.(result);
        onClose?.();
      } else if (result.userCancelled) {
        setError('Connection cancelled');
      } else {
        setError(result.error || 'Connection failed');
      }
    } catch (e) {
      setError(e.message || 'Connection failed');
    }

    setConnecting(null);
  };

  const handleDisconnect = async () => {
    await disconnectWallet();
    setConnectionStatus(null);
    onDisconnect?.();
  };

  const handleInstallWallet = async (wallet) => {
    const storeUrl = Platform.OS === 'ios' 
      ? wallet.appStoreUrl 
      : wallet.playStoreUrl;
    
    if (storeUrl) {
      await Linking.openURL(storeUrl);
    }
  };

  const getWalletIcon = (iconName) => {
    const iconMap = {
      wallet: 'credit-card',
      ghost: 'box',
      link: 'link',
      hexagon: 'hexagon',
    };
    return iconMap[iconName] || 'credit-card';
  };

  const renderWalletItem = (wallet) => {
    const isConnecting = connecting === wallet.type;
    const isConnected = connectionStatus?.walletType === wallet.type;

    return (
      <TouchableOpacity
        key={wallet.type}
        style={[
          styles.walletItem,
          isConnected && styles.walletItemConnected,
          !wallet.isInstalled && styles.walletItemNotInstalled,
        ]}
        onPress={() => {
          if (wallet.isInstalled) {
            handleConnect(wallet.type);
          } else {
            handleInstallWallet(wallet);
          }
        }}
        disabled={isConnecting}
      >
        <View style={styles.walletIconContainer}>
          <Feather
            name={getWalletIcon(wallet.icon)}
            size={24}
            color={isConnected ? '#A78BFA' : '#FFFFFF'}
          />
        </View>

        <View style={styles.walletInfo}>
          <Text style={[styles.walletName, isConnected && styles.walletNameConnected]}>
            {wallet.name}
          </Text>
          <Text style={styles.walletDescription}>
            {wallet.isInstalled ? wallet.description : (t('walletModal.tapToInstall') || 'Tap to install')}
          </Text>
        </View>

        <View style={styles.walletAction}>
          {isConnecting ? (
            <ActivityIndicator size="small" color="#A78BFA" />
          ) : isConnected ? (
            <View style={styles.connectedBadge}>
              <Feather name="check-circle" size={16} color="#A78BFA" />
              <Text style={styles.connectedText}>{t('walletModal.connected') || 'Connected'}</Text>
            </View>
          ) : !wallet.isInstalled ? (
            <Feather name="download" size={20} color="#888888" />
          ) : (
            <Feather name="chevron-right" size={20} color="#888888" />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <BlurView intensity={20} style={styles.overlay}>
        <TouchableOpacity
          style={styles.overlayTouchable}
          activeOpacity={1}
          onPress={onClose}
        >
          <View style={styles.modalContainer}>
            <TouchableOpacity activeOpacity={1}>
              <View style={styles.modal}>
                {/* Header */}
                <View style={styles.header}>
                  <View>
                    <Text style={styles.title}>{modalTitle}</Text>
                    <Text style={styles.subtitle}>{modalSubtitle}</Text>
                  </View>
                  <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                    <Feather name="x" size={24} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>

                {/* Connected Status */}
                {connectionStatus?.isConnected && (
                  <View style={styles.connectedStatus}>
                    <View style={styles.connectedInfo}>
                      <Feather name="check-circle" size={20} color="#A78BFA" />
                      <View style={styles.connectedDetails}>
                        <Text style={styles.connectedLabel}>{t('walletModal.connected') || 'Connected'}</Text>
                        <Text style={styles.connectedAddress} numberOfLines={1}>
                          {connectionStatus.address?.slice(0, 8)}...
                          {connectionStatus.address?.slice(-6)}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.disconnectButton}
                      onPress={handleDisconnect}
                    >
                      <Text style={styles.disconnectText}>{t('walletModal.disconnect') || 'Disconnect'}</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Error */}
                {error && (
                  <View style={styles.errorContainer}>
                    <Feather name="alert-circle" size={16} color="#FF6B6B" />
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}

                {/* Wallet List */}
                <View style={styles.walletList}>
                  {loading ? (
                    <View style={styles.loadingContainer}>
                      <ActivityIndicator size="large" color="#A78BFA" />
                      <Text style={styles.loadingText}>{t('walletModal.loadingWallets') || 'Loading wallets...'}</Text>
                    </View>
                  ) : availableWallets.length === 0 ? (
                    <View style={styles.emptyContainer}>
                      <Feather name="alert-triangle" size={32} color="#888888" />
                      <Text style={styles.emptyText}>{t('walletModal.noWalletsAvailable') || 'No wallets available'}</Text>
                      <Text style={styles.emptySubtext}>
                        {t('walletModal.installWalletHint') || 'Install Phantom or another Solana wallet'}
                      </Text>
                    </View>
                  ) : (
                    availableWallets.map(renderWalletItem)
                  )}
                </View>

                {/* Footer */}
                <View style={styles.footer}>
                  <Text style={styles.footerText}>
                    {t('walletModal.footerText') || 'Payments are made in SOL on Solana blockchain'}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </BlurView>
    </Modal>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  overlayTouchable: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContainer: {
    width: SCREEN_WIDTH - 40,
    maxWidth: 400,
  },
  modal: {
    backgroundColor: '#1A1A2E',
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(3, 225, 255, 0.2)',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#888888',
  },
  closeButton: {
    padding: 4,
  },
  connectedStatus: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: 'rgba(3, 225, 255, 0.1)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  connectedInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  connectedDetails: {
    marginLeft: 12,
    flex: 1,
  },
  connectedLabel: {
    fontSize: 12,
    color: '#A78BFA',
    fontWeight: '600',
  },
  connectedAddress: {
    fontSize: 14,
    color: '#FFFFFF',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  disconnectButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 107, 107, 0.2)',
  },
  disconnectText: {
    fontSize: 12,
    color: '#FF6B6B',
    fontWeight: '600',
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: 'rgba(255, 107, 107, 0.1)',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 8,
  },
  errorText: {
    fontSize: 14,
    color: '#FF6B6B',
    marginLeft: 8,
    flex: 1,
  },
  walletList: {
    padding: 16,
  },
  loadingContainer: {
    alignItems: 'center',
    padding: 40,
  },
  loadingText: {
    fontSize: 14,
    color: '#888888',
    marginTop: 12,
  },
  emptyContainer: {
    alignItems: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: 16,
    color: '#FFFFFF',
    marginTop: 12,
    fontWeight: '600',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#888888',
    marginTop: 4,
    textAlign: 'center',
  },
  walletItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  walletItemConnected: {
    borderColor: 'rgba(3, 225, 255, 0.5)',
    backgroundColor: 'rgba(3, 225, 255, 0.1)',
  },
  walletItemNotInstalled: {
    opacity: 0.6,
  },
  walletIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  walletInfo: {
    flex: 1,
    marginLeft: 16,
  },
  walletName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 2,
  },
  walletNameConnected: {
    color: '#A78BFA',
  },
  walletDescription: {
    fontSize: 13,
    color: '#888888',
  },
  walletAction: {
    marginLeft: 12,
  },
  connectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  connectedText: {
    fontSize: 12,
    color: '#A78BFA',
    marginLeft: 4,
    fontWeight: '600',
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: '#666666',
    textAlign: 'center',
  },
});

export default WalletModal;
