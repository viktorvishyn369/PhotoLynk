# PhotoSync Server

> Self-hosted photo backup server for PhotoSync mobile app

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D16.0.0-green)
![License](https://img.shields.io/badge/license-Open%20Source-purple)

## 🎯 Overview

PhotoSync Server is a lightweight, self-hosted backend for the PhotoSync mobile application. It provides secure photo and video backup with device-bound authentication and automatic deduplication.

## ✨ Features

- 🔐 **Secure Authentication** - Device UUID + email/password binding
- 📦 **Smart Storage** - SHA-256 hash-based deduplication
- 🔄 **Auto-Restart** - Self-healing service that restarts on crash
- 🔥 **Auto-Firewall** - Automatically configures firewall rules
- 🚀 **Easy Setup** - One-command installation for all platforms
- 💾 **SQLite Database** - Lightweight, no external database needed
- 🌐 **CORS Enabled** - Works with mobile apps seamlessly

## 📋 Requirements

- **Node.js** 16.0.0 or higher
- **Operating System**: Linux, macOS, or Windows
- **Disk Space**: 100MB minimum (plus space for your photos)
- **RAM**: 512MB recommended
- **Port**: 3000 (configurable)

## 🚀 Quick Start

### Option 1: Automatic Installation (Recommended)

#### **Linux / Ubuntu Server**
```bash
# Download and run installer
curl -O https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/server/install-linux.sh
sudo bash install-linux.sh
```

#### **macOS**
```bash
# Download and run installer
curl -O https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/server/install-macos.sh
bash install-macos.sh
```

#### **Windows**
```powershell
# Run PowerShell as Administrator
# Download and run installer
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/server/install-windows.ps1" -OutFile "install-windows.ps1"
.\install-windows.ps1
```

### Option 2: Manual Installation

```bash
# Clone repository
git clone https://github.com/viktorvishyn369/PhotoSync.git
cd PhotoSync/server

# Install dependencies
npm install

# Start server
npm start
```

## 🔧 Installation Details

### Linux / Ubuntu Server

The automatic installer will:
- ✅ Install Node.js 20.x (if not present)
- ✅ Install npm dependencies
- ✅ Create uploads directory
- ✅ Configure UFW/firewalld/iptables firewall
- ✅ Open port 3000 automatically
- ✅ Create systemd service
- ✅ Enable auto-start on boot
- ✅ Enable auto-restart on crash

**Service Management:**
```bash
# Check status
sudo systemctl status photosync-server

# Stop service
sudo systemctl stop photosync-server

# Start service
sudo systemctl start photosync-server

# Restart service
sudo systemctl restart photosync-server

# View logs
sudo journalctl -u photosync-server -f
```

**Firewall Configuration:**
The installer automatically configures:
- UFW (Ubuntu/Debian)
- firewalld (CentOS/RHEL/Fedora)
- iptables (fallback)

Port 3000 will be opened automatically.

### macOS

The automatic installer will:
- ✅ Check Node.js installation
- ✅ Install npm dependencies
- ✅ Create uploads directory
- ✅ Configure macOS firewall
- ✅ Create LaunchAgent service
- ✅ Enable auto-start on login
- ✅ Enable auto-restart on crash

**Service Management:**
```bash
# Check status
launchctl list | grep photosync

# Stop service
launchctl unload ~/Library/LaunchAgents/com.photosync.server.plist

# Start service
launchctl load ~/Library/LaunchAgents/com.photosync.server.plist

# View logs
tail -f ~/path/to/server/photosync-server.log

# View errors
tail -f ~/path/to/server/photosync-server-error.log
```

### Windows

The automatic installer will:
- ✅ Check Node.js installation
- ✅ Install npm dependencies
- ✅ Create uploads directory
- ✅ Configure Windows Firewall
- ✅ Open port 3000 automatically
- ✅ Create Windows Service
- ✅ Enable auto-start on boot
- ✅ Enable auto-restart on crash

**Service Management:**
```powershell
# Check status
Get-Service "PhotoSync Server"

# Stop service
Stop-Service "PhotoSync Server"

# Start service
Start-Service "PhotoSync Server"

# Restart service
Restart-Service "PhotoSync Server"

# View logs (Event Viewer)
# Open Event Viewer → Windows Logs → Application
# Filter by source: PhotoSync Server
```

## 🌐 Network Configuration

### Local Network Access

After installation, the server will display your local IP address:
```
Local IP: 192.168.1.100:3000
```

Use this IP in the PhotoSync mobile app when on the same network.

### Remote Access

For remote access from anywhere:

1. **Get your public IP** (displayed during installation)
2. **Configure port forwarding** on your router:
   - External Port: 3000
   - Internal Port: 3000
   - Internal IP: Your server's local IP

3. **Use public IP** in mobile app:
   ```
   Remote IP: YOUR_PUBLIC_IP:3000
   ```

### Cloud Servers (AWS, Azure, Google Cloud)

⚠️ **IMPORTANT**: Cloud providers require manual security group configuration!

#### AWS EC2
1. Go to **EC2 Console** → **Security Groups**
2. Select your instance's security group
3. Click **Edit Inbound Rules**
4. Add rule:
   - Type: Custom TCP
   - Port: 3000
   - Source: 0.0.0.0/0 (or your IP for security)
5. Save rules

#### Azure
1. Go to **Virtual Machines** → Your VM
2. Click **Networking** → **Add inbound port rule**
3. Configure:
   - Destination port ranges: 3000
   - Protocol: TCP
   - Action: Allow
4. Save

#### Google Cloud
1. Go to **VPC Network** → **Firewall**
2. Click **Create Firewall Rule**
3. Configure:
   - Targets: All instances
   - Source IP ranges: 0.0.0.0/0
   - Protocols and ports: tcp:3000
4. Create

## 📱 Mobile App Configuration

After server installation, configure the PhotoSync mobile app:

### For Local Network:
1. Open PhotoSync app
2. Go to **Settings**
3. Select **Local Network**
4. Server will auto-detect or use displayed IP
5. Register/Login

### For Remote Server:
1. Open PhotoSync app
2. Go to **Settings**
3. Select **Remote Server**
4. Enter your public IP or domain
5. Port is automatically set to 3000
6. Register/Login

## 🔒 Security

### Authentication
- Device UUID binding prevents unauthorized access
- Bcrypt password hashing
- JWT token-based sessions
- Each device must register separately

### Network Security
- CORS configured for mobile app access
- Helmet.js security headers
- Rate limiting recommended (add middleware)

### Firewall
- Port 3000 automatically opened on local firewall
- Cloud providers require manual security group configuration
- Consider restricting source IPs in production

## 🗂️ File Structure

```
server/
├── server.js              # Main server file
├── package.json           # Dependencies
├── backup.db              # SQLite database (auto-created)
├── uploads/               # Uploaded files (auto-created)
├── install-linux.sh       # Linux installer
├── install-macos.sh       # macOS installer
├── install-windows.ps1    # Windows installer
└── README.md             # This file
```

## 🔄 Auto-Restart Configuration

All installers configure automatic restart on crash:

- **Linux**: systemd with `Restart=always` and `RestartSec=10`
- **macOS**: LaunchAgent with `KeepAlive` and `ThrottleInterval=10`
- **Windows**: node-windows service with `maxRestarts=10` and `wait=10`

The server will automatically restart within 10 seconds if it crashes.

## 📊 Monitoring

### Linux
```bash
# Real-time logs
sudo journalctl -u photosync-server -f

# Last 100 lines
sudo journalctl -u photosync-server -n 100

# Service status
sudo systemctl status photosync-server
```

### macOS
```bash
# Real-time logs
tail -f ~/path/to/server/photosync-server.log

# Service status
launchctl list | grep photosync
```

### Windows
```powershell
# Service status
Get-Service "PhotoSync Server"

# Event Viewer logs
Get-EventLog -LogName Application -Source "PhotoSync Server" -Newest 50
```

## 🐛 Troubleshooting

### Server won't start

**Check Node.js version:**
```bash
node -v  # Should be 16.0.0 or higher
```

**Check if port 3000 is in use:**
```bash
# Linux/macOS
lsof -i :3000

# Windows
netstat -ano | findstr :3000
```

**Check logs:**
```bash
# Linux
sudo journalctl -u photosync-server -n 50

# macOS
tail -50 ~/path/to/server/photosync-server-error.log

# Windows
# Check Event Viewer → Application logs
```

### Can't connect from mobile app

1. **Check server is running:**
   ```bash
   curl http://localhost:3000/api/health
   ```

2. **Check firewall:**
   ```bash
   # Linux
   sudo ufw status
   
   # macOS
   /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
   
   # Windows
   Get-NetFirewallRule -DisplayName "*PhotoSync*"
   ```

3. **Verify IP address:**
   - Use correct local/public IP
   - Ensure mobile device is on same network (for local)
   - Check port forwarding (for remote)

4. **Cloud servers:**
   - Verify security group allows port 3000
   - Check instance firewall settings

### Database issues

**Reset database:**
```bash
# Stop server first
rm backup.db
# Restart server - database will be recreated
```

### Permission issues (Linux)

```bash
# Fix uploads directory permissions
sudo chown -R $USER:$USER uploads
chmod 755 uploads
```

## 🔧 Configuration

### Change Port

Edit `server.js` line ~10:
```javascript
const PORT = process.env.PORT || 3000;
```

Or set environment variable:
```bash
export PORT=8080  # Linux/macOS
$env:PORT=8080    # Windows PowerShell
```

### Environment Variables

Create `.env` file:
```env
PORT=3000
NODE_ENV=production
JWT_SECRET=your-secret-key-here
```

## 📦 API Endpoints

- `POST /api/register` - Register new user
- `POST /api/login` - Login user
- `GET /api/files` - List user's files
- `POST /api/upload` - Upload file
- `GET /api/download/:id` - Download file
- `GET /api/health` - Health check

## 🤝 Contributing

This is an open-source project. Contributions welcome!

## 📄 License

Open Source - Free to use and modify

## 🆘 Support

- **GitHub Issues**: Report bugs and request features
- **Documentation**: See mobile app settings for setup guide
- **Community**: Join discussions on GitHub

## 📞 Contact

- **GitHub**: https://github.com/viktorvishyn369/PhotoSync
- **Issues**: https://github.com/viktorvishyn369/PhotoSync/issues

---

**Made with ❤️ for privacy-conscious users**

**Status**: 🟢 Production Ready
