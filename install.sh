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
echo -e "${BLUE}[1/6]${NC} Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Node.js not found. Installing..."
    
    if [ "$PLATFORM" = "Mac" ]; then
        # Install Homebrew if not installed
        if ! command -v brew &> /dev/null; then
            echo -e "${YELLOW}⚠${NC}  Homebrew not found. Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        echo -e "${BLUE}→${NC} Using Homebrew to install Node.js"
        brew install node
    else
        # Linux - try to detect package manager
        if command -v apt-get &> /dev/null; then
            echo -e "${BLUE}→${NC} Using apt-get to install Node.js (NodeSource LTS)"
            curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif command -v dnf &> /dev/null; then
            echo -e "${BLUE}→${NC} Using dnf to install Node.js (NodeSource LTS)"
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
            sudo dnf install -y nodejs
        elif command -v pacman &> /dev/null; then
            echo -e "${BLUE}→${NC} Using pacman to install Node.js + npm"
            sudo pacman -S --noconfirm nodejs npm
        else
            echo -e "${RED}✗${NC} Could not install Node.js automatically"
            echo -e "${YELLOW}⚠${NC}  Please install Node.js from: https://nodejs.org/ (LTS recommended), then rerun this script."
            exit 1
        fi
    fi
    echo -e "${GREEN}✓${NC} Node.js installed"
else
    echo -e "${GREEN}✓${NC} Node.js found: $(node -v)"
fi

# Check if Git is installed
echo ""
echo -e "${BLUE}[2/6]${NC} Checking Git..."
if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Git not found. Installing..."

    if [ "$PLATFORM" = "Mac" ]; then
        if command -v brew &> /dev/null; then
            echo -e "${BLUE}→${NC} Using Homebrew to install Git"
            brew install git
        else
            echo -e "${YELLOW}⚠${NC}  Homebrew not available. On macOS, Git is usually provided by Xcode Command Line Tools."
            echo -e "${YELLOW}→${NC}  Please run: xcode-select --install"
            echo -e "${YELLOW}   Then rerun this installer after Git is installed.${NC}"
            exit 1
        fi
    else
        if command -v apt-get &> /dev/null; then
            echo -e "${BLUE}→${NC} Using apt-get to install Git"
            sudo apt-get install -y git
        elif command -v dnf &> /dev/null; then
            echo -e "${BLUE}→${NC} Using dnf to install Git"
            sudo dnf install -y git
        elif command -v pacman &> /dev/null; then
            echo -e "${BLUE}→${NC} Using pacman to install Git"
            sudo pacman -S --noconfirm git
        else
            echo -e "${RED}✗${NC} Could not install Git automatically"
            echo -e "${YELLOW}⚠${NC}  Please install Git manually from https://git-scm.com/ then rerun this script."
            exit 1
        fi
    fi

    echo -e "${GREEN}✓${NC} Git installed"
else
    echo -e "${GREEN}✓${NC} Git found: $(git --version)"
fi

# Clone repository
echo ""
echo -e "${BLUE}[3/6]${NC} Downloading PhotoSync..."
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
echo -e "${BLUE}[4/7]${NC} Installing server dependencies..."
cd server
rm -f package-lock.json
npm install --production
echo -e "${GREEN}✓${NC} Server dependencies installed"

# Install tray dependencies
echo ""
echo -e "${BLUE}[5/7]${NC} Installing tray app dependencies..."
cd ../server-tray
rm -f package-lock.json
npm install
echo -e "${GREEN}✓${NC} Tray app dependencies installed"

# Start the tray app in the background
echo ""
echo -e "${BLUE}[6/7]${NC} Starting PhotoSync Server tray in background..."
echo ""
(npm start &>/dev/null &)
echo -e "${GREEN}✓${NC} Tray app launched. Look for the PhotoSync icon in your:"
if [ "$PLATFORM" = "Mac" ]; then
    echo "  • Menu bar (top-right corner)"
else
    echo "  • System tray"
fi

# Prepare and start the mobile app (Expo dev server)
echo ""
echo -e "${BLUE}[7/7]${NC} Preparing mobile app and starting Expo dev server..."
cd ../mobile-v2
rm -f package-lock.json
npm install
echo -e "${GREEN}✓${NC} Mobile app dependencies installed"

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}All components installed.${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""
echo "The PhotoSync Server tray is running on your computer."
echo "Now starting the Expo dev server for the mobile app..."
echo "Keep this terminal open and connect from your phone using Expo (QR code)."
echo ""

# Start Expo dev server (foreground so user can see QR code)
npx expo start --tunnel

