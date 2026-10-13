import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/ci/release-metadata-check.mjs');
const roots = [];

function fixture({ compose = '1.2.3', envExample = '1.2.3' } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pp-release-metadata-'));
  roots.push(root);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const lock = JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } });
  write('package.json', JSON.stringify({ version: '1.2.3' }));
  write('client/package.json', JSON.stringify({ version: '1.2.3' }));
  write('package-lock.json', lock);
  write('client/package-lock.json', lock);
  write('Dockerfile', 'LABEL org.opencontainers.image.version="1.2.3"\n');
  write('CHANGELOG.md', '# Changelog\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n- Example.\n');
  write('docker-compose.yml', compose === null
    ? 'services:\n  app:\n    image: example\n'
    : `services:\n  app:\n    image: \${PUNCHPILOT_IMAGE:-ghcr.io/sky-zhang01/punchpilot:${compose}}\n`);
  write('.env.example', envExample === null
    ? 'PORT=8681\n'
    : `# PUNCHPILOT_IMAGE=ghcr.io/sky-zhang01/punchpilot:${envExample}\n`);
  return root;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['GITHUB_REF', 'GITHUB_REF_NAME']) if (!(key in extra)) delete env[key];
  return env;
}

function check(root, args = ['--tag', 'v1.2.3'], env = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: cleanEnv(env) });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('release metadata check', () => {
  it('accepts matching image references in docker-compose.yml and .env.example', () => {
    const result = check(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('release metadata matches v1.2.3');
  });

  it('rejects a stale docker-compose.yml image tag', () => {
    const result = check(fixture({ compose: '1.2.2' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docker-compose.yml image tag 1.2.2 does not match 1.2.3');
  });

  it('rejects a stale .env.example image tag', () => {
    const result = check(fixture({ envExample: '1.2.2' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.env.example image tag 1.2.2 does not match 1.2.3');
  });

  it('reads tags that end a sentence or sit in quotes', () => {
    const root = fixture();
    fs.appendFileSync(path.join(root, '.env.example'), '# Example: ghcr.io/sky-zhang01/punchpilot:1.2.3.\n# "ghcr.io/sky-zhang01/punchpilot:1.2.3", (ghcr.io/sky-zhang01/punchpilot:1.2.3)\n');
    const result = check(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects decorated or nested image references', () => {
    for (const reference of ['1.2.3+build', '1.2.3/extra', '${OLD:-1.2.2}']) {
      const root = fixture();
      fs.appendFileSync(path.join(root, '.env.example'), `# PUNCHPILOT_IMAGE=ghcr.io/sky-zhang01/punchpilot:${reference}\n`);
      const result = check(root);
      expect(result.status, reference).toBe(1);
      expect(result.stderr).toContain('.env.example image tag');
    }
  });

  it('rejects files that no longer reference the published image', () => {
    const result = check(fixture({ compose: null, envExample: null }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docker-compose.yml does not reference ghcr.io/sky-zhang01/punchpilot:1.2.3');
    expect(result.stderr).toContain('.env.example does not reference ghcr.io/sky-zhang01/punchpilot:1.2.3');
  });

  it('ignores branch and pull request ref names when no tag is given', () => {
    for (const env of [
      { GITHUB_REF: 'refs/pull/135/merge', GITHUB_REF_NAME: '135' },
      { GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main' },
    ]) {
      const result = check(fixture(), [], env);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  it('checks the tag of a tag build when no tag is given', () => {
    const matching = check(fixture(), [], { GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_REF_NAME: 'v1.2.3' });
    expect(matching.status).toBe(0);
    const stale = check(fixture(), [], { GITHUB_REF: 'refs/tags/v1.2.2', GITHUB_REF_NAME: 'v1.2.2' });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('tag v1.2.2 does not match package version v1.2.3');
  });

  it('passes for the repository itself', () => {
    const result = check(path.resolve('.'), []);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
