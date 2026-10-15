'use strict';

const runAsync = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});

const allAsync = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});

const PS_DEVICE_COLUMNS = {
    sub_status: 'TEXT',
    sub_until: 'INTEGER',
    last_country_code: 'TEXT',
    sub_signature: 'TEXT',
    sub_paid_at: 'INTEGER',
    sub_paid_with: 'TEXT',
    sub_plan: 'TEXT',
    sub_usd: 'REAL',
    sub_amount_atomic: 'INTEGER',
    wallet_address: 'TEXT',
    wallet_domain: 'TEXT',
    ad_until: 'INTEGER',
    reported_sub_until: 'INTEGER',
};

const PS_REVENUE_COLUMNS = {
    eco_verified: 'INTEGER DEFAULT 0',
};

const LN_DEVICE_COLUMNS = {
    sub_status: 'TEXT',
    sub_until: 'INTEGER',
    sub_signature: 'TEXT',
    sub_paid_at: 'INTEGER',
    sub_paid_with: 'TEXT',
    sub_plan: 'TEXT',
    sub_usd: 'REAL',
    sub_amount_atomic: 'INTEGER',
    wallet_address: 'TEXT',
    reported_sub_until: 'INTEGER',
    // Server-mirrored free-tier ledger: calendar month key + used-day count
    // reported by the client (telemetry - the device ledger is authoritative
    // for gating; this copy exists for abuse review and future enforcement).
    usage_month: 'TEXT',
    usage_days: 'INTEGER DEFAULT 0',
};

const LN_REVENUE_COLUMNS = {
    eco_verified: 'INTEGER DEFAULT 0',
};

const REQUIRED_COLUMNS = {
    ecosystem_members: ['account_id', 'app', 'identity', 'wallet', 'wallet_verified', 'wallet_changed_at'],
    ecosystem_accounts: ['account_id'],
    stealthlynk_subs: ['account_id', 'sub_until'],
    user_plans: ['user_id', 'status', 'plan_gb', 'expires_at', 'premium_gb', 'premium_expires_at', 'deleted_at', 'grace_until', 'trial_until', 'updated_at'],
    solana_payments: ['tx_signature', 'user_id', 'entitlement_applied_at'],
};

const tableColumns = async (db, table) => {
    const rows = await allAsync(db, `PRAGMA table_info(${table})`);
    return new Set((rows || []).map((c) => c.name));
};

const ensureColumns = async (db, table, whitelist) => {
    let cols = await tableColumns(db, table);
    for (const [name, def] of Object.entries(whitelist)) {
        if (cols.has(name)) continue;
        try {
            await runAsync(db, `ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
            cols.add(name);
        } catch (err) {
            cols = await tableColumns(db, table);
            const duplicate = err && /duplicate column/i.test(String(err.message || ''));
            if (duplicate && cols.has(name)) continue;
            throw err;
        }
    }
};

const ensurePaceSeekerSchema = async (db) => {
    await runAsync(db, `CREATE TABLE IF NOT EXISTS paceseeker_devices (
        device_hash TEXT PRIMARY KEY,
        first_seen INTEGER,
        last_seen INTEGER,
        trial_started_at INTEGER,
        trial_expires_at INTEGER,
        version_code INTEGER,
        last_ip TEXT,
        ad_until INTEGER
    )`);
    await runAsync(db, `CREATE TABLE IF NOT EXISTS paceseeker_revenue (
        signature TEXT PRIMARY KEY,
        device_hash TEXT,
        paid_at INTEGER,
        paid_with TEXT,
        plan TEXT,
        usd_at_checkout REAL,
        amount_atomic INTEGER,
        reported_at INTEGER,
        eco_verified INTEGER DEFAULT 0
    )`);
    await ensureColumns(db, 'paceseeker_devices', PS_DEVICE_COLUMNS);
    await ensureColumns(db, 'paceseeker_revenue', PS_REVENUE_COLUMNS);
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
        const cols = await tableColumns(db, table);
        for (const name of required) {
            if (!cols.has(name)) throw new Error(`required column ${table}.${name} missing`);
        }
    }
};

const ensureLaneSchema = async (db) => {
    await runAsync(db, `CREATE TABLE IF NOT EXISTS lane_devices (
        device_hash TEXT PRIMARY KEY,
        first_seen INTEGER,
        last_seen INTEGER,
        trial_started_at INTEGER,
        version_code INTEGER,
        last_ip TEXT
    )`);
    await runAsync(db, `CREATE TABLE IF NOT EXISTS lane_revenue (
        signature TEXT PRIMARY KEY,
        device_hash TEXT,
        paid_at INTEGER,
        paid_with TEXT,
        plan TEXT,
        usd_at_checkout REAL,
        amount_atomic INTEGER,
        reported_at INTEGER,
        eco_verified INTEGER DEFAULT 0
    )`);
    await ensureColumns(db, 'lane_devices', LN_DEVICE_COLUMNS);
    await ensureColumns(db, 'lane_revenue', LN_REVENUE_COLUMNS);
};

const createSubscriptionReadiness = () => {
    let settled = false;
    let resolveWait;
    const wait = new Promise((resolve) => { resolveWait = resolve; });
    const finish = (err) => {
        if (settled) return;
        settled = true;
        resolveWait(err || null);
    };
    const middleware = async (req, res, next) => {
        const err = await wait;
        if (err) {
            return res.status(503).json({ code: 'SUBSCRIPTION_SCHEMA_UNAVAILABLE', error: 'Subscription service unavailable' });
        }
        return next();
    };
    return { wait, finish, middleware };
};

module.exports = { ensurePaceSeekerSchema, ensureLaneSchema, createSubscriptionReadiness };
