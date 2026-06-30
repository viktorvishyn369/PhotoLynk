// PhotoLynk Mobile App - Restore History Persistence
// Tracks which files have been restored to avoid re-downloading renamed assets

import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

const RESTORE_HISTORY_KEY = 'restore_history';
const RESTORE_HISTORY_FILE = `${FileSystem.documentDirectory}restore_history_v2.json`;

/**
 * Create a history key from type and id
 */
export const makeHistoryKey = (type, id) => `${type}:${id}`;

/**
 * Load restore history from persistent storage
 * Tries FileSystem first (handles large data), falls back to SecureStore
 */
export const loadRestoreHistory = async () => {
  try {
    // Try FileSystem first (handles large data)
    try {
      const info = await FileSystem.getInfoAsync(RESTORE_HISTORY_FILE);
      if (info && info.exists) {
        const rawFile = await FileSystem.readAsStringAsync(RESTORE_HISTORY_FILE);
        if (rawFile) {
          const parsedFile = JSON.parse(rawFile);
          if (Array.isArray(parsedFile)) {
            return new Set(parsedFile.filter(Boolean));
          }
        }
      }
    } catch (e) {
      // ignore FileSystem errors
    }

    // Fallback to SecureStore (legacy, limited to 2048 bytes)
    const raw = await SecureStore.getItemAsync(RESTORE_HISTORY_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const set = new Set(parsed.filter(Boolean));

    // Migrate to FileSystem for future use
    try {
      await FileSystem.writeAsStringAsync(RESTORE_HISTORY_FILE, JSON.stringify([...set]));
    } catch (e) {
      // ignore migration errors
    }

    return set;
  } catch (e) {
    return new Set();
  }
};

/**
 * Save restore history to persistent storage
 * Uses FileSystem for large data, SecureStore for small data
 */
export const saveRestoreHistory = async (set) => {
  try {
    const data = JSON.stringify([...set]);
    const dataSize = new Blob([data]).size; // Approximate size in bytes

    // Always try FileSystem first (handles large data)
    try {
      await FileSystem.writeAsStringAsync(RESTORE_HISTORY_FILE, data);
    } catch (e) {
      console.warn('FileSystem save failed:', e.message);
    }

    // Only use SecureStore for small data to avoid 2048 byte limit
    if (dataSize <= 1800) { // Leave some buffer below 2048 limit
      try {
        await SecureStore.setItemAsync(RESTORE_HISTORY_KEY, data);
      } catch (e) {
        console.warn('SecureStore save failed (size limit?):', e.message);
      }
    } else {
      // For large data, clear SecureStore to avoid stale data
      try {
        await SecureStore.deleteItemAsync(RESTORE_HISTORY_KEY);
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    console.warn('saveRestoreHistory failed:', e.message);
  }
};

/**
 * Clear all restore history
 */
export const clearRestoreHistory = async () => {
  try {
    await FileSystem.deleteAsync(RESTORE_HISTORY_FILE, { idempotent: true });
    console.log('Cleared restore history file');
  } catch (e) {
    console.warn('Failed to clear restore history file:', e.message);
  }
  try {
    await SecureStore.deleteItemAsync(RESTORE_HISTORY_KEY);
    console.log('Cleared restore history from SecureStore');
  } catch (e) {
    console.warn('Failed to clear restore history from SecureStore:', e.message);
  }
};
