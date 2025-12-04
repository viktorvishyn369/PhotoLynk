# PhotoSync - Global Installation Guide

This guide ensures PhotoSync works for users worldwide, regardless of location, language, or platform.

## 🌍 Universal Requirements

### Node.js Installation (All Platforms)

**Option 1: Official Installer (Recommended)**
- Visit: https://nodejs.org/
- Download LTS version (works in all countries)
- Installer available in multiple languages
- Works offline after download

**Option 2: Package Manager**

**Windows:**
```powershell
# Using Chocolatey
choco install nodejs-lts

# Using Scoop
scoop install nodejs-lts

# Using Winget
winget install OpenJS.NodeJS.LTS
```

**macOS:**
```bash
# Using Homebrew
brew install node@20

# Using MacPorts
sudo port install nodejs20
```

**Linux (Universal - works on all distros):**
```bash
# Using NVM (Node Version Manager) - RECOMMENDED for global compatibility
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
# Or wget:
wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Restart terminal, then:
nvm install --lts
nvm use --lts
```

**Linux (Distribution-Specific):**
```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Fedora/RHEL/CentOS
curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
sudo dnf install -y nodejs

# Arch Linux
sudo pacman -S nodejs npm

# openSUSE
sudo zypper install nodejs20

# Alpine Linux
sudo apk add nodejs npm
```

## 🚀 Installation Steps (After Node.js is installed)

### 1. Verify Node.js
```bash
node --version  # Should show v16.0.0 or higher
npm --version   # Should show 8.0.0 or higher
```

### 2. Clone or Download PhotoSync
```bash
git clone https://github.com/viktorvishyn369/PhotoSync.git
cd PhotoSync
```

Or download ZIP from GitHub and extract.

### 3. Install Server

**Automated (Linux/macOS):**
```bash
cd server
chmod +x install-*.sh
sudo ./install-linux.sh        # Linux Desktop
# OR
sudo ./install-ubuntu-server.sh # Ubuntu Server (headless)
# OR
sudo ./install-macos.sh         # macOS
```

**Automated (Windows):**
```powershell
cd server
powershell -ExecutionPolicy Bypass -File install-windows.ps1
```

**Manual (Universal - works everywhere):**
```bash
cd server
npm install
node server.js
```

The server will:
- Create database automatically
- Create uploads folder automatically
- Start on port 3000
- Work in any language/locale

### 4. Install Mobile App

**From APK (Android):**
1. Download `PhotoSync-v1.0.0.apk` from releases
2. Enable "Install from Unknown Sources"
3. Install APK
4. Works on any Android device worldwide

**Build from Source:**
```bash
cd mobile-v2
npm install
npx expo start
```

## 🌐 Locale & Language Support

### Server
- ✅ Works in any system locale (UTF-8, ASCII, etc.)
- ✅ Supports international characters in filenames
- ✅ No language-specific dependencies
- ✅ Database uses UTF-8 encoding

### Mobile App
- ✅ Works on devices in any language
- ✅ Supports international keyboards
- ✅ Handles non-Latin filenames
- ✅ Works with any date/time format

## 🔧 Troubleshooting

### Node.js Installation Fails

**China/Restricted Regions:**
```bash
# Use Taobao mirror
npm config set registry https://registry.npmmirror.com
npm install

# Or use cnpm
npm install -g cnpm --registry=https://registry.npmmirror.com
cnpm install
```

**Slow Downloads:**
```bash
# Use different npm registry
npm config set registry https://registry.npmjs.org/
# Or European mirror
npm config set registry https://registry.npmjs.eu/
```

### Firewall Issues
```bash
# Linux
sudo ufw allow 3000/tcp

# Windows
netsh advfirewall firewall add rule name="PhotoSync" dir=in action=allow protocol=TCP localport=3000

# macOS
# System Preferences > Security & Privacy > Firewall > Firewall Options
# Allow incoming connections for Node
```

### Permission Issues
```bash
# Linux/macOS - Run with sudo
sudo node server.js

# Or fix npm permissions (recommended)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
```

## 📦 Offline Installation

If you have no internet connection:

1. **Download on connected computer:**
   - Node.js installer
   - PhotoSync repository (ZIP)
   - Run `npm install` once to download dependencies

2. **Transfer to offline computer:**
   - Copy entire `node_modules` folder
   - Copy all PhotoSync files

3. **Run:**
   ```bash
   node server.js  # No internet needed
   ```

## 🌍 Tested Regions

PhotoSync has been designed to work in:
- ✅ Americas (North & South)
- ✅ Europe (EU & non-EU)
- ✅ Asia (including China, Japan, Korea)
- ✅ Middle East
- ✅ Africa
- ✅ Oceania

## 📱 Mobile App Compatibility

- ✅ Android 5.0+ (API 21+)
- ✅ Works on all Android devices globally
- ✅ No Google Play Services required
- ✅ Can be sideloaded anywhere

## 🔒 No External Dependencies

PhotoSync does NOT require:
- ❌ Google services
- ❌ Cloud accounts
- ❌ External APIs
- ❌ Internet connection (after installation)
- ❌ Specific DNS servers
- ❌ VPN or proxy

Everything runs locally on your network!

## 💡 Best Practices

1. **Use NVM for Node.js** - Works universally
2. **Download official Node.js** - If NVM not available
3. **Use manual installation** - If scripts fail
4. **Check firewall** - Allow port 3000
5. **Use local IP** - Not localhost for mobile access

## 🆘 Support

If installation fails in your region:
1. Try manual installation (always works)
2. Use alternative npm registry
3. Download Node.js directly from nodejs.org
4. Open GitHub issue with your location/error

## ✅ Success Checklist

- [ ] Node.js 16+ installed
- [ ] npm 8+ installed
- [ ] PhotoSync downloaded
- [ ] Dependencies installed (`npm install`)
- [ ] Server starts (`node server.js`)
- [ ] Port 3000 accessible
- [ ] Mobile app installed
- [ ] Can connect from mobile to server

**If all checked, PhotoSync is ready to use!** 🎉
