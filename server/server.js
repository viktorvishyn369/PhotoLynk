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
const CAPACITY_JSON_PATH = process.env.CAPACITY_JSON_PATH || path.join(AUX_ROOT, 'capacity', 'photosync-capacity.json');

const SUBSCRIPTION_GRACE_DAYS = Number.parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);
const TRIAL_DAYS = Number.parseInt(process.env.TRIAL_DAYS || '7', 10);
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
        };
    }

    if (trialUntil && trialUntil > now) {
        return {
            allowed: true,
            status: 'trial',
            trialUntil,
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
        };
    }

    if (row.status === 'trial' && trialUntil && trialUntil > 0 && trialUntil <= now) {
        try {
            const updatedAt = Date.now();
            await dbRunAsync(
                `UPDATE user_plans SET status = ?, updated_at = ? WHERE user_id = ?`,
                ['trial_expired', updatedAt, userId]
            );
        } catch (e) {
            // ignore
        }
        return {
            allowed: false,
            status: 'trial_expired',
            trialUntil,
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
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
        };
    }

    if (row.status === 'active') {
        return {
            allowed: true,
            status: 'active',
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
        };
    }

    return {
        allowed: false,
        status: row.status || 'none',
        trialUntil: trialUntil || null,
        expiresAt: expiresAt || null,
        graceUntil: graceUntil || null,
        planGb: row.plan_gb || null,
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

        if (st.status === 'grace' || st.status === 'grace_expired') {
            return res.status(402).json({
                error: 'Subscription expired',
                code: 'SUBSCRIPTION_EXPIRED',
                expiresAt: st.expiresAt,
                graceUntil: st.graceUntil,
                deleteInDays: SUBSCRIPTION_GRACE_DAYS,
            });
        }

        if (st.status === 'trial_expired') {
            return res.status(402).json({
                error: 'Trial expired',
                code: 'TRIAL_EXPIRED',
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

// Uploads are more restrictive than read-only sync.
// Policy: active + trial can upload; grace/trial_expired can only sync/restore.
const requireUploadSubscription = async (req, res, next) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        if (st.status === 'active' || st.status === 'trial') return next();

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, filename),
        UNIQUE(user_id, file_hash)
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
    // Chunks go to HDD RAID10 if CHUNKS_DIR is set, otherwise same as CLOUD_DIR
    const chunksDir = CHUNKS_DIR 
        ? path.join(CHUNKS_DIR, 'users', key, 'chunks')
        : path.join(userDir, 'chunks');
    const manifestsDir = path.join(userDir, 'manifests'); // Manifests always on NVMe (CLOUD_DIR)
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
app.post('/api/login', authRateLimiter, (req, res) => {
    const { email, password, device_uuid, device_name } = req.body;
    if (!email || !password || !device_uuid) return res.status(400).json({ error: 'Missing credentials or device ID' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT * FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

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
                
                // Generate Token BOUND to this device
                const token = jwt.sign({ id: user.id, user_uuid: user.user_uuid, email: user.email, device_uuid: device_uuid }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ token, userId: user.id });
            }
        );
    });
});

// Device-bound Password Reset
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

app.post('/api/subscription/sync', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { productId, tierGb, entitlementId, paymentType } = req.body || {};
        const tier = normalizeTierGb(tierGb) || normalizeTierGb(inferTierGbFromProductId(productId));
        if (!tier) return res.status(400).json({ error: 'Invalid or missing tier' });

        await ensurePlanRow(userId);
        const now = Date.now();
        await dbRunAsync(
            `UPDATE user_plans
                SET plan_gb = ?,
                    status = 'active',
                    rc_product_id = ?,
                    rc_entitlement = COALESCE(?, rc_entitlement),
                    rc_app_user_id = COALESCE(rc_app_user_id, ?),
                    payment_type = COALESCE(?, payment_type),
                    payment_at = COALESCE(payment_at, ?),
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
                                payment_type = COALESCE(?, payment_type),
                                payment_at = COALESCE(payment_at, ?),
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
                            payment_type = COALESCE(?, payment_type),
                            payment_at = COALESCE(payment_at, ?),
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
                payment_type = COALESCE(user_plans.payment_type, 'solana'),
                payment_at = COALESCE(user_plans.payment_at, excluded.updated_at),
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
            `SELECT filename, file_hash FROM files WHERE user_id = ? AND (file_hash = ? OR filename = ?)`,
            [req.user.id, fileHash, safeName],
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
                    db.run(`DELETE FROM files WHERE user_id = ? AND (file_hash = ? OR filename = ?)`, [req.user.id, fileHash, safeName]);
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

                db.run(
                    `INSERT OR REPLACE INTO files (user_id, filename, original_name, mime_type, size, file_hash) VALUES (?, ?, ?, ?, ?, ?)`,
                    [req.user.id, safeName, safeName, mimetype, size, fileHash],
                    (err2) => {
                        if (err2) {
                            console.error('Metadata save error:', err2);
                            try { fs.unlinkSync(finalPath); } catch (e) {}
                            return res.status(500).json({ error: 'Failed to save file metadata' });
                        }
                        return res.json({ message: 'File uploaded', filename: safeName });
                    }
                );
            }
        );
    });

    req.pipe(out);
});

// List Files (for Sync)
app.get('/api/files', authenticateToken, (req, res) => {
    const rawOffset = req.query && req.query.offset ? req.query.offset : null;
    const rawLimit = req.query && req.query.limit ? req.query.limit : null;
    const offset = rawOffset !== null ? Math.max(0, parseInt(String(rawOffset), 10) || 0) : 0;
    const limit = rawLimit !== null ? Math.max(0, parseInt(String(rawLimit), 10) || 0) : 0;

    // Read files from device UUID folder
    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    
    console.log(`[LIST FILES] Device UUID: ${req.user.device_uuid}`);
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
        
        console.log(`[LIST FILES] Returning ${files.length} files (offset=${offset} limit=${limit || 'all'} total=${total})`);
        res.json({ files, total });
    } catch (error) {
        console.error('[LIST FILES] Error reading files:', error);
        res.status(500).json({ error: 'Error reading files' });
    }
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
            // Fall through to serve original
        }
    }

    // Fallback: serve original file
    res.download(filePath);
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

// Upload encrypted manifest JSON
app.post('/api/cloud/manifests', authenticateToken, requireUploadSubscription, (req, res) => {
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
    
    // Cross-device deduplication: if manifest already exists, skip (don't overwrite)
    // This allows iOS and Android to upload the same file with the same stable manifestId
    // Client-side handles all hash-based deduplication (exact file hash and perceptual hash)
    if (fs.existsSync(manifestPath)) {
        console.log(`[SC] Manifest ${safeId} already exists for user ${req.user.id}, skipping (cross-device dedupe by manifestId)`);
        return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'manifestId' });
    }
    
    const payload = {
        manifestId: safeId,
        encryptedManifest,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(manifestPath, JSON.stringify(payload));

    res.json({ ok: true, manifestId: safeId });
});

// List manifests
app.get('/api/cloud/manifests', authenticateToken, blockDeletedSubscription, (req, res) => {
    const rawOffset = req.query && req.query.offset ? req.query.offset : null;
    const rawLimit = req.query && req.query.limit ? req.query.limit : null;
    const offset = rawOffset !== null ? Math.max(0, parseInt(String(rawOffset), 10) || 0) : 0;
    const limit = rawLimit !== null ? Math.max(0, parseInt(String(rawLimit), 10) || 0) : 0;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', '');
    const { manifestsDir } = ensureStealthCloudUserDirs(req.user);
    if (!fs.existsSync(manifestsDir)) return res.json({ manifests: [], total: 0 });
    let list = fs.readdirSync(manifestsDir)
        .filter(f => f.endsWith('.json'))
        .filter(f => !f.startsWith('.')) // Skip hidden files like .DS_Store
        .map(f => ({ manifestId: f.replace(/\.json$/, '') }));

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
