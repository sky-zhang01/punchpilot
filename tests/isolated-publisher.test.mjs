import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalObjects, digest, gitObjectId, jsonBytes, platformProtection } from '../scripts/ci/publication-contract.mjs';
import { computePolicyHash } from '../scripts/ci/export-public-tree.mjs';
import { githubRequest, publicCIGate, validateArtifact, verifyLivePlatform, withPublicationLock } from '../scripts/ci/isolated-publisher.mjs';
import { reviewedAdmission } from './helpers/publication-fixtures.mjs';

const temporary = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const publisherUrl = new URL('../scripts/ci/isolated-publisher.mjs', import.meta.url).href;
const responseCanary = 'synthetic-api-response-secret';
function lockWorker(state, label, hold = 100) {
  const program = `import fs from 'node:fs'; import path from 'node:path'; import { withPublicationLock } from ${JSON.stringify(publisherUrl)};
    await withPublicationLock(process.argv[1], async()=>{fs.appendFileSync(path.join(process.argv[1],'events'),process.argv[2]+' start\\n');console.log('HELD');await new Promise(r=>setTimeout(r,Number(process.argv[3])));fs.appendFileSync(path.join(process.argv[1],'events'),process.argv[2]+' end\\n');});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, state, label, String(hold)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { error += data; });
  const closed = new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal, output, error })));
  const held = new Promise((resolve, reject) => { child.stdout.on('data', () => { if (output.includes('HELD')) resolve(); }); child.on('close', () => { if (!output.includes('HELD')) reject(new Error(error)); }); });
  return { child, closed, held };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-isolation-'));
  temporary.push(root);
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  git(source, 'init', '-q'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(source, 'README.md'), '# public\n'); git(source, 'add', '.'); git(source, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const tree = git(source, 'rev-parse', 'HEAD^{tree}'); const sourceCommit = git(source, 'rev-parse', 'HEAD');
  const artifacts = path.join(root, 'artifact'); fs.mkdirSync(artifacts, { mode: 0o700 });
  const pack = execFileSync('git', ['pack-objects', '--stdout', '--no-reuse-delta'], { cwd: source, input: git(source, 'rev-list', '--objects', tree).split('\n').map((line) => line.split(' ')[0]).join('\n') + '\n' });
  const policy = { version: 1, include: ['README.md'], exclude: [] };
  const sourceTag = Buffer.from(`object ${sourceCommit}\ntype commit\ntag v1.2.3\ntagger Fixture <fixture@example.invalid> 1700000000 +0000\n\nv1.2.3\n\nsource: gitea/${sourceCommit}\nsource-tree: ${tree}\n`);
  const proof = jsonBytes({ schema: 'punchpilot-source-ci-proof', sourceCommit, sourceTagObject: gitObjectId('tag', sourceTag), sourceRef: 'refs/tags/v1.2.3' });
  const policyBytes = jsonBytes(policy);
  const provenance = { schema: 'public-export-provenance/v1', generator: 'scripts/ci/export-public-tree.mjs', sourceCommit, sourceTree: tree, exportedTree: tree, policyVersion: 1, policyHash: computePolicyHash(policy), pathsetSha256: digest('README.md\n'), pathset: ['README.md'], excludedPaths: [], intendedPublicBase: sourceCommit };
  const manifest = { schema: 'punchpilot-publication-artifact', sourceCommit, exportedTree: tree, publicBase: sourceCommit, version: 'v1.2.3', sourceEpoch: 1700000000, policyHash: provenance.policyHash, provenance, packSha256: digest(pack), sourceTagSha256: digest(sourceTag), sourceTagObject: gitObjectId('tag', sourceTag), sourceProofSha256: digest(proof), policySha256: digest(policyBytes) };
  for (const [name, bytes] of Object.entries({ 'export.pack': pack, 'source-tag.raw': sourceTag, 'source-ci-proof.json': proof, 'allowlist.json': policyBytes, 'manifest.json': jsonBytes(manifest) })) fs.writeFileSync(path.join(artifacts, name), bytes, { mode: 0o600 });
  const snapshot = { artifactSha256: digest(jsonBytes(manifest)), policyHash: manifest.policyHash };
  return { root, source, artifacts, manifest, snapshot };
}
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('isolated publication artifact and durable lock', () => {
  it.each(['id', 'run_number', 'run_attempt'])('rejects missing/noninteger public CI ordering field %s before choosing an old successful run', async (field) => {
    const head = 'a'.repeat(40), good = { id: 1, run_number: 1, run_attempt: 1, head_sha: head, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
    for (const value of [undefined, null, '2', true, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      const bad = { ...good, id: 2, run_number: 2, status: 'in_progress', conclusion: null, [field]: value };
      await expect(publicCIGate(async () => ({ status: 200, body: { workflow_runs: [good, bad] } }), head)).rejects.toThrow('ordering identity');
    }
  });
  it('blocks a newer pending or failed exact-P public CI attempt', async () => {
    const head = 'a'.repeat(40), good = { id: 1, run_number: 1, run_attempt: 1, head_sha: head, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
    for (const status of ['in_progress', 'completed']) {
      const bad = { ...good, id: 2, run_number: 2, status, conclusion: 'failure' };
      await expect(publicCIGate(async () => ({ status: 200, body: { workflow_runs: [good, bad] } }), head)).rejects.toThrow('forward fix');
    }
  });
  it('returns only the public CI run/attempt fields needed by persisted observations', async () => {
    const head = 'a'.repeat(40);
    const run = { id: 17, run_number: 4, run_attempt: 2, head_sha: head, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
    const selected = await publicCIGate(async () => ({ status: 200, body: { workflow_runs: [{ ...run, token: responseCanary, actor: { login: 'irrelevant' } }] } }), head);
    expect(selected).toEqual(run);
    expect(JSON.stringify(selected)).not.toContain(responseCanary);
  });
  it('returns only endpoint/digest observations after every live platform record matches admission', async () => {
    const f = fixture(); const { admission } = reviewedAdmission(f.manifest);
    const platform = admission.receipts.platform;
    const records = [
      ...platform.rulesets.map((record) => [`/repos/sky-zhang01/punchpilot/rulesets/${record.id}`, record]),
      ['/repos/sky-zhang01/punchpilot/environments/public-release', platform.environment],
      ['/repos/sky-zhang01/punchpilot/environments/public-release/deployment-branch-policies', platform.branchPolicies],
    ];
    const observed = await verifyLivePlatform(async ({ endpoint }) => ({ status: 200, body: new Map(records).get(endpoint) }), admission);
    expect(observed).toEqual(records.map(([endpoint, body]) => ({ endpoint, bodySha256: digest(jsonBytes(platformProtection(
      endpoint.includes('/rulesets/') ? 'ruleset' : endpoint.endsWith('/deployment-branch-policies') ? 'branchPolicies' : 'environment',
      endpoint.endsWith('/deployment-branch-policies') ? body.branch_policies : body,
    ))) })));
    for (const endpoint of records.map(([endpoint]) => endpoint)) {
      await expect(verifyLivePlatform(async (request) => ({ status: 200, body: request.endpoint === endpoint ? {} : new Map(records).get(request.endpoint) }), admission)).rejects.toThrow('platform protection changed');
    }
  });
  it('accepts the same protections despite response timestamps, links, key order, and unordered rule order', async () => {
    const f = fixture(), { admission } = reviewedAdmission(f.manifest);
    const platform = admission.receipts.platform;
    const records = new Map([
      ...platform.rulesets.map((record) => [`/repos/sky-zhang01/punchpilot/rulesets/${record.id}`, record]),
      ['/repos/sky-zhang01/punchpilot/environments/public-release', platform.environment],
      ['/repos/sky-zhang01/punchpilot/environments/public-release/deployment-branch-policies', platform.branchPolicies],
    ]);
    const expected = await verifyLivePlatform(async ({ endpoint }) => ({ status: 200, body: records.get(endpoint) }), admission);
    const actual = await verifyLivePlatform(async ({ endpoint }) => {
      const body = structuredClone(records.get(endpoint));
      Object.assign(body, { updated_at: '2026-10-08T00:00:00Z', html_url: 'https://example.invalid/', current_user_can_bypass: 'always', token: responseCanary });
      if (body.rules) body.rules.reverse();
      if (body.protection_rules) body.protection_rules[0].reviewers[0].reviewer.avatar_url = 'https://example.invalid/';
      return { status: 200, body: Object.fromEntries(Object.entries(body).reverse()) };
    }, admission);
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).not.toContain(responseCanary);
  });
  it.each([
    ['hidden bypass', (p) => { delete p.rulesets[0].bypass_actors; }],
    ['extra actor', (p) => { p.rulesets[0].bypass_actors.push({ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }); }],
    ['wrong App', (p) => { p.rulesets[0].bypass_actors[0].actor_id += 1; }],
    ['changed scope', (p) => { p.rulesets[0].conditions.ref_name.include = ['refs/heads/*']; }],
    ['changed enforcement', (p) => { p.rulesets[0].enforcement = 'disabled'; }],
    ['changed rule parameters', (p) => { p.rulesets[0].rules[0].parameters = { update_allows_fetch_and_merge: true }; }],
    ['changed reviewer', (p) => { p.environment.protection_rules[0].reviewers[0].reviewer.id += 1; }],
    ['self review', (p) => { p.environment.protection_rules[0].prevent_self_review = false; }],
    ['admin bypass', (p) => { p.environment.can_admins_bypass = true; }],
    ['hidden admin bypass', (p) => { delete p.environment.can_admins_bypass; }],
    ['changed tag policy', (p) => { p.branchPolicies.branch_policies[0].name = '*'; }],
    ['unknown extra policy page', (p) => { p.branchPolicies.total_count = 2; }],
  ])('rejects %s instead of authorizing from an incomplete projection', async (_name, alter) => {
    const f = fixture(), { admission } = reviewedAdmission(f.manifest);
    const actual = structuredClone(admission.receipts.platform); alter(actual);
    const records = new Map([
      ...actual.rulesets.map((record) => [`/repos/sky-zhang01/punchpilot/rulesets/${record.id}`, record]),
      ['/repos/sky-zhang01/punchpilot/environments/public-release', actual.environment],
      ['/repos/sky-zhang01/punchpilot/environments/public-release/deployment-branch-policies', actual.branchPolicies],
    ]);
    await expect(verifyLivePlatform(async ({ endpoint }) => ({ status: 200, body: records.get(endpoint) }), admission)).rejects.toThrow(/platform protection/);
  });
  it('requires a distinct read channel and never falls back to a write token or anonymous GET', async () => {
    let requests = 0;
    const request = () => { requests += 1; throw new Error('network must remain unopened'); };
    for (const options of [{ readToken: undefined }, { readToken: '' }, { readToken: 'bad\nvalue' }, { token: 'fixture-writer', readToken: '' }]) {
      await expect(githubRequest({ endpoint: '/repos/sky-zhang01/punchpilot/rulesets/1', request, ...options })).rejects.toThrow(/read|observer/);
    }
    expect(requests).toBe(0);
  });
  it('uses only the observer for GET and only an explicit writer for the sole Release POST', async () => {
    const requests = [];
    const request = (options, callback) => {
      requests.push(options); const outgoing = new EventEmitter(); outgoing.setTimeout = () => {}; outgoing.destroy = (error) => outgoing.emit('error', error);
      outgoing.end = () => queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; callback(response); response.emit('data', Buffer.from('{}')); response.emit('end'); });
      return outgoing;
    };
    await githubRequest({ endpoint: '/repos/sky-zhang01/punchpilot/rulesets/1', readToken: 'fixture-reader', request });
    await githubRequest({ method: 'POST', endpoint: '/repos/sky-zhang01/punchpilot/releases', readToken: 'fixture-reader', token: 'fixture-writer', body: {}, request });
    expect(requests.map((options) => options.headers.Authorization)).toEqual(['Bearer fixture-reader', 'Bearer fixture-writer']);
    for (const options of [{ method: 'POST', endpoint: '/repos/sky-zhang01/punchpilot/releases' }, { method: 'DELETE', endpoint: '/repos/sky-zhang01/punchpilot/releases/1' }, { method: 'POST', endpoint: '/repos/sky-zhang01/punchpilot/issues', token: 'fixture-writer' }]) {
      await expect(githubRequest({ readToken: 'fixture-reader', request, ...options })).rejects.toThrow(/write|Release/);
    }
    expect(requests).toHaveLength(2);
  });
  it('imports only the exact E tree/blob closure into a fresh store', () => {
    const f = fixture(); const store = path.join(f.root, 'consumer');
    const result = validateArtifact({ artifactDir: f.artifacts, snapshot: f.snapshot, repoRoot: store });
    expect(result.manifest.exportedTree).toBe(f.manifest.exportedTree);
    expect(git(store, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)').split('\n').sort()).toEqual(['blob', 'tree']);
    expect(() => git(store, 'cat-file', '-t', f.manifest.sourceCommit)).toThrow();
    expect(git(store, 'remote')).toBe(''); expect(git(store, 'for-each-ref')).toBe('');
  });
  it('rejects an additional object even when its new pack digest is self-reported', () => {
    const f = fixture();
    const raw = execFileSync('git', ['pack-objects', '--stdout', '--no-reuse-delta'], { cwd: f.source, input: `${f.manifest.sourceCommit}\n${f.manifest.exportedTree}\n${git(f.source, 'rev-parse', 'HEAD:README.md')}\n` });
    f.manifest.packSha256 = digest(raw); fs.writeFileSync(path.join(f.artifacts, 'export.pack'), raw);
    fs.writeFileSync(path.join(f.artifacts, 'manifest.json'), jsonBytes(f.manifest));
    f.snapshot.artifactSha256 = digest(jsonBytes(f.manifest));
    expect(() => validateArtifact({ artifactDir: f.artifacts, snapshot: f.snapshot, repoRoot: path.join(f.root, 'consumer') })).toThrow(/closure|extra/);
  });
  it('rejects a tampered manifest against the independently pinned digest', () => {
    const f = fixture(); fs.appendFileSync(path.join(f.artifacts, 'manifest.json'), ' ');
    expect(() => validateArtifact({ artifactDir: f.artifacts, snapshot: f.snapshot, repoRoot: path.join(f.root, 'consumer') })).toThrow(/digest/);
  });
  it('rejects unlisted artifact files and does not import them', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.artifacts, 'extra-tag.raw'), canonicalObjects(f.manifest).tag, { mode: 0o600 });
    expect(() => validateArtifact({ artifactDir: f.artifacts, snapshot: f.snapshot, repoRoot: path.join(f.root, 'consumer') })).toThrow(/files/);
  });
  it('keeps the across-process lock owned through failure and releases its exact owner', async () => {
    const f = fixture(); const state = path.join(f.root, 'state'); fs.mkdirSync(state, { mode: 0o700 });
    await expect(withPublicationLock(state, async () => { throw new Error('fixture failure'); })).rejects.toThrow('fixture failure');
    expect(fs.readdirSync(state)).toEqual(['.publication.lock']);
  });
  it('KI3 serializes two actual OS processes without an interleaved publication operation', async () => {
    const f = fixture(), state = path.join(f.root, 'concurrent'); fs.mkdirSync(state, { mode: 0o700 });
    const a = lockWorker(state, 'A', 150), b = lockWorker(state, 'B', 150);
    const results = await Promise.all([a.closed, b.closed]);
    expect(results.every((result) => result.status === 0), JSON.stringify(results)).toBe(true);
    const events = fs.readFileSync(path.join(state, 'events'), 'utf8');
    expect(['A start\nA end\nB start\nB end\n', 'B start\nB end\nA start\nA end\n']).toContain(events);
  });
  it('recovers an actual killed owner through kernel lock release without stealing a live successor', async () => {
    const f = fixture(), state = path.join(f.root, 'crash'); fs.mkdirSync(state, { mode: 0o700 });
    const abandoned = lockWorker(state, 'abandoned', 30000); await abandoned.held;
    const waiting = lockWorker(state, 'successor', 100);
    abandoned.child.kill('SIGKILL'); await abandoned.closed;
    const result = await waiting.closed; expect(result.status, result.error).toBe(0);
    expect(fs.readFileSync(path.join(state, 'events'), 'utf8')).toBe('abandoned start\nsuccessor start\nsuccessor end\n');
    expect(fs.existsSync(path.join(state, '.publication-lock-owner.json'))).toBe(false);
  });
  it('rejects a symlink lock inode before entering the protected operation', async () => {
    const f = fixture(), state = path.join(f.root, 'symlink'); fs.mkdirSync(state, { mode: 0o700 });
    const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'unchanged', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(state, '.publication.lock'));
    let entered = false;
    await expect(withPublicationLock(state, () => { entered = true; })).rejects.toThrow(/lock/);
    expect(entered).toBe(false); expect(fs.readFileSync(outside, 'utf8')).toBe('unchanged');
  });
  it('keeps the Node-owned flock after the actual helper is killed until its live operation ends', async () => {
    const f = fixture(), state = path.join(f.root, 'helper-crash'); fs.mkdirSync(state, { mode: 0o700 });
    const owner = lockWorker(state, 'owner', 400); await owner.held;
    const helperPid = JSON.parse(fs.readFileSync(path.join(state, '.publication-lock-owner.json'))).lockHelperPid;
    const waiting = lockWorker(state, 'successor', 100);
    process.kill(helperPid, 'SIGKILL');
    const [first, second] = await Promise.all([owner.closed, waiting.closed]);
    expect(first.status).not.toBe(0); expect(first.error).toContain('lock release failed'); expect(second.status, second.error).toBe(0);
    expect(fs.readFileSync(path.join(state, 'events'), 'utf8')).toBe('owner start\nowner end\nsuccessor start\nsuccessor end\n');
  });
  it('rejects an actual replaced path inode after opening its stable descriptor', async () => {
    const f = fixture(), state = path.join(f.root, 'inode-race'); fs.mkdirSync(state, { mode: 0o700 });
    const program = `import fs from 'node:fs'; import path from 'node:path'; import { withPublicationLock } from ${JSON.stringify(publisherUrl)};
      const open=fs.openSync;let changed=false;fs.openSync=(file,...args)=>{const fd=open(file,...args);if(!changed&&String(file).endsWith('.publication.lock')){changed=true;fs.renameSync(file,file+'.replaced');fs.writeFileSync(file,'',{mode:0o600});}return fd;};
      await withPublicationLock(process.argv[1],()=>fs.writeFileSync(path.join(process.argv[1],'entered'),'unsafe'));`;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, state], { stdio: ['ignore', 'pipe', 'pipe'] });
      let error = ''; child.stderr.on('data', (data) => { error += data; }); child.on('close', (status) => resolve({ status, error }));
    });
    expect(result.status).not.toBe(0); expect(result.error).toContain('lock inode changed'); expect(fs.existsSync(path.join(state, 'entered'))).toBe(false);
  });
});
