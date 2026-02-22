// PhotoLynk NFT Service — Main Entry Point
//
// This module can be used in two ways:
//
// 1. INTEGRATED: Mount into existing Express server (recommended)
//    const nftService = require('./nft-service');
//    nftService.initialize();
//    app.use('/api/nft-service', authenticateToken, nftService.routes);
//
// 2. STANDALONE: Run as its own Express server
//    STANDALONE=1 node nft-service/index.js

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const config = require('./config');
const balance = require('./balance');
const solana = require('./solana');
const storage = require('./storage');
const { mintNFT } = require('./mint');
const routes = require('./routes');

/**
 * Initialize all subsystems
 * Call this once at startup before handling requests
 */
function initialize() {
  console.log('[NFT Service] Initializing...');

  // Initialize balance database
  balance.init();

  // Initialize Solana connection + load server keypair
  const solResult = solana.initialize();
  if (solResult.success) {
    console.log('[NFT Service] Solana ready. Server wallet:', solResult.walletAddress);
  } else {
    console.warn('[NFT Service] Solana init warning:', solResult.error);
    console.warn('[NFT Service] Minting will fail until keypair is configured.');
  }

  console.log('[NFT Service] Promo active:', config.isPromoActive());
  console.log('[NFT Service] Ready.');
}

// ============================================================================
// STANDALONE MODE
// ============================================================================

if (process.env.STANDALONE === '1' || require.main === module) {
  const express = require('express');
  const app = express();
  const PORT = process.env.PORT || 3100;

  app.use(express.json());

  // Simple auth middleware for standalone mode (replace with real auth in production)
  app.use('/api/nft-service', (req, res, next) => {
    // In standalone mode, expect Authorization: Bearer <token>
    // and extract user ID from token (simplified — use real JWT validation)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Placeholder: extract user ID from a simple token format
    // In production, validate JWT and extract user from your auth system
    req.user = { id: 1 }; // TODO: Replace with real auth
    next();
  });

  app.use('/api/nft-service', routes);

  // Health check
  app.get('/health', (req, res) => res.json({ ok: true, service: 'nft-service' }));

  initialize();

  app.listen(PORT, () => {
    console.log(`[NFT Service] Standalone server running on port ${PORT}`);
  });
}

module.exports = {
  initialize,
  routes,
  // Direct access to subsystems (for integration)
  balance,
  solana,
  storage,
  mintNFT,
  config,
};
