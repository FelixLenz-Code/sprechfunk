import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  audio_bitrate INTEGER NOT NULL DEFAULT 24000,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('direct','group')),
  name       TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  type            TEXT NOT NULL CHECK (type IN ('text','voice','system')),
  body            TEXT,
  audio_file      TEXT,
  audio_mime      TEXT,
  duration_ms     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at    INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
`);

// Default app settings
const getSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const setSetting = db.prepare(
  'INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function getAppSetting(key: string): string | null {
  const row = getSetting.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string): void {
  setSetting.run(key, value);
}

// Seed registration_enabled = true on first boot.
if (getAppSetting('registration_enabled') === null) {
  setAppSetting('registration_enabled', 'true');
}

export function isRegistrationEnabled(): boolean {
  return getAppSetting('registration_enabled') === 'true';
}

export function countUsers(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}
