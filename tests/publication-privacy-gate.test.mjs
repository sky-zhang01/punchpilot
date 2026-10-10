import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProvenance, exportPublicTree } from '../scripts/ci/export-public-tree.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(projectRoot, 'scripts', 'ci', 'public-release-privacy-gate.py');
const python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
const tempRoots = [];

function git(root, ...args) {
  const env = { ...process.env };
  for (const name of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE',
  ]) {
    delete env[name];
  }
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-publication-gate-'));
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

function runGate(root, ...args) {
  return runGateWithEnv(root, {}, ...args);
}

function runGateWithEnv(root, env, ...args) {
  return spawnSync(python, [gate, '--root', root, '--repo-name', 'fixture', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runPublicationGate(root, ...args) {
  return runGateWithEnv(
    root,
    { PUBLIC_RELEASE_FORBIDDEN_HOSTS: 'private.example.invalid' },
    ...args,
  );
}

function createPublicationCommit(root, tree, parent, message = 'release: public publication') {
  return git(root, 'commit-tree', tree, '-p', parent, '-m', message);
}

function createAnnotatedTag(root, name, commit, message) {
  git(root, '-c', 'tag.gpgSign=false', 'tag', '-a', name, commit, '-m', message);
  return name;
}

function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type), body, Buffer.alloc(4)]);
}

function pngTextChunk(text) {
  return pngChunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1'));
}

function pngCompressedTextChunk(text) {
  return pngChunk(
    'zTXt',
    Buffer.concat([
      Buffer.from('Comment\0', 'latin1'),
      Buffer.from([0]),
      deflateSync(Buffer.from(text, 'latin1')),
    ]),
  );
}

// Write a provenance record to a scratch dir OUTSIDE the fixture repo so
// working-tree scans never see the pathset file itself.
function writePathsetProvenance(provenance) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pathset-'));
  tempRoots.push(dir);
  const file = path.join(dir, 'pathset.json');
  fs.writeFileSync(file, JSON.stringify(provenance));
  return file;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('public release privacy gate for outgoing history', () => {
  it('uses NUL-safe tree inventories that remain compatible with older runner Git', () => {
    const source = fs.readFileSync(gate, 'utf8');
    expect(source).toContain('for entry in tree_entries(root, commit):');
    expect(source).not.toContain('"rev-list", "--objects", "-z"');
  });

  it('accepts a clean ref and commit range', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(root, 'README.md'), 'public change\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'docs: public change');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('rejects an equal range and a range whose head does not match the scanned ref', () => {
    const root = createRepo();
    const mainBranch = git(root, 'branch', '--show-current');
    const base = git(root, 'rev-parse', 'HEAD');

    git(root, 'checkout', '-q', '-b', 'alternate');
    fs.writeFileSync(path.join(root, 'alternate.md'), 'alternate\n');
    git(root, 'add', 'alternate.md');
    git(root, 'commit', '-q', '-m', 'add alternate');
    const alternate = git(root, 'rev-parse', 'HEAD');

    git(root, 'checkout', '-q', mainBranch);
    fs.writeFileSync(path.join(root, 'main.md'), 'main\n');
    git(root, 'add', 'main.md');
    git(root, 'commit', '-q', '-m', 'add main');

    const equal = runGate(root, '--ref', 'HEAD', '--commit-range', 'HEAD..HEAD');
    const mismatched = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..${alternate}`);

    expect(equal.status).toBe(1);
    expect(mismatched.status).toBe(1);
    expect(equal.stdout).toContain('could not inspect Git ref');
    expect(mismatched.stdout).toContain('could not inspect Git ref');
    expect(mismatched.stdout).not.toContain(alternate);
  });

  it('scans tracked paths even when default and CLI excludes match', () => {
    const root = createRepo();
    const privateAddress = ['10', '91', '82', '73'].join('.');
    const excludedPath = path.join('coverage', 'internal.txt');
    fs.mkdirSync(path.dirname(path.join(root, excludedPath)), { recursive: true });
    fs.writeFileSync(path.join(root, excludedPath), `endpoint=${privateAddress}\n`);
    git(root, 'add', '-f', excludedPath);
    git(root, 'commit', '-q', '-m', 'add tracked report');

    const result = runGate(root, '--ref', 'HEAD', '--exclude', '*');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 10.x IP');
    expect(result.stdout).not.toContain(privateAddress);
    expect(result.stdout).not.toContain(excludedPath);
  });

  it('scans text content regardless of file extension', () => {
    const root = createRepo();
    const privateAddress = ['172', '22', '81', '19'].join('.');
    fs.writeFileSync(path.join(root, 'release.payload'), `endpoint=${privateAddress}\n`);
    git(root, 'add', 'release.payload');
    git(root, 'commit', '-q', '-m', 'add release payload');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 172.16-31.x IP');
    expect(result.stdout).not.toContain(privateAddress);
  });

  it('does not skip findings inside a gate-named tracked path', () => {
    const root = createRepo();
    const privateAddress = ['10', '33', '22', '11'].join('.');
    const gatePath = path.join('scripts', 'ci', 'public-release-privacy-gate.py');
    fs.mkdirSync(path.dirname(path.join(root, gatePath)), { recursive: true });
    fs.writeFileSync(path.join(root, gatePath), `re.compile('safe') # endpoint=${privateAddress}\n`);
    git(root, 'add', gatePath);
    git(root, 'commit', '-q', '-m', 'add release gate');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 10.x IP');
    expect(result.stdout).not.toContain(privateAddress);
  });

  it('scans a clean copy of the gate source without a self-exemption', () => {
    const root = createRepo();
    const gatePath = path.join('scripts', 'ci', 'public-release-privacy-gate.py');
    fs.mkdirSync(path.dirname(path.join(root, gatePath)), { recursive: true });
    fs.copyFileSync(gate, path.join(root, gatePath));
    git(root, 'add', gatePath);
    git(root, 'commit', '-q', '-m', 'add release gate');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', 'HEAD');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('rejects sensitive content from an intermediate commit even when later deleted', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const privateAddress = ['10', '23', '45', '67'].join('.');
    fs.writeFileSync(path.join(root, 'temporary.md'), `endpoint=${privateAddress}\n`);
    git(root, 'add', 'temporary.md');
    git(root, 'commit', '-q', '-m', 'add temporary configuration');
    fs.rmSync(path.join(root, 'temporary.md'));
    git(root, 'add', '-u');
    git(root, 'commit', '-q', '-m', 'remove temporary configuration');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 10.x IP');
    expect(result.stdout).not.toContain(privateAddress);
  });

  it('rejects deleted intermediate raw high-entropy credentials without echoing value or path', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const sensitivePath = 'notes.txt';
    const rawHexToken = [
      'f3a91c7e2d84b605',
      '9e14fa8c73d026b5',
      'c82e4a0f9167bd35',
      '6af03d9c817e24b5',
    ].join('');
    const rawUrlToken = createHash('sha512')
      .update('context-free deleted credential fixture')
      .digest('base64url');
    fs.writeFileSync(path.join(root, sensitivePath), `${rawHexToken}\n${rawUrlToken}\n`);
    git(root, 'add', sensitivePath);
    git(root, 'commit', '-q', '-m', 'add temporary notes');
    fs.rmSync(path.join(root, sensitivePath));
    git(root, 'add', '-u');
    git(root, 'commit', '-q', '-m', 'remove temporary notes');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unclassified high-entropy credential');
    expect(result.stdout).toMatch(/location=[a-f0-9]{12}/);
    for (const sensitiveValue of [rawHexToken, rawUrlToken, sensitivePath]) {
      expect(result.stdout + result.stderr).not.toContain(sensitiveValue);
    }
  });

  it('rejects an unclassified 40-character hexadecimal credential', () => {
    const root = createRepo();
    const rawHexToken = `${'0123456789abcdef'.repeat(2)}01234567`;
    fs.writeFileSync(path.join(root, 'opaque.txt'), `${rawHexToken}\n`);
    git(root, 'add', 'opaque.txt');
    git(root, 'commit', '-q', '-m', 'add opaque value');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(rawHexToken);
  });

  it('rejects an unclassified 32-character hexadecimal credential', () => {
    const root = createRepo();
    const rawHexToken = '0123456789abcdef'.repeat(2);
    fs.writeFileSync(path.join(root, 'opaque.txt'), `${rawHexToken}\n`);
    git(root, 'add', 'opaque.txt');
    git(root, 'commit', '-q', '-m', 'add short opaque value');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(rawHexToken);
  });

  it('allows explicitly reviewed public digests, integrity values, action pins, and asset hashes', () => {
    const root = createRepo();
    const sha256 = createHash('sha256').update('reviewed public artifact').digest('hex');
    const gitSha = createHash('sha256').update('reviewed public Git object').digest('hex');
    const integrity = `sha512-${createHash('sha512')
      .update('reviewed package integrity')
      .digest('base64')}`;
    fs.writeFileSync(
      path.join(root, 'reviewed-digests.yml'),
      [
        `uses: actions/checkout@${gitSha}`,
        `sha256: ${sha256}`,
        `digest: sha256:${sha256}`,
        `integrity: "${integrity}"`,
        `"client/public/app.js": "${sha256}"`,
        `archive_sha256='${sha256}'`,
        `ADD --checksum=sha256:${sha256} \\`,
        `image=registry.example.invalid/punchpilot@sha256:${sha256}`,
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'reviewed-digest-assertion.mjs'),
      [
        'expect(installer).toContain(',
        `  '${sha256}',`,
        ');',
      ].join('\n'),
    );
    git(root, 'add', 'reviewed-digests.yml', 'reviewed-digest-assertion.mjs');
    git(root, 'commit', '-q', '-m', 'add reviewed public digests');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', 'HEAD');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('does not allow checksum comments or asset mappings to hide opaque credentials', () => {
    const root = createRepo();
    const rawCommentToken = createHash('sha256')
      .update('unreviewed checksum comment credential')
      .digest('hex');
    const rawAssetName = createHash('sha512')
      .update('unreviewed asset-name credential')
      .digest('base64url');
    const publicAssetDigest = createHash('sha256')
      .update('reviewed public asset digest')
      .digest('hex');
    const rawAssertionToken = createHash('sha256')
      .update('unreviewed test assertion credential')
      .digest('hex');
    const rawChecksumToken = createHash('sha256')
      .update('unreviewed generic checksum credential')
      .digest('hex');
    fs.writeFileSync(
      path.join(root, 'notes.txt'),
      `# public-checksum: ${rawCommentToken}\n`,
    );
    fs.writeFileSync(
      path.join(root, 'asset-manifest.json'),
      JSON.stringify({ [`${rawAssetName}.png`]: publicAssetDigest }),
    );
    fs.writeFileSync(
      path.join(root, 'credential-assertion.mjs'),
      `expect(payload).toContain('${rawAssertionToken}');\n`,
    );
    fs.writeFileSync(path.join(root, 'metadata.yml'), `checksum: ${rawChecksumToken}\n`);
    git(root, 'add', 'notes.txt', 'asset-manifest.json', 'credential-assertion.mjs', 'metadata.yml');
    git(root, 'commit', '-q', '-m', 'add unreviewed opaque values');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unclassified high-entropy credential');
    for (const sensitiveValue of [
      rawCommentToken,
      rawAssetName,
      rawAssertionToken,
      rawChecksumToken,
      'notes.txt',
      'asset-manifest.json',
      'credential-assertion.mjs',
      'metadata.yml',
    ]) {
      expect(result.stdout + result.stderr).not.toContain(sensitiveValue);
    }
  });

  it('rejects deleted intermediate dotted, parenthesized, JWT, and provider secrets', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const dottedSecret = ['DottedPartAlpha7', 'DottedPartBeta8', 'DottedPartGamma9'].join('.');
    const parenthesizedPassword = ['LongPasswordAlpha7', '(rotated)', 'LongPasswordBeta8'].join('');
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'fixture-user', exp: 4102444800 })).toString('base64url'),
      Buffer.from('synthetic-signature-material').toString('base64url'),
    ].join('.');
    const providerTokens = [
      ['github', 'pat', 'A1'.repeat(16)].join('_'),
      `npm_${'B2'.repeat(18)}`,
      `xoxb-${'123456789012'}-${'C3'.repeat(16)}`,
    ];
    const sensitiveValues = [dottedSecret, parenthesizedPassword, jwt, ...providerTokens];
    fs.writeFileSync(
      path.join(root, 'temporary.env.txt'),
      [
        `OAUTH_CLIENT_SECRET=${dottedSecret}`,
        `LOGIN_PASSWORD="${parenthesizedPassword}"`,
        `Authorization: Bearer ${jwt}`,
        ...providerTokens.map((token) => `credential ${token}`),
      ].join('\n'),
    );
    git(root, 'add', 'temporary.env.txt');
    git(root, 'commit', '-q', '-m', 'add temporary credentials');
    fs.rmSync(path.join(root, 'temporary.env.txt'));
    git(root, 'add', '-u');
    git(root, 'commit', '-q', '-m', 'remove temporary credentials');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('generic assigned secret');
    expect(result.stdout).toContain('JWT credential');
    expect(result.stdout).toContain('GitHub fine-grained token');
    expect(result.stdout).toContain('npm access token');
    expect(result.stdout).toContain('Slack token');
    for (const value of sensitiveValues) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('rejects a blob created by a merge commit and deleted before head', () => {
    const root = createRepo();
    const mainBranch = git(root, 'branch', '--show-current');
    const base = git(root, 'rev-parse', 'HEAD');
    const privateAddress = ['192', '168', '77', '41'].join('.');

    git(root, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(root, 'side.md'), 'side branch\n');
    git(root, 'add', 'side.md');
    git(root, 'commit', '-q', '-m', 'add side branch');

    git(root, 'checkout', '-q', mainBranch);
    fs.writeFileSync(path.join(root, 'main.md'), 'main branch\n');
    git(root, 'add', 'main.md');
    git(root, 'commit', '-q', '-m', 'add main branch');
    git(root, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    fs.writeFileSync(path.join(root, 'merge-only.md'), `endpoint=${privateAddress}\n`);
    git(root, 'add', 'merge-only.md');
    git(root, 'commit', '-q', '-m', 'merge side branch');
    fs.rmSync(path.join(root, 'merge-only.md'));
    git(root, 'add', '-u');
    git(root, 'commit', '-q', '-m', 'remove merge scratch data');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 192.168.x IP');
    expect(result.stdout).not.toContain(privateAddress);
    expect(result.stdout).not.toContain('merge-only.md');
  });

  it('rejects sensitive commit messages without echoing their contents', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const privateAddress = ['192', '168', '44', '9'].join('.');
    git(root, 'commit', '--allow-empty', '-q', '-m', `debug ${privateAddress}`);

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit message');
    expect(result.stdout).not.toContain(privateAddress);
  });

  it('allows forbidden-host author and committer identities in source history with an explicit exemption', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    const internalEmail = `bot@${forbiddenHost}`;
    git(root, 'config', 'user.name', 'Source Bot');
    git(root, 'config', 'user.email', internalEmail);
    git(root, 'commit', '--allow-empty', '-q', '-m', 'docs: identity fixture');
    expect(git(root, 'show', '-s', '--format=%ae %ce', 'HEAD')).toBe(
      `${internalEmail} ${internalEmail}`,
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--commit-range',
      `${base}..HEAD`,
      '--exempt-source-commit-identity',
      '--require-forbidden-hosts',
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('commit metadata: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it('rejects forbidden-host source identities by default without the exemption', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    const internalEmail = `bot@${forbiddenHost}`;
    git(root, 'config', 'user.name', 'Source Bot');
    git(root, 'config', 'user.email', internalEmail);
    git(root, 'commit', '--allow-empty', '-q', '-m', 'docs: identity fixture');
    expect(git(root, 'show', '-s', '--format=%ae %ce', 'HEAD')).toBe(
      `${internalEmail} ${internalEmail}`,
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--commit-range',
      `${base}..HEAD`,
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit metadata: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it('still rejects forbidden hosts in source commit messages', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    git(root, 'commit', '--allow-empty', '-q', '-m', `docs: reference ${forbiddenHost}`);

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--commit-range',
      `${base}..HEAD`,
      '--exempt-source-commit-identity',
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit message: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it('still rejects forbidden hosts in source commit tree content', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    const fixturePath = 'temporary-endpoint.md';
    fs.writeFileSync(path.join(root, fixturePath), `endpoint=https://${forbiddenHost}/status\n`);
    git(root, 'add', fixturePath);
    git(root, 'commit', '-q', '-m', 'docs: add temporary endpoint');
    fs.rmSync(path.join(root, fixturePath));
    git(root, 'add', '-u');
    git(root, 'commit', '-q', '-m', 'docs: remove temporary endpoint');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--commit-range',
      `${base}..HEAD`,
      '--exempt-source-commit-identity',
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit artifact: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it('rejects forbidden hosts in arbitrary public commit headers and continuations', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const forbiddenHost = ['review', 'private', 'invalid'].join('.');
    const identity = 'Fixture <fixture@example.invalid> 1700000000 +0000';
    const rawCommit = [
      `tree ${tree}`,
      `parent ${base}`,
      `author ${identity}`,
      `committer ${identity}`,
      'x-publication-review retained',
      ` https://${forbiddenHost}/review`,
      '',
      'docs: custom metadata fixture',
      '',
    ].join('\n');
    const commit = execFileSync(
      'git',
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      { cwd: root, input: rawCommit, encoding: 'utf8' },
    ).trim();
    git(root, 'update-ref', 'HEAD', commit, base);

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--commit-range',
      `${base}..HEAD`,
      '--exempt-source-commit-identity',
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit metadata: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it('rejects source-forge merge references in commit messages', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    const mergeMessage = [
      'Merge',
      'pull request',
      "'docs: fixture'",
      '(#42)',
      'from fixture/docs into main',
    ].join(' ');
    git(root, 'commit', '--allow-empty', '-q', '-m', mergeMessage);

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('source-forge merge reference');
    expect(result.stdout).not.toContain(mergeMessage);
  });

  it('requires and enforces externally supplied forbidden hosts', () => {
    const root = createRepo();
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    fs.appendFileSync(path.join(root, 'README.md'), `endpoint=https://${forbiddenHost}/status\n`);
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'add endpoint documentation');

    const missing = runGate(root, '--ref', 'HEAD', '--require-forbidden-hosts');
    const blocked = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );

    expect(missing.status).toBe(1);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('forbidden internal hostname');
    expect(blocked.stdout).not.toContain(forbiddenHost);
  });

  it('enforces a valid single-label internal hostname without echoing it', () => {
    const root = createRepo();
    const forbiddenHost = ['fixture', 'node'].join('');
    fs.appendFileSync(path.join(root, 'README.md'), `endpoint=http://${forbiddenHost}/status\n`);
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'add internal endpoint fixture');

    const blocked = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );

    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('forbidden internal hostname');
    expect(blocked.stdout + blocked.stderr).not.toContain(forbiddenHost);
  });

  it('rejects wildcard host apexes and common encoded or split forms', () => {
    const root = createRepo();
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    const encodedHost = forbiddenHost.replaceAll('.', '%2e');
    const [first, ...rest] = forbiddenHost.split('.');
    const splitHost = `${first}" + ".${rest.join('.')}`;
    fs.writeFileSync(
      path.join(root, 'endpoints.txt'),
      [forbiddenHost, `child.${forbiddenHost}`, encodedHost, splitHost].join('\n'),
    );
    git(root, 'add', 'endpoints.txt');
    git(root, 'commit', '-q', '-m', 'add endpoint fixtures');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: `*.${forbiddenHost}` },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it('fails closed on a nonblank forbidden-host policy with no valid hosts', () => {
    const root = createRepo();
    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: ',,,' },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PUBLIC_RELEASE_FORBIDDEN_HOSTS is required');
  });

  it('rejects private IPv6 and generic secrets even when comments say example', () => {
    const root = createRepo();
    const privateIpv6 = ['fd12', '3456', '789a', '', '1'].join(':');
    const assignedSecret = ['AbCdEfGh', 'JkLmNoPq', 'RsTuVwXy'].join('');
    fs.appendFileSync(
      path.join(root, 'README.md'),
      `endpoint=[${privateIpv6}]\ntoken=${assignedSecret} # example deployment\n`,
    );
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'add deployment documentation');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private IPv6 address');
    expect(result.stdout).toContain('generic assigned secret');
    expect(result.stdout).not.toContain(privateIpv6);
    expect(result.stdout).not.toContain(assignedSecret);
  });

  it('rejects prefixed secret identifiers across YAML, Markdown, and JavaScript', () => {
    const root = createRepo();
    const assignedSecrets = [
      ['Aq7Lm2Nz', '9Rx4Cv8B', 'k3Hs6Jp5'].join(''),
      ['Bw8Mn3Py', '2Sy5Dw9C', 'j4Kt7Lq6'].join(''),
      ['Cx9Np4Qz', '3Tt6Ex2D', 'k5Lu8Mr7'].join(''),
      ['Dy2Pq5Ra', '4Uv7Fy3E', 'm6Nv9Ns8'].join(''),
      ['Ez3Qr6Sb', '5Vw8Gz4F', 'n7Pw2Pt9'].join(''),
    ];
    const fixtures = new Map([
      [
        'release.yml',
        [
          `OAUTH_REFRESH_TOKEN: ${assignedSecrets[0]}`,
          `OAUTH_CLIENT_SECRET: "${assignedSecrets[1]}"`,
        ].join('\n'),
      ],
      [
        'deployment.md',
        [
          '```env',
          `LOGIN_PASSWORD=${assignedSecrets[2]}`,
          `service-api-key: ${assignedSecrets[4]}`,
          '```',
        ].join('\n'),
      ],
      ['config.js', `export const APP_SECRET = '${assignedSecrets[3]}';\n`],
    ]);
    for (const [fixturePath, content] of fixtures) {
      fs.writeFileSync(path.join(root, fixturePath), content);
    }
    git(root, 'add', ...fixtures.keys());
    git(root, 'commit', '-q', '-m', 'add release configuration');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout.match(/generic assigned secret/g)).toHaveLength(5);
    for (const assignedSecret of assignedSecrets) {
      expect(result.stdout).not.toContain(assignedSecret);
    }
  });

  it('rejects quoted JSON and HTTP header credentials', () => {
    const root = createRepo();
    const jsonSecret = ['JsonRefreshA7', 'JsonRefreshB8', 'JsonRefreshC9'].join('');
    const bearerSecret = ['BearerAccessA7', 'BearerAccessB8', 'BearerAccessC9'].join('');
    const cookieSecret = ['CookieSessionA7', 'CookieSessionB8', 'CookieSessionC9'].join('');
    fs.writeFileSync(path.join(root, 'oauth.json'), JSON.stringify({
      refresh_token: jsonSecret,
    }));
    fs.writeFileSync(
      path.join(root, 'headers.txt'),
      [
        `Authorization: Bearer ${bearerSecret}`,
        `Set-${'Cookie'}: session_id=${cookieSecret}; HttpOnly; Secure`,
      ].join('\n'),
    );
    git(root, 'add', 'oauth.json', 'headers.txt');
    git(root, 'commit', '-q', '-m', 'add credential response fixtures');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('generic assigned secret');
    expect(result.stdout.match(/HTTP credential/g)).toHaveLength(2);
    for (const secret of [jsonSecret, bearerSecret, cookieSecret]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
  });

  it('rejects opaque credentials hidden behind placeholder-like prefixes', () => {
    const root = createRepo();
    const opaqueSecret = ['PrefixOpaqueA7', 'PrefixOpaqueB8', 'PrefixOpaqueC9'].join('');
    const prefixedValues = [
      `sample-${opaqueSecret}`,
      `dummy-${opaqueSecret}`,
      `example-${opaqueSecret}`,
    ];
    fs.writeFileSync(
      path.join(root, 'prefixed-credentials.txt'),
      [
        `Authorization: Bearer ${prefixedValues[0]}`,
        `Cookie: sid=${prefixedValues[1]}`,
        `refresh_token: ${prefixedValues[2]}`,
      ].join('\n'),
    );
    git(root, 'add', 'prefixed-credentials.txt');
    git(root, 'commit', '-q', '-m', 'add prefixed credential fixtures');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HTTP credential');
    expect(result.stdout).toContain('generic assigned secret');
    for (const value of [opaqueSecret, ...prefixedValues]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('fails closed on invalid and duplicate-key JSON without echoing values', () => {
    const root = createRepo();
    const invalidSecret = ['InvalidJsonA7', 'InvalidJsonB8', 'InvalidJsonC9'].join('');
    const duplicateSecret = ['DuplicateJsonA7', 'DuplicateJsonB8', 'DuplicateJsonC9'].join('');
    fs.writeFileSync(
      path.join(root, 'invalid.json'),
      `{"refresh_token":\n"${invalidSecret}",}`,
    );
    fs.writeFileSync(
      path.join(root, 'duplicate.json'),
      [
        '{"refresh_token":',
        `"${duplicateSecret}",`,
        '"refresh_token":"example-placeholder-value"}',
      ].join('\n'),
    );
    git(root, 'add', 'invalid.json', 'duplicate.json');
    git(root, 'commit', '-q', '-m', 'add ambiguous JSON fixtures');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('invalid JSON artifact');
    expect(result.stdout).toContain('duplicate JSON key');
    for (const value of [invalidSecret, duplicateSecret]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('preserves JSON header and cookie context through objects and arrays', () => {
    const root = createRepo();
    const secrets = {
      namedAuthorization: ['NamedAuthA7', 'NamedAuthB8', 'NamedAuthC9'].join(''),
      namedCookie: ['NamedCookieA7', 'NamedCookieB8', 'NamedCookieC9'].join(''),
      arrayAuthorization: ['ArrayAuthA7', 'ArrayAuthB8', 'ArrayAuthC9'].join(''),
      arrayCookie: ['ArrayCookieA7', 'ArrayCookieB8', 'ArrayCookieC9'].join(''),
    };
    fs.writeFileSync(path.join(root, 'structured-headers.json'), JSON.stringify({
      headers: [
        { name: 'Authorization', value: `Bearer ${secrets.namedAuthorization}` },
      ],
      cookies: [
        { name: 'sid', value: secrets.namedCookie },
      ],
      authorization: [`Bearer ${secrets.arrayAuthorization}`],
      'set-cookie': [`session_token=${secrets.arrayCookie}; HttpOnly`],
    }, null, 2));
    git(root, 'add', 'structured-headers.json');
    git(root, 'commit', '-q', '-m', 'add structured header fixtures');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HTTP credential');
    for (const value of Object.values(secrets)) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('scans bounded logical statements across JavaScript and YAML', () => {
    const root = createRepo();
    const jsObjectSecret = ['JsObjectA7', 'JsObjectB8', 'JsObjectC9'].join('');
    const jsBracketSecret = ['JsBracketA7', 'JsBracketB8', 'JsBracketC9'].join('');
    const yamlSecret = ['YamlBlockA7', 'YamlBlockB8', 'YamlBlockC9'].join('');
    fs.writeFileSync(
      path.join(root, 'multiline-headers.js'),
      [
        'export const headers = {',
        '  Authorization:',
        `    "Bearer ${jsObjectSecret}",`,
        '};',
        'headers["Authorization"] =',
        `  "Bearer ${jsBracketSecret}";`,
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'multiline-secret.yml'),
      ['refresh_token: >', `  ${yamlSecret}`].join('\n'),
    );
    git(root, 'add', 'multiline-headers.js', 'multiline-secret.yml');
    git(root, 'commit', '-q', '-m', 'add multiline credential fixtures');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HTTP credential');
    expect(result.stdout).toContain('generic assigned secret');
    for (const value of [jsObjectSecret, jsBracketSecret, yamlSecret]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('rejects colon-bearing opaque session cookies', () => {
    const root = createRepo();
    const cookieSecret = [
      ['ColonCookieA7', 'ColonCookieB8'].join(''),
      ['ColonCookieC9', 'ColonCookieD2'].join(''),
    ].join(':');
    fs.writeFileSync(path.join(root, 'headers.txt'), `Cookie: session=${cookieSecret}\n`);
    git(root, 'add', 'headers.txt');
    git(root, 'commit', '-q', '-m', 'add colon cookie fixture');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HTTP credential');
    expect(result.stdout + result.stderr).not.toContain(cookieSecret);
  });

  it('rejects multiline JSON, quoted JavaScript headers, and decoded local paths', () => {
    const root = createRepo();
    const jsonBearer = 'a'.repeat(24);
    const jsonRefresh = 'b'.repeat(24);
    const jsBearer = 'c'.repeat(24);
    const jsCookie = 'd'.repeat(24);
    const windowsHome = ['C:', 'Users', 'StructuredFixture', 'Cache'].join('\\');
    fs.writeFileSync(
      path.join(root, 'structured.json'),
      [
        '{',
        '  "authorization":',
        `    ${JSON.stringify(`Bearer ${jsonBearer}`)},`,
        '  "nested": {',
        '    "refresh_token":',
        `      ${JSON.stringify(jsonRefresh)},`,
        `    "cache_path": ${JSON.stringify(windowsHome)}`,
        '  }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'headers.js'),
      [
        'export const headers = {',
        `  "Authorization": "Bearer ${jsBearer}",`,
        `  "Cookie": "session_token=${jsCookie}",`,
        '};',
      ].join('\n'),
    );
    git(root, 'add', 'structured.json', 'headers.js');
    git(root, 'commit', '-q', '-m', 'add structured credential fixtures');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('generic assigned secret');
    expect(result.stdout.match(/HTTP credential/g)).toHaveLength(3);
    expect(result.stdout).toContain('Windows home path');
    for (const secret of [jsonBearer, jsonRefresh, jsBearer, jsCookie, windowsHome]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
  });

  it('does not classify non-credential cookie preferences as secrets', () => {
    const root = createRepo();
    fs.writeFileSync(
      path.join(root, 'headers.txt'),
      'Cookie: auth_method=PasswordlessWebAuthn; session_theme=HighContrastDarkMode\n',
    );
    git(root, 'add', 'headers.txt');
    git(root, 'commit', '-q', '-m', 'add safe cookie preferences');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('fails closed on oversized HTTP header lines without resource amplification', () => {
    const root = createRepo();
    fs.writeFileSync(
      path.join(root, 'oversized-header.txt'),
      `"Cookie": "session_theme=${'A'.repeat(256 * 1024)}"\n`,
    );
    git(root, 'add', 'oversized-header.txt');
    git(root, 'commit', '-q', '-m', 'add oversized header fixture');

    const startedAt = Date.now();
    const result = runGate(root, '--ref', 'HEAD');
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HTTP credential');
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('fails closed on oversized text before structured parsing', () => {
    const root = createRepo();
    const oversizedJson = `[${'0,'.repeat(1024 * 1024)}0]`;
    fs.writeFileSync(path.join(root, 'oversized.json'), oversizedJson);
    git(root, 'add', 'oversized.json');
    git(root, 'commit', '-q', '-m', 'add oversized JSON fixture');

    const startedAt = Date.now();
    const result = runGate(root, '--ref', 'HEAD');
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('oversized text artifact');
    expect(result.stdout + result.stderr).not.toContain(oversizedJson.slice(0, 128));
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('rejects Windows home paths without echoing them', () => {
    const root = createRepo();
    const windowsHome = ['C:', 'Users', 'PrivateFixture', 'AppData'].join('\\');
    fs.appendFileSync(path.join(root, 'README.md'), `cache=${windowsHome}\\cache\n`);
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'docs: add local cache fixture');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Windows home path');
    expect(result.stdout + result.stderr).not.toContain(windowsHome);
  });

  it('rejects macOS and Linux home paths at boundaries and before arbitrary suffixes', () => {
    const root = createRepo();
    const macHome = ['', 'Users', 'PrivateFixture'].join('/');
    const linuxHome = ['', 'home', 'private-fixture'].join('/');
    const suffixes = [
      '@host.invalid',
      '=value',
      '&query=1',
      '?query=1',
      '#fragment',
      '<node',
      '>node',
      '|pipe',
      '!bang',
      '(call)',
      '[index]',
      '{object}',
      '+plus',
      '~tilde',
      '^caret',
      '%25encoded',
    ];
    fs.appendFileSync(
      path.join(root, 'README.md'),
      [
        `mac_home=${macHome}`,
        `linux_home=${linuxHome}`,
        ...suffixes.flatMap((suffix, index) => [
          `mac_home_${index}=${macHome}${suffix}`,
          `linux_home_${index}=${linuxHome}${suffix}`,
        ]),
        '',
      ].join('\n'),
    );
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'docs: add terminal path fixtures');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('macOS home path');
    expect(result.stdout).toContain('Linux home path');
    expect(result.stdout + result.stderr).not.toContain(macHome);
    expect(result.stdout + result.stderr).not.toContain(linuxHome);
  });

  it('rejects dotted, parenthesized, JWT, and provider secrets in the working tree', () => {
    const root = createRepo();
    const dottedSecret = ['WorkingTreeAlpha7', 'WorkingTreeBeta8', 'WorkingTreeGamma9'].join('.');
    const parenthesizedPassword = ['WorkingPasswordAlpha7', '(current)', 'WorkingPasswordBeta8'].join('');
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'working-tree-user', exp: 4102444800 })).toString('base64url'),
      Buffer.from('working-tree-signature-material').toString('base64url'),
    ].join('.');
    const providerTokens = [
      ['github', 'pat', 'D4'.repeat(16)].join('_'),
      `npm_${'E5'.repeat(18)}`,
      `xoxb-${'987654321098'}-${'F6'.repeat(16)}`,
    ];
    const sensitiveValues = [dottedSecret, parenthesizedPassword, jwt, ...providerTokens];
    fs.writeFileSync(
      path.join(root, 'staged-config.txt'),
      [
        `OAUTH_CLIENT_SECRET=${dottedSecret}`,
        `LOGIN_PASSWORD="${parenthesizedPassword}"`,
        `Authorization: Bearer ${jwt}`,
        ...providerTokens.map((token) => `credential ${token}`),
      ].join('\n'),
    );
    git(root, 'add', 'staged-config.txt');

    const result = runGate(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('generic assigned secret');
    expect(result.stdout).toContain('JWT credential');
    expect(result.stdout).toContain('GitHub fine-grained token');
    expect(result.stdout).toContain('npm access token');
    expect(result.stdout).toContain('Slack token');
    for (const value of sensitiveValues) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('rejects JavaScript template-string and numeric credential literals', () => {
    const root = createRepo();
    const templateSecret = ['TemplateSecretA7', 'TemplateSecretB8'].join('');
    const numericPassword = '7'.repeat(30);
    fs.writeFileSync(
      path.join(root, 'runtime-config.js'),
      [
        `const api_token = \`${templateSecret}\`;`,
        `const login_password = ${numericPassword};`,
      ].join('\n'),
    );
    git(root, 'add', 'runtime-config.js');
    git(root, 'commit', '-q', '-m', 'add unsafe runtime configuration');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout.match(/generic assigned secret/g)).toHaveLength(2);
    expect(result.stdout + result.stderr).not.toContain(templateSecret);
    expect(result.stdout + result.stderr).not.toContain(numericPassword);
  });

  it('ignores tracked files deleted from the working tree', () => {
    const root = createRepo();
    const deletedPath = path.join(root, 'obsolete-helper.mjs');
    fs.writeFileSync(deletedPath, 'export const obsolete = true;\n');
    git(root, 'add', 'obsolete-helper.mjs');
    git(root, 'commit', '-q', '-m', 'add obsolete helper');
    fs.rmSync(deletedPath);

    const result = runGate(root, '--include-untracked', '--fail-on-warn');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('allows placeholder, environment reference, and ordinary source fixtures', () => {
    const root = createRepo();
    const fixtures = new Map([
      [
        'release.yml',
        [
          'OAUTH_REFRESH_TOKEN: ${OAUTH_REFRESH_TOKEN}',
          'OAUTH_CLIENT_SECRET: ${{ secrets.OAUTH_CLIENT_SECRET }}',
          'OAUTH_TOKEN_URL: https://public.example.invalid/oauth/token',
        ].join('\n'),
      ],
      [
        'deployment.md',
        [
          'LOGIN_PASSWORD=your-login-password-placeholder',
          'PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE=/path/to/private-initial-admin-password',
          'service-api-key: example-placeholder-api-key',
          'tokenizer_config: AbCdEfGhJkLmNoPqRsTuVwXy',
          'The token, secret, password, and api_key labels are documented here.',
        ].join('\n'),
      ],
      [
        'config.js',
        [
          'export const APP_SECRET = process.env.APP_SECRET;',
          "process.env.LOGIN_PASSWORD = 'synthetic-web-password';",
          "const releaseNote = 'APP_SECRET is supplied by the runtime environment';",
          "const documentation = 'APP_SECRET=provided-by-runtime-environment';",
          'const access_token = session.credentials.accessToken;',
          'const refresh_token = createRefreshToken(user);',
          'const config_token = settings?.authentication?.token;',
          'const config = {',
          '  PUNCHPILOT_INITIAL_ADMIN_PASSWORD: initialAdminPassword,',
          '};',
        ].join('\n'),
      ],
    ]);
    for (const [fixturePath, content] of fixtures) {
      fs.writeFileSync(path.join(root, fixturePath), content);
    }
    git(root, 'add', ...fixtures.keys());
    git(root, 'commit', '-q', '-m', 'add safe release configuration');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('does not allow a repository-owned ignore file to bypass the gate', () => {
    const root = createRepo();
    const privateAddress = ['10', '77', '88', '99'].join('.');
    fs.writeFileSync(path.join(root, '.public-release-privacy-ignore'), '*\n');
    fs.writeFileSync(path.join(root, 'configuration.md'), `endpoint=${privateAddress}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'add configuration');

    const result = runGate(root, '--ref', 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 10.x IP');
    expect(result.stdout).not.toContain(privateAddress);
  });

  it('does not expose a sensitive file name in text or JSON findings', () => {
    const root = createRepo();
    const privateAddress = ['192', '168', '91', '17'].join('.');
    const sensitiveName = `endpoint-${privateAddress}.md`;
    fs.writeFileSync(path.join(root, sensitiveName), `endpoint=${privateAddress}\n`);
    git(root, 'add', sensitiveName);
    git(root, 'commit', '-q', '-m', 'add endpoint configuration');

    const textResult = runGate(root, '--ref', 'HEAD');
    const jsonResult = runGate(root, '--ref', 'HEAD', '--json');
    expect(textResult.status).toBe(1);
    expect(jsonResult.status).toBe(1);
    expect(textResult.stdout).not.toContain(privateAddress);
    expect(jsonResult.stdout).not.toContain(privateAddress);
    expect(textResult.stdout).toMatch(/location=[a-f0-9]{12}/);
  });

  it('rejects tracked runtime databases without exposing their path', () => {
    const root = createRepo();
    const sensitivePath = path.join('data', 'runtime-fixture.db');
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, sensitivePath), Buffer.from([0, 1, 2, 3]));
    git(root, 'add', '-f', sensitivePath);
    git(root, 'commit', '-q', '-m', 'add binary fixture');

    const result = runGate(root, '--ref', 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('path is forbidden');
    expect(result.stdout).not.toContain(sensitivePath);
  });

  it('rejects unreviewed binary artifacts outside the public asset allowlist', () => {
    const root = createRepo();
    const binaryPath = path.join('docs', 'session-fixture.bin');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, binaryPath), Buffer.from([0, 1, 2, 3]));
    git(root, 'add', binaryPath);
    git(root, 'commit', '-q', '-m', 'add binary fixture');

    const result = runGate(root, '--ref', 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unreviewed binary artifact');
    expect(result.stdout).not.toContain(binaryPath);
  });

  it('rejects a binary with an allowlisted path but an unreviewed digest', () => {
    const root = createRepo();
    const assetPath = path.join('client', 'public', 'favicon-16x16.png');
    fs.mkdirSync(path.dirname(path.join(root, assetPath)), { recursive: true });
    fs.writeFileSync(path.join(root, assetPath), 'printable but unreviewed image bytes\n');
    git(root, 'add', assetPath);
    git(root, 'commit', '-q', '-m', 'add public image');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unreviewed binary artifact');
    expect(result.stdout).not.toContain(assetPath);
  });

  it('rejects an allowlisted digest at a different path', () => {
    const root = createRepo();
    const reviewedPath = path.join('client', 'public', 'favicon-16x16.png');
    const copiedPath = path.join('docs', 'favicon-16x16.png');
    fs.mkdirSync(path.dirname(path.join(root, copiedPath)), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, reviewedPath), path.join(root, copiedPath));
    git(root, 'add', copiedPath);
    git(root, 'commit', '-q', '-m', 'copy public image');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unreviewed binary artifact');
    expect(result.stdout).not.toContain(copiedPath);
  });

  it('allows an explicitly reviewed binary path and digest pair', () => {
    const root = createRepo();
    const assetPath = path.join('client', 'public', 'favicon-16x16.png');
    fs.mkdirSync(path.dirname(path.join(root, assetPath)), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, assetPath), path.join(root, assetPath));
    git(root, 'add', assetPath);
    git(root, 'commit', '-q', '-m', 'add reviewed public image');

    const result = runGate(root, '--ref', 'HEAD', '--commit-range', 'HEAD');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe('public release privacy gate publication mode', () => {
  it('scans a raw source tag without importing its source commit or tag into Git', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const source = '1'.repeat(40);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-raw-source-tag-')); tempRoots.push(outside);
    const raw = path.join(outside, 'source-tag.raw');
    fs.writeFileSync(raw, `object ${source}\ntype commit\ntag v1.2.3\ntagger Fixture <fixture@example.invalid> 1700000000 +0000\n\nv1.2.3\n\nsource: gitea/${source}\nsource-tree: ${tree}\n`);
    const clean = runPublicationGate(root, '--commit-envelope', publication, '--tag-envelope-file', raw, '--fail-on-warn');
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    fs.appendFileSync(raw, 'endpoint=https://private.example.invalid/review\n');
    const blocked = runPublicationGate(root, '--commit-envelope', publication, '--tag-envelope-file', raw, '--fail-on-warn');
    expect(blocked.status).toBe(1); expect(blocked.stdout).toContain('tag metadata: forbidden internal hostname');
    expect(() => git(root, 'cat-file', '-t', source)).toThrow();
  });
  it('makes an actual privacy warning fatal on the publication boundary', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent, `follow issue #${123}`);
    const result = runPublicationGate(root, '--commit-envelope', publication, '--fail-on-warn');
    expect(result.status).toBe(1); expect(result.stdout).toContain('[WARN]');
  });
  it('accepts a clean tree + commit-envelope + tag-envelope', () => {
    const root = createRepo();
    const publicParent = git(root, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(root, 'README.md'), 'public source tree\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'docs: prepare public source tree');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, publicParent);
    const tag = createAnnotatedTag(root, 'publication-v1', publication, 'release: public tag');

    const result = runPublicationGate(
      root,
      '--commit-envelope',
      publication,
      '--tree',
      tree,
      '--tag-envelope',
      tag,
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("still rejects forbidden hosts in P's author and committer identities", () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    const internalEmail = `bot@${forbiddenHost}`;
    git(root, 'config', 'user.name', 'Publication Bot');
    git(root, 'config', 'user.email', internalEmail);
    const publication = createPublicationCommit(root, tree, parent);
    expect(git(root, 'show', '-s', '--format=%ae %ce', publication)).toBe(
      `${internalEmail} ${internalEmail}`,
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--commit-envelope',
      publication,
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit metadata: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it("accepts P's clean author and committer identities", () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const forbiddenHost = ['private', 'example', 'invalid'].join('.');
    const cleanEmail = 'bot@users.noreply.github.com';
    git(root, 'config', 'user.name', 'Publication Bot');
    git(root, 'config', 'user.email', cleanEmail);
    const publication = createPublicationCommit(root, tree, parent);
    expect(git(root, 'show', '-s', '--format=%ae %ce', publication)).toBe(
      `${cleanEmail} ${cleanEmail}`,
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--commit-envelope',
      publication,
      '--require-forbidden-hosts',
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('accepts the exact frozen source tag-message lines', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const sourceSha = `${'0123456789abcdef'.repeat(2)}01234567`;
    const sourceTree = `${'fedcba9876543210'.repeat(2)}fedcba98`;
    const tag = createAnnotatedTag(
      root,
      'publication-source-attestation',
      publication,
      [
        'release: public tag',
        `source: gitea/${sourceSha}`,
        `source-tree: ${sourceTree}`,
      ].join('\n'),
    );

    const result = runPublicationGate(
      root,
      '--commit-envelope',
      publication,
      '--tag-envelope',
      tag,
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('rejects extra content after a source tag-message line', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const sourceSha = `${'0123456789abcdef'.repeat(2)}01234567`;
    const tag = createAnnotatedTag(
      root,
      'publication-source-extra-content',
      publication,
      `source: gitea/${sourceSha} extracontent`,
    );

    const result = runPublicationGate(
      root,
      '--commit-envelope',
      publication,
      '--tag-envelope',
      tag,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('tag metadata: unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(sourceSha);
  });

  it('rejects a bare 40-character hexadecimal value in a tag message', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const opaqueValue = `${'0123456789abcdef'.repeat(2)}01234567`;
    const tag = createAnnotatedTag(
      root,
      'publication-bare-hex',
      publication,
      ['release: public tag', opaqueValue].join('\n'),
    );

    const result = runPublicationGate(
      root,
      '--commit-envelope',
      publication,
      '--tag-envelope',
      tag,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('tag metadata: unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(opaqueValue);
  });

  it('rejects unverified high-entropy PGP armor in a tag message', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const signatureLine = createHash('sha512')
      .update('clean signed publication tag fixture')
      .digest('base64');
    const tag = createAnnotatedTag(
      root,
      'publication-signed-tag',
      publication,
      [
        'release: signed public tag',
        '-----BEGIN PGP SIGNATURE-----',
        '',
        signatureLine,
        '-----END PGP SIGNATURE-----',
      ].join('\n'),
    );

    const result = runPublicationGate(
      root,
      '--commit-envelope',
      publication,
      '--tag-envelope',
      tag,
    );

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('tag metadata: unverified or unsupported signature material');
    expect(result.stdout).toContain('tag metadata: unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(signatureLine);
  });

  it('rejects forbidden hosts and unverified entropy inside tag PGP armor', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const forbiddenHost = ['signed-tag', 'private', 'invalid'].join('.');
    const signatureLine = createHash('sha512')
      .update('signed publication tag with forbidden host fixture')
      .digest('base64');
    const tag = createAnnotatedTag(
      root,
      'publication-signed-tag-host',
      publication,
      [
        'release: signed public tag',
        '-----BEGIN PGP SIGNATURE-----',
        '',
        signatureLine,
        `Comment: https://${forbiddenHost}/review`,
        '-----END PGP SIGNATURE-----',
      ].join('\n'),
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--commit-envelope',
      publication,
      '--tag-envelope',
      tag,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('tag metadata: forbidden internal hostname');
    expect(result.stdout).toContain('tag metadata: unverified or unsupported signature material');
    expect(result.stdout).toContain('tag metadata: unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(signatureLine);
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it('does not exempt high entropy in unterminated tag PGP signature armor', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const signatureLine = createHash('sha512')
      .update('unterminated signed publication tag fixture')
      .digest('base64');
    const tag = createAnnotatedTag(
      root,
      'publication-unterminated-signature',
      publication,
      [
        'release: malformed signed public tag',
        '-----BEGIN PGP SIGNATURE-----',
        '',
        signatureLine,
      ].join('\n'),
    );

    const result = runPublicationGate(
      root,
      '--commit-envelope',
      publication,
      '--tag-envelope',
      tag,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('tag metadata: unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(signatureLine);
  });

  it('requires forbidden-host rules in publication mode without a flag', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);

    const missing = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: '' },
      '--commit-envelope',
      publication,
    );
    const configured = runPublicationGate(root, '--commit-envelope', publication);

    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('PUBLIC_RELEASE_FORBIDDEN_HOSTS is required for public release');
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  });

  it("rejects a forbidden host in P's commit message", () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const forbiddenHost = ['publication', 'private', 'invalid'].join('.');
    const publication = createPublicationCommit(
      root,
      tree,
      parent,
      `release from ${forbiddenHost}`,
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--commit-envelope',
      publication,
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit message: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it("rejects a forbidden host in P's annotated-tag message", () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const forbiddenHost = ['tag', 'private', 'invalid'].join('.');
    const tag = createAnnotatedTag(
      root,
      'publication-tag-leak',
      publication,
      `release from ${forbiddenHost}`,
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--commit-envelope',
      publication,
      '--tag-envelope',
      tag,
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('tag metadata: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });

  it("publication mode does not walk P's ancestor history", () => {
    const root = createRepo();
    const secret = ['AncestorSecretA7', 'AncestorSecretB8', 'AncestorSecretC9'].join('');
    fs.writeFileSync(path.join(root, 'ancestor-only.txt'), `token=${secret}\n`);
    git(root, 'add', 'ancestor-only.txt');
    git(root, 'commit', '-q', '-m', 'add ancestor-only fixture');
    fs.rmSync(path.join(root, 'ancestor-only.txt'));
    git(root, 'add', '-u');
    git(root, 'commit', '-q', '-m', 'remove ancestor-only fixture');
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);

    const result = runPublicationGate(root, '--commit-envelope', publication, '--tree', tree);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('publication mode requires --commit-envelope', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const privateAddress = ['10', '29', '41', '53'].join('.');
    createPublicationCommit(root, tree, parent, `release from ${privateAddress}`);

    const result = runGate(root, '--tree', tree);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('publication mode requires --commit-envelope');
    expect(result.stdout + result.stderr).not.toContain(privateAddress);
  });

  it('rejects a --tree that does not match the commit-envelope tree', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const cleanTree = git(root, 'rev-parse', 'HEAD^{tree}');
    const privateAddress = ['10', '31', '43', '59'].join('.');
    fs.writeFileSync(path.join(root, 'published.txt'), `endpoint=${privateAddress}\n`);
    git(root, 'add', 'published.txt');
    git(root, 'commit', '-q', '-m', 'add published tree fixture');
    const publishedTree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, publishedTree, parent);

    const result = runPublicationGate(
      root,
      '--commit-envelope',
      publication,
      '--tree',
      cleanTree,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('publication --tree does not match --commit-envelope tree');
    expect(result.stdout + result.stderr).not.toContain(privateAddress);
  });

  it("--commit-envelope alone derives and scans P's tree", () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const privateAddress = ['10', '37', '47', '61'].join('.');
    fs.writeFileSync(path.join(root, 'published.txt'), `endpoint=${privateAddress}\n`);
    git(root, 'add', 'published.txt');
    git(root, 'commit', '-q', '-m', 'add published tree fixture');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);

    const result = runPublicationGate(root, '--commit-envelope', publication);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 10.x IP');
    expect(result.stdout + result.stderr).not.toContain(privateAddress);
  });

  it('ignores replacement refs when scanning the published commit', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const cleanTree = git(root, 'rev-parse', 'HEAD^{tree}');
    const privateAddress = ['10', '41', '53', '67'].join('.');
    fs.writeFileSync(path.join(root, 'published.txt'), `endpoint=${privateAddress}\n`);
    git(root, 'add', 'published.txt');
    git(root, 'commit', '-q', '-m', 'add replacement-ref fixture');
    const publishedTree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(
      root,
      publishedTree,
      parent,
      `release from ${privateAddress}`,
    );
    const cleanReplacement = createPublicationCommit(root, cleanTree, parent);
    git(root, 'replace', publication, cleanReplacement);

    const result = runPublicationGate(root, '--commit-envelope', publication);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private 10.x IP');
    expect(result.stdout + result.stderr).not.toContain(privateAddress);
  });

  it('rejects combining publication flags with --ref/--commit-range', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);

    const withRef = runGate(root, '--commit-envelope', publication, '--ref', 'HEAD');
    const withRange = runGate(
      root,
      '--commit-envelope',
      publication,
      '--commit-range',
      'HEAD',
    );

    for (const result of [withRef, withRange]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('publication mode cannot combine with --ref/--commit-range');
    }
  });

  it('--ref on a clean annotated tag does not spuriously FAIL', () => {
    const root = createRepo();
    const tag = createAnnotatedTag(
      root,
      'clean-annotated-tag',
      git(root, 'rev-parse', 'HEAD'),
      'release: clean tag',
    );

    const result = runGate(root, '--ref', tag);

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('scans both public tags when --tag-envelope is repeated', () => {
    const root = createRepo();
    const parent = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const publication = createPublicationCommit(root, tree, parent);
    const cleanTag = createAnnotatedTag(
      root,
      'publication-clean-tag',
      publication,
      'release: clean public tag',
    );
    const forbiddenHost = ['second-tag', 'private', 'invalid'].join('.');
    const leakyTag = createAnnotatedTag(
      root,
      'publication-leaky-tag',
      publication,
      `release from ${forbiddenHost}`,
    );

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--commit-envelope',
      publication,
      '--tag-envelope',
      cleanTag,
      '--tag-envelope',
      leakyTag,
      '--require-forbidden-hosts',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('tag metadata: forbidden internal hostname');
    expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
  });
});

describe('public release privacy gate LFS and embedded binary scanning', () => {
  it('rejects a git-lfs pointer blob', () => {
    const root = createRepo();
    const pointerPath = 'release-asset.dat';
    fs.writeFileSync(
      path.join(root, pointerPath),
      [
        'version https://git-lfs.github.com/spec/v1',
        `oid sha256:${'a'.repeat(64)}`,
        'size 12345',
        '',
      ].join('\n'),
    );
    git(root, 'add', pointerPath);
    git(root, 'commit', '-q', '-m', 'add LFS pointer fixture');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('git-lfs pointer: content not scannable');
    expect(result.stdout).not.toContain(pointerPath);
  });

  it('rejects a forbidden host embedded in a PNG tEXt chunk', () => {
    const forbiddenHost = ['image', 'private', 'invalid'].join('.');
    const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

    const craftedRoot = createRepo();
    const craftedPath = 'crafted.png';
    fs.writeFileSync(
      path.join(craftedRoot, craftedPath),
      Buffer.concat([pngSignature, pngTextChunk(forbiddenHost)]),
    );
    git(craftedRoot, 'add', craftedPath);
    git(craftedRoot, 'commit', '-q', '-m', 'add PNG text fixture');
    const craftedResult = runGateWithEnv(
      craftedRoot,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );

    const pinnedRoot = createRepo();
    const pinnedPath = path.join('client', 'public', 'favicon-16x16.png');
    fs.mkdirSync(path.dirname(path.join(pinnedRoot, pinnedPath)), { recursive: true });
    const pinnedBytes = fs.readFileSync(path.join(projectRoot, pinnedPath));
    fs.writeFileSync(
      path.join(pinnedRoot, pinnedPath),
      Buffer.concat([pinnedBytes, pngTextChunk(forbiddenHost)]),
    );
    git(pinnedRoot, 'add', pinnedPath);
    git(pinnedRoot, 'commit', '-q', '-m', 'add reviewed PNG with text fixture');
    const pinnedResult = runGateWithEnv(
      pinnedRoot,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );

    for (const result of [craftedResult, pinnedResult]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('embedded string: forbidden internal hostname');
      expect(result.stdout + result.stderr).not.toContain(forbiddenHost);
    }
    expect(craftedResult.stdout + craftedResult.stderr).not.toContain(craftedPath);
    expect(pinnedResult.stdout + pinnedResult.stderr).not.toContain(pinnedPath);
  });

  it('fails closed on oversized compressed PNG text without resource amplification', () => {
    const root = createRepo();
    const binaryPath = 'compressed-metadata.png';
    const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
    const compressedText = 'A'.repeat((1024 * 1024) + 1);
    fs.writeFileSync(
      path.join(root, binaryPath),
      Buffer.concat([pngSignature, pngCompressedTextChunk(compressedText)]),
    );
    git(root, 'add', binaryPath);
    git(root, 'commit', '-q', '-m', 'add compressed PNG text fixture');

    const startedAt = Date.now();
    const result = runGate(root, '--ref', 'HEAD');
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('could not inspect Git ref');
    expect(result.stdout + result.stderr).not.toContain(binaryPath);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('bounds cumulative expansion across compressed PNG text chunks', () => {
    const root = createRepo();
    const binaryPath = 'many-compressed-metadata.png';
    const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
    const chunks = Array.from(
      { length: 64 },
      () => pngCompressedTextChunk('A'.repeat(20 * 1024)),
    );
    fs.writeFileSync(
      path.join(root, binaryPath),
      Buffer.concat([pngSignature, ...chunks]),
    );
    git(root, 'add', binaryPath);
    git(root, 'commit', '-q', '-m', 'add many compressed PNG text chunks');

    const startedAt = Date.now();
    const result = runGate(root, '--ref', 'HEAD');
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('could not inspect Git ref');
    expect(result.stdout + result.stderr).not.toContain(binaryPath);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('rejects a macOS home path embedded in a .bin blob', () => {
    const root = createRepo();
    const binaryPath = 'release.bin';
    const homePath = ['', 'Users', 'leak', 'private-release'].join('/');
    fs.writeFileSync(path.join(root, binaryPath), Buffer.from(`\0 ${homePath} \0`));
    git(root, 'add', binaryPath);
    git(root, 'commit', '-q', '-m', 'add embedded path fixture');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded string: macOS home path');
    expect(result.stdout + result.stderr).not.toContain(homePath);
    expect(result.stdout).not.toContain(binaryPath);
  });

  it('rejects a UTF-16LE embedded provider token', () => {
    const root = createRepo();
    const binaryPath = 'provider-token.bin';
    const token = `ghp_${'A1'.repeat(20)}`;
    fs.writeFileSync(
      path.join(root, binaryPath),
      Buffer.concat([Buffer.from([0]), Buffer.from(token, 'utf16le')]),
    );
    git(root, 'add', binaryPath);
    git(root, 'commit', '-q', '-m', 'add UTF-16 token fixture');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded string: GitHub token');
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout).not.toContain(binaryPath);
  });

  it('allows the pinned public icons under embedded scanning', () => {
    const root = createRepo();
    const assetPaths = [
      'client/public/android-chrome-192x192.png',
      'client/public/android-chrome-512x512.png',
      'client/public/apple-touch-icon.png',
      'client/public/favicon-16x16.png',
      'client/public/favicon-32x32.png',
      'client/public/favicon.ico',
      'client/public/logo-256.png',
    ];
    for (const assetPath of assetPaths) {
      fs.mkdirSync(path.dirname(path.join(root, assetPath)), { recursive: true });
      fs.copyFileSync(path.join(projectRoot, assetPath), path.join(root, assetPath));
    }
    git(root, 'add', ...assetPaths);
    git(root, 'commit', '-q', '-m', 'add pinned public icons');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('does not flag high-entropy binary noise', () => {
    const root = createRepo();
    const binaryPath = 'high-entropy-noise.bin';
    const printableNoise = createHash('sha512')
      .update('deterministic embedded binary noise')
      .digest('base64')
      .repeat(4)
      .slice(0, 200);
    fs.writeFileSync(
      path.join(root, binaryPath),
      Buffer.concat([Buffer.from([0]), Buffer.from(printableNoise), Buffer.from([0])]),
    );
    git(root, 'add', binaryPath);
    git(root, 'commit', '-q', '-m', 'add binary noise fixture');

    const result = runGate(root, '--ref', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unreviewed binary artifact');
    expect(result.stdout).not.toContain('unclassified high-entropy credential');
    expect(result.stdout + result.stderr).not.toContain(printableNoise);
  });
});

describe('public release privacy gate layer-B export allowlist', () => {
  it('accepts a tree whose paths are all covered by the export allowlist pathset', () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'notes.md'), '# public notes\n');
    git(root, 'add', 'notes.md');
    git(root, 'commit', '-q', '-m', 'add public notes');

    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: { version: 1, include: ['README.md', 'notes.md'], exclude: [] },
      scan: false,
    });
    const pathsetFile = writePathsetProvenance(result.provenance);

    const clean = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', pathsetFile);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain('OK');
  });

  it('trips the gate on an unexpected path not covered by the export allowlist', () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'notes.md'), '# public notes\n');
    git(root, 'add', 'notes.md');
    git(root, 'commit', '-q', '-m', 'add public notes');
    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: { version: 1, include: ['README.md', 'notes.md'], exclude: [] },
      scan: false,
    });
    const pathsetFile = writePathsetProvenance(result.provenance);

    // A NEW path appears after the pathset was computed from the exporter.
    fs.writeFileSync(path.join(root, 'unexpected.txt'), '# unexpected\n');
    git(root, 'add', 'unexpected.txt');
    git(root, 'commit', '-q', '-m', 'add unexpected path');

    const blocked = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', pathsetFile);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('path not covered by export allowlist');
  });

  it('fails closed when the pathset digest does not match its path list', () => {
    const root = createRepo();
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const provenance = buildProvenance({
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
      sourceTree: tree,
      treeSha: tree,
      policy: { version: 1, include: ['README.md'], exclude: [] },
      policyHash: '0'.repeat(64),
      pathset: ['README.md'],
      excluded: [],
      publicBase: null,
    });
    const tampered = { ...provenance, pathset: ['README.md', 'sneaky.txt'] };
    const pathsetFile = writePathsetProvenance(tampered);

    const result = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', pathsetFile);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('export allowlist pathset digest mismatch');
  });

  it('fails closed when the allowlist pathset file is missing or malformed', () => {
    const root = createRepo();
    const missing = runGate(
      root,
      '--ref',
      'HEAD',
      '--allowlist-pathset',
      path.join(root, 'nope.json'),
    );
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('could not read export allowlist pathset');

    const badFile = writePathsetProvenance({ pathset: 'not-an-array' });
    const bad = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', badFile);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("'pathset' array of strings");
  });

  it('fails closed when --allowlist-pathset is present with an empty value', () => {
    const root = createRepo();
    const result = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', '');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('could not read export allowlist pathset');
  });

  it('fails closed without a traceback on an invalid path encoding', () => {
    const root = createRepo();
    const pathsetFile = writePathsetProvenance({
      pathset: ['README.md', '\uD83D-x.txt'],
      pathsetSha256: '0'.repeat(64),
    });
    const result = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', pathsetFile);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('export allowlist pathset contains an invalid path encoding');
    expect(result.stderr).not.toContain('Traceback');
  });

  it('uses the exporter UTF-16 path ordering when verifying the pathset digest', () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, '\u{1F642}.txt'), 'astral path\n');
    fs.writeFileSync(path.join(root, '\uFF5E.txt'), 'fullwidth path\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'add non-BMP ordering fixtures');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const provenance = buildProvenance({
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
      sourceTree: tree,
      treeSha: tree,
      policy: { version: 1, include: ['README.md', '*.txt'], exclude: [] },
      policyHash: '0'.repeat(64),
      pathset: ['README.md', '\u{1F642}.txt', '\uFF5E.txt'],
      excluded: [],
      publicBase: null,
    });
    const pathsetFile = writePathsetProvenance(provenance);

    const clean = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', pathsetFile);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
  });

  it('trips on an unexpected working-tree path', () => {
    const root = createRepo();
    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: { version: 1, include: ['README.md'], exclude: [] },
      scan: false,
    });
    const pathsetFile = writePathsetProvenance(result.provenance);
    fs.writeFileSync(path.join(root, 'stray.txt'), 'stray\n');

    const blocked = runGate(root, '--allowlist-pathset', pathsetFile, '--include-untracked');
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('path not covered by export allowlist');
  });

  it('trips on a historical path not covered by the export allowlist in commit-range mode', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'notes.md'), '# notes\n');
    git(root, 'add', 'notes.md');
    git(root, 'commit', '-q', '-m', 'add notes');
    // The path is deleted again, so it is absent from the current pathset.
    fs.rmSync(path.join(root, 'notes.md'));
    git(root, 'add', '-u', 'notes.md');
    git(root, 'commit', '-q', '-m', 'remove notes');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: { version: 1, include: ['README.md'], exclude: [] },
      scan: false,
    });
    const pathsetFile = writePathsetProvenance(result.provenance);

    const blocked = runGate(
      root,
      '--commit-range',
      `${base}..${head}`,
      '--allowlist-pathset',
      pathsetFile,
    );
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('path not covered by export allowlist');
  });

  it('accepts covered real paths behind commit-range reporting prefixes', () => {
    const root = createRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'notes.md'), '# covered notes\n');
    git(root, 'add', 'notes.md');
    git(root, 'commit', '-q', '-m', 'add covered notes');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = exportPublicTree({
      repoRoot: root,
      source: 'HEAD',
      policy: { version: 1, include: ['README.md', 'notes.md'], exclude: [] },
      scan: false,
    });
    const pathsetFile = writePathsetProvenance(result.provenance);

    const clean = runGate(
      root,
      '--commit-range',
      `${base}..${head}`,
      '--allowlist-pathset',
      pathsetFile,
    );
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
  });

  it('does not collapse a real commit-prefixed path onto an allowlisted path', () => {
    const root = createRepo();
    const collisionDir = path.join(root, 'commit-0123456789ab');
    fs.mkdirSync(collisionDir);
    fs.writeFileSync(path.join(collisionDir, 'README.md'), '# unexpected historical-looking path\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'add commit-prefixed path');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const provenance = buildProvenance({
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
      sourceTree: tree,
      treeSha: tree,
      policy: { version: 1, include: ['README.md'], exclude: [] },
      policyHash: '0'.repeat(64),
      pathset: ['README.md'],
      excluded: ['commit-0123456789ab/README.md'],
      publicBase: null,
    });
    const pathsetFile = writePathsetProvenance(provenance);

    const blocked = runGate(
      root,
      '--ref',
      'HEAD',
      '--allowlist-pathset',
      pathsetFile,
    );
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('path not covered by export allowlist');
  });

  it('does not normalize a backslash tree path onto an allowlisted slash path', () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'server\\app.js'), 'export const clean = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'add backslash path');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const provenance = buildProvenance({
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
      sourceTree: tree,
      treeSha: tree,
      policy: { version: 1, include: ['README.md', 'server/app.js'], exclude: [] },
      policyHash: '0'.repeat(64),
      pathset: ['README.md', 'server/app.js'],
      excluded: [],
      publicBase: null,
    });
    const pathsetFile = writePathsetProvenance(provenance);

    const blocked = runGate(root, '--ref', 'HEAD', '--allowlist-pathset', pathsetFile);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('path not covered by export allowlist');
  });
});

describe('public release privacy gate rule-evasion residuals', () => {
  it.each([
    'build[.]corp',
    'build(.)corp',
    'build[dot]corp',
    'build(dot)corp',
    'build dot corp',
  ])('rejects the defanged forbidden host %s (SF-4)', (defangedHost) => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'endpoints.txt'), `see ${defangedHost} for details\n`);
    git(root, 'add', 'endpoints.txt');
    git(root, 'commit', '-q', '-m', 'add defanged endpoint fixtures');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
  });

  it('does not treat an arbitrary parenthesized character as a hostname separator', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'the build(x)corp label is not a hostname\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'add non-host parenthetical fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('rejects a forbidden host split across a newline (SF-3)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'endpoint=build.\ncorp\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'add wrapped endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
  });

  it('rejects a forbidden host split across multiple blank lines (SF-3)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'endpoint=build.\n\n\n\ncorp\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'add widely wrapped endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
  });

  it('preserves a host boundary at the start of a later physical line', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'the host is\nbuild.\ncorp\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'add host after unrelated line context');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('line=2 forbidden internal hostname');
  });

  it.each([
    'notbuild.\ncorp\n',
    'build.\ncorpuses\n',
  ])('does not invent a hostname boundary inside a longer label: %s', (content) => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'notes.txt'), content);
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'add longer hostname label control');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('forbidden internal hostname');
  });

  it('rejects a split forbidden host beyond the former whitespace window', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const trailing = ' '.repeat(507);
    const leading = '\t'.repeat(509);
    fs.writeFileSync(path.join(root, 'notes.txt'), `endpoint=build.${trailing}\n${leading}corp\n`);
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'add padded wrapped endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
  });

  it('rejects a base64-encoded short forbidden host in a text blob (SF-2)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const b64 = Buffer.from(forbiddenHost).toString('base64');
    expect(b64.length).toBeLessThan(32); // under the high-entropy floor
    fs.writeFileSync(path.join(root, 'deploy.txt'), `# deploy target: ${b64}\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add encoded endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
    expect(result.stdout).toContain('embedded base64:');
  });

  it('rejects an unpadded base64 forbidden host (SF-2)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const unpadded = Buffer.from(forbiddenHost).toString('base64url');
    fs.writeFileSync(
      path.join(root, 'deploy.txt'),
      `target=${unpadded}\n`,
    );
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add unpadded endpoint fixtures');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
  });

  it('rejects unpadded base64 adjacent to alphanumeric text (SF-2)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const unpadded = Buffer.from(forbiddenHost).toString('base64url');
    fs.writeFileSync(path.join(root, 'deploy.txt'), `wrapped=xx${unpadded}yy\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add adjacent encoded endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
  });

  it('rejects padded base64 adjacent to alphanumeric text (SF-2)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const padded = Buffer.from(forbiddenHost).toString('base64');
    fs.writeFileSync(path.join(root, 'deploy.txt'), `wrapped=xx${padded}yy\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add padded adjacent endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
  });

  it.each([
    ['non-printable left context', `AAAA${Buffer.from('build.corp').toString('base64url')}`],
    ['non-ASCII left context', `////${Buffer.from('build.corp').toString('base64url')}`],
    ['non-printable right context', `${Buffer.from('build.corp').toString('base64url')}AAAA`],
  ])('rejects base64 with %s', (_label, encodedLine) => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'deploy.txt'), `target=${encodedLine}\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add encoded endpoint with binary context');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
  });

  it.each([
    'AAAAAAAA=YnVpbGQuY29ycA=BBBBBBBB',
    'YnVpbGQuY29ycA=BBBB',
    'QUJDREVGRw==AbYnVpbGQuY29ycA==Gh',
  ])('rejects a forbidden host in a non-final base64 segment: %s', (encodedLine) => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    fs.writeFileSync(path.join(root, 'deploy.txt'), `${encodedLine}\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add non-final encoded endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
  });

  it('does not let invalid base64 decoys exhaust the candidate budget (SF-2)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const encoded = Buffer.from(forbiddenHost).toString('base64');
    const decoys = Array.from({ length: 70 }, () => 'AAAAAAAA').join('=');
    fs.writeFileSync(path.join(root, 'deploy.txt'), `${decoys} ${encoded}\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add encoded endpoint after invalid decoys');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
  });

  it('fails closed instead of silently truncating one excessive base64 candidate', () => {
    const root = createRepo();
    const segments = Array.from(
      { length: 130 },
      (_, index) => `SEG${String(index).padStart(5, '0')}`,
    ).join('=');
    fs.writeFileSync(path.join(root, 'deploy.txt'), `${segments}\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add excessive encoded candidate fixture');

    const result = runGate(root, '--ref', 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('base64 scan variant limit exceeded');
  });

  it('does not count independent ordinary words against one base64 candidate limit', () => {
    const root = createRepo();
    const words = Array.from({ length: 150 }, (_, index) => `normalword${index}`);
    fs.writeFileSync(path.join(root, 'notes.txt'), `${words.join(' ')}\n`);
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'add long ordinary prose line');

    const result = runGate(root, '--ref', 'HEAD');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('base64 scan variant limit exceeded');
  });

  it('does not merge independent padded base64 lines into one candidate', () => {
    const root = createRepo();
    const tokens = Array.from(
      { length: 130 },
      (_, index) => Buffer.from(`token-sample-${String(index).padStart(5, '0')}`).toString('base64'),
    );
    fs.writeFileSync(path.join(root, 'tokens.txt'), `${tokens.join('\n')}\n`);
    git(root, 'add', 'tokens.txt');
    git(root, 'commit', '-q', '-m', 'add independent padded token fixtures');

    const result = runGate(root, '--ref', 'HEAD');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('base64 scan variant limit exceeded');
  });

  it('does not merge independent assignment lines into one candidate', () => {
    const root = createRepo();
    const assignments = Array.from(
      { length: 130 },
      (_, index) => `KEY${String(index).padStart(5, '0')}=VALUE${String(index).padStart(5, '0')}`,
    );
    fs.writeFileSync(path.join(root, 'settings.txt'), `${assignments.join('\n')}\n`);
    git(root, 'add', 'settings.txt');
    git(root, 'commit', '-q', '-m', 'add independent assignment fixtures');

    const result = runGate(root, '--ref', 'HEAD');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('base64 scan variant limit exceeded');
  });

  it.each([6, 8, 12])(
    'rejects a base64 forbidden host followed by %i padding characters',
    (paddingLength) => {
      const root = createRepo();
      const forbiddenHost = ['build', 'corp'].join('.');
      const encoded = Buffer.from(forbiddenHost).toString('base64url');
      fs.writeFileSync(
        path.join(root, 'deploy.txt'),
        `ref ${encoded}${'='.repeat(paddingLength)}\n`,
      );
      git(root, 'add', 'deploy.txt');
      git(root, 'commit', '-q', '-m', 'add over-padded endpoint fixture');

      const result = runGateWithEnv(
        root,
        { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
        '--ref',
        'HEAD',
        '--require-forbidden-hosts',
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
    },
  );

  it('rejects a base64-encoded forbidden host split across lines (SF-2/SF-3)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const encoded = Buffer.from(forbiddenHost).toString('base64url');
    const midpoint = Math.floor(encoded.length / 2);
    fs.writeFileSync(
      path.join(root, 'deploy.txt'),
      `metadata:\n${encoded.slice(0, midpoint)}\n${encoded.slice(midpoint)}\n`,
    );
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add wrapped encoded endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('line=2 embedded base64: forbidden internal hostname');
    expect(result.stdout.match(/embedded base64: forbidden internal hostname/g)).toHaveLength(1);
  });

  it.each([
    ['printable left context', 'dGVz', ''],
    ['printable right context', '', 'dGVz'],
  ])(
    'rejects a split base64 host with %s from another physical line',
    (_label, prefix, suffix) => {
      const root = createRepo();
      const forbiddenHost = ['build', 'corp'].join('.');
      const encoded = Buffer.from(forbiddenHost).toString('base64url');
      fs.writeFileSync(
        path.join(root, 'deploy.txt'),
        `${prefix || encoded}\n${prefix ? encoded : suffix}\n`,
      );
      git(root, 'add', 'deploy.txt');
      git(root, 'commit', '-q', '-m', 'add split endpoint with line context');

      const result = runGateWithEnv(
        root,
        { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
        '--ref',
        'HEAD',
        '--require-forbidden-hosts',
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
    },
  );

  it('rejects a base64 forbidden host split across multiple blank lines (SF-2/SF-3)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const encoded = Buffer.from(forbiddenHost).toString('base64url');
    const midpoint = Math.floor(encoded.length / 2);
    fs.writeFileSync(
      path.join(root, 'deploy.txt'),
      `${encoded.slice(0, midpoint)}\n\n\n\n${encoded.slice(midpoint)}\n`,
    );
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add widely wrapped encoded endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
    expect(result.stdout.match(/embedded base64: forbidden internal hostname/g)).toHaveLength(1);
  });

  it('rejects a base64 forbidden host split across more than four physical lines', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const encoded = Buffer.from(forbiddenHost).toString('base64url');
    const wrapped = encoded.match(/.{1,3}/g).join('\n');
    expect(wrapped.split('\n').length).toBeGreaterThan(4);
    fs.writeFileSync(path.join(root, 'deploy.txt'), `${wrapped}\n`);
    git(root, 'add', 'deploy.txt');
    git(root, 'commit', '-q', '-m', 'add multi-line encoded endpoint fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('embedded base64: forbidden internal hostname');
    expect(result.stdout.match(/embedded base64: forbidden internal hostname/g)).toHaveLength(1);
  });

  it('rejects a base64-encoded short forbidden host in a commit message (SF-2/F13)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const b64 = Buffer.from(forbiddenHost).toString('base64');
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'commit', '--allow-empty', '-q', '-m', `deploy ${b64}`);
    const head = git(root, 'rev-parse', 'HEAD');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--commit-range',
      `${base}..${head}`,
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
  });

  it('rejects a base64-encoded short forbidden host embedded in a binary blob (SF-2)', () => {
    const root = createRepo();
    const forbiddenHost = ['build', 'corp'].join('.');
    const b64 = Buffer.from(`# deploy ${forbiddenHost}\n`).toString('base64');
    fs.writeFileSync(
      path.join(root, 'blob.bin'),
      Buffer.concat([
        Buffer.from([0x00, 0xff, 0x01]),
        Buffer.from(b64),
        Buffer.from([0x02, 0xfe]),
      ]),
    );
    git(root, 'add', 'blob.bin');
    git(root, 'commit', '-q', '-m', 'add encoded binary fixture');

    const result = runGateWithEnv(
      root,
      { PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHost },
      '--ref',
      'HEAD',
      '--require-forbidden-hosts',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden internal hostname');
  });

  it('documents embedded-scan coverage limits honestly in the module docstring (item 3)', () => {
    const source = fs.readFileSync(gate, 'utf8');
    const docstring = source.slice(
      source.indexOf('"""'),
      source.indexOf('"""', source.indexOf('"""') + 3),
    );
    expect(docstring).toMatch(/does not decompress/i);
    expect(docstring).toMatch(/ALLOWED_BINARY_ARTIFACTS/);
    expect(docstring).toMatch(/hash-pin/i);
  });
});
