#!/bin/bash
# PhotoLynk Sync: Raspberry Pi Backup → Main Server (Recovery Mode)
# Run this on RASPBERRY PI when main server comes back online after outage
# This syncs any changes made during the outage back to main server
# Usage: sudo bash setup-backup-to-main.sh <main-server-ip> <ssh-key-path>

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

MAIN_HOST="${1:-}"
SSH_KEY="${2:-/root/privatesshkey.pem}"

if [ -z "$MAIN_HOST" ]; then
  echo -e "${RED}Usage: $0 <main-server-ip> [ssh-key-path]${NC}"
  echo -e "Example: $0 192.168.1.107 /root/privatesshkey.pem"
  exit 1
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   PhotoLynk Recovery Sync (Backup → Main)                  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"

# Verify SSH key exists
if [ ! -f "$SSH_KEY" ]; then
  echo -e "${RED}SSH key not found: $SSH_KEY${NC}"
  exit 1
fi

chmod 600 "$SSH_KEY"

# Test SSH connection
echo -e "${BLUE}Testing SSH connection to main server $MAIN_HOST...${NC}"
if ! ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o StrictHostKeyChecking=no "root@$MAIN_HOST" "echo 'SSH OK'" 2>/dev/null; then
  echo -e "${RED}Cannot connect to main server $MAIN_HOST${NC}"
  echo -e "${YELLOW}Main server may still be offline. Try again later.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Main server is online${NC}"

# Install rsync if not present
if ! command -v rsync >/dev/null 2>&1; then
  apt-get install -y rsync
fi

# Raspberry Pi paths
LOCAL_CLOUD="/opt/photolynk/data/cloud"
LOCAL_CHUNKS="/opt/photolynk/data/chunks"
LOCAL_DB="/opt/photolynk/data/db"

# Main server paths
MAIN_CLOUD="/mnt/nvme-buffer/cloud"
MAIN_CHUNKS="/data/chunks"
MAIN_DB="/mnt/nvme-buffer/db"

echo ""
echo -e "${YELLOW}⚠ This will sync changes from Raspberry Pi back to main server${NC}"
echo -e "${YELLOW}  Only newer files (by timestamp) will be copied${NC}"
echo ""

# Sync manifests (newer files only, using --update)
echo -e "${BLUE}[1/3] Syncing manifests (newer only)...${NC}"
rsync -avz --update --progress \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  "$LOCAL_CLOUD/users/" \
  "root@$MAIN_HOST:$MAIN_CLOUD/users/"
echo -e "${GREEN}✓ Manifests synced${NC}"

# Sync chunks (newer files only)
echo -e "${BLUE}[2/3] Syncing chunks (newer only)...${NC}"
rsync -avz --update --progress \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  "$LOCAL_CHUNKS/users/" \
  "root@$MAIN_HOST:$MAIN_CHUNKS/users/"
echo -e "${GREEN}✓ Chunks synced${NC}"

# Database sync is tricky - we need to merge, not overwrite
# For now, just copy if local is newer
echo -e "${BLUE}[3/3] Checking database...${NC}"
LOCAL_DB_TIME=$(stat -c %Y "$LOCAL_DB/backup.db" 2>/dev/null || echo 0)
REMOTE_DB_TIME=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "root@$MAIN_HOST" "stat -c %Y $MAIN_DB/backup.db 2>/dev/null || echo 0")

if [ "$LOCAL_DB_TIME" -gt "$REMOTE_DB_TIME" ]; then
  echo -e "${YELLOW}Local database is newer. Copying to main server...${NC}"
  # Backup remote DB first
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "root@$MAIN_HOST" \
    "cp $MAIN_DB/backup.db $MAIN_DB/backup.db.pre-recovery-$(date +%Y%m%d-%H%M%S)"
  # Copy local DB
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    "$LOCAL_DB/backup.db" "root@$MAIN_HOST:$MAIN_DB/backup.db"
  # Restart main server service
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "root@$MAIN_HOST" \
    "systemctl restart photolynk"
  echo -e "${GREEN}✓ Database synced and main server restarted${NC}"
else
  echo -e "${GREEN}✓ Main server database is current (no sync needed)${NC}"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Recovery Sync Complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo -e "  1. Stop cloudflared on Raspberry Pi: ${YELLOW}sudo systemctl stop cloudflared${NC}"
echo -e "  2. Verify main server is serving traffic"
echo -e "  3. Main server will resume syncing to Raspberry Pi automatically"
