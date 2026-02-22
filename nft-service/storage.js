// IPFS / Arweave Upload Module
// Handles image and metadata uploads to decentralized storage
// Matches solana-seeker/nftOperations.js upload logic (server-side Node.js version)

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { PINATA_JWT, NFT_STORAGE_API_KEY, AKORD_API_KEY } = require('./config');

// ============================================================================
// PINATA IPFS (PRIMARY)
// ============================================================================

/**
 * Upload a file to IPFS via Pinata
 * @param {string} filePath - Local file path
 * @param {string} contentType - MIME type
 * @returns {{ success: boolean, url: string, cid: string, size: number, error?: string }}
 */
async function uploadToPinata(filePath, contentType = 'image/jpeg') {
  if (!PINATA_JWT) {
    throw new Error('Pinata JWT not configured');
  }

  const fileStream = fs.createReadStream(filePath);
  const stats = fs.statSync(filePath);
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append('file', fileStream, { filename, contentType });
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  form.append('pinataMetadata', JSON.stringify({ name: `photolynk_${filename}` }));

  const response = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    maxContentLength: 100 * 1024 * 1024, // 100MB
    timeout: 120000,
  });

  const cid = response.data.IpfsHash;
  console.log('[Storage] Pinata upload success, CID:', cid);

  return {
    success: true,
    url: `https://w3s.link/ipfs/${cid}`,
    ipfsUrl: `ipfs://${cid}`,
    cid,
    size: stats.size,
  };
}

// ============================================================================
// NFT.STORAGE (FALLBACK)
// ============================================================================

/**
 * Upload a file to IPFS via NFT.storage
 * @param {string} filePath - Local file path
 * @param {string} contentType - MIME type
 * @returns {{ success: boolean, url: string, cid: string, size: number, error?: string }}
 */
async function uploadToNftStorage(filePath, contentType = 'image/jpeg') {
  if (!NFT_STORAGE_API_KEY) {
    throw new Error('NFT.storage API key not configured');
  }

  const fileBuffer = fs.readFileSync(filePath);

  const response = await axios.post('https://api.nft.storage/upload', fileBuffer, {
    headers: {
      Authorization: `Bearer ${NFT_STORAGE_API_KEY}`,
      'Content-Type': contentType,
    },
    maxContentLength: 100 * 1024 * 1024,
    timeout: 120000,
  });

  if (response.data.ok && response.data.value?.cid) {
    const cid = response.data.value.cid;
    console.log('[Storage] NFT.storage upload success, CID:', cid);

    return {
      success: true,
      url: `https://nftstorage.link/ipfs/${cid}`,
      ipfsUrl: `ipfs://${cid}`,
      cid,
      size: fileBuffer.length,
    };
  }

  throw new Error('No CID returned from NFT.storage');
}

// ============================================================================
// UNIFIED UPLOAD (tries Pinata → NFT.storage)
// ============================================================================

/**
 * Upload image to IPFS (Pinata primary, NFT.storage fallback)
 * @param {string} filePath - Local file path
 * @param {string} contentType - MIME type
 * @returns {{ success: boolean, url: string, cid: string, size: number, error?: string }}
 */
async function uploadImage(filePath, contentType = 'image/jpeg') {
  // Try Pinata first
  if (PINATA_JWT) {
    try {
      return await uploadToPinata(filePath, contentType);
    } catch (e) {
      console.error('[Storage] Pinata upload failed:', e.message);
    }
  }

  // Fallback to NFT.storage
  if (NFT_STORAGE_API_KEY) {
    try {
      return await uploadToNftStorage(filePath, contentType);
    } catch (e) {
      console.error('[Storage] NFT.storage upload failed:', e.message);
    }
  }

  return { success: false, error: 'No IPFS upload service configured. Set PINATA_JWT or NFT_STORAGE_API_KEY.' };
}

/**
 * Upload metadata JSON to IPFS
 * @param {Object} metadata - NFT metadata object
 * @returns {{ success: boolean, url: string, cid: string, error?: string }}
 */
async function uploadMetadata(metadata) {
  const tmpPath = path.join(require('os').tmpdir(), `nft_metadata_${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2));

  try {
    const result = await uploadImage(tmpPath, 'application/json');
    return result;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

module.exports = {
  uploadImage,
  uploadMetadata,
  uploadToPinata,
  uploadToNftStorage,
};
