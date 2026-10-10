/**
 * crypto.js — Unit & Integration Tests
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import os from 'os';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let encrypt, decrypt;
const sandboxRoots = [];

function runCryptoSandbox(prepare, operation, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-crypto-sandbox-'));
  sandboxRoots.push(root);
  const serverDir = path.join(root, 'server');
  const dataDir = path.join(root, 'data');
  const keystoreDir = path.join(root, 'keystore');
  fs.mkdirSync(serverDir);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  const cryptoModule = path.join(serverDir, 'crypto.js');
  fs.copyFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), cryptoModule);
  fs.copyFileSync(path.join(PROJECT_ROOT, 'server', 'paths.js'), path.join(serverDir, 'paths.js'));
  prepare?.({ root, dataDir, keystoreDir });

  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const mod = await import(${JSON.stringify(pathToFileURL(cryptoModule).href)}); ${operation}`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_SECRET: '',
        PUNCHPILOT_KEYSTORE_DIR: keystoreDir,
        PUNCHPILOT_LEGACY_APP_SECRET_FILE: path.join(dataDir, '.app-secret'),
        ...extraEnv,
      },
    },
  );
  return { root, dataDir, keystoreDir, result };
}

beforeAll(async () => {
  const mod = await import(path.join(PROJECT_ROOT, 'server', 'crypto.js'));
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
});

afterEach(() => {
  for (const root of sandboxRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  it('rejects malformed IV, tag, ciphertext, and extra fields', () => {
    const valid = encrypt('test').split(':');
    expect(decrypt(`00:${valid[1]}:${valid[2]}`)).toBe('');
    expect(decrypt(`${valid[0]}:00:${valid[2]}`)).toBe('');
    expect(decrypt(`${valid[0]}:${valid[1]}:not-hex`)).toBe('');
    expect(decrypt(`${valid.join(':')}:extra`)).toBe('');
  });

  it('fails closed when APP_SECRET is shorter than 32 bytes', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import(${JSON.stringify(path.join(PROJECT_ROOT, 'server', 'crypto.js'))}).then((mod) => mod.encrypt('probe'))`,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: { ...process.env, APP_SECRET: 'short' },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('APP_SECRET must be at least 32 bytes');
  });
});

describe('key storage paths', () => {
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');

  it('defaults KEYSTORE_DIR to ../keystore and permits explicit test isolation', () => {
    const paths = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'paths.js'), 'utf8');
    expect(paths).toContain('process.env.PUNCHPILOT_KEYSTORE_DIR');
    expect(cryptoSrc).toContain('KEYSTORE_DIR, LEGACY_SECRET_FILE');
  });

  it('SECRET_FILE is in KEYSTORE_DIR', () => {
    expect(cryptoSrc).toContain("const SECRET_FILE = path.join(KEYSTORE_DIR, '.app-secret')");
  });

  it('defaults OLD_SECRET_FILE to data/ and permits explicit test isolation', () => {
    const paths = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'paths.js'), 'utf8');
    expect(paths).toContain('process.env.PUNCHPILOT_LEGACY_APP_SECRET_FILE');
    expect(cryptoSrc).toContain('const OLD_SECRET_FILE = LEGACY_SECRET_FILE');
  });

  it('keeps the active Vitest key lifecycle under the disposable run root', () => {
    const runRoot = path.resolve(process.env.PUNCHPILOT_TEST_RUN_ROOT);
    const keystoreDir = path.resolve(process.env.PUNCHPILOT_KEYSTORE_DIR);
    const legacySecretFile = path.resolve(
      process.env.PUNCHPILOT_LEGACY_APP_SECRET_FILE,
    );
    expect(path.relative(runRoot, keystoreDir)).not.toMatch(/^\.\.(?:[/\\]|$)/);
    expect(path.relative(runRoot, legacySecretFile)).not.toMatch(/^\.\.(?:[/\\]|$)/);
    encrypt('isolated-path-probe');
    expect(fs.existsSync(path.join(keystoreDir, '.app-secret'))).toBe(true);
  });

  it('uses punchpilot-salt for key derivation', () => {
    expect(cryptoSrc).toContain("'punchpilot-salt'");
  });
});

describe('migration logic', () => {
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');

  it('migrateSecretLocation() exists', () => {
    expect(cryptoSrc).toContain('function migrateSecretLocation()');
  });

  it('supports an atomic freee_username migration', () => {
    expect(cryptoSrc).toContain("['freee_username_encrypted'");
    expect(cryptoSrc).toContain("['freee_username', '']");
    expect(cryptoSrc).toContain('setSettingsAtomically(updates)');
  });

  it('uses punchpilot-salt for key derivation with no legacy code', () => {
    expect(cryptoSrc).toContain("'punchpilot-salt'");
    expect(cryptoSrc).not.toContain('decryptWithLegacyKey');
  });

  it('migrates a regular legacy secret without changing its value', () => {
    const secret = crypto.randomBytes(32).toString('hex');
    const { dataDir, keystoreDir, result } = runCryptoSandbox(
      ({ dataDir: sandboxData }) => {
        fs.writeFileSync(path.join(sandboxData, '.app-secret'), secret, { mode: 0o644 });
      },
      "mod.migrateEncryptionIfNeeded(() => '', () => {});",
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(dataDir, '.app-secret'))).toBe(false);
    expect(fs.readFileSync(path.join(keystoreDir, '.app-secret'), 'utf8')).toBe(secret);
    expect(fs.statSync(path.join(keystoreDir, '.app-secret')).mode & 0o777).toBe(0o600);
  });

  it('preserves both files and fails closed when legacy and current secrets conflict', () => {
    const legacySecret = crypto.randomBytes(32).toString('hex');
    const currentSecret = crypto.randomBytes(32).toString('hex');
    const { dataDir, keystoreDir, result } = runCryptoSandbox(
      ({ dataDir: sandboxData, keystoreDir: sandboxKeystore }) => {
        fs.mkdirSync(sandboxKeystore, { mode: 0o700 });
        fs.writeFileSync(path.join(sandboxData, '.app-secret'), legacySecret, { mode: 0o600 });
        fs.writeFileSync(path.join(sandboxKeystore, '.app-secret'), currentSecret, { mode: 0o600 });
      },
      "mod.migrateEncryptionIfNeeded(() => '', () => {});",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('application secrets conflict');
    expect(fs.readFileSync(path.join(dataDir, '.app-secret'), 'utf8')).toBe(legacySecret);
    expect(fs.readFileSync(path.join(keystoreDir, '.app-secret'), 'utf8')).toBe(currentSecret);
  });

  it('rejects a symbolic link as the current application secret', () => {
    const targetSecret = crypto.randomBytes(32).toString('hex');
    const { root, result } = runCryptoSandbox(
      ({ root: sandboxRoot, keystoreDir }) => {
        const target = path.join(sandboxRoot, 'secret-target');
        fs.mkdirSync(keystoreDir, { mode: 0o700 });
        fs.writeFileSync(target, targetSecret, { mode: 0o600 });
        fs.symlinkSync(target, path.join(keystoreDir, '.app-secret'));
      },
      "mod.encrypt('probe');",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('private regular file');
    expect(fs.readFileSync(path.join(root, 'secret-target'), 'utf8')).toBe(targetSecret);
  });

  it('fails closed when APP_SECRET conflicts with an existing keystore secret', () => {
    const storedSecret = crypto.randomBytes(32).toString('hex');
    const configuredSecret = crypto.randomBytes(32).toString('hex');
    const { keystoreDir, result } = runCryptoSandbox(
      ({ keystoreDir: sandboxKeystore }) => {
        fs.mkdirSync(sandboxKeystore, { mode: 0o700 });
        fs.writeFileSync(path.join(sandboxKeystore, '.app-secret'), storedSecret, { mode: 0o600 });
      },
      "mod.migrateEncryptionIfNeeded(() => '', () => {});",
      { APP_SECRET: configuredSecret },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('conflicts with the existing keystore secret');
    expect(fs.readFileSync(path.join(keystoreDir, '.app-secret'), 'utf8')).toBe(storedSecret);
  });

  it('persists a configured APP_SECRET when the keystore is empty', () => {
    const configuredSecret = crypto.randomBytes(32).toString('hex');
    const { keystoreDir, result } = runCryptoSandbox(
      undefined,
      "mod.migrateEncryptionIfNeeded(() => '', () => {});",
      { APP_SECRET: configuredSecret },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(keystoreDir, '.app-secret'), 'utf8')).toBe(configuredSecret);
    expect(fs.statSync(path.join(keystoreDir, '.app-secret')).mode & 0o777).toBe(0o600);
  });

  it('clears a matching crash-recovery plaintext value in one atomic update', () => {
    const username = 'recovery@example.com';
    const store = new Map([
      ['freee_username', username],
      ['freee_username_encrypted', encrypt(username)],
    ]);
    const atomicUpdates = [];

    const modPromise = import(path.join(PROJECT_ROOT, 'server', 'crypto.js'));
    return modPromise.then((mod) => {
      mod.migrateEncryptionIfNeeded(
        (key) => store.get(key) || '',
        () => {
          throw new Error('non-atomic setter must not be used');
        },
        (entries) => {
          atomicUpdates.push(entries);
          for (const [key, value] of entries) store.set(key, value);
        },
      );

      expect(atomicUpdates).toHaveLength(1);
      expect(store.get('freee_username')).toBe('');
      expect(decrypt(store.get('freee_username_encrypted'))).toBe(username);
    });
  });

  it('preserves both username representations when crash recovery finds a conflict', async () => {
    const mod = await import(path.join(PROJECT_ROOT, 'server', 'crypto.js'));
    const plaintext = 'expected@example.com';
    const encrypted = encrypt('different@example.com');
    const store = new Map([
      ['freee_username', plaintext],
      ['freee_username_encrypted', encrypted],
    ]);

    expect(() => mod.migrateEncryptionIfNeeded(
      (key) => store.get(key) || '',
      () => {
        throw new Error('non-atomic setter must not be used');
      },
      () => {
        throw new Error('conflicting values must not be written');
      },
    )).toThrow(/usernames conflict/);
    expect(store.get('freee_username')).toBe(plaintext);
    expect(store.get('freee_username_encrypted')).toBe(encrypted);
  });
});
