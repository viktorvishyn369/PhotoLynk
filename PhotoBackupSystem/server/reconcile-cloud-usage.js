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

const isValidChunkId = (name) => /^[a-f0-9]{64}$/i.test(String(name || ''));

const main = () => {
  const usersRoot = path.join(CLOUD_DIR, 'users');
  if (!fs.existsSync(usersRoot)) {
    process.exit(0);
  }

  const now = Date.now();
  const db = new sqlite3.Database(DB_PATH);

  db.serialize(() => {
    // Concurrency tuning (safe even if already set in server.js)
    db.run(`PRAGMA journal_mode=WAL`);
    db.run(`PRAGMA synchronous=NORMAL`);
    db.run(`PRAGMA busy_timeout=5000`);

    db.all(
      `SELECT u.id AS user_id,
              u.user_uuid AS user_uuid,
              GROUP_CONCAT(d.device_uuid, ',') AS device_uuids
         FROM users u
         LEFT JOIN devices d ON d.user_id = u.id
        GROUP BY u.id`,
      [],
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

          // Pick the first existing folder as the authoritative storage location.
          let userDir = null;
          for (const k of keys) {
            const candidate = path.join(usersRoot, k);
            if (fs.existsSync(candidate)) {
              userDir = candidate;
              break;
            }
          }
          if (!userDir) return;

          const chunksDir = path.join(userDir, 'chunks');
          if (!fs.existsSync(chunksDir)) return;

          let files;
          try {
            files = fs.readdirSync(chunksDir);
          } catch (e) {
            return;
          }

          const seen = new Set();

          files
            .filter((f) => !String(f).startsWith('.'))
            .filter(isValidChunkId)
            .forEach((chunkId) => {
              const chunkPath = path.join(chunksDir, chunkId);
              try {
                const st = fs.statSync(chunkPath);
                if (!st.isFile()) return;
                const size = Number(st.size);
                if (!Number.isFinite(size) || size <= 0) return;

                seen.add(chunkId);
                db.run(
                  `INSERT INTO cloud_chunks (user_id, chunk_id, size, created_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(user_id, chunk_id) DO UPDATE SET
                     size=excluded.size`,
                  [userId, chunkId, size, now]
                );
              } catch (e) {
                return;
              }
            });

          // Delete stale DB rows for missing files.
          db.all(
            `SELECT chunk_id FROM cloud_chunks WHERE user_id = ?`,
            [userId],
            (e2, rows2) => {
              if (e2) return;
              const dbChunks = Array.isArray(rows2) ? rows2 : [];
              dbChunks.forEach((row) => {
                const cid = row && row.chunk_id ? String(row.chunk_id) : '';
                if (!cid) return;
                if (!seen.has(cid)) {
                  db.run(
                    `DELETE FROM cloud_chunks WHERE user_id = ? AND chunk_id = ?`,
                    [userId, cid]
                  );
                }
              });
            }
          );
        });

        // Let sqlite flush queued statements then close.
        setTimeout(() => {
          db.close();
        }, 500);
      }
    );
  });
};

main();
