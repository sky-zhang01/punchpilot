/**
 * db.js — Seed Completeness & Encrypted Field Tests
 */
import { afterAll, describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let encrypt, decrypt;

beforeAll(async () => {
  const mod = await import(path.join(PROJECT_ROOT, 'server', 'crypto.js'));
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
});

describe('db.js seed completeness', () => {
  const dbSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'db.js'), 'utf8');

  const encryptedFields = [
    'freee_username_encrypted',
    'freee_password_encrypted',
    'web_employee_id_encrypted',
    'oauth_client_secret_encrypted',
    'oauth_access_token_encrypted',
    'oauth_refresh_token_encrypted',
  ];

  for (const field of encryptedFields) {
    it(`seeds "${field}"`, () => {
      expect(dbSrc).toContain(`insertSetting.run('${field}', '')`);
    });
  }

  it('seeds legacy freee_username (for migration)', () => {
    expect(dbSrc).toContain("insertSetting.run('freee_username', '')");
  });

  it('seeds OAuth auth breaker settings', () => {
    expect(dbSrc).toContain("insertSetting.run('oauth_auth_broken', '0')");
    expect(dbSrc).toContain("insertSetting.run('oauth_auth_broken_since', '')");
    expect(dbSrc).toContain("insertSetting.run('oauth_auth_broken_reason', '')");
  });

  it('migrates daily_schedule observability columns', () => {
    expect(dbSrc).toContain("ALTER TABLE daily_schedule ADD COLUMN last_status");
    expect(dbSrc).toContain("ALTER TABLE daily_schedule ADD COLUMN attempts");
    expect(dbSrc).toContain("ALTER TABLE daily_schedule ADD COLUMN last_error");
  });

  it('migrates legacy schedules into an isolated identity scope', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-db-schedule-migration-'));
    const dbPath = path.join(root, 'legacy.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE daily_schedule (
        date TEXT NOT NULL,
        action_type TEXT NOT NULL,
        resolved_time TEXT NOT NULL,
        executed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, action_type)
      );
      INSERT INTO daily_schedule (date, action_type, resolved_time, executed)
      VALUES ('2026-05-18', 'checkin', '09:55', 1);
    `);
    legacyDb.close();

    const script = `
      const module = await import('./server/db.js');
      module.initDatabase();
      const db = module.getDb();
      const columns = db.prepare('PRAGMA table_info(daily_schedule)').all();
      const row = db.prepare('SELECT * FROM daily_schedule').get();
      console.log(JSON.stringify({
        primaryKey: columns.filter((column) => column.pk).map((column) => column.name),
        row,
      }));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PUNCHPILOT_DB_PATH: dbPath },
    });
    const migrated = JSON.parse(output.trim().split('\n').at(-1));

    expect(migrated.primaryKey).toEqual(['date', 'identity_key', 'action_type']);
    expect(migrated.row).toMatchObject({
      date: '2026-05-18',
      identity_key: 'legacy',
      action_type: 'checkin',
      resolved_time: '09:55',
      executed: 1,
      last_status: 'pending',
      attempts: 0,
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('repairs an execution_log schema that has only one company column', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-db-partial-migration-'));
    const dbPath = path.join(root, 'partial.db');
    const partialDb = new Database(dbPath);
    partialDb.exec(`
      CREATE TABLE execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL,
        scheduled_time TEXT,
        executed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        status TEXT NOT NULL,
        trigger_type TEXT NOT NULL DEFAULT 'scheduled',
        error_message TEXT,
        screenshot_before TEXT,
        screenshot_after TEXT,
        duration_ms INTEGER,
        company_id TEXT
      )
    `);
    partialDb.close();

    const script = `
      const module = await import('./server/db.js');
      module.initDatabase();
      const columns = module.getDb().prepare('PRAGMA table_info(execution_log)').all();
      console.log(JSON.stringify(columns.map((column) => column.name)));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PUNCHPILOT_DB_PATH: dbPath },
    });
    const columns = JSON.parse(output.trim().split('\n').at(-1));

    expect(columns).toContain('company_id');
    expect(columns).toContain('company_name');
    expect(columns).toContain('identity_key');
    expect(columns).toContain('error_code');
    expect(columns).toContain('failure_stage');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('migrates legacy strategy caches and async tasks into an isolated scope', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-db-operation-migration-'));
    const dbPath = path.join(root, 'legacy.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE strategy_cache (
        month TEXT PRIMARY KEY,
        direct_ok INTEGER DEFAULT 1,
        approval_ok INTEGER DEFAULT 1,
        time_clock_ok INTEGER DEFAULT 1,
        best_strategy TEXT DEFAULT 'direct',
        detected_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO strategy_cache (month, direct_ok, approval_ok, best_strategy)
      VALUES ('2026-07', 0, 1, 'approval');

      CREATE TABLE async_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        completed_at TEXT,
        result_summary TEXT,
        error_text TEXT
      );
      INSERT INTO async_tasks (id, task_type) VALUES ('legacy-task', 'batch');
    `);
    legacyDb.close();

    const script = `
      const module = await import('./server/db.js');
      module.initDatabase();
      const database = module.getDb();
      const strategyColumns = database.prepare('PRAGMA table_info(strategy_cache)').all();
      const asyncColumns = database.prepare('PRAGMA table_info(async_tasks)').all();
      console.log(JSON.stringify({
        strategyPrimaryKey: strategyColumns
          .filter((column) => column.pk)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name),
        strategy: database.prepare('SELECT * FROM strategy_cache').get(),
        asyncColumns: asyncColumns.map((column) => column.name),
        task: database.prepare('SELECT * FROM async_tasks').get(),
      }));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PUNCHPILOT_DB_PATH: dbPath,
        PUNCHPILOT_INITIAL_ADMIN_PASSWORD: 'synthetic-initial-password-1234',
      },
    });
    const migrated = JSON.parse(output.trim().split('\n').at(-1));

    expect(migrated.strategyPrimaryKey).toEqual(['month', 'identity_key']);
    expect(migrated.strategy).toMatchObject({
      month: '2026-07',
      identity_key: 'legacy',
      direct_ok: 0,
      approval_ok: 1,
      best_strategy: 'approval',
    });
    expect(migrated.asyncColumns).toEqual(expect.arrayContaining([
      'identity_key',
      'company_id',
      'company_name',
    ]));
    expect(migrated.task).toMatchObject({
      id: 'legacy-task',
      identity_key: 'legacy',
      status: 'interrupted',
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('cross-reference: all encrypted getSetting calls have seeds', () => {
  const dbSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'db.js'), 'utf8');
  const configSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'routes', 'api-config.js'), 'utf8');
  const freeApiSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'freee-api.js'), 'utf8');
  const allSrc = configSrc + freeApiSrc;

  const referenced = new Set();
  const regex = /getSetting\('(\w+_encrypted)'\)/g;
  let m;
  while ((m = regex.exec(allSrc)) !== null) referenced.add(m[1]);

  for (const field of referenced) {
    it(`"${field}" referenced in routes has seed in db.js`, () => {
      expect(dbSrc).toContain(`'${field}'`);
    });
  }
});

describe('encrypted field CRUD via SQLite', () => {
  let db, root, getSetting, setSetting;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-db-'));
    const tmpPath = path.join(root, 'test.db');
    db = new Database(tmpPath);
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

    getSetting = (key) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    };
    setSetting = (key, value) => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    };

    // Seed
    setSetting('freee_username', '');
    setSetting('freee_username_encrypted', '');
    setSetting('freee_password_encrypted', '');
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores and retrieves encrypted username', () => {
    const user = 'user@example.com';
    setSetting('freee_username_encrypted', encrypt(user));
    expect(decrypt(getSetting('freee_username_encrypted'))).toBe(user);
  });

  it('stores and retrieves encrypted password', () => {
    const pass = 'p@$$w0rd!';
    setSetting('freee_password_encrypted', encrypt(pass));
    expect(decrypt(getSetting('freee_password_encrypted'))).toBe(pass);
  });

  it('clears plaintext username on save', () => {
    setSetting('freee_username', '');
    expect(getSetting('freee_username')).toBe('');
  });

  it('handles delete (clear all)', () => {
    setSetting('freee_username_encrypted', '');
    setSetting('freee_password_encrypted', '');
    expect(decrypt(getSetting('freee_username_encrypted') || '')).toBe('');
  });
});
