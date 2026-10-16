'use strict';

// ECO2 backend-protocol + wiring regressions. Everything runs against a
// temporary SQLite database, a real ecosystem core, the real payment protocol
// service and the real route module mounted on an express app. RPC responses
// are fully mocked; the Ed25519 key is a fresh throwaway test key. No
// production keys, no network, no server.js require.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const sqlite3 = require('sqlite3');
const { createEcosystemService, DEFAULT_REGISTRY } = require('./ecosystemEntitlements');
const { createEcosystemPaymentService } = require('./ecosystemPayments');
const { mountEcosystemRoutes } = require('./ecosystemRoutes');

const createdDirs = [];
test.after(() => { for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true }); });

const FIXTURE_DDL = [
    `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)`,
    `CREATE TABLE user_plans (user_id INTEGER PRIMARY KEY, plan_gb INTEGER, premium_gb INTEGER, premium_expires_at INTEGER, status TEXT, expires_at INTEGER, grace_until INTEGER, trial_until INTEGER, deleted_at INTEGER, payment_type TEXT, payment_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE ecosystem_accounts (account_id TEXT PRIMARY KEY, primary_wallet TEXT, created_at INTEGER, ad_strict INTEGER DEFAULT 0)`,
    `CREATE TABLE ecosystem_members (account_id TEXT NOT NULL, app TEXT NOT NULL, identity TEXT NOT NULL, wallet TEXT, linked_at INTEGER, wallet_verified INTEGER DEFAULT 0, wallet_changed_at INTEGER, PRIMARY KEY (app, identity))`,
    `CREATE TABLE stealthlynk_subs (account_id TEXT PRIMARY KEY, sub_until INTEGER, source_app TEXT, source_kind TEXT, provenance TEXT, updated_at INTEGER)`,
    `CREATE TABLE ad_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, week_key INTEGER NOT NULL, platform TEXT, post_url TEXT UNIQUE, code TEXT, author_handle TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, verified_at INTEGER, verify_attempts INTEGER DEFAULT 0, granted_at INTEGER, app TEXT, tier_gb INTEGER, UNIQUE(account_id, week_key))`,
    `CREATE TABLE solana_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tx_signature TEXT UNIQUE NOT NULL, sol_amount REAL, skr_amount REAL, payment_token TEXT, tier_gb INTEGER, duration TEXT DEFAULT 'monthly', created_at INTEGER, verified_at INTEGER, entitlement_applied_at INTEGER)`,
    `CREATE TABLE solana_subscription_credits (tx_signature TEXT PRIMARY KEY,user_id INTEGER NOT NULL,source TEXT NOT NULL,payment_at INTEGER NOT NULL,expires_before INTEGER,expires_after INTEGER NOT NULL,detail TEXT,created_at INTEGER NOT NULL)`,
    `CREATE TABLE solana_wallet_bindings (wallet TEXT NOT NULL,user_id INTEGER NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(wallet,user_id))`,
    `CREATE TABLE paceseeker_devices (device_hash TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, sub_status TEXT, sub_until INTEGER, reported_sub_until INTEGER, ad_until INTEGER, sub_signature TEXT, wallet_address TEXT)`,
    `CREATE TABLE paceseeker_revenue (signature TEXT PRIMARY KEY, device_hash TEXT, paid_at INTEGER, paid_with TEXT, plan TEXT, usd_at_checkout REAL, amount_atomic INTEGER, reported_at INTEGER, eco_verified INTEGER DEFAULT 0)`,
];

// Valid 32-byte base58 wallets derived from fixed seeds - test-only values.
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58encode = (bytes) => {
    const digits = [0];
    for (const b of bytes) {
        let carry = b;
        for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
        while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    return '1'.repeat(zeros) + digits.reverse().map((d) => B58A[d]).join('');
};
const WALLET = (n) => b58encode(Buffer.concat([Buffer.from([n]), Buffer.alloc(31, n)]));
const TREASURY = WALLET(0xaa);
const P1 = WALLET(0x11);
const P2 = WALLET(0x22);
const P3 = WALLET(0x33);
const DEV1 = 'dev_' + 'a'.repeat(24);
const DEV2 = 'dev_' + 'b'.repeat(24);
const SKR_MINT = WALLET(0x44);
// Signature labels must satisfy BASE58_SIG_RE (no 0/O/I/l).
const SIG = (label) => `${label}`.replace(/[0OIl]/g, 'a').padEnd(64, 'x').slice(0, 64);

// Same checksum the server shape-checks (fnv1a32 over code+pepper).
const _fnv1a32 = (input) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        hash |= 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};
const VALID_PROMO = (() => {
    const base = 'PSTESTCD12'; // 10 chars -> 14-char code after checksum
    return base + _fnv1a32(base + 'PS_PROMO_V1_PEPPER').slice(0, 4).toUpperCase();
})();

const openDb = (file) => new Promise((res, rej) => { const c = new sqlite3.Database(file, (e) => e ? rej(e) : res(c)); });
const runOn = (conn, sql, p = []) => new Promise((res, rej) => conn.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const getOn = (conn, sql, p = []) => new Promise((res, rej) => conn.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const allOn = (conn, sql, p = []) => new Promise((res, rej) => conn.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const closeDb = (conn) => new Promise((res) => conn.close(() => res()));

// A finalized, parseable SOL treasury transfer carrying arbitrary memos.
const mkSolTx = ({ sig, payer, lamports, memos = [], blockTime }) => ({
    blockTime, slot: 777,
    transaction: {
        signatures: [sig],
        message: {
            accountKeys: [{ pubkey: payer, signer: true }, TREASURY],
            instructions: [
                {
                    programId: '11111111111111111111111111111111',
                    parsed: { type: 'transfer', info: { source: payer, destination: TREASURY, lamports: String(lamports) } },
                },
                ...memos.map((m) => ({ programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: m })),
            ],
        },
    },
    meta: {
        err: null, innerInstructions: [],
        preBalances: [10_000_000_000, 500_000_000],
        postBalances: [10_000_000_000 - Number(lamports) - 5000, 500_000_000 + Number(lamports)],
    },
});

const mkStack = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecoint-'));
    createdDirs.push(dir);
    const file = path.join(dir, 'test.db');
    const conn = await openDb(file);
    for (const ddl of FIXTURE_DDL) await runOn(conn, ddl);
    const clock = { t: Date.now() };
    const now = () => clock.t;
    const state = { band: { latest: 100, low24h: 90, high24h: 110 }, promo: { enabled: true, discountPct: 50, mode: 'code' } };
    const txMap = new Map();
    const signingKey = crypto.generateKeyPairSync('ed25519').privateKey;

    const ecosystem = createEcosystemService({ sqlite3, dbPath: file, registry: DEFAULT_REGISTRY, now });
    await ecosystem.initialize();

    const paymentCodeFor = (id) => `c0de${Number(id).toString(16).padStart(4, '0')}`;
    const protocol = createEcosystemPaymentService({
        ecosystem,
        signingKey,
        treasury: TREASURY,
        tokens: { skrMint: SKR_MINT },
        fetchTransaction: async (sig) => txMap.get(String(sig)) || null,
        getPriceBand: async () => state.band,
        // Called synchronously by the service - must not return a Promise.
        evaluatePaymentAmount: ({ receivedUnits, expectedUsd, band }) => {
            const expected = expectedUsd / band.latest;
            return { ok: receivedUnits >= expected * 0.92, expectedAtLatest: expected };
        },
        resolvePaymentCode: async (code) => allOn(conn, `SELECT user_id FROM solana_payment_codes WHERE code = ?`, [String(code)]),
        paymentCodeFor,
        treasuryBoundUsers: async (wallet, paidAt) =>
            allOn(conn, `SELECT user_id AS id FROM solana_wallet_bindings WHERE wallet = ? AND verified_at <= ?`, [wallet, paidAt]),
        creditSubscription: async (a) => {
            const r = await ecosystem.transaction((tx) => ecosystem.applyPhotolynkInTransaction(tx, {
                signature: a.signature, userId: a.userId, token: a.token, amountAtomic: a.amountAtomic,
                payerWallet: a.payerWallet, paidAt: a.paymentAt, verifiedAt: now(), tierGb: a.tierGb,
                duration: a.duration, source: a.source || 'protocol', quoteId: a.quoteId, mint: a.mint, evidence: a.evidence,
            }, null));
            // Same contract as the production creditor: a false result is a
            // thrown PAYMENT_CONFLICT, never a silent ok.
            if (r && r.ok === false) { const e = new Error(r.code || 'PAYMENT_CONFLICT'); e.code = r.code || 'PAYMENT_CONFLICT'; throw e; }
            return r;
        },
        creditPremium: async (a) => {
            const r = await ecosystem.transaction((tx) => ecosystem.claimPremiumInTransaction(tx, {
                signature: a.signature, userId: a.userId, token: a.token, amountAtomic: a.amountAtomic,
                payerWallet: a.payerWallet, paidAt: a.paymentAt, verifiedAt: now(), quoteId: a.quoteId, mint: a.mint, evidence: a.evidence,
            }));
            if (r && r.ok === false) { const e = new Error(r.code || 'PAYMENT_CONFLICT'); e.code = r.code || 'PAYMENT_CONFLICT'; throw e; }
            // Mirror recordVerifiedPremiumPayment: the claim reserves the
            // receipt and the canonical solana_payments ledger row is written
            // alongside it.
            const token = String(a.token || 'SOL').toUpperCase();
            const at = Number(a.paymentAt) > 0 ? Number(a.paymentAt) : now();
            await runOn(conn,
                `INSERT OR IGNORE INTO solana_payments (user_id, tx_signature, sol_amount, skr_amount, payment_token, tier_gb, duration, created_at, verified_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [a.userId, a.signature, token === 'SKR' ? 0 : (Number(a.amount) || 0), token === 'SKR' ? (Number(a.amount) || 0) : 0,
                 token, 0, token === 'SKR' ? 'premium_skr' : 'premium', at, now()]);
            return r;
        },
        getPremiumPayment: async (sig) => getOn(conn, `SELECT * FROM solana_payments WHERE tx_signature = ?`, [String(sig)]),
        // Same contract as the production resume: the premium marker is only
        // applied through markPremiumApplied once the downstream work lands.
        resumePremiumPayment: async (row) => {
            await ecosystem.markPremiumApplied(row.tx_signature);
            return { applied: true, isPremium: true };
        },
        getPromoPolicy: async () => state.promo,
        registry: DEFAULT_REGISTRY,
        now,
    });
    await protocol.initialize();
    return { conn, file, clock, now, state, txMap, ecosystem, protocol, signingKey };
};

const secsNow = (clock) => Math.floor(clock.t / 1000);

test('canonical PL product through mocked RPC transfer credits 400GB and consumes the quote', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    const q = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1 });
    const p = JSON.parse(q.payload);
    const sig = SIG('plq400');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports: Number(p.amountAtomic), blockTime: secsNow(clock),
        memos: ['PhotoLynk:sub:400:monthly', `SLQ1|${q.quoteId}`],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied');
    assert.equal(r.app, 'photolynk');
    assert.equal(r.identity, '1');
    const snap = await ecosystem.resolveIdentity('photolynk', '1');
    assert.equal(snap.entitlement.planGb, 400);
    assert.ok(snap.entitlement.expiresAt > clock.t, 'grant is live');
    const qrow = await getOn(conn, `SELECT used_signature FROM ecosystem_payment_quotes WHERE quote_id = ?`, [q.quoteId]);
    assert.equal(qrow.used_signature, sig, 'quote consumed by this signature');
    await closeDb(conn);
});

test('unquoted PL payment-code memo attributes via the indexed code map', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO solana_payment_codes (user_id, code) VALUES (1, 'c0de0001')`);
    const sig = SIG('plcode');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports: 40_000_000, blockTime: secsNow(clock),
        memos: ['PhotoLynk:sub:400:monthly:c0de0001'],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied');
    assert.equal(r.identity, '1');
    const snap = await ecosystem.resolveIdentity('photolynk', '1');
    assert.equal(snap.entitlement.planGb, 400);
    await closeDb(conn);
});

test('malformed and mixed-product memos are denied, never credited', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    const cases = [
        ['mixapps', ['PhotoLynk:sub:400:monthly', 'PS1|monthly|1700000000000|deadbeef']],
        ['badquot', ['PhotoLynk:sub:400:monthly', 'SLQ1|NOTHEXATALL']],
        ['badplfmt', ['PhotoLynk:sub:400:weekly']],
        ['badpsfmt', ['PS1|daily|1700000000000|deadbeef']],
        ['twoplmem', ['PhotoLynk:sub:400:monthly', 'PhotoLynk:sub:200:monthly']],
    ];
    for (const [label, memos] of cases) {
        const sig = SIG(label);
        txMap.set(sig, mkSolTx({ sig, payer: P1, lamports: 40_000_000, blockTime: secsNow(clock), memos }));
        const r = await protocol.processSignature(sig, { subjects: [] });
        assert.equal(r.status, 'conflict', label);
        assert.equal(r.code, 'MEMO_MISMATCH', label);
        const rec = await getOn(conn, `SELECT signature FROM ecosystem_receipts WHERE signature = ?`, [sig]);
        assert.equal(rec, null, `no receipt for ${label}`);
    }
    const snap = await ecosystem.resolveIdentity('photolynk', '1');
    assert.equal(snap.entitlement.planGb, 0, 'nothing credited');
    await closeDb(conn);
});

test('unbound PL signature report cannot credit a hinted user', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    const sig = SIG('unbound');
    txMap.set(sig, mkSolTx({
        sig, payer: P2, lamports: 40_000_000, blockTime: secsNow(clock),
        memos: ['PhotoLynk:sub:400:monthly'],
    }));
    const r = await protocol.processSignature(sig, { subjects: [{ app: 'photolynk', identity: '1' }] });
    assert.equal(r.status, 'pending');
    assert.equal(r.code, 'PAYMENT_ACCOUNT_UNVERIFIED');
    const snap = await ecosystem.resolveIdentity('photolynk', '1');
    assert.equal(snap.entitlement.planGb, 0, 'hinted user got nothing');
    await closeDb(conn);
});

test('globally ambiguous PS wallet stays ambiguous regardless of reported subjects', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?),(?)`, [DEV1, DEV2]);
    await ecosystem.ensureAccount('paceseeker', DEV1, { wallet: P3, proofKind: 'bind', proofRef: 'ref1' });
    await ecosystem.ensureAccount('paceseeker', DEV2, { wallet: P3, proofKind: 'bind', proofRef: 'ref2' });
    const sig = SIG('ambigps');
    txMap.set(sig, mkSolTx({
        sig, payer: P3, lamports: 40_000_000, blockTime: secsNow(clock),
        memos: [`PS1|monthly|${clock.t}|deadbeef`],
    }));
    const r = await protocol.processSignature(sig, { subjects: [{ app: 'paceseeker', identity: DEV1 }] });
    assert.equal(r.status, 'conflict');
    assert.equal(r.code, 'AMBIGUOUS_WALLET');
    await closeDb(conn);
});

test('quote reuse requires same payer+promo; PL promo is rejected outright', async () => {
    const { conn, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    const q1 = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1 });
    const q1b = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1 });
    assert.equal(q1b.quoteId, q1.quoteId, 'identical request reuses the live quote');
    assert.equal(q1b.reused, true);
    const q2 = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P2 });
    assert.notEqual(q2.quoteId, q1.quoteId, 'different payer issues a new quote');
    await assert.rejects(
        protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1, promoCode: VALID_PROMO }),
        (e) => e.code === 'PROMO_INVALID',
        'PL storage cannot take a PS promo');
    await assert.rejects(
        protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.premium', duration: 'premium', token: 'SOL', payerWallet: P1, promoCode: VALID_PROMO }),
        (e) => e.code === 'PROMO_INVALID',
        'PL premium cannot take a PS promo');
    const q3 = await protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'USDC', payerWallet: P1, promoCode: VALID_PROMO });
    const p3 = JSON.parse(q3.payload);
    assert.equal(p3.usdCents, 88, 'PS promo applies the 50% discount on the $1.75 list, rounded');
    const q4 = await protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'USDC', payerWallet: P1, promoCode: VALID_PROMO });
    assert.equal(q4.quoteId, q3.quoteId, 'same promo request reuses');
    const q5 = await protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'USDC', payerWallet: P1 });
    assert.notEqual(q5.quoteId, q3.quoteId, 'no-promo request does not reuse the promo quote');
    await closeDb(conn);
});

test('delayed verification inside the quote block-time window succeeds with live pricing down', async () => {
    const { conn, clock, txMap, ecosystem, protocol, state } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    const q = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1 });
    const p = JSON.parse(q.payload);
    const sig = SIG('delayed');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports: Number(p.amountAtomic), blockTime: secsNow(clock),
        memos: ['PhotoLynk:sub:400:monthly', `SLQ1|${q.quoteId}`],
    }));
    state.band = null; // live pricing unavailable
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied', 'quoted payment validates from stored terms');
    await closeDb(conn);
});

test('same quote with a different signature conflicts atomically', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    const q = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1 });
    const p = JSON.parse(q.payload);
    const memos = ['PhotoLynk:sub:400:monthly', `SLQ1|${q.quoteId}`];
    const sig1 = SIG('firstsig');
    txMap.set(sig1, mkSolTx({ sig: sig1, payer: P1, lamports: Number(p.amountAtomic), blockTime: secsNow(clock), memos }));
    const r1 = await protocol.processSignature(sig1, { subjects: [] });
    assert.equal(r1.status, 'applied');
    const sig2 = SIG('secsig2');
    txMap.set(sig2, mkSolTx({ sig: sig2, payer: P1, lamports: Number(p.amountAtomic), blockTime: secsNow(clock), memos }));
    const r2 = await protocol.processSignature(sig2, { subjects: [] });
    assert.equal(r2.status, 'conflict');
    assert.equal(r2.code, 'PAYMENT_CONFLICT');
    const rec2 = await getOn(conn, `SELECT signature FROM ecosystem_receipts WHERE signature = ?`, [sig2]);
    assert.equal(rec2, null, 'second signature left no receipt');
    const snap = await ecosystem.resolveIdentity('photolynk', '1');
    assert.equal(snap.entitlement.planGb, 400, 'only the first payment counted');
    await closeDb(conn);
});

test('signed local benefit never crosses apps; unknown app and missing member cannot sign', async () => {
    const { conn, clock, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?)`, [DEV1]);
    const acct = await ecosystem.ensureAccount('photolynk', '1', { wallet: P1, proofKind: 'bind', proofRef: 'pb1' });
    await ecosystem.ensureAccount('paceseeker', DEV1, { wallet: P1, proofKind: 'bind', proofRef: 'pb2' });
    // 100GB local purchase on the PL member.
    await ecosystem.transaction((tx) => ecosystem.applyPhotolynkInTransaction(tx, {
        signature: SIG('pl100'), userId: 1, token: 'SOL', amountAtomic: '17500000',
        payerWallet: P1, paidAt: clock.t, verifiedAt: clock.t, tierGb: 100, duration: 'monthly', source: 'test',
    }, null));
    const snap = await ecosystem.resolveAccount(acct);
    const plSigned = protocol.signEntitlement(snap, { app: 'photolynk', identity: '1' });
    const plBenefits = JSON.parse(plSigned.payload).benefits;
    assert.ok(plBenefits.some((b) => b.planGb === 100), 'PL local benefit signed for PL subject');
    const psSigned = protocol.signEntitlement(snap, { app: 'paceseeker', identity: DEV1 });
    const psBenefits = JSON.parse(psSigned.payload).benefits;
    assert.ok(!psBenefits.some((b) => b.planGb === 100), 'PL local benefit must not cross into the PS envelope');
    assert.throws(() => protocol.signEntitlement(snap, { app: 'notanapp', identity: '1' }), (e) => e.code === 'APP_UNKNOWN');
    assert.throws(() => protocol.signEntitlement(snap, { app: 'photolynk', identity: '999' }), (e) => e.code === 'MEMBER_UNKNOWN');
    await closeDb(conn);
});

test('premium claim applies once; markPremiumApplied is idempotent and repairs', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO solana_wallet_bindings (wallet,user_id,verified_at) VALUES (?,?,?)`, [P1, 1, 1]);
    const sig = SIG('premium1');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports: 500_000_000, blockTime: secsNow(clock),
        memos: ['PhotoLynk:premium:0:premium'],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied');
    assert.equal(r.result.applied, false, 'claim recorded, NFT effect still pending');
    const m1 = await ecosystem.markPremiumApplied(sig);
    assert.equal(m1.applied, true);
    const m2 = await ecosystem.markPremiumApplied(sig);
    assert.equal(m2.alreadyApplied, true);
    assert.equal(m2.applied, true, 're-mark is a no-op, not a second apply');
    const claim = await ecosystem.transaction((tx) => ecosystem.claimPremiumInTransaction(tx, {
        signature: sig, userId: 1, token: 'SOL', amountAtomic: '500000000',
        payerWallet: P1, paidAt: secsNow(clock) * 1000, verifiedAt: clock.t,
    }));
    assert.equal(claim.alreadyClaimed, true);
    assert.equal(claim.applied, true, 'partial retry reports the repaired marker');
    await closeDb(conn);
});

test('mounted routes: capabilities, quote, verify ownership and entitlement envelope', async () => {
    const { conn, clock, txMap, ecosystem, protocol, signingKey } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await ecosystem.ensureAccount('photolynk', '1', {});
    let who = { app: 'photolynk', identity: '1', accountId: acct };
    const app = express();
    app.use(express.json());
    mountEcosystemRoutes(app, {
        caller: async () => who,
        ready: () => true,
        protocol: () => protocol,
        ecosystem,
        signKey: signingKey,
        registry: DEFAULT_REGISTRY,
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (p, body) => (await fetch(`${base}${p}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    try {
        const cap = await (await fetch(`${base}/api/ecosystem/capabilities`)).json();
        assert.equal(cap.version, 2);
        assert.equal(cap.keyId, 'rc-v1');
        assert.equal(cap.signedQuotes, true);
        assert.equal(cap.quoteTtlMs, 300000);

        const qr = await post('/api/ecosystem/payment-quote', {
            productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1,
        });
        assert.equal(qr.status, 200);
        const q = (await qr.json()).quote;
        const qp = JSON.parse(q.payload);
        assert.equal(qp.type, 'payment_quote');
        assert.equal(qp.app, 'photolynk');

        // A PS caller cannot quote a wallet it has not proven.
        who = { app: 'paceseeker', identity: DEV1, accountId: acct };
        const psq = await post('/api/ecosystem/payment-quote', {
            productId: 'paceseeker.monthly', token: 'SOL', payerWallet: P1,
        });
        assert.equal(psq.status, 403);
        assert.equal((await psq.json()).code, 'PAYER_UNPROVEN');
        who = { app: 'photolynk', identity: '1', accountId: acct };

        const sig = SIG('routever');
        txMap.set(sig, mkSolTx({
            sig, payer: P1, lamports: Number(qp.amountAtomic), blockTime: secsNow(clock),
            memos: ['PhotoLynk:sub:400:monthly', `SLQ1|${q.quoteId}`],
        }));
        const vr = await post('/api/ecosystem/payments/verify', { signature: sig });
        assert.equal(vr.status, 200);
        const v = await vr.json();
        assert.equal(v.success, true);
        assert.equal(v.status, 'applied');
        assert.ok(v.entitlementEnvelope && v.entitlementEnvelope.signature, 'owner receives a signed envelope');
        const env = JSON.parse(v.entitlementEnvelope.payload);
        assert.equal(env.type, 'entitlement');
        assert.equal(env.subjectId, '1');
        assert.ok(env.benefits.some((b) => b.planGb === 400));

        // Another app's caller never sees the applied result.
        who = { app: 'paceseeker', identity: DEV1, accountId: acct };
        const vr2 = await post('/api/ecosystem/payments/verify', { signature: sig });
        assert.equal(vr2.status, 409, 'other subject gets conflict, not the owner result');
        who = { app: 'photolynk', identity: '1', accountId: acct };

        const er = await (await fetch(`${base}/api/ecosystem/entitlement`)).json();
        assert.equal(er.success, true);
        assert.ok(er.entitlementEnvelope.signature);
    } finally {
        server.close();
        await closeDb(conn);
    }
});

test('verify route stays pending for an unfetched signature and reports conflict for a foreign owner', async () => {
    const { conn, ecosystem, protocol, signingKey } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await ecosystem.ensureAccount('photolynk', '1', {});
    const who = { app: 'photolynk', identity: '1', accountId: acct };
    const app = express();
    app.use(express.json());
    mountEcosystemRoutes(app, {
        caller: async () => who, ready: () => true,
        protocol: () => protocol, ecosystem, signKey: signingKey, registry: DEFAULT_REGISTRY,
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const r = await fetch(`${base}/api/ecosystem/payments/verify`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ signature: SIG('nosuchtx') }),
        });
        assert.equal(r.status, 202);
        const body = await r.json();
        assert.equal(body.status, 'pending');
        assert.equal(body.retryAfterMs, 5000);
        // The signature was durably enqueued for the reconcile loop.
        const jobs = await ecosystem.listJobs().catch(() => []);
        assert.ok(jobs.some((j) => j.reference_id === SIG('nosuchtx')), 'job enqueued');
    } finally {
        server.close();
        await closeDb(conn);
    }
});

test('quote status route: pending/applied for the owner, 404 cross-identity, 503 on read failure', async () => {
    const { conn, clock, txMap, ecosystem, protocol, signingKey } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c'),(2,'b@c.d')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    await ecosystem.ensureAccount('photolynk', '2', {});
    let who = { app: 'photolynk', identity: '1' };
    let failReads = false;
    let scans = 0;
    let wakes = 0;
    const ecoWrap = {
        ...ecosystem,
        readTransaction: async (fn) => (failReads ? Promise.reject(new Error('db down')) : ecosystem.readTransaction(fn)),
    };
    const app = express();
    app.use(express.json());
    mountEcosystemRoutes(app, {
        caller: async () => who, ready: () => true,
        protocol: () => protocol, ecosystem: ecoWrap, signKey: signingKey, registry: DEFAULT_REGISTRY,
        requestScan: () => { scans++; }, wakeWorker: () => { wakes++; },
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const q = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1 });
        // malformed id -> 400; a different identity's view of a live quote -> 404
        assert.equal((await fetch(`${base}/api/ecosystem/payment-quotes/NOT-HEX/status`)).status, 400);
        who = { app: 'photolynk', identity: '2' };
        assert.equal((await fetch(`${base}/api/ecosystem/payment-quotes/${q.quoteId}/status`)).status, 404,
            'another identity never sees the quote');
        who = { app: 'photolynk', identity: '1' };
        // no signature known -> pending + scanner wakeup requested, never awaited
        const pending = await (await fetch(`${base}/api/ecosystem/payment-quotes/${q.quoteId}/status`)).json();
        assert.equal(pending.status, 'pending');
        assert.equal(pending.signature, null);
        assert.equal(scans, 1, 'signatureless status asks for a throttled treasury scan');
        // the payment lands -> used_signature + applied receipt -> applied + worker wake
        const qp = JSON.parse(q.payload);
        const sig = SIG('qstatus');
        txMap.set(sig, mkSolTx({
            sig, payer: P1, lamports: Number(qp.amountAtomic), blockTime: secsNow(clock),
            memos: ['PhotoLynk:sub:400:monthly', `SLQ1|${q.quoteId}`],
        }));
        const vr = await protocol.processSignature(sig, { subjects: [] });
        assert.equal(vr.status, 'applied');
        const applied = await (await fetch(`${base}/api/ecosystem/payment-quotes/${q.quoteId}/status`)).json();
        assert.equal(applied.status, 'applied');
        assert.equal(applied.signature, sig);
        assert.ok(wakes >= 1, 'a known signature wakes the verification worker');
        // a read failure is retryable 503, never an empty result
        failReads = true;
        const r503 = await fetch(`${base}/api/ecosystem/payment-quotes/${q.quoteId}/status`);
        assert.equal(r503.status, 503);
        assert.equal((await r503.json()).code, 'STATUS_UNAVAILABLE');
    } finally {
        server.close();
        await closeDb(conn);
    }
});

// A quote is evidence, never grounds to reject an otherwise valid on-chain
// payment: expired/underpaid quotes still bind (all identity terms matched)
// while pricing falls back to the live band; unknown/mismatching quotes are
// ignored entirely and never reach quote consumption.
test('quoted PL payment landing 10min after issue applies via band, quote still binds', async () => {
    const { conn, clock, txMap, ecosystem, protocol, signingKey } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    const q = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_400', token: 'SOL', payerWallet: P1 });
    const p = JSON.parse(q.payload);
    // Paid 10 minutes after issue - past the 5-minute quote TTL. The amount
    // differs from the quote's exact atomic charge but satisfies the live band.
    const lamports = Number(p.amountAtomic) + 100_000;
    const sig = SIG('qexp10');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports, blockTime: secsNow(clock) + 600,
        memos: ['PhotoLynk:sub:400:monthly', `SLQ1|${q.quoteId}`],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied', 'expired quote falls back to band pricing, never rejects');
    assert.equal(r.identity, '1', 'attribution retained from the quote payload');
    const paidAtMs = (secsNow(clock) + 600) * 1000;
    const rec = await getOn(conn, `SELECT quote_id, evidence_json FROM ecosystem_receipts WHERE signature = ?`, [sig]);
    assert.equal(rec.quote_id, q.quoteId, 'receipt retains the quote binding');
    const ev = JSON.parse(rec.evidence_json || '{}');
    assert.equal(ev.quoteFallback, 'QUOTE_EXPIRED', 'fallback is recorded in evidence');
    const qrow = await getOn(conn, `SELECT used_signature FROM ecosystem_payment_quotes WHERE quote_id = ?`, [q.quoteId]);
    assert.equal(qrow.used_signature, sig, 'quote consumed by this signature');
    // quote-status route resolves to applied for the owner
    const app = express();
    app.use(express.json());
    mountEcosystemRoutes(app, {
        caller: async () => ({ app: 'photolynk', identity: '1' }), ready: () => true,
        protocol: () => protocol, ecosystem, signKey: signingKey, registry: DEFAULT_REGISTRY,
    });
    const server = app.listen(0);
    await new Promise((res) => server.once('listening', res));
    try {
        const st = await (await fetch(
            `http://127.0.0.1:${server.address().port}/api/ecosystem/payment-quotes/${q.quoteId}/status`)).json();
        assert.equal(st.status, 'applied');
        assert.equal(st.signature, sig);
    } finally {
        server.close();
    }
    // The receipt's paid_at is 10min ahead of the clock - resolve at paid_at
    // where the benefit is live.
    const snap = await ecosystem.resolveIdentity('photolynk', '1', { at: paidAtMs + 1000 });
    assert.equal(snap.entitlement.planGb, 400, 'full tier granted from the band-valid amount');
    assert.equal(snap.entitlement.expiresAt, paidAtMs + 30 * 24 * 60 * 60 * 1000);
    await closeDb(conn);
});

test('quoted PS payment below the quote amount but within live band applies', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO paceseeker_devices (device_hash) VALUES (?)`, [DEV1]);
    // Attribution needs a proven wallet even when the quote supplies the
    // subject - same requirement as an accepted quote.
    await ecosystem.ensureAccount('paceseeker', DEV1, { wallet: P1, proofKind: 'bind', proofRef: 'p1' });
    const q = await protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'SOL', payerWallet: P1 });
    const p = JSON.parse(q.payload);
    // 95% of the quoted charge: UNDERPAID vs the quote, but >= the live
    // band's ~92% floor - the payment must apply, not conflict.
    const lamports = Math.floor(Number(p.amountAtomic) * 0.95);
    const sig = SIG('psunder');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports, blockTime: secsNow(clock),
        memos: [`PS1|monthly|${clock.t}|deadbeef`, `SLQ1|${q.quoteId}`],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(r.identity, DEV1, 'subject attribution retained from the fallback quote');
    const rec = await getOn(conn, `SELECT quote_id, evidence_json FROM ecosystem_receipts WHERE signature = ?`, [sig]);
    assert.equal(rec.quote_id, q.quoteId);
    assert.equal(JSON.parse(rec.evidence_json || '{}').quoteFallback, 'UNDERPAID');
    const qrow = await getOn(conn, `SELECT used_signature FROM ecosystem_payment_quotes WHERE quote_id = ?`, [q.quoteId]);
    assert.equal(qrow.used_signature, sig);
    await closeDb(conn);
});

test('unknown SLQ1 quote memo on a band-valid PL payment applies with no binding', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    await ecosystem.ensureAccount('photolynk', '1', {});
    // Attribution without a quote subject: the payer wallet is bound to uid 1
    // before the payment lands (verified_at <= paidAt).
    await runOn(conn, `INSERT INTO solana_wallet_bindings (wallet,user_id,verified_at) VALUES (?,1,?)`, [P1, clock.t - 60_000]);
    const sig = SIG('unkqte');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports: 40_000_000, blockTime: secsNow(clock),
        memos: ['PhotoLynk:sub:400:monthly', `SLQ1|${'f'.repeat(32)}`],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied', 'an unknown quote id never rejects a valid payment');
    assert.equal(r.identity, '1', 'attributed via the proven wallet binding');
    const rec = await getOn(conn, `SELECT quote_id, evidence_json FROM ecosystem_receipts WHERE signature = ?`, [sig]);
    assert.equal(rec.quote_id, null, 'no quote binding is stored');
    assert.equal(JSON.parse(rec.evidence_json || '{}').quoteIgnored, 'QUOTE_UNKNOWN');
    await closeDb(conn);
});

// --- Cost-match promo/subscription regressions ($1.75 model) ---------------

const FREE_PROMO = (() => {
    const base = 'PFTESTCD12';
    return base + _fnv1a32(base + 'PF_PROMO_V1_PEPPER').slice(0, 4).toUpperCase();
})();
const FREE_PROMO_2 = (() => {
    const base = 'PFTESTCD22';
    return base + _fnv1a32(base + 'PF_PROMO_V1_PEPPER').slice(0, 4).toUpperCase();
})();
const LN_FREE_PROMO = (() => {
    const base = 'LFTESTCD12';
    return base + _fnv1a32(base + 'LF_PROMO_V1_PEPPER').slice(0, 4).toUpperCase();
})();
const VALID_PROMO2 = (() => {
    const base = 'PSTESTCD34';
    return base + _fnv1a32(base + 'PS_PROMO_V1_PEPPER').slice(0, 4).toUpperCase();
})();
const LN_VALID_PROMO = (() => {
    const base = 'LNTESTCD12';
    return base + _fnv1a32(base + 'LN_PROMO_V1_PEPPER').slice(0, 4).toUpperCase();
})();
const DAY = 24 * 60 * 60 * 1000;

test('fixed final price wins over percentage; disabled promo fails closed', async () => {
    const { conn, ecosystem, protocol, state } = await mkStack();
    await ecosystem.ensureAccount('paceseeker', DEV1, {});
    // Percentage default: 50% off the $1.75 list -> 88c.
    let q = await protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'USDC', payerWallet: P1, promoCode: VALID_PROMO });
    assert.equal(JSON.parse(q.payload).usdCents, 88);
    // Fixed final price takes precedence and ignores the percentage.
    // (Fresh code — a quote reserves its promo, reusing it throws PROMO_TAKEN.)
    state.promo = { enabled: true, discountPct: 50, priceUsd: 1.19, mode: 'code' };
    q = await protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'USDC', payerWallet: P1, promoCode: VALID_PROMO2 });
    assert.equal(JSON.parse(q.payload).usdCents, 119, 'subPromoPriceUsd overrides discountPct');
    // Lane gets the same treatment.
    q = await protocol.issueQuote({ app: 'lane', identity: 'ln-1', productId: 'lane.monthly', token: 'USDC', payerWallet: P1, promoCode: LN_VALID_PROMO });
    assert.equal(JSON.parse(q.payload).usdCents, 119, 'lane.monthly honors the same fixed price');
    // Disabled policy rejects even a structurally valid code.
    state.promo = { enabled: false, discountPct: 50, priceUsd: 1.19, mode: 'code' };
    await assert.rejects(
        protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'USDC', payerWallet: P1, promoCode: VALID_PROMO }),
        (e) => e.code === 'PROMO_INVALID', 'disabled promo never discounts');
    await closeDb(conn);
});

test('PS/Lane monthly price is 175c; old 399c overpayment still accepted', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await ecosystem.ensureAccount('paceseeker', DEV1, { wallet: P1, proofKind: 'bind', proofRef: 'p1' });
    const q = await protocol.issueQuote({ app: 'paceseeker', identity: DEV1, productId: 'paceseeker.monthly', token: 'USDC', payerWallet: P1 });
    assert.equal(JSON.parse(q.payload).usdCents, 175, 'PS list price is $1.75');
    // Legacy $3.99 payment (old client): overpayment above the quote applies.
    const lamports = 39_900_000; // $3.99 at the mocked $100 SOL band
    const sig = SIG('old399');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports, blockTime: secsNow(clock),
        memos: [`PS1|monthly|${clock.t}|deadbeef`, `SLQ1|${q.quoteId}`],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied', 'old-app $3.99 payment remains valid');
    await closeDb(conn);
});

test('free-month redeem: single-use globally, local-only grant, stacks, eco block activates instantly', async () => {
    const { conn, clock, ecosystem, protocol, signingKey } = await mkStack();
    const acct = await ecosystem.ensureAccount('paceseeker', DEV1, {});

    // Route-level codespace check: LF belongs to lane, not paceseeker.
    const app = express();
    app.use(express.json());
    mountEcosystemRoutes(app, {
        caller: async (req) => ({ app: String(req.query.app || 'paceseeker'), identity: String(req.query.id || DEV1) }),
        ready: () => true, protocol: () => protocol, ecosystem, signKey: signingKey, registry: DEFAULT_REGISTRY,
        signGrant: (accountId, subUntil) => ({ grant: `ECO1|${accountId}|${subUntil}`, sig: 'testsig' }),
        // Issued-registry gate: only codes the generator registered may
        // redeem - checksum shape alone must never suffice for a free grant.
        promoIssued: async (_app, code) => code === FREE_PROMO || code === FREE_PROMO_2,
    });
    const server = app.listen(0);
    await new Promise((res) => server.once('listening', res));
    const port = server.address().port;
    try {
        // LF code on the paceseeker app: invalid codespace.
        const bad = await (await fetch(`http://127.0.0.1:${port}/api/ecosystem/promo/redeem?app=paceseeker&id=${DEV1}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: LN_FREE_PROMO }),
        })).json();
        assert.equal(bad.code, 'PROMO_INVALID', 'LF code rejected for paceseeker');
        // Discount-shaped code is not a free code either.
        const disc = await (await fetch(`http://127.0.0.1:${port}/api/ecosystem/promo/redeem?app=paceseeker&id=${DEV1}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: VALID_PROMO }),
        })).json();
        assert.equal(disc.code, 'PROMO_INVALID', 'PS discount code is not a grant code');
        // Shape-valid but unregistered PF code (e.g. forged with an extracted
        // pepper): the issued-registry gate denies it.
        const unregistered = 'PFZZZZZZZZ' + _fnv1a32('PFZZZZZZZZ' + 'PF_PROMO_V1_PEPPER').slice(0, 4).toUpperCase();
        const unknown = await (await fetch(`http://127.0.0.1:${port}/api/ecosystem/promo/redeem?app=paceseeker&id=${DEV1}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: unregistered }),
        })).json();
        assert.equal(unknown.code, 'PROMO_UNKNOWN', 'unregistered free code denied');
        // Valid + registered PF code redeems and returns the signed eco block.
        const ok = await (await fetch(`http://127.0.0.1:${port}/api/ecosystem/promo/redeem?app=paceseeker&id=${DEV1}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: FREE_PROMO }),
        })).json();
        assert.equal(ok.success, true);
        assert.equal(Number(ok.expiresAt), clock.t + 30 * DAY, 'one local month');
        assert.equal(ok.eco.subUntil, clock.t + 30 * DAY, 'eco block carries the grant instantly');
        assert.equal(ok.eco.grant, `ECO1|${acct}|${clock.t + 30 * DAY}`);
        assert.ok(ok.eco.v2 && ok.eco.v2.signature, 'v2 envelope signed');
        // Global single-use: another identity cannot burn the same code.
        const dup = await (await fetch(`http://127.0.0.1:${port}/api/ecosystem/promo/redeem?app=paceseeker&id=${DEV2}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: FREE_PROMO }),
        }));
        assert.equal(dup.status, 409);
        const dupBody = await dup.json();
        assert.equal(dupBody.code, 'PROMO_USED');
    } finally {
        server.close();
    }

    // The grant is local: resolved member is active with promo provenance,
    // sharedUntil stays zero, and a lane member on the same account gets
    // nothing — free codes never feed the shared floor.
    const snap = await ecosystem.resolveAccount(acct, { at: clock.t });
    const me = snap.members.find((m) => m.app === 'paceseeker' && m.identity === DEV1);
    assert.equal(me.active, true);
    assert.equal(me.sourceKind, 'promo');
    assert.equal(me.sourceEventId, `promo:${FREE_PROMO}`);
    assert.equal(Number(snap.sharedUntil) || 0, 0, 'no shared floor from a free code');
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,?,?,?)`, [acct, 'lane', 'ln-9', clock.t]);
    const snap2 = await ecosystem.resolveAccount(acct, { at: clock.t });
    const ln = snap2.members.find((m) => m.app === 'lane');
    assert.equal(ln.active, false, 'promo grant never crosses apps');

    // A second distinct PF code stacks on the live expiry.
    const r2 = await ecosystem.redeemPromoGrant({ app: 'paceseeker', identity: DEV1, code: FREE_PROMO_2 });
    assert.equal(Number(r2.expiresAt), clock.t + 60 * DAY, 'renewal stacks on remaining time');

    // PhotoLynk cannot take feature grants.
    await assert.rejects(ecosystem.redeemPromoGrant({ app: 'photolynk', identity: '1', code: FREE_PROMO_2 }),
        (e) => e.code === 'APP_UNSUPPORTED');
    await closeDb(conn);
});

test('PhotoLynk 100GB binds the shared floor at 175c and activates PS/Lane; 1TB lifts all', async () => {
    const { conn, clock, txMap, ecosystem, protocol } = await mkStack();
    await runOn(conn, `INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await ecosystem.ensureAccount('photolynk', '1', {});
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,?,?,?)`, [acct, 'paceseeker', DEV1, clock.t]);
    await runOn(conn, `INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES (?,?,?,?)`, [acct, 'lane', 'ln-1', clock.t]);
    // 100GB monthly: $1.75 — the exact cost match.
    const q = await protocol.issueQuote({ app: 'photolynk', identity: '1', productId: 'photolynk.storage_100', token: 'SOL', payerWallet: P1 });
    const p = JSON.parse(q.payload);
    assert.equal(p.usdCents, 175, 'storage_100 prices at $1.75');
    const sig = SIG('pl100');
    txMap.set(sig, mkSolTx({
        sig, payer: P1, lamports: Number(p.amountAtomic), blockTime: secsNow(clock),
        memos: ['PhotoLynk:sub:100:monthly', `SLQ1|${q.quoteId}`],
    }));
    const r = await protocol.processSignature(sig, { subjects: [] });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    const paidAtMs = secsNow(clock) * 1000;
    const snap = await ecosystem.resolveAccount(acct, { at: paidAtMs + 1000 });
    const ps = snap.members.find((m) => m.app === 'paceseeker');
    const ln = snap.members.find((m) => m.app === 'lane');
    const pl = snap.members.find((m) => m.app === 'photolynk');
    assert.equal(ps.active, true, '100GB activates PaceSeeker');
    assert.equal(ln.active, true, '100GB activates Lane');
    assert.equal(pl.planGb, 100, 'PL member keeps its own 100GB tier');
    assert.ok(Number(snap.sharedUntil) >= paidAtMs + 29 * DAY, 'shared floor lifted');
    await closeDb(conn);
});
