'use strict';

// SOL/SKR payment recovery helpers shared by the client verify endpoints, the
// treasury scanner and the admin recovery routes. Everything here is pure or
// dependency-injected so the logic can be regression-tested against temporary
// SQLite databases and mocked RPC responses - never against live services.

const path = require('path');

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const LAMPORTS_PER_SOL = 1000000000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// SPL Memo program v2 + legacy v1 - PhotoLynk clients tag payments with v2,
// but either program may carry a valid product memo on-chain.
const MEMO_PROGRAM_IDS = new Set([
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

const VALID_TIERS_GB = new Set([100, 200, 400, 1000]);
const VALID_TOKENS = new Set(['SOL', 'SKR']);
const VALID_DURATIONS = new Set(['monthly', 'yearly']);
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

// Outcomes the treasury scanner retries independently of sweep position.
// 'pending' marks a signature that was durably page-persisted but never
// processed (crash/restart mid-run) - it must re-enter the queue immediately.
// 'premium_manual' rows were logged by older scanner builds before automatic
// premium recovery existed - re-evaluating them now credits them or records
// a fresh retryable/terminal outcome.
const RETRYABLE_OUTCOMES = ['no_user', 'code_no_match', 'conflict', 'rpc_error', 'underpaid', 'pending', 'premium_manual'];

// ---------------------------------------------------------------------------
// Keyed same-process mutation gates.
//
// SQLite's BEGIN IMMEDIATE gives cross-process atomicity, but inside this
// process an autopurge/migration writer can still interleave a payment
// credit, and a burst of concurrent BEGIN waiters (node-sqlite3's 4-slot
// libuv pool) can starve the active writer so its COMMIT is never scheduled.
// These promise-keyed gates order same-process work per (db,user) and per
// database file. They are NOT cross-process locks and do no network work.
// ---------------------------------------------------------------------------
const mutationGateTails = new Map();
const resolveGatePath = (dbPath) => {
    try { return path.resolve(String(dbPath)); } catch (_) { return String(dbPath); }
};
const withKeyedGate = (key, fn) => {
    const prev = mutationGateTails.get(key) || Promise.resolve();
    const result = prev.then(() => fn());
    // The stored tail swallows rejections so one failure never wedges the key.
    const tail = result.catch(() => {});
    mutationGateTails.set(key, tail);
    tail.finally(() => {
        if (mutationGateTails.get(key) === tail) mutationGateTails.delete(key);
    });
    return result;
};
const withAccountMutation = (dbPath, userId, fn) =>
    withKeyedGate(`${resolveGatePath(dbPath)}::u:${String(userId)}`, fn);
const withDatabaseWriter = (dbPath, fn) =>
    withKeyedGate(`${resolveGatePath(dbPath)}::db`, fn);

const UPSERT_WALLET_BINDING_SQL =
    `INSERT INTO solana_wallet_bindings(wallet,user_id,verified_at) VALUES (?,?,?) ` +
    `ON CONFLICT(wallet,user_id) DO UPDATE SET verified_at=excluded.verified_at`;

const codedError = (code, message) => {
    const e = new Error(message || code);
    e.code = code;
    return e;
};

// ---------------------------------------------------------------------------
// Memo parsing: PhotoLynk:sub:<tier>:<duration>[:<8-hex payment code>]
// ---------------------------------------------------------------------------
const SUB_MEMO_RE = /^PhotoLynk:sub:(100|200|400|1000):(monthly|yearly)(?::([0-9a-f]{8}))?$/;

function parseSubscriptionMemo(memo) {
    if (typeof memo !== 'string') return null;
    const m = memo.match(SUB_MEMO_RE);
    if (!m) return null;
    return { tierGb: Number(m[1]), duration: m[2], code: m[3] || null };
}

// Premium one-time purchase memo: PhotoLynk:premium:0:premium[:<code8>]
const PREMIUM_MEMO_RE = /^PhotoLynk:premium:0:premium(?::([0-9a-f]{8}))?$/;

function parsePremiumMemo(memo) {
    if (typeof memo !== 'string') return null;
    const m = memo.match(PREMIUM_MEMO_RE);
    if (!m) return null;
    return { tierGb: 0, duration: 'premium', code: m[1] || null };
}

// Strict base58 decode - jsonParsed RPC returns raw instruction `data` base58
// encoded (NOT base64). Returns null on any non-base58 character.
function base58Decode(str) {
    if (typeof str !== 'string' || str.length === 0) return null;
    const digits = [0];
    for (const ch of str) {
        const v = BASE58_ALPHABET.indexOf(ch);
        if (v < 0) return null;
        let carry = v;
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] * 58;
            digits[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry) { digits.push(carry & 0xff); carry >>= 8; }
    }
    let zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros++;
    return Uint8Array.from([...new Array(zeros).fill(0), ...digits.reverse()]);
}

// PaceSeeker sub memo: PS1|monthly|<milliseconds>|<8-hex checksum>[|promo:<14-char PS code>].
// The checksum field is ALWAYS present (native SecurityModule) and is NOT a
// promo marker - a discount exists only with an explicit promo: suffix. The
// timestamp is client-reported telemetry; on-chain blockTime stays
// authoritative for paidAt.
const PS_MEMO_RE = /^PS1\|monthly\|(\d+)\|([0-9a-fA-F]{8})(?:\|promo:(PS[A-Z0-9]{12}))?$/;
// Lane sub memo: LN1|monthly|<milliseconds>|<8-hex checksum>[|promo:<14-char
// LN code>] — same contract as PS1 (checksum is shape-only, timestamp is
// telemetry; on-chain blockTime stays authoritative for paidAt).
const LN_MEMO_RE = /^LN1\|monthly\|(\d+)\|([0-9a-fA-F]{8})(?:\|promo:(LN[A-Z0-9]{12}))?$/;
// ECO2 quote-reference memo: SLQ1|<32-lower-hex quote id>. Optional, carries
// no product intent of its own - it only accompanies a primary product memo.
const QUOTE_MEMO_RE = /^SLQ1\|([0-9a-f]{32})$/;

function parsePaceSeekerMemo(memo) {
    if (typeof memo !== 'string') return null;
    const m = memo.match(PS_MEMO_RE);
    if (!m) return null;
    const timestamp = Number(m[1]);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
    return { duration: 'monthly', reportedPaidAt: timestamp, checksum: m[2].toLowerCase(), promo: m[3] || null };
}

function parseLaneMemo(memo) {
    if (typeof memo !== 'string') return null;
    const m = memo.match(LN_MEMO_RE);
    if (!m) return null;
    const timestamp = Number(m[1]);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
    return { duration: 'monthly', reportedPaidAt: timestamp, checksum: m[2].toLowerCase(), promo: m[3] || null };
}

// All memo-instruction texts on a transaction (parsed string payloads and raw
// base58 instruction data, top-level and inner), from either memo program.
function _memoTexts(tx) {
    const message = tx?.transaction?.message || {};
    const ixs = [
        ...(Array.isArray(message.instructions) ? message.instructions : []),
        ...((Array.isArray(tx?.meta?.innerInstructions) ? tx.meta.innerInstructions : []).flatMap((ii) => ii?.instructions || [])),
    ];
    const texts = [];
    for (const ix of ixs) {
        if (!ix) continue;
        const pid = ix.programId
            || (ix.program === 'spl-memo' ? 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' : null);
        if (!MEMO_PROGRAM_IDS.has(pid)) continue;
        let text = '';
        if (typeof ix.parsed === 'string') {
            text = ix.parsed;
        } else if (ix.data) {
            const raw = base58Decode(String(ix.data));
            if (raw) {
                try { text = Buffer.from(raw).toString('utf8'); } catch (_) { text = ''; }
            }
        }
        if (text) texts.push(text);
    }
    return texts;
}

// The single PhotoLynk product memo on a transaction (parsed string or raw
// base58 memo data). Exactly one product memo is allowed - two product memos
// on one tx (two PhotoLynk memos, or a PhotoLynk memo plus a PS1| memo) is a
// MEMO_MISMATCH, not a first-match win, so a crafted tx cannot satisfy a sub
// verification while also claiming premium or a PaceSeeker sub.
function extractPaymentMemo(tx) {
    const eco = _classifyMemos(tx);
    return eco.pl[0] || null;
}

// Cross-app memo inspection for the ECO2 protocol. Exactly ONE primary
// product memo (PhotoLynk:* or PS1|*) and at most one SLQ1| quote reference;
// unrelated memo text is ignored. Returns null when no primary memo exists,
// {app, memo, tierGb, duration, code, promo, reportedPaidAt, productId,
// quoteId} otherwise.
function extractEcosystemMemo(tx) {
    const cls = _classifyMemos(tx);
    const quoteIds = [];
    for (const t of cls.other) {
        if (t.startsWith('SLQ1|') && !QUOTE_MEMO_RE.test(t)) {
            throw codedError('MEMO_MISMATCH', 'invalid quote memo');
        }
        const q = t.match(QUOTE_MEMO_RE);
        if (q) quoteIds.push(q[1]);
    }
    if (quoteIds.length > 1) {
        throw codedError('MEMO_MISMATCH', `conflicting quote memos (${quoteIds.length})`);
    }
    const quoteId = quoteIds[0] || null;
    if (cls.pl.length) {
        const memo = cls.pl[0];
        const parsed = parseSubscriptionMemo(memo) || parsePremiumMemo(memo);
        if (!parsed) throw codedError('MEMO_MISMATCH', 'invalid product memo');
        return {
            app: 'photolynk', memo,
            tierGb: parsed.tierGb,
            duration: parsed.duration,
            productId: parsed.duration === 'premium' ? 'photolynk.premium' : `photolynk.storage_${parsed.tierGb}`,
            code: parsed.code,
            promo: null, reportedPaidAt: null, quoteId,
        };
    }
    if (cls.ps.length) {
        const memo = cls.ps[0];
        const parsed = parsePaceSeekerMemo(memo);
        if (!parsed) throw codedError('MEMO_MISMATCH', 'invalid product memo');
        return {
            app: 'paceseeker', memo,
            tierGb: null, duration: 'monthly',
            productId: 'paceseeker.monthly',
            code: null,
            promo: parsed.promo,
            reportedPaidAt: parsed.reportedPaidAt,
            quoteId,
        };
    }
    if (cls.ln.length) {
        const memo = cls.ln[0];
        const parsed = parseLaneMemo(memo);
        if (!parsed) throw codedError('MEMO_MISMATCH', 'invalid product memo');
        return {
            app: 'lane', memo,
            tierGb: null, duration: 'monthly',
            productId: 'lane.monthly',
            code: null,
            promo: parsed.promo,
            reportedPaidAt: parsed.reportedPaidAt,
            quoteId,
        };
    }
    return null;
}

function _classifyMemos(tx) {
    const pl = [], ps = [], ln = [], other = [];
    for (const t of _memoTexts(tx)) {
        if (t.startsWith('PhotoLynk:')) pl.push(t);
        else if (t.startsWith('PS1|')) ps.push(t);
        else if (t.startsWith('LN1|')) ln.push(t);
        else other.push(t);
    }
    const total = pl.length + ps.length + ln.length;
    if (total > 1) {
        throw codedError('MEMO_MISMATCH', `conflicting product memos (${total})`);
    }
    return { pl, ps, ln, other };
}

// ---------------------------------------------------------------------------
// Treasury inflow extraction.
// Only counts transfers a transaction SIGNER authorized:
//   SOL - system-program transfer into the treasury wallet, capped by the
//         wallet's positive net balance gain.
//   SKR - spl-token transfer/transferChecked into a token account whose POST
//         balance proves mint/decimals/treasury-owner, from a source account
//         whose PRE balance proves the same mint and authority ownership.
// Exactly one payer across all matched transfers; mixed SOL+SKR and multiple
// payers are ambiguous and rejected.
// ---------------------------------------------------------------------------
const toBig = (v) => {
    if (v === null || v === undefined) return 0n;
    if (typeof v === 'bigint') return v;
    const s = String(v);
    if (!/^\d+$/.test(s)) return 0n;
    return BigInt(s);
};

// Strict variant: meta balances that are unrepresentable (non-integer JS
// numbers, floats, out-of-range strings) mean the RPC payload itself cannot
// be trusted - the tx must be rejected, not silently floored to 0.
const toBigStrict = (v) => {
    if (v === null || v === undefined) return 0n;
    if (typeof v === 'bigint') return v < 0n ? 'unsafe' : v;
    if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v < 0) return 'unsafe';
        return BigInt(v);
    }
    const s = String(v);
    if (!/^\d+$/.test(s)) return 'unsafe';
    return BigInt(s);
};

const parseRawAmount = (v) => {
    const s = String(v ?? '');
    if (!/^\d+$/.test(s)) return null;
    const b = BigInt(s);
    if (b > MAX_SAFE_BIG) return 'unsafe';
    return b;
};

function extractTreasuryTransfer(tx, { wallet, mint, decimals }) {
    if (!tx || typeof tx !== 'object') throw codedError('TX_MALFORMED', 'no transaction object');
    if (!tx.meta || typeof tx.meta !== 'object' || tx.meta.err === undefined) {
        throw codedError('TX_NO_META', 'transaction metadata unavailable');
    }
    if (tx.meta.err !== null) throw codedError('TX_FAILED', 'transaction failed on chain');

    const message = tx.transaction?.message || {};
    const accountKeysRaw = Array.isArray(message.accountKeys) ? message.accountKeys : [];
    const accountKeys = accountKeysRaw.map((k) => (typeof k === 'string' ? k : k?.pubkey || ''));
    const signers = new Set();
    for (const k of accountKeysRaw) {
        if (k && typeof k === 'object' && k.signer === true && k.pubkey) signers.add(k.pubkey);
    }

    const preBalances = Array.isArray(tx.meta.preBalances) ? tx.meta.preBalances : [];
    const postBalances = Array.isArray(tx.meta.postBalances) ? tx.meta.postBalances : [];
    const preTokenBalances = Array.isArray(tx.meta.preTokenBalances) ? tx.meta.preTokenBalances : [];
    const postTokenBalances = Array.isArray(tx.meta.postTokenBalances) ? tx.meta.postTokenBalances : [];

    // Any unrepresentable lamport balance anywhere in meta poisons net-gain
    // math - reject rather than floor to 0.
    for (const b of [...preBalances, ...postBalances]) {
        if (toBigStrict(b) === 'unsafe') {
            throw codedError('UNSAFE_AMOUNT', 'unsafe lamport balance in transaction meta');
        }
    }

    const instructions = [
        ...(Array.isArray(message.instructions) ? message.instructions : []),
        ...((Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : []).flatMap((ii) => ii?.instructions || [])),
    ];

    const solTransfers = []; // {source, raw:BigInt}
    const skrTransfers = []; // {authority, raw:BigInt, destIdx}

    for (const ix of instructions) {
        if (!ix) continue;
        const programId = ix.programId
            || (ix.program === 'system' ? SYSTEM_PROGRAM_ID : ix.program === 'spl-token' ? TOKEN_PROGRAM_ID : null);
        const parsed = ix.parsed;

        if (programId === SYSTEM_PROGRAM_ID && parsed?.type === 'transfer') {
            const info = parsed.info || {};
            if (info.destination !== wallet) continue;
            if (!info.source || !signers.has(info.source)) continue;
            const raw = parseRawAmount(info.lamports);
            if (raw === 'unsafe') throw codedError('UNSAFE_AMOUNT', 'unsafe lamports value');
            if (raw === null || raw <= 0n) continue;
            solTransfers.push({ source: info.source, raw });
            continue;
        }

        if (programId === TOKEN_PROGRAM_ID && (parsed?.type === 'transfer' || parsed?.type === 'transferChecked')) {
            const info = parsed.info || {};
            if (!info.authority || !signers.has(info.authority)) continue;
            // Treasury -> treasury transfers are collected as selfPayments: only
            // the treasury can sign them, and the signed amount is the proof.
            const destIdx = accountKeys.indexOf(info.destination);
            const srcIdx = accountKeys.indexOf(info.source);
            if (destIdx < 0 || srcIdx < 0) continue;
            // Destination must PROVE itself a treasury token account for this
            // mint via its post balance - no "wallet present in keys" fallback.
            const postDest = postTokenBalances.find(
                (b) => b.accountIndex === destIdx && b.mint === mint && b.owner === wallet
                    && Number(b?.uiTokenAmount?.decimals) === Number(decimals)
            );
            if (!postDest) continue;
            // Source must prove same mint + authority ownership via pre balance.
            const preSrc = preTokenBalances.find((b) => b.accountIndex === srcIdx && b.mint === mint);
            if (!preSrc || preSrc.owner !== info.authority) continue;
            if (parsed.type === 'transferChecked') {
                if (info.mint !== mint) continue;
                if (Number(info.tokenAmount?.decimals) !== Number(decimals)) continue;
            }
            const raw = parseRawAmount(parsed.type === 'transferChecked' ? info.tokenAmount?.amount : info.amount);
            if (raw === 'unsafe') throw codedError('UNSAFE_AMOUNT', 'unsafe token amount');
            if (raw === null || raw <= 0n) continue;
            skrTransfers.push({ authority: info.authority, raw, destIdx });
        }
    }

    if (solTransfers.length && skrTransfers.length) {
        throw codedError('AMBIGUOUS_PAYMENT', 'mixed SOL and SKR inflow in one transaction');
    }

    if (solTransfers.length) {
        const payers = new Set(solTransfers.map((t) => t.source));
        if (payers.size !== 1) throw codedError('AMBIGUOUS_PAYMENT', 'multiple SOL payers');
        // Treasury self-payment: source AND destination are the treasury, so the
        // net balance gain is zero/negative. Only the treasury keyholder can sign
        // such a transfer (source must be a signer), so the signed instruction
        // amount itself is the proof of payment.
        const selfPay = solTransfers[0].source === wallet;
        const walletIdx = accountKeys.indexOf(wallet);
        const netGain = walletIdx >= 0 ? toBig(postBalances[walletIdx]) - toBig(preBalances[walletIdx]) : 0n;
        const ixSum = solTransfers.reduce((acc, t) => acc + t.raw, 0n);
        if (ixSum > MAX_SAFE_BIG) throw codedError('UNSAFE_AMOUNT', 'summed lamports exceed safe range');
        const amount = selfPay ? ixSum : (ixSum < netGain ? ixSum : netGain);
        if (amount <= 0n) throw codedError('NO_INFLOW', 'no positive net SOL gain for treasury');
        return {
            token: 'SOL',
            amount: Number(amount) / LAMPORTS_PER_SOL,
            rawAmount: amount.toString(),
            senderWallet: solTransfers[0].source,
            selfPayment: selfPay,
            blockTime: tx.blockTime ?? null,
            slot: tx.slot ?? null,
        };
    }

    if (skrTransfers.length) {
        const payers = new Set(skrTransfers.map((t) => t.authority));
        if (payers.size !== 1) throw codedError('AMBIGUOUS_PAYMENT', 'multiple SKR payers');
        const selfPay = skrTransfers[0].authority === wallet;
        let total;
        if (selfPay) {
            // Self-payment: source and destination share the treasury balance,
            // net gain is zero - the signed instruction amount is the proof.
            total = skrTransfers.reduce((acc, t) => acc + t.raw, 0n);
        } else {
            // Per receiving account: cap instruction sum by that account's net gain.
            const byDest = new Map();
            for (const t of skrTransfers) byDest.set(t.destIdx, (byDest.get(t.destIdx) || 0n) + t.raw);
            total = 0n;
            for (const [destIdx, sum] of byDest) {
                const pre = preTokenBalances.find((b) => b.accountIndex === destIdx && b.mint === mint);
                const post = postTokenBalances.find((b) => b.accountIndex === destIdx && b.mint === mint);
                const preRaw = toBigStrict(pre?.uiTokenAmount?.amount);
                const postRaw = toBigStrict(post?.uiTokenAmount?.amount);
                if (preRaw === 'unsafe' || postRaw === 'unsafe') {
                    throw codedError('UNSAFE_AMOUNT', 'unsafe token balance in transaction meta');
                }
                let net = postRaw - preRaw;
                if (net < 0n) net = 0n;
                total += sum < net ? sum : net;
            }
        }
        if (total > MAX_SAFE_BIG) throw codedError('UNSAFE_AMOUNT', 'summed token amount exceeds safe range');
        if (total <= 0n) throw codedError('NO_INFLOW', 'no positive net SKR gain for treasury');
        return {
            token: 'SKR',
            amount: Number(total) / Math.pow(10, Number(decimals)),
            rawAmount: total.toString(),
            senderWallet: skrTransfers[0].authority,
            selfPayment: selfPay,
            blockTime: tx.blockTime ?? null,
            slot: tx.slot ?? null,
        };
    }

    throw codedError('NO_INFLOW', 'no qualifying treasury transfer');
}

// ---------------------------------------------------------------------------
// Duplicate-row comparison shared by the client early check, the creditor's
// locked re-check and the admin inspector. Legacy rows lack payment_token and
// mean SOL.
// ---------------------------------------------------------------------------
function samePaymentRow(row, { userId, token, tierGb, duration }) {
    if (!row) return false;
    const rowToken = row.payment_token || 'SOL';
    return Number(row.user_id) === Number(userId)
        && String(rowToken) === String(token)
        && Number(row.tier_gb) === Number(tierGb)
        && String(row.duration || 'monthly') === String(duration || 'monthly');
}

// ---------------------------------------------------------------------------
// Atomic subscription creditor. Each call opens a dedicated SQLite connection
// (the shared server handle has unrelated traffic and must never BEGIN), runs
// BEGIN IMMEDIATE and writes payment + plan + audit in one transaction.
// ---------------------------------------------------------------------------
function createSubscriptionCreditor({ sqlite3, dbPath, computeExpiry, durations, ecosystem = null }) {
    if (!sqlite3 || !dbPath || typeof computeExpiry !== 'function' || !durations) {
        throw codedError('BAD_CREDITOR_CONFIG', 'createSubscriptionCreditor requires {sqlite3, dbPath, computeExpiry, durations}');
    }

    // All DB work lives in this UNLOCKED helper - callers must never invoke
    // it directly without the gates, and it must never re-acquire them.
    const creditUnlocked = async ({
        userId, signature, token, amount, tierGb, duration,
        paymentAt, source, detail, preserveTier = false,
        amountAtomic = null, payerWallet = null, mint = null, quoteId = null, evidence = null,
    }) => {
        const uid = Number(userId);
        if (!Number.isInteger(uid) || uid <= 0) throw codedError('INVALID_INPUT', 'invalid userId');
        // Canonicalize before ANY query or write: '  sig  ' and 'sig' are the
        // same payment - trimming is what makes the UNIQUE key idempotent.
        const sig = String(signature ?? '').trim();
        if (!sig) throw codedError('INVALID_INPUT', 'invalid signature');
        if (!VALID_TOKENS.has(token)) throw codedError('INVALID_INPUT', 'invalid token');
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) throw codedError('INVALID_INPUT', 'invalid amount');
        const tier = Number(tierGb);
        if (!VALID_TIERS_GB.has(tier)) throw codedError('INVALID_INPUT', 'invalid tierGb');
        // Own enum - never `durations[duration]`, which would accept inherited
        // prototype properties like 'toString'.
        const durationMs = VALID_DURATIONS.has(duration) ? Number(durations[duration]) : NaN;
        if (!Number.isFinite(durationMs) || durationMs <= 0) throw codedError('INVALID_INPUT', 'invalid duration');
        const payAt = Number(paymentAt);
        if (!Number.isFinite(payAt) || payAt <= 0) throw codedError('INVALID_INPUT', 'invalid paymentAt');

        // A failed open (missing parent dir, permissions) surfaces through the
        // constructor callback - without it sqlite emits an 'error' event on
        // the handle and crashes the process.
        let conn = null;
        let begun = false;
        const run = (sql, params = []) => new Promise((resolve, reject) => {
            conn.run(sql, params, function (e) { e ? reject(e) : resolve(this); });
        });
        const get = (sql, params = []) => new Promise((resolve, reject) => {
            conn.get(sql, params, (e, row) => { e ? reject(e) : resolve(row); });
        });
        const all = (sql, params = []) => new Promise((resolve, reject) => {
            conn.all(sql, params, (e, rows) => { e ? reject(e) : resolve(rows || []); });
        });

        try {
            conn = await new Promise((resolve, reject) => {
                const c = new sqlite3.Database(dbPath, (e) => (e ? reject(e) : resolve(c)));
            });
            conn.configure('busyTimeout', 10000);
            await run('PRAGMA foreign_keys = ON');
            await run('BEGIN IMMEDIATE');
            begun = true;

            const now = Date.now();
            const user = await get('SELECT id FROM users WHERE id = ?', [uid]);
            if (!user) throw codedError('NO_USER', `user ${uid} not found`);
            const existing = await get('SELECT * FROM solana_payments WHERE tx_signature = ?', [sig]);
            const currentPlan = await get('SELECT * FROM user_plans WHERE user_id = ?', [uid]);

            if (existing) {
                if (!samePaymentRow(existing, { userId: uid, token, tierGb: tier, duration })) {
                    throw codedError('PAYMENT_CONFLICT', 'tx_signature already recorded for a different payment');
                }
                await run('COMMIT');
                begun = false;
                return {
                    alreadyProcessed: true,
                    expiresAt: currentPlan?.expires_at ?? null,
                    planGb: currentPlan?.plan_gb ?? null,
                    status: currentPlan?.status ?? null,
                };
            }

            const expiry = computeExpiry({ currentPlan, purchaseAt: payAt, durationMs });
            const paymentType = token === 'SKR' ? 'skr' : 'solana';
            let eco = null;
            if (ecosystem) {
                eco = await ecosystem.applyPhotolynkInTransaction({ run, get, all }, {
                    signature: sig, userId: uid, token,
                    amountAtomic: amountAtomic == null ? null : String(amountAtomic),
                    payerWallet: payerWallet || null,
                    paidAt: payAt, verifiedAt: now, tierGb: tier, duration, source,
                    quoteId: quoteId || null, mint: mint || null,
                    evidence: evidence || null,
                }, currentPlan);
                if (eco && eco.ok === false) {
                    // The core already committed nothing; persist a conflict
                    // audit row under this tx, commit it, then fail closed.
                    await run(
                        `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at)
                         VALUES (?,?,?,?,?,?,?,?)`,
                        [sig, uid, 'eco_conflict', payAt, currentPlan?.expires_at ?? null, currentPlan?.expires_at ?? null,
                         String(`${eco.code || 'conflict'}:${JSON.stringify(eco.conflicting || {}).slice(0, 400)}`).slice(0, 500), now]);
                    await run('COMMIT');
                    begun = false;
                    throw codedError('PAYMENT_CONFLICT', eco.code || 'payment conflict');
                }
            }
            const expiresAt = eco ? (Number(eco.expiresAt) || 0)
                : Math.max(Number(expiry?.expiresAt) || 0, Number(currentPlan?.expires_at) || 0);
            const planGb = eco ? (Number(eco.planGb) || 0)
                : (preserveTier ? Math.max(Number(currentPlan?.plan_gb) || 0, tier) : tier);
            const status = eco ? (eco.status || (expiresAt > now ? 'active' : 'expired'))
                : (expiresAt > now ? 'active' : (currentPlan?.status || 'expired'));

            try {
                await run(
                    `INSERT INTO solana_payments (user_id,tx_signature,sol_amount,skr_amount,payment_token,tier_gb,duration,created_at,verified_at)
                     VALUES (?,?,?,?,?,?,?,?,?)`,
                    [uid, sig, token === 'SOL' ? amt : 0, token === 'SKR' ? amt : 0, token, tier, duration, payAt, now]
                );
            } catch (e) {
                // Lost a race with a concurrent credit of the same signature:
                // re-read under the write lock and apply the same dup rules.
                // A constraint failure for any other reason is NOT a duplicate.
                if (/UNIQUE/i.test(e.message || '')) {
                    const raced = await get('SELECT * FROM solana_payments WHERE tx_signature = ?', [sig]);
                    if (raced) {
                        if (!samePaymentRow(raced, { userId: uid, token, tierGb: tier, duration })) {
                            throw codedError('PAYMENT_CONFLICT', 'tx_signature already recorded for a different payment');
                        }
                        await run('COMMIT');
                        begun = false;
                        return {
                            alreadyProcessed: true,
                            expiresAt: currentPlan?.expires_at ?? null,
                            planGb: currentPlan?.plan_gb ?? null,
                            status: currentPlan?.status ?? null,
                        };
                    }
                }
                throw e;
            }

            if (eco) {
                // The core already projected plan_gb/status/expires_at and the
                // real payment_type - only the purchase timestamp and the
                // one-time trial carryover marker move here.
                await run(
                    `UPDATE user_plans SET
                        payment_at = MAX(COALESCE(user_plans.payment_at, 0), ?),
                        trial_carryover_applied_at = COALESCE(?, user_plans.trial_carryover_applied_at),
                        updated_at = ?
                     WHERE user_id = ?`,
                    [payAt, expiry?.trialCarryoverAppliedAt ?? null, now, uid]);
            } else {
                await run(
                    `INSERT INTO user_plans (user_id,plan_gb,status,expires_at,trial_carryover_applied_at,payment_type,payment_at,grace_until,deleted_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,NULL,NULL,?)
                     ON CONFLICT(user_id) DO UPDATE SET
                        plan_gb=excluded.plan_gb,status=excluded.status,expires_at=excluded.expires_at,
                        trial_carryover_applied_at=COALESCE(excluded.trial_carryover_applied_at,user_plans.trial_carryover_applied_at),
                        payment_type=CASE WHEN COALESCE(user_plans.payment_at,0)<=excluded.payment_at THEN excluded.payment_type ELSE user_plans.payment_type END,
                        payment_at=MAX(COALESCE(user_plans.payment_at,0),excluded.payment_at),
                        grace_until=CASE WHEN excluded.expires_at>? THEN NULL ELSE user_plans.grace_until END,
                        deleted_at=CASE WHEN excluded.expires_at>? THEN NULL ELSE user_plans.deleted_at END, updated_at=excluded.updated_at`,
                    [uid, planGb, status, expiresAt, expiry?.trialCarryoverAppliedAt ?? null, paymentType, payAt, now, now, now]
                );
            }

            await run(
                `INSERT INTO solana_subscription_credits (tx_signature,user_id,source,payment_at,expires_before,expires_after,detail,created_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [sig, uid, String(source || 'unknown'), payAt, currentPlan?.expires_at ?? null, expiresAt,
                 detail ? String(detail).slice(0, 500) : null, now]
            );

            await run('COMMIT');
            begun = false;
            return { alreadyProcessed: false, expiresAt, planGb, status, paymentAt: payAt };
        } catch (e) {
            if (begun) {
                try { await run('ROLLBACK'); } catch (_) { /* connection dies anyway */ }
            }
            throw e;
        } finally {
            if (conn) await new Promise((resolve) => conn.close(() => resolve()));
        }
    };

    // Account gate first (serializes vs autopurge/migration for THIS user),
    // then the database-writer gate (bounds concurrent BEGIN IMMEDIATE
    // waiters so the active writer can always schedule its COMMIT).
    return async function credit(args) {
        return withAccountMutation(dbPath, args?.userId, () =>
            withDatabaseWriter(dbPath, () => creditUnlocked(args)));
    };
}

// ---------------------------------------------------------------------------
// Rolling-sweep signature collection for the treasury scanner.
// Per endpoint+address: always fetch the newest head page, then continue a
// persisted backward sweep cursor for up to maxSweepPages pages per run. The
// sweep NEVER consults processed-payment state, so it cannot stall at a known
// signature; on history exhaustion the cursor clears and the next run sweeps
// fresh from the head. Malformed/erroring pages skip that endpoint only.
//
// Budget is INDEPENDENT per endpoint (head + sweepPages whole pages each):
// a busy first endpoint can never starve a deeper one, and a page is only
// discarded when the endpoint never answered. maxSigs derives the default
// sweep depth (500/100 -> 4 sweep pages) but never truncates fetched pages.
// A getState failure logs and skips the sweep - the persisted cursor is left
// untouched, never silently reset.
// ---------------------------------------------------------------------------
async function collectTreasurySignatures({
    endpoints, address, rpcOn,
    getState, setState, clearState,
    onPage = null,
    sleep = async () => { },
    pageLimit = 100, maxSigs = 500, maxSweepPages = null,
    commitment = 'finalized',
    log = console.warn,
}) {
    const sweepPages = Number.isInteger(maxSweepPages) && maxSweepPages >= 0
        ? maxSweepPages
        : Math.max(0, Math.floor(maxSigs / pageLimit) - 1);
    const collected = [];
    const seen = new Set();
    const push = (entry) => {
        const sig = entry?.signature;
        if (!sig || seen.has(sig)) return;
        seen.add(sig);
        collected.push(entry);
    };
    // Durable page persistence hook: invoked for EVERY fetched page BEFORE
    // the entries are consumed and before the sweep cursor advances, so a
    // crash after persistence still leaves every signature processable via
    // the retry queue. A persistence failure must not advance the cursor.
    const emitPage = async (entries) => {
        if (typeof onPage !== 'function' || !Array.isArray(entries) || entries.length === 0) return;
        await onPage(entries);
    };

    for (const endpoint of endpoints || []) {
        let head;
        try {
            head = await rpcOn(endpoint, 'getSignaturesForAddress', [address, { limit: pageLimit, commitment }]);
            if (!Array.isArray(head)) throw codedError('RPC_MALFORMED', 'getSignaturesForAddress result is not a list');
            await emitPage(head);
        } catch (e) {
            log(`[collectTreasurySignatures] head page failed on ${endpoint}: ${e.message}`);
            continue; // endpoint failed: other endpoints still sweep
        }
        for (const entry of head) push(entry);

        const stateKey = JSON.stringify(['history_v2', endpoint, address]);
        let persisted = null;
        try {
            persisted = await getState(stateKey);
        } catch (e) {
            // Never silently reset sweep progress: leave the stored cursor
            // alone and just skip the sweep for this endpoint this run.
            log(`[collectTreasurySignatures] state read failed for ${endpoint}: ${e.message}`);
            continue;
        }
        let before = persisted && persisted.before ? persisted.before : null;
        // No cursor yet: only start a sweep when the head page is FULL (a
        // short head already IS the endpoint's whole history). A persisted
        // cursor always resumes - even on a shallow endpoint whose head is
        // short, the backlog behind the cursor still needs draining.
        if (!before && head.length >= pageLimit) {
            before = head[head.length - 1]?.signature || null;
        }
        for (let p = 0; p < sweepPages && before; p++) {
            let page;
            try {
                page = await rpcOn(endpoint, 'getSignaturesForAddress', [address, { limit: pageLimit, commitment, before }]);
                if (!Array.isArray(page)) throw codedError('RPC_MALFORMED', 'getSignaturesForAddress result is not a list');
                // Persist the page BEFORE consuming it or moving the cursor:
                // if the marker write fails the cursor stays put and the page
                // is re-fetched (and re-persisted) on the next run.
                await emitPage(page);
            } catch (e) {
                log(`[collectTreasurySignatures] sweep page failed on ${endpoint}: ${e.message}`);
                break; // leave the persisted cursor - resume next run
            }
            for (const entry of page) push(entry);
            if (page.length < pageLimit) {
                // History exhausted on this endpoint - reset to head next run.
                try { await clearState(stateKey); } catch (e) {
                    log(`[collectTreasurySignatures] state clear failed for ${endpoint}: ${e.message}`);
                }
                before = null;
                break;
            }
            before = page[page.length - 1]?.signature || null;
            try { await setState(stateKey, { before }); } catch (e) {
                log(`[collectTreasurySignatures] state persist failed for ${endpoint}: ${e.message}`);
            }
            await sleep(300);
        }
    }
    return collected;
}

// Unique positive user ids from solana_wallet_bindings join rows. Ambiguity
// (more than one bound owner) is surfaced to the caller - never guessed away.
const boundUserIds = (rows) => [...new Set((rows || [])
    .map((r) => Number(r?.id))
    .filter((n) => Number.isInteger(n) && n > 0))];

// Accounts an ADMIN already attributed this payer wallet to via the explicit
// treasury-recovery flow. Rows come from the solana_subscription_credits JOIN
// solana_payments JOIN users query in server.js - this is prior recorded
// approval evidence, not cryptographic ownership and not payment-history
// inference: the row must be an admin_recovery credit whose detail JSON names
// this exact payer, carries the matching memo tier/duration, and predates the
// payment now being attributed. Returns [] on any doubt.
function approvedRecoveryUsers(walletAddress, paymentAt, rows) {
    const out = new Map();
    if (!walletAddress || !Number.isFinite(Number(paymentAt))) return [];
    for (const row of rows || []) {
        if (row.source !== 'admin_recovery' || !(Number(row.payment_at) > 0) || Number(row.payment_at) > Number(paymentAt)) continue;
        let detail; try { detail = JSON.parse(row.detail); } catch { continue; }
        const memo = parseSubscriptionMemo(detail?.memo);
        if (detail?.payer !== walletAddress || typeof detail.admin !== 'string' || !detail.admin || !memo || memo.tierGb !== Number(row.tier_gb) || memo.duration !== row.duration) continue;
        const id = Number(row.user_id);
        if (Number.isInteger(id) && id > 0) out.set(id, { id, email: row.email, source: 'admin_recovery' });
    }
    return [...out.values()];
}

// Merge freshly collected entries with the retry queue (old retryable scan
// outcomes). Returns { queue, retrySet } - queue entries keep their RPC info,
// retrySet marks signatures exempt from the sticky seen-outcome skip.
function buildScanQueue(collectedEntries, retrySignatures) {
    const seen = new Set();
    const queue = [];
    for (const e of collectedEntries || []) {
        const sig = e?.signature;
        if (!sig || seen.has(sig)) continue;
        seen.add(sig);
        queue.push(e);
    }
    const retrySet = new Set();
    for (const sig of retrySignatures || []) {
        if (!sig) continue;
        retrySet.add(sig);
        if (!seen.has(sig)) {
            seen.add(sig);
            queue.push({ signature: sig });
        }
    }
    return { queue, retrySet };
}

// ---------------------------------------------------------------------------
// Wallet ownership proof used by /api/wallet-login and /api/ecosystem/bind-wallet.
// Verifies the ed25519 signature AND that the public key encodes to the claimed
// base58 address - run BEFORE any account repair or binding write.
// ---------------------------------------------------------------------------
function verifyWalletOwnership({ nacl, naclUtil, base58Encode, publicKeyB64, signatureB64, messageBytes, walletAddress }) {
    let publicKeyBytes, signatureBytes;
    try {
        publicKeyBytes = naclUtil.decodeBase64(publicKeyB64);
        signatureBytes = naclUtil.decodeBase64(signatureB64);
    } catch (e) {
        return { ok: false, status: 400, error: 'Invalid signature encoding' };
    }
    if (publicKeyBytes.length !== nacl.sign.publicKeyLength) {
        return { ok: false, status: 400, error: 'Invalid public key length' };
    }
    if (signatureBytes.length !== nacl.sign.signatureLength) {
        return { ok: false, status: 400, error: 'Invalid signature length' };
    }
    if (!nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes)) {
        return { ok: false, status: 401, error: 'Invalid wallet signature' };
    }
    if (base58Encode(publicKeyBytes) !== String(walletAddress || '').trim()) {
        return { ok: false, status: 400, error: 'Public key does not match wallet address' };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin inspector: read-only validation of an on-chain payment against a
// selected user. Every check the recovery POST depends on runs here; it never
// writes anything.
// ---------------------------------------------------------------------------
const TX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BASE58_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

// The recover POST may only proceed on an explicit boolean confirm:true.
const recoveryConfirmed = (body) => body?.confirm === true;

function createTreasuryInspector({
    fetchTx,
    getUserById,
    getPaymentBySignature,
    getPlanByUser,
    resolvePaymentCode,
    getBoundUsersByWallet,
    getLegacyWalletCandidates,
    getPriceBand,
    evaluatePayment,
    computeExpiry,
    durations,
    extractMemo,
    treasury,                    // { wallet, mint, decimals }
    planPricesUsd,
    skrSubscriptionMultiplier = 1,
    maxTxAgeMs = TX_MAX_AGE_MS,
    now = () => Date.now(),
}) {
    return async function inspect(signature, userId) {
        const sig = String(signature || '').trim();
        if (!BASE58_SIG_RE.test(sig)) {
            return { ok: false, status: 400, code: 'BAD_SIGNATURE', error: 'Invalid transaction signature' };
        }
        const uid = Number(userId);
        if (!Number.isInteger(uid) || uid <= 0) {
            return { ok: false, status: 400, code: 'BAD_USER', error: 'Invalid userId' };
        }
        const user = await getUserById(uid);
        if (!user) return { ok: false, status: 404, code: 'NO_USER', error: 'User not found' };

        const tx = await fetchTx(sig);
        if (!tx) return { ok: false, status: 502, code: 'TX_NOT_FOUND', error: 'Transaction not available on any RPC endpoint' };
        if (!tx.meta || tx.meta.err === undefined) {
            return { ok: false, status: 502, code: 'TX_NO_META', error: 'Transaction metadata unavailable' };
        }
        if (tx.meta.err !== null) {
            return { ok: false, status: 400, code: 'TX_FAILED', error: 'Transaction failed on chain' };
        }
        const paymentAt = Number(tx.blockTime) > 0 ? tx.blockTime * 1000 : null;
        if (!paymentAt) {
            return { ok: false, status: 502, code: 'TX_NO_BLOCKTIME', error: 'Transaction blockTime unavailable' };
        }
        const historical = (now() - paymentAt) > maxTxAgeMs;

        let transfer;
        try {
            transfer = extractTreasuryTransfer(tx, treasury);
        } catch (e) {
            return { ok: false, status: 400, code: e.code || 'TX_INVALID', error: e.message };
        }

        let memo;
        try {
            memo = extractMemo(tx);
        } catch (e) {
            return { ok: false, status: 400, code: e.code || 'MEMO_MISMATCH', error: e.message };
        }
        const parsed = parseSubscriptionMemo(memo);
        if (!parsed) {
            return {
                ok: false, status: 400, code: 'NO_SUB_MEMO',
                error: 'Transaction carries no valid PhotoLynk subscription memo',
                detail: { memo: memo || null, payer: transfer.senderWallet },
            };
        }

        // An SLQ1 quote reference changes who may redeem this payment - the
        // caller must route it through the protocol, not the legacy credit.
        let quoteId = null;
        try {
            const eco = extractEcosystemMemo(tx);
            if (eco && eco.quoteId) quoteId = eco.quoteId;
        } catch (e) {
            return { ok: false, status: 400, code: e.code || 'MEMO_MISMATCH', error: e.message };
        }

        const isSkr = transfer.token === 'SKR';
        const expectedUsd = (planPricesUsd[parsed.tierGb] || 0)
            * (parsed.duration === 'yearly' ? 12 : 1)
            * (isSkr ? skrSubscriptionMultiplier : 1);
        let price;
        if (historical) {
            price = { expectedUsd, ok: false, reason: 'historical_review' };
        } else {
            const band = await getPriceBand(isSkr ? 'skr' : 'sol');
            if (!band) {
                price = { expectedUsd, ok: null, reason: 'PRICE_UNAVAILABLE' };
            } else {
                const ev = evaluatePayment({ receivedUnits: transfer.amount, expectedUsd, band });
                price = { expectedUsd, ok: ev.ok, minAcceptable: ev.minAcceptable, expectedAtLatest: ev.expectedAtLatest };
            }
        }

        // Verified wallet bindings are checked on BOTH attribution paths:
        // a wallet bound to multiple users is always ambiguous, and a wallet
        // uniquely bound to a different user conflicts even when a valid
        // HMAC code is present (the code names the recipient, but the payer's
        // proven wallet must not contradict it).
        const boundRows = transfer.senderWallet ? (await getBoundUsersByWallet(transfer.senderWallet, paymentAt)) || [] : [];
        const boundIds = boundUserIds(boundRows);
        if (boundIds.length > 1) {
            return { ok: false, status: 409, code: 'ATTRIBUTION_CONFLICT', error: 'Payer wallet is bound to multiple users' };
        }
        let attribution;
        if (parsed.code) {
            const codeUser = await resolvePaymentCode(parsed.code);
            if (!codeUser) {
                return { ok: false, status: 400, code: 'CODE_NO_MATCH', error: 'Payment code matched no user' };
            }
            if (Number(codeUser.id) !== uid) {
                return { ok: false, status: 409, code: 'ATTRIBUTION_CONFLICT', error: 'Payment code belongs to a different user' };
            }
            if (boundIds.length === 1 && boundIds[0] !== uid) {
                return { ok: false, status: 409, code: 'ATTRIBUTION_CONFLICT', error: 'Payer wallet is verified-bound to a different user' };
            }
            attribution = 'payment_code';
        } else {
            if (boundIds.length === 1 && boundIds[0] !== uid) {
                return { ok: false, status: 409, code: 'ATTRIBUTION_CONFLICT', error: 'Payer wallet is verified-bound to a different user' };
            }
            const boundRow = boundRows.find((r) => Number(r.id) === boundIds[0]);
            attribution = boundIds.length !== 1 ? 'admin_required'
                : (boundRow?.source === 'admin_recovery' ? 'prior_admin_assignment' : 'verified_wallet');
        }

        const existing = await getPaymentBySignature(sig);
        let alreadyProcessed = false;
        if (existing) {
            if (!samePaymentRow(existing, { userId: uid, token: transfer.token, tierGb: parsed.tierGb, duration: parsed.duration })) {
                return { ok: false, status: 409, code: 'PAYMENT_CONFLICT', error: 'Transaction already recorded for a different payment' };
            }
            alreadyProcessed = true;
        }

        const currentPlan = await getPlanByUser(uid);
        let expectedExpiresAt = currentPlan?.expires_at ?? null;
        if (!alreadyProcessed) {
            const expiry = computeExpiry({ currentPlan, purchaseAt: paymentAt, durationMs: durations[parsed.duration] });
            expectedExpiresAt = Math.max(Number(expiry?.expiresAt) || 0, Number(currentPlan?.expires_at) || 0);
        }

        const candidates = transfer.senderWallet ? (await getLegacyWalletCandidates(transfer.senderWallet)) || [] : [];

        return {
            ok: true,
            inspection: {
                user: { id: user.id, email: user.email, displayName: user.alias_email || user.email },
                signature: sig,
                memo,
                payer: transfer.senderWallet,
                token: transfer.token,
                amount: transfer.amount,
                rawAmount: transfer.rawAmount,
                tierGb: parsed.tierGb,
                duration: parsed.duration,
                paymentAt,
                historical,
                alreadyProcessed,
                quoteId,
                attribution,
                candidates: candidates.map((c) => ({
                    id: c.id, email: c.email, alias_email: c.alias_email, wallet_address: c.wallet_address,
                })),
                expectedExpiresAt,
                planGb: currentPlan?.plan_gb ?? null,
                planStatus: currentPlan?.status ?? null,
                price,
            },
        };
    };
}

module.exports = {
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    LAMPORTS_PER_SOL,
    VALID_TIERS_GB,
    RETRYABLE_OUTCOMES,
    UPSERT_WALLET_BINDING_SQL,
    MEMO_PROGRAM_IDS,
    BASE58_ALPHABET,
    base58Decode,
    parseSubscriptionMemo,
    parsePremiumMemo,
    parsePaceSeekerMemo,
    parseLaneMemo,
    PS_MEMO_RE,
    LN_MEMO_RE,
    QUOTE_MEMO_RE,
    extractPaymentMemo,
    extractEcosystemMemo,
    extractTreasuryTransfer,
    boundUserIds,
    approvedRecoveryUsers,
    samePaymentRow,
    createSubscriptionCreditor,
    collectTreasurySignatures,
    buildScanQueue,
    verifyWalletOwnership,
    createTreasuryInspector,
    recoveryConfirmed,
    withAccountMutation,
    withDatabaseWriter,
    BASE58_SIG_RE,
    TX_MAX_AGE_MS,
};
