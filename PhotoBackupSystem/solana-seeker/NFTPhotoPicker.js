// NFT Photo Picker Component
// Large thumbnail grid for selecting photos to mint as NFTs

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
  Animated,
  Modal,
  TextInput,
  ScrollView,
  Platform,
  Keyboard,
  NativeModules,
  UIManager,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Switch,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import * as SecureStore from 'expo-secure-store';
import { Feather } from '@expo/vector-icons';
import { t } from './i18n';
import { estimateNFTMintCost, computeLimitedEditionFee, isCNFTAvailable, NFT_FEES, isPromoActive, getPromoDaysRemaining, NFT_EDITION, NFT_LICENSE_OPTIONS, EDITION_ROYALTY_BPS, NFT_COMMISSION_WALLET, NFT_PAYMENT_METHODS, SKR_TOKEN_SYMBOL, fetchWeeklyNftDiscountQuote, NFT_WEEKLY_DISCOUNT_FALLBACK } from './nftOperations';

const NFT_WELCOME_SHOWN_KEY = 'nft_welcome_shown';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCREEN_HEIGHT_FULL = Dimensions.get('screen').height;
const ANDROID_NAV_BAR_HEIGHT = Platform.OS === 'android' ? Math.max(48, SCREEN_HEIGHT_FULL - SCREEN_HEIGHT) : 0;
const THUMBNAIL_SIZE = (SCREEN_WIDTH - 48) / 3; // 3 columns with padding
const LARGE_THUMBNAIL_SIZE = (SCREEN_WIDTH - 32) / 2; // 2 columns for NFT picker
const IS_SMALL_SCREEN = SCREEN_WIDTH < 430;

// ============================================================================
// COLORS (matching app theme)
// ============================================================================

const COLORS = {
  background: '#030308',
  surface: '#0A0A14',
  surfaceLight: 'rgba(10, 10, 20, 0.96)',
  primary: '#0099FF',
  secondary: '#A78BFA',
  accent: '#00FFA3',
  text: '#EEEEF6',
  textSecondary: '#7676A0',
  textMuted: '#5C5C80',
  border: 'rgba(167,139,250,0.12)',
  error: '#FF4466',
  warning: '#F5C842',
};
const IOS_RAW_EXTENSIONS = new Set(['dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'pef', 'srw', 'raf']);

const HAS_EXPO_LINEAR_GRADIENT = (() => {
  try {
    // expo-linear-gradient view manager names differ between build modes
    return !!(
      UIManager.getViewManagerConfig?.('ViewManagerAdapter_ExpoLinearGradient') ||
      UIManager.getViewManagerConfig?.('ExpoLinearGradient')
    );
  } catch (e) {
    return false;
  }
})();

const GradientBox = ({ colors, start, end, style, fallbackColor, children }) => {
  if (HAS_EXPO_LINEAR_GRADIENT) {
    return (
      <LinearGradient colors={colors} start={start} end={end} style={style}>
        {children}
      </LinearGradient>
    );
  }
  return (
    <View style={[style, { backgroundColor: fallbackColor || colors?.[0] || COLORS.secondary }]}>
      {children}
    </View>
  );
};

// ============================================================================
// NFT PHOTO PICKER COMPONENT
// ============================================================================

const NFTPhotoPicker = ({
  visible,
  onClose,
  onSelectPhoto,
  resolveReadableFilePath,
  serverConfig,        // StealthCloud server config { baseUrl, headers }
  checkCloudEligibility, // Function to check StealthCloud eligibility
  nftFeesWaived = false,
  nftFeeDiscountPercent = 0,
  nftFreeMintsRemaining = 0,
  isLegacySubscriber = false,
}) => {
  const insets = useSafeAreaInsets();
  const headerTopInset = Platform.OS === 'ios' ? insets.top + 12 : 12;
  const modalTopInset = Platform.OS === 'ios' ? insets.top + 12 : 44;
  const bottomInset = Platform.OS === 'android' ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT) : insets.bottom;
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [selectedPhotoExif, setSelectedPhotoExif] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [endCursor, setEndCursor] = useState(null);
  const [nftName, setNftName] = useState('');
  const [nftDescription, setNftDescription] = useState('');
  const [showMintConfirm, setShowMintConfirm] = useState(false);
  const [exifCache, setExifCache] = useState({}); // Cache EXIF data by asset id
  const [stripExif, setStripExif] = useState(false); // Privacy option to remove EXIF
  const [storageOption, setStorageOption] = useState('ipfs'); // 'ipfs' or 'cloud'
  const [nftType, setNftType] = useState('compressed'); // 'compressed' or 'standard'
  // Edition options
  const [edition, setEdition] = useState(NFT_EDITION.OPEN);
  const [license, setLicense] = useState('arr');
  const [watermark, setWatermark] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [showLicensePicker, setShowLicensePicker] = useState(false);
  const [cloudEligible, setCloudEligible] = useState(false);
  const [cloudReason, setCloudReason] = useState('');
  const [checkingCloud, setCheckingCloud] = useState(false);
  const [estimatedCost, setEstimatedCost] = useState(null);
  const [loadingCost, setLoadingCost] = useState(false);
  const [compressedEstimate, setCompressedEstimate] = useState(null);
  const [standardEstimate, setStandardEstimate] = useState(null);
  const [showWelcome, setShowWelcome] = useState(false); // HIDDEN: welcome modal disabled for simplified UI
  const [dontShowWelcomeAgain, setDontShowWelcomeAgain] = useState(false);
  const [welcomeChecked, setWelcomeChecked] = useState(false);
  const [expandedDetail, setExpandedDetail] = useState(null); // 'public' | 'private' | 'cert' | null
  const [certificationMode, setCertificationMode] = useState('private'); // 'private' | 'public'
  const [paymentMethod, setPaymentMethod] = useState(NFT_PAYMENT_METHODS.SOL);
  const [mintBlockchainConsent, setMintBlockchainConsent] = useState(false); // Blockchain consent for NFT minting
  const [weeklyDiscountQuote, setWeeklyDiscountQuote] = useState(NFT_WEEKLY_DISCOUNT_FALLBACK);
  
  const flatListRef = useRef(null);
  const slideAnim = useRef(new Animated.Value(0)).current;
  
  // HIDDEN: Welcome popup disabled for simplified certification UI — keep logic intact
  // useEffect(() => {
  //   const checkWelcome = async () => {
  //     if (visible && !welcomeChecked) {
  //       try {
  //         const shown = await SecureStore.getItemAsync(NFT_WELCOME_SHOWN_KEY);
  //         if (shown !== 'true') {
  //           setShowWelcome(true);
  //         }
  //       } catch (e) {
  //         setShowWelcome(true);
  //       }
  //       setWelcomeChecked(true);
  //     }
  //   };
  //   checkWelcome();
  // }, [visible, welcomeChecked]);
  
  // Certification mode handler — auto-configures hidden options
  const selectCertificationMode = useCallback((mode) => {
    setCertificationMode(mode);
    if (mode === 'private') {
      setEncrypt(true);
      setStorageOption('ipfs');
      setWatermark(false);
      setStripExif(false);
      setEdition(NFT_EDITION.LIMITED);
    } else {
      setEncrypt(false);
      setStorageOption('ipfs');
      setStripExif(false);
      setEdition(NFT_EDITION.OPEN);
    }
  }, []);

  // Wizard step transition animations
  const animateToForm = useCallback(() => {
    Animated.timing(slideAnim, { toValue: -SCREEN_WIDTH, duration: 250, useNativeDriver: true }).start(() => {
      setShowMintConfirm(true);
      slideAnim.setValue(SCREEN_WIDTH);
      Animated.timing(slideAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start();
    });
  }, [slideAnim]);

  const animateToPick = useCallback(() => {
    Animated.timing(slideAnim, { toValue: SCREEN_WIDTH, duration: 250, useNativeDriver: true }).start(() => {
      setShowMintConfirm(false);
      slideAnim.setValue(-SCREEN_WIDTH);
      Animated.timing(slideAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start();
    });
  }, [slideAnim]);

  const handleWizardBack = useCallback(() => {
    if (showMintConfirm) {
      setMintBlockchainConsent(false); // Reset consent when going back
      animateToPick();
    } else {
      onClose?.();
    }
  }, [showMintConfirm, animateToPick, onClose]);

  const tf = useCallback((key, fallback) => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  }, []);

  // Handle welcome popup dismiss
  const handleWelcomeDismiss = async () => {
    if (dontShowWelcomeAgain) {
      try {
        await SecureStore.setItemAsync(NFT_WELCOME_SHOWN_KEY, 'true');
      } catch (e) {
        console.log('[NFT] Could not save welcome preference');
      }
    }
    setShowWelcome(false);
  };
  
  // Load photos on mount
  useEffect(() => {
    if (visible) {
      loadPhotos();
    } else {
      // Reset state when closed
      setPhotos([]);
      setSelectedPhoto(null);
      setSelectedPhotoExif(null);
      setEndCursor(null);
      setHasMore(true);
      setNftName('');
      setNftDescription('');
      setShowMintConfirm(false);
      setMintBlockchainConsent(false); // Reset consent on close
      slideAnim.setValue(0);
      setExifCache({});
      setStripExif(false);
      setStorageOption('ipfs');
      setNftType('compressed');
      setEdition(NFT_EDITION.OPEN);
      setLicense('arr');
      setWatermark(false);
      setEncrypt(true);
      setShowLicensePicker(false);
      setCloudEligible(false);
      setCloudReason('');
      setWelcomeChecked(false);
      setEstimatedCost(null);
      setCertificationMode('private');
      setPaymentMethod(NFT_PAYMENT_METHODS.SOL);
      setWeeklyDiscountQuote(NFT_WEEKLY_DISCOUNT_FALLBACK);
    }
  }, [visible]);

  useEffect(() => {
    if (nftFeesWaived && paymentMethod !== NFT_PAYMENT_METHODS.SOL) {
      setPaymentMethod(NFT_PAYMENT_METHODS.SOL);
    }
  }, [nftFeesWaived, paymentMethod]);

  useEffect(() => {
    if (!nftFeesWaived && nftFeeDiscountPercent > 0 && paymentMethod !== NFT_PAYMENT_METHODS.SKR) {
      setPaymentMethod(NFT_PAYMENT_METHODS.SKR);
    }
  }, [nftFeeDiscountPercent, nftFeesWaived, paymentMethod]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetchWeeklyNftDiscountQuote(serverConfig)
      .then((quote) => {
        if (!cancelled) setWeeklyDiscountQuote(quote || NFT_WEEKLY_DISCOUNT_FALLBACK);
      })
      .catch(() => {
        if (!cancelled) setWeeklyDiscountQuote(NFT_WEEKLY_DISCOUNT_FALLBACK);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, serverConfig?.baseUrl]);
  
  // Check StealthCloud eligibility when picker opens — default to cloud if eligible
  useEffect(() => {
    if (visible && checkCloudEligibility) {
      setCheckingCloud(true);
      checkCloudEligibility(5 * 1024 * 1024) // Estimate 5MB
        .then(result => {
          setCloudEligible(result.eligible);
          setCloudReason(result.reason || '');
          // Cloud eligible but don't auto-switch — default stays IPFS
          // User can manually select StealthCloud if they want encryption
        })
        .catch(() => {
          setCloudEligible(false);
          setCloudReason('Could not check');
        })
        .finally(() => setCheckingCloud(false));
    }
  }, [visible, checkCloudEligibility]);
  
  // Limited Edition: original photo embedded on-chain as data URI in metadata → uploaded to IPFS
  // Hashes + RFC 3161 + C2PA also in metadata. Encryption IS available (user choice).
  const isLimited = edition === NFT_EDITION.LIMITED;
  // StealthCloud requires encryption — force on and lock
  const isCloudSelected = storageOption === 'cloud';
  // Lock encryption/watermark only for Open Edition + onchain (SVG vector, not meaningful to encrypt)
  // Limited Edition keeps encryption available — the embedded original image can be encrypted
  const isOnchainLocked = !isLimited && edition === NFT_EDITION.OPEN && storageOption === 'onchain';
  useEffect(() => {
    if (isLimited) {
      setStorageOption('onchain');
    }
  }, [isLimited]);
  useEffect(() => {
    if (isCloudSelected) {
      setEncrypt(true); // StealthCloud: encryption mandatory
    } else if (isOnchainLocked) {
      setEncrypt(false);
      setWatermark(false);
    }
  }, [isCloudSelected, isOnchainLocked]);

  const getPhotoFileSize = useCallback(async (photo) => {
    if (!photo?.id) return photo?.fileSize || 0;
    let cleanupUri = null;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(photo.id, { shouldDownloadFromNetwork: true });
      const rawFilename = String(info?.filename || photo?.filename || '');
      const rawExt = rawFilename.includes('.') ? rawFilename.split('.').pop().toLowerCase() : '';
      if (Platform.OS === 'ios' && IOS_RAW_EXTENSIONS.has(rawExt) && resolveReadableFilePath) {
        const resolved = await resolveReadableFilePath({ assetId: photo.id, assetInfo: info });
        const rawUri = resolved?.filePath
          ? (resolved.filePath.startsWith('/') ? `file://${resolved.filePath}` : resolved.filePath)
          : null;
        if (rawUri) {
          const rawInfo = await FileSystem.getInfoAsync(rawUri);
          if (rawInfo?.exists && rawInfo.size) {
            return rawInfo.size;
          }
        }
        if (resolved?.tmpCopied) {
          cleanupUri = resolved.tmpUri || rawUri;
        }
      }
      let realSize = info?.fileSize || info?.size || photo?.fileSize || 0;
      if (!realSize && (info?.localUri || info?.uri)) {
        const fsInfo = await FileSystem.getInfoAsync(info.localUri || info.uri);
        if (fsInfo?.exists && fsInfo.size) realSize = fsInfo.size;
      }
      return realSize || 0;
    } catch (_) {
      return photo?.fileSize || 0;
    } finally {
      if (cleanupUri) {
        FileSystem.deleteAsync(cleanupUri, { idempotent: true }).catch(() => {});
      }
    }
  }, [resolveReadableFilePath]);

  // Estimate cost when options change (debounced to avoid 429 RPC spam)
  useEffect(() => {
    if (!selectedPhoto) return;
    setLoadingCost(true);
    const useCompressed = nftType === 'compressed';
    let cancelled = false;
    const timer = setTimeout(() => {
      getPhotoFileSize(selectedPhoto)
        .then((fileSize) => {
          if (cancelled) return null;
          console.log('[NFTPicker] Cost estimate fileSize:', fileSize, 'bytes =', Math.round(fileSize / 1024), 'KB, edition:', edition);
          const effectiveDiscountQuote = nftFeesWaived
            ? { ...weeklyDiscountQuote, discountPercent: 100, multiplier: 0 }
            : nftFeeDiscountPercent > 0
              ? { ...weeklyDiscountQuote, discountPercent: nftFeeDiscountPercent, multiplier: (100 - nftFeeDiscountPercent) / 100 }
              : weeklyDiscountQuote;
          return estimateNFTMintCost(fileSize || 500 * 1024, storageOption, useCompressed, edition, paymentMethod, effectiveDiscountQuote);
        })
        .then(cost => {
          if (!cancelled) setEstimatedCost(cost);
        })
        .catch(e => {
          console.log('[NFTPicker] Cost estimation failed:', e.message);
          if (!cancelled) setEstimatedCost(null);
        })
        .finally(() => {
          if (!cancelled) setLoadingCost(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedPhoto, storageOption, nftType, edition, paymentMethod, weeklyDiscountQuote, nftFeeDiscountPercent, getPhotoFileSize]);

  // Card estimates for both types (debounced to avoid 429 RPC spam)
  useEffect(() => {
    if (!selectedPhoto) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getPhotoFileSize(selectedPhoto)
        .then((fileSize) => Promise.all([
          estimateNFTMintCost(fileSize || 500 * 1024, storageOption, true, edition).catch(() => null),
          estimateNFTMintCost(fileSize || 500 * 1024, storageOption, false, edition).catch(() => null),
        ]))
        .then(([cnft, standard]) => {
          if (!cancelled) {
            setCompressedEstimate(cnft);
            setStandardEstimate(standard);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCompressedEstimate(null);
            setStandardEstimate(null);
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedPhoto, storageOption, edition, getPhotoFileSize]);
  
  // Cache of PhotoLynkDeleted asset IDs for filtering
  const deletedIdsRef = useRef(null);

  // Build set of asset IDs in PhotoLynkDeleted album
  const getDeletedIds = async () => {
    if (deletedIdsRef.current) return deletedIdsRef.current;
    const ids = new Set();
    try {
      const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: false });
      const deletedAlbum = albums.find(a => a.title === 'PhotoLynkDeleted');
      if (deletedAlbum) {
        let cursor = null;
        while (true) {
          const page = await MediaLibrary.getAssetsAsync({
            first: 500,
            after: cursor || undefined,
            album: deletedAlbum.id,
            mediaType: ['photo'],
          });
          if (page?.assets) for (const a of page.assets) ids.add(a.id);
          cursor = page?.endCursor;
          if (!page?.hasNextPage || !page?.assets?.length) break;
        }
        console.log('[NFTPicker] Excluding', ids.size, 'assets from PhotoLynkDeleted');
      }
    } catch (e) {
      console.log('[NFTPicker] Could not get PhotoLynkDeleted album:', e?.message);
    }
    deletedIdsRef.current = ids;
    return ids;
  };

  // Load photos from media library
  const loadPhotos = async (after = null) => {
    try {
      if (after) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      
      // Request only photo permissions (not audio/video) on Android 13+
      const permission = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      if (permission.status !== 'granted') {
        setLoading(false);
        return;
      }

      // Build excluded IDs set on first load
      const deletedIds = await getDeletedIds();
      
      const result = await MediaLibrary.getAssetsAsync({
        first: 50,
        after,
        mediaType: ['photo'],
        sortBy: [MediaLibrary.SortBy.creationTime],
      });
      
      // Filter out photos from PhotoLynkDeleted folder (by album ID + URI fallback)
      const filtered = result.assets.filter(a => {
        if (deletedIds.has(a.id)) return false;
        const uri = a?.uri || '';
        const localUri = a?.localUri || '';
        if (uri.includes('/PhotoLynkDeleted/') || localUri.includes('/PhotoLynkDeleted/')) return false;
        return true;
      });
      
      if (after) {
        setPhotos(prev => [...prev, ...filtered]);
      } else {
        setPhotos(filtered);
      }
      
      setEndCursor(result.endCursor);
      setHasMore(result.hasNextPage);
    } catch (e) {
      console.error('[NFTPicker] Load photos error:', e);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };
  
  // Load more photos when scrolling
  const loadMore = () => {
    if (!loadingMore && hasMore && endCursor) {
      loadPhotos(endCursor);
    }
  };
  
  // Extract EXIF date from asset info
  const extractExifDate = (exif) => {
    if (!exif) return null;
    
    // Try various EXIF date fields
    const dateFields = ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime', 'CreateDate'];
    for (const field of dateFields) {
      if (exif[field]) {
        try {
          // EXIF date format: "YYYY:MM:DD HH:MM:SS"
          const dateStr = String(exif[field]).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
          const date = new Date(dateStr);
          if (!isNaN(date.getTime()) && date.getFullYear() > 1971) {
            return date;
          }
        } catch (e) {}
      }
    }
    return null;
  };
  
  // Extract GPS location from EXIF
  const extractExifLocation = (exif) => {
    if (!exif) return null;
    
    const lat = exif.GPSLatitude;
    const lon = exif.GPSLongitude;
    const latRef = exif.GPSLatitudeRef;
    const lonRef = exif.GPSLongitudeRef;
    
    if (lat && lon) {
      // Convert to decimal degrees if needed
      let latitude = typeof lat === 'number' ? lat : null;
      let longitude = typeof lon === 'number' ? lon : null;
      
      if (latitude && longitude) {
        if (latRef === 'S') latitude = -latitude;
        if (lonRef === 'W') longitude = -longitude;
        return { latitude, longitude };
      }
    }
    return null;
  };
  
  // Get best date for a photo (EXIF > creationTime > modificationTime)
  const getBestDate = (photo, exifData) => {
    // 1. Try EXIF date first (most accurate)
    if (exifData?.dateTaken) {
      return exifData.dateTaken;
    }
    
    // 2. Try MediaLibrary creationTime (may be restore date)
    if (photo.creationTime && photo.creationTime > 0) {
      const date = new Date(photo.creationTime);
      if (date.getFullYear() > 1971) {
        return date;
      }
    }
    
    // 3. Try modificationTime
    if (photo.modificationTime && photo.modificationTime > 0) {
      const date = new Date(photo.modificationTime);
      if (date.getFullYear() > 1971) {
        return date;
      }
    }
    
    return null;
  };
  
  // Load EXIF data for a photo
  const loadExifForPhoto = async (photo) => {
    if (exifCache[photo.id]) {
      return exifCache[photo.id];
    }
    
    try {
      const info = await MediaLibrary.getAssetInfoAsync(photo.id);
      const exif = info?.exif;
      
      const exifData = {
        dateTaken: extractExifDate(exif),
        location: extractExifLocation(exif),
        camera: exif?.Make && exif?.Model 
          ? `${exif.Make} ${exif.Model}`.trim() 
          : exif?.Model || exif?.Make || null,
        raw: exif,
      };
      
      // Cache it
      setExifCache(prev => ({ ...prev, [photo.id]: exifData }));
      return exifData;
    } catch (e) {
      console.log('[NFTPicker] EXIF extraction failed:', e.message);
      return null;
    }
  };
  
  // Handle photo selection - load EXIF data
  const handleSelectPhoto = async (photo) => {
    setSelectedPhoto(photo);
    setSelectedPhotoExif(null); // Clear previous
    
    // Generate default name from filename
    const baseName = photo.filename?.replace(/\.[^/.]+$/, '') || 'Photo';
    setNftName(`${baseName} NFT`);
    
    // Fetch real fileSize from asset info so cost estimates are accurate
    try {
      const realSize = await getPhotoFileSize(photo);
      console.log('[NFTPicker] Photo fileSize:', realSize, 'bytes =', Math.round(realSize / 1024), 'KB');
      if (realSize && realSize !== photo.fileSize) {
        setSelectedPhoto({ ...photo, fileSize: realSize });
      }
    } catch (e) {
      console.log('[NFTPicker] fileSize fetch failed:', e?.message);
    }
    
    // Load EXIF data in background
    const exifData = await loadExifForPhoto(photo);
    setSelectedPhotoExif(exifData);
  };
  
  // Handle mint confirmation
  const handleMintConfirm = async () => {
    if (!selectedPhoto) return;
    
    setShowMintConfirm(false);
    
    // Get file path — resolveReadableFilePath stages ph:// / content:// to file://
    // and extracts original RAW resource on iOS (not JPEG sidecar)
    let filePath = null;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(selectedPhoto.id);
      filePath = info.localUri || info.uri || selectedPhoto.uri;
      
      if (resolveReadableFilePath) {
        const resolved = await resolveReadableFilePath({ assetId: selectedPhoto.id, assetInfo: info });
        if (resolved && resolved.filePath) {
          filePath = resolved.filePath;
        }
      }
    } catch (e) {
      console.log('[NFTPicker] Using fallback URI');
    }
    
    // Fallback to asset URI if no path found
    if (!filePath) {
      filePath = selectedPhoto.uri;
    }
    
    if (!filePath) {
      console.error('[NFTPicker] No file path available');
      return;
    }
    
    onSelectPhoto?.({
      asset: selectedPhoto,
      filePath,
      name: nftName || `PhotoLynk #${Date.now()}`,
      description: nftDescription || t('nftMint.defaultDescription'),
      stripExif: stripExif,
      storageOption: storageOption,
      nftType: nftType, // 'compressed' or 'standard'
      serverConfig: serverConfig,
      costEstimate: estimatedCost,
      // Edition parameters
      edition,
      license,
      watermark,
      encrypt,
      certificationMode,
      paymentMethod,
      weeklyDiscountQuote: nftFeesWaived
        ? { ...weeklyDiscountQuote, discountPercent: 100, multiplier: 0 }
        : nftFeeDiscountPercent > 0
          ? { ...weeklyDiscountQuote, discountPercent: nftFeeDiscountPercent, multiplier: (100 - nftFeeDiscountPercent) / 100 }
          : weeklyDiscountQuote,
    });
    
    onClose?.();
  };

  const paymentQuote = estimatedCost?.payment || null;
  const isSkrSelected = paymentMethod === NFT_PAYMENT_METHODS.SKR;
  const skrTokenAmount = paymentQuote?.commission?.tokenAmountFormatted
    ? `${paymentQuote.commission.tokenAmountFormatted} ${SKR_TOKEN_SYMBOL}`
    : `Live ${SKR_TOKEN_SYMBOL} quote`;
  const skrSavingsUsd = Number(paymentQuote?.commission?.savingsUsd || 0);
  const skrNetworkDisplay = paymentQuote?.network?.solFormatted
    ? `${paymentQuote.network.solFormatted} SOL`
    : '—';
  const skrDiscountedUsd = Number(paymentQuote?.commission?.discountedUsd || 0);
  const weeklyDiscountPercent = nftFeesWaived
    ? 100
    : nftFeeDiscountPercent > 0
      ? Math.min(90, Math.max(0, Number(nftFeeDiscountPercent || 0)))
      : Math.min(90, Math.max(0, Number(weeklyDiscountQuote?.discountPercent || 0)));
  const weeklyDiscountHelpText = weeklyDiscountQuote?.loyaltyFreeWeekActive
    ? 'PhotoLynk fee waived this week. Network costs still apply.'
    : 'Member pricing is applied automatically. High-volume certification unlocks additional fee waivers.';
  const mintButtonLabel = loadingCost
    ? t('nftMint.estimating')
    : nftFeesWaived && nftFreeMintsRemaining > 0
      ? `${t('nftMint.certifyOriginal')} • Free`
    : isLegacySubscriber
      ? `${t('nftMint.certifyOriginal')} • Fee waived`
    : nftFeesWaived
      ? `${t('nftMint.certifyOriginal')} • Fee waived`
    : paymentMethod === NFT_PAYMENT_METHODS.SKR
      ? `${t('nftMint.certifyOriginal')} • ${weeklyDiscountPercent}% off`
      : t('nftMint.certifyOriginal');
  
  // Render photo thumbnail
  const renderPhoto = useCallback(({ item }) => {
    const isSelected = selectedPhoto?.id === item.id;
    
    return (
      <TouchableOpacity
        style={[styles.photoContainer, isSelected && styles.photoSelected]}
        onPress={() => handleSelectPhoto(item)}
        activeOpacity={0.7}
      >
        <Image
          source={{ uri: item.uri }}
          style={styles.photoThumbnail}
          resizeMode="cover"
        />
        {isSelected && (
          <View style={styles.selectedOverlay}>
            <Feather name="check-circle" size={32} color={COLORS.accent} />
          </View>
        )}
        <View style={styles.photoInfo}>
          <Text style={styles.photoDate} numberOfLines={1}>
            {item.creationTime && item.creationTime > 0 
              ? new Date(item.creationTime).toLocaleDateString()
              : item.modificationTime && item.modificationTime > 0
                ? new Date(item.modificationTime).toLocaleDateString()
                : t('nftMint.noDate')}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }, [selectedPhoto]);
  
  // Render footer (loading indicator)
  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={styles.loadingFooter}>
        <ActivityIndicator size="small" color={COLORS.primary} />
      </View>
    );
  };
  
  // Render form step content — replaces photo grid when user taps Next
  const renderFormStep = () => {
    return (
        <KeyboardAvoidingView 
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
              contentContainerStyle={styles.mintPanelScroll}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >

              {/* ── Promo banner ── */}
              {isPromoActive() && (
                <GradientBox
                  colors={[COLORS.primary, '#14F195']}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={styles.mintPromoBanner}
                  fallbackColor={COLORS.primary}
                >
                  <Text style={styles.mintPromoText}>🎉 {t('nftMint.launchSpecialBanner', { days: getPromoDaysRemaining() })}</Text>
                </GradientBox>
              )}

              {/* ── 2. Photo preview (matches desktop .nft-photo-select / .nft-photo-preview) ── */}
              {selectedPhoto && (
                <View style={styles.mintHeroCard}>
                  <View style={styles.mintSelectedPhotoThumb}>
                    <Image
                      source={{ uri: selectedPhoto.uri }}
                      style={styles.mintSelectedPhotoThumbImage}
                      resizeMode="cover"
                    />
                  </View>
                  <View style={styles.mintHeroMeta}>
                    <Text style={styles.mintHeroEyebrow}>{tf('nftMint.selectedPhoto', 'Selected photo')}</Text>
                    <Text style={styles.mintHeroTitle} numberOfLines={1}>{selectedPhoto.filename || tf('nftMint.photo', 'Photo')}</Text>
                    <Text style={styles.mintHeroSub}>{selectedPhoto.width} × {selectedPhoto.height}</Text>
                  </View>
                </View>
              )}

              {/* ── 3. Name input (matches desktop .nft-input) ── */}
              <View style={styles.mintFieldSection}>
                <Text style={styles.mintFieldEyebrow}>{tf('nftMint.photoName', 'Name your certification')}</Text>
                <Text style={styles.mintFieldHelp}>{tf('nftMint.photoNamePlaceholder', 'Choose a short name that will appear with the NFT certificate.')}</Text>
                <TextInput
                  style={styles.mintInput}
                  value={nftName}
                  onChangeText={setNftName}
                  placeholder={tf('nftMint.nftName', 'Name')}
                  placeholderTextColor={COLORS.textSecondary}
                  maxLength={50}
                />
              </View>

              {/* ── 4. Privacy Level cards (matches desktop .nft-cert-options) ── */}
              <View style={styles.mintCertSection}>
              <Text style={styles.mintSectionLabel}>{t('nftMint.certificationModeLabel')}</Text>
              <Text style={styles.mintCertSectionDesc}>{t('nftMint.certificationModeDesc')}</Text>
              <View style={[styles.mintCardRow, { flexDirection: 'column', gap: 10 }]}>
                <TouchableOpacity
                  style={[styles.mintCertCard, certificationMode === 'private' && styles.mintCertCardActive]}
                  onPress={() => selectCertificationMode('private')}
                  activeOpacity={0.85}
                >
                  <View style={styles.mintCertCardTop}>
                    <View style={styles.mintCertCardHeader}>
                      <View style={[styles.mintCertIconWrap, certificationMode === 'private' && styles.mintCertIconWrapActive]}>
                        <Feather name="lock" size={16} color={certificationMode === 'private' ? '#ffffff' : COLORS.textSecondary} />
                      </View>
                      <View style={styles.mintCertCardTextWrap}>
                        <Text style={[styles.mintCertCardName, certificationMode === 'private' && { color: '#fff' }]}>{t('nftMint.privateCertifiedTitle')}</Text>
                      </View>
                    </View>
                    {certificationMode === 'private' ? (
                      <View style={styles.mintCertSelectedBadge}>
                        <Feather name="check" size={12} color="#fff" />
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.mintCertCardDesc}>{t('nftMint.privateCertifiedDesc')}</Text>
                  <View style={styles.mintCertChips}>
                    <View style={styles.chipGreen}><Text style={styles.chipGreenText}>{t('nftMint.chipFullQuality')}</Text></View>
                    <View style={styles.chipGreen}><Text style={styles.chipGreenText}>{t('nftMint.chipZeroKnowledge')}</Text></View>
                    <View style={styles.chipGreen}><Text style={styles.chipGreenText}>{t('nftMint.chipExifPreserved')}</Text></View>
                    <View style={styles.chipGreen}><Text style={styles.chipGreenText}>{t('nftMint.chipTransferable')}</Text></View>
                    <View style={styles.chipGreen}><Text style={styles.chipGreenText}>{t('nftMint.chipPrivacyFirst')}</Text></View>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.mintCertCard, certificationMode === 'public' && styles.mintCertCardActive]}
                  onPress={() => selectCertificationMode('public')}
                  activeOpacity={0.85}
                >
                  <View style={styles.mintCertCardTop}>
                    <View style={styles.mintCertCardHeader}>
                      <View style={[styles.mintCertIconWrap, certificationMode === 'public' && styles.mintCertIconWrapActive]}>
                        <Feather name="globe" size={16} color={certificationMode === 'public' ? '#ffffff' : COLORS.textSecondary} />
                      </View>
                      <View style={styles.mintCertCardTextWrap}>
                        <Text style={[styles.mintCertCardName, certificationMode === 'public' && { color: '#fff' }]}>{t('nftMint.publicCertifiedTitle')}</Text>
                      </View>
                    </View>
                    {certificationMode === 'public' ? (
                      <View style={styles.mintCertSelectedBadge}>
                        <Feather name="check" size={12} color="#fff" />
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.mintCertCardDesc}>{t('nftMint.publicCertifiedDesc')}</Text>
                  <View style={styles.mintCertChips}>
                    <View style={styles.chipGreen}><Text style={styles.chipGreenText}>{t('nftMint.chipFullQuality')}</Text></View>
                    <View style={styles.chipAmber}><Text style={styles.chipAmberText}>{t('nftMint.chipPubliclyVisible')}</Text></View>
                    <View style={styles.chipGreen}><Text style={styles.chipGreenText}>{t('nftMint.chipTransferable')}</Text></View>
                  </View>
                </TouchableOpacity>
              </View>
              </View>

              {/* ── 5. Watermark toggle (public only, matches desktop #watermark-option) ── */}
              {false && certificationMode === 'public' && (
                <TouchableOpacity style={styles.mintToggleRow} onPress={() => setWatermark(!watermark)} activeOpacity={0.85}>
                  <View style={styles.mintToggleLeft}>
                    <Feather name="droplet" size={14} color={watermark ? COLORS.accent : 'rgba(255,255,255,0.5)'} />
                    <View>
                      <Text style={styles.mintToggleTitle}>{t('nftMint.addWatermark')}</Text>
                      <Text style={styles.mintToggleDesc}>{t('nftMint.publicCertifiedDesc')}</Text>
                    </View>
                  </View>
                  <Switch value={watermark} onValueChange={setWatermark} />
                </TouchableOpacity>
              )}

              {/* ── 6. Strip EXIF toggle (matches desktop .nft-toggle-row) ── */}
              <View style={styles.mintOptionsSection}>
                <Text style={styles.mintFieldEyebrow}>{tf('nftMint.settings', 'Protection & rights')}</Text>
                <Text style={styles.mintFieldHelp}>{tf('nftMint.removePrivateDataDesc', 'Choose how metadata is handled and what license travels with the NFT.')}</Text>
                <TouchableOpacity style={[styles.mintToggleRow, certificationMode === 'private' && { opacity: 0.4 }]} onPress={() => certificationMode !== 'private' && setStripExif(!stripExif)} activeOpacity={0.85} disabled={certificationMode === 'private'}>
                  <View style={styles.mintToggleLeft}>
                    <Feather name="shield" size={14} color={stripExif ? COLORS.accent : 'rgba(255,255,255,0.5)'} />
                    <View>
                      <Text style={styles.mintToggleTitle}>{tf('nftMint.removePrivateData', 'Remove private data')}</Text>
                      <Text style={styles.mintToggleDesc}>{certificationMode === 'private' ? tf('nftMint.exifPreservedPrivate', 'EXIF preserved in private mode') : tf('nftMint.removePrivateDataDesc', 'Strip location, camera info, and other metadata')}</Text>
                    </View>
                  </View>
                  <Switch value={stripExif} onValueChange={certificationMode === 'private' ? undefined : setStripExif} disabled={certificationMode === 'private'} />
                </TouchableOpacity>

                {/* ── 7. License picker (matches desktop .nft-input select) ── */}
                <TouchableOpacity style={styles.mintToggleRow} onPress={() => setShowLicensePicker(!showLicensePicker)} activeOpacity={0.85}>
                  <View style={styles.mintToggleLeft}>
                    <Feather name="file-text" size={14} color={COLORS.primary} />
                    <View>
                      <Text style={styles.mintToggleTitle}>{tf('nftMint.licenseLabel', 'License')}</Text>
                      <Text style={styles.mintToggleDesc}>{tf('nftMint.licenseDesc', 'Select how others can use or share this certified photo.')}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{ color: COLORS.textSecondary, fontSize: 12, fontWeight: '500', marginRight: 4 }}>
                      {NFT_LICENSE_OPTIONS.find(l => l.id === license)?.short || 'ARR'}
                    </Text>
                    <Feather name={showLicensePicker ? 'chevron-up' : 'chevron-down'} size={14} color={COLORS.textSecondary} />
                  </View>
                </TouchableOpacity>

                {showLicensePicker && (
                  <View style={styles.mintLicenseList}>
                    {NFT_LICENSE_OPTIONS.map(opt => (
                      <TouchableOpacity
                        key={opt.id}
                        style={[styles.mintLicenseItem, license === opt.id && styles.mintLicenseItemActive]}
                        onPress={() => { setLicense(opt.id); setShowLicensePicker(false); }}
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.mintLicenseItemText, license === opt.id && { color: COLORS.primary }]}>{t(`nftMint.license_${opt.id.replace(/-/g,'_')}`) || opt.label}</Text>
                        {license === opt.id && <Feather name="check" size={14} color={COLORS.primary} />}
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {nftFeesWaived && nftFreeMintsRemaining > 0 ? (
                <View style={styles.mintInfoBanner}>
                  <Feather name="award" size={13} color={COLORS.accent} />
                  <Text style={styles.mintInfoText}>Premium benefit: fully free mint (no app fee, no network fee).</Text>
                </View>
              ) : isLegacySubscriber ? (
                <View style={styles.mintInfoBanner}>
                  <Feather name="award" size={13} color={COLORS.accent} />
                  <Text style={styles.mintInfoText}>Subscription benefit: PhotoLynk app fee waived. Network fees apply.</Text>
                </View>
              ) : nftFeesWaived ? (
                <View style={styles.mintInfoBanner}>
                  <Feather name="award" size={13} color={COLORS.accent} />
                  <Text style={styles.mintInfoText}>Premium benefit: $0.02 USDC flat fee covers all expenses.</Text>
                </View>
              ) : (
                <View style={styles.mintPaymentSection}>
                  <View style={styles.mintPaymentHeaderRow}>
                    <View style={{ flex: 1, flexShrink: 1, marginRight: 10 }}>
                      <Text style={styles.mintFieldEyebrow}>Payment</Text>
                      <Text style={styles.mintFieldHelp}>Choose how to pay the PhotoLynk certification fee.</Text>
                    </View>
                    <View style={styles.mintPaymentBadge}>
                      <Feather name="zap" size={10} color={COLORS.accent} />
                      <Text style={styles.mintPaymentBadgeText}>{SKR_TOKEN_SYMBOL} {weeklyDiscountPercent}% OFF</Text>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={[styles.mintPaymentCard, paymentMethod === NFT_PAYMENT_METHODS.SOL && styles.mintPaymentCardActive]}
                    onPress={() => setPaymentMethod(NFT_PAYMENT_METHODS.SOL)}
                    activeOpacity={0.85}
                  >
                    <View style={styles.mintPaymentCardTop}>
                      <View style={styles.mintPaymentCardTitleRow}>
                        <View style={[styles.mintPaymentIconWrap, paymentMethod === NFT_PAYMENT_METHODS.SOL && styles.mintPaymentIconWrapActive]}>
                          <Feather name="sun" size={15} color={paymentMethod === NFT_PAYMENT_METHODS.SOL ? '#041118' : COLORS.primary} />
                        </View>
                        <View style={styles.mintPaymentCopyWrap}>
                          <Text style={[styles.mintPaymentCardTitle, paymentMethod === NFT_PAYMENT_METHODS.SOL && styles.mintPaymentCardTitleActive]}>Pay with SOL</Text>
                          <Text style={styles.mintPaymentCardSubtitle}>One currency for mint, network, and PhotoLynk fee.</Text>
                        </View>
                      </View>
                      {paymentMethod === NFT_PAYMENT_METHODS.SOL ? (
                        <View style={styles.mintPaymentSelectedBadge}>
                          <Feather name="check" size={12} color="#041118" />
                        </View>
                      ) : null}
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.mintPaymentCard, paymentMethod === NFT_PAYMENT_METHODS.SKR && styles.mintPaymentCardActiveSkr]}
                    onPress={() => setPaymentMethod(NFT_PAYMENT_METHODS.SKR)}
                    activeOpacity={0.85}
                  >
                    <View style={styles.mintPaymentCardTop}>
                      <View style={styles.mintPaymentCardTitleRow}>
                        <View style={[styles.mintPaymentIconWrap, styles.mintPaymentIconWrapSkr, paymentMethod === NFT_PAYMENT_METHODS.SKR && styles.mintPaymentIconWrapSkrActive]}>
                          <Feather name="award" size={15} color={paymentMethod === NFT_PAYMENT_METHODS.SKR ? '#041118' : COLORS.accent} />
                        </View>
                        <View style={styles.mintPaymentCopyWrap}>
                          <Text style={[styles.mintPaymentCardTitle, paymentMethod === NFT_PAYMENT_METHODS.SKR && styles.mintPaymentCardTitleActive]}>{`Pay with ${SKR_TOKEN_SYMBOL}`}</Text>
                          <Text style={styles.mintPaymentCardSubtitle}>{weeklyDiscountHelpText}</Text>
                        </View>
                      </View>
                      <View style={styles.mintPaymentPromoPill}>
                        <Text style={styles.mintPaymentPromoPillText}>{`${weeklyDiscountPercent}% OFF`}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                </View>
              )}

              {/* ── HIDDEN sections (logic preserved, not rendered) ── */}
              {false && (
              <>
              <Text style={styles.mintSectionLabel}>{t('nftMint.editionLabel')}</Text>
              <View style={[styles.mintCardRow, IS_SMALL_SCREEN && styles.mintCardRowStack]}>
                <TouchableOpacity
                  style={[styles.mintOptionCard, edition === NFT_EDITION.OPEN && styles.mintOptionCardActive]}
                  onPress={() => setEdition(NFT_EDITION.OPEN)}
                  activeOpacity={0.85}
                >
                  <Feather name="image" size={18} color={edition === NFT_EDITION.OPEN ? COLORS.primary : COLORS.textSecondary} style={{ marginBottom: 4 }} />
                  <Text style={styles.mintOptionTitle} numberOfLines={1}>{t('nftMint.openEdition')}</Text>
                  <Text style={styles.mintOptionSubtitle}>{t('nftMint.photoOnBlockchain')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.mintOptionCard, edition === NFT_EDITION.LIMITED && styles.mintOptionCardActive]}
                  onPress={() => setEdition(NFT_EDITION.LIMITED)}
                  activeOpacity={0.85}
                >
                  <Feather name="award" size={18} color={edition === NFT_EDITION.LIMITED ? COLORS.accent : COLORS.textSecondary} style={{ marginBottom: 4 }} />
                  <Text style={styles.mintOptionTitle} numberOfLines={1}>{t('nftMint.limitedEdition')}</Text>
                  <Text style={styles.mintOptionSubtitle}>{t('nftMint.copyrightCertificate')}</Text>
                </TouchableOpacity>
              </View>
              {edition === NFT_EDITION.LIMITED && (
                <View style={styles.mintInfoBanner}>
                  <Feather name="info" size={13} color={COLORS.accent} />
                  <Text style={styles.mintInfoText}>{t('nftMint.limitedEditionInfo')}</Text>
                </View>
              )}
              </>
              )}

              {false && (
              <>
              <Text style={styles.mintSectionLabel}>{t('nftMint.nftType')}</Text>
              <View style={[styles.mintCardRow, IS_SMALL_SCREEN && styles.mintCardRowStack]}>
                <TouchableOpacity style={[styles.mintOptionCard, nftType === 'compressed' && styles.mintOptionCardActive]} onPress={() => setNftType('compressed')} activeOpacity={0.85}>
                  <Text style={styles.mintOptionTitle} numberOfLines={1}>{t('nftMint.compressedCNft')}</Text>
                  <Text style={styles.mintOptionSubtitle}>{t('nftMint.compressedCheaper')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.mintOptionCard, nftType === 'standard' && styles.mintOptionCardActive]} onPress={() => setNftType('standard')} activeOpacity={0.85}>
                  <Text style={styles.mintOptionTitle} numberOfLines={1}>{t('nftMint.standardNft')}</Text>
                  <Text style={styles.mintOptionSubtitle}>{t('nftMint.standardTraditional')}</Text>
                </TouchableOpacity>
              </View>
              </>
              )}

              {false && !isLimited && (
              <>
              <Text style={styles.mintSectionLabel}>{t('nftMint.imageStorageLabel')}</Text>
              <View style={[styles.mintCardRow, IS_SMALL_SCREEN && styles.mintCardRowStack]}>
                <TouchableOpacity style={[styles.mintOptionCard, storageOption === 'ipfs' && styles.mintOptionCardActive]} onPress={() => setStorageOption('ipfs')} activeOpacity={0.85}>
                  <Text style={styles.mintOptionTitle} numberOfLines={1} ellipsizeMode="tail">IPFS</Text>
                  <Text style={styles.mintOptionSubtitle}>{t('nftMint.ipfsSub')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.mintOptionCard, storageOption === 'cloud' && styles.mintOptionCardActive, !cloudEligible && styles.mintOptionCardDisabled]} onPress={() => cloudEligible && setStorageOption('cloud')} disabled={!cloudEligible} activeOpacity={0.85}>
                  <Text style={styles.mintOptionTitle} numberOfLines={1} ellipsizeMode="tail">StealthCloud</Text>
                  <Text style={styles.mintOptionSubtitle}>{t('nftMint.cloudSub')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.mintOptionCard, storageOption === 'onchain' && styles.mintOptionCardActive]} onPress={() => setStorageOption('onchain')} activeOpacity={0.85}>
                  <Text style={styles.mintOptionTitle} numberOfLines={1} ellipsizeMode="tail">{t('nftMint.embeddedTitle')}</Text>
                  <Text style={styles.mintOptionSubtitle}>{t('nftMint.embeddedSub')}</Text>
                </TouchableOpacity>
              </View>
              </>)
              }

              {false && (
              <TouchableOpacity style={[styles.mintPrivacyRow, isOnchainLocked && !isCloudSelected && { opacity: 0.4 }]} onPress={() => !isOnchainLocked && !isCloudSelected && setEncrypt(!encrypt)} activeOpacity={isCloudSelected ? 1 : 0.85} disabled={isOnchainLocked || isCloudSelected}>
                <View style={styles.mintPrivacyLeft}>
                  <Feather name="lock" size={14} color={encrypt ? COLORS.accent : COLORS.textSecondary} />
                  <Text style={styles.mintPrivacyText}>{t('nftMint.encryptImage')}{isCloudSelected ? ` (${t('nftMint.encryptRequired')})` : ''}</Text>
                </View>
                <Switch value={encrypt} onValueChange={isCloudSelected ? undefined : setEncrypt} disabled={isOnchainLocked || isCloudSelected} />
              </TouchableOpacity>
              )}
              {false && (
              <TouchableOpacity style={[styles.mintPrivacyRow, isOnchainLocked && { opacity: 0.4 }]} onPress={() => !isOnchainLocked && setWatermark(!watermark)} activeOpacity={0.85} disabled={isOnchainLocked}>
                <View style={styles.mintPrivacyLeft}>
                  <Feather name="droplet" size={14} color={watermark ? COLORS.accent : COLORS.textSecondary} />
                  <Text style={styles.mintPrivacyText}>{t('nftMint.addWatermark')}</Text>
                </View>
                <Switch value={watermark} onValueChange={setWatermark} disabled={isOnchainLocked} />
              </TouchableOpacity>
              )}
              

              {/* ── 8. Estimated cost (matches desktop .nft-cost-display) ── */}
              <View style={styles.mintSummarySection}>
                <Text style={styles.mintFieldEyebrow}>{tf('nftMint.estTotal', 'Summary')}</Text>
                <Text style={styles.mintFieldHelp}>{tf('nftMint.costSummaryDesc', 'Review the estimated certification cost before minting.')}</Text>
                <View style={styles.mintCostRow}>
                  <Text style={styles.mintCostLabel}>{isSkrSelected ? 'Estimated value' : tf('nftMint.estTotal', 'Est. total')}</Text>
                  <Text style={styles.mintCostValue}>
                    {nftFeesWaived && nftFreeMintsRemaining > 0 ? 'Free' : isLegacySubscriber ? (estimatedCost ? (isSkrSelected
                      ? `~$${(Number(paymentQuote?.network?.usd || 0) + Number(paymentQuote?.commission?.discountedUsd || 0)).toFixed(2)}`
                      : `~${estimatedCost.total.usdFormatted}`
                    ) : '—') : nftFeesWaived ? '$0.02 USDC' : estimatedCost ? (isSkrSelected
                      ? `~$${(Number(paymentQuote?.network?.usd || 0) + Number(paymentQuote?.commission?.discountedUsd || 0)).toFixed(2)}`
                      : `~${estimatedCost.total.usdFormatted}`
                    ) : '—'}
                  </Text>
                </View>
                {nftFeesWaived && nftFreeMintsRemaining > 0 ? (
                  <Text style={styles.mintSummaryFinePrint}>Fully free mint — no app fee, no network fee. Premium covers all costs.</Text>
                ) : isLegacySubscriber ? (
                  <Text style={styles.mintSummaryFinePrint}>Subscription benefit: 80% off PhotoLynk app fee. Network fees still apply.</Text>
                ) : nftFeesWaived ? (
                  <Text style={styles.mintSummaryFinePrint}>$0.02 USDC flat fee per NFT. Covers all app and network expenses.</Text>
                ) : isSkrSelected ? (
                  <>
                    <View style={styles.mintCostRowCompact}>
                      <Text style={styles.mintCostLabel}>Mint + network</Text>
                      <Text style={styles.mintCostValueSecondary}>{skrNetworkDisplay}</Text>
                    </View>
                    <View style={styles.mintCostRowCompact}>
                      <Text style={styles.mintCostLabel}>{`PhotoLynk fee in ${SKR_TOKEN_SYMBOL}`}</Text>
                      <Text style={styles.mintCostValueSecondary}>{skrTokenAmount}</Text>
                    </View>
                    <View style={styles.mintCostRowCompact}>
                      <Text style={styles.mintCostLabel}>You save</Text>
                      <Text style={styles.mintCostValueSecondary}>{`~$${skrSavingsUsd.toFixed(2)}`}</Text>
                    </View>
                    <Text style={styles.mintSummaryFinePrint}>{`You still need SOL for network and mint costs. ${SKR_TOKEN_SYMBOL} only covers the discounted PhotoLynk fee (~$${skrDiscountedUsd.toFixed(2)}).`}</Text>
                  </>
                ) : null}
              </View>

            </ScrollView>
            {/* ── 9. Blockchain Consent + Certify button pinned at bottom ── */}
            <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12 + bottomInset, backgroundColor: '#040406' }}>
              {/* Blockchain Minting Consent */}
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}
                onPress={() => setMintBlockchainConsent(!mintBlockchainConsent)}
                activeOpacity={0.7}
              >
                <View style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  borderWidth: 1.5,
                  borderColor: mintBlockchainConsent ? COLORS.accent : 'rgba(255,255,255,0.12)',
                  backgroundColor: mintBlockchainConsent ? 'rgba(0,255,163,0.2)' : 'transparent',
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginTop: 2,
                }}>
                  {mintBlockchainConsent && <Feather name="check" size={14} color={COLORS.accent} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, color: '#AAA', lineHeight: 18 }}>
                    I understand that NFTs are{' '}
                    <Text style={{ color: '#FFF', fontWeight: '600' }}>permanently stored</Text>
                    {' '}on the Solana blockchain, that transaction fees are{' '}
                    <Text style={{ color: '#FFF', fontWeight: '600' }}>non-refundable</Text>,
                    {' '}and that my wallet{' '}
                    <Text style={{ color: '#FFF', fontWeight: '600' }}>private keys</Text>
                    {' '}never leave my device.{' '}
                    <Text
                      style={{ color: COLORS.accent, textDecorationLine: 'underline' }}
                      onPress={() => Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/terms.html#blockchain')}
                    >
                      Learn more
                    </Text>
                  </Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.mintFullBtn, (!mintBlockchainConsent || loadingCost) && { opacity: 0.5 }]}
                onPress={() => {
                  if (!mintBlockchainConsent) {
                    Alert.alert('Blockchain Consent Required', 'Please acknowledge the NFT minting terms to continue.');
                    return;
                  }
                  if (loadingCost) {
                    return;
                  }
                  handleMintConfirm();
                }}
                activeOpacity={mintBlockchainConsent && !loadingCost ? 0.85 : 1}
                disabled={!mintBlockchainConsent || loadingCost}
              >
                <GradientBox
                  colors={['#0099FF', '#0066CC']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.mintFullBtnGradient}
                  fallbackColor={COLORS.primary}
                >
                  <Text style={styles.mintFullBtnText}>
                    {mintButtonLabel}
                  </Text>
                </GradientBox>
              </TouchableOpacity>
            </View>
        </KeyboardAvoidingView>
    );
  };
  
  if (!visible) return null;
  
  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={handleWizardBack}
    >
      <View style={styles.container}>
        {/* Step-aware header */}
        <View style={[styles.header, { paddingTop: headerTopInset }]}>
          {showMintConfirm ? (
            <TouchableOpacity onPress={animateToPick} style={styles.closeButton}>
              <Feather name="arrow-left" size={24} color={COLORS.text} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Feather name="x" size={24} color={COLORS.text} />
            </TouchableOpacity>
          )}

          {/* Step indicator */}
          <View style={styles.stepIndicator}>
            <View style={[styles.stepDot, !showMintConfirm && styles.stepDotActive]} />
            <View style={[styles.stepLine, showMintConfirm && styles.stepLineActive]} />
            <View style={[styles.stepDot, showMintConfirm && styles.stepDotActive]} />
          </View>

          {!showMintConfirm ? (
            <TouchableOpacity
              style={[styles.nextButton, !selectedPhoto && styles.nextButtonDisabled]}
              onPress={() => selectedPhoto && animateToForm()}
              disabled={!selectedPhoto}
            >
              <Text style={[styles.nextButtonText, !selectedPhoto && styles.nextButtonTextDisabled]}>
                {t('nftMint.next')}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={{ width: 60 }} />
          )}
        </View>

        {/* Animated content area */}
        <Animated.View style={{ flex: 1, transform: [{ translateX: slideAnim }] }}>
          {!showMintConfirm ? (
            loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={COLORS.primary} />
                <Text style={styles.loadingText}>{t('nftMint.loadingPhotos')}</Text>
              </View>
            ) : (
              <FlatList
                ref={flatListRef}
                data={photos}
                renderItem={renderPhoto}
                keyExtractor={(item) => item.id}
                numColumns={2}
                contentContainerStyle={styles.gridContainer}
                columnWrapperStyle={styles.gridRow}
                onEndReached={loadMore}
                onEndReachedThreshold={0.5}
                ListFooterComponent={renderFooter}
                ListEmptyComponent={
                  <View style={styles.emptyContainer}>
                    <Feather name="image" size={48} color={COLORS.textSecondary} />
                    <Text style={styles.emptyText}>{t('nftMint.noPhotosFound')}</Text>
                  </View>
                }
              />
            )
          ) : (
            renderFormStep()
          )}
        </Animated.View>
        
        {/* Welcome popup for first-time users — absolute View avoids Android nav bar cutoff */}
        {showWelcome && (
          <View style={styles.welcomeOverlay}>
            <View style={styles.welcomeModal}>
              {/* Header */}
              <View style={styles.welcomeHeader}>
                <Text style={styles.welcomeTitle}>{t('nftWelcome.title')}</Text>
                <TouchableOpacity onPress={handleWelcomeDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Feather name="x" size={18} color="#52525b" />
                </TouchableOpacity>
              </View>
              <Text style={styles.welcomeSubtitle}>{t('nftWelcome.subtitle')}</Text>

              <ScrollView style={styles.welcomeScroll} showsVerticalScrollIndicator={false} bounces={false}>

              {/* Scenario label */}
              <Text style={styles.welcomeLabel}>{t('nftWelcome.scenarioLabel')}</Text>

              {/* Example 1: Public */}
              <View style={styles.welcomeExample}>
                <View style={styles.welcomeExHead}>
                  <View style={[styles.welcomeExTag, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
                    <Text style={[styles.welcomeExTagText, { color: '#4ade80' }]}>{t('nftWelcome.publicTag')}</Text>
                  </View>
                  <Text style={styles.welcomeExName}>{t('nftWelcome.publicName')}</Text>
                </View>
                <Text style={styles.welcomeExDesc}>{t('nftWelcome.publicDesc')}</Text>
                <View style={styles.welcomeChipRow}>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.publicChip1')}</Text></View>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.publicChip2')}</Text></View>
                  <View style={styles.welcomeChipAmber}><Text style={styles.welcomeChipAmberText}>{t('nftWelcome.publicChip3')}</Text></View>
                </View>
                <TouchableOpacity style={styles.welcomeDetailToggle} onPress={() => setExpandedDetail(expandedDetail === 'public' ? null : 'public')} activeOpacity={0.7}>
                  <Text style={styles.welcomeDetailToggleText}>{t('nftWelcome.details')}</Text>
                  <Feather name={expandedDetail === 'public' ? 'chevron-down' : 'chevron-right'} size={12} color="#52525b" />
                </TouchableOpacity>
                {expandedDetail === 'public' && (
                  <View style={styles.welcomeDetailBody}>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.publicPro1')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.publicPro2')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.publicPro3')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.publicPro4')}</Text>
                    <Text style={styles.welcomeConText}>– {t('nftWelcome.publicCon1')}</Text>
                    <Text style={styles.welcomeConText}>– {t('nftWelcome.publicCon2')}</Text>
                  </View>
                )}
              </View>

              {/* Example 2: Private */}
              <View style={styles.welcomeExample}>
                <View style={styles.welcomeExHead}>
                  <View style={[styles.welcomeExTag, { backgroundColor: 'rgba(99,102,241,0.15)' }]}>
                    <Text style={[styles.welcomeExTagText, { color: '#818cf8' }]}>{t('nftWelcome.privateTag')}</Text>
                  </View>
                  <Text style={styles.welcomeExName}>{t('nftWelcome.privateName')}</Text>
                </View>
                <Text style={styles.welcomeExDesc}>{t('nftWelcome.privateDesc')}</Text>
                <View style={styles.welcomeChipRow}>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.privateChip1')}</Text></View>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.privateChip2')}</Text></View>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.privateChip3')}</Text></View>
                </View>
                <TouchableOpacity style={styles.welcomeDetailToggle} onPress={() => setExpandedDetail(expandedDetail === 'private' ? null : 'private')} activeOpacity={0.7}>
                  <Text style={styles.welcomeDetailToggleText}>{t('nftWelcome.details')}</Text>
                  <Feather name={expandedDetail === 'private' ? 'chevron-down' : 'chevron-right'} size={12} color="#52525b" />
                </TouchableOpacity>
                {expandedDetail === 'private' && (
                  <View style={styles.welcomeDetailBody}>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.privatePro1')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.privatePro2')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.privatePro3')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.privatePro4')}</Text>
                    <Text style={styles.welcomeConText}>– {t('nftWelcome.privateCon1')}</Text>
                    <Text style={styles.welcomeConText}>– {t('nftWelcome.privateCon2')}</Text>
                  </View>
                )}
              </View>

              {/* Example 3: Certificate */}
              <View style={styles.welcomeExample}>
                <View style={styles.welcomeExHead}>
                  <View style={[styles.welcomeExTag, { backgroundColor: 'rgba(245,158,11,0.15)' }]}>
                    <Text style={[styles.welcomeExTagText, { color: '#fbbf24' }]}>{t('nftWelcome.certTag')}</Text>
                  </View>
                  <Text style={styles.welcomeExName}>{t('nftWelcome.certName')}</Text>
                </View>
                <Text style={styles.welcomeExDesc}>{t('nftWelcome.certDesc')}</Text>
                <View style={styles.welcomeChipRow}>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.certChip1')}</Text></View>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.certChip2')}</Text></View>
                  <View style={styles.welcomeChipGreen}><Text style={styles.welcomeChipGreenText}>{t('nftWelcome.certChip3')}</Text></View>
                </View>
                <TouchableOpacity style={styles.welcomeDetailToggle} onPress={() => setExpandedDetail(expandedDetail === 'cert' ? null : 'cert')} activeOpacity={0.7}>
                  <Text style={styles.welcomeDetailToggleText}>{t('nftWelcome.details')}</Text>
                  <Feather name={expandedDetail === 'cert' ? 'chevron-down' : 'chevron-right'} size={12} color="#52525b" />
                </TouchableOpacity>
                {expandedDetail === 'cert' && (
                  <View style={styles.welcomeDetailBody}>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.certPro1')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.certPro2')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.certPro3')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.certPro4')}</Text>
                    <Text style={styles.welcomeProText}>+ {t('nftWelcome.certPro5')}</Text>
                    <Text style={styles.welcomeConText}>– {t('nftWelcome.certCon1')}</Text>
                    <Text style={styles.welcomeConText}>– {t('nftWelcome.certCon2')}</Text>
                  </View>
                )}
              </View>

              {/* Key facts */}
              <Text style={styles.welcomeLabel}>{t('nftWelcome.keyFactsLabel')}</Text>

              <View style={styles.welcomeNote}>
                <Text style={styles.welcomeNoteText}><Text style={styles.welcomeNoteBold}>{t('nftWelcome.factImageTitle')}</Text> {t('nftWelcome.factImageDesc')}</Text>
              </View>
              <View style={[styles.welcomeNote, { marginTop: 4 }]}>
                <Text style={styles.welcomeNoteText}><Text style={styles.welcomeNoteBold}>{t('nftWelcome.factExifTitle')}</Text> {t('nftWelcome.factExifDesc')}</Text>
              </View>
              <View style={[styles.welcomeNote, { marginTop: 4 }]}>
                <Text style={styles.welcomeNoteText}><Text style={styles.welcomeNoteBold}>{t('nftWelcome.factEncryptionTitle')}</Text> {t('nftWelcome.factEncryptionDesc')}</Text>
              </View>
              <View style={[styles.welcomeNote, { marginTop: 4, marginBottom: 4 }]}>
                <Text style={styles.welcomeNoteText}><Text style={styles.welcomeNoteBold}>{t('nftWelcome.factPublicTitle')}</Text> {t('nftWelcome.factPublicDesc')}</Text>
              </View>

              </ScrollView>

              {/* Don't show again toggle */}
              <TouchableOpacity 
                style={styles.welcomeToggle}
                onPress={() => setDontShowWelcomeAgain(!dontShowWelcomeAgain)}
                activeOpacity={0.7}
              >
                <View style={[styles.welcomeCheckbox, dontShowWelcomeAgain && styles.welcomeCheckboxChecked]}>
                  {dontShowWelcomeAgain && <Feather name="check" size={12} color="#fff" />}
                </View>
                <Text style={styles.welcomeToggleText}>{t('nftWelcome.dontShowAgain')}</Text>
              </TouchableOpacity>
              
              {/* Got It button */}
              <TouchableOpacity
                style={styles.welcomeButton}
                onPress={handleWelcomeDismiss}
              >
                <Text style={styles.welcomeButtonText}>{t('nftWelcome.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    marginTop: Platform.OS === 'ios' ? 32 : 44,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: Platform.OS === 'ios' ? 0.18 : 0,
    shadowRadius: Platform.OS === 'ios' ? 14 : 0,
    elevation: Platform.OS === 'android' ? 0 : 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    paddingTop: 12,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
    marginHorizontal: 8,
  },
  stepIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  stepDotActive: {
    backgroundColor: '#0099FF',
    shadowColor: '#0099FF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: Platform.OS === 'ios' ? 0.35 : 0,
    shadowRadius: Platform.OS === 'ios' ? 3 : 0,
    elevation: Platform.OS === 'android' ? 0 : 3,
  },
  stepLine: {
    width: 32,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 4,
    borderRadius: 1,
  },
  stepLineActive: {
    backgroundColor: '#0099FF',
  },
  nextButton: {
    paddingHorizontal: 16,
    height: 40,
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: Platform.OS === 'ios' ? 0.16 : 0,
    shadowRadius: Platform.OS === 'ios' ? 10 : 0,
    elevation: Platform.OS === 'android' ? 0 : 6,
  },
  nextButtonDisabled: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  nextButtonText: {
    color: '#F4F4F8',
    fontWeight: '700',
  },
  nextButtonTextDisabled: {
    color: COLORS.textSecondary,
  },
  selectedPreview: {
    flexDirection: 'column',
    padding: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  selectedPreviewBox: {
    width: '100%',
    height: 170,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.18)',
    borderStyle: 'dashed',
    backgroundColor: 'rgba(255,255,255,0.03)',
    overflow: 'hidden',
  },
  selectedImage: {
    width: '100%',
    height: '100%',
  },
  selectedInfo: {
    flex: 1,
    marginTop: 10,
  },
  selectedFilename: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  selectedMeta: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  exifBadge: {
    fontSize: 10,
    color: COLORS.accent,
    fontWeight: '600',
  },
  selectedLocation: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  selectedCamera: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: COLORS.textSecondary,
  },
  gridContainer: {
    padding: 12,
    paddingBottom: 20,
  },
  gridRow: {
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  photoContainer: {
    width: LARGE_THUMBNAIL_SIZE,
    height: LARGE_THUMBNAIL_SIZE,
    marginBottom: 16,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  photoSelected: {
    borderWidth: 3,
    borderColor: COLORS.accent,
  },
  photoThumbnail: {
    width: '100%',
    height: '100%',
  },
  selectedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  photoInfo: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  photoDate: {
    fontSize: 11,
    color: '#F4F4F8',
  },
  loadingFooter: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyText: {
    marginTop: 12,
    color: COLORS.textSecondary,
    fontSize: 16,
  },
  
  // Mint confirmation modal - Compact design
  modalOverlay: {
    flex: 1,
    backgroundColor: '#030308',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    padding: 0,
    paddingTop: 44,
    paddingBottom: 0,
  },
  mintConfirmOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#030308',
    zIndex: 1000,
    elevation: 1000,
  },
  mintPanel: {
    flex: 1,
    backgroundColor: '#030308',
    width: '100%',
  },
  mintPanelScroll: {
    padding: 20,
    paddingHorizontal: 16,
    paddingBottom: 16,
    paddingTop: 10,
    flexGrow: 1,
    backgroundColor: '#030308',
  },
  mintPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  mintPanelHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mintPanelTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F4F4F8',
    letterSpacing: -0.2,
  },
  mintPanelCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(108,92,231,0.06)',
  },
  mintPromoBanner: {
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  mintPromoText: {
    color: '#F4F4F8',
    fontWeight: '700',
    fontSize: 13,
    textAlign: 'center',
  },
  mintSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#5C5C72',
    textTransform: 'uppercase',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  mintCardRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  mintCardRowStack: {
    flexDirection: 'column',
  },
  mintOptionCard: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    minHeight: 98,
    justifyContent: 'center',
  },
  mintOptionCardActive: {
    borderWidth: 2,
    borderColor: COLORS.primary,
    backgroundColor: 'rgba(153, 69, 255, 0.18)',
  },
  mintOptionCardActiveAlt: {
    borderWidth: 2,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  mintOptionCardDisabled: {
    opacity: 0.45,
  },
  mintOptionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
    textAlign: 'center',
  },
  mintOptionSubtitle: {
    marginTop: 6,
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  mintOptionPrice: {
    marginTop: 8,
    fontSize: 16,
    fontWeight: '900',
    color: COLORS.accent,
    textAlign: 'center',
  },
  // Grey card wrapper matching info/settings tab style
  mintCertSection: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 16,
    marginBottom: 14,
  },
  mintCertSectionDesc: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginBottom: 14,
  },
  mintCertCardDesc: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginBottom: 12,
  },
  mintCertCard: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  mintCertCardActive: {
    borderColor: 'rgba(0,153,255,0.55)',
    backgroundColor: 'rgba(0,153,255,0.12)',
    shadowColor: '#0099FF',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: Platform.OS === 'ios' ? 0.12 : 0,
    shadowRadius: Platform.OS === 'ios' ? 12 : 0,
    elevation: Platform.OS === 'android' ? 0 : 6,
  },
  mintCertCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  mintCertCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  mintCertIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  mintCertIconWrapActive: {
    backgroundColor: 'rgba(0,153,255,0.28)',
    borderColor: 'rgba(0,153,255,0.4)',
  },
  mintCertCardTextWrap: {
    flex: 1,
  },
  mintCertCardName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#9898B0',
  },
  mintCertSelectedBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0099FF',
  },
  mintCertChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chipGreen: {
    backgroundColor: 'rgba(34,197,94,0.1)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  chipGreenText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#4ade80',
  },
  chipAmber: {
    backgroundColor: 'rgba(245,158,11,0.1)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  chipAmberText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#fbbf24',
  },
  // Desktop-matching toggle rows (.nft-toggle-row)
  mintToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    marginBottom: 10,
  },
  mintToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    marginRight: 10,
  },
  mintToggleTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#9898B0',
  },
  mintToggleDesc: {
    fontSize: 11,
    color: '#5C5C72',
    marginTop: 1,
    lineHeight: 15,
  },
  // Desktop-matching cost display (.nft-cost-display)
  mintCostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    marginBottom: 12,
  },
  mintCostLabel: {
    fontSize: 12,
    color: '#5C5C72',
    fontWeight: '500',
  },
  mintCostValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#00FFA3',
  },
  // Desktop-matching full-width certify button (.nft-mint-btn)
  mintFullBtn: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  mintFullBtnGradient: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mintFullBtnText: {
    color: '#F4F4F8',
    fontSize: 13,
    fontWeight: '700',
  },
  // Keep old styles for hidden sections
  mintBreakdownBox: {
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  mintBreakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  mintBreakdownLabel: {
    fontSize: 13,
    color: COLORS.textSecondary,
  },
  mintBreakdownValue: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  mintSelectedPhotoRow: {
    flexDirection: 'column',
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    padding: 12,
    marginBottom: 12,
  },
  mintSelectedPhotoThumb: {
    width: '100%',
    height: 140,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.1)',
    borderStyle: 'dashed',
    backgroundColor: 'rgba(255,255,255,0.015)',
    overflow: 'hidden',
  },
  mintSelectedPhotoThumbImage: {
    width: '100%',
    height: '100%',
  },
  mintHeroCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 14,
    marginBottom: 14,
  },
  mintHeroMeta: {
    marginTop: 12,
  },
  mintHeroEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  mintHeroTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  mintHeroSub: {
    marginTop: 4,
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  mintSelectedPhotoMeta: {
    flex: 1,
    minWidth: 0,
    marginTop: 10,
  },
  mintSelectedPhotoName: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  mintSelectedPhotoSub: {
    marginTop: 4,
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  mintInput: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: '#F4F4F8',
    fontSize: 13,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 0,
  },
  mintFieldSection: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 16,
    marginBottom: 14,
  },
  mintFieldEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  mintFieldHelp: {
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textSecondary,
    marginBottom: 12,
  },
  mintOptionsSection: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 16,
    marginBottom: 14,
  },
  mintPaymentSection: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 16,
    marginBottom: 14,
  },
  mintPaymentHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  mintPaymentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,255,163,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.18)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    flexShrink: 0,
  },
  mintPaymentBadgeText: {
    color: COLORS.accent,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  mintPaymentCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.025)',
    padding: 12,
    marginBottom: 10,
  },
  mintPaymentCardActive: {
    borderColor: 'rgba(0,153,255,0.35)',
    backgroundColor: 'rgba(0,153,255,0.08)',
  },
  mintPaymentCardActiveSkr: {
    borderColor: 'rgba(0,255,163,0.26)',
    backgroundColor: 'rgba(0,255,163,0.08)',
  },
  mintPaymentCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  mintPaymentCardTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    flex: 1,
  },
  mintPaymentIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,153,255,0.10)',
  },
  mintPaymentIconWrapActive: {
    backgroundColor: 'rgba(0,153,255,0.95)',
  },
  mintPaymentIconWrapSkr: {
    backgroundColor: 'rgba(0,255,163,0.10)',
  },
  mintPaymentIconWrapSkrActive: {
    backgroundColor: 'rgba(0,255,163,0.95)',
  },
  mintPaymentCopyWrap: {
    flex: 1,
  },
  mintPaymentCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  mintPaymentCardTitleActive: {
    color: '#F4F4F8',
  },
  mintPaymentCardSubtitle: {
    fontSize: 11,
    lineHeight: 16,
    color: COLORS.textSecondary,
  },
  mintPaymentPromoPill: {
    backgroundColor: 'rgba(0,255,163,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.24)',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
  },
  mintPaymentPromoPillText: {
    color: COLORS.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  mintPaymentSelectedBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mintSummarySection: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 16,
    marginBottom: 12,
  },
  mintCostRowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.018)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    marginBottom: 10,
  },
  mintCostValueSecondary: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F4F4F8',
  },
  mintSummaryFinePrint: {
    fontSize: 11,
    lineHeight: 16,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  mintPrivacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 14,
  },
  mintPrivacyLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mintPrivacyText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '600',
  },
  mintInfoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(34, 197, 94, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.25)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 14,
  },
  mintInfoText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  mintLicenseList: {
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 14,
    marginTop: -4,
    overflow: 'hidden',
  },
  mintLicenseItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  mintLicenseItemActive: {
    backgroundColor: 'rgba(153, 69, 255, 0.15)',
  },
  mintLicenseItemText: {
    color: '#F4F4F8',
    fontSize: 12,
    fontWeight: '500',
  },
  mintActionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 2,
  },
  mintCancelBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mintCancelText: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 14,
  },
  mintCtaBtn: {
    flex: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  mintCtaBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  mintCtaText: {
    color: '#F4F4F8',
    fontWeight: '800',
    fontSize: 14,
  },
  compactModal: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 16,
    width: '100%',
    maxWidth: 340,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  compactHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  compactTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  compactCloseBtn: {
    padding: 4,
  },
  compactPreview: {
    width: '100%',
    height: 120,
    borderRadius: 10,
    marginBottom: 12,
  },
  compactInput: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    padding: 10,
    color: COLORS.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  compactRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  compactBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  compactBtnActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  compactBtnActiveAlt: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  compactBtnDisabled: {
    opacity: 0.4,
  },
  compactBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  compactBtnTextActive: {
    color: '#F4F4F8',
  },
  compactBtnTextDisabled: {
    color: COLORS.border,
  },
  compactBtnPrice: {
    fontSize: 10,
    color: COLORS.textSecondary,
  },
  compactBtnPriceActive: {
    color: 'rgba(255,255,255,0.8)',
  },
  compactPrivacy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  compactPrivacyLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  compactPrivacyText: {
    fontSize: 12,
    color: COLORS.text,
  },
  compactToggle: {
    width: 36,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.border,
    padding: 2,
    justifyContent: 'center',
  },
  compactToggleOn: {
    backgroundColor: COLORS.accent,
  },
  compactToggleKnob: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#F4F4F8',
  },
  compactToggleKnobOn: {
    alignSelf: 'flex-end',
  },
  compactCost: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  compactCostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  compactCostLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  compactCostValue: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.accent,
  },
  compactPromoBadge: {
    backgroundColor: 'rgba(0,255,163,0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  compactPromoText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#00FFA3',
  },
  compactSavings: {
    fontSize: 11,
    color: COLORS.accent,
    textAlign: 'center',
    marginTop: 6,
  },
  compactActions: {
    flexDirection: 'row',
    gap: 10,
  },
  compactCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
  },
  compactCancelText: {
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 14,
  },
  compactMintBtn: {
    flex: 1,
    flexDirection: 'row',
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  compactMintText: {
    color: '#F4F4F8',
    fontWeight: '700',
    fontSize: 14,
  },
  // Welcome popup styles — professional scenario-based design
  welcomeOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 20,
    zIndex: 999,
  },
  welcomeModal: {
    backgroundColor: '#0C0C12',
    borderRadius: 16,
    padding: 16,
    width: '100%',
    maxWidth: 380,
    maxHeight: SCREEN_HEIGHT - 60,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  welcomeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  welcomeTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F4F4F8',
  },
  welcomeSubtitle: {
    fontSize: 11,
    color: '#5C5C72',
    lineHeight: 15,
    marginBottom: 12,
  },
  welcomeScroll: {
    flexGrow: 0,
  },
  welcomeLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: '#5C5C72',
    letterSpacing: 0.6,
    marginTop: 12,
    marginBottom: 6,
  },
  welcomeExample: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  welcomeExHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 4,
  },
  welcomeExTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  welcomeExTagText: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  welcomeExName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9898B0',
  },
  welcomeExDesc: {
    fontSize: 10.5,
    color: '#8888A0',
    lineHeight: 15,
    marginBottom: 5,
  },
  welcomeChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  welcomeChipGreen: {
    backgroundColor: 'rgba(34,197,94,0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  welcomeChipGreenText: {
    fontSize: 9,
    color: '#4ade80',
  },
  welcomeChipAmber: {
    backgroundColor: 'rgba(245,158,11,0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  welcomeChipAmberText: {
    fontSize: 9,
    color: '#fbbf24',
  },
  welcomeDetailToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  welcomeDetailToggleText: {
    fontSize: 10,
    color: '#5C5C72',
  },
  welcomeDetailBody: {
    paddingTop: 5,
  },
  welcomeProText: {
    fontSize: 10,
    color: '#5C5C72',
    lineHeight: 14,
    marginBottom: 2,
  },
  welcomeConText: {
    fontSize: 10,
    color: '#5C5C72',
    lineHeight: 14,
    marginBottom: 2,
  },
  welcomeNote: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  welcomeNoteText: {
    fontSize: 10,
    color: '#5C5C72',
    lineHeight: 14,
  },
  welcomeNoteBold: {
    color: '#8888A0',
    fontWeight: '600',
  },
  welcomeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 10,
  },
  welcomeCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  welcomeCheckboxChecked: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  welcomeToggleText: {
    fontSize: 12,
    color: '#5C5C72',
  },
  welcomeButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  welcomeButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F4F4F8',
  },
});

export default NFTPhotoPicker;
