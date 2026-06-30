/**
 * SettingsScreen.js
 * 
 * Professional Settings UI - Clean, minimal, premium feel
 */

import React, { useState, useRef, useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
  StyleSheet,
  Platform,
  Dimensions,
  StatusBar,
  useWindowDimensions,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as LocalAuthentication from 'expo-local-authentication';
import { t, SUPPORTED_LANGUAGES, isUsingEnglish, setUseEnglish, getSystemLanguage, getCurrentLanguage } from './i18n';
import * as Clipboard from 'expo-clipboard';
import { getCachedMasterKeyBase64, getCachedLegacyMasterKeyBase64 } from './backgroundTask';
import { createRecoveryKit } from './recoveryKit';
import { getMigrationProgress, maybeContinueMigration, pauseMigration, resumeMigration, setUserPaused, isMigrationActive, checkMigrationNeeded } from './encryptionMigration';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCREEN_HEIGHT_FULL = Dimensions.get('screen').height;
// Android navigation bar height detection - use minimum 48px if detection fails
const ANDROID_NAV_BAR_HEIGHT = Platform.OS === 'android' ? Math.max(48, SCREEN_HEIGHT_FULL - SCREEN_HEIGHT) : 0;
const MIN_DIMENSION = Math.min(SCREEN_WIDTH, SCREEN_HEIGHT);

// Device categories based on viewport widths:
// iPhone SE (1st-3rd): 320px | iPhone 6/7/8/X/XS/11Pro/12mini/13mini: 375px
// iPhone 6+/7+/8+: 414px | iPhone XR/11/12/13/14: 390px | iPhone 12-15 Pro: 390-393px
// iPhone 12-15 Pro Max/Plus: 428-430px | Small Android: 320-360px
// Tablets: 600px+ | Large tablets: 768px+
const isVerySmallPhone = MIN_DIMENSION < 340; // iPhone SE 1st gen, very small Android
const isSmallPhone = MIN_DIMENSION >= 340 && MIN_DIMENSION < 375; // Small Android
const isMediumPhone = MIN_DIMENSION >= 375 && MIN_DIMENSION < 400; // iPhone X/12/13, most phones
const isLargePhone = MIN_DIMENSION >= 400 && MIN_DIMENSION < 600; // iPhone Plus/Max
const isTablet = MIN_DIMENSION >= 600;
const isLargeTablet = MIN_DIMENSION >= 768;

// Height-based scaling for fitting content within screen bounds
// Base height: 844px (iPhone 12/13/14)
const BASE_HEIGHT = 844;
const heightRatio = SCREEN_HEIGHT / BASE_HEIGHT;
const isShortScreen = SCREEN_HEIGHT < 700; // iPhone SE, small Android
const isTallScreen = SCREEN_HEIGHT > 900; // iPhone Pro Max, tall Android

// Responsive scale factor based on screen width (base: 390px - iPhone 12/13)
const BASE_WIDTH = 390;
const scaleFactor = Math.min(Math.max(SCREEN_WIDTH / BASE_WIDTH, 0.75), 1.5);

const scale = (size) => {
  let result = size;
  if (isLargeTablet) result = size * 1.3;
  else if (isTablet) result = size * 1.15;
  else if (isVerySmallPhone) result = size * 0.78;
  else if (isSmallPhone) result = size * 0.85;
  else if (isMediumPhone) result = size * 0.92;
  // Apply height-based compression for short screens
  if (isShortScreen) result *= 0.9;
  return result;
};

const scaleSpacing = (size) => {
  let result = size;
  if (isLargeTablet) result = size * 1.2;
  else if (isTablet) result = size * 1.1;
  else if (isVerySmallPhone) result = size * 0.6;
  else if (isSmallPhone) result = size * 0.7;
  else if (isMediumPhone) result = size * 0.8;
  else result = size * 0.9;
  // Apply height-based compression for short screens
  if (isShortScreen) result *= 0.75;
  return result;
};

// Reusable Card Component
const Card = ({ children, style, glassModeEnabled }) => (
  <View style={[
    styles.card,
    glassModeEnabled && styles.cardGlass,
    style
  ]}>
    {children}
  </View>
);

const SectionTitle = ({ children, color = '#A78BFA', style, onInfoPress }) => (
  <View style={[styles.sectionTitleWrap, style]}>
    <LinearGradient colors={[color, `${color}80`]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.sectionTitleDot} />
    <Text style={[styles.sectionTitle, { color }]}>{children}</Text>
    {onInfoPress && (
      <TouchableOpacity onPress={onInfoPress} activeOpacity={0.7} style={{ marginLeft: scaleSpacing(6) }}>
        <Feather name="info" size={scale(14)} color={color} />
      </TouchableOpacity>
    )}
  </View>
);

// Server Option Button
const ServerOption = ({ icon, label, description, isSelected, onPress, glassModeEnabled, disabled }) => (
  <TouchableOpacity
    style={[
      styles.serverOption,
      isSelected && styles.serverOptionSelected,
      glassModeEnabled && styles.serverOptionGlass,
      disabled && styles.serverOptionDisabled,
    ]}
    onPress={onPress}
    activeOpacity={0.7}
    disabled={disabled}
  >
    <View style={[styles.serverOptionIcon, isSelected && styles.serverOptionIconSelected]}>
      <Feather name={icon} size={scale(20)} color={isSelected ? '#FFFFFF' : '#8888A0'} />
    </View>
    <View style={styles.serverOptionContent}>
      <Text style={[styles.serverOptionLabel, isSelected && styles.serverOptionLabelSelected]}>
        {label}
      </Text>
      {description && (
        <Text style={styles.serverOptionDesc}>{description}</Text>
      )}
    </View>
  </TouchableOpacity>
);

// Toggle Setting Row
const ToggleSetting = ({ icon, title, subtitle, value, onValueChange, glassModeEnabled }) => (
  <View style={[styles.settingRow, glassModeEnabled && styles.settingRowGlass]}>
    <View style={styles.settingIcon}>
      <Feather name={icon} size={scale(20)} color="#8888A0" />
    </View>
    <View style={styles.settingContent}>
      <Text style={styles.settingTitle}>{title}</Text>
      {subtitle && <Text style={styles.settingSubtitle}>{subtitle}</Text>}
    </View>
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: '#3A3A3C', true: '#A78BFA' }}
      thumbColor="#FFFFFF"
      ios_backgroundColor="#3A3A3C"
    />
  </View>
);

// Action Button
const ActionButton = ({ title, subtitle, onPress, danger, disabled, glassModeEnabled }) => (
  <TouchableOpacity
    style={[
      styles.actionButton,
      danger && styles.actionButtonDanger,
      disabled && styles.actionButtonDisabled,
      glassModeEnabled && styles.actionButtonGlass,
    ]}
    onPress={onPress}
    disabled={disabled}
    activeOpacity={0.7}
  >
    <Text style={[styles.actionButtonText, danger && styles.actionButtonTextDanger]}>
      {title}
    </Text>
    {subtitle && <Text style={styles.actionButtonSubtitle}>{subtitle}</Text>}
  </TouchableOpacity>
);

// Main Settings Screen
export const SettingsScreen = ({
  onBack,
  serverType,
  setServerType,
  localHost,
  setLocalHost,
  remoteHost,
  setRemoteHost,
  getServerUrl,
  autoUploadEnabled,
  persistAutoUploadEnabled,
  fastModeEnabled,
  persistFastModeEnabled,
  glassModeEnabled,
  persistGlassModeEnabled,
  loading,
  logout,
  relogin,
  purgeStealthCloudData,
  purgeClassicServerData,
  showDarkAlert,
  onQrScan,
  normalizeHostInput,
  SecureStore,
  currentLanguage,
  onLanguageChange,
}) => {
  const [useEnglish, setUseEnglishState] = useState(isUsingEnglish());
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [legacyKey, setLegacyKey] = useState(null);
  const [keysExpanded, setKeysExpanded] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState(null);
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [recoveryKitExpanded, setRecoveryKitExpanded] = useState(false);
  const [recoveryKitPin, setRecoveryKitPin] = useState('');
  const [recoveryKitConfirmPin, setRecoveryKitConfirmPin] = useState('');
  const [recoveryKitString, setRecoveryKitString] = useState(null);
  const [recoveryKitError, setRecoveryKitError] = useState(null);
  const [recoveryKitLoading, setRecoveryKitLoading] = useState(false);
  const userActionRef = useRef(0); // timestamp of last manual button press
  const insets = useSafeAreaInsets();

  // Load migration progress when screen mounts
  // Proactively check server if state is default (user may have opened
  // Settings before the opportunistic background check ran).
  // Also sync running state — migration may have been started from
  // App.js opportunistic trigger or a previous Settings visit.
  useEffect(() => {
    let mounted = true;
    let interval;

    // IMMEDIATELY sync running state so the button shows correctly
    // before any async loads complete (critical for tab-hopping).
    setMigrationRunning(isMigrationActive());

    (async () => {
      // Load keys for Encryption & Recovery section
      const key = await getCachedMasterKeyBase64();
      const leg = await getCachedLegacyMasterKeyBase64();
      if (mounted) {
        setRecoveryKey(key);
        setLegacyKey(leg && leg !== key ? leg : null);
      }
      // Load migration status
      let p = await getMigrationProgress();
      if (mounted && p && !p.needed && !p.isComplete && p.total === 0) {
        try {
          await checkMigrationNeeded();
          p = await getMigrationProgress();
        } catch (e) {}
      }
      if (mounted) {
        setMigrationStatus(p);
        setMigrationRunning(isMigrationActive()); // Re-check after async
      }
      // Poll every 2s while Settings is open to catch progress from
      // background triggers or tab switches.
      // Skip overriding migrationRunning if user just pressed a button.
      interval = setInterval(async () => {
        if (!mounted) return;
        const active = isMigrationActive();
        const sinceUserAction = Date.now() - userActionRef.current;
        if (sinceUserAction > 3000) {
          setMigrationRunning(active);
        }
        // Always refresh status so we catch completion and state changes
        // even when migration is not actively running in this moment.
        try {
          const fresh = await getMigrationProgress();
          if (mounted) setMigrationStatus(fresh);
        } catch (e) {}
      }, 2000);
    })();
    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
    };
  }, []);
  const bottomInset = Platform.OS === 'android' ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT) : insets.bottom;
  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : insets.top;
  // Detect orientation for tablets - enable scroll in landscape
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isLandscape = windowWidth > windowHeight;
  const minDim = Math.min(windowWidth, windowHeight);
  const isTabletDevice = minDim >= 600; // 7"+ tablets
  const shouldEnableScroll = true; // Always enable scroll to handle content on small screens
  const remoteConnectTimerRef = useRef(null);
  const systemLang = getSystemLanguage();
  const systemLangInfo = SUPPORTED_LANGUAGES.find(l => l.code === systemLang);
  const currentLangInfo = SUPPORTED_LANGUAGES.find(l => l.code === currentLanguage);

  // TODO: Re-enable when translations are complete
  const SHOW_LANGUAGE_TOGGLE = false;

  const handleLanguageToggle = async (value) => {
    setUseEnglishState(value);
    await setUseEnglish(value);
    onLanguageChange(value ? 'en' : systemLang);
  };

  const authenticateBeforeReveal = async () => {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!compatible || !enrolled) {
      showDarkAlert(
        t('alerts.authRequired') || 'Authentication Required',
        t('alerts.biometricNotAvailable') || 'Biometric authentication is not available on this device. Keys cannot be revealed without device-level security confirmation.'
      );
      return false;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: t('auth.confirmIdentity') || 'Confirm your identity to reveal encryption keys',
      cancelLabel: t('common.cancel') || 'Cancel',
      fallbackLabel: t('auth.usePasscode') || 'Use passcode',
    });
    return result.success;
  };

  const handleServerTypeChange = async (type) => {
    // Always persist server_type so it's remembered on app restart
    await SecureStore.setItemAsync('server_type', type);
    setServerType(type);
    
    if (relogin) {
      if (type === 'stealthcloud') {
        await relogin('stealthcloud');
      } else if (type === 'local' && localHost) {
        await relogin('local');
      } else if (type === 'remote' && remoteHost) {
        await relogin('remote');
      }
    }
  };

  const handleSaveSettings = async () => {
    await SecureStore.setItemAsync('server_type', serverType);
    if (serverType === 'remote') {
      await SecureStore.setItemAsync('remote_host', remoteHost);
    } else if (serverType === 'local') {
      await SecureStore.setItemAsync('local_host', localHost);
    }
    // Relogin with new server settings instead of logging out
    if (relogin) {
      await relogin(serverType);
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: topInset + scaleSpacing(10) }]}>
        <Text style={styles.headerTitle}>{t('settings.title') || 'Settings'}</Text>
        <LinearGradient colors={['transparent', 'rgba(255,255,255,0.1)', 'transparent']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth }} />
      </View>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: scaleSpacing(20) + bottomInset }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        alwaysBounceVertical={false}
        scrollEnabled={shouldEnableScroll}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.sectionsContainer}>
        {/* Server Selection */}
        <SectionTitle color="#A78BFA" onInfoPress={() => showDarkAlert(t('settings.server') || 'Server', t('settings.serverInfo') || 'Choose where your encrypted files are stored.\n\nStealthCloud uses our secure server.\nLocal lets you run your own server on your home network.')}>{t('settings.server')}</SectionTitle>
        <Card glassModeEnabled={glassModeEnabled}>
          <View style={{ paddingVertical: scaleSpacing(12) }}>
            <ServerOption
              icon="cloud"
              label={t('settings.stealthcloud')}
              description={t('settings.stealthcloudDesc')}
              isSelected={serverType === 'stealthcloud'}
              onPress={() => handleServerTypeChange('stealthcloud')}
              glassModeEnabled={glassModeEnabled}
              disabled={loading}
            />
            <View style={styles.divider} />
            <ServerOption
              icon="wifi"
              label={t('settings.localServer')}
              description={t('settings.localServerDesc')}
              isSelected={serverType === 'local'}
              onPress={() => handleServerTypeChange('local')}
              glassModeEnabled={glassModeEnabled}
              disabled={loading}
            />
            <View style={styles.divider} />
            <ServerOption
              icon="globe"
              label={t('settings.remoteServer')}
              description={t('settings.remoteServerDesc')}
              isSelected={serverType === 'remote'}
              onPress={() => handleServerTypeChange('remote')}
              glassModeEnabled={glassModeEnabled}
              disabled={loading}
            />
          </View>
        </Card>

        {/* Server Configuration */}
        {serverType === 'local' && (
          <>
            <SectionTitle color="#A78BFA" onInfoPress={() => showDarkAlert(t('settings.localServer') || 'Local Server', t('settings.localServerInfo') || 'Connect to a PhotoLynk server running on your local network.\n\nEnter the IP address and port of the computer running the server.')}>{t('settings.localServer')}</SectionTitle>
            <Card glassModeEnabled={glassModeEnabled}>
              <View style={styles.inputContainer}>
                <Text style={styles.inputLabel}>{t('settings.serverIpAddress')}</Text>
                <View style={styles.inputRow}>
                  <TextInput
                    style={[styles.textInput, { backgroundColor: '#1a1a1a', color: '#888' }]}
                    placeholder="192.168.1.100"
                    placeholderTextColor="#666"
                    value={localHost}
                    editable={false}
                    selectTextOnFocus={false}
                  />
                  <TouchableOpacity style={styles.qrButton} onPress={onQrScan}>
                    <Feather name="maximize" size={scale(18)} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>
              </View>
              {/* Save & Connect button hidden - connection happens via QR scan */}
            </Card>
          </>
        )}

        {serverType === 'remote' && (
          <>
            <SectionTitle color="#A78BFA" onInfoPress={() => showDarkAlert(t('settings.remoteServer') || 'Remote Server', t('settings.remoteServerInfo') || 'Connect to a PhotoLynk server at a custom web address.\n\nUseful if you are self-hosting on a VPS or dedicated server.')}>{t('settings.remoteServer')}</SectionTitle>
            <Card glassModeEnabled={glassModeEnabled}>
              <View style={styles.inputContainer}>
                <Text style={styles.inputLabel}>{t('settings.serverAddress')}</Text>
                <TextInput
                  style={[styles.textInput, { flex: 0 }]}
                  placeholder={t('settings.remoteAddressPlaceholder') || 'example.com or IP address'}
                  placeholderTextColor="#666"
                  value={remoteHost}
                  onChangeText={(text) => {
                    setRemoteHost(text);
                    // Cancel any pending connect attempt while typing
                    if (remoteConnectTimerRef.current) {
                      clearTimeout(remoteConnectTimerRef.current);
                      remoteConnectTimerRef.current = null;
                    }
                  }}
                  onBlur={async () => {
                    // Try to connect when user leaves the input field
                    const normalized = normalizeHostInput(remoteHost);
                    if (!normalized || normalized.length < 4) return;
                    // Validate IP (xxx.xxx.xxx.xxx) or domain (xxx.xxx)
                    const isValidIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
                    const isValidDomain = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}/.test(normalized);
                    if (!isValidIp && !isValidDomain) return;
                    // Save and try to connect
                    await SecureStore.setItemAsync('server_type', 'remote');
                    await SecureStore.setItemAsync('remote_host', normalized);
                    if (relogin) {
                      try {
                        await relogin('remote');
                      } catch (e) {
                        console.log('[Remote] Connection failed:', e.message);
                        showDarkAlert(
                          t('alerts.error') || 'Error',
                          t('settings.remoteServerUnreachable') || 'Remote server is not reachable. Check the address and try again.'
                        );
                      }
                    }
                  }}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>
              {/* Save & Connect button hidden - auto-connects on input */}
            </Card>
          </>
        )}


        {/* Preferences */}
        <SectionTitle color="#A78BFA" onInfoPress={() => showDarkAlert(t('settings.preferences') || 'Preferences', t('settings.preferencesInfo') || 'Customize app behavior.\n\nFast Mode increases upload speed but uses more battery.')}>{t('settings.preferences')}</SectionTitle>
        <Card glassModeEnabled={glassModeEnabled}>
          <View style={{ paddingVertical: scaleSpacing(12) }}>
            {serverType === 'stealthcloud' && (
              <>
                {/* Auto-upload temporarily hidden */}
                {/* <ToggleSetting
                  icon="upload-cloud"
                  title={t('settings.autoUpload')}
                  subtitle={autoUploadEnabled ? t('settings.autoUploadOnDesc') : t('settings.autoUploadOffDesc')}
                  value={autoUploadEnabled}
                  onValueChange={persistAutoUploadEnabled}
                  glassModeEnabled={glassModeEnabled}
                />
                <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: scaleSpacing(8) }} /> */}
                <ToggleSetting
                  icon="zap"
                  title={t('settings.fastMode')}
                  subtitle={fastModeEnabled ? t('settings.fastModeOnDesc') : t('settings.fastModeOffDesc')}
                  value={fastModeEnabled}
                  onValueChange={persistFastModeEnabled}
                  glassModeEnabled={glassModeEnabled}
                />
              </>
            )}
          </View>
        </Card>

        {SHOW_LANGUAGE_TOGGLE && (
          <>
            {/* Language */}
            <SectionTitle color="#A78BFA" onInfoPress={() => showDarkAlert(t('settings.language') || 'Language', t('settings.language') || 'Choose your preferred language for the app interface.')}>{t('settings.language')}</SectionTitle>
            <Card glassModeEnabled={glassModeEnabled}>
              <View style={[styles.settingRow, glassModeEnabled && styles.settingRowGlass]}>
                <View style={styles.settingIcon}>
                  <Text style={{ fontSize: scale(20) }}>🌐</Text>
                </View>
                <View style={styles.settingContent}>
                  <Text style={styles.settingTitle}>{t('settings.useEnglish')}</Text>
                  <Text style={styles.settingSubtitle}>
                    {useEnglish
                      ? t('settings.currentlyEnglish')
                      : `${t('settings.currentlySystem')}: ${systemLangInfo?.nativeName || 'English'}`
                    }
                  </Text>
                </View>
                <Switch
                  value={useEnglish}
                  onValueChange={handleLanguageToggle}
                  trackColor={{ false: '#333', true: '#A78BFA' }}
                  thumbColor={useEnglish ? '#fff' : '#888'}
                />
              </View>
              <View style={styles.languageNote}>
                <Text style={styles.languageNoteText}>
                  {t('settings.englishDefaultNote')}
                </Text>
              </View>
            </Card>
          </>
        )}

        </View>

        {/* Encryption & Recovery */}
        <SectionTitle color="#10B981" onInfoPress={() => showDarkAlert(t('settings.encryptionRecovery') || 'Encryption & Recovery', t('settings.encryptionRecoveryInfo') || 'Your photos are encrypted with a master key before upload.\n\nThe key is derived from your wallet signature — the same wallet on any Solana phone regenerates it automatically thanks to the secure seed vault.\n\nUse the recovery kit below to save an encrypted backup of your credentials. On any Android phone, paste the kit and enter your PIN to restore your account. See the recovery guide for details.')}>{t('settings.encryptionRecovery') || 'Encryption & Recovery'}</SectionTitle>
        <Card glassModeEnabled={glassModeEnabled}>
          <View style={{ paddingVertical: scaleSpacing(12) }}>
            {recoveryKey ? (
              <>
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: '#10B98120', borderColor: '#10B98140', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: scaleSpacing(8) }]}
                  onPress={async () => {
                    if (keysExpanded) {
                      setKeysExpanded(false);
                      return;
                    }
                    const ok = await authenticateBeforeReveal();
                    if (ok) setKeysExpanded(true);
                  }}
                  activeOpacity={0.7}
                >
                  <Feather name={keysExpanded ? 'eye-off' : 'eye'} size={scale(16)} color="#10B981" />
                  <Text style={{ color: '#10B981', fontSize: scale(15), fontWeight: '700' }}>
                    {keysExpanded
                      ? (t('settings.hideKey') || 'Hide key')
                      : (legacyKey && !migrationStatus?.isComplete
                          ? (t('settings.revealRecoveryKey') || 'Reveal Encryption Keys')
                          : (t('settings.revealEncryptionKey') || 'Reveal Encryption Key')
                        )
                    }
                  </Text>
                </TouchableOpacity>
                {keysExpanded && (
                  <>
                    <View style={[styles.keyBox, glassModeEnabled && styles.keyBoxGlass, { marginTop: scaleSpacing(12) }]}>
                      <Text style={styles.keyLabel}>{t('settings.yourSecureKey') || 'Secure Key'}</Text>
                      <Text style={styles.keyValue} selectable>{recoveryKey}</Text>
                      <TouchableOpacity
                        style={styles.copyButton}
                        onPress={async () => {
                          await Clipboard.setStringAsync(recoveryKey);
                          showDarkAlert(t('alerts.success') || 'Copied', t('settings.keyCopied') || 'Recovery key copied to clipboard');
                        }}
                        activeOpacity={0.7}
                      >
                        <Feather name="copy" size={scale(16)} color="#A78BFA" style={{ marginRight: scaleSpacing(6) }} />
                        <Text style={{ color: '#A78BFA', fontSize: scale(14), fontWeight: '600' }}>{t('settings.copy') || 'Copy'}</Text>
                      </TouchableOpacity>
                    </View>
                    {legacyKey && !migrationStatus?.isComplete && (
                      <View style={[styles.keyBox, glassModeEnabled && styles.keyBoxGlass, { marginTop: scaleSpacing(10) }]}>
                        <Text style={styles.keyLabel}>{t('settings.legacyKey') || 'Previous Key'}</Text>
                        <Text style={styles.keyValue} selectable>{legacyKey}</Text>
                        <TouchableOpacity
                          style={styles.copyButton}
                          onPress={async () => {
                            await Clipboard.setStringAsync(legacyKey);
                            showDarkAlert(t('alerts.success') || 'Copied', t('settings.legacyKeyCopied') || 'Previous key copied to clipboard');
                          }}
                          activeOpacity={0.7}
                        >
                          <Feather name="copy" size={scale(16)} color="#A78BFA" style={{ marginRight: scaleSpacing(6) }} />
                          <Text style={{ color: '#A78BFA', fontSize: scale(14), fontWeight: '600' }}>{t('settings.copy') || 'Copy'}</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                )}
              </>
            ) : (
              <Text style={{ color: '#888', fontSize: scale(13), textAlign: 'center' }}>
                {t('settings.encryptionKeyUnavailable') || 'Encryption key not available. Please log out and log in again.'}
              </Text>
            )}

            {/* Recovery Kit */}
            {recoveryKey && (
              <>
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: scaleSpacing(14) }} />
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: '#10B98120', borderColor: '#10B98140', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: scaleSpacing(8) }]}
                  onPress={async () => {
                    if (recoveryKitExpanded) {
                      setRecoveryKitExpanded(false);
                      setRecoveryKitString(null);
                      setRecoveryKitError(null);
                      return;
                    }
                    const ok = await authenticateBeforeReveal();
                    if (ok) setRecoveryKitExpanded(true);
                  }}
                  activeOpacity={0.7}
                >
                  <Feather name={recoveryKitExpanded ? 'x' : 'package'} size={scale(16)} color="#10B981" />
                  <Text style={{ color: '#10B981', fontSize: scale(15), fontWeight: '700' }}>
                    {recoveryKitExpanded ? 'Close' : 'Create Recovery Kit'}
                  </Text>
                </TouchableOpacity>
                {recoveryKitExpanded && (
                  <>
                    <Text style={{ color: '#888', fontSize: scale(12), marginTop: scaleSpacing(10), textAlign: 'center' }}>
                      Save this kit on a new phone + enter your PIN to recover your account without remembering your password.
                    </Text>
                    {recoveryKitString ? (
                      <>
                        <View style={[styles.keyBox, glassModeEnabled && styles.keyBoxGlass, { marginTop: scaleSpacing(12) }]}>
                          <Text style={styles.keyLabel}>Your Recovery Kit</Text>
                          <Text style={styles.keyValue} selectable>{recoveryKitString}</Text>
                          <TouchableOpacity
                            style={styles.copyButton}
                            onPress={async () => {
                              await Clipboard.setStringAsync(recoveryKitString);
                              showDarkAlert('Copied', 'Recovery kit copied to clipboard');
                            }}
                            activeOpacity={0.7}
                          >
                            <Feather name="copy" size={scale(16)} color="#A78BFA" style={{ marginRight: scaleSpacing(6) }} />
                            <Text style={{ color: '#A78BFA', fontSize: scale(14), fontWeight: '600' }}>Copy</Text>
                          </TouchableOpacity>
                        </View>
                        <Text style={{ color: '#10B981', fontSize: scale(12), marginTop: scaleSpacing(8), textAlign: 'center' }}>
                          Save this kit somewhere safe. If you change your password, create a new kit.
                        </Text>
                        <TouchableOpacity
                          style={[styles.actionButton, { backgroundColor: '#EF444420', borderColor: '#EF444440', marginTop: scaleSpacing(10) }]}
                          onPress={() => {
                            setRecoveryKitString(null);
                            setRecoveryKitPin('');
                            setRecoveryKitConfirmPin('');
                            setRecoveryKitError(null);
                          }}
                        >
                          <Text style={{ color: '#EF4444', fontSize: scale(14), fontWeight: '700' }}>Create another kit</Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <View style={styles.formCard}>
                        <Text style={styles.inputLabel}>Create PIN</Text>
                        <View style={styles.inputRow}>
                          <Feather name="lock" size={scale(16)} color="#8888A0" style={styles.inputIcon} />
                          <TextInput
                            style={styles.inputFlex}
                            placeholder="Min 4 characters"
                            placeholderTextColor="#666"
                            value={recoveryKitPin}
                            onChangeText={setRecoveryKitPin}
                            secureTextEntry
                            maxLength={32}
                            autoCapitalize="none"
                            autoCorrect={false}
                          />
                        </View>

                        <Text style={styles.inputLabel}>Confirm PIN</Text>
                        <View style={styles.inputRow}>
                          <Feather name="check-circle" size={scale(16)} color="#8888A0" style={styles.inputIcon} />
                          <TextInput
                            style={styles.inputFlex}
                            placeholder="Re-enter PIN"
                            placeholderTextColor="#666"
                            value={recoveryKitConfirmPin}
                            onChangeText={setRecoveryKitConfirmPin}
                            secureTextEntry
                            maxLength={32}
                            autoCapitalize="none"
                            autoCorrect={false}
                          />
                        </View>

                        {recoveryKitError && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: scaleSpacing(12), gap: scaleSpacing(6) }}>
                            <Feather name="alert-circle" size={scale(14)} color="#EF4444" />
                            <Text style={{ color: '#EF4444', fontSize: scale(12), fontWeight: '600' }}>
                              {recoveryKitError}
                            </Text>
                          </View>
                        )}

                        <TouchableOpacity
                          style={[styles.generateButton, recoveryKitLoading && styles.generateButtonDisabled]}
                          onPress={async () => {
                            setRecoveryKitError(null);
                            if (recoveryKitPin.length < 4) {
                              setRecoveryKitError('PIN must be at least 4 characters');
                              return;
                            }
                            if (recoveryKitPin !== recoveryKitConfirmPin) {
                              setRecoveryKitError('PINs do not match');
                              return;
                            }
                            setRecoveryKitLoading(true);
                            try {
                              const kit = await createRecoveryKit(recoveryKitPin);
                              setRecoveryKitString(kit);
                              setRecoveryKitPin('');
                              setRecoveryKitConfirmPin('');
                            } catch (e) {
                              setRecoveryKitError(e?.message || 'Failed to create kit');
                            } finally {
                              setRecoveryKitLoading(false);
                            }
                          }}
                          disabled={recoveryKitLoading}
                          activeOpacity={0.7}
                        >
                          {recoveryKitLoading ? (
                            <>
                              <ActivityIndicator size="small" color="#050507" />
                              <Text style={styles.generateButtonText}> Generating...</Text>
                            </>
                          ) : (
                            <>
                              <Feather name="shield" size={scale(16)} color="#050507" />
                              <Text style={styles.generateButtonText}>Generate Kit</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                )}
              </>
            )}
          </View>
        </Card>

        {/* Encryption Migration — Active */}
        {migrationStatus && migrationStatus.needed && !migrationStatus.isComplete && (
          <Card glassModeEnabled={glassModeEnabled}>
            <View style={{ paddingVertical: scaleSpacing(12) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: scaleSpacing(8) }}>
                <Feather name="shield" size={scale(18)} color="#10B981" style={{ marginRight: scaleSpacing(8) }} />
                <Text style={{ color: '#10B981', fontSize: scale(15), fontWeight: '700' }}>
                  {t('settings.encryptionUpgrade') || 'Enhancing Encryption'}
                </Text>
                <TouchableOpacity
                  onPress={() => showDarkAlert(t('settings.encryptionUpgrade') || 'Enhancing Encryption', t('settings.encryptionUpgradeInfo') || 'This upgrades your file manifest encryption to a stronger wallet-signature-derived key.\n\nIt only re-encrypts the small manifest wrapper on the server — no photos are re-uploaded.\n\nThe app must stay open to process. It pauses if you switch apps and resumes when you return.\n\nIt does not interfere with backups or sync.')}
                  activeOpacity={0.7}
                  style={{ marginLeft: scaleSpacing(6) }}
                >
                  <Feather name="info" size={scale(14)} color="#10B981" />
                </TouchableOpacity>
              </View>
              <View style={{ marginBottom: scaleSpacing(12), marginTop: scaleSpacing(8) }}>
                <View style={{ height: scaleSpacing(6), backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: scaleSpacing(3), overflow: 'hidden' }}>
                  <View
                    style={{
                      height: '100%',
                      width: `${migrationStatus.total > 0 ? (migrationStatus.completedManifests?.length || 0) / migrationStatus.total * 100 : 0}%`,
                      backgroundColor: '#10B981',
                      borderRadius: scaleSpacing(3),
                    }}
                  />
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: scaleSpacing(4) }}>
                  <Text style={{ color: '#888', fontSize: scale(12) }}>
                    {migrationStatus.completedManifests?.length || 0} / {migrationStatus.total} {t('settings.files') || 'files'}
                    {migrationStatus.failedManifests?.length > 0 ? ` (${migrationStatus.failedManifests.length} ${t('settings.retryLater') || 'retry later'})` : ''}
                  </Text>
                  {migrationRunning && (
                    <ActivityIndicator size="small" color="#10B981" style={{ marginLeft: scaleSpacing(8) }} />
                  )}
                </View>
              </View>
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: migrationRunning ? 'rgba(255,255,255,0.06)' : '#10B98120', borderColor: migrationRunning ? 'rgba(255,255,255,0.10)' : '#10B98140', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: scaleSpacing(8) }]}
                onPress={() => {
                  userActionRef.current = Date.now();
                  if (migrationRunning) {
                    // Pause
                    pauseMigration();
                    setMigrationRunning(false);
                    (async () => {
                      await setUserPaused(true);
                      setMigrationStatus(await getMigrationProgress());
                    })();
                  } else {
                    // Continue
                    setMigrationRunning(true);
                    (async () => {
                      await resumeMigration();
                      setMigrationStatus(await getMigrationProgress());
                      let lastUpdate = 0;
                      await maybeContinueMigration({
                        onProgress: (p) => {
                          const now = Date.now();
                          if (now - lastUpdate < 2000) return;
                          lastUpdate = now;
                          setMigrationStatus(prev => prev ? {
                            ...prev,
                            completedManifests: new Array(p.completed).fill(null),
                            total: p.total,
                          } : prev);
                        },
                        onComplete: async () => {
                          setMigrationRunning(false);
                          setMigrationStatus(await getMigrationProgress());
                        },
                      });
                    })();
                  }
                }}
                activeOpacity={0.7}
              >
                {migrationRunning ? (
                  <ActivityIndicator size="small" color="#888" style={{ marginRight: scaleSpacing(6) }} />
                ) : (
                  <Feather name="play" size={scale(16)} color="#10B981" style={{ marginRight: scaleSpacing(6) }} />
                )}
                <Text style={{ color: migrationRunning ? '#888' : '#10B981', fontSize: scale(15), fontWeight: '700' }}>
                  {migrationRunning ? (t('settings.pauseMigration') || 'Pause') : (t('settings.continueMigration') || 'Continue')}
                </Text>
              </TouchableOpacity>
            </View>
          </Card>
        )}


        {/* Danger Zone - pushed to bottom */}
        <View style={styles.dangerSection}>
          <SectionTitle color="#EF4444" style={{ marginTop: 0 }} onInfoPress={() => showDarkAlert(t('settings.dangerZone') || 'Danger Zone', t('settings.dangerZoneInfo') || 'These actions permanently delete data. Use with caution.\n\nDeleting server data removes all your encrypted backups.\nThis cannot be undone.')}>{t('settings.dangerZone')}</SectionTitle>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.25)', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: scaleSpacing(8) }]}
            onPress={serverType === 'stealthcloud' ? purgeStealthCloudData : purgeClassicServerData}
            disabled={loading}
            activeOpacity={0.7}
          >
            <Feather name="trash-2" size={scale(16)} color="#EF4444" />
            <Text style={{ color: '#EF4444', fontSize: scale(15), fontWeight: '700' }}>
              {t('settings.deleteAllServerData')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
};

// Styles
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#030308',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: scaleSpacing(20),
    paddingBottom: scaleSpacing(6),
    backgroundColor: '#030308',
    position: 'relative',
  },
  headerTitle: {
    fontSize: scale(26),
    fontWeight: '900',
    color: '#EEEEF6',
    letterSpacing: -1,
  },
  backButton: {
    paddingHorizontal: scaleSpacing(14),
    paddingVertical: scaleSpacing(8),
    borderRadius: scaleSpacing(10),
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  backButtonText: {
    fontSize: scale(15),
    color: '#A78BFA',
    fontWeight: '700',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: scaleSpacing(16),
    paddingTop: scaleSpacing(6),
    paddingBottom: scaleSpacing(20),
    justifyContent: 'space-between',
  },
  sectionsContainer: {
    flex: 1,
  },
  dangerSection: {
    marginTop: scaleSpacing(10),
  },
  sectionTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(8),
    marginTop: scaleSpacing(12),
    marginBottom: scaleSpacing(6),
    marginLeft: scaleSpacing(2),
  },
  sectionTitleDot: {
    width: scale(3),
    height: scale(16),
    borderRadius: scale(2),
  },
  sectionTitle: {
    fontSize: scale(13),
    fontWeight: '800',
    color: '#A78BFA',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderRadius: scale(16),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.075)',
    overflow: 'hidden',
  },
  cardGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  dangerCard: {
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.2)',
    borderLeftWidth: 3,
    borderLeftColor: '#EF4444',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginLeft: scaleSpacing(56),
  },
  // Server Options
  serverOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(14),
  },
  serverOptionSelected: {
    backgroundColor: 'rgba(108,92,231,0.10)',
    borderWidth: 1.5,
    borderColor: 'rgba(108,92,231,0.4)',
    borderLeftWidth: 3,
    borderLeftColor: '#6C5CE7',
    borderRadius: scale(12),
    marginHorizontal: scaleSpacing(4),
    marginVertical: scaleSpacing(2),
  },
  serverOptionGlass: {},
  serverOptionDisabled: {
    opacity: 0.5,
  },
  serverOptionIcon: {
    width: scaleSpacing(38),
    height: scaleSpacing(38),
    borderRadius: scaleSpacing(10),
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: scaleSpacing(12),
  },
  serverOptionIconSelected: {
    backgroundColor: 'rgba(108,92,231,0.12)',
  },
  serverOptionContent: {
    flex: 1,
  },
  serverOptionLabel: {
    fontSize: scale(15),
    fontWeight: '700',
    color: '#F4F4F8',
    letterSpacing: -0.2,
  },
  serverOptionLabelSelected: {
    color: '#A78BFA',
  },
  serverOptionDesc: {
    fontSize: scale(12),
    color: '#5C5C72',
    marginTop: scaleSpacing(3),
  },
  checkmark: {
    width: scaleSpacing(24),
    height: scaleSpacing(24),
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Settings Row
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(14),
  },
  settingRowGlass: {},
  settingIcon: {
    width: scaleSpacing(38),
    height: scaleSpacing(38),
    borderRadius: scaleSpacing(10),
    backgroundColor: 'rgba(255,255,255,0.03)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: scaleSpacing(12),
  },
  settingContent: {
    flex: 1,
  },
  settingTitle: {
    fontSize: scale(15),
    fontWeight: '700',
    color: '#F4F4F8',
    letterSpacing: -0.2,
  },
  settingSubtitle: {
    fontSize: scale(12),
    color: '#5C5C72',
    marginTop: 3,
  },
  // Input
  inputContainer: {
    paddingHorizontal: scaleSpacing(16),
    paddingTop: scaleSpacing(16),
    paddingBottom: scaleSpacing(12),
  },
  inputLabel: {
    fontSize: scale(13),
    fontWeight: '500',
    color: '#8888A0',
    marginBottom: scaleSpacing(8),
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(8),
  },
  textInput: {
    flex: 1,
    height: scaleSpacing(48),
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(16),
    fontSize: scale(15),
    color: '#F4F4F8',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  qrButton: {
    width: scaleSpacing(48),
    height: scaleSpacing(48),
    backgroundColor: 'rgba(108,92,231,0.1)',
    borderRadius: scaleSpacing(12),
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.2)',
  },
  // Action Button
  actionButton: {
    paddingVertical: scaleSpacing(14),
    backgroundColor: '#A78BFA',
    borderRadius: scale(16),
    alignItems: 'center',
  },
  actionButtonGlass: {},
  actionButtonDanger: {
    backgroundColor: 'rgba(255,68,102,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,68,102,0.2)',
    borderLeftWidth: 3,
    borderLeftColor: '#EF4444',
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionButtonText: {
    fontSize: scale(15),
    fontWeight: '800',
    color: '#050507',
    letterSpacing: -0.2,
  },
  actionButtonTextDanger: {
    color: '#FF4466',
  },
  actionButtonSubtitle: {
    fontSize: scale(11),
    color: '#8888A0',
    marginTop: 3,
  },
  // Connection Info
  connectionInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: scaleSpacing(12),
    gap: scaleSpacing(6),
  },
  connectionText: {
    fontSize: scale(13),
    color: '#5C5C72',
  },
  // Language Note
  languageNote: {
    paddingHorizontal: scaleSpacing(14),
    paddingBottom: scaleSpacing(8),
    paddingTop: scaleSpacing(2),
  },
  languageNoteText: {
    fontSize: scale(11),
    color: '#5C5C72',
    fontStyle: 'italic',
  },
  // Auto Upload Note
  autoUploadNote: {
    paddingHorizontal: scaleSpacing(14),
    paddingBottom: scaleSpacing(6),
    paddingTop: scaleSpacing(1),
  },
  autoUploadNoteText: {
    fontSize: scale(10),
    color: '#8888A0',
    lineHeight: scale(14),
  },
  // Encryption Key
  keyBox: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: scaleSpacing(12),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: scaleSpacing(14),
    alignItems: 'center',
  },
  keyBoxGlass: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderColor: 'rgba(255,255,255,0.05)',
  },
  keyLabel: {
    fontSize: scale(12),
    color: '#8888A0',
    fontWeight: '600',
    marginBottom: scaleSpacing(8),
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  keyValue: {
    fontSize: scale(14),
    color: '#10B981',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: scale(22),
    letterSpacing: 0.5,
    marginBottom: scaleSpacing(12),
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(167,139,250,0.08)',
    borderRadius: scaleSpacing(8),
    paddingVertical: scaleSpacing(8),
    paddingHorizontal: scaleSpacing(16),
  },
  // Recovery Kit Form
  input: {
    flex: 1,
    height: scaleSpacing(48),
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(16),
    fontSize: scale(15),
    color: '#F4F4F8',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  inputLabel: {
    fontSize: scale(12),
    color: '#8888A0',
    fontWeight: '600',
    marginTop: scaleSpacing(10),
    marginBottom: scaleSpacing(6),
    marginLeft: scaleSpacing(4),
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: scaleSpacing(48),
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: scaleSpacing(12),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: scaleSpacing(12),
  },
  inputIcon: {
    marginRight: scaleSpacing(8),
  },
  inputFlex: {
    flex: 1,
    fontSize: scale(15),
    color: '#F4F4F8',
  },
  formCard: {
    backgroundColor: 'rgba(16,185,129,0.04)',
    borderRadius: scaleSpacing(14),
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.12)',
    padding: scaleSpacing(16),
    marginTop: scaleSpacing(12),
  },
  generateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: scaleSpacing(48),
    backgroundColor: '#10B981',
    borderRadius: scaleSpacing(12),
    marginTop: scaleSpacing(16),
    gap: scaleSpacing(8),
  },
  generateButtonDisabled: {
    opacity: 0.5,
  },
  generateButtonText: {
    color: '#050507',
    fontSize: scale(15),
    fontWeight: '800',
    letterSpacing: -0.2,
  },
});
