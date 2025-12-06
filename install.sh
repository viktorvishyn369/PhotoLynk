#!/bin/bash
# PhotoSync Server - One-Line Installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           PhotoSync Server - Installer            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# Detect OS
OS="$(uname -s)"
case "${OS}" in
    Linux*)     PLATFORM=Linux;;
    Darwin*)    PLATFORM=Mac;;
    *)          PLATFORM="UNKNOWN"
esac

if [ "$PLATFORM" = "UNKNOWN" ]; then
    echo -e "${RED}✗${NC} Unsupported operating system"
    exit 1
fi

echo -e "${GREEN}✓${NC} Detected: $PLATFORM"
echo ""

# Check if Node.js is installed
echo -e "${BLUE}[1/5]${NC} Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Node.js not found. Installing..."
    
    if [ "$PLATFORM" = "Mac" ]; then
        # Install Homebrew if not installed
        if ! command -v brew &> /dev/null; then
            echo -e "${YELLOW}⚠${NC}  Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        brew install node
    else
        # Linux - try to detect package manager
        if command -v apt-get &> /dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif command -v dnf &> /dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
            sudo dnf install -y nodejs
        elif command -v pacman &> /dev/null; then
            sudo pacman -S nodejs npm
        else
            echo -e "${RED}✗${NC} Could not install Node.js automatically"
            echo -e "${YELLOW}⚠${NC}  Please install Node.js from: https://nodejs.org/"
            exit 1
        fi
    fi
    echo -e "${GREEN}✓${NC} Node.js installed"
else
    echo -e "${GREEN}✓${NC} Node.js found: $(node -v)"
fi

# Clone repository
echo ""
echo -e "${BLUE}[2/5]${NC} Downloading PhotoSync..."
INSTALL_DIR="$HOME/PhotoSync"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠${NC}  PhotoSync directory exists, resetting and updating..."
    cd "$INSTALL_DIR"
    # Discard any local changes (including generated lockfiles) so updates are reliable
    git reset --hard HEAD >/dev/null 2>&1 || true
    git clean -fd >/dev/null 2>&1 || true
    git pull
else
    git clone https://github.com/viktorvishyn369/PhotoSync.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
echo -e "${GREEN}✓${NC} Downloaded to $INSTALL_DIR"

# Install server dependencies
echo ""
echo -e "${BLUE}[3/5]${NC} Installing server dependencies..."
cd server
rm -f package-lock.json
npm install --production
echo -e "${GREEN}✓${NC} Server dependencies installed"

# Install tray dependencies
echo ""
echo -e "${BLUE}[4/5]${NC} Installing tray app dependencies..."
cd ../server-tray
rm -f package-lock.json
npm install
echo -e "${GREEN}✓${NC} Tray app dependencies installed"

# Start the tray app
echo ""
echo -e "${BLUE}[5/5]${NC} Starting PhotoSync Server..."
echo ""
echo -e "${GREEN}✓${NC} Installation complete!"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}PhotoSync Server is starting...${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""
echo "Look for the PhotoSync icon in your:"
if [ "$PLATFORM" = "Mac" ]; then
    echo "  • Menu bar (top-right corner)"
else
    echo "  • System tray"
fi
echo ""
echo "Click the icon to:"
echo "  • Open files location"
echo "  • Stop/Start/Restart server"
echo "  • Quit"
echo ""
echo "Server URL: http://YOUR_LOCAL_IP:3000"
echo ""
echo -e "${YELLOW}Note:${NC} Find your local IP with: ifconfig (Mac/Linux) or ipconfig (Windows)"
echo ""

# Start the app
npm start
