#!/usr/bin/env node
// Private reviewed entry. Source mode checks live source authority; consumer
// mode imports only E and public B/P history and never executes E programs.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAdmission, canonicalObjects, digest, durableFile, ENVELOPE_LIMIT,
  fsyncDirectory, gitBytes, gitEnvironment, gitObjectId, gitText, jsonBytes,
  LIMIT, OID, SHA256, parseTagEnvelope, privateFile, readPrivateJson, safePath,
  platformProtection, publicHistorySigningKeys, sourcePublicCertificates,
  validateProvenance, verifyRawSourceTag, withPublicGpgContext, workflowChanges,
} from './publication-contract.mjs';
import { computePolicyHash, createPublicationArtifact, exportPublicTree, sourceAuthorityProof } from './export-public-tree.mjs';

const publicationLock = new AsyncLocalStorage();
const artifactFiles = ['allowlist.json', 'export.pack', 'manifest.json', 'source-ci-proof.json', 'source-tag.raw'];
const consumerFiles = ['publication-contract.mjs', 'isolated-publisher.mjs', 'export-public-tree.mjs',
  'publication-preflight.mjs', 'public-release-privacy-gate.py', 'release-metadata-check.mjs', 'mint-app-token.mjs', 'pre-push'];
function privateDirectory(directory) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) throw new Error('publication directory must be private and process-owned');
}
function treeEntries(root, tree) {
  const bytes = gitBytes(root, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('publication tree paths must be UTF-8');
  return text.split('\0').filter(Boolean).map((record) => {
    const match = record.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/s);
    if (!match || !safePath(match[3])) throw new Error('publication tree accepts regular safe paths only');
    return { mode: match[1], objectId: match[2], path: match[3] };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function proofBinding(proof, manifest) {
  if (proof.schema !== 'punchpilot-source-ci-proof' || proof.sourceCommit !== manifest.sourceCommit ||
      proof.sourceTagObject !== manifest.sourceTagObject || proof.sourceRef !== `refs/tags/${manifest.version}` || Object.hasOwn(proof, 'pass')) throw new Error('source proof binding mismatch');
}
function readArtifact({ artifactDir, snapshot }) {
  privateDirectory(artifactDir);
  if (fs.readdirSync(artifactDir).sort().join('\n') !== artifactFiles.join('\n')) throw new Error('publication artifact files do not match the closed manifest');
  const manifestBytes = privateFile(path.join(artifactDir, 'manifest.json'));
  if (digest(manifestBytes) !== snapshot.artifactSha256) throw new Error('artifact manifest digest does not match independent admission');
  const manifest = JSON.parse(manifestBytes);
  if (!jsonBytes(manifest).equals(manifestBytes) || manifest.schema !== 'punchpilot-publication-artifact') throw new Error('artifact manifest is noncanonical');
  canonicalObjects(manifest);
  validateProvenance(manifest.provenance, snapshot.policyHash);
  if (manifest.policyHash !== snapshot.policyHash || manifest.provenance.sourceCommit !== manifest.sourceCommit ||
      manifest.provenance.exportedTree !== manifest.exportedTree || manifest.provenance.intendedPublicBase !== manifest.publicBase) throw new Error('artifact provenance binding mismatch');
  const pack = privateFile(path.join(artifactDir, 'export.pack'), null, LIMIT);
  const rawTag = privateFile(path.join(artifactDir, 'source-tag.raw'));
  const proofBytes = privateFile(path.join(artifactDir, 'source-ci-proof.json'));
  const policyBytes = privateFile(path.join(artifactDir, 'allowlist.json'));
  if (digest(pack) !== manifest.packSha256 || digest(rawTag) !== manifest.sourceTagSha256 ||
      digest(proofBytes) !== manifest.sourceProofSha256 || digest(policyBytes) !== manifest.policySha256 ||
      gitObjectId('tag', rawTag) !== manifest.sourceTagObject) throw new Error('artifact content digest mismatch');
  const policy = JSON.parse(policyBytes);
  if (!jsonBytes(policy).equals(policyBytes) || computePolicyHash(policy) !== manifest.policyHash) throw new Error('artifact policy mismatch');
  const proof = JSON.parse(proofBytes);
  if (!jsonBytes(proof).equals(proofBytes)) throw new Error('source proof must be canonical and unambiguous');
  proofBinding(proof, manifest);
  const rawEnvelope = parseTagEnvelope(rawTag);
  if (rawEnvelope.target !== manifest.sourceCommit || rawEnvelope.name !== manifest.version) throw new Error('source tag binding mismatch');
  return { manifest, rawTag, proofBytes, manifestBytes, pack };
}
export function validateArtifact({ artifactDir, snapshot, repoRoot }) {
  const { manifest, rawTag, proofBytes, manifestBytes, pack } = readArtifact({ artifactDir, snapshot });
  if (fs.existsSync(repoRoot)) throw new Error('E import requires a fresh isolated Git store');
  fs.mkdirSync(repoRoot, { mode: 0o700 });
  try {
    gitText(repoRoot, ['init', '--bare', '-q']);
    gitBytes(repoRoot, ['index-pack', '--stdin', '--strict'], pack);
    const entries = treeEntries(repoRoot, manifest.exportedTree);
    if (JSON.stringify(entries.map((entry) => entry.path)) !== JSON.stringify(manifest.provenance.pathset)) throw new Error('artifact pathset mismatch');
    const expected = gitText(repoRoot, ['rev-list', '--objects', manifest.exportedTree]).split('\n').map((line) => line.split(' ')[0]).sort();
    const inventory = gitText(repoRoot, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).split('\n').map((line) => line.split(' '));
    if (inventory.some(([, type]) => !['tree', 'blob'].includes(type)) ||
        JSON.stringify(inventory.map(([oid]) => oid).sort()) !== JSON.stringify(expected)) throw new Error('artifact object closure contains extra or non-E objects');
    if (gitText(repoRoot, ['remote']) || gitText(repoRoot, ['for-each-ref']) || fs.existsSync(path.join(repoRoot, 'objects/info/alternates'))) throw new Error('E consumer cannot contain remotes, refs, or alternates');
    gitText(repoRoot, ['fsck', '--full', '--no-reflogs']);
    return { manifest, rawTag, proofBytes, manifestBytes, entries, artifactSha256: digest(manifestBytes) };
  } catch (error) { fs.rmSync(repoRoot, { recursive: true, force: true }); throw error; }
}

export function installArtifact({ repoRoot, artifactDir, target, sourceGate, fingerprint, revokedKeys = [], gpgHome, publicUrl, forbiddenHosts, admissionFile, admissionSha256 }) {
  const source = fs.realpathSync(repoRoot);
  if (gitText(source, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('independent artifact installation requires a clean reviewed source checkout');
  if (!forbiddenHosts || typeof forbiddenHosts !== 'string') throw new Error('external forbidden-host policy is required');
  const destination = path.resolve(target);
  if (destination === source || destination.startsWith(`${source}${path.sep}`) || fs.existsSync(destination)) throw new Error('consumer installation requires a new private directory outside source');
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    return withPublicGpgContext(sourcePublicCertificates(source, { fingerprint, gpgHome }), (publicHome) => {
      const manifestBytes = privateFile(path.join(artifactDir, 'manifest.json'));
      const manifest = JSON.parse(manifestBytes);
      const snapshot = { artifactSha256: digest(manifestBytes), policyHash: manifest.policyHash };
      const verified = validateArtifact({ artifactDir, snapshot, repoRoot: path.join(destination, 'inspection.git') });
      publicDestination(publicUrl);
      gitText(path.join(destination, 'inspection.git'), ['fetch', '--no-tags', '--', publicUrl, `${manifest.publicBase}:refs/punchpilot/public-base`]);
      const reviewedEntrySha256 = digest(fs.readFileSync(path.join(source, 'scripts/ci/isolated-publisher.mjs')));
      const admitted = readPrivateJson(admissionFile, source);
      assertAdmission(admitted, { ...manifest, artifactSha256: snapshot.artifactSha256, admissionSha256, reviewedEntrySha256 },
        Math.floor(Date.now() / 1000), workflowChanges(path.join(destination, 'inspection.git'), manifest.publicBase, manifest.exportedTree));
      const policy = JSON.parse(privateFile(path.join(artifactDir, 'allowlist.json')));
      verifyRawSourceTag(verified.rawTag, manifest, { fingerprint, revokedKeys, gpgHome: publicHome, scratch: destination });
      const fresh = exportPublicTree({ repoRoot: source, source: manifest.sourceCommit, sourceTag: manifest.sourceTagObject, publicBase: manifest.publicBase, policy, scan: true, forbiddenHosts, gpgHome: publicHome });
      if (JSON.stringify(fresh.provenance) !== JSON.stringify(manifest.provenance) ||
          Number(gitText(source, ['show', '-s', '--format=%ct', manifest.sourceCommit])) !== manifest.sourceEpoch ||
          !gitBytes(source, ['cat-file', 'tag', manifest.sourceTagObject]).equals(verified.rawTag)) throw new Error('independent S-to-E/tag/time projection mismatch');
      const freshProofPath = path.join(destination, 'fresh-source-proof.json');
      const freshProof = sourceAuthorityProof({ repoRoot: source, sourceGate, sourceCommit: manifest.sourceCommit,
        sourceTagObject: manifest.sourceTagObject, version: manifest.version, evidenceFile: freshProofPath });
      if (!freshProof.bytes.equals(verified.proofBytes)) throw new Error('source authority changed since artifact creation; producer evidence cannot authorize admission');
      const historyKeys = publicHistorySigningKeys(path.join(destination, 'inspection.git'), manifest.publicBase, publicHome);
      const publicKey = execFileSync('gpg', ['--no-options', '--homedir', publicHome, '--batch', '--armor', '--export', ...new Set([fingerprint, ...historyKeys])], { env: gitEnvironment(), maxBuffer: ENVELOPE_LIMIT });
      if (!publicKey.length || publicKey.includes(Buffer.from('PRIVATE KEY'))) throw new Error('consumer requires public signing material only');
      const codeHashes = {};
      for (const file of consumerFiles) {
        const bytes = fs.readFileSync(file === 'pre-push' ? path.join(source, '.githooks/pre-push') : path.join(source, 'scripts/ci', file));
        durableFile(path.join(destination, file), bytes);
        if (file === 'pre-push') fs.chmodSync(path.join(destination, file), 0o700);
        codeHashes[file] = digest(bytes);
      }
      const artifactTarget = path.join(destination, 'artifact'); fs.mkdirSync(artifactTarget, { mode: 0o700 });
      for (const file of artifactFiles) durableFile(path.join(artifactTarget, file), privateFile(path.join(artifactDir, file), null, LIMIT));
      durableFile(path.join(destination, 'source-signing-public-key.asc'), publicKey);
      durableFile(path.join(destination, 'admission.json'), jsonBytes(admitted));
      Object.assign(snapshot, { schema: 'punchpilot-consumer-snapshot', manifest, codeHashes, publicKeySha256: digest(publicKey),
        fingerprint, revokedKeys, publicUrl, forbiddenHosts, reviewedCodeCommit: gitText(source, ['rev-parse', 'HEAD']),
        nodeExecutable: fs.realpathSync(process.execPath), nodeVersion: process.version,
        admissionSha256, reviewedEntrySha256, sourceEvidenceSnapshot: JSON.parse(freshProof.bytes) });
      durableFile(path.join(destination, 'consumer.json'), jsonBytes(snapshot));
      fs.rmSync(path.join(destination, 'inspection.git'), { recursive: true, force: true });
      fs.rmSync(freshProofPath); fsyncDirectory(destination);
      return snapshot;
    });
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}
export function readConsumerSnapshot(directory) {
  privateDirectory(directory);
  const snapshot = readPrivateJson(path.join(directory, 'consumer.json'));
  if (snapshot.schema !== 'punchpilot-consumer-snapshot') throw new Error('consumer snapshot is not installed');
  if (snapshot.nodeExecutable !== fs.realpathSync(process.execPath) || snapshot.nodeVersion !== process.version) throw new Error('consumer must execute the independently installed Node runtime');
  if (JSON.stringify(Object.keys(snapshot.codeHashes).sort()) !== JSON.stringify([...consumerFiles].sort())) throw new Error('consumer reviewed code inventory mismatch');
  for (const file of consumerFiles) if (digest(privateFile(path.join(directory, file))) !== snapshot.codeHashes[file]) throw new Error('consumer reviewed code digest mismatch');
  if (snapshot.codeHashes['isolated-publisher.mjs'] !== snapshot.reviewedEntrySha256) throw new Error('consumer entry differs from independently admitted code');
  if (digest(privateFile(path.join(directory, 'source-signing-public-key.asc'))) !== snapshot.publicKeySha256) throw new Error('consumer signing material digest mismatch');
  if (digest(privateFile(path.join(directory, 'admission.json'))) !== snapshot.admissionSha256) throw new Error('consumer admission digest mismatch');
  const artifact = readArtifact({ artifactDir: path.join(directory, 'artifact'), snapshot });
  if (JSON.stringify(artifact.manifest) !== JSON.stringify(snapshot.manifest) ||
      JSON.stringify(JSON.parse(artifact.proofBytes)) !== JSON.stringify(snapshot.sourceEvidenceSnapshot)) throw new Error('consumer snapshot differs from the independently sealed source artifact');
  return snapshot;
}
function processIdentity(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
export async function withPublicationLock(directory, operation) {
  privateDirectory(directory);
  // The stable lock inode is never renamed or unlinked. Kernel flock releases
  // when the last Node/helper descriptor closes; stale JSON cannot grant ownership.
  const owner = { host: os.hostname(), pid: process.pid, started: processIdentity(process.pid) };
  if (!owner.started) throw new Error('cannot identify publication lock owner');
  const lockFile = path.join(directory, '.publication.lock');
  const lockFd = fs.openSync(lockFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  const lockMetadata = fs.fstatSync(lockFd);
  if (!lockMetadata.isFile() || lockMetadata.uid !== process.getuid() || lockMetadata.mode & 0o077) {
    fs.closeSync(lockFd); throw new Error('unsafe publication lock inode');
  }
  const program = String.raw`import fcntl,json,os,stat,sys,tempfile
directory=sys.argv[1]; owner=json.loads(sys.argv[2])
lock=os.path.join(directory,'.publication.lock')
fd=3
meta=os.fstat(fd)
if not stat.S_ISREG(meta.st_mode) or meta.st_uid!=os.getuid() or meta.st_mode&0o077: raise SystemExit('unsafe publication lock')
fcntl.flock(fd,fcntl.LOCK_EX)
current=os.stat(lock,follow_symlinks=False)
if (current.st_dev,current.st_ino)!=(meta.st_dev,meta.st_ino): raise SystemExit('publication lock inode changed')
record=os.path.join(directory,'.publication-lock-owner.json')
if os.path.exists(record):
 previous=json.load(open(record))
 if previous.get('host')!=owner['host']: raise SystemExit('cross-host publication lock recovery requires operator admission')
owner['lockHelperPid']=os.getpid()
temporary_fd,temporary=tempfile.mkstemp(prefix='.publication-owner-',dir=directory)
with os.fdopen(temporary_fd,'w') as output:
 json.dump(owner,output,separators=(',',':')); output.write('\n'); output.flush(); os.fsync(output.fileno())
os.replace(temporary,record)
directory_fd=os.open(directory,os.O_RDONLY); os.fsync(directory_fd)
try:
 print('LOCKED',flush=True)
 sys.stdin.buffer.read()
finally:
 if os.path.exists(record):
  actual=json.load(open(record))
  if actual==owner: os.unlink(record); os.fsync(directory_fd)
 os.close(directory_fd)
`;
  const helper = spawn('python3', ['-c', program, directory, JSON.stringify(owner)], {
    env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe', lockFd],
  });
  let stderr = '';
  helper.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    helper.once('error', reject); helper.once('close', (code) => resolve(code));
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      helper.stdout.on('data', (chunk) => { output += chunk; if (output === 'LOCKED\n') resolve(); else if (output.length > 16) reject(new Error('invalid publication lock handshake')); });
      helper.once('error', reject);
      helper.once('close', (code) => reject(new Error(`publication lock helper failed (${code}): ${stderr}`)));
    });
    return await publicationLock.run({ fd: lockFd, file: lockFile, device: lockMetadata.dev, inode: lockMetadata.ino }, operation);
  } finally {
    helper.stdin.end();
    try {
      const code = await closed;
      if (code !== 0) throw new Error(`publication lock release failed (${code}): ${stderr}`);
    } finally { fs.closeSync(lockFd); }
  }
}
function assertHeldLock() {
  const held = publicationLock.getStore();
  if (!held) throw new Error('publication write requires the OS lock');
  const current = fs.lstatSync(held.file), descriptor = fs.fstatSync(held.fd);
  if (current.isSymbolicLink() || current.dev !== held.device || current.ino !== held.inode ||
      descriptor.dev !== held.device || descriptor.ino !== held.inode) throw new Error('publication lock inode changed before write');
}

function materialize(root, tree, destination) {
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const entry of treeEntries(root, tree)) {
    const file = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, gitBytes(root, ['cat-file', 'blob', entry.objectId]), { flag: 'wx', mode: Number.parseInt(entry.mode.slice(3), 8) });
  }
}
function releaseBodyFromChangelog(changelog, version) {
  const section = changelog.slice(changelog.indexOf(`## [${version.slice(1)}]`));
  const nextHeading = section.indexOf('\n## [');
  return section.slice(0, nextHeading < 0 ? undefined : nextHeading).trim() + '\n';
}
function executeGate(file, args, cwd, env) {
  const executable = file.endsWith('.py') ? 'python3' : process.execPath;
  const result = spawnSync(executable, [file, ...args], { cwd, env, encoding: 'utf8', maxBuffer: ENVELOPE_LIMIT });
  if (result.error || result.status !== 0) throw new Error(`required ${path.basename(file)} gate failed: ${result.stdout || ''}${result.stderr || ''}`);
}
function scanPublicAncestry(snapshotDir, repoRoot, publicBase, environment) {
  // A single commit range walks every reachable ancestor, including merge
  // parents, and scans identities, messages and all historical tree blobs.
  executeGate(path.join(snapshotDir, 'public-release-privacy-gate.py'), [
    '--root', repoRoot, '--repo-name', 'public', '--ref', publicBase, '--commit-range', publicBase,
    '--require-forbidden-hosts', '--fail-on-warn',
  ], repoRoot, environment);
}
function publicDestination(url) {
  if (url === 'https://github.com/sky-zhang01/punchpilot.git') return 'github';
  if (path.isAbsolute(url) && fs.lstatSync(url).isDirectory() && gitText(url, ['rev-parse', '--is-bare-repository']) === 'true') return 'local';
  throw new Error('publisher destination must be the fixed public repository or a local bare fixture');
}
export function remoteReadback(root, url, version) {
  const output = gitText(root, ['ls-remote', '--', url, 'refs/heads/main', `refs/tags/${version}`, `refs/tags/${version}^{}`]);
  const refs = new Map(output.split('\n').filter(Boolean).map((line) => line.split('\t').reverse()));
  return { main: refs.get('refs/heads/main') || null, tag: refs.get(`refs/tags/${version}`) || null, peeled: refs.get(`refs/tags/${version}^{}`) || null };
}
function validateRemote(state, remote) {
  if (![state.publicBase, state.commitId].includes(remote.main)) throw new Error('KI1 public base moved; frozen objects cannot be rebased or reused for a new candidate');
  if (remote.tag && (remote.tag !== state.tagId || remote.peeled !== state.commitId)) throw new Error('public release tag conflicts with frozen objects');
  if (!remote.tag && remote.peeled) throw new Error('public tag readback is malformed');
  if (remote.tag && remote.main !== state.commitId) throw new Error('public tag exists without its exact publication main');
}
function stateFiles(directory) { return { state: path.join(directory, 'state.json'), bundle: path.join(directory, 'publication.bundle'), commit: path.join(directory, 'publication.commit'), tag: path.join(directory, 'publication.tag') }; }
const observationBindings = ['sourceCommit', 'exportedTree', 'publicBase', 'version', 'sourceEpoch',
  'artifactSha256', 'policyHash', 'sourceTagObject', 'sourceProofSha256', 'commitId', 'tagId', 'commitSha256', 'tagSha256', 'bundleSha256'];
const ciObservationFields = ['id', 'run_number', 'run_attempt', 'head_sha', 'head_branch', 'event', 'status', 'conclusion'];
function candidateObservationDigest(state) {
  return digest(jsonBytes(Object.fromEntries(observationBindings.map((key) => [key, state[key]]))));
}
function exactKeys(record, keys) {
  return record && !Array.isArray(record) && typeof record === 'object' &&
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
function assertSavedObservations(state) {
  const proof = state.observations;
  if (!exactKeys(proof, ['candidateSha256', 'attempts']) || !Array.isArray(proof.attempts) ||
      !SHA256.test(state.observationsSha256) || digest(jsonBytes(proof)) !== state.observationsSha256) throw new Error('persisted publication observations are missing or corrupted');
  if (proof.candidateSha256 !== candidateObservationDigest(state)) throw new Error('observations candidate differs from the immutable publication tuple');
  if (!['PREPARED', 'MAIN_PRESENT', 'TAG_PRESENT', 'RELEASE_REQUESTED', 'VERIFIED'].includes(state.phase)) throw new Error('persisted publication observations phase is invalid');
  let previousTime = 0;
  for (const [index, attempt] of proof.attempts.entries()) {
    if (!exactKeys(attempt, ['number', 'startedAt', 'admissionSha256', 'reviewedEntrySha256', 'events']) ||
        attempt.number !== index + 1 || !Number.isSafeInteger(attempt.startedAt) || attempt.startedAt < previousTime ||
        !SHA256.test(attempt.admissionSha256) || !SHA256.test(attempt.reviewedEntrySha256) || !Array.isArray(attempt.events)) throw new Error('publication observations attempt identity is invalid');
    previousTime = attempt.startedAt;
    let platformSeen = false, remoteComplete = false, ciSeen = false, releaseSeen = false;
    for (const event of attempt.events) {
      if (!exactKeys(event, ['gate', 'observedAt', 'data']) || !Number.isSafeInteger(event.observedAt) || event.observedAt < previousTime) throw new Error('publication observations ordering identity is invalid');
      previousTime = event.observedAt;
      const data = event.data;
      if (event.gate === 'platform') {
        if (!Array.isArray(data) || data.length !== 4 || new Set(data.map((item) => item?.endpoint)).size !== 4 ||
            data.some((item) => !exactKeys(item, ['endpoint', 'bodySha256']) || !SHA256.test(item.bodySha256)) ||
            !data.slice(0, 2).every((item) => /^\/repos\/sky-zhang01\/punchpilot\/rulesets\/[1-9][0-9]*$/.test(item.endpoint)) ||
            data[2].endpoint !== '/repos/sky-zhang01/punchpilot/environments/public-release' ||
            data[3].endpoint !== '/repos/sky-zhang01/punchpilot/environments/public-release/deployment-branch-policies') throw new Error('publication observations platform receipt is invalid');
        platformSeen = true;
      } else if (event.gate === 'remote') {
        if (!exactKeys(data, ['main', 'tag', 'peeled']) || !platformSeen) throw new Error('publication observations remote receipt is invalid');
        validateRemote(state, data);
        remoteComplete = data.main === state.commitId && data.tag === state.tagId && data.peeled === state.commitId;
      } else if (event.gate === 'publicCI') {
        if (!exactKeys(data, ciObservationFields) || !['id', 'run_number', 'run_attempt'].every((key) => Number.isSafeInteger(data[key]) && data[key] > 0) ||
            data.head_sha !== state.commitId || data.head_branch !== 'main' || data.event !== 'push' || data.status !== 'completed' || data.conclusion !== 'success' ||
            !platformSeen || !remoteComplete) throw new Error('publication observations public CI run/attempt binding is invalid');
        ciSeen = true;
      } else if (event.gate === 'release') {
        if (!exactKeys(data, ['id', 'tag_name', 'target_commitish', 'name', 'bodySha256', 'draft', 'prerelease', 'assetCount']) ||
            !Number.isSafeInteger(data.id) || data.id < 1 || data.tag_name !== state.version || data.target_commitish !== state.commitId || data.name !== state.version ||
            data.bodySha256 !== digest(state.releaseBody) || data.draft !== false || data.prerelease !== false || data.assetCount !== 0 || !ciSeen) throw new Error('publication observations Release terminal binding is invalid');
        releaseSeen = true;
      } else if (event.gate === 'git') {
        if (!exactKeys(data, ['main', 'tag', 'peeled', 'tree', 'commitSha256', 'tagSha256']) || data.main !== state.commitId || data.tag !== state.tagId ||
            data.peeled !== state.commitId || data.tree !== state.exportedTree || data.commitSha256 !== state.commitSha256 || data.tagSha256 !== state.tagSha256 || !releaseSeen) throw new Error('publication observations Git terminal binding is invalid');
      } else throw new Error('publication observations gate is invalid');
    }
  }
  const currentAttempt = proof.attempts.at(-1);
  if (currentAttempt && (currentAttempt.admissionSha256 !== state.admissionSha256 || currentAttempt.reviewedEntrySha256 !== state.reviewedEntrySha256)) throw new Error('publication observations attempt authority binding is invalid');
  const events = currentAttempt?.events || [];
  const remote = events.findLast((event) => event.gate === 'remote')?.data;
  if (state.phase === 'MAIN_PRESENT' && (remote?.main !== state.commitId || remote.tag !== null)) throw new Error('MAIN_PRESENT requires actual partial remote observations');
  if (['TAG_PRESENT', 'RELEASE_REQUESTED', 'VERIFIED'].includes(state.phase) &&
      (remote?.main !== state.commitId || remote.tag !== state.tagId || remote.peeled !== state.commitId)) throw new Error('publication phase requires actual main/tag observations');
  if (state.phase === 'RELEASE_REQUESTED' && (state.releaseRequested !== true || !events.some((event) => event.gate === 'publicCI'))) throw new Error('Release intent requires actual CI observations');
  if (state.phase === 'VERIFIED' && events.slice(-4).map((event) => event.gate).join(',') !== 'platform,publicCI,release,git') throw new Error('VERIFIED requires complete fresh terminal observations');
}
function recordObservation(directory, state, gate, data, now) {
  state.observations.attempts.at(-1).events.push({ gate, observedAt: now(), data });
  saveState(directory, state, state.phase);
}
function durableObject(file, bytes) {
  if (fs.existsSync(file)) {
    if (!privateFile(file, null, LIMIT).equals(bytes)) throw new Error('incomplete preparation contains different frozen object bytes');
  } else durableFile(file, bytes);
}
function verifyConsumerSignature(snapshotDir, snapshot, rawTag, manifest, scratch, operation) {
  return withPublicGpgContext(privateFile(path.join(snapshotDir, 'source-signing-public-key.asc')), (home) => {
    verifyRawSourceTag(rawTag, manifest, { fingerprint: snapshot.fingerprint, revokedKeys: snapshot.revokedKeys, gpgHome: home, scratch });
    return operation({ ...gitEnvironment(), GNUPGHOME: home, PUBLIC_RELEASE_FORBIDDEN_HOSTS: snapshot.forbiddenHosts });
  });
}
export function restorePublication(directory, repoRoot) {
  const files = stateFiles(directory); const state = readPrivateJson(files.state);
  if (state.schema !== 'punchpilot-publication-state') throw new Error('persisted publication state is invalid');
  assertSavedObservations(state);
  const commit = privateFile(files.commit), tag = privateFile(files.tag), bundle = privateFile(files.bundle, null, LIMIT);
  if (digest(bundle) !== state.bundleSha256 || digest(commit) !== state.commitSha256 || digest(tag) !== state.tagSha256 ||
      gitObjectId('commit', commit) !== state.commitId || gitObjectId('tag', tag) !== state.tagId) throw new Error('persisted actual publication objects were corrupted');
  if (fs.existsSync(repoRoot)) throw new Error('bundle resume requires a fresh consumer store');
  fs.mkdirSync(repoRoot, { mode: 0o700 }); gitText(repoRoot, ['init', '--bare', '-q']);
  gitText(repoRoot, ['bundle', 'verify', files.bundle]);
  const heads = gitText(repoRoot, ['bundle', 'list-heads', files.bundle]).split('\n').sort();
  const expected = [`${state.commitId} ${state.publicationRef}`, `${state.tagId} ${state.tagRef}`].sort();
  if (JSON.stringify(heads) !== JSON.stringify(expected)) throw new Error('persisted bundle contains extra refs');
  gitText(repoRoot, ['fetch', '--no-tags', '--', files.bundle, `${state.publicationRef}:${state.publicationRef}`, `${state.tagRef}:${state.tagRef}`]);
  if (!gitBytes(repoRoot, ['cat-file', 'commit', state.commitId]).equals(commit) || !gitBytes(repoRoot, ['cat-file', 'tag', state.tagId]).equals(tag)) throw new Error('bundle reload did not retain exact objects');
  return state;
}
export function preparePublication({ snapshotDir, stateDir, repoRoot }) {
  if (Object.keys(process.env).some((key) => /^(?:GITEA_|PUNCHPILOT_SOURCE_|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_OBJECT_DIRECTORY$)/.test(key))) throw new Error('consumer cannot inherit internal credentials or object storage');
  const snapshot = readConsumerSnapshot(snapshotDir);
  publicDestination(snapshot.publicUrl);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); privateDirectory(stateDir);
  const files = stateFiles(stateDir);
  let state;
  if (fs.existsSync(files.state)) {
    state = restorePublication(stateDir, repoRoot);
    if (state.artifactSha256 !== snapshot.artifactSha256 || state.policyHash !== snapshot.policyHash) throw new Error('same-version resume cannot change admitted artifact or policy');
  } else {
    const verified = validateArtifact({ artifactDir: path.join(snapshotDir, 'artifact'), snapshot, repoRoot });
    const manifest = verified.manifest;
    const before = remoteReadback(repoRoot, snapshot.publicUrl, manifest.version);
    if (before.main !== manifest.publicBase || before.tag) throw new Error('KI1 public base/tag changed before candidate preparation');
    gitText(repoRoot, ['fetch', '--no-tags', '--', snapshot.publicUrl, `${manifest.publicBase}:refs/punchpilot/public-base`]);
    const objects = canonicalObjects(manifest);
    if (gitText(repoRoot, ['hash-object', '-t', 'commit', '-w', '--stdin'], objects.commit) !== objects.commitId ||
        gitText(repoRoot, ['hash-object', '-t', 'tag', '-w', '--stdin'], objects.tag) !== objects.tagId) throw new Error('canonical object write mismatch');
    const publicationRef = `refs/punchpilot/publications/${manifest.version}`;
    const tagRef = `refs/punchpilot/public-tags/${manifest.version}`;
    gitText(repoRoot, ['update-ref', publicationRef, objects.commitId]); gitText(repoRoot, ['update-ref', tagRef, objects.tagId]);
    const provenance = path.join(stateDir, 'provenance.json'); durableObject(provenance, jsonBytes(manifest.provenance));
    const environment = { ...gitEnvironment(), PUBLIC_RELEASE_FORBIDDEN_HOSTS: snapshot.forbiddenHosts };
    verifyConsumerSignature(snapshotDir, snapshot, verified.rawTag, manifest, stateDir, (signingEnvironment) => {
    executeGate(path.join(snapshotDir, 'public-release-privacy-gate.py'), ['--root', repoRoot, '--repo-name', 'public', '--commit-envelope', objects.commitId, '--tree', manifest.exportedTree,
      '--tag-envelope', objects.tagId, '--tag-envelope-file', path.join(snapshotDir, 'artifact/source-tag.raw'), '--allowlist-pathset', provenance, '--require-forbidden-hosts', '--fail-on-warn'], repoRoot, signingEnvironment);
    // Public ancestry is scanned separately; no source history is imported.
    scanPublicAncestry(snapshotDir, repoRoot, manifest.publicBase, signingEnvironment);
    });
    const workParent = fs.mkdtempSync(path.join(stateDir, 'metadata-')); fs.chmodSync(workParent, 0o700);
    const work = path.join(workParent, 'tree'); let changelog;
    try {
      materialize(repoRoot, manifest.exportedTree, work);
      executeGate(path.join(snapshotDir, 'release-metadata-check.mjs'), ['--tag', manifest.version, '--mode', 'public'], work, environment);
      changelog = fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8');
    } finally { fs.rmSync(workParent, { recursive: true, force: true }); }
    const releaseBody = releaseBodyFromChangelog(changelog, manifest.version);
    state = { ...manifest, schema: 'punchpilot-publication-state', artifactSha256: snapshot.artifactSha256,
      commitId: objects.commitId, tagId: objects.tagId, publicationRef, tagRef,
      commitSha256: digest(objects.commit), tagSha256: digest(objects.tag), releaseBody, phase: 'PREPARED',
      changedWorkflows: workflowChanges(repoRoot, manifest.publicBase, manifest.exportedTree) };
    durableObject(files.commit, objects.commit); durableObject(files.tag, objects.tag);
    let bundle;
    if (fs.existsSync(files.bundle)) bundle = privateFile(files.bundle, null, LIMIT);
    else {
      const bundleParent = fs.mkdtempSync(path.join(stateDir, 'bundle-')); fs.chmodSync(bundleParent, 0o700);
      try {
        const bundleTemporary = path.join(bundleParent, 'publication.bundle');
        gitText(repoRoot, ['bundle', 'create', bundleTemporary, publicationRef, tagRef]); fs.chmodSync(bundleTemporary, 0o600);
        bundle = privateFile(bundleTemporary, null, LIMIT); durableFile(files.bundle, bundle);
      } finally { fs.rmSync(bundleParent, { recursive: true, force: true }); }
    }
    state.bundleSha256 = digest(bundle);
    state.observations = { candidateSha256: candidateObservationDigest(state), attempts: [] };
    state.observationsSha256 = digest(jsonBytes(state.observations));
    durableFile(files.state, jsonBytes(state));
    // A crash may have saved the complete bundle before the state marker.
    // Reload the actual saved bytes and prove their closure before any write.
    const recovery = path.join(stateDir, `preparation-readback-${process.pid}`);
    try { restorePublication(stateDir, recovery); validateConsumerPublication({ snapshotDir, stateDir, repoRoot: recovery }); }
    finally { fs.rmSync(recovery, { recursive: true, force: true }); }
  }
  if (!state.observations.attempts.length) {
    state.admissionSha256 = snapshot.admissionSha256;
    state.reviewedEntrySha256 = snapshot.reviewedEntrySha256;
  }
  durableFile(files.state, jsonBytes(state), true);
  gitText(repoRoot, ['config', '--local', 'core.hooksPath', snapshotDir]);
  gitText(repoRoot, ['config', '--local', 'punchpilot.publicationState', stateDir]);
  consumerPreflight({ snapshotDir, stateDir, repoRoot });
  return { state, snapshot };
}
export function validateConsumerPublication({ snapshotDir, stateDir, repoRoot }) {
  const snapshot = readConsumerSnapshot(snapshotDir);
  const state = readPrivateJson(stateFiles(stateDir).state);
  if (state.schema !== 'punchpilot-publication-state' || Object.keys(snapshot.manifest).some((key) => key !== 'schema' &&
      JSON.stringify(state[key]) !== JSON.stringify(snapshot.manifest[key]))) throw new Error('persisted immutable publication tuple differs from the admitted artifact');
  assertSavedObservations(state);
  if (state.artifactSha256 !== snapshot.artifactSha256 || state.policyHash !== snapshot.policyHash ||
      digest(privateFile(path.join(snapshotDir, 'artifact/manifest.json'))) !== snapshot.artifactSha256) throw new Error('consumer artifact/state binding mismatch');
  const canonical = canonicalObjects(state);
  if (canonical.commitId !== state.commitId || canonical.tagId !== state.tagId ||
      !gitBytes(repoRoot, ['cat-file', 'commit', state.commitId]).equals(canonical.commit) ||
      !gitBytes(repoRoot, ['cat-file', 'tag', state.tagId]).equals(canonical.tag)) throw new Error('consumer canonical objects mismatch');
  if (gitText(repoRoot, ['rev-list', state.commitId, `^${state.publicBase}`]) !== state.commitId ||
      gitText(repoRoot, ['cat-file', '-t', state.publicBase]) !== 'commit') throw new Error('publication ancestry must introduce exactly P relative to B');
  const sourcePresent = spawnSync('git', ['--no-replace-objects', 'cat-file', '-e', state.sourceCommit], { cwd: repoRoot, env: gitEnvironment(), stdio: 'ignore' });
  if (sourcePresent.status === 0 || gitText(repoRoot, ['remote']) || fs.existsSync(path.join(repoRoot, 'objects/info/alternates')) ||
      gitText(repoRoot, ['for-each-ref', 'refs/replace/'])) throw new Error('consumer cannot contain source objects, remotes, alternates, or replacement refs');
  const expected = gitText(repoRoot, ['rev-list', '--objects', state.commitId, state.tagId]).split('\n').map((line) => line.split(' ')[0]).sort();
  const actual = gitText(repoRoot, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n').sort();
  if (JSON.stringify([...new Set(expected)]) !== JSON.stringify(actual)) throw new Error('consumer object database contains extra objects beyond E/public B/P/tag');
  const rawTag = privateFile(path.join(snapshotDir, 'artifact/source-tag.raw'));
  if (digest(rawTag) !== state.sourceTagSha256) throw new Error('consumer source tag digest mismatch');
  const environment = { ...gitEnvironment(), PUBLIC_RELEASE_FORBIDDEN_HOSTS: snapshot.forbiddenHosts };
  verifyConsumerSignature(snapshotDir, snapshot, rawTag, state, stateDir, (signingEnvironment) => {
  executeGate(path.join(snapshotDir, 'public-release-privacy-gate.py'), ['--root', repoRoot, '--repo-name', 'public', '--commit-envelope', state.commitId,
    '--tree', state.exportedTree, '--tag-envelope', state.tagId, '--tag-envelope-file', path.join(snapshotDir, 'artifact/source-tag.raw'),
    '--allowlist-pathset', path.join(stateDir, 'provenance.json'), '--require-forbidden-hosts', '--fail-on-warn'], repoRoot, signingEnvironment);
  scanPublicAncestry(snapshotDir, repoRoot, state.publicBase, signingEnvironment);
  });
  const work = path.join(stateDir, `metadata-check-${process.pid}`);
  try {
    materialize(repoRoot, state.exportedTree, work);
    executeGate(path.join(snapshotDir, 'release-metadata-check.mjs'), ['--tag', state.version, '--mode', 'public'], work, environment);
    if (releaseBodyFromChangelog(fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8'), state.version) !== state.releaseBody) throw new Error('persisted Release body differs from the reviewed export');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return state;
}
function consumerPreflight({ snapshotDir, stateDir, repoRoot }) {
  executeGate(path.join(snapshotDir, 'publication-preflight.mjs'),
    ['--mode', 'consumer', '--consumer-snapshot', snapshotDir, '--state', stateDir], repoRoot, gitEnvironment());
}
function saveState(directory, state, phase) {
  state.phase = phase; state.observationsSha256 = digest(jsonBytes(state.observations));
  assertSavedObservations(state);
  const bytes = jsonBytes(state);
  if (bytes.length > ENVELOPE_LIMIT) throw new Error('publication observations exceed the bounded state store; preserve the existing evidence');
  durableFile(stateFiles(directory).state, bytes, true);
}
export function assertPushUpdates({ root, remoteUrl, state, input }) {
  const remote = remoteReadback(root, remoteUrl, state.version); validateRemote(state, remote);
  const allowed = new Map([
    ['refs/heads/main', { ref: state.publicationRef, oid: state.commitId, remote: remote.main }],
    [`refs/tags/${state.version}`, { ref: state.tagRef, oid: state.tagId, remote: remote.tag }],
  ]);
  const updates = input.split('\n').filter(Boolean);
  const seen = new Set();
  if (updates.length > 2) throw new Error('only exactly two reviewed main/tag destinations are allowed');
  for (const line of updates) {
    const fields = line.split(' ');
    if (fields.length !== 4) throw new Error('push update is malformed');
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    const expected = allowed.get(remoteRef);
    if (!expected || seen.has(remoteRef) || localRef !== expected.ref || localOid !== expected.oid ||
        remoteOid !== (expected.remote || '0'.repeat(40))) throw new Error('push update is outside the reviewed canonical main/tag pair');
    seen.add(remoteRef);
  }
  for (const [destination, expected] of allowed) {
    if (!seen.has(destination) && expected.remote !== expected.oid) throw new Error('omitted push leg is not an independently verified same-object no-op');
  }
}
export function githubRequest({ method = 'GET', endpoint, readToken = process.env.PUNCHPILOT_PUBLICATION_READ_TOKEN, token, body, request = https.request }) {
  return new Promise((resolve, reject) => {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/repos/sky-zhang01/punchpilot/') || /[\s\\#\0-\x1f\x7f]/.test(endpoint) || endpoint.includes('..')) { reject(new Error('public API endpoint is outside the fixed repository')); return; }
    const validToken = (value) => typeof value === 'string' && value.length > 0 && !/[^\x21-\x7e]/.test(value);
    if (method === 'GET') {
      if (!validToken(readToken) || token !== undefined || body !== undefined) { reject(new Error('public API requires the independent read observer channel')); return; }
    } else if (method !== 'POST' || endpoint !== '/repos/sky-zhang01/punchpilot/releases' || !validToken(token)) {
      reject(new Error('public API write is restricted to the sole Release POST with an explicit writer token')); return;
    }
    const bytes = body === undefined ? null : jsonBytes(body);
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'punchpilot-isolated-publisher' };
    headers.Authorization = `Bearer ${method === 'GET' ? readToken : token}`;
    if (bytes) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = bytes.length; }
    const outgoing = request({ protocol: 'https:', hostname: 'api.github.com', port: 443, method, path: endpoint, headers }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > ENVELOPE_LIMIT) outgoing.destroy(new Error('public API response exceeded limit')); else chunks.push(chunk); });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null, headers: { link: response.headers?.link || '' } }); }
        catch { reject(new Error('public API response is invalid JSON')); }
      });
      response.on('error', reject);
    });
    outgoing.setTimeout(30000, () => outgoing.destroy(new Error('public API timeout'))); outgoing.on('error', reject);
    outgoing.end(bytes || undefined);
  });
}
export async function publicCIGate(api, commitId) {
  const response = await api({ endpoint: `/repos/sky-zhang01/punchpilot/actions/workflows/ci.yml/runs?event=push&head_sha=${commitId}&per_page=100` });
  if (response.status !== 200 || !Array.isArray(response.body?.workflow_runs)) throw new Error('public CI authority is unknown');
  const runs = response.body.workflow_runs.filter((run) => run.head_sha === commitId && run.head_branch === 'main' && run.event === 'push');
  if (runs.some((run) => !['id', 'run_number', 'run_attempt'].every((field) => Number.isSafeInteger(run[field]) && run[field] > 0))) throw new Error('exact-P public CI ordering identity is invalid');
  runs.sort((a, b) => (b.run_number - a.run_number) || (b.run_attempt - a.run_attempt) || (b.id - a.id));
  if (!runs[0] || runs[0].status !== 'completed' || runs[0].conclusion !== 'success') throw new Error('latest exact-P public CI is not successful; immutable tags require a forward fix with new S/version');
  return Object.fromEntries(ciObservationFields.map((key) => [key, runs[0][key]]));
}
export async function verifyLivePlatform(api, admission) {
  const platform = admission.receipts.platform;
  const records = [
    ...platform.rulesets.map((record) => [`/repos/sky-zhang01/punchpilot/rulesets/${record.id}`, 'ruleset', record]),
    ['/repos/sky-zhang01/punchpilot/environments/public-release', 'environment', platform.environment],
    ['/repos/sky-zhang01/punchpilot/environments/public-release/deployment-branch-policies', 'branchPolicies', platform.branchPolicies],
  ];
  const observed = [];
  for (const [endpoint, kind, expected] of records) {
    const current = await api({ endpoint });
    try {
      if (current.status !== 200 || current.headers?.link) throw new Error('incomplete platform response');
      const projected = (body) => platformProtection(kind, kind === 'branchPolicies' ? body?.branch_policies : body);
      if (kind === 'branchPolicies' && Object.hasOwn(current.body || {}, 'total_count') && current.body.total_count !== current.body.branch_policies?.length) throw new Error('incomplete platform policies');
      const expectedSha256 = digest(jsonBytes(projected(expected))), bodySha256 = digest(jsonBytes(projected(current.body)));
      if (bodySha256 !== expectedSha256) throw new Error('platform drift');
      // The persisted digest covers protection semantics, never raw response
      // metadata, observer secrets or user-dependent capability fields.
      observed.push({ endpoint, bodySha256 });
    } catch { throw new Error('live platform protection changed or is unavailable; external admission is no longer valid'); }
  }
  return observed;
}
export async function publicWriteAuthority({ root, commitId, admissionFile, admissionSha256, runId, runAttempt, api = githubRequest, now = Math.floor(Date.now() / 1000) }) {
  const admission = readPrivateJson(admissionFile, fs.realpathSync(root));
  const objects = canonicalObjects(admission);
  if (objects.commitId !== commitId || gitText(root, ['rev-parse', 'HEAD^{commit}']) !== commitId ||
      !gitBytes(root, ['cat-file', 'commit', commitId]).equals(objects.commit)) throw new Error('public writer must consume the exact canonical approved P');
  if (gitText(root, ['remote']).split('\n').filter(Boolean).some((name) => name !== 'origin') ||
      !['https://github.com/sky-zhang01/punchpilot', 'https://github.com/sky-zhang01/punchpilot.git'].includes(gitText(root, ['remote', 'get-url', 'origin']))) throw new Error('public writer checkout must contain only the approved public origin');
  try { gitText(root, ['cat-file', '-t', admission.publicBase]); }
  catch { gitText(root, ['fetch', '--no-tags', '--', 'origin', admission.publicBase]); }
  const tuple = { ...admission, admissionSha256, reviewedEntrySha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))) };
  assertAdmission(admission, tuple, now, workflowChanges(root, admission.publicBase, admission.exportedTree));
  await verifyLivePlatform(api, admission);
  const refs = [
    ['/repos/sky-zhang01/punchpilot/git/ref/heads/main', 'commit', commitId],
    [`/repos/sky-zhang01/punchpilot/git/ref/tags/${admission.version}`, 'tag', objects.tagId],
  ];
  for (const [endpoint, type, sha] of refs) {
    const ref = await api({ endpoint });
    if (ref.status !== 200 || ref.body?.object?.type !== type || ref.body.object.sha !== sha) throw new Error('public main/tag no longer match the approved publication');
  }
  await publicCIGate(api, commitId);
  if (![runId, runAttempt].every((value) => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value)))) throw new Error('public writer must bind the current run and attempt');
  const runs = await api({ endpoint: `/repos/sky-zhang01/punchpilot/actions/workflows/docker-publish.yml/runs?event=push&head_sha=${commitId}&per_page=100` });
  const run = runs.body?.workflow_runs?.find((run) => run.id === Number(runId));
  if (runs.status !== 200 || !run || run.head_sha !== commitId || run.head_branch !== admission.version || run.event !== 'push' || run.run_attempt !== Number(runAttempt) ||
      run.actor?.login !== 'punchpilot-release-bot[bot]' || !['punchpilot-release-bot[bot]', 'sky-zhang01'].includes(run.triggering_actor?.login) ||
      !['queued', 'in_progress'].includes(run.status)) throw new Error('public writer is not the exact named-bot run/attempt');
  const reviews = await api({ endpoint: `/repos/sky-zhang01/punchpilot/actions/runs/${runId}/approvals` });
  if (reviews.status !== 200 || !Array.isArray(reviews.body) || !reviews.body.some((review) => review.state === 'approved' &&
      review.user?.login === 'sky-zhang01' && review.environments?.some((environment) => environment.name === 'public-release'))) throw new Error('the owner has not approved this actual public-release workflow run');
  return tuple;
}
function exactRelease(release, state) {
  return release && Number.isSafeInteger(release.id) && release.id > 0 && release.tag_name === state.version &&
    release.target_commitish === state.commitId && release.name === state.version && release.body === state.releaseBody &&
    release.draft === false && release.prerelease === false && Array.isArray(release.assets) && release.assets.length === 0;
}
export function localPublicationAPI({ snapshotDir, stateDir }) {
  const snapshot = readConsumerSnapshot(snapshotDir);
  if (publicDestination(snapshot.publicUrl) !== 'local') throw new Error('publication rehearsal requires an existing local bare fixture');
  const receipt = readPrivateJson(path.join(snapshotDir, 'admission.json'));
  const platform = receipt.receipts.platform;
  const records = new Map([
    ...platform.rulesets.map((record) => [`/repos/sky-zhang01/punchpilot/rulesets/${record.id}`, record]),
    ['/repos/sky-zhang01/punchpilot/environments/public-release', platform.environment],
    ['/repos/sky-zhang01/punchpilot/environments/public-release/deployment-branch-policies', platform.branchPolicies],
  ]);
  const releaseFile = path.join(stateDir, 'rehearsal-release.json');
  return async ({ endpoint, method = 'GET', body }) => {
    if (method === 'GET' && records.has(endpoint)) return { status: 200, body: records.get(endpoint) };
    const state = readPrivateJson(stateFiles(stateDir).state);
    const remote = remoteReadback(stateDir, snapshot.publicUrl, state.version);
    if (remote.main !== state.commitId || remote.tag !== state.tagId || remote.peeled !== state.commitId) throw new Error('local fixture refs are incomplete');
    if (method === 'GET' && endpoint === `/repos/sky-zhang01/punchpilot/actions/workflows/ci.yml/runs?event=push&head_sha=${state.commitId}&per_page=100`) {
      return { status: 200, body: { workflow_runs: [{ id: 1, run_number: 1, run_attempt: 1, head_sha: state.commitId, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] } };
    }
    if (method === 'GET' && endpoint === `/repos/sky-zhang01/punchpilot/releases/tags/${state.version}`) {
      return fs.existsSync(releaseFile) ? { status: 200, body: readPrivateJson(releaseFile) } : { status: 404, body: null };
    }
    if (method === 'POST' && endpoint === '/repos/sky-zhang01/punchpilot/releases') {
      if (fs.existsSync(releaseFile)) return { status: 422, body: null };
      durableFile(releaseFile, jsonBytes({ ...body, id: 1, assets: [] }));
      return { status: 202, body: { accepted: true } };
    }
    throw new Error('local rehearsal cannot access any other public API');
  };
}
export async function publishPrepared({ snapshotDir, stateDir, repoRoot, admissionFile, api = githubRequest, tokenProvider, now = () => Math.floor(Date.now() / 1000), push = null }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const installedAdmission = path.join(snapshotDir, 'admission.json');
  if (admissionFile && fs.realpathSync(admissionFile) !== fs.realpathSync(installedAdmission)) throw new Error('publisher and hook must use the same independently installed admission file');
  return withPublicationLock(stateDir, async () => {
    const { state, snapshot } = preparePublication({ snapshotDir, stateDir, repoRoot });
    const kind = publicDestination(snapshot.publicUrl);
    state.admissionSha256 = snapshot.admissionSha256;
    state.reviewedEntrySha256 = snapshot.reviewedEntrySha256;
    state.observations.attempts.push({ number: state.observations.attempts.length + 1, startedAt: now(),
      admissionSha256: snapshot.admissionSha256, reviewedEntrySha256: snapshot.reviewedEntrySha256, events: [] });
    // Saved observations explain prior attempts; a new attempt obtains fresh
    // authority and cannot retain VERIFIED while its live checks are incomplete.
    saveState(stateDir, state, 'PREPARED');
    const admission = async () => {
      const approved = readPrivateJson(installedAdmission, repoRoot);
      assertAdmission(approved, state, now(), state.changedWorkflows);
      recordObservation(stateDir, state, 'platform', await verifyLivePlatform(api, approved), now);
      return approved;
    };
    const observeRemote = () => {
      const current = remoteReadback(repoRoot, snapshot.publicUrl, state.version); validateRemote(state, current);
      recordObservation(stateDir, state, 'remote', current, now); return current;
    };
    const observeCI = async () => {
      recordObservation(stateDir, state, 'publicCI', await publicCIGate(api, state.commitId), now);
    };
    await admission();
    let remote = observeRemote();
    const refspecs = [`${state.publicationRef}:refs/heads/main`, `${state.tagRef}:refs/tags/${state.version}`];
    // Every write uses the same saved objects and two explicit refspecs, even
    // when Git omits a no-op leg from the pre-push stdin update set.
    if (remote.main !== state.commitId || remote.tag !== state.tagId) {
      await admission();
      assertHeldLock();
      const performPush = async (token) => {
        try {
          if (push) await push({ root: repoRoot, url: snapshot.publicUrl, refspecs, atomic: true, token });
          else {
            const env = gitEnvironment();
            if (token) { env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'; env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`; }
            gitBytes(repoRoot, ['-c', 'push.followTags=false', 'push', '--atomic', '--', snapshot.publicUrl, ...refspecs], undefined, env);
          }
        } catch (error) {
          remote = observeRemote();
          if (remote.main !== state.commitId || remote.tag !== state.tagId) { saveState(stateDir, state, remote.main === state.commitId ? 'MAIN_PRESENT' : 'PREPARED'); throw error; }
        }
      };
      if (kind === 'github') {
        if (typeof tokenProvider !== 'function') throw new Error('reviewed public token provider is required');
        await tokenProvider({ state, admissionFile: installedAdmission, repoRoot }, performPush);
      } else {
        await performPush();
      }
    }
    remote = observeRemote();
    if (remote.main !== state.commitId || remote.tag !== state.tagId || remote.peeled !== state.commitId) throw new Error('remote main/tag terminal readback is incomplete');
    saveState(stateDir, state, 'TAG_PRESENT');
    await observeCI();
    await admission();
    const releasePath = `/repos/sky-zhang01/punchpilot/releases/tags/${state.version}`;
    let release = await api({ endpoint: releasePath });
    if (release.status === 404) {
      let creationError, definitiveRejection = false;
      if (!state.releaseRequested) {
        // Persist intent before the sole Release write. A crash/lost response
        // resumes by reading the terminal object, without a second blind POST.
        await admission(); await observeCI();
        assertHeldLock();
        const requestRelease = async (token) => {
          state.releaseRequested = true; saveState(stateDir, state, 'RELEASE_REQUESTED');
          try {
            const created = await api({ method: 'POST', endpoint: '/repos/sky-zhang01/punchpilot/releases', token,
              body: { tag_name: state.version, target_commitish: state.commitId, name: state.version, body: state.releaseBody, draft: false, prerelease: false } });
            if (![200, 201, 202].includes(created.status)) {
              creationError = new Error('Release creation was rejected');
              definitiveRejection = [400, 401, 403, 404].includes(created.status);
            }
          } catch (error) { creationError = error; }
        };
        if (kind === 'github') {
          if (typeof tokenProvider !== 'function') throw new Error('reviewed public token provider is required');
          await tokenProvider({ state, admissionFile: installedAdmission, repoRoot }, requestRelease);
        } else {
          await requestRelease();
        }
      }
      if (definitiveRejection) {
        release = await api({ endpoint: releasePath });
        if (release.status === 404) { state.releaseRequested = false; saveState(stateDir, state, 'TAG_PRESENT'); throw creationError; }
      }
      saveState(stateDir, state, 'RELEASE_REQUESTED');
      // A lost response cannot distinguish rejection from a completed remote
      // write. Read the exact immutable result before permitting a retry.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        release = await api({ endpoint: releasePath });
        if (release.status === 200) break;
        if (release.status !== 404) throw new Error('Release terminal readback is unknown');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (creationError && release.status !== 200) {
        if (definitiveRejection) { state.releaseRequested = false; saveState(stateDir, state, 'TAG_PRESENT'); }
        throw creationError;
      }
      if (release.status !== 200) throw new Error('previous Release write remains unknown; preserve frozen state and retry terminal readback');
    }
    if (release.status !== 200 || !exactRelease(release.body, state)) throw new Error('Release terminal readback does not match the frozen publication; refusing overwrite');
    const releaseId = release.body.id;
    await admission(); await observeCI();
    release = await api({ endpoint: releasePath });
    if (release.status !== 200 || !exactRelease(release.body, state) || release.body.id !== releaseId) throw new Error('fresh Release terminal identity/readback changed');
    recordObservation(stateDir, state, 'release', { id: release.body.id, tag_name: release.body.tag_name,
      target_commitish: release.body.target_commitish, name: release.body.name, bodySha256: digest(release.body.body),
      draft: release.body.draft, prerelease: release.body.prerelease, assetCount: release.body.assets.length }, now);
    const readback = path.join(stateDir, `readback-${process.pid}`);
    try {
      fs.mkdirSync(readback, { mode: 0o700 }); gitText(readback, ['init', '--bare', '-q']);
      gitText(readback, ['fetch', '--no-tags', '--', snapshot.publicUrl, 'refs/heads/main:refs/heads/main', `refs/tags/${state.version}:refs/tags/${state.version}`]);
      gitText(readback, ['fsck', '--full', '--no-reflogs']);
      if (gitText(readback, ['rev-parse', 'refs/heads/main']) !== state.commitId ||
          gitText(readback, ['rev-parse', `refs/tags/${state.version}`]) !== state.tagId ||
          gitText(readback, ['rev-parse', `refs/tags/${state.version}^{}`]) !== state.commitId ||
          gitText(readback, ['rev-parse', 'refs/heads/main^{tree}']) !== state.exportedTree ||
          !gitBytes(readback, ['cat-file', 'commit', state.commitId]).equals(privateFile(stateFiles(stateDir).commit)) ||
          !gitBytes(readback, ['cat-file', 'tag', state.tagId]).equals(privateFile(stateFiles(stateDir).tag))) throw new Error('fresh network Git terminal readback differs from frozen objects');
      if (JSON.stringify(treeEntries(readback, state.exportedTree)) !== JSON.stringify(treeEntries(repoRoot, state.exportedTree))) throw new Error('network tree bytes/modes differ');
      recordObservation(stateDir, state, 'git', { main: gitText(readback, ['rev-parse', 'refs/heads/main']),
        tag: gitText(readback, ['rev-parse', `refs/tags/${state.version}`]), peeled: gitText(readback, ['rev-parse', `refs/tags/${state.version}^{}`]),
        tree: gitText(readback, ['rev-parse', 'refs/heads/main^{tree}']),
        commitSha256: digest(gitBytes(readback, ['cat-file', 'commit', state.commitId])), tagSha256: digest(gitBytes(readback, ['cat-file', 'tag', state.tagId])) }, now);
    } finally { fs.rmSync(readback, { recursive: true, force: true }); }
    saveState(stateDir, state, 'VERIFIED');
    return state;
  });
}

async function main(argv) {
  const command = argv.shift(); const values = new Map();
  const options = { hook: ['--remote-url'], 'public-authority': ['--commit', '--admission', '--admission-sha256'],
    produce: ['--policy', '--artifact'], install: ['--policy', '--artifact', '--target'],
    publish: ['--policy', '--state', '--snapshot'], rehearse: ['--state', '--snapshot'] };
  if (!Object.hasOwn(options, command)) throw new Error('unknown publisher command');
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!options[command].includes(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('invalid publisher arguments');
    values.set(name, value);
  }
  if (command === 'hook') {
    const snapshotDir = path.dirname(fileURLToPath(import.meta.url));
    const stateDir = gitText(process.cwd(), ['config', '--get', 'punchpilot.publicationState']);
    const state = readPrivateJson(stateFiles(stateDir).state);
    const snapshot = readConsumerSnapshot(snapshotDir);
    if (values.get('--remote-url') !== snapshot.publicUrl) throw new Error('push destination differs from installed policy');
    assertAdmission(readPrivateJson(path.join(snapshotDir, 'admission.json'), process.cwd()), state, Math.floor(Date.now() / 1000), state.changedWorkflows);
    consumerPreflight({ snapshotDir, stateDir, repoRoot: process.cwd() });
    assertPushUpdates({ root: process.cwd(), remoteUrl: snapshot.publicUrl, state, input: fs.readFileSync(0, 'utf8') });
    return;
  }
  if (command === 'public-authority') {
    await publicWriteAuthority({ root: process.cwd(), commitId: values.get('--commit') || process.env.PUBLICATION_COMMIT,
      admissionFile: values.get('--admission') || process.env.PUBLICATION_ADMISSION_FILE,
      admissionSha256: values.get('--admission-sha256') || process.env.PUBLICATION_ADMISSION_SHA256,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
    return;
  }
  if (command === 'rehearse') {
    const stateDir = values.get('--state'), snapshotDir = values.get('--snapshot');
    if (!stateDir || !snapshotDir) throw new Error('rehearsal requires --state and --snapshot');
    const api = localPublicationAPI({ snapshotDir, stateDir });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const repoRoot = path.join(stateDir, `consumer-${process.pid}`);
    try { await publishPrepared({ stateDir, snapshotDir, repoRoot, api }); }
    finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    return;
  }
  const policyFile = values.get('--policy');
  if (!policyFile) throw new Error('private external --policy is required');
  const policy = readPrivateJson(policyFile, process.cwd());
  if (command === 'produce') {
    createPublicationArtifact({ ...policy, repoRoot: process.cwd(), artifactDir: values.get('--artifact') });
  } else if (command === 'install') {
    installArtifact({ ...policy, repoRoot: process.cwd(), artifactDir: values.get('--artifact'), target: values.get('--target') });
  } else if (command === 'publish') {
    const stateDir = values.get('--state'), snapshotDir = values.get('--snapshot');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const repoRoot = path.join(stateDir, `consumer-${process.pid}`);
    try {
      await publishPrepared({ stateDir, snapshotDir, repoRoot, admissionFile: policyFile,
        tokenProvider: async ({ state, admissionFile, repoRoot: consumer }, operation) => {
          const { withAppToken } = await import('./mint-app-token.mjs');
          return withAppToken({ admissionFile, publication: state, publicationRoot: consumer }, operation);
        } });
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  } else throw new Error('publisher command must be produce, install, publish, or hook');
}
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => { console.error(`[FAIL] ${error.message}`); process.exitCode = 1; });
}
