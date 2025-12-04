# PhotoSync Server - Quick Start Guide

## 🚀 One-Command Installation

### Linux / Ubuntu Server

```bash
sudo bash install-linux.sh
```

**What it does:**
- ✅ Installs Node.js (if needed)
- ✅ Installs dependencies
- ✅ Opens port 3000 in firewall (UFW/firewalld/iptables)
- ✅ Creates systemd service
- ✅ Enables auto-restart on crash
- ✅ Starts on boot

**After installation:**
```
Local IP: 192.168.1.100:3000  ← Use this in mobile app
```

---

### macOS

```bash
bash install-macos.sh
```

**What it does:**
- ✅ Checks Node.js
- ✅ Installs dependencies
- ✅ Configures macOS firewall
- ✅ Creates LaunchAgent service
- ✅ Enables auto-restart on crash
- ✅ Starts on login

**After installation:**
```
Local IP: 192.168.1.100:3000  ← Use this in mobile app
```

---

### Windows

```powershell
# Run PowerShell as Administrator
.\install-windows.ps1
```

**What it does:**
- ✅ Checks Node.js
- ✅ Installs dependencies
- ✅ Opens port 3000 in Windows Firewall
- ✅ Creates Windows Service
- ✅ Enables auto-restart on crash
- ✅ Starts on boot

**After installation:**
```
Local IP: 192.168.1.100:3000  ← Use this in mobile app
```

---

## 📱 Configure Mobile App

### Step 1: Open PhotoSync App
Launch the PhotoSync app on your phone

### Step 2: Go to Settings
Tap the settings icon (⚙️)

### Step 3: Configure Server

**For Local Network (same WiFi):**
1. Select "Local Network"
2. Server IP is auto-detected or shown during installation
3. Example: `192.168.1.100:3000`

**For Remote Access (anywhere):**
1. Select "Remote Server"
2. Enter your public IP or domain
3. Example: `203.0.113.45` or `myserver.com`
4. Port 3000 is automatic

### Step 4: Register
1. Enter your email
2. Create a password
3. Tap "Create Account"

### Step 5: Start Backing Up!
Tap "Backup Photos" to start syncing

---

## ☁️ Cloud Server Setup (AWS/Azure/GCP)

### ⚠️ IMPORTANT: Manual Port Configuration Required

After running the installer, you MUST open port 3000 in your cloud provider's security settings:

### AWS EC2
```
1. EC2 Console → Security Groups
2. Select your instance's security group
3. Edit Inbound Rules → Add Rule
4. Type: Custom TCP
5. Port: 3000
6. Source: 0.0.0.0/0
7. Save
```

### Azure
```
1. Virtual Machines → Your VM
2. Networking → Add inbound port rule
3. Port: 3000
4. Protocol: TCP
5. Action: Allow
6. Save
```

### Google Cloud
```
1. VPC Network → Firewall
2. Create Firewall Rule
3. Targets: All instances
4. Ports: tcp:3000
5. Source: 0.0.0.0/0
6. Create
```

**Your Remote IP:**
```
Use your cloud instance's public IP in the mobile app
Example: 203.0.113.45:3000
```

---

## 🔧 Service Management

### Linux
```bash
# Check status
sudo systemctl status photosync-server

# Restart
sudo systemctl restart photosync-server

# View logs
sudo journalctl -u photosync-server -f
```

### macOS
```bash
# Check status
launchctl list | grep photosync

# Restart
launchctl unload ~/Library/LaunchAgents/com.photosync.server.plist
launchctl load ~/Library/LaunchAgents/com.photosync.server.plist

# View logs
tail -f photosync-server.log
```

### Windows
```powershell
# Check status
Get-Service "PhotoSync Server"

# Restart
Restart-Service "PhotoSync Server"

# View logs
# Event Viewer → Application logs
```

---

## 🔄 Auto-Restart Feature

**Your server automatically restarts if it crashes!**

- ✅ Restarts within 10 seconds
- ✅ Starts on boot/login
- ✅ Self-healing
- ✅ No manual intervention needed

---

## 🐛 Troubleshooting

### Can't connect from mobile app?

**1. Check server is running:**
```bash
curl http://localhost:3000/api/health
# Should return: {"status":"ok"}
```

**2. Check firewall:**
- Linux: `sudo ufw status`
- macOS: Check System Preferences → Security
- Windows: Check Windows Defender Firewall

**3. Verify IP address:**
- Use the IP shown during installation
- Make sure phone is on same network (for local)
- Check port forwarding (for remote)

**4. Cloud servers:**
- Did you open port 3000 in security group?
- Check instance firewall settings

### Server won't start?

**Check Node.js version:**
```bash
node -v
# Should be 16.0.0 or higher
```

**Check if port 3000 is in use:**
```bash
# Linux/macOS
lsof -i :3000

# Windows
netstat -ano | findstr :3000
```

**View error logs:**
- Linux: `sudo journalctl -u photosync-server -n 50`
- macOS: `tail -50 photosync-server-error.log`
- Windows: Event Viewer → Application logs

---

## 📊 What Gets Installed

### Files Created:
```
server/
├── server.js              # Main server
├── package.json           # Dependencies
├── backup.db              # Database (auto-created)
├── uploads/               # Your photos (auto-created)
└── node_modules/          # Dependencies
```

### Services Created:

**Linux:**
- `/etc/systemd/system/photosync-server.service`

**macOS:**
- `~/Library/LaunchAgents/com.photosync.server.plist`

**Windows:**
- Windows Service: "PhotoSync Server"

### Firewall Rules:
- Port 3000 TCP (Inbound) - ALLOWED

---

## 🎯 Summary

1. **Run installer** for your OS
2. **Note the Local IP** shown at the end
3. **Open port 3000** if on cloud server (AWS/Azure/GCP)
4. **Configure mobile app** with server IP
5. **Register** and start backing up!

**That's it! Your server is ready.** 🎉

---

## 📞 Need Help?

- **Full Documentation**: See `README.md`
- **GitHub Issues**: Report problems
- **Mobile App**: Check Settings → Resources for more info

---

**Server Status**: 🟢 Running at `http://YOUR_IP:3000`
