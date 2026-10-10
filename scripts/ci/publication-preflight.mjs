#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const privacyGate = path.join(scriptDir, 'public-release-privacy-gate.py');
import {
  BOT_NAME as pinnedBotName, BOT_EMAIL as pinnedBotEmail, OID as gitSha1Pattern,
  SHA256 as sha256Pattern, VERSION as versionPattern, FINGERPRINT as fingerprintPattern,
  ENVELOPE_LIMIT as maxProvenanceBytes, ENVELOPE_LIMIT as maxTagBytes,
  PGP_BEGIN as pgpSignatureBegin, PGP_END as pgpSignatureEnd,
  digest as sha256, safePath as validateManifestPath, validateProvenance,
  tagMessage as expectedTagMessage, validateSignatureStatus,
} from './publication-contract.mjs';

// Both trust modes enter the same normative gate. Source mode has live S and
// its source proof; consumer mode has only the independently sealed E/public
// objects and raw source evidence outside its Git database.
const modeIndex = process.argv.indexOf('--mode');
if (modeIndex !== -1) {
  const mode = process.argv[modeIndex + 1];
  if (mode === 'consumer') {
    try {
      const values = new Map();
      const args = process.argv.slice(2);
      for (let index = 0; index < args.length; index += 2) {
        if (!['--mode', '--consumer-snapshot', '--state'].includes(args[index]) || !args[index + 1] || values.has(args[index])) throw new Error('invalid consumer preflight arguments');
        values.set(args[index], args[index + 1]);
      }
      if (!values.get('--consumer-snapshot') || !values.get('--state')) throw new Error('installed consumer snapshot and persisted state are required');
      const { validateConsumerPublication } = await import('./isolated-publisher.mjs');
      validateConsumerPublication({ snapshotDir: values.get('--consumer-snapshot'), stateDir: values.get('--state'), repoRoot: process.cwd() });
      console.log('OK - isolated consumer publication contract passed.');
      process.exit(0);
    } catch (error) { fail(error.message); }
  }
  if (mode !== 'source') fail('publication preflight mode must be source or consumer');
  process.argv.splice(modeIndex, 2);
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function usage() {
  console.log(
    'Usage: publication-preflight.mjs [--head REF] [--base REF] ' +
    '[--require-source-ref REF] [--repo-name NAME] [--require-forbidden-hosts] ' +
    '[--tree-only] [--publication-commit P] [--public-base REF] ' +
    '[--export-provenance FILE] [--policy-hash SHA256] [--version vX.Y.Z] ' +
    '[--publication-tag TAG] [--source-tag TAG] ' +
    '[--source-tag-signing-key FINGERPRINT] ' +
    '[--revoked-signing-key FINGERPRINT ...]',
  );
}

function parseArguments(args) {
  if (args.includes('--help')) {
    if (args.length !== 1) fail('--help cannot be combined with other arguments.');
    usage();
    process.exit(0);
  }

  const valueOptions = new Set([
    '--head',
    '--base',
    '--require-source-ref',
    '--repo-name',
    '--publication-commit',
    '--public-base',
    '--export-provenance',
    '--policy-hash',
    '--version',
    '--publication-tag',
    '--source-tag',
    '--source-tag-signing-key',
  ]);
  const values = new Map();
  const revokedSigningKeys = [];
  let requireForbiddenHosts = false;
  let treeOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--require-forbidden-hosts') {
      if (requireForbiddenHosts) fail('duplicate publication preflight argument.');
      requireForbiddenHosts = true;
      continue;
    }
    if (argument === '--tree-only') {
      if (treeOnly) fail('duplicate publication preflight argument.');
      treeOnly = true;
      continue;
    }
    if (argument === '--revoked-signing-key') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        fail('publication preflight argument is missing a value.');
      }
      revokedSigningKeys.push(value);
      index += 1;
      continue;
    }
    if (!valueOptions.has(argument)) {
      fail('unsupported publication preflight argument.');
    }
    if (values.has(argument)) fail('duplicate publication preflight argument.');
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      fail('publication preflight argument is missing a value.');
    }
    values.set(argument, value);
    index += 1;
  }
  return { values, requireForbiddenHosts, treeOnly, revokedSigningKeys };
}

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitWithoutReplacementObjects(...args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitBufferWithoutReplacementObjects(...args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    encoding: 'buffer',
    maxBuffer: maxTagBytes + 128 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

function readExportProvenance(file, expectedPolicyHash) {
  let raw;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxProvenanceBytes) {
      fail('export provenance is missing, oversized, or not a file');
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail('export provenance is missing or unreadable');
  }

  try { return validateProvenance(JSON.parse(raw), expectedPolicyHash); }
  catch (error) { fail(error.message); }
}

function requireObjectType(object, expectedType, message) {
  let actualType;
  try {
    actualType = gitWithoutReplacementObjects('cat-file', '-t', object);
  } catch {
    fail(message);
  }
  if (actualType !== expectedType) fail(message);
}

function listTreeEntries(tree, role) {
  let raw;
  try {
    raw = gitBufferWithoutReplacementObjects(
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      tree,
    );
  } catch {
    fail(`could not inspect ${role} tree manifest`);
  }
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) {
    fail(`${role} tree manifest contains a non-UTF-8 path`);
  }
  const entries = text.split('\0').filter(Boolean).map((record) => {
    const separator = record.indexOf('\t');
    if (separator < 0) fail(`${role} tree manifest is malformed`);
    const metadata = record.slice(0, separator);
    const entryPath = record.slice(separator + 1);
    const match = metadata.match(
      /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})$/,
    );
    if (
      !match ||
      !validateManifestPath(entryPath) ||
      (match[1] === '160000') !== (match[2] === 'commit')
    ) {
      fail(`${role} tree manifest is malformed`);
    }
    return {
      mode: match[1],
      type: match[2],
      objectId: match[3],
      path: entryPath,
    };
  });
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}

function parseRawCommit(commit) {
  let raw;
  try {
    raw = gitBufferWithoutReplacementObjects('cat-file', 'commit', commit);
  } catch {
    fail('publication commit is not a commit');
  }
  const separator = raw.indexOf(Buffer.from('\n\n'));
  if (separator < 0) fail('publication commit object is malformed');
  const header = raw.subarray(0, separator);
  const headerText = header.toString('utf8');
  if (
    !Buffer.from(headerText, 'utf8').equals(header) ||
    headerText.includes('\0') ||
    headerText.includes('\r')
  ) {
    fail('publication commit object is malformed');
  }
  const lines = headerText.split('\n');
  const select = (prefix) => lines.filter((line) => line.startsWith(prefix));
  const trees = select('tree ');
  const parents = select('parent ');
  const authors = select('author ');
  const committers = select('committer ');
  if (trees.length !== 1 || authors.length !== 1 || committers.length !== 1) {
    fail('publication commit object is malformed');
  }
  return {
    tree: trees[0].slice('tree '.length),
    parents: parents.map((line) => line.slice('parent '.length)),
    author: authors[0],
    committer: committers[0],
    body: raw.subarray(separator + 2),
    headers: lines,
  };
}

function assertPinnedCommitIdentity(line, role) {
  const expectedPrefix =
    `${role} ${pinnedBotName} <${pinnedBotEmail}> `;
  const timestamp = line.startsWith(expectedPrefix)
    ? line.slice(expectedPrefix.length)
    : '';
  if (!/^-?[0-9]+ [+-][0-9]{4}$/.test(timestamp)) {
    fail(`publication ${role} must use the pinned release bot identity`);
  }
}

function assertPinnedTaggerIdentity(line) {
  const expectedPrefix =
    `tagger ${pinnedBotName} <${pinnedBotEmail}> `;
  const timestamp = line.startsWith(expectedPrefix)
    ? line.slice(expectedPrefix.length)
    : '';
  if (!/^-?[0-9]+ [+-][0-9]{4}$/.test(timestamp)) {
    fail('public tag must use the pinned release bot identity');
  }
}

function readTagObject(ref, role) {
  let objectId;
  try {
    objectId = gitWithoutReplacementObjects(
      'rev-parse',
      '--verify',
      `${ref}^{tag}`,
    );
  } catch {
    fail(`${role} tag must be an annotated tag object`);
  }
  requireObjectType(objectId, 'tag', `${role} tag must be an annotated tag object`);

  let size;
  try {
    size = Number(gitWithoutReplacementObjects('cat-file', '-s', objectId));
  } catch {
    fail(`${role} tag could not be inspected`);
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > maxTagBytes) {
    fail(`${role} tag object exceeds the publication size limit`);
  }

  let raw;
  try {
    raw = gitBufferWithoutReplacementObjects('cat-file', 'tag', objectId);
  } catch {
    fail(`${role} tag could not be inspected`);
  }
  const separator = raw.indexOf(Buffer.from('\n\n'));
  if (separator < 0) fail(`${role} tag object is malformed`);
  const header = raw.subarray(0, separator);
  const headerText = header.toString('utf8');
  if (
    !Buffer.from(headerText, 'utf8').equals(header) ||
    headerText.includes('\0') ||
    headerText.includes('\r')
  ) {
    fail(`${role} tag object is malformed`);
  }
  const lines = headerText.split('\n');
  if (
    lines.length !== 4 ||
    !lines[0].startsWith('object ') ||
    !lines[1].startsWith('type ') ||
    !lines[2].startsWith('tag ') ||
    !lines[3].startsWith('tagger ')
  ) {
    fail(`${role} tag object is malformed`);
  }
  const target = lines[0].slice('object '.length);
  const targetType = lines[1].slice('type '.length);
  const name = lines[2].slice('tag '.length);
  const tagger = lines[3];
  if (!gitSha1Pattern.test(target) || targetType !== 'commit') {
    fail(`${role} tag must target a commit directly`);
  }
  if (
    !/^tagger .+ <[^<>\n]+> -?[0-9]+ [+-][0-9]{4}$/.test(tagger)
  ) {
    fail(`${role} tag object is malformed`);
  }
  return {
    objectId,
    target,
    name,
    tagger,
    body: raw.subarray(separator + 2),
  };
}

function assertTagTarget(tag, expectedTarget, role) {
  if (tag.target !== expectedTarget) {
    fail(`${role} tag must target the expected commit`);
  }
  let peeled;
  try {
    peeled = gitWithoutReplacementObjects(
      'rev-parse',
      '--verify',
      `${tag.objectId}^{commit}`,
    );
  } catch {
    fail(`${role} tag must target the expected commit`);
  }
  if (peeled !== expectedTarget) {
    fail(`${role} tag must target the expected commit`);
  }
}

function assertCanonicalTagEnvelope(tag, {
  role,
  version,
  message,
  signed,
}) {
  if (tag.name !== version) fail(`${role} tag name must equal publication version`);
  if (role === 'public') assertPinnedTaggerIdentity(tag.tagger);
  if (!signed) {
    if (
      tag.body.includes(pgpSignatureBegin) ||
      tag.body.includes(Buffer.from('-----BEGIN SSH SIGNATURE-----'))
    ) {
      fail('public tag must be unsigned in publication contract v1');
    }
    if (!tag.body.equals(message)) {
      fail(`${role} tag message must exactly match publication provenance`);
    }
    return;
  }

  const signatureOffset = tag.body.indexOf(pgpSignatureBegin);
  if (signatureOffset < 0) {
    if (!tag.body.equals(message)) {
      fail(`${role} tag message must exactly match publication provenance`);
    }
    fail('source tag must have one OpenPGP signature');
  }
  if (!tag.body.subarray(0, signatureOffset).equals(message)) {
    fail(`${role} tag message must exactly match publication provenance`);
  }
  const signature = tag.body.subarray(signatureOffset);
  const firstBegin = signature.indexOf(pgpSignatureBegin);
  const secondBegin = signature.indexOf(
    pgpSignatureBegin,
    pgpSignatureBegin.length,
  );
  const firstEnd = signature.indexOf(pgpSignatureEnd);
  const secondEnd = signature.indexOf(
    pgpSignatureEnd,
    firstEnd < 0 ? 0 : firstEnd + pgpSignatureEnd.length,
  );
  if (
    firstBegin !== 0 ||
    secondBegin !== -1 ||
    firstEnd < pgpSignatureBegin.length ||
    secondEnd !== -1 ||
    firstEnd + pgpSignatureEnd.length !== signature.length ||
    signature.includes(Buffer.from('\0')) ||
    signature.includes(Buffer.from('\r'))
  ) {
    fail('source tag must have one OpenPGP signature');
  }
}

function verifySourceTagSignature(tagObject, expectedFingerprint, revokedKeys) {
  const result = spawnSync(
    'git',
    [
      '--no-replace-objects',
      '-c',
      'gpg.format=openpgp',
      '-c',
      'gpg.program=gpg',
      '-c',
      'gpg.openpgp.program=gpg',
      'verify-tag',
      '--raw',
      tagObject,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try { validateSignatureStatus(result, expectedFingerprint, [...revokedKeys]); }
  catch (error) { fail(error.message); }
}

const parsedArguments = parseArguments(process.argv.slice(2));
const head = parsedArguments.values.get('--head') || 'HEAD';
const base = parsedArguments.values.get('--base');
const sourceRef = parsedArguments.values.get('--require-source-ref');
const repoName = parsedArguments.values.get('--repo-name') || 'local';
const treeOnly = parsedArguments.treeOnly;
const publicationCommitRef = parsedArguments.values.get('--publication-commit');
const publicBaseRef = parsedArguments.values.get('--public-base');
const exportProvenancePath = parsedArguments.values.get('--export-provenance');
const expectedPolicyHash = parsedArguments.values.get('--policy-hash');
const publicationVersion = parsedArguments.values.get('--version');
const publicationTagRef = parsedArguments.values.get('--publication-tag');
const sourceTagRef = parsedArguments.values.get('--source-tag');
const sourceSigningKeyValue = parsedArguments.values.get('--source-tag-signing-key');
const publicationRequested = [
  publicationCommitRef,
  publicBaseRef,
  exportProvenancePath,
  expectedPolicyHash,
  publicationVersion,
  publicationTagRef,
  sourceTagRef,
  sourceSigningKeyValue,
].some(Boolean) || parsedArguments.revokedSigningKeys.length > 0;

if (treeOnly && base) {
  fail('--tree-only cannot be combined with --base.');
}
if (
  publicationRequested &&
  (parsedArguments.values.has('--head') || base || treeOnly)
) {
  fail('publication mode cannot combine with --head/--base/--tree-only.');
}
if (publicationCommitRef && !publicBaseRef) {
  fail('--public-base is required in publication mode.');
}
if (publicBaseRef && !publicationCommitRef) {
  fail('--public-base requires --publication-commit.');
}
if (publicationRequested && !publicationCommitRef) {
  fail('--publication-commit is required in publication mode.');
}
if (publicationCommitRef && !exportProvenancePath) {
  fail('--export-provenance is required in publication mode.');
}
if (publicationCommitRef && !expectedPolicyHash) {
  fail('--policy-hash is required in publication mode.');
}
if (publicationCommitRef && !publicationVersion) {
  fail('--version is required in publication mode.');
}
if (publicationCommitRef && (!publicationTagRef || !sourceTagRef)) {
  fail('--publication-tag and --source-tag are required in publication mode.');
}
if (publicationCommitRef && !sourceSigningKeyValue) {
  fail('--source-tag-signing-key is required in publication mode.');
}
if (expectedPolicyHash && !sha256Pattern.test(expectedPolicyHash)) {
  fail('--policy-hash must be a lowercase SHA-256 digest.');
}
if (publicationVersion && !versionPattern.test(publicationVersion)) {
  fail('--version must use the exact vX.Y.Z form.');
}
const sourceSigningKey = sourceSigningKeyValue
  ? sourceSigningKeyValue.toUpperCase()
  : null;
if (sourceSigningKey && !fingerprintPattern.test(sourceSigningKey)) {
  fail('--source-tag-signing-key must be a full OpenPGP fingerprint.');
}
const revokedSigningKeys = new Set();
for (const value of parsedArguments.revokedSigningKeys) {
  const fingerprint = value.toUpperCase();
  if (!fingerprintPattern.test(fingerprint) || revokedSigningKeys.has(fingerprint)) {
    fail('--revoked-signing-key must contain unique full fingerprints.');
  }
  revokedSigningKeys.add(fingerprint);
}

let headCommit;
let publicationCommit;
let publicationTree;
let publicBaseCommit;
let exportProvenance;
let publicationTag;
let sourceTag;
if (publicationCommitRef) {
  let replacementRefs;
  try {
    replacementRefs = gitWithoutReplacementObjects(
      'for-each-ref',
      '--format=%(refname)',
      'refs/replace/',
    );
  } catch {
    fail('could not inspect refs/replace');
  }
  if (replacementRefs) fail('refs/replace must be empty in publication mode');

  exportProvenance = readExportProvenance(
    exportProvenancePath,
    expectedPolicyHash,
  );
  try {
    publicationCommit = gitWithoutReplacementObjects(
      'rev-parse',
      `${publicationCommitRef}^{commit}`,
    );
    publicationTree = gitWithoutReplacementObjects(
      'rev-parse',
      `${publicationCommit}^{tree}`,
    );
  } catch {
    fail('publication commit is not a commit');
  }
  try {
    publicBaseCommit = gitWithoutReplacementObjects(
      'rev-parse',
      `${publicBaseRef}^{commit}`,
    );
  } catch {
    fail('public base is not a commit');
  }
  if (publicBaseCommit !== exportProvenance.intendedPublicBase) {
    fail('public base must match export provenance intended public base');
  }

  requireObjectType(
    exportProvenance.sourceCommit,
    'commit',
    'export provenance source commit is not available',
  );
  requireObjectType(
    exportProvenance.sourceTree,
    'tree',
    'export provenance source tree is not available',
  );
  requireObjectType(
    exportProvenance.exportedTree,
    'tree',
    'export provenance exported tree is not available',
  );
  let resolvedSourceTree;
  try {
    resolvedSourceTree = gitWithoutReplacementObjects(
      'rev-parse',
      `${exportProvenance.sourceCommit}^{tree}`,
    );
  } catch {
    fail('could not resolve source tree from export provenance');
  }
  if (resolvedSourceTree !== exportProvenance.sourceTree) {
    fail('source tree does not match source commit in export provenance');
  }
  if (publicationTree !== exportProvenance.exportedTree) {
    fail('publication tree must equal exported tree from export provenance');
  }
  const exportedEntries = listTreeEntries(
    exportProvenance.exportedTree,
    'exported',
  );
  const exportedPaths = exportedEntries.map((entry) => entry.path);
  if (
    exportedPaths.length !== exportProvenance.pathset.length ||
    exportedPaths.some(
      (entry, index) => entry !== exportProvenance.pathset[index],
    )
  ) {
    fail('export provenance manifest does not match exported tree');
  }
  const sourceEntries = listTreeEntries(exportProvenance.sourceTree, 'source');
  const sourcePaths = sourceEntries.map((entry) => entry.path);
  const manifestedSourcePaths = [
    ...exportProvenance.pathset,
    ...exportProvenance.excludedPaths,
  ].sort();
  if (
    sourcePaths.length !== manifestedSourcePaths.length ||
    sourcePaths.some((entry, index) => entry !== manifestedSourcePaths[index])
  ) {
    fail('export provenance manifest does not match source tree');
  }
  const sourceEntriesByPath = new Map(
    sourceEntries.map((entry) => [entry.path, entry]),
  );
  for (const exportedEntry of exportedEntries) {
    const sourceEntry = sourceEntriesByPath.get(exportedEntry.path);
    if (
      !sourceEntry ||
      sourceEntry.mode !== exportedEntry.mode ||
      sourceEntry.type !== exportedEntry.type ||
      sourceEntry.objectId !== exportedEntry.objectId
    ) {
      fail('exported tree must be an exact path-filtered projection of source tree');
    }
  }

  if (exportedEntries.some((entry) => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) {
    fail('publication exported tree accepts regular files only');
  }

  // Fail-closed ancestry: P must be a single-parent commit rooted exactly on
  // the public base, introducing no other reachable history (KE1/KE2).
  const commitEnvelope = parseRawCommit(publicationCommit);
  if (commitEnvelope.tree !== publicationTree) {
    fail('publication commit object tree does not match resolved tree');
  }
  assertPinnedCommitIdentity(commitEnvelope.author, 'author');
  assertPinnedCommitIdentity(commitEnvelope.committer, 'committer');
  const sourceTimestamp = gitWithoutReplacementObjects(
    'show', '-s', '--format=%ct', exportProvenance.sourceCommit,
  );
  const fixedTimestamp = `${sourceTimestamp} +0000`;
  const expectedCommitMessage = Buffer.from(
    `chore(release): ${publicationVersion}\n\n` +
    `source: gitea/${exportProvenance.sourceCommit}\n` +
    `source-tree: ${exportProvenance.exportedTree}\n`,
  );
  if (
    !commitEnvelope.body.equals(expectedCommitMessage) ||
    commitEnvelope.author !== `author ${pinnedBotName} <${pinnedBotEmail}> ${fixedTimestamp}` ||
    commitEnvelope.committer !== `committer ${pinnedBotName} <${pinnedBotEmail}> ${fixedTimestamp}`
  ) fail('canonical publication message, timestamps, and unsigned headers are required');
  if (commitEnvelope.parents.length !== 1) {
    fail('publication commit must have exactly one parent');
  }
  if (commitEnvelope.parents[0] !== publicBaseCommit) {
    fail('publication commit parent must equal public base');
  }
  if (commitEnvelope.headers.length !== 4) fail('canonical publication unsigned headers are required');
  let exclusiveHistory;
  try {
    exclusiveHistory = gitWithoutReplacementObjects(
      'rev-list',
      publicationCommit,
      `^${publicBaseCommit}`,
    );
  } catch {
    fail('could not verify publication commit ancestry against public base');
  }
  const exclusiveCommits = exclusiveHistory
    ? exclusiveHistory.split('\n').filter(Boolean)
    : [];
  if (
    exclusiveCommits.length !== 1 ||
    exclusiveCommits[0] !== publicationCommit
  ) {
    fail(
      'publication commit must introduce no history beyond itself relative to public base',
    );
  }

  const tagMessage = expectedTagMessage(
    publicationVersion,
    exportProvenance.sourceCommit,
    exportProvenance.exportedTree,
  );
  publicationTag = readTagObject(publicationTagRef, 'public');
  sourceTag = readTagObject(sourceTagRef, 'source');
  if (publicationTag.objectId === sourceTag.objectId) {
    fail('public and source tag object ids must be distinct');
  }
  assertTagTarget(publicationTag, publicationCommit, 'public');
  assertTagTarget(sourceTag, exportProvenance.sourceCommit, 'source');
  assertCanonicalTagEnvelope(publicationTag, {
    role: 'public',
    version: publicationVersion,
    message: tagMessage,
    signed: false,
  });
  if (publicationTag.tagger !== `tagger ${pinnedBotName} <${pinnedBotEmail}> ${fixedTimestamp}`) {
    fail('canonical publication tag timestamp is required');
  }
  assertCanonicalTagEnvelope(sourceTag, {
    role: 'source',
    version: publicationVersion,
    message: tagMessage,
    signed: true,
  });
  verifySourceTagSignature(
    sourceTag.objectId,
    sourceSigningKey,
    revokedSigningKeys,
  );
} else {
  try {
    headCommit = git('rev-parse', `${head}^{commit}`);
  } catch {
    fail('publication head is not a commit or annotated tag');
  }
}

if (sourceRef) {
  let sourceCommit;
  try {
    const resolveSourceCommit = publicationCommit
      ? gitWithoutReplacementObjects
      : git;
    sourceCommit = resolveSourceCommit('rev-parse', `${sourceRef}^{commit}`);
  } catch {
    fail('configured source ref is not a commit');
  }
  const expectedSourceCommit = publicationCommit
    ? exportProvenance.sourceCommit
    : headCommit;
  if (sourceCommit !== expectedSourceCommit) {
    fail('publication head does not exactly match the configured source ref');
  }
}

const args = [
  privacyGate,
  '--root',
  process.cwd(),
  '--repo-name',
  repoName,
  '--require-forbidden-hosts',
  '--fail-on-warn',
];

if (publicationCommit) {
  args.push(
    '--commit-envelope',
    publicationCommit,
    '--tree',
    exportProvenance.exportedTree,
    '--tag-envelope',
    publicationTag.objectId,
    '--tag-envelope',
    sourceTag.objectId,
    '--allowlist-pathset',
    exportProvenancePath,
  );
} else {
  args.push('--ref', head);

  if (base) {
    let baseCommit;
    try {
      baseCommit = git('rev-parse', `${base}^{commit}`);
    } catch {
      fail('publication base is not a commit');
    }
    if (baseCommit === headCommit || !isAncestor(baseCommit, headCommit)) {
      fail('publication base must be a strict ancestor of publication head');
    }
    args.push('--commit-range', `${baseCommit}..${headCommit}`);
  } else if (!treeOnly) {
    args.push('--commit-range', headCommit);
  }
}

const result = spawnSync('python3', args, {
  encoding: 'utf8',
  env: publicationCommit
    ? { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
    : process.env,
  stdio: 'inherit',
});
if (result.error) fail('could not start the publication privacy gate');
if (result.status !== 0) process.exit(result.status || 1);

if (publicationCommit) {
  console.log(
    `OK - publication preflight passed for ${publicationCommit.slice(0, 12)}; ` +
    'validated divergent export provenance and two-tag envelope.',
  );
} else {
  console.log(`OK - publication preflight passed for ${headCommit.slice(0, 12)}.`);
}
