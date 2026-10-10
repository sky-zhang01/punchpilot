#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = fs.realpathSync(path.resolve(scriptDir, '..'));
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const workflowDirectories = ['.gitea/workflows', '.github/workflows'];
const sourceConfigFields = new Set([
  'version',
  'apiBaseUrl',
  'repository',
  'credentialFile',
  'expectedActor',
  'caFile',
  'extraHeaderFiles',
  'gitTransportUrls',
  'promotionCommit',
  'trustedWorkflowTrees',
]);

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!['--mode', '--source-config', '--policy', '--artifact', '--target'].includes(name) || !value || value.startsWith('--') || argumentsByName.has(name)) fail('Invalid publication installer arguments.');
  argumentsByName.set(name, value);
}
const option = (name) => argumentsByName.get(name) || null;

function git(cwd, ...args) {
  try {
    return execFileSync(
      'git',
      args,
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    fail('The reviewed Git state is unavailable.');
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function canonicalDestination(candidate) {
  const suffix = [];
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail('Could not resolve the hook target.');
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function assertPrivateDirectory(directory) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('The hook target must be a real directory.');
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    fail('The hook target must be owned by the current user.');
  }
  if ((metadata.mode & 0o022) !== 0) {
    fail('The hook target must not be writable by group or other users.');
  }
}

function assertPrivateSourceFile(source, label) {
  let metadata;
  try {
    metadata = fs.lstatSync(source);
  } catch {
    fail(`${label} is unavailable.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular file.`);
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible to group or other users.`);
  }
  const resolved = fs.realpathSync(source);
  if (isInside(sourceRoot, resolved)) {
    fail(`${label} must remain outside the repository.`);
  }
  return resolved;
}

function installFile(source, target, mode) {
  const sourceMetadata = fs.lstatSync(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    fail('Publication hook sources must be regular files.');
  }
  if (fs.existsSync(target)) {
    const targetMetadata = fs.lstatSync(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
      fail('Refusing to replace a non-regular publication hook target.');
    }
  }

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function installContent(content, target, mode) {
  if (fs.existsSync(target)) {
    const targetMetadata = fs.lstatSync(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
      fail('Refusing to replace a non-regular publication hook target.');
    }
  }

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseSourceConfig(source) {
  let config;
  try {
    if (fs.statSync(source).size > 65_536) fail('The source gate configuration is invalid.');
    config = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail('The source gate configuration is unavailable.');
    fail('The source gate configuration is invalid.');
  }
  if (
    !config
    || typeof config !== 'object'
    || Array.isArray(config)
    || ![1, 2].includes(config.version)
    || Object.keys(config).some((field) => !sourceConfigFields.has(field))
  ) {
    fail('The source gate configuration is invalid.');
  }
  if (
    typeof config.apiBaseUrl !== 'string'
    || typeof config.credentialFile !== 'string'
    || typeof config.expectedActor !== 'string'
    || !config.repository
    || typeof config.repository !== 'object'
    || Array.isArray(config.repository)
    || Object.keys(config.repository).length !== 2
    || typeof config.repository.owner !== 'string'
    || typeof config.repository.name !== 'string'
    || (config.caFile !== undefined && typeof config.caFile !== 'string')
    || (
      config.extraHeaderFiles !== undefined
      && (
        !config.extraHeaderFiles
        || typeof config.extraHeaderFiles !== 'object'
        || Array.isArray(config.extraHeaderFiles)
      )
    )
    || (
      config.gitTransportUrls !== undefined
      && (
        !Array.isArray(config.gitTransportUrls)
        || config.gitTransportUrls.length > 4
        || new Set(config.gitTransportUrls).size !== config.gitTransportUrls.length
        || config.gitTransportUrls.some((value) => typeof value !== 'string' || !value)
      )
    )
  ) {
    fail('The source gate configuration is invalid.');
  }

  for (const value of config.gitTransportUrls || []) {
    let transport;
    try {
      transport = new URL(value);
    } catch {
      fail('The source Git transport configuration is invalid.');
    }
    const expectedPaths = new Set([
      `/${config.repository.owner}/${config.repository.name}`,
      `/${config.repository.owner}/${config.repository.name}.git`,
    ]);
    if (
      transport.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(transport.hostname.toLowerCase())
      || !transport.port
      || transport.username
      || transport.password
      || transport.search
      || transport.hash
      || !expectedPaths.has(transport.pathname.replace(/\/$/, ''))
    ) {
      fail('The source Git transport configuration is invalid.');
    }
  }

  const normalized = {
    version: 2,
    apiBaseUrl: config.apiBaseUrl,
    repository: config.repository,
    credentialFile: config.credentialFile,
    expectedActor: config.expectedActor,
  };
  if (config.caFile !== undefined) normalized.caFile = config.caFile;
  if (config.extraHeaderFiles !== undefined) {
    normalized.extraHeaderFiles = config.extraHeaderFiles;
  }
  if (config.gitTransportUrls !== undefined) {
    normalized.gitTransportUrls = config.gitTransportUrls;
  }
  return normalized;
}

let repoRoot;
try {
  repoRoot = fs.realpathSync(git(process.cwd(), 'rev-parse', '--show-toplevel'));
} catch {
  fail('Run this installer from the PunchPilot repository.');
}

if (repoRoot !== sourceRoot) {
  fail('Run the installer from the same reviewed checkout that contains it.');
}

if (git(repoRoot, 'status', '--porcelain=v1', '--untracked-files=all')) {
  fail('The publication snapshot requires a clean reviewed checkout.');
}

const mode = option('--mode') || 'source';
if (mode === 'consumer') {
  if (option('--source-config') || !option('--policy') || !option('--artifact') || !option('--target')) fail('Consumer installation requires --policy, --artifact and --target.');
  const { readPrivateJson } = await import('./ci/publication-contract.mjs');
  const { installArtifact } = await import('./ci/isolated-publisher.mjs');
  try {
    const policy = readPrivateJson(path.resolve(option('--policy')), repoRoot);
    installArtifact({ ...policy, repoRoot, artifactDir: path.resolve(option('--artifact')), target: path.resolve(option('--target')) });
    console.log('Installed independently admitted E-only publication consumer.');
    process.exit(0);
  } catch (error) { fail(error.message); }
}
if (mode !== 'source' || option('--policy') || option('--artifact')) fail('Installer mode must be source or consumer with its exact arguments.');

const sourceConfig = option('--source-config');
if (!sourceConfig) fail('--source-config is required.');
const resolvedSourceConfig = assertPrivateSourceFile(
  path.resolve(sourceConfig),
  'The source gate configuration',
);
const installedSourceConfig = parseSourceConfig(resolvedSourceConfig);

const promotionCommit = git(repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}').toLowerCase();
if (!objectIdPattern.test(promotionCommit)) {
  fail('The reviewed promotion commit is invalid.');
}
const trustedWorkflowTrees = {};
for (const directory of workflowDirectories) {
  const objectId = git(
    repoRoot,
    'rev-parse',
    '--verify',
    `${promotionCommit}:${directory}`,
  ).toLowerCase();
  if (
    !objectIdPattern.test(objectId)
    || objectId.length !== promotionCommit.length
    || git(repoRoot, 'cat-file', '-t', objectId) !== 'tree'
  ) {
    fail('A reviewed workflow directory is unavailable.');
  }
  trustedWorkflowTrees[directory] = objectId;
}
installedSourceConfig.promotionCommit = promotionCommit;
installedSourceConfig.trustedWorkflowTrees = trustedWorkflowTrees;

const checkoutId = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
const defaultConfigRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const requestedTarget = option('--target') ||
  path.join(defaultConfigRoot, 'punchpilot', 'git-hooks', checkoutId);
const resolvedTarget = canonicalDestination(path.resolve(requestedTarget));

if (isInside(repoRoot, resolvedTarget)) {
  fail('The trusted hook target must be outside the repository.');
}

fs.mkdirSync(resolvedTarget, { recursive: true, mode: 0o700 });
const target = fs.realpathSync(resolvedTarget);
if (isInside(repoRoot, target)) {
  fail('The trusted hook target resolves inside the repository.');
}
fs.chmodSync(target, 0o700);
assertPrivateDirectory(target);

const privacySource = path.join(repoRoot, 'scripts', 'ci', 'public-release-privacy-gate.py');
const sourceGateSource = path.join(repoRoot, 'scripts', 'ci', 'source-ci-gate.py');
const hookSource = path.join(repoRoot, '.githooks', 'pre-push');
const privacyTarget = path.join(target, 'public-release-privacy-gate.py');
const sourceGateTarget = path.join(target, 'source-ci-gate.py');
const sourceConfigTarget = path.join(target, 'source-ci-gate.json');
const hookTarget = path.join(target, 'pre-push');

installFile(privacySource, privacyTarget, 0o600);
installFile(sourceGateSource, sourceGateTarget, 0o700);
installFile(hookSource, hookTarget, 0o700);
installContent(`${JSON.stringify(installedSourceConfig, null, 2)}\n`, sourceConfigTarget, 0o600);

execFileSync('git', ['config', '--local', 'core.hooksPath', target], {
  cwd: repoRoot,
  stdio: 'inherit',
});
const configured = execFileSync(
  'git',
  ['config', '--local', '--get', 'core.hooksPath'],
  { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
).trim();
if (configured !== target) {
  fail('Git did not retain the external hooks path.');
}
execFileSync(
  'git',
  ['config', '--local', 'punchpilot.sourceGateExecutable', sourceGateTarget],
  { cwd: repoRoot, stdio: 'inherit' },
);

console.log(`Installed trusted publication hook at ${target}`);
console.log(`Pinned exact publication candidate ${promotionCommit}`);
