// NFT Mint Orchestrator
// Coordinates the full minting flow:
// 1. Validate user balance
// 2. Estimate cost
// 3. Deduct balance (pre-charge)
// 4. Upload image to IPFS
// 5. Build & upload metadata
// 6. Mint cNFT on Solana
// 7. Refund on failure
// 8. Return result with updated balance

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256 } = require('js-sha256');
const sharp = require('sharp');

const { NFT_EDITION, NFT_LICENSE_OPTIONS } = require('./config');
const balance = require('./balance');
const storage = require('./storage');
const solana = require('./solana');

/**
 * Build Metaplex-compatible NFT metadata JSON
 * Matches solana-seeker/nftOperations.js buildNFTMetadata structure
 */
function buildMetadata({ name, description, imageUrl, ownerAddress, contentHash, fileSize, edition, license, storageOption, mintTimestamp }) {
  const isLimited = edition === NFT_EDITION.LIMITED;
  const licenseObj = NFT_LICENSE_OPTIONS.find(l => l.id === license) || NFT_LICENSE_OPTIONS[0];

  const metadata = {
    name: name || 'Photo NFT',
    symbol: 'PLNK',
    description: description || (isLimited
      ? `Limited Edition photograph — ${licenseObj.label}. Minted via PhotoLynk.`
      : `Photo NFT minted via PhotoLynk.`),
    image: imageUrl,
    external_url: 'https://stealthlynk.io',
    attributes: [
      { trait_type: 'App', value: 'PhotoLynk' },
      { trait_type: 'Edition', value: isLimited ? 'Limited' : 'Open' },
      { trait_type: 'License', value: licenseObj.short },
      { trait_type: 'Storage', value: storageOption || 'ipfs' },
      { trait_type: 'Mint Platform', value: 'nft-service' },
    ],
    properties: {
      files: [{ uri: imageUrl, type: 'image/jpeg' }],
      category: 'image',
      creators: [{ address: ownerAddress, share: 100 }],
    },
  };

  // Integrity proof
  if (contentHash) {
    metadata.attributes.push({ trait_type: 'Content Hash', value: contentHash });
  }
  if (fileSize) {
    metadata.attributes.push({ trait_type: 'Original Size', value: String(fileSize) });
  }
  if (mintTimestamp) {
    metadata.attributes.push({ trait_type: 'Mint Timestamp', value: mintTimestamp });
  }

  return metadata;
}

/**
 * Compute SHA-256 content hash of a file
 * Matches solana-seeker/nftOperations.js computeContentHash
 */
function computeContentHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return sha256(fileBuffer);
}

/**
 * Strip EXIF metadata from an image for privacy
 * @param {string} filePath
 * @returns {string} Path to stripped file
 */
async function stripExif(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const tmpPath = path.join(require('os').tmpdir(), `nft_stripped_${Date.now()}${ext}`);

  try {
    if (ext === '.png') {
      await sharp(filePath).png().toFile(tmpPath);
    } else {
      await sharp(filePath).jpeg({ quality: 95 }).toFile(tmpPath);
    }
    return tmpPath;
  } catch (e) {
    console.warn('[Mint] EXIF stripping failed, using original:', e.message);
    return filePath;
  }
}

/**
 * Generate a thumbnail for gallery display
 * @param {string} filePath
 * @param {number} width - Thumbnail width in pixels
 * @returns {{ success: boolean, thumbnailPath?: string }}
 */
async function generateThumbnail(filePath, width = 400) {
  const tmpPath = path.join(require('os').tmpdir(), `nft_thumb_${Date.now()}.jpg`);
  try {
    await sharp(filePath)
      .resize(width, null, { withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toFile(tmpPath);
    return { success: true, thumbnailPath: tmpPath };
  } catch (e) {
    console.warn('[Mint] Thumbnail generation failed:', e.message);
    return { success: false };
  }
}

/**
 * Full NFT minting flow
 *
 * @param {Object} params
 * @param {number} params.userId - Authenticated user ID
 * @param {string} params.imagePath - Path to uploaded image on server
 * @param {string} params.name - NFT name
 * @param {string} params.description - NFT description (optional)
 * @param {string} params.recipientAddress - Solana wallet address to own the NFT
 *   If not provided, the server wallet is used as owner (custodial)
 * @param {boolean} params.stripExifData - Remove EXIF for privacy (default: true)
 * @param {string} params.storageOption - 'ipfs' (default)
 * @param {string} params.edition - 'open' | 'limited' (default: 'open')
 * @param {string} params.license - License ID (default: 'arr')
 * @param {Function} params.onProgress - Progress callback (stage, percent)
 * @returns {Object} Mint result with balance info
 */
async function mintNFT({
  userId,
  imagePath,
  name,
  description,
  recipientAddress,
  stripExifData = true,
  storageOption = 'ipfs',
  edition = 'open',
  license = 'arr',
  onProgress,
}) {
  const cleanupFiles = [];
  let preChargeAmount = 0;

  const progress = (stage, pct) => {
    if (onProgress) onProgress(stage, pct);
    console.log(`[Mint] ${stage} (${Math.round(pct * 100)}%)`);
  };

  try {
    // ── 1. Validate inputs ──
    progress('Validating', 0.05);

    if (!imagePath || !fs.existsSync(imagePath)) {
      return { success: false, error: 'Image file not found' };
    }

    const fileStats = fs.statSync(imagePath);
    const fileSize = fileStats.size;

    if (!name || name.trim().length === 0) {
      return { success: false, error: 'NFT name is required' };
    }

    // Initialize Solana
    const initResult = solana.initialize();
    if (!initResult.success) {
      return { success: false, error: initResult.error };
    }

    // Use server wallet as recipient if none provided (custodial mode)
    const ownerAddress = recipientAddress || initResult.walletAddress;

    // ── 2. Estimate cost ──
    progress('Estimating cost', 0.10);
    const costEstimate = await solana.estimateMintCost(fileSize, storageOption, edition);
    const totalCostUsd = costEstimate.totalUsd;

    // ── 3. Check & deduct balance ──
    progress('Checking balance', 0.15);
    const affordCheck = balance.canAfford(userId, totalCostUsd);
    if (!affordCheck.canAfford) {
      return {
        success: false,
        error: 'Insufficient NFT credit balance',
        balanceUsd: affordCheck.balanceUsd,
        costUsd: totalCostUsd,
        shortfall: affordCheck.shortfall,
      };
    }

    // Pre-charge (deduct now, refund on failure)
    const deductResult = balance.deductBalance(userId, totalCostUsd, '', '', `Pre-charge: ${name}`);
    if (!deductResult.success) {
      return { success: false, error: deductResult.error, balanceUsd: deductResult.balanceUsd };
    }
    preChargeAmount = totalCostUsd;

    // ── 4. Process image ──
    progress('Processing image', 0.20);
    let uploadPath = imagePath;

    if (stripExifData) {
      const strippedPath = await stripExif(imagePath);
      if (strippedPath !== imagePath) {
        uploadPath = strippedPath;
        cleanupFiles.push(strippedPath);
      }
    }

    // Compute content hash of original file
    const contentHash = computeContentHash(imagePath);

    // ── 5. Upload image to IPFS ──
    progress('Uploading image', 0.30);
    const imageUpload = await storage.uploadImage(uploadPath, 'image/jpeg');
    if (!imageUpload.success) {
      throw new Error('Image upload failed: ' + imageUpload.error);
    }
    console.log('[Mint] Image uploaded:', imageUpload.url);

    // ── 6. Generate & upload thumbnail ──
    progress('Creating thumbnail', 0.45);
    let thumbnailUrl = null;
    const thumbResult = await generateThumbnail(uploadPath);
    if (thumbResult.success) {
      cleanupFiles.push(thumbResult.thumbnailPath);
      const thumbUpload = await storage.uploadImage(thumbResult.thumbnailPath, 'image/jpeg');
      if (thumbUpload.success) {
        thumbnailUrl = thumbUpload.url;
      }
    }

    // ── 7. Build & upload metadata ──
    progress('Building metadata', 0.55);
    const mintTimestamp = new Date().toISOString();
    const metadata = buildMetadata({
      name,
      description,
      imageUrl: imageUpload.url,
      ownerAddress,
      contentHash,
      fileSize,
      edition,
      license,
      storageOption,
      mintTimestamp,
    });

    progress('Uploading metadata', 0.60);
    const metadataUpload = await storage.uploadMetadata(metadata);
    if (!metadataUpload.success) {
      throw new Error('Metadata upload failed: ' + metadataUpload.error);
    }
    console.log('[Mint] Metadata uploaded:', metadataUpload.url);

    // ── 8. Mint cNFT on Solana ──
    progress('Minting on Solana', 0.70);
    const mintResult = await solana.mintCNFT({
      recipientAddress: ownerAddress,
      nftName: name,
      metadataUrl: metadataUpload.url,
      imageUrl: imageUpload.url,
    });

    if (!mintResult.success) {
      throw new Error('Solana minting failed: ' + mintResult.error);
    }

    // ── 9. Update balance record with mint address ──
    progress('Finalizing', 0.90);

    // Update the pre-charge transaction with the actual mint address
    // (The deductBalance already recorded it; this is informational)
    console.log('[Mint] Success! Asset:', mintResult.assetId, 'Tx:', mintResult.txSignature);

    // Get final balance
    const finalBalance = balance.getBalance(userId);

    progress('Complete', 1.0);

    return {
      success: true,
      assetId: mintResult.assetId,
      mintAddress: mintResult.assetId,
      txSignature: mintResult.txSignature,
      isCompressed: true,
      merkleTree: mintResult.merkleTree,
      imageUrl: imageUpload.url,
      thumbnailUrl,
      metadataUrl: metadataUpload.url,
      metadata,
      contentHash,
      costUsd: totalCostUsd,
      balanceUsd: finalBalance.balanceUsd,
      ownerAddress,
    };
  } catch (e) {
    console.error('[Mint] Failed:', e.message);

    // Refund pre-charge on failure
    if (preChargeAmount > 0) {
      try {
        balance.refund(userId, preChargeAmount, `Mint failed: ${e.message.slice(0, 100)}`);
        console.log('[Mint] Pre-charge refunded:', preChargeAmount);
      } catch (refundErr) {
        console.error('[Mint] CRITICAL: Refund failed:', refundErr.message);
      }
    }

    const finalBalance = balance.getBalance(userId);
    return {
      success: false,
      error: e.message,
      balanceUsd: finalBalance.balanceUsd,
    };
  } finally {
    // Cleanup temp files
    for (const f of cleanupFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

module.exports = {
  mintNFT,
  buildMetadata,
  computeContentHash,
};
