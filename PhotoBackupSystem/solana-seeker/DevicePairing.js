// DevicePairing.js — Cross-app QR pairing (solana-seeker ↔ mobile-v2, iOS ↔ Android)
// Shows QR code with device_uuid for another app to scan, or scans another device's QR.
// Server links the two device_uuids so NFT/certificate data is merged on read.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, StatusBar,
  ActivityIndicator, Alert, Dimensions, ScrollView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import QRCode from 'react-native-qrcode-svg';
import axios from 'axios';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as LocalAuthentication from 'expo-local-authentication';
import { t } from './i18n';
import { getDeviceHardwareId } from './deviceId';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCREEN_HEIGHT_FULL = Dimensions.get('screen').height;
const ANDROID_NAV_BAR_HEIGHT = Platform.OS === 'android' ? Math.max(48, SCREEN_HEIGHT_FULL - SCREEN_HEIGHT) : 0;
const isTablet = SCREEN_WIDTH >= 768;
const scale = (v) => (isTablet ? v * 1.25 : v);
const scaleSpacing = (v) => (isTablet ? v * 1.2 : v);

const QR_TYPE = 'photolynk-device-pair';

const sortLinkedDevices = (links) => [...links].sort((a, b) => {
  const aUuid = a?.paired_device_uuid || '';
  const bUuid = b?.paired_device_uuid || '';
  return aUuid.localeCompare(bUuid);
});

const areLinkedDevicesEqual = (a, b) => {
  const left = sortLinkedDevices(Array.isArray(a) ? a : []);
  const right = sortLinkedDevices(Array.isArray(b) ? b : []);

  if (left.length !== right.length) return false;

  return left.every((link, index) => {
    const other = right[index];
    return (
      link?.paired_device_uuid === other?.paired_device_uuid &&
      link?.label === other?.label &&
      !!link?.canSwitch === !!other?.canSwitch
    );
  });
};

/**
 * DevicePairing overlay component.
 *
 * Props:
 *  - visible: boolean
 *  - onClose: () => void
 *  - token: string (JWT)
 *  - deviceUuid: string
 *  - serverUrl: string (computed server URL)
 *  - email: string (user's email for credential sharing)
 *  - password: string (user's password for credential sharing)
 *  - mkEmail: string (master key email — only set for migrated legacy→wallet users)
 *  - mkPassword: string (master key password — only set for migrated legacy→wallet users)
 *  - onPaired: (pairedDeviceUuid) => void — called after successful pairing
 *  - onSwitchAccount: (email, password, mkEmail, mkPassword) => void — called when user wants to switch to paired device account
 */
const DevicePairing = ({ visible, onClose, token, deviceUuid, serverUrl, email, password, mkEmail, mkPassword, onPaired, onSwitchAccount }) => {
  const insets = useSafeAreaInsets();
  const bottomInset = Platform.OS === 'android' ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT) : insets.bottom;
  const overlayTopInset = Platform.OS === 'ios' ? insets.top + scaleSpacing(8) : (StatusBar.currentHeight || 24);
  const [mode, setMode] = useState(null); // null = choose, 'show' = show QR, 'scan' = scan QR
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [linkedDevices, setLinkedDevices] = useState([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [pairingDeviceId, setPairingDeviceId] = useState('');
  const linkedDevicesRef = useRef([]);
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    linkedDevicesRef.current = linkedDevices;
  }, [linkedDevices]);

  useEffect(() => {
    let cancelled = false;
    const loadPairingDeviceId = async () => {
      try {
        const resolvedId = await getDeviceHardwareId();
        if (!cancelled) {
          setPairingDeviceId(resolvedId || '');
        }
      } catch (e) {
        console.log('[Pairing] Failed to get pairing device ID:', e?.message);
        if (!cancelled) {
          setPairingDeviceId('');
        }
      }
    };
    loadPairingDeviceId();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setMode(null);
      setError('');
      setSuccess('');
      setScanned(false);
    }
  }, [visible]);

  const getSwitchableDeviceUuids = async () => {
    try {
      const storedRaw = await SecureStore.getItemAsync('paired_switchable_device_uuids');
      const stored = storedRaw ? JSON.parse(storedRaw) : [];
      return Array.isArray(stored) ? stored.filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  };

  const setSwitchableDeviceUuids = async (uuids) => {
    try {
      const deduped = Array.from(new Set((Array.isArray(uuids) ? uuids : []).filter(Boolean)));
      await SecureStore.setItemAsync('paired_switchable_device_uuids', JSON.stringify(deduped));
    } catch (_) {}
  };

  const hasStoredCredentialsForUuid = async (targetUuid) => {
    try {
      const switchableUuids = await getSwitchableDeviceUuids();
      return switchableUuids.includes(targetUuid);
    } catch (_) {
      return false;
    }
  };

  const getStoredPairedDeviceUuids = async () => {
    try {
      const storedUuidsRaw = await SecureStore.getItemAsync('paired_device_uuids');
      const storedUuids = storedUuidsRaw ? JSON.parse(storedUuidsRaw) : [];
      return Array.isArray(storedUuids) ? storedUuids.filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  };

  const getCachedLinkedDeviceUuids = async () => {
    try {
      const cachedUuidsRaw = await SecureStore.getItemAsync('linked_device_uuids');
      const cachedUuids = cachedUuidsRaw ? JSON.parse(cachedUuidsRaw) : [];
      return Array.isArray(cachedUuids) ? cachedUuids.filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  };

  const setCachedLinkedDeviceUuids = async (uuids) => {
    try {
      const deduped = Array.from(new Set((Array.isArray(uuids) ? uuids : []).filter(Boolean)));
      await SecureStore.setItemAsync('linked_device_uuids', JSON.stringify(deduped));
    } catch (_) {}
  };

  const loadLinkedDevices = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++loadRequestIdRef.current;
    if (!silent) {
      setLoadingLinks(true);
    }
    try {
      // Extract device_uuid from JWT to ensure header matches token
      let authDeviceUuid = deviceUuid;
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          if (payload.device_uuid) authDeviceUuid = payload.device_uuid;
        } catch (_) {}
      }
      console.log('[Pairing] Loading links with deviceUuid:', deviceUuid, 'authDeviceUuid:', authDeviceUuid, 'pairingDeviceId:', pairingDeviceId);
      const res = await axios.get(`${serverUrl}/api/device/links`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Device-UUID': authDeviceUuid,
          'X-Pairing-Device-ID': pairingDeviceId,
        },
        timeout: 10000,
      });
      const links = Array.isArray(res.data?.links) ? res.data.links : [];
      const storedPairedUuids = await getStoredPairedDeviceUuids();
      const cachedLinkedUuids = await getCachedLinkedDeviceUuids();
      const mergedLinksMap = new Map();

      for (const link of links) {
        if (!link?.paired_device_uuid) continue;
        mergedLinksMap.set(link.paired_device_uuid, { ...link });
      }

      for (const cachedUuid of cachedLinkedUuids) {
        if (!mergedLinksMap.has(cachedUuid)) {
          mergedLinksMap.set(cachedUuid, {
            id: `cached-${cachedUuid}`,
            paired_device_uuid: cachedUuid,
            label: Platform.OS + ' pairing',
          });
        }
      }

      for (const storedUuid of storedPairedUuids) {
        if (!mergedLinksMap.has(storedUuid)) {
          mergedLinksMap.set(storedUuid, {
            id: `stored-${storedUuid}`,
            paired_device_uuid: storedUuid,
            label: Platform.OS + ' pairing',
          });
        }
      }

      const enrichedLinks = await Promise.all(Array.from(mergedLinksMap.values()).map(async (link) => ({
        ...link,
        canSwitch: await hasStoredCredentialsForUuid(link.paired_device_uuid),
      })));
      await setCachedLinkedDeviceUuids(enrichedLinks.map(link => link.paired_device_uuid));
      if (requestId === loadRequestIdRef.current && !areLinkedDevicesEqual(linkedDevicesRef.current, enrichedLinks)) {
        linkedDevicesRef.current = enrichedLinks;
        setLinkedDevices(enrichedLinks);
      }
    } catch (e) {
      console.log('[Pairing] Failed to load links:', e.message);
      try {
        const storedPairedUuids = await getStoredPairedDeviceUuids();
        const cachedLinkedUuids = await getCachedLinkedDeviceUuids();
        const fallbackUuids = Array.from(new Set([...cachedLinkedUuids, ...storedPairedUuids]));
        const fallbackLinks = await Promise.all(fallbackUuids.map(async (storedUuid) => ({
          id: `fallback-${storedUuid}`,
          paired_device_uuid: storedUuid,
          label: Platform.OS + ' pairing',
          canSwitch: await hasStoredCredentialsForUuid(storedUuid),
        })));
        if (requestId === loadRequestIdRef.current && !areLinkedDevicesEqual(linkedDevicesRef.current, fallbackLinks)) {
          linkedDevicesRef.current = fallbackLinks;
          setLinkedDevices(fallbackLinks);
        }
      } catch (_) {}
    }
    if (!silent && requestId === loadRequestIdRef.current) {
      setLoadingLinks(false);
    }
  }, [deviceUuid, pairingDeviceId, serverUrl, token]);

  const refreshLinkedDevicesBurst = useCallback(() => {
    loadLinkedDevices({ silent: true });
    const timeouts = [500, 1200, 2200, 3600].map((delay) => setTimeout(() => {
      loadLinkedDevices({ silent: true });
    }, delay));
    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [loadLinkedDevices]);

  useEffect(() => {
    if (visible && token && serverUrl && pairingDeviceId) {
      loadLinkedDevices();
    }
  }, [visible, token, serverUrl, pairingDeviceId, loadLinkedDevices]);

  useEffect(() => {
    if (!(visible && mode === 'show' && token && serverUrl && pairingDeviceId)) {
      return undefined;
    }

    loadLinkedDevices({ silent: true });
    const interval = setInterval(() => {
      loadLinkedDevices({ silent: true });
    }, 1200);

    return () => clearInterval(interval);
  }, [visible, mode, token, serverUrl, pairingDeviceId, loadLinkedDevices]);

  const handleUnlink = async (targetUuid) => {
    try {
      let authDeviceUuid = deviceUuid;
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          if (payload.device_uuid) authDeviceUuid = payload.device_uuid;
        } catch (_) {}
      }
      await axios.delete(`${serverUrl}/api/device/link`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Device-UUID': authDeviceUuid,
          'X-Pairing-Device-ID': pairingDeviceId,
          'Content-Type': 'application/json'
        },
        data: { target_device_uuid: targetUuid },
        timeout: 10000,
      });
      setLinkedDevices(prev => prev.filter(l => l.paired_device_uuid !== targetUuid));
      // Clear from SecureStore
      try {
        const stored = await SecureStore.getItemAsync('paired_device_uuids');
        if (stored) {
          const arr = JSON.parse(stored).filter(u => u !== targetUuid);
          await SecureStore.setItemAsync('paired_device_uuids', JSON.stringify(arr));
        }
        const linkedStored = await SecureStore.getItemAsync('linked_device_uuids');
        if (linkedStored) {
          const arr = JSON.parse(linkedStored).filter(u => u !== targetUuid);
          await SecureStore.setItemAsync('linked_device_uuids', JSON.stringify(arr));
        }
        const switchableStored = await SecureStore.getItemAsync('paired_switchable_device_uuids');
        if (switchableStored) {
          const arr = JSON.parse(switchableStored).filter(u => u !== targetUuid);
          await SecureStore.setItemAsync('paired_switchable_device_uuids', JSON.stringify(arr));
        }
        await SecureStore.deleteItemAsync(`paired_email_${targetUuid}`);
        await SecureStore.deleteItemAsync(`paired_password_${targetUuid}`);
        await SecureStore.deleteItemAsync(`paired_credentials_${targetUuid}`);
        await SecureStore.deleteItemAsync(`paired_mk_email_${targetUuid}`);
        await SecureStore.deleteItemAsync(`paired_mk_password_${targetUuid}`);
      } catch (_) {}
    } catch (e) {
      setError(t('pairing.unlinkFailed') || 'Failed to unlink device');
    }
  };

  const handleSwitchAccount = async (targetUuid) => {
    try {
      console.log('[Pairing] Retrieving credentials for:', targetUuid);
      let pairedEmail = null;
      let pairedPassword = null;
      let pairedMkEmail = null;
      let pairedMkPassword = null;

      try {
        const pairedCredsRaw = await SecureStore.getItemAsync(`paired_credentials_${targetUuid}`, {
          requireAuthentication: true,
          authenticationPrompt: t('pairing.switchAccountPrompt') || 'Authenticate to switch accounts'
        });
        if (pairedCredsRaw) {
          const pairedCreds = JSON.parse(pairedCredsRaw);
          pairedEmail = pairedCreds?.email || null;
          pairedPassword = pairedCreds?.password || null;
          pairedMkEmail = pairedCreds?.mkEmail || null;
          pairedMkPassword = pairedCreds?.mkPassword || null;
        }
      } catch (bioErr) {
        console.log('[Pairing] Combined biometric credential read failed, trying legacy keys:', bioErr.message);
      }

      if (!pairedEmail || !pairedPassword) {
        // Legacy fallback for older pairings stored as separate keys.
        // Avoid repeating biometric prompts here; use silent reads only.
        try { pairedEmail = await SecureStore.getItemAsync(`paired_email_${targetUuid}`); } catch (_) {}
        try { pairedPassword = await SecureStore.getItemAsync(`paired_password_${targetUuid}`); } catch (_) {}
      }
      
      console.log('[Pairing] Retrieved email:', pairedEmail, 'password:', pairedPassword ? '***' : 'EMPTY');
      
      if (pairedEmail && pairedPassword && onSwitchAccount) {
        if (!pairedMkEmail && !pairedMkPassword) {
          try {
            pairedMkEmail = await SecureStore.getItemAsync(`paired_mk_email_${targetUuid}`);
            pairedMkPassword = await SecureStore.getItemAsync(`paired_mk_password_${targetUuid}`);
          } catch (_) {}
        }
        onClose();
        onSwitchAccount(pairedEmail, pairedPassword, pairedMkEmail, pairedMkPassword);
      } else {
        setError(t('pairing.credentialsNotFound') || 'Paired credentials not found');
      }
    } catch (e) {
      if (e.message?.includes('cancel')) {
        // User cancelled biometric prompt
        return;
      }
      setError(t('pairing.switchFailed') || 'Failed to switch account');
    }
  };

  // QR payload: JSON with type, device_uuid, server URL, credentials, and optional master key creds
  // mk_email/mk_password are included for migrated legacy→wallet users whose master key
  // derives from original (legacy) credentials, not the current wallet-derived ones.
  const qrData = {
    type: QR_TYPE,
    device_uuid: pairingDeviceId,
    server: serverUrl,
    email: email,
    password: password,
  };
  if (mkEmail && mkPassword && (mkEmail !== email || mkPassword !== password)) {
    qrData.mk_email = mkEmail;
    qrData.mk_password = mkPassword;
  }
  const qrPayload = JSON.stringify(qrData);

  // Handle scanning another device's QR
  const handleQRScanned = useCallback(async (data) => {
    if (scanned || linking) return;
    setScanned(true);

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      setError(t('pairing.invalidQr') || 'Invalid QR code');
      setTimeout(() => setScanned(false), 2000);
      return;
    }

    if (parsed.type !== QR_TYPE || !parsed.device_uuid) {
      setError(t('pairing.wrongQrType') || 'This QR code is not a device pairing code');
      setTimeout(() => setScanned(false), 2000);
      return;
    }

    if (parsed.device_uuid === pairingDeviceId) {
      setError(t('pairing.cannotPairSelf') || 'Cannot pair with yourself');
      setTimeout(() => setScanned(false), 2000);
      return;
    }

    // Link on server
    setLinking(true);
    setError('');
    try {
      let authDeviceUuid = deviceUuid;
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          if (payload.device_uuid) authDeviceUuid = payload.device_uuid;
        } catch (_) {}
      }
      const res = await axios.post(`${serverUrl}/api/device/link`, {
        target_device_uuid: parsed.device_uuid,
        label: Platform.OS + ' pairing',
      }, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Device-UUID': authDeviceUuid,
          'X-Pairing-Device-ID': pairingDeviceId,
        },
        timeout: 10000,
      });

      if (res.data?.success) {
        // Store paired UUID and credentials locally with biometric protection
        let canSwitchForParsedDevice = false;
        try {
          const stored = await SecureStore.getItemAsync('paired_device_uuids');
          const arr = stored ? JSON.parse(stored) : [];
          if (!arr.includes(parsed.device_uuid)) arr.push(parsed.device_uuid);
          await SecureStore.setItemAsync('paired_device_uuids', JSON.stringify(arr));
          
          // Store paired credentials securely (for backup/sync operations)
          if (parsed.email && parsed.password) {
            const combinedCreds = JSON.stringify({
              email: parsed.email,
              password: parsed.password,
              mkEmail: parsed.mk_email || null,
              mkPassword: parsed.mk_password || null,
            });
            await SecureStore.setItemAsync(`paired_credentials_${parsed.device_uuid}`, combinedCreds, {
              requireAuthentication: true,
              authenticationPrompt: t('pairing.storePairedCredentials') || 'Store paired device credentials'
            });
            await SecureStore.setItemAsync(`paired_email_${parsed.device_uuid}`, parsed.email);
            await SecureStore.setItemAsync(`paired_password_${parsed.device_uuid}`, parsed.password);
            canSwitchForParsedDevice = true;
            const switchableUuids = await getSwitchableDeviceUuids();
            if (!switchableUuids.includes(parsed.device_uuid)) {
              await setSwitchableDeviceUuids([...switchableUuids, parsed.device_uuid]);
            }
          }
          // Store master key credentials if provided (migrated legacy→wallet users)
          if (parsed.mk_email && parsed.mk_password) {
            await SecureStore.setItemAsync(`paired_mk_email_${parsed.device_uuid}`, parsed.mk_email);
            await SecureStore.setItemAsync(`paired_mk_password_${parsed.device_uuid}`, parsed.mk_password);
          }
        } catch (_) {}

        setSuccess(t('pairing.success') || 'Devices paired successfully! NFTs and certificates will now sync across both apps.');
        setLinkedDevices(prev => {
          const withoutCurrent = prev.filter(link => link.paired_device_uuid !== parsed.device_uuid);
          return [{
            id: `local-${parsed.device_uuid}`,
            paired_device_uuid: parsed.device_uuid,
            label: Platform.OS + ' pairing',
            canSwitch: canSwitchForParsedDevice,
          }, ...withoutCurrent];
        });
        onPaired?.(parsed.device_uuid);
        loadLinkedDevices();
        
        // Automatically switch to the paired account
        if (parsed.email && parsed.password && onSwitchAccount) {
          console.log('[Pairing] Auto-switching to paired account after successful pairing');
          onClose();
          onSwitchAccount(parsed.email, parsed.password, parsed.mk_email || null, parsed.mk_password || null);
        }
      } else {
        setError(res.data?.error || t('pairing.linkFailed') || 'Failed to link devices');
      }
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404) {
        setError(t('pairing.serverNotSupported') || 'Device pairing requires StealthCloud. Please switch both devices to StealthCloud in Settings before pairing.');
      } else {
        const msg = e?.response?.data?.error || e.message;
        setError(msg || t('pairing.linkFailed') || 'Failed to link devices');
      }
    }
    setLinking(false);
  }, [scanned, linking, deviceUuid, pairingDeviceId, token, serverUrl]);

  useEffect(() => {
    if (!visible || mode !== 'show' || !token || !serverUrl || !pairingDeviceId) return undefined;
    const cancelBurst = refreshLinkedDevicesBurst();
    const intervalId = setInterval(() => {
      loadLinkedDevices();
    }, 2000);
    return () => {
      clearInterval(intervalId);
      cancelBurst();
    };
  }, [visible, mode, token, serverUrl, pairingDeviceId, loadLinkedDevices, refreshLinkedDevicesBurst]);

  if (!visible) return null;

  // ─── Choose mode screen ────────────────────────────────────────────
  const renderChooseMode = () => (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset + scaleSpacing(24) }]}
      showsVerticalScrollIndicator={false}
    >
      <LinearGradient
        colors={['rgba(167,139,250,0.18)', 'rgba(108,92,231,0.06)']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={styles.heroCard}
      >
        <View style={styles.heroIconWrap}>
          <Feather name="link" size={scale(28)} color="#A78BFA" />
        </View>
        <Text style={styles.heroTitle}>{t('pairing.title') || 'Pair Another Phone or Tablet'}</Text>
        <Text style={styles.heroSubtitle}>
          {t('pairing.subtitle') || 'Share your account between phones and tablets. For desktop server pairing, use Settings.'}
        </Text>
      </LinearGradient>

      <Text style={styles.sectionLabel}>{t('pairing.choosePairingMethod') || 'Pairing method'}</Text>

      <TouchableOpacity activeOpacity={0.85} style={styles.optionBtn} onPress={async () => {
        try {
          const authResult = await LocalAuthentication.authenticateAsync({
            promptMessage: t('pairing.bioPromptShowQr') || 'Authenticate to show pairing QR',
            cancelLabel: t('common.cancel') || 'Cancel',
            disableDeviceFallback: false,
          });
          if (!authResult.success) return;
        } catch (e) {
          console.log('[Pairing] Biometric error:', e?.message);
          return;
        }
        refreshLinkedDevicesBurst();
        setMode('show');
      }}>
        <View style={[styles.optionIcon, { backgroundColor: 'rgba(167,139,250,0.16)', borderColor: 'rgba(167,139,250,0.32)' }]}>
          <Feather name="maximize" size={scale(20)} color="#A78BFA" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.optionTitle}>{t('pairing.showMyQr') || 'Show My QR Code'}</Text>
          <Text style={styles.optionSub}>{t('pairing.showMyQrSub') || 'Let the other device scan this QR'}</Text>
        </View>
        <Feather name="chevron-right" size={scale(18)} color="rgba(167,139,250,0.6)" />
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.85} style={styles.optionBtn} onPress={async () => {
        if (!cameraPermission?.granted) {
          const result = await requestCameraPermission();
          if (!result.granted) {
            Alert.alert(t('pairing.cameraRequired') || 'Camera Required', t('pairing.cameraRequiredMsg') || 'Camera permission is needed to scan QR codes.');
            return;
          }
        }
        setMode('scan');
      }}>
        <View style={[styles.optionIcon, { backgroundColor: 'rgba(0,255,163,0.14)', borderColor: 'rgba(0,255,163,0.32)' }]}>
          <Feather name="camera" size={scale(20)} color="#00FFA3" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.optionTitle}>{t('pairing.scanDevice') || 'Scan Other Device'}</Text>
          <Text style={styles.optionSub}>{t('pairing.scanDeviceSub') || 'Scan the QR code shown on the other device'}</Text>
        </View>
        <Feather name="chevron-right" size={scale(18)} color="rgba(0,255,163,0.6)" />
      </TouchableOpacity>

      {/* Linked devices list */}
      {loadingLinks ? (
        <ActivityIndicator color="#A78BFA" style={{ marginTop: scaleSpacing(20) }} />
      ) : linkedDevices.length > 0 ? (
        <View style={styles.linkedSection}>
          <View style={styles.linkedSectionHeader}>
            <Text style={styles.linkedTitle}>{t('pairing.linkedDevices') || 'Linked Devices'}</Text>
            <View style={styles.linkedCountPill}>
              <Text style={styles.linkedCountPillText}>{linkedDevices.length}</Text>
            </View>
          </View>
          {linkedDevices.map((link, i) => (
            <View key={link.id || i} style={styles.linkedCard}>
              <View style={styles.linkedRow}>
                <View style={styles.linkedDeviceIcon}>
                  <Feather name="smartphone" size={scale(14)} color="#A78BFA" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.linkedLabel} numberOfLines={1}>{link.label || (Platform.OS + ' pairing')}</Text>
                  <Text style={styles.linkedUuid} numberOfLines={1} ellipsizeMode="middle">{link.paired_device_uuid}</Text>
                </View>
                <TouchableOpacity
                  style={styles.linkedRemoveBtn}
                  onPress={() => handleUnlink(link.paired_device_uuid)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="x" size={scale(14)} color="#FF4466" />
                </TouchableOpacity>
              </View>
              {link.canSwitch ? (
                <TouchableOpacity style={styles.switchBtn} onPress={() => handleSwitchAccount(link.paired_device_uuid)} activeOpacity={0.85}>
                  <Feather name="refresh-cw" size={scale(13)} color="#A78BFA" />
                  <Text style={styles.switchBtnText}>{t('pairing.switchAccount') || 'Switch to this account'}</Text>
                </TouchableOpacity>
              ) : (
                <View style={[styles.switchBtn, styles.switchBtnDisabled]}>
                  <Feather name="info" size={scale(13)} color="rgba(255,255,255,0.45)" />
                  <Text style={[styles.switchBtnText, { color: 'rgba(255,255,255,0.55)' }]}>{t('pairing.sharedOnOtherDevice') || 'Shared on the other device'}</Text>
                </View>
              )}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );

  // ─── Show QR mode ──────────────────────────────────────────────────
  const renderShowQR = () => (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset + scaleSpacing(24), alignItems: 'center' }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>{t('pairing.showQrTitle') || 'Your Pairing QR Code'}</Text>
      <Text style={styles.subtitle}>
        {t('pairing.showQrInstruction') || 'Open the other PhotoLynk / Solana Seeker app, tap the pair icon, and scan this QR code.'}
      </Text>
      <LinearGradient
        colors={['rgba(167,139,250,0.22)', 'rgba(108,92,231,0.06)']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={styles.qrFrame}
      >
        <View style={styles.qrContainer}>
          <QRCode
            value={qrPayload}
            size={isTablet ? 260 : 220}
            backgroundColor="#FFFFFF"
            color="#000000"
          />
        </View>
        <View style={styles.qrAwaitingPill}>
          <View style={styles.qrAwaitingDot} />
          <Text style={styles.qrAwaitingText}>{t('pairing.awaitingScan') || 'Awaiting scan'}</Text>
        </View>
      </LinearGradient>
      <View style={styles.deviceIdCard}>
        <Text style={styles.deviceIdLabel}>{t('pairing.yourDeviceId') || 'Your Device ID'}</Text>
        <Text style={styles.deviceIdValue} numberOfLines={1} ellipsizeMode="middle">{pairingDeviceId || deviceUuid}</Text>
      </View>

      {success ? <Text style={styles.successText}>{success}</Text> : null}

      <TouchableOpacity style={styles.backBtn} onPress={async () => { await loadLinkedDevices(); refreshLinkedDevicesBurst(); setMode(null); setSuccess(''); }} activeOpacity={0.85}>
        <Feather name="arrow-left" size={scale(15)} color="#F4F4F8" style={{ marginRight: scaleSpacing(6) }} />
        <Text style={styles.backBtnText}>{t('common.back') || 'Back'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  // ─── Scan QR mode ─────────────────────────────────────────────────
  const renderScanQR = () => (
    <View style={{ flex: 1 }}>
      {cameraPermission?.granted ? (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          autofocus="on"
          zoom={0}
          barcodeScannerSettings={{ barcodeTypes: ['qr'], interval: 100 }}
          onBarcodeScanned={(result) => {
            if (result && result.data && !scanned && !linking) {
              handleQRScanned(result.data);
            }
          }}
        />
      ) : (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
          <Text style={{ color: '#888', textAlign: 'center', padding: scaleSpacing(20), fontSize: scale(14) }}>
            {t('permissions.cameraRequired') || 'Camera permission is required'}
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: '#A78BFA', paddingHorizontal: scaleSpacing(20), paddingVertical: scaleSpacing(10), borderRadius: scaleSpacing(8) }}
            onPress={requestCameraPermission}>
            <Text style={{ color: '#000000', fontWeight: '700', fontSize: scale(14) }}>{t('permissions.grant') || 'Grant'}</Text>
          </TouchableOpacity>
        </View>
      )}
      {/* Overlay */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' }}>
        <View style={{ paddingTop: overlayTopInset, paddingHorizontal: scaleSpacing(20), backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <Text style={{ color: '#fff', fontSize: scale(18), fontWeight: '600', textAlign: 'center' }}>
            {t('pairing.scanTitle') || 'Scan Pairing QR'}
          </Text>
          <Text style={{ color: '#aaa', fontSize: scale(13), textAlign: 'center', marginTop: scaleSpacing(4) }}>
            {t('pairing.scanInstruction') || 'Point at the QR code shown on the other device'}
          </Text>
        </View>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ width: isTablet ? 280 : 240, height: isTablet ? 280 : 240, borderWidth: 2, borderColor: '#A78BFA', borderRadius: scaleSpacing(16) }} />
        </View>
        {/* Status / error / linking overlay */}
        {(linking || error || success) ? (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.8)' }}>
            {linking ? (
              <>
                <ActivityIndicator size="large" color="#A78BFA" />
                <Text style={{ color: '#fff', fontSize: scale(16), marginTop: scaleSpacing(12) }}>
                  {t('pairing.linking') || 'Linking devices...'}
                </Text>
              </>
            ) : success ? (
              <>
                <Feather name="check-circle" size={scale(48)} color="#00FFA3" />
                <Text style={{ color: '#00FFA3', fontSize: scale(16), fontWeight: '600', marginTop: scaleSpacing(12), textAlign: 'center', paddingHorizontal: scaleSpacing(20) }}>
                  {success}
                </Text>
                <TouchableOpacity style={[styles.backBtn, { marginTop: scaleSpacing(20) }]} onPress={onClose}>
                  <Text style={styles.backBtnText}>{t('common.done') || 'Done'}</Text>
                </TouchableOpacity>
              </>
            ) : error ? (
              <>
                <Feather name="alert-circle" size={scale(48)} color="#FF4444" />
                <Text style={{ color: '#FF4444', fontSize: scale(14), marginTop: scaleSpacing(12), textAlign: 'center', paddingHorizontal: scaleSpacing(20) }}>
                  {error}
                </Text>
                <TouchableOpacity style={[styles.backBtn, { marginTop: scaleSpacing(16) }]} onPress={() => { setError(''); setScanned(false); }}>
                  <Text style={styles.backBtnText}>{t('common.tryAgain') || 'Try Again'}</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        ) : null}
        {/* Bottom bar */}
        <View style={{ paddingBottom: scaleSpacing(16) + bottomInset, paddingHorizontal: scaleSpacing(20), backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center' }}>
          <TouchableOpacity
            style={{ paddingVertical: scaleSpacing(14), paddingHorizontal: scaleSpacing(50), backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: scaleSpacing(12), borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}
            onPress={() => { setMode(null); setError(''); setSuccess(''); setScanned(false); }}>
            <Text style={{ color: '#fff', fontSize: scale(16), fontWeight: '600' }}>{t('common.back') || 'Back'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Header bar */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerIconWrap}>
            <Feather name="link" size={scale(15)} color="#A78BFA" />
          </View>
          <Text style={styles.headerTitle}>{t('pairing.headerTitle') || 'Pair Phone / Tablet'}</Text>
        </View>
        <TouchableOpacity
          onPress={onClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.headerCloseBtn}
          activeOpacity={0.7}
        >
          <Feather name="x" size={scale(18)} color="#F4F4F8" />
        </TouchableOpacity>
        <LinearGradient
          colors={['transparent', 'rgba(167,139,250,0.4)', 'transparent']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={styles.headerHairline}
        />
      </View>

      {mode === null && renderChooseMode()}
      {mode === 'show' && renderShowQR()}
      {mode === 'scan' && renderScanQR()}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#030308',
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 52 : (StatusBar.currentHeight || 24) + 8,
    paddingBottom: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(20),
    backgroundColor: '#030308',
  },
  headerLeft: {
    flexDirection: 'row', alignItems: 'center', gap: scaleSpacing(10),
  },
  headerIconWrap: {
    width: scale(30), height: scale(30), borderRadius: scale(15),
    backgroundColor: 'rgba(167,139,250,0.14)',
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    color: '#F4F4F8', fontSize: scale(17), fontWeight: '800', letterSpacing: -0.2,
  },
  headerCloseBtn: {
    width: scale(34), height: scale(34), borderRadius: scale(17),
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerHairline: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: StyleSheet.hairlineWidth,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: scaleSpacing(20),
    paddingTop: scaleSpacing(16),
  },
  heroCard: {
    width: '100%',
    borderRadius: scale(20),
    paddingVertical: scaleSpacing(22),
    paddingHorizontal: scaleSpacing(20),
    alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.22)',
    marginBottom: scaleSpacing(20),
  },
  heroIconWrap: {
    width: scale(52), height: scale(52), borderRadius: scale(26),
    backgroundColor: 'rgba(167,139,250,0.18)',
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.32)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: scaleSpacing(12),
  },
  heroTitle: {
    color: '#F4F4F8', fontSize: scale(17), fontWeight: '800',
    textAlign: 'center', marginBottom: scaleSpacing(6), letterSpacing: -0.3,
  },
  heroSubtitle: {
    color: '#A9A9C7', fontSize: scale(12.5), textAlign: 'center',
    lineHeight: scale(18),
  },
  sectionLabel: {
    color: '#7676A0', fontSize: scale(11), fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginBottom: scaleSpacing(10),
    paddingLeft: scaleSpacing(2),
  },
  title: {
    color: '#F4F4F8', fontSize: scale(20), fontWeight: '800',
    textAlign: 'center', marginBottom: scaleSpacing(8),
  },
  subtitle: {
    color: '#A9A9C7', fontSize: scale(13), textAlign: 'center',
    lineHeight: scale(19), marginBottom: scaleSpacing(20),
    paddingHorizontal: scaleSpacing(8),
  },
  optionBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderRadius: scale(16),
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(14),
    marginBottom: scaleSpacing(10),
    width: '100%',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  optionIcon: {
    width: scale(40), height: scale(40), borderRadius: scale(20),
    backgroundColor: 'rgba(108,92,231,0.14)',
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.28)',
    alignItems: 'center', justifyContent: 'center',
    marginRight: scaleSpacing(12),
  },
  optionTitle: {
    color: '#F4F4F8', fontSize: scale(14.5), fontWeight: '700',
    marginBottom: scaleSpacing(2), letterSpacing: -0.2,
  },
  optionSub: {
    color: '#7676A0', fontSize: scale(11.5), lineHeight: scale(15),
  },
  qrFrame: {
    borderRadius: scale(22),
    padding: scaleSpacing(14),
    alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.28)',
    marginBottom: scaleSpacing(18),
  },
  qrContainer: {
    backgroundColor: '#FFFFFF', padding: scaleSpacing(16),
    borderRadius: scale(14),
  },
  qrAwaitingPill: {
    flexDirection: 'row', alignItems: 'center', gap: scaleSpacing(6),
    marginTop: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(10), paddingVertical: scaleSpacing(4),
    borderRadius: 999,
    backgroundColor: 'rgba(0,255,163,0.12)',
    borderWidth: 1, borderColor: 'rgba(0,255,163,0.28)',
  },
  qrAwaitingDot: {
    width: scale(6), height: scale(6), borderRadius: scale(3),
    backgroundColor: '#00FFA3',
  },
  qrAwaitingText: {
    color: '#00FFA3', fontSize: scale(11), fontWeight: '700', letterSpacing: 0.3,
  },
  deviceIdCard: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderRadius: scale(14),
    paddingVertical: scaleSpacing(12), paddingHorizontal: scaleSpacing(14),
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: scaleSpacing(16),
    alignItems: 'center',
  },
  deviceIdLabel: {
    color: '#7676A0', fontSize: scale(10.5), fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginBottom: scaleSpacing(4),
  },
  deviceIdValue: {
    color: '#A78BFA', fontSize: scale(12),
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    maxWidth: '95%',
  },
  backBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(167,139,250,0.10)', borderRadius: scale(14),
    paddingVertical: scaleSpacing(13), paddingHorizontal: scaleSpacing(36),
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.28)',
    marginTop: scaleSpacing(4),
    minWidth: scale(140),
  },
  backBtnText: {
    color: '#F4F4F8', fontSize: scale(14), fontWeight: '700', letterSpacing: -0.2,
  },
  successText: {
    color: '#00FFA3', fontSize: scale(13.5), fontWeight: '600',
    textAlign: 'center', marginBottom: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(12),
  },
  linkedSection: {
    width: '100%', marginTop: scaleSpacing(20),
  },
  linkedSectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: scaleSpacing(8),
    marginBottom: scaleSpacing(10),
    paddingLeft: scaleSpacing(2),
  },
  linkedTitle: {
    color: '#7676A0', fontSize: scale(11), fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  linkedCountPill: {
    minWidth: scale(20), paddingHorizontal: scaleSpacing(6), height: scale(18),
    borderRadius: scale(9),
    backgroundColor: 'rgba(167,139,250,0.16)',
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  linkedCountPillText: {
    color: '#A78BFA', fontSize: scale(10), fontWeight: '800',
  },
  linkedCard: {
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderRadius: scale(14),
    paddingVertical: scaleSpacing(12), paddingHorizontal: scaleSpacing(12),
    marginBottom: scaleSpacing(8),
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  linkedRow: {
    flexDirection: 'row', alignItems: 'center', gap: scaleSpacing(10),
    marginBottom: scaleSpacing(10),
  },
  linkedDeviceIcon: {
    width: scale(28), height: scale(28), borderRadius: scale(14),
    backgroundColor: 'rgba(167,139,250,0.14)',
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  linkedLabel: {
    color: '#F4F4F8', fontSize: scale(13), fontWeight: '700', letterSpacing: -0.2,
    marginBottom: scaleSpacing(1),
  },
  linkedUuid: {
    color: '#7676A0', fontSize: scale(10.5),
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  linkedRemoveBtn: {
    width: scale(28), height: scale(28), borderRadius: scale(14),
    backgroundColor: 'rgba(255,68,102,0.10)',
    borderWidth: 1, borderColor: 'rgba(255,68,102,0.24)',
    alignItems: 'center', justifyContent: 'center',
  },
  switchBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: scaleSpacing(6), paddingVertical: scaleSpacing(9),
    backgroundColor: 'rgba(108,92,231,0.10)',
    borderRadius: scale(10),
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.28)',
  },
  switchBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderColor: 'rgba(255,255,255,0.08)',
  },
  switchBtnText: {
    color: '#A78BFA', fontSize: scale(12), fontWeight: '700', letterSpacing: -0.1,
  },
});

export default DevicePairing;
