const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secure-secret-key-change-this';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Security & Middleware
app.use(helmet()); // Sets various HTTP headers for security
app.use(cors());
app.use(morgan('common')); // Logging
app.use(express.json());

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

// Database Setup
const db = new sqlite3.Database('./backup.db', (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log('Connected to SQLite database.');
});

db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT
    )`);

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, filename)
    )`);
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

// --- ROUTES ---

// Root: Secure by default (no info leaked)
app.get('/', (req, res) => {
    res.status(403).send('Access Forbidden');
});

// Register User
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (email, password) VALUES (?, ?)`, [email, hashedPassword], function(err) {
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
app.post('/api/login', (req, res) => {
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
                const token = jwt.sign({ id: user.id, email: user.email, device_uuid: device_uuid }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ token, userId: user.id });
            }
        );
    });
});

// Upload File
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { filename, originalname, mimetype, size } = req.file;
    
    // Record in DB
    db.run(`INSERT OR REPLACE INTO files (user_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, originalname, originalname, mimetype, size],
        (err) => {
            if (err) console.error('Metadata save error:', err);
            // Even if DB fails, file is on disk, but best to keep sync.
            res.json({ message: 'File uploaded', filename: originalname });
        }
    );
});

// List Files (for Sync)
app.get('/api/files', authenticateToken, (req, res) => {
    db.all(`SELECT filename, size, created_at FROM files WHERE user_id = ?`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ files: rows });
    });
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Secure Backup Server running on 0.0.0.0:${PORT}`);
});
