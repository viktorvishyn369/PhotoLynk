// Solana Blockchain Module
// Handles connection, cNFT minting via Bubblegum, cost estimation
// Server-side version — uses a server keypair to sign and pay for transactions
// The server wallet pays Solana fees; the user pays via USD credit balance

const fs = require('fs');
const {
  SOLANA_RPC_URL,
  SOLANA_RPC_FALLBACKS,
  WALLET_KEYPAIR_PATH,
  MERKLE_TREE,
  COMMISSION_WALLET,
  PROGRAM_IDS,
  getCurrentFees,
  computeLimitedEditionFee,
  ARWEAVE_UPLOAD_BASE_USD,
  ARWEAVE_PER_KB_USD,
  NFT_STORAGE_OPTIONS,
  NFT_EDITION,
} = require('./config');

// ============================================================================
// SOLANA WEB3 IMPORTS
// ============================================================================

const {
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
  TransactionInstruction,
  ComputeBudgetProgram,
} = require('@solana/web3.js');

let connection = null;
let serverKeypair = null;

// ============================================================================
// SOL PRICE CACHE
// ============================================================================

let cachedSolPrice = null;
let solPriceLastFetch = 0;
const SOL_PRICE_CACHE_MS = 15000;

async function fetchSolPrice() {
  const now = Date.now();
  if (cachedSolPrice && (now - solPriceLastFetch) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice;
  }

  const axios = require('axios');
  const apis = [
    { url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', extract: (d) => d?.solana?.usd },
    { url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', extract: (d) => parseFloat(d?.price) },
    { url: 'https://api.coincap.io/v2/assets/solana', extract: (d) => parseFloat(d?.data?.priceUsd) },
    { url: 'https://price.jup.ag/v4/price?ids=SOL', extract: (d) => d?.data?.SOL?.price },
  ];

  for (const api of apis) {
    try {
      const { data } = await axios.get(api.url, { timeout: 8000 });
      const price = Number(api.extract(data));
      if (Number.isFinite(price) && price > 0) {
        cachedSolPrice = price;
        solPriceLastFetch = now;
        return cachedSolPrice;
      }
    } catch (_) {
      continue;
    }
  }

  const fallback = (cachedSolPrice && cachedSolPrice > 0) ? cachedSolPrice : 150;
  cachedSolPrice = fallback;
  solPriceLastFetch = now;
  return cachedSolPrice;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Solana connection and load server keypair
 * @returns {{ success: boolean, walletAddress?: string, error?: string }}
 */
function initialize() {
  if (connection && serverKeypair) {
    return { success: true, walletAddress: serverKeypair.publicKey.toBase58() };
  }

  // Connection
  connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  console.log('[Solana] Connection initialized:', SOLANA_RPC_URL);

  // Load server keypair
  if (!fs.existsSync(WALLET_KEYPAIR_PATH)) {
    return { success: false, error: `Wallet keypair not found: ${WALLET_KEYPAIR_PATH}. Run: npm run generate-keypair` };
  }

  try {
    const keypairData = JSON.parse(fs.readFileSync(WALLET_KEYPAIR_PATH, 'utf8'));
    serverKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
    console.log('[Solana] Server wallet loaded:', serverKeypair.publicKey.toBase58());
    return { success: true, walletAddress: serverKeypair.publicKey.toBase58() };
  } catch (e) {
    return { success: false, error: `Failed to load keypair: ${e.message}` };
  }
}

/**
 * Get server wallet SOL balance
 * @returns {number} Balance in SOL
 */
async function getServerBalance() {
  if (!connection || !serverKeypair) initialize();
  const lamports = await connection.getBalance(serverKeypair.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

// ============================================================================
// PRIORITY FEE ESTIMATION
// ============================================================================

let _cachedPriorityFee = null;
let _cachedPriorityFeeTs = 0;
const PRIORITY_FEE_CACHE_MS = 30000;

async function getMedianPriorityFee() {
  const now = Date.now();
  if (_cachedPriorityFee !== null && (now - _cachedPriorityFeeTs) < PRIORITY_FEE_CACHE_MS) {
    return _cachedPriorityFee;
  }

  try {
    const recentFees = await connection.getRecentPrioritizationFees();
    if (Array.isArray(recentFees) && recentFees.length) {
      const vals = recentFees
        .map(f => Number(f.prioritizationFee))
        .filter(n => Number.isFinite(n) && n >= 0)
        .sort((a, b) => a - b);
      const medianMicroLamports = vals[Math.floor(vals.length / 2)] || 0;
      _cachedPriorityFee = medianMicroLamports;
      _cachedPriorityFeeTs = now;
      return medianMicroLamports;
    }
  } catch (_) {}

  _cachedPriorityFee = _cachedPriorityFee || 0;
  _cachedPriorityFeeTs = now;
  return _cachedPriorityFee;
}

// ============================================================================
// COST ESTIMATION (matches solana-seeker/nftOperations.js estimateNFTMintCost)
// ============================================================================

/**
 * Estimate total NFT minting cost in USD
 * @param {number} imageSizeBytes
 * @param {string} storageOption - 'ipfs' | 'cloud' | 'arweave' | 'onchain'
 * @param {string} edition - 'open' | 'limited'
 * @returns {Object} Cost breakdown
 */
async function estimateMintCost(imageSizeBytes, storageOption = 'ipfs', edition = 'open') {
  if (!connection) initialize();

  const solPrice = await fetchSolPrice();
  const fees = getCurrentFees();
  const isLimited = edition === NFT_EDITION.LIMITED;
  const useCloud = storageOption === NFT_STORAGE_OPTIONS.STEALTHCLOUD;
  const useOnChain = storageOption === NFT_STORAGE_OPTIONS.ONCHAIN;

  // Storage upload cost (image + metadata)
  const imageUploadUsd = (useCloud || useOnChain)
    ? 0
    : ARWEAVE_UPLOAD_BASE_USD + (imageSizeBytes / 1024) * ARWEAVE_PER_KB_USD;
  const metadataBytes = useOnChain ? (imageSizeBytes + 2000) : 2000;
  const metadataUploadUsd = ARWEAVE_UPLOAD_BASE_USD + (metadataBytes / 1024) * ARWEAVE_PER_KB_USD;

  // Solana network costs (cNFT only — server always mints compressed)
  const baseFeeSol = 0.000005;
  const medianMicroLamports = await getMedianPriorityFee();
  const cuEstimate = 80000; // cNFT compute units
  const priorityFeeSol = Math.ceil((medianMicroLamports * cuEstimate) / 1_000_000) / 1e9;
  const transactionFeeSol = baseFeeSol + priorityFeeSol;

  // App commission (your fee)
  const appCommissionUsd = isLimited
    ? computeLimitedEditionFee(imageSizeBytes)
    : (useCloud ? fees.APP_COMMISSION_CNFT_CLOUD_USD : fees.APP_COMMISSION_CNFT_IPFS_USD);

  // Total in USD
  const networkCostUsd = transactionFeeSol * solPrice;
  const storageCostUsd = imageUploadUsd + metadataUploadUsd;
  const totalUsd = networkCostUsd + storageCostUsd + appCommissionUsd;

  return {
    totalUsd: Math.round(totalUsd * 100) / 100,
    totalUsdFormatted: `$${totalUsd.toFixed(2)}`,
    breakdown: {
      networkCostUsd: Math.round(networkCostUsd * 100) / 100,
      storageCostUsd: Math.round(storageCostUsd * 100) / 100,
      appCommissionUsd: Math.round(appCommissionUsd * 100) / 100,
      transactionFeeSol,
    },
    solPrice,
    isCompressed: true,
  };
}

// ============================================================================
// BORSH SERIALIZATION (matches solana-seeker/nftOperations.js serializeMetadataArgs)
// ============================================================================

function serializeString(str) {
  const encoded = Buffer.from(str, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(encoded.length, 0);
  return Buffer.concat([lenBuf, encoded]);
}

function serializeMetadataArgs(args) {
  const parts = [];

  // name: string
  parts.push(serializeString(args.name));
  // symbol: string
  parts.push(serializeString(args.symbol));
  // uri: string
  parts.push(serializeString(args.uri));
  // sellerFeeBasisPoints: u16
  const bpBuf = Buffer.alloc(2);
  bpBuf.writeUInt16LE(args.sellerFeeBasisPoints, 0);
  parts.push(bpBuf);
  // primarySaleHappened: bool
  parts.push(Buffer.from([args.primarySaleHappened ? 1 : 0]));
  // isMutable: bool
  parts.push(Buffer.from([args.isMutable ? 1 : 0]));

  // editionNonce: Option<u8>
  if (args.editionNonce != null) {
    parts.push(Buffer.from([1, args.editionNonce]));
  } else {
    parts.push(Buffer.from([0]));
  }

  // tokenStandard: Option<u8>
  if (args.tokenStandard != null) {
    parts.push(Buffer.from([1, args.tokenStandard]));
  } else {
    parts.push(Buffer.from([0]));
  }

  // collection: Option<Collection>
  if (args.collection) {
    parts.push(Buffer.from([1]));
    parts.push(Buffer.from([args.collection.verified ? 1 : 0]));
    const collKey = typeof args.collection.key === 'string'
      ? new PublicKey(args.collection.key).toBuffer()
      : args.collection.key.toBuffer();
    parts.push(collKey);
  } else {
    parts.push(Buffer.from([0]));
  }

  // uses: Option<Uses>
  if (args.uses) {
    parts.push(Buffer.from([1]));
    parts.push(Buffer.from([args.uses.useMethod]));
    const remainBuf = Buffer.alloc(8);
    remainBuf.writeBigUInt64LE(BigInt(args.uses.remaining), 0);
    parts.push(remainBuf);
    const totalBuf = Buffer.alloc(8);
    totalBuf.writeBigUInt64LE(BigInt(args.uses.total), 0);
    parts.push(totalBuf);
  } else {
    parts.push(Buffer.from([0]));
  }

  // tokenProgramVersion: u8
  parts.push(Buffer.from([args.tokenProgramVersion || 0]));

  // creators: Option<Vec<Creator>>
  if (args.creators && args.creators.length > 0) {
    parts.push(Buffer.from([1])); // Some
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(args.creators.length, 0);
    parts.push(lenBuf);
    for (const creator of args.creators) {
      const addr = typeof creator.address === 'string'
        ? new PublicKey(creator.address).toBuffer()
        : creator.address.toBuffer();
      parts.push(addr);
      parts.push(Buffer.from([creator.verified ? 1 : 0]));
      parts.push(Buffer.from([creator.share]));
    }
  } else {
    parts.push(Buffer.from([0])); // None
  }

  return Buffer.concat(parts);
}

// ============================================================================
// cNFT MINTING (matches solana-seeker mintCompressedNFT)
// ============================================================================

/**
 * Mint a compressed NFT (cNFT) using the server keypair
 * The server wallet pays for the transaction and is set as tree delegate.
 * The NFT is owned by the specified recipient address.
 *
 * @param {Object} params
 * @param {string} params.recipientAddress - Solana address of the NFT owner (user's wallet or server-assigned)
 * @param {string} params.nftName - NFT name (max 32 chars)
 * @param {string} params.metadataUrl - IPFS URL of the metadata JSON
 * @param {string} params.imageUrl - IPFS URL of the image
 * @returns {{ success: boolean, assetId?: string, txSignature?: string, error?: string }}
 */
async function mintCNFT({ recipientAddress, nftName, metadataUrl, imageUrl }) {
  if (!connection || !serverKeypair) {
    const initResult = initialize();
    if (!initResult.success) return initResult;
  }

  console.log('[cNFT] Minting for recipient:', recipientAddress);
  console.log('[cNFT] Name:', nftName, '| Metadata:', metadataUrl);

  try {
    const recipientPubkey = new PublicKey(recipientAddress);
    const serverPubkey = serverKeypair.publicKey;
    const merkleTreePubkey = new PublicKey(MERKLE_TREE);

    const BUBBLEGUM_PROGRAM_ID = new PublicKey(PROGRAM_IDS.BUBBLEGUM);
    const SPL_NOOP_PROGRAM_ID = new PublicKey(PROGRAM_IDS.SPL_NOOP);
    const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(PROGRAM_IDS.SPL_ACCOUNT_COMPRESSION);

    // Derive tree config PDA
    const [treeConfig] = PublicKey.findProgramAddressSync(
      [merkleTreePubkey.toBuffer()],
      BUBBLEGUM_PROGRAM_ID
    );

    // Build metadata for the cNFT
    const metadataArgs = {
      name: nftName.slice(0, 32),
      symbol: 'PLNK',
      uri: metadataUrl,
      sellerFeeBasisPoints: 500, // 5%
      primarySaleHappened: false,
      isMutable: true,
      editionNonce: null,
      tokenStandard: null,
      collection: null,
      uses: null,
      tokenProgramVersion: 0,
      creators: [{ address: recipientPubkey, verified: false, share: 100 }],
    };

    const metadataBuffer = serializeMetadataArgs(metadataArgs);

    // Bubblegum mintV1 discriminator
    const MINT_V1_DISCRIMINATOR = Buffer.from([145, 98, 192, 118, 184, 147, 118, 104]);
    const instructionData = Buffer.concat([MINT_V1_DISCRIMINATOR, metadataBuffer]);

    const mintV1Instruction = new TransactionInstruction({
      keys: [
        { pubkey: treeConfig, isSigner: false, isWritable: true },
        { pubkey: recipientPubkey, isSigner: false, isWritable: false },   // leafOwner
        { pubkey: recipientPubkey, isSigner: false, isWritable: false },   // leafDelegate
        { pubkey: merkleTreePubkey, isSigner: false, isWritable: true },
        { pubkey: serverPubkey, isSigner: true, isWritable: true },        // payer (server)
        { pubkey: serverPubkey, isSigner: true, isWritable: false },       // treeCreatorOrDelegate (server)
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: BUBBLEGUM_PROGRAM_ID,
      data: instructionData,
    });

    // Build instructions: priority fee + mint + commission transfer
    const instructions = [];

    // Add priority fee
    const medianMicroLamports = await getMedianPriorityFee();
    if (medianMicroLamports > 0) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: medianMicroLamports })
      );
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 })
      );
    }

    instructions.push(mintV1Instruction);

    // Commission transfer (server → commission wallet)
    const solPrice = await fetchSolPrice();
    const fees = getCurrentFees();
    const commissionUsd = fees.APP_COMMISSION_CNFT_IPFS_USD;
    const commissionLamports = Math.ceil((commissionUsd / solPrice) * LAMPORTS_PER_SOL);

    if (serverPubkey.toBase58() !== COMMISSION_WALLET) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: serverPubkey,
          toPubkey: new PublicKey(COMMISSION_WALLET),
          lamports: commissionLamports,
        })
      );
    }

    // Build and sign transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: serverPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([serverKeypair]);

    // Send and confirm
    console.log('[cNFT] Sending transaction...');
    const txSignature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log('[cNFT] Transaction sent:', txSignature);

    // Confirm with timeout
    const confirmation = await connection.confirmTransaction(
      { signature: txSignature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    if (confirmation.value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('[cNFT] Transaction confirmed:', txSignature);

    // Asset ID placeholder (can be resolved via DAS API later)
    const assetId = `cnft_${txSignature.slice(0, 16)}`;

    return {
      success: true,
      assetId,
      txSignature,
      isCompressed: true,
      merkleTree: MERKLE_TREE,
      commissionUsd,
    };
  } catch (e) {
    console.error('[cNFT] Minting failed:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = {
  initialize,
  getServerBalance,
  fetchSolPrice,
  estimateMintCost,
  mintCNFT,
};
