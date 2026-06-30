/**
 * recoveryKit.js
 *
 * Emergency recovery kit for PhotoLynk.
 * Creates an encrypted backup of credentials (email + password) protected by a user-chosen PIN.
 * On a new device, the kit + PIN allows login without remembering the original password.
 *
 * Security model:
 * - Kit is encrypted with XSalsa20-Poly1305
 * - Encryption key derived from PIN via PBKDF2-HMAC-SHA256 (100k iterations)
 * - Random salt included in kit to prevent rainbow-table attacks
 * - Kit does NOT contain the master encryption key — that re-derives automatically on login
 * - Kit is a point-in-time snapshot: changing password invalidates the old kit
 */

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { pbkdf2Sha256 } from './backgroundTask';

const KIT_VERSION = 1;
const SALT_LEN = 16;
const NONCE_LEN = 24;
const PIN_PBKDF2_ITERATIONS = 100000;
const PIN_KEY_LEN = 32;

/**
 * Derive an encryption key from the user's recovery PIN.
 * @param {string} pin — User's recovery PIN
 * @param {Uint8Array} salt — Random salt (included in the kit)
 * @returns {Uint8Array} 32-byte encryption key
 */
const derivePinKey = (pin, salt) => {
  const encoder = new TextEncoder();
  const pinBytes = encoder.encode(pin);
  return pbkdf2Sha256(pinBytes, salt, PIN_PBKDF2_ITERATIONS, PIN_KEY_LEN);
};

/**
 * Create a recovery kit from the currently stored credentials.
 * @param {string} pin — User-chosen recovery PIN (4–12 chars recommended)
 * @returns {Promise<string>} Base64-encoded recovery kit
 */
export const createRecoveryKit = async (pin) => {
  if (!pin || pin.length < 4) {
    throw new Error('PIN must be at least 4 characters');
  }

  const email = await SecureStore.getItemAsync('user_email');
  let password = null;
  try {
    // iOS always stores passwords with biometric protection.
    // Android may use biometric or silent fallback — try biometric first.
    password = await SecureStore.getItemAsync('user_password_v1', {
      requireAuthentication: true,
      authenticationPrompt: 'Authenticate to create recovery kit',
    });
  } catch (_) {
    // Fallback for Android silent storage or cancelled biometric
    try {
      password = await SecureStore.getItemAsync('user_password_v1', {
        requireAuthentication: false,
      });
    } catch (_) {}
  }

  if (!email || !password) {
    throw new Error('Credentials not available. Please log in first.');
  }

  const salt = new Uint8Array(SALT_LEN);
  global.crypto.getRandomValues(salt);

  const pinKey = derivePinKey(pin, salt);

  const payload = JSON.stringify({ v: KIT_VERSION, email, password });
  const payloadBytes = naclUtil.decodeUTF8(payload);

  const nonce = new Uint8Array(NONCE_LEN);
  global.crypto.getRandomValues(nonce);

  const encrypted = nacl.secretbox(payloadBytes, nonce, pinKey);

  // Format: [version(1)][salt(16)][nonce(24)][ciphertext(...)]
  const result = new Uint8Array(1 + SALT_LEN + NONCE_LEN + encrypted.length);
  result[0] = KIT_VERSION;
  result.set(salt, 1);
  result.set(nonce, 1 + SALT_LEN);
  result.set(encrypted, 1 + SALT_LEN + NONCE_LEN);

  return naclUtil.encodeBase64(result);
};

/**
 * Recover credentials from a recovery kit.
 * @param {string} kitBase64 — Base64-encoded recovery kit
 * @param {string} pin — Recovery PIN
 * @returns {Promise<{email: string, password: string}>}
 */
export const recoverFromKit = async (kitBase64, pin) => {
  if (!kitBase64 || !pin) {
    throw new Error('Kit and PIN are required');
  }

  const data = naclUtil.decodeBase64(kitBase64);
  if (data.length < 1 + SALT_LEN + NONCE_LEN + 16) {
    throw new Error('Invalid recovery kit (too short)');
  }
  if (data[0] !== KIT_VERSION) {
    throw new Error('Unsupported recovery kit version');
  }

  const salt = data.slice(1, 1 + SALT_LEN);
  const nonce = data.slice(1 + SALT_LEN, 1 + SALT_LEN + NONCE_LEN);
  const encrypted = data.slice(1 + SALT_LEN + NONCE_LEN);

  const pinKey = derivePinKey(pin, salt);
  const decrypted = nacl.secretbox.open(encrypted, nonce, pinKey);

  if (!decrypted) {
    throw new Error('Incorrect PIN or corrupted kit');
  }

  const payload = JSON.parse(naclUtil.encodeUTF8(decrypted));
  if (!payload.email || !payload.password) {
    throw new Error('Invalid kit payload');
  }

  return { email: payload.email, password: payload.password };
};

/**
 * Validate that a kit string looks syntactically valid (base64, minimum length, correct version).
 * Does NOT verify the PIN — that requires actual decryption.
 * @param {string} kitBase64
 * @returns {boolean}
 */
export const isValidKitFormat = (kitBase64) => {
  try {
    const data = naclUtil.decodeBase64(kitBase64);
    return data.length >= 1 + SALT_LEN + NONCE_LEN + 16 && data[0] === KIT_VERSION;
  } catch (_) {
    return false;
  }
};
