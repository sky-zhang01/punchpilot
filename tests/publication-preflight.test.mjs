import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withPublicGpgContext } from '../scripts/ci/publication-contract.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preflight = path.join(projectRoot, 'scripts', 'ci', 'publication-preflight.mjs');
const tempRoots = [];
const botName = 'punchpilot-release-bot[bot]';
const botEmail = '4366822+punchpilot-release-bot[bot]@users.noreply.github.com';
const fixtureVersion = 'v1.2.3';
const fixturePolicyHash = 'b'.repeat(64);
let fixtureSigningKey;
let signingFixture;
const fakePgpSignature = Buffer.from(
  '-----BEGIN PGP SIGNATURE-----\n\nZmFrZS1zaWduYXR1cmU=\n=abcd\n' +
    '-----END PGP SIGNATURE-----\n',
);

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitWithInput(root, input, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-publication-preflight-'));
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

function runPreflightWithEnv(root, env, ...args) {
  return spawnSync('node', [preflight, '--repo-name', 'fixture', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUBLIC_RELEASE_FORBIDDEN_HOSTS: 'private.example.invalid',
      ...env,
    },
  });
}

function runPreflight(root, ...args) {
  return runPreflightWithEnv(root, {}, ...args);
}

function runPreflightWithoutHosts(root, ...args) {
  return spawnSync('node', [preflight, '--repo-name', 'fixture', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUBLIC_RELEASE_FORBIDDEN_HOSTS: '',
    },
  });
}

function runRawPreflight(root, ...args) {
  return spawnSync('node', [preflight, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUBLIC_RELEASE_FORBIDDEN_HOSTS: '',
    },
  });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (!signingFixture) return;
  try {
    execFileSync('gpgconf', ['--homedir', signingFixture.home, '--kill', 'all'], { stdio: 'ignore' });
  } finally {
    fs.rmSync(signingFixture.home, { recursive: true, force: true });
  }
});

function publicationSigningFixture() {
  if (signingFixture) return signingFixture;
  const home = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'pp-preflight-key-'));
  fs.chmodSync(home, 0o700);
  signingFixture = { home };
  const options = execFileSync('gpg', ['--dump-options'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(home, 'gpg.conf'), `disable-signer-uid\n${options.includes('--compatibility-flags') ? 'compatibility-flags no-manu\n' : ''}`);
  execFileSync('gpg', ['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Preflight Fixture <fixture@example.invalid>', 'ed25519', 'sign', '1d'], { stdio: 'ignore' });
  fixtureSigningKey = execFileSync('gpg', ['--homedir', home, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
  signingFixture.certificate = execFileSync('gpg', ['--homedir', home, '--batch', '--armor', '--export', fixtureSigningKey], { stdio: ['ignore', 'pipe', 'pipe'] });
  return signingFixture;
}

describe('publication preflight trusted base validation', () => {
  it('passes mandatory host and fatal-warning flags to the actual Python scanner', () => {
    const root = createRepo();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-preflight-python-')); tempRoots.push(bin);
    const actualPython = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    const trace = path.join(bin, 'argv.json');
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'python3'), `#!/usr/bin/env node\nimport fs from 'node:fs'; import { spawnSync } from 'node:child_process'; fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2))); const result=spawnSync(${JSON.stringify(actualPython)}, process.argv.slice(2), {stdio:'inherit'});process.exit(result.status ?? 1);\n`, { mode: 0o700 });
    const result = runPreflightWithEnv(root, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, '--head', 'HEAD');
    expect(result.status, output(result)).toBe(0);
    const argv = JSON.parse(fs.readFileSync(trace));
    expect(argv).toContain('--require-forbidden-hosts'); expect(argv).toContain('--fail-on-warn');
  });
  it('makes an actual generic publication privacy warning fatal', () => {
    const root = createRepo();
    fs.appendFileSync(path.join(root, 'README.md'), 'clean change\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', `follow issue #${123}`);
    const result = runPreflight(root, '--head', 'HEAD');
    expect(result.status).toBe(1); expect(output(result)).toContain('[WARN]');
  });
  it('prints help without starting a privacy scan', () => {
    const root = createRepo();

    const result = runRawPreflight(root, '--help');

    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('Usage: publication-preflight.mjs');
    expect(output(result)).not.toContain('public-release privacy');
  });

  it('rejects unsupported, missing, and duplicate arguments before scanning', () => {
    const root = createRepo();
    const unsupported = runRawPreflight(root, '--unexpected');
    const missing = runRawPreflight(root, '--base');
    const duplicate = runRawPreflight(root, '--head', 'HEAD', '--head', 'HEAD');
    const duplicateTreeOnly = runRawPreflight(root, '--tree-only', '--tree-only');

    expect(unsupported.status).toBe(1);
    expect(output(unsupported)).toContain('unsupported publication preflight argument');
    expect(missing.status).toBe(1);
    expect(output(missing)).toContain('missing a value');
    expect(duplicate.status).toBe(1);
    expect(output(duplicate)).toContain('duplicate publication preflight argument');
    expect(duplicateTreeOnly.status).toBe(1);
    expect(output(duplicateTreeOnly)).toContain('duplicate publication preflight argument');
    for (const result of [unsupported, missing, duplicate, duplicateTreeOnly]) {
      expect(output(result)).not.toContain('no public-release privacy findings');
    }
  });

  it('rejects tree-only scanning with a history base', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');

    const result = runPreflight(
      root,
      '--head',
      'HEAD',
      '--tree-only',
      '--base',
      base,
    );

    expect(result.status).toBe(1);
    expect(output(result)).toContain('--tree-only cannot be combined with --base');
    expect(output(result)).not.toContain('no public-release privacy findings');
  });

  it('binds the repository npm preflight to the public main baseline', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts['publication:preflight']).toBe(
      'node scripts/ci/publication-preflight.mjs --head HEAD --base origin/main --repo-name local',
    );
  });

  it('fails closed even when a caller omits the explicit mandatory host flag', () => {
    const root = createRepo();

    const result = runPreflightWithoutHosts(root, '--head', 'HEAD');

    expect(result.status).toBe(1);
    expect(output(result)).toContain('PUBLIC_RELEASE_FORBIDDEN_HOSTS is required');
  });

  it('fails closed when the internal gate requires missing host configuration', () => {
    const root = createRepo();

    const result = runPreflightWithoutHosts(
      root,
      '--head',
      'HEAD',
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(output(result)).toContain('PUBLIC_RELEASE_FORBIDDEN_HOSTS is required');
  });

  it('accepts a clean first publication without a prior base', () => {
    const root = createRepo();

    const result = runPreflight(root, '--head', 'HEAD');

    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('publication preflight passed');
  });

  it('lets source-tag validation scan the final tree without source-only history', () => {
    const root = createRepo();
    const secretValue = ['AbCdEfGh', 'JkLmNoPq', 'RsTuVwXy'].join('');
    fs.writeFileSync(path.join(root, 'source-only.txt'), `token=${secretValue}\n`);
    git(root, 'add', 'source-only.txt');
    git(root, 'commit', '-q', '-m', 'add source fixture');
    fs.rmSync(path.join(root, 'source-only.txt'));
    git(root, 'add', '-u');
    git(root, 'commit', '-q', '-m', 'remove source fixture');

    const historyResult = runPreflight(root, '--head', 'HEAD');
    const treeResult = runPreflight(root, '--head', 'HEAD', '--tree-only');

    expect(historyResult.status).toBe(1);
    expect(output(historyResult)).toContain('generic assigned secret');
    expect(treeResult.status, output(treeResult)).toBe(0);
    expect(output(treeResult)).toContain('publication preflight passed');
    expect(output(treeResult)).not.toContain(secretValue);
  });

  it('keeps final-tree findings fail-closed in tree-only mode', () => {
    const root = createRepo();
    const secretValue = ['AbCdEfGh', 'JkLmNoPq', 'RsTuVwXy'].join('');
    fs.writeFileSync(path.join(root, 'candidate.txt'), `token=${secretValue}\n`);
    git(root, 'add', 'candidate.txt');
    git(root, 'commit', '-q', '-m', 'add candidate fixture');

    const result = runPreflight(root, '--head', 'HEAD', '--tree-only');

    expect(result.status).toBe(1);
    expect(output(result)).toContain('generic assigned secret');
    expect(output(result)).not.toContain(secretValue);
  });

  it('accepts a strict ancestor as the trusted base', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(root, 'README.md'), 'public change\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'add public change');

    const result = runPreflight(root, '--head', 'HEAD', '--base', base);

    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('publication preflight passed');
  });

  it('requires the publication head to exactly match the configured source ref', () => {
    const root = createRepo();
    const sourceCommit = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/source/main', sourceCommit);

    const accepted = runPreflight(
      root,
      '--head',
      'HEAD',
      '--require-source-ref',
      'refs/remotes/source/main',
    );
    expect(accepted.status, output(accepted)).toBe(0);

    fs.appendFileSync(path.join(root, 'README.md'), 'source advanced\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'advance source');
    git(root, 'update-ref', 'refs/remotes/source/main', 'HEAD');
    const rejected = runPreflight(
      root,
      '--head',
      sourceCommit,
      '--require-source-ref',
      'refs/remotes/source/main',
    );

    expect(rejected.status).toBe(1);
    expect(output(rejected)).toContain('does not exactly match');
    expect(output(rejected)).not.toContain(sourceCommit);
  });

  it('rejects an equal base without echoing the supplied revision', () => {
    const root = createRepo();
    const head = git(root, 'rev-parse', 'HEAD');

    const result = runPreflight(root, '--head', head, '--base', head);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('strict ancestor');
    expect(output(result)).not.toContain(head);
  });

  it('rejects an invalid base without echoing Git error details', () => {
    const root = createRepo();
    const invalidBase = ['missing', '10', '81', '72', '63'].join('-');

    const result = runPreflight(root, '--head', 'HEAD', '--base', invalidBase);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('publication base is not a commit');
    expect(output(result)).not.toContain(invalidBase);
  });

  it('rejects a non-ancestor base without echoing either revision', () => {
    const root = createRepo();
    const mainBranch = git(root, 'branch', '--show-current');

    git(root, 'checkout', '-q', '-b', 'diverged-base');
    fs.writeFileSync(path.join(root, 'base.md'), 'diverged base\n');
    git(root, 'add', 'base.md');
    git(root, 'commit', '-q', '-m', 'add diverged base');
    const base = git(root, 'rev-parse', 'HEAD');

    git(root, 'checkout', '-q', mainBranch);
    fs.writeFileSync(path.join(root, 'head.md'), 'publication head\n');
    git(root, 'add', 'head.md');
    git(root, 'commit', '-q', '-m', 'add publication head');
    const head = git(root, 'rev-parse', 'HEAD');

    const result = runPreflight(root, '--head', head, '--base', base);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('strict ancestor');
    expect(output(result)).not.toContain(base);
    expect(output(result)).not.toContain(head);
  });

  it('does not echo a rejected value or its path', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const privateAddress = ['10', '66', '55', '44'].join('.');
    const secretValue = ['AbCdEfGh', 'JkLmNoPq', 'RsTuVwXy'].join('');
    const sensitivePath = `endpoint-${privateAddress}.txt`;
    fs.writeFileSync(path.join(root, sensitivePath), `token=${secretValue}\n`);
    git(root, 'add', sensitivePath);
    git(root, 'commit', '-q', '-m', 'add publication configuration');

    const result = runPreflight(root, '--head', 'HEAD', '--base', base);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('generic assigned secret');
    expect(output(result)).not.toContain(secretValue);
    expect(output(result)).not.toContain(privateAddress);
    expect(output(result)).not.toContain(sensitivePath);
  });
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createPublicationCommit(
  root,
  tree,
  parents,
  {
    authorName = botName,
    authorEmail = botEmail,
    committerName = botName,
    committerEmail = botEmail,
    message = null,
    timestamp = null,
  } = {},
) {
  const parentArgs = parents.flatMap((parent) => ['-p', parent]);
  return execFileSync('git', ['commit-tree', tree, ...parentArgs, '-F', '-'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_AUTHOR_DATE: timestamp || `${git(root, 'show', '-s', '--format=%ct', 'HEAD')} +0000`,
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: committerEmail,
      GIT_COMMITTER_DATE: timestamp || `${git(root, 'show', '-s', '--format=%ct', 'HEAD')} +0000`,
    },
    input: message ?? `chore(release): ${fixtureVersion}\n\nsource: gitea/${git(root, 'rev-parse', 'HEAD')}\nsource-tree: ${tree}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function canonicalTagMessage(fixture, {
  version = fixtureVersion,
  sourceCommit = fixture.sourceCommit,
  exportedTree = fixture.exportedTree,
} = {}) {
  return Buffer.from(
    `${version}\n\nsource: gitea/${sourceCommit}\nsource-tree: ${exportedTree}\n`,
  );
}

function createTagObject(root, {
  target,
  type = 'commit',
  version = fixtureVersion,
  message,
  signature = null,
  sign = false,
  taggerName = 'Source Release Bot',
  taggerEmail = 'source-release@users.noreply.github.com',
}) {
  const payload = Buffer.concat([
    Buffer.from(
      `object ${target}\ntype ${type}\ntag ${version}\n` +
        `tagger ${taggerName} <${taggerEmail}> ${git(root, 'show', '-s', '--format=%ct', 'HEAD')} +0000\n\n`,
    ),
    Buffer.isBuffer(message) ? message : Buffer.from(message),
  ]);
  const signedBytes = sign
    ? execFileSync('gpg', ['--homedir', publicationSigningFixture().home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--armor', '--detach-sign'], { input: payload, stdio: ['pipe', 'pipe', 'pipe'] })
    : signature || Buffer.alloc(0);
  return gitWithInput(root, Buffer.concat([payload, signedBytes]), 'hash-object', '--literally', '-t', 'tag', '-w', '--stdin');
}

function createPublicTag(fixture, overrides = {}) {
  return createTagObject(fixture.root, {
    target: fixture.publicationCommit,
    message: canonicalTagMessage(fixture),
    taggerName: botName,
    taggerEmail: botEmail,
    ...overrides,
  });
}

function createSourceTag(fixture, overrides = {}) {
  return createTagObject(fixture.root, {
    target: fixture.sourceCommit,
    message: canonicalTagMessage(fixture),
    sign: !Object.hasOwn(overrides, 'signature'),
    ...overrides,
  });
}

function installFakeGpgVerifier(root) {
  const binDir = path.join(root, '.fixture-bin');
  fs.mkdirSync(binDir);
  const wrapper = path.join(binDir, 'gpg');
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (!Object.hasOwn(process.env, 'PP_FAKE_GPG_STATUS')) {
  const result = spawnSync('gpg', args, { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} }, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
let statusFd = 2;
for (let index = 0; index < args.length; index += 1) {
  if (args[index].startsWith('--status-fd=')) {
    statusFd = Number(args[index].slice('--status-fd='.length));
  } else if (args[index] === '--status-fd') {
    statusFd = Number(args[index + 1]);
  }
}
fs.writeSync(statusFd, process.env.PP_FAKE_GPG_STATUS || '');
process.exit(Number(process.env.PP_FAKE_GPG_EXIT || '0'));
`,
    { mode: 0o755 },
  );
  return { binDir };
}

function installPythonArgumentRecorder(fixture) {
  const recordPath = path.join(fixture.root, '.python-args.json');
  const wrapper = path.join(fixture.verifier.binDir, 'python3');
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.writeFileSync(process.env.PP_PYTHON_ARGS_PATH, JSON.stringify(args));
const cleanPath = (process.env.PATH || '')
  .split(path.delimiter)
  .filter((entry) => entry !== process.env.PP_PYTHON_WRAPPER_DIR)
  .join(path.delimiter);
const result = spawnSync('python3', args, {
  env: { ...process.env, PATH: cleanPath },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  return recordPath;
}

function validGpgStatus(fingerprint = fixtureSigningKey) {
  return (
    `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG ${fingerprint.slice(-16)} Fixture\n` +
    `[GNUPG:] VALIDSIG ${fingerprint} 2026-07-24 0 4 0 1 10 00 ${fingerprint}\n`
  );
}

function createPublicationFixture() {
  const signer = publicationSigningFixture();
  const root = createRepo();
  const publicBase = git(root, 'rev-parse', 'HEAD');
  const exportedTree = git(root, 'rev-parse', `${publicBase}^{tree}`);
  fs.writeFileSync(path.join(root, 'internal-only.txt'), 'not exported\n');
  git(root, 'add', 'internal-only.txt');
  git(root, 'commit', '-q', '-m', 'internal source commit');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const sourceTree = git(root, 'rev-parse', `${sourceCommit}^{tree}`);
  const publicationCommit = createPublicationCommit(root, exportedTree, [publicBase]);
  const pathset = git(root, 'ls-tree', '-r', '--name-only', exportedTree)
    .split('\n')
    .filter(Boolean)
    .sort();
  const provenancePath = path.join(root, '.public-export-provenance.json');
  const verifier = installFakeGpgVerifier(root);
  const fixture = {
    root,
    publicBase,
    exportedTree,
    sourceCommit,
    sourceTree,
    publicationCommit,
    pathset,
    provenancePath,
    verifier,
    signer,
  };
  fixture.publicationTag = createPublicTag(fixture);
  fixture.sourceTag = createSourceTag(fixture);
  fixture.provenance = {
    schema: 'public-export-provenance/v1',
    generator: 'scripts/ci/export-public-tree.mjs',
    sourceCommit,
    sourceTree,
    exportedTree,
    policyVersion: 1,
    policyHash: fixturePolicyHash,
    pathsetSha256: sha256(`${pathset.join('\n')}\n`),
    pathset,
    excludedPaths: ['internal-only.txt'],
    intendedPublicBase: publicBase,
  };
  return fixture;
}

function replaceFixturePublicationCommit(fixture, identity = {}, parents = [fixture.publicBase]) {
  fixture.publicationCommit = createPublicationCommit(
    fixture.root,
    fixture.exportedTree,
    parents,
    identity,
  );
  fixture.publicationTag = createPublicTag(fixture);
}

function replaceFixtureExportedTree(fixture, {
  contents = '# clean\n',
  mode = '100644',
  type = 'blob',
}) {
  // gitlink entries (mode 160000) reference an existing commit object
  // rather than a freshly hashed blob; reuse the fixture source commit.
  const objectId =
    type === 'commit'
      ? fixture.sourceCommit
      : gitWithInput(
          fixture.root,
          contents,
          'hash-object',
          '-w',
          '--stdin',
        );
  fixture.exportedTree = gitWithInput(
    fixture.root,
    `${mode} ${type} ${objectId}\tREADME.md\n`,
    'mktree',
  );
  fixture.provenance.exportedTree = fixture.exportedTree;
  fixture.publicationCommit = createPublicationCommit(
    fixture.root,
    fixture.exportedTree,
    [fixture.publicBase],
  );
  fixture.publicationTag = createPublicTag(fixture);
  fixture.sourceTag = createSourceTag(fixture);
}

function runPublicationFixture(fixture, {
  provenance = {},
  publicationCommit = fixture.publicationCommit,
  publicBase = fixture.publicBase,
  policyHash = fixturePolicyHash,
  version = fixtureVersion,
  publicationTag = fixture.publicationTag,
  sourceTag = fixture.sourceTag,
  sourceSigningKey = fixtureSigningKey,
  revokedSigningKeys = [],
  extraArgs = [],
  env = {},
} = {}) {
  fs.writeFileSync(
    fixture.provenancePath,
    `${JSON.stringify({ ...fixture.provenance, ...provenance }, null, 2)}\n`,
  );
  const args = [
    '--publication-commit',
    publicationCommit,
    '--public-base',
    publicBase,
    '--export-provenance',
    fixture.provenancePath,
    '--policy-hash',
    policyHash,
    '--version',
    version,
    '--publication-tag',
    publicationTag,
    '--source-tag',
    sourceTag,
    '--source-tag-signing-key',
    sourceSigningKey,
  ];
  for (const fingerprint of revokedSigningKeys) {
    args.push('--revoked-signing-key', fingerprint);
  }
  args.push(...extraArgs);
  return withPublicGpgContext(fixture.signer.certificate, (home) => runPreflightWithEnv(
    fixture.root,
    {
      PATH: `${fixture.verifier.binDir}${path.delimiter}${process.env.PATH}`,
      GNUPGHOME: home,
      ...env,
    },
    ...args,
  ));
}

describe('publication preflight publication-mode structural contract', () => {
  it('passes the validated export provenance pathset into the publication privacy scan', () => {
    const fixture = createPublicationFixture();
    const recordPath = installPythonArgumentRecorder(fixture);

    const result = runPublicationFixture(fixture, {
      env: {
        PP_PYTHON_ARGS_PATH: recordPath,
        PP_PYTHON_WRAPPER_DIR: fixture.verifier.binDir,
      },
    });

    expect(result.status, output(result)).toBe(0);
    const args = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const pathsetIndex = args.indexOf('--allowlist-pathset');
    expect(pathsetIndex).toBeGreaterThanOrEqual(0);
    expect(args[pathsetIndex + 1]).toBe(fixture.provenancePath);
    expect(args).toContain('--commit-envelope');
    expect(args).toContain('--require-forbidden-hosts');
    expect(args).toContain('--fail-on-warn');
  });

  it('accepts divergent E with bound provenance, pinned identity, and two valid tags', () => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture);

    expect(fixture.sourceTree).not.toBe(fixture.exportedTree);
    expect(fixture.publicationTag).not.toBe(fixture.sourceTag);
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('publication preflight passed');
  });

  it('ignores repository-local GPG verifier overrides', () => {
    const fixture = createPublicationFixture();
    const untrustedProgram = path.join(fixture.root, 'untrusted-gpg-program');
    git(fixture.root, 'config', 'gpg.program', untrustedProgram);
    git(fixture.root, 'config', 'gpg.openpgp.program', untrustedProgram);

    const result = runPublicationFixture(fixture);

    expect(result.status, output(result)).toBe(0);
  });

  it('rejects fabricated signature packets despite a verifier reporting VALIDSIG', () => {
    const fixture = createPublicationFixture();
    const sourceTag = createSourceTag(fixture, { signature: fakePgpSignature });
    const result = runPublicationFixture(fixture, {
      sourceTag,
      env: { PP_FAKE_GPG_STATUS: validGpgStatus() },
    });
    expect(result.status).toBe(1);
    expect(output(result)).toContain('tag metadata: unverified or unsupported signature material');
  });

  it('fails closed when publication mode omits --public-base', () => {
    const fixture = createPublicationFixture();

    const result = runPreflight(
      fixture.root,
      '--publication-commit',
      fixture.publicationCommit,
    );

    expect(result.status).toBe(1);
    expect(output(result)).toContain('--public-base is required in publication mode');
    expect(output(result)).not.toContain('no public-release privacy findings');
  });

  it.each([
    ['schema', { schema: 'public-export-provenance/v2' }],
    ['manifest digest', { pathsetSha256: '0'.repeat(64) }],
    [
      'manifest pathset',
      {
        pathset: ['other.txt'],
        pathsetSha256: sha256('other.txt\n'),
      },
    ],
    ['excluded manifest pathset', { excludedPaths: [] }],
    ['exported tree', { exportedTree: null }],
    ['source tree', { sourceTree: null }],
    ['intended public base', { intendedPublicBase: null }],
  ])('rejects invalid provenance %s binding', (_name, provenance) => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture, { provenance });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('export provenance');
    expect(output(result)).not.toContain('no public-release privacy findings');
  });

  it('rejects tree(P) when it differs from provenance tree(E)', () => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture, {
      provenance: { exportedTree: fixture.sourceTree },
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('publication tree must equal exported tree');
  });

  it('rejects provenance sourceTree when it differs from tree(S)', () => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture, {
      provenance: { sourceTree: fixture.exportedTree },
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('source tree does not match source commit');
  });

  it.each([
    ['blob OID', { contents: '# substituted export\n' }],
    ['file mode', { mode: '100755' }],
    ['symlink mode', { mode: '120000', contents: 'internal-only.txt' }],
    ['gitlink mode', { mode: '160000', type: 'commit' }],
  ])('rejects an exported tree with a same-path changed %s', (_name, change) => {
    const fixture = createPublicationFixture();
    replaceFixtureExportedTree(fixture, change);

    const result = runPublicationFixture(fixture);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('exact path-filtered projection');
  });

  it('rejects a policy hash not independently pinned by the caller', () => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture, {
      policyHash: 'c'.repeat(64),
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('policy hash');
  });

  it('binds the publication parent to provenance intendedPublicBase', () => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture, {
      provenance: { intendedPublicBase: fixture.sourceCommit },
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('public base must match export provenance');
  });

  it.each([
    ['author name', { authorName: 'Wrong Bot' }],
    ['author email', { authorEmail: 'wrong@example.invalid' }],
    ['committer name', { committerName: 'Wrong Bot' }],
    ['committer email', { committerEmail: 'wrong@example.invalid' }],
  ])('rejects a publication commit with the wrong %s', (_name, identity) => {
    const fixture = createPublicationFixture();
    replaceFixturePublicationCommit(fixture, identity);

    const result = runPublicationFixture(fixture);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('pinned release bot identity');
  });

  it.each([
    ['message', { message: 'release fixture\n' }],
    ['timestamp', { timestamp: '1700000000 +0000' }],
  ])('rejects noncanonical publication %s before privacy scanning', (_name, override) => {
    const fixture = createPublicationFixture();
    replaceFixturePublicationCommit(fixture, override);
    const result = runPublicationFixture(fixture);
    expect(result.status).toBe(1);
    expect(output(result)).toContain('canonical publication');
  });

  it('rejects a public tagger that is not the pinned release bot', () => {
    const fixture = createPublicationFixture();
    const publicationTag = createPublicTag(fixture, {
      taggerName: 'Wrong Tagger',
    });

    const result = runPublicationFixture(fixture, { publicationTag });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('pinned release bot identity');
  });

  it('binds --require-source-ref to S instead of P in divergent publication mode', () => {
    const fixture = createPublicationFixture();
    git(
      fixture.root,
      'update-ref',
      'refs/remotes/source/main',
      fixture.sourceCommit,
    );
    const accepted = runPublicationFixture(fixture, {
      extraArgs: ['--require-source-ref', 'refs/remotes/source/main'],
    });
    git(
      fixture.root,
      'update-ref',
      'refs/remotes/source/main',
      fixture.publicationCommit,
    );
    const rejected = runPublicationFixture(fixture, {
      extraArgs: ['--require-source-ref', 'refs/remotes/source/main'],
    });

    expect(accepted.status, output(accepted)).toBe(0);
    expect(rejected.status).toBe(1);
    expect(output(rejected)).toContain('does not exactly match');
  });

  it('rejects any refs/replace entry before inspecting publication objects', () => {
    const fixture = createPublicationFixture();
    git(fixture.root, 'replace', fixture.sourceCommit, fixture.publicationCommit);

    const result = runPublicationFixture(fixture);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('refs/replace must be empty');
  });

  it('rejects equal public and source tag object IDs (KF1)', () => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture, {
      publicationTag: fixture.sourceTag,
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('tag object ids must be distinct');
  });

  it.each([
    ['public tag not targeting P', 'public'],
    ['source tag not targeting S', 'source'],
    ['tag targeting another tag object', 'nested'],
  ])('rejects %s (KF2)', (_name, role) => {
    const fixture = createPublicationFixture();
    let publicationTag = fixture.publicationTag;
    let sourceTag = fixture.sourceTag;
    if (role === 'public') {
      publicationTag = createPublicTag(fixture, { target: fixture.sourceCommit });
    } else if (role === 'source') {
      sourceTag = createSourceTag(fixture, { target: fixture.publicationCommit });
    } else {
      sourceTag = createSourceTag(fixture, {
        target: fixture.publicationTag,
        type: 'tag',
      });
    }

    const result = runPublicationFixture(fixture, { publicationTag, sourceTag });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('tag must target');
  });

  it.each([
    ['version', 'public', { version: 'v9.9.9' }],
    [
      'message whitespace',
      'source',
      { message: (fixture) => Buffer.concat([canonicalTagMessage(fixture), Buffer.from(' ')]) },
    ],
    [
      'source commit trailer',
      'public',
      {
        message: (fixture) => canonicalTagMessage(fixture, {
          sourceCommit: fixture.publicBase,
        }),
      },
    ],
    [
      'source tree trailer',
      'source',
      {
        message: (fixture) => canonicalTagMessage(fixture, {
          exportedTree: fixture.sourceTree,
        }),
      },
    ],
  ])('rejects a tag with mismatched %s (KF3)', (_name, role, mutation) => {
    const fixture = createPublicationFixture();
    const resolved = {
      ...mutation,
      ...(mutation.message ? { message: mutation.message(fixture) } : {}),
    };
    const publicationTag = role === 'public'
      ? createPublicTag(fixture, resolved)
      : fixture.publicationTag;
    const sourceTag = role === 'source'
      ? createSourceTag(fixture, resolved)
      : fixture.sourceTag;

    const result = runPublicationFixture(fixture, { publicationTag, sourceTag });

    expect(result.status).toBe(1);
    expect(output(result)).toMatch(/tag (name|message) must/);
  });

  it('rejects an unsigned source tag', () => {
    const fixture = createPublicationFixture();
    const sourceTag = createSourceTag(fixture, { signature: null });

    const result = runPublicationFixture(fixture, { sourceTag });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('source tag must have one OpenPGP signature');
  });

  it('rejects a source tag signed by an unpinned key', () => {
    const fixture = createPublicationFixture();
    const wrongKey = 'C'.repeat(40);

    const result = runPublicationFixture(fixture, {
      env: { PP_FAKE_GPG_STATUS: validGpgStatus(wrongKey) },
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('source tag signing key does not match');
  });

  it('rejects a source signing key in the explicit revocation denylist', () => {
    const fixture = createPublicationFixture();

    const result = runPublicationFixture(fixture, {
      revokedSigningKeys: [fixtureSigningKey],
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('source tag signing key is revoked');
  });

  it.each(['BADSIG', 'EXPKEYSIG', 'REVKEYSIG'])(
    'rejects OpenPGP verifier status %s',
    (status) => {
      const fixture = createPublicationFixture();

      const result = runPublicationFixture(fixture, {
        env: {
          PP_FAKE_GPG_STATUS:
            `[GNUPG:] ${status} ${fixtureSigningKey.slice(-16)} Fixture\n` +
            validGpgStatus(),
          PP_FAKE_GPG_EXIT: status === 'BADSIG' ? '1' : '0',
        },
      });

      expect(result.status).toBe(1);
      expect(output(result)).toContain('source tag signature is not valid');
    },
  );

  it('rejects a signed public tag because the v1 public envelope is unsigned', () => {
    const fixture = createPublicationFixture();
    const publicationTag = createPublicTag(fixture, { signature: fakePgpSignature });

    const result = runPublicationFixture(fixture, { publicationTag });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('public tag must be unsigned');
  });

  it.each([
    [
      'NUL bytes',
      (fixture, canary) => Buffer.concat([
        canonicalTagMessage(fixture),
        Buffer.from([0]),
        Buffer.from(canary),
      ]),
    ],
    [
      'PNG bytes',
      (fixture, canary) => Buffer.concat([
        canonicalTagMessage(fixture),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from(canary),
      ]),
    ],
    [
      'encoded data',
      (fixture, canary) => Buffer.concat([
        canonicalTagMessage(fixture),
        Buffer.from(Buffer.from(canary).toString('base64')),
      ]),
    ],
    [
      'oversized data',
      (fixture) => Buffer.concat([
        canonicalTagMessage(fixture),
        Buffer.alloc(1024 * 1024 + 1, 0x41),
      ]),
    ],
  ])('fails closed on tag-message %s without echoing bytes (KD3)', (_name, mutate) => {
    const fixture = createPublicationFixture();
    const canary = ['AbCdEfGh', 'JkLmNoPq', 'RsTuVwXy'].join('');
    const publicationTag = createPublicTag(fixture, {
      message: mutate(fixture, canary),
    });

    const result = runPublicationFixture(fixture, { publicationTag });

    expect(result.status).toBe(1);
    expect(output(result)).toMatch(/public tag (message|object)/);
    expect(output(result)).not.toContain(canary);
  });

  it.each([
    ['zero parents', []],
    ['two parents', (fixture) => [fixture.publicBase, fixture.sourceCommit]],
    ['internal-only parent', (fixture) => [fixture.sourceCommit]],
  ])('rejects a publication commit with %s (KE3)', (_name, parents) => {
    const fixture = createPublicationFixture();
    replaceFixturePublicationCommit(
      fixture,
      {},
      typeof parents === 'function' ? parents(fixture) : parents,
    );

    const result = runPublicationFixture(fixture);

    expect(result.status).toBe(1);
    expect(output(result)).toMatch(/exactly one parent|parent must equal public base/);
  });

  it('reads the recorded parent when local grafts spoof the revision graph', () => {
    const fixture = createPublicationFixture();
    replaceFixturePublicationCommit(fixture, {}, [fixture.sourceCommit]);
    fs.writeFileSync(
      path.join(fixture.root, '.git', 'info', 'grafts'),
      `${fixture.publicationCommit} ${fixture.publicBase}\n`,
    );

    const result = runPublicationFixture(fixture);

    expect(result.status).toBe(1);
    expect(output(result)).toContain('publication commit parent must equal public base');
  });
});
