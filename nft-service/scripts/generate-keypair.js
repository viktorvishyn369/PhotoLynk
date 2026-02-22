#!/usr/bin/env node
// Generate a new Solana keypair for the NFT service server wallet
// Usage: node scripts/generate-keypair.js [output-path]
//
// The generated keypair file is a JSON array of 64 bytes (secret key).
// Fund this wallet with SOL to pay for cNFT minting transactions.
// KEEP THIS FILE SECRET — it controls the server wallet.

const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const outputPath = process.argv[2] || path.join(__dirname, '..', 'wallet-keypair.json');

if (fs.existsSync(outputPath)) {
  console.error(`\n⚠️  Keypair already exists at: ${outputPath}`);
  console.error('   Delete it first if you want to generate a new one.\n');
  process.exit(1);
}

const keypair = Keypair.generate();
const secretKeyArray = Array.from(keypair.secretKey);

fs.writeFileSync(outputPath, JSON.stringify(secretKeyArray));

console.log('\n✅ Server wallet keypair generated!\n');
console.log('   File:', outputPath);
console.log('   Public Key:', keypair.publicKey.toBase58());
console.log('\n   ⚠️  IMPORTANT:');
console.log('   1. Fund this wallet with SOL (mainnet) to pay for minting transactions');
console.log('   2. Keep wallet-keypair.json SECRET — never commit to git');
console.log('   3. Back up the keypair file securely\n');
