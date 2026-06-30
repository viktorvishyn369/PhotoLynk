// PhotoLynk Mobile App - Auth Helpers
// Core authentication logic extracted from App.js

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import axios from 'axios';

import { v5 as uuidv5 } from 'uuid';
import { normalizeEmailForDeviceUuid, normalizeHostInput, computeServerUrl, isSeekerIdFormat, normalizeSeekerIdForStorage, sanitizeStoreKey } from './utils';
import { computeIosHardwareId, computeAndroidHardwareId } from './deviceId';
import { t } from './i18n';

// Constants
export const SAVED_PASSWORD_KEY = 'user_password_v1';
export const SAVED_PASSWORD_EMAIL_KEY = 'user_password_email_v1';

/**
 * Validates auth form inputs before submission.
 * Accepts either email (user@example.com) or Seeker ID (alice.skr, alice)
 * @param {Object} params
 * @param {string} params.email - User email or Seeker ID
 * @param {string} params.password - User password
 * @param {string} params.confirmPassword - Confirm password (for registration)
 * @param {string} params.type - 'login' or 'register'
 * @returns {{ valid: boolean, error?: string, normalizedEmail?: string, isSeekerAuth?: boolean }}
 */
export const validateAuthInputs = ({ email, password, confirmPassword, type }) => {
  if (!email || !password) {
    return { valid: false, error: 'Please fill in all fields' };
  }

  const trimmedInput = String(email).trim();
  
  // Check if it's a Seeker ID/nickname or email
  const isSeekerAuth = isSeekerIdFormat(trimmedInput);
  const isEmail = trimmedInput.includes('@');
  
  // Must be either a valid Seeker ID/nickname or a valid email
  if (!isSeekerAuth && !isEmail) {
    return { valid: false, error: 'Please enter a valid email or Seeker ID (alice.skr or alice)' };
  }
  
  // Normalize to email format for storage and UUID generation
  // Seeker ID "alice" or "alice.skr" becomes "alice@photolynk.local"
  // This matches mobile-v2 nickname format for cross-app compatibility
  const normalizedEmail = normalizeEmailForDeviceUuid(trimmedInput);
  
  if (!normalizedEmail) {
    return { valid: false, error: 'Please enter a valid email or Seeker ID' };
  }

  if (type === 'register') {
    if (!confirmPassword) {
      return { valid: false, error: 'Please confirm your password' };
    }
    if (password !== confirmPassword) {
      return { valid: false, error: 'Passwords do not match' };
    }
  }

  return { valid: true, normalizedEmail, isSeekerAuth };
};

/**
 * Resolves effective server settings from state and persisted values.
 * @param {Object} params
 * @param {string} params.serverType - Current server type state
 * @param {string} params.localHost - Current local host state
 * @param {string} params.remoteHost - Current remote host state
 * @returns {Promise<{ effectiveType: string, effectiveLocalHost: string, effectiveRemoteHost: string }>}
 */
export const resolveEffectiveServerSettings = async ({ serverType, localHost, remoteHost }) => {
  const persistedType = await SecureStore.getItemAsync('server_type');
  const persistedLocalHost = await SecureStore.getItemAsync('local_host');
  const persistedRemoteHost = await SecureStore.getItemAsync('remote_host');

  const effectiveType = serverType || persistedType || 'local';
  const normalizedLocal = normalizeHostInput(localHost);
  const normalizedRemote = normalizeHostInput(remoteHost);
  const effectiveLocalHost = (effectiveType === 'local' && !normalizedLocal && persistedLocalHost)
    ? persistedLocalHost
    : localHost;
  const effectiveRemoteHost = (effectiveType === 'remote' && !normalizedRemote && persistedRemoteHost)
    ? persistedRemoteHost
    : remoteHost;

  return { effectiveType, effectiveLocalHost, effectiveRemoteHost };
};

/**
 * Persists server settings to SecureStore.
 * @param {Object} params
 * @param {string} params.effectiveType - Server type to persist
 * @param {string} params.effectiveLocalHost - Local host to persist
 * @param {string} params.effectiveRemoteHost - Remote host to persist
 */
export const persistServerSettings = async ({ effectiveType, effectiveLocalHost, effectiveRemoteHost }) => {
  await SecureStore.setItemAsync('server_type', effectiveType);
  if (effectiveType === 'remote') {
    await SecureStore.setItemAsync('remote_host', effectiveRemoteHost);
  } else if (effectiveType === 'local') {
    await SecureStore.setItemAsync('local_host', effectiveLocalHost);
  }
};

/**
 * Gets hardware device ID for password reset capability.
 * @returns {Promise<string|null>}
 */
export const getHardwareDeviceId = async () => {
  try {
    if (Platform.OS === 'ios') {
      return await computeIosHardwareId();
    } else if (Platform.OS === 'android') {
      return await computeAndroidHardwareId();
    }
  } catch (e) {
    console.log('Could not get hardware device ID:', e);
  }
  return null;
};

/**
 * Builds the auth request payload.
 * @param {Object} params
 * @param {string} params.normalizedEmail - Normalized email
 * @param {string} params.password - Password
 * @param {string} params.deviceId - Device UUID
 * @param {string} params.type - 'login' or 'register'
 * @param {string} params.effectiveType - Server type
 * @param {number|null} params.selectedStealthPlanGb - Selected plan (for registration)
 * @param {string|null} params.hardwareDeviceId - Hardware device ID (for registration)
 * @returns {Object} Payload object
 */
export const buildAuthPayload = ({
  normalizedEmail,
  password,
  deviceId,
  type,
  effectiveType,
  selectedStealthPlanGb,
  hardwareDeviceId,
  countryVerificationCode,
}) => {
  const payload = {
    email: normalizedEmail,
    password,
    device_uuid: deviceId,
    deviceUuid: deviceId,
    device_name: Platform.OS + ' ' + Platform.Version,
  };

  if (type === 'register' && hardwareDeviceId) {
    payload.hardware_device_id = hardwareDeviceId;
  }

  if (type === 'register' && effectiveType === 'stealthcloud' && selectedStealthPlanGb) {
    payload.plan_gb = selectedStealthPlanGb;
  }

  // Country verification code for new country login
  if (countryVerificationCode) {
    payload.country_verification_code = countryVerificationCode;
  }

  return payload;
};

/**
 * Resend country verification code
 * @param {Object} params
 * @param {string} params.email - User email
 * @param {string} params.countryCode - Country code to verify
 * @param {string} params.baseUrl - Server base URL
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export const resendCountryVerificationCode = async ({ email, countryCode, baseUrl }) => {
  try {
    await axios.post(`${baseUrl}/api/auth/resend-country-code`, {
      email,
      countryCode
    }, { timeout: 10000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.response?.data?.error || 'Failed to resend code' };
  }
};

/**
 * Stores credentials with biometrics after successful auth.
 * @param {Object} params
 * @param {string} params.password - Password to store
 * @param {string} params.normalizedEmail - Email to store
 * @param {string} params.type - 'login' or 'register'
 */
export const storeCredentialsWithBiometrics = async ({ password, normalizedEmail, type }) => {
  try {
    // Skip redundant biometric prompt if credentials already stored for same email.
    // On iOS, re-writing a biometric-protected key can trigger a second prompt
    // (delete existing + add new), so we avoid it when nothing changed.
    try {
      const storedEmail = await SecureStore.getItemAsync(SAVED_PASSWORD_EMAIL_KEY);
      const storedWithBiometric = (await SecureStore.getItemAsync('password_stored_with_biometric')) === 'true';
      if (storedEmail === normalizedEmail && storedWithBiometric) {
        return;
      }
    } catch (_) {}

    if (Platform.OS === 'ios') {
      await SecureStore.setItemAsync(SAVED_PASSWORD_KEY, password, {
        requireAuthentication: true,
        authenticationPrompt: type === 'register' ? t('auth.secureWithBiometrics') : t('auth.unlockToSignIn')
      });
      await SecureStore.setItemAsync(SAVED_PASSWORD_EMAIL_KEY, normalizedEmail);
      // Track storage mode for downstream logic
      await SecureStore.setItemAsync('password_stored_with_biometric', 'true');
    } else {
      // Android: try biometric first, fallback to silent storage
      let storedWithBiometric = false;
      try {
        await SecureStore.setItemAsync(SAVED_PASSWORD_KEY, password, {
          requireAuthentication: true,
          authenticationPrompt: type === 'register' ? t('auth.secureWithFingerprint') : t('auth.useFingerprint')
        });
        storedWithBiometric = true;
      } catch (e) {
        console.log(`[Auth] Android biometric storage failed${type === 'register' ? ' (register)' : ''}, using silent storage:`, e?.message);
        await SecureStore.setItemAsync(SAVED_PASSWORD_KEY, password);
      }
      await SecureStore.setItemAsync(SAVED_PASSWORD_EMAIL_KEY, normalizedEmail);
      await SecureStore.setItemAsync('password_stored_with_biometric', storedWithBiometric ? 'true' : 'false');
    }
  } catch (e) {
    // Fallback: store without biometrics
    await SecureStore.setItemAsync(SAVED_PASSWORD_KEY, password);
    await SecureStore.setItemAsync(SAVED_PASSWORD_EMAIL_KEY, normalizedEmail);
    await SecureStore.setItemAsync('password_stored_with_biometric', 'false');
  }
};

/**
 * Clears credentials that changed when switching accounts.
 * @param {string} previousEmail - Previous email
 * @param {string} normalizedEmail - New email
 * @param {Function} clearMasterKeyCache - Function to clear master key cache
 */
export const handleCredentialsChange = async (previousEmail, normalizedEmail, callbacks) => {
  if (previousEmail && previousEmail !== normalizedEmail) {
    await clearStealthCloudMasterKeyCache();
    if (callbacks.setStealthUsage) callbacks.setStealthUsage(null);
    if (callbacks.setStealthUsageError) callbacks.setStealthUsageError(null);
    if (callbacks.setStealthUsageLoading) callbacks.setStealthUsageLoading(false);
  }
};

/**
 * Checks for first launch after reinstall and clears old credentials.
 * Uses SecureStore (keychain) for the marker since it persists across app updates.
 * Only returns true on genuine first install (no existing credentials).
 * @returns {Promise<boolean>} True if first launch after reinstall
 */
export const checkFirstLaunchAfterReinstall = async () => {
  const MARKER_KEY = 'app_initialized_v2';
  
  try {
    // Check if marker exists in SecureStore (persists across updates)
    const markerExists = await SecureStore.getItemAsync(MARKER_KEY);
    
    if (markerExists) {
      // Marker exists - not a first launch, credentials should be intact
      return false;
    }
    
    // No marker - check if this is a true first install or just missing marker
    // If credentials exist, this is an existing user (marker was missing due to migration)
    const existingToken = await SecureStore.getItemAsync('auth_token');
    const existingEmail = await SecureStore.getItemAsync('user_email');
    const existingPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, { requireAuthentication: false });
    
    if (existingToken || existingEmail || existingPassword) {
      // Credentials exist - this is an existing user, just create the marker
      console.log('[FirstLaunch] Existing credentials found - creating marker without clearing');
      await SecureStore.setItemAsync(MARKER_KEY, new Date().toISOString());
      return false;
    }
    
    // No marker AND no credentials - true first install
    console.log('[FirstLaunch] True first install detected - creating marker');
    await SecureStore.setItemAsync(MARKER_KEY, new Date().toISOString());
    return true;
  } catch (e) {
    console.log('[FirstLaunch] Error checking/creating marker:', e?.message);
  }
  
  return false;
};

/**
 * Loads and normalizes server settings from SecureStore.
 * @returns {Promise<{ savedType: string|null, savedLocalHost: string|null, normalizedRemoteHost: string|null }>}
 */
export const loadServerSettings = async () => {
  const savedType = await SecureStore.getItemAsync('server_type');
  const savedLocalHost = await SecureStore.getItemAsync('local_host');
  const savedRemoteHost = await SecureStore.getItemAsync('remote_host');
  const savedRemoteUrl = await SecureStore.getItemAsync('remote_url');
  const savedRemoteIp = await SecureStore.getItemAsync('remote_ip');

  // Normalize any persisted remote values
  const persistedRemoteRaw = savedRemoteHost || savedRemoteUrl || savedRemoteIp;
  let normalizedRemoteHost = null;
  
  if (persistedRemoteRaw) {
    normalizedRemoteHost = normalizeHostInput(persistedRemoteRaw);
    // Clean up legacy keys
    try { await SecureStore.setItemAsync('remote_host', normalizedRemoteHost); } catch (e) {}
    try { if (savedRemoteUrl) await SecureStore.deleteItemAsync('remote_url'); } catch (e) {}
    try { if (savedRemoteIp) await SecureStore.deleteItemAsync('remote_ip'); } catch (e) {}
  }

  return { savedType, savedLocalHost, normalizedRemoteHost };
};

/**
 * Validates an existing token against the server and retrieves saved password for master key.
 * @param {Object} params
 * @param {string} params.storedToken - Auth token
 * @param {string} params.storedEmail - User email
 * @param {string} params.storedUserId - User ID
 * @param {string} params.uuid - Device UUID
 * @param {string} params.baseUrl - Server base URL
 * @param {Function} params.onStatus - Status update callback
 * @returns {Promise<{ success: boolean, savedPassword?: string, networkError?: boolean }>}
 */
export const validateToken = async ({ storedToken, storedEmail, storedUserId, uuid, baseUrl, onStatus }) => {
  // Check if user explicitly logged out
  const userLoggedOut = await SecureStore.getItemAsync('user_logged_out');
  if (userLoggedOut === 'true') {
    console.log('[Auth] User logged out - skipping token validation');
    return { success: false };
  }

  if (!storedToken) {
    return { success: false };
  }

  try {
    onStatus?.(t('auth.verifyingSession'));
    const headers = {
      'Authorization': `Bearer ${storedToken}`,
      'X-Device-UUID': uuid || 'unknown'
    };
    await axios.get(`${baseUrl}/api/cloud/usage`, { headers, timeout: 5000 });
    
    // Token valid - check if master key is already cached (skip biometric if so)
    let savedPassword = null;
    const existingCache = await SecureStore.getItemAsync('stealthcloud_derived_key_v2').catch(() => null);
    if (existingCache) {
      console.log('[Auth] Token valid + master key cached — skipping biometric');
      return { success: true, savedPassword: null };
    }

    // Master key not cached — need password to derive it (requires biometric)
    const savedPasswordEmail = await SecureStore.getItemAsync(SAVED_PASSWORD_EMAIL_KEY);
    if (savedPasswordEmail === storedEmail) {
      onStatus?.(t('auth.unlockToSignIn'));
      const storedWithBiometric = Platform.OS === 'ios' ||
        (await SecureStore.getItemAsync('password_stored_with_biometric')) === 'true';
      
      if (storedWithBiometric) {
        try {
          savedPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, {
            requireAuthentication: true,
            authenticationPrompt: t('auth.unlockToSignIn')
          });
        } catch (e) {
          // Biometric cancelled/failed - still allow login but without master key
          console.log('[Auth] Biometric for master key skipped:', e?.message);
        }
      } else {
        savedPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY);
      }
    }
    
    return { success: true, savedPassword };
  } catch (e) {
    const isNetworkError = !e?.response && (e?.message?.includes('Network') || e?.code === 'ECONNABORTED' || e?.message?.includes('timeout'));
    if (isNetworkError) {
      // Network error - allow offline access if we have credentials
      console.log('[Auth] Network error during token validation - allowing offline access');
      return { success: true, networkError: true };
    }
    console.log('[Auth] Token validation failed:', e?.response?.status || e?.message);
    return { success: false, networkError: false };
  }
};

/**
 * Gets saved password from SecureStore with biometric authentication.
 * @returns {Promise<string|null>}
 */
export const getSavedPasswordWithBiometrics = async () => {
  try {
    return await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, {
      requireAuthentication: true,
      authenticationPrompt: t('auth.unlockToSignIn')
    });
  } catch (e) {
    // Fallback to non-biometric retrieval
    return await SecureStore.getItemAsync(SAVED_PASSWORD_KEY);
  }
};

/**
 * Attempts biometric re-authentication when no valid token exists but credentials are saved.
 * @param {Object} params
 * @param {string} params.storedEmail - Stored user email
 * @param {string} params.baseUrl - Server base URL
 * @param {Function} params.getDeviceUUID - Function to get device UUID
 * @param {Function} params.onStatus - Status update callback
 * @returns {Promise<{ success: boolean, token?: string, userId?: number, savedPassword?: string, deviceId?: string, biometricCancelled?: boolean }>}
 */
export const attemptBiometricReauth = async ({ storedEmail, baseUrl, getDeviceUUID, onStatus }) => {
  // Check if user explicitly logged out
  const userLoggedOut = await SecureStore.getItemAsync('user_logged_out');
  if (userLoggedOut === 'true') {
    console.log('[Auth] User logged out - skipping biometric re-auth');
    await SecureStore.deleteItemAsync('user_logged_out');
    return { success: false, biometricCancelled: false };
  }

  const savedPasswordEmail = await SecureStore.getItemAsync(SAVED_PASSWORD_EMAIL_KEY);
  if (!savedPasswordEmail || !storedEmail) {
    return { success: false, biometricCancelled: false };
  }

  try {
    onStatus?.(t('auth.unlockToSignIn'));
    let savedPassword = null;
    let biometricCancelled = false;

    // Check how password was stored (Android only - iOS always uses biometric)
    const storedWithBiometric = Platform.OS === 'ios' ||
      (await SecureStore.getItemAsync('password_stored_with_biometric')) === 'true';

    if (storedWithBiometric) {
      try {
        savedPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY, {
          requireAuthentication: true,
          authenticationPrompt: t('auth.unlockToSignIn')
        });
      } catch (e) {
        const errMsg = e?.message?.toLowerCase() || '';
        if (errMsg.includes('cancel') || errMsg.includes('user') || errMsg.includes('authentication') || errMsg.includes('failed')) {
          console.log('[Auth] Biometric cancelled/failed by user:', errMsg);
          biometricCancelled = true;
        }
      }
    } else {
      console.log('[Auth] Reading password without biometric (Android silent storage)');
      savedPassword = await SecureStore.getItemAsync(SAVED_PASSWORD_KEY);
    }

    if (biometricCancelled) {
      return { success: false, biometricCancelled: true };
    }

    if (!savedPassword) {
      return { success: false, biometricCancelled: false };
    }

    onStatus?.('Signing in...');
    const deviceId = await getDeviceUUID(storedEmail, savedPassword);

    const payload = {
      email: storedEmail,
      password: savedPassword,
      device_uuid: deviceId,
      deviceUuid: deviceId,
      device_name: Platform.OS + ' ' + Platform.Version,
    };

    const res = await axios.post(`${baseUrl}/api/login`, payload, { timeout: 15000 });
    const { token, userId } = res.data;

    await SecureStore.setItemAsync('auth_token', token);
    if (userId) {
      await SecureStore.setItemAsync('user_id', String(userId));
    }

    return { success: true, token, userId, savedPassword, deviceId };
  } catch (e) {
    console.log('Biometric re-auth failed:', e?.response?.status || e?.message);
    
    // Handle country verification requirement
    if (e?.response?.status === 403 && e?.response?.data?.requiresCountryVerification) {
      return { 
        success: false, 
        biometricCancelled: false,
        requiresCountryVerification: true,
        newCountry: e.response.data.newCountry,
        newCountryCode: e.response.data.newCountryCode,
        message: e.response.data.message
      };
    }
    
    // Handle email verification requirement
    if (e?.response?.status === 403 && e?.response?.data?.requiresEmailVerification) {
      return { 
        success: false, 
        biometricCancelled: false,
        requiresEmailVerification: true,
        message: e.response.data.hint
      };
    }
    
    return { success: false, biometricCancelled: false };
  }
};

/**
 * Performs password reset via device verification.
 * @param {Object} params
 * @param {string} params.email - User email
 * @param {string} params.newPassword - New password
 * @param {string} params.serverType - Server type
 * @param {string} params.localHost - Local host
 * @param {string} params.remoteHost - Remote host
 * @returns {Promise<{ success: boolean, error?: string, hint?: string }>}
 */
export const performDevicePasswordReset = async ({ email, newPassword, serverType, localHost, remoteHost }) => {
  const normalizedEmail = normalizeEmailForDeviceUuid(email);
  if (!normalizedEmail) {
    return { success: false, error: 'Please enter a valid email address' };
  }

  if (newPassword.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  const hardwareDeviceId = await getHardwareDeviceId();
  if (!hardwareDeviceId) {
    return { 
      success: false, 
      error: 'Could not retrieve device identifier. Password reset requires device verification. Please ensure you registered on this device.' 
    };
  }

  try {
    const baseUrl = computeServerUrl(serverType, localHost, remoteHost);
    await axios.post(`${baseUrl}/api/reset-password-device`, {
      email: normalizedEmail,
      hardware_device_id: hardwareDeviceId,
      newPassword
    });
    // Clear biometric flag so next login re-stores the new password
    try {
      await SecureStore.deleteItemAsync('password_stored_with_biometric');
    } catch (_) {}
    return { success: true };
  } catch (error) {
    const hint = error.response?.data?.hint;
    return { 
      success: false, 
      error: error.response?.data?.error || 'Failed to reset password',
      hint 
    };
  }
};

/**
 * Request email-based password reset code
 * Works for all server types (local/remote/stealthcloud)
 * @param {Object} params
 * @param {string} params.email - User email
 * @param {string} params.serverType - Server type
 * @param {string} params.localHost - Local host
 * @param {string} params.remoteHost - Remote host
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export const requestPasswordResetCode = async ({ email, serverType, localHost, remoteHost }) => {
  const normalizedEmail = normalizeEmailForDeviceUuid(email);
  if (!normalizedEmail) {
    return { success: false, error: 'Please enter a valid email address' };
  }

  try {
    const baseUrl = computeServerUrl(serverType, localHost, remoteHost);
    await axios.post(`${baseUrl}/api/auth/request-password-reset`, {
      email: normalizedEmail
    }, { timeout: 15000 });
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data?.error || 'Failed to send reset code'
    };
  }
};

/**
 * Reset password using email verification code
 * Works for all server types (local/remote/stealthcloud)
 * @param {Object} params
 * @param {string} params.email - User email
 * @param {string} params.code - Verification code from email
 * @param {string} params.newPassword - New password
 * @param {string} params.serverType - Server type
 * @param {string} params.localHost - Local host
 * @param {string} params.remoteHost - Remote host
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export const resetPasswordWithCode = async ({ email, code, newPassword, serverType, localHost, remoteHost }) => {
  const normalizedEmail = normalizeEmailForDeviceUuid(email);
  if (!normalizedEmail) {
    return { success: false, error: 'Please enter a valid email address' };
  }

  if (!code || code.length !== 6) {
    return { success: false, error: 'Please enter the 6-digit verification code' };
  }

  if (newPassword.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  try {
    const baseUrl = computeServerUrl(serverType, localHost, remoteHost);
    await axios.post(`${baseUrl}/api/auth/reset-password-with-code`, {
      email: normalizedEmail,
      code,
      newPassword
    }, { timeout: 15000 });
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data?.error || 'Failed to reset password'
    };
  }
};

/**
 * Core logout logic - clears tokens and optionally credentials.
 * @param {Object} params
 * @param {boolean} params.forgetCredentials - If true, also clears saved email/password
 * @returns {Promise<void>}
 */
export const logoutCore = async ({ forgetCredentials = false } = {}) => {
  // Always clear token on logout - user must re-authenticate
  await SecureStore.deleteItemAsync('auth_token');
  await SecureStore.deleteItemAsync('user_id');

  // Set flag to prevent biometric auto-login on next app launch
  await SecureStore.setItemAsync('user_logged_out', 'true');

  // Only delete saved credentials if explicitly forgetting
  if (forgetCredentials) {
    await SecureStore.deleteItemAsync('user_email');
    await SecureStore.deleteItemAsync('device_uuid');
    await SecureStore.deleteItemAsync(SAVED_PASSWORD_KEY);
    await SecureStore.deleteItemAsync(SAVED_PASSWORD_EMAIL_KEY);
  }
};

export const getDeviceUUID = async (userEmail = null, userPassword = null) => {
  const normalizedEmail = normalizeEmailForDeviceUuid(userEmail);
  if (!normalizedEmail) return null;

  const persistedKey = sanitizeStoreKey(`device_uuid_v3:${normalizedEmail}`);
  const legacyKey = sanitizeStoreKey(`device_uuid_v3:${String(userEmail).toLowerCase()}`);

  let persisted = null;
  try {
    persisted = await SecureStore.getItemAsync(persistedKey);
  } catch (e) {
    persisted = null;
  }

  if (!persisted) {
    // Migration path for older builds (non-trimmed key)
    let legacy = null;
    try {
      legacy = await SecureStore.getItemAsync(legacyKey);
    } catch (e) {
      legacy = null;
    }
    if (legacy) {
      persisted = legacy;
      try {
        await SecureStore.setItemAsync(persistedKey, legacy);
      } catch (e) {
        // ignore
      }
    }
  }

  // If password is not provided (e.g. app start), we can only use the persisted UUID.
  if (!userPassword) {
    if (persisted) {
      try {
        await SecureStore.setItemAsync('device_uuid', persisted);
      } catch (e) {}
    }
    return persisted;
  }

  // Check if this email has a migrated UUID lock (legacy → wallet migration).
  // If so, the persisted UUID is the original legacy UUID and must NOT be
  // overwritten by the wallet-derived email:password hash.
  const migrationLockKey = sanitizeStoreKey(`uuid_migrated_lock:${normalizedEmail}`);
  let isMigrated = false;
  try {
    isMigrated = (await SecureStore.getItemAsync(migrationLockKey)) === 'true';
  } catch (e) {}

  if (isMigrated && persisted) {
    // Legacy UUID preserved — skip re-derivation
    try {
      await SecureStore.setItemAsync('device_uuid', persisted);
    } catch (e) {}
    return persisted;
  }

  // If password is provided (login/register), enforce email+password-derived UUID.
  const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const expected = uuidv5(`${normalizedEmail}:${userPassword}`, namespace);

  if (persisted !== expected) {
    try {
      await SecureStore.setItemAsync(persistedKey, expected);
    } catch (e) {
      // ignore
    }
  }

  try {
    await SecureStore.setItemAsync('device_uuid', expected);
  } catch (e) {}

  return expected;
};

/**
 * Get paired device credentials from SecureStore.
 * Returns the first available paired device's credentials, or null if none exist.
 * @returns {Promise<{email: string, password: string, deviceUuid: string} | null>}
 */
export const getPairedCredentials = async () => {
  try {
    const pairedUuidsStr = await SecureStore.getItemAsync('paired_device_uuids');
    if (!pairedUuidsStr) return null;
    
    const pairedUuids = JSON.parse(pairedUuidsStr);
    if (!Array.isArray(pairedUuids) || pairedUuids.length === 0) return null;
    
    // Get credentials for the first paired device
    const deviceUuid = pairedUuids[0];
    const email = await SecureStore.getItemAsync(`paired_email_${deviceUuid}`, {
      requireAuthentication: false
    });
    const password = await SecureStore.getItemAsync(`paired_password_${deviceUuid}`, {
      requireAuthentication: false
    });
    
    if (email && password) {
      return { email, password, deviceUuid };
    }
    
    return null;
  } catch (e) {
    console.log('[Auth] Failed to get paired credentials:', e.message);
    return null;
  }
};

export default {
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
  requestPasswordResetCode,
  resetPasswordWithCode,
  resendCountryVerificationCode,
  logoutCore,
  getDeviceUUID,
  getPairedCredentials,
};
