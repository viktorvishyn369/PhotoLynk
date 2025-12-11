#!/bin/bash
# PhotoSync Server - Headless Server Installer for Linux
# For servers without GUI (Ubuntu Server, VPS, cloud instances)
# Usage: curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install-server.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      PhotoSync Server - Headless Installer        ║${NC}"
echo -e "${BLUE}║           For Linux Servers (No GUI)               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running as root or with sudo
if [ "$EUID" -eq 0 ]; then 
    SUDO=""
else
    SUDO="sudo"
fi

# Check if Node.js is installed
echo -e "${BLUE}[1/6]${NC} Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Node.js not found. Installing..."
    
    # Detect package manager
    if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO -E bash -
        $SUDO apt-get install -y nodejs
    elif command -v dnf &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | $SUDO bash -
        $SUDO dnf install -y nodejs
    elif command -v yum &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | $SUDO bash -
        $SUDO yum install -y nodejs
    elif command -v pacman &> /dev/null; then
        $SUDO pacman -S nodejs npm
    else
        echo -e "${RED}✗${NC} Could not install Node.js automatically"
        echo -e "${YELLOW}⚠${NC}  Please install Node.js from: https://nodejs.org/"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} Node.js installed"
else
    echo -e "${GREEN}✓${NC} Node.js found: $(node -v)"
fi

# Clone repository
echo ""
echo -e "${BLUE}[2/6]${NC} Downloading PhotoSync..."
INSTALL_DIR="/opt/photosync"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠${NC}  PhotoSync directory exists, updating..."
    cd "$INSTALL_DIR"
    $SUDO git pull
else
    $SUDO git clone https://github.com/viktorvishyn369/PhotoSync.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
echo -e "${GREEN}✓${NC} Downloaded to $INSTALL_DIR"

# Install server dependencies
echo ""
echo -e "${BLUE}[3/6]${NC} Installing server dependencies..."
cd server
$SUDO npm install --production
echo -e "${GREEN}✓${NC} Server dependencies installed"

# Create systemd service
echo ""
echo -e "${BLUE}[4/6]${NC} Creating systemd service..."

$SUDO tee /etc/systemd/system/photosync.service > /dev/null <<EOF
[Unit]
Description=PhotoSync Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR/server
Environment="UPLOAD_DIR=$INSTALL_DIR/server/uploads"
Environment="DB_PATH=$INSTALL_DIR/server/backup.db"
ExecStart=$(which node) server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=photosync

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓${NC} Systemd service created"

# Enable and start service
echo ""
echo -e "${BLUE}[5/6]${NC} Starting PhotoSync service..."
$SUDO systemctl daemon-reload
$SUDO systemctl enable photosync
$SUDO systemctl restart photosync
echo -e "${GREEN}✓${NC} Service started and enabled"

# Configure firewall
echo ""
echo -e "${BLUE}[6/6]${NC} Configuring firewall..."
if command -v ufw &> /dev/null; then
    $SUDO ufw allow 3000/tcp
    echo -e "${GREEN}✓${NC} UFW: Port 3000 opened"
elif command -v firewall-cmd &> /dev/null; then
    $SUDO firewall-cmd --permanent --add-port=3000/tcp
    $SUDO firewall-cmd --reload
    echo -e "${GREEN}✓${NC} Firewalld: Port 3000 opened"
else
    echo -e "${YELLOW}⚠${NC}  No firewall detected, skipping"
fi

# Get server IP
SERVER_IP=$(hostname -I | awk '{print $1}')

# Display success message
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ PhotoSync Server installed and running!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Server Information:${NC}"
echo -e "  • Status: ${GREEN}Running${NC}"
echo -e "  • URL: ${YELLOW}http://${SERVER_IP}:3000${NC}"
echo -e "  • Port: ${YELLOW}3000${NC}"
echo ""
echo -e "${BLUE}File Storage:${NC}"
echo -e "  • Location: ${YELLOW}$INSTALL_DIR/server/uploads/${NC}"
echo -e "  • Structure: ${YELLOW}uploads/{device-uuid}/${NC}"
echo -e "  • Each device gets its own folder"
echo ""
echo -e "${BLUE}Service Management:${NC}"
echo -e "  • Status:  ${YELLOW}sudo systemctl status photosync${NC}"
echo -e "  • Stop:    ${YELLOW}sudo systemctl stop photosync${NC}"
echo -e "  • Start:   ${YELLOW}sudo systemctl start photosync${NC}"
echo -e "  • Restart: ${YELLOW}sudo systemctl restart photosync${NC}"
echo -e "  • Logs:    ${YELLOW}sudo journalctl -u photosync -f${NC}"
echo ""
echo -e "${BLUE}Mobile App Setup:${NC}"
echo -e "  1. Download PhotoSync APK from GitHub Releases"
echo -e "  2. Install on your Android device"
echo -e "  3. Enter server URL: ${YELLOW}http://${SERVER_IP}:3000${NC}"
echo -e "  4. Register and start backing up!"
echo ""
echo -e "${YELLOW}Note:${NC} If connecting from outside your network, use your public IP"
echo -e "${YELLOW}Note:${NC} You may need to configure port forwarding on your router"
echo ""
echo -e "${GREEN}Installation complete!${NC} 🎉"
echo ""
