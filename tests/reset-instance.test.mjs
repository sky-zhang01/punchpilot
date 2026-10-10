import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function resetFixture(prepare, input = 'RESET\n') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pp-reset-'));
  const selected = path.join(root, 'selected');
  const untouched = path.join(root, 'other');
  fs.mkdirSync(selected);
  fs.mkdirSync(untouched);
  for (const name of ['keys', 'logs', 'shots']) fs.mkdirSync(path.join(selected, name));
  fs.writeFileSync(path.join(selected, 'attendance.db'), 'synthetic db');
  fs.writeFileSync(path.join(selected, 'keys', '.app-secret'), 'synthetic key');
  fs.writeFileSync(path.join(selected, 'keys', 'unrelated'), 'keep');
  fs.writeFileSync(path.join(selected, 'logs', 'punchpilot.log'), 'synthetic log');
  fs.writeFileSync(path.join(untouched, 'attendance.db'), 'other db');
  const externalPasswordFile = path.join(untouched, 'initial-password');
  fs.writeFileSync(externalPasswordFile, 'synthetic external password');
  try {
    const overrides = prepare?.({ root, selected, untouched });
    const result = spawnSync(process.execPath, [path.resolve('server/reset-password.js')], {
      cwd: root, input, encoding: 'utf8', env: { ...process.env,
        PUNCHPILOT_DB_PATH: path.join(selected, 'attendance.db'),
        PUNCHPILOT_KEYSTORE_DIR: path.join(selected, 'keys'),
        PUNCHPILOT_LOG_DIR: path.join(selected, 'logs'),
        SCREENSHOTS_DIR: path.join(selected, 'shots'),
        PUNCHPILOT_LEGACY_APP_SECRET_FILE: path.join(selected, '.app-secret'),
        PUNCHPILOT_INITIAL_ADMIN_PASSWORD: '',
        PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE: '',
        ...overrides,
      },
    });
    return { result, databaseRemains: fs.existsSync(path.join(selected, 'attendance.db')),
      keyRemains: fs.existsSync(path.join(selected, 'keys', '.app-secret')),
      unrelatedKey: fs.readFileSync(path.join(selected, 'keys', 'unrelated'), 'utf8'),
      externalPassword: fs.readFileSync(externalPasswordFile, 'utf8'),
      otherDb: fs.readFileSync(path.join(untouched, 'attendance.db'), 'utf8') };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it('resets only selected instance files and preserves unrelated keystore entries', () => {
  const state = resetFixture();
  expect(state.result.stdout).toContain('Factory reset complete');
  expect(state.result.stdout).toContain('A new one-time administrator password will be generated');
  expect(state.databaseRemains).toBe(false);
  expect(state.keyRemains).toBe(false);
  expect(state.unrelatedKey).toBe('keep');
  expect(state.otherDb).toBe('other db');
});

it('checks all reset paths before deleting anything', () => {
  const state = resetFixture(({ selected }) => fs.writeFileSync(path.join(selected, 'shots', 'unrelated.txt'), 'keep'));
  expect(state.result.stderr).toContain('factory reset failed');
  expect(state.databaseRemains).toBe(true);
  expect(state.keyRemains).toBe(true);
});

it('preserves a configured external password file and explains the restart source', () => {
  const state = resetFixture(({ untouched }) => ({
    PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE: path.join(untouched, 'initial-password'),
  }));
  expect(state.result.stdout).toContain('Factory reset complete');
  expect(state.result.stdout).toContain('Configured initial administrator password sources remain in effect');
  expect(state.result.stdout).not.toContain('A new one-time administrator password will be generated');
  expect(state.externalPassword).toBe('synthetic external password');
  expect(state.databaseRemains).toBe(false);
  expect(state.keyRemains).toBe(false);
});

it('preserves all files when confirmation is declined', () => {
  const state = resetFixture(null, 'CANCEL\n');
  expect(state.result.status).toBe(0);
  expect(state.databaseRemains).toBe(true);
  expect(state.keyRemains).toBe(true);
});

it('rejects a directory in a file slot before deleting the database', () => {
  const state = resetFixture(({ selected }) => { fs.mkdirSync(path.join(selected, '.app-secret')); });
  expect(state.result.stderr).toContain('factory reset failed');
  expect(state.databaseRemains).toBe(true);
  expect(state.keyRemains).toBe(true);
});

it('rejects a symlink anywhere above a target without touching another instance', () => {
  const state = resetFixture(({ selected, untouched }) => {
    fs.mkdirSync(path.join(untouched, 'nested'));
    fs.writeFileSync(path.join(untouched, 'nested', 'attendance.db'), 'keep');
    fs.symlinkSync(untouched, path.join(selected, 'alias'));
    return { PUNCHPILOT_DB_PATH: path.join(selected, 'alias', 'nested', 'attendance.db') };
  });
  expect(state.result.stderr).toContain('factory reset failed');
  expect(state.databaseRemains).toBe(true);
  expect(state.keyRemains).toBe(true);
  expect(state.otherDb).toBe('other db');
});
