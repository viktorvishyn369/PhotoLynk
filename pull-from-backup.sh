#!/bin/bash
# PhotoLynk — Pull missing data from Raspberry Pi backup server to main
# Usage: sudo bash pull-from-backup.sh
#
# This script:
#   1. Stops photolynk + all background timers on BOTH main and Pi
#   2. Backs up both main DBs (+ WAL/SHM) to /root/ before touching anything
#   3. Replaces main DBs with Pi's SQLite .backup snapshots (Pi is authoritative
#      after serving during main's downtime)
#   4. Pulls missing files from Pi (--ignore-existing: never overwrites existing)
#   5. Restarts all services on both sides
#
# Run manually — not automated.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date -u '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date -u '+%H:%M:%S')] ⚠ $*${NC}"; }
err() { echo -e "${RED}[$(date -u '+%H:%M:%S')] ✗ $*${NC}"; }
ok() { echo -e "${GREEN}[$(date -u '+%H:%M:%S')] ✓ $*${NC}"; }

# ── Configuration ──────────────────────────────────────────────────────
PI_IP="${PI_IP:-192.168.1.106}"
SSH_KEY="${SSH_KEY:-/root/privatesshkey.pem}"
SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR"

# Main server paths (NVMe + RAID split storage)
MAIN_NVME="/mnt/nvme-buffer"
MAIN_RAID="/data"
MAIN_DB="${MAIN_NVME}/db/backup.db"
MAIN_NFT_DB="${MAIN_NVME}/db/nft-service.db"
MAIN_CLOUD="${MAIN_NVME}/cloud"
MAIN_CHUNKS="${MAIN_RAID}/chunks"
MAIN_UPLOADS="${MAIN_NVME}/uploads"
MAIN_UPTIME="${MAIN_NVME}/uptime.json"

# Pi backup paths (single storage at /opt/photolynk/data)
PI_DATA="/opt/photolynk/data"
PI_DB="${PI_DATA}/db/backup.db"
PI_NFT_DB="${PI_DATA}/db/nft-service.db"
PI_CLOUD="${PI_DATA}/cloud"
PI_CHUNKS="${PI_DATA}/chunks"
PI_UPLOADS="${PI_DATA}/uploads"
PI_UPTIME="${PI_DATA}/uptime.json"

# Backup destination
BACKUP_TS=$(date -u '+%Y%m%d-%H%M%S')
DB_BACKUP_DIR="/root/db-backup-before-pull-${BACKUP_TS}"

SERVICE_NAME="photolynk"

# ── Preflight checks ──────────────────────────────────────────────────
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  err "This script must be run as root (sudo)"
  exit 1
fi

if [ ! -f "$SSH_KEY" ]; then
  err "SSH key not found: $SSH_KEY"
  err "Set SSH_KEY=/path/to/key or place it at /root/privatesshkey.pem"
  exit 1
fi

log "Checking Pi ($PI_IP) is reachable..."
if ! ssh $SSH_OPTS "root@${PI_IP}" "echo ok" >/dev/null 2>&1; then
  err "Cannot SSH to Pi at root@${PI_IP}"
  err "Check connectivity and SSH key."
  exit 1
fi
ok "Pi is reachable"

# Show what Pi has
log "Checking Pi data sizes..."
ssh $SSH_OPTS "root@${PI_IP}" "
  echo '  DB:       ' \$(ls -lh ${PI_DB} 2>/dev/null | awk '{print \$5}' || echo 'MISSING')
  echo '  NFT DB:   ' \$(ls -lh ${PI_NFT_DB} 2>/dev/null | awk '{print \$5}' || echo 'MISSING')
  echo '  Cloud:    ' \$(du -sh ${PI_CLOUD} 2>/dev/null | awk '{print \$1}' || echo 'MISSING')
  echo '  Chunks:   ' \$(du -sh ${PI_CHUNKS} 2>/dev/null | awk '{print \$1}' || echo 'MISSING')
  echo '  Uploads:  ' \$(du -sh ${PI_UPLOADS} 2>/dev/null | awk '{print \$1}' || echo 'MISSING')
" 2>/dev/null || warn "Could not check Pi data sizes"

echo ""
echo -e "${YELLOW}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  This will STOP all PhotoLynk services on BOTH servers  ║${NC}"
echo -e "${YELLOW}║  and pull data + DBs from the Pi backup server.         ║${NC}"
echo -e "${YELLOW}║                                                         ║${NC}"
echo -e "${YELLOW}║  DATABASES: Replaced with Pi's (Pi is authoritative     ║${NC}"
echo -e "${YELLOW}║             after serving during main's downtime).       ║${NC}"
echo -e "${YELLOW}║             Main's old DBs backed up to /root/ first.   ║${NC}"
echo -e "${YELLOW}║  FILES:     Only missing files pulled (existing kept).  ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -n "Continue? [y/N] "
read -r CONFIRM < /dev/tty 2>/dev/null || CONFIRM=""
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  log "Aborted."
  exit 0
fi

# ── Step 1: Stop all services ─────────────────────────────────────────
log ""
log "═══ Step 1: Stopping services on main ═══"
systemctl stop ${SERVICE_NAME} 2>/dev/null || true
systemctl stop ${SERVICE_NAME}-capacity.timer ${SERVICE_NAME}-capacity.service 2>/dev/null || true
systemctl stop ${SERVICE_NAME}-sweep-expired.timer ${SERVICE_NAME}-sweep-expired.service 2>/dev/null || true
systemctl stop ${SERVICE_NAME}-reconcile-cloud-usage.timer ${SERVICE_NAME}-reconcile-cloud-usage.service 2>/dev/null || true
ok "All services stopped on main"

# Also stop Pi services to get clean DB snapshots
log "Stopping services on Pi..."
ssh $SSH_OPTS "root@${PI_IP}" "
  systemctl stop ${SERVICE_NAME} 2>/dev/null || true
  systemctl stop ${SERVICE_NAME}-capacity.timer ${SERVICE_NAME}-capacity.service 2>/dev/null || true
  systemctl stop ${SERVICE_NAME}-sweep-expired.timer ${SERVICE_NAME}-sweep-expired.service 2>/dev/null || true
  systemctl stop ${SERVICE_NAME}-reconcile-cloud-usage.timer ${SERVICE_NAME}-reconcile-cloud-usage.service 2>/dev/null || true
" 2>/dev/null || warn "Could not stop Pi services"
ok "Pi services stopped"

# ── Step 2: Backup main DBs to /root/ ─────────────────────────────────
log ""
log "═══ Step 2: Backing up main DBs to ${DB_BACKUP_DIR}/ ═══"
mkdir -p "$DB_BACKUP_DIR"

if [ -f "$MAIN_DB" ]; then
  cp -v "$MAIN_DB" "${DB_BACKUP_DIR}/backup.db"
  cp -v "${MAIN_DB}-wal" "${DB_BACKUP_DIR}/backup.db-wal" 2>/dev/null || true
  cp -v "${MAIN_DB}-shm" "${DB_BACKUP_DIR}/backup.db-shm" 2>/dev/null || true
  ok "backup.db backed up ($(ls -lh "$MAIN_DB" | awk '{print $5}'))"
else
  warn "backup.db does not exist on main"
fi

if [ -f "$MAIN_NFT_DB" ]; then
  cp -v "$MAIN_NFT_DB" "${DB_BACKUP_DIR}/nft-service.db"
  cp -v "${MAIN_NFT_DB}-wal" "${DB_BACKUP_DIR}/nft-service.db-wal" 2>/dev/null || true
  cp -v "${MAIN_NFT_DB}-shm" "${DB_BACKUP_DIR}/nft-service.db-shm" 2>/dev/null || true
  ok "nft-service.db backed up ($(ls -lh "$MAIN_NFT_DB" | awk '{print $5}'))"
else
  warn "nft-service.db does not exist on main"
fi

ok "DB backups saved to ${DB_BACKUP_DIR}/"
ls -lh "${DB_BACKUP_DIR}/"

# ── Step 3: Create clean DB snapshots on Pi ────────────────────────────
log ""
log "═══ Step 3: Creating clean DB snapshots on Pi ═══"

# backup.db snapshot
PI_HAS_DB=0
if ssh $SSH_OPTS "root@${PI_IP}" "test -s '${PI_DB}'" 2>/dev/null; then
  ssh $SSH_OPTS "root@${PI_IP}" "sqlite3 '${PI_DB}' \".backup '/tmp/backup.db.pull-snapshot\"" 2>/dev/null
  PI_DB_QC=$(ssh $SSH_OPTS "root@${PI_IP}" "sqlite3 '/tmp/backup.db.pull-snapshot' 'PRAGMA quick_check;' 2>/dev/null | tail -n 1" 2>/dev/null || true)
  if [ "$PI_DB_QC" = "ok" ]; then
    PI_HAS_DB=1
    ok "Pi backup.db snapshot created (integrity ok)"
  else
    warn "Pi backup.db snapshot failed integrity check: $PI_DB_QC"
  fi
else
  warn "Pi has no backup.db"
fi

# nft-service.db snapshot
PI_HAS_NFT_DB=0
if ssh $SSH_OPTS "root@${PI_IP}" "test -s '${PI_NFT_DB}'" 2>/dev/null; then
  ssh $SSH_OPTS "root@${PI_IP}" "sqlite3 '${PI_NFT_DB}' \".backup '/tmp/nft-service.db.pull-snapshot\"" 2>/dev/null
  PI_NFT_QC=$(ssh $SSH_OPTS "root@${PI_IP}" "sqlite3 '/tmp/nft-service.db.pull-snapshot' 'PRAGMA quick_check;' 2>/dev/null | tail -n 1" 2>/dev/null || true)
  if [ "$PI_NFT_QC" = "ok" ]; then
    PI_HAS_NFT_DB=1
    ok "Pi nft-service.db snapshot created (integrity ok)"
  else
    warn "Pi nft-service.db snapshot failed integrity check: $PI_NFT_QC"
  fi
else
  warn "Pi has no nft-service.db"
fi

# ── Step 4: Replace main DBs with Pi's (Pi is authoritative) ──────────
log ""
log "═══ Step 4: Replacing main DBs with Pi's snapshots ═══"
log "  (Pi served users during main downtime — its DB has the latest state)"
log "  (Main's old DBs are safe in ${DB_BACKUP_DIR}/)"

if [ "$PI_HAS_DB" -eq 1 ]; then
  log "Pulling backup.db from Pi..."
  mkdir -p "$(dirname "$MAIN_DB")"
  RSYNC_RSH="ssh $SSH_OPTS" rsync -avz "root@${PI_IP}:/tmp/backup.db.pull-snapshot" "${MAIN_DB}"
  rm -f "${MAIN_DB}-wal" "${MAIN_DB}-shm" 2>/dev/null || true
  ok "backup.db replaced with Pi's snapshot ($(ls -lh "$MAIN_DB" | awk '{print $5}'))"
else
  warn "Pi has no valid backup.db — main's existing DB kept"
fi

if [ "$PI_HAS_NFT_DB" -eq 1 ]; then
  log "Pulling nft-service.db from Pi..."
  mkdir -p "$(dirname "$MAIN_NFT_DB")"
  RSYNC_RSH="ssh $SSH_OPTS" rsync -avz "root@${PI_IP}:/tmp/nft-service.db.pull-snapshot" "${MAIN_NFT_DB}"
  rm -f "${MAIN_NFT_DB}-wal" "${MAIN_NFT_DB}-shm" 2>/dev/null || true
  ok "nft-service.db replaced with Pi's snapshot ($(ls -lh "$MAIN_NFT_DB" | awk '{print $5}'))"
else
  warn "Pi has no valid nft-service.db — main's existing DB kept"
fi

# Clean up Pi snapshots and clear the "served traffic" flag so periodic sync resumes
ssh $SSH_OPTS "root@${PI_IP}" "rm -f /tmp/backup.db.pull-snapshot /tmp/nft-service.db.pull-snapshot /tmp/photolynk_pi_served_traffic" 2>/dev/null || true
ok "Cleared Pi sync-block flag — periodic sync from main will resume"

# ── Step 5: Pull missing files (--ignore-existing) ────────────────────
log ""
log "═══ Step 5: Pulling missing files from Pi (skip existing) ═══"

RSYNC_BASE="rsync -avz --ignore-existing --exclude='*.tmp' --exclude='*.lock'"

# Cloud users (manifests, raw-meta) → NVMe
log "  Cloud/users (manifests, raw-meta)..."
mkdir -p "${MAIN_CLOUD}/users"
RSYNC_RSH="ssh $SSH_OPTS" $RSYNC_BASE \
  "root@${PI_IP}:${PI_CLOUD}/users/" "${MAIN_CLOUD}/users/"
ok "  Cloud/users synced"

# Cloud/exif → NVMe
log "  Cloud/exif..."
mkdir -p "${MAIN_CLOUD}/exif"
RSYNC_RSH="ssh $SSH_OPTS" $RSYNC_BASE \
  "root@${PI_IP}:${PI_CLOUD}/exif/" "${MAIN_CLOUD}/exif/"
ok "  Cloud/exif synced"

# Cloud/nft (permanent NFT images) → NVMe
log "  Cloud/nft..."
mkdir -p "${MAIN_CLOUD}/nft"
RSYNC_RSH="ssh $SSH_OPTS" $RSYNC_BASE \
  "root@${PI_IP}:${PI_CLOUD}/nft/" "${MAIN_CLOUD}/nft/"
ok "  Cloud/nft synced"

# Chunks → RAID10 (different path on main!)
log "  Chunks (Pi: ${PI_CHUNKS}/users/ → Main: ${MAIN_CHUNKS}/users/)..."
mkdir -p "${MAIN_CHUNKS}/users"
RSYNC_RSH="ssh $SSH_OPTS" $RSYNC_BASE \
  "root@${PI_IP}:${PI_CHUNKS}/users/" "${MAIN_CHUNKS}/users/"
ok "  Chunks synced"

# Uploads → NVMe
log "  Uploads..."
mkdir -p "${MAIN_UPLOADS}"
RSYNC_RSH="ssh $SSH_OPTS" $RSYNC_BASE \
  "root@${PI_IP}:${PI_UPLOADS}/" "${MAIN_UPLOADS}/"
ok "  Uploads synced"

# Uptime JSON
log "  uptime.json..."
RSYNC_RSH="ssh $SSH_OPTS" rsync -avz --ignore-existing \
  "root@${PI_IP}:${PI_UPTIME}" "${MAIN_UPTIME}" 2>/dev/null || true

ok "All file syncs complete"

# ── Step 6: Restart services ──────────────────────────────────────────
log ""
log "═══ Step 6: Restarting services ═══"

# Restart Pi services first
log "Restarting Pi services..."
ssh $SSH_OPTS "root@${PI_IP}" "
  systemctl start ${SERVICE_NAME} 2>/dev/null || true
  systemctl start ${SERVICE_NAME}-capacity.timer ${SERVICE_NAME}-sweep-expired.timer ${SERVICE_NAME}-reconcile-cloud-usage.timer 2>/dev/null || true
" 2>/dev/null || warn "Could not restart Pi services"
ok "Pi services restarted"

# Restart main services
log "Restarting main services..."
systemctl start ${SERVICE_NAME}-capacity.timer ${SERVICE_NAME}-sweep-expired.timer ${SERVICE_NAME}-reconcile-cloud-usage.timer 2>/dev/null || true
systemctl start ${SERVICE_NAME}
ok "Main services restarted"

# Verify main is running
sleep 2
if systemctl is-active --quiet ${SERVICE_NAME}; then
  ok "photolynk service is running"
else
  err "photolynk service failed to start — check: journalctl -u photolynk -n 50"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Pull from backup complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BLUE}DB backups:${NC}    ${DB_BACKUP_DIR}/"
echo -e "  ${BLUE}Main DB:${NC}       $(ls -lh "$MAIN_DB" 2>/dev/null | awk '{print $5}' || echo 'MISSING')"
echo -e "  ${BLUE}Main NFT DB:${NC}   $(ls -lh "$MAIN_NFT_DB" 2>/dev/null | awk '{print $5}' || echo 'MISSING')"
echo -e "  ${BLUE}Cloud:${NC}         $(du -sh "$MAIN_CLOUD" 2>/dev/null | awk '{print $1}' || echo 'MISSING')"
echo -e "  ${BLUE}Chunks:${NC}        $(du -sh "$MAIN_CHUNKS" 2>/dev/null | awk '{print $1}' || echo 'MISSING')"
echo -e "  ${BLUE}Uploads:${NC}       $(du -sh "$MAIN_UPLOADS" 2>/dev/null | awk '{print $1}' || echo 'MISSING')"
echo ""
echo -e "  ${YELLOW}To restore old DBs:${NC}"
echo -e "    cp ${DB_BACKUP_DIR}/backup.db ${MAIN_DB}"
echo -e "    cp ${DB_BACKUP_DIR}/nft-service.db ${MAIN_NFT_DB}"
echo -e "    sudo systemctl restart photolynk"
echo ""
