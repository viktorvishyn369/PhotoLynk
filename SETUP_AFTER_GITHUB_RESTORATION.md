# Setup Instructions After GitHub Account Restoration

## Current Status

✅ **All code changes committed locally:**
- Commit `11c668a`: Env var support for HELIUS_API_KEY_2 and HELIUS_RPC_KEY
- Commit `eb55a01`: GitHub Secrets injection in build workflow

✅ **Local environment fully functional:**
- All secrets in `.env` files (gitignored)
- Apps work with `dotenv.config()`
- Public repos clean (no secrets)

❌ **Blocked by GitHub account suspension:**
- Cannot push to PhotoLynk-Private repo
- Cannot add GitHub Secrets
- Cannot trigger automated builds

---

## Steps to Complete After Account Restoration

### 1. Push Commits to Private Repo

```bash
cd /Users/vishyn369/Downloads/StealthLynk/NEW/DEMO_APPS/FileSharing

# Push the 2 commits to private repo
git push private main
```

### 2. Add GitHub Secrets to Private Repo

Go to: https://github.com/viktorvishyn369/PhotoLynk-Private/settings/secrets/actions

Click **"New repository secret"** and add each of these:

| Secret Name | Value |
|-------------|-------|
| `HELIUS_API_KEY` | `8b86bd0d-4534-4ce9-a61d-ec3850cb0b62` |
| `HELIUS_API_KEY_2` | `6b3d0180-4354-4e31-a2fc-9b6cd9e550a7` |
| `HELIUS_RPC_KEY` | `15319bf2-6d8c-4e35-a99e-134b3e8b5b2e` |
| `PINATA_JWT` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiJjZWJmYjg0Ni04NTJjLTRmMTQtYjRmMS0zYTk4MjFiZDJiYmIiLCJlbWFpbCI6InZpa3Rvci52aXNoeW4uMzY5QGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaW5fcG9saWN5Ijp7InJlZ2lvbnMiOlt7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6IkZSQTEifSx7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6Ik5ZQzEifV0sInZlcnNpb24iOjF9LCJtZmFfZW5hYmxlZCI6ZmFsc2UsInN0YXR1cyI6IkFDVElWRSJ9LCJhdXRoZW50aWNhdGlvblR5cGUiOiJzY29wZWRLZXkiLCJzY29wZWRLZXlLZXkiOiIyNWI0ODcyZDg1ZDgzODgzMGY5MCIsInNjb3BlZEtleVNlY3JldCI6ImM5Yjc2Zjc3MjIzNTA0YTE2ZDVkNGE5MTE5ZDdiZjEzNzNhNTkxYzc4NTEyMGM4M2I5MmM3ZWFjYWU3OGRjZjAiLCJleHAiOjE3OTk4NzQzNTh9.YMv_l6T4RSh7HGxNaCVf7y-1w_FPKhdaCUBfmMotJpM` |
| `DEBUG_SECRET` | `photolynk2026` |

> **Note:** You also need code signing secrets (CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY_BASE64, APPLE_API_KEY_ID, APPLE_API_ISSUER) if you want signed macOS builds.

### 3. Test Automated Build

Push a version tag to trigger the build workflow:

```bash
cd /Users/vishyn369/Downloads/StealthLynk/NEW/DEMO_APPS/FileSharing

# Create and push a test tag
git tag v2.0.1
git push private v2.0.1
```

This will trigger the GitHub Actions workflow which will:
1. Build macOS (x64 + ARM64), Windows, and Linux apps
2. Inject secrets from GitHub Secrets as environment variables
3. Create a GitHub Release with all platform builds attached

### 4. Verify Build Success

Go to: https://github.com/viktorvishyn369/PhotoLynk-Private/actions

Check that the workflow runs successfully and creates a release at:
https://github.com/viktorvishyn369/PhotoLynk-Private/releases

---

## How It Works

**Public Repos (PhotoLynk, PhotoLynk-Solana):**
- Code references `process.env.HELIUS_API_KEY`, etc.
- No actual secret values in source code
- `.env` files gitignored
- Anyone can clone and run with their own API keys

**Private Repo (PhotoLynk-Private):**
- Same code with env var references
- GitHub Secrets store the actual API keys
- Workflow injects secrets at build time
- Built apps have secrets baked in
- Only you can access the secrets

**Local Development:**
- `.env` files in `server/` and `server-tray/`
- `dotenv.config()` loads them at runtime
- Apps work exactly like production builds

---

## Contact GitHub Support

**To restore your account:**
1. Visit: https://support.github.com/contact
2. Select: "Account and profile" → "Account suspension"
3. Explain the situation and request details about the violation
4. Wait for GitHub's response (usually 1-2 business days)

Once restored, follow the steps above to complete the setup.
