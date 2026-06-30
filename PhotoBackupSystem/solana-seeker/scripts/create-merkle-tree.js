#!/usr/bin/env node
/**
 * PhotoLynk Merkle Tree Creation Script
 * 
 * This script creates a shared Merkle tree on Solana mainnet for compressed NFTs (cNFTs).
 * Run this ONCE to set up the tree, then update PHOTOLYNK_MERKLE_TREE in nftOperations.js
 * 
 * Prerequisites:
 * 1. Node.js installed
 * 2. A Solana wallet with ~0.5 SOL for tree creation
 * 3. Install dependencies: npm install @solana/web3.js @metaplex-foundation/mpl-bubblegum @metaplex-foundation/umi @metaplex-foundation/umi-bundle-defaults bs58
 * 
 * Usage:
 *   node create-merkle-tree.js <PRIVATE_KEY_BASE58>
 * 
 * Or set environment variable:
 *   SOLANA_PRIVATE_KEY=<your_base58_private_key> node create-merkle-tree.js
 * 
 * The script will output the Merkle tree address to paste into nftOperations.js
 */

const { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
let bs58;
try {
  // bs58 v5+ uses default export differently
  const bs58Module = require('bs58');
  bs58 = bs58Module.default || bs58Module;
} catch (e) {
  console.error('Please install bs58: npm install bs58');
  process.exit(1);
}

// Solana mainnet RPC endpoint
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

// Merkle tree configuration presets
// Choose based on your needs and budget
const TREE_PRESETS = {
  // CHEAPEST - Good for testing or small projects (~0.01 SOL / ~$1.50)
  tiny: {
    maxDepth: 3,            // 2^3 = 8 max NFTs
    maxBufferSize: 8,
    canopyDepth: 0,
    description: '8 NFTs - Testing only',
  },
  // VERY CHEAP - Small community (~0.02 SOL / ~$3)
  small: {
    maxDepth: 14,           // 2^14 = 16,384 max NFTs
    maxBufferSize: 64,
    canopyDepth: 0,
    description: '16K NFTs - Small project',
  },
  // CHEAP - Medium project (~0.05 SOL / ~$7.50)
  medium: {
    maxDepth: 17,           // 2^17 = 131,072 max NFTs
    maxBufferSize: 64,
    canopyDepth: 0,
    description: '131K NFTs - Medium project',
  },
  // STANDARD - Large project (~0.15 SOL / ~$22)
  large: {
    maxDepth: 20,           // 2^20 = 1,048,576 max NFTs
    maxBufferSize: 64,
    canopyDepth: 0,         // No canopy = cheaper
    description: '1M NFTs - Large project',
  },
  // PREMIUM - With canopy for faster proofs (~0.35 SOL / ~$52)
  premium: {
    maxDepth: 20,
    maxBufferSize: 64,
    canopyDepth: 14,        // Canopy reduces RPC calls but costs more
    description: '1M NFTs + fast proofs',
  },
};

// SELECT YOUR PRESET HERE (or pass as 3rd argument)
const DEFAULT_PRESET = 'small';  // Change to: tiny, small, medium, large, premium

const TREE_CONFIG = {
  ...TREE_PRESETS[DEFAULT_PRESET],
  public: true,
};

// Program IDs
const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');

/**
 * Calculate the space required for a Merkle tree account
 */
function getMerkleTreeAccountSize(maxDepth, maxBufferSize, canopyDepth) {
  // Header: 2 bytes
  // Max depth: 4 bytes
  // Max buffer size: 4 bytes
  // Authority: 32 bytes
  // Creation slot: 8 bytes
  // Padding: 6 bytes
  const headerSize = 2 + 4 + 4 + 32 + 8 + 6;
  
  // Changelog buffer
  const changelogSize = maxBufferSize * (32 + 4 + 4 + 4 + 32 * maxDepth);
  
  // Rightmost proof
  const rightmostProofSize = 32 * maxDepth;
  
  // Canopy
  const canopySize = canopyDepth > 0 ? 32 * ((1 << (canopyDepth + 1)) - 2) : 0;
  
  return headerSize + changelogSize + rightmostProofSize + canopySize;
}

/**
 * Derive the tree config PDA
 */
function getTreeConfigPDA(merkleTree) {
  return PublicKey.findProgramAddressSync(
    [merkleTree.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )[0];
}

/**
 * Create the Merkle tree
 */
async function createMerkleTree(privateKeyBase58) {
  console.log('\n🌳 PhotoLynk Merkle Tree Creator\n');
  console.log('='.repeat(50));
  
  // Parse private key
  let payer;
  try {
    // Clean the key - remove any whitespace
    const cleanKey = privateKeyBase58.trim();
    console.log('🔑 Key length:', cleanKey.length, 'characters');
    
    // Try to decode base58
    let privateKeyBytes;
    try {
      privateKeyBytes = bs58.decode(cleanKey);
    } catch (decodeErr) {
      // Fallback: try using Buffer if bs58 fails
      console.log('   Trying alternative decode method...');
      const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let num = BigInt(0);
      for (const char of cleanKey) {
        const idx = base58Chars.indexOf(char);
        if (idx === -1) throw new Error(`Invalid character: ${char}`);
        num = num * BigInt(58) + BigInt(idx);
      }
      const hex = num.toString(16).padStart(128, '0');
      privateKeyBytes = Uint8Array.from(Buffer.from(hex, 'hex'));
    }
    
    console.log('   Decoded bytes:', privateKeyBytes.length);
    payer = Keypair.fromSecretKey(privateKeyBytes);
    console.log('✅ Wallet loaded:', payer.publicKey.toBase58());
  } catch (e) {
    console.error('❌ Invalid private key format:', e.message);
    console.error('   Make sure you copied the full key from Phantom');
    process.exit(1);
  }
  
  // Connect to Solana
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  console.log('✅ Connected to Solana mainnet');
  
  // Check balance
  const balance = await connection.getBalance(payer.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  console.log(`💰 Wallet balance: ${balanceSol.toFixed(4)} SOL`);
  
  if (balanceSol < 0.3) {
    console.error('❌ Insufficient balance. Need at least 0.3 SOL for tree creation.');
    console.log('   Send SOL to:', payer.publicKey.toBase58());
    process.exit(1);
  }
  
  // Calculate tree size and rent
  const treeSize = getMerkleTreeAccountSize(
    TREE_CONFIG.maxDepth, 
    TREE_CONFIG.maxBufferSize, 
    TREE_CONFIG.canopyDepth
  );
  const rentExempt = await connection.getMinimumBalanceForRentExemption(treeSize);
  const rentSol = rentExempt / LAMPORTS_PER_SOL;
  
  console.log('\n📊 Tree Configuration:');
  console.log(`   Max Depth: ${TREE_CONFIG.maxDepth} (supports ${Math.pow(2, TREE_CONFIG.maxDepth).toLocaleString()} NFTs)`);
  console.log(`   Buffer Size: ${TREE_CONFIG.maxBufferSize}`);
  console.log(`   Canopy Depth: ${TREE_CONFIG.canopyDepth}`);
  console.log(`   Account Size: ${(treeSize / 1024).toFixed(2)} KB`);
  console.log(`   Rent Cost: ${rentSol.toFixed(4)} SOL (~$${(rentSol * 150).toFixed(2)} at $150/SOL)`);
  
  // Generate new keypair for the Merkle tree account
  const merkleTreeKeypair = Keypair.generate();
  const merkleTreePubkey = merkleTreeKeypair.publicKey;
  
  console.log('\n🔑 New Merkle Tree Address:', merkleTreePubkey.toBase58());
  
  // Derive tree config PDA
  const treeConfig = getTreeConfigPDA(merkleTreePubkey);
  console.log('📋 Tree Config PDA:', treeConfig.toBase58());
  
  // Build create tree instruction
  console.log('\n⏳ Creating Merkle tree on Solana mainnet...');
  
  try {
    // Step 1: Create the account for the Merkle tree
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: merkleTreePubkey,
      lamports: rentExempt,
      space: treeSize,
      programId: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    });
    
    // Step 2: Initialize the tree with Bubblegum's createTree instruction
    // Instruction discriminator for createTree: [165, 83, 136, 142, 89, 202, 47, 220]
    const createTreeDiscriminator = Buffer.from([165, 83, 136, 142, 89, 202, 47, 220]);
    
    // Serialize arguments
    const maxDepthBuf = Buffer.alloc(4);
    maxDepthBuf.writeUInt32LE(TREE_CONFIG.maxDepth);
    
    const maxBufferSizeBuf = Buffer.alloc(4);
    maxBufferSizeBuf.writeUInt32LE(TREE_CONFIG.maxBufferSize);
    
    // Public tree (Option<bool> = Some(true))
    const publicBuf = Buffer.from([1, 1]); // Some(true)
    
    const createTreeData = Buffer.concat([
      createTreeDiscriminator,
      maxDepthBuf,
      maxBufferSizeBuf,
      publicBuf,
    ]);
    
    const createTreeIx = {
      keys: [
        { pubkey: treeConfig, isSigner: false, isWritable: true },
        { pubkey: merkleTreePubkey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // tree creator
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: BUBBLEGUM_PROGRAM_ID,
      data: createTreeData,
    };
    
    // Build and send transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      blockhash,
      lastValidBlockHeight,
    });
    
    transaction.add(createAccountIx);
    transaction.add(createTreeIx);
    
    // Sign with both payer and merkle tree keypair
    transaction.sign(payer, merkleTreeKeypair);
    
    // Send transaction
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    console.log('📤 Transaction sent:', signature);
    console.log('⏳ Waiting for confirmation...');
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('✅ MERKLE TREE CREATED SUCCESSFULLY!');
    console.log('='.repeat(50));
    console.log('\n📋 Copy this address to nftOperations.js:\n');
    console.log(`export const PHOTOLYNK_MERKLE_TREE = '${merkleTreePubkey.toBase58()}';`);
    console.log('\n🔗 View on Solscan:');
    console.log(`   https://solscan.io/account/${merkleTreePubkey.toBase58()}`);
    console.log('\n🔗 Transaction:');
    console.log(`   https://solscan.io/tx/${signature}`);
    console.log('\n💡 The tree is now ready for PhotoLynk users to mint compressed NFTs!');
    console.log('='.repeat(50) + '\n');
    
    return {
      merkleTree: merkleTreePubkey.toBase58(),
      treeConfig: treeConfig.toBase58(),
      signature,
    };
    
  } catch (e) {
    console.error('\n❌ Failed to create Merkle tree:', e.message);
    if (e.logs) {
      console.error('Transaction logs:', e.logs);
    }
    process.exit(1);
  }
}

// Main
async function main() {
  // Get private key and preset from arguments or environment
  let privateKey = process.argv[2] || process.env.SOLANA_PRIVATE_KEY;
  let preset = process.argv[3] || process.argv[2] || DEFAULT_PRESET;
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
  
  // If first arg is a preset name (no key), show cost estimate
  if (!privateKey || TREE_PRESETS[privateKey]) {
    preset = privateKey || DEFAULT_PRESET;
    
    console.log(`
PhotoLynk Merkle Tree Creator
=============================

💰 COST ESTIMATES (at ~$150/SOL):

  tiny    - ~0.008 SOL  (~$1.20)   - 8 NFTs (testing only)
  small   - ~0.016 SOL  (~$2.40)   - 16K NFTs ⭐ RECOMMENDED
  medium  - ~0.045 SOL  (~$6.75)   - 131K NFTs
  large   - ~0.13 SOL   (~$19.50)  - 1M NFTs
  premium - ~0.35 SOL   (~$52.50)  - 1M NFTs + fast proofs

Usage:
  node create-merkle-tree.js <PRIVATE_KEY> [preset]
  node create-merkle-tree.js --dry-run [preset]   # Show cost without signing

Examples:
  node create-merkle-tree.js 'YOUR_KEY' small
  node create-merkle-tree.js --dry-run small      # Just show cost

Get your private key from Phantom:
  Settings → Security & Privacy → Export Private Key

⚠️  Your key is only used locally to sign the transaction.
`);
    
    // Show specific preset cost
    if (TREE_PRESETS[preset]) {
      const config = TREE_PRESETS[preset];
      const treeSize = getMerkleTreeAccountSize(config.maxDepth, config.maxBufferSize, config.canopyDepth || 0);
      const rentLamports = Math.ceil(treeSize * 6960 / 1000) + 2039280; // Approximate rent
      const rentSol = rentLamports / LAMPORTS_PER_SOL;
      console.log(`📊 ${preset.toUpperCase()} preset details:`);
      console.log(`   Max NFTs: ${Math.pow(2, config.maxDepth).toLocaleString()}`);
      console.log(`   Account size: ${(treeSize / 1024).toFixed(1)} KB`);
      console.log(`   Estimated cost: ~${rentSol.toFixed(4)} SOL (~$${(rentSol * 150).toFixed(2)})`);
      console.log('');
    }
    
    process.exit(0);
  }
  
  // Validate preset
  if (!TREE_PRESETS[preset]) {
    console.error('❌ Invalid preset:', preset);
    console.log('   Available: tiny, small, medium, large, premium');
    process.exit(1);
  }
  
  // Update config with selected preset
  TREE_CONFIG.maxDepth = TREE_PRESETS[preset].maxDepth;
  TREE_CONFIG.maxBufferSize = TREE_PRESETS[preset].maxBufferSize;
  TREE_CONFIG.canopyDepth = TREE_PRESETS[preset].canopyDepth;
  TREE_CONFIG.description = TREE_PRESETS[preset].description;
  
  console.log(`\n📦 Selected preset: ${preset.toUpperCase()} - ${TREE_PRESETS[preset].description}\n`);
  
  await createMerkleTree(privateKey);
}

main().catch(console.error);
