'use strict';

// ECO2 protocol routes: signed quotes, signature verification and signed
// entitlement envelopes. Mounted once by server.js after the readiness
// objects exist; every handler fails closed through `ready()` until the
// core + payment protocol finish initializing (the /api/ecosystem
// subscriptionReadiness middleware already 503s before that, so a false
// readiness flag can never silently serve protocol responses).
//
// Client-supplied amounts/tiers are never authoritative here: the service
// resolves subject, product price and quote terms from server state, and
// inspects the actual on-chain transfer.

const { BASE58_SIG_RE, promoFreeCodeValidFor } = require('./ecosystemPayments');

const codedHttp = (status, code, message, extra) => ({
    status, code, error: message || code, ...(extra || {}),
});
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;

function mountEcosystemRoutes(app, deps = {}) {
    const {
        auth = (req, res, next) => next(),
        caller,
        ready = () => false,
        protocol = () => null,
        ecosystem = null,
        signKey = null,
        signGrant = null,
        registry = null,
        requestScan = null,
        wakeWorker = null,
    } = deps;

    const notReady = (res) => res.status(503).json({
        success: false, error: 'Ecosystem core unavailable', code: 'ECOSYSTEM_UNAVAILABLE', retryable: true,
    });
    const callerError = (res, who) => res.status(403).json({ error: who.error || 'caller resolution failed' });

    // Public capabilities advertisement - registry products only, no
    // secrets. Still ready-gated: a permanently-initializing server must
    // not advertise a protocol it cannot serve.
    const capabilities = (req, res) => {
        if (!ready()) return notReady(res);
        const apps = (registry && registry.apps) || {};
        const products = (registry && registry.products) || {};
        const pubProducts = {};
        for (const [id, p] of Object.entries(products)) {
            pubProducts[id] = {
                app: p.app, monthlyValueCents: Number(p.monthlyValueCents) || 0,
                tierGb: Number(p.tierGb) || 0, ecosystem: !!p.ecosystem,
                durations: p.durations ? Object.keys(p.durations) : [],
                premium: !!p.premium,
            };
        }
        res.json({
            version: 2,
            quotes: true,
            entitlements: true,
            signedQuotes: !!signKey,
            signedEntitlements: !!signKey,
            keyId: 'rc-v1',
            quoteTtlMs: 300000,
            registry: { apps: Object.keys(apps), products: pubProducts },
        });
    };
    app.get('/api/ecosystem/capabilities', capabilities);
    app.get('/api/ecosystem/v2/capabilities', capabilities);

    // Signed payment quote (SLQ2). Subject identity comes only from the
    // authenticated caller; PS additionally requires the quote payer to be
    // the member's proven wallet.
    const issueQuote = async (req, res) => {
        try {
            if (!ready()) return notReady(res);
            const who = await caller(req);
            if (who.error) return callerError(res, who);
            const { productId, duration, token, payerWallet, promoCode } = req.body || {};
            const payer = String(payerWallet || '').trim();
            if (!payer) return res.status(400).json({ error: 'payerWallet required', code: 'PAYER_REQUIRED' });
            if (who.app === 'paceseeker' || who.app === 'lane') {
                // A device-app quote only credits its own member: the payer
                // must be the wallet this device actually proved by
                // signature.
                const proven = await ecosystem.readTransaction((tx) => tx.all(
                    `SELECT wallet FROM ecosystem_member_proofs WHERE app = ? AND identity = ?`,
                    [who.app, String(who.identity)])).catch(() => []);
                if (!proven.some((p) => p.wallet === payer)) {
                    return res.status(403).json({ error: 'payerWallet is not the proven wallet for this device', code: 'PAYER_UNPROVEN' });
                }
            }
            const q = await protocol().issueQuote({
                app: who.app, identity: String(who.identity),
                productId, duration, token, payerWallet: payer, promoCode,
            });
            res.json({ success: true, quote: { quoteId: q.quoteId, payload: q.payload, signature: q.signature, reused: !!q.reused } });
        } catch (e) {
            const sc = Number(e && e.statusCode) || (e && e.code === 'PROMO_TAKEN' ? 409 : 400);
            res.status(sc).json({ success: false, error: e.message, code: e.code || 'QUOTE_FAILED' });
        }
    };
    app.post('/api/ecosystem/payment-quote', auth, issueQuote);
    app.post('/api/ecosystem/v2/quote', auth, issueQuote);

    // Payment verification: durably enqueue the reported signature, then
    // attempt at most one bounded processing pass. Applied results are
    // returned only when they belong to THIS caller - another subject's
    // envelope/account details are never exposed.
    const verifyPayment = async (req, res) => {
        try {
            if (!ready()) return notReady(res);
            const who = await caller(req);
            if (who.error) return callerError(res, who);
            const sig = String((req.body && req.body.signature) || '').trim();
            if (!BASE58_SIG_RE.test(sig)) {
                return res.status(400).json({ success: false, error: 'invalid signature', code: 'SIGNATURE_INVALID' });
            }
            // Durable enqueue first: if this fails the client must retry,
            // never proceed to a verification with no recovery record.
            try {
                await ecosystem.enqueueVerification({ signature: sig, app: who.app, identity: String(who.identity) });
            } catch (e) {
                return res.status(503).json({ success: false, error: 'verification queue unavailable', code: 'ENQUEUE_FAILED', retryable: true });
            }
            const r = await protocol().processSignature(sig, { subjects: [{ app: who.app, identity: String(who.identity) }] });
            if (r.status === 'applied') {
                const owned = r.app === who.app && String(r.identity) === String(who.identity);
                if (!owned) {
                    return res.status(409).json({ success: false, status: 'conflict', code: 'PAYMENT_ACCOUNT_UNVERIFIED' });
                }
                let envelope = null;
                try {
                    const snap = await ecosystem.resolveIdentity(who.app, String(who.identity), { project: false });
                    const signed = protocol().signEntitlement(snap, { app: who.app, identity: String(who.identity) });
                    envelope = { keyId: signed.keyId, payload: signed.payload, signature: signed.signature };
                } catch (_) { envelope = null; }
                return res.json({ success: true, status: 'applied', entitlementEnvelope: envelope });
            }
            if (r.status === 'pending') {
                return res.status(202).json({ success: false, status: 'pending', pending: true, code: r.code || 'PENDING', retryAfterMs: 5000 });
            }
            return res.status(409).json({ success: false, status: 'conflict', code: r.code || 'PAYMENT_CONFLICT' });
        } catch (e) {
            res.status(500).json({ success: false, error: 'verification failed', code: 'VERIFY_FAILED' });
        }
    };
    app.post('/api/ecosystem/payments/verify', auth, verifyPayment);
    app.post('/api/ecosystem/v2/verify', auth, verifyPayment);

    // Quote status for THIS caller's intent. Non-MWA wallets sign+broadcast
    // inside the wallet app, so a crash can lose the returned signature -
    // this lets a client recover via the scanner instead of paying again.
    // 'applied' only when the used signature has an applied ecosystem
    // receipt; expiry alone never declares "no payment".
    const quoteStatus = async (req, res) => {
        try {
            if (!ready()) return notReady(res);
            const who = await caller(req);
            if (who.error) return callerError(res, who);
            const quoteId = String(req.params.quoteId || '').trim();
            if (!QUOTE_ID_RE.test(quoteId)) {
                return res.status(400).json({ success: false, error: 'invalid quoteId', code: 'QUOTE_INVALID' });
            }
            let row;
            try {
                row = await ecosystem.readTransaction((tx) => tx.get(
                    `SELECT q.quote_id, q.used_signature, q.expires_at,
                            (SELECT r.applied_at FROM ecosystem_receipts r WHERE r.signature = q.used_signature) AS applied_at
                       FROM ecosystem_payment_quotes q
                      WHERE q.quote_id = ? AND q.app = ? AND q.identity = ?`,
                    [quoteId, who.app, String(who.identity)]));
            } catch (e) {
                return res.status(503).json({ success: false, error: 'quote status unavailable', code: 'STATUS_UNAVAILABLE', retryable: true });
            }
            if (!row) return res.status(404).json({ success: false, error: 'quote not found', code: 'QUOTE_UNKNOWN' });
            const signature = row.used_signature || null;
            if (signature) {
                // Known signature: durably enqueue (idempotent) and wake the
                // worker so verification resumes without waiting a cycle.
                try {
                    await ecosystem.enqueueVerification({ signature, app: who.app, identity: String(who.identity) });
                    if (typeof wakeWorker === 'function') wakeWorker();
                } catch (e) {
                    return res.status(503).json({ success: false, error: 'verification queue unavailable', code: 'ENQUEUE_FAILED', retryable: true });
                }
            } else if (typeof requestScan === 'function') {
                // No signature yet: ask the server to coalesce/throttle a
                // treasury scan wakeup - never awaited in this handler.
                try { requestScan(); } catch (_) { }
            }
            res.json({
                success: true,
                quoteId: row.quote_id,
                status: row.applied_at != null ? 'applied' : 'pending',
                signature,
                expiresAt: row.expires_at == null ? null : Number(row.expires_at),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: 'quote status failed', code: 'STATUS_FAILED' });
        }
    };
    app.get('/api/ecosystem/payment-quotes/:quoteId/status', auth, quoteStatus);
    app.get('/api/ecosystem/v2/payment-quotes/:quoteId/status', auth, quoteStatus);

    // Signed entitlement snapshot for this caller (ECO2 envelope).
    const getEntitlement = async (req, res) => {
        try {
            if (!ready()) return notReady(res);
            const who = await caller(req);
            if (who.error) return callerError(res, who);
            const snap = await ecosystem.resolveIdentity(who.app, String(who.identity), { project: false });
            if (!snap || !snap.entitlement) {
                return res.status(404).json({ success: false, error: 'member not found', code: 'MEMBER_UNKNOWN' });
            }
            const signed = protocol().signEntitlement(snap, { app: who.app, identity: String(who.identity) });
            res.json({ success: true, entitlementEnvelope: { keyId: signed.keyId, payload: signed.payload, signature: signed.signature } });
        } catch (e) {
            res.status(500).json({ success: false, error: 'entitlement failed', code: 'ENTITLEMENT_FAILED' });
        }
    };
    app.get('/api/ecosystem/v2/entitlement', auth, getEntitlement);
    app.get('/api/ecosystem/entitlement', auth, getEntitlement);

    // Free-month promo redemption (PF/LF codespace — distinct peppers from
    // the discount-code spaces). Burns the code once globally via the
    // `promo:<code>` event PK and grants a LOCAL month on the caller's
    // identity — never feeds the cross-app shared floor.
    const redeemPromo = async (req, res) => {
        try {
            if (!ready()) return notReady(res);
            const who = await caller(req);
            if (who.error) return callerError(res, who);
            const code = String((req.body || {}).code || '').trim().toUpperCase();
            if (!promoFreeCodeValidFor(who.app, code)) {
                return res.status(400).json({ success: false, error: 'invalid promo code', code: 'PROMO_INVALID' });
            }
            const r = await ecosystem.redeemPromoGrant({ app: who.app, identity: who.identity, code });
            const out = { success: true, accountId: r.accountId, expiresAt: r.expiresAt };
            try {
                // Return the same signed eco block a heartbeat carries so the
                // app activates immediately instead of waiting for the next
                // trial ping. Failure is harmless — the grant is durable and
                // the next heartbeat delivers it.
                const snap = await ecosystem.resolveIdentity(who.app, String(who.identity), { project: false });
                const subUntil = snap && snap.entitlement && snap.entitlement.expiresAt != null
                    ? Number(snap.entitlement.expiresAt) : (Number(r.expiresAt) || 0);
                const g = typeof signGrant === 'function' && subUntil > Date.now()
                    ? signGrant(r.accountId, subUntil) : null;
                const env = snap && protocol() ? protocol().signEntitlement(snap, { app: who.app, identity: String(who.identity) }) : null;
                out.eco = { account: r.accountId, subUntil, grant: g ? g.grant : null, sig: g ? g.sig : null };
                if (env) out.eco.v2 = env;
            } catch (e) { /* durable grant — next heartbeat carries it */ }
            res.json(out);
        } catch (e) {
            const status = (e && e.statusCode) || (e && e.code === 'PROMO_USED' ? 409 : 500);
            res.status(status).json({ success: false, error: (e && e.message) || 'redeem failed', code: (e && e.code) || 'REDEEM_FAILED' });
        }
    };
    app.post('/api/ecosystem/promo/redeem', auth, redeemPromo);
    app.post('/api/ecosystem/v2/promo/redeem', auth, redeemPromo);
}

module.exports = { mountEcosystemRoutes };
