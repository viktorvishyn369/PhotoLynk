'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const sqlite3 = require('sqlite3');
const { createEcosystemService, DAY_MS } = require('./ecosystemEntitlements');

test('isolated scale: preserve 10000 legacy accounts, resolve 100, credit 100 concurrently', { timeout: 600000 }, async (t) => {
    const source = fs.readFileSync(path.join(__dirname, 'ecosystemEntitlements.test.js'), 'utf8');
    const start = source.indexOf('const FIXTURE_DDL = [');
    const end = source.indexOf('\n];', start);
    assert.ok(start >= 0 && end > start, 'fixture schema anchors must exist');
    const ddl = vm.runInNewContext(`${source.slice(start, end + 3)}\nFIXTURE_DDL`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-scale-'));
    const dbPath = path.join(dir, 'isolated.sqlite');
    let db;
    const delay = monitorEventLoopDelay({ resolution: 20 });
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (error) { error ? reject(error) : resolve(this); });
    });
    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
    const close = () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    const accountCount = 10000;
    const sampleCount = 100;
    const paidAt = Date.now();
    const expiry = paidAt + 30 * DAY_MS;
    try {
        db = await new Promise((resolve, reject) => {
            const connection = new sqlite3.Database(dbPath, error => error ? reject(error) : resolve(connection));
        });
        await run('PRAGMA journal_mode = WAL');
        await run('PRAGMA busy_timeout = 10000');
        for (const sql of ddl) await run(sql);
        await run('BEGIN IMMEDIATE');
        for (let id = 1; id <= accountCount; id++) {
            const account = `eco_${id.toString(16).padStart(24, '0')}`;
            await run('INSERT INTO users(id,email) VALUES (?,?)', [id, `fixture-${id}@example.invalid`]);
            await run(
                "INSERT INTO user_plans(user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at,premium_gb,premium_expires_at) VALUES (?,400,'active',?,'solana',?,?,1000,?)",
                [id, expiry, paidAt, paidAt, paidAt + 365 * DAY_MS]);
            await run('INSERT INTO ecosystem_accounts(account_id,created_at) VALUES (?,?)', [account, paidAt]);
            await run("INSERT INTO ecosystem_members(account_id,app,identity,linked_at) VALUES (?,'photolynk',?,?)", [account, String(id), paidAt]);
        }
        await run('COMMIT');

        const service = createEcosystemService({ sqlite3, dbPath, now: () => paidAt });
        const rssBefore = process.memoryUsage().rss;
        delay.enable();
        const migrationStart = performance.now();
        await service.initialize();
        const migrationMs = performance.now() - migrationStart;
        const damaged = await get(
            "SELECT COUNT(*) AS n FROM user_plans WHERE plan_gb <> 400 OR status <> 'active' OR expires_at <> ? OR premium_gb <> 1000 OR premium_expires_at <> ?",
            [expiry, paidAt + 365 * DAY_MS]);
        assert.equal(damaged.n, 0, 'migration must not reduce or rewrite existing subscription/premium benefits');
        assert.equal((await get('SELECT COUNT(*) AS n FROM user_plans')).n, accountCount);

        const readMs = [];
        for (let sample = 0; sample < sampleCount; sample++) {
            const id = 1 + sample * (accountCount / sampleCount);
            const began = performance.now();
            const snapshot = await service.resolveIdentity('photolynk', String(id), { project: false, at: paidAt });
            readMs.push(performance.now() - began);
            assert.equal(snapshot.entitlement.planGb, 400);
            assert.equal(snapshot.entitlement.expiresAt, expiry);
        }
        assert.equal((await get('SELECT COUNT(*) AS n FROM ecosystem_receipts')).n, 0, 'reads must not manufacture receipts');

        for (let id = 1; id <= sampleCount; id++) {
            const deviceHash = `fixture_device_${String(id).padStart(20, '0')}`;
            const wallet = `FixtureWallet${String(id).padStart(24, '0')}`;
            const account = `eco_${id.toString(16).padStart(24, '0')}`;
            await run('INSERT INTO paceseeker_devices(device_hash) VALUES (?)', [deviceHash]);
            await run(
                "INSERT INTO ecosystem_members(account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,'paceseeker',?,?,1,?)",
                [account, deviceHash, wallet, paidAt]);
            await run(
                "INSERT INTO ecosystem_member_proofs(app,identity,wallet,kind,reference,verified_at) VALUES ('paceseeker',?,?,'bind','isolated-fixture',?)",
                [deviceHash, wallet, paidAt]);
        }
        const writesStart = performance.now();
        const results = await Promise.all(Array.from({ length: sampleCount }, (_, index) => {
            const id = index + 1;
            return service.applyPaceSeekerPayment({
                signature: `isolated-scale-receipt-${id}`,
                token: 'USDC',
                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                amountAtomic: '3990000',
                payerWallet: `FixtureWallet${String(id).padStart(24, '0')}`,
                paidAt,
                verifiedAt: paidAt,
            }, { deviceHash: `fixture_device_${String(id).padStart(20, '0')}` });
        }));
        const writesMs = performance.now() - writesStart;
        assert.ok(results.every(result => result.ok && !result.alreadyApplied));
        assert.ok(results.every(result => result.sharedUntil === expiry), 'each account receives exactly one period');
        assert.equal((await get('SELECT COUNT(*) AS n FROM ecosystem_receipts')).n, sampleCount);
        assert.equal((await get(
            "SELECT COUNT(*) AS n FROM user_plans WHERE plan_gb <> 400 OR status <> 'active' OR expires_at <> ? OR premium_gb <> 1000 OR premium_expires_at <> ?",
            [expiry, paidAt + 365 * DAY_MS])).n, 0);

        const sorted = [...readMs].sort((a, b) => a - b);
        const percentile = p => sorted[Math.ceil(p * sorted.length) - 1];
        const milliseconds = value => Number.isFinite(value) ? Number(value.toFixed(2)) : null;
        delay.disable();
        t.diagnostic(JSON.stringify({
            fixtureOnly: true,
            accounts: accountCount,
            readSamples: sampleCount,
            concurrentCredits: sampleCount,
            migrationMs: milliseconds(migrationMs),
            readP50Ms: milliseconds(percentile(0.5)),
            readP95Ms: milliseconds(percentile(0.95)),
            concurrentCreditsTotalMs: milliseconds(writesMs),
            eventLoopDelayMeanMs: milliseconds(delay.mean / 1e6),
            eventLoopDelayMaxMs: milliseconds(delay.max / 1e6),
            rssBeforeBytes: rssBefore,
            rssAfterBytes: process.memoryUsage().rss,
        }));
    } finally {
        delay.disable();
        if (db) await close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
