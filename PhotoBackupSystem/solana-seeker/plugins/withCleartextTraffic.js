const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    
    // Ensure manifest and application exist
    if (!androidManifest.manifest) {
      androidManifest.manifest = {};
    }
    if (!androidManifest.manifest.application) {
      androidManifest.manifest.application = [{}];
    }
    
    const mainApplication = androidManifest.manifest.application[0];
    
    // Ensure $ object exists for attributes
    if (!mainApplication.$) {
      mainApplication.$ = {};
    }
    
    // Add usesCleartextTraffic attribute
    mainApplication.$['android:usesCleartextTraffic'] = 'true';
    
    console.log('✅ Added android:usesCleartextTraffic="true" to AndroidManifest.xml');
    
    return config;
  });
};
