// PhotoLynk Mobile App - App.js

import 'react-native-get-random-values';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Appearance,
  FlatList,
  Image,
  Dimensions,
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
} from 'react-native';
import * as ReactNative from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Ionicons from '@expo/vector-icons/Ionicons';
import FontAwesome5 from '@expo/vector-icons/FontAwesome5';
import { styles, THEME, scale, scaleSpacing, isTablet } from './styles';
import {
  sleep,
  withRetries,
  shouldRetryChunkUpload,
  normalizeFilePath,
  makeChunkNonce,
  sanitizeHeaders,
  stripContentType,
  normalizeHostInput,
  computeServerUrl,
  formatBytes,
  normalizeFilenameForCompare,
  formatFilenameForStatus,
  normalizeEmailForDeviceUuid,
  isValidUrl,
  computeFileIdentity,
  getMimeFromFilename,
  sanitizeStoreKey,
  emailToSeekerId,
} from './utils';
import { computeAndroidHardwareId, computeIosHardwareId } from './deviceId';
import { makeHistoryKey, loadRestoreHistory, saveRestoreHistory, clearRestoreHistory } from './restoreHistory';
import {
  startBackgroundService,
  stopBackgroundService,
  updateBackgroundNotification,
} from './serviceController';
import { GradientSpinner, GlassCard } from './uiComponents';
import { buildLocalFilenameSetPaged, buildLocalAssetIdSetPaged, fetchAllServerFilesPaged, fetchAllManifestsPaged } from './mediaHelpers';
import {
  AUTO_UPLOAD_POLL_INTERVAL_SECONDS,
  AUTO_UPLOAD_MIN_CHECK_INTERVAL_SECONDS,
  AUTO_UPLOAD_MIN_CHUNK_SIZE,
  AUTO_UPLOAD_MAX_CHUNK_SIZE,
  AUTO_UPLOAD_KEEP_AWAKE_TAG,
  AUTO_UPLOAD_BACKGROUND_TASK,
  AUTO_UPLOAD_CURSOR_KEY_PREFIX,
  AUTO_UPLOAD_POLICY_POLL_MS,
  SAVED_PASSWORD_KEY,
  SAVED_PASSWORD_EMAIL_KEY,
  ensureAutoUploadPolicyAllowsWorkIfBackgroundedGlobal,
  activateKeepAwakeForAutoUpload,
  deactivateKeepAwakeForAutoUpload,
  buildAutoUploadCursorKey,
  getAutoUploadCursorKey,
  checkPhotoAccessForAutoUpload,
  getMediaLibraryAccessPrivileges,
  findFirstAlbumByTitle,
  ensureAndroidNotificationPermission,
  startAndroidForegroundUploadService,
  stopAndroidForegroundUploadService,
  evaluateAutoUploadPolicyState,
  logAutoUploadRunnerCondition,
  autoUploadEligibilityForBackground,
  autoUploadGetDeviceUuidFromEmail,
  autoUploadGetAuthHeadersFromSecureStore
} from './autoUpload';
import * as SecureStore from 'expo-secure-store';
import { runExifBackfill, cancelExifBackfill, signalBusy as exifBackfillBusy, signalIdle as exifBackfillIdle } from './exifBackfill';
import {
  MB,
  resolveReadableFilePath,
  getStealthCloudMasterKey,
  getDecryptionMasterKeys,
  cacheStealthCloudMasterKey,
  clearStealthCloudMasterKeyCache,
  uploadEncryptedChunk,
  chooseStealthCloudChunkBytes,
  chooseStealthCloudMaxParallelChunkUploads,
  createConcurrencyLimiter,
  trackInFlightPromise,
  drainInFlightPromises,
  autoUploadStealthCloudUploadOneAsset
} from './backgroundTask';
import * as MediaLibrary from 'expo-media-library';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as KeepAwake from 'expo-keep-awake';
import * as Network from 'expo-network';
import * as Battery from 'expo-battery';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ScreenOrientation from 'expo-screen-orientation';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { Feather } from '@expo/vector-icons';
import axios from 'axios';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { sha256 } from 'js-sha256';
import {
  initializeSolana,
  getAvailablePlans,
  purchaseWithSol,
  purchaseWithWallet,
  purchaseWithSkr,
  purchasePremiumWithWallet,
  purchasePremiumWithWalletSkr,
  retryPendingPremiumVerification,
  retryPendingSubscriptionVerification,
  getPremiumPriceInSol,
  getPlanPriceWithSkr,
  getAvailablePaymentWallets,
  getWalletConnectionStatus,
  disconnectCurrentWallet,
  getSubscriptionStatus,
  checkUploadAccess,
  GRACE_PERIOD_DAYS,
  PREMIUM_PRICE_USD,
  SKR_TOKEN_SYMBOL,
} from './solanaPurchases';
import {
  stealthCloudUploadEncryptedChunk,
  PHOTO_ALBUM_NAME,
  LEGACY_PHOTO_ALBUM_NAME,
} from './backupManager';
import {
  stealthCloudRestoreCore,
  localRemoteRestoreCore,
} from './syncOperations';
import { fetchStealthCloudPickerPage, fetchLocalRemotePickerPage, fetchStealthCloudThumbFileUri, fetchThumbnailBase64 } from './syncPickerOperations';
import { SettingsScreen } from './SettingsScreen';
import { InfoScreen } from './InfoScreen';
import { DocsScreen } from './DocsScreen';
import { LoginScreen } from './LoginScreen';
import { HomeScreen } from './HomeScreen';
import {
  validateAuthInputs,
  resolveEffectiveServerSettings,
  persistServerSettings,
  getHardwareDeviceId,
  buildAuthPayload,
  storeCredentialsWithBiometrics,
  handleCredentialsChange,
  checkFirstLaunchAfterReinstall,
  loadServerSettings,
  validateToken,
  getSavedPasswordWithBiometrics,
  attemptBiometricReauth,
  performDevicePasswordReset,
  logoutCore,
  getDeviceUUID,
} from './authHelpers';
import { computeExactFileHash, computePerceptualHash, findPerceptualHashMatch, extractBaseFilename, normalizeDateForCompare, normalizeFullTimestamp, CROSS_PLATFORM_DHASH_THRESHOLD } from './duplicateScanner';
import { stealthCloudBackupCore, stealthCloudBackupSelectedCore } from './backupOperations';
import { localRemoteBackupCore, localRemoteBackupSelectedCore } from './uploadOperations';
import { startSimilarShotsReviewCore, buildDefaultSimilarSelection as buildDefaultSimilarSelectionCore, startExactDuplicatesScanCore } from './cleanDuplicatesOperations';
import { buildResultMessage, checkTierAvailability } from './uiHelpers';
import NFTOperations, { addToTransferredOutBlacklist, checkStealthCloudEligibility, isPhotoLynkEcosystem, countWalletFilteredCertifiedNFTs } from './nftOperations';
import * as WalletAdapter from './WalletAdapter';
import { handleWalletAuth, isWalletAuthMode, setWalletAuthMode, deriveWalletEmail, deriveWalletPassword, reAuthWithWallet, isLegacyMigrated, getMasterKeyCredentials, WALLET_EMAIL_DOMAIN } from './walletAuth';
import { recoverFromKit } from './recoveryKit';
import { maybeContinueMigration, checkMigrationNeeded } from './encryptionMigration';
import NFTPhotoPicker from './NFTPhotoPicker';
import NFTGallery from './NFTGallery';
import NFTTransferModal from './NFTTransferModal';
import CertificatesViewer from './CertificatesViewer';
import DevicePairing from './DevicePairing';
import { initializeLanguage, t, getCurrentLanguage, setLanguage, SUPPORTED_LANGUAGES } from './i18n';
import LanguageSelector, { LanguageButton } from './LanguageSelector';
import {
  loadHashCache,
  flushHashCache,
  clearHashCache,
  runBackgroundPreAnalysis,
  abortPreAnalysis,
  isPreAnalysisRunning,
  getHashCacheStats,
  canRunPreAnalysisNow,
  markPreAnalysisUserActivity,
} from './hashCache';

// Constants moved from inline definitions
const APP_VERSION = '2.2.0';
const APP_DISPLAY_NAME = 'PhotoLynk';
const LEGACY_APP_DISPLAY_NAME = 'PhotoSync';
const SUBSCRIBED_AT_VERSION_KEY = 'subscribed_at_version';
const SUBSCRIPTION_WAS_INACTIVE_KEY = 'subscription_was_inactive';
const CACHED_SUBSCRIPTION_STATUS_KEY = 'cached_subscription_status';
const PHOTOLYNK_QR_SCHEMA = 'photolynk';
const LOCAL_SERVER_QR_SCHEMA = 'photolynk_local';
const REMOTE_SERVER_QR_SCHEMA = 'photolynk_remote';
const GITHUB_RELEASES_LATEST_URL = 'https://github.com/viktorvishyn369/PhotoLynk/releases/latest';
const SETTINGS_SCHEMA_VERSION = '2'; // Bump when pricing/commission logic changes to invalidate caches

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCREEN_HEIGHT_FULL = Dimensions.get('screen').height;
const ANDROID_NAV_BAR_HEIGHT = Platform.OS === 'android' ? Math.max(48, SCREEN_HEIGHT_FULL - SCREEN_HEIGHT) : 0;

const { MediaDelete } = NativeModules;

const CLIENT_BUILD = `photolynk-mobile-v2/${Application.nativeApplicationVersion || '0'}(${Application.nativeBuildVersion || '0'}) sc-debug-2025-12-13`;

const AUTO_UPLOAD_FEATURE_ENABLED = false;

// Module-level cache for PhotoLynkDeleted asset IDs (avoids hook order issues)
let backupPickerDeletedIdsCache = null;

// Helper: Request media library permissions
const requestMediaLibraryPermission = async () => {
  return await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
};

// Alias for backward compatibility with global function name
const ensureAutoUploadPolicyAllowsWorkIfBackgrounded = ensureAutoUploadPolicyAllowsWorkIfBackgroundedGlobal;

// Login loading label helpers
const clearLoginTimers = (timerRef) => {
  if (timerRef?.current && Array.isArray(timerRef.current)) {
    timerRef.current.forEach(id => clearTimeout(id));
  } else if (timerRef?.current) {
    clearTimeout(timerRef.current);
  }
  if (timerRef) timerRef.current = [];
};

const scheduleAuthProgressLabels = (loginLabelTimerRef, setAuthLoadingLabel) => {
  // Removed - status messages now sync with actual operations
};

const resetAuthLoadingLabel = (loginStatusTimerRef, loginLabelTimerRef, setAuthLoadingLabel, label) => {
  if (loginStatusTimerRef?.current) {
    clearTimeout(loginStatusTimerRef.current);
    loginStatusTimerRef.current = null;
  }
  clearLoginTimers(loginLabelTimerRef);
  setAuthLoadingLabel(label);
};

// Thermal protection constants to prevent phone overheating and crashes (used when Fast Mode is OFF)
// Increased values for better stability on weak phones
const THERMAL_BATCH_LIMIT = 5; // Max assets per batch before long cooling pause (was 10)
const THERMAL_BATCH_COOLDOWN_MS = 45000; // 45 second pause between batches for memory cleanup (was 30s)
const THERMAL_ASSET_COOLDOWN_MS = Platform.OS === 'ios' ? 3000 : 2500; // Cooldown between assets (was 2000/1500)
const THERMAL_CHUNK_COOLDOWN_MS = 400; // Delay between chunks (was 300)

// Fast mode constants (used when Fast Mode is ON) - no throttling, maximum speed
const FAST_BATCH_LIMIT = 999999; // Effectively no batch limit
const FAST_BATCH_COOLDOWN_MS = 0; // No pause between batches
const FAST_ASSET_COOLDOWN_MS = 0; // No cooldown between assets
const FAST_CHUNK_COOLDOWN_MS = 0; // No delay between chunks
const AUTO_UPLOAD_ANDROID_FALLBACK_POLL_MS = 60000;
const HOME_BACKGROUND_TASK_DELAY_MS = 120000;
const PRE_ANALYSIS_RESTART_COOLDOWN_MS = 30 * 60 * 1000;
const PRE_ANALYSIS_USER_IDLE_DELAY_MS = 180 * 1000;
const EXIF_BACKFILL_RESTART_COOLDOWN_MS = 60 * 60 * 1000;
const BG_NFT_CERT_SYNC_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
const WALLET_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const normalizeWalletSeekerId = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.endsWith('.skr')) return raw;
  if (raw.includes('@')) return null;
  if (WALLET_BASE58_RE.test(raw)) return null;
  return `${raw}.skr`;
};

function PurchaseConfirmingOverlay({ visible, title, subtitle }) {
  if (!visible) return null;
  return (
    <View
      pointerEvents="auto"
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10100,
        elevation: 10100,
      }}
    >
      <View style={{
        backgroundColor: '#1C1C1E',
        borderRadius: 20,
        paddingVertical: 28,
        paddingHorizontal: 28,
        alignItems: 'center',
        minWidth: 260,
        maxWidth: 340,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
      }}>
        <GradientSpinner size={isTablet ? 90 : 72} />
        <Text style={{ color: '#FFFFFF', fontSize: scale(16), fontWeight: '700', textAlign: 'center', marginTop: scaleSpacing(18) }}>
          {title || 'Confirming purchase…'}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: scale(13), textAlign: 'center', marginTop: scaleSpacing(8), lineHeight: scale(18) }}>
          {subtitle || 'Verifying your payment on Solana. Please don\'t close the app.'}
        </Text>
      </View>
    </View>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const bottomInset = Platform.OS === 'android'
    ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT)
    : insets.bottom;
  const overlayHeaderPaddingTop = Platform.OS === 'ios' ? insets.top + scaleSpacing(8) : (StatusBar.currentHeight || 24);
  const fullscreenHeaderPaddingTop = Platform.OS === 'ios' ? insets.top + 12 : (StatusBar.currentHeight || 24);
  // Immediately handle wallet changes (Seeker hardware wallet / MWA via WalletAdapter)
  useEffect(() => {
    const unsubscribe = WalletAdapter.onWalletChanged(async (nextAddress, prevAddress, label) => {
      if (!nextAddress) return;
      setQsWalletAddress(nextAddress || null);
      // Only update account display from wallet if user is in wallet auth mode
      const isWalletMode = await isWalletAuthMode();
      if (isWalletMode) {
        const normalizedSeekerId = resolveWalletQuickSeekerId(label);
        if (normalizedSeekerId) setQsSeekerId(normalizedSeekerId);
      }
      if (nextAddress === prevAddress) return;
      // Only purge + rescan on actual wallet switch, not initial restore
      // (NFTGallery handles the initial scan via autoScanBlockchain)
      if (!prevAddress) return;
      try {
        await NFTOperations.purgeNFTStorage();
      } catch (_) { }

      try {
        let headers = null;
        try {
          const authConfig = await getStealthCloudAuthHeaders();
          headers = authConfig?.headers || authConfig;
        } catch (_) { }
        NFTOperations.invalidateDasCache();
        await NFTOperations.discoverAndImportNFTs(nextAddress, 'https://stealthlynk.io', headers);
      } catch (_) { }

      // Refresh gallery if open
      try {
        setNftGalleryRefreshKey(k => (k || 0) + 1);
      } catch (_) { }
    });

    // Ensure adapter initializes (restores previous connection and can emit change)
    WalletAdapter.initializeWalletAdapter()
      .then(() => { void syncQuickWalletLabelFromAdapter(); })
      .catch(() => { });

    return () => {
      try { unsubscribe?.(); } catch (_) { }
    };
  }, []);

  const [view, setView] = useState('loading'); // loading, auth, home, settings
  const [homeActiveTab, setHomeActiveTab] = useState('home');
  const [authMode, setAuthMode] = useState('login'); // login, register, forgot
  const [isFirstRun, setIsFirstRun] = useState(false); // First ever app run - show register, hide server options
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showWalletLogin, setShowWalletLogin] = useState(false); // Wallet login overlay visible
  const [showEmailLogin, setShowEmailLogin] = useState(false); // Show email/password form in overlay
  const [walletAuthLoading, setWalletAuthLoading] = useState(false); // Wallet auth in progress
  const [walletAuthStatus, setWalletAuthStatus] = useState(''); // Status message for wallet auth
  const [walletAuthError, setWalletAuthError] = useState(''); // Error message for wallet auth
  const [walletBlockchainConsent, setWalletBlockchainConsent] = useState(false); // Blockchain consent for wallet login
  const [showRecoveryKitLogin, setShowRecoveryKitLogin] = useState(false);
  const [recoveryKitInput, setRecoveryKitInput] = useState('');
  const [recoveryKitPin, setRecoveryKitPin] = useState('');
  const [recoveryKitError, setRecoveryKitError] = useState(null);
  const [recoveryKitLoading, setRecoveryKitLoading] = useState(false);
  const [updatePrompt, setUpdatePrompt] = useState(null); // null | { latestVersionCode: number, updateUrl: string | null, releaseNotes: string | null }
  const [serverType, setServerType] = useState('stealthcloud'); // 'local' | 'remote' | 'stealthcloud'
  const [localHost, setLocalHost] = useState('');
  const [remoteHost, setRemoteHost] = useState('');
  const [autoUploadEnabled, setAutoUploadEnabled] = useState(true);
  const [fastModeEnabled, setFastModeEnabled] = useState(true);
  const [glassModeEnabled, setGlassModeEnabled] = useState(false);
  const [backupModeOpen, setBackupModeOpen] = useState(false);
  const [backupPickerOpen, setBackupPickerOpen] = useState(false);
  const [backupPickerAssets, setBackupPickerAssets] = useState([]);
  const [backupPickerAfter, setBackupPickerAfter] = useState(null);
  const [backupPickerHasNext, setBackupPickerHasNext] = useState(true);
  const [backupPickerLoading, setBackupPickerLoading] = useState(false);
  const [backupPickerTotal, setBackupPickerTotal] = useState(0);
  const [backupPickerSelected, setBackupPickerSelected] = useState({});
  const [backupPickerPreview, setBackupPickerPreview] = useState(null);
  const backupPickerThumbFixingRef = useRef(new Map());
  const backupPickerOpenRef = useRef(false);
  const backupPickerThumbCacheRef = useRef(new Map());
  const backupPickerMetaInFlightRef = useRef(new Set());
  const backupPickerSelectedRef = useRef({});
  const backupPickerMetaLimiterRef = useRef(createConcurrencyLimiter(3));
  const backupPickerScrollingRef = useRef(false);
  const [syncModeOpen, setSyncModeOpen] = useState(false);
  const [syncPickerOpen, setSyncPickerOpen] = useState(false);
  const syncPickerOpenRef = useRef(false);
  const [syncPickerItems, setSyncPickerItems] = useState([]);
  const [syncPickerTotal, setSyncPickerTotal] = useState(0); // Total items on server (after filtering)
  const [syncPickerOffset, setSyncPickerOffset] = useState(0); // How many server items have been processed
  const [syncPickerLoading, setSyncPickerLoading] = useState(false);
  const [syncPickerLoadingMore, setSyncPickerLoadingMore] = useState(false);
  const [syncPickerSelected, setSyncPickerSelected] = useState({});
  const [syncPickerPreview, setSyncPickerPreview] = useState(null); // { uri, filename } for enlarged preview
  const [syncPickerAuthHeaders, setSyncPickerAuthHeaders] = useState(null);
  const syncPickerMasterKeyRef = useRef(null);
  const syncPickerLegacyKeyRef = useRef(null);
  const syncPickerThumbCacheRef = useRef(new Map());
  const syncPickerThumbInFlightRef = useRef(new Set());
  const syncPickerThumbLimiterRef = useRef(createConcurrencyLimiter(3));
  const SYNC_PICKER_PAGE_SIZE = 18; // Items per page (18 for thumbnails)
  const [cleanupModeOpen, setCleanupModeOpen] = useState(false);
  const [quickSetupOpen, setQuickSetupOpen] = useState(false);
  const [authLoadingLabel, setAuthLoadingLabel] = useState(t('auth.signingIn'));
  const loginStatusTimerRef = useRef(null);
  const loginLabelTimerRef = useRef(null);
  const [accountTransitionLabel, setAccountTransitionLabel] = useState('');
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [devicePairingOpen, setDevicePairingOpen] = useState(false);
  const [pairingPassword, setPairingPassword] = useState('');
  const [pairingMkEmail, setPairingMkEmail] = useState(null);
  const [pairingMkPassword, setPairingMkPassword] = useState(null);
  const [similarReviewOpen, setSimilarReviewOpen] = useState(false);
  const [similarGroups, setSimilarGroups] = useState([]);
  const [similarGroupIndex, setSimilarGroupIndex] = useState(0);
  const [similarSelected, setSimilarSelected] = useState({});
  const [similarPhotoIndex, setSimilarPhotoIndex] = useState(0); // Current photo in full-screen view
  const [similarDeletedTotal, setSimilarDeletedTotal] = useState(0); // Track total deleted during similar review
  const similarDeletedTotalRef = useRef(0); // Ref to track cumulative total (state is stale in async handlers)
  const similarThumbCacheRef = useRef(new Map());
  const similarThumbInFlightRef = useRef(new Set());
  const similarThumbLimiterRef = useRef(createConcurrencyLimiter(2));
  const [customAlert, setCustomAlert] = useState(null); // { title, message, buttons }
  const [inlineNotification, setInlineNotification] = useState(null); // { title, message, type: 'success'|'error'|'warning' }
  const [showCompletionTick, setShowCompletionTick] = useState(false);
  const [completionMessage, setCompletionMessage] = useState('');
  const [stealthCapacity, setStealthCapacity] = useState(null);
  const [stealthCapacityLoading, setStealthCapacityLoading] = useState(false);
  const [stealthCapacityError, setStealthCapacityError] = useState(null);
  const [selectedStealthPlanGb, setSelectedStealthPlanGb] = useState(100);
  const [stealthUsage, setStealthUsage] = useState(null);
  const [stealthUsageLoading, setStealthUsageLoading] = useState(false);
  const [stealthUsageError, setStealthUsageError] = useState(null);
  const [availablePlans, setAvailablePlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState(null);
  const [isLegacySubscriber, setIsLegacySubscriber] = useState(false);
  const [paywallTierGb, setPaywallTierGb] = useState(null);
  const [paywallPaymentMethod, setPaywallPaymentMethod] = useState('sol'); // 'sol' or 'skr'
  const [blockchainConsent, setBlockchainConsent] = useState(false); // For SOL/SKR payments
  const [token, setToken] = useState(null);
  const [userId, setUserId] = useState(null);
  const [deviceUuid, setDeviceUuid] = useState(null);
  const [status, setStatus] = useState('Idle');
  const [progress, setProgress] = useState(0);
  const [progressAction, setProgressAction] = useState(null); // 'cleanup' | 'backup' | 'sync' | null
  const [duplicateReview, setDuplicateReview] = useState(null);
  const [duplicateZoomImage, setDuplicateZoomImage] = useState(null); // { uri, filename, created, size } for fullscreen zoom
  const [loading, setLoading] = useState(false);
  const [wasBackgroundedDuringWork, setWasBackgroundedDuringWork] = useState(false);
  const [backgroundWarnEligible, setBackgroundWarnEligible] = useState(false);
  const [quickSetupCollapsed, setQuickSetupCollapsed] = useState(true);
  const [quickSetupHighlightInput, setQuickSetupHighlightInput] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState('en');
  const [languageSelectorOpen, setLanguageSelectorOpen] = useState(false);

  // NFT state
  const [nftPickerOpen, setNftPickerOpen] = useState(false);
  const [nftGalleryOpen, setNftGalleryOpen] = useState(false);
  const [nftCertsOpen, setNftCertsOpen] = useState(false);
  const [nftTransferOpen, setNftTransferOpen] = useState(false);
  const [nftToTransfer, setNftToTransfer] = useState(null);
  const [nftMinting, setNftMinting] = useState(false);
  const [nftGalleryRefreshKey, setNftGalleryRefreshKey] = useState(0);
  const [pendingCertMint, setPendingCertMint] = useState(null); // mint to pre-select in CertificatesViewer
  const [pendingNftMint, setPendingNftMint] = useState(null);  // mint to pre-select in NFTGallery
  const [nftWeeklyDiscountQuote, setNftWeeklyDiscountQuote] = useState(NFTOperations.NFT_WEEKLY_DISCOUNT_FALLBACK);
  const [nftHomeSkrFeeQuote, setNftHomeSkrFeeQuote] = useState(null);

  // Premium state
  const [nftIsPremium, setNftIsPremium] = useState(false);
  const [nftMintCount, setNftMintCount] = useState(0);
  const [nftFreeMintLimit, setNftFreeMintLimit] = useState(100);
  const [nftFreeMintsRemaining, setNftFreeMintsRemaining] = useState(0);
  const [nftMaxNoFeeMints, setNftMaxNoFeeMints] = useState(0);
  const [nftNoFeeMintsRemaining, setNftNoFeeMintsRemaining] = useState(0);
  const [nftPurchaseLoading, setNftPurchaseLoading] = useState(false);
  const [premiumPriceInfo, setPremiumPriceInfo] = useState(null);
  const isFeeWalletExemptHome = qsWalletAddress === NFTOperations.NFT_COMMISSION_WALLET;
  const nftFeesWaived = !!nftIsPremium || !!subscriptionStatus?.isPremium || (subscriptionStatus?.status === 'active' && isLegacySubscriber) || isFeeWalletExemptHome;
  const nftHasPaidStoragePlan = subscriptionStatus?.status === 'active' && !!(subscriptionStatus?.purchasedVia || subscriptionStatus?.paymentType);
  const nftPlanFeeDiscountPercent = !nftFeesWaived && nftHasPaidStoragePlan ? 80 : 0;
  const isPremiumFreeMintHome = !!subscriptionStatus?.isPremium && nftFreeMintsRemaining > 0;
  const isPremiumBeyond100Home = !!subscriptionStatus?.isPremium && nftFreeMintsRemaining <= 0;
  const isMonthlySubscriberHome = nftHasPaidStoragePlan && !subscriptionStatus?.isPremium && !isLegacySubscriber;
  const nftDisplayFeeDiscountPercent = nftFeesWaived ? 80 : nftPlanFeeDiscountPercent || Math.min(80, Math.max(0, Number(nftWeeklyDiscountQuote?.discountPercent || 0)));
  const isLegacySubscriberForFee = subscriptionStatus?.status === 'active' && isLegacySubscriber;
  const nftEffectiveDiscountQuote = nftFeesWaived
    ? isLegacySubscriberForFee
      ? { ...nftWeeklyDiscountQuote, discountPercent: 80, multiplier: 0.2 }
      : { ...nftWeeklyDiscountQuote, discountPercent: 100, multiplier: 0 }
    : nftPlanFeeDiscountPercent > 0
      ? { ...nftWeeklyDiscountQuote, discountPercent: nftPlanFeeDiscountPercent, multiplier: (100 - nftPlanFeeDiscountPercent) / 100 }
      : {
          ...nftWeeklyDiscountQuote,
          discountPercent: Math.min(80, Math.max(0, Number(nftWeeklyDiscountQuote?.discountPercent || 0))),
          multiplier: Math.max(0.1, Math.min(1, Number(nftWeeklyDiscountQuote?.multiplier ?? ((100 - Math.min(80, Math.max(0, Number(nftWeeklyDiscountQuote?.discountPercent || 0)))) / 100)))),
        };

  // Quick-stats state
  const [qsWalletAddress, setQsWalletAddress] = useState(null);
  const [qsSeekerId, setQsSeekerId] = useState(null);
  const [qsNftCount, setQsNftCount] = useState(null);
  const [qsLastBackupTime, setQsLastBackupTime] = useState(null);
  const homeMaintenanceModalBlocked = backupPickerOpen || syncPickerOpen || backupModeOpen || syncModeOpen || cleanupModeOpen || nftPickerOpen || nftGalleryOpen || nftCertsOpen || nftTransferOpen || quickSetupOpen || qrScannerOpen || devicePairingOpen || similarReviewOpen || !!duplicateReview || !!duplicateZoomImage || !!customAlert || languageSelectorOpen;
  const homeMaintenanceBlocked = homeMaintenanceModalBlocked || loading;

  const refreshQuickCertifiedCount = useCallback(async () => {
    try {
      const storedNfts = await NFTOperations.getStoredNFTs();
      const normalizeValue = (value) => {
        if (value === undefined || value === null) return null;
        const normalized = String(value).trim().toLowerCase();
        return normalized || null;
      };
      const normalizeMint = (value) => value ? String(value).replace(/^cnft_/, '') : '';
      const normalizeWallet = (value) => value ? String(value).trim() : '';
      const connectedWallet = (() => {
        try {
          const status = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
          return normalizeWallet(status?.address);
        } catch (_) {
          return '';
        }
      })();
      const activeWallet = connectedWallet || normalizeWallet(qsWalletAddress);
      const isPrivateMatch = (nft) => {
        const mode = normalizeValue(nft?.certificationMode);
        const edition = normalizeValue(nft?.edition);
        if (mode === 'public') return false;
        if (mode === 'private') return true;
        if (edition === 'limited') return true;
        return nft?.encrypted === true;
      };
      const isPublicMatch = (nft) => {
        const mode = normalizeValue(nft?.certificationMode);
        const edition = normalizeValue(nft?.edition);
        if (mode === 'private') return false;
        if (mode === 'public') return true;
        return edition === 'open';
      };
      const shouldDisplayEncrypted = (nft) => {
        if (!nft) return false;
        if (isPublicMatch(nft)) return false;
        return nft?.encrypted === true;
      };
      const isCertified = (nft) => {
        if (!nft) return false;
        const ecosystem = isPhotoLynkEcosystem(nft);
        const isPrivate = (ecosystem || nft?.encrypted === true || nft?.certificationMode || nft?.edition)
          && (isPrivateMatch(nft) || shouldDisplayEncrypted(nft));
        const isPublic = ecosystem && isPublicMatch(nft) && !shouldDisplayEncrypted(nft);
        return isPrivate || isPublic;
      };
      const seen = new Set();
      const uniqueCount = (Array.isArray(storedNfts) ? storedNfts : []).filter((nft) => {
        const ownerWallet = normalizeWallet(nft?.ownerAddress);
        if (activeWallet && ownerWallet && ownerWallet !== activeWallet) return false;
        if (!isCertified(nft)) return false;
        if (nft?.storageType === 'onchain') return false;
        const img = (nft?.imageUrl || nft?.arweaveUrl || '');
        if (img.startsWith('data:') && img.length > 50000) return false;
        const uniqueId = normalizeMint(nft?.mintAddress) || normalizeMint(nft?.assetId) || String(nft?.txSignature || '');
        if (!uniqueId || seen.has(uniqueId)) return false;
        seen.add(uniqueId);
        return true;
      }).length;
      setQsNftCount(uniqueCount);
    } catch (e) {
      console.log('[QuickStats] Failed to load certified NFT count:', e.message);
    }
  }, [qsWalletAddress]);

  // Paired-session state — tracks when user is operating under paired device credentials
  const [isPairedSession, setIsPairedSession] = useState(false);

  const autoUploadEnabledRef = useRef(false);
  const fastModeEnabledRef = useRef(true);
  const backgroundWarnEligibleRef = useRef(false);
  const wasBackgroundedDuringWorkRef = useRef(false);
  const statusRef = useRef('');
  const loadingRef = useRef(false);
  const walletProfileSyncKeyRef = useRef('');
  const syncPickerLocalFilenamesRef = useRef(null);
  const backgroundedAtMsRef = useRef(0);
  const expiredSubscriptionAlertShownRef = useRef(false);
  const stealthCloudUsageRetryRef = useRef(null);
  const appStateRef = useRef(AppState.currentState || 'active');
  const tokenRef = useRef(null);
  const serverTypeRef = useRef('stealthcloud');
  const autoUploadNightRunnerActiveRef = useRef(false);
  const [autoUploadNightRunnerCancelRef] = useState({ current: false });
  const autoUploadNightRunnerSessionIdRef = useRef(0);
  const abortOperationsRef = useRef(false);
  const currentOperationIdRef = useRef(0);
  const autoUploadNightRunnerHeartbeatMsRef = useRef(0);
  const autoUploadNightRunnerStartingRef = useRef(false);
  const autoUploadNightNextTimerRef = useRef(null);
  const autoUploadDebugLastLogMsRef = useRef(0);
  const autoUploadDebugScheduleLastLogMsRef = useRef(0);
  const autoUploadPolicyLogMsRef = useRef(0);
  const autoUploadBackgroundPolicyLogMsRef = useRef(0);
  const autoUploadAssetLogMsRef = useRef(0);
  const autoUploadSummaryLogMsRef = useRef(0);
  const autoUploadRunnerExitLogMsRef = useRef(0);
  const scTokenRef = useRef(null);  // Cached StealthCloud-specific JWT
  const scTokenTsRef = useRef(0);   // Timestamp when SC token was obtained
  const lastPreAnalysisKickMsRef = useRef(0);
  const lastPreAnalysisUserActivityMsRef = useRef(0);
  const lastExifBackfillKickMsRef = useRef(0);
  const lastBgNftCertSyncKickMsRef = useRef(0);
  const preAnalysisKickTimerRef = useRef(null);

  const isWalletDerivedAccountEmail = (value) => String(value || '').trim().toLowerCase().endsWith(`@${WALLET_EMAIL_DOMAIN}`);
  const getQuickAccountDisplay = () => {
    const normalizedSeekerId = normalizeWalletSeekerId(qsSeekerId);
    if (normalizedSeekerId) return normalizedSeekerId;
    if (isWalletDerivedAccountEmail(email)) {
      const wallet = String(qsWalletAddress || '').trim();
      return wallet ? `${wallet.slice(0, 8)}...${wallet.slice(-4)}` : '—';
    }
    // For real email users, show the actual email (not the .skr format)
    return email || '—';
  };
  const resolveWalletQuickSeekerId = (labelValue = null) => {
    const normalizedLabel = normalizeWalletSeekerId(labelValue);
    if (normalizedLabel) return normalizedLabel;
    try {
      const status = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
      return normalizeWalletSeekerId(status?.label);
    } catch (_) {
      return null;
    }
  };
  const syncQuickWalletLabelFromAdapter = async (emailHint = null) => {
    let effectiveEmail = String(emailHint || email || '').trim().toLowerCase();
    if (!effectiveEmail) {
      try {
        effectiveEmail = String(await SecureStore.getItemAsync('user_email') || '').trim().toLowerCase();
      } catch (_) { }
    }
    if (!isWalletDerivedAccountEmail(effectiveEmail)) return;
    try {
      await WalletAdapter.initializeWalletAdapter();
    } catch (_) { }
    try {
      const status = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
      if (status?.address) setQsWalletAddress(status.address);
      const normalizedSeekerId = resolveWalletQuickSeekerId(status?.label);
      if (normalizedSeekerId) setQsSeekerId(normalizedSeekerId);
    } catch (_) { }
  };

  // Cancels any in-flight user-initiated work (backup/sync/cleanup) before starting a new one
  const cancelInFlightOperations = async () => {
    abortOperationsRef.current = true;
    currentOperationIdRef.current += 1; // Invalidate all previous operation callbacks
    // Give in-flight loops a tick to observe the abort flag
    await new Promise(resolve => setTimeout(resolve, 100));
    // Reset abort flag so new operation can proceed
    abortOperationsRef.current = false;
    // Reset UI to a clean state
    setLoadingSafe(false);
    setBackgroundWarnEligibleSafe(false);
    setWasBackgroundedDuringWorkSafe(false);
    setProgress(0);
    setProgressAction(null);
    setStatus('');
  };

  // Wrapped setters that check operation ID to prevent stale callbacks from updating UI
  const setStatusSafe = (operationId, statusText) => {
    if (operationId === currentOperationIdRef.current && statusRef.current !== statusText) {
      statusRef.current = statusText;
      setStatus(statusText);
    }
  };

  const setStatusIfChanged = useCallback((statusText) => {
    if (statusRef.current !== statusText) {
      statusRef.current = statusText;
      setStatus(statusText);
    }
  }, []);

  const setProgressSafe = (operationId, progressValue) => {
    if (operationId === currentOperationIdRef.current) {
      setProgress(progressValue);
    }
  };

  const logAutoUploadRunnerCondition = (reason, extra = null) => {
    try {
      const now = Date.now();
      if (autoUploadRunnerExitLogMsRef.current && (now - autoUploadRunnerExitLogMsRef.current) < 1000) return;
      autoUploadRunnerExitLogMsRef.current = now;
      console.log('AutoUpload:', reason, extra || '');
    } catch (e) { }
  };

  const applyNftPremiumStatus = (data) => {
    if (!data) return;
    const normalized = data ? { ...data } : {};
    const mintCount = typeof normalized.mintCount === 'number' ? Math.max(0, Number(normalized.mintCount) || 0) : null;
    const freeMintLimit = typeof normalized.freeMintLimit === 'number' ? Math.max(0, Number(normalized.freeMintLimit) || 0) : 100;
    const maxNoFeeMints = typeof normalized.maxNoFeeMints === 'number' ? Math.max(0, Number(normalized.maxNoFeeMints) || 0) : 0;
    if (mintCount !== null) {
      normalized.mintCount = mintCount;
      normalized.freeMintLimit = freeMintLimit;
      normalized.maxNoFeeMints = maxNoFeeMints;
      normalized.freeMintsRemaining = Math.max(0, freeMintLimit - mintCount);
      normalized.noFeeMintsRemaining = Math.max(0, maxNoFeeMints - Math.max(0, mintCount - freeMintLimit));
    }
    setNftIsPremium(!!normalized.isPremium);
    if (typeof normalized.mintCount === 'number') setNftMintCount(normalized.mintCount);
    if (typeof normalized.freeMintLimit === 'number') setNftFreeMintLimit(normalized.freeMintLimit);
    if (typeof normalized.freeMintsRemaining === 'number') setNftFreeMintsRemaining(normalized.freeMintsRemaining);
    if (typeof normalized.maxNoFeeMints === 'number') setNftMaxNoFeeMints(normalized.maxNoFeeMints);
    if (typeof normalized.noFeeMintsRemaining === 'number') setNftNoFeeMintsRemaining(normalized.noFeeMintsRemaining);
  };

  const resetNftPremiumState = () => {
    setNftIsPremium(false);
    setNftMintCount(0);
    setNftFreeMintLimit(100);
    setNftFreeMintsRemaining(0);
    setNftMaxNoFeeMints(0);
    setNftNoFeeMintsRemaining(0);
  };

  const refreshNftPremiumStatus = async () => {
    try {
      const config = await getStealthCloudAuthHeaders();
      const headers = config?.headers || config;
      if (!headers?.Authorization) return null;
      const response = await axios.get('https://stealthlynk.io/api/nft-service/premium-status', {
        headers,
        timeout: 10000,
      });
      const data = response?.data || null;
      if (data) applyNftPremiumStatus(data);
      return data;
    } catch (_) {
      return null;
    }
  };

  const setAutoUploadEnabledSafe = (value) => { autoUploadEnabledRef.current = !!value; setAutoUploadEnabled(!!value); };
  const setFastModeEnabledSafe = (value) => { fastModeEnabledRef.current = !!value; setFastModeEnabled(!!value); };
  const setTokenSafe = (value) => { tokenRef.current = value; setToken(value); };
  const beginAccountTransition = (label) => {
    setAccountTransitionLabel(label || t('alerts.pleaseWait'));
  };
  const endAccountTransition = () => {
    setAccountTransitionLabel('');
  };
  const setLoadingSafe = (value) => {
    loadingRef.current = !!value;
    setLoading(!!value);
    // Pause/resume EXIF backfill when heavy operations start/end
    if (value) { exifBackfillBusy(); } else { exifBackfillIdle(); }
    // Automatically clear background warning flags when loading ends
    if (!value) {
      backgroundWarnEligibleRef.current = false;
      wasBackgroundedDuringWorkRef.current = false;
      backgroundedAtMsRef.current = 0;
      setBackgroundWarnEligible(false);
      setWasBackgroundedDuringWork(false);
    }
  };

  // Camera permission for QR scanner
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  // QR Code scanner handler
  const handleQRCodeScanned = async (data) => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'photolynk-local' && parsed.ip && parsed.port) {
        // Valid PhotoLynk QR code for local server connection
        const serverIp = parsed.ip;
        setLocalHost(serverIp);
        setServerType('local');
        setQrScannerOpen(false);
        // Close Quick Setup modal if open
        setQuickSetupOpen(false);
        setQuickSetupCollapsed(true);

        // Save to SecureStore
        await SecureStore.setItemAsync('local_host', serverIp);
        await SecureStore.setItemAsync('server_type', 'local');

        // On wallet login overlay (not yet authenticated): just set IP, user will login via wallet
        if (showWalletLogin || !token) {
          showDarkAlert(t('login.connected'), t('login.serverIpSetTo', { ip: serverIp + ':' + parsed.port }));
          return;
        }

        // On settings: do full pairing with desktop
        // Try to get credentials from SecureStore (user is logged in)
        let pairEmail = null;
        let pairPassword = null;
        try {
          pairEmail = await SecureStore.getItemAsync('user_email');
          pairPassword = await SecureStore.getItemAsync('user_password_v1', { requireAuthentication: false });
        } catch (e) {
          console.log('[QR] Failed to get credentials from SecureStore:', e.message);
        }
        console.log('[QR] Pairing check:', { pairingPort: parsed.pairingPort, hasToken: !!parsed.token, email: pairEmail || '(empty)', hasPassword: !!pairPassword });
        if (parsed.pairingPort && parsed.token && pairEmail && pairPassword) {
          try {
            console.log('[QR] Sending pairing request to:', `http://${serverIp}:${parsed.pairingPort}/api/pair`);
            const pairingUrl = `http://${serverIp}:${parsed.pairingPort}/api/pair`;
            // Include device_uuid so desktop uses the actual UUID (critical for migrated users
            // where email:password no longer derives the correct legacy UUID)
            const pairDeviceUuid = await getDeviceUUID(pairEmail, pairPassword);
            // Include legacy MK creds so desktop derives the correct PBKDF2 master key
            // for StealthCloud decryption (migrated users use original legacy credentials)
            const mkCreds = await getMasterKeyCredentials();
            const pairingBody = { email: pairEmail, password: pairPassword, token: parsed.token, device_uuid: pairDeviceUuid };
            if (mkCreds) {
              pairingBody.mk_email = mkCreds.email;
              pairingBody.mk_password = mkCreds.password;
            }
            const response = await fetch(pairingUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(pairingBody),
            });
            const result = await response.json();
            if (result.success) {
              // After successful pairing, login to the local server to get a valid JWT token
              // Without this, the stored auth_token may be from StealthCloud (different JWT_SECRET)
              try {
                const localServerUrl = `http://${serverIp}:${parsed.port}`;
                const deviceId = await getDeviceUUID(pairEmail, pairPassword);
                const loginRes = await axios.post(`${localServerUrl}/api/login`, {
                  email: pairEmail,
                  password: pairPassword,
                  device_uuid: deviceId,
                  device_name: Platform.OS + ' ' + Platform.Version,
                }, { timeout: 10000 });
                if (loginRes.data && loginRes.data.token) {
                  await SecureStore.setItemAsync('auth_token', loginRes.data.token);
                  setTokenSafe(loginRes.data.token);
                  setDeviceUuid(deviceId);
                  console.log('[QR] Logged into local server, token stored');
                }
              } catch (loginErr) {
                console.log('[QR] Local server login failed (non-critical):', loginErr.message);
              }
              showDarkAlert(t('login.paired'), t('login.pairedWithDesktop', { ip: serverIp }));
              return;
            }
          } catch (pairErr) {
            console.log('[QR] Pairing request failed:', pairErr.message);
          }
        }

        // Fallback: just show IP set message
        showDarkAlert(t('login.connected'), t('login.serverIpSetTo', { ip: serverIp + ':' + parsed.port }));
      } else if (parsed.type === 'photolynk-decrypt' && parsed.sessionId && parsed.server) {
        // Web portal decryption request - connect via WebSocket
        setQrScannerOpen(false);
        await handleWebPortalDecryption(parsed.sessionId, parsed.server);
      } else {
        showDarkAlert(t('alerts.invalidQrCode'), t('alerts.invalidQrCodeNotPhotolynk'));
      }
    } catch (e) {
      showDarkAlert(t('alerts.invalidQrCode'), t('alerts.invalidQrCodeParse'));
    }
  };

  // Handle web portal decryption via WebSocket
  const handleWebPortalDecryption = async (sessionId, serverUrl) => {
    try {
      // Get encryption key, token, and device UUID from secure storage
      const encryptionKey = await SecureStore.getItemAsync('encryption_key');
      const token = await SecureStore.getItemAsync('auth_token');
      const deviceUuid = await SecureStore.getItemAsync('device_uuid');

      if (!encryptionKey || !token || !deviceUuid) {
        showDarkAlert(t('alerts.notLoggedIn'), t('alerts.notLoggedInMessage'));
        return;
      }

      // Connect to WebSocket
      const wsUrl = serverUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/portal';
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Send auth credentials and encryption key to web portal session
        ws.send(JSON.stringify({
          type: 'phone_connect',
          sessionId: sessionId,
          token: token,
          deviceUuid: deviceUuid,
          encryptionKey: encryptionKey
        }));
        showDarkAlert(t('login.connected'), t('login.webPortalConnected'));
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showDarkAlert(t('alerts.connectionFailed'), t('alerts.webPortalFailed'));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'decrypt_request') {
            // Web portal is requesting decryption of a file
            handleDecryptRequest(ws, msg, encryptionKey);
          } else if (msg.type === 'session_ended') {
            ws.close();
          }
        } catch (e) {
          console.error('WebSocket message error:', e);
        }
      };

      // Keep connection alive for 5 minutes
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }, 5 * 60 * 1000);

    } catch (error) {
      console.error('Web portal decryption error:', error);
      showDarkAlert(t('alerts.error'), t('alerts.failedToConnectWebPortal'));
    }
  };

  // Handle individual file decryption request from web portal
  const handleDecryptRequest = async (ws, msg, encryptionKey) => {
    try {
      const { fileId, encryptedData } = msg;

      // Decrypt the data using nacl
      const keyBytes = nacl.hash(new TextEncoder().encode(encryptionKey)).slice(0, 32);
      const nonce = Uint8Array.from(atob(encryptedData.nonce), c => c.charCodeAt(0));
      const ciphertext = Uint8Array.from(atob(encryptedData.ciphertext), c => c.charCodeAt(0));

      const decrypted = nacl.secretbox.open(ciphertext, nonce, keyBytes);

      if (decrypted) {
        // Send decrypted data back to web portal
        ws.send(JSON.stringify({
          type: 'decrypt_response',
          fileId: fileId,
          success: true,
          data: btoa(String.fromCharCode(...decrypted))
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'decrypt_response',
          fileId: fileId,
          success: false,
          error: 'Decryption failed'
        }));
      }
    } catch (error) {
      console.error('Decrypt request error:', error);
      ws.send(JSON.stringify({
        type: 'decrypt_response',
        fileId: msg.fileId,
        success: false,
        error: error.message
      }));
    }
  };

  // Format helpers - defined early since used throughout
  const formatBytesHuman = (bytes) => formatBytes(bytes, false);
  const formatBytesHumanDecimal = (bytes) => formatBytes(bytes, true);

  // Custom dark-themed alert (replaces Alert.alert for duplicate results)
  const showDarkAlert = (title, message, buttons = null) => {
    // Close Quick Setup modal if open to ensure alert is visible
    setQuickSetupOpen(false);
    setQuickSetupCollapsed(true);
    setCustomAlert({
      title,
      message,
      buttons: buttons || [{ text: 'OK', onPress: () => setCustomAlert(null) }]
    });
  };
  const closeDarkAlert = () => setCustomAlert(null);

  // Show completion tick - stays until user taps to dismiss
  const showCompletionTickBriefly = (message = '') => {
    setCompletionMessage(message);
    setShowCompletionTick(true);
    // No auto-hide - user must tap to dismiss
  };

  // Dismiss completion tick on user tap
  const dismissCompletionTick = () => {
    setShowCompletionTick(false);
    setCompletionMessage('');
  };

  // Standardized result for backup/sync/cleanup operations - shows tick
  const showResultAlert = (type, stats) => {
    // Only show tick for success, not errors
    if (!stats.error) {
      let msg = '';
      if (type === 'backup') {
        const u = stats.uploaded || 0;
        // Use serverTotal if available (actual files on server), otherwise fall back to uploaded + skipped
        const serverTotal = stats.serverTotal || (u + (stats.skipped || 0));
        if (u > 0) {
          msg = t('results.xOfYUploaded', { uploaded: u, total: serverTotal });
        } else {
          msg = t('results.filesOnServer', { count: serverTotal });
        }
      } else if (type === 'sync') {
        const d = stats.downloaded || 0;
        const s = stats.skipped || 0;
        const total = d + s;
        if (d > 0) {
          msg = t('results.xOfYDownloaded', { downloaded: d, total });
        } else {
          msg = t('results.filesOnDevice', { count: s });
        }
      } else if (type === 'cleanup' || type === 'clean') {
        const del = stats.deleted || 0;
        msg = del > 0 ? t('results.filesDeleted', { count: del }) : t('results.noDuplicatesFound');
      }
      showCompletionTickBriefly(msg);
      if (type === 'backup') {
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        setQsLastBackupTime(timeStr);
        SecureStore.setItemAsync('last_backup_time', timeStr).catch(() => {});
      }
    }
  };

  const openPaywall = (tierGb) => {
    setPaywallTierGb(tierGb);
  };

  const closePaywall = () => {
    setPaywallTierGb(null);
    setPaywallPaymentMethod('sol'); // Reset to default
    setBlockchainConsent(false); // Reset blockchain consent
  };

  const persistAutoUploadEnabled = async (enabled) => {
    const next = AUTO_UPLOAD_FEATURE_ENABLED ? !!enabled : false;
    setAutoUploadEnabledSafe(next);
    try { await SecureStore.setItemAsync('auto_upload_enabled', next ? 'true' : 'false'); } catch (e) { }
  };

  const persistFastModeEnabled = async (enabled) => {
    setFastModeEnabledSafe(enabled);
    try { await SecureStore.setItemAsync('fast_mode_enabled', enabled ? 'true' : 'false'); } catch (e) { }
  };

  const persistGlassModeEnabled = (enabled) => {
    setGlassModeEnabled(enabled);
    SecureStore.setItemAsync('glass_mode_enabled', enabled ? 'true' : 'false').catch(() => { });
  };

  useEffect(() => { autoUploadEnabledRef.current = !!autoUploadEnabled; }, [autoUploadEnabled]);
  useEffect(() => { fastModeEnabledRef.current = !!fastModeEnabled; }, [fastModeEnabled]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { serverTypeRef.current = serverType; }, [serverType]);
  useEffect(() => { if (!token) walletProfileSyncKeyRef.current = ''; }, [token]);

  // Force fast mode ON for local/remote — only stealthcloud allows toggling
  useEffect(() => {
    if (serverType === 'local' || serverType === 'remote') {
      setFastModeEnabledSafe(true);
    }
  }, [serverType]);

  // Throttle helpers - return current values based on fast mode setting
  const getThrottleBatchLimit = () => fastModeEnabledRef.current ? FAST_BATCH_LIMIT : THERMAL_BATCH_LIMIT;
  const getThrottleBatchCooldownMs = () => fastModeEnabledRef.current ? FAST_BATCH_COOLDOWN_MS : THERMAL_BATCH_COOLDOWN_MS;
  const getThrottleAssetCooldownMs = () => fastModeEnabledRef.current ? FAST_ASSET_COOLDOWN_MS : THERMAL_ASSET_COOLDOWN_MS;
  const getThrottleChunkCooldownMs = () => fastModeEnabledRef.current ? FAST_CHUNK_COOLDOWN_MS : THERMAL_CHUNK_COOLDOWN_MS;

  // Solana purchase helpers
  const loadAvailablePlans = async () => {
    try {
      setPlansLoading(true);
      const plans = await getAvailablePlans();
      setAvailablePlans(plans);
    } catch (e) {
      console.error('Failed to load plans:', e);
    } finally {
      setPlansLoading(false);
    }
  };

  const refreshSubscriptionStatus = async () => {
    try {
      const status = await getSubscriptionStatus(token, deviceUuid);
      setSubscriptionStatus(status);

      // Persist so local/remote and reload still know the subscription state
      try {
        if (status) {
          await SecureStore.setItemAsync(CACHED_SUBSCRIPTION_STATUS_KEY, JSON.stringify(status));
        } else {
          await SecureStore.deleteItemAsync(CACHED_SUBSCRIPTION_STATUS_KEY);
        }
      } catch (_) {}

      let isLegacy = false;
      // Legacy subscription detection:
      // - Store version at first subscription
      // - If subscription lapsed and re-subscribed, update to current version
      // - Legacy = subscribed before v3 and never lapsed
      if (status?.status === 'active') {
        try {
          const wasInactive = await SecureStore.getItemAsync(SUBSCRIPTION_WAS_INACTIVE_KEY);
          const storedVersion = await SecureStore.getItemAsync(SUBSCRIBED_AT_VERSION_KEY);

          if (!storedVersion || wasInactive === 'true') {
            // First subscription or re-subscription after lapse → current version
            await SecureStore.setItemAsync(SUBSCRIBED_AT_VERSION_KEY, APP_VERSION);
            await SecureStore.deleteItemAsync(SUBSCRIPTION_WAS_INACTIVE_KEY);
            isLegacy = false;
          } else {
            // Continuous subscription — legacy if subscribed before v3
            isLegacy = storedVersion < '3.0.0';
          }
        } catch (_) {
          isLegacy = false;
        }
      } else {
        // Subscription inactive — mark so we detect re-subscription
        try {
          await SecureStore.setItemAsync(SUBSCRIPTION_WAS_INACTIVE_KEY, 'true');
        } catch (_) {}
        isLegacy = false;
      }
      setIsLegacySubscriber(isLegacy);

      // Persist legacy flag too
      try {
        await SecureStore.setItemAsync('is_legacy_subscriber', String(isLegacy));
      } catch (_) {}

      if (status?.isPremium) {
        setNftIsPremium(true);
        await refreshNftPremiumStatus();
      } else {
        resetNftPremiumState();
      }
      return status;
    } catch (e) {
      // Silently ignore subscription status errors (403, network, etc.)
      return null;
    }
  };

  const refreshStealthUsage = async () => {
    try {
      if (loadingRef.current) {
        return null;
      }
      const config = await getAuthHeaders();
      const base = getServerUrl();
      console.log('[Info] Fetching usage from:', base, 'auth:', !!config?.headers?.Authorization);
      const res = await axios.get(`${base}/api/cloud/usage`, { ...config, timeout: 10000 });
      const data = res && res.data ? res.data : null;
      console.log('[Info] Usage response:', data ? `quota=${data.quotaBytes || data.quota_bytes}, sub=${data.subscription?.status}, premiumGb=${data.premiumGb}` : 'null');
      setStealthUsage(data);
      // Restore premium state from server data on every usage refresh
      if (data && (Number(data.premiumGb) > 0 || data.subscription?.status === 'premium_only')) {
        setNftIsPremium(true);
      }
      return data;
    } catch (e) {
      console.log('[Info] Failed to refresh usage:', e?.response?.status, e?.message);
      return null;
    }
  };

  const handlePurchase = async (tierGb, paymentMethod = 'sol') => {
    try {
      setPurchaseLoading(true);
      setStatus(t('status.processingPurchase'));
      
      // Get pricing info for display
      let priceDisplay = '';
      if (paymentMethod === 'skr') {
        const skrPrice = await getPlanPriceWithSkr(tierGb, 'monthly');
        priceDisplay = `${skrPrice.skrAmountFormatted} (~$${skrPrice.discountedUsd.toFixed(2)})`;
      }

      // Get auth token for server authentication
      let authToken = token;
      if (!authToken) {
        try {
          authToken = await SecureStore.getItemAsync('auth_token');
        } catch (e) { }
      }
      if (!authToken) {
        showDarkAlert(t('alerts.error'), t('alerts.notLoggedInMessage'));
        setPurchaseLoading(false);
        setStatus(t('status.idle'));
        return;
      }

      // Use universal wallet purchase (supports MWA, Phantom, WalletConnect, etc.)
      // Purchase with selected payment method
      let result;
      if (paymentMethod === 'skr') {
        result = await purchaseWithSkr(tierGb, authToken, 'monthly');
      } else {
        result = await purchaseWithWallet(tierGb, authToken, 'monthly');
      }

      if (result.success) {
        // Close paywall popup immediately on success
        closePaywall();

        // Refresh subscription status from server
        await refreshSubscriptionStatus();
        await refreshStealthUsage();
        setSelectedStealthPlanGb(tierGb);

        // Show appropriate message based on server verification
        const planName = tierGb === 1000 ? '1 TB' : tierGb + ' GB';
        if (result.pendingVerification) {
          // Fallback message if translation key doesn't exist
          const pendingMsg = t('alerts.paymentSentPending', { plan: planName });
          const fallbackMsg = `Payment sent! Your ${planName} plan will activate shortly.`;
          showDarkAlert(t('alerts.success'), pendingMsg.includes('paymentSentPending') ? fallbackMsg : pendingMsg);
          // Schedule deferred background retries so user doesn't need to restart app
          const deferredRetry = async (delaySec) => {
            await new Promise(r => setTimeout(r, delaySec * 1000));
            try {
              const freshToken = token || await SecureStore.getItemAsync('auth_token');
              const retryResult = await retryPendingSubscriptionVerification(freshToken);
              if (retryResult.success && retryResult.hadPending) {
                console.log(`[Purchase] Deferred retry at ${delaySec}s succeeded`);
                await refreshSubscriptionStatus();
                await refreshStealthUsage();
              }
            } catch (_) {}
          };
          deferredRetry(30);
          deferredRetry(60);
        } else {
          showDarkAlert(t('alerts.success'), t('alerts.planActive', { plan: planName }));
        }
      } else if (result.userCancelled) {
        // User cancelled - no message needed
      } else {
        // Close paywall first so alert is visible
        closePaywall();
        // Use translated error message based on errorKey
        const errorMessage = result.errorKey
          ? t(`alerts.${result.errorKey}`)
          : (result.error || t('alerts.purchaseFailedMessage'));
        showDarkAlert(t('alerts.purchaseFailed'), errorMessage);
      }
    } catch (e) {
      closePaywall();
      showDarkAlert(t('alerts.purchaseError'), e.message || t('alerts.purchaseErrorMessage'));
    } finally {
      setPurchaseLoading(false);
      setStatus(t('status.idle'));
    }
  };

  const handleSolanaPremium = async (paymentMethod = 'sol') => {
    try {
      setNftPurchaseLoading(true);
      setStatus(t('status.processingPurchase'));

      let authToken = token;
      if (!authToken) {
        try {
          authToken = await SecureStore.getItemAsync('auth_token');
        } catch (e) { }
      }
      if (!authToken) {
        showDarkAlert(t('alerts.error'), t('alerts.notLoggedInMessage'));
        setNftPurchaseLoading(false);
        setStatus(t('status.idle'));
        return;
      }

      // Use appropriate purchase method based on payment selection
      const result = paymentMethod === 'skr'
        ? await purchasePremiumWithWalletSkr(authToken)
        : await purchasePremiumWithWallet(authToken);

      if (result.success) {
        setNftIsPremium(true);
        await refreshSubscriptionStatus();
        await refreshStealthUsage();

        if (result.pendingVerification) {
          showDarkAlert(t('alerts.success'), t('subscription.paymentReceivedPremiumFailed') + (result.txSignature || ''));
        } else {
          showDarkAlert(t('alerts.success'), t('subscription.premiumActivated'));
        }
      } else if (result.userCancelled) {
        // User cancelled - no message needed
      } else if (result.insufficientBalance) {
        showDarkAlert(t('alerts.insufficientBalance'), result.error);
      } else {
        const errorMessage = result.errorKey
          ? t(`alerts.${result.errorKey}`)
          : (result.error || t('alerts.purchaseFailedMessage'));
        showDarkAlert(t('alerts.purchaseFailed'), errorMessage);
      }
    } catch (e) {
      showDarkAlert(t('alerts.purchaseError'), e.message || t('alerts.purchaseErrorMessage'));
    } finally {
      setNftPurchaseLoading(false);
      setStatus(t('status.idle'));
    }
  };

  const handleRestorePurchases = async () => {
    try {
      setPurchaseLoading(true);
      setStatus(t('status.checkingSubscription'));

      // For Solana payments, just refresh from server - it tracks all payments
      const status = await refreshSubscriptionStatus();
      await refreshStealthUsage();

      if (status && status.isActive) {
        showDarkAlert(t('alerts.success'), t('alerts.subscriptionRestored'));
      } else {
        showDarkAlert(t('alerts.noSubscriptionFound'), t('alerts.noSubscriptionFoundMessage'));
      }
    } catch (e) {
      showDarkAlert(t('alerts.error'), e.message || t('alerts.restoreErrorMessage'));
    } finally {
      setPurchaseLoading(false);
      setStatus(t('status.idle'));
    }
  };

  const deleteAccountFromApp = async () => {
    let deleteSucceeded = false;
    let accountDeletedRemotely = false;

    try {
      setLoadingSafe(true);
      setBackgroundWarnEligibleSafe(false);
      setWasBackgroundedDuringWorkSafe(false);
      setStatus(t('status.deleting'));

      const SERVER_URL = getServerUrl();
      if (!SERVER_URL) {
        throw new Error(t('alerts.connectionFailed'));
      }

      let config = await getAuthHeaders();

      try {
        await axios.delete(`${SERVER_URL}/api/account`, {
          ...config,
          timeout: 30000,
        });
      } catch (error) {
        if (error?.response?.status !== 403) {
          throw error;
        }

        const refreshed = await refreshAuthToken();
        if (!refreshed?.success || !refreshed?.headers) {
          throw error;
        }

        config = { headers: refreshed.headers };
        await axios.delete(`${SERVER_URL}/api/account`, {
          ...config,
          timeout: 30000,
        });
      }

      accountDeletedRemotely = true;

      try {
        await disconnectCurrentWallet();
      } catch (walletError) {
        console.log('[Account Deletion] Wallet disconnect skipped:', walletError?.message);
      }

      setStatus(t('auth.signingOut'));
      await logout({ forgetCredentials: true });
      deleteSucceeded = true;
    } catch (error) {
      const message = accountDeletedRemotely
        ? (error?.message || 'Account deleted, but local logout cleanup failed.')
        : (error?.response?.data?.error || error?.message || 'Failed to delete account.');
      showDarkAlert(t('alerts.error'), message);
    } finally {
      if (!deleteSucceeded) {
        setLoadingSafe(false);
        setStatus(t('status.idle'));
      }
    }
  };

  const handleDeleteAccount = () => {
    showDarkAlert(
      t('info.deleteAccount'),
      t('info.deleteAccountWarning'),
      [
        { text: t('alerts.cancel') || 'Cancel' },
        { text: t('info.deleteAccount'), onPress: deleteAccountFromApp },
      ]
    );
  };

  const getAutoUploadEligibility = async () => {
    try {
      const state = await evaluateAutoUploadPolicyState();
      if (state.ok) return { ok: true, reason: null };
      return { ok: false, reason: state.reason || 'Auto Upload waiting' };
    } catch (e) { return { ok: false, reason: 'Auto Upload policy check failed' }; }
  };

  const ensureAutoUploadPolicyAllowsWork = async ({ userInitiated }) => {
    if (!autoUploadEnabledRef.current) return true;
    if (userInitiated) return true;
    const el = await getAutoUploadEligibility();
    if (el.ok) {
      const st = (appStateRef.current || 'active').toString();
      if (st === 'active') setStatusIfChanged(t('status.autoBackupResumed'));
      return true;
    }
    setStatusIfChanged(el.reason || 'Auto-Backup: Waiting');
    return false;
  };

  const ensureAutoUploadPolicyAllowsWorkIfBackgrounded = async () => {
    if (!autoUploadEnabledRef.current) return true;
    const st = (appStateRef.current || 'active').toString();
    if (st === 'active') return true;
    const el = await getAutoUploadEligibility();
    if (el.ok) {
      // Don't update status when in background - keep showing "paused (backgrounded)"
      return true;
    }
    setStatusIfChanged(el.reason || 'Auto-Backup: Waiting');
    try {
      const now = Date.now();
      if (!autoUploadBackgroundPolicyLogMsRef.current || (now - autoUploadBackgroundPolicyLogMsRef.current) > 5000) {
        autoUploadBackgroundPolicyLogMsRef.current = now;
        console.log('AutoUpload: waiting (background policy)', el.reason || 'unknown');
      }
    } catch (e) { }
    return false;
  };

  const scheduleNextAutoUploadNightKick = () => {
    try {
      if (autoUploadNightNextTimerRef.current) {
        clearTimeout(autoUploadNightNextTimerRef.current);
        autoUploadNightNextTimerRef.current = null;
      }

      const nowLog = Date.now();
      const canLog = (!autoUploadDebugScheduleLastLogMsRef.current || (nowLog - autoUploadDebugScheduleLastLogMsRef.current) > 8000);

      if (!autoUploadEnabledRef.current) {
        if (canLog) { autoUploadDebugScheduleLastLogMsRef.current = nowLog; console.log('AutoUpload: schedule skipped (disabled)'); }

        // Stop Android foreground service when disabled
        try { void stopAndroidForegroundUploadService(); } catch (e) { }
        return;
      }
      if (serverTypeRef.current !== 'stealthcloud') {
        if (canLog) { autoUploadDebugScheduleLastLogMsRef.current = nowLog; console.log('AutoUpload: schedule skipped (serverType)', serverTypeRef.current); }
        return;
      }
      if (!tokenRef.current) {
        if (canLog) { autoUploadDebugScheduleLastLogMsRef.current = nowLog; console.log('AutoUpload: schedule skipped (missing token)'); }
        return;
      }

      void maybeStartAutoUploadNightSession();

      autoUploadNightNextTimerRef.current = setTimeout(() => {
        autoUploadNightNextTimerRef.current = null;
        void maybeStartAutoUploadNightSession();
        scheduleNextAutoUploadNightKick();
      }, AUTO_UPLOAD_POLICY_POLL_MS);

      try {
        const now2 = Date.now();
        if (!autoUploadDebugScheduleLastLogMsRef.current || (now2 - autoUploadDebugScheduleLastLogMsRef.current) > 8000) {
          autoUploadDebugScheduleLastLogMsRef.current = now2;
          console.log('AutoUpload: scheduled policy poll in', Math.round(AUTO_UPLOAD_POLICY_POLL_MS / 1000), 's');
        }
      } catch (e) { }
    } catch (e) {
      // ignore
    }
  };

  const maybeStartAutoUploadNightSession = async () => {
    // Feature disabled globally
    if (!AUTO_UPLOAD_FEATURE_ENABLED) {
      autoUploadNightRunnerStartingRef.current = false;
      return;
    }
    // Prevent concurrent calls
    if (autoUploadNightRunnerStartingRef.current) {
      return;
    }
    autoUploadNightRunnerStartingRef.current = true;

    try {
      const now = Date.now();
      const canLog = (!autoUploadDebugLastLogMsRef.current || (now - autoUploadDebugLastLogMsRef.current) > 8000);
      if (!autoUploadEnabledRef.current) {
        if (canLog) { autoUploadDebugLastLogMsRef.current = now; console.log('AutoUpload: not starting (disabled)'); }
        autoUploadNightRunnerStartingRef.current = false;
        return;
      }
      if (serverTypeRef.current !== 'stealthcloud') {
        if (canLog) { autoUploadDebugLastLogMsRef.current = now; console.log('AutoUpload: not starting (serverType)', serverTypeRef.current); }
        autoUploadNightRunnerStartingRef.current = false;
        return;
      }
      if (!tokenRef.current) {
        if (canLog) { autoUploadDebugLastLogMsRef.current = now; console.log('AutoUpload: not starting (missing token)'); }
        autoUploadNightRunnerStartingRef.current = false;
        return;
      }
      const state = await evaluateAutoUploadPolicyState();
      if (!state.ok) {
        if (canLog) { autoUploadDebugLastLogMsRef.current = now; console.log('AutoUpload: not starting (policy)', state.reason); }
        setStatusIfChanged(state.reason || 'Auto-Backup: Waiting');
        autoUploadNightRunnerStartingRef.current = false;
        return;
      }

      const photoAccess = await checkPhotoAccessForAutoUpload();
      if (!photoAccess.granted) {
        if (canLog) { autoUploadDebugLastLogMsRef.current = now; console.log('AutoUpload: not starting (photos permission denied)'); }
        setStatusIfChanged(t('status.autoBackupAllowPhotos'));
        autoUploadNightRunnerStartingRef.current = false;
        return;
      }
      if (photoAccess.limited) {
        if (canLog) {
          autoUploadDebugLastLogMsRef.current = now;
          console.log('AutoUpload: not starting (photos access limited)');
        }
        if (Platform.OS === 'ios') {
          setStatusIfChanged(t('status.autoBackupEnableAllPhotos'));
          showDarkAlert(
            t('alerts.allowAllPhotos'),
            t('alerts.allowAllPhotosMessage')
          );
        }
        autoUploadNightRunnerStartingRef.current = false;
        return;
      }
    } catch (e) {
      // ignore precondition errors
      autoUploadNightRunnerStartingRef.current = false;
      return;
    }

    // Watchdog: replace stuck runner if no heartbeat in 120s
    if (autoUploadNightRunnerActiveRef.current) {
      const lastBeat = autoUploadNightRunnerHeartbeatMsRef.current || 0;
      const staleTimeoutMs = Platform.OS === 'android' ? (120 * 1000) : (120 * 1000);
      const stale = lastBeat > 0 && (Date.now() - lastBeat) > staleTimeoutMs;
      if (!stale) {
        console.log('AutoUpload: runner already active, not stale yet', { lastBeatAgoMs: Date.now() - lastBeat, staleTimeoutMs });
        autoUploadNightRunnerStartingRef.current = false;
        return;
      }

      console.log('AutoUpload: replacing stuck night runner (stale)', { lastBeatAgoMs: Date.now() - lastBeat });
      autoUploadNightRunnerCancelRef.current = true;
      autoUploadNightRunnerSessionIdRef.current += 1;
      autoUploadNightRunnerActiveRef.current = false;
    }

    autoUploadNightRunnerStartingRef.current = false;

    autoUploadNightRunnerSessionIdRef.current += 1;
    const sessionId = autoUploadNightRunnerSessionIdRef.current;
    console.log('AutoUpload: starting night runner session', sessionId);
    setStatusIfChanged(t('status.autoBackupResumed'));

    autoUploadNightRunnerActiveRef.current = true;
    autoUploadNightRunnerCancelRef.current = false;
    autoUploadNightRunnerHeartbeatMsRef.current = Date.now();
    await activateKeepAwakeForAutoUpload();

    // Android: start foreground service to prevent suspension
    try {
      if (Platform.OS === 'android') {
        await startAndroidForegroundUploadService({
          title: 'Auto Upload',
          text: 'Checking for new photos...'
        });
      }
    } catch (e) { }
    try {
      console.log('AutoUpload: entering runner loop', {
        autoUploadEnabled: autoUploadEnabledRef.current,
        serverType: serverTypeRef.current,
        hasToken: !!tokenRef.current,
        sessionId,
        currentSessionId: autoUploadNightRunnerSessionIdRef.current,
        cancelled: autoUploadNightRunnerCancelRef.current
      });
      while (autoUploadEnabledRef.current && serverTypeRef.current === 'stealthcloud' && tokenRef.current) {
        if (sessionId !== autoUploadNightRunnerSessionIdRef.current) {
          console.log('AutoUpload: breaking - session mismatch', { sessionId, current: autoUploadNightRunnerSessionIdRef.current });
          break;
        }
        if (autoUploadNightRunnerCancelRef.current) {
          console.log('AutoUpload: breaking - cancelled');
          break;
        }
        autoUploadNightRunnerHeartbeatMsRef.current = Date.now();

        // Skip if user task in progress
        if (loadingRef.current) {
          await sleep(30000);
          continue;
        }

        const allowed = await ensureAutoUploadPolicyAllowsWork({ userInitiated: false });
        if (!allowed) {
          console.log('AutoUpload: runner sleeping (policy not allowed)');
          await sleep(60000);
          continue;
        }

        const allowedBg = await ensureAutoUploadPolicyAllowsWorkIfBackgrounded();
        if (!allowedBg) {
          console.log('AutoUpload: runner sleeping (background policy not allowed)', { appState: appStateRef.current });
          await sleep(60000);
          continue;
        }

        let config = null;
        let authErr = null;
        try {
          config = await getAuthHeaders();
        } catch (e) {
          authErr = e;
          config = null;
        }
        if (!config) {
          try {
            const now = Date.now();
            if (!autoUploadDebugLastLogMsRef.current || (now - autoUploadDebugLastLogMsRef.current) > 15000) {
              autoUploadDebugLastLogMsRef.current = now;
              const msg = authErr && authErr.message ? String(authErr.message) : 'unknown';
              console.log('AutoUpload: waiting (no auth headers)', msg);
            }
          } catch (e) { }
          await sleep(60000);
          continue;
        }

        let SERVER_URL = getServerUrl();
        if (!SERVER_URL) {
          try {
            const now = Date.now();
            if (!autoUploadDebugLastLogMsRef.current || (now - autoUploadDebugLastLogMsRef.current) > 15000) {
              autoUploadDebugLastLogMsRef.current = now;
              console.log('AutoUpload: waiting (no server url)');
            }
          } catch (e) { }
          await sleep(60000);
          continue;
        }

        const startedAt = Date.now();
        const batchBudgetMs = Platform.OS === 'ios' ? 20000 : 2 * 60 * 1000;
        const maxUploads = Platform.OS === 'ios' ? 8 : 200;
        const pageSize = Platform.OS === 'ios' ? 80 : 250;

        let existingManifests = [];
        try {
          existingManifests = await fetchAllManifestsPaged(SERVER_URL, config, null, true); // includeMeta=true for fast dedup
        } catch (e) {
          existingManifests = [];
        }
        let already = new Set(existingManifests.map(m => m.manifestId));

        let initialDeviceTotalCount = null;
        try {
          const firstPage = await MediaLibrary.getAssetsAsync({
            mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
            first: 1,
            sortBy: [MediaLibrary.SortBy.creationTime]
          });
          if (firstPage && typeof firstPage.totalCount === 'number') {
            initialDeviceTotalCount = firstPage.totalCount;
          }
        } catch (e) { }
        const canCompareTotalsAtStart = (typeof initialDeviceTotalCount === 'number');
        const allBackedUpAtStart = canCompareTotalsAtStart && existingManifests.length >= initialDeviceTotalCount;
        const shouldShowPreparingAtStart = canCompareTotalsAtStart && existingManifests.length > 0 && existingManifests.length < initialDeviceTotalCount;
        console.log('AutoUpload: early check -', { serverManifests: existingManifests.length, deviceTotal: initialDeviceTotalCount, allBackedUpAtStart, shouldShowPreparingAtStart });
        let backupCompleted = false;
        if (allBackedUpAtStart) {
          setStatusIfChanged(t('status.autoBackupActive'));
          backupCompleted = true;
          console.log('AutoUpload: all files already backed up at start, skipping manifest decryption');
        }

        // Build deduplication sets for cross-device duplicate detection (auto-upload has more time)
        // Try to load cached dedup sets first to avoid re-decrypting all manifests
        let alreadyFilenames = new Set();
        let alreadyBaseFilenames = new Set();
        let alreadyBaseNameSizes = new Map(); // baseFilename -> Set of sizes
        let alreadyBaseNameDates = new Map(); // baseFilename -> Set of date strings (YYYY-MM-DD)
        let alreadyBaseNameTimestamps = new Map(); // baseFilename -> Set of full timestamps (YYYY-MM-DDTHH:MM:SS) for HEIC
        let alreadyPerceptualHashes = new Set();
        let alreadyFileHashes = new Set();
        // Build dedup sets from metadata in list response (no decryption needed - server returns plaintext meta)
        if (existingManifests.length > 0 && !allBackedUpAtStart) {
          if (shouldShowPreparingAtStart) setStatusIfChanged(t('status.autoBackupPreparing'));
          for (const m of existingManifests) {
            // Use metadata from list response (includeMeta=true) - no HTTP request needed
            if (m.filename) {
              alreadyFilenames.add(normalizeFilenameForCompare(m.filename));
              const baseName = extractBaseFilename(m.filename);
              if (baseName) {
                alreadyBaseFilenames.add(baseName);
                if (m.originalSize) {
                  if (!alreadyBaseNameSizes.has(baseName)) alreadyBaseNameSizes.set(baseName, new Set());
                  alreadyBaseNameSizes.get(baseName).add(m.originalSize);
                }
                if (m.creationTime) {
                  const dateStr = normalizeDateForCompare(m.creationTime);
                  if (dateStr) {
                    if (!alreadyBaseNameDates.has(baseName)) alreadyBaseNameDates.set(baseName, new Set());
                    alreadyBaseNameDates.get(baseName).add(dateStr);
                  }
                  const fullTimestamp = normalizeFullTimestamp(m.creationTime);
                  if (fullTimestamp) {
                    if (!alreadyBaseNameTimestamps.has(baseName)) alreadyBaseNameTimestamps.set(baseName, new Set());
                    alreadyBaseNameTimestamps.get(baseName).add(fullTimestamp);
                  }
                }
              }
            }
            if (m.perceptualHash) alreadyPerceptualHashes.add(m.perceptualHash);
            if (m.fileHash) alreadyFileHashes.add(m.fileHash);
          }
          console.log(`AutoUpload: found ${alreadyFilenames.size} filenames, ${alreadyBaseFilenames.size} base names, ${alreadyBaseNameSizes.size} name+size, ${alreadyBaseNameDates.size} name+date, ${alreadyBaseNameTimestamps.size} name+timestamp, ${alreadyPerceptualHashes.size} perceptual hashes, ${alreadyFileHashes.size} file hashes for deduplication`);
          // Debug: log some sample filenames to verify they're being collected
          const sampleFilenames = Array.from(alreadyFilenames).slice(0, 5);
          console.log(`AutoUpload: sample filenames in set: ${JSON.stringify(sampleFilenames)}`);

          // Memory cleanup: clear existingManifests array after building dedup sets
          // The dedup sets contain all needed info, no need to keep raw manifests in memory
          existingManifests.length = 0;
          try { if (global.gc) global.gc(); } catch (e) { }
          console.log('AutoUpload: dedup sets built, cleared manifest array to free memory');
        }

        let after = null;
        const cursorKey = await getAutoUploadCursorKey();
        try {
          const savedCursor = await SecureStore.getItemAsync(cursorKey);
          after = savedCursor ? savedCursor : null;
        } catch (e) {
          after = null;
        }

        let uploaded = 0;
        let skipped = 0;
        let failed = 0;

        // Track cumulative progress across sessions
        let totalEstimatedCount = null;
        let cumulativeUploaded = 0;

        // Get current uploaded count from server manifests (primary source)
        config = await getAuthHeaders();
        SERVER_URL = getServerUrl();
        try {
          const existingManifests = await fetchAllManifestsPaged(SERVER_URL, config);
          cumulativeUploaded = existingManifests.length;
          console.log('AutoUpload: loaded cumulative uploaded count from server:', cumulativeUploaded);
        } catch (e) {
          console.log('AutoUpload: failed to load manifests from server, using SecureStore fallback');
          // Fallback to SecureStore if server request fails
          try {
            const saved = await SecureStore.getItemAsync('auto_upload_cumulative_uploaded');
            cumulativeUploaded = saved ? parseInt(saved, 10) || 0 : 0;
          } catch (e2) {
            cumulativeUploaded = 0;
          }
        }

        // Create set of already uploaded manifest IDs
        already = new Set();
        if (existingManifests) {
          existingManifests.forEach(m => already.add(m.manifestId));
        } else {
          // If we couldn't load manifests, try again or use empty set
          try {
            const manifests = await fetchAllManifestsPaged(SERVER_URL, config);
            manifests.forEach(m => already.add(m.manifestId));
          } catch (e) {
            console.log('AutoUpload: failed to load manifest IDs, will check individually');
          }
        }

        // Get total count early to check if all files are already backed up
        try {
          const firstPage = await MediaLibrary.getAssetsAsync({
            mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
            first: 1,
            sortBy: [MediaLibrary.SortBy.creationTime]
          });
          if (firstPage && typeof firstPage.totalCount === 'number') {
            totalEstimatedCount = firstPage.totalCount;
            // If all files are already backed up, show Active status immediately
            if (cumulativeUploaded >= totalEstimatedCount) {
              setStatusIfChanged(t('status.autoBackupActive'));
              console.log('AutoUpload: all files already backed up, showing Active status');
              backupCompleted = true;
            }
          }
        } catch (e) {
          console.log('AutoUpload: failed to get initial total count');
        }

        while (true) {
          if (uploaded >= maxUploads) {
            console.log('AutoUpload: breaking loop - max uploads reached', uploaded, maxUploads);
            logAutoUploadRunnerCondition('runner exiting loop (max uploads reached)', { uploaded, maxUploads });
            break;
          }
          if (Date.now() - startedAt >= batchBudgetMs) {
            console.log('AutoUpload: breaking loop - batch budget exceeded', Date.now() - startedAt, batchBudgetMs);
            logAutoUploadRunnerCondition('runner exiting loop (batch budget exceeded)', { elapsedMs: Date.now() - startedAt, batchBudgetMs });
            break;
          }
          if (sessionId !== autoUploadNightRunnerSessionIdRef.current) {
            console.log('AutoUpload: breaking loop - session superseded', sessionId, autoUploadNightRunnerSessionIdRef.current);
            logAutoUploadRunnerCondition('runner exiting loop (session superseded)', { sessionId, activeSessionId: autoUploadNightRunnerSessionIdRef.current });
            break;
          }
          if (autoUploadNightRunnerCancelRef.current) {
            console.log('AutoUpload: breaking loop - cancel requested');
            logAutoUploadRunnerCondition('runner exiting loop (cancel requested)');
            break;
          }
          if (!autoUploadEnabledRef.current) {
            console.log('AutoUpload: breaking loop - auto upload disabled');
            logAutoUploadRunnerCondition('runner exiting loop (auto upload disabled)');
            break;
          }

          const page = await MediaLibrary.getAssetsAsync({
            mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
            first: pageSize,
            after: after || undefined,
            sortBy: [MediaLibrary.SortBy.creationTime]
          });
          const assets = page && Array.isArray(page.assets) ? page.assets : [];
          if (!assets.length) {
            try {
              const nowAssets = Date.now();
              if (!autoUploadAssetLogMsRef.current || (nowAssets - autoUploadAssetLogMsRef.current) > 15000) {
                autoUploadAssetLogMsRef.current = nowAssets;
                console.log('AutoUpload: no assets returned', {
                  hasNextPage: page && page.hasNextPage,
                  totalCount: page && typeof page.totalCount === 'number' ? page.totalCount : undefined,
                  after,
                });
                // If we've reached the end with no assets, notify user backup is complete
                if (!page || page.hasNextPage !== true) {
                  console.log('AutoUpload: reached end of assets, clearing cursor and setting active');
                  await SecureStore.deleteItemAsync(cursorKey);
                  setStatusIfChanged(t('status.autoBackupActive'));
                  console.log('AutoUpload: full backup cycle complete, all photos backed up, monitoring');
                  backupCompleted = true;
                }
              }
            } catch (e) { }
            break;
          }

          // Update total count from each page (in case new files were added)
          if (page && typeof page.totalCount === 'number') {
            if (totalEstimatedCount === null || page.totalCount > totalEstimatedCount) {
              totalEstimatedCount = page.totalCount;
            }
            console.log('AutoUpload: estimated total assets to upload:', totalEstimatedCount);
            // Update status with current progress or completion
            console.log('AutoUpload: initial status - backupCompleted:', backupCompleted, 'cumulativeUploaded:', cumulativeUploaded, 'totalEstimatedCount:', totalEstimatedCount);
            if (backupCompleted || cumulativeUploaded === totalEstimatedCount) {
              setStatusIfChanged(t('status.autoBackupActive'));
              console.log('AutoUpload: showing active status (all backed up, monitoring)');
            } else {
              setStatus(t('status.autoBackupProgress', { current: cumulativeUploaded, total: totalEstimatedCount }));
              console.log('AutoUpload: showing progress message');
            }
          }

          for (const asset of assets) {
            if (uploaded >= maxUploads) {
              logAutoUploadRunnerCondition('asset loop break (max uploads reached mid-page)', { uploaded, maxUploads });
              break;
            }
            if (Date.now() - startedAt >= batchBudgetMs) {
              logAutoUploadRunnerCondition('asset loop break (batch budget exceeded mid-page)', { elapsedMs: Date.now() - startedAt, batchBudgetMs });
              break;
            }
            if (sessionId !== autoUploadNightRunnerSessionIdRef.current) {
              logAutoUploadRunnerCondition('asset loop break (session superseded mid-page)', { sessionId, activeSessionId: autoUploadNightRunnerSessionIdRef.current });
              break;
            }
            if (autoUploadNightRunnerCancelRef.current) {
              logAutoUploadRunnerCondition('asset loop break (cancel requested mid-page)');
              break;
            }
            if (!autoUploadEnabledRef.current) {
              logAutoUploadRunnerCondition('asset loop break (auto upload disabled mid-page)');
              break;
            }
            if (!asset || !asset.id) continue;

            autoUploadNightRunnerHeartbeatMsRef.current = Date.now();

            const assetFilename = formatFilenameForStatus(asset.filename || 'file');
            console.log('AutoUpload: attempting upload for asset:', asset.id, assetFilename);
            const r = await autoUploadStealthCloudUploadOneAsset({
              asset,
              config,
              SERVER_URL,
              existingManifestIds: already,
              alreadyFilenames,
              alreadyBaseNameSizes,
              alreadyBaseNameDates,
              alreadyBaseNameTimestamps,
              alreadyPerceptualHashes,
              alreadyFileHashes,
              fastMode: fastModeEnabledRef.current,
              onStatus: (phase) => {
                if (totalEstimatedCount !== null && !autoUploadNightRunnerCancelRef.current && autoUploadEnabledRef.current) {
                  if (phase === 'encrypting' || phase === 'uploading') {
                    const displayCurrent = Math.min(cumulativeUploaded + 1, totalEstimatedCount);
                    setStatus(t('status.autoBackupProgressFile', { current: displayCurrent, total: totalEstimatedCount, filename: assetFilename }));
                    if (Platform.OS === 'android') {
                      updateBackgroundNotification('Auto Upload', `${assetFilename} (${displayCurrent}/${totalEstimatedCount})`);
                    }
                  }
                }
              }
            });
            if (r && r.uploaded) {
              uploaded += 1;
              cumulativeUploaded += 1;
              if (r.manifestId) already.add(r.manifestId);
              // Update dedup sets with newly uploaded file's hashes to prevent duplicates within same session
              if (r.perceptualHash) alreadyPerceptualHashes.add(r.perceptualHash);
              if (r.fileHash) alreadyFileHashes.add(r.fileHash);
              if (r.filename) alreadyFilenames.add(normalizeFilenameForCompare(r.filename));
              // Update status with current progress (only if not cancelled)
              if (totalEstimatedCount !== null && !autoUploadNightRunnerCancelRef.current && autoUploadEnabledRef.current) {
                const displayCurrent = Math.min(cumulativeUploaded, totalEstimatedCount);
                setStatus(t('status.autoBackupProgressFile', { current: displayCurrent, total: totalEstimatedCount, filename: assetFilename }));
                if (Platform.OS === 'android') {
                  updateBackgroundNotification('Auto Upload', `${assetFilename} (${displayCurrent}/${totalEstimatedCount})`);
                }
              }
              console.log('AutoUpload: successfully uploaded asset:', asset.id, 'cumulative:', cumulativeUploaded);
            } else if (r && r.skipped) {
              skipped += 1;
              // Update status with filename even for skipped files
              if (totalEstimatedCount !== null && !autoUploadNightRunnerCancelRef.current && autoUploadEnabledRef.current) {
                const displayCurrent = Math.min(cumulativeUploaded, totalEstimatedCount);
                setStatus(t('status.autoBackupProgressFile', { current: displayCurrent, total: totalEstimatedCount, filename: assetFilename }));
                if (Platform.OS === 'android') {
                  updateBackgroundNotification('Auto Upload', `${assetFilename} (${displayCurrent}/${totalEstimatedCount})`);
                }
              }
            } else {
              failed += 1;
              console.log('AutoUpload: upload failed for asset:', asset.id);
            }

            // CPU cooldown between assets to reduce CPU pressure and phone heating
            const assetCooldown = getThrottleAssetCooldownMs();
            if (assetCooldown > 0) await sleep(assetCooldown);

            // Memory cleanup: hint GC every 5 assets to prevent memory buildup
            if ((uploaded + skipped + failed) % 5 === 0) {
              try { if (global.gc) global.gc(); } catch (e) { }
            }

            // Thermal batch limit: long cooling pause every N assets
            const batchLimit = getThrottleBatchLimit();
            const batchCooldown = getThrottleBatchCooldownMs();
            if (batchCooldown > 0 && uploaded > 0 && uploaded % batchLimit === 0) {
              setStatusIfChanged(t('status.autoBackupPausing'));
              await sleep(batchCooldown);
              // Force GC during long pause
              try { if (global.gc) global.gc(); } catch (e) { }
            }
          }

          after = page && page.endCursor ? page.endCursor : null;
          try {
            if (after) await SecureStore.setItemAsync(cursorKey, after);
          } catch (e) { }
          if (!page || page.hasNextPage !== true || !after) break;
        }

        try {
          if (!after) {
            await SecureStore.deleteItemAsync(cursorKey);
            // If we completed a full cycle and uploaded nothing, all photos are backed up
            if (uploaded === 0 && totalEstimatedCount !== null) {
              backupCompleted = true;
              setStatusIfChanged(t('status.autoBackupActive'));
              console.log('AutoUpload: full backup cycle complete, all photos backed up, monitoring for new files');
            }
          }
        } catch (e) { }

        try {
          await SecureStore.setItemAsync('auto_upload_last_run', new Date().toISOString());
          await SecureStore.setItemAsync('auto_upload_last_summary', JSON.stringify({ uploaded, skipped, failed }));
          // Save cumulative uploaded count for progress tracking across sessions
          await SecureStore.setItemAsync('auto_upload_cumulative_uploaded', cumulativeUploaded.toString());
        } catch (e) { }

        try {
          const nowSummary = Date.now();
          if (!autoUploadSummaryLogMsRef.current || (nowSummary - autoUploadSummaryLogMsRef.current) > 5000) {
            autoUploadSummaryLogMsRef.current = nowSummary;
            console.log('AutoUpload: batch summary', { uploaded, skipped, failed, pageSize, hasMore: !!after });
          }
        } catch (e) { }

        // Back off if nothing uploaded to save battery
        if (uploaded === 0) {
          await sleep(60000);
        } else {
          await sleep(2000);
        }
      }
    } catch (e) {
      console.log('AutoUpload: runner caught exception', e && e.message ? e.message : e);
    } finally {
      if (sessionId === autoUploadNightRunnerSessionIdRef.current) {
        autoUploadNightRunnerActiveRef.current = false;
      }
      console.log('AutoUpload: exiting night runner session', sessionId);
      // Only set paused status if not completed and not disabled by user
      if (!backupCompleted && autoUploadEnabledRef.current) {
        setStatusIfChanged(t('status.autoBackupPaused'));
      }

      // Stop Android foreground service
      try {
        if (Platform.OS === 'android' && sessionId === autoUploadNightRunnerSessionIdRef.current) {
          void stopAndroidForegroundUploadService();
        }
      } catch (e) { }
      await deactivateKeepAwakeForAutoUpload();

      // Schedule a quick re-check to pick up newly added photos & videos soon after completion
      if (autoUploadEnabledRef.current && serverTypeRef.current === 'stealthcloud' && tokenRef.current) {
        setTimeout(() => {
          try {
            if (!autoUploadNightRunnerActiveRef.current && !autoUploadNightRunnerStartingRef.current) {
              void maybeStartAutoUploadNightSession();
            }
          } catch (e) { }
        }, 15000);
      }
    }
  };

  const fetchStealthCloudUsage = async () => {
    try {
      const config = await getAuthHeaders();
      const base = getServerUrl();
      // Retry once on 5xx / network error
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await axios.get(`${base}/api/cloud/usage`, { ...config, timeout: 10000 });
          return res && res.data ? res.data : null;
        } catch (retryErr) {
          const st = retryErr.response?.status;
          if (st && st >= 500 && attempt < 1) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          throw retryErr;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  const ensureStealthCloudUploadAllowed = async () => {
    const usage = await fetchStealthCloudUsage();
    // If usage fetch failed (server unreachable / 502), allow backup — server will enforce limits
    if (!usage) return true;
    const st = usage && usage.subscription ? usage.subscription : null;
    const status = st && st.status ? String(st.status) : 'none';
    if (status === 'active' || status === 'trial' || status === 'premium_only') return true;

    const purchasedVia = st && st.purchased_via ? st.purchased_via : null;
    const isOtherPlatform = purchasedVia && purchasedVia !== 'solana';
    const platformName = purchasedVia === 'apple' ? 'App Store' : purchasedVia === 'google' ? 'Google Play' : null;

    if (status === 'trial_complimentary') {
      showDarkAlert(
        t('alerts.complimentarySyncTitle'),
        t('alerts.complimentarySyncMessage'),
        [{ text: t('alerts.syncNow'), onPress: () => openSyncModeChooser() }]
      );
      return false;
    }

    if (status === 'premium_trial_complimentary') {
      showDarkAlert(
        t('alerts.complimentarySyncTitle'),
        t('alerts.complimentarySyncMessagePremium'),
        [{ text: t('alerts.syncNow'), onPress: () => openSyncModeChooser() }]
      );
      return false;
    }

    if (status === 'premium_over_capacity') {
      showDarkAlert(
        t('alerts.premiumOnlyTitle'),
        t('alerts.premiumOnlyMessage'),
        [
          { text: t('alerts.syncNow'), onPress: () => openSyncModeChooser() },
          { text: t('alerts.ok') }
        ]
      );
      return false;
    }

    if (status === 'grace') {
      if (isOtherPlatform && platformName) {
        showDarkAlert(
          t('alerts.subscriptionExpired'),
          t('alerts.managedByOtherPlatform', { platform: platformName }),
          [{ text: t('alerts.ok') }]
        );
      } else {
        showDarkAlert(
          t('alerts.subscriptionExpired'),
          t('alerts.graceMessage', { days: GRACE_PERIOD_DAYS }),
          [
            { text: t('alerts.syncNow'), onPress: () => openSyncModeChooser() }
          ]
        );
      }
      return false;
    }

    if (status === 'trial_complimentary_expired') {
      showDarkAlert(
        t('alerts.trialComplimentaryExpiredTitle') || 'Free Trial Ended',
        t('alerts.trialComplimentaryExpiredMessage') || 'Your free trial has ended. Cloud uploads are paused, but all your backed-up data is safe and accessible. You can still browse, download, and mint photo certifications. Choose a plan anytime to resume uploads.',
        [
          { text: t('alerts.viewPlans'), onPress: () => setHomeActiveTab('info') },
          { text: t('alerts.later') }
        ]
      );
      return false;
    }

    if (status === 'grace_expired' || status === 'trial_expired') {
      if (isOtherPlatform && platformName) {
        showDarkAlert(
          t('alerts.accessLocked'),
          t('alerts.managedByOtherPlatform', { platform: platformName }),
          [{ text: t('alerts.ok') }]
        );
      } else {
        showDarkAlert(
          t('alerts.accessLocked'),
          t('alerts.accessLockedMessage'),
          [
            { text: t('alerts.viewPlans'), onPress: () => setHomeActiveTab('info') },
            { text: t('alerts.ok') }
          ]
        );
      }
      return false;
    }

    showDarkAlert(t('alerts.backupDisabled'), t('alerts.backupDisabledMessage'));
    return false;
  };

  useEffect(() => {
    if (!token || view !== 'home' || serverType !== 'stealthcloud') return;
    if (expiredSubscriptionAlertShownRef.current) return;

    expiredSubscriptionAlertShownRef.current = true;
    (async () => {
      try {
        const usage = await fetchStealthCloudUsage();
        const st = usage && usage.subscription ? usage.subscription : null;
        const status = st && st.status ? String(st.status) : 'none';
        if (status === 'premium_only') return;
        if (status === 'premium_trial_complimentary') {
          showDarkAlert(
            t('alerts.complimentarySyncTitle'),
            t('alerts.complimentarySyncMessagePremium'),
            [
              { text: t('alerts.syncNow'), onPress: () => openSyncModeChooser() },
              { text: t('alerts.later') }
            ]
          );
          return;
        }
        if (status === 'premium_over_capacity') {
          showDarkAlert(
            t('alerts.premiumOnlyTitle'),
            t('alerts.premiumOnlyMessage'),
            [
              { text: t('alerts.syncNow'), onPress: () => openSyncModeChooser() },
              { text: t('alerts.later') }
            ]
          );
          return;
        }
        // trial_complimentary_expired gets a gentler message — account stays intact, minting still works
        if (status === 'trial_complimentary_expired') {
          showDarkAlert(
            t('alerts.trialComplimentaryExpiredTitle') || 'Free Trial Ended',
            t('alerts.trialComplimentaryExpiredMessage') || 'Your free trial has ended. Cloud uploads are paused, but all your backed-up data is safe and accessible. You can still browse, download, and mint photo certifications. Choose a plan anytime to resume uploads.',
            [
              { text: t('alerts.viewPlans'), onPress: () => setHomeActiveTab('info') },
              { text: t('alerts.later') }
            ]
          );
          return;
        }

        if (status !== 'grace' && status !== 'grace_expired' && status !== 'trial_expired') return;

        const purchasedVia = st && st.purchased_via ? st.purchased_via : null;
        const isOtherPlatform = purchasedVia && purchasedVia !== 'solana';
        const platformName = purchasedVia === 'apple' ? 'App Store' : purchasedVia === 'google' ? 'Google Play' : null;

        if (isOtherPlatform && platformName) {
          showDarkAlert(
            t('alerts.subscriptionExpired'),
            t('alerts.managedByOtherPlatform', { platform: platformName }),
            [{ text: t('alerts.ok') }]
          );
        } else {
          showDarkAlert(
            t('alerts.subscriptionExpired'),
            t('alerts.expiredGraceMessage', { days: GRACE_PERIOD_DAYS }),
            [
              { text: t('alerts.syncNow'), onPress: () => { setHomeActiveTab('home'); restorePhotos(); } },
              { text: t('alerts.viewPlans'), onPress: () => setHomeActiveTab('info') }
            ]
          );
        }
      } catch (e) {
        // ignore
      }
    })();
  }, [token, view, serverType]);

  // EXIF backfill: upload missing EXIF sidecars for old StealthCloud backups (temporary module)
  useEffect(() => {
    if (!token || view !== 'home' || serverType !== 'stealthcloud' || homeMaintenanceModalBlocked) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled || loadingRef.current || appStateRef.current !== 'active') return;
      const now = Date.now();
      if (lastExifBackfillKickMsRef.current && (now - lastExifBackfillKickMsRef.current) < EXIF_BACKFILL_RESTART_COOLDOWN_MS) return;
      lastExifBackfillKickMsRef.current = now;
      try {
        const config = await getAuthHeaders();
        const SERVER_URL = getServerUrl();
        console.log('[ExifBackfill] Triggering background backfill...');
        runExifBackfill(SERVER_URL, config).catch(e => console.warn('[ExifBackfill] error:', e?.message));
      } catch (e) {
        console.warn('[ExifBackfill] setup error:', e?.message);
      }
    }, HOME_BACKGROUND_TASK_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [token, view, serverType, homeMaintenanceModalBlocked]);

  useEffect(() => {
    if (token && view === 'home' && serverType === 'stealthcloud' && !homeMaintenanceModalBlocked) return;
    cancelExifBackfill();
  }, [token, view, serverType, homeMaintenanceModalBlocked]);

  useEffect(() => {
    const batteryListener = Battery.addBatteryStateListener(async ({ batteryState }) => {
      if (batteryState === Battery.BatteryState.CHARGING) {
        if (autoUploadEnabledRef.current && !autoUploadNightRunnerActiveRef.current && serverTypeRef.current === 'stealthcloud' && tokenRef.current) {
          console.log('Battery plugged in, resuming auto upload');
          setStatusIfChanged(t('status.autoBackupResumed'));
          maybeStartAutoUploadNightSession();
        }
      }
    });
    return () => batteryListener?.remove();
  }, [setStatusIfChanged]);

  // stealthCloudUploadEncryptedChunk is now imported from backupManager.js

  const stealthCloudBackupSelected = async ({ assets }) => {
    const permission = await requestMediaLibraryPermission();
    if (!permission || permission.status !== 'granted') {
      showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededMessage'));
      setLoadingSafe(false);
      setProgressAction(null);
      return;
    }

    // Loading state already set by backupSelectedAssets — no cancelInFlightOperations here
    const opId = currentOperationIdRef.current;
    setBackgroundWarnEligibleSafe(true);

    if (Platform.OS === 'ios') {
      const ap = await getMediaLibraryAccessPrivileges(permission);
      if (ap && ap !== 'all') {
        setStatus(t('status.limitedPhotosAccess'));
      }
    }

    if (!(await ensureAutoUploadPolicyAllowsWork({ userInitiated: true }))) {
      return;
    }

    const list = Array.isArray(assets) ? assets.filter(a => a && a.id) : [];
    if (list.length === 0) {
      showDarkAlert(t('alerts.selectItems'), t('alerts.selectItemsMessage'));
      return;
    }

    startBackgroundService('PhotoLynk Backup', 'Uploading selected photos…');

    try {
      const result = await stealthCloudBackupSelectedCore({
        assets: list,
        getAuthHeaders,
        getServerUrl,
        ensureStealthCloudUploadAllowed,
        // Don't pass ensureAutoUploadPolicyAllowsWorkIfBackgrounded for user-initiated operations
        // This allows the operation to pause when backgrounded and resume when foregrounded
        appStateRef,
        fastMode: fastModeEnabledRef.current,
        onStatus: (s) => setStatusSafe(opId, s),
        onProgress: (p) => setProgressSafe(opId, p),
        abortRef: abortOperationsRef,
      });

      if (result.aborted) {
        return;
      }

      if (result.notAllowed) {
        return;
      }

      if (result.noAssets) {
        showDarkAlert(t('alerts.selectItems'), t('alerts.selectItemsMessage'));
        return;
      }

      const { uploaded, skipped, failed, serverTotal, selectedCount } = result;

      if (uploaded === 0 && skipped === 0 && failed === 0) {
        setProgress(1);
        setStatus(
          Platform.OS === 'ios'
            ? 'No photos visible to the app yet. If you chose "Selected Photos" / Limited access, pick photos or switch to Full Access in iOS Settings.'
            : 'No items processed'
        );
        await sleep(1000);
        setProgress(0);
        return;
      }

      if (uploaded === 0 && skipped > 0 && failed === 0) {
        setProgress(1);
        await sleep(300);
        setStatus(t('status.allFilesBackedUp', { count: skipped }));
        refreshStealthUsage();
        showResultAlert('backup', { uploaded: 0, skipped, failed: 0, serverTotal });
        return;
      }

      setProgress(1);
      await sleep(300);
      setStatus(t('status.backupComplete'));
      refreshStealthUsage();
      showResultAlert('backup', { uploaded, skipped, failed, serverTotal });
    } catch (e) {
      // Auto re-auth on 403 (token was issued by a different server)
      if (e?.response?.status === 403) {
        console.log('[Auth] 403 during StealthCloud backup — attempting token refresh');
        const refresh = await refreshAuthToken();
        if (refresh.success) {
          setStatus(t('status.backupRetrying'));
          try {
            const retryResult = await stealthCloudBackupSelectedCore({
              assets: list, getAuthHeaders, getServerUrl, ensureStealthCloudUploadAllowed,
              appStateRef,
              fastMode: fastModeEnabledRef.current,
              onStatus: (s) => setStatusSafe(opId, s), onProgress: (p) => setProgressSafe(opId, p),
              abortRef: abortOperationsRef,
            });
            if (!retryResult.aborted && !retryResult.notAllowed && !retryResult.noAssets) {
              const { uploaded, skipped, failed, serverTotal, selectedCount } = retryResult;
              if (uploaded === 0 && skipped > 0 && failed === 0) {
                setProgress(1);
                setStatus(t('status.allFilesBackedUp', { count: skipped }));
                showResultAlert('backup', { uploaded: 0, skipped, failed: 0, serverTotal });
                return;
              }
              setProgress(1);
              setStatus(t('status.backupComplete'));
              showResultAlert('backup', { uploaded, skipped, failed, serverTotal });
            }
            return;
          } catch (retryErr) {
            console.error('StealthCloud backup retry failed:', retryErr);
          }
        } else {
          showDarkAlert(t('alerts.sessionExpired'), t('alerts.sessionExpiredRePair'));
        }
      }
      console.error('StealthCloud backup error:', e);
      setStatus(t('status.backupFailed'));
      showResultAlert('backup', { error: e && e.message ? e.message : 'Unknown error' });
    } finally {
      stopBackgroundService();
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setProgress(0);
      setProgressAction(null);
    }
  };

  const backupSelectedAssets = async ({ assets }) => {
    const list = Array.isArray(assets) ? assets.filter(a => a && a.id) : [];
    if (list.length === 0) {
      showDarkAlert(t('alerts.selectItems'), t('alerts.selectItemsMessage'));
      return;
    }

    await cancelInFlightOperations();
    setLoadingSafe(true);
    setBackgroundWarnEligibleSafe(false);
    setWasBackgroundedDuringWorkSafe(false);
    setProgress(0);
    setProgressAction('backup');
    setStatus(t('status.backupPreparing'));

    if (!(await ensureAutoUploadPolicyAllowsWork({ userInitiated: true }))) {
      setLoadingSafe(false);
      setProgressAction(null);
      return;
    }

    if (serverType === 'stealthcloud') {
      return stealthCloudBackupSelected({ assets: list });
    }

    // Enable background warning only after we start actual work (permission already granted inside core)
    setTimeout(() => { if (loadingRef.current) setBackgroundWarnEligibleSafe(true); }, 2000);

    startBackgroundService('PhotoLynk Backup', 'Uploading selected photos…');

    try {
      const result = await localRemoteBackupSelectedCore({
        assets: list,
        getAuthHeaders,
        getServerUrl,
        resolveReadableFilePath,
        appStateRef, // Pass appStateRef so upload can pause when backgrounded
        onStatus: setStatus,
        onProgress: setProgress,
        t,
        abortRef: abortOperationsRef,
      });

      if (result.permissionDenied) {
        showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededMessage'));
        return;
      }

      if (result.noSelection) {
        showDarkAlert(t('alerts.selectItems'), t('alerts.selectItemsMessage'));
        return;
      }

      if (result.aborted) {
        return;
      }

      if (result.alreadyBackedUp) {
        const count = result.selectedCount || list.length;
        setProgress(1); // Show 100% before checkmark
        setStatus(t('status.allFilesBackedUp', { count }));
        await sleep(400); // Brief pause to show 100%
        showResultAlert('backup', { uploaded: 0, skipped: count, failed: 0, serverTotal: count });
        setProgress(0);
        return;
      }

      setProgress(1); // Show 100% before checkmark
      setStatus(t('status.backupComplete'));
      refreshStealthUsage();
      await sleep(400); // Brief pause to show 100%
      showResultAlert('backup', { uploaded: result.uploaded, skipped: result.skipped, failed: result.failed, serverTotal: result.selectedCount || result.serverTotal });
      setProgress(0);
    } catch (error) {
      // Auto re-auth on 403 (token was issued by a different server)
      if (error?.response?.status === 403) {
        console.log('[Auth] 403 during local/remote backup — attempting token refresh');
        const refresh = await refreshAuthToken();
        if (refresh.success) {
          setStatus(t('status.backupRetrying'));
          try {
            const retryResult = await localRemoteBackupSelectedCore({
              assets: list, getAuthHeaders, getServerUrl, resolveReadableFilePath,
              appStateRef, onStatus: setStatus, onProgress: setProgress, t,
              abortRef: abortOperationsRef,
            });
            if (retryResult.aborted) {
              return;
            }
            if (!retryResult.permissionDenied && !retryResult.noSelection) {
              setProgress(1);
              setStatus(t('status.backupComplete'));
              showResultAlert('backup', { uploaded: retryResult.uploaded, skipped: retryResult.skipped, failed: retryResult.failed, serverTotal: retryResult.selectedCount || retryResult.serverTotal });
              setProgress(0);
            }
            return;
          } catch (retryErr) {
            console.error('Local/remote backup retry failed:', retryErr);
          }
        } else {
          showDarkAlert(t('alerts.sessionExpired'), t('alerts.sessionExpiredRePair'));
        }
      }
      setStatus(t('status.backupFailed'));
      showResultAlert('backup', { error: error && error.message ? error.message : 'Unknown error' });
    } finally {
      stopBackgroundService();
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setWasBackgroundedDuringWorkSafe(false);
      setProgressAction(null);
    }
  };

  const setBackgroundWarnEligibleSafe = (value) => {
    backgroundWarnEligibleRef.current = value;
    setBackgroundWarnEligible(value);
    if (!value) { wasBackgroundedDuringWorkRef.current = false; setWasBackgroundedDuringWork(false); backgroundedAtMsRef.current = 0; }
  };

  const purgeStealthCloudData = async () => {
    if (loadingRef.current) return;
    if (!token) {
      setStatus(t('status.idle'));
      return;
    }

    showDarkAlert(
      t('alerts.deleteAllDataTitle'),
      t('alerts.deleteAllDataStealthCloud'),
      [
        { text: t('alerts.cancel') },
        {
          text: t('alerts.delete'),
          onPress: async () => {
            try {
              setLoadingSafe(true);
              setBackgroundWarnEligibleSafe(false);
              setWasBackgroundedDuringWorkSafe(false);
              setStatus(t('status.deleting'));

              // Biometric confirmation — delete all is a dangerous operation
              let bioPassword = null;
              try {
                bioPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, {
                  requireAuthentication: true,
                  authenticationPrompt: t('auth.confirmDeleteAll') || t('auth.unlockToSignIn')
                });
              } catch (bioErr) {
                // Biometric cancelled/failed — abort delete
                console.log('[Purge] Biometric cancelled:', bioErr?.message);
                setStatus(t('status.idle'));
                setLoadingSafe(false);
                return;
              }

              const SERVER_URL = getServerUrl();
              let config = await getAuthHeaders();
              // Re-auth against target server (stored token may be from a different server)
              if (bioPassword) {
                try {
                  const se = await SecureStore.getItemAsync('user_email');
                  if (se) {
                    const did = await getDeviceUUID(se, bioPassword);
                    const lr = await axios.post(`${SERVER_URL}/api/login`, { email: se, password: bioPassword, device_uuid: did, device_name: Platform.OS + ' ' + Platform.Version }, { timeout: 10000 });
                    if (lr.data?.token) config = { headers: { Authorization: `Bearer ${lr.data.token}`, 'X-Device-UUID': did } };
                  }
                } catch (_) { }
              }
              let res;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  res = await axios.post(`${SERVER_URL}/api/cloud/purge`, {}, { ...config, timeout: 30000 });
                  break;
                } catch (retryErr) {
                  const st = retryErr.response?.status;
                  if (st && st >= 500 && attempt < 2) {
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                  }
                  throw retryErr;
                }
              }
              const deleted = res && res.data && res.data.deleted ? res.data.deleted : null;
              const chunks = deleted && typeof deleted.chunks === 'number' ? deleted.chunks : null;
              const manifests = deleted && typeof deleted.manifests === 'number' ? deleted.manifests : null;
              const msg = t('alerts.allFilesDeleted');
              if (chunks !== null || manifests !== null) {
                console.log('[StealthCloud] Purge deleted:', { chunks, manifests });
              }
              setStatus(t('status.cloudDataDeleted'));
              setStealthUsage(prev => prev ? { ...prev, usedBytes: 0, used_bytes: 0 } : prev);
              refreshStealthUsage();
              showDarkAlert(t('alerts.deleted'), msg);
            } catch (e) {
              const m = e && e.response && e.response.data && e.response.data.error
                ? e.response.data.error
                : (e && e.message ? e.message : 'Unknown error');
              setStatus(t('status.deletionFailed'));
              showDarkAlert(t('alerts.error'), m);
            } finally {
              setLoadingSafe(false);
            }
          }
        }
      ]
    );
  };

  const purgeClassicServerData = async () => {
    if (loadingRef.current) return;
    if (!token) {
      setStatus(t('status.idle'));
      return;
    }

    showDarkAlert(
      t('alerts.deleteAllDataTitle'),
      t('alerts.deleteAllDataClassic'),
      [
        { text: t('alerts.cancel') },
        {
          text: t('alerts.delete'),
          onPress: async () => {
            try {
              setLoadingSafe(true);
              setBackgroundWarnEligibleSafe(false);
              setWasBackgroundedDuringWorkSafe(false);
              setStatus(t('status.deleting'));

              // Biometric confirmation — delete all is a dangerous operation
              let bioPassword = null;
              try {
                bioPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, {
                  requireAuthentication: true,
                  authenticationPrompt: t('auth.confirmDeleteAll') || t('auth.unlockToSignIn')
                });
              } catch (bioErr) {
                // Biometric cancelled/failed — abort delete
                console.log('[Purge] Biometric cancelled:', bioErr?.message);
                setStatus(t('status.idle'));
                setLoadingSafe(false);
                return;
              }

              const SERVER_URL = getServerUrl();
              let config = await getAuthHeaders();
              // Re-auth against target server (stored token may be from a different server)
              if (bioPassword) {
                try {
                  const se = await SecureStore.getItemAsync('user_email');
                  if (se) {
                    const did = await getDeviceUUID(se, bioPassword);
                    const lr = await axios.post(`${SERVER_URL}/api/login`, { email: se, password: bioPassword, device_uuid: did, device_name: Platform.OS + ' ' + Platform.Version }, { timeout: 10000 });
                    if (lr.data?.token) config = { headers: { Authorization: `Bearer ${lr.data.token}`, 'X-Device-UUID': did } };
                  }
                } catch (_) { }
              }
              let res;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  res = await axios.post(`${SERVER_URL}/api/files/purge`, {}, { ...config, timeout: 30000 });
                  break;
                } catch (retryErr) {
                  const st = retryErr.response?.status;
                  if (st && st >= 500 && attempt < 2) {
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                  }
                  throw retryErr;
                }
              }
              const deleted = res && res.data && res.data.deleted ? res.data.deleted : null;
              const files = deleted && typeof deleted.files === 'number' ? deleted.files : null;
              if (files !== null) {
                console.log('[Classic] Purge deleted:', { files });
              }
              setStatus(t('status.cloudDataDeleted'));
              showDarkAlert(t('alerts.deleted'), t('alerts.allFilesDeleted'));
            } catch (e) {
              const m = e && e.response && e.response.data && e.response.data.error
                ? e.response.data.error
                : (e && e.message ? e.message : 'Unknown error');
              setStatus(t('status.deletionFailed'));
              showDarkAlert(t('alerts.error'), m);
            } finally {
              setLoadingSafe(false);
            }
          }
        }
      ]
    );
  };

  const setWasBackgroundedDuringWorkSafe = (value) => { wasBackgroundedDuringWorkRef.current = value; setWasBackgroundedDuringWork(value); };

  const resetBackupPickerState = () => { backupPickerDeletedIdsCache = null; setBackupPickerAssets([]); setBackupPickerAfter(null); setBackupPickerHasNext(true); setBackupPickerLoading(false); setBackupPickerTotal(0); setBackupPickerSelected({}); backupPickerSelectedRef.current = {}; backupPickerMetaInFlightRef.current.clear(); backupPickerThumbFixingRef.current.clear(); backupPickerThumbCacheRef.current.clear(); backupPickerScrollingRef.current = false; };
  const openBackupModeChooser = () => { if (loadingRef.current) return; setBackupModeOpen(true); };
  const closeBackupModeChooser = () => setBackupModeOpen(false);

  // --- Backup picker: SINGLE batched flush for all async updates ---
  // All thumb fixes, enrichments, and meta updates write to this pending Map,
  // then a single debounced flush applies them to state in one setBackupPickerAssets call.
  const backupPickerPendingUpdatesRef = useRef(new Map()); // id -> { thumbUri?, fileSize? }
  const backupPickerFlushTimerRef = useRef(null);
  const flushBackupPickerUpdates = useCallback(() => {
    const pending = backupPickerPendingUpdatesRef.current;
    if (pending.size === 0) return;
    const batch = new Map(pending);
    pending.clear();
    setBackupPickerAssets(prev => (prev || []).map(a => {
      if (!a?.id) return a;
      const upd = batch.get(a.id);
      if (!upd) return a;
      let changed = a;
      if (upd.thumbUri) changed = { ...changed, thumbUri: upd.thumbUri };
      if (upd.fileSize) changed = { ...changed, fileSize: upd.fileSize };
      return changed;
    }));
  }, []);
  const scheduleBackupPickerFlush = useCallback(() => {
    if (backupPickerFlushTimerRef.current) clearTimeout(backupPickerFlushTimerRef.current);
    backupPickerFlushTimerRef.current = setTimeout(flushBackupPickerUpdates, 400);
  }, [flushBackupPickerUpdates]);
  const queueBackupPickerUpdate = useCallback((id, updates) => {
    if (!id) return;
    const existing = backupPickerPendingUpdatesRef.current.get(id) || {};
    backupPickerPendingUpdatesRef.current.set(id, { ...existing, ...updates });
    scheduleBackupPickerFlush();
  }, [scheduleBackupPickerFlush]);

  const fixBackupPickerThumbnail = useCallback(async (asset) => {
    try {
      if (!asset?.id) return;
      const attempts = Number(backupPickerThumbFixingRef.current.get(asset.id) || 0);
      if (attempts >= 2) return;
      backupPickerThumbFixingRef.current.set(asset.id, attempts + 1);

      const ext = (asset.filename || '').split('.').pop()?.toLowerCase();
      const isVideo = asset.mediaType === 'video' || ['mov', 'mp4', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext);

      const info = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true });
      const sourceUri = info?.localUri || info?.uri || asset?.uri || asset?.thumbUri;
      let thumbUri = sourceUri || null;

      if (isVideo) return; else if (Platform.OS === 'android' && asset.mediaType === 'photo') {
        try {
          const shouldForceThumb = !!(sourceUri && typeof sourceUri === 'string' && sourceUri.startsWith('content://'));
          if (sourceUri && (shouldForceThumb || ext === 'heic' || ext === 'heif' || ext === 'avif')) {
            const manipResult = await ImageManipulator.manipulateAsync(
              sourceUri,
              [{ resize: { width: 200 } }],
              { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
            );
            if (manipResult?.uri) thumbUri = manipResult.uri;
          }
        } catch (e) { }
      }

      const isContentUri = Platform.OS === 'android' && typeof thumbUri === 'string' && thumbUri.startsWith('content://');
      if (thumbUri && !isContentUri) {
        backupPickerThumbCacheRef.current.set(asset.id, thumbUri);
        if (backupPickerThumbCacheRef.current.size > 800) {
          const firstKey = backupPickerThumbCacheRef.current.keys().next().value;
          if (firstKey) backupPickerThumbCacheRef.current.delete(firstKey);
        }
        if (thumbUri !== asset?.thumbUri) {
          queueBackupPickerUpdate(asset.id, { thumbUri });
        }
      }
    } catch (e) { }
  }, [queueBackupPickerUpdate]);

  const warmBackupPickerDeletedIds = async () => {
    if (Platform.OS !== 'android' || backupPickerDeletedIdsCache) return;
    try {
      const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
      const deletedAlbum = albums.find(a => a.title === 'PhotoLynkDeleted');
      if (deletedAlbum) {
        const ids = new Set();
        let dAfter = null;
        while (true) {
          const dPage = await MediaLibrary.getAssetsAsync({ album: deletedAlbum, first: 500, after: dAfter || undefined, mediaType: ['photo', 'video'] });
          if (dPage?.assets) for (const a of dPage.assets) ids.add(a.id);
          dAfter = dPage?.endCursor;
          if (!dPage?.hasNextPage || !dPage?.assets?.length) break;
        }
        backupPickerDeletedIdsCache = ids;
      } else {
        backupPickerDeletedIdsCache = new Set();
      }
    } catch (e) { backupPickerDeletedIdsCache = new Set(); }
  };

  const loadBackupPickerPage = async ({ reset }) => {
    if (backupPickerLoading) return;
    if (!reset && !backupPickerHasNext) return;
    setBackupPickerLoading(true);
    try {
      const permission = await requestMediaLibraryPermission();
      if (permission.status !== 'granted') { showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededMessage')); return; }

      if (!backupPickerDeletedIdsCache) backupPickerDeletedIdsCache = new Set();

      let currentAfter = reset ? null : backupPickerAfter;
      let fetchedAssets = [];
      let hasNext = true;
      let deferredTotal = null;

      // Loop until we have at least 18 items to avoid triggering rapid onEndReached calls
      while (fetchedAssets.length < 18 && hasNext) {
        const page = await MediaLibrary.getAssetsAsync({ first: 18, after: currentAfter || undefined, mediaType: ['photo', 'video'], sortBy: [MediaLibrary.SortBy.creationTime] });
        if (!page || !Array.isArray(page.assets) || page.assets.length === 0) {
          hasNext = false;
          break;
        }

        if (deferredTotal === null && typeof page.totalCount === 'number') {
          deferredTotal = Math.max(0, Number(page.totalCount) - backupPickerDeletedIdsCache.size) || 0;
        }

        let batch = page.assets;
        if (Platform.OS === 'android') {
          batch = batch.filter(a => {
            if (backupPickerDeletedIdsCache.has(a.id)) return false;
            const uri = a?.uri || '';
            const localUri = a?.localUri || '';
            if (uri.includes('/PhotoLynkDeleted/') || localUri.includes('/PhotoLynkDeleted/')) return false;
            return true;
          });
        }
        fetchedAssets.push(...batch);
        currentAfter = page.endCursor;
        hasNext = !!page.hasNextPage;
      }

      const assets = fetchedAssets;
      if (deferredTotal === null && reset) {
        deferredTotal = assets.length;
      }

      // Show assets immediately without blocking UI
      const resolvedAssets = assets.map(a => {
        if (!a || !a.id) return { ...a, thumbUri: null };
        const cached = backupPickerThumbCacheRef.current.get(a.id);
        const thumbUri = cached || a.uri || null;
        return { ...a, thumbUri };
      });

      ReactNative.unstable_batchedUpdates(() => {
        if (deferredTotal !== null) setBackupPickerTotal(deferredTotal);
        setBackupPickerAssets(prev => reset ? resolvedAssets : prev.concat(resolvedAssets));
        setBackupPickerAfter(currentAfter);
        setBackupPickerHasNext(hasNext);
        setBackupPickerLoading(false);
      });

      // Async background enrichment (Android content:// thumb fix & StealthCloud file size)
      const ENRICH_BATCH = 4;
      (async () => {
        try {
          for (let i = 0; i < assets.length; i += ENRICH_BATCH) {
            if (!backupPickerOpenRef.current) break;
            await waitWhileBackupPickerScrolling();
            const batch = assets.slice(i, i + ENRICH_BATCH);
            await Promise.all(batch.map(async (asset) => {
              try {
                if (!asset?.id) return;
                let updates = {};

                if (Platform.OS === 'android') {
                  const cached = backupPickerThumbCacheRef.current.get(asset.id);
                  const isContent = !cached && asset.uri && asset.uri.startsWith('content://');
                  if (isContent || (!cached && asset.mediaType === 'video')) {
                    const info = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: false }).catch(() => null);
                    let newThumb = info?.localUri || info?.uri || asset.uri;
                    const ext = (asset.filename || '').split('.').pop()?.toLowerCase();
                    const isHeic = ext === 'heic' || ext === 'heif' || ext === 'avif';
                    if ((isHeic || (newThumb && newThumb.startsWith('content://'))) && asset.mediaType === 'photo') {
                      const manip = await ImageManipulator.manipulateAsync(newThumb, [{ resize: { width: 200 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }).catch(() => null);
                      if (manip?.uri) newThumb = manip.uri;
                    } else if (asset.mediaType === 'video' && newThumb) {
                      const frame = await VideoThumbnails.getThumbnailAsync(newThumb, { time: 0 }).catch(() => null);
                      if (frame?.uri) newThumb = frame.uri;
                    }
                    if (newThumb && newThumb !== asset.uri && newThumb !== asset.thumbUri) {
                      backupPickerThumbCacheRef.current.set(asset.id, newThumb);
                      updates.thumbUri = newThumb;
                    }
                  }
                }

                if (serverType === 'stealthcloud' && !(typeof asset.fileSize === 'number' && asset.fileSize > 0)) {
                  if (!backupPickerMetaInFlightRef.current.has(String(asset.id))) {
                    backupPickerMetaInFlightRef.current.add(String(asset.id));
                    const info = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: false }).catch(() => null);
                    let fs = info && typeof info.fileSize === 'number' ? Number(info.fileSize) : null;
                    if ((!fs || fs <= 0) && info) {
                      const uri = info.localUri || info.uri || asset.uri || null;
                      if (uri) {
                        const fi = await FileSystem.getInfoAsync(uri).catch(() => null);
                        if (fi && typeof fi.size === 'number' && fi.size > 0) fs = fi.size;
                      }
                    }
                    if (fs && fs > 0) updates.fileSize = fs;
                  }
                }

                if (Object.keys(updates).length > 0) {
                  queueBackupPickerUpdate(asset.id, updates);
                }
              } catch (e) { }
            }));
          }
        } catch (e) { }
      })();

      if (backupPickerThumbCacheRef.current.size > 800) {
        const firstKey = backupPickerThumbCacheRef.current.keys().next().value;
        if (firstKey) backupPickerThumbCacheRef.current.delete(firstKey);
      }
    } catch (e) {
      setBackupPickerLoading(false);
    }
  };

  const openBackupPicker = async () => { if (loadingRef.current) return; resetBackupPickerState(); setBackupPickerPreview(null); backupPickerOpenRef.current = true; setBackupPickerOpen(true); setBackupPickerLoading(true); await warmBackupPickerDeletedIds(); await loadBackupPickerPage({ reset: true }); };
  const closeBackupPicker = () => { backupPickerOpenRef.current = false; setBackupPickerOpen(false); setBackupPickerPreview(null); resetBackupPickerState(); if (backupPickerFlushTimerRef.current) { clearTimeout(backupPickerFlushTimerRef.current); backupPickerFlushTimerRef.current = null; } backupPickerPendingUpdatesRef.current.clear(); };

  const ensureBackupPickerAssetMeta = useCallback(async (asset) => {
    try {
      if (serverType !== 'stealthcloud') return;
      const id = asset && asset.id ? String(asset.id) : '';
      if (!id) return;
      if (asset && typeof asset.fileSize === 'number' && asset.fileSize > 0) return;
      if (backupPickerMetaInFlightRef.current.has(id)) return;
      backupPickerMetaInFlightRef.current.add(id);
      await backupPickerMetaLimiterRef.current(async () => {
        try {
          const info = await MediaLibrary.getAssetInfoAsync(id, { shouldDownloadFromNetwork: true });
          let fileSize = info && typeof info.fileSize === 'number' ? Number(info.fileSize) : null;
          if ((!fileSize || fileSize <= 0) && info) {
            const uri = info.localUri || info.uri || (asset && asset.uri) || null;
            if (uri) {
              try {
                const fsInfo = await FileSystem.getInfoAsync(uri);
                const sz = fsInfo && typeof fsInfo.size === 'number' ? Number(fsInfo.size) : null;
                if (sz && sz > 0) fileSize = sz;
              } catch (e) { }
            }
          }
          if (fileSize && fileSize > 0) {
            queueBackupPickerUpdate(id, { fileSize });
          }
        } catch (e) {
        }
      });
    } catch (e) { }
  }, [serverType, queueBackupPickerUpdate]);

  const onBackupPickerViewableItemsChangedRef = useRef(null);
  onBackupPickerViewableItemsChangedRef.current = ({ viewableItems }) => {
    if (serverType !== 'stealthcloud') return;
    try {
      const vis = Array.isArray(viewableItems) ? viewableItems : [];
      for (const v of vis) {
        const a = v && v.item ? v.item : null;
        if (a && a.id) ensureBackupPickerAssetMeta(a);
      }
    } catch (e) { }
  };
  const onBackupPickerViewableItemsChanged = useRef(({ viewableItems }) => {
    if (onBackupPickerViewableItemsChangedRef.current) {
      onBackupPickerViewableItemsChangedRef.current({ viewableItems });
    }
  });

  const toggleBackupPickerSelected = useCallback((assetId) => {
    if (!assetId) return;
    setBackupPickerSelected(prev => { const next = { ...prev }; if (next[assetId]) delete next[assetId]; else next[assetId] = true; backupPickerSelectedRef.current = next; return next; });
  }, []);

  const onBackupPickerScrollBegin = useCallback(() => { backupPickerScrollingRef.current = true; }, []);
  const onBackupPickerScrollEnd = useCallback(() => { backupPickerScrollingRef.current = false; }, []);
  const waitWhileBackupPickerScrolling = () => new Promise(resolve => {
    const check = () => { if (!backupPickerScrollingRef.current) return resolve(); setTimeout(check, 80); };
    check();
  });

  const backupPickerKeyExtractor = useCallback((a, idx) => `${a?.id}-${idx}`, []);

  const backupPickerGridNumCols = isTablet ? 4 : 3;
  const backupPickerGridContainerPad = scaleSpacing(10);
  const backupPickerGridItemFraction = isTablet ? 0.24 : 0.32;
  const backupPickerGridItemHeight = (SCREEN_WIDTH - 2 * backupPickerGridContainerPad) * backupPickerGridItemFraction + scaleSpacing(8);
  const getBackupPickerGridItemLayout = useCallback((data, index) => ({
    length: backupPickerGridItemHeight,
    offset: backupPickerGridItemHeight * Math.floor(index / backupPickerGridNumCols),
    index,
  }), []);

  const backupPickerListRowHeight = (isTablet ? 56 : 44) + scaleSpacing(12) * 2 + scaleSpacing(10);
  const getBackupPickerListItemLayout = useCallback((data, index) => ({
    length: backupPickerListRowHeight,
    offset: backupPickerListRowHeight * index,
    index,
  }), []);

  const renderBackupPickerListItem = useCallback(({ item: a, index: idx }) => {
    const id = a && a.id ? String(a.id) : '';
    if (!id) return null;
    const selected = !!(backupPickerSelectedRef.current && backupPickerSelectedRef.current[id]);
    const displayName = a && a.filename ? a.filename : id;
    const rawSize = a && typeof a.fileSize === 'number' ? a.fileSize : null;
    const fileSize = rawSize !== null && rawSize > 0 ? rawSize : null;
    const ext = (displayName || '').split('.').pop()?.toLowerCase() || '';
    const isVideo = a && (a.mediaType === 'video' || ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext));
    const isImage = a && (a.mediaType === 'photo' || ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'orf', 'rw2', 'pef', 'srw', 'raf', 'psd', 'psb', 'exr', 'hdr', 'avif'].includes(ext));
    const fileIcon = isVideo ? '🎬' : isImage ? '🖼️' : '📄';
    const thumbUri = (a && (a.thumbUri || a.uri)) ? (a.thumbUri || a.uri) : null;
    return (
      <TouchableOpacity
        key={`${id}-${idx}`}
        style={[styles.syncPickerRow, selected && { borderColor: THEME.accent }]}
        onPress={() => toggleBackupPickerSelected(id)}>
        <TouchableOpacity
          style={{ width: isTablet ? 56 : 44, height: isTablet ? 56 : 44, borderRadius: scaleSpacing(6), marginRight: scaleSpacing(10), backgroundColor: isVideo ? '#1a1a2e' : '#1e3a2e', alignItems: 'center', justifyContent: 'center' }}
          onPress={(e) => {
            e.stopPropagation();
            if (thumbUri) {
              setBackupPickerPreview({ uri: thumbUri, filename: displayName });
            }
          }}
          disabled={!thumbUri}
          activeOpacity={thumbUri ? 0.7 : 1}>
          {thumbUri ? (
            <Image
              source={{ uri: thumbUri }}
              style={{ width: '100%', height: '100%', borderRadius: scaleSpacing(6) }}
              onError={() => fixBackupPickerThumbnail(a)}
            />
          ) : (
            <Text style={{ fontSize: scale(22) }}>{fileIcon}</Text>
          )}
        </TouchableOpacity>
        <View style={[styles.syncPickerRowLeft, { flex: 1 }]}>
          <Text style={styles.syncPickerRowTitle} numberOfLines={1} ellipsizeMode="middle">{displayName}</Text>
          {fileSize !== null && (
            <Text style={styles.syncPickerRowMeta}>{formatBytesHuman(fileSize)}</Text>
          )}
        </View>
        <View style={[styles.syncPickerCheck, selected && { backgroundColor: 'rgba(3, 225, 255, 0.92)', borderColor: 'rgba(3, 225, 255, 0.92)' }]}>
          <Text style={[styles.syncPickerCheckText, selected && styles.syncPickerCheckTextOn]}>{selected ? '✓' : ''}</Text>
        </View>
      </TouchableOpacity>
    );
  }, [toggleBackupPickerSelected, fixBackupPickerThumbnail]);

  const renderBackupPickerGridItem = useCallback(({ item: a, index: idx }) => {
    const selected = !!(backupPickerSelectedRef.current && a && backupPickerSelectedRef.current[a.id]);
    return (
      <TouchableOpacity
        style={[styles.pickerItem, selected && styles.pickerItemSelected]}
        onPress={() => toggleBackupPickerSelected(a.id)}>
        <View style={[styles.pickerThumb, { backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center' }]}>
          {(a.thumbUri || a.uri) && (
            <Image
              source={{ uri: a.thumbUri || a.uri }}
              style={[styles.pickerThumb, { position: 'absolute', top: 0, left: 0 }]}
              onError={() => fixBackupPickerThumbnail(a)}
            />
          )}
          <Text style={{ color: '#444', fontSize: 10, textAlign: 'center' }}>{a.mediaType === 'video' ? '🎬' : '📷'}</Text>
        </View>
        {a.mediaType === 'video' && (
          <View style={styles.pickerBadge}>
            <Text style={styles.pickerBadgeText}>{t('picker.video')}</Text>
          </View>
        )}
        {selected && (
          <View style={styles.pickerCheck}>
            <Text style={styles.pickerCheckText}>✓</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }, [toggleBackupPickerSelected, fixBackupPickerThumbnail]);

  const getSelectedPickerAssets = () => {
    const selectedIds = backupPickerSelected && typeof backupPickerSelected === 'object' ? Object.keys(backupPickerSelected).filter(k => backupPickerSelected[k]) : [];
    if (selectedIds.length === 0) return [];
    const setIds = new Set(selectedIds);
    return (backupPickerAssets || []).filter(a => a && a.id && setIds.has(a.id));
  };

  const resetSyncPickerState = () => { setSyncPickerItems([]); setSyncPickerTotal(0); setSyncPickerOffset(0); setSyncPickerLoading(false); setSyncPickerLoadingMore(false); setSyncPickerSelected({}); setSyncPickerAuthHeaders(null); syncPickerLocalFilenamesRef.current = null; syncPickerMasterKeyRef.current = null; syncPickerLegacyKeyRef.current = null; syncPickerThumbCacheRef.current = new Map(); syncPickerThumbInFlightRef.current = new Set(); };
  const openSyncModeChooser = () => { if (loadingRef.current) return; setSyncModeOpen(true); };
  const closeSyncModeChooser = () => setSyncModeOpen(false);
  const openCleanupModeChooser = () => { if (loadingRef.current) return; setCleanupModeOpen(true); };
  const closeCleanupModeChooser = () => setCleanupModeOpen(false);
  const closeSimilarReview = () => { setSimilarReviewOpen(false); setSimilarGroups([]); setSimilarGroupIndex(0); setSimilarSelected({}); setSimilarPhotoIndex(0); setSimilarDeletedTotal(0); similarDeletedTotalRef.current = 0; };

  const buildDefaultSimilarSelection = (group) => {
    const items = Array.isArray(group) ? group : [];
    const next = {};
    for (let i = 1; i < items.length; i++) { const id = items[i] && items[i].id ? String(items[i].id) : ''; if (id) next[id] = true; }
    return next;
  };

  const openSimilarGroup = ({ groups, index }) => {
    const g = Array.isArray(groups) ? groups : [];
    const i = typeof index === 'number' ? index : 0;
    setSimilarGroups(g); setSimilarGroupIndex(i); setSimilarSelected(buildDefaultSimilarSelection(g[i] || [])); setSimilarPhotoIndex(0); setSimilarReviewOpen(true);
  };

  const toggleSimilarSelected = (assetId) => {
    const key = assetId ? String(assetId) : '';
    if (!key) return;
    setSimilarSelected(prev => { const next = { ...(prev || {}) }; if (next[key]) delete next[key]; else next[key] = true; return next; });
  };

  const ensureSimilarThumb = useCallback(async (asset) => {
    try {
      if (!asset?.id) return;
      const id = String(asset.id);
      const cached = similarThumbCacheRef.current.get(id);
      if (cached) return;
      if (similarThumbInFlightRef.current.has(id)) return;

      similarThumbInFlightRef.current.add(id);

      await similarThumbLimiterRef.current(async () => {
        try {
          const info = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true });
          const ext = String(asset?.filename || info?.filename || '').split('.').pop()?.toLowerCase();
          const sourceUri = info?.localUri || info?.uri || asset?.thumbUri || asset?.uri || null;
          let thumbUri = sourceUri;

          if (Platform.OS === 'android') {
            const needsThumb = !!(typeof sourceUri === 'string' && (sourceUri.startsWith('content://') || ext === 'heic' || ext === 'heif' || ext === 'avif'));
            if (needsThumb && sourceUri) {
              try {
                const manipResult = await ImageManipulator.manipulateAsync(
                  sourceUri,
                  [{ resize: { width: 200 } }],
                  { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
                );
                if (manipResult?.uri) thumbUri = manipResult.uri;
              } catch (e) { }
            }
          }

          if (thumbUri) {
            similarThumbCacheRef.current.set(id, thumbUri);
            setSimilarGroups(prev => (Array.isArray(prev) ? prev.map(g => (Array.isArray(g) ? g.map(a => {
              if (!a || String(a.id) !== id) return a;
              return a.thumbUri === thumbUri ? a : { ...a, thumbUri };
            }) : g)) : prev));
          }
        } finally {
          similarThumbInFlightRef.current.delete(id);
        }
      });
    } catch (e) {
      try { if (asset?.id) similarThumbInFlightRef.current.delete(String(asset.id)); } catch (e2) { }
    }
  }, []);

  const getSimilarSelectedIds = () => {
    const sel = similarSelected && typeof similarSelected === 'object' ? similarSelected : {};
    return Object.keys(sel).filter(k => sel[k]);
  };

  useEffect(() => {
    if (!similarReviewOpen) return;
    if (Platform.OS !== 'android') return;
    const g = Array.isArray(similarGroups) ? similarGroups : [];
    const group = g[similarGroupIndex] || [];
    if (!Array.isArray(group) || group.length === 0) return;
    setTimeout(() => {
      try {
        for (const a of group) {
          void ensureSimilarThumb(a);
        }
      } catch (e) { }
    }, 0);
  }, [similarReviewOpen, similarGroupIndex, similarGroups, ensureSimilarThumb]);

  const advanceSimilarGroup = ({ groups, nextIndex, deletedCount = 0 }) => {
    const g = Array.isArray(groups) ? groups : [];
    const i = typeof nextIndex === 'number' ? nextIndex : 0;
    if (i >= g.length) {
      // Use ref for accurate cumulative total (state is stale in async handlers)
      const totalDeleted = deletedCount || similarDeletedTotalRef.current;
      closeSimilarReview();
      setStatus(t('status.cleanupComplete'));
      showCompletionTickBriefly(t('results.filesDeleted', { count: totalDeleted }));
      return;
    }
    openSimilarGroup({ groups: g, index: i });
  };

  // ============================================================================
  // NFT FUNCTIONS
  // ============================================================================

  const openNftPicker = async () => { if (nftMinting) return; setNftPickerOpen(true); };

  const closeNftPicker = () => {
    setNftPickerOpen(false);
  };

  const openNftGallery = () => {
    setNftGalleryOpen(true);
  };

  const closeNftGallery = () => {
    setNftGalleryOpen(false);
  };

  const handleNftTransfer = (nft) => {
    setNftToTransfer(nft);
    setNftTransferOpen(true);
  };

  const closeNftTransfer = () => {
    setNftTransferOpen(false);
    setNftToTransfer(null);
  };

  const handleNftTransferComplete = async (result) => {
    const transferredNft = nftToTransfer;
    closeNftTransfer();
    showCompletionTickBriefly(t('results.nftTransferred'));
    // Transfer certificate first (before NFT removal) so encryptionData is still accessible for nftKey unwrap
    if (transferredNft?.mintAddress) {
      const mintAddrStored = transferredNft.mintAddress;
      const mintAddrStripped = (mintAddrStored || '').replace('cnft_', '');
      // Transfer cert to new owner (sends full cert with RFC3161 token to server, then removes locally)
      const recipientAddr = result?.recipientAddress || '';
      let authHeaders = null;
      try { const ac = await getAuthHeaders(); authHeaders = ac?.headers || ac; } catch (_) { }
      const serverUrl = getServerUrl();
      if (recipientAddr && serverUrl && authHeaders) {
        try {
          let mk = null;
          try { mk = await getStealthCloudMasterKey(); } catch (_) { }
          const remintedNewMintAddress = result?.newAssetId ? `cnft_${String(result.newAssetId).replace(/^cnft_/, '')}` : null;
          const r = await NFTOperations.transferCertificateForMint(mintAddrStored, recipientAddr, serverUrl, authHeaders, mk, remintedNewMintAddress);
          console.log('[Transfer] Cert transfer result:', r);
        } catch (e) { console.warn('[Transfer] Cert transfer error:', e.message); }
      } else {
        // Fallback: just remove cert locally if no recipient or no auth
        try {
          await NFTOperations.removeCertificateByMint(mintAddrStored);
          if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
            await NFTOperations.removeCertificateByMint(mintAddrStripped);
          }
          console.log('[Transfer] Removed cert from storage (no recipient):', mintAddrStored);
        } catch (e) {
          console.log('[Transfer] Cert removal error:', e.message);
        }
      }
      // Now remove the NFT from local storage (after cert transfer so encryptionData was still accessible)
      try {
        await addToTransferredOutBlacklist(mintAddrStored);
        if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
          await addToTransferredOutBlacklist(mintAddrStripped);
        }
        await NFTOperations.removeNFTFromStorage(mintAddrStored);
        if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
          await NFTOperations.removeNFTFromStorage(mintAddrStripped);
        }
        console.log('[Transfer] Removed NFT from storage:', mintAddrStored);
      } catch (e) {
        console.log('[Transfer] NFT removal error:', e.message);
      }
      // Also remove from server NFT sync — await so gallery refresh sees updated state
      if (serverUrl && authHeaders) {
        try {
          await fetch(`${serverUrl}/api/nft/sync`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({
              action: 'remove',
              mintAddress: mintAddrStored,
              ownerAddress: transferredNft?.ownerAddress || '',
            }),
          });
        } catch (_) { }
        const walletAddress = transferredNft?.ownerAddress || '';
        if (walletAddress) {
          try { await NFTOperations.syncNFTsFromServer(serverUrl, authHeaders, walletAddress); } catch (_) { }
          try { await NFTOperations.removeTransferredNFTs(walletAddress, serverUrl, authHeaders); } catch (_) { }
          try { await NFTOperations.backupNFTsToServer(serverUrl, authHeaders, walletAddress); } catch (_) { }
        }
      }
    }
    // Trigger gallery refresh so transferred NFT disappears immediately
    if (nftGalleryOpen) {
      setNftGalleryRefreshKey(k => (k || 0) + 1);
    }
  };

  const normalizeNftMintError = (error) => {
    const raw = String(error?.message || error || '').trim();
    const lower = raw.toLowerCase();
    if (
      lower.includes('timed out waiting for response') ||
      lower.includes('timeoutexception') ||
      lower.includes('mobilewalletadapter') ||
      lower.includes('user cancelled') ||
      lower.includes('user canceled') ||
      lower.includes('user rejected') ||
      lower.includes('cancelled') ||
      lower.includes('canceled')
    ) {
      return 'NFT certification was not confirmed in your wallet. Please approve the wallet transaction before it times out, or try again.';
    }
    if (lower.includes('blockhash not found') || lower.includes('transaction expired')) {
      return 'The Solana network took too long to confirm this transaction. No NFT was certified. Please try again.';
    }
    if (lower.includes('network request failed') || lower.includes('failed to fetch')) {
      return 'Network connection was interrupted while preparing the NFT certification. Please check your connection and try again.';
    }
    return raw || t('alerts.error');
  };

  const handleMintNFT = async ({ asset, filePath, name, description, stripExif, storageOption, nftType, serverConfig, costEstimate: passedCostEstimate, edition, license, watermark, encrypt, certificationMode, paymentMethod = NFTOperations.NFT_PAYMENT_METHODS.SOL, weeklyDiscountQuote = null }) => {
    if (!asset || !filePath) {
      showDarkAlert(t('alerts.error'), t('alerts.selectItemsMessage'));
      return;
    }

    const shouldUseGlobalProgress = !loadingRef.current;
    setNftMinting(true);
    if (shouldUseGlobalProgress) {
      setLoadingSafe(true);
      setStatus(t('status.nftPreparing'));
      setProgress(0);
      setProgressAction('nft');
    }

    try {
      // Initialize NFT module
      await NFTOperations.initializeNFT();

      // Use the cost estimate passed from NFTPhotoPicker (already calculated with correct file size)
      const useCloud = storageOption === 'cloud';
      const useCompressed = nftType === 'compressed';
      let fileSize = 0;
      try { fileSize = (await FileSystem.getInfoAsync(filePath)).size || 0; } catch (_) { }
      const normalizedPaymentMethod = paymentMethod || NFTOperations.NFT_PAYMENT_METHODS.SOL;
      const expectedDiscountPercent = Math.min(80, Math.max(0, Number(weeklyDiscountQuote?.discountPercent || 0)));
      const passedDiscountPercent = Math.min(80, Math.max(0, Number(passedCostEstimate?.payment?.commission?.discount?.discountPercent || 0)));
      const estimateMatchesPayment = passedCostEstimate?.payment?.method === normalizedPaymentMethod && (
        normalizedPaymentMethod !== NFTOperations.NFT_PAYMENT_METHODS.SKR || passedDiscountPercent === expectedDiscountPercent
      );
      const costEstimate = estimateMatchesPayment ? passedCostEstimate : await NFTOperations.estimateNFTMintCost(
        fileSize || (500 * 1024),
        storageOption,
        useCompressed,
        edition || 'open',
        normalizedPaymentMethod,
        nftEffectiveDiscountQuote
      );

      // Check if connected wallet is the fee wallet (fee wallet doesn't pay PhotoLynk fees)
      let isFeeWallet = false;
      try {
        const walletStatus = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
        isFeeWallet = walletStatus?.address === NFTOperations.NFT_COMMISSION_WALLET;
      } catch (_) { }

      const breakdown = costEstimate.breakdown;
      const standardTotalSol = Number(costEstimate?.total?.sol || 0);
      const standardTotalUsd = Number(costEstimate?.total?.usd || 0);
      const appCommissionSol = Number(breakdown?.appCommission?.sol || 0);
      const appCommissionUsd = Number(breakdown?.appCommission?.usd || 0);
      const waivedCommissionSol = Math.max(0, standardTotalSol - appCommissionSol);
      const waivedCommissionUsd = Math.max(0, standardTotalUsd - appCommissionUsd);
      const paymentQuote = costEstimate?.payment || null;
      const isSkrPayment = paymentMethod === NFTOperations.NFT_PAYMENT_METHODS.SKR;
      const hasNftFeeBenefit = !!nftIsPremium || !!subscriptionStatus?.isPremium;
      const isPremiumFreeMint = hasNftFeeBenefit && nftFreeMintsRemaining > 0;
      const isPremiumBeyond100 = hasNftFeeBenefit && !isPremiumFreeMint;
      const isLegacySubscription = !!subscriptionStatus?.isActive && isLegacySubscriber;
      const isMonthlySubscriber = nftHasPaidStoragePlan && !hasNftFeeBenefit && !isLegacySubscription;
      if (shouldUseGlobalProgress) {
        setStatus('Choose wallet to approve payment...');
        setProgress(0.08);
      }
      const selectedWallet = await NFTOperations.getConnectedWalletAddress();
      if (!selectedWallet.success) {
        setNftMinting(false);
        if (shouldUseGlobalProgress) {
          setLoadingSafe(false);
          setStatus(t('status.idle'));
          setProgress(0);
          setProgressAction(null);
        }
        return;
      }
      isFeeWallet = selectedWallet.address === NFTOperations.NFT_COMMISSION_WALLET;
      const regularPriceDisplay = `~${costEstimate.total.usdFormatted} (${costEstimate.total.solFormatted} SOL)`;
      const payablePriceDisplay = `~$${waivedCommissionUsd.toFixed(2)} (${waivedCommissionSol.toFixed(6)} SOL)`;
      const monthlyDiscountedCommissionSol = Math.round(appCommissionSol * 20) / 100; // 80% off commission
      const monthlyDiscountedCommissionUsd = Math.round(appCommissionUsd * 20) / 100;
      const monthlyDiscountedTotalSol = waivedCommissionSol + monthlyDiscountedCommissionSol;
      const monthlyDiscountedTotalUsd = waivedCommissionUsd + monthlyDiscountedCommissionUsd;
      const monthlySavingsSol = appCommissionSol - monthlyDiscountedCommissionSol;
      const monthlySavingsUsd = appCommissionUsd - monthlyDiscountedCommissionUsd;
      const savingsSol = isPremiumFreeMint ? standardTotalSol : (isPremiumBeyond100 || isFeeWallet || isLegacySubscription) ? appCommissionSol : isMonthlySubscriber ? monthlySavingsSol : 0;
      const savingsUsd = isPremiumFreeMint ? standardTotalUsd : (isPremiumBeyond100 || isFeeWallet || isLegacySubscription) ? appCommissionUsd : isMonthlySubscriber ? monthlySavingsUsd : 0;
      const savingsDisplay = `~$${savingsUsd.toFixed(2)} (${savingsSol.toFixed(6)} SOL)`;
      const confirmLines = [];
      if (isPremiumFreeMint) {
        confirmLines.push(t('nftMint.premiumFreeTierInfo', { count: nftFreeMintLimit || 100 }));
        confirmLines.push(`${t('nftMint.regularPriceToday')}: ${regularPriceDisplay}`);
        confirmLines.push(`${t('nftMint.youSave')}: ${savingsDisplay}`);
        confirmLines.push(`${t('nftMint.youPayNow')}: $0.00`);
      } else if (isFeeWallet) {
        confirmLines.push(`${t('nftMint.regularPriceToday')}: ${regularPriceDisplay}`);
        confirmLines.push(`${t('nftMint.youSave')}: ${savingsDisplay}`);
        confirmLines.push(`${t('nftMint.youPayNow')}: ${payablePriceDisplay}`);
        confirmLines.push(t('nftMint.networkFeesMayVary'));
      } else if (isLegacySubscription) {
        confirmLines.push(`${t('nftMint.regularPriceToday')}: ${regularPriceDisplay}`);
        confirmLines.push(`${t('nftMint.youSave')}: ${savingsDisplay}`);
        confirmLines.push(`${t('nftMint.youPayNow')}: ${payablePriceDisplay}`);
        confirmLines.push(t('nftMint.networkFeesMayVary'));
      } else if (isPremiumBeyond100) {
        confirmLines.push(`${t('nftMint.regularPriceToday')}: ${regularPriceDisplay}`);
        confirmLines.push(`${t('nftMint.youSave')}: ${savingsDisplay}`);
        confirmLines.push(`${t('nftMint.youPayNow')}: $0.02 USDC`);
        confirmLines.push(t('nftMint.networkFeesMayVary'));
      } else if (isMonthlySubscriber) {
        const discountedDisplay = `~$${monthlyDiscountedTotalUsd.toFixed(2)} (${monthlyDiscountedTotalSol.toFixed(6)} SOL)`;
        confirmLines.push(`${t('nftMint.regularPriceToday')}: ${regularPriceDisplay}`);
        confirmLines.push(`${t('nftMint.youSave')}: ${savingsDisplay}`);
        confirmLines.push(`${t('nftMint.youPayNow')}: ${discountedDisplay}`);
        confirmLines.push(t('nftMint.networkFeesMayVary'));
      } else if (isSkrPayment) {
        const networkUsd = Number(paymentQuote?.network?.usd ?? waivedCommissionUsd);
        const weeklyDiscountMultiplier = Math.max(0, Math.min(1, Number(weeklyDiscountQuote?.multiplier ?? 1)));
        const skrDiscountedUsd = Number(paymentQuote?.commission?.discountedUsd ?? (appCommissionUsd * weeklyDiscountMultiplier));
        const skrSavingsDisplay = `~$${Number(paymentQuote?.commission?.savingsUsd ?? (appCommissionUsd - skrDiscountedUsd)).toFixed(2)}`;
        const skrAmountDisplay = paymentQuote?.commission?.tokenAmountFormatted
          ? `${paymentQuote.commission.tokenAmountFormatted} ${NFTOperations.SKR_TOKEN_SYMBOL}`
          : `Live ${NFTOperations.SKR_TOKEN_SYMBOL} quote`;
        const totalPayUsd = networkUsd + skrDiscountedUsd;
        confirmLines.push(`${t('nftMint.estTotal')}: ${regularPriceDisplay}`);
        confirmLines.push(`Mint + network: ~$${networkUsd.toFixed(2)}`);
        confirmLines.push(`PhotoLynk fee: ${skrAmountDisplay} (~$${skrDiscountedUsd.toFixed(2)})`);
        confirmLines.push(`${t('nftMint.youSave')}: ${skrSavingsDisplay}`);
        confirmLines.push(`${t('nftMint.youPayNow')}: ~$${totalPayUsd.toFixed(2)}`);
        confirmLines.push(`${NFTOperations.SKR_TOKEN_SYMBOL} covers the discounted PhotoLynk fee. SOL is required for network costs.`);
        confirmLines.push(t('nftMint.networkFeesMayVary'));
      } else {
        confirmLines.push(`${t('nftMint.estTotal')}: ${regularPriceDisplay}`);
        confirmLines.push(`${t('nftMint.youPayNow')}: ${regularPriceDisplay}`);
        confirmLines.push(t('nftMint.networkFeesMayVary'));
      }

      const confirmMint = await new Promise((resolve) => {
        setCustomAlert({
          title: t('nftMint.confirmMinting'),
          message: confirmLines.join('\n'),
          buttons: [
            { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('nftMint.certifyOriginal'), onPress: () => resolve(true) },
          ],
        });
      });

      if (!confirmMint) {
        setNftMinting(false);
        if (shouldUseGlobalProgress) {
          setLoadingSafe(false);
          setStatus(t('status.idle'));
          setProgress(0);
          setProgressAction(null);
        }
        return;
      }

      // Get master key if encryption is requested
      let masterKey = null;
      if (encrypt) {
        try {
          masterKey = await getStealthCloudMasterKey();
        } catch (e) {
          console.warn('[NFT] Could not get master key for encryption:', e?.message);
          showDarkAlert(t('alerts.error'), t('alerts.encryptionRequiresLogin'));
          setNftMinting(false);
          if (shouldUseGlobalProgress) {
            setLoadingSafe(false);
            setStatus(t('status.idle'));
            setProgress(0);
            setProgressAction(null);
          }
          return;
        }
      }

      const hasNftFeeBenefitForMint = !!nftIsPremium || !!subscriptionStatus?.isPremium;
      const isPremiumBeyond100ForMint = hasNftFeeBenefitForMint && nftFreeMintsRemaining <= 0;

      startBackgroundService('PhotoLynk NFT', 'Minting NFT on Solana…');

      // Mint the NFT
      const result = await NFTOperations.mintPhotoNFT({
        asset,
        filePath,
        name,
        description,
        stripExif,
        storageOption,
        nftType: nftType || 'compressed',
        serverConfig,
        onProgress: (p) => { if (shouldUseGlobalProgress) setProgress(p); },
        onStatus: (s) => {
          const statusMap = {
            'Preparing NFT...': t('nftStatus.preparing'),
            'Estimating costs...': t('nftStatus.estimatingCosts'),
            'Connecting wallet...': t('nftStatus.connectingWallet'),
            'Removing private data...': t('nftStatus.removingPrivateData'),
            'Uploading to StealthCloud...': t('nftStatus.uploadingStealthCloud'),
            'Uploading image to StealthCloud...': t('nftStatus.uploadingStealthCloud'),
            'Uploading to IPFS...': t('nftStatus.uploadingIpfs'),
            'Creating thumbnail...': t('nftStatus.creatingThumbnail'),
            'Creating preview...': t('nftStatus.creatingThumbnail'),
            'Creating certificate image...': t('nftStatus.creatingThumbnail'),
            'Compressing for on-chain...': t('nftStatus.compressingOnChain'),
            'Applying watermark...': t('nftStatus.applyingWatermark'),
            'Encrypting image...': t('nftStatus.encryptingImage'),
            'Computing integrity proof...': t('nftStatus.computingIntegrity'),
            'Building metadata...': t('nftStatus.buildingMetadata'),
            'Creating NFT on Solana...': t('nftStatus.creatingOnSolana'),
            'Requesting trusted timestamp (RFC 3161)...': t('nftStatus.requestingTimestamp'),
            'Uploading to Arweave (permanent)...': t('nftStatus.uploadingArweave'),
            'Embedding original image...': t('nftStatus.embeddingOriginal'),
            'Minting standard NFT...': t('nftStatus.mintingStandard'),
            'Minting compressed NFT...': t('nftStatus.mintingCompressed'),
            'Signing transaction...': t('nftStatus.signingTransaction'),
            'Confirming transaction...': t('nftStatus.confirmingTransaction'),
            'Finalizing...': t('nftStatus.finalizing'),
            'NFT minted successfully!': t('nftStatus.mintedSuccessfully'),
            'Minting failed': t('nftStatus.mintingFailed'),
          };
          const translated = statusMap[s] || s;
          if (shouldUseGlobalProgress) setStatus(`NFT: ${translated}`);
        },
        // Edition parameters
        edition,
        license,
        watermark,
        encrypt,
        masterKey,
        certificationMode,
        paymentMethod,
        weeklyDiscountQuote: costEstimate?.payment?.commission?.discount || weeklyDiscountQuote,
        selectedWallet,
        isLegacySubscriber,
        isPremiumBeyond100: isPremiumBeyond100ForMint,
      });

      if (result.success) {
        NFTOperations.fetchWeeklyNftDiscountQuote({
          baseUrl: 'https://stealthlynk.io',
          getAuthHeaders: getStealthCloudAuthHeaders,
        }).then((quote) => {
          setNftWeeklyDiscountQuote(quote || NFTOperations.NFT_WEEKLY_DISCOUNT_FALLBACK);
        }).catch(() => { });
        if (typeof result.mintCount === 'number' || typeof result.freeMintsRemaining === 'number' || typeof result.noFeeMintsRemaining === 'number') {
          applyNftPremiumStatus({
            isPremium: true,
            mintCount: result.mintCount,
            freeMintLimit: result.freeMintLimit,
            freeMintsRemaining: result.freeMintsRemaining,
            maxNoFeeMints: result.maxNoFeeMints,
            noFeeMintsRemaining: result.noFeeMintsRemaining,
          });
        } else if (nftIsPremium || subscriptionStatus?.isPremium) {
          await refreshNftPremiumStatus();
        }
        if (shouldUseGlobalProgress) setStatus(t('status.nftMinted'));
        // Invalidate DAS cache so next scan picks up the new NFT
        NFTOperations.invalidateDasCache();
        const mintAddr = result.mintAddress || result.assetId;
        if (mintAddr) {
          setPendingNftMint(mintAddr);
          setNftGalleryRefreshKey(k => (k || 0) + 1);
          setTimeout(() => setNftGalleryOpen(true), 800);
        }

        // Show checkmark success popup for consistency with backup/sync/cleanup
        showCompletionTickBriefly(`${t('nftMint.certifiedSuccess')}\n${name}`);
      } else {
        const errMsg = normalizeNftMintError(result.error || t('alerts.error'));
        const translatedErr = errMsg.includes('too complex for on-chain') ? t('nftStatus.onChainTooComplex') : errMsg.includes('On-chain compression failed') ? t('nftStatus.onChainFailed', { reason: errMsg.replace(/^On-chain compression failed:\s*/, '') }) : errMsg;
        showDarkAlert(t('alerts.error'), translatedErr);
      }
    } catch (e) {
      console.error('[NFT] Mint error:', e);
      const errMsg = normalizeNftMintError(e);
      const translatedErr = errMsg.includes('too complex for on-chain') ? t('nftStatus.onChainTooComplex') : errMsg.includes('On-chain compression failed') ? t('nftStatus.onChainFailed', { reason: errMsg.replace(/^On-chain compression failed:\s*/, '') }) : errMsg;
      showDarkAlert(t('alerts.error'), translatedErr);
    } finally {
      stopBackgroundService();
      setNftMinting(false);
      if (shouldUseGlobalProgress) {
        setLoadingSafe(false);
        setBackgroundWarnEligibleSafe(false);
        setProgress(0);
        setProgressAction(null);
      }
    }
  };

  const startSimilarShotsReview = async () => {
    await cancelInFlightOperations();
    const opId = currentOperationIdRef.current;
    setBackgroundWarnEligibleSafe(false); setWasBackgroundedDuringWorkSafe(false); setLoadingSafe(true); // Don't warn during permission prompts
    setProgress(0);
    setProgressAction('cleanup');
    setStatus(t('status.comparingPreparing'));

    // Request photo permission FIRST before any background service or scan.
    // On Android 13+, the notification permission dialog must not precede
    // the photo dialog or Android suppresses the latter.
    const permission = await requestMediaLibraryPermission();
    if (!permission || permission.status !== 'granted') {
      setLoadingSafe(false);
      showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededDuplicates'));
      return;
    }
    if (Platform.OS === 'ios') {
      const ap = await getMediaLibraryAccessPrivileges(permission);
      if (ap && ap !== 'all') {
        setLoadingSafe(false);
        showDarkAlert(t('alerts.limitedPhotosAccess'), t('alerts.limitedPhotosAccessClean'));
        return;
      }
    }

    // Enable background warning only after we start actual work (permission already granted inside core)
    setTimeout(() => { if (loadingRef.current) setBackgroundWarnEligibleSafe(true); }, 2000);

    startBackgroundService('PhotoLynk Cleanup', 'Scanning for similar shots…');

    try {
      const result = await startSimilarShotsReviewCore({
        resolveReadableFilePath,
        onStatus: (s) => setStatusSafe(opId, s),
        onProgress: (p) => setProgressSafe(opId, p),
        t,
        abortRef: abortOperationsRef,
      });

      if (result.aborted) {
        setLoadingSafe(false);
        setBackgroundWarnEligibleSafe(false);
        return;
      }

      if (result.error) {
        setLoadingSafe(false);
        setBackgroundWarnEligibleSafe(false);
        showDarkAlert(t('alerts.similarPhotos'), result.error);
        return;
      }

      if (result.noGroups) {
        setStatus(t('status.noSimilarPhotos'));
        await sleep(400); // Let user see 100% before checkmark
        showCompletionTickBriefly(t('results.noSimilarPhotos'));
        setLoadingSafe(false);
        setBackgroundWarnEligibleSafe(false);
        return;
      }

      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setSimilarDeletedTotal(0);
      similarDeletedTotalRef.current = 0;
      openSimilarGroup({ groups: result.groups, index: 0 });
    } finally {
      stopBackgroundService();
    }
  };

  const openSyncPicker = async () => {
    if (loadingRef.current) return;
    resetSyncPickerState(); syncPickerOpenRef.current = true; setSyncPickerOpen(true); setSyncPickerLoading(true);
    try {
      // Ensure media library permission before listing local assets
      const permission = await requestMediaLibraryPermission();
      if (!permission || permission.status !== 'granted') {
        showDarkAlert(t('alerts.syncListFailed'), t('alerts.syncListFailedPermission'));
        syncPickerOpenRef.current = false; setSyncPickerOpen(false);
        return;
      }

      const config = await getAuthHeaders();
      setSyncPickerAuthHeaders(config.headers || {});
      const SERVER_URL = getServerUrl();

      const localIndex = await buildLocalFilenameSetPaged({ mediaType: ['photo', 'video'] });
      syncPickerLocalFilenamesRef.current = localIndex.set;

      if (serverType === 'stealthcloud') {
        const { secureKey: masterKey, legacyKey } = await getDecryptionMasterKeys();
        syncPickerMasterKeyRef.current = masterKey;
        syncPickerLegacyKeyRef.current = legacyKey;
        const result = await fetchStealthCloudPickerPage({
          config, SERVER_URL, masterKey, legacyKey, offset: 0, limit: SYNC_PICKER_PAGE_SIZE
        });
        setSyncPickerItems(result.items);
        setSyncPickerTotal(result.total);
        setSyncPickerOffset(result.nextOffset);
        // Trigger thumbnail loading for initial visible items
        setTimeout(() => {
          const initialItems = result.items.slice(0, 12);
          for (const it of initialItems) {
            if (it && it.thumbChunkId && it.thumbNonce && !it.thumbUri) {
              ensureStealthCloudSyncThumb(it);
            }
          }
        }, 100);
      } else {
        const result = await fetchLocalRemotePickerPage({
          config, SERVER_URL, offset: 0, limit: SYNC_PICKER_PAGE_SIZE,
          fetchThumbnails: true // Fetch thumbnails during load
        });
        setSyncPickerItems(result.items);
        setSyncPickerTotal(result.total);
        setSyncPickerOffset(result.nextOffset);
      }
    } catch (e) {
      setSyncPickerItems([]);
      setSyncPickerTotal(0);
      setSyncPickerOffset(0);
      const detail = e?.response?.data?.error || e?.message || 'Unknown error';
      showDarkAlert(t('alerts.syncListFailed'), detail);
    } finally { setSyncPickerLoading(false); }
  };

  const loadMoreSyncPickerItems = () => {
    if (syncPickerLoadingMore || syncPickerLoading) return;
    setSyncPickerLoadingMore(true);
    (async () => {
      try {
        const config = await getAuthHeaders();
        const SERVER_URL = getServerUrl();

        if (serverType === 'stealthcloud') {
          const { secureKey: masterKey, legacyKey } = await getDecryptionMasterKeys();
          syncPickerMasterKeyRef.current = masterKey;
          syncPickerLegacyKeyRef.current = legacyKey;
          const result = await fetchStealthCloudPickerPage({
            config, SERVER_URL, masterKey, legacyKey, offset: syncPickerOffset, limit: SYNC_PICKER_PAGE_SIZE
          });
          if (result.total !== syncPickerTotal) setSyncPickerTotal(result.total);
          setSyncPickerOffset(result.nextOffset);
          if (result.items.length > 0) {
            setSyncPickerItems(prev => {
              const existingIds = new Set(prev.map(it => it?.manifestId));
              const newItems = result.items.filter(it => it?.manifestId && !existingIds.has(it.manifestId));
              return [...prev, ...newItems];
            });
          }
        } else {
          const result = await fetchLocalRemotePickerPage({
            config, SERVER_URL, offset: syncPickerOffset, limit: SYNC_PICKER_PAGE_SIZE,
            fetchThumbnails: true
          });
          if (result.total !== syncPickerTotal) setSyncPickerTotal(result.total);
          setSyncPickerOffset(result.nextOffset);
          if (result.items.length > 0) {
            setSyncPickerItems(prev => {
              const existingIds = new Set(prev.map(it => it?.filename));
              const newItems = result.items.filter(it => it?.filename && !existingIds.has(it.filename));
              return [...prev, ...newItems];
            });
          }
        }
      } catch (e) {
        console.log('Sync picker: load more failed', e.message);
      } finally {
        setSyncPickerLoadingMore(false);
      }
    })();
  };

  const syncPickerHasMore = (syncPickerTotal > 0 && syncPickerOffset < syncPickerTotal);

  const ensureStealthCloudSyncThumb = useCallback(async (item) => {
    try {
      if (!item || !item.manifestId) return;
      if (serverType !== 'stealthcloud') return;
      const manifestId = String(item.manifestId);
      if (item.thumbUri) return;

      const cached = syncPickerThumbCacheRef.current.get(manifestId);
      if (cached) {
        setSyncPickerItems(prev => (prev || []).map(it => (it && String(it.manifestId || '') === manifestId ? { ...it, thumbUri: cached } : it)));
        return;
      }

      const thumbChunkId = item.thumbChunkId ? String(item.thumbChunkId) : '';
      const thumbNonce = item.thumbNonce ? String(item.thumbNonce) : '';
      if (!thumbChunkId || !thumbNonce) return;

      const inFlightKey = `${manifestId}:${thumbChunkId}`;
      if (syncPickerThumbInFlightRef.current.has(inFlightKey)) return;
      syncPickerThumbInFlightRef.current.add(inFlightKey);

      await syncPickerThumbLimiterRef.current(async () => {
        try {
          const headers = syncPickerAuthHeaders && typeof syncPickerAuthHeaders === 'object' ? syncPickerAuthHeaders : null;
          const masterKey = syncPickerMasterKeyRef.current;
          const legacyKey = syncPickerLegacyKeyRef.current;
          if (!headers || !masterKey) return;
          const SERVER_URL = getServerUrl();
          const uri = await fetchStealthCloudThumbFileUri({
            config: { headers },
            SERVER_URL,
            masterKey,
            legacyKey,
            thumbChunkId,
            thumbNonce,
            thumbMime: item.thumbMime,
          });
          if (uri) {
            syncPickerThumbCacheRef.current.set(manifestId, uri);
            setSyncPickerItems(prev => (prev || []).map(it => (it && String(it.manifestId || '') === manifestId ? { ...it, thumbUri: uri } : it)));
          }
        } finally {
          syncPickerThumbInFlightRef.current.delete(inFlightKey);
        }
      });
    } catch (e) {
    }
  }, [serverType, syncPickerAuthHeaders]);

  // Enrichment function for local/remote server thumbnails
  const ensureLocalRemoteSyncThumb = useCallback(async (item) => {
    try {
      if (!item || !item.filename) return;
      if (serverType === 'stealthcloud') return;
      const filename = String(item.filename);
      if (item.thumbUri) return;

      const cached = syncPickerThumbCacheRef.current.get(filename);
      if (cached) {
        setSyncPickerItems(prev => (prev || []).map(it => (it && String(it.filename || '') === filename ? { ...it, thumbUri: cached } : it)));
        return;
      }

      const inFlightKey = `local:${filename}`;
      if (syncPickerThumbInFlightRef.current.has(inFlightKey)) return;
      syncPickerThumbInFlightRef.current.add(inFlightKey);

      await syncPickerThumbLimiterRef.current(async () => {
        try {
          const headers = syncPickerAuthHeaders && typeof syncPickerAuthHeaders === 'object' ? syncPickerAuthHeaders : {};
          const SERVER_URL = getServerUrl();
          const uri = await fetchThumbnailBase64(filename, { headers }, SERVER_URL);
          if (uri) {
            syncPickerThumbCacheRef.current.set(filename, uri);
            setSyncPickerItems(prev => (prev || []).map(it => (it && String(it.filename || '') === filename ? { ...it, thumbUri: uri } : it)));
          }
        } finally {
          syncPickerThumbInFlightRef.current.delete(inFlightKey);
        }
      });
    } catch (e) {
    }
  }, [serverType, syncPickerAuthHeaders]);

  const onSyncPickerViewableItemsChangedRef = useRef(null);
  onSyncPickerViewableItemsChangedRef.current = ({ viewableItems }) => {
    try {
      const vis = Array.isArray(viewableItems) ? viewableItems : [];
      for (const v of vis) {
        const it = v && v.item ? v.item : null;
        if (!it || it.thumbUri) continue;
        if (serverType === 'stealthcloud') {
          ensureStealthCloudSyncThumb(it);
        } else {
          ensureLocalRemoteSyncThumb(it);
        }
      }
    } catch (e) { }
  };
  const onSyncPickerViewableItemsChanged = useRef(({ viewableItems }) => {
    if (onSyncPickerViewableItemsChangedRef.current) {
      onSyncPickerViewableItemsChangedRef.current({ viewableItems });
    }
  });

  const closeSyncPicker = () => { syncPickerOpenRef.current = false; setSyncPickerOpen(false); resetSyncPickerState(); };

  const toggleSyncPickerSelected = (key) => {
    if (!key) return;
    setSyncPickerSelected(prev => { const next = { ...prev }; if (next[key]) delete next[key]; else next[key] = true; return next; });
  };

  const getSelectedSyncKeys = () => {
    const selected = syncPickerSelected && typeof syncPickerSelected === 'object' ? Object.keys(syncPickerSelected).filter(k => syncPickerSelected[k]) : [];
    return selected;
  };

  useEffect(() => {
    // Initialize language first (fast, from SecureStore)
    initializeLanguage().then(lang => {
      setCurrentLanguage(lang);
      console.log('[i18n] App language:', lang);
    });
    checkLogin();
    // Clear sync picker state on app launch to prevent stale data
    resetSyncPickerState();
  }, []);

  // Handle language change - triggers re-render
  const handleLanguageChange = (langCode) => {
    setCurrentLanguage(langCode);
    console.log('[i18n] Language changed to:', langCode);
  };

  // Initialize Solana when app starts
  useEffect(() => {
    (async () => {
      // Lock to portrait — app.json alone isn't enough on Android
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      } catch (e) { console.warn('[Orientation] Lock failed:', e.message); }

      // Restore last backup time for quick stats
      try {
        const savedBackupTime = await SecureStore.getItemAsync('last_backup_time');
        if (savedBackupTime) setQsLastBackupTime(savedBackupTime);
      } catch (e) { }

      try {
        await initializeSolana();
        await loadAvailablePlans();

        // Restore cached subscription status first (preserves discount when on local/remote
        // or when token hasn't loaded yet). Live refresh happens after token is known.
        try {
          const cached = await SecureStore.getItemAsync(CACHED_SUBSCRIPTION_STATUS_KEY);
          if (cached) {
            const parsed = JSON.parse(cached);
            setSubscriptionStatus(parsed);
            if (parsed?.isPremium) setNftIsPremium(true);
          }
          const cachedLegacy = await SecureStore.getItemAsync('is_legacy_subscriber');
          if (cachedLegacy === 'true') setIsLegacySubscriber(true);
        } catch (_) {}

        await refreshSubscriptionStatus();
        const authToken = token || await SecureStore.getItemAsync('auth_token');
        if (authToken) {
          const retryResult = await retryPendingPremiumVerification(authToken);
          if (retryResult?.success && retryResult?.isPremium) {
            setNftIsPremium(true);
            await refreshSubscriptionStatus();
            await refreshStealthUsage();
          }
          const subRetry = await retryPendingSubscriptionVerification(authToken);
          if (subRetry?.success && subRetry?.hadPending) {
            await refreshSubscriptionStatus();
            await refreshStealthUsage();
          }
        }
      } catch (e) {
        console.log('Solana init skipped:', e.message);
      }
    })();
  }, []);

  // ─── In-app update check (Android only) ─────────────────────────────────
  // Fetches remote config from stealthlynk.io and compares versionCode.
  // StealthLynk signature: same pattern as PaceSeeker — versionCode comparison
  // + Solana dApp Store redirect.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let cancelled = false;
    (async () => {
      try {
        // Unified endpoint: PaceSeeker reads payload+signature, PhotoLynk reads photolynk field
        const res = await fetch('https://stealthlynk.io/remote-config.json', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        // New unified format has photolynk nested; legacy plain JSON is direct
        const rc = data.photolynk || data;
        const latestVersionCode = Number(rc.latestVersionCode || 0);
        const currentVersionCode = Number(Application.nativeBuildVersion || 0);
        if (latestVersionCode > 0 && latestVersionCode > currentVersionCode) {
          console.log(`[app] PhotoLynk update available: ${currentVersionCode} -> ${latestVersionCode}`);
          setUpdatePrompt({ latestVersionCode, updateUrl: rc.updateUrl || null, releaseNotes: rc.releaseNotes || null });
        }
      } catch (e) {
        // Silent fail — update check is non-critical
        console.log('[app] Update check failed:', e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load certified photo count from storage on app startup for quick stats
  useEffect(() => {
    void refreshQuickCertifiedCount();
  }, [refreshQuickCertifiedCount]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const retryResult = await retryPendingPremiumVerification(token);
        if (retryResult?.success && retryResult?.isPremium) {
          setNftIsPremium(true);
          await refreshSubscriptionStatus();
          await refreshStealthUsage();
        }
        const subRetry = await retryPendingSubscriptionVerification(token);
        if (subRetry?.success && subRetry?.hadPending) {
          await refreshSubscriptionStatus();
          await refreshStealthUsage();
        }

        // On reload token may have loaded AFTER checkLogin() already tried
        // refreshSubscriptionStatus() with a stale null token. Re-fetch now
        // that we have a valid token so subscribers don't see full price.
        // Skip for local/remote: the local token is not valid for StealthCloud's
        // subscription API and would overwrite a valid subscriptionStatus with null.
        if (serverTypeRef.current === 'stealthcloud') {
          await refreshSubscriptionStatus();
          await refreshStealthUsage();
        }
      } catch (_) { }

      // Resume encryption migration on cold start (not just foreground)
      try {
        await maybeContinueMigration({
          onProgress: (p) => console.log('[Migration] Startup progress:', p.completed, '/', p.total),
          onComplete: (c) => console.log('[Migration] Startup complete:', c),
        });
      } catch (_) { }
    })();
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    const refreshHomeSkrFeeQuote = async () => {
      try {
        const estimate = await NFTOperations.estimateNFTMintCost(
          500 * 1024,
          'cloud',
          true,
          'open',
          NFTOperations.NFT_PAYMENT_METHODS.SKR,
          nftEffectiveDiscountQuote
        );
        if (!cancelled) setNftHomeSkrFeeQuote(estimate?.payment?.commission || null);
      } catch (_) {
        if (!cancelled) setNftHomeSkrFeeQuote(null);
      }
    };
    refreshHomeSkrFeeQuote();
    return () => {
      cancelled = true;
    };
  }, [nftWeeklyDiscountQuote, nftPlanFeeDiscountPercent]);

  const clearScheduledPreAnalysisKick = () => {
    if (preAnalysisKickTimerRef.current) {
      clearTimeout(preAnalysisKickTimerRef.current);
      preAnalysisKickTimerRef.current = null;
    }
  };

  const scheduleBackgroundPreAnalysisKick = (delayMs = HOME_BACKGROUND_TASK_DELAY_MS) => {
    // Background pre-analysis disabled to reduce CPU lag
    return;
  };

  const notePreAnalysisUserActivity = async (reason = 'userActivity', idleDelayMs = PRE_ANALYSIS_USER_IDLE_DELAY_MS) => {
    const now = Date.now();
    if (lastPreAnalysisUserActivityMsRef.current && (now - lastPreAnalysisUserActivityMsRef.current) < 1000) return;
    lastPreAnalysisUserActivityMsRef.current = now;
    clearScheduledPreAnalysisKick();
    try {
      await markPreAnalysisUserActivity({ idleDelayMs, reason });
    } catch (_) { }
    if (view === 'home' && token && !homeMaintenanceBlocked && appStateRef.current === 'active') {
      scheduleBackgroundPreAnalysisKick(Math.max(idleDelayMs, HOME_BACKGROUND_TASK_DELAY_MS));
    }
  };

  const handleGlobalUserActivity = () => {
    void notePreAnalysisUserActivity('touch');
  };

  const maybeStartBackgroundPreAnalysis = async () => {
    // Background pre-analysis disabled to reduce CPU lag
    return;
  };

  // Background pre-analysis: silently hash files when user is logged in
  // This speeds up subsequent duplicate scans by having hashes ready
  useEffect(() => {
    clearScheduledPreAnalysisKick();
    if (view !== 'home' || !token || homeMaintenanceBlocked) {
      void abortPreAnalysis('inactiveScreen');
      return;
    }

    scheduleBackgroundPreAnalysisKick(HOME_BACKGROUND_TASK_DELAY_MS);

    return () => {
      clearScheduledPreAnalysisKick();
      void abortPreAnalysis('effectCleanup');
    };
  }, [view, token, homeMaintenanceBlocked]);

  // Refresh subscription when email changes
  useEffect(() => {
    if (!email) return;
    (async () => {
      try {
        await refreshSubscriptionStatus();
      } catch (e) {
        console.log('Subscription refresh skipped:', e.message);
      }
    })();
  }, [email]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!autoUploadEnabledRef.current) {
          const isRegistered = await TaskManager.isTaskRegisteredAsync(AUTO_UPLOAD_BACKGROUND_TASK);
          if (isRegistered) {
            await BackgroundFetch.unregisterTaskAsync(AUTO_UPLOAD_BACKGROUND_TASK);
          }
          return;
        }

        const status = await BackgroundFetch.getStatusAsync();
        if (status !== BackgroundFetch.BackgroundFetchStatus.Available) {
          return;
        }

        const isRegistered = await TaskManager.isTaskRegisteredAsync(AUTO_UPLOAD_BACKGROUND_TASK);
        if (!isRegistered) {
          await BackgroundFetch.registerTaskAsync(AUTO_UPLOAD_BACKGROUND_TASK, {
            minimumInterval: 60 * 5,
            stopOnTerminate: false,
            startOnBoot: true
          });
        }
      } catch (e) {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [autoUploadEnabled]);

  useEffect(() => {
    backgroundWarnEligibleRef.current = backgroundWarnEligible;
  }, [backgroundWarnEligible]);

  useEffect(() => {
    wasBackgroundedDuringWorkRef.current = wasBackgroundedDuringWork;
  }, [wasBackgroundedDuringWork]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    if (view !== 'home') return;
    if (loading) return;
    if (autoUploadNightRunnerActiveRef.current) return;
    const idleStatus = t('status.idleWithMode', { mode: fastModeEnabled ? t('settings.fastModeLabel') : t('settings.slowModeLabel') });
    setProgress(prev => (prev === 0 ? prev : 0));
    setProgressAction(prev => (prev == null ? prev : null));
    setStatus(prev => (prev === idleStatus ? prev : idleStatus));
  }, [loading, view, fastModeEnabled]);

  useEffect(() => {
    if (loading && !autoUploadEnabledRef.current) {
      KeepAwake.activateKeepAwakeAsync('photolynk-work');
      return;
    }
    KeepAwake.deactivateKeepAwake('photolynk-work');
  }, [loading]);

  // Background NFT + Certificate sync (runs after auth, polls every 60s)
  useEffect(() => {
    if (!token || view !== 'home' || homeMaintenanceBlocked) return;
    let cancelled = false;
    const doSync = async () => {
      try {
        if (cancelled || loadingRef.current || appStateRef.current !== 'active') return;
        const now = Date.now();
        if (lastBgNftCertSyncKickMsRef.current && (now - lastBgNftCertSyncKickMsRef.current) < BG_NFT_CERT_SYNC_RESTART_COOLDOWN_MS) return;
        lastBgNftCertSyncKickMsRef.current = now;
        let config = await getStealthCloudAuthHeaders();
        let headers = config?.headers || config;
        if (!headers) return;
        const walletStatus = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
        const walletAddress = walletStatus?.address || '';
        if (walletAddress) {
          try {
            await NFTOperations.syncNFTsFromServer('https://stealthlynk.io', headers, walletAddress);
          } catch (e) {
            if (e?.response?.status === 403) {
              console.log('[BGSync] 403 on NFT sync — re-auth against StealthCloud');
              scTokenRef.current = null; // Force re-login
              try {
                const freshConfig = await getStealthCloudAuthHeaders();
                headers = freshConfig?.headers || freshConfig;
                if (headers) await NFTOperations.syncNFTsFromServer('https://stealthlynk.io', headers, walletAddress);
              } catch (_) { return; }
            } else throw e;
          }
          try { await NFTOperations.removeTransferredNFTs(walletAddress, 'https://stealthlynk.io', headers); } catch (_) { }
          try { await NFTOperations.backupNFTsToServer('https://stealthlynk.io', headers, walletAddress); } catch (_) { }
        }
        try { await NFTOperations.syncCertificatesFromServer('https://stealthlynk.io', headers, walletStatus?.address || ''); } catch (_) { }
        if (walletAddress) {
          try { await NFTOperations.removeTransferredNFTs(walletAddress, 'https://stealthlynk.io', headers); } catch (_) { }
        }
        try { await NFTOperations.backupCertificatesToServer('https://stealthlynk.io', headers); } catch (_) { }
        await refreshQuickCertifiedCount();
      } catch (e) {
        console.log('[BGSync] NFT/cert sync error:', e?.message);
      }
    };
    const timeout = setTimeout(doSync, HOME_BACKGROUND_TASK_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [token, view, homeMaintenanceBlocked, refreshQuickCertifiedCount]);

  // AppState listener: handles background warnings and auto-upload recovery
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      if (nextState !== 'active') {
        clearScheduledPreAnalysisKick();
        void notePreAnalysisUserActivity(`appState:${nextState}`);
      } else if (view === 'home' && tokenRef.current && !homeMaintenanceBlocked) {
        void syncQuickWalletLabelFromAdapter();
        scheduleBackgroundPreAnalysisKick(HOME_BACKGROUND_TASK_DELAY_MS);
      }
      if (backgroundWarnEligibleRef.current && loadingRef.current && nextState === 'background') {
        backgroundedAtMsRef.current = Date.now();
        wasBackgroundedDuringWorkRef.current = true;
        setWasBackgroundedDuringWorkSafe(true);
        setShowCompletionTick(false); // Hide checkmark when going to background during work
        return;
      }

      // Try to restart auto-upload runner when app returns to foreground
      if (nextState === 'active') {
        // Opportunistically continue encryption migration if app is idle
        if (!loadingRef.current && !backupPickerOpenRef.current && !syncPickerOpenRef.current) {
          setTimeout(() => {
            maybeContinueMigration({
              onProgress: (p) => console.log('[Migration] Progress:', p.completed, '/', p.total),
              onComplete: (c) => console.log('[Migration] Session complete:', c),
            }).catch(e => console.warn('[Migration] Foreground trigger failed:', e.message));
          }, 3000);
        }

        // Skip auto-upload restart when backup picker is open — these functions
        // call setStatus internally which re-renders the entire component tree
        if (!backupPickerOpenRef.current) {
          try {
            console.log('AutoUpload: app returned to foreground, attempting runner restart');
            scheduleNextAutoUploadNightKick();
            if (autoUploadEnabledRef.current && serverTypeRef.current === 'stealthcloud' && tokenRef.current) {
              // If runner is already active, don't change status
              if (!autoUploadNightRunnerActiveRef.current) {
                void maybeStartAutoUploadNightSession();
              }
            }
          } catch (e) {
            // ignore
          }
        }

        if (!loadingRef.current && !autoUploadNightRunnerActiveRef.current && !backupPickerOpenRef.current) {
          setProgress(0);
          setProgressAction(null);
          setStatusIfChanged(t('status.idle'));
          // Clear stale background warning flags when app is idle
          wasBackgroundedDuringWorkRef.current = false;
          backgroundWarnEligibleRef.current = false;
          backgroundedAtMsRef.current = 0;
        }
      }

      // iOS: show paused status when backgrounded (Android has foreground service)
      if (Platform.OS === 'ios' && nextState === 'background' && autoUploadEnabledRef.current && serverTypeRef.current === 'stealthcloud') {
        setStatusIfChanged(t('status.autoBackupPaused'));
      }

      if (nextState === 'active' && wasBackgroundedDuringWorkRef.current) {
        setShowCompletionTick(false); // Hide checkmark when returning to foreground after being backgrounded during work
        const backgroundForMs = backgroundedAtMsRef.current ? (Date.now() - backgroundedAtMsRef.current) : 0;
        const stillWorking = !!loadingRef.current;
        const wasEligible = !!backgroundWarnEligibleRef.current;
        backgroundedAtMsRef.current = 0;

        // Clear refs
        wasBackgroundedDuringWorkRef.current = false;
        backgroundWarnEligibleRef.current = false;
        setWasBackgroundedDuringWorkSafe(false);
        setBackgroundWarnEligibleSafe(false);

        // Only show alert if: still working, was eligible for warning, and was backgrounded long enough
        if (!stillWorking) return;
        if (!wasEligible) return;

        // Ignore short transitions (permission prompts, system UI, Android overlays)
        // Also ignore if backgroundForMs is 0 (timestamp wasn't set properly)
        if (backgroundForMs === 0) return;
        if (Platform.OS === 'android' && backgroundForMs < 3000) return;
        if (Platform.OS === 'ios' && backgroundForMs < 2000) return;

        if (!autoUploadEnabledRef.current) {
          showDarkAlert(t('alerts.processPaused'), t('alerts.processPausedMessage'));
        }
      }
    });
    return () => sub.remove();
  }, [setStatusIfChanged, view, homeMaintenanceBlocked, token]);

  // Battery listener: triggers auto-upload when charging starts
  useEffect(() => {
    if (!autoUploadEnabled || serverType !== 'stealthcloud' || !token) return;

    let sub = null;
    let pollInterval = null;

    try {
      sub = Battery.addBatteryStateListener(({ batteryState }) => {
        console.log('AutoUpload: battery state changed', batteryState);
        if (autoUploadEnabledRef.current && serverTypeRef.current === 'stealthcloud' && tokenRef.current) {
          setStatusIfChanged(t('status.autoBackupResumed'));
          void maybeStartAutoUploadNightSession();
        }
      });
    } catch (e) {
      console.log('AutoUpload: failed to add battery listener', e);
    }

    // Android: poll every 10s as fallback (listener unreliable on some devices)
    if (Platform.OS === 'android') {
      pollInterval = setInterval(() => {
        if (appStateRef.current !== 'active') return;
        if (loadingRef.current || autoUploadNightRunnerActiveRef.current || homeMaintenanceBlocked) return;
        if (autoUploadEnabledRef.current && serverTypeRef.current === 'stealthcloud' && tokenRef.current) {
          void maybeStartAutoUploadNightSession();
        }
      }, AUTO_UPLOAD_ANDROID_FALLBACK_POLL_MS);
    }

    return () => {
      if (sub) {
        try { sub.remove(); } catch (e) { }
      }
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [autoUploadEnabled, serverType, token, homeMaintenanceBlocked, setStatusIfChanged]);

  // Auto-upload runner lifecycle: start/stop based on enabled state
  useEffect(() => {
    autoUploadNightRunnerCancelRef.current = false;
    scheduleNextAutoUploadNightKick();
    if (autoUploadEnabledRef.current && serverTypeRef.current === 'stealthcloud' && tokenRef.current) {
      void maybeStartAutoUploadNightSession();
    }
    return () => {
      autoUploadNightRunnerCancelRef.current = true;
      try {
        if (autoUploadNightNextTimerRef.current) {
          clearTimeout(autoUploadNightNextTimerRef.current);
          autoUploadNightNextTimerRef.current = null;
        }
      } catch (e) { }
    };
  }, [autoUploadEnabled, serverType, token]);

  // Load wallet-derived password and master key credentials for pairing QR code
  useEffect(() => {
    if (!devicePairingOpen) return;
    if (password) {
      setPairingPassword(password);
    }
    (async () => {
      // Load password if not already available (wallet auth mode)
      if (!password) {
        try {
          const stored = await SecureStore.getItemAsync('user_password_v1', { requireAuthentication: false });
          if (stored) {
            setPairingPassword(stored);
            console.log('[Pairing] Loaded wallet-derived password for QR');
          }
        } catch (e) {
          console.log('[Pairing] Failed to load password:', e.message);
        }
      }
      // Load master key credentials for migrated legacy→wallet users.
      // These differ from the current wallet-derived email+password and are
      // needed so the receiving device can derive the correct StealthCloud key.
      try {
        const mkCreds = await getMasterKeyCredentials();
        if (mkCreds) {
          setPairingMkEmail(mkCreds.email);
          setPairingMkPassword(mkCreds.password);
          console.log('[Pairing] Loaded legacy MK credentials for QR');
        } else {
          setPairingMkEmail(null);
          setPairingMkPassword(null);
        }
      } catch (e) {
        console.log('[Pairing] Failed to load MK credentials:', e.message);
      }
    })();
  }, [devicePairingOpen, password]);

  useEffect(() => {
    if (serverType !== 'stealthcloud') {
      setStealthCapacity(null);
      setStealthCapacityError(null);
      setStealthCapacityLoading(false);
      return;
    }
    // Reset to default 100GB when switching to stealthcloud
    if (!selectedStealthPlanGb) {
      setSelectedStealthPlanGb(100);
    }

    if (view !== 'auth') return;

    let cancelled = false;

    const fetchStealthCloudCapacity = async () => {
      if (serverType !== 'stealthcloud') return null;
      try {
        setStealthCapacityLoading(true);
        setStealthCapacityError(null);

        const base = 'https://stealthlynk.io';
        let data = null;
        try {
          const res = await axios.get(`${base}/.well-known/photolynk-capacity.json`, { timeout: 8000 });
          data = res && res.data ? res.data : null;
        } catch (e) {
          data = null;
        }

        if (!data) {
          try {
            const res2 = await axios.get(`${base}/.well-known/photosync-capacity.json`, { timeout: 8000 });
            data = res2 && res2.data ? res2.data : null;
          } catch (e2) {
            data = null;
          }
        }

        if (!data) {
          const res2 = await axios.get(`${base}/api/capacity`, { timeout: 8000 });
          data = res2 && res2.data ? res2.data : null;
        }
        if (!data) return null;

        if (cancelled) return;
        setStealthCapacity(data);
      } catch (e) {
        if (cancelled) return;
        setStealthCapacity(null);
        setStealthCapacityError(e && e.message ? e.message : 'Capacity check failed');
      } finally {
        if (cancelled) return;
        setStealthCapacityLoading(false);
      }
    };

    fetchStealthCloudCapacity();

    return () => {
      cancelled = true;
    };
  }, [serverType, view]);

  /** Available StealthCloud plan tiers in GB */
  const STEALTH_PLAN_TIERS = [100, 200, 400, 1000];
  /** Message shown when a tier is sold out */
  const STEALTH_SOLD_OUT_MESSAGE = 'Sold out';

  /**
   * Gets the availability status for a StealthCloud plan tier.
   * Checks capacity data to determine if tier can be created.
   * @platform Both
   * @param {number} tierGb - Tier size in GB (100, 200, 400, 1000)
   * @returns {{canCreate: boolean, message: string|null, usageBlocked: boolean}} Tier status
   */
  const getStealthCloudTierStatus = (tierGb) => {
    const capacityStatus = checkTierAvailability(tierGb, stealthCapacity);

    // Check if user's current storage usage exceeds this tier's capacity (downgrade protection)
    const usedBytes = stealthUsage?.usedBytes || 0;
    const tierBytes = Number(tierGb) * 1_000_000_000;
    const usageExceedsTier = usedBytes >= tierBytes;

    if (usageExceedsTier) {
      return {
        canCreate: false,
        message: 'Storage usage exceeds this plan',
        usageBlocked: true,
      };
    }

    return { ...capacityStatus, usageBlocked: false };
  };

  /**
   * Yields to the UI thread to prevent blocking during long operations.
   * @platform Both
   */
  const yieldToUi = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /**
   * CPU throttle delay for encryption operations to prevent overheating.
   * Adds a small delay every N chunks to let the CPU cool down.
   * @platform Both
   */
  const throttleEncryption = async (chunkIndex) => {
    const chunkCooldown = getThrottleChunkCooldownMs();
    if (chunkCooldown <= 0) return; // Fast mode - no throttling
    if (chunkIndex > 0) {
      await new Promise((resolve) => setTimeout(resolve, chunkCooldown));
    }
  };

  /**
   * Check if device is overheating and should pause.
   * iOS: Uses ProcessInfo thermal state (requires native module, fallback to time-based)
   * Android: Uses battery temperature if available, fallback to time-based
   * @returns {Promise<boolean>} true if should pause for cooling
   */
  const checkThermalState = async () => {
    try {
      // Time-based thermal estimation: if we've been running for a while, assume hot
      // This is a fallback since JS doesn't have direct thermal API access
      return false; // Let batch limits handle it
    } catch (e) {
      return false;
    }
  };

  /**
   * Perform thermal cooldown pause with status update.
   * @param {number} batchCount - Current batch number
   */
  const thermalCooldownPause = async (batchCount) => {
    const cooldownMs = getThrottleBatchCooldownMs();
    if (cooldownMs <= 0) return; // Fast mode - no cooldown
    setStatus(t('status.coolingDown', { batch: batchCount }));
    console.log(`Thermal: cooling pause after batch ${batchCount}, waiting ${cooldownMs}ms`);
    await sleep(cooldownMs);
  };

  // Poll Info screen while open to catch late server/RC updates
  // Uses 5s interval normally, 60s during active backup to reduce load on weak phones
  const infoRefreshIntervalRef = useRef(null);
  const infoRefreshInFlightRef = useRef(false);
  const infoAdaptTimerRef = useRef(null);
  useEffect(() => {
    const clearPoll = () => {
      if (infoRefreshIntervalRef.current) {
        clearInterval(infoRefreshIntervalRef.current);
        infoRefreshIntervalRef.current = null;
      }
      if (infoAdaptTimerRef.current) {
        clearInterval(infoAdaptTimerRef.current);
        infoAdaptTimerRef.current = null;
      }
    };
    if (view !== 'info') {
      clearPoll();
      return;
    }

    // Load plans when opening Info screen (in case Solana initialized late)
    (async () => {
      try { await loadAvailablePlans(); } catch (e) { }
    })();

    // Initial non-silent fetch
    (async () => {
      try {
        setStealthUsageLoading(true);
        setStealthUsageError(null);
        await refreshStealthUsage();
      } catch (e) {
        setStealthUsageError(e?.message || 'Usage check failed');
      } finally {
        setStealthUsageLoading(false);
      }
    })();

    const tick = async () => {
      if (infoRefreshInFlightRef.current) return;
      infoRefreshInFlightRef.current = true;
      try {
        await refreshStealthUsage();
      } catch (e) { }
      infoRefreshInFlightRef.current = false;
    };
    const POLL_NORMAL_MS = 60000;
    const POLL_BUSY_MS = 120000;
    let currentInterval = POLL_NORMAL_MS;
    const startPoll = () => {
      if (infoRefreshIntervalRef.current) clearInterval(infoRefreshIntervalRef.current);
      infoRefreshIntervalRef.current = setInterval(tick, currentInterval);
    };
    infoAdaptTimerRef.current = setInterval(() => {
      const desired = loadingRef.current ? POLL_BUSY_MS : POLL_NORMAL_MS;
      if (desired !== currentInterval) {
        currentInterval = desired;
        startPoll();
      }
    }, 2000);
    startPoll();
    return () => clearPoll();
  }, [view]);

  /**
   * Opens an external URL in the device's default browser.
   * @platform Both
   * @param {string} url - URL to open
   */
  const openLink = async (url) => {
    if (!isValidUrl(url)) return;
    try {
      await Linking.openURL(url);
    } catch (error) {
      console.error('Link open error', error);
      showDarkAlert(t('alerts.error'), t('alerts.couldNotOpenLink'));
    }
  };

  /**
   * Backs up all photos to StealthCloud with end-to-end encryption.
   * This is the "Backup All" flow for StealthCloud.
   * @platform Both
   */
  const stealthCloudBackup = async () => {
    if (!(await ensureAutoUploadPolicyAllowsWork({ userInitiated: true }))) {
      return;
    }

    await cancelInFlightOperations();
    const opId = currentOperationIdRef.current;
    setLoadingSafe(true);
    setBackgroundWarnEligibleSafe(false); // Don't warn during permission prompts
    setWasBackgroundedDuringWorkSafe(false);
    setProgress(0);
    setProgressAction('backup');

    // Enable background warning only after we start actual work (permission already granted inside core)
    setTimeout(() => { if (loadingRef.current) setBackgroundWarnEligibleSafe(true); }, 2000);

    startBackgroundService('PhotoLynk Backup', 'Uploading photos to StealthCloud…');

    try {
      const result = await stealthCloudBackupCore({
        getAuthHeaders,
        getServerUrl,
        ensureStealthCloudUploadAllowed,
        // Don't pass ensureAutoUploadPolicyAllowsWorkIfBackgrounded for user-initiated operations
        // This allows the operation to pause when backgrounded and resume when foregrounded
        appStateRef,
        fastMode: fastModeEnabledRef.current,
        onStatus: (s) => setStatusSafe(opId, s),
        onProgress: (p) => setProgressSafe(opId, p),
        abortRef: abortOperationsRef,
      });

      if (result.aborted) {
        return;
      }

      if (result.permissionDenied) {
        showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededMessage'));
        return;
      }

      if (result.notAllowed) {
        return;
      }

      if (result.noFiles) {
        setProgress(1);
        setStatus(t('status.noPhotosFound'));
        await sleep(400);
        showResultAlert('backup', { uploaded: 0, skipped: 0, failed: 0, serverTotal: 0 });
        setProgress(0);
        return;
      }

      const { uploaded, skipped, failed, serverTotal } = result;

      if (uploaded === 0 && skipped === 0 && failed === 0) {
        setProgress(1);
        setStatus(t('status.noPhotosFound'));
        await sleep(400);
        showResultAlert('backup', { uploaded: 0, skipped: 0, failed: 0, serverTotal: 0 });
        setProgress(0);
        return;
      }

      // All files already exist on server - show count of selected files that were skipped
      if (uploaded === 0 && skipped > 0 && failed === 0) {
        setProgress(1);
        setStatus(t('status.allFilesBackedUp', { count: skipped }));
        await sleep(300);
        showResultAlert('backup', { uploaded: 0, skipped, failed: 0, serverTotal });
        setProgress(0);
        return;
      }

      setProgress(1);
      await sleep(300);
      setStatus(t('status.backupComplete'));
      refreshStealthUsage();
      showResultAlert('backup', { uploaded, skipped, failed, serverTotal });
    } catch (e) {
      // Auto re-auth on 403 (token was issued by a different server)
      if (e?.response?.status === 403) {
        console.log('[Auth] 403 during StealthCloud full backup — attempting token refresh');
        const refresh = await refreshAuthToken();
        if (refresh.success) {
          setStatus(t('status.backupRetrying'));
          try {
            const retryResult = await stealthCloudBackupCore({
              getAuthHeaders, getServerUrl, ensureStealthCloudUploadAllowed,
              appStateRef,
              fastMode: fastModeEnabledRef.current,
              onStatus: (s) => setStatusSafe(opId, s), onProgress: (p) => setProgressSafe(opId, p),
              abortRef: abortOperationsRef,
            });
            if (!retryResult.aborted && !retryResult.notAllowed && !retryResult.permissionDenied && !retryResult.noFiles) {
              const { uploaded, skipped, failed, serverTotal } = retryResult;
              setProgress(1);
              setStatus(t('status.backupComplete'));
              showResultAlert('backup', { uploaded, skipped, failed, serverTotal });
            }
            return;
          } catch (retryErr) {
            console.error('StealthCloud full backup retry failed:', retryErr);
          }
        } else {
          showDarkAlert(t('alerts.sessionExpired'), t('alerts.sessionExpiredRePair'));
        }
      }
      console.error('StealthCloud backup error:', e);
      setStatus(t('status.backupFailed'));
      showResultAlert('backup', { error: e && e.message ? e.message : 'Unknown error' });
    } finally {
      stopBackgroundService();
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setProgress(0);
      setProgressAction(null);
    }
  };

  /**
   * Restores photos from StealthCloud to device gallery.
   * Downloads encrypted chunks, decrypts them, and saves to media library.
   * @platform Both
   * @platform iOS: Requires full photo access (not limited)
   * @platform Android: Requires react-native-blob-util for file append operations
   * @param {Object|null} opts - Options
   * @param {Array<string>} opts.manifestIds - Optional list of specific manifests to restore
   *
   * Process:
   * 1. Request photo permissions
   * 2. Build local filename index to skip already-restored files
   * 3. Fetch manifest list from server
   * 4. For each manifest: download chunks, decrypt, save to gallery
   */
  const stealthCloudRestore = async (opts = null) => {
    await cancelInFlightOperations();
    const opId = currentOperationIdRef.current;
    setLoadingSafe(true);
    setBackgroundWarnEligibleSafe(false); // Don't warn during permission prompts
    setWasBackgroundedDuringWorkSafe(false);
    setProgress(0);
    setProgressAction('sync');
    setStatus(t('status.syncPreparing'));

    const permission = await requestMediaLibraryPermission();
    if (permission.status !== 'granted') {
      showDarkAlert(t('alerts.permissionRequired'), t('alerts.permissionRequiredSync'));
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setWasBackgroundedDuringWorkSafe(false);
      return;
    }
    if (Platform.OS === 'ios' && permission.accessPrivileges && permission.accessPrivileges !== 'all') {
      setStatus(t('status.syncLimitedAccess'));
      showDarkAlert(t('alerts.limitedPhotosAccess'), t('alerts.limitedPhotosAccessMessage'));
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setWasBackgroundedDuringWorkSafe(false);
      return;
    }

    startBackgroundService('PhotoLynk Sync', 'Downloading photos from StealthCloud…');

    try {
      const restoreHistory = await loadRestoreHistory();
      const config = await getAuthHeaders();
      const SERVER_URL = getServerUrl();
      const { secureKey: masterKey, legacyKey } = await getDecryptionMasterKeys();

      // New optimized sync handles local scanning internally
      const result = await stealthCloudRestoreCore({
        config,
        SERVER_URL,
        masterKey,
        legacyKey,
        resolveReadableFilePath,
        restoreHistory,
        saveRestoreHistory,
        makeHistoryKey,
        manifestIds: opts?.manifestIds || null,
        fastMode: fastModeEnabledRef.current,
        onStatus: (s) => setStatusSafe(opId, s),
        onProgress: (p) => setProgressSafe(opId, p),
        abortRef: abortOperationsRef,
        appStateRef,
      });

      if (result.aborted) {
        return;
      }

      if (result.noBackups) {
        setProgress(1);
        setStatus(t('status.syncNoFiles'));
        await sleep(400);
        showCompletionTickBriefly(t('status.syncNoFiles'));
        setProgress(0);
        return;
      }

      setProgress(1);
      await sleep(300);
      setStatus(t('status.syncComplete'));
      showResultAlert('sync', { downloaded: result.restored, skipped: result.skipped, failed: result.failed });
    } catch (e) {
      // Auto re-auth on 403 (token was issued by a different server)
      if (e?.response?.status === 403) {
        console.log('[Auth] 403 during StealthCloud restore — attempting token refresh');
        const refresh = await refreshAuthToken();
        if (refresh.success) {
          setStatus(t('status.syncRetrying'));
          try {
            const retryConfig = await getAuthHeaders();
            const { secureKey: retryMasterKey, legacyKey: retryLegacyKey } = await getDecryptionMasterKeys();
            const retryResult = await stealthCloudRestoreCore({
              config: retryConfig, SERVER_URL: getServerUrl(), masterKey: retryMasterKey, legacyKey: retryLegacyKey,
              resolveReadableFilePath, restoreHistory: await loadRestoreHistory(), saveRestoreHistory, makeHistoryKey,
              manifestIds: opts?.manifestIds || null, fastMode: fastModeEnabledRef.current,
              onStatus: (s) => setStatusSafe(opId, s), onProgress: (p) => setProgressSafe(opId, p),
              abortRef: abortOperationsRef,
              appStateRef,
            });
            if (!retryResult.aborted) {
              setProgress(1);
              setStatus(t('status.syncComplete'));
              showResultAlert('sync', { downloaded: retryResult.restored, skipped: retryResult.skipped, failed: retryResult.failed });
            }
            return;
          } catch (retryErr) {
            console.error('StealthCloud restore retry failed:', retryErr);
          }
        } else {
          showDarkAlert(t('alerts.sessionExpired'), t('alerts.sessionExpiredRePair'));
        }
      }
      console.error('StealthCloud restore error:', e);
      setStatus(t('status.syncFailed'));
      showResultAlert('sync', { error: e && e.message ? e.message : 'Unknown error' });
    } finally {
      stopBackgroundService();
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setProgress(0);
      setProgressAction(null);
    }
  };

  const getServerUrl = () => computeServerUrl(serverType, localHost, remoteHost);

  // Network connectivity check for backup/sync operations
  const checkNetworkForOperation = async (operationType = 'backup') => {
    try {
      const networkState = await Network.getNetworkStateAsync();

      // For NFT operations - need internet
      if (operationType === 'nft') {
        if (!networkState.isConnected || !networkState.isInternetReachable) {
          showDarkAlert(t('alerts.noInternet') || 'No Internet', t('alerts.noInternetMessage') || 'Internet connection is required to create NFTs. Please check your connection and try again.');
          return false;
        }
        return true;
      }

      // Read from SecureStore to get the most up-to-date values (state may lag after QR pairing)
      const effectiveServerType = serverType || (await SecureStore.getItemAsync('server_type')) || 'local';
      const effectiveLocalHost = localHost || (await SecureStore.getItemAsync('local_host'));
      const effectiveRemoteHost = remoteHost || (await SecureStore.getItemAsync('remote_host'));

      // For local/remote server - check local network
      if (effectiveServerType === 'local' || effectiveServerType === 'remote') {
        if (!networkState.isConnected) {
          showDarkAlert(t('alerts.noNetwork') || 'No Network Connection', t('alerts.noLocalNetworkMessage') || 'Cannot connect to your desktop app. Please ensure you are on the same network as your PhotoLynk Server or pair via QR code in the Settings tab.');
          return false;
        }
        // Try to ping the server
        try {
          const SERVER_URL = computeServerUrl(effectiveServerType, effectiveLocalHost, effectiveRemoteHost);
          if (!SERVER_URL || SERVER_URL.includes('localhost')) {
            // No server configured yet - skip check and let the actual operation handle the error
            return true;
          }
          await axios.get(`${SERVER_URL}/api/health`, { timeout: 5000 });
          return true;
        } catch (e) {
          showDarkAlert(t('alerts.noNetwork') || 'No Network Connection', t('alerts.noLocalNetworkMessage') || 'Cannot connect to your desktop app. Please ensure you are on the same network as your PhotoLynk Server or pair via QR code in the Settings tab.');
          return false;
        }
      }

      // For StealthCloud - need internet, retry for 3 minutes
      if (effectiveServerType === 'stealthcloud') {
        const maxRetryMs = 3 * 60 * 1000; // 3 minutes
        const retryIntervalMs = 5000; // 5 seconds
        const startTime = Date.now();

        while (Date.now() - startTime < maxRetryMs) {
          const state = await Network.getNetworkStateAsync();
          if (state.isConnected && state.isInternetReachable) {
            // Try to reach the server
            try {
              const SERVER_URL = getServerUrl();
              await axios.get(`${SERVER_URL}/api/health`, { timeout: 10000 });
              return true;
            } catch (e) {
              // Server not reachable, continue retrying
            }
          }

          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const remaining = Math.ceil((maxRetryMs - (Date.now() - startTime)) / 1000);
          setStatus(t('status.connecting') || `Connecting... (${remaining}s remaining)`);

          await new Promise(r => setTimeout(r, retryIntervalMs));
        }

        // After 3 minutes, show popup
        setStatus('');
        showDarkAlert(t('alerts.noConnection') || 'No Connection Available', t('alerts.noConnectionMessage') || 'Could not connect to StealthCloud after multiple attempts. Please check your internet connection and try again.');
        return false;
      }

      return true;
    } catch (e) {
      console.log('Network check error:', e);
      return true; // Allow operation to proceed if check fails
    }
  };

  const checkLogin = async () => {
    try {
      // Settings schema migration: invalidate cached pricing when commission logic changes
      try {
        const storedSchema = await SecureStore.getItemAsync('settings_schema_version');
        if (storedSchema !== SETTINGS_SCHEMA_VERSION) {
          console.log('[Settings] Schema changed from', storedSchema, 'to', SETTINGS_SCHEMA_VERSION, '- clearing price caches');
          await SecureStore.deleteItemAsync('photolynk_sol_price');
          await SecureStore.setItemAsync('settings_schema_version', SETTINGS_SCHEMA_VERSION);
        }
      } catch (_) {}

      // Detect first launch after reinstall and clear old credentials
      const isFirstLaunchAfterReinstall = await checkFirstLaunchAfterReinstall();

      // Load server settings using helper
      const serverSettings = await loadServerSettings();
      if (serverSettings.savedType) setServerType(serverSettings.savedType);
      if (serverSettings.savedLocalHost) setLocalHost(serverSettings.savedLocalHost);
      if (serverSettings.normalizedRemoteHost) setRemoteHost(serverSettings.normalizedRemoteHost);

      // Restore saved Auto Upload state — defaults to OFF for new installs
      const savedAutoUpload = await SecureStore.getItemAsync('auto_upload_enabled');
      if (savedAutoUpload === null || savedAutoUpload === undefined) {
        // First launch — default to OFF
        setAutoUploadEnabledSafe(false);
        try { await SecureStore.setItemAsync('auto_upload_enabled', 'false'); } catch (e) { }
      } else if (savedAutoUpload === 'true') {
        setAutoUploadEnabledSafe(true);
      } else {
        setAutoUploadEnabledSafe(false);
      }

      const savedFastMode = await SecureStore.getItemAsync('fast_mode_enabled');
      // Only restore user preference for stealthcloud; local/remote always fast
      if (savedFastMode === 'false' && serverTypeRef.current === 'stealthcloud') {
        setFastModeEnabledSafe(false);
      } else {
        setFastModeEnabledSafe(true);
      }

      const savedGlassMode = await SecureStore.getItemAsync('glass_mode_enabled');
      if (savedGlassMode === 'true' || savedGlassMode === 'false') {
        setGlassModeEnabled(savedGlassMode === 'true');
      }

      // Restore paired-session badge if user was operating under paired credentials
      const pairedActive = await SecureStore.getItemAsync('paired_session_active');
      if (pairedActive === 'true') {
        setIsPairedSession(true);
      }

      // If first launch after reinstall, show wallet login overlay on home
      if (isFirstLaunchAfterReinstall) {
        console.log('[FirstLaunch] Skipping auto-login - showing wallet login');
        setIsFirstRun(true);
        setStatus('');
        setView('home');
        setShowWalletLogin(true);
        setShowEmailLogin(false);
        setShowRecoveryKitLogin(false);
        return;
      }

      // Load stored email to get correct UUID
      const rawStoredEmail = await SecureStore.getItemAsync('user_email');
      const storedEmail = normalizeEmailForDeviceUuid(rawStoredEmail);

      // Normalize persisted email so UUID lookup and background tasks stay consistent.
      if (storedEmail && rawStoredEmail !== storedEmail) {
        try {
          await SecureStore.setItemAsync('user_email', storedEmail);
        } catch (e) {
          // ignore
        }
      }

      const storedToken = await SecureStore.getItemAsync('auth_token');
      const storedUserId = await SecureStore.getItemAsync('user_id');

      // Load persisted device UUID for this email (cannot regenerate without password)
      let uuid = await getDeviceUUID(storedEmail);
      if (!uuid && storedEmail) {
        // iOS may have a valid cached device UUID but a missing per-email key.
        // Fall back to the cached value so Info always shows the Device ID.
        try {
          const cached = await SecureStore.getItemAsync('device_uuid');
          if (cached) {
            uuid = cached;
            try {
              await SecureStore.setItemAsync(sanitizeStoreKey(`device_uuid_v3:${storedEmail}`), cached);
            } catch (e) {
              // ignore
            }
          }
        } catch (e) {
          // ignore
        }
      }
      setDeviceUuid(uuid);

      // Best practice flow:
      // 1. If token exists AND is valid -> auto-login with biometric for master key
      // 2. If no token BUT credentials exist -> biometric re-auth to generate new token
      // 3. If no token AND no credentials -> manual login (first run/reinstall)

      const baseUrl = computeServerUrl(
        serverType || serverSettings.savedType || 'local',
        serverSettings.savedLocalHost || localHost,
        serverSettings.normalizedRemoteHost || remoteHost
      );

      // Case 1: Valid token exists - validate and auto-login
      if (storedToken && storedEmail) {
        const validationResult = await validateToken({
          storedToken,
          storedEmail,
          storedUserId,
          uuid,
          baseUrl,
          onStatus: setStatus,
        });

        if (validationResult.success) {
          // Token valid or network error with offline access
          if (validationResult.savedPassword) {
            setStatus(t('status.securingSession'));
            const mkCreds = await getMasterKeyCredentials();
            if (mkCreds) {
              await cacheStealthCloudMasterKey(mkCreds.email, mkCreds.password, true);
            } else {
              await cacheStealthCloudMasterKey(storedEmail, validationResult.savedPassword);
            }
          }
          setTokenSafe(storedToken);
          if (storedUserId) setUserId(parseInt(storedUserId));
          if (storedEmail && !email) setEmail(storedEmail);
          await syncQuickWalletLabelFromAdapter(storedEmail);
          setStatus('');
          setView('home');
          return;
        }
        // Token invalid - fall through to Case 2
      }

      // Case 2: No valid token but credentials exist - biometric re-auth
      const reauthResult = await attemptBiometricReauth({
        storedEmail,
        baseUrl,
        getDeviceUUID,
        onStatus: setStatus,
      });

      if (reauthResult.biometricCancelled) {
        console.log('[Auth] Biometric cancelled - showing wallet login overlay');
        if (storedEmail && !email) setEmail(storedEmail);
        setStatus('');
        setView('home');
        setShowWalletLogin(true);
        setShowEmailLogin(false);
        setShowRecoveryKitLogin(false);
        return;
      }

      if (reauthResult.success) {
        if (reauthResult.deviceId) setDeviceUuid(reauthResult.deviceId);
        if (reauthResult.userId) setUserId(reauthResult.userId);
        if (storedEmail && !email) setEmail(storedEmail);

        setStatus(t('status.securingSession'));
        const mkCreds2 = await getMasterKeyCredentials();
        if (mkCreds2) {
          await cacheStealthCloudMasterKey(mkCreds2.email, mkCreds2.password, true);
        } else {
          await cacheStealthCloudMasterKey(storedEmail, reauthResult.savedPassword);
        }

        setTokenSafe(reauthResult.token);
        await syncQuickWalletLabelFromAdapter(storedEmail);
        setStatus('');
        setView('home');
        return;
      }

      // Case 3: No token and no credentials - show wallet login overlay
      if (storedEmail && !email) setEmail(storedEmail);
      console.log('No valid session - showing wallet login overlay');
      setStatus('');
      setView('home');
      setShowWalletLogin(true);
      setShowEmailLogin(false);
      setShowRecoveryKitLogin(false);
    } catch (e) {
      console.error('AutoLogin: checkLogin failed', e?.message || e);
      setLoadingSafe(false);
      setStatus('');
      setView('home');
      setShowWalletLogin(true);
      setShowEmailLogin(false);
      setShowRecoveryKitLogin(false);
    }
  };

  /**
   * Performs wallet-based login via MWA hardware wallet.
   * Called from the wallet login overlay. Connects wallet, auto-registers
   * if needed, stores credentials, caches master key, and dismisses overlay.
   */
  const performWalletLogin = async ({ skipNewUserConfirmation = false } = {}) => {
    setWalletAuthLoading(true);
    setWalletAuthError('');
    setWalletAuthStatus(t('auth.connectingWallet') || 'Connecting wallet...');

    const formatWalletAuthError = (err) => {
      const message = typeof err === 'string' ? err : (err?.message || err?.toString?.() || '');
      const lower = message.toLowerCase();
      const cancelledMessage = t('auth.walletConnectionCancelled');
      if (
        lower.includes('cancellationexception') ||
        lower.includes('user rejected') ||
        lower.includes('rejected') ||
        lower.includes('cancelled') ||
        lower.includes('canceled')
      ) {
        return cancelledMessage && cancelledMessage !== 'auth.walletConnectionCancelled'
          ? cancelledMessage
          : 'Wallet connection was cancelled. Tap Connect Wallet when you are ready to continue.';
      }
      return message || t('auth.walletAuthFailed') || 'Wallet authentication failed';
    };

    try {
      const result = await handleWalletAuth({
        serverType,
        localHost,
        remoteHost,
        onStatus: (msg) => setWalletAuthStatus(msg),
        skipNewUserConfirmation,
      });

      if (result.success) {
        // Auth successful — update app state
        setTokenSafe(result.token);
        if (result.userId) setUserId(result.userId);
        if (result.email) setEmail(result.email);
        if (result.deviceId) setDeviceUuid(result.deviceId);
        if (result.walletAddress) setQsWalletAddress(result.walletAddress);
        const normalizedWalletSeekerId = resolveWalletQuickSeekerId(result.seekerId);
        if (normalizedWalletSeekerId) setQsSeekerId(normalizedWalletSeekerId);

        // Restore saved settings — defaults to OFF for new installs
        const savedAutoUpload = await SecureStore.getItemAsync('auto_upload_enabled');
        if (savedAutoUpload === null || savedAutoUpload === undefined) {
          setAutoUploadEnabledSafe(false);
          try { await SecureStore.setItemAsync('auto_upload_enabled', 'false'); } catch (e) { }
        } else if (savedAutoUpload === 'true') {
          setAutoUploadEnabledSafe(true);
        } else {
          setAutoUploadEnabledSafe(false);
        }

        // Dismiss overlay
        setShowWalletLogin(false);
        setShowEmailLogin(false);
        setWalletAuthLoading(false);
        setWalletAuthStatus('');
        setWalletAuthError('');
        setView('home');

        // Opportunistically start encryption migration if needed
        // (re-encrypts old manifests with new secure key, no chunks re-uploaded)
        setTimeout(() => {
          maybeContinueMigration({
            onProgress: (p) => console.log('[Migration] Progress:', p.completed, '/', p.total),
            onComplete: (c) => console.log('[Migration] Session complete:', c),
          }).catch(e => console.warn('[Migration] Opportunistic start failed:', e.message));
        }, 5000);
      } else if (result.needsNewUserConfirmation) {
        // No account found for this wallet — warn user before creating a new one
        setWalletAuthLoading(false);
        setWalletAuthStatus('');
        showDarkAlert(
          t('auth.newAccountTitle') || 'No Account Found',
          t('auth.newAccountWarningWalletOnly') || 'No existing account is linked to this wallet. Continue to create your wallet-only PhotoLynk account.',
          [
            {
              text: t('auth.createNewAccount') || 'Create New Account',
              onPress: () => {
                setCustomAlert(null);
                performWalletLogin({ skipNewUserConfirmation: true });
              },
            },
          ]
        );
      } else if (result.userCancelled) {
        // User cancelled wallet prompt — stay on overlay
        setWalletAuthLoading(false);
        setWalletAuthStatus('');
      } else {
        // Error
        setWalletAuthLoading(false);
        setWalletAuthError(formatWalletAuthError(result.error || t('alerts.connectionFailed') || 'Connection failed'));
        setWalletAuthStatus('');
      }
    } catch (e) {
      setWalletAuthLoading(false);
      setWalletAuthError(formatWalletAuthError(e));
      setWalletAuthStatus('');
    }
  };

  /**
   * Handles user authentication (login or registration).
   * @platform Both
   * @param {string} type - 'login' or 'register'
   *
   * Process:
   * 1. Validates email and password
   * 2. Generates device UUID from credentials
   * 3. Sends auth request to server
   * 4. Stores token and credentials securely
   * 5. Navigates to home view on success
   */
  const handleAuth = async (type, opts = {}) => {
    // Allow passing credentials directly for relogin (state updates are async)
    const effectiveEmail = opts.email || email;
    const effectivePassword = opts.password || password;
    const requestedServerType = (opts && (opts.serverType || opts.serverTypeOverride)) || serverType;
    const throwOnError = !!(opts && opts.throwOnError);
    const suppressAlert = !!(opts && opts.suppressAlert);

    console.log('handleAuth called:', type);
    console.log('Email:', effectiveEmail, 'Password:', effectivePassword ? '***' : 'empty');

    if (!effectiveEmail || !effectivePassword) {
      showDarkAlert(t('alerts.error'), t('alerts.fillAllFields'));
      if (throwOnError) throw new Error(t('alerts.fillAllFields'));
      return;
    }

    const normalizedEmail = normalizeEmailForDeviceUuid(effectiveEmail);
    if (!normalizedEmail) {
      showDarkAlert(t('alerts.error'), t('alerts.invalidEmail'));
      if (throwOnError) throw new Error(t('alerts.invalidEmail'));
      return;
    }

    if (type === 'register' && !opts.skipConfirmCheck) {
      if (!confirmPassword) {
        showDarkAlert(t('alerts.error'), t('alerts.confirmPasswordRequired'));
        if (throwOnError) throw new Error(t('alerts.confirmPasswordRequired'));
        return;
      }
      if (effectivePassword !== confirmPassword) {
        showDarkAlert(t('alerts.error'), t('alerts.passwordsDoNotMatch'));
        if (throwOnError) throw new Error(t('alerts.passwordsDoNotMatch'));
        return;
      }
      // For Local/Remote registration, require server address and show Quick Setup if missing
      if (requestedServerType === 'local' && !localHost) {
        setQuickSetupCollapsed(false);
        setQuickSetupHighlightInput(true);
        return;
      }
      if (requestedServerType === 'remote' && !remoteHost) {
        setQuickSetupCollapsed(false);
        setQuickSetupHighlightInput(true);
        return;
      }
    }

    // For login, also require server address for Local/Remote
    if (type === 'login') {
      if (requestedServerType === 'local' && !localHost) {
        setQuickSetupCollapsed(false);
        setQuickSetupHighlightInput(true);
        return;
      }
      if (requestedServerType === 'remote' && !remoteHost) {
        setQuickSetupCollapsed(false);
        setQuickSetupHighlightInput(true);
        return;
      }
    }

    Keyboard.dismiss();
    setLoadingSafe(true);
    resetAuthLoadingLabel(loginStatusTimerRef, loginLabelTimerRef, setAuthLoadingLabel, type === 'register' ? t('auth.creatingAccount') : t('auth.signingIn'));

    try {
      // Step 1: Bonding device
      setAuthLoadingLabel(t('auth.bondingDevice'));
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Resolve and persist effective server settings
      const { effectiveType, effectiveLocalHost, effectiveRemoteHost } = await resolveEffectiveServerSettings({
        serverType: requestedServerType, localHost, remoteHost
      });
      await persistServerSettings({ effectiveType, effectiveLocalHost, effectiveRemoteHost });

      // Ensure in-memory state matches what we used.
      if (serverType !== effectiveType) setServerType(effectiveType);
      if (effectiveType === 'local' && localHost !== effectiveLocalHost) setLocalHost(effectiveLocalHost);
      if (effectiveType === 'remote' && remoteHost !== effectiveRemoteHost) setRemoteHost(effectiveRemoteHost);

      // Device UUID is derived from email+password and persisted.
      const deviceId = await getDeviceUUID(normalizedEmail, effectivePassword);
      await new Promise(resolve => setTimeout(resolve, 200));
      if (!deviceId) {
        showDarkAlert(t('alerts.deviceIdUnavailable'), t('alerts.deviceIdUnavailableMessage'));
        setLoadingSafe(false);
        return;
      }
      setDeviceUuid(deviceId);

      // Plan selection is mandatory for StealthCloud registration (7-day free trial)
      if (type === 'register' && effectiveType === 'stealthcloud' && !selectedStealthPlanGb) {
        showDarkAlert(t('alerts.selectPlan'), t('alerts.selectPlanMessage'));
        setLoadingSafe(false);
        return;
      }
      const endpoint = type === 'register' ? '/api/register' : '/api/login';
      const authBaseUrl = computeServerUrl(effectiveType, effectiveLocalHost, effectiveRemoteHost);

      // Build auth payload with hardware device ID for registration
      let hardwareDeviceId = null;
      if (type === 'register') {
        hardwareDeviceId = await getHardwareDeviceId();
      }
      const payload = await buildAuthPayload({
        type,
        normalizedEmail,
        password: effectivePassword,
        deviceId,
        effectiveType,
        selectedStealthPlanGb,
        hardwareDeviceId,
      });

      const authUrl = authBaseUrl + endpoint;
      console.log('Auth request:', {
        type,
        effectiveType,
        authUrl,
        localHost: effectiveLocalHost,
        remoteHost: effectiveRemoteHost,
        platform: Platform.OS,
      });

      // iOS Local Network Permission: Pre-trigger permission and wait for it to be granted
      // iOS doesn't immediately grant network access after user taps "Allow" - need to retry
      if (Platform.OS === 'ios' && (effectiveType === 'local' || effectiveType === 'remote')) {
        setAuthLoadingLabel(t('auth.checkingNetwork'));
        const healthUrl = authBaseUrl + '/api/health';
        let networkReady = false;

        // Try up to 5 times with 1 second delay - gives user time to respond to popup
        // and allows iOS to fully enable network access after permission is granted
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await axios.head(healthUrl, { timeout: 3000 });
            networkReady = true;
            console.log('[Auth] Network access confirmed on attempt', attempt + 1);
            break;
          } catch (e) {
            console.log('[Auth] Network check attempt', attempt + 1, 'failed:', e?.message || 'unknown');
            // Wait before retry - gives user time to tap "Allow" on permission popup
            if (attempt < 4) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }

        if (!networkReady) {
          console.log('[Auth] Network pre-check failed after 5 attempts, proceeding anyway');
        }
      }

      // Step 2: Generating token / Authenticating with retry for StealthCloud
      setAuthLoadingLabel(type === 'register' ? t('auth.generatingToken') : t('auth.authenticating'));
      await new Promise(resolve => setTimeout(resolve, 500));

      // StealthCloud retry logic with rotating status messages (server may be rebooting ~2-3 min)
      const STEALTHCLOUD_MAX_RETRIES = 20; // ~3+ minutes of retries
      const STEALTHCLOUD_RETRY_DELAY_MS = 10000; // 10 seconds between retries
      const STEALTHCLOUD_RETRY_MESSAGES = [
        t('auth.connecting'),
        t('auth.establishingConnection'),
        t('auth.reachingStealthCloud'),
        t('auth.waitingForServer'),
        t('auth.retryingConnection'),
        t('auth.stillConnecting'),
        t('common.pleaseWait'),
        t('auth.almostThere'),
      ];

      let res;
      let lastNetworkError = null;

      if (effectiveType === 'stealthcloud') {
        for (let attempt = 0; attempt < STEALTHCLOUD_MAX_RETRIES; attempt++) {
          try {
            res = await axios.post(authUrl, payload, { timeout: 15000 });
            lastNetworkError = null;
            break; // Success - exit retry loop
          } catch (err) {
            // Check if it's a retryable error:
            // - Network errors (no response)
            // - 5xx server errors (server down, Cloudflare 530, etc.)
            const status = err.response?.status;
            const isServerError = status && status >= 500 && status < 600;
            const isNetworkError = !err.response;

            // 4xx errors are client errors - don't retry (wrong password, etc.)
            if (err.response && !isServerError) {
              throw err;
            }

            // Retryable error - retry with rotating status message
            lastNetworkError = err;
            const msgIndex = attempt % STEALTHCLOUD_RETRY_MESSAGES.length;
            setAuthLoadingLabel(STEALTHCLOUD_RETRY_MESSAGES[msgIndex]);
            console.log(`StealthCloud connection attempt ${attempt + 1}/${STEALTHCLOUD_MAX_RETRIES} failed:`,
              isServerError ? `HTTP ${status}` : err?.message);

            if (attempt < STEALTHCLOUD_MAX_RETRIES - 1) {
              await new Promise(resolve => setTimeout(resolve, STEALTHCLOUD_RETRY_DELAY_MS));
            }
          }
        }

        // If all retries failed, throw the last error
        if (lastNetworkError && !res) {
          throw lastNetworkError;
        }
      } else {
        // Local/Remote - no retry, fail immediately (15s timeout)
        res = await axios.post(authUrl, payload, { timeout: 15000 });
      }
      await new Promise(resolve => setTimeout(resolve, 200));

      console.log('Attempting auth:', type, authUrl, {
        email,
        password,
        device_uuid: deviceId,
        deviceUuid: deviceId,
        device_name: Platform.OS + ' ' + Platform.Version
      });
      console.log('Auth response:', res.status);

      if (type === 'login') {
        const { token, userId } = res.data;

        // Check if credentials changed - if so, clear old session data first
        const previousEmail = await SecureStore.getItemAsync(SAVED_PASSWORD_EMAIL_KEY).catch(() => null);
        const credentialsChanged = previousEmail && previousEmail !== normalizedEmail;

        if (credentialsChanged) {
          // Clear old session data when switching accounts
          await clearStealthCloudMasterKeyCache();
          setStealthUsage(null);
          setStealthUsageError(null);
          setStealthUsageLoading(false);
        }

        // Step 3: Securing credentials
        setAuthLoadingLabel(t('auth.securingCredentials'));
        await new Promise(resolve => setTimeout(resolve, 1000));

        await SecureStore.setItemAsync('auth_token', token);
        await SecureStore.setItemAsync('user_email', normalizedEmail);

        // Store password with biometrics
        await storeCredentialsWithBiometrics({ password: effectivePassword, normalizedEmail, type: 'login' });
        if (userId) {
          await SecureStore.setItemAsync('user_id', String(userId));
          setUserId(userId);
        }

        // Step 4: Finalizing (cache master key)
        setAuthLoadingLabel(t('common.finalizing'));
        const mkCredsLogin = await getMasterKeyCredentials();
        if (mkCredsLogin) {
          await cacheStealthCloudMasterKey(mkCredsLogin.email, mkCredsLogin.password, true);
        } else {
          await cacheStealthCloudMasterKey(normalizedEmail, effectivePassword);
        }
        await new Promise(resolve => setTimeout(resolve, 500));

        setTokenSafe(token);

        // Restore saved Auto Upload state after login — defaults to OFF for new installs
        const savedAutoUpload = await SecureStore.getItemAsync('auto_upload_enabled');
        if (savedAutoUpload === null || savedAutoUpload === undefined) {
          setAutoUploadEnabledSafe(false);
          try { await SecureStore.setItemAsync('auto_upload_enabled', 'false'); } catch (e) { }
        } else if (savedAutoUpload === 'true') {
          setAutoUploadEnabledSafe(true);
        } else {
          setAutoUploadEnabledSafe(false);
        }

        // Clear logout flag on successful login
        await SecureStore.deleteItemAsync('user_logged_out');

        setAuthMode('login');
        setView('home');
        setShowWalletLogin(false);
        setShowEmailLogin(false);
        setShowRecoveryKitLogin(false);

        // If this is an email-based login (not wallet), clear wallet auth display
        if (!isWalletDerivedAccountEmail(normalizedEmail)) {
          await setWalletAuthMode(false);
          setQsSeekerId(null);
        }

        // Return login result for account switching
        return { success: true, email: normalizedEmail, token, userId };
      } else {
        // Registration successful - auto-login immediately
        // Store credentials with biometrics and get token
        const { token, userId } = res.data;

        // Step 3: Securing credentials
        setAuthLoadingLabel(t('auth.securingCredentials'));
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Store token
        await SecureStore.setItemAsync('auth_token', token);
        await SecureStore.setItemAsync('user_email', normalizedEmail);

        // Store password with biometrics for future auto-login
        await storeCredentialsWithBiometrics({ password: effectivePassword, normalizedEmail, type: 'register' });

        if (userId) {
          await SecureStore.setItemAsync('user_id', String(userId));
          setUserId(userId);
        }

        // Step 4: Finalizing (cache master key)
        setAuthLoadingLabel(t('common.finalizing'));
        const mkCredsReg = await getMasterKeyCredentials();
        if (mkCredsReg) {
          await cacheStealthCloudMasterKey(mkCredsReg.email, mkCredsReg.password, true);
        } else {
          await cacheStealthCloudMasterKey(normalizedEmail, effectivePassword);
        }
        await new Promise(resolve => setTimeout(resolve, 500));

        setTokenSafe(token);
        setConfirmPassword('');
        setAuthMode('login');

        // Clear logout flag on successful registration
        await SecureStore.deleteItemAsync('user_logged_out');

        // Navigate to home immediately (same as login flow)
        setView('home');
        setShowWalletLogin(false);
        setShowEmailLogin(false);
        setShowRecoveryKitLogin(false);

        // If this is an email-based registration (not wallet), clear wallet auth display
        if (!isWalletDerivedAccountEmail(normalizedEmail)) {
          await setWalletAuthMode(false);
          setQsSeekerId(null);
        }

        // Show success message after navigation
        showDarkAlert(
          t('alerts.accountCreated'),
          t('alerts.accountCreatedMessage'),
          [{ text: t('alerts.getStarted') }]
        );
      }
    } catch (error) {
      // Only log actual server errors, not Metro bundler noise
      if (error.response) {
        const status = error.response.status;
        console.error('Auth Error:', status, error.response.data);

        // 429 - Rate limited
        if (status === 429) {
          if (!suppressAlert) showDarkAlert(
            t('alerts.tooManyAttempts'),
            t('alerts.tooManyAttemptsMessage')
          );
          // 5xx errors after retries exhausted - server is down
        } else if (status >= 500 && status < 600 && serverType === 'stealthcloud') {
          if (!suppressAlert) showDarkAlert(
            t('alerts.serverUnavailable'),
            t('alerts.serverUnavailableMessage')
          );
        } else {
          // Map known server error messages to translations
          const serverError = error.response?.data?.error;
          let translatedError = t('alerts.connectionFailed');
          if (serverError) {
            const errorLower = serverError.toLowerCase();
            if (errorLower.includes('invalid credentials') || errorLower.includes('invalid password') || errorLower.includes('wrong password')) {
              translatedError = t('alerts.invalidCredentials');
            } else if (errorLower.includes('user not found') || errorLower.includes('no user')) {
              translatedError = t('alerts.userNotFound');
            } else if (errorLower.includes('email already') || errorLower.includes('already registered')) {
              translatedError = t('alerts.emailAlreadyRegistered');
            } else {
              translatedError = serverError;
            }
          }
          if (!suppressAlert) showDarkAlert(t('alerts.error'), translatedError);
        }
      } else if (error.request) {
        console.error('Network Error - cannot reach server', {
          message: error?.message,
          code: error?.code,
          url: error?.config?.url,
          method: error?.config?.method,
          baseURL: error?.config?.baseURL,
        });
        let message;
        if (serverType === 'stealthcloud') {
          message = t('alerts.cannotReachStealthCloud');
        } else if (serverType === 'remote') {
          message = t('alerts.cannotReachRemote');
        } else {
          message = t('alerts.cannotReachLocal');
        }
        if (!suppressAlert) showDarkAlert(t('alerts.connectionFailed'), message);
      }
      if (throwOnError) {
        throw error;
      }
      return { success: false, error };
    } finally {
      resetAuthLoadingLabel(loginStatusTimerRef, loginLabelTimerRef, setAuthLoadingLabel, t('auth.signingIn'));
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setWasBackgroundedDuringWorkSafe(false);
    }
  };

  /**
   * Unified email auth — tries login, auto-registers if user not found, then logs in.
   */
  const handleUnifiedEmailAuth = async () => {
    // Step 1: try login (suppress alert so user doesn't see "Invalid credentials" on new users)
    const result = await handleAuth('login', { suppressAlert: true });
    if (result.success) return;

    const status = result.error?.response?.status;

    if (status === 401) {
      // Step 2: auto-register (no confirm password needed)
      // Server returns 401 for both "user not found" and "wrong password",
      // so we try register. If it fails with 409, the email exists → wrong password.
      try {
        await handleAuth('register', { throwOnError: true, skipConfirmCheck: true });
      } catch (regError) {
        const regStatus = regError.response?.status;
        const regServerError = regError.response?.data?.error?.toLowerCase() || '';
        if (regStatus === 409 || regServerError.includes('already exists')) {
          showDarkAlert(t('alerts.error'), t('alerts.invalidCredentials'));
        } else {
          showDarkAlert(t('alerts.error'), regError.response?.data?.error || 'Registration failed. Please try again.');
        }
      }
    } else {
      // Other errors (429, 5xx, network) — show them now
      const errMsg = result.error?.response?.data?.error || t('alerts.connectionFailed');
      showDarkAlert(t('alerts.error'), errMsg);
    }
  };

  /**
   * Device-bound password reset using hardware device ID
   * Allows password reset if the user is on the same physical device that created the account.
   */
  const handleResetPassword = async () => {
    if (!email || !newPassword) {
      showDarkAlert(t('alerts.error'), t('alerts.enterEmailAndPassword'));
      return;
    }

    Keyboard.dismiss();
    setLoadingSafe(true);
    setAuthLoadingLabel(t('auth.verifyingDevice'));

    try {
      const result = await performDevicePasswordReset({
        email,
        newPassword,
        serverType,
        localHost,
        remoteHost,
      });

      if (!result.success) {
        if (result.hint === 'device_mismatch') {
          showDarkAlert(t('alerts.differentDevice'), t('alerts.differentDeviceMessage'));
        } else if (result.hint === 'no_hardware_id_stored') {
          showDarkAlert(t('alerts.featureNotAvailable'), t('alerts.featureNotAvailableMessage'));
        } else {
          showDarkAlert(t('alerts.error'), result.error);
        }
        return;
      }

      showDarkAlert(t('alerts.success'), t('alerts.passwordResetSuccess'));
      setPassword(newPassword);
      setAuthMode('login');
      setNewPassword('');
    } finally {
      setLoadingSafe(false);
      setAuthLoadingLabel(t('auth.signingIn'));
    }
  };

  /**
   * Emergency recovery using a recovery kit + PIN.
   * Decrypts the kit to reveal credentials, then performs normal login.
   */
  const handleRecoveryKitLogin = async (kit, pin) => {
    if (!kit || !pin) {
      throw new Error('Kit and PIN are required');
    }
    const { email, password } = await recoverFromKit(kit.trim(), pin);
    if (!email || !password) {
      throw new Error('Invalid recovery kit');
    }
    setEmail(email);
    setPassword(password);
    await handleAuth('login', { email, password, throwOnError: true });
  };

  /**
   * Scans device for exact duplicate photos using pixel-based hashing.
   * Uses DuplicateScanner module for the heavy lifting.
   * @platform Both
   */
  const cleanDeviceDuplicates = async () => {
    await cancelInFlightOperations();
    const opId = currentOperationIdRef.current;
    setBackgroundWarnEligibleSafe(false); // Don't warn during permission prompts
    setWasBackgroundedDuringWorkSafe(false);
    setLoadingSafe(true);
    setProgress(0);
    setProgressAction('cleanup');
    setStatus(t('status.comparingPreparing'));

    // Request photo permission FIRST before any background service or scan.
    // On Android 13+, the notification permission dialog must not precede
    // the photo dialog or Android suppresses the latter.
    const permission = await requestMediaLibraryPermission();
    if (!permission || permission.status !== 'granted') {
      setLoadingSafe(false);
      showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededDuplicates'));
      return;
    }
    if (Platform.OS === 'ios') {
      const ap = await getMediaLibraryAccessPrivileges(permission);
      if (ap && ap !== 'all') {
        setLoadingSafe(false);
        showDarkAlert(t('alerts.limitedPhotosAccess'), t('alerts.limitedPhotosAccessClean'));
        return;
      }
    }

    // Enable background warning only after we start actual work (permission already granted inside core)
    setTimeout(() => { if (loadingRef.current) setBackgroundWarnEligibleSafe(true); }, 2000);

    startBackgroundService('PhotoLynk Cleanup', 'Scanning for duplicate photos and videos…');

    try {
      const result = await startExactDuplicatesScanCore({
        resolveReadableFilePath,
        onStatus: (s) => setStatusSafe(opId, s),
        onProgress: (p) => setProgressSafe(opId, p),
        t,
        abortRef: abortOperationsRef,
      });

      if (result.aborted) {
        return;
      }

      if (result.error) {
        if (result.error.includes('Limited')) {
          showDarkAlert(t('alerts.limitedPhotosAccess'), t('alerts.limitedPhotosAccessClean'));
        } else if (result.error.includes('permission')) {
          showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededDuplicates'));
        } else {
          showDarkAlert(t('alerts.error'), result.error);
        }
        return;
      }

      if (result.noAssets) {
        showDarkAlert(t('alerts.noMedia'), t('alerts.noMediaMessage'));
        return;
      }

      if (result.noDuplicates) {
        setStatus(t('status.noIdenticalPhotos'));
        await sleep(400); // Let user see 100% before checkmark
        showCompletionTickBriefly(t('results.noIdenticalFiles'));
        return;
      }

      const DuplicateScanner = require('./duplicateScanner').default;
      const duplicateCount = DuplicateScanner.countDuplicates(result.groups);

      setDuplicateReview({
        mode: 'pixel-hash',
        duplicateCount: result.totalDuplicates,
        groupCount: result.groups.length,
        groups: result.groups
      });

      setStatus(t('status.foundDuplicates', { count: result.totalDuplicates, groups: result.groups.length }));
    } catch (error) {
      console.error('Clean duplicates error:', error);
      setStatus(t('status.errorDuringCleanup', { message: error.message }));
      showDarkAlert(t('alerts.error'), error.message);
    } finally {
      stopBackgroundService();
      setLoadingSafe(false);
    }
  };

  /**
   * Logs out the current user and clears session state.
   * @platform Both
   * @param {Object|null} opts - Options
   * @param {boolean} opts.forgetCredentials - If true, also clears saved email/password
   */
  const logout = async (opts = null) => {
    const forgetCredentials = !!(opts && opts.forgetCredentials);
    const skipPairedRestore = !!(opts && opts.skipPairedRestore);
    const preserveTransitionOverlay = !!(opts && opts.preserveTransitionOverlay);

    // Check if we're in a paired session and should restore original account
    let pairedSessionPersisted = false;
    let restoreOriginal = false;
    let origEmail = null;
    let origPassword = null;
    let origDeviceUuid = null;
    if (!forgetCredentials && !skipPairedRestore) {
      try {
        pairedSessionPersisted = (await SecureStore.getItemAsync('paired_session_active')) === 'true';
        origEmail = await SecureStore.getItemAsync('paired_original_email');
        origPassword = await SecureStore.getItemAsync('paired_original_password');
        origDeviceUuid = await SecureStore.getItemAsync('paired_original_device_uuid');
        if ((isPairedSession || pairedSessionPersisted) && origEmail && origPassword) {
          restoreOriginal = true;
          console.log('[Pairing] Will restore original account after logout');
        }
      } catch (_) { }
    }

    // Signal all running operations to abort immediately
    abortOperationsRef.current = true;
    currentOperationIdRef.current += 1; // Invalidate all previous operation callbacks

    // Show signing out spinner
    setLoadingSafe(true);
    setAuthLoadingLabel(t('auth.signingOut'));
    if (preserveTransitionOverlay) {
      beginAccountTransition(skipPairedRestore ? (t('pairing.switchingAccount') || 'Switching accounts...') : (t('pairing.restoringAccount') || 'Restoring your account...'));
    }

    // Use core logout logic from authHelpers
    await logoutCore({ forgetCredentials });

    // Always clear cached master key on logout
    await clearStealthCloudMasterKeyCache();

    // Clear paired session state (but not when skipPairedRestore — onSwitchAccount will set it right after)
    if (!skipPairedRestore) {
      setIsPairedSession(false);
    }
    try {
      if (!skipPairedRestore) {
        await SecureStore.deleteItemAsync('paired_session_active');
      }
      await SecureStore.deleteItemAsync('legacy_mk_email');
      await SecureStore.deleteItemAsync('legacy_mk_password');
      await SecureStore.deleteItemAsync('wallet_secure_password_v1');
      await SecureStore.deleteItemAsync('wallet_legacy_password_v1');
      if (!restoreOriginal && !skipPairedRestore) {
        // Purge saved original creds only when genuinely discarding them
        // (forgetCredentials or non-paired logout). Do NOT purge when
        // skipPairedRestore — onSwitchAccount just saved them and needs them.
        await SecureStore.deleteItemAsync('paired_original_email');
        await SecureStore.deleteItemAsync('paired_original_password');
        await SecureStore.deleteItemAsync('paired_original_device_uuid');
      }
    } catch (_) { }

    // Clear StealthCloud usage data so it re-fetches on next login
    setStealthUsage(null);
    setStealthUsageError(null);
    setStealthUsageLoading(false);

    setTokenSafe(null);
    setUserId(null);
    setDeviceUuid(null);
    setPassword('');
    setSubscriptionStatus(null);
    resetNftPremiumState();

    // Reset progress state BEFORE changing view to prevent blue flash
    setProgress(0);
    setProgressAction(null);
    setStatus(t('status.idle'));
    if (!preserveTransitionOverlay) {
      setLoadingSafe(false);
    }

    // Clear wallet auth mode on logout
    await setWalletAuthMode(false);

    // If restoring original account after paired session, auto-login
    if (restoreOriginal) {
      console.log('[Pairing] Restoring original account');
      setStatus(t('pairing.restoringAccount') || 'Restoring your account...');
      setLoadingSafe(true);
      beginAccountTransition(t('pairing.restoringAccount') || 'Restoring your account...');
      try {
        await handleAuth('login', { email: origEmail, password: origPassword, throwOnError: true });
        if (origDeviceUuid) {
          try {
            await SecureStore.setItemAsync('device_uuid', origDeviceUuid);
            await SecureStore.setItemAsync(sanitizeStoreKey(`device_uuid_v3:${normalizeEmailForDeviceUuid(origEmail)}`), origDeviceUuid);
          } catch (_) { }
          setDeviceUuid(origDeviceUuid);
        }
        setEmail(origEmail);
        setPassword(origPassword);
        try {
          await SecureStore.deleteItemAsync('paired_original_email');
          await SecureStore.deleteItemAsync('paired_original_password');
          await SecureStore.deleteItemAsync('paired_original_device_uuid');
        } catch (_) { }
        setQsSeekerId(isWalletDerivedAccountEmail(origEmail) ? emailToSeekerId(origEmail) : null);
        resetSyncPickerState();
        invalidateDasCache();
        setStatus('');
      } catch (e) {
        console.log('[Pairing] Restore login failed, falling back to login screen:', e?.message);
        if (origDeviceUuid) {
          try {
            await SecureStore.setItemAsync('device_uuid', origDeviceUuid);
            await SecureStore.setItemAsync(sanitizeStoreKey(`device_uuid_v3:${normalizeEmailForDeviceUuid(origEmail)}`), origDeviceUuid);
          } catch (_) { }
          setDeviceUuid(origDeviceUuid);
        }
        setEmail(origEmail || '');
        setPassword(origPassword || '');
        setLoadingSafe(false);
        setStatus('');
        setView('home');
        setShowWalletLogin(true);
        setShowEmailLogin(false);
        setShowRecoveryKitLogin(false);
      } finally {
        endAccountTransition();
      }
      return;
    }

    // Show wallet login overlay instead of old auth screen (but not when skipPairedRestore — onSwitchAccount will login with paired creds)
    if (!skipPairedRestore) {
      setView('home');
      setShowWalletLogin(true);
      setShowEmailLogin(false);
      setShowRecoveryKitLogin(false);
      setAuthLoadingLabel(t('auth.signingIn'));
    }
    if (!preserveTransitionOverlay) {
      endAccountTransition();
    }

    // DO NOT reset abort flag here - it must stay true until user starts a new operation
    // The abort flag will be reset by cancelInFlightOperations when a new operation starts
  };

  /**
   * Re-login with stored credentials to get a fresh JWT token for the current server.
   * Called automatically when a 403 (invalid token) is received during operations.
   * This handles the case where the stored token was issued by a different server
   * (e.g. StealthCloud token used against local server, or vice versa).
   * @returns {Promise<{success: boolean, headers?: Object, message?: string}>}
   */
  const refreshAuthToken = async () => {
    try {
      const se = await SecureStore.getItemAsync('user_email');
      // Read password without triggering biometric — this runs during backup/sync 403 retry
      let sp = null;
      try {
        sp = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, { requireAuthentication: false });
      } catch (e) { /* ignore */ }
      if (!se || !sp) {
        return { success: false, message: 'no_credentials' };
      }
      const SERVER_URL = getServerUrl();
      if (!SERVER_URL) {
        return { success: false, message: 'no_server' };
      }
      const did = await getDeviceUUID(se, sp);
      const lr = await axios.post(`${SERVER_URL}/api/login`, {
        email: se,
        password: sp,
        device_uuid: did,
        device_name: Platform.OS + ' ' + Platform.Version,
      }, { timeout: 15000 });
      if (lr.data?.token) {
        await SecureStore.setItemAsync('auth_token', lr.data.token);
        setTokenSafe(lr.data.token);
        setDeviceUuid(did);
        console.log('[Auth] Token refreshed for', SERVER_URL);
        return {
          success: true,
          headers: {
            'Authorization': `Bearer ${lr.data.token}`,
            'X-Device-UUID': did,
            'X-Client-Build': CLIENT_BUILD,
          },
        };
      }
      return { success: false, message: 'no_token_in_response' };
    } catch (e) {
      console.log('[Auth] Token refresh failed:', e?.response?.status || e?.message);
      return { success: false, message: e?.message || 'refresh_failed' };
    }
  };

  /**
   * Gets authentication headers for API requests.
   * Includes Bearer token and device UUID for server-side validation.
   * @platform Both
   * @returns {Promise<{headers: Object}>} Headers object with Authorization, X-Device-UUID, X-Client-Build
   * @throws {Error} If device UUID or auth token is missing
   */
  const getAuthHeaders = async () => {
    // Always use the same user+device UUID that was used at login
    // so that X-Device-UUID matches the device_uuid inside the JWT
    let storedEmail = null;
    try {
      storedEmail = await SecureStore.getItemAsync('user_email');
    } catch (e) {
      storedEmail = null;
    }
    if (!storedEmail) {
      try {
        storedEmail = await SecureStore.getItemAsync(SAVED_PASSWORD_EMAIL_KEY);
      } catch (e) {
        storedEmail = null;
      }
    }
    storedEmail = normalizeEmailForDeviceUuid(storedEmail);
    let uuid = deviceUuid;
    if (!uuid) {
      try {
        uuid = await SecureStore.getItemAsync('device_uuid');
      } catch (e) {
        uuid = null;
      }
    }
    if (!uuid) {
      try {
        uuid = await getDeviceUUID(storedEmail);
      } catch (e) {
        uuid = null;
      }
    }
    if (!uuid) {
      throw new Error('Device UUID missing. Please logout and login again.');
    }

    let authToken = tokenRef && tokenRef.current ? tokenRef.current : token;
    if (!authToken) {
      try {
        authToken = await SecureStore.getItemAsync('auth_token');
      } catch (e) {
        authToken = null;
      }
    }
    if (!authToken) {
      throw new Error('Auth token missing. Please login again.');
    }
    return {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-Device-UUID': uuid,
        'X-Client-Build': CLIENT_BUILD
      }
    };
  };

  useEffect(() => {
    if (!token || !qsWalletAddress) return;
    const normalizedSeekerId = normalizeWalletSeekerId(qsSeekerId);
    const SERVER_URL = getServerUrl();
    if (!SERVER_URL) return;
    const syncKey = `${SERVER_URL}|${qsWalletAddress}|${normalizedSeekerId || ''}`;
    if (walletProfileSyncKeyRef.current === syncKey) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await getAuthHeaders();
        await axios.post(`${SERVER_URL}/api/save-wallet`, {
          wallet_address: qsWalletAddress,
          seeker_id: normalizedSeekerId || undefined,
        }, { ...config, timeout: 10000 });
        if (!cancelled) {
          walletProfileSyncKeyRef.current = syncKey;
        }
      } catch (e) {
        console.log('[Wallet] Profile sync failed:', e?.response?.data?.error || e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [token, qsWalletAddress, qsSeekerId, serverType, localHost, remoteHost]);

  useEffect(() => {
    if (!token) return;
    const SERVER_URL = getServerUrl();
    if (!SERVER_URL) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await getAuthHeaders();
        const response = await axios.get(`${SERVER_URL}/api/wallet-profile`, { ...config, timeout: 10000 });
        if (cancelled) return;
        const profile = response.data || {};
        const normalizedSeekerId = normalizeWalletSeekerId(profile.seeker_id);
        if (normalizedSeekerId) setQsSeekerId(normalizedSeekerId);
        if (profile.wallet_address) setQsWalletAddress(profile.wallet_address);
      } catch (e) {
        console.log('[Wallet] Profile load failed:', e?.response?.data?.error || e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [token, serverType, localHost, remoteHost]);

  /**
   * Get auth headers specifically for StealthCloud (https://stealthlynk.io).
   * If the user is already connected to StealthCloud, returns the normal token.
   * Otherwise, re-authenticates against StealthCloud using stored credentials
   * and caches the token for 50 minutes to avoid repeated logins.
   * Used by all NFT/certificate operations which always talk to StealthCloud.
   */
  const getStealthCloudAuthHeaders = async () => {
    // If already on StealthCloud, just use the normal token
    if (serverTypeRef.current === 'stealthcloud') {
      return getAuthHeaders();
    }

    // Check cached SC token (valid for 50 min)
    if (scTokenRef.current && Date.now() - scTokenTsRef.current < 50 * 60 * 1000) {
      let uuid = deviceUuid;
      if (!uuid) {
        try { uuid = await SecureStore.getItemAsync('device_uuid'); } catch (_) { }
      }
      return {
        headers: {
          'Authorization': `Bearer ${scTokenRef.current}`,
          'X-Device-UUID': uuid || '',
          'X-Client-Build': CLIENT_BUILD,
        }
      };
    }

    // Local/remote server: don't attempt StealthCloud re-auth (avoids biometric
    // popup from reading password stored with requireAuthentication:true).
    // NFT gallery will get a 403 and show login hint instead of silently failing.
    if (serverTypeRef.current !== 'stealthcloud') {
      return getAuthHeaders();
    }

    // Re-authenticate against StealthCloud
    const se = await SecureStore.getItemAsync('user_email').catch(() => null);
    let sp = null;
    try {
      sp = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, { requireAuthentication: false });
    } catch (_) { }
    if (!se || !sp) {
      console.log('[SC-Auth] No stored credentials for StealthCloud login');
      return getAuthHeaders(); // fallback to normal token
    }
    try {
      const did = await getDeviceUUID(se, sp);
      const lr = await axios.post('https://stealthlynk.io/api/login', {
        email: se,
        password: sp,
        device_uuid: did,
        device_name: Platform.OS + ' ' + Platform.Version,
      }, { timeout: 15000 });
      if (lr.data?.token) {
        scTokenRef.current = lr.data.token;
        scTokenTsRef.current = Date.now();
        console.log('[SC-Auth] StealthCloud token obtained');
        return {
          headers: {
            'Authorization': `Bearer ${lr.data.token}`,
            'X-Device-UUID': did,
            'X-Client-Build': CLIENT_BUILD,
          }
        };
      }
    } catch (e) {
      console.log('[SC-Auth] StealthCloud login failed:', e?.response?.status || e?.message);
    }
    // Fallback to normal token (may 403 but better than nothing)
    return getAuthHeaders();
  };

  useEffect(() => {
    let cancelled = false;
    const refreshWeeklyDiscount = async () => {
      if (serverTypeRef.current !== 'stealthcloud') return;
      try {
        const quote = await NFTOperations.fetchWeeklyNftDiscountQuote({
          baseUrl: 'https://stealthlynk.io',
          getAuthHeaders: getStealthCloudAuthHeaders,
        });
        if (!cancelled) setNftWeeklyDiscountQuote(quote || NFTOperations.NFT_WEEKLY_DISCOUNT_FALLBACK);
      } catch (_) {
        if (!cancelled) setNftWeeklyDiscountQuote(NFTOperations.NFT_WEEKLY_DISCOUNT_FALLBACK);
      }
    };
    refreshWeeklyDiscount();
    const interval = setInterval(refreshWeeklyDiscount, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token]);

  /**
   * Backs up all photos to the configured server (local/remote).
   * For StealthCloud, delegates to stealthCloudBackup.
   * @platform Both
   *
   * Process:
   * 1. Request photo permissions
   * 2. Get list of files already on server
   * 3. Exclude files in app album (already restored)
   * 4. Upload missing files to server
   */
  const backupPhotos = async () => {
    if (serverType === 'stealthcloud') {
      return stealthCloudBackup();
    }

    await cancelInFlightOperations();
    const opId = currentOperationIdRef.current;
    setLoadingSafe(true);
    setBackgroundWarnEligibleSafe(false); // Don't warn during permission prompts
    setWasBackgroundedDuringWorkSafe(false);
    setProgress(0);
    setProgressAction('backup');

    // Enable background warning only after we start actual work (permission already granted inside core)
    setTimeout(() => { if (loadingRef.current) setBackgroundWarnEligibleSafe(true); }, 2000);

    startBackgroundService('PhotoLynk Backup', 'Uploading photos to server…');

    try {
      const result = await localRemoteBackupCore({
        getAuthHeaders,
        getServerUrl,
        resolveReadableFilePath,
        appStateRef, // Pass appStateRef so upload can pause when backgrounded
        fastMode: fastModeEnabledRef.current,
        onStatus: (s) => setStatusSafe(opId, s),
        onProgress: (p) => setProgressSafe(opId, p),
        t,
        abortRef: abortOperationsRef,
      });

      if (result.aborted) {
        return;
      }

      if (result.permissionDenied) {
        showDarkAlert(t('alerts.permissionNeeded'), t('alerts.permissionNeededMessage'));
        setStatus('');
        return;
      }

      if (result.limitedAccess) {
        setStatus(t('status.limitedPhotosAccess'));
        showDarkAlert(
          t('alerts.limitedPhotosAccess'),
          t('alerts.limitedPhotosAccessMessage')
        );
        return;
      }

      if (result.noFiles) {
        setProgress(1);
        setStatus(t('status.noPhotosFound'));
        await sleep(400);
        showResultAlert('backup', { uploaded: 0, skipped: 0, failed: 0, serverTotal: 0 });
        setProgress(0);
        return;
      }

      if (result.noFilesToBackup) {
        setProgress(1);
        setStatus(t('status.noFilesToBackup'));
        await sleep(400);
        showResultAlert('backup', { uploaded: 0, skipped: 0, failed: 0, serverTotal: 0 });
        setProgress(0);
        return;
      }

      if (result.alreadyBackedUp) {
        setProgress(1); // Show 100% before checkmark
        setStatus(t('status.allFilesBackedUp', { count: result.serverTotal || result.checkedCount }));
        await sleep(400); // Brief pause to show 100%
        showResultAlert('backup', { uploaded: 0, skipped: result.serverTotal || result.checkedCount || 0, failed: 0, serverTotal: result.serverTotal || result.checkedCount });
        setProgress(0);
        return;
      }

      const { uploaded, skipped, failed, serverTotal } = result;
      setProgress(1); // Show 100% before checkmark
      setStatus(t('status.backupComplete'));
      refreshStealthUsage();
      await sleep(400); // Brief pause to show 100%
      showResultAlert('backup', { uploaded, skipped, failed, serverTotal });
      setProgress(0);
    } catch (error) {
      // Auto re-auth on 403 (token was issued by a different server)
      if (error?.response?.status === 403) {
        console.log('[Auth] 403 during local/remote full backup — attempting token refresh');
        const refresh = await refreshAuthToken();
        if (refresh.success) {
          setStatus(t('status.backupRetrying'));
          try {
            const retryResult = await localRemoteBackupCore({
              getAuthHeaders, getServerUrl, resolveReadableFilePath,
              appStateRef, fastMode: fastModeEnabledRef.current,
              onStatus: (s) => setStatusSafe(opId, s), onProgress: (p) => setProgressSafe(opId, p),
              t,
              abortRef: abortOperationsRef,
            });
            if (retryResult.aborted) {
              return;
            }
            if (!retryResult.permissionDenied && !retryResult.noFiles && !retryResult.noFilesToBackup) {
              const { uploaded, skipped, failed, serverTotal } = retryResult;
              setProgress(1);
              setStatus(t('status.backupComplete'));
              showResultAlert('backup', { uploaded, skipped, failed, serverTotal });
              setProgress(0);
            }
            return;
          } catch (retryErr) {
            console.error('Local/remote full backup retry failed:', retryErr);
          }
        } else {
          showDarkAlert(t('alerts.sessionExpired'), t('alerts.sessionExpiredRePair'));
        }
      }
      console.error(error);
      setStatus(t('status.backupFailed'));
      setProgress(0);
      showResultAlert('backup', { error: error && error.message ? error.message : 'Unknown error' });
    } finally {
      stopBackgroundService();
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setProgressAction(null);
    }
  };

  /**
   * Restores photos from the configured server (local/remote) to device gallery.
   * For StealthCloud, delegates to stealthCloudRestore.
   * @platform Both
   * @platform iOS: Requires full photo access (not limited)
   * @param {Object|null} opts - Options
   * @param {Array<string>} opts.onlyFilenames - Optional list of specific filenames to restore
   *
   * Process:
   * 1. Request photo permissions
   * 2. Get list of files on server
   * 3. Build local filename index to skip already-restored files
   * 4. Download and save missing files to gallery
   */
  const restorePhotos = async (opts = null) => {
    if (serverType === 'stealthcloud') {
      return stealthCloudRestore(opts);
    }

    await cancelInFlightOperations();
    const opId = currentOperationIdRef.current;
    setStatus(t('status.syncPreparing'));
    setProgress(0);
    setProgressAction('sync');
    setLoadingSafe(true);
    setBackgroundWarnEligibleSafe(false); // Don't warn during permission prompts
    setWasBackgroundedDuringWorkSafe(false);

    const permission = await requestMediaLibraryPermission();
    if (permission.status !== 'granted') {
      showDarkAlert(t('alerts.permissionRequired'), t('alerts.permissionRequiredSync'));
      setLoadingSafe(false);
      setStatus('');
      setBackgroundWarnEligibleSafe(false);
      setProgressAction(null);
      setWasBackgroundedDuringWorkSafe(false);
      return;
    }

    if (Platform.OS === 'ios' && permission.accessPrivileges && permission.accessPrivileges !== 'all') {
      setStatus(t('status.syncLimitedAccess'));
      showDarkAlert(
        t('alerts.limitedPhotosAccess'),
        t('alerts.limitedPhotosAccessMessage')
      );
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setWasBackgroundedDuringWorkSafe(false);
      setProgress(0);
      return;
    }

    setBackgroundWarnEligibleSafe(true);
    setWasBackgroundedDuringWorkSafe(false);

    startBackgroundService('PhotoLynk Sync', 'Downloading photos from server…');

    try {
      const config = await getAuthHeaders();
      const SERVER_URL = getServerUrl();
      const restoreHistory = await loadRestoreHistory();

      // New optimized sync handles local scanning internally
      const result = await localRemoteRestoreCore({
        config,
        SERVER_URL,
        resolveReadableFilePath,
        restoreHistory,
        saveRestoreHistory,
        makeHistoryKey,
        onlyFilenames: opts?.onlyFilenames || opts?.manifestIds || null,
        fastMode: fastModeEnabledRef.current,
        onStatus: (s) => setStatusSafe(opId, s),
        onProgress: (p) => setProgressSafe(opId, p),
        abortRef: abortOperationsRef,
        appStateRef, // Pass appStateRef so sync can pause when backgrounded
      });

      if (result.aborted) {
        return;
      }

      if (result.noFiles) {
        setProgress(1);
        setStatus(t('status.syncNoFiles'));
        await sleep(400);
        showCompletionTickBriefly(t('status.syncNoFiles'));
        setProgress(0);
        return;
      }

      if (result.allSynced) {
        setProgress(1);
        setStatus(t('status.allFilesSynced', { count: result.serverTotal }));
        await sleep(800);
        showCompletionTickBriefly(t('results.filesOnDevice', { count: result.serverTotal }));
        await sleep(500);
        setProgress(0);
        return;
      }

      setStatus(t('status.syncComplete'));
      setProgress(0);
      showResultAlert('sync', { downloaded: result.restored, skipped: result.skipped, failed: result.failed });
      resetSyncPickerState();

    } catch (error) {
      // Auto re-auth on 403 (token was issued by a different server)
      if (error?.response?.status === 403) {
        console.log('[Auth] 403 during local/remote restore — attempting token refresh');
        const refresh = await refreshAuthToken();
        if (refresh.success) {
          setStatus(t('status.syncRetrying'));
          try {
            const retryConfig = await getAuthHeaders();
            const retryResult = await localRemoteRestoreCore({
              config: retryConfig, SERVER_URL: getServerUrl(), resolveReadableFilePath,
              restoreHistory: await loadRestoreHistory(), saveRestoreHistory, makeHistoryKey,
              onlyFilenames: opts?.onlyFilenames || opts?.manifestIds || null, fastMode: fastModeEnabledRef.current,
              onStatus: (s) => setStatusSafe(opId, s), onProgress: (p) => setProgressSafe(opId, p),
              abortRef: abortOperationsRef, appStateRef,
            });
            if (retryResult.aborted) {
              return;
            }
            if (!retryResult.noFiles) {
              setStatus(t('status.syncComplete'));
              showResultAlert('sync', { downloaded: retryResult.restored, skipped: retryResult.skipped, failed: retryResult.failed });
            }
            return;
          } catch (retryErr) {
            console.error('Local/remote restore retry failed:', retryErr);
          }
        } else {
          showDarkAlert(t('alerts.sessionExpired'), t('alerts.sessionExpiredRePair'));
        }
      }
      console.error('Restore error:', error);
      setStatus(t('status.syncFailed'));
      setProgress(0);
      showResultAlert('sync', { error: error.message });
    } finally {
      stopBackgroundService();
      setLoadingSafe(false);
      setBackgroundWarnEligibleSafe(false);
      setProgressAction(null);
    }
  };

  // Secret long-press handlers to clear stuck history/cache
  const secretClearBackupHistory = async () => {
    try {
      await clearHashCache();
      console.log('[Secret] Cleared hash cache');
      showDarkAlert('Cache Cleared', 'Backup hash cache has been reset. Next backup will re-scan all files.');
    } catch (e) {
      console.warn('[Secret] Failed to clear hash cache:', e?.message);
    }
  };

  const secretClearSyncHistory = async () => {
    try {
      await clearRestoreHistory();
      console.log('[Secret] Cleared restore history');
      showDarkAlert('History Cleared', 'Sync/restore history has been reset. Next sync will re-download all files.');
    } catch (e) {
      console.warn('[Secret] Failed to clear restore history:', e?.message);
    }
  };

  const handleTabChange = useCallback((tab) => { setHomeActiveTab(tab); if (tab === 'info') setView('info'); else setView('home'); }, []);

  const memoizedInfoContent = useMemo(() => (
    <InfoScreen
      appDisplayName={APP_DISPLAY_NAME}
      appVersion={APP_VERSION}
      deviceUuid={deviceUuid}
      serverType={serverType}
      stealthUsage={stealthUsage}
      stealthUsageLoading={stealthUsageLoading}
      stealthUsageError={stealthUsageError}
      availablePlans={availablePlans}
      purchaseLoading={purchaseLoading}
      glassModeEnabled={glassModeEnabled}
      showDarkAlert={showDarkAlert}
      openPaywall={openPaywall}
      STEALTH_PLAN_TIERS={STEALTH_PLAN_TIERS}
      nftIsPremium={nftIsPremium}
      nftMintCount={nftMintCount}
      nftFreeMintLimit={nftFreeMintLimit}
      nftFreeMintsRemaining={nftFreeMintsRemaining}
      nftMaxNoFeeMints={nftMaxNoFeeMints}
      nftNoFeeMintsRemaining={nftNoFeeMintsRemaining}
      nftPurchaseLoading={nftPurchaseLoading}
      handleSolanaPremium={handleSolanaPremium}
      handleDeleteAccount={handleDeleteAccount}
      subscriptionStatus={subscriptionStatus}
    />
  ), [deviceUuid, serverType, stealthUsage, stealthUsageLoading, stealthUsageError, availablePlans, purchaseLoading, glassModeEnabled, showDarkAlert, openPaywall, nftIsPremium, nftMintCount, nftFreeMintLimit, nftFreeMintsRemaining, nftMaxNoFeeMints, nftNoFeeMintsRemaining, nftPurchaseLoading, handleSolanaPremium, handleDeleteAccount, subscriptionStatus]);

  const memoizedSettingsContent = useMemo(() => (
    <SettingsScreen
      serverType={serverType}
      setServerType={setServerType}
      localHost={localHost}
      setLocalHost={setLocalHost}
      remoteHost={remoteHost}
      setRemoteHost={setRemoteHost}
      getServerUrl={getServerUrl}
      autoUploadEnabled={autoUploadEnabled}
      persistAutoUploadEnabled={persistAutoUploadEnabled}
      fastModeEnabled={fastModeEnabled}
      persistFastModeEnabled={persistFastModeEnabled}
      glassModeEnabled={glassModeEnabled}
      persistGlassModeEnabled={persistGlassModeEnabled}
      loading={loading}
      logout={logout}
      relogin={async (newServerType) => {
        setLoadingSafe(true);
        setStatus(t('status.switchingServer') || 'Switching server...');
        setStealthUsage(null);
        setStealthUsageError(null);
        try {
          const savedEmail = await SecureStore.getItemAsync('user_email');
          const savedPasswordEmail = await SecureStore.getItemAsync(SAVED_PASSWORD_EMAIL_KEY);
          let savedPassword = null;
          if (savedPasswordEmail) {
            const storedWithBiometric = Platform.OS === 'ios' ||
              (await SecureStore.getItemAsync('password_stored_with_biometric')) === 'true';
            if (storedWithBiometric) {
              try {
                savedPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, {
                  requireAuthentication: true,
                  authenticationPrompt: t('auth.unlockToSignIn')
                });
              } catch (e) {
                savedPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY);
              }
            } else {
              savedPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY);
            }
          }
          if (savedEmail && savedPassword) {
            if (newServerType) { try { setServerType(newServerType); } catch (e) { } }
            await handleAuth('login', { email: savedEmail, password: savedPassword, serverType: newServerType || serverType });
          } else {
            setShowWalletLogin(true);
            setShowEmailLogin(false);
            setShowRecoveryKitLogin(false);
          }
        } catch (e) {
          showDarkAlert(t('alerts.error'), e.message || t('alerts.connectionFailed'));
        } finally {
          setLoadingSafe(false);
        }
      }}
      purgeStealthCloudData={purgeStealthCloudData}
      purgeClassicServerData={purgeClassicServerData}
      showDarkAlert={showDarkAlert}
      onQrScan={async () => {
        if (!cameraPermission?.granted) {
          const result = await requestCameraPermission();
          if (!result.granted) {
            showDarkAlert(t('login.cameraPermissionTitle'), t('login.cameraPermissionMessage'));
            return;
          }
        }
        setQrScannerOpen(true);
      }}
      normalizeHostInput={normalizeHostInput}
      SecureStore={SecureStore}
      currentLanguage={currentLanguage}
      onLanguageChange={handleLanguageChange}
    />
  ), [serverType, localHost, remoteHost, getServerUrl, autoUploadEnabled, persistAutoUploadEnabled, fastModeEnabled, persistFastModeEnabled, glassModeEnabled, persistGlassModeEnabled, loading, logout, cameraPermission, currentLanguage, handleLanguageChange]);

  const memoizedDocsContent = useMemo(() => <DocsScreen appVersion={APP_VERSION} />, []);

  const handleViewCertificates = useCallback(() => setNftCertsOpen(true), []);

  const handleOpenDevicePairing = useCallback(() => {
    if (!nftIsPremium && !subscriptionStatus?.isActive) {
      showDarkAlert(
        t('pairing.premiumRequiredTitle') || 'Premium or Subscription Required',
        t('pairing.premiumRequiredMsg') || 'Pairing phones and tablets is available to Premium users and active subscribers. Upgrade in the Info tab to share your account across devices.'
      );
      return;
    }
    setDevicePairingOpen(true);
  }, [nftIsPremium, subscriptionStatus]);

  if (view === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }} onTouchStart={handleGlobalUserActivity}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        <GradientSpinner size={90} />
      </View>
    );
  }

  /* Old LoginScreen hidden — wallet-based auth replaces it. Logic preserved for future development. */
  if (false && view === 'auth') {
    return (
      <SafeAreaView style={styles.container} onTouchStart={handleGlobalUserActivity}>
        <StatusBar barStyle="light-content" backgroundColor="#060608" />
        <LoginScreen
          appDisplayName={APP_DISPLAY_NAME}
          appIcon={require('./assets/splash-icon.png')}
          serverType={serverType}
          setServerType={setServerType}
          authMode={authMode}
          setAuthMode={(mode) => {
            setAuthMode(mode);
            // When user switches to login on first run, show server options
            if (mode === 'login' && isFirstRun) {
              setIsFirstRun(false);
            }
          }}
          isFirstRun={isFirstRun}
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          confirmPassword={confirmPassword}
          setConfirmPassword={setConfirmPassword}
          newPassword={newPassword}
          setNewPassword={setNewPassword}
          localHost={localHost}
          setLocalHost={setLocalHost}
          remoteHost={remoteHost}
          setRemoteHost={setRemoteHost}
          termsAccepted={termsAccepted}
          setTermsAccepted={setTermsAccepted}
          selectedStealthPlanGb={selectedStealthPlanGb}
          setSelectedStealthPlanGb={setSelectedStealthPlanGb}
          loading={loading}
          authLoadingLabel={authLoadingLabel}
          handleAuth={handleAuth}
          handleResetPassword={handleResetPassword}
          normalizeHostInput={normalizeHostInput}
          openQrScanner={async () => {
            if (!cameraPermission?.granted) {
              const result = await requestCameraPermission();
              if (!result.granted) {
                showDarkAlert(t('login.cameraPermissionTitle'), t('login.cameraPermissionMessage'));
                return;
              }
            }
            setQrScannerOpen(true);
          }}
          openQuickSetupGuide={() => setQuickSetupCollapsed(false)}
          STEALTH_PLAN_TIERS={STEALTH_PLAN_TIERS}
          availablePlans={availablePlans}
          getStealthCloudTierStatus={getStealthCloudTierStatus}
          stealthCapacityLoading={stealthCapacityLoading}
          stealthCapacityError={stealthCapacityError}
          stealthCapacity={stealthCapacity}
          plansLoading={plansLoading}
          purchaseLoading={purchaseLoading}
        />

        {/* Keep overlays for loading, alerts, QR scanner, and quick setup guide */}
        {loading && (
          <View style={[styles.overlay, { backgroundColor: '#000' }]}>
            <View style={{ alignItems: 'center', justifyContent: 'center' }}>
              <GradientSpinner size={isTablet ? 90 : 70} />
              <Text style={{ color: '#fff', fontSize: scale(16), fontWeight: '600', marginTop: scaleSpacing(20) }}>{authLoadingLabel}</Text>
              <Text style={{ color: '#888', fontSize: scale(13), marginTop: scaleSpacing(8) }}>{t('alerts.pleaseWait')}</Text>
            </View>
          </View>
        )}

        {customAlert && (
          <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass]}>
            <View style={[styles.overlayCard, glassModeEnabled && styles.overlayCardGlass, { backgroundColor: glassModeEnabled ? 'rgba(30, 30, 30, 0.9)' : '#1E1E1E', maxWidth: isTablet ? 480 : 340 }]}>
              <Text style={[styles.overlayTitle, { fontSize: scale(18), marginBottom: scaleSpacing(8) }]}>{customAlert.title}</Text>
              <Text style={{ color: '#CCC', fontSize: scale(14), textAlign: 'center', marginBottom: scaleSpacing(14), lineHeight: scale(20) }}>{customAlert.message}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: scaleSpacing(12), flexWrap: 'wrap' }}>
                {(customAlert.buttons || []).map((btn, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={[styles.overlayBtnPrimary, glassModeEnabled && styles.overlayBtnPrimaryGlass, { paddingVertical: scaleSpacing(10), paddingHorizontal: scaleSpacing(24), minWidth: isTablet ? 110 : 90 }]}
                    onPress={() => { closeDarkAlert(); if (btn.onPress) btn.onPress(); }}>
                    <Text style={styles.overlayBtnPrimaryText} numberOfLines={1}>{btn.text}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}

        {qrScannerOpen && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' }}>
            {cameraPermission?.granted ? (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                autofocus="on"
                zoom={0}
                barcodeScannerSettings={{
                  barcodeTypes: ['qr'],
                  interval: 100,
                }}
                onBarcodeScanned={(result) => {
                  if (result && result.data) {
                    handleQRCodeScanned(result.data);
                  }
                }}
              />
            ) : (
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
                <Text style={{ color: '#888', textAlign: 'center', padding: scaleSpacing(20), fontSize: scale(14) }}>
                  {t('permissions.cameraRequired')}
                </Text>
                <TouchableOpacity
                  style={{ backgroundColor: '#A78BFA', paddingHorizontal: scaleSpacing(20), paddingVertical: scaleSpacing(10), borderRadius: scaleSpacing(8) }}
                  onPress={requestCameraPermission}>
                  <Text style={{ color: '#000000', fontWeight: '700', fontSize: scale(14) }}>{t('permissions.grant')}</Text>
                </TouchableOpacity>
              </View>
            )}
            {/* Overlay UI on top of camera - only show when permission granted */}
            {cameraPermission?.granted ? (
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' }}>
                {/* Top bar with title */}
                <View style={{ paddingTop: overlayHeaderPaddingTop, paddingHorizontal: scaleSpacing(20), backgroundColor: 'rgba(0,0,0,0.5)' }}>
                  <Text style={{ color: '#fff', fontSize: scale(18), fontWeight: '600', textAlign: 'center' }}>
                    {t('qrScanner.title')}
                  </Text>
                  <Text style={{ color: '#aaa', fontSize: scale(13), textAlign: 'center', marginTop: scaleSpacing(4) }}>
                    {t('qrScanner.instruction')}
                  </Text>
                </View>
                {/* Center scanning frame */}
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                  <View style={{ width: isTablet ? 280 : 240, height: isTablet ? 280 : 240, borderWidth: 2, borderColor: '#A78BFA', borderRadius: scaleSpacing(16) }} />
                </View>
                {/* Bottom bar with cancel button */}
                <View style={{ paddingBottom: scaleSpacing(16) + bottomInset, paddingHorizontal: scaleSpacing(20), backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center' }}>
                  <TouchableOpacity
                    style={{ paddingVertical: scaleSpacing(14), paddingHorizontal: scaleSpacing(50), backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: scaleSpacing(12), borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}
                    onPress={() => setQrScannerOpen(false)}>
                    <Text style={{ color: '#fff', fontSize: scale(16), fontWeight: '600' }}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' }}>
                {/* Top bar with title - full screen permission view */}
                <View style={{ paddingTop: overlayHeaderPaddingTop, paddingHorizontal: scaleSpacing(20) }}>
                  <Text style={{ color: '#fff', fontSize: scale(18), fontWeight: '600', textAlign: 'center' }}>
                    {t('qrScanner.title')}
                  </Text>
                  <Text style={{ color: '#aaa', fontSize: scale(13), textAlign: 'center', marginTop: scaleSpacing(4) }}>
                    {t('qrScanner.instruction')}
                  </Text>
                </View>
                {/* Bottom bar with cancel button */}
                <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: scaleSpacing(16) + bottomInset, paddingHorizontal: scaleSpacing(20), alignItems: 'center' }}>
                  <TouchableOpacity
                    style={{ paddingVertical: scaleSpacing(14), paddingHorizontal: scaleSpacing(50), backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: scaleSpacing(12), borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}
                    onPress={() => setQrScannerOpen(false)}>
                    <Text style={{ color: '#fff', fontSize: scale(16), fontWeight: '600' }}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {!quickSetupCollapsed && serverType !== 'stealthcloud' && (
          <View style={[styles.overlay, { backgroundColor: '#000000' }]}>
            <View style={[styles.overlayCard, { backgroundColor: '#000000', maxWidth: 420, width: '94%', padding: scaleSpacing(20) }]}>
              {/* Header */}
              <View style={{ marginBottom: scaleSpacing(20) }}>
                <Text style={{ color: '#FFFFFF', fontSize: scale(20), fontWeight: '700', marginBottom: scaleSpacing(4) }}>
                  {serverType === 'local' ? t('quickSetup.localNetworkSetup') : t('quickSetup.remoteServerSetup')}
                </Text>
                <Text style={{ color: '#888888', fontSize: scale(13) }}>
                  {serverType === 'local' ? t('quickSetup.localNetworkDesc') : t('quickSetup.remoteServerDesc')}
                </Text>
              </View>

              {serverType === 'local' && (
                <>
                  {/* Step 1: Download */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: scaleSpacing(16) }}>
                    <View style={{ width: scale(28), height: scale(28), borderRadius: scale(14), backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(12) }}>
                      <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '700' }}>1</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#FFFFFF', fontSize: scale(15), fontWeight: '600', marginBottom: scaleSpacing(6) }}>{t('quickSetup.step1Local')}</Text>
                      <TouchableOpacity
                        style={{ backgroundColor: '#1A1A1A', borderRadius: scale(8), padding: scaleSpacing(12), borderWidth: 1, borderColor: '#333' }}
                        onPress={() => { Clipboard.setStringAsync(GITHUB_RELEASES_LATEST_URL); showDarkAlert(t('alerts.copied'), t('alerts.linkCopied')); }}
                        onLongPress={() => openLink(GITHUB_RELEASES_LATEST_URL)}>
                        <Text style={{ color: '#FFFFFF', fontSize: scale(11) }} numberOfLines={1} ellipsizeMode="middle">{GITHUB_RELEASES_LATEST_URL}</Text>
                        <Text style={{ color: '#888', fontSize: scale(10), marginTop: 4 }}>{t('quickSetup.tapToCopyLink')}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Step 2: Scan QR in Settings */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: scaleSpacing(16) }}>
                    <View style={{ width: scale(28), height: scale(28), borderRadius: scale(14), backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(12) }}>
                      <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '700' }}>2</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#FFFFFF', fontSize: scale(15), fontWeight: '600', marginBottom: scaleSpacing(6) }}>{t('quickSetup.step2Local')}</Text>
                      <Text style={{ color: '#888', fontSize: scale(12) }}>{t('quickSetup.step2LocalDesc')}</Text>
                    </View>
                  </View>

                  {/* Step 3: Start backing up */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                    <View style={{ width: scale(28), height: scale(28), borderRadius: scale(14), backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(12) }}>
                      <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '700' }}>3</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#FFFFFF', fontSize: scale(15), fontWeight: '600' }}>{t('quickSetup.step3')}</Text>
                      <Text style={{ color: '#888', fontSize: scale(12), marginTop: 4 }}>{t('quickSetup.step3LocalDesc')}</Text>
                    </View>
                  </View>
                </>
              )}

              {serverType === 'remote' && (
                <>
                  {/* Step 1: Run install script */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: scaleSpacing(16) }}>
                    <View style={{ width: scale(28), height: scale(28), borderRadius: scale(14), backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(12) }}>
                      <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '700' }}>1</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#FFFFFF', fontSize: scale(15), fontWeight: '600', marginBottom: scaleSpacing(6) }}>{t('quickSetup.step1Remote')}</Text>
                      <TouchableOpacity
                        style={{ backgroundColor: '#1A1A1A', borderRadius: scale(8), padding: scaleSpacing(12), borderWidth: 1, borderColor: '#333' }}
                        onPress={() => { Clipboard.setStringAsync('sudo curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoLynk/main/install-server.sh | bash'); showDarkAlert(t('alerts.copied'), t('alerts.commandCopied')); }}
                        onLongPress={() => openLink('https://github.com/viktorvishyn369/PhotoLynk/blob/main/install-server.sh')}>
                        <Text style={{ color: '#FFFFFF', fontSize: scale(10) }} numberOfLines={2}>sudo curl -fsSL https://...install-server.sh | bash</Text>
                        <Text style={{ color: '#888', fontSize: scale(10), marginTop: 4 }}>{t('quickSetup.tapToCopyCommand')}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Step 2: Enter domain in Settings */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: scaleSpacing(16) }}>
                    <View style={{ width: scale(28), height: scale(28), borderRadius: scale(14), backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(12) }}>
                      <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '700' }}>2</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#FFFFFF', fontSize: scale(15), fontWeight: '600', marginBottom: scaleSpacing(6) }}>{t('quickSetup.step2Remote')}</Text>
                      <Text style={{ color: '#888', fontSize: scale(12) }}>{t('quickSetup.step2RemoteDesc')}</Text>
                    </View>
                  </View>

                  {/* Step 3: Start backing up */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                    <View style={{ width: scale(28), height: scale(28), borderRadius: scale(14), backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(12) }}>
                      <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '700' }}>3</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#FFFFFF', fontSize: scale(15), fontWeight: '600' }}>{t('quickSetup.step3')}</Text>
                      <Text style={{ color: '#888', fontSize: scale(12), marginTop: 4 }}>{t('quickSetup.step3RemoteDesc')}</Text>
                    </View>
                  </View>
                </>
              )}

              {/* StealthCloud setup instructions - hidden for now, kept for future use
            {serverType === 'stealthcloud' && (
              <View style={{ backgroundColor: '#1A1A1A', borderRadius: scale(12), padding: scaleSpacing(14), borderWidth: 1, borderColor: '#2A2A2A' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: scaleSpacing(10) }}>
                  <Feather name="zap" size={scale(16)} color="#8B5CF6" />
                  <Text style={{ color: '#8B5CF6', fontSize: scale(13), fontWeight: '600', marginLeft: scaleSpacing(8) }}>GETTING STARTED</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: scaleSpacing(6) }}>
                  <View style={{ width: scale(20), height: scale(20), borderRadius: scale(10), backgroundColor: '#8B5CF6', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(10) }}>
                    <Text style={{ color: '#fff', fontSize: scale(11), fontWeight: '700' }}>1</Text>
                  </View>
                  <Text style={{ color: '#FFFFFF', fontSize: scale(13) }}>Create account & log in</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: scaleSpacing(6) }}>
                  <View style={{ width: scale(20), height: scale(20), borderRadius: scale(10), backgroundColor: '#8B5CF6', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(10) }}>
                    <Text style={{ color: '#fff', fontSize: scale(11), fontWeight: '700' }}>2</Text>
                  </View>
                  <Text style={{ color: '#FFFFFF', fontSize: scale(13) }}>Start backing up (7-day free trial)</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: scaleSpacing(10) }}>
                  <View style={{ width: scale(20), height: scale(20), borderRadius: scale(10), backgroundColor: '#8B5CF6', alignItems: 'center', justifyContent: 'center', marginRight: scaleSpacing(10) }}>
                    <Text style={{ color: '#fff', fontSize: scale(11), fontWeight: '700' }}>3</Text>
                  </View>
                  <Text style={{ color: '#FFFFFF', fontSize: scale(13) }}>Pick a plan when ready</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(139, 92, 246, 0.1)', borderRadius: scale(8), padding: scaleSpacing(10) }}>
                  <Feather name="shield" size={scale(14)} color="#8B5CF6" />
                  <Text style={{ color: '#888', fontSize: scale(11), marginLeft: scaleSpacing(8), flex: 1 }}>Zero-knowledge encryption: only your device can decrypt your data.</Text>
                </View>
              </View>
            )}
            */}

              <TouchableOpacity
                style={{ marginTop: scaleSpacing(16), backgroundColor: '#1A1A1A', borderRadius: scale(12), paddingVertical: scaleSpacing(14), alignItems: 'center', borderWidth: 1, borderColor: '#2A2A2A' }}
                onPress={() => { setQuickSetupCollapsed(true); setQuickSetupHighlightInput(false); }}>
                <Text style={{ color: '#FFFFFF', fontSize: scale(15), fontWeight: '600' }}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container} onTouchStart={handleGlobalUserActivity}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      <HomeScreen
        appDisplayName={APP_DISPLAY_NAME}
        appVersion={APP_VERSION}
        serverType={serverType}
        status={status}
        progress={progress}
        progressAction={progressAction}
        loading={loading}
        glassModeEnabled={glassModeEnabled}
        qsEmail={getQuickAccountDisplay()}
        qsWalletAddress={qsWalletAddress}
        qsNftCount={qsNftCount}
        qsLastBackupTime={qsLastBackupTime}
        nftWeeklyDiscountPercent={nftDisplayFeeDiscountPercent}
        nftHomeSkrFeeQuote={nftHomeSkrFeeQuote}
        nftFeesWaived={nftFeesWaived}
        isPremiumFreeMint={isPremiumFreeMintHome}
        isPremiumBeyond100={isPremiumBeyond100Home}
        isMonthlySubscriber={isMonthlySubscriberHome}
        isPairedAccount={isPairedSession}
        activeTab={homeActiveTab}
        onTabChange={handleTabChange}
        infoContent={memoizedInfoContent}
        settingsContent={memoizedSettingsContent}
        docsContent={memoizedDocsContent}
        onLogout={logout}
        onCleanBestMatches={cleanDeviceDuplicates}
        onCleanSimilar={startSimilarShotsReview}
        onBackupAll={backupPhotos}
        onLongPressBackup={secretClearBackupHistory}
        onBackupSelected={openBackupPicker}
        onSyncAll={restorePhotos}
        onLongPressSync={secretClearSyncHistory}
        onSyncSelected={openSyncPicker}
        showCompletionTick={showCompletionTick}
        completionMessage={completionMessage}
        onDismissCompletionTick={dismissCompletionTick}
        onMintNFT={openNftPicker}
        nftMinting={nftMinting}
        onViewNFTs={openNftGallery}
        onViewCertificates={handleViewCertificates}
        canPairDevices={!!nftIsPremium || !!subscriptionStatus?.isActive}
        onOpenDevicePairing={handleOpenDevicePairing}
        showDarkAlert={showDarkAlert}
      />

      {/* Cross-app device pairing (solana-seeker ↔ mobile-v2 QR linking) */}
      {devicePairingOpen && <DevicePairing
        visible={devicePairingOpen}
        onClose={() => setDevicePairingOpen(false)}
        token={token}
        deviceUuid={deviceUuid}
        serverUrl={getServerUrl()}
        email={email}
        password={password || pairingPassword}
        mkEmail={pairingMkEmail}
        mkPassword={pairingMkPassword}
        onPaired={(pairedUuid) => {
          console.log('[Pairing] Device paired:', pairedUuid);
        }}
        onSwitchAccount={async (pairedEmail, pairedPassword, pairedMkEmail, pairedMkPassword) => {
          // Logout and login with paired device credentials
          console.log('[Pairing] Switching to paired device account');
          setStatus(t('pairing.switchingAccount') || 'Switching accounts...');
          setLoadingSafe(true);
          beginAccountTransition(t('pairing.switchingAccount') || 'Switching accounts...');

          // Save original credentials before switching so we can restore on logout.
          // Use in-memory email + password state (or pairingPassword fallback) — avoids
          // iOS biometric issue where SecureStore returns null for requireAuthentication:false.
          // Only save if not already paired — keep the true original, not the paired creds.
          if (!isPairedSession) {
            let origEmail = email;
            let origPassword = password || pairingPassword;
            if (!origEmail) {
              try {
                origEmail = await SecureStore.getItemAsync('user_email');
              } catch (_) { }
            }
            if (!origPassword) {
              try {
                origPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, { requireAuthentication: false });
              } catch (_) { }
              if (!origPassword) {
                try {
                  origPassword = await SecureStore.getItemAsync('user_password_v1', { requireAuthentication: false });
                } catch (_) { }
              }
            }
            if (origEmail && origPassword) {
              try {
                await SecureStore.setItemAsync('paired_original_email', origEmail);
                await SecureStore.setItemAsync('paired_original_password', origPassword);
                if (deviceUuid) {
                  await SecureStore.setItemAsync('paired_original_device_uuid', deviceUuid);
                }
              } catch (e) {
                console.log('[Pairing] Failed to save original credentials:', e.message);
              }
            }
          }

          await logout({ forgetCredentials: false, skipPairedRestore: true, preserveTransitionOverlay: true });

          // If paired device sent master key credentials (migrated legacy→wallet user),
          // store them so the master key derives correctly after login.
          if (pairedMkEmail && pairedMkPassword) {
            try {
              await SecureStore.setItemAsync('legacy_mk_email', pairedMkEmail);
              await SecureStore.setItemAsync('legacy_mk_password', pairedMkPassword);
              console.log('[Pairing] Stored paired master key credentials for correct SC decryption');
            } catch (e) {
              console.log('[Pairing] Failed to store MK credentials:', e.message);
            }
          }

          try {
            await handleAuth('login', { email: pairedEmail, password: pairedPassword, throwOnError: true });
            setEmail(pairedEmail);
            setPassword(pairedPassword);
            setQsSeekerId(isWalletDerivedAccountEmail(pairedEmail) ? emailToSeekerId(pairedEmail) : null);
            setIsPairedSession(true);
            try { await SecureStore.setItemAsync('paired_session_active', 'true'); } catch (_) { }
            resetSyncPickerState();
            setStatus('');
          } catch (e) {
            console.log('[Pairing] Switch login failed:', e?.message);
            setLoadingSafe(false);
            setStatus('');
            setView('home');
            setShowWalletLogin(true);
            setShowEmailLogin(false);
            setShowRecoveryKitLogin(false);
          } finally {
            endAccountTransition();
          }
        }}
      />}

      {accountTransitionLabel ? (
        <View style={[styles.overlay, { backgroundColor: '#000000', zIndex: 10050, elevation: 10050 }]}>
          <View style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: scaleSpacing(24) }}>
            <GradientSpinner size={isTablet ? 94 : 76} />
            <Text style={{ color: '#fff', fontSize: scale(17), fontWeight: '700', marginTop: scaleSpacing(22), textAlign: 'center' }}>{accountTransitionLabel}</Text>
            <Text style={{ color: '#7EE7F7', fontSize: scale(13), marginTop: scaleSpacing(8), textAlign: 'center' }}>{t('alerts.pleaseWait')}</Text>
          </View>
        </View>
      ) : null}

      {qrScannerOpen && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', zIndex: 10001, elevation: 10001 }}>
          {cameraPermission?.granted ? (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              autofocus="on"
              zoom={0}
              barcodeScannerSettings={{
                barcodeTypes: ['qr'],
                interval: 100,
              }}
              onBarcodeScanned={(result) => {
                if (result && result.data) {
                  handleQRCodeScanned(result.data);
                }
              }}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
              <Text style={{ color: '#888', textAlign: 'center', padding: scaleSpacing(20), fontSize: scale(14) }}>
                {t('permissions.cameraRequired')}
              </Text>
              <TouchableOpacity
                style={{ backgroundColor: '#A78BFA', paddingHorizontal: scaleSpacing(20), paddingVertical: scaleSpacing(10), borderRadius: scaleSpacing(8) }}
                onPress={requestCameraPermission}>
                <Text style={{ color: '#000000', fontWeight: '700', fontSize: scale(14) }}>{t('permissions.grant')}</Text>
              </TouchableOpacity>
            </View>
          )}
          {cameraPermission?.granted ? (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' }}>
              <View style={{ paddingTop: overlayHeaderPaddingTop, paddingHorizontal: scaleSpacing(20), backgroundColor: 'rgba(0,0,0,0.5)' }}>
                <Text style={{ color: '#fff', fontSize: scale(18), fontWeight: '600', textAlign: 'center' }}>
                  {t('qrScanner.title')}
                </Text>
                <Text style={{ color: '#aaa', fontSize: scale(13), textAlign: 'center', marginTop: scaleSpacing(4) }}>
                  {t('qrScanner.instruction')}
                </Text>
              </View>
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <View style={{ width: isTablet ? 280 : 240, height: isTablet ? 280 : 240, borderWidth: 2, borderColor: '#A78BFA', borderRadius: scaleSpacing(16) }} />
              </View>
              <View style={{ paddingBottom: scaleSpacing(16) + bottomInset, paddingHorizontal: scaleSpacing(20), backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center' }}>
                <TouchableOpacity
                  style={{ paddingVertical: scaleSpacing(14), paddingHorizontal: scaleSpacing(50), backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: scaleSpacing(12), borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}
                  onPress={() => setQrScannerOpen(false)}>
                  <Text style={{ color: '#fff', fontSize: scale(16), fontWeight: '600' }}>{t('common.cancel')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' }}>
              <View style={{ paddingTop: overlayHeaderPaddingTop, paddingHorizontal: scaleSpacing(20) }}>
                <Text style={{ color: '#fff', fontSize: scale(18), fontWeight: '600', textAlign: 'center' }}>
                  {t('qrScanner.title')}
                </Text>
                <Text style={{ color: '#aaa', fontSize: scale(13), textAlign: 'center', marginTop: scaleSpacing(4) }}>
                  {t('qrScanner.instruction')}
                </Text>
              </View>
              <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: scaleSpacing(16) + bottomInset, paddingHorizontal: scaleSpacing(20), alignItems: 'center' }}>
                <TouchableOpacity
                  style={{ paddingVertical: scaleSpacing(14), paddingHorizontal: scaleSpacing(50), backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: scaleSpacing(12), borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}
                  onPress={() => setQrScannerOpen(false)}>
                  <Text style={{ color: '#fff', fontSize: scale(16), fontWeight: '600' }}>{t('common.cancel')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}

      {loading && !progressAction && (
        <View style={[styles.overlay, { backgroundColor: '#000', zIndex: 9998 }]}>
          <View style={{ alignItems: 'center', justifyContent: 'center' }}>
            <GradientSpinner size={isTablet ? 90 : 70} />
            <Text style={{ color: '#fff', fontSize: scale(16), fontWeight: '600', marginTop: scaleSpacing(20) }}>{status || t('alerts.pleaseWait')}</Text>
            <Text style={{ color: '#888', fontSize: scale(13), marginTop: scaleSpacing(8) }}>{t('alerts.pleaseWait')}</Text>
          </View>
        </View>
      )}

      {cleanupModeOpen && (
        <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass]}>
          <View style={[styles.overlayCard, glassModeEnabled && styles.overlayCardGlass]}>
            <Text style={styles.overlayTitle}>{t('cleanup.title')}</Text>
            <Text style={styles.overlaySubtitle}>{t('cleanup.subtitle')}</Text>

            <TouchableOpacity
              style={[styles.overlayBtnPrimary, glassModeEnabled && styles.overlayBtnPrimaryGlass]}
              onPress={async () => {
                closeCleanupModeChooser();
                await cleanDeviceDuplicates();
              }}>
              <Text style={styles.overlayBtnPrimaryText}>{t('cleanup.identicalPhotosVideos')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.overlayBtnSecondary, glassModeEnabled && styles.overlayBtnSecondaryGlass]}
              onPress={async () => {
                closeCleanupModeChooser();
                await startSimilarShotsReview();
              }}>
              <Text style={styles.overlayBtnSecondaryText}>{t('similarPhotos.title')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.overlayBtnGhost, glassModeEnabled && styles.overlayBtnGhostGlass]}
              onPress={closeCleanupModeChooser}>
              <Text style={styles.overlayBtnGhostText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {similarReviewOpen && (() => {
        const CLEANUP_MAGENTA = '#A78BFA'; // Magenta color for clean duplicates
        const currentGroup = (similarGroups || [])[similarGroupIndex] || [];
        const currentPhoto = currentGroup[similarPhotoIndex] || null;
        const currentPhotoId = currentPhoto && currentPhoto.id ? String(currentPhoto.id) : '';
        const isSelected = !!(similarSelected && similarSelected[currentPhotoId]);
        const totalInGroup = currentGroup.length || 0;
        const totalGroups = (similarGroups || []).length || 0;
        const selectedCount = getSimilarSelectedIds().length || 0;
        const similarGroupKey = `${similarGroupIndex}:${totalInGroup}:${String(currentGroup?.[0]?.id || '')}:${String(currentGroup?.[totalInGroup - 1]?.id || '')}`;

        // Safety check - close if no valid data
        if (!currentGroup.length || !currentPhoto) {
          return null;
        }

        return (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' }}>
            {/* Header */}
            <View style={{ paddingTop: fullscreenHeaderPaddingTop, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: 'rgba(0,0,0,0.8)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <TouchableOpacity onPress={closeSimilarReview} style={{ padding: 8 }}>
                  <Text style={{ color: CLEANUP_MAGENTA, fontSize: scale(16), fontWeight: '600' }}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <Text style={{ color: '#FFF', fontSize: scale(16), fontWeight: '700' }}>{t('similarPhotos.title')}</Text>
                <View style={{ width: 60 }} />
              </View>
              <Text style={{ color: '#888', fontSize: scale(12), textAlign: 'center', marginTop: 4 }} numberOfLines={1}>{t('similarPhotos.setInfo', { set: similarGroupIndex + 1, total: totalGroups })} • {t('similarPhotos.photoInfo', { photo: similarPhotoIndex + 1, total: totalInGroup })}</Text>
            </View>

            {/* Full-screen photo */}
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              {currentPhoto && (
                <Image
                  source={{ uri: currentPhoto.uri }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="contain"
                />
              )}

              {/* Selection overlay badge */}
              {isSelected && (
                <View style={{ position: 'absolute', top: 20, right: 20, backgroundColor: 'rgba(255,59,48,0.9)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 }}>
                  <Text style={{ color: '#FFF', fontSize: scale(14), fontWeight: '700' }}>{t('similarPhotos.markedForDeletion')}</Text>
                </View>
              )}

              {/* Photo info */}
              {currentPhoto && (
                <View style={{ position: 'absolute', bottom: 20 + bottomInset, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.7)', padding: 12, borderRadius: 12, alignItems: 'center' }}>
                  <Text style={{ color: '#FFF', fontSize: scale(13), fontWeight: '600', textAlign: 'center' }}>{currentPhoto.filename || 'Unknown'}</Text>
                  {(currentPhoto.created > 0 || currentPhoto.creationTime > 0) ? (
                    <Text style={{ color: '#AAA', fontSize: scale(11), marginTop: 4, textAlign: 'center' }}>
                      {new Date(currentPhoto.created || currentPhoto.creationTime).toLocaleString()}
                    </Text>
                  ) : null}
                </View>
              )}

              {/* Left/Right navigation arrows */}
              {similarPhotoIndex > 0 && (
                <TouchableOpacity
                  style={{ position: 'absolute', left: 10, top: '50%', marginTop: -30, backgroundColor: 'rgba(255,255,255,0.2)', width: 50, height: 60, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }}
                  onPress={() => setSimilarPhotoIndex(prev => Math.max(0, prev - 1))}>
                  <Text style={{ color: '#FFF', fontSize: 28, fontWeight: '300' }}>‹</Text>
                </TouchableOpacity>
              )}
              {similarPhotoIndex < totalInGroup - 1 && (
                <TouchableOpacity
                  style={{ position: 'absolute', right: 10, top: '50%', marginTop: -30, backgroundColor: 'rgba(255,255,255,0.2)', width: 50, height: 60, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }}
                  onPress={() => setSimilarPhotoIndex(prev => Math.min(totalInGroup - 1, prev + 1))}>
                  <Text style={{ color: '#FFF', fontSize: 28, fontWeight: '300' }}>›</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Thumbnail strip */}
            <View style={{ backgroundColor: 'rgba(0,0,0,0.9)', paddingVertical: 8, minHeight: 86 }}>
              <ScrollView key={`thumbstrip-${similarGroupKey}`} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12 }}>
                {currentGroup.map((a, idx) => {
                  const thumbSelected = !!(similarSelected && similarSelected[String(a && a.id ? a.id : '')]);
                  const isCurrent = idx === similarPhotoIndex;
                  const thumbUri = (a && (a.thumbUri || a.uri)) ? (a.thumbUri || a.uri) : null;
                  return (
                    <TouchableOpacity
                      key={`${similarGroupKey}-${a.id}`}
                      style={{ width: 70, height: 70, marginRight: 8, borderRadius: 8, overflow: 'hidden', borderWidth: isCurrent ? 3 : 2, borderColor: isCurrent ? CLEANUP_MAGENTA : (thumbSelected ? '#FF3B30' : '#333') }}
                      onPress={() => setSimilarPhotoIndex(idx)}>
                      {thumbUri ? (
                        <Image
                          key={`img-${similarGroupKey}-${a.id}`}
                          source={{ uri: thumbUri }}
                          style={{ width: '100%', height: '100%' }}
                          onError={() => { try { void ensureSimilarThumb(a); } catch (e) { } }}
                        />
                      ) : (
                        <View style={{ width: '100%', height: '100%', backgroundColor: '#111' }} />
                      )}
                      {thumbSelected && (
                        <View style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: '#FF3B30', justifyContent: 'center', alignItems: 'center' }}>
                          <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '900' }}>✓</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Bottom action bar */}
            <View style={{ backgroundColor: 'rgba(0,0,0,0.95)', paddingBottom: 16 + bottomInset, paddingTop: 12, paddingHorizontal: 16 }}>
              {/* Toggle selection button */}
              <TouchableOpacity
                style={{ backgroundColor: isSelected ? '#333' : '#FF3B30', paddingVertical: 14, borderRadius: 12, marginBottom: 10, alignItems: 'center', paddingHorizontal: 8 }}
                onPress={() => toggleSimilarSelected(currentPhotoId)}>
                <Text style={{ color: '#FFF', fontSize: scale(15), fontWeight: '700', textAlign: 'center' }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                  {isSelected ? t('similarPhotos.keepThisPhoto') : t('similarPhotos.markForDeletion')}
                </Text>
              </TouchableOpacity>

              <View style={{ flexDirection: 'row' }}>
                {/* Delete selected */}
                <TouchableOpacity
                  disabled={selectedCount === 0 || loading}
                  style={{ flex: 1, marginRight: 5, backgroundColor: selectedCount > 0 ? CLEANUP_MAGENTA : '#333', paddingVertical: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', opacity: selectedCount === 0 ? 0.5 : 1 }}
                  onPress={async () => {
                    const ids = getSimilarSelectedIds();
                    if (ids.length === 0) return;
                    setLoadingSafe(true);
                    setStatus(t('status.deletingItems', { count: ids.length }));
                    let didDelete = false;
                    let thisDeletedCount = 0;

                    try {
                      // Use batched deletion to avoid crashes with large numbers of files
                      const DuplicateScanner = require('./duplicateScannerOptimized').default;
                      console.log('Similar Photos: Using batched deletion for', ids.length, 'items');
                      const result = await DuplicateScanner.deleteAssets(ids, (progress, deleted, total) => {
                        setStatus(t('status.deletingProgress', { deleted, total }));
                      });
                      thisDeletedCount = result.deleted;
                      if (thisDeletedCount > 0) {
                        didDelete = true;
                        similarDeletedTotalRef.current += thisDeletedCount;
                        setSimilarDeletedTotal(similarDeletedTotalRef.current);
                        setStatus(t('status.deletedItems', { count: thisDeletedCount }));
                      } else {
                        setStatus(t('status.deletionCancelled'));
                      }
                    } catch (e) {
                      console.log('Similar Photos: Delete error', e?.message || e);
                      const msg = String(e?.message || e || '');
                      const isUserCancelled = Platform.OS === 'ios' && msg.includes('PHPhotosErrorDomain') && msg.includes('3072');
                      if (isUserCancelled) {
                        setStatus(t('status.deletionCancelled'));
                      } else {
                        setStatus(t('status.deletionFailed'));
                        showDarkAlert(t('alerts.deleteFailed'), e?.message || t('alerts.deleteFailedMessage'));
                      }
                    }

                    setLoadingSafe(false);

                    if (!didDelete) return;

                    const prevGroups = Array.isArray(similarGroups) ? similarGroups : [];
                    const nextGroups = prevGroups
                      .map((g) => (Array.isArray(g) ? g.filter((it) => it && it.id && !ids.includes(String(it.id))) : []))
                      .filter((g) => Array.isArray(g) && g.length >= 2);

                    if (nextGroups.length === 0) {
                      // Use ref for accurate cumulative total (state is stale in async handlers)
                      const totalDeleted = similarDeletedTotalRef.current;
                      closeSimilarReview();
                      setStatus(t('status.cleanupComplete'));
                      showCompletionTickBriefly(t('results.filesDeleted', { count: totalDeleted }));
                      return;
                    }

                    const nextIndex = Math.min(similarGroupIndex, nextGroups.length - 1);
                    setSimilarGroups(nextGroups);
                    setSimilarGroupIndex(nextIndex);
                    setSimilarSelected(buildDefaultSimilarSelection(nextGroups[nextIndex] || []));
                    setSimilarPhotoIndex(0);
                  }}>
                  <Text style={{ color: selectedCount > 0 ? '#FFF' : '#888', fontSize: scale(14), fontWeight: '700', textAlign: 'center' }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                    {t('similarPhotos.delete')} {selectedCount > 0 ? `(${selectedCount})` : ''}
                  </Text>
                </TouchableOpacity>

                {/* Keep all / Next set */}
                <TouchableOpacity
                  style={{ flex: 1, marginLeft: 5, backgroundColor: '#222', paddingVertical: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#444', paddingHorizontal: 6 }}
                  onPress={() => {
                    advanceSimilarGroup({ groups: similarGroups, nextIndex: similarGroupIndex + 1 });
                  }}>
                  <Text style={{ color: '#FFF', fontSize: scale(14), fontWeight: '600', textAlign: 'center' }} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>
                    {(similarGroupIndex < totalGroups - 1 ? t('similarPhotos.keepAllNext') : t('similarPhotos.keepAllDone')) + (similarDeletedTotal > 0 ? ` (${similarDeletedTotal})` : '')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        );
      })()}

      {backupModeOpen && (
        <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass]}>
          <View style={[styles.overlayCard, glassModeEnabled && styles.overlayCardGlass]}>
            <Text style={styles.overlayTitle}>Backup to Cloud</Text>
            <Text style={styles.overlaySubtitle}>Choose how you want to upload{"\n"}(existing files on server will be skipped).</Text>

            <TouchableOpacity
              style={[styles.overlayBtnPrimary, glassModeEnabled && styles.overlayBtnPrimaryGlass]}
              onPress={async () => {
                closeBackupModeChooser();
                await backupPhotos();
              }}>
              <Text style={styles.overlayBtnPrimaryText}>All Photos & Videos</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.overlayBtnSecondary, glassModeEnabled && styles.overlayBtnSecondaryGlass]}
              onPress={async () => {
                closeBackupModeChooser();
                await openBackupPicker();
              }}>
              <Text style={styles.overlayBtnSecondaryText}>Choose Photos & Videos</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.overlayBtnGhost, glassModeEnabled && styles.overlayBtnGhostGlass]}
              onPress={closeBackupModeChooser}>
              <Text style={styles.overlayBtnGhostText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {backupPickerOpen && (
        <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass]}>
          <View style={[styles.pickerCard, glassModeEnabled && styles.pickerCardGlass]}>
            <View style={styles.pickerHeader}>
              <TouchableOpacity onPress={closeBackupPicker} style={styles.pickerHeaderBtn}>
                <Text style={[styles.pickerHeaderBtnText, { color: THEME.accent }]}>{t('picker.cancel')}</Text>
              </TouchableOpacity>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={styles.pickerHeaderTitle}>{t('picker.selectFiles')}</Text>
                <Text style={styles.pickerHeaderSubtitle}>{t('picker.selected', { count: Object.keys(backupPickerSelected || {}).filter(k => backupPickerSelected[k]).length })}</Text>
              </View>
              <TouchableOpacity
                disabled={Object.keys(backupPickerSelected || {}).filter(k => backupPickerSelected[k]).length === 0 || loading}
                onPress={async () => {
                  const selected = getSelectedPickerAssets();
                  closeBackupPicker();
                  await backupSelectedAssets({ assets: selected });
                }}
                style={styles.pickerHeaderBtn}>
                <Text style={[styles.pickerHeaderBtnText, { color: THEME.accent }]}>{t('picker.start')}</Text>
              </TouchableOpacity>
            </View>

            {serverType !== 'stealthcloud' ? (
              <View style={{ paddingHorizontal: scaleSpacing(12), paddingVertical: scaleSpacing(6), backgroundColor: '#1a1a1a' }}>
                <Text style={{ color: '#666', fontSize: scale(11), textAlign: 'center' }}>
                  {t('picker.previewsUnavailable')}
                </Text>
              </View>
            ) : null}

            {backupPickerLoading && (backupPickerAssets || []).length === 0 ? (
              <View style={{ width: '100%', paddingVertical: scaleSpacing(32), alignItems: 'center' }}>
                <ActivityIndicator size={isTablet ? 'large' : 'small'} color={THEME.accent} />
                <Text style={{ color: '#888', fontSize: scale(13), marginTop: scaleSpacing(10) }}>{t('picker.loadingFiles')}</Text>
              </View>
            ) : serverType === 'stealthcloud' ? (
              <FlatList
                data={backupPickerAssets || []}
                extraData={backupPickerSelected}
                keyExtractor={backupPickerKeyExtractor}
                ListHeaderComponent={
                  <View style={{ paddingHorizontal: scaleSpacing(12), paddingVertical: scaleSpacing(8), borderBottomWidth: 1, borderBottomColor: '#222', backgroundColor: '#121212' }}>
                    <Text style={{ color: '#888', fontSize: scale(12) }}>
                      {t('picker.showingFiles', { count: backupPickerAssets.length, total: backupPickerTotal > 0 ? backupPickerTotal : backupPickerAssets.length })}
                    </Text>
                  </View>
                }
                contentContainerStyle={styles.syncPickerList}
                onViewableItemsChanged={onBackupPickerViewableItemsChanged.current}
                viewabilityConfig={{ itemVisiblePercentThreshold: 55 }}
                getItemLayout={getBackupPickerListItemLayout}
                removeClippedSubviews={Platform.OS === 'android'}
                initialNumToRender={24}
                maxToRenderPerBatch={24}
                windowSize={7}
                onScrollBeginDrag={onBackupPickerScrollBegin}
                onMomentumScrollEnd={onBackupPickerScrollEnd}
                onScrollEndDrag={onBackupPickerScrollEnd}
                onEndReachedThreshold={0.7}
                onEndReached={() => {
                  if (backupPickerHasNext && !backupPickerLoading) {
                    loadBackupPickerPage({ reset: false });
                  }
                }}
                renderItem={renderBackupPickerListItem}
                ListFooterComponent={
                  <View style={{ width: '100%', paddingVertical: 12, paddingHorizontal: scaleSpacing(12), alignItems: 'center' }}>
                    {backupPickerLoading ? (
                      <ActivityIndicator size={isTablet ? 'large' : 'small'} color={THEME.accent} />
                    ) : (
                      <View style={{ height: 8 }} />
                    )}
                  </View>
                }
              />
            ) : (
              <FlatList
                data={backupPickerAssets || []}
                extraData={backupPickerSelected}
                keyExtractor={backupPickerKeyExtractor}
                numColumns={isTablet ? 4 : 3}
                ListEmptyComponent={backupPickerLoading ? (
                  <View style={{ width: '100%', paddingVertical: scaleSpacing(32), alignItems: 'center' }}>
                    <ActivityIndicator size={isTablet ? 'large' : 'small'} color={THEME.accent} />
                    <Text style={{ color: '#888', fontSize: scale(13), marginTop: scaleSpacing(10) }}>{t('picker.loadingFiles')}</Text>
                  </View>
                ) : null}
                contentContainerStyle={{ padding: scaleSpacing(10) }}
                columnWrapperStyle={{ justifyContent: 'space-between' }}
                getItemLayout={getBackupPickerGridItemLayout}
                removeClippedSubviews={Platform.OS === 'android'}
                initialNumToRender={24}
                maxToRenderPerBatch={24}
                windowSize={7}
                onScrollBeginDrag={onBackupPickerScrollBegin}
                onMomentumScrollEnd={onBackupPickerScrollEnd}
                onScrollEndDrag={onBackupPickerScrollEnd}
                onEndReachedThreshold={0.7}
                onEndReached={() => {
                  if (backupPickerHasNext && !backupPickerLoading) {
                    loadBackupPickerPage({ reset: false });
                  }
                }}
                renderItem={renderBackupPickerGridItem}
                ListFooterComponent={
                  <View style={{ width: '100%', paddingVertical: 12, paddingHorizontal: scaleSpacing(12), alignItems: 'center' }}>
                    {backupPickerLoading ? (
                      <ActivityIndicator size="small" color={THEME.accent} />
                    ) : (
                      <View style={{ height: 8 }} />
                    )}
                  </View>
                }
              />
            )}
          </View>
        </View>
      )}

      {backupPickerPreview && serverType === 'stealthcloud' && (
        <Modal
          visible={true}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setBackupPickerPreview(null)}>
          <TouchableOpacity
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' }}
            activeOpacity={1}
            onPress={() => setBackupPickerPreview(null)}>
            <View style={{ width: '90%', maxWidth: 400, backgroundColor: '#1a1a1a', borderRadius: scaleSpacing(12), overflow: 'hidden' }}>
              <Image
                source={{ uri: backupPickerPreview.uri }}
                style={{ width: '100%', aspectRatio: 1, resizeMode: 'contain', backgroundColor: '#000' }}
              />
              <View style={{ padding: scaleSpacing(12), borderTopWidth: 1, borderTopColor: '#333' }}>
                <Text style={{ color: '#fff', fontSize: scale(13), textAlign: 'center' }} numberOfLines={2} ellipsizeMode="middle">
                  {backupPickerPreview.filename}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={{ marginTop: scaleSpacing(16), paddingVertical: scaleSpacing(10), paddingHorizontal: scaleSpacing(24), backgroundColor: '#333', borderRadius: scaleSpacing(8) }}
              onPress={() => setBackupPickerPreview(null)}>
              <Text style={{ color: '#fff', fontSize: scale(14) }}>{t('common.close') || 'Close'}</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}

      {syncModeOpen && (
        <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass]}>
          <View style={[styles.overlayCard, glassModeEnabled && styles.overlayCardGlass]}>
            <Text style={styles.overlayTitle}>{t('sync.title')}</Text>
            <Text style={styles.overlaySubtitle}>{t('sync.subtitle')}</Text>

            <TouchableOpacity
              style={[styles.overlayBtnPrimary, glassModeEnabled && styles.overlayBtnPrimaryGlass]}
              onPress={async () => {
                closeSyncModeChooser();
                await restorePhotos();
              }}>
              <Text style={styles.overlayBtnPrimaryText}>{t('sync.allPhotosVideos')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.overlayBtnSecondary, glassModeEnabled && styles.overlayBtnSecondaryGlass]}
              onPress={async () => {
                closeSyncModeChooser();
                await openSyncPicker();
              }}>
              <Text style={styles.overlayBtnSecondaryText}>{t('sync.choosePhotosVideos')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.overlayBtnGhost, glassModeEnabled && styles.overlayBtnGhostGlass]}
              onPress={closeSyncModeChooser}>
              <Text style={styles.overlayBtnGhostText}>{t('picker.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {syncPickerOpen && (
        <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass]}>
          <View style={[styles.pickerCard, glassModeEnabled && styles.pickerCardGlass]}>
            <View style={styles.pickerHeader}>
              <TouchableOpacity onPress={closeSyncPicker} style={styles.pickerHeaderBtn}>
                <Text style={[styles.pickerHeaderBtnText, { color: THEME.secondary }]}>{t('picker.cancel')}</Text>
              </TouchableOpacity>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={styles.pickerHeaderTitle}>{t('picker.selectFiles')}</Text>
                <Text style={styles.pickerHeaderSubtitle}>{t('picker.selected', { count: getSelectedSyncKeys().length })}</Text>
              </View>
              <TouchableOpacity
                disabled={getSelectedSyncKeys().length === 0 || loading}
                onPress={async () => {
                  const selectedKeys = getSelectedSyncKeys();
                  closeSyncPicker();
                  await restorePhotos({ manifestIds: selectedKeys });
                }}
                style={styles.pickerHeaderBtn}>
                <Text style={[styles.pickerHeaderBtnText, { color: THEME.secondary }]}>{t('picker.start')}</Text>
              </TouchableOpacity>
            </View>

            {!syncPickerLoading && serverType !== 'stealthcloud' ? (
              <View style={{ width: '100%', paddingHorizontal: scaleSpacing(12), paddingVertical: scaleSpacing(6), backgroundColor: '#1a1a1a' }}>
                <Text style={{ color: '#666', fontSize: scale(11), textAlign: 'center' }}>
                  {t('picker.previewsUnavailable')}
                </Text>
              </View>
            ) : null}

            {syncPickerLoading ? (
              <View style={{ width: '100%', paddingVertical: scaleSpacing(32), alignItems: 'center' }}>
                <ActivityIndicator size={isTablet ? 'large' : 'small'} color={THEME.secondary} />
                <Text style={{ color: '#888', fontSize: scale(13), marginTop: scaleSpacing(10) }}>{t('picker.loadingFiles')}</Text>
              </View>
            ) : serverType === 'stealthcloud' ? (
              <FlatList
                data={syncPickerItems || []}
                keyExtractor={(it, idx) => String((it && it.manifestId) ? it.manifestId : idx)}
                ListHeaderComponent={() => (
                  <View style={{ paddingHorizontal: scaleSpacing(12), paddingVertical: scaleSpacing(8), borderBottomWidth: 1, borderBottomColor: '#222', backgroundColor: '#121212' }}>
                    <Text style={{ color: '#888', fontSize: scale(12) }}>
                      {t('picker.showingFiles', { count: syncPickerItems.length, total: syncPickerTotal > 0 ? syncPickerTotal : syncPickerItems.length })}
                    </Text>
                  </View>
                )}
                stickyHeaderIndices={[0]}
                contentContainerStyle={styles.syncPickerList}
                removeClippedSubviews={Platform.OS === 'android'}
                initialNumToRender={24}
                maxToRenderPerBatch={24}
                windowSize={7}
                onViewableItemsChanged={onSyncPickerViewableItemsChanged.current}
                viewabilityConfig={{ itemVisiblePercentThreshold: 55 }}
                onEndReachedThreshold={0.7}
                onEndReached={() => {
                  if (syncPickerHasMore && !syncPickerLoadingMore) {
                    loadMoreSyncPickerItems();
                  }
                }}
                renderItem={({ item: it }) => {
                  const key = String(it && it.manifestId ? it.manifestId : '');
                  if (!key) return null;
                  const selected = !!(syncPickerSelected && syncPickerSelected[key]);
                  const displayName = it && it.filename ? it.filename : key;
                  const rawSize = it && typeof it.size === 'number' ? it.size : null;
                  const fileSize = rawSize !== null && rawSize > 0 ? rawSize : null;
                  const mediaType = it && it.mediaType ? it.mediaType : null;
                  const ext = (displayName || '').split('.').pop()?.toLowerCase() || '';
                  const isVideo = mediaType === 'video' || ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext);
                  const isImage = mediaType === 'photo' || ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'orf', 'rw2', 'pef', 'srw', 'raf', 'psd', 'psb', 'exr', 'hdr', 'avif'].includes(ext);
                  const fileIcon = isVideo ? '🎬' : isImage ? '🖼️' : '📄';
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[styles.syncPickerRow, selected && styles.syncPickerRowSelected]}
                      onPress={() => toggleSyncPickerSelected(key)}>
                      <TouchableOpacity
                        style={{ width: isTablet ? 56 : 44, height: isTablet ? 56 : 44, borderRadius: scaleSpacing(6), marginRight: scaleSpacing(10), backgroundColor: isVideo ? '#1a1a2e' : '#1e3a2e', alignItems: 'center', justifyContent: 'center' }}
                        onPress={(e) => {
                          e.stopPropagation();
                          if (it && it.thumbUri) {
                            setSyncPickerPreview({ uri: it.thumbUri, filename: displayName });
                          }
                        }}
                        disabled={!it || !it.thumbUri}
                        activeOpacity={it && it.thumbUri ? 0.7 : 1}>
                        {it && it.thumbUri ? (
                          <Image source={{ uri: it.thumbUri }} style={{ width: '100%', height: '100%', borderRadius: scaleSpacing(6) }} />
                        ) : (
                          <Text style={{ fontSize: scale(22) }}>{fileIcon}</Text>
                        )}
                      </TouchableOpacity>
                      <View style={[styles.syncPickerRowLeft, { flex: 1 }]}>
                        <Text style={styles.syncPickerRowTitle} numberOfLines={1} ellipsizeMode="middle">{displayName}</Text>
                        {fileSize !== null && (
                          <Text style={styles.syncPickerRowMeta}>{formatBytesHuman(fileSize)}</Text>
                        )}
                      </View>
                      <View style={[styles.syncPickerCheck, selected && styles.syncPickerCheckOn]}>
                        <Text style={[styles.syncPickerCheckText, selected && styles.syncPickerCheckTextOn]}>{selected ? '✓' : ''}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                }}
                ListFooterComponent={() => (
                  <View style={{ width: '100%', paddingVertical: 12, paddingHorizontal: scaleSpacing(12), alignItems: 'center' }}>
                    {syncPickerLoadingMore ? (
                      <ActivityIndicator size={isTablet ? 'large' : 'small'} color={THEME.accent} />
                    ) : (
                      <View style={{ height: 8 }} />
                    )}
                  </View>
                )}
              />
            ) : (
              <FlatList
                data={syncPickerItems || []}
                keyExtractor={(it, idx) => String((it && it.filename) ? it.filename : idx)}
                numColumns={isTablet ? 4 : 3}
                contentContainerStyle={{ padding: scaleSpacing(10) }}
                columnWrapperStyle={{ justifyContent: 'space-between' }}
                removeClippedSubviews={Platform.OS === 'android'}
                initialNumToRender={24}
                maxToRenderPerBatch={24}
                windowSize={7}
                onEndReachedThreshold={0.7}
                onEndReached={() => {
                  if (syncPickerHasMore && !syncPickerLoadingMore) {
                    loadMoreSyncPickerItems();
                  }
                }}
                renderItem={({ item: it }) => {
                  const key = String(it && it.filename ? it.filename : '');
                  if (!key) return null;
                  const selected = !!(syncPickerSelected && syncPickerSelected[key]);
                  const ext = (key || '').split('.').pop()?.toLowerCase() || '';
                  const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext);
                  const thumbUri = it.thumbUri;
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[styles.pickerItem, selected && styles.pickerItemSelectedGreen]}
                      onPress={() => toggleSyncPickerSelected(key)}>
                      <View style={[styles.pickerThumb, { backgroundColor: isVideo ? '#1a1a2e' : '#1e3a2e', alignItems: 'center', justifyContent: 'center' }]}>
                        {thumbUri && (
                          <Image
                            source={{ uri: thumbUri }}
                            style={[styles.pickerThumb, { position: 'absolute', top: 0, left: 0 }]}
                          />
                        )}
                        <Text style={{ fontSize: 10, color: '#444', textAlign: 'center' }}>{isVideo ? '🎬' : '📷'}</Text>
                      </View>
                      {isVideo && (
                        <View style={styles.pickerBadge}>
                          <Text style={styles.pickerBadgeText}>{t('picker.video')}</Text>
                        </View>
                      )}
                      {selected && (
                        <View style={styles.pickerCheckGreen}>
                          <Text style={styles.pickerCheckText}>✓</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                }}
                ListFooterComponent={() => (
                  <View style={{ width: '100%', paddingVertical: 12, paddingHorizontal: scaleSpacing(12), alignItems: 'center' }}>
                    {syncPickerLoadingMore ? (
                      <ActivityIndicator size="small" color={THEME.accent} />
                    ) : (
                      <View style={{ height: 8 }} />
                    )}
                  </View>
                )}
              />
            )}
          </View>
        </View>
      )}

      {/* Sync Picker Thumbnail Preview Modal */}
      {syncPickerPreview && (
        <Modal
          visible={true}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setSyncPickerPreview(null)}>
          <TouchableOpacity
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' }}
            activeOpacity={1}
            onPress={() => setSyncPickerPreview(null)}>
            <View style={{ width: '90%', maxWidth: 400, backgroundColor: '#1a1a1a', borderRadius: scaleSpacing(12), overflow: 'hidden' }}>
              <Image
                source={{ uri: syncPickerPreview.uri }}
                style={{ width: '100%', aspectRatio: 1, resizeMode: 'contain', backgroundColor: '#000' }}
              />
              <View style={{ padding: scaleSpacing(12), borderTopWidth: 1, borderTopColor: '#333' }}>
                <Text style={{ color: '#fff', fontSize: scale(13), textAlign: 'center' }} numberOfLines={2} ellipsizeMode="middle">
                  {syncPickerPreview.filename}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={{ marginTop: scaleSpacing(16), paddingVertical: scaleSpacing(10), paddingHorizontal: scaleSpacing(24), backgroundColor: '#333', borderRadius: scaleSpacing(8) }}
              onPress={() => setSyncPickerPreview(null)}>
              <Text style={{ color: '#fff', fontSize: scale(14) }}>{t('common.close') || 'Close'}</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}

      {duplicateReview && (() => {
        const CLEANUP_MAGENTA = '#A78BFA'; // Magenta color for clean duplicates
        return (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' }}>
            {/* Header */}
            <View style={{ paddingTop: fullscreenHeaderPaddingTop, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: 'rgba(0,0,0,0.95)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <TouchableOpacity onPress={() => { setDuplicateReview(null); setStatus(t('status.duplicateScanCancelled')); }} style={{ padding: 8 }}>
                  <Text style={{ color: CLEANUP_MAGENTA, fontSize: scale(16), fontWeight: '600' }}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <Text style={{ color: '#FFF', fontSize: scale(16), fontWeight: '700' }}>{t('duplicates.review')}</Text>
                <View style={{ width: 60 }} />
              </View>
              <Text style={{ color: '#888', fontSize: scale(11), textAlign: 'center', marginTop: 4 }} numberOfLines={2} ellipsizeMode="tail">
                {t('duplicates.reviewSubtitle', { count: duplicateReview.duplicateCount, groups: duplicateReview.groupCount })}
              </Text>
            </View>

            {/* Scrollable content - fullscreen */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 + bottomInset }}>
              {duplicateReview.groups.map((group) => (
                <View key={`grp-${group.groupIndex}`} style={{ marginBottom: 16, padding: 12, backgroundColor: '#111', borderRadius: 12 }}>
                  <Text style={{ color: '#fff', fontWeight: '700', marginBottom: 10, fontSize: scale(14) }}>
                    {group.type === 'similar' ? t('duplicates.similarGroup', { index: group.groupIndex }) : t('duplicates.bestMatchGroup', { index: group.groupIndex })}
                  </Text>
                  {group.items.map((item, idx) => (
                    <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 6, backgroundColor: '#1a1a1a', padding: 8, borderRadius: 8 }}>
                      {/* Checkbox */}
                      <TouchableOpacity
                        onPress={() => {
                          setDuplicateReview(prev => {
                            if (!prev) return prev;
                            const next = {
                              ...prev, groups: prev.groups.map(g => {
                                if (g.groupIndex !== group.groupIndex) return g;
                                return {
                                  ...g,
                                  items: g.items.map(it => it.id === item.id ? { ...it, delete: !it.delete } : it)
                                };
                              })
                            };
                            return next;
                          });
                        }}
                        style={{ padding: 4 }}
                      >
                        <View style={{
                          width: 24, height: 24, borderRadius: 4,
                          borderWidth: 2, borderColor: item.delete ? CLEANUP_MAGENTA : '#555',
                          backgroundColor: item.delete ? CLEANUP_MAGENTA : 'transparent',
                          justifyContent: 'center', alignItems: 'center'
                        }}>
                          {item.delete && <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '900' }}>✓</Text>}
                        </View>
                      </TouchableOpacity>

                      {/* Thumbnail - tap to zoom */}
                      <TouchableOpacity
                        onPress={() => setDuplicateZoomImage({ uri: item.uri, filename: item.filename, created: item.created, size: item.size })}
                        style={{ marginLeft: 10 }}
                      >
                        <View style={{ width: 60, height: 60, borderRadius: 8, overflow: 'hidden', backgroundColor: '#222', borderWidth: 2, borderColor: CLEANUP_MAGENTA + '40' }}>
                          {item.uri ? (
                            <Image
                              source={{ uri: item.uri }}
                              style={{ width: '100%', height: '100%' }}
                              resizeMode="cover"
                            />
                          ) : null}
                        </View>
                        <Text style={{ color: '#FFF', fontSize: 9, textAlign: 'center', marginTop: 2 }}>{t('duplicates.tapToZoom')}</Text>
                      </TouchableOpacity>

                      {/* File info */}
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={{ color: '#fff', fontSize: scale(13) }} numberOfLines={1}>{item.filename}</Text>
                        <Text style={{ color: '#888', fontSize: scale(11), marginTop: 2 }}>
                          {new Date(item.created).toLocaleString()}
                        </Text>
                        {item.size ? <Text style={{ color: '#666', fontSize: scale(10) }}>{(item.size / 1024).toFixed(1)} KB</Text> : null}
                      </View>

                      {/* Keep oldest badge */}
                      {idx === 0 && <View style={{ backgroundColor: CLEANUP_MAGENTA + '30', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }}>
                        <Text style={{ color: '#FFF', fontSize: scale(10), fontWeight: '600' }}>{t('duplicates.keepOldest')}</Text>
                      </View>}
                    </View>
                  ))}
                </View>
              ))}
            </ScrollView>

            {/* Bottom action bar */}
            <View style={{ backgroundColor: 'rgba(0,0,0,0.95)', paddingBottom: 16 + bottomInset, paddingTop: 12, paddingHorizontal: 16 }}>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity
                  style={{ flex: 1, backgroundColor: '#222', paddingVertical: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#444' }}
                  onPress={() => { setDuplicateReview(null); setStatus(t('status.duplicateScanCancelled')); }}
                >
                  <Text style={{ color: '#FFF', fontSize: scale(14), fontWeight: '600' }}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1, backgroundColor: CLEANUP_MAGENTA, paddingVertical: 14, borderRadius: 12, alignItems: 'center' }}
                  onPress={async () => {
                    try {
                      const idsToDelete = [];
                      duplicateReview.groups.forEach(g => {
                        g.items.forEach(it => { if (it.delete) idsToDelete.push(it.id); });
                      });
                      if (idsToDelete.length === 0) {
                        setStatus(t('status.allItemsKept'));
                        setDuplicateReview(null);
                        showCompletionTickBriefly(t('results.allFilesKept'));
                        return;
                      }
                      setStatus(t('status.deletingItems', { count: idsToDelete.length }));

                      // Use batched deletion to avoid crashes with large numbers of files
                      const DuplicateScanner = require('./duplicateScannerOptimized').default;
                      const result = await DuplicateScanner.deleteAssets(idsToDelete, (progress, deleted, total) => {
                        setStatus(t('status.deletingProgress', { deleted, total }));
                      });

                      if (result.deleted > 0) {
                        showResultAlert('clean', { deleted: result.deleted });
                        setStatus(t('status.deletedItems', { count: result.deleted }));
                      } else {
                        setStatus(t('status.deletionCancelled'));
                      }
                    } catch (err) {
                      console.log('Exact Duplicates: Delete error', err?.message || err);
                      setStatus(t('status.deletionFailed'));
                      showDarkAlert(t('alerts.deleteFailed'), err?.message || t('alerts.deleteFailedMessage'));
                    } finally {
                      setDuplicateReview(null);
                      setLoadingSafe(false);
                      setBackgroundWarnEligibleSafe(false);
                      setWasBackgroundedDuringWorkSafe(false);
                    }
                  }}
                >
                  <Text style={{ color: '#FFF', fontSize: scale(14), fontWeight: '700' }}>{t('duplicates.delete')}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Zoom overlay */}
            {duplicateZoomImage && (
              <TouchableOpacity
                activeOpacity={1}
                onPress={() => setDuplicateZoomImage(null)}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' }}
              >
                <Image
                  source={{ uri: duplicateZoomImage.uri }}
                  style={{ width: '100%', height: '70%' }}
                  resizeMode="contain"
                />
                <View style={{ position: 'absolute', bottom: 100 + bottomInset, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.8)', padding: 16, borderRadius: 12, alignItems: 'center' }}>
                  <Text style={{ color: '#FFF', fontSize: scale(15), fontWeight: '600', textAlign: 'center' }}>{duplicateZoomImage.filename}</Text>
                  <Text style={{ color: '#AAA', fontSize: scale(12), marginTop: 4, textAlign: 'center' }}>
                    {new Date(duplicateZoomImage.created).toLocaleString()}
                  </Text>
                  {duplicateZoomImage.size ? <Text style={{ color: '#888', fontSize: scale(11), marginTop: 2, textAlign: 'center' }}>{(duplicateZoomImage.size / 1024).toFixed(1)} KB</Text> : null}
                </View>
                <Text style={{ position: 'absolute', top: Platform.OS === 'ios' ? 60 : 40, color: '#FFF', fontSize: scale(14) }}>{t('duplicates.tapToClose')}</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })()}

      {customAlert && (
        <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass, { zIndex: 10001 }]}>
          <View style={[styles.overlayCard, glassModeEnabled && styles.overlayCardGlass, { backgroundColor: glassModeEnabled ? 'rgba(30, 30, 30, 0.9)' : '#1E1E1E', maxWidth: isTablet ? 480 : 340 }]}>
            <Text style={[styles.overlayTitle, { fontSize: scale(18), marginBottom: scaleSpacing(8) }]}>{customAlert.title}</Text>
            <Text style={{ color: '#CCC', fontSize: scale(14), textAlign: 'center', marginBottom: scaleSpacing(14), lineHeight: scale(20) }}>{customAlert.message}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: scaleSpacing(12), flexWrap: 'wrap' }}>
              {(customAlert.buttons || []).map((btn, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={[styles.overlayBtnPrimary, glassModeEnabled && styles.overlayBtnPrimaryGlass, { paddingVertical: scaleSpacing(10), paddingHorizontal: scaleSpacing(24), minWidth: isTablet ? 110 : 90 }]}
                  onPress={() => {
                    closeDarkAlert();
                    if (btn.onPress) btn.onPress();
                  }}>
                  <Text style={styles.overlayBtnPrimaryText} numberOfLines={1}>{btn.text}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      )}

      {paywallTierGb && (
        <View style={[styles.overlay, glassModeEnabled && styles.overlayGlass]}>
          <View style={[styles.overlayCard, glassModeEnabled && styles.overlayCardGlass, { backgroundColor: glassModeEnabled ? 'rgba(30, 30, 30, 0.9)' : '#1E1E1E', maxWidth: isTablet ? 480 : 340 }]}>
            {(() => {
              const gb = paywallTierGb;
              const plan = availablePlans.find(p => p.tierGb === gb);
              const priceStr = plan ? plan.priceString : '—';
              const currentPlan = stealthUsage?.planGb || stealthUsage?.plan_gb;
              const isCurrent = currentPlan === gb;
              const canSubscribe = !purchaseLoading && plan && priceStr && priceStr !== '—';
              const title = gb === 1000 ? t('subscription.storage1000Monthly') : t('subscription.storageGbMonthly', { gb });

              return (
                <>
                  <Text style={[styles.overlayTitle, { fontSize: scale(18), marginBottom: scaleSpacing(8) }]}>{title}</Text>
                  
                  {/* Price display — SKR discount UI hidden; both methods show same monthly rate */}
                  <View style={{ alignItems: 'center', marginBottom: scaleSpacing(12) }}>
                    <Text style={{ color: '#CCC', fontSize: scale(14), textAlign: 'center', lineHeight: scale(20) }}>
                      {priceStr !== '—' ? t('subscription.pricePerMonth', { price: priceStr }) : t('subscription.pricingUnavailable')}
                    </Text>
                  </View>

                  <View style={{
                    alignSelf: 'center',
                    marginBottom: scaleSpacing(14),
                    paddingHorizontal: scaleSpacing(12),
                    paddingVertical: scaleSpacing(7),
                    borderRadius: scaleSpacing(999),
                    backgroundColor: 'rgba(0,255,163,0.12)',
                    borderWidth: 1,
                    borderColor: 'rgba(0,255,163,0.28)',
                  }}>
                    <Text style={{ color: '#00FFA3', fontSize: scale(11), fontWeight: '800', textAlign: 'center' }}>
                      {t('subscription.feeWaiverHighlight') || 'PhotoLynk mint fees waived with any active paid plan'}
                    </Text>
                  </View>

                  {/* Payment method selector */}
                  <View style={{ flexDirection: 'row', justifyContent: 'center', gap: scaleSpacing(8), marginBottom: scaleSpacing(14) }}>
                    <TouchableOpacity
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: scaleSpacing(8),
                        paddingHorizontal: scaleSpacing(12),
                        borderRadius: scaleSpacing(8),
                        borderWidth: 1,
                        borderColor: paywallPaymentMethod === 'sol' ? '#0099FF' : '#444',
                        backgroundColor: paywallPaymentMethod === 'sol' ? 'rgba(0,153,255,0.15)' : 'transparent',
                        gap: scaleSpacing(6),
                      }}
                      onPress={() => {
                        setPaywallPaymentMethod('sol');
                        setBlockchainConsent(false);
                      }}
                    >
                      <Text style={{ color: paywallPaymentMethod === 'sol' ? '#0099FF' : '#AAA', fontSize: scale(12), fontWeight: '600' }}>
                        Pay with SOL
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: scaleSpacing(8),
                        paddingHorizontal: scaleSpacing(12),
                        borderRadius: scaleSpacing(8),
                        borderWidth: 1,
                        borderColor: paywallPaymentMethod === 'skr' ? '#00FFA3' : '#444',
                        backgroundColor: paywallPaymentMethod === 'skr' ? 'rgba(0,255,163,0.15)' : 'transparent',
                        gap: scaleSpacing(6),
                      }}
                      onPress={() => {
                        setPaywallPaymentMethod('skr');
                        setBlockchainConsent(false);
                      }}
                    >
                      <Feather name="zap" size={scale(12)} color={paywallPaymentMethod === 'skr' ? '#00FFA3' : '#888'} />
                      <Text style={{ color: paywallPaymentMethod === 'skr' ? '#00FFA3' : '#AAA', fontSize: scale(12), fontWeight: '600' }}>
                        Pay with {SKR_TOKEN_SYMBOL}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* Blockchain Payment Consent */}
                  {(paywallPaymentMethod === 'sol' || paywallPaymentMethod === 'skr') && (
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: scaleSpacing(10), marginBottom: scaleSpacing(14), paddingHorizontal: scaleSpacing(4) }}
                      onPress={() => setBlockchainConsent(!blockchainConsent)}
                      activeOpacity={0.7}
                    >
                      <View style={{
                        width: scaleSpacing(22),
                        height: scaleSpacing(22),
                        borderRadius: scaleSpacing(6),
                        borderWidth: 1.5,
                        borderColor: blockchainConsent ? (paywallPaymentMethod === 'skr' ? '#00FFA3' : '#0099FF') : 'rgba(255,255,255,0.12)',
                        backgroundColor: blockchainConsent ? (paywallPaymentMethod === 'skr' ? 'rgba(0,255,163,0.2)' : 'rgba(0,153,255,0.2)') : 'transparent',
                        justifyContent: 'center',
                        alignItems: 'center',
                        marginTop: scaleSpacing(2),
                      }}>
                        {blockchainConsent && <Feather name="check" size={scale(14)} color={paywallPaymentMethod === 'skr' ? '#00FFA3' : '#0099FF'} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: scale(12), color: '#AAA', lineHeight: scale(18) }}>
                          I understand that blockchain payments are{' '}
                          <Text style={{ color: '#FFF', fontWeight: '600' }}>irreversible</Text>,
                          {' '}that I am responsible for{' '}
                          <Text style={{ color: '#FFF', fontWeight: '600' }}>wallet security</Text>,
                          {' '}and that StealthLynk does not custody my funds.{' '}
                          <Text
                            style={{ color: paywallPaymentMethod === 'skr' ? '#00FFA3' : '#0099FF', textDecorationLine: 'underline' }}
                            onPress={() => Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/terms.html#blockchain')}
                          >
                            Learn more
                          </Text>
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}

                  <View style={{ flexDirection: 'row', justifyContent: 'center', gap: scaleSpacing(12), flexWrap: 'wrap' }}>
                    <TouchableOpacity
                      style={[styles.overlayBtnPrimary, glassModeEnabled && styles.overlayBtnPrimaryGlass, { paddingVertical: scaleSpacing(10), paddingHorizontal: scaleSpacing(24), minWidth: isTablet ? 110 : 90, opacity: purchaseLoading ? 0.6 : 1 }]}
                      onPress={closePaywall}
                      disabled={purchaseLoading}
                    >
                      <Text style={styles.overlayBtnPrimaryText}>{t('common.close')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.overlayBtnPrimary, glassModeEnabled && styles.overlayBtnPrimaryGlass, { paddingVertical: scaleSpacing(10), paddingHorizontal: scaleSpacing(24), minWidth: isTablet ? 130 : 110, opacity: (canSubscribe && (paywallPaymentMethod === 'apple' || blockchainConsent)) ? 1 : 0.5 }]}
                      onPress={() => {
                        if (!canSubscribe) return;
                        if (paywallPaymentMethod !== 'apple' && !blockchainConsent) {
                          showDarkAlert(t('alerts.error'), 'Please acknowledge the blockchain payment terms to continue.');
                          return;
                        }
                        closePaywall();
                        handlePurchase(gb, paywallPaymentMethod);
                      }}
                      disabled={!canSubscribe || (paywallPaymentMethod !== 'apple' && !blockchainConsent)}
                    >
                      <Text style={styles.overlayBtnPrimaryText}>{isCurrent ? t('subscription.currentPlan') : t('subscription.subscribe')}</Text>
                    </TouchableOpacity>
                  </View>

                  {false && (
                    <TouchableOpacity
                      style={[styles.restorePurchasesBtn, { marginTop: scaleSpacing(14) }]}
                      onPress={() => {
                        closePaywall();
                        handleRestorePurchases();
                      }}
                      disabled={purchaseLoading}
                    >
                      <Text style={styles.restorePurchasesText}>{t('subscription.restorePurchases')}</Text>
                    </TouchableOpacity>
                  )}
                  <Text style={{ color: '#00FFA3', fontSize: scale(11), fontWeight: '700', textAlign: 'center', marginTop: scaleSpacing(12), lineHeight: scale(16) }}>
                    {t('subscription.autoRenewNote')}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: scaleSpacing(6), marginTop: scaleSpacing(8) }}>
                    <TouchableOpacity onPress={() => Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/terms.html')}>
                      <Text style={{ color: '#A78BFA', fontSize: scale(11), textDecorationLine: 'underline' }}>{t('subscription.termsOfUse')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/privacy-policy.html')}>
                      <Text style={{ color: '#A78BFA', fontSize: scale(11), textDecorationLine: 'underline' }}>{t('subscription.privacyPolicy')}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              );
            })()}
          </View>
        </View>
      )}

      {/* Purchase confirming overlay (shown after wallet approval until server confirms) */}
      <PurchaseConfirmingOverlay
        visible={!!(purchaseLoading || nftPurchaseLoading)}
        title={t('alerts.confirmingPurchase') && !t('alerts.confirmingPurchase').includes('confirmingPurchase') ? t('alerts.confirmingPurchase') : 'Confirming purchase…'}
        subtitle={t('alerts.confirmingPurchaseDesc') && !t('alerts.confirmingPurchaseDesc').includes('confirmingPurchaseDesc') ? t('alerts.confirmingPurchaseDesc') : 'Verifying your payment on Solana. Please don\'t close the app.'}
      />

      {/* NFT Photo Picker */}
      <NFTPhotoPicker
        visible={nftPickerOpen}
        onClose={closeNftPicker}
        onSelectPhoto={handleMintNFT}
        resolveReadableFilePath={resolveReadableFilePath}
        serverConfig={{ baseUrl: 'https://stealthlynk.io', getAuthHeaders: getStealthCloudAuthHeaders }}
        checkCloudEligibility={(fileSize) => checkStealthCloudEligibility({ baseUrl: 'https://stealthlynk.io', getAuthHeaders: getStealthCloudAuthHeaders }, fileSize)}
        nftFeesWaived={nftFeesWaived}
        nftFeeDiscountPercent={nftPlanFeeDiscountPercent}
        nftFreeMintsRemaining={nftFreeMintsRemaining}
        isLegacySubscriber={isLegacySubscriber}
      />

      {/* NFT Gallery */}
      <NFTGallery
        visible={nftGalleryOpen}
        onClose={closeNftGallery}
        onTransferNFT={handleNftTransfer}
        serverUrl={'https://stealthlynk.io'}
        getAuthHeaders={getStealthCloudAuthHeaders}
        refreshKey={nftGalleryRefreshKey}
        onShowCertificate={(mintAddress) => {
          setNftGalleryOpen(false);
          setPendingCertMint(mintAddress);
          setNftCertsOpen(true);
        }}
        pendingSelectMint={pendingNftMint}
        onPendingSelectConsumed={() => setPendingNftMint(null)}
        onCertifiedCountChange={(count) => setQsNftCount(count)}
      />

      {/* Certificates Viewer */}
      <CertificatesViewer
        visible={nftCertsOpen}
        onClose={() => setNftCertsOpen(false)}
        serverUrl={'https://stealthlynk.io'}
        getAuthHeaders={getStealthCloudAuthHeaders}
        onShowNFT={(mintAddress) => {
          setNftCertsOpen(false);
          setPendingNftMint(mintAddress);
          setNftGalleryOpen(true);
        }}
        pendingSelectMint={pendingCertMint}
        onPendingSelectConsumed={() => setPendingCertMint(null)}
      />

      {/* NFT Transfer Modal */}
      <NFTTransferModal
        visible={nftTransferOpen}
        nft={nftToTransfer}
        onClose={closeNftTransfer}
        onTransferComplete={handleNftTransferComplete}
        authToken={token}
      />

      {/* ============================================================ */}
      {/* Wallet Login Overlay — branded hardware wallet auth           */}
      {/* Appears on app startup when no valid session exists.          */}
      {/* Replaces old LoginScreen (which is preserved but hidden).     */}
      {/* ============================================================ */}
      {showWalletLogin && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: '#000000',
          justifyContent: 'center', alignItems: 'center',
          zIndex: 10000,
        }}>
          <View style={{
            width: '94%', maxWidth: isTablet ? 520 : 440,
            backgroundColor: 'transparent',
            borderRadius: scaleSpacing(22),
            borderWidth: 0,
            paddingVertical: scaleSpacing(28),
            paddingHorizontal: scaleSpacing(24),
            alignItems: 'center',
          }}>
            {/* App Icon */}
            <Image
              source={require('./assets/splash-icon.png')}
              style={{ width: scale(56), height: scale(56), marginBottom: scaleSpacing(10), borderRadius: scale(14) }}
              resizeMode="contain"
            />

            {/* App Name */}
            <Text style={{
              color: '#FFFFFF', fontSize: scale(22), fontWeight: '800',
              letterSpacing: 1, marginBottom: scaleSpacing(16),
            }}>
              {APP_DISPLAY_NAME}
            </Text>

            {!showRecoveryKitLogin && (
              <>
                <View style={{
                  width: '100%',
                  marginBottom: scaleSpacing(16),
                  borderRadius: scaleSpacing(18),
                  paddingVertical: scaleSpacing(12),
                  paddingHorizontal: scaleSpacing(14),
                  backgroundColor: 'rgba(167,139,250,0.08)',
                }}>
                  <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: scaleSpacing(10) }}>
                      <View style={{
                        width: scaleSpacing(30),
                        height: scaleSpacing(30),
                        borderRadius: scaleSpacing(15),
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(0,255,163,0.14)',
                        marginRight: scaleSpacing(10),
                      }}>
                        <Feather name="award" size={scale(15)} color="#00FFA3" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#F4F4F8', fontSize: scale(13.5), fontWeight: '800' }}>
                          Pay with SKR
                        </Text>
                        <Text style={{ color: '#A9A9C7', fontSize: scale(11), marginTop: scaleSpacing(2) }}>
                          Loyalty pricing
                        </Text>
                      </View>
                    </View>
                    <View style={{
                      paddingHorizontal: scaleSpacing(10),
                      paddingVertical: scaleSpacing(6),
                      borderRadius: scaleSpacing(999),
                      backgroundColor: 'rgba(0,255,163,0.16)',
                      borderWidth: 1,
                      borderColor: 'rgba(0,255,163,0.24)',
                    }}>
                      <Text style={{ color: '#00FFA3', fontSize: scale(10), fontWeight: '900', letterSpacing: 0.4 }}>
                        UP TO 80% OFF
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Divider */}
                <View style={{
                  width: '100%', height: 1,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  marginBottom: scaleSpacing(16),
                }} />
              </>
            )}

            {/* Error message */}
            {walletAuthError ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: scaleSpacing(8), marginBottom: scaleSpacing(18), width: '100%', paddingHorizontal: scaleSpacing(4) }}>
                <Feather name="alert-circle" size={scale(14)} color="#FF6B6B" />
                <Text style={{
                  color: '#FF6B6B', fontSize: scale(12),
                  lineHeight: scale(17), flex: 1,
                }}>
                  {walletAuthError}
                </Text>
              </View>
            ) : null}

            {/* Auth actions */}
            {walletAuthLoading ? (
              <View style={{ alignItems: 'center', marginBottom: scaleSpacing(8) }}>
                <GradientSpinner size={isTablet ? 56 : 44} />
                <Text style={{
                  color: '#888', fontSize: scale(12), marginTop: scaleSpacing(12),
                  textAlign: 'center',
                }}>
                  {walletAuthStatus || t('common.loading') || 'Loading...'}
                </Text>
              </View>
            ) : showEmailLogin ? (
              /* ── Email / Password login mode ── */
              <View style={{ width: '100%', alignItems: 'center', marginBottom: scaleSpacing(16) }}>
                <Text style={{ fontSize: scale(13), color: '#A78BFA', fontWeight: '700', marginBottom: scaleSpacing(16), textAlign: 'center' }}>
                  {t('auth.signInWithEmail') || 'Sign in with Email'}
                </Text>
                <TextInput
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    borderRadius: scaleSpacing(12),
                    paddingVertical: scaleSpacing(12),
                    paddingHorizontal: scaleSpacing(14),
                    color: '#FFF',
                    fontSize: scale(14),
                    marginBottom: scaleSpacing(10),
                  }}
                  placeholder={t('login.emailPlaceholder') || 'Email'}
                  placeholderTextColor="#55556A"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  editable={!loading}
                />
                <TextInput
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    borderRadius: scaleSpacing(12),
                    paddingVertical: scaleSpacing(12),
                    paddingHorizontal: scaleSpacing(14),
                    color: '#FFF',
                    fontSize: scale(14),
                  }}
                  placeholder={t('login.passwordPlaceholder') || 'Password'}
                  placeholderTextColor="#55556A"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  editable={!loading}
                />
                  {/* Email login consent checkbox */}
                  <TouchableOpacity
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: scaleSpacing(12),
                      marginTop: scaleSpacing(12),
                      paddingHorizontal: scaleSpacing(4),
                    }}
                    onPress={() => setTermsAccepted(!termsAccepted)}
                    activeOpacity={0.7}
                  >
                    <View style={{
                      width: scaleSpacing(24),
                      height: scaleSpacing(24),
                      borderRadius: scaleSpacing(6),
                      borderWidth: 1.5,
                      borderColor: termsAccepted ? '#A78BFA' : 'rgba(255,255,255,0.15)',
                      backgroundColor: termsAccepted ? '#A78BFA' : 'transparent',
                      justifyContent: 'center',
                      alignItems: 'center',
                      marginTop: scaleSpacing(2),
                    }}>
                      {termsAccepted && <Feather name="check" size={scale(14)} color="#FFF" />}
                    </View>
                    <Text style={{ flex: 1, fontSize: scale(12), color: '#8888A0', lineHeight: scale(18) }}>
                      By signing in, you agree to our{' '}
                      <Text style={{ color: '#A78BFA', textDecorationLine: 'underline', fontWeight: '600' }} onPress={(e) => { e.stopPropagation(); Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/terms.html'); }}>Terms of Service</Text>
                      {' '}and{' '}
                      <Text style={{ color: '#A78BFA', textDecorationLine: 'underline', fontWeight: '600' }} onPress={(e) => { e.stopPropagation(); Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/privacy-policy.html'); }}>Privacy Policy</Text>
                      .
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={{
                      width: '100%',
                      backgroundColor: (loading || !termsAccepted) ? '#555' : '#A78BFA',
                      borderRadius: scaleSpacing(12),
                      paddingVertical: scaleSpacing(14),
                      alignItems: 'center',
                      marginTop: scaleSpacing(14),
                      flexDirection: 'row',
                      justifyContent: 'center',
                      gap: scaleSpacing(8),
                      opacity: (loading || !termsAccepted) ? 0.5 : 1,
                    }}
                    onPress={() => {
                      if (!termsAccepted) {
                        showDarkAlert(t('alerts.error'), 'Please agree to the terms to continue.');
                        return;
                      }
                      handleUnifiedEmailAuth();
                    }}
                    disabled={loading || !email || !password || !termsAccepted}
                    activeOpacity={termsAccepted ? 0.8 : 1}
                  >
                    {loading ? (
                      <>
                        <ActivityIndicator size="small" color="#000" />
                        <Text style={{ color: '#000', fontSize: scale(15), fontWeight: '700' }}>
                          {t('common.continue') || 'Continue'}
                        </Text>
                      </>
                    ) : (
                      <>
                        <Feather name="log-in" size={scale(16)} color={termsAccepted ? '#000' : '#888'} />
                        <Text style={{ color: termsAccepted ? '#000' : '#888', fontSize: scale(15), fontWeight: '700' }}>
                          {t('common.continue') || 'Continue'}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => { setShowEmailLogin(false); setWalletAuthError(''); setTermsAccepted(false); setShowRecoveryKitLogin(false); }}
                  activeOpacity={0.7}
                  style={{ marginTop: scaleSpacing(12) }}
                >
                  <Text style={{ color: '#A78BFA', fontSize: scale(13), textDecorationLine: 'underline' }}>
                    {t('auth.backToLogin') || '← Back to Login'}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : showRecoveryKitLogin ? (
              /* ── Recovery kit mode ── */
              <View style={{ width: '100%', alignItems: 'center', marginBottom: scaleSpacing(16) }}>
                <Text style={{ fontSize: scale(13), color: '#A78BFA', fontWeight: '700', marginBottom: scaleSpacing(16), textAlign: 'center' }}>
                  {t('auth.recoverWithKey') || 'Recover with Key'}
                </Text>
                <Text style={{ fontSize: scale(12), color: '#888', marginBottom: scaleSpacing(14), textAlign: 'center', lineHeight: scale(18) }}>
                  Paste your exported recovery kit and enter the PIN you set when creating it.
                </Text>
                <TextInput
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    borderRadius: scaleSpacing(12),
                    paddingVertical: scaleSpacing(12),
                    paddingHorizontal: scaleSpacing(14),
                    color: '#FFF',
                    fontSize: scale(13),
                    marginBottom: scaleSpacing(10),
                  }}
                  placeholder="Recovery kit"
                  placeholderTextColor="#555"
                  value={recoveryKitInput}
                  onChangeText={setRecoveryKitInput}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!recoveryKitLoading}
                />
                <TextInput
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    borderRadius: scaleSpacing(12),
                    paddingVertical: scaleSpacing(12),
                    paddingHorizontal: scaleSpacing(14),
                    color: '#FFF',
                    fontSize: scale(14),
                  }}
                  placeholder="PIN"
                  placeholderTextColor="#555"
                  value={recoveryKitPin}
                  onChangeText={setRecoveryKitPin}
                  secureTextEntry
                  maxLength={32}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!recoveryKitLoading}
                />
                {recoveryKitError && (
                  <Text style={{ color: '#FF6B6B', fontSize: scale(12), marginTop: scaleSpacing(8), textAlign: 'center' }}>
                    {recoveryKitError}
                  </Text>
                )}
                <TouchableOpacity
                  style={{
                    width: '100%',
                    backgroundColor: '#10B981',
                    borderRadius: scaleSpacing(12),
                    paddingVertical: scaleSpacing(14),
                    alignItems: 'center',
                    marginTop: scaleSpacing(14),
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: scaleSpacing(8),
                    opacity: (!recoveryKitInput.trim() || !recoveryKitPin || recoveryKitLoading) ? 0.5 : 1,
                  }}
                  onPress={async () => {
                    setRecoveryKitError(null);
                    setRecoveryKitLoading(true);
                    // Yield so React renders the spinner before PBKDF2 blocks the thread
                    await new Promise((r) => setTimeout(r, 50));
                    try {
                      await handleRecoveryKitLogin(recoveryKitInput.trim(), recoveryKitPin);
                      setRecoveryKitInput('');
                      setRecoveryKitPin('');
                      setShowRecoveryKitLogin(false);
                    } catch (e) {
                      setRecoveryKitError(e?.message || 'Recovery failed');
                    } finally {
                      setRecoveryKitLoading(false);
                    }
                  }}
                  disabled={!recoveryKitInput.trim() || !recoveryKitPin || recoveryKitLoading}
                  activeOpacity={0.8}
                >
                  {recoveryKitLoading ? (
                    <ActivityIndicator size="small" color="#000" />
                  ) : (
                    <>
                      <Feather name="key" size={scale(16)} color="#000" />
                      <Text style={{ color: '#000', fontSize: scale(15), fontWeight: '700' }}>
                        Recover Account
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => { setShowRecoveryKitLogin(false); setRecoveryKitInput(''); setRecoveryKitPin(''); setRecoveryKitError(null); }}
                  activeOpacity={0.7}
                  style={{ marginTop: scaleSpacing(12) }}
                >
                  <Text style={{ color: '#A78BFA', fontSize: scale(13), textDecorationLine: 'underline' }}>
                    {t('auth.backToLogin') || '← Back to Login'}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              /* ── Wallet login mode ── */
              <View style={{ width: '100%', alignItems: 'center' }}>
                {/* Wallet Consent Card */}
                <TouchableOpacity
                  style={{
                    width: '100%',
                    backgroundColor: walletBlockchainConsent ? 'rgba(0,255,163,0.06)' : 'rgba(255,255,255,0.02)',
                    borderRadius: scaleSpacing(14),
                    padding: scaleSpacing(16),
                    marginBottom: scaleSpacing(16),
                  }}
                  onPress={() => setWalletBlockchainConsent(!walletBlockchainConsent)}
                  activeOpacity={0.7}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: scaleSpacing(14) }}>
                    <View style={{
                      width: scaleSpacing(28),
                      height: scaleSpacing(28),
                      borderRadius: scaleSpacing(8),
                      borderWidth: 2,
                      borderColor: walletBlockchainConsent ? '#00FFA3' : 'rgba(255,255,255,0.15)',
                      backgroundColor: walletBlockchainConsent ? '#00FFA3' : 'transparent',
                      justifyContent: 'center',
                      alignItems: 'center',
                      marginTop: scaleSpacing(2),
                    }}>
                      {walletBlockchainConsent && <Feather name="check" size={scale(18)} color="#000" />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: scale(14), fontWeight: '700', color: '#FFFFFF', marginBottom: scaleSpacing(4) }}>
                        Connect Wallet
                      </Text>
                      <Text style={{ fontSize: scale(12), color: '#8888A0', lineHeight: scale(18) }}>
                        By connecting, you agree to our{' '}
                        <Text style={{ color: '#00FFA3', textDecorationLine: 'underline', fontWeight: '600' }} onPress={(e) => { e.stopPropagation(); Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/terms.html#blockchain'); }}>Terms of Service</Text>
                        {' '}and{' '}
                        <Text style={{ color: '#00FFA3', textDecorationLine: 'underline', fontWeight: '600' }} onPress={(e) => { e.stopPropagation(); Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/privacy-policy.html'); }}>Privacy Policy</Text>
                        . Your wallet private keys never leave your device.
                      </Text>
                    </View>
                  </View>
                </TouchableOpacity>

                {/* Connect Wallet Button */}
                <TouchableOpacity
                  style={{
                    width: '100%',
                    backgroundColor: walletBlockchainConsent ? '#A78BFA' : '#555',
                    borderRadius: scaleSpacing(14),
                    paddingVertical: scaleSpacing(15),
                    alignItems: 'center',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: scaleSpacing(10),
                    shadowColor: walletBlockchainConsent ? '#A78BFA' : 'transparent',
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: walletBlockchainConsent ? 0.25 : 0,
                    shadowRadius: 12,
                    elevation: walletBlockchainConsent ? 6 : 0,
                  }}
                  activeOpacity={walletBlockchainConsent ? 0.8 : 1}
                  onPress={() => {
                    if (!walletBlockchainConsent) {
                      showDarkAlert(t('alerts.error'), 'Please confirm wallet security terms.');
                      return;
                    }
                    performWalletLogin();
                  }}
                >
                  <Image source={require('./assets/solana-logo.png')} style={{ width: scale(20), height: scale(20), tintColor: walletBlockchainConsent ? '#000' : '#888' }} resizeMode="contain" />
                  <Text style={{
                    color: walletBlockchainConsent ? '#000000' : '#888', fontSize: scale(15), fontWeight: '700',
                    letterSpacing: 0.3,
                  }}>
                    {t('auth.connectWallet') || 'Connect Wallet'}
                  </Text>
                </TouchableOpacity>

                {/* Divider */}
                <View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', marginVertical: scaleSpacing(16) }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />
                  <Text style={{ color: '#55556A', fontSize: scale(11), marginHorizontal: scaleSpacing(10) }}>or</Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />
                </View>

                {/* Sign in with Email */}
                <TouchableOpacity
                  style={{
                    width: '100%',
                    backgroundColor: 'transparent',
                    borderRadius: scaleSpacing(14),
                    paddingVertical: scaleSpacing(14),
                    alignItems: 'center',
                    borderWidth: 1,
                    borderColor: 'rgba(167,139,250,0.60)',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: scaleSpacing(8),
                  }}
                  onPress={() => { setShowEmailLogin(true); setWalletAuthError(''); setShowRecoveryKitLogin(false); }}
                  activeOpacity={0.7}
                >
                  <Feather name="mail" size={scale(16)} color="#A78BFA" />
                  <Text style={{ color: '#A78BFA', fontSize: scale(14), fontWeight: '600' }}>
                    {t('auth.signInWithEmail') || 'Sign in with Email'}
                  </Text>
                </TouchableOpacity>

                {/* Recover with Key */}
                <TouchableOpacity
                  style={{
                    width: '100%',
                    backgroundColor: 'transparent',
                    borderRadius: scaleSpacing(14),
                    paddingVertical: scaleSpacing(14),
                    alignItems: 'center',
                    borderWidth: 1,
                    borderColor: 'rgba(16,185,129,0.60)',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: scaleSpacing(8),
                    marginTop: scaleSpacing(12),
                  }}
                  onPress={() => { setShowRecoveryKitLogin(true); setRecoveryKitError(null); setShowEmailLogin(false); setWalletAuthError(''); }}
                  activeOpacity={0.7}
                >
                  <Feather name="key" size={scale(16)} color="#10B981" />
                  <Text style={{ color: '#10B981', fontSize: scale(14), fontWeight: '600' }}>
                    {t('auth.recoverWithKey') || 'Recover with Key'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Server type indicator (small, below button) */}
            {serverType === 'stealthcloud' ? (
              <TouchableOpacity
                style={{ marginTop: scaleSpacing(16) }}
                onPress={() => Linking.openURL('https://stealthlynk.io')}
                activeOpacity={0.7}
              >
                <Text style={{
                  color: '#555', fontSize: scale(10),
                  textAlign: 'center',
                  textDecorationLine: 'underline',
                }}>
                  stealthlynk.io
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={{
                color: '#555', fontSize: scale(10), marginTop: scaleSpacing(16),
                textAlign: 'center',
              }}>
                {serverType === 'local' ? `Local · ${localHost || '—'}` : `Remote · ${remoteHost || '—'}`}
              </Text>
            )}

            {/* QR Scanner link for local/remote pairing */}
            {serverType !== 'stealthcloud' && (
              <TouchableOpacity
                style={{ marginTop: scaleSpacing(10) }}
                onPress={async () => {
                  if (!cameraPermission?.granted) {
                    const result = await requestCameraPermission();
                    if (!result.granted) {
                      showDarkAlert(t('login.cameraPermissionTitle'), t('login.cameraPermissionMessage'));
                      return;
                    }
                  }
                  setQrScannerOpen(true);
                }}
              >
                <Text style={{ color: '#A78BFA', fontSize: scale(12), textDecorationLine: 'underline' }}>
                  {t('login.scanQrCode') || 'Scan QR to pair with desktop'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* ═══ In-app update prompt (Android) ═══ */}
      {updatePrompt && (
        <Modal transparent animationType="fade" visible={!!updatePrompt} onRequestClose={() => setUpdatePrompt(null)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <View style={{ width: '100%', maxWidth: 360, backgroundColor: THEME.card, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(167,139,250,0.2)', padding: 24 }}>
              <Text style={{ color: THEME.accent, fontSize: scale(20), fontWeight: '800', marginBottom: 12, textAlign: 'center' }}>
                Update Available
              </Text>
              <Text style={{ color: THEME.text, fontSize: scale(13), lineHeight: scale(20), textAlign: 'center', marginBottom: 16 }}>
                A new version of PhotoLynk is available on the Solana dApp Store.
              </Text>
              <View style={{ backgroundColor: 'rgba(167,139,250,0.06)', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(167,139,250,0.12)' }}>
                <Text style={{ color: THEME.textSec, fontSize: scale(12), lineHeight: scale(18) }}>
                  <Text style={{ color: THEME.text, fontWeight: '700' }}>Current:</Text> build {Application.nativeBuildVersion || '?'}{'\n'}
                  <Text style={{ color: THEME.text, fontWeight: '700' }}>Latest:</Text> build {updatePrompt.latestVersionCode}
                </Text>
              </View>
              {updatePrompt.releaseNotes && (
                <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                  <Text style={{ color: THEME.accent, fontSize: scale(11), fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 }}>What's new</Text>
                  {updatePrompt.releaseNotes
                    .split(/\n|\./)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                    .map((s, i) => (
                      <Text key={i} style={{ color: THEME.textSec, fontSize: scale(11), lineHeight: scale(18) }}>
                        {'- '}{s}{!s.endsWith('!') && !s.endsWith('?') ? '.' : ''}
                      </Text>
                    ))}
                </View>
              )}
              <Text style={{ color: '#666', fontSize: scale(11), lineHeight: scale(17), textAlign: 'center', marginBottom: 20 }}>
                Updates include bug fixes, security patches, and new features. You can continue using the app and update later from the dApp Store.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity
                  style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}
                  onPress={() => setUpdatePrompt(null)}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: THEME.text, fontSize: scale(13), fontWeight: '600' }}>Later</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1, backgroundColor: THEME.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}
                  onPress={() => {
                    const url = updatePrompt.updateUrl || 'solanadappstore://details?id=com.photolynk.solana';
                    Linking.openURL(url).catch(() => {
                      Linking.openURL('https://dappstore.solanamobile.com');
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#fff', fontSize: scale(13), fontWeight: '700' }}>Update Now</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}
