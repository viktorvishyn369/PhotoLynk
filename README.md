# PhotoSync - Self-Hosted Photo Backup

Secure, private photo backup system. Your photos, your server, your control.

---

## 🚀 Quick Start

### 1️⃣ Install Server (Choose Your Platform)

#### Desktop (macOS, Windows, Linux) - With GUI Tray
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.sh | bash

# Windows (PowerShell as Admin)
irm https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.ps1 | iex
```

#### Linux Server (Headless) - No GUI
```bash
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install-server.sh | bash
```

### 2️⃣ Install Mobile App
- Download APK from [Releases](https://github.com/viktorvishyn369/PhotoSync/releases)
- Install on Android device

### 3️⃣ Connect & Backup
- Open PhotoSync app
- Enter server URL: `http://YOUR_SERVER_IP:3000`
- Register and start backing up!

---

## 📱 Mobile App (Android)

Download APK from [Releases](https://github.com/viktorvishyn369/PhotoSync/releases)

**Features:**
- Automatic photo backup
- Restore to any device
- Device-bound security (UUID-based)
- Works offline after setup
- No cloud dependencies

## 💻 Server Apps

### Desktop (macOS, Windows, Linux)
System tray app with GUI controls.

**One-line install:**
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.sh | bash

# Windows (PowerShell as Admin)
irm https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.ps1 | iex
```

**Features:**
- System tray icon
- Start/Stop/Restart server
- Open files location
- Auto-starts on boot

### Linux Server (Headless)
For Ubuntu Server, VPS, cloud instances.

**One-line install:**
```bash
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install-server.sh | bash
```

**Features:**
- Systemd service (auto-start)
- Firewall configuration
- No GUI required
- Service management commands

---

## 📂 File Storage

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

### Desktop (Tray App)
- Click tray icon
- Use menu to control server

### Linux Server
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

## 🔒 Security

- **Device UUID binding**: Each device has unique UUID based on email + password + hardware ID
- **JWT authentication**: Tokens bound to device UUID
- **Path validation**: Prevents directory traversal
- **Isolated storage**: Each device has separate folder
- **No cloud**: Everything runs locally on your network

## 🌍 Requirements

### Server
- Node.js 16+ (auto-installed by scripts)
- Port 3000 available
- Linux, macOS, or Windows

### Mobile
- Android 5.0+ (API 21+)
- Network access to server

## 📝 Privacy

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md)

- No data collection
- No external services
- No cloud storage
- Everything stays on your network

## 🆘 Troubleshooting

### Can't connect from mobile app
- Check server is running
- Verify firewall allows port 3000
- Use correct local IP (not localhost)
- Ensure mobile and server on same network

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

### Build Desktop Apps
```bash
cd server-tray
npm install
npm run build-mac    # macOS
npm run build-win    # Windows
npm run build-linux  # Linux
```

## 📄 License

MIT

## 🤝 Contributing

Issues and pull requests welcome!

---

**PhotoSync** - Your photos, your server, your privacy. 🔒📱💻
