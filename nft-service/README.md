# PhotoLynk NFT Service

Server-side NFT minting module for **mobile-v2**. Handles the complete cNFT creation flow on Solana so mobile users don't need a Solana wallet — they pay with in-app purchased USD credits instead.

## Architecture

```
mobile-v2 app                    nft-service (server)                 Solana
─────────────                    ────────────────────                 ──────
User buys $10 package ──IAP──►   POST /credit (add balance)
User picks photo + name ──────►  POST /mint
                                   ├─ Check balance
                                   ├─ Deduct USD credit
                                   ├─ Upload image → IPFS (Pinata)
                                   ├─ Build metadata JSON
                                   ├─ Upload metadata → IPFS
                                   ├─ Mint cNFT ──────────────────►  Bubblegum mintV1
                                   │   (server keypair signs+pays)    on shared Merkle tree
                                   ├─ Return result + new balance
                                   └─ Refund on failure
User sees NFT in album ◄────── GET /album (from main server /api/nft/list)
```

## Why server-side minting?

Apple and Google **will not approve** apps that connect to crypto wallets for payments. The workaround:

1. User buys an **NFT credit package** via standard in-app purchase ($5, $10, $20, etc.)
2. Credits are stored as USD balance in the server database
3. When user creates an NFT, the server deducts from their balance and mints using its own Solana wallet
4. The server wallet pays all Solana fees (fractions of a cent for cNFTs)
5. Your commission (configurable) is the spread between what the user pays and the actual Solana cost

## Setup

```bash
cd nft-service
npm install

# Generate server wallet keypair
npm run generate-keypair

# Copy and configure environment
cp .env.example .env
# Edit .env with your Pinata JWT, etc.

# Fund the server wallet with SOL (mainnet)
# The public key is printed by generate-keypair
```

## Integration with main server

```javascript
// In server/server.js
const nftService = require('../nft-service');
nftService.initialize();
app.use('/api/nft-service', authenticateToken, nftService.routes);
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/nft-service/status` | Service health, wallet balance, promo status |
| GET | `/api/nft-service/balance` | User's NFT credit balance |
| POST | `/api/nft-service/credit` | Add credit after in-app purchase |
| POST | `/api/nft-service/estimate` | Estimate minting cost before creating |
| POST | `/api/nft-service/mint` | Upload image + mint cNFT (multipart) |
| GET | `/api/nft-service/history` | User's transaction history |

### POST /api/nft-service/mint (multipart/form-data)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| image | file | yes | JPEG/PNG image to mint |
| name | string | yes | NFT name (max 32 chars) |
| description | string | no | NFT description |
| edition | string | no | `open` (default) or `limited` |
| license | string | no | License ID (default: `arr`) |
| stripExif | string | no | `true` (default) or `false` |
| recipientAddress | string | no | Solana address (default: server wallet / custodial) |

### Response

```json
{
  "success": true,
  "assetId": "cnft_abc123...",
  "mintAddress": "cnft_abc123...",
  "txSignature": "5xYz...",
  "imageUrl": "https://w3s.link/ipfs/...",
  "thumbnailUrl": "https://w3s.link/ipfs/...",
  "metadataUrl": "https://w3s.link/ipfs/...",
  "costUsd": 0.05,
  "balanceUsd": 9.95,
  "ownerAddress": "HttTZk..."
}
```

## Mobile-v2 Integration Flow

1. **Buy credits**: User taps "Buy NFT Package" → IAP → app calls `POST /credit`
2. **Check balance**: App calls `GET /balance` to show current credits
3. **Estimate**: Before minting, app calls `POST /estimate` with file size
4. **Create NFT**: User picks photo, enters name → app calls `POST /mint` with image
5. **Album**: App fetches NFTs from existing `GET /api/nft/list` endpoint
6. **Background sync**: On first load, fetch NFTs + certs and cache on device

## Files

| File | Purpose |
|------|---------|
| `index.js` | Entry point, initialization, exports |
| `config.js` | Configuration, fee structure, constants |
| `solana.js` | Solana connection, cNFT minting, cost estimation |
| `storage.js` | IPFS upload (Pinata primary, NFT.storage fallback) |
| `balance.js` | User credit balance management (SQLite) |
| `mint.js` | Mint orchestrator (coordinates full flow) |
| `routes.js` | Express API routes |
| `scripts/generate-keypair.js` | Generate server wallet keypair |

## Pricing

Matches solana-seeker/nftOperations.js fee structure:

- **Promo** (first 30 days): cNFT + IPFS = $0.05, cNFT + Cloud = $0.02
- **Regular**: cNFT + IPFS = $0.50, cNFT + Cloud = $0.20
- **Limited Edition**: 0.1% of file size in KB, minimum $1

Actual Solana cost for a cNFT is ~$0.0001 (base fee only, no rent). Your profit is the spread.
