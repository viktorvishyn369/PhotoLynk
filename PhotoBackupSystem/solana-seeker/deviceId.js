// PhotoLynk Mobile App - Device ID Helpers
// Computes stable hardware IDs for Android and iOS devices

import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { v4 as uuidv4 } from 'uuid';
import { sha256 } from 'js-sha256';

// SecureStore keys
const ANDROID_HW_ID_KEY = 'android_hardware_device_id';
const IOS_HW_ID_KEY = 'ios_hardware_device_id';

/**
 * Compute a stable Android hardware ID.
 * Strategy: Use Application.androidId (SSAID) which is stable per app+device combo on Android 8+.
 * For devices where androidId is null (rare, some custom ROMs/emulators), use deterministic hash.
 * This works across: Pixel, Samsung, Xiaomi, Huawei, Oppo, OnePlus, Solana Mobile, etc.
 */
export const computeAndroidHardwareId = async () => {
  // 1) Primary: Application.androidId (SSAID)
  // - Unique per app signing key + device combination
  // - Persists across app reinstalls (same signing key)
  // - Persists across OS updates
  // - Available on Android 8.0+ (API 26+), which covers 99%+ of active devices
  const androidId = Application.androidId;
  if (androidId) {
    console.log('Android HW ID: using androidId (SSAID)');
    return androidId;
  }

  // 2) Fallback: Deterministic hash from immutable device properties
  // Used only when androidId is null (emulators, some custom ROMs)
  // These properties are set at factory and never change:
  // - brand: Device brand (e.g., "google", "samsung", "xiaomi", "solana")
  // - manufacturer: Hardware manufacturer
  // - modelName: Marketing model name (e.g., "Pixel 8", "Galaxy S24", "Seeker")
  // - productName: Internal product codename (stable across OS updates)
  const parts = [
    Device.brand,
    Device.manufacturer,
    Device.modelName,
    Device.productName,
  ].filter(Boolean);

  // Add Application.applicationId (package name) to make it app-specific
  // This ensures different apps on same device get different IDs
  if (Application.applicationId) {
    parts.push(Application.applicationId);
  }

  console.log('Android HW ID: androidId null, using device fingerprint:', parts.join('|'));

  if (parts.length >= 3) {
    const hash = sha256(parts.join('|'));
    const hwId = `android_hw_${hash.slice(0, 32)}`;
    console.log('Android HW ID: generated deterministic:', hwId);
    return hwId;
  }

  // 3) Last resort: stored UUID (won't survive reinstall, but covers edge cases)
  try {
    const stored = await SecureStore.getItemAsync(ANDROID_HW_ID_KEY);
    if (stored) {
      console.log('Android HW ID: using stored UUID');
      return stored;
    }
  } catch (e) {
    console.log('ANDROID_HW_ID_KEY read error:', e);
  }

  // Generate and store new UUID
  const hwId = `android_fallback_${uuidv4()}`;
  console.log('Android HW ID: generated new UUID fallback');
  try {
    await SecureStore.setItemAsync(ANDROID_HW_ID_KEY, hwId);
  } catch (e) {
    console.log('ANDROID_HW_ID_KEY write error:', e);
  }

  return hwId;
};

/**
 * Compute a stable iOS hardware ID.
 * Order: return stored keychain value if present; else use IDFV and persist; else generate and persist.
 */
export const computeIosHardwareId = async () => {
  const secureStoreOpts = {
    keychainService: 'photolynk_hw_id',
    accessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
  };

  // 1) Prefer previously stored value (persists in keychain across reinstall/reboot)
  try {
    const stored = await SecureStore.getItemAsync(IOS_HW_ID_KEY, secureStoreOpts);
    if (stored) return stored;
  } catch (e) {
    console.log('IOS_HW_ID_KEY read error:', e);
  }

  // 2) Use IDFV if available, and persist it for future reinstall/reboot
  try {
    const idfv = await Application.getIosIdForVendorAsync();
    if (idfv) {
      try { await SecureStore.setItemAsync(IOS_HW_ID_KEY, idfv, secureStoreOpts); } catch (e) {}
      return idfv;
    }
  } catch (e) {
    console.log('IDFV error:', e);
  }

  // 3) Fallback: generate and persist
  const generated = `ios_hw_${uuidv4()}`;
  try { await SecureStore.setItemAsync(IOS_HW_ID_KEY, generated, secureStoreOpts); } catch (e) {}
  return generated;
};

/**
 * Get device hardware ID for current platform
 */
export const getDeviceHardwareId = async () => {
  if (Platform.OS === 'ios') {
    return computeIosHardwareId();
  } else {
    return computeAndroidHardwareId();
  }
};
