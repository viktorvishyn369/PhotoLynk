/**
 * InfoScreen.js
 * 
 * Professional Info UI - Clean, minimal, premium feel
 * Matches SettingsScreen theme
 */

import React, { useState, useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Dimensions,
  ActivityIndicator,
  Linking,
  StatusBar,
  useWindowDimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import { t } from './i18n';
import { SKR_SUBSCRIPTION_DISCOUNT_PERCENT, SKR_TOKEN_SYMBOL } from './solanaPurchases';

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
// 7+ inch tablets for 4 cards per row
const is7InchOrLarger = MIN_DIMENSION >= 600 && Math.max(SCREEN_WIDTH, SCREEN_HEIGHT) >= 960;

// Responsive scale factor based on screen width (base: 390px - iPhone 12/13)
const BASE_WIDTH = 390;
const scaleFactor = Math.min(Math.max(SCREEN_WIDTH / BASE_WIDTH, 0.75), 1.5);

// Height-based scaling for fitting content within screen bounds
// Base height: 844px (iPhone 12/13/14)
const BASE_HEIGHT = 844;
const heightRatio = SCREEN_HEIGHT / BASE_HEIGHT;
const isShortScreen = SCREEN_HEIGHT < 700; // iPhone SE, small Android
const isTallScreen = SCREEN_HEIGHT > 900; // iPhone Pro Max, tall Android

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

// Calculate plan card width for 2x2 grid
// Use percentage-based width: 48% each card with 4% gap between
// This ensures 2 cards per row on ALL screen sizes

const GRACE_PERIOD_DAYS = 7;

// Format bytes to human readable
const formatBytesHumanDecimal = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1000;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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

const SectionTitle = ({ children, color = '#A78BFA', style }) => (
  <View style={[styles.sectionTitleWrap, style]}>
    <LinearGradient colors={[color, `${color}80`]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.sectionTitleDot} />
    <Text style={[styles.sectionTitle, { color }]}>{children}</Text>
  </View>
);

// Info Row Component
const InfoRow = ({ icon, label, value, onPress, glassModeEnabled }) => (
  <TouchableOpacity
    style={[styles.infoRow, glassModeEnabled && styles.infoRowGlass]}
    onPress={onPress}
    disabled={!onPress}
    activeOpacity={onPress ? 0.7 : 1}
  >
    <View style={styles.infoRowIcon}>
      <Feather name={icon} size={scale(18)} color="#8888A0" />
    </View>
    <View style={styles.infoRowContent}>
      <Text style={styles.infoRowLabel}>{label}</Text>
      <Text style={styles.infoRowValue} numberOfLines={1}>{value}</Text>
    </View>
    {onPress && (
      <Feather name="copy" size={scale(16)} color="#55556A" />
    )}
  </TouchableOpacity>
);

// Link Row Component
const LinkRow = ({ icon, title, subtitle, onPress, glassModeEnabled }) => (
  <TouchableOpacity
    style={[styles.linkRow, glassModeEnabled && styles.linkRowGlass]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <View style={styles.linkRowIcon}>
      <Feather name={icon} size={scale(20)} color="#A78BFA" />
    </View>
    <View style={styles.linkRowContent}>
      <Text style={styles.linkRowTitle}>{title}</Text>
      {subtitle && <Text style={styles.linkRowSubtitle}>{subtitle}</Text>}
    </View>
    <Feather name="external-link" size={scale(16)} color="#55556A" />
  </TouchableOpacity>
);

// Usage Stat Component
const UsageStat = ({ label, value, color }) => (
  <View style={styles.usageStat}>
    <Text style={styles.usageStatLabel}>{label}</Text>
    <Text style={[styles.usageStatValue, color && { color }]}>{value}</Text>
  </View>
);

// Plan Card Component
const PlanCard = ({ gb, price, isCurrent, onPress, disabled, glassModeEnabled, currentLabel, perMonthLabel }) => (
  <TouchableOpacity
    style={[
      styles.planCard,
      isCurrent && styles.planCardCurrent,
      disabled && styles.planCardDisabled,
      glassModeEnabled && styles.planCardGlass,
    ]}
    onPress={onPress}
    disabled={disabled}
    activeOpacity={0.7}
  >
    <Text style={[styles.planCardGb, isCurrent && styles.planCardGbCurrent]}>
      {gb === 1000 ? '1 TB' : `${gb} GB`}
    </Text>
    <Text style={[styles.planCardPrice, isCurrent && styles.planCardPriceCurrent]} numberOfLines={1}>
      {isCurrent ? currentLabel : (price !== '—' ? `${price} ${perMonthLabel}` : price)}
    </Text>
  </TouchableOpacity>
);

// Main Info Screen
export const InfoScreen = ({
  onBack,
  appDisplayName,
  appVersion,
  deviceUuid,
  serverType,
  stealthUsage,
  stealthUsageLoading,
  stealthUsageError,
  availablePlans,
  purchaseLoading,
  glassModeEnabled,
  showDarkAlert,
  openPaywall,
  STEALTH_PLAN_TIERS,
  nftIsPremium = false,
  nftMintCount = 0,
  nftFreeMintLimit = 100,
  nftFreeMintsRemaining = 0,
  nftMaxNoFeeMints = 0,
  nftNoFeeMintsRemaining = 0,
  nftPurchaseLoading = false,
  handleSolanaPremium,
  handleDeleteAccount,
  subscriptionStatus,
}) => {
  const insets = useSafeAreaInsets();
  const bottomInset = Platform.OS === 'android' ? (insets.bottom || ANDROID_NAV_BAR_HEIGHT) : insets.bottom;
  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : insets.top;
  const premiumMintCount = Math.max(0, Number(nftMintCount) || 0);
  const freeMintLimit = Math.max(0, Number(nftFreeMintLimit) || 0);
  const maxNoFeeMints = Math.max(0, Number(nftMaxNoFeeMints) || 0);
  const freeMintsUsed = Math.min(premiumMintCount, freeMintLimit);
  const freeMintsRemaining = Math.max(0, freeMintLimit - freeMintsUsed);
  const noFeeMintsUsed = Math.max(0, premiumMintCount - freeMintLimit);
  const noFeeMintsRemaining = Math.max(0, maxNoFeeMints - noFeeMintsUsed);
  // Premium payment method state
  const [premiumPaymentMethod, setPremiumPaymentMethod] = useState('sol');
  // Premium card collapse state — collapsed by default to save space
  const [premiumExpanded, setPremiumExpanded] = useState(false);
  // Detect orientation for tablets - enable scroll in landscape
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isLandscape = windowWidth > windowHeight;
  const minDim = Math.min(windowWidth, windowHeight);
  const isTabletDevice = minDim >= 600; // 7"+ tablets
  const shouldEnableScroll = true; // Always enable scroll to handle content on small screens

  const handleCopyDeviceId = () => {
    if (deviceUuid) {
      Clipboard.setStringAsync(deviceUuid);
      showDarkAlert(t('info.copied'), t('info.deviceIdCopied'));
    }
  };

  const handleOpenGitHub = () => {
    Linking.openURL('https://github.com/viktorvishyn369/PhotoLynk/releases').catch(() => {
      showDarkAlert(t('alerts.error'), t('alerts.couldNotOpenLink'));
    });
  };

  const handleOpenDeleteAccount = () => {
    if (typeof handleDeleteAccount === 'function') {
      handleDeleteAccount();
      return;
    }
    showDarkAlert(t('alerts.error'), t('alerts.notLoggedInMessage'));
  };

  const handleOpenSupport = () => {
    Linking.openURL('mailto:support@stealthlynk.io?subject=PhotoLynk%20Support').catch(() => {
      showDarkAlert(t('alerts.error'), t('alerts.couldNotOpenLink'));
    });
  };

  // Parse StealthCloud usage data
  const getUsageData = () => {
    if (!stealthUsage) return null;
    
    const quotaBytes = Number(stealthUsage.quotaBytes ?? stealthUsage.quota_bytes ?? stealthUsage.quota ?? 0) || 0;
    const usedBytes = Number(stealthUsage.usedBytes ?? stealthUsage.used_bytes ?? stealthUsage.used ?? 0) || 0;
    const remainingBytes = Number(
      (stealthUsage.remainingBytes ?? stealthUsage.remaining_bytes ?? stealthUsage.remaining) ??
      (quotaBytes ? (quotaBytes - usedBytes) : 0)
    ) || 0;
    const sub = stealthUsage.subscription || {};
    const subStatus = sub.status || 'none';
    const isGrace = subStatus === 'grace' || subStatus === 'grace_expired';
    const isExpired = subStatus === 'trial_expired' || subStatus === 'grace_expired';
    const planGb = stealthUsage.planGb || stealthUsage.plan_gb;

    return { quotaBytes, usedBytes, remainingBytes, sub, subStatus, isGrace, isExpired, planGb };
  };

  const getStatusText = (subStatus, sub, isExpired, isGrace) => {
    if (subStatus === 'active') {
      const hasPurchasedPlan = !!(sub.paymentType || sub.payment_type || sub.purchased_via || sub.purchasedVia);
      return hasPurchasedPlan && sub.expiresAt ? `${t('info.activeUntil')} ${new Date(sub.expiresAt).toLocaleDateString()}` : t('info.active');
    }
    if (subStatus === 'trial') return t('info.freeTrialStatus');
    if (subStatus === 'grace') return t('info.expiredGraceDays');
    if (subStatus === 'grace_expired') return t('info.gracePeriodEnded');
    if (subStatus === 'trial_expired') return t('info.trialExpired');
    return '—';
  };

  const getStatusColor = (isExpired, isGrace) => {
    if (isExpired) return '#EF4444';
    if (isGrace) return '#F59E0B';
    return '#10B981';
  };

  const usageData = getUsageData();

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: topInset + scaleSpacing(10) }]}>
        <Text style={styles.headerTitle}>{t('info.title') || 'Info'}</Text>
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

        {/* App Info - hidden (version now in header, UUID kept for functionality) */}
        <View style={{ display: 'none' }}>
        <SectionTitle>{t('info.app')}</SectionTitle>
        <Card glassModeEnabled={glassModeEnabled}>
          <View style={styles.appInfoGrid}>
            <View style={styles.appInfoItem}>
              <Feather name="smartphone" size={scale(16)} color="#8888A0" />
              <View>
                <Text style={styles.appInfoLabel}>{appDisplayName}</Text>
                <Text style={styles.appInfoSubtitle}>stealthlynk.io</Text>
              </View>
            </View>
            <View style={styles.appInfoItem}>
              <Feather name="tag" size={scale(16)} color="#8888A0" />
              <Text style={styles.appInfoLabel}>v{appVersion}</Text>
            </View>
          </View>
          {deviceUuid && (
            <>
              <View style={styles.dividerFull} />
              <TouchableOpacity 
                style={styles.deviceIdRow}
                onPress={handleCopyDeviceId}
                activeOpacity={0.7}
              >
                <Feather name="hash" size={scale(16)} color="#8888A0" />
                <Text style={styles.deviceIdText} numberOfLines={1}>{deviceUuid}</Text>
                <Feather name="copy" size={scale(14)} color="#55556A" />
              </TouchableOpacity>
            </>
          )}
        </Card>
        </View>

        {/* StealthCloud Storage */}
        {serverType === 'stealthcloud' && (
          <>
            <SectionTitle>{t('info.stealthcloudStorage')}</SectionTitle>
            <Card glassModeEnabled={glassModeEnabled}>
              {/* Spinner hidden - data fetches silently in background */}

              {stealthUsageError && (
                <View style={styles.errorContainer}>
                  <Feather name="alert-circle" size={scale(18)} color="#EF4444" />
                  <Text style={styles.errorText}>{stealthUsageError}</Text>
                </View>
              )}

              {usageData && (() => {
                const quota = usageData.quotaBytes || 0;
                const used = usageData.usedBytes || 0;
                const pct = quota > 0 ? Math.min(100, Math.max(0, (used / quota) * 100)) : 0;
                const barColor = pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : '#10B981';
                const statusColor = getStatusColor(usageData.isExpired, usageData.isGrace);
                const statusText = getStatusText(usageData.subStatus, usageData.sub, usageData.isExpired, usageData.isGrace);
                return (
                <>
                  <View style={styles.storageSummary}>
                    <View style={styles.storageSummaryHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.storageSummaryPlan} numberOfLines={1}>
                          {usageData.planGb ? (usageData.planGb === 1000 ? '1 TB' : `${usageData.planGb} GB`) : '—'}
                        </Text>
                        <Text style={styles.storageSummaryMeta} numberOfLines={1}>
                          {`${formatBytesHumanDecimal(used)} ${t('info.of') || 'of'} ${quota > 0 ? formatBytesHumanDecimal(quota) : '—'} ${t('info.used') || 'used'}`}
                        </Text>
                      </View>
                      <View style={[styles.storageStatusPill, { backgroundColor: `${statusColor}1A`, borderColor: `${statusColor}55` }]}>
                        <View style={[styles.storageStatusDot, { backgroundColor: statusColor }]} />
                        <Text style={[styles.storageStatusText, { color: statusColor }]} numberOfLines={1}>{statusText}</Text>
                      </View>
                    </View>
                    <View style={styles.progressBarTrack}>
                      <View style={[styles.progressBarFill, { width: `${pct}%`, backgroundColor: barColor }]} />
                    </View>
                    <View style={styles.storageSummaryFooter}>
                      <Text style={styles.storageSummaryFooterText}>{`${formatBytesHumanDecimal(used)} ${t('info.used') || 'used'}`}</Text>
                      <Text style={styles.storageSummaryFooterText}>{`${formatBytesHumanDecimal(usageData.remainingBytes)} ${t('info.remaining') || 'free'}`}</Text>
                    </View>
                  </View>

                  {(usageData.isGrace || usageData.isExpired) && (
                    <View style={styles.warningBanner}>
                      <Feather name="alert-triangle" size={scale(16)} color="#F59E0B" />
                      <Text style={styles.warningText}>
                        {usageData.isGrace && !usageData.isExpired
                          ? t('info.subscriptionExpiredGrace')
                          : t('info.subscriptionExpiredRenew')}
                      </Text>
                    </View>
                  )}

                  {/* Cross-platform payment notice - only show for Apple/Google Pay subscriptions (not Solana) */}
                  {(() => {
                    const sub = stealthUsage?.subscription || {};
                    const purchasedVia = sub.purchased_via || sub.purchasedVia || sub.paymentType || sub.payment_type;
                    const hasPlan = usageData.planGb;
                    const isActive = usageData.subStatus === 'active' || usageData.subStatus === 'trial';
                    
                    // Only show notice for Apple Pay or Google Play subscriptions (not Solana)
                    // Solana payments don't need a "switch to SOL" message since they're already using SOL
                    if (purchasedVia && (purchasedVia === 'apple' || purchasedVia === 'google') && hasPlan && isActive) {
                      const paymentLabel = purchasedVia === 'apple' ? 'App Store' : 'Google Play';
                      return (
                        <View style={styles.infoBanner}>
                          <Feather name="info" size={scale(16)} color="#A78BFA" />
                          <Text style={styles.infoText}>
                            {t('info.subscriptionViaPlatform', { platform: paymentLabel })}
                          </Text>
                        </View>
                      );
                    }
                    return null;
                  })()}
                </>
                );
              })()}
            </Card>

            {/* Subscription Plans */}
            <SectionTitle>{t('info.manageSubscription')}</SectionTitle>
            <Card glassModeEnabled={glassModeEnabled}>
              {/* SKR discount banner hidden — promotion paused
              <View style={styles.subscriptionPromoBanner}>
                <View style={styles.subscriptionPromoIconWrap}>
                  <Feather name="zap" size={scale(12)} color="#00FFA3" />
                </View>
                <View style={styles.subscriptionPromoContent}>
                  <Text style={styles.subscriptionPromoTitle}>Pay with {SKR_TOKEN_SYMBOL} and save {SKR_SUBSCRIPTION_DISCOUNT_PERCENT}%</Text>
                  <Text style={styles.subscriptionPromoSubtitle}>Limited offer across all subscription plans</Text>
                </View>
              </View>
              */}
              <View style={styles.planPaymentCaption}>
                <Feather name="zap" size={scale(10)} color="#00FFA3" />
                <Text style={styles.planPaymentCaptionText}>{`Pay with SOL or ${SKR_TOKEN_SYMBOL}`}</Text>
              </View>
              <View style={styles.planGrid}>
                {STEALTH_PLAN_TIERS.map((gb) => {
                  const plan = availablePlans.find(p => p.tierGb === gb);
                  const priceStr = plan ? plan.priceString : '—';
                  const currentPlan = usageData?.planGb;
                  const isCurrent = currentPlan === gb;

                  return (
                    <PlanCard
                      key={String(gb)}
                      gb={gb}
                      price={priceStr}
                      isCurrent={isCurrent}
                      onPress={() => openPaywall(gb)}
                      disabled={purchaseLoading}
                      glassModeEnabled={glassModeEnabled}
                      currentLabel={t('info.current')}
                      perMonthLabel={t('info.perMonth')}
                    />
                  );
                })}
              </View>
              <Text style={{ color: '#00FFA3', fontSize: scale(11), fontWeight: '700', textAlign: 'center', marginTop: scaleSpacing(4), marginBottom: scaleSpacing(4), lineHeight: scale(16) }}>
                {t('subscription.autoRenewNote')}
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: scaleSpacing(16), marginBottom: scaleSpacing(10) }}>
                <TouchableOpacity onPress={() => Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/terms.html')}>
                  <Text style={{ color: '#A78BFA', fontSize: scale(11), textDecorationLine: 'underline' }}>{t('subscription.termsOfUse')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => Linking.openURL('https://viktorvishyn369.github.io/PhotoLynk/privacy-policy.html')}>
                  <Text style={{ color: '#A78BFA', fontSize: scale(11), textDecorationLine: 'underline' }}>{t('subscription.privacyPolicy')}</Text>
                </TouchableOpacity>
              </View>
            </Card>

            {/* Premium — Go Premium or Premium Active badge */}
            <SectionTitle>{t('info.premiumUpgrade') || 'Premium Upgrade'}</SectionTitle>
            <Card glassModeEnabled={glassModeEnabled}>
              {(nftIsPremium || subscriptionStatus?.isPremium) ? (
                <View style={styles.nftPremiumBadgeRow}>
                  <LinearGradient
                    colors={['rgba(153,69,255,0.15)', 'rgba(220,31,255,0.08)']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.nftPremiumBadge}
                  >
                    <View style={styles.nftPremiumBadgeHeader}>
                      <Feather name="award" size={scale(16)} color="#6C5CE7" />
                      <Text style={styles.nftPremiumBadgeText}>{t('info.premiumActive') || 'Premium Active'}</Text>
                    </View>
                    <Text style={styles.nftPremiumBadgeSub}>
                      {freeMintsUsed} / {freeMintLimit} {t('info.certifiedImages') || 'certified'} · {t('info.remaining') || 'Remaining'}: {freeMintsRemaining}
                    </Text>
                    {noFeeMintsUsed > 0 && (
                      <Text style={styles.nftPremiumBadgeSub}>
                        {t('info.paidMintsUsed') || 'Paid mints'}: {noFeeMintsUsed} · $0.02 USDC {t('info.perNft') || 'per NFT'}
                      </Text>
                    )}
                    <Text style={styles.nftPremiumBadgeSub}>
                      {t('info.beyondLimit') || `Beyond ${freeMintLimit}`}: $0.02 USDC {t('info.perNft') || 'per NFT'}
                    </Text>
                  </LinearGradient>
                </View>
              ) : (
                <View style={[styles.nftPremiumCard, glassModeEnabled && styles.nftPremiumCardGlass]}>
                  <LinearGradient
                    colors={['rgba(153,69,255,0.12)', 'rgba(220,31,255,0.06)']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                    style={styles.nftPremiumCardInner}
                  >
                    {/* SKR discount banner hidden — promotion paused
                    <View style={styles.premiumOfferBanner}>
                      <View style={styles.premiumOfferPillLimited}>
                        <Feather name="clock" size={scale(10)} color="#FFD76A" />
                        <Text style={styles.premiumOfferPillLimitedText}>Limited offer</Text>
                      </View>
                      <View style={styles.premiumOfferPillDiscount}>
                        <Feather name="zap" size={scale(10)} color="#00FFA3" />
                        <Text style={styles.premiumOfferPillDiscountText}>{SKR_SUBSCRIPTION_DISCOUNT_PERCENT}% OFF with {SKR_TOKEN_SYMBOL}</Text>
                      </View>
                    </View>
                    */}

                    <TouchableOpacity
                      style={styles.nftPremiumCardHeader}
                      onPress={() => setPremiumExpanded(prev => !prev)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: premiumExpanded }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: scaleSpacing(6), flex: 1 }}>
                        <Feather name="award" size={scale(16)} color="#A78BFA" />
                        <Text style={styles.nftPremiumCardTitle}>{t('info.goPremium') || 'Go Premium'}</Text>
                      </View>
                      <View style={styles.nftPremiumPriceBadge}>
                        <Text style={styles.nftPremiumPriceText}>$49.99</Text>
                        <Text style={styles.nftPremiumPriceOnce}>{t('info.oneTime') || 'one-time'}</Text>
                      </View>
                      <Feather
                        name={premiumExpanded ? 'chevron-up' : 'chevron-down'}
                        size={scale(18)}
                        color="#A78BFA"
                        style={{ marginLeft: scaleSpacing(8) }}
                      />
                    </TouchableOpacity>

                    {premiumExpanded && (
                    <>
                    {/* Payment Method Selector */}
                    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: scaleSpacing(8), marginVertical: scaleSpacing(12) }}>
                      <TouchableOpacity
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: scaleSpacing(8),
                          paddingHorizontal: scaleSpacing(12),
                          borderRadius: scaleSpacing(8),
                          borderWidth: 1,
                          borderColor: premiumPaymentMethod === 'sol' ? '#0099FF' : '#444',
                          backgroundColor: premiumPaymentMethod === 'sol' ? 'rgba(0,153,255,0.15)' : 'transparent',
                          gap: scaleSpacing(6),
                        }}
                        onPress={() => setPremiumPaymentMethod('sol')}
                      >
                        <Text style={{ color: premiumPaymentMethod === 'sol' ? '#0099FF' : '#AAA', fontSize: scale(11), fontWeight: '600' }}>
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
                          borderColor: premiumPaymentMethod === 'skr' ? '#00FFA3' : '#444',
                          backgroundColor: premiumPaymentMethod === 'skr' ? 'rgba(0,255,163,0.15)' : 'transparent',
                          gap: scaleSpacing(6),
                        }}
                        onPress={() => setPremiumPaymentMethod('skr')}
                      >
                        <Feather name="zap" size={scale(11)} color={premiumPaymentMethod === 'skr' ? '#00FFA3' : '#888'} />
                        <Text style={{ color: premiumPaymentMethod === 'skr' ? '#00FFA3' : '#AAA', fontSize: scale(11), fontWeight: '600' }}>
                          Pay with {SKR_TOKEN_SYMBOL}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* Price display — discount UI removed; both methods show same one-time price */}
                    <View style={styles.premiumPriceSummary}>
                      <Text style={styles.premiumPriceStandard}>One-time premium unlock</Text>
                    </View>
                    <View style={styles.nftPremiumPerks}>
                      <View style={styles.nftPerkRow}>
                        <Feather name="check" size={scale(12)} color="#00FFA3" />
                        <Text style={styles.nftPerkText}>{t('info.perkStorage') || '1TB encrypted storage for 1 year'}</Text>
                      </View>
                      <View style={styles.nftPerkRow}>
                        <Feather name="check" size={scale(12)} color="#00FFA3" />
                        <Text style={styles.nftPerkText}>{t('info.perkFreeCerts', { count: freeMintLimit }) || `${freeMintLimit} fully free NFT certifications (no app fees, no network fees)`}</Text>
                      </View>
                      <View style={styles.nftPerkRow}>
                        <Feather name="check" size={scale(12)} color="#00FFA3" />
                        <Text style={styles.nftPerkText}>{t('info.perkBeyond100', { count: freeMintLimit }) || `$0.02 USDC per NFT beyond ${freeMintLimit} (covers all expenses)`}</Text>
                      </View>
                      <View style={styles.nftPerkRow}>
                        <Feather name="check" size={scale(12)} color="#00FFA3" />
                        <Text style={styles.nftPerkText}>{t('info.perkDevices') || 'Use across all your devices'}</Text>
                      </View>
                      <View style={styles.nftPerkRow}>
                        <Feather name="check" size={scale(12)} color="#00FFA3" />
                        <Text style={styles.nftPerkText}>{t('info.perkSolana') || 'Pay with SOL via hardware wallet'}</Text>
                      </View>
                    </View>
                    {/* Purchase Button */}
                    <TouchableOpacity
                      style={{
                        backgroundColor: premiumPaymentMethod === 'skr' ? '#00FFA3' : '#A78BFA',
                        borderRadius: scaleSpacing(12),
                        paddingVertical: scaleSpacing(12),
                        paddingHorizontal: scaleSpacing(20),
                        alignItems: 'center',
                        marginTop: scaleSpacing(10),
                        opacity: nftPurchaseLoading ? 0.5 : 1,
                      }}
                      onPress={() => handleSolanaPremium(premiumPaymentMethod)}
                      disabled={nftPurchaseLoading}
                      activeOpacity={0.8}
                    >
                      {nftPurchaseLoading ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: scaleSpacing(8) }}>
                          <ActivityIndicator size="small" color="#000" />
                          <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '600' }}>{t('info.processing') || 'Processing...'}</Text>
                        </View>
                      ) : (
                        <Text style={{ color: '#000', fontSize: scale(14), fontWeight: '700' }}>
                          {premiumPaymentMethod === 'skr' ? `Buy with ${SKR_TOKEN_SYMBOL}` : 'Buy with SOL'}
                        </Text>
                      )}
                    </TouchableOpacity>
                    </>
                    )}
                  </LinearGradient>
                </View>
              )}
            </Card>
          </>
        )}
        </View>

        {/* Resources — pushed to bottom (always visible) */}
        <View style={styles.resourcesSection}>
          <SectionTitle style={{ marginTop: 0 }}>{t('info.resources')}</SectionTitle>
          <View style={styles.resourcesRow}>
          <TouchableOpacity
            style={styles.resourceCard}
            onPress={handleOpenGitHub}
            activeOpacity={0.7}
          >
            <View style={styles.resourceCardIcon}>
              <Feather name="github" size={scale(18)} color="#A78BFA" />
            </View>
            <Text style={styles.resourceCardTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('info.github')}</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.resourceCard}
            onPress={handleOpenSupport}
            activeOpacity={0.7}
          >
            <View style={[styles.resourceCardIcon, { backgroundColor: 'rgba(16, 185, 129, 0.15)' }]}>
              <Feather name="mail" size={scale(18)} color="#10B981" />
            </View>
            <Text style={styles.resourceCardTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('info.support')}</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.resourceCard}
            onPress={handleOpenDeleteAccount}
            activeOpacity={0.7}
          >
            <View style={[styles.resourceCardIcon, { backgroundColor: 'rgba(239, 68, 68, 0.15)' }]}>
              <Feather name="trash-2" size={scale(18)} color="#EF4444" />
            </View>
            <Text style={styles.resourceCardTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('info.deleteAccount')}</Text>
          </TouchableOpacity>
          </View>
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
  resourcesSection: {
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
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginLeft: scaleSpacing(56),
  },
  dividerFull: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  // App Info Grid
  appInfoGrid: {
    flexDirection: 'row',
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(16),
  },
  appInfoItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(8),
  },
  appInfoLabel: {
    fontSize: scale(15),
    fontWeight: '600',
    color: '#F4F4F8',
  },
  appInfoSubtitle: {
    fontSize: scale(11),
    fontWeight: '400',
    color: '#5C5C72',
    marginTop: scaleSpacing(1),
  },
  deviceIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(16),
    gap: scaleSpacing(10),
  },
  deviceIdText: {
    flex: 1,
    fontSize: scale(13),
    color: '#8888A0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Info Row
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(16),
  },
  infoRowGlass: {},
  infoRowIcon: {
    width: scaleSpacing(40),
    height: scaleSpacing(40),
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: scaleSpacing(12),
  },
  infoRowContent: {
    flex: 1,
  },
  infoRowLabel: {
    fontSize: scale(13),
    color: '#8888A0',
  },
  infoRowValue: {
    fontSize: scale(16),
    fontWeight: '600',
    color: '#F4F4F8',
    marginTop: scaleSpacing(2),
  },
  // Resources Row
  resourcesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: scaleSpacing(8),
  },
  resourceCard: {
    flex: 1,
    minWidth: scale(90),
    flexDirection: 'column',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: scale(14),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(8),
    gap: scaleSpacing(8),
  },
  resourceCardIcon: {
    width: scale(36),
    height: scale(36),
    borderRadius: scale(10),
    backgroundColor: 'rgba(108, 92, 231, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  resourceCardTitle: {
    fontSize: scale(11),
    fontWeight: '700',
    color: '#F4F4F8',
    textAlign: 'center',
  },
  // Loading & Error
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: scaleSpacing(20),
    gap: scaleSpacing(10),
  },
  loadingText: {
    fontSize: scale(14),
    color: '#8888A0',
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: scaleSpacing(16),
    gap: scaleSpacing(10),
  },
  errorText: {
    fontSize: scale(14),
    color: '#EF4444',
    flex: 1,
  },
  // Usage Grid
  usageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: scaleSpacing(16),
    gap: scaleSpacing(2),
  },
  storageSummary: {
    paddingHorizontal: scaleSpacing(16),
    paddingVertical: scaleSpacing(14),
  },
  storageSummaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: scaleSpacing(10),
    gap: scaleSpacing(8),
  },
  storageSummaryPlan: {
    fontSize: scale(20),
    fontWeight: '800',
    color: '#F4F4F8',
    letterSpacing: -0.3,
  },
  storageSummaryMeta: {
    fontSize: scale(11),
    color: '#7676A0',
    marginTop: scaleSpacing(2),
    fontWeight: '500',
  },
  storageStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(6),
    paddingHorizontal: scaleSpacing(10),
    paddingVertical: scaleSpacing(4),
    borderRadius: 999,
    borderWidth: 1,
  },
  storageStatusDot: {
    width: scale(6),
    height: scale(6),
    borderRadius: scale(3),
  },
  storageStatusText: {
    fontSize: scale(11),
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  progressBarTrack: {
    height: scale(8),
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: scale(4),
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: scale(4),
  },
  storageSummaryFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: scaleSpacing(8),
  },
  storageSummaryFooterText: {
    fontSize: scale(12),
    color: '#A9A9C7',
    fontWeight: '600',
  },
  usageStat: {
    width: '48%',
    paddingVertical: scaleSpacing(10),
    paddingHorizontal: scaleSpacing(4),
  },
  usageStatLabel: {
    fontSize: scale(11),
    color: '#7676A0',
    marginBottom: scaleSpacing(4),
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  usageStatValue: {
    fontSize: scale(17),
    fontWeight: '800',
    color: '#F4F4F8',
    letterSpacing: -0.3,
  },
  // Warning & Info Banners
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    marginHorizontal: scaleSpacing(16),
    marginBottom: scaleSpacing(16),
    padding: scaleSpacing(12),
    borderRadius: scaleSpacing(12),
    borderLeftWidth: 3,
    borderLeftColor: '#F59E0B',
    gap: scaleSpacing(10),
  },
  warningText: {
    fontSize: scale(13),
    color: '#F59E0B',
    flex: 1,
    lineHeight: scale(18),
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(108, 92, 231, 0.08)',
    marginHorizontal: scaleSpacing(16),
    marginBottom: scaleSpacing(16),
    padding: scaleSpacing(12),
    borderRadius: scaleSpacing(12),
    borderLeftWidth: 3,
    borderLeftColor: '#6C5CE7',
    gap: scaleSpacing(10),
  },
  infoText: {
    fontSize: scale(13),
    color: '#A78BFA',
    flex: 1,
    lineHeight: scale(18),
  },
  // Plan Grid - 2x2 responsive grid with proper gaps (4 per row on 7+ inch tablets)
  planGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: scaleSpacing(10),
    paddingVertical: scaleSpacing(10),
    gap: scaleSpacing(6),
  },
  planCard: {
    width: is7InchOrLarger ? '22.5%' : '47%',
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: scale(14),
    paddingVertical: scaleSpacing(8),
    paddingHorizontal: scaleSpacing(8),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  planPaymentCaption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: scaleSpacing(4),
    paddingTop: scaleSpacing(8),
    paddingBottom: scaleSpacing(2),
  },
  planPaymentCaptionText: {
    color: '#A9A9C7',
    fontSize: scale(11),
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  planCardCurrent: {
    backgroundColor: 'rgba(108,92,231,0.10)',
    borderColor: 'rgba(108,92,231,0.4)',
    borderWidth: 1.5,
    borderLeftWidth: 3,
    borderLeftColor: '#6C5CE7',
  },
  planCardDisabled: {
    opacity: 0.5,
  },
  planCardGlass: {},
  planCardGb: {
    fontSize: scale(16),
    fontWeight: '800',
    color: '#F4F4F8',
    letterSpacing: -0.3,
  },
  planCardGbCurrent: {
    color: '#A78BFA',
  },
  planCardPrice: {
    fontSize: scale(13),
    fontWeight: '600',
    color: '#8888A0',
    marginTop: scaleSpacing(4),
  },
  planCardPriceCurrent: {
    color: '#F4F4F8',
  },
  planCardMeta: {
    fontSize: scale(9),
    color: '#5C5C72',
    marginTop: scaleSpacing(3),
    fontWeight: '500',
  },
  subscriptionPromoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,255,163,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.18)',
    borderRadius: scale(12),
    paddingHorizontal: scaleSpacing(12),
    paddingVertical: scaleSpacing(10),
    marginBottom: scaleSpacing(12),
  },
  subscriptionPromoIconWrap: {
    width: scale(28),
    height: scale(28),
    borderRadius: scale(14),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,255,163,0.12)',
    marginRight: scaleSpacing(10),
  },
  subscriptionPromoContent: {
    flex: 1,
  },
  subscriptionPromoTitle: {
    color: '#D7FFF2',
    fontSize: scale(11.5),
    fontWeight: '700',
  },
  subscriptionPromoSubtitle: {
    color: '#7BC8AD',
    fontSize: scale(10),
    marginTop: scaleSpacing(2),
  },
  // Premium styles
  nftPremiumBadgeRow: {
    paddingHorizontal: scaleSpacing(16),
    paddingVertical: scaleSpacing(12),
  },
  nftPremiumBadge: {
    gap: scaleSpacing(6),
    paddingHorizontal: scaleSpacing(14),
    paddingVertical: scaleSpacing(12),
    borderRadius: scale(12),
  },
  nftPremiumBadgeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(8),
    marginBottom: scaleSpacing(2),
  },
  nftPremiumBadgeText: {
    fontSize: scale(13),
    fontWeight: '800',
    color: '#6C5CE7',
    letterSpacing: -0.2,
  },
  nftPremiumBadgeSub: {
    fontSize: scale(11),
    color: '#8888A0',
    lineHeight: scale(16),
  },
  nftPremiumCard: {
    overflow: 'hidden',
  },
  nftPremiumCardInner: {
    padding: scaleSpacing(18),
    paddingVertical: scaleSpacing(20),
  },
  premiumOfferBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: scaleSpacing(8),
    marginBottom: scaleSpacing(14),
    flexWrap: 'wrap',
  },
  premiumOfferPillLimited: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,215,106,0.12)',
    borderColor: 'rgba(255,215,106,0.24)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: scaleSpacing(8),
    paddingVertical: scaleSpacing(4),
    gap: scaleSpacing(4),
  },
  premiumOfferPillLimitedText: {
    color: '#FFD76A',
    fontSize: scale(10),
    fontWeight: '700',
  },
  premiumOfferPillDiscount: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,255,163,0.12)',
    borderColor: 'rgba(0,255,163,0.24)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: scaleSpacing(8),
    paddingVertical: scaleSpacing(4),
    gap: scaleSpacing(4),
  },
  premiumOfferPillDiscountText: {
    color: '#00FFA3',
    fontSize: scale(10),
    fontWeight: '700',
  },
  nftPremiumCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: scaleSpacing(10),
  },
  nftPremiumCardTitle: {
    fontSize: scale(16),
    fontWeight: '800',
    color: '#A78BFA',
    letterSpacing: -0.3,
  },
  nftPremiumPriceBadge: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: scaleSpacing(4),
  },
  nftPremiumPriceText: {
    fontSize: scale(22),
    fontWeight: '900',
    color: '#F4F4F8',
    letterSpacing: -0.5,
  },
  nftPremiumPriceOnce: {
    fontSize: scale(10),
    color: '#8888A0',
    fontWeight: '500',
  },
  nftPremiumPerks: {
    gap: scaleSpacing(8),
  },
  premiumPriceSummary: {
    alignItems: 'center',
    marginBottom: scaleSpacing(12),
  },
  premiumPriceStrike: {
    color: '#8E8EA8',
    fontSize: scale(12),
    textDecorationLine: 'line-through',
    marginBottom: scaleSpacing(2),
  },
  premiumPriceHighlight: {
    color: '#00FFA3',
    fontSize: scale(14),
    fontWeight: '700',
  },
  premiumPriceStandard: {
    color: '#B8B8D1',
    fontSize: scale(12),
    fontWeight: '600',
  },
  nftPerkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scaleSpacing(8),
  },
  nftPerkText: {
    fontSize: scale(12),
    color: '#9898B0',
    flex: 1,
    lineHeight: scale(17),
  },
  // Footer
  footer: {
    alignItems: 'center',
    paddingVertical: scaleSpacing(24),
  },
  footerText: {
    fontSize: scale(13),
    color: '#4E4E66',
  },
});

export default InfoScreen;
