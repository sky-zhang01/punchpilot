import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envModule = new URL('../server/env.js', import.meta.url).href;

function probe({ file, inherited, directory = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-env-'));
  try {
    if (directory) fs.mkdirSync(path.join(cwd, '.env'));
    else if (file != null) fs.writeFileSync(path.join(cwd, '.env'), file);
    fs.writeFileSync(path.join(cwd, 'capture.mjs'),
      'export const captured = process.env.PUNCHPILOT_ENV_PROBE;\n');
    fs.writeFileSync(path.join(cwd, 'entry.mjs'),
      `import ${JSON.stringify(envModule)};\n` +
      'import { captured } from "./capture.mjs";\n' +
      'console.log(JSON.stringify({ captured: captured ?? null }));\n');
    const env = { ...process.env };
    delete env.PUNCHPILOT_ENV_PROBE;
    if (inherited != null) env.PUNCHPILOT_ENV_PROBE = inherited;
    return spawnSync(process.execPath, ['entry.mjs'], { cwd, env, encoding: 'utf8' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe('environment initialization before static consumers', () => {
  it('loads the file before a sibling module captures configuration', () => {
    const result = probe({ file: 'PUNCHPILOT_ENV_PROBE="from file"\n' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ captured: 'from file' });
  });

  it('preserves the operator-provided environment over the file', () => {
    const result = probe({ file: 'PUNCHPILOT_ENV_PROBE=from-file\n', inherited: 'from-parent' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ captured: 'from-parent' });
  });

  it('allows a missing file', () => {
    const result = probe();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ captured: null });
  });

  it('does not swallow non-ENOENT file errors', () => {
    const result = probe({ directory: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EISDIR|ERR_INVALID_ARG_TYPE/);
  });

  it.each(['server.js', 'reset-password.js'])('%s loads env before application imports', (entry) => {
    const source = fs.readFileSync(path.join(root, 'server', entry), 'utf8');
    expect(source.match(/^import\s+[^\n]+/m)?.[0]).toMatch(/^import ['"]\.\/env\.js['"]/);
  });
});
