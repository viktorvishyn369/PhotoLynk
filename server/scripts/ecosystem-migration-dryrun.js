#!/usr/bin/env node
'use strict';

/**
 * Ecosystem baseline-migration dry run.
 * =====================================
 * Copies a production database file (plus -wal/-shm siblings) to a temp
 * location, runs the REAL ecosystem initialize() + per-member projection on
 * the copy, and diffs the legacy entitlement tables before/after to detect
 * regressions. Nothing is written to the source file.
 *
 * Usage:
 *   node server/scripts/ecosystem-migration-dryrun.js /path/to/copy-of-prod.db [--json out.json]
 *
 * Flags:
 *   --i-copied-it        required if the given path IS the configured
 *                        production DB path (we still only ever touch a copy)
 *   --json <file>        write the full machine-readable report
 *   --inject-regression  TEST ONLY: after init, lower one expires_at so the
 *                        detector can be proven to fire (exit 1)
 *
 * Exit codes: 0 = clean, 1 = regressions detected, 2 = error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { createEcosystemService } = require('../ecosystemEntitlements');

const isExistingDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

// Mirror of server.js DB_PATH resolution (server.js L259-309) — used only to
// refuse running "dry" against the live database file itself.
const resolveDataDir = () => {
    if (process.env.PHOTOSYNC_DATA_DIR) return process.env.PHOTOSYNC_DATA_DIR;
    if (process.env.UPLOAD_DIR) return path.dirname(process.env.UPLOAD_DIR);
    if (isExistingDir('/data/media') || isExistingDir('/data/db')) return '/data';
    const photolynkDir = path.join(os.homedir(), 'PhotoLynk', 'server');
    const photosyncDir = path.join(os.homedir(), 'PhotoSync', 'server');
    if (isExistingDir(photolynkDir)) return photolynkDir;
    if (isExistingDir(photosyncDir)) return photosyncDir;
    return photolynkDir;
};
const PROD_DB_PATH = process.env.DB_PATH
    || (isExistingDir('/data/db') ? '/data/db/backup.db' : path.join(resolveDataDir(), 'backup.db'));

const args = process.argv.slice(2);
const flagSet = new Set();
let dbArg = null;
let jsonOut = null;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { jsonOut = args[++i]; continue; }
    if (a.startsWith('--')) { flagSet.add(a); continue; }
    if (!dbArg) dbArg = a;
}
const die = (msg, code = 2) => { console.error(`[dryrun] ERROR: ${msg}`); process.exit(code); };
if (!dbArg) die('usage: node server/scripts/ecosystem-migration-dryrun.js <db-path> [--json out.json] [--i-copied-it]');
const srcPath = path.resolve(dbArg);
if (!fs.existsSync(srcPath)) die(`file not found: ${srcPath}`);
if (srcPath === path.resolve(PROD_DB_PATH) && !flagSet.has('--i-copied-it')) {
    die(`${srcPath} IS the configured production DB path - pass a copy, or re-run with --i-copied-it (we still only operate on a temp copy)`);
}

// Copy the db + journal sidecars to a temp dir; all work happens there.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-dryrun-'));
const workPath = path.join(tmpDir, path.basename(srcPath));
for (const suffix of ['', '-wal', '-shm']) {
    const f = srcPath + suffix;
    if (fs.existsSync(f)) fs.copyFileSync(f, workPath + suffix);
}
console.log(`[dryrun] source : ${srcPath}`);
console.log(`[dryrun] working on copy: ${workPath}`);

const open = (file) => new Promise((res, rej) => {
    const c = new sqlite3.Database(file, (e) => (e ? rej(e) : res(c)));
});
const run = (c, s, p = []) => new Promise((res, rej) => c.run(s, p, function (e) { e ? rej(e) : res(this); }));
const get = (c, s, p = []) => new Promise((res, rej) => c.get(s, p, (e, r) => (e ? rej(e) : res(r))));
const all = (c, s, p = []) => new Promise((res, rej) => c.all(s, p, (e, r) => (e ? rej(e) : res(r || []))));
const tableExists = (c, name) => get(c, `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`, [name]).then((r) => !!r);

const trunc = (v) => {
    if (v == null) return 'null';
    const s = String(v);
    return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
};

const snapshot = async (conn) => {
    const snap = { plans: new Map(), devices: new Map(), subs: new Map(), counts: {} };
    if (await tableExists(conn, 'user_plans')) {
        for (const r of await all(conn, `SELECT user_id, plan_gb, status, expires_at, grace_until, deleted_at, premium_gb, premium_expires_at, payment_type, trial_until FROM user_plans`))
            snap.plans.set(Number(r.user_id), r);
    }
    if (await tableExists(conn, 'paceseeker_devices')) {
        for (const r of await all(conn, `SELECT device_hash, sub_until, ad_until FROM paceseeker_devices`))
            snap.devices.set(String(r.device_hash), r);
    }
    if (await tableExists(conn, 'stealthlynk_subs')) {
        for (const r of await all(conn, `SELECT account_id, sub_until, source_app, source_kind, provenance FROM stealthlynk_subs`))
            snap.subs.set(String(r.account_id), r);
    }
    for (const t of ['solana_payments', 'paceseeker_revenue', 'ad_claims', 'ecosystem_members', 'ecosystem_accounts']) {
        snap.counts[t] = (await tableExists(conn, t))
            ? Number((await get(conn, `SELECT COUNT(*) AS n FROM ${t}`)).n) : null;
    }
    return snap;
};

const compare = (before, after) => {
    const regressions = [];
    const gains = [];
    const liveStatus = (s) => ['active', 'grace', 'trial'].includes(String(s));
    // ---- user_plans -------------------------------------------------------
    for (const [uid, b] of before.plans) {
        const a = after.plans.get(uid);
        const id = `user ${uid}`;
        if (!a) { regressions.push({ table: 'user_plans', id, field: 'row', before: 'present', after: 'missing' }); continue; }
        if (liveStatus(b.status) && Number(a.plan_gb || 0) < Number(b.plan_gb || 0))
            regressions.push({ table: 'user_plans', id, field: 'plan_gb', before: Number(b.plan_gb || 0), after: Number(a.plan_gb || 0) });
        else if (Number(a.plan_gb || 0) > Number(b.plan_gb || 0))
            gains.push({ table: 'user_plans', id, field: 'plan_gb', before: Number(b.plan_gb || 0), after: Number(a.plan_gb || 0) });
        const be = b.expires_at == null ? null : Number(b.expires_at);
        const ae = a.expires_at == null ? null : Number(a.expires_at);
        if (liveStatus(b.status)) {
            // NULL before = unbounded: any finite after is a loss, but only an
            // ACTIVE row can legitimately hold unbounded paid time.
            const expRegressed = (be == null && ae != null && String(b.status) === 'active')
                || (be != null && ae != null && ae < be);
            if (expRegressed) regressions.push({ table: 'user_plans', id, field: 'expires_at', before: be, after: ae });
            else if (ae != null && (be == null || ae > be)) gains.push({ table: 'user_plans', id, field: 'expires_at', before: be, after: ae });
        } else if (ae != null && be != null && ae > be) {
            gains.push({ table: 'user_plans', id, field: 'expires_at', before: be, after: ae });
        }
        if (String(a.premium_gb ?? '') !== String(b.premium_gb ?? ''))
            regressions.push({ table: 'user_plans', id, field: 'premium_gb', before: b.premium_gb ?? null, after: a.premium_gb ?? null });
        if (String(a.premium_expires_at ?? '') !== String(b.premium_expires_at ?? ''))
            regressions.push({ table: 'user_plans', id, field: 'premium_expires_at', before: b.premium_expires_at ?? null, after: a.premium_expires_at ?? null });
        if ((a.deleted_at != null) && (b.deleted_at == null))
            regressions.push({ table: 'user_plans', id, field: 'deleted_at', before: null, after: Number(a.deleted_at) });
        if (String(a.trial_until ?? '') !== String(b.trial_until ?? ''))
            regressions.push({ table: 'user_plans', id, field: 'trial_until', before: b.trial_until ?? null, after: a.trial_until ?? null });
    }
    for (const [uid, a] of after.plans) {
        if (!before.plans.has(uid) && (Number(a.plan_gb || 0) > 0 || a.expires_at != null))
            gains.push({ table: 'user_plans', id: `user ${uid}`, field: 'row', before: 'missing', after: `plan_gb=${a.plan_gb} expires_at=${a.expires_at}` });
    }
    // ---- paceseeker_devices ------------------------------------------------
    for (const [dev, b] of before.devices) {
        const a = after.devices.get(dev);
        const id = `device ${trunc(dev)}`;
        if (!a) { regressions.push({ table: 'paceseeker_devices', id, field: 'row', before: 'present', after: 'missing' }); continue; }
        const bs = Number(b.sub_until || 0); const as = Number(a.sub_until || 0);
        if (as < bs) regressions.push({ table: 'paceseeker_devices', id, field: 'sub_until', before: bs, after: as });
        else if (as > bs) gains.push({ table: 'paceseeker_devices', id, field: 'sub_until', before: bs, after: as });
        if (String(a.ad_until ?? '') !== String(b.ad_until ?? ''))
            regressions.push({ table: 'paceseeker_devices', id, field: 'ad_until', before: b.ad_until ?? null, after: a.ad_until ?? null });
    }
    // ---- stealthlynk_subs ---------------------------------------------------
    for (const [acct, b] of before.subs) {
        const a = after.subs.get(acct);
        const id = `account ${trunc(acct)}`;
        if (!a) { regressions.push({ table: 'stealthlynk_subs', id, field: 'row', before: 'present', after: 'missing' }); continue; }
        const bs = Number(b.sub_until || 0); const as = Number(a.sub_until || 0);
        if (as < bs && String(b.source_kind) !== 'revoke')
            regressions.push({ table: 'stealthlynk_subs', id, field: 'sub_until', before: bs, after: as, sourceKind: b.source_kind });
        else if (as > bs) gains.push({ table: 'stealthlynk_subs', id, field: 'sub_until', before: bs, after: as, sourceKind: b.source_kind });
    }
    return { regressions, gains };
};

const main = async () => {
    const conn = await open(workPath);
    try {
        const before = await snapshot(conn);
        const svc = createEcosystemService({ sqlite3, dbPath: workPath });
        const t0 = Date.now();
        const init = await svc.initialize();
        const initMs = Date.now() - t0;
        const members = await tableExists(conn, 'ecosystem_members')
            ? await all(conn, `SELECT app, identity FROM ecosystem_members ORDER BY app, identity`)
            : [];
        const t1 = Date.now();
        for (const m of members) {
            await svc.resolveIdentity(m.app, m.identity, { project: true });
        }
        const resolveMs = Date.now() - t1;
        // TEST ONLY: prove the detector fires on a planted regression.
        if (flagSet.has('--inject-regression')) {
            await run(conn, `UPDATE user_plans SET expires_at = expires_at - 1000
                 WHERE user_id = (SELECT MIN(user_id) FROM user_plans WHERE expires_at IS NOT NULL)`);
        }
        const after = await snapshot(conn);
        const { regressions, gains } = compare(before, after);
        const report = {
            source: srcPath, copy: workPath, at: new Date().toISOString(),
            init: { ms: initMs, initialized: !!init.initialized, migrated: !!init.migrated },
            membersResolved: members.length, resolveMs,
            counts: { before: before.counts, after: after.counts },
            regressions, gains,
        };
        console.log(`\n[dryrun] initialize: ${initMs}ms (migrated=${init.migrated}) — resolved ${members.length} member(s) in ${resolveMs}ms`);
        console.log(`[dryrun] rows: user_plans ${before.plans.size}->${after.plans.size}, paceseeker_devices ${before.devices.size}->${after.devices.size}, stealthlynk_subs ${before.subs.size}->${after.subs.size}`);
        for (const [t, n] of Object.entries(before.counts)) {
            if (n != null) console.log(`[dryrun]   ${t}: ${n} -> ${after.counts[t]}`);
        }
        if (gains.length) {
            console.log(`\n[dryrun] GAINS (${gains.length}) — expiry/plan increased (review; unexpected gains are suspicious):`);
            for (const g of gains.slice(0, 20)) console.log(`[dryrun]   + ${g.id}: ${g.field} ${g.before} -> ${g.after}`);
            if (gains.length > 20) console.log(`[dryrun]   ... and ${gains.length - 20} more`);
        }
        if (regressions.length) {
            console.log(`\n[dryrun] REGRESSIONS (${regressions.length}):`);
            for (const r of regressions.slice(0, 50)) console.log(`[dryrun]   ! ${r.id}: ${r.field} ${r.before} -> ${r.after}`);
            if (regressions.length > 50) console.log(`[dryrun]   ... and ${regressions.length - 50} more`);
        } else {
            console.log(`\n[dryrun] REGRESSIONS: 0 — no entitlement was lowered by the migration`);
        }
        if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2)); console.log(`[dryrun] full report: ${jsonOut}`); }
        process.exit(regressions.length ? 1 : 0);
    } finally {
        await new Promise((res) => conn.close(() => res()));
    }
};

main().catch((e) => { console.error(`[dryrun] ERROR:`, e.stack || e); process.exit(2); });
