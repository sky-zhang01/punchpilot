/**
 * crypto.js — Unit & Integration Tests
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let encrypt, decrypt;

beforeAll(async () => {
  const mod = await import(path.join(PROJECT_ROOT, 'server', 'crypto.js'));
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
});

describe('encrypt/decrypt round-trip', () => {
  it('should encrypt and decrypt ASCII text', () => {
    const original = 'test@example.com';
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it('should encrypt and decrypt Japanese Unicode', () => {
    const original = 'テスト太郎@フリー.co.jp';
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it('should encrypt and decrypt long text (10000 chars)', () => {
    const original = 'x'.repeat(10000);
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it('should encrypt and decrypt special characters', () => {
    const original = "p@$$w0rd!#%^&*()_+-=[]{}|;':\",./<>?`~";
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it('should produce different ciphertext for same plaintext (random IV)', () => {
    const enc1 = encrypt('same');
    const enc2 = encrypt('same');
    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe('same');
    expect(decrypt(enc2)).toBe('same');
  });
});

describe('encrypted format', () => {
  it('should have 3 colon-separated parts (iv:tag:cipher)', () => {
    const parts = encrypt('test').split(':');
    expect(parts).toHaveLength(3);
  });

  it('should have 32-char IV (16 bytes hex)', () => {
    const [iv] = encrypt('test').split(':');
    expect(iv).toHaveLength(32);
  });

  it('should have 32-char auth tag (16 bytes hex)', () => {
    const [, tag] = encrypt('test').split(':');
    expect(tag).toHaveLength(32);
  });
});

describe('edge cases', () => {
  it('encrypt("") returns ""', () => {
    expect(encrypt('')).toBe('');
  });

  it('encrypt(null) returns ""', () => {
    expect(encrypt(null)).toBe('');
  });

  it('encrypt(undefined) returns ""', () => {
    expect(encrypt(undefined)).toBe('');
  });

  it('decrypt("") returns ""', () => {
    expect(decrypt('')).toBe('');
  });

  it('decrypt(null) returns ""', () => {
    expect(decrypt(null)).toBe('');
  });

  it('decrypt("no-colons") returns "" (invalid format)', () => {
    expect(decrypt('no-colons')).toBe('');
  });

  it('decrypt with garbage ciphertext returns "" (no crash)', () => {
    const fake = 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(32);
    expect(decrypt(fake)).toBe('');
  });
});

describe('key storage paths', () => {
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');

  it('KEYSTORE_DIR points to ../keystore', () => {
    expect(cryptoSrc).toContain("const KEYSTORE_DIR = path.resolve(__dirname, '..', 'keystore')");
  });

  it('SECRET_FILE is in KEYSTORE_DIR', () => {
    expect(cryptoSrc).toContain("const SECRET_FILE = path.join(KEYSTORE_DIR, '.app-secret')");
  });

  it('OLD_SECRET_FILE points to data/ for migration', () => {
    expect(cryptoSrc).toContain("const OLD_SECRET_FILE = path.resolve(__dirname, '..', 'data', '.app-secret')");
  });

  it('uses punchpilot-salt-v2 for key derivation', () => {
    expect(cryptoSrc).toContain("'punchpilot-salt-v2'");
  });
});

describe('migration logic', () => {
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');

  it('migrateSecretLocation() exists', () => {
    expect(cryptoSrc).toContain('function migrateSecretLocation()');
  });

  it('securely overwrites old file before deleting', () => {
    const block = cryptoSrc.substring(
      cryptoSrc.indexOf('function migrateSecretLocation()'),
      cryptoSrc.indexOf('function getAppSecret()')
    );
    expect(block).toContain('crypto.randomBytes(64)');
    expect(block).toContain('fs.rmSync(OLD_SECRET_FILE)');
  });

  it('writes new key with 0o600 permissions', () => {
    expect(cryptoSrc).toContain("fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })");
  });

  it('migrates freee_username from plaintext to encrypted', () => {
    expect(cryptoSrc).toContain("setSetting('freee_username_encrypted', encrypt(plaintextUsername))");
    expect(cryptoSrc).toContain("setSetting('freee_username', '')");
  });

  it('uses punchpilot-salt-v2 for key derivation', () => {
    expect(cryptoSrc).toContain("'punchpilot-salt-v2'");
    expect(cryptoSrc).not.toContain('decryptWithLegacyKey');
  });

  it('simulated migration preserves secret value', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mig-'));
    const oldPath = path.join(tmpDir, 'old-secret');
    const newPath = path.join(tmpDir, 'new-secret');
    const secret = crypto.randomBytes(32).toString('hex');

    fs.writeFileSync(oldPath, secret);
    const read = fs.readFileSync(oldPath, 'utf8').trim();
    fs.writeFileSync(newPath, read, { mode: 0o600 });
    fs.writeFileSync(oldPath, crypto.randomBytes(64).toString('hex'));
    fs.rmSync(oldPath);

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(newPath, 'utf8')).toBe(secret);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
