#!/usr/bin/env node

/**
 * Tiered Storage Background Sync Script
 * 
 * Moves old/large chunks from NVMe (hot tier) to HDD (cold tier)
 * Runs periodically via systemd timer or cron
 * 
 * Strategy:
 * - Small files (< 10MB): Stay on NVMe permanently
 * - Large files (> 10MB): Move to HDD after 30 days
 * - Manifests: Always stay on NVMe (small, frequently accessed)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration from environment
const CLOUD_DIR = process.env.CLOUD_DIR || '/mnt/nvme-buffer/cloud';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/data/cloud-archive';
const TIERING_ENABLED = process.env.TIERING_ENABLED === 'true';
const TIERING_AGE_DAYS = parseInt(process.env.TIERING_AGE_DAYS || '30', 10);
const TIERING_SIZE_THRESHOLD_MB = parseInt(process.env.TIERING_SIZE_THRESHOLD_MB || '10', 10);
const DRY_RUN = process.argv.includes('--dry-run');

const BYTES_PER_MB = 1024 * 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

console.log('=== PhotoSync Tiered Storage Sync ===');
console.log(`Hot tier:  ${CLOUD_DIR}`);
console.log(`Cold tier: ${ARCHIVE_DIR}`);
console.log(`Age threshold: ${TIERING_AGE_DAYS} days`);
console.log(`Size threshold: ${TIERING_SIZE_THRESHOLD_MB} MB`);
console.log(`Dry run: ${DRY_RUN ? 'YES' : 'NO'}`);
console.log('');

if (!TIERING_ENABLED) {
    console.log('Tiering is disabled. Set TIERING_ENABLED=true to enable.');
    process.exit(0);
}

if (!fs.existsSync(CLOUD_DIR)) {
    console.error(`Error: Hot tier directory does not exist: ${CLOUD_DIR}`);
    process.exit(1);
}

if (!fs.existsSync(ARCHIVE_DIR)) {
    console.log(`Creating archive directory: ${ARCHIVE_DIR}`);
    if (!DRY_RUN) {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    }
}

// Recursively find all chunk files in hot tier
function findChunks(dir, basePath = '') {
    const chunks = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(basePath, entry.name);
        
        if (entry.isDirectory()) {
            // Skip manifests directory - manifests always stay hot
            if (entry.name === 'manifests') {
                continue;
            }
            chunks.push(...findChunks(fullPath, relativePath));
        } else if (entry.isFile() && entry.name.match(/^[a-f0-9]{64}$/i)) {
            // This is a chunk file (64 hex chars)
            chunks.push({
                fullPath,
                relativePath,
                name: entry.name
            });
        }
    }
    
    return chunks;
}

// Get file stats
function getFileStats(filePath) {
    const stats = fs.statSync(filePath);
    const ageMs = Date.now() - stats.mtimeMs;
    const ageDays = ageMs / MS_PER_DAY;
    const sizeMB = stats.size / BYTES_PER_MB;
    
    return {
        size: stats.size,
        sizeMB,
        ageMs,
        ageDays,
        mtime: stats.mtime
    };
}

// Move chunk to archive
function moveToArchive(chunk) {
    const archivePath = path.join(ARCHIVE_DIR, chunk.relativePath);
    const archiveDir = path.dirname(archivePath);
    
    // Create archive directory structure
    if (!fs.existsSync(archiveDir)) {
        console.log(`  Creating directory: ${archiveDir}`);
        if (!DRY_RUN) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }
    }
    
    // Move file
    console.log(`  Moving: ${chunk.relativePath}`);
    if (!DRY_RUN) {
        fs.renameSync(chunk.fullPath, archivePath);
    }
}

// Main sync logic
async function sync() {
    console.log('Scanning hot tier for chunks...');
    const chunks = findChunks(CLOUD_DIR);
    console.log(`Found ${chunks.length} chunks\n`);
    
    let movedCount = 0;
    let movedBytes = 0;
    let skippedTooNew = 0;
    let skippedTooSmall = 0;
    
    for (const chunk of chunks) {
        const stats = getFileStats(chunk.fullPath);
        
        // Skip if too new
        if (stats.ageDays < TIERING_AGE_DAYS) {
            skippedTooNew++;
            continue;
        }
        
        // Skip if too small (keep small files hot)
        if (stats.sizeMB < TIERING_SIZE_THRESHOLD_MB) {
            skippedTooSmall++;
            continue;
        }
        
        // Move to archive
        console.log(`Archiving chunk: ${chunk.name}`);
        console.log(`  Age: ${stats.ageDays.toFixed(1)} days`);
        console.log(`  Size: ${stats.sizeMB.toFixed(2)} MB`);
        
        try {
            moveToArchive(chunk);
            movedCount++;
            movedBytes += stats.size;
        } catch (err) {
            console.error(`  Error: ${err.message}`);
        }
    }
    
    console.log('');
    console.log('=== Summary ===');
    console.log(`Total chunks scanned: ${chunks.length}`);
    console.log(`Moved to archive: ${movedCount} (${(movedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)`);
    console.log(`Skipped (too new): ${skippedTooNew}`);
    console.log(`Skipped (too small): ${skippedTooSmall}`);
    console.log('');
    
    // Show disk usage
    if (!DRY_RUN) {
        console.log('=== Disk Usage ===');
        try {
            const hotDf = execSync(`df -h ${CLOUD_DIR} | tail -1`).toString().trim();
            const coldDf = execSync(`df -h ${ARCHIVE_DIR} | tail -1`).toString().trim();
            console.log('Hot tier (NVMe):');
            console.log(`  ${hotDf}`);
            console.log('Cold tier (HDD):');
            console.log(`  ${coldDf}`);
        } catch (err) {
            console.error('Could not get disk usage');
        }
    }
}

// Run sync
sync().catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
});
