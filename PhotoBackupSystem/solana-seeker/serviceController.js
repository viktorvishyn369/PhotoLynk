// PhotoLynk Background Service Controller
// Bridges JS operations to the Android foreground service

import { NativeModules, Platform, PermissionsAndroid } from 'react-native';

const PhotoLynkServiceModule = NativeModules.PhotoLynkServiceModule;

let serviceRunning = false;
let operationGeneration = 0;

/**
 * Check if the foreground service is currently running.
 * Other modules use this to know whether they should pause when backgrounded.
 */
export function isBackgroundServiceRunning() {
  return serviceRunning;
}

/**
 * Request notification permission on Android 13+ before starting foreground service.
 * Without this the notification may be silently suppressed.
 */
async function ensureNotificationPermission() {
  if (Platform.OS !== 'android' || typeof Platform.Version !== 'number' || Platform.Version < 33) {
    return true;
  }
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
      console.warn('[serviceController] POST_NOTIFICATIONS denied — foreground service may not show');
    }
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) {
    return false;
  }
}

/**
 * Start the foreground service with a persistent notification.
 * Call this when beginning any long-running operation (backup, sync, upload).
 */
export async function startBackgroundService(title = 'PhotoLynk', body = 'Working in background…') {
  if (Platform.OS !== 'android' || !PhotoLynkServiceModule) return;
  try {
    // Fire-and-forget: don't block scan operations on notification permission.
    // If denied, the foreground service notification is silently suppressed
    // but the service still runs. Photo permission must come first.
    ensureNotificationPermission().catch(() => {});
    operationGeneration++;
    PhotoLynkServiceModule.startService(title, body);
    serviceRunning = true;
  } catch (e) {
    console.warn('[serviceController] startService failed:', e?.message);
  }
}

/**
 * Update the foreground service notification text.
 * Call this periodically to show progress (e.g. "Uploaded 12/50").
 */
export function updateBackgroundNotification(title, body) {
  if (Platform.OS !== 'android' || !PhotoLynkServiceModule) return;
  try {
    PhotoLynkServiceModule.updateNotification(title, body);
  } catch (e) {
    console.warn('[serviceController] updateNotification failed:', e?.message);
  }
}

/**
 * Stop the foreground service.
 * Call this when all background work is complete.
 * Uses a generation counter so a previous operation's finally block cannot
 * kill a newer operation's notification (race from cancelInFlightOperations).
 */
export function stopBackgroundService() {
  if (Platform.OS !== 'android' || !PhotoLynkServiceModule) return;
  try {
    // Only stop if no newer operation has started the service since this one.
    // Each startBackgroundService increments operationGeneration. If another
    // operation started after us, its generation will be higher and we must
    // NOT stop (it will stop itself when done).
    const myGeneration = operationGeneration;
    // Give any concurrent start a tick to increment the counter
    setTimeout(() => {
      if (operationGeneration === myGeneration) {
        PhotoLynkServiceModule.stopService();
        serviceRunning = false;
      } else {
        console.log('[serviceController] stopService skipped — newer operation is running');
      }
    }, 50);
  } catch (e) {
    console.warn('[serviceController] stopService failed:', e?.message);
  }
}
