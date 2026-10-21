import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ensureDataDir } from './config.js';

ensureDataDir();

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const migrations = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        user_agent TEXT,
        ip_address TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        ip_address TEXT,
        success INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_login_attempts_user_time ON login_attempts(username, created_at);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        scope TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        private_session INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_search_history_user_time ON search_history(user_id, created_at);
      CREATE TABLE IF NOT EXISTS technical_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tech_logs_created ON technical_logs(created_at);
    `,
  },
  {
    version: 3,
    up: `
      CREATE TABLE IF NOT EXISTS online_presence (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','idle','offline')),
        last_heartbeat_at TEXT,
        active_sessions INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL DEFAULT 'global',
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chat_room_time ON chat_messages(room, created_at);
    `,
  },
  {
    version: 4,
    up: `
      CREATE TABLE IF NOT EXISTS always_on_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK (task_type IN ('monitor','persistent')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','starting','running','degraded','stopped','failed')),
        config TEXT NOT NULL DEFAULT '{}',
        started_at TEXT,
        last_heartbeat_at TEXT,
        restart_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_aot_user ON always_on_tasks(user_id);
      CREATE TABLE IF NOT EXISTS storage_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file','folder','note','link','snippet','draft')),
        parent_id INTEGER REFERENCES storage_items(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content TEXT,
        mime TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_storage_user_parent ON storage_items(user_id, parent_id);
    `,
  },
  {
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS always_on_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES always_on_tasks(id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        http_status INTEGER,
        latency_ms INTEGER,
        outcome TEXT NOT NULL CHECK (outcome IN ('ok','error')),
        message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_aot_checks_task_time ON always_on_checks(task_id, checked_at DESC);
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO system_settings(key, value) VALUES ('always_on_enabled', 'true');
      CREATE TABLE IF NOT EXISTS extensions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 0,
        installed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
      CREATE INDEX IF NOT EXISTS idx_extensions_enabled ON extensions(enabled);
      CREATE INDEX IF NOT EXISTS idx_history_created ON search_history(created_at);
      CREATE INDEX IF NOT EXISTS idx_chat_id_room ON chat_messages(room, id DESC);
      CREATE INDEX IF NOT EXISTS idx_storage_expiry ON storage_items(expires_at);
      CREATE INDEX IF NOT EXISTS idx_workspaces_user_name ON workspaces(user_id, name);
    `,
  },
  {
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(user_id, key)
      );
      CREATE TABLE IF NOT EXISTS user_extensions (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        extension_id INTEGER NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(user_id, extension_id)
      );
      INSERT OR IGNORE INTO extensions(name, version, description, source_url, permissions, enabled)
      VALUES (
        'Privacy URL Cleaner',
        '1.0.0',
        'Removes known tracking parameters from URLs entered into WioBrowse. It does not filter website requests.',
        'https://github.com/oswi3525-glitch/wiobr',
        '["url.modify"]',
        1
      );
    `,
  },
];

const migrationTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
let currentVersion = migrationTable
  ? db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get().v
  : 0;

const pendingMigrations = migrations.filter((migration) => migration.version > currentVersion);
if (pendingMigrations.length && currentVersion > 0 && existsSync(config.dbPath)) {
  const backupDir = join(config.dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = join(backupDir, `wiobr-pre-migration-v${currentVersion}-${Date.now()}.sqlite`);
  await db.backup(backupPath);
  chmodSync(backupPath, 0o600);
}

for (const migration of pendingMigrations) {
  const tx = db.transaction(() => {
    db.exec(migration.up);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, datetime(\'now\'))').run(migration.version);
  });
  tx();
  console.log(`Applied migration ${migration.version}`);
}

export function auditLog({ actorUserId = null, action, targetType = null, targetId = null, scope = null, metadata = null }) {
  if (!/^[a-z0-9_.:-]{1,80}$/i.test(action)) throw new Error('Invalid audit action');
  db.prepare(
    'INSERT INTO audit_logs(actor_user_id, action, target_type, target_id, scope, metadata) VALUES (?,?,?,?,?,?)',
  ).run(actorUserId, action, targetType, targetId, scope, metadata ? JSON.stringify(metadata) : null);
}

export function technicalLog(level, message, context = null) {
  const safeMessage = String(message).replace(/[\r\n]/g, ' ').slice(0, 500);
  db.prepare('INSERT INTO technical_logs(level, message, context) VALUES (?,?,?)')
    .run(level, safeMessage, context ? JSON.stringify(context).slice(0, 2000) : null);
}
