import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BOT_NAME = 'punchpilot-release-bot[bot]';
export const BOT_EMAIL = '4366822+punchpilot-release-bot[bot]@users.noreply.github.com';
export const OID = /^[0-9a-f]{40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const VERSION = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
export const FINGERPRINT = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/;
export const LIMIT = 64 * 1024 * 1024;
export const ENVELOPE_LIMIT = 1024 * 1024;
export const PROVENANCE_SCHEMA = 'public-export-provenance/v1';
export const PROVENANCE_GENERATOR = 'scripts/ci/export-public-tree.mjs';
export const PROVENANCE_KEYS = new Set(['schema', 'generator', 'sourceCommit', 'sourceTree', 'exportedTree', 'policyVersion', 'policyHash', 'pathsetSha256', 'pathset', 'excludedPaths', 'intendedPublicBase']);
export const PGP_BEGIN = Buffer.from('-----BEGIN PGP SIGNATURE-----\n');
export const PGP_END = Buffer.from('-----END PGP SIGNATURE-----\n');
const invalidSignatureStatuses = new Set(['BADSIG', 'ERRSIG', 'EXPKEYSIG', 'EXPSIG', 'KEYEXPIRED', 'REVKEYSIG', 'KEYREVOKED', 'SIGEXPIRED', 'NO_PUBKEY', 'NODATA']);
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gitObjectId = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
export const canonicalJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const protectionFields = (object, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(object || {}, key)).map((key) => [key, object[key]]));
const protectionSet = (items) => {
  if (!Array.isArray(items)) throw new Error('platform protection fields are unavailable');
  return [...items].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
};
// API timestamps, links and the observer's own bypass status are not policy.
// Keep complete rule parameters/conditions/bypass entries; missing fields are
// never filled with safe defaults. Governance and publication use this boundary.
export function platformProtection(kind, value) {
  let projection;
  if (kind === 'ruleset') {
    projection = { ...protectionFields(value, ['id', 'target', 'enforcement', 'conditions']),
      bypass_actors: protectionSet(value?.bypass_actors), rules: protectionSet(value?.rules) };
  } else if (kind === 'environment') {
    const reviewer = (rule) => ({ ...protectionFields(rule, ['id', 'type', 'prevent_self_review', 'wait_timer']),
      ...(Object.hasOwn(rule, 'reviewers') ? { reviewers: protectionSet(rule.reviewers.map((entry) => ({
        type: entry.type, reviewer: protectionFields(entry.reviewer, ['id', 'login']),
      }))) } : {}) });
    if (!Array.isArray(value?.protection_rules)) throw new Error('platform protection fields are unavailable');
    projection = { ...protectionFields(value, ['name', 'can_admins_bypass', 'deployment_branch_policy']),
      protection_rules: protectionSet(value.protection_rules.map(reviewer)) };
  } else if (kind === 'branchPolicies') {
    projection = protectionSet(value.map((record) => protectionFields(record, ['id', 'type', 'name'])));
  } else throw new Error('unknown platform protection record');
  return JSON.parse(canonicalJson(projection));
}

export function gitEnvironment(home = process.env.HOME) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/opt/homebrew/bin', HOME: home || '',
    LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
  };
}
export function gitBytes(root, args, input, env = gitEnvironment()) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: root, input, env, maxBuffer: LIMIT, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
export function gitText(root, args, input, env) {
  return gitBytes(root, args, input, env).toString('utf8').trim();
}
export function safePath(value) {
  return typeof value === 'string' && value.length > 0 &&
    !value.startsWith('/') && !value.endsWith('/') && !value.includes('\\') &&
    !/[\0-\x1f\x7f]/.test(value) && Buffer.from(value).toString() === value &&
    value.split('/').every((part) => part && !['.', '..', '.git'].includes(part.toLowerCase()));
}
export function sortedPaths(value, allowEmpty = false) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) &&
    value.every(safePath) && new Set(value).size === value.length &&
    [...value].sort().every((item, index) => item === value[index]);
}
export function validateProvenance(provenance, policyHash) {
  if (!provenance || Array.isArray(provenance) || typeof provenance !== 'object' ||
      Object.keys(provenance).length !== PROVENANCE_KEYS.size ||
      Object.keys(provenance).some((key) => !PROVENANCE_KEYS.has(key)) ||
      provenance.schema !== PROVENANCE_SCHEMA || provenance.generator !== PROVENANCE_GENERATOR || provenance.policyVersion !== 1) {
    throw new Error('export provenance does not match schema v1');
  }
  if (!['sourceCommit', 'sourceTree', 'exportedTree', 'intendedPublicBase'].every((key) => OID.test(provenance[key])) ||
      !SHA256.test(provenance.policyHash) || !SHA256.test(provenance.pathsetSha256)) throw new Error('export provenance contains an invalid digest');
  if (!sortedPaths(provenance.pathset) || !sortedPaths(provenance.excludedPaths, true) ||
      provenance.excludedPaths.some((item) => provenance.pathset.includes(item))) throw new Error('export provenance contains an invalid manifest');
  if (digest(`${provenance.pathset.join('\n')}\n`) !== provenance.pathsetSha256) throw new Error('export provenance manifest digest does not match pathset');
  if (provenance.policyHash !== policyHash) throw new Error('export provenance policy hash does not match expected policy hash');
  return provenance;
}
export function tagMessage(version, sourceCommit, exportedTree) {
  return Buffer.from(`${version}\n\nsource: gitea/${sourceCommit}\nsource-tree: ${exportedTree}\n`);
}
export function canonicalObjects(tuple) {
  const { sourceCommit, exportedTree, publicBase, version, sourceEpoch } = tuple;
  if (![sourceCommit, exportedTree, publicBase].every((value) => OID.test(value)) ||
      !VERSION.test(version) || !Number.isSafeInteger(sourceEpoch) || sourceEpoch < 0) throw new Error('invalid canonical publication binding');
  const identity = `${BOT_NAME} <${BOT_EMAIL}> ${sourceEpoch} +0000`;
  const commit = Buffer.from(`tree ${exportedTree}\nparent ${publicBase}\nauthor ${identity}\ncommitter ${identity}\n\nchore(release): ${version}\n\nsource: gitea/${sourceCommit}\nsource-tree: ${exportedTree}\n`);
  const commitId = gitObjectId('commit', commit);
  const tag = Buffer.concat([Buffer.from(`object ${commitId}\ntype commit\ntag ${version}\ntagger ${identity}\n\n`), tagMessage(version, sourceCommit, exportedTree)]);
  return { commit, commitId, tag, tagId: gitObjectId('tag', tag) };
}
export function parseTagEnvelope(raw, role = 'source') {
  if (!Buffer.isBuffer(raw) || raw.length > ENVELOPE_LIMIT) throw new Error(`${role} tag object exceeds the publication size limit`);
  const split = raw.indexOf(Buffer.from('\n\n'));
  if (split < 0) throw new Error(`${role} tag object is malformed`);
  const header = raw.subarray(0, split);
  const text = header.toString('utf8');
  const lines = text.split('\n');
  if (!Buffer.from(text).equals(header) || /[\0\r]/.test(text) || lines.length !== 4 ||
      !/^object [0-9a-f]{40}$/.test(lines[0]) || lines[1] !== 'type commit' ||
      !lines[2].startsWith('tag ') || !/^tagger .+ <[^<>\n]+> -?[0-9]+ [+-][0-9]{4}$/.test(lines[3])) throw new Error(`${role} tag object is malformed`);
  return { objectId: gitObjectId('tag', raw), target: lines[0].slice(7), name: lines[2].slice(4), tagger: lines[3], body: raw.subarray(split + 2), raw };
}
export function validateTagSignatureEnvelope(tag, message) {
  const offset = tag.body.indexOf(PGP_BEGIN);
  if (offset < 0) throw new Error('source tag must have one OpenPGP signature');
  if (!tag.body.subarray(0, offset).equals(message)) throw new Error('source tag message must exactly match publication provenance');
  const signature = tag.body.subarray(offset);
  if (signature.indexOf(PGP_BEGIN, PGP_BEGIN.length) !== -1 ||
      signature.indexOf(PGP_END) !== signature.length - PGP_END.length ||
      signature.indexOf(PGP_END, signature.indexOf(PGP_END) + PGP_END.length) !== -1 ||
      signature.includes(0) || signature.includes(13)) throw new Error('source tag must have one OpenPGP signature');
  return offset;
}
function verifiedSignatureFingerprints(result) {
  const records = [...`${result.stdout || ''}${result.stderr || ''}`.matchAll(/^\[GNUPG:\] ([A-Z_]+)(?: (.*))?$/gm)]
    .map((match) => ({ status: match[1], fields: match[2] || '' }));
  const valid = records.filter((record) => record.status === 'VALIDSIG');
  if (result.error || result.status !== 0 || records.some((record) => invalidSignatureStatuses.has(record.status)) || valid.length !== 1) throw new Error('source tag signature is not valid');
  const fingerprints = valid[0].fields.split(/\s+/).map((field) => field.toUpperCase()).filter((field) => FINGERPRINT.test(field));
  if (fingerprints.length === 0) throw new Error('source tag signature is not valid');
  return fingerprints;
}
export function validateSignatureStatus(result, expectedFingerprint, revokedKeys = []) {
  const fingerprints = verifiedSignatureFingerprints(result);
  if (fingerprints.at(-1) !== expectedFingerprint) throw new Error('source tag signing key does not match the pinned key');
  if (fingerprints.some((item) => revokedKeys.includes(item))) throw new Error('source tag signing key is revoked');
}
export function withPublicGpgContext(certificates, operation) {
  if (!Buffer.isBuffer(certificates) || !certificates.length || certificates.length > ENVELOPE_LIMIT ||
      !Buffer.from(certificates.toString('ascii'), 'ascii').equals(certificates) ||
      !/^(?:-----BEGIN PGP PUBLIC KEY BLOCK-----\n[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----\n\s*)+$/.test(certificates.toString('ascii')) ||
      certificates.includes(Buffer.from('PRIVATE KEY'))) throw new Error('only bounded armored public certificates may enter the signing context');
  const home = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'pp-public-key-'));
  fs.chmodSync(home, 0o700);
  const environment = { ...gitEnvironment(), GNUPGHOME: home };
  try {
    execFileSync('gpg', ['--no-options', '--homedir', home, '--batch', '--no-auto-key-retrieve', '--import'],
      { input: certificates, env: environment, maxBuffer: ENVELOPE_LIMIT, stdio: ['pipe', 'pipe', 'pipe'] });
    const secrets = execFileSync('gpg', ['--no-options', '--homedir', home, '--batch', '--with-colons', '--list-secret-keys'],
      { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (/^(?:sec|ssb):/m.test(secrets)) throw new Error('public signing context contains private keys');
    const result = operation(home);
    if (result && typeof result.then === 'function') throw new Error('public signing context operation must be synchronous');
    return result;
  } finally {
    const stopped = spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { env: environment, stdio: 'ignore' });
    fs.rmSync(home, { recursive: true, force: true });
    if (stopped.error || stopped.status !== 0 || fs.existsSync(home)) throw new Error('public signing context cleanup failed');
  }
}
export function sourcePublicCertificates(repoRoot, { fingerprint, gpgHome } = {}) {
  const assetFile = path.join(repoRoot, '.public-export/public-signing-keys.asc');
  if (!gpgHome && !fingerprint) return fs.readFileSync(assetFile);
  const asset = fs.existsSync(assetFile) ? fs.readFileSync(assetFile) : Buffer.alloc(0);
  if (!FINGERPRINT.test(fingerprint) || !gpgHome) throw new Error('source signing material admission is required');
  const home = fs.lstatSync(gpgHome);
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid() || home.mode & 0o077) throw new Error('source signing store must be private and process-owned');
  const source = execFileSync('gpg', ['--no-options', '--homedir', gpgHome, '--batch', '--armor', '--export', fingerprint],
    { env: gitEnvironment(), maxBuffer: ENVELOPE_LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!source.length) throw new Error('source tag signing key does not match the pinned key');
  return asset.length ? Buffer.concat([asset, Buffer.from('\n'), source]) : source;
}
export function publicHistorySigningKeys(root, publicBase, gpgHome) {
  const required = new Set();
  for (const commit of gitText(root, ['rev-list', publicBase]).split('\n').filter(Boolean)) {
    const raw = gitBytes(root, ['cat-file', 'commit', commit]);
    const boundary = raw.indexOf(Buffer.from('\n\n'));
    if (boundary < 0) throw new Error('public history commit is malformed');
    const headers = raw.subarray(0, boundary).toString('utf8').split('\n');
    const kept = [], signatures = [];
    for (let index = 0; index < headers.length; index += 1) {
      if (!headers[index].startsWith('gpgsig ')) { kept.push(headers[index]); continue; }
      const signature = [headers[index].slice(7)];
      while (headers[index + 1]?.startsWith(' ')) signature.push(headers[++index].slice(1));
      signatures.push(signature.join('\n') + '\n');
    }
    if (!signatures.length) continue;
    if (signatures.length !== 1) throw new Error('public history has ambiguous signing material');
    if (signatures[0].startsWith('-----BEGIN SSH SIGNATURE-----')) continue;
    if (!signatures[0].startsWith(PGP_BEGIN.toString())) throw new Error('public history signature format is unsupported');
    const check = fs.mkdtempSync(path.join(gpgHome, 'history-check-'));
    try {
      const signature = path.join(check, 'signature'), payload = path.join(check, 'payload');
      fs.writeFileSync(signature, signatures[0], { mode: 0o600 });
      fs.writeFileSync(payload, Buffer.concat([Buffer.from(kept.join('\n') + '\n\n'), raw.subarray(boundary + 2)]), { mode: 0o600 });
      const result = spawnSync('gpg', ['--no-options', '--homedir', gpgHome, '--batch', '--no-autostart', '--no-auto-key-retrieve', '--status-fd', '1', '--verify', signature, payload],
        { env: { ...gitEnvironment(), GNUPGHOME: gpgHome }, encoding: 'utf8', maxBuffer: ENVELOPE_LIMIT });
      required.add(verifiedSignatureFingerprints(result).at(-1));
    } finally { fs.rmSync(check, { recursive: true, force: true }); }
  }
  return [...required].sort();
}
export function verifyRawSourceTag(raw, tuple, { fingerprint, revokedKeys = [], gpgHome, scratch }) {
  if (!FINGERPRINT.test(fingerprint) || !gpgHome || !scratch) throw new Error('source signing material admission is required');
  const home = fs.lstatSync(gpgHome);
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid() || home.mode & 0o077) throw new Error('source signing store must be private and process-owned');
  const tag = parseTagEnvelope(raw);
  if (tag.target !== tuple.sourceCommit || tag.name !== tuple.version) throw new Error('source tag binding mismatch');
  const bodyOffset = raw.indexOf(Buffer.from('\n\n')) + 2;
  const signatureOffset = validateTagSignatureEnvelope(tag, tagMessage(tuple.version, tuple.sourceCommit, tuple.exportedTree));
  const checkDirectory = fs.mkdtempSync(path.join(scratch, 'signature-check-')); fs.chmodSync(checkDirectory, 0o700);
  const payload = path.join(checkDirectory, 'source-tag-payload');
  const signature = path.join(checkDirectory, 'source-tag-signature');
  try {
    fs.writeFileSync(payload, raw.subarray(0, bodyOffset + signatureOffset), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(signature, raw.subarray(bodyOffset + signatureOffset), { mode: 0o600, flag: 'wx' });
    validateSignatureStatus(spawnSync('gpg', ['--no-options', '--homedir', gpgHome, '--batch', '--no-autostart', '--no-auto-key-retrieve', '--status-fd', '1', '--verify', signature, payload],
      { env: { ...gitEnvironment(), GNUPGHOME: gpgHome }, encoding: 'utf8', maxBuffer: ENVELOPE_LIMIT, stdio: ['ignore', 'pipe', 'pipe'] }), fingerprint, revokedKeys);
  } finally {
    fs.rmSync(checkDirectory, { recursive: true, force: true });
  }
  return tag;
}
export function privateFile(file, outsideRoot = null, maximum = ENVELOPE_LIMIT) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maximum) throw new Error('trusted publication file must be private, regular, bounded, and process-owned');
  const resolved = fs.realpathSync(file);
  if (outsideRoot && (resolved === outsideRoot || resolved.startsWith(`${fs.realpathSync(outsideRoot)}${path.sep}`))) throw new Error('trusted publication admission must remain outside the candidate repository');
  return fs.readFileSync(resolved);
}
export function readPrivateJson(file, outsideRoot) {
  const bytes = privateFile(file, outsideRoot);
  const parsed = JSON.parse(bytes);
  if (!jsonBytes(parsed).equals(bytes)) throw new Error('trusted publication JSON must be canonical and unambiguous');
  return parsed;
}
export function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function durableFile(file, bytes, replace = false) {
  const temporary = `${file}.${process.pid}.${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16)}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (!replace && fs.existsSync(file)) throw new Error('durable publication object already exists');
    fs.renameSync(temporary, file); fsyncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function workflowChanges(root, publicBase, exportedTree) {
  if (gitText(root, ['cat-file', '-t', publicBase]) !== 'commit' ||
      gitText(root, ['cat-file', '-t', exportedTree]) !== 'tree') throw new Error('workflow scope requires the actual public base commit and exported tree');
  function subtree(tree) {
    const entry = gitText(root, ['ls-tree', tree, '.github']);
    if (!entry) return null;
    const github = gitText(root, ['rev-parse', '--verify', `${tree}:.github`]);
    if (gitText(root, ['cat-file', '-t', github]) !== 'tree') throw new Error('public workflow directory must be a tree');
    const workflowEntry = gitText(root, ['ls-tree', github, 'workflows']);
    if (!workflowEntry) return null;
    const workflows = gitText(root, ['rev-parse', '--verify', `${tree}:.github/workflows`]);
    if (gitText(root, ['cat-file', '-t', workflows]) !== 'tree') throw new Error('public workflows must be a tree');
    return workflows;
  }
  return subtree(publicBase) !== subtree(exportedTree);
}
export const ADMISSION_BINDINGS = ['sourceCommit', 'exportedTree', 'publicBase', 'version', 'artifactSha256', 'policyHash'];
export function admissionSubject(tuple) {
  return digest(jsonBytes(Object.fromEntries(ADMISSION_BINDINGS.map((key) => [key, tuple[key]]))));
}
function receiptWindow(receipt, startField, now, admission) {
  return receipt && Number.isSafeInteger(receipt[startField]) && receipt[startField] >= admission.issuedAt &&
    Number.isSafeInteger(receipt.expiresAt) && receipt.expiresAt > receipt[startField] &&
    receipt.expiresAt <= admission.expiresAt && receipt[startField] <= now && now < receipt.expiresAt;
}
export function assertAdmission(admission, tuple, now, changedWorkflows, expectedAdmissionSha256 = tuple.admissionSha256) {
  if (!admission || admission.schema !== 'punchpilot-publication-admission') throw new Error('external publication admission is required');
  for (const key of ADMISSION_BINDINGS) {
    if (admission[key] !== tuple[key]) throw new Error('publication admission binding mismatch');
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(admission.issuedAt) || !Number.isSafeInteger(admission.expiresAt) ||
      now < admission.issuedAt || now >= admission.expiresAt || admission.revoked !== false ||
      ![admission.ownerApproval, admission.platformEvidence, admission.runnerEvidence].every((item) => typeof item === 'string' && item.length > 0 && !/[\0\r\n]/.test(item)) ||
      admission.actor !== BOT_NAME || admission.repository !== 'sky-zhang01/punchpilot') throw new Error('publication admission is absent, revoked, expired, or not bound to the protected bot/platform/runner');
  const permissions = changedWorkflows ? { contents: 'write', workflows: 'write' } : { contents: 'write' };
  const profile = changedWorkflows ? 'workflow-changing' : 'contents';
  if (admission.scopeProfile !== profile || JSON.stringify(admission.permissions) !== JSON.stringify(permissions)) throw new Error('publication admission scope profile mismatch');
  if (!SHA256.test(expectedAdmissionSha256) || digest(jsonBytes(admission)) !== expectedAdmissionSha256) throw new Error('publication admission digest is not independently pinned');
  const receipts = admission.receipts;
  const subjectSha256 = admissionSubject(tuple);
  const owner = receipts?.owner, platform = receipts?.platform, runner = receipts?.runner;
  if (!owner || owner.actor !== 'sky-zhang01' || owner.decision !== 'approved' || owner.approvalId !== admission.ownerApproval ||
      owner.subjectSha256 !== subjectSha256 || !receiptWindow(owner, 'issuedAt', now, admission)) throw new Error('owner approval receipt is not bound to this publication');
  if (!platform || platform.receiptId !== admission.platformEvidence || platform.repository !== admission.repository ||
      !receiptWindow(platform, 'observedAt', now, admission) || !Number.isSafeInteger(platform.appId) || platform.appId < 1 ||
      !Number.isSafeInteger(platform.installationId) || platform.installationId < 1 || platform.account?.login !== 'sky-zhang01' ||
      platform.account?.type !== 'User' || platform.repositoryIdentity?.full_name !== admission.repository ||
      !Number.isSafeInteger(platform.repositoryIdentity?.id) || platform.repositoryIdentity.id < 1 ||
      !Array.isArray(platform.rulesets) || platform.rulesets.length !== 2) throw new Error('platform protection receipt is incomplete');
  for (const [index, target] of ['branch', 'tag'].entries()) {
    const rule = platform.rulesets[index];
    const allowedRef = target === 'branch' ? 'refs/heads/main' : `refs/tags/${admission.version}`;
    const included = rule?.conditions?.ref_name?.include;
    const bypass = rule?.bypass_actors;
    if (!rule || !Number.isSafeInteger(rule.id) || rule.target !== target || rule.enforcement !== 'active' ||
        !Array.isArray(included) || included.length !== 1 || ![allowedRef, target === 'tag' ? 'refs/tags/v*' : allowedRef].includes(included[0]) ||
        rule.conditions.ref_name.exclude?.length || !Array.isArray(bypass) || bypass.length !== 1 ||
        bypass[0].actor_type !== 'Integration' || bypass[0].actor_id !== platform.appId || bypass[0].bypass_mode !== 'always' ||
        !['creation', 'update', 'deletion', 'non_fast_forward'].every((type) => rule.rules?.some((item) => item.type === type))) throw new Error('platform rules must restrict the exact main/tag to the sole release bot');
  }
  const environment = platform.environment;
  const protections = environment?.protection_rules?.filter((rule) => rule.type === 'required_reviewers');
  const branches = platform.branchPolicies?.branch_policies;
  if (environment?.name !== 'public-release' || environment.can_admins_bypass !== false || environment.deployment_branch_policy?.custom_branch_policies !== true ||
      !Array.isArray(protections) || protections.length !== 1 || protections[0].type !== 'required_reviewers' ||
      protections[0].prevent_self_review !== true || !Array.isArray(protections[0].reviewers) || protections[0].reviewers.length !== 1 ||
      protections[0].reviewers[0].type !== 'User' || protections[0].reviewers[0].reviewer?.login !== 'sky-zhang01' ||
      !Number.isSafeInteger(protections[0].reviewers[0].reviewer?.id) || protections[0].reviewers[0].reviewer.id < 1 ||
      environment.protection_rules.some((rule) => !['required_reviewers', 'branch_policy', 'wait_timer'].includes(rule.type)) ||
    !Array.isArray(branches) || branches.length !== 1 || branches[0].type !== 'tag' || ![admission.version, 'v*'].includes(branches[0].name)) throw new Error('public-release environment lacks the owner reviewer and exact tag policy');
  if (!runner || runner.receiptId !== admission.runnerEvidence || runner.subjectSha256 !== subjectSha256 ||
      !receiptWindow(runner, 'observedAt', now, admission) || !SHA256.test(runner.reviewedEntrySha256) ||
      runner.sourceCheckoutMounted !== false || runner.sourceCredentialsMounted !== false || runner.internalNetworkAllowed !== false ||
      !Array.isArray(runner.environmentNames) || runner.environmentNames.some((name) => /^(?:GITEA_|PUNCHPILOT_SOURCE_|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_OBJECT_DIRECTORY$)/.test(name)) ||
      !Array.isArray(runner.gitRemotes) || runner.gitRemotes.length !== 0 ||
      !Array.isArray(runner.objectTypesBeforeImport) || runner.objectTypesBeforeImport.length !== 0) throw new Error('reviewed runner isolation receipt is incomplete or contains internal inputs');
  if (tuple.reviewedEntrySha256 && runner.reviewedEntrySha256 !== tuple.reviewedEntrySha256) throw new Error('runner receipt does not match independently installed publisher code');
  return permissions;
}
