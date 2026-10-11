'use strict';

// Regression tests for server/paymentRecovery.js.
// All DB work runs against temporary on-disk SQLite databases; all RPC is
// mocked. No live network, no production database, no server startup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const sqlite3 = require('sqlite3').verbose();
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

const paymentRecovery = require('./paymentRecovery');
const {
    parseSubscriptionMemo,
    extractTreasuryTransfer,
    extractPaymentMemo,
    samePaymentRow,
    createSubscriptionCreditor,
    collectTreasurySignatures,
    buildScanQueue,
    verifyWalletOwnership,
    createTreasuryInspector,
    recoveryConfirmed,
    boundUserIds,
    UPSERT_WALLET_BINDING_SQL,
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} = paymentRecovery;

const TREASURY = 'TREASURYwallet1111111111111111111111111111';
const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
const SKR_DECIMALS = 6;
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PAYER = 'PayerWallet111111111111111111111111111111';
const OTHER = 'OtherWallet111111111111111111111111111111';
const SRC_ATA = 'SrcTokenAcct111111111111111111111111111111';
const DEST_ATA = 'DestTokenAcct11111111111111111111111111111';
const TREASURY_OPTS = { wallet: TREASURY, mint: SKR_MINT, decimals: SKR_DECIMALS };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Load ACTUAL definitions from server.js source between explicit markers -
// never a copied lookalike. server.js can't be required (it opens the real
// DB on load), so marked regions are evaluated in a VM sandbox instead.
const SERVER_SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const extractMarked = (name) => {
    const begin = `// === ${name}_BEGIN ===`;
    const end = `// === ${name}_END ===`;
    const i = SERVER_SRC.indexOf(begin);
    const j = SERVER_SRC.indexOf(end);
    assert.ok(i >= 0 && j > i, `marker ${name} not found in server.js`);
    return SERVER_SRC.slice(i + begin.length, j);
};
const evalServer = (name, tail, sandbox = {}) =>
    vm.runInNewContext(`${extractMarked(name)}\n;(${tail})`, { console, ...sandbox });

const { computePaidSubscriptionExpiry: computeExpiry } =
    evalServer('PAID_EXPIRY', '{ computePaidSubscriptionExpiry }');
const { evaluatePaymentAmount: evaluatePayment } =
    evalServer('PAYMENT_EVALUATOR', '{ evaluatePaymentAmount }');
const { base58Encode } = evalServer('BASE58_ENCODE', '{ base58Encode }');

const PLAN_DURATION_MS = { monthly: 30 * 24 * 60 * 60 * 1000, yearly: 365 * 24 * 60 * 60 * 1000 };

// The production memo extractor (server aliases extractPhotoLynkMemo to it).
const extractMemo = (tx) => extractPaymentMemo(tx);

const memoIx = (text) => ({ programId: MEMO_PROGRAM_ID, parsed: text });
// Raw (non-parsed) memo instruction: jsonParsed RPC returns `data` base58.
const memoDataIx = (text) => ({ programId: MEMO_PROGRAM_ID, data: base58Encode(Buffer.from(text, 'utf8')) });

async function openDb(dbPath) {
    const conn = await new Promise((res, rej) => {
        const c = new sqlite3.Database(dbPath, (e) => (e ? rej(e) : res(c)));
    });
    const run = (sql, params = []) => new Promise((res, rej) => conn.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const get = (sql, params = []) => new Promise((res, rej) => conn.get(sql, params, (e, r) => e ? rej(e) : res(r)));
    const all = (sql, params = []) => new Promise((res, rej) => conn.all(sql, params, (e, r) => e ? rej(e) : res(r)));
    const close = () => new Promise((res) => conn.close(() => res()));
    return { conn, run, get, all, close };
}

// Every temp dir a test creates lands here; test.after removes them all and
// asserts nothing is left behind.
const createdDirs = [];
test.after(() => {
    for (const dir of createdDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
        assert.ok(!fs.existsSync(dir), `temp dir not removed: ${dir}`);
    }
});

async function makeFixtureDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payrec-'));
    createdDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const h = await openDb(dbPath);
    await h.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, alias_email TEXT, wallet_address TEXT, storage_uuid TEXT, user_uuid TEXT)`);
    await h.run(`CREATE TABLE user_plans (
        user_id INTEGER PRIMARY KEY, plan_gb INTEGER, premium_gb INTEGER, premium_expires_at INTEGER,
        status TEXT, expires_at INTEGER, grace_until INTEGER, trial_until INTEGER,
        trial_carryover_applied_at INTEGER, last_store_purchase_at INTEGER, deleted_at INTEGER,
        payment_type TEXT, payment_at INTEGER, updated_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id))`);
    await h.run(`CREATE TABLE solana_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        tx_signature TEXT UNIQUE NOT NULL, sol_amount REAL, skr_amount REAL,
        payment_token TEXT, tier_gb INTEGER, duration TEXT DEFAULT 'monthly',
        created_at INTEGER, verified_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id))`);
    await h.run(`CREATE TABLE solana_subscription_credits (
        tx_signature TEXT PRIMARY KEY, user_id INTEGER NOT NULL, source TEXT NOT NULL,
        payment_at INTEGER NOT NULL, expires_before INTEGER, expires_after INTEGER NOT NULL,
        detail TEXT, created_at INTEGER NOT NULL)`);
    await h.run(`CREATE TABLE solana_wallet_bindings (
        wallet TEXT NOT NULL, user_id INTEGER NOT NULL, verified_at INTEGER NOT NULL,
        PRIMARY KEY(wallet,user_id))`);
    await h.run(`CREATE TABLE treasury_scan_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`);
    await h.run(`CREATE TABLE treasury_scan_seen (signature TEXT PRIMARY KEY, seen_at INTEGER, outcome TEXT, user_id INTEGER, detail TEXT)`);
    await h.run(`CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, filename TEXT)`);
    await h.run(`CREATE TABLE devices (user_id INTEGER, device_uuid TEXT, device_name TEXT, last_seen INTEGER, PRIMARY KEY(user_id, device_uuid))`);
    await h.close();
    return { dbPath, dir };
}

const creditDefaults = (dbPath) => ({
    sqlite3, dbPath, computeExpiry, durations: PLAN_DURATION_MS,
});

const basePayment = (over = {}) => ({
    userId: 1,
    signature: 'sig_' + Math.random().toString(36).slice(2) + 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD',
    token: 'SOL',
    amount: 0.5,
    tierGb: 100,
    duration: 'monthly',
    paymentAt: Date.now() - 60_000,
    source: 'test',
    ...over,
});

// ---------------------------------------------------------------------------
// Transaction fixtures
// ---------------------------------------------------------------------------
function solTx({ payer = PAYER, lamports = '500000000', treasuryPre = 2_000_000_000, extraIxs = [], memo = null }) {
    const instructions = [
        ...extraIxs,
        {
            program: 'system', programId: SYSTEM_PROGRAM_ID,
            parsed: { type: 'transfer', info: { source: payer, destination: TREASURY, lamports } },
        },
    ];
    if (memo) instructions.push(memoIx(memo));
    return {
        blockTime: Math.floor(Date.now() / 1000) - 60,
        slot: 250000000,
        meta: {
            err: null,
            fee: 5000,
            preBalances: [10_000_000_000, treasuryPre, 1],
            postBalances: [10_000_000_000 - Number(lamports) - 5000, treasuryPre + Number(lamports), 1],
            preTokenBalances: [],
            postTokenBalances: [],
            innerInstructions: [],
        },
        transaction: {
            message: {
                accountKeys: [
                    { pubkey: payer, signer: true, writable: true },
                    { pubkey: TREASURY, signer: false, writable: true },
                    { pubkey: 'system111111111111111111111111111111111', signer: false, writable: false },
                ],
                instructions,
            },
        },
    };
}

function skrTx({ authority = PAYER, amount = '106207279', memo = null, extraIxs = [], destOwner = TREASURY }) {
    const instructions = [
        ...extraIxs,
        {
            program: 'spl-token', programId: TOKEN_PROGRAM_ID,
            parsed: {
                type: 'transferChecked',
                info: {
                    source: SRC_ATA, destination: DEST_ATA, mint: SKR_MINT,
                    tokenAmount: { amount, decimals: SKR_DECIMALS, uiAmount: Number(amount) / 1e6 },
                    authority,
                },
            },
        },
    ];
    if (memo) instructions.push(memoIx(memo));
    // NOTE: the treasury WALLET is deliberately absent from accountKeys - only
    // its ATA is present. Extraction must prove ownership via token balances.
    return {
        blockTime: Math.floor(Date.now() / 1000) - 60,
        slot: 250000001,
        meta: {
            err: null,
            fee: 5000,
            preBalances: [10_000_000_000, 2_039_280, 2_039_280],
            postBalances: [9_999_995_000, 2_039_280, 2_039_280],
            preTokenBalances: [
                { accountIndex: 1, mint: SKR_MINT, owner: authority, uiTokenAmount: { amount: '1000000000', decimals: SKR_DECIMALS } },
            ],
            postTokenBalances: [
                { accountIndex: 1, mint: SKR_MINT, owner: authority, uiTokenAmount: { amount: String(1000000000 - Number(amount)), decimals: SKR_DECIMALS } },
                { accountIndex: 2, mint: SKR_MINT, owner: destOwner, uiTokenAmount: { amount, decimals: SKR_DECIMALS } },
            ],
            innerInstructions: [],
        },
        transaction: {
            message: {
                accountKeys: [
                    { pubkey: authority, signer: true, writable: true },
                    { pubkey: SRC_ATA, signer: false, writable: true },
                    { pubkey: DEST_ATA, signer: false, writable: true },
                ],
                instructions,
            },
        },
    };
}

// ===========================================================================
// parseSubscriptionMemo
// ===========================================================================
test('parseSubscriptionMemo: valid codeless and coded memos', () => {
    assert.deepEqual(parseSubscriptionMemo('PhotoLynk:sub:100:monthly'), { tierGb: 100, duration: 'monthly', code: null });
    assert.deepEqual(parseSubscriptionMemo('PhotoLynk:sub:400:yearly:deadbeef'), { tierGb: 400, duration: 'yearly', code: 'deadbeef' });
    assert.deepEqual(parseSubscriptionMemo('PhotoLynk:sub:1000:yearly'), { tierGb: 1000, duration: 'yearly', code: null });
});

test('parseSubscriptionMemo: rejects wrong product, missing, malformed memos', () => {
    assert.equal(parseSubscriptionMemo(null), null);
    assert.equal(parseSubscriptionMemo('PhotoLynk:premium:0:premium'), null);
    assert.equal(parseSubscriptionMemo('PhotoLynk:sub:50:monthly'), null);          // bad tier
    assert.equal(parseSubscriptionMemo('PhotoLynk:sub:100:weekly'), null);          // bad duration
    assert.equal(parseSubscriptionMemo('PhotoLynk:sub:100:monthly:xyz'), null);     // bad code
    assert.equal(parseSubscriptionMemo('PhotoLynk:sub:100:monthly:DEADBEEF'), null);// uppercase hex rejected
    assert.equal(parseSubscriptionMemo('random string'), null);
});

// ===========================================================================
// extractTreasuryTransfer
// ===========================================================================
test('extractTreasuryTransfer: valid SOL transfer, capped by net gain', () => {
    const tx = solTx({ lamports: '500000000' });
    const r = extractTreasuryTransfer(tx, TREASURY_OPTS);
    assert.equal(r.token, 'SOL');
    assert.equal(r.rawAmount, '500000000');
    assert.ok(Math.abs(r.amount - 0.5) < 1e-9);
    assert.equal(r.senderWallet, PAYER);
    assert.equal(r.slot, 250000000);
});

test('extractTreasuryTransfer: valid SKR with treasury absent from accountKeys', () => {
    const tx = skrTx({ amount: '106207279' });
    const r = extractTreasuryTransfer(tx, TREASURY_OPTS);
    assert.equal(r.token, 'SKR');
    assert.equal(r.rawAmount, '106207279');
    assert.ok(Math.abs(r.amount - 106.207279) < 1e-6);
    assert.equal(r.senderWallet, PAYER);
});

test('extractTreasuryTransfer: unrelated first SPL ix never supplies the payer', () => {
    const stray = {
        program: 'spl-token', programId: TOKEN_PROGRAM_ID,
        parsed: {
            type: 'transferChecked',
            info: {
                source: 'SomeSrc111', destination: 'SomeDest111', mint: SKR_MINT,
                tokenAmount: { amount: '999', decimals: SKR_DECIMALS }, authority: OTHER,
            },
        },
    };
    const tx = skrTx({ extraIxs: [stray] });
    const r = extractTreasuryTransfer(tx, TREASURY_OPTS);
    assert.equal(r.senderWallet, PAYER); // not OTHER
});

test('extractTreasuryTransfer: rejects wrong mint, wrong destination, failed/missing meta', () => {
    // failed meta
    const failed = solTx({});
    failed.meta.err = { InstructionError: [0, 'CustomError'] };
    assert.throws(() => extractTreasuryTransfer(failed, TREASURY_OPTS), /TX_FAILED|chain/);
    // missing meta
    const noMeta = solTx({});
    delete noMeta.meta;
    assert.throws(() => extractTreasuryTransfer(noMeta, TREASURY_OPTS), (e) => e.code === 'TX_NO_META');
    // wrong destination
    const wrongDest = solTx({});
    wrongDest.transaction.message.instructions[0].parsed.info.destination = OTHER;
    assert.throws(() => extractTreasuryTransfer(wrongDest, TREASURY_OPTS), (e) => e.code === 'NO_INFLOW');
    // wrong mint on SKR
    const wrongMint = skrTx({});
    wrongMint.meta.postTokenBalances[1].mint = 'OtherMint1111111111111111111111111111111';
    assert.throws(() => extractTreasuryTransfer(wrongMint, TREASURY_OPTS), (e) => e.code === 'NO_INFLOW');
});

test('extractTreasuryTransfer: multiple payers and mixed currencies are ambiguous', () => {
    // two different SOL payers
    const tx = solTx({ payer: PAYER });
    tx.transaction.message.accountKeys.push({ pubkey: OTHER, signer: true, writable: true });
    tx.transaction.message.instructions.push({
        program: 'system', programId: SYSTEM_PROGRAM_ID,
        parsed: { type: 'transfer', info: { source: OTHER, destination: TREASURY, lamports: '1000' } },
    });
    tx.meta.preBalances.push(5_000_000_000);
    tx.meta.postBalances.push(4_999_999_000);
    assert.throws(() => extractTreasuryTransfer(tx, TREASURY_OPTS), (e) => e.code === 'AMBIGUOUS_PAYMENT');

    // SOL + SKR in one tx
    const mixed = solTx({ payer: PAYER });
    const skr = skrTx({ authority: PAYER });
    mixed.transaction.message.accountKeys.push({ pubkey: SRC_ATA, signer: false }, { pubkey: DEST_ATA, signer: false });
    mixed.transaction.message.instructions.push(skr.transaction.message.instructions[0]);
    mixed.meta.preTokenBalances = skr.meta.preTokenBalances.map(b => ({ ...b, accountIndex: 3 }));
    mixed.meta.postTokenBalances = skr.meta.postTokenBalances.map(b => ({ ...b, accountIndex: b.accountIndex + 2 }));
    assert.throws(() => extractTreasuryTransfer(mixed, TREASURY_OPTS), (e) => e.code === 'AMBIGUOUS_PAYMENT');
});

test('extractTreasuryTransfer: non-signer source is ignored', () => {
    const tx = solTx({ payer: PAYER });
    tx.transaction.message.accountKeys[0].signer = false; // payer no longer a signer
    tx.transaction.message.accountKeys.push({ pubkey: OTHER, signer: true });
    assert.throws(() => extractTreasuryTransfer(tx, TREASURY_OPTS), (e) => e.code === 'NO_INFLOW');
});

test('extractTreasuryTransfer: unsafe raw amount rejected', () => {
    const tx = solTx({ lamports: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString() });
    tx.meta.postBalances[1] = tx.meta.preBalances[1] + Number.MAX_SAFE_INTEGER; // enough net gain either way
    assert.throws(() => extractTreasuryTransfer(tx, TREASURY_OPTS), (e) => e.code === 'UNSAFE_AMOUNT');
});

// ===========================================================================
// createSubscriptionCreditor - atomicity
// ===========================================================================
async function seedUser(h, id, email) {
    await h.run(`INSERT INTO users (id, email) VALUES (?, ?)`, [id, email]);
}

test('creditor: concurrent same-sig credits -> exactly one payment, one term', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const payAt = Date.now() - 60_000;
    const sig = basePayment().signature;
    const results = await Promise.all([
        credit(basePayment({ signature: sig, paymentAt: payAt })),
        credit(basePayment({ signature: sig, paymentAt: payAt })),
        credit(basePayment({ signature: sig, paymentAt: payAt })),
    ]);
    const payments = await h.all(`SELECT * FROM solana_payments`);
    const credits = await h.all(`SELECT * FROM solana_subscription_credits`);
    const plan = await h.get(`SELECT * FROM user_plans WHERE user_id = 1`);
    assert.equal(payments.length, 1);
    assert.equal(credits.length, 1);
    assert.ok(results.some(r => r.alreadyProcessed), 'at least one concurrent call saw the committed row');
    // exactly ONE monthly duration granted
    assert.equal(plan.expires_at, payAt + PLAN_DURATION_MS.monthly);
    await h.close();
});

test('creditor: two different sigs same user -> stacked durations (concurrent)', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const payAt = Date.now() - 60_000;
    // Concurrent: the write lock must serialize both - a lost update would
    // silently grant only one term.
    const [r1, r2] = await Promise.all([
        credit(basePayment({ signature: 'sigA' + '1'.repeat(60), paymentAt: payAt })),
        credit(basePayment({ signature: 'sigB' + '2'.repeat(60), paymentAt: payAt })),
    ]);
    assert.equal((await h.all(`SELECT * FROM solana_payments`)).length, 2);
    const plan = await h.get(`SELECT * FROM user_plans WHERE user_id = 1`);
    // whichever applied first got extended by the second
    const expirations = [r1.expiresAt, r2.expiresAt].sort((a, b) => a - b);
    assert.equal(expirations[0], payAt + PLAN_DURATION_MS.monthly);
    assert.equal(plan.expires_at, expirations[1]);
    assert.equal(plan.expires_at - payAt, 2 * PLAN_DURATION_MS.monthly);
    await h.close();
});

test('creditor: SOL/SKR race on same signature -> one wins, other PAYMENT_CONFLICT', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const sig = 'racesig' + '3'.repeat(60);
    const results = await Promise.allSettled([
        credit(basePayment({ signature: sig, token: 'SOL', amount: 0.5 })),
        credit(basePayment({ signature: sig, token: 'SKR', amount: 100 })),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const conflicted = results.filter(r => r.status === 'rejected' && r.reason?.code === 'PAYMENT_CONFLICT');
    const payments = await h.all(`SELECT * FROM solana_payments`);
    assert.equal(payments.length, 1);
    assert.equal(ok.length >= 1 && conflicted.length >= 1, true, `expected 1 ok + 1 conflict, got ${JSON.stringify(results.map(r => r.status))}`);
    await h.close();
});

test('creditor: trigger aborting user_plans update -> nothing persists', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await h.run(`CREATE TRIGGER block_plans BEFORE INSERT ON user_plans BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    await assert.rejects(credit(basePayment({ signature: 'abort' + '4'.repeat(60) })), /blocked/);
    assert.equal((await h.all(`SELECT * FROM solana_payments`)).length, 0);
    assert.equal((await h.all(`SELECT * FROM solana_subscription_credits`)).length, 0);
    assert.equal((await h.all(`SELECT * FROM user_plans`)).length, 0);
    await h.close();
});

test('creditor: close/reopen then retry applies once', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await h.close(); // simulate process restart
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const sig = 'retry' + '5'.repeat(60);
    const r1 = await credit(basePayment({ signature: sig }));
    const r2 = await credit(basePayment({ signature: sig }));
    assert.equal(r1.alreadyProcessed, false);
    assert.equal(r2.alreadyProcessed, true);
    const h2 = await openDb(dbPath);
    assert.equal((await h2.all(`SELECT * FROM solana_payments`)).length, 1);
    await h2.close();
});

test('creditor: trial carryover once + yearly duration', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const now = Date.now();
    const payAt = now - 60_000;
    const trialUntil = payAt + 5 * 24 * 60 * 60 * 1000; // 5d of trial left at purchase
    await h.run(`INSERT INTO user_plans (user_id, plan_gb, status, trial_until) VALUES (1, 0, 'trial', ?)`, [trialUntil]);
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const r1 = await credit(basePayment({ signature: 'yr1' + '6'.repeat(60), duration: 'yearly', paymentAt: payAt }));
    // yearly + 5d trial carryover
    assert.equal(r1.expiresAt, payAt + PLAN_DURATION_MS.yearly + (trialUntil - payAt));
    const plan1 = await h.get(`SELECT * FROM user_plans WHERE user_id = 1`);
    assert.equal(plan1.trial_carryover_applied_at, payAt);
    // second purchase does NOT re-apply carryover
    const payAt2 = now - 30_000;
    const r2 = await credit(basePayment({ signature: 'mo1' + '7'.repeat(60), paymentAt: payAt2 }));
    assert.equal(r2.expiresAt, r1.expiresAt + PLAN_DURATION_MS.monthly);
    await h.close();
});

test('creditor: other user plan/premium/files untouched', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await seedUser(h, 2, 'b@x');
    await h.run(`INSERT INTO user_plans (user_id, plan_gb, premium_gb, status, expires_at, payment_type) VALUES (2, 200, 1000, 'active', ?, 'apple')`, [Date.now() + 9999999]);
    await h.run(`INSERT INTO files (user_id, filename) VALUES (2, 'precious.jpg')`);
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    await credit(basePayment({ signature: 'iso' + '8'.repeat(60) }));
    const other = await h.get(`SELECT * FROM user_plans WHERE user_id = 2`);
    const file = await h.get(`SELECT * FROM files WHERE user_id = 2`);
    assert.equal(other.plan_gb, 200);
    assert.equal(other.premium_gb, 1000);
    assert.equal(other.payment_type, 'apple');
    assert.equal(file.filename, 'precious.jpg');
    await h.close();
});

test('creditor: preserveTier recovery cannot downgrade a higher plan', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await h.run(`INSERT INTO user_plans (user_id, plan_gb, status, expires_at) VALUES (1, 400, 'active', ?)`, [Date.now() + 10 * 24 * 3600 * 1000]);
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const r = await credit(basePayment({ signature: 'rec' + '9'.repeat(60), tierGb: 100, preserveTier: true }));
    const plan = await h.get(`SELECT * FROM user_plans WHERE user_id = 1`);
    assert.equal(plan.plan_gb, 400); // still the bigger plan
    assert.equal(r.planGb, 400);
    await h.close();
});

test('creditor: existing identical ledger row -> duplicate, no extra term', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const payAt = Date.now() - 60_000;
    const expiresBefore = payAt + PLAN_DURATION_MS.monthly;
    const legSig = 'legsig' + 'a'.repeat(50);
    // legacy row: payment_token NULL means SOL
    await h.run(`INSERT INTO solana_payments (user_id, tx_signature, sol_amount, tier_gb, duration, created_at, verified_at) VALUES (1, ?, 0.5, 100, 'monthly', ?, ?)`, [legSig, payAt, payAt]);
    await h.run(`INSERT INTO user_plans (user_id, plan_gb, status, expires_at) VALUES (1, 100, 'active', ?)`, [expiresBefore]);
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const r = await credit(basePayment({ signature: legSig, paymentAt: payAt }));
    assert.equal(r.alreadyProcessed, true);
    assert.equal(r.expiresAt, expiresBefore);
    const plan = await h.get(`SELECT * FROM user_plans WHERE user_id = 1`);
    assert.equal(plan.expires_at, expiresBefore); // untouched - no double term
    assert.equal((await h.all(`SELECT * FROM solana_payments`)).length, 1);
    await h.close();
});

test('creditor: validation rejects bad input; generic constraint is not a dup', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    await assert.rejects(credit(basePayment({ userId: 0 })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ token: 'USDC' })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ amount: -1 })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ tierGb: 50 })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ duration: 'weekly' })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ paymentAt: 0 })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ userId: 999 })), (e) => e.code === 'NO_USER');
    // conflicting existing row -> PAYMENT_CONFLICT (not silently "duplicate")
    const sig = 'conf' + 'b'.repeat(60);
    await credit(basePayment({ signature: sig, userId: 1 }));
    await assert.rejects(credit(basePayment({ signature: sig, userId: 1, tierGb: 200 })), (e) => e.code === 'PAYMENT_CONFLICT');
    await h.close();
});

// ===========================================================================
// collectTreasurySignatures - mocked RPC rolling sweep
// ===========================================================================
const mkSigs = (prefix, start, count) =>
    Array.from({ length: count }, (_, i) => ({ signature: `${prefix}${String(start + i).padStart(4, '0')}`, slot: start + i, err: null }));

function stateStore(h) {
    return {
        getState: async (key) => { const r = await h.get(`SELECT value FROM treasury_scan_state WHERE key=?`, [key]); try { return r?.value ? JSON.parse(r.value) : null; } catch { return null; } },
        setState: async (key, v) => h.run(`INSERT OR REPLACE INTO treasury_scan_state (key,value,updated_at) VALUES (?,?,?)`, [key, JSON.stringify(v), Date.now()]),
        clearState: async (key) => h.run(`DELETE FROM treasury_scan_state WHERE key=?`, [key]),
    };
}

test('collectTreasurySignatures: endpoint error/null falls through to next endpoint', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const st = stateStore(h);
    const history = mkSigs('h', 1, 10);
    const calls = [];
    const rpcOn = async (endpoint, method, params) => {
        calls.push(endpoint);
        if (endpoint === 'ep1') throw new Error('ep1 down');
        return history; // ep2
    };
    const out = await collectTreasurySignatures({
        endpoints: ['ep1', 'ep2'], address: 'ADDR', rpcOn,
        ...st, sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    assert.equal(out.length, 10);
    assert.ok(calls.includes('ep2'));
    // malformed result is not an "empty page" success either
    const out2 = await collectTreasurySignatures({
        endpoints: ['epA', 'epB'], address: 'ADDR2',
        rpcOn: async (ep) => (ep === 'epA' ? { notAList: true } : mkSigs('x', 1, 3)),
        ...st, sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    assert.equal(out2.length, 3);
    await h.close();
});

test('collectTreasurySignatures: sweeps past "known" sigs; backlog resumes via cursor', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const st = stateStore(h);
    // 600-sig history, newest first (RPC order). A "known" sig sits at index 3
    // - the sweep must page past it, never stop.
    const history = mkSigs('s', 1, 600);
    const pages = [];
    const rpcOn = async (endpoint, method, params) => {
        const opts = params[1] || {}; // RPC params are positional: [address, opts]
        const limit = opts.limit;
        if (!opts.before) { pages.push('head'); return history.slice(0, limit); }
        const idx = history.findIndex(e => e.signature === opts.before);
        return history.slice(idx + 1, idx + 1 + limit);
    };
    const run1 = await collectTreasurySignatures({
        endpoints: ['ep'], address: 'A', rpcOn,
        ...st, sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    assert.equal(run1.length, 500); // head(100)+4 sweep pages
    const cursor1 = await st.getState(JSON.stringify(['history_v2', 'ep', 'A']));
    assert.equal(cursor1.before, 's0500');
    const run2 = await collectTreasurySignatures({
        endpoints: ['ep'], address: 'A', rpcOn,
        ...st, sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    // run2: head(100, all dup of run1 head) + sweep from s0500 -> last 100 -> exhausted
    assert.equal(run2.length, 200);
    const cursor2 = await st.getState(JSON.stringify(['history_v2', 'ep', 'A']));
    assert.equal(cursor2, null); // cleared on exhaustion -> fresh sweep next run
    const all = new Set([...run1, ...run2].map(e => e.signature));
    assert.equal(all.size, 600); // entire history covered across two runs
    await h.close();
});

test('buildScanQueue: no_user retry is queued even when absent from head', () => {
    const collected = mkSigs('n', 1, 5);
    const { queue, retrySet } = buildScanQueue(collected, ['oldRetrySig1', 'n0002']);
    assert.ok(queue.some(e => e.signature === 'oldRetrySig1'));
    assert.ok(retrySet.has('oldRetrySig1'));
    assert.ok(retrySet.has('n0002'));
    // deduped - n0002 appears once
    assert.equal(queue.filter(e => e.signature === 'n0002').length, 1);
    assert.equal(queue.length, 6);
});

test('retry queue SQL: only retryable outcomes, oldest first', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const outcomes = ['no_user', 'credited_sub', 'code_no_match', 'no_memo', 'conflict', 'rpc_error', 'already_credited', 'underpaid'];
    for (let i = 0; i < outcomes.length; i++) {
        await h.run(`INSERT INTO treasury_scan_seen (signature, seen_at, outcome) VALUES (?, ?, ?)`, [`s${i}`, i + 1, outcomes[i]]);
    }
    const rows = await h.all(`SELECT signature FROM treasury_scan_seen WHERE outcome IN ('no_user','code_no_match','conflict','rpc_error','underpaid') ORDER BY seen_at ASC LIMIT 100`);
    assert.deepEqual(rows.map(r => r.signature), ['s0', 's2', 's4', 's5', 's7']);
    await h.close();
});

// ===========================================================================
// createTreasuryInspector - admin preview (zero writes, attribution rules)
// ===========================================================================
async function makeInspectorDeps(h, overrides = {}) {
    return {
        fetchTx: overrides.fetchTx || (async () => solTx({ memo: 'PhotoLynk:sub:100:monthly' })),
        getUserById: async (id) => h.get(`SELECT id, email, alias_email, wallet_address FROM users WHERE id = ?`, [id]),
        getPaymentBySignature: async (sig) => h.get(`SELECT * FROM solana_payments WHERE tx_signature = ?`, [sig]),
        getPlanByUser: async (id) => h.get(`SELECT * FROM user_plans WHERE user_id = ?`, [id]),
        resolvePaymentCode: overrides.resolvePaymentCode || (async () => null),
        getBoundUsersByWallet: async (w) => h.all(
            `SELECT DISTINCT u.id, u.email FROM users u JOIN solana_wallet_bindings b ON b.user_id = u.id WHERE b.wallet = ?`, [w]),
        getLegacyWalletCandidates: async () => [],
        getPriceBand: overrides.getPriceBand || (async () => ({ latest: 150, min: 140, max: 160, sampleCount: 3 })),
        evaluatePayment, // REAL server.js evaluator (VM-loaded)
        computeExpiry,   // REAL computePaidSubscriptionExpiry (VM-loaded)
        durations: PLAN_DURATION_MS,
        extractMemo,     // REAL paymentRecovery.extractPaymentMemo
        treasury: TREASURY_OPTS,
        planPricesUsd: { 100: 1.75, 200: 2.45, 400: 3.99, 1000: 7.99 },
        skrSubscriptionMultiplier: 1.0,
    };
}
const VALID_SIG = 'A'.repeat(64);

test('inspector: preview writes nothing; codeless+unbound => admin_required', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const inspect = createTreasuryInspector(await makeInspectorDeps(h));
    // SOL 0.5 @ band latest 150 = $75 >> $1.75? overpay is fine - eval ok.
    const r = await inspect(VALID_SIG, 1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.inspection.attribution, 'admin_required');
    assert.equal(r.inspection.token, 'SOL');
    assert.equal(r.inspection.tierGb, 100);
    assert.equal(r.inspection.alreadyProcessed, false);
    // zero writes
    assert.equal((await h.all(`SELECT * FROM solana_payments`)).length, 0);
    assert.equal((await h.all(`SELECT * FROM user_plans`)).length, 0);
    assert.equal((await h.all(`SELECT * FROM solana_subscription_credits`)).length, 0);
    await h.close();
});

test('inspector: other-user code cannot be claimed; missing-code user fails', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await seedUser(h, 2, 'b@x');
    const tx = solTx({ memo: 'PhotoLynk:sub:100:monthly:deadbeef' });
    const inspect = createTreasuryInspector(await makeInspectorDeps(h, {
        fetchTx: async () => tx,
        resolvePaymentCode: async (code) => (code === 'deadbeef' ? { id: 2, email: 'b@x' } : null),
    }));
    const wrong = await inspect(VALID_SIG, 1);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'ATTRIBUTION_CONFLICT');
    const right = await inspect(VALID_SIG, 2);
    assert.equal(right.ok, true);
    assert.equal(right.inspection.attribution, 'payment_code');
    // unknown code
    const tx2 = solTx({ memo: 'PhotoLynk:sub:100:monthly:0badc0de' });
    const inspect2 = createTreasuryInspector(await makeInspectorDeps(h, { fetchTx: async () => tx2 }));
    const noMatch = await inspect2(VALID_SIG, 1);
    assert.equal(noMatch.ok, false);
    assert.equal(noMatch.code, 'CODE_NO_MATCH');
    await h.close();
});

test('inspector: verified binding rules (same user ok, other user conflict)', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await seedUser(h, 2, 'b@x');
    const deps = await makeInspectorDeps(h);
    const inspect = createTreasuryInspector(deps);
    await h.run(UPSERT_WALLET_BINDING_SQL, [PAYER, 1, Date.now()]);
    const mine = await inspect(VALID_SIG, 1);
    assert.equal(mine.ok, true);
    assert.equal(mine.inspection.attribution, 'verified_wallet');
    const foreign = await inspect(VALID_SIG, 2);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, 'ATTRIBUTION_CONFLICT');
    await h.close();
});

test('inspector: existing row same user -> alreadyProcessed; different user -> conflict', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await seedUser(h, 2, 'b@x');
    await h.run(`INSERT INTO solana_payments (user_id, tx_signature, sol_amount, payment_token, tier_gb, duration, created_at, verified_at)
                VALUES (1, ?, 0.5, 'SOL', 100, 'monthly', 1, 1)`, [VALID_SIG]);
    const inspect = createTreasuryInspector(await makeInspectorDeps(h));
    const mine = await inspect(VALID_SIG, 1);
    assert.equal(mine.ok, true);
    assert.equal(mine.inspection.alreadyProcessed, true);
    const foreign = await inspect(VALID_SIG, 2);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, 'PAYMENT_CONFLICT');
    await h.close();
});

test('inspector: >30d payment is historical; POST-side underpay flagged via price', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const oldTx = solTx({ memo: 'PhotoLynk:sub:100:monthly' });
    oldTx.blockTime = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
    const inspectOld = createTreasuryInspector(await makeInspectorDeps(h, { fetchTx: async () => oldTx }));
    const r1 = await inspectOld(VALID_SIG, 1);
    assert.equal(r1.ok, true);
    assert.equal(r1.inspection.historical, true);
    assert.equal(r1.inspection.price.ok, false); // historical -> never priced at today's rate
    // underpaid: tiny amount
    const underTx = solTx({ memo: 'PhotoLynk:sub:1000:yearly', lamports: '1000' });
    underTx.meta.postBalances[1] = underTx.meta.preBalances[1] + 1000;
    const inspectUnder = createTreasuryInspector(await makeInspectorDeps(h, { fetchTx: async () => underTx }));
    const r2 = await inspectUnder(VALID_SIG, 1);
    assert.equal(r2.ok, true);
    assert.equal(r2.inspection.price.ok, false);
    await h.close();
});

test('recoveryConfirmed: only explicit boolean true passes the gate', () => {
    assert.equal(recoveryConfirmed({ confirm: true }), true);
    assert.equal(recoveryConfirmed({ confirm: 'true' }), false);
    assert.equal(recoveryConfirmed({ confirm: 1 }), false);
    assert.equal(recoveryConfirmed({}), false);
    assert.equal(recoveryConfirmed(undefined), false);
    assert.equal(recoveryConfirmed(null), false);
});

test('inspector: input validation', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const inspect = createTreasuryInspector(await makeInspectorDeps(h));
    assert.equal((await inspect('!!!bad', 1)).code, 'BAD_SIGNATURE');
    assert.equal((await inspect(VALID_SIG, -1)).code, 'BAD_USER');
    assert.equal((await inspect(VALID_SIG, 999)).code, 'NO_USER');
    await h.close();
});

// ===========================================================================
// samePaymentRow + verifyWalletOwnership + binding upsert
// ===========================================================================
test('samePaymentRow: legacy null token is SOL; mismatches conflict', () => {
    const legacy = { user_id: 1, tx_signature: 's', sol_amount: 0.5, payment_token: null, tier_gb: 100, duration: 'monthly' };
    assert.equal(samePaymentRow(legacy, { userId: 1, token: 'SOL', tierGb: 100, duration: 'monthly' }), true);
    assert.equal(samePaymentRow(legacy, { userId: 1, token: 'SKR', tierGb: 100, duration: 'monthly' }), false);
    assert.equal(samePaymentRow(legacy, { userId: 2, token: 'SOL', tierGb: 100, duration: 'monthly' }), false);
    assert.equal(samePaymentRow(legacy, { userId: 1, token: 'SOL', tierGb: 200, duration: 'monthly' }), false);
    assert.equal(samePaymentRow(legacy, { userId: 1, token: 'SOL', tierGb: 100, duration: 'yearly' }), false);
});

test('verifyWalletOwnership: key mismatch rejected; valid signature accepted', () => {
    const kp = nacl.sign.keyPair();
    const wallet = base58Encode(kp.publicKey);
    const msg = naclUtil.decodeUTF8('PhotoLynk-Login-v1 wallet:' + wallet);
    const sig = nacl.sign.detached(msg, kp.secretKey);
    const ok = verifyWalletOwnership({
        nacl, naclUtil, base58Encode,
        publicKeyB64: naclUtil.encodeBase64(kp.publicKey),
        signatureB64: naclUtil.encodeBase64(sig),
        messageBytes: msg,
        walletAddress: wallet,
    });
    assert.equal(ok.ok, true);
    // same signature, different claimed wallet -> rejected (no repair may run)
    const kp2 = nacl.sign.keyPair();
    const bad = verifyWalletOwnership({
        nacl, naclUtil, base58Encode,
        publicKeyB64: naclUtil.encodeBase64(kp.publicKey),
        signatureB64: naclUtil.encodeBase64(sig),
        messageBytes: msg,
        walletAddress: base58Encode(kp2.publicKey),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'Public key does not match wallet address');
    // forged signature -> rejected
    const forged = verifyWalletOwnership({
        nacl, naclUtil, base58Encode,
        publicKeyB64: naclUtil.encodeBase64(kp.publicKey),
        signatureB64: naclUtil.encodeBase64(nacl.sign.detached(naclUtil.decodeUTF8('other'), kp.secretKey)),
        messageBytes: msg,
        walletAddress: wallet,
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.status, 401);
});

test('wallet binding upsert persists proof once, refreshes verified_at', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await h.run(UPSERT_WALLET_BINDING_SQL, [PAYER, 1, 1000]);
    await h.run(UPSERT_WALLET_BINDING_SQL, [PAYER, 1, 2000]);
    const rows = await h.all(`SELECT * FROM solana_wallet_bindings WHERE wallet = ?`, [PAYER]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verified_at, 2000);
    await h.close();
});

// ===========================================================================
// End-to-end: inspector attribution -> creditor recovery on temp DB
// ===========================================================================
test('recovery path: inspect then credit applies payment+plan+audit atomically', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const tx = solTx({ memo: 'PhotoLynk:sub:100:monthly' });
    const payAt = tx.blockTime * 1000;
    const inspect = createTreasuryInspector(await makeInspectorDeps(h, { fetchTx: async () => tx }));
    const r = await inspect(VALID_SIG, 1);
    assert.equal(r.ok, true);
    assert.equal(r.inspection.attribution, 'admin_required'); // explicit admin confirm required
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const cr = await credit({
        userId: 1, signature: VALID_SIG, token: r.inspection.token, amount: r.inspection.amount,
        tierGb: r.inspection.tierGb, duration: r.inspection.duration, paymentAt: r.inspection.paymentAt,
        source: 'admin_recovery', detail: JSON.stringify({ payer: r.inspection.payer, memo: r.inspection.memo }),
        preserveTier: true,
    });
    assert.equal(cr.alreadyProcessed, false);
    const plan = await h.get(`SELECT * FROM user_plans WHERE user_id = 1`);
    const audit = await h.get(`SELECT * FROM solana_subscription_credits WHERE tx_signature = ?`, [VALID_SIG]);
    assert.equal(plan.expires_at, payAt + PLAN_DURATION_MS.monthly);
    assert.equal(plan.payment_type, 'solana');
    assert.equal(audit.source, 'admin_recovery');
    assert.equal(audit.expires_after, plan.expires_at);
    // second inspect reports alreadyProcessed - idempotent
    const r2 = await inspect(VALID_SIG, 1);
    assert.equal(r2.inspection.alreadyProcessed, true);
    await h.close();
});

// ===========================================================================
// extractPaymentMemo - production memo extraction (parsed + raw base58)
// ===========================================================================
test('extractPaymentMemo: parsed string and raw base58 memo data both resolve', () => {
    const txParsed = solTx({ memo: 'PhotoLynk:sub:100:monthly' });
    assert.equal(extractPaymentMemo(txParsed), 'PhotoLynk:sub:100:monthly');
    // raw data instruction (non-parsed jsonParsed form): data is base58, NOT base64
    const txRaw = solTx({});
    txRaw.transaction.message.instructions.push(memoDataIx('PhotoLynk:sub:400:yearly:deadbeef'));
    assert.equal(extractPaymentMemo(txRaw), 'PhotoLynk:sub:400:yearly:deadbeef');
    // inner-instruction memo also counts
    const txInner = solTx({});
    txInner.meta.innerInstructions = [{ index: 0, instructions: [memoIx('PhotoLynk:premium:0:premium')] }];
    assert.equal(extractPaymentMemo(txInner), 'PhotoLynk:premium:0:premium');
    // non-PhotoLynk memos are ignored; no memo -> null
    const txNone = solTx({ memo: 'unrelated memo text' });
    assert.equal(extractPaymentMemo(txNone), null);
    assert.equal(extractPaymentMemo(solTx({})), null);
    // invalid base58 data cannot carry a PhotoLynk memo
    const txBad = solTx({});
    txBad.transaction.message.instructions.push({ programId: MEMO_PROGRAM_ID, data: '0OIl!!!not-base58' });
    assert.equal(extractPaymentMemo(txBad), null);
});

test('extractPaymentMemo: more than one PhotoLynk memo is MEMO_MISMATCH, not first-match', () => {
    const tx = solTx({ memo: 'PhotoLynk:sub:100:monthly' });
    tx.transaction.message.instructions.push(memoIx('PhotoLynk:premium:0:premium'));
    assert.throws(() => extractPaymentMemo(tx), (e) => e.code === 'MEMO_MISMATCH');
    const tx2 = solTx({ memo: 'PhotoLynk:sub:100:monthly' });
    tx2.transaction.message.instructions.push(memoDataIx('PhotoLynk:sub:400:yearly'));
    assert.throws(() => extractPaymentMemo(tx2), (e) => e.code === 'MEMO_MISMATCH');
});

// ===========================================================================
// extractTreasuryTransfer - unsafe numeric balances/amounts
// ===========================================================================
test('extractTreasuryTransfer: unsafe lamport balances in meta rejected', () => {
    const tx = solTx({});
    tx.meta.postBalances[1] = 1.5; // non-integer balance - poisoned payload
    assert.throws(() => extractTreasuryTransfer(tx, TREASURY_OPTS), (e) => e.code === 'UNSAFE_AMOUNT');
    const tx2 = solTx({});
    tx2.meta.postBalances[0] = 1e20; // above MAX_SAFE_INTEGER
    assert.throws(() => extractTreasuryTransfer(tx2, TREASURY_OPTS), (e) => e.code === 'UNSAFE_AMOUNT');
});

// ===========================================================================
// Creditor: signature canonicalization, open failure, duration own-enum
// ===========================================================================
test('creditor: whitespace signature variants resolve to ONE row/term', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const sig = 'canon' + 'c'.repeat(60);
    const r1 = await credit(basePayment({ signature: `  ${sig}  ` }));
    const r2 = await credit(basePayment({ signature: sig }));
    const r3 = await credit(basePayment({ signature: `\t${sig}\n` }));
    assert.equal(r1.alreadyProcessed, false);
    assert.equal(r2.alreadyProcessed, true);
    assert.equal(r3.alreadyProcessed, true);
    const rows = await h.all(`SELECT * FROM solana_payments`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tx_signature, sig);
    await h.close();
});

test('creditor: database open failure rejects cleanly (no unhandled error)', async () => {
    const credit = createSubscriptionCreditor({
        sqlite3, dbPath: '/definitely-missing-payrec-dir-xyz/deep/test.db',
        computeExpiry, durations: PLAN_DURATION_MS,
    });
    await assert.rejects(credit(basePayment()), /SQLITE_CANTOPEN|unable to open/i);
});

test('creditor: duration enum rejects inherited prototype properties', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    await assert.rejects(credit(basePayment({ duration: 'toString' })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ duration: 'constructor' })), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(credit(basePayment({ duration: 'hasOwnProperty' })), (e) => e.code === 'INVALID_INPUT');
    await h.close();
});

// ===========================================================================
// collectTreasurySignatures - per-endpoint budgets, cursor edge cases
// ===========================================================================
test('collectTreasurySignatures: independent per-endpoint budget - busy ep1 cannot starve ep2', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const st = stateStore(h);
    const hist1 = mkSigs('a', 1, 650);   // ep1 deep
    const hist2 = mkSigs('b', 1, 620);   // ep2 deep - disjoint
    const rpcOn = async (endpoint, method, params) => {
        const hist = endpoint === 'ep1' ? hist1 : hist2;
        const opts = params[1] || {};
        if (!opts.before) return hist.slice(0, opts.limit);
        const idx = hist.findIndex(e => e.signature === opts.before);
        return idx < 0 ? [] : hist.slice(idx + 1, idx + 1 + opts.limit);
    };
    const run1 = await collectTreasurySignatures({
        endpoints: ['ep1', 'ep2'], address: 'A', rpcOn,
        ...st, sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    // BOTH endpoints get their head + 4 sweep pages: 500 + 500
    assert.equal(run1.filter(e => e.signature.startsWith('a')).length, 500);
    assert.equal(run1.filter(e => e.signature.startsWith('b')).length, 500);
    const run2 = await collectTreasurySignatures({
        endpoints: ['ep1', 'ep2'], address: 'A', rpcOn,
        ...st, sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    const all = new Set([...run1, ...run2].map(e => e.signature));
    assert.equal(all.size, 650 + 620); // full history of BOTH endpoints across runs
    await h.close();
});

test('collectTreasurySignatures: persisted cursor resumes even when head is short', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const st = stateStore(h);
    const key = JSON.stringify(['history_v2', 'shallow', 'A']);
    // Shallow endpoint: head only has 3 sigs, but a persisted cursor still
    // has backlog behind it - it must NOT be treated as exhausted/discarded.
    await st.setState(key, { before: 'cur0' });
    const rpcOn = async (endpoint, method, params) => {
        const opts = params[1] || {};
        if (!opts.before) return mkSigs('h', 1, 3);          // short head
        if (opts.before === 'cur0') return mkSigs('b', 1, 2); // last backlog page
        return [];
    };
    const out = await collectTreasurySignatures({
        endpoints: ['shallow'], address: 'A', rpcOn,
        ...st, sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    assert.equal(out.length, 5); // 3 head + 2 backlog - cursor was resumed, not dropped
    assert.equal(await st.getState(key), null); // backlog exhausted -> cleared
    await h.close();
});

test('collectTreasurySignatures: getState failure keeps cursor and still collects head', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const st = stateStore(h);
    const key = JSON.stringify(['history_v2', 'ep', 'A']);
    await st.setState(key, { before: 'keepme' });
    const out = await collectTreasurySignatures({
        endpoints: ['ep'], address: 'A',
        rpcOn: async () => mkSigs('h', 1, 5),
        getState: async () => { throw new Error('db down'); },
        setState: st.setState, clearState: st.clearState,
        sleep: async () => { }, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
        log: () => { },
    });
    assert.equal(out.length, 5); // head still collected
    // persisted cursor untouched - progress is never silently reset
    assert.deepEqual(await st.getState(key), { before: 'keepme' });
    await h.close();
});

// ===========================================================================
// Inspector: bound-wallet conflict on BOTH attribution paths
// ===========================================================================
test('inspector: valid code + payer wallet bound to OTHER user -> conflict', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await seedUser(h, 2, 'b@x');
    await h.run(UPSERT_WALLET_BINDING_SQL, [PAYER, 2, Date.now()]); // payer wallet belongs to user 2
    const tx = solTx({ memo: 'PhotoLynk:sub:100:monthly:deadbeef' });
    const inspect = createTreasuryInspector(await makeInspectorDeps(h, {
        fetchTx: async () => tx,
        resolvePaymentCode: async (code) => (code === 'deadbeef' ? { id: 1, email: 'a@x' } : null),
    }));
    const r = await inspect(VALID_SIG, 1); // code says user 1, wallet bound to user 2
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ATTRIBUTION_CONFLICT');
    await h.close();
});

test('inspector: wallet bound to multiple users is ambiguous on both paths', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    await seedUser(h, 2, 'b@x');
    await h.run(UPSERT_WALLET_BINDING_SQL, [PAYER, 1, Date.now()]);
    await h.run(UPSERT_WALLET_BINDING_SQL, [PAYER, 2, Date.now()]);
    // codeless path
    const inspect = createTreasuryInspector(await makeInspectorDeps(h));
    const r1 = await inspect(VALID_SIG, 1);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'ATTRIBUTION_CONFLICT');
    // coded path with a code that resolves to the selected user: still conflict
    const tx = solTx({ memo: 'PhotoLynk:sub:100:monthly:deadbeef' });
    const inspect2 = createTreasuryInspector(await makeInspectorDeps(h, {
        fetchTx: async () => tx,
        resolvePaymentCode: async () => ({ id: 1, email: 'a@x' }),
    }));
    const r2 = await inspect2(VALID_SIG, 1);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'ATTRIBUTION_CONFLICT');
    await h.close();
});

test('inspector: conflicting memos surface as coded failure', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await seedUser(h, 1, 'a@x');
    const tx = solTx({ memo: 'PhotoLynk:sub:100:monthly' });
    tx.transaction.message.instructions.push(memoIx('PhotoLynk:sub:400:yearly'));
    const inspect = createTreasuryInspector(await makeInspectorDeps(h, { fetchTx: async () => tx }));
    const r = await inspect(VALID_SIG, 1);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEMO_MISMATCH');
    await h.close();
});

// ===========================================================================
// verifyTreasuryTransaction - REAL server.js code, VM-loaded with stubs
// ===========================================================================
const mkVerifySandbox = ({ tx, band = { latest: 150, min: 140, max: 160, sampleCount: 3 } }) => {
    const calls = [];
    const sandbox = {
        paymentRecovery,
        treasuryFetchTransaction: async (sig) => {
            calls.push(sig);
            return typeof tx === 'function' ? tx(calls.length) : tx;
        },
        treasurySleep: async () => { },
        getPriceBand: async () => band,
        evaluatePaymentAmount: evaluatePayment, // REAL evaluator (VM-loaded)
        extractPhotoLynkMemo: extractPaymentMemo, // REAL extractor
        SOLANA_PAYMENT_WALLET: TREASURY,
        SKR_TOKEN_MINT: SKR_MINT,
        SKR_TOKEN_DECIMALS: SKR_DECIMALS,
    };
    const fns = evalServer('VERIFY_TREASURY_TX',
        '{ verifyTreasuryTransaction, verifySolanaTransaction, verifySkrTokenTransaction }', sandbox);
    return { ...fns, calls };
};

test('verifyTreasuryTransaction (real server code): SOL success shape + endpoint fallback', async () => {
    let n = 0;
    const { verifySolanaTransaction, calls } = mkVerifySandbox({
        tx: () => (++n === 1 ? null : solTx({ memo: 'PhotoLynk:sub:100:monthly' })),
    });
    const r = await verifySolanaTransaction('  paddedSig  ', 1.75);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.receivedAmount, 0.5);
    assert.equal(r.sender, PAYER);
    assert.equal(r.receiver, TREASURY);
    assert.equal(r.memo, 'PhotoLynk:sub:100:monthly');
    assert.equal(typeof r.blockTime, 'number');
    assert.equal(calls.length, 2); // null fell through, second fetch delivered
    assert.equal(calls[0], 'paddedSig'); // canonicalized before RPC
});

test('verifyTreasuryTransaction (real server code): SKR success shape', async () => {
    const { verifySkrTokenTransaction } = mkVerifySandbox({ tx: skrTx({ memo: 'PhotoLynk:sub:100:monthly' }) });
    const r = await verifySkrTokenTransaction('sig', 170);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.receivedRawAmount, 106207279);
    assert.equal(r.mint, SKR_MINT);
    assert.equal(r.owner, TREASURY);
    assert.equal(r.sender, PAYER);
});

test('verifyTreasuryTransaction (real server code): wrong token/destination -> WRONG_WALLET', async () => {
    const solOnSkrPath = mkVerifySandbox({ tx: solTx({}) });
    const r1 = await solOnSkrPath.verifySkrTokenTransaction('sig', 1.75);
    assert.equal(r1.success, false);
    assert.equal(r1.code, 'WRONG_WALLET');
    const skrOnSolPath = mkVerifySandbox({ tx: skrTx({}) });
    const r2 = await skrOnSolPath.verifySolanaTransaction('sig', 1.75);
    assert.equal(r2.success, false);
    assert.equal(r2.code, 'WRONG_WALLET');
    const wrongDest = solTx({});
    wrongDest.transaction.message.instructions[0].parsed.info.destination = OTHER;
    const r3 = await mkVerifySandbox({ tx: wrongDest }).verifySolanaTransaction('sig', 1.75);
    assert.equal(r3.success, false);
    assert.equal(r3.code, 'WRONG_WALLET');
});

test('verifyTreasuryTransaction (real server code): missing meta is retryable, not a verdict', async () => {
    const { verifySolanaTransaction, calls } = mkVerifySandbox({ tx: { blockTime: 1 } });
    const r = await verifySolanaTransaction('sig', 1.75);
    assert.equal(r.success, false);
    assert.equal(r.code, 'TX_UNAVAILABLE');
    assert.equal(r.retryable, true);
    assert.equal(calls.length, 5); // retried the full cadence before giving up
});

// ===========================================================================
// Admin page route - REAL emitted HTML; its inline <script> must PARSE
// ===========================================================================
test('admin page: emitted inline script compiles (catches literal-newline bug)', () => {
    const captured = {};
    const app = { get: (p, ...a) => { captured.handler = a[a.length - 1]; } };
    vm.runInNewContext(extractMarked('ADMIN_PAGE_ROUTE'), {
        app, adminAuth: () => { }, ADMIN_HTML_TITLE: 'T', console,
    });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, send(html) { this.html = html; } };
    captured.handler({}, res);
    assert.ok(res.html && res.html.includes('Recover payment'), 'admin HTML emitted');
    const scripts = [...res.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length >= 1, 'expected at least one inline script');
    for (const s of scripts) new vm.Script(s); // SyntaxError here = broken admin page
});

// ===========================================================================
// Admin recover route - REAL handler via VM/stubs
// ===========================================================================
const mkRecoverRoute = ({ inspection, creditImpl } = {}) => {
    const calls = { credit: [], markSeen: [], eco: [] };
    const captured = {};
    const app = { post: (p, ...a) => { captured.handler = a[a.length - 1]; } };
    vm.runInNewContext(extractMarked('TREASURY_RECOVER_ROUTE'), {
        app, adminAuth: () => { },
        paymentRecovery,
        inspectTreasuryPayment: async () => inspection,
        creditSolanaSubscription: async (args) => {
            calls.credit.push(args);
            return creditImpl ? creditImpl(args) : { alreadyProcessed: false, expiresAt: Date.now() + 86400000, planGb: args.tierGb, status: 'active' };
        },
        treasuryMarkSeen: async (...a) => { calls.markSeen.push(a); },
        ecoEnsureAccount: async (...a) => { calls.eco.push(a); return 'acct'; },
        ecoFloorSub: async () => { },
        ECO_BIND_MIN_TIER_GB: 400,
        ADMIN_USER: 'admin',
        console, Date,
    });
    return { handler: captured.handler, calls };
};
const resStub = () => ({
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
});
const okInspection = (over = {}) => ({
    ok: true,
    inspection: {
        user: { id: 1, email: 'a@x', displayName: 'a@x' },
        signature: 'A'.repeat(64), memo: 'PhotoLynk:sub:100:monthly', payer: PAYER,
        token: 'SOL', amount: 0.5, rawAmount: '500000000',
        tierGb: 100, duration: 'monthly', paymentAt: Date.now() - 60000,
        historical: false, alreadyProcessed: false, attribution: 'admin_required',
        candidates: [], expectedExpiresAt: Date.now() + 30 * 86400000,
        planGb: null, planStatus: null, price: { expectedUsd: 1.75, ok: true },
        ...over,
    },
});

test('admin recover route (real handler): confirm gate + conflict + canonical sig + dup', async () => {
    // missing confirm -> 400 before any work
    let { handler, calls } = mkRecoverRoute({ inspection: okInspection() });
    let res = resStub();
    await handler({ body: { signature: 'sig', userId: 1 } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'CONFIRM_REQUIRED');
    assert.equal(calls.credit.length, 0);

    // inspector conflict propagates (other-user claim cannot proceed)
    ({ handler } = mkRecoverRoute({ inspection: { ok: false, status: 409, code: 'ATTRIBUTION_CONFLICT', error: 'x' } }));
    res = resStub();
    await handler({ body: { signature: 'sig', userId: 1, confirm: true } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'ATTRIBUTION_CONFLICT');

    // canonical signature: padded request sig -> creditor sees trimmed insp.signature
    const insp = okInspection();
    ({ handler, calls } = mkRecoverRoute({ inspection: insp }));
    res = resStub();
    await handler({ body: { signature: `  ${'A'.repeat(64)}  `, userId: 1, confirm: true } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.credit.length, 1);
    assert.equal(calls.credit[0].signature, 'A'.repeat(64));
    assert.equal(calls.credit[0].source, 'admin_recovery');
    assert.equal(calls.credit[0].preserveTier, true);
    assert.equal(calls.markSeen[0][0], 'A'.repeat(64));

    // alreadyProcessed -> idempotent success, creditor never invoked
    ({ handler, calls } = mkRecoverRoute({ inspection: okInspection({ alreadyProcessed: true, planGb: 400, planStatus: 'active' }) }));
    res = resStub();
    await handler({ body: { signature: 'sig', userId: 1, confirm: true } }, res);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyProcessed, true);
    assert.equal(res.body.planGb, 400);
    assert.equal(calls.credit.length, 0);
});

test('admin recover route (real handler): eco mirror uses purchased tier, never wallet', async () => {
    // purchased 400 -> mirror fires with a NULL wallet (not users.wallet_address)
    let { handler, calls } = mkRecoverRoute({ inspection: okInspection({ tierGb: 400, amount: 2 }) });
    let res = resStub();
    await handler({ body: { signature: 'sig', userId: 1, confirm: true } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.eco.length, 1);
    assert.equal(calls.eco[0][2], null);
    // purchased 100 but plan_gb preserved at 400 -> NO ecosystem unlock
    ({ handler, calls } = mkRecoverRoute({
        inspection: okInspection({ tierGb: 100 }),
        creditImpl: () => ({ alreadyProcessed: false, expiresAt: Date.now() + 86400000, planGb: 400, status: 'active' }),
    }));
    res = resStub();
    await handler({ body: { signature: 'sig', userId: 1, confirm: true } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.eco.length, 0);
});

// ===========================================================================
// Wallet-login route - REAL handler + REAL findUserByWalletAddress vs temp DB
// ===========================================================================
const runWalletLogin = async (h, body) => {
    const captured = {};
    const app = { post: (p, ...a) => { captured.handler = a[a.length - 1]; } };
    const sandbox = {
        app, authRateLimiter: () => { },
        paymentRecovery, nacl, naclUtil, base58Encode,
        walletLoginChallenges: new Map(),
        process: { env: { WALLET_LOGIN_ALLOW_LEGACY: '1' } },
        dbRunAsync: (sql, p = []) => h.run(sql, p),
        dbGetAsync: (sql, p = []) => h.get(sql, p),
        dbAllAsync: (sql, p = []) => h.all(sql, p),
        computeStorageUuidFromEmail: () => null,
        jwt: { sign: () => 'test-token' },
        JWT_SECRET: 'test-secret',
        ecoEnsureAccount: async () => 'acct',
        ecoSyncMemberEntitlement: async () => { },
        console, Date,
    };
    // REAL implementations evaluated in the same sandbox (temp-db dbAllAsync).
    sandbox.findUserByWalletAddress = vm.runInNewContext(
        extractMarked('FIND_USER_BY_WALLET') + '\n;findUserByWalletAddress', sandbox);
    sandbox.validateWalletLoginMessage = vm.runInNewContext(
        extractMarked('WALLET_MSG_VALIDATOR') + '\n;validateWalletLoginMessage', sandbox);
    vm.runInNewContext(extractMarked('WALLET_LOGIN_ROUTE'), sandbox);
    const res = resStub();
    await captured.handler({ body }, res);
    return res;
};

const walletLoginBody = (kp, wallet, msgText) => {
    const msg = naclUtil.decodeUTF8(msgText);
    return {
        wallet_address: wallet,
        signed_message: naclUtil.encodeBase64(msg),
        signature: naclUtil.encodeBase64(nacl.sign.detached(msg, kp.secretKey)),
        public_key_b64: naclUtil.encodeBase64(kp.publicKey),
        device_uuid: 'dev-1',
    };
};
const LEGACY_MSG = 'Sign this message to authenticate with stealthlynk.io - PhotoLynk-MasterKey-v1';

test('wallet-login (real handler): key mismatch rejected with NO repair or proof', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const claimedKp = nacl.sign.keyPair();
    const claimedWallet = base58Encode(claimedKp.publicKey);
    // user resolvable via the claimed wallet's legacy derived email
    await h.run(`INSERT INTO users (id, email) VALUES (1, ?)`, [`${claimedWallet.toLowerCase()}@seeker.photolynk.local`]);
    // attacker signs with a DIFFERENT key - pubkey does not encode the claimed wallet
    const attackerKp = nacl.sign.keyPair();
    const res = await runWalletLogin(h, walletLoginBody(attackerKp, claimedWallet, LEGACY_MSG));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Public key does not match wallet address');
    const user = await h.get(`SELECT wallet_address FROM users WHERE id = 1`);
    assert.equal(user.wallet_address, null); // no repair before proof
    assert.equal((await h.all(`SELECT * FROM solana_wallet_bindings`)).length, 0);
    assert.equal((await h.all(`SELECT * FROM devices`)).length, 0);
    await h.close();
});

test('wallet-login (real handler): forged signature rejected with NO writes', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const kp = nacl.sign.keyPair();
    const wallet = base58Encode(kp.publicKey);
    await h.run(`INSERT INTO users (id, email) VALUES (1, ?)`, [`${wallet.toLowerCase()}@seeker.photolynk.local`]);
    // sign a different message than what is sent
    const body = walletLoginBody(kp, wallet, LEGACY_MSG);
    body.signed_message = naclUtil.encodeBase64(naclUtil.decodeUTF8('a different message stealthlynk.io PhotoLynk-MasterKey-v1'));
    const res = await runWalletLogin(h, body);
    assert.equal(res.statusCode, 401);
    assert.equal((await h.all(`SELECT * FROM solana_wallet_bindings`)).length, 0);
    await h.close();
});

test('wallet-login (real handler): valid legacy login persists proof + repairs wallet', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const kp = nacl.sign.keyPair();
    const wallet = base58Encode(kp.publicKey);
    await h.run(`INSERT INTO users (id, email, user_uuid) VALUES (1, ?, 'uu-1')`, [`${wallet.toLowerCase()}@seeker.photolynk.local`]);
    const res = await runWalletLogin(h, walletLoginBody(kp, wallet, LEGACY_MSG));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.token, 'test-token');
    assert.equal(res.body.userId, 1);
    const binding = await h.get(`SELECT * FROM solana_wallet_bindings WHERE wallet = ? AND user_id = 1`, [wallet]);
    assert.ok(binding, 'verified proof row persisted');
    const user = await h.get(`SELECT wallet_address FROM users WHERE id = 1`);
    assert.equal(user.wallet_address, wallet); // repair ran AFTER proof
    assert.equal((await h.all(`SELECT * FROM devices WHERE user_id = 1`)).length, 1);
    await h.close();
});

test('wallet-login (real handler): ambiguous wallet-derived accounts -> 401, no first-match', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const kp = nacl.sign.keyPair();
    const wallet = base58Encode(kp.publicKey);
    const derived = `${wallet.toLowerCase()}@seeker.photolynk.local`;
    await h.run(`INSERT INTO users (id, email) VALUES (1, ?)`, [derived]);
    await h.run(`INSERT INTO users (id, email, alias_email) VALUES (2, 'other@x', ?)`, [derived]);
    const res = await runWalletLogin(h, walletLoginBody(kp, wallet, LEGACY_MSG));
    assert.equal(res.statusCode, 401); // never grafts onto an arbitrary first match
    assert.equal((await h.all(`SELECT * FROM solana_wallet_bindings`)).length, 0);
    await h.close();
});

// ===========================================================================
// treasuryFetchTransaction - REAL server code: malformed results fall through
// ===========================================================================
const mkFetchTx = (results) => {
    const calls = [];
    const sandbox = {
        TREASURY_RPC_ENDPOINTS: ['ep1', 'ep2'],
        treasuryRpcOn: async (endpoint, method, params) => {
            calls.push({ endpoint, params });
            const r = results[endpoint];
            if (r instanceof Error) throw r;
            return typeof r === 'function' ? r() : r;
        },
    };
    const fetchTx = evalServer('TREASURY_FETCH_TX', 'treasuryFetchTransaction', sandbox);
    return { fetchTx, calls };
};
const VALID_TX = () => solTx({});

test('treasuryFetchTransaction (real code): null/malformed/error on ep1 falls through to ep2', async () => {
    // ep1 null -> ep2 valid wins
    let { fetchTx, calls } = mkFetchTx({ ep1: null, ep2: VALID_TX() });
    let tx = await fetchTx('sig1');
    assert.equal(tx.slot, VALID_TX().slot);
    assert.equal(calls.length, 2);
    // ep1 missing meta -> ep2 valid wins
    ({ fetchTx, calls } = mkFetchTx({ ep1: { transaction: { message: {} }, blockTime: 5 }, ep2: VALID_TX() }));
    tx = await fetchTx('sig2');
    assert.equal(tx.meta.err, null);
    assert.equal(calls.length, 2);
    // ep1 JSON-RPC error -> ep2 valid wins
    ({ fetchTx, calls } = mkFetchTx({ ep1: new Error('RPC error -32602'), ep2: VALID_TX() }));
    tx = await fetchTx('sig3');
    assert.equal(tx.meta.err, null);
    // ep1 no blockTime -> ep2 valid wins
    ({ fetchTx, calls } = mkFetchTx({ ep1: { transaction: { message: {} }, meta: { err: null } }, ep2: VALID_TX() }));
    tx = await fetchTx('sig4');
    assert.equal(tx.slot, VALID_TX().slot);
    // every call requested finalized
    for (const c of calls) assert.equal(c.params[1].commitment, 'finalized');
});

test('treasuryFetchTransaction (real code): both bad -> null; failed on-chain still returned', async () => {
    // both endpoints unusable -> null
    let { fetchTx, calls } = mkFetchTx({ ep1: null, ep2: { transaction: { message: {} } } });
    assert.equal(await fetchTx('sig'), null);
    assert.equal(calls.length, 2);
    // meta.err non-null (failed on-chain) IS a valid return - caller rejects it
    const failed = VALID_TX();
    failed.meta.err = { InstructionError: [0, 'Custom'] };
    ({ fetchTx, calls } = mkFetchTx({ ep1: failed, ep2: VALID_TX() }));
    const tx = await fetchTx('sig');
    assert.deepEqual(tx.meta.err, { InstructionError: [0, 'Custom'] });
    assert.equal(calls.length, 1); // no fall-through on a real verdict
});
