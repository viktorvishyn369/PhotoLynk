# PhotoBackupSystem Folder Removal Notice

## Security Update

The `PhotoBackupSystem` folder has been **removed from this public repository** for security reasons.

### What Changed

- **PhotoBackupSystem** (mobile-v2, solana-seeker apps) is now hosted in a **private repository**: `viktorvishyn369/PhotoLynk-Mobile`
- Install scripts have been updated to automatically clone PhotoBackupSystem from the private repo during server installation
- Hardcoded GitHub tokens have been removed from all install scripts

### For Server Installations

The install scripts (`install-server-PhotoLynk.sh` and `install-server-PhotoLynk-raspberry-emergency.sh`) will:

1. Clone the public PhotoLynk repository (server, server-tray, nft-service core)
2. Automatically clone PhotoBackupSystem from the private `PhotoLynk-Mobile` repository
3. Prompt for a GitHub Personal Access Token (PAT) if not already configured

### Setting Up GitHub Token

To install PhotoBackupSystem during server setup, you need a GitHub token with `repo` scope:

1. Go to https://github.com/settings/tokens
2. Generate a new token (classic) with `repo` scope
3. Provide the token when prompted during installation, or set it as an environment variable:
   ```bash
   export NFT_GITHUB_TOKEN="your_token_here"
   ```

### Why This Change?

- **Security**: Sensitive mobile app code and configuration should not be publicly accessible
- **Access Control**: Private repository ensures only authorized users can access mobile app source
- **Token Security**: Removed hardcoded tokens that were previously embedded in install scripts

### Repository Structure

```
PhotoLynk (Public)
├── server/              # Main server
├── server-tray/         # Desktop tray app
├── nft-service/         # NFT certification (pulled from private repo)
└── install scripts

PhotoLynk-Mobile (Private)
└── PhotoBackupSystem/
    ├── mobile-v2/       # React Native mobile app
    ├── solana-seeker/   # Solana Saga optimized app
    └── install scripts
```

### Questions?

If you encounter issues during installation, ensure:
- Your GitHub token has `repo` scope for private repositories
- You have access to the `viktorvishyn369/PhotoLynk-Mobile` repository
- The token is correctly set via environment variable or entered when prompted
