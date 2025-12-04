#!/bin/bash

# PhotoSync Server - Ubuntu Server Installation Script (Command-Line Only)
# For headless Ubuntu Server environments

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  PhotoSync Server (CLI) - Ubuntu Server Install   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Check Node.js
echo -e "${BLUE}[1/7]${NC} Checking Node.js installation..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo -e "${GREEN}✓${NC} Node.js installed"
else
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 16 ]; then
        echo -e "${RED}❌ Node.js version too old (need 16+)${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} Node.js found: $(node -v)"
fi

# Step 2: Install dependencies
echo ""
echo -e "${BLUE}[2/7]${NC} Installing npm dependencies..."
npm install --production
echo -e "${GREEN}✓${NC} Dependencies installed"

# Step 3: Create uploads directory
echo ""
echo -e "${BLUE}[3/7]${NC} Creating uploads directory..."
mkdir -p uploads
chmod 755 uploads
echo -e "${GREEN}✓${NC} Uploads directory ready"

# Step 4: Get server IP
echo ""
echo -e "${BLUE}[4/7]${NC} Detecting server IP addresses..."
LOCAL_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -s ifconfig.me || echo "Unable to detect")

echo -e "${GREEN}✓${NC} Local IP: ${YELLOW}$LOCAL_IP${NC}"
if [ "$PUBLIC_IP" != "Unable to detect" ]; then
    echo -e "${GREEN}✓${NC} Public IP: ${YELLOW}$PUBLIC_IP${NC}"
fi

# Step 5: Configure UFW firewall
echo ""
echo -e "${BLUE}[5/7]${NC} Configuring UFW firewall..."

if command -v ufw &> /dev/null; then
    if sudo ufw status | grep -q "Status: active"; then
        echo "UFW is active. Opening port 3000..."
        sudo ufw allow 3000/tcp
        echo -e "${GREEN}✓${NC} Port 3000 opened in UFW"
    else
        echo -e "${YELLOW}⚠${NC}  UFW is installed but not active"
    fi
else
    echo -e "${YELLOW}⚠${NC}  UFW not installed"
fi

# Step 6: Create systemd service
echo ""
echo -e "${BLUE}[6/7]${NC} Creating systemd service..."

INSTALL_DIR=$(pwd)
SERVICE_FILE="/etc/systemd/system/photosync-server.service"

sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=PhotoSync Server (Headless)
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/server.js
Restart=always
RestartSec=10
StandardOutput=append:$INSTALL_DIR/photosync-server.log
StandardError=append:$INSTALL_DIR/photosync-server-error.log

Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and start service
sudo systemctl daemon-reload
sudo systemctl enable photosync-server.service
sudo systemctl start photosync-server.service

echo -e "${GREEN}✓${NC} Systemd service created and started"

# Step 7: Check service status
echo ""
echo -e "${BLUE}[7/7]${NC} Checking service status..."
sleep 2

if sudo systemctl is-active --quiet photosync-server.service; then
    echo -e "${GREEN}✓${NC} Service is running"
else
    echo -e "${RED}❌ Service failed to start${NC}"
    echo "Check logs with: sudo journalctl -u photosync-server.service -n 50"
    exit 1
fi

# Display information
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║            Installation Successful! 🎉             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📁 Uploaded Photos Location:${NC}"
echo -e "   • Path: ${GREEN}$INSTALL_DIR/uploads/[user_id]/${NC}"
echo -e "   • Each user gets their own folder by user ID"
echo -e "   • List users: ${YELLOW}ls -la $INSTALL_DIR/uploads${NC}"
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
echo -e "   • Port 3000 is ${GREEN}ALLOWED${NC}"
echo ""
echo -e "${BLUE}🔧 Service Management:${NC}"
echo -e "   • Status:  ${GREEN}sudo systemctl status photosync-server${NC}"
echo -e "   • Stop:    ${YELLOW}sudo systemctl stop photosync-server${NC}"
echo -e "   • Start:   ${GREEN}sudo systemctl start photosync-server${NC}"
echo -e "   • Restart: ${BLUE}sudo systemctl restart photosync-server${NC}"
echo -e "   • Logs:    ${BLUE}sudo journalctl -u photosync-server -f${NC}"
echo ""
echo -e "${BLUE}🔄 Auto-Restart:${NC}"
echo -e "   • Service will ${GREEN}automatically restart${NC} if it crashes"
echo -e "   • Restart delay: 10 seconds"
echo -e "   • Starts on boot: ${GREEN}ENABLED${NC}"
echo ""
echo -e "${GREEN}✓${NC} Server is running at: ${GREEN}http://$LOCAL_IP:3000${NC}"
echo ""
