#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const UNPIN = args.includes('--unpin');
const YES = args.includes('--yes');
const LIST_ONLY = args.includes('--list');
const HELP = args.includes('--help') || args.includes('-h');

const valueArgs = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
};

const keepValues = [
  ...valueArgs('--keep'),
  ...valueArgs('--keep-user'),
  ...valueArgs('--keep-email'),
  ...valueArgs('--keep-handle'),
  ...valueArgs('--keep-id'),
  ...valueArgs('--keep-folder'),
].map(v => String(v || '').trim()).filter(Boolean);

if (HELP) {
  console.log(`Usage:
  node cleanup-nfts-except-users.js --keep cybermike.skr --list
  node cleanup-nfts-except-users.js --keep cybermike.skr --unpin
  node cleanup-nfts-except-users.js --keep cybermike.skr --unpin --execute --yes

Default is dry-run. Nothing is deleted or unpinned unless --execute is supplied.
Use multiple --keep values to preserve more users/folders.`);
  process.exit(0);
}

if (!keepValues.length) {
  console.error('Refusing to run without at least one --keep value. Example: --keep cybermike.skr');
  process.exit(1);
}

if (EXECUTE && !YES) {
  console.error('Refusing destructive execution without --yes. Run dry-run first, then add --execute --yes.');
  process.exit(1);
}

const NVME_MOUNT = '/mnt/nvme-buffer';
const RAID_MOUNT = '/data';
const DATA_DIR = process.env.PHOTOSYNC_DATA_DIR || path.join(__dirname, 'data');
const isDir = (p) => {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (_) { return false; }
};
const DB_PATH = process.env.DB_PATH || (isDir(path.join(NVME_MOUNT, 'db')) ? path.join(NVME_MOUNT, 'db', 'backup.db') : path.join(DATA_DIR, 'backup.db'));
const CLOUD_DIR = process.env.CLOUD_DIR || (isDir(path.join(NVME_MOUNT, 'cloud')) ? path.join(NVME_MOUNT, 'cloud') : path.join(DATA_DIR, 'cloud'));
const NFT_DIR = path.join(CLOUD_DIR, 'nft');

const sanitize = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || '';
const norm = (v) => String(v || '').trim().toLowerCase();
const normLoose = (v) => norm(v).replace(/^@+/, '');
const extractCids = (text) => {
  const out = new Set();
  const s = String(text || '');
  const re = /\b(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z2-7]{50,})\b/g;
  let m;
  while ((m = re.exec(s))) out.add(m[1]);
  return out;
};

const dbAll = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});

const loadUsers = async () => {
  if (!fs.existsSync(DB_PATH)) return [];
  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
  try {
    const users = await dbAll(db, `
      SELECT u.id, u.email, u.alias_email, u.seeker_id, u.user_uuid, u.storage_uuid,
             GROUP_CONCAT(DISTINCT d.device_uuid) AS device_uuids
      FROM users u
      LEFT JOIN devices d ON u.id = d.user_id
      GROUP BY u.id
      ORDER BY u.id ASC
    `);
    return users;
  } finally {
    db.close();
  }
};

const userTokens = (user) => {
  const tokens = new Set();
  [user.id, user.email, user.alias_email, user.seeker_id, user.user_uuid, user.storage_uuid].forEach(v => {
    if (v !== null && v !== undefined && String(v).trim()) {
      tokens.add(norm(v));
      tokens.add(normLoose(v));
      tokens.add(sanitize(v).toLowerCase());
    }
  });
  if (user.device_uuids) {
    String(user.device_uuids).split(',').forEach(v => {
      if (v.trim()) {
        tokens.add(norm(v));
        tokens.add(sanitize(v).toLowerCase());
      }
    });
  }
  return tokens;
};

const userFolderKeys = (user) => {
  const keys = new Set();
  [user.id, user.user_uuid, user.storage_uuid].forEach(v => {
    const safe = sanitize(v);
    if (safe) keys.add(safe);
  });
  if (user.device_uuids) String(user.device_uuids).split(',').forEach(v => {
    const safe = sanitize(v);
    if (safe) keys.add(safe);
  });
  return keys;
};

const loadPinataJwts = () => {
  const seen = new Set();
  const out = [];
  const push = (label, jwt) => {
    const v = String(jwt || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push({ label, jwt: v });
  };
  const parse = (label, value) => String(value || '').split(/[\s,]+/).forEach(v => push(label, v));
  const roots = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
    '/opt/photolynk',
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ];
  const nftServiceRoot = roots.find(root => fs.existsSync(path.join(root, 'nft-service', 'config.js')));
  const nftStorageRoot = roots.find(root => fs.existsSync(path.join(root, 'nft-service', 'storage.js')));
  try {
    const cfg = require(path.join(nftServiceRoot || path.resolve(__dirname, '..'), 'nft-service', 'config'));
    if (typeof cfg.getAllPinataJwts === 'function') {
      for (const item of cfg.getAllPinataJwts()) push(item.label || 'nft-service', item.jwt);
    }
    push('nft-service:primary', cfg.PINATA_JWT);
    push('nft-service:fallback', cfg.PINATA_JWT_FALLBACK);
    push('nft-service:extra2', cfg.PINATA_JWT_EXTRA2);
  } catch (_) {}
  Object.keys(process.env).filter(k => /^PINATA_JWT($|_)/.test(k) || /^PINATA_JWT_EXTRA\d+$/.test(k)).sort().forEach(k => parse(`env:${k}`, process.env[k]));
  const scanFiles = new Set();
  for (const root of roots) {
    scanFiles.add(path.join(root, 'nft-service', 'config.js'));
    scanFiles.add(path.join(root, 'nft-service', 'pinataAccounts.js'));
    scanFiles.add(path.join(root, 'PhotoBackupSystem', 'solana-seeker', 'nftOperations.js'));
    scanFiles.add(path.join(root, 'solana-seeker', 'nftOperations.js'));
  }
  if (nftServiceRoot) {
    scanFiles.add(path.join(nftServiceRoot, 'nft-service', 'config.js'));
    scanFiles.add(path.join(nftServiceRoot, 'nft-service', 'pinataAccounts.js'));
  }
  if (nftStorageRoot) {
    scanFiles.add(path.join(nftStorageRoot, 'nft-service', 'config.js'));
    scanFiles.add(path.join(nftStorageRoot, 'nft-service', 'pinataAccounts.js'));
  }
  scanFiles.add(path.join(__dirname, 'nftOperations.js'));
  scanFiles.add('/root/photolynk-pinata-jwts.txt');
  for (const file of scanFiles) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const matches = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
      matches.forEach((jwt, index) => push(`${path.basename(file)}:jwt${index + 1}`, jwt));
    } catch (_) {}
  }
  return out;
};

const collectDir = (dir) => {
  const files = [];
  const cids = new Set();
  const walk = (p) => {
    for (const name of fs.readdirSync(p)) {
      const fp = path.join(p, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp);
      else if (st.isFile()) {
        files.push(fp);
        const ext = path.extname(name).toLowerCase();
        if (['.json', '.txt', '.log'].includes(ext)) {
          try { extractCids(fs.readFileSync(fp, 'utf8')).forEach(cid => cids.add(cid)); } catch (_) {}
        }
      }
    }
  };
  walk(dir);
  return { files, cids };
};

const rmrf = (target) => {
  fs.rmSync(target, { recursive: true, force: true });
};

const unpinCid = async (cid, jwts) => {
  if (!jwts.length) return { ok: false, status: 'no_jwts' };
  let saw404 = false;
  let lastStatus = null;
  let lastLabel = null;
  let lastBody = '';
  for (const item of jwts) {
    try {
      const response = await axios.delete(`https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`, {
        headers: { Authorization: `Bearer ${item.jwt}` },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: 'unpinned', label: item.label };
      }
      const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
      if (response.status === 404 || /not\s*pinned|not\s*found/i.test(body)) {
        saw404 = true;
        lastStatus = response.status;
        lastLabel = item.label;
        lastBody = body;
        continue;
      }
      lastStatus = response.status;
      lastLabel = item.label;
      lastBody = body;
      if (response.status === 401 || response.status === 403) continue;
    } catch (e) {
      const status = e.response && e.response.status;
      const body = typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data || {});
      if (status === 404) {
        saw404 = true;
        lastStatus = status;
        lastLabel = item.label;
        lastBody = body;
        continue;
      }
      lastStatus = status || e.code || 'error';
      lastLabel = item.label;
      lastBody = body || e.message || '';
      if (status === 401 || status === 403) continue;
    }
  }
  if (saw404) return { ok: true, status: 'not_found' };
  return { ok: false, status: `failed${lastStatus ? ` last=${lastStatus}` : ''}${lastLabel ? ` via ${lastLabel}` : ''}${lastBody ? ` ${String(lastBody).slice(0, 120)}` : ''}` };
};

(async () => {
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`DB_PATH: ${DB_PATH}`);
  console.log(`NFT_DIR: ${NFT_DIR}`);
  console.log(`Keep: ${keepValues.join(', ')}`);

  if (!fs.existsSync(NFT_DIR)) {
    console.error(`NFT_DIR not found: ${NFT_DIR}`);
    process.exit(1);
  }

  const users = await loadUsers();
  const keepNeedles = new Set(keepValues.flatMap(v => [norm(v), normLoose(v), sanitize(v).toLowerCase()].filter(Boolean)));
  const keepUsers = users.filter(u => {
    const tokens = userTokens(u);
    return [...keepNeedles].some(k => tokens.has(k));
  });
  const keepFolders = new Set([...keepNeedles].map(sanitize).filter(Boolean));
  keepUsers.forEach(u => userFolderKeys(u).forEach(k => keepFolders.add(k)));

  if (!keepUsers.length && !keepFolders.size) {
    console.error('No keep users/folders resolved. Refusing to continue.');
    process.exit(1);
  }

  console.log('Resolved keep users:');
  keepUsers.forEach(u => console.log(`  #${u.id} ${u.seeker_id || u.alias_email || u.email || '-'} folders=${[...userFolderKeys(u)].join(',')}`));
  console.log(`Resolved keep folders: ${[...keepFolders].join(', ')}`);

  const folderEntries = fs.readdirSync(NFT_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const targets = [];
  const kept = [];
  for (const folder of folderEntries) {
    const dir = path.join(NFT_DIR, folder);
    const collected = collectDir(dir);
    const item = { folder, dir, fileCount: collected.files.length, cids: collected.cids };
    if (keepFolders.has(folder)) kept.push(item);
    else targets.push(item);
  }

  const allCids = new Set();
  targets.forEach(t => t.cids.forEach(cid => allCids.add(cid)));

  console.log(`Keep folders found: ${kept.length}`);
  kept.forEach(k => console.log(`  KEEP ${k.folder}: files=${k.fileCount} cids=${k.cids.size}`));
  console.log(`Target folders: ${targets.length}`);
  targets.forEach(t => console.log(`  DELETE ${t.folder}: files=${t.fileCount} cids=${t.cids.size}`));
  console.log(`Unique Pinata CIDs to unpin from deleted folders: ${allCids.size}`);

  if (LIST_ONLY) return;
  if (!EXECUTE) {
    console.log('Dry run complete. Re-run with --execute --yes to delete, add --unpin to unpin Pinata CIDs.');
    return;
  }

  const jwts = UNPIN ? loadPinataJwts() : [];
  if (UNPIN) console.log(`Pinata JWT candidates: ${jwts.length}`);

  let unpinned = 0;
  let unpinFailed = 0;
  if (UNPIN) {
    for (const cid of allCids) {
      const result = await unpinCid(cid, jwts);
      if (result.ok) {
        unpinned++;
        console.log(`UNPIN ${cid}: ${result.status}${result.label ? ` via ${result.label}` : ''}`);
      } else {
        unpinFailed++;
        console.log(`UNPIN_FAILED ${cid}: ${result.status}`);
      }
    }
  }

  let deletedFolders = 0;
  for (const target of targets) {
    rmrf(target.dir);
    deletedFolders++;
    console.log(`DELETED ${target.dir}`);
  }

  console.log(JSON.stringify({
    success: true,
    deletedFolders,
    keptFolders: kept.length,
    cidsFound: allCids.size,
    unpinned,
    unpinFailed,
  }, null, 2));
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
