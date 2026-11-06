#!/usr/bin/env node

/**
 * Runtime Absence Assertion for Forbidden Internal Hosts
 * 
 * Derives forbidden hostnames from `PUBLIC_RELEASE_FORBIDDEN_HOSTS` CI marker
 * and asserts that no derived host (or its split / assembled / encoded forms)
 * is present in the repository codebase.
 * 
 * MUST FAIL CLOSED if `PUBLIC_RELEASE_FORBIDDEN_HOSTS` is empty, unset, or invalid.
 * MUST NOT import or invoke `scripts/ci/public-release-privacy-gate.py`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse raw PUBLIC_RELEASE_FORBIDDEN_HOSTS environment variable into normalized hostnames.
 * Returns null if missing, empty, or whitespace-only (triggering fail-closed mode).
 */
export function parseForbiddenHosts(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const hosts = [];
  for (let item of raw.split(/[\s,]+/)) {
    item = item.trim();
    if (!item) continue;
    if (item.startsWith('*.')) {
      item = item.slice(2);
    }
    item = item.replace(/\.+$/, '').toLowerCase();
    if (item) {
      hosts.push(item);
    }
  }
  return hosts.length > 0 ? hosts : null;
}

/**
 * Build regexes for detecting hostname in literal, split, tokenized, encoded, or concatenated forms.
 */
export function buildHostRegexes(hostname) {
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 2) {
    return [];
  }

  const escapedLabels = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // Separators between labels:
  // - literal dot, URL encoded (%2e), hex (\x2e), unicode (\u002e), octal (\056)
  // - quotes, commas, pluses, spaces surrounding separators for split array / join / concat idioms
  const sep = '(?:\\s*[\x27"\`]\\s*)?(?:\\+|\\,)?(?:\\s*[\x27"\`]\\s*)?(?:\\.|%2[eE]|\\\\u002[eE]|\\\\x2[eE]|\\\\056|,|\\+)(?:\\s*[\x27"\`]\\s*)?(?:\\+|\\,)?(?:\\s*[\x27"\`]\\s*)?';

  const pattern = `(?<![A-Za-z0-9-])` + escapedLabels.join(sep) + `(?![A-Za-z0-9-])`;

  return [new RegExp(pattern, 'i')];
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  '.npm',
  '.next',
]);

/**
 * Check if a file should be skipped based on path or binary content.
 */
export function isBinaryFile(buffer) {
  const checkLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively collect files to scan under root.
 */
export function collectFiles(rootDir, currentDir = rootDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (!DEFAULT_EXCLUDE_DIRS.has(entry.name)) {
        results.push(...collectFiles(rootDir, fullPath));
      }
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Scan a single file for forbidden host patterns.
 * Returns array of findings: { file, line }.
 */
export function scanFile(filePath, rootDir, regexes) {
  const findings = [];
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return findings;
  }

  if (isBinaryFile(buffer)) {
    return findings;
  }

  const content = buffer.toString('utf8');
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');

  for (const regex of regexes) {
    let match;
    const gRegex = new RegExp(regex.source, regex.flags + (regex.flags.includes('g') ? '' : 'g'));
    while ((match = gRegex.exec(content)) !== null) {
      const lineNumber = content.slice(0, match.index).split('\n').length;
      findings.push({
        file: relPath,
        line: lineNumber,
      });
      if (match.index === gRegex.lastIndex) {
        gRegex.lastIndex++;
      }
    }
  }

  return findings;
}

/**
 * Execute the host absence check.
 * Options:
 * - root: root directory to scan (default process.cwd())
 * - hostsEnv: raw forbidden hosts string (default process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS)
 * - silent: boolean (default false)
 */
export function runAbsenceCheck(options = {}) {
  const rootDir = path.resolve(options.root || process.cwd());
  const rawHosts = options.hostsEnv !== undefined
    ? options.hostsEnv
    : process.env.PUBLIC_RELEASE_FORBIDDEN_HOSTS;

  const hosts = parseForbiddenHosts(rawHosts);
  if (!hosts) {
    const errMessage = '[FAIL-CLOSED] PUBLIC_RELEASE_FORBIDDEN_HOSTS is required and must contain non-empty forbidden hostname(s).';
    if (!options.silent) {
      console.error(errMessage);
    }
    return {
      success: false,
      reason: 'FAIL_CLOSED',
      findings: [],
      error: errMessage,
    };
  }

  const allRegexes = [];
  for (const host of hosts) {
    allRegexes.push(...buildHostRegexes(host));
  }

  const files = collectFiles(rootDir);
  const allFindings = [];

  for (const file of files) {
    const findings = scanFile(file, rootDir, allRegexes);
    allFindings.push(...findings);
  }

  if (allFindings.length > 0) {
    if (!options.silent) {
      console.error(`[FAIL] Forbidden host pattern detected in ${allFindings.length} location(s):`);
      for (const f of allFindings) {
        console.error(`  - ${f.file}:${f.line}`);
      }
    }
    return {
      success: false,
      reason: 'FORBIDDEN_HOST_DETECTED',
      findings: allFindings,
    };
  }

  if (!options.silent) {
    console.log('[OK] Runtime host absence check passed. No forbidden host patterns detected across repository.');
  }

  return {
    success: true,
    reason: 'CLEAN',
    findings: [],
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = runAbsenceCheck();
  if (!result.success) {
    process.exit(1);
  }
}
