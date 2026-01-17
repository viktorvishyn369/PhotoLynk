#!/bin/bash
# PhotoLynk Real-Time Sync Watcher (Alternative to lsyncd)
# Uses inotifywait for real-time file change detection
# Run this on MAIN SERVER to continuously sync to Raspberry Pi
# Usage: sudo bash photolynk-sync-watcher.sh <raspberry-pi-ip> <ssh-key-path>

set -euo pipefail

BACKUP_HOST="${1:-}"
SSH_KEY="${2:-/root/privatesshkey.pem}"

if [ -z "$BACKUP_HOST" ]; then
  echo "Usage: $0 <raspberry-pi-ip> [ssh-key-path]"
  exit 1
fi

# Main server paths
CLOUD_DIR="/mnt/nvme-buffer/cloud"
CHUNKS_DIR="/data/chunks"
DB_DIR="/mnt/nvme-buffer/db"

# Backup server paths
BACKUP_CLOUD="/opt/photolynk/data/cloud"
BACKUP_CHUNKS="/opt/photolynk/data/chunks"
BACKUP_DB="/opt/photolynk/data/db"

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

sync_file() {
  local src="$1"
  local event="$2"
  
  # Determine destination based on source path
  local dest=""
  if [[ "$src" == "$CLOUD_DIR"* ]]; then
    local rel="${src#$CLOUD_DIR}"
    dest="root@$BACKUP_HOST:$BACKUP_CLOUD$rel"
  elif [[ "$src" == "$CHUNKS_DIR"* ]]; then
    local rel="${src#$CHUNKS_DIR}"
    dest="root@$BACKUP_HOST:$BACKUP_CHUNKS$rel"
  elif [[ "$src" == "$DB_DIR"* ]]; then
    local rel="${src#$DB_DIR}"
    dest="root@$BACKUP_HOST:$BACKUP_DB$rel"
  else
    return
  fi
  
  if [[ "$event" == *"DELETE"* ]]; then
    log "DELETE: $src"
    ssh $SSH_OPTS "root@$BACKUP_HOST" "rm -rf '${dest#*:}'" 2>/dev/null || true
  elif [ -f "$src" ]; then
    log "SYNC: $src → $dest"
    # Ensure parent directory exists
    local destdir=$(dirname "${dest#*:}")
    ssh $SSH_OPTS "root@$BACKUP_HOST" "mkdir -p '$destdir'" 2>/dev/null || true
    scp $SSH_OPTS "$src" "$dest" 2>/dev/null || log "WARN: Failed to sync $src"
  elif [ -d "$src" ]; then
    log "SYNC DIR: $src → $dest"
    ssh $SSH_OPTS "root@$BACKUP_HOST" "mkdir -p '${dest#*:}'" 2>/dev/null || true
  fi
}

# Initial full sync
log "Starting initial full sync..."
rsync -az $SSH_OPTS "$CLOUD_DIR/" "root@$BACKUP_HOST:$BACKUP_CLOUD/" 2>/dev/null || log "WARN: Cloud sync failed"
rsync -az $SSH_OPTS "$CHUNKS_DIR/" "root@$BACKUP_HOST:$BACKUP_CHUNKS/" 2>/dev/null || log "WARN: Chunks sync failed"
rsync -az $SSH_OPTS "$DB_DIR/" "root@$BACKUP_HOST:$BACKUP_DB/" 2>/dev/null || log "WARN: DB sync failed"
log "Initial sync complete"

# Watch for changes
log "Watching for file changes..."
inotifywait -m -r -e create,modify,delete,move \
  --format '%w%f %e' \
  "$CLOUD_DIR" "$CHUNKS_DIR" "$DB_DIR" 2>/dev/null | \
while read -r line; do
  file=$(echo "$line" | awk '{print $1}')
  event=$(echo "$line" | awk '{print $2}')
  sync_file "$file" "$event" &
done
