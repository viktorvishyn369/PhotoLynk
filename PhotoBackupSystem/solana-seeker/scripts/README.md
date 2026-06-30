# PhotoLynk Solana Scripts

## create-merkle-tree.js

Creates a shared Merkle tree on Solana mainnet for compressed NFTs (cNFTs).

### Prerequisites

1. Node.js 18+
2. A Solana wallet with **~0.3-0.5 SOL**
3. Your wallet's private key in base58 format

### Installation

```bash
cd scripts
npm install @solana/web3.js bs58
```

### Usage

**Option 1: Pass private key as argument**
```bash
node create-merkle-tree.js YOUR_PRIVATE_KEY_BASE58
```

**Option 2: Use environment variable**
```bash
export SOLANA_PRIVATE_KEY=YOUR_PRIVATE_KEY_BASE58
node create-merkle-tree.js
```

### Getting Your Private Key

**From Phantom:**
1. Open Phantom wallet
2. Settings → Security & Privacy → Export Private Key
3. Enter password
4. Copy the base58 string

**From Solana CLI:**
```bash
cat ~/.config/solana/id.json | python3 -c "import json,sys,base58; print(base58.b58encode(bytes(json.load(sys.stdin))).decode())"
```

### Output

The script will output:
- Merkle tree address
- Transaction signature
- Solscan links

**Copy the address and update `nftOperations.js`:**

```javascript
export const PHOTOLYNK_MERKLE_TREE = 'YOUR_NEW_TREE_ADDRESS';
```

### Tree Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| Max Depth | 20 | Supports 1,048,576 NFTs |
| Buffer Size | 64 | Concurrent operations |
| Canopy Depth | 14 | Proof caching |
| Public | true | Anyone can mint |

### Cost

- **One-time cost**: ~0.2-0.4 SOL (~$30-60 at $150/SOL)
- **Per-mint cost**: ~0.000005 SOL (~$0.001)

### Security

⚠️ **IMPORTANT**: 
- Never share your private key
- The script only uses it locally to sign the transaction
- Consider using a dedicated wallet for this operation
- The tree creator wallet becomes the tree authority
