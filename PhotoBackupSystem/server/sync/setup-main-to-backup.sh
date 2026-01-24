#!/bin/bash
# PhotoLynk Real-Time Sync: Main Server → Raspberry Pi Backup
# Run this on the MAIN SERVER to continuously sync to Raspberry Pi
# Usage: sudo bash setup-main-to-backup.sh <raspberry-pi-ip> <ssh-key-path>

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

BACKUP_HOST="${1:-}"
SSH_KEY="${2:-/root/privatesshkey.pem}"

if [ -z "$BACKUP_HOST" ]; then
  echo -e "${RED}Usage: $0 <raspberry-pi-ip> [ssh-key-path]${NC}"
  echo -e "Example: $0 192.168.1.50 /root/privatesshkey.pem"
  exit 1
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   PhotoLynk Real-Time Sync Setup (Main → Backup)          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"

# Install lsyncd if not present
if ! command -v lsyncd >/dev/null 2>&1; then
  echo -e "${YELLOW}Installing lsyncd...${NC}"
  apt-get update -y
  apt-get install -y lsyncd rsync
fi

# Install rsync if not present
if ! command -v rsync >/dev/null 2>&1; then
  apt-get install -y rsync
fi

# Verify SSH key exists
if [ ! -f "$SSH_KEY" ]; then
  echo -e "${RED}SSH key not found: $SSH_KEY${NC}"
  exit 1
fi

chmod 600 "$SSH_KEY"

# Test SSH connection
echo -e "${BLUE}Testing SSH connection to $BACKUP_HOST...${NC}"
if ! ssh -i "$SSH_KEY" -o ConnectTimeout=5 -o StrictHostKeyChecking=no "root@$BACKUP_HOST" "echo 'SSH OK'" 2>/dev/null; then
  echo -e "${RED}Cannot connect to $BACKUP_HOST via SSH${NC}"
  exit 1
fi
echo -e "${GREEN}✓ SSH connection OK${NC}"

# Ensure rsync is installed on backup server
echo -e "${BLUE}Ensuring rsync is installed on backup server...${NC}"
ssh -i "$SSH_KEY" "root@$BACKUP_HOST" "command -v rsync >/dev/null || apt-get install -y rsync" 2>/dev/null
echo -e "${GREEN}✓ rsync available on backup${NC}"

# Create lsyncd config directory
mkdir -p /etc/lsyncd
mkdir -p /var/log/lsyncd

# Main server paths (NVMe + RAID)
CLOUD_DIR="/mnt/nvme-buffer/cloud"
CHUNKS_DIR="/data/chunks"
DB_DIR="/mnt/nvme-buffer/db"

# Backup server paths
BACKUP_CLOUD="/opt/photolynk/data/cloud"
BACKUP_CHUNKS="/opt/photolynk/data/chunks"
BACKUP_DB="/opt/photolynk/data/db"

# Create lsyncd configuration
cat > /etc/lsyncd/lsyncd.conf.lua <<EOF
----
-- PhotoLynk Real-Time Sync Configuration
-- Main Server → Raspberry Pi Backup
-- Syncs: manifests, chunks, database
----

settings {
    logfile = "/var/log/lsyncd/lsyncd.log",
    statusFile = "/var/log/lsyncd/lsyncd.status",
    statusInterval = 10,
    maxProcesses = 4,
    maxDelays = 1,
}

-- SSH options
local sshOpts = "-i ${SSH_KEY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

-- Sync cloud directory (manifests)
sync {
    default.rsync,
    source = "${CLOUD_DIR}/",
    target = "root@${BACKUP_HOST}:${BACKUP_CLOUD}/",
    delay = 1,
    rsync = {
        binary = "/usr/bin/rsync",
        archive = true,
        compress = true,
        verbose = true,
        rsh = "/usr/bin/ssh " .. sshOpts,
        _extra = {"--delete-after", "--partial", "--timeout=30"}
    }
}

-- Sync chunks directory
sync {
    default.rsync,
    source = "${CHUNKS_DIR}/",
    target = "root@${BACKUP_HOST}:${BACKUP_CHUNKS}/",
    delay = 2,
    rsync = {
        binary = "/usr/bin/rsync",
        archive = true,
        compress = true,
        verbose = true,
        rsh = "/usr/bin/ssh " .. sshOpts,
        _extra = {"--delete-after", "--partial", "--timeout=60"}
    }
}

-- Sync database (with special handling - copy only, no delete)
sync {
    default.rsync,
    source = "${DB_DIR}/",
    target = "root@${BACKUP_HOST}:${BACKUP_DB}/",
    delay = 5,
    rsync = {
        binary = "/usr/bin/rsync",
        archive = true,
        compress = true,
        verbose = true,
        rsh = "/usr/bin/ssh " .. sshOpts,
        _extra = {"--partial", "--timeout=30"}
    }
}
EOF

# Create systemd service for lsyncd
cat > /etc/systemd/system/photolynk-sync.service <<EOF
[Unit]
Description=PhotoLynk Real-Time Sync to Backup Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/lsyncd -nodaemon /etc/lsyncd/lsyncd.conf.lua
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Create sync status script
cat > /root/ADMIN_PHOTOLYNK/sync-status.sh <<'STATUSEOF'
#!/bin/bash
echo "╔════════════════════════════════════════════════════════════╗"
echo "║   PhotoLynk Sync Status                                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Service Status:"
systemctl status photolynk-sync --no-pager -l | head -n 10
echo ""
echo "Recent Sync Activity:"
tail -n 20 /var/log/lsyncd/lsyncd.log 2>/dev/null || echo "No log yet"
echo ""
echo "Sync Status File:"
cat /var/log/lsyncd/lsyncd.status 2>/dev/null || echo "No status yet"
STATUSEOF
chmod +x /root/ADMIN_PHOTOLYNK/sync-status.sh

# Enable and start the sync service
systemctl daemon-reload
systemctl enable photolynk-sync
systemctl restart photolynk-sync

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Real-Time Sync Configured (Main → Backup)${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Syncing:${NC}"
echo -e "  ${CLOUD_DIR} → ${BACKUP_HOST}:${BACKUP_CLOUD}"
echo -e "  ${CHUNKS_DIR} → ${BACKUP_HOST}:${BACKUP_CHUNKS}"
echo -e "  ${DB_DIR} → ${BACKUP_HOST}:${BACKUP_DB}"
echo ""
echo -e "${BLUE}Commands:${NC}"
echo -e "  Status:  ${YELLOW}sudo systemctl status photolynk-sync${NC}"
echo -e "  Logs:    ${YELLOW}sudo tail -f /var/log/lsyncd/lsyncd.log${NC}"
echo -e "  Report:  ${YELLOW}sudo /root/ADMIN_PHOTOLYNK/sync-status.sh${NC}"
echo ""
echo -e "${GREEN}Sync is now running continuously in real-time!${NC}"
