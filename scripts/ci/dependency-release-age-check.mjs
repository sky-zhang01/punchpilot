#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_HOST = 'registry.npmjs.org';
const MAX_CONCURRENCY = 12;
const PUBLIC_ADVISORY_HOSTS = new Set([
  'cve.org',
  'github.com',
  'nvd.nist.gov',
  'osv.dev',
  'www.cve.org',
]);

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packageNameFromLocation(location) {
  const marker = 'node_modules/';
  const index = location.lastIndexOf(marker);
  if (index === -1) return '';
  const parts = location.slice(index + marker.length).split('/');
  return parts[0]?.startsWith('@')
    ? `${parts[0] || ''}/${parts[1] || ''}`
    : parts[0] || '';
}

function registryTarballUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} does not use a valid registry tarball URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== REGISTRY_HOST ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('.tgz')
  ) {
    throw new Error(`${label} must resolve to an HTTPS npm registry tarball`);
  }
  return url.href;
}

export function collectLockedArtifacts(lock, label = 'package-lock.json') {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error(`${label} must be a package-lock v3 file`);
  }
  const artifacts = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || entry?.link) continue;
    const name = typeof entry?.name === 'string' && entry.name
      ? entry.name
      : packageNameFromLocation(location);
    const version = typeof entry?.version === 'string' ? entry.version : '';
    if (!name || !version) {
      throw new Error(`${label}:${location} is missing an exact package identity`);
    }
    if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
      throw new Error(`${label}:${location} is missing a SHA-512 registry integrity value`);
    }
    artifacts.push({
      name,
      version,
      url: registryTarballUrl(entry.resolved, `${label}:${location}`),
      source: label,
    });
  }
  return artifacts;
}

export function collectPackageManagerArtifact(manifests) {
  const pins = manifests.map(({ manifest, label }) => {
    const match = String(manifest?.packageManager || '').match(/^npm@(\d+\.\d+\.\d+)$/);
    if (!match) throw new Error(`${label} must pin an exact npm packageManager version`);
    return match[1];
  });
  if (new Set(pins).size !== 1) {
    throw new Error('Server and client packageManager pins must match');
  }
  const version = pins[0];
  return {
    name: 'npm',
    version,
    url: `https://${REGISTRY_HOST}/npm/-/npm-${version}.tgz`,
    source: manifests.map(({ label }) => label).join(', '),
  };
}

function exactException(exception, index) {
  const label = `release-age exception ${index + 1}`;
  if (
    !exception ||
    typeof exception.package !== 'string' ||
    !exception.package ||
    typeof exception.version !== 'string' ||
    !exception.version ||
    !validIsoDate(exception.expires_at || '') ||
    typeof exception.statement !== 'string' ||
    exception.statement.trim().length < 20
  ) {
    throw new Error(`${label} must be exact, expiring, and justified`);
  }
  let advisory;
  try {
    advisory = new URL(exception.advisory_url);
  } catch {
    throw new Error(`${label} must reference a public HTTPS advisory`);
  }
  if (
    advisory.protocol !== 'https:' ||
    advisory.username ||
    advisory.password ||
    advisory.port ||
    !PUBLIC_ADVISORY_HOSTS.has(advisory.hostname)
  ) {
    throw new Error(`${label} must reference a public HTTPS advisory`);
  }
  return {
    ...exception,
    key: `${exception.package}\u0000${exception.version}`,
    expiresAt: Date.parse(`${exception.expires_at}T23:59:59.999Z`),
  };
}

export function normalizePolicy(policy) {
  if (
    !Number.isInteger(policy?.minimum_age_days) ||
    policy.minimum_age_days < 1 ||
    policy.minimum_age_days > 30 ||
    !Array.isArray(policy?.exceptions)
  ) {
    throw new Error('Invalid dependency release-age policy');
  }
  const exceptions = policy.exceptions.map(exactException);
  if (new Set(exceptions.map((entry) => entry.key)).size !== exceptions.length) {
    throw new Error('Dependency release-age exceptions must be unique');
  }
  return { minimumAgeDays: policy.minimum_age_days, exceptions };
}

function uniqueArtifacts(artifacts) {
  const unique = new Map();
  for (const artifact of artifacts) {
    const key = `${artifact.name}\u0000${artifact.version}`;
    const existing = unique.get(key);
    if (existing && existing.url !== artifact.url) {
      throw new Error(`${artifact.name}@${artifact.version} resolves to multiple tarballs`);
    }
    if (!existing) unique.set(key, { ...artifact, key });
  }
  return [...unique.values()];
}

export function validateReleaseAges({ artifacts, policy, publishedAtByUrl, now = Date.now() }) {
  if (!Number.isFinite(now)) throw new Error('Invalid release-age validation time');
  const normalized = normalizePolicy(policy);
  const candidates = uniqueArtifacts(artifacts);
  const candidateKeys = new Set(candidates.map((artifact) => artifact.key));
  const usedExceptions = new Set();
  const blockers = [];

  for (const artifact of candidates) {
    const publishedAt = publishedAtByUrl.get(artifact.url);
    if (!Number.isFinite(publishedAt) || publishedAt > now + 5 * 60 * 1000) {
      blockers.push(`${artifact.name}@${artifact.version}: invalid registry publication time`);
      continue;
    }
    const eligibleAt = publishedAt + normalized.minimumAgeDays * DAY_MS;
    if (now >= eligibleAt) continue;

    const exception = normalized.exceptions.find((entry) => entry.key === artifact.key);
    if (exception) usedExceptions.add(exception.key);
    if (
      !exception ||
      now > exception.expiresAt ||
      exception.expiresAt > eligibleAt + DAY_MS
    ) {
      blockers.push(
        `${artifact.name}@${artifact.version}: published ${new Date(publishedAt).toISOString()}`,
      );
      continue;
    }
  }

  for (const exception of normalized.exceptions) {
    if (!candidateKeys.has(exception.key) || !usedExceptions.has(exception.key)) {
      blockers.push(`${exception.package}@${exception.version}: stale release-age exception`);
    }
  }
  if (blockers.length > 0) {
    const error = new Error(
      `Dependency release-age policy rejected ${blockers.length} artifact(s).`,
    );
    error.blockers = blockers;
    throw error;
  }
  return {
    artifacts: candidates.length,
    exceptions: usedExceptions.size,
  };
}

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function fetchPublishedAt(artifact) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(artifact.url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'PunchPilot dependency release-age gate' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      registryTarballUrl(response.url, `${artifact.name}@${artifact.version}`);
      const publishedAt = Date.parse(response.headers.get('last-modified') || '');
      if (!Number.isFinite(publishedAt)) throw new Error('missing Last-Modified');
      return [artifact.url, publishedAt];
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
  throw new Error(`${artifact.name}@${artifact.version}: registry HEAD failed (${lastError.message})`);
}

async function main() {
  const root = process.cwd();
  const rootManifest = readJson(path.join(root, 'package.json'));
  const clientManifest = readJson(path.join(root, 'client', 'package.json'));
  const artifacts = [
    ...collectLockedArtifacts(readJson(path.join(root, 'package-lock.json')), 'package-lock.json'),
    ...collectLockedArtifacts(
      readJson(path.join(root, 'client', 'package-lock.json')),
      'client/package-lock.json',
    ),
    collectPackageManagerArtifact([
      { manifest: rootManifest, label: 'package.json' },
      { manifest: clientManifest, label: 'client/package.json' },
    ]),
  ];
  const unique = uniqueArtifacts(artifacts);
  const publicationEntries = await withConcurrency(
    unique,
    MAX_CONCURRENCY,
    fetchPublishedAt,
  );
  const result = validateReleaseAges({
    artifacts,
    policy: readJson(path.join(root, 'dependency-release-age-policy.json')),
    publishedAtByUrl: new Map(publicationEntries),
  });
  console.log(
    `OK - ${result.artifacts} dependency artifacts satisfy the release-age policy ` +
    `(${result.exceptions} exception(s)).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    for (const blocker of error.blockers || []) console.error(blocker);
    process.exit(1);
  });
}
