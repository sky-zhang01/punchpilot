import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoots = [];

const verifyScript = `
  import fs from 'node:fs';
  import bcrypt from 'bcryptjs';
  const configuredPassword = process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD;
  const { initDatabase, getUserByUsername } = await import('./server/db.js');
  initDatabase();
  const user = getUserByUsername('admin');
  const password = configuredPassword
    || fs.readFileSync(process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE, 'utf8').trim();
  if (!user || !bcrypt.compareSync(password, user.password_hash)) process.exit(7);
  process.stdout.write('bootstrap-ok\\n');
`;

function runBootstrap(extraEnv = {}, prepare = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-bootstrap-admin-'));
  tempRoots.push(root);
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(serverDir);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(projectRoot, 'server'), serverDir, { recursive: true });
  fs.cpSync(path.join(projectRoot, 'shared'), path.join(root, 'shared'), { recursive: true });
  fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const passwordFile = path.join(root, 'keystore', 'initial-admin-password');
  const passwordSource = extraEnv.PUNCHPILOT_INITIAL_ADMIN_PASSWORD
    ? {}
    : { PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE: passwordFile };
  if (prepare) prepare({ root, passwordFile });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', verifyScript], {
    cwd: root,
    env: {
      ...process.env,
      PUNCHPILOT_DB_PATH: path.join(root, 'data', 'punchpilot.db'),
      PUNCHPILOT_KEYSTORE_DIR: path.join(root, 'keystore'),
      PUNCHPILOT_LEGACY_APP_SECRET_FILE: path.join(root, 'data', '.app-secret'),
      PUNCHPILOT_INITIAL_ADMIN_PASSWORD: '',
      APP_SECRET: `bootstrap-test-${'x'.repeat(48)}`,
      ...passwordSource,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return { root, passwordFile, result };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('initial administrator bootstrap', () => {
  it('generates a private high-entropy password file without logging it or local paths', () => {
    const { root, passwordFile, result } = runBootstrap();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const password = fs.readFileSync(passwordFile, 'utf8').trim();
    expect(Buffer.byteLength(password, 'utf8')).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(passwordFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(passwordFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'data')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'data', 'punchpilot.db')).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm']) {
      const artifact = path.join(root, 'data', `punchpilot.db${suffix}`);
      if (fs.existsSync(artifact)) {
        expect(fs.statSync(artifact).mode & 0o777).toBe(0o600);
      }
    }
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain('admin / admin');
  });

  it('accepts a strong operator-provided bootstrap password without writing it to logs', () => {
    const password = `Synthetic-${'A1b2'.repeat(8)}`;
    const { result } = runBootstrap({ PUNCHPILOT_INITIAL_ADMIN_PASSWORD: password });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain(password);
    expect(result.stderr).not.toContain(password);
  });

  it('reuses an existing private password file without replacing it', () => {
    const password = `Synthetic-${'B2c3'.repeat(8)}`;
    const { passwordFile, result } = runBootstrap({}, ({ passwordFile: file }) => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${password}\n`, { mode: 0o600 });
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.readFileSync(passwordFile, 'utf8').trim()).toBe(password);
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain('Generated an initial administrator password');
  });

  it('fails closed on a weak operator-provided bootstrap password', () => {
    const { result } = runBootstrap({ PUNCHPILOT_INITIAL_ADMIN_PASSWORD: 'short' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be at least 16 bytes');
    expect(result.stderr).not.toContain('short');
  });

  it('rejects an operator-provided password file with broad permissions', () => {
    const { result } = runBootstrap({}, ({ passwordFile }) => {
      fs.mkdirSync(path.dirname(passwordFile), { recursive: true });
      fs.writeFileSync(passwordFile, `Synthetic-${'C3d4'.repeat(8)}\n`);
      fs.chmodSync(passwordFile, 0o644);
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be a private regular file');
  });

  it('rejects a symbolic link as the bootstrap password file', () => {
    const { result } = runBootstrap({}, ({ root, passwordFile }) => {
      const target = path.join(root, 'password-target');
      fs.mkdirSync(path.dirname(passwordFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, `Synthetic-${'D4e5'.repeat(8)}\n`, { mode: 0o600 });
      fs.symlinkSync(target, passwordFile);
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be a private regular file');
  });

  it('rejects a symbolic link as the SQLite database file', () => {
    const { result } = runBootstrap({}, ({ root }) => {
      const target = path.join(root, 'database-target');
      fs.writeFileSync(target, 'not-a-database', { mode: 0o600 });
      fs.symlinkSync(target, path.join(root, 'data', 'punchpilot.db'));
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Database files must be private regular files');
    expect(result.stderr).not.toContain('database-target');
  });
});
