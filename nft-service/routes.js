// Express Routes for NFT Service
// These routes are mounted into the main server (or run standalone)
// All routes require authentication via the parent server's authenticateToken middleware
//
// Mobile-v2 integration:
//   POST /api/nft-service/estimate    — Get cost estimate before minting
//   GET  /api/nft-service/balance     — Get user's NFT credit balance
//   POST /api/nft-service/credit      — Add credit (after in-app purchase verification)
//   POST /api/nft-service/mint        — Upload image + mint cNFT (multipart)
//   GET  /api/nft-service/history     — Transaction history
//   GET  /api/nft-service/album       — Fetch user's minted NFTs (for gallery)
//   GET  /api/nft-service/status      — Service health + server wallet balance

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const balance = require('./balance');
const solana = require('./solana');
const { mintNFT } = require('./mint');
const { NFT_LICENSE_OPTIONS, NFT_EDITION, isPromoActive } = require('./config');

const router = express.Router();

// Multer config for image uploads (store in temp dir, max 50MB)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tmpDir = path.join(os.tmpdir(), 'nft-service-uploads');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `nft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|gif)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ============================================================================
// GET /api/nft-service/status — Service health check
// ============================================================================

router.get('/status', async (req, res) => {
  try {
    const initResult = solana.initialize();
    let serverBalance = null;
    if (initResult.success) {
      try { serverBalance = await solana.getServerBalance(); } catch (_) {}
    }

    res.json({
      ok: initResult.success,
      walletAddress: initResult.walletAddress || null,
      serverBalanceSol: serverBalance,
      promoActive: isPromoActive(),
      licenses: NFT_LICENSE_OPTIONS.map(l => ({ id: l.id, label: l.label, short: l.short })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================================
// GET /api/nft-service/balance — Get user's NFT credit balance
// ============================================================================

router.get('/balance', (req, res) => {
  try {
    const userId = req.user.id;
    const bal = balance.getBalance(userId);
    res.json({
      balanceUsd: bal.balanceUsd,
      totalPurchased: bal.totalPurchased,
      totalSpent: bal.totalSpent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// POST /api/nft-service/credit — Add credit after in-app purchase
// Body: { amountUsd: number, receiptId: string, platform: 'ios'|'android' }
// ============================================================================

router.post('/credit', (req, res) => {
  try {
    const userId = req.user.id;
    const { amountUsd, receiptId, platform } = req.body;

    if (!amountUsd || amountUsd <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // TODO: Verify the in-app purchase receipt with Apple/Google before crediting
    // For now, trust the client (replace with server-side receipt validation in production)
    //
    // iOS:  Verify with App Store Server API (https://developer.apple.com/documentation/appstoreserverapi)
    // Android: Verify with Google Play Developer API (https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products)
    //
    // Example:
    // const verified = await verifyReceipt(platform, receiptId, amountUsd);
    // if (!verified) return res.status(403).json({ error: 'Receipt verification failed' });

    const description = `NFT Package $${amountUsd} (${platform || 'unknown'}) receipt:${receiptId || 'none'}`;
    const result = balance.addCredit(userId, amountUsd, description);

    res.json({
      success: true,
      balanceUsd: result.balanceUsd,
      totalPurchased: result.totalPurchased,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// POST /api/nft-service/estimate — Estimate minting cost
// Body: { fileSizeBytes: number, storageOption?: string, edition?: string }
// ============================================================================

router.post('/estimate', async (req, res) => {
  try {
    const userId = req.user.id;
    const { fileSizeBytes, storageOption, edition } = req.body;

    if (!fileSizeBytes || fileSizeBytes <= 0) {
      return res.status(400).json({ error: 'fileSizeBytes is required' });
    }

    const estimate = await solana.estimateMintCost(
      fileSizeBytes,
      storageOption || 'ipfs',
      edition || 'open'
    );

    const bal = balance.getBalance(userId);
    const canAfford = bal.balanceUsd >= estimate.totalUsd;

    res.json({
      ...estimate,
      balanceUsd: bal.balanceUsd,
      canAfford,
      shortfall: canAfford ? 0 : Math.round((estimate.totalUsd - bal.balanceUsd) * 100) / 100,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// POST /api/nft-service/mint — Upload image and mint cNFT
// Multipart form: image (file), name (string), description? (string),
//   edition? (string), license? (string), stripExif? (boolean),
//   recipientAddress? (string)
// ============================================================================

router.post('/mint', upload.single('image'), async (req, res) => {
  let imagePath = null;

  try {
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    imagePath = req.file.path;
    const { name, description, edition, license, stripExif, recipientAddress, storageOption } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'NFT name is required' });
    }

    console.log(`[Routes] Mint request: user=${userId} name="${name}" file=${req.file.originalname} size=${req.file.size}`);

    const result = await mintNFT({
      userId,
      imagePath,
      name: name.trim(),
      description: description || '',
      recipientAddress: recipientAddress || undefined,
      stripExifData: stripExif !== 'false',
      storageOption: storageOption || 'ipfs',
      edition: edition || 'open',
      license: license || 'arr',
    });

    if (result.success) {
      res.json({
        success: true,
        assetId: result.assetId,
        mintAddress: result.mintAddress,
        txSignature: result.txSignature,
        isCompressed: result.isCompressed,
        imageUrl: result.imageUrl,
        thumbnailUrl: result.thumbnailUrl,
        metadataUrl: result.metadataUrl,
        contentHash: result.contentHash,
        costUsd: result.costUsd,
        balanceUsd: result.balanceUsd,
        ownerAddress: result.ownerAddress,
      });
    } else {
      const status = result.error?.includes('Insufficient') ? 402 : 500;
      res.status(status).json({
        success: false,
        error: result.error,
        balanceUsd: result.balanceUsd,
        costUsd: result.costUsd,
        shortfall: result.shortfall,
      });
    }
  } catch (e) {
    console.error('[Routes] Mint error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    // Cleanup uploaded file
    if (imagePath) {
      try { fs.unlinkSync(imagePath); } catch (_) {}
    }
  }
});

// ============================================================================
// GET /api/nft-service/history — Transaction history
// Query: ?limit=50
// ============================================================================

router.get('/history', (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    const transactions = balance.getTransactions(userId, limit);
    const bal = balance.getBalance(userId);

    res.json({
      balanceUsd: bal.balanceUsd,
      transactions,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
