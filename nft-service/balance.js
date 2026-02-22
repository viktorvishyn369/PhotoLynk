// NFT Credit Balance Management
// Tracks user balances for NFT minting (purchased via in-app purchases)
// Uses SQLite for persistence

const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('./config');

let db = null;

/**
 * Initialize the SQLite database and create tables if needed
 */
function init() {
  if (db) return;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS nft_balances (
      user_id INTEGER PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      total_purchased_usd REAL NOT NULL DEFAULT 0,
      total_spent_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nft_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,           -- 'credit' (purchase) | 'debit' (mint) | 'refund'
      amount_usd REAL NOT NULL,
      description TEXT,
      mint_address TEXT,            -- populated for debit (mint) transactions
      tx_signature TEXT,            -- Solana transaction signature
      metadata TEXT,                -- JSON blob for extra info
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nft_tx_user ON nft_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_nft_tx_type ON nft_transactions(user_id, type);
  `);

  console.log('[NFT Balance] Database initialized:', DB_PATH);
}

/**
 * Get user's current NFT credit balance
 * @param {number} userId
 * @returns {{ balanceUsd: number, totalPurchased: number, totalSpent: number }}
 */
function getBalance(userId) {
  init();
  const row = db.prepare('SELECT balance_usd, total_purchased_usd, total_spent_usd FROM nft_balances WHERE user_id = ?').get(userId);
  if (!row) {
    return { balanceUsd: 0, totalPurchased: 0, totalSpent: 0 };
  }
  return {
    balanceUsd: row.balance_usd,
    totalPurchased: row.total_purchased_usd,
    totalSpent: row.total_spent_usd,
  };
}

/**
 * Add credit to user's balance (after in-app purchase)
 * @param {number} userId
 * @param {number} amountUsd - Amount in USD (e.g. 10.00 for a $10 package)
 * @param {string} description - e.g. 'NFT Package $10' or receipt ID
 * @returns {{ balanceUsd: number }}
 */
function addCredit(userId, amountUsd, description = '') {
  init();
  if (amountUsd <= 0) throw new Error('Credit amount must be positive');

  const txn = db.transaction(() => {
    // Upsert balance
    db.prepare(`
      INSERT INTO nft_balances (user_id, balance_usd, total_purchased_usd, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        balance_usd = balance_usd + ?,
        total_purchased_usd = total_purchased_usd + ?,
        updated_at = datetime('now')
    `).run(userId, amountUsd, amountUsd, amountUsd, amountUsd);

    // Record transaction
    db.prepare(`
      INSERT INTO nft_transactions (user_id, type, amount_usd, description)
      VALUES (?, 'credit', ?, ?)
    `).run(userId, amountUsd, description);
  });

  txn();

  const balance = getBalance(userId);
  console.log(`[NFT Balance] Credit: user=${userId} +$${amountUsd.toFixed(2)} → $${balance.balanceUsd.toFixed(2)}`);
  return balance;
}

/**
 * Deduct from user's balance (after successful NFT mint)
 * @param {number} userId
 * @param {number} amountUsd - Cost of the mint in USD
 * @param {string} mintAddress - On-chain mint address or cNFT asset ID
 * @param {string} txSignature - Solana transaction signature
 * @param {string} description - e.g. 'cNFT mint: My Photo'
 * @returns {{ balanceUsd: number, success: boolean, error?: string }}
 */
function deductBalance(userId, amountUsd, mintAddress = '', txSignature = '', description = '') {
  init();
  if (amountUsd <= 0) throw new Error('Debit amount must be positive');

  const current = getBalance(userId);
  if (current.balanceUsd < amountUsd) {
    return {
      balanceUsd: current.balanceUsd,
      success: false,
      error: `Insufficient balance: $${current.balanceUsd.toFixed(2)} < $${amountUsd.toFixed(2)}`,
    };
  }

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE nft_balances SET
        balance_usd = balance_usd - ?,
        total_spent_usd = total_spent_usd + ?,
        updated_at = datetime('now')
      WHERE user_id = ?
    `).run(amountUsd, amountUsd, userId);

    db.prepare(`
      INSERT INTO nft_transactions (user_id, type, amount_usd, description, mint_address, tx_signature)
      VALUES (?, 'debit', ?, ?, ?, ?)
    `).run(userId, amountUsd, description, mintAddress, txSignature);
  });

  txn();

  const balance = getBalance(userId);
  console.log(`[NFT Balance] Debit: user=${userId} -$${amountUsd.toFixed(2)} → $${balance.balanceUsd.toFixed(2)} mint=${mintAddress}`);
  return { ...balance, success: true };
}

/**
 * Refund a failed mint back to user's balance
 * @param {number} userId
 * @param {number} amountUsd
 * @param {string} reason
 * @returns {{ balanceUsd: number }}
 */
function refund(userId, amountUsd, reason = 'Mint failed — refunded') {
  init();
  if (amountUsd <= 0) throw new Error('Refund amount must be positive');

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE nft_balances SET
        balance_usd = balance_usd + ?,
        total_spent_usd = total_spent_usd - ?,
        updated_at = datetime('now')
      WHERE user_id = ?
    `).run(amountUsd, amountUsd, userId);

    db.prepare(`
      INSERT INTO nft_transactions (user_id, type, amount_usd, description)
      VALUES (?, 'refund', ?, ?)
    `).run(userId, amountUsd, reason);
  });

  txn();

  const balance = getBalance(userId);
  console.log(`[NFT Balance] Refund: user=${userId} +$${amountUsd.toFixed(2)} → $${balance.balanceUsd.toFixed(2)}`);
  return balance;
}

/**
 * Get transaction history for a user
 * @param {number} userId
 * @param {number} limit
 * @returns {Array}
 */
function getTransactions(userId, limit = 50) {
  init();
  return db.prepare(`
    SELECT id, type, amount_usd, description, mint_address, tx_signature, created_at
    FROM nft_transactions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

/**
 * Check if user can afford a mint at the given cost
 * @param {number} userId
 * @param {number} costUsd
 * @returns {{ canAfford: boolean, balanceUsd: number, costUsd: number, shortfall: number }}
 */
function canAfford(userId, costUsd) {
  const { balanceUsd } = getBalance(userId);
  return {
    canAfford: balanceUsd >= costUsd,
    balanceUsd,
    costUsd,
    shortfall: Math.max(0, costUsd - balanceUsd),
  };
}

module.exports = {
  init,
  getBalance,
  addCredit,
  deductBalance,
  refund,
  getTransactions,
  canAfford,
};
