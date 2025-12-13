# PhotoSync - Self-Hosted Photo Backup

Secure, private photo backup system. Your photos, your server, your control.

---

## 🚀 Quick Start

### 1️⃣ Install Server (Choose Your Platform)

**First, open a terminal:**

- **Mac:** Press `Cmd + Space`, type "Terminal", press Enter
- **Windows:** Press `Win + R`, type "powershell", press Enter
- **Linux:** Press `Ctrl + Alt + T`

Then follow the section for your platform. **Install the prerequisites via the links first** (opens in browser), then run the script so it can finish in one pass.

#### Desktop (macOS / Linux) - With GUI Tray

**Install these first:**
- [Node.js v18.20.8 for macOS Intel](https://nodejs.org/dist/v18.20.8/node-v18.20.8.pkg)
- [Node.js v18.20.8 for macOS Apple Silicon](https://nodejs.org/dist/v18.20.8/node-v18.20.8.pkg) *(Apple Silicon users run via Rosetta if prompted)*
- [Node.js v18.20.8 for Linux desktop (x64 tarball)](https://nodejs.org/dist/v18.20.8/node-v18.20.8-linux-x64.tar.xz)
- [Git](https://git-scm.com/downloads)
- **macOS only:** [Homebrew package manager](https://brew.sh/)

After the installers finish, return to Terminal and run:
```bash
sudo curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.sh | bash
```

#### Windows Desktop (PowerShell, x64 only)

**Install these first (open in browser, install, then come back):**
- [Node.js v18.20.8 for Windows x64](https://nodejs.org/dist/v18.20.8/node-v18.20.8-x64.msi) — works on Windows 10 (initial release) and newer. (No Windows ARM build available.)
- [Git for Windows](https://gitforwindows.org/)

Then open **PowerShell as Administrator** and run:
```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-RestMethod https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.ps1 | Invoke-Expression
```

#### Linux Server (Headless, no GUI)

**Install prerequisites first (if your distro doesn’t have them):**
- [Node.js v18.20.8 for Linux desktop (x64 tarball)](https://nodejs.org/dist/v18.20.8/node-v18.20.8-linux-x64.tar.xz)
- [Git for Linux](https://git-scm.com/download/linux)

Then run on the server:
```bash
sudo curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install-server.sh | bash
```

### 2️⃣ Install Mobile App
- Download from **Google Play Store**
- Or **App Store** (iOS)
- Also available on **Solana dApp Store**

### 3️⃣ Connect & Backup
- Open PhotoSync app
- Enter server URL: `http://YOUR_SERVER_IP:3000`
- Register and start backing up!

#### Find your server IP (Desktop Tray app)

If you installed PhotoSync **with the desktop tray app**, it will automatically detect your machine's local IP address(es) and show them in the tray menu.

- **macOS:** Look for the PhotoSync icon in the **menu bar** (top-right). Click it.
- **Windows:** Look for the PhotoSync icon in the **system tray** (bottom-right near the clock). You may need to click the **^** arrow to see hidden tray icons.
- **Linux:** Look for the PhotoSync icon in the **panel tray area** (top/bottom bar depending on your desktop environment).

In the tray menu you will see:

- `Local IP (click to copy)`
- One or more IP addresses (example: `<LAN_IP>`)

Then:

1. Open the tray menu.
2. Click the IP address you want (it copies to clipboard).
3. In the mobile app, paste it as a full URL:
   - `http://<copied-ip>:3000`
   - Example: `http://<LAN_IP>:3000`

If you don't see any IPs listed, make sure:

- You are connected to Wi-Fi/Ethernet (not airplane mode)
- You are not only on VPN (VPN-only interfaces can hide LAN IPs)
- Your phone and computer are on the same Wi‑Fi network

**Fallback: find your IP manually**

- **macOS:** System Settings → Network → select Wi‑Fi/Ethernet → look for **IP Address**
- **Windows:** Settings → Network & Internet → Wi‑Fi/Ethernet → properties → **IPv4 address**
- **Linux:** Settings → Network → select your connection → **IPv4** (or run `ip a`)

Use that IP like: `http://<LAN_IP>:3000`

P.S. **With the same credentials (email + password), your backed up photos/videos can be restored on any phone** (login with the same credentials and run Restore/Sync).

---

##  File Storage

Files are stored in:
```
uploads/
  └── {device-uuid}/
      ├── photo1.jpg
      ├── photo2.jpg
      └── ...
```

Each device gets its own UUID folder for complete isolation.

## 🔧 Server Management

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
- Or run manually: `cd ~/PhotoSync/server && node server.js`

## 🔄 Auto-Updates

PhotoSync automatically checks for updates every 24 hours.

**Check for updates manually:**
```bash
cd ~/PhotoSync/server
npm run check-update
```

**Install update:**
```bash
cd ~/PhotoSync/server
npm run update
```

The server will:
1. ✅ Create backup of current version
2. ✅ Download latest version from GitHub
3. ✅ Install dependencies
4. ✅ Notify you to restart

**Update notifications:**
- Server logs show when updates are available
- Tray app shows notification (if running)
- No automatic restart - you control when to update

## 🔒 Security

- **Device UUID binding**: Each device uses a UUID derived from your login credentials (email + password) and stored locally for reuse.
- **JWT authentication**: Tokens bound to device UUID
- **Path validation**: Prevents directory traversal
- **Isolated storage**: Each device has separate folder
- **No cloud**: Everything runs locally on your network

## 🕶️ StealthCloud (optional)

StealthCloud is PhotoSync's optional cloud mode for people who want:

- Access to backups **from anywhere** (not just your home Wi‑Fi)
- **High availability** infrastructure (targeting 99.99% uptime on fast, secure servers)
- A simple paid plan (target: **$1 / 10GB per month**, subject to change)

### How StealthCloud works (why it’s safe)

StealthCloud is designed as a **zero‑knowledge encrypted backup**:

- Your photos/videos are **encrypted on your phone before upload**.
- The encrypted data is **split into chunks**.
- Only encrypted chunks + encrypted manifests are uploaded.

Because the server never receives the plaintext (and is not supposed to receive the keys), StealthCloud is designed so that **without your credentials it cannot reconstruct your files**. Even if someone captured traffic or obtained stored blobs, they would only get encrypted chunk data.

### Restore on any phone

If you sign in with the **same credentials (email + password)**, your device identity is reproduced deterministically, so you can **restore the same backups on any phone** — anytime, from any location.

### Remote access over HTTPS (recommended)

If you use PhotoSync over the public internet, **do not use plain HTTP**.

Mobile app (Remote Server):

- Enter a **full base URL**.
  - Examples:
    - `https://photosync.example.com` (Cloudflare / reverse proxy)
    - `https://<public-ip>:3443` (native HTTPS)

Two supported HTTPS setups:

1) **Cloudflare Tunnel / Reverse Proxy (recommended)**
   - Keep the PhotoSync server running on HTTP locally (default `:3000`).
   - Put Cloudflare Tunnel or a reverse proxy (Caddy/Nginx) in front to provide HTTPS.
   - Your phone connects to the HTTPS URL (usually port 443).

2) **Native HTTPS in PhotoSync server (advanced)**
   - Enable HTTPS directly in `server/server.js` with environment variables:
     - `ENABLE_HTTPS=true`
     - `HTTPS_PORT=3443` (or `443`)
     - `TLS_KEY_PATH=/path/to/privkey.pem`
     - `TLS_CERT_PATH=/path/to/fullchain.pem`
     - Optional: `FORCE_HTTPS_REDIRECT=true` (redirects HTTP `:3000` to HTTPS)

Brute-force protection (basic rate limiting):

- Auth endpoints are rate limited (in-memory) with env:
  - `AUTH_RATE_LIMIT_WINDOW_MS` (default 15 minutes)
  - `AUTH_RATE_LIMIT_MAX` (default 25)

Important:

- **Set a strong `JWT_SECRET`** for any remote deployment.
- If you run multiple server instances behind a load balancer, the in-memory rate limit is per-instance.

### Device UUID generation (mobile)

The mobile app generates the device UUID as:

```
uuidv5("<email-lower>:<password>")
```

It is persisted in `expo-secure-store` so the same UUID is reused for backup/sync requests after login.

Important notes:

- **Same email + same password = same UUID** (even after reinstall)
- If you **change your password**, the UUID will change
- The server never tells the app to regenerate the UUID. The server only stores what the app sends.

---

## 🧹 Clean Duplicates (mobile)

The **Clean Duplicates** feature finds and deletes duplicates by **content hash** (SHA-256), not by filename/date/metadata.

How it works:

- The app scans your photo/video library.
- For each readable asset, it computes a SHA-256 hash.
- Assets with the same hash are treated as duplicates.
- The app **keeps the oldest** item in each duplicate group and deletes the newer ones.

Limitations:

- In **Expo Go**, native file hashing is not available, so Clean Duplicates requires a **development build**.
- Some iOS assets may not be readable (e.g. iCloud “Optimize Storage” / `ph://` URIs), so they can be skipped.

Deletion behavior:

- **iOS**: deleted items go to **Photos → Recently Deleted**.
- **Android**: deleted items are removed from the device (behavior depends on OEM/OS).

## 🌍 Requirements

### Server
- Node.js 16+ (auto-installed by scripts)
- Port 3000 available
- Linux, macOS, or Windows

### Mobile
- **Android:** 5.0+ (API 21+)
- **iOS:** 13.0+
- Network access to server

## 📝 Privacy

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md)

- No data collection
- No external services
- No cloud storage
- Everything stays on your network

## 🆘 Troubleshooting

### Can't connect from mobile app

**For Local Server (same WiFi network):**
1. If you are using the **Desktop Tray app**, open the tray menu and click the IP under `Local IP (click to copy)` (it copies the IP only).
2. In the mobile app, use it as a full URL:
   - `http://<ip>:3000`
   - Example: `http://<LAN_IP>:3000`
3. If you are not using the tray app (or it shows no IP), find your server IP manually:
   - **macOS:** System Settings → Network → your connection → **IP Address**
   - **Windows:** `ipconfig` → **IPv4 Address**
   - **Linux:** Settings → Network → your connection → **IPv4** (or run `ip a`)
4. ❌ **Don't use:** `localhost` or `127.0.0.1` (won't work from phone!)
5. ✅ Ensure the phone and computer are on the **same Wi‑Fi network**

**For Remote Server (internet/VPS):**
1. Prefer HTTPS via Cloudflare Tunnel / reverse proxy.
2. In the app (Remote Server), enter a full URL like `https://yourdomain.com`
3. If you must use direct server access, use native HTTPS (see “Remote access over HTTPS”).

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

## 📦 What Gets Installed

### Desktop Install
- PhotoSync repository → `~/PhotoSync`
- Server dependencies
- Tray app dependencies
- System tray application

### Linux Server Install
- PhotoSync repository → `/opt/photosync`
- Server dependencies
- Systemd service
- Firewall rules

## 🔄 Updates

```bash
# Desktop
cd ~/PhotoSync
git pull
cd server-tray
npm install
npm start

# Linux Server
cd /opt/photosync
sudo git pull
cd server
sudo npm install
sudo systemctl restart photosync
```

## 📊 System Info

- **Server Port**: 3000
- **File Storage**: `uploads/{device-uuid}/`
- **Database**: SQLite (`server/backup.db`)
- **Logs**: Console output or systemd journal

## ⚙️ Advanced

### Manual Installation
```bash
git clone https://github.com/viktorvishyn369/PhotoSync.git
cd PhotoSync

# For desktop with tray
cd server-tray
npm install
npm start

# For headless server
cd server
npm install
node server.js
```

## 📄 License

MIT

## 🤝 Contributing

Issues and pull requests welcome!

---

**PhotoSync** - Your photos, your server, your privacy. 🔒📱💻
