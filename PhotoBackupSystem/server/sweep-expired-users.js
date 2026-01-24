const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH;
const CLOUD_DIR = process.env.CLOUD_DIR;

if (!DB_PATH || !CLOUD_DIR) {
  process.exit(2);
}

const sanitizeKey = (value) => {
  const s = (value || '').toString();
  const safe = s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  return safe || null;
};

const removeDirSafe = (dirPath) => {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
};

const main = () => {
  const now = Date.now();
  const db = new sqlite3.Database(DB_PATH);

  db.serialize(() => {
    db.all(
      `SELECT up.user_id,
              up.grace_until,
              u.user_uuid AS user_uuid,
              GROUP_CONCAT(d.device_uuid, ',') AS device_uuids
         FROM user_plans up
         LEFT JOIN users u ON u.id = up.user_id
         LEFT JOIN devices d ON d.user_id = up.user_id
        WHERE up.status = 'grace'
          AND up.grace_until IS NOT NULL
          AND up.grace_until <= ?
          AND (up.deleted_at IS NULL OR up.deleted_at = 0)
        GROUP BY up.user_id`,
      [now],
      (err, rows) => {
        if (err) {
          db.close();
          process.exit(1);
          return;
        }

        const list = Array.isArray(rows) ? rows : [];
        list.forEach((r) => {
          const userId = r && r.user_id ? r.user_id : null;
          if (!userId) return;

          const keys = new Set();
          keys.add(String(userId));

          const userUuidKey = sanitizeKey(r.user_uuid);
          if (userUuidKey) keys.add(userUuidKey);

          const deviceUuids = (r && r.device_uuids ? String(r.device_uuids) : '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

          deviceUuids.forEach((du) => {
            const k = sanitizeKey(du);
            if (k) keys.add(k);
          });

          keys.forEach((k) => {
            const userDir = path.join(CLOUD_DIR, 'users', k);
            removeDirSafe(userDir);
          });

          db.run(
            `DELETE FROM cloud_chunks WHERE user_id = ?`,
            [userId]
          );

          db.run(
            `UPDATE user_plans
                SET status = 'deleted',
                    deleted_at = ?,
                    updated_at = ?
              WHERE user_id = ?`,
            [now, now, userId]
          );
        });

        db.close();
      }
    );
  });
};

main();
