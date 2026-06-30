// walletAuth.js — Wallet-based authentication for Solana Seeker
// Uses MWA hardware wallet as identity. The wallet address becomes the
// user identifier, and a deterministic password derived from the address
// is used so the existing server auth (email+password) works unchanged.
//
// The hardware wallet biometric/PIN prompt IS the login — no separate
// password needed.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import { v5 as uuidv5 } from 'uuid';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

import * as WalletAdapter from './WalletAdapter';
import { normalizeEmailForDeviceUuid, computeServerUrl, sanitizeStoreKey } from './utils';
import { getDeviceUUID, storeCredentialsWithBiometrics, SAVED_PASSWORD_KEY, SAVED_PASSWORD_EMAIL_KEY } from './authHelpers';
import { cacheStealthCloudMasterKey } from './backgroundTask';
import { t } from './i18n';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Domain used for wallet-derived email addresses
const WALLET_EMAIL_DOMAIN = 'seeker.photolynk.local';

// App-level salt so the derived password is unique to PhotoLynk
const WALLET_PASSWORD_SALT = 'PhotoLynk-Seeker-WalletAuth-v1';

// SecureStore key to remember this is a wallet-based account
const WALLET_AUTH_MODE_KEY = 'auth_mode_wallet';

// SecureStore key prefix for migration lock — prevents getDeviceUUID from
// re-deriving the UUID when the wallet email is used with a migrated legacy UUID.
const LEGACY_MIGRATION_LOCK_PREFIX = 'uuid_migrated_lock:';

// SecureStore keys for legacy master key credentials.
// After migration, the encryption master key must still be derived from the
// ORIGINAL email+password (PBKDF2), not the wallet-derived ones.
const LEGACY_MK_EMAIL_KEY = 'legacy_mk_email';
const LEGACY_MK_PASSWORD_KEY = 'legacy_mk_password';

// SecureStore key for the wallet signature-derived secure password.
// This password is NOT guessable from public data — it requires the wallet private key.
const WALLET_SECURE_PASSWORD_KEY = 'wallet_secure_password_v1';
const WALLET_LEGACY_PASSWORD_KEY = 'wallet_legacy_password_v1';

// Fixed message signed by wallet to derive the secure encryption password.
const MASTER_KEY_DERIVATION_MESSAGE = 'PhotoLynk-MasterKey-v1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable "email" from a wallet address.
 * Format: <address>@seeker.photolynk.local
 * This is treated as a normal email by the server.
 */
export const deriveWalletEmail = (walletAddress) => {
  if (!walletAddress) return null;
  return `${walletAddress.toLowerCase()}@${WALLET_EMAIL_DOMAIN}`;
};

/**
 * Derive a deterministic "password" from a wallet address.
 * Uses SHA-512 of (address + salt), then base64-encodes the first 32 bytes.
 * This is stable and reproducible — no need to store it separately.
 *
 * This is the legacy derivation method, used for server auth and as a
 * fallback for older encrypted files. New encryption uses
 * deriveWalletPasswordSecure() which requires a wallet signature for
 * stronger security and self-service recovery.
 */
export const deriveWalletPassword = (walletAddress) => {
  if (!walletAddress) return null;
  const input = `${walletAddress}:${WALLET_PASSWORD_SALT}`;
  const hash = nacl.hash(naclUtil.decodeUTF8(input));
  // Take first 32 bytes, base64-encode for a strong deterministic password
  return naclUtil.encodeBase64(hash.slice(0, 32));
};

/**
 * Derive a SECURE password from a wallet signature.
 * The user must sign a fixed message with their hardware wallet.
 * The signature requires the PRIVATE KEY — not guessable from public data.
 *
 * @returns {Promise<string|null>} Base64-encoded 32-byte password, or null if signing fails.
 */
export const deriveWalletPasswordSecure = async () => {
  try {
    const signResult = await WalletAdapter.signMessage(MASTER_KEY_DERIVATION_MESSAGE);
    if (!signResult.success) {
      console.warn('[WalletAuth] signMessage failed:', signResult.error);
      return null;
    }
    // Hash the signature to get a deterministic password
    const signatureBytes = signResult.signature instanceof Uint8Array
      ? signResult.signature
      : naclUtil.decodeBase64(signResult.signature);
    const hash = nacl.hash(signatureBytes);
    return naclUtil.encodeBase64(hash.slice(0, 32));
  } catch (e) {
    console.warn('[WalletAuth] deriveWalletPasswordSecure failed:', e.message);
    return null;
  }
};

/**
 * Get the secure password for master key derivation.
 * First checks SecureStore cache, then tries wallet signMessage.
 * Falls back to legacy public derivation if signMessage is unavailable.
 *
 * @returns {Promise<{password: string, isSecure: boolean}>}
 */
export const getWalletPasswordForMasterKey = async (walletAddress) => {
  // Try cached secure password first
  try {
    const cached = await SecureStore.getItemAsync(WALLET_SECURE_PASSWORD_KEY);
    if (cached) {
      console.log('[WalletAuth] Using cached secure password');
      return { password: cached, isSecure: true };
    }
  } catch (e) {}

  // Try to derive a new secure password via wallet signature
  if (walletAddress) {
    const securePassword = await deriveWalletPasswordSecure();
    if (securePassword) {
      // Cache it so we don't need to sign again
      try {
        await SecureStore.setItemAsync(WALLET_SECURE_PASSWORD_KEY, securePassword);
      } catch (e) {
        console.warn('[WalletAuth] Failed to cache secure password:', e.message);
      }
      // Also cache the legacy password for old file decryption fallback
      const legacyPassword = deriveWalletPassword(walletAddress);
      try {
        await SecureStore.setItemAsync(WALLET_LEGACY_PASSWORD_KEY, legacyPassword);
      } catch (e) {}
      return { password: securePassword, isSecure: true };
    }
  }

  // Fall back to legacy public derivation
  console.log('[WalletAuth] Using legacy public-address password derivation (older method).');
  const legacyPassword = walletAddress ? deriveWalletPassword(walletAddress) : null;
  return { password: legacyPassword, isSecure: false };
};

/**
 * Get the correct email+password for master key (PBKDF2) derivation.
 * For migrated users, returns the original legacy credentials.
 * For non-migrated users, returns null (caller should use current credentials).
 * @returns {Promise<{email: string, password: string}|null>}
 */
export const getMasterKeyCredentials = async () => {
  try {
    const mkEmail = await SecureStore.getItemAsync(LEGACY_MK_EMAIL_KEY);
    const mkPassword = await SecureStore.getItemAsync(LEGACY_MK_PASSWORD_KEY);
    if (mkEmail && mkPassword) {
      return { email: mkEmail, password: mkPassword };
    }
  } catch (e) {}
  return null;
};

/**
 * Check if the current session is wallet-based auth.
 */
export const isWalletAuthMode = async () => {
  try {
    const mode = await SecureStore.getItemAsync(WALLET_AUTH_MODE_KEY);
    return mode === 'true';
  } catch (e) {
    return false;
  }
};

/**
 * Mark/unmark wallet auth mode in SecureStore.
 */
export const setWalletAuthMode = async (enabled) => {
  try {
    if (enabled) {
      await SecureStore.setItemAsync(WALLET_AUTH_MODE_KEY, 'true');
    } else {
      await SecureStore.deleteItemAsync(WALLET_AUTH_MODE_KEY);
    }
  } catch (e) {
    // ignore
  }
};

// ---------------------------------------------------------------------------
// Main auth flow
// ---------------------------------------------------------------------------

/**
 * Full wallet-based authentication flow.
 * 1. Connect MWA wallet (triggers biometric/PIN on Seeker)
 * 2. Derive email + password from wallet address
 * 3. Try login — if user doesn't exist, auto-register then login
 * 4. Store credentials, cache master key, return session data
 *
 * @param {Object} params
 * @param {string} params.serverType - Current server type
 * @param {string} params.localHost - Local host value
 * @param {string} params.remoteHost - Remote host value
 * @param {Function} params.onStatus - Status update callback
 * @returns {Promise<{
 *   success: boolean,
 *   token?: string,
 *   userId?: number,
 *   email?: string,
 *   password?: string,
 *   deviceId?: string,
 *   walletAddress?: string,
 *   userCancelled?: boolean,
 *   error?: string
 * }>}
 */
export const handleWalletAuth = async ({ serverType, localHost, remoteHost, onStatus, skipNewUserConfirmation = false }) => {
  try {
    // Step 1: Connect wallet via MWA (hardware wallet biometric prompt)
    onStatus?.(t('auth.connectingWallet') || 'Connecting wallet...');

    // Initialize wallet adapter if needed
    await WalletAdapter.initializeWalletAdapter();

    // Try to connect best available wallet (MWA on Seeker)
    const walletResult = await WalletAdapter.connectBestWallet();

    if (!walletResult.success) {
      if (walletResult.error?.includes('cancelled') || walletResult.userCancelled) {
        return { success: false, userCancelled: true };
      }
      return { success: false, error: walletResult.error || 'Failed to connect wallet' };
    }

    const walletAddress = walletResult.address;
    const seekerId = walletResult.label || null;
    if (!walletAddress) {
      return { success: false, error: 'No wallet address received' };
    }

    console.log('[WalletAuth] Wallet connected:', walletAddress);

    // Step 2: Derive credentials from wallet address
    onStatus?.(t('auth.signingIn') || 'Signing in...');

    const walletEmail = deriveWalletEmail(walletAddress);
    const walletPassword = deriveWalletPassword(walletAddress);
    const normalizedEmail = normalizeEmailForDeviceUuid(walletEmail);

    // Step 2b: Derive SECURE password for encryption (requires private key signature)
    onStatus?.(t('auth.securingSession') || 'Securing session...');
    const { password: securePassword, isSecure } = await getWalletPasswordForMasterKey(walletAddress);
    console.log('[WalletAuth] Master key derivation:', isSecure ? 'secure (signature-based)' : 'legacy (public-address-based)');

    if (!normalizedEmail || !walletPassword) {
      return { success: false, error: 'Failed to derive credentials from wallet' };
    }

    // Step 3: Generate device UUID
    const deviceId = await getDeviceUUID(normalizedEmail, walletPassword);

    // Step 4: Compute server URL
    const baseUrl = computeServerUrl(serverType, localHost, remoteHost);

    const payload = {
      email: normalizedEmail,
      password: walletPassword,
      device_uuid: deviceId,
      deviceUuid: deviceId,
      device_name: Platform.OS + ' ' + Platform.Version,
    };

    // Step 5: Try login first
    let token = null;
    let userId = null;

    try {
      onStatus?.(t('auth.signingIn') || 'Signing in...');
      const loginRes = await axios.post(`${baseUrl}/api/login`, payload, { timeout: 15000 });
      token = loginRes.data?.token;
      userId = loginRes.data?.userId;
      console.log('[WalletAuth] Login successful');
    } catch (loginErr) {
      const status = loginErr?.response?.status;
      const errMsg = loginErr?.response?.data?.error || '';

      // If user not found (401), ask for confirmation before creating a new account
      if (status === 401 && (errMsg.toLowerCase().includes('invalid credentials') || errMsg.toLowerCase().includes('user not found') || errMsg.toLowerCase().includes('no user'))) {
        // Return confirmation-needed flag so UI can warn the user first
        if (!skipNewUserConfirmation) {
          console.log('[WalletAuth] User not found — asking for confirmation before creating new account');
          return { success: false, needsNewUserConfirmation: true, walletAddress, seekerId };
        }

        console.log('[WalletAuth] User confirmed new account, registering...');
        onStatus?.(t('auth.registering') || 'Creating account...');

        try {
          const regPayload = {
            ...payload,
            plan_gb: 100, // Default plan for wallet users
          };
          const regRes = await axios.post(`${baseUrl}/api/register`, regPayload, { timeout: 15000 });
          token = regRes.data?.token;
          userId = regRes.data?.userId;
          console.log('[WalletAuth] Registration + auto-login successful');
        } catch (regErr) {
          const regStatus = regErr?.response?.status;
          const regErrMsg = regErr?.response?.data?.error || '';

          // If email already exists (409), retry login (race condition or previous partial registration)
          if (regStatus === 409) {
            console.log('[WalletAuth] Already registered, retrying login...');
            onStatus?.(t('auth.signingIn') || 'Signing in...');
            const retryRes = await axios.post(`${baseUrl}/api/login`, payload, { timeout: 15000 });
            token = retryRes.data?.token;
            userId = retryRes.data?.userId;
          } else {
            return { success: false, error: regErrMsg || 'Registration failed' };
          }
        }
      } else if (status === 403) {
        // Country verification or email verification
        return { success: false, error: errMsg || 'Access denied' };
      } else if (!loginErr?.response) {
        // Network error
        return { success: false, error: t('alerts.connectionFailed') || 'Cannot reach server' };
      } else {
        return { success: false, error: errMsg || 'Login failed' };
      }
    }

    if (!token) {
      return { success: false, error: 'No token received from server' };
    }

    // Step 6: Store credentials securely
    onStatus?.(t('auth.securingCredentials') || 'Securing credentials...');

    await SecureStore.setItemAsync('auth_token', token);
    await SecureStore.setItemAsync('user_email', normalizedEmail);
    await SecureStore.setItemAsync('device_uuid', deviceId);
    if (userId) {
      await SecureStore.setItemAsync('user_id', String(userId));
    }

    // Store password for biometric re-auth on next launch
    await storeCredentialsWithBiometrics({
      password: walletPassword,
      normalizedEmail,
      type: 'login',
    });

    // Mark as wallet auth mode
    await setWalletAuthMode(true);

    // Clear logout flag
    await SecureStore.deleteItemAsync('user_logged_out');

    // Step 7: Cache master keys for encryption.
    // For migrated users, the key must be derived from the ORIGINAL legacy
    // credentials (stored during migration). For new wallet-only users, use
    // the wallet-derived credentials.
    onStatus?.(t('common.finalizing') || 'Finalizing...');
    const mkCreds = await getMasterKeyCredentials();
    if (mkCreds) {
      await cacheStealthCloudMasterKey(mkCreds.email, mkCreds.password, true);
    } else {
      // Cache the secure key (signature-derived) if available
      if (securePassword) {
        await cacheStealthCloudMasterKey(normalizedEmail, securePassword, false, true);
      }
      // Always also cache the legacy key for old file decryption fallback
      await cacheStealthCloudMasterKey(normalizedEmail, walletPassword, false, false);
    }

    // Also store the legacy password for getWalletLegacyMasterKey
    try {
      const legacyKey = deriveWalletPassword(walletAddress);
      await SecureStore.setItemAsync(WALLET_LEGACY_PASSWORD_KEY, legacyKey);
    } catch (e) {}

    return {
      success: true,
      token,
      userId,
      email: normalizedEmail,
      password: walletPassword,
      deviceId,
      walletAddress,
      seekerId,
    };
  } catch (e) {
    console.error('[WalletAuth] Error:', e?.message || e);
    return { success: false, error: e?.message || 'Wallet authentication failed' };
  }
};

/**
 * Check if the current wallet account was migrated from a legacy account.
 */
export const isLegacyMigrated = async (walletEmail) => {
  if (!walletEmail) return false;
  const normalized = normalizeEmailForDeviceUuid(walletEmail);
  try {
    return (await SecureStore.getItemAsync(`${LEGACY_MIGRATION_LOCK_PREFIX}${normalized}`)) === 'true';
  } catch (e) {
    return false;
  }
};

/**
 * Migrate a legacy email+password account to wallet-based auth.
 *
 * Flow:
 *  1. Verify old email+password against the server (login)
 *  2. Get the legacy UUID from old credentials
 *  3. Connect MWA wallet (biometric prompt)
 *  4. Derive wallet email + password
 *  5. Store legacy UUID under wallet email key + set migration lock
 *  6. Register wallet email on server (uses legacy UUID as device_uuid)
 *  7. Store wallet credentials in SecureStore, cache master key
 *  8. On next app run → normal wallet auto-login, using preserved legacy UUID
 *
 * The legacy UUID is preserved so the user keeps access to all their existing
 * files on StealthCloud, local, and remote servers.
 *
 * @param {Object} params
 * @param {string} params.legacyEmail - Old email address
 * @param {string} params.legacyPassword - Old password
 * @param {string} params.serverType - Current server type
 * @param {string} params.localHost - Local host value
 * @param {string} params.remoteHost - Remote host value
 * @param {Function} params.onStatus - Status update callback
 * @returns {Promise<{
 *   success: boolean,
 *   token?: string,
 *   userId?: number,
 *   email?: string,
 *   password?: string,
 *   deviceId?: string,
 *   walletAddress?: string,
 *   seekerId?: string,
 *   error?: string
 * }>}
 */
export const migrateFromLegacy = async ({ legacyEmail, legacyPassword, serverType, localHost, remoteHost, onStatus }) => {
  try {
    // Step 1: Verify legacy credentials against the server
    onStatus?.(t('auth.verifyingSession') || 'Verifying account...');

    const normalizedLegacyEmail = normalizeEmailForDeviceUuid(legacyEmail);
    if (!normalizedLegacyEmail || !legacyPassword) {
      return { success: false, error: t('auth.invalidEmail') || 'Please enter a valid email and password' };
    }

    const legacyUUID = await getDeviceUUID(normalizedLegacyEmail, legacyPassword);
    console.log('[WalletAuth] Legacy UUID from getDeviceUUID:', legacyUUID, 'email:', normalizedLegacyEmail);
    if (!legacyUUID) {
      return { success: false, error: 'Could not derive device identity. Please check your credentials.' };
    }
    const baseUrl = computeServerUrl(serverType, localHost, remoteHost);

    let legacyToken = null;
    let legacyUserId = null;
    try {
      const loginRes = await axios.post(`${baseUrl}/api/login`, {
        email: normalizedLegacyEmail,
        password: legacyPassword,
        device_uuid: legacyUUID,
        deviceUuid: legacyUUID,
        device_name: Platform.OS + ' ' + Platform.Version,
      }, { timeout: 15000 });
      legacyToken = loginRes.data?.token;
      legacyUserId = loginRes.data?.userId;
    } catch (loginErr) {
      const status = loginErr?.response?.status;
      const errMsg = loginErr?.response?.data?.error || '';
      if (!loginErr?.response) {
        return { success: false, error: t('alerts.connectionFailed') || 'Cannot reach server' };
      }
      return { success: false, error: errMsg || t('auth.loginFailed') || 'Invalid credentials' };
    }

    if (!legacyToken) {
      return { success: false, error: 'Legacy account verification failed' };
    }

    console.log('[WalletAuth] Legacy account verified, UUID:', legacyUUID);

    // Step 2: Connect wallet via MWA (hardware wallet biometric prompt)
    onStatus?.(t('auth.connectingWallet') || 'Connecting wallet...');

    await WalletAdapter.initializeWalletAdapter();
    const walletResult = await WalletAdapter.connectBestWallet();

    if (!walletResult.success) {
      if (walletResult.error?.includes('cancelled') || walletResult.userCancelled) {
        return { success: false, userCancelled: true };
      }
      return { success: false, error: walletResult.error || 'Failed to connect wallet' };
    }

    const walletAddress = walletResult.address;
    const seekerId = walletResult.label || null;
    if (!walletAddress) {
      return { success: false, error: 'No wallet address received' };
    }

    console.log('[WalletAuth] Wallet connected for migration:', walletAddress);

    // Step 3: Derive wallet credentials
    const walletEmail = deriveWalletEmail(walletAddress);
    const walletPassword = deriveWalletPassword(walletAddress);
    const normalizedWalletEmail = normalizeEmailForDeviceUuid(walletEmail);

    if (!normalizedWalletEmail || !walletPassword) {
      return { success: false, error: 'Failed to derive wallet credentials' };
    }

    // Step 4: Store legacy UUID under wallet email key + set migration lock
    // This MUST happen BEFORE calling getDeviceUUID for the wallet email
    onStatus?.(t('auth.bondingDevice') || 'Bonding device...');

    const walletUuidKey = sanitizeStoreKey(`device_uuid_v3:${normalizedWalletEmail}`);
    const migrationLockKey = sanitizeStoreKey(`${LEGACY_MIGRATION_LOCK_PREFIX}${normalizedWalletEmail}`);

    try {
      console.log('[WalletAuth] Storing UUID key:', walletUuidKey, 'value:', legacyUUID);
      await SecureStore.setItemAsync(walletUuidKey, legacyUUID);
      console.log('[WalletAuth] Storing migration lock:', migrationLockKey);
      await SecureStore.setItemAsync(migrationLockKey, 'true');
      console.log('[WalletAuth] Storing device_uuid');
      await SecureStore.setItemAsync('device_uuid', legacyUUID);
    } catch (e) {
      console.error('[WalletAuth] SecureStore error preserving device identity:', e?.message || e, 'key:', walletUuidKey);
      return { success: false, error: 'Failed to preserve device identity: ' + (e?.message || String(e)) };
    }

    console.log('[WalletAuth] Legacy UUID preserved for wallet email:', legacyUUID);

    // Step 5: Migrate credentials on server (UPDATE existing account, same user_id).
    // Uses the legacyToken from Step 1 to authenticate, then /api/migrate-credentials
    // updates the account's email+password to the wallet-derived ones IN-PLACE.
    // This preserves user_id → cloud_chunks, user_plans, devices all stay intact.
    onStatus?.(t('auth.registering') || 'Migrating account...');

    let token = null;
    let userId = null;

    try {
      const migrateRes = await axios.post(`${baseUrl}/api/migrate-credentials`, {
        new_email: normalizedWalletEmail,
        new_password: walletPassword,
        device_uuid: legacyUUID,
        device_name: Platform.OS + ' ' + Platform.Version,
      }, {
        headers: { 'Authorization': `Bearer ${legacyToken}`, 'X-Device-UUID': legacyUUID },
        timeout: 15000,
      });
      token = migrateRes.data?.token;
      userId = migrateRes.data?.userId;
      console.log('[WalletAuth] Server credentials migrated in-place (same user_id)');
    } catch (migrateErr) {
      const migrateStatus = migrateErr?.response?.status;
      // 409 = wallet email already in use (previous migration completed) — just login
      if (migrateStatus === 409) {
        try {
          const loginRes = await axios.post(`${baseUrl}/api/login`, {
            email: normalizedWalletEmail,
            password: walletPassword,
            device_uuid: legacyUUID,
            deviceUuid: legacyUUID,
            device_name: Platform.OS + ' ' + Platform.Version,
          }, { timeout: 15000 });
          token = loginRes.data?.token;
          userId = loginRes.data?.userId;
        } catch (e) {
          return { success: false, error: e?.response?.data?.error || 'Migration login failed' };
        }
      } else {
        return { success: false, error: migrateErr?.response?.data?.error || 'Credential migration failed' };
      }
    }

    if (!token) {
      return { success: false, error: 'No token received during migration' };
    }

    // Step 6: Store wallet credentials in SecureStore
    onStatus?.(t('auth.securingCredentials') || 'Securing credentials...');

    await SecureStore.setItemAsync('auth_token', token);
    await SecureStore.setItemAsync('user_email', normalizedWalletEmail);
    if (userId) {
      await SecureStore.setItemAsync('user_id', String(userId));
    }

    // Store legacy credentials for master key derivation on future logins.
    // The encryption key MUST always be derived from the original email+password.
    await SecureStore.setItemAsync(LEGACY_MK_EMAIL_KEY, normalizedLegacyEmail);
    await SecureStore.setItemAsync(LEGACY_MK_PASSWORD_KEY, legacyPassword);
    await SecureStore.setItemAsync('legacy_migrated_email', normalizedLegacyEmail);

    await storeCredentialsWithBiometrics({
      password: walletPassword,
      normalizedEmail: normalizedWalletEmail,
      type: 'login',
    });

    await setWalletAuthMode(true);
    await SecureStore.deleteItemAsync('user_logged_out');

    // Step 7: Cache master key using LEGACY credentials (old email+password).
    // This is critical — files are encrypted with PBKDF2(oldPassword, oldEmail).
    // We must continue using the same key so existing files remain decryptable
    // and future uploads are encrypted with the same key.
    onStatus?.(t('common.finalizing') || 'Finalizing...');
    await cacheStealthCloudMasterKey(normalizedLegacyEmail, legacyPassword, true);

    console.log('[WalletAuth] Migration complete! Legacy UUID:', legacyUUID, 'Wallet:', walletAddress);

    return {
      success: true,
      token,
      userId,
      email: normalizedWalletEmail,
      password: walletPassword,
      deviceId: legacyUUID,
      walletAddress,
      seekerId,
      migrated: true,
    };
  } catch (e) {
    console.error('[WalletAuth] Migration error:', e?.message || e);
    return { success: false, error: e?.message || 'Migration failed' };
  }
};

/**
 * Re-authenticate using stored wallet address (for server switches, token refresh).
 * Does NOT show wallet UI — uses stored credentials.
 *
 * @param {Object} params
 * @param {string} params.walletAddress - Known wallet address
 * @param {string} params.serverType - Server type
 * @param {string} params.localHost - Local host
 * @param {string} params.remoteHost - Remote host
 * @returns {Promise<{ success: boolean, token?: string, headers?: Object }>}
 */
export const reAuthWithWallet = async ({ walletAddress, serverType, localHost, remoteHost }) => {
  if (!walletAddress) {
    // Try to get wallet address from stored email
    try {
      const storedEmail = await SecureStore.getItemAsync('user_email');
      if (storedEmail && storedEmail.includes(`@${WALLET_EMAIL_DOMAIN}`)) {
        walletAddress = storedEmail.split('@')[0];
      }
    } catch (e) {}
  }

  if (!walletAddress) {
    return { success: false, error: 'No wallet address available' };
  }

  const walletEmail = deriveWalletEmail(walletAddress);
  const walletPassword = deriveWalletPassword(walletAddress);
  const normalizedEmail = normalizeEmailForDeviceUuid(walletEmail);
  const deviceId = await getDeviceUUID(normalizedEmail, walletPassword);
  const baseUrl = computeServerUrl(serverType, localHost, remoteHost);

  try {
    const res = await axios.post(`${baseUrl}/api/login`, {
      email: normalizedEmail,
      password: walletPassword,
      device_uuid: deviceId,
      deviceUuid: deviceId,
      device_name: Platform.OS + ' ' + Platform.Version,
    }, { timeout: 15000 });

    if (res.data?.token) {
      await SecureStore.setItemAsync('auth_token', res.data.token);
      return {
        success: true,
        token: res.data.token,
        headers: {
          'Authorization': `Bearer ${res.data.token}`,
          'X-Device-UUID': deviceId,
        },
      };
    }
    return { success: false, error: 'No token in response' };
  } catch (e) {
    return { success: false, error: e?.message || 'Re-auth failed' };
  }
};

/**
 * Clear the cached legacy password after encryption migration is complete.
 * Safe to call — only removes the key, does not affect secure password.
 */
export const clearWalletLegacyPassword = async () => {
  try {
    await SecureStore.deleteItemAsync(WALLET_LEGACY_PASSWORD_KEY);
    console.log('[WalletAuth] Legacy password cleared');
  } catch (e) {
    console.warn('[WalletAuth] Failed to clear legacy password:', e.message);
  }
};

export default {
  deriveWalletEmail,
  deriveWalletPassword,
  getMasterKeyCredentials,
  clearWalletLegacyPassword,
  isWalletAuthMode,
  setWalletAuthMode,
  handleWalletAuth,
  migrateFromLegacy,
  isLegacyMigrated,
  reAuthWithWallet,
  WALLET_EMAIL_DOMAIN,
};
