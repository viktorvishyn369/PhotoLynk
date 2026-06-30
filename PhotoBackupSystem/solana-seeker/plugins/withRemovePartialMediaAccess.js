const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Config plugin to remove READ_MEDIA_VISUAL_USER_SELECTED permission
 * This prevents Android 14+ from offering partial/selected-only media access
 * and forces full media library access instead.
 */
module.exports = function withRemovePartialMediaAccess(config) {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;
    
    // Find and remove READ_MEDIA_VISUAL_USER_SELECTED permission
    if (manifest['uses-permission']) {
      manifest['uses-permission'] = manifest['uses-permission'].filter(
        (perm) => {
          const name = perm.$?.['android:name'] || '';
          return name !== 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED';
        }
      );
    }
    
    return config;
  });
};
