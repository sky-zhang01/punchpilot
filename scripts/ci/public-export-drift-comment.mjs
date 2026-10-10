#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  comparePath,
  exportPublicTree,
  parseAllowlist,
} from './export-public-tree.mjs';

export const COMMENT_MARKER = '<!-- punchpilot-public-export-drift -->';
export const CONTRACT_LIMIT =
  'This report covers exported path-list membership only. It does not detect content changes ' +
  'within an already-exported path; the privacy gate is the content control.';
export const UNAVAILABLE_BODY = `${COMMENT_MARKER}\n\n## Public export drift\n\n` +
  `Report unavailable for this workflow attempt. See the compute step error for details.\n\n${CONTRACT_LIMIT}\n`;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_COMMENT_BYTES = 512 * 1024;
const API_TIMEOUT_MS = 10_000;
const COMMENTS_PER_PAGE = 50;
const MAX_COMMENT_PAGES = 200;

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha(value, label) {
  const sha = requireString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${label} must be a lowercase 40-hex commit SHA`);
  }
  return sha;
}

export function validatePullRequestEvent(event, { expectedRepository }) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be a JSON object');
  }
  const repository = requireString(expectedRepository, 'expected repository');
  if (event.repository?.full_name !== repository) {
    throw new Error('event repository does not match the expected repository');
  }
  const pull = event.pull_request;
  if (pull === null || typeof pull !== 'object' || Array.isArray(pull)) {
    throw new Error('event is not a pull_request event');
  }
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0) {
    throw new Error('pull_request.number must be a positive integer');
  }
  if (pull.base?.ref !== 'main') {
    throw new Error('pull request target must be main');
  }
  if (pull.base?.repo?.full_name !== repository || pull.head?.repo?.full_name !== repository) {
    throw new Error('public export drift comments are restricted to same-repository pull requests');
  }
  return {
    repository,
    pullNumber: pull.number,
    baseSha: requireSha(pull.base?.sha, 'pull_request.base.sha'),
    headSha: requireSha(pull.head?.sha, 'pull_request.head.sha'),
  };
}

function git(repoRoot, args, options = {}) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function requireCommit(repoRoot, sha, label) {
  try {
    git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    throw new Error(`${label} commit object is not available locally`);
  }
}

function requireAncestor(repoRoot, baseSha, headSha) {
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', baseSha, headSha]);
  } catch {
    throw new Error('pull_request.base.sha must be an ancestor of pull_request.head.sha');
  }
}

function policyAt(repoRoot, sha, label) {
  let text;
  try {
    text = git(repoRoot, ['show', `${sha}:.public-export/allowlist.json`]);
  } catch {
    throw new Error(`${label} does not contain .public-export/allowlist.json`);
  }
  return parseAllowlist(text, { source: `${label} allowlist` });
}

function setDifference(left, right) {
  const other = new Set(right);
  return left.filter((entry) => !other.has(entry)).sort(comparePath);
}

export function computeExportDrift({ repoRoot, event, expectedRepository }) {
  const pull = validatePullRequestEvent(event, { expectedRepository });
  let checkedOutHead;
  try {
    checkedOutHead = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  } catch {
    throw new Error('could not resolve the checked-out HEAD commit');
  }
  if (checkedOutHead !== pull.headSha) {
    throw new Error('checked-out HEAD does not match pull_request.head.sha');
  }
  requireCommit(repoRoot, pull.baseSha, 'base');
  requireCommit(repoRoot, pull.headSha, 'head');
  requireAncestor(repoRoot, pull.baseSha, pull.headSha);

  const basePolicy = policyAt(repoRoot, pull.baseSha, 'base');
  const headPolicy = policyAt(repoRoot, pull.headSha, 'head');
  const base = exportPublicTree({
    repoRoot,
    source: pull.baseSha,
    policy: basePolicy,
    scan: false,
  });
  const head = exportPublicTree({
    repoRoot,
    source: pull.headSha,
    policy: headPolicy,
    scan: false,
  });
  const basePaths = [...base.provenance.pathset].sort(comparePath);
  const headPaths = [...head.provenance.pathset].sort(comparePath);

  return {
    ...pull,
    basePathsetSha256: base.provenance.pathsetSha256,
    headPathsetSha256: head.provenance.pathsetSha256,
    added: setDifference(headPaths, basePaths),
    removed: setDifference(basePaths, headPaths),
  };
}

function safeMarkdownPath(value) {
  return JSON.stringify(value).replace(/[<>&`]/g, (character) =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
}

function formatPathSection(paths) {
  if (paths.length === 0) return '- None';
  return paths.map((entry) => `- \`${safeMarkdownPath(entry)}\``).join('\n');
}

export function formatDriftComment(result) {
  const changed = result.added.length > 0 || result.removed.length > 0;
  const body = `${COMMENT_MARKER}\n\n## Public export drift\n\n` +
    `Membership changed: **${changed ? 'yes' : 'no'}**\n\n` +
    `Base: \`${result.baseSha}\`  \n` +
    `Base pathset SHA-256: \`${result.basePathsetSha256}\`\n\n` +
    `Head: \`${result.headSha}\`  \n` +
    `Head pathset SHA-256: \`${result.headPathsetSha256}\`\n\n` +
    `### Added paths\n\n${formatPathSection(result.added)}\n\n` +
    `### Removed paths\n\n${formatPathSection(result.removed)}\n\n${CONTRACT_LIMIT}\n`;
  if (Buffer.byteLength(body, 'utf8') > MAX_COMMENT_BYTES) {
    throw new Error('public export drift comment exceeds the bounded comment size');
  }
  return body;
}

function normalizeApiBase(apiBase) {
  const url = new URL(requireString(apiBase, 'Gitea API URL'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Gitea API URL must be an uncredentialed HTTP(S) URL');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/api/v1')) {
    throw new Error('Gitea API URL must end with /api/v1');
  }
  return url;
}

async function readBoundedBody(response, limit = MAX_API_RESPONSE_BYTES) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('Gitea API response exceeded the bounded response size');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

export async function giteaJsonRequest({
  apiBase,
  token,
  method = 'GET',
  apiPath,
  body = null,
  expectedStatuses = [200],
  timeoutMs = API_TIMEOUT_MS,
}) {
  requireString(token, 'GITEA_TOKEN');
  const base = normalizeApiBase(apiBase);
  const relativePath = requireString(apiPath, 'Gitea API path').replace(/^\/+/, '');
  const url = new URL(`${base.pathname}/${relativePath}`, base.origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `token ${token}`,
        ...(body === null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const reason = controller.signal.aborted ? 'request timed out' : 'request failed';
    throw new Error(`Gitea API ${method} ${apiPath} ${reason}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  const bytes = await readBoundedBody(response);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`Gitea API ${method} ${apiPath} returned HTTP ${response.status}`);
  }
  if (bytes.length === 0) {
    throw new Error(`Gitea API ${method} ${apiPath} returned an empty JSON response`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`Gitea API ${method} ${apiPath} returned malformed JSON`);
  }
}

function splitRepository(repository) {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((entry) => entry.length === 0)) {
    throw new Error('repository must have owner/name form');
  }
  return parts.map((entry) => encodeURIComponent(entry));
}

function ownedMarker(comment, login) {
  return Number.isSafeInteger(comment?.id) && comment.id > 0 &&
    comment.user?.login === login &&
    typeof comment.body === 'string' &&
    (comment.body === COMMENT_MARKER || comment.body.startsWith(`${COMMENT_MARKER}\n`));
}

function commentOrder(left, right) {
  const leftTime = Date.parse(left.updated_at || left.created_at || '') || 0;
  const rightTime = Date.parse(right.updated_at || right.created_at || '') || 0;
  return leftTime - rightTime || left.id - right.id;
}

function verifyCommentReadback(comment, {
  apiBase,
  repository,
  pullNumber,
  login,
  body,
  commentId,
}) {
  if (comment?.id !== commentId || comment?.user?.login !== login || comment?.body !== body) {
    throw new Error('comment readback did not match the requested author, id, and body');
  }
  if (!(comment.body === COMMENT_MARKER || comment.body.startsWith(`${COMMENT_MARKER}\n`))) {
    throw new Error('comment readback is missing the owned marker');
  }
  if (comment.issue_url) {
    throw new Error('pull request comment readback unexpectedly targets an issue');
  }
  let pullUrl;
  try {
    pullUrl = new URL(comment.pull_request_url);
  } catch {
    throw new Error('comment readback has no valid pull request target');
  }
  const [owner, name] = splitRepository(repository);
  const expectedOrigin = normalizeApiBase(apiBase).origin;
  const expectedPath = `/${owner}/${name}/pulls/${pullNumber}`;
  if (pullUrl.origin !== expectedOrigin || pullUrl.pathname !== expectedPath) {
    throw new Error('comment readback targets a different repository or pull request');
  }
}

export async function upsertDriftComment({
  apiBase,
  token,
  event,
  expectedRepository,
  body,
  warn = (message) => console.warn(message),
}) {
  const pull = validatePullRequestEvent(event, { expectedRepository });
  if (typeof body !== 'string' || !body.startsWith(`${COMMENT_MARKER}\n`)) {
    throw new Error('comment body must start with the public export drift marker');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_COMMENT_BYTES) {
    throw new Error('comment body exceeds the bounded comment size');
  }
  const identity = await giteaJsonRequest({ apiBase, token, apiPath: '/user' });
  const login = requireString(identity?.login, 'Gitea token identity login');
  const [owner, name] = splitRepository(pull.repository);
  const issuePath = `/repos/${owner}/${name}/issues/${pull.pullNumber}`;
  const comments = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const batch = await giteaJsonRequest({
      apiBase,
      token,
      apiPath: `${issuePath}/comments?limit=${COMMENTS_PER_PAGE}&page=${page}`,
    });
    if (!Array.isArray(batch)) {
      throw new Error('Gitea comment list response must be an array');
    }
    comments.push(...batch);
    if (batch.length < COMMENTS_PER_PAGE) break;
    if (page === MAX_COMMENT_PAGES) {
      throw new Error('Gitea comment pagination exceeded the bounded page count');
    }
  }

  const owned = comments.filter((comment) => ownedMarker(comment, login)).sort(commentOrder);
  const target = owned.at(-1) ?? null;
  if (owned.length > 1) {
    warn(`duplicate owned public export drift comments: ${owned.map((entry) => entry.id).join(', ')}`);
  }
  const method = target ? 'PATCH' : 'POST';
  const mutationPath = target
    ? `/repos/${owner}/${name}/issues/comments/${target.id}`
    : `${issuePath}/comments`;
  const mutation = await giteaJsonRequest({
    apiBase,
    token,
    method,
    apiPath: mutationPath,
    body: { body },
    expectedStatuses: target ? [200] : [200, 201],
  });
  if (!Number.isSafeInteger(mutation?.id) || mutation.id <= 0) {
    throw new Error('Gitea comment mutation returned no valid comment id');
  }
  const readbackPath = `/repos/${owner}/${name}/issues/comments/${mutation.id}`;
  const readback = await giteaJsonRequest({ apiBase, token, apiPath: readbackPath });
  verifyCommentReadback(readback, {
    apiBase,
    repository: pull.repository,
    pullNumber: pull.pullNumber,
    login,
    body,
    commentId: mutation.id,
  });
  return { action: target ? 'updated' : 'created', commentId: mutation.id, login };
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('CLI options must use --name value pairs');
    }
    if (Object.hasOwn(options, key)) throw new Error(`duplicate CLI option ${key}`);
    options[key] = value;
  }
  return options;
}

function readEvent(eventPath) {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read pull request event JSON (${error.message})`);
  }
  return event;
}

function writeBody(outputPath, body) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, body, { encoding: 'utf8', mode: 0o600 });
}

function requireExpectedNodeVersion(expectedVersion) {
  if (expectedVersion && process.version !== expectedVersion) {
    throw new Error(`Node.js runtime ${process.version} does not match reviewed ${expectedVersion}`);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  const eventPath = options['--event'] || process.env.GITHUB_EVENT_PATH;
  const expectedRepository = options['--expected-repository'] || process.env.GITHUB_REPOSITORY;
  if (command === 'compute') {
    const outputPath = requireString(options['--output'], '--output');
    try {
      requireExpectedNodeVersion(options['--expected-node-version']);
      const event = readEvent(requireString(eventPath, 'GITHUB_EVENT_PATH'));
      const drift = computeExportDrift({
        repoRoot: path.resolve(options['--repo-root'] || process.cwd()),
        event,
        expectedRepository,
      });
      writeBody(outputPath, formatDriftComment(drift));
      console.log(`public export drift report written to ${outputPath}`);
    } catch (error) {
      writeBody(outputPath, UNAVAILABLE_BODY);
      console.error(`public export drift report unavailable: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'publish') {
    requireExpectedNodeVersion(options['--expected-node-version']);
    const bodyPath = requireString(options['--body'], '--body');
    const event = readEvent(requireString(eventPath, 'GITHUB_EVENT_PATH'));
    const result = await upsertDriftComment({
      apiBase: options['--api-base'] || process.env.GITEA_API_URL || process.env.GITHUB_API_URL,
      token: process.env.GITEA_TOKEN,
      event,
      expectedRepository,
      body: fs.readFileSync(bodyPath, 'utf8'),
    });
    console.log(`public export drift comment ${result.action}: id=${result.commentId} actor=${result.login}`);
    return;
  }
  throw new Error('usage: public-export-drift-comment.mjs compute|publish [--name value ...]');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`public export drift comment failed: ${error.message}`);
    process.exitCode = 1;
  });
}
