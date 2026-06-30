# WalletAdapter Module

Universal wallet connection for Solana payments in PhotoLynk.

## Supported Wallets

| Wallet | iOS | Android | Method |
|--------|-----|---------|--------|
| **Mobile Wallet Adapter** | ❌ | ✅ | MWA Protocol |
| **Phantom** | ✅ | ✅ | Deeplinks |
| **WalletConnect** | ✅ | ✅ | WC v2 Protocol |
| **MetaMask** | ⚠️ | ⚠️ | SDK (EVM only) |

> **Note:** MetaMask doesn't natively support Solana. It connects with EVM address only.

## Installation

### Required Dependencies

```bash
# Already installed (Solana core)
npm install @solana/web3.js

# Already installed (MWA for Android)
npm install @solana-mobile/mobile-wallet-adapter-protocol-web3js

# For Phantom deeplinks
npm install tweetnacl bs58

# For WalletConnect (optional)
npm install @walletconnect/sign-client

# For MetaMask SDK (optional)
npm install @metamask/sdk-react-native
```

### WalletConnect Setup

1. Get a Project ID from [WalletConnect Cloud](https://cloud.walletconnect.com)
2. Add to `.env`:
   ```
   EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id
   ```

### App Scheme Setup

Add to `app.json`:
```json
{
  "expo": {
    "scheme": "photolynk"
  }
}
```

## Usage

### Basic Connection

```javascript
import { 
  initializeWalletAdapter,
  getAvailableWallets,
  connectWallet,
  WALLET_TYPES 
} from './WalletAdapter';

// Initialize on app start
await initializeWalletAdapter();

// Get available wallets
const wallets = await getAvailableWallets();

// Connect to specific wallet
const result = await connectWallet(WALLET_TYPES.PHANTOM);
if (result.success) {
  console.log('Connected:', result.address);
}
```

### Using React Context

```javascript
import { WalletProvider, useWallet } from './WalletAdapter/WalletContext';

// Wrap your app
<WalletProvider>
  <App />
</WalletProvider>

// In components
function PaymentButton() {
  const { isConnected, address, connect, sendTransaction } = useWallet();
  
  if (!isConnected) {
    return <Button onPress={() => connect(WALLET_TYPES.PHANTOM)}>Connect</Button>;
  }
  
  return <Text>Connected: {address}</Text>;
}
```

### Using Wallet Modal

```javascript
import WalletModal from './WalletAdapter/WalletModal';

function App() {
  const [showModal, setShowModal] = useState(false);
  
  return (
    <>
      <Button onPress={() => setShowModal(true)}>Connect Wallet</Button>
      <WalletModal
        visible={showModal}
        onClose={() => setShowModal(false)}
        onConnect={(result) => console.log('Connected:', result)}
      />
    </>
  );
}
```

### Sending Transactions

```javascript
import { signAndSendTransaction } from './WalletAdapter';
import { createTransferTransaction } from './WalletAdapter/utils';

// Create transfer transaction
const { transaction } = await createTransferTransaction(
  fromAddress,
  toAddress,
  0.1 // SOL amount
);

// Sign and send
const result = await signAndSendTransaction(transaction);
if (result.success) {
  console.log('Transaction:', result.signature);
}
```

## Module Structure

```
WalletAdapter/
├── index.js              # Main exports, wallet management
├── WalletContext.js      # React context for state
├── WalletModal.js        # Wallet selection UI
├── utils.js              # Shared utilities
├── README.md             # This file
└── adapters/
    ├── MWAAdapter.js         # Mobile Wallet Adapter (Android)
    ├── PhantomAdapter.js     # Phantom deeplinks (iOS/Android)
    ├── WalletConnectAdapter.js # WalletConnect v2
    └── MetaMaskAdapter.js    # MetaMask SDK
```

## API Reference

### Main Functions

| Function | Description |
|----------|-------------|
| `initializeWalletAdapter()` | Initialize the module |
| `getAvailableWallets()` | Get list of available wallets |
| `connectWallet(type)` | Connect to specific wallet |
| `connectBestWallet()` | Auto-connect to best wallet |
| `disconnectWallet()` | Disconnect current wallet |
| `getConnectionStatus()` | Get current connection status |
| `signAndSendTransaction(tx)` | Sign and send transaction |
| `signMessage(msg)` | Sign a message |
| `getBalance()` | Get SOL balance |

### Wallet Types

```javascript
WALLET_TYPES = {
  MWA: 'mwa',
  PHANTOM: 'phantom',
  WALLETCONNECT: 'walletconnect',
  METAMASK: 'metamask',
}
```

## Future Development

- [ ] Add Solflare direct support
- [ ] Add Backpack wallet support
- [ ] Implement MetaMask Solana Snap
- [ ] Add hardware wallet support (Ledger via WalletConnect)
- [ ] Add multi-wallet management
