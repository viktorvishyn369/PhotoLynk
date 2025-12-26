#!/bin/bash
# PhotoLynk Server - Headless Server Installer for Linux
# For servers without GUI (Ubuntu Server, VPS, cloud instances)
# Usage: curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/PhotoLynk/main/install-server.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      PhotoLynk Server - Headless Installer        ║${NC}"
echo -e "${BLUE}║           For Linux Servers (No GUI)               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running as root or with sudo
if [ "$EUID" -eq 0 ]; then 
    SUDO=""
else
    SUDO="sudo"
fi

# Determine which user should run the systemd service.
# When script is executed with sudo, $USER may be "root".
SERVICE_USER="${SUDO_USER:-${USER:-$(whoami)}}"

# Ensure Git is installed (required to clone/pull)
echo ""
echo -e "${BLUE}[1/7]${NC} Checking Git..."
if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  Git not found. Installing..."
    if command -v apt-get &> /dev/null; then
        $SUDO apt-get update -y
        $SUDO apt-get install -y git
    elif command -v dnf &> /dev/null; then
        $SUDO dnf install -y git
    elif command -v yum &> /dev/null; then
        $SUDO yum install -y git
    elif command -v pacman &> /dev/null; then
        $SUDO pacman -S --noconfirm git
    else
        echo -e "${RED}✗${NC} Could not install Git automatically"
        echo -e "${YELLOW}⚠${NC}  Please install Git manually, then rerun this script."
        exit 1
    fi
    echo -e "${GREEN}✓${NC} Git installed"
else
    echo -e "${GREEN}✓${NC} Git found: $(git --version)"
fi

# Check if Node.js is installed
echo ""
echo -e "${BLUE}[2/7]${NC} Checking Node.js..."
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
        $SUDO pacman -S --noconfirm nodejs npm
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
echo -e "${BLUE}[3/7]${NC} Downloading PhotoLynk..."

DEFAULT_INSTALL_DIR="/opt/photolynk"
LEGACY_INSTALL_DIR="/opt/photosync"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"

SERVICE_NAME="photolynk"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠${NC}  Existing install directory exists, updating..."
    cd "$INSTALL_DIR"
    REPO_URL="https://github.com/viktorvishyn369/PhotoLynk.git"
    if [ -n "${PHOTOLYNK_GITHUB_TOKEN:-}" ]; then
        REPO_URL="https://x-access-token:${PHOTOLYNK_GITHUB_TOKEN}@github.com/viktorvishyn369/PhotoLynk.git"
    elif [ -n "${GITHUB_TOKEN:-}" ]; then
        REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/viktorvishyn369/PhotoLynk.git"
    fi
    $SUDO git remote set-url origin "$REPO_URL" >/dev/null 2>&1 || true
    GIT_TERMINAL_PROMPT=0 $SUDO git pull
else
    REPO_URL="https://github.com/viktorvishyn369/PhotoLynk.git"
    if [ -n "${PHOTOLYNK_GITHUB_TOKEN:-}" ]; then
        REPO_URL="https://x-access-token:${PHOTOLYNK_GITHUB_TOKEN}@github.com/viktorvishyn369/PhotoLynk.git"
    elif [ -n "${GITHUB_TOKEN:-}" ]; then
        REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/viktorvishyn369/PhotoLynk.git"
    fi
    GIT_TERMINAL_PROMPT=0 $SUDO git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
echo -e "${GREEN}✓${NC} Downloaded to $INSTALL_DIR"

# Install server dependencies
echo ""
echo -e "${BLUE}[4/7]${NC} Installing server dependencies..."
cd server
$SUDO npm install --production
echo -e "${GREEN}✓${NC} Server dependencies installed"

# Create systemd service
echo ""
echo -e "${BLUE}[5/7]${NC} Creating systemd service..."

UPLOAD_DIR="$INSTALL_DIR/server/uploads"
DB_PATH="$INSTALL_DIR/server/backup.db"
if [ -d "/data/media" ]; then
    UPLOAD_DIR="/data/media"
fi
if [ -d "/data/db" ]; then
    DB_PATH="/data/db/backup.db"
fi

$SUDO mkdir -p "$UPLOAD_DIR" "$(dirname "$DB_PATH")"
$SUDO chown -R "$SERVICE_USER":"$SERVICE_USER" "$UPLOAD_DIR" "$(dirname "$DB_PATH")" 2>/dev/null || true

$SUDO tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=PhotoLynk Server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/server
Environment="UPLOAD_DIR=$UPLOAD_DIR"
Environment="DB_PATH=$DB_PATH"
ExecStart=$(which node) server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓${NC} Systemd service created"

# Enable and start service
echo ""
echo -e "${BLUE}[6/7]${NC} Starting PhotoLynk service..."
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"
echo -e "${GREEN}✓${NC} Service started and enabled"

# Configure firewall
echo ""
echo -e "${BLUE}[7/8]${NC} Configuring firewall..."
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

# Optional HTTPS setup with Nginx + Certbot
echo ""
echo -e "${BLUE}[8/8]${NC} Optional: Set up HTTPS (Nginx + Certbot)"
read -p "Do you want to configure HTTPS with your domain now? (y/N): " ENABLE_HTTPS
ENABLE_HTTPS=${ENABLE_HTTPS,,}
PROXY_DOMAIN=""
if [[ "$ENABLE_HTTPS" == "y" || "$ENABLE_HTTPS" == "yes" ]]; then
    read -p "Enter your domain (e.g., remote.example.com): " PROXY_DOMAIN
    if [ -z "$PROXY_DOMAIN" ]; then
        echo -e "${YELLOW}⚠${NC} No domain provided. Skipping HTTPS setup."
    else
        read -p "Enter email for Certbot/Let's Encrypt (required): " CERTBOT_EMAIL
        if [ -z "$CERTBOT_EMAIL" ]; then
            echo -e "${YELLOW}⚠${NC} No email provided. Skipping HTTPS setup."
        else
            echo -e "${BLUE}Installing Nginx and Certbot...${NC}"
            if command -v apt-get &> /dev/null; then
                $SUDO apt-get update -y
                $SUDO apt-get install -y nginx certbot python3-certbot-nginx
            else
                echo -e "${YELLOW}⚠${NC} Non-apt system detected. Please install nginx + certbot manually."
                PROXY_DOMAIN=""
            fi
            if [ -n "$PROXY_DOMAIN" ]; then
                echo -e "${YELLOW}About to create/overwrite Nginx site: /etc/nginx/sites-available/photolynk${NC}"
                read -p "Proceed with writing Nginx config for $PROXY_DOMAIN? (y/N): " CONFIRM_NGINX
                CONFIRM_NGINX=${CONFIRM_NGINX,,}
                if [[ "$CONFIRM_NGINX" == "y" || "$CONFIRM_NGINX" == "yes" ]]; then
                    echo -e "${BLUE}Configuring Nginx reverse proxy for $PROXY_DOMAIN ...${NC}"
                    $SUDO tee /etc/nginx/sites-available/photolynk > /dev/null <<EOF
server {
  listen 80;
  server_name $PROXY_DOMAIN;
  client_max_body_size 2000M;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
                    $SUDO ln -sf /etc/nginx/sites-available/photolynk /etc/nginx/sites-enabled/photolynk
                    $SUDO nginx -t
                    $SUDO systemctl reload nginx
                else
                    echo -e "${YELLOW}⚠${NC} Skipping Nginx config write. HTTPS setup aborted."
                    PROXY_DOMAIN=""
                fi
                if [ -n "$PROXY_DOMAIN" ]; then
                    echo -e "${YELLOW}About to request TLS certificate for $PROXY_DOMAIN with email $CERTBOT_EMAIL${NC}"
                    read -p "Proceed with Certbot now? (y/N): " CONFIRM_CERTBOT
                    CONFIRM_CERTBOT=${CONFIRM_CERTBOT,,}
                    if [[ "$CONFIRM_CERTBOT" == "y" || "$CONFIRM_CERTBOT" == "yes" ]]; then
                        echo -e "${BLUE}Running Certbot for $PROXY_DOMAIN ...${NC}"
                        $SUDO certbot --nginx -d "$PROXY_DOMAIN" -m "$CERTBOT_EMAIL" --agree-tos --non-interactive || true
                        echo -e "${GREEN}✓${NC} HTTPS setup attempt completed. If Certbot failed, check DNS (A record to this server) and re-run later."
                    else
                        echo -e "${YELLOW}⚠${NC} Certbot skipped. HTTPS not enabled."
                        PROXY_DOMAIN=""
                    fi
                fi
            fi
        fi
    fi
fi

# Get server IP
SERVER_IP=$(hostname -I | awk '{print $1}')

# Determine the best URL to display
if [ -n "$PROXY_DOMAIN" ]; then
    SERVER_URL="https://$PROXY_DOMAIN"
else
    SERVER_URL="http://${SERVER_IP}:3000"
fi

# Display success message
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ PhotoLynk Server installed and running!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Server Information:${NC}"
echo -e "  • Status: ${GREEN}Running${NC}"
echo -e "  • URL: ${YELLOW}${SERVER_URL}${NC}"
echo -e "  • Port: ${YELLOW}3000${NC}"
echo ""
echo -e "${BLUE}File Storage:${NC}"
echo -e "  • Location: ${YELLOW}$INSTALL_DIR/server/uploads/${NC}"
echo -e "  • Structure: ${YELLOW}uploads/{device-uuid}/${NC}"
echo -e "  • Each device gets its own folder"
echo ""
echo -e "${BLUE}Service Management:${NC}"
echo -e "  • Status:  ${YELLOW}sudo systemctl status ${SERVICE_NAME}${NC}"
echo -e "  • Stop:    ${YELLOW}sudo systemctl stop ${SERVICE_NAME}${NC}"
echo -e "  • Start:   ${YELLOW}sudo systemctl start ${SERVICE_NAME}${NC}"
echo -e "  • Restart: ${YELLOW}sudo systemctl restart ${SERVICE_NAME}${NC}"
echo -e "  • Logs:    ${YELLOW}sudo journalctl -u ${SERVICE_NAME} -f${NC}"
echo ""
echo -e "${BLUE}Mobile App Setup:${NC}"
echo -e "  1. Download PhotoLynk APK from GitHub Releases"
echo -e "  2. Install on your Android device"
echo -e "  3. Enter server URL: ${YELLOW}http://${SERVER_IP}:3000${NC}"
echo -e "  4. Register and start backing up!"
echo ""
echo -e "${YELLOW}Note:${NC} If connecting from outside your network, use your public IP"
echo -e "${YELLOW}Note:${NC} You may need to configure port forwarding on your router"
echo ""
echo -e "${GREEN}Installation complete!${NC} 🎉"
echo ""
