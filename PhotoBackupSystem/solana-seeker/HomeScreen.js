/**
 * HomeScreen.js
 * 
 * Premium Home UI with bottom tab navigation.
 * 4 tabs: Home (Backup/Sync), Info (Plans/Usage), Docs (How it works), Settings.
 * Dark glass aesthetic with premium palette. Fits all screen sizes.
 */

import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ScrollView,
  Platform,
  StatusBar,
  useWindowDimensions,
  Animated,
  LayoutAnimation,
  UIManager,
} from 'react-native';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { t } from './i18n';
import { GradientSpinner } from './uiComponents';
import { SKR_TOKEN_SYMBOL } from './nftOperations';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCREEN_HEIGHT_FULL = Dimensions.get('screen').height;
const ANDROID_NAV_BAR_HEIGHT = Platform.OS === 'android' ? Math.max(48, SCREEN_HEIGHT_FULL - SCREEN_HEIGHT) : 0;
const MIN_DIMENSION = Math.min(SCREEN_WIDTH, SCREEN_HEIGHT);

const isVerySmallPhone = MIN_DIMENSION < 340;
const isSmallPhone = MIN_DIMENSION >= 340 && MIN_DIMENSION < 375;
const isMediumPhone = MIN_DIMENSION >= 375 && MIN_DIMENSION < 400;
const isLargePhone = MIN_DIMENSION >= 400 && MIN_DIMENSION < 600;
const isTablet = MIN_DIMENSION >= 600;
const isLargeTablet = MIN_DIMENSION >= 768;
const isShortScreen = SCREEN_HEIGHT < 700;
const isTallScreen = SCREEN_HEIGHT > 900;
const isAndroid = Platform.OS === 'android';

const scale = (size) => {
  let r = size;
  if (isLargeTablet) r = size * 1.3;
  else if (isTablet) r = size * 1.15;
  else if (isVerySmallPhone) r = size * 0.78;
  else if (isSmallPhone) r = size * 0.85;
  else if (isMediumPhone) r = size * 0.92;
  if (isShortScreen) r *= 0.9;
  return r;
};

const scaleStatus = (size) => {
  if (isShortScreen) return size * 0.55;
  if (isVerySmallPhone) return size * 0.65;
  if (isSmallPhone) return size * 0.7;
  if (isMediumPhone) return size * 0.82;
  if (isLargeTablet) return size * 1.3;
  if (isTablet) return size * 1.15;
  return size;
};

const scaleSpacing = (size) => {
  let r = size;
  if (isLargeTablet) r = size * 1.2;
  else if (isTablet) r = size * 1.1;
  else if (isVerySmallPhone) r = size * 0.6;
  else if (isSmallPhone) r = size * 0.7;
  else if (isMediumPhone) r = size * 0.8;
  else r = size * 0.9;
  if (isShortScreen) r *= 0.75;
  return r;
};

// Premium dark palette
const COLORS = {
  primary: '#6C5CE7',    // Rich purple
  secondary: '#00FFA3',  // Mint
  accent: '#FF1493',     // Soft violet
  nft: '#6C5CE7',        // Authenticity purple
  gold: '#F5C842',       // Premium gold accent
  bg: '#030308',         // Deep black
  card: '#0A0A14',       // Dark card
  cardLight: '#12121E',  // Slightly lighter
  cardElevated: '#181828', // Elevated surface
  border: 'rgba(167,139,250,0.12)', // Violet border
  borderLight: 'rgba(167,139,250,0.18)', // Lighter violet border
  text: '#EEEEF6',       // Off-white
  textMuted: '#7676A0',  // Muted
  textDim: '#5C5C80',    // Dim
  tabBar: '#050510',     // Tab bar bg
  tabBarBorder: 'rgba(167,139,250,0.06)', // Tab bar top border
};

// ─── TAB DEFINITIONS ────────────────────────────────────────────────
const TAB_DEFS = [
  { key: 'home',     icon: 'image',      labelKey: 'home.home',     color: COLORS.primary },
  { key: 'info',     icon: 'info',       labelKey: 'home.info',     color: COLORS.primary },
  { key: 'docs',     icon: 'book-open',  labelKey: 'home.docs',     color: COLORS.primary },
  { key: 'settings', icon: 'settings',   labelKey: 'home.settings', color: COLORS.primary },
];

// Tab bar height (including bottom safe area on Android)
const TAB_BAR_HEIGHT = scale(72);
const TAB_BAR_TOTAL = TAB_BAR_HEIGHT;

// ─── ANIMATED PRESSABLE (scale on press) ────────────────────────────
const AnimatedPressable = ({ children, style, onPress, onLongPress, delayLongPress, disabled, activeOpacity = 0.9 }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, { toValue: 0.965, useNativeDriver: true, speed: 50, bounciness: 4 }).start();
  }, []);
  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
  }, []);
  const flat = StyleSheet.flatten(style) || {};
  const { flex, width, height, alignSelf, ...innerStyle } = flat;
  const outerStyle = {};
  if (flex !== undefined) outerStyle.flex = flex;
  if (width !== undefined) outerStyle.width = width;
  if (height !== undefined) outerStyle.height = height;
  if (alignSelf !== undefined) outerStyle.alignSelf = alignSelf;
  const needsStretch = alignSelf === 'stretch';
  return (
    <TouchableOpacity style={outerStyle} onPress={onPress} onLongPress={onLongPress} delayLongPress={delayLongPress} disabled={disabled} activeOpacity={activeOpacity}
      onPressIn={handlePressIn} onPressOut={handlePressOut}>
      <Animated.View style={[innerStyle, needsStretch && { flex: 1 }, { transform: [{ scale: scaleAnim }] }]}>{children}</Animated.View>
    </TouchableOpacity>
  );
};

// ─── GLOW CARD (gradient border + shadow) ───────────────────────────
const GlowCard = ({ children, style, glowColor, gradientColors }) => {
  const colors = gradientColors || [`${glowColor || COLORS.primary}08`, `${glowColor || COLORS.primary}03`];
  return (
    <View style={[styles.glowCardOuter, style, glowColor && !isAndroid && { shadowColor: glowColor }]}>
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.glowCardGradient}>
        {children}
      </LinearGradient>
    </View>
  );
};

// ─── SECTION HEADER (gradient dot + premium typography) ─────────────
const SectionHeader = ({ icon, title, color, onInfoPress }) => (
  <View style={styles.sectionHeader}>
    <LinearGradient colors={[color, `${color}80`]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.sectionHeaderDot} />
    <Text style={[styles.sectionHeaderTitle, { color }]}>{title}</Text>
    {onInfoPress && (
      <TouchableOpacity onPress={onInfoPress} activeOpacity={0.7} style={{ marginLeft: scaleSpacing(6) }}>
        <Feather name="info" size={scale(14)} color={color} />
      </TouchableOpacity>
    )}
  </View>
);


export const HomeScreen = ({
  appDisplayName,
  serverType,
  status,
  progress,
  progressAction,
  loading,
  glassModeEnabled,
  infoContent,
  settingsContent,
  docsContent,
  onLogout,
  onCleanBestMatches,
  onCleanSimilar,
  onBackupAll,
  onLongPressBackup,
  onBackupSelected,
  onSyncAll,
  onLongPressSync,
  onSyncSelected,
  showCompletionTick,
  completionMessage,
  onDismissCompletionTick,
  onMintNFT,
  nftMinting = false,
  onViewNFTs,
  onViewCertificates,
  onOpenDevicePairing,
  canPairDevices = false,
  onTabChange,
  activeTab: activeTabProp,
  qsEmail,
  qsWalletAddress,
  qsNftCount,
  qsLastBackupTime,
  nftWeeklyDiscountPercent = 0,
  nftHomeSkrFeeQuote = null,
  nftFeesWaived = false,
  isPremiumFreeMint = false,
  isPremiumBeyond100 = false,
  isMonthlySubscriber = false,
  isPairedAccount,
  appVersion,
  showDarkAlert,
}) => {
  const activeTab = activeTabProp || 'home';
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bottomInset = isAndroid ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT) : insets.bottom;
  const tabContentPaddingBottom = scaleSpacing(16) + TAB_BAR_TOTAL + bottomInset;
  const tabBarPaddingBottom = scaleSpacing(6) + bottomInset;

  // Flip animation refs for footer icons (one per tab)
  const tabFlipValues = useRef(TAB_DEFS.map(() => new Animated.Value(0))).current;
  const triggerTabFlip = (index) => {
    const val = tabFlipValues[index];
    val.setValue(0);
    Animated.sequence([
      Animated.timing(val, { toValue: 180, duration: 220, useNativeDriver: true }),
      Animated.timing(val, { toValue: 360, duration: 220, useNativeDriver: true }),
    ]).start();
  };

  // Tap-to-toggle collapse for quick-stats (no scroll-driven bounce)
  const [qsCollapsed, setQsCollapsed] = useState(false);
  const qsExpandedOpacity = useRef(new Animated.Value(1)).current;
  const qsCollapsedOpacity = useRef(new Animated.Value(0)).current;
  const nftDiscountPercent = Math.min(80, Math.max(0, Number(nftWeeklyDiscountPercent || 0)));
  const nftHomeSkrAmount = nftHomeSkrFeeQuote?.tokenAmountFormatted
    ? `${nftHomeSkrFeeQuote.tokenAmountFormatted} ${SKR_TOKEN_SYMBOL}`
    : `Live ${SKR_TOKEN_SYMBOL}`;
  const nftHomeSkrUsd = Number.isFinite(Number(nftHomeSkrFeeQuote?.discountedUsd))
    ? `$${Number(nftHomeSkrFeeQuote.discountedUsd).toFixed(3)}`
    : 'live fee';

  const handleSolanaNftInfo = useCallback(() => {
    showDarkAlert?.('Web3 Album', 'Create a tamper-proof Web3 album. Each photo gets an on-chain authenticity record proving ownership of the original, with a bound timestamp and blockchain hook.');
  }, [showDarkAlert]);

  const QS_EXPANDED = scale(100);
  const QS_COLLAPSED = scale(36);

  const toggleQsCollapse = useCallback(() => {
    const next = !qsCollapsed;
    LayoutAnimation.configureNext(LayoutAnimation.create(250, 'easeInEaseOut', 'opacity'));
    setQsCollapsed(next);
    Animated.parallel([
      Animated.timing(qsExpandedOpacity, { toValue: next ? 0 : 1, duration: 200, useNativeDriver: true }),
      Animated.timing(qsCollapsedOpacity, { toValue: next ? 1 : 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [qsCollapsed]);

  const serverLabel = serverType === 'stealthcloud' ? 'StealthCloud' : serverType === 'remote' ? t('home.remoteServer') : t('home.localServer');
  const serverIcon = serverType === 'stealthcloud' ? 'cloud' : serverType === 'remote' ? 'globe' : 'wifi';

  // Status detection
  const isBackingUp = progressAction === 'backup';
  const isSyncing = progressAction === 'sync';
  const isCleaning = progressAction === 'cleanup';
  const isCertifying = progressAction === 'nft';
  const isIdle = !isBackingUp && !isSyncing && !isCleaning && !isCertifying;
  const isFetching = loading && isIdle;

  const progressPercent = Math.min(Math.max(progress, 0), 1) * 100;
  const showProgress = progressPercent > 0 && !isFetching && !isIdle;

  const getStatusColor = () => {
    if (isCertifying) return '#0099FF'; // Blue for certify
    if (isCleaning) return COLORS.accent; // Magenta for clean duplicates
    if (isSyncing) return COLORS.secondary; // Green for sync
    if (isBackingUp) return COLORS.secondary; // Green for backup
    if (loading) return COLORS.secondary;
    if (isIdle) return COLORS.secondary;
    return COLORS.secondary;
  };
  const statusColor = getStatusColor();

  // ─── COLLAPSIBLE QUICK-STATS BAR (always visible above scroll) ──
  const renderQuickStatsBar = () => {
    if (activeTabProp !== 'home') return null;

    const isActive = !isIdle && !isFetching;
    const operationLabel = isCertifying ? t('home.mintingNft') : isCleaning ? t('home.scanning') : isSyncing ? t('home.syncing') : t('home.backingUp');

    return (
      <View style={styles.qsBarWrap}>
        <LinearGradient colors={['rgba(255,255,255,0.035)', 'rgba(255,255,255,0.018)']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.qsBarGradient}>
          <LinearGradient colors={['rgba(255,255,255,0.035)', 'transparent']}
            start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />

          {/* 2×2 grid — always visible */}
          <View style={{ paddingVertical: scaleSpacing(4), paddingHorizontal: scaleSpacing(10) }}>
            <View style={styles.qsRow}>
              <View style={styles.qsCell}>
                <View style={[styles.qsIcon, { backgroundColor: isPairedAccount ? '#F59E0B18' : `${COLORS.primary}18` }]}>
                  <Feather name={isPairedAccount ? 'link' : 'user'} size={scale(13)} color={isPairedAccount ? '#F59E0B' : COLORS.primary} />
                </View>
                <View style={styles.qsText}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={styles.qsLabel}>{t('home.qsAccount')}</Text>
                    {isPairedAccount && (
                      <View style={{ backgroundColor: '#F59E0B', borderRadius: scale(3), paddingHorizontal: scale(4), paddingVertical: scale(1), marginLeft: scale(5) }}>
                        <Text style={{ color: '#000', fontSize: scale(8), fontWeight: '800', letterSpacing: 0.5 }}>{t('home.qsPaired') || 'PAIRED'}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.qsValue, isPairedAccount && { color: '#F59E0B' }]} numberOfLines={1}>{qsEmail || '—'}</Text>
                </View>
              </View>
              <View style={[styles.qsCell, styles.qsCellRight]}>
                <View style={[styles.qsIcon, { backgroundColor: `${COLORS.nft}18` }]}>
                  <View style={[styles.qsDot, { backgroundColor: COLORS.nft }]} />
                </View>
                <View style={styles.qsText}>
                  <Text style={styles.qsLabel}>{t('home.qsServer')}</Text>
                  <Text style={styles.qsValue} numberOfLines={1}>{serverLabel}</Text>
                </View>
              </View>
            </View>
            <View style={styles.qsRow}>
              <View style={styles.qsCell}>
                <View style={[styles.qsIcon, { backgroundColor: 'rgba(99,102,241,0.15)' }]}>
                  <Feather name="cloud" size={scale(13)} color="#6366F1" />
                </View>
                <View style={styles.qsText}>
                  <Text style={styles.qsLabel}>{t('home.qsLastBackup')}</Text>
                  <Text style={styles.qsValue} numberOfLines={1}>{qsLastBackupTime || '—'}</Text>
                </View>
              </View>
              <View style={[styles.qsCell, styles.qsCellRight]}>
                <View style={[styles.qsIcon, { backgroundColor: `${COLORS.nft}18` }]}>
                  <Feather name="shield" size={scale(13)} color={COLORS.nft} />
                </View>
                <View style={styles.qsText}>
                  <Text style={styles.qsLabel}>{t('home.qsNfts')}</Text>
                  <Text style={styles.qsValue} numberOfLines={1}>{qsNftCount != null ? String(qsNftCount) : '—'}</Text>
                </View>
              </View>
            </View>
          </View>

          {/* Progress overlay — sits on top of stats during active operations */}
          {isActive && (
            <View style={styles.heroOverlay}>
              <View style={[StyleSheet.absoluteFill, { backgroundColor: COLORS.card }]} />
              <LinearGradient colors={[`${statusColor}30`, `${statusColor}08`]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              <View style={styles.heroTopRow}>
                <View style={styles.heroSpinnerWrap}>
                  <GradientSpinner size={scale(28)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.heroTitle, { color: statusColor }]} numberOfLines={1}>{operationLabel}</Text>
                  {status ? <Text style={styles.heroStatus} numberOfLines={1}>{status}</Text> : null}
                </View>
                {showProgress ? (
                  <Text style={[styles.heroPct, { color: statusColor }]}>{Math.round(progressPercent)}%</Text>
                ) : null}
              </View>
              {showProgress ? (
                <View style={styles.heroTrack}>
                  <LinearGradient colors={[statusColor, `${statusColor}BB`]}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={[styles.heroFill, { width: `${progressPercent}%` }]} />
                </View>
              ) : (
                <View style={styles.heroTrack} />
              )}
            </View>
          )}
        </LinearGradient>
      </View>
    );
  };

  // ─── TAB: HOME ──────────────────────────────────────────────────
  const renderHomeTab = () => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.tabContent, { paddingBottom: tabContentPaddingBottom }]} showsVerticalScrollIndicator={false}>
      <SectionHeader icon="cloud" title={t('home.backupSync')} color={COLORS.secondary} onInfoPress={() => showDarkAlert?.('Cloud Backup & Sync', 'Backup uploads your photos to encrypted cloud storage. Sync restores them to this device. Long-press either button to clear its history.')} />

      {/* Backup — single button with zigzag separator */}
      <View style={[styles.primaryBtn, loading && styles.disabled, isAndroid ? { elevation: 2 } : { shadowColor: COLORS.secondary, shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }]}>
        <LinearGradient colors={['rgba(0,255,163,0.16)', 'rgba(0,255,163,0.045)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.primaryBtnGrad, { paddingVertical: scaleSpacing(24) }]}>
          <AnimatedPressable
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' }}
            onPress={onBackupAll}
            onLongPress={onLongPressBackup}
            delayLongPress={2000}
            disabled={loading}
          >
            <View style={styles.primaryBtnIcon}>
              <Feather name="upload-cloud" size={scale(24)} color="#FFF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.primaryBtnTitle}>{t('home.backupAll')}</Text>
            </View>
          </AnimatedPressable>
          <View style={{ alignItems: 'center', justifyContent: 'center', width: scale(16), marginHorizontal: scaleSpacing(4) }}>
            {[0,1,2,3].map(i => (
              <View key={i} style={{ width: scale(6), height: scale(6), backgroundColor: 'rgba(180,180,200,0.45)', transform: [{ rotate: '45deg' }], marginVertical: scale(2) }} />
            ))}
          </View>
          <AnimatedPressable
            style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: scaleSpacing(8), alignSelf: 'stretch' }}
            onPress={onBackupSelected}
            disabled={loading}
          >
            <Feather name="check-square" size={scale(16)} color={COLORS.secondary} />
            <Text style={{ fontSize: scale(10), fontWeight: '700', color: COLORS.secondary, marginTop: scaleSpacing(3) }}>{t('home.select')}</Text>
          </AnimatedPressable>
        </LinearGradient>
      </View>

      {/* Sync — single button with zigzag separator */}
      <View style={[styles.primaryBtn, loading && styles.disabled, isAndroid ? { elevation: 2 } : { shadowColor: COLORS.secondary, shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }]}>
        <LinearGradient colors={['rgba(0,255,163,0.12)', 'rgba(255,255,255,0.035)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.primaryBtnGrad, { paddingVertical: scaleSpacing(24) }]}>
          <AnimatedPressable
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' }}
            onPress={onSyncAll}
            onLongPress={onLongPressSync}
            delayLongPress={2000}
            disabled={loading}
          >
            <View style={styles.primaryBtnIcon}>
              <Feather name="download-cloud" size={scale(24)} color="#FFF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.primaryBtnTitle}>{t('home.syncAll')}</Text>
            </View>
          </AnimatedPressable>
          <View style={{ alignItems: 'center', justifyContent: 'center', width: scale(16), marginHorizontal: scaleSpacing(4) }}>
            {[0,1,2,3].map(i => (
              <View key={i} style={{ width: scale(6), height: scale(6), backgroundColor: 'rgba(180,180,200,0.45)', transform: [{ rotate: '45deg' }], marginVertical: scale(2) }} />
            ))}
          </View>
          <AnimatedPressable
            style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: scaleSpacing(8), alignSelf: 'stretch' }}
            onPress={onSyncSelected}
            disabled={loading}
          >
            <Feather name="check-square" size={scale(16)} color={COLORS.secondary} />
            <Text style={{ fontSize: scale(10), fontWeight: '700', color: COLORS.secondary, marginTop: scaleSpacing(3) }}>{t('home.select')}</Text>
          </AnimatedPressable>
        </LinearGradient>
      </View>


      <SectionHeader icon="tool" title={t('home.cleanDuplicates') || 'CLEAN DUPLICATES'} color={COLORS.accent} onInfoPress={() => showDarkAlert?.('Photo & Video Cleanup', 'Find and remove duplicate photos and videos.\n\nExact Match: compares every photo and video on your device. Photos are matched by visual fingerprint (resistant to re-saving and minor edits). Videos are matched by exact file content. Identical copies are grouped for review.\n\nBurst Photos: groups visually similar shots so you can keep the best one. Only photos, not videos.')} />

      <View style={styles.actionRow}>
        <AnimatedPressable style={[styles.nftSubCard, loading && styles.disabled, { borderColor: `${COLORS.accent}40`, backgroundColor: `${COLORS.accent}12` }, isAndroid ? { elevation: 1 } : { shadowColor: COLORS.accent, shadowOpacity: 0.10, shadowRadius: 14 }]}
          onPress={onCleanBestMatches} disabled={loading}>
          <View style={styles.nftSubCardInner}>
            <View style={[styles.nftSubCardIconWrap, { backgroundColor: `${COLORS.accent}1A` }]}>
              <Feather name="trash-2" size={scale(22)} color={COLORS.accent} />
            </View>
            <Text style={styles.nftSubCardTitle}>{t('home.identical')}</Text>
            <Text style={styles.nftSubCardSub}>Exact duplicates</Text>
          </View>
        </AnimatedPressable>

        <AnimatedPressable style={[styles.nftSubCard, loading && styles.disabled, { borderColor: `${COLORS.accent}40`, backgroundColor: `${COLORS.accent}12` }, isAndroid ? { elevation: 1 } : { shadowColor: COLORS.accent, shadowOpacity: 0.10, shadowRadius: 14 }]}
          onPress={onCleanSimilar} disabled={loading}>
          <View style={styles.nftSubCardInner}>
            <View style={[styles.nftSubCardIconWrap, { backgroundColor: `${COLORS.accent}1A` }]}>
              <Feather name="layers" size={scale(22)} color={COLORS.accent} />
            </View>
            <Text style={styles.nftSubCardTitle}>{t('home.similar')}</Text>
            <Text style={styles.nftSubCardSub}>Burst photos</Text>
          </View>
        </AnimatedPressable>
      </View>


      {/* ── Authenticity Section ── */}
      <SectionHeader icon="shield" title={t('home.solanaNft') || 'WEB3 ALBUM'} color="#0099FF" onInfoPress={handleSolanaNftInfo} />

      <AnimatedPressable style={[styles.nftHeroCard, nftMinting && styles.disabled, { shadowColor: '#0099FF' }]}
        onPress={onMintNFT} disabled={nftMinting}>
        <LinearGradient colors={['rgba(0,153,255,0.13)', 'rgba(255,255,255,0.035)']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.nftHeroGrad}>
          <View style={styles.nftHeroIconWrap}>
            <Feather name="hexagon" size={scale(32)} color="#FFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.nftHeroTitle}>{t('home.createNft')}</Text>
          </View>
          <View style={styles.nftHeroBadge}>
            {isPremiumFreeMint ? (
              <>
                <Text style={styles.nftHeroBadgeText}>100 FREE</Text>
                <Text style={styles.nftHeroBadgeDiscountText}>INCLUDED</Text>
                <Text style={styles.nftHeroBadgeSubText}>premium</Text>
              </>
            ) : isPremiumBeyond100 ? (
              <>
                <Text style={styles.nftHeroBadgeText}>$0.02</Text>
                <Text style={styles.nftHeroBadgeDiscountText}>USDC</Text>
                <Text style={styles.nftHeroBadgeSubText}>per mint</Text>
              </>
            ) : isMonthlySubscriber ? (
              <>
                <Text style={styles.nftHeroBadgeText}>{nftHomeSkrAmount}</Text>
                <Text style={styles.nftHeroBadgeDiscountText}>80% OFF</Text>
                <Text style={styles.nftHeroBadgeSubText}>active plan</Text>
              </>
            ) : nftFeesWaived ? (
              <>
                <Text style={styles.nftHeroBadgeText}>{nftHomeSkrAmount}</Text>
                <Text style={styles.nftHeroBadgeDiscountText}>80% OFF</Text>
                <Text style={styles.nftHeroBadgeSubText}>subscriber</Text>
              </>
            ) : (
              <>
                <Text style={styles.nftHeroBadgeText}>{nftHomeSkrAmount}</Text>
                <Text style={styles.nftHeroBadgeDiscountText}>{nftDiscountPercent > 0 ? `${nftDiscountPercent}% OFF` : 'LIVE FEE'}</Text>
                <Text style={styles.nftHeroBadgeSubText}>{nftHomeSkrUsd}</Text>
              </>
            )}
          </View>
        </LinearGradient>
      </AnimatedPressable>

      <View style={styles.actionRow}>
        <AnimatedPressable style={[styles.nftSubCard, isAndroid ? { elevation: 1 } : { shadowColor: '#0099FF', shadowOpacity: 0.08, shadowRadius: 12 }]}
          onPress={onViewNFTs}>
          <View style={styles.nftSubCardInner}>
            <View style={styles.nftSubCardIconWrap}>
              <Feather name="image" size={scale(22)} color="#0099FF" />
            </View>
            <Text style={styles.nftSubCardTitle}>{t('home.album')}</Text>
            <Text style={styles.nftSubCardSub}>Browse collection</Text>
          </View>
        </AnimatedPressable>

        <AnimatedPressable style={[styles.nftSubCard, isAndroid ? { elevation: 1 } : { shadowColor: '#0099FF', shadowOpacity: 0.08, shadowRadius: 12 }]}
          onPress={onViewCertificates}>
          <View style={styles.nftSubCardInner}>
            <View style={styles.nftSubCardIconWrap}>
              <Feather name="award" size={scale(22)} color="#0099FF" />
            </View>
            <Text style={styles.nftSubCardTitle}>{t('home.viewCerts')}</Text>
            <Text style={styles.nftSubCardSub}>Authenticity records</Text>
          </View>
        </AnimatedPressable>
      </View>
    </ScrollView>
  );

  // ─── TAB: TOOLS (AI Detector only — Clean Dups moved to Home) ──
  const renderToolsTab = () => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.tabContent, { paddingBottom: tabContentPaddingBottom }]} showsVerticalScrollIndicator={false}>
      <SectionHeader icon="cpu" title={t('home.aiDetector')} color={COLORS.gold} />
      <GlowCard glowColor={COLORS.gold} gradientColors={[`${COLORS.gold}08`, COLORS.card]}>
        <View style={styles.comingSoonCard}>
          <LinearGradient colors={[`${COLORS.gold}20`, `${COLORS.gold}08`]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.comingSoonIcon}>
            <Feather name="cpu" size={scale(28)} color={COLORS.gold} />
          </LinearGradient>
          <Text style={[styles.comingSoonTitle, { textShadowColor: `${COLORS.gold}30`, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: isAndroid ? 2 : 8 }]}>{t('home.aiDetectorTitle')}</Text>
        </View>
      </GlowCard>
    </ScrollView>
  );

  // ─── TAB: SHARE ─────────────────────────────────────────────────
  const renderShareTab = () => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.tabContent, { paddingBottom: tabContentPaddingBottom }]} showsVerticalScrollIndicator={false}>
      <SectionHeader icon="send" title={t('home.p2pSharing')} color={COLORS.secondary} />
      <GlowCard glowColor={COLORS.secondary} gradientColors={[`${COLORS.secondary}08`, COLORS.card]}>
        <View style={styles.comingSoonCard}>
          <LinearGradient colors={[`${COLORS.secondary}20`, `${COLORS.secondary}08`]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.comingSoonIcon}>
            <Feather name="lock" size={scale(28)} color={COLORS.secondary} />
          </LinearGradient>
          <Text style={[styles.comingSoonTitle, { textShadowColor: `${COLORS.secondary}30`, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: isAndroid ? 2 : 8 }]}>{t('home.p2pSharingTitle')}</Text>
        </View>
      </GlowCard>
    </ScrollView>
  );

  // ─── RENDER ─────────────────────────────────────────────────────
  const renderTabContent = () => {
    switch (activeTab) {
      case 'home':  return renderHomeTab();
      case 'info':  return infoContent || null;
      case 'docs':  return docsContent || null;
      case 'settings': return settingsContent || null;
      default:      return renderHomeTab();
    }
  };

  return (
    <View style={styles.container}>
      {/* ── HEADER — gradient border (hidden on info/settings tabs — they have their own) ── */}
      {activeTab === 'home' && (
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: scaleSpacing(6) }}>
              <Text style={styles.appName}>{appDisplayName}</Text>
              {appVersion ? <Text style={styles.versionBadge}>v{appVersion}</Text> : null}
            </View>
          </View>
          <View style={styles.headerActions}>
            {canPairDevices ? (
              <TouchableOpacity onPress={onOpenDevicePairing} style={styles.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="link" size={scale(17)} color={COLORS.textMuted} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={onLogout} style={styles.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="log-out" size={scale(17)} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
          <LinearGradient colors={['transparent', `${COLORS.border}60`, 'transparent']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth }} />
        </View>
      )}

      {/* ── COLLAPSIBLE QUICK-STATS (home tab only) ── */}
      {activeTab === 'home' && renderQuickStatsBar()}

      {/* ── TAB CONTENT ── */}
      <View style={{ flex: 1 }}>
        {renderTabContent()}
      </View>

      {/* ── BOTTOM TAB BAR — glass effect ── */}
      <LinearGradient colors={[`${COLORS.tabBar}E0`, COLORS.tabBar]}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={[styles.tabBar, { paddingBottom: tabBarPaddingBottom }]}>
        <LinearGradient colors={['transparent', `${COLORS.tabBarBorder}50`, 'transparent']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth }} />
        {TAB_DEFS.map((tab, index) => {
          const active = activeTab === tab.key;
          const flipRotate = tabFlipValues[index].interpolate({
            inputRange: [0, 360],
            outputRange: ['0deg', '360deg'],
          });
          const showRunningDot = tab.key === 'home' && !isIdle && !active;
          const runningColor = isCleaning ? COLORS.accent : isCertifying ? '#0099FF' : COLORS.secondary;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tabItem, active && { backgroundColor: `${tab.color}18`, borderTopWidth: 2, borderTopColor: tab.color }]}
              onPress={() => { triggerTabFlip(index); onTabChange?.(tab.key); }}
              activeOpacity={0.7}
            >
              <Animated.View style={[styles.tabIconWrap, { transform: [{ rotateY: flipRotate }] }]}>
                <Feather name={tab.icon} size={scale(22)} color={active ? tab.color : COLORS.textDim} />
                {showRunningDot && (
                  <View style={[styles.tabRunningDot, { backgroundColor: runningColor }]} />
                )}
              </Animated.View>
              <Text style={[styles.tabLabel, { color: active ? tab.color : COLORS.textDim }, active && { fontWeight: '700' }]}>
                {t(tab.labelKey)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </LinearGradient>

      {/* ── COMPLETION OVERLAY ── */}
      {showCompletionTick && (
        <TouchableOpacity style={styles.completionOverlay} activeOpacity={1} onPress={onDismissCompletionTick}>
          <View style={styles.completionCard}>
            <View style={styles.completionCircle}>
              <Feather name="check" size={scale(36)} color={COLORS.secondary} />
            </View>
            {completionMessage ? <Text style={styles.completionMsg}>{completionMessage}</Text> : null}
            {completionMessage && !completionMessage.startsWith('0 ') && !completionMessage.startsWith('0개') && !completionMessage.startsWith('0 ف') && (completionMessage.includes('deleted') || completionMessage.includes('slettet') || completionMessage.includes('eliminad') || completionMessage.includes('dihapus') || completionMessage.includes('удален') || completionMessage.includes('smazán') || completionMessage.includes('excluíd') || completionMessage.includes('삭제') || completionMessage.includes('șters') || completionMessage.includes('हटा') || completionMessage.includes('supprimé') || completionMessage.includes('διαγράφ') || completionMessage.includes('kustuta') || completionMessage.includes('изтрит') || completionMessage.includes('izbris') || completionMessage.includes('cancella') || completionMessage.includes('eliminad') || completionMessage.includes('raderad') || completionMessage.includes('izdzēst') || completionMessage.includes('حذف') || completionMessage.includes(t('results.cleanupDone'))) ? (
              <Text style={[styles.completionHint, { marginTop: scaleSpacing(8), marginBottom: scaleSpacing(4), fontWeight: '600' }]}>
                {Platform.OS === 'ios' ? t('results.filesMovedToRecentlyDeleted') : t('results.filesMovedToDeleted')}
              </Text>
            ) : null}
            <Text style={styles.completionHint}>{t('home.tapToDismiss')}</Text>
          </View>
        </TouchableOpacity>
      )}
    </View>
  );
};

// ═══════════════════════════════════════════════════════════════════
// STYLES — Premium dark glass aesthetic v2
// ═══════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },

  // ── Header ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: scaleSpacing(20),
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + scaleSpacing(2) : 46,
    paddingBottom: scaleSpacing(6),
    position: 'relative',
  },
  headerLeft: { flex: 1 },
  appName: {
    fontSize: scale(26),
    fontWeight: '900',
    color: COLORS.text,
    letterSpacing: -1,
  },
  versionBadge: {
    fontSize: scale(10),
    fontWeight: '600',
    color: COLORS.textDim,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: scale(6),
    paddingVertical: scale(2),
    borderRadius: scale(6),
    overflow: 'hidden',
  },
  headerActions: {
    flexDirection: 'row',
    gap: scaleSpacing(4),
  },
  headerBtn: {
    width: scale(38),
    height: scale(38),
    borderRadius: scale(12),
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Tab bar — floating pill style ──
  tabBar: {
    flexDirection: 'row',
    paddingTop: scaleSpacing(10),
    paddingBottom: scaleSpacing(10),
    paddingHorizontal: scaleSpacing(12),
    position: 'relative',
    gap: scaleSpacing(6),
  },
  tabItem: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: scaleSpacing(8),
    paddingHorizontal: scaleSpacing(4),
    borderRadius: scale(14),
    gap: scaleSpacing(4),
  },
  tabIconWrap: {
    width: scale(28),
    height: scale(28),
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontSize: scale(12),
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  tabRunningDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: COLORS.tabBar,
  },

  // ── Tab content ──
  tabContent: {
    paddingHorizontal: scaleSpacing(16),
    paddingTop: scaleSpacing(6),
    paddingBottom: scaleSpacing(10),
    gap: scaleSpacing(6),
  },

  // ── GlowCard ──
  glowCardOuter: {
    borderRadius: scale(20),
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    ...Platform.select({
      ios: { shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.2, shadowRadius: 16 },
      android: { elevation: 2 },
    }),
  },
  glowCardGradient: {
    borderRadius: scale(20),
  },

  // ── Quick Stats Bar — horizontal chip strip ──
  qsBarWrap: {
    marginHorizontal: scaleSpacing(16),
    marginTop: scaleSpacing(4),
    borderRadius: scale(14),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.075)',
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  qsBarGradient: {
    borderRadius: scale(14),
    position: 'relative',
    overflow: 'hidden',
  },
  qsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  qsCell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(5),
    paddingVertical: scaleSpacing(6),
    paddingHorizontal: scaleSpacing(8),
    minWidth: '48%',
  },
  qsCellRight: {
    justifyContent: 'flex-start',
  },
  qsIcon: {
    width: scale(24),
    height: scale(24),
    borderRadius: scale(7),
    alignItems: 'center',
    justifyContent: 'center',
  },
  qsDot: {
    width: scale(7),
    height: scale(7),
    borderRadius: scale(4),
  },
  qsText: {
    flex: 1,
    minWidth: 0,
  },
  qsLabel: {
    fontSize: scale(9),
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: COLORS.textDim,
    lineHeight: scale(12),
    marginBottom: 2,
  },
  qsValue: {
    fontSize: scale(12),
    fontWeight: '700',
    color: COLORS.text,
    lineHeight: scale(16),
  },
  qsCollapsedRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: scaleSpacing(12),
    gap: scaleSpacing(5),
  },
  qsCollapsedText: {
    fontSize: scale(11),
    fontWeight: '600',
    color: COLORS.text,
    maxWidth: scale(70),
  },
  qsCollapsedDot: {
    width: scale(3),
    height: scale(3),
    borderRadius: scale(2),
    opacity: 0.4,
  },
  // Hero progress overlay (during active operations — sits on top of stats)
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: scale(16),
    paddingVertical: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(14),
    justifyContent: 'center',
    overflow: 'hidden',
    zIndex: 2,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(10),
    marginBottom: scaleSpacing(10),
  },
  heroSpinnerWrap: {
    width: scale(36),
    height: scale(36),
    borderRadius: scale(10),
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: {
    fontSize: scale(15),
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  heroStatus: {
    fontSize: scale(11),
    color: '#FFFFFF',
    marginTop: 2,
    lineHeight: scale(15),
  },
  heroPct: {
    fontSize: scale(22),
    fontWeight: '800',
    letterSpacing: -0.5,
    minWidth: scale(50),
    textAlign: 'right',
  },
  heroTrack: {
    height: scale(6),
    backgroundColor: COLORS.border,
    borderRadius: scale(3),
    overflow: 'hidden',
  },
  heroFill: {
    height: '100%',
    borderRadius: scale(3),
  },
  heroFillIndeterminate: {
    height: '100%',
    width: '30%',
    borderRadius: scale(3),
  },

  // ── Section header — bold heading with accent underline ──
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(8),
    marginTop: scaleSpacing(8),
    marginBottom: scaleSpacing(4),
    paddingHorizontal: scaleSpacing(2),
  },
  sectionHeaderDot: {
    width: scale(3),
    height: scale(16),
    borderRadius: scale(2),
  },
  sectionHeaderTitle: {
    fontSize: scale(13),
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sectionHeaderSub: {
    fontSize: scale(11),
    color: COLORS.textMuted,
    marginTop: 1,
  },

  // ── Action rows ──
  actionRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: scaleSpacing(8),
  },
  actionStack: {
    gap: scaleSpacing(5),
    marginBottom: scaleSpacing(2),
  },

  // ── Primary button (Backup/Sync) — gradient fill with left accent ──
  primaryBtn: {
    flex: 1,
    borderRadius: scale(16),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  primaryBtnGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(16),
    borderRadius: scale(16),
  },
  primaryBtnIcon: {
    width: scale(40),
    height: scale(40),
    borderRadius: scale(12),
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: scaleSpacing(10),
  },
  primaryBtnTitle: {
    fontSize: scale(16),
    fontWeight: '800',
    color: '#FFF',
    letterSpacing: -0.3,
  },
  primaryBtnSub: {
    fontSize: scale(12),
    color: 'rgba(255,255,255,0.66)',
    marginTop: 2,
  },
  inlineChoiceBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(5),
    paddingHorizontal: scaleSpacing(10),
    paddingVertical: scaleSpacing(5),
    borderRadius: scale(999),
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  inlineChoiceText: {
    fontSize: scale(11),
    fontWeight: '700',
    color: COLORS.textMuted,
  },

  // ── Side button (Select) — pill shape ──
  sideBtn: {
    width: scale(52),
    alignSelf: 'stretch',
    borderRadius: scale(16),
    borderWidth: 1.5,
    backgroundColor: 'rgba(255,255,255,0.02)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: scaleSpacing(3),
  },
  sideBtnLabel: {
    fontSize: scale(9),
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  // ── NFT hero card — prominent rounded card ──
  nftHeroCard: {
    borderRadius: scale(18),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  nftHeroGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: scaleSpacing(4),
    paddingHorizontal: scaleSpacing(14),
    borderRadius: scale(18),
    position: 'relative',
  },
  nftHeroIconWrap: {
    width: scale(44),
    height: scale(44),
    borderRadius: scale(14),
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: scaleSpacing(12),
  },
  nftHeroTitle: {
    fontSize: scale(18),
    fontWeight: '800',
    color: '#FFF',
    letterSpacing: -0.3,
  },
  nftHeroSub: {
    fontSize: scale(12),
    color: 'rgba(255,255,255,0.66)',
    marginTop: 2,
  },
  nftHeroBadge: {
    width: scale(82),
    height: scale(82),
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,153,255,0.06)',
    marginLeft: scaleSpacing(10),
    paddingHorizontal: scaleSpacing(6),
    shadowColor: '#0099FF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
  },
  nftHeroBadgeText: {
    fontSize: scale(10.5),
    fontWeight: '900',
    color: '#0099FF',
    textAlign: 'center',
  },
  nftHeroBadgeDiscountText: {
    fontSize: scale(9.5),
    fontWeight: '900',
    color: '#FFFFFF',
    textAlign: 'center',
    marginTop: scaleSpacing(3),
  },
  nftHeroBadgeSubText: {
    fontSize: scale(9.5),
    fontWeight: '800',
    color: 'rgba(255,255,255,0.72)',
    textAlign: 'center',
    marginTop: scaleSpacing(3),
  },

  // ── NFT sub-cards (Album, Certs) — unified premium dark surface ──
  nftSubCard: {
    flex: 1,
    borderRadius: scale(16),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,153,255,0.15)',
    backgroundColor: 'rgba(0,153,255,0.04)',
  },
  nftSubCardInner: {
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(12),
    alignItems: 'center',
    borderRadius: scale(16),
  },
  nftSubCardIconWrap: {
    width: scale(40),
    height: scale(40),
    borderRadius: scale(12),
    backgroundColor: 'rgba(0,153,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: scaleSpacing(8),
  },
  nftSubCardTitle: {
    fontSize: scale(13.5),
    fontWeight: '800',
    color: '#FFF',
    letterSpacing: -0.2,
  },
  nftSubCardSub: {
    fontSize: scale(10),
    fontWeight: '600',
    color: 'rgba(255,255,255,0.50)',
    marginTop: scaleSpacing(3),
    textAlign: 'center',
  },

  // ── Feature card (Album, Certs) — tall card with centered content ──
  featureCard: {
    flex: 1,
    borderRadius: scale(16),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  featureCardGrad: {
    paddingVertical: scaleSpacing(11),
    paddingHorizontal: scaleSpacing(12),
    alignItems: 'center',
    borderRadius: scale(16),
  },
  featureCardIcon: {
    width: scale(42),
    height: scale(42),
    borderRadius: scale(12),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: scaleSpacing(6),
  },
  featureCardTitle: {
    fontSize: scale(14),
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  featureCardSub: {
    fontSize: scale(10),
    color: COLORS.textDim,
    marginTop: 3,
    textAlign: 'center',
  },

  // ── Tool card (Clean dups) — matching feature card style ──
  toolCard: {
    flex: 1,
    borderRadius: scale(16),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  toolCardGrad: {
    paddingVertical: scaleSpacing(11),
    paddingHorizontal: scaleSpacing(12),
    alignItems: 'center',
    borderRadius: scale(16),
  },
  toolCardIcon: {
    width: scale(44),
    height: scale(44),
    borderRadius: scale(14),
    backgroundColor: 'rgba(255,20,147,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: scaleSpacing(6),
  },
  toolCardTitle: {
    fontSize: scale(14),
    fontWeight: '800',
    color: COLORS.text,
    letterSpacing: -0.2,
  },
  toolCardSub: {
    fontSize: scale(11),
    color: COLORS.textMuted,
    marginTop: 3,
  },

  // ── Coming soon ──
  comingSoonCard: {
    alignItems: 'center',
    paddingVertical: scaleSpacing(24),
    paddingHorizontal: scaleSpacing(20),
  },
  comingSoonIcon: {
    width: scale(56),
    height: scale(56),
    borderRadius: scale(18),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: scaleSpacing(12),
  },
  comingSoonTitle: {
    fontSize: scale(15),
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: scaleSpacing(6),
  },
  comingSoonSub: {
    fontSize: scale(12),
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: scale(17),
  },

  // ── Disabled ──
  disabled: {
    opacity: 0.5,
  },

  // ── Completion overlay — centered modal ──
  completionOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.88)',
  },
  completionCard: {
    backgroundColor: '#0C0C16',
    borderRadius: scale(28),
    paddingVertical: scaleSpacing(32),
    paddingHorizontal: scaleSpacing(40),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: `${COLORS.secondary}25`,
    minWidth: scale(220),
    maxWidth: scale(320),
  },
  completionCircle: {
    width: scale(80),
    height: scale(80),
    borderRadius: scale(40),
    backgroundColor: `${COLORS.secondary}15`,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completionMsg: {
    marginTop: scaleSpacing(18),
    color: COLORS.text,
    fontSize: scale(18),
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  completionHint: {
    marginTop: scaleSpacing(14),
    color: COLORS.textDim,
    fontSize: scale(12),
    fontWeight: '500',
    textAlign: 'center',
  },
});

export default memo(HomeScreen);
