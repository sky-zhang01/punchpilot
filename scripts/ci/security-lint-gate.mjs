#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { ESLint } from 'eslint';
import security from 'eslint-plugin-security';

const require = createRequire(import.meta.url);
const BASELINE_FILE = 'security-lint-baseline.json';
const CONFIG_FILE = 'eslint.config.mjs';
const SCHEMA_VERSION = 2;
const ESLINT_VERSION = require('eslint/package.json').version;
const PLUGIN_SECURITY_VERSION = require('eslint-plugin-security/package.json').version;
const RECOMMENDED_RULES = new Set(Object.keys(security.configs.recommended.rules));
const HIGH_CONFIDENCE_RULES = new Set([
  'security/detect-bidi-characters',
  'security/detect-buffer-noassert',
  'security/detect-child-process',
  'security/detect-disable-mustache-escape',
  'security/detect-eval-with-expression',
  'security/detect-new-buffer',
  'security/detect-no-csrf-before-method-override',
  'security/detect-non-literal-require',
  'security/detect-possible-timing-attacks',
  'security/detect-pseudoRandomBytes',
]);
const DOCUMENT_KEYS = [
  'schema_version',
  'eslint_version',
  'plugin_security_version',
  'config_sha256',
  'warnings',
];
const WARNING_KEYS = [
  'path',
  'rule',
  'message',
  'source_line_sha256',
  'source_file_sha256',
  'column',
  'occurrence',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unexpected, missing, or non-canonical fields`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareWarnings(left, right) {
  return compareStrings(left.path, right.path) ||
    compareStrings(left.rule, right.rule) ||
    compareStrings(left.source_file_sha256, right.source_file_sha256) ||
    compareStrings(left.source_line_sha256, right.source_line_sha256) ||
    left.column - right.column ||
    left.occurrence - right.occurrence ||
    compareStrings(left.message, right.message);
}

function findingKey(finding, keys = WARNING_KEYS) {
  return JSON.stringify(keys.map((key) => finding[key]));
}

function severityValue(ruleConfig) {
  const configured = Array.isArray(ruleConfig) ? ruleConfig[0] : ruleConfig;
  if (configured === 'error') return 2;
  if (configured === 'warn') return 1;
  if (configured === 'off') return 0;
  return Number.isInteger(configured) ? configured : -1;
}

function readRepoRegularFile(root, relativePath, label) {
  const filePath = path.join(root, relativePath);
  let metadata;
  try {
    metadata = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} must be a readable repository file`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular repository file`);
  }
  try {
    return { filePath, contents: fs.readFileSync(filePath) };
  } catch {
    throw new Error(`${label} must be a readable repository file`);
  }
}

function toRepoPath(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Security lint returned a path outside the repository');
  }
  return relative.split(path.sep).join('/');
}

function listServerJavaScriptFiles(root) {
  const serverRoot = path.join(root, 'server');
  const serverMetadata = fs.lstatSync(serverRoot);
  if (serverMetadata.isSymbolicLink() || !serverMetadata.isDirectory()) {
    throw new Error('server must be a directory');
  }

  const files = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Security lint source path must not be a symbolic link: ${toRepoPath(root, target)}`);
      }
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(target);
      } else if (!entry.isFile()) {
        throw new Error(`Security lint source path has an unsupported type: ${toRepoPath(root, target)}`);
      }
    }
  }
  visit(serverRoot);
  if (files.length === 0) throw new Error('Security lint found no server JavaScript files');
  return files;
}

async function assertSecurityConfiguration(eslint, root, files) {
  for (const file of files) {
    const repoPath = toRepoPath(root, file);
    if (await eslint.isPathIgnored(file)) {
      throw new Error(`Security lint source is ignored: ${repoPath}`);
    }
    const config = await eslint.calculateConfigForFile(file);
    if (!config?.rules) throw new Error(`Security lint has no configuration for ${repoPath}`);
    if (config.linterOptions?.noInlineConfig !== true) {
      throw new Error(`Security lint must disable inline configuration for ${repoPath}`);
    }
    for (const rule of RECOMMENDED_RULES) {
      const severity = severityValue(config.rules[rule]);
      if (severity < 1) {
        throw new Error(`Recommended security rule is disabled for ${repoPath}: ${rule}`);
      }
      if (HIGH_CONFIDENCE_RULES.has(rule) && severity !== 2) {
        throw new Error(`High-confidence security rule must be an error for ${repoPath}: ${rule}`);
      }
    }
  }
}

function normalizedSource(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

function safeLintLocation(repoPath, message) {
  const line = Number.isInteger(message.line) ? message.line : 0;
  const column = Number.isInteger(message.column) ? message.column : 0;
  return `${repoPath}:${line}:${column}`;
}

export async function buildSecurityLintSnapshot(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const configFile = readRepoRegularFile(absoluteRoot, CONFIG_FILE, 'Security lint configuration');
  const configPath = configFile.filePath;
  const files = listServerJavaScriptFiles(absoluteRoot);
  const eslint = new ESLint({
    cwd: absoluteRoot,
    overrideConfigFile: configPath,
    allowInlineConfig: false,
    cache: false,
    errorOnUnmatchedPattern: true,
  });

  await assertSecurityConfiguration(eslint, absoluteRoot, files);
  const results = await eslint.lintFiles(files);
  const expectedPaths = new Set(files.map((file) => toRepoPath(absoluteRoot, file)));
  const records = [];

  for (const result of results) {
    const repoPath = toRepoPath(absoluteRoot, result.filePath);
    if (!expectedPaths.delete(repoPath)) {
      throw new Error(`Security lint returned an unexpected or duplicate file: ${repoPath}`);
    }
    if ((result.suppressedMessages || []).length > 0) {
      throw new Error(`Security lint returned an unexpected suppression for ${repoPath}`);
    }
    const source = normalizedSource(result.filePath);
    const sourceLines = source.split('\n');
    const sourceFileSha256 = sha256(source);
    for (const message of result.messages) {
      const location = safeLintLocation(repoPath, message);
      if (message.fatal || message.severity === 2) {
        throw new Error(`Security lint error at ${location}`);
      }
      if (message.severity === 0) continue;
      if (
        message.severity !== 1 ||
        typeof message.ruleId !== 'string' ||
        !RECOMMENDED_RULES.has(message.ruleId)
      ) {
        throw new Error(`Unexpected lint warning at ${location}`);
      }
      if (HIGH_CONFIDENCE_RULES.has(message.ruleId)) {
        throw new Error(`High-confidence security rule must remain an error: ${location}`);
      }
      if (
        !Number.isInteger(message.line) ||
        message.line < 1 ||
        message.line > sourceLines.length ||
        !Number.isInteger(message.column) ||
        message.column < 1
      ) {
        throw new Error(`Security lint returned an invalid location for ${repoPath}`);
      }
      if (
        typeof message.message !== 'string' ||
        !message.message ||
        message.message.length > 200 ||
        /[\r\n]/.test(message.message)
      ) {
        throw new Error(`Security lint returned an invalid diagnostic for ${location}`);
      }

      records.push({
        path: repoPath,
        rule: message.ruleId,
        message: message.message,
        source_line_sha256: sha256(sourceLines[message.line - 1]),
        source_file_sha256: sourceFileSha256,
        column: message.column,
        line: message.line,
        endLine: Number.isInteger(message.endLine) ? message.endLine : message.line,
        endColumn: Number.isInteger(message.endColumn) ? message.endColumn : message.column,
      });
    }
  }
  if (expectedPaths.size > 0 || results.length !== files.length) {
    throw new Error('Security lint did not return every enumerated server JavaScript file');
  }

  records.sort((left, right) =>
    compareStrings(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    compareStrings(left.rule, right.rule) ||
    compareStrings(left.message, right.message));

  const occurrences = new Map();
  const diagnostics = new Map();
  const warnings = [];
  for (const record of records) {
    const stem = JSON.stringify([
      record.path,
      record.rule,
      record.message,
      record.source_line_sha256,
      record.source_file_sha256,
      record.column,
    ]);
    const occurrence = (occurrences.get(stem) || 0) + 1;
    occurrences.set(stem, occurrence);
    const finding = {
      path: record.path,
      rule: record.rule,
      message: record.message,
      source_line_sha256: record.source_line_sha256,
      source_file_sha256: record.source_file_sha256,
      column: record.column,
      occurrence,
    };
    diagnostics.set(
      findingKey(finding),
      { line: record.line, column: record.column },
    );
    warnings.push(finding);
  }
  warnings.sort(compareWarnings);

  return {
    document: {
      schema_version: SCHEMA_VERSION,
      eslint_version: ESLINT_VERSION,
      plugin_security_version: PLUGIN_SECURITY_VERSION,
      config_sha256: sha256(configFile.contents),
      warnings,
    },
    diagnostics,
  };
}

function validRepoWarningPath(value) {
  return typeof value === 'string' &&
    value.startsWith('server/') &&
    value.endsWith('.js') &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..');
}

export function validateBaselineDocument(document) {
  assertPlainObject(document, 'Security lint baseline');
  assertExactKeys(document, DOCUMENT_KEYS, 'Security lint baseline');
  if (document.schema_version !== SCHEMA_VERSION) {
    throw new Error('Security lint baseline uses an unsupported schema version');
  }
  for (const [field, value] of [
    ['eslint_version', document.eslint_version],
    ['plugin_security_version', document.plugin_security_version],
  ]) {
    if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`Security lint baseline ${field} is invalid`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(document.config_sha256 || '')) {
    throw new Error('Security lint baseline config_sha256 is invalid');
  }
  if (!Array.isArray(document.warnings)) {
    throw new Error('Security lint baseline warnings must be an array');
  }
  const identities = new Set();
  for (const [index, finding] of document.warnings.entries()) {
    const label = `Security lint baseline warning ${index + 1}`;
    assertPlainObject(finding, label);
    assertExactKeys(finding, WARNING_KEYS, label);
    if (!validRepoWarningPath(finding.path)) {
      throw new Error(`${label} path must be a normalized repo-relative server JavaScript path`);
    }
    if (typeof finding.rule !== 'string' || !RECOMMENDED_RULES.has(finding.rule)) {
      throw new Error(`${label} rule is not an enabled security rule`);
    }
    if (HIGH_CONFIDENCE_RULES.has(finding.rule)) {
      throw new Error(`${label} cannot contain a high-confidence security rule`);
    }
    if (
      typeof finding.message !== 'string' ||
      !finding.message ||
      finding.message.length > 200 ||
      /[\r\n]/.test(finding.message)
    ) {
      throw new Error(`${label} message is invalid`);
    }
    for (const hashField of ['source_line_sha256', 'source_file_sha256']) {
      if (!/^[0-9a-f]{64}$/.test(finding[hashField] || '')) {
        throw new Error(`${label} ${hashField} is invalid`);
      }
    }
    if (!Number.isInteger(finding.column) || finding.column < 1) {
      throw new Error(`${label} column is invalid`);
    }
    if (!Number.isInteger(finding.occurrence) || finding.occurrence < 1) {
      throw new Error(`${label} occurrence is invalid`);
    }
    const key = findingKey(finding);
    if (identities.has(key)) throw new Error(`${label} duplicates another finding identity`);
    identities.add(key);
  }
  const sorted = [...document.warnings].sort(compareWarnings);
  if (JSON.stringify(sorted) !== JSON.stringify(document.warnings)) {
    throw new Error('Security lint baseline warnings must use canonical order');
  }
  return document;
}

export function parseCanonicalBaseline(text, label = BASELINE_FILE) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (canonicalJson(document) !== text) {
    throw new Error(`${label} must use canonical JSON without duplicate fields`);
  }
  return validateBaselineDocument(document);
}

function findingSummary(finding, keys, diagnostics) {
  const location = diagnostics.get(findingKey(finding, keys));
  const suffix = location ? `:${location.line}:${location.column}` : '';
  return `${finding.path}${suffix} ${finding.rule} ` +
    `file=${finding.source_file_sha256.slice(0, 12)} ` +
    `line=${finding.source_line_sha256.slice(0, 12)}`;
}

export function compareBaselineDocuments(expected, current, diagnostics = new Map()) {
  validateBaselineDocument(expected);
  validateBaselineDocument(current);
  const blockers = [];
  // eslint_version and plugin_security_version stay in the document as
  // provenance metadata but do not block: a toolchain version bump alone has
  // no bearing on reviewed findings. Configuration and finding identity do.
  for (const field of ['config_sha256']) {
    if (expected[field] !== current[field]) blockers.push(`${field} drifted from the reviewed baseline`);
  }

  function compareCollection(label, keys, expectedFindings, currentFindings, locations) {
    const expectedKeys = new Map(
      expectedFindings.map((finding) => [findingKey(finding, keys), finding]),
    );
    const currentKeys = new Map(
      currentFindings.map((finding) => [findingKey(finding, keys), finding]),
    );
    for (const [key, finding] of currentKeys) {
      if (!expectedKeys.has(key)) {
        blockers.push(`new ${label}: ${findingSummary(finding, keys, locations)}`);
      }
    }
    for (const [key, finding] of expectedKeys) {
      if (!currentKeys.has(key)) {
        blockers.push(`stale ${label}: ${findingSummary(finding, keys, new Map())}`);
      }
    }
  }
  compareCollection(
    'warning',
    WARNING_KEYS,
    expected.warnings,
    current.warnings,
    diagnostics || new Map(),
  );

  if (blockers.length > 0) {
    const error = new Error(`Security lint baseline rejected ${blockers.length} change(s).`);
    error.blockers = blockers;
    throw error;
  }
  return {
    warnings: current.warnings.length,
  };
}

export async function runSecurityLintGate(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const current = await buildSecurityLintSnapshot(absoluteRoot);
  const baselineFile = readRepoRegularFile(
    absoluteRoot,
    BASELINE_FILE,
    'Security lint baseline',
  );
  const expected = parseCanonicalBaseline(
    baselineFile.contents.toString('utf8'),
  );
  return compareBaselineDocuments(expected, current.document, current.diagnostics);
}

export async function updateSecurityLintBaseline(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const current = await buildSecurityLintSnapshot(absoluteRoot);
  const baselinePath = path.join(absoluteRoot, BASELINE_FILE);
  let existed = false;
  let previousDocument = null;
  let metadata = null;
  try {
    metadata = fs.lstatSync(baselinePath);
  } catch {
    metadata = null;
  }
  if (metadata) {
    existed = true;
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Security lint baseline must be a regular repository file');
    }
    previousDocument = parseCanonicalBaseline(
      fs.readFileSync(baselinePath, 'utf8'),
    );
  }

  const changes = [];
  if (previousDocument) {
    try {
      compareBaselineDocuments(
        previousDocument,
        current.document,
        current.diagnostics,
      );
    } catch (error) {
      changes.push(...(error.blockers || [error.message]));
    }
    for (const field of ['eslint_version', 'plugin_security_version']) {
      if (previousDocument[field] !== current.document[field]) {
        changes.push(`${field} provenance refreshed (non-blocking)`);
      }
    }
  }

  fs.writeFileSync(baselinePath, canonicalJson(current.document));
  return {
    baselineFile: BASELINE_FILE,
    created: !existed,
    changes,
    warnings: current.document.warnings.length,
  };
}

const USAGE = 'Usage: security-lint-gate.mjs [--print-baseline|--update]';

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !['--print-baseline', '--update'].includes(args[0]))
  ) {
    throw new Error(USAGE);
  }
  if (args[0] === '--print-baseline') {
    const current = await buildSecurityLintSnapshot(process.cwd());
    process.stdout.write(canonicalJson(current.document));
    return;
  }
  if (args[0] === '--update') {
    const result = await updateSecurityLintBaseline(process.cwd());
    if (result.created) {
      console.log(`Created ${result.baselineFile} (${result.warnings} warning(s)).`);
    } else if (result.changes.length === 0) {
      console.log(
        `${result.baselineFile} already matches the current toolchain and findings; rewritten unchanged.`,
      );
    } else {
      for (const change of result.changes) console.log(`changed: ${change}`);
      console.log(
        `Updated ${result.baselineFile} (${result.warnings} warning(s)).`,
      );
    }
    console.log(
      'Commit the baseline diff with the change that caused it for human review; CI still fails on any drift.',
    );
    return;
  }
  const result = await runSecurityLintGate(process.cwd());
  console.log(`OK - ${result.warnings} security lint finding(s) match the exact baseline.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    for (const blocker of error.blockers || []) console.error(blocker);
    process.exit(1);
  });
}
