// NFT Transfer Modal Component
// Send NFTs to other users by Solana address or email

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ScrollView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import NFTOperations from './nftOperations';
import { t } from './i18n';

// ============================================================================
// COLORS
// ============================================================================

const COLORS = {
  background: '#030308',
  surface: '#0A0A14',
  surfaceLight: '#12121E',
  primary: '#0099FF',
  secondary: '#A78BFA',
  accent: '#00FFA3',
  text: '#EEEEF6',
  textSecondary: '#7676A0',
  border: 'rgba(167,139,250,0.12)',
  error: '#FF4466',
  warning: '#F5C842',
  solana: '#0099FF',
};

// ============================================================================
// NFT TRANSFER MODAL COMPONENT
// ============================================================================

const NFTTransferModal = ({
  visible,
  nft,
  onClose,
  onTransferComplete,
  authToken,
}) => {
  const [transferMethod, setTransferMethod] = useState('address'); // 'address' or 'domain'
  const [recipientAddress, setRecipientAddress] = useState('');
  const [recipientDomain, setRecipientDomain] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolvedAddress, setResolvedAddress] = useState(null);
  const [error, setError] = useState(null);
  const [confirmAlert, setConfirmAlert] = useState(null);
  const [successAlert, setSuccessAlert] = useState(null);
  
  // Validate Solana address
  const isValidSolanaAddress = (address) => {
    // Solana addresses are base58 encoded and 32-44 characters
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(address);
  };
  
  // Validate .skr or .sol domain
  const isValidSolDomain = (domain) => {
    if (!domain) return false;
    const trimmed = domain.trim().toLowerCase();
    // Must end with .skr, .sol, or be a simple alphanumeric name
    return /^[a-z0-9][a-z0-9-]*(\.skr|\.sol)?$/.test(trimmed);
  };
  
  // Resolve .sol domain to address
  const resolveDomain = async (domain) => {
    if (!domain?.trim()) return;
    setResolving(true);
    setResolvedAddress(null);
    try {
      const result = await NFTOperations.resolveSolDomain(domain.trim());
      if (result.success) {
        setResolvedAddress(result.address);
        setError(null);
      } else {
        setError(result.error || 'Could not resolve domain');
      }
    } catch (e) {
      setError('Failed to resolve domain');
    } finally {
      setResolving(false);
    }
  };
  
  // Handle transfer
  const handleTransfer = async () => {
    setError(null);
    
    if (transferMethod === 'address') {
      if (!recipientAddress.trim()) {
        setError('Please enter a recipient address');
        return;
      }
      if (!isValidSolanaAddress(recipientAddress.trim())) {
        setError('Invalid Solana wallet address');
        return;
      }
    } else {
      if (!recipientDomain.trim()) {
        setError('Please enter a .sol domain');
        return;
      }
      if (!isValidSolDomain(recipientDomain.trim())) {
        setError('Invalid .sol domain format');
        return;
      }
    }
    
    const recipient = transferMethod === 'address' ? recipientAddress : recipientDomain;
    
    // Show dark themed confirmation alert
    setConfirmAlert({
      title: t('nftTransfer.confirmTransfer'),
      message: t('nftTransfer.confirmTransferMessage', { name: nft?.name, recipient }),
      onConfirm: executeTransfer,
      onCancel: () => setConfirmAlert(null),
    });
  };
  
  // Execute the transfer
  const executeTransfer = async () => {
    setConfirmAlert(null); // Close confirmation alert
    setTransferring(true);
    setError(null);
    
    try {
      // transferNFT handles both addresses and .sol/.skr domains
      let recipient = transferMethod === 'address' 
        ? recipientAddress.trim() 
        : recipientDomain.trim();
      // Auto-append .skr for bare seeker IDs so resolveRecipient treats them as domains
      if (transferMethod === 'domain' && recipient && !recipient.includes('.')) {
        recipient = recipient + '.skr';
      }
      
      console.log('[NFTTransfer] Starting transfer to:', recipient);
      const result = await NFTOperations.transferNFT(nft.mintAddress, recipient);
      console.log('[NFTTransfer] Result:', result);
      
      setTransferring(false); // Stop loading before showing alert
      
      if (result.success) {
        // Show dark themed success alert
        setSuccessAlert({
          txSignature: result.txSignature,
          onDismiss: () => {
            setSuccessAlert(null);
            onClose?.();
            onTransferComplete?.(result);
          },
        });
      } else {
        setError(result.error || 'Transfer failed');
      }
    } catch (e) {
      console.error('[NFTTransfer] Error:', e);
      setTransferring(false);
      setError(e.message || 'Transfer failed');
    }
  };
  
  // Reset state when closing
  const handleClose = () => {
    setRecipientAddress('');
    setRecipientDomain('');
    setResolvedAddress(null);
    setError(null);
    setTransferMethod('address');
    onClose?.();
  };
  
  if (!visible || !nft) return null;
  
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.modalOverlay}
      >
        <View style={styles.modalContainer}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{t('nftTransfer.title')}</Text>
            <TouchableOpacity onPress={handleClose} disabled={transferring}>
              <Feather name="x" size={24} color={COLORS.text} />
            </TouchableOpacity>
          </View>
          
          <ScrollView 
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentContainer}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
          {/* NFT Preview */}
          <View style={styles.nftPreview}>
            <Image
              source={{ uri: nft.imageUrl }}
              style={styles.nftImage}
              resizeMode="cover"
            />
            <View style={styles.nftInfo}>
              <Text style={styles.nftName} numberOfLines={1}>{nft.name}</Text>
              <Text style={styles.nftMint} numberOfLines={1}>
                {nft.mintAddress?.slice(0, 8)}...{nft.mintAddress?.slice(-8)}
              </Text>
            </View>
          </View>
          
          {/* Transfer method tabs */}
          <View style={styles.methodTabs}>
            <TouchableOpacity
              style={[styles.methodTab, transferMethod === 'address' && styles.methodTabActive]}
              onPress={() => setTransferMethod('address')}
              disabled={transferring}
            >
              <Feather
                name="hash"
                size={16}
                color={transferMethod === 'address' ? COLORS.primary : COLORS.textSecondary}
              />
              <Text style={[
                styles.methodTabText,
                transferMethod === 'address' && styles.methodTabTextActive
              ]}>
                {t('nftTransfer.walletAddress')}
              </Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.methodTab, transferMethod === 'domain' && styles.methodTabActive]}
              onPress={() => setTransferMethod('domain')}
              disabled={transferring}
            >
              <Feather
                name="at-sign"
                size={16}
                color={transferMethod === 'domain' ? COLORS.primary : COLORS.textSecondary}
              />
              <Text style={[
                styles.methodTabText,
                transferMethod === 'domain' && styles.methodTabTextActive
              ]}>
                {t('nftTransfer.seekerId')}
              </Text>
            </TouchableOpacity>
          </View>
          
          {/* Input field */}
          <View style={styles.inputContainer}>
            {transferMethod === 'address' ? (
              <>
                <Text style={styles.inputLabel}>{t('nftTransfer.recipientAddress')}</Text>
                <TextInput
                  style={styles.textInput}
                  value={recipientAddress}
                  onChangeText={setRecipientAddress}
                  placeholder={t('nftTransfer.enterWalletAddress')}
                  placeholderTextColor={COLORS.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!transferring}
                />
                <Text style={styles.inputHint}>
                  {t('nftTransfer.walletAddressHint')}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.inputLabel}>{t('nftTransfer.recipientSeekerId')}</Text>
                <View style={styles.domainInputRow}>
                  <TextInput
                    style={[styles.textInput, styles.domainInput]}
                    value={recipientDomain}
                    onChangeText={(text) => {
                      setRecipientDomain(text);
                      setResolvedAddress(null);
                    }}
                    placeholder={t('nftTransfer.seekerIdPlaceholder')}
                    placeholderTextColor={COLORS.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!transferring && !resolving}
                  />
                  <TouchableOpacity
                    style={[styles.resolveButton, resolving && styles.resolveButtonDisabled]}
                    onPress={() => resolveDomain(recipientDomain)}
                    disabled={!recipientDomain.trim() || resolving || transferring}
                  >
                    {resolving ? (
                      <ActivityIndicator size="small" color={COLORS.primary} />
                    ) : (
                      <Feather name="search" size={18} color={COLORS.primary} />
                    )}
                  </TouchableOpacity>
                </View>
                {resolvedAddress && (
                  <View style={styles.resolvedContainer}>
                    <Feather name="check-circle" size={14} color={COLORS.accent} />
                    <Text style={styles.resolvedText} numberOfLines={1}>
                      {resolvedAddress.slice(0, 12)}...{resolvedAddress.slice(-12)}
                    </Text>
                  </View>
                )}
                <Text style={styles.inputHint}>
                  {t('nftTransfer.seekerIdHint')}
                </Text>
              </>
            )}
          </View>
          
          {/* Error message */}
          {error && (
            <View style={styles.errorContainer}>
              <Feather name="alert-circle" size={16} color={COLORS.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          
          {/* Warning */}
          <View style={styles.warningContainer}>
            <Feather name="alert-triangle" size={16} color={COLORS.warning} />
            <Text style={styles.warningText}>
              {t('nftTransfer.warningMessage')}
            </Text>
          </View>
          </ScrollView>
          
          {/* Buttons */}
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={handleClose}
              disabled={transferring}
            >
              <Text style={styles.cancelButtonText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.transferButton, transferring && styles.transferButtonDisabled]}
              onPress={handleTransfer}
              disabled={transferring}
            >
              {transferring ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Feather name="send" size={18} color="#fff" />
                  <Text style={styles.transferButtonText}>{t('nftTransfer.transfer')}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
        
        {/* Dark themed confirmation alert */}
        {confirmAlert && (
          <View style={styles.alertOverlay}>
            <View style={styles.alertContainer}>
              <Text style={styles.alertTitle}>{confirmAlert.title}</Text>
              <Text style={styles.alertMessage}>{confirmAlert.message}</Text>
              <Text style={styles.alertWarning}>{t('nftTransfer.cannotBeUndone')}</Text>
              <View style={styles.alertButtons}>
                <TouchableOpacity
                  style={styles.alertCancelButton}
                  onPress={confirmAlert.onCancel}
                >
                  <Text style={styles.alertCancelText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.alertConfirmButton}
                  onPress={confirmAlert.onConfirm}
                >
                  <Text style={styles.alertConfirmText}>{t('nftTransfer.transfer')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
        
        {/* Dark themed success alert */}
        {successAlert && (
          <View style={styles.alertOverlay}>
            <View style={styles.alertContainer}>
              <Feather name="check-circle" size={48} color={COLORS.accent} style={{ alignSelf: 'center', marginBottom: 16 }} />
              <Text style={styles.alertTitle}>{t('nftTransfer.transferSuccessful')}</Text>
              <Text style={styles.alertMessage}>{t('nftTransfer.transferSuccessMessage')}</Text>
              <Text style={styles.txSignature}>{t('nftTransfer.transaction')}: {successAlert.txSignature?.slice(0, 24)}...</Text>
              <View style={[styles.alertButtons, { marginTop: 20 }]}>
                <TouchableOpacity
                  style={[styles.alertConfirmButton, { backgroundColor: COLORS.accent }]}
                  onPress={successAlert.onDismiss}
                >
                  <Text style={styles.alertConfirmText}>{t('common.ok')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    overflow: 'hidden',
    maxHeight: '90%',
  },
  scrollContent: {
    flexGrow: 0,
  },
  scrollContentContainer: {
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.text,
    marginHorizontal: 8,
  },
  nftPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: COLORS.surfaceLight,
  },
  nftImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
  },
  nftInfo: {
    flex: 1,
    marginLeft: 12,
  },
  nftName: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 4,
  },
  nftMint: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  methodTabs: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  methodTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  methodTabActive: {
    borderColor: COLORS.primary,
    backgroundColor: `${COLORS.primary}15`,
  },
  methodTabText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },
  methodTabTextActive: {
    color: COLORS.primary,
  },
  inputContainer: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    padding: 14,
    color: COLORS.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  domainInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  domainInput: {
    flex: 1,
  },
  resolveButton: {
    width: 48,
    height: 48,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resolveButtonDisabled: {
    opacity: 0.5,
  },
  resolvedContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: `${COLORS.accent}15`,
    borderRadius: 6,
  },
  resolvedText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.accent,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  inputHint: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 8,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 12,
    backgroundColor: `${COLORS.error}15`,
    borderRadius: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.error,
  },
  warningContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 12,
    backgroundColor: `${COLORS.warning}15`,
    borderRadius: 8,
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.warning,
    lineHeight: 18,
  },
  buttonContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  transferButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
  },
  transferButtonDisabled: {
    opacity: 0.6,
  },
  transferButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F4F4F8',
  },
  // Dark themed alert styles
  alertOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  alertContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 320,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  alertTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: 12,
  },
  alertMessage: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  alertWarning: {
    fontSize: 12,
    color: COLORS.warning,
    textAlign: 'center',
    marginBottom: 20,
  },
  alertButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  alertCancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
  },
  alertCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  alertConfirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: COLORS.error,
    alignItems: 'center',
  },
  alertConfirmText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F4F4F8',
  },
  txSignature: {
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 8,
  },
});

export default NFTTransferModal;
