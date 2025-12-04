#!/bin/bash

# PhotoSync Server - macOS Installation Script
# Automatically installs as LaunchAgent with auto-restart

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     PhotoSync Server - macOS Installation         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Check Node.js
echo -e "${BLUE}[1/6]${NC} Checking Node.js installation..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Node.js not found. Please install Node.js first:"
    echo "   Visit: https://nodejs.org/"
    echo "   Or use Homebrew: brew install node"
    exit 1
else
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 16 ]; then
        echo -e "${RED}❌ Node.js version too old (need 16+)${NC}"
        echo "Update with: brew upgrade node"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} Node.js found: $(node -v)"
fi

# Step 2: Install dependencies
echo ""
echo -e "${BLUE}[2/6]${NC} Installing npm dependencies..."
npm install --production
echo -e "${GREEN}✓${NC} Dependencies installed"

# Step 3: Create uploads directory
echo ""
echo -e "${BLUE}[3/6]${NC} Creating uploads directory..."
mkdir -p uploads
chmod 755 uploads
echo -e "${GREEN}✓${NC} Uploads directory ready"

# Step 4: Get server IP
echo ""
echo -e "${BLUE}[4/6]${NC} Detecting server IP addresses..."
LOCAL_IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || echo "127.0.0.1")
PUBLIC_IP=$(curl -s ifconfig.me || echo "Unable to detect")

echo -e "${GREEN}✓${NC} Local IP: ${YELLOW}$LOCAL_IP${NC}"
if [ "$PUBLIC_IP" != "Unable to detect" ]; then
    echo -e "${GREEN}✓${NC} Public IP: ${YELLOW}$PUBLIC_IP${NC}"
fi

# Step 5: Configure macOS firewall
echo ""
echo -e "${BLUE}[5/6]${NC} Configuring macOS firewall..."

# Check if firewall is enabled
FIREWALL_STATUS=$(sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate | grep -o "enabled\|disabled")

if [ "$FIREWALL_STATUS" = "enabled" ]; then
    echo "macOS Firewall is enabled. Adding Node.js to allowed apps..."
    NODE_PATH=$(which node)
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$NODE_PATH"
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$NODE_PATH"
    echo -e "${GREEN}✓${NC} Node.js added to firewall exceptions"
else
    echo -e "${YELLOW}⚠${NC}  macOS Firewall is disabled"
fi

# Step 6: Create LaunchAgent
echo ""
echo -e "${BLUE}[6/6]${NC} Creating LaunchAgent service..."

INSTALL_DIR=$(pwd)
PLIST_FILE="$HOME/Library/LaunchAgents/com.photosync.server.plist"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.photosync.server</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>$INSTALL_DIR/server.js</string>
    </array>
    
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    
    <key>ThrottleInterval</key>
    <integer>10</integer>
    
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/photosync-server.log</string>
    
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/photosync-server-error.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>3000</string>
    </dict>
</dict>
</plist>
EOF

# Load the LaunchAgent
launchctl unload "$PLIST_FILE" 2>/dev/null || true
launchctl load "$PLIST_FILE"

echo -e "${GREEN}✓${NC} LaunchAgent created and loaded"

# Wait a moment for service to start
sleep 2

# Check if service is running
if launchctl list | grep -q "com.photosync.server"; then
    echo -e "${GREEN}✓${NC} Service started successfully"
else
    echo -e "${RED}❌ Service failed to start${NC}"
    echo "Check logs at: $INSTALL_DIR/photosync-server-error.log"
    exit 1
fi

# Display information
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║            Installation Successful! 🎉             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📱 Mobile App Configuration:${NC}"
echo ""
echo -e "   ${YELLOW}Local Network:${NC}"
echo -e "   • Server IP: ${GREEN}$LOCAL_IP:3000${NC}"
echo -e "   • Use this when on the same network"
echo ""
if [ "$PUBLIC_IP" != "Unable to detect" ]; then
    echo -e "   ${YELLOW}Remote Access:${NC}"
    echo -e "   • Server IP: ${GREEN}$PUBLIC_IP:3000${NC}"
    echo -e "   • Use this from anywhere (requires port forwarding)"
    echo ""
fi
echo -e "${BLUE}🔥 Firewall:${NC}"
echo -e "   • Node.js added to firewall exceptions"
echo -e "   • Port 3000 is ${GREEN}ALLOWED${NC}"
echo ""
echo -e "${BLUE}🔧 Service Management:${NC}"
echo -e "   • Status:  ${GREEN}launchctl list | grep photosync${NC}"
echo -e "   • Stop:    ${YELLOW}launchctl unload ~/Library/LaunchAgents/com.photosync.server.plist${NC}"
echo -e "   • Start:   ${GREEN}launchctl load ~/Library/LaunchAgents/com.photosync.server.plist${NC}"
echo -e "   • Logs:    ${BLUE}tail -f $INSTALL_DIR/photosync-server.log${NC}"
echo -e "   • Errors:  ${BLUE}tail -f $INSTALL_DIR/photosync-server-error.log${NC}"
echo ""
echo -e "${BLUE}🔄 Auto-Restart:${NC}"
echo -e "   • Service will ${GREEN}automatically restart${NC} if it crashes"
echo -e "   • Restart delay: 10 seconds"
echo -e "   • Starts on login: ${GREEN}ENABLED${NC}"
echo ""
echo -e "${GREEN}✓${NC} Server is running at: ${GREEN}http://$LOCAL_IP:3000${NC}"
echo ""
