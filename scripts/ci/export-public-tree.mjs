#!/usr/bin/env node
// export-public-tree.mjs — PUB-ENGINE I2 divergent export-build
//
// Divergent export-build: a default-deny path allowlist policy is the sole
// owner of what may leave the internal tree. It compiles to a per-path
// include/exclude decision, then a git-archive-style path-filter projects the
// internal source commit onto an exported tree E that MAY diverge from the
// internal tree S. The exported tree E is content-scanned and, when clean,
// emitted as a verified-clean artifact together with reproducible provenance
// (source SHA, tree(E) digest, policy hash).
//
// Safety model (default-DENY):
//   * include  — path-spec covering a leaf path; the path enters E.
//   * exclude  — path-spec covering a leaf path; the path is redacted out of E
//                (deliberate divergence). An excluded path is ABSENT from E.
//   * (neither) — UNLISTED. A leaf path present in the source that no rule
//                covers FAILS the export. New top-level content cannot leak
//                without an explicit policy update.
//   exclude wins over include.
//
// Path-spec grammar:
//   * POSIX forward slashes, no leading '/', no '.'/'..' segments, no NUL.
//   * A spec ending in '/' is a directory prefix (matches the dir entry and
//     every leaf under it).
//   * Any other spec is an exact leaf path.
//
// NO-PUBLIC-MUTATION: this tool only writes tree objects to the local object
// database and may materialize a working tree under a local --out directory.
// It performs no push and mutates no public ref.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  canonicalObjects, digest, durableFile, ENVELOPE_LIMIT, gitBytes, gitText,
  gitEnvironment, jsonBytes, parseTagEnvelope, PGP_BEGIN, privateFile, sourcePublicCertificates,
  verifyRawSourceTag, withPublicGpgContext,
} from './publication-contract.mjs';

export const SCHEMA_ID = 'public-export-allowlist/v1';
export const ALLOWLIST_VERSION = 1;

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function git(repoRoot, ...args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitBuffer(repoRoot, ...args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const LEADING_SLASH = /^\//;
const TRAILING_SLASH = /\/$/;
const BACKSLASH = /\\/g;
const RELATIVE_SEGMENT = /(?:^|\/)\.\.(?:\/|$)|(?:^|\/)\.(?:\/|$)/;

// Normalize + validate a single path-spec. Directory specs keep a trailing '/'.
export function normalizePathSpec(raw) {
  if (typeof raw !== 'string') {
    throw new Error('allowlist path-spec must be a string');
  }
  const original = raw;
  let spec = raw.replace(BACKSLASH, '/').replace(/\/+/g, '/').trim();
  if (spec.length === 0) {
    throw new Error('allowlist path-spec is empty');
  }
  if (LEADING_SLASH.test(spec)) {
    throw new Error(`allowlist path-spec must be relative: ${original}`);
  }
  if (spec.includes('\0')) {
    throw new Error('allowlist path-spec contains a NUL byte');
  }
  if (RELATIVE_SEGMENT.test(spec)) {
    throw new Error(`allowlist path-spec must not contain '.' or '..' segments: ${original}`);
  }
  const isDirectory = TRAILING_SLASH.test(spec);
  spec = spec.replace(TRAILING_SLASH, '');
  if (spec.length === 0) {
    throw new Error('allowlist path-spec is empty');
  }
  return isDirectory ? `${spec}/` : spec;
}

// Parse + validate the versioned allowlist document. Returns a normalized,
// deterministic policy: version + de-duplicated, sorted include/exclude arrays.
export function parseAllowlist(text, { source = 'allowlist' } = {}) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: allowlist is not valid JSON (${error.message})`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${source}: allowlist must be a JSON object`);
  }
  if (document.$schema !== SCHEMA_ID) {
    throw new Error(`${source}: allowlist $schema must be '${SCHEMA_ID}'`);
  }
  const version = document.version;
  if (version !== ALLOWLIST_VERSION) {
    throw new Error(
      `${source}: unsupported allowlist version ${JSON.stringify(version)} (expected ${ALLOWLIST_VERSION})`,
    );
  }
  const include = readSpecList(document.include, source, 'include');
  const exclude = readSpecList(document.exclude, source, 'exclude');
  const seen = new Set();
  for (const list of [include, exclude]) {
    for (const spec of list) {
      if (seen.has(spec)) {
        throw new Error(`${source}: duplicate allowlist path-spec ${JSON.stringify(spec)}`);
      }
      seen.add(spec);
    }
  }
  return { version, include, exclude };
}

function readSpecList(value, source, field) {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: allowlist '${field}' must be an array`);
  }
  const normalized = value.map((entry) => normalizePathSpec(entry));
  normalized.sort(comparePath);
  return normalized;
}

export function comparePath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Canonical, byte-stable serialization for cross-consumer policy hashing.
export function canonicalPolicyJson(policy) {
  return JSON.stringify({
    $schema: SCHEMA_ID,
    version: policy.version,
    include: [...policy.include].sort(comparePath),
    exclude: [...policy.exclude].sort(comparePath),
  });
}

export function computePolicyHash(policy) {
  return crypto.createHash('sha256').update(canonicalPolicyJson(policy), 'utf8').digest('hex');
}

// A path-spec matches a leaf path. Directory specs match every leaf under
// the prefix; exact specs match the whole path. `server/` matches
// `server/a.js` but not a leaf file literally named `server`.
function specMatches(spec, leafPath) {
  if (TRAILING_SLASH.test(spec)) {
    return leafPath.startsWith(spec);
  }
  return leafPath === spec;
}

export function compilePolicy(policy) {
  const include = [...policy.include];
  const exclude = [...policy.exclude];
  return function decide(leafPath) {
    for (const spec of exclude) {
      if (specMatches(spec, leafPath)) return 'exclude';
    }
    for (const spec of include) {
      if (specMatches(spec, leafPath)) return 'include';
    }
    return 'unlisted';
  };
}

// Enumerate the leaf entries of the source tree (blobs + gitlinks). Modes are
// preserved so the rebuilt tree E is byte-identical to the filtered source.
export function listSourceEntries(repoRoot, source) {
  const output = gitBuffer(repoRoot, 'ls-tree', '-r', '-z', '--full-tree', source);
  const entries = [];
  for (const rawEntry of output.toString('utf8').split('\0')) {
    if (rawEntry.length === 0) continue;
    const tab = rawEntry.indexOf('\t');
    if (tab < 0) throw new Error('invalid Git tree entry');
    const [mode, type, sha] = rawEntry.slice(0, tab).split(' ');
    const entryPath = rawEntry.slice(tab + 1);
    if (!mode || !type || !sha) throw new Error('invalid Git tree entry');
    if (entryPath.length === 0) throw new Error('invalid Git tree entry');
    entries.push({ mode, type, sha, path: entryPath });
  }
  return entries;
}

// Partition source leaves by the compiled policy.
export function partitionEntries(entries, decide) {
  const included = [];
  const excluded = [];
  const unlisted = [];
  for (const entry of entries) {
    const decision = decide(entry.path);
    if (decision === 'include') included.push(entry);
    else if (decision === 'exclude') excluded.push(entry);
    else unlisted.push(entry);
  }
  included.sort((a, b) => comparePath(a.path, b.path));
  excluded.sort((a, b) => comparePath(a.path, b.path));
  unlisted.sort((a, b) => comparePath(a.path, b.path));
  return { included, excluded, unlisted };
}

// Rebuild tree E from the included leaves using `git mktree` bottom-up. This
// preserves file modes, executables, symlinks (120000), and gitlinks (160000),
// and avoids the git index entirely so it is robust to environments that pin a
// single process index.
export function buildExportTree(repoRoot, included) {
  if (included.length === 0) {
    throw new Error('cannot build an exported tree from zero included paths');
  }
  const root = Object.create(null);
  for (const entry of included) {
    const segments = entry.path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      node[segment] = node[segment] || Object.create(null);
      node = node[segment];
    }
    node[segments[segments.length - 1]] = {
      mode: entry.mode,
      type: entry.type,
      sha: entry.sha,
    };
  }

  const buildLevel = (node) => {
    const lines = [];
    for (const [name, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && value.sha) {
        lines.push(`${value.mode} ${value.type} ${value.sha}\t${name}`);
      } else {
        lines.push(`040000 tree ${buildLevel(value)}\t${name}`);
      }
    }
    lines.sort();
    return execFileSync('git', ['mktree'], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: `${lines.join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  };

  return buildLevel(root);
}

// Materialize tree E into a working directory (git-archive style).
export function materializeTree(repoRoot, treeSha, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', treeSha], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tar = spawnSync('tar', ['-xf', '-', '-C', outDir], {
    encoding: 'utf8',
    input: archive,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (tar.error || tar.status !== 0) {
    throw new Error('could not materialize exported tree');
  }
}

// Content-scan tree E with the public-release privacy gate. Returns the exit
// status and captured output so the caller can fail closed on any finding.
export function scanExportTree(
  repoRoot,
  treeSha,
  { privacyGate, repoName, pathsetProvenance, rawSourceTag, gpgHome, forbiddenHosts = process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS || '' } = {},
) {
  if (!pathsetProvenance) {
    throw new Error('export pathset provenance is required for the privacy scan');
  }
  const gate = privacyGate || path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'public-release-privacy-gate.py',
  );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-export-scan-'));
  const pathsetFile = path.join(scratch, 'provenance.json');
  let result;
  try {
    fs.writeFileSync(
      pathsetFile,
      `${JSON.stringify(pathsetProvenance)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const tagFile = path.join(scratch, 'source-tag.raw');
    if (rawSourceTag) fs.writeFileSync(tagFile, rawSourceTag, { flag: 'wx', mode: 0o600 });
    result = spawnSync(
      'python3',
      [
        gate,
        '--root',
        repoRoot,
        '--export-tree',
        treeSha,
        '--repo-name',
        repoName || 'export',
        '--allowlist-pathset',
        pathsetFile,
        '--require-forbidden-hosts',
        '--fail-on-warn',
        ...(rawSourceTag ? ['--tag-envelope-file', tagFile] : []),
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...gitEnvironment(), ...(gpgHome ? { GNUPGHOME: gpgHome } : {}), PUBLIC_RELEASE_FORBIDDEN_HOSTS: forbiddenHosts },
      },
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exit = result.status == null ? 1 : result.status;
  return { ok: exit === 0, exit, stdout, stderr };
}

export function buildProvenance({
  sourceCommit,
  sourceTree,
  treeSha,
  policy,
  policyHash,
  pathset,
  excluded,
  publicBase,
}) {
  const manifest = [...pathset].sort(comparePath);
  const manifestBlob = `${manifest.join('\n')}\n`;
  const pathsetSha256 = crypto
    .createHash('sha256')
    .update(manifestBlob, 'utf8')
    .digest('hex');
  return {
    schema: 'public-export-provenance/v1',
    generator: 'scripts/ci/export-public-tree.mjs',
    sourceCommit,
    sourceTree,
    exportedTree: treeSha,
    policyVersion: policy.version,
    policyHash,
    pathsetSha256,
    pathset: manifest,
    excludedPaths: [...excluded].sort(comparePath),
    intendedPublicBase: publicBase || null,
  };
}

// Full export pipeline. Shared by the CLI and tests. Throws on policy/export
// violations; returns the artifact + provenance on success.
export function exportPublicTree({
  repoRoot,
  source = 'HEAD',
  sourceTag = null,
  policy,
  publicBase = null,
  outDir = null,
  scan = true,
  privacyGate = null,
  repoName = 'export',
  gpgHome = null,
  forbiddenHosts = process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS || '',
}) {
  const decide = compilePolicy(policy);
  const policyHash = computePolicyHash(policy);

  let sourceCommit;
  let sourceTree;
  try {
    sourceCommit = git(repoRoot, 'rev-parse', `${source}^{commit}`);
  } catch {
    throw new Error(`source is not a commit: ${source}`);
  }
  try {
    sourceTree = git(repoRoot, 'rev-parse', `${sourceCommit}^{tree}`);
  } catch {
    throw new Error(`could not resolve source tree for ${source}`);
  }

  const entries = listSourceEntries(repoRoot, sourceCommit);
  const { included, excluded, unlisted } = partitionEntries(entries, decide);
  if (unlisted.length > 0) {
    const sample = unlisted.slice(0, 3).map((entry) => entry.path).join(', ');
    const err = new Error(
      `default-deny: ${unlisted.length} source path(s) are not covered by the allowlist ` +
        `(include or exclude). First: ${sample}. Update .public-export/allowlist.json explicitly.`,
    );
    err.code = 'UNLISTED';
    err.unlisted = unlisted.map((entry) => entry.path);
    throw err;
  }

  if (included.some((entry) => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) {
    throw new Error('publication exports accept regular files only; symbolic links and Git links are forbidden');
  }
  const treeSha = buildExportTree(repoRoot, included);
  const pathset = included.map((entry) => entry.path);
  const excludedPaths = excluded.map((entry) => entry.path);
  const provenance = buildProvenance({
    sourceCommit,
    sourceTree,
    treeSha,
    policy,
    policyHash,
    pathset,
    excluded: excludedPaths,
    publicBase,
  });

  let scanResult = null;
  if (scan) {
    let rawSourceTag;
    if (sourceTag) {
      rawSourceTag = gitBytes(repoRoot, ['cat-file', 'tag', sourceTag]);
      if (parseTagEnvelope(rawSourceTag).target !== sourceCommit) throw new Error('source tag must target the exported source commit');
    }
    const scanWithHome = (home) => scanExportTree(repoRoot, treeSha, {
      privacyGate,
      repoName,
      pathsetProvenance: provenance,
      rawSourceTag,
      gpgHome: home,
      forbiddenHosts,
    });
    scanResult = rawSourceTag?.includes(PGP_BEGIN) && !gpgHome
      ? withPublicGpgContext(sourcePublicCertificates(repoRoot), scanWithHome)
      : scanWithHome(gpgHome);
    if (!scanResult.ok) {
      const err = new Error(
        `exported tree E is not verified-clean: public-release privacy gate reported findings ` +
          `(exit ${scanResult.exit}).`,
      );
      err.code = 'NOT_CLEAN';
      err.scanResult = scanResult;
      throw err;
    }
  }

  if (outDir) {
    materializeTree(repoRoot, treeSha, outDir);
  }

  return {
    treeSha,
    sourceCommit,
    sourceTree,
    policyHash,
    pathset,
    excludedPaths,
    unlisted: [],
    scanResult,
    provenance,
  };
}

// Source mode owns live authority. The consumer receives this sealed snapshot;
// it never receives the source CI configuration or its credential paths.
export function sourceAuthorityProof({ repoRoot, sourceGate, sourceCommit, sourceTagObject, version, evidenceFile }) {
  const gate = fs.realpathSync(sourceGate);
  privateFile(gate, fs.realpathSync(repoRoot));
  const result = spawnSync('python3', [gate, '--commit', sourceCommit, '--object', sourceTagObject,
    '--ref', `refs/tags/${version}`, '--evidence-out', evidenceFile], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: ENVELOPE_LIMIT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error || result.status !== 0) throw new Error('live source authority failed; no artifact may be admitted');
  const bytes = privateFile(evidenceFile, fs.realpathSync(repoRoot));
  const proof = JSON.parse(bytes);
  if (proof.schema !== 'punchpilot-source-ci-proof' || proof.sourceCommit !== sourceCommit ||
      proof.sourceTagObject !== sourceTagObject || proof.sourceRef !== `refs/tags/${version}` ||
      proof.mainRun?.head_sha !== sourceCommit || proof.mainRun?.status !== 'completed' || proof.mainRun?.conclusion !== 'success' ||
      proof.releaseRun?.head_sha !== sourceCommit || proof.releaseRun?.status !== 'completed' || proof.releaseRun?.conclusion !== 'success' ||
      proof.mainJobs?.length !== 7 || proof.releaseJobs?.length !== 1 ||
      [proof.mainRun, proof.releaseRun].some((run) => !['id', 'run_number', 'run_attempt'].every((key) => Number.isSafeInteger(run[key]) && run[key] > 0)) ||
      [...proof.mainJobs, ...proof.releaseJobs].some((job) => job.headSha !== sourceCommit || job.conclusion !== 'success') ||
      Object.hasOwn(proof, 'pass')) throw new Error('source authority proof binding is invalid');
  return { proof, bytes };
}

export function createPublicationArtifact({ repoRoot, source = 'HEAD', sourceTag, publicBase, policy,
  artifactDir, sourceGate, fingerprint, revokedKeys = [], gpgHome, privacyGate = null, forbiddenHosts }) {
  const root = fs.realpathSync(repoRoot);
  if (gitText(root, ['status', '--porcelain=v1', '--untracked-files=all']) ||
      gitText(root, ['rev-parse', `${source}^{commit}`]) !== gitText(root, ['rev-parse', 'HEAD^{commit}'])) throw new Error('artifact producer requires the exact clean reviewed source checkout');
  if (typeof forbiddenHosts !== 'string' || !forbiddenHosts) throw new Error('producer requires the external forbidden-host policy');
  const destination = path.resolve(artifactDir);
  if (destination === root || destination.startsWith(`${root}${path.sep}`) || fs.existsSync(destination)) throw new Error('artifact requires a new directory outside the source repository');
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    return withPublicGpgContext(sourcePublicCertificates(root, { fingerprint, gpgHome }), (publicHome) => {
      const exported = exportPublicTree({ repoRoot: root, source, sourceTag, publicBase, policy, scan: false });
      const rawTag = gitBytes(root, ['cat-file', 'tag', sourceTag]);
      const tag = parseTagEnvelope(rawTag);
      const sourceEpoch = Number(gitText(root, ['show', '-s', '--format=%ct', exported.sourceCommit]));
      const tuple = { sourceCommit: exported.sourceCommit, exportedTree: exported.treeSha,
        publicBase, version: tag.name, sourceEpoch };
      canonicalObjects(tuple);
      verifyRawSourceTag(rawTag, tuple, { fingerprint, revokedKeys, gpgHome: publicHome, scratch: destination });
      const scanned = scanExportTree(root, exported.treeSha, { privacyGate, pathsetProvenance: exported.provenance,
        rawSourceTag: rawTag, gpgHome: publicHome, forbiddenHosts });
      if (!scanned.ok) throw new Error(`exported tree E is not verified-clean: ${scanned.stdout}${scanned.stderr}`);
      const { bytes: proof } = sourceAuthorityProof({ repoRoot: root, sourceGate,
        sourceCommit: tuple.sourceCommit, sourceTagObject: tag.objectId, version: tuple.version,
        evidenceFile: path.join(destination, 'source-ci-proof.json') });
      const closure = gitText(root, ['rev-list', '--objects', exported.treeSha]).split('\n').map((line) => line.split(' ')[0]);
      const pack = gitBytes(root, ['pack-objects', '--stdout', '--no-reuse-delta'], `${closure.join('\n')}\n`);
      const policyBytes = jsonBytes(policy);
      const manifest = {
        schema: 'punchpilot-publication-artifact', ...tuple, policyHash: exported.policyHash,
        provenance: exported.provenance, packSha256: digest(pack), sourceTagSha256: digest(rawTag),
        sourceTagObject: tag.objectId, sourceProofSha256: digest(proof), policySha256: digest(policyBytes),
      };
      durableFile(path.join(destination, 'export.pack'), pack);
      durableFile(path.join(destination, 'source-tag.raw'), rawTag);
      durableFile(path.join(destination, 'allowlist.json'), policyBytes);
      const manifestBytes = jsonBytes(manifest);
      durableFile(path.join(destination, 'manifest.json'), manifestBytes);
      return { artifactDir: destination, manifest, artifactSha256: digest(manifestBytes) };
    });
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  console.log(
    'Usage: export-public-tree.mjs --source REF [--source-tag TAG] [--policy PATH] [--out DIR] ' +
      '[--public-base REF] [--repo-name NAME] [--no-scan] [--json] [--help]',
  );
}

function parseArguments(args) {
  if (args.includes('--help')) {
    usage();
    process.exit(0);
  }
  const valueOptions = new Set(['--source', '--source-tag', '--policy', '--out', '--public-base', '--repo-name']);
  const flags = new Set(['--no-scan', '--json']);
  const values = new Map();
  let noScan = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--no-scan') {
      noScan = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (flags.has(argument)) {
      if (values.has(argument)) fail(`duplicate export argument: ${argument}`);
      values.set(argument, true);
      continue;
    }
    if (!valueOptions.has(argument)) {
      fail(`unsupported export argument: ${argument}`);
    }
    if (values.has(argument)) fail(`duplicate export argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`export argument ${argument} is missing a value.`);
    }
    values.set(argument, value);
    index += 1;
  }
  return {
    source: values.get('--source') || 'HEAD',
    sourceTag: values.get('--source-tag') || null,
    policyPath: values.get('--policy') || '.public-export/allowlist.json',
    outDir: values.get('--out') || null,
    publicBase: values.get('--public-base') || null,
    repoName: values.get('--repo-name') || 'export',
    noScan,
    json,
  };
}

function main(argv) {
  const options = parseArguments(argv);
  const repoRoot = process.cwd();
  const policyPath = path.resolve(repoRoot, options.policyPath);
  if (!fs.existsSync(policyPath)) {
    fail(`allowlist policy not found: ${options.policyPath}`);
  }
  let policy;
  try {
    policy = parseAllowlist(fs.readFileSync(policyPath, 'utf8'), {
      source: options.policyPath,
    });
  } catch (error) {
    fail(error.message);
  }

  let result;
  try {
    result = exportPublicTree({
      repoRoot,
      source: options.source,
      sourceTag: options.sourceTag,
      policy,
      publicBase: options.publicBase,
      outDir: options.outDir,
      scan: !options.noScan,
      repoName: options.repoName,
    });
  } catch (error) {
    if (error.code === 'UNLISTED') {
      console.error(`[FAIL] ${error.message}`);
      for (const missed of error.unlisted) {
        console.error(`        unlisted: ${missed}`);
      }
    } else if (error.code === 'NOT_CLEAN') {
      console.error(`[FAIL] ${error.message}`);
      if (error.scanResult) {
        process.stdout.write(error.scanResult.stdout || '');
        process.stderr.write(error.scanResult.stderr || '');
      }
    } else {
      console.error(`[FAIL] ${error.message}`);
    }
    process.exit(1);
  }

  const summary = {
    sourceCommit: result.sourceCommit,
    sourceTree: result.sourceTree,
    exportedTree: result.treeSha,
    policyHash: result.policyHash,
    pathsetSha256: result.provenance.pathsetSha256,
    includedPaths: result.pathset.length,
    excludedPaths: result.excludedPaths.length,
    divergent: result.excludedPaths.length > 0,
    verifiedClean: Boolean(result.scanResult?.ok),
    provenance: result.provenance,
  };

  if (options.outDir) {
    fs.writeFileSync(
      path.join(options.outDir, '.public-export-provenance.json'),
      `${JSON.stringify(result.provenance, null, 2)}\n`,
    );
  }

  console.log(
    `OK - exported tree E ${result.treeSha.slice(0, 12)} ` +
      `(${result.pathset.length} paths, ${result.excludedPaths.length} excluded)` +
      `${summary.divergent ? ' [DIVERGENT]' : ''}` +
      `${result.scanResult ? ' verified-clean' : ' (scan skipped)'}.`,
  );
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
