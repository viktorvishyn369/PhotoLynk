// PhotoLynk Mobile App - Styles
import { StyleSheet, Platform, Dimensions, PixelRatio, StatusBar } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Responsive scaling for tablets (11-13 inch iPads)
const isTablet = Math.min(SCREEN_WIDTH, SCREEN_HEIGHT) >= 600;
const isLargeTablet = Math.min(SCREEN_WIDTH, SCREEN_HEIGHT) >= 768;

// Scale factor for fonts and spacing on tablets
const scale = (size) => {
  if (isLargeTablet) return size * 1.35; // 13" iPad
  if (isTablet) return size * 1.2; // 11" iPad
  return size; // Phone
};

// Scale for spacing/padding (less aggressive than fonts)
const scaleSpacing = (size) => {
  if (isLargeTablet) return size * 1.25;
  if (isTablet) return size * 1.15;
  return size;
};

export const THEME = {
  bg: '#030308',
  card: '#0A0A14',
  cardLight: '#12121E',
  text: '#EEEEF6',
  textSec: '#7676A0',
  primary: '#6C5CE7',    // Rich purple primary
  secondary: '#00FFA3',  // Solana bright mint/green
  accent: '#A78BFA',     // Soft violet accent
  gold: '#F5C842',       // Premium gold
  error: '#FF4466',
  glow: 'rgba(108,92,231,0.15)',  // Purple glow for cards
  border: 'rgba(167,139,250,0.12)', // Violet tinted border
};

// Export for use in App.js if needed
export { isTablet, isLargeTablet, scale, scaleSpacing };

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#030308',
    paddingTop: Platform.OS === 'ios' ? 0 : 0,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Auth Screen
  authHeader: {
    alignItems: 'center',
    marginBottom: Math.max(24, SCREEN_HEIGHT * 0.035),
    marginTop: Platform.OS === 'android' ? Math.max(40, SCREEN_HEIGHT * 0.08) : 0,
  },
  appIcon: {
    width: isTablet ? 130 : Math.min(90, SCREEN_WIDTH * 0.22),
    height: isTablet ? 130 : Math.min(90, SCREEN_WIDTH * 0.22),
    borderRadius: isTablet ? 32 : 24,
    marginBottom: scaleSpacing(20),
  },
  title: {
    fontSize: scale(32),
    fontWeight: '900',
    color: '#EEEEF6',
    marginBottom: scaleSpacing(6),
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: scale(14),
    color: '#7676A0',
    textAlign: 'center',
    paddingHorizontal: scaleSpacing(36),
    lineHeight: scale(20),
  },
  form: {
    paddingHorizontal: Math.max(24, SCREEN_WIDTH * 0.06),
    gap: scaleSpacing(14),
    maxWidth: isTablet ? 560 : 480,
    width: '100%',
    alignSelf: 'center',
    marginBottom: scaleSpacing(24),
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    color: '#EEEEF6',
    paddingVertical: scaleSpacing(16),
    paddingHorizontal: scaleSpacing(20),
    borderRadius: scaleSpacing(14),
    fontSize: scale(16),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  btnPrimary: {
    backgroundColor: '#6C5CE7',
    borderWidth: 0,
    borderColor: 'transparent',
    paddingVertical: scaleSpacing(16),
    paddingHorizontal: scaleSpacing(24),
    borderRadius: scaleSpacing(14),
    alignItems: 'center',
    width: '100%',
    marginTop: scaleSpacing(10),
  },
  btnSecondary: {
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(20),
    alignItems: 'center',
  },
  btnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: scale(16),
    letterSpacing: -0.2,
  },
  btnDanger: {
    backgroundColor: 'rgba(255,68,102,0.1)',
    padding: scaleSpacing(16),
    borderRadius: scaleSpacing(14),
    alignItems: 'center',
    width: '100%',
    marginTop: scaleSpacing(12),
    borderWidth: 1,
    borderColor: 'rgba(255,68,102,0.3)',
  },
  btnDangerText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: scale(15),
  },
  btnTextSec: {
    color: '#8888A0',
    fontSize: scale(16),
  },
  authFooter: {
    alignItems: 'center',
    paddingVertical: scaleSpacing(20),
    paddingBottom: scaleSpacing(40),
  },
  footerText: {
    color: '#4E4E66',
    fontSize: scale(12),
  },
  // Main Screen
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: scaleSpacing(20),
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + scaleSpacing(4) : 50,
    paddingBottom: scaleSpacing(12),
    backgroundColor: '#030308',
  },
  headerTitle: {
    fontSize: scale(26),
    fontWeight: '900',
    color: '#EEEEF6',
    letterSpacing: -1,
  },
  headerSubtitle: {
    fontSize: scale(13),
    color: '#6C6C90',
    marginTop: 3,
  },
  logoutBtn: {
    backgroundColor: 'rgba(255,68,102,0.08)',
    paddingHorizontal: scaleSpacing(14),
    paddingVertical: scaleSpacing(8),
    borderRadius: scaleSpacing(10),
    borderWidth: 1,
    borderColor: 'rgba(255,68,102,0.15)',
  },
  logoutText: {
    color: '#FF4466',
    fontSize: scale(13),
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
    padding: Math.max(scaleSpacing(16), SCREEN_WIDTH * 0.04),
    maxWidth: isTablet ? 800 : 600,
    width: '100%',
    alignSelf: 'center',
  },
  statusCard: {
    backgroundColor: '#0A0A14',
    padding: scaleSpacing(20),
    borderRadius: scaleSpacing(18),
    marginBottom: scaleSpacing(24),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderLeftWidth: 3,
    borderLeftColor: '#6C5CE7',
  },
  statusCardGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    ...Platform.select({
      ios: {
        shadowColor: '#6C5CE7',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 12,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  statusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: scaleSpacing(12),
  },
  statusLabel: {
    color: '#A78BFA',
    fontWeight: '800',
    fontSize: scale(12),
    letterSpacing: 2,
  },
  statusText: {
    color: '#F4F4F8',
    fontSize: scale(16),
    flexShrink: 1,
  },
  progressBar: {
    height: isTablet ? 8 : 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: isTablet ? 4 : 3,
    marginTop: scaleSpacing(12),
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#6C5CE7',
    borderRadius: 3,
  },
  actionsContainer: {
    flex: 1,
    gap: scaleSpacing(12),
    marginBottom: scaleSpacing(20),
  },
  actionCard: {
    flex: 1,
    padding: scaleSpacing(18),
    borderRadius: scaleSpacing(16),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    minHeight: isTablet ? 100 : 80,
  },
  backupCard: {
    backgroundColor: 'rgba(108,92,231,0.08)',
    borderColor: 'rgba(108,92,231,0.3)',
  },
  backupCardGlass: {
    backgroundColor: 'rgba(108,92,231,0.06)',
    borderColor: 'rgba(108,92,231,0.25)',
    ...Platform.select({
      ios: {
        shadowColor: '#6C5CE7',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  syncCard: {
    backgroundColor: 'rgba(0,255,163,0.08)',
    borderColor: 'rgba(0,255,163,0.3)',
  },
  syncCardGlass: {
    backgroundColor: 'rgba(0,255,163,0.06)',
    borderColor: 'rgba(0,255,163,0.25)',
    ...Platform.select({
      ios: {
        shadowColor: '#00FFA3',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  cleanupCard: {
    backgroundColor: 'rgba(245,200,66,0.06)',
    borderColor: 'rgba(245,200,66,0.25)',
  },
  cleanupCardGlass: {
    backgroundColor: 'rgba(245,200,66,0.04)',
    borderColor: 'rgba(245,200,66,0.2)',
    ...Platform.select({
      ios: {
        shadowColor: '#F5C842',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  disabledCard: {
    opacity: 0.4,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.97)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: scaleSpacing(20),
  },
  overlayGlass: {
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  overlayCard: {
    width: '100%',
    maxWidth: isTablet ? 520 : 400,
    backgroundColor: '#0C0C16',
    borderRadius: scaleSpacing(22),
    padding: scaleSpacing(28),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  overlayCardGlass: {
    backgroundColor: '#0C0C12',
    borderColor: 'rgba(255,255,255,0.08)',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  overlayTitle: {
    color: '#F4F4F8',
    fontSize: scale(22),
    fontWeight: '900',
    marginBottom: scaleSpacing(8),
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  overlaySubtitle: {
    color: '#8888A0',
    fontSize: scale(14),
    lineHeight: scale(20),
    marginBottom: scaleSpacing(20),
    textAlign: 'center',
  },
  overlayBtnPrimary: {
    backgroundColor: 'rgba(108,92,231,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.3)',
    paddingVertical: scaleSpacing(14),
    borderRadius: scaleSpacing(14),
    alignItems: 'center',
    marginTop: scaleSpacing(8),
  },
  overlayBtnPrimaryGlass: {
    backgroundColor: 'rgba(3,225,255,0.1)',
    borderColor: 'rgba(3,225,255,0.3)',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  overlayBtnPrimaryText: {
    color: '#A78BFA',
    fontWeight: '800',
    fontSize: scale(16),
  },
  overlayBtnSecondary: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingVertical: scaleSpacing(14),
    borderRadius: scaleSpacing(14),
    alignItems: 'center',
    marginTop: scaleSpacing(8),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  overlayBtnSecondaryGlass: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: 'rgba(255,255,255,0.1)',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 6,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  overlayBtnSecondaryText: {
    color: '#F4F4F8',
    fontWeight: '600',
    fontSize: scale(16),
  },
  overlayBtnGhost: {
    paddingVertical: scaleSpacing(14),
    alignItems: 'center',
    marginTop: scaleSpacing(12),
  },
  overlayBtnGhostGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 10,
  },
  overlayBtnGhostText: {
    color: '#5C5C72',
    fontSize: scale(15),
    fontWeight: '600',
  },
  pickerCard: {
    width: '100%',
    maxWidth: isTablet ? 800 : 650,
    maxHeight: '86%',
    backgroundColor: '#0C0C12',
    borderRadius: scaleSpacing(18),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  pickerCardGlass: {
    backgroundColor: 'rgba(12, 12, 18, 0.96)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    ...Platform.select({
      ios: {
        shadowColor: '#6C5CE7',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: {
        elevation: 5,
      },
    }),
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: scaleSpacing(12),
    paddingVertical: scaleSpacing(10),
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    backgroundColor: '#040406',
  },
  pickerHeaderBtn: {
    paddingHorizontal: scaleSpacing(10),
    paddingVertical: scaleSpacing(8),
  },
  pickerHeaderBtnText: {
    color: THEME.accent,
    fontSize: scale(14),
    fontWeight: '700',
  },
  pickerHeaderTitle: {
    color: '#F4F4F8',
    fontSize: scale(14),
    fontWeight: '800',
  },
  pickerHeaderSubtitle: {
    color: '#5C5C72',
    fontSize: scale(12),
    marginTop: 2,
  },
  pickerGrid: {
    padding: scaleSpacing(10),
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  pickerItem: {
    width: isTablet ? '24%' : '32%',
    aspectRatio: 1,
    borderRadius: scaleSpacing(12),
    overflow: 'hidden',
    marginBottom: scaleSpacing(8),
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  pickerItemSelected: {
    borderColor: THEME.accent,
  },
  pickerItemSelectedGreen: {
    borderColor: THEME.secondary,
  },
  pickerThumb: {
    width: '100%',
    height: '100%',
  },
  pickerBadge: {
    position: 'absolute',
    left: scaleSpacing(6),
    bottom: scaleSpacing(6),
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: scaleSpacing(8),
    paddingHorizontal: scaleSpacing(8),
    paddingVertical: scaleSpacing(4),
  },
  pickerBadgeText: {
    color: '#F4F4F8',
    fontSize: scale(10),
    fontWeight: '800',
  },
  pickerCheck: {
    position: 'absolute',
    right: scaleSpacing(6),
    top: scaleSpacing(6),
    width: isTablet ? 28 : 22,
    height: isTablet ? 28 : 22,
    borderRadius: isTablet ? 14 : 11,
    backgroundColor: 'rgba(3, 225, 255, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerCheckGreen: {
    position: 'absolute',
    right: scaleSpacing(6),
    top: scaleSpacing(6),
    width: isTablet ? 28 : 22,
    height: isTablet ? 28 : 22,
    borderRadius: isTablet ? 14 : 11,
    backgroundColor: 'rgba(0, 255, 163, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerCheckText: {
    color: '#000000',
    fontWeight: '900',
    fontSize: scale(14),
    includeFontPadding: false,
  },
  syncPickerList: {
    padding: scaleSpacing(10),
  },
  syncPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: scaleSpacing(12),
    paddingHorizontal: scaleSpacing(12),
    borderRadius: scaleSpacing(14),
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: scaleSpacing(10),
  },
  syncPickerRowSelected: {
    borderColor: THEME.secondary,
  },
  syncPickerRowLeft: {
    flex: 1,
    paddingRight: scaleSpacing(12),
  },
  syncPickerRowTitle: {
    color: '#F4F4F8',
    fontSize: scale(13),
    fontWeight: '800',
    marginBottom: scaleSpacing(4),
  },
  syncPickerRowMeta: {
    color: '#5C5C72',
    fontSize: scale(12),
  },
  syncPickerCheck: {
    width: isTablet ? 30 : 24,
    height: isTablet ? 30 : 24,
    borderRadius: isTablet ? 15 : 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1),',
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncPickerCheckOn: {
    backgroundColor: 'rgba(0, 255, 163, 0.92)',
    borderColor: 'rgba(0, 255, 163, 0.92)',
  },
  syncPickerCheckText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: scale(14),
  },
  syncPickerCheckTextOn: {
    color: '#000000',
  },
  cardIcon: {
    width: isTablet ? 56 : 44,
    height: isTablet ? 56 : 44,
    borderRadius: isTablet ? 16 : 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: scaleSpacing(10),
  },
  cardIconText: {
    fontSize: scale(24),
  },
  cardTitle: {
    fontSize: scale(16),
    fontWeight: '800',
    color: '#F4F4F8',
    marginBottom: scaleSpacing(4),
    letterSpacing: -0.3,
  },
  cardDescription: {
    fontSize: scale(SCREEN_WIDTH < 380 ? 12 : 13),
    color: '#8888A0',
    lineHeight: scale(SCREEN_WIDTH < 380 ? 17 : 18),
  },
  infoCard: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    padding: scaleSpacing(16),
    borderRadius: scaleSpacing(14),
    borderLeftWidth: isTablet ? 4 : 3,
    borderLeftColor: '#6C5CE7',
  },
  infoCardGlass: {
    backgroundColor: 'rgba(3, 225, 255, 0.06)',
  },
  infoText: {
    color: '#8888A0',
    fontSize: scale(13),
  },
  // Server configuration
  serverConfig: {
    marginBottom: scaleSpacing(20),
  },
  serverLabel: {
    color: '#5C5C72',
    fontSize: scale(12),
    marginBottom: scaleSpacing(8),
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  serverToggle: {
    flexDirection: 'row',
    gap: scaleSpacing(SCREEN_WIDTH < 380 ? 6 : 10),
    marginTop: scaleSpacing(12),
  },
  serverExplanation: {
    marginTop: scaleSpacing(12),
    padding: scaleSpacing(12),
    backgroundColor: '#0C0C12',
    borderRadius: scaleSpacing(10),
    borderLeftWidth: isTablet ? 4 : 3,
    borderLeftColor: THEME.primary,
  },
  serverExplanationText: {
    color: '#9898B0',
    fontSize: scale(13),
    lineHeight: scale(20),
  },
  toggleBtn: {
    flex: 1,
    minHeight: isTablet ? 50 : (SCREEN_WIDTH < 380 ? 38 : 42),
    paddingVertical: scaleSpacing(SCREEN_WIDTH < 380 ? 8 : 10),
    paddingHorizontal: scaleSpacing(SCREEN_WIDTH < 380 ? 8 : 12),
    borderRadius: scaleSpacing(12),
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleBtnActive: {
    backgroundColor: 'rgba(108,92,231,0.12)',
    borderColor: 'rgba(108,92,231,0.35)',
  },
  toggleText: {
    color: '#5C5C72',
    fontSize: scale(SCREEN_WIDTH < 380 ? 12 : 13),
    fontWeight: '600',
    textAlign: 'center',
    includeFontPadding: false,
  },
  toggleTextActive: {
    color: '#F4F4F8',
  },
  serverHint: {
    color: '#4E4E66',
    fontSize: scale(12),
    marginTop: scaleSpacing(8),
    textAlign: 'center',
  },
  // Settings screen
  settingsCard: {
    backgroundColor: '#0A0A14',
    padding: scaleSpacing(20),
    borderRadius: scaleSpacing(16),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: scaleSpacing(14),
  },
  glassCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1.5,
    ...Platform.select({
      ios: {
        shadowColor: '#6C5CE7',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 10,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  settingsTitle: {
    fontSize: scale(22),
    fontWeight: '900',
    color: '#F4F4F8',
    marginBottom: scaleSpacing(6),
    letterSpacing: -0.5,
  },
  settingsDescription: {
    fontSize: scale(14),
    color: '#8888A0',
    marginBottom: scaleSpacing(16),
  },
  uuidBox: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: scaleSpacing(12),
    borderRadius: scaleSpacing(8),
    marginBottom: scaleSpacing(16),
  },
  uuidLabel: {
    fontSize: scale(11),
    color: '#5C5C72',
    marginBottom: scaleSpacing(6),
  },
  uuidText: {
    fontSize: scale(11),
    color: '#A78BFA',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  inputLabel: {
    color: '#8888A0',
    fontSize: scale(14),
    marginBottom: scaleSpacing(8),
    marginTop: scaleSpacing(16),
  },
  inputHint: {
    color: '#4E4E66',
    fontSize: scale(12),
    marginTop: scaleSpacing(6),
    fontStyle: 'italic',
  },
  stealthPlanBox: {
    marginTop: scaleSpacing(14),
    padding: scaleSpacing(14),
    borderRadius: scaleSpacing(14),
    backgroundColor: '#0C0C12',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  stealthPlanHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: scaleSpacing(8),
  },
  stealthPlanTitle: {
    color: '#F4F4F8',
    fontSize: scale(14),
    fontWeight: '700',
  },
  stealthPlanHint: {
    color: '#5C5C72',
    fontSize: scale(12),
    marginBottom: scaleSpacing(10),
  },
  stealthPlanGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: scaleSpacing(4),
  },
  stealthPlanCard: {
    flexBasis: isTablet ? '23%' : '24%',
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: scaleSpacing(10),
    padding: scaleSpacing(8),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    minHeight: isTablet ? 90 : 70,
  },
  stealthPlanCardSelected: {
    borderColor: THEME.primary,
  },
  stealthPlanCardDisabled: {
    opacity: 0.55,
  },
  stealthPlanGb: {
    color: '#F4F4F8',
    fontSize: scale(13),
    fontWeight: '800',
    marginBottom: scaleSpacing(4),
  },
  stealthPlanMeta: {
    color: '#5C5C72',
    fontSize: scale(9),
    marginBottom: scaleSpacing(6),
  },
  stealthPlanSoldOut: {
    color: '#FFB74D',
    fontSize: scale(11),
    lineHeight: scale(14),
  },
  stealthPlanPrice: {
    color: THEME.secondary,
    fontSize: scale(11),
    fontWeight: '700',
    marginBottom: scaleSpacing(2),
  },
  usageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: scaleSpacing(8),
  },
  usageItem: {
    width: '50%',
    paddingRight: scaleSpacing(10),
    marginBottom: scaleSpacing(10),
  },
  restorePurchasesBtn: {
    marginTop: scaleSpacing(12),
    paddingVertical: scaleSpacing(10),
    alignItems: 'center',
  },
  restorePurchasesText: {
    color: THEME.primary,
    fontSize: scale(14),
    fontWeight: '500',
  },
  serverInfo: {
    marginTop: scaleSpacing(16),
    padding: scaleSpacing(12),
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: scaleSpacing(10),
  },
  serverInfoLabel: {
    color: '#5C5C72',
    fontSize: scale(11),
    marginBottom: scaleSpacing(4),
  },
  serverInfoText: {
    color: '#8888A0',
    fontSize: scale(12),
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  serverHelp: {
    marginTop: scaleSpacing(16),
    padding: scaleSpacing(14),
    backgroundColor: '#0C0C12',
    borderRadius: scaleSpacing(12),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  serverHelpTitle: {
    color: '#F4F4F8',
    fontSize: scale(15),
    fontWeight: '700',
    marginBottom: scaleSpacing(8),
  },
  serverHelpSubtitle: {
    color: '#9898B0',
    fontSize: scale(13),
    fontWeight: '600',
    marginTop: scaleSpacing(6),
    marginBottom: scaleSpacing(4),
  },
  serverHelpText: {
    color: '#8888A0',
    fontSize: scale(12),
    lineHeight: scale(18),
    marginLeft: scaleSpacing(4),
  },
  headerButtons: {
    flexDirection: 'row',
    gap: scaleSpacing(10),
  },
  infoBtn: {
    backgroundColor: 'transparent',
    width: isTablet ? 44 : 36,
    height: isTablet ? 44 : 36,
    borderRadius: isTablet ? 22 : 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
  },
  infoBtnText: {
    fontSize: scale(20),
    fontWeight: 'bold',
    color: '#A78BFA',
  },
  settingsBtn: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: scaleSpacing(12),
    paddingVertical: scaleSpacing(8),
    borderRadius: scaleSpacing(8),
  },
  settingsText: {
    fontSize: scale(20),
  },
  backBtn: {
    paddingHorizontal: scaleSpacing(16),
    paddingVertical: scaleSpacing(8),
  },
  backText: {
    color: '#A78BFA',
    fontSize: scale(16),
  },
  // Setup Guide
  guideSteps: {
    marginTop: scaleSpacing(16),
    gap: scaleSpacing(16),
  },
  guideStep: {
    flexDirection: 'row',
    gap: scaleSpacing(12),
  },
  stepNumber: {
    width: isTablet ? 40 : 32,
    height: isTablet ? 40 : 32,
    borderRadius: isTablet ? 20 : 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: '#F4F4F8',
    fontSize: scale(16),
    fontWeight: 'bold',
    textAlign: 'center',
    lineHeight: isTablet ? 40 : 32,
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    color: '#F4F4F8',
    fontSize: scale(16),
    fontWeight: '600',
    marginBottom: scaleSpacing(4),
  },
  stepText: {
    color: '#8888A0',
    fontSize: scale(14),
    lineHeight: scale(20),
  },
  // How It Works
  howItWorksText: {
    color: '#9898B0',
    fontSize: scale(14),
    lineHeight: scale(22),
    marginTop: scaleSpacing(12),
  },
  boldText: {
    color: '#F4F4F8',
    fontWeight: '600',
  },
  setupGuideBtn: {
    backgroundColor: THEME.primary,
    padding: scaleSpacing(18),
    borderRadius: scaleSpacing(16),
    alignItems: 'center',
    width: '100%',
    marginBottom: scaleSpacing(12),
  },
  setupGuideBtnText: {
    color: '#FFFFFF',
    fontSize: scale(15),
    fontWeight: '700',
  },
  quickStepsTitle: {
    color: '#F4F4F8',
    fontSize: scale(14),
    fontWeight: '600',
    marginBottom: scaleSpacing(8),
  },
  quickStepsText: {
    color: '#9898B0',
    fontSize: scale(13),
    lineHeight: scale(22),
  },
  linkList: {
    gap: scaleSpacing(8),
    marginTop: scaleSpacing(8),
  },
  linkButton: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingVertical: scaleSpacing(10),
    paddingHorizontal: scaleSpacing(14),
    borderRadius: scaleSpacing(10),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  linkButtonText: {
    color: '#F4F4F8',
    fontSize: scale(13),
    fontWeight: '600',
  },
  codeLine: {
    color: '#F4F4F8',
    fontSize: scale(12),
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingVertical: scaleSpacing(6),
    paddingHorizontal: scaleSpacing(10),
    borderRadius: scaleSpacing(6),
    marginTop: scaleSpacing(2),
  },
  codeHint: {
    color: '#5C5C72',
    fontSize: scale(11),
    marginTop: scaleSpacing(2),
  },
  guideStepNumber: {
    width: isTablet ? 40 : 32,
    height: isTablet ? 40 : 32,
    borderRadius: isTablet ? 20 : 16,
    backgroundColor: THEME.primary,
    color: '#FFFFFF',
    fontSize: scale(16),
    fontWeight: 'bold',
    textAlign: 'center',
    lineHeight: isTablet ? 40 : 32,
  },
  guideStepContent: {
    flex: 1,
  },
  guideStepTitle: {
    color: '#F4F4F8',
    fontSize: scale(15),
    fontWeight: '600',
    marginBottom: scaleSpacing(4),
  },
  guideStepDesc: {
    color: '#8888A0',
    fontSize: scale(13),
    lineHeight: scale(18),
  },
  copyLinkBtn: {
    backgroundColor: THEME.primary,
    paddingVertical: scaleSpacing(8),
    paddingHorizontal: scaleSpacing(16),
    borderRadius: scaleSpacing(10),
    marginTop: scaleSpacing(8),
    alignSelf: 'flex-start',
  },
  copyLinkText: {
    color: '#FFFFFF',
    fontSize: scale(14),
    fontWeight: '700',
  },
  // Resources
  resourceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.02)',
    paddingVertical: scaleSpacing(14),
    paddingHorizontal: scaleSpacing(16),
    borderRadius: scaleSpacing(14),
    marginBottom: scaleSpacing(10),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  resourceIcon: {
    fontSize: scale(22),
    marginRight: scaleSpacing(10),
  },
  resourceContent: {
    flex: 1,
  },
  resourceTitle: {
    color: '#F4F4F8',
    fontSize: scale(14),
    fontWeight: '600',
    marginBottom: scaleSpacing(2),
  },
  resourceDesc: {
    color: '#5C5C72',
    fontSize: scale(12),
  },
  resourceArrow: {
    color: '#4E4E66',
    fontSize: scale(20),
    fontWeight: 'bold',
  },
  openSourceBadge: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingVertical: scaleSpacing(10),
    paddingHorizontal: scaleSpacing(12),
    borderRadius: scaleSpacing(10),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginTop: scaleSpacing(6),
  },
  openSourceText: {
    color: '#5C5C72',
    fontSize: scale(12),
    textAlign: 'center',
    fontWeight: '600',
  },
  // Settings Footer
  settingsFooter: {
    alignItems: 'center',
    paddingVertical: scaleSpacing(16),
    gap: scaleSpacing(6),
  },
  footerVersion: {
    color: '#4E4E66',
    fontSize: scale(12),
    textAlign: 'center',
  },
  footerCopyright: {
    color: '#4E4E66',
    fontSize: scale(12),
  },
});
