#!/bin/bash

# PhotoSync Server - Linux/Ubuntu Installation Script
# Automatically installs as systemd service with auto-restart and firewall configuration

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     PhotoSync Server - Linux Installation         ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root (use sudo)${NC}"
    echo "Usage: sudo bash install-linux.sh"
    exit 1
fi

# Get the actual user (not root)
ACTUAL_USER=${SUDO_USER:-$USER}
ACTUAL_HOME=$(eval echo ~$ACTUAL_USER)

echo -e "${GREEN}✓${NC} Running as root"
echo -e "${GREEN}✓${NC} Installing for user: $ACTUAL_USER"
echo ""

# Step 1: Check Node.js
echo -e "${BLUE}[1/8]${NC} Checking Node.js installation..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Node.js not found. Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    echo -e "${GREEN}✓${NC} Node.js installed: $(node -v)"
else
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 16 ]; then
        echo -e "${YELLOW}⚠${NC}  Node.js version too old. Updating..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi
    echo -e "${GREEN}✓${NC} Node.js found: $(node -v)"
fi

# Step 2: Install dependencies
echo ""
echo -e "${BLUE}[2/8]${NC} Installing npm dependencies..."
npm install --production
echo -e "${GREEN}✓${NC} Dependencies installed"

# Step 3: Create uploads directory
echo ""
echo -e "${BLUE}[3/8]${NC} Creating uploads directory..."
mkdir -p uploads
chown -R $ACTUAL_USER:$ACTUAL_USER uploads
chmod 755 uploads
echo -e "${GREEN}✓${NC} Uploads directory ready"

# Step 4: Get server IP
echo ""
echo -e "${BLUE}[4/8]${NC} Detecting server IP addresses..."
LOCAL_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -s ifconfig.me || echo "Unable to detect")

echo -e "${GREEN}✓${NC} Local IP: ${YELLOW}$LOCAL_IP${NC}"
if [ "$PUBLIC_IP" != "Unable to detect" ]; then
    echo -e "${GREEN}✓${NC} Public IP: ${YELLOW}$PUBLIC_IP${NC}"
fi

# Step 5: Configure firewall (UFW)
echo ""
echo -e "${BLUE}[5/8]${NC} Configuring firewall..."

if command -v ufw &> /dev/null; then
    echo "Configuring UFW firewall..."
    ufw allow 3000/tcp comment 'PhotoSync Server'
    ufw --force enable
    echo -e "${GREEN}✓${NC} UFW: Port 3000 opened"
else
    echo -e "${YELLOW}⚠${NC}  UFW not found, skipping"
fi

# Configure firewalld (CentOS/RHEL)
if command -v firewall-cmd &> /dev/null; then
    echo "Configuring firewalld..."
    firewall-cmd --permanent --add-port=3000/tcp
    firewall-cmd --reload
    echo -e "${GREEN}✓${NC} firewalld: Port 3000 opened"
fi

# Configure iptables as fallback
if ! command -v ufw &> /dev/null && ! command -v firewall-cmd &> /dev/null; then
    echo "Configuring iptables..."
    iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
    # Save iptables rules
    if command -v netfilter-persistent &> /dev/null; then
        netfilter-persistent save
    elif [ -f /etc/init.d/iptables-persistent ]; then
        /etc/init.d/iptables-persistent save
    fi
    echo -e "${GREEN}✓${NC} iptables: Port 3000 opened"
fi

# Step 6: Create systemd service
echo ""
echo -e "${BLUE}[6/8]${NC} Creating systemd service..."

INSTALL_DIR=$(pwd)

cat > /etc/systemd/system/photosync-server.service << EOF
[Unit]
Description=PhotoSync Server - Decentralized Photo Backup
After=network.target
Documentation=https://github.com/viktorvishyn369/PhotoSync

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=photosync-server

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$INSTALL_DIR/uploads $INSTALL_DIR

# Resource limits
LimitNOFILE=65536
MemoryMax=512M

# Environment
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓${NC} Systemd service created"

# Step 7: Enable and start service
echo ""
echo -e "${BLUE}[7/8]${NC} Enabling and starting service..."
systemctl daemon-reload
systemctl enable photosync-server.service
systemctl start photosync-server.service

# Wait a moment for service to start
sleep 2

# Check service status
if systemctl is-active --quiet photosync-server.service; then
    echo -e "${GREEN}✓${NC} Service started successfully"
else
    echo -e "${RED}❌ Service failed to start${NC}"
    echo "Check logs with: journalctl -u photosync-server.service -n 50"
    exit 1
fi

# Step 8: Display information
echo ""
echo -e "${BLUE}[8/8]${NC} Installation complete!"
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
echo -e "   • Port 3000 is ${GREEN}OPEN${NC} on local firewall"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT - Cloud Providers (AWS/Azure/GCP):${NC}"
echo -e "   If running on cloud server, you MUST manually open port 3000:"
echo ""
echo -e "   ${BLUE}AWS:${NC}"
echo -e "   1. Go to EC2 → Security Groups"
echo -e "   2. Edit Inbound Rules"
echo -e "   3. Add: Custom TCP, Port 3000, Source: 0.0.0.0/0"
echo ""
echo -e "   ${BLUE}Azure:${NC}"
echo -e "   1. Go to Network Security Groups"
echo -e "   2. Add Inbound Security Rule"
echo -e "   3. Port: 3000, Protocol: TCP"
echo ""
echo -e "   ${BLUE}Google Cloud:${NC}"
echo -e "   1. Go to VPC Network → Firewall"
echo -e "   2. Create Firewall Rule"
echo -e "   3. Ports: tcp:3000"
echo ""
echo -e "${BLUE}🔧 Service Management:${NC}"
echo -e "   • Status:  ${GREEN}sudo systemctl status photosync-server${NC}"
echo -e "   • Stop:    ${YELLOW}sudo systemctl stop photosync-server${NC}"
echo -e "   • Start:   ${GREEN}sudo systemctl start photosync-server${NC}"
echo -e "   • Restart: ${YELLOW}sudo systemctl restart photosync-server${NC}"
echo -e "   • Logs:    ${BLUE}sudo journalctl -u photosync-server -f${NC}"
echo ""
echo -e "${BLUE}🔄 Auto-Restart:${NC}"
echo -e "   • Service will ${GREEN}automatically restart${NC} if it crashes"
echo -e "   • Restart delay: 10 seconds"
echo -e "   • Starts on boot: ${GREEN}ENABLED${NC}"
echo ""
echo -e "${GREEN}✓${NC} Server is running at: ${GREEN}http://$LOCAL_IP:3000${NC}"
echo ""
