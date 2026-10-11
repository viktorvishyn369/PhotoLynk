'use strict';

const crypto = require('crypto');
const paymentRecovery = require('./paymentRecovery');

const QUOTE_TTL_MS = 5 * 60 * 1000;
const QUOTE_BLOCKTIME_PAD_MS = 2000;
const KEY_ID = 'rc-v1';
const POLICY_VERSION = 2;
const JOB_LEASE_MS = 180000;
const RECONCILE_CONCURRENCY = 2;

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Exact published product prices in USD cents. Yearly = monthly x 12.
const PLAN_PRICES_CENTS = {
    'paceseeker.monthly': { app: 'paceseeker', usdCents: 399, tierGb: 0, durations: ['monthly'] },
    'photolynk.storage_100': { app: 'photolynk', usdCents: 175, tierGb: 100, durations: ['monthly', 'yearly'] },
    'photolynk.storage_200': { app: 'photolynk', usdCents: 245, tierGb: 200, durations: ['monthly', 'yearly'] },
    'photolynk.storage_400': { app: 'photolynk', usdCents: 399, tierGb: 400, durations: ['monthly', 'yearly'] },
    'photolynk.storage_1000': { app: 'photolynk', usdCents: 799, tierGb: 1000, durations: ['monthly', 'yearly'] },
    'photolynk.premium': { app: 'photolynk', usdCents: 4999, tierGb: 0, durations: ['premium'] },
};

// Legacy PS promo: the memo's trailing 8-hex field marks a discounted payment.
// Its checksum is native-side (not server-verifiable); presence alone accepts
// the historical 50% discount, rounded to a whole-cent expectation.
const PS_LEGACY_PROMO_CENTS = Math.round(399 * 0.5);

const codedError = (code, message, extra) => {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
};
const isNonBlank = (v) => typeof v === 'string' && v.trim().length > 0;
const BASE58_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

// Same promo checksum the native client computes (fnv1a32 over code+pepper).
// The checksum is shape verification only - no claim it is cryptographic.
const PROMO_PEPPER = 'PS_PROMO_V1_PEPPER';
function _fnv1a32(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        hash |= 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
function promoCodeValid(code) {
    const c = String(code || '').trim().toUpperCase();
    if (c.length !== 14 || !c.startsWith('PS')) return false;
    return c.slice(10, 14) === _fnv1a32(c.slice(0, 10) + PROMO_PEPPER).slice(0, 4).toUpperCase();
}

function createEcosystemPaymentService({
    ecosystem, signingKey, treasury, tokens, fetchTransaction,
    getPriceBand, evaluatePaymentAmount, resolvePaymentCode, paymentCodeFor,
    treasuryBoundUsers, creditSubscription, creditPremium, resumePremiumPayment,
    getPremiumPayment, getPromoPolicy, registry, now,
} = {}) {
    if (!ecosystem || typeof ecosystem.transaction !== 'function') throw codedError('BAD_CONFIG', 'ecosystem service required');
    if (!isNonBlank(treasury)) throw codedError('BAD_CONFIG', 'treasury wallet required');
    if (typeof fetchTransaction !== 'function') throw codedError('BAD_CONFIG', 'fetchTransaction required');
    if (typeof evaluatePaymentAmount !== 'function') throw codedError('BAD_CONFIG', 'evaluatePaymentAmount required');
    const _now = typeof now === 'function' ? now : () => Date.now();

    const TOKENS = (() => {
        if (tokens && tokens.SOL && tokens.SKR) return tokens;
        const skrMint = tokens && (tokens.skrMint || (tokens.SKR && tokens.SKR.mint));
        return {
            SOL: { decimals: 9, mint: null },
            SKR: { decimals: 6, mint: skrMint || null },
            USDC: { decimals: 6, mint: USDC_MINT },
            USDT: { decimals: 6, mint: USDT_MINT },
        };
    })();
    const PL_TOKENS = new Set(['SOL', 'SKR']);
    const STABLES = new Set(['USDC', 'USDT']);

    const publicKey = (() => {
        if (!signingKey) return null;
        try { return crypto.createPublicKey(signingKey); } catch (_) { return null; }
    })();
    const signPayload = (prefix, payloadStr) => {
        if (!signingKey) throw codedError('SIGNING_UNAVAILABLE', 'no signing key configured');
        return crypto.sign(null, Buffer.from(prefix + payloadStr, 'utf8'), signingKey).toString('base64');
    };
    const verifyPayload = (prefix, payloadStr, sigB64) => {
        if (!publicKey) return false;
        try {
            return crypto.verify(null, Buffer.from(prefix + payloadStr, 'utf8'), publicKey, Buffer.from(String(sigB64 || ''), 'base64'));
        } catch (_) { return false; }
    };

    const health = { runs: 0, processed: 0, applied: 0, conflicts: 0, pending: 0, lastSuccessAt: null, lastError: null };

    const QUOTES_DDL = [
        `CREATE TABLE IF NOT EXISTS ecosystem_payment_quotes (quote_id TEXT PRIMARY KEY,app TEXT NOT NULL,identity TEXT NOT NULL,product_id TEXT NOT NULL,duration TEXT NOT NULL,token TEXT NOT NULL,payer_wallet TEXT,amount_atomic TEXT NOT NULL,usd_cents INTEGER NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL,promo_code TEXT,used_signature TEXT)`,
        `CREATE INDEX IF NOT EXISTS idx_eco_quotes_identity ON ecosystem_payment_quotes(app,identity,issued_at)`,
        `CREATE TABLE IF NOT EXISTS ecosystem_promo_uses (code TEXT PRIMARY KEY,quote_id TEXT NOT NULL,signature TEXT)`,
        `CREATE TABLE IF NOT EXISTS solana_payment_codes (user_id INTEGER PRIMARY KEY,code TEXT NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_solana_payment_codes_code ON solana_payment_codes(code)`,
    ];

    const initialize = async () => ecosystem.transaction(async (tx) => {
        for (const ddl of QUOTES_DDL) await tx.run(ddl);
        // Backfill the indexed payment-code map for every existing user once;
        // new codes are upserted lazily by the payment-code endpoint.
        const hasCodes = typeof paymentCodeFor === 'function';
        if (hasCodes) {
            const users = await tx.all(`SELECT id FROM users`).catch(() => []);
            for (const u of users || []) {
                await tx.run(`INSERT INTO solana_payment_codes (user_id, code) VALUES (?, ?)
                              ON CONFLICT(user_id) DO UPDATE SET code = excluded.code`,
                    [u.id, paymentCodeFor(u.id)]);
            }
        }
        return { initialized: true };
    });

    // Resolve all users owning a payment code via the indexed mapping (replaces
    // the O(users) HMAC scan). Returns [] (none), [user], or multiple rows for
    // a genuine collision - the caller decides ambiguity.
    const usersByPaymentCode = async (code) => {
        const rows = await ecosystem.readTransaction((tx) =>
            tx.all(`SELECT user_id FROM solana_payment_codes WHERE code = ?`, [String(code)]));
        return rows.map((r) => r.user_id);
    };

    const promoPolicy = async () => {
        try {
            const p = typeof getPromoPolicy === 'function' ? await getPromoPolicy() : null;
            return { enabled: p && p.enabled !== false, discountPct: Math.max(0, Math.min(100, Number(p && p.discountPct) || 0)), mode: p && p.mode || 'code' };
        } catch (_) { return { enabled: false, discountPct: 0, mode: 'code' }; }
    };

    const tokenPriceUsd = async (token) => {
        if (STABLES.has(token)) return 1;
        if (typeof getPriceBand !== 'function') return null;
        const band = await getPriceBand(token === 'SOL' ? 'sol' : 'skr');
        return band && Number.isFinite(band.latest) && band.latest > 0 ? band.latest : null;
    };

    // ------------------------------------------------------------------
    // Quotes (SLQ2 signed payloads; consumed atomically by the core hook)
    // ------------------------------------------------------------------
    const normalizePayer = (w) => {
        const s = String(w || '').trim();
        if (!BASE58_SIG_RE.test(s)) return null;
        const decoded = paymentRecovery.base58Decode(s);
        return decoded && decoded.length === 32 ? s : null;
    };

    const issueQuote = async ({ app, identity, productId, duration = 'monthly', token, payerWallet = null, promoCode = null } = {}) => {
        const prod = PLAN_PRICES_CENTS[String(productId)];
        if (!prod) throw codedError('PRODUCT_INVALID', `unknown product ${productId}`);
        if (String(app) !== prod.app) throw codedError('PRODUCT_INVALID', 'app/product mismatch');
        const dur = prod.durations.includes(String(duration)) ? String(duration) : null;
        if (!dur) throw codedError('DURATION_INVALID', `duration ${duration} not offered for ${productId}`);
        const tok = String(token || '').toUpperCase();
        if (!TOKENS[tok]) throw codedError('TOKEN_INVALID', `unsupported token ${token}`);
        if (prod.app === 'photolynk' && !PL_TOKENS.has(tok)) throw codedError('TOKEN_INVALID', `${tok} not accepted for ${productId}`);
        if (!isNonBlank(String(identity))) throw codedError('SUBJECT_INVALID', 'identity required');
        const payer = normalizePayer(payerWallet);
        if (!payer) throw codedError('PAYER_REQUIRED', 'a valid 32-byte base58 payer wallet is required');

        const months = dur === 'yearly' ? 12 : 1;
        let usdCents = prod.usdCents * months;
        let promo = null;
        // Promo policy is PaceSeeker-only; PhotoLynk (incl. premium) never
        // receives a discount, and a supplied PL promo is rejected outright.
        const policy = prod.app === 'paceseeker'
            ? await promoPolicy() : { enabled: false, discountPct: 0, mode: 'code' };
        if (isNonBlank(promoCode)) {
            if (!policy.enabled || !promoCodeValid(promoCode)) throw codedError('PROMO_INVALID', 'promo code is not valid');
            usdCents = Math.round(usdCents * (100 - policy.discountPct) / 100);
            promo = String(promoCode).trim().toUpperCase();
        } else if (policy.enabled && (policy.mode === 'auto' || policy.mode === 'hidden')) {
            usdCents = Math.round(usdCents * (100 - policy.discountPct) / 100);
        }

        const priceUsd = await tokenPriceUsd(tok);
        if (!(priceUsd > 0)) throw codedError('PRICE_UNAVAILABLE', `no ${tok} price available`);
        const amountAtomic = Math.ceil((usdCents / 100) / priceUsd * Math.pow(10, TOKENS[tok].decimals));
        if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) throw codedError('AMOUNT_INVALID', 'computed amount is not a safe positive integer');

        const issuedAt = _now();
        const expiresAt = issuedAt + QUOTE_TTL_MS;
        return await ecosystem.transaction(async (tx) => {
            // Reuse an identical still-unused, unexpired quote instead of
            // issuing a second intent for the same payment: same app,
            // identity, product, duration, token, payer, promo and charge.
            const existing = await tx.get(
                `SELECT * FROM ecosystem_payment_quotes
                  WHERE app = ? AND identity = ? AND product_id = ? AND duration = ? AND token = ?
                    AND payer_wallet = ? AND promo_code IS ? AND usd_cents = ?
                    AND used_signature IS NULL AND expires_at > ?
                  ORDER BY issued_at DESC LIMIT 1`,
                [prod.app, String(identity), String(productId), dur, tok, payer, promo, usdCents, issuedAt]);
            if (existing) {
                return { quoteId: existing.quote_id, payload: existing.payload, signature: existing.signature, reused: true };
            }
            const quoteId = crypto.randomBytes(16).toString('hex');
            if (promo) {
                const r = await tx.run(`INSERT OR IGNORE INTO ecosystem_promo_uses (code, quote_id) VALUES (?, ?)`, [promo, quoteId]);
                if (!r.changes) {
                    const held = await tx.get(`SELECT quote_id FROM ecosystem_promo_uses WHERE code = ?`, [promo]);
                    const heldQuote = held ? await tx.get(`SELECT * FROM ecosystem_payment_quotes WHERE quote_id = ?`, [held.quote_id]) : null;
                    // A code may be re-reserved by the SAME owner only when the
                    // previous reservation's quote expired unused; a used quote
                    // burns the code, a live quote keeps it held.
                    const expiredUnused = heldQuote && heldQuote.app === prod.app && heldQuote.identity === String(identity)
                        && heldQuote.used_signature == null && Number(heldQuote.expires_at) <= issuedAt;
                    if (!expiredUnused) throw codedError('PROMO_TAKEN', 'promo code already reserved', { statusCode: 409 });
                    await tx.run(`UPDATE ecosystem_promo_uses SET quote_id = ? WHERE code = ?`, [quoteId, promo]);
                }
            }
            const payload = JSON.stringify({
                version: 2, type: 'payment_quote', quoteId, app: prod.app, subjectId: String(identity),
                productId: String(productId), duration: dur, token: tok, mint: TOKENS[tok].mint || null,
                decimals: TOKENS[tok].decimals, treasury, payerWallet: payer,
                amountAtomic: String(amountAtomic), usdCents, issuedAt, expiresAt, policyVersion: POLICY_VERSION,
            });
            const signature = signPayload('SLQ2|', payload);
            await tx.run(
                `INSERT INTO ecosystem_payment_quotes (quote_id,app,identity,product_id,duration,token,payer_wallet,amount_atomic,usd_cents,issued_at,expires_at,payload,signature,promo_code,used_signature)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
                [quoteId, prod.app, String(identity), String(productId), dur, tok, payer,
                 String(amountAtomic), usdCents, issuedAt, expiresAt, payload, signature, promo]);
            return { quoteId, payload, signature, reused: false };
        });
    };

    const loadQuote = async (tx, quoteId) =>
        await tx.get(`SELECT * FROM ecosystem_payment_quotes WHERE quote_id = ?`, [String(quoteId)]);

    // Validate a stored quote against an observed on-chain payment.
    const quoteCheck = async (quoteId, { app, productId, duration, token, payer, rawAmount, paidAt }) => {
        const row = await ecosystem.readTransaction((tx) => loadQuote(tx, quoteId));
        if (!row) return { ok: false, code: 'QUOTE_UNKNOWN', retryable: false };
        if (!verifyPayload('SLQ2|', row.payload, row.signature)) return { ok: false, code: 'QUOTE_SIGNATURE_INVALID', retryable: false };
        let p = null;
        try { p = JSON.parse(row.payload); } catch (_) { return { ok: false, code: 'QUOTE_SIGNATURE_INVALID', retryable: false }; }
        if (p.version !== 2 || p.type !== 'payment_quote' || p.quoteId !== row.quote_id) {
            return { ok: false, code: 'QUOTE_SIGNATURE_INVALID', retryable: false };
        }
        if (p.app !== app || p.productId !== productId || p.duration !== duration || p.token !== token) {
            return { ok: false, code: 'QUOTE_MISMATCH', retryable: false };
        }
        if (p.payerWallet && payer && p.payerWallet !== payer) return { ok: false, code: 'QUOTE_MISMATCH', retryable: false };
        const want = BigInt(String(p.amountAtomic));
        const got = BigInt(String(rawAmount || '0'));
        if (got < want) return { ok: false, code: 'UNDERPAID', retryable: false, expected: want.toString(), received: got.toString() };
        if (!(paidAt >= Number(p.issuedAt) - QUOTE_BLOCKTIME_PAD_MS && paidAt <= Number(p.expiresAt))) {
            return { ok: false, code: 'QUOTE_EXPIRED', retryable: false };
        }
        return { ok: true, quote: row, payload: p };
    };

    // ------------------------------------------------------------------
    // Chain inspection
    // ------------------------------------------------------------------
    const inspectTransaction = async (signature, expected = {}) => {
        const sig = String(signature || '').trim();
        if (!BASE58_SIG_RE.test(sig)) return { ok: false, code: 'SIGNATURE_INVALID', retryable: false };
        const tx = await fetchTransaction(sig);
        if (!tx) return { ok: false, code: 'TX_NOT_FOUND', retryable: true };
        const txSig = tx.transaction && Array.isArray(tx.transaction.signatures) ? tx.transaction.signatures[0] : null;
        if (txSig && txSig !== sig) return { ok: false, code: 'TX_SIGNATURE_MISMATCH', retryable: false };
        if (!tx.meta || typeof tx.meta !== 'object') return { ok: false, code: 'TX_NO_META', retryable: true };
        if (tx.meta.err) return { ok: false, code: 'TX_FAILED', retryable: false };
        const blockTime = Number(tx.blockTime);
        if (!Number.isFinite(blockTime) || blockTime <= 0) return { ok: false, code: 'TX_TIME_UNKNOWN', retryable: true };

        let memo = null;
        try {
            memo = paymentRecovery.extractEcosystemMemo(tx);
        } catch (e) {
            return { ok: false, code: e.code || 'MEMO_MISMATCH', retryable: false };
        }
        if (!memo) return { ok: false, code: 'NO_MEMO', retryable: false };

        // One token must carry the payment: try each accepted mint and require
        // exactly one positive net inflow from one signer.
        const inflows = [];
        let mixed = false;
        for (const [label, def] of Object.entries(TOKENS)) {
            if (memo.app === 'photolynk' && !PL_TOKENS.has(label)) continue;
            let r = null;
            try {
                r = paymentRecovery.extractTreasuryTransfer(tx, { wallet: treasury, mint: def.mint, decimals: def.decimals });
            } catch (e) {
                if (e && e.code === 'AMBIGUOUS_PAYMENT') { mixed = true; break; }
                if (e && (e.code === 'NO_INFLOW')) continue;
                return { ok: false, code: e.code || 'TX_INVALID', retryable: e.code !== 'TX_FAILED' && e.code !== 'TX_MALFORMED' };
            }
            if (!r) continue;
            // The extractor reports any SOL leg under every call - it only
            // counts as an inflow for the SOL definition itself.
            if (r.token === 'SOL' && def.mint != null) continue;
            inflows.push({ ...r, token: r.token === 'SOL' ? 'SOL' : label, mint: r.token === 'SOL' ? null : def.mint || null });
        }
        if (mixed || inflows.length > 1) return { ok: false, code: 'AMBIGUOUS_PAYMENT', retryable: false };
        if (!inflows.length) return { ok: false, code: 'NO_INFLOW', retryable: false };
        const transfer = inflows[0];

        return {
            ok: true, signature: sig,
            app: memo.app, memo: memo.memo, productId: memo.productId,
            tierGb: memo.tierGb, duration: memo.duration, code: memo.code,
            promo: memo.promo, reportedPaidAt: memo.reportedPaidAt, quoteId: memo.quoteId,
            transfer, paidAt: blockTime * 1000, slot: transfer.slot,
        };
    };

    // ------------------------------------------------------------------
    // Price checks
    // ------------------------------------------------------------------
    const priceCheck = async ({ app, productId, tierGb, duration, token, amount, rawAmount, promo, quoted }) => {
        const prod = PLAN_PRICES_CENTS[productId];
        if (!prod) return { ok: false, code: 'PRODUCT_INVALID', retryable: false };
        if (quoted) {
            // Quoted payments already matched the exact quoted atomic amount.
            return { ok: true, usdCents: quoted.usdCents };
        }
        const months = duration === 'yearly' ? 12 : 1;
        let expectedUsd = (prod.usdCents * months) / 100;
        let flagged = null;
        if (prod.app === 'paceseeker') {
            // Discount only for an actual validated promo: suffix - the
            // memo's always-present checksum field is not a promo marker
            // and an unverifiable promo claims no discount.
            if (promo && promoCodeValid(promo)) expectedUsd = PS_LEGACY_PROMO_CENTS / 100;
            else if (STABLES.has(token)) {
                // Ambiguous legacy discount: a ~half-price payment with no
                // promo marker could not be distinguished from a promo-mode
                // charge - keep the grant and expose the evidence gap.
                const cents = Number(rawAmount) / Math.pow(10, TOKENS[token].decimals - 2);
                if (cents < prod.usdCents && cents >= PS_LEGACY_PROMO_CENTS) flagged = 'PRICE_EVIDENCE_UNAVAILABLE';
            }
        }
        if (STABLES.has(token)) {
            const cents = Number(rawAmount) / Math.pow(10, TOKENS[token].decimals - 2);
            if (!(cents >= expectedUsd * 100)) return { ok: false, code: 'UNDERPAID', retryable: false, expectedCents: Math.round(expectedUsd * 100), receivedCents: Math.round(cents) };
            return { ok: true, usdCents: Math.round(cents), flagged };
        }
        const band = typeof getPriceBand === 'function' ? await getPriceBand(token === 'SOL' ? 'sol' : 'skr') : null;
        if (!band) return { ok: false, code: 'PRICE_UNAVAILABLE', retryable: true };
        const evalResult = evaluatePaymentAmount({ receivedUnits: amount, expectedUsd, band });
        if (!evalResult.ok) return { ok: false, code: 'UNDERPAID', retryable: false, expected: evalResult.expectedAtLatest, received: amount };
        return { ok: true, usdCents: Math.round(amount * band.latest * 100), flagged };
    };

    // ------------------------------------------------------------------
    // Attribution + application
    // ------------------------------------------------------------------
    const _inFlight = new Map();
    const processSignature = async (signature, { subjects = [] } = {}) => {
        const sig = String(signature || '').trim();
        const held = _inFlight.get(sig);
        if (held) return held;
        const p = (async () => {
            try {
                return await _processSignatureUnlocked(sig, subjects);
            } finally {
                _inFlight.delete(sig);
            }
        })();
        if (_inFlight.size > 5000) _inFlight.clear();
        _inFlight.set(sig, p);
        return p;
    };

    const _processSignatureUnlocked = async (sig, subjects) => {
        const insp = await inspectTransaction(sig);
        if (!insp.ok) {
            return { status: insp.retryable ? 'pending' : 'conflict', code: insp.code, retryable: !!insp.retryable };
        }

        let quoted = null;
        if (insp.quoteId) {
            const qc = await quoteCheck(insp.quoteId, {
                app: insp.app, productId: insp.productId, duration: insp.duration,
                token: insp.transfer.token, payer: insp.transfer.senderWallet,
                rawAmount: insp.transfer.rawAmount, paidAt: insp.paidAt,
            });
            if (!qc.ok) return { status: qc.retryable ? 'pending' : 'conflict', code: qc.code, retryable: !!qc.retryable };
            quoted = qc.payload;
        }

        const price = await priceCheck({
            app: insp.app, productId: insp.productId, tierGb: insp.tierGb, duration: insp.duration,
            token: insp.transfer.token, amount: insp.transfer.amount, rawAmount: insp.transfer.rawAmount,
            promo: insp.promo, quoted,
        });
        if (!price.ok) {
            return { status: price.retryable ? 'pending' : 'conflict', code: price.code, retryable: !!price.retryable };
        }

        const payer = insp.transfer.senderWallet;
        if (insp.app === 'paceseeker') {
            // Quoted payments bind to the quote subject; unquoted payments are
            // attributed by the core across ALL proven PS holders of the payer
            // wallet - reported subjects are telemetry, never attribution, and
            // cannot conceal a globally ambiguous wallet.
            const deviceHash = quoted ? String(quoted.subjectId) : null;
            const r = await ecosystem.applyPaceSeekerPayment({
                signature: sig, payerWallet: payer, token: insp.transfer.token, mint: insp.transfer.mint,
                amountAtomic: String(insp.transfer.rawAmount), paidAt: insp.paidAt, verifiedAt: _now(),
                quoteId: insp.quoteId || null,
                evidence: { slot: insp.slot, memo: insp.memo, subjects: subjects || [], flagged: price.flagged || null },
            }, { deviceHash });
            if (r && r.ok === false) {
                return { status: r.retryable ? 'pending' : 'conflict', code: r.code || 'PAYMENT_ACCOUNT_UNVERIFIED', retryable: !!r.retryable };
            }
            const appliedIdentity = deviceHash || await ecosystem.readTransaction((tx) =>
                tx.get(`SELECT origin_identity FROM ecosystem_receipts WHERE signature = ?`, [sig])
                    .then((row) => (row && row.origin_identity) || null)).catch(() => null);
            return { status: 'applied', app: 'paceseeker', identity: appliedIdentity, result: r, flagged: price.flagged || null };
        }

        if (insp.app === 'photolynk') {
            let uid = quoted ? Number(quoted.subjectId) : null;
            if (!Number.isSafeInteger(uid) || uid <= 0) {
                if (insp.code) {
                    const owners = await usersByPaymentCode(insp.code);
                    if (owners.length > 1) return { status: 'conflict', code: 'AMBIGUOUS', retryable: false };
                    uid = owners.length ? Number(owners[0]) : null;
                    if (!uid) return { status: 'conflict', code: 'CODE_NO_MATCH', retryable: false };
                } else if (typeof treasuryBoundUsers === 'function') {
                    const boundIds = paymentRecovery.boundUserIds(await treasuryBoundUsers(payer, insp.paidAt));
                    if (boundIds.length > 1) return { status: 'conflict', code: 'AMBIGUOUS', retryable: false };
                    uid = boundIds.length === 1 ? Number(boundIds[0]) : null;
                }
                // Reported subjects are telemetry - never attribution.
            }
            if (!Number.isSafeInteger(uid) || uid <= 0) {
                return { status: 'pending', code: 'PAYMENT_ACCOUNT_UNVERIFIED', retryable: true };
            }
            if (insp.productId === 'photolynk.premium') {
                if (typeof creditPremium !== 'function') return { status: 'conflict', code: 'PREMIUM_UNSUPPORTED', retryable: false };
                let r;
                try {
                    r = await creditPremium({
                        userId: uid, signature: sig, token: insp.transfer.token,
                        amount: insp.transfer.amount, amountAtomic: String(insp.transfer.rawAmount),
                        payerWallet: payer, mint: insp.transfer.mint, paymentAt: insp.paidAt,
                        quoteId: insp.quoteId || null,
                        evidence: { slot: insp.slot, memo: insp.memo },
                    });
                } catch (e) {
                    if (e && e.code === 'PAYMENT_CONFLICT') return { status: 'conflict', code: 'PAYMENT_CONFLICT', retryable: false };
                    throw e;
                }
                if (r && r.ok === false) return { status: 'conflict', code: r.code || 'PAYMENT_CONFLICT', retryable: false };
                // The claim only reserves the payment. The premium
                // entitlement lands when the resumable NFT/storage work
                // succeeds against the canonical ledger row - unavailable or
                // failed downstream work stays pending, never falsely
                // 'applied'. A real PAYMENT_CONFLICT is not a pending retry.
                let row = null;
                try {
                    row = typeof getPremiumPayment === 'function' ? await getPremiumPayment(sig) : null;
                } catch (_) { row = null; }
                if (!row) return { status: 'pending', code: 'PREMIUM_LEDGER_PENDING', retryable: true };
                if (typeof resumePremiumPayment !== 'function') return { status: 'pending', code: 'PREMIUM_RESUME_UNAVAILABLE', retryable: true };
                let res;
                try {
                    res = await resumePremiumPayment(row);
                } catch (e) {
                    if (e && e.code === 'PAYMENT_CONFLICT') return { status: 'conflict', code: 'PAYMENT_CONFLICT', retryable: false };
                    return { status: 'pending', code: 'PREMIUM_APPLY_PENDING', retryable: true };
                }
                if (!res || !(res.applied === true || res.isPremium === true)) {
                    return { status: 'pending', code: 'PREMIUM_APPLY_PENDING', retryable: true };
                }
                return { status: 'applied', app: 'photolynk', identity: String(uid), result: r };
            }
            if (typeof creditSubscription !== 'function') return { status: 'conflict', code: 'UNSUPPORTED', retryable: false };
            let r;
            try {
                r = await creditSubscription({
                    userId: uid, signature: sig, token: insp.transfer.token,
                    amount: insp.transfer.amount, amountAtomic: String(insp.transfer.rawAmount),
                    payerWallet: payer, mint: insp.transfer.mint, quoteId: insp.quoteId || null,
                    tierGb: insp.tierGb, duration: insp.duration, paymentAt: insp.paidAt,
                    source: 'protocol', detail: `memo=${insp.memo}`,
                    evidence: { slot: insp.slot, memo: insp.memo },
                });
            } catch (e) {
                if (e && e.code === 'PAYMENT_CONFLICT') return { status: 'conflict', code: 'PAYMENT_CONFLICT', retryable: false };
                throw e;
            }
            if (r && r.ok === false) return { status: 'conflict', code: r.code || 'PAYMENT_CONFLICT', retryable: false };
            return { status: 'applied', app: 'photolynk', identity: String(uid), result: r };
        }
        return { status: 'conflict', code: 'PRODUCT_INVALID', retryable: false };
    };

    // ------------------------------------------------------------------
    // Durable reconcile loop over ecosystem_jobs
    // ------------------------------------------------------------------
    const reconcile = async ({ limit = 100 } = {}) => {
        const jobs = await ecosystem.leaseJobs({ limit, leaseMs: JOB_LEASE_MS });
        health.runs++;
        let idx = 0;
        const worker = async () => {
            while (idx < jobs.length) {
                const job = jobs[idx++];
                let payload = {};
                try { payload = JSON.parse(job.payload_json || '{}'); } catch (_) { payload = {}; }
                const subjects = Array.isArray(payload.subjects) ? payload.subjects : [];
                try {
                    const r = await processSignature(job.reference_id, { subjects });
                    health.processed++;
                    if (r.status === 'applied') {
                        health.applied++;
                        health.lastSuccessAt = _now();
                        await ecosystem.finishJob(job, {});
                    } else if (r.status === 'pending') {
                        health.pending++;
                        await ecosystem.finishJob(job, { errorCode: r.code || 'PENDING', retryable: true });
                    } else {
                        health.conflicts++;
                        await ecosystem.finishJob(job, { errorCode: r.code || 'CONFLICT', retryable: false });
                    }
                } catch (e) {
                    health.lastError = e && e.message;
                    const retryable = !(e && (e.code === 'PAYMENT_CONFLICT' || e.code === 'MEMO_MISMATCH' || e.code === 'TX_FAILED' || e.code === 'PRODUCT_INVALID' || e.code === 'TOKEN_INVALID'));
                    await ecosystem.finishJob(job, { errorCode: (e && e.code) || 'ERROR', retryable }).catch(() => {});
                }
            }
        };
        await Promise.all([worker(), worker()].slice(0, RECONCILE_CONCURRENCY));
        return { leased: jobs.length, ...health };
    };

    // ------------------------------------------------------------------
    // ECO2 signed entitlement envelopes
    // ------------------------------------------------------------------
    const REGISTRY_APPS = (registry && registry.apps) || {};
    const signEntitlement = (snapshot, { app, identity, extraBenefits = [] } = {}) => {
        if (!snapshot || !isNonBlank(String(app)) || identity == null) {
            throw codedError('SNAPSHOT_INVALID', 'snapshot + {app,identity} required');
        }
        if (!Object.prototype.hasOwnProperty.call(REGISTRY_APPS, String(app))) {
            throw codedError('APP_UNKNOWN', `no registry entry for app ${app}`);
        }
        const appDef = REGISTRY_APPS[String(app)];
        const subject = String(identity);
        const member = (snapshot.members || []).find((m) => m.app === app && String(m.identity) === subject);
        if (!member) throw codedError('MEMBER_UNKNOWN', 'snapshot has no matching member for this subject');
        const benefits = [];
        for (const s of snapshot.sources || []) {
            const isShared = s.scope === 'shared';
            const isLocal = (s.scope === 'local' || s.scope === 'shared_local')
                && s.app === app && String(s.identity) === subject;
            if (!isShared && !isLocal) continue;
            if (isShared && !(Number(s.monthlyValueCents) >= Number(appDef.monthlyValueCents))) continue;
            const planGb = isShared
                ? (appDef.benefit === 'storage' ? (Number(appDef.tierGb) || 0) : 0)
                : (Number(s.tierGb) || 0);
            benefits.push({
                eventId: s.eventId, kind: s.kind || 'payment',
                startsAt: s.startsAt == null ? null : Number(s.startsAt),
                expiresAt: s.expiresAt == null ? null : Number(s.expiresAt),
                planGb,
            });
        }
        // Server-only extras (trial/grace/premium-storage) signed as their own
        // kinds - they never become shared benefits and never cross apps.
        for (const x of extraBenefits || []) {
            if (!x || typeof x !== 'object') continue;
            benefits.push({
                eventId: x.eventId || null, kind: String(x.kind || 'extra'),
                startsAt: x.startsAt == null ? null : Number(x.startsAt),
                expiresAt: x.expiresAt == null ? null : Number(x.expiresAt),
                planGb: Number(x.planGb) || 0,
            });
        }
        const payload = JSON.stringify({
            version: 2, type: 'entitlement', keyId: KEY_ID,
            accountId: snapshot.accountId, app: String(app), subjectId: subject,
            revision: Number(snapshot.revision) || 0,
            issuedAt: _now(),
            benefits,
            nextChangeAt: snapshot.nextChangeAt == null ? null : Number(snapshot.nextChangeAt),
        });
        return { keyId: KEY_ID, payload, signature: signPayload('ECO2|', payload), member };
    };

    return {
        initialize,
        issueQuote,
        quoteCheck,
        inspectTransaction,
        processSignature,
        reconcile,
        signEntitlement,
        usersByPaymentCode,
        promoCodeValid,
        health,
        TOKENS,
        PLAN_PRICES_CENTS,
        QUOTE_TTL_MS,
        KEY_ID,
    };
}

module.exports = { createEcosystemPaymentService, USDC_MINT, USDT_MINT, promoCodeValid, BASE58_SIG_RE };
