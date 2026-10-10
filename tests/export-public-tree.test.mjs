import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildProvenance,
  canonicalPolicyJson,
  compilePolicy,
  computePolicyHash,
  exportPublicTree,
  parseAllowlist,
  SCHEMA_ID,
} from '../scripts/ci/export-public-tree.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exportScript = path.join(projectRoot, 'scripts', 'ci', 'export-public-tree.mjs');
const privacyGate = path.join(projectRoot, 'scripts', 'ci', 'public-release-privacy-gate.py');
const committedAllowlistPath = path.join(projectRoot, '.public-export', 'allowlist.json');
const sourceWorkflowMarker = path.join(projectRoot, '.gitea', 'workflows', 'ci.yml');
const sourcePolicyIt = fs.existsSync(sourceWorkflowMarker) ? it : it.skip;
const tempRoots = [];
let previousForbiddenHosts;
beforeEach(() => {
  previousForbiddenHosts = process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS;
  process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS = 'private.example.invalid';
});

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-export-public-tree-'));
  tempRoots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'README.md'), '# clean\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

function writeFile(root, rel, contents, { executable = false } = {}) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  if (executable) fs.chmodSync(full, 0o755);
}

function writePolicy(root, policy) {
  fs.mkdirSync(path.join(root, '.public-export'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.public-export', 'allowlist.json'),
    JSON.stringify(policy, null, 2),
  );
}

function writePathsetAssertingGate(root, tracePath) {
  const gatePath = path.join(root, '.fixture-tools', 'pathset-gate.py');
  fs.mkdirSync(path.dirname(gatePath), { recursive: true });
  fs.writeFileSync(
    gatePath,
    `import json
import pathlib
import sys

args = sys.argv[1:]
try:
    ref = args[args.index("--export-tree") + 1]
    provenance_path = args[args.index("--allowlist-pathset") + 1]
    with open(provenance_path, "r", encoding="utf-8") as stream:
        provenance = json.load(stream)
    if provenance.get("exportedTree") != ref:
        raise ValueError("exported tree mismatch")
    pathset = provenance.get("pathset")
    if not isinstance(pathset, list) or pathset != sorted(pathset):
        raise ValueError("pathset is not normalized")
    pathlib.Path(${JSON.stringify(tracePath)}).write_text(json.dumps({
        "provenancePath": provenance_path,
        "ref": ref,
        "pathset": pathset,
    }), encoding="utf-8")
except Exception:
    sys.exit(3)
`,
  );
  return gatePath;
}

function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

function runScript(root, ...args) {
  return spawnSync('node', [exportScript, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PUBLIC_RELEASE_FORBIDDEN_HOSTS: 'private.example.invalid' },
  });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function sourceCiScan(root, event, { head = git(root, 'rev-parse', 'HEAD'), base, forbiddenHosts = 'private.example.invalid' } = {}) {
  const workflow = fs.readFileSync(sourceWorkflowMarker, 'utf8');
  const step = workflow.slice(
    workflow.indexOf('      - name: Public content baseline scan\n'),
    workflow.indexOf('      - name: Runtime forbidden host absence check\n'),
  );
  const script = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length)
    .split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  return spawnSync('bash', ['-c', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: event, PR_HEAD_SHA: head,
      PR_BASE_SHA: base, PUSH_BASE_SHA: base, PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHosts },
  });
}

function sourceCiFixture() {
  const root = createRepo();
  const base = git(root, 'rev-parse', 'HEAD');
  for (const name of ['export-public-tree.mjs', 'publication-contract.mjs', 'public-release-privacy-gate.py']) {
    writeFile(root, `scripts/ci/${name}`, fs.readFileSync(path.join(projectRoot, 'scripts/ci', name)));
  }
  writePolicy(root, { $schema: SCHEMA_ID, version: 1, include: ['README.md'], exclude: ['.gitea/', '.public-export/', 'scripts/'] });
  writeFile(root, '.gitea/internal.txt', `private.example.invalid\n${secretCanary()}`);
  writeFile(root, 'README.md', secretCanary());
  commitAll(root, 'source history with synthetic canary');
  writeFile(root, 'README.md', '# clean public export\n');
  commitAll(root, 'clean public candidate');
  return { root, base };
}

// Content the public-release privacy gate flags as a secret regardless of the
// path it lives at (AWS access key ID). Used as the divergent-export canary.
// Assembled at runtime via segmented concat so no committed fixture carries a
// literal forbidden key (same technique the privacy-gate tests use).
function secretCanary() {
  const awsAccessKeyId = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  return `aws_access_key_id = ${awsAccessKeyId}\n`;
}

afterEach(() => {
  if (previousForbiddenHosts === undefined) delete process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS;
  else process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS = previousForbiddenHosts;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('export-public-tree allowlist parser conformance', () => {
  it('accepts and normalizes a valid v1 allowlist', () => {
    const policy = parseAllowlist(
      JSON.stringify({
        $schema: SCHEMA_ID,
        version: 1,
        include: ['server/b/', 'README.md', 'docs/'],
        exclude: ['docs/internal/'],
      }),
    );
    expect(policy.version).toBe(1);
    // directory specs keep a trailing slash; arrays are sorted.
    expect(policy.include).toEqual(['README.md', 'docs/', 'server/b/']);
    expect(policy.exclude).toEqual(['docs/internal/']);
  });

  it('normalizes backslashes and collapsed slashes', () => {
    const policy = parseAllowlist(
      JSON.stringify({
        $schema: SCHEMA_ID,
        version: 1,
        include: ['server\\deep\\'],
        exclude: [],
      }),
    );
    expect(policy.include).toEqual(['server/deep/']);
  });

  it.each([
    ['bad schema', { $schema: 'wrong', version: 1, include: [], exclude: [] }],
    ['wrong version', { $schema: SCHEMA_ID, version: 2, include: [], exclude: [] }],
    ['non-object', '[]', true],
    ['include not array', { $schema: SCHEMA_ID, version: 1, include: 'x', exclude: [] }],
    ['empty spec', { $schema: SCHEMA_ID, version: 1, include: [''], exclude: [] }],
    ['leading slash', { $schema: SCHEMA_ID, version: 1, include: ['/x'], exclude: [] }],
    ['parent segment', { $schema: SCHEMA_ID, version: 1, include: ['a/../b'], exclude: [] }],
    ['duplicate spec', { $schema: SCHEMA_ID, version: 1, include: ['a'], exclude: ['a'] }],
  ])('rejects an invalid allowlist: %s', (_label, doc, raw) => {
    const text = raw ? doc : JSON.stringify(doc);
    expect(() => parseAllowlist(text)).toThrow();
  });

  it('rejects a NUL byte in a path-spec', () => {
    expect(() =>
      parseAllowlist(
        JSON.stringify({
          $schema: SCHEMA_ID,
          version: 1,
          include: ['a\0b'],
          exclude: [],
        }),
      ),
    ).toThrow();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseAllowlist('{not json')).toThrow(/not valid JSON/);
  });
});

describe('export-public-tree policy compiler', () => {
  const policy = parseAllowlist(
    JSON.stringify({
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/', 'docs/'],
      exclude: ['server/internal/', 'docs/secret.txt'],
    }),
  );
  const decide = compilePolicy(policy);

  it('includes exact files and directory prefixes', () => {
    expect(decide('README.md')).toBe('include');
    expect(decide('server/a.js')).toBe('include');
    expect(decide('docs/readme.md')).toBe('include');
  });

  it('redacts excluded paths (exclude wins over include)', () => {
    expect(decide('server/internal/key.pem')).toBe('exclude');
    expect(decide('docs/secret.txt')).toBe('exclude');
  });

  it('marks uncovered paths as unlisted (default-deny)', () => {
    expect(decide('internal/leak.txt')).toBe('unlisted');
    expect(decide('new-top-level.json')).toBe('unlisted');
  });

  it('does not treat a bare directory name as included by its prefix', () => {
    // 'server/' matches 'server/x' but not exactly 'server' as a leaf file.
    expect(decide('server')).toBe('unlisted');
  });

  it('produces a deterministic policy hash invariant to key order', () => {
    const a = parseAllowlist(
      JSON.stringify({ $schema: SCHEMA_ID, version: 1, include: ['b/', 'a'], exclude: ['c'] }),
    );
    const b = parseAllowlist(
      JSON.stringify({ $schema: SCHEMA_ID, version: 1, exclude: ['c'], include: ['a', 'b/'] }),
    );
    expect(computePolicyHash(a)).toBe(computePolicyHash(b));
    expect(canonicalPolicyJson(a)).toBe(canonicalPolicyJson(b));
  });
});

describe('export-public-tree divergent export-build', () => {
  sourcePolicyIt.each(['pull_request', 'push', 'workflow_dispatch'])('actual source CI %s caller scans E with mandatory policy and fatal warnings', (event) => {
    const { root, base } = sourceCiFixture();
    const clean = sourceCiScan(root, event, { base });
    expect(clean.status, output(clean)).toBe(0);
    const summary = JSON.parse(output(clean).slice(output(clean).indexOf('{')));
    expect(summary.verifiedClean).toBe(true);
    expect(summary.sourceCommit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'ls-tree', '-r', '--name-only', summary.exportedTree)).toBe('README.md');
    expect(summary.provenance.excludedPaths).toContain('.gitea/internal.txt');

    writeFile(root, 'README.md', secretCanary());
    commitAll(root, 'canary in actual exported path');
    const leaking = sourceCiScan(root, event, { base });
    expect(leaking.status).not.toBe(0);
    expect(output(leaking)).toContain('[FAIL]');
    expect(output(leaking)).not.toContain(secretCanary().trim());

    writeFile(root, 'README.md', `follow issue #${123}\n`);
    commitAll(root, 'warning in actual exported path');
    const warning = sourceCiScan(root, event, { base });
    expect(warning.status).not.toBe(0);
    expect(output(warning)).toContain('[WARN]');

    writeFile(root, 'README.md', '# clean again\n');
    commitAll(root, 'clean current export');
    const missingPolicy = sourceCiScan(root, event, { base, forbiddenHosts: '' });
    expect(missingPolicy.status).not.toBe(0);
    expect(output(missingPolicy)).toContain('PUBLIC_RELEASE_FORBIDDEN_HOSTS');
  }, 30000);

  sourcePolicyIt('rejects a source PR head different from the checked out policy snapshot before export', () => {
    const { root, base } = sourceCiFixture();
    const result = sourceCiScan(root, 'pull_request', { base, head: base });
    expect(result.status).not.toBe(0);
    expect(output(result)).not.toContain('OK - exported tree');
  });

  it('rejects an empty mandatory forbidden-host policy on the real export CLI', () => {
    const root = createRepo();
    writePolicy(root, { $schema: SCHEMA_ID, version: 1, include: ['README.md'], exclude: [] });
    const result = spawnSync(process.execPath, [exportScript, '--source', 'HEAD'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PUBLIC_RELEASE_FORBIDDEN_HOSTS: '' },
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('PUBLIC_RELEASE_FORBIDDEN_HOSTS');
  });
  it('scans the actual annotated source tag alongside E before the export CLI succeeds', () => {
    const root = createRepo();
    writePolicy(root, { $schema: SCHEMA_ID, version: 1, include: ['README.md'], exclude: [] });
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'private.example.invalid');
    const result = runScript(root, '--source', 'v1.2.3', '--source-tag', 'v1.2.3');
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('tag metadata: forbidden internal hostname');
    expect(output(result)).not.toContain('verified-clean.');
  });
  it('makes a real source-tag privacy warning fatal on the export CLI', () => {
    const root = createRepo();
    writePolicy(root, { $schema: SCHEMA_ID, version: 1, include: ['README.md'], exclude: [] });
    git(root, 'tag', '-a', 'v1.2.3', '-m', `follow issue #${123}`);
    const result = runScript(root, '--source', 'v1.2.3', '--source-tag', 'v1.2.3');
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('[WARN]');
  });
  it('the real source-tag CLI imports the reviewed public asset and rejects missing, wrong or tampered signing material', () => {
    const root = createRepo(), home = fs.mkdtempSync('/tmp/pp-export-key-');
    fs.chmodSync(home, 0o700);
    try {
      const options = execFileSync('gpg', ['--dump-options'], { encoding: 'utf8' });
      fs.writeFileSync(path.join(home, 'gpg.conf'), `disable-signer-uid\n${options.includes('--compatibility-flags') ? 'compatibility-flags no-manu\n' : ''}`);
      execFileSync('gpg', ['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Public Fixture <fixture@example.invalid>', 'ed25519', 'sign', '1d'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const fingerprint = execFileSync('gpg', ['--homedir', home, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
      execFileSync('git', ['-c', 'gpg.format=openpgp', '-c', 'gpg.program=gpg', '-c', `user.signingkey=${fingerprint}`, 'tag', '-s', 'v1.2.3', '-m', 'clean release tag'], { cwd: root, env: { ...process.env, GNUPGHOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      writePolicy(root, { $schema: SCHEMA_ID, version: 1, include: ['README.md'], exclude: ['.public-export/'] });
      const asset = path.join(root, '.public-export/public-signing-keys.asc');
      expect(runScript(root, '--source', 'v1.2.3', '--source-tag', 'v1.2.3').status).toBe(1);
      const certificate = execFileSync('gpg', ['--homedir', home, '--batch', '--armor', '--export', fingerprint], { stdio: ['ignore', 'pipe', 'pipe'] });
      fs.writeFileSync(asset, certificate);
      const valid = runScript(root, '--source', 'v1.2.3', '--source-tag', 'v1.2.3');
      expect(valid.status, output(valid)).toBe(0);
      const raw = execFileSync('git', ['cat-file', 'tag', 'v1.2.3'], { cwd: root });
      const changed = execFileSync('git', ['hash-object', '-w', '-t', 'tag', '--stdin'], { cwd: root, input: Buffer.from(raw.toString().replace('clean release tag', 'changed release tag')), encoding: 'utf8' }).trim();
      const tampered = runScript(root, '--source', 'v1.2.3', '--source-tag', changed);
      expect(tampered.status).toBe(1); expect(output(tampered)).toContain('signature material');
      fs.writeFileSync(asset, 'fixture');
      expect(runScript(root, '--source', 'v1.2.3', '--source-tag', 'v1.2.3').status).toBe(1);
    } finally {
      execFileSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
  it('passes the exact normalized E pathset into the privacy scan and removes the scratch file', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'module.exports = 1;\n');
    commitAll(root, 'add clean public content');
    const policy = parseAllowlist(JSON.stringify({
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: [],
    }));
    const tracePath = path.join(root, '.fixture-tools', 'trace.json');
    const assertingGate = writePathsetAssertingGate(root, tracePath);

    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy,
      scan: true,
      privacyGate: assertingGate,
    });

    expect(result.scanResult.ok).toBe(true);
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    expect(trace.ref).toBe(result.treeSha);
    expect(trace.pathset).toEqual(result.pathset);
    expect(fs.existsSync(trace.provenancePath)).toBe(false);
  });

  it('materializes a public tree larger than the subprocess default buffer', () => {
    const root = createRepo();
    for (const name of ['first', 'second', 'third']) {
      writeFile(root, `server/${name}.txt`, '# clean\n'.repeat(75000));
    }
    commitAll(root, 'add normal sized public files');
    const policy = parseAllowlist(JSON.stringify({
      $schema: SCHEMA_ID, version: 1, include: ['README.md', 'server/'], exclude: [],
    }));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-export-out-'));
    tempRoots.push(outDir);
    exportPublicTree({ repoRoot: root, policy, scan: false, outDir });
    expect(fs.readFileSync(path.join(outDir, 'server/third.txt'), 'utf8'))
      .toBe('# clean\n'.repeat(75000));
  });

  it('preserves a tracked path named __proto__ without mutating the tree builder', () => {
    const root = createRepo();
    writeFile(root, 'server/__proto__/app.js', 'module.exports = 1;\n');
    commitAll(root, 'add special path');
    const policy = parseAllowlist(JSON.stringify({
      $schema: SCHEMA_ID, version: 1, include: ['README.md', 'server/'], exclude: [],
    }));
    const result = exportPublicTree({ repoRoot: root, policy, scan: false });
    expect(git(root, 'ls-tree', '-r', '--name-only', result.treeSha).split('\n'))
      .toContain('server/__proto__/app.js');
    expect({}.app).toBeUndefined();
  });

  it('rejects exported symbolic links before materialization', () => {
    const root = createRepo();
    fs.symlinkSync('/etc/passwd', path.join(root, 'public-link'));
    commitAll(root, 'add symbolic link');
    const policy = parseAllowlist(JSON.stringify({
      $schema: SCHEMA_ID, version: 1, include: ['README.md', 'public-link'], exclude: [],
    }));
    expect(() => exportPublicTree({ repoRoot: root, policy, scan: false }))
      .toThrow('regular files');
  });

  it('builds a verified-clean artifact with provenance for a clean source', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'module.exports = 1;\n', { executable: true });
    writeFile(root, 'docs/guide.md', '# Guide\n');
    commitAll(root, 'add clean public content');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/', 'docs/'],
      exclude: [],
    });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-export-out-'));
    tempRoots.push(outDir);

    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: parseAllowlist(fs.readFileSync(path.join(root, '.public-export', 'allowlist.json'), 'utf8')),
      outDir,
      scan: true,
      privacyGate,
      publicBase: git(root, 'rev-parse', 'HEAD~'),
    });

    expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.scanResult.ok).toBe(true);
    expect(result.unlisted).toEqual([]);
    // materialized tree contains the clean content with mode preserved.
    expect(fs.existsSync(path.join(outDir, 'server/app.js'))).toBe(true);
    expect(result.provenance).toMatchObject({
      schema: 'public-export-provenance/v1',
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
      exportedTree: result.treeSha,
      intendedPublicBase: git(root, 'rev-parse', 'HEAD~'),
    });
    expect(result.provenance.pathset).toContain('server/app.js');
    expect(result.provenance.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance.excludedPaths).toEqual([]);
  });

  it('redacts an excluded path so it is ABSENT from E (divergence)', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'public\n');
    writeFile(root, 'server/internal/key.pem', 'private-key-material\n');
    commitAll(root, 'add public + internal-only content');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: ['server/internal/'],
    });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-export-out-'));
    tempRoots.push(outDir);

    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: parseAllowlist(fs.readFileSync(path.join(root, '.public-export', 'allowlist.json'), 'utf8')),
      outDir,
      scan: true,
      privacyGate,
    });

    // The internal-only path was excluded -> divergent artifact.
    expect(result.excludedPaths).toEqual(['server/internal/key.pem']);
    expect(result.pathset).not.toContain('server/internal/key.pem');
    // And it is provably absent from the materialized export.
    expect(fs.existsSync(path.join(outDir, 'server/internal/key.pem'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'server/internal'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'server/app.js'))).toBe(true);
    expect(result.treeSha).not.toBe(result.sourceTree);
  });

  it('FAILS the export when a new unlisted top-level path is present (default-deny)', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'public\n');
    writeFile(root, 'untracked-new-dir/leak.txt', 'never listed in policy\n');
    commitAll(root, 'add an unlisted top-level directory');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: [],
    });

    let thrown;
    try {
      exportPublicTree({
        repoRoot: root,
        source: 'HEAD',
        policy: parseAllowlist(fs.readFileSync(path.join(root, '.public-export', 'allowlist.json'), 'utf8')),
        scan: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('UNLISTED');
    expect(thrown.unlisted).toContain('untracked-new-dir/leak.txt');
  });

  it('FAILS the export via the CLI with a non-zero exit on an unlisted path', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'public\n');
    writeFile(root, 'top-secret.txt', 'never listed\n');
    commitAll(root, 'add unlisted file');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: [],
    });

    const result = runScript(root, '--source', 'HEAD', '--no-scan');

    expect(result.status).toBe(1);
    expect(output(result)).toContain('default-deny');
    expect(output(result)).toContain('top-secret.txt');
  });

  it('FAILS the export with code UNLISTED when an unlisted path like ops/deploy.md is present', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'public\n');
    writeFile(root, 'ops/deploy.md', 'unlisted deployment file\n');
    commitAll(root, 'add unlisted ops file');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: [],
    });

    let thrown;
    try {
      exportPublicTree({
        repoRoot: root,
        source: 'HEAD',
        policy: parseAllowlist(fs.readFileSync(path.join(root, '.public-export', 'allowlist.json'), 'utf8')),
        scan: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('UNLISTED');
    expect(thrown.unlisted).toContain('ops/deploy.md');
  });

  it('catches a secret canary inside an allowed path in the exported tree', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', secretCanary());
    commitAll(root, 'canary inside an allowed path');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: [],
    });

    let thrown;
    try {
      exportPublicTree({
        repoRoot: root,
        source: 'HEAD',
        policy: parseAllowlist(fs.readFileSync(path.join(root, '.public-export', 'allowlist.json'), 'utf8')),
        scan: true,
        privacyGate,
      });
    } catch (error) {
      thrown = error;
    }
    // The canary entered E and the gate rejected it -> not verified-clean.
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('NOT_CLEAN');
  });

  it('passes when a secret canary lives under an EXCLUDED path (provably absent from E)', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'clean\n');
    writeFile(root, 'server/internal/canary.txt', secretCanary());
    commitAll(root, 'canary inside an excluded path');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: ['server/internal/'],
    });

    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: parseAllowlist(fs.readFileSync(path.join(root, '.public-export', 'allowlist.json'), 'utf8')),
      scan: true,
      privacyGate,
    });

    // The redacted canary never reaches E, so the clean export succeeds.
    expect(result.scanResult.ok).toBe(true);
    expect(result.excludedPaths).toContain('server/internal/canary.txt');
    expect(result.pathset).not.toContain('server/internal/canary.txt');
  });

  it('emits a JSON summary with --json and a provenance file under --out', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'public\n');
    commitAll(root, 'clean content');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: [],
    });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-export-out-'));
    tempRoots.push(outDir);

    const result = runScript(
      root,
      '--source',
      'HEAD',
      '--out',
      outDir,
      '--json',
    );
    expect(result.status, output(result)).toBe(0);
    const summary = JSON.parse(
      output(result).slice(output(result).indexOf('{')),
    );
    expect(summary.exportedTree).toMatch(/^[0-9a-f]{40}$/);
    expect(summary.verifiedClean).toBe(true);
    expect(summary.includedPaths).toBeGreaterThanOrEqual(2);
    const provenanceFile = path.join(outDir, '.public-export-provenance.json');
    expect(fs.existsSync(provenanceFile)).toBe(true);
    const provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
    expect(provenance.exportedTree).toBe(summary.exportedTree);
    expect(provenance.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('succeeds via CLI with exit status 0 and prints [DIVERGENT] when an exclude spec redacts a leaf from E', () => {
    const root = createRepo();
    writeFile(root, 'server/app.js', 'public content\n');
    writeFile(root, 'server/internal/secret.key', 'internal secret\n');
    commitAll(root, 'add public and internal files');
    writePolicy(root, {
      $schema: SCHEMA_ID,
      version: 1,
      include: ['README.md', 'server/'],
      exclude: ['server/internal/'],
    });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-export-out-'));
    tempRoots.push(outDir);

    const result = runScript(
      root,
      '--source',
      'HEAD',
      '--out',
      outDir,
      '--no-scan',
    );

    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('[DIVERGENT]');
    expect(fs.existsSync(path.join(outDir, 'server/internal/secret.key'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'server/app.js'))).toBe(true);
  });
});

describe('export-public-tree provenance pathsetSha256 determinism', () => {
  it('computes pathsetSha256 deterministically invariant to input path order (path list digest only)', () => {
    const policy = parseAllowlist(
      JSON.stringify({ $schema: SCHEMA_ID, version: 1, include: ['README.md', 'a/', 'b/'], exclude: [] }),
    );
    const policyHash = computePolicyHash(policy);

    const prov1 = buildProvenance({
      sourceCommit: '0000000000000000000000000000000000000001',
      sourceTree: '0000000000000000000000000000000000000002',
      treeSha: '0000000000000000000000000000000000000003',
      policy,
      policyHash,
      pathset: ['b/file2.js', 'a/file1.js', 'README.md'],
      excluded: [],
    });

    const prov2 = buildProvenance({
      sourceCommit: '0000000000000000000000000000000000000001',
      sourceTree: '0000000000000000000000000000000000000002',
      treeSha: '0000000000000000000000000000000000000003',
      policy,
      policyHash,
      pathset: ['README.md', 'a/file1.js', 'b/file2.js'],
      excluded: [],
    });

    expect(prov1.pathsetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prov1.pathsetSha256).toBe(prov2.pathsetSha256);
  });
});

describe('export-public-tree committed seed allowlist (real repo)', () => {
  sourcePolicyIt('enforces complete path coverage: every leaf in HEAD is explicitly classified (no unlisted paths)', () => {
    const policy = parseAllowlist(fs.readFileSync(committedAllowlistPath, 'utf8'));
    const decide = compilePolicy(policy);

    // CI checks out a detached HEAD with no local `main`/`origin/main` ref, so
    // reproduce against HEAD (the PR head = the public-clean tree under test).
    // The seed covers every leaf of HEAD: main's tree plus this change's own
    // export tooling (.public-export/, scripts/, tests/).
    const entries = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)
      .map((line) => line.split('\t')[1]);
    for (const entry of entries) {
      expect(decide(entry), `unlisted: ${entry}`).not.toBe('unlisted');
    }
  });

  sourcePolicyIt('tracks the approved divergence snapshot (E excludes exactly the approved paths)', () => {
    const policy = parseAllowlist(fs.readFileSync(committedAllowlistPath, 'utf8'));

    // The owner-approved policy made the export deliberately divergent: the
    // approved exclusion set removes internal-only
    // paths, so E is no longer byte-identical to S.
    const result = exportPublicTree({
      repoRoot: projectRoot,
      source: 'HEAD',
      policy,
      scan: false,
    });
    // Review every source-only leaf, including the runner protocol helper and
    // closed publisher caller. Enumerate HEAD before and after their commit,
    // while rejecting any unreviewed file under the excluded directory.
    const approvedSourceOnlyPaths = [
      '.gitea/scripts/runner-protocol-check.mjs',
      '.gitea/workflows/branch-housekeeping.yml',
      '.gitea/workflows/ci.yml',
      '.gitea/workflows/internal-release-check.yml',
      '.gitea/workflows/public-release.yml',
      '.gitea/workflows/public-governance-check.yml',
    ];
    const sourceOnlyPaths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '.gitea'], {
      cwd: projectRoot, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    for (const file of sourceOnlyPaths) expect(approvedSourceOnlyPaths).toContain(file);
    const publicExportPaths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '.public-export'], { cwd: projectRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const file of publicExportPaths) expect(['.public-export/README.md', '.public-export/allowlist.json', '.public-export/public-signing-keys.asc']).toContain(file);
    expect(result.excludedPaths).toEqual([
      ...sourceOnlyPaths,
      ...publicExportPaths,
      'docs/branching.md',
      'tests/dependency-install-policy.test.mjs',
    ]);
    expect(result.treeSha).not.toBe(result.sourceTree);
    expect(result.unlisted).toEqual([]);
  });

  sourcePolicyIt('proves every approved excluded leaf is ABSENT from the produced exported tree E', () => {
    const policy = parseAllowlist(fs.readFileSync(committedAllowlistPath, 'utf8'));

    // Pin the approved exclusion set so policy changes require this control
    // to be consciously updated.
    expect(policy.exclude).toEqual([
      '.gitea/',
      '.public-export/',
      'docs/branching.md',
      'tests/dependency-install-policy.test.mjs',
    ]);

    const result = exportPublicTree({
      repoRoot: projectRoot,
      source: 'HEAD',
      policy,
      scan: false,
    });

    // Absence is read from the produced artifact — the exported tree E the
    // exporter actually built (result.treeSha) — not inferred from a clean
    // scanner report. (The full-repo tree is enumerated via ls-tree rather
    // than materializeTree, whose execFileSync buffer cannot hold the whole
    // repository archive.)
    const exportedLeaves = execFileSync(
      'git',
      ['ls-tree', '-r', '-z', '--full-tree', result.treeSha],
      { cwd: projectRoot, encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean)
      .map((line) => line.split('\t')[1]);
    expect(exportedLeaves).toHaveLength(result.pathset.length);
    const exported = new Set(exportedLeaves);

    for (const excludedPath of result.excludedPaths) {
      expect(
        exported.has(excludedPath),
        `excluded path present in E: ${excludedPath}`,
      ).toBe(false);
      expect(result.pathset, `excluded path in pathset: ${excludedPath}`).not.toContain(excludedPath);
    }
    // The excluded directories are gone entirely, not merely emptied.
    expect([...exported].some((leaf) => leaf.startsWith('.gitea/'))).toBe(false);
    expect([...exported].some((leaf) => leaf.startsWith('.public-export/'))).toBe(false);

    // Passthrough anchors that must stay public.
    expect(exported.has('CLAUDE.md')).toBe(true);
    expect(exported.has('data/.gitkeep')).toBe(true);
    expect([...exported].some((leaf) => leaf.startsWith('.githooks/'))).toBe(true);
    expect(exported.has('scripts/ci/export-public-tree.mjs')).toBe(true);
    expect(exported.has('docs/releases.md')).toBe(true);
    expect(exported.has('docs/security-threat-model.md')).toBe(true);
  });
});
