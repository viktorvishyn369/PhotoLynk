// PhotoLynk Mobile App - Auto Upload Helpers

import { Platform, AppState, PermissionsAndroid, NativeModules } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as MediaLibrary from 'expo-media-library';
import * as Network from 'expo-network';
import * as Battery from 'expo-battery';
import * as KeepAwake from 'expo-keep-awake';
import { v5 as uuidv5 } from 'uuid';
import { normalizeEmailForDeviceUuid, sanitizeStoreKey } from './utils';
import { startBackgroundService, stopBackgroundService } from './serviceController';

// Constants
export const AUTO_UPLOAD_KEEP_AWAKE_TAG = 'photolynk-auto-upload-runner';
export const AUTO_UPLOAD_BACKGROUND_TASK = 'photolynk-auto-upload';
export const AUTO_UPLOAD_CURSOR_KEY_PREFIX = 'auto_upload_cursor_v1';
export const AUTO_UPLOAD_POLICY_POLL_MS = 60 * 1000;
export const SAVED_PASSWORD_KEY = 'user_password_v1';
export const SAVED_PASSWORD_EMAIL_KEY = 'user_password_email_v1';
export const MB = 1024 * 1024;

// Basic background policy check (global version)
export const ensureAutoUploadPolicyAllowsWorkIfBackgroundedGlobal = async () => {
  if (Platform.OS === 'ios') {
    const state = AppState.currentState;
    if (state !== 'active') return false;
  }
  return true;
};

// KeepAwake helpers
export const activateKeepAwakeForAutoUpload = async () => {
  try {
    if (typeof KeepAwake.activateKeepAwakeAsync === 'function') {
      await KeepAwake.activateKeepAwakeAsync(AUTO_UPLOAD_KEEP_AWAKE_TAG);
    } else if (typeof KeepAwake.activateKeepAwake === 'function') {
      KeepAwake.activateKeepAwake();
    }
  } catch (e) {}
};

export const deactivateKeepAwakeForAutoUpload = async () => {
  try {
    if (typeof KeepAwake.deactivateKeepAwakeAsync === 'function') {
      await KeepAwake.deactivateKeepAwakeAsync(AUTO_UPLOAD_KEEP_AWAKE_TAG);
    } else if (typeof KeepAwake.deactivateKeepAwake === 'function') {
      KeepAwake.deactivateKeepAwake();
    }
  } catch (e) {}
};

// Cursor key helpers
export const buildAutoUploadCursorKey = (email) => {
  const normalized = normalizeEmailForDeviceUuid(email);
  if (!normalized) return AUTO_UPLOAD_CURSOR_KEY_PREFIX;
  return `${AUTO_UPLOAD_CURSOR_KEY_PREFIX}:${normalized}`;
};

export const getAutoUploadCursorKey = async () => {
  let storedEmail = null;
  try { storedEmail = await SecureStore.getItemAsync('user_email'); } catch (e) { storedEmail = null; }
  return buildAutoUploadCursorKey(storedEmail);
};

// Photo access check
export const checkPhotoAccessForAutoUpload = async () => {
  let permission = null;
  try { permission = await MediaLibrary.getPermissionsAsync(); } catch (e) { permission = null; }
  if (!permission || permission.status !== 'granted') {
    try { permission = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']); } catch (e) { permission = null; }
    if (!permission || permission.status !== 'granted') return { granted: false, limited: false };
  }
  const privileges = await getMediaLibraryAccessPrivileges(permission);
  const limited = Platform.OS === 'ios' && privileges && privileges !== 'all';
  return { granted: true, limited };
};

export const getMediaLibraryAccessPrivileges = async (permission) => {
  const ap = permission && typeof permission.accessPrivileges === 'string' ? permission.accessPrivileges : null;
  if (ap) return ap;
  try {
    const p2 = await MediaLibrary.getPermissionsAsync();
    return p2 && typeof p2.accessPrivileges === 'string' ? p2.accessPrivileges : null;
  } catch (e) { return null; }
};

// Album helper
export const findFirstAlbumByTitle = (albums, titles) => {
  const list = Array.isArray(albums) ? albums : [];
  const wanted = Array.isArray(titles) ? titles : [];
  for (const t of wanted) {
    const title = String(t || '');
    if (!title) continue;
    const found = list.find(a => a && a.title === title);
    if (found) return found;
  }
  return null;
};

// Android notification permission
export const ensureAndroidNotificationPermission = async () => {
  if (Platform.OS !== 'android') return true;
  if (typeof Platform.Version !== 'number') return true;
  if (Platform.Version < 33) return true;
  try {
    const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return res === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) { return false; }
};

// Android foreground service helpers
// Delegates to the PhotoLynk foreground service (serviceController.js)
export const startAndroidForegroundUploadService = async ({ title, text }) => {
  await startBackgroundService(title || 'Auto Upload', text || 'Uploading in background');
};

export const stopAndroidForegroundUploadService = async () => {
  stopBackgroundService();
};

// Policy state evaluation
export const evaluateAutoUploadPolicyState = async () => {
  let net = null;
  try { net = await Network.getNetworkStateAsync(); } catch (e) { net = null; }
  const netType = net && net.type != null ? net.type : null;
  const netConnected = !!(net && (net.isConnected || net.isInternetReachable));
  console.log('Network state:', { net, netType, netConnected });
  // Only allow WiFi, not mobile data (3G/4G/LTE/5G)
  const wifiOk = netConnected && (netType === Network.NetworkStateType.WIFI || netType === 'wifi');

  let power = null;
  try { power = await Battery.getPowerStateAsync(); } catch (e2) { power = null; }
  console.log('Power state raw:', power);
  let bs = power && power.batteryState != null ? power.batteryState : null;
  const chargingFlags = [];

  if (bs == null || bs === Battery.BatteryState.UNKNOWN || bs === 'unknown') {
    try {
      const fallback = await Battery.getBatteryStateAsync();
      if (fallback != null) bs = fallback;
    } catch (e3) {
      // ignore
    }
  }

  let chargingOk = (
    bs === Battery.BatteryState.CHARGING ||
    bs === Battery.BatteryState.FULL ||
    bs === 'charging' ||
    bs === 'full' ||
    bs === 2 ||
    bs === 3
  );

  if (!chargingOk) {
    const boolFlags = [
      power && typeof power.isCharging === 'boolean' ? power.isCharging : null,
      power && typeof power.charging === 'boolean' ? power.charging : null,
    ].filter(v => v !== null);
    chargingFlags.push(...boolFlags);
    if (boolFlags.some(Boolean)) {
      chargingOk = true;
    }
  }

  if (!chargingOk) {
    try {
      const direct = await Battery.isBatteryChargingAsync();
      chargingFlags.push(direct);
      if (direct) chargingOk = true;
    } catch (e4) {
      chargingFlags.push('isBatteryChargingAsync_error');
    }
  }

  const lowPower = !!(power && power.lowPowerMode);

  // batteryLevel can be -1 (unavailable) on some devices - treat as null
  const rawBatteryLevel = power && typeof power.batteryLevel === 'number' ? power.batteryLevel : null;
  const batteryLevel = rawBatteryLevel !== null && rawBatteryLevel >= 0 ? rawBatteryLevel : null;
  const batteryOk = batteryLevel !== null && batteryLevel >= 0.50;
  const overallPowerOk = chargingOk || batteryOk;

  let reason = null;
  if (!wifiOk) {
    reason = 'Auto-Backup: Waiting for WiFi';
  } else if (!batteryOk && !chargingOk) {
    const pct = batteryLevel !== null ? `${Math.round(batteryLevel * 100)}%` : '';
    reason = pct ? `Plug in charger (${pct})` : 'Plug in charger';
  } else if (lowPower) {
    reason = 'Low Power Mode enabled';
  }
  console.log('AutoUploadPolicyState:', {
    ok: overallPowerOk && !lowPower && wifiOk,
    wifiOk,
    chargingOk,
    batteryOk,
    batteryLevel,
    overallPowerOk,
    lowPower,
    reason,
    powerState: power,
    batteryState: bs,
    chargingFlags,
  });

  return {
    ok: overallPowerOk && !lowPower && wifiOk,
    wifiOk,
    chargingOk,
    batteryOk,
    batteryLevel,
    overallPowerOk,
    lowPower,
    reason,
    powerState: power,
    batteryState: bs,
    chargingFlags,
  };
};

// Logging helper
export const logAutoUploadRunnerCondition = (condition, details) => console.log(`AutoUploadRunner: ${condition}`, details);

// Background eligibility check
export const autoUploadEligibilityForBackground = async () => {
  try {
    const state = await evaluateAutoUploadPolicyState();
    if (!state.ok) { logAutoUploadRunnerCondition('policy not ok', { reason: state.reason }); return { ok: false, reason: state.reason }; }
    if (!state.wifiOk) return { ok: false, reason: 'wifi' };
    if (!state.chargingOk) return { ok: false, reason: 'charging' };
    if (state.lowPower) return { ok: false, reason: 'low_power' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'error' }; }
};

// Device UUID from email
export const autoUploadGetDeviceUuidFromEmail = async (userEmail, clientBuild) => {
  const normalizedEmail = normalizeEmailForDeviceUuid(userEmail);
  if (!normalizedEmail) return null;
  const password = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, { requireAuthentication: false });
  if (!password) return null;
  const combined = normalizedEmail + ':' + password;
  const persistedKey = sanitizeStoreKey(`device_uuid_v3:${normalizedEmail}`);
  let persisted = null;
  try { persisted = await SecureStore.getItemAsync(persistedKey); } catch (e) { persisted = null; }
  if (persisted) return persisted;
  // If a migration lock exists, the UUID must come from the persisted key (set during
  // legacy→wallet migration). If it's missing here, fall back to device_uuid store.
  let isMigrated = false;
  try { isMigrated = (await SecureStore.getItemAsync(sanitizeStoreKey(`uuid_migrated_lock:${normalizedEmail}`))) === 'true'; } catch (e) {}
  if (isMigrated) {
    try { const fallback = await SecureStore.getItemAsync('device_uuid'); if (fallback) return fallback; } catch (e) {}
  }
  const newUuid = uuidv5(combined, uuidv5.DNS);
  try { await SecureStore.setItemAsync(persistedKey, newUuid); } catch (e) {}
  return newUuid;
};

// Auth headers from SecureStore (for background task)
export const autoUploadGetAuthHeadersFromSecureStore = async (clientBuild) => {
  const token = await SecureStore.getItemAsync('auth_token');
  const storedEmail = await SecureStore.getItemAsync('user_email');
  const uuid = await autoUploadGetDeviceUuidFromEmail(storedEmail);
  if (!token || !uuid) return null;
  return { headers: { 'Authorization': `Bearer ${token}`, 'X-Device-UUID': uuid, 'X-Client-Build': clientBuild } };
};
