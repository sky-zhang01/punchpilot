import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalObjects, digest, jsonBytes, BOT_NAME, ENVELOPE_LIMIT, withPublicGpgContext } from '../scripts/ci/publication-contract.mjs';
import { exportPublicTree } from '../scripts/ci/export-public-tree.mjs';
import { assertPushUpdates, githubRequest, preparePublication, publishPrepared, publicWriteAuthority, remoteReadback, restorePublication, validateConsumerPublication } from '../scripts/ci/isolated-publisher.mjs';
import { reviewedAdmission } from './helpers/publication-fixtures.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gateSource = path.join(projectRoot, 'scripts', 'ci', 'source-ci-gate.py');
const workflowDirectories = ['.gitea/workflows', '.github/workflows'];
let commit;
const tagObject = 'b'.repeat(40);
const mainContexts = [
  'CI / Lint (push)',
  'CI / Test (push)',
  'CI / Dependency Audit (push)',
  'CI / Client Build (push)',
  'CI / E2E Smoke (push)',
  'CI / Docker Build Check (amd64) (push)',
  'CI / Security Scan (push)',
];
const mainJobNames = [
  'Lint',
  'Test',
  'Dependency Audit',
  'Client Build',
  'E2E Smoke',
  'Docker Build Check (amd64)',
  'Security Scan',
];
const releaseContext = 'Internal Release Check / Internal Release Check (push)';
const tempRoots = [];
const openServers = [];
const fixtureGpgHomes = [];
const initialPath = process.env.PATH;
const responseCanary = 'synthetic-api-response-secret';
let certificateRoot;
let certificate;
let privateKey;

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function json(response, payload, status = 200, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function statusEntry(context, runId, jobId, status = 'success', creator = {}) {
  return {
    context,
    status,
    creator,
    target_url: `https://source.example.invalid/example/punchpilot/actions/runs/${runId}/jobs/${jobId}`,
  };
}

function statusPayload({
  includeRelease = false,
  mixedRun = false,
  failure = false,
  forgedJob = false,
} = {}) {
  const statuses = mainContexts.map((context, index) => statusEntry(
    context,
    mixedRun && index === mainContexts.length - 1 ? 78 : 77,
    forgedJob && index === 0 ? 9999 : 770 + index,
    failure && index === 1 ? 'failure' : 'success',
  ));
  if (includeRelease) {
    statuses.push(statusEntry(releaseContext, 88, 880));
    statuses.push(statusEntry(
      'Publish Docker Image / skipped public job (push)',
      89,
      890,
      'skipped',
    ));
  }
  return {
    sha: commit,
    state: failure ? 'failure' : 'success',
    total_count: statuses.length,
    statuses,
  };
}

function workflowRun(id, workflowPath, {
  event = 'push',
  status = 'completed',
  conclusion = 'success',
} = {}) {
  return {
    id,
    path: workflowPath,
    head_sha: commit,
    event,
    status,
    conclusion,
    run_number: id,
    run_attempt: 1,
  };
}

function workflowJob(id, runId, name, {
  headSha = commit,
  runAttempt = 1,
  status = 'completed',
  conclusion = 'success',
} = {}) {
  return {
    id,
    run_id: runId,
    run_attempt: runAttempt,
    name,
    head_sha: headSha,
    status,
    conclusion,
  };
}

function releaseAttestation(runId, object = tagObject) {
  return `PUNCHPILOT_RELEASE_ATTESTATION_V1 run_id=${runId} ref=refs/tags/v0.5.0 tag_object=${object} tag_commit=${commit}`;
}

function pageItems(items, url) {
  const page = Number(url.searchParams.get('page') || 1);
  const limit = Number(url.searchParams.get('limit') || 50);
  return items.slice((page - 1) * limit, page * limit);
}

function createRepository(apiBaseUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-ci-repo-'));
  tempRoots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Synthetic Fixture');
  git(root, 'config', 'user.email', 'synthetic-fixture@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'punchpilot.sourceRemote', 'source');
  const apiUrl = new URL(apiBaseUrl);
  git(root, 'remote', 'add', 'source', `${apiUrl.origin}/example/punchpilot.git`);
  for (const directory of workflowDirectories) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(
      path.join(root, directory, 'ci.yml'),
      `name: CI\non: push\n# ${directory}\n`,
    );
  }
  fs.writeFileSync(path.join(root, 'README.md'), '# synthetic source gate fixture\n');
  git(root, 'add', '.gitea', '.github', 'README.md');
  git(root, 'commit', '-q', '-m', 'synthetic source gate fixture');
  commit = git(root, 'rev-parse', 'HEAD');
  return root;
}

function workflowTrees(root, ref = commit) {
  return Object.fromEntries(workflowDirectories.map((directory) => [
    directory,
    git(root, 'rev-parse', `${ref}:${directory}`),
  ]));
}

function createTrustedGate(root, apiBaseUrl, overrides = {}) {
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-ci-trusted-'));
  tempRoots.push(trusted);
  const gate = path.join(trusted, 'source-ci-gate.py');
  const token = path.join(trusted, 'source-token');
  const accessHeader = path.join(trusted, 'source-access-header');
  fs.copyFileSync(gateSource, gate);
  fs.chmodSync(gate, 0o700);
  fs.writeFileSync(token, 'synthetic-token\n', { mode: 0o600 });
  fs.writeFileSync(accessHeader, 'synthetic-access\n', { mode: 0o600 });
  const trustedWorkflowTrees = workflowTrees(root);
  fs.writeFileSync(
    path.join(trusted, 'source-ci-gate.json'),
    `${JSON.stringify({
      version: 2,
      apiBaseUrl,
      repository: { owner: 'example', name: 'punchpilot' },
      credentialFile: token,
      expectedActor: 'reviewer',
      caFile: certificate,
      extraHeaderFiles: { 'X-Access-Client': accessHeader },
      promotionCommit: commit,
      trustedWorkflowTrees,
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
  return { gate, token };
}

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { key: fs.readFileSync(privateKey), cert: fs.readFileSync(certificate) },
      handler,
    );
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      openServers.push(server);
      resolve({ server, baseUrl: `https://localhost:${server.address().port}/api/v1` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runGate(root, gate, args) {
  return new Promise((resolve) => {
    const child = spawn(gate, args, {
      cwd: root,
      env: {
        HOME: process.env.HOME,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function authorityHandler({
  includeRelease = false,
  mixedRun = false,
  failure = false,
  forgedJob = false,
  wrongJobName = false,
  wrongJobHead = false,
  wrongJobAttempt = false,
  failedJob = false,
  extraJobs = 0,
  duplicateJobId = false,
  remoteTagObject = tagObject,
  newerMainFailure = false,
  dispatchSuccess = false,
  wrongMainRef = false,
  wrongReleaseRef = false,
  extraStatuses = 0,
  driftOnFinalReadback = false,
  attestedTagObject = tagObject,
  runOverrides = {},
  auxiliaryConclusion = 'success',
} = {}) {
  let runListReads = 0;
  return (request, response) => {
    const mainPath = wrongMainRef ? 'ci.yml@refs/heads/other' : 'ci.yml@refs/heads/main';
    const mainRun = workflowRun(77, mainPath, failure ? {
      conclusion: 'failure',
    } : {});
    Object.assign(mainRun, runOverrides);
    const releasePath = wrongReleaseRef
      ? 'internal-release-check.yml@refs/tags/v0.4.14'
      : 'internal-release-check.yml@refs/tags/v0.5.0';
    const releaseRun = workflowRun(88, releasePath);
    const mainJobs = mainJobNames.map((name, index) => workflowJob(
      770 + index,
      mainRun.id,
      wrongJobName && index === 0 ? 'Different Job' : name,
      {
        headSha: wrongJobHead && index === 0 ? 'c'.repeat(commit.length) : commit,
        runAttempt: wrongJobAttempt && index === 0 ? 2 : 1,
        conclusion: failedJob && index === 0 ? 'failure' : 'success',
      },
    ));
    for (let index = 0; index < extraJobs; index += 1) {
      mainJobs.push(workflowJob(2000 + index, mainRun.id, `Auxiliary ${index}`, { conclusion: auxiliaryConclusion }));
    }
    if (duplicateJobId) {
      mainJobs.push(workflowJob(mainJobs[0].id, mainRun.id, 'Duplicate'));
    }
    const releaseJob = workflowJob(880, releaseRun.id, 'Internal Release Check');
    if (
      request.headers.authorization !== 'token synthetic-token'
      || request.headers['x-access-client'] !== 'synthetic-access'
    ) {
      json(response, {}, 401);
      return;
    }
    const url = new URL(request.url, 'https://localhost');
    const prefix = '/api/v1/repos/example/punchpilot';
    if (url.pathname === '/api/v1/user') {
      json(response, { login: 'reviewer', active: true });
    } else if (url.pathname === `${prefix}/git/refs/heads/main`) {
      json(response, [{
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: commit },
      }]);
    } else if (url.pathname === `${prefix}/commits/${commit}/status`) {
      const complete = statusPayload({ includeRelease, mixedRun, failure, forgedJob });
      for (let index = 0; index < extraStatuses; index += 1) {
        complete.statuses.push(statusEntry(
          `Auxiliary / ${index} (push)`,
          77,
          1000 + index,
        ));
      }
      const statuses = pageItems(complete.statuses, url);
      json(response, {
        ...complete,
        total_count: statuses.length,
        statuses,
      }, 200, { 'x-total-count': String(complete.statuses.length) });
    } else if (url.pathname === `${prefix}/actions/runs`) {
      runListReads += 1;
      const runs = includeRelease ? [releaseRun, mainRun] : [mainRun];
      if (newerMainFailure || (driftOnFinalReadback && runListReads > 1)) {
        runs.push(workflowRun(99, 'ci.yml@refs/heads/main', { conclusion: 'failure' }));
      }
      if (dispatchSuccess) {
        runs.push(workflowRun(100, 'ci.yml@refs/heads/main', { event: 'workflow_dispatch' }));
      }
      json(response, { total_count: runs.length, workflow_runs: pageItems(runs, url) });
    } else if (url.pathname === `${prefix}/actions/runs/${mainRun.id}/jobs`) {
      json(response, { total_count: mainJobs.length, jobs: pageItems(mainJobs, url) });
    } else if (url.pathname === `${prefix}/actions/runs/${releaseRun.id}/jobs`) {
      const jobs = [releaseJob];
      json(response, { total_count: jobs.length, jobs: pageItems(jobs, url) });
    } else if (url.pathname === `${prefix}/actions/jobs/${releaseJob.id}/logs`) {
      const body = `synthetic workflow log\n${releaseAttestation(releaseRun.id, attestedTagObject)}\n`;
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    } else if (url.pathname.startsWith(`${prefix}/actions/runs/`)) {
      const id = Number(url.pathname.split('/').at(-1));
      const details = new Map([
        [77, mainRun],
        [88, releaseRun],
        [99, workflowRun(99, 'ci.yml@refs/heads/main', { conclusion: 'failure' })],
        [100, workflowRun(100, 'ci.yml@refs/heads/main', { event: 'workflow_dispatch' })],
      ]);
      json(response, details.get(id) || {}, details.has(id) ? 200 : 404);
    } else if (url.pathname === `${prefix}/git/refs/tags/v0.5.0`) {
      json(response, [{
        ref: 'refs/tags/v0.5.0',
        object: { type: 'tag', sha: remoteTagObject },
      }]);
    } else if (url.pathname === `${prefix}/git/tags/${remoteTagObject}`) {
      json(response, {
        sha: remoteTagObject,
        tag: 'v0.5.0',
        object: { type: 'commit', sha: commit },
      });
    } else {
      json(response, {}, 404);
    }
  };
}

async function createPublicationFixture(ancestry = 'clean') {
  // This Vitest process is a disposable consumer fixture. Drop inherited
  // launcher identity/configuration names without reading their values.
  for (const name of Object.keys(process.env)) if (/^(?:GITEA_|PUNCHPILOT_SOURCE_|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_OBJECT_DIRECTORY$)/.test(name)) delete process.env[name];
  const { server, baseUrl } = await startServer((request, response) => authority(request, response));
  let authority = authorityHandler({ includeRelease: true });
  const source = createRepository(baseUrl);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-publication-flow-')); tempRoots.push(scratch); fs.chmodSync(scratch, 0o700);
  const pythonBin = path.join(scratch, 'runtime-bin'); fs.mkdirSync(pythonBin, { mode: 0o700 });
  const pythonTrace = path.join(scratch, 'python-argv.jsonl');
  const actualPython = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  fs.symlinkSync(process.execPath, path.join(pythonBin, 'node'));
  const signingTrace = path.join(scratch, 'signing-context.jsonl');
  fs.writeFileSync(path.join(pythonBin, 'python3'), `#!/usr/bin/env node\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(pythonTrace)},JSON.stringify(args)+'\\n',{mode:0o600});if(args[0]?.endsWith('public-release-privacy-gate.py')&&(args.includes('--tag-envelope-file')||args.includes('--commit-range'))){const home=process.env.GNUPGHOME;const keys=home?spawnSync('gpg',['--no-options','--homedir',home,'--batch','--with-colons','--list-secret-keys'],{encoding:'utf8'}):null;fs.appendFileSync(${JSON.stringify(signingTrace)},JSON.stringify({home,exists:!!home&&fs.existsSync(home),secretKeys:keys?keys.stdout:'MISSING',exit:keys?.status})+'\\n',{mode:0o600});}const stdio=args[0]==='-c'&&args[1].includes('fd=3')?['inherit','inherit','inherit',3]:'inherit';const result=spawnSync(${JSON.stringify(actualPython)},args,{stdio});process.exit(result.status ?? 1);\n`, { mode: 0o700 });
  process.env.PATH = `${pythonBin}${path.delimiter}${initialPath}`;
  const publicSource = path.join(scratch, 'public-source'); fs.mkdirSync(publicSource);
  git(publicSource, 'init', '-q'); git(publicSource, 'config', 'user.name', 'Public Fixture'); git(publicSource, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(publicSource, 'README.md'), '# clean public base\n');
  git(publicSource, 'add', '.'); git(publicSource, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'public base');
  if (!['clean', 'signed history'].includes(ancestry)) {
    const mainBranch = git(publicSource, 'symbolic-ref', '--short', 'HEAD');
    if (ancestry === 'merge ancestor') git(publicSource, 'checkout', '-qb', 'public-side');
    const canary = path.join(publicSource, 'removed.txt');
    if (['deleted secret', 'merge ancestor'].includes(ancestry)) fs.writeFileSync(canary, `${'password'}=${'publication-history-canary'}\n`);
    if (ancestry === 'deleted host') fs.writeFileSync(canary, 'https://private.example.invalid/\n');
    git(publicSource, 'add', '.');
    const author = `Public Fixture${ancestry === 'identity warning' ? ` issue ${'#'}${'123'}` : ''} <fixture@example.invalid>`;
    git(publicSource, '-c', 'commit.gpgsign=false', 'commit', '--author', author, '--allow-empty', '-qm', 'public ancestor');
    if (fs.existsSync(canary)) fs.rmSync(canary);
    git(publicSource, 'add', '-A'); git(publicSource, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'clean public tip');
    if (ancestry === 'merge ancestor') {
      git(publicSource, 'checkout', '-q', mainBranch);
      git(publicSource, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-qm', 'clean merge tip', 'public-side');
    }
  }
  let publicBase = git(publicSource, 'rev-parse', 'HEAD');
  const remote = path.join(scratch, 'public.git'); git(scratch, 'init', '--bare', '-q', remote);
  git(publicSource, 'push', '-q', remote, `${publicBase}:refs/heads/main`);
  const version = '0.5.0';
  for (const file of ['package.json', 'client/package.json']) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.writeFileSync(path.join(source, file), JSON.stringify({ name: 'fixture', version }));
  }
  for (const file of ['package-lock.json', 'client/package-lock.json']) fs.writeFileSync(path.join(source, file), JSON.stringify({ version, packages: { '': { version } } }));
  fs.writeFileSync(path.join(source, 'Dockerfile'), `FROM scratch\nLABEL org.opencontainers.image.version="${version}"\n`);
  fs.writeFileSync(path.join(source, 'CHANGELOG.md'), `## [${version}]\n\n### Changed\n- Public fixture release.\n`);
  fs.writeFileSync(path.join(source, 'internal.txt'), 'private source content excluded from E\n');
  fs.writeFileSync(path.join(source, 'app.mjs'), 'throw new Error("E application scripts must never execute in the consumer");\n');
  const reviewedFiles = ['publication-contract.mjs', 'isolated-publisher.mjs', 'export-public-tree.mjs', 'publication-preflight.mjs', 'public-release-privacy-gate.py', 'release-metadata-check.mjs', 'mint-app-token.mjs'];
  fs.mkdirSync(path.join(source, 'scripts/ci'), { recursive: true }); fs.mkdirSync(path.join(source, '.githooks'));
  for (const file of reviewedFiles) fs.copyFileSync(path.join(projectRoot, 'scripts/ci', file), path.join(source, 'scripts/ci', file));
  fs.copyFileSync(path.join(projectRoot, '.githooks/pre-push'), path.join(source, '.githooks/pre-push'));
  fs.copyFileSync(path.join(projectRoot, 'scripts/install-publication-hook.mjs'), path.join(source, 'scripts/install-publication-hook.mjs'));
  // Keep GnuPG's Unix socket path short on both macOS and Linux.
  const gpgHome = fs.mkdtempSync('/tmp/pp-gpg-'); fixtureGpgHomes.push(gpgHome); fs.chmodSync(gpgHome, 0o700);
  execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Publication Fixture <fixture@example.invalid>', 'ed25519', 'sign', '1d'], { stdio: 'ignore' });
  const gpgOptions = execFileSync('gpg', ['--dump-options'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(gpgHome, 'gpg.conf'), `disable-signer-uid\n${gpgOptions.includes('--compatibility-flags') ? 'compatibility-flags no-manu\n' : ''}`);
  const fingerprint = execFileSync('gpg', ['--homedir', gpgHome, '--with-colons', '--list-keys'], { encoding: 'utf8' }).split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
  let historyFingerprint;
  if (ancestry === 'signed history') {
    execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'History Fixture <history@example.invalid>', 'ed25519', 'sign', '1d'], { stdio: 'ignore' });
    historyFingerprint = execFileSync('gpg', ['--homedir', gpgHome, '--with-colons', '--list-keys', 'history@example.invalid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
    fs.mkdirSync(path.join(source, '.public-export'));
    fs.writeFileSync(path.join(source, '.public-export/public-signing-keys.asc'), execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--armor', '--export', historyFingerprint], { stdio: ['ignore', 'pipe', 'pipe'] }));
    execFileSync('git', ['-c', 'gpg.format=openpgp', '-c', 'gpg.program=gpg', '-c', `user.signingkey=${historyFingerprint}`, 'commit', '-S', '--allow-empty', '-qm', 'signed public base'], { cwd: publicSource, env: { ...process.env, GNUPGHOME: gpgHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    publicBase = git(publicSource, 'rev-parse', 'HEAD');
    git(publicSource, 'push', '-q', remote, `${publicBase}:refs/heads/main`);
  }
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'release fixture source'); commit = git(source, 'rev-parse', 'HEAD');
  const policy = { version: 1, include: ['README.md', '.github/', 'package.json', 'package-lock.json', 'client/', 'Dockerfile', 'CHANGELOG.md', 'app.mjs'], exclude: ['.gitea/', '.githooks/', '.public-export/', 'scripts/', 'internal.txt'] };
  const exported = exportPublicTree({ repoRoot: source, source: commit, publicBase, policy, scan: false });
  const message = `v${version}\n\nsource: gitea/${commit}\nsource-tree: ${exported.treeSha}\n`;
  execFileSync('git', ['-c', 'gpg.format=openpgp', '-c', 'gpg.program=gpg', '-c', `user.signingkey=${fingerprint}`, 'tag', '-s', `v${version}`, commit, '-m', message], { cwd: source, env: { ...process.env, GNUPGHOME: gpgHome }, stdio: 'ignore' });
  const signedTag = git(source, 'rev-parse', `refs/tags/v${version}`);
  authority = authorityHandler({ includeRelease: true, remoteTagObject: signedTag, attestedTagObject: signedTag });
  const { gate } = createTrustedGate(source, baseUrl);
  const externalPolicy = path.join(scratch, 'source-policy.json');
  fs.writeFileSync(externalPolicy, jsonBytes({ source: commit, sourceTag: signedTag, publicBase, policy, sourceGate: gate, fingerprint, gpgHome, publicUrl: remote, forbiddenHosts: 'private.example.invalid' }), { mode: 0o600 });
  const artifact = path.join(scratch, 'artifact'); const snapshot = path.join(scratch, 'consumer-policy');
  async function invoke(command, extra) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(projectRoot, 'scripts/ci/isolated-publisher.mjs'), command, '--policy', externalPolicy, '--artifact', artifact, ...extra], { cwd: source,
        env: { HOME: process.env.HOME, PATH: process.env.PATH, PUBLIC_RELEASE_FORBIDDEN_HOSTS: 'private.example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('close', (status) => resolve({ status, output }));
    });
  }
  const initialPolicyBytes = fs.readFileSync(externalPolicy), initialPolicy = JSON.parse(initialPolicyBytes);
  for (const [override, message] of [
    [{ source: git(source, 'rev-parse', 'HEAD~1') }, 'exact clean reviewed'],
    [{ fingerprint: 'A'.repeat(40) }, 'pinned key'],
    [{ revokedKeys: [fingerprint] }, 'revoked'],
  ]) {
    fs.writeFileSync(externalPolicy, jsonBytes({ ...initialPolicy, ...override }));
    const denied = await invoke('produce', []); expect(denied.status, denied.output).toBe(1); expect(denied.output).toContain(message);
    expect(fs.existsSync(artifact)).toBe(false);
  }
  fs.writeFileSync(externalPolicy, initialPolicyBytes);
  const produced = await invoke('produce', []); expect(produced.status, produced.output).toBe(0);
  const manifest = JSON.parse(fs.readFileSync(path.join(artifact, 'manifest.json')));
  const { admission, publication } = reviewedAdmission({ ...manifest, artifactSha256: digest(fs.readFileSync(path.join(artifact, 'manifest.json'))) },
    { changedWorkflows: true, now: Math.floor(Date.now() / 1000), entrySha256: digest(fs.readFileSync(path.join(source, 'scripts/ci/isolated-publisher.mjs'))) });
  const originalAdmission = path.join(scratch, 'owner-admission.json'); fs.writeFileSync(originalAdmission, jsonBytes(admission), { mode: 0o600 });
  const sourcePolicy = JSON.parse(fs.readFileSync(externalPolicy));
  Object.assign(sourcePolicy, { admissionFile: originalAdmission, admissionSha256: publication.admissionSha256 });
  fs.writeFileSync(externalPolicy, jsonBytes(sourcePolicy));
  const installed = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(source, 'scripts/install-publication-hook.mjs'), '--mode', 'consumer', '--policy', externalPolicy, '--artifact', artifact, '--target', snapshot],
      { cwd: source, env: { HOME: process.env.HOME, PATH: process.env.PATH, PUBLIC_RELEASE_FORBIDDEN_HOSTS: 'private.example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; }); child.on('close', (status) => resolve({ status, output }));
  });
  expect(installed.status, installed.output).toBe(0);
  const consumerSnapshotFile = path.join(snapshot, 'consumer.json'), consumerSnapshotBytes = fs.readFileSync(consumerSnapshotFile);
  fs.writeFileSync(consumerSnapshotFile, jsonBytes({ ...JSON.parse(consumerSnapshotBytes), nodeVersion: 'v0.0.0' }));
  expect(() => preparePublication({ snapshotDir: snapshot, stateDir: path.join(scratch, 'wrong-runtime-state'), repoRoot: path.join(scratch, 'wrong-runtime-store') })).toThrow('Node runtime');
  fs.writeFileSync(consumerSnapshotFile, consumerSnapshotBytes);
  const stateDir = path.join(scratch, 'state'); fs.mkdirSync(stateDir, { mode: 0o700 });
  const initialConsumer = path.join(scratch, 'consumer-initial');
  const admissionFile = path.join(snapshot, 'admission.json');
  return { server, source, scratch, publicSource, publicBase, remote, version, signedTag, exported, manifest, admission, publication, snapshot, consumerSnapshotFile, consumerSnapshotBytes, stateDir, initialConsumer, pythonTrace, signingTrace, commit, admissionFile, gpgHome, fingerprint, historyFingerprint };
}

async function createPublicationApi({ admission, version }, prepared) {
  const controls = { release: null, releaseReads: 0, releaseWrites: 0, publicCIConclusion: 'success',
    writerActor: BOT_NAME, writerAttempt: 1, ownerApproved: true, loseReleaseResponse: false };
  const publicApi = await startServer((request, response) => {
    if (request.headers.authorization !== `Bearer fixture-${request.method === 'POST' ? 'writer' : 'reader'}`) {
      json(response, {}, 401); return;
    }
    const platform = admission.receipts.platform;
    const platformRecords = new Map([
      ...platform.rulesets.map((record) => [`/repos/sky-zhang01/punchpilot/rulesets/${record.id}`, record]),
      ['/repos/sky-zhang01/punchpilot/environments/public-release', platform.environment],
      ['/repos/sky-zhang01/punchpilot/environments/public-release/deployment-branch-policies', platform.branchPolicies],
    ]);
    if (platformRecords.has(request.url)) json(response, platformRecords.get(request.url));
    else if (request.url.startsWith('/repos/sky-zhang01/punchpilot/actions/workflows/ci.yml/runs')) json(response, { workflow_runs: [{ id: 1, run_number: 1, run_attempt: 1, head_sha: prepared.state.commitId, head_branch: 'main', event: 'push', status: 'completed', conclusion: controls.publicCIConclusion, token: responseCanary }] });
    else if (request.url.startsWith('/repos/sky-zhang01/punchpilot/actions/workflows/docker-publish.yml/runs')) json(response, { workflow_runs: [{ id: 2, run_attempt: controls.writerAttempt, head_sha: prepared.state.commitId, head_branch: `v${version}`, event: 'push', status: 'in_progress', actor: { login: controls.writerActor }, triggering_actor: { login: BOT_NAME } }] });
    else if (request.url === '/repos/sky-zhang01/punchpilot/actions/runs/2/approvals') json(response, controls.ownerApproved ? [{ state: 'approved', user: { login: 'sky-zhang01' }, environments: [{ name: 'public-release' }] }] : []);
    else if (request.url === '/repos/sky-zhang01/punchpilot/git/ref/heads/main') json(response, { object: { type: 'commit', sha: prepared.state.commitId } });
    else if (request.url === `/repos/sky-zhang01/punchpilot/git/ref/tags/v${version}`) json(response, { object: { type: 'tag', sha: prepared.state.tagId } });
    else if (request.method === 'POST') {
      let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => { controls.releaseWrites += 1; controls.release = { ...JSON.parse(body), id: 42, assets: [], token: responseCanary }; if (controls.loseReleaseResponse) response.destroy(); else json(response, { accepted: true }, 202); });
    } else { controls.releaseReads += 1; json(response, controls.release && controls.releaseReads > 2 ? controls.release : {}, controls.release && controls.releaseReads > 2 ? 200 : 404); }
  });
  const api = (options) => githubRequest({ ...options, readToken: 'fixture-reader', ...(options.method === 'POST' ? { token: 'fixture-writer' } : {}), request: (options, callback) => https.request({ ...options, hostname: 'localhost', port: publicApi.server.address().port, ca: fs.readFileSync(certificate) }, callback) });
  return { ...publicApi, api, controls };
}

function assertPublicationScannerPolicy({ pythonTrace, publicBase, signingTrace }) {
  const scannerCalls = fs.readFileSync(pythonTrace, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((args) => args[0].endsWith('public-release-privacy-gate.py'));
  for (const args of scannerCalls) {
    expect(args).toContain('--require-forbidden-hosts'); expect(args).toContain('--fail-on-warn');
    if (args.includes('--ref')) expect(args[args.indexOf('--commit-range') + 1]).toBe(publicBase);
  }
  for (const context of fs.readFileSync(signingTrace, 'utf8').trim().split('\n').map((line) => JSON.parse(line))) {
    expect(context.exists).toBe(true); expect(context.exit).toBe(0); expect(context.secretKeys).toBe('');
    expect(fs.existsSync(context.home)).toBe(false);
  }
  return scannerCalls;
}

beforeAll(() => {
  certificateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-ci-certificate-'));
  privateKey = path.join(certificateRoot, 'localhost-key.pem');
  certificate = path.join(certificateRoot, 'localhost-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', privateKey, '-out', certificate,
  ], { stdio: 'ignore' });
  fs.chmodSync(privateKey, 0o600);
  fs.chmodSync(certificate, 0o600);
});

afterEach(async () => {
  process.env.PATH = initialPath;
  for (const server of openServers.splice(0)) {
    if (server.listening) await closeServer(server);
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const home of fixtureGpgHomes.splice(0)) {
    try { execFileSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' }); } catch { /* only disposable fixture agents */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(certificateRoot, { recursive: true, force: true });
});

describe('external source CI authority gate', () => {
  it('installs exact source/history public keys and keeps them through the actual CLI, resume and hook gates', async () => {
    const fixture = await createPublicationFixture('signed history');
    const { scratch, snapshot, stateDir, initialConsumer, gpgHome, fingerprint, historyFingerprint, consumerSnapshotFile } = fixture;
    // This key was generated above solely inside the disposable fixture. Even
    // a private packet mislabeled as PUBLIC armor must not enter the operation.
    const mislabeledPrivate = execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--armor', '--export-secret-keys', fingerprint], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().replaceAll('PRIVATE KEY BLOCK', 'PUBLIC KEY BLOCK');
    let entered = false;
    expect(() => withPublicGpgContext(Buffer.from(mislabeledPrivate), () => { entered = true; })).toThrow('private keys');
    expect(entered).toBe(false);
    const keyFile = path.join(snapshot, 'source-signing-public-key.asc'), originalKeys = fs.readFileSync(keyFile);
    const fingerprints = withPublicGpgContext(originalKeys, (home) => execFileSync('gpg', ['--no-options', '--homedir', home, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter((line) => line.startsWith('fpr:')).map((line) => line.split(':')[9]));
    expect(fingerprints.sort()).toEqual([fingerprint, historyFingerprint].sort());
    preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer });
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(snapshot, 'isolated-publisher.mjs'), 'rehearse', '--snapshot', snapshot, '--state', stateDir], { cwd: scratch, env: { HOME: process.env.HOME, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; }); child.on('close', (status) => resolve({ status, output }));
    });
    expect(result.status, result.output).toBe(0);
    const sourceOnly = execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--armor', '--export', fingerprint], { stdio: ['ignore', 'pipe', 'pipe'] });
    const savedSnapshot = fs.readFileSync(consumerSnapshotFile);
    fs.writeFileSync(keyFile, sourceOnly);
    fs.writeFileSync(consumerSnapshotFile, jsonBytes({ ...JSON.parse(savedSnapshot), publicKeySha256: digest(sourceOnly) }));
    expect(() => preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'missing-history-key') })).toThrow('signature material');
    expect(() => git(initialConsumer, 'push', '--atomic', '--', fixture.remote, `refs/punchpilot/publications/${fixture.manifest.version}:refs/heads/main`, `refs/punchpilot/public-tags/${fixture.manifest.version}:refs/tags/${fixture.manifest.version}`)).toThrow('signature material');
    fs.writeFileSync(keyFile, originalKeys); fs.writeFileSync(consumerSnapshotFile, savedSnapshot);
    assertPublicationScannerPolicy(fixture);
    await closeServer(fixture.server);
  }, 120000);
  it.each(['deleted secret', 'deleted host', 'identity warning', 'merge ancestor'])('KC/KE/KI2 verifies public ancestry %s through the installed E-only consumer and saved bundle retry', async (ancestry) => {
    const fixture = await createPublicationFixture(ancestry);
    const { scratch, publicBase, remote, manifest, publication, snapshot, stateDir, initialConsumer, pythonTrace, server } = fixture;
    const expectedFinding = ['deleted secret', 'merge ancestor'].includes(ancestry) ? 'generic assigned secret'
      : ancestry === 'deleted host' ? 'forbidden internal hostname' : 'commit metadata: bare tracker number';
    expect(() => preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer })).toThrow(expectedFinding);
    expect(fs.existsSync(path.join(stateDir, 'state.json'))).toBe(false);
    // Reconstitute a quarantined persisted candidate from the actual objects
    // already written before the gate refused preparation. Resume and the
    // installed Git hook must inspect ancestors again, even with saved bytes.
    const objects = canonicalObjects(manifest);
    const publicationRef = `refs/punchpilot/publications/${manifest.version}`, tagRef = `refs/punchpilot/public-tags/${manifest.version}`;
    for (const [name, type, oid] of [['publication.commit', 'commit', objects.commitId], ['publication.tag', 'tag', objects.tagId]]) {
      fs.writeFileSync(path.join(stateDir, name), execFileSync('git', ['cat-file', type, oid], { cwd: initialConsumer }), { mode: 0o600 });
    }
    const bundleFile = path.join(stateDir, 'publication.bundle');
    git(initialConsumer, 'bundle', 'create', bundleFile, publicationRef, tagRef); fs.chmodSync(bundleFile, 0o600);
    const saved = { ...manifest, schema: 'punchpilot-publication-state', artifactSha256: publication.artifactSha256,
      commitId: objects.commitId, tagId: objects.tagId, publicationRef, tagRef, commitSha256: digest(objects.commit),
      tagSha256: digest(objects.tag), bundleSha256: digest(fs.readFileSync(bundleFile)), changedWorkflows: true,
      admissionSha256: publication.admissionSha256, reviewedEntrySha256: publication.reviewedEntrySha256, phase: 'PREPARED' };
    saved.observations = { candidateSha256: digest(jsonBytes(Object.fromEntries(['sourceCommit', 'exportedTree', 'publicBase', 'version', 'sourceEpoch',
      'artifactSha256', 'policyHash', 'sourceTagObject', 'sourceProofSha256', 'commitId', 'tagId', 'commitSha256', 'tagSha256', 'bundleSha256'].map((key) => [key, saved[key]])))), attempts: [] };
    saved.observationsSha256 = digest(jsonBytes(saved.observations));
    fs.writeFileSync(path.join(stateDir, 'state.json'), jsonBytes(saved), { mode: 0o600 });
    const resumed = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(snapshot, 'isolated-publisher.mjs'), 'rehearse', '--snapshot', snapshot, '--state', stateDir],
        { cwd: scratch, env: { HOME: process.env.HOME, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
      child.on('close', (status) => resolve({ status, output }));
    });
    expect(resumed.status, resumed.output).toBe(1); expect(resumed.output).toContain(expectedFinding);
    git(initialConsumer, 'config', 'core.hooksPath', snapshot); git(initialConsumer, 'config', 'punchpilot.publicationState', stateDir);
    expect(() => git(initialConsumer, 'push', '--atomic', '--', remote, `${publicationRef}:refs/heads/main`, `${tagRef}:refs/tags/${manifest.version}`)).toThrow(expectedFinding);
    expect(remoteReadback(initialConsumer, remote, manifest.version)).toEqual({ main: publicBase, tag: null, peeled: null });
    for (const name of ['publication.commit', 'publication.tag']) {
      expect(digest(fs.readFileSync(path.join(stateDir, name)))).toBe(saved[name === 'publication.commit' ? 'commitSha256' : 'tagSha256']);
    }
    const historyCalls = fs.readFileSync(pythonTrace, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((args) => args[0].endsWith('public-release-privacy-gate.py') && args.includes('--ref'));
    expect(historyCalls.length).toBeGreaterThanOrEqual(2);
    for (const args of historyCalls) {
      expect(args[args.indexOf('--ref') + 1]).toBe(publicBase);
      expect(args[args.indexOf('--commit-range') + 1]).toBe(publicBase);
      expect(args).toContain('--require-forbidden-hosts'); expect(args).toContain('--fail-on-warn');
    }
    await closeServer(server);
  }, 120000);

  it('clean consumer preparation publishes the frozen objects and retries without reminting', async () => {
    const fixture = await createPublicationFixture();
    const { scratch, remote, version, signedTag, exported, publication, snapshot, stateDir, initialConsumer, admissionFile, commit } = fixture;
    const prepared = preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer });
    const durableBytes = Object.fromEntries(['publication.commit', 'publication.tag', 'publication.bundle', 'state.json'].map((name) => [name, fs.readFileSync(path.join(stateDir, name))]));
    const unreviewedBody = JSON.parse(durableBytes['state.json']); unreviewedBody.releaseBody = 'Fixture content absent from the reviewed export.\n';
    fs.writeFileSync(path.join(stateDir, 'state.json'), jsonBytes(unreviewedBody));
    expect(() => validateConsumerPublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer })).toThrow('Release body differs from the reviewed export');
    expect(() => preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'changed-release-body-store') })).toThrow('Release body differs from the reviewed export');
    let unreviewedBodyRequests = 0;
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'changed-release-body-publisher'), api: () => { unreviewedBodyRequests += 1; throw new Error('unreviewed Release body reached the API'); } })).rejects.toThrow('Release body differs from the reviewed export');
    expect(unreviewedBodyRequests).toBe(0);
    fs.writeFileSync(path.join(stateDir, 'state.json'), durableBytes['state.json']);
    const invalidState = JSON.parse(durableBytes['state.json']); invalidState.sourceEpoch += 1;
    fs.writeFileSync(path.join(stateDir, 'state.json'), jsonBytes(invalidState));
    expect(() => preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'changed-epoch-store') })).toThrow('immutable publication tuple');
    fs.writeFileSync(path.join(stateDir, 'state.json'), durableBytes['state.json']);
    // Actual persisted objects exist, but a preparation crash removed the final
    // state marker. The next run completes it without changing any object byte.
    fs.rmSync(path.join(stateDir, 'state.json')); fs.mkdirSync(path.join(stateDir, 'metadata-abandoned'), { mode: 0o700 });
    const repaired = preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'repaired-preparation') });
    expect(repaired.state.commitId).toBe(prepared.state.commitId);
    for (const name of ['publication.commit', 'publication.tag', 'publication.bundle']) expect(fs.readFileSync(path.join(stateDir, name)).equals(durableBytes[name])).toBe(true);
    expect(prepared.state.exportedTree).not.toBe(exported.sourceTree);
    expect(() => git(initialConsumer, 'cat-file', '-t', commit)).toThrow();
    expect(() => git(initialConsumer, 'cat-file', '-t', signedTag)).toThrow();
    expect(git(initialConsumer, 'remote')).toBe(''); expect(fs.readdirSync(snapshot)).not.toContain('source-ci-gate.json');
    const publicApi = await createPublicationApi(fixture, prepared);
    const { api, controls } = publicApi;
    const firstConsumer = path.join(scratch, 'consumer-publish');
    const completed = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: firstConsumer, admissionFile, api });
    expect(completed.phase).toBe('VERIFIED'); expect(controls.releaseWrites).toBe(1); expect(controls.releaseReads).toBeGreaterThan(2);
    const observed = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json')));
    expect(JSON.stringify(observed)).not.toContain(responseCanary);
    expect(observed.observations.attempts).toHaveLength(1);
    expect(observed.observationsSha256).toBe(digest(jsonBytes(observed.observations)));
    const observedAttempt = observed.observations.attempts[0];
    expect(observedAttempt.number).toBe(1);
    expect(observedAttempt.admissionSha256).toBe(publication.admissionSha256);
    expect(observedAttempt.reviewedEntrySha256).toBe(publication.reviewedEntrySha256);
    expect(observedAttempt.events.slice(-4).map((event) => event.gate)).toEqual(['platform', 'publicCI', 'release', 'git']);
    expect(observedAttempt.events.at(-3).data).toEqual({ id: 1, run_number: 1, run_attempt: 1, head_sha: completed.commitId, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' });
    expect(observedAttempt.events.at(-2).data).toEqual({ id: 42, tag_name: completed.version, target_commitish: completed.commitId, name: completed.version, bodySha256: digest(completed.releaseBody), draft: false, prerelease: false, assetCount: 0 });
    expect(observedAttempt.events.at(-1).data).toEqual({ main: completed.commitId, tag: completed.tagId, peeled: completed.commitId, tree: completed.exportedTree, commitSha256: completed.commitSha256, tagSha256: completed.tagSha256 });
    expect(remoteReadback(firstConsumer, remote, `v${version}`)).toEqual({ main: completed.commitId, tag: completed.tagId, peeled: completed.commitId });
    const fresh = path.join(scratch, 'consumer-reloaded');
    const reloaded = restorePublication(stateDir, fresh); expect(reloaded.commitId).toBe(completed.commitId); expect(reloaded.tagId).toBe(completed.tagId);
    const retried = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'consumer-retry'), admissionFile, api });
    expect(retried.commitId).toBe(completed.commitId); expect(controls.releaseWrites).toBe(1);
    expect(retried.observations.attempts).toHaveLength(2);
    expect(retried.observations.attempts[1].number).toBe(2);
    const scannerCalls = assertPublicationScannerPolicy(fixture);
    expect(scannerCalls.filter((args) => args.includes('--commit-envelope')).length).toBeGreaterThan(10);
    await closeServer(fixture.server); await closeServer(publicApi.server);
  }, 120000);

  it('saved observations reject corruption and preserve bounded proof across renewed admission', async () => {
    const fixture = await createPublicationFixture();
    const { scratch, publicBase, publication, snapshot, consumerSnapshotFile, consumerSnapshotBytes, stateDir, initialConsumer, admissionFile } = fixture;
    const prepared = preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer });
    const publicApi = await createPublicationApi(fixture, prepared);
    const { api, controls } = publicApi;
    const firstConsumer = path.join(scratch, 'consumer-publish');
    const completed = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: firstConsumer, admissionFile, api });
    expect(completed.phase).toBe('VERIFIED');
    const retried = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'consumer-retry'), admissionFile, api });
    expect(retried.observations.attempts).toHaveLength(2);
    const proofStateBytes = fs.readFileSync(path.join(stateDir, 'state.json'));
    for (const [name, mutate, recompute, expected] of [
      ['missing-proof', (state) => { delete state.observations; }, false, 'observations'],
      ['run-attempt-corruption', (state) => { state.observations.attempts[1].events.at(-3).data.run_attempt = 2; }, false, 'observations'],
      ['wrong-run-head', (state) => { state.observations.attempts[1].events.at(-3).data.head_sha = 'f'.repeat(40); }, true, 'public CI'],
      ['missing-terminal-git', (state) => { state.observations.attempts[1].events.pop(); }, true, 'VERIFIED'],
      ['injected-token', (state) => { state.observations.attempts[1].events.at(-3).data.token = responseCanary; }, true, 'public CI'],
      ['changed-candidate', (state) => { state.observations.candidateSha256 = 'f'.repeat(64); }, true, 'candidate'],
      ['changed-attempt-identity', (state) => { state.observations.attempts[1].number = 4; }, true, 'attempt identity'],
      ['changed-admission-binding', (state) => { state.observations.attempts[1].admissionSha256 = 'f'.repeat(64); }, true, 'authority binding'],
      ['changed-entry-binding', (state) => { state.observations.attempts[1].reviewedEntrySha256 = 'f'.repeat(64); }, true, 'authority binding'],
      ['changed-observation-time', (state) => { state.observations.attempts[1].events.at(-3).observedAt = 0; }, true, 'ordering identity'],
      ['unknown-phase', (state) => { state.phase = 'DONE'; }, false, 'phase'],
      ['changed-platform-inventory', (state) => { state.observations.attempts[1].events.at(-4).data.pop(); }, true, 'platform receipt'],
      ['changed-remote-fields', (state) => { state.observations.attempts[1].events.find((event) => event.gate === 'remote').data.raw = 'unapproved'; }, true, 'remote receipt'],
      ['changed-release-target', (state) => { state.observations.attempts[1].events.at(-2).data.target_commitish = publicBase; }, true, 'Release terminal'],
      ['changed-git-tree', (state) => { state.observations.attempts[1].events.at(-1).data.tree = 'f'.repeat(40); }, true, 'Git terminal'],
      ['unknown-observation-gate', (state) => { state.observations.attempts[1].events[0].gate = 'submitted'; }, true, 'gate is invalid'],
      ['false-partial-phase', (state) => { state.phase = 'MAIN_PRESENT'; }, false, 'MAIN_PRESENT'],
      ['false-tag-phase', (state) => { state.phase = 'TAG_PRESENT'; state.observations.attempts[1].events = []; }, true, 'actual main/tag'],
      ['false-release-intent', (state) => { state.phase = 'RELEASE_REQUESTED'; state.releaseRequested = false; }, false, 'Release intent'],
    ]) {
      const invalid = JSON.parse(proofStateBytes); mutate(invalid);
      if (recompute) invalid.observationsSha256 = digest(jsonBytes(invalid.observations));
      fs.writeFileSync(path.join(stateDir, 'state.json'), jsonBytes(invalid));
      expect(() => restorePublication(stateDir, path.join(scratch, name)), name).toThrow(expected);
      expect(() => validateConsumerPublication({ snapshotDir: snapshot, stateDir, repoRoot: firstConsumer }), name).toThrow(expected);
      let requests = 0;
      await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, `${name}-publish`), api: (options) => { requests += 1; return api(options); } })).rejects.toThrow(expected);
      expect(requests).toBe(0);
      fs.writeFileSync(path.join(stateDir, 'state.json'), proofStateBytes);
    }
    // Repeated observations must not grow beyond the private-file reader's
    // bound. Refuse the next attempt before any API/write, retaining the whole
    // existing proof rather than silently trimming its history.
    const boundedStateDir = path.join(scratch, 'bounded-observation-state'); fs.mkdirSync(boundedStateDir, { mode: 0o700 });
    for (const name of ['publication.commit', 'publication.tag', 'publication.bundle', 'provenance.json']) fs.copyFileSync(path.join(stateDir, name), path.join(boundedStateDir, name));
    const boundedState = JSON.parse(proofStateBytes), boundedEvents = boundedState.observations.attempts.at(-1).events;
    const repeatedRemote = { ...boundedEvents.findLast((event) => event.gate === 'remote'), observedAt: boundedEvents.at(-4).observedAt };
    const eventBytes = JSON.stringify(repeatedRemote).length + 1;
    const repetitionCount = Math.floor((ENVELOPE_LIMIT - jsonBytes(boundedState).length) / eventBytes);
    boundedEvents.splice(-4, 0, ...Array.from({ length: repetitionCount }, () => repeatedRemote));
    boundedState.observationsSha256 = digest(jsonBytes(boundedState.observations));
    const boundedBytes = jsonBytes(boundedState);
    expect(boundedBytes.length).toBeLessThanOrEqual(ENVELOPE_LIMIT);
    fs.writeFileSync(path.join(boundedStateDir, 'state.json'), boundedBytes, { mode: 0o600 });
    let boundedRequests = 0;
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir: boundedStateDir, repoRoot: path.join(scratch, 'bounded-observation-consumer'), api: (options) => { boundedRequests += 1; return api(options); } })).rejects.toThrow('bounded state store');
    expect(boundedRequests).toBe(0);
    expect(fs.readFileSync(path.join(boundedStateDir, 'state.json')).equals(boundedBytes)).toBe(true);
    // Independently installed re-admission may change the approval for the
    // same frozen candidate; prior attempts retain their original authority.
    const originalInstalledAdmission = fs.readFileSync(admissionFile);
    const renewedAdmission = JSON.parse(originalInstalledAdmission);
    renewedAdmission.ownerApproval = 'fixture-renewed-owner-review';
    renewedAdmission.receipts.owner.approvalId = renewedAdmission.ownerApproval;
    const renewedAdmissionSha256 = digest(jsonBytes(renewedAdmission));
    fs.writeFileSync(admissionFile, jsonBytes(renewedAdmission));
    fs.writeFileSync(consumerSnapshotFile, jsonBytes({ ...JSON.parse(consumerSnapshotBytes), admissionSha256: renewedAdmissionSha256 }));
    try {
      const readmitted = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'readmitted-consumer'), api });
      expect(readmitted.commitId).toBe(completed.commitId);
      expect(readmitted.observations.attempts.at(-1).admissionSha256).toBe(renewedAdmissionSha256);
      expect(readmitted.observations.attempts[0].admissionSha256).toBe(publication.admissionSha256);
      expect(controls.releaseWrites).toBe(1);
    } finally {
      fs.writeFileSync(admissionFile, originalInstalledAdmission);
      fs.writeFileSync(consumerSnapshotFile, consumerSnapshotBytes);
    }
    assertPublicationScannerPolicy(fixture);
    await closeServer(fixture.server); await closeServer(publicApi.server);
  }, 120000);

  it('the exact public writer requires the named bot attempt and owner admission', async () => {
    const fixture = await createPublicationFixture();
    const { scratch, publicSource, remote, publication, snapshot, stateDir, initialConsumer, admissionFile, commit } = fixture;
    const prepared = preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer });
    const publicApi = await createPublicationApi(fixture, prepared);
    const { api, controls } = publicApi;
    const firstConsumer = path.join(scratch, 'consumer-publish');
    const completed = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: firstConsumer, admissionFile, api });
    expect(completed.phase).toBe('VERIFIED');
    // GHCR has only exact public P/B history and uses the same admission gate;
    // source credentials/snapshot are not inputs to this mode.
    git(publicSource, 'fetch', '--no-tags', remote, `${completed.commitId}:refs/heads/public-fixture`);
    git(publicSource, 'checkout', '--detach', completed.commitId);
    git(publicSource, 'remote', 'add', 'origin', 'https://github.com/sky-zhang01/punchpilot.git');
    const writerOptions = { root: publicSource, commitId: completed.commitId, admissionFile, admissionSha256: publication.admissionSha256, runId: 2, runAttempt: 1, api };
    await expect(publicWriteAuthority(writerOptions)).resolves.toMatchObject({ sourceCommit: commit });
    controls.ownerApproved = false; await expect(publicWriteAuthority(writerOptions)).rejects.toThrow('owner'); controls.ownerApproved = true;
    controls.writerActor = 'someone'; await expect(publicWriteAuthority(writerOptions)).rejects.toThrow('named-bot'); controls.writerActor = BOT_NAME;
    controls.writerAttempt = 2; await expect(publicWriteAuthority(writerOptions)).rejects.toThrow('attempt'); controls.writerAttempt = 1;
    controls.publicCIConclusion = 'failure'; await expect(publicWriteAuthority(writerOptions)).rejects.toThrow('forward fix'); controls.publicCIConclusion = 'success';
    await expect(publicWriteAuthority({ ...writerOptions, admissionSha256: '0'.repeat(64) })).rejects.toThrow(/digest/);
    assertPublicationScannerPolicy(fixture);
    await closeServer(fixture.server); await closeServer(publicApi.server);
  }, 120000);

  it('the installed CLI and hook recover exact Git updates after lost or partial responses', async () => {
    const fixture = await createPublicationFixture();
    const { scratch, publicBase, remote, version, snapshot, stateDir, initialConsumer } = fixture;
    const prepared = preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer });
    const durableBytes = Object.fromEntries(['publication.commit', 'publication.tag', 'publication.bundle', 'state.json'].map((name) => [name, fs.readFileSync(path.join(stateDir, name))]));
    const publicApi = await createPublicationApi(fixture, prepared);
    const { api } = publicApi;
    const completed = prepared.state;
    const firstConsumer = initialConsumer;
    // The actual installed CLI + its copied hook drive the exact same state
    // machine against an existing local bare fixture without remote API writes.
    const rehearsalState = path.join(scratch, 'cli-state');
    // Reuse frozen objects with their pre-write state. The rehearsal has an
    // independent local Release inventory, so it starts before the POST intent.
    fs.cpSync(stateDir, rehearsalState, { recursive: true }); fs.chmodSync(rehearsalState, 0o700);
    fs.writeFileSync(path.join(rehearsalState, 'state.json'), durableBytes['state.json']);
    for (const name of fs.readdirSync(rehearsalState)) if (name.startsWith('consumer-')) fs.rmSync(path.join(rehearsalState, name), { recursive: true, force: true });
    const invokeRehearsal = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(projectRoot, 'scripts/ci/publication-boundary-dryrun.mjs'), '--snapshot', snapshot, '--state', rehearsalState],
        { cwd: scratch, env: { HOME: process.env.HOME, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; }); child.on('close', (status) => resolve({ status, output }));
    });
    // Actual installed CLI exercises both visible updates, then the one-update
    // hook case where main is already P and only the exact saved tag is absent.
    git(remote, 'update-ref', '-d', `refs/tags/v${version}`);
    git(remote, 'update-ref', 'refs/heads/main', publicBase);
    const rehearsed = await invokeRehearsal();
    expect(rehearsed.status, rehearsed.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(rehearsalState, 'state.json'))).phase).toBe('VERIFIED');
    git(remote, 'update-ref', '-d', `refs/tags/v${version}`);
    const oneUpdate = await invokeRehearsal(); expect(oneUpdate.status, oneUpdate.output).toBe(0);
    expect(remoteReadback(firstConsumer, remote, `v${version}`)).toEqual({ main: completed.commitId, tag: completed.tagId, peeled: completed.commitId });
    assertPushUpdates({ root: firstConsumer, remoteUrl: remote, state: completed, input: '' });
    expect(() => assertPushUpdates({ root: firstConsumer, remoteUrl: remote, state: completed,
      input: `refs/tags/extra ${completed.tagId} refs/tags/extra ${'0'.repeat(40)}\n` })).toThrow('reviewed canonical');
    // Exact writer argv survives ambiguous successful Git transport response.
    git(remote, 'update-ref', '-d', `refs/tags/v${version}`); git(remote, 'update-ref', 'refs/heads/main', publicBase);
    let pushes = 0;
    const lostPush = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'consumer-response-lost'), api,
      push: ({ root, url, refspecs, atomic }) => {
        expect(atomic).toBe(true); expect(refspecs).toEqual([`${completed.publicationRef}:refs/heads/main`, `${completed.tagRef}:refs/tags/v${version}`]);
        git(root, 'push', '--atomic', '--', url, ...refspecs); pushes += 1; throw new Error('fixture response lost');
      } });
    expect(lostPush.phase).toBe('VERIFIED'); expect(pushes).toBe(1);
    // Abnormal partial server state is recovered with the same two objects.
    git(remote, 'update-ref', '-d', `refs/tags/v${version}`); git(remote, 'update-ref', 'refs/heads/main', publicBase);
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'consumer-partial'), api,
      push: ({ root, url, refspecs }) => {
        expect(refspecs).toHaveLength(2);
        git(root, '-c', 'core.hooksPath=/dev/null', 'push', '--', url, refspecs[0]);
        throw new Error('fixture abnormal partial write');
      } })).rejects.toThrow('abnormal partial');
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'))).phase).toBe('MAIN_PRESENT');
    const partialRetry = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'consumer-partial-retry'), api });
    expect(partialRetry.commitId).toBe(completed.commitId); expect(partialRetry.tagId).toBe(completed.tagId);
    assertPublicationScannerPolicy(fixture);
    await closeServer(fixture.server); await closeServer(publicApi.server);
  }, 120000);

  it('Release recovery and fresh terminal readback reject CI identity and public ref drift', async () => {
    const fixture = await createPublicationFixture();
    const { scratch, publicSource, remote, snapshot, stateDir, initialConsumer, admissionFile } = fixture;
    const prepared = preparePublication({ snapshotDir: snapshot, stateDir, repoRoot: initialConsumer });
    const durableBytes = Object.fromEntries(['publication.commit', 'publication.tag', 'publication.bundle', 'state.json'].map((name) => [name, fs.readFileSync(path.join(stateDir, name))]));
    const publicApi = await createPublicationApi(fixture, prepared);
    const { api, controls } = publicApi;
    const firstConsumer = path.join(scratch, 'consumer-publish');
    const completed = await publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: firstConsumer, admissionFile, api });
    expect(completed.phase).toBe('VERIFIED');
    git(publicSource, 'fetch', '--no-tags', remote, `${completed.commitId}:refs/heads/public-fixture`);
    git(publicSource, 'checkout', '--detach', completed.commitId);
    // A newer failed public CI makes Release unreachable with immutable refs;
    // once source was fixed and a new version is prepared, it is a new tuple.
    controls.publicCIConclusion = 'failure'; const beforeFailedCI = controls.releaseWrites;
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'consumer-ci-failed'), api })).rejects.toThrow('forward fix');
    expect(controls.releaseWrites).toBe(beforeFailedCI); controls.publicCIConclusion = 'success';
    controls.release = null; controls.releaseReads = 0; controls.loseReleaseResponse = true;
    const releaseLostState = path.join(scratch, 'release-lost-state'); fs.cpSync(stateDir, releaseLostState, { recursive: true }); fs.chmodSync(releaseLostState, 0o700);
    fs.writeFileSync(path.join(releaseLostState, 'state.json'), durableBytes['state.json']);
    const lostRelease = await publishPrepared({ snapshotDir: snapshot, stateDir: releaseLostState, repoRoot: path.join(scratch, 'consumer-release-response-lost'), api });
    expect(lostRelease.phase).toBe('VERIFIED'); expect(controls.releaseWrites).toBe(beforeFailedCI + 1);
    const unknownState = path.join(scratch, 'unknown-release-state'); fs.cpSync(stateDir, unknownState, { recursive: true }); fs.chmodSync(unknownState, 0o700);
    fs.writeFileSync(path.join(unknownState, 'state.json'), durableBytes['state.json']);
    let unknownRequests = 0;
    const unknownApi = (options) => {
      if (options.method === 'POST') { unknownRequests += 1; throw new Error('fixture unknown Release transport'); }
      if (options.endpoint.includes('/releases/tags/')) return Promise.resolve({ status: 404, body: null });
      return api(options);
    };
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir: unknownState, repoRoot: path.join(scratch, 'unknown-release-first'), api: unknownApi })).rejects.toThrow('unknown Release transport');
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir: unknownState, repoRoot: path.join(scratch, 'unknown-release-retry'), api: unknownApi })).rejects.toThrow('retry terminal readback');
    expect(unknownRequests).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(unknownState, 'state.json'))).phase).toBe('RELEASE_REQUESTED');
    let successfulReleaseReads = 0;
    const changedReleaseApi = async (options) => {
      const response = await api(options);
      return options.endpoint.includes('/releases/tags/') && response.status === 200 && ++successfulReleaseReads === 2
        ? { ...response, body: { ...response.body, id: response.body.id + 1 } } : response;
    };
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'changed-release-id-consumer'), api: changedReleaseApi })).rejects.toThrow('fresh Release terminal identity');
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'))).phase).not.toBe('VERIFIED');
    let ciReads = 0;
    const changedFinalCI = async (options) => {
      const response = await api(options);
      if (options.endpoint.includes('/actions/workflows/ci.yml/runs') && ++ciReads === 2) response.body.workflow_runs[0].conclusion = 'failure';
      return response;
    };
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'changed-final-ci-consumer'), api: changedFinalCI })).rejects.toThrow('forward fix');
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'))).phase).not.toBe('VERIFIED');
    // A fresh fetch must bind the main ref itself. A different same-tree main
    // still contains P via the tag and must never satisfy terminal acceptance.
    successfulReleaseReads = 0;
    const sameTreeHead = git(publicSource, '-c', 'commit.gpgsign=false', 'commit-tree', completed.exportedTree, '-p', completed.commitId, '-m', 'same-tree public ref drift');
    const driftApi = async (options) => {
      const response = await api(options);
      if (options.endpoint.includes('/releases/tags/') && response.status === 200 && ++successfulReleaseReads === 2) git(remote, 'update-ref', 'refs/heads/main', sameTreeHead);
      return response;
    };
    // Import only this public commit into the local remote before the canary.
    git(publicSource, 'update-ref', 'refs/heads/same-tree-canary', sameTreeHead);
    git(publicSource, 'push', '-q', remote, 'refs/heads/same-tree-canary:refs/heads/same-tree-canary');
    try {
      await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'same-tree-drift-consumer'), api: driftApi })).rejects.toThrow('fresh network Git terminal readback');
      expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'))).phase).not.toBe('VERIFIED');
    } finally {
      git(remote, 'update-ref', 'refs/heads/main', completed.commitId);
      git(remote, 'update-ref', '-d', 'refs/heads/same-tree-canary');
    }
    // KI1: changed public B cannot rebase or remint saved objects.
    git(publicSource, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'public base advanced');
    git(publicSource, 'push', remote, 'HEAD:refs/heads/main');
    await expect(publishPrepared({ snapshotDir: snapshot, stateDir, repoRoot: path.join(scratch, 'consumer-base-moved'), api })).rejects.toThrow('KI1');
    assertPublicationScannerPolicy(fixture);
    await closeServer(fixture.server); await closeServer(publicApi.server);
  }, 120000);

  it.each(['id', 'run_number', 'run_attempt'])('rejects malformed exact source ordering identity %s before accepting old green evidence', async (field) => {
    const { server, baseUrl } = await startServer(authorityHandler({ runOverrides: { [field]: null } }));
    const root = createRepository(baseUrl); const { gate } = createTrustedGate(root, baseUrl);
    const result = await runGate(root, gate, ['--commit', commit, '--object', commit, '--ref', 'refs/heads/main']);
    expect(result.status).toBe(1); expect(result.stderr).toContain('ordering identity'); await closeServer(server);
  });
  it('rejects an unrequired failed job even when required contexts and run conclusion claim success', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ extraJobs: 1, auxiliaryConclusion: 'failure' }));
    const root = createRepository(baseUrl); const { gate } = createTrustedGate(root, baseUrl);
    const result = await runGate(root, gate, ['--commit', commit, '--object', commit, '--ref', 'refs/heads/main']);
    expect(result.status).toBe(1); expect(result.stderr).toContain('complete source workflow jobs'); await closeServer(server);
  });
  it('accepts exact source main when Gitea omits the synthetic status creator', async () => {
    const { server, baseUrl } = await startServer(authorityHandler());
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('exact live refs');
    await closeServer(server);
  });

  it('writes run-bound proof only after successful final readback', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ includeRelease: true }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);
    const evidence = path.join(path.dirname(gate), 'source-proof.json');
    const result = await runGate(root, gate, [
      '--commit', commit, '--object', tagObject, '--ref', 'refs/tags/v0.5.0',
      '--evidence-out', evidence,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    expect(proof.sourceCommit).toBe(commit);
    expect(proof.sourceTagObject).toBe(tagObject);
    expect(proof.mainRun.id).toBe(77);
    expect(proof.releaseRun.id).toBe(88);
    expect(proof.mainJobs).toHaveLength(7);
    expect(proof.releaseJobs).toHaveLength(1);
    expect(proof).not.toHaveProperty('pass');
    expect(fs.statSync(evidence).mode & 0o077).toBe(0);
    await closeServer(server);
  });

  it('never persists a proof when final source authority drifts', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({
      includeRelease: true, driftOnFinalReadback: true,
    }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);
    const evidence = path.join(path.dirname(gate), 'source-proof.json');
    const result = await runGate(root, gate, [
      '--commit', commit, '--object', tagObject, '--ref', 'refs/tags/v0.5.0',
      '--evidence-out', evidence,
    ]);
    expect(result.status).toBe(1);
    expect(fs.existsSync(evidence)).toBe(false);
    await closeServer(server);
  });

  it('rejects a candidate different from the externally pinned promotion commit', async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((request, response) => {
      requests += 1;
      authorityHandler()(request, response);
    });
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl, {
      promotionCommit: 'c'.repeat(commit.length),
    });

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(requests).toBe(0);
    expect(result.stderr).toContain('reviewed snapshot');
    expect(result.stderr).not.toContain(commit);
    await closeServer(server);
  });

  it('rejects a workflow tree different from the external snapshot', async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((request, response) => {
      requests += 1;
      authorityHandler()(request, response);
    });
    const root = createRepository(baseUrl);
    const trees = workflowTrees(root);
    trees['.gitea/workflows'] = 'c'.repeat(commit.length);
    const { gate } = createTrustedGate(root, baseUrl, {
      trustedWorkflowTrees: trees,
    });

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(requests).toBe(0);
    expect(result.stderr).toContain('workflow tree');
    expect(result.stderr).not.toContain(trees['.gitea/workflows']);
    await closeServer(server);
  });

  it('rejects a legacy source configuration before promotion', async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((request, response) => {
      requests += 1;
      authorityHandler()(request, response);
    });
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl, { version: 1 });

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(requests).toBe(0);
    expect(result.stderr).toContain('version is unsupported');
    await closeServer(server);
  });

  it('accepts only an exact annotated tag with a distinct successful release run', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ includeRelease: true }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', tagObject,
      '--ref', 'refs/tags/v0.5.0',
    ]);

    expect(result.status, result.stderr).toBe(0);
    await closeServer(server);
  });

  it('rejects a same-commit tag replacement not attested by the exact release run', async () => {
    const replacement = 'c'.repeat(40);
    const { server, baseUrl } = await startServer(authorityHandler({
      includeRelease: true,
      remoteTagObject: replacement,
      attestedTagObject: tagObject,
    }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', replacement,
      '--ref', 'refs/tags/v0.5.0',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not attest the promotion tag object');
    expect(result.stderr).not.toContain(replacement);
    await closeServer(server);
  });

  it('validates the external source destination binding without network access', async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((request, response) => {
      requests += 1;
      authorityHandler()(request, response);
    });
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, ['--validate-source-destination']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('destination binding passed');
    expect(requests).toBe(0);
    await closeServer(server);
  });

  it('accepts only an externally trusted loopback Git transport', async () => {
    const { server, baseUrl } = await startServer(authorityHandler());
    const root = createRepository(baseUrl);
    const transportUrl = 'http://127.0.0.1:13000/example/punchpilot.git';
    git(root, 'remote', 'set-url', '--push', 'source', transportUrl);
    const { gate } = createTrustedGate(root, baseUrl, {
      gitTransportUrls: [transportUrl],
    });

    const accepted = await runGate(root, gate, ['--validate-source-destination']);
    const { gate: untrustedGate } = createTrustedGate(root, baseUrl);
    const rejected = await runGate(root, untrustedGate, ['--validate-source-destination']);
    const { gate: malformedGate } = createTrustedGate(root, baseUrl, {
      gitTransportUrls: [{}],
    });
    const malformed = await runGate(root, malformedGate, ['--validate-source-destination']);

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('not explicitly trusted');
    expect(rejected.stderr).not.toContain(transportUrl);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('transport configuration is invalid');
    expect(malformed.stderr).not.toContain('[object Object]');
    await closeServer(server);
  });

  it('rejects successful contexts mixed from different CI runs', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ mixedRun: true }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exact successful run');
    expect(result.stderr).not.toContain(commit);
    await closeServer(server);
  });

  it('rejects a required context that points to a nonexistent Actions job', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ forgedJob: true }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required source CI status');
    expect(result.stderr).not.toContain('9999');
    await closeServer(server);
  });

  it.each([
    ['job name', { wrongJobName: true }],
    ['job head', { wrongJobHead: true }],
    ['job attempt', { wrongJobAttempt: true }],
    ['job conclusion', { failedJob: true }],
  ])('rejects a required context with the wrong exact %s', async (_label, options) => {
    const { server, baseUrl } = await startServer(authorityHandler(options));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/exact successful job|complete source workflow jobs/);
    expect(result.stderr).not.toContain(commit);
    await closeServer(server);
  });

  it('rejects a newer failed push run even when an older run and dispatch succeeded', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({
      newerMainFailure: true,
      dispatchSuccess: true,
    }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('latest exact source workflow run');
    await closeServer(server);
  });

  it('rejects a workflow run whose exact ref path does not match', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ wrongMainRef: true }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No exact source workflow run');
    await closeServer(server);
  });

  it('rejects a release run from another tag on the same commit', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({
      includeRelease: true,
      wrongReleaseRef: true,
    }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', tagObject,
      '--ref', 'refs/tags/v0.5.0',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No exact source workflow run');
    await closeServer(server);
  });

  it('reads every status page before accepting required contexts', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ extraStatuses: 60 }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status, result.stderr).toBe(0);
    await closeServer(server);
  });

  it('reads every Actions job page before accepting required contexts', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ extraJobs: 60 }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status, result.stderr).toBe(0);
    await closeServer(server);
  });

  it('rejects duplicate Actions job identities', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({ duplicateJobId: true }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workflow-job identity evidence');
    await closeServer(server);
  });

  it('rejects authority that changes during final readback', async () => {
    const { server, baseUrl } = await startServer(authorityHandler({
      driftOnFinalReadback: true,
    }));
    const root = createRepository(baseUrl);
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('latest exact source workflow run');
    await closeServer(server);
  });

  it('rejects an API origin different from the configured source remote before network use', async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((request, response) => {
      requests += 1;
      authorityHandler()(request, response);
    });
    const root = createRepository(baseUrl);
    git(root, 'remote', 'set-url', '--push', 'source', 'https://other.example.invalid/example/punchpilot.git');
    const { gate } = createTrustedGate(root, baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(requests).toBe(0);
    expect(result.stderr).toContain('API origin');
    expect(result.stderr).not.toContain('other.example.invalid');
    await closeServer(server);
  });

  it('rejects a failed latest required context and an altered tag object', async () => {
    const failedServer = await startServer(authorityHandler({ failure: true }));
    const root = createRepository(failedServer.baseUrl);
    const { gate } = createTrustedGate(root, failedServer.baseUrl);
    const failed = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).not.toContain('synthetic-token');
    await closeServer(failedServer.server);

    const tagServer = await startServer(authorityHandler({
      includeRelease: true,
      remoteTagObject: 'c'.repeat(40),
    }));
    const tagRoot = createRepository(tagServer.baseUrl);
    const { gate: tagGate } = createTrustedGate(tagRoot, tagServer.baseUrl);
    const altered = await runGate(tagRoot, tagGate, [
      '--commit', commit,
      '--object', tagObject,
      '--ref', 'refs/tags/v0.5.0',
    ]);
    expect(altered.status).toBe(1);
    expect(altered.stderr).toContain('live source object');
    expect(altered.stderr).not.toContain(tagObject);
    await closeServer(tagServer.server);
  });

  it('does not follow API redirects carrying authorization headers', async () => {
    let redirectedRequests = 0;
    const target = await startServer((request, response) => {
      redirectedRequests += 1;
      json(response, {});
    });
    const redirect = await startServer((request, response) => {
      response.writeHead(302, { location: `${target.baseUrl}/capture` });
      response.end();
    });
    const root = createRepository(redirect.baseUrl);
    const { gate } = createTrustedGate(root, redirect.baseUrl);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(redirectedRequests).toBe(0);
    expect(result.stderr).not.toContain(target.baseUrl);
    await closeServer(redirect.server);
    await closeServer(target.server);
  });

  it('rejects a credential file readable by other users before network access', async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((request, response) => {
      requests += 1;
      authorityHandler()(request, response);
    });
    const root = createRepository(baseUrl);
    const { gate, token } = createTrustedGate(root, baseUrl);
    fs.chmodSync(token, 0o644);

    const result = await runGate(root, gate, [
      '--commit', commit,
      '--object', commit,
      '--ref', 'refs/heads/main',
    ]);

    expect(result.status).toBe(1);
    expect(requests).toBe(0);
    expect(result.stderr).toContain('private-file requirements');
    expect(result.stderr).not.toContain(token);
    await closeServer(server);
  });
});
