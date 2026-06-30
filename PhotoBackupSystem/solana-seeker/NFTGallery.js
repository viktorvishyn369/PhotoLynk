// NFT Album Component
// Premium gallery for viewing minted NFTs with 3D-style cards

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
  Modal,
  Linking,
  RefreshControl,
  Alert,
  Platform,
  TextInput,
  Animated,
  ScrollView,
  Share,
  BackHandler,
  StatusBar,
  AppState,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { SvgXml } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import NFTOperations, { decryptNFTImage, isPhotoLynkEcosystem, addToTransferredOutBlacklist, PHOTOLYNK_MERKLE_TREE } from './nftOperations';
import * as WalletAdapter from './WalletAdapter';
import { getStealthCloudMasterKey, getLegacyMasterKey } from './backgroundTask';
import { t, getCurrentLanguage } from './i18n';
import { GradientSpinner } from './uiComponents';
import { getAllPinataJwts } from './pinataAccounts';

// Import shared cache utilities (avoids circular dependency with nftOperations)
import NFTImageCache from './nftImageCache';

// Re-export for backwards compatibility
export const removeNFTImageFromCache = NFTImageCache.removeNFTImageFromCache;

// Local wrapper to provide Map-like interface for existing code
const imageCache = {
  has: (cid) => NFTImageCache.hasCachedPath(cid),
  get: (cid) => NFTImageCache.getCachedPath(cid),
  set: (cid, path) => NFTImageCache.setCachedPath(cid, path),
};
const saveCacheIndex = () => NFTImageCache.saveCacheIndex();
const IMAGE_CACHE_DIR = `${FileSystem.cacheDirectory}nft_images/`;
const NFT_LIVE_REFRESH_MS = 10000;

const normalizeMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';

const getNFTDateValue = (nft) => {
  const timestamps = [
    nft?.createdAt,
    nft?.mintedAt,
    nft?.transferredAt,
    nft?.discoveredAt,
    nft?.metadata?.properties?.certificate?.mintedAt,
  ]
    .filter(Boolean)
    .map(value => new Date(value).getTime())
    .filter(ts => Number.isFinite(ts) && ts > 0);
  return timestamps.length ? Math.max(...timestamps) : 0;
};

const normalizeBadgeValue = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
};

// STRICT ecosystem check used by Public/Private album tabs.
// PhotoLynk only mints compressed NFTs to a single shared Merkle tree, so the
// authoritative signal is `merkleTree === PHOTOLYNK_MERKLE_TREE`. This is true
// regardless of which app did the mint (solana-seeker, mobile-v2, server-tray)
// because all of them mint to the same tree. The fallbacks below cover legacy
// stored objects where `merkleTree` wasn't propagated locally — they require
// PhotoLynk-specific metadata signatures that foreign NFTs do not have.
const isStrictPhotoLynkMinted = (nft) => {
  if (!nft) return false;
  if (nft.merkleTree && nft.merkleTree === PHOTOLYNK_MERKLE_TREE) return true;
  // Legacy backstop 1: PhotoLynk certificate signature in metadata
  const certType = nft?.metadata?.properties?.certificate?.type;
  if (certType && String(certType).toLowerCase().includes('photolynk')) return true;
  // Legacy backstop 2: BOTH proof hashes (Content + EXIF) — unique to PhotoLynk mints
  const attrs = nft?.metadata?.attributes || nft?.attributes || [];
  const hasContentHash = !!nft?.contentHash || attrs.some(a => a?.trait_type === 'Content Hash');
  const hasExifHash = !!nft?.exifHash || attrs.some(a => a?.trait_type === 'EXIF Hash');
  if (hasContentHash && hasExifHash) return true;
  return false;
};

// Public/Private tabs are STRICT — only NFTs with an explicit `certificationMode`
// badge ('public' or 'private') belong there. Unmarked PhotoLynk NFTs (e.g.
// older mints without the badge) are visible only on the All tab. This matches
// the on-screen badge model: if a card doesn't show a green "Public" or amber
// "Private" badge, it should not appear in those tabs.
const isPrivateNFTTabMatch = (nft) => {
  return normalizeBadgeValue(nft?.certificationMode) === 'private';
};

const isPublicNFTTabMatch = (nft) => {
  return normalizeBadgeValue(nft?.certificationMode) === 'public';
};

// True if the NFT is encrypted according to ANY available signal:
// - top-level `encrypted: true` flag (modern objects)
// - off-chain metadata attribute  Encrypted == "true"
// - properties.encryption.encrypted === true
// - presence of encryptionData (wrappedKey / nonce / transferNftKey)
// Public-tab NFTs are never displayed encrypted (they're public by definition).
const isNFTEncrypted = (nft) => {
  if (!nft) return false;
  if (nft.encrypted === true) return true;
  const attrs = nft?.metadata?.attributes || nft?.attributes || [];
  const encAttr = attrs.find(a => a?.trait_type === 'Encrypted');
  if (encAttr && String(encAttr.value).toLowerCase() === 'true') return true;
  if (nft?.metadata?.properties?.encryption?.encrypted === true) return true;
  const enc = nft?.encryptionData;
  if (enc && (enc.wrappedKey || enc.nonce || enc.transferNftKey)) return true;
  return false;
};

const shouldDisplayEncrypted = (nft) => {
  if (!nft) return false;
  if (isPublicNFTTabMatch(nft)) return false;
  return isNFTEncrypted(nft);
};

// Kept for backwards compatibility (still referenced by certified-count effect).
// Now strictly aliases the strict ecosystem check.
const isPhotoLynkCertifiedNFT = (nft) => isStrictPhotoLynkMinted(nft);

// Selection / batch-burn eligibility. Looser than `isPhotoLynkEcosystem` to
// also accept legacy PhotoLynk mints whose locally cached object lacks
// merkleTree / creatorWallet / mintPlatform but still carries the PhotoLynk-
// only `certificationMode` attribute (set only by this app at mint time).
const isBurnSelectable = (nft) => {
  if (!nft) return false;
  if (isPhotoLynkEcosystem(nft)) return true;
  const mode = normalizeBadgeValue(nft.certificationMode);
  if (mode === 'private' || mode === 'public') return true;
  return false;
};

// Initialize cache on module load
NFTImageCache.loadCacheIndex();

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
// Grid: container has 12px horizontal padding; each grid item has 6px horizontal padding
const GRID_HORIZONTAL_PADDING = 12;
const GRID_ITEM_PADDING = 6; // each side inside gridItem
const GRID_COLUMNS = 2;
const CARD_WIDTH = ((SCREEN_WIDTH - GRID_HORIZONTAL_PADDING * 2) / GRID_COLUMNS) - (GRID_ITEM_PADDING * 2);
const CARD_HEIGHT = CARD_WIDTH * 1.45; // portrait-ish aspect to avoid horizontal stretching
const SCREEN_HEIGHT_FULL = Dimensions.get('screen').height;
const ANDROID_NAV_BAR_HEIGHT = Platform.OS === 'android' ? Math.max(48, SCREEN_HEIGHT_FULL - SCREEN_HEIGHT) : 0;

// ============================================================================
// COLORS
// ============================================================================

const COLORS = {
  background: '#030308',
  surface: '#0A0A14',
  surfaceLight: '#12121E',
  primary: '#3B82F6',
  secondary: '#60A5FA',
  accent: '#00FFA3',
  text: '#EEEEF6',
  textSecondary: '#7676A0',
  border: 'rgba(167,139,250,0.12)',
  error: '#FF4466',
  warning: '#F5C842',
  solana: '#3B82F6',
};

// IPFS Gateway configuration with fallbacks
// Ordered by reliability: primary gateway first, fallbacks after
const IPFS_GATEWAYS = [
  'https://dweb.link/ipfs/',         // Protocol Labs CDN - most reliable
  'https://w3s.link/ipfs/',          // Web3.Storage - good for cNFTs
  'https://nftstorage.link/ipfs/',   // NFT.Storage - designed for NFTs
  'https://cloudflare-ipfs.com/ipfs/', // Cloudflare - fast CDN
];

// Extract CID from any IPFS URL (supports /ipfs/CID, ipfs://CID, and ipfs://ipfs/CID)
const extractIPFSCid = (url) => {
  if (!url) return null;
  // Match ipfs://CID or ipfs://ipfs/CID (raw IPFS scheme used by old standard NFTs)
  const ipfsScheme = url.match(/^ipfs:\/\/(?:ipfs\/)?([a-zA-Z0-9]+)/);
  if (ipfsScheme) return ipfsScheme[1];
  // Match /ipfs/CID pattern (gateway URLs)
  const match = url.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
};

// Get fast image URL - rewrites Pinata to faster gateway
const getFastImageUrl = (url, gatewayIndex = 0) => {
  if (!url) return url;

  // Don't rewrite StealthCloud or Arweave URLs
  if (url.includes('stealthlynk.io') || url.includes('arweave.net') || url.includes('irys.xyz')) {
    return url;
  }

  const cid = extractIPFSCid(url);
  if (cid && gatewayIndex < IPFS_GATEWAYS.length) {
    return `${IPFS_GATEWAYS[gatewayIndex]}${cid}`;
  }
  return url;
};

// NFT Image component with StealthCloud priority, retries, then fallback to original IPFS
const MAX_STEALTHCLOUD_RETRIES = 2;
const MAX_IPFS_RETRY_CYCLES = 1; // Single cycle - if all 4 gateways fail, content is likely unpinned

// Check if URL is StealthCloud
const isStealthCloudUrl = (url) => {
  if (!url) return false;
  return url.includes('stealthlynk.io') || url.includes('nft.stealthlynk.io');
};

const NFTImageWithFallback = ({ url, originalUrl, style, isDetail = false }) => {
  // ALL hooks must be declared before any early returns (React rules of hooks)
  const [currentSource, setCurrentSource] = useState('primary');
  const [retryCount, setRetryCount] = useState(0);
  const [gatewayIndex, setGatewayIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [memoryRetries, setMemoryRetries] = useState(0);
  const [cachedPath, setCachedPath] = useState(null);
  const [effectiveUrl, setEffectiveUrl] = useState(url);
  const [imageAspectRatio, setImageAspectRatio] = useState(4 / 3);
  const imageRef = React.useRef(null);
  const retryTimerRef = React.useRef(null);

  // SVG data URI: decode and render with SvgXml (after hooks)
  const isSvgDataUri = url && url.startsWith('data:image/svg+xml');
  if (isSvgDataUri) {
    try {
      const base64Part = url.split(',')[1] || '';
      const svgString = decodeURIComponent(escape(atob(base64Part)));
      return (
        <View
          pointerEvents="none"
          style={[style, { justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.surface, overflow: 'hidden' }]}
        >
          <SvgXml xml={svgString} width="100%" height="100%" pointerEvents="none" />
        </View>
      );
    } catch (e) {
      console.warn('[NFTImage] SVG decode error:', e.message);
      return (
        <View style={[style, { justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.surface }]}>
          <Feather name="code" size={24} color={COLORS.textSecondary} />
        </View>
      );
    }
  }

  // Check for cached image on mount and validate URL
  React.useEffect(() => {
    const checkCacheAndUrl = async () => {
      // If URL is a local file path, check if it exists
      if (url && (url.startsWith('file://') || url.startsWith('/'))) {
        try {
          const info = await FileSystem.getInfoAsync(url.replace('file://', ''));
          if (!info.exists && originalUrl) {
            // Local file doesn't exist, use originalUrl (StealthCloud/IPFS)
            console.log('[NFTImage] Local file missing, using originalUrl');
            setEffectiveUrl(originalUrl);
            return;
          }
        } catch (e) {
          if (originalUrl) {
            setEffectiveUrl(originalUrl);
            return;
          }
        }
      }
      setEffectiveUrl(url);

      // Check IPFS cache
      const cid = extractIPFSCid(url) || extractIPFSCid(originalUrl);
      if (cid) {
        // Check in-memory cache first
        if (imageCache.has(cid)) {
          setCachedPath(imageCache.get(cid));
          return;
        }
        // Check disk cache
        try {
          const localPath = `${IMAGE_CACHE_DIR}${cid}.jpg`;
          const info = await FileSystem.getInfoAsync(localPath);
          if (info.exists) {
            imageCache.set(cid, localPath);
            setCachedPath(localPath);
          }
        } catch (e) {
          // Cache check failed, will load from network
        }
      }
    };
    checkCacheAndUrl();
  }, [url, originalUrl]);

  // Early return if no URL provided - show placeholder
  if (!url && !originalUrl) {
    return (
      <View style={[style, { justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.surface }]}>
        <Feather name="image" size={24} color={COLORS.textSecondary} />
      </View>
    );
  }

  const isStealthCloud = isStealthCloudUrl(effectiveUrl);
  const fallbackUrl = originalUrl || effectiveUrl;
  const cid = extractIPFSCid(currentSource === 'fallback' ? fallbackUrl : effectiveUrl);
  const isIPFS = !!cid;

  // Determine which URL to use
  const getImageUrl = () => {
    if (currentSource === 'primary') {
      // Primary: use the effective URL (validated/corrected)
      // If it's an IPFS URL, use gateway rotation
      const cidFromUrl = extractIPFSCid(effectiveUrl);
      if (cidFromUrl) {
        const gatewayUrl = getFastImageUrl(effectiveUrl, gatewayIndex);
        return retryCount > 0 ? `${gatewayUrl}${gatewayUrl.includes('?') ? '&' : '?'}r=${retryCount}` : gatewayUrl;
      }
      // StealthCloud or local path - use directly
      const baseUrl = effectiveUrl;
      return retryCount > 0 ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}r=${retryCount}` : baseUrl;
    } else {
      // Fallback: use original IPFS URL with gateway
      const cidFromFallback = extractIPFSCid(fallbackUrl);
      if (cidFromFallback) {
        const gatewayUrl = getFastImageUrl(fallbackUrl, gatewayIndex);
        return retryCount > 0 ? `${gatewayUrl}${gatewayUrl.includes('?') ? '&' : '?'}r=${retryCount}` : gatewayUrl;
      }
      return fallbackUrl;
    }
  };

  const finalUrl = getImageUrl();

  const handleError = (e) => {
    const errorMsg = e?.nativeEvent?.error || 'unknown';

    // Check for memory errors - wait and retry instead of failing immediately
    if (errorMsg.includes('Pool hard cap') || errorMsg.includes('memory')) {
      if (memoryRetries < 5) {
        console.log('[NFTImage] Memory full, waiting to retry...', memoryRetries + 1);
        setMemoryRetries(prev => prev + 1);
        // Wait 5 seconds for memory to free up, then retry
        retryTimerRef.current = setTimeout(() => {
          setRetryCount(prev => prev + 1);
        }, 5000);
        return;
      } else {
        console.log('[NFTImage] Memory exhausted after retries');
        setFailed(true);
        setLoading(false);
        return;
      }
    }

    if (currentSource === 'primary') {
      // Primary source (StealthCloud or direct URL)
      if (isStealthCloud) {
        if (retryCount < MAX_STEALTHCLOUD_RETRIES - 1) {
          // Retry StealthCloud up to 3 times
          console.log('[NFTImage] StealthCloud retry', retryCount + 1);
          setRetryCount(prev => prev + 1);
        } else if (fallbackUrl && fallbackUrl !== url && (extractIPFSCid(fallbackUrl) || fallbackUrl.startsWith('data:'))) {
          // StealthCloud failed, try IPFS or data: URI fallback
          console.log('[NFTImage] StealthCloud failed, trying fallback:', fallbackUrl.substring(0, 60));
          setCurrentSource('fallback');
          setRetryCount(0);
          setGatewayIndex(0);
        } else {
          // No fallback, fail
          console.log('[NFTImage] StealthCloud failed, no fallback');
          setFailed(true);
          setLoading(false);
        }
      } else if (isIPFS || extractIPFSCid(url)) {
        // IPFS URL - try different gateways with delay
        if (gatewayIndex === 0 && retryCount === 0) console.log('[NFTImage] IPFS retrying gateways for', extractIPFSCid(url) || 'unknown');
        // Wait 10 seconds before trying next gateway (large files need time)
        retryTimerRef.current = setTimeout(() => {
          if (gatewayIndex < IPFS_GATEWAYS.length - 1) {
            setGatewayIndex(prev => prev + 1);
          } else if (retryCount < MAX_IPFS_RETRY_CYCLES) {
            setGatewayIndex(0);
            setRetryCount(prev => prev + 1);
          } else {
            console.log('[NFTImage] All IPFS gateways failed for', extractIPFSCid(url) || 'unknown');
            setFailed(true);
            setLoading(false);
          }
        }, 10000); // 10 second delay between gateway attempts
      } else if (fallbackUrl && fallbackUrl !== url && extractIPFSCid(fallbackUrl)) {
        // Switch to fallback (original IPFS) only if it has a valid CID
        console.log('[NFTImage] Switching to fallback IPFS');
        setCurrentSource('fallback');
        setRetryCount(0);
        setGatewayIndex(0);
      } else {
        // No fallback available
        setFailed(true);
        setLoading(false);
      }
    } else {
      // Fallback source (IPFS gateways)
      const cidFromFallback = extractIPFSCid(fallbackUrl);
      if (cidFromFallback && gatewayIndex < IPFS_GATEWAYS.length - 1) {
        setGatewayIndex(prev => prev + 1);
      } else if (cidFromFallback && retryCount < MAX_IPFS_RETRY_CYCLES) {
        // Start new gateway cycle
        setGatewayIndex(0);
        setRetryCount(prev => prev + 1);
      } else {
        // All fallbacks exhausted
        console.log('[NFTImage] All sources failed');
        setFailed(true);
        setLoading(false);
      }
    }
  };

  // Reset state when URL changes
  React.useEffect(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
    }
    setCurrentSource('primary');
    setRetryCount(0);
    setGatewayIndex(0);
    setLoading(true);
    setFailed(false);
    setMemoryRetries(0);
  }, [url]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
      imageRef.current = null;
    };
  }, []);

  if (failed) {
    return (
      <View style={[style, { justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.surface }]}>
        <Feather name="image" size={24} color={COLORS.textSecondary} />
      </View>
    );
  }

  // Save image to cache after successful load
  const handleLoadSuccess = async (event) => {
    setLoading(false);

    // Get image dimensions for proper aspect ratio in detail view
    if (isDetail && event?.nativeEvent?.source) {
      const { width, height } = event.nativeEvent.source;
      if (width && height && height > 0) {
        setImageAspectRatio(width / height);
      }
    }

    // Cache IPFS images to disk for persistence
    const cid = extractIPFSCid(finalUrl);
    if (cid && !cachedPath && !imageCache.has(cid)) {
      try {
        // Ensure cache directory exists
        await FileSystem.makeDirectoryAsync(IMAGE_CACHE_DIR, { intermediates: true }).catch(() => { });

        // Download and save to cache
        const localPath = `${IMAGE_CACHE_DIR}${cid}.jpg`;
        await FileSystem.downloadAsync(finalUrl, localPath);
        imageCache.set(cid, localPath);
        // Persist cache index to survive app restarts
        saveCacheIndex();
        console.log('[NFTImage] Cached:', cid);
      } catch (e) {
        // Cache save failed, not critical
      }
    }
  };

  // Use cached path if available
  const displayUrl = cachedPath || finalUrl;

  // For detail view, use dynamic aspect ratio to preserve original dimensions
  const imageStyle = isDetail
    ? [style, { aspectRatio: imageAspectRatio }]
    : style;

  return (
    <View style={isDetail ? { width: '100%', alignItems: 'center' } : style}>
      {loading && (
        <View style={[style, { position: 'absolute', justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.surface, zIndex: 1 }]}>
          <ActivityIndicator size={isDetail ? 'large' : 'small'} color={COLORS.primary} />
        </View>
      )}
      <Image
        ref={imageRef}
        source={{ uri: displayUrl, cache: 'force-cache' }}
        style={imageStyle}
        resizeMode={isDetail ? 'contain' : 'cover'}
        onLoadStart={() => setLoading(true)}
        onLoad={handleLoadSuccess}
        onError={handleError}
      />
    </View>
  );
};

// ============================================================================
// DECRYPTED NFT IMAGE - downloads encrypted blob, decrypts, shows result
// ============================================================================

const DECRYPT_CACHE_DIR = `${FileSystem.cacheDirectory}nft_decrypted/`;

// Track NFTs that failed decryption with retry count — allows 3 attempts before permanent blacklist
// Transient errors (download, no keys) are tracked separately and retried on each mount
const _failedDecryptRetries = new Map(); // mintId -> { count, permanent }
const MAX_DECRYPT_RETRIES = 3;

// Global decryption queue — serialize all decryptions to prevent concurrent memory spikes
// (each decryption holds ~4MB peak; 3 concurrent = 12MB+ → OOM on Android)
let _decryptQueue = Promise.resolve();
const enqueueDecrypt = (fn) => {
  _decryptQueue = _decryptQueue.then(fn, fn);
  return _decryptQueue;
};

const DecryptedNFTImage = ({ nft, style, isDetail = false, getAuthHeaders = null, serverUrl = null }) => {
  const [decryptedUri, setDecryptedUri] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const doDecrypt = async () => {
      try {
        setLoading(true);
        setError(null);

        let enc = nft.encryptionData;
        const nftId = nft.mintAddress || nft.assetId || '';
        // Look up local cert for transferNftKey if encryptionData is incomplete
        if (nft.encrypted && !enc?.transferNftKey) {
          try {
            const certs = await NFTOperations.getStoredCertificates();
            const targetMint = normalizeMint(nftId);
            const cert = certs.find(c => normalizeMint(c.mintAddress) === targetMint);
            if (cert?.transferNftKey) {
              enc = { ...(enc || {}), transferNftKey: cert.transferNftKey, nonce: cert.transferNonce || enc?.nonce, thumbnailNonce: cert.transferThumbnailNonce || enc?.thumbnailNonce };
              console.log('[Decrypt] Found transferNftKey from local cert for', nft.name || nftId);
            }
          } catch (_) { }
        }
        // If still no transferNftKey, try fetching from server wallet transfer endpoint
        if (nft.encrypted && !enc?.transferNftKey && serverUrl && nft.ownerAddress) {
          try {
            const ac = new AbortController(); const tid = setTimeout(() => ac.abort(), 8000);
            const resp = await fetch(`${serverUrl}/api/nft/certificates/wallet/${nft.ownerAddress}`, { signal: ac.signal });
            clearTimeout(tid);
            if (resp.ok) {
              const data = await resp.json();
              const targetMint = normalizeMint(nftId);
              const remoteCert = (data.certificates || []).find(c => normalizeMint(c.mintAddress) === targetMint);
              if (remoteCert?.transferNftKey) {
                enc = { ...(enc || {}), transferNftKey: remoteCert.transferNftKey, nonce: remoteCert.transferNonce || enc?.nonce, thumbnailNonce: remoteCert.transferThumbnailNonce || enc?.thumbnailNonce };
                console.log('[Decrypt] Found transferNftKey from server for', nft.name || nftId);
                // Save to local certs so future decrypts don't need server round-trip
                try {
                  const localCerts = await NFTOperations.getStoredCertificates();
                  const existIdx = localCerts.findIndex(c => normalizeMint(c.mintAddress) === targetMint);
                  if (existIdx >= 0) Object.assign(localCerts[existIdx], { transferNftKey: remoteCert.transferNftKey, transferNonce: remoteCert.transferNonce, transferThumbnailNonce: remoteCert.transferThumbnailNonce });
                  else localCerts.push(remoteCert);
                  await NFTOperations.saveAllCertificates(localCerts);
                } catch (_) { }
              }
            }
          } catch (_) { }
        }
        const hasKeys = (enc?.wrappedKey && enc?.wrapNonce && enc?.nonce) || (enc?.transferNftKey && (enc?.nonce || enc?.thumbnailNonce));
        if (!hasKeys) {
          console.log(`[Decrypt] ${nft.name || nftId} — no keys, encData=${JSON.stringify(enc)}`);
          setError('No decryption keys');
          setLoading(false);
          return;
        }

        // Skip if permanently failed after MAX_DECRYPT_RETRIES attempts
        const retryInfo = _failedDecryptRetries.get(nftId);
        if (retryInfo?.permanent) {
          setError('Decryption unavailable');
          setLoading(false);
          return;
        }

        // Check decrypted cache first
        const cacheKey = nftId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const cachedDecPath = `${DECRYPT_CACHE_DIR}${cacheKey}.jpg`;
        try {
          const info = await FileSystem.getInfoAsync(cachedDecPath);
          if (info.exists && info.size > 100) {
            if (!cancelled) { setDecryptedUri(cachedDecPath); setLoading(false); }
            return;
          }
        } catch (_) { }

        // Get master key + legacy fallback for pre-migration encrypted NFTs
        const masterKey = await getStealthCloudMasterKey();
        if (!masterKey && !enc.transferNftKey) { setError('No master key'); setLoading(false); return; }
        const legacyKey = await getLegacyMasterKey();

        // Download encrypted blob — prefer encrypted thumbnail (small) over full image (multi-MB)
        const encryptedThumbUrl = nft.thumbnailUrl || nft.ipfsThumbnailUrl || enc.thumbnailUrl || '';
        const useThumb = !!(encryptedThumbUrl && enc.thumbnailNonce);
        const imageUrl = useThumb ? encryptedThumbUrl : (nft.imageUrl || nft.arweaveUrl || nft.image || '');
        const decryptNonce = useThumb ? enc.thumbnailNonce : enc.nonce;
        if (!imageUrl) { setError('No image URL'); setLoading(false); return; }

        // Build download options — add auth headers for StealthCloud URLs
        const dlOptions = {};
        const isStealthCloud = imageUrl.includes('stealthlynk.io') || imageUrl.includes('stealthcloud');
        if (isStealthCloud && getAuthHeaders) {
          try {
            const authConfig = await getAuthHeaders();
            const hdrs = authConfig?.headers || authConfig;
            if (hdrs) dlOptions.headers = hdrs;
          } catch (_) { }
        }

        // Enqueue download+decrypt (serialized — only one at a time to prevent OOM)
        const decResult = await enqueueDecrypt(async () => {
          if (cancelled) return { cancelled: true };
          console.log(`[Decrypt] ${nft.name || nft.mintAddress} — ${useThumb ? 'encrypted thumbnail' : 'full image'}: ${imageUrl.slice(0, 60)}`);

          const cid = extractIPFSCid(imageUrl);
          const downloadUrls = cid ? IPFS_GATEWAYS.map(g => `${g}${cid}`) : [imageUrl];
          const tmpPath = `${FileSystem.cacheDirectory}nft_enc_dl_${Date.now()}.bin`;
          const MAX_DECRYPT_SIZE = 5 * 1024 * 1024; // 5MB

          // Pre-flight size check (HEAD)
          try {
            const headCtrl = new AbortController();
            const headTimeout = setTimeout(() => headCtrl.abort(), 5000);
            const headResp = await fetch(downloadUrls[0], { method: 'HEAD', headers: dlOptions.headers, signal: headCtrl.signal });
            clearTimeout(headTimeout);
            const cl = parseInt(headResp.headers.get('content-length') || '0', 10);
            if (cl > MAX_DECRYPT_SIZE) {
              console.log(`[Decrypt] ${nft.name || nft.mintAddress} — HEAD says ${Math.round(cl / 1024)}KB, too large`);
              return { error: 'Too large' };
            }
          } catch (_) { }

          const sleep = (ms) => new Promise(res => setTimeout(res, ms));
          let downloaded = false;
          for (let attempt = 0; attempt < 3 && !downloaded; attempt++) {
            for (let i = 0; i < downloadUrls.length && !downloaded; i++) {
              try {
                const r = await FileSystem.downloadAsync(downloadUrls[i], tmpPath, dlOptions);
                if (r && r.status === 200) { downloaded = true; break; }
              } catch (_) { }
            }
            if (!downloaded) await sleep(500 * (attempt + 1));
          }

          if (!downloaded) {
            console.log(`[Decrypt] ${nft.name || nft.mintAddress} — download failed`);
            return { error: 'Download failed' };
          }

          // Post-download size guard
          try {
            const dlInfo = await FileSystem.getInfoAsync(tmpPath, { size: true });
            if (dlInfo.exists && dlInfo.size > MAX_DECRYPT_SIZE) {
              console.log(`[Decrypt] ${nft.name || nft.mintAddress} — file too large (${Math.round(dlInfo.size / 1024)}KB)`);
              FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => { });
              return { error: 'Too large' };
            }
          } catch (_) { }

          if (cancelled) { FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => { }); return { cancelled: true }; }

          const result = await decryptNFTImage(tmpPath, enc.wrappedKey, enc.wrapNonce, decryptNonce, masterKey, legacyKey, enc.transferNftKey || null);
          console.log(`[Decrypt] ${nft.name || nft.mintAddress} — result=${result.success} ${result.error || ''}`);
          FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => { });
          return result;
        });

        if (cancelled || decResult?.cancelled) return;

        if (decResult?.error) {
          const prev = _failedDecryptRetries.get(nftId) || { count: 0, permanent: false };
          const isTransient = decResult.error === 'Download failed';
          prev.count++;
          prev.permanent = !isTransient && prev.count >= MAX_DECRYPT_RETRIES;
          _failedDecryptRetries.set(nftId, prev);
          setError(decResult.error); setLoading(false); return;
        }

        if (decResult?.success && decResult.decryptedPath) {
          // Copy to persistent cache
          _failedDecryptRetries.delete(nftId); // Clear any previous failures
          await FileSystem.makeDirectoryAsync(DECRYPT_CACHE_DIR, { intermediates: true }).catch(() => { });
          await FileSystem.copyAsync({ from: decResult.decryptedPath, to: cachedDecPath }).catch(() => { });
          setDecryptedUri(decResult.decryptedPath);
        } else {
          const prev = _failedDecryptRetries.get(nftId) || { count: 0, permanent: false };
          prev.count++;
          prev.permanent = prev.count >= MAX_DECRYPT_RETRIES;
          _failedDecryptRetries.set(nftId, prev);
          setError(decResult?.error || 'Decryption failed');
        }
      } catch (e) {
        if (!cancelled) {
          const prev = _failedDecryptRetries.get(nftId) || { count: 0, permanent: false };
          prev.count++;
          prev.permanent = prev.count >= MAX_DECRYPT_RETRIES;
          _failedDecryptRetries.set(nftId, prev);
          setError(e.message || 'Decryption error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    doDecrypt();
    return () => { cancelled = true; };
  }, [nft.mintAddress, nft.assetId]);

  if (loading) {
    return (
      <View style={[style, { justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.surface }]}>
        <ActivityIndicator size={isDetail ? 'large' : 'small'} color={COLORS.primary} />
        <Text style={{ fontSize: 8, color: COLORS.primary, marginTop: 4 }}>{t('nftAlbum.decrypting')}</Text>
      </View>
    );
  }

  if (error || !decryptedUri) {
    return (
      <View style={[style, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(245, 158, 11, 0.06)' }]}>
        <Feather name="lock" size={isDetail ? 48 : 24} color="#f59e0b" />
        <Text style={{ fontSize: isDetail ? 14 : 8, color: '#f59e0b', fontWeight: '600', marginTop: 4, textAlign: 'center' }}>{t('nftAlbum.encryptedCertified')}</Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri: decryptedUri }}
      style={style}
      resizeMode={isDetail ? 'contain' : 'cover'}
    />
  );
};

// ============================================================================
// NFT GALLERY COMPONENT
// ============================================================================

// Sort options - labels will be translated at render time
const SORT_OPTIONS = [
  { key: 'date_desc', labelKey: 'nftAlbum.newestFirst', icon: 'arrow-down' },
  { key: 'date_asc', labelKey: 'nftAlbum.oldestFirst', icon: 'arrow-up' },
  { key: 'name_asc', labelKey: 'nftAlbum.nameAZ', icon: 'type' },
  { key: 'name_desc', labelKey: 'nftAlbum.nameZA', icon: 'type' },
];

const ITEMS_PER_PAGE = 4;  // 2x2 grid - show 4 cards per page
const NFT_PASSIVE_REFRESH_MS = 300000;
const SLIM_NFT_FIELDS = [
  'mintAddress', 'assetId', 'name', 'description', 'imageUrl', 'thumbnailUrl',
  'ipfsThumbnailUrl', 'arweaveUrl', 'metadataUrl', 'ownerAddress', 'creatorWallet',
  'createdAt', 'mintedAt', 'transferredAt', 'discoveredAt', 'storageType', 'merkleTree', 'mintPlatform',
  'certificationMode', 'edition', 'encrypted', 'watermarked', 'license',
  'network', 'isCompressed', 'nftType', 'txSignature', 'contentHash',
  'exifHash', 'hasRfc3161', 'hasC2pa',
];
const slimNFTForState = (nft) => {
  const slim = {};
  for (const field of SLIM_NFT_FIELDS) {
    if (nft?.[field] !== undefined) slim[field] = nft[field];
  }
  if (nft?.encryptionData) {
    const enc = {};
    for (const key of ['wrappedKey', 'wrapNonce', 'nonce', 'thumbnailNonce', 'thumbnailUrl', 'transferNftKey']) {
      if (nft.encryptionData[key] !== undefined) enc[key] = nft.encryptionData[key];
    }
    if (Object.keys(enc).length > 0) slim.encryptionData = enc;
  }
  return slim;
};
const slimNFTListForState = (items) => Array.isArray(items) ? items.map(slimNFTForState) : [];

const NFTGallery = ({
  visible,
  onClose,
  onTransferNFT,
  serverUrl,
  getAuthHeaders,
  refreshKey,
  onShowCertificate,
  pendingSelectMint,
  onPendingSelectConsumed,
  onNftCountChange,
  onCertifiedCountChange,
}) => {
  const insets = useSafeAreaInsets();
  const bottomInset = Platform.OS === 'android' ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT) : insets.bottom;
  const topInset = Platform.OS === 'ios' ? insets.top + 12 : 12;
  const [nfts, setNfts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedNFT, setSelectedNFT] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState(null);
  const [burning, setBurning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null); // { current, total } or null
  const [stopAfterCurrentRequested, setStopAfterCurrentRequested] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [burnWaitSeconds, setBurnWaitSeconds] = useState(30);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const cancelBurnRef = useRef(false);
  const burnTimerRef = useRef(null);
  const burnPhaseRef = useRef('preparing');
  const ignoreNextCardPressRef = useRef(false);
  const [certifiedMints, setCertifiedMints] = useState(new Set());

  // New state for Album features
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [currentPage, setCurrentPage] = useState(0); // Page-based pagination
  const [nftFilter, setNftFilter] = useState('all'); // 'all', 'private', 'public'

  // Auto-exit selection mode when switching to the All tab — burn selection is restricted to Public/Private.
  useEffect(() => {
    if (nftFilter === 'all' && selectionMode) {
      setSelectionMode(false);
      setSelectedIds(new Set());
    }
  }, [nftFilter, selectionMode]);

  // Track current wallet address to filter out stale NFTs from previous wallet
  const activeWalletRef = React.useRef(null);
  const syncInProgressRef = React.useRef(false);
  const normWallet = (w) => w ? String(w).trim() : '';
  const getConnectedGalleryWallet = () => {
    try {
      const status = WalletAdapter.getConnectionStatus ? WalletAdapter.getConnectionStatus() : null;
      return normWallet(status?.address);
    } catch (_) {
      return '';
    }
  };
  const getNFTWallet = (n) => normWallet(n?.ownerAddress);
  const filterByWallet = (nftList) => {
    const w = normWallet(activeWalletRef.current) || getConnectedGalleryWallet();
    if (!w) return nftList;
    return nftList.filter(n => !getNFTWallet(n) || getNFTWallet(n) === w);
  };
  const getActiveWalletAddress = useCallback(async () => {
    const connectedWallet = getConnectedGalleryWallet();
    if (connectedWallet) {
      activeWalletRef.current = connectedWallet;
      return connectedWallet;
    }
    const cachedWallet = normWallet(activeWalletRef.current);
    if (cachedWallet) return cachedWallet;
    try {
      const storedNFTs = await NFTOperations.getStoredNFTs();
      const storedWallet = getNFTWallet(storedNFTs.find(n => getNFTWallet(n)));
      if (storedWallet) {
        activeWalletRef.current = storedWallet;
        return storedWallet;
      }
    } catch (_) { }
    return '';
  }, []);

  // Custom dark alert state
  const [darkAlert, setDarkAlert] = useState(null);
  const [alertCheckbox, setAlertCheckbox] = useState(null);
  const alertCheckboxValueRef = React.useRef(false);

  // Show dark themed alert
  const showDarkAlert = (title, message, buttons = [{ text: t('common.ok'), onPress: () => closeDarkAlert() }], extra = null) => {
    const checkbox = extra?.checkbox ? { ...extra.checkbox } : null;
    alertCheckboxValueRef.current = !!checkbox?.value;
    setAlertCheckbox(checkbox);
    setDarkAlert({ title, message, buttons });
  };

  const closeDarkAlert = () => {
    alertCheckboxValueRef.current = false;
    setAlertCheckbox(null);
    setDarkAlert(null);
  };

  useEffect(() => {
    if (visible) return;
    setSelectedNFT(null);
    setNfts([]);
    activeWalletRef.current = null;
    setCertifiedMints(new Set());
    setCurrentPage(0);
    setLoading(true);
    setRefreshing(false);
    setSyncing(false);
    setVerifying(false);
    setVerificationResult(null);
  }, [visible]);

  // Handle Android back button for detail overlay (no longer a Modal)
  useEffect(() => {
    if (!selectedNFT) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelectedNFT(null);
      return true;
    });
    return () => handler.remove();
  }, [selectedNFT]);

  const mergeAppendOnly = (current, incoming) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return current || [];
    if (!Array.isArray(current) || current.length === 0) return incoming;

    const norm = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const existingIds = new Set(
      current
        .map(nft => norm(nft?.mintAddress) || norm(nft?.assetId))
        .filter(Boolean)
    );

    const newOnes = incoming.filter(nft => {
      const id = norm(nft?.mintAddress) || norm(nft?.assetId);
      if (!id || existingIds.has(id)) return false;
      existingIds.add(id); // prevent dupes within incoming
      return true;
    });

    return newOnes.length > 0 ? [...current, ...newOnes] : current;
  };

  const getFullNFTByMint = useCallback(async (mintAddress, assetId) => {
    const targetMint = normalizeMint(mintAddress);
    const targetAsset = normalizeMint(assetId);
    if (!targetMint && !targetAsset) return null;
    const storedNFTs = await NFTOperations.getStoredNFTs();
    if (targetMint) {
      const mintMatch = storedNFTs.find(nft => normalizeMint(nft?.mintAddress) === targetMint);
      if (mintMatch) return mintMatch;
    }
    if (targetAsset) {
      const assetMatch = storedNFTs.find(nft => normalizeMint(nft?.assetId) === targetAsset);
      if (assetMatch) return assetMatch;
    }
    return null;
  }, []);

  const openNFTDetail = useCallback(async (item) => {
    const targetId = normalizeMint(item?.mintAddress || item?.assetId);
    setSelectedNFT(item);
    try {
      const full = await getFullNFTByMint(item?.mintAddress, item?.assetId);
      if (!full) return;
      setSelectedNFT(prev => {
        const prevId = normalizeMint(prev?.mintAddress || prev?.assetId);
        return prevId === targetId ? full : prev;
      });
    } catch (_) { }
  }, [getFullNFTByMint]);

  const loadNFTsAppendOnly = async (syncFromServer = false) => {
    const prevCount = nfts.length;
    let needsRefresh = prevCount === 0;
    try {
      // Bidirectional sync: pull from server, then push local to server
      if (syncFromServer && serverUrl && getAuthHeaders && !syncInProgressRef.current) {
        syncInProgressRef.current = true;
        setSyncing(true);
        try {
          const authConfig = await getAuthHeaders();
          const headers = authConfig?.headers || authConfig;
          const walletAddr = await getActiveWalletAddress();
          if (walletAddr) {
            const syncResult = await NFTOperations.syncNFTsFromServer('https://stealthlynk.io', headers, walletAddr);
            let removedCount = 0;
            try { removedCount = await NFTOperations.removeTransferredNFTs(walletAddr, 'https://stealthlynk.io', headers); } catch (_) { }
            needsRefresh = needsRefresh || ((syncResult?.merged || 0) > 0) || removedCount > 0;
          }
        } catch (syncErr) {
          console.log('[NFTGallery] Server sync failed, using local:', syncErr.message);
        } finally {
          setSyncing(false);
          syncInProgressRef.current = false;
        }
      }

      const storedNFTs = await NFTOperations.getStoredNFTs();
      const walletAddr = await getActiveWalletAddress();
      if (walletAddr) activeWalletRef.current = walletAddr;
      const filtered = filterByWallet(storedNFTs);
      if (needsRefresh || filtered.length !== prevCount) {
        setNfts(slimNFTListForState(filtered));
      }
    } catch (e) {
      console.error('[NFTGallery] Append-only load error:', e);
    } finally {
      setLoading(false);
    }
  };

  // Auto-scan blockchain on gallery open (like desktop does)
  // Uses wallet address from stored NFTs — no wallet prompt needed
  const autoScanBlockchain = useCallback(async () => {
    try {
      // Use getActiveWalletAddress which checks stored NFTs then falls back to WalletAdapter
      const walletAddr = await getActiveWalletAddress();
      if (!walletAddr) {
        console.log('[NFTGallery] No wallet address available, skipping auto-scan');
        return;
      }
      activeWalletRef.current = walletAddr;
      console.log('[NFTGallery] Auto-scanning blockchain for:', walletAddr);
      let headers = null;
      if (getAuthHeaders) {
        try {
          const authConfig = await getAuthHeaders();
          headers = authConfig?.headers || authConfig;
        } catch (_) { }
      }
      NFTOperations.invalidateDasCache();
      const result = await NFTOperations.discoverAndImportNFTs(walletAddr, 'https://stealthlynk.io', headers);
      if (result.success && (result.imported > 0 || result.updated > 0)) {
        console.log(`[NFTGallery] Auto-scan: ${result.imported} new, ${result.updated || 0} updated`);
        // Reload full list from storage to pick up updated encryptionData/edition
        const freshNFTs = await NFTOperations.getStoredNFTs();
        if (freshNFTs.length > 0) setNfts(slimNFTListForState(filterByWallet(freshNFTs)));
      }
      // Sync certificates from server (restores cert badges after storage clear)
      if (headers) {
        try {
          await NFTOperations.syncCertificatesFromServer('https://stealthlynk.io', headers, walletAddr);
          console.log('[NFTGallery] Auto-scan: certificates synced from server');
        } catch (_) { }
      }
    } catch (e) {
      console.log('[NFTGallery] Auto-scan failed (non-critical):', e.message);
    }
  }, [serverUrl, getAuthHeaders, getActiveWalletAddress]);

  const liveRefreshNFTs = useCallback(async () => {
    try {
      if (!visible) return;
      if (!serverUrl || !getAuthHeaders) return;
      if (syncInProgressRef.current || scanInProgressRef.current) return;
      const walletAddr = await getActiveWalletAddress();
      if (!walletAddr) return;
      const authConfig = await getAuthHeaders();
      const headers = authConfig?.headers || authConfig;
      if (!headers) return;
      syncInProgressRef.current = true;
      const syncResult = await NFTOperations.syncNFTsFromServer('https://stealthlynk.io', headers, walletAddr);
      let removedCount = 0;
      try {
        removedCount = await NFTOperations.removeTransferredNFTs(walletAddr, 'https://stealthlynk.io', headers);
      } catch (_) { }
      const changed = ((syncResult?.added || 0) > 0) || ((syncResult?.updated || 0) > 0) || ((syncResult?.merged || 0) > 0) || removedCount > 0;
      if (!changed) return;
      const freshNFTs = await NFTOperations.getStoredNFTs();
      setNfts(slimNFTListForState(filterByWallet(freshNFTs)));
    } catch (_) {
    } finally {
      syncInProgressRef.current = false;
    }
  }, [visible, serverUrl, getAuthHeaders]);

  // Guard to prevent overlapping blockchain scans
  const scanInProgressRef = React.useRef(false);
  const lastScanTimeRef = React.useRef(0);

  // Auto-select NFT when navigating from CertificatesViewer
  useEffect(() => {
    if (!visible || !pendingSelectMint || nfts.length === 0) return;
    const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const target = normMint(pendingSelectMint);
    const match = nfts.find(n => normMint(n.mintAddress) === target);
    if (match) {
      void openNFTDetail(match);
    }
    onPendingSelectConsumed?.();
  }, [visible, pendingSelectMint, nfts, openNFTDetail]);

  // Load certificate mint addresses for "Certified" badge on grid cards
  useEffect(() => {
    if (!visible) return;
    const loadCerts = async () => {
      try {
        const certs = await NFTOperations.getStoredCertificates();
        const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
        const mints = new Set(certs.map(c => normMint(c.mintAddress)).filter(Boolean));
        setCertifiedMints(mints);
      } catch (_) { }
    };
    loadCerts();
  }, [visible, nfts.length]);

  // Load NFTs on mount - local storage first, then auto-scan blockchain, then periodic sync
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    // Show cached NFTs first, then sync/resolve/scan in the background.
    // Running sync + scan in parallel causes 2x syncNFTsFromServer + blockchain scan + backup simultaneously → OOM
    loadNFTs(false).then(async () => {
      if (cancelled) return;
      await loadNFTsAppendOnly(true);
      if (cancelled) return;
      // Auto-resolve any unresolved cnft_tx_ / tx_ entries via DAS (non-blocking)
      try {
        let arHeaders = null;
        if (getAuthHeaders) { try { const ac = await getAuthHeaders(); arHeaders = ac?.headers || ac; } catch (_) { } }
        const activeWallet = await getActiveWalletAddress();
        const arResult = await NFTOperations.autoResolveUnresolvedCNFTs(activeWallet || null, 'https://stealthlynk.io', arHeaders);
        if (!cancelled && arResult.resolved > 0) await loadNFTsAppendOnly(false);
      } catch (_) { }
      if (cancelled) return;
      const now = Date.now();
      if (!scanInProgressRef.current && now - lastScanTimeRef.current > 60000) {
        scanInProgressRef.current = true;
        lastScanTimeRef.current = now;
        autoScanBlockchain().finally(() => { scanInProgressRef.current = false; });
      }
    });

    const interval = setInterval(() => {
      loadNFTsAppendOnly(true);
    }, NFT_PASSIVE_REFRESH_MS);

    return () => { cancelled = true; clearInterval(interval); };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void loadNFTsAppendOnly(true);
      }
    });
    return () => sub.remove();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      void liveRefreshNFTs();
    }, NFT_LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [visible, liveRefreshNFTs]);

  // When refreshKey changes (e.g. after transfer), do a full reload from storage
  useEffect(() => {
    if (!visible || refreshKey === undefined) return;
    loadNFTs(false);
  }, [refreshKey]);

  // Load NFTs from storage, optionally sync from server first
  const loadNFTs = async (syncFromServer = false) => {
    try {
      setLoading(true);

      // Sync from server if available (restores NFTs after reinstall)
      if (syncFromServer && serverUrl && getAuthHeaders) {
        setSyncing(true);
        try {
          const authConfig = await getAuthHeaders();
          const headers = authConfig?.headers || authConfig;
          const walletAddr = await getActiveWalletAddress();
          if (walletAddr) {
            await NFTOperations.syncNFTsFromServer('https://stealthlynk.io', headers, walletAddr);
            try { await NFTOperations.removeTransferredNFTs(walletAddr, 'https://stealthlynk.io', headers); } catch (_) { }
          }
        } catch (syncErr) {
          console.log('[NFTGallery] Server sync failed, using local:', syncErr.message);
        } finally {
          setSyncing(false);
        }
      }

      const storedNFTs = await NFTOperations.getStoredNFTs();
      const walletAddr = await getActiveWalletAddress();
      if (walletAddr) activeWalletRef.current = walletAddr;
      setNfts(slimNFTListForState(filterByWallet(storedNFTs)));
      setCurrentPage(0); // Reset to first page
    } catch (e) {
      console.error('[NFTGallery] Load error:', e);
    } finally {
      setLoading(false);
    }
  };

  // Backup NFTs to server
  const backupToServer = async () => {
    if (!serverUrl || !getAuthHeaders) {
      showDarkAlert(t('nftAlbum.notConnected'), t('nftAlbum.connectToBackup'));
      return;
    }

    setSyncing(true);
    try {
      const authConfig = await getAuthHeaders();
      const headers = authConfig?.headers || authConfig;
      const walletAddr = await getActiveWalletAddress();
      if (!walletAddr) {
        throw new Error('Please connect your wallet before backing up NFTs.');
      }
      const result = await NFTOperations.backupNFTsToServer('https://stealthlynk.io', headers, walletAddr);
      if (result.success) {
        showDarkAlert(t('nftAlbum.backupComplete'), t('nftAlbum.nftsBackedUp', { count: result.backed }));
      } else {
        showDarkAlert(t('nftAlbum.backupFailed'), result.error || t('nftAlbum.unknownError'));
      }
    } catch (e) {
      showDarkAlert(t('nftAlbum.backupFailed'), e.message);
    } finally {
      setSyncing(false);
    }
  };

  // Scan wallet for NFTs from blockchain (manual button press)
  const scanWalletForNFTs = async () => {
    // Don't block manual scan if auto-scan is running — user explicitly pressed the button
    scanInProgressRef.current = true;
    setSyncing(true);
    try {
      // Get auth headers for server sync (StealthCloud)
      let headers = null;
      if (getAuthHeaders) {
        try {
          const authConfig = await getAuthHeaders();
          headers = authConfig?.headers || authConfig;
        } catch (e) {
          console.log('[NFTGallery] No auth headers available');
        }
      }

      let walletAddress = await getActiveWalletAddress();

      // If no stored wallet, prompt wallet connection
      if (!walletAddress) {
        try {
          const { transact } = await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
          await transact(async (wallet) => {
            const authResult = await wallet.authorize({
              cluster: 'mainnet-beta',
              identity: {
                name: 'PhotoLynk',
                uri: 'https://photolynk.app',
                icon: 'favicon.ico',
              },
            });
            const address = authResult.accounts[0].address;
            const addressBytes = typeof address === 'string'
              ? Uint8Array.from(atob(address), c => c.charCodeAt(0))
              : new Uint8Array(address);
            const { PublicKey } = await import('@solana/web3.js');
            walletAddress = new PublicKey(addressBytes).toBase58();
          });
        } catch (e) {
          console.log('[NFTGallery] Wallet transact failed:', e?.message);
        }
      }

      if (walletAddress) {
        activeWalletRef.current = walletAddress;
        if (headers) {
          try {
            await NFTOperations.syncNFTsFromServer('https://stealthlynk.io', headers, walletAddress);
            await NFTOperations.removeTransferredNFTs(walletAddress, 'https://stealthlynk.io', headers);
            await NFTOperations.backupNFTsToServer('https://stealthlynk.io', headers, walletAddress);
          } catch (e) {
            console.log('[NFTGallery] Server sync during scan failed:', e?.message);
          }
        }
        console.log('[NFTGallery] Scanning wallet:', walletAddress);
        NFTOperations.invalidateDasCache();
        // Discover and import NFTs from blockchain
        const result = await NFTOperations.discoverAndImportNFTs(walletAddress, 'https://stealthlynk.io', headers);
        if (result.skipped) {
          showDarkAlert(t('nftAlbum.scanSkipped'), 'NFT minting in progress — please wait and try again');
        } else if (result.success && result.imported > 0) {
          showDarkAlert(t('nftAlbum.nftsFound'), t('nftAlbum.importedNfts', { count: result.imported }));
        }
      }

      // Always reload from storage — server sync may have added NFTs even if blockchain scan found 0
      await loadNFTsAppendOnly(false);

      const storedCount = (await NFTOperations.getStoredNFTs()).length;
      if (!walletAddress && storedCount === 0) {
        showDarkAlert(t('nftAlbum.noNftsFound'), t('nftAlbum.noNftsInWallet'));
      } else if (storedCount > 0 && !walletAddress) {
        showDarkAlert(t('nftAlbum.alreadySynced'), t('nftAlbum.allAlreadyInAlbum', { count: storedCount }));
      }
    } catch (e) {
      console.error('[NFTGallery] Scan failed:', e);
      showDarkAlert(t('nftAlbum.scanFailed'), e.message);
    } finally {
      setSyncing(false);
      scanInProgressRef.current = false;
    }
  };

  // Check if NFT is compressed (cNFT)
  const isCompressedNFT = (nft) => {
    return nft.isCompressed || nft.mintAddress?.startsWith('cnft_');
  };

  // Filtered and sorted NFTs
  const filteredNFTs = useMemo(() => {
    // Exclude heavy on-chain embedded NFTs (data: URI images stripped at storage → no renderable image)
    let result = nfts.filter(nft => {
      if (nft.storageType === 'onchain') return false;
      const img = nft.imageUrl || nft.arweaveUrl || '';
      if (img.startsWith('data:') && img.length > 50000) return false;
      return true;
    });

    // Apply certification mode filter.
    //   - 'all'     → every NFT the wallet possesses (PhotoLynk + foreign).
    //   - 'public'  → ONLY PhotoLynk-minted NFTs flagged public (or unmarked + unencrypted).
    //   - 'private' → ONLY PhotoLynk-minted NFTs flagged private (or encrypted).
    // The ecosystem gate is `isStrictPhotoLynkMinted`, which requires the shared
    // PhotoLynk Merkle tree (or PhotoLynk-specific cert/proof-hash signatures for
    // legacy stored objects). Foreign NFTs from other collections never match.
    if (nftFilter === 'private') {
      // `certificationMode` is a PhotoLynk-only attribute — foreign NFTs never
      // carry it, so it's a sufficient ecosystem gate on its own. The previous
      // strict gate (merkleTree / contentHash+exifHash) excluded legacy
      // PhotoLynk mints whose locally cached object never captured those
      // fields, even though they show the Private badge in All Photos.
      result = result.filter(nft => isPrivateNFTTabMatch(nft));
    } else if (nftFilter === 'public') {
      result = result.filter(nft => isPublicNFTTabMatch(nft));
    }
    // 'all' shows everything (PhotoLynk + any other Solana NFTs the wallet owns)

    // Apply search filter (name, description, and badge tags)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
      result = result.filter(nft => {
        if (nft.name?.toLowerCase().includes(query) || nft.description?.toLowerCase().includes(query)) return true;
        // Build searchable badge tags
        const tags = [];
        if (isPrivateNFTTabMatch(nft)) { tags.push('private', 'certified'); }
        else if (isPublicNFTTabMatch(nft)) { tags.push('public', 'certified'); }
        if (nft.edition === 'limited') { tags.push('limited'); }
        else if (nft.edition === 'open') { tags.push('open'); }
        if (isCompressedNFT(nft)) { tags.push('compressed', 'cnft'); } else { tags.push('standard'); }
        if (shouldDisplayEncrypted(nft)) tags.push('encrypted'); else tags.push('unencrypted');

        // Add network/storage tags
        if (nft.network === 'solana') { tags.push('solana', 'onchain'); }
        if (nft.storageType === 'onchain') { tags.push('onchain'); }
        if (nft.storageType === 'cloud') { tags.push('cloud'); }
        if (nft.storageType === 'arweave') { tags.push('arweave'); }
        if (nft.storageType === 'ipfs') { tags.push('ipfs'); }
        if (nft.watermarked) tags.push('watermarked');
        const mint = normMint(nft.mintAddress);
        if (mint && certifiedMints.has(mint)) tags.push('certified');
        const _urls = (nft.imageUrl || '') + (nft.arweaveUrl || '');
        const st = nft.storageType || (_urls.startsWith('data:') ? 'onchain' : _urls.includes('stealthlynk.io') ? 'cloud' : (_urls.includes('arweave.net') || _urls.includes('akrd.net')) ? 'arweave' : 'ipfs');
        tags.push(st);
        if (st === 'onchain') tags.push('on-chain');
        return tags.join(' ').includes(query);
      });
    }

    // Apply sorting (default: newest first)
    result.sort((a, b) => {
      switch (sortBy) {
        case 'date_desc':
          return getNFTDateValue(b) - getNFTDateValue(a);
        case 'date_asc':
          return getNFTDateValue(a) - getNFTDateValue(b);
        case 'name_asc':
          return (a.name || '').localeCompare(b.name || '');
        case 'name_desc':
          return (b.name || '').localeCompare(a.name || '');
        default:
          return 0;
      }
    });

    return result;
  }, [nfts, searchQuery, sortBy, nftFilter, certifiedMints]);

  // Paginated NFTs - show only current page (4 items)
  const visibleCount = filteredNFTs.length;
  const totalPages = Math.ceil(visibleCount / ITEMS_PER_PAGE);
  const displayedNFTs = useMemo(() => {
    const start = currentPage * ITEMS_PER_PAGE;
    return filteredNFTs.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredNFTs, currentPage]);

  // Report total NFT count (not filtered/paginated) to parent for quick stats
  useEffect(() => {
    if (onNftCountChange) onNftCountChange(nfts.length);
  }, [onNftCountChange, nfts.length]);

  // Report certified NFT count (Public + Private tabs) to parent for quick stats
  // Only reports when gallery is visible to avoid zeroing out on close
  useEffect(() => {
    if (!onCertifiedCountChange || !visible) return;
    if (!nfts.length) return; // Don't report 0 on initial load/close
    // Base filter: exclude onchain storage and large data URIs (same as filteredNFTs base)
    const baseFiltered = nfts.filter(nft => {
      if (nft.storageType === 'onchain') return false;
      const img = nft.imageUrl || nft.arweaveUrl || '';
      if (img.startsWith('data:') && img.length > 50000) return false;
      return true;
    });
    // Private tab count (mirrors nftFilter==='private' exactly)
    const privateCount = baseFiltered.filter(nft => isPrivateNFTTabMatch(nft)).length;
    // Public tab count (mirrors nftFilter==='public' exactly)
    const publicCount = baseFiltered.filter(nft => isPublicNFTTabMatch(nft)).length;
    onCertifiedCountChange(privateCount + publicCount);
  }, [onCertifiedCountChange, nfts, visible]);

  // Pagination handlers
  const goToNextPage = () => {
    if (currentPage < totalPages - 1) {
      setCurrentPage(prev => prev + 1);
    }
  };

  const goToPrevPage = () => {
    if (currentPage > 0) {
      setCurrentPage(prev => prev - 1);
    }
  };

  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;

  // Refresh NFTs (sync from server)
  const onRefresh = async () => {
    setRefreshing(true);
    await loadNFTs(true); // true = sync from server
    setRefreshing(false);
  };

  // Helper: get auth headers for server calls
  const getHeaders = async () => {
    if (!getAuthHeaders) return null;
    try {
      const authConfig = await getAuthHeaders();
      return authConfig?.headers || authConfig;
    } catch (e) {
      console.log('[NFTGallery] No auth headers for server clear');
      return null;
    }
  };

  // Execute the actual clear with given options
  const executeClear = async (options = {}) => {
    closeDarkAlert();
    const walletAddress = options.walletAddress || await getActiveWalletAddress();
    if (!walletAddress) {
      showDarkAlert(t('common.error'), t('nftAlbum.connectToBackup') || 'Please connect your wallet first.');
      return;
    }
    const headers = await getHeaders();
    const result = await NFTOperations.clearAllStoredNFTs(serverUrl, headers, { ...options, walletAddress });
    if (!result.success) {
      showDarkAlert(t('common.error'), result.error || result.serverError || 'Failed to clear NFT album');
      return;
    }
    setNfts([]);
    setSelectedNFT(null);
    if (options.deleteAssets) {
      if (!result.server) {
        showDarkAlert(
          t('common.error'),
          result.serverError || 'Album entries were cleared locally, but server-side file deletion and IPFS unpinning did not complete.'
        );
        return;
      }
      const s = result.server || {};
      const parts = [];
      if (s.nftsCleared) parts.push(`${s.nftsCleared} NFT album entr${s.nftsCleared === 1 ? 'y' : 'ies'} removed`);
      if (s.filesDeleted) parts.push(`${s.filesDeleted} StealthCloud file(s) deleted`);
      if (s.unpinned) parts.push(`${s.unpinned} Pinata unpin operation(s) completed`);
      if (s.unpinFailed) parts.push(`${s.unpinFailed} Pinata unpin operation(s) failed`);
      const clearCompleteTitle = t('nftAlbum.clearComplete');
      showDarkAlert(clearCompleteTitle === 'nftAlbum.clearComplete' ? 'Clear Complete' : clearCompleteTitle, parts.join('\n') || 'Wallet NFT data removed.');
      return;
    }
    const clearCompleteTitle = t('nftAlbum.clearComplete');
    showDarkAlert(clearCompleteTitle === 'nftAlbum.clearComplete' ? 'Clear Complete' : clearCompleteTitle, 'Album entries were cleared only for the connected wallet. Use Scan Wallet to fetch NFTs again from blockchain.');
  };

  const clearAllNFTs = async () => {
    const walletAddress = await getActiveWalletAddress();
    if (!walletAddress) {
      showDarkAlert(t('common.error'), t('nftAlbum.connectToBackup') || 'Please connect your wallet first.');
      return;
    }
    showDarkAlert(
      t('nftAlbum.clearAllNfts'),
      'This will remove these photos from your album. You can scan again later to restore them from the blockchain. Check the box below only if you also want to permanently delete the stored image files.',
      [
        { text: t('common.cancel'), onPress: () => closeDarkAlert() },
        {
          text: t('common.continue') || 'Continue',
          onPress: () => {
            if (!alertCheckboxValueRef.current) {
              executeClear({ walletAddress });
              return;
            }
            showDarkAlert(
              '⚠️ ' + (t('nftAlbum.dangerZone') || 'Danger Zone'),
              'This will permanently delete the stored image files. This cannot be undone. Your NFT and metadata will still remain on the blockchain, so this does not burn your NFT.',
              [
                { text: t('common.cancel'), onPress: () => closeDarkAlert() },
                {
                  text: t('nftAlbum.confirmDelete') || 'Delete Everything',
                  onPress: () => executeClear({ walletAddress, deleteAssets: true, unpinIpfs: true }),
                },
              ]
            );
          }
        },
      ],
      {
        checkbox: {
          label: 'Also permanently delete the stored image files',
          value: false,
        },
      }
    );
  };

  // Verify NFT on blockchain
  const verifyOnChain = async (nft) => {
    setVerifying(true);
    setVerificationResult(null);

    try {
      // Pass txSignature as fallback for old cNFTs without valid asset IDs
      const result = await NFTOperations.verifyNFTOnChain(nft.mintAddress, nft.txSignature);
      setVerificationResult(result);
    } catch (e) {
      setVerificationResult({ verified: false, error: e.message });
    } finally {
      setVerifying(false);
    }
  };

  // Open external link
  const openLink = (url) => {
    if (!url) {
      showDarkAlert(t('common.error'), 'URL not available');
      return;
    }
    Linking.openURL(url).catch(e => {
      showDarkAlert(t('common.error'), t('nftAlbum.couldNotOpenLink'));
    });
  };

  // Handle transfer
  const handleTransfer = (nft) => {
    setSelectedNFT(null);
    onTransferNFT?.(nft);
  };

  // Unpin all Pinata IPFS files associated with a burned NFT (image, metadata JSON,
  // thumbnail, encrypted thumb, and any nested CIDs inside the metadata JSON).
  // Fire-and-forget: never blocks the burn completion path.
  const unpinPinataFilesForBurn = async (nft) => {
    try {
      if (!nft) return;
      // Collect every URL/CID we know about for this PhotoLynk cNFT. PhotoLynk
      // mints (public + private, encrypted + unencrypted) put the following on Pinata:
      //   - image/encrypted-image blob (`imageUrl`/`arweaveUrl`)
      //   - thumbnail (`thumbnailUrl`/`ipfsThumbnailUrl`)
      //   - encrypted thumbnail (only for encrypted NFTs — lives in `encryptionData`)
      //   - metadata JSON (`metadataUrl`)
      // For encrypted NFTs `nft.metadata` is null (blob is unparseable) so we cannot
      // rely on metadata.image / properties.files — we MUST fall back to the
      // top-level fields and the encryptionData block.
      const urls = [
        nft.imageUrl,
        nft.arweaveUrl,
        nft.thumbnailUrl,
        nft.ipfsThumbnailUrl,
        nft.encryptedThumbnailUrl,
        nft.encryptionData?.thumbnailUrl,
        nft.encryptionData?.encryptedFile,
        nft.metadataUrl,
        nft.metadata?.image,
        nft.metadata?.thumbnail,
        nft.metadata?.encryptedThumbnail,
        nft.metadata?.properties?.encryption?.encryptedFile,
        nft.metadata?.properties?.encryption?.thumbnailUrl,
        ...((Array.isArray(nft.metadata?.properties?.files) ? nft.metadata.properties.files : []).map(f => f?.uri)),
      ].filter(Boolean);
      if (urls.length === 0 && !nft.metadataUrl) return;
      const cids = new Set(urls.map(extractIPFSCid).filter(Boolean));
      if (nft.metadataUrl) {
        const metadataCid = extractIPFSCid(nft.metadataUrl);
        if (metadataCid) cids.add(metadataCid);
      }

      let authHeaders = null;
      if (getAuthHeaders) { try { const ac = await getAuthHeaders(); authHeaders = ac?.headers || ac; } catch (_) { } }
      // Always target the StealthLynk-hosted nft-service (where Pinata JWTs live),
      // regardless of which server the user is connected to.
      const targetBase = 'https://stealthlynk.io';
      const resp = await fetch(`${targetBase}/api/nft-service/unpin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeaders || {}) },
        body: JSON.stringify({ urls, metadataUrl: nft.metadataUrl || null }),
      });
      try {
        const data = await resp.json();
        console.log(`[Burn] Pinata unpin: ${data?.succeeded || 0}/${data?.total || 0} for ${nft.mintAddress}`);
        if (!resp.ok || data?.failed > 0) {
          console.warn('[Burn] Pinata unpin details:', data);
        }
      } catch (_) { }
      const pinataAccounts = getAllPinataJwts();
      let directSucceeded = 0;
      let directFailed = 0;
      for (const cid of cids) {
        let removed = false;
        let allNotFound = true;
        for (const { label, jwt } of pinataAccounts) {
          try {
            const directResp = await fetch(`https://api.pinata.cloud/pinning/unpin/${cid}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${jwt}` },
            });
            if (directResp.ok) {
              console.log(`[Burn] Direct Pinata unpin success (${label}) for ${cid}`);
              removed = true;
              break;
            }
            const body = await directResp.text().catch(() => '');
            if (directResp.status === 404 || /CURRENT_USER_HAS_NOT_PINNED_CID|not.*pinned|not\s*found/i.test(body)) {
              continue;
            }
            if (directResp.status !== 404) {
              allNotFound = false;
              console.warn(`[Burn] Direct Pinata unpin failed (${label}) for ${cid}: ${directResp.status} ${body}`);
            }
          } catch (directErr) {
            allNotFound = false;
            console.warn(`[Burn] Direct Pinata unpin error (${label}) for ${cid}:`, directErr.message);
          }
        }
        if (removed || allNotFound) directSucceeded++;
        else directFailed++;
      }
      if (cids.size > 0) {
        console.log(`[Burn] Direct Pinata unpin: ${directSucceeded}/${cids.size} succeeded, ${directFailed} failed`);
      }
    } catch (e) {
      console.warn('[Burn] Pinata unpin request failed:', e.message);
    }
  };

  // Handle burn (PhotoLynk ecosystem only)
  const performBurn = async (nft) => {
    closeDarkAlert();
    if (!nft) return;
    if (!isBurnSelectable(nft)) {
      showDarkAlert(t('common.error'), 'This NFT was not minted by PhotoLynk and cannot be burned from this app.');
      return;
    }
    setBurning(true);
    try {
      const result = await NFTOperations.burnNFT(nft);
      if (!result?.success) {
        if (result?.userCancelled) return;
        showDarkAlert(t('common.error'), result?.error || 'Burn failed');
        return;
      }
      // Fire-and-forget: unpin Pinata IPFS files now that on-chain burn succeeded.
      // Runs in parallel with local cleanup; never blocks the UI.
      unpinPinataFilesForBurn(nft).catch(() => {});
      // Cleanup local + server state
      const mintAddrStored = nft.mintAddress;
      const mintAddrStripped = (mintAddrStored || '').replace('cnft_', '');
      try { await addToTransferredOutBlacklist(mintAddrStored); } catch (_) { }
      if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
        try { await addToTransferredOutBlacklist(mintAddrStripped); } catch (_) { }
      }
      try { await NFTOperations.removeNFTFromStorage(mintAddrStored); } catch (_) { }
      if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
        try { await NFTOperations.removeNFTFromStorage(mintAddrStripped); } catch (_) { }
      }
      try { await NFTOperations.removeCertificateByMint(mintAddrStored); } catch (_) { }
      if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
        try { await NFTOperations.removeCertificateByMint(mintAddrStripped); } catch (_) { }
      }
      // Notify server to remove from sync index
      try {
        let authHeaders = null;
        if (getAuthHeaders) { try { const ac = await getAuthHeaders(); authHeaders = ac?.headers || ac; } catch (_) { } }
        if (serverUrl && authHeaders) {
          try {
            await fetch(`${serverUrl}/api/nft/sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ action: 'remove', mintAddress: mintAddrStored, ownerAddress: nft.ownerAddress || '' }),
            });
          } catch (_) { }
        }
      } catch (_) { }

      setNfts(prev => prev.filter(n => n.mintAddress !== mintAddrStored));
      setSelectedNFT(null);
      const burnedTitle = t('nftAlbum.burnComplete');
      showDarkAlert(burnedTitle === 'nftAlbum.burnComplete' ? 'NFT Burned' : burnedTitle, 'The NFT has been permanently burned on the blockchain.');
    } catch (e) {
      showDarkAlert(t('common.error'), e.message || 'Burn failed');
    } finally {
      setBurning(false);
    }
  };

  // ===== Multi-select / batch burn =====
  const enterSelectionMode = useCallback((initialNft = null) => {
    setSelectionMode(true);
    setSelectedIds(initialNft?.mintAddress ? new Set([initialNft.mintAddress]) : new Set());
  }, []);
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };
  const toggleSelection = useCallback((nft) => {
    if (!nft || !nft.mintAddress) return;
    if (!isBurnSelectable(nft)) return; // Only PhotoLynk NFTs are selectable
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(nft.mintAddress)) next.delete(nft.mintAddress);
      else next.add(nft.mintAddress);
      return next;
    });
  }, []);

  const performBatchBurn = async () => {
    closeDarkAlert();
    const targets = nfts.filter(n => selectedIds.has(n.mintAddress) && isBurnSelectable(n));
    if (targets.length === 0) return;
    const cooldownUnlessCancelled = (totalSec) => new Promise(resolve => {
      setCooldownSeconds(totalSec);
      const endsAt = Date.now() + totalSec * 1000;
      const tick = () => {
        const remainingMs = endsAt - Date.now();
        if (cancelBurnRef.current || remainingMs <= 0) {
          setCooldownSeconds(0);
          resolve();
          return;
        }
        setCooldownSeconds(Math.ceil(remainingMs / 1000));
        setTimeout(tick, 250);
      };
      tick();
    });
    cancelBurnRef.current = false;
    setStopAfterCurrentRequested(false);
    setBurning(true);
    setBatchProgress({ current: 0, total: targets.length });

    let burned = 0, failed = 0, cancelled = 0;
    const burnedMints = [];
    let lastError = null;

    for (let i = 0; i < targets.length; i++) {
      if (cancelBurnRef.current) {
        cancelled = targets.length - i;
        break;
      }
      const nft = targets[i];
      setBatchProgress({ current: i + 1, total: targets.length });
      burnPhaseRef.current = 'preparing';
      let attemptOutcome = 'fail'; // 'success' | 'fail' | 'cancelled'
      try {
        const result = await NFTOperations.burnNFT(nft, null, {
          onBurnPhase: ({ phase }) => {
            burnPhaseRef.current = phase || 'preparing';
          },
        });
        if (result?.success) {
          attemptOutcome = 'success';
          burned++;
          burnedMints.push(nft.mintAddress);
          // Fire-and-forget: unpin Pinata IPFS files for this burned NFT
          unpinPinataFilesForBurn(nft).catch(() => {});
          // Cleanup per NFT
          const mintAddrStored = nft.mintAddress;
          const mintAddrStripped = (mintAddrStored || '').replace('cnft_', '');
          try { await addToTransferredOutBlacklist(mintAddrStored); } catch (_) { }
          if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
            try { await addToTransferredOutBlacklist(mintAddrStripped); } catch (_) { }
          }
          try { await NFTOperations.removeNFTFromStorage(mintAddrStored); } catch (_) { }
          if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
            try { await NFTOperations.removeNFTFromStorage(mintAddrStripped); } catch (_) { }
          }
          try { await NFTOperations.removeCertificateByMint(mintAddrStored); } catch (_) { }
          if (mintAddrStripped && mintAddrStripped !== mintAddrStored) {
            try { await NFTOperations.removeCertificateByMint(mintAddrStripped); } catch (_) { }
          }
          try { NFTOperations.invalidateDasCache?.(); } catch (_) { }
          // Server sync remove (fire and forget)
          try {
            let authHeaders = null;
            if (getAuthHeaders) { try { const ac = await getAuthHeaders(); authHeaders = ac?.headers || ac; } catch (_) { } }
            if (serverUrl && authHeaders) {
              fetch(`${serverUrl}/api/nft/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ action: 'remove', mintAddress: mintAddrStored, ownerAddress: nft.ownerAddress || '' }),
              }).catch(() => { });
            }
          } catch (_) { }
        } else if (result?.userCancelled) {
          // User cancelled wallet prompt: stop the batch
          attemptOutcome = 'cancelled';
          cancelled = targets.length - i;
        } else {
          failed++;
          lastError = result?.error || 'Unknown error';
        }
      } catch (e) {
        const msg = String(e?.message || e || '');
        const isCancelled = /cancel|user reject|user denied|CancellationException/i.test(msg);
        if (isCancelled) {
          attemptOutcome = 'cancelled';
          cancelled = targets.length - i;
        } else {
          failed++;
          lastError = msg || 'Unknown error';
        }
      }
      if (burnTimerRef.current) {
        clearInterval(burnTimerRef.current);
        burnTimerRef.current = null;
      }

      if (attemptOutcome === 'cancelled') break;

      // Cooldown between burns (success OR failure) so the Merkle tree updates on-chain
      if (i < targets.length - 1 && String(nft.mintAddress || '').startsWith('cnft_')) {
        await cooldownUnlessCancelled(30);
        if (cancelBurnRef.current) {
          cancelled = targets.length - i - 1;
          break;
        }
      }
    }

    // Update gallery state
    if (burnedMints.length > 0) {
      setNfts(prev => prev.filter(n => !burnedMints.includes(n.mintAddress)));
    }
    if (burnTimerRef.current) {
      clearInterval(burnTimerRef.current);
      burnTimerRef.current = null;
    }
    setBurning(false);
    setBatchProgress(null);
    setStopAfterCurrentRequested(false);
    setCooldownSeconds(0);
    setBurnWaitSeconds(30);
    burnPhaseRef.current = 'preparing';
    exitSelectionMode();

    // Summary
    const parts = [];
    if (burned > 0) parts.push(`${burned} burned`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    const summary = parts.join(', ') || 'No changes';
    const friendlyError = (() => {
      if (!lastError) return '';
      const raw = String(lastError);
      if (/CancellationException|user reject|user denied|cancel/i.test(raw)) return 'Wallet request was cancelled';
      if (/timeout/i.test(raw)) return 'Wallet did not respond in time';
      if (/proof|merkle|stale/i.test(raw)) return 'On-chain state was still updating. Try again in a few seconds.';
      if (/network|fetch|connection/i.test(raw)) return 'Network error. Check your connection and try again.';
      return raw;
    })();
    const detail = failed > 0 && friendlyError ? `\n\nLast error: ${friendlyError}` : '';
    showDarkAlert(burned > 0 ? 'Burn Complete' : 'Burn Stopped', summary + detail);
  };

  const handleBatchBurn = () => {
    const count = selectedIds.size;
    if (count === 0) return;
    showDarkAlert(
      `Burn ${count} NFT${count === 1 ? '' : 's'}?`,
      `Only PhotoLynk-certified NFTs can be burned from this app — public or private, encrypted or non-encrypted. External NFTs in your album cannot be selected.\n\nThis will permanently destroy ${count} NFT${count === 1 ? '' : 's'} on the blockchain. Each will require a separate wallet approval. The stored image files will also be removed. This cannot be undone.`,
      [
        { text: t('common.cancel'), onPress: () => closeDarkAlert() },
        {
          text: t('common.continue') || 'Continue',
          onPress: () => {
            showDarkAlert(
              '⚠️ Permanent Burn',
              `You are about to permanently burn ${count} NFT${count === 1 ? '' : 's'}. This is irreversible.`,
              [
                { text: t('common.cancel'), onPress: () => closeDarkAlert() },
                { text: 'Burn Forever', onPress: () => performBatchBurn() },
              ]
            );
          }
        },
      ]
    );
  };

  const handleBurn = (nft) => {
    if (!nft) return;
    if (!isBurnSelectable(nft)) {
      showDarkAlert(t('common.error'), 'This NFT was not minted by PhotoLynk and cannot be burned from this app.');
      return;
    }
    const burnTitle = t('nftAlbum.burnNft');
    const dangerTitle = t('nftAlbum.burnDangerTitle');
    const confirmText = t('nftAlbum.confirmBurn');
    showDarkAlert(
      burnTitle === 'nftAlbum.burnNft' ? 'Burn NFT' : burnTitle,
      'Only PhotoLynk-certified NFTs can be burned from this app — public or private, encrypted or non-encrypted, compressed (cNFT) or standard. External NFTs cannot be burned here.\n\nThis will permanently destroy this NFT on the blockchain. It cannot be recovered, restored, or rescanned. The stored image files for this NFT will also be removed.',
      [
        { text: t('common.cancel'), onPress: () => closeDarkAlert() },
        {
          text: t('common.continue') || 'Continue',
          onPress: () => {
            showDarkAlert(
              '⚠️ ' + (dangerTitle === 'nftAlbum.burnDangerTitle' ? 'Permanent Burn' : dangerTitle),
              'You are about to permanently burn this NFT. This is irreversible — once confirmed, the NFT no longer exists on-chain.',
              [
                { text: t('common.cancel'), onPress: () => closeDarkAlert() },
                {
                  text: confirmText === 'nftAlbum.confirmBurn' ? 'Burn Forever' : confirmText,
                  onPress: () => performBurn(nft),
                },
              ]
            );
          }
        },
      ]
    );
  };

  // Render premium 3D-style NFT card
  const renderNFTCard = useCallback(({ item, index }) => {
    const ecosystem = isBurnSelectable(item);
    const isSelected = selectionMode && selectedIds.has(item.mintAddress);
    const cardOnPress = selectionMode
      ? () => {
        if (ignoreNextCardPressRef.current) {
          ignoreNextCardPressRef.current = false;
          return;
        }
        toggleSelection(item);
      }
      : () => {
        if (ignoreNextCardPressRef.current) {
          ignoreNextCardPressRef.current = false;
          return;
        }
        openNFTDetail(item);
      };
    const cardOnLongPress = !selectionMode && ecosystem && nftFilter !== 'all'
      ? () => {
        ignoreNextCardPressRef.current = true;
        enterSelectionMode(item);
      }
      : undefined;
    const cardDisabled = selectionMode && !ecosystem;
    return (
    <TouchableOpacity
      style={[styles.nftCard, cardDisabled && { opacity: 0.35 }]}
      onPress={cardOnPress}
      onLongPress={cardOnLongPress}
      activeOpacity={0.9}
      disabled={cardDisabled}
    >
      {/* 3D Shadow layers */}
      <View style={styles.cardShadow3} />
      <View style={styles.cardShadow2} />
      <View style={styles.cardShadow1} />

      {/* Selection checkbox overlay (top-left) — only in selection mode and only for ecosystem NFTs */}
      {selectionMode && ecosystem && (
        <View style={{ position: 'absolute', top: 6, left: 6, zIndex: 20, width: 26, height: 26, borderRadius: 13, backgroundColor: isSelected ? '#FF453A' : 'rgba(0,0,0,0.55)', borderWidth: 2, borderColor: isSelected ? '#FF453A' : 'rgba(255,255,255,0.85)', justifyContent: 'center', alignItems: 'center' }}>
          {isSelected && <Feather name="check" size={14} color="#fff" />}
        </View>
      )}
      {/* Selection mode lock indicator for non-ecosystem NFTs */}
      {selectionMode && !ecosystem && (
        <View style={{ position: 'absolute', top: 6, left: 6, zIndex: 20, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center' }}>
          <Feather name="lock" size={12} color="rgba(255,255,255,0.6)" />
        </View>
      )}

      {/* Main card */}
      <View style={styles.cardMain}>
        {/* Render image: data: URI → direct; encrypted → decrypt; else normal */}
        {(() => {
          // Check if any field has a data: URI (true on-chain embedded image)
          const dataUri = [item.imageUrl, item.arweaveUrl].find(u => u && u.startsWith('data:'));
          if (dataUri) {
            // On-chain: use thumbnail if available (faster), else data URI
            const bestUrl = item.thumbnailUrl || dataUri;
            return (
              <NFTImageWithFallback
                url={bestUrl}
                originalUrl={dataUri}
                style={styles.nftImage}
              />
            );
          }
          if (shouldDisplayEncrypted(item)) {
            // On-chain encrypted: only decrypt if we have the small encrypted thumbnail
            // (without thumbnailNonce, the only URLs are metadata blobs → OOM)
            // Non-on-chain encrypted: standalone encrypted image file is safe to download
            const hasEncThumb = !!((item.thumbnailUrl || item.ipfsThumbnailUrl || item.encryptionData?.thumbnailUrl) && item.encryptionData?.thumbnailNonce);
            const hasStandaloneImage = !!(item.imageUrl || item.arweaveUrl);
            const isOnChainEnc = item.storageType === 'onchain' || !hasStandaloneImage;
            const canDecrypt = isOnChainEnc ? hasEncThumb : hasStandaloneImage;
            if (canDecrypt && (item.encryptionData?.wrappedKey || item.encryptionData?.transferNftKey || shouldDisplayEncrypted(item))) {
              return <DecryptedNFTImage nft={item} style={styles.nftImage} getAuthHeaders={getAuthHeaders} serverUrl={serverUrl} />;
            }
            // No decryptable URL (StealthCloud not accessible) — show lock placeholder
            return (
              <View style={[styles.nftImage, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(245, 158, 11, 0.06)' }]}>
                <Feather name="lock" size={24} color="#f59e0b" />
                <Text style={{ fontSize: 8, color: '#f59e0b', fontWeight: '600', marginTop: 4, textAlign: 'center' }}>Encrypted{`\n`}& Certified</Text>
              </View>
            );
          }
          const imgUrl = item.thumbnailUrl || item.imageUrl || item.arweaveUrl || item.metadataUrl;
          return imgUrl ? (
            <NFTImageWithFallback
              url={imgUrl}
              originalUrl={item.ipfsThumbnailUrl || item.arweaveUrl || item.metadataUrl}
              style={styles.nftImage}
            />
          ) : (
            <View style={[styles.nftImage, styles.noImagePlaceholder]}>
              <Feather name="image" size={32} color={COLORS.textSecondary} />
            </View>
          );
        })()}

        {/* Certified badge (top-right) — only for NFTs with Public/Private certification */}
        {(() => {
          const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
          // Only show if NFT has certificationMode or edition (is actually Public or Private)
          const hasCertification = item.certificationMode || item.edition;
          if (hasCertification && certifiedMints.has(normMint(item.mintAddress))) {
            return (
              <TouchableOpacity
                style={{ position: 'absolute', top: 6, right: 6, zIndex: 10, backgroundColor: 'rgba(245,158,11,0.9)', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 3 }}
                activeOpacity={0.7}
                onPress={(e) => {
                  e.stopPropagation?.();
                  onShowCertificate?.(item.mintAddress);
                }}
              >
                <Feather name="award" size={10} color="#fff" />
                <Text style={{ fontSize: 8, color: '#fff', fontWeight: '700' }}>{t('nftAlbum.certified')}</Text>
              </TouchableOpacity>
            );
          }
          return null;
        })()}

        {/* Gradient overlay */}
        <View style={styles.cardGradient} />

        {/* Card info */}
        <View style={styles.cardInfo}>
          <Text style={styles.nftName} numberOfLines={1}>{item.name}</Text>
          <View style={styles.cardMeta}>
            <View style={styles.dateBadge}>
              <Feather name="calendar" size={10} color="rgba(255,255,255,0.7)" />
              <Text style={styles.nftDate}>
                {(() => {
                  const rawDate = item.createdAt || item.mintedAt || item.metadata?.properties?.certificate?.mintedAt;
                  const parsed = rawDate ? new Date(rawDate) : null;
                  return parsed && !Number.isNaN(parsed.getTime())
                    ? parsed.toLocaleDateString(getCurrentLanguage())
                    : '—';
                })()}
              </Text>
            </View>
            {/* Certification badge — only for certified NFTs */}
            {(item.certificationMode || item.edition) && (
              isPrivateNFTTabMatch(item) ? (
                <View style={[styles.solanaBadge, { backgroundColor: 'rgba(245, 158, 11, 0.3)' }]}>
                  <Text style={{ fontSize: 8, color: '#f59e0b', fontWeight: '600' }}>🔐 {t('nftAlbum.privateBadge')}</Text>
                </View>
              ) : isPublicNFTTabMatch(item) ? (
                <View style={[styles.solanaBadge, { backgroundColor: 'rgba(34, 197, 94, 0.3)' }]}>
                  <Text style={{ fontSize: 8, color: '#22c55e', fontWeight: '600' }}>🌍 {t('nftAlbum.publicBadge')}</Text>
                </View>
              ) : null
            )}
            {/* Encrypted indicator — only for PhotoLynk ecosystem NFTs */}
            {isPhotoLynkEcosystem(item) && shouldDisplayEncrypted(item) && (
              <View style={[styles.solanaBadge, { backgroundColor: 'rgba(245, 158, 11, 0.3)' }]}>
                <Feather name="lock" size={8} color="#f59e0b" />
              </View>
            )}
            {/* Storage badge */}
            {(() => {
              const _urls = (item.imageUrl || '') + (item.arweaveUrl || '');
              const st = item.storageType || (_urls.startsWith('data:') ? 'onchain' : _urls.includes('stealthlynk.io') ? 'cloud' : (_urls.includes('arweave.net') || _urls.includes('akrd.net')) ? 'arweave' : null);
              if (st === 'cloud') return (
                <View style={[styles.solanaBadge, { backgroundColor: 'rgba(245, 158, 11, 0.3)' }]}>
                  <Feather name="cloud" size={8} color="#f59e0b" />
                </View>
              );
              if (st === 'onchain') return (
                <View style={[styles.solanaBadge, { backgroundColor: 'rgba(245, 158, 11, 0.3)' }]}>
                  <Feather name="code" size={8} color="#f59e0b" />
                </View>
              );
              return (
                <View style={[styles.solanaBadge, { backgroundColor: 'rgba(153, 69, 255, 0.3)' }]}>
                  <Feather name="globe" size={8} color="#9945FF" />
                </View>
              );
            })()}
          </View>
        </View>
      </View>
    </TouchableOpacity>
    );
  }, [certifiedMints, onShowCertificate, getAuthHeaders, openNFTDetail, selectionMode, selectedIds, toggleSelection, nftFilter, enterSelectionMode]);

  // Render NFT detail modal
  const renderDetailModal = () => {
    if (!selectedNFT) return null;

    return (
      <View style={styles.modalOverlay}>
        <View style={[styles.detailModal, { paddingBottom: bottomInset }]}>
          {/* Header - fixed at top, compact: only name + close */}
          <View style={styles.detailHeader}>
            <Text style={styles.detailTitle} numberOfLines={1}>{selectedNFT.name}</Text>
            <TouchableOpacity onPress={() => setSelectedNFT(null)}>
              <Feather name="x" size={24} color={COLORS.text} />
            </TouchableOpacity>
          </View>

          {/* Scrollable content */}
          <ScrollView
            key={`scroll-${selectedNFT.mintAddress}`}
            style={styles.detailScrollView}
            contentContainerStyle={[styles.detailScrollContent, { paddingBottom: 40 + bottomInset }]}
            showsVerticalScrollIndicator={true}
            bounces={false}
          >
            {/* Type & edition badges — only for certified NFTs */}
            <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, flexWrap: 'wrap' }}>
              {(selectedNFT.certificationMode || selectedNFT.edition) && (
                isPrivateNFTTabMatch(selectedNFT) ? (
                  <View style={{ backgroundColor: 'rgba(245, 158, 11, 0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ fontSize: 10, color: '#f59e0b', fontWeight: '600' }}>🔐 {t('nftAlbum.privateCertification') || 'Private Certified'}</Text>
                  </View>
                ) : isPublicNFTTabMatch(selectedNFT) ? (
                  <View style={{ backgroundColor: 'rgba(34, 197, 94, 0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ fontSize: 10, color: '#22c55e', fontWeight: '600' }}>🌍 {t('nftAlbum.publicCertification') || 'Public Certified'}</Text>
                  </View>
                ) : null
              )}
              <View style={{ backgroundColor: (selectedNFT.storageType === 'cloud' || (!selectedNFT.storageType && ((selectedNFT.imageUrl || '') + (selectedNFT.arweaveUrl || '')).includes('stealthlynk.io'))) ? 'rgba(245, 158, 11, 0.2)' : 'rgba(153, 69, 255, 0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
                <Text style={{ fontSize: 10, color: (selectedNFT.storageType === 'cloud' || (!selectedNFT.storageType && ((selectedNFT.imageUrl || '') + (selectedNFT.arweaveUrl || '')).includes('stealthlynk.io'))) ? '#f59e0b' : '#9945FF', fontWeight: '600' }}>
                  {(() => { if (selectedNFT.storageType === 'cloud') return 'StealthCloud'; if (selectedNFT.storageType === 'arweave') return 'Arweave'; if (selectedNFT.storageType === 'onchain') return 'On-Chain'; if (selectedNFT.storageType) return 'IPFS'; const _u = (selectedNFT.imageUrl || '') + (selectedNFT.arweaveUrl || ''); return _u.includes('stealthlynk.io') ? 'StealthCloud' : _u.includes('arweave.net') || _u.includes('akrd.net') ? 'Arweave' : _u.startsWith('data:') ? 'On-Chain' : 'IPFS'; })()}
                </Text>
              </View>
              {/* Encrypted badge - only for PhotoLynk ecosystem NFTs */}
              {isPhotoLynkEcosystem(selectedNFT) && shouldDisplayEncrypted(selectedNFT) && (
                <View style={{ backgroundColor: 'rgba(245, 158, 11, 0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Feather name="lock" size={9} color="#f59e0b" />
                  <Text style={{ fontSize: 10, color: '#f59e0b', fontWeight: '600' }}>{t('nftAlbum.encrypted')}</Text>
                </View>
              )}
              {selectedNFT.watermarked === true && (
                <View style={{ backgroundColor: 'rgba(34, 197, 94, 0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
                  <Text style={{ fontSize: 10, color: '#22c55e', fontWeight: '600' }}>{t('nftAlbum.watermarked')}</Text>
                </View>
              )}
              {selectedNFT.license && selectedNFT.license !== 'none' && (
                <View style={{ backgroundColor: 'rgba(245, 158, 11, 0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
                  <Text style={{ fontSize: 10, color: '#f59e0b', fontWeight: '600' }}>{selectedNFT.license === 'arr' ? t('nftAlbum.allRightsReserved') : selectedNFT.license?.toUpperCase()}</Text>
                </View>
              )}
              {(selectedNFT.hasRfc3161 || selectedNFT.attributes?.some(a => a.trait_type === 'RFC 3161 Timestamp')) && (
                <View style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderColor: 'rgba(16,185,129,0.4)' }}>
                  <Feather name="clock" size={9} color="#10b981" />
                  <Text style={{ fontSize: 10, color: '#10b981', fontWeight: '700' }}>RFC 3161</Text>
                </View>
              )}
              {(selectedNFT.hasC2pa || selectedNFT.attributes?.some(a => a.trait_type === 'C2PA Provenance')) && (
                <View style={{ backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}>
                  <Feather name="shield" size={9} color="#fff" />
                  <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>C2PA</Text>
                </View>
              )}
            </View>

            {/* Image — detect on-chain ONLY if a data: URI is actually present */}
            {(() => {
              const dataUri = [selectedNFT.imageUrl, selectedNFT.arweaveUrl].find(u => u && u.startsWith('data:'));

              if (dataUri) {
                const isSvg = dataUri && dataUri.startsWith('data:image/svg+xml');
                // Prefer thumbnail for detail (higher res raster), fallback to data URI
                const thumbOrRemote = selectedNFT.thumbnailUrl && !selectedNFT.thumbnailUrl.startsWith('data:') ? selectedNFT.thumbnailUrl : null;

                if (isSvg && !thumbOrRemote) {
                  // Render embedded SVG at proper size
                  return (
                    <View pointerEvents="none" style={[styles.detailImage, { height: 220, minHeight: 220, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.surface, overflow: 'hidden' }]}>
                      {(() => {
                        try {
                          const b64 = dataUri.split(',')[1] || '';
                          const svg = decodeURIComponent(escape(atob(b64)));
                          return <SvgXml xml={svg} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" />;
                        } catch (e) {
                          return <Feather name="code" size={48} color={COLORS.textSecondary} />;
                        }
                      })()}
                      <Text style={{ fontSize: 10, color: COLORS.textSecondary, marginTop: 6 }}>{t('nftAlbum.embeddedOnChain') || 'Embedded preview'}</Text>
                    </View>
                  );
                }
                if (dataUri && !isSvg && !thumbOrRemote) {
                  // Non-SVG data URI (e.g. data:image/jpeg)
                  return <Image source={{ uri: dataUri }} style={styles.detailImage} resizeMode="contain" />;
                }
                // Use thumbnail or fallback
                const bestUrl = thumbOrRemote || dataUri || selectedNFT.imageUrl || selectedNFT.metadataUrl;
                return bestUrl ? (
                  <NFTImageWithFallback
                    key={`img-${selectedNFT.mintAddress}`}
                    url={bestUrl}
                    originalUrl={dataUri || selectedNFT.arweaveUrl || selectedNFT.metadataUrl}
                    style={styles.detailImage}
                    isDetail={true}
                  />
                ) : (
                  <View style={[styles.detailImage, styles.noImagePlaceholder]}>
                    <Feather name="image" size={48} color={COLORS.textSecondary} />
                    <Text style={styles.noImageText}>{t('nftAlbum.noImageAvailable')}</Text>
                  </View>
                );
              }

              // Non-on-chain: encrypted → decrypt; otherwise normal image
              if (shouldDisplayEncrypted(selectedNFT)) {
                const hasEncThumb = !!((selectedNFT.thumbnailUrl || selectedNFT.ipfsThumbnailUrl || selectedNFT.encryptionData?.thumbnailUrl) && selectedNFT.encryptionData?.thumbnailNonce);
                const hasStandaloneImage = !!(selectedNFT.imageUrl || selectedNFT.arweaveUrl);
                const isOnChainEnc = selectedNFT.storageType === 'onchain' || !hasStandaloneImage;
                const canDecrypt = isOnChainEnc ? hasEncThumb : hasStandaloneImage;
                if (canDecrypt && (selectedNFT.encryptionData?.wrappedKey || selectedNFT.encryptionData?.transferNftKey || shouldDisplayEncrypted(selectedNFT))) {
                  return <DecryptedNFTImage nft={selectedNFT} style={styles.detailImage} isDetail={true} getAuthHeaders={getAuthHeaders} serverUrl={serverUrl} />;
                }
                return (
                  <View style={[styles.detailImage, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(245, 158, 11, 0.06)' }]}>
                    <Feather name="lock" size={48} color="#f59e0b" />
                    <Text style={{ fontSize: 14, color: '#f59e0b', fontWeight: '600', marginTop: 6 }}>Encrypted & Certified</Text>
                  </View>
                );
              }
              const imgUrl = selectedNFT.thumbnailUrl || selectedNFT.imageUrl || selectedNFT.arweaveUrl || selectedNFT.metadataUrl;
              return imgUrl ? (
                <NFTImageWithFallback
                  key={`img-${selectedNFT.mintAddress}`}
                  url={imgUrl}
                  originalUrl={selectedNFT.ipfsThumbnailUrl || selectedNFT.arweaveUrl || selectedNFT.metadataUrl}
                  style={styles.detailImage}
                  isDetail={true}
                />
              ) : (
                <View style={[styles.detailImage, styles.noImagePlaceholder]}>
                  <Feather name="image" size={48} color={COLORS.textSecondary} />
                  <Text style={styles.noImageText}>{t('nftAlbum.noImageAvailable')}</Text>
                </View>
              );
            })()}

            {/* Certification banner — clickable to view certificate */}
            {(selectedNFT.certificationMode || selectedNFT.edition) && (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: isPrivateNFTTabMatch(selectedNFT) ? 'rgba(245, 158, 11, 0.08)' : 'rgba(34,197,94,0.08)', borderBottomWidth: 1, borderBottomColor: COLORS.border }}
                activeOpacity={0.7}
                onPress={() => onShowCertificate?.(selectedNFT.mintAddress)}
              >
                <Feather name="shield" size={24} color={isPrivateNFTTabMatch(selectedNFT) ? '#f59e0b' : '#22c55e'} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: isPrivateNFTTabMatch(selectedNFT) ? '#f59e0b' : '#22c55e' }}>{t('certificates.certificateOfAuth')}</Text>
                  <Text style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 2 }}>{isPrivateNFTTabMatch(selectedNFT) ? t('nftAlbum.privateCertDesc') : t('nftAlbum.publicCertDesc')}</Text>
                </View>
                <Feather name="chevron-right" size={20} color={isPrivateNFTTabMatch(selectedNFT) ? '#f59e0b' : '#22c55e'} />
              </TouchableOpacity>
            )}

            {/* Owner info */}
            <View style={styles.ownerSection}>
              <Text style={styles.sectionLabel}>{t('nftAlbum.nftOwner')}</Text>
              <Text style={styles.ownerAddress} numberOfLines={1}>
                {selectedNFT.ownerAddress}
              </Text>
            </View>


            {/* Description */}
            {selectedNFT.description && (
              <View style={styles.descriptionSection}>
                <Text style={styles.sectionLabel}>{t('nftAlbum.description')}</Text>
                <Text style={styles.descriptionText}>{selectedNFT.description}</Text>
              </View>
            )}

            {/* EXIF Data */}
            {selectedNFT.exifData && (
              <View style={styles.exifSection}>
                <Text style={styles.sectionLabel}>{t('nftAlbum.photoDetails')}</Text>
                <View style={styles.exifGrid}>
                  {selectedNFT.exifData.dateTaken && (
                    <View style={styles.exifItem}>
                      <Feather name="calendar" size={14} color={COLORS.textSecondary} />
                      <Text style={styles.exifText}>
                        {new Date(selectedNFT.exifData.dateTaken).toLocaleDateString(getCurrentLanguage())}
                      </Text>
                    </View>
                  )}
                  {selectedNFT.exifData.camera && (
                    <View style={styles.exifItem}>
                      <Feather name="camera" size={14} color={COLORS.textSecondary} />
                      <Text style={styles.exifText}>{selectedNFT.exifData.camera}</Text>
                    </View>
                  )}
                  {selectedNFT.exifData.width && selectedNFT.exifData.height && (
                    <View style={styles.exifItem}>
                      <Feather name="maximize" size={14} color={COLORS.textSecondary} />
                      <Text style={styles.exifText}>
                        {selectedNFT.exifData.width}x{selectedNFT.exifData.height}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}


            {/* Action buttons - context-aware based on NFT type and storage */}
            <View style={styles.actionButtons}>
              {/* Token view - different for cNFT vs standard NFT */}
              {selectedNFT.isCompressed || selectedNFT.mintAddress?.startsWith('cnft_') || selectedNFT.mintAddress?.startsWith('tx_') ? (
                // cNFT: Use Tensor for real asset IDs, Solscan for tx-based fallback
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => {
                    const mintAddr = selectedNFT.mintAddress || '';
                    // Extract real asset ID — try explicit assetId, then cnft_{assetId} mintAddress
                    let assetId = '';
                    const explicitAsset = selectedNFT.assetId || '';
                    // Only use explicit assetId if it looks like a real blockchain asset ID (not media library ID)
                    if (explicitAsset && explicitAsset.length > 30 && !explicitAsset.startsWith('tx_') && !explicitAsset.startsWith('ph://') && /^[1-9A-HJ-NP-Za-km-z]+$/.test(explicitAsset)) {
                      assetId = explicitAsset;
                    }
                    if (!assetId && mintAddr.startsWith('cnft_') && !mintAddr.startsWith('cnft_tx_')) {
                      const extracted = mintAddr.replace('cnft_', '');
                      if (extracted.length > 30 && !extracted.startsWith('tx_')) assetId = extracted;
                    }
                    if (!assetId && mintAddr.length > 30 && !mintAddr.startsWith('tx_') && !mintAddr.startsWith('cnft_tx_') && !mintAddr.startsWith('cnft_')) {
                      assetId = mintAddr;
                    }
                    if (assetId && assetId.length > 30) {
                      openLink(`https://www.tensor.trade/item/${assetId.replace(/^cnft_/, '')}`);
                    } else {
                      // Fallback: open tx signature on Solscan
                      const txSig = mintAddr.startsWith('cnft_tx_')
                        ? mintAddr.replace('cnft_tx_', '')
                        : mintAddr.startsWith('tx_')
                          ? mintAddr.replace('tx_', '')
                          : selectedNFT.txSignature || '';
                      if (txSig && txSig.length > 30) {
                        openLink(`https://solscan.io/tx/${txSig}`);
                      } else {
                        showDarkAlert(t('nftAlbum.rescanRequired') || 'Rescan Required', t('nftAlbum.rescanMessage') || 'This cNFT was created before proper asset ID tracking. Please use "Scan Wallet" to update your NFT data.');
                      }
                    }
                  }}
                >
                  <Feather name="zap" size={16} color={COLORS.text} />
                  <Text style={styles.actionButtonText}>{t('nftAlbum.explorer') || 'Explorer'}</Text>
                </TouchableOpacity>
              ) : (
                // Standard NFT: Use Tensor
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => {
                    const mint = selectedNFT.mintAddress || '';
                    if (mint && mint.length > 30 && !mint.startsWith('tx_')) {
                      openLink(`https://www.tensor.trade/item/${mint}`);
                    } else {
                      openLink(NFTOperations.getSolscanUrl(mint));
                    }
                  }}
                >
                  <Feather name="search" size={16} color={COLORS.text} />
                  <Text style={styles.actionButtonText}>{t('nftAlbum.explorer') || 'Explorer'}</Text>
                </TouchableOpacity>
              )}

              {/* Image storage - IPFS, StealthCloud, or On-Chain */}
              <TouchableOpacity
                style={styles.actionButton}
                onPress={async () => {
                  // On-chain: image is a data: URI embedded in metadata — open metadata URL instead
                  const isOnChain = selectedNFT.storageType === 'onchain' || (selectedNFT.imageUrl || '').startsWith('data:');
                  if (isOnChain) {
                    const metaUrl = selectedNFT.metadataUrl || selectedNFT.uri || '';
                    if (metaUrl) {
                      const metaCid = extractIPFSCid(metaUrl);
                      openLink(metaCid ? `https://ipfs.io/ipfs/${metaCid}` : metaUrl);
                    } else {
                      showDarkAlert(t('common.error'), t('nftAlbum.metadataNotAvailable') || 'Metadata URL not available');
                    }
                    return;
                  }

                  // Determine if this is StealthCloud or IPFS storage
                  const isStealthCloud = selectedNFT.storageType === 'cloud' || (!selectedNFT.storageType && (selectedNFT.imageUrl || '').includes('stealthlynk.io'));

                  if (isStealthCloud) {
                    // StealthCloud: use thumbnailUrl or imageUrl directly
                    const url = selectedNFT.thumbnailUrl || selectedNFT.imageUrl || selectedNFT.arweaveUrl;
                    if (url) {
                      openLink(url);
                    } else {
                      showDarkAlert(t('common.error'), t('nftAlbum.imageUrlNotAvailable'));
                    }
                    return;
                  }

                  // Encrypted IPFS: skip content-type probe (HEAD/fetch downloads multi-MB blob
                  // into app memory → OOM). Just open the stored URL directly in the browser.
                  if (shouldDisplayEncrypted(selectedNFT)) {
                    const url = selectedNFT.arweaveUrl || selectedNFT.imageUrl || selectedNFT.metadataUrl;
                    if (url) {
                      const cid = extractIPFSCid(url);
                      openLink(cid ? `https://ipfs.io/ipfs/${cid}` : url);
                    } else {
                      showDarkAlert(t('common.error'), t('nftAlbum.imageUrlNotAvailable'));
                    }
                    return;
                  }

                  // IPFS storage: need to find the actual image URL
                  // arweaveUrl might be metadata JSON URL, not image URL
                  // We need to fetch metadata and extract the image field

                  let imageUrl = null;

                  // Check if we have a direct IPFS image URL (not metadata)
                  // Metadata URLs typically end with the CID only, image URLs have file extensions or specific patterns
                  const possibleImageUrl = selectedNFT.imageUrl || selectedNFT.arweaveUrl;
                  if (possibleImageUrl) {
                    const cid = extractIPFSCid(possibleImageUrl);
                    if (cid) {
                      // Fetch to check if it's JSON (metadata) or image
                      try {
                        const testUrl = `https://w3s.link/ipfs/${cid}`;
                        const resp = await fetch(testUrl, { method: 'HEAD', timeout: 3000 });
                        const contentType = resp.headers.get('content-type') || '';

                        if (contentType.includes('image')) {
                          // It's an image, use directly
                          imageUrl = testUrl;
                        } else if (contentType.includes('json')) {
                          // It's metadata JSON, fetch and extract image
                          const jsonResp = await fetch(testUrl, { timeout: 5000 });
                          if (jsonResp.ok) {
                            const meta = await jsonResp.json();
                            if (meta.image) {
                              imageUrl = meta.image;
                            }
                          }
                        }
                      } catch (e) {
                        console.log('[NFT] Could not determine content type:', e.message);
                      }
                    }
                  }

                  // If still no image URL, try metadataUrl
                  if (!imageUrl && selectedNFT.metadataUrl) {
                    const metaCid = extractIPFSCid(selectedNFT.metadataUrl);
                    if (metaCid) {
                      try {
                        const gateways = [
                          `https://w3s.link/ipfs/${metaCid}`,
                          `https://nftstorage.link/ipfs/${metaCid}`,
                        ];
                        for (const gateway of gateways) {
                          try {
                            const resp = await fetch(gateway, { timeout: 5000 });
                            if (resp.ok) {
                              const meta = await resp.json();
                              if (meta.image) {
                                imageUrl = meta.image;
                                break;
                              }
                            }
                          } catch (e) { }
                        }
                      } catch (e) { }
                    }
                  }

                  // Open the image URL
                  if (imageUrl) {
                    const cid = extractIPFSCid(imageUrl);
                    if (cid) {
                      openLink(`https://ipfs.io/ipfs/${cid}`);
                    } else {
                      openLink(imageUrl);
                    }
                  } else {
                    showDarkAlert(t('common.error'), t('nftAlbum.imageUrlNotAvailable'));
                  }
                }}
              >
                <Feather name="image" size={16} color={COLORS.text} />
                <Text style={styles.actionButtonText}>
                  {selectedNFT.storageType === 'onchain' || (selectedNFT.imageUrl || '').startsWith('data:') ? t('nftAlbum.metadata') : (selectedNFT.thumbnailUrl || selectedNFT.imageUrl || '').includes('stealthlynk.io') ? t('nftAlbum.imageBtn') : t('nftAlbum.ipfs')}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Share Cert hidden for now — kept for future development */}
            {false && (selectedNFT.certificationMode || selectedNFT.edition) && (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,153,255,0.15)', borderRadius: 10, paddingVertical: 12, marginBottom: 8, gap: 8 }}
                onPress={async () => {
                  try {
                    const cert = NFTOperations.generateCertificate(selectedNFT);
                    if (!cert) { showDarkAlert(t('common.error'), t('certificates.noCertsHint')); return; }
                    const text = NFTOperations.formatCertificateForExport(cert);
                    await Share.share({ message: text, title: `${t('certificates.certificateOfAuth')} — ${cert.name}` });
                  } catch (e) {
                    if (e.message !== 'User did not share') {
                      showDarkAlert(t('common.error'), e.message);
                    }
                  }
                }}
                activeOpacity={0.7}
              >
                <Feather name="award" size={16} color="#0099FF" />
                <Text style={{ color: '#0099FF', fontWeight: '600', fontSize: 14 }}>{t('certificates.shareCert')}</Text>
              </TouchableOpacity>
            )}

            {/* Transfer button — styled like View in Album but blue */}
            {isPhotoLynkEcosystem(selectedNFT) ? (
              <>
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,153,255,0.15)', borderRadius: 10, paddingVertical: 12, marginTop: 16, gap: 8 }}
                  onPress={() => handleTransfer(selectedNFT)}
                  activeOpacity={0.7}
                >
                  <Feather name="send" size={16} color="#0099FF" />
                  <Text style={{ color: '#0099FF', fontWeight: '600', fontSize: 14 }}>{t('nftAlbum.transferNft')}</Text>
                </TouchableOpacity>
                {/* Burn button — only shown for PhotoLynk ecosystem NFTs */}
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,69,58,0.12)', borderRadius: 10, paddingVertical: 12, marginTop: 10, gap: 8, borderWidth: 1, borderColor: 'rgba(255,69,58,0.35)' }}
                  onPress={() => handleBurn(selectedNFT)}
                  activeOpacity={0.7}
                >
                  <Feather name="trash-2" size={16} color="#FF453A" />
                  <Text style={{ color: '#FF453A', fontWeight: '600', fontSize: 14 }}>
                    {(() => { const v = t('nftAlbum.burnNft'); return v === 'nftAlbum.burnNft' ? 'Burn NFT' : v; })()}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 10, paddingVertical: 12, marginTop: 16, gap: 8 }}>
                <Feather name="lock" size={16} color="rgba(255,255,255,0.35)" />
                <Text style={{ color: 'rgba(255,255,255,0.35)', fontWeight: '600', fontSize: 14 }}>Not Transferrable</Text>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    );
  };

  // Handle Android back button since we're not using Modal anymore
  useEffect(() => {
    if (!visible) return;
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => backHandler.remove();
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <View style={styles.fullOverlay}>
      <View style={[styles.container, { paddingBottom: bottomInset }]}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: topInset }]}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Feather name="x" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text numberOfLines={1} style={styles.headerTitle}>{t('nftAlbum.myAlbum')}</Text>
            <Text style={styles.headerSubtitle}>{visibleCount} {t('nftAlbum.memories')}</Text>
          </View>
          {/* Header right: Select / Cancel toggle for multi-select burn (Public/Private tabs only — hidden in All) */}
          {nfts.length > 0 && nftFilter !== 'all' ? (
            selectionMode ? (
              <TouchableOpacity onPress={exitSelectionMode} style={styles.headerRight} disabled={burning}>
                <Text style={{ color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' }}>{t('common.cancel') || 'Cancel'}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={enterSelectionMode} style={styles.headerRight}>
                <Feather name="check-square" size={20} color={COLORS.textSecondary} />
              </TouchableOpacity>
            )
          ) : (
            <View style={styles.headerRight} />
          )}
          {/* Clear All Photos button hidden — kept in code for future development.
              To re-enable, restore the TouchableOpacity below. */}
          {false && (
            <TouchableOpacity onPress={clearAllNFTs} style={styles.headerRight}>
              {nfts.length > 0 && (
                <Feather name="archive" size={20} color={COLORS.textSecondary} />
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Filter Toggle - All, Public, Private */}
        {nfts.length > 0 && (
          <View style={styles.filterToggleBar}>
            <TouchableOpacity
              style={[styles.filterToggle, nftFilter === 'all' && styles.filterToggleActive]}
              onPress={() => { setNftFilter('all'); setCurrentPage(0); }}
            >
              <Feather name="grid" size={14} color={nftFilter === 'all' ? '#fff' : COLORS.textSecondary} />
              <Text numberOfLines={1} style={[styles.filterToggleText, nftFilter === 'all' && styles.filterToggleTextActive]}>
                {t('nftAlbum.allNfts')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.filterToggle, nftFilter === 'public' && { backgroundColor: 'rgba(34, 197, 94, 0.3)', borderColor: '#22c55e' }]}
              onPress={() => { setNftFilter('public'); setCurrentPage(0); }}
            >
              <View style={{ alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Feather name="globe" size={14} color={nftFilter === 'public' ? '#22c55e' : COLORS.textSecondary} />
                  <Text numberOfLines={1} style={[styles.filterToggleText, nftFilter === 'public' && { color: '#22c55e' }]}>
                    {t('nftAlbum.publicFilter')}
                  </Text>
                </View>
                <Text numberOfLines={1} style={{ fontSize: 8, color: COLORS.textSecondary, marginTop: 2 }}>{t('nftAlbum.publicFilterDesc')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.filterToggle, nftFilter === 'private' && { backgroundColor: 'rgba(245, 158, 11, 0.3)', borderColor: '#f59e0b' }]}
              onPress={() => { setNftFilter('private'); setCurrentPage(0); }}
            >
              <View style={{ alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Feather name="lock" size={14} color={nftFilter === 'private' ? '#f59e0b' : COLORS.textSecondary} />
                  <Text numberOfLines={1} style={[styles.filterToggleText, nftFilter === 'private' && { color: '#f59e0b' }]}>
                    {t('nftAlbum.privateFilter')}
                  </Text>
                </View>
                <Text numberOfLines={1} style={{ fontSize: 8, color: COLORS.textSecondary, marginTop: 2 }}>{t('nftAlbum.privateFilterDesc')}</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Search and Sort Bar */}
        {nfts.length > 0 && (
          <View style={styles.searchSortBar}>
            <View style={styles.searchContainer}>
              <Feather name="search" size={18} color={COLORS.textSecondary} />
              <TextInput
                style={styles.searchInput}
                placeholder={t('nftAlbum.searchMemories')}
                placeholderTextColor={COLORS.textSecondary}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <Feather name="x" size={18} color={COLORS.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity
              style={styles.sortButton}
              onPress={() => setShowSortMenu(!showSortMenu)}
            >
              <Feather name="sliders" size={18} color={COLORS.primary} />
            </TouchableOpacity>
          </View>
        )}

        {/* Sort Menu Dropdown */}
        {showSortMenu && (
          <View style={styles.sortMenu}>
            {SORT_OPTIONS.map(option => (
              <TouchableOpacity
                key={option.key}
                style={[
                  styles.sortOption,
                  sortBy === option.key && styles.sortOptionActive
                ]}
                onPress={() => {
                  setSortBy(option.key);
                  setShowSortMenu(false);
                }}
              >
                <Feather
                  name={option.icon}
                  size={16}
                  color={sortBy === option.key ? COLORS.primary : COLORS.textSecondary}
                />
                <Text style={[
                  styles.sortOptionText,
                  sortBy === option.key && styles.sortOptionTextActive
                ]}>
                  {t(option.labelKey)}
                </Text>
                {sortBy === option.key && (
                  <Feather name="check" size={16} color={COLORS.primary} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Content */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>{t('nftAlbum.loadingNfts')}</Text>
          </View>
        ) : nfts.length === 0 ? (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Feather name="image" size={48} color={COLORS.textSecondary} />
            </View>
            <Text style={styles.emptyTitle}>{t('nftAlbum.noNftsYet')}</Text>
            <Text style={styles.emptyText}>
              {t('nftAlbum.mintFirstNft')}
            </Text>
            <TouchableOpacity
              style={styles.syncButton}
              onPress={scanWalletForNFTs}
              disabled={syncing}
            >
              {syncing ? (
                <ActivityIndicator size="small" color={COLORS.primary} />
              ) : (
                <>
                  <Feather name="search" size={18} color={COLORS.primary} />
                  <Text style={styles.syncButtonText}>{t('nftAlbum.scanWallet')}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 8 + bottomInset }]}
            bounces={false}
          >
            {/* Results count */}
            {searchQuery.length > 0 && (
              <Text style={styles.resultsCount}>
                {visibleCount} result{visibleCount !== 1 ? 's' : ''} found
              </Text>
            )}

            {/* NFT Grid - key forces complete re-render on page change to free memory */}
            <View key={`page-${currentPage}`} style={styles.gridContainer}>
              {displayedNFTs.map((item, index) => (
                <View key={item.mintAddress} style={styles.gridItem}>
                  {renderNFTCard({ item, index })}
                </View>
              ))}
            </View>

            {/* Pagination Controls */}
            {filteredNFTs.length > ITEMS_PER_PAGE && (
              <View style={[styles.paginationContainer, { marginBottom: 1 + bottomInset }]}>
                <TouchableOpacity
                  style={[styles.paginationButton, !hasPrev && styles.paginationButtonDisabled]}
                  onPress={goToPrevPage}
                  disabled={!hasPrev}
                >
                  <Feather name="chevron-left" size={24} color={hasPrev ? COLORS.primary : COLORS.textSecondary} />
                  <Text style={[styles.paginationText, !hasPrev && styles.paginationTextDisabled]}>{t('nftAlbum.prev')}</Text>
                </TouchableOpacity>

                <Text style={styles.paginationInfo}>
                  {currentPage + 1} / {totalPages}
                </Text>

                <TouchableOpacity
                  style={[styles.paginationButton, !hasNext && styles.paginationButtonDisabled]}
                  onPress={goToNextPage}
                  disabled={!hasNext}
                >
                  <Text style={[styles.paginationText, !hasNext && styles.paginationTextDisabled]}>{t('nftAlbum.next')}</Text>
                  <Feather name="chevron-right" size={24} color={hasNext ? COLORS.primary : COLORS.textSecondary} />
                </TouchableOpacity>
              </View>
            )}

            {/* No results */}
            {filteredNFTs.length === 0 && searchQuery.length > 0 && (
              <View style={styles.noResults}>
                <Feather name="search" size={40} color={COLORS.textSecondary} />
                <Text style={styles.noResultsText}>No memories match "{searchQuery}"</Text>
              </View>
            )}
          </ScrollView>
        )}

        {/* Detail modal */}
        {renderDetailModal()}

        {/* Burn-in-progress overlay (shown while DAS proof fetch + wallet sign + send + confirm) */}
        {burning && (
          <View style={styles.brandedOverlay} pointerEvents="auto">
            <View style={[styles.brandedOverlayCard, { alignItems: 'center' }]}>
              <GradientSpinner size={72} />
              <Text style={[styles.brandedOverlayTitle, { marginTop: 14 }]}>
                {cooldownSeconds > 0
                  ? `Cooldown before next burn (${batchProgress?.current || 0} / ${batchProgress?.total || 0})`
                  : batchProgress ? `Burning ${batchProgress.current} / ${batchProgress.total}…` : 'Burning NFT…'}
              </Text>
              <Text style={[styles.brandedOverlaySubtitle, { marginTop: 4, opacity: 0.8 }]}>
                Each NFT takes roughly ~30 seconds to burn.
              </Text>
              <Text style={styles.brandedOverlaySubtitle}>
                {stopAfterCurrentRequested
                  ? 'Stop requested. No more selected NFTs will be burned after the current operation finishes.'
                  : cooldownSeconds > 0
                  ? 'Letting the Merkle tree update on-chain to avoid stale-proof errors.'
                  : burnPhaseRef.current === 'wallet'
                  ? 'Approve the wallet request to sign the burn transaction.'
                  : burnPhaseRef.current === 'confirming'
                  ? 'Wallet approved. Confirming the burn transaction on Solana.'
                  : batchProgress
                  ? 'Preparing cNFT proof and wallet request.'
                  : 'Preparing transaction and waiting for wallet approval. Please don\'t close the app.'}
              </Text>
              {batchProgress && batchProgress.total > 1 && (
                <TouchableOpacity
                  style={[styles.purchaseAlertButton, styles.purchaseAlertButtonPrimary, { marginTop: 14, minWidth: 150 }]}
                  onPress={() => {
                    cancelBurnRef.current = true;
                    setStopAfterCurrentRequested(true);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.purchaseAlertButtonText, styles.purchaseAlertButtonPrimaryText]}>
                    {stopAfterCurrentRequested ? 'Stopping…' : 'Stop after current'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Selection-mode bottom action bar */}
        {selectionMode && !burning && (
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: bottomInset, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(15,15,18,0.96)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ color: COLORS.textSecondary, fontSize: 13, flex: 1 }}>
              {selectedIds.size} selected
            </Text>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: selectedIds.size > 0 ? 'rgba(255,69,58,0.15)' : 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: selectedIds.size > 0 ? 'rgba(255,69,58,0.5)' : 'rgba(255,255,255,0.12)', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 18, gap: 8 }}
              onPress={handleBatchBurn}
              activeOpacity={0.7}
              disabled={selectedIds.size === 0}
            >
              <Feather name="trash-2" size={16} color={selectedIds.size > 0 ? '#FF453A' : 'rgba(255,255,255,0.35)'} />
              <Text style={{ color: selectedIds.size > 0 ? '#FF453A' : 'rgba(255,255,255,0.35)', fontWeight: '700', fontSize: 14 }}>
                Burn{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Dark Alert Modal */}
        {darkAlert && (
          <View style={styles.brandedOverlay}>
            <View style={styles.brandedOverlayCard}>
              <Text style={styles.brandedOverlayTitle}>{darkAlert.title}</Text>
              <Text style={styles.brandedOverlaySubtitle}>{darkAlert.message}</Text>
              {alertCheckbox && (
                <TouchableOpacity
                  style={styles.darkAlertCheckboxRow}
                  onPress={() => {
                    const nextValue = !alertCheckboxValueRef.current;
                    alertCheckboxValueRef.current = nextValue;
                    setAlertCheckbox(prev => (prev ? { ...prev, value: nextValue } : prev));
                  }}
                  activeOpacity={0.85}
                >
                  <View style={styles.darkAlertCheckboxBox}>
                    <Feather name={alertCheckbox.value ? 'check-square' : 'square'} size={20} color={alertCheckbox.value ? '#A78BFA' : '#9898B0'} />
                  </View>
                  <Text style={styles.darkAlertCheckboxLabel}>{alertCheckbox.label}</Text>
                </TouchableOpacity>
              )}
              <View style={styles.darkAlertButtons}>
                {darkAlert.buttons.map((btn, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={[
                      styles.purchaseAlertButton,
                      idx === darkAlert.buttons.length - 1 && styles.purchaseAlertButtonPrimary,
                    ]}
                    onPress={btn.onPress}
                  >
                    <Text
                      style={[
                        styles.purchaseAlertButtonText,
                        idx === darkAlert.buttons.length - 1 && styles.purchaseAlertButtonPrimaryText,
                      ]}
                    >
                      {btn.text}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}
      </View>
    </View>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  fullOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0,
    paddingBottom: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1.5,
    borderBottomColor: 'rgba(167,139,250,0.1)',
    paddingTop: 14,
  },
  closeButton: {
    padding: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '900',
    color: COLORS.text,
    marginHorizontal: 8,
    letterSpacing: -0.3,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
  },
  filterToggleBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  filterToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 22,
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderColor: 'rgba(167,139,250,0.1)',
    overflow: 'hidden',
  },
  filterToggleActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  filterToggleText: {
    fontSize: 12,
    fontWeight: '500',
    color: COLORS.textSecondary,
    flexShrink: 1,
  },
  filterToggleTextActive: {
    color: '#F4F4F8',
  },
  nftCount: {
    fontSize: 14,
    color: COLORS.textSecondary,
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
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: COLORS.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  syncButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.primary,
  },
  // Header center
  headerCenter: {
    alignItems: 'center',
  },
  headerSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },

  // Search and Sort
  searchSortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
    backgroundColor: COLORS.background,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 7,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
    paddingVertical: 0,
  },
  sortButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sortMenu: {
    backgroundColor: COLORS.surface,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  sortOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  sortOptionActive: {
    backgroundColor: `${COLORS.primary}15`,
  },
  sortOptionText: {
    flex: 1,
    fontSize: 15,
    color: COLORS.textSecondary,
  },
  sortOptionTextActive: {
    color: COLORS.primary,
    fontWeight: '500',
  },

  // ScrollView
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  resultsCount: {
    fontSize: 13,
    color: COLORS.textSecondary,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },

  // Grid
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  gridItem: {
    width: '50%',
    paddingHorizontal: 6,
    marginBottom: 16,
  },

  // Premium 3D Card - 2 columns
  nftCard: {
    position: 'relative',
    height: CARD_HEIGHT,
  },
  cardShadow3: {
    position: 'absolute',
    bottom: -4,
    left: 4,
    right: 4,
    height: '100%',
    backgroundColor: 'rgba(108, 92, 231, 0.12)',
    borderRadius: 14,
  },
  cardShadow2: {
    position: 'absolute',
    bottom: -2,
    left: 2,
    right: 2,
    height: '100%',
    backgroundColor: 'rgba(108, 92, 231, 0.18)',
    borderRadius: 12,
  },
  cardShadow1: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '100%',
    backgroundColor: COLORS.surface,
    borderRadius: 12,
  },
  cardMain: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 4,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(108, 92, 231, 0.25)',
  },
  nftImage: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: COLORS.background,
  },
  noImagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
  },
  noImageText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 8,
  },
  cardGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
    backgroundColor: 'transparent',
    backgroundImage: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
  },
  cardInfo: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 6,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  nftName: {
    fontSize: 10,
    fontWeight: '700',
    color: '#F4F4F8',
    marginBottom: 2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  nftDate: {
    fontSize: 8,
    color: 'rgba(255,255,255,0.7)',
  },
  solanaBadge: {
    minWidth: 16,
    minHeight: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(108, 92, 231, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 2,
  },

  // Pagination
  paginationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 1,
    marginBottom: 1,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
  },
  paginationButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  paginationButtonDisabled: {
    opacity: 0.4,
  },
  paginationText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.primary,
  },
  paginationTextDisabled: {
    color: COLORS.textSecondary,
  },
  paginationInfo: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.text,
  },

  // No Results
  noResults: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 16,
  },
  noResultsText: {
    fontSize: 15,
    color: COLORS.textSecondary,
  },
  nftBadge: {
    flexDirection: 'row',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: '#F4F4F8',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#F4F4F8',
  },

  // Detail modal
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'flex-end',
    zIndex: 100,
  },
  detailModal: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    flex: 1,
    marginTop: 40,
    paddingBottom: 0,
    minHeight: '90%', // Increased height to ensure all content is visible and scrollable
    overflow: 'hidden',
  },
  detailScrollView: {
    flex: 1,
  },
  detailScrollContent: {
    paddingBottom: 40,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  detailTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
    flex: 1,
  },
  detailImage: {
    width: '100%',
    height: 320,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  ownerSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  ownerAddress: {
    fontSize: 13,
    color: COLORS.primary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  uriSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  uriHint: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginBottom: 8,
    marginTop: -4,
  },
  uriCopyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  uriText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  descriptionSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  descriptionText: {
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 20,
  },
  exifSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  exifGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  exifItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  exifText: {
    fontSize: 13,
    color: COLORS.text,
  },
  verifySection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  verifyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  verifyButtonText: {
    fontSize: 14,
    color: COLORS.primary,
    fontWeight: '500',
  },
  verifyResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  verifySuccess: {
    backgroundColor: `${COLORS.accent}20`,
  },
  verifyFailed: {
    backgroundColor: `${COLORS.error}20`,
  },
  verifyText: {
    fontSize: 14,
    fontWeight: '500',
  },
  actionButtons: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
  },
  actionButtonText: {
    fontSize: 12,
    color: COLORS.text,
    fontWeight: '500',
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionButtonTextDisabled: {
    color: COLORS.textSecondary,
  },
  transferButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    margin: 16,
    paddingVertical: 14,
    backgroundColor: COLORS.primary,
    borderRadius: 16,
  },
  transferButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F4F4F8',
  },
  // Dark Alert styles
  darkAlertOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,1)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 9999,
    elevation: 9999,
  },
  darkAlertCard: {
    backgroundColor: '#0A0A14',
    borderRadius: 24,
    padding: 28,
    width: '100%',
    maxWidth: 340,
    borderWidth: 1.5,
    borderColor: 'rgba(167,139,250,0.15)',
  },
  darkAlertTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#F4F4F8',
    textAlign: 'center',
    marginBottom: 12,
  },
  darkAlertMessage: {
    fontSize: 14,
    color: '#9898B0',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  darkAlertCheckboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 20,
    padding: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(108,92,231,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.18)',
  },
  darkAlertCheckboxBox: {
    paddingTop: 1,
  },
  darkAlertCheckboxLabel: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: '#D5D5E6',
  },
  darkAlertButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  darkAlertButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 14,
    backgroundColor: 'rgba(108,92,231,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(108,92,231,0.35)',
    minWidth: 100,
  },
  darkAlertButtonPrimary: {
    backgroundColor: 'rgba(108,92,231,0.2)',
  },
  darkAlertButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#A78BFA',
  },
  brandedOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 9999,
    elevation: 9999,
  },
  brandedOverlayCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#1E1E1E',
    borderRadius: 22,
    paddingVertical: 28,
    paddingHorizontal: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  brandedOverlayTitle: {
    color: '#F4F4F8',
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  brandedOverlaySubtitle: {
    color: '#CCC',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 14,
    textAlign: 'center',
  },
  brandedOverlayButton: {
    backgroundColor: 'rgba(0,255,163,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.28)',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 14,
    alignItems: 'center',
    minWidth: 150,
  },
  brandedOverlayButtonText: {
    color: '#00FFA3',
    fontWeight: '800',
    fontSize: 14,
  },
  purchaseAlertButton: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 14,
    alignItems: 'center',
    minWidth: 110,
  },
  purchaseAlertButtonPrimary: {
    backgroundColor: 'rgba(108,92,231,0.12)',
    borderColor: 'rgba(108,92,231,0.3)',
  },
  purchaseAlertButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  purchaseAlertButtonPrimaryText: {
    color: '#A78BFA',
  },
  burnTimerText: {
    fontSize: 44,
    fontWeight: '900',
    color: '#00FFA3',
    marginBottom: 4,
    letterSpacing: -1,
  },
  darkAlertButtonTextPrimary: {
    color: '#A78BFA',
  },
});

export default NFTGallery;
