import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookSource = path.join(projectRoot, '.githooks', 'pre-push');
const installerSource = path.join(projectRoot, 'scripts', 'install-publication-hook.mjs');
const privacyGate = path.join(projectRoot, 'scripts', 'ci', 'public-release-privacy-gate.py');
const sourceGate = path.join(projectRoot, 'scripts', 'ci', 'source-ci-gate.py');
const tempRoots = [];
const trustedHooks = new Map();
const installedSourceGates = new Map();

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pre-push-hook-'));
  tempRoots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Synthetic Fixture');
  git(root, 'config', 'user.email', 'synthetic-fixture@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'punchpilot.publicRemote', 'origin');
  git(root, 'config', 'punchpilot.sourceRemote', 'source');
  git(root, 'config', 'punchpilot.sourceRef', 'refs/remotes/source/main');
  git(root, 'config', 'punchpilot.publicationForbiddenHosts', 'private.example.invalid');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/punchpilot.git');
  git(root, 'remote', 'add', 'source', 'https://source.example.invalid/example/punchpilot.git');
  const ciDirectory = path.join(root, 'scripts', 'ci');
  fs.mkdirSync(ciDirectory, { recursive: true });
  fs.copyFileSync(privacyGate, path.join(ciDirectory, 'public-release-privacy-gate.py'));
  fs.copyFileSync(sourceGate, path.join(ciDirectory, 'source-ci-gate.py'));
  fs.mkdirSync(path.join(root, '.githooks'));
  fs.copyFileSync(hookSource, path.join(root, '.githooks', 'pre-push'));
  fs.copyFileSync(installerSource, path.join(root, 'scripts', 'install-publication-hook.mjs'));
  fs.chmodSync(path.join(root, '.githooks', 'pre-push'), 0o755);
  fs.chmodSync(path.join(root, 'scripts', 'install-publication-hook.mjs'), 0o755);
  for (const directory of ['.gitea/workflows', '.github/workflows']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, 'ci.yml'), 'name: CI\non: push\n');
  }
  fs.writeFileSync(path.join(root, 'README.md'), '# synthetic fixture\n');
  git(root, 'add', 'README.md', 'scripts', '.githooks', '.gitea', '.github');
  git(root, 'commit', '-q', '-m', 'initial synthetic fixture');
  git(root, 'update-ref', 'refs/remotes/source/main', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-trusted-hook-'));
  tempRoots.push(trustedRoot);
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-config-'));
  tempRoots.push(configRoot);
  const sourceConfig = path.join(configRoot, 'source-ci-gate.json');
  fs.writeFileSync(sourceConfig, `${JSON.stringify({
    version: 1,
    apiBaseUrl: 'https://source.example.invalid/api/v1',
    repository: { owner: 'example', name: 'punchpilot' },
    credentialFile: '/private/synthetic/source-token',
    expectedActor: 'reviewer',
    gitTransportUrls: ['http://127.0.0.1:13000/example/punchpilot.git'],
  })}\n`, { mode: 0o600 });
  execFileSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'install-publication-hook.mjs'),
      '--target', trustedRoot,
      '--source-config', sourceConfig,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  installedSourceGates.set(
    root,
    git(root, 'config', '--local', '--get', 'punchpilot.sourceGateExecutable'),
  );
  writeGate(trustedRoot, 'source-ci-gate.py');
  trustedHooks.set(root, path.join(trustedRoot, 'pre-push'));
  return root;
}

function writeGate(root, relativePath, mode = 0o700) {
  const gate = path.join(root, relativePath);
  fs.writeFileSync(gate, '#!/bin/sh\nexit 0\n', { mode });
  fs.chmodSync(gate, mode);
  return gate;
}

function runHook(
  root,
  remoteUrl = 'https://github.com/example/punchpilot.git',
  remoteName = 'origin',
  input = '',
  env = {},
) {
  return spawnSync(trustedHooks.get(root), [remoteName, remoteUrl], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  trustedHooks.clear();
  installedSourceGates.clear();
});

describe('public pre-push source gate trust boundary', () => {
  it('installs the active hook outside the candidate repository', () => {
    const root = createRepo();
    const hooksPath = git(root, 'config', '--local', '--get', 'core.hooksPath');

    expect(path.relative(root, hooksPath)).toMatch(/^\.\./);
    expect(fs.statSync(hooksPath).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(hooksPath, 'pre-push')).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(hooksPath, 'public-release-privacy-gate.py')).mode & 0o177).toBe(0);
    expect(fs.statSync(path.join(hooksPath, 'source-ci-gate.py')).mode & 0o077).toBe(0);
    expect(installedSourceGates.get(root))
      .toBe(path.join(hooksPath, 'source-ci-gate.py'));
    const installedConfig = JSON.parse(
      fs.readFileSync(path.join(hooksPath, 'source-ci-gate.json'), 'utf8'),
    );
    expect(installedConfig.version).toBe(2);
    expect(installedConfig.promotionCommit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(installedConfig.trustedWorkflowTrees).toEqual({
      '.gitea/workflows': git(root, 'rev-parse', 'HEAD:.gitea/workflows'),
      '.github/workflows': git(root, 'rev-parse', 'HEAD:.github/workflows'),
    });
  });

  it('copies only an external private source configuration', () => {
    const root = createRepo();
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-config-'));
    tempRoots.push(externalRoot);
    const config = path.join(externalRoot, 'source-ci-gate.json');
    fs.writeFileSync(config, `${JSON.stringify({
      version: 1,
      apiBaseUrl: 'https://source.example.invalid/api/v1',
      repository: { owner: 'example', name: 'punchpilot' },
      credentialFile: '/private/synthetic/source-token',
      expectedActor: 'reviewer',
      gitTransportUrls: ['http://127.0.0.1:13000/example/punchpilot.git'],
    })}\n`, { mode: 0o600 });
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-install-'));
    tempRoots.push(installRoot);

    const accepted = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts', 'install-publication-hook.mjs'),
        '--target',
        installRoot,
        '--source-config',
        config,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    const installed = JSON.parse(
      fs.readFileSync(path.join(installRoot, 'source-ci-gate.json'), 'utf8'),
    );
    expect(installed).toMatchObject({
      version: 2,
      apiBaseUrl: 'https://source.example.invalid/api/v1',
      repository: { owner: 'example', name: 'punchpilot' },
      expectedActor: 'reviewer',
      gitTransportUrls: ['http://127.0.0.1:13000/example/punchpilot.git'],
      promotionCommit: git(root, 'rev-parse', 'HEAD'),
    });
    expect(installed.trustedWorkflowTrees).toEqual({
      '.gitea/workflows': git(root, 'rev-parse', 'HEAD:.gitea/workflows'),
      '.github/workflows': git(root, 'rev-parse', 'HEAD:.github/workflows'),
    });
    expect(fs.statSync(path.join(installRoot, 'source-ci-gate.json')).mode & 0o077).toBe(0);

    fs.chmodSync(config, 0o644);
    const rejected = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts', 'install-publication-hook.mjs'),
        '--target',
        installRoot,
        '--source-config',
        config,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('must not be accessible');
    expect(rejected.stderr).not.toContain(config);
  });

  it('overwrites prior trust fields with the new clean exact commit', () => {
    const root = createRepo();
    const hooksPath = path.dirname(trustedHooks.get(root));
    const installedConfig = path.join(hooksPath, 'source-ci-gate.json');
    const previous = JSON.parse(fs.readFileSync(installedConfig, 'utf8'));
    fs.appendFileSync(path.join(root, 'README.md'), 'reviewed update\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'reviewed update');

    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts', 'install-publication-hook.mjs'),
        '--target', hooksPath,
        '--source-config', installedConfig,
      ],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    const updated = JSON.parse(fs.readFileSync(installedConfig, 'utf8'));
    expect(updated.promotionCommit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(updated.promotionCommit).not.toBe(previous.promotionCommit);
    expect(typeof updated.promotionCommit).toBe('string');
    expect(updated.trustedWorkflowTrees).toEqual(previous.trustedWorkflowTrees);
  });

  it('rejects installation from a dirty checkout', () => {
    const root = createRepo();
    const hooksPath = path.dirname(trustedHooks.get(root));
    const installedConfig = path.join(hooksPath, 'source-ci-gate.json');
    fs.appendFileSync(path.join(root, 'README.md'), 'unreviewed update\n');

    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts', 'install-publication-hook.mjs'),
        '--target', hooksPath,
        '--source-config', installedConfig,
      ],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('clean reviewed checkout');
  });

  it('refuses to install the trusted hook inside the candidate repository', () => {
    const root = createRepo();
    const sourceConfig = path.join(
      path.dirname(trustedHooks.get(root)),
      'source-ci-gate.json',
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts', 'install-publication-hook.mjs'),
        '--target',
        path.join(root, '.trusted-hooks'),
        '--source-config',
        sourceConfig,
      ],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outside the repository');
    expect(result.stderr).not.toContain(root);
  });

  it('fails closed when the configured public remote URL is not approved', () => {
    const root = createRepo();
    git(root, 'remote', 'set-url', 'origin', 'git@github-work:example/punchpilot.git');

    const result = runHook(root, 'git@github-work:example/punchpilot.git');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not use an approved GitHub URL');
    expect(result.stderr).not.toContain('github-work');
  });

  it('rejects an alternate remote or SSH alias even when it resembles GitHub', () => {
    const root = createRepo();

    const result = runHook(
      root,
      'git@github-work:example/punchpilot.git',
      'temporary-public',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not the configured source or public remote');
    expect(result.stderr).not.toContain('github-work');
  });

  it('requires an E-only consumer even for the exact configured public URL', () => {
    const root = createRepo();
    const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-gate-'));
    tempRoots.push(trustedRoot);
    const gate = writeGate(trustedRoot, 'gate.sh');
    git(root, 'config', 'punchpilot.sourceGateExecutable', gate);

    const publicUrl = 'https://github.com/example/punchpilot.git';
    const result = runHook(root, publicUrl, publicUrl);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E-only consumer');
  });

  it('allows the configured source remote without public promotion state', () => {
    const root = createRepo();

    const result = runHook(
      root,
      'https://source.example.invalid/example/punchpilot.git',
      'source',
    );

    expect(result.status).toBe(0);
  });

  it('allows a private-configured loopback source transport only through the source role', () => {
    const root = createRepo();
    const transportUrl = 'http://127.0.0.1:13000/example/punchpilot.git';
    git(root, 'remote', 'set-url', '--push', 'source', transportUrl);

    const sourceResult = runHook(root, transportUrl, 'source');
    const publicResult = runHook(root, transportUrl, 'origin');

    expect(sourceResult.status, sourceResult.stderr).toBe(0);
    expect(publicResult.status).toBe(1);
    expect(publicResult.stderr).toContain('not the configured source or public remote');
    expect(publicResult.stderr).not.toContain(transportUrl);
  });

  it('rejects source and public roles that resolve to the same canonical destination', () => {
    const root = createRepo();
    git(root, 'remote', 'set-url', 'source', 'git@github.com:example/punchpilot.git');

    const result = runHook(
      root,
      'git@github.com:example/punchpilot.git',
      'source',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('destinations must be distinct');
  });

  it('rejects the source role when the invocation points at the public destination', () => {
    const root = createRepo();

    const result = runHook(
      root,
      'https://github.com/example/punchpilot.git',
      'source',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the configured source remote destination');
  });

  it('validates the trusted source binding before taking the source fast path', () => {
    const root = createRepo();
    const trustedRoot = path.dirname(trustedHooks.get(root));
    const gateArguments = path.join(trustedRoot, 'source-binding-arguments.txt');
    fs.writeFileSync(
      path.join(trustedRoot, 'source-ci-gate.py'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${gateArguments}'\n`,
      { mode: 0o700 },
    );

    const result = runHook(
      root,
      'https://source.example.invalid/example/punchpilot.git',
      'source',
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(fs.readFileSync(gateArguments, 'utf8')).toBe('--validate-source-destination\n');
  });

  it('rejects source pushes when remote roles are not configured explicitly', () => {
    const root = createRepo();
    git(root, 'config', '--unset', 'punchpilot.sourceRemote');

    const result = runHook(
      root,
      'https://source.example.invalid/example/punchpilot.git',
      'source',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('remote roles must be configured explicitly');
  });

  it('ignores a configured candidate gate and uses the installed sibling gate', () => {
    const root = createRepo();
    const marker = path.join(root, '.candidate-gate-executed');
    const gate = path.join(root, 'candidate-controlled-gate.sh');
    fs.writeFileSync(gate, '#!/bin/sh\ntouch .candidate-gate-executed\nexit 99\n', {
      mode: 0o700,
    });
    git(root, 'config', 'punchpilot.sourceGateExecutable', gate);

    const result = runHook(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E-only consumer');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects a source gate writable by group or other users', () => {
    const root = createRepo();
    const gate = path.join(path.dirname(trustedHooks.get(root)), 'source-ci-gate.py');
    fs.chmodSync(gate, 0o722);

    const result = runHook(root);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(gate);
  });

  it('does not authorize a public source-workspace write through an external gate', () => {
    const root = createRepo();

    const result = runHook(root);

    expect(result.status).toBe(1);
  });

  it('refuses every public write from a source checkout before executing candidate programs', () => {
    const root = createRepo();
    const result = runHook(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('independently installed E-only consumer');
  });
});
