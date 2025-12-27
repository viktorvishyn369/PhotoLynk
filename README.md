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

### Local backup (LAN)

- Your library is stored on your own machine.
- Requests are authenticated (JWT) and stored under an account-specific folder structure.
- This mode is ideal for home networks where your phone can reach your computer directly.

### StealthCloud backup

StealthCloud is designed as an end‑to‑end encrypted backup flow:

- **On-device encryption:** your photos/videos are encrypted on your phone before upload using TweetNaCl `secretbox` (XSalsa20‑Poly1305).
- **Chunked uploads:** files are split into chunks; each chunk is encrypted independently and uploaded.
- **Encrypted manifests:** the cloud stores encrypted chunks plus an encrypted manifest (metadata needed for restore).
- **Keys stay on the device:** encryption keys are generated on the phone and stored in the OS secure storage.

This means StealthCloud stores encrypted data and is designed so that it cannot read your photos/videos.

### Remote access

Remote works like Local mode, but your server runs on a remote machine (VPS/home server) instead of your personal computer.

   - Install PhotoLynk Server on the remote machine (headless is recommended).
   - Enable HTTPS (TLS) on the remote server so traffic is encrypted end-to-end.
   - In the mobile app (Remote), enter the server public host only (domain only — no http(s)://, no port, no path).
   - The app connects using HTTPS for Remote domains.

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
