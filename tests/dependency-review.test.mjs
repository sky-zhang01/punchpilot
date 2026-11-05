import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const entry = new URL('../.gitea/scripts/dependency-review.mjs', import.meta.url);
const sourceAvailable = fs.existsSync(entry);
const sourcePolicyAvailable = fs.existsSync(new URL('../.public-export/allowlist.json', import.meta.url));
const review = sourceAvailable ? await import(entry.href) : null;

const lock = (packages) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });
const rootLock = lock({
  'node_modules/body-parser': { version: '2.4.0' },
  'node_modules/express/node_modules/body-parser': { version: '2.4.1' },
  'node_modules/aliased': { name: 'undici', version: '8.11.0' },
});
const clientLock = lock({ 'node_modules/undici': { version: '8.12.3' }, 'node_modules/vitest': { version: '5.0.5' } });
const files = { 'package-lock.json': rootLock, 'client/package-lock.json': clientLock };
const readLockfile = (file) => files[file] ?? null;

function response(body, total, status = 200) {
  const headers = new Headers(total === undefined ? {} : { 'x-total-count': String(total) });
  return { ok: status < 400, status, headers, json: async () => body };
}

describe('pre-release dependency review', () => {
  it('keeps the source-only entry and export policy availability coherent', () => {
    expect(sourceAvailable).toBe(sourcePolicyAvailable);
  });

  if (!sourceAvailable) return;

  it('compares versions and advisory ranges including prereleases', () => {
    expect(review.compareVersions('8.12.3', '8.12.2')).toBe(1);
    expect(review.compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(review.compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(review.inRange('8.12.1', '>= 8.0.0, < 8.12.2')).toBe(true);
    expect(review.inRange('8.12.2', '>= 8.0.0, < 8.12.2')).toBe(false);
    expect(review.inRange('2.3.0', '< 2.4.0')).toBe(true);
    expect(() => review.inRange('1.0.0', '~1.0.0')).toThrow(/unsupported range clause/);
    expect(() => review.inRange('1.0.0', '')).toThrow(/empty/);
  });

  it('reads every installed copy of a package, including aliases', () => {
    expect(review.lockfileVersions(rootLock, 'body-parser').sort()).toEqual(['2.4.0', '2.4.1']);
    expect(review.lockfileVersions(rootLock, 'undici')).toEqual(['8.11.0']);
    expect(() => review.lockfileVersions(JSON.stringify({ lockfileVersion: 1 }), 'x')).toThrow(/lockfileVersion/);
    expect(review.lockfileForManifest('client/package.json')).toBe('client/package-lock.json');
    expect(review.lockfileForManifest('/')).toBe('package-lock.json');
    expect(() => review.lockfileForManifest('../package-lock.json')).toThrow(/unsafe/);
  });

  it('treats an alert as handled only when the candidate lockfile is outside the range', () => {
    const alert = (number, name, manifest, range) => ({
      number,
      dependency: { package: { ecosystem: 'npm', name }, manifest_path: manifest },
      security_vulnerability: { vulnerable_version_range: range },
      security_advisory: { ghsa_id: 'GHSA-test', severity: 'high' },
    });
    expect(review.classifyAlert(alert(1, 'undici', 'client/package-lock.json', '>= 8.0.0, < 8.12.2'), readLockfile).handled).toBe(true);
    const rootUndici = review.classifyAlert(alert(2, 'undici', 'package-lock.json', '>= 8.0.0, < 8.12.2'), readLockfile);
    expect(rootUndici).toMatchObject({ handled: false, reason: expect.stringContaining('undici@8.11.0') });
    expect(review.classifyAlert(alert(3, 'left-pad', 'package-lock.json', '< 2.0.0'), readLockfile).reason).toContain('not installed');
    expect(review.classifyAlert(alert(4, 'x', 'docs/package-lock.json', '< 2.0.0'), readLockfile)).toMatchObject({ handled: false });
    const action = { ...alert(5, 'actions/checkout', '.github/workflows/ci.yml', '< 7'), dependency: { package: { ecosystem: 'actions', name: 'actions/checkout' } } };
    expect(review.classifyAlert(action, readLockfile)).toMatchObject({ handled: false, reason: expect.stringContaining('manually') });
  });

  it('accepts a Dependabot pull request only when the candidate already carries every update', () => {
    const single = { number: 21, title: 'chore(deps): bump body-parser from 2.3.0 to 2.4.0', body: 'Bumps [body-parser](https://example.invalid) from 2.3.0 to 2.4.0.' };
    const group = {
      number: 22,
      title: 'chore(deps-dev): bump the vitest-toolchain group across 1 directory with 2 updates',
      body: 'Bumps the vitest-toolchain group with 2 updates in the /client directory: a and b.\nUpdates `vitest` from 5.0.4 to 5.0.5\nUpdates `@vitest/coverage-v8` from 5.0.4 to 5.0.5\n',
    };
    const actions = { number: 23, title: 'chore(deps): bump the github-actions group across 1 directory with 2 updates', body: 'Bumps the github-actions group with 2 updates in the / directory: x.\nUpdates `actions/upload-artifact` from 7.0.1 to 7.0.2\n' };
    expect(review.classifyDependabotPr(single, readLockfile)).toMatchObject({ handled: true });
    expect(review.parseDependabotUpdates(group)).toEqual({
      lockfile: 'client/package-lock.json',
      updates: [{ name: 'vitest', to: '5.0.5' }, { name: '@vitest/coverage-v8', to: '5.0.5' }],
    });
    expect(review.classifyDependabotPr(group, readLockfile)).toMatchObject({ handled: false, reason: expect.stringContaining('@vitest/coverage-v8@5.0.5') });
    expect(review.classifyDependabotPr(actions, readLockfile).handled).toBe(false);
    expect(review.classifyDependabotPr({ ...actions, labels: [{ name: review.DEFERRED_LABEL }] }, readLockfile).handled).toBe(true);
    expect(review.classifyDependabotPr({ number: 1, title: 'chore: something else', body: '' }, readLockfile).reason).toContain('manually');
  });

  it('pages Gitea lists to the reported total and fails closed on truncation or errors', async () => {
    const pages = [[{ number: 1 }, { number: 2 }], [{ number: 3 }]];
    const calls = [];
    const fetchPages = async (url) => { calls.push(url); return response(pages[calls.length - 1] ?? [], 3); };
    await expect(review.giteaList('https://forge.invalid/api/v1', 't', '/x?state=open', fetchPages)).resolves.toHaveLength(3);
    expect(calls[0]).toBe('https://forge.invalid/api/v1/x?state=open&limit=50&page=1');
    await expect(review.giteaList('https://forge.invalid/api/v1', 't', '/x', async () => response([{ n: 1 }], undefined))).rejects.toThrow(/total count/);
    await expect(review.giteaList('https://forge.invalid/api/v1', 't', '/x', async () => response([], 2))).rejects.toThrow(/0 of 2/);
    await expect(review.giteaList('https://forge.invalid/api/v1', 't', '/x', async () => response({}, 1, 502))).rejects.toThrow(/HTTP 502/);
  });

  it('returns 1 while anything is unhandled and rejects loose arguments', async () => {
    const renovate = { number: 11, title: 'fix(deps): update client production dependencies', user: { login: review.RENOVATE_LOGIN }, head: { sha: 'a'.repeat(40) } };
    const human = { number: 12, title: 'ci: change', user: { login: 'maintainer' }, head: { sha: 'b'.repeat(40) } };
    const fetchImpl = async (url) => (url.includes('/status') ? response({ state: 'success' }) : response([renovate, human], 2));
    const ghBodies = {
      'pulls?state=open': [[{ number: 21, user: { login: 'dependabot[bot]', type: 'Bot' }, title: 'chore(deps): bump body-parser from 2.3.0 to 2.4.0', body: '' }]],
      'alerts?state=open': [[]],
    };
    const run = (command, args) => JSON.stringify(Object.entries(ghBodies).find(([key]) => args.at(-1).includes(key))[1]);
    let output = '';
    const deps = { fetch: fetchImpl, run, gitShow: (spec) => readLockfile(spec.split(':')[1]), write: (text) => { output += text; } };
    const env = { GITEA_API_URL: 'https://forge.invalid/api/v1', GITEA_TOKEN: 'placeholder' };
    const candidate = 'c'.repeat(40);
    await expect(review.main(['--candidate', candidate], env, deps)).resolves.toBe(1);
    expect(output).toContain('OPEN gitea#11');
    expect(output).toContain('ok   github#21');
    expect(output).not.toContain('gitea#12');
    const deferred = { ...renovate, labels: [{ name: review.DEFERRED_LABEL }] };
    deps.fetch = async (url) => (url.includes('/status') ? response({ state: 'failure' }) : response([deferred], 1));
    await expect(review.main(['--candidate', candidate], env, deps)).resolves.toBe(0);
    await expect(review.main(['--cand', candidate], env, deps)).rejects.toThrow();
    await expect(review.main(['--candidate', 'HEAD'], env, deps)).rejects.toThrow(/40-hex/);
    await expect(review.main(['--candidate', candidate], { ...env, GITEA_API_URL: 'http://forge.invalid/api/v1' }, deps)).rejects.toThrow(/https/);
  });
});
