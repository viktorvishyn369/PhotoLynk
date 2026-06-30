/**
 * cleanDuplicatesOperations.js
 * 
 * Handles clean duplicates UI operations and coordination with duplicateScanner.
 * Extracted from App.js to keep codebase modular.
 */

import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

/**
 * Starts the similar photos review process.
 * Scans device for similar photos and returns groups for review.
 * 
 * @param {Object} params - Parameters
 * @param {Function} params.resolveReadableFilePath - Function to resolve file paths
 * @param {Function} params.onStatus - Status update callback
 * @param {Function} params.onProgress - Progress update callback
 * @returns {Promise<Object>} Result with groups or error
 */
export const startSimilarShotsReviewCore = async ({
  resolveReadableFilePath,
  onStatus,
  onProgress,
  abortRef,
  t,
}) => {
  // Scanner handles all progress updates internally (0-100%)
  onStatus(t ? t('status.comparingPreparing') : 'Comparing: Preparing...');
  onProgress(0);
  
  try {
    // Check permission first
    const permission = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
    if (permission.status !== 'granted') {
      return { error: 'Photos permission not granted' };
    }
    if (Platform.OS === 'ios' && permission.accessPrivileges && permission.accessPrivileges !== 'all') {
      return { error: 'Limited Photos Access. Please allow Full Access.' };
    }

    // Use optimized duplicateScanner module
    const DuplicateScanner = require('./duplicateScannerOptimized').default;
    
    const result = await DuplicateScanner.scanSimilarPhotos({
      resolveReadableFilePath,
      abortRef,
      includeVideos: false,
      onStatus,
      onProgress,
      // Let scanner handle progress internally - no resets
      onCollecting: null,
      onFindingMatches: null,
    });

    // Check if scan was aborted
    if (result.aborted) {
      return { aborted: true };
    }

    // Scanner already set progress to 1
    
    const groups = result.groups || [];
    if (!groups || groups.length === 0) {
      return { noGroups: true };
    }

    return { groups };
  } catch (e) {
    return { error: e?.message || 'Could not scan for photos.' };
  }
};

/**
 * Builds default selection for a similar group (select all except first).
 * 
 * @param {Array} group - Array of similar items
 * @returns {Object} Selection map with asset IDs as keys
 */
export const buildDefaultSimilarSelection = (group) => {
  const items = Array.isArray(group) ? group : [];
  const next = {};
  for (let i = 1; i < items.length; i++) {
    const id = items[i] && items[i].id ? String(items[i].id) : '';
    if (id) next[id] = true;
  }
  return next;
};

/**
 * Gets array of selected asset IDs from selection map.
 * 
 * @param {Object} similarSelected - Selection map
 * @returns {Array<string>} Array of selected asset IDs
 */
export const getSelectedIds = (similarSelected) => {
  const sel = similarSelected && typeof similarSelected === 'object' ? similarSelected : {};
  return Object.keys(sel).filter(k => sel[k]);
};

/**
 * Toggles selection state for an asset.
 * 
 * @param {Object} prevSelected - Previous selection map
 * @param {string} assetId - Asset ID to toggle
 * @returns {Object} New selection map
 */
export const toggleSelection = (prevSelected, assetId) => {
  const key = assetId ? String(assetId) : '';
  if (!key) return prevSelected;
  const next = { ...(prevSelected || {}) };
  if (next[key]) {
    delete next[key];
  } else {
    next[key] = true;
  }
  return next;
};

/**
 * Deletes selected assets from the device.
 * Uses duplicateScanner's deleteAssets function.
 * 
 * @param {Array<string>} ids - Array of asset IDs to delete
 * @returns {Promise<Object>} Result with success status and deleted count
 */
export const deleteSelectedAssets = async (ids) => {
  if (!ids || ids.length === 0) {
    return { success: true, deleted: 0 };
  }

  const DuplicateScanner = require('./duplicateScannerOptimized').default;
  return await DuplicateScanner.deleteAssets(ids);
};

/**
 * Starts the exact duplicates scan process.
 * Scans device for exact duplicate photos and videos.
 * Photos are matched by visual fingerprint (perceptual dHash) — resistant to
 * re-saving, compression, and minor edits. Videos are matched by exact file
 * content (SHA-256). All supported image and video formats are included.
 *
 * @param {Object} params - Parameters
 * @param {Function} params.resolveReadableFilePath - Function to resolve file paths
 * @param {Function} params.onStatus - Status update callback
 * @param {Function} params.onProgress - Progress update callback
 * @returns {Promise<Object>} Result with duplicateGroups, stats, or error
 */
export const startExactDuplicatesScanCore = async ({
  resolveReadableFilePath,
  onStatus,
  onProgress,
  abortRef,
  t,
}) => {
  // Scanner handles all progress updates internally (0-100%)
  onStatus(t ? t('status.comparingPreparing') : 'Comparing: Preparing...');
  onProgress(0);
  
  try {
    // Check permission first
    const permission = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
    if (permission.status !== 'granted') {
      return { error: 'Photos permission not granted' };
    }
    if (Platform.OS === 'ios' && permission.accessPrivileges && permission.accessPrivileges !== 'all') {
      return { error: 'Limited Photos Access. Please allow Full Access.' };
    }

    // Use optimized duplicateScanner module
    const DuplicateScanner = require('./duplicateScannerOptimized').default;
    
    // Optimized scanner handles collection + hashing + grouping internally
    const { duplicateGroups, stats, aborted } = await DuplicateScanner.scanExactDuplicates({
      resolveReadableFilePath,
      abortRef,
      includeVideos: true,
      onStatus,
      onProgress,
    });

    // Check if scan was aborted
    if (aborted) {
      return { aborted: true };
    }

    if (!duplicateGroups || duplicateGroups.length === 0) {
      // Scanner already set progress to 1
      const note = DuplicateScanner.buildNoResultsNote(stats);
      return { noDuplicates: true, note, stats };
    }

    // Format for review
    const reviewGroups = DuplicateScanner.formatDuplicateGroupsForReview(duplicateGroups);
    const totalDuplicates = DuplicateScanner.countDuplicates(duplicateGroups);

    // Scanner already set progress to 1
    
    return {
      groups: reviewGroups,
      totalDuplicates,
      stats,
    };
  } catch (e) {
    return { error: e?.message || 'Could not scan for duplicates.' };
  }
};

export default {
  startSimilarShotsReviewCore,
  startExactDuplicatesScanCore,
  buildDefaultSimilarSelection,
  getSelectedIds,
  toggleSelection,
  deleteSelectedAssets,
};
