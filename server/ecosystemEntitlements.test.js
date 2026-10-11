'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { createEcosystemService, DAY_MS } = require('./ecosystemEntitlements');

const WEEK_MS = 7 * DAY_MS;
const createdDirs = [];
test.after(() => { for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true }); });

const FIXTURE_DDL = [
    `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)`,
    `CREATE TABLE user_plans (user_id INTEGER PRIMARY KEY, plan_gb INTEGER, premium_gb INTEGER, premium_expires_at INTEGER, status TEXT, expires_at INTEGER, grace_until INTEGER, trial_until INTEGER, deleted_at INTEGER, payment_type TEXT, payment_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, filename TEXT, size INTEGER)`,
    `CREATE TABLE ecosystem_accounts (account_id TEXT PRIMARY KEY, primary_wallet TEXT, created_at INTEGER, ad_strict INTEGER DEFAULT 0)`,
    `CREATE TABLE ecosystem_members (account_id TEXT NOT NULL, app TEXT NOT NULL, identity TEXT NOT NULL, wallet TEXT, linked_at INTEGER, wallet_verified INTEGER DEFAULT 0, wallet_changed_at INTEGER, PRIMARY KEY (app, identity))`,
    `CREATE TABLE stealthlynk_subs (account_id TEXT PRIMARY KEY, sub_until INTEGER, source_app TEXT, source_kind TEXT, provenance TEXT, updated_at INTEGER)`,
    `CREATE TABLE ad_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, week_key INTEGER NOT NULL, platform TEXT, post_url TEXT UNIQUE, code TEXT, author_handle TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, verified_at INTEGER, verify_attempts INTEGER DEFAULT 0, granted_at INTEGER, app TEXT, tier_gb INTEGER, UNIQUE(account_id, week_key))`,
    `CREATE TABLE solana_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tx_signature TEXT UNIQUE NOT NULL, sol_amount REAL, skr_amount REAL, payment_token TEXT, tier_gb INTEGER, duration TEXT DEFAULT 'monthly', created_at INTEGER, verified_at INTEGER, entitlement_applied_at INTEGER)`,
    `CREATE TABLE solana_subscription_credits (tx_signature TEXT PRIMARY KEY,user_id INTEGER NOT NULL,source TEXT NOT NULL,payment_at INTEGER NOT NULL,expires_before INTEGER,expires_after INTEGER NOT NULL,detail TEXT,created_at INTEGER NOT NULL)`,
    `CREATE TABLE solana_wallet_bindings (wallet TEXT NOT NULL,user_id INTEGER NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(wallet,user_id))`,
    `CREATE TABLE paceseeker_devices (device_hash TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, sub_status TEXT, sub_until INTEGER, ad_until INTEGER, sub_signature TEXT, wallet_address TEXT)`,
    `CREATE TABLE paceseeker_revenue (signature TEXT PRIMARY KEY, device_hash TEXT, paid_at INTEGER, paid_with TEXT, plan TEXT, usd_at_checkout REAL, amount_atomic INTEGER, reported_at INTEGER, eco_verified INTEGER DEFAULT 0)`,
];

const DEV1 = 'dev_' + 'a'.repeat(20);
const DEV2 = 'dev_' + 'b'.repeat(20);
const W1 = 'WALLETaaaabbbbccccddddeeeeffffgg';
const W2 = 'WALLEThhhhiiiijjjjkkkkllllmmmmnn';

const openDb = (file) => new Promise((res, rej) => {
    const conn = new sqlite3.Database(file, (e) => e ? rej(e) : res(conn));
});
const runOn = (conn, sql, p = []) => new Promise((res, rej) => conn.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const getOn = (conn, sql, p = []) => new Promise((res, rej) => conn.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const allOn = (conn, sql, p = []) => new Promise((res, rej) => conn.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const closeDb = (conn) => new Promise((res) => conn.close(() => res()));

const mk = async ({ registry } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-'));
    createdDirs.push(dir);
    const file = path.join(dir, 'test.db');
    const conn = await openDb(file);
    for (const ddl of FIXTURE_DDL) await runOn(conn, ddl);
    const clock = { t: Date.now() };
    const svc = createEcosystemService({ sqlite3, dbPath: file, now: () => clock.t, ...(registry ? { registry } : {}) });
    return { svc, conn, clock, file, dir };
};

const plPayment = (over = {}) => ({
    signature: 'sigPL' + Math.random().toString(16).slice(2, 10),
    userId: 1, token: 'SOL', amountAtomic: '10000000', payerWallet: W1,
    paidAt: Date.now(), tierGb: 400, duration: 'monthly', source: 'solana',
    ...over,
});
const psReceipt = (over = {}) => ({
    signature: 'sigPS' + Math.random().toString(16).slice(2, 10),
    token: 'SOL', amountAtomic: '5000000', payerWallet: W1,
    paidAt: Date.now(), verifiedAt: Date.now(), ...over,
});

test('initialize creates schema idempotently', async () => {
    const { svc, conn } = await mk();
    const r1 = await svc.initialize();
    assert.equal(r1.initialized, true);
    assert.equal(r1.migrated, true);
    const r2 = await svc.initialize();
    assert.equal(r2.migrated, false, 'baseline_v2 prevents a second migration');
    const tables = (await allOn(conn, `SELECT name FROM sqlite_master WHERE type='table'`)).map(r => r.name);
    for (const t of ['ecosystem_meta', 'ecosystem_receipts', 'ecosystem_events', 'ecosystem_benefits', 'ecosystem_jobs', 'ecosystem_aliases', 'ecosystem_member_proofs', 'ecosystem_revisions', 'ecosystem_projection_state', 'ecosystem_receipt_conflicts'])
        assert.ok(tables.includes(t), `missing ${t}`);
    await closeDb(conn);
});

test('two concurrent PS receipts add 60d shared once; duplicate never extends', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?)`, [DEV1]);
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'proof1' });
    const p1 = psReceipt({ signature: 'sigPSaaaa', paidAt: t0 });
    const p2 = psReceipt({ signature: 'sigPSbbbb', paidAt: t0 });
    const [r1, r2] = await Promise.all([
        svc.applyPaceSeekerPayment(p1, { deviceHash: DEV1 }),
        svc.applyPaceSeekerPayment(p2, { deviceHash: DEV1 }),
    ]);
    assert.equal(r1.alreadyApplied, false);
    assert.equal(r2.alreadyApplied, false);
    const res = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 60 * DAY_MS, 'two receipts stack to 60d');
    const dup = await svc.applyPaceSeekerPayment(p1, { deviceHash: DEV1 });
    assert.equal(dup.alreadyApplied, true);
    assert.equal(dup.sharedUntil, t0 + 60 * DAY_MS, 'replayed receipt adds nothing');
    const dev = await getOn(conn, `SELECT sub_until FROM paceseeker_devices WHERE device_hash = ?`, [DEV1]);
    assert.equal(Number(dev && dev.sub_until), t0 + 60 * DAY_MS);
    await closeDb(conn);
});

test('PL + PS simultaneous payments on one account lose no shared term', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?)`, [DEV1]);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,?,?,?,1,?)`, [acct, 'paceseeker', DEV1, W1, t0]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at) VALUES (?,?,?,?,?)`, ['paceseeker', DEV1, W1, 'bind', t0]);
    const [rPl] = await Promise.all([
        svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 400, paidAt: t0 }))),
        svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPScc', paidAt: t0 }), { deviceHash: DEV1 }),
    ]);
    const res = await svc.resolveAccount(acct);
    assert.equal(res.sharedUntil, t0 + 60 * DAY_MS, 'PL400 and PS both contributed 30d shared');
    assert.equal(res.apps.photolynk.planGb, 400);
    assert.equal(res.apps.paceseeker.active, true);
    await closeDb(conn);
});

test('same signature cross-app reports PAYMENT_CONFLICT and records the conflict row', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'p1' });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigX', paidAt: clock.t }), { deviceHash: DEV1 });
    const conflict = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigX', userId: 1 })));
    assert.equal(conflict.code, 'PAYMENT_CONFLICT');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflicting.app, 'paceseeker');
    const c = await getOn(conn, `SELECT * FROM ecosystem_receipt_conflicts WHERE signature = 'sigX'`);
    assert.ok(c, 'conflict recorded');
    assert.equal(c.app, 'photolynk');
    const rec = await getOn(conn, `SELECT app FROM ecosystem_receipts WHERE signature = 'sigX'`);
    assert.equal(rec.app, 'paceseeker', 'first receipt is not overwritten');
    await closeDb(conn);
});

test('injected failure after receipt effects rolls the whole transaction back', async () => {
    const { svc, conn } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,status) VALUES (1,'none')`);
    await assert.rejects(
        svc.transaction(async (tx) => {
            await svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigRoll' }));
            throw new Error('boom');
        }));
    assert.equal(await getOn(conn, `SELECT signature FROM ecosystem_receipts WHERE signature='sigRoll'`), undefined);
    assert.equal(await getOn(conn, `SELECT event_id FROM ecosystem_events WHERE event_id='rcpt:sigRoll'`), undefined);
    assert.equal((await allOn(conn, `SELECT * FROM ecosystem_benefits`)).length, 0);
    await closeDb(conn);
});

test('trigger failure inside grant rolls event, benefits and granted_at back together', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES (?,52,'verified','photolynk',100,?)`, [acct, clock.t]);
    const claim = await getOn(conn, `SELECT id FROM ad_claims WHERE account_id = ?`, [acct]);
    await runOn(conn, `CREATE TRIGGER fail_benefit BEFORE INSERT ON ecosystem_benefits BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await assert.rejects(svc.grantAdClaim(claim.id));
    assert.equal(await getOn(conn, `SELECT event_id FROM ecosystem_events WHERE event_id='ad:${claim.id}'`), undefined);
    assert.equal((await getOn(conn, `SELECT granted_at FROM ad_claims WHERE id=?`, [claim.id])).granted_at, null);
    await runOn(conn, `DROP TRIGGER fail_benefit`);
    const g = await svc.grantAdClaim(claim.id);
    assert.equal(g.granted, true);
    assert.equal(g.grants.length, 1);
    assert.equal(g.grants[0].until, clock.t + WEEK_MS);
    const dup = await svc.grantAdClaim(claim.id);
    assert.equal(dup.alreadyGranted, true, 'replay does not stack a second week');
    const until = (await getOn(conn, `SELECT expires_at FROM user_plans WHERE user_id = 1`)).expires_at;
    assert.equal(Number(until), clock.t + WEEK_MS);
    await closeDb(conn);
});

test('close/reopen replay applies once; legacy ledger row prevents re-credit', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const r1 = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigPLonce', paidAt: t0, tierGb: 400 })));
    assert.equal(r1.alreadyApplied, false);
    assert.equal(r1.expiresAt, t0 + 30 * DAY_MS);
    const r2 = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigPLonce', paidAt: t0, tierGb: 400 })));
    assert.equal(r2.alreadyApplied, true);
    assert.equal(r2.expiresAt, t0 + 30 * DAY_MS, 'replay never appends another term');
    const plan = await getOn(conn, `SELECT status, plan_gb, expires_at, payment_type FROM user_plans WHERE user_id = 1`);
    assert.equal(plan.status, 'active');
    assert.equal(Number(plan.plan_gb), 400);
    await closeDb(conn);
});

test('existing solana_payments signature is not re-credited (premium race protected)', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigOld',400,'monthly',?,?)`, [clock.t - 1000, clock.t - 1000]);
    const r = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigOld', tierGb: 400, paidAt: clock.t - 1000 })));
    assert.equal(r.alreadyApplied, true);
    const benefits = await allOn(conn, `SELECT * FROM ecosystem_benefits WHERE event_id = 'rcpt:sigOld'`);
    assert.equal(benefits.length, 0, 'no fresh benefit for an already-accounted payment');
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigPrem',0,'premium',?,?)`, [clock.t, clock.t]);
    const blocked = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigPrem', tierGb: 400 })));
    assert.equal(blocked.code, 'PAYMENT_CONFLICT');
    const claim = await svc.transaction((tx) => svc.claimPremiumInTransaction(tx, { signature: 'sigPrem', userId: 1, token: 'SOL', payerWallet: W1, amountAtomic: '7', paidAt: clock.t }));
    assert.equal(claim.alreadyApplied, true);
    await closeDb(conn);
});

test('PL1000 + PS renewal: 1000GB until T1 then shared400 until T2', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?)`, [DEV1]);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,?,?,?,1,?)`, [acct, 'paceseeker', DEV1, W1, t0]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at) VALUES (?,?,?,?,?)`, ['paceseeker', DEV1, W1, 'bind', t0]);
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 1000, paidAt: t0 })));
    const t1 = t0 + 30 * DAY_MS;
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPSx', paidAt: t0 }), { deviceHash: DEV1 });
    const t2 = t1 + 30 * DAY_MS;
    const atT1 = await svc.resolveIdentity('photolynk', '1', { at: t1 - 1 });
    assert.equal(atT1.apps.photolynk.planGb, 1000);
    const after = await svc.resolveIdentity('photolynk', '1', { at: t1 + 1 });
    assert.equal(after.apps.photolynk.planGb, 400, 'PL1000 local expires at T1, shared400 remains');
    assert.equal(after.apps.photolynk.expiresAt, t2);
    const plan = await getOn(conn, `SELECT plan_gb, expires_at FROM user_plans WHERE user_id = 1`);
    assert.equal(Number(plan.plan_gb), 400, 'projection at t1+1 materializes shared400');
    assert.equal(Number(plan.expires_at), t2);
    await closeDb(conn);
});

test('PL100 local with later expiry cannot suppress the shared400 tier', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 100, duration: 'yearly', paidAt: t0 })));
    const acct = (await svc.resolveIdentity('photolynk', '1', { project: false })).accountId;
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?)`, [DEV1]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,?,?,?,1,?)`, [acct, 'paceseeker', DEV1, W1, t0]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at) VALUES (?,?,?,?,?)`, ['paceseeker', DEV1, W1, 'bind', t0]);
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPSy', paidAt: t0 }), { deviceHash: DEV1 });
    const res = await svc.resolveIdentity('photolynk', '1', { at: t0 + 5 * DAY_MS });
    assert.equal(res.apps.photolynk.planGb, 400, 'shared400 outranks the longer-lived 100GB plan');
    assert.equal(res.apps.photolynk.expiresAt, t0 + 30 * DAY_MS, 'expiry tracks only benefits supplying the chosen tier');
    await closeDb(conn);
});

test('low-tier purchase after a big legacy shared grant cannot extend shared', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acct1',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES ('acct1','photolynk','1',NULL,0,?)`, [t0]);
    await runOn(conn, `INSERT INTO stealthlynk_subs (account_id,sub_until,source_app,source_kind,updated_at) VALUES ('acct1',?,'paceseeker','payment',?)`, [t0 + 90 * DAY_MS, t0]);
    await svc.initialize();
    const before = (await svc.resolveAccount('acct1', { at: t0 })).sharedUntil;
    assert.equal(before, t0 + 90 * DAY_MS);
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 200, paidAt: t0 })));
    const after = (await svc.resolveAccount('acct1', { at: t0 })).sharedUntil;
    assert.equal(after, t0 + 90 * DAY_MS, 'a non-qualifying purchase adds no shared time');
    await closeDb(conn);
});

test('premium claim records receipt+event only, no subscription effects', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const r = await svc.transaction((tx) => svc.claimPremiumInTransaction(tx, { signature: 'sigPrem1', userId: 1, token: 'SOL', payerWallet: W1, amountAtomic: '999', paidAt: clock.t }));
    assert.equal(r.alreadyApplied, false);
    assert.equal((await allOn(conn, `SELECT * FROM ecosystem_benefits`)).length, 0);
    const rec = await getOn(conn, `SELECT * FROM ecosystem_receipts WHERE signature='sigPrem1'`);
    assert.equal(rec.product_id, 'photolynk.premium');
    const plan = await getOn(conn, `SELECT * FROM user_plans WHERE user_id = 1`);
    assert.equal(plan, undefined, 'premium never writes plan rows');
    const planCols = await allOn(conn, `PRAGMA table_info(user_plans)`);
    assert.ok(planCols.length > 0);
    const r2 = await svc.transaction((tx) => svc.claimPremiumInTransaction(tx, { signature: 'sigPrem1', userId: 1, token: 'SOL', payerWallet: W1, amountAtomic: '999', paidAt: clock.t }));
    assert.equal(r2.alreadyApplied, true);
    await closeDb(conn);
});

test('ad grant is app-local: a member joining later does not inherit the week', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?)`, [DEV1]);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES (?,99,'verified','photolynk',200,?)`, [acct, t0]);
    const claim = await getOn(conn, `SELECT id FROM ad_claims WHERE account_id=?`, [acct]);
    const g = await svc.grantAdClaim(claim.id, { tierGb: 200 });
    assert.equal(g.granted, true);
    assert.equal(g.grants[0].until, t0 + WEEK_MS);
    clock.t += 1000;
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,?,?,?)`, [acct, 'paceseeker', DEV1, clock.t]);
    const res = await svc.resolveAccount(acct, { at: clock.t });
    assert.equal(res.apps.paceseeker.active, false, 'ad week never binds a future app member');
    assert.equal(res.apps.photolynk.expiresAt, t0 + WEEK_MS);
    const plan = await getOn(conn, `SELECT plan_gb FROM user_plans WHERE user_id = 1`);
    assert.equal(Number(plan.plan_gb), 200, 'ad materializes capped at 200GB');
    await closeDb(conn);
});

test('admin set-until/revoke cannot be backfilled; independent direct payment unaffected', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'p1' });
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,'photolynk','1',?)`, [acct, t0]);
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPSa', paidAt: t0 }), { deviceHash: DEV1 });
    const short = t0 + 5 * DAY_MS;
    await svc.adjustShared(acct, { action: 'set-until', until: short, eventId: 'adm:1', actor: 'admin' });
    let res = await svc.resolveAccount(acct, { at: t0 + 1000 });
    assert.equal(res.sharedUntil, short, 'admin set-until exactly shortens shared');
    await svc.adjustShared(acct, { action: 'revoke', eventId: 'adm:2', actor: 'admin' });
    res = await svc.resolveAccount(acct, { at: t0 + 1000 });
    assert.equal(res.sharedUntil, 0, 'revoke zeroes shared');
    assert.equal(res.apps.paceseeker.active, true, 'the independent direct PS benefit survives a shared revoke');
    res = await svc.resolveAccount(acct, { at: t0 + 1000, project: true });
    assert.equal(res.sharedUntil, 0, 'projection must not resurrect the revoked grant');
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 100, paidAt: t0 + 2000, signature: 'sigLocal' })));
    res = await svc.resolveAccount(acct, { at: t0 + 2000 });
    assert.equal(res.apps.photolynk.active, true, 'an independent direct payment still works under revoke');
    assert.equal(res.sharedUntil, 0);
    const r = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPSnew', paidAt: t0 + 3000 }), { deviceHash: DEV1 });
    res = await svc.resolveAccount(acct, { at: t0 + 3000 });
    assert.equal(res.sharedUntil, t0 + 3000 + 30 * DAY_MS, 'a NEW qualifying payment lifts revoke prospectively');
    await closeDb(conn);
});

test('replayed receipt after revoke does not lift it', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'p1' });
    const acct = (await svc.resolveIdentity('paceseeker', DEV1, { project: false })).accountId;
    const receipt = psReceipt({ signature: 'sigPSr', paidAt: t0 });
    await svc.applyPaceSeekerPayment(receipt, { deviceHash: DEV1 });
    await svc.adjustShared(acct, { action: 'revoke', eventId: 'adm:r', actor: 'admin' });
    const dup = await svc.applyPaceSeekerPayment(receipt, { deviceHash: DEV1 });
    assert.equal(dup.alreadyApplied, true);
    const res = await svc.resolveAccount(acct, { at: t0 + 1000 });
    assert.equal(res.sharedUntil, 0, 'replayed receipt cannot lift the revoke');
    await closeDb(conn);
});

test('verified wallet links identities; unverified profile wallet never joins', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'ps-bind' });
    const joined = await svc.ensureAccount('photolynk', '1', { wallet: W1, proofKind: 'bind', proofRef: 'pl-bind' });
    assert.equal(joined, acct, 'a proven wallet joins the photolynk user into the same account');
    await runOn(conn, `INSERT INTO users (id,email) VALUES (2,'z@z.z')`);
    const forged = await svc.ensureAccount('photolynk', '2', { wallet: W1 });
    assert.notEqual(forged, acct, 'an unverified wallet report cannot join the proven account');
    await assert.rejects(
        svc.ensureAccount('paceseeker', DEV1, { wallet: W2, proofKind: 'bind', proofRef: 'rotate-attempt' }),
        (e) => e.code === 'WALLET_MISMATCH');
    const rotated = await svc.ensureAccount('paceseeker', DEV1, { wallet: W2, proofKind: 'rotation', proofRef: 'rotation-proof', allowRotation: true });
    assert.equal(rotated, acct, 'explicit rotation replaces the proven wallet');
    await closeDb(conn);
});

test('same-app collision refuses the merge but keeps the source account', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const b = await svc.ensureAccount('paceseeker', DEV2, { wallet: W1, proofKind: 'bind', proofRef: 'x' });
    const a = await svc.ensureAccount('paceseeker', DEV1, {});
    const own = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'y' });
    assert.equal(own, a, 'a valid bind keeps the source account; only auto-merge is refused');
    const still = await svc.resolveIdentity('paceseeker', DEV1, { project: false });
    assert.equal(still.accountId, a, 'source account retained after collision');
    const proof = await getOn(conn, `SELECT wallet_verified FROM ecosystem_members WHERE app='paceseeker' AND identity=?`, [DEV1]);
    assert.equal(Number(proof.wallet_verified), 1, 'a valid proof persists instead of rolling back');
    assert.equal(still.linkConflict.code, 'APP_ALREADY_LINKED');
    assert.equal(still.linkConflict.candidates.includes(b), true);
    await closeDb(conn);
});

test('merge combines benefits by max, aliases the source, keeps claims/audit', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const a = await svc.ensureAccount('photolynk', '1', {});
    const b = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 400, paidAt: t0, signature: 'sigA' })));
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigB', paidAt: t0 }), { deviceHash: DEV1 });
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,created_at) VALUES (?,1,'verified','paceseeker',?)`, [b, t0]);
    await svc.mergeAccounts(a, b);
    const mergedRes = await svc.resolveAccount(a, { at: t0 + 1000 });
    assert.deepEqual(mergedRes.members.map((m) => m.app).sort(), ['paceseeker', 'photolynk'], 'members resolve across the alias');
    const alias = await getOn(conn, `SELECT * FROM ecosystem_aliases WHERE alias_id = ?`, [b]);
    assert.equal(alias.account_id, a);
    const claim = await getOn(conn, `SELECT account_id FROM ad_claims WHERE week_key = 1`);
    assert.equal(claim.account_id, b, 'claims stay on the aliased account for audit');
    const res = mergedRes;
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'independent shared grants union by max, never stacked again');
    const psClaims = await svc.resolveAccount(b, { at: t0 + 1000 });
    assert.equal(psClaims.accountId, a, 'resolution follows the alias');
    await closeDb(conn);
});

test('merge rollback on injected failure moves nothing', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const a = await svc.ensureAccount('photolynk', '1', {});
    const b = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await runOn(conn, `CREATE TRIGGER fail_alias BEFORE INSERT ON ecosystem_aliases BEGIN SELECT RAISE(ABORT,'x'); END`);
    await assert.rejects(svc.mergeAccounts(a, b));
    await runOn(conn, `DROP TRIGGER fail_alias`);
    assert.equal((await getOn(conn, `SELECT account_id FROM ecosystem_members WHERE app='paceseeker'`)).account_id, b);
    assert.equal(await getOn(conn, `SELECT * FROM ecosystem_aliases`), undefined);
    await closeDb(conn);
});

test('baseline migration preserves legacy rows and never duplicates on rerun', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    const tPlan = t0 + 10 * DAY_MS;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c'),(2,'z@z.z')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,premium_gb,premium_expires_at,trial_until,updated_at)
        VALUES (1,400,'active',?,'solana',?,500,?,NULL,?)`,
        [tPlan, t0 - DAY_MS, t0 + 60 * DAY_MS, t0]);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,trial_until,updated_at)
        VALUES (2,100,'trial',NULL,?,?)`, [t0 + DAY_MS, t0]);
    await runOn(conn, `INSERT INTO files (user_id,filename,size) VALUES (1,'a.jpg',10)`);
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigLegacy',400,'monthly',?,?)`, [t0 - DAY_MS, t0 - DAY_MS]);
    await runOn(conn, `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,created_at) VALUES ('sigLegacy',1,'x',?,NULL,?,?)`, [t0 - DAY_MS, tPlan, t0 - DAY_MS]);
    await runOn(conn, `INSERT INTO solana_wallet_bindings (wallet,user_id,verified_at) VALUES (?,1,?)`, [W1, t0]);
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acct1',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES ('acct1','photolynk','1',?,0,?)`, [W1, t0]);
    await runOn(conn, `INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,paid_with,plan,usd_at_checkout,reported_at,eco_verified) VALUES ('sigPSold',?,?,'SOL','monthly',3.99,?,1)`, [DEV1, t0 - DAY_MS, t0 - DAY_MS]);
    const r1 = await svc.initialize();
    assert.equal(r1.migrated, true);
    const r2 = await svc.initialize();
    assert.equal(r2.migrated, false);
    const receipts = await allOn(conn, `SELECT * FROM ecosystem_receipts ORDER BY signature`);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].legacy_accounted, 1);
    const plBen = await allOn(conn, `SELECT * FROM ecosystem_benefits WHERE identity='1' AND app='photolynk'`);
    assert.equal(plBen.length, 1);
    assert.equal(Number(plBen[0].expires_at), tPlan, 'legacy local plan expiry preserved');
    const proof = await getOn(conn, `SELECT * FROM ecosystem_member_proofs WHERE app='photolynk' AND identity='1'`);
    assert.equal(proof.wallet, W1);
    const sharedFloor = await allOn(conn, `SELECT * FROM ecosystem_benefits WHERE scope='shared' AND account_id='acct1'`);
    assert.equal(sharedFloor.length, 1, 'qualifying ledger seeds a shared floor');
    assert.equal(Number(sharedFloor[0].expires_at), t0 - DAY_MS + 30 * DAY_MS, 'floor takes the max of ledger candidates');
    const plan = await getOn(conn, `SELECT * FROM user_plans WHERE user_id = 1`);
    assert.equal(Number(plan.premium_gb), 500, 'premium untouched by migration');
    assert.equal(Number(plan.premium_expires_at), t0 + 60 * DAY_MS);
    const trial = await getOn(conn, `SELECT * FROM user_plans WHERE user_id = 2`);
    assert.equal(trial.status, 'trial', 'trial rows are not rewritten as paid benefits');
    const file = await getOn(conn, `SELECT * FROM files WHERE user_id = 1`);
    assert.equal(file.filename, 'a.jpg');
    const res = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(res.apps.photolynk.planGb, 400);
    assert.equal(res.apps.photolynk.active, true);
    await closeDb(conn);
});

test('migration: legacy revoke subs row suppresses shared, ad subs stay local', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctR',?),('acctA',?)`, [t0, t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES ('acctR','photolynk','1',?),('acctA','paceseeker',?,?)`, [t0, DEV1, t0]);
    await runOn(conn, `INSERT INTO stealthlynk_subs (account_id,sub_until,source_app,source_kind,updated_at) VALUES ('acctR',?,NULL,'revoke',?),('acctA',?,'paceseeker','ad_claim',?)`,
        [t0 + 50 * DAY_MS, t0, t0 + 20 * DAY_MS, t0]);
    await svc.initialize();
    const rr = await svc.resolveAccount('acctR', { at: t0 + 1000 });
    assert.equal(rr.sharedUntil, 0, 'revoke suppresses shared');
    assert.equal(rr.apps.photolynk.active, false);
    const ra = await svc.resolveAccount('acctA', { at: t0 + 1000 });
    assert.equal(ra.apps.paceseeker.active, true, 'ad week applies to the claiming app member');
    assert.equal(ra.sharedUntil, 0, 'ad subs never create a shared row');
    await closeDb(conn);
});

test('third registered app receives shared features via registry only', async () => {
    const registry = JSON.parse(JSON.stringify(require('./ecosystemEntitlements').DEFAULT_REGISTRY));
    registry.apps.appx = { monthlyValueCents: 399, benefit: 'features' };
    const { svc, conn, clock } = await mk({ registry });
    await svc.initialize();
    const t0 = clock.t;
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'p1' });
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,?,?,?)`, [acct, 'appx', 'some-appx-id', t0]);
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPSq', paidAt: t0 }), { deviceHash: DEV1 });
    const res = await svc.resolveAccount(acct, { at: t0 + 1000 });
    assert.equal(res.apps.appx.active, true, 'a registered third app shares the qualifying grant');
    assert.equal(res.apps.appx.expiresAt, t0 + 30 * DAY_MS);
    await closeDb(conn);
});

test('jobs: enqueue merge, lease ownership, retry backoff, stale finish refused', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const e1 = await svc.enqueueVerification({ signature: 'sigJob1', app: 'paceseeker', identity: DEV1 });
    assert.equal(e1.enqueued, true);
    const e2 = await svc.enqueueVerification({ signature: 'sigJob1', app: 'photolynk', identity: '1' });
    assert.equal(e2.enqueued, false);
    const subjects = JSON.parse(e2.job.payload_json).subjects;
    assert.equal(subjects.length, 2, 'subjects merge, first reporter never owns the job');
    const leased = await svc.leaseJobs({ limit: 10, leaseMs: 60000 });
    assert.equal(leased.length, 1);
    const job = leased[0];
    assert.ok(job.leaseToken);
    const wrong = await svc.finishJob({ job_key: job.job_key, leaseToken: 'bogus' }, { retryable: true, errorCode: 'E' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'LEASE_MISMATCH');
    const again = await svc.leaseJobs({ limit: 10, leaseMs: 60000 });
    assert.equal(again.length, 0, 'an active lease is not reclaimable');
    clock.t += 61000;
    const reLeased = await svc.leaseJobs({ limit: 10, leaseMs: 60000 });
    assert.equal(reLeased.length, 1, 'an expired lease can be reclaimed');
    const stale = await svc.finishJob(job, { retryable: false, errorCode: 'gone' });
    assert.equal(stale.ok, false, 'a stale completion cannot clobber the new lease');
    const retry = await svc.finishJob(reLeased[0], { retryable: true, errorCode: 'rpc_down' });
    assert.equal(retry.ok, true);
    assert.equal(retry.job.state, 'pending');
    assert.ok(Number(retry.job.next_attempt_at) > clock.t);
    const leased2 = await svc.leaseJobs({ limit: 10, leaseMs: 60000 });
    assert.equal(leased2.length, 0, 'backoff delays the retry');
    clock.t += 30000;
    const leased3 = await svc.leaseJobs({ limit: 10, leaseMs: 60000 });
    const done = await svc.finishJob(leased3[0], {});
    assert.equal(done.ok, true);
    assert.equal(done.job.state, 'done');
    const reopen = await svc.enqueueVerification({ signature: 'sigJob1', app: 'paceseeker', identity: DEV2 });
    assert.equal(reopen.enqueued, false);
    assert.equal(reopen.job.state, 'done', 'a finished job never reopens');
    const jobs = await svc.listJobs({ state: 'done' });
    assert.equal(jobs.length, 1);
    await closeDb(conn);
});

test('PS payment with no proven wallet throws retryable and writes nothing', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctX',?)`, [clock.t]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES ('acctX','paceseeker',?,?,0,?)`, [DEV1, W1, clock.t]);
    const unv = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigNoProof', payerWallet: W1 }), { deviceHash: DEV1 });
    assert.equal(unv.ok, false);
    assert.equal(unv.code, 'PAYMENT_ACCOUNT_UNVERIFIED');
    assert.equal(unv.retryable, true);
    assert.equal(await getOn(conn, `SELECT * FROM ecosystem_receipts WHERE signature='sigNoProof'`), undefined, 'no verified receipt for unbound payer');
    assert.equal((await allOn(conn, `SELECT * FROM ecosystem_benefits`)).length, 0);
    const unv2 = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigNoSubj' }), {});
    assert.equal(unv2.code, 'PAYMENT_ACCOUNT_UNVERIFIED');
    await closeDb(conn);
});

test('PS attribution follows a separately proven payer wallet on the same account', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W2, proofKind: 'bind', proofRef: 'dev-bind' });
    await svc.ensureAccount('paceseeker', DEV2, { wallet: W1, proofKind: 'bind', proofRef: 'payer-bind' });
    const r = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPSw2', payerWallet: W2, paidAt: t0 }), { deviceHash: DEV1 });
    assert.equal(r.alreadyApplied, false);
    assert.equal(r.accountId, acct);
    await closeDb(conn);
});

test('ambiguous proven wallet refuses attribution and join', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctP','acctQ')`, []);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at)
        VALUES ('acctP','paceseeker',?,?,1,?),('acctQ','paceseeker',?,?,1,?)`, [DEV1, W1, clock.t, DEV2, W1, clock.t]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at)
        VALUES ('paceseeker',?,?,?,?),('paceseeker',?,?,?,?)`, [DEV1, W1, 'bind', clock.t, DEV2, W1, 'bind', clock.t]);
    const amb = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigAmb', payerWallet: W1 }), {});
    assert.equal(amb.code, 'AMBIGUOUS_WALLET');
    assert.equal(amb.accounts.length, 2);
    assert.equal(await getOn(conn, `SELECT * FROM ecosystem_receipts WHERE signature='sigAmb'`), undefined);
    const bound = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigBound', payerWallet: W1 }), { deviceHash: DEV1 });
    assert.equal(bound.accountId, 'acctP', 'an already-bound member attributes to its own account');
    const DEV3 = 'dev_' + 'c'.repeat(20);
    const own = await svc.ensureAccount('paceseeker', DEV3, { wallet: W1, proofKind: 'bind', proofRef: 'z' });
    assert.ok(own, 'a valid ambiguous bind keeps its own account');
    const res = await svc.resolveIdentity('paceseeker', DEV3, { project: false });
    assert.equal(res.linkConflict.code, 'AMBIGUOUS_WALLET');
    await closeDb(conn);
});

test('resolve projection preserves trial rows and clears grace only with an active benefit', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c'),(2,'z@z.z')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,status,trial_until,updated_at) VALUES (2,'trial',?,?)`, [t0 + DAY_MS, t0]);
    const acct = await svc.ensureAccount('photolynk', '2', {});
    await svc.resolveIdentity('photolynk', '2', { at: t0, project: true });
    const trial = await getOn(conn, `SELECT status, trial_until FROM user_plans WHERE user_id = 2`);
    assert.equal(trial.status, 'trial', 'a trial row is not marked deleted or expired by projection');
    assert.equal(Number(trial.trial_until), t0 + DAY_MS);
    await runOn(conn, `INSERT INTO user_plans (user_id,status,expires_at,grace_until,updated_at) VALUES (1,'grace',?,?,?)`, [t0 - DAY_MS, t0 - 1000, t0]);
    const acct2 = await svc.ensureAccount('photolynk', '1', {});
    await svc.resolveIdentity('photolynk', '1', { at: t0, project: true });
    const g = await getOn(conn, `SELECT status, expires_at, grace_until FROM user_plans WHERE user_id = 1`);
    assert.equal(g.status, 'expired');
    assert.equal(Number(g.expires_at), t0 - DAY_MS, 'last finite expiry is retained for runtime grace');
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 400, paidAt: t0, signature: 'sigRecover' })));
    const g2 = await getOn(conn, `SELECT status, grace_until, deleted_at FROM user_plans WHERE user_id = 1`);
    assert.equal(g2.status, 'active');
    assert.equal(g2.grace_until, null, 'active benefit clears grace');
    await closeDb(conn);
});

test('A: unverified PS revenue report is telemetry; real payment still credits; wrong-device report does not reserve', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await runOn(conn, `INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,reported_at,eco_verified) VALUES ('sigHb',?,0,?,0)`, [DEV1, t0]);
    const r = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigHb', paidAt: t0 }), { deviceHash: DEV1 });
    assert.equal(r.ok, true, 'a same-device unverified report never blocks the verified payment');
    assert.equal(r.alreadyApplied, false);
    assert.equal(r.sharedUntil, t0 + 30 * DAY_MS);
    await runOn(conn, `INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,reported_at,eco_verified) VALUES ('sigHb2',?,0,?,0)`, [DEV2, t0]);
    const r2 = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigHb2', paidAt: t0 }), { deviceHash: DEV1 });
    assert.equal(r2.alreadyApplied, false, 'a different device heartbeat cannot reserve the signature');
    assert.equal(r2.accountId, acct);
    await closeDb(conn);
});

test('A: PS payment conflicts against freshly inserted solana_payments ledger', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigCross',400,'monthly',?,?)`, [clock.t, clock.t]);
    const r = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigCross' }), { deviceHash: DEV1 });
    assert.equal(r.code, 'PAYMENT_CONFLICT');
    assert.equal((await allOn(conn, `SELECT * FROM ecosystem_benefits WHERE event_id='rcpt:sigCross'`)).length, 0);
    const c = await getOn(conn, `SELECT * FROM ecosystem_receipt_conflicts WHERE signature='sigCross'`);
    assert.ok(c);
    await closeDb(conn);
});

test('B: stranger device cannot hijack a public signature; device requires its own proven wallet', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    const acctOwner = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await svc.ensureAccount('paceseeker', DEV2, { wallet: W2, proofKind: 'bind', proofRef: 'b2' });
    const hijack = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPub', payerWallet: W1, paidAt: t0 }), { deviceHash: DEV2 });
    assert.equal(hijack.code, 'PAYMENT_ACCOUNT_UNVERIFIED', 'an unproven device falls back to nothing');
    assert.equal(await getOn(conn, `SELECT signature FROM ecosystem_receipts WHERE signature='sigPub'`), undefined);
    const own = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPub', payerWallet: W1, paidAt: t0 }), { deviceHash: DEV1 });
    assert.equal(own.accountId, acctOwner);
    assert.equal(own.sharedUntil, t0 + 30 * DAY_MS);
    await closeDb(conn);
});

test('B: scanner without device uses the single proven PS member; photolynk-only proof queues registration', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await svc.ensureAccount('photolynk', '1', { wallet: W1, proofKind: 'bind', proofRef: 'plb' });
    const noPs = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigNoPs', payerWallet: W1, paidAt: t0 }), {});
    assert.equal(noPs.code, 'PAYMENT_ACCOUNT_UNVERIFIED');
    assert.equal(await getOn(conn, `SELECT signature FROM ecosystem_receipts WHERE signature='sigNoPs'`), undefined, 'never mints a wallet-origin receipt');
    const job = await getOn(conn, `SELECT * FROM ecosystem_jobs WHERE job_key='verify:solana:sigNoPs'`);
    assert.ok(job, 'a waiting verification job is queued');
    const acctPs = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'psb' });
    const ok = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigScan', payerWallet: W1, paidAt: t0 }), {});
    assert.equal(ok.accountId, acctPs, 'wallet-less scan attributes to the sole proven PS member');
    const rec = await getOn(conn, `SELECT origin_identity FROM ecosystem_receipts WHERE signature='sigScan'`);
    assert.equal(rec.origin_identity, DEV1);
    const replay = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigScan', payerWallet: W1, paidAt: t0 }), { deviceHash: DEV1 });
    assert.equal(replay.alreadyApplied, true, 'later device replay is idempotent');
    await closeDb(conn);
});

test('C: same signature with different duration/token/amount/payer conflicts', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigD', tierGb: 400, duration: 'monthly', paidAt: t0 })));
    const yearly = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigD', tierGb: 400, duration: 'yearly', paidAt: t0 })));
    assert.equal(yearly.code, 'PAYMENT_CONFLICT', 'monthly vs yearly on one signature conflicts');
    const tok = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigD', tierGb: 400, token: 'SKR', mint: 'MINTskr1', paidAt: t0 })));
    assert.equal(tok.code, 'PAYMENT_CONFLICT', 'SOL vs SKR on one signature conflicts');
    const amt = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigD', tierGb: 400, amountAtomic: '999', paidAt: t0 })));
    assert.equal(amt.code, 'PAYMENT_CONFLICT', 'different amount conflicts');
    const payer = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigD', tierGb: 400, payerWallet: W2, paidAt: t0 })));
    assert.equal(payer.code, 'PAYMENT_CONFLICT', 'different payer conflicts');
    const same = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigD', tierGb: 400, duration: 'monthly', paidAt: t0 })));
    assert.equal(same.alreadyApplied, true);
    await closeDb(conn);
});

test('C: missing or out-of-enum token is rejected; premium applied_at stays NULL until marked', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await assert.rejects(
        svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigT1', token: null }))),
        (e) => e.code === 'TOKEN_INVALID');
    await assert.rejects(
        svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigT2', token: 'BTC' }), { deviceHash: DEV1 }),
        (e) => e.code === 'TOKEN_INVALID');
    await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b' });
    const ok = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigT3', token: 'USDT', paidAt: t0 }), { deviceHash: DEV1 });
    assert.equal(ok.ok, true);
    const claim = await svc.transaction((tx) => svc.claimPremiumInTransaction(tx, { signature: 'sigP', userId: 1, token: 'SOL', payerWallet: W1, amountAtomic: '9', paidAt: t0 }));
    assert.equal(claim.ok, true);
    const rec = await getOn(conn, `SELECT applied_at FROM ecosystem_receipts WHERE signature='sigP'`);
    assert.equal(rec.applied_at, null, 'premium is pending until the NFT entitlement applies');
    const mark = await svc.markPremiumApplied('sigP');
    assert.equal(mark.ok, true);
    const rec2 = await getOn(conn, `SELECT applied_at FROM ecosystem_receipts WHERE signature='sigP'`);
    assert.equal(Number(rec2.applied_at), t0);
    await closeDb(conn);
});

test('C: legacy premium import carries entitlement_applied_at, NULL when unapplied', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at,entitlement_applied_at) VALUES (1,'sigPremLegacy',0,'premium',?,?,NULL)`, [t0 - 1000, t0 - 500]);
    await svc.initialize();
    const rec = await getOn(conn, `SELECT applied_at,verified_at FROM ecosystem_receipts WHERE signature='sigPremLegacy'`);
    assert.equal(rec.applied_at, null, 'unapplied legacy premium stays pending');
    assert.equal(Number(rec.verified_at), t0 - 500);
    await closeDb(conn);
});

test('D: orphan baseline benefits attach on first ensure; late-joining paid users keep access', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    const tPlan = t0 + 10 * DAY_MS;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c'),(2,'z@z.z')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at)
        VALUES (1,400,'active',?,'solana',?,?),(2,1000,'active',?,'ecosystem',?,?)`,
        [tPlan, t0 - DAY_MS, t0, tPlan, t0 - DAY_MS, t0]);
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at)
        VALUES (1,'sigO400',400,'monthly',?,?),(2,'sigO1000',1000,'monthly',?,?)`, [t0 - DAY_MS, t0 - DAY_MS, t0 - DAY_MS, t0 - DAY_MS]);
    await svc.initialize();
    const acct1 = await svc.ensureAccount('photolynk', '1', {});
    const r1 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r1.entitlement.planGb, 400);
    assert.ok(Number(r1.entitlement.expiresAt) >= tPlan, 'the pre-existing paid plan survives joining');
    assert.equal(r1.sharedUntil > 0, true, 'qualifying ledger seeds the shared floor on attach');
    const acct2 = await svc.ensureAccount('photolynk', '2', {});
    const r2 = await svc.resolveIdentity('photolynk', '2', { at: t0 });
    assert.equal(r2.entitlement.planGb, 1000);
    const plan = await getOn(conn, `SELECT status, plan_gb FROM user_plans WHERE user_id = 1`);
    assert.equal(plan.status, 'active');
    assert.equal(Number(plan.plan_gb), 400);
    await closeDb(conn);
});

test('E: zero/null/negative shared rows and grace/null plans never grant unbounded access', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c'),(2,'z@z.z'),(3,'q@q.q'),(4,'m@m.m')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,updated_at)
        VALUES (1,400,'active',NULL,?),(2,200,'grace',NULL,?),(3,0,'active',0,?),(4,400,'active','not-a-date',?)`, [t0, t0, t0, t0]);
    await runOn(conn, `INSERT INTO stealthlynk_subs (account_id,sub_until,source_kind,updated_at)
        VALUES ('acctZ',0,'payment',?),('acctN',NULL,'payment',?),('acctNeg',-5,'payment',?)`, [t0, t0, t0]);
    await svc.initialize();
    await svc.ensureAccount('photolynk', '1', {});
    await svc.ensureAccount('photolynk', '2', {});
    await svc.ensureAccount('photolynk', '3', {});
    await svc.ensureAccount('photolynk', '4', {});
    const r1 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r1.entitlement.expiresAt, null, 'legitimate active-null PL keeps the trusted unbounded plan');
    const rz = await svc.resolveAccount('acctZ', { at: t0 });
    assert.equal(rz.sharedUntil, 0, 'zero sub_until is not forever');
    const rn = await svc.resolveAccount('acctN', { at: t0 });
    assert.equal(rn.sharedUntil, 0, 'null sub_until is not forever');
    const rneg = await svc.resolveAccount('acctNeg', { at: t0 });
    assert.equal(rneg.sharedUntil, 0, 'negative sub_until is not forever');
    const rg = await svc.resolveIdentity('photolynk', '2', { at: t0 });
    assert.equal(rg.entitlement.active, false, 'grace with null expiry grants nothing');
    const r3 = await svc.resolveIdentity('photolynk', '3', { at: t0 });
    assert.equal(r3.entitlement.active, false, 'active with zero expiry and zero tier grants nothing');
    const r4 = await svc.resolveIdentity('photolynk', '4', { at: t0 });
    assert.equal(r4.entitlement.active, false, 'a malformed expiry never becomes an unbounded grant');
    await closeDb(conn);
});

test('E: PS ad_until seeds a local ad benefit through initialization', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash,ad_until) VALUES (?,?)`, [DEV1, t0 + WEEK_MS]);
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctAd',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES ('acctAd','paceseeker',?,?)`, [DEV1, t0]);
    await svc.initialize();
    const res = await svc.resolveAccount('acctAd', { at: t0 });
    assert.equal(res.apps.paceseeker.active, true, 'a stored ad_until preserves the earned week');
    assert.equal(Number(res.apps.paceseeker.expiresAt), t0 + WEEK_MS);
    const ev = await getOn(conn, `SELECT source_kind FROM ecosystem_events WHERE event_id='legacy:psad:${DEV1}'`);
    assert.equal(ev.source_kind, 'ad_claim', 'the ad seed is never counted as paid');
    await closeDb(conn);
});

test('F: recreated PS device row and externally overwritten compat rows are repaired', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash,sub_until) VALUES (?,0)`, [DEV1]);
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigFix', paidAt: t0 }), { deviceHash: DEV1 });
    await runOn(conn, `DELETE FROM paceseeker_devices WHERE device_hash = ?`, [DEV1]);
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash,sub_until) VALUES (?,0)`, [DEV1]);
    await svc.resolveAccount(acct, { at: t0, project: true });
    const dev = await getOn(conn, `SELECT sub_until FROM paceseeker_devices WHERE device_hash=?`, [DEV1]);
    assert.equal(Number(dev.sub_until), t0 + 30 * DAY_MS, 'a recreated device row is repaired');
    await runOn(conn, `UPDATE paceseeker_devices SET sub_until = 1 WHERE device_hash = ?`, [DEV1]);
    await svc.resolveAccount(acct, { at: t0, project: true });
    const dev2 = await getOn(conn, `SELECT sub_until FROM paceseeker_devices WHERE device_hash=?`, [DEV1]);
    assert.equal(Number(dev2.sub_until), t0 + 30 * DAY_MS, 'an externally overwritten sub_until is repaired');
    const subs = await getOn(conn, `SELECT * FROM stealthlynk_subs WHERE account_id=?`, [acct]);
    assert.ok(subs, 'compatibility shared row is projected');
    assert.equal(Number(subs.sub_until), t0 + 30 * DAY_MS);
    await closeDb(conn);
});

test('F: two same-app PL identities resolve independently; no-source trial untouched', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c'),(2,'z@z.z')`);
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctDuo',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at)
        VALUES ('acctDuo','photolynk','1',?),('acctDuo','photolynk','2',?)`, [t0, t0]);
    await runOn(conn, `INSERT INTO ecosystem_events (event_id,account_id,source_kind,source_app,source_ref,policy_version,created_at)
        VALUES ('ev1','acctDuo','payment','photolynk','sigX',2,?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_benefits (event_id,account_id,app,identity,benefit,starts_at,expires_at,tier_gb,scope)
        VALUES ('ev1','acctDuo','photolynk','1','storage',?,?,400,'local')`, [t0, t0 + 30 * DAY_MS]);
    await runOn(conn, `INSERT INTO user_plans (user_id,status,trial_until,updated_at) VALUES (2,'trial',?,?)`, [t0 + DAY_MS, t0]);
    const res = await svc.resolveAccount('acctDuo', { at: t0, project: true });
    const m1 = res.members.find((m) => m.app === 'photolynk' && m.identity === '1');
    const m2 = res.members.find((m) => m.app === 'photolynk' && m.identity === '2');
    assert.equal(m1.planGb, 400);
    assert.equal(m2.planGb, 0, "identity2 never inherits identity1's plan");
    assert.equal(res.apps.photolynk, undefined, 'ambiguous same-app members only surface in members[]');
    const r1 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r1.entitlement.planGb, 400);
    const r2 = await svc.resolveIdentity('photolynk', '2', { at: t0 });
    assert.equal(r2.entitlement.planGb, 0);
    const trial = await getOn(conn, `SELECT status FROM user_plans WHERE user_id = 2`);
    assert.equal(trial.status, 'trial', 'an untouched trial row is not rewritten');
    await closeDb(conn);
});

test('G: admin extend grants on an empty account; set-until is exact; shared_local 1000 is not resurrected', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,updated_at)
        VALUES (1,1000,'active',?,'ecosystem',?)`, [t0 - DAY_MS, t0]);
    await svc.initialize();
    const acct = await svc.ensureAccount('paceseeker', DEV1, {});
    const ex = await svc.adjustShared(acct, { action: 'extend', days: 7, eventId: 'adm:e', actor: 'admin' });
    assert.equal(ex.sharedUntil, t0 + 7 * DAY_MS, 'extend grants 7d on an empty account');
    const su = await svc.adjustShared(acct, { action: 'set-until', until: t0 + 3 * DAY_MS, eventId: 'adm:s', actor: 'admin' });
    assert.equal(su.sharedUntil, t0 + 3 * DAY_MS, 'set-until is exact');
    const acct2 = await svc.ensureAccount('photolynk', '1', {});
    const svcDb = await getOn(conn, `SELECT expires_at FROM ecosystem_benefits WHERE app='photolynk' AND identity='1'`);
    assert.ok(Number(svcDb.expires_at) < t0, 'expired shared_local stays expired');
    const r2 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r2.entitlement.active, false, 'expired shared_local does not resurrect');
    const ex2 = await svc.adjustShared(acct2, { action: 'extend', days: 10, eventId: 'adm:e2', actor: 'admin' });
    const r3 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r3.entitlement.planGb, 400, 'extend yields the shared 400 tier, never the dead 1000');
    assert.equal(Number(r3.entitlement.expiresAt), t0 + 10 * DAY_MS);
    await closeDb(conn);
});

test('G: source revoke survives merge; target revoke does not wipe unrelated source grant', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acctS = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'bs' });
    const acctT = await svc.ensureAccount('photolynk', '1', {});
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigS', paidAt: t0 }), { deviceHash: DEV1 });
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 400, signature: 'sigT', paidAt: t0 })));
    await svc.adjustShared(acctS, { action: 'revoke', eventId: 'adm:rs', actor: 'admin' });
    await svc.mergeAccounts(acctT, acctS);
    let res = await svc.resolveAccount(acctT, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, "source's revoke does not wipe target's grant");
    res = await svc.resolveAccount(acctS, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'source resolves to canonical target');
    res = await svc.resolveIdentity('paceseeker', DEV1, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'merged account sees the surviving target grant');
    await closeDb(conn);
});

test('G: alias chains flatten transitively', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const a = await svc.ensureAccount('paceseeker', DEV1, {});
    const b = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctC',?)`, [t0]);
    await svc.mergeAccounts(b, a);
    await svc.mergeAccounts('acctC', b);
    const r = await svc.resolveAccount(a, { at: t0 });
    assert.equal(r.accountId, 'acctC', 'A resolves through B to C');
    const aliases = await allOn(conn, `SELECT * FROM ecosystem_aliases`);
    const aRow = aliases.find((x) => x.alias_id === a);
    const bRow = aliases.find((x) => x.alias_id === b);
    assert.equal(aRow.account_id, 'acctC');
    assert.equal(bRow.account_id, 'acctC');
    await closeDb(conn);
});

test('H: revisions are globally monotonic; read-only resolves never bump or write', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    const a = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    const b = await svc.ensureAccount('paceseeker', DEV2, { wallet: W2, proofKind: 'bind', proofRef: 'b2' });
    const ra = (await getOn(conn, `SELECT revision FROM ecosystem_revisions WHERE account_id=?`, [a])).revision;
    const rb = (await getOn(conn, `SELECT revision FROM ecosystem_revisions WHERE account_id=?`, [b])).revision;
    assert.ok(rb > ra, 'second account creation has a higher global revision');
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigRev', paidAt: t0 }), { deviceHash: DEV1 });
    const ra2 = (await getOn(conn, `SELECT revision FROM ecosystem_revisions WHERE account_id=?`, [a])).revision;
    assert.ok(ra2 > rb, 'payment bumps revision past the other account');
    const before = await getOn(conn, `SELECT value FROM ecosystem_meta WHERE key='global_revision'`);
    const rows = (await allOn(conn, `SELECT * FROM ecosystem_projection_state`)).length;
    await svc.resolveAccount(a, { at: t0, project: false });
    await svc.resolveIdentity('paceseeker', DEV1, { at: t0, project: false });
    const after = await getOn(conn, `SELECT value FROM ecosystem_meta WHERE key='global_revision'`);
    assert.equal(Number(after.value), Number(before.value), 'read-only resolution never bumps the global revision');
    assert.equal((await allOn(conn, `SELECT * FROM ecosystem_projection_state`)).length, rows, 'reads create no rows');
    await closeDb(conn);
});

test('I: same-app collision keeps the valid proof and records identity_conflict', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const b = await svc.ensureAccount('paceseeker', DEV2, { wallet: W1, proofKind: 'bind', proofRef: 'x' });
    const a = await svc.ensureAccount('paceseeker', DEV1, {});
    const own = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'y' });
    assert.equal(own, a, 'the valid proof stays with the source account');
    const proof = await getOn(conn, `SELECT wallet FROM ecosystem_member_proofs WHERE app='paceseeker' AND identity=?`, [DEV1]);
    assert.equal(proof.wallet, W1, 'the proven wallet is persisted');
    const ev = await getOn(conn, `SELECT * FROM ecosystem_events WHERE source_kind='identity_conflict' AND account_id=?`, [a]);
    assert.ok(ev, 'a deterministic identity_conflict event is recorded');
    const payload = JSON.parse(ev.payload_json);
    assert.equal(payload.code, 'APP_ALREADY_LINKED');
    const res = await svc.resolveIdentity('paceseeker', DEV1, { at: clock.t, project: false });
    assert.equal(res.linkConflict.code, 'APP_ALREADY_LINKED');
    assert.equal(res.linkConflict.candidates.includes(b), true);
    const pay = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigOwn', payerWallet: W1, paidAt: clock.t }), { deviceHash: DEV1 });
    assert.equal(pay.accountId, a, 'the proven device still pays its own account');
    await closeDb(conn);
});

test('I: multi-holder wallet keeps own proof, no merge, marks AMBIGUOUS_WALLET', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctP',?),('acctQ',?)`, [clock.t, clock.t]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at)
        VALUES ('acctP','paceseeker',?,?,1,?),('acctQ','paceseeker',?,?,1,?)`, [DEV1, W1, clock.t, DEV2, W1, clock.t]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at)
        VALUES ('paceseeker',?,?,?,?),('paceseeker',?,?,?,?)`, [DEV1, W1, 'bind', clock.t, DEV2, W1, 'bind', clock.t]);
    const DEV3 = 'dev_' + 'c'.repeat(20);
    const own = await svc.ensureAccount('paceseeker', DEV3, { wallet: W1, proofKind: 'bind', proofRef: 'z' });
    const p = await getOn(conn, `SELECT * FROM ecosystem_member_proofs WHERE app='paceseeker' AND identity=? AND wallet=?`, [DEV3, W1]);
    assert.ok(p, 'own proof persisted despite ambiguity');
    const res = await svc.resolveIdentity('paceseeker', DEV3, { project: false });
    assert.equal(res.linkConflict.code, 'AMBIGUOUS_WALLET');
    const scan = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigAmb2', payerWallet: W1 }), {});
    assert.equal(scan.code, 'AMBIGUOUS_WALLET', 'scanner still refuses an ambiguous wallet');
    const own2 = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigAmb3', payerWallet: W1, paidAt: clock.t }), { deviceHash: DEV3 });
    assert.equal(own2.accountId, own, 'explicit device pays its own account');
    await closeDb(conn);
});

test('J: out-of-order receipts fold deterministically', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigLate', paidAt: t0 + 60 * DAY_MS }), { deviceHash: DEV1 });
    let res = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 90 * DAY_MS, 'one 30d receipt from day60 ends day90');
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigEarly', paidAt: t0 }), { deviceHash: DEV1 });
    res = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 90 * DAY_MS, 'the earlier receipt fills the gap: day0+day60 = 90 not 120');
    await closeDb(conn);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-'));
    createdDirs.push(dir);
    const f2 = path.join(dir, 't.db');
    const c2 = await openDb(f2);
    for (const ddl of FIXTURE_DDL) await runOn(c2, ddl);
    const c = { t: t0 };
    const s2 = createEcosystemService({ sqlite3, dbPath: f2, now: () => c.t });
    await s2.initialize();
    await s2.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await s2.applyPaceSeekerPayment(psReceipt({ signature: 'sigEarly', paidAt: t0 }), { deviceHash: DEV1 });
    await s2.applyPaceSeekerPayment(psReceipt({ signature: 'sigLate', paidAt: t0 + 60 * DAY_MS }), { deviceHash: DEV1 });
    const r2 = await s2.resolveIdentity('paceseeker', DEV1, { at: t0 });
    assert.equal(r2.sharedUntil, t0 + 90 * DAY_MS, 'in-order arrival yields the same end');
    await closeDb(c2);
});

test('J: contiguous day0/day10 receipts end day60; merged 30d lineages give 30 then 60', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigA', paidAt: t0 }), { deviceHash: DEV1 });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigB', paidAt: t0 + 10 * DAY_MS }), { deviceHash: DEV1 });
    let res = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 60 * DAY_MS, 'contiguous receipts stack to 60d');
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acctX = await svc.ensureAccount('photolynk', '1', {});
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 400, signature: 'sigX', paidAt: t0 })));
    res = await svc.resolveAccount(acctX, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS);
    const DEV3 = 'dev_' + 'c'.repeat(20);
    const acctY = await svc.ensureAccount('paceseeker', DEV3, { wallet: 'WY', proofKind: 'bind', proofRef: 'b3' });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigY', paidAt: t0, payerWallet: 'WY' }), { deviceHash: DEV3 });
    const merged = await svc.mergeAccounts(acctX, acctY);
    res = await svc.resolveAccount(acctX, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'two independent 30d lineages merge to 30, never 60');
    const DEV4 = 'dev_' + 'd'.repeat(20);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,?,?,?,1,?)`, [acctX, 'paceseeker', DEV4, W2, t0]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at) VALUES (?,?,?,?,?)`, ['paceseeker', DEV4, W2, 'bind', t0]);
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPost', paidAt: t0 + 30 * DAY_MS, payerWallet: W2 }), { deviceHash: DEV4 });
    res = await svc.resolveAccount(acctX, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 60 * DAY_MS, 'a post-merge payment stacks on the merged end');
    await closeDb(conn);
});

test('K: legacy checked receipt imports as unverified placeholder; reverify repairs exactly one term', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    const future = t0 + 400 * 365 * DAY_MS;
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctL',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES ('acctL','paceseeker',?,?,1,?)`, [DEV1, W1, t0]);
    await runOn(conn, `INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,reported_at,eco_verified) VALUES ('sigWin',?,?,?,1)`, [DEV1, future, t0]);
    await svc.initialize();
    const rec = await getOn(conn, `SELECT * FROM ecosystem_receipts WHERE signature='sigWin'`);
    assert.equal(Number(rec.paid_at), 0, 'client-reported dates never fold — placeholder');
    assert.equal(rec.verified_at, null);
    assert.equal(rec.applied_at, null);
    let res = await svc.resolveAccount('acctL', { at: t0 });
    assert.equal(res.sharedUntil, 0, 'a year-3000 client paid_at cannot extend anything');
    const r = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigWin', paidAt: t0, verifiedAt: t0 }), { deviceHash: DEV1 });
    assert.equal(r.alreadyApplied, true);
    const rec2 = await getOn(conn, `SELECT * FROM ecosystem_receipts WHERE signature='sigWin'`);
    assert.equal(Number(rec2.paid_at), t0, 'trusted re-verification fills the placeholder');
    assert.equal(Number(rec2.verified_at), t0);
    res = await svc.resolveAccount('acctL', { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'repair yields exactly one term, no append');
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigWin', paidAt: t0, verifiedAt: t0 }), { deviceHash: DEV1 });
    res = await svc.resolveAccount('acctL', { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'replay never doubles the floor');
    await closeDb(conn);
});

test('K: preserved shared baseline is not re-extended by the same legacy receipt', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctB',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES ('acctB','paceseeker',?,?,1,?)`, [DEV1, W1, t0]);
    await runOn(conn, `INSERT INTO stealthlynk_subs (account_id,sub_until,source_app,source_kind,updated_at) VALUES ('acctB',?,'paceseeker','payment',?)`, [t0 + 30 * DAY_MS, t0]);
    await runOn(conn, `INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,reported_at,eco_verified) VALUES ('sigBase',?,?,?,1)`, [DEV1, t0, t0]);
    await svc.initialize();
    let res = await svc.resolveAccount('acctB', { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'preserved snapshot stands alone before re-verification');
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigBase', paidAt: t0, verifiedAt: t0 }), { deviceHash: DEV1 });
    res = await svc.resolveAccount('acctB', { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS, 'the same verified receipt never adds a second term over the snapshot');
    await closeDb(conn);
});

test('K: two re-verified legacy receipts renew to 60 not 90', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctL2',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES ('acctL2','paceseeker',?,?,1,?)`, [DEV1, W1, t0]);
    await runOn(conn, `INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,reported_at,eco_verified)
        VALUES ('sigL1',?,?,?,1),('sigL2',?,?,?,1)`, [DEV1, t0, t0, DEV1, t0 + 30 * DAY_MS, t0 + 30 * DAY_MS]);
    await svc.initialize();
    let res = await svc.resolveAccount('acctL2', { at: t0 });
    assert.equal(res.sharedUntil, 0, 'unverified telemetry grants nothing before re-verification');
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigL1', paidAt: t0, verifiedAt: t0 }), { deviceHash: DEV1 });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigL2', paidAt: t0 + 30 * DAY_MS, verifiedAt: t0 + 30 * DAY_MS }), { deviceHash: DEV1 });
    res = await svc.resolveAccount('acctL2', { at: t0 });
    assert.equal(res.sharedUntil, t0 + 60 * DAY_MS, 'two contiguous verified legacy receipts fold to 60');
    await closeDb(conn);
});

test('1: the shared floor seeds once — later v2 ledger/credit rows never reseed', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at)
        VALUES (1,400,'active',?,'solana',?,?)`, [t0 + 10 * DAY_MS, t0 - DAY_MS, t0]);
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at)
        VALUES (1,'sigO400',400,'monthly',?,?)`, [t0 - DAY_MS, t0 - DAY_MS]);
    await svc.initialize();
    const acct = await svc.ensureAccount('photolynk', '1', {});
    const r0 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    const exp0 = Number(r0.entitlement.expiresAt);
    const rev0 = r0.revision;
    const sh0 = r0.sharedUntil;
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at)
        VALUES (1,'sigV2new',1000,'yearly',?,?)`, [clock.t, clock.t]);
    await runOn(conn, `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,created_at)
        VALUES ('sigV2new',1,'x',?,NULL,?,?)`, [clock.t, clock.t + 999 * DAY_MS, clock.t]);
    for (let i = 0; i < 5; i++) {
        await svc.ensureAccount('photolynk', '1', {});
        await svc.resolveIdentity('photolynk', '1', { at: t0, project: false });
        await svc.resolveAccount(acct, { at: t0, project: true });
    }
    const r1 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r1.sharedUntil, sh0, 'shared floor is frozen after the one-shot seed');
    assert.equal(Number(r1.entitlement.expiresAt), exp0, 'expiry stops drifting');
    assert.equal(r1.revision, rev0, 'revision is stable across repeated ensure/resolve');
    await closeDb(conn);
});

test('3: local fold seeds from the fixed legacy paid snapshot — renewals stack on remaining days', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at)
        VALUES (1,1000,'active',?,'solana',?,?)`, [t0 + 10 * DAY_MS, t0 - 20 * DAY_MS, t0]);
    await svc.initialize();
    await svc.ensureAccount('photolynk', '1', {});
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigRenew', tierGb: 1000, paidAt: t0 })));
    const r = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r.entitlement.planGb, 1000);
    assert.equal(Number(r.entitlement.expiresAt), t0 + 40 * DAY_MS, '10 paid days left + 30d renewal');
    await closeDb(conn);
});

test('3: low tier after legacy 1000 gets its own duration; PS renewal never extends the 1000', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at)
        VALUES (1,1000,'active',?,'solana',?,?)`, [t0 + 10 * DAY_MS, t0 - 20 * DAY_MS, t0]);
    await svc.initialize();
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,?,?,?,1,?)`, [acct, 'paceseeker', DEV1, W1, t0]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at) VALUES (?,?,?,?,?)`, ['paceseeker', DEV1, W1, 'bind', t0]);
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPs3', paidAt: t0 }), { deviceHash: DEV1 });
    const r1 = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(r1.entitlement.planGb, 1000);
    assert.equal(Number(r1.entitlement.expiresAt), t0 + 10 * DAY_MS, 'a PS payment never extends the local 1000 term');
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigLow', tierGb: 100, paidAt: t0 })));
    const benLow = await getOn(conn, `SELECT expires_at, tier_gb FROM ecosystem_benefits WHERE event_id='rcpt:sigLow' AND app='photolynk'`);
    assert.equal(Number(benLow.tier_gb), 100);
    assert.equal(Number(benLow.expires_at), t0 + 40 * DAY_MS, 'the lower term stacks past the legacy paid end');
    const benLeg = await getOn(conn, `SELECT expires_at, tier_gb FROM ecosystem_benefits WHERE event_id='legacy:pl:1' AND app='photolynk'`);
    assert.equal(Number(benLeg.tier_gb), 1000);
    assert.equal(Number(benLeg.expires_at), t0 + 10 * DAY_MS, 'the legacy 1000 term is never extended');
    await closeDb(conn);
});

test('4: revoke on a merged target cannot be bypassed by a parent timeline row', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const a = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    const b = await svc.ensureAccount('photolynk', '1', {});
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigPa', paidAt: t0 }), { deviceHash: DEV1 });
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ tierGb: 400, signature: 'sigPb', paidAt: t0 })));
    await svc.mergeAccounts(a, b);
    let res = await svc.resolveAccount(a, { at: t0 });
    assert.equal(res.sharedUntil, t0 + 30 * DAY_MS);
    await svc.adjustShared(a, { action: 'revoke', eventId: 'adm:rv', actor: 'admin' });
    res = await svc.resolveAccount(a, { at: t0 });
    assert.equal(res.sharedUntil, 0, 'revoke caps the merged lineage — parent timeline rows never leak');
    const leaked = res.sources.filter((s) => s.scope === 'shared' && (s.expiresAt == null || Number(s.expiresAt) > t0));
    assert.equal(leaked.length, 0, 'no parent shared row stays active');
    const rpl = await svc.resolveIdentity('photolynk', '1', { at: t0 });
    assert.equal(rpl.entitlement.planGb, 400, 'independent direct paid time still survives the revoke');
    await closeDb(conn);
});

test('5: epoch edges avoid full timeline scans; unknown old shape refuses without dropping', async () => {
    const { conn, clock, file } = await (async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-'));
        createdDirs.push(dir);
        const file = path.join(dir, 'test.db');
        const conn = await openDb(file);
        for (const ddl of FIXTURE_DDL) await runOn(conn, ddl);
        return { conn, clock: { t: Date.now() }, file, dir };
    })();
    const queries = [];
    const recording = {
        Database: class extends sqlite3.Database {
            all(sql, p, cb) { queries.push(String(sql)); return super.all(sql, p, cb); }
            get(sql, p, cb) { queries.push(String(sql)); return super.get(sql, p, cb); }
            run(sql, p, cb) { queries.push(String(sql)); return super.run(sql, p, cb); }
        },
    };
    const svc = createEcosystemService({ sqlite3: recording, dbPath: file, now: () => clock.t });
    await svc.initialize();
    const t0 = clock.t;
    const a = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    const b = await svc.ensureAccount('paceseeker', DEV2, { wallet: W2, proofKind: 'bind', proofRef: 'b2' });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigE1', paidAt: t0 }), { deviceHash: DEV1 });
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigE2', paidAt: t0, payerWallet: W2 }), { deviceHash: DEV2 });
    queries.length = 0;
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigE3', paidAt: t0 }), { deviceHash: DEV1 });
    const wholeScans = queries.filter((q) => /FROM\s+ecosystem_timelines\b/i.test(q) && !/WHERE/i.test(q));
    assert.equal(wholeScans.length, 0, 'refold must use the parent-edge index, not a whole-table scan');
    const dup = await getOn(conn, `SELECT COUNT(*) AS n FROM ecosystem_timeline_parents`);
    assert.ok(dup && Number(dup.n) >= 0);
    await closeDb(conn);

    const { conn: conn2, clock: clock2, file: file2 } = await (async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-old-'));
        createdDirs.push(dir);
        const file = path.join(dir, 'old.db');
        const conn = await openDb(file);
        for (const ddl of FIXTURE_DDL) await runOn(conn, ddl);
        return { conn, clock: { t: Date.now() }, file, dir };
    })();
    await runOn(conn2, `CREATE TABLE ecosystem_timelines (account_id TEXT PRIMARY KEY, base_at INTEGER, parents TEXT, end_at INTEGER, updated_at INTEGER)`);
    await runOn(conn2, `INSERT INTO ecosystem_timelines VALUES ('sentinel',5,'[]',7,?)`, [clock2.t]);
    const svc2 = createEcosystemService({ sqlite3, dbPath: file2, now: () => clock2.t });
    await assert.rejects(svc2.initialize(), (e) => e.code === 'SCHEMA_VERSION_UNSUPPORTED');
    const row = await getOn(conn2, `SELECT * FROM ecosystem_timelines WHERE account_id='sentinel'`);
    assert.equal(Number(row.base_at), 5, 'unknown schema shapes are preserved, never dropped');
    await closeDb(conn2);
});

test('6: scanner is ambiguous when one account holds two proven same-app members', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctD',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at)
        VALUES ('acctD','paceseeker',?,?,1,?),('acctD','paceseeker',?,?,1,?)`, [DEV1, W1, t0, DEV2, W1, t0]);
    await runOn(conn, `INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,verified_at)
        VALUES ('paceseeker',?,?,?,?),('paceseeker',?,?,?,?)`, [DEV1, W1, 'bind', t0, DEV2, W1, 'bind', t0]);
    const r = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigDuo', payerWallet: W1, paidAt: t0 }), {});
    assert.equal(r.code, 'AMBIGUOUS_WALLET');
    const own = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigDuo2', payerWallet: W1, paidAt: t0 }), { deviceHash: DEV1 });
    assert.equal(own.accountId, 'acctD', 'explicit device attribution still works');
    await closeDb(conn);
});

test('6: collision checks cover members retained on aliased sources', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const a = await svc.ensureAccount('paceseeker', DEV1, {});
    const c = await svc.ensureAccount('photolynk', '1', {});
    await svc.mergeAccounts(c, a);
    const b = await svc.ensureAccount('paceseeker', DEV2, {});
    await assert.rejects(svc.mergeAccounts(c, b),
        (e) => e.code === 'APP_ALREADY_LINKED', 'the aliased PS member on the target lineage still collides');
    const res = await svc.resolveAccount(b, { at: t0 });
    assert.equal(res.accountId, b, 'source account retained on collision');
    await closeDb(conn);
});

test('7: registry app value policy — <=399 supported, higher rejected explicitly', async () => {
    const registry = JSON.parse(JSON.stringify(require('./ecosystemEntitlements').DEFAULT_REGISTRY));
    registry.apps.appLo = { monthlyValueCents: 199, benefit: 'features' };
    registry.apps.appHi = { monthlyValueCents: 499, benefit: 'features' };
    const { svc, conn, clock } = await mk({ registry });
    await svc.initialize();
    const t0 = clock.t;
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'p' });
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,?,?,?)`, [acct, 'appLo', 'lo-1', t0]);
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigV', paidAt: t0 }), { deviceHash: DEV1 });
    const res = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res.apps.appLo.active, true, 'a lower-priced registered app shares the grant');
    await assert.rejects(svc.ensureAccount('appHi', 'hi-1'), (e) => e.code === 'APP_VALUE_UNSUPPORTED');
    const res2 = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res2.apps.appHi, undefined, 'unsupported app never resolves active');
    await closeDb(conn);
});

test('8: payer required, SKR needs mint, premium re-mark is a no-op, missing quote conflicts', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await assert.rejects(svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigNp', payerWallet: null }))),
        (e) => e.code === 'PAYER_REQUIRED');
    await assert.rejects(svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigNm', token: 'SKR' }))),
        (e) => e.code === 'MINT_REQUIRED');
    // The quotes table is owned by ecosystemPayments; seed a live quote so the
    // receipt below actually records quote_id 'q-1'.
    await runOn(conn, `CREATE TABLE IF NOT EXISTS ecosystem_payment_quotes (quote_id TEXT PRIMARY KEY,app TEXT NOT NULL,identity TEXT NOT NULL,product_id TEXT NOT NULL,duration TEXT NOT NULL,token TEXT NOT NULL,payer_wallet TEXT,amount_atomic TEXT NOT NULL,usd_cents INTEGER NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL,promo_code TEXT,used_signature TEXT)`);
    await runOn(conn, `INSERT INTO ecosystem_payment_quotes (quote_id,app,identity,product_id,duration,token,payer_wallet,amount_atomic,usd_cents,issued_at,expires_at,payload,signature)
        VALUES ('q-1','photolynk','1','photolynk.storage_400','monthly','SOL',?,'10000000',1000,?,?,'{}','k')`, [W1, t0 - 1000, t0 + 300000]);
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigQ', paidAt: t0, quoteId: 'q-1' })));
    const noQuote = await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigQ', paidAt: t0 })));
    assert.equal(noQuote.code, 'PAYMENT_CONFLICT', 'a recorded quote cannot silently disappear');
    const claim = await svc.transaction((tx) => svc.claimPremiumInTransaction(tx, { signature: 'sigPr', userId: 1, token: 'SOL', payerWallet: W1, amountAtomic: '9', paidAt: t0 }));
    assert.equal(claim.ok, true);
    const rev0 = (await svc.resolveIdentity('photolynk', '1', { at: t0, project: false })).revision;
    const m1 = await svc.markPremiumApplied('sigPr');
    assert.equal(m1.applied, true);
    const m2 = await svc.markPremiumApplied('sigPr');
    assert.equal(m2.applied, true);
    assert.equal(m2.alreadyApplied, true, 'a repeated mark is a no-op');
    const rev1 = (await svc.resolveIdentity('photolynk', '1', { at: t0, project: false })).revision;
    assert.equal(rev1, rev0 + 1, 'only the first mark bumps the revision');
    const dup = await svc.transaction((tx) => svc.claimPremiumInTransaction(tx, { signature: 'sigPr', userId: 1, token: 'SOL', payerWallet: W1, amountAtomic: '9', paidAt: t0 }));
    assert.equal(dup.applied, true, 'duplicate response exposes the applied flag');
    await closeDb(conn);
});

test('8: projection repairs payment_type even when tier and expiry match', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES (?,3,'verified','photolynk',100,?)`, [acct, t0]);
    const claim = await getOn(conn, `SELECT id FROM ad_claims WHERE account_id=?`, [acct]);
    await svc.grantAdClaim(claim.id);
    await runOn(conn, `UPDATE user_plans SET payment_type='solana' WHERE user_id=1`);
    await svc.resolveIdentity('photolynk', '1', { at: t0, project: true });
    const plan = await getOn(conn, `SELECT payment_type FROM user_plans WHERE user_id=1`);
    assert.equal(plan.payment_type, 'ad_claim', 'projection repairs the wrong source label');
    await closeDb(conn);
});

test('9: granted sibling across aliases dedupes the week; rejected claims refused; ad allowed once shared reactivates', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const a = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    const b = await svc.ensureAccount('photolynk', '1', {});
    await svc.mergeAccounts(a, b);
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at,granted_at) VALUES (?,7,'verified','photolynk',100,?,?)`, [b, t0, t0]);
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES (?,7,'verified','paceseeker',100,?)`, [a, t0]);
    const claim7 = await getOn(conn, `SELECT id FROM ad_claims WHERE account_id=?`, [a]);
    const g7 = await svc.grantAdClaim(claim7.id);
    assert.equal(g7.alreadyGranted, true, 'a granted sibling on the aliased account dedupes the week');
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES (?,8,'rejected','paceseeker',100,?)`, [a, t0]);
    const rej = await getOn(conn, `SELECT id FROM ad_claims WHERE week_key=8`);
    const g8 = await svc.grantAdClaim(rej.id);
    assert.equal(g8.granted, false, 'a rejected claim is never granted');
    await svc.adjustShared(a, { action: 'revoke', eventId: 'adm:rv2', actor: 'admin' });
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES (?,9,'verified','paceseeker',100,?)`, [a, t0]);
    const c9 = await getOn(conn, `SELECT id FROM ad_claims WHERE week_key=9`);
    const g9 = await svc.grantAdClaim(c9.id);
    assert.equal(g9.granted, false, 'a revoked account cannot claim ad time');
    assert.equal(g9.reason, 'revoked');
    await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigReUp', paidAt: t0 + 2000 }), { deviceHash: DEV1 });
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES (?,10,'verified','paceseeker',100,?)`, [a, t0]);
    const c10 = await getOn(conn, `SELECT id FROM ad_claims WHERE week_key=10`);
    const g10 = await svc.grantAdClaim(c10.id);
    assert.equal(g10.granted, true, 'a new qualifying payment re-enables ad grants');
    await closeDb(conn);
});

test('9: orphaned legacy PS ad_until attaches when the device joins later', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash,ad_until) VALUES (?,?)`, [DEV1, t0 + WEEK_MS]);
    await svc.initialize();
    const ben = await getOn(conn, `SELECT * FROM ecosystem_benefits WHERE app='paceseeker' AND identity=?`, [DEV1]);
    assert.ok(ben && ben.account_id === null, 'the orphan ad benefit is preserved unattached');
    await svc.ensureAccount('paceseeker', DEV1, {});
    const r = await svc.resolveIdentity('paceseeker', DEV1, { at: t0 });
    assert.equal(r.entitlement.active, true, 'the earned ad week survives a late join');
    assert.equal(Number(r.entitlement.expiresAt), t0 + WEEK_MS);
    await closeDb(conn);
});

test('10: identical heartbeat re-bind never bumps the revision', async () => {
    const { svc, conn } = await mk();
    await svc.initialize();
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    const r0 = await svc.resolveAccount(acct, { project: false });
    for (let i = 0; i < 3; i++) await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'b1' });
    const r1 = await svc.resolveAccount(acct, { project: false });
    assert.equal(r1.revision, r0.revision, 'identical re-proof is a no-op');
    await closeDb(conn);
});

test('L: prototype-name apps rejected; job lease/list validation; bind reschedules waiting jobs', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await assert.rejects(svc.ensureAccount('constructor', 'x'), (e) => e.code === 'APP_UNKNOWN');
    await assert.rejects(svc.ensureAccount('hasOwnProperty', 'x'), (e) => e.code === 'APP_UNKNOWN');
    const unv = await svc.applyPaceSeekerPayment(psReceipt({ signature: 'sigWait', payerWallet: W1 }), {});
    assert.equal(unv.code, 'PAYMENT_ACCOUNT_UNVERIFIED');
    const job = await getOn(conn, `SELECT * FROM ecosystem_jobs WHERE job_key='verify:solana:sigWait'`);
    assert.ok(job && job.state === 'pending');
    await runOn(conn, `UPDATE ecosystem_jobs SET next_attempt_at = ? WHERE job_key = ?`, [clock.t + 999999, job.job_key]);
    await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'wake' });
    const woken = await getOn(conn, `SELECT next_attempt_at,last_error_code FROM ecosystem_jobs WHERE job_key=?`, [job.job_key]);
    assert.equal(Number(woken.next_attempt_at), clock.t, 'a new proven bind reschedules the waiting job');
    await svc.finishJob({ job_key: 'verify:solana:done1' }, {}).catch(() => {});
    await assert.rejects(svc.leaseJobs({ limit: 10000 }), (e) => e.code === 'LIMIT_INVALID');
    await assert.rejects(svc.leaseJobs({ limit: -3 }), (e) => e.code === 'LIMIT_INVALID');
    await assert.rejects(svc.leaseJobs({ limit: NaN }), (e) => e.code === 'LIMIT_INVALID');
    await assert.rejects(svc.leaseJobs({ leaseMs: 0 }), (e) => e.code === 'LEASE_MS_INVALID');
    await closeDb(conn);
});

test('admin eventId: identical normalized edit is a no-op; an extension records a new correction', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    // Same derivation as the admin route: sha256 over the normalized RESULT,
    // never generated 'now' - retries of one edit share one event id.
    const adminEventId = (uid, gb, exp, status) =>
        'admin-plan:' + crypto.createHash('sha256').update(JSON.stringify([uid, gb, exp, status])).digest('hex').slice(0, 16);
    const edit = (eventId, expiresAt) => svc.transaction((tx) => svc.recordLocalPlanInTransaction(tx, {
        userId: 1, eventId, kind: 'admin', actor: 'admin',
        plan: { planGb: 400, status: 'active', startsAt: t0, expiresAt },
    }));
    const exp1 = t0 + 30 * DAY_MS;
    const evt1 = adminEventId(1, 400, exp1, 'active');
    assert.equal((await edit(evt1, exp1)).alreadyRecorded, false);
    assert.equal((await edit(evt1, exp1)).alreadyRecorded, true, 'retried identical edit replays as a no-op');
    assert.equal((await allOn(conn, `SELECT event_id FROM ecosystem_events WHERE event_id LIKE 'localplan:admin-plan:%'`)).length, 1);
    assert.equal((await getOn(conn, `SELECT COUNT(*) n FROM ecosystem_benefits`)).n, 1,
        'no second revoke/grant pair on a retry');
    const exp2 = t0 + 60 * DAY_MS;
    const evt2 = adminEventId(1, 400, exp2, 'active');
    assert.notEqual(evt2, evt1, 'an extension changes the normalized result');
    assert.equal((await edit(evt2, exp2)).alreadyRecorded, false);
    assert.equal((await allOn(conn, `SELECT event_id FROM ecosystem_events WHERE event_id LIKE 'localplan:admin-plan:%'`)).length, 2);
    const snap = await svc.resolveIdentity('photolynk', '1', { at: t0, project: false });
    assert.equal(Number(snap.entitlement.expiresAt), exp2, 'the newer correction wins');
    await closeDb(conn);
});

test('admin local-plan cutoff revokes pre-cutoff local benefits but never the shared grant', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const t0 = clock.t;
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    // A 400GB store purchase grants BOTH a local and a shared benefit.
    await svc.transaction((tx) => svc.recordLocalPlanInTransaction(tx, {
        userId: 1, eventId: 'store-rc1', kind: 'store',
        plan: { planGb: 400, startsAt: t0 - 5000, expiresAt: t0 + 30 * DAY_MS },
        sharedEligible: true,
    }));
    // Direct-plan correction to a smaller plan: revokes local/shared_local,
    // writes the cutoff, and leaves the shared grant independent.
    await svc.transaction((tx) => svc.recordLocalPlanInTransaction(tx, {
        userId: 1, eventId: 'admin-plan:corr1', kind: 'admin', actor: 'admin',
        plan: { planGb: 100, status: 'active', startsAt: t0, expiresAt: t0 + 10 * DAY_MS },
    }));
    const local = await getOn(conn, `SELECT revoked_at FROM ecosystem_benefits WHERE event_id = 'localplan:store-rc1' AND scope = 'local'`);
    const shared = await getOn(conn, `SELECT revoked_at FROM ecosystem_benefits WHERE event_id = 'localplan_shared:store-rc1' AND scope = 'shared'`);
    assert.ok(local.revoked_at != null, 'pre-cutoff local source revoked');
    assert.equal(shared.revoked_at, null, 'global shared grant survives the local correction');
    const meta = await getOn(conn, `SELECT value FROM ecosystem_meta WHERE key = 'local-plan-cutoff:photolynk:1'`);
    assert.ok(meta && JSON.parse(meta.value).eventId, 'cutoff marker recorded');
    // A payment dated before the cutoff arriving late: verified receipt kept,
    // but its local effect is revoked and it adds no local time.
    await svc.transaction((tx) => svc.applyPhotolynkInTransaction(tx, plPayment({ signature: 'sigLate', paidAt: t0 - 9000 })));
    const late = await getOn(conn, `SELECT revoked_at FROM ecosystem_benefits WHERE event_id = 'rcpt:sigLate' AND scope = 'local'`);
    assert.ok(late.revoked_at != null, 'late pre-cutoff receipt gains no local time');
    const snap = await svc.resolveIdentity('photolynk', '1', { at: t0, project: false });
    assert.ok(!snap.sources.some((s) => s.eventId === 'rcpt:sigLate'),
        'a revoked receipt contributes nothing active');
    assert.ok(snap.sources.some((s) => s.eventId === 'localplan_shared:store-rc1' && s.scope === 'shared'),
        'the shared grant remains an active source');
    // The effective expiry legitimately stays extended: the independent
    // shared grant still covers the member (admin UI must surface this).
    assert.equal(Number(snap.sharedUntil), t0 + 30 * DAY_MS, 'shared paid timeline untouched by the cutoff');
    await closeDb(conn);
});

test('baseline migration: ad-claim granted_at stamped only for frozen-covered claims', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-'));
    createdDirs.push(dir);
    const file = path.join(dir, 'test.db');
    const conn = await openDb(file);
    for (const ddl of FIXTURE_DDL) await runOn(conn, ddl);
    const clock = { t: Date.now() };
    const covered = clock.t - 10 * DAY_MS;   // claim filed while the ad grant was live
    const uncovered = clock.t - 1 * DAY_MS;  // claim filed after every entitlement ended
    // member + device whose ad_until covers `covered` but not `uncovered`
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity) VALUES ('acctA','paceseeker',?)`, [DEV1]);
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash, ad_until) VALUES (?,?)`, [DEV1, covered + 7 * DAY_MS]);
    // member whose shared ad_claim sub_until covers `covered`
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity) VALUES ('acctB','photolynk','9')`);
    await runOn(conn, `INSERT INTO stealthlynk_subs (account_id,sub_until,source_app,source_kind,updated_at) VALUES ('acctB',?,'photolynk','ad_claim',?)`, [covered + 7 * DAY_MS, covered]);
    await runOn(conn, `INSERT INTO ad_claims (account_id,week_key,status,app,tier_gb,created_at) VALUES
        ('acctA',1,'verified','paceseeker',100,?),
        ('acctA',2,'verified','paceseeker',100,?),
        ('acctB',1,'verified','photolynk',100,?),
        ('acctC',1,'verified','paceseeker',100,?)`,
        [covered, uncovered, covered, covered]);
    const svc = createEcosystemService({ sqlite3, dbPath: file, now: () => clock.t });
    await svc.initialize();
    const stamped = async (acct, wk) => (await getOn(conn, `SELECT granted_at FROM ad_claims WHERE account_id = ? AND week_key = ?`, [acct, wk])).granted_at;
    assert.equal(await stamped('acctA', 1), covered, 'device ad_until covers the claim -> stamped to created_at');
    assert.equal(await stamped('acctB', 1), covered, 'shared ad_claim sub_until covers the claim -> stamped');
    assert.equal(await stamped('acctA', 2), null, 'claim filed after the frozen entitlement stays pending');
    assert.equal(await stamped('acctC', 1), null, 'no covering member or subs row stays pending');
    // idempotent: a second initialize re-stamps nothing and loses nothing
    const svc2 = createEcosystemService({ sqlite3, dbPath: file, now: () => clock.t });
    await svc2.initialize();
    assert.equal(await stamped('acctA', 1), covered);
    assert.equal(await stamped('acctA', 2), null);
    await closeDb(conn);
});

// ---- Legacy-mode write absorption (core down -> legacy ledger -> recovery) --

test('legacy-mode PL payment after baseline is absorbed before projection, never lowered or doubled', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();                 // baseline_v2 stamped on an empty DB
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    const t0 = clock.t;
    const legacyExp = t0 + 30 * DAY_MS;
    // Legacy compatibility mode wrote user_plans + solana_payments + credits
    // while the core was down - no ecosystem receipt exists for this sig.
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,payment_token,created_at,verified_at) VALUES (1,'sigLate',400,'monthly','SOL',?,?)`, [t0, t0]);
    await runOn(conn, `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at) VALUES ('sigLate',1,'solana',?,0,?,NULL,?)`, [t0, legacyExp, t0]);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_at,updated_at) VALUES (1,400,'active',?,?,?)`, [legacyExp, t0, t0]);
    const res = await svc.resolveIdentity('photolynk', '1', { project: true });
    const rec = await getOn(conn, `SELECT legacy_accounted FROM ecosystem_receipts WHERE signature='sigLate'`);
    assert.ok(rec && Number(rec.legacy_accounted) === 1, 'late payment absorbed as legacy_accounted receipt');
    const plan = await getOn(conn, `SELECT expires_at, plan_gb FROM user_plans WHERE user_id = 1`);
    assert.equal(Number(plan.expires_at), legacyExp, 'projection must not lower the legacy expiry');
    assert.equal(Number(plan.plan_gb), 400);
    // Idempotent: re-resolution inserts no second receipt and grants no time.
    await svc.resolveIdentity('photolynk', '1', { project: true });
    assert.equal(Number((await getOn(conn, `SELECT COUNT(*) AS n FROM ecosystem_receipts WHERE signature='sigLate'`)).n), 1);
    assert.equal(Number((await getOn(conn, `SELECT expires_at FROM user_plans WHERE user_id = 1`)).expires_at), legacyExp,
        'no double-credited time');
    // Premium rows are not subscription time - the premium ledger owns them.
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigPremLate',0,'premium',?,?)`, [t0, t0]);
    await svc.resolveIdentity('photolynk', '1', { project: true });
    assert.equal(await getOn(conn, `SELECT signature FROM ecosystem_receipts WHERE signature='sigPremLate'`), undefined,
        'premium row left to the premium ledger');
    await closeDb(conn);
});

test('legacy-mode PS mirror write after baseline is absorbed before projection, sub_until not lowered', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    const acct = await svc.ensureAccount('paceseeker', DEV1, { wallet: W1, proofKind: 'bind', proofRef: 'p1' });
    const t0 = clock.t;
    const subUntil = t0 + 30 * DAY_MS;
    // Legacy-mode verified payment wrote subs + device sub_until + revenue.
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash,sub_until,ad_until) VALUES (?,?,0)`, [DEV1, subUntil]);
    await runOn(conn, `INSERT INTO stealthlynk_subs (account_id,sub_until,source_app,source_kind,provenance,updated_at) VALUES (?,?,'paceseeker','payment','sigPSlate',?)`, [acct, subUntil, t0]);
    await runOn(conn, `INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,paid_with,plan,reported_at,eco_verified) VALUES ('sigPSlate',?,?,'SOL','monthly',?,1)`, [DEV1, t0, t0]);
    const res = await svc.resolveIdentity('paceseeker', DEV1, { project: true });
    const rec = await getOn(conn, `SELECT legacy_accounted FROM ecosystem_receipts WHERE signature='sigPSlate'`);
    assert.ok(rec && Number(rec.legacy_accounted) === 1, 'absorbed as legacy_accounted');
    const job = await getOn(conn, `SELECT job_key, state FROM ecosystem_jobs WHERE reference_id='sigPSlate'`);
    assert.ok(job, 'durable on-chain verify job enqueued for the absorbed row');
    const dev = await getOn(conn, `SELECT sub_until FROM paceseeker_devices WHERE device_hash = ?`, [DEV1]);
    assert.ok(Number(dev.sub_until) >= subUntil, 'projection must not lower legacy sub_until');
    // idempotent second pass
    await svc.resolveIdentity('paceseeker', DEV1, { project: true });
    assert.equal(Number((await getOn(conn, `SELECT COUNT(*) AS n FROM ecosystem_receipts WHERE signature='sigPSlate'`)).n), 1);
    await closeDb(conn);
});

test('absorbLegacyLedgerPage (worker/init sweep) absorbs late legacy writes for both apps', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    const t0 = clock.t;
    const legacyExp = t0 + 30 * DAY_MS;
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,payment_token,created_at,verified_at) VALUES (1,'sigPg',400,'monthly','SOL',?,?)`, [t0, t0]);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_at,updated_at) VALUES (1,400,'active',?,?,?)`, [legacyExp, t0, t0]);
    const n = await svc.absorbLegacyLedgerPage({ limit: 50 });
    assert.ok(n > 0, 'page absorbed at least the late payment');
    const rec = await getOn(conn, `SELECT legacy_accounted FROM ecosystem_receipts WHERE signature='sigPg'`);
    assert.ok(rec && Number(rec.legacy_accounted) === 1);
    // the page's own refold must already be visible to resolution/projection
    const res = await svc.resolveIdentity('photolynk', '1', { project: true });
    const plan = await getOn(conn, `SELECT expires_at FROM user_plans WHERE user_id = 1`);
    assert.equal(Number(plan.expires_at), legacyExp);
    await closeDb(conn);
});

// ---- F1: ad/admin/store plan time never leaks into the SHARED floor --------
// The pre-core bind gate (plan_gb >= 400 AND a bindable payment_type) applies
// in BOTH the baseline seed and post-baseline absorption. The receipt-derived
// floor (paid_at + duration / credits.expires_after) is paid time and stays.
test('F1 baseline: ad_claim plan expiry is member-local, shared floor is paid time only', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    const paid = t0 - 2 * DAY_MS;
    const paidEnd = paid + 30 * DAY_MS;
    const planExp = paidEnd + 7 * DAY_MS; // ad week stacked on top of paid time
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at)
        VALUES (1,400,'active',?,'ad_claim',?,?)`, [planExp, paid, t0]);
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigF1ad',400,'monthly',?,?)`, [paid, paid]);
    await runOn(conn, `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,created_at) VALUES ('sigF1ad',1,'solana',?,NULL,?,?)`, [paid, paidEnd, paid]);
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctF1a',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES ('acctF1a','photolynk','1',?),('acctF1a','paceseeker',?,?)`, [t0, DEV1, t0]);
    await svc.initialize();
    const res = await svc.resolveAccount('acctF1a', { at: t0 });
    assert.equal(res.sharedUntil, paidEnd, 'shared floor is paid+30d - the stacked ad week stays local');
    assert.equal(res.apps.paceseeker.expiresAt, paidEnd, 'PS member sees only the paid shared term');
    assert.equal(res.apps.photolynk.expiresAt, planExp, 'the local PL benefit keeps the full live expiry');
    await closeDb(conn);
});

test('F1 baseline: bindable solana plan expiry feeds the shared floor', async () => {
    const { svc, conn, clock } = await mk();
    const t0 = clock.t;
    const paid = t0 - 2 * DAY_MS;
    const planExp = paid + 30 * DAY_MS + 7 * DAY_MS; // paid time + extra paid/renewal time
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at)
        VALUES (1,400,'active',?,'solana',?,?)`, [planExp, paid, t0]);
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigF1so',400,'monthly',?,?)`, [paid, paid]);
    await runOn(conn, `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,created_at) VALUES ('sigF1so',1,'solana',?,NULL,?,?)`, [paid, paid + 30 * DAY_MS, paid]);
    await runOn(conn, `INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctF1s',?)`, [t0]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES ('acctF1s','photolynk','1',?),('acctF1s','paceseeker',?,?)`, [t0, DEV1, t0]);
    await svc.initialize();
    const res = await svc.resolveAccount('acctF1s', { at: t0 });
    assert.equal(res.sharedUntil, planExp, 'a bindable payment_type plan feeds the shared floor');
    assert.equal(res.apps.paceseeker.expiresAt, planExp);
    await closeDb(conn);
});

test('F1 absorb: legacy-mode ad_claim plan expiry stays out of the shared floor', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize(); // baseline_v2 on an empty DB
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,'paceseeker',?,?)`, [acct, DEV1, clock.t]);
    const t0 = clock.t;
    const paidEnd = t0 + 30 * DAY_MS;
    const planExp = paidEnd + 7 * DAY_MS;
    // Legacy-mode write while the core was down: payment + credits + plan with
    // an ad week stacked on top - payment_type is NOT a bindable value.
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,payment_token,created_at,verified_at) VALUES (1,'sigF1ab',400,'monthly','SOL',?,?)`, [t0, t0]);
    await runOn(conn, `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at) VALUES ('sigF1ab',1,'solana',?,0,?,NULL,?)`, [t0, paidEnd, t0]);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at) VALUES (1,400,'active',?,'ad_claim',?,?)`, [planExp, t0, t0]);
    await svc.resolveIdentity('photolynk', '1', { project: true });
    const rec = await getOn(conn, `SELECT legacy_accounted FROM ecosystem_receipts WHERE signature='sigF1ab'`);
    assert.ok(rec && Number(rec.legacy_accounted) === 1, 'payment absorbed as legacy_accounted');
    const res = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res.sharedUntil, paidEnd, 'shared is paid+30d - the ad week never propagates');
    assert.equal(res.apps.paceseeker.expiresAt, paidEnd);
    assert.equal(res.apps.photolynk.expiresAt, planExp, 'the member keeps the full live expiry locally');
    await closeDb(conn);
});

test('F1 absorb: legacy-mode bindable plan expiry feeds the shared floor', async () => {
    const { svc, conn, clock } = await mk();
    await svc.initialize();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,'paceseeker',?,?)`, [acct, DEV1, clock.t]);
    const t0 = clock.t;
    const paidEnd = t0 + 30 * DAY_MS;
    const planExp = paidEnd + 7 * DAY_MS;
    await runOn(conn, `INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,payment_token,created_at,verified_at) VALUES (1,'sigF1sb',400,'monthly','SOL',?,?)`, [t0, t0]);
    await runOn(conn, `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at) VALUES ('sigF1sb',1,'solana',?,0,?,NULL,?)`, [t0, paidEnd, t0]);
    await runOn(conn, `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at) VALUES (1,400,'active',?,'solana',?,?)`, [planExp, t0, t0]);
    await svc.resolveIdentity('photolynk', '1', { project: true });
    const res = await svc.resolveAccount(acct, { at: t0 });
    assert.equal(res.sharedUntil, planExp, 'bindable plan expiry feeds the shared floor');
    assert.equal(res.apps.paceseeker.expiresAt, planExp);
    await closeDb(conn);
});
