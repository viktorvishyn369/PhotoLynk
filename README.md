# PhotoLynk — Self‑Hosted. Encrypted Cloud. iOS ↔ Android.

Back up photos/videos to your own server or StealthCloud, and restore on any phone with the same credentials.

---

## Quick Start

### Option A: Local Backup (Home Wi‑Fi / LAN)

1. Download the **PhotoLynk Server** app for your platform from **GitHub Releases**:
   - https://github.com/viktorvishyn369/PhotoLynk/releases

2. Install it and run it.
   - It runs in your system tray / menu bar.

3. Open the tray dropdown menu → **Local Server** → **Pair Mobile Device (QR)** to show a QR code with your IP.

4. On your phone, open the PhotoLynk mobile app:
   - Select **Local** connection
   - Scan the QR code, or manually enter the IP (IP only — no http(s)://, no port):
     - Example: `192.168.1.222`

Done. Start backing up your photos/videos.

### Option B: Remote Backup (VPS / Internet)

Remote works like Local mode, but your server runs on a remote machine (VPS/home server) and the app connects over HTTPS.

1. Install and run PhotoLynk Server on your remote machine.
2. Configure HTTPS (TLS) on the server (recommended: domain + reverse proxy such as Nginx/Certbot/Cloudflare).
3. Ensure the server is reachable from the internet over HTTPS.
4. In the mobile app Settings:
   - Select **Remote** connection
   - Enter your server host (domain only — no http(s)://, no port, no path)
     - Example: `remote.example.com`

Note: the mobile app automatically uses HTTPS for Remote domains. Ensure your domain is pointed to the server and has a valid certificate.

### Option C: StealthCloud Backup

If you choose **StealthCloud**, you do not need to download/install the server app.

1. Install the PhotoLynk mobile app.
2. Select **StealthCloud** inside the app.
3. Start backing up.

---

## Optional Install (Scripts / From Source)

If you prefer installing from source (advanced), you can use the provided scripts:

- Desktop (macOS/Linux):
  ```bash
  sudo curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoLynk/main/install.sh | bash
  ```
- Windows (PowerShell as Administrator):
  ```powershell
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-RestMethod https://raw.githubusercontent.com/viktorvishyn369/PhotoLynk/main/install.ps1 | Invoke-Expression
  ```
- Linux server (headless):
  ```bash
  sudo curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoLynk/main/install-server.sh | bash
  ```

---

## How it works

### Local backup (LAN)

- You run **PhotoLynk Server** on your computer.
- Your phone connects over your home network to the server (port `3000`).
- Photos/videos are uploaded to the server and stored on disk under your account folder.

### StealthCloud backup

- You only need the **mobile app**.
- Files are encrypted on-device and uploaded as encrypted chunks.
- The cloud stores encrypted data only.

## Backup Speed Modes

PhotoLynk offers two backup speed modes to balance performance and device health:

### Normal Mode (Default)
- **Slower, gentler backup** — processes files with small delays between uploads
- Reduces CPU/battery usage and device heat
- Ideal for large backups running in the background
- Recommended for overnight or extended backup sessions

### Fast Mode
- **Maximum speed** — uploads files as fast as your connection allows
- Higher CPU and battery usage
- May cause device to warm up during extended use
- Best for quick backups when plugged in or on Wi-Fi with time constraints

**Toggle Fast Mode** in the app's Settings screen. The mode affects both manual and automatic backups.

## File Storage

Files are stored in:
```
uploads/
  └── {device-uuid}/
      ├── photo1.jpg
      ├── photo2.jpg
      └── ...
```

Each set of credentials (email + password) maps to a deterministic UUID folder, so storage is isolated per account.

## Server Management

**For Headless Linux Servers** (systemd service):
```bash
# Check status
sudo systemctl status photosync

# Stop server
sudo systemctl stop photosync

# Start server
sudo systemctl start photosync

# Restart server
sudo systemctl restart photosync

# View logs
sudo journalctl -u photosync -f
```

**For Desktop (Tray App):**
- Use the tray icon menu to Start/Stop/Restart
- Or run manually (headless server): `cd server && npm install && npm start`

## Advanced: Manual Installation (any machine)

Prerequisites:

- Node.js 18+ (Node 20 LTS recommended)
- Git
- Build tools for native dependencies (`sqlite3`, `bcrypt`)
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio Build Tools + Python
  - Linux: build-essential / gcc / g++ / make + Python

Clone the repo:

```bash
git clone https://github.com/viktorvishyn369/PhotoLynk.git
cd PhotoLynk
```

Run as a desktop tray app (includes server):

```bash
cd server
npm install

cd ../server-tray
npm install
npm start
```

Run as a headless server:

```bash
cd server
npm install
npm start
```

Optional configuration (environment variables):

- `PORT` (default: `3000`)
- `PHOTOSYNC_DATA_DIR` (sets the base data folder)
- `UPLOAD_DIR`, `DB_PATH`, `CLOUD_DIR` (advanced overrides)
- HTTPS (TLS): `ENABLE_HTTPS=true`, `TLS_KEY_PATH`, `TLS_CERT_PATH`, `HTTPS_PORT`

## Auto-Updates

PhotoLynk automatically checks for updates every 24 hours.

**Check for updates manually:**
```bash
cd ~/PhotoLynk/server
npm run check-update
```

**Install update:**
```bash
cd ~/PhotoLynk/server
npm run update
```

The server will:
1. Create a backup of the current version
2. Download the latest version from GitHub
3. Install dependencies
4. Notify you to restart

**Update notifications:**
- Server logs show when updates are available
- Tray app shows notification (if running)
- No automatic restart - you control when to update

## Security & Privacy

PhotoLynk uses industry-standard security practices similar to those employed by Signal, ProtonMail, Tresorit, and other privacy-focused services.

### Local Backup (LAN)

**Security Model:** Trusted network, authenticated access

| Layer | Protection |
|-------|------------|
| **Authentication** | JWT tokens with bcrypt-hashed passwords (same as Auth0, Firebase Auth) |
| **Device Binding** | Each token is bound to a specific device UUID — requests from other devices are rejected |
| **File Isolation** | Each account's files stored in separate folder (`uploads/{device-uuid}/`) |
| **Rate Limiting** | Brute-force protection on authentication endpoints |

**Files are stored unencrypted** on your own machine — this is intentional for Local mode, as you control the hardware and may want direct access to your photos. This is similar to how Syncthing, Nextcloud, and other self-hosted solutions work.

**Risk Assessment:**
- ✅ Safe on trusted home networks
- ⚠️ On public/untrusted WiFi: traffic could be intercepted (use Remote + HTTPS instead)
- 🔒 Even if intercepted, attacker would need valid JWT + matching device UUID

### Remote Backup (VPS/Internet)

**Security Model:** Authenticated access over encrypted transport (HTTPS/TLS)

| Layer | Protection |
|-------|------------|
| **Transport** | TLS 1.2/1.3 encryption (same as banking, e-commerce) |
| **Authentication** | JWT + device UUID binding |
| **Server Security** | Helmet.js security headers, CORS, rate limiting |

When properly configured with HTTPS:
- **Man-in-the-middle attacks:** Virtually impossible with valid TLS certificate
- **Interception probability:** Near zero — same protection as online banking
- **Brute force:** Rate-limited to 25 attempts per 15 minutes

**Recommended Setup:**
- Use a domain with Let's Encrypt certificate (free, auto-renewing)
- The installer offers Nginx + Certbot setup for easy HTTPS

### StealthCloud Backup (Zero-Knowledge Encryption)

**Security Model:** End-to-end encryption — server cannot read your data

| Layer | Protection |
|-------|------------|
| **Encryption Algorithm** | XSalsa20-Poly1305 via TweetNaCl (same as Signal Protocol, Keybase) |
| **Key Derivation** | Master key derived on-device, never transmitted |
| **Chunk Encryption** | Each 2MB chunk encrypted independently with unique nonce |
| **Manifest Encryption** | File metadata also encrypted — server sees only opaque blobs |
| **Key Storage** | iOS Keychain / Android Keystore (hardware-backed on supported devices) |

**How it compares to industry leaders:**

| Service | Encryption | Zero-Knowledge |
|---------|------------|----------------|
| **StealthCloud** | XSalsa20-Poly1305 | ✅ Yes |
| **Signal** | XSalsa20-Poly1305 | ✅ Yes |
| **ProtonMail** | AES-256 + RSA | ✅ Yes |
| **Tresorit** | AES-256 | ✅ Yes |
| **iCloud** | AES-128 | ❌ Apple holds keys |
| **Google Photos** | AES-256 | ❌ Google holds keys |

**Attack Scenarios & Probability:**

| Attack Vector | Probability | Notes |
|---------------|-------------|-------|
| Server breach | **Data safe** | Attacker gets encrypted blobs only |
| Man-in-the-middle | **Near zero** | TLS + authenticated encryption |
| Brute-force key | **Computationally infeasible** | 256-bit key space = 2^256 combinations |
| Quantum computing | **Safe for decades** | XSalsa20 is symmetric; not vulnerable to Shor's algorithm |

**What a sophisticated attacker would need:**
1. Physical access to your unlocked phone, OR
2. Your account credentials + access to your device's secure storage, OR
3. A breakthrough in cryptography that breaks XSalsa20 (none known)

### Summary

| Mode | Encryption | Who Can Read Your Files |
|------|------------|------------------------|
| **Local** | None (your own machine) | You only |
| **Remote** | TLS in transit | You + your server |
| **StealthCloud** | End-to-end (XSalsa20) | You only (zero-knowledge) |

For maximum privacy, use **StealthCloud**. For full control over your data, use **Local** or **Remote** with your own server.

---

## Clean Duplicates (mobile)

The **Clean Duplicates** feature finds and deletes duplicates by **content hash** (SHA-256), not by filename/date/metadata.

How it works:

- The app scans your photo/video library.
- For each readable asset, it computes a SHA-256 hash.
- Assets with the same hash are treated as duplicates.
- The app **keeps the oldest** item in each duplicate group and deletes the newer ones.

Limitations:

- Clean Duplicates works in the installed app (development builds and production builds). It is not supported in **Expo Go** because it relies on native file hashing.
- On iOS, items that are not available as a local file (for example when iCloud Photos is enabled with “Optimize iPhone Storage”) may be skipped during analysis. For best results, download originals to the device and grant Photos “Full Access”.

Deletion behavior:

- **iOS**: deleted items go to **Photos → Recently Deleted**.
- **Android**: deleted items are removed from the device (behavior depends on OEM/OS).

## Requirements

### Server
- Node.js 18+ (auto-installed by scripts)
- Port 3000 available
- Linux, macOS, or Windows

### Mobile
- **Android:** 5.0+ (API 21+)
- **iOS:** 13.0+
- Network access to server

## Privacy

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md)

- PhotoLynk does not sell your personal data.
- Local mode stores your library on your own machine.
- StealthCloud (if enabled) stores encrypted backup data.

## Important: Password Reset on Android

Password reset on Android is tied to your device's unique identifier. **If you upgrade your Android OS to a major new version or perform a factory reset, the device identifier may change.** In this case:

- Password reset will no longer work for accounts registered before the upgrade
- If you forget your password after an OS upgrade, you may lose access to your backed-up data
- **Always remember your password** or store it securely before upgrading your Android OS

This limitation does not apply to iOS devices.

## Troubleshooting

### Can't connect from mobile app

**For Local Server (same WiFi network):**
1. If you are using the **Desktop Tray app**, open the tray menu → **Local Server** → **Pair Mobile Device (QR)** to show a QR code, or select **Local IP Addresses** to copy an IP.
2. In the mobile app (Local), paste the IP address only (no http(s)://, no port, no domain):
   - Example: `192.168.1.222`
3. If you are not using the tray app (or it shows no IP), find your server IP manually:
   - **macOS:** System Settings → Network → your connection → **IP Address**
   - **Windows:** `ipconfig` → **IPv4 Address**
   - **Linux:** Settings → Network → your connection → **IPv4** (or run `ip a`)
4. Do not use `localhost` or `127.0.0.1` (this will not work from a phone).
5. Ensure the phone and computer are on the same Wi‑Fi network.

**For Remote Server (internet/VPS):**
1. Install PhotoLynk Server on your remote machine (VPS/home server).
2. Enable HTTPS (TLS) for PhotoLynk Server on the remote machine (install a certificate and open the HTTPS port).
3. In the app (Remote), enter the public host only (domain only — no http(s)://, no port, no path):
   - Example: `remote.example.com`

**Common issues:**
- Server not running? Check tray icon or terminal
- Firewall blocking? Allow port 3000
- Wrong network? Connect phone to same WiFi as server

### Port 3000 already in use
```bash
# macOS / Linux
lsof -ti:3000 | xargs kill -9

# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

### Server won't start
- Check Node.js is installed: `node --version`
- Check logs for errors
- Ensure port 3000 is available

## What Gets Installed

### Desktop Install
- PhotoLynk repository → `~/PhotoLynk`
- Server dependencies
- Tray app dependencies
- System tray application

### Linux Server Install
- PhotoLynk repository → `/opt/photolynk`
- Server dependencies
- Systemd service
- Firewall rules

## Updates

```bash
# Desktop
cd ~/PhotoLynk
git pull
cd server-tray
npm install
npm start

# Linux Server
cd /opt/photolynk
sudo git pull
cd server
sudo npm install
sudo systemctl restart photosync
```

## System Info

- **Server Port**: 3000
- **File Storage**: `uploads/{device-uuid}/`
- **Database**: SQLite (`server/backup.db`)
- **Logs**: Console output or systemd journal

## Advanced

### Manual Installation
```bash
git clone https://github.com/viktorvishyn369/PhotoLynk.git
cd PhotoLynk

# For desktop with tray
cd server-tray
npm install
npm start

# For headless server
cd server
npm install
node server.js
```

## License

MIT

## Contributing

Issues and pull requests welcome!

---

**PhotoLynk** - Your photos, your server, your privacy.
