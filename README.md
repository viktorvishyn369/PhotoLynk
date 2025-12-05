# PhotoSync - Self-Hosted Photo Backup

Secure, private photo backup system. Your photos, your server, your control.

---

## 🚀 Quick Start

### 1️⃣ Install Server (Choose Your Platform)

**First, open Terminal/Command Prompt:**

- **Mac:** Press `Cmd + Space`, type "Terminal", press Enter
- **Windows:** Press `Win + R`, type "powershell", press Enter
- **Linux:** Press `Ctrl + Alt + T`

**Then, copy & paste one of these commands:**

#### Desktop (macOS, Windows, Linux) - With GUI Tray
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.sh | bash

# Windows (PowerShell as Admin)
irm https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.ps1 | iex
```

**Tip:** Right-click in Terminal/PowerShell to paste, then press Enter!

#### Linux Server (Headless) - No GUI
```bash
curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install-server.sh | bash
```

### 2️⃣ Install Mobile App
- Download from **Google Play Store**
- Or **App Store** (iOS)
- Also available on **Solana dApp Store**

### 3️⃣ Connect & Backup
- Open PhotoSync app
- Enter server URL: `http://YOUR_SERVER_IP:3000`
- Register and start backing up!

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
1. **Auto-detected:** The app automatically detects your local server at `192.168.1.222:3000`
2. If auto-detection doesn't work, find your server's local IP manually:
   - **Mac/Linux:** `ifconfig | grep "inet " | grep -v 127.0.0.1`
   - **Windows:** `ipconfig` (look for IPv4 Address)
3. Use this IP in app: `http://192.168.1.XXX:3000`
4. ❌ **Don't use:** `localhost` or `127.0.0.1` (won't work from phone!)
5. ✅ **Use:** Your actual local IP like `192.168.1.100`
6. Ensure phone and server on **same WiFi network**

**For Remote Server (internet/VPS):**
1. Use your public IP or domain: `http://YOUR_PUBLIC_IP:3000`
2. Make sure port 3000 is open in firewall
3. If using domain: `http://yourdomain.com:3000`

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
