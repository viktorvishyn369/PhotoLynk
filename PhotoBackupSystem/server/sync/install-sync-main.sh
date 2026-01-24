#!/bin/bash
# PhotoLynk Real-Time Sync - Install on MAIN SERVER
# Syncs to Raspberry Pi backup every 30 seconds + on file changes
# Usage: sudo bash install-sync-main.sh <raspberry-pi-ip>

set -euo pipefail

BACKUP_IP="${1:-}"
SSH_KEY="${2:-/root/privatesshkey.pem}"

if [ -z "$BACKUP_IP" ]; then
  echo "Usage: $0 <raspberry-pi-ip> [ssh-key-path]"
  echo "Example: $0 192.168.1.50 /root/privatesshkey.pem"
  exit 1
fi

echo "Installing PhotoLynk sync to backup server $BACKUP_IP..."

# Install rsync
apt-get install -y rsync inotify-tools 2>/dev/null || true

# Create sync script
mkdir -p /opt/photolynk/sync
cat > /opt/photolynk/sync/sync-to-backup.sh <<'SYNCEOF'
#!/bin/bash
# PhotoLynk Sync to Backup Server

BACKUP_IP="__BACKUP_IP__"
SSH_KEY="__SSH_KEY__"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"

# Main server paths
CLOUD_SRC="/mnt/nvme-buffer/cloud/"
CHUNKS_SRC="/data/chunks/"
DB_SRC="/mnt/nvme-buffer/db/"

# Backup paths
CLOUD_DST="root@$BACKUP_IP:/opt/photolynk/data/cloud/"
CHUNKS_DST="root@$BACKUP_IP:/opt/photolynk/data/chunks/"
DB_DST="root@$BACKUP_IP:/opt/photolynk/data/db/"

LOCKFILE="/tmp/photolynk-sync.lock"
LOGFILE="/var/log/photolynk-sync.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGFILE"
}

# Prevent concurrent runs
exec 200>"$LOCKFILE"
flock -n 200 || { log "Sync already running, skipping"; exit 0; }

# Check if backup is reachable
if ! ssh $SSH_OPTS "root@$BACKUP_IP" "echo ok" >/dev/null 2>&1; then
  log "WARN: Backup server $BACKUP_IP unreachable"
  exit 0
fi

log "Starting sync to $BACKUP_IP"

# Sync cloud (manifests) - fast, small files
rsync -az --delete -e "ssh $SSH_OPTS" "$CLOUD_SRC" "$CLOUD_DST" 2>/dev/null && \
  log "Cloud synced" || log "WARN: Cloud sync failed"

# Sync chunks - larger files, may take longer
rsync -az --delete -e "ssh $SSH_OPTS" "$CHUNKS_SRC" "$CHUNKS_DST" 2>/dev/null && \
  log "Chunks synced" || log "WARN: Chunks sync failed"

# Sync database
rsync -az -e "ssh $SSH_OPTS" "$DB_SRC" "$DB_DST" 2>/dev/null && \
  log "DB synced" || log "WARN: DB sync failed"

log "Sync complete"
SYNCEOF

# Replace placeholders
sed -i "s|__BACKUP_IP__|$BACKUP_IP|g" /opt/photolynk/sync/sync-to-backup.sh
sed -i "s|__SSH_KEY__|$SSH_KEY|g" /opt/photolynk/sync/sync-to-backup.sh
chmod +x /opt/photolynk/sync/sync-to-backup.sh

# Create systemd timer for periodic sync (every 30 seconds)
cat > /etc/systemd/system/photolynk-sync.service <<EOF
[Unit]
Description=PhotoLynk Sync to Backup Server
After=network.target

[Service]
Type=oneshot
ExecStart=/opt/photolynk/sync/sync-to-backup.sh
TimeoutSec=300
EOF

cat > /etc/systemd/system/photolynk-sync.timer <<EOF
[Unit]
Description=PhotoLynk Sync Timer (every 30s)

[Timer]
OnBootSec=60
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

# Create file watcher service for instant sync on changes
cat > /etc/systemd/system/photolynk-sync-watch.service <<EOF
[Unit]
Description=PhotoLynk Real-Time File Watcher
After=network.target

[Service]
Type=simple
ExecStart=/opt/photolynk/sync/watch-and-sync.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create watcher script
cat > /opt/photolynk/sync/watch-and-sync.sh <<'WATCHEOF'
#!/bin/bash
# Watch for file changes and trigger sync

CLOUD_DIR="/mnt/nvme-buffer/cloud"
CHUNKS_DIR="/data/chunks"
DB_DIR="/mnt/nvme-buffer/db"

while true; do
  inotifywait -r -e create,modify,delete,move \
    --timeout 30 \
    "$CLOUD_DIR" "$CHUNKS_DIR" "$DB_DIR" 2>/dev/null
  
  # Trigger sync after any change (or timeout)
  /opt/photolynk/sync/sync-to-backup.sh &
  
  # Small delay to batch rapid changes
  sleep 2
done
WATCHEOF
chmod +x /opt/photolynk/sync/watch-and-sync.sh

# Enable and start services
systemctl daemon-reload
systemctl enable photolynk-sync.timer
systemctl start photolynk-sync.timer
systemctl enable photolynk-sync-watch
systemctl start photolynk-sync-watch

# Run initial sync
echo "Running initial sync..."
/opt/photolynk/sync/sync-to-backup.sh

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "✓ PhotoLynk Sync Installed (Main → Backup)"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Syncing to: $BACKUP_IP"
echo "  - Every 30 seconds (timer)"
echo "  - Instantly on file changes (watcher)"
echo ""
echo "Commands:"
echo "  Status:     sudo systemctl status photolynk-sync-watch"
echo "  Timer:      sudo systemctl status photolynk-sync.timer"
echo "  Logs:       sudo tail -f /var/log/photolynk-sync.log"
echo "  Manual:     sudo /opt/photolynk/sync/sync-to-backup.sh"
