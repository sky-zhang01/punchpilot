import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { decrypt, deriveKeyedDigest, migrateEncryptionIfNeeded } from './crypto.js';
import { DB_PATH, INITIAL_ADMIN_PASSWORD_FILE } from './paths.js';
import { dateInTimezone, resolveTimezone } from '../shared/date-time.js';
import { resolveWebAccount } from './web-account.js';
import {
  normalizeAutomationErrorCode,
  normalizeAutomationFailureStage,
} from './automation-diagnostics.js';

const INITIAL_ADMIN_PASSWORD_MIN_BYTES = 16;

let db;

function databasePathError(message) {
  const error = new Error(message);
  error.code = 'DATABASE_PATH_UNSAFE';
  return error;
}

function ownerIsAllowed(metadata) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return currentUid === null || metadata.uid === 0 || metadata.uid === currentUid;
}

function ensurePrivateDatabaseDirectory() {
  const directory = path.dirname(DB_PATH);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownerIsAllowed(metadata)) {
    throw databasePathError('Database directory must be a private directory');
  }
  fs.chmodSync(directory, 0o700);
}

function secureDatabaseArtifact(file) {
  let metadata;
  try {
    metadata = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || !ownerIsAllowed(metadata)) {
    throw databasePathError('Database files must be private regular files');
  }
  fs.chmodSync(file, 0o600);
}

function secureDatabaseArtifacts() {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    secureDatabaseArtifact(file);
  }
}

function initialAdminConfigurationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unsafeInitialAdminPasswordFileError() {
  return initialAdminConfigurationError(
    'Initial administrator password file must be a private regular file',
    'INITIAL_ADMIN_PASSWORD_FILE_UNSAFE',
  );
}

function validateInitialAdminPassword(password) {
  if (Buffer.byteLength(password, 'utf8') < INITIAL_ADMIN_PASSWORD_MIN_BYTES) {
    throw initialAdminConfigurationError(
      `PUNCHPILOT_INITIAL_ADMIN_PASSWORD must be at least ${INITIAL_ADMIN_PASSWORD_MIN_BYTES} bytes`,
      'INITIAL_ADMIN_PASSWORD_TOO_SHORT',
    );
  }
  return password;
}

function validateInitialAdminPasswordFileMetadata(metadata) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !metadata.isFile() ||
    metadata.mode & 0o077 ||
    (currentUid !== null && metadata.uid !== 0 && metadata.uid !== currentUid)
  ) {
    throw unsafeInitialAdminPasswordFileError();
  }
}

function readInitialAdminPasswordFile(passwordFile) {
  let descriptor;
  try {
    const pathMetadata = fs.lstatSync(passwordFile);
    if (pathMetadata.isSymbolicLink()) throw unsafeInitialAdminPasswordFileError();
    descriptor = fs.openSync(
      passwordFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    validateInitialAdminPasswordFileMetadata(fs.fstatSync(descriptor));
    return fs.readFileSync(descriptor, 'utf8').trim();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'INITIAL_ADMIN_PASSWORD_FILE_UNSAFE') {
      throw error;
    }
    throw unsafeInitialAdminPasswordFileError();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function resolveInitialAdminPassword() {
  const directPassword = process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD;
  const configuredFile = process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE;
  if (directPassword && configuredFile) {
    throw initialAdminConfigurationError(
      'Configure only one initial administrator password source.',
      'INITIAL_ADMIN_PASSWORD_SOURCE_CONFLICT',
    );
  }
  if (directPassword) {
    return {
      password: validateInitialAdminPassword(directPassword),
      generated: false,
    };
  }

  const passwordFile = configuredFile
    ? path.resolve(configuredFile)
    : INITIAL_ADMIN_PASSWORD_FILE;
  try {
    const password = readInitialAdminPasswordFile(passwordFile);
    return { password: validateInitialAdminPassword(password), generated: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const password = crypto.randomBytes(32).toString('base64url');
  const passwordDir = path.dirname(passwordFile);
  fs.mkdirSync(passwordDir, { recursive: true, mode: 0o700 });
  const directoryMetadata = fs.lstatSync(passwordDir);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    (currentUid !== null && directoryMetadata.uid !== 0 && directoryMetadata.uid !== currentUid)
  ) {
    throw unsafeInitialAdminPasswordFileError();
  }
  fs.chmodSync(passwordDir, 0o700);
  try {
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw unsafeInitialAdminPasswordFileError();
    throw error;
  }
  return { password, generated: true };
}

export function clearInitialAdminPassword() {
  const passwordFile = process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE
    ? path.resolve(process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE)
    : INITIAL_ADMIN_PASSWORD_FILE;
  try {
    if (!fs.statSync(passwordFile).isFile()) return;
    fs.rmSync(passwordFile, { force: true });
  } catch {
    // A read-only externally managed secret may remain mounted, but it is no
    // longer accepted after the initial administrator changes the password.
  }
}

export function getDb() {
  if (!db) {
    ensurePrivateDatabaseDirectory();
    secureDatabaseArtifact(DB_PATH);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    secureDatabaseArtifacts();
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
      business_date TEXT,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'scheduled',
      error_message TEXT,
      screenshot_before TEXT,
      screenshot_after TEXT,
      duration_ms INTEGER,
      error_code TEXT,
      failure_stage TEXT,
      identity_key TEXT NOT NULL DEFAULT 'legacy'
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
      identity_key TEXT NOT NULL,
      action_type TEXT NOT NULL,
      resolved_time TEXT NOT NULL,
      executed INTEGER NOT NULL DEFAULT 0,
      last_status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (date, identity_key, action_type)
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
      month TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      direct_ok INTEGER DEFAULT 1,
      approval_ok INTEGER DEFAULT 1,
      time_clock_ok INTEGER DEFAULT 1,
      best_strategy TEXT DEFAULT 'direct',
      detected_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (month, identity_key)
    );

    CREATE TABLE IF NOT EXISTS async_tasks (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      identity_key TEXT NOT NULL DEFAULT 'legacy',
      company_id TEXT,
      company_name TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      completed_at TEXT,
      result_summary TEXT,
      error_text TEXT,
      result_json TEXT
    );
  `);

  // Add user_id column to sessions if it doesn't exist (migration for existing DBs)
  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all();
  if (!sessionCols.some(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');
    console.log('[PunchPilot] Migrated sessions table: added user_id column');
  }

  // Add company_id and company_name columns to execution_log (migration)
  const logCols = db.prepare('PRAGMA table_info(execution_log)').all();
  const logColumnNames = new Set(logCols.map((column) => column.name));
  const addedLogColumns = [];
  if (!logColumnNames.has('business_date')) {
    db.exec('ALTER TABLE execution_log ADD COLUMN business_date TEXT');
    addedLogColumns.push('business_date');
  }
  if (!logColumnNames.has('company_id')) {
    db.exec('ALTER TABLE execution_log ADD COLUMN company_id TEXT');
    addedLogColumns.push('company_id');
  }
  if (!logColumnNames.has('company_name')) {
    db.exec('ALTER TABLE execution_log ADD COLUMN company_name TEXT');
    addedLogColumns.push('company_name');
  }
  if (!logColumnNames.has('identity_key')) {
    db.exec("ALTER TABLE execution_log ADD COLUMN identity_key TEXT NOT NULL DEFAULT 'legacy'");
    addedLogColumns.push('identity_key');
  }
  if (!logColumnNames.has('error_code')) {
    db.exec('ALTER TABLE execution_log ADD COLUMN error_code TEXT');
    addedLogColumns.push('error_code');
  }
  if (!logColumnNames.has('failure_stage')) {
    db.exec('ALTER TABLE execution_log ADD COLUMN failure_stage TEXT');
    addedLogColumns.push('failure_stage');
  }
  if (addedLogColumns.length > 0) {
    console.log(`[PunchPilot] Migrated execution_log table: added ${addedLogColumns.join(', ')} columns`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_log_identity_date
    ON execution_log(identity_key, executed_at)
  `);

  // Add observability columns to daily_schedule (migration)
  const scheduleCols = db.prepare('PRAGMA table_info(daily_schedule)').all();
  if (!scheduleCols.some(c => c.name === 'last_status')) {
    db.exec("ALTER TABLE daily_schedule ADD COLUMN last_status TEXT NOT NULL DEFAULT 'pending'");
    console.log('[PunchPilot] Migrated daily_schedule table: added last_status column');
  }
  if (!scheduleCols.some(c => c.name === 'attempts')) {
    db.exec('ALTER TABLE daily_schedule ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    console.log('[PunchPilot] Migrated daily_schedule table: added attempts column');
  }
  if (!scheduleCols.some(c => c.name === 'last_error')) {
    db.exec('ALTER TABLE daily_schedule ADD COLUMN last_error TEXT');
    console.log('[PunchPilot] Migrated daily_schedule table: added last_error column');
  }
  if (!scheduleCols.some(c => c.name === 'identity_key')) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE daily_schedule RENAME TO daily_schedule_legacy_v05;
      CREATE TABLE daily_schedule (
        date TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        action_type TEXT NOT NULL,
        resolved_time TEXT NOT NULL,
        executed INTEGER NOT NULL DEFAULT 0,
        last_status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (date, identity_key, action_type)
      );
      INSERT INTO daily_schedule (
        date, identity_key, action_type, resolved_time, executed,
        last_status, attempts, last_error
      )
      SELECT
        date, 'legacy', action_type, resolved_time, executed,
        last_status, attempts, last_error
      FROM daily_schedule_legacy_v05;
      DROP TABLE daily_schedule_legacy_v05;
      COMMIT;
    `);
    console.log('[PunchPilot] Migrated daily_schedule table: isolated legacy account scope');
  }

  const strategyCols = db.prepare('PRAGMA table_info(strategy_cache)').all();
  const strategyPrimaryKey = strategyCols
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (
    !strategyCols.some((column) => column.name === 'identity_key') ||
    strategyPrimaryKey.join(',') !== 'month,identity_key'
  ) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE strategy_cache RENAME TO strategy_cache_legacy_v05;
      CREATE TABLE strategy_cache (
        month TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        direct_ok INTEGER DEFAULT 1,
        approval_ok INTEGER DEFAULT 1,
        time_clock_ok INTEGER DEFAULT 1,
        best_strategy TEXT DEFAULT 'direct',
        detected_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        PRIMARY KEY (month, identity_key)
      );
      INSERT OR REPLACE INTO strategy_cache (
        month, identity_key, direct_ok, approval_ok, time_clock_ok,
        best_strategy, detected_at
      )
      SELECT
        month, 'legacy', direct_ok, approval_ok, time_clock_ok,
        best_strategy, detected_at
      FROM strategy_cache_legacy_v05;
      DROP TABLE strategy_cache_legacy_v05;
      COMMIT;
    `);
    console.log('[PunchPilot] Migrated strategy_cache table: isolated legacy account scope');
  }

  const asyncTaskCols = db.prepare('PRAGMA table_info(async_tasks)').all();
  const asyncTaskColumnNames = new Set(
    asyncTaskCols.map((column) => column.name),
  );
  if (!asyncTaskColumnNames.has('identity_key')) {
    db.exec("ALTER TABLE async_tasks ADD COLUMN identity_key TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!asyncTaskColumnNames.has('company_id')) {
    db.exec('ALTER TABLE async_tasks ADD COLUMN company_id TEXT');
  }
  if (!asyncTaskColumnNames.has('company_name')) {
    db.exec('ALTER TABLE async_tasks ADD COLUMN company_name TEXT');
  }
  if (!asyncTaskColumnNames.has('result_json')) {
    db.exec('ALTER TABLE async_tasks ADD COLUMN result_json TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_async_tasks_identity_id
    ON async_tasks(identity_key, id)
  `);

  // A task left running across process restart has no live worker.
  db.prepare("UPDATE async_tasks SET status = 'interrupted', completed_at = ?, error_text = ? WHERE status = 'running'").run(
    new Date().toISOString(),
    'Task was interrupted. Verify any unknown freee outcome before retrying.',
  );

  // Seed default config
  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO config (action_type, mode, fixed_time, window_start, window_end)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertConfig.run('checkin', 'random', '10:00', '09:50', '10:00');
  insertConfig.run('checkout', 'random', '19:00', '19:00', '20:00');
  insertConfig.run('break_start', 'random', '12:00', '12:00', '12:30');
  insertConfig.run('break_end', 'random', '13:00', '13:00', '13:30');

  // Seed default settings
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);
  insertSetting.run('auto_checkin_enabled', '1'); // Default ON after initial setup
  insertSetting.run('debug_mode', '1'); // Default ON for first run (mock mode)
  insertSetting.run('holiday_cache_date', '');
  insertSetting.run('holiday_cache_data', '{}');
  insertSetting.run('freee_username', '');
  insertSetting.run('freee_username_encrypted', '');
  insertSetting.run('freee_password_encrypted', '');
  insertSetting.run('web_employee_id_encrypted', '');
  insertSetting.run('holiday_skip_countries', 'jp'); // Default: skip Japan holidays only
  insertSetting.run('freee_configured', '0');
  insertSetting.run('web_company_name', '');
  insertSetting.run('web_identity_generation', '0');
  insertSetting.run('web_verified_credential_digest', '');

  // Connection mode & OAuth settings (API remains the default transport)
  insertSetting.run('connection_mode', 'api');
  insertSetting.run('oauth_client_id', '');
  insertSetting.run('oauth_client_secret_encrypted', '');
  insertSetting.run('oauth_access_token_encrypted', '');
  insertSetting.run('oauth_refresh_token_encrypted', '');
  insertSetting.run('oauth_token_expires_at', '0');
  insertSetting.run('oauth_company_id', '');
  insertSetting.run('oauth_employee_id', '');
  insertSetting.run('oauth_configured', '0');
  insertSetting.run('oauth_auth_broken', '0');
  insertSetting.run('oauth_auth_broken_since', '');
  insertSetting.run('oauth_auth_broken_reason', '');
  insertSetting.run('oauth_identity_generation', '0');
  insertSetting.run('oauth_state', '');
  insertSetting.run('oauth_state_issued_at', '0');
  insertSetting.run('oauth_state_generation', '');

  // Seed default admin user if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const initialAdmin = resolveInitialAdminPassword();
    const hash = bcrypt.hashSync(initialAdmin.password, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 1)'
    ).run('admin', hash);
    if (initialAdmin.generated) {
      console.log('[PunchPilot] Generated an initial administrator password in the keystore');
    }
    console.log('[PunchPilot] Created the initial administrator; password change required');
    delete process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD;
  }

  // Migrate encryption and storage if needed (secret location, plaintext username)
  migrateEncryptionIfNeeded(getSetting, setSetting, setSettingsAtomically);

  console.log('[PunchPilot] Database initialized');
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

  const database = getDb();
  return database.transaction(() => {
    const before = getConfigByAction(actionType);
    const result = database.prepare(
      `UPDATE config SET ${fields.join(', ')} WHERE action_type = ?`
    ).run(...values);
    if (!before) return result;
    const after = getConfigByAction(actionType);
    const timeFields = after.mode === 'random' ? ['window_start', 'window_end'] : ['fixed_time'];
    if (before.mode !== after.mode || timeFields.some((field) => Reflect.get(before, field) !== Reflect.get(after, field))) {
      const actions = actionType.startsWith('break_') ? ['break_start', 'break_end'] : [actionType];
      const today = dateInTimezone(new Date(), resolveTimezone(process.env.TZ, getSetting('app_timezone')));
      const removePending = database.prepare(`DELETE FROM daily_schedule
        WHERE date >= ? AND action_type = ? AND executed = 0 AND attempts = 0
          AND last_status IN ('pending', 'paused_configuration')`);
      for (const action of actions) removePending.run(today, action);
    }
    return result;
  })();
}

// --- Execution log helpers ---

const EXECUTION_LOG_IDENTITY_PATTERN = /^log-v1:[a-f0-9]{64}$/;

function executionLogIdentityDigest(parts) {
  return `log-v1:${deriveKeyedDigest('execution-log-v1', parts)}`;
}

export function currentExecutionLogIdentityKey() {
  const mode = getSetting('connection_mode') || 'api';
  const debugMode = getSetting('debug_mode') === '1' ? 'debug' : 'live';
  if (mode === 'browser') {
    const account = resolveWebAccount(getSetting, decrypt);
    const { source, companyName, employeeId: employeeIdentity } = account;
    const credentialIdentity = account.username.trim().toLowerCase();
    if (
      companyName &&
      credentialIdentity &&
      /^[1-9]\d*$/.test(employeeIdentity)
    ) {
      return executionLogIdentityDigest([
        'automation-log',
        debugMode,
        'browser',
        'verified',
        companyName,
        employeeIdentity,
        credentialIdentity,
      ]);
    }
    return executionLogIdentityDigest([
      'automation-log',
      debugMode,
      'browser',
      'unverified',
      source,
      getSetting('web_identity_generation') || '0',
      companyName,
    ]);
  }
  const companyId = String(getSetting('oauth_company_id') || '').trim();
  const employeeId = String(getSetting('oauth_employee_id') || '').trim();
  if (/^[1-9]\d*$/.test(companyId) && /^[1-9]\d*$/.test(employeeId)) {
    return executionLogIdentityDigest([
      'automation-log',
      debugMode,
      'api',
      'verified',
      companyId,
      employeeId,
    ]);
  }
  return executionLogIdentityDigest([
    'automation-log',
    debugMode,
    'api',
    'unverified',
    getSetting('oauth_identity_generation') || '0',
    companyId,
    employeeId,
  ]);
}

function normalizeExecutionLogIdentityKey(value) {
  if (typeof value !== 'string' || !EXECUTION_LOG_IDENTITY_PATTERN.test(value)) {
    throw new TypeError('A current execution-log identity key is required');
  }
  return value;
}

export function insertLog(log) {
  const now = new Date();
  const businessDate = dateInTimezone(now, resolveTimezone(process.env.TZ, getSetting('app_timezone')));
  const usesOAuth = (getSetting('connection_mode') || 'api') === 'api';
  const hasCompanyId = Object.prototype.hasOwnProperty.call(log, 'company_id');
  const hasCompanyName = Object.prototype.hasOwnProperty.call(log, 'company_name');
  const companyId = hasCompanyId
    ? log.company_id || ''
    : usesOAuth ? getSetting('oauth_company_id') || '' : '';
  const companyName = hasCompanyName
    ? log.company_name || ''
    : usesOAuth
      ? getSetting('oauth_company_name') || ''
      : getSetting('web_company_name') || '';
  const identityKey = normalizeExecutionLogIdentityKey(
    Object.prototype.hasOwnProperty.call(log, 'identity_key')
      ? log.identity_key
      : currentExecutionLogIdentityKey(),
  );
  return getDb().prepare(`
    INSERT INTO execution_log (action_type, scheduled_time, status, trigger_type, error_message, screenshot_before, screenshot_after, duration_ms, error_code, failure_stage, company_id, company_name, identity_key, executed_at, business_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.action_type,
    log.scheduled_time || null,
    log.status,
    log.trigger_type || 'scheduled',
    log.error_message || null,
    log.screenshot_before || null,
    log.screenshot_after || null,
    log.duration_ms ?? null,
    normalizeAutomationErrorCode(log.error_code),
    normalizeAutomationFailureStage(log.failure_stage),
    companyId,
    companyName,
    identityKey,
    now.toISOString(),
    businessDate,
  );
}

// Logs are append-only. Their IDs preserve order across historical local timestamps
// and new UTC timestamps without guessing a timezone for old entries.
const LOG_BUSINESS_DATE = 'COALESCE(business_date, substr(executed_at, 1, 10))';

export function getLogsByDate(date, identityKey) {
  return getDb().prepare(
    `SELECT * FROM execution_log WHERE ${LOG_BUSINESS_DATE} = ? AND identity_key = ? ORDER BY id DESC`
  ).all(date, normalizeExecutionLogIdentityKey(identityKey));
}

export function getLogsPaginated(params = {}) {
  const {
    date,
    date_from,
    date_to,
    action_type,
    status,
    search,
    identity_key,
    page = 1,
    limit = 20,
  } = params;
  const conditions = [];
  const values = [];

  if (date) {
    conditions.push(`${LOG_BUSINESS_DATE} = ?`);
    values.push(date);
  } else {
    if (date_from) {
      conditions.push(`${LOG_BUSINESS_DATE} >= ?`);
      values.push(date_from);
    }
    if (date_to) {
      conditions.push(`${LOG_BUSINESS_DATE} <= ?`);
      values.push(date_to);
    }
  }
  if (action_type) {
    conditions.push('action_type = ?');
    values.push(action_type);
  }
  if (status) {
    conditions.push('status = ?');
    values.push(status);
  }
  if (search) {
    const escapedSearch = search.replace(/[!%_]/g, '!$&');
    const searchPattern = `%${escapedSearch}%`;
    conditions.push(`(
      action_type LIKE ? ESCAPE '!' OR
      trigger_type LIKE ? ESCAPE '!' OR
      error_message LIKE ? ESCAPE '!' OR
      error_code LIKE ? ESCAPE '!' OR
      failure_stage LIKE ? ESCAPE '!' OR
      company_name LIKE ? ESCAPE '!'
    )`);
    values.push(...Array(6).fill(searchPattern));
  }
  conditions.push('identity_key = ?');
  values.push(normalizeExecutionLogIdentityKey(identity_key));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const total = getDb().prepare(
    `SELECT COUNT(*) as count FROM execution_log ${where}`
  ).get(...values).count;

  const rows = getDb().prepare(
    `SELECT * FROM execution_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...values, limit, offset);

  return { rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export function getLogById(id, identityKey) {
  return getDb()
    .prepare('SELECT * FROM execution_log WHERE id = ? AND identity_key = ?')
    .get(id, normalizeExecutionLogIdentityKey(identityKey));
}

export function getCalendarData(year, month, identityKey) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return getDb().prepare(`
    SELECT ${LOG_BUSINESS_DATE} as date, action_type, status, COUNT(*) as count
    FROM execution_log
    WHERE ${LOG_BUSINESS_DATE} LIKE ?
      AND identity_key = ?
    GROUP BY ${LOG_BUSINESS_DATE}, action_type, status
    ORDER BY ${LOG_BUSINESS_DATE}
  `).all(`${prefix}%`, normalizeExecutionLogIdentityKey(identityKey));
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

function validateSettingEntries(entries) {
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
  ) {
    throw new TypeError('Settings updates must be [key, value] pairs');
  }
}

export function setSettingsAtomically(entries) {
  validateSettingEntries(entries);
  const database = getDb();
  const statement = database.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  );
  return database.transaction((updates) => {
    for (const [key, value] of updates) statement.run(key, String(value));
  })(entries);
}

export function setSettingsAtomicallyIfCurrent(expectedEntries, entries) {
  validateSettingEntries(expectedEntries);
  validateSettingEntries(entries);
  const database = getDb();
  const readStatement = database.prepare('SELECT value FROM settings WHERE key = ?');
  const writeStatement = database.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  );
  return database.transaction((expected, updates) => {
    for (const [key, value] of expected) {
      const current = readStatement.get(key);
      if (!current || current.value !== String(value)) return false;
    }
    for (const [key, value] of updates) writeStatement.run(key, String(value));
    return true;
  })(expectedEntries, entries);
}

/**
 * Clean up expired leave strategy cache entries from settings table.
 * Keeps only entries for the current month; deletes older ones.
 * Called from the daily cron job alongside cleanOldSchedules.
 */
export function cleanExpiredLeaveStrategyCache() {
  const currentMonth = dateInTimezone(new Date(), resolveTimezone(process.env.TZ, getSetting('app_timezone'))).slice(0, 7);
  const prefix = 'leave_strategy_';
  const rows = getDb().prepare(
    `SELECT key FROM settings WHERE key LIKE ?`
  ).all(`${prefix}%`);
  let deleted = 0;
  for (const row of rows) {
    // key format: leave_strategy_YYYY-MM_Type
    const month = row.key.substring(prefix.length, prefix.length + 7);
    if (month < currentMonth) {
      getDb().prepare('DELETE FROM settings WHERE key = ?').run(row.key);
      deleted++;
    }
  }
  if (deleted > 0) {
    console.log(`[PunchPilot] Cleaned ${deleted} expired leave strategy cache entries`);
  }
  return deleted;
}

// --- Session helpers ---

function hashedSessionId(token) {
  return `sha256:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
}

export function createSession(token, userId, expiresAt) {
  return getDb().prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(hashedSessionId(token), userId, expiresAt);
}

export function getSession(token) {
  const db = getDb();
  const hashedId = hashedSessionId(token);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(hashedId);
  if (session) return session;

  const legacySession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(token);
  if (!legacySession) return undefined;

  db.prepare('UPDATE sessions SET id = ? WHERE id = ?').run(hashedId, token);
  return { ...legacySession, id: hashedId };
}

export function deleteSession(token) {
  return getDb()
    .prepare('DELETE FROM sessions WHERE id IN (?, ?)')
    .run(hashedSessionId(token), token);
}

export function deleteAllUserSessions(userId) {
  return getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function cleanExpiredSessions() {
  return getDb().prepare(
    "DELETE FROM sessions WHERE julianday(expires_at) < julianday('now')"
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

function normalizeScheduleIdentityKey(identityKey) {
  if (
    typeof identityKey !== 'string' ||
    identityKey.length < 1 ||
    identityKey.length > 128 ||
    !/^[A-Za-z0-9:_-]+$/.test(identityKey)
  ) {
    throw new TypeError('A valid schedule identity key is required');
  }
  return identityKey;
}

export function getDailySchedule(date, identityKey = 'legacy') {
  return getDb().prepare(
    'SELECT * FROM daily_schedule WHERE date = ? AND identity_key = ?'
  ).all(date, normalizeScheduleIdentityKey(identityKey));
}

export function setDailySchedule(date, actionType, resolvedTime, identityKey = 'legacy') {
  return getDb().prepare(
    "INSERT OR REPLACE INTO daily_schedule (date, identity_key, action_type, resolved_time, executed, last_status, attempts, last_error) VALUES (?, ?, ?, ?, 0, 'pending', 0, NULL)"
  ).run(date, normalizeScheduleIdentityKey(identityKey), actionType, resolvedTime);
}

export function markDailyScheduleExecuted(date, actionType, status = 'executed', error = null, identityKey = 'legacy') {
  return getDb().prepare(
    'UPDATE daily_schedule SET executed = 1, last_status = ?, last_error = ? WHERE date = ? AND identity_key = ? AND action_type = ?'
  ).run(status, error, date, normalizeScheduleIdentityKey(identityKey), actionType);
}

export function updateDailyScheduleStatus(date, actionType, status, error = null, incrementAttempts = false, identityKey = 'legacy') {
  const attemptsExpr = incrementAttempts ? 'attempts = attempts + 1,' : '';
  return getDb().prepare(
    `UPDATE daily_schedule SET ${attemptsExpr} last_status = ?, last_error = ? WHERE date = ? AND identity_key = ? AND action_type = ?`
  ).run(status, error, date, normalizeScheduleIdentityKey(identityKey), actionType);
}

// --- Strategy cache helpers ---

export function getStrategyCache(
  month,
  identityKey = currentExecutionLogIdentityKey(),
) {
  return getDb().prepare(
    'SELECT * FROM strategy_cache WHERE month = ? AND identity_key = ?',
  ).get(month, normalizeExecutionLogIdentityKey(identityKey)) || null;
}

export function setStrategyCache(
  month,
  data,
  identityKey = currentExecutionLogIdentityKey(),
) {
  return getDb().prepare(`
    INSERT OR REPLACE INTO strategy_cache (
      month, identity_key, direct_ok, approval_ok, time_clock_ok,
      best_strategy, detected_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
  `).run(
    month,
    normalizeExecutionLogIdentityKey(identityKey),
    data.direct_ok ? 1 : 0,
    data.approval_ok ? 1 : 0,
    data.time_clock_ok ? 1 : 0,
    data.best_strategy || 'direct'
  );
}

export function cleanOldSchedules(daysToKeep = 7) {
  const today = dateInTimezone(new Date(), resolveTimezone(process.env.TZ, getSetting('app_timezone')));
  return getDb().prepare(
    `DELETE FROM daily_schedule WHERE date < date(?, '-' || ? || ' days')`
  ).run(today, String(daysToKeep));
}

// --- Async task helpers ---

export function createAsyncTask(id, taskType, identity, result) {
  return getDb().prepare(`
    INSERT INTO async_tasks (
      id, task_type, identity_key, company_id, company_name, created_at, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskType,
    normalizeExecutionLogIdentityKey(identity?.identityKey),
    identity?.companyId || '',
    identity?.companyName || '',
    new Date().toISOString(),
    JSON.stringify(result),
  );
}

export function updateAsyncTask(
  id,
  identityKey,
  { status, result, error = null },
) {
  return getDb().prepare(
    'UPDATE async_tasks SET status = ?, completed_at = ?, result_json = ?, error_text = ? WHERE id = ? AND identity_key = ?'
  ).run(
    status,
    status === 'running' ? null : new Date().toISOString(),
    JSON.stringify(result),
    error,
    id,
    normalizeExecutionLogIdentityKey(identityKey),
  );
}

export function getAsyncTask(
  id,
  identityKey = currentExecutionLogIdentityKey(),
) {
  return getDb().prepare(
    'SELECT * FROM async_tasks WHERE id = ? AND identity_key = ?',
  ).get(id, normalizeExecutionLogIdentityKey(identityKey));
}

export function cleanOldAsyncTasks(hoursToKeep = 2) {
  if (!Number.isFinite(hoursToKeep) || hoursToKeep <= 0) throw new RangeError('Task retention must be positive');
  const cutoff = new Date(Date.now() - hoursToKeep * 3_600_000).toISOString();
  return getDb().prepare(
    `DELETE FROM async_tasks WHERE status != 'running' AND
      ((completed_at LIKE '%Z' AND completed_at < ?) OR
       (result_json IS NULL AND substr(created_at, 1, 10) < ?))`
  ).run(cutoff, cutoff.slice(0, 10));
}
