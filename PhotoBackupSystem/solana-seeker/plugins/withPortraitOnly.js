const { withAndroidManifest, withInfoPlist } = require('@expo/config-plugins');

/**
 * Force portrait-only orientation on ALL devices including tablets
 */
const withPortraitOnly = (config) => {
  // Android: Force portrait orientation
  config = withAndroidManifest(config, (config) => {
    const mainApplication = config.modResults.manifest.application[0];
    const mainActivity = mainApplication.activity.find(
      (activity) => activity.$['android:name'] === '.MainActivity'
    );
    if (mainActivity) {
      // Use 'portrait' to strictly lock orientation on all devices
      mainActivity.$['android:screenOrientation'] = 'portrait';
    }
    return config;
  });

  // iOS: Force portrait orientation and disable multitasking (which allows rotation on iPad)
  config = withInfoPlist(config, (config) => {
    // Lock to portrait only
    config.modResults.UISupportedInterfaceOrientations = ['UIInterfaceOrientationPortrait'];
    config.modResults['UISupportedInterfaceOrientations~ipad'] = ['UIInterfaceOrientationPortrait'];
    // Require full screen to prevent split view rotation on iPad
    config.modResults.UIRequiresFullScreen = true;
    return config;
  });

  return config;
};

module.exports = withPortraitOnly;
