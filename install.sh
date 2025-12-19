#!/bin/bash
# PhotoLynk Server - One-Line Installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoLynk/main/install.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           PhotoLynk Server - Installer            ║${NC}"
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

# Headless/non-interactive mode:
# - Default is non-interactive (best for one-line installers)
# - Set PHOTOSYNC_INTERACTIVE=1 to enable tray UI and interactive prompts
# - Set PHOTOSYNC_HEADLESS=1 to force headless behavior
INTERACTIVE="${PHOTOSYNC_INTERACTIVE:-0}"
HEADLESS="${PHOTOSYNC_HEADLESS:-0}"

# Non-interactive implies headless on Linux (since tray UI won't work there in headless)
if [ "$INTERACTIVE" != "1" ] && [ "$PLATFORM" = "Linux" ]; then
    HEADLESS="1"
fi

if [ "${PHOTOSYNC_NONINTERACTIVE:-0}" = "1" ]; then
    HEADLESS="1"
fi

# On Linux, if no display is available, auto-enable headless
if [ "$PLATFORM" = "Linux" ] && [ "$HEADLESS" != "1" ]; then
    if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
        HEADLESS="1"
    fi
fi

if [ "$HEADLESS" = "1" ]; then
    echo -e "${YELLOW}⚠${NC}  Headless mode enabled (no tray UI / no Expo auto-start)"
    echo ""
fi

# Reduce interactive prompts where possible
export GIT_TERMINAL_PROMPT=0
if [ "$PLATFORM" = "Mac" ]; then
    export NONINTERACTIVE=1
fi

# Try to load Homebrew into PATH if it is already installed (helps on reruns)
if [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x "/usr/local/bin/brew" ]; then
    eval "$(/usr/local/bin/brew shellenv)"
fi

# Check if Node.js is installed
echo -e "${BLUE}[1/6]${NC} Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Node.js not found. Installing..."
    
    if [ "$PLATFORM" = "Mac" ]; then
        # Install Homebrew if not installed
        if ! command -v brew &> /dev/null; then
            echo -e "${YELLOW}⚠${NC}  Homebrew not found. Installing Homebrew..."
            if ! /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
                echo -e "${RED}✗${NC} Homebrew installation failed. Make sure this macOS user is an Administrator, then rerun this installer."
                exit 1
            fi
            if [ -x "/opt/homebrew/bin/brew" ]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [ -x "/usr/local/bin/brew" ]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
        fi
        echo -e "${BLUE}→${NC} Using Homebrew to install Node.js"
        set +e
        HOMEBREW_NO_INSTALL_FROM_API=1 brew install node
        BREW_NODE_EXIT=$?
        set -e
        if [ "$BREW_NODE_EXIT" -ne 0 ]; then
            echo -e "${RED}✗${NC} Could not install Node.js automatically via Homebrew"
            echo -e "${YELLOW}⚠${NC}  Please install Node.js from: https://nodejs.org/ (LTS recommended), then rerun this script."
            exit 1
        fi
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
echo -e "${BLUE}[3/6]${NC} Downloading PhotoLynk..."

DEFAULT_INSTALL_DIR="$HOME/PhotoLynk"
LEGACY_INSTALL_DIR="$HOME/PhotoSync"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
if [ -d "$LEGACY_INSTALL_DIR" ] && [ ! -d "$DEFAULT_INSTALL_DIR" ]; then
    INSTALL_DIR="$LEGACY_INSTALL_DIR"
fi

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠${NC}  Existing install directory found, resetting and updating..."
    cd "$INSTALL_DIR"
    git remote set-url origin https://github.com/viktorvishyn369/PhotoLynk.git >/dev/null 2>&1 || true
    # Discard any local changes (including generated lockfiles) so updates are reliable
    git reset --hard HEAD >/dev/null 2>&1 || true
    git clean -fd >/dev/null 2>&1 || true
    git pull || true
else
    git clone https://github.com/viktorvishyn369/PhotoLynk.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
echo -e "${GREEN}✓${NC} Downloaded to $INSTALL_DIR"

# Install server dependencies
echo ""
echo -e "${BLUE}[4/7]${NC} Installing server dependencies..."
cd server
npm install --omit=dev
echo -e "${GREEN}✓${NC} Server dependencies installed"

# Install tray dependencies
echo ""
echo -e "${BLUE}[5/7]${NC} Installing tray app dependencies..."
cd ../server-tray

if [ "$HEADLESS" = "1" ]; then
    echo -e "${YELLOW}⚠${NC}  Headless mode: skipping tray app install"
else
    npm install
    echo -e "${GREEN}✓${NC} Tray app dependencies installed"
fi

# Start the tray app in the background
echo ""
echo -e "${BLUE}[6/7]${NC} Starting PhotoLynk Server tray in background..."
echo ""

if [ "$HEADLESS" = "1" ]; then
    echo -e "${BLUE}→${NC} Starting server in background (headless)"
    cd ../server
    (nohup node server.js >/dev/null 2>&1 &)
    echo -e "${GREEN}✓${NC} Server started"
    cd ../server-tray
else
    (npm start &>/dev/null &)
    echo -e "${GREEN}✓${NC} Tray app launched. Look for the PhotoLynk icon in your:"
    if [ "$PLATFORM" = "Mac" ]; then
        echo "  • Menu bar (top-right corner)"
    else
        echo "  • System tray"
    fi
fi

# Prepare and start the mobile app (Expo dev server)
echo ""
echo -e "${BLUE}[7/7]${NC} Preparing mobile app and starting Expo dev server..."
cd ../mobile-v2
npm install
echo -e "${GREEN}✓${NC} Mobile app dependencies installed"

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}All components installed.${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""
echo "The PhotoLynk Server tray is running on your computer."
echo "Now starting the Expo dev server for the mobile app..."
echo "Keep this terminal open and connect from your phone using Expo (QR code)."
echo ""

START_EXPO="${PHOTOSYNC_START_EXPO:-}"
if [ "$HEADLESS" = "1" ] && [ "$START_EXPO" != "1" ]; then
    echo -e "${YELLOW}⚠${NC}  Headless mode: skipping Expo dev server auto-start"
    echo -e "${BLUE}→${NC} To start Expo later: cd $INSTALL_DIR/mobile-v2 && npx expo start --dev-client --clear"
    exit 0
fi

# Start Expo dev server (foreground so user can see QR code)
PORT=8081
kill_listeners_on_port() {
    _port="$1"
    if command -v lsof &> /dev/null; then
        pids=$(lsof -tiTCP:"$_port" -sTCP:LISTEN 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo -e "${YELLOW}⚠${NC}  Port $_port is in use. Stopping existing process(es): $pids"
            kill $pids 2>/dev/null || true
            sleep 1
            still=$(lsof -tiTCP:"$_port" -sTCP:LISTEN 2>/dev/null || true)
            if [ -n "$still" ]; then
                kill -9 $still 2>/dev/null || true
            fi
        fi
    elif command -v fuser &> /dev/null; then
        pids=$(fuser -n tcp "$_port" 2>/dev/null | tr -s ' ' | sed 's/^ //g' || true)
        if [ -n "$pids" ]; then
            echo -e "${YELLOW}⚠${NC}  Port $_port is in use. Stopping existing process(es): $pids"
            kill $pids 2>/dev/null || true
            sleep 1
            fuser -k -n tcp "$_port" 2>/dev/null || true
        fi
    fi
}

kill_listeners_on_port 8081
kill_listeners_on_port 8082

if command -v lsof &> /dev/null; then
    if lsof -tiTCP:$PORT -sTCP:LISTEN &> /dev/null; then
        PORT=8082
    fi
else
    if command -v nc &> /dev/null; then
        if nc -z 127.0.0.1 $PORT &> /dev/null; then
            PORT=8082
        fi
    fi
fi

echo -e "${BLUE}→${NC} Starting Expo on port $PORT (LAN mode)"
npx expo start --clear --lan --port $PORT
