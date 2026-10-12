'use strict';
const crypto = require('crypto');
const { withDatabaseWriter } = require('./paymentRecovery');

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const AD_MAX_TIER_GB = 200;
const POLICY_VERSION = 2;
const PS_IDENTITY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PROOF_KINDS = new Set(['siws', 'bind', 'rotation']);
const NON_PAID_KINDS = new Set(['ad_claim', 'revoke', 'admin', 'ad', 'identity_conflict']);
const OVERRIDE_PREFIX = 'shared_override:';
const JOB_PREFIX = 'verify:solana:';
const TIMELINE_EVENT_PREFIX = 'sharedtl:';
const TOKEN_ENUM = {
    paceseeker: new Set(['SOL', 'USDC', 'USDT', 'SKR']),
    photolynk: new Set(['SOL', 'SKR']),
};
const SHARED_VALUE_CENTS = 399;
// A user_plans row may stack non-payment time on top of paid expiry (ad week,
// admin edit, store row). Only bindable payment types at the bind tier may
// feed the shared floor — the same gate the pre-core mirror used.
const BINDABLE_PLAN_PAYMENT_TYPES = new Set(['', 'solana', 'skr', 'ecosystem', 'apple', 'google']);
const BIND_MIN_TIER_GB = 400;
const bindablePlan = (plan) => !!plan
    && Number(plan.plan_gb) >= BIND_MIN_TIER_GB
    && BINDABLE_PLAN_PAYMENT_TYPES.has(plan.payment_type == null ? '' : String(plan.payment_type));

const DEFAULT_REGISTRY = {
    version: 2,
    apps: {
        paceseeker: { monthlyValueCents: 399, benefit: 'features' },
        photolynk: { monthlyValueCents: 399, benefit: 'storage', tierGb: 400 },
    },
    products: {
        'paceseeker.monthly': { app: 'paceseeker', monthlyValueCents: 399, tierGb: 0, ecosystem: true, durations: { monthly: 30 * DAY_MS } },
        'photolynk.storage_100': { app: 'photolynk', monthlyValueCents: 175, tierGb: 100, ecosystem: false, durations: { monthly: 30 * DAY_MS, yearly: 365 * DAY_MS } },
        'photolynk.storage_200': { app: 'photolynk', monthlyValueCents: 245, tierGb: 200, ecosystem: false, durations: { monthly: 30 * DAY_MS, yearly: 365 * DAY_MS } },
        'photolynk.storage_400': { app: 'photolynk', monthlyValueCents: 399, tierGb: 400, ecosystem: true, durations: { monthly: 30 * DAY_MS, yearly: 365 * DAY_MS } },
        'photolynk.storage_1000': { app: 'photolynk', monthlyValueCents: 799, tierGb: 1000, ecosystem: true, durations: { monthly: 30 * DAY_MS, yearly: 365 * DAY_MS } },
        'photolynk.premium': { app: 'photolynk', monthlyValueCents: 0, tierGb: 0, ecosystem: false, premium: true },
    },
};

const codedError = (code, message, extra) => {
    const e = new Error(message || code);
    e.code = code;
    if (extra && typeof extra === 'object') Object.assign(e, extra);
    return e;
};

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key) ? obj[key] : undefined;
const isAmountAtomic = (v) => typeof v === 'string' && /^[0-9]+$/.test(v) && v.length > 0 && v.length <= 40 && BigInt(v) > 0n;
const isFiniteMs = (v) => Number.isFinite(v) && Number.isInteger(v) && v > 0;
const isNonBlank = (v) => typeof v === 'string' && v.trim().length > 0;
const finiteOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const SCHEMA_DDL = [
    `CREATE TABLE IF NOT EXISTS ecosystem_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ecosystem_receipts (signature TEXT PRIMARY KEY,account_id TEXT,app TEXT NOT NULL,product_id TEXT NOT NULL,duration TEXT,origin_identity TEXT NOT NULL,payer_wallet TEXT,token TEXT,mint TEXT,amount_atomic TEXT,paid_at INTEGER NOT NULL,verified_at INTEGER,quote_id TEXT,policy_version INTEGER NOT NULL,evidence_json TEXT,applied_at INTEGER,legacy_accounted INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ecosystem_events (event_id TEXT PRIMARY KEY,account_id TEXT,source_kind TEXT NOT NULL,source_app TEXT,source_ref TEXT,policy_version INTEGER NOT NULL,payload_json TEXT,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ecosystem_benefits (event_id TEXT NOT NULL,account_id TEXT,app TEXT NOT NULL,identity TEXT NOT NULL,benefit TEXT NOT NULL,starts_at INTEGER NOT NULL,expires_at INTEGER,tier_gb INTEGER NOT NULL DEFAULT 0,monthly_value_cents INTEGER NOT NULL DEFAULT 0,scope TEXT NOT NULL,revoked_at INTEGER,value_json TEXT,PRIMARY KEY(event_id,app,identity,benefit))`,
    `CREATE TABLE IF NOT EXISTS ecosystem_jobs (job_key TEXT PRIMARY KEY,kind TEXT NOT NULL,reference_id TEXT NOT NULL,payload_json TEXT,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,last_error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ecosystem_aliases (alias_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,merged_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ecosystem_member_proofs (app TEXT NOT NULL,identity TEXT NOT NULL,wallet TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT,verified_at INTEGER NOT NULL,PRIMARY KEY(app,identity,wallet))`,
    `CREATE TABLE IF NOT EXISTS ecosystem_revisions (account_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ecosystem_projection_state (app TEXT NOT NULL,identity TEXT NOT NULL,account_id TEXT,revision INTEGER,plan_gb INTEGER,expires_at INTEGER,source_kind TEXT,updated_at INTEGER,PRIMARY KEY(app,identity))`,
    `CREATE TABLE IF NOT EXISTS ecosystem_receipt_conflicts (signature TEXT NOT NULL,app TEXT NOT NULL,identity TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(signature,app,identity))`,
    `CREATE TABLE IF NOT EXISTS ecosystem_timelines (timeline_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,epoch INTEGER NOT NULL,boundary_at INTEGER NOT NULL DEFAULT 0,base_at INTEGER NOT NULL DEFAULT 0,parents TEXT,end_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ecosystem_timeline_parents (child_id TEXT NOT NULL,parent_id TEXT NOT NULL,PRIMARY KEY(child_id,parent_id))`,
    `CREATE INDEX IF NOT EXISTS idx_eco_tl_parents_parent ON ecosystem_timeline_parents(parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_eco_benefits_acct_exp ON ecosystem_benefits(account_id, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_eco_benefits_member_exp ON ecosystem_benefits(app, identity, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_eco_receipts_wallet_paid ON ecosystem_receipts(payer_wallet, paid_at)`,
    `CREATE INDEX IF NOT EXISTS idx_eco_receipts_acct_paid ON ecosystem_receipts(account_id, paid_at)`,
    `CREATE INDEX IF NOT EXISTS idx_eco_jobs_state_next ON ecosystem_jobs(state, next_attempt_at, lease_until)`,
    `CREATE INDEX IF NOT EXISTS idx_eco_proofs_wallet ON ecosystem_member_proofs(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_eco_aliases_acct ON ecosystem_aliases(account_id)`,
];

function createEcosystemService({ sqlite3, dbPath, registry = DEFAULT_REGISTRY, now = () => Date.now() } = {}) {
    if (!sqlite3) throw codedError('CONFIG_INVALID', 'sqlite3 module required');
    if (!isNonBlank(dbPath)) throw codedError('CONFIG_INVALID', 'dbPath required');
    if (!registry || !registry.apps || !registry.products) throw codedError('REGISTRY_INVALID', 'registry.apps/products required');

    const openConn = () => new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath, (e) => e ? reject(e) : resolve(conn));
    });
    const runOn = (conn, sql, params = []) => new Promise((res, rej) =>
        conn.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const getOn = (conn, sql, params = []) => new Promise((res, rej) =>
        conn.get(sql, params, (e, row) => e ? rej(e) : res(row)));
    const allOn = (conn, sql, params = []) => new Promise((res, rej) =>
        conn.all(sql, params, (e, rows) => e ? rej(e) : res(rows || [])));
    const closeConn = (conn) => new Promise((res) => conn.close(() => res()));

    const transaction = (fn) => withDatabaseWriter(dbPath, async () => {
        const conn = await openConn();
        const tx = {
            run: (sql, params) => runOn(conn, sql, params),
            get: (sql, params) => getOn(conn, sql, params),
            all: (sql, params) => allOn(conn, sql, params),
        };
        try {
            await runOn(conn, 'PRAGMA busy_timeout = 10000');
            await runOn(conn, 'PRAGMA foreign_keys = ON');
            await runOn(conn, 'BEGIN IMMEDIATE');
            let result;
            try {
                result = await fn(tx);
            } catch (e) {
                await runOn(conn, 'ROLLBACK').catch(() => { });
                throw e;
            }
            try {
                await runOn(conn, 'COMMIT');
            } catch (e) {
                await runOn(conn, 'ROLLBACK').catch(() => { });
                throw e;
            }
            return result;
        } finally {
            await closeConn(conn);
        }
    });

    const readTransaction = (fn) => (async () => {
        const conn = await openConn();
        const tx = {
            run: (sql, params) => runOn(conn, sql, params),
            get: (sql, params) => getOn(conn, sql, params),
            all: (sql, params) => allOn(conn, sql, params),
        };
        try {
            await runOn(conn, 'PRAGMA busy_timeout = 10000');
            await runOn(conn, 'BEGIN');
            let result;
            try {
                result = await fn(tx);
            } catch (e) {
                await runOn(conn, 'ROLLBACK').catch(() => { });
                throw e;
            }
            await runOn(conn, 'COMMIT');
            return result;
        } finally {
            await closeConn(conn);
        }
    })();

    const tableExists = async (tx, name) =>
        !!(await tx.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));
    const columnExists = async (tx, table, col) =>
        (await tx.all(`PRAGMA table_info(${table})`)).some((c) => c.name === col);
    const placeholders = (n) => Array(n).fill('?').join(',');

    const canonicalAccount = async (tx, accountId) => {
        const a = await tx.get(`SELECT account_id FROM ecosystem_aliases WHERE alias_id = ?`, [String(accountId)]);
        return a ? a.account_id : String(accountId);
    };
    const accountIdSet = async (tx, accountId) => {
        const canonical = await canonicalAccount(tx, accountId);
        const rows = await tx.all(`SELECT alias_id FROM ecosystem_aliases WHERE account_id = ?`, [canonical]);
        return [canonical, ...rows.map((r) => r.alias_id)];
    };

    const newAccountId = (app, identity) =>
        'eco_' + crypto.createHash('sha256')
            .update(`${app}|${identity}|${now()}|${crypto.randomBytes(8).toString('hex')}`)
            .digest('hex').slice(0, 24);

    const bumpGlobal = async (tx, accountId) => {
        await tx.run(`INSERT INTO ecosystem_meta (key,value) VALUES ('global_revision','1')
                      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
        const g = await tx.get(`SELECT value FROM ecosystem_meta WHERE key = 'global_revision'`);
        const rev = Number(g && g.value) || 1;
        if (accountId != null) {
            await tx.run(`INSERT INTO ecosystem_revisions (account_id,revision,updated_at) VALUES (?,?,?)
                          ON CONFLICT(account_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`,
                [String(accountId), rev, now()]);
        }
        return rev;
    };

    const supportedApp = (app) => {
        const a = own(registry.apps, app);
        if (!a) return null;
        const v = Number(a.monthlyValueCents);
        return (Number.isInteger(v) && v > 0 && v <= SHARED_VALUE_CENTS) ? a : null;
    };

    const validateIdentity = async (tx, app, identity) => {
        const appDef = own(registry.apps, app);
        if (!appDef) throw codedError('APP_UNKNOWN', `app not in registry: ${app}`);
        if (!supportedApp(app)) throw codedError('APP_VALUE_UNSUPPORTED', `app monthlyValueCents must be a positive integer <= ${SHARED_VALUE_CENTS}: ${app}`);
        const id = identity == null ? '' : String(identity);
        if (!id) throw codedError('IDENTITY_INVALID', 'identity required');
        if (app === 'photolynk') {
            if (!/^[0-9]+$/.test(id)) throw codedError('IDENTITY_INVALID', 'photolynk identity must be a numeric user id');
            const u = await tx.get(`SELECT id FROM users WHERE id = ?`, [Number(id)]);
            if (!u) throw codedError('IDENTITY_UNKNOWN', `photolynk user does not exist: ${id}`);
        } else if (app === 'paceseeker') {
            if (!PS_IDENTITY_RE.test(id)) throw codedError('IDENTITY_INVALID', 'paceseeker identity must be a device hash');
        }
        return id;
    };

    const productFor = (productId) => {
        const p = own(registry.products, productId);
        if (!p) throw codedError('PRODUCT_UNKNOWN', `product not in registry: ${productId}`);
        return p;
    };
    const durationFor = (product, productId, duration) => {
        const ms = product.durations && own(product.durations, duration);
        if (!isFiniteMs(ms)) throw codedError('DURATION_INVALID', `${productId}:${duration}`);
        return ms;
    };
    const validateToken = (app, token) => {
        const allowed = TOKEN_ENUM[app];
        if (!allowed || !isNonBlank(token) || !allowed.has(String(token))) {
            throw codedError('TOKEN_INVALID', `token not accepted for ${app}: ${token}`);
        }
        return String(token);
    };

    const hasProof = async (tx, app, identity, wallet) =>
        !!(await tx.get(`SELECT 1 AS x FROM ecosystem_member_proofs WHERE app = ? AND identity = ? AND wallet = ?`,
            [app, String(identity), wallet]));
    const recordProof = async (tx, app, identity, wallet, kind, reference) => {
        const ex = await tx.get(
            `SELECT kind, reference FROM ecosystem_member_proofs WHERE app = ? AND identity = ? AND wallet = ?`,
            [app, String(identity), wallet]);
        if (ex && String(ex.kind) === String(kind) && String(ex.reference || '') === String(reference || '')) return false;
        await tx.run(`INSERT INTO ecosystem_member_proofs (app,identity,wallet,kind,reference,verified_at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(app,identity,wallet) DO UPDATE SET kind=excluded.kind,reference=excluded.reference,verified_at=excluded.verified_at`,
            [app, String(identity), wallet, kind, reference || null, now()]);
        return true;
    };

    const provenPsMembersForWallet = async (tx, wallet) => {
        const rows = await tx.all(
            `SELECT m.account_id, m.identity FROM ecosystem_member_proofs p
             JOIN ecosystem_members m ON m.app = p.app AND m.identity = p.identity AND m.wallet = p.wallet
             WHERE p.wallet = ? AND p.app = 'paceseeker'`, [wallet]);
        const seen = new Map();
        for (const r of rows) {
            const c = await canonicalAccount(tx, r.account_id);
            if (!seen.has(c)) seen.set(c, []);
            seen.get(c).push(r);
        }
        return [...seen.entries()].map(([accountId, members]) => ({ accountId, members }));
    };
    const provenAccountsForWallet = async (tx, wallet) => {
        const rows = await tx.all(
            `SELECT DISTINCT m.account_id FROM ecosystem_member_proofs p
             JOIN ecosystem_members m ON m.app = p.app AND m.identity = p.identity AND m.wallet = p.wallet
             WHERE p.wallet = ?`, [wallet]);
        const out = [];
        for (const r of rows) {
            const c = await canonicalAccount(tx, r.account_id);
            if (!out.includes(c)) out.push(c);
        }
        return out;
    };

    const rescheduleWaitingJobs = async (tx, app, identity, wallet) => {
        const jobs = await tx.all(
            `SELECT * FROM ecosystem_jobs WHERE state = 'pending' AND last_error_code = 'PAYMENT_ACCOUNT_UNVERIFIED'`);
        for (const j of jobs) {
            let payload = {};
            try { payload = JSON.parse(j.payload_json || '{}'); } catch (_) { continue; }
            const subjects = Array.isArray(payload.subjects) ? payload.subjects : [];
            const hit = subjects.some((s) =>
                (s.app === app && s.identity != null && String(s.identity) === String(identity))
                || (wallet && s.wallet === wallet));
            if (hit) {
                await tx.run(`UPDATE ecosystem_jobs SET next_attempt_at = ?, updated_at = ? WHERE job_key = ?`,
                    [now(), now(), j.job_key]);
            }
        }
    };

    const enqueueJobTx = async (tx, { signature, subjects, errorCode = null }) => {
        const key = JOB_PREFIX + signature;
        const existing = await tx.get(`SELECT * FROM ecosystem_jobs WHERE job_key = ?`, [key]);
        if (existing) {
            if (existing.state === 'done' || existing.state === 'rejected') return { job: existing, created: false };
            let payload = {};
            try { payload = JSON.parse(existing.payload_json || '{}'); } catch (_) { payload = {}; }
            const list = Array.isArray(payload.subjects) ? payload.subjects : [];
            for (const s of subjects) {
                if (!list.some((x) => x.app === s.app && x.identity === s.identity)) list.push(s);
            }
            await tx.run(`UPDATE ecosystem_jobs SET payload_json = ?, last_error_code = ?, updated_at = ? WHERE job_key = ?`,
                [JSON.stringify({ ...payload, subjects: list }), errorCode || existing.last_error_code, now(), key]);
            return { job: await tx.get(`SELECT * FROM ecosystem_jobs WHERE job_key = ?`, [key]), created: false };
        }
        await tx.run(`INSERT INTO ecosystem_jobs (job_key,kind,reference_id,payload_json,state,attempts,next_attempt_at,last_error_code,created_at,updated_at)
                      VALUES (?,?,?,?,'pending',0,?,?,?,?)`,
            [key, 'verify_solana', signature, JSON.stringify({ subjects }), now(), errorCode, now(), now()]);
        return { job: await tx.get(`SELECT * FROM ecosystem_jobs WHERE job_key = ?`, [key]), created: true };
    };

    const insertEvent = (tx, { eventId, accountId, sourceKind, sourceApp, sourceRef, payload }) =>
        tx.run(`INSERT OR IGNORE INTO ecosystem_events (event_id,account_id,source_kind,source_app,source_ref,policy_version,payload_json,created_at)
                VALUES (?,?,?,?,?,?,?,?)`,
            [eventId, accountId, sourceKind, sourceApp || null, sourceRef || null, POLICY_VERSION, JSON.stringify(payload == null ? null : payload), now()]);
    const eventExists = (tx, eventId) =>
        tx.get(`SELECT event_id FROM ecosystem_events WHERE event_id = ?`, [eventId]);
    const insertBenefit = (tx, b) =>
        tx.run(`INSERT OR IGNORE INTO ecosystem_benefits (event_id,account_id,app,identity,benefit,starts_at,expires_at,tier_gb,monthly_value_cents,scope,value_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [b.eventId, b.accountId || null, b.app, String(b.identity), b.benefit, b.startsAt, b.expiresAt == null ? null : b.expiresAt,
             Number(b.tierGb) || 0, Number(b.monthlyValueCents) || 0, b.scope, JSON.stringify(b.value == null ? null : b.value)]);
    const updateBenefitExpiry = (tx, { eventId, app, identity, benefit, expiresAt }) =>
        tx.run(`UPDATE ecosystem_benefits SET expires_at = ? WHERE event_id = ? AND app = ? AND identity = ? AND benefit = ?`,
            [expiresAt == null ? null : expiresAt, eventId, app, String(identity), benefit]);

    const recordConflict = (tx, signature, app, identity, detail) =>
        tx.run(`INSERT OR IGNORE INTO ecosystem_receipt_conflicts (signature,app,identity,detail,created_at) VALUES (?,?,?,?,?)`,
            [signature, app, String(identity), String(detail || ''), now()]);

    const recordIdentityConflict = (tx, accountId, { app, identity, code, candidates }) =>
        insertEvent(tx, {
            eventId: `idconflict:${app}:${identity}:${code}`,
            accountId, sourceKind: 'identity_conflict', sourceApp: app, sourceRef: String(identity),
            payload: { code, candidates: candidates || [], resolved: false },
        });
    const resolveIdentityConflicts = async (tx, accountId, app, identity) => {
        const rows = await tx.all(
            `SELECT * FROM ecosystem_events WHERE source_kind = 'identity_conflict' AND account_id = ? AND source_app = ? AND source_ref = ?`,
            [accountId, app, String(identity)]);
        for (const r of rows) {
            let p = {};
            try { p = JSON.parse(r.payload_json || '{}'); } catch (_) { p = {}; }
            if (p.resolved) continue;
            p.resolved = true;
            await tx.run(`UPDATE ecosystem_events SET payload_json = ? WHERE event_id = ?`, [JSON.stringify(p), r.event_id]);
        }
    };
    const readLinkConflict = async (tx, accountId, app, identity) => {
        const ids = await accountIdSet(tx, accountId);
        const rows = await tx.all(
            `SELECT * FROM ecosystem_events WHERE source_kind = 'identity_conflict'
               AND account_id IN (${placeholders(ids.length)}) AND source_app = ? AND source_ref = ?
               ORDER BY created_at`, [...ids, app, String(identity)]);
        let latest = null;
        for (const r of rows) {
            let p = {};
            try { p = JSON.parse(r.payload_json || '{}'); } catch (_) { p = {}; }
            if (!p.resolved && isNonBlank(p.code)) latest = { code: p.code, candidates: p.candidates || [] };
        }
        return latest;
    };

    const overrideKey = (accountId) => OVERRIDE_PREFIX + String(accountId);
    const readOverrideList = async (tx, accountId) => {
        const r = await tx.get(`SELECT value FROM ecosystem_meta WHERE key = ?`, [overrideKey(accountId)]);
        if (!r) return [];
        try {
            const p = JSON.parse(r.value);
            return Array.isArray(p.actions) ? p.actions : [];
        } catch (_) { return []; }
    };
    const readOverrideActions = async (tx, accountId) => {
        const ids = await accountIdSet(tx, accountId);
        let actions = [];
        for (const id of ids) actions = actions.concat(await readOverrideList(tx, id));
        const seen = new Set();
        return actions.filter((a) => {
            if (seen.has(a.eventId)) return false;
            seen.add(a.eventId);
            return true;
        }).sort((x, y) => (Number(x.eventAt) - Number(y.eventAt)) || String(x.eventId).localeCompare(String(y.eventId)));
    };
    const appendOverrideAction = async (tx, accountId, action) => {
        const actions = await readOverrideList(tx, accountId);
        if (!actions.some((a) => a.eventId === action.eventId)) actions.push(action);
        await tx.run(`INSERT INTO ecosystem_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [overrideKey(accountId), JSON.stringify({ actions })]);
    };

    const isSharedScope = (scope) => scope === 'shared' || scope === 'shared_local';
    const sharedAdjustedExpiry = (b, actions) => {
        if (!isSharedScope(b.scope)) return b.expires_at == null ? null : Number(b.expires_at);
        if (b.event_kind === 'timeline' || String(b.event_id || '').startsWith(TIMELINE_EVENT_PREFIX)) {
            return b.expires_at == null ? null : Number(b.expires_at);
        }
        let exp = b.expires_at == null ? null : Number(b.expires_at);
        for (const a of actions) {
            const affected = Array.isArray(a.affectedEvents) && a.affectedEvents.includes(b.event_id);
            if (!affected) continue;
            if (a.action === 'revoke') exp = 0;
            else if (a.action === 'set-until' && a.until != null) exp = exp == null ? Number(a.until) : Math.min(exp, Number(a.until));
        }
        return exp;
    };
    const benefitExpiry = (b, actions) => isSharedScope(b.scope) ? sharedAdjustedExpiry(b, actions) : (b.expires_at == null ? null : Number(b.expires_at));
    const benefitActiveAt = (b, actions, at) => {
        if (b.revoked_at != null) return false;
        if (!(Number(b.starts_at) <= at)) return false;
        const exp = benefitExpiry(b, actions);
        return exp == null ? true : exp > at;
    };
    const maxExpiryOf = (rows) => {
        let anyNull = false, m = 0;
        for (const e of rows) { if (e == null) anyNull = true; else m = Math.max(m, Number(e) || 0); }
        return anyNull ? null : m;
    };

    const loadAccountBenefits = async (tx, accountId) => {
        const canonical = await canonicalAccount(tx, accountId);
        const ids = await accountIdSet(tx, canonical);
        const rows = await tx.all(
            `SELECT b.*, e.source_kind AS event_kind, e.source_app AS event_app, e.source_ref AS event_ref
             FROM ecosystem_benefits b LEFT JOIN ecosystem_events e ON e.event_id = b.event_id
             WHERE b.account_id IN (${placeholders(ids.length)})`, ids);
        return rows.filter((b) => !(String(b.event_id || '').startsWith(TIMELINE_EVENT_PREFIX)
            && String(b.event_ref) !== String(canonical)));
    };
    const loadAccountMembers = async (tx, accountId) => {
        const ids = await accountIdSet(tx, accountId);
        return await tx.all(`SELECT * FROM ecosystem_members WHERE account_id IN (${placeholders(ids.length)})`, ids);
    };

    const memberEligible = (b, member) => {
        if (b.scope === 'local' || b.scope === 'shared_local')
            return b.app === member.app && String(b.identity) === String(member.identity);
        if (b.scope === 'shared') {
            const appDef = supportedApp(member.app);
            return !!appDef && Number(b.monthly_value_cents) >= Number(appDef.monthlyValueCents);
        }
        return false;
    };
    const tierSupplied = (b, app) => {
        if (b.scope === 'shared') {
            const appDef = own(registry.apps, app);
            return appDef && appDef.benefit === 'storage' ? (Number(appDef.tierGb) || 0) : 0;
        }
        return Number(b.tier_gb) || 0;
    };

    const resolveMemberState = (member, benefits, actions, at) => {
        const eligible = benefits.filter((b) => benefitActiveAt(b, actions, at) && memberEligible(b, member));
        const appDef = supportedApp(member.app);
        const empty = { identity: member.identity, app: member.app, active: false, expiresAt: null, planGb: 0, sourceKind: null, nextChangeAt: null, eligible };
        if (!appDef || eligible.length === 0) return empty;
        const byExp = (b) => benefitExpiry(b, actions);
        let chosen = eligible;
        let planGb = 0;
        if (appDef.benefit === 'storage') {
            const maxTier = Math.max(0, ...eligible.map((b) => tierSupplied(b, member.app)));
            chosen = eligible.filter((b) => tierSupplied(b, member.app) === maxTier);
            planGb = maxTier;
        }
        const expiresAt = maxExpiryOf(chosen.map(byExp));
        const ranked = [...chosen].sort((a, c) => {
            const ea = byExp(a), ec = byExp(c);
            if (ea == null && ec == null) return 0;
            if (ea == null) return -1;
            if (ec == null) return 1;
            return ec - ea;
        });
        const winner = ranked[0];
        const nextChangeAt = chosen
            .map(byExp).filter((e) => e != null && e > at)
            .reduce((m, e) => Math.min(m, e), Infinity);
        return {
            identity: member.identity, app: member.app,
            active: true,
            expiresAt,
            planGb,
            sourceKind: winner ? (winner.event_kind || winner.scope) : null,
            sourceScope: winner ? winner.scope : null,
            paymentType: winner && winner.value_json ? (() => { try { return JSON.parse(winner.value_json)?.paymentType || null; } catch (_) { return null; } })() : null,
            nextChangeAt: nextChangeAt === Infinity ? null : nextChangeAt,
            eligible,
        };
    };

    const timelineId = (accountId, epoch) => `${accountId}:${epoch}`;
    const ensureEpoch0 = async (tx, accountId) => {
        const id = timelineId(String(accountId), 0);
        await tx.run(`INSERT OR IGNORE INTO ecosystem_timelines (timeline_id,account_id,epoch,boundary_at,base_at,parents,end_at,updated_at)
                     VALUES (?,?,0,0,0,'[]',0,?)`, [id, String(accountId), now()]);
        return await tx.get(`SELECT * FROM ecosystem_timelines WHERE timeline_id = ?`, [id]);
    };
    const latestEpoch = async (tx, accountId) => {
        await ensureEpoch0(tx, accountId);
        return await tx.get(`SELECT * FROM ecosystem_timelines WHERE account_id = ? ORDER BY epoch DESC LIMIT 1`, [String(accountId)]);
    };
    const epochForPaidAt = async (tx, accountId, paidAt) => {
        await ensureEpoch0(tx, accountId);
        const e = await tx.get(
            `SELECT * FROM ecosystem_timelines WHERE account_id = ? AND boundary_at < ? ORDER BY epoch DESC LIMIT 1`,
            [String(accountId), Number(paidAt)]);
        return e || await ensureEpoch0(tx, accountId);
    };
    const epochWindow = async (tx, e) => {
        const nxt = await tx.get(
            `SELECT boundary_at FROM ecosystem_timelines WHERE account_id = ? AND epoch > ? ORDER BY epoch ASC LIMIT 1`,
            [e.account_id, e.epoch]);
        return [Number(e.boundary_at) || 0, nxt ? Number(nxt.boundary_at) : Number.MAX_SAFE_INTEGER];
    };
    const setTimelineBase = async (tx, accountId, baseAt) => {
        await ensureEpoch0(tx, accountId);
        await tx.run(`UPDATE ecosystem_timelines SET base_at = MAX(base_at, ?), updated_at = ? WHERE timeline_id = ?`,
            [Number(baseAt) || 0, now(), timelineId(String(accountId), 0)]);
    };
    const lineageForReceipt = async (tx, originAccountId, paidAt) => {
        const origin = String(originAccountId);
        const canonical = await canonicalAccount(tx, origin);
        if (origin === canonical) return canonical;
        const al = await tx.get(`SELECT merged_at FROM ecosystem_aliases WHERE alias_id = ? AND account_id = ?`, [origin, canonical]);
        if (al && Number(paidAt) > Number(al.merged_at)) return canonical;
        return origin;
    };

    const sharedFoldEvents = async (tx, lineageId, { w0 = 0, w1 = Number.MAX_SAFE_INTEGER, beforeTs = null } = {}) => {
        const receipts = await tx.all(
            `SELECT signature, paid_at, product_id, duration FROM ecosystem_receipts
             WHERE account_id = ? AND COALESCE(legacy_accounted,0) = 0 AND paid_at > ? AND paid_at <= ?
             ORDER BY paid_at, signature`, [String(lineageId), w0, w1]);
        const out = [];
        for (const r of receipts) {
            const product = own(registry.products, r.product_id);
            if (!product || !product.ecosystem) continue;
            let dur = null;
            try { dur = durationFor(product, r.product_id, r.duration || 'monthly'); } catch (_) { continue; }
            out.push({ ts: Number(r.paid_at), kind: 'receipt', dur, id: r.signature });
        }
        const actions = await readOverrideList(tx, lineageId);
        for (const a of actions) {
            const ts = Number(a.eventAt);
            if (!(ts >= w0 && ts < w1)) continue;
            if (a.action === 'revoke') out.push({ ts, kind: 'revoke', id: a.eventId });
            else if (a.action === 'set-until' && a.until != null) out.push({ ts, kind: 'set-until', until: Number(a.until), id: a.eventId });
            else if (a.action === 'extend' && a.days != null) out.push({ ts, kind: 'extend', days: Number(a.days), id: a.eventId });
        }
        out.sort((x, y) => (x.ts - y.ts)
            || ((x.kind === 'receipt' ? 0 : 1) - (y.kind === 'receipt' ? 0 : 1))
            || String(x.id || '').localeCompare(String(y.id || '')));
        if (beforeTs != null) return out.filter((e) => e.ts < beforeTs);
        return out;
    };

    const legacyChainEnd = async (tx, accountId, { beforeTs = null } = {}) => {
        const rows = await tx.all(
            `SELECT signature, app, paid_at, product_id, duration, verified_at, payer_wallet, amount_atomic, token
             FROM ecosystem_receipts
             WHERE account_id = ? AND legacy_accounted = 1 ORDER BY paid_at, signature`, [String(accountId)]);
        let end = 0;
        for (const r of rows) {
            const product = own(registry.products, r.product_id);
            if (!product || !product.ecosystem) continue;
            if (!(Number(r.verified_at) > 0)) continue;
            if (r.app === 'paceseeker') {
                if (!isNonBlank(r.payer_wallet) || !isNonBlank(r.amount_atomic)) continue;
                const allowed = TOKEN_ENUM[r.app];
                if (!isNonBlank(r.token) || !allowed || !allowed.has(String(r.token))) continue;
            }
            const ts = Number(r.paid_at);
            if (!Number.isFinite(ts) || ts <= 0) continue;
            if (beforeTs != null && !(ts < beforeTs)) continue;
            let dur = null;
            try { dur = durationFor(product, r.product_id, r.duration || 'monthly'); } catch (_) { continue; }
            end = Math.max(end, ts) + dur;
        }
        return end;
    };

    const foldSequence = (base, events) => {
        let end = Number(base) || 0;
        for (const ev of events) {
            if (ev.kind === 'receipt') end = Math.max(end, ev.ts) + ev.dur;
            else if (ev.kind === 'revoke') end = 0;
            else if (ev.kind === 'set-until') end = Number(ev.until) || 0;
            else if (ev.kind === 'extend') end = Math.max(end, ev.ts) + Number(ev.days) * DAY_MS;
        }
        return end;
    };

    const foldEpoch = async (tx, eid, { beforeTs = null, memo = new Map(), inStack = new Set() } = {}) => {
        const key = `${eid}|${beforeTs == null ? '' : beforeTs}`;
        if (memo.has(key)) return memo.get(key);
        if (inStack.has(eid)) return 0;
        inStack.add(eid);
        const e = await tx.get(`SELECT * FROM ecosystem_timelines WHERE timeline_id = ?`, [eid]);
        if (!e) { inStack.delete(eid); memo.set(key, 0); return 0; }
        let base = Number(e.base_at) || 0;
        let parents = [];
        try { parents = JSON.parse(e.parents || '[]') || []; } catch (_) { parents = []; }
        for (const p of parents) {
            base = Math.max(base, await foldEpoch(tx, p, { beforeTs, memo, inStack }));
        }
        if (Number(e.epoch) === 0) {
            base = Math.max(base, await legacyChainEnd(tx, e.account_id, { beforeTs }));
        }
        const [w0, w1] = await epochWindow(tx, e);
        const events = await sharedFoldEvents(tx, e.account_id, { w0, w1, beforeTs });
        const end = foldSequence(base, events);
        inStack.delete(eid);
        memo.set(key, end);
        return end;
    };

    const foldSharedEnd = async (tx, lineageId, { beforeTs = null, memo = new Map(), inStack = new Set() } = {}) => {
        const latest = await latestEpoch(tx, lineageId);
        return await foldEpoch(tx, latest.timeline_id, { beforeTs, memo, inStack });
    };

    const refoldEpoch = async (tx, eid, visited = new Set()) => {
        if (visited.has(eid)) return;
        visited.add(eid);
        const e = await tx.get(`SELECT * FROM ecosystem_timelines WHERE timeline_id = ?`, [eid]);
        if (!e) return;
        const end = await foldEpoch(tx, eid);
        if (end !== (Number(e.end_at) || 0)) {
            await tx.run(`UPDATE ecosystem_timelines SET end_at = ?, updated_at = ? WHERE timeline_id = ?`, [end, now(), eid]);
        }
        const latest = await latestEpoch(tx, e.account_id);
        if (latest && latest.timeline_id === eid) {
            const eventId = TIMELINE_EVENT_PREFIX + e.account_id;
            const first = await tx.get(
                `SELECT MIN(paid_at) AS m FROM ecosystem_receipts WHERE account_id = ? AND paid_at > 0`, [e.account_id]);
            const startsAt = first && first.m != null ? Math.min(Number(first.m), Math.max(0, end)) : 0;
            const [w0, w1] = await epochWindow(tx, e);
            const evs = await sharedFoldEvents(tx, e.account_id, { w0, w1 });
            let originKind = 'legacy';
            if (evs.length) originKind = evs[evs.length - 1].kind === 'receipt' ? 'payment' : 'admin';
            await insertEvent(tx, {
                eventId, accountId: e.account_id, sourceKind: 'timeline', sourceApp: 'ecosystem', sourceRef: e.account_id,
                payload: { end },
            });
            await tx.run(`UPDATE ecosystem_events SET source_kind = ?, payload_json = ? WHERE event_id = ?`,
                [end > 0 ? originKind : 'timeline', JSON.stringify({ end }), eventId]);
            await insertBenefit(tx, {
                eventId, accountId: e.account_id, app: '*', identity: '*', benefit: 'subscription',
                startsAt, expiresAt: end > 0 ? end : 0, tierGb: 0, monthlyValueCents: 399, scope: 'shared',
                value: { timeline: true },
            });
            await updateBenefitExpiry(tx, { eventId, app: '*', identity: '*', benefit: 'subscription', expiresAt: end > 0 ? end : 0 });
        }
        const children = await tx.all(`SELECT child_id FROM ecosystem_timeline_parents WHERE parent_id = ?`, [eid]);
        for (const row of children) await refoldEpoch(tx, row.child_id, visited);
    };

    const refoldSharedLineage = async (tx, lineageId) => {
        const latest = await latestEpoch(tx, lineageId);
        await refoldEpoch(tx, latest.timeline_id, new Set());
    };

    const refoldAllShared = async (tx) => {
        const ids = new Set((await tx.all(`SELECT DISTINCT account_id FROM ecosystem_timelines`)).map((r) => r.account_id));
        for (const r of await tx.all(`SELECT DISTINCT account_id FROM ecosystem_receipts WHERE account_id IS NOT NULL`)) ids.add(r.account_id);
        for (const r of await tx.all(`SELECT DISTINCT account_id FROM ecosystem_members`)) ids.add(r.account_id);
        const visited = new Set();
        for (const id of ids) {
            const latest = await latestEpoch(tx, id);
            await refoldEpoch(tx, latest.timeline_id, visited);
        }
    };

    const trialCarryoverKey = (uid) => `carry:pl:${uid}`;
    const recordTrialCarryover = async (tx, uid, trialUntil) => {
        const key = trialCarryoverKey(uid);
        if (await tx.get(`SELECT key FROM ecosystem_meta WHERE key = ?`, [key])) return;
        await tx.run(`INSERT INTO ecosystem_meta (key,value) VALUES (?,?)`, [key, String(Number(trialUntil))]);
        await insertEvent(tx, {
            eventId: `carry:pl:${uid}`, accountId: null, sourceKind: 'carryover', sourceApp: 'photolynk',
            sourceRef: String(uid), payload: { trialUntil: Number(trialUntil) },
        });
    };
    const readTrialCarryover = async (tx, uid) => {
        const r = await tx.get(`SELECT value FROM ecosystem_meta WHERE key = ?`, [trialCarryoverKey(uid)]);
        return r ? Number(r.value) || 0 : 0;
    };

    const refoldLocalMember = async (tx, accountId, app, identity) => {
        const id = String(identity);
        const canonical0 = await canonicalAccount(tx, accountId);
        const lineage = await accountIdSet(tx, canonical0);
        const receipts = await tx.all(
            `SELECT signature, paid_at, product_id, duration FROM ecosystem_receipts
             WHERE account_id IN (${placeholders(lineage.length)}) AND app = ? AND origin_identity = ?
               AND COALESCE(legacy_accounted,0) = 0
             ORDER BY paid_at, signature`, [...lineage, app, id]);
        let end = 0;
        // Admin direct-plan correction: every local/shared_local source that
        // started at-or-before the cutoff is revoked, and receipts paid at or
        // before it contribute NO time to a new local expiry. Their shared
        // timeline contribution is untouched.
        let cutoffAt = 0;
        if (app === 'photolynk') {
            const meta = await tx.get(`SELECT value FROM ecosystem_meta WHERE key = ?`, [`local-plan-cutoff:photolynk:${id}`]);
            if (meta && meta.value) {
                try { cutoffAt = Number(JSON.parse(meta.value).at) || 0; } catch (_) { cutoffAt = 0; }
            }
        }
        // Local base: unrevoked legacy/admin/store grants only. A revoked row
        // (admin correction) never re-enters the base; shared_local rows are
        // materialized shared time (folded via the account timeline, not
        // local expiry) and receipt-derived rows fold through the
        // paid-receipt chain below.
        const legacyRows = await tx.all(
            `SELECT b.expires_at FROM ecosystem_benefits b
             LEFT JOIN ecosystem_events e ON e.event_id = b.event_id
             WHERE b.account_id IN (${placeholders(lineage.length)})
               AND b.scope = 'local' AND b.app = ? AND b.identity = ?
               AND b.revoked_at IS NULL
               AND COALESCE(e.source_kind,'') IN ('legacy','admin','store')`, [...lineage, app, id]);
        for (const r of legacyRows) {
            const x = Number(r.expires_at);
            if (Number.isFinite(x) && x > 0) end = Math.max(end, x);
        }
        if (app === 'photolynk') end = Math.max(end, await readTrialCarryover(tx, id));
        if (app === 'paceseeker') {
            const adRows = await tx.all(
                `SELECT b.expires_at FROM ecosystem_benefits b
                 LEFT JOIN ecosystem_events e ON e.event_id = b.event_id
                 WHERE b.account_id IN (${placeholders(lineage.length)})
                   AND b.scope = 'local' AND b.app = 'paceseeker' AND b.identity = ?
                   AND COALESCE(e.source_kind,'') IN ('ad_claim','ad')`, [...lineage, id]);
            for (const r of adRows) end = Math.max(end, Number(r.expires_at) || 0);
        }
        const canonical = canonical0;
        for (const r of receipts) {
            const product = own(registry.products, r.product_id);
            if (!product || product.premium) continue;
            let dur;
            try { dur = durationFor(product, r.product_id, r.duration || 'monthly'); } catch (_) { continue; }
            const paidAt = Number(r.paid_at);
            if (app === 'photolynk' && cutoffAt > 0 && paidAt <= cutoffAt) {
                // Pre-correction payment: its local effect is revoked even
                // when the benefit row arrived late (inserted after the
                // cutoff was written). The shared timeline contribution
                // stays - only the local grant is corrected.
                await tx.run(
                    `UPDATE ecosystem_benefits SET revoked_at = ?
                     WHERE event_id = ? AND app = ? AND identity = ?
                       AND scope IN ('local','shared_local') AND revoked_at IS NULL`,
                    [now(), `rcpt:${r.signature}`, app, id]);
                continue;
            }
            if (app === 'paceseeker') {
                const sharedBefore = await foldSharedEnd(tx, canonical, { beforeTs: paidAt });
                end = Math.max(end, paidAt, sharedBefore);
            } else {
                end = Math.max(end, paidAt);
            }
            end = end + dur;
            const benefitName = own(registry.apps, app) && registry.apps[app].benefit === 'storage' ? 'storage' : 'features';
            await updateBenefitExpiry(tx, {
                eventId: `rcpt:${r.signature}`, app, identity: id, benefit: benefitName, expiresAt: end,
            });
        }
        return end;
    };

    const seedPlSharedFloor = async (tx, accountId, uid) => {
        const eventId = `legacy:plshared:${uid}`;
        if (await eventExists(tx, eventId)) return 0;
        const isQualifying = (productId) => {
            const p = own(registry.products, productId);
            return !!(p && p.ecosystem && !p.premium);
        };
        const receipts = await tx.all(
            `SELECT product_id, duration, paid_at FROM ecosystem_receipts
             WHERE app = 'photolynk' AND origin_identity = ? AND COALESCE(legacy_accounted,0) = 1
               AND verified_at > 0 AND paid_at > 0
             ORDER BY paid_at, signature`, [String(uid)]);
        let floor = 0;
        if (await tableExists(tx, 'solana_subscription_credits')) {
            const cr = await tx.all(
                `SELECT r.product_id AS pid, c.expires_after AS e FROM solana_subscription_credits c
                 JOIN ecosystem_receipts r ON r.signature = c.tx_signature
                 WHERE c.user_id = ? AND r.legacy_accounted = 1 AND r.app = 'photolynk'
                   AND r.verified_at > 0 AND r.paid_at > 0`, [uid]);
            for (const row of cr) {
                if (isQualifying(row.pid)) floor = Math.max(floor, Number(row.e) || 0);
            }
        }
        const latest = receipts[receipts.length - 1] || null;
        const qualifying = receipts.filter((r) => isQualifying(r.product_id));
        const latestQual = qualifying[qualifying.length - 1] || null;
        if (latestQual) {
            const product = registry.products[latestQual.product_id];
            const dur = durationFor(product, latestQual.product_id, latestQual.duration || 'monthly');
            floor = Math.max(floor, Number(latestQual.paid_at) + dur);
        }
        const planEv = await tx.get(`SELECT payload_json FROM ecosystem_events WHERE event_id = ?`, [`legacy:pl:${uid}`]);
        let plan = null;
        if (planEv) { try { plan = (JSON.parse(planEv.payload_json || '{}') || {}).plan || null; } catch (_) { plan = null; } }
        if (plan && latest && isQualifying(latest.product_id) && String(plan.status) === 'active'
            && plan.expires_at != null && Number(plan.expires_at) > now()
            && bindablePlan(plan)) {
            floor = Math.max(floor, Number(plan.expires_at));
        }
        await insertEvent(tx, {
            eventId, accountId, sourceKind: 'legacy', sourceApp: 'photolynk',
            sourceRef: String(uid), payload: { floor },
        });
        if (floor > 0) await setTimelineBase(tx, accountId, floor);
        return floor;
    };

    const attachOrphans = async (tx, accountId, app, identity) => {
        const id = String(identity);
        let changed = 0;
        const r1 = await tx.run(`UPDATE ecosystem_benefits SET account_id = ? WHERE account_id IS NULL AND app = ? AND identity = ?`,
            [String(accountId), app, id]);
        changed += (r1.changes || 0);
        const r2 = await tx.run(`UPDATE ecosystem_events SET account_id = ? WHERE account_id IS NULL AND source_app = ? AND source_ref = ?`,
            [String(accountId), app, id]);
        changed += (r2.changes || 0);
        const r3 = await tx.run(`UPDATE ecosystem_receipts SET account_id = ? WHERE account_id IS NULL AND app = ? AND origin_identity = ?`,
            [String(accountId), app, id]);
        changed += (r3.changes || 0);
        if (app === 'photolynk') {
            const floor = await seedPlSharedFloor(tx, accountId, Number(id));
            if (floor > 0) changed += 1;
        }
        if (changed > 0) await refoldSharedLineage(tx, await canonicalAccount(tx, accountId));
        return changed;
    };

    // Atomically bind a protocol quote to the receipt signature that consumes
    // it. Idempotent for the same signature; a different signature consuming
    // an already-used quote, an unknown quote id, or a receipt whose immutable
    // subject/product/terms disagree with the issued quote fails closed - a
    // nonempty quote id can never be consumed by a different subject's intent.
    const consumeQuoteInTransaction = async (tx, quoteId, signature, receipt = null) => {
        const tbl = await tx.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ecosystem_payment_quotes'`);
        if (!tbl) return { ok: false, code: 'QUOTE_UNKNOWN', conflicting: { quoteId: String(quoteId) } };
        const row = await tx.get(`SELECT * FROM ecosystem_payment_quotes WHERE quote_id = ?`, [String(quoteId)]);
        if (!row) return { ok: false, code: 'QUOTE_UNKNOWN', conflicting: { quoteId: String(quoteId) } };
        if (receipt) {
            const normDur = (d) => (d == null ? null : (String(d) === 'premium' ? 'premium' : String(d)));
            const checks = [
                ['app', receipt.app, row.app],
                ['identity', receipt.originIdentity == null ? null : String(receipt.originIdentity), row.identity == null ? null : String(row.identity)],
                ['productId', receipt.productId, row.product_id],
                ['duration', normDur(receipt.duration), normDur(row.duration)],
                ['token', receipt.token, row.token],
            ];
            for (const [f, got, want] of checks) {
                if (got == null && want == null) continue;
                if (String(got) !== String(want)) {
                    return { ok: false, code: 'PAYMENT_CONFLICT', conflicting: { quoteId: String(quoteId), field: f } };
                }
            }
            // The payer binds the on-chain funder: a quote issued for one
            // wallet cannot be consumed by a different sender's payment.
            if (row.payer_wallet != null && String(receipt.payerWallet) !== String(row.payer_wallet)) {
                return { ok: false, code: 'PAYMENT_CONFLICT', conflicting: { quoteId: String(quoteId), field: 'payerWallet' } };
            }
        }
        if (row.used_signature != null && String(row.used_signature) !== String(signature)) {
            return { ok: false, code: 'PAYMENT_CONFLICT', conflicting: { quoteId: String(quoteId), usedSignature: String(row.used_signature) } };
        }
        if (row.used_signature == null) {
            const r = await tx.run(`UPDATE ecosystem_payment_quotes SET used_signature = ? WHERE quote_id = ? AND used_signature IS NULL`,
                [String(signature), String(quoteId)]);
            if (!r || r.changes !== 1) {
                const again = await tx.get(`SELECT used_signature FROM ecosystem_payment_quotes WHERE quote_id = ?`, [String(quoteId)]);
                if (!again || String(again.used_signature) !== String(signature)) {
                    return { ok: false, code: 'PAYMENT_CONFLICT', conflicting: { quoteId: String(quoteId), usedSignature: again ? String(again.used_signature) : null } };
                }
            }
        }
        return { ok: true };
    };

    const insertReceipt = async (tx, r) => {
        if (r.quoteId) {
            const c = await consumeQuoteInTransaction(tx, r.quoteId, r.signature, {
                app: r.app, originIdentity: r.originIdentity, productId: r.productId,
                duration: r.duration, token: r.token, payerWallet: r.payerWallet,
            });
            if (c && c.ok === false) {
                const e = codedError(c.code || 'PAYMENT_CONFLICT', `quote ${r.quoteId}: ${c.code}`);
                e.conflicting = c.conflicting;
                throw e;
            }
        }
        return tx.run(`INSERT OR IGNORE INTO ecosystem_receipts (signature,account_id,app,product_id,duration,origin_identity,payer_wallet,token,mint,amount_atomic,paid_at,verified_at,quote_id,policy_version,evidence_json,applied_at,legacy_accounted)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [r.signature, r.accountId || null, r.app, r.productId, r.duration || null, String(r.originIdentity), r.payerWallet || null,
             r.token || null, r.mint || null, r.amountAtomic || null, r.paidAt, r.verifiedAt == null ? null : r.verifiedAt,
             r.quoteId || null, r.policyVersion || POLICY_VERSION, JSON.stringify(r.evidence == null ? null : r.evidence),
             r.appliedAt == null ? null : r.appliedAt, r.legacyAccounted ? 1 : 0]);
    };

    const conflictResult = (conflicting) => ({ ok: false, code: 'PAYMENT_CONFLICT', conflicting });
    const RECEIPT_FIELDS = ['app', 'product_id', 'origin_identity', 'duration', 'token', 'mint', 'payer_wallet', 'amount_atomic', 'quote_id'];
    const receiptCheck = async (tx, { signature, app, productId, duration, originIdentity, token, mint, payerWallet, amountAtomic, quoteId, paidAt, verifiedAt }) => {
        const existing = await tx.get(`SELECT * FROM ecosystem_receipts WHERE signature = ?`, [signature]);
        if (!existing) return null;
        const incoming = {
            app, product_id: productId, origin_identity: String(originIdentity),
            duration: duration || null, token: token || null, mint: mint || null,
            payer_wallet: payerWallet || null, amount_atomic: amountAtomic || null, quote_id: quoteId || null,
        };
        let identical = true;
        const fills = {};
        for (const f of RECEIPT_FIELDS) {
            const oldV = existing[f] == null ? null : String(existing[f]);
            const newV = incoming[f] == null ? null : String(incoming[f]);
            if (oldV != null && newV == null) identical = false;
            if (oldV != null && newV != null && oldV !== newV) identical = false;
            if (oldV == null && newV != null) fills[f] = newV;
        }
        const paidOld = Number(existing.paid_at);
        if (paidOld > 0) {
            if (isFiniteMs(paidAt) && paidOld !== Number(paidAt)) identical = false;
        } else if (isFiniteMs(paidAt)) {
            fills.paid_at = Number(paidAt);
        }
        if (existing.verified_at == null && isFiniteMs(verifiedAt)) fills.verified_at = Number(verifiedAt);
        if (existing.applied_at == null && productId !== 'photolynk.premium') fills.applied_at = now();
        if (!identical) {
            await recordConflict(tx, signature, app, originIdentity,
                `conflicts with ${existing.app}/${existing.product_id}/${existing.origin_identity}/${existing.duration || '-'}/${existing.token || '-'}`);
            return {
                conflict: {
                    app: existing.app, productId: existing.product_id,
                    originIdentity: String(existing.origin_identity), accountId: existing.account_id || null,
                },
            };
        }
        const keys = Object.keys(fills);
        if (keys.length) {
            await tx.run(`UPDATE ecosystem_receipts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE signature = ?`,
                [...keys.map((k) => fills[k]), signature]);
            if (keys.includes('paid_at')) existing.paid_at = fills.paid_at;
            if (keys.includes('verified_at')) existing.verified_at = fills.verified_at;
            if (keys.includes('applied_at')) existing.applied_at = fills.applied_at;
        }
        return { duplicate: true, receipt: existing };
    };

    const checkSolanaLedger = async (tx, { signature, app, userId, deviceHash, tierGb, duration, premium }) => {
        if (!(await tableExists(tx, 'solana_payments'))) return null;
        const old = await tx.get(`SELECT * FROM solana_payments WHERE tx_signature = ?`, [signature]);
        if (!old) return null;
        const oldPremium = old.duration === 'premium' || old.duration === 'premium_skr' || Number(old.tier_gb) === 0;
        if (app === 'paceseeker') {
            await recordConflict(tx, signature, app, deviceHash || '', 'signature recorded in solana_payments ledger');
            return { conflict: { app: 'photolynk', productId: 'solana_payments', originIdentity: String(old.user_id) } };
        }
        if (premium) {
            if (Number(old.user_id) === Number(userId) && oldPremium) return { accounted: true };
            await recordConflict(tx, signature, app, userId, 'signature recorded for a different solana_payments row');
            return { conflict: { app: 'photolynk', productId: 'solana_payments', originIdentity: String(old.user_id) } };
        }
        if (Number(old.user_id) === Number(userId) && !oldPremium && Number(old.tier_gb) === Number(tierGb) && String(old.duration) === String(duration)) {
            return { accounted: true };
        }
        await recordConflict(tx, signature, app, userId, 'signature recorded for a different solana_payments row');
        return { conflict: { app: 'photolynk', productId: 'solana_payments', originIdentity: String(old.user_id) } };
    };

    const validateSignature = (sig) => {
        if (!isNonBlank(sig)) throw codedError('SIGNATURE_INVALID', 'signature must be a nonblank string');
        return String(sig).trim();
    };
    const validatePaymentCore = (p) => {
        const signature = validateSignature(p.signature);
        if (!isAmountAtomic(p.amountAtomic)) throw codedError('AMOUNT_INVALID', 'amountAtomic must be a positive integer string');
        if (!isFiniteMs(p.paidAt)) throw codedError('PAID_AT_INVALID', 'paidAt must be a finite positive epoch ms');
        return signature;
    };

    const snapshotFor = async (tx, accountId, at, { app = 'photolynk', identity = null } = {}) => {
        const r = await resolveAccountTx(tx, accountId, { at, project: true });
        const st = r.members.find((m) => m.app === app && String(m.identity) === String(identity)) || {};
        return {
            ok: true,
            alreadyApplied: false,
            accountId: r.accountId,
            planGb: st.planGb || 0,
            expiresAt: st.expiresAt == null ? null : st.expiresAt,
            status: st.active ? 'active' : 'expired',
            sharedUntil: r.sharedUntil,
            revision: r.revision,
        };
    };

    const mergeAccountsTx = async (tx, targetId, sourceId) => {
        const target = await canonicalAccount(tx, targetId);
        const source = await canonicalAccount(tx, sourceId);
        if (target === source) return target;
        const exists = async (id) => !!(await tx.get(
            `SELECT 1 AS x FROM ecosystem_accounts WHERE account_id = ? UNION SELECT 1 FROM ecosystem_members WHERE account_id = ?`, [id, id]));
        if (!(await exists(target)) || !(await exists(source))) {
            throw codedError('ACCOUNT_UNKNOWN', 'cannot merge an unknown account');
        }
        const cycle = await tx.get(`SELECT 1 AS x FROM ecosystem_aliases WHERE alias_id = ? AND account_id = ?`, [target, source]);
        if (cycle) throw codedError('MERGE_CYCLE', 'accounts already merged in the opposite direction');
        const tMembers = await tx.all(
            `SELECT DISTINCT app FROM ecosystem_members WHERE account_id IN (
                SELECT ? UNION SELECT alias_id FROM ecosystem_aliases WHERE account_id = ?)`, [target, target]);
        const tApps = new Set(tMembers.map((m) => m.app));
        const sMembers = [...new Set((await loadAccountMembers(tx, source)).map((m) => m.app))].map((app) => ({ app }));
        const collisions = sMembers.filter((m) => tApps.has(m.app));
        if (collisions.length) {
            throw codedError('APP_ALREADY_LINKED', 'same app already linked on target account', {
                collisions: collisions.map((m) => ({ app: m.app })),
            });
        }
        await tx.run(`UPDATE ecosystem_aliases SET account_id = ? WHERE account_id = ?`, [target, source]);
        await tx.run(`INSERT OR IGNORE INTO ecosystem_aliases (alias_id,account_id,merged_at) VALUES (?,?,?)`,
            [source, target, now()]);
        const tLatest = await latestEpoch(tx, target);
        const sLatest = await latestEpoch(tx, source);
        const newEpoch = Number(tLatest.epoch) + 1;
        const newEid = timelineId(target, newEpoch);
        await tx.run(`INSERT INTO ecosystem_timelines (timeline_id,account_id,epoch,boundary_at,base_at,parents,end_at,updated_at)
                     VALUES (?,?,?,?,0,?,0,?)`,
            [newEid, target, newEpoch, now(), JSON.stringify([tLatest.timeline_id, sLatest.timeline_id]), now()]);
        for (const p of [tLatest.timeline_id, sLatest.timeline_id]) {
            await tx.run(`INSERT OR IGNORE INTO ecosystem_timeline_parents (child_id,parent_id) VALUES (?,?)`, [newEid, p]);
        }
        await refoldEpoch(tx, sLatest.timeline_id);
        await refoldEpoch(tx, newEid);
        await bumpGlobal(tx, target);
        await resolveAccountTx(tx, target, { at: now(), project: true });
        return target;
    };

    const ensureAccountTx = async (tx, app, identity, { wallet = null, proofKind = null, proofRef = null, allowRotation = false } = {}) => {
        const id = await validateIdentity(tx, app, identity);
        if (proofKind != null) {
            if (!PROOF_KINDS.has(proofKind)) throw codedError('PROOF_KIND_INVALID', `proofKind must be one of ${[...PROOF_KINDS].join(',')}`);
            if (!isNonBlank(proofRef)) throw codedError('PROOF_REF_REQUIRED', 'proofRef required when proofKind is provided');
            if (!isNonBlank(wallet)) throw codedError('WALLET_REQUIRED', 'proof requires a wallet');
        }
        const recordConflictAndReturn = async (accountId, code, candidates) => {
            await recordIdentityConflict(tx, accountId, { app, identity: id, code, candidates });
            return accountId;
        };
        const member = await tx.get(
            `SELECT account_id, wallet, wallet_verified, wallet_changed_at FROM ecosystem_members WHERE app = ? AND identity = ?`,
            [app, id]);
        if (member) {
            const accountId = member.account_id;
            const canonical = await canonicalAccount(tx, accountId);
            let changed = false;
            if (isNonBlank(wallet)) {
                const provenWallet = member.wallet ? await hasProof(tx, app, id, member.wallet) : false;
                if (member.wallet === wallet) {
                    if (proofKind) {
                        const proofChanged = await recordProof(tx, app, id, wallet, proofKind, proofRef);
                        if (!member.wallet_verified) {
                            await tx.run(`UPDATE ecosystem_members SET wallet_verified = 1 WHERE app = ? AND identity = ?`, [app, id]);
                            changed = true;
                        }
                        if (proofChanged) changed = true;
                    }
                } else if (proofKind) {
                    if (provenWallet && !(allowRotation && proofKind === 'rotation')) {
                        throw codedError('WALLET_MISMATCH', 'a different wallet is already proven for this identity');
                    }
                    await tx.run(`UPDATE ecosystem_members SET wallet = ?, wallet_verified = 1, wallet_changed_at = ? WHERE app = ? AND identity = ?`,
                        [wallet, now(), app, id]);
                    await recordProof(tx, app, id, wallet, proofKind, proofRef);
                    changed = true;
                } else if (!provenWallet && member.wallet !== wallet) {
                    await tx.run(`UPDATE ecosystem_members SET wallet = ?, wallet_changed_at = ? WHERE app = ? AND identity = ?`,
                        [wallet, now(), app, id]);
                    changed = true;
                }
            }
            if (await attachOrphans(tx, accountId, app, id)) changed = true;
            if (isNonBlank(wallet) && await hasProof(tx, app, id, wallet)) {
                const holders = (await provenAccountsForWallet(tx, wallet)).filter((a) => a !== canonical);
                if (holders.length > 1) {
                    await recordConflictAndReturn(accountId, 'AMBIGUOUS_WALLET', holders);
                    await bumpGlobal(tx, canonical);
                    return canonical;
                }
                if (holders.length === 1) {
                    const target = holders[0];
                    const clash = (await loadAccountMembers(tx, target)).find((m) => m.app === app);
                    if (clash) {
                        await recordConflictAndReturn(accountId, 'APP_ALREADY_LINKED', [target]);
                        await bumpGlobal(tx, canonical);
                        return canonical;
                    }
                    const merged = await mergeAccountsTx(tx, target, accountId);
                    await resolveIdentityConflicts(tx, merged, app, id);
                    return merged;
                }
            }
            if (changed) await bumpGlobal(tx, canonical);
            return canonical;
        }
        if (isNonBlank(wallet) && proofKind) {
            const holders = await provenAccountsForWallet(tx, wallet);
            if (holders.length > 0) {
                const accountId = newAccountId(app, id);
                await tx.run(`INSERT OR IGNORE INTO ecosystem_accounts (account_id,primary_wallet,created_at) VALUES (?,?,?)`,
                    [accountId, wallet, now()]);
                await tx.run(`INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,?,?,?,1,?)`,
                    [accountId, app, id, wallet, now()]);
                await recordProof(tx, app, id, wallet, proofKind, proofRef);
                await attachOrphans(tx, accountId, app, id);
                if (holders.length > 1) {
                    await recordConflictAndReturn(accountId, 'AMBIGUOUS_WALLET', holders);
                } else {
                    const clash = (await loadAccountMembers(tx, holders[0])).find((m) => m.app === app);
                    if (clash) {
                        await recordConflictAndReturn(accountId, 'APP_ALREADY_LINKED', [holders[0]]);
                    } else {
                        const merged = await mergeAccountsTx(tx, holders[0], accountId);
                        await bumpGlobal(tx, merged);
                        return merged;
                    }
                }
                await rescheduleWaitingJobs(tx, app, id, wallet);
                await bumpGlobal(tx, accountId);
                return accountId;
            }
        }
        const accountId = newAccountId(app, id);
        await tx.run(`INSERT OR IGNORE INTO ecosystem_accounts (account_id,primary_wallet,created_at) VALUES (?,?,?)`,
            [accountId, isNonBlank(wallet) ? wallet : null, now()]);
        await tx.run(`INSERT INTO ecosystem_members (account_id,app,identity,wallet,wallet_verified,linked_at) VALUES (?,?,?,?,?,?)`,
            [accountId, app, id, isNonBlank(wallet) ? wallet : null, proofKind ? 1 : 0, now()]);
        if (proofKind) {
            await recordProof(tx, app, id, wallet, proofKind, proofRef);
            await rescheduleWaitingJobs(tx, app, id, wallet);
        }
        await attachOrphans(tx, accountId, app, id);
        await bumpGlobal(tx, accountId);
        return accountId;
    };

    const applyPhotolynkInTransaction = async (tx, payment, currentPlan) => {
        const p = payment || {};
        const sig = validatePaymentCore(p);
        const token = validateToken('photolynk', p.token);
        if (token === 'SKR' && !isNonBlank(p.mint)) throw codedError('MINT_REQUIRED', 'mint is required for SKR receipts');
        if (!isNonBlank(p.payerWallet)) throw codedError('PAYER_REQUIRED', 'payerWallet is required receipt evidence');
        const uid = Number(p.userId);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw codedError('USER_INVALID', 'userId must be a positive integer');
        await validateIdentity(tx, 'photolynk', String(uid));
        const productId = `photolynk.storage_${Number(p.tierGb)}`;
        const product = productFor(productId);
        if (product.premium || Number(product.tierGb) !== Number(p.tierGb)) throw codedError('TIER_INVALID', `unknown tier ${p.tierGb}`);
        const durationMs = durationFor(product, productId, p.duration);
        const prior = await receiptCheck(tx, {
            signature: sig, app: 'photolynk', productId, duration: p.duration, originIdentity: uid,
            token, payerWallet: p.payerWallet, amountAtomic: p.amountAtomic, quoteId: p.quoteId,
            mint: p.mint, paidAt: p.paidAt, verifiedAt: p.verifiedAt,
        });
        const member = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = 'photolynk' AND identity = ?`, [String(uid)]);
        const accountId = member ? member.account_id : await ensureAccountTx(tx, 'photolynk', String(uid), {});
        if (member) await attachOrphans(tx, accountId, 'photolynk', String(uid));
        if (prior && prior.conflict) return conflictResult(prior.conflict);
        if (prior) {
            const rec = prior.receipt || {};
            const epAcct = rec.account_id || accountId;
            await refoldLocalMember(tx, accountId, 'photolynk', uid);
            if (product.ecosystem) {
                await refoldEpoch(tx, (await epochForPaidAt(tx, epAcct, Number(rec.paid_at) || p.paidAt)).timeline_id);
            }
            const snap = await snapshotFor(tx, accountId, now(), { app: 'photolynk', identity: String(uid) });
            return { ...snap, alreadyApplied: true };
        }
        if (p.quoteId) {
            const qc = await consumeQuoteInTransaction(tx, p.quoteId, sig, {
                app: 'photolynk', originIdentity: uid, productId,
                duration: p.duration, token, payerWallet: p.payerWallet,
            });
            if (qc && qc.ok === false) {
                await recordConflict(tx, sig, 'photolynk', uid, `quote ${p.quoteId}: ${qc.code}`);
                return { ok: false, code: qc.code || 'PAYMENT_CONFLICT', conflicting: qc.conflicting || { quoteId: p.quoteId } };
            }
        }
        const legacy = await checkSolanaLedger(tx, {
            signature: sig, app: 'photolynk', userId: uid, tierGb: p.tierGb, duration: p.duration, premium: false,
        });
        if (legacy && legacy.conflict) return conflictResult(legacy.conflict);
        if (legacy && legacy.accounted) {
            const lin = await lineageForReceipt(tx, accountId, p.paidAt);
            await insertReceipt(tx, {
                signature: sig, accountId: lin, app: 'photolynk', productId, duration: p.duration, originIdentity: uid,
                payerWallet: p.payerWallet, token, mint: p.mint, amountAtomic: p.amountAtomic, paidAt: p.paidAt,
                verifiedAt: p.verifiedAt, quoteId: p.quoteId, evidence: p.evidence,
                appliedAt: now(), legacyAccounted: true,
            });
            await refoldLocalMember(tx, accountId, 'photolynk', uid);
            await refoldEpoch(tx, (await epochForPaidAt(tx, lin, p.paidAt)).timeline_id);
            const snap = await snapshotFor(tx, accountId, now(), { app: 'photolynk', identity: String(uid) });
            return { ...snap, alreadyApplied: true };
        }
        const eventId = `rcpt:${sig}`;
        await insertEvent(tx, {
            eventId, accountId, sourceKind: 'payment', sourceApp: 'photolynk', sourceRef: sig,
            payload: { productId, tierGb: Number(p.tierGb), duration: p.duration, token, quoteId: p.quoteId || null },
        });
        await insertBenefit(tx, {
            eventId, accountId, app: 'photolynk', identity: String(uid), benefit: 'storage',
            startsAt: p.paidAt, expiresAt: p.paidAt + durationMs, tierGb: Number(p.tierGb),
            monthlyValueCents: 0, scope: 'local',
            value: { paymentType: token === 'SKR' ? 'skr' : 'solana', source: p.source || null },
        });
        const lin = await lineageForReceipt(tx, accountId, p.paidAt);
        await insertReceipt(tx, {
            signature: sig, accountId: lin, app: 'photolynk', productId, duration: p.duration, originIdentity: uid,
            payerWallet: p.payerWallet, token, mint: p.mint, amountAtomic: p.amountAtomic, paidAt: p.paidAt,
            verifiedAt: p.verifiedAt, quoteId: p.quoteId, evidence: p.evidence, appliedAt: now(),
        });
        if (currentPlan && currentPlan.status === 'trial' && isFiniteMs(Number(currentPlan.trial_until))) {
            await recordTrialCarryover(tx, uid, Number(currentPlan.trial_until));
        }
        await refoldLocalMember(tx, accountId, 'photolynk', uid);
        if (product.ecosystem) {
            await refoldEpoch(tx, (await epochForPaidAt(tx, lin, p.paidAt)).timeline_id);
        }
        await bumpGlobal(tx, accountId);
        return await snapshotFor(tx, accountId, now(), { app: 'photolynk', identity: String(uid) });
    };

    const claimPremiumInTransaction = async (tx, payment) => {
        const p = payment || {};
        const sig = validatePaymentCore(p);
        const token = validateToken('photolynk', p.token);
        if (token === 'SKR' && !isNonBlank(p.mint)) throw codedError('MINT_REQUIRED', 'mint is required for SKR receipts');
        if (!isNonBlank(p.payerWallet)) throw codedError('PAYER_REQUIRED', 'payerWallet is required receipt evidence');
        const uid = Number(p.userId);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw codedError('USER_INVALID', 'userId must be a positive integer');
        await validateIdentity(tx, 'photolynk', String(uid));
        const productId = 'photolynk.premium';
        productFor(productId);
        const prior = await receiptCheck(tx, {
            signature: sig, app: 'photolynk', productId, duration: 'premium', originIdentity: uid,
            token, payerWallet: p.payerWallet, amountAtomic: p.amountAtomic, quoteId: p.quoteId,
            mint: p.mint, paidAt: p.paidAt, verifiedAt: p.verifiedAt,
        });
        const member = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = 'photolynk' AND identity = ?`, [String(uid)]);
        const accountId = member ? member.account_id : await ensureAccountTx(tx, 'photolynk', String(uid), {});
        if (member) await attachOrphans(tx, accountId, 'photolynk', String(uid));
        if (prior && prior.conflict) return conflictResult(prior.conflict);
        if (prior) return { ok: true, alreadyApplied: true, alreadyClaimed: true, applied: !!(prior.receipt && prior.receipt.applied_at), accountId, signature: sig };
        const legacy = await checkSolanaLedger(tx, {
            signature: sig, app: 'photolynk', userId: uid, premium: true,
        });
        if (legacy && legacy.conflict) return conflictResult(legacy.conflict);
        if (legacy && legacy.accounted) {
            await insertReceipt(tx, {
                signature: sig, accountId, app: 'photolynk', productId, duration: 'premium', originIdentity: uid,
                payerWallet: p.payerWallet, token, mint: p.mint, amountAtomic: p.amountAtomic, paidAt: p.paidAt,
                verifiedAt: p.verifiedAt, quoteId: p.quoteId, evidence: p.evidence, appliedAt: null, legacyAccounted: true,
            });
            await bumpGlobal(tx, accountId);
            return { ok: true, alreadyApplied: true, alreadyClaimed: true, applied: false, accountId, signature: sig };
        }
        await insertEvent(tx, {
            eventId: `premium:${sig}`, accountId, sourceKind: 'payment', sourceApp: 'photolynk', sourceRef: sig,
            payload: { productId, token },
        });
        await insertReceipt(tx, {
            signature: sig, accountId, app: 'photolynk', productId, duration: 'premium', originIdentity: uid,
            payerWallet: p.payerWallet, token, mint: p.mint, amountAtomic: p.amountAtomic, paidAt: p.paidAt,
            verifiedAt: p.verifiedAt, quoteId: p.quoteId, evidence: p.evidence, appliedAt: null,
        });
        await bumpGlobal(tx, accountId);
        return { ok: true, alreadyApplied: false, applied: false, accountId, signature: sig };
    };

    const markPremiumApplied = async (signature) =>
        transaction(async (tx) => {
            const sig = validateSignature(signature);
            const rec = await tx.get(`SELECT * FROM ecosystem_receipts WHERE signature = ?`, [sig]);
            if (!rec) throw codedError('RECEIPT_UNKNOWN', `receipt not found: ${sig}`);
            if (rec.product_id !== 'photolynk.premium') throw codedError('NOT_PREMIUM', 'receipt is not a premium claim');
            if (rec.applied_at != null) {
                return { ok: true, alreadyApplied: true, applied: true, signature: sig, appliedAt: Number(rec.applied_at) };
            }
            await tx.run(`UPDATE ecosystem_receipts SET applied_at = ? WHERE signature = ?`, [now(), sig]);
            if (rec.account_id) await bumpGlobal(tx, rec.account_id);
            return { ok: true, applied: true, signature: sig, appliedAt: now() };
        });

    const applyPaceSeekerPayment = async (receipt, { deviceHash } = {}) =>
        transaction(async (tx) => {
            const r = receipt || {};
            const sig = validatePaymentCore(r);
            const token = validateToken('paceseeker', r.token);
            if (token === 'SKR' && !isNonBlank(r.mint)) throw codedError('MINT_REQUIRED', 'mint is required for SKR receipts');
            if (r.verifiedAt != null && !isFiniteMs(r.verifiedAt)) throw codedError('VERIFIED_AT_INVALID');
            const productId = 'paceseeker.monthly';
            const product = productFor(productId);
            const durationMs = durationFor(product, productId, 'monthly');
            const wallet = isNonBlank(r.payerWallet) ? String(r.payerWallet) : null;
            const deviceId = deviceHash == null ? null : String(deviceHash);
            if (deviceId != null) await validateIdentity(tx, 'paceseeker', deviceId);
            let member = null;
            let accountId = null;
            if (deviceId) {
                member = await tx.get(
                    `SELECT account_id, identity FROM ecosystem_members WHERE app = 'paceseeker' AND identity = ?`, [deviceId]);
                if (member && wallet && await hasProof(tx, 'paceseeker', deviceId, wallet)) {
                    accountId = member.account_id;
                }
            } else if (wallet) {
                const holders = await provenPsMembersForWallet(tx, wallet);
                const memberCount = holders.reduce((n, h) => n + h.members.length, 0);
                if (holders.length > 1 || memberCount > 1) {
                    return { ok: false, code: 'AMBIGUOUS_WALLET', accounts: holders.map((h) => h.accountId) };
                }
                if (memberCount === 1) {
                    member = holders[0].members[0];
                    accountId = holders[0].accountId;
                }
            }
            if (!member || !accountId) {
                await enqueueJobTx(tx, {
                    signature: sig,
                    subjects: [{ app: 'paceseeker', identity: deviceId || null, wallet }],
                    errorCode: 'PAYMENT_ACCOUNT_UNVERIFIED',
                });
                return { ok: false, code: 'PAYMENT_ACCOUNT_UNVERIFIED', retryable: true, awaitingRegistration: !deviceId && !wallet ? 'paceseeker' : 'paceseeker' };
            }
            const originIdentity = String(member.identity);
            const prior = await receiptCheck(tx, {
                signature: sig, app: 'paceseeker', productId, duration: 'monthly', originIdentity,
                token, payerWallet: wallet, amountAtomic: r.amountAtomic, quoteId: r.quoteId,
                mint: r.mint, paidAt: r.paidAt, verifiedAt: r.verifiedAt,
            });
            if (prior && prior.conflict) return conflictResult(prior.conflict);
            const canonical = await canonicalAccount(tx, accountId);
            const snapshot = async () => {
                const snap = await resolveAccountTx(tx, canonical, { at: now(), project: true });
                const psM = snap.members.find((m) => m.app === 'paceseeker' && String(m.identity) === originIdentity) || {};
                return {
                    ok: true, alreadyApplied: true, accountId: canonical,
                    sharedUntil: snap.sharedUntil,
                    psUntil: psM.expiresAt == null ? null : psM.expiresAt,
                    revision: snap.revision,
                };
            };
            if (prior) {
                const rec = prior.receipt || {};
                const epAcct = rec.account_id || accountId;
                await refoldEpoch(tx, (await epochForPaidAt(tx, epAcct, Number(rec.paid_at) || r.paidAt)).timeline_id);
                await refoldLocalMember(tx, accountId, 'paceseeker', originIdentity);
                return await snapshot();
            }
            const ledger = await checkSolanaLedger(tx, { signature: sig, app: 'paceseeker', deviceHash: deviceId });
            if (ledger && ledger.conflict) return conflictResult(ledger.conflict);
            if (ledger && ledger.accounted) {
                const lin = await lineageForReceipt(tx, accountId, r.paidAt);
                await insertReceipt(tx, {
                    signature: sig, accountId: lin, app: 'paceseeker', productId, duration: 'monthly', originIdentity,
                    payerWallet: wallet, token, mint: r.mint, amountAtomic: r.amountAtomic,
                    paidAt: r.paidAt, verifiedAt: r.verifiedAt, quoteId: r.quoteId, evidence: r.evidence,
                    appliedAt: now(), legacyAccounted: true,
                });
                await refoldLocalMember(tx, accountId, 'paceseeker', originIdentity);
                await refoldEpoch(tx, (await epochForPaidAt(tx, lin, r.paidAt)).timeline_id);
                return await snapshot();
            }
            const eventId = `rcpt:${sig}`;
            await insertEvent(tx, {
                eventId, accountId, sourceKind: 'payment', sourceApp: 'paceseeker', sourceRef: sig,
                payload: { productId, token, deviceHash: deviceId, quoteId: r.quoteId || null },
            });
            if (deviceId) {
                await insertBenefit(tx, {
                    eventId, accountId, app: 'paceseeker', identity: deviceId, benefit: 'features',
                    startsAt: r.paidAt, expiresAt: r.paidAt + durationMs, tierGb: 0,
                    monthlyValueCents: 0, scope: 'local', value: { source: 'payment' },
                });
            }
            const lin = await lineageForReceipt(tx, accountId, r.paidAt);
            await insertReceipt(tx, {
                signature: sig, accountId: lin, app: 'paceseeker', productId, duration: 'monthly', originIdentity,
                payerWallet: wallet, token, mint: r.mint, amountAtomic: r.amountAtomic,
                paidAt: r.paidAt, verifiedAt: r.verifiedAt, quoteId: r.quoteId, evidence: r.evidence, appliedAt: now(),
            });
            if (deviceId) await refoldLocalMember(tx, accountId, 'paceseeker', deviceId);
            await refoldEpoch(tx, (await epochForPaidAt(tx, lin, r.paidAt)).timeline_id);
            await bumpGlobal(tx, canonical);
            const snap = await resolveAccountTx(tx, canonical, { at: now(), project: true });
            const psMember = snap.members.find((m) => m.app === 'paceseeker' && String(m.identity) === originIdentity) || {};
            return {
                ok: true,
                alreadyApplied: false, accountId: canonical, sharedUntil: snap.sharedUntil,
                psUntil: deviceId && psMember.expiresAt != null ? psMember.expiresAt : null,
                revision: snap.revision,
            };
        });

    const resolveAccountTx = async (tx, accountId, { at = now(), project = false } = {}) => {
        const canonical = await canonicalAccount(tx, accountId);
        const members = await loadAccountMembers(tx, canonical);
        if (project) {
            // A legacy ledger row the core has never seen must be absorbed
            // before benefits load — otherwise the projection below would
            // overwrite the legacy expiry with the lower core-derived value.
            let absorbed = false;
            for (const m of members) {
                if (await absorbLegacyLedgerFor(tx, m.app, m.identity) > 0) absorbed = true;
            }
            if (absorbed) await refoldSharedLineage(tx, canonical);
        }
        const benefits = await loadAccountBenefits(tx, canonical);
        const actions = await readOverrideActions(tx, canonical);
        const appCounts = {};
        for (const m of members) if (supportedApp(m.app)) appCounts[m.app] = (appCounts[m.app] || 0) + 1;
        const apps = {};
        const memberStates = [];
        const sources = [];
        const seenSources = new Set();
        let nextChangeAt = Infinity;
        for (const m of members) {
            if (!supportedApp(m.app)) continue;
            const st = resolveMemberState(m, benefits, actions, at);
            const { eligible, ...pub } = st;
            memberStates.push(pub);
            if (appCounts[m.app] === 1) apps[m.app] = pub;
            if (st.nextChangeAt != null && st.nextChangeAt < nextChangeAt) nextChangeAt = st.nextChangeAt;
            if (eligible) for (const b of eligible) {
                const key = `${b.event_id}|${b.app}|${b.identity}|${b.benefit}`;
                if (seenSources.has(key)) continue;
                seenSources.add(key);
                sources.push({
                    eventId: b.event_id, kind: b.event_kind || b.scope, app: b.app, benefit: b.benefit,
                    identity: b.identity == null ? null : String(b.identity),
                    scope: b.scope, startsAt: Number(b.starts_at), expiresAt: benefitExpiry(b, actions),
                    tierGb: Number(b.tier_gb) || 0, monthlyValueCents: Number(b.monthly_value_cents) || 0,
                });
            }
        }
        const sharedRows = benefits.filter((b) => b.scope === 'shared');
        const sharedUntil = maxExpiryOf(sharedRows.map((b) => benefitExpiry(b, actions)));
        const rev = await tx.get(`SELECT revision FROM ecosystem_revisions WHERE account_id = ?`, [canonical]);
        const result = {
            accountId: canonical,
            revision: rev ? Number(rev.revision) : 0,
            apps,
            members: memberStates,
            sources,
            sharedUntil: sharedUntil == null && sharedRows.length ? null : (sharedUntil || 0),
            nextChangeAt: nextChangeAt === Infinity ? null : nextChangeAt,
        };
        if (project) result.revision = await projectAccountTx(tx, canonical, members, benefits, actions, memberStates, at);
        return result;
    };

    const lastFiniteMemberExpiry = (member, benefits, actions) => {
        const rows = benefits
            .filter((b) => memberEligible(b, member) && Number(b.starts_at) > 0)
            .map((b) => benefitExpiry(b, actions))
            .filter((e) => e != null);
        return rows.length ? Math.max(...rows) : null;
    };

    const projectAccountTx = async (tx, accountId, members, benefits, actions, memberStates, at) => {
        let changed = false;
        const statesByKey = new Map(memberStates.map((s) => [`${s.app}|${s.identity}`, s]));
        for (const m of members) {
            if (!supportedApp(m.app)) continue;
            const st = statesByKey.get(`${m.app}|${m.identity}`) || { active: false, expiresAt: null, planGb: 0 };
            const prev = await tx.get(
                `SELECT plan_gb, expires_at, source_kind FROM ecosystem_projection_state WHERE app = ? AND identity = ?`,
                [m.app, String(m.identity)]);
            const prevExp = prev && prev.expires_at == null ? null : Number(prev && prev.expires_at);
            const sameProjection = prev && Number(prev.plan_gb || 0) === Number(st.planGb || 0)
                && prevExp === (st.expiresAt == null ? null : Number(st.expiresAt))
                && String(prev.source_kind || '') === String(st.sourceKind || '');
            let compatChanged = false;
            if (m.app === 'photolynk') {
                const uid = Number(m.identity);
                const alive = await tx.get(`SELECT id FROM users WHERE id = ?`, [uid]);
                if (alive) {
                    const cur = await tx.get(`SELECT * FROM user_plans WHERE user_id = ?`, [uid]);
                    if (st.active) {
                        const paymentType = isSharedScope(st.sourceScope) ? 'ecosystem'
                            : (st.sourceKind === 'ad_claim' || st.sourceKind === 'ad') ? 'ad_claim'
                                : (st.paymentType || 'ecosystem');
                        const desiredExp = st.expiresAt == null ? null : Number(st.expiresAt);
                        const differs = !cur || Number(cur.plan_gb || 0) !== (Number(st.planGb) || 0)
                            || cur.status !== 'active'
                            || (cur.expires_at == null ? null : Number(cur.expires_at)) !== desiredExp
                            || String(cur.payment_type || '') !== String(paymentType)
                            || cur.grace_until != null || cur.deleted_at != null;
                        if (differs) {
                            await tx.run(
                                `INSERT INTO user_plans (user_id, plan_gb, status, expires_at, payment_type, updated_at)
                                 VALUES (?, ?, 'active', ?, ?, ?)
                                 ON CONFLICT(user_id) DO UPDATE SET
                                    plan_gb = excluded.plan_gb, status = 'active', expires_at = excluded.expires_at,
                                    payment_type = excluded.payment_type, grace_until = NULL, deleted_at = NULL,
                                    updated_at = excluded.updated_at`,
                                [uid, Number(st.planGb) || 0, desiredExp, paymentType, now()]);
                            compatChanged = true;
                        }
                    } else if (cur) {
                        // Projection mirrors the resolved expiry ONLY - the
                        // grace/retention state machine (resolveSubscriptionState)
                        // owns status/grace_until/deleted_at. A projection-written
                        // 'expired' would satisfy that machine's CAS guard with
                        // deleted_at never set, so retention would never start.
                        const lastFin = lastFiniteMemberExpiry(m, benefits, actions);
                        const nextExp = lastFin != null ? lastFin : (cur.expires_at == null ? null : Number(cur.expires_at));
                        if ((cur.expires_at == null ? null : Number(cur.expires_at)) !== (nextExp == null ? null : Number(nextExp))) {
                            await tx.run(
                                `UPDATE user_plans SET expires_at = ?, updated_at = ? WHERE user_id = ?`,
                                [nextExp, now(), uid]);
                            compatChanged = true;
                        }
                    }
                }
            } else if (m.app === 'paceseeker' && (await tableExists(tx, 'paceseeker_devices'))) {
                const lastFin = st.active ? st.expiresAt : lastFiniteMemberExpiry(m, benefits, actions);
                const next = lastFin == null ? 0 : Number(lastFin);
                const dev = await tx.get(`SELECT sub_until FROM paceseeker_devices WHERE device_hash = ?`, [String(m.identity)]);
                if (dev && Number(dev.sub_until || 0) !== next) {
                    await tx.run(`UPDATE paceseeker_devices SET sub_until = ? WHERE device_hash = ?`, [next, String(m.identity)]);
                    compatChanged = true;
                }
            }
            if (!sameProjection || compatChanged) changed = true;
            if (!sameProjection) {
                await tx.run(
                    `INSERT INTO ecosystem_projection_state (app,identity,account_id,revision,plan_gb,expires_at,source_kind,updated_at)
                     VALUES (?,?,?,?,?,?,?,?)
                     ON CONFLICT(app,identity) DO UPDATE SET
                        account_id = excluded.account_id, plan_gb = excluded.plan_gb,
                        expires_at = excluded.expires_at, source_kind = excluded.source_kind, updated_at = excluded.updated_at`,
                    [m.app, String(m.identity), accountId, null, Number(st.planGb) || 0,
                     st.expiresAt == null ? null : Number(st.expiresAt), st.sourceKind || null, now()]);
            }
        }
        const benefitsShared = benefits.filter((b) => b.scope === 'shared');
        const sharedUntil = maxExpiryOf(benefitsShared.map((b) => benefitExpiry(b, actions))) || 0;
        if (await tableExists(tx, 'stealthlynk_subs')) {
            const subs = await tx.get(`SELECT * FROM stealthlynk_subs WHERE account_id = ?`, [accountId]);
            const topSource = benefitsShared
                .filter((b) => benefitActiveAt(b, actions, at))
                .sort((a, c) => (benefitExpiry(c, actions) || 0) - (benefitExpiry(a, actions) || 0))[0];
            const srcApp = topSource ? (topSource.event_app || topSource.scope) : 'ecosystem';
            const srcRef = topSource ? topSource.event_id : null;
            if (!subs) {
                await tx.run(
                    `INSERT INTO stealthlynk_subs (account_id,sub_until,source_app,source_kind,provenance,updated_at)
                     VALUES (?,?,?,?,?,?)`,
                    [accountId, sharedUntil, srcApp, 'subscription', srcRef, now()]);
                changed = true;
            } else if (Number(subs.sub_until || 0) !== sharedUntil
                || String(subs.source_app || '') !== String(srcApp || '')
                || String(subs.source_kind || '') !== 'subscription'
                || String(subs.provenance || '') !== String(srcRef || '')) {
                await tx.run(
                    `UPDATE stealthlynk_subs SET sub_until = ?, updated_at = ?,
                        source_app = ?, source_kind = 'subscription', provenance = ?
                     WHERE account_id = ?`,
                    [sharedUntil, now(), srcApp, srcRef, accountId]);
                changed = true;
            }
        }
        const revision = changed ? await bumpGlobal(tx, accountId)
            : Number((await tx.get(`SELECT revision FROM ecosystem_revisions WHERE account_id = ?`, [accountId]))?.revision || 0);
        // Every projection pass stamps the FINAL revision and refreshes
        // updated_at - a non-projecting bump (e.g. ensureAccount wallet
        // change) must not leave auto-mode reads projecting forever, and a
        // stable account re-projects at most once per freshness window.
        for (const m of members) {
            if (!supportedApp(m.app)) continue;
            await tx.run(
                `UPDATE ecosystem_projection_state SET revision = ?, updated_at = ?
                 WHERE app = ? AND identity = ? AND (revision IS NOT ? OR updated_at IS NOT ?)`,
                [revision, now(), m.app, String(m.identity), revision, now()]);
        }
        return revision;
    };

    // Auto mode: a read takes the writer gate only when the stored projection
    // is behind the account revision or older than the freshness window;
    // otherwise the read-only snapshot is returned without a write.
    const PROJECTION_STALE_MS = 10 * 60 * 1000;
    const autoProjectionNeeded = async (tx, accountId) => {
        const canonical = await canonicalAccount(tx, accountId);
        const rev = await tx.get(`SELECT revision FROM ecosystem_revisions WHERE account_id = ?`, [canonical]);
        const R = rev ? Number(rev.revision) : 0;
        const members = await loadAccountMembers(tx, canonical);
        const staleBefore = now() - PROJECTION_STALE_MS;
        for (const m of members) {
            if (!supportedApp(m.app)) continue;
            const p = await tx.get(
                `SELECT revision, updated_at FROM ecosystem_projection_state WHERE app = ? AND identity = ?`,
                [m.app, String(m.identity)]);
            if (!p || Number(p.revision || 0) !== R || Number(p.updated_at || 0) < staleBefore) return true;
        }
        return false;
    };

    const resolveIdentity = async (app, identity, { at = now(), project = true } = {}) => {
        const work = async (tx) => {
            const id = await validateIdentity(tx, app, identity);
            const member = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = ? AND identity = ?`, [app, id]);
            if (!member) return null;
            const res = await resolveAccountTx(tx, member.account_id, { at, project });
            res.entitlement = res.members.find((s) => s.app === app && String(s.identity) === String(id)) || null;
            res.linkConflict = await readLinkConflict(tx, res.accountId, app, id);
            return res;
        };
        if (project === 'auto') {
            const needed = await readTransaction(async (tx) => {
                const id = await validateIdentity(tx, app, identity);
                const member = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = ? AND identity = ?`, [app, id]);
                return member ? autoProjectionNeeded(tx, member.account_id) : false;
            });
            project = needed;
        }
        return project ? await transaction(work) : await readTransaction(work);
    };
    const resolveAccount = async (accountId, { at = now(), project = false } = {}) => {
        if (project === 'auto') {
            project = await readTransaction((tx) => autoProjectionNeeded(tx, accountId));
        }
        const work = (tx) => resolveAccountTx(tx, accountId, { at, project });
        return project ? await transaction(work) : await readTransaction(work);
    };

    const grantAdClaim = async (claimId, { tierGb = 100 } = {}) =>
        transaction(async (tx) => {
            const claim = await tx.get(`SELECT * FROM ad_claims WHERE id = ?`, [Number(claimId)]);
            if (!claim) throw codedError('CLAIM_UNKNOWN', `ad_claim ${claimId} not found`);
            const canonical = await canonicalAccount(tx, claim.account_id);
            if (!['verified', 'pending'].includes(String(claim.status))) {
                return { granted: false, reason: 'claim_not_verified', accountId: canonical };
            }
            const eventId = `ad:${claim.id}`;
            if (await eventExists(tx, eventId)) {
                const snap = await resolveAccountTx(tx, canonical, { at: now(), project: false });
                return { granted: false, alreadyGranted: true, accountId: canonical, revision: snap.revision };
            }
            const ids = await accountIdSet(tx, canonical);
            const siblings = await tx.all(
                `SELECT c.id, c.granted_at FROM ad_claims c WHERE c.account_id IN (${placeholders(ids.length)})
                   AND c.week_key = ? AND c.id <> ?`,
                [...ids, claim.week_key, claim.id]);
            let dupGranted = false;
            for (const s of siblings) {
                if (s.granted_at != null || await eventExists(tx, `ad:${s.id}`)) { dupGranted = true; break; }
            }
            if (dupGranted) {
                if (claim.granted_at == null) {
                    await tx.run(`UPDATE ad_claims SET granted_at = ? WHERE id = ?`, [now(), claim.id]);
                }
                const snap = await resolveAccountTx(tx, canonical, { at: now(), project: false });
                return { granted: false, alreadyGranted: true, accountId: canonical, revision: snap.revision };
            }
            if (claim.granted_at != null) {
                const snap = await resolveAccountTx(tx, canonical, { at: now(), project: false });
                return { granted: false, alreadyGranted: true, accountId: canonical, revision: snap.revision };
            }
            const actions = await readOverrideActions(tx, canonical);
            const latestRevoke = actions.length && actions[actions.length - 1].action === 'revoke';
            const sharedEnd = await foldSharedEnd(tx, canonical);
            if (latestRevoke && !(sharedEnd > now())) return { granted: false, reason: 'revoked', accountId: canonical };
            const members = await loadAccountMembers(tx, canonical);
            const benefits = await loadAccountBenefits(tx, canonical);
            await insertEvent(tx, {
                eventId, accountId: canonical, sourceKind: 'ad_claim', sourceApp: claim.app || null,
                sourceRef: claim.post_url || String(claim.id),
                payload: { claimId: claim.id, weekKey: claim.week_key, platform: claim.platform || null },
            });
            const results = [];
            for (const m of members) {
                const appDef = supportedApp(m.app);
                if (!appDef) continue;
                const st = resolveMemberState(m, benefits, actions, now());
                const base = Math.max(now(), st.active && st.expiresAt != null ? st.expiresAt : 0);
                const tier = appDef.benefit === 'storage' ? Math.min(Math.max(Number(tierGb) || 100, 1), AD_MAX_TIER_GB) : 0;
                await insertBenefit(tx, {
                    eventId, accountId: m.account_id, app: m.app, identity: String(m.identity),
                    benefit: appDef.benefit, startsAt: now(), expiresAt: base + WEEK_MS,
                    tierGb: tier, monthlyValueCents: 0, scope: 'local', value: { source: 'ad_claim' },
                });
                results.push({ app: m.app, identity: String(m.identity), until: base + WEEK_MS });
            }
            await tx.run(`UPDATE ad_claims SET granted_at = ? WHERE id = ?`, [now(), claim.id]);
            await bumpGlobal(tx, canonical);
            const snap = await resolveAccountTx(tx, canonical, { at: now(), project: true });
            return { granted: true, accountId: canonical, grants: results, revision: snap.revision };
        });

    const adjustShared = async (accountId, { action, until, days, eventId, actor } = {}) =>
        transaction(async (tx) => {
            if (!isNonBlank(eventId)) throw codedError('EVENT_ID_REQUIRED', 'stable eventId required');
            if (!isNonBlank(actor)) throw codedError('ACTOR_REQUIRED', 'actor required');
            const canonical = await canonicalAccount(tx, accountId);
            const exists = await tx.get(`SELECT 1 AS x FROM ecosystem_accounts WHERE account_id = ?
                                        UNION SELECT 1 FROM ecosystem_members WHERE account_id = ?`, [canonical, canonical]);
            if (!exists) throw codedError('ACCOUNT_UNKNOWN', `account not found: ${canonical}`);
            const allActions = await readOverrideActions(tx, canonical);
            if (allActions.some((a) => a.eventId === eventId)) {
                const snap = await resolveAccountTx(tx, canonical, { at: now(), project: false });
                return { accountId: canonical, action, applied: false, sharedUntil: snap.sharedUntil, revision: snap.revision };
            }
            if (action === 'extend') {
                if (!Number.isInteger(days) || days < 1 || days > 365) throw codedError('DAYS_INVALID', 'days must be an integer 1..365');
            } else if (action === 'set-until') {
                if (!isFiniteMs(until) || until <= now()) throw codedError('UNTIL_INVALID', 'until must be a finite future epoch ms');
            } else if (action !== 'revoke') {
                throw codedError('ACTION_INVALID', `unknown action: ${action}`);
            }
            const lineageIds = await accountIdSet(tx, canonical);
            const affected = await tx.all(
                `SELECT DISTINCT event_id FROM ecosystem_benefits
                 WHERE account_id IN (${placeholders(lineageIds.length)})
                   AND scope IN ('shared','shared_local')`, lineageIds);
            const affectedEvents = affected.map((r) => r.event_id);
            const entry = { action, eventId, actor, eventAt: now(), lineage: canonical, affectedEvents };
            if (action === 'extend') entry.days = days;
            if (action === 'set-until') entry.until = Number(until);
            await insertEvent(tx, {
                eventId, accountId: canonical, sourceKind: 'admin', sourceApp: 'admin', sourceRef: eventId,
                payload: { action, until: entry.until ?? null, days: entry.days ?? null, actor },
            });
            await appendOverrideAction(tx, canonical, entry);
            await refoldSharedLineage(tx, canonical);
            await bumpGlobal(tx, canonical);
            const snap = await resolveAccountTx(tx, canonical, { at: now(), project: true });
            return { accountId: canonical, action, applied: true, sharedUntil: snap.sharedUntil, revision: snap.revision };
        });

    const mergeAccounts = async (targetId, sourceId) =>
        transaction(async (tx) => await mergeAccountsTx(tx, targetId, sourceId));
    const ensureAccount = async (app, identity, opts = {}) =>
        transaction(async (tx) => await ensureAccountTx(tx, app, identity, opts));

    const enqueueVerification = async ({ signature, app, identity } = {}) =>
        transaction(async (tx) => {
            const sig = validateSignature(signature);
            if (!isNonBlank(app) || !own(registry.apps, String(app))) throw codedError('APP_REQUIRED');
            if (!supportedApp(String(app))) throw codedError('APP_VALUE_UNSUPPORTED', `app monthlyValueCents must be a positive integer <= ${SHARED_VALUE_CENTS}: ${app}`);
            const subject = { app: String(app), identity: identity == null ? null : String(identity) };
            const { job, created } = await enqueueJobTx(tx, { signature: sig, subjects: [subject] });
            return { job, enqueued: created };
        });

    const validateLimit = (limit) => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw codedError('LIMIT_INVALID', 'limit must be an integer 1..100');
        return limit;
    };
    const leaseJobs = async ({ limit = 100, leaseMs = 60000 } = {}) =>
        transaction(async (tx) => {
            validateLimit(limit);
            if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw codedError('LEASE_MS_INVALID');
            const rows = await tx.all(
                `SELECT * FROM ecosystem_jobs WHERE state = 'pending' AND next_attempt_at <= ?
                   AND (lease_until IS NULL OR lease_until < ?)
                 ORDER BY next_attempt_at LIMIT ?`, [now(), now(), Number(limit)]);
            const leased = [];
            for (const j of rows) {
                const token = crypto.randomUUID();
                const r = await tx.run(
                    `UPDATE ecosystem_jobs SET lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
                     WHERE job_key = ? AND state = 'pending' AND (lease_until IS NULL OR lease_until < ?)`,
                    [token, now() + Number(leaseMs), now(), j.job_key, now()]);
                if (r.changes > 0) {
                    const fresh = await tx.get(`SELECT * FROM ecosystem_jobs WHERE job_key = ?`, [j.job_key]);
                    leased.push({ ...fresh, leaseToken: token });
                }
            }
            return leased;
        });

    const finishJob = async (job, { errorCode = null, retryable = false } = {}) =>
        transaction(async (tx) => {
            const key = job && job.job_key;
            if (!isNonBlank(key)) throw codedError('JOB_KEY_REQUIRED');
            const cur = await tx.get(`SELECT * FROM ecosystem_jobs WHERE job_key = ?`, [key]);
            if (!cur) throw codedError('JOB_UNKNOWN', `job not found: ${key}`);
            if (!job.leaseToken || cur.lease_token !== job.leaseToken || !(Number(cur.lease_until) >= now())) {
                return { ok: false, code: 'LEASE_MISMATCH', job: cur };
            }
            if (errorCode == null) {
                await tx.run(`UPDATE ecosystem_jobs SET state = 'done', lease_until = NULL, lease_token = NULL, last_error_code = NULL, updated_at = ? WHERE job_key = ?`,
                    [now(), key]);
            } else if (retryable) {
                const attempts = Number(cur.attempts) || 0;
                const backoff = Math.min(900000, 5000 * Math.pow(2, Math.min(attempts, 8)));
                const hash = crypto.createHash('sha256').update(`${cur.reference_id}|${attempts}`).digest();
                const jitter = hash.readUInt32BE(0) % 1000;
                await tx.run(`UPDATE ecosystem_jobs SET state = 'pending', next_attempt_at = ?, lease_until = NULL, lease_token = NULL, last_error_code = ?, updated_at = ? WHERE job_key = ?`,
                    [now() + backoff + jitter, errorCode, now(), key]);
            } else {
                await tx.run(`UPDATE ecosystem_jobs SET state = 'rejected', lease_until = NULL, lease_token = NULL, last_error_code = ?, updated_at = ? WHERE job_key = ?`,
                    [errorCode, now(), key]);
            }
            const fresh = await tx.get(`SELECT * FROM ecosystem_jobs WHERE job_key = ?`, [key]);
            return { ok: true, job: fresh };
        });

    const listJobs = async ({ limit = 100, offset = 0, state } = {}) =>
        readTransaction(async (tx) => {
            validateLimit(limit);
            const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
            if (state) {
                return await tx.all(`SELECT * FROM ecosystem_jobs WHERE state = ? ORDER BY created_at LIMIT ? OFFSET ?`,
                    [String(state), Number(limit), off]);
            }
            return await tx.all(`SELECT * FROM ecosystem_jobs ORDER BY created_at LIMIT ? OFFSET ?`,
                [Number(limit), off]);
        });

    // Legacy ledger absorption: migrateBaseline's semantics applied to rows
    // the baseline could not have seen — credits written to the legacy tables
    // while the core was down (legacy compatibility mode). Must run BEFORE any
    // projection for the identity, otherwise projectAccountTx would overwrite
    // the legacy expiry with the lower core-derived value.
    //
    // Post-baseline rows differ from baseline rows in one crucial way: the
    // cumulative fields (stealthlynk_subs.sub_until, user_plans.expires_at,
    // solana_subscription_credits.expires_after) may already contain
    // core-folded time. They are therefore absorbed as POST-FOLD benefit
    // floors (scope 'local'/'shared' benefit rows at the live value), never as
    // setTimelineBase — a timeline base is folded BEFORE receipts and would
    // double-count receipt time already inside the cumulative value. Every
    // write is compare-then-write under the baseline's own event ids
    // (legacy:pl:<uid>, legacy:plshared:<uid>, legacy:shared:<acct>,
    // legacy:psad:<dev>), so a pass that finds nothing new writes nothing —
    // repeated projections stay byte-identical and revisions stable. A core
    // admin correction still wins via revoked_at / the local-plan cutoff /
    // override actions; a legacy-mode reduction is mirrored to the live value.
    const absorbBenefitExpiry = async (tx, b) => {
        const cur = await tx.get(
            `SELECT expires_at FROM ecosystem_benefits WHERE event_id = ? AND app = ? AND identity = ? AND benefit = ?`,
            [b.eventId, b.app, String(b.identity), b.benefit]);
        const target = b.expiresAt == null ? null : Number(b.expiresAt);
        const curExp = cur ? (cur.expires_at == null ? null : Number(cur.expires_at)) : undefined;
        if (cur && curExp === target) return 0;
        await insertBenefit(tx, b);
        if (cur) await updateBenefitExpiry(tx, {
            eventId: b.eventId, app: b.app, identity: b.identity, benefit: b.benefit, expiresAt: target,
        });
        return 1;
    };

    const absorbLegacyLedgerFor = async (tx, app, identity) => {
        const id = String(identity);
        let changed = 0;
        if (app === 'photolynk') {
            const uid = Number(id);
            if (!Number.isSafeInteger(uid) || uid <= 0) return 0;
            if (!(await tableExists(tx, 'solana_payments')) || !(await tableExists(tx, 'user_plans'))) return 0;
            const member = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = 'photolynk' AND identity = ?`, [id]);
            const acct = member ? member.account_id : null;
            const plan = await tx.get(`SELECT * FROM user_plans WHERE user_id = ?`, [uid]);
            const liveExp = plan && plan.expires_at != null ? Number(plan.expires_at) : null;
            // Verified, non-premium subscription payments the core never saw —
            // but ONLY when the legacy credit's own ledger shows its effect
            // inside the live plan expiry (a real legacy-mode credit writes
            // credits.expires_after = the new user_plans.expires_at). A bare
            // ledger row claiming more than the plan shows was recorded by a
            // path that never credited it — the v2 pipeline owns those; they
            // must never reseed shared time. Premium rows are not sub time.
            if (liveExp != null) {
                const hasCredits = await tableExists(tx, 'solana_subscription_credits');
                const rows = await tx.all(
                    `SELECT p.* FROM solana_payments p
                     ${hasCredits ? `LEFT JOIN solana_subscription_credits c ON c.tx_signature = p.tx_signature` : ''}
                     LEFT JOIN ecosystem_receipts r ON r.signature = p.tx_signature
                     WHERE p.user_id = ? AND r.signature IS NULL
                       AND p.tx_signature IS NOT NULL AND COALESCE(p.verified_at,0) > 0
                       AND COALESCE(p.duration,'') NOT IN ('premium','premium_skr')
                       AND COALESCE(p.tier_gb,0) > 0
                       ${hasCredits ? `AND (c.tx_signature IS NULL OR COALESCE(c.expires_after,0) <= ?)` : ''}`,
                    hasCredits ? [uid, liveExp] : [uid]);
                for (const p of rows) {
                    const productId = `photolynk.storage_${Number(p.tier_gb)}`;
                    if (!own(registry.products, productId)) continue;
                    const ins = await insertReceipt(tx, {
                        signature: p.tx_signature, accountId: acct,
                        app: 'photolynk', productId, duration: p.duration || 'monthly', originIdentity: String(p.user_id),
                        payerWallet: null, token: p.payment_token || null, amountAtomic: null,
                        paidAt: Number(p.created_at) || Number(p.verified_at) || 0,
                        verifiedAt: Number(p.verified_at) || null, policyVersion: 1,
                        appliedAt: Number(p.verified_at) || now(), legacyAccounted: true,
                    });
                    if (ins && ins.changes > 0) changed++;
                }
            }
            if (!acct) return changed;
            const canonical = await canonicalAccount(tx, acct);
            const lineage = await accountIdSet(tx, canonical);
            if (plan) {
                const exp = liveExp;
                const legacyNull = plan.expires_at == null;
                const finite = Number.isFinite(exp) && exp > 0;
                const tier = Number(plan.plan_gb) || 0;
                const unbounded = legacyNull && plan.status === 'active' && tier > 0;
                // The projection writes its own resolved expiry back into
                // user_plans, so a live value only evidences a legacy-mode
                // credit when it EXCEEDS the value the core last projected.
                // Raising only — floors never reduce.
                const proj = await tx.get(
                    `SELECT expires_at FROM ecosystem_projection_state WHERE app = 'photolynk' AND identity = ?`, [id]);
                const projExp = proj && proj.expires_at != null ? Number(proj.expires_at) : -1;
                const genuineRaise = unbounded || (finite && exp > projExp);
                if (genuineRaise) {
                    // Live plan mirror — the baseline's legacy:pl:<uid>
                    // event+benefit shape, kept at the live value so a legacy-
                    // mode credit survives projection. Skip the insert when
                    // the core already covers the live expiry (admin/localplan
                    // paths provide it themselves — no pollution, no drift).
                    const eventId = `legacy:pl:${uid}`;
                    const target = unbounded ? null : exp;
                    const has = await tx.get(
                        `SELECT expires_at FROM ecosystem_benefits WHERE event_id = ? AND app = 'photolynk' AND identity = ? AND benefit = 'storage'`,
                        [eventId, id]);
                    if (has) {
                        const curExp = has.expires_at == null ? null : Number(has.expires_at);
                        if (curExp !== target && (target == null || curExp == null || target > curExp)) {
                            await updateBenefitExpiry(tx, { eventId, app: 'photolynk', identity: id, benefit: 'storage', expiresAt: target });
                            changed++;
                        }
                    } else {
                        const covered = await tx.get(
                            `SELECT 1 AS x FROM ecosystem_benefits b
                             WHERE b.account_id IN (${placeholders(lineage.length)})
                               AND b.app = 'photolynk' AND b.identity = ? AND b.benefit = 'storage'
                               AND b.scope IN ('local','shared_local') AND b.revoked_at IS NULL
                               AND COALESCE(b.expires_at,-1) >= COALESCE(?,9223372036854775807)`,
                            [...lineage, id, target]);
                        if (!covered) {
                            await insertEvent(tx, {
                                eventId, accountId: acct,
                                sourceKind: 'legacy', sourceApp: 'photolynk', sourceRef: id, payload: { plan },
                            });
                            await insertBenefit(tx, {
                                eventId, accountId: acct, app: 'photolynk', identity: id, benefit: 'storage',
                                startsAt: Number(plan.payment_at) || Number(plan.updated_at) || 0,
                                expiresAt: target, tierGb: tier, monthlyValueCents: 0,
                                scope: plan.payment_type === 'ecosystem' ? 'shared_local' : 'local',
                                value: { legacy: true, paymentType: plan.payment_type === 'ad' ? 'ad_claim' : (plan.payment_type || null) },
                            });
                            changed++;
                        }
                    }
                    // Shared floor for ecosystem-qualifying legacy payments —
                    // the baseline seed's gate (latest qualifying legacy
                    // receipt + active plan) emitted as a post-fold shared
                    // benefit at the live expiry. Skipped whenever the shared
                    // view already covers it.
                    const latest = await tx.get(
                        `SELECT product_id FROM ecosystem_receipts
                         WHERE app = 'photolynk' AND origin_identity = ? AND COALESCE(legacy_accounted,0) = 1
                           AND verified_at > 0 AND paid_at > 0
                         ORDER BY paid_at DESC, signature DESC LIMIT 1`, [id]);
                    const latestProduct = latest && own(registry.products, latest.product_id);
                    const qualifies = !!(latestProduct && latestProduct.ecosystem && !latestProduct.premium);
                    // Same pre-core gate as the baseline seed: only a
                    // bindable payment-type plan at the bind tier may feed
                    // the shared floor — ad weeks, admin edits and store
                    // rows stay member-local.
                    const sharedTarget = (qualifies && String(plan.status) === 'active' && exp != null && exp > now()
                        && bindablePlan(plan)) ? exp : 0;
                    if (sharedTarget > 0) {
                        const sharedNow = await tx.get(
                            `SELECT MAX(COALESCE(b.expires_at,0)) AS m FROM ecosystem_benefits b
                             WHERE b.account_id IN (${placeholders(lineage.length)}) AND b.scope = 'shared' AND b.revoked_at IS NULL`,
                            lineage);
                        if (sharedTarget > (Number(sharedNow && sharedNow.m) || 0)) {
                            const sharedEventId = `legacy:plshared:${uid}`;
                            await insertEvent(tx, {
                                eventId: sharedEventId, accountId: acct, sourceKind: 'legacy',
                                sourceApp: 'photolynk', sourceRef: id, payload: { floor: sharedTarget },
                            });
                            changed += await absorbBenefitExpiry(tx, {
                                eventId: sharedEventId, accountId: acct, app: '*', identity: '*',
                                benefit: 'subscription', startsAt: Number(plan.payment_at) || Number(plan.updated_at) || 0,
                                expiresAt: sharedTarget, tierGb: 0, monthlyValueCents: SHARED_VALUE_CENTS,
                                scope: 'shared', value: { legacy: true, floor: true },
                            });
                        }
                    }
                }
            }
            if (changed > 0) {
                await bumpGlobal(tx, acct);
                await refoldSharedLineage(tx, canonical);
            }
            return changed;
        }
        if (app === 'paceseeker') {
            const member = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = 'paceseeker' AND identity = ?`, [id]);
            const acct = member ? member.account_id : null;
            // Chain-checked payments the core never saw — baseline shape:
            // legacy receipt + durable on-chain verify job for real paidAt.
            if (await tableExists(tx, 'paceseeker_revenue')) {
                const rows = await tx.all(
                    `SELECT v.* FROM paceseeker_revenue v
                     LEFT JOIN ecosystem_receipts e ON e.signature = v.signature
                     WHERE v.device_hash = ? AND v.eco_verified = 1 AND v.signature IS NOT NULL
                       AND e.signature IS NULL`, [id]);
                for (const r of rows) {
                    const ins = await insertReceipt(tx, {
                        signature: r.signature, accountId: acct,
                        app: 'paceseeker', productId: 'paceseeker.monthly', duration: 'monthly', originIdentity: id,
                        payerWallet: null, token: null, amountAtomic: null,
                        paidAt: 0, verifiedAt: null, policyVersion: 1,
                        appliedAt: null, legacyAccounted: true,
                        evidence: {
                            reported: {
                                paidAt: r.paid_at == null ? null : Number(r.paid_at) || null,
                                reportedAt: r.reported_at == null ? null : Number(r.reported_at) || null,
                                paidWith: r.paid_with || null,
                                plan: r.plan || null,
                                usdAtCheckout: r.usd_at_checkout == null ? null : Number(r.usd_at_checkout) || null,
                                amountAtomic: r.amount_atomic == null ? null : String(r.amount_atomic),
                            },
                        },
                    });
                    await enqueueJobTx(tx, {
                        signature: r.signature,
                        subjects: [{ app: 'paceseeker', identity: id, wallet: null }],
                        errorCode: null,
                    });
                    if (ins && ins.changes > 0) changed++;
                }
            }
            if (!acct) return changed;
            const canonical = await canonicalAccount(tx, acct);
            const lineage = await accountIdSet(tx, canonical);
            // Trusted shared-sub floor — every legacy mirror path writes
            // stealthlynk_subs. Rows with source_kind='subscription' are the
            // core's own projection output (their value is already inside the
            // fold) and are skipped unconditionally. The device row's
            // client-reported sub_until is deliberately not read here either —
            // the baseline never trusted it.
            if (await tableExists(tx, 'stealthlynk_subs')) {
                const s = await tx.get(`SELECT * FROM stealthlynk_subs WHERE account_id = ?`, [acct]);
                if (s && String(s.source_kind || '') !== 'subscription') {
                    const eventId = `legacy:shared:${acct}`;
                    const kind = s.source_kind || 'legacy';
                    const subUntil = Number(s.sub_until);
                    if (kind === 'revoke') {
                        await insertEvent(tx, {
                            eventId, accountId: acct, sourceKind: 'legacy',
                            sourceApp: s.source_app || null, sourceRef: s.provenance || null, payload: { subs: s },
                        });
                        const affected = await tx.all(
                            `SELECT DISTINCT event_id FROM ecosystem_benefits WHERE account_id = ? AND scope IN ('shared','shared_local')`, [acct]);
                        await appendOverrideAction(tx, acct, {
                            action: 'revoke', eventId, actor: 'legacy', eventAt: now(), lineage: acct,
                            affectedEvents: affected.map((x) => x.event_id),
                        });
                        changed++;
                    } else if (kind === 'ad_claim') {
                        if (Number.isFinite(subUntil) && subUntil > 0) {
                            await insertEvent(tx, {
                                eventId, accountId: acct, sourceKind: 'ad_claim',
                                sourceApp: s.source_app || null, sourceRef: s.provenance || null, payload: { subs: s },
                            });
                            const targetApp = s.source_app === 'paceseeker' || s.source_app === 'photolynk' ? s.source_app : null;
                            const claims = await tableExists(tx, 'ad_claims')
                                ? await tx.all(`SELECT * FROM ad_claims WHERE account_id = ?`, [acct]) : [];
                            for (const m of await tx.all(`SELECT app, identity FROM ecosystem_members WHERE account_id = ?`, [acct])) {
                                const appDef = supportedApp(m.app);
                                if (!appDef) continue;
                                if (targetApp && m.app !== targetApp) continue;
                                const claimTier = (claims.find((c) => c.app === m.app) || claims[0] || {}).tier_gb;
                                const tier = appDef.benefit === 'storage' ? Math.min(Number(claimTier) || 100, AD_MAX_TIER_GB) : 0;
                                changed += await absorbBenefitExpiry(tx, {
                                    eventId, accountId: acct, app: m.app, identity: String(m.identity),
                                    benefit: appDef.benefit, startsAt: Number(s.updated_at) || 0,
                                    expiresAt: subUntil, tierGb: tier,
                                    monthlyValueCents: 0, scope: 'local', value: { legacy: true, source: 'ad_claim' },
                                });
                            }
                        }
                    } else if (Number.isFinite(subUntil) && subUntil > 0) {
                        // Post-fold shared floor at the live value — skipped
                        // when the shared view already covers it (the fold
                        // itself produced it or a newer value is present).
                        const sharedNow = await tx.get(
                            `SELECT MAX(COALESCE(b.expires_at,0)) AS m FROM ecosystem_benefits b
                             WHERE b.account_id IN (${placeholders(lineage.length)}) AND b.scope = 'shared' AND b.revoked_at IS NULL`,
                            lineage);
                        if (subUntil > (Number(sharedNow && sharedNow.m) || 0)) {
                            await insertEvent(tx, {
                                eventId, accountId: acct, sourceKind: 'legacy',
                                sourceApp: s.source_app || null, sourceRef: s.provenance || null, payload: { subs: s },
                            });
                            changed += await absorbBenefitExpiry(tx, {
                                eventId, accountId: acct, app: '*', identity: '*',
                                benefit: 'subscription', startsAt: Number(s.updated_at) || 0,
                                expiresAt: subUntil, tierGb: 0, monthlyValueCents: SHARED_VALUE_CENTS,
                                scope: 'shared', value: { legacy: true, floor: true },
                            });
                        }
                    }
                }
            }
            // Server-granted ad weeks — device ad_until mirror, baseline shape.
            if (await tableExists(tx, 'paceseeker_devices')) {
                const d = await tx.get(`SELECT ad_until FROM paceseeker_devices WHERE device_hash = ?`, [id]);
                if (d && Number(d.ad_until) > 0) {
                    const eventId = `legacy:psad:${id}`;
                    await insertEvent(tx, {
                        eventId, accountId: acct, sourceKind: 'ad_claim', sourceApp: 'paceseeker',
                        sourceRef: id, payload: { adUntil: Number(d.ad_until) },
                    });
                    changed += await absorbBenefitExpiry(tx, {
                        eventId, accountId: acct, app: 'paceseeker', identity: id,
                        benefit: 'features', startsAt: 0, expiresAt: Number(d.ad_until),
                        tierGb: 0, monthlyValueCents: 0, scope: 'local', value: { legacy: true, source: 'ad_claim' },
                    });
                }
            }
            if (changed > 0) {
                await bumpGlobal(tx, acct);
                await refoldSharedLineage(tx, canonical);
            }
            return changed;
        }
        return 0;
    };

    // Bounded page over recent legacy rows missing a core receipt — driven by
    // the worker pass and by the one-shot recovery sweep after initialize().
    const absorbLegacyLedgerPage = async ({ limit = 50 } = {}) =>
        transaction(async (tx) => {
            const lim = Math.max(1, Math.min(500, Number(limit) || 50));
            let n = 0;
            if (await tableExists(tx, 'solana_payments')) {
                const rows = await tx.all(
                    `SELECT DISTINCT p.user_id AS uid FROM solana_payments p
                     LEFT JOIN ecosystem_receipts e ON e.signature = p.tx_signature
                     WHERE e.signature IS NULL AND p.tx_signature IS NOT NULL
                       AND COALESCE(p.verified_at,0) > 0
                       AND COALESCE(p.duration,'') NOT IN ('premium','premium_skr')
                       AND COALESCE(p.tier_gb,0) > 0
                     ORDER BY p.created_at DESC LIMIT ?`, [lim]);
                for (const r of rows) n += await absorbLegacyLedgerFor(tx, 'photolynk', String(r.uid));
            }
            if (await tableExists(tx, 'paceseeker_revenue')) {
                const rows = await tx.all(
                    `SELECT DISTINCT v.device_hash AS dev FROM paceseeker_revenue v
                     LEFT JOIN ecosystem_receipts e ON e.signature = v.signature
                     WHERE e.signature IS NULL AND v.eco_verified = 1
                     ORDER BY v.reported_at DESC LIMIT ?`, [lim]);
                for (const r of rows) n += await absorbLegacyLedgerFor(tx, 'paceseeker', String(r.dev));
            }
            if (await tableExists(tx, 'stealthlynk_subs')) {
                const rows = await tx.all(
                    `SELECT DISTINCT m.app, m.identity FROM stealthlynk_subs s
                     JOIN ecosystem_members m ON m.account_id = s.account_id
                     WHERE COALESCE(s.sub_until,0) > 0 AND COALESCE(s.source_kind,'') <> 'subscription'
                     ORDER BY s.updated_at DESC LIMIT ?`, [lim]);
                for (const r of rows) n += await absorbLegacyLedgerFor(tx, r.app, String(r.identity));
            }
            return n;
        });

    const migrateBaseline = async (tx) => {
        const memberAccount = async (app, identity) => {
            const m = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = ? AND identity = ?`, [app, String(identity)]);
            return m ? m.account_id : null;
        };
        const claimsByAccount = new Map();
        if (await tableExists(tx, 'ad_claims')) {
            for (const c of await tx.all(`SELECT * FROM ad_claims`)) {
                if (!claimsByAccount.has(c.account_id)) claimsByAccount.set(c.account_id, []);
                claimsByAccount.get(c.account_id).push(c);
            }
        }
        if (await tableExists(tx, 'user_plans')) {
            for (const row of await tx.all(`SELECT * FROM user_plans`)) {
                const uid = row.user_id;
                const exp = row.expires_at == null ? null : Number(row.expires_at);
                const legacyNull = row.expires_at == null;
                const finite = Number.isFinite(exp) && exp > 0;
                const tier = Number(row.plan_gb) || 0;
                const unbounded = legacyNull && row.status === 'active' && tier > 0;
                if (!unbounded && !finite) continue;
                const eventId = `legacy:pl:${uid}`;
                await insertEvent(tx, {
                    eventId, accountId: await memberAccount('photolynk', uid),
                    sourceKind: 'legacy', sourceApp: 'photolynk', sourceRef: String(uid), payload: { plan: row },
                });
                await insertBenefit(tx, {
                    eventId, accountId: await memberAccount('photolynk', uid),
                    app: 'photolynk', identity: String(uid), benefit: 'storage',
                    startsAt: Number(row.payment_at) || Number(row.updated_at) || 0,
                    expiresAt: unbounded ? null : exp,
                    tierGb: tier, monthlyValueCents: 0,
                    scope: row.payment_type === 'ecosystem' ? 'shared_local' : 'local',
                    value: { legacy: true, paymentType: row.payment_type === 'ad' ? 'ad_claim' : (row.payment_type || null) },
                });
            }
        }
        if (await tableExists(tx, 'stealthlynk_subs')) {
            for (const row of await tx.all(`SELECT * FROM stealthlynk_subs`)) {
                const acct = row.account_id;
                const eventId = `legacy:shared:${acct}`;
                const kind = row.source_kind || 'legacy';
                await insertEvent(tx, {
                    eventId, accountId: acct, sourceKind: kind === 'ad_claim' ? 'ad_claim' : 'legacy', sourceApp: row.source_app || null,
                    sourceRef: row.provenance || null, payload: { subs: row },
                });
                if (kind === 'revoke') {
                    const affected = await tx.all(
                        `SELECT DISTINCT event_id FROM ecosystem_benefits WHERE account_id = ? AND scope IN ('shared','shared_local')`, [acct]);
                    await appendOverrideAction(tx, acct, {
                        action: 'revoke', eventId, actor: 'legacy', eventAt: now(), lineage: acct,
                        affectedEvents: affected.map((x) => x.event_id),
                    });
                    continue;
                }
                const subUntil = Number(row.sub_until);
                if (!Number.isFinite(subUntil) || subUntil <= 0) continue;
                if (kind === 'ad_claim') {
                    const targetApp = row.source_app === 'paceseeker' || row.source_app === 'photolynk' ? row.source_app : null;
                    const members = await tx.all(`SELECT app, identity, account_id FROM ecosystem_members WHERE account_id = ?`, [acct]);
                    const claims = claimsByAccount.get(acct) || [];
                    for (const m of members) {
                        const appDef = supportedApp(m.app);
                        if (!appDef) continue;
                        if (targetApp && m.app !== targetApp) continue;
                        const claimTier = (claims.find((c) => c.app === m.app) || claims[0] || {}).tier_gb;
                        const tier = appDef.benefit === 'storage' ? Math.min(Number(claimTier) || 100, AD_MAX_TIER_GB) : 0;
                        await insertBenefit(tx, {
                            eventId, accountId: acct, app: m.app, identity: String(m.identity),
                            benefit: appDef.benefit, startsAt: Number(row.updated_at) || 0,
                            expiresAt: subUntil, tierGb: tier,
                            monthlyValueCents: 0, scope: 'local', value: { legacy: true, source: 'ad_claim' },
                        });
                    }
                    continue;
                }
                await setTimelineBase(tx, acct, subUntil);
            }
        }
        if (await tableExists(tx, 'paceseeker_devices')) {
            for (const d of await tx.all(`SELECT device_hash, ad_until FROM paceseeker_devices WHERE ad_until IS NOT NULL AND ad_until > 0`)) {
                const acct = await memberAccount('paceseeker', d.device_hash);
                const eventId = `legacy:psad:${d.device_hash}`;
                await insertEvent(tx, {
                    eventId, accountId: acct, sourceKind: 'ad_claim', sourceApp: 'paceseeker',
                    sourceRef: String(d.device_hash), payload: { adUntil: Number(d.ad_until) },
                });
                await insertBenefit(tx, {
                    eventId, accountId: acct, app: 'paceseeker', identity: String(d.device_hash),
                    benefit: 'features', startsAt: 0, expiresAt: Number(d.ad_until),
                    tierGb: 0, monthlyValueCents: 0, scope: 'local', value: { legacy: true, source: 'ad_claim' },
                });
            }
        }
        if (await tableExists(tx, 'solana_payments')) {
            for (const p of await tx.all(`SELECT * FROM solana_payments`)) {
                const premium = p.duration === 'premium' || p.duration === 'premium_skr' || Number(p.tier_gb) === 0;
                const productId = premium ? 'photolynk.premium' : `photolynk.storage_${Number(p.tier_gb)}`;
                const dur = premium ? 'premium' : (p.duration || 'monthly');
                const appliedAt = premium
                    ? (p.entitlement_applied_at == null ? null : Number(p.entitlement_applied_at))
                    : (Number(p.verified_at) || now());
                await insertReceipt(tx, {
                    signature: p.tx_signature, accountId: await memberAccount('photolynk', p.user_id),
                    app: 'photolynk', productId, duration: dur, originIdentity: String(p.user_id),
                    payerWallet: null, token: p.payment_token || null, amountAtomic: null,
                    paidAt: Number(p.created_at) || Number(p.verified_at) || 0,
                    verifiedAt: Number(p.verified_at) || null, policyVersion: 1,
                    appliedAt, legacyAccounted: true,
                });
            }
        }
        if (await tableExists(tx, 'paceseeker_revenue')) {
            for (const r of await tx.all(`SELECT * FROM paceseeker_revenue WHERE eco_verified = 1`)) {
                const existing = await tx.get(`SELECT signature FROM ecosystem_receipts WHERE signature = ?`, [r.signature]);
                if (existing) {
                    await recordConflict(tx, r.signature, 'paceseeker', r.device_hash, 'cross-app duplicate signature');
                    continue;
                }
                const acct = await memberAccount('paceseeker', r.device_hash);
                await insertReceipt(tx, {
                    signature: r.signature, accountId: acct,
                    app: 'paceseeker', productId: 'paceseeker.monthly', duration: 'monthly', originIdentity: String(r.device_hash),
                    payerWallet: null, token: null, amountAtomic: null,
                    paidAt: 0, verifiedAt: null, policyVersion: 1,
                    appliedAt: null, legacyAccounted: true,
                    evidence: {
                        reported: {
                            paidAt: r.paid_at == null ? null : Number(r.paid_at) || null,
                            reportedAt: r.reported_at == null ? null : Number(r.reported_at) || null,
                            paidWith: r.paid_with || null,
                            plan: r.plan || null,
                            usdAtCheckout: r.usd_at_checkout == null ? null : Number(r.usd_at_checkout) || null,
                            amountAtomic: r.amount_atomic == null ? null : String(r.amount_atomic),
                        },
                    },
                });
                await enqueueJobTx(tx, {
                    signature: r.signature,
                    subjects: [{ app: 'paceseeker', identity: String(r.device_hash), wallet: null }],
                    errorCode: null,
                });
            }
        }
        if (await tableExists(tx, 'solana_wallet_bindings') && await tableExists(tx, 'ecosystem_members')) {
            for (const b of await tx.all(`SELECT * FROM solana_wallet_bindings`)) {
                const m = await tx.get(`SELECT account_id, wallet FROM ecosystem_members WHERE app = 'photolynk' AND identity = ?`, [String(b.user_id)]);
                if (!m) continue;
                await tx.run(`INSERT OR IGNORE INTO ecosystem_member_proofs (app,identity,wallet,kind,reference,verified_at) VALUES (?,?,?,?,?,?)`,
                    ['photolynk', String(b.user_id), b.wallet, 'bind', 'solana_wallet_bindings', Number(b.verified_at) || now()]);
                await tx.run(`UPDATE ecosystem_members SET wallet = COALESCE(wallet, ?), wallet_verified = 1 WHERE app = 'photolynk' AND identity = ?`,
                    [b.wallet, String(b.user_id)]);
            }
        }
        if (await tableExists(tx, 'ecosystem_members')) {
            for (const m of await tx.all(`SELECT app, identity, wallet, wallet_verified FROM ecosystem_members WHERE app = 'paceseeker' AND wallet_verified = 1 AND wallet IS NOT NULL`)) {
                await tx.run(`INSERT OR IGNORE INTO ecosystem_member_proofs (app,identity,wallet,kind,reference,verified_at) VALUES (?,?,?,?,?,?)`,
                    ['paceseeker', String(m.identity), m.wallet, 'bind', 'legacy_wallet_verified', now()]);
            }
        }
        if (await tableExists(tx, 'ecosystem_members') && await tableExists(tx, 'user_plans') && await tableExists(tx, 'solana_payments')) {
            const plMembers = await tx.all(`SELECT account_id, identity FROM ecosystem_members WHERE app = 'photolynk'`);
            for (const m of plMembers) {
                const shared = await tx.get(
                    `SELECT 1 AS x FROM ecosystem_timelines WHERE account_id = ? AND base_at > 0 LIMIT 1`, [m.account_id]);
                if (shared) continue;
                await seedPlSharedFloor(tx, m.account_id, Number(m.identity));
            }
        }
        // Legacy ad-claim grant accounting: a claim whose own created_at sits
        // INSIDE a frozen ad-derived entitlement — the device's
        // paceseeker_devices.ad_until, the account's shared ad_claim
        // sub_until, or a member's legacy payment_type='ad' user_plans row —
        // was already issued by the legacy code. Stamp granted_at =
        // created_at so the repair worker never manufactures a second week.
        // Ambiguous claims stay NULL and remain eligible for repair.
        if (await tableExists(tx, 'ad_claims') && await tableExists(tx, 'ecosystem_members')) {
            const hasDevices = await tableExists(tx, 'paceseeker_devices');
            const hasPlans = await tableExists(tx, 'user_plans');
            const hasSubs = await tableExists(tx, 'stealthlynk_subs');
            for (const c of await tx.all(`SELECT * FROM ad_claims WHERE granted_at IS NULL`)) {
                const created = Number(c.created_at) || 0;
                if (created <= 0) continue;
                let accounted = false;
                const claimApp = c.app || null;
                const members = await tx.all(`SELECT app, identity FROM ecosystem_members WHERE account_id = ?`, [c.account_id]);
                for (const m of members) {
                    if (claimApp && m.app !== claimApp) continue;
                    if (m.app === 'paceseeker' && hasDevices) {
                        const d = await tx.get(`SELECT ad_until FROM paceseeker_devices WHERE device_hash = ?`, [String(m.identity)]);
                        if (Number(d && d.ad_until) > created) { accounted = true; break; }
                    }
                    if (m.app === 'photolynk' && hasPlans) {
                        const p = await tx.get(`SELECT expires_at FROM user_plans WHERE user_id = ? AND payment_type = 'ad'`, [Number(m.identity)]);
                        if (Number(p && p.expires_at) > created) { accounted = true; break; }
                    }
                }
                if (!accounted && hasSubs) {
                    const s = await tx.get(`SELECT sub_until FROM stealthlynk_subs WHERE account_id = ? AND source_kind = 'ad_claim'`, [c.account_id]);
                    if (Number(s && s.sub_until) > created) accounted = true;
                }
                if (accounted) {
                    await tx.run(`UPDATE ad_claims SET granted_at = ? WHERE id = ? AND granted_at IS NULL`, [created, c.id]);
                }
            }
        }
        await refoldAllShared(tx);
        const memberRows = await tx.all(`SELECT account_id, app, identity FROM ecosystem_members`);
        for (const m of memberRows) {
            await refoldLocalMember(tx, m.account_id, m.app, m.identity);
        }
    };

    const initialize = async () =>
        transaction(async (tx) => {
            if ((await tableExists(tx, 'ecosystem_timelines')) && !(await columnExists(tx, 'ecosystem_timelines', 'timeline_id'))) {
                throw codedError('SCHEMA_VERSION_UNSUPPORTED', 'ecosystem_timelines has an unknown shape; refusing to migrate destructively');
            }
            for (const ddl of SCHEMA_DDL) await tx.run(ddl);
            if (!(await columnExists(tx, 'ecosystem_receipts', 'duration'))) {
                await tx.run(`ALTER TABLE ecosystem_receipts ADD COLUMN duration TEXT`);
            }
            if (!(await columnExists(tx, 'ecosystem_projection_state', 'source_kind'))) {
                await tx.run(`ALTER TABLE ecosystem_projection_state ADD COLUMN source_kind TEXT`);
            }
            if (await tableExists(tx, 'paceseeker_devices')) {
                await tx.run(`CREATE INDEX IF NOT EXISTS idx_paceseeker_devices_last_seen ON paceseeker_devices(last_seen)`);
            }
            const meta = await tx.get(`SELECT value FROM ecosystem_meta WHERE key = 'baseline_v2'`);
            if (meta) return { initialized: true, migrated: false };
            await migrateBaseline(tx);
            await tx.run(`INSERT INTO ecosystem_meta (key,value) VALUES ('baseline_v2', ?)`, [String(now())]);
            await tx.run(`INSERT OR IGNORE INTO ecosystem_meta (key,value) VALUES ('snapshot_time', ?)`, [String(now())]);
            await tx.run(`INSERT OR IGNORE INTO ecosystem_meta (key,value) VALUES ('global_revision', '0')`, []);
            return { initialized: true, migrated: true };
        });

    // Explicit authorized-source local plan write. An ADMIN edit is a
    // direct-plan replacement of all prior local/shared_local PhotoLynk
    // sources for the user: it revokes them, writes a durable per-user
    // correction cutoff (so pre-cutoff receipts folded later grant no local
    // time), and records the event even for status-only, shortening,
    // inactive, expired, deleted, none or zero-quota results. A positive
    // benefit is created only for a genuinely active positive quota - null
    // expiry is unbounded ONLY under an explicit 'active' admin result.
    // Verified STORE purchases are independent positive finite grants: they
    // keep the strict positive/finite contract and never write the cutoff.
    // Premium fields are never touched and duplicate event ids never
    // re-extend. sharedEligible is honored only for store at a binding tier.
    const recordLocalPlanInTransaction = async (tx, { userId, eventId, kind = 'admin', actor = null, plan = {}, sharedEligible = false } = {}) => {
        const uid = Number(userId);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw codedError('USER_INVALID', 'userId must be a positive integer');
        if (!isNonBlank(eventId)) throw codedError('EVENT_ID_REQUIRED', 'eventId is required');
        const planGb = Number(plan && plan.planGb) || 0;
        const expiresAt = plan && plan.expiresAt == null ? null : Number(plan.expiresAt);
        const status = String(plan && plan.status || '').trim().toLowerCase();
        const srcKind = kind === 'store' ? 'store' : 'admin';
        if (srcKind === 'store') {
            if (!(planGb > 0)) throw codedError('PLAN_INVALID', 'plan requires a positive planGb');
            if (!(expiresAt > 0)) throw codedError('PLAN_INVALID', 'plan requires a finite expiresAt');
        } else if (expiresAt != null && !(Number.isFinite(expiresAt) && expiresAt > 0)) {
            throw codedError('PLAN_INVALID', 'expiresAt must be a positive timestamp or null');
        }
        const startsAt = isFiniteMs(plan && plan.startsAt) ? Number(plan.startsAt) : now();
        const evtId = `localplan:${String(eventId)}`;
        const member = await tx.get(`SELECT account_id FROM ecosystem_members WHERE app = 'photolynk' AND identity = ?`, [String(uid)]);
        const accountId = member ? member.account_id : await ensureAccountTx(tx, 'photolynk', String(uid), {});
        if (member) await attachOrphans(tx, accountId, 'photolynk', String(uid));
        const prior = await eventExists(tx, evtId);
        if (!prior) {
            if (srcKind === 'admin') {
                // Scoped local correction: revoke every prior local and
                // shared_local source started at-or-before now, then write
                // the cutoff marker refoldLocalMember enforces for
                // late-arriving receipts. Shared account benefits and
                // premium rows are independent and untouched.
                const correctionAt = now();
                await tx.run(
                    `UPDATE ecosystem_benefits SET revoked_at = ?
                     WHERE app = 'photolynk' AND identity = ?
                       AND scope IN ('local','shared_local') AND revoked_at IS NULL
                       AND starts_at <= ?`,
                    [correctionAt, String(uid), correctionAt]);
                await tx.run(
                    `INSERT INTO ecosystem_meta (key,value) VALUES (?,?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                    [`local-plan-cutoff:photolynk:${uid}`, JSON.stringify({ eventId: evtId, at: correctionAt })]);
            }
            await insertEvent(tx, {
                eventId: evtId, accountId, sourceKind: srcKind, sourceApp: 'photolynk', sourceRef: String(eventId),
                payload: { userId: uid, actor: actor || null, planGb, status: status || null, startsAt, expiresAt },
            });
            // A store purchase is always an active paid grant. For admin,
            // 'genuinely active' = explicit active status, or the caller
            // passed no status with a positive quota (legacy callers).
            const activeResult = srcKind === 'store' ? true
                : (status === 'active' || (status === '' && planGb > 0));
            if (planGb > 0 && activeResult) {
                await insertBenefit(tx, {
                    eventId: evtId, accountId, app: 'photolynk', identity: String(uid), benefit: 'storage',
                    startsAt, expiresAt: srcKind === 'store' ? expiresAt : (expiresAt > 0 ? expiresAt : null),
                    tierGb: planGb, monthlyValueCents: 0, scope: 'local',
                    value: { source: srcKind, actor: actor || null },
                });
            }
            if (sharedEligible && srcKind === 'store' && planGb >= 400) {
                const shId = `localplan_shared:${String(eventId)}`;
                await insertEvent(tx, {
                    eventId: shId, accountId, sourceKind: 'store', sourceApp: 'photolynk', sourceRef: String(eventId),
                    payload: { userId: uid, actor: actor || null, planGb, startsAt, expiresAt },
                });
                await insertBenefit(tx, {
                    eventId: shId, accountId, app: 'photolynk', identity: String(uid), benefit: 'storage',
                    startsAt, expiresAt, tierGb: planGb, monthlyValueCents: SHARED_VALUE_CENTS, scope: 'shared',
                    value: { source: 'store', actor: actor || null },
                });
            }
            await bumpGlobal(tx, accountId);
        }
        await refoldLocalMember(tx, accountId, 'photolynk', uid);
        const snap = await snapshotFor(tx, accountId, now(), { app: 'photolynk', identity: String(uid) });
        return { ...snap, alreadyRecorded: !!prior };
    };

    return {
        initialize,
        transaction,
        readTransaction,
        ensureAccount,
        mergeAccounts,
        applyPhotolynkInTransaction,
        claimPremiumInTransaction,
        consumeQuoteInTransaction,
        recordLocalPlanInTransaction,
        ensureAccountInTransaction: ensureAccountTx,
        markPremiumApplied,
        applyPaceSeekerPayment,
        resolveIdentity,
        resolveAccount,
        grantAdClaim,
        adjustShared,
        enqueueVerification,
        absorbLegacyLedgerPage,
        leaseJobs,
        finishJob,
        listJobs,
    };
}

module.exports = { createEcosystemService, DEFAULT_REGISTRY, DAY_MS };
