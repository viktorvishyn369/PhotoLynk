const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add polyfill resolvers for Solana compatibility
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  crypto: require.resolve('crypto-browserify'),
  stream: require.resolve('readable-stream'),
  zlib: require.resolve('browserify-zlib'),
  path: require.resolve('path-browserify'),
  url: require.resolve('react-native-url-polyfill'),
  assert: require.resolve('assert'),
};

module.exports = config;
