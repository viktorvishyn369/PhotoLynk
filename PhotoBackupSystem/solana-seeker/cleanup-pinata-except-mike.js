#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT_CANDIDATES = [
  path.resolve(__dirname, '..', '..'),
  path.resolve(__dirname, '..'),
  '/opt/photolynk',
  path.resolve(process.cwd(), '..'),
  process.cwd(),
];
const ROOT = ROOT_CANDIDATES.find(dir => fs.existsSync(path.join(dir, 'nft-service', 'storage.js')));
if (!ROOT) {
  throw new Error(`Cannot find nft-service/storage.js. Checked: ${ROOT_CANDIDATES.join(', ')}`);
}
const pinataStorage = require(path.join(ROOT, 'nft-service', 'storage'));
const pinataConfig = require(path.join(ROOT, 'nft-service', 'config'));

const NFT_DIR = process.env.NFT_DIR || '/mnt/nvme-buffer/cloud/nft';
const MIKE_FOLDER = process.env.MIKE_FOLDER || path.join(NFT_DIR, '0bdcce87-975c-5293-b260-b202305cae28');
const OUT_DIR = process.env.OUT_DIR || '/root';
const EXECUTE = process.argv.includes('--execute');
const YES = process.argv.includes('--yes');
const LIST = process.argv.includes('--list');
const RATE_DELAY_MS = Number(process.env.RATE_DELAY_MS || 500);
const CID_RE = /\b(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{50,})\b/g;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function unique(list) {
  return [...new Set(list.filter(Boolean).map(x => String(x).trim()).filter(Boolean))].sort();
}

function getJwtInfos() {
  if (typeof pinataConfig.getAllPinataJwts === 'function') return pinataConfig.getAllPinataJwts();

  const out = [];
  const seen = new Set();
  const push = (label, jwt) => {
    const value = String(jwt || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ label, jwt: value });
  };

  push('config:PINATA_JWT', pinataConfig.PINATA_JWT);
  push('config:PINATA_JWT_FALLBACK', pinataConfig.PINATA_JWT_FALLBACK);
  push('config:PINATA_JWT_EXTRA2', pinataConfig.PINATA_JWT_EXTRA2);
  push('env:PINATA_JWT', process.env.PINATA_JWT);
  push('env:PINATA_JWT_FALLBACK', process.env.PINATA_JWT_FALLBACK);
  push('env:PINATA_JWT_EXTRA2', process.env.PINATA_JWT_EXTRA2);

  for (const key of Object.keys(process.env).sort()) {
    if (/^PINATA_JWT_EXTRA\d+$/.test(key)) push(`env:${key}`, process.env[key]);
  }

  for (const file of [
    path.join(ROOT, 'nft-service', 'config.js'),
    path.join(ROOT, 'nft-service', 'pinataAccounts.js'),
    path.join(ROOT, 'PhotoBackupSystem', 'solana-seeker', 'nftOperations.js'),
    path.join(ROOT, 'solana-seeker', 'nftOperations.js'),
    path.join(__dirname, 'nftOperations.js'),
    '/root/photolynk-pinata-jwts.txt',
  ]) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const matches = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
      matches.forEach((jwt, index) => push(`${path.basename(file)}:jwt${index + 1}`, jwt));
    } catch (_) {}
  }

  return out;
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function writeList(name, list) {
  ensureOutDir();
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, list.join('\n') + (list.length ? '\n' : ''));
  return file;
}

function walkFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function extractCidsFromFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.match(CID_RE) || [];
  } catch (_) {
    return [];
  }
}

function extractCidsFromFolder(folder) {
  const cids = [];
  for (const file of walkFiles(folder)) cids.push(...extractCidsFromFile(file));
  return unique(cids);
}

function readCidFile(file) {
  if (!file || !fs.existsSync(file)) return [];
  return unique(fs.readFileSync(file, 'utf8').split(/\r?\n/));
}

async function listPinnedForJwt({ label, jwt }) {
  const cids = [];
  let pageOffset = 0;
  const pageLimit = 1000;

  while (true) {
    const response = await axios.get('https://api.pinata.cloud/data/pinList', {
      headers: { Authorization: `Bearer ${jwt}` },
      params: { status: 'pinned', pageLimit, pageOffset },
      timeout: 30000,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      console.log(`PIN_LIST_FAILED ${label}: HTTP ${response.status}`);
      break;
    }

    const rows = Array.isArray(response.data?.rows) ? response.data.rows : [];
    for (const row of rows) {
      if (row?.ipfs_pin_hash) cids.push(row.ipfs_pin_hash);
    }

    if (rows.length < pageLimit) break;
    pageOffset += pageLimit;
  }

  console.log(`PIN_LIST ${label}: ${cids.length}`);
  return cids;
}

async function unpinCidWithJwts(cid, jwts) {
  if (typeof pinataStorage.unpinFromPinata === 'function') return pinataStorage.unpinFromPinata(cid);

  let lastError = 'not attempted';
  for (const { label, jwt } of jwts) {
    const response = await axios.delete(`https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`, {
      headers: { Authorization: `Bearer ${jwt}` },
      timeout: 30000,
      validateStatus: () => true,
    });

    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
    if (response.status >= 200 && response.status < 300) {
      return { success: true, cid, jwtUsed: label };
    }
    if (response.status === 404 || /not\s*pinned|not\s*found/i.test(body)) {
      lastError = `404/not-pinned on ${label}`;
      continue;
    }
    lastError = `HTTP ${response.status} on ${label}: ${body.slice(0, 200)}`;
  }

  if (/404|not-pinned/i.test(lastError)) return { success: true, cid, alreadyUnpinned: true };
  return { success: false, cid, error: lastError };
}

async function collectCandidateCids(jwts) {
  const explicit = process.argv.find(arg => arg.startsWith('--cids-file='));
  if (explicit) return readCidFile(explicit.slice('--cids-file='.length));

  const logArg = process.argv.find(arg => arg.startsWith('--from-log='));
  if (logArg) return unique(extractCidsFromFile(logArg.slice('--from-log='.length)));

  const deletedRoot = process.argv.find(arg => arg.startsWith('--deleted-backup-dir='));
  if (deletedRoot) return extractCidsFromFolder(deletedRoot.slice('--deleted-backup-dir='.length));

  const cids = [];
  for (const jwtInfo of jwts) {
    cids.push(...await listPinnedForJwt(jwtInfo));
    await sleep(RATE_DELAY_MS);
  }
  return unique(cids);
}

async function main() {
  const jwts = getJwtInfos();
  const mikeCids = extractCidsFromFolder(MIKE_FOLDER);
  const mikeSet = new Set(mikeCids);
  const candidates = await collectCandidateCids(jwts);
  const targets = candidates.filter(cid => !mikeSet.has(cid));

  const mikeFile = writeList('mike-keep-cids.txt', mikeCids);
  const targetFile = writeList('pinata-target-cids-excluding-mike.txt', targets);

  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`NFT_DIR: ${NFT_DIR}`);
  console.log(`MIKE_FOLDER: ${MIKE_FOLDER}`);
  console.log(`Pinata JWT candidates from nft-service/config: ${jwts.length}`);
  console.log(`Mike keep CIDs: ${mikeCids.length} -> ${mikeFile}`);
  console.log(`Input candidate CIDs: ${candidates.length}`);
  console.log(`Target CIDs after excluding Mike: ${targets.length} -> ${targetFile}`);

  if (!candidates.length) throw new Error('No Pinata pins found and no candidate CIDs provided');

  if (LIST || !EXECUTE) {
    console.log('DRY RUN only. Nothing unpinned. Add --execute --yes to remove targets.');
    return;
  }

  if (!YES) throw new Error('Refusing execute without --yes');

  const results = [];
  let ok = 0;
  let failed = 0;

  for (const cid of targets) {
    const result = await unpinCidWithJwts(cid, jwts);
    results.push(result);
    if (result.success) {
      ok++;
      console.log(`UNPIN ${cid} ${result.jwtUsed ? `via ${result.jwtUsed}` : ''}${result.alreadyUnpinned ? ' already-gone' : ''}`);
    } else {
      failed++;
      console.log(`UNPIN_FAILED ${cid}: ${result.error || 'failed'}`);
    }
    await sleep(RATE_DELAY_MS);
  }

  const resultsFile = path.join(OUT_DIR, 'pinata-cleanup-results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  const failedFile = writeList('pinata-cleanup-failed-cids.txt', results.filter(r => !r.success).map(r => r.cid));

  console.log(JSON.stringify({ success: failed === 0, targets: targets.length, unpinned: ok, failed, resultsFile, failedFile }, null, 2));
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
