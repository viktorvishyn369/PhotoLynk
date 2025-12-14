const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const updater = require('./updater');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secure-secret-key-change-this';
const BCRYPT_ROUNDS = Number.parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

const ENABLE_HTTPS = String(process.env.ENABLE_HTTPS || '').toLowerCase() === 'true';
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const FORCE_HTTPS_REDIRECT = String(process.env.FORCE_HTTPS_REDIRECT || '').toLowerCase() === 'true';
// Use home directory for universal path across any user/OS
const os = require('os');
const HOME_DIR = os.homedir();

const resolveDataDir = () => {
    if (process.env.PHOTOSYNC_DATA_DIR) return process.env.PHOTOSYNC_DATA_DIR;
    if (process.env.DB_PATH) return path.dirname(process.env.DB_PATH);
    return path.join(HOME_DIR, 'PhotoSync', 'server');
};

const DATA_DIR = resolveDataDir();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const CLOUD_DIR = process.env.CLOUD_DIR || path.join(DATA_DIR, 'cloud');

// Security & Middleware
app.use(helmet()); // Sets various HTTP headers for security
app.use(cors());
app.use(morgan('common')); // Logging
app.use(express.json());

// Prevent stale caching (e.g., 304 Not Modified) for API responses like StealthCloud manifest listing
app.set('etag', false);

// Basic brute-force protection for auth endpoints (in-memory)
const createRateLimiter = ({ windowMs, max }) => {
    const hits = new Map();
    const windowMsNum = Number(windowMs);
    const maxNum = Number(max);

    return (req, res, next) => {
        const now = Date.now();
        const key = `${req.ip}:${req.path}`;
        const entry = hits.get(key) || { count: 0, resetAt: now + windowMsNum };

        if (now > entry.resetAt) {
            entry.count = 0;
            entry.resetAt = now + windowMsNum;
        }

        entry.count += 1;
        hits.set(key, entry);

        const remaining = Math.max(0, maxNum - entry.count);
        res.setHeader('X-RateLimit-Limit', String(maxNum));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.floor(entry.resetAt / 1000)));

        if (entry.count > maxNum) {
            return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        }

        next();
    };
};

const AUTH_RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10);
const AUTH_RATE_LIMIT_MAX = Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '25', 10);
const authRateLimiter = createRateLimiter({ windowMs: AUTH_RATE_LIMIT_WINDOW_MS, max: AUTH_RATE_LIMIT_MAX });

// Ensure base data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Ensure cloud directory exists
if (!fs.existsSync(CLOUD_DIR)) {
    fs.mkdirSync(CLOUD_DIR, { recursive: true });
}

// Database Setup
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'backup.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log(`Connected to SQLite database at ${DB_PATH}`);
});

db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT,
        email TEXT UNIQUE,
        password TEXT
    )`);

    // Migrate existing DBs: add user_uuid column if missing, and populate it
    db.all(`PRAGMA table_info(users)`, [], (err, cols) => {
        if (err) return;
        const hasUserUuid = Array.isArray(cols) && cols.some(c => c && c.name === 'user_uuid');
        if (!hasUserUuid) {
            db.run(`ALTER TABLE users ADD COLUMN user_uuid TEXT`, [], () => {
                // continue even if alter fails
                db.all(`SELECT id FROM users WHERE user_uuid IS NULL OR user_uuid = ''`, [], (e2, rows) => {
                    if (e2) return;
                    (rows || []).forEach(r => {
                        const u = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
                        db.run(`UPDATE users SET user_uuid = ? WHERE id = ?`, [u, r.id]);
                    });
                });
            });
        } else {
            db.all(`SELECT id FROM users WHERE user_uuid IS NULL OR user_uuid = ''`, [], (e2, rows) => {
                if (e2) return;
                (rows || []).forEach(r => {
                    const u = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
                    db.run(`UPDATE users SET user_uuid = ? WHERE id = ?`, [u, r.id]);
                });
            });
        }
    });

    // Devices table - Binding users to specific devices
    db.run(`CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        device_uuid TEXT,
        device_name TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(user_id, device_uuid)
    )`);
    
    // Files table to track metadata
    db.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT,
        original_name TEXT,
        mime_type TEXT,
        size INTEGER,
        file_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, filename),
        UNIQUE(user_id, file_hash)
    )`);
    
    // Clean up database on startup - remove entries for files that don't exist
    setTimeout(() => {
        db.all(`
            SELECT f.user_id, f.filename, d.device_uuid 
            FROM files f
            JOIN devices d ON f.user_id = d.user_id
        `, [], (err, rows) => {
            if (err) return console.error('Cleanup error:', err);
            
            let cleaned = 0;
            rows.forEach(row => {
                // Files are stored by device_uuid, not user_id
                const deviceDir = path.join(UPLOAD_DIR, row.device_uuid);
                const filePath = path.join(deviceDir, row.filename);
                
                if (!fs.existsSync(filePath)) {
                    db.run(`DELETE FROM files WHERE user_id = ? AND filename = ?`, 
                        [row.user_id, row.filename]);
                    cleaned++;
                }
            });
            
            if (cleaned > 0) {
                console.log(`Database cleanup: removed ${cleaned} orphaned entries`);
            }
        });
    }, 1000); // Wait 1 second after startup
});

// Middleware: Verify Token & Device Binding
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const deviceUuid = req.headers['x-device-uuid']; // Critical for security binding
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied' });
    if (!deviceUuid) return res.status(400).json({ error: 'Device UUID required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });

        // Strict Security: Ensure the token matches the device requesting it
        if (user.device_uuid !== deviceUuid) {
            return res.status(403).json({ error: 'Device mismatch. Token not valid for this device.' });
        }

        req.user = user;
        next();
    });
};

const getStealthCloudUserKey = (user) => {
    const deviceKey = (user && (user.device_uuid || user.deviceUuid)) ? String(user.device_uuid || user.deviceUuid) : '';
    const safeDevice = deviceKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (safeDevice) return safeDevice;

    const key = (user && (user.user_uuid || user.userUuid)) ? String(user.user_uuid || user.userUuid) : '';
    // UUID safe-ish folder: keep only [a-zA-Z0-9_-]
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    return safe || String(user.id);
};

const ensureStealthCloudUserDirs = (user) => {
    const key = getStealthCloudUserKey(user);
    const userDir = path.join(CLOUD_DIR, 'users', key);
    const chunksDir = path.join(userDir, 'chunks');
    const manifestsDir = path.join(userDir, 'manifests');
    if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });
    if (!fs.existsSync(manifestsDir)) fs.mkdirSync(manifestsDir, { recursive: true });

    // Backward-compat migration: if old numeric folder exists and new doesn't have data, move it once
    const oldKeys = [];
    if (user && (user.user_uuid || user.userUuid)) {
        const oldUserUuid = String(user.user_uuid || user.userUuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
        if (oldUserUuid) oldKeys.push(oldUserUuid);
    }
    if (user && user.id) {
        oldKeys.push(String(user.id));
    }
    oldKeys
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .filter(k => k !== key)
        .forEach(oldKey => {
            const oldDir = path.join(CLOUD_DIR, 'users', oldKey);
            if (!fs.existsSync(oldDir)) return;
            const oldChunks = path.join(oldDir, 'chunks');
            const oldManifests = path.join(oldDir, 'manifests');
            try {
                if (fs.existsSync(oldChunks)) {
                    fs.readdirSync(oldChunks).forEach(f => {
                        const src = path.join(oldChunks, f);
                        const dst = path.join(chunksDir, f);
                        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
                    });
                }
                if (fs.existsSync(oldManifests)) {
                    fs.readdirSync(oldManifests).forEach(f => {
                        const src = path.join(oldManifests, f);
                        const dst = path.join(manifestsDir, f);
                        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
                    });
                }
            } catch (e) {
                // ignore migration errors
            }
        });

    return { userDir, chunksDir, manifestsDir };
};

// File Storage Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Use device UUID for folder name (scalable for future cloud service)
        const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
        if (!fs.existsSync(deviceDir)) {
            fs.mkdirSync(deviceDir, { recursive: true });
        }
        cb(null, deviceDir);
    },
    filename: (req, file, cb) => {
        // Use original name but sanitize or prepend timestamp to avoid collisions if needed.
        // For sync, we often want to keep the exact filename or a hash.
        // Here we assume the client sends a unique filename (e.g. UUID or timestamped name)
        cb(null, file.originalname); 
    }
});

const upload = multer({ storage: storage });

// Cloud chunk storage (encrypted blobs): keep server blind
const cloudStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { chunksDir } = ensureStealthCloudUserDirs(req.user);
        cb(null, chunksDir);
    },
    filename: (req, file, cb) => {
        const requestedId = req.headers['x-chunk-id'];
        const safeId = typeof requestedId === 'string' && requestedId.match(/^[a-f0-9]{64}$/i)
            ? requestedId.toLowerCase()
            : crypto.randomBytes(32).toString('hex');
        cb(null, safeId);
    }
});
const uploadCloudChunk = multer({ storage: cloudStorage });

// Raw encrypted chunk uploads (application/octet-stream)
const rawCloudChunk = express.raw({ type: '*/*', limit: '250mb' });

// --- ROUTES ---

// Root: Secure by default (no info leaked)
app.get('/', (req, res) => {
    res.status(403).send('Access Forbidden');
});

app.get('/health', (req, res) => {
    res.status(200).json({ ok: true });
});

// Register User
app.post('/api/register', authRateLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const u = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
        db.run(`INSERT INTO users (user_uuid, email, password) VALUES (?, ?, ?)`, [u, email, hashedPassword], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'Email already exists' });
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ message: 'User registered successfully' });
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Login & Bind Device
app.post('/api/login', authRateLimiter, (req, res) => {
    const { email, password, device_uuid, device_name } = req.body;
    if (!email || !password || !device_uuid) return res.status(400).json({ error: 'Missing credentials or device ID' });

    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        // Register/Update Device
        db.run(`INSERT OR IGNORE INTO devices (user_id, device_uuid, device_name) VALUES (?, ?, ?)`, 
            [user.id, device_uuid, device_name || 'Unknown Device'], 
            (devErr) => {
                if (devErr) console.error('Device reg error:', devErr);
                
                // Generate Token BOUND to this device
                const token = jwt.sign({ id: user.id, user_uuid: user.user_uuid, email: user.email, device_uuid: device_uuid }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ token, userId: user.id });
            }
        );
    });
});

// Upload File
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { filename, path: filePath, originalname, mimetype, size } = req.file;
    
    // Calculate file hash to detect duplicates
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    // Check if this exact file already exists for this user (by hash OR filename)
    db.get(`SELECT filename, file_hash FROM files WHERE user_id = ? AND (file_hash = ? OR filename = ?)`, 
        [req.user.id, fileHash, originalname], 
        (err, row) => {
            if (row) {
                // Check if the file actually exists on disk
                const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
                const existingFilePath = path.join(deviceDir, row.filename);
                
                if (fs.existsSync(existingFilePath)) {
                    // Duplicate file exists - delete the uploaded file and return existing filename
                    fs.unlinkSync(filePath);
                    console.log(`Duplicate file detected: ${originalname} (matches ${row.filename})`);
                    return res.json({ message: 'File already exists (duplicate)', filename: row.filename, duplicate: true });
                } else {
                    // File in DB but not on disk - remove from DB and continue with upload
                    console.log(`File ${row.filename} in DB but missing from disk - cleaning up DB`);
                    db.run(`DELETE FROM files WHERE user_id = ? AND (file_hash = ? OR filename = ?)`, [req.user.id, fileHash, originalname]);
                    // Continue to save the new file below
                }
            }
            
            // Not a duplicate - save to DB
            db.run(`INSERT OR REPLACE INTO files (user_id, filename, original_name, mime_type, size, file_hash) VALUES (?, ?, ?, ?, ?, ?)`,
                [req.user.id, originalname, originalname, mimetype, size, fileHash],
                (err) => {
                    if (err) {
                        console.error('Metadata save error:', err);
                        // If DB save fails, try to clean up the file
                        fs.unlinkSync(filePath);
                        return res.status(500).json({ error: 'Failed to save file metadata' });
                    }
                    res.json({ message: 'File uploaded', filename: originalname });
                }
            );
        }
    );
});

// List Files (for Sync)
app.get('/api/files', authenticateToken, (req, res) => {
    // Read files from device UUID folder
    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    
    console.log(`[LIST FILES] Device UUID: ${req.user.device_uuid}`);
    console.log(`[LIST FILES] Looking in: ${deviceDir}`);
    
    if (!fs.existsSync(deviceDir)) {
        console.log(`[LIST FILES] Directory does not exist`);
        return res.json({ files: [] });
    }
    
    try {
        const allFiles = fs.readdirSync(deviceDir);
        console.log(`[LIST FILES] Found ${allFiles.length} items in directory`);
        
        // Filter out system files and only include actual media files
        const files = allFiles
            .filter(filename => !filename.startsWith('.')) // Skip hidden files like .DS_Store
            .filter(filename => fs.statSync(path.join(deviceDir, filename)).isFile()) // Only files, not directories
            .map(filename => {
                const filePath = path.join(deviceDir, filename);
                const stats = fs.statSync(filePath);
                return {
                    filename,
                    size: stats.size,
                    created_at: stats.mtime
                };
            });
        
        console.log(`[LIST FILES] Returning ${files.length} files`);
        res.json({ files });
    } catch (error) {
        console.error('[LIST FILES] Error reading files:', error);
        res.status(500).json({ error: 'Error reading files' });
    }
});

// Download File
app.get('/api/files/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    const filePath = path.join(deviceDir, filename);

    // Security check: prevent directory traversal
    if (!filePath.startsWith(deviceDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// --- StealthCloud (zero-knowledge) routes ---
// Server stores encrypted chunks and encrypted manifests only.

// Upload encrypted chunk blob
app.post('/api/cloud/chunks', authenticateToken, (req, res, next) => {
    const ct = (req.headers['content-type'] || '').toString().toLowerCase();
    if (ct.startsWith('application/octet-stream') || ct === 'application/octetstream') {
        return rawCloudChunk(req, res, next);
    }
    return uploadCloudChunk.single('chunk')(req, res, next);
}, (req, res) => {
    const clientBuild = (req.headers['x-client-build'] || '').toString();
    if (clientBuild) {
        console.log(`[SC] /chunks client=${clientBuild} user=${req.user.id}`);
    }
    const requestedId = (req.headers['x-chunk-id'] || '').toString().toLowerCase();

    // If raw upload (no multipart), store from req.body
    if (!req.file) {
        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'No chunk uploaded' });
        }

        if (!requestedId || !requestedId.match(/^[a-f0-9]{64}$/i)) {
            return res.status(400).json({ error: 'Missing or invalid X-Chunk-Id' });
        }

        const { chunksDir } = ensureStealthCloudUserDirs(req.user);
        const target = path.join(chunksDir, requestedId);
        if (!target.startsWith(chunksDir)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        try {
            const actual = crypto.createHash('sha256').update(req.body).digest('hex');
            if (actual !== requestedId) {
                return res.status(400).json({ error: 'Chunk hash mismatch' });
            }
            if (!fs.existsSync(target)) {
                fs.writeFileSync(target, req.body);
            }
            return res.json({ chunkId: requestedId, stored: true });
        } catch (e) {
            return res.status(500).json({ error: 'Chunk verification failed' });
        }
    }

    const storedName = req.file.filename;

    // Optional integrity check: if client provided a sha256 id, verify it
    if (requestedId && requestedId.match(/^[a-f0-9]{64}$/i)) {
        try {
            const buf = fs.readFileSync(req.file.path);
            const actual = crypto.createHash('sha256').update(buf).digest('hex');
            if (actual !== requestedId) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: 'Chunk hash mismatch' });
            }

            // Ensure filename equals requested hash for idempotency
            if (storedName !== requestedId) {
                const dir = path.dirname(req.file.path);
                const target = path.join(dir, requestedId);
                if (fs.existsSync(target)) {
                    fs.unlinkSync(req.file.path);
                } else {
                    fs.renameSync(req.file.path, target);
                }
                return res.json({ chunkId: requestedId, stored: true });
            }
        } catch (e) {
            return res.status(500).json({ error: 'Chunk verification failed' });
        }
    }

    res.json({ chunkId: storedName, stored: true });
});

// Download encrypted chunk blob
app.get('/api/cloud/chunks/:chunkId', authenticateToken, (req, res) => {
    const chunkId = (req.params.chunkId || '').toLowerCase();
    if (!chunkId.match(/^[a-f0-9]{64}$/i)) {
        return res.status(400).json({ error: 'Invalid chunk id' });
    }
    const { chunksDir: chunksRoot } = ensureStealthCloudUserDirs(req.user);
    const chunkPath = path.join(chunksRoot, chunkId);
    if (!chunkPath.startsWith(chunksRoot)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(chunkPath)) {
        return res.status(404).json({ error: 'Chunk not found' });
    }
    res.download(chunkPath);
});

// Upload encrypted manifest JSON
app.post('/api/cloud/manifests', authenticateToken, (req, res) => {
    const { manifestId, encryptedManifest, chunkCount } = req.body || {};
    const clientBuild = (req.headers['x-client-build'] || '').toString();
    if (clientBuild) {
        console.log(`[SC] /manifests client=${clientBuild} user=${req.user.id} chunkCount=${typeof chunkCount === 'number' ? chunkCount : 'na'}`);
    }
    if (!manifestId || typeof manifestId !== 'string') return res.status(400).json({ error: 'manifestId required' });
    if (!encryptedManifest || typeof encryptedManifest !== 'string') return res.status(400).json({ error: 'encryptedManifest required' });

    if (typeof chunkCount === 'number' && chunkCount <= 0) {
        return res.status(400).json({ error: 'Invalid manifest: chunkCount must be > 0' });
    }

    const safeId = manifestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (!safeId) return res.status(400).json({ error: 'Invalid manifestId' });

    const { manifestsDir } = ensureStealthCloudUserDirs(req.user);

    const manifestPath = path.join(manifestsDir, `${safeId}.json`);
    const payload = {
        manifestId: safeId,
        encryptedManifest,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(manifestPath, JSON.stringify(payload));

    res.json({ ok: true, manifestId: safeId });
});

// List manifests
app.get('/api/cloud/manifests', authenticateToken, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', '');
    const { manifestsDir } = ensureStealthCloudUserDirs(req.user);
    if (!fs.existsSync(manifestsDir)) return res.json({ manifests: [] });
    const list = fs.readdirSync(manifestsDir)
        .filter(f => f.endsWith('.json'))
        .filter(f => !f.startsWith('.')) // Skip hidden files like .DS_Store
        .map(f => ({ manifestId: f.replace(/\.json$/, '') }));
    res.json({ manifests: list });
});

// Download encrypted manifest
app.get('/api/cloud/manifests/:manifestId', authenticateToken, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', '');
    const safeId = (req.params.manifestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (!safeId) return res.status(400).json({ error: 'Invalid manifest id' });
    const { manifestsDir: manifestsRoot } = ensureStealthCloudUserDirs(req.user);
    const manifestPath = path.join(manifestsRoot, `${safeId}.json`);
    if (!manifestPath.startsWith(manifestsRoot)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Manifest not found' });
    res.sendFile(manifestPath);
});

const startUpdateChecker = () => {
    updater.startAutoCheck((result) => {
        if (result.available) {
            console.log(`\n✨ Update available: v${result.version}`);
            console.log(`Run 'npm run update' to install\n`);
        }
    });
};

const startHttp = () => {
    const httpServer = http.createServer(app);
    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Secure Backup Server running on 0.0.0.0:${PORT}`);
        console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
        console.log(`💾 Database: ${DB_PATH}\n`);
        startUpdateChecker();
    });
};

const startHttps = () => {
    if (!TLS_KEY_PATH || !TLS_CERT_PATH) {
        console.error('HTTPS enabled but TLS_KEY_PATH or TLS_CERT_PATH is missing. Falling back to HTTP.');
        return startHttp();
    }
    if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
        console.error('HTTPS enabled but TLS key/cert files not found. Falling back to HTTP.');
        return startHttp();
    }

    if (JWT_SECRET === 'super-secure-secret-key-change-this') {
        console.warn('⚠️  JWT_SECRET is using the default value. Set a strong JWT_SECRET for remote deployments.');
    }

    const tlsOptions = {
        key: fs.readFileSync(TLS_KEY_PATH),
        cert: fs.readFileSync(TLS_CERT_PATH)
    };

    const httpsServer = https.createServer(tlsOptions, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`\n🔐 HTTPS enabled on 0.0.0.0:${HTTPS_PORT}`);
        console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
        console.log(`💾 Database: ${DB_PATH}\n`);
        startUpdateChecker();
    });

    if (FORCE_HTTPS_REDIRECT) {
        const redirectApp = express();
        redirectApp.use((req, res) => {
            const hostHeader = req.headers.host || '';
            const host = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
            const portPart = String(HTTPS_PORT) === '443' ? '' : `:${HTTPS_PORT}`;
            const location = `https://${host}${portPart}${req.originalUrl}`;
            res.redirect(301, location);
        });
        http.createServer(redirectApp).listen(PORT, '0.0.0.0', () => {
            console.log(`↪️  HTTP redirect enabled on 0.0.0.0:${PORT} -> HTTPS`);
        });
    }
};

if (ENABLE_HTTPS) startHttps();
else startHttp();
