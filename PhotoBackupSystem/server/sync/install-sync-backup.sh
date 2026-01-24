#!/bin/bash
# PhotoLynk Recovery Sync - Install on RASPBERRY PI BACKUP
# Run this when main server comes back online after outage
# Usage: sudo bash install-sync-backup.sh <main-server-ip>

set -euo pipefail

MAIN_IP="${1:-192.168.1.107}"
SSH_KEY="${2:-/root/privatesshkey.pem}"

echo "PhotoLynk Recovery Sync (Backup → Main)"
echo "Main server: $MAIN_IP"
echo ""

# Install rsync
apt-get install -y rsync 2>/dev/null || true

# Verify SSH key
if [ ! -f "$SSH_KEY" ]; then
  echo "ERROR: SSH key not found: $SSH_KEY"
  exit 1
fi
chmod 600 "$SSH_KEY"

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

# Test connection
echo "Testing connection to main server..."
if ! ssh $SSH_OPTS "root@$MAIN_IP" "echo ok" >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to main server $MAIN_IP"
  echo "Main server may still be offline."
  exit 1
fi
echo "✓ Main server is online"

# Local paths (Raspberry Pi)
LOCAL_CLOUD="/opt/photolynk/data/cloud/"
LOCAL_CHUNKS="/opt/photolynk/data/chunks/"
LOCAL_DB="/opt/photolynk/data/db/"

# Main server paths
MAIN_CLOUD="/mnt/nvme-buffer/cloud/"
MAIN_CHUNKS="/data/chunks/"
MAIN_DB="/mnt/nvme-buffer/db/"

echo ""
echo "Syncing newer files from Raspberry Pi → Main Server..."
echo "(Only files modified during outage will be copied)"
echo ""

# Sync manifests (--update = only newer files)
echo "[1/3] Syncing manifests..."
rsync -avz --update -e "ssh $SSH_OPTS" \
  "$LOCAL_CLOUD" "root@$MAIN_IP:$MAIN_CLOUD"

# Sync chunks
echo "[2/3] Syncing chunks..."
rsync -avz --update -e "ssh $SSH_OPTS" \
  "$LOCAL_CHUNKS" "root@$MAIN_IP:$MAIN_CHUNKS"

# Sync database (check timestamp first)
echo "[3/3] Checking database..."
LOCAL_TIME=$(stat -c %Y "${LOCAL_DB}backup.db" 2>/dev/null || echo 0)
REMOTE_TIME=$(ssh $SSH_OPTS "root@$MAIN_IP" "stat -c %Y ${MAIN_DB}backup.db 2>/dev/null || echo 0")

if [ "$LOCAL_TIME" -gt "$REMOTE_TIME" ]; then
  echo "Local DB is newer, syncing..."
  # Backup remote DB first
  ssh $SSH_OPTS "root@$MAIN_IP" \
    "cp ${MAIN_DB}backup.db ${MAIN_DB}backup.db.bak-$(date +%Y%m%d%H%M%S)"
  rsync -avz -e "ssh $SSH_OPTS" \
    "$LOCAL_DB" "root@$MAIN_IP:$MAIN_DB"
  # Restart main server
  ssh $SSH_OPTS "root@$MAIN_IP" "systemctl restart photolynk"
  echo "✓ Database synced, main server restarted"
else
  echo "✓ Main server DB is current"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "✓ Recovery Sync Complete"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Stop cloudflared: sudo systemctl stop cloudflared"
echo "  2. Main server will resume syncing to Raspberry Pi"
