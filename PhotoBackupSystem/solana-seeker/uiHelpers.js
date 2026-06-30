/**
 * UI Helper functions for PhotoLynk
 * Contains utility functions for alerts, formatting, and UI state management
 */

/**
 * Builds a standardized result message for backup/sync/cleanup operations.
 * @param {string} type - 'backup' | 'sync' | 'clean' | 'delete'
 * @param {Object} stats - Operation statistics
 * @returns {{ title: string, message: string }}
 */
export const buildResultMessage = (type, stats = {}) => {
  const titles = {
    backup: { success: 'Backup Complete', error: 'Backup Failed' },
    sync: { success: 'Sync Complete', error: 'Sync Failed' },
    clean: { success: 'Cleanup Complete', error: 'Cleanup Failed' },
    delete: { success: 'Delete Complete', error: 'Delete Failed' },
  };
  const isError = stats.error;
  const title = titles[type]?.[isError ? 'error' : 'success'] || (isError ? 'Error' : 'Complete');

  let message = '';
  if (isError) {
    message = String(stats.error);
  } else {
    const lines = [];
    if (type === 'backup') {
      const uploaded = stats.uploaded || 0;
      const totalSkipped = (stats.skipped || 0) + (stats.failed || 0);
      lines.push(`${uploaded} uploaded`);
      if (totalSkipped > 0) lines.push(`${totalSkipped} skipped`);
    } else if (type === 'sync') {
      const downloaded = stats.downloaded || 0;
      const totalSkipped = (stats.skipped || 0) + (stats.failed || 0);
      lines.push(`${downloaded} downloaded`);
      if (totalSkipped > 0) lines.push(`${totalSkipped} skipped`);
    } else if (type === 'clean') {
      const deleted = stats.deleted || 0;
      const kept = stats.kept || 0;
      lines.push(`${deleted} deleted`);
      if (kept > 0) lines.push(`${kept} kept`);
    } else if (type === 'delete') {
      const deleted = stats.deleted || 0;
      lines.push(`${deleted} deleted`);
    }
    message = lines.join(' • ');
  }

  return { title, message: message || 'Operation completed' };
};

/**
 * Resets the auth loading label with a timer-based sequence.
 * @param {Object} statusTimerRef - Ref for status timer
 * @param {Object} labelTimerRef - Ref for label timer
 * @param {Function} setAuthLoadingLabel - State setter
 * @param {string} initialLabel - Initial label to show
 */
export const resetAuthLoadingLabel = (statusTimerRef, labelTimerRef, setAuthLoadingLabel, initialLabel = 'Signing in...') => {
  if (statusTimerRef.current) {
    clearTimeout(statusTimerRef.current);
    statusTimerRef.current = null;
  }
  if (labelTimerRef.current) {
    clearTimeout(labelTimerRef.current);
    labelTimerRef.current = null;
  }
  setAuthLoadingLabel(initialLabel);
};

/**
 * Formats bytes to human-readable string.
 * @param {number} bytes - Number of bytes
 * @param {number} decimals - Decimal places (default 2)
 * @returns {string} Formatted string like "1.5 GB"
 */
export const formatBytes = (bytes, decimals = 2) => {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Formats a date to a readable string.
 * @param {Date|string|number} date - Date to format
 * @returns {string} Formatted date string
 */
export const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

/**
 * Checks if a StealthCloud tier can be created based on capacity.
 * @param {number} tierGb - Tier size in GB (100, 200, 400, 1000)
 * @param {Object|null} capacity - Capacity object from server
 * @returns {{canCreate: boolean, message: string|null}} Tier status
 */
export const checkTierAvailability = (tierGb, capacity) => {
  const tierBytes = Number(tierGb) * 1_000_000_000;
  const c = capacity && typeof capacity === 'object' ? capacity : null;
  if (!c) return { canCreate: true, message: null };

  const tiers = c.tiers && typeof c.tiers === 'object' ? c.tiers : null;
  if (tiers) {
    const direct = tiers[String(tierGb)] || tiers[tierGb];
    if (direct && typeof direct === 'object') {
      if (typeof direct.canCreate === 'boolean') {
        return { canCreate: direct.canCreate, message: direct.message || c.message || null };
      }
      if (typeof direct.available === 'boolean') {
        return { canCreate: direct.available, message: direct.message || c.message || null };
      }
    }
  }

  const totalBytes = typeof c.totalBytes === 'number' ? c.totalBytes : (c.totalBytes ? Number(c.totalBytes) : null);
  const freeBytes = typeof c.freeBytes === 'number' ? c.freeBytes : (c.freeBytes ? Number(c.freeBytes) : null);
  const allocatedBytes = typeof c.allocatedBytes === 'number' ? c.allocatedBytes : (c.allocatedBytes ? Number(c.allocatedBytes) : 0);
  const usedBytes = typeof c.usedBytes === 'number' ? c.usedBytes : (c.usedBytes ? Number(c.usedBytes) : 0);

  let availableBytes = null;
  if (typeof c.availableBytes === 'number') availableBytes = c.availableBytes;
  else if (c.availableBytes) availableBytes = Number(c.availableBytes);
  else if (freeBytes !== null) availableBytes = freeBytes;
  else if (totalBytes !== null) availableBytes = totalBytes - usedBytes - allocatedBytes;

  if (availableBytes === null || Number.isNaN(availableBytes)) {
    return { canCreate: true, message: c.message || null };
  }

  return {
    canCreate: availableBytes >= tierBytes,
    message: c.message || null,
  };
};

export default {
  buildResultMessage,
  resetAuthLoadingLabel,
  formatBytes,
  formatDate,
  checkTierAvailability,
};
