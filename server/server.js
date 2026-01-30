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
const axios = require('axios');
const updater = require('./updater');
let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

/**
 * Compute perceptual hash (dHash) for an image file
 * Returns 16-character hex string (64-bit hash)
 */
const computePerceptualHash = async (filePath) => {
    if (!sharp) return null;
    try {
        // Resize to 9x8 grayscale for dHash
        const { data, info } = await sharp(filePath)
            .resize(9, 8, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });
        
        if (info.width !== 9 || info.height !== 8) return null;
        
        // Compute difference hash - compare adjacent horizontal pixels
        let hash = BigInt(0);
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const left = data[y * 9 + x];
                const right = data[y * 9 + x + 1];
                if (left > right) {
                    hash |= BigInt(1) << BigInt(y * 8 + x);
                }
            }
        }
        
        // Convert to 16-char hex string
        return hash.toString(16).padStart(16, '0');
    } catch (e) {
        console.log('computePerceptualHash error:', e.message);
        return null;
    }
};

// Try to use bundled ffmpeg, fallback to system ffmpeg
let ffmpegPath = 'ffmpeg';
try {
    // Try @ffmpeg-installer/ffmpeg first (better Electron support)
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    let installerPath = ffmpegInstaller.path;
    if (installerPath && typeof installerPath === 'string') {
        // Handle Electron asar unpacking
        if (installerPath.includes('app.asar')) {
            installerPath = installerPath.replace('app.asar', 'app.asar.unpacked');
        }
        if (fs.existsSync(installerPath)) {
            ffmpegPath = installerPath;
            console.log('Using bundled ffmpeg:', ffmpegPath);
        } else {
            console.log('Bundled ffmpeg not found at:', installerPath, '- trying system ffmpeg');
        }
    }
} catch (e) {
    // Try ffmpeg-static as fallback
    try {
        let staticPath = require('ffmpeg-static');
        if (staticPath && typeof staticPath === 'string') {
            if (staticPath.includes('app.asar')) {
                staticPath = staticPath.replace('app.asar', 'app.asar.unpacked');
            }
            if (fs.existsSync(staticPath)) {
                ffmpegPath = staticPath;
                console.log('Using bundled ffmpeg-static:', ffmpegPath);
            }
        }
    } catch (e2) {
        console.log('No bundled ffmpeg available, using system ffmpeg');
    }
}

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

const DEFAULT_LINUX_MEDIA_DIR = '/data/media';
const DEFAULT_LINUX_DB_DIR = '/data/db';

const isExistingDir = (p) => {
    try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch (e) {
        return false;
    }
};

const reserveStealthCloudIncomingBytes = async ({ userId, incomingBytes }) => {
    const inc = typeof incomingBytes === 'number' && Number.isFinite(incomingBytes) ? Math.max(0, incomingBytes) : 0;
    if (inc <= 0) {
        return {
            allowed: true,
            quotaBytes: await getUserQuotaBytes(userId),
            usedBytes: await getUserUsedBytes(userId),
            reservedBytes: Number(cloudUploadReservedBytes.get(String(userId)) || 0) || 0,
            remainingBytes: 0,
            marginBytes: USER_QUOTA_MARGIN_BYTES,
            release: () => {},
        };
    }

    const releaseLock = await acquireCloudUploadLock(userId);
    try {
        const quotaBytes = await getUserQuotaBytes(userId);
        const usedBytes = await getUserUsedBytes(userId);
        const key = String(userId);
        const reservedBytes = Number(cloudUploadReservedBytes.get(key) || 0) || 0;
        const allowed = quotaBytes <= 0 ? true : (usedBytes + reservedBytes + inc + USER_QUOTA_MARGIN_BYTES) <= quotaBytes;
        const remaining = quotaBytes <= 0 ? 0 : Math.max(0, quotaBytes - (usedBytes + reservedBytes));

        if (!allowed) {
            return {
                allowed: false,
                quotaBytes,
                usedBytes,
                reservedBytes,
                remainingBytes: remaining,
                marginBytes: USER_QUOTA_MARGIN_BYTES,
                release: () => {},
            };
        }

        cloudUploadReservedBytes.set(key, reservedBytes + inc);
        let released = false;
        const releaseReservation = () => {
            if (released) return;
            released = true;
            const cur = Number(cloudUploadReservedBytes.get(key) || 0) || 0;
            const next = Math.max(0, cur - inc);
            if (next <= 0) cloudUploadReservedBytes.delete(key);
            else cloudUploadReservedBytes.set(key, next);
        };

        return {
            allowed: true,
            quotaBytes,
            usedBytes,
            reservedBytes: reservedBytes + inc,
            remainingBytes: remaining,
            marginBytes: USER_QUOTA_MARGIN_BYTES,
            release: releaseReservation,
        };
    } finally {
        releaseLock();
    }
};

const resolveDataDir = () => {
    if (process.env.PHOTOSYNC_DATA_DIR) return process.env.PHOTOSYNC_DATA_DIR;
    if (process.env.UPLOAD_DIR) return path.dirname(process.env.UPLOAD_DIR);
    if (isExistingDir(DEFAULT_LINUX_MEDIA_DIR) || isExistingDir(DEFAULT_LINUX_DB_DIR)) return '/data';
    const photolynkDir = path.join(HOME_DIR, 'PhotoLynk', 'server');
    const photosyncDir = path.join(HOME_DIR, 'PhotoSync', 'server');
    try {
        if (fs.existsSync(photolynkDir)) return photolynkDir;
        if (fs.existsSync(photosyncDir)) return photosyncDir;
    } catch (e) {
        // ignore
    }
    return photolynkDir;
};

const normalizeTierGb = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n === 100 || n === 200 || n === 400 || n === 1000) return n;
    return null;
};

const inferTierGbFromProductId = (productId) => {
    if (!productId) return null;
    const pid = String(productId);
    const pidLower = pid.toLowerCase();
    if (pidLower === 'stealthcloud_1tb_monthly' || pidLower === 'stealthcloud.1tb.monthly') return 1000;

    const m = pid.match(/(?:^|[._])stealthcloud[._](\d+)(gb|tb)[._]monthly$/i);
    if (!m) {
        const legacy = pid.match(/^stealthcloud_(\d+)(gb|tb)_monthly$/i);
        if (!legacy) return null;

        const qtyLegacy = Number(legacy[1]);
        const unitLegacy = String(legacy[2]).toLowerCase();
        if (!Number.isFinite(qtyLegacy) || qtyLegacy <= 0) return null;
        if (unitLegacy === 'tb') return qtyLegacy * 1000;
        return qtyLegacy;
    }
    const qty = Number(m[1]);
    const unit = String(m[2]).toLowerCase();
    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (unit === 'tb') return qty * 1000;
    return qty;
};

const DATA_DIR = resolveDataDir();
const UPLOAD_DIR =
    process.env.UPLOAD_DIR || (isExistingDir(DEFAULT_LINUX_MEDIA_DIR) ? DEFAULT_LINUX_MEDIA_DIR : path.join(DATA_DIR, 'uploads'));
const DB_PATH =
    process.env.DB_PATH || (isExistingDir(DEFAULT_LINUX_DB_DIR) ? path.join(DEFAULT_LINUX_DB_DIR, 'backup.db') : path.join(DATA_DIR, 'backup.db'));
const AUX_ROOT = process.env.PHOTOSYNC_DATA_DIR || path.dirname(UPLOAD_DIR);
const CLOUD_DIR = process.env.CLOUD_DIR || path.join(AUX_ROOT, 'cloud'); // NVMe: manifests, small data
const CHUNKS_DIR = process.env.CHUNKS_DIR || null; // HDD RAID10: chunks only (if set)
const CAPACITY_JSON_PATH = process.env.CAPACITY_JSON_PATH || path.join(AUX_ROOT, '.well-known', 'photolynk-capacity.json');

const SUBSCRIPTION_GRACE_DAYS = Number.parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);
const TRIAL_DAYS = Number.parseInt(process.env.TRIAL_DAYS || '7', 10);
const TRIAL_COMPLIMENTARY_DAYS = Number.parseInt(process.env.TRIAL_COMPLIMENTARY_DAYS || '3', 10);
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || '';
const USER_QUOTA_MARGIN_BYTES = Number.parseInt(process.env.USER_QUOTA_MARGIN_BYTES || String(50 * 1024 * 1024), 10);
const ENABLE_CLOUD_UPLOAD_LOCK = String(process.env.ENABLE_CLOUD_UPLOAD_LOCK || 'true').toLowerCase() !== 'false';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD_BCRYPT = process.env.ADMIN_PASSWORD_BCRYPT || '';
const ADMIN_IP_ALLOWLIST = (process.env.ADMIN_IP_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_HTML_TITLE = 'StealthCloud Admin';

// Security & Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
        },
    },
}));
app.use(cors());
app.use(morgan('common')); // Logging
app.use(express.json());

// Serve static files from public directory (company website assets)
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// Serve .well-known directory for capacity JSON
app.use('/.well-known', express.static(path.join(AUX_ROOT, '.well-known')));

// Basic IP allowlist helper
const isIpAllowed = (ip) => {
    if (!ADMIN_IP_ALLOWLIST.length) return true;
    const clean = (ip || '').replace('::ffff:', '');
    return ADMIN_IP_ALLOWLIST.includes(clean);
};

// Admin auth middleware (Basic Auth + bcrypt + optional IP allowlist)
const adminAuth = async (req, res, next) => {
    try {
        if (!ADMIN_USER || !ADMIN_PASSWORD_BCRYPT) {
            return res.status(403).send('Admin access not configured');
        }
        if (!isIpAllowed(req.ip)) {
            return res.status(403).send('IP not allowed');
        }
        const header = req.headers['authorization'] || '';
        if (!header.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate', 'Basic').send('Auth required');
        const decoded = Buffer.from(header.split(' ')[1] || '', 'base64').toString('utf8');
        const [user, ...rest] = decoded.split(':');
        const pass = rest.join(':');
        if (user !== ADMIN_USER) return res.status(401).send('Invalid credentials');
        const ok = await bcrypt.compare(pass, ADMIN_PASSWORD_BCRYPT);
        if (!ok) return res.status(401).send('Invalid credentials');
        next();
    } catch (e) {
        return res.status(401).send('Unauthorized');
    }
};

// Admin HTML helper
const adminLayout = (contentHtml) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${ADMIN_HTML_TITLE}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b1021;
      --panel: #121a30;
      --accent: #4fd1c5;
      --muted: #8fa3c3;
      --text: #e6ecff;
      --danger: #f87171;
    }
    body {
      margin: 0;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: radial-gradient(120% 120% at 20% 20%, rgba(79,209,197,0.08), transparent 50%),
                  radial-gradient(100% 100% at 80% 0%, rgba(79,209,197,0.06), transparent 45%),
                  var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    h1 { margin: 0 0 12px; letter-spacing: 0.3px; }
    .card {
      background: linear-gradient(145deg, rgba(18,26,48,0.95), rgba(18,26,48,0.75));
      border: 1px solid rgba(79,209,197,0.16);
      box-shadow: 0 20px 60px rgba(0,0,0,0.35);
      border-radius: 14px;
      padding: 18px 20px;
      margin-top: 16px;
    }
    label { display: block; font-weight: 600; margin: 10px 0 6px; color: var(--muted); }
    input, select, button, textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      font-size: 15px;
      outline: none;
      transition: border 0.15s ease, transform 0.1s ease;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); }
    button {
      cursor: pointer;
      font-weight: 700;
      background: linear-gradient(135deg, #4fd1c5, #3fb3a9);
      border: none;
      color: #0b1021;
      margin-top: 12px;
    }
    button:hover { transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    pre {
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 12px;
      overflow: auto;
      color: #e6ecff;
      font-size: 13px;
    }
    .danger { color: var(--danger); }
    .muted { color: var(--muted); }
    .flex { display: flex; gap: 12px; align-items: center; }
    .flex button { width: auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${ADMIN_HTML_TITLE}</h1>
    <p class="muted">Search users, view/update plan, expires_at, grace_until, trial_until, and inspect payments.</p>
    ${contentHtml}
  </div>
</body>
</html>`;

// Admin page (Basic Auth + IP allowlist + no cache)
app.get('/admin', adminAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const html = adminLayout(`
      <div class="card">
        <h3>Lookup user</h3>
        <label>Email</label>
        <input type="text" id="lookup-email" placeholder="user@example.com" />
        <label>User UUID</label>
        <input type="text" id="lookup-userUuid" placeholder="67ec8dd3-...." />
        <label>Device UUID</label>
        <input type="text" id="lookup-deviceUuid" placeholder="d27b8441-...." />
        <div class="flex">
          <button type="button" onclick="doLookup()">Lookup</button>
          <span id="lookup-status" class="muted"></span>
        </div>
      </div>

      <div class="card">
        <h3>Update plan</h3>
        <div class="row">
          <div>
            <label>User ID (required)</label>
            <input type="text" id="update-userId" placeholder="numeric user_id" />
          </div>
          <div>
            <label>Plan GB (100, 200, 400, 1000)</label>
            <input type="text" id="update-planGb" placeholder="100" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>Extend Expires by (days)</label>
            <input type="text" id="update-extendExpiresDays" placeholder="e.g., 15" />
          </div>
          <div>
            <label>Extend Trial by (days)</label>
            <input type="text" id="update-extendTrialDays" placeholder="e.g., 15" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>Expires At (ms epoch, optional)</label>
            <input type="text" id="update-expiresAt" placeholder="absolute epoch" />
          </div>
          <div>
            <label>Trial Until (ms epoch, optional)</label>
            <input type="text" id="update-trialUntil" placeholder="absolute epoch" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>Grace Until (ms epoch)</label>
            <input type="text" id="update-graceUntil" placeholder="optional" />
          </div>
          <div>
            <label>Status</label>
            <select id="update-status">
              <option value="">(leave unchanged)</option>
              <option value="active">active</option>
              <option value="trial">trial</option>
              <option value="grace">grace</option>
              <option value="expired">expired</option>
              <option value="deleted">deleted</option>
              <option value="none">none</option>
            </select>
          </div>
        </div>
        <div class="flex">
          <button type="button" onclick="doUpdate()">Update plan</button>
          <span id="update-status-msg" class="muted"></span>
        </div>
      </div>

      <div class="card" style="border:2px solid #f44336;">
        <h3 style="color:#f44336;">⚠️ Delete User (DANGER)</h3>
        <p style="color:#888;font-size:12px;">This will permanently delete the user, their devices, plan, cloud chunks from DB, and optionally their files from disk.</p>
        <div class="row">
          <div>
            <label>User ID (required)</label>
            <input type="text" id="delete-userId" placeholder="numeric user_id" />
          </div>
          <div>
            <label style="display:flex;align-items:center;gap:8px;margin-top:20px;">
              <input type="checkbox" id="delete-files" checked style="width:auto;" />
              Also delete files from disk
            </label>
          </div>
        </div>
        <div class="flex">
          <button type="button" onclick="doDeleteUser()" style="background:#f44336;">Delete User</button>
          <span id="delete-status" class="muted"></span>
        </div>
      </div>

      <div class="card">
        <h3>All Users</h3>
        <div class="flex">
          <button type="button" onclick="loadAllUsers()">Load All Users</button>
          <span id="users-status" class="muted"></span>
        </div>
        <div id="users-table-container" style="margin-top:12px;max-height:400px;overflow:auto;"></div>
      </div>

      <div class="card">
        <h3>Results</h3>
        <pre id="results">Waiting…</pre>
      </div>

      <script>
        var resultsEl = document.getElementById('results');
        var lookupStatusEl = document.getElementById('lookup-status');
        var updateStatusEl = document.getElementById('update-status-msg');
        var deleteStatusEl = document.getElementById('delete-status');
        var usersStatusEl = document.getElementById('users-status');
        var usersTableContainer = document.getElementById('users-table-container');

        function formatJson(obj) { return JSON.stringify(obj, null, 2); }

        function formatDate(isoStr) {
          if (!isoStr) return '-';
          var d = new Date(isoStr);
          return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
        }

        async function loadAllUsers() {
          usersStatusEl.textContent = 'Loading...';
          try {
            var res = await fetch('/admin/api/users', { method: 'GET' });
            var data = await res.json();
            if (!res.ok) {
              usersStatusEl.textContent = 'Error: ' + (data.error || 'Unknown') + ' - ' + (data.details || '');
              return;
            }
            usersStatusEl.textContent = 'Loaded ' + data.total_users + ' users';
            
            var html = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
            html += '<thead><tr style="background:#333;color:#fff;">';
            html += '<th style="padding:6px;border:1px solid #555;">ID</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Email</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Plan (GB)</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Status</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Trial Until</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Expires</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Registered</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Payment Type</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Payment At</th>';
            html += '<th style="padding:6px;border:1px solid #555;">Updated</th>';
            html += '</tr></thead><tbody>';
            
            data.users.forEach(function(u) {
              var statusColor = u.plan.status === 'active' ? '#4CAF50' : 
                               u.plan.status === 'trial' ? '#2196F3' : 
                               u.plan.status === 'expired' ? '#f44336' : '#888';
              html += '<tr>';
              html += '<td style="padding:4px;border:1px solid #444;">' + u.id + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + (u.email || '-') + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + (u.plan.plan_gb || '-') + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;color:' + statusColor + ';">' + (u.plan.status || 'none') + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + formatDate(u.plan.trial_until_date) + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + formatDate(u.plan.expires_at_date) + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + formatDate(u.user_created_at_date) + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + (u.plan.payment_type || '-') + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + formatDate(u.plan.payment_at_date) + '</td>';
              html += '<td style="padding:4px;border:1px solid #444;">' + formatDate(u.plan.updated_at_date) + '</td>';
              html += '</tr>';
            });
            
            html += '</tbody></table>';
            usersTableContainer.innerHTML = html;
            
            resultsEl.textContent = formatJson(data);
          } catch (e) {
            usersStatusEl.textContent = 'Error: ' + e.message;
          }
        }

        async function doLookup() {
          lookupStatusEl.textContent = 'Working...';
          try {
            var email = document.getElementById('lookup-email').value.trim();
            var userUuid = document.getElementById('lookup-userUuid').value.trim();
            var deviceUuid = document.getElementById('lookup-deviceUuid').value.trim();
            var params = new URLSearchParams({ email: email, userUuid: userUuid, deviceUuid: deviceUuid });
            var res = await fetch('/admin/api/user?' + params.toString(), { method: 'GET' });
            var text = await res.text();
            var data;
            try { data = JSON.parse(text); } catch (e) { data = text; }
            resultsEl.textContent = formatJson({ status: res.status, data: data });
            lookupStatusEl.textContent = res.ok ? 'OK' : 'Error';
          } catch (e) {
            resultsEl.textContent = formatJson({ error: e.message });
            lookupStatusEl.textContent = 'Error';
          }
        }

        async function doDeleteUser() {
          var userId = document.getElementById('delete-userId').value.trim();
          var deleteFiles = document.getElementById('delete-files').checked;
          if (!userId) {
            deleteStatusEl.textContent = 'User ID required';
            return;
          }
          if (!confirm('Are you sure you want to DELETE user ' + userId + '? This cannot be undone!')) {
            deleteStatusEl.textContent = 'Cancelled';
            return;
          }
          deleteStatusEl.textContent = 'Deleting...';
          try {
            var res = await fetch('/admin/api/user/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: Number(userId), deleteFiles: deleteFiles })
            });
            var data = await res.json();
            resultsEl.textContent = formatJson({ status: res.status, data: data });
            deleteStatusEl.textContent = res.ok ? 'Deleted!' : 'Error';
            if (res.ok) {
              document.getElementById('delete-userId').value = '';
              loadAllUsers();
            }
          } catch (e) {
            resultsEl.textContent = formatJson({ error: e.message });
            deleteStatusEl.textContent = 'Error';
          }
        }

        async function doUpdate() {
          updateStatusEl.textContent = 'Working...';
          try {
            var userId = document.getElementById('update-userId').value.trim();
            var planGb = document.getElementById('update-planGb').value.trim();
            var extendExpiresDays = document.getElementById('update-extendExpiresDays').value.trim();
            var extendTrialDays = document.getElementById('update-extendTrialDays').value.trim();
            var expiresAt = document.getElementById('update-expiresAt').value.trim();
            var graceUntil = document.getElementById('update-graceUntil').value.trim();
            var trialUntil = document.getElementById('update-trialUntil').value.trim();
            var status = document.getElementById('update-status').value;
            var payload = {
              userId: userId ? Number(userId) : null,
              planGb: planGb ? Number(planGb) : null,
              extendExpiresDays: extendExpiresDays ? Number(extendExpiresDays) : null,
              extendTrialDays: extendTrialDays ? Number(extendTrialDays) : null,
              expiresAt: expiresAt ? Number(expiresAt) : null,
              graceUntil: graceUntil ? Number(graceUntil) : null,
              trialUntil: trialUntil ? Number(trialUntil) : null,
              status: status || null
            };
            var res = await fetch('/admin/api/user/plan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            var text = await res.text();
            var data;
            try { data = JSON.parse(text); } catch (e) { data = text; }
            resultsEl.textContent = formatJson({ status: res.status, data: data });
            updateStatusEl.textContent = res.ok ? 'OK' : 'Error';
          } catch (e) {
            resultsEl.textContent = formatJson({ error: e.message });
            updateStatusEl.textContent = 'Error';
          }
        }
      </script>
    `);
    res.send(html);
});

// Admin API: lookup user (email | userUuid | deviceUuid)
app.get('/admin/api/user', adminAuth, async (req, res) => {
    try {
        const email = (req.query.email || '').toString().trim().toLowerCase();
        const userUuid = (req.query.userUuid || req.query.user_uuid || '').toString().trim();
        const deviceUuid = (req.query.deviceUuid || req.query.device_uuid || '').toString().trim();
        if (!email && !userUuid && !deviceUuid) {
            return res.status(400).json({ error: 'email, userUuid, or deviceUuid required' });
        }

        let user = null;
        if (email) {
            user = await dbGetAsync(`SELECT * FROM users WHERE lower(email) = ?`, [email]);
        }
        if (!user && userUuid) {
            user = await dbGetAsync(`SELECT * FROM users WHERE user_uuid = ?`, [userUuid]);
        }
        if (!user && deviceUuid) {
            user = await dbGetAsync(
                `SELECT u.* FROM users u
                  JOIN devices d ON u.id = d.user_id
                 WHERE d.device_uuid = ?
                 LIMIT 1`,
                [deviceUuid]
            );
        }

        if (!user) return res.status(404).json({ error: 'User not found' });

        const plan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [user.id]);
        const payments = await dbAllAsync(
            `SELECT * FROM solana_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [user.id]
        );

        return res.json({ user, plan, payments });
    } catch (e) {
        console.error('[Admin] lookup error', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Admin API: update plan fields
app.post('/admin/api/user/plan', adminAuth, async (req, res) => {
    try {
        const {
            userId,
            planGb,
            extendExpiresDays,
            extendTrialDays,
            expiresAt,
            graceUntil,
            trialUntil,
            status,
        } = req.body || {};

        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return res.status(400).json({ error: 'userId required' });

        const user = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [uid]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        await ensurePlanRow(uid);

        const currentPlan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [uid]);

        const updates = [];
        const params = [];
        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;

        if (planGb !== undefined && planGb !== null && planGb !== '') {
            const normalized = normalizeTierGb(planGb);
            if (!normalized) return res.status(400).json({ error: 'Invalid planGb' });
            updates.push('plan_gb = ?');
            params.push(normalized);
        }
        const numericOrNull = (v) => {
            if (v === undefined || v === null || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };

        // Handle extend expires by days
        if (extendExpiresDays !== undefined && extendExpiresDays !== null && extendExpiresDays !== '') {
            const days = Number(extendExpiresDays);
            if (!Number.isFinite(days)) return res.status(400).json({ error: 'Invalid extendExpiresDays' });
            const currentExpires = currentPlan?.expires_at || now;
            const baseTime = currentExpires > now ? currentExpires : now;
            updates.push('expires_at = ?');
            params.push(baseTime + days * DAY_MS);
        }

        // Handle extend trial by days
        if (extendTrialDays !== undefined && extendTrialDays !== null && extendTrialDays !== '') {
            const days = Number(extendTrialDays);
            if (!Number.isFinite(days)) return res.status(400).json({ error: 'Invalid extendTrialDays' });
            const currentTrial = currentPlan?.trial_until || now;
            const baseTime = currentTrial > now ? currentTrial : now;
            updates.push('trial_until = ?');
            params.push(baseTime + days * DAY_MS);
        }

        // Absolute epoch values (override extend if both provided)
        const exp = numericOrNull(expiresAt);
        if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
            if (exp === null) return res.status(400).json({ error: 'Invalid expiresAt' });
            updates.push('expires_at = ?');
            params.push(exp);
        }
        const gu = numericOrNull(graceUntil);
        if (graceUntil !== undefined && graceUntil !== null && graceUntil !== '') {
            if (gu === null) return res.status(400).json({ error: 'Invalid graceUntil' });
            updates.push('grace_until = ?');
            params.push(gu);
        }
        const tu = numericOrNull(trialUntil);
        if (trialUntil !== undefined && trialUntil !== null && trialUntil !== '') {
            if (tu === null) return res.status(400).json({ error: 'Invalid trialUntil' });
            updates.push('trial_until = ?');
            params.push(tu);
        }
        if (status !== undefined && status !== null && status !== '') {
            const allowed = new Set(['active', 'trial', 'grace', 'expired', 'deleted', 'none']);
            if (!allowed.has(String(status))) return res.status(400).json({ error: 'Invalid status' });
            updates.push('status = ?');
            params.push(String(status));
        }

        if (!updates.length) return res.status(400).json({ error: 'No updates provided' });

        updates.push('updated_at = ?');
        params.push(now, uid);

        const sql = `UPDATE user_plans SET ${updates.join(', ')} WHERE user_id = ?`;
        await dbRunAsync(sql, params);

        const plan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [uid]);
        return res.json({ ok: true, plan });
    } catch (e) {
        console.error('[Admin] plan update error', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Admin API: list all users with plans
app.get('/admin/api/users', adminAuth, async (req, res) => {
    try {
        // Get all users with their plans (users table has no created_at, use plan updated_at as proxy)
        const users = await dbAllAsync(`
            SELECT 
                u.id,
                u.email,
                u.user_uuid,
                u.created_at AS user_created_at,
                p.plan_gb,
                p.status as plan_status,
                p.trial_until,
                p.expires_at,
                p.grace_until,
                p.payment_type,
                p.payment_at,
                p.updated_at as plan_updated_at
            FROM users u
            LEFT JOIN user_plans p ON u.id = p.user_id
            ORDER BY u.id DESC
        `);

        const formattedUsers = users.map(user => ({
            id: user.id,
            email: user.email,
            user_uuid: user.user_uuid,
            user_created_at: user.user_created_at,
            user_created_at_date: user.user_created_at ? new Date(user.user_created_at).toISOString() : null,
            plan: {
                plan_gb: user.plan_gb,
                status: user.plan_status,
                trial_until: user.trial_until,
                trial_until_date: user.trial_until ? new Date(user.trial_until).toISOString() : null,
                expires_at: user.expires_at,
                expires_at_date: user.expires_at ? new Date(user.expires_at).toISOString() : null,
                grace_until: user.grace_until,
                payment_type: user.payment_type,
                payment_at: user.payment_at,
                payment_at_date: user.payment_at ? new Date(user.payment_at).toISOString() : null,
                updated_at: user.plan_updated_at,
                updated_at_date: user.plan_updated_at ? new Date(user.plan_updated_at).toISOString() : null,
            },
        }));

        return res.json({
            total_users: formattedUsers.length,
            users: formattedUsers,
        });
    } catch (e) {
        console.error('[Admin] list users error', e);
        return res.status(500).json({ error: 'Server error', details: e?.message });
    }
});

// Admin API: delete user completely
app.post('/admin/api/user/delete', adminAuth, async (req, res) => {
    try {
        const { userId, deleteFiles } = req.body;
        
        if (!userId || typeof userId !== 'number') {
            return res.status(400).json({ error: 'userId (number) required' });
        }

        // Get user info first
        const user = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [userId]);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get all devices for this user
        const devices = await dbAllAsync(`SELECT * FROM devices WHERE user_id = ?`, [userId]);
        
        // Get user key for file deletion
        const userKey = user.user_uuid || String(userId);
        
        const deletedItems = {
            user: user.email || user.user_uuid,
            userId: userId,
            devices: devices.length,
            filesDeleted: false,
            directories: []
        };

        // Delete files from disk if requested
        if (deleteFiles) {
            const dirsToDelete = new Set();
            
            // Collect all possible user keys (old uuid folders + new numeric id folders)
            const possibleKeys = new Set();
            possibleKeys.add(String(userId)); // numeric user id
            if (user.user_uuid) possibleKeys.add(user.user_uuid); // user_uuid
            
            // Also add device UUIDs as they may have been used as folder keys
            for (const device of devices) {
                if (device.device_uuid) {
                    possibleKeys.add(device.device_uuid);
                }
            }
            
            // Check all possible keys in CLOUD_DIR/users/
            for (const key of possibleKeys) {
                const cloudDir = path.join(CLOUD_DIR, 'users', key);
                if (fs.existsSync(cloudDir)) {
                    dirsToDelete.add(cloudDir);
                }
            }
            
            // Check all possible keys in CHUNKS_DIR/users/ (if separate)
            if (CHUNKS_DIR) {
                for (const key of possibleKeys) {
                    const chunksDir = path.join(CHUNKS_DIR, 'users', key);
                    if (fs.existsSync(chunksDir)) {
                        dirsToDelete.add(chunksDir);
                    }
                }
            }
            
            // Device upload directories in UPLOAD_DIR
            for (const device of devices) {
                if (device.device_uuid) {
                    const deviceDir = path.join(UPLOAD_DIR, device.device_uuid);
                    if (fs.existsSync(deviceDir)) {
                        dirsToDelete.add(deviceDir);
                    }
                }
            }
            
            // Delete all found directories
            for (const dir of dirsToDelete) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true });
                    deletedItems.directories.push(dir);
                    console.log(`[Admin Delete] Removed directory: ${dir}`);
                } catch (e) {
                    console.error(`[Admin Delete] Failed to remove ${dir}:`, e.message);
                }
            }
            
            deletedItems.filesDeleted = dirsToDelete.size > 0;
            deletedItems.keysChecked = Array.from(possibleKeys);
        }

        // Delete from database (order matters due to foreign keys)
        await dbRunAsync(`DELETE FROM cloud_chunks WHERE user_id = ?`, [userId]);
        await dbRunAsync(`DELETE FROM user_plans WHERE user_id = ?`, [userId]);
        await dbRunAsync(`DELETE FROM devices WHERE user_id = ?`, [userId]);
        await dbRunAsync(`DELETE FROM users WHERE id = ?`, [userId]);

        console.log(`[Admin Delete] User ${userId} (${user.email || user.user_uuid}) deleted completely`);
        
        return res.json({ 
            ok: true, 
            message: `User ${userId} deleted successfully`,
            deleted: deletedItems
        });
    } catch (e) {
        console.error('[Admin] delete user error', e);
        return res.status(500).json({ error: 'Server error', details: e?.message });
    }
});

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

// ============================================================================
// SECURITY CONFIGURATION
// ============================================================================

// Email verification: set to true to require email verification before login
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true' || false;

// Country/geo verification: require re-verification when logging in from a new country
// DISABLED for development - set to true in production if needed
const REQUIRE_COUNTRY_VERIFICATION = false; // process.env.REQUIRE_COUNTRY_VERIFICATION === 'true';

// Get country from IP using free ip-api.com (no API key needed)
const getCountryFromIP = async (ip) => {
    try {
        // Skip for localhost/private IPs
        if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
            return null;
        }
        // Clean IP (remove ::ffff: prefix for IPv4-mapped IPv6)
        const cleanIp = ip.replace(/^::ffff:/, '');
        const response = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode`, { timeout: 5000 });
        if (response.data && response.data.status === 'success') {
            return { country: response.data.country, countryCode: response.data.countryCode };
        }
    } catch (e) {
        console.log('[Geo] IP lookup failed:', e.message);
    }
    return null;
};

// Generate 6-digit verification code
const generateVerificationCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// In-memory store for pending verifications (email and country)
// In production, use Redis or database for persistence across restarts
const pendingVerifications = new Map();

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

const capacityDir = path.dirname(CAPACITY_JSON_PATH);
if (!fs.existsSync(capacityDir)) {
    fs.mkdirSync(capacityDir, { recursive: true });
}

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Database Setup
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log(`Connected to SQLite database at ${DB_PATH}`);
});

// SQLite concurrency tuning for single-server deployments.
// WAL reduces write contention; busy_timeout avoids transient SQLITE_BUSY under load.
db.serialize(() => {
    db.run(`PRAGMA journal_mode=WAL`);
    db.run(`PRAGMA synchronous=NORMAL`);
    db.run(`PRAGMA busy_timeout=5000`);
});

const dbGetAsync = (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
    });
});

const dbRunAsync = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
    });
});

const dbAllAsync = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(Array.isArray(rows) ? rows : []);
    });
});

const ensurePlanRow = async (userId) => {
    const existing = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
    if (existing) return existing;
    const now = Date.now();
    await dbRunAsync(
        `INSERT INTO user_plans (user_id, status, trial_until, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at`,
        [userId, 'none', null, now]
    );
    return await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
};

const resolveSubscriptionState = async (userId) => {
    const now = Date.now();
    const row = await ensurePlanRow(userId);
    if (!row) return { allowed: false, status: 'none' };

    const expiresAt = typeof row.expires_at === 'number' ? row.expires_at : (row.expires_at ? Number(row.expires_at) : null);
    const graceUntil = typeof row.grace_until === 'number' ? row.grace_until : (row.grace_until ? Number(row.grace_until) : null);
    const deletedAt = typeof row.deleted_at === 'number' ? row.deleted_at : (row.deleted_at ? Number(row.deleted_at) : null);
    const trialUntil = typeof row.trial_until === 'number' ? row.trial_until : (row.trial_until ? Number(row.trial_until) : null);

    if (deletedAt && deletedAt > 0) {
        return {
            allowed: false,
            status: 'deleted',
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            deletedAt,
            planGb: row.plan_gb || null,
            paymentType: row.payment_type || null,
        };
    }

    const complimentaryMs = Math.max(0, TRIAL_COMPLIMENTARY_DAYS) * 24 * 60 * 60 * 1000;
    const complimentaryUntil = trialUntil ? (trialUntil + complimentaryMs) : null;

    if (trialUntil && trialUntil > now) {
        return {
            allowed: true,
            status: 'trial',
            trialUntil,
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
            paymentType: row.payment_type || null,
            complimentaryUntil,
        };
    }

    // Complimentary window after trial for sync-only access
    if (row.status === 'trial' && trialUntil && trialUntil > 0 && complimentaryUntil && now <= complimentaryUntil) {
        // Allow read/sync, block uploads via requireUploadSubscription
        return {
            allowed: true,
            status: 'trial_complimentary',
            trialUntil,
            complimentaryUntil,
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
            paymentType: row.payment_type || null,
        };
    }

    // Complimentary ended – clear plan selection to free it up
    if (row.status === 'trial' && trialUntil && trialUntil > 0 && complimentaryUntil && complimentaryUntil < now) {
        try {
            const updatedAt = Date.now();
            await dbRunAsync(
                `UPDATE user_plans SET status = ?, plan_gb = NULL, trial_until = NULL, grace_until = NULL, expires_at = NULL, updated_at = ? WHERE user_id = ?`,
                ['trial_complimentary_expired', updatedAt, userId]
            );
        } catch (e) {
            // ignore
        }
        return {
            allowed: false,
            status: 'trial_complimentary_expired',
            trialUntil,
            complimentaryUntil,
            expiresAt: null,
            graceUntil: null,
            planGb: null,
            paymentType: row.payment_type || null,
        };
    }

    if (expiresAt && expiresAt > 0 && expiresAt <= now) {
        const graceMs = Math.max(0, SUBSCRIPTION_GRACE_DAYS) * 24 * 60 * 60 * 1000;
        const gu = graceUntil && graceUntil > 0 ? graceUntil : (expiresAt + graceMs);
        if (!graceUntil || graceUntil <= 0) {
            const updatedAt = Date.now();
            await dbRunAsync(
                `UPDATE user_plans SET status = ?, grace_until = ?, updated_at = ? WHERE user_id = ?`,
                ['grace', gu, updatedAt, userId]
            );
        }
        const allowedInGrace = gu && gu > 0 ? now <= gu : false;
        return {
            allowed: allowedInGrace,
            status: allowedInGrace ? 'grace' : 'grace_expired',
            expiresAt,
            graceUntil: gu,
            planGb: row.plan_gb || null,
            paymentType: row.payment_type || null,
        };
    }

    if (row.status === 'active') {
        return {
            allowed: true,
            status: 'active',
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
            paymentType: row.payment_type || null,
        };
    }

    return {
        allowed: false,
        status: row.status || 'none',
        trialUntil: trialUntil || null,
        expiresAt: expiresAt || null,
        graceUntil: graceUntil || null,
        planGb: row.plan_gb || null,
        paymentType: row.payment_type || null,
    };
};

// Allow read-only access to StealthCloud data even without an active subscription.
// We only block access after the data has been deleted server-side.
const blockDeletedSubscription = async (req, res, next) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        if (st.status === 'deleted') {
            return res.status(410).json({
                error: 'Data deleted',
                code: 'SUBSCRIPTION_DATA_DELETED',
                deletedAt: st.deletedAt,
            });
        }
        return next();
    } catch (e) {
        return res.status(500).json({ error: 'Subscription check failed' });
    }
};

const requireActiveSubscription = async (req, res, next) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        if (st.allowed) return next();

        if (st.status === 'trial_complimentary') {
            return next(); // allow sync/read during complimentary window
        }

        if (st.status === 'grace' || st.status === 'grace_expired') {
            return res.status(402).json({
                error: 'Subscription expired',
                code: 'SUBSCRIPTION_EXPIRED',
                expiresAt: st.expiresAt,
                graceUntil: st.graceUntil,
                deleteInDays: SUBSCRIPTION_GRACE_DAYS,
            });
        }

        if (st.status === 'trial_expired' || st.status === 'trial_complimentary_expired') {
            return res.status(402).json({
                error: 'Trial expired',
                code: 'TRIAL_EXPIRED',
                trialUntil: st.trialUntil,
                complimentaryUntil: st.complimentaryUntil || null,
            });
        }

        if (st.status === 'deleted') {
            return res.status(410).json({
                error: 'Data deleted',
                code: 'SUBSCRIPTION_DATA_DELETED',
                deletedAt: st.deletedAt,
            });
        }

        return res.status(402).json({
            error: 'Subscription required',
            code: 'SUBSCRIPTION_REQUIRED',
        });
    } catch (e) {
        return res.status(500).json({ error: 'Subscription check failed' });
    }
};

// Uploads are more restrictive than read-only sync.
// Policy: active + trial can upload; grace/trial_expired can only sync/restore.
const requireUploadSubscription = async (req, res, next) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        if (st.status === 'active' || st.status === 'trial') return next();

        if (st.status === 'trial_complimentary') {
            return res.status(402).json({
                error: 'Trial complimentary window (sync-only)',
                code: 'TRIAL_COMPLIMENTARY_SYNC_ONLY',
                trialUntil: st.trialUntil,
                complimentaryUntil: st.complimentaryUntil || null,
            });
        }

        if (st.status === 'grace' || st.status === 'grace_expired') {
            return res.status(402).json({
                error: 'Subscription expired (sync-only)',
                code: 'SUBSCRIPTION_EXPIRED_SYNC_ONLY',
                expiresAt: st.expiresAt,
                graceUntil: st.graceUntil,
                deleteInDays: SUBSCRIPTION_GRACE_DAYS,
            });
        }

        if (st.status === 'trial_expired') {
            return res.status(402).json({
                error: 'Trial expired (sync-only)',
                code: 'TRIAL_EXPIRED_SYNC_ONLY',
                trialUntil: st.trialUntil,
            });
        }

        if (st.status === 'deleted') {
            return res.status(410).json({
                error: 'Data deleted',
                code: 'SUBSCRIPTION_DATA_DELETED',
                deletedAt: st.deletedAt,
            });
        }

        return res.status(402).json({
            error: 'Subscription required',
            code: 'SUBSCRIPTION_REQUIRED',
        });
    } catch (e) {
        return res.status(500).json({ error: 'Subscription check failed' });
    }
};

db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT,
        email TEXT UNIQUE,
        password TEXT,
        hardware_device_id TEXT,
        created_at INTEGER
    )`);

    // Migrate existing DBs: add hardware_device_id column if missing
    db.all(`PRAGMA table_info(users)`, [], (err, cols) => {
        if (err) return;
        const names = Array.isArray(cols) ? cols.map(c => c && c.name).filter(Boolean) : [];
        if (!names.includes('hardware_device_id')) {
            db.run(`ALTER TABLE users ADD COLUMN hardware_device_id TEXT`, [], () => {});
        }
        if (!names.includes('created_at')) {
            db.run(`ALTER TABLE users ADD COLUMN created_at INTEGER`, [], () => {
                const now = Date.now();
                db.run(`UPDATE users SET created_at = ? WHERE created_at IS NULL`, [now]);
            });
        }
        // Security: email verification status
        if (!names.includes('email_verified')) {
            db.run(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`, [], () => {});
        }
        // Security: last known country code for geo verification
        if (!names.includes('last_country_code')) {
            db.run(`ALTER TABLE users ADD COLUMN last_country_code TEXT`, [], () => {});
        }
        // Security: list of verified country codes (JSON array)
        if (!names.includes('verified_countries')) {
            db.run(`ALTER TABLE users ADD COLUMN verified_countries TEXT DEFAULT '[]'`, [], () => {});
        }
    });

    // Subscription/tier state (for StealthCloud / RevenueCat). Kept separate from auth rows.
    db.run(`CREATE TABLE IF NOT EXISTS user_plans (
        user_id INTEGER PRIMARY KEY,
        plan_gb INTEGER,
        rc_app_user_id TEXT,
        rc_product_id TEXT,
        rc_entitlement TEXT,
        status TEXT,
        expires_at INTEGER,
        grace_until INTEGER,
        trial_until INTEGER,
        deleted_at INTEGER,
        payment_type TEXT,
        payment_at INTEGER,
        updated_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Migrate existing DBs: add missing columns to user_plans
    db.all(`PRAGMA table_info(user_plans)`, [], (err, cols) => {
        if (err) return;
        const names = Array.isArray(cols) ? cols.map(c => c && c.name).filter(Boolean) : [];
        if (!names.includes('grace_until')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN grace_until INTEGER`, [], () => {});
        }
        if (!names.includes('trial_until')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN trial_until INTEGER`, [], () => {});
        }
        if (!names.includes('deleted_at')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN deleted_at INTEGER`, [], () => {});
        }
        if (!names.includes('payment_type')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN payment_type TEXT`, [], () => {});
        }
        if (!names.includes('payment_at')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN payment_at INTEGER`, [], () => {});
        }
    });

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
        perceptual_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, filename),
        UNIQUE(user_id, file_hash)
    )`);
    
    // Add perceptual_hash column if it doesn't exist (migration for existing DBs)
    db.run(`ALTER TABLE files ADD COLUMN perceptual_hash TEXT`, (err) => {
        // Ignore error if column already exists
    });

    // Platform-specific hashes for cross-platform dedup fallback
    // When a device syncs a file, it can submit its platform's computed hash
    // Next sync from same platform can use this for fast pre-download skip
    db.run(`CREATE TABLE IF NOT EXISTS platform_hashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT,
        platform TEXT,
        perceptual_hash TEXT,
        file_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, filename, platform)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cloud_chunks (
        user_id INTEGER,
        chunk_id TEXT,
        size INTEGER,
        created_at INTEGER,
        PRIMARY KEY(user_id, chunk_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cloud_device_state (
        user_id INTEGER,
        device_uuid TEXT,
        state_json TEXT,
        updated_at INTEGER,
        PRIMARY KEY(user_id, device_uuid),
        FOREIGN KEY(user_id) REFERENCES users(id)
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
    // StealthCloud files are stored per USER (not per device) so all devices
    // for the same account can access the same files.
    // Use user_id as the primary key for storage.
    if (user && user.id) {
        return String(user.id);
    }
    
    // Fallback to device_uuid only if user_id is not available (legacy)
    const deviceKey = (user && (user.device_uuid || user.deviceUuid)) ? String(user.device_uuid || user.deviceUuid) : '';
    const safeDevice = deviceKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (safeDevice) return safeDevice;

    const key = (user && (user.user_uuid || user.userUuid)) ? String(user.user_uuid || user.userUuid) : '';
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    return safe || 'unknown';
};

const ensureStealthCloudUserDirs = (user) => {
    const key = getStealthCloudUserKey(user);
    const userDir = path.join(CLOUD_DIR, 'users', key);
    // Chunks go to HDD RAID10 if CHUNKS_DIR is set, otherwise same as CLOUD_DIR
    const chunksDir = CHUNKS_DIR 
        ? path.join(CHUNKS_DIR, 'users', key, 'chunks')
        : path.join(userDir, 'chunks');
    const manifestsDir = path.join(userDir, 'manifests'); // Manifests always on NVMe (CLOUD_DIR)
    if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });
    if (!fs.existsSync(manifestsDir)) fs.mkdirSync(manifestsDir, { recursive: true });

    // Backward-compat migration: move files from old device_uuid or user_uuid folders to user_id folder
    const oldKeys = [];
    // Migration from device_uuid folders (old per-device storage)
    if (user && (user.device_uuid || user.deviceUuid)) {
        const oldDeviceUuid = String(user.device_uuid || user.deviceUuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
        if (oldDeviceUuid) oldKeys.push(oldDeviceUuid);
    }
    // Migration from user_uuid folders
    if (user && (user.user_uuid || user.userUuid)) {
        const oldUserUuid = String(user.user_uuid || user.userUuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
        if (oldUserUuid) oldKeys.push(oldUserUuid);
    }
    oldKeys
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .filter(k => k !== key)
        .forEach(oldKey => {
            // Safe migration helper: copy first, then delete source only if copy succeeded
            const safeMigrateFile = (src, dst) => {
                if (!fs.existsSync(src)) return;
                if (fs.existsSync(dst)) return; // Already migrated or exists
                try {
                    // Copy file to new location
                    fs.copyFileSync(src, dst);
                    // Verify copy succeeded before deleting source
                    if (fs.existsSync(dst)) {
                        const srcSize = fs.statSync(src).size;
                        const dstSize = fs.statSync(dst).size;
                        if (srcSize === dstSize) {
                            fs.unlinkSync(src); // Safe to delete source
                        }
                    }
                } catch (e) {
                    console.error(`[Migration] Failed to migrate ${src} -> ${dst}:`, e.message);
                    // Source file is preserved on error
                }
            };

            // Migrate from CLOUD_DIR (NVMe) - manifests and possibly chunks
            const oldDir = path.join(CLOUD_DIR, 'users', oldKey);
            if (fs.existsSync(oldDir)) {
                const oldChunksCloud = path.join(oldDir, 'chunks');
                const oldManifests = path.join(oldDir, 'manifests');
                try {
                    if (fs.existsSync(oldChunksCloud)) {
                        fs.readdirSync(oldChunksCloud).forEach(f => {
                            safeMigrateFile(path.join(oldChunksCloud, f), path.join(chunksDir, f));
                        });
                    }
                    if (fs.existsSync(oldManifests)) {
                        fs.readdirSync(oldManifests).forEach(f => {
                            safeMigrateFile(path.join(oldManifests, f), path.join(manifestsDir, f));
                        });
                    }
                } catch (e) {
                    console.error(`[Migration] Error reading old directory ${oldDir}:`, e.message);
                }
            }
            // Migrate from CHUNKS_DIR (HDD RAID) if separate from CLOUD_DIR
            if (CHUNKS_DIR) {
                const oldChunksHdd = path.join(CHUNKS_DIR, 'users', oldKey, 'chunks');
                if (fs.existsSync(oldChunksHdd)) {
                    try {
                        fs.readdirSync(oldChunksHdd).forEach(f => {
                            safeMigrateFile(path.join(oldChunksHdd, f), path.join(chunksDir, f));
                        });
                    } catch (e) {
                        console.error(`[Migration] Error reading old HDD chunks ${oldChunksHdd}:`, e.message);
                    }
                }
            }
        });

    // Raw files go to RAID10 alongside chunks (same storage tier as chunks)
    const rawDir = CHUNKS_DIR 
        ? path.join(CHUNKS_DIR, 'users', key, 'raw')
        : path.join(userDir, 'raw');
    const rawMetaDir = path.join(userDir, 'raw-meta'); // Metadata for raw files (thumbnails, EXIF) - on NVMe
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
    if (!fs.existsSync(rawMetaDir)) fs.mkdirSync(rawMetaDir, { recursive: true });

    return { userDir, chunksDir, manifestsDir, rawDir, rawMetaDir };
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

// Root: Serve company visit card page
app.get('/', (req, res) => {
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(publicIndexPath)) {
        return res.sendFile(publicIndexPath);
    }
    res.status(403).send('Access Forbidden');
});

app.get('/health', (req, res) => {
    res.status(200).json({ ok: true });
});

const readCapacityJson = () => {
    try {
        if (!fs.existsSync(CAPACITY_JSON_PATH)) return null;
        const raw = fs.readFileSync(CAPACITY_JSON_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        return null;
    }
};

const getUserPlanGb = async (userId) => {
    const row = await ensurePlanRow(userId);
    const planGb = row && row.plan_gb !== null && row.plan_gb !== undefined ? Number(row.plan_gb) : null;
    return Number.isFinite(planGb) ? planGb : null;
};

const getUserUsedBytes = async (userId) => {
    const row = await dbGetAsync(
        `SELECT COALESCE(SUM(size), 0) AS usedBytes FROM cloud_chunks WHERE user_id = ?`,
        [userId]
    );
    const used = row && row.usedBytes !== undefined && row.usedBytes !== null ? Number(row.usedBytes) : 0;
    return Number.isFinite(used) ? used : 0;
};

const getUserQuotaBytes = async (userId) => {
    const planGb = await getUserPlanGb(userId);
    if (!planGb) return 0;
    const GB = 1000 * 1000 * 1000;
    const planBytes = Math.floor(planGb * GB);
    return planBytes + USER_QUOTA_MARGIN_BYTES;
};

const getServerFreeBytes = () => {
    const payload = readCapacityJson();
    const free = payload && typeof payload.freeBytes === 'number' ? payload.freeBytes : null;
    return typeof free === 'number' && Number.isFinite(free) ? free : null;
};

const enforceUserQuotaForIncomingBytes = async ({ userId, incomingBytes }) => {
    const planGb = await getUserPlanGb(userId);
    const GB = 1000 * 1000 * 1000;
    const planBytes = planGb ? Math.floor(Number(planGb) * GB) : 0;
    const quotaBytes = planBytes ? (planBytes + USER_QUOTA_MARGIN_BYTES) : 0;
    const usedBytes = await getUserUsedBytes(userId);
    const inc = typeof incomingBytes === 'number' && Number.isFinite(incomingBytes) ? incomingBytes : 0;
    const allowed = quotaBytes <= 0 ? true : (usedBytes + inc + USER_QUOTA_MARGIN_BYTES) <= quotaBytes;
    return {
        allowed,
        quotaBytes,
        usedBytes,
        remainingBytes: Math.max(0, planBytes - usedBytes),
        marginBytes: USER_QUOTA_MARGIN_BYTES,
    };
};

// Concurrency hardening:
// - Without this lock, two parallel chunk uploads for the same user can both pass the quota check
//   before either inserts into cloud_chunks, letting the user exceed their tier.
// - This is an in-memory mutex (single-node). If you run multiple Node processes behind a load balancer,
//   you should replace this with a distributed lock or an atomic quota reservation table.
const cloudUploadLocks = new Map();
const cloudUploadReservedBytes = new Map();

const acquireCloudUploadLock = async (userId) => {
    const key = String(userId);
    const prev = cloudUploadLocks.get(key) || Promise.resolve();
    let releaseNext;
    const gate = new Promise((resolve) => {
        releaseNext = resolve;
    });
    const chain = prev.then(() => gate);
    cloudUploadLocks.set(key, chain);
    await prev;

    let released = false;
    return () => {
        if (released) return;
        released = true;
        try {
            releaseNext();
        } catch (e) {
            // ignore
        }
        setTimeout(() => {
            if (cloudUploadLocks.get(key) === chain) {
                cloudUploadLocks.delete(key);
            }
        }, 0);
    };
};

const lockStealthCloudUploadForUser = async (req, res, next) => {
    try {
        if (!ENABLE_CLOUD_UPLOAD_LOCK) return next();
        if (!req.user || !req.user.id) return next();
        const release = await acquireCloudUploadLock(req.user.id);
        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            release();
        };
        res.on('finish', cleanup);
        res.on('close', cleanup);
        req.on('aborted', cleanup);
        return next();
    } catch (e) {
        return next(e);
    }
};

// Capacity endpoint (recommended for proxies that only forward /api/*)
app.get('/api/capacity', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const payload = readCapacityJson();
    if (!payload) return res.status(404).json({ error: 'Capacity not available' });
    return res.json(payload);
});

// Public well-known capacity JSON (mobile app can call this directly)
app.get('/.well-known/photolynk-capacity.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const payload = readCapacityJson();
    if (!payload) return res.status(404).json({ error: 'Capacity not available' });
    return res.json(payload);
});

app.get('/.well-known/photosync-capacity.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const payload = readCapacityJson();
    if (!payload) return res.status(404).json({ error: 'Capacity not available' });
    return res.json(payload);
});

app.get('/api/cloud/usage', authenticateToken, async (req, res) => {
    try {
        const planGb = await getUserPlanGb(req.user.id);
        const GB = 1000 * 1000 * 1000;
        const planBytes = planGb ? Math.floor(Number(planGb) * GB) : 0;
        const quotaBytes = planBytes ? (planBytes + USER_QUOTA_MARGIN_BYTES) : 0;
        const usedBytes = await getUserUsedBytes(req.user.id);
        const subscription = await resolveSubscriptionState(req.user.id);
        const serverFreeBytes = getServerFreeBytes();

        return res.json({
            planGb,
            quotaBytes,
            usedBytes,
            remainingBytes: Math.max(0, planBytes - usedBytes),
            marginBytes: USER_QUOTA_MARGIN_BYTES,
            subscription,
            serverFreeBytes,
        });
    } catch (e) {
        return res.status(500).json({ error: 'Usage unavailable' });
    }
});

// Register User
app.post('/api/register', authRateLimiter, async (req, res) => {
    const { email, password, plan_gb, hardware_device_id } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const normalizedEmail = String(email).toLowerCase().trim();
    const hwDeviceId = hardware_device_id ? String(hardware_device_id).trim() : null;

    const normalizedPlanGb = normalizeTierGb(plan_gb);

    try {
        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const u = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
        db.run(`INSERT INTO users (user_uuid, email, password, hardware_device_id) VALUES (?, ?, ?, ?)`, [u, normalizedEmail, hashedPassword, hwDeviceId], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'Email already exists' });
                return res.status(500).json({ error: err.message });
            }

            const newUserId = this.lastID;
            const now = Date.now();
            const trialMs = Math.max(0, TRIAL_DAYS) * 24 * 60 * 60 * 1000;
            const trialUntil = (normalizedPlanGb && trialMs > 0) ? (now + trialMs) : null;
            const initialStatus = trialUntil ? 'trial' : 'none';
            db.run(
                `INSERT INTO user_plans (user_id, plan_gb, status, trial_until, rc_app_user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET plan_gb=COALESCE(excluded.plan_gb, plan_gb), status=excluded.status, trial_until=excluded.trial_until, rc_app_user_id=excluded.rc_app_user_id, updated_at=excluded.updated_at`,
                [newUserId, normalizedPlanGb, initialStatus, trialUntil, normalizedEmail, now]
            );

            // Generate token for auto-login after registration (same as login flow)
            const device_uuid = req.body.device_uuid || req.body.deviceUuid || u;
            const token = jwt.sign({ id: newUserId, user_uuid: u, email: normalizedEmail, device_uuid: device_uuid }, JWT_SECRET, { expiresIn: '30d' });
            res.status(201).json({ message: 'User registered successfully', token, userId: newUserId });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Login & Bind Device
app.post('/api/login', authRateLimiter, async (req, res) => {
    const { email, password, device_uuid, device_name, country_verification_code } = req.body;
    if (!email || !password || !device_uuid) return res.status(400).json({ error: 'Missing credentials or device ID' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT * FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        // Check email verification (if enabled)
        if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
            return res.status(403).json({ 
                error: 'Email not verified', 
                requiresEmailVerification: true,
                hint: 'Please verify your email before logging in'
            });
        }

        // Country/geo verification check
        let currentCountry = null;
        if (REQUIRE_COUNTRY_VERIFICATION) {
            const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
            currentCountry = await getCountryFromIP(clientIp);
            
            if (currentCountry && currentCountry.countryCode) {
                const verifiedCountries = JSON.parse(user.verified_countries || '[]');
                const isNewCountry = !verifiedCountries.includes(currentCountry.countryCode) && 
                                     user.last_country_code && 
                                     user.last_country_code !== currentCountry.countryCode;
                
                if (isNewCountry) {
                    const verifyKey = `country:${user.id}:${currentCountry.countryCode}`;
                    const pending = pendingVerifications.get(verifyKey);
                    
                    // Check if verification code was provided
                    if (country_verification_code) {
                        if (pending && pending.code === country_verification_code && Date.now() < pending.expiresAt) {
                            // Code is valid - add country to verified list
                            verifiedCountries.push(currentCountry.countryCode);
                            db.run(`UPDATE users SET verified_countries = ?, last_country_code = ? WHERE id = ?`,
                                [JSON.stringify(verifiedCountries), currentCountry.countryCode, user.id]);
                            pendingVerifications.delete(verifyKey);
                            console.log(`[Geo] User ${user.id} verified new country: ${currentCountry.country}`);
                        } else {
                            return res.status(403).json({
                                error: 'Invalid or expired verification code',
                                requiresCountryVerification: true,
                                newCountry: currentCountry.country,
                                newCountryCode: currentCountry.countryCode
                            });
                        }
                    } else {
                        // Generate new verification code and send email
                        const code = generateVerificationCode();
                        pendingVerifications.set(verifyKey, {
                            code,
                            expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
                            country: currentCountry.country,
                            countryCode: currentCountry.countryCode
                        });
                        
                        console.log(`[Geo] New country login detected for user ${user.id}: ${currentCountry.country} (code: ${code})`);
                        // TODO: Send email with code (for now, log it)
                        // In production: await sendVerificationEmail(user.email, code, currentCountry.country);
                        
                        return res.status(403).json({
                            error: 'Login from new country detected',
                            requiresCountryVerification: true,
                            newCountry: currentCountry.country,
                            newCountryCode: currentCountry.countryCode,
                            message: `A verification code has been sent to your email. Please enter it to verify this login from ${currentCountry.country}.`
                        });
                    }
                }
            }
        }

        // Register/Update Device
        db.run(`INSERT OR IGNORE INTO devices (user_id, device_uuid, device_name) VALUES (?, ?, ?)`, 
            [user.id, device_uuid, device_name || 'Unknown Device'], 
            async (devErr) => {
                if (devErr) console.error('Device reg error:', devErr);

                const now = Date.now();
                try {
                    await ensurePlanRow(user.id);
                } catch (e) {
                    // ignore
                }
                // Backfill hardware_device_id for legacy accounts on login
                db.run(
                    `UPDATE users SET hardware_device_id = COALESCE(hardware_device_id, ?) WHERE id = ?`,
                    [device_uuid, user.id]
                );
                db.run(
                    `UPDATE user_plans SET rc_app_user_id = ?, updated_at = ? WHERE user_id = ?`,
                    [normalizedEmail, now, user.id]
                );
                
                // Update last known country
                if (currentCountry && currentCountry.countryCode) {
                    const verifiedCountries = JSON.parse(user.verified_countries || '[]');
                    if (!verifiedCountries.includes(currentCountry.countryCode)) {
                        verifiedCountries.push(currentCountry.countryCode);
                    }
                    db.run(`UPDATE users SET last_country_code = ?, verified_countries = ? WHERE id = ?`,
                        [currentCountry.countryCode, JSON.stringify(verifiedCountries), user.id]);
                }
                
                // Generate Token BOUND to this device
                const token = jwt.sign({ id: user.id, user_uuid: user.user_uuid, email: user.email, device_uuid: device_uuid }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ token, userId: user.id });
            }
        );
    });
});

// ============================================================================
// EMAIL VERIFICATION ENDPOINTS (inactive by default, ready to enable)
// ============================================================================

// Request email verification code
// POST /api/auth/request-email-verification
app.post('/api/auth/request-email-verification', authRateLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email, email_verified FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });
        
        if (user.email_verified) {
            return res.json({ message: 'Email already verified', alreadyVerified: true });
        }

        const code = generateVerificationCode();
        const verifyKey = `email:${user.id}`;
        pendingVerifications.set(verifyKey, {
            code,
            expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
            email: normalizedEmail
        });

        console.log(`[Email] Verification code for ${normalizedEmail}: ${code}`);
        // TODO: Send email with code
        // In production: await sendVerificationEmail(normalizedEmail, code);

        res.json({ message: 'Verification code sent to your email', codeSent: true });
    });
});

// Verify email with code
// POST /api/auth/verify-email
app.post('/api/auth/verify-email', authRateLimiter, async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email, email_verified FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        if (user.email_verified) {
            return res.json({ message: 'Email already verified', success: true });
        }

        const verifyKey = `email:${user.id}`;
        const pending = pendingVerifications.get(verifyKey);

        if (!pending || pending.code !== code || Date.now() > pending.expiresAt) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        // Mark email as verified
        db.run(`UPDATE users SET email_verified = 1 WHERE id = ?`, [user.id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: 'Failed to verify email' });
            
            pendingVerifications.delete(verifyKey);
            console.log(`[Email] User ${user.id} email verified: ${normalizedEmail}`);
            res.json({ message: 'Email verified successfully', success: true });
        });
    });
});

// ============================================================================
// COUNTRY VERIFICATION ENDPOINT
// ============================================================================

// Resend country verification code
// POST /api/auth/resend-country-code
app.post('/api/auth/resend-country-code', authRateLimiter, async (req, res) => {
    const { email, countryCode } = req.body;
    if (!email || !countryCode) return res.status(400).json({ error: 'Email and country code required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        const verifyKey = `country:${user.id}:${countryCode}`;
        const code = generateVerificationCode();
        
        pendingVerifications.set(verifyKey, {
            code,
            expiresAt: Date.now() + 15 * 60 * 1000,
            countryCode
        });

        console.log(`[Geo] Resent country verification code for ${normalizedEmail}: ${code}`);
        // TODO: Send email with code
        // In production: await sendVerificationEmail(normalizedEmail, code, countryCode);

        res.json({ message: 'Verification code resent', codeSent: true });
    });
});

// ============================================================================
// PASSWORD RESET
// ============================================================================

// Email-based Password Reset - Step 1: Request reset code
// POST /api/auth/request-password-reset
// Works for all server types (local/remote/stealthcloud)
app.post('/api/auth/request-password-reset', authRateLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        
        // Always return success to prevent email enumeration attacks
        if (!user) {
            console.log(`[Password Reset] Request for non-existent email: ${normalizedEmail}`);
            return res.json({ message: 'If an account exists with this email, a reset code has been sent', codeSent: true });
        }

        const code = generateVerificationCode();
        const verifyKey = `pwreset:${user.id}`;
        pendingVerifications.set(verifyKey, {
            code,
            expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
            email: normalizedEmail
        });

        console.log(`[Password Reset] Code for ${normalizedEmail}: ${code}`);
        // TODO: Send email with code
        // In production: await sendPasswordResetEmail(normalizedEmail, code);

        res.json({ message: 'If an account exists with this email, a reset code has been sent', codeSent: true });
    });
});

// Email-based Password Reset - Step 2: Verify code and reset password
// POST /api/auth/reset-password-with-code
app.post('/api/auth/reset-password-with-code', authRateLimiter, async (req, res) => {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
        return res.status(400).json({ error: 'Email, code, and new password required' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        const verifyKey = `pwreset:${user.id}`;
        const pending = pendingVerifications.get(verifyKey);

        if (!pending || pending.code !== code || Date.now() > pending.expiresAt) {
            return res.status(400).json({ error: 'Invalid or expired reset code' });
        }

        try {
            const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashedPassword, user.id], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: 'Failed to update password' });

                pendingVerifications.delete(verifyKey);
                console.log(`[Password Reset] Password updated for ${normalizedEmail} via email code`);
                res.json({ message: 'Password has been reset successfully', success: true });
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
});

// Device-bound Password Reset (legacy - still works)
// Allows password reset if the hardware_device_id matches the one stored during account creation
// This survives app reinstalls because it uses a persistent hardware identifier
app.post('/api/reset-password-device', authRateLimiter, async (req, res) => {
    const { email, hardware_device_id, newPassword } = req.body;
    if (!email || !hardware_device_id || !newPassword) {
        return res.status(400).json({ error: 'Email, device ID, and new password are required' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const hwDeviceId = String(hardware_device_id).trim();

    // Find user by email and check hardware_device_id
    db.get(`SELECT id, email, hardware_device_id FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        // Check if hardware_device_id was stored during registration
        if (!user.hardware_device_id) {
            return res.status(403).json({ 
                error: 'Password reset is not available for this account. The account was created before device-bound reset was enabled.',
                hint: 'no_hardware_id_stored'
            });
        }

        // Compare hardware device IDs
        if (user.hardware_device_id !== hwDeviceId) {
            return res.status(403).json({ 
                error: 'Password reset is only allowed from the device that created this account',
                hint: 'device_mismatch'
            });
        }

        // Device matches - allow password reset
        try {
            const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashedPassword, user.id], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: 'Failed to update password' });

                console.log(`[PASSWORD RESET] Password updated for ${normalizedEmail} via hardware device-bound reset`);
                res.json({ message: 'Password has been reset successfully' });
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
});

app.get('/api/subscription/status', authenticateToken, async (req, res) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        return res.json(st);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to resolve subscription status' });
    }
});

// Check if user can downgrade to a specific tier based on current storage usage
const canDowngradeToTier = async (userId, targetTierGb) => {
    const usedBytes = await getUserUsedBytes(userId);
    const GB = 1000 * 1000 * 1000;
    const targetBytes = targetTierGb * GB;
    // Allow downgrade only if used storage is less than target tier capacity
    return usedBytes < targetBytes;
};

// Get minimum required tier based on current storage usage
const getMinRequiredTier = async (userId) => {
    const usedBytes = await getUserUsedBytes(userId);
    const GB = 1000 * 1000 * 1000;
    const tiers = [100, 200, 400, 1000];
    for (const tier of tiers) {
        if (usedBytes < tier * GB) return tier;
    }
    return 1000; // Max tier if usage exceeds all
};

// API endpoint to check downgrade eligibility
app.get('/api/subscription/downgrade-check', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const usedBytes = await getUserUsedBytes(userId);
        const currentPlan = await getUserPlanGb(userId);
        const minRequiredTier = await getMinRequiredTier(userId);
        const GB = 1000 * 1000 * 1000;
        
        // Check each tier
        const tiers = [100, 200, 400, 1000];
        const tierStatus = {};
        for (const tier of tiers) {
            const tierBytes = tier * GB;
            tierStatus[tier] = {
                allowed: usedBytes < tierBytes,
                tierBytes,
                usedBytes,
                usedPercent: tierBytes > 0 ? Math.round((usedBytes / tierBytes) * 100) : 0,
            };
        }
        
        return res.json({
            currentPlanGb: currentPlan,
            usedBytes,
            minRequiredTier,
            tiers: tierStatus,
        });
    } catch (e) {
        console.error('[Downgrade check] error', e);
        return res.status(500).json({ error: 'Downgrade check failed' });
    }
});

app.post('/api/subscription/sync', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { productId, tierGb, entitlementId, paymentType } = req.body || {};
        const tier = normalizeTierGb(tierGb) || normalizeTierGb(inferTierGbFromProductId(productId));
        if (!tier) return res.status(400).json({ error: 'Invalid or missing tier' });

        // DOWNGRADE GUARD: Reject if user's storage exceeds target tier
        const currentPlanGb = await getUserPlanGb(userId);
        if (currentPlanGb && tier < currentPlanGb) {
            const canDowngrade = await canDowngradeToTier(userId, tier);
            if (!canDowngrade) {
                const usedBytes = await getUserUsedBytes(userId);
                const minTier = await getMinRequiredTier(userId);
                return res.status(400).json({
                    error: 'Cannot downgrade: storage usage exceeds target plan capacity',
                    code: 'DOWNGRADE_BLOCKED',
                    usedBytes,
                    targetTierGb: tier,
                    minRequiredTier: minTier,
                });
            }
        }

        await ensurePlanRow(userId);
        const now = Date.now();
        await dbRunAsync(
            `UPDATE user_plans
                SET plan_gb = ?,
                    status = 'active',
                    rc_product_id = ?,
                    rc_entitlement = COALESCE(?, rc_entitlement),
                    rc_app_user_id = COALESCE(rc_app_user_id, ?),
                    payment_type = ?,
                    payment_at = ?,
                    grace_until = NULL,
                    deleted_at = NULL,
                    updated_at = ?
              WHERE user_id = ?`,
            [
                tier,
                productId || null,
                entitlementId || null,
                req.user.email || null,
                paymentType || null,
                now,
                now,
                userId,
            ]
        );

        const plan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
        return res.json({ ok: true, plan });
    } catch (e) {
        console.error('[Subscription sync] error', e);
        return res.status(500).json({ error: 'Sync failed' });
    }
});

app.post('/api/revenuecat/webhook', async (req, res) => {
    try {
        if (REVENUECAT_WEBHOOK_SECRET) {
            const auth = (req.headers['authorization'] || '').toString();
            if (auth !== `Bearer ${REVENUECAT_WEBHOOK_SECRET}`) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }

        const event = req.body || {};
        const appUserId = event && (event.app_user_id || event.appUserId) ? String(event.app_user_id || event.appUserId) : '';
        if (!appUserId) return res.status(400).json({ error: 'Missing app_user_id' });

        const expiresAtMs = event && (event.expiration_at_ms || event.expirationAtMs) ? Number(event.expiration_at_ms || event.expirationAtMs) : null;
        const productId = event && (event.product_id || event.productId) ? String(event.product_id || event.productId) : null;
        const entitlementId = event && (event.entitlement_id || event.entitlementId) ? String(event.entitlement_id || event.entitlementId) : null;
        const tierGbFromEvent = normalizeTierGb(event && (event.plan_gb || event.planGb || event.tier_gb || event.tierGb));
        const tierGb = tierGbFromEvent || normalizeTierGb(inferTierGbFromProductId(productId));

        const store = (event && (event.store || event.Store)) ? String(event.store || event.Store).toUpperCase() : '';
        const paymentType =
            store === 'APP_STORE' ? 'apple' :
            store === 'PLAY_STORE' ? 'google' :
            null;

        db.get(
            `SELECT up.user_id AS user_id
               FROM user_plans up
              WHERE up.rc_app_user_id = ?
              LIMIT 1`,
            [appUserId],
            async (err, row) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                if (!row || !row.user_id) return res.status(404).json({ error: 'User not found' });

                // DOWNGRADE GUARD: Reject if user's storage exceeds target tier
                if (tierGb) {
                    const currentPlanGb = await getUserPlanGb(row.user_id);
                    if (currentPlanGb && tierGb < currentPlanGb) {
                        const canDowngrade = await canDowngradeToTier(row.user_id, tierGb);
                        if (!canDowngrade) {
                            const usedBytes = await getUserUsedBytes(row.user_id);
                            const minTier = await getMinRequiredTier(row.user_id);
                            console.log(`[RevenueCat Webhook] DOWNGRADE BLOCKED: user ${row.user_id} tried ${currentPlanGb}GB -> ${tierGb}GB, used ${usedBytes} bytes, min tier ${minTier}GB`);
                            return res.status(400).json({
                                error: 'Cannot downgrade: storage usage exceeds target plan capacity',
                                code: 'DOWNGRADE_BLOCKED',
                                usedBytes,
                                targetTierGb: tierGb,
                                minRequiredTier: minTier,
                            });
                        }
                    }
                }

                const now = Date.now();
                const expiresMs = Number.isFinite(expiresAtMs) ? expiresAtMs : null;
                const isActive = expiresMs && expiresMs > now;

                if (isActive) {
                    await dbRunAsync(
                        `UPDATE user_plans
                            SET status = ?,
                                expires_at = ?,
                                grace_until = NULL,
                                deleted_at = NULL,
                                rc_product_id = ?,
                                rc_entitlement = ?,
                                payment_type = ?,
                                payment_at = ?,
                                plan_gb = COALESCE(?, plan_gb),
                                updated_at = ?
                          WHERE user_id = ?`,
                        ['active', expiresMs, productId, entitlementId, paymentType, now, tierGb, now, row.user_id]
                    );
                    return res.json({ ok: true });
                }

                const graceMs = Math.max(0, SUBSCRIPTION_GRACE_DAYS) * 24 * 60 * 60 * 1000;
                const graceUntil = (expiresMs && expiresMs > 0) ? (expiresMs + graceMs) : (now + graceMs);
                await dbRunAsync(
                    `UPDATE user_plans
                        SET status = ?,
                            expires_at = COALESCE(?, expires_at),
                            grace_until = COALESCE(grace_until, ?),
                            rc_product_id = ?,
                            rc_entitlement = ?,
                            payment_type = ?,
                            payment_at = ?,
                            updated_at = ?
                      WHERE user_id = ?`,
                    ['grace', expiresMs, graceUntil, productId, entitlementId, paymentType, now, now, row.user_id]
                );
                return res.json({ ok: true });
            }
        );
    } catch (e) {
        return res.status(500).json({ error: 'Webhook failed' });
    }
});

// ============================================================================
// SOLANA BLOCKCHAIN PAYMENT VERIFICATION
// ============================================================================
// Verifies SOL payments on Solana blockchain and activates subscriptions
// Payment wallet: 8uaqEooTysK7mtb5gLKMD1MJbsKVPoahEXVMAESwptMg

const SOLANA_PAYMENT_WALLET = 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU';
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const LAMPORTS_PER_SOL = 1000000000;

// Plan durations in milliseconds
const PLAN_DURATION_MS = {
    monthly: 30 * 24 * 60 * 60 * 1000,
    yearly: 365 * 24 * 60 * 60 * 1000,
};

// Verify Solana payment transaction
app.post('/api/solana/verify-payment', async (req, res) => {
    const { txSignature, tierGb, duration, solAmount, paymentWallet } = req.body;
    
    // Extract user from JWT token in Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization token required' });
    }
    
    const token = authHeader.substring(7);
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    if (!txSignature || !tierGb) {
        return res.status(400).json({ error: 'Missing required fields: txSignature, tierGb' });
    }
    
    // Validate payment wallet matches
    if (paymentWallet && paymentWallet !== SOLANA_PAYMENT_WALLET) {
        return res.status(400).json({ error: 'Invalid payment wallet' });
    }
    
    // Normalize tier
    const normalizedTier = normalizeTierGb(tierGb);
    if (!normalizedTier) {
        return res.status(400).json({ error: 'Invalid tier' });
    }
    
    try {
        // Find user by ID from JWT token
        const user = await dbGetAsync(`SELECT id, email FROM users WHERE id = ?`, [decoded.id]);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // DOWNGRADE GUARD: Reject if user's storage exceeds target tier
        const currentPlanGb = await getUserPlanGb(user.id);
        if (currentPlanGb && normalizedTier < currentPlanGb) {
            const canDowngrade = await canDowngradeToTier(user.id, normalizedTier);
            if (!canDowngrade) {
                const usedBytes = await getUserUsedBytes(user.id);
                const minTier = await getMinRequiredTier(user.id);
                return res.status(400).json({
                    error: 'Cannot downgrade: storage usage exceeds target plan capacity',
                    code: 'DOWNGRADE_BLOCKED',
                    usedBytes,
                    targetTierGb: normalizedTier,
                    minRequiredTier: minTier,
                });
            }
        }
        
        // Verify transaction on Solana blockchain
        const txVerification = await verifySolanaTransaction(txSignature, solAmount);
        if (!txVerification.success) {
            return res.status(400).json({ error: txVerification.error || 'Transaction verification failed' });
        }
        
        // Check if this transaction was already processed
        const existingTx = await dbGetAsync(
            `SELECT * FROM solana_payments WHERE tx_signature = ?`,
            [txSignature]
        );
        if (existingTx) {
            return res.status(409).json({ error: 'Transaction already processed', existingPayment: existingTx });
        }
        
        // Calculate subscription expiry
        // If user has existing active subscription, add new term to existing expiration (early renewal)
        // Otherwise start from now
        const now = Date.now();
        const durationMs = PLAN_DURATION_MS[duration] || PLAN_DURATION_MS.monthly;
        
        // Get current plan to check existing expiration
        const currentPlan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [user.id]);
        let baseTime = now;
        
        // If user has active subscription with future expiration, extend from that date
        if (currentPlan) {
            const currentExpires = currentPlan.expires_at;
            const currentTrial = currentPlan.trial_until;
            
            // Check if expires_at is in the future
            if (currentExpires && currentExpires > now) {
                baseTime = currentExpires;
            }
            // Or if trial_until is in the future (user paying during trial)
            else if (currentTrial && currentTrial > now) {
                baseTime = currentTrial;
            }
        }
        
        const expiresAt = baseTime + durationMs;
        
        // Record the payment
        await dbRunAsync(
            `INSERT INTO solana_payments (user_id, tx_signature, sol_amount, tier_gb, duration, created_at, verified_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user.id, txSignature, solAmount || 0, normalizedTier, duration || 'monthly', now, now]
        );
        
        // Activate subscription
        await dbRunAsync(
            `INSERT INTO user_plans (user_id, plan_gb, status, expires_at, updated_at)
             VALUES (?, ?, 'active', ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
                plan_gb = excluded.plan_gb,
                status = 'active',
                expires_at = excluded.expires_at,
                payment_type = 'solana',
                payment_at = excluded.updated_at,
                grace_until = NULL,
                updated_at = excluded.updated_at`,
            [user.id, normalizedTier, expiresAt, now]
        );
        
        console.log(`[Solana] Payment verified: ${txSignature} - User ${user.email} - ${normalizedTier}GB ${duration}`);
        
        return res.json({
            success: true,
            message: 'Payment verified and subscription activated',
            subscription: {
                tierGb: normalizedTier,
                status: 'active',
                expiresAt: new Date(expiresAt).toISOString(),
            },
        });
    } catch (e) {
        console.error('[Solana] Payment verification error:', e);
        return res.status(500).json({ error: 'Payment verification failed' });
    }
});

// Helper function to verify Solana transaction
async function verifySolanaTransaction(txSignature, expectedSolAmount) {
    console.log('[Solana] Verifying transaction:', txSignature, 'expected amount:', expectedSolAmount);
    
    // Retry up to 5 times with 2 second intervals to allow tx to propagate
    const maxRetries = 5;
    const retryDelay = 2000;
    let tx = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[Solana] Attempt ${attempt}/${maxRetries} to fetch transaction`);
            const response = await axios.post(SOLANA_RPC_ENDPOINT, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [
                    txSignature,
                    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
                ],
            }, {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
            });
            
            tx = response.data?.result;
            if (tx) {
                console.log('[Solana] Transaction found on attempt', attempt);
                break;
            }
            
            if (attempt < maxRetries) {
                console.log(`[Solana] Transaction not found yet, waiting ${retryDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        } catch (e) {
            console.error(`[Solana] RPC error on attempt ${attempt}:`, e.message);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }
    
    if (!tx) {
        return { success: false, error: 'Transaction not found after retries - may still be propagating' };
    }
        
        // Check if transaction explicitly failed (only if meta exists)
        if (tx.meta && tx.meta.err) {
            return { success: false, error: 'Transaction failed on chain' };
        }
        
        // Parse transfer instructions to find sender, receiver, and amount
        const instructions = tx.transaction?.message?.instructions || [];
        let sender = null;
        let receiver = null;
        let transferAmount = 0;
        
        for (const ix of instructions) {
            // Look for System Program transfer instruction
            if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
                sender = ix.parsed.info.source;
                receiver = ix.parsed.info.destination;
                transferAmount = ix.parsed.info.lamports / LAMPORTS_PER_SOL;
                console.log(`[Solana] Transfer found: ${sender} -> ${receiver}, amount: ${transferAmount} SOL`);
                break;
            }
        }
        
        if (!sender || !receiver || transferAmount <= 0) {
            console.log('[Solana] No valid transfer instruction found in transaction');
            console.log('[Solana] Instructions:', JSON.stringify(instructions, null, 2));
            return { success: false, error: 'No valid transfer found in transaction' };
        }
        
        // Verify the payment is TO our wallet
        if (receiver !== SOLANA_PAYMENT_WALLET) {
            console.log(`[Solana] Payment not to our wallet. Expected: ${SOLANA_PAYMENT_WALLET}, Got: ${receiver}`);
            return { success: false, error: 'Payment not sent to correct wallet' };
        }
        
        console.log(`[Solana] Valid payment: ${transferAmount} SOL from ${sender} to ${receiver}`);
        
    return { 
        success: true, 
        receivedAmount: transferAmount,
        sender,
        receiver,
        blockTime: tx.blockTime,
        slot: tx.slot,
    };
}

// Create solana_payments table if not exists
db.run(`CREATE TABLE IF NOT EXISTS solana_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tx_signature TEXT UNIQUE NOT NULL,
    sol_amount REAL,
    tier_gb INTEGER,
    duration TEXT DEFAULT 'monthly',
    created_at INTEGER,
    verified_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
)`);

// Upload File
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { filename, path: filePath, originalname, mimetype, size } = req.file;
    
    // Calculate file hash to detect duplicates
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    // Check if this exact file already exists for this user (by hash only - same content = duplicate)
    db.get(`SELECT filename, file_hash FROM files WHERE user_id = ? AND file_hash = ?`, 
        [req.user.id, fileHash], 
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
                    db.run(`DELETE FROM files WHERE user_id = ? AND file_hash = ?`, [req.user.id, fileHash]);
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

// Raw Upload File (no multipart)
app.post('/api/upload/raw', authenticateToken, (req, res) => {
    const originalname = (req.headers['x-filename'] || req.headers['x-file-name'] || '').toString();
    if (!originalname) return res.status(400).json({ error: 'Missing x-filename header' });

    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    try { fs.mkdirSync(deviceDir, { recursive: true }); } catch (e) {}

    const safeName = path.basename(originalname);
    const tmpName = `${Date.now()}_${Math.random().toString(16).slice(2)}_${safeName}.uploading`;
    const tmpPath = path.join(deviceDir, tmpName);
    const finalPath = path.join(deviceDir, safeName);

    const hasher = crypto.createHash('sha256');
    let writtenBytes = 0;

    const out = fs.createWriteStream(tmpPath);
    const cleanupTmp = () => {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    };

    req.on('aborted', () => {
        try { out.destroy(); } catch (e) {}
        cleanupTmp();
    });

    req.on('error', (e) => {
        try { out.destroy(); } catch (e2) {}
        cleanupTmp();
    });

    out.on('error', (e) => {
        cleanupTmp();
        return res.status(500).json({ error: 'Failed to write upload' });
    });

    req.on('data', (chunk) => {
        try {
            writtenBytes += chunk.length;
            hasher.update(chunk);
        } catch (e) {
            // ignore
        }
    });

    out.on('finish', () => {
        const fileHash = hasher.digest('hex');
        const mimetype = (req.headers['content-type'] || 'application/octet-stream').toString();
        const size = writtenBytes;

        db.get(
            `SELECT filename, file_hash FROM files WHERE user_id = ? AND file_hash = ?`,
            [req.user.id, fileHash],
            (err, row) => {
                if (err) {
                    cleanupTmp();
                    return res.status(500).json({ error: 'Database error' });
                }

                if (row) {
                    const existingFilePath = path.join(deviceDir, row.filename);
                    if (fs.existsSync(existingFilePath)) {
                        cleanupTmp();
                        console.log(`Duplicate raw upload detected: ${safeName} (matches ${row.filename})`);
                        return res.json({ message: 'File already exists (duplicate)', filename: row.filename, duplicate: true });
                    }
                    console.log(`File ${row.filename} in DB but missing from disk - cleaning up DB`);
                    db.run(`DELETE FROM files WHERE user_id = ? AND file_hash = ?`, [req.user.id, fileHash]);
                }

                try {
                    if (fs.existsSync(finalPath)) {
                        fs.unlinkSync(finalPath);
                    }
                } catch (e) {}

                try {
                    fs.renameSync(tmpPath, finalPath);
                } catch (e) {
                    cleanupTmp();
                    return res.status(500).json({ error: 'Failed to finalize upload' });
                }

                // Compute perceptual hash for images (async, non-blocking)
                const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tiff?)$/i.test(safeName);
                const saveToDb = (perceptualHash) => {
                    db.run(
                        `INSERT OR REPLACE INTO files (user_id, filename, original_name, mime_type, size, file_hash, perceptual_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [req.user.id, safeName, safeName, mimetype, size, fileHash, perceptualHash],
                        (err2) => {
                            if (err2) {
                                console.error('Metadata save error:', err2);
                                try { fs.unlinkSync(finalPath); } catch (e) {}
                                return res.status(500).json({ error: 'Failed to save file metadata' });
                            }
                            return res.json({ message: 'File uploaded', filename: safeName, fileHash, perceptualHash });
                        }
                    );
                };

                if (isImage) {
                    computePerceptualHash(finalPath).then(phash => {
                        saveToDb(phash);
                    }).catch(e => {
                        console.log('Perceptual hash failed:', e.message);
                        saveToDb(null);
                    });
                } else {
                    saveToDb(null);
                }
            }
        );
    });

    req.pipe(out);
});

// List Files (for Sync) - includes hash metadata for cross-device dedup
app.get('/api/files', authenticateToken, (req, res) => {
    const rawOffset = req.query && req.query.offset ? req.query.offset : null;
    const rawLimit = req.query && req.query.limit ? req.query.limit : null;
    const includeMeta = req.query && req.query.meta === 'true';
    const offset = rawOffset !== null ? Math.max(0, parseInt(String(rawOffset), 10) || 0) : 0;
    const limit = rawLimit !== null ? Math.max(0, parseInt(String(rawLimit), 10) || 0) : 0;

    // Read files from device UUID folder
    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    
    console.log(`[LIST FILES] Device UUID: ${req.user.device_uuid}, meta=${includeMeta}`);
    console.log(`[LIST FILES] Looking in: ${deviceDir}`);
    
    if (!fs.existsSync(deviceDir)) {
        console.log(`[LIST FILES] Directory does not exist`);
        return res.json({ files: [], total: 0 });
    }
    
    try {
        const allFiles = fs.readdirSync(deviceDir);
        console.log(`[LIST FILES] Found ${allFiles.length} items in directory`);
        
        // Filter out system files and only include actual media files
        let files = allFiles
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

        files.sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));
        const total = files.length;
        if (limit > 0) {
            files = files.slice(offset, offset + limit);
        }
        
        // If meta=true, enrich with hash metadata from database
        if (includeMeta && files.length > 0) {
            const filenames = files.map(f => f.filename);
            const placeholders = filenames.map(() => '?').join(',');
            
            // Get primary hashes from files table
            db.all(
                `SELECT filename, file_hash, perceptual_hash, size FROM files WHERE user_id = ? AND filename IN (${placeholders})`,
                [req.user.id, ...filenames],
                (err, rows) => {
                    if (err) {
                        console.error('[LIST FILES] DB error:', err);
                        return res.json({ files, total });
                    }
                    
                    // Create lookup map for primary hashes
                    const hashMap = {};
                    for (const row of (rows || [])) {
                        hashMap[row.filename] = {
                            fileHash: row.file_hash,
                            perceptualHash: row.perceptual_hash
                        };
                    }
                    
                    // Get platform-specific hashes (fallback for cross-platform dedup)
                    db.all(
                        `SELECT filename, platform, perceptual_hash, file_hash FROM platform_hashes WHERE user_id = ? AND filename IN (${placeholders})`,
                        [req.user.id, ...filenames],
                        (err2, platformRows) => {
                            // Build platform hash lookup: { filename: { ios: {...}, android: {...} } }
                            const platformHashMap = {};
                            for (const row of (platformRows || [])) {
                                if (!platformHashMap[row.filename]) {
                                    platformHashMap[row.filename] = {};
                                }
                                platformHashMap[row.filename][row.platform] = {
                                    perceptualHash: row.perceptual_hash,
                                    fileHash: row.file_hash
                                };
                            }
                            
                            // Enrich files with hash metadata
                            for (const file of files) {
                                const meta = hashMap[file.filename];
                                if (meta) {
                                    file.fileHash = meta.fileHash;
                                    file.perceptualHash = meta.perceptualHash;
                                }
                                // Add platform-specific hashes as fallback
                                const platformMeta = platformHashMap[file.filename];
                                if (platformMeta) {
                                    file.platformHashes = platformMeta;
                                }
                            }
                            
                            console.log(`[LIST FILES] Returning ${files.length} files with meta (offset=${offset} limit=${limit || 'all'} total=${total})`);
                            res.json({ files, total });
                        }
                    );
                }
            );
        } else {
            console.log(`[LIST FILES] Returning ${files.length} files (offset=${offset} limit=${limit || 'all'} total=${total})`);
            res.json({ files, total });
        }
    } catch (error) {
        console.error('[LIST FILES] Error reading files:', error);
        res.status(500).json({ error: 'Error reading files' });
    }
});

// Migrate existing files to compute missing hashes
app.post('/api/files/migrate-hashes', authenticateToken, async (req, res) => {
    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    if (!fs.existsSync(deviceDir)) {
        return res.json({ migrated: 0, message: 'No files to migrate' });
    }

    try {
        // Get files without perceptual_hash
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, filename, file_hash FROM files WHERE user_id = ? AND (perceptual_hash IS NULL OR perceptual_hash = '')`,
                [req.user.id],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });

        console.log(`[MIGRATE] Found ${rows.length} files without perceptual_hash`);
        let migrated = 0;
        let errors = 0;

        for (const row of rows) {
            const filePath = path.join(deviceDir, row.filename);
            if (!fs.existsSync(filePath)) {
                errors++;
                continue;
            }

            const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tiff?)$/i.test(row.filename);
            if (!isImage) continue; // Only images need perceptual hash

            try {
                const phash = await computePerceptualHash(filePath);
                if (phash) {
                    await new Promise((resolve, reject) => {
                        db.run(
                            `UPDATE files SET perceptual_hash = ? WHERE id = ?`,
                            [phash, row.id],
                            (err) => err ? reject(err) : resolve()
                        );
                    });
                    migrated++;
                    console.log(`[MIGRATE] ${row.filename}: ${phash}`);
                }
            } catch (e) {
                errors++;
                console.log(`[MIGRATE] Error for ${row.filename}: ${e.message}`);
            }
        }

        console.log(`[MIGRATE] Complete: ${migrated} migrated, ${errors} errors`);
        res.json({ migrated, errors, total: rows.length });
    } catch (e) {
        console.error('[MIGRATE] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Submit platform-specific hash for a file (for cross-platform dedup fallback)
// Called by clients after syncing a file to store their platform's computed hash
app.post('/api/files/platform-hash', authenticateToken, (req, res) => {
    const { filename, platform, perceptualHash, fileHash } = req.body || {};
    
    if (!filename || !platform) {
        return res.status(400).json({ error: 'filename and platform required' });
    }
    
    if (!perceptualHash && !fileHash) {
        return res.status(400).json({ error: 'perceptualHash or fileHash required' });
    }
    
    // Validate platform
    const validPlatforms = ['ios', 'android'];
    if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform. Must be ios or android' });
    }
    
    db.run(
        `INSERT OR REPLACE INTO platform_hashes (user_id, filename, platform, perceptual_hash, file_hash) VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, filename, platform, perceptualHash || null, fileHash || null],
        (err) => {
            if (err) {
                console.error('[PLATFORM-HASH] Error:', err);
                return res.status(500).json({ error: 'Failed to save platform hash' });
            }
            res.json({ success: true, filename, platform });
        }
    );
});

// Batch submit platform hashes (more efficient for sync)
app.post('/api/files/platform-hashes', authenticateToken, (req, res) => {
    const { platform, hashes } = req.body || {};
    
    if (!platform || !Array.isArray(hashes) || hashes.length === 0) {
        return res.status(400).json({ error: 'platform and hashes array required' });
    }
    
    const validPlatforms = ['ios', 'android'];
    if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
    }
    
    let saved = 0;
    let errors = 0;
    
    const stmt = db.prepare(`INSERT OR REPLACE INTO platform_hashes (user_id, filename, platform, perceptual_hash, file_hash) VALUES (?, ?, ?, ?, ?)`);
    
    for (const h of hashes) {
        if (h.filename && (h.perceptualHash || h.fileHash)) {
            stmt.run([req.user.id, h.filename, platform, h.perceptualHash || null, h.fileHash || null], (err) => {
                if (err) errors++;
                else saved++;
            });
        }
    }
    
    stmt.finalize((err) => {
        if (err) {
            console.error('[PLATFORM-HASHES] Finalize error:', err);
        }
        console.log(`[PLATFORM-HASHES] Saved ${saved} hashes for ${platform}, ${errors} errors`);
        res.json({ saved, errors, total: hashes.length });
    });
});

// Purge classic uploads (non-StealthCloud) for this device
app.post('/api/files/purge', authenticateToken, async (req, res) => {
    try {
        const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);

        const countFiles = (dir) => {
            try {
                if (!fs.existsSync(dir)) return 0;
                return fs.readdirSync(dir)
                    .filter(f => f && !f.startsWith('.'))
                    .filter(f => {
                        try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; }
                    }).length;
            } catch (e) {
                return 0;
            }
        };

        const filesBefore = countFiles(deviceDir);

        try { fs.rmSync(deviceDir, { recursive: true, force: true }); } catch (e) {}
        try { fs.mkdirSync(deviceDir, { recursive: true }); } catch (e) {}

        try {
            await dbRunAsync(`DELETE FROM files WHERE user_id = ?`, [req.user.id]);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to clear file index' });
        }

        return res.json({
            ok: true,
            deleted: {
                files: filesBefore,
            }
        });
    } catch (e) {
        return res.status(500).json({ error: 'Purge failed' });
    }
});

// Thumbnail endpoint - returns resized image (150px) or video frame
app.get('/api/files/:filename/thumb', authenticateToken, async (req, res) => {
    const filename = req.params.filename;
    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    const filePath = path.join(deviceDir, filename);

    // Security check: prevent directory traversal
    if (!filePath.startsWith(deviceDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
    const isImage = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff'].includes(ext);
    const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext);

    if (!isImage && !isVideo) {
        return res.status(400).json({ error: 'Not a media file' });
    }

    // Handle video thumbnails using ffmpeg
    if (isVideo) {
        const { execFile } = require('child_process');
        const tmpThumb = path.join(os.tmpdir(), `thumb_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
        try {
            await new Promise((resolve, reject) => {
                execFile(ffmpegPath, [
                    '-i', filePath,
                    '-ss', '00:00:01',
                    '-vframes', '1',
                    '-vf', 'scale=150:150:force_original_aspect_ratio=increase,crop=150:150',
                    '-y',
                    tmpThumb
                ], { timeout: 10000 }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            if (fs.existsSync(tmpThumb)) {
                const thumbBuffer = fs.readFileSync(tmpThumb);
                fs.unlinkSync(tmpThumb);
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(thumbBuffer);
            }
        } catch (e) {
            if (fs.existsSync(tmpThumb)) fs.unlinkSync(tmpThumb);
            console.log('Video thumbnail generation failed:', e.message);
        }
        // Fallback: generate a simple placeholder for videos if ffmpeg fails
        if (sharp) {
            try {
                const placeholder = await sharp({
                    create: { width: 150, height: 150, channels: 3, background: { r: 40, g: 40, b: 60 } }
                }).jpeg({ quality: 70 }).toBuffer();
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(placeholder);
            } catch (e2) {}
        }
        return res.status(500).json({ error: 'Video thumbnail generation failed' });
    }

    // If sharp is available, generate thumbnail for images
    if (sharp) {
        try {
            const thumbBuffer = await sharp(filePath)
                .resize(150, 150, { fit: 'cover', position: 'center' })
                .jpeg({ quality: 70 })
                .toBuffer();
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(thumbBuffer);
        } catch (e) {
            console.log('Thumbnail generation failed:', e.message);
            // Generate placeholder instead of serving huge original
            try {
                const placeholder = await sharp({
                    create: { width: 150, height: 150, channels: 3, background: { r: 40, g: 60, b: 40 } }
                }).jpeg({ quality: 70 }).toBuffer();
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(placeholder);
            } catch (e2) {}
        }
    }

    // Fallback: generate simple placeholder (don't serve huge original)
    if (sharp) {
        try {
            const placeholder = await sharp({
                create: { width: 150, height: 150, channels: 3, background: { r: 60, g: 60, b: 60 } }
            }).jpeg({ quality: 70 }).toBuffer();
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(placeholder);
        } catch (e) {}
    }
    res.status(500).json({ error: 'Thumbnail generation failed' });
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

// Server uptime status (persistent and shareable)
// Tracks: totalUptimeMs (cumulative on-time), downtimeMs (cumulative off-time), lastHeartbeat (last seen running), startedAt (anchor for lifetime history)
const UPTIME_STATE_PATH = process.env.UPTIME_STATE_PATH || path.join(DATA_DIR, 'uptime.json');
const UPTIME_ANCHOR_START = new Date('2026-01-01T00:00:00Z').getTime();
function loadUptimeState() {
    try {
        if (!fs.existsSync(UPTIME_STATE_PATH)) return null;
        const raw = fs.readFileSync(UPTIME_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        // New format
        if (parsed.totalUptimeMs !== undefined && parsed.downtimeMs !== undefined && parsed.lastHeartbeat !== undefined) {
            return {
                totalUptimeMs: Math.max(0, Number(parsed.totalUptimeMs) || 0),
                downtimeMs: Math.max(0, Number(parsed.downtimeMs) || 0),
                lastHeartbeat: Number(parsed.lastHeartbeat) || Date.now(),
                startedAt: Number(parsed.startedAt) || UPTIME_ANCHOR_START
            };
        }

        // Old format: convert startedAt/lastSeen/downtimeMs
        const { startedAt, lastSeen, downtimeMs } = parsed;
        if (startedAt !== undefined && lastSeen !== undefined && downtimeMs !== undefined) {
            const elapsed = Math.max(0, Number(lastSeen) - Number(startedAt));
            const uptime = Math.max(0, elapsed - Number(downtimeMs));
            return {
                totalUptimeMs: uptime,
                downtimeMs: Math.max(0, Number(downtimeMs) || 0),
                lastHeartbeat: Number(lastSeen) || Date.now(),
                startedAt: Number(startedAt) || UPTIME_ANCHOR_START
            };
        }
        return null;
    } catch (e) {
        return null;
    }
}

function saveUptimeState(state) {
    try {
        fs.mkdirSync(path.dirname(UPTIME_STATE_PATH), { recursive: true });
        fs.writeFileSync(UPTIME_STATE_PATH, JSON.stringify({
            totalUptimeMs: state.totalUptimeMs,
            downtimeMs: state.downtimeMs,
            lastHeartbeat: state.lastHeartbeat,
            startedAt: state.startedAt
        }));
    } catch (e) {
        // best effort
    }
}

// Initialize uptime state
let uptimeState = loadUptimeState();
const nowInit = Date.now();
if (!uptimeState) {
    uptimeState = {
        // On first install, prefill uptime with elapsed time since anchor so counters start from history
        totalUptimeMs: Math.max(0, nowInit - UPTIME_ANCHOR_START),
        downtimeMs: 0,
        lastHeartbeat: nowInit,
        startedAt: UPTIME_ANCHOR_START
    };
    saveUptimeState(uptimeState);
} else {
    // Server restart - don't count restart gaps as downtime (assume server was running)
    uptimeState.lastHeartbeat = nowInit;
    uptimeState.startedAt = uptimeState.startedAt || UPTIME_ANCHOR_START;
    // Ensure uptime matches elapsed time since anchor (assume 100% uptime)
    const anchorElapsed = Math.max(0, nowInit - UPTIME_ANCHOR_START);
    uptimeState.totalUptimeMs = anchorElapsed;
    uptimeState.downtimeMs = 0; // Reset downtime - assume server was always up
    saveUptimeState(uptimeState);
}

// Heartbeat: add uptime since last heartbeat
setInterval(() => {
    const now = Date.now();
    const gap = Math.max(0, now - uptimeState.lastHeartbeat);
    uptimeState.totalUptimeMs += gap;
    uptimeState.lastHeartbeat = now;
    saveUptimeState(uptimeState);
}, 60 * 1000).unref();

app.get('/api/status/uptime', (_req, res) => {
    const now = Date.now();
    // Lifetime tracking anchored to startedAt
    const anchor = uptimeState.startedAt || UPTIME_ANCHOR_START;
    const totalMs = Math.max(0, uptimeState.totalUptimeMs + uptimeState.downtimeMs);
    const anchorElapsed = Math.max(0, now - anchor);
    // If totals drift behind wall-clock since anchor, clamp totalMs up so pct math stays valid
    const effectiveTotalMs = Math.max(totalMs, anchorElapsed);
    const uptimeMs = uptimeState.totalUptimeMs;
    const uptimeSec = Math.floor(uptimeMs / 1000);

    // Lifetime pct (kept for reference)
    const pctLifetime = effectiveTotalMs > 0 ? Math.max(0, Math.min(1, uptimeMs / effectiveTotalMs)) : 1;

    // Use anchor as lifetime start (shows history from 2026-01-01)
    const startedAtDisplay = anchor;

    // Reflect actual uptime ratio (adds uptime when up, downtime when down)
    const uptimePct24h = +(pctLifetime * 100).toFixed(2);

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
        ok: true,
        startedAt: startedAtDisplay,
        now,
        uptimeSeconds: uptimeSec,
        uptimeHours: +(uptimeSec / 3600).toFixed(2),
        uptimeDays: +(uptimeSec / 86400).toFixed(3),
        uptimePct24h,
        pctLifetime: +(pctLifetime * 100).toFixed(2)
    });
});

// Reset uptime to 100% (admin only - use secret param)
app.post('/api/status/uptime/reset', (req, res) => {
    const secret = req.query.secret || req.body?.secret;
    if (secret !== 'photolynk2026') {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const now = Date.now();
    const anchorElapsed = Math.max(0, now - UPTIME_ANCHOR_START);
    uptimeState = {
        totalUptimeMs: anchorElapsed,
        downtimeMs: 0,
        lastHeartbeat: now,
        startedAt: UPTIME_ANCHOR_START
    };
    saveUptimeState(uptimeState);
    res.json({ ok: true, message: 'Uptime reset to 100%', uptimeHours: +(anchorElapsed / 3600000).toFixed(2) });
});

app.post('/api/cloud/purge', authenticateToken, async (req, res) => {
    try {
        const { chunksDir, manifestsDir } = ensureStealthCloudUserDirs(req.user);

        const countFiles = (dir) => {
            try {
                if (!fs.existsSync(dir)) return 0;
                return fs.readdirSync(dir).filter(f => f && !f.startsWith('.')).length;
            } catch (e) {
                return 0;
            }
        };

        const chunksBefore = countFiles(chunksDir);
        const manifestsBefore = countFiles(manifestsDir);

        try { fs.rmSync(chunksDir, { recursive: true, force: true }); } catch (e) {}
        try { fs.rmSync(manifestsDir, { recursive: true, force: true }); } catch (e) {}

        try { fs.mkdirSync(chunksDir, { recursive: true }); } catch (e) {}
        try { fs.mkdirSync(manifestsDir, { recursive: true }); } catch (e) {}

        try {
            await dbRunAsync(`DELETE FROM cloud_chunks WHERE user_id = ?`, [req.user.id]);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to clear cloud index' });
        }

        return res.json({
            ok: true,
            deleted: {
                chunks: chunksBefore,
                manifests: manifestsBefore
            }
        });
    } catch (e) {
        return res.status(500).json({ error: 'Purge failed' });
    }
});

app.get('/api/cloud/device-state', authenticateToken, blockDeletedSubscription, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('ETag', '');

        const deviceUuid = (req.user && (req.user.device_uuid || req.user.deviceUuid)) ? String(req.user.device_uuid || req.user.deviceUuid) : '';
        const row = await dbGetAsync(
            `SELECT state_json, updated_at FROM cloud_device_state WHERE user_id = ? AND device_uuid = ?`,
            [req.user.id, deviceUuid]
        );
        if (!row || !row.state_json) {
            return res.json({ state: null, updatedAt: null });
        }
        let parsed = null;
        try {
            parsed = JSON.parse(String(row.state_json));
        } catch (e) {
            parsed = null;
        }
        return res.json({ state: parsed, updatedAt: row.updated_at || null });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to load device state' });
    }
});

app.put('/api/cloud/device-state', authenticateToken, blockDeletedSubscription, async (req, res) => {
    try {
        const deviceUuid = (req.user && (req.user.device_uuid || req.user.deviceUuid)) ? String(req.user.device_uuid || req.user.deviceUuid) : '';
        const state = req && req.body && typeof req.body === 'object' ? (req.body.state !== undefined ? req.body.state : req.body) : null;

        if (state === null || typeof state !== 'object' || Array.isArray(state)) {
            return res.status(400).json({ error: 'state must be an object' });
        }

        const json = JSON.stringify(state);
        const bytes = Buffer.byteLength(json, 'utf8');
        if (bytes > 100 * 1024) {
            return res.status(413).json({ error: 'state too large' });
        }

        const now = Date.now();
        await dbRunAsync(
            `INSERT INTO cloud_device_state (user_id, device_uuid, state_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, device_uuid) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`,
            [req.user.id, deviceUuid, json, now]
        );
        return res.json({ ok: true, updatedAt: now });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save device state' });
    }
});

// Upload encrypted chunk blob
app.post('/api/cloud/chunks', authenticateToken, requireUploadSubscription, (req, res, next) => {
    const ct = (req.headers['content-type'] || '').toString().toLowerCase();
    if (ct.startsWith('application/octet-stream') || ct === 'application/octetstream') {
        return rawCloudChunk(req, res, next);
    }
    return uploadCloudChunk.single('chunk')(req, res, next);
}, async (req, res) => {
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

        if (fs.existsSync(target)) {
            return res.json({ chunkId: requestedId, stored: true });
        }

        const reservation = await reserveStealthCloudIncomingBytes({ userId: req.user.id, incomingBytes: req.body.length });
        if (!reservation.allowed) {
            return res.status(413).json({
                error: 'Storage limit reached',
                code: 'QUOTA_EXCEEDED',
                usedBytes: reservation.usedBytes,
                quotaBytes: reservation.quotaBytes,
                remainingBytes: reservation.remainingBytes,
            });
        }

        try {
            const actual = crypto.createHash('sha256').update(req.body).digest('hex');
            if (actual !== requestedId) {
                return res.status(400).json({ error: 'Chunk hash mismatch' });
            }
            fs.writeFileSync(target, req.body);
            db.run(
                `INSERT OR IGNORE INTO cloud_chunks (user_id, chunk_id, size, created_at) VALUES (?, ?, ?, ?)`,
                [req.user.id, requestedId, req.body.length, Date.now()]
            );
            return res.json({ chunkId: requestedId, stored: true });
        } catch (e) {
            return res.status(500).json({ error: 'Chunk verification failed' });
        } finally {
            try { reservation.release(); } catch (e) {}
        }
    }

    const storedName = req.file.filename;
    const tmpPath = req.file.path;
    const tmpSize = (() => {
        try {
            const st = fs.statSync(tmpPath);
            return st && typeof st.size === 'number' ? Number(st.size) : 0;
        } catch (e) {
            return 0;
        }
    })();

    // If we already have this chunk, don't count it again.
    if (requestedId && requestedId.match(/^[a-f0-9]{64}$/i)) {
        const { chunksDir } = ensureStealthCloudUserDirs(req.user);
        const existing = path.join(chunksDir, requestedId);
        if (fs.existsSync(existing)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
            return res.json({ chunkId: requestedId, stored: true });
        }
    }

    const reservationMultipart = await reserveStealthCloudIncomingBytes({ userId: req.user.id, incomingBytes: tmpSize });
    if (!reservationMultipart.allowed) {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        return res.status(413).json({
            error: 'Storage limit reached',
            code: 'QUOTA_EXCEEDED',
            usedBytes: reservationMultipart.usedBytes,
            quotaBytes: reservationMultipart.quotaBytes,
            remainingBytes: reservationMultipart.remainingBytes,
        });
    }

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
                const finalPath = fs.existsSync(target) ? target : req.file.path;
                let finalSize = tmpSize;
                try {
                    const st = fs.statSync(finalPath);
                    finalSize = st && typeof st.size === 'number' ? Number(st.size) : finalSize;
                } catch (e) {
                    finalSize = finalSize;
                }
                db.run(
                    `INSERT OR IGNORE INTO cloud_chunks (user_id, chunk_id, size, created_at) VALUES (?, ?, ?, ?)`,
                    [req.user.id, requestedId, finalSize, Date.now()]
                );
                return res.json({ chunkId: requestedId, stored: true });
            }
        } catch (e) {
            return res.status(500).json({ error: 'Chunk verification failed' });
        } finally {
            try { reservationMultipart.release(); } catch (e) {}
        }
    }

    db.run(
        `INSERT OR IGNORE INTO cloud_chunks (user_id, chunk_id, size, created_at) VALUES (?, ?, ?, ?)`,
        [req.user.id, storedName, tmpSize, Date.now()]
    );
    try {
        res.json({ chunkId: storedName, stored: true });
    } finally {
        try { reservationMultipart.release(); } catch (e) {}
    }
});

// Download encrypted chunk blob
app.get('/api/cloud/chunks/:chunkId', authenticateToken, blockDeletedSubscription, (req, res) => {
    const chunkId = (req.params.chunkId || '').toLowerCase();
    if (!chunkId.match(/^[a-f0-9]{64}$/i)) {
        return res.status(400).json({ error: 'Invalid chunk id' });
    }
    const { chunksDir: chunksRoot } = ensureStealthCloudUserDirs(req.user);
    const chunkPath = path.join(chunksRoot, chunkId);
    if (!chunkPath.startsWith(chunksRoot)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    if (fs.existsSync(chunkPath)) {
        return res.download(chunkPath);
    }
    
    return res.status(404).json({ error: 'Chunk not found' });
});

// ============================================================================
// SERVER-SIDE DEDUPLICATION HELPERS
// Extra precaution: check all dedup criteria on server before accepting upload
// ============================================================================

// Hamming distance for 16-char hex hash (64 bits) - for perceptual hash fuzzy matching
function hammingDistance64(a, b) {
    if (!a || !b || a.length !== 16 || b.length !== 16) return Number.MAX_SAFE_INTEGER;
    let dist = 0;
    for (let i = 0; i < 16; i += 8) {
        const valA = parseInt(a.substring(i, i + 8), 16);
        const valB = parseInt(b.substring(i, i + 8), 16);
        let x = valA ^ valB;
        while (x) {
            dist += x & 1;
            x >>>= 1;
        }
    }
    return dist;
}

// Cross-platform dHash threshold (3 bits = tighter match tolerance)
const SERVER_DHASH_THRESHOLD = 3;

// Normalize filename for comparison
function normalizeFilenameForCompare(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    return trimmed.toLowerCase();
}

// Build server-side dedup sets from existing manifests
function buildServerDedupSets(manifestsDir) {
    const sets = {
        manifestIds: new Set(),
        filenames: new Set(),
        fileHashes: new Set(),
        perceptualHashes: new Set(),
        exifFull: new Set(),      // captureTime|make|model
        exifTimeModel: new Set(), // captureTime|model
        exifTimeMake: new Set(),  // captureTime|make
    };
    
    if (!fs.existsSync(manifestsDir)) return sets;
    
    try {
        const files = fs.readdirSync(manifestsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
        for (const f of files) {
            try {
                const content = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), 'utf8'));
                const manifestId = f.replace(/\.json$/, '');
                sets.manifestIds.add(manifestId);
                
                if (content.meta) {
                    if (content.meta.filename) {
                        const normalized = normalizeFilenameForCompare(content.meta.filename);
                        if (normalized) sets.filenames.add(normalized);
                    }
                    if (content.meta.fileHash) sets.fileHashes.add(content.meta.fileHash);
                    if (content.meta.perceptualHash) sets.perceptualHashes.add(content.meta.perceptualHash);
                    
                    // EXIF-based dedup keys
                    const ct = content.meta.exifCaptureTime;
                    const mk = content.meta.exifMake;
                    const md = content.meta.exifModel;
                    if (ct && mk && md) sets.exifFull.add(`${ct}|${mk}|${md}`);
                    if (ct && md) sets.exifTimeModel.add(`${ct}|${md}`);
                    if (ct && mk) sets.exifTimeMake.add(`${ct}|${mk}`);
                }
            } catch (e) {
                // Skip unreadable manifests
            }
        }
    } catch (e) {
        console.warn('[SC] Failed to build dedup sets:', e.message);
    }
    
    return sets;
}

// Check if perceptual hash matches any existing hash (fuzzy matching)
function findPerceptualHashMatchServer(hash, hashSet) {
    if (!hash || hash.length !== 16 || !hashSet || hashSet.size === 0) return { match: false };
    if (hashSet.has(hash)) return { match: true, reason: 'exact' };
    for (const existing of hashSet) {
        if (existing && existing.length === 16) {
            const dist = hammingDistance64(hash, existing);
            if (dist <= SERVER_DHASH_THRESHOLD) {
                return { match: true, reason: 'fuzzy', distance: dist };
            }
        }
    }
    return { match: false };
}

// Upload encrypted manifest JSON
// Now includes comprehensive server-side deduplication as extra precaution
app.post('/api/cloud/manifests', authenticateToken, requireUploadSubscription, (req, res) => {
    const {
        manifestId,
        encryptedManifest,
        chunkCount,
        filename,
        originalSize,
        fileHash,
        perceptualHash,
        creationTime,
        exifCaptureTime,
        exifMake,
        exifModel,
        mediaType,
        thumbChunkId,
        thumbNonce,
        thumbSize,
        thumbW,
        thumbH,
        thumbMime,
    } = req.body || {};
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

    // ========== SERVER-SIDE DEDUPLICATION (Extra Precaution) ==========
    // Build dedup sets from existing manifests
    const dedupSets = buildServerDedupSets(manifestsDir);
    console.log(`[SC-Dedup] Checking ${safeId}: ${dedupSets.manifestIds.size} manifestIds, ${dedupSets.filenames.size} filenames, ${dedupSets.perceptualHashes.size} pHashes, ${dedupSets.fileHashes.size} fHashes`);
    
    // Check 1: ManifestId (filename + size hash)
    if (dedupSets.manifestIds.has(safeId)) {
        console.log(`[SC-Dedup] Skipping ${safeId} - manifestId already exists`);
        return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'manifestId' });
    }
    
    // Check 2: Exact filename match
    if (filename) {
        const normalizedFilename = normalizeFilenameForCompare(filename);
        if (normalizedFilename && dedupSets.filenames.has(normalizedFilename)) {
            console.log(`[SC-Dedup] Skipping ${safeId} - filename "${filename}" already exists`);
            return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'filename' });
        }
    }
    
    // Check 3: Exact file hash match (videos and byte-identical files)
    if (fileHash && dedupSets.fileHashes.has(fileHash)) {
        console.log(`[SC-Dedup] Skipping ${safeId} - fileHash already exists`);
        return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'fileHash' });
    }
    
    // Check 4: Perceptual hash match (images - fuzzy matching)
    if (perceptualHash) {
        const phashMatch = findPerceptualHashMatchServer(perceptualHash, dedupSets.perceptualHashes);
        if (phashMatch.match) {
            console.log(`[SC-Dedup] Skipping ${safeId} - perceptualHash match (${phashMatch.reason}${phashMatch.distance !== undefined ? ', dist=' + phashMatch.distance : ''})`);
            return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'perceptualHash' });
        }
    }
    
    // Check 5: EXIF-based dedup (cross-platform HEIC matching)
    if (exifCaptureTime) {
        const ct = exifCaptureTime;
        const mk = exifMake;
        const md = exifModel;
        
        // Full EXIF match (captureTime + make + model)
        if (ct && mk && md && dedupSets.exifFull.has(`${ct}|${mk}|${md}`)) {
            console.log(`[SC-Dedup] Skipping ${safeId} - EXIF full match (time+make+model)`);
            return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'exifFull' });
        }
        
        // Time + model match
        if (ct && md && dedupSets.exifTimeModel.has(`${ct}|${md}`)) {
            console.log(`[SC-Dedup] Skipping ${safeId} - EXIF time+model match`);
            return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'exifTimeModel' });
        }
        
        // Time + make match
        if (ct && mk && dedupSets.exifTimeMake.has(`${ct}|${mk}`)) {
            console.log(`[SC-Dedup] Skipping ${safeId} - EXIF time+make match`);
            return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'exifTimeMake' });
        }
    }
    
    // ========== No duplicates found - store the manifest ==========
    const manifestPath = path.join(manifestsDir, `${safeId}.json`);
    
    // Store encrypted manifest + unencrypted metadata for fast dedup lookups
    const payload = {
        manifestId: safeId,
        encryptedManifest,
        createdAt: new Date().toISOString(),
        // Unencrypted metadata for fast dedup (hashes don't reveal content)
        meta: {
            filename: typeof filename === 'string' ? filename : null,
            mediaType: typeof mediaType === 'string' ? mediaType : null,
            originalSize: typeof originalSize === 'number' ? originalSize : null,
            fileHash: typeof fileHash === 'string' ? fileHash : null,
            perceptualHash: typeof perceptualHash === 'string' ? perceptualHash : null,
            creationTime: creationTime || null,
            exifCaptureTime: typeof exifCaptureTime === 'string' ? exifCaptureTime : null,
            exifMake: typeof exifMake === 'string' ? exifMake : null,
            exifModel: typeof exifModel === 'string' ? exifModel : null,
            thumbChunkId: typeof thumbChunkId === 'string' ? thumbChunkId : null,
            thumbNonce: typeof thumbNonce === 'string' ? thumbNonce : null,
            thumbSize: typeof thumbSize === 'number' ? thumbSize : null,
            thumbW: typeof thumbW === 'number' ? thumbW : null,
            thumbH: typeof thumbH === 'number' ? thumbH : null,
            thumbMime: typeof thumbMime === 'string' ? thumbMime : null,
        }
    };
    fs.writeFileSync(manifestPath, JSON.stringify(payload));
    
    console.log(`[SC] Stored manifest ${safeId} for user ${req.user.id}`);
    res.json({ ok: true, manifestId: safeId });
});

// List manifests - now includes metadata for fast client-side deduplication
app.get('/api/cloud/manifests', authenticateToken, blockDeletedSubscription, (req, res) => {
    const rawOffset = req.query && req.query.offset ? req.query.offset : null;
    const rawLimit = req.query && req.query.limit ? req.query.limit : null;
    const includeMeta = req.query && req.query.meta === 'true'; // ?meta=true to include hash metadata
    const offset = rawOffset !== null ? Math.max(0, parseInt(String(rawOffset), 10) || 0) : 0;
    const limit = rawLimit !== null ? Math.max(0, parseInt(String(rawLimit), 10) || 0) : 0;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', '');
    const { manifestsDir } = ensureStealthCloudUserDirs(req.user);
    if (!fs.existsSync(manifestsDir)) return res.json({ manifests: [], total: 0 });
    
    const files = fs.readdirSync(manifestsDir)
        .filter(f => f.endsWith('.json'))
        .filter(f => !f.startsWith('.')); // Skip hidden files like .DS_Store
    
    let list = files.map(f => {
        const manifestId = f.replace(/\.json$/, '');
        const entry = { manifestId };
        
        // Include metadata if requested (for fast dedup without decryption)
        if (includeMeta) {
            try {
                const manifestPath = path.join(manifestsDir, f);
                const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                if (content.meta) {
                    entry.filename = content.meta.filename || null;
                    entry.mediaType = content.meta.mediaType || null;
                    entry.originalSize = content.meta.originalSize || null;
                    entry.fileHash = content.meta.fileHash || null;
                    entry.perceptualHash = content.meta.perceptualHash || null;
                    entry.creationTime = content.meta.creationTime || null;
                    // EXIF metadata for cross-platform dedup
                    entry.exifCaptureTime = content.meta.exifCaptureTime || null;
                    entry.exifMake = content.meta.exifMake || null;
                    entry.exifModel = content.meta.exifModel || null;
                    entry.thumbChunkId = content.meta.thumbChunkId || null;
                    entry.thumbNonce = content.meta.thumbNonce || null;
                    entry.thumbSize = content.meta.thumbSize || null;
                    entry.thumbW = content.meta.thumbW || null;
                    entry.thumbH = content.meta.thumbH || null;
                    entry.thumbMime = content.meta.thumbMime || null;
                }
            } catch (e) {
                // Ignore read errors, just return manifestId
            }
        }
        
        return entry;
    });

    list.sort((a, b) => String(a.manifestId || '').localeCompare(String(b.manifestId || '')));
    const total = list.length;
    if (limit > 0) {
        list = list.slice(offset, offset + limit);
    }

    res.json({ manifests: list, total });
});

// Download encrypted manifest
app.get('/api/cloud/manifests/:manifestId', authenticateToken, blockDeletedSubscription, (req, res) => {
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

// ============================================================================
// STEALTHCLOUD RAW MODE (Unencrypted fast uploads - optional)
// ============================================================================

// Upload raw file to StealthCloud (unencrypted mode)
app.post('/api/cloud/raw', authenticateToken, requireUploadSubscription, express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
    const filename = (req.headers['x-filename'] || '').toString();
    if (!filename) return res.status(400).json({ error: 'Missing X-Filename header' });
    
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const filePath = path.join(rawDir, safeName);
    
    if (!filePath.startsWith(rawDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    // Check quota
    const fileSize = req.body?.length || 0;
    const reservation = await reserveStealthCloudIncomingBytes({ userId: req.user.id, incomingBytes: fileSize });
    if (!reservation.allowed) {
        return res.status(413).json({
            error: 'Storage limit reached',
            code: 'QUOTA_EXCEEDED',
            usedBytes: reservation.usedBytes,
            quotaBytes: reservation.quotaBytes,
            remainingBytes: reservation.remainingBytes,
        });
    }
    
    try {
        // Compute file hash for deduplication
        const fileHash = crypto.createHash('sha256').update(req.body).digest('hex');
        
        // Check if file already exists (by hash)
        const existingFiles = fs.readdirSync(rawDir);
        for (const existing of existingFiles) {
            const existingPath = path.join(rawDir, existing);
            if (fs.statSync(existingPath).isFile()) {
                const existingHash = crypto.createHash('sha256').update(fs.readFileSync(existingPath)).digest('hex');
                if (existingHash === fileHash) {
                    reservation.release();
                    return res.json({ 
                        success: true, 
                        filename: existing, 
                        fileHash,
                        duplicate: true,
                        message: 'File already exists (duplicate)'
                    });
                }
            }
        }
        
        // Write file
        fs.writeFileSync(filePath, req.body);
        
        console.log(`[SC-RAW] Uploaded: ${safeName} (${fileSize} bytes) for user ${req.user.id}`);
        
        res.json({ 
            success: true, 
            filename: safeName, 
            fileHash,
            size: fileSize,
            duplicate: false
        });
    } catch (e) {
        console.error(`[SC-RAW] Upload failed for ${safeName}:`, e.message);
        res.status(500).json({ error: 'Failed to save file' });
    } finally {
        try { reservation.release(); } catch (e) {}
    }
});

// Upload metadata (thumbnail, EXIF) for a raw file
app.post('/api/cloud/raw/:filename/meta', authenticateToken, express.json({ limit: '10mb' }), (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const metaPath = path.join(rawMetaDir, `${safeName}.json`);
    
    if (!metaPath.startsWith(rawMetaDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const meta = req.body || {};
    
    try {
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        console.log(`[SC-RAW] Saved metadata for ${safeName}`);
        res.json({ success: true, filename: safeName });
    } catch (e) {
        console.error(`[SC-RAW] Failed to save metadata for ${safeName}:`, e.message);
        res.status(500).json({ error: 'Failed to save metadata' });
    }
});

// List raw files
app.get('/api/cloud/raw', authenticateToken, (req, res) => {
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const includeMeta = req.query.meta === 'true';
    
    if (!fs.existsSync(rawDir)) {
        return res.json({ files: [], total: 0 });
    }
    
    try {
        const files = fs.readdirSync(rawDir)
            .filter(f => !f.startsWith('.'))
            .map(filename => {
                const filePath = path.join(rawDir, filename);
                const stats = fs.statSync(filePath);
                if (!stats.isFile()) return null;
                
                const file = {
                    type: 'raw',
                    filename,
                    size: stats.size,
                    createdAt: stats.mtime.toISOString(),
                };
                
                // Include metadata if requested
                if (includeMeta) {
                    const metaPath = path.join(rawMetaDir, `${filename}.json`);
                    if (fs.existsSync(metaPath)) {
                        try {
                            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                            file.meta = meta;
                        } catch (e) {}
                    }
                }
                
                return file;
            })
            .filter(Boolean);
        
        res.json({ files, total: files.length });
    } catch (e) {
        console.error('[SC-RAW] List error:', e.message);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// Download raw file
app.get('/api/cloud/raw/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir } = ensureStealthCloudUserDirs(req.user);
    const filePath = path.join(rawDir, safeName);
    
    if (!filePath.startsWith(rawDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    res.sendFile(filePath);
});

// Get thumbnail for raw file
app.get('/api/cloud/raw/:filename/thumb', authenticateToken, async (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    
    // First check if we have a stored thumbnail in metadata
    const metaPath = path.join(rawMetaDir, `${safeName}.json`);
    if (fs.existsSync(metaPath)) {
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.thumbBase64) {
                const thumbBuffer = Buffer.from(meta.thumbBase64, 'base64');
                res.setHeader('Content-Type', meta.thumbMime || 'image/jpeg');
                return res.send(thumbBuffer);
            }
        } catch (e) {}
    }
    
    // Generate thumbnail on-the-fly if sharp is available
    const filePath = path.join(rawDir, safeName);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    const ext = path.extname(safeName).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'].includes(ext);
    const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp'].includes(ext);
    
    if (isImage && sharp) {
        try {
            const thumbBuffer = await sharp(filePath)
                .resize(220, 220, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 60 })
                .toBuffer();
            res.setHeader('Content-Type', 'image/jpeg');
            return res.send(thumbBuffer);
        } catch (e) {
            console.log(`[SC-RAW] Thumb generation failed for ${safeName}:`, e.message);
        }
    }
    
    // For videos, try ffmpeg if available
    if (isVideo && ffmpegPath !== 'ffmpeg') {
        try {
            const { execSync } = require('child_process');
            const tmpThumb = path.join(rawMetaDir, `${safeName}.thumb.jpg`);
            execSync(`"${ffmpegPath}" -y -i "${filePath}" -ss 00:00:01 -vframes 1 -vf "scale=220:-1" "${tmpThumb}"`, { timeout: 10000 });
            if (fs.existsSync(tmpThumb)) {
                const thumbBuffer = fs.readFileSync(tmpThumb);
                fs.unlinkSync(tmpThumb);
                res.setHeader('Content-Type', 'image/jpeg');
                return res.send(thumbBuffer);
            }
        } catch (e) {
            console.log(`[SC-RAW] Video thumb failed for ${safeName}:`, e.message);
        }
    }
    
    res.status(404).json({ error: 'Thumbnail not available' });
});

// Delete raw file
app.delete('/api/cloud/raw/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const filePath = path.join(rawDir, safeName);
    const metaPath = path.join(rawMetaDir, `${safeName}.json`);
    
    if (!filePath.startsWith(rawDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        console.log(`[SC-RAW] Deleted: ${safeName}`);
        res.json({ success: true, filename: safeName });
    } catch (e) {
        console.error(`[SC-RAW] Delete failed for ${safeName}:`, e.message);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Unified list: Get both encrypted manifests and raw files
app.get('/api/cloud/files', authenticateToken, (req, res) => {
    const { manifestsDir, rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const includeMeta = req.query.meta === 'true';
    
    const files = [];
    
    // Get encrypted files from manifests
    if (fs.existsSync(manifestsDir)) {
        try {
            const manifests = fs.readdirSync(manifestsDir)
                .filter(f => f.endsWith('.json'))
                .map(f => {


// DELETE /api/account - Delete user account and all associated data (GDPR compliance)
app.delete('/api/account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email || '';
        const userKey = getStealthCloudUserKey(req.user);
        
        console.log(`[Account Deletion] Starting deletion for user ${userId} (${userEmail})`);
        
        // Get user directories
        const userDir = path.join(CLOUD_DIR, 'users', userKey);
        const chunksDir = CHUNKS_DIR 
            ? path.join(CHUNKS_DIR, 'users', userKey)
            : path.join(userDir, 'chunks');
        const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid || '');
        
        // Delete all user files (chunks, manifests, classic uploads)
        const dirsToDelete = [chunksDir, userDir, deviceDir].filter(d => d && d.length > 10);
        for (const dir of dirsToDelete) {
            try {
                if (fs.existsSync(dir)) {
                    fs.rmSync(dir, { recursive: true, force: true });
                    console.log(`[Account Deletion] Deleted directory: ${dir}`);
                }
            } catch (e) {
                console.error(`[Account Deletion] Error deleting ${dir}:`, e.message);
            }
        }
        
        // Delete user from database
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM user_plans WHERE user_id = ?', [userId], (err) => {
                if (err) console.error('[Account Deletion] Error deleting user_plans:', err.message);
                resolve();
            });
        });
        
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
                if (err) {
                    console.error('[Account Deletion] Error deleting user:', err.message);
                    reject(err);
                } else {
                    console.log(`[Account Deletion] User ${userId} deleted from database`);
                    resolve();
                }
            });
        });
        
        console.log(`[Account Deletion] Successfully deleted account for user ${userId}`);
        res.json({ success: true, message: 'Account and all associated data deleted successfully' });
    } catch (error) {
        console.error('[Account Deletion] Error:', error);
        res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
    }
});

// ============================================================================
// EXIF METADATA PRESERVATION (Universal cross-platform)
// ============================================================================

// EXIF data is stored by file hash for universal cross-platform preservation
// When files are synced/restored, EXIF can be applied regardless of source platform
const EXIF_DIR = path.join(CLOUD_DIR, 'exif');
if (!fs.existsSync(EXIF_DIR)) {
    fs.mkdirSync(EXIF_DIR, { recursive: true });
}

// Get EXIF file path by hash (uses first 2 chars as subdirectory for performance)
const getExifPath = (fileHash) => {
    const safeHash = String(fileHash || '').replace(/[^a-fA-F0-9]/g, '').slice(0, 64);
    if (!safeHash || safeHash.length < 8) return null;
    const subDir = safeHash.slice(0, 2);
    const exifSubDir = path.join(EXIF_DIR, subDir);
    if (!fs.existsSync(exifSubDir)) {
        fs.mkdirSync(exifSubDir, { recursive: true });
    }
    return path.join(exifSubDir, `${safeHash}.json`);
};

// Store EXIF metadata by file hash
app.post('/api/exif/store', authenticateToken, async (req, res) => {
    try {
        const { fileHash, exif, platform } = req.body || {};
        
        if (!fileHash || typeof fileHash !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid fileHash' });
        }
        
        if (!exif || typeof exif !== 'object') {
            return res.status(400).json({ error: 'Missing or invalid exif object' });
        }
        
        const exifPath = getExifPath(fileHash);
        if (!exifPath) {
            return res.status(400).json({ error: 'Invalid fileHash format' });
        }
        
        // Don't overwrite existing EXIF (first upload wins)
        if (fs.existsSync(exifPath)) {
            return res.json({ ok: true, exists: true, message: 'EXIF already stored' });
        }
        
        const exifData = {
            fileHash: fileHash.slice(0, 64),
            platform: String(platform || 'unknown').slice(0, 20),
            storedAt: new Date().toISOString(),
            userId: req.user.id,
            exif: exif,
        };
        
        fs.writeFileSync(exifPath, JSON.stringify(exifData, null, 2), 'utf8');
        console.log(`[EXIF] Stored EXIF for hash ${fileHash.slice(0, 16)}... (${platform})`);
        
        return res.json({ ok: true, stored: true });
    } catch (e) {
        console.error('[EXIF] Store error:', e.message);
        return res.status(500).json({ error: 'Failed to store EXIF' });
    }
});

// Retrieve EXIF metadata by file hash
app.get('/api/exif/:fileHash', authenticateToken, async (req, res) => {
    try {
        const fileHash = req.params.fileHash;
        
        if (!fileHash || typeof fileHash !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid fileHash' });
        }
        
        const exifPath = getExifPath(fileHash);
        if (!exifPath) {
            return res.status(400).json({ error: 'Invalid fileHash format' });
        }
        
        if (!fs.existsSync(exifPath)) {
            return res.status(404).json({ error: 'EXIF not found', fileHash });
        }
        
        const exifData = JSON.parse(fs.readFileSync(exifPath, 'utf8'));
        return res.json(exifData);
    } catch (e) {
        console.error('[EXIF] Retrieve error:', e.message);
        return res.status(500).json({ error: 'Failed to retrieve EXIF' });
    }
});

// Batch retrieve EXIF for multiple file hashes (for sync operations)
app.post('/api/exif/batch', authenticateToken, async (req, res) => {
    try {
        const { fileHashes } = req.body || {};
        
        if (!Array.isArray(fileHashes)) {
            return res.status(400).json({ error: 'fileHashes must be an array' });
        }
        
        // Limit batch size to prevent abuse
        const limitedHashes = fileHashes.slice(0, 100);
        const results = {};
        
        for (const hash of limitedHashes) {
            if (!hash || typeof hash !== 'string') continue;
            
            const exifPath = getExifPath(hash);
            if (!exifPath) continue;
            
            if (fs.existsSync(exifPath)) {
                try {
                    results[hash] = JSON.parse(fs.readFileSync(exifPath, 'utf8'));
                } catch (e) {
                    // Skip invalid files
                }
            }
        }
        
        return res.json({ exifData: results, found: Object.keys(results).length });
    } catch (e) {
        console.error('[EXIF] Batch retrieve error:', e.message);
        return res.status(500).json({ error: 'Failed to retrieve EXIF batch' });
    }
});

// ============================================================================
// NFT IMAGE STORAGE (StealthCloud-based, publicly accessible)
// ============================================================================

// NFT images are stored in a separate 'nft' folder per user
// They are NOT encrypted so they can be served publicly for NFT metadata
const NFT_DIR = path.join(CLOUD_DIR, 'nft');
if (!fs.existsSync(NFT_DIR)) {
    fs.mkdirSync(NFT_DIR, { recursive: true });
}

// Ensure user NFT directory exists
const ensureUserNftDir = (userId) => {
    const userNftDir = path.join(NFT_DIR, String(userId));
    if (!fs.existsSync(userNftDir)) {
        fs.mkdirSync(userNftDir, { recursive: true });
    }
    return userNftDir;
};

// Check if user has StealthCloud subscription with available space
const checkNftStorageEligibility = async (userId, fileSizeBytes) => {
    const quotaBytes = await getUserQuotaBytes(userId);
    const usedBytes = await getUserUsedBytes(userId);
    
    if (quotaBytes <= 0) {
        return { eligible: false, reason: 'No active StealthCloud plan' };
    }
    
    const availableBytes = quotaBytes - usedBytes;
    if (fileSizeBytes > availableBytes) {
        return { 
            eligible: false, 
            reason: 'Not enough space',
            availableBytes,
            requiredBytes: fileSizeBytes,
        };
    }
    
    return { 
        eligible: true, 
        quotaBytes, 
        usedBytes, 
        availableBytes,
    };
};

// Upload NFT image to StealthCloud (authenticated)
// POST /api/nft/upload
// Body: multipart form with 'image' file
// Returns: { success, imageId, publicUrl }
const nftUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, GIF, WebP images allowed'));
        }
    },
});

app.post('/api/nft/upload', authenticateToken, nftUpload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }
        
        const userId = req.user.id;
        const fileSize = req.file.size;
        
        // NFT uploads are allowed for all authenticated users without subscription check
        // NFT images/thumbnails are essential for NFT functionality and users pay commission per mint
        // No quota check - NFT storage is separate from backup storage
        
        // Generate unique image ID
        const imageId = crypto.randomBytes(16).toString('hex');
        const ext = req.file.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : req.file.mimetype.split('/')[1];
        const filename = `${imageId}.${ext}`;
        
        // Save to user's NFT directory
        const userNftDir = ensureUserNftDir(userId);
        const filePath = path.join(userNftDir, filename);
        fs.writeFileSync(filePath, req.file.buffer);
        
        // Public URL (served via nft.stealthlynk.io or /api/nft/image/:userId/:imageId)
        const publicUrl = `https://nft.stealthlynk.io/${userId}/${filename}`;
        const fallbackUrl = `/api/nft/image/${userId}/${filename}`;
        
        console.log(`[NFT] Image uploaded: user=${userId} id=${imageId} size=${fileSize}`);
        
        res.json({
            success: true,
            imageId,
            filename,
            publicUrl,
            fallbackUrl,
            size: fileSize,
        });
    } catch (error) {
        console.error('[NFT] Upload error:', error);
        res.status(500).json({ error: 'Failed to upload NFT image' });
    }
});

// Check NFT storage eligibility (for UI to show/hide option)
// GET /api/nft/eligibility?size=<bytes>
app.get('/api/nft/eligibility', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const fileSize = parseInt(req.query.size) || 5 * 1024 * 1024; // Default 5MB estimate
        
        const eligibility = await checkNftStorageEligibility(userId, fileSize);
        res.json(eligibility);
    } catch (error) {
        console.error('[NFT] Eligibility check error:', error);
        res.status(500).json({ error: 'Failed to check eligibility' });
    }
});

// List user's NFT images
// GET /api/nft/images
app.get('/api/nft/images', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userNftDir = path.join(NFT_DIR, String(userId));
        
        if (!fs.existsSync(userNftDir)) {
            return res.json({ images: [] });
        }
        
        const files = fs.readdirSync(userNftDir);
        const images = files.map(f => {
            const filePath = path.join(userNftDir, f);
            const stats = fs.statSync(filePath);
            return {
                filename: f,
                imageId: f.replace(/\.[^.]+$/, ''),
                publicUrl: `https://nft.stealthlynk.io/${userId}/${f}`,
                fallbackUrl: `/api/nft/image/${userId}/${f}`,
                size: stats.size,
                createdAt: stats.birthtime,
            };
        });
        
        res.json({ images });
    } catch (error) {
        console.error('[NFT] List images error:', error);
        res.status(500).json({ error: 'Failed to list NFT images' });
    }
});

// PUBLIC: Serve NFT image (no authentication required)
// GET /api/nft/image/:userId/:filename OR /:userId/:filename (for nft.stealthlynk.io subdomain)
// This endpoint is publicly accessible so NFT wallets/marketplaces can display images
const serveNftImage = (req, res) => {
    try {
        const { userId, filename } = req.params;
        
        // Sanitize inputs
        const safeUserId = String(userId).replace(/[^0-9]/g, '');
        const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, '');
        
        if (!safeUserId || !safeFilename) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        
        const filePath = path.join(NFT_DIR, safeUserId, safeFilename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        
        // Determine content type
        const ext = path.extname(safeFilename).toLowerCase();
        const contentTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
        };
        const contentType = contentTypes[ext] || 'application/octet-stream';
        
        // Set cache headers for CDN/browser caching
        // Override helmet's restrictive CORP header for public NFT images
        res.set({
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable', // 1 year cache
            'Access-Control-Allow-Origin': '*', // Allow cross-origin for NFT viewers
            'Cross-Origin-Resource-Policy': 'cross-origin', // Allow embedding in any origin
        });
        
        res.sendFile(filePath);
    } catch (error) {
        console.error('[NFT] Serve image error:', error);
        res.status(500).json({ error: 'Failed to serve image' });
    }
};

// Register both routes for NFT image serving
app.get('/api/nft/image/:userId/:filename', serveNftImage);
// Also handle /:userId/:filename for nft.stealthlynk.io subdomain (no /api/nft/image prefix)
app.get('/:userId/:filename', (req, res, next) => {
    // Only handle if userId is numeric and filename looks like an image
    const { userId, filename } = req.params;
    if (/^\d+$/.test(userId) && /\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
        return serveNftImage(req, res);
    }
    next(); // Pass to other routes if not an NFT image request
});

// Delete NFT image (authenticated, owner only)
// DELETE /api/nft/image/:imageId
app.delete('/api/nft/image/:imageId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { imageId } = req.params;
        
        const userNftDir = path.join(NFT_DIR, String(userId));
        if (!fs.existsSync(userNftDir)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        
        // Find file with this imageId
        const files = fs.readdirSync(userNftDir);
        const file = files.find(f => f.startsWith(imageId));
        
        if (!file) {
            return res.status(404).json({ error: 'Image not found' });
        }
        
        const filePath = path.join(userNftDir, file);
        fs.unlinkSync(filePath);
        
        console.log(`[NFT] Image deleted: user=${userId} id=${imageId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('[NFT] Delete image error:', error);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

// ============================================================================
// NFT ALBUM SYNC (persists NFT metadata across app reinstalls)
// ============================================================================

// NFT metadata storage file per user
const getNftMetadataPath = (userId) => path.join(NFT_DIR, String(userId), 'nft-album.json');

// Get user's NFT album (list of minted NFTs)
// GET /api/nft/list
app.get('/api/nft/list', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const metadataPath = getNftMetadataPath(userId);
        
        if (!fs.existsSync(metadataPath)) {
            return res.json({ success: true, nfts: [] });
        }
        
        const data = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        console.log(`[NFT] Album list: user=${userId} count=${data.nfts?.length || 0}`);
        res.json({ success: true, nfts: data.nfts || [] });
    } catch (error) {
        console.error('[NFT] List error:', error);
        res.status(500).json({ error: 'Failed to get NFT list' });
    }
});

// Sync NFT album (add, remove, or backup NFTs)
// POST /api/nft/sync
// Body: { action: 'add'|'remove'|'backup', nft?: {}, mintAddress?: '', nfts?: [] }
app.post('/api/nft/sync', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { action, nft, mintAddress, nfts } = req.body;
        
        const userNftDir = path.join(NFT_DIR, String(userId));
        if (!fs.existsSync(userNftDir)) {
            fs.mkdirSync(userNftDir, { recursive: true });
        }
        
        const metadataPath = getNftMetadataPath(userId);
        let data = { nfts: [] };
        
        if (fs.existsSync(metadataPath)) {
            try {
                data = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            } catch (e) {
                data = { nfts: [] };
            }
        }
        
        if (action === 'add' && nft) {
            // Add single NFT (avoid duplicates)
            const exists = data.nfts.some(n => n.mintAddress === nft.mintAddress);
            if (!exists) {
                data.nfts.push(nft);
                console.log(`[NFT] Album add: user=${userId} mint=${nft.mintAddress}`);
            }
        } else if (action === 'remove' && mintAddress) {
            // Remove NFT by mint address
            const before = data.nfts.length;
            data.nfts = data.nfts.filter(n => n.mintAddress !== mintAddress);
            console.log(`[NFT] Album remove: user=${userId} mint=${mintAddress} removed=${before - data.nfts.length}`);
        } else if (action === 'backup' && Array.isArray(nfts)) {
            // Backup: merge all NFTs (avoid duplicates)
            const existingMints = new Set(data.nfts.map(n => n.mintAddress));
            let added = 0;
            for (const n of nfts) {
                if (!existingMints.has(n.mintAddress)) {
                    data.nfts.push(n);
                    existingMints.add(n.mintAddress);
                    added++;
                }
            }
            console.log(`[NFT] Album backup: user=${userId} added=${added} total=${data.nfts.length}`);
        } else {
            return res.status(400).json({ error: 'Invalid action or missing data' });
        }
        
        // Save updated metadata
        fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2));
        res.json({ success: true, count: data.nfts.length });
    } catch (error) {
        console.error('[NFT] Sync error:', error);
        res.status(500).json({ error: 'Failed to sync NFT album' });
    }
});

// Solana RPC proxy - avoids CORS issues when calling from browser
app.post('/solana-rpc', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    const rpcEndpoints = [
        'https://api.mainnet-beta.solana.com',
        'https://rpc.ankr.com/solana',
        'https://solana-mainnet.g.alchemy.com/v2/demo'
    ];
    
    for (const rpc of rpcEndpoints) {
        try {
            const response = await axios.post(rpc, req.body, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });
            return res.json(response.data);
        } catch (e) {
            console.log('[Solana RPC] Failed:', rpc, e.message);
        }
    }
    
    res.status(503).json({ error: 'All RPC endpoints failed' });
});

// Handle CORS preflight for solana-rpc
app.options('/solana-rpc', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(200);
});

// Serve local images via HTTP (for Electron renderer which can't access file:// directly)
app.get('/local-image', (req, res) => {
    const imagePath = req.query.path;
    if (!imagePath) {
        return res.status(400).json({ error: 'No path provided' });
    }
    
    const resolvedPath = path.resolve(imagePath);
    
    // Allow any path for now (desktop app is trusted)
    if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    // Determine content type
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.heic': 'image/heic',
        '.heif': 'image/heif',
    };
    
    // Add CORS headers for Electron renderer
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(resolvedPath).pipe(res);
});

// NFT Payment page - served via HTTP so Phantom extension can interact with it
app.get('/nft-payment', (req, res) => {
    // Set permissive CSP to allow Solana CDN and IPFS gateways
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://bundle.run; img-src 'self' data: blob: https: http:; connect-src 'self' https: wss:; style-src 'self' 'unsafe-inline';");
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PhotoLynk NFT Payment</title>
  <script src="https://bundle.run/buffer@6.0.3"></script>
  <script>if(typeof window.Buffer==='undefined')window.Buffer=buffer.Buffer;</script>
  <script src="https://unpkg.com/@solana/web3.js@1.87.6/lib/index.iife.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js" onerror="console.error('QRCode CDN failed, trying fallback');var s=document.createElement('script');s.src='https://unpkg.com/qrcode@1.5.3/build/qrcode.min.js';document.head.appendChild(s);"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; }
    .container { background: rgba(30, 30, 50, 0.95); border-radius: 24px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid rgba(153, 69, 255, 0.3); }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .nft-preview { width: 120px; height: 120px; border-radius: 16px; margin: 0 auto 20px; overflow: hidden; border: 2px solid rgba(153, 69, 255, 0.5); background: #222; }
    .nft-preview img { width: 100%; height: 100%; object-fit: cover; }
    .nft-name { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .nft-type { font-size: 12px; color: #9945FF; margin-bottom: 20px; }
    .amount-box { background: rgba(20, 241, 149, 0.1); border: 1px solid rgba(20, 241, 149, 0.3); border-radius: 12px; padding: 16px; margin-bottom: 24px; }
    .amount-label { font-size: 12px; color: #888; margin-bottom: 4px; }
    .amount-value { font-size: 28px; font-weight: 700; color: #14F195; }
    .amount-usd { font-size: 14px; color: #888; }
    .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; transition: all 0.2s; margin-bottom: 12px; }
    .btn-phantom { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; }
    .btn-phantom:hover { box-shadow: 0 8px 24px rgba(153, 69, 255, 0.4); transform: translateY(-2px); }
    .btn-phantom:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #888; }
    .status { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 14px; display: none; }
    .status.error { display: block; background: rgba(248, 113, 113, 0.1); color: #F87171; }
    .status.success { display: block; background: rgba(20, 241, 149, 0.1); color: #14F195; }
    .status.info { display: block; background: rgba(153, 69, 255, 0.1); color: #9945FF; }
    .wallet-info { font-size: 12px; color: #666; margin-top: 16px; }
    .spinner { width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container" id="main-container">
    <div class="logo">⬡</div>
    <h1>PhotoLynk NFT</h1>
    <p class="subtitle">Complete payment to mint your memory</p>
    <div class="nft-preview"><img id="nft-image" src="" alt="NFT" onerror="this.style.display='none'"></div>
    <div class="nft-name" id="nft-name">Loading...</div>
    <div class="nft-type" id="nft-type">Compressed NFT</div>
    <div class="amount-box">
      <div class="amount-label">Pay now (App Fee)</div>
      <div class="amount-value" id="amount-sol">0.000 SOL</div>
      <div class="amount-usd" id="amount-usd">≈ $0.00 USD</div>
    </div>

    <div class="amount-box" id="estimated-box" style="display:none;">
      <div class="amount-label">Estimated total cost</div>
      <div class="amount-value" id="estimated-sol">0.000 SOL</div>
      <div class="amount-usd" id="estimated-usd">≈ $0.00 USD</div>
    </div>
    <button class="btn btn-phantom" id="pay-btn" onclick="connectAndPay()"><span>👻</span> Connect Phantom & Pay</button>
    <!-- QR code and external wallets hidden for future development -->
    <div style="display:none;margin:16px 0;color:#666;font-size:12px;">— or scan with any Solana wallet —</div>
    <div id="qr-container" style="display:none;background:#fff;padding:16px;border-radius:12px;margin-bottom:12px;min-width:180px;min-height:180px;"><canvas id="qr-code" width="180" height="180" style="display:block;"></canvas></div>
    <div style="display:none;font-size:10px;color:#888;margin-bottom:8px;">Compatible wallets:</div>
    <div id="wallet-links" style="display:none;flex-wrap:wrap;justify-content:center;gap:8px;margin-bottom:16px;"></div>
    <!-- End hidden QR section -->
    <button class="btn btn-secondary" onclick="window.close()" style="margin-top:16px;">Cancel</button>
    <div class="status" id="status"></div>
    <div class="wallet-info">Recipient: <span id="recipient">...</span></div>
  </div>
  <div class="container" id="success-container" style="display:none;">
    <div class="success-icon">✅</div>
    <h1>Payment Successful!</h1>
    <p class="subtitle">Your NFT is being minted on Solana</p>
    <div class="status success" style="display:block;" id="tx-link"></div>
    <button class="btn btn-phantom" onclick="window.close()" style="margin-top:24px;">Close Window</button>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const recipient = params.get('recipient') || '';
    let amount = parseFloat(params.get('amount')) || 0;
    const feeUsd = parseFloat(params.get('feeUsd')) || 0;
    let solPrice = parseFloat(params.get('solPrice')) || 0;
    const estimatedTotalUsd = parseFloat(params.get('estimatedTotalUsd')) || 0;
    const estimatedTotalSol = parseFloat(params.get('estimatedTotalSol')) || 0;
    const name = params.get('name') || 'PhotoLynk Memory';
    const imageUrl = decodeURIComponent(params.get('imageUrl') || '');
    const nftType = params.get('nftType') || 'compressed';
    const storageOption = params.get('storageOption') || '';
    const fileSizeBytes = parseInt(params.get('fileSizeBytes') || '0', 10) || 0;
    console.log('[NFT Payment] imageUrl:', imageUrl);
    document.getElementById('nft-name').textContent = name;
    const typeLabel = nftType === 'compressed' ? 'Compressed NFT (cNFT)' : 'Standard NFT';
    const storageLabel = storageOption === 'cloud' ? 'StealthCloud' : (storageOption === 'ipfs' ? 'IPFS' : '');
    document.getElementById('nft-type').textContent = storageLabel ? (typeLabel + ' • ' + storageLabel) : typeLabel;
    function renderAmounts(extra) {
      const usdRate = solPrice > 0 ? solPrice : 200;

      // If feeUsd is provided, recompute SOL amount so the USD fee stays constant
      if (feeUsd > 0 && usdRate > 0) {
        amount = feeUsd / usdRate;
      }

      document.getElementById('amount-sol').textContent = amount.toFixed(6) + ' SOL';
      document.getElementById('amount-usd').textContent = '≈ $' + (amount * usdRate).toFixed(2) + ' USD';

      if (estimatedTotalUsd > 0 || estimatedTotalSol > 0) {
        document.getElementById('estimated-box').style.display = 'block';
        let estSol = estimatedTotalSol > 0 ? estimatedTotalSol : (estimatedTotalUsd / usdRate);
        let estUsd = estimatedTotalUsd > 0 ? estimatedTotalUsd : (estimatedTotalSol * usdRate);

        if (extra && typeof extra.estSol === 'number' && extra.estSol > 0) {
          estSol = extra.estSol;
          estUsd = estSol * usdRate;
        }
        document.getElementById('estimated-sol').textContent = estSol.toFixed(6) + ' SOL';
        document.getElementById('estimated-usd').textContent = '≈ $' + estUsd.toFixed(2) + ' USD';
      }
    }

    async function refreshSolPrice() {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { cache: 'no-store' });
        const json = await res.json();
        const p = Number(json?.solana?.usd);
        if (Number.isFinite(p) && p > 0) {
          solPrice = p;
          renderAmounts();
        }
      } catch (e) {
        // ignore
      }
    }

    async function rpc(method, params) {
      const res = await fetch('/solana-rpc', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] })
      });
      const json = await res.json();
      if (json && json.error) throw new Error(json.error.message || 'RPC error');
      return json.result;
    }

    function storageUsdEstimate() {
      if (storageOption === 'cloud') return 0;
      const ARWEAVE_UPLOAD_BASE_USD = 0.01;
      const ARWEAVE_PER_KB_USD = 0.00001;
      const metadataBytes = 2000;
      const imageBytes = fileSizeBytes > 0 ? fileSizeBytes : 0;
      const imgUsd = ARWEAVE_UPLOAD_BASE_USD + (imageBytes / 1024) * ARWEAVE_PER_KB_USD;
      const metaUsd = ARWEAVE_UPLOAD_BASE_USD + (metadataBytes / 1024) * ARWEAVE_PER_KB_USD;
      return imgUsd + metaUsd;
    }

    async function refreshRealtimeEstimate() {
      try {
        const usdRate = solPrice > 0 ? solPrice : 200;

        // Priority fee market (median)
        let priorityLamports = 0;
        try {
          const fees = await rpc('getRecentPrioritizationFees', []);
          if (Array.isArray(fees) && fees.length) {
            const vals = fees.map(x => Number(x && x.prioritizationFee)).filter(n => Number.isFinite(n) && n >= 0).sort((a,b)=>a-b);
            const microLamportsPerCu = vals.length ? vals[Math.floor(vals.length/2)] : 0;
            const cuEstimate = nftType === 'compressed' ? 80000 : 250000;
            priorityLamports = Math.ceil((microLamportsPerCu * cuEstimate) / 1000000);
          }
        } catch (e) {}

        // Rent (standard NFT only)
        let rentLamports = 0;
        if (nftType !== 'compressed') {
          const sizes = [82, 165, 679, 282];
          const rents = await Promise.all(sizes.map(s => rpc('getMinimumBalanceForRentExemption', [s]).catch(()=>0)));
          rentLamports = rents.reduce((a,b)=>a+(Number(b)||0),0);
        }

        const baseFeeLamports = 5000;
        const networkLamports = rentLamports + baseFeeLamports + priorityLamports;
        const networkSol = networkLamports / 1e9;

        const feeSolLive = feeUsd > 0 ? (feeUsd / usdRate) : amount;
        const storageUsd = storageUsdEstimate();
        const storageSol = storageUsd / usdRate;

        const estSol = feeSolLive + networkSol + storageSol;
        renderAmounts({ estSol });
      } catch (e) {
        // ignore
      }
    }

    renderAmounts();
    setInterval(refreshSolPrice, 15000);
    refreshRealtimeEstimate();
    setInterval(refreshRealtimeEstimate, 15000);
    document.getElementById('recipient').textContent = recipient ? recipient.slice(0,4) + '...' + recipient.slice(-4) : '...';
    if (imageUrl) {
      const img = document.getElementById('nft-image');
      img.src = imageUrl;
      img.onerror = function() { console.log('[NFT Payment] Image failed to load:', imageUrl); this.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;">📷</div>'; };
    }
    
    // Generate Solana Pay QR code
    const reference = params.get('reference') || crypto.randomUUID();
    const solanaPayUrl = 'solana:' + recipient + '?amount=' + amount + '&reference=' + reference + '&label=PhotoLynk&message=' + encodeURIComponent(name);
    
    // Compatible wallets with deep-links
    const wallets = [
      { name: 'Phantom', icon: '👻', deepLink: 'https://phantom.app/ul/v1/browse/' + encodeURIComponent(window.location.href) },
      { name: 'Solflare', icon: '🔆', deepLink: 'solflare:' + solanaPayUrl.replace('solana:', '') },
      { name: 'Glow', icon: '✨', deepLink: solanaPayUrl },
      { name: 'Backpack', icon: '🎒', deepLink: solanaPayUrl },
      { name: 'Trust', icon: '🛡️', deepLink: solanaPayUrl },
    ];
    
    // Render wallet buttons
    const walletLinksEl = document.getElementById('wallet-links');
    wallets.forEach(w => {
      const btn = document.createElement('a');
      btn.href = w.deepLink;
      btn.target = '_blank';
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:6px 10px;background:rgba(255,255,255,0.1);border-radius:8px;color:#fff;text-decoration:none;font-size:11px;border:1px solid rgba(255,255,255,0.2);';
      btn.innerHTML = w.icon + ' ' + w.name;
      btn.onmouseover = function() { this.style.borderColor = '#9945FF'; };
      btn.onmouseout = function() { this.style.borderColor = 'rgba(255,255,255,0.2)'; };
      walletLinksEl.appendChild(btn);
    });
    
    let qrAttempts = 0;
    function generateQR() {
      qrAttempts++;
      console.log('[NFT Payment] QR attempt', qrAttempts, 'QRCode defined:', typeof QRCode !== 'undefined');
      if (typeof QRCode !== 'undefined' && QRCode.toCanvas) {
        const canvas = document.getElementById('qr-code');
        if (!canvas) {
          console.error('[NFT Payment] Canvas element not found');
          return;
        }
        QRCode.toCanvas(canvas, solanaPayUrl, { width: 180, margin: 1, color: { dark: '#000000', light: '#ffffff' } }, (err) => {
          if (err) {
            console.error('[NFT Payment] QR error:', err);
            if (qrAttempts < 5) setTimeout(generateQR, 500);
            else document.getElementById('qr-container').innerHTML = '<div style="width:180px;height:180px;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;">QR unavailable</div>';
          } else {
            console.log('[NFT Payment] QR generated successfully');
          }
        });
      } else if (qrAttempts < 10) {
        console.log('[NFT Payment] QRCode not ready, retrying in 300ms...');
        setTimeout(generateQR, 300);
      } else {
        console.error('[NFT Payment] QRCode library failed to load after', qrAttempts, 'attempts');
        document.getElementById('qr-container').innerHTML = '<div style="width:180px;height:180px;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;">QR unavailable</div>';
      }
    }
    // Start QR generation with delay to ensure library loads
    setTimeout(generateQR, 100);
    
    // Poll for QR payment by checking recipient's recent transactions
    let qrPaymentDetected = false;
    let pollInterval = null;
    let lastKnownSig = null;
    const expectedLamports = Math.ceil(amount * 1e9);
    
    async function pollForQRPayment() {
      if (qrPaymentDetected) return;
      try {
        // Get recent signatures for the recipient
        const res = await fetch('/solana-rpc', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [recipient, {limit: 5}] })
        });
        const data = await res.json();
        if (data.result && data.result.length > 0) {
          // Check for new transactions since page load
          for (const tx of data.result) {
            if (lastKnownSig === null) {
              lastKnownSig = tx.signature; // First poll - just record current state
              break;
            }
            if (tx.signature === lastKnownSig) break; // Reached known transactions
            
            // New transaction found - verify it's a payment of correct amount
            console.log('[NFT Payment] New transaction detected:', tx.signature);
            qrPaymentDetected = true;
            clearInterval(pollInterval);
            showStatus('Payment detected! Minting NFT...', 'info');
            await processQRPayment(tx.signature);
            return;
          }
        }
      } catch (err) {
        console.log('[NFT Payment] Poll error:', err.message);
      }
    }
    
    async function processQRPayment(paymentSig) {
      try {
        // Get metadata URL from params
        const metadataUrl = params.get('metadataUrl') || '';
        const nftTypeParam = params.get('nftType') || 'compressed';
        
        // Call server to mint NFT
        const mintRes = await fetch('/api/nft/mint-after-payment', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            paymentSignature: paymentSig,
            recipient: recipient,
            metadataUrl: metadataUrl,
            nftType: nftTypeParam,
            name: name
          })
        });
        
        const mintData = await mintRes.json();
        if (mintData.success) {
          document.getElementById('main-container').style.display = 'none';
          document.getElementById('success-container').style.display = 'block';
          document.getElementById('tx-link').innerHTML = 'NFT Minted! <a href="https://solscan.io/tx/' + (mintData.signature || paymentSig) + '" target="_blank" style="color:#14F195;">View on Solscan</a>';
        } else {
          showStatus('Payment received but mint failed: ' + (mintData.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        console.error('[NFT Payment] Mint after QR payment failed:', err);
        showStatus('Payment received but mint failed: ' + err.message, 'error');
      }
    }
    
    // Start polling for QR payments (every 3 seconds)
    pollInterval = setInterval(pollForQRPayment, 3000);
    console.log('[NFT Payment] QR payment polling started for reference:', reference);
    
    function showStatus(msg, type) { const el = document.getElementById('status'); el.textContent = msg; el.className = 'status ' + type; }
    function setLoading(loading) { const btn = document.getElementById('pay-btn'); btn.disabled = loading; btn.innerHTML = loading ? '<div class="spinner"></div> Processing...' : '<span>👻</span> Connect Phantom & Pay'; }
    
    async function connectAndPay() {
      const provider = window.phantom?.solana || window.solana;
      if (!provider?.isPhantom) { showStatus('Phantom wallet not found. Install it from phantom.app', 'error'); setTimeout(() => window.open('https://phantom.app/', '_blank'), 1500); return; }
      setLoading(true); showStatus('Connecting to Phantom...', 'info');
      try {
        // Try multiple connection methods
        let pubkeyStr;
        if (provider.publicKey) {
          // Already connected
          pubkeyStr = provider.publicKey.toString();
        } else {
          // Try connect with different approaches
          try {
            const resp = await provider.connect();
            pubkeyStr = resp.publicKey.toString();
          } catch (connectErr) {
            console.log('[NFT Payment] connect() failed, trying request():', connectErr.message);
            try {
              const resp = await provider.request({ method: 'connect' });
              pubkeyStr = resp.publicKey.toString();
            } catch (reqErr) {
              console.log('[NFT Payment] request() also failed:', reqErr.message);
              throw new Error('Could not connect to Phantom. Please unlock your wallet and try again.');
            }
          }
        }
        showStatus('Connected: ' + pubkeyStr.slice(0,4) + '...' + pubkeyStr.slice(-4), 'info');
        
        // Get blockhash via local proxy (avoids CORS issues)
        showStatus('Getting blockhash...', 'info');
        const rpcRes = await fetch('/solana-rpc', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{commitment:'confirmed'}] })
        });
        const rpcData = await rpcRes.json();
        if (!rpcData.result?.value?.blockhash) throw new Error('Could not get blockhash');
        const blockhash = rpcData.result.value.blockhash;
        console.log('[NFT Payment] Got blockhash:', blockhash.slice(0,8) + '...');
        
        // Use Solana web3.js to build transaction
        showStatus('Creating transaction...', 'info');
        
        if (typeof solanaWeb3 === 'undefined') {
          throw new Error('Solana library not loaded. Please refresh the page.');
        }
        
        const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, TransactionInstruction } = solanaWeb3;
        const fromPubkey = new PublicKey(pubkeyStr);
        const toPubkey = new PublicKey(recipient);
        const lamports = Math.ceil(amount * LAMPORTS_PER_SOL);
        
        console.log('[NFT Payment] Creating transfer:', lamports, 'lamports to', recipient);
        
        const paymentTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey,
            toPubkey,
            lamports
          })
        );
        paymentTx.recentBlockhash = blockhash;
        paymentTx.feePayer = fromPubkey;
        
        showStatus('Approve payment in Phantom...', 'info');
        const { signature: paymentSig } = await provider.signAndSendTransaction(paymentTx);
        console.log('[NFT Payment] Payment sent:', paymentSig);
        
        // Now mint the NFT based on type
        showStatus('Minting your NFT...', 'info');
        const nftTypeParam = new URLSearchParams(window.location.search).get('nftType') || 'compressed';
        
        // Get fresh blockhash for mint transaction
        const rpcRes2 = await fetch('/solana-rpc', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{commitment:'confirmed'}] })
        });
        const rpcData2 = await rpcRes2.json();
        const blockhash2 = rpcData2.result.value.blockhash;
        
        let mintSig;
        
        if (nftTypeParam === 'standard') {
          // ========== STANDARD NFT MINTING ==========
          // Standard NFTs require SPL Token + Metaplex Token Metadata
          // This is more expensive (~0.02 SOL) but creates a traditional NFT
          
          const { Keypair } = solanaWeb3;
          const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
          const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
          const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
          const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');
          
          // Generate new mint keypair
          const mintKeypair = Keypair.generate();
          const mintPubkey = mintKeypair.publicKey;
          console.log('[NFT Payment] Standard NFT mint address:', mintPubkey.toBase58());
          
          // Derive PDAs
          const [associatedTokenAccount] = PublicKey.findProgramAddressSync(
            [fromPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
          );
          const [metadataAccount] = PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
            TOKEN_METADATA_PROGRAM_ID
          );
          const [masterEditionAccount] = PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer(), new TextEncoder().encode('edition')],
            TOKEN_METADATA_PROGRAM_ID
          );
          
          // Get rent for mint account (82 bytes)
          const rentRes = await fetch('/solana-rpc', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMinimumBalanceForRentExemption', params: [82] })
          });
          const rentData = await rentRes.json();
          const mintRent = rentData.result;
          
          // 1. Create mint account
          const createMintIx = SystemProgram.createAccount({
            fromPubkey: fromPubkey,
            newAccountPubkey: mintPubkey,
            space: 82,
            lamports: mintRent,
            programId: TOKEN_PROGRAM_ID,
          });
          
          // 2. Initialize mint (0 decimals, owner is user)
          const initMintData = new Uint8Array([0, 0, ...fromPubkey.toBytes(), 1, ...fromPubkey.toBytes()]);
          const initMintIx = new TransactionInstruction({
            keys: [
              { pubkey: mintPubkey, isSigner: false, isWritable: true },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            ],
            programId: TOKEN_PROGRAM_ID,
            data: initMintData,
          });
          
          // 3. Create ATA
          const createATAIx = new TransactionInstruction({
            keys: [
              { pubkey: fromPubkey, isSigner: true, isWritable: true },
              { pubkey: associatedTokenAccount, isSigner: false, isWritable: true },
              { pubkey: fromPubkey, isSigner: false, isWritable: false },
              { pubkey: mintPubkey, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            programId: ASSOCIATED_TOKEN_PROGRAM_ID,
            data: new Uint8Array([]),
          });
          
          // 4. Mint 1 token
          const mintToData = new Uint8Array([7, 1, 0, 0, 0, 0, 0, 0, 0]);
          const mintToIx = new TransactionInstruction({
            keys: [
              { pubkey: mintPubkey, isSigner: false, isWritable: true },
              { pubkey: associatedTokenAccount, isSigner: false, isWritable: true },
              { pubkey: fromPubkey, isSigner: true, isWritable: false },
            ],
            programId: TOKEN_PROGRAM_ID,
            data: mintToData,
          });
          
          // 5. Create Metadata (CreateMetadataAccountV3 - discriminator 33)
          const nftNameParam = new URLSearchParams(window.location.search).get('name') || 'PhotoLynk Memory';
          const metadataUrlParam = new URLSearchParams(window.location.search).get('metadataUrl') || '';
          
          // Serialize metadata instruction data
          function serializeMetadataV3(name, symbol, uri, sellerFeeBasisPoints) {
            const nameBytes = new TextEncoder().encode(name.slice(0, 32));
            const symbolBytes = new TextEncoder().encode(symbol.slice(0, 10));
            const uriBytes = new TextEncoder().encode(uri.slice(0, 200));
            
            // Calculate total size: discriminator(1) + name(4+len) + symbol(4+len) + uri(4+len) + fee(2) + creators(1) + collection(1) + uses(1) + isMutable(1) + collectionDetails(1)
            const totalSize = 1 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 2 + 1 + 1 + 1 + 1 + 1;
            const data = new Uint8Array(totalSize);
            let offset = 0;
            
            data[offset++] = 33; // CreateMetadataAccountV3 discriminator
            
            // Name (borsh string)
            new DataView(data.buffer).setUint32(offset, nameBytes.length, true); offset += 4;
            data.set(nameBytes, offset); offset += nameBytes.length;
            
            // Symbol
            new DataView(data.buffer).setUint32(offset, symbolBytes.length, true); offset += 4;
            data.set(symbolBytes, offset); offset += symbolBytes.length;
            
            // URI
            new DataView(data.buffer).setUint32(offset, uriBytes.length, true); offset += 4;
            data.set(uriBytes, offset); offset += uriBytes.length;
            
            // Seller fee basis points
            new DataView(data.buffer).setUint16(offset, sellerFeeBasisPoints, true); offset += 2;
            
            // Creators: None (0)
            data[offset++] = 0;
            // Collection: None (0)
            data[offset++] = 0;
            // Uses: None (0)
            data[offset++] = 0;
            // Is mutable: true (1)
            data[offset++] = 1;
            // Collection details: None (0)
            data[offset++] = 0;
            
            return data;
          }
          
          const metadataData = serializeMetadataV3(nftNameParam, 'PLNK', metadataUrlParam, 500);
          const createMetadataIx = new TransactionInstruction({
            keys: [
              { pubkey: metadataAccount, isSigner: false, isWritable: true },
              { pubkey: mintPubkey, isSigner: false, isWritable: false },
              { pubkey: fromPubkey, isSigner: true, isWritable: false },  // mint authority
              { pubkey: fromPubkey, isSigner: true, isWritable: true },   // payer
              { pubkey: fromPubkey, isSigner: false, isWritable: false }, // update authority
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            ],
            programId: TOKEN_METADATA_PROGRAM_ID,
            data: metadataData,
          });
          
          // 6. Create Master Edition (CreateMasterEditionV3 - discriminator 17)
          // Data: discriminator(1) + max_supply Option<u64> = Some(0) means no prints
          const masterEditionData = new Uint8Array([17, 1, 0, 0, 0, 0, 0, 0, 0, 0]); // discriminator + Some(0)
          const createMasterEditionIx = new TransactionInstruction({
            keys: [
              { pubkey: masterEditionAccount, isSigner: false, isWritable: true },
              { pubkey: mintPubkey, isSigner: false, isWritable: true },
              { pubkey: fromPubkey, isSigner: true, isWritable: false },  // update authority
              { pubkey: fromPubkey, isSigner: true, isWritable: false },  // mint authority
              { pubkey: fromPubkey, isSigner: true, isWritable: true },   // payer
              { pubkey: metadataAccount, isSigner: false, isWritable: true },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            ],
            programId: TOKEN_METADATA_PROGRAM_ID,
            data: masterEditionData,
          });
          
          const standardTx = new Transaction()
            .add(createMintIx)
            .add(initMintIx)
            .add(createATAIx)
            .add(mintToIx)
            .add(createMetadataIx)
            .add(createMasterEditionIx);
          standardTx.recentBlockhash = blockhash2;
          standardTx.feePayer = fromPubkey;
          standardTx.partialSign(mintKeypair);
          
          showStatus('Approve standard NFT mint in Phantom...', 'info');
          const result = await provider.signAndSendTransaction(standardTx);
          mintSig = result.signature;
          console.log('[NFT Payment] Standard NFT minted:', mintSig, 'Mint:', mintPubkey.toBase58());
          
          // Send success data to app
          const imageUrlStd = new URLSearchParams(window.location.search).get('imageUrl') || '';
          const amountStd = new URLSearchParams(window.location.search).get('amount') || '0';
          fetch('/nft-mint-success', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              paymentTx: paymentSig,
              mintTx: mintSig,
              imageUrl: imageUrlStd,
              amount: parseFloat(amountStd),
              nftType: 'standard',
              mintAddress: mintPubkey.toBase58()
            })
          }).catch(e => console.log('Failed to notify app:', e));
          
          document.getElementById('main-container').style.display = 'none';
          document.getElementById('success-container').style.display = 'block';
          document.getElementById('tx-link').innerHTML = 'Payment: <a href="https://solscan.io/tx/' + paymentSig + '" target="_blank" style="color:#14F195;">' + paymentSig.slice(0,8) + '...</a><br>NFT Mint: <a href="https://solscan.io/tx/' + mintSig + '" target="_blank" style="color:#14F195;">' + mintSig.slice(0,8) + '...</a><br>Mint Address: <span style="color:#9945FF;font-size:10px;">' + mintPubkey.toBase58() + '</span>';
          
          // Auto-close after 3 seconds
          setTimeout(() => window.close(), 3000);
          return;
        }
        
        // ========== COMPRESSED NFT (cNFT) MINTING ==========
        // Bubblegum program IDs - PhotoLynk shared Merkle tree
        const MERKLE_TREE = '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS';
        const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
        const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
        const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
        const merkleTreePubkey = new PublicKey(MERKLE_TREE);
        
        // Derive tree config PDA
        const [treeConfig] = PublicKey.findProgramAddressSync(
          [merkleTreePubkey.toBuffer()],
          BUBBLEGUM_PROGRAM_ID
        );
        
        // Build metadata for the cNFT - exact borsh serialization matching mobile app
        const nftNameParam = new URLSearchParams(window.location.search).get('name') || 'PhotoLynk Memory';
        const metadataUrlParam = new URLSearchParams(window.location.search).get('metadataUrl') || '';
        
        // Serialize metadata args for Bubblegum mintV1 (exact order from mpl-bubblegum)
        function serializeString(str) {
          const bytes = new TextEncoder().encode(str || '');
          const len = new Uint8Array(4);
          new DataView(len.buffer).setUint32(0, bytes.length, true);
          return new Uint8Array([...len, ...bytes]);
        }
        
        const buffers = [];
        // name (string: 4-byte length + data)
        buffers.push(serializeString(nftNameParam.slice(0, 32)));
        // symbol (string)
        buffers.push(serializeString('PLNK'));
        // uri (string)
        buffers.push(serializeString(metadataUrlParam));
        // sellerFeeBasisPoints (u16) - 500 = 5%
        const feeBuf = new Uint8Array(2);
        new DataView(feeBuf.buffer).setUint16(0, 500, true);
        buffers.push(feeBuf);
        // primarySaleHappened (bool) - false
        buffers.push(new Uint8Array([0]));
        // isMutable (bool) - true
        buffers.push(new Uint8Array([1]));
        // editionNonce (Option<u8>): None = 0
        buffers.push(new Uint8Array([0]));
        // tokenStandard (Option<TokenStandard>): Some(NonFungible=0) = [1, 0]
        buffers.push(new Uint8Array([1, 0]));
        // collection (Option<Collection>): None = 0
        buffers.push(new Uint8Array([0]));
        // uses (Option<Uses>): None = 0
        buffers.push(new Uint8Array([0]));
        // tokenProgramVersion (enum: 0 = Original)
        buffers.push(new Uint8Array([0]));
        // creators (Vec<Creator>): 4-byte length + array
        const creatorsLen = new Uint8Array(4);
        new DataView(creatorsLen.buffer).setUint32(0, 1, true);
        buffers.push(creatorsLen);
        // Creator: address (32 bytes) + verified (bool) + share (u8)
        buffers.push(fromPubkey.toBytes());
        buffers.push(new Uint8Array([1])); // verified = true (matches successful tx)
        buffers.push(new Uint8Array([100])); // share = 100%
        
        // Combine all buffers
        const totalLen = buffers.reduce((acc, b) => acc + b.length, 0);
        const metadataArgs = new Uint8Array(totalLen);
        let offset = 0;
        for (const buf of buffers) { metadataArgs.set(buf, offset); offset += buf.length; }
        
        // Discriminator for mintV1 instruction
        const discriminator = new Uint8Array([145, 98, 192, 118, 184, 147, 118, 104]);
        const instructionData = new Uint8Array(discriminator.length + metadataArgs.length);
        instructionData.set(discriminator, 0);
        instructionData.set(metadataArgs, discriminator.length);
        
        const mintInstruction = new TransactionInstruction({
          keys: [
            { pubkey: treeConfig, isSigner: false, isWritable: true },       // 0: treeConfig
            { pubkey: fromPubkey, isSigner: false, isWritable: false },      // 1: leafOwner
            { pubkey: fromPubkey, isSigner: false, isWritable: false },      // 2: leafDelegate
            { pubkey: merkleTreePubkey, isSigner: false, isWritable: true }, // 3: merkleTree
            { pubkey: fromPubkey, isSigner: true, isWritable: true },        // 4: payer
            { pubkey: fromPubkey, isSigner: true, isWritable: false },       // 5: treeCreatorOrDelegate
            { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: BUBBLEGUM_PROGRAM_ID,
          data: instructionData,
        });
        
        const mintTx = new Transaction().add(mintInstruction);
        mintTx.recentBlockhash = blockhash2;
        mintTx.feePayer = fromPubkey;
        
        showStatus('Approve NFT mint in Phantom...', 'info');
        const mintResult = await provider.signAndSendTransaction(mintTx);
        mintSig = mintResult.signature;
        console.log('[NFT Payment] NFT minted:', mintSig);
        
        // Send success data to app
        const imageUrl = new URLSearchParams(window.location.search).get('imageUrl') || '';
        const amountParam = new URLSearchParams(window.location.search).get('amount') || '0';
        fetch('/nft-mint-success', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentTx: paymentSig,
            mintTx: mintSig,
            imageUrl: imageUrl,
            amount: parseFloat(amountParam),
            nftType: nftTypeParam
          })
        }).catch(e => console.log('Failed to notify app:', e));
        
        document.getElementById('main-container').style.display = 'none';
        document.getElementById('success-container').style.display = 'block';
        document.getElementById('tx-link').innerHTML = 'Payment: <a href="https://solscan.io/tx/' + paymentSig + '" target="_blank" style="color:#14F195;">' + paymentSig.slice(0,8) + '...</a><br>NFT Mint: <a href="https://solscan.io/tx/' + mintSig + '" target="_blank" style="color:#14F195;">' + mintSig.slice(0,8) + '...</a>';
        
        // Auto-close after 3 seconds
        setTimeout(() => window.close(), 3000);
      } catch (err) { console.error('Payment error:', err); showStatus(err.message || 'Payment failed', 'error'); setLoading(false); }
    }
  </script>
</body>
</html>`);
});

// NFT mint success callback - receives mint details from browser to show in app
app.post('/nft-mint-success', (req, res) => {
    const { paymentTx, mintTx, imageUrl, amount, nftType } = req.body;
    console.log('[NFT] Mint success received:', { paymentTx, mintTx, amount, nftType });
    // Store for app to poll
    global.nftMintSuccess = {
        paymentTx,
        mintTx,
        imageUrl,
        amount,
        nftType,
        timestamp: Date.now()
    };
    res.json({ success: true });
});

// NFT mint success poll endpoint - app polls this to get mint details
app.get('/nft-mint-success', (req, res) => {
    const data = global.nftMintSuccess;
    if (data && Date.now() - data.timestamp < 60000) { // Valid for 60 seconds
        global.nftMintSuccess = null; // Clear after reading
        res.json({ success: true, ...data });
    } else {
        res.json({ success: false });
    }
});

// NFT mint after QR payment - called when QR payment is detected via polling
app.post('/api/nft/mint-after-payment', async (req, res) => {
    const { paymentSignature, recipient, metadataUrl, nftType, name } = req.body;
    console.log('[NFT] Mint after QR payment:', { paymentSignature, nftType, name });
    
    try {
        // For now, store the success for the app to poll
        // In a full implementation, this would trigger actual NFT minting via Metaplex
        global.nftMintSuccess = {
            paymentTx: paymentSignature,
            mintTx: paymentSignature, // Same as payment for QR flow
            imageUrl: metadataUrl,
            amount: 0,
            nftType: nftType || 'compressed',
            name: name,
            timestamp: Date.now()
        };
        
        console.log('[NFT] QR payment mint success stored for app polling');
        res.json({ success: true, signature: paymentSignature });
    } catch (err) {
        console.error('[NFT] Mint after QR payment error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Wallet connected callback - receives address from browser and broadcasts to Electron app
app.post('/wallet-connected', (req, res) => {
    const { address } = req.body;
    if (!address) {
        return res.status(400).json({ success: false, error: 'No address provided' });
    }
    console.log('[Wallet] Connected from browser:', address);
    // Store in memory for the app to poll
    global.connectedWalletAddress = address;
    global.walletJustConnected = true; // Flag to bring app to front
    res.json({ success: true });
});

// Wallet address poll endpoint - Electron app polls this to get the connected address
// Note: Address is cleared 5 seconds after first read to allow multiple windows to receive it
app.get('/wallet-address', (req, res) => {
    const address = global.connectedWalletAddress;
    const bringToFront = global.walletJustConnected;
    if (address) {
        // Clear bringToFront immediately but keep address for 5 seconds
        // This allows multiple windows to receive the address
        if (bringToFront) {
            global.walletJustConnected = false;
            // Clear address after 5 seconds
            setTimeout(() => {
                if (global.connectedWalletAddress === address) {
                    global.connectedWalletAddress = null;
                }
            }, 5000);
        }
        res.json({ success: true, address, bringToFront });
    } else {
        res.json({ success: false });
    }
});

// Wallet connect page - for connecting Phantom in browser
app.get('/wallet-connect', (req, res) => {
    // Headers to help Phantom extension work properly
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob: https: http:; connect-src 'self' https: wss:; style-src 'self' 'unsafe-inline';");
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Wallet - PhotoLynk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; }
    .container { background: rgba(30, 30, 50, 0.95); border-radius: 24px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid rgba(153, 69, 255, 0.3); }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; transition: all 0.2s; margin-bottom: 12px; }
    .btn-phantom { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; }
    .btn-phantom:hover { box-shadow: 0 8px 24px rgba(153, 69, 255, 0.4); transform: translateY(-2px); }
    .btn-phantom:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #888; }
    .status { margin-top: 20px; padding: 14px; border-radius: 10px; font-size: 14px; display: none; }
    .status.error { display: block; background: rgba(248, 113, 113, 0.1); color: #F87171; }
    .status.success { display: block; background: rgba(20, 241, 149, 0.1); color: #14F195; }
    .status.info { display: block; background: rgba(153, 69, 255, 0.1); color: #9945FF; }
    .spinner { width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .wallet-address { font-family: monospace; font-size: 12px; word-break: break-all; margin-top: 8px; color: #14F195; }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
    .copy-btn { background: rgba(153,69,255,0.2); border: none; color: #9945FF; padding: 8px 16px; border-radius: 8px; cursor: pointer; margin-top: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container" id="connect-container">
    <div class="logo">👻</div>
    <h1>Connect Phantom</h1>
    <p class="subtitle">Connect your Solana wallet to PhotoLynk</p>
    <button class="btn btn-phantom" id="connect-btn"><span>🔗</span> Connect Phantom Wallet</button>
    <button class="btn btn-secondary" onclick="window.close()" style="margin-top:12px;">Cancel</button>
    <div class="status" id="status"></div>
  </div>
  <div class="container" id="waiting-container" style="display:none;">
    <div class="logo" style="animation: pulse 2s infinite;">👻</div>
    <h1>Waiting for Phantom...</h1>
    <p class="subtitle">Approve the connection in your Phantom wallet</p>
    <div class="spinner" style="margin: 20px auto;"></div>
    <button class="btn btn-secondary" onclick="cancelConnect()" style="margin-top:12px;">Cancel</button>
  </div>
  <style>@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }</style>
  <div class="container" id="success-container" style="display:none;">
    <div class="success-icon">✅</div>
    <h1>Wallet Connected!</h1>
    <p class="subtitle">Copy your address and paste it in PhotoLynk</p>
    <div class="wallet-address" id="wallet-address"></div>
    <button class="copy-btn" onclick="copyAddress()">📋 Copy Address</button>
    <div class="status success" style="display:block; margin-top:16px;">You can now close this window and paste the address in PhotoLynk</div>
  </div>
  <script>
    let connectedAddress = '';
    let connectPollInterval = null;
    
    function showStatus(msg, type) { const el = document.getElementById('status'); el.textContent = msg; el.className = 'status ' + type; el.style.display = 'block'; }
    function setLoading(loading) { const btn = document.getElementById('connect-btn'); btn.disabled = loading; btn.innerHTML = loading ? '<div class="spinner"></div> Connecting...' : '<span>🔗</span> Connect Phantom Wallet'; }
    
    function showWaiting() {
      document.getElementById('connect-container').style.display = 'none';
      document.getElementById('waiting-container').style.display = 'block';
    }
    
    function hideWaiting() {
      document.getElementById('waiting-container').style.display = 'none';
      document.getElementById('connect-container').style.display = 'block';
    }
    
    function cancelConnect() {
      if (connectPollInterval) clearInterval(connectPollInterval);
      hideWaiting();
    }
    
    // Send address back to desktop app automatically
    async function sendAddressToApp(address) {
      try {
        await fetch('/wallet-connected', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        return true;
      } catch (e) {
        console.error('Failed to send address to app:', e);
        return false;
      }
    }
    
    function showSuccess(address) {
      connectedAddress = address;
      document.getElementById('connect-container').style.display = 'none';
      document.getElementById('success-container').style.display = 'block';
      document.getElementById('wallet-address').textContent = address;
      
      // Automatically send to app
      sendAddressToApp(address).then(sent => {
        if (sent) {
          document.querySelector('.copy-btn').style.display = 'none';
          document.querySelector('#success-container .status').innerHTML = '✓ Address sent to PhotoLynk!<br><small>You can close this window.</small>';
          // Auto-close after 2 seconds
          setTimeout(() => window.close(), 2000);
        }
      });
    }
    
    function copyAddress() { 
      navigator.clipboard.writeText(connectedAddress).then(() => { 
        const btn = document.querySelector('.copy-btn'); 
        btn.textContent = '✓ Copied!'; 
        setTimeout(() => btn.textContent = '📋 Copy Address', 2000); 
      }); 
    }
    
    // Connect using Phantom Universal Links (deeplinks) - works even when wallet is locked
    document.getElementById('connect-btn').addEventListener('click', async function() {
      const provider = window.phantom?.solana || window.solana;
      
      // First try the provider API if available and connected
      if (provider?.isPhantom && provider.isConnected && provider.publicKey) {
        showSuccess(provider.publicKey.toString());
        return;
      }
      
      // Try provider.connect() first (works if wallet is unlocked)
      if (provider?.isPhantom) {
        setLoading(true);
        showStatus('Connecting...', 'info');
        
        try {
          const resp = await provider.connect();
          showSuccess(resp.publicKey.toString());
          return;
        } catch (err) {
          console.log('Provider connect failed, trying deeplink:', err.message);
          setLoading(false);
        }
      }
      
      // Fallback: Use Phantom Universal Link (deeplink) - this ALWAYS opens Phantom
      const redirectUrl = encodeURIComponent(window.location.origin + '/wallet-callback');
      const appUrl = encodeURIComponent('https://stealthlynk.io');
      const cluster = 'mainnet-beta';
      
      // Phantom Universal Link format
      const phantomConnectUrl = 'https://phantom.app/ul/v1/connect?' + 
        'app_url=' + appUrl + 
        '&redirect_link=' + redirectUrl +
        '&cluster=' + cluster;
      
      console.log('Opening Phantom via Universal Link:', phantomConnectUrl);
      showWaiting();
      
      // Open Phantom - this will trigger the extension or open phantom.app
      window.open(phantomConnectUrl, '_blank');
      
      // Poll for connection (Phantom will redirect back or user will approve in extension)
      let attempts = 0;
      connectPollInterval = setInterval(async () => {
        attempts++;
        
        // Check if provider is now connected
        const p = window.phantom?.solana || window.solana;
        if (p?.isConnected && p?.publicKey) {
          clearInterval(connectPollInterval);
          showSuccess(p.publicKey.toString());
          return;
        }
        
        // Try eager connect
        if (p?.isPhantom) {
          try {
            const resp = await p.connect({ onlyIfTrusted: true });
            if (resp?.publicKey) {
              clearInterval(connectPollInterval);
              showSuccess(resp.publicKey.toString());
              return;
            }
          } catch (e) { /* not yet */ }
        }
        
        // Timeout after 2 minutes
        if (attempts > 120) {
          clearInterval(connectPollInterval);
          hideWaiting();
          showStatus('Connection timed out. Please try again.', 'error');
        }
      }, 1000);
    });
    
    // Wait for Phantom extension to inject (can take 1-3 seconds on some browsers)
    let phantomCheckAttempts = 0;
    const maxPhantomChecks = 15; // Check for up to 7.5 seconds
    
    function waitForPhantom() {
      phantomCheckAttempts++;
      const provider = window.phantom?.solana || window.solana;
      
      if (provider?.isPhantom) {
        // Phantom found - try eager connect
        showStatus('Phantom detected!', 'info');
        provider.connect({ onlyIfTrusted: true }).then(resp => {
          if (resp?.publicKey) showSuccess(resp.publicKey.toString());
          else showStatus('Click Connect to link your wallet', 'info');
        }).catch(() => {
          showStatus('Click Connect to link your wallet', 'info');
        });
      } else if (phantomCheckAttempts < maxPhantomChecks) {
        // Keep checking - extension may still be loading
        showStatus('Looking for Phantom wallet... (' + phantomCheckAttempts + '/' + maxPhantomChecks + ')', 'info');
        setTimeout(waitForPhantom, 500);
      } else {
        // Phantom not found after all attempts
        showStatus('Phantom wallet not detected. Make sure the extension is installed and enabled for this site.', 'error');
        document.getElementById('connect-btn').innerHTML = '<span>📥</span> Install Phantom';
        document.getElementById('connect-btn').onclick = function() {
          window.open('https://phantom.app/', '_blank');
        };
      }
    }
    
    // Start checking for Phantom after page load
    window.addEventListener('load', () => {
      setTimeout(waitForPhantom, 300);
    });
  </script>
</body>
</html>`);
});

// NFT Transfer state
let nftTransferStatus = { completed: false, success: false, signature: null, error: null };

// NFT Transfer status endpoint - polled by desktop app
app.get('/nft-transfer-status', (req, res) => {
    res.json(nftTransferStatus);
});

// NFT Transfer completed callback - receives result from browser
app.post('/nft-transfer-complete', (req, res) => {
    const { success, signature, error } = req.body;
    nftTransferStatus = { completed: true, success: !!success, signature: signature || null, error: error || null };
    // Reset after 30 seconds
    setTimeout(() => { nftTransferStatus = { completed: false, success: false, signature: null, error: null }; }, 30000);
    res.json({ success: true });
});

// NFT Transfer signing page - opens in browser with Phantom
app.get('/nft-transfer-sign', (req, res) => {
    const { tx, mint, to, versioned } = req.query;
    if (!tx || !mint || !to) {
        return res.status(400).send('Missing parameters');
    }
    const isVersioned = versioned === '1';
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign NFT Transfer - PhotoLynk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; }
    .container { background: rgba(30, 30, 50, 0.95); border-radius: 24px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid rgba(153, 69, 255, 0.3); }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .info-box { background: rgba(0,0,0,0.3); border-radius: 12px; padding: 16px; margin-bottom: 24px; text-align: left; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
    .info-row:last-child { margin-bottom: 0; }
    .info-label { color: #888; font-size: 12px; }
    .info-value { color: #fff; font-size: 12px; font-family: monospace; }
    .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; transition: all 0.2s; margin-bottom: 12px; }
    .btn-phantom { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; }
    .btn-phantom:hover { box-shadow: 0 8px 24px rgba(153, 69, 255, 0.4); transform: translateY(-2px); }
    .btn-phantom:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #888; }
    .status { margin-top: 20px; padding: 14px; border-radius: 10px; font-size: 14px; display: none; }
    .status.error { display: block; background: rgba(248, 113, 113, 0.1); color: #F87171; }
    .status.success { display: block; background: rgba(20, 241, 149, 0.1); color: #14F195; }
    .status.info { display: block; background: rgba(153, 69, 255, 0.1); color: #9945FF; }
    .spinner { width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🖼️</div>
    <h1>Sign NFT Transfer</h1>
    <p class="subtitle">Approve this transaction in Phantom to transfer your NFT</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">NFT Mint</span>
        <span class="info-value">${mint.slice(0, 8)}...${mint.slice(-8)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Recipient</span>
        <span class="info-value">${to.slice(0, 8)}...${to.slice(-8)}</span>
      </div>
    </div>
    
    <button class="btn btn-phantom" id="sign-btn"><span>✍️</span> Sign & Send Transaction</button>
    <button class="btn btn-secondary" onclick="cancelTransfer()">Cancel</button>
    <div class="status" id="status"></div>
  </div>
  
  <script>
    const txBase64 = '${tx}';
    const isVersioned = ${isVersioned};
    
    function showStatus(msg, type) { 
      const el = document.getElementById('status'); 
      el.textContent = msg; 
      el.className = 'status ' + type; 
      el.style.display = 'block'; 
    }
    
    function setLoading(loading) { 
      const btn = document.getElementById('sign-btn'); 
      btn.disabled = loading; 
      btn.innerHTML = loading ? '<div class="spinner"></div> Signing...' : '<span>✍️</span> Sign & Send Transaction'; 
    }
    
    async function notifyApp(success, signature, error) {
      try {
        await fetch('/nft-transfer-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success, signature, error })
        });
      } catch (e) {
        console.error('Failed to notify app:', e);
      }
    }
    
    function cancelTransfer() {
      notifyApp(false, null, 'User cancelled');
      window.close();
    }
    
    document.getElementById('sign-btn').addEventListener('click', async function() {
      const provider = window.phantom?.solana || window.solana;
      
      if (!provider?.isPhantom) {
        showStatus('Phantom wallet not detected. Please install it.', 'error');
        return;
      }
      
      setLoading(true);
      showStatus('Connecting to Phantom...', 'info');
      
      try {
        // Connect if not connected
        if (!provider.isConnected) {
          await provider.connect();
        }
        
        showStatus('Please approve the transaction in Phantom...', 'info');
        
        // Decode the transaction
        const txBuffer = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
        
        // Sign and send the transaction
        // For versioned transactions (cNFTs), Phantom handles them the same way
        const { signature } = await provider.signAndSendTransaction({
          serialize: () => txBuffer,
          // Phantom auto-detects versioned vs legacy transactions from the buffer
        });
        
        showStatus('Transaction sent! Signature: ' + signature.slice(0, 16) + '...', 'success');
        
        // Notify the desktop app
        await notifyApp(true, signature, null);
        
        // Auto-close after 3 seconds
        setTimeout(() => window.close(), 3000);
        
      } catch (err) {
        console.error('Transfer error:', err);
        const errorMsg = err.message || 'Transaction failed';
        showStatus(errorMsg, 'error');
        setLoading(false);
        
        // Notify app of failure
        await notifyApp(false, null, errorMsg);
      }
    });
    
    // Check for Phantom on load
    window.addEventListener('load', () => {
      const provider = window.phantom?.solana || window.solana;
      if (!provider?.isPhantom) {
        showStatus('Phantom wallet not detected. Please install it.', 'error');
        document.getElementById('sign-btn').disabled = true;
      }
    });
  </script>
</body>
</html>`);
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
