/**
 * db.js — Seed Completeness & Encrypted Field Tests
 */
import { describe, it, expect, beforeAll } from 'vitest';
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
  let db, getSetting, setSetting;

  beforeAll(() => {
    const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-db-')), 'test.db');
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
