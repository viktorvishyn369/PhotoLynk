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
const { createEcosystemService } = require('./ecosystemEntitlements');
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
const USDC_MINT = 'USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT';
const USDT_MINT = 'USDTuqcZ2d7QpXkM2xJ3b6r9v1n4m8w5y7z0A1B2C3D';
// The scanned/routed regions now consult the ECO2 payment protocol. These
// unit fixtures exercise the legacy PhotoLynk path, so the protocol stays
// disabled unless a test stubs it explicitly.
const ECO_OFF = { ecosystemReady: false, paymentProtocol: null, ecosystem: null };
// The scanner's premium claim goes through recordVerifiedPremiumPayment;
// replicate its legacy (!ecosystemReady) solana_payments INSERT so the fixture
// DB sees exactly the row production would write.
const stubRecordVerifiedPremium = (h) => async ({ userId, signature, token, amount, paymentAt }) => {
    const uid = Number(userId);
    const t = String(token || 'SOL').toUpperCase();
    const at = Number(paymentAt) > 0 ? Number(paymentAt) : Date.now();
    await h.run(
        `INSERT OR IGNORE INTO solana_payments (user_id, tx_signature, sol_amount, skr_amount, payment_token, tier_gb, duration, created_at, verified_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [uid, signature, t === 'SKR' ? 0 : (Number(amount) || 0), t === 'SKR' ? (Number(amount) || 0) : 0,
         t, 0, t === 'SKR' ? 'premium_skr' : 'premium', at, Date.now()]);
    return { alreadyRecorded: false };
};
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
        created_at INTEGER, verified_at INTEGER, entitlement_applied_at INTEGER,
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
    // Eco mirror + token-account cache + purge targets (minimal shapes; the
    // audit tests only exercise account/user-level deletes/upserts).
    await h.run(`CREATE TABLE skr_token_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, address TEXT UNIQUE)`);
    await h.run(`CREATE TABLE stealthlynk_accounts (user_id INTEGER PRIMARY KEY, sub_until INTEGER, updated_at INTEGER)`);
    await h.run(`CREATE TABLE stealthlynk_subs (account_id TEXT PRIMARY KEY, user_id INTEGER, sub_until INTEGER,
        source_app TEXT, source_kind TEXT, provenance TEXT, updated_at INTEGER)`);
    await h.run(`CREATE TABLE stealthlynk_members (user_id INTEGER, app TEXT, sub_until INTEGER, updated_at INTEGER)`);
    await h.run(`CREATE TABLE ecosystem_members (account_id TEXT, app TEXT, identity TEXT, PRIMARY KEY(account_id, app, identity))`);
    await h.run(`CREATE TABLE paceseeker_devices (device_hash TEXT PRIMARY KEY, sub_until INTEGER)`);
    await h.run(`CREATE TABLE plan_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, details TEXT, created_at INTEGER)`);
    for (const t of ['cloud_chunks', 'cloud_device_state', 'platform_hashes']) {
        await h.run(`CREATE TABLE ${t} (user_id INTEGER)`);
    }
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

test('extractTreasuryTransfer: treasury SOL self-payment uses the signed instruction amount', () => {
    // treasury -> treasury: net gain is just the burned fee, but only the
    // treasury keyholder can sign such a transfer - the ix amount is the proof.
    const tx = solTx({ payer: TREASURY, lamports: '500000000' });
    tx.transaction.message.accountKeys = [{ pubkey: TREASURY, signer: true, writable: true }];
    tx.meta.preBalances = [2_000_000_000];
    tx.meta.postBalances = [2_000_000_000 - 5000];
    const r = extractTreasuryTransfer(tx, TREASURY_OPTS);
    assert.equal(r.token, 'SOL');
    assert.equal(r.rawAmount, '500000000');
    assert.ok(Math.abs(r.amount - 0.5) < 1e-9);
    assert.equal(r.senderWallet, TREASURY);
    assert.equal(r.selfPayment, true);
});

test('extractTreasuryTransfer: treasury SKR self-payment to its own ATA is accepted', () => {
    const tx = skrTx({ authority: TREASURY });
    tx.transaction.message.instructions[0].parsed.info.destination = SRC_ATA;
    tx.transaction.message.accountKeys = [
        { pubkey: TREASURY, signer: true, writable: true },
        { pubkey: SRC_ATA, signer: false, writable: true },
    ];
    tx.meta.preTokenBalances = [
        { accountIndex: 1, mint: SKR_MINT, owner: TREASURY, uiTokenAmount: { amount: '1000000000', decimals: SKR_DECIMALS } },
    ];
    tx.meta.postTokenBalances = [
        { accountIndex: 1, mint: SKR_MINT, owner: TREASURY, uiTokenAmount: { amount: '1000000000', decimals: SKR_DECIMALS } },
    ];
    const r = extractTreasuryTransfer(tx, TREASURY_OPTS);
    assert.equal(r.token, 'SKR');
    assert.equal(r.rawAmount, '106207279');
    assert.equal(r.senderWallet, TREASURY);
    assert.equal(r.selfPayment, true);
});

test('extractTreasuryTransfer: normal payments are not flagged as selfPayment', () => {
    const r = extractTreasuryTransfer(solTx({ lamports: '500000000' }), TREASURY_OPTS);
    assert.equal(r.selfPayment, false);
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
const mkVerifySandbox = ({ tx, band = { latest: 150, min: 140, max: 160, sampleCount: 3 },
    paymentProtocol = null, ecosystemReady = false, dbGetAsync = async () => null }) => {
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
        paymentProtocol, ecosystemReady, dbGetAsync,
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

// A quote is evidence, never grounds to reject an otherwise valid on-chain
// payment: expired/underpaid quotes keep their binding but the amount is
// re-priced by the live band; unknown/mismatching quotes and a down core are
// ignored entirely. Only a malformed SLQ1 memo still rejects.
test('verifyTreasuryTransaction (real code): QUOTE_EXPIRED keeps the binding but prices by band', async () => {
    const quoteId = 'a'.repeat(32);
    let qcSeen = null;
    const { verifySolanaTransaction } = mkVerifySandbox({
        tx: solTx({ memo: 'PhotoLynk:sub:400:monthly', extraIxs: [memoIx(`SLQ1|${quoteId}`)] }),
        paymentProtocol: {
            quoteCheck: async (qid, args) => {
                qcSeen = { qid, args };
                return { ok: false, code: 'QUOTE_EXPIRED', retryable: false };
            },
        },
        ecosystemReady: true,
        dbGetAsync: async () => ({ payload: JSON.stringify({ subjectId: '42' }) }),
    });
    const r = await verifySolanaTransaction('sig', 1.75);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.quoteId, quoteId, 'fallback quote id still binds for the creditor/status poll');
    assert.equal(r.quoteSubjectId, '42', 'subject attribution survives the fallback');
    assert.equal(qcSeen.qid, quoteId);
});

test('verifyTreasuryTransaction (real code): core down + quote memo verifies by band, not PROTOCOL_UNAVAILABLE', async () => {
    const quoteId = 'b'.repeat(32);
    const { verifySolanaTransaction } = mkVerifySandbox({
        tx: solTx({ memo: 'PhotoLynk:sub:400:monthly', extraIxs: [memoIx(`SLQ1|${quoteId}`)] }),
        paymentProtocol: null,
        ecosystemReady: false,
    });
    const r = await verifySolanaTransaction('sig', 1.75);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.quoteId, null, 'an unverifiable quote never reaches the creditor');
    assert.equal(r.quoteSubjectId, null);
});

test('verifyTreasuryTransaction (real code): payer-mismatched quote is ignored, band pricing applies', async () => {
    const quoteId = 'c'.repeat(32);
    const { verifySolanaTransaction } = mkVerifySandbox({
        tx: solTx({ memo: 'PhotoLynk:sub:400:monthly', extraIxs: [memoIx(`SLQ1|${quoteId}`)] }),
        paymentProtocol: {
            quoteCheck: async () => ({ ok: false, code: 'QUOTE_MISMATCH', retryable: false }),
        },
        ecosystemReady: true,
    });
    const r = await verifySolanaTransaction('sig', 1.75);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.quoteId, null, 'mismatching quote id must never reach consumeQuote');
    assert.equal(r.quoteSubjectId, null);
});

test('verifyTreasuryTransaction (real code): malformed SLQ1 memo still rejects', async () => {
    const { verifySolanaTransaction } = mkVerifySandbox({
        tx: solTx({ memo: 'PhotoLynk:sub:400:monthly', extraIxs: [memoIx('SLQ1|NOTHEXATALL')] }),
        paymentProtocol: { quoteCheck: async () => ({ ok: true }) },
        ecosystemReady: true,
    });
    const r = await verifySolanaTransaction('sig', 1.75);
    assert.equal(r.success, false);
    assert.equal(r.code, 'MEMO_MISMATCH');
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
        // The route now unconditionally projects the credited user into the
        // ecosystem mirror after a successful credit.
        syncEcoUser: async (...a) => { calls.eco.push(a); },
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

test('admin recover route (real handler): eco mirror projects the credited user, never a wallet', async () => {
    // A successful credit unconditionally re-projects the user; the resolver
    // owns tier/premium semantics, and the route never passes a wallet.
    let { handler, calls } = mkRecoverRoute({ inspection: okInspection({ tierGb: 400, amount: 2 }) });
    let res = resStub();
    await handler({ body: { signature: 'sig', userId: 1, confirm: true } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.eco.length, 1);
    assert.equal(calls.eco[0][0], 1, 'projected identity is the numeric userId');
    assert.equal(calls.eco[0].length, 1, 'no wallet is ever projected from the recovery route');
    // plan_gb preserved at a higher tier still re-projects (resolver decides)
    ({ handler, calls } = mkRecoverRoute({
        inspection: okInspection({ tierGb: 100 }),
        creditImpl: () => ({ alreadyProcessed: false, expiresAt: Date.now() + 86400000, planGb: 400, status: 'active' }),
    }));
    res = resStub();
    await handler({ body: { signature: 'sig', userId: 1, confirm: true } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.eco.length, 1);
    assert.equal(calls.eco[0][0], 1);
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
        crypto: require('crypto'),
        console, Date,
    };
    // REAL implementations evaluated in the same sandbox (temp-db dbAllAsync).
    sandbox.findUserByWalletAddress = vm.runInNewContext(
        extractMarked('FIND_USER_BY_WALLET') + '\n;findUserByWalletAddress', sandbox);
    sandbox.validateWalletLoginMessage = vm.runInNewContext(
        extractMarked('WALLET_MSG_VALIDATOR') + '\n;validateWalletLoginMessage', sandbox);
    sandbox.deviceUuidOwnedByOther = vm.runInNewContext(
        extractMarked('DEVICE_UUID_GUARD') + '\n;deviceUuidOwnedByOther', sandbox);
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

// ===========================================================================
// Client subscription verify routes - REAL handlers via VM: a signature
// claimed by a DIFFERENT purchase is 400 PAYMENT_CONFLICT (never a 409 that
// old clients count as success); an identical same-user claim stays 200.
// ===========================================================================
const mkRes = () => {
    const out = { statusCode: 200, body: null };
    out.status = (c) => { out.statusCode = c; return out; };
    out.json = (b) => { out.body = b; return out; };
    return out;
};
const mkReq = (body) => ({ body, headers: { authorization: 'Bearer t' } });
const loadSubVerifyRoutes = (over = {}) => {
    const routes = {};
    evalServer('CLIENT_SUB_VERIFY_ROUTES', 'null', {
        app: { post: (p, h) => { routes[p] = h; } },
        jwt: { verify: () => ({ id: 1 }) },
        JWT_SECRET: 'test-secret',
        SOLANA_PAYMENT_WALLET: TREASURY,
        SKR_TOKEN_MINT: SKR_MINT,
        SKR_TOKEN_SYMBOL: 'SKR',
        SKR_SUBSCRIPTION_MULTIPLIER: 1,
        normalizeTierGb: (t) => ([100, 200, 400, 1000].includes(Number(t)) ? Number(t) : null),
        dbGetAsync: async () => null,
        paymentRecovery,
        getUserPlanGb: async () => 0,
        canDowngradeToTier: async () => true,
        getUserUsedBytes: async () => 0,
        getMinRequiredTier: async () => 0,
        PLAN_PRICES_USD: { 100: 10, 200: 20, 400: 40, 1000: 100 },
        verifySolanaTransaction: async () => ({ success: true, receivedAmount: 0.5, blockTime: Math.floor(Date.now() / 1000) - 60, memo: 'PhotoLynk:sub:100:monthly', sender: PAYER }),
        verifySkrTokenTransaction: async () => ({ success: true, receivedAmount: 100, blockTime: Math.floor(Date.now() / 1000) - 60, memo: 'PhotoLynk:sub:100:monthly', sender: PAYER }),
        respondVerificationFailure: (res, _r, msg) => res.status(400).json({ error: msg }),
        requirePaymentMemo: () => true,
        treasuryBoundUsers: async () => [],
        treasuryMarkSeen: async () => {},
        creditSolanaSubscription: async () => ({ expiresAt: Date.now() + 1e6, alreadyProcessed: false, planGb: 100, status: 'active' }),
        syncEcoUser: async () => {},
        ECO_BIND_MIN_TIER_GB: 400,
        ...over,
    });
    return routes;
};
const SUB_ROUTES = [['/api/solana/verify-payment', 'SOL'], ['/api/solana/verify-skr-payment', 'SKR']];

test('client verify routes (real code): foreign-claimed signature -> 400 PAYMENT_CONFLICT, no credit call', async () => {
    let creditCalls = 0;
    const routes = loadSubVerifyRoutes({
        dbGetAsync: async (sql) => {
            if (sql.includes('FROM users')) return { id: 1, email: 'a@b' };
            if (sql.includes('FROM solana_payments')) {
                return { tx_signature: 'sig', user_id: 2, tier_gb: 100, duration: 'monthly', payment_token: 'SOL' };
            }
            return null;
        },
        creditSolanaSubscription: async () => { creditCalls++; },
    });
    for (const [p] of SUB_ROUTES) {
        const res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig', tierGb: 100, duration: 'monthly' }), res);
        assert.equal(res.statusCode, 400, `${p} must be 400 (old clients treat any 409 as success)`);
        assert.equal(res.body.code, 'PAYMENT_CONFLICT');
        assert.equal(res.body.retryable, false);
        assert.notEqual(res.body.success, true);
    }
    assert.equal(creditCalls, 0);
});

test('client verify routes (real code): identical same-user claim -> 200 alreadyProcessed', async () => {
    for (const [p, token] of SUB_ROUTES) {
        const routes = loadSubVerifyRoutes({
            dbGetAsync: async (sql) => {
                if (sql.includes('FROM users')) return { id: 1, email: 'a@b' };
                if (sql.includes('FROM solana_payments')) {
                    return { tx_signature: 'sig', user_id: 1, tier_gb: 100, duration: 'monthly', payment_token: token };
                }
                if (sql.includes('FROM user_plans')) return { plan_gb: 100, status: 'active', expires_at: Date.now() + 1e6 };
                return null;
            },
        });
        const res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig', tierGb: 100, duration: 'monthly' }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.alreadyProcessed, true);
    }
});

test('client verify routes (real code): raced creditor PAYMENT_CONFLICT -> 400, never 200/409', async () => {
    for (const [p] of SUB_ROUTES) {
        const routes = loadSubVerifyRoutes({
            dbGetAsync: async (sql) => (sql.includes('FROM users') ? { id: 1, email: 'a@b' } : null),
            creditSolanaSubscription: async () => {
                const e = new Error('transaction belongs to a different purchase');
                e.code = 'PAYMENT_CONFLICT';
                throw e;
            },
        });
        const res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig', tierGb: 100, duration: 'monthly' }), res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'PAYMENT_CONFLICT');
        assert.equal(res.body.retryable, false);
    }
});

// ===========================================================================
// treasuryScanOnce - REAL scanner: a missing price band records a retryable
// 'rpc_error' seen row instead of dying silently (previously the sig was
// dropped for the run with no durable record).
// ===========================================================================
test('treasuryScanOnce (real code): null price band -> rpc_error marked, retryable', async () => {
    const marked = [];
    const scan = evalServer('TREASURY_SCAN_RUN', 'treasuryScanOnce', {
        treasuryScanInFlight: false,
        subscriptionReadiness: { wait: Promise.resolve(null) },
        SOLANA_PAYMENT_WALLET: TREASURY,
        SKR_TOKEN_MINT: SKR_MINT,
        SKR_TOKEN_DECIMALS: SKR_DECIMALS,
        SKR_SUBSCRIPTION_MULTIPLIER: 1,
        TREASURY_TX_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
        TREASURY_SCAN_TX_DELAY_MS: 0,
        PLAN_PRICES_USD: { 100: 10 },
        ECO_BIND_MIN_TIER_GB: 400,
        paymentRecovery,
        treasuryGetTokenAccounts: async () => [],
        treasuryCollectSignatures: async () => [{ signature: 'sig', slot: 1 }],
        dbAllAsync: async () => [],
        dbGetAsync: async () => null,
        treasuryMarkSeen: async (...a) => { marked.push(a); },
        treasuryFetchTransaction: async () => solTx({}),
        treasurySleep: async () => {},
        extractPhotoLynkMemo: () => 'PhotoLynk:sub:100:monthly:abcd1234',
        treasuryUserByPaymentCode: async () => ({ id: 7, email: 'u@x' }),
        treasuryBoundUsers: async () => [],
        getUserPlanGb: async () => 0,
        canDowngradeToTier: async () => true,
        getPriceBand: async () => null,
        evaluatePaymentAmount: () => { throw new Error('unreachable: band null'); },
        creditSolanaSubscription: async () => { throw new Error('unreachable: band null'); },
        USDC_MINT, USDT_MINT,
        syncEcoUser: async () => {},
        recordVerifiedPremiumPayment: async () => { throw new Error('not a premium'); },
        resumePremiumPayment: async () => { throw new Error('no premium resume'); },
        ...ECO_OFF,
    });
    const summary = await scan();
    assert.equal(summary.errors, 1);
    assert.equal(summary.credited, 0);
    const m = marked.find((a) => a[0] === 'sig');
    assert.ok(m, 'signature must get a durable seen row');
    assert.equal(m[1], 'rpc_error');
    assert.equal(m[2], 7);
    assert.match(m[3], /Price feed unavailable/);
});

// ===========================================================================
// GET /api/solana/payment-code - REAL route + REAL HMAC + REAL resolver:
// code issued only when it provably resolves back to the same single user.
// ===========================================================================
const mkCodeRoute = (over = {}) => {
    const routes = {};
    const fns = evalServer('PAYMENT_CODE_ROUTE', '({ paymentCodeFor, requirePaymentMemo })', {
        app: { get: (p, h) => { routes[p] = h; }, post: () => {} },
        jwt: { verify: () => ({ id: 7 }) },
        JWT_SECRET: 'test-secret',
        crypto: require('crypto'),
        treasuryUserByPaymentCode: async () => null,
        respondVerificationFailure: (res, r) => res.status(400).json({ error: r.error, code: r.code }),
        console,
        ...ECO_OFF,
        ...over,
    });
    return { route: routes['/api/solana/payment-code'], ...fns };
};
const mkCodeReq = (auth = 'Bearer t') => ({ headers: { authorization: auth } });
const mkCodeRes = () => {
    const out = { statusCode: 200, body: null, headers: {} };
    out.set = (k, v) => { out.headers[k] = v; };
    out.status = (c) => { out.statusCode = c; return out; };
    out.json = (b) => { out.body = b; return out; };
    return out;
};

test('payment-code route (real code): unique resolvable user -> 8-hex code + no-store', async () => {
    const { route, paymentCodeFor } = mkCodeRoute({
        treasuryUserByPaymentCode: async (code) => (code === paymentCodeFor(7) ? { id: 7, email: 'u@x' } : null),
    });
    const res = mkCodeRes();
    await route(mkCodeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.code, /^[0-9a-f]{8}$/);
    assert.equal(res.body.code, paymentCodeFor(7));
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('payment-code route (real code): unresolvable/deleted user or collision -> 503, NO code', async () => {
    // Resolver returns null (deleted user / collision / any mismatch)
    let { route } = mkCodeRoute({ treasuryUserByPaymentCode: async () => null });
    let res = mkCodeRes();
    await route(mkCodeReq(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'PAYMENT_ACCOUNT_UNAVAILABLE');
    assert.equal(res.body.code?.length === 8 && /^[0-9a-f]{8}$/.test(res.body.code), false);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    // Resolver resolves to a DIFFERENT user id
    ({ route } = mkCodeRoute({ treasuryUserByPaymentCode: async () => ({ id: 99, email: 'x@y' }) }));
    res = mkCodeRes();
    await route(mkCodeReq(), res);
    assert.equal(res.statusCode, 503);

    // DB failure -> 503, no code
    ({ route } = mkCodeRoute({ treasuryUserByPaymentCode: async () => { throw new Error('db down'); } }));
    res = mkCodeRes();
    await route(mkCodeReq(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'PAYMENT_ACCOUNT_UNAVAILABLE');

    // Expired/malformed JWT -> 401 unchanged
    ({ route } = mkCodeRoute({ jwt: { verify: () => { throw new Error('bad'); } } }));
    res = mkCodeRes();
    await route(mkCodeReq(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, undefined);
    res = mkCodeRes();
    await route(mkCodeReq(null), res);
    assert.equal(res.statusCode, 401);
});

test('payment-code resolver (real code): exactly-one match wins, zero/collision -> null', async () => {
    const code4 = (id) => `code${id}`; // paymentCodeFor stub: deterministic per id
    const resolve = evalServer('PAYMENT_CODE_RESOLVER', 'treasuryUserByPaymentCode', {
        paymentCodeFor: code4,
        dbAllAsync: async () => [{ id: 7, email: 'a' }, { id: 8, email: 'b' }],
        ...ECO_OFF,
    });
    assert.deepEqual(await resolve('code7'), { id: 7, email: 'a' });
    assert.equal(await resolve('nope'), null);
    const collide = evalServer('PAYMENT_CODE_RESOLVER', 'treasuryUserByPaymentCode', {
        paymentCodeFor: () => 'same',
        dbAllAsync: async () => [{ id: 7, email: 'a' }, { id: 8, email: 'b' }],
        ...ECO_OFF,
    });
    assert.equal(await collide('same'), null, 'collision must not pick a first match');
});

test('requirePaymentMemo (real code): legacy codeless memo still accepted; coded memo binds; mismatch rejects', () => {
    const { requirePaymentMemo, paymentCodeFor } = mkCodeRoute();
    const res = mkCodeRes();
    assert.equal(requirePaymentMemo(res, 'PhotoLynk:sub:100:monthly', 'PhotoLynk:sub:100:monthly', 7), true);
    assert.equal(requirePaymentMemo(res, `PhotoLynk:sub:100:monthly:${paymentCodeFor(7)}`, 'PhotoLynk:sub:100:monthly', 7), true);
    assert.equal(requirePaymentMemo(res, `PhotoLynk:sub:100:monthly:${paymentCodeFor(8)}`, 'PhotoLynk:sub:100:monthly', 7), false);
    assert.equal(res.body.code, 'MEMO_MISMATCH');
});

// ===========================================================================
// Admin-confirmed payer evidence: approvedRecoveryUsers + REAL
// treasuryBoundUsers (merged signed-proof + prior admin recovery) on temp DB.
// ===========================================================================
const loadBoundUsers = (h) => evalServer('TREASURY_BOUND_USERS', 'treasuryBoundUsers', {
    dbAllAsync: h.all,
    paymentRecovery,
});

const seedAdminApproval = async (h, { sig, userId, wallet, tier = 100, dur = 'monthly', paymentAt, admin = 'admin', detailMemo, source = 'admin_recovery', detail }) => {
    await h.run(
        `INSERT INTO solana_payments (user_id, tx_signature, sol_amount, payment_token, tier_gb, duration, created_at, verified_at) VALUES (?,?,?,?,?,?,?,?)`,
        [userId, sig, 0.5, 'SOL', tier, dur, paymentAt, paymentAt]);
    await h.run(
        `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [sig, userId, source, paymentAt, null, paymentAt + 1000, detail ?? JSON.stringify({ payer: wallet, memo: detailMemo ?? `PhotoLynk:sub:${tier}:${dur}`, admin }), Date.now()]);
};

test('treasuryBoundUsers (real code): prior admin recovery qualifies the payer - and only that', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const bound = loadBoundUsers(h);
    const T0 = Date.now() - 60_000;
    await h.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x'), (8, 'other@x')`);
    await seedAdminApproval(h, { sig: 'old1', userId: 7, wallet: PAYER, paymentAt: T0 });

    // Happy path: new payment later than the approval -> evidence for user 7
    let rows = await bound(PAYER, T0 + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows)),
        [{ id: 7, email: 'mike@x', source: 'admin_recovery' }]);

    // Same wallet, payment BEFORE the approval -> the approval postdates it, no evidence
    assert.deepEqual(JSON.parse(JSON.stringify(await bound(PAYER, T0 - 1))), []);

    // Different payer -> no evidence
    assert.deepEqual(JSON.parse(JSON.stringify(await bound(OTHER, T0 + 1))), []);

    // Malformed detail JSON -> dropped
    const { dbPath: db2 } = await makeFixtureDb();
    const h2 = await openDb(db2);
    await h2.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x')`);
    await seedAdminApproval(h2, { sig: 'old2', userId: 7, wallet: PAYER, paymentAt: T0, detail: '{not json' });
    assert.deepEqual(JSON.parse(JSON.stringify(await loadBoundUsers(h2)(PAYER, T0 + 1))), []);

    // Detail names a different payer -> dropped
    const { dbPath: db3 } = await makeFixtureDb();
    const h3 = await openDb(db3);
    await h3.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x')`);
    await seedAdminApproval(h3, { sig: 'old3', userId: 7, wallet: PAYER, paymentAt: T0, detail: JSON.stringify({ payer: OTHER, memo: 'PhotoLynk:sub:100:monthly', admin: 'admin' }) });
    assert.deepEqual(JSON.parse(JSON.stringify(await loadBoundUsers(h3)(PAYER, T0 + 1))), []);

    // Non-admin source -> dropped
    const { dbPath: db4 } = await makeFixtureDb();
    const h4 = await openDb(db4);
    await h4.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x')`);
    await seedAdminApproval(h4, { sig: 'old4', userId: 7, wallet: PAYER, paymentAt: T0, source: 'treasury_scan' });
    assert.deepEqual(JSON.parse(JSON.stringify(await loadBoundUsers(h4)(PAYER, T0 + 1))), []);

    // Ledger/payment tier inconsistent with the approved memo -> dropped
    const { dbPath: db5 } = await makeFixtureDb();
    const h5 = await openDb(db5);
    await h5.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x')`);
    await seedAdminApproval(h5, { sig: 'old5', userId: 7, wallet: PAYER, paymentAt: T0, tier: 200, detailMemo: 'PhotoLynk:sub:100:monthly' });
    assert.deepEqual(JSON.parse(JSON.stringify(await loadBoundUsers(h5)(PAYER, T0 + 1))), []);

    // Well-formed admin_recovery credit but NO matching solana_payments
    // ledger row -> the JOIN must drop it, no evidence.
    const { dbPath: db6 } = await makeFixtureDb();
    const h6 = await openDb(db6);
    await h6.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x')`);
    await h6.run(
        `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        ['orphan', 7, 'admin_recovery', T0, null, T0 + 1000, JSON.stringify({ payer: PAYER, memo: 'PhotoLynk:sub:100:monthly', admin: 'admin' }), Date.now()]);
    assert.deepEqual(JSON.parse(JSON.stringify(await loadBoundUsers(h6)(PAYER, T0 + 1))), []);

    // Ledger row exists but belongs to a DIFFERENT user than the credit row
    // -> the JOIN's user_id equality must drop it.
    const { dbPath: db7 } = await makeFixtureDb();
    const h7 = await openDb(db7);
    await h7.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x'), (8, 'other@x')`);
    await h7.run(
        `INSERT INTO solana_payments (user_id, tx_signature, sol_amount, payment_token, tier_gb, duration, created_at, verified_at) VALUES (?,?,?,?,?,?,?,?)`,
        [8, 'split', 0.5, 'SOL', 100, 'monthly', T0, T0]);
    await h7.run(
        `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        ['split', 7, 'admin_recovery', T0, null, T0 + 1000, JSON.stringify({ payer: PAYER, memo: 'PhotoLynk:sub:100:monthly', admin: 'admin' }), Date.now()]);
    assert.deepEqual(JSON.parse(JSON.stringify(await loadBoundUsers(h7)(PAYER, T0 + 1))), []);

    // Credit + ledger consistent but the USERS row is gone (deleted
    // account) -> the users JOIN must drop it.
    const { dbPath: db8 } = await makeFixtureDb();
    const h8 = await openDb(db8);
    await seedAdminApproval(h8, { sig: 'gone', userId: 7, wallet: PAYER, paymentAt: T0 });
    assert.deepEqual(JSON.parse(JSON.stringify(await loadBoundUsers(h8)(PAYER, T0 + 1))), []);

    await Promise.all([h.close(), h2.close(), h3.close(), h4.close(), h5.close(), h6.close(), h7.close(), h8.close()]);
});

test('treasuryBoundUsers (real code): signed proof + admin evidence merge; ambiguity returns ALL ids', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const bound = loadBoundUsers(h);
    const T0 = Date.now() - 60_000;
    await h.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x'), (8, 'other@x'), (9, 'third@x')`);
    // Signed proof: PAYER -> user 7
    await h.run(`INSERT INTO solana_wallet_bindings (wallet,user_id,verified_at) VALUES (?,?,?)`, [PAYER, 7, T0]);
    let rows = await bound(PAYER, T0 + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows)),
        [{ id: 7, email: 'mike@x', source: 'signed_wallet' }]);

    // Same user also admin-approved -> still one row, signed proof wins the label
    await seedAdminApproval(h, { sig: 'old6', userId: 7, wallet: PAYER, paymentAt: T0 - 1 });
    rows = await bound(PAYER, T0 + 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'signed_wallet');

    // A second admin-approved owner -> BOTH ids surface (conflict, never first-match)
    await seedAdminApproval(h, { sig: 'old7', userId: 8, wallet: PAYER, paymentAt: T0 - 1 });
    rows = await bound(PAYER, T0 + 1);
    assert.deepEqual(paymentRecovery.boundUserIds(rows).sort(), [7, 8]);
    await h.close();
});

// ===========================================================================
// Scanner auto-credit: a codeless payment from a payer an admin previously
// recovered is credited automatically - no confirmation step, no code.
// ===========================================================================
test('treasuryScanOnce (real code): codeless SOL+SKR auto-credit to admin-approved payer account', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const T0 = Date.now() - 3600_000;
    await h.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x')`);
    // Admin previously recovered a payment from PAYER to user 7 (explicit approval)
    await seedAdminApproval(h, { sig: 'oldSol', userId: 7, wallet: PAYER, paymentAt: T0 });
    await h.run(
        `INSERT INTO solana_payments (user_id, tx_signature, skr_amount, payment_token, tier_gb, duration, created_at, verified_at) VALUES (?,?,?,?,?,?,?,?)`,
        [7, 'oldSkr', 50, 'SKR', 100, 'monthly', T0, T0]);
    await h.run(
        `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        ['oldSkr', 7, 'admin_recovery', T0, null, T0 + 1000, JSON.stringify({ payer: PAYER, memo: 'PhotoLynk:sub:100:monthly', admin: 'admin' }), Date.now()]);

    const marked = [];
    const scan = evalServer('TREASURY_SCAN_RUN', 'treasuryScanOnce', {
        treasuryScanInFlight: false,
        subscriptionReadiness: { wait: Promise.resolve(null) },
        SOLANA_PAYMENT_WALLET: TREASURY,
        SKR_TOKEN_MINT: SKR_MINT,
        SKR_TOKEN_DECIMALS: SKR_DECIMALS,
        SKR_SUBSCRIPTION_MULTIPLIER: 1,
        TREASURY_TX_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
        TREASURY_SCAN_TX_DELAY_MS: 0,
        PLAN_PRICES_USD: { 100: 10 },
        ECO_BIND_MIN_TIER_GB: 400,
        paymentRecovery,
        treasuryGetTokenAccounts: async () => [],
        treasuryCollectSignatures: async () => [{ signature: 'newSol', slot: 1 }, { signature: 'newSkr', slot: 2 }],
        dbAllAsync: h.all,   // real SQL: retry queue + binding + admin-credit joins
        dbGetAsync: h.get,   // real SQL: seen rows + existing payments
        treasuryMarkSeen: async (...a) => { marked.push(a); },
        treasuryFetchTransaction: async (sig) => (sig === 'newSol' ? solTx({}) : skrTx({})),
        treasurySleep: async () => {},
        extractPhotoLynkMemo: () => 'PhotoLynk:sub:100:monthly', // codeless
        treasuryUserByPaymentCode: async () => null,
        treasuryBoundUsers: loadBoundUsers(h),                   // REAL merged resolver
        getUserPlanGb: async () => 0,
        canDowngradeToTier: async () => true,
        getPriceBand: async () => ({ min: 1, max: 100, latest: 10 }),
        evaluatePaymentAmount: () => ({ ok: true, minAcceptable: 0.1 }),
        creditSolanaSubscription: createSubscriptionCreditor(creditDefaults(dbPath)),
        USDC_MINT, USDT_MINT,
        syncEcoUser: async () => {},
        recordVerifiedPremiumPayment: async () => { throw new Error('not a premium'); },
        resumePremiumPayment: async () => { throw new Error('no premium resume'); },
        ...ECO_OFF,
    });
    const summary = await scan();
    assert.equal(summary.credited, 2, JSON.stringify(marked));
    const pays = await h.all(`SELECT tx_signature, user_id, payment_token FROM solana_payments WHERE tx_signature IN ('newSol','newSkr')`);
    assert.equal(pays.length, 2);
    assert.ok(pays.every((p) => p.user_id === 7));
    const audit = await h.all(`SELECT source, detail FROM solana_subscription_credits WHERE tx_signature IN ('newSol','newSkr')`);
    assert.ok(audit.every((a) => a.source === 'treasury_scan' && a.detail.includes('via=admin_recovery')),
        'credit detail must record admin_recovery provenance');
    // Second run: same signatures -> already recorded, not double-credited
    marked.length = 0;
    const summary2 = await scan();
    assert.equal(summary2.credited, 0);
    assert.equal((await h.all(`SELECT * FROM solana_payments WHERE tx_signature IN ('newSol','newSkr')`)).length, 2);
    await h.close();
});

test('real creditor concurrency: 3 distinct signatures stack +90d, repeat adds nothing', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const T0 = Date.now() - 60_000;
    await h.run(`INSERT INTO users (id, email) VALUES (7, 'mike@x')`);
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const sigs = ['c1', 'c2', 'c3'];
    const results = await Promise.all(sigs.map((s) => credit({
        userId: 7, signature: s, token: 'SOL', amount: 0.5, tierGb: 100,
        duration: 'monthly', paymentAt: T0, source: 'treasury_scan', detail: 'x',
    })));
    assert.ok(results.every((r) => !r.alreadyProcessed));
    const plan = await h.get(`SELECT * FROM user_plans WHERE user_id = 7`);
    const monthMs = PLAN_DURATION_MS.monthly;
    assert.ok(Math.abs(plan.expires_at - (T0 + 3 * monthMs)) < 10,
        `3 monthly credits must stack ~90d, got expires_at delta ${plan.expires_at - T0} vs ${3 * monthMs}`);
    // Re-crediting one signature is a no-op duplicate
    const dup = await credit({
        userId: 7, signature: 'c1', token: 'SOL', amount: 0.5, tierGb: 100,
        duration: 'monthly', paymentAt: T0, source: 'treasury_scan', detail: 'x',
    });
    assert.equal(dup.alreadyProcessed, true);
    const plan2 = await h.get(`SELECT * FROM user_plans WHERE user_id = 7`);
    assert.equal(plan2.expires_at, plan.expires_at, 'duplicate must not extend the term');
    assert.equal((await h.all(`SELECT * FROM solana_payments`)).length, 3);
    await h.close();
});

// ===========================================================================
// FINAL AUDIT BLOCK - mutation gates, CAS plan state, autopurge interlock,
// premium ledger-first resume, durable scanner pages, token-account union.
// Real server.js regions via VM markers; temp SQLite only; no live RPC.
// ===========================================================================

const Module = require('module');
const NFT_BALANCE_PATH = path.join(__dirname, '..', 'nft-service', 'balance.js');
const NFT_BALANCE_SRC = fs.readFileSync(NFT_BALANCE_PATH, 'utf8');
const mkNftDbPath = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nftbal-'));
    createdDirs.push(dir);
    return path.join(dir, 'nft.db');
};
const loadNftBalance = (nftDbPath) => {
    const nftRequire = Module.createRequire(NFT_BALANCE_PATH);
    const mod = { exports: {} };
    vm.runInNewContext(NFT_BALANCE_SRC, {
        require: (id) => (id === './config' ? { DB_PATH: nftDbPath } : nftRequire(id)),
        module: mod, exports: mod.exports, console,
        __dirname: path.dirname(NFT_BALANCE_PATH), __filename: NFT_BALANCE_PATH,
    });
    return mod.exports;
};
const nftAll = (nftDbPath, sql, params = []) => {
    const Database = Module.createRequire(NFT_BALANCE_PATH)('better-sqlite3');
    const d = new Database(nftDbPath);
    try { return d.prepare(sql).all(...params); } finally { d.close(); }
};

const ensurePlanRowStub = (h) => async (userId) => {
    await h.run(`INSERT OR IGNORE INTO user_plans (user_id, updated_at) VALUES (?, ?)`, [userId, Date.now()]);
    return h.get(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
};

const loadPremiumPlan = (h, dbPath, over = {}) => vm.runInNewContext(
    `${extractMarked('PREMIUM_PLAN_HELPERS')}\n${extractMarked('PREMIUM_RESUME')}\n;({ parsePremiumPurchaseTime, ensurePremiumStorageCapacity, ensurePremiumStorageCapacityUnlocked, activateSolanaPremiumPlan, resumePremiumPayment })`,
    {
        console, paymentRecovery, DB_PATH: dbPath,
        dbGetAsync: h.get, dbRunAsync: h.run, dbAllAsync: h.all,
        ensurePlanRow: ensurePlanRowStub(h),
        GB_BYTES: 1e9, readCapacityJson: () => null,
        PREMIUM_STORAGE_GB: 1000,
        PREMIUM_STORAGE_DURATION_MS: 365 * 24 * 60 * 60 * 1000,
        PREMIUM_PRICE_USD: 49.99,
        nftService: { balance: { setPremium: () => {}, recordPayment: () => {}, getPremiumStatus: () => ({ isPremium: true }), getBalance: () => ({ balanceUsd: 0 }) } },
        ...ECO_OFF,
        ...over,
    });

// --- mutation gates ---------------------------------------------------------
test('gates: 16 concurrent distinct-user credits all commit, no SQLITE_BUSY', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const N = 16;
    await h.run(`INSERT INTO users (id,email) VALUES ${Array.from({ length: N }, (_, i) => `(${i + 1},'u${i + 1}@x')`).join(',')}`);
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    const T0 = Date.now() - 60_000;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
        credit(basePayment({ userId: i + 1, paymentAt: T0 }))));
    assert.ok(results.every((r) => !r.alreadyProcessed));
    assert.equal((await h.all(`SELECT * FROM solana_payments`)).length, N);
    for (let i = 1; i <= N; i++) {
        const p = await h.get(`SELECT status, expires_at FROM user_plans WHERE user_id = ?`, [i]);
        assert.equal(p.status, 'active', `user ${i} not credited`);
        assert.ok(p.expires_at > Date.now());
    }
    await h.close();
});

// --- CAS plan state ---------------------------------------------------------
const loadPlanState = (h) => vm.runInNewContext(
    `${extractMarked('CAS_PLAN_STATE')}\n${extractMarked('QUOTA_PROFILE')}\n${extractMarked('SUBSCRIPTION_STATE')}\n;({ compareAndSetPlanState, resolveSubscriptionState, getUserQuotaProfileFromRow })`,
    {
        console,
        dbRunAsync: h.run, dbGetAsync: h.get, dbAllAsync: h.all,
        ensurePlanRow: ensurePlanRowStub(h),
        getUserUsedBytes: async () => 0, getUserQuotaBytes: async () => 0,
        TRIAL_COMPLIMENTARY_DAYS: 3, SUBSCRIPTION_GRACE_DAYS: 7, GB_BYTES: 1e9,
    });

test('compareAndSetPlanState (real code): stale snapshot cannot overwrite a committed renewal', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await h.run(`INSERT INTO users (id,email) VALUES (1,'a@x')`);
    const old = Date.now() - 1000;
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,updated_at) VALUES (1,100,'active',?,?)`, [old, old]);
    const { compareAndSetPlanState } = loadPlanState(h);
    const snapshot = await h.get(`SELECT * FROM user_plans WHERE user_id = 1`);
    // A renewal commits AFTER the snapshot was read.
    const renewal = old + 100 * 864e5;
    await h.run(`UPDATE user_plans SET status='active', expires_at=?, updated_at=? WHERE user_id=1`, [renewal, Date.now()]);
    const applied = await compareAndSetPlanState(1, snapshot, { status: 'expired', deletedAt: Date.now(), now: Date.now() });
    assert.equal(applied, false, 'CAS must refuse to tombstone a row renewed after the snapshot');
    const after = await h.get(`SELECT status, expires_at, deleted_at FROM user_plans WHERE user_id=1`);
    assert.equal(after.status, 'active');
    assert.equal(after.expires_at, renewal);
    assert.ok(!after.deleted_at);
    // Control: a CAS whose tuple still matches DOES apply.
    const fresh = await h.get(`SELECT * FROM user_plans WHERE user_id=1`);
    const g = Date.now() + 1000;
    assert.equal(await compareAndSetPlanState(1, fresh, { status: 'grace', graceUntil: g, now: Date.now() }), true);
    const after2 = await h.get(`SELECT status, grace_until FROM user_plans WHERE user_id=1`);
    assert.equal(after2.status, 'grace');
    assert.equal(after2.grace_until, g);
    await h.close();
});

test('resolveSubscriptionState (real code): lazy transitions write once; readOnly never writes', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email) VALUES (1,'a@x'),(2,'b@x'),(3,'c@x')`);
    // user 1: expired paid plan, no grace yet -> transitions to grace
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,updated_at) VALUES (1,100,'active',?,?)`, [now - 3600e3, now - 3600e3]);
    // user 2: trial whose complimentary window already lapsed
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,trial_until,updated_at) VALUES (2,50,'trial',?,?)`, [now - 10 * 864e5, now - 10 * 864e5]);
    // user 3: live paid plan -> stays active
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,updated_at) VALUES (3,100,'active',?,?)`, [now + 10 * 864e5, now]);
    const { resolveSubscriptionState } = loadPlanState(h);

    const r1 = await resolveSubscriptionState(1);
    assert.equal(r1.status, 'grace');
    const row1 = await h.get(`SELECT status, grace_until FROM user_plans WHERE user_id=1`);
    assert.equal(row1.status, 'grace');
    assert.ok(row1.grace_until > now, 'grace_until written by the transition');

    const r2 = await resolveSubscriptionState(2);
    assert.equal(r2.status, 'trial_complimentary_expired');
    const row2 = await h.get(`SELECT status, deleted_at FROM user_plans WHERE user_id=2`);
    assert.equal(row2.status, 'expired');
    assert.ok(row2.deleted_at > 0, 'complimentary expiry must tombstone');

    const r3 = await resolveSubscriptionState(3);
    assert.equal(r3.status, 'active');

    // readOnly computes state but never transitions the stored row.
    await h.run(`INSERT INTO users (id,email) VALUES (4,'d@x')`);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,updated_at) VALUES (4,100,'active',?,?)`, [now - 3600e3, now]);
    const r4 = await resolveSubscriptionState(4, { readOnly: true });
    assert.equal(r4.status, 'grace');
    const row4 = await h.get(`SELECT status, grace_until FROM user_plans WHERE user_id=4`);
    assert.equal(row4.status, 'active', 'readOnly must not write');
    assert.ok(!row4.grace_until);
    await h.close();
});

test('projection never drives the grace/retention machine: lapsed benefit -> grace -> expired+deleted_at', async () => {
    // A projection-written 'expired' would satisfy the CAS guard
    // (`row.status !== 'expired'`) without deleted_at ever being set - the
    // retention clock would never start. Projection may only mirror
    // expires_at; resolveSubscriptionState owns the status transitions.
    const { h, dbPath } = await mkEcoAdminDb();
    const now = Date.now();
    const clock = { t: now };
    const svc = createEcosystemService({ sqlite3, dbPath, now: () => clock.t });
    await svc.initialize();
    await h.run(`INSERT INTO users (id,email) VALUES (1,'a@x')`);
    // Lapsed paid plan still marked 'active' - exactly what a real row looks
    // like before the lazy state machine has touched it.
    const lapsedExp = now - 864e5;
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,updated_at) VALUES (1,400,'active',?,?)`, [lapsedExp, now]);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    // Projection absorbs the lapsed plan as a member-local benefit, mirrors
    // the expiry, and must NOT touch status/grace_until/deleted_at.
    await svc.resolveIdentity('photolynk', '1', { project: true });
    const proj = await h.get(`SELECT status, expires_at, grace_until, deleted_at FROM user_plans WHERE user_id = 1`);
    assert.equal(proj.status, 'active', 'projection must NOT write expired - status is the state machine\'s');
    assert.equal(Number(proj.expires_at), lapsedExp, 'projection mirrors the resolved expiry');
    assert.equal(proj.grace_until, null);
    assert.equal(proj.deleted_at, null, 'no tombstone from projection');

    // The real CAS state machine then transitions exactly as before the core.
    const { resolveSubscriptionState } = loadPlanState(h);
    const r1 = await resolveSubscriptionState(1);
    assert.equal(r1.status, 'grace');
    const g = await h.get(`SELECT status, grace_until, deleted_at FROM user_plans WHERE user_id = 1`);
    assert.equal(g.status, 'grace');
    assert.ok(Number(g.grace_until) > now, 'grace window written');
    assert.equal(g.deleted_at, null);
    // Grace lapses -> expired + deleted_at (retention clock starts).
    await h.run(`UPDATE user_plans SET grace_until = ? WHERE user_id = 1`, [now - 1]);
    const r2 = await resolveSubscriptionState(1);
    assert.equal(r2.status, 'expired');
    const fin = await h.get(`SELECT status, deleted_at FROM user_plans WHERE user_id = 1`);
    assert.equal(fin.status, 'expired');
    assert.ok(Number(fin.deleted_at) > 0, 'deleted_at set by the state machine, not projection');
    await h.close();
});

// --- autopurge interlock -----------------------------------------------------
const loadPurge = (h, dbPath, fakeFs) => vm.runInNewContext(
    `${extractMarked('USER_PURGE')}\n;({ purgeUserEverywhere })`,
    {
        console, path, paymentRecovery, DB_PATH: dbPath,
        require: (id) => (id === '../nft-service' ? { balance: { deleteUserData: () => ({}) } } : require(id)),
        dbGetAsync: h.get, dbAllAsync: h.all, dbRunAsync: h.run,
        PURGE_RETENTION_DAYS: 10, TRIAL_COMPLIMENTARY_DAYS: 3,
        CLOUD_DIR: '/nonexistent/cloud', CHUNKS_DIR: '/nonexistent/chunks',
        NFT_DIR: '/nonexistent/nft', UPLOAD_DIR: '/nonexistent/up',
        fs: fakeFs,
        getStealthCloudAllPossibleUserKeys: () => ['u7', 's7'],
        sanitizeUserKey: (v) => v,
        getWalletTransferInboxDir: () => null,
        clearStealthCloudDedupCachesForKeys: () => {},
        safeDeleteFromTable: async (t, w, p) => (await h.run(`DELETE FROM ${t} WHERE ${w}`, p)).changes || 0,
        ...ECO_OFF,
    });

test('purge gate (real code): a concurrent credit wins the account gate - zero fs deletes', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email,user_uuid,storage_uuid) VALUES (7,'m@x','u7','s7')`);
    await h.run(`INSERT INTO user_plans (user_id,status,deleted_at,updated_at) VALUES (7,'expired',?,?)`, [now - 30 * 864e5, now - 30 * 864e5]);
    const rmCalls = [];
    const { purgeUserEverywhere } = loadPurge(h, dbPath, {
        existsSync: () => true,
        promises: { rm: async (d) => { rmCalls.push(d); } },
    });
    const credit = createSubscriptionCreditor(creditDefaults(dbPath));
    // The credit registers on the account gate first; the purge queues behind
    // it and must see the renewed entitlement when it finally runs.
    const creditP = credit(basePayment({ userId: 7, paymentAt: now - 60_000 }));
    await new Promise((r) => setImmediate(r));
    const purgeRes = await purgeUserEverywhere(7, { reason: 'autopurge_retention' });
    const creditRes = await creditP;
    assert.equal(creditRes.alreadyProcessed, false);
    assert.equal(purgeRes.skipped, true);
    assert.equal(purgeRes.reason, 'entitlement_changed');
    assert.equal(rmCalls.length, 0, 'no filesystem deletion may run once the plan is live again');
    assert.ok(await h.get(`SELECT id FROM users WHERE id = 7`), 'user row must survive');
    await h.close();
});

test('stale-plan migration (real code): live NULL-expiry premium never gets a tombstone', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email) VALUES (1,'a@x'),(2,'b@x'),(3,'c@x'),(4,'d@x'),(5,'e@x'),(6,'f@x')`);
    // u1: expired paid plan BUT live premium with NULL expiry - a legacy
    // grant must not be treated as expired premium.
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,premium_gb,status,expires_at,updated_at) VALUES (1,100,1000,'active',?,?)`, [now - 3600e3, now]);
    // u2: same with premium_expires_at = 0 - also treated as live legacy.
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,premium_gb,premium_expires_at,status,expires_at,updated_at) VALUES (2,100,1000,0,'active',?,?)`, [now - 3600e3, now]);
    // u3: control - expired paid plan, no premium -> transitions to grace.
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,updated_at) VALUES (3,100,'active',?,?)`, [now - 3600e3, now]);
    // u4: lapsed complimentary trial + NULL-expiry premium -> no tombstone.
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,premium_gb,status,trial_until,updated_at) VALUES (4,50,1000,'trial',?,?)`, [now - 10 * 864e5, now]);
    // u5: control - grace over, premium expiry POSITIVE and past -> tombstone.
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,premium_gb,premium_expires_at,status,grace_until,updated_at) VALUES (5,100,500,?,'grace',?,?)`, [now - 864e5, now - 3600e3, now]);
    const migrate = vm.runInNewContext(
        `${extractMarked('CAS_PLAN_STATE')}\n${extractMarked('STALE_PLAN_MIGRATION')}\n;migrateStalePlanStates`,
        {
            console, dbAllAsync: h.all, dbRunAsync: h.run, dbGetAsync: h.get,
            TRIAL_COMPLIMENTARY_DAYS: 3, SUBSCRIPTION_GRACE_DAYS: 7,
        });
    await migrate();
    const p1 = await h.get(`SELECT status, deleted_at FROM user_plans WHERE user_id=1`);
    assert.equal(p1.deleted_at ?? 0, 0, 'NULL-expiry premium must not be tombstoned (staleActive branch)');
    const p2 = await h.get(`SELECT status, deleted_at FROM user_plans WHERE user_id=2`);
    assert.equal(p2.deleted_at ?? 0, 0, 'zero-expiry premium must not be tombstoned either');
    const p3 = await h.get(`SELECT status FROM user_plans WHERE user_id=3`);
    assert.equal(p3.status, 'grace', 'control: expired paid plan still transitions');
    const p4 = await h.get(`SELECT status, deleted_at FROM user_plans WHERE user_id=4`);
    assert.equal(p4.deleted_at ?? 0, 0, 'trial+NULL-expiry premium keeps its slot');
    assert.equal(p4.status, 'trial');
    const p5 = await h.get(`SELECT status, deleted_at FROM user_plans WHERE user_id=5`);
    assert.equal(p5.status, 'expired', 'control: positive-past premium expiry still tombstones');
    assert.ok(p5.deleted_at > 0);
    await h.close();
});

test('purge gate (real code): NULL-expiry premium blocks autopurge at the recheck', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email,user_uuid,storage_uuid) VALUES (7,'m@x','u7','s7')`);
    await h.run(`INSERT INTO user_plans (user_id,status,premium_gb,deleted_at,updated_at) VALUES (7,'expired',1000,?,?)`, [now - 30 * 864e5, now - 30 * 864e5]);
    const rmCalls = [];
    const { purgeUserEverywhere } = loadPurge(h, dbPath, {
        existsSync: () => true,
        promises: { rm: async (d) => { rmCalls.push(d); } },
    });
    const res = await purgeUserEverywhere(7, { reason: 'autopurge_retention' });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'entitlement_changed');
    assert.equal(rmCalls.length, 0);
    assert.ok(await h.get(`SELECT id FROM users WHERE id = 7`));
    await h.close();
});

test('purge gate (real code): still-expired user is deleted normally', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email,user_uuid,storage_uuid) VALUES (7,'m@x','u7','s7')`);
    await h.run(`INSERT INTO user_plans (user_id,status,deleted_at,updated_at) VALUES (7,'expired',?,?)`, [now - 30 * 864e5, now - 30 * 864e5]);
    const rmCalls = [];
    const { purgeUserEverywhere } = loadPurge(h, dbPath, {
        existsSync: () => true,
        promises: { rm: async (d) => { rmCalls.push(d); } },
    });
    const res = await purgeUserEverywhere(7, { reason: 'autopurge_retention' });
    assert.equal(res.ok, true);
    assert.ok(!res.skipped);
    assert.ok(rmCalls.length > 0, 'filesystem dirs removed');
    assert.ok(!(await h.get(`SELECT id FROM users WHERE id = 7`)), 'user row deleted');
    await h.close();
});

// --- premium purchase-time parsing + capacity + activation -------------------
test('parsePremiumPurchaseTime (real code): ms number, ISO-Z, SQLite UTC all parse; junk -> null', () => {
    const { parsePremiumPurchaseTime } = loadPremiumPlan(
        { get: async () => null, run: async () => ({}), all: async () => [] }, '/unused.db');
    const iso = Date.parse('2024-01-15T10:30:00Z');
    assert.equal(parsePremiumPurchaseTime(iso), iso);
    assert.equal(parsePremiumPurchaseTime('2024-01-15T10:30:00Z'), iso);
    assert.equal(parsePremiumPurchaseTime('2024-01-15 10:30:00'), iso, 'SQLite UTC must equal ISO-Z');
    assert.equal(parsePremiumPurchaseTime('2024-01-15 10:30:00.5'), null, 'non-exact SQLite form rejected');
    for (const bad of [null, undefined, '', 'garbage', '2024-13-99 99:99:99', -5, 0, NaN, Infinity]) {
        assert.equal(parsePremiumPurchaseTime(bad), null, `must reject ${String(bad)}`);
    }
});

test('premium capacity (real code): two users race one slot - writer gate serializes', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await h.run(`INSERT INTO users (id,email) VALUES (1,'a@x'),(2,'b@x')`);
    const fns = loadPremiumPlan(h, dbPath, {
        readCapacityJson: () => ({ totalBytes: 1020 * 1e9 }), // exactly one 1000GB slot + 20GB safety
    });
    const now = Date.now();
    const [r1, r2] = await Promise.all([
        paymentRecovery.withAccountMutation(dbPath, 1, () => fns.activateSolanaPremiumPlan(1, now, { now, paymentType: 'sol' })),
        paymentRecovery.withAccountMutation(dbPath, 2, () => fns.activateSolanaPremiumPlan(2, now, { now, paymentType: 'sol' })),
    ]);
    assert.equal([r1, r2].filter((r) => r.storageAllocated).length, 1, 'exactly one allocation may win the last slot');
    assert.equal([r1, r2].filter((r) => r.capacityExceeded).length, 1);
    const allocated = await h.all(`SELECT user_id FROM user_plans WHERE premium_gb = 1000`);
    assert.equal(allocated.length, 1);
    await h.close();
});

test('activateSolanaPremiumPlan (real code): no yearly reset; paid monthly type preserved; expired not revived', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x'),(8,'n@x'),(9,'o@x')`);
    // user 7: live paid monthly - premium must not steal its payment_type
    const liveExp = now + 20 * 864e5;
    const payAt = now - 10 * 864e5;
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at) VALUES (7,100,'active',?,'solana',?,?)`, [liveExp, payAt, payAt]);
    const fns = loadPremiumPlan(h, dbPath);
    const purchased = now - 10 * 864e5;

    const r1 = await fns.activateSolanaPremiumPlan(7, purchased, { now, paymentType: 'sol' });
    assert.equal(r1.storageAllocated, true);
    const p1 = await h.get(`SELECT * FROM user_plans WHERE user_id=7`);
    assert.equal(p1.premium_gb, 1000);
    assert.equal(p1.payment_type, 'solana', 'live paid plan keeps its provenance');
    assert.equal(p1.payment_at, payAt);
    assert.equal(p1.expires_at, liveExp, 'subscription expiry untouched');
    assert.equal(p1.plan_gb, 100);
    const exp1 = p1.premium_expires_at;
    assert.ok(Math.abs(exp1 - (purchased + 365 * 864e5)) < 2000);

    // Repeat activation must NOT roll the year forward.
    const later = now + 5 * 864e5;
    await fns.activateSolanaPremiumPlan(7, purchased, { now: later, paymentType: 'sol' });
    const p2 = await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=7`);
    assert.equal(p2.premium_expires_at, exp1, 'repeat activation must not extend the year');

    // A LONGER incoming expiry still wins via MAX (never shorten).
    const longerExp = exp1 + 10 * 864e5;
    await h.run(`UPDATE user_plans SET premium_expires_at=? WHERE user_id=7`, [longerExp]);
    await fns.activateSolanaPremiumPlan(7, purchased, { now: later, paymentType: 'sol' });
    const p3 = await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=7`);
    assert.equal(p3.premium_expires_at, longerExp, 'existing longer expiry preserved');

    // user 8: known purchase >1y ago + live premium WITHOUT expiry -> the
    // proven (past) anchor is persisted once; no fresh year, no revive.
    const oldPurchase = now - 400 * 864e5;
    await h.run(`INSERT INTO user_plans (user_id,premium_gb,status,updated_at) VALUES (8,1000,'none',?)`, [now]);
    const r8 = await fns.activateSolanaPremiumPlan(8, oldPurchase, { now, paymentType: 'sol' });
    assert.equal(r8.storageAllocated, false);
    const p8 = await h.get(`SELECT premium_gb, premium_expires_at FROM user_plans WHERE user_id=8`);
    assert.equal(p8.premium_gb, 1000);
    assert.equal(p8.premium_expires_at, oldPurchase + 365 * 864e5, 'proven past anchor persisted - not an unlimited NULL grant');
    assert.ok(p8.premium_expires_at < now);

    // user 9: fully expired stored expiry must not revive either.
    const oldExp = now - 5 * 864e5;
    await h.run(`INSERT INTO user_plans (user_id,premium_gb,premium_expires_at,status,updated_at) VALUES (9,1000,?,'none',?)`, [oldExp, now]);
    const r9 = await fns.activateSolanaPremiumPlan(9, oldPurchase, { now, paymentType: 'sol' });
    assert.equal(r9.storageAllocated, false);
    const p9 = await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=9`);
    assert.equal(p9.premium_expires_at, oldExp, 'existing positive expiry is never rewritten');
    await h.close();
});

test('activateSolanaPremiumPlan (real code): past purchase anchor + NEWER live expiry still reports allocated', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x'),(8,'n@x')`);
    const fns = loadPremiumPlan(h, dbPath);
    // user 7: an old receipt arrives while the stored expiry is still live -
    // the live allocation must report as allocated, with expiry preserved.
    const liveExp = now + 200 * 864e5;
    const oldPurchase = now - 400 * 864e5;
    await h.run(`INSERT INTO user_plans (user_id,premium_gb,premium_expires_at,status,updated_at) VALUES (7,1000,?,'none',?)`, [liveExp, now]);
    const r7 = await fns.activateSolanaPremiumPlan(7, oldPurchase, { now, paymentType: 'sol' });
    assert.equal(r7.storageAllocated, true, 'live existing allocation is not reported as missing');
    assert.equal(r7.premiumGb, 1000);
    const p7 = await h.get(`SELECT premium_gb, premium_expires_at FROM user_plans WHERE user_id=7`);
    assert.equal(p7.premium_gb, 1000);
    assert.equal(p7.premium_expires_at, liveExp, 'live expiry preserved - no extension, no truncation');
    // Control: same past anchor against an EXPIRED allocation -> not allocated.
    await h.run(`INSERT INTO user_plans (user_id,premium_gb,premium_expires_at,status,updated_at) VALUES (8,1000,?,'none',?)`, [now - 864e5, now]);
    const r8 = await fns.activateSolanaPremiumPlan(8, oldPurchase, { now, paymentType: 'sol' });
    assert.equal(r8.storageAllocated, false);
    assert.equal(r8.premiumGb, 0);
    await h.close();
});

// --- nft-service balance.js idempotency (REAL module, temp DB) ---------------
test('nft balance (real module): setPremium/recordPayment idempotent; foreign receipt -> PAYMENT_CONFLICT', async () => {
    const nftDb = mkNftDbPath();
    const bal = loadNftBalance(nftDb);
    bal.setPremium(7, 'receiptA', 'solana');
    assert.equal(bal.isPremium(7), true);
    // Same user, same receipt: no mint-count/expiry reset, bookkeeping repaired idempotently.
    bal.setPremium(7, 'receiptA', 'solana');
    bal.recordPayment(7, 'premium_49', 49.99, 'receiptA', 'solana');
    bal.recordPayment(7, 'premium_49', 49.99, 'receiptA', 'solana');
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_payments WHERE receipt_id='receiptA'`).length, 1);
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_used_receipts WHERE receipt_id='receiptA'`).length, 1);
    // Foreign user reusing the same receipt -> hard conflict both ways.
    assert.throws(() => bal.setPremium(8, 'receiptA', 'solana'), (e) => e.code === 'PAYMENT_CONFLICT');
    assert.throws(() => bal.recordPayment(8, 'premium_49', 49.99, 'receiptA', 'solana'), (e) => e.code === 'PAYMENT_CONFLICT');
    assert.equal(bal.isPremium(8), false, 'foreign receipt must not grant premium');
    // A receipt-less recordPayment still inserts (legacy IAP callers).
    bal.recordPayment(7, 'deposit_15', 15, null, 'ios');
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_payments WHERE user_id=7 AND payment_type='deposit_15'`).length, 1);
});

// --- resumePremiumPayment: ledger-first, retryable, conflict-checked ---------
const seedPremiumLedger = async (h, { sig, userId = 7, token = 'SOL', duration = 'premium', tierGb = 0, createdAt, applied = null }) =>
    h.run(
        `INSERT INTO solana_payments (user_id, tx_signature, sol_amount, skr_amount, payment_token, tier_gb, duration, created_at, verified_at, entitlement_applied_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [userId, sig, token === 'SOL' ? 0.5 : null, token === 'SKR' ? 106.2 : null, token, tierGb, duration, createdAt, createdAt, applied]);

test('resumePremiumPayment (real code): failed attempts retry to completion exactly once', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const nftDb = mkNftDbPath();
    const bal = loadNftBalance(nftDb);
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x')`);
    const createdAt = Date.now() - 30 * 864e5;
    await seedPremiumLedger(h, { sig: 'prem1', createdAt });

    // Drive the REAL resumePremiumPayment with a balance module whose effects
    // fail in sequence: NFT premium down, then tax record down, then healthy.
    let failSetPremium = true, failRecord = true;
    const flaky = {
        ...bal,
        setPremium: (u, s, p) => { if (failSetPremium) throw new Error('nft premium down'); return bal.setPremium(u, s, p); },
        recordPayment: (...a) => { if (failRecord) throw new Error('tax record down'); return bal.recordPayment(...a); },
    };
    const fns = loadPremiumPlan(h, dbPath, { nftService: { balance: flaky } });
    const marker = () => h.get(`SELECT entitlement_applied_at FROM solana_payments WHERE tx_signature='prem1'`);

    // Attempt 1: setPremium throws before any effect.
    await assert.rejects(fns.resumePremiumPayment({ user_id: 7, tx_signature: 'prem1' }), /nft premium down/);
    assert.equal((await marker()).entitlement_applied_at, null);
    assert.equal(bal.isPremium(7), false);

    // Attempt 2: NFT premium lands, tax record throws -> marker still NULL.
    failSetPremium = false;
    await assert.rejects(fns.resumePremiumPayment({ user_id: 7, tx_signature: 'prem1' }), /tax record down/);
    assert.equal((await marker()).entitlement_applied_at, null, 'partial effects must not mark the row complete');
    assert.equal(bal.isPremium(7), true, 'NFT effect persists for the retry to build on');

    // Attempt 3: full success - marker stamped, premium_49 recorded once.
    failRecord = false;
    const out = await fns.resumePremiumPayment({ user_id: 7, tx_signature: 'prem1' });
    assert.equal(out.applied, true);
    assert.ok((await marker()).entitlement_applied_at > 0);
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_payments WHERE receipt_id='prem1'`).length, 1, 'premium_49 recorded exactly once');
    const planA = await h.get(`SELECT premium_gb, premium_expires_at, payment_type FROM user_plans WHERE user_id=7`);
    assert.equal(planA.premium_gb, 1000);
    assert.ok(Math.abs(planA.premium_expires_at - (createdAt + 365 * 864e5)) < 2000, 'year anchored to purchase, not to retry time');
    assert.equal(planA.payment_type, 'premium_sol');

    // Attempt 4: marker set -> complete no-op, year NOT reset, no extra rows.
    const out2 = await fns.resumePremiumPayment({ user_id: 7, tx_signature: 'prem1' });
    assert.equal(out2.applied, false);
    const planB = await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=7`);
    assert.equal(planB.premium_expires_at, planA.premium_expires_at, 'completed marker => no re-activation, no year reset');
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_used_receipts WHERE receipt_id='prem1'`).length, 1);
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_payments WHERE receipt_id='prem1'`).length, 1);
    await h.close();
});

test('resumePremiumPayment (real code): foreign/malformed canonical row -> PAYMENT_CONFLICT before any effect', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const nftDb = mkNftDbPath();
    const bal = loadNftBalance(nftDb);
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x'),(8,'n@x')`);
    const createdAt = Date.now() - 60_000;
    await seedPremiumLedger(h, { sig: 'premF', userId: 8, createdAt });   // row belongs to user 8
    await seedPremiumLedger(h, { sig: 'premSub', userId: 7, tierGb: 100, duration: 'monthly', createdAt }); // not premium
    const fns = loadPremiumPlan(h, dbPath, { nftService: { balance: bal } });
    await assert.rejects(fns.resumePremiumPayment({ user_id: 7, tx_signature: 'premF' }), (e) => e.code === 'PAYMENT_CONFLICT');
    await assert.rejects(fns.resumePremiumPayment({ user_id: 7, tx_signature: 'premSub' }), (e) => e.code === 'PAYMENT_CONFLICT');
    await assert.rejects(fns.resumePremiumPayment({ user_id: 7, tx_signature: 'missing' }), (e) => e.code === 'PAYMENT_CONFLICT');
    assert.equal(bal.isPremium(7), false);
    assert.equal(bal.isPremium(8), false);
    assert.equal((await h.get(`SELECT entitlement_applied_at FROM solana_payments WHERE tx_signature='premF'`)).entitlement_applied_at, null);
    await h.close();
});

// --- /api/premium/activate-storage: unknown-origin anchoring ------------------
test('activate-storage route (real code): unknown origin anchors once, SQLite-UTC and expired handled', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x'),(8,'n@x'),(9,'o@x')`);
    const sqliteUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

    const fns = loadPremiumPlan(h, dbPath);
    const nftStatus = {};
    const routes = {};
    vm.runInNewContext(`${extractMarked('PREMIUM_ACTIVATE_ROUTE')}\n;null`, {
        console, paymentRecovery, DB_PATH: dbPath,
        app: { post: (p, mw, handler) => { routes[p] = (req, res) => { mw(req, res, () => {}); return handler(req, res); }; } },
        authenticateToken: (req, res, next) => { req.user = { id: req.body.__uid }; next(); },
        nftService: { balance: { getPremiumStatus: (uid) => nftStatus[uid] || { isPremium: true, purchasedAt: null } } },
        ensurePlanRow: ensurePlanRowStub(h),
        parsePremiumPurchaseTime: fns.parsePremiumPurchaseTime,
        activateSolanaPremiumPlan: fns.activateSolanaPremiumPlan,
        resolveSubscriptionState: async () => ({ status: 'active' }),
        dbGetAsync: h.get, dbRunAsync: h.run,
        PREMIUM_STORAGE_DURATION_MS: 365 * 864e5,
    });
    const route = routes['/api/premium/activate-storage'];
    const call = (uid) => { const res = mkRes(); return route({ body: { __uid: uid }, headers: {} }, res).then(() => res); };

    // user 7: known purchase via SQLite-UTC purchased_at -> anchor = purchase.
    const p7 = now - 10 * 864e5;
    nftStatus[7] = { isPremium: true, purchasedAt: sqliteUtc(p7) };
    const res7 = await call(7);
    assert.equal(res7.statusCode, 200);
    const e1 = (await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=7`)).premium_expires_at;
    assert.ok(Math.abs(e1 - (p7 + 365 * 864e5)) < 2000, `anchor must be the purchase, got delta ${e1 - p7}`);
    // Second call: same anchor, no re-extension.
    const res7b = await call(7);
    assert.equal(res7b.statusCode, 200);
    assert.equal((await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=7`)).premium_expires_at, e1);

    // user 8: NO known purchase, no stored expiry -> anchors at now ONCE;
    // the stored expiry then anchors every later call (never re-extends).
    const res8 = await call(8);
    assert.equal(res8.statusCode, 200);
    const e8 = (await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=8`)).premium_expires_at;
    assert.ok(e8 > now, 'first unknown call allocates a live year');
    await new Promise((r) => setTimeout(r, 25));
    const res8b = await call(8);
    assert.equal(res8b.statusCode, 200);
    const e8b = (await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=8`)).premium_expires_at;
    assert.equal(e8b, e8, 'unknown-origin repeat derives anchor from stored expiry - no rolling year');

    // user 9: known purchase >1y old + premium_gb>0 + NULL expiry -> past
    // anchor persisted once, storage NOT revived, repeats keep the anchor.
    const p9 = now - 400 * 864e5;
    nftStatus[9] = { isPremium: true, purchasedAt: sqliteUtc(p9) };
    await h.run(`INSERT INTO user_plans (user_id,premium_gb,status,updated_at) VALUES (9,1000,'none',?)`, [now]);
    const res9 = await call(9);
    assert.equal(res9.statusCode, 200);
    const p9row = await h.get(`SELECT premium_gb, premium_expires_at FROM user_plans WHERE user_id=9`);
    const p9Anchor = Math.floor(p9 / 1000) * 1000 + 365 * 864e5; // SQLite UTC truncates to seconds
    assert.equal(p9row.premium_expires_at, p9Anchor, 'proven past anchor persisted');
    assert.ok(p9row.premium_expires_at < now, 'expired premium is NOT revived');
    await call(9);
    assert.equal((await h.get(`SELECT premium_expires_at FROM user_plans WHERE user_id=9`)).premium_expires_at, p9Anchor);
    await h.close();
});

// --- premium verify routes: foreign -> 400, same-user resume -> 200 -----------
const loadPremiumVerifyRoutes = (over = {}) => {
    const routes = {};
    evalServer('PREMIUM_VERIFY_ROUTES', 'null', {
        app: { post: (p, h) => { routes[p] = h; } },
        jwt: { verify: () => ({ id: 1 }) },
        JWT_SECRET: 'test-secret',
        SOLANA_PAYMENT_WALLET: TREASURY,
        SKR_TOKEN_MINT: SKR_MINT,
        SKR_TOKEN_DECIMALS: SKR_DECIMALS,
        SKR_TOKEN_SYMBOL: 'SKR',
        SKR_PREMIUM_MULTIPLIER: 1,
        PREMIUM_PRICE_USD: 49.99,
        paymentRecovery,
        dbGetAsync: async () => null,
        dbRunAsync: async () => ({}),
        verifySolanaTransaction: async () => ({ success: true, receivedAmount: 0.5, blockTime: Math.floor(Date.now() / 1000) - 60, memo: 'PhotoLynk:premium:0:premium', sender: PAYER }),
        verifySkrTokenTransaction: async () => ({ success: true, receivedRawAmount: 106207279, blockTime: Math.floor(Date.now() / 1000) - 60, memo: 'PhotoLynk:premium:0:premium', sender: PAYER }),
        requirePaymentMemo: () => true,
        resumePremiumPayment: async (row) => ({ applied: true, isPremium: true, premiumGb: 1000, balanceUsd: 0, cloudQuotaBytes: 1e12 }),
        treasuryBoundUsers: async () => [],
        treasuryMarkSeen: async () => {},
        resolveSubscriptionState: async () => ({ status: 'active' }),
        respondVerificationFailure: (res, _r, msg) => res.status(400).json({ error: msg }),
        ecoEnsureAccount: async () => ({}),
        ecoFloorSub: async () => {},
        console,
        ...over,
    });
    return routes;
};
const PREMIUM_ROUTES = [['/api/solana/verify-premium-payment', 'premium'], ['/api/solana/verify-premium-skr-payment', 'premium_skr']];

test('premium verify routes (real code): foreign-claimed signature -> 400 PAYMENT_CONFLICT, never 409', async () => {
    let resumeCalls = 0;
    const routes = loadPremiumVerifyRoutes({
        dbGetAsync: async (sql) => {
            if (sql.includes('FROM users')) return { id: 1, email: 'a@b' };
            if (sql.includes('FROM solana_payments')) {
                return { tx_signature: 'sig', user_id: 2, tier_gb: 0, duration: 'premium', payment_token: 'SOL' };
            }
            return null;
        },
        resumePremiumPayment: async () => { resumeCalls++; return {}; },
    });
    for (const [p] of PREMIUM_ROUTES) {
        const res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig' }), res);
        assert.equal(res.statusCode, 400, `${p}: old clients treat any 409 as success - foreign sig must be 400`);
        assert.equal(res.body.code, 'PAYMENT_CONFLICT');
        assert.equal(res.body.retryable, false);
    }
    assert.equal(resumeCalls, 0, 'no effects may run for a foreign row');
});

test('premium verify routes (real code): same-user unapplied row -> resume + 200', async () => {
    const resumed = [];
    for (const [p, dur] of PREMIUM_ROUTES) {
        resumed.length = 0;
        const token = dur === 'premium' ? 'SOL' : 'SKR';
        const routes = loadPremiumVerifyRoutes({
            dbGetAsync: async (sql) => {
                if (sql.includes('FROM users')) return { id: 1, email: 'a@b' };
                if (sql.includes('FROM solana_payments')) {
                    return { tx_signature: 'sig', user_id: 1, tier_gb: 0, duration: dur, payment_token: token, entitlement_applied_at: null };
                }
                return null;
            },
            resumePremiumPayment: async (row) => { resumed.push(row); return { applied: true, isPremium: true, premiumGb: 1000, balanceUsd: 0, cloudQuotaBytes: 1e12 }; },
        });
        const res = mkRes();
        await routes[p](mkReq({ txSignature: '  sig  ' }), res);
        assert.equal(res.statusCode, 200, `${p}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.success, true);
        assert.equal(res.body.isPremium, true);
        assert.equal(resumed.length, 1, 'resume invoked exactly once');
        assert.equal(resumed[0].tx_signature, 'sig', 'canonicalized signature row passed to resume');
    }
});

// --- scanner: durable onPage persistence + pending replay ---------------------
test('collectTreasurySignatures: onPage persist failure never advances the cursor', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const st = stateStore(h);
    const rpcOn = async () => mkSigs('p', 1, 3);
    const out = await collectTreasurySignatures({
        endpoints: ['ep'], address: 'A', rpcOn,
        onPage: async () => { throw new Error('persist failed'); },
        ...st, sleep: async () => {}, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    assert.equal(out.length, 0, 'unpersisted head page must not be consumed');
    assert.equal(await st.getState(JSON.stringify(['history_v2', 'ep', 'A'])), null, 'cursor must not advance');
    // Retry with a healthy onPage: same head page is collected and persisted.
    const persisted = [];
    const out2 = await collectTreasurySignatures({
        endpoints: ['ep'], address: 'A', rpcOn,
        onPage: async (entries) => { persisted.push(...entries.map((e) => e.signature)); },
        ...st, sleep: async () => {}, pageLimit: 100, maxSigs: 500, maxSweepPages: 4,
    });
    assert.equal(out2.length, 3);
    assert.deepEqual(persisted, out2.map((e) => e.signature));
    await h.close();
});

test('treasuryCollectSignatures (real code): every page row lands in treasury_scan_seen as pending', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const history = mkSigs('w', 1, 5);
    const collect = evalServer('TREASURY_COLLECT_WRAPPER', 'treasuryCollectSignatures', {
        console, paymentRecovery,
        treasuryRpcOn: async (ep, m, params) => history.slice(0, params[1]?.limit || 100),
        treasurySleep: async () => {},
        dbGetAsync: h.get, dbRunAsync: h.run,
        TREASURY_RPC_ENDPOINTS: ['ep1', 'ep2'],
        TREASURY_SCAN_PAGE_LIMIT: 100, TREASURY_SCAN_MAX_SIGS: 500,
    });
    const out = await collect(TREASURY);
    assert.equal(out.length, 5);
    const seen = await h.all(`SELECT signature, outcome FROM treasury_scan_seen ORDER BY signature`);
    assert.deepEqual(seen.map((r) => r.signature).sort(), out.map((e) => e.signature).sort());
    assert.ok(seen.every((r) => r.outcome === 'pending'));
    // Persist failure -> collector drops the page and holds the cursor.
    const { dbPath: db2 } = await makeFixtureDb();
    const h2 = await openDb(db2);
    const collect2 = evalServer('TREASURY_COLLECT_WRAPPER', 'treasuryCollectSignatures', {
        console, paymentRecovery,
        treasuryRpcOn: async () => mkSigs('q', 1, 3),
        treasurySleep: async () => {},
        dbGetAsync: h2.get,
        dbRunAsync: async (sql) => { if (sql.includes('treasury_scan_seen')) throw new Error('db full'); return h2.run(sql); },
        TREASURY_RPC_ENDPOINTS: ['ep1'],
        TREASURY_SCAN_PAGE_LIMIT: 100, TREASURY_SCAN_MAX_SIGS: 500,
    });
    const out2 = await collect2(TREASURY);
    assert.equal(out2.length, 0, 'unpersisted pages are dropped for retry, not consumed');
    assert.equal((await h2.all(`SELECT * FROM treasury_scan_seen`)).length, 0);
    assert.equal((await h2.all(`SELECT * FROM treasury_scan_state`)).length, 0, 'no cursor advancement on persist failure');
    await h.close();
    await h2.close();
});

// --- token-account discovery: union across endpoints + persisted cache --------
test('treasuryGetTokenAccounts (real code): union of all endpoints + cache; cache survives empty', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    // Persisted discovery cache lives in treasury_scan_state['skr_token_accounts'].
    await h.run(`INSERT INTO treasury_scan_state (key, value, updated_at) VALUES ('skr_token_accounts', ?, ?)`,
        [JSON.stringify(['cachedOld']), Date.now()]);
    const loadDiscovery = (rpcImpl) => evalServer('TOKEN_ACCOUNT_DISCOVERY', 'treasuryGetTokenAccounts', {
        console, paymentRecovery,
        treasuryRpcOn: rpcImpl,
        dbGetAsync: h.get, dbRunAsync: h.run,
        TREASURY_RPC_ENDPOINTS: ['ep1', 'ep2'],
        SOLANA_PAYMENT_WALLET: TREASURY, SKR_TOKEN_MINT: SKR_MINT,
    });
    const readCache = async () => JSON.parse((await h.get(`SELECT value FROM treasury_scan_state WHERE key='skr_token_accounts'`)).value);
    // ep1 empty + ep2 nonempty + persisted cache -> union of all three sources.
    const disc1 = loadDiscovery(async (ep) => (ep === 'ep1' ? { value: [] } : { value: [{ pubkey: 'newRpcAcct' }] }));
    const u1 = await disc1();
    assert.ok(u1.includes('cachedOld') && u1.includes('newRpcAcct'), `union must merge cache+RPC, got ${u1}`);
    assert.deepEqual((await readCache()).sort(), ['cachedOld', 'newRpcAcct'], 'union persisted');
    // ALL endpoints legitimately empty -> cached union still returned (never wiped).
    const disc2 = loadDiscovery(async () => ({ value: [] }));
    const u2 = await disc2();
    assert.ok(u2.includes('cachedOld') && u2.includes('newRpcAcct'), 'all-empty discovery must retain persisted history');
    // All endpoints fail -> cached union.
    const disc3 = loadDiscovery(async () => { throw new Error('rpc down'); });
    const u3 = await disc3();
    assert.ok(u3.includes('cachedOld') && u3.includes('newRpcAcct'));
    // Malformed results are skipped like errors; ep2 still contributes.
    const disc4 = loadDiscovery(async (ep) => (ep === 'ep1' ? { value: 'not-array' } : { value: [{ pubkey: 'acctX' }] }));
    const u4 = await disc4();
    assert.ok(u4.includes('acctX') && u4.includes('cachedOld'));
    // Malformed ELEMENTS are filtered: non-strings, blank and null pubkeys are
    // dropped; a padded string is stored trimmed.
    const disc5 = loadDiscovery(async () => ({
        value: [{ pubkey: '  acctY  ' }, { pubkey: 42 }, { pubkey: '   ' }, { pubkey: null }, {}],
    }));
    const u5 = await disc5();
    assert.ok(u5.includes('acctY'), 'padded pubkey must be stored trimmed');
    assert.ok(!u5.includes('') && !u5.includes('42') && !u5.includes('null'),
        `malformed elements leaked: ${JSON.stringify(u5)}`);
    await h.close();
});

// --- scanner premium auto-recovery (SOL + SKR, no manual action) --------------
const loadScanner = (over = {}) => evalServer('TREASURY_SCAN_RUN', 'treasuryScanOnce', {
    console,
    treasuryScanInFlight: false,
    subscriptionReadiness: { wait: Promise.resolve(null) },
    SOLANA_PAYMENT_WALLET: TREASURY,
    SKR_TOKEN_MINT: SKR_MINT,
    SKR_TOKEN_DECIMALS: SKR_DECIMALS,
    SKR_SUBSCRIPTION_MULTIPLIER: 1,
    SKR_PREMIUM_MULTIPLIER: 1,
    PREMIUM_PRICE_USD: 49.99,
    TREASURY_TX_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
    TREASURY_SCAN_TX_DELAY_MS: 0,
    PLAN_PRICES_USD: { 100: 10 },
    ECO_BIND_MIN_TIER_GB: 400,
    paymentRecovery,
    treasuryGetTokenAccounts: async () => [],
    treasuryCollectSignatures: async () => [],
    treasurySleep: async () => {},
    getUserPlanGb: async () => 0,
    canDowngradeToTier: async () => true,
    getPriceBand: async () => ({ min: 1, max: 100, latest: 10 }),
    evaluatePaymentAmount: () => ({ ok: true, minAcceptable: 0.1 }),
    creditSolanaSubscription: async () => { throw new Error('not a subscription'); },
    USDC_MINT, USDT_MINT,
    syncEcoUser: async () => {},
    recordVerifiedPremiumPayment: async () => { throw new Error('not a premium'); },
    resumePremiumPayment: async () => { throw new Error('no premium resume'); },
    ...ECO_OFF,
    ...over,
});

test('treasuryScanOnce (real code): SOL+SKR premium memos auto-recover end-to-end - no manual step', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const nftDb = mkNftDbPath();
    const bal = loadNftBalance(nftDb);
    const createdSlot = Date.now() - 60_000;
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x')`);
    // PAYER is cryptographically bound to user 7 (signed_wallet path).
    await h.run(`INSERT INTO solana_wallet_bindings (wallet,user_id,verified_at) VALUES (?,?,?)`, [PAYER, 7, createdSlot]);
    const premiumFns = loadPremiumPlan(h, dbPath, { nftService: { balance: bal } });
    const scan = loadScanner({
        resumePremiumPayment: premiumFns.resumePremiumPayment,
        recordVerifiedPremiumPayment: stubRecordVerifiedPremium(h),
        dbAllAsync: h.all, dbGetAsync: h.get, dbRunAsync: h.run,
        treasuryCollectSignatures: async (addr) =>
            addr === TREASURY ? [{ signature: 'premSol', slot: 1 }] : [{ signature: 'premSkr', slot: 2 }],
        treasuryGetTokenAccounts: async () => ['acctSKR'],
        treasuryMarkSeen: async (sig, outcome, uid, detail) =>
            h.run(`INSERT OR REPLACE INTO treasury_scan_seen (signature,seen_at,outcome,user_id,detail) VALUES (?,?,?,?,?)`, [sig, Date.now(), outcome, uid, detail]),
        treasuryFetchTransaction: async (sig) => (sig === 'premSol' ? solTx({}) : skrTx({})),
        extractPhotoLynkMemo: () => 'PhotoLynk:premium:0:premium',
        treasuryUserByPaymentCode: async () => null,
        treasuryBoundUsers: loadBoundUsers(h),
        getPriceBand: async (asset) => (asset === 'skr' ? { min: 0.9, max: 1.1, latest: 1 } : { min: 95, max: 110, latest: 100 }),
        evaluatePaymentAmount: evaluatePayment, // REAL evaluator
    });
    const summary = await scan();
    const seenRows = await h.all(`SELECT signature, outcome, detail FROM treasury_scan_seen`);
    assert.equal(summary.errors, 0, JSON.stringify(seenRows));
    const rows = await h.all(`SELECT * FROM solana_payments WHERE tx_signature IN ('premSol','premSkr') ORDER BY tx_signature`);
    assert.equal(rows.length, 2);
    const solRow = rows.find((r) => r.tx_signature === 'premSol');
    const skrRow = rows.find((r) => r.tx_signature === 'premSkr');
    assert.equal(solRow.user_id, 7); assert.equal(solRow.payment_token, 'SOL'); assert.equal(solRow.duration, 'premium'); assert.equal(solRow.tier_gb, 0);
    assert.equal(skrRow.payment_token, 'SKR'); assert.equal(skrRow.duration, 'premium_skr');
    assert.ok(solRow.entitlement_applied_at > 0 && skrRow.entitlement_applied_at > 0, 'both completed ledger-first');
    // NFT + plan effects applied exactly once.
    assert.equal(bal.isPremium(7), true);
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_payments WHERE user_id=7 AND payment_type='premium_49'`).length, 2);
    const plan = await h.get(`SELECT premium_gb, premium_expires_at FROM user_plans WHERE user_id=7`);
    assert.equal(plan.premium_gb, 1000);
    // Subscription state untouched: no status/expires_at credit for premium.
    assert.equal((await h.get(`SELECT status FROM user_plans WHERE user_id=7`)).status !== 'active', true);
    const seen = await h.all(`SELECT signature, outcome FROM treasury_scan_seen WHERE signature IN ('premSol','premSkr')`);
    assert.deepEqual(seen.map((r) => r.outcome).sort(), ['credited_premium', 'credited_premium']);
    // Re-run: rows already complete -> 'already_credited', nothing re-applied.
    const summary2 = await scan();
    assert.equal(summary2.errors, 0);
    assert.equal((await h.all(`SELECT * FROM solana_payments WHERE tx_signature IN ('premSol','premSkr')`)).length, 2);
    assert.equal(nftAll(nftDb, `SELECT * FROM nft_payments WHERE user_id=7 AND payment_type='premium_49'`).length, 2);
    await h.close();
});

test('treasuryScanOnce (real code): unapplied premium ledger rows resume at scan start; failures stay retryable', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const nftDb = mkNftDbPath();
    const bal = loadNftBalance(nftDb);
    const createdAt = Date.now() - 5 * 864e5;
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x')`);
    await seedPremiumLedger(h, { sig: 'pendPrem', userId: 7, token: 'SKR', duration: 'premium_skr', createdAt });
    const premiumFns = loadPremiumPlan(h, dbPath, { nftService: { balance: bal } });
    const scan = loadScanner({
        resumePremiumPayment: premiumFns.resumePremiumPayment,
        dbAllAsync: h.all, dbGetAsync: h.get, dbRunAsync: h.run,
        treasuryCollectSignatures: async () => [],
        treasuryGetTokenAccounts: async () => [],
        treasuryMarkSeen: async () => {},
        treasuryFetchTransaction: async () => null,
        extractPhotoLynkMemo: () => null,
        treasuryUserByPaymentCode: async () => null,
        treasuryBoundUsers: loadBoundUsers(h),
        verifyTreasuryTransaction: async () => ({ success: false }),
    });
    const summary = await scan();
    assert.equal(summary.errors, 0);
    const row = await h.get(`SELECT entitlement_applied_at FROM solana_payments WHERE tx_signature='pendPrem'`);
    assert.ok(row.entitlement_applied_at > 0, 'startup resume completed the row');
    assert.equal(bal.isPremium(7), true);
    const plan = await h.get(`SELECT premium_gb, premium_expires_at, payment_type FROM user_plans WHERE user_id=7`);
    assert.equal(plan.premium_gb, 1000);
    assert.ok(Math.abs(plan.premium_expires_at - (createdAt + 365 * 864e5)) < 2000, 'anchored to original purchase');
    assert.equal(plan.payment_type, 'premium_skr');
    // Failure case: resume throws -> marker stays NULL, next run retries.
    await seedPremiumLedger(h, { sig: 'pendFail', userId: 7, createdAt });
    const scan2 = loadScanner({
        resumePremiumPayment: async () => { throw new Error('nft down'); },
        dbAllAsync: h.all, dbGetAsync: h.get, dbRunAsync: h.run,
        treasuryCollectSignatures: async () => [],
        treasuryGetTokenAccounts: async () => [],
        treasuryMarkSeen: async () => {},
        treasuryFetchTransaction: async () => null,
        extractPhotoLynkMemo: () => null,
        treasuryUserByPaymentCode: async () => null,
        treasuryBoundUsers: loadBoundUsers(h),
        verifyTreasuryTransaction: async () => ({ success: false }),
    });
    await scan2();
    assert.equal((await h.get(`SELECT entitlement_applied_at FROM solana_payments WHERE tx_signature='pendFail'`)).entitlement_applied_at, null,
        'a failed resume leaves the row retryable');
    await h.close();
});

test('treasuryScanOnce (real code): collected sig with unapplied ledger row resumes via existing-row branch', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const nftDb = mkNftDbPath();
    const bal = loadNftBalance(nftDb);
    const createdAt = Date.now() - 2 * 864e5;
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x')`);
    await seedPremiumLedger(h, { sig: 'pendLate', userId: 7, createdAt });
    const premiumFns = loadPremiumPlan(h, dbPath, { nftService: { balance: bal } });
    const scan = loadScanner({
        resumePremiumPayment: premiumFns.resumePremiumPayment,
        // The startup resume batch deliberately misses this row (as if it
        // were beyond the LIMIT-100 window) - the existing-row branch must
        // still complete it, with the canonical row's tx_signature intact.
        dbAllAsync: async (sql, p) => (String(sql).includes('entitlement_applied_at IS NULL') ? [] : h.all(sql, p)),
        dbGetAsync: h.get, dbRunAsync: h.run,
        treasuryCollectSignatures: async (addr) => (addr === TREASURY ? [{ signature: 'pendLate', slot: 1 }] : []),
        treasuryGetTokenAccounts: async () => [],
        treasuryMarkSeen: async (sig, outcome, uid, detail) =>
            h.run(`INSERT OR REPLACE INTO treasury_scan_seen (signature,seen_at,outcome,user_id,detail) VALUES (?,?,?,?,?)`, [sig, Date.now(), outcome, uid, detail]),
        treasuryFetchTransaction: async () => { throw new Error('fetch must not run - row already in ledger'); },
        extractPhotoLynkMemo: () => null,
        treasuryUserByPaymentCode: async () => null,
        treasuryBoundUsers: loadBoundUsers(h),
        verifyTreasuryTransaction: async () => ({ success: false }),
    });
    const summary = await scan();
    assert.equal(summary.errors, 0);
    assert.equal(summary.credited, 1, 'existing-row resume counts as credited');
    const rows = await h.all(`SELECT * FROM solana_payments WHERE tx_signature='pendLate'`);
    assert.equal(rows.length, 1, 'no second ledger insert');
    assert.ok(rows[0].entitlement_applied_at > 0, 'marker completed by the existing-row resume');
    assert.equal(bal.isPremium(7), true);
    assert.equal((await h.get(`SELECT premium_gb FROM user_plans WHERE user_id=7`)).premium_gb, 1000);
    const seen = await h.get(`SELECT outcome FROM treasury_scan_seen WHERE signature='pendLate'`);
    assert.equal(seen.outcome, 'credited_premium');
    await h.close();
});

test('treasuryScanOnce (real code): sticky pending skip permits entries outside the first-100 retry rows', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    // 100 older retryable rows fill the retry queue; a newer 'pending' entry
    // must STILL be processed from the head even though it missed LIMIT 100.
    for (let i = 0; i < 100; i++) {
        await h.run(`INSERT INTO treasury_scan_seen (signature, seen_at, outcome) VALUES (?,?,?)`, [`old${i}`, i + 1, 'no_user']);
    }
    await h.run(`INSERT INTO treasury_scan_seen (signature, seen_at, outcome) VALUES ('pend1',?,'pending')`, [Date.now()]);
    const marked = [];
    const scan = loadScanner({
        dbAllAsync: h.all, dbGetAsync: h.get, dbRunAsync: h.run,
        treasuryCollectSignatures: async () => [{ signature: 'pend1', slot: 1 }],
        treasuryMarkSeen: async (sig, outcome, uid, detail) => { marked.push([sig, outcome]); },
        treasuryFetchTransaction: async () => solTx({}), // no memo
        extractPhotoLynkMemo: () => null,
        treasuryUserByPaymentCode: async () => null,
        treasuryBoundUsers: loadBoundUsers(h),
        verifyTreasuryTransaction: async () => ({ success: true }),
    });
    await scan();
    const m = marked.find((a) => a[0] === 'pend1');
    assert.ok(m, 'pending head entry must be processed even outside the first-100 retry window');
    assert.equal(m[1], 'no_memo');
    await h.close();
});

// --- pendingReplay guard in client sub routes ---------------------------------
test('pendingReplay guard (real code): legacy codeless replay needs a verified binding', async () => {
    for (const [p] of SUB_ROUTES) {
        // Unbound replay -> 400 retryable PAYMENT_ACCOUNT_UNVERIFIED
        let routes = loadSubVerifyRoutes({
            dbGetAsync: async (sql) => (sql.includes('FROM users') ? { id: 1, email: 'a@b' } : null),
            treasuryBoundUsers: async () => [],
        });
        let res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig', tierGb: 100, duration: 'monthly', pendingReplay: true }), res);
        assert.equal(res.statusCode, 400, `${p}: unbound legacy replay must not credit`);
        assert.equal(res.body.code, 'PAYMENT_ACCOUNT_UNVERIFIED');
        assert.equal(res.body.retryable, true);

        // Ambiguous binding (two users) -> same rejection
        routes = loadSubVerifyRoutes({
            dbGetAsync: async (sql) => (sql.includes('FROM users') ? { id: 1, email: 'a@b' } : null),
            treasuryBoundUsers: async () => [{ id: 1 }, { id: 2 }],
        });
        res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig', tierGb: 100, duration: 'monthly', pendingReplay: true }), res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'PAYMENT_ACCOUNT_UNVERIFIED');

        // Bound to exactly this user -> proceeds to credit
        routes = loadSubVerifyRoutes({
            dbGetAsync: async (sql) => (sql.includes('FROM users') ? { id: 1, email: 'a@b' } : null),
            treasuryBoundUsers: async () => [{ id: 1 }],
        });
        res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig', tierGb: 100, duration: 'monthly', pendingReplay: true }), res);
        assert.equal(res.statusCode, 200, `${p}: trusted binding must allow replay, got ${JSON.stringify(res.body)}`);

        // A coded memo never needs the flag (the code itself binds the user)
        const codedMemo = 'PhotoLynk:sub:100:monthly:abcd1234';
        routes = loadSubVerifyRoutes({
            dbGetAsync: async (sql) => (sql.includes('FROM users') ? { id: 1, email: 'a@b' } : null),
            treasuryBoundUsers: async () => { throw new Error('must not be called for coded memos'); },
            verifySolanaTransaction: async () => ({ success: true, receivedAmount: 0.5, blockTime: Math.floor(Date.now() / 1000) - 60, memo: codedMemo, sender: PAYER }),
            verifySkrTokenTransaction: async () => ({ success: true, receivedAmount: 100, blockTime: Math.floor(Date.now() / 1000) - 60, memo: codedMemo, sender: PAYER }),
        });
        res = mkRes();
        await routes[p](mkReq({ txSignature: 'sig', tierGb: 100, duration: 'monthly', pendingReplay: true }), res);
        assert.equal(res.statusCode, 200, `${p}: coded replay must not consult bound users`);
    }
});

// --- eco mirror: stale floor cannot shorten; admin set-until still exact ------
test('ecoApplySub (real code): stale renewal floor cannot shorten; admin set-until overrides', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    const now = Date.now();
    await h.run(`INSERT INTO users (id,email) VALUES (7,'m@x')`);
    const far = now + 300 * 864e5;
    await h.run(`INSERT INTO stealthlynk_subs (account_id, sub_until, source_app, provenance, updated_at) VALUES ('acct7', ?, 'photolynk', 'sub-paid', ?)`, [far, now]);
    await h.run(`INSERT INTO ecosystem_members (account_id, app, identity) VALUES ('acct7','photolynk','7'), ('acct7','paceseeker','devhash1')`);
    await h.run(`INSERT INTO paceseeker_devices (device_hash, sub_until) VALUES ('devhash1', ?)`, [far]);
    const ecoApplySub = evalServer('ECO_APPLY_SUB', 'ecoApplySub', {
        console,
        dbGetAsync: h.get, dbRunAsync: h.run, dbAllAsync: h.all,
        ECO_PL_TIER_GB: 100,
        ...ECO_OFF,
    });
    // Stale floor (earlier expiry) must NOT shrink the shared record.
    const near = now + 10 * 864e5;
    const ret = await ecoApplySub('acct7', near, { sourceApp: 'photolynk', kind: 'paid', provenance: 'sub-paid', plTierGb: 100 });
    assert.equal(ret, far, 'effective expiry returned, not the stale floor');
    const sub = await h.get(`SELECT sub_until, source_app, provenance FROM stealthlynk_subs WHERE account_id='acct7'`);
    assert.equal(sub.sub_until, far);
    // The member materialization uses the EFFECTIVE max, not the stale value.
    const planRow = await h.get(`SELECT expires_at FROM user_plans WHERE user_id=7`);
    assert.equal(planRow.expires_at, far, 'member plan carries the effective max expiry');
    assert.equal((await h.get(`SELECT sub_until FROM paceseeker_devices WHERE device_hash='devhash1'`)).sub_until, far);
    // A LATER floor still raises the expiry.
    const farther = now + 400 * 864e5;
    await ecoApplySub('acct7', farther, { sourceApp: 'photolynk', kind: 'paid', provenance: 'sub-paid', plTierGb: 100 });
    assert.equal((await h.get(`SELECT sub_until FROM stealthlynk_subs WHERE account_id='acct7'`)).sub_until, farther);
    // Explicit admin set-until CAN shorten (intentional administrative override).
    const adminSet = now + 30 * 864e5;
    await ecoApplySub('acct7', adminSet, { sourceApp: 'admin', kind: 'paid', provenance: 'set-until' });
    assert.equal((await h.get(`SELECT sub_until FROM stealthlynk_subs WHERE account_id='acct7'`)).sub_until, adminSet,
        'admin set-until applies exactly');
    await h.close();
});

const extractBetween = (startAnchor, endAnchor) => {
    const i = SERVER_SRC.indexOf(startAnchor);
    const j = i >= 0 ? SERVER_SRC.indexOf(endAnchor, i + startAnchor.length) : -1;
    assert.ok(i >= 0 && j > i, `anchors not found: ${startAnchor} .. ${endAnchor}`);
    return SERVER_SRC.slice(i, j);
};

const loadReadOnlyResolver = (over = {}) => vm.runInNewContext(
    `${extractMarked('CAS_PLAN_STATE')}\n${extractMarked('QUOTA_PROFILE')}\n${extractMarked('SUBSCRIPTION_STATE')}\n;({ compareAndSetPlanState, resolveSubscriptionState, getUserQuotaProfileFromRow })`,
    {
        console,
        dbRunAsync: async () => { throw new Error('db write must not run'); },
        dbGetAsync: async () => { throw new Error('db read must not run'); },
        dbAllAsync: async () => { throw new Error('db read must not run'); },
        ensurePlanRow: async () => { throw new Error('planRow supplied - no lazy row'); },
        getUserUsedBytes: async () => { throw new Error('knownUsedBytes supplied'); },
        getUserQuotaBytes: async () => { throw new Error('knownQuotaBytes supplied'); },
        TRIAL_COMPLIMENTARY_DAYS: 3, SUBSCRIPTION_GRACE_DAYS: 7, GB_BYTES: 1e9,
        ...over,
    });

test('resolveSubscriptionState readOnly supplied-row: expired/active premium, live grace, paid', async () => {
    const { resolveSubscriptionState } = loadReadOnlyResolver();
    const now = Date.now();
    const resolve = (row) => resolveSubscriptionState(1, { readOnly: true, planRow: row, knownUsedBytes: 0, knownQuotaBytes: 0 });
    assert.equal((await resolve({ status: 'expired', expires_at: now - 40 * 864e5, premium_gb: 1000, premium_expires_at: now - 864e5 })).status, 'expired');
    assert.equal((await resolve({ status: 'expired', expires_at: now - 40 * 864e5, premium_gb: 1000, premium_expires_at: now + 864e5 })).status, 'premium_only');
    assert.equal((await resolve({ status: 'grace', expires_at: now - 864e5, grace_until: now + 5 * 864e5, premium_gb: 1000, premium_expires_at: now + 864e5 })).status, 'grace');
    assert.equal((await resolve({ status: 'active', expires_at: now + 10 * 864e5, plan_gb: 400 })).status, 'active');
});

test('resolveSubscriptionState readOnly supplied snapshot performs no DB access', async () => {
    const { resolveSubscriptionState, getUserQuotaProfileFromRow } = loadReadOnlyResolver();
    const now = Date.now();
    const st = await resolveSubscriptionState(9, { readOnly: true, planRow: { status: 'expired', expires_at: now - 40 * 864e5, premium_gb: 1000, premium_expires_at: now + 864e5 }, knownUsedBytes: 7, knownQuotaBytes: 1000e9 });
    assert.equal(st.status, 'premium_only');
    assert.equal(st.usedBytes, 7);
    assert.equal(st.quotaBytes, 1000e9);
    const activePrem = getUserQuotaProfileFromRow({ status: 'active', plan_gb: 400, expires_at: now + 864e5, premium_gb: 1000, premium_expires_at: now + 864e5 });
    assert.equal(activePrem.totalQuotaGb, 1400);
    const expiredPrem = getUserQuotaProfileFromRow({ status: 'active', plan_gb: 400, expires_at: now + 864e5, premium_gb: 1000, premium_expires_at: now - 1000 });
    assert.equal(expiredPrem.premiumGb, 0);
    assert.equal(expiredPrem.totalQuotaGb, 400);
    assert.equal(Math.floor(expiredPrem.totalQuotaGb * 1e9), 400e9);
});

const loadAdminUsersRoute = (over = {}) => {
    const captured = {};
    vm.runInNewContext(
        `${extractMarked('CAS_PLAN_STATE')}\n${extractMarked('QUOTA_PROFILE')}\n${extractMarked('SUBSCRIPTION_STATE')}\n${extractBetween("app.get('/admin/api/users', adminAuth", 'Admin API: delete user completely')}`,
        {
            console, fs, path, Date, JSON, Number, String, Math, Set, Map,
            app: { get: (p, ...a) => { captured.handler = a[a.length - 1]; } },
            adminAuth: () => { },
            require: (id) => { if (id === '../nft-service') throw new Error('nft-service unavailable'); return require(id); },
            NFT_DIR: '/nonexistent-nft-dir',
            TRIAL_COMPLIMENTARY_DAYS: 3, SUBSCRIPTION_GRACE_DAYS: 7, GB_BYTES: 1e9,
            PLAN_PRICES_USD: { 100: 10, 200: 20, 400: 40, 1000: 100 }, PREMIUM_PRICE_USD: 49.99,
            sanitizeUserKey: (v) => (v === null || v === undefined || v === '' ? null : String(v)),
            deriveAdminDisplayHandle: (...vals) => (vals.find((v) => v) || ''),
            fetchSolPriceUsd: async () => 200,
            fetchSkrPriceUsd: async () => 1,
            getUserUsedBytes: async () => 0,
            ...over,
        });
    return captured.handler;
};

test('admin users route (real handler): read-only resolver statuses + decimal GB quota', async () => {
    const { dbPath } = await makeFixtureDb();
    const h = await openDb(dbPath);
    await h.run(`ALTER TABLE cloud_chunks ADD COLUMN size INTEGER`);
    await h.run(`ALTER TABLE users ADD COLUMN seeker_id TEXT`);
    await h.run(`ALTER TABLE users ADD COLUMN created_at INTEGER`);
    const now = Date.now();
    for (const u of [11, 12, 13, 14, 15]) await h.run(`INSERT INTO users (id, email) VALUES (?, ?)`, [u, `u${u}@x`]);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,premium_gb,premium_expires_at) VALUES (11,400,'active',?,0,NULL)`, [now + 30 * 864e5]);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,premium_gb,premium_expires_at) VALUES (12,100,'expired',?,1000,?)`, [now - 40 * 864e5, now - 864e5]);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,premium_gb,premium_expires_at) VALUES (13,100,'expired',?,1000,?)`, [now - 40 * 864e5, now + 100 * 864e5]);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,grace_until,premium_gb,premium_expires_at) VALUES (14,200,'grace',?,?,1000,?)`, [now - 864e5, now + 5 * 864e5, now + 100 * 864e5]);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,premium_gb,premium_expires_at,deleted_at) VALUES (15,100,'expired',?,0,NULL,?)`, [now - 40 * 864e5, now - 864e5]);
    const allQueries = [];
    const handler = loadAdminUsersRoute({
        dbAllAsync: async (sql, params) => { allQueries.push(sql); return h.all(sql, params); },
        dbGetAsync: async () => { throw new Error('resolver must not read'); },
        dbRunAsync: async () => { throw new Error('resolver must not write'); },
        ensurePlanRow: async () => { throw new Error('readOnly with planRow must not call ensurePlanRow'); },
        getUserQuotaBytes: async () => { throw new Error('knownQuotaBytes supplied'); },
    });
    const res = resStub();
    await handler({ query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body).slice(0, 400));
    const byId = Object.fromEntries(res.body.users.map((u) => [u.id, u]));
    assert.equal(byId[11].plan.effective_status, 'active');
    assert.equal(byId[11].storage_quota_bytes, Math.floor(400 * 1e9));
    assert.equal(byId[12].plan.effective_status, 'expired');
    assert.equal(byId[12].plan.premium_gb, 0);
    assert.equal(byId[12].plan.premium_gb_allocated, 1000);
    assert.ok(byId[12].plan.premium_expires_at > 0);
    assert.ok(byId[12].plan.premium_expires_at_date);
    assert.equal(byId[13].plan.effective_status, 'premium_only');
    assert.equal(byId[13].plan.premium_gb, 1000);
    assert.equal(byId[13].storage_quota_bytes, Math.floor(1000 * 1e9));
    assert.equal(byId[14].plan.effective_status, 'grace');
    assert.equal(byId[14].storage_quota_bytes, Math.floor((200 + 1000) * 1e9));
    assert.equal(byId[15].plan.effective_status, 'deleted');
    assert.equal(allQueries.length, 3, `queries: ${allQueries.map((q) => q.slice(0, 60)).join(' | ')}`);
    await h.close();
});

const loadAdminPageScript = (over = {}) => {
    const captured = {};
    vm.runInNewContext(extractMarked('ADMIN_PAGE_ROUTE'), {
        app: { get: (p, ...a) => { captured.handler = a[a.length - 1]; } },
        adminAuth: () => { }, ADMIN_HTML_TITLE: 'T', console,
    });
    const res = { setHeader() { }, send(html) { this.html = html; } };
    captured.handler({}, res);
    assert.ok(res.html, 'admin HTML emitted');
    const scripts = [...res.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const els = {};
    const mkEl = () => ({
        style: {}, dataset: {}, value: '', innerHTML: '', textContent: '', placeholder: '',
        checked: false, disabled: false,
        classList: { add() { }, remove() { }, toggle() { } },
        querySelector: () => null, querySelectorAll: () => [],
        appendChild() { }, remove() { }, select() { }, addEventListener() { },
    });
    const documentStub = {
        getElementById: (id) => (els[id] = els[id] || mkEl()),
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => mkEl(),
        addEventListener: () => { },
        body: mkEl(),
    };
    const fetches = [];
    const fetchStub = async (url, opts) => {
        fetches.push(url);
        const payload = typeof over.responder === 'function' ? over.responder(url, opts) : (over.payload || {});
        return { ok: payload.ok !== false, status: payload.status || 200, json: async () => (payload.body !== undefined ? payload.body : payload) };
    };
    const ctx = vm.createContext({
        console, document: documentStub, fetch: fetchStub,
        setInterval: () => 0, setTimeout: () => 0,
        navigator: { clipboard: { writeText: async () => { } } },
        window: {}, prompt: () => null, confirm: () => true,
        Date, JSON, Math, Promise, Number, String, Object, Array,
    });
    vm.runInContext(scripts.join('\n'), ctx);
    return { ctx, els, fetches, html: res.html };
};

test('admin inline script (emitted): loadUsers preserves premium expiry and allocation', async () => {
    const iso = '2030-01-02T03:04:05.000Z';
    const { ctx } = loadAdminPageScript({
        responder: () => ({
            server_time: iso,
            users: [{
                id: 1, email: 'a@x',
                plan: { plan_gb: 100, premium_gb: 0, premium_gb_allocated: 1000, premium_expires_at: 1893476645000, premium_expires_at_date: iso, status: 'expired', effective_status: 'expired' },
                nft: {}, solana: {},
            }],
        }),
    });
    await ctx.loadUsers();
    assert.equal(ctx.allUsers.length, 1);
    assert.equal(ctx.allUsers[0].premium_expires_at, iso);
    assert.equal(ctx.allUsers[0].premium_gb_allocated, 1000);
});

test('admin inline script (emitted): presence filter fetches all=1; header verification facts', async () => {
    const psBody = {
        server_time: '2026-01-01T00:00:00.000Z',
        revenue: { count: 3, usd: 11.97, verifiedCount: 1, pendingCount: 2, usdSource: 'client_reported' },
        users: [
            { device_hash: 'd1hash', status: 'expired', sub_status: 'paid', sub_signature: 'sigA', payment_verification: 'chain_checked', last_seen: 1, trial_expires_at: 1, first_seen: 1 },
            { device_hash: 'd2hash', status: 'trial', sub_status: 'trial', last_seen: 2, trial_expires_at: 2, first_seen: 1 },
            { device_hash: 'd3hash', status: 'expired', sub_status: 'none', last_seen: 3, trial_expires_at: 1, first_seen: 1 },
        ],
    };
    const { ctx, els, fetches, html } = loadAdminPageScript({ responder: (url) => (url.includes('paceseeker') ? psBody : { users: [] }) });
    assert.ok(html.includes('id="ps-presence-filter"'), 'presence select emitted in admin HTML');
    ctx.switchApp('paceseeker');
    assert.equal(els['ps-presence-filter'].style.display, '');
    els['ps-presence-filter'].value = 'all';
    await ctx.loadPsUsers();
    assert.ok(fetches.some((u) => u === '/admin/api/paceseeker-users?all=1'), `fetches: ${fetches.join(',')}`);
    const statsHtml = els['header-stats'].innerHTML;
    assert.match(statsHtml, /Reported checkout USD \(unverified\): <b>\$11\.97<\/b>/);
    assert.match(statsHtml, /Expired: <b>2<\/b>/);
    assert.match(statsHtml, /Chain-checked: <b>1<\/b>/);
    assert.match(statsHtml, /Pending reports: <b>2<\/b>/);
    const rep = ctx.subBadge('paid', '2030-02-01T00:00:00.000Z', { sub_signature: 'sigB', payment_verification: 'reported' });
    assert.ok(rep.includes('Reported paid'), rep);
    assert.ok(rep.includes('client-reported'), rep);
    const chk = ctx.subBadge('paid', '2030-02-01T00:00:00.000Z', { sub_signature: 'sigB', payment_verification: 'chain_checked' });
    assert.ok(chk.includes('Chain checked'), chk);
    els['ps-presence-filter'].value = 'recent';
    await ctx.loadPsUsers();
    assert.ok(fetches.some((u) => u === '/admin/api/paceseeker-users'), 'recent must use the default route');
    ctx.switchApp('photolynk');
    assert.equal(els['ps-presence-filter'].style.display, 'none');
});

const loadPsUsersRoute = (db) => {
    const captured = {};
    vm.runInNewContext(extractBetween("app.get('/admin/api/paceseeker-users'", 'PaceSeeker invite code tracker'), {
        app: { get: (p, ...a) => { captured.handler = a[a.length - 1]; } },
        adminAuth: () => { }, db, console, Date, JSON, Number, String,
    });
    return captured.handler;
};

const callPsUsers = (handler, query) => new Promise((resolve) => {
    const res = {
        statusCode: 200, body: undefined,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; resolve(this); return this; },
    };
    handler({ query: query || {} }, res);
});

async function makePsAdminDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psadmin-'));
    createdDirs.push(dir);
    const h = await openDb(path.join(dir, 'test.db'));
    await h.run(`CREATE TABLE paceseeker_devices (
        device_hash TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER,
        trial_started_at INTEGER, trial_expires_at INTEGER, version_code INTEGER,
        last_ip TEXT, sub_status TEXT, sub_until INTEGER, last_country_code TEXT,
        sub_signature TEXT, sub_paid_at INTEGER, sub_paid_with TEXT, sub_plan TEXT,
        sub_usd REAL, sub_amount_atomic INTEGER, wallet_address TEXT, wallet_domain TEXT,
        ad_until INTEGER)`);
    await h.run(`CREATE TABLE paceseeker_revenue (
        signature TEXT PRIMARY KEY, device_hash TEXT, paid_at INTEGER, paid_with TEXT,
        plan TEXT, usd_at_checkout REAL, amount_atomic INTEGER, reported_at INTEGER,
        eco_verified INTEGER DEFAULT 0)`);
    await h.run(`CREATE TABLE ecosystem_members (
        account_id TEXT NOT NULL, app TEXT NOT NULL, identity TEXT NOT NULL,
        wallet TEXT, linked_at INTEGER, wallet_verified INTEGER DEFAULT 0,
        wallet_changed_at INTEGER, PRIMARY KEY (app, identity))`);
    await h.run(`CREATE TABLE stealthlynk_subs (
        account_id TEXT PRIMARY KEY, sub_until INTEGER, source_app TEXT,
        source_kind TEXT, provenance TEXT, updated_at INTEGER)`);
    return h;
}

test('PS admin route (real handler): verified vs pending reports, USD stays client-reported', async () => {
    const h = await makePsAdminDb();
    const now = Date.now();
    await h.run(`INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,paid_with,plan,usd_at_checkout,amount_atomic,reported_at,eco_verified) VALUES ('sigV','d1',?,'SOL','sub',3.99,1,?,1)`, [now, now]);
    await h.run(`INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,paid_with,plan,usd_at_checkout,amount_atomic,reported_at,eco_verified) VALUES ('sigU','d2',?,'USDC','sub',3.99,1,?,0)`, [now, now]);
    await h.run(`INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,paid_with,plan,usd_at_checkout,amount_atomic,reported_at,eco_verified) VALUES ('sigX','d9',?,'SKR','sub',3.99,1,?,0)`, [now, now]);
    await h.run(`INSERT INTO paceseeker_devices (device_hash,first_seen,last_seen,trial_started_at,trial_expires_at,sub_status,sub_signature) VALUES ('d1',?,?,?,?,'paid','sigV')`, [now - 9e6, now, now - 9e6, now + 6e5]);
    await h.run(`INSERT INTO paceseeker_devices (device_hash,first_seen,last_seen,trial_started_at,trial_expires_at,sub_status,sub_signature) VALUES ('d2',?,?,?,?,'paid','sigU')`, [now - 9e6, now, now - 9e6, now + 6e5]);
    await h.run(`INSERT INTO paceseeker_devices (device_hash,first_seen,last_seen,trial_started_at,trial_expires_at,sub_status,sub_signature) VALUES ('d3',?,?,?,?,'none',NULL)`, [now - 9e6, now, now - 9e6, now - 8e7]);
    await h.run(`INSERT INTO paceseeker_devices (device_hash,first_seen,last_seen,trial_started_at,trial_expires_at,sub_status,sub_signature) VALUES ('d4',?,?,?,?,'paid','sigV')`, [now - 9e6, now, now - 9e6, now + 6e5]);
    const res = await callPsUsers(loadPsUsersRoute(h.conn), { all: '1' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.revenue.count, 3);
    assert.ok(Math.abs(res.body.revenue.usd - 11.97) < 1e-6);
    assert.equal(res.body.revenue.verifiedCount, 1);
    assert.equal(res.body.revenue.pendingCount, 2);
    assert.equal(res.body.revenue.usdSource, 'client_reported');
    const byDev = Object.fromEntries(res.body.users.map((u) => [u.device_hash, u]));
    assert.equal(byDev.d1.payment_verification, 'chain_checked');
    assert.equal(byDev.d2.payment_verification, 'reported');
    assert.equal(byDev.d3.payment_verification, 'none');
    assert.equal(byDev.d4.payment_verification, 'reported');
    await h.close();
});

test('PS admin route (real handler): aggregate or membership query failure -> 500', async () => {
    const errDb = (failOn) => ({
        all: (sql, params, cb) => {
            const f = typeof params === 'function' ? params : cb;
            if ((failOn === 'devices' && sql.includes('paceseeker_devices')) || (failOn === 'members' && sql.includes('ecosystem_members'))) return f(new Error('db down'));
            return f(null, []);
        },
        get: (sql, params, cb) => {
            const f = typeof params === 'function' ? params : cb;
            if (failOn === 'revenue') return f(new Error('db down'));
            return f(null, { cnt: 0, usd: 0, verified_count: 0 });
        },
    });
    const resRev = await callPsUsers(loadPsUsersRoute(errDb('revenue')), {});
    assert.equal(resRev.statusCode, 500);
    const resMem = await callPsUsers(loadPsUsersRoute(errDb('members')), {});
    assert.equal(resMem.statusCode, 500);
});

async function makeSchemaFixtureDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subschema-'));
    createdDirs.push(dir);
    const h = await openDb(path.join(dir, 'test.db'));
    await h.run(`CREATE TABLE ecosystem_members (
        account_id TEXT NOT NULL, app TEXT NOT NULL, identity TEXT NOT NULL,
        wallet TEXT, linked_at INTEGER, wallet_verified INTEGER DEFAULT 0,
        wallet_changed_at INTEGER, PRIMARY KEY (app, identity))`);
    await h.run(`CREATE TABLE ecosystem_accounts (account_id TEXT PRIMARY KEY, primary_wallet TEXT, created_at INTEGER)`);
    await h.run(`CREATE TABLE stealthlynk_subs (account_id TEXT PRIMARY KEY, sub_until INTEGER, source_app TEXT, source_kind TEXT, provenance TEXT, updated_at INTEGER)`);
    await h.run(`CREATE TABLE user_plans (user_id INTEGER PRIMARY KEY, status TEXT, plan_gb INTEGER, expires_at INTEGER, premium_gb INTEGER, premium_expires_at INTEGER, deleted_at INTEGER, grace_until INTEGER, trial_until INTEGER, updated_at INTEGER)`);
    await h.run(`CREATE TABLE solana_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tx_signature TEXT UNIQUE NOT NULL, sol_amount REAL, created_at INTEGER, entitlement_applied_at INTEGER)`);
    return h;
}

test('subscriptionSchema: fresh DB initializes PS tables; prerequisites verified', async () => {
    const { ensurePaceSeekerSchema } = require('./subscriptionSchema');
    const h = await makeSchemaFixtureDb();
    await ensurePaceSeekerSchema(h.conn);
    const devCols = new Set((await h.all(`PRAGMA table_info(paceseeker_devices)`)).map((c) => c.name));
    for (const c of ['device_hash', 'first_seen', 'last_seen', 'trial_started_at', 'trial_expires_at', 'version_code', 'last_ip', 'sub_status', 'sub_until', 'last_country_code', 'sub_signature', 'sub_paid_at', 'sub_paid_with', 'sub_plan', 'sub_usd', 'sub_amount_atomic', 'wallet_address', 'wallet_domain', 'ad_until']) {
        assert.ok(devCols.has(c), `paceseeker_devices missing ${c}`);
    }
    const revCols = new Set((await h.all(`PRAGMA table_info(paceseeker_revenue)`)).map((c) => c.name));
    for (const c of ['signature', 'device_hash', 'paid_at', 'paid_with', 'plan', 'usd_at_checkout', 'amount_atomic', 'reported_at', 'eco_verified']) {
        assert.ok(revCols.has(c), `paceseeker_revenue missing ${c}`);
    }
    await h.close();
});

test('subscriptionSchema: legacy PS tables gain columns without losing rows; idempotent re-run', async () => {
    const { ensurePaceSeekerSchema } = require('./subscriptionSchema');
    const h = await makeSchemaFixtureDb();
    await h.run(`CREATE TABLE paceseeker_devices (device_hash TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, trial_started_at INTEGER, trial_expires_at INTEGER, version_code INTEGER, last_ip TEXT)`);
    await h.run(`INSERT INTO paceseeker_devices (device_hash,first_seen,last_seen) VALUES ('dev1',11,22)`);
    await h.run(`CREATE TABLE paceseeker_revenue (signature TEXT PRIMARY KEY, device_hash TEXT, paid_at INTEGER, paid_with TEXT, plan TEXT, usd_at_checkout REAL, amount_atomic INTEGER, reported_at INTEGER)`);
    await h.run(`INSERT INTO paceseeker_revenue (signature,usd_at_checkout) VALUES ('sig1',3.99)`);
    await ensurePaceSeekerSchema(h.conn);
    assert.equal((await h.get(`SELECT device_hash,first_seen FROM paceseeker_devices`)).first_seen, 11);
    assert.equal((await h.get(`SELECT usd_at_checkout FROM paceseeker_revenue`)).usd_at_checkout, 3.99);
    await ensurePaceSeekerSchema(h.conn);
    const devCols = new Set((await h.all(`PRAGMA table_info(paceseeker_devices)`)).map((c) => c.name));
    assert.ok(devCols.has('ad_until') && devCols.has('wallet_domain') && devCols.has('sub_signature'));
    assert.equal((await h.get(`SELECT device_hash FROM paceseeker_devices`)).device_hash, 'dev1');
    await h.close();
});

test('subscriptionSchema: stale duplicate-column error tolerated only when re-read confirms column', async () => {
    const { ensurePaceSeekerSchema } = require('./subscriptionSchema');
    const h = await makeSchemaFixtureDb();
    await h.run(`CREATE TABLE paceseeker_devices (device_hash TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, trial_started_at INTEGER, trial_expires_at INTEGER, version_code INTEGER, last_ip TEXT)`);
    await h.run(`ALTER TABLE paceseeker_devices ADD COLUMN sub_status TEXT`);
    let masked = true;
    const wrapped = {
        run: (sql, params, cb) => h.conn.run(sql, params, cb),
        all: (sql, params, cb) => {
            if (sql.includes('table_info(paceseeker_devices)') && masked) {
                masked = false;
                return h.conn.all(sql, params, (e, rows) => cb(e, (rows || []).filter((r) => r.name !== 'sub_status')));
            }
            return h.conn.all(sql, params, cb);
        },
    };
    await ensurePaceSeekerSchema(wrapped);
    const devCols = new Set((await h.all(`PRAGMA table_info(paceseeker_devices)`)).map((c) => c.name));
    for (const c of ['sub_status', 'ad_until', 'sub_signature', 'wallet_domain']) assert.ok(devCols.has(c), `missing ${c}`);
    await h.close();
});

test('subscriptionSchema: missing required prerequisite schema rejects', async () => {
    const { ensurePaceSeekerSchema } = require('./subscriptionSchema');
    const h = await makeSchemaFixtureDb();
    await h.run(`DROP TABLE user_plans`);
    await h.run(`CREATE TABLE user_plans (user_id INTEGER PRIMARY KEY, status TEXT, plan_gb INTEGER, expires_at INTEGER, premium_gb INTEGER)`);
    await assert.rejects(() => ensurePaceSeekerSchema(h.conn), /premium/);
    await h.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subschema-empty-'));
    createdDirs.push(dir);
    const h2 = await openDb(path.join(dir, 'test.db'));
    await assert.rejects(() => ensurePaceSeekerSchema(h2.conn));
    await h2.close();
});

test('subscriptionReadiness: middleware holds until finish; injected failure -> 503', async () => {
    const { createSubscriptionReadiness } = require('./subscriptionSchema');
    const readiness = createSubscriptionReadiness();
    let nextCalls = 0;
    const res = resStub();
    const held = readiness.middleware({}, res, () => { nextCalls++; });
    await new Promise((r) => setImmediate(r));
    assert.equal(nextCalls, 0, 'request must be held until schema readiness resolves');
    readiness.finish(new Error('schema down'));
    await held;
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'SUBSCRIPTION_SCHEMA_UNAVAILABLE');
    const ok = createSubscriptionReadiness();
    const res2 = resStub();
    const held2 = ok.middleware({}, res2, () => { nextCalls++; });
    ok.finish(null);
    await held2;
    assert.equal(nextCalls, 1);
    assert.equal(res2.statusCode, 200);
});

test('subscriptionReadiness: non-duplicate DB failure propagates into 503', async () => {
    const { ensurePaceSeekerSchema, createSubscriptionReadiness } = require('./subscriptionSchema');
    const failingDb = {
        run: (sql, params, cb) => { const f = typeof params === 'function' ? params : cb; f(new Error('disk I/O error')); },
        all: (sql, params, cb) => { const f = typeof params === 'function' ? params : cb; f(null, []); },
    };
    const readiness = createSubscriptionReadiness();
    let nextCalls = 0;
    const res = resStub();
    const held = readiness.middleware({}, res, () => { nextCalls++; });
    ensurePaceSeekerSchema(failingDb).then(() => readiness.finish(null), (err) => readiness.finish(err));
    await held;
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'SUBSCRIPTION_SCHEMA_UNAVAILABLE');
});

test('treasuryScanOnce (real code): schema unavailable -> structured skip, no scan work', async () => {
    const scan = evalServer('TREASURY_SCAN_RUN', 'treasuryScanOnce', {
        treasuryScanInFlight: false,
        subscriptionReadiness: { wait: Promise.resolve(new Error('ps schema down')) },
        treasuryCollectSignatures: async () => { throw new Error('must not scan'); },
        dbAllAsync: async () => { throw new Error('must not read'); },
    });
    const r = await scan();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema_unavailable');
    assert.equal(r.errors, 0);
});

const loadVerifyPsPaymentTx = (over = {}) => {
    const calls = [];
    const fn = vm.runInNewContext(
        `${extractBetween('const _psPayVerifyCache = new Map();', 'async function ecoMirrorPsPayment')}\n;({ verifyPsPaymentTx })`,
        {
            console,
            axios: {
                post: async (url, body) => {
                    calls.push({ url, body });
                    return { data: { result: over.tx } };
                },
            },
            paymentRecovery,
            getPriceBand: over.getPriceBand || (async () => ({ latest: 200 })),
            PS_TREASURY_WALLET: TREASURY,
            PS_ECO_STABLE_MINTS: {},
            PS_ECO_SKR_MINT: SKR_MINT,
            PS_ECO_MIN_PAYMENT_USD: 1,
            process: { env: {} },
            Buffer, Date, JSON, Math, Number, String, Object,
        }).verifyPsPaymentTx;
    return { fn, calls };
};

test('verifyPsPaymentTx (real code): parsed + raw base58 PS1 memos pass; malformed encoding rejects', async () => {
    const psTx = (memoInstruction) => ({
        blockTime: Math.floor(Date.now() / 1000),
        meta: { err: null, preBalances: [5e9, 1e9], postBalances: [4e9, 2e9], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
        transaction: {
            message: {
                accountKeys: [PAYER, TREASURY],
                instructions: [
                    { program: 'system', parsed: { type: 'transfer', info: { source: PAYER, destination: TREASURY, lamports: '100000000' } } },
                    memoInstruction,
                ],
            },
        },
    });
    const memo = 'PS1|monthly|1700000000|abcd1234';
    const parsed = loadVerifyPsPaymentTx({ tx: psTx(memoIx(memo)) });
    const r1 = await parsed.fn('sigParsed' + 'X'.repeat(80));
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.payer, PAYER);
    assert.equal(parsed.calls.length, 1);
    const raw = loadVerifyPsPaymentTx({ tx: psTx(memoDataIx(memo)) });
    const r2 = await raw.fn('sigRaw' + 'Y'.repeat(80));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const bad = loadVerifyPsPaymentTx({ tx: psTx({ programId: MEMO_PROGRAM_ID, data: Buffer.from(memo, 'utf8').toString('base64') }) });
    const r3 = await bad.fn('sigBad' + 'Z'.repeat(80));
    assert.equal(r3.ok, false);
});

test('subscriptionReadiness: verifier waits behind pending callback-style user_plans migration', async () => {
    const { ensurePaceSeekerSchema } = require('./subscriptionSchema');
    const h = await makeSchemaFixtureDb();
    await h.run(`DROP TABLE user_plans`);
    await h.run(`CREATE TABLE user_plans (user_id INTEGER PRIMARY KEY, status TEXT, plan_gb INTEGER, expires_at INTEGER)`);
    await h.run(`CREATE TABLE users (id INTEGER PRIMARY KEY)`);
    await assert.rejects(() => ensurePaceSeekerSchema(h.conn), /premium/);
    let migrationResolve;
    const migrationDone = new Promise((r) => { migrationResolve = r; });
    vm.runInNewContext(
        extractBetween('// Migrate existing DBs: add missing columns to user_plans', '// Migrate existing DBs: add user_uuid'),
        {
            db: h.conn, console, Date,
            resolveUserPlansMigration: () => migrationResolve(),
        });
    const gated = migrationDone.then(() => ensurePaceSeekerSchema(h.conn));
    await migrationDone;
    await new Promise((res, rej) => h.conn.serialize(() => h.conn.run('SELECT 1', [], (e) => (e ? rej(e) : res()))));
    await gated;
    const cols = new Set((await h.all(`PRAGMA table_info(user_plans)`)).map((c) => c.name));
    assert.ok(cols.has('premium_gb') && cols.has('premium_expires_at'));
    await h.close();
});

// --- PS memo + promo fixtures conform to the native client format ------------
test('parsePaceSeekerMemo (real code): native PS1 ms+checksum format incl. promo suffix', async () => {
    const { parsePaceSeekerMemo } = paymentRecovery;
    assert.deepEqual(
        parsePaceSeekerMemo('PS1|monthly|1730000000123|ab12cd34'),
        { duration: 'monthly', reportedPaidAt: 1730000000123, checksum: 'ab12cd34', promo: null });
    const withPromo = parsePaceSeekerMemo('PS1|monthly|1730000000123|AB12CD34|promo:PSABCDEFGH1234');
    assert.equal(withPromo.promo, 'PSABCDEFGH1234', 'real promo suffix parses');
    assert.equal(withPromo.checksum, 'ab12cd34', 'checksum segment is normalized, never treated as promo');
    // Rejections: the timestamp is client-reported telemetry only.
    assert.equal(parsePaceSeekerMemo('PS1|monthly|1700000000'), null, 'missing checksum segment');
    assert.equal(parsePaceSeekerMemo('PS1|monthly|1730000000123|ab12cd34|promo:XXBAD'), null, 'malformed promo');
    assert.equal(parsePaceSeekerMemo('PS1|daily|1730000000123|ab12cd34'), null, 'unknown duration');
    assert.equal(parsePaceSeekerMemo('PS1|monthly|0|ab12cd34'), null, 'non-positive timestamp');
    assert.equal(parsePaceSeekerMemo('PhotoLynk:sub:100:monthly'), null, 'foreign product memo');
    assert.equal(parsePaceSeekerMemo('SLQ1|' + 'a'.repeat(32)), null, 'quote memo is not a product memo');
    assert.equal(parsePaceSeekerMemo(42), null);
});

test('promoCodeValid (real code): fnv1a-peppered 14-char checksum only', async () => {
    const { promoCodeValid } = require('./ecosystemPayments');
    const sum = (init) => (s) => {
        let h = init;
        for (const c of s) { h ^= c.charCodeAt(0); h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); h |= 0; }
        return (h >>> 0).toString(16).padStart(8, '0');
    };
    const base = 'PSTESTCD12'; // 10-char code body
    const peppered = base + 'PS_PROMO_V1_PEPPER';
    const good = base + sum(0x811c9dc5)(peppered).slice(0, 4).toUpperCase();
    assert.equal(good.length, 14);
    assert.equal(promoCodeValid(good), true, 'fnv1a checksum accepted');
    assert.equal(promoCodeValid(good.toLowerCase()), true, 'case-normalized before check');
    const oldAlgo = base + sum(0)(peppered).slice(0, 4).toUpperCase();
    assert.equal(promoCodeValid(oldAlgo), false, 'old init-0 checksum is invalid');
    assert.equal(promoCodeValid(base + 'XXXX'), false, 'bad checksum');
    assert.equal(promoCodeValid('XSTESTCD12' + good.slice(10)), false, 'must carry the PS prefix');
    assert.equal(promoCodeValid(good.slice(0, 13)), false, 'length enforced');
    assert.equal(promoCodeValid(''), false);
});

// ---- Ecosystem-core startup degradation (ECO_INIT region, VM-extracted) ----

test('ecoTryInitialize: init failure keeps legacy mode, records state, unref backoff retry recovers', async () => {
    const timers = [];
    const fakeSetTimeout = (fn, ms) => {
        const t = { fn, ms, unrefd: false, unref: () => { t.unrefd = true; return t; } };
        timers.push(t);
        return t;
    };
    const api = vm.runInNewContext(`
        let ecosystemReady = false;
        let paymentProtocol = null;
        let _ecoInitState = null;
        let _ecoInitAttempts = 0;
        let _ecoInitTimer = null;
        let workerStarts = 0;
        const ecosystem = {
            calls: 0, fail: null, absorbCalls: 0,
            initialize: async () => {
                ecosystem.calls++;
                if (ecosystem.fail) throw ecosystem.fail;
                return { initialized: true, migrated: false };
            },
            absorbLegacyLedgerPage: async () => { ecosystem.absorbCalls++; return 0; },
        };
        const createEcosystemPaymentService = () => ({ initialize: async () => ({ initialized: true }) });
        const startEcoWorker = () => { workerStarts++; };
        const ecoRepairPendingAdClaims = async () => {};
        const ECO_SIGNING_KEY = null, SOLANA_PAYMENT_WALLET = 'w';
        const SKR_TOKEN_DECIMALS = 6, SKR_TOKEN_MINT = 'm', USDC_MINT = 'u', USDT_MINT = 't';
        const treasuryFetchTransaction = async () => null;
        const getPriceBand = () => null, evaluatePaymentAmount = () => null;
        const treasuryUserByPaymentCode = async () => null, paymentCodeFor = () => '', treasuryBoundUsers = async () => [];
        const creditSolanaSubscription = async () => ({}), recordVerifiedPremiumPayment = async () => ({}), resumePremiumPayment = async () => ({});
        const dbGetAsync = async () => null, ecoGetPromoPolicy = async () => null;
        const DEFAULT_REGISTRY = {};
        ${extractMarked('ECO_INIT')}
        ;({ ecoTryInitialize, ecosystem,
            state: () => ({ ecosystemReady, paymentProtocol, _ecoInitState, _ecoInitAttempts, _ecoInitTimer, workerStarts }) })
    `, { console, setTimeout: fakeSetTimeout });

    const boom = Object.assign(new Error('ecosystem_timelines has an unknown shape'), { code: 'SCHEMA_VERSION_UNSUPPORTED' });
    api.ecosystem.fail = boom;
    // Must RESOLVE (not reject): the readiness chain finishes null on ecosystem
    // failure — only ensurePaceSeekerSchema may reject readiness.
    const resolved = await api.ecoTryInitialize();
    assert.equal(resolved, undefined, 'ecoTryInitialize resolves even when the core throws');
    let st = api.state();
    assert.equal(st.ecosystemReady, false, 'ecosystem failure leaves legacy compatibility mode');
    assert.equal(st.paymentProtocol, null);
    assert.equal(st._ecoInitState.ok, false);
    assert.equal(st._ecoInitState.code, 'SCHEMA_VERSION_UNSUPPORTED');
    assert.match(st._ecoInitState.message, /unknown shape/);
    assert.equal(st._ecoInitState.attempts, 1);
    assert.ok(st._ecoInitState.at > 0, 'failure timestamp recorded');
    assert.equal(timers.length, 1, 'retry scheduled');
    assert.equal(timers[0].unrefd, true, 'retry timer unref’d');
    assert.equal(timers[0].ms, 60000, 'first retry after 60s');

    // A second failure doubles the backoff (still unref’d).
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    st = api.state();
    assert.equal(st._ecoInitState.ok, false);
    assert.equal(st._ecoInitState.attempts, 2);
    assert.equal(timers.length, 2);
    assert.equal(timers[1].ms, 120000, 'backoff doubles');
    assert.equal(timers[1].unrefd, true);

    // Core recovers: the scheduled retry flips the server to ready, runs the
    // post-baseline absorb sweep, starts the worker, and stops retrying.
    api.ecosystem.fail = null;
    timers[1].fn();
    await new Promise((r) => setTimeout(r, 0));
    st = api.state();
    assert.equal(st.ecosystemReady, true);
    assert.ok(st.paymentProtocol, 'payment protocol created on recovery');
    assert.equal(st._ecoInitState.ok, true);
    assert.equal(st._ecoInitState.attempts, 3);
    assert.equal(st.workerStarts, 1, 'worker started on recovery');
    assert.equal(api.ecosystem.absorbCalls, 1, 'baseline_v2 already existed -> one-shot absorb sweep ran');
    assert.equal(timers.length, 2, 'no further retry scheduled');
});

test('admin eco-accounts payload exposes ecosystem init state (real route, VM-extracted)', async () => {
    const handlers = {};
    const api = vm.runInNewContext(`
        let ecosystemReady = false;
        let _ecoInitState = { ok: false, code: 'SCHEMA_VERSION_UNSUPPORTED', message: 'bad shape', at: 12345, attempts: 2 };
        const app = { get: (p, mw, h) => { handlers[p] = h; } };
        const adminAuth = (req, res, next) => next();
        const dbAllAsync = async () => [];
        const dbGetAsync = async () => ({ n: 0 });
        ${extractMarked('ADMIN_ECO_ACCOUNTS')}
        ;({ handlers })
    `, { console, handlers });
    const res = { statusCode: 200, body: null, json(o) { this.body = o; }, status(c) { this.statusCode = c; return this; } };
    await api.handlers['/admin/api/eco-accounts']({}, res);
    assert.ok(res.body.ecosystem, 'payload carries an ecosystem status block');
    assert.equal(res.body.ecosystem.ready, false);
    assert.equal(res.body.ecosystem.legacyMode, true);
    const init = res.body.ecosystem.init;
    assert.equal(init.ok, false);
    assert.equal(init.code, 'SCHEMA_VERSION_UNSUPPORTED');
    assert.equal(init.message, 'bad shape');
    assert.equal(init.at, 12345);
    assert.equal(init.attempts, 2);
});

// ---------------------------------------------------------------------------
// /admin/api/eco-accounts pagination + entitlements, /admin/api/eco-jobs
// ---------------------------------------------------------------------------

// Compat tables the eco-accounts route reads plus everything
// createEcosystemService.initialize()/migrateBaseline expects.
const ECO_ADMIN_DDL = [
    `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)`,
    `CREATE TABLE user_plans (user_id INTEGER PRIMARY KEY, plan_gb INTEGER, premium_gb INTEGER, premium_expires_at INTEGER, status TEXT, expires_at INTEGER, grace_until INTEGER, trial_until INTEGER, deleted_at INTEGER, payment_type TEXT, payment_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, filename TEXT, size INTEGER)`,
    `CREATE TABLE ecosystem_accounts (account_id TEXT PRIMARY KEY, primary_wallet TEXT, created_at INTEGER, ad_strict INTEGER DEFAULT 0, x_handle TEXT, tg_username TEXT, cherry_state TEXT)`,
    `CREATE TABLE ecosystem_members (account_id TEXT NOT NULL, app TEXT NOT NULL, identity TEXT NOT NULL, wallet TEXT, linked_at INTEGER, wallet_verified INTEGER DEFAULT 0, wallet_changed_at INTEGER, PRIMARY KEY (app, identity))`,
    `CREATE TABLE stealthlynk_subs (account_id TEXT PRIMARY KEY, sub_until INTEGER, source_app TEXT, source_kind TEXT, provenance TEXT, updated_at INTEGER)`,
    `CREATE TABLE ad_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, week_key INTEGER NOT NULL, platform TEXT, post_url TEXT UNIQUE, code TEXT, author_handle TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, verified_at INTEGER, verify_attempts INTEGER DEFAULT 0, granted_at INTEGER, app TEXT, tier_gb INTEGER, UNIQUE(account_id, week_key))`,
    `CREATE TABLE solana_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tx_signature TEXT UNIQUE NOT NULL, sol_amount REAL, skr_amount REAL, payment_token TEXT, tier_gb INTEGER, duration TEXT DEFAULT 'monthly', created_at INTEGER, verified_at INTEGER, entitlement_applied_at INTEGER)`,
    `CREATE TABLE solana_subscription_credits (tx_signature TEXT PRIMARY KEY,user_id INTEGER NOT NULL,source TEXT NOT NULL,payment_at INTEGER NOT NULL,expires_before INTEGER,expires_after INTEGER NOT NULL,detail TEXT,created_at INTEGER NOT NULL)`,
    `CREATE TABLE solana_wallet_bindings (wallet TEXT NOT NULL,user_id INTEGER NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(wallet,user_id))`,
    `CREATE TABLE paceseeker_devices (device_hash TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, sub_status TEXT, sub_until INTEGER, ad_until INTEGER, sub_signature TEXT, wallet_address TEXT)`,
    `CREATE TABLE paceseeker_revenue (signature TEXT PRIMARY KEY, device_hash TEXT, paid_at INTEGER, paid_with TEXT, plan TEXT, usd_at_checkout REAL, amount_atomic INTEGER, reported_at INTEGER, eco_verified INTEGER DEFAULT 0)`,
];

const mkEcoAdminDb = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecoadmin-'));
    createdDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const h = await openDb(dbPath);
    for (const ddl of ECO_ADMIN_DDL) await h.run(ddl);
    return { h, dbPath };
};

// Run the real marked route bodies in a VM with the test's own deps —
// production code paths, fixture state.
const mkEcoAdminHandlers = (sandbox) => {
    const handlers = {};
    vm.runInNewContext(`
        ${extractMarked('ADMIN_ECO_ACCOUNTS')}
        ${extractMarked('ADMIN_ECO_JOBS')}
    `, {
        console, handlers,
        app: { get: (p, mw, h) => { handlers[p] = h; } },
        adminAuth: (req, res, next) => next(),
        ...sandbox,
    });
    return handlers;
};

const mkAdminRes = () => ({
    statusCode: 200, body: null,
    json(o) { this.body = o; return this; },
    status(c) { this.statusCode = c; return this; },
});

test('admin eco-accounts: pagination total/offset/limit, members+subs scoped to page', async () => {
    const { h } = await mkEcoAdminDb();
    for (let i = 1; i <= 5; i++) {
        await h.run(`INSERT INTO ecosystem_accounts (account_id, created_at) VALUES (?, ?)`, [`acct${i}`, 1000 + i]);
    }
    await h.run(`INSERT INTO ecosystem_members (account_id, app, identity, linked_at) VALUES ('acct4', 'paceseeker', 'dev_x', 1)`);
    await h.run(`INSERT INTO stealthlynk_subs (account_id, sub_until, source_kind) VALUES ('acct4', 999, 'payment')`);
    const handlers = mkEcoAdminHandlers({
        ecosystemReady: false, _ecoInitState: { ok: false, code: 'X', message: 'm', at: 1, attempts: 1 },
        dbGetAsync: h.get, dbAllAsync: h.all,
    });
    const res = mkAdminRes();
    await handlers['/admin/api/eco-accounts']({ query: { offset: '1', limit: '2' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 5, 'total counts all accounts');
    assert.equal(res.body.offset, 1);
    assert.equal(res.body.limit, 2);
    assert.equal(res.body.accounts.length, 2);
    // ORDER BY created_at DESC: acct5, acct4 | acct3, acct2, acct1
    assert.equal(res.body.accounts[0].account_id, 'acct4', 'page slice is deterministic');
    assert.equal(res.body.accounts[0].members.length, 1, 'page member rows still joined');
    assert.equal(res.body.accounts[0].sub_until, 999);
    assert.ok(!('entitlements' in res.body.accounts[0]), 'legacy mode omits entitlements');
    // limit clamps at 500
    const res2 = mkAdminRes();
    await handlers['/admin/api/eco-accounts']({ query: { offset: '0', limit: '99999' } }, res2);
    assert.equal(res2.body.limit, 500);
    await h.close();
});

test('admin eco-accounts: entitlements come from a real read-only snapshot', async () => {
    const { h, dbPath } = await mkEcoAdminDb();
    const clock = { t: Date.now() };
    const svc = createEcosystemService({ sqlite3, dbPath, now: () => clock.t });
    await svc.initialize();
    await h.run(`INSERT INTO users (id,email) VALUES (1,'a@b.c')`);
    const acct = await svc.ensureAccount('photolynk', '1', {});
    const projCalls = [];
    const ecoSpy = {
        ...svc,
        resolveAccount: (id, opts) => { projCalls.push(opts); return svc.resolveAccount(id, opts); },
    };
    const handlers = mkEcoAdminHandlers({
        ecosystemReady: true, _ecoInitState: { ok: true, code: null, message: null, at: 1, attempts: 1 },
        dbGetAsync: h.get, dbAllAsync: h.all, ecosystem: ecoSpy,
    });
    const projBefore = await h.all(`SELECT * FROM ecosystem_projection_state ORDER BY app, identity`);
    const plansBefore = await h.all(`SELECT * FROM user_plans ORDER BY user_id`);
    const res = mkAdminRes();
    await handlers['/admin/api/eco-accounts']({ query: {} }, res);
    const a = res.body.accounts.find((x) => x.account_id === acct);
    assert.ok(a, 'account in page');
    assert.ok(a.entitlements, 'snapshot attached');
    assert.equal(a.entitlements.members.length, 1);
    assert.equal(a.entitlements.members[0].app, 'photolynk');
    assert.equal(a.entitlements.members[0].identity, '1');
    assert.ok(projCalls.length >= 1, 'resolveAccount invoked');
    assert.ok(projCalls.every((o) => o && o.project === false), 'admin reads never project');
    const projAfter = await h.all(`SELECT * FROM ecosystem_projection_state ORDER BY app, identity`);
    const plansAfter = await h.all(`SELECT * FROM user_plans ORDER BY user_id`);
    assert.deepEqual(projAfter, projBefore, 'projection state untouched by the read');
    assert.deepEqual(plansAfter, plansBefore, 'user_plans untouched by the read');
    await h.close();
});

test('admin eco-accounts: per-account resolve failure isolates to entitlementsError', async () => {
    const { h } = await mkEcoAdminDb();
    await h.run(`INSERT INTO ecosystem_accounts (account_id, created_at) VALUES ('good', 2)`);
    await h.run(`INSERT INTO ecosystem_accounts (account_id, created_at) VALUES ('bad', 1)`);
    const handlers = mkEcoAdminHandlers({
        ecosystemReady: true, _ecoInitState: { ok: true, code: null, message: null, at: 1, attempts: 1 },
        dbGetAsync: h.get, dbAllAsync: h.all,
        ecosystem: {
            resolveAccount: async (id) => {
                if (id === 'bad') { const e = new Error('nope'); e.code = 'RESOLVE_BOOM'; throw e; }
                return { accountId: id, revision: 7, sharedUntil: 42, members: [], sources: [] };
            },
        },
    });
    const res = mkAdminRes();
    await handlers['/admin/api/eco-accounts']({ query: {} }, res);
    assert.equal(res.statusCode, 200, 'page survives a per-account failure');
    const good = res.body.accounts.find((x) => x.account_id === 'good');
    const bad = res.body.accounts.find((x) => x.account_id === 'bad');
    assert.equal(good.entitlements.revision, 7);
    assert.equal(bad.entitlements, null);
    assert.equal(bad.entitlementsError, 'RESOLVE_BOOM');
    await h.close();
});

test('admin eco-jobs: counts + rows with parsed subjects; legacy mode short-circuits', async () => {
    const { h, dbPath } = await mkEcoAdminDb();
    const clock = { t: Date.now() };
    const svc = createEcosystemService({ sqlite3, dbPath, now: () => clock.t });
    await svc.initialize(); // creates ecosystem_jobs
    const WALLET = 'WALLETaaaabbbbccccddddeeeeffffgg';
    await h.run(
        `INSERT INTO ecosystem_jobs (job_key,kind,reference_id,payload_json,state,attempts,next_attempt_at,last_error_code,created_at,updated_at)
         VALUES ('job:sigPEND','verify_solana','sigPEND',?,'pending',2,?,?,?,?)`,
        [JSON.stringify({ subjects: [{ app: 'paceseeker', identity: 'dev_aaaa', wallet: WALLET }] }),
         clock.t + 60000, 'PAYMENT_ACCOUNT_UNVERIFIED', clock.t, clock.t]);
    await h.run(
        `INSERT INTO ecosystem_jobs (job_key,kind,reference_id,payload_json,state,attempts,next_attempt_at,last_error_code,created_at,updated_at)
         VALUES ('job:sigDONE','verify_solana','sigDONE','{"subjects":[]}','done',1,?,?,?,?)`,
        [clock.t, null, clock.t, clock.t]);
    const handlers = mkEcoAdminHandlers({
        ecosystemReady: true, _ecoInitState: { ok: true, code: null, message: null, at: 1, attempts: 1 },
        dbGetAsync: h.get, dbAllAsync: h.all, ecosystem: svc,
    });
    const res = mkAdminRes();
    await handlers['/admin/api/eco-jobs']({ query: {} }, res);
    assert.equal(res.body.counts.pending, 1);
    assert.equal(res.body.counts.done, 1);
    assert.equal(res.body.counts.leased, 0);
    assert.equal(res.body.jobs.length, 2);
    const pending = res.body.jobs.find((j) => j.signature === 'sigPEND');
    assert.equal(pending.state, 'pending');
    assert.equal(pending.attempts, 2);
    assert.equal(pending.last_error_code, 'PAYMENT_ACCOUNT_UNVERIFIED');
    assert.equal(pending.subjects.length, 1);
    assert.equal(pending.subjects[0].app, 'paceseeker');
    assert.equal(pending.subjects[0].identity, 'dev_aaaa');
    assert.equal(pending.subjects[0].wallet, 'WALLETaa…ffgg', 'wallet truncated 8+4');
    // Legacy mode: no queue access at all.
    const handlersLegacy = mkEcoAdminHandlers({
        ecosystemReady: false, _ecoInitState: { ok: false, code: 'X', message: 'm', at: 1, attempts: 1 },
        dbGetAsync: h.get, dbAllAsync: h.all, ecosystem: svc,
    });
    const res2 = mkAdminRes();
    await handlersLegacy['/admin/api/eco-jobs']({ query: {} }, res2);
    assert.equal(res2.body.legacyMode, true);
    assert.equal(Object.keys(res2.body.counts).length, 0);
    assert.equal(res2.body.jobs.length, 0);
    await h.close();
});

// ===========================================================================
// ecosystem-migration-dryrun.js - the production deploy-safety tool itself
// ===========================================================================
const { spawnSync } = require('child_process');
const DRYRUN_SCRIPT = path.join(__dirname, 'scripts', 'ecosystem-migration-dryrun.js');

// Legacy fixture shaped like a real prod DB: paid users, an ad-stacked plan,
// trial/grace/premium-only rows, a PS device + verified revenue, shared and
// revoke subs rows - everything the baseline must preserve.
const mkDryrunFixture = async () => {
    const { h, dbPath } = await mkEcoAdminDb();
    const t0 = Date.now();
    const DAY = 864e5;
    const DEV = 'dev_' + 'a'.repeat(20);
    const DEV2 = 'dev_' + 'b'.repeat(20);
    await h.run(`INSERT INTO users (id,email) VALUES (1,'u1@x'),(2,'u2@x'),(3,'u3@x'),(4,'u4@x'),(5,'u5@x')`);
    // user 1: active 400GB solana payment with an ad week stacked on top
    const paid1 = t0 - 23 * DAY;
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at) VALUES (1,400,'active',?,'ad_claim',?,?)`, [paid1 + 37 * DAY, paid1, t0]);
    await h.run(`INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (1,'sigU1',400,'monthly',?,?)`, [paid1, paid1]);
    await h.run(`INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,created_at) VALUES ('sigU1',1,'solana',?,NULL,?,?)`, [paid1, paid1 + 30 * DAY, paid1]);
    // user 2: active 1TB solana
    const paid2 = t0 - 10 * DAY;
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,payment_type,payment_at,updated_at) VALUES (2,1000,'active',?,'solana',?,?)`, [paid2 + 30 * DAY, paid2, t0]);
    await h.run(`INSERT INTO solana_payments (user_id,tx_signature,tier_gb,duration,created_at,verified_at) VALUES (2,'sigU2',1000,'monthly',?,?)`, [paid2, paid2]);
    // user 3: live trial; user 4: lapsed into grace; user 5: premium-only
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,trial_until,updated_at) VALUES (3,50,'trial',?,?)`, [t0 + 5 * DAY, t0]);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,grace_until,updated_at) VALUES (4,400,'grace',?,?,?)`, [t0 - DAY, t0 + 6 * DAY, t0]);
    await h.run(`INSERT INTO user_plans (user_id,plan_gb,status,expires_at,premium_gb,premium_expires_at,updated_at) VALUES (5,0,'expired',?,500,?,?)`, [t0 - 40 * DAY, t0 + 60 * DAY, t0]);
    // accounts + members
    await h.run(`INSERT INTO ecosystem_accounts (account_id,created_at) VALUES ('acctP1',?),('acctP2',?),('acctT',?),('acctG',?),('acctPrem',?),('acctPS',?),('acctShared',?),('acctRev',?)`,
        [t0, t0, t0, t0, t0, t0, t0, t0]);
    await h.run(`INSERT INTO ecosystem_members (account_id,app,identity,linked_at) VALUES
        ('acctP1','photolynk','1',?),('acctP2','photolynk','2',?),('acctT','photolynk','3',?),
        ('acctG','photolynk','4',?),('acctPrem','photolynk','5',?),('acctPS','paceseeker',?,?),
        ('acctShared','paceseeker',?,?),('acctRev','paceseeker',?,?)`,
        [t0, t0, t0, t0, t0, DEV, t0, DEV2, t0, 'dev_' + 'c'.repeat(20), t0]);
    // PS device: sub_until covered by the account's shared floor + a verified
    // revenue row; ad_until seeds the local ad benefit.
    await h.run(`INSERT INTO paceseeker_devices (device_hash,sub_until,ad_until) VALUES (?,?,?)`, [DEV, t0 + 10 * DAY, t0 + 2 * DAY]);
    await h.run(`INSERT INTO paceseeker_revenue (signature,device_hash,paid_at,paid_with,plan,reported_at,eco_verified) VALUES ('sigDEV',?,?,'SOL','monthly',?,1)`, [DEV, t0 - 20 * DAY, t0]);
    await h.run(`INSERT INTO stealthlynk_subs (account_id,sub_until,source_app,source_kind,provenance,updated_at) VALUES
        ('acctPS',?,'paceseeker','payment','sigDEV',?),
        ('acctShared',?,'photolynk','payment','sigU2',?),
        ('acctRev',?,'photolynk','revoke',NULL,?)`,
        [t0 + 10 * DAY, t0, t0 + 15 * DAY, t0, t0 + 30 * DAY, t0]);
    await h.close();
    return dbPath;
};

test('migration dry-run on a legacy fixture: exit 0, zero regressions, copy-only', async () => {
    const dbPath = await mkDryrunFixture();
    const jsonOut = path.join(path.dirname(dbPath), 'report.json');
    const r = spawnSync(process.execPath, [DRYRUN_SCRIPT, dbPath, '--json', jsonOut], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    assert.equal(report.regressions.length, 0);
    assert.equal(report.init.migrated, true);
    assert.ok(report.membersResolved >= 8, 'every member resolved');
    assert.ok(fs.existsSync(report.copy) && report.copy !== dbPath, 'operated on a copy');
});

test('migration dry-run detector fires: --inject-regression exits 1', async () => {
    const dbPath = await mkDryrunFixture();
    const r = spawnSync(process.execPath, [DRYRUN_SCRIPT, dbPath, '--inject-regression'], { encoding: 'utf8' });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(/REGRESSIONS \([1-9]/.test(r.stdout), 'human summary reports the planted regression');
    assert.ok(r.stdout.includes('expires_at'), 'the planted expires_at regression is named');
});
