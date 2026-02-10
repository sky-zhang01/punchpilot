import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { migrateEncryptionIfNeeded } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'punchpilot.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'fixed',
      fixed_time TEXT,
      window_start TEXT,
      window_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      scheduled_time TEXT,
      executed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'scheduled',
      error_message TEXT,
      screenshot_before TEXT,
      screenshot_after TEXT,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_log_date ON execution_log(executed_at);
    CREATE INDEX IF NOT EXISTS idx_log_action ON execution_log(action_type);

    CREATE TABLE IF NOT EXISTS custom_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_schedule (
      date TEXT NOT NULL,
      action_type TEXT NOT NULL,
      resolved_time TEXT NOT NULL,
      executed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, action_type)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS strategy_cache (
      month TEXT PRIMARY KEY,
      direct_ok INTEGER DEFAULT 1,
      approval_ok INTEGER DEFAULT 1,
      time_clock_ok INTEGER DEFAULT 1,
      best_strategy TEXT DEFAULT 'direct',
      detected_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  // Add user_id column to sessions if it doesn't exist (migration for existing DBs)
  try {
    db.prepare('SELECT user_id FROM sessions LIMIT 1').get();
  } catch {
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');
      console.log('[PunchPilot] Migrated sessions table: added user_id column');
    } catch {}
  }

  // Seed default config
  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO config (action_type, mode, fixed_time, window_start, window_end)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertConfig.run('checkin', 'random', '10:00', '09:50', '10:00');
  insertConfig.run('checkout', 'random', '20:00', '19:45', '20:15');
  insertConfig.run('break_start', 'random', '12:00', '12:00', '12:45');
  insertConfig.run('break_end', 'random', '13:00', '13:00', '13:45');

  // Seed default settings
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);
  insertSetting.run('auto_checkin_enabled', '0'); // Default OFF - user must enable
  insertSetting.run('debug_mode', '1'); // Default ON for first run (mock mode)
  insertSetting.run('holiday_cache_date', '');
  insertSetting.run('holiday_cache_data', '{}');
  insertSetting.run('freee_username', '');
  insertSetting.run('freee_username_encrypted', '');
  insertSetting.run('freee_password_encrypted', '');
  insertSetting.run('freee_configured', '0');

  // Connection mode & OAuth settings (browser mode disabled, default to api)
  insertSetting.run('connection_mode', 'api');
  insertSetting.run('oauth_client_id', '');
  insertSetting.run('oauth_client_secret_encrypted', '');
  insertSetting.run('oauth_access_token_encrypted', '');
  insertSetting.run('oauth_refresh_token_encrypted', '');
  insertSetting.run('oauth_token_expires_at', '0');
  insertSetting.run('oauth_company_id', '');
  insertSetting.run('oauth_employee_id', '');
  insertSetting.run('oauth_configured', '0');

  // Seed default admin user if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 1)'
    ).run('admin', hash);
    console.log('[PunchPilot] Created default user: admin / admin (must change on first login)');
  }

  // Migrate encryption if needed (legacy GUI_PASSWORD → APP_SECRET)
  migrateEncryptionIfNeeded(getSetting, setSetting);

  console.log('[PunchPilot] Database initialized at', DB_PATH);
}

// --- Config helpers ---

export function getAllConfig() {
  return getDb().prepare('SELECT * FROM config ORDER BY id').all();
}

export function getConfigByAction(actionType) {
  return getDb().prepare('SELECT * FROM config WHERE action_type = ?').get(actionType);
}

export function updateConfig(actionType, data) {
  const fields = [];
  const values = [];

  for (const key of ['enabled', 'mode', 'fixed_time', 'window_start', 'window_end']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }

  if (fields.length === 0) return null;

  fields.push("updated_at = datetime('now','localtime')");
  values.push(actionType);

  return getDb().prepare(
    `UPDATE config SET ${fields.join(', ')} WHERE action_type = ?`
  ).run(...values);
}

// --- Execution log helpers ---

export function insertLog(log) {
  return getDb().prepare(`
    INSERT INTO execution_log (action_type, scheduled_time, status, trigger_type, error_message, screenshot_before, screenshot_after, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.action_type,
    log.scheduled_time || null,
    log.status,
    log.trigger_type || 'scheduled',
    log.error_message || null,
    log.screenshot_before || null,
    log.screenshot_after || null,
    log.duration_ms || null
  );
}

export function getLogsByDate(date) {
  return getDb().prepare(
    `SELECT * FROM execution_log WHERE date(executed_at) = ? ORDER BY executed_at DESC`
  ).all(date);
}

export function getLogsPaginated(params = {}) {
  const { date, action_type, page = 1, limit = 20 } = params;
  const conditions = [];
  const values = [];

  if (date) {
    conditions.push('date(executed_at) = ?');
    values.push(date);
  }
  if (action_type) {
    conditions.push('action_type = ?');
    values.push(action_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const total = getDb().prepare(
    `SELECT COUNT(*) as count FROM execution_log ${where}`
  ).get(...values).count;

  const rows = getDb().prepare(
    `SELECT * FROM execution_log ${where} ORDER BY executed_at DESC LIMIT ? OFFSET ?`
  ).all(...values, limit, offset);

  return { rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export function getLogById(id) {
  return getDb().prepare('SELECT * FROM execution_log WHERE id = ?').get(id);
}

export function getCalendarData(year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return getDb().prepare(`
    SELECT date(executed_at) as date, action_type, status, COUNT(*) as count
    FROM execution_log
    WHERE executed_at LIKE ?
    GROUP BY date(executed_at), action_type, status
    ORDER BY date(executed_at)
  `).all(`${prefix}%`);
}

// --- Custom holidays helpers ---

export function getCustomHolidays() {
  return getDb().prepare('SELECT * FROM custom_holidays ORDER BY date').all();
}

export function getCustomHolidaysByYear(year) {
  return getDb().prepare(
    'SELECT * FROM custom_holidays WHERE date LIKE ? ORDER BY date'
  ).all(`${year}%`);
}

export function addCustomHoliday(date, description) {
  return getDb().prepare(
    'INSERT INTO custom_holidays (date, description) VALUES (?, ?)'
  ).run(date, description || '');
}

export function deleteCustomHoliday(id) {
  return getDb().prepare('DELETE FROM custom_holidays WHERE id = ?').run(id);
}

// --- Settings helpers ---

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  return getDb().prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).run(key, value);
}

// --- Session helpers ---

export function createSession(token, userId, expiresAt) {
  return getDb().prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(token, userId, expiresAt);
}

export function getSession(token) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(token);
}

export function deleteSession(token) {
  return getDb().prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

export function deleteAllUserSessions(userId) {
  return getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function cleanExpiredSessions() {
  return getDb().prepare(
    "DELETE FROM sessions WHERE expires_at < datetime('now','localtime')"
  ).run();
}

// --- User helpers ---

export function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

export function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function updateUser(id, data) {
  const fields = [];
  const values = [];

  if (data.username !== undefined) {
    fields.push('username = ?');
    values.push(data.username);
  }
  if (data.password_hash !== undefined) {
    fields.push('password_hash = ?');
    values.push(data.password_hash);
  }
  if (data.must_change_password !== undefined) {
    fields.push('must_change_password = ?');
    values.push(data.must_change_password);
  }

  if (fields.length === 0) return null;

  fields.push("updated_at = datetime('now','localtime')");
  values.push(id);

  return getDb().prepare(
    `UPDATE users SET ${fields.join(', ')} WHERE id = ?`
  ).run(...values);
}

// --- Daily schedule helpers ---

export function getDailySchedule(date) {
  return getDb().prepare(
    'SELECT * FROM daily_schedule WHERE date = ?'
  ).all(date);
}

export function setDailySchedule(date, actionType, resolvedTime) {
  return getDb().prepare(
    'INSERT OR REPLACE INTO daily_schedule (date, action_type, resolved_time, executed) VALUES (?, ?, ?, 0)'
  ).run(date, actionType, resolvedTime);
}

export function markDailyScheduleExecuted(date, actionType) {
  return getDb().prepare(
    'UPDATE daily_schedule SET executed = 1 WHERE date = ? AND action_type = ?'
  ).run(date, actionType);
}

// --- Strategy cache helpers ---

export function getStrategyCache(month) {
  return getDb().prepare('SELECT * FROM strategy_cache WHERE month = ?').get(month) || null;
}

export function setStrategyCache(month, data) {
  return getDb().prepare(`
    INSERT OR REPLACE INTO strategy_cache (month, direct_ok, approval_ok, time_clock_ok, best_strategy, detected_at)
    VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
  `).run(
    month,
    data.direct_ok ? 1 : 0,
    data.approval_ok ? 1 : 0,
    data.time_clock_ok ? 1 : 0,
    data.best_strategy || 'direct'
  );
}

export function cleanOldSchedules(daysToKeep = 7) {
  return getDb().prepare(
    `DELETE FROM daily_schedule WHERE date < date('now','localtime','-' || ? || ' days')`
  ).run(String(daysToKeep));
}
