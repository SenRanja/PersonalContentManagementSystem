import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dataRoot = path.resolve(process.env.DATA_DIR || path.join(projectRoot, "data"));
export const filesRoot = path.join(dataRoot, "files");
export const tempRoot = path.join(dataRoot, "tmp");

fs.mkdirSync(filesRoot, { recursive: true });
fs.mkdirSync(tempRoot, { recursive: true });

const db = new Database(path.join(dataRoot, "pcms.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS file_areas (
    path TEXT PRIMARY KEY,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS file_grants (
    area_path TEXT NOT NULL REFERENCES file_areas(path) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (area_path, user_id)
  );

  CREATE TABLE IF NOT EXISTS file_protections (
    path TEXT PRIMARY KEY,
    area_path TEXT NOT NULL REFERENCES file_areas(path) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(id);
  CREATE INDEX IF NOT EXISTS idx_file_grants_user ON file_grants(user_id);
  CREATE INDEX IF NOT EXISTS idx_file_protections_area ON file_protections(area_path);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((column) => column.name === "is_owner")) {
  db.exec("ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0");
}

if (db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_owner = 1").get().count === 0) {
  db.prepare(`
    UPDATE users SET is_owner = 1, is_admin = 1
    WHERE id = COALESCE(
      (SELECT id FROM users WHERE username = 'admin' COLLATE NOCASE ORDER BY id LIMIT 1),
      (SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1),
      (SELECT id FROM users ORDER BY id LIMIT 1)
    )
  `).run();
}

db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(is_owner) WHERE is_owner = 1");

db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

export default db;