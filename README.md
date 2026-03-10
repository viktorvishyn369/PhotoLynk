# PhotoLynk — Self‑Hosted. Encrypted Cloud. iOS ↔ Android ↔ Desktop.

**A project by <a href="https://stealthlynk.io" target="_blank">StealthLynk LLC</a>** — Building secure, privacy-respecting infrastructure for real-world digital systems.

Back up photos/videos to your own server or StealthCloud, and restore on any phone with the same credentials.

> 🎥 **[Watch the 60-Second Demo Video on YouTube](https://youtube.com/shorts/pp3TYwn68D0)**  
> 📄 **[Read the Technical Pitch Deck](PITCH_DECK.md)**

> ⚠️ **Security Notice**: The `PhotoBackupSystem` folder (mobile apps) has been moved to a private repository for security. Install scripts automatically pull it during server setup. [Read more](PHOTOBACKUP_REMOVAL_NOTICE.md)

---

## 📱 Mobile Apps

| Platform | Status | Payment Method |
|----------|--------|----------------|
| **iOS** | ✅ Live on App Store | In-App Purchase |
| **Android** | ✅ Live on Google Play | In-App Purchase |
| **Wallet-enabled Android variant** | ✅ Available in ecosystem distribution | On-chain wallet payment flow |

The PhotoLynk mobile apps feature end-to-end encryption, self-hosted or cloud backup options, and seamless cross-platform restore.

**iOS, Android, and the wallet-enabled Android variant are live.**

Store links:
- iOS (App Store): [Download PhotoLynk](https://apps.apple.com/app/id6748285696)
- Android (Google Play): [Download PhotoLynk](https://play.google.com/store/apps/details?id=com.photosync.app)
- Wallet-enabled Android variant: available in its ecosystem distribution channel

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

Remote works like Local mode, but your server runs on a remote machine (VPS) and the app connects over HTTPS.

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

### Slow Mode (Default)
- **Slower, gentler backup** — processes files with small delays between uploads
- Reduces CPU/battery usage and device heat
- Ideal for large backups
- Recommended for overnight or extended backup sessions

### Fast Mode
- **Maximum speed** — uploads files as fast as your connection or StealthCloud server load allows
- Higher CPU and battery usage
- May cause device to warm up during extended use
- Best for quick backups when plugged in or on Wi-Fi with time constraints

**Toggle Fast Mode** in the app's Settings screen. The mode affects Backups and Syncs.

## File Storage

Files are stored in:
```
uploads/
  └── {device-uuid}/
      ├── photo1.jpg
      ├── photo2.jpg
      └── ...
```

Each set of credentials (email + password) maps to a deterministic UUID folder, so storage is isolated per account. Extra device bond is created.

## Server Management

**For Headless Linux Servers** (systemd service):
```bash
# Check status
sudo systemctl status photolynk

# Stop server
sudo systemctl stop photolynk

# Start server
sudo systemctl start photolynk

# Restart server
sudo systemctl restart photolynk

# View logs
sudo journalctl -u photolynk -f
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

Create a `.env` file in `server/` and/or `server-tray/` with any of the following:

- `PORT` (default: `3000`)
- `PHOTOLYNK_DATA_DIR` (sets the base data folder)
- `UPLOAD_DIR`, `DB_PATH`, `CLOUD_DIR` (advanced overrides)
- HTTPS (TLS): `ENABLE_HTTPS=true`, `TLS_KEY_PATH`, `TLS_CERT_PATH`, `HTTPS_PORT`
- `PINATA_JWT` (IPFS uploads — get free key at [pinata.cloud](https://pinata.cloud))
- `DEBUG_SECRET` (admin debug endpoint secret)

> **Note:** `.env` files are gitignored and never included in the repository. You must create your own with your own API keys.

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

### Security Audit

We provide a transparent security audit for StealthCloud backup mode. You can:

1. **Read the audit report:** [`security/SECURITY_AUDIT_REPORT.md`](security/SECURITY_AUDIT_REPORT.md)
2. **Review the audit script:** [`security/security-audit.sh`](security/security-audit.sh)
3. **Run the audit yourself:**
   ```bash
   cd security && ./security-audit.sh
   ```

The audit script dynamically analyzes the codebase and generates a report based on actual code findings. It verifies:
- Encryption algorithms and key derivation
- Secure token storage (iOS Keychain / Android Keystore)
- Device binding and authentication
- Vulnerability scanning (eval, XSS, password logging, etc.)
- OWASP Mobile Top 10 compliance

> **Note:** The security audit applies only to **StealthCloud** mode. For Local/Remote modes, security depends on your own server configuration.

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
- **Android**: deleted items go to **Photos → Trash** or are removed from the device (behavior depends on OEM/OS).

## Requirements

### Desktop App (Server Tray)
- **macOS:** 10.15 (Catalina) or later
- **Windows:** Windows 10 version 1809 (October 2018 Update) or later, Windows 11
- **Linux:** Ubuntu 18.04+, Debian 10+, or equivalent (x64)

### Server (Headless)
- Node.js 18+ (Node 20 LTS recommended)
- Port 3000 available
- Linux, macOS, or Windows

### Mobile
- **Android:** 10+ (API 29+) — HEIC/HEIF support requires Android 10+
- **iOS:** 15.0+
- Network access to server

### Supported File Formats

PhotoLynk handles file formats in three distinct ways:

- **Backup, sync, and restore** store the original file bytes and return the same bytes on restore.
- **Metadata preservation** depends on whether the platform can read or write EXIF for that format.
- **Certify Original** supports a narrower set of image formats that the certification pipeline can hash and package consistently.

This section reflects the formats actually handled by the current server, desktop, and certification code paths.

#### 1. Backup, Sync & Restore

For backup and StealthCloud sync, PhotoLynk preserves the original file bytes. No re-encoding or quality reduction is required for normal backup/restore flows.

**Images explicitly handled by current upload and metadata paths:**

- **Standard images:** JPEG/JPG, PNG, GIF, BMP, WebP, TIFF/TIF, AVIF
- **Apple formats:** HEIC, HEIF
- **Camera RAW formats:** RAW, CR2, CR3, NEF, ARW, DNG, ORF, RW2, PEF, SRW, RAF
- **Additional image-like formats seen in upload handling:** PSD, PSB, EXR, HDR

**Videos documented for backup/restore:**

- MP4, MOV, M4V, 3GP, AVI, MKV, WebM
- MPEG, MPG, WMV, FLV, TS, MTS, M2TS

#### 2. Metadata Preservation

When metadata is available, PhotoLynk stores a structured metadata record that can include:

- **EXIF:** camera settings, orientation, dimensions, timestamps
- **GPS:** latitude, longitude, altitude, GPS timestamp
- **IPTC:** caption, copyright, keywords, creator, title, city, country, credit, source
- **XMP:** rating, label, subject, creator tool, rights, description, raw XML
- **ICC:** profile name
- **MakerNote:** SHA-256 hash of proprietary maker data

**Formats with active EXIF extraction in current code:**

- JPEG/JPG
- PNG
- GIF
- BMP
- WebP
- TIFF/TIF
- HEIC/HEIF
- AVIF
- RAW, CR2, CR3, NEF, ARW, DNG, ORF, RW2, PEF, SRW, RAF

EXIF extraction is format-dependent:

- The server backfill path relies mainly on `sharp`, so some formats may remain stored byte-exact without a server-side EXIF sidecar.
- The desktop backup and certification paths use `ExifReader` for HEIC/HEIF and major RAW camera formats where `sharp` cannot read EXIF reliably.

#### 3. Metadata Write-Back on Sync/Restore

PhotoLynk restores the original file bytes first. Metadata write-back is a second step used only when the restored file is missing embedded metadata and the platform has a writer for that target format.

- Android uses native `androidx.exifinterface:exifinterface:1.3.7`
- iOS uses native ImageIO (`CGImageSource` / `CGImageDestination`) plus native save-to-library paths
- Desktop uses bundled `exiftool-vendored` first, with `sharp` only as a narrower fallback when `exiftool` is unavailable

PhotoLynk also avoids unnecessary rewrites:

- If the restored file already contains metadata, the app skips write-back
- If the platform can save the original file bytes directly to the photo library, the original container is preserved even when no rewrite is needed
- On iOS specifically, restore uses native save paths because the generic media-library save path can re-encode JPEGs and strip metadata

Because there are two different concerns, the practical behavior is:

- **Byte-preserving restore:** whether the original file/container can be restored and saved back without conversion
- **Explicit metadata rewrite:** whether PhotoLynk has an implemented writer that can inject metadata back into that format when needed

| Format | Android explicit metadata rewrite | iOS explicit metadata rewrite | Desktop explicit metadata rewrite |
|--------|:--------------------------------:|:-----------------------------:|:---------------------------------:|
| JPEG/JPG | ✅ | ✅ | ✅ |
| PNG | ✅ | ✅ | ✅ |
| WebP | ✅ | ✅ | ✅ |
| HEIC/HEIF | ⚠️ | ✅ | ✅ |
| TIFF/TIF | ⚠️ | ✅ | ✅ |
| GIF | ⚠️ | ✅ | ✅ |
| BMP | ⚠️ | ⚠️ | ✅ |
| AVIF | ⚠️ | ⚠️ | ✅ |
| PSD/PSB | ❌ | ❌ | ✅ |
| EXR/HDR | ❌ | ❌ | ✅ |
| RAW formats (`.raw`, `.cr2`, `.cr3`, `.nef`, `.arw`, `.dng`, `.orf`, `.rw2`, `.pef`, `.srw`, `.raf`) | ⚠️ | ⚠️ | ✅ |

- ✅ = implemented writer path exists in current code for that platform/format family
- ⚠️ = depends on what the native platform metadata APIs can successfully open and finalize for that specific container; original-file restore may still work even if rewrite is not guaranteed
- ❌ = no implemented metadata writer in the current restore path

What the restore writers actually write also differs by platform:

- **Desktop**
  - Writes the broadest metadata set
  - Uses `exiftool-vendored` to write core EXIF, GPS, lens fields, IPTC, and structured XMP
  - Covers JPEG, PNG, WebP, HEIC/HEIF, TIFF/TIF, GIF, BMP, AVIF, PSD/PSB, EXR/HDR, and major RAW camera formats in the current restore code
  - Falls back to `sharp` only for JPEG/TIFF if `exiftool` is unavailable, and that fallback re-encodes pixels

- **iOS**
  - `writeExif` writes broad EXIF, GPS, TIFF, and IPTC fields through ImageIO
  - Current iOS write path includes IPTC caption, copyright, keywords, creator, title, city, country, credit, and source
  - Current iOS write path does **not** implement XMP field write-back in the native module
  - `saveFileToLibrary` preserves original file bytes for normal file restore
  - `saveRawToLibrary` preserves RAW/DNG originals by storing the original RAW as an alternate photo resource with a generated JPEG preview for Photos

- **Android**
  - `writeExif` uses `ExifInterface` and writes core EXIF/GPS fields plus IPTC-equivalent mappings through EXIF tags
  - Current Android write path includes capture time, timezone/subsecond fields, make/model, exposure settings, focal length, orientation, GPS, software, lens make/model, plus caption/copyright/creator through `ImageDescription`, `Copyright`, and `Artist`
  - Current Android write path does **not** implement full IPTC block write-back or XMP write-back
  - Container support is narrower and more platform-dependent than desktop because it is limited by `ExifInterface`

Important RAW caveat:

- **Desktop:** implemented RAW metadata write-back is broad because restore uses bundled `exiftool`
- **iOS:** RAW originals are preserved in the library, but the current code should be understood as **RAW-preserving restore**, not a blanket guarantee of native metadata rewrite for every RAW container
- **Android:** RAW rewrite remains conditional on what `ExifInterface` can successfully open and save for the specific file

#### 4. Certify Original

Certify Original supports a narrower image set than general backup. The current certification pipeline explicitly handles:

- JPEG/JPG
- PNG
- GIF
- WebP
- HEIC
- HEIF
- AVIF
- TIFF/TIF
- DNG
- CR2
- CR3
- NEF
- ARW
- RAF
- ORF
- RW2
- PEF
- SRW
- Encrypted `.bin` payloads

Certificate storage options: **StealthCloud**, **IPFS** (Pinata), **Arweave**, **Embedded SVG**.

#### 5. Certification Security Model

When certifying a supported image, PhotoLynk records integrity proofs from the original file before later processing steps such as stripping, watermarking, or encryption.

| Proof | Description | Purpose |
|------|-------------|---------|
| **Content Hash** | SHA-256 of original file bytes | Proves byte-exact file identity |
| **Raw EXIF Hash** | SHA-256 of raw EXIF bytes when EXIF exists | Preserves the camera-written EXIF payload |
| **Normalized EXIF Hash** | SHA-256 of normalized EXIF fields | Enables stable cross-platform verification |
| **Binding Hash** | SHA-256 of the raw and normalized EXIF hashes together | Binds both EXIF proofs into one record |

Additional certificate fields can include:

- **Camera Serial Hash**
- **RFC 3161 timestamp**
- **C2PA manifest/provenance data**

If a file has no EXIF data, the EXIF-based proof fields are omitted or shown as unavailable. The content hash certificate is still valid.

#### 6. Security Summary by Storage Mode

| Mode | How files are stored | Who can read them |
|------|----------------------|-------------------|
| **Local** | Original files on your own machine | You and anyone with access to that machine |
| **Remote** | Original files on your server, protected by HTTPS and authentication | You and your server |
| **StealthCloud** | Encrypted chunks and encrypted manifests | Only you, with your keys |

## In-App Purchases

PhotoLynk offers two optional in-app purchases to unlock additional features:

### Photo Verification Credit — $15.00 USD (Consumable)
- Adds $15.00 credit to your account balance
- Credit is used to pay for photo certification services (Certify Original), which create tamper-evident digital proofs of your photographs
- Each certification cost varies based on file size and storage method
- Unused credit does not expire and carries forward across sessions
- Multiple purchases are cumulative — each adds to your total balance

### Premium — $49.99 USD (Non-Consumable, One-Time)
- Unlocks 100 GB of end-to-end encrypted cloud storage for 4 years
- Includes 25 free photo certifications and 250 commission-free certifications
- Full access across all platforms and devices linked to your account
- One-time payment — no recurring charges, no auto-renewal

All purchases are processed through the respective platform's payment system (Apple App Store or Google Play Store). Listed prices are base prices; Apple or Google may automatically add applicable taxes, fees, or regional price adjustments at checkout for one-time purchases and subscriptions. PhotoLynk does not directly handle payment card information. Both purchases are final and non-refundable except as required by applicable law.

### Build Requirements (for building from source)
- Node.js 20 LTS
- Python 3.x
- Build tools for native dependencies (`sqlite3`, `bcrypt`, `sharp`):
  - **macOS:** Xcode Command Line Tools
  - **Windows:** Visual Studio Build Tools + Python (install via `npm install -g windows-build-tools`)
  - **Linux:** build-essential, gcc, g++, make, Python

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
sudo systemctl restart photolynk
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

**CC BY-NC-ND 4.0** (Creative Commons Attribution-NonCommercial-NoDerivatives)

- ✅ View and study source code
- ✅ Share repository link
- ❌ No commercial use without written permission
- ❌ No building/distributing applications without written permission
- ❌ No modified versions

**Commercial use requires written permission**: support@photolynk.io

See [LICENSE](LICENSE) for full terms.

## Legal

- [Privacy Policy](https://viktorvishyn369.github.io/PhotoLynk/privacy-policy.html)
- [Terms of Service](https://viktorvishyn369.github.io/PhotoLynk/terms.html)
- [Copyright](https://viktorvishyn369.github.io/PhotoLynk/copyright.html)

## Contributing

Bug reports and feature suggestions are welcome via GitHub Issues.

This project is licensed under CC BY-NC-ND 4.0. Pull requests may be accepted at the maintainer's discretion, but you may not distribute modified versions independently. See [LICENSE](LICENSE).

---

**PhotoLynk** - Your photos, your server, your privacy.
