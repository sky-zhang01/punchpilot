import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMMENT_MARKER,
  CONTRACT_LIMIT,
  UNAVAILABLE_BODY,
  computeExportDrift,
  formatDriftComment,
  giteaJsonRequest,
  upsertDriftComment,
  validatePullRequestEvent,
} from '../scripts/ci/public-export-drift-comment.mjs';

const scriptPath = path.resolve('scripts/ci/public-export-drift-comment.mjs');
const repository = 'test-owner/test-repository';
const temporaryDirectories = [];
const servers = [];

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function allowlist({ exclude = [], include = ['.public-export/', 'docs/', 'server/'] } = {}) {
  return `${JSON.stringify({
    $schema: 'public-export-allowlist/v1',
    version: 1,
    include,
    exclude,
  }, null, 2)}\n`;
}

function writeFiles(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
}

function createRepository(files = {}) {
  const root = temporaryDirectory('pp-export-drift-repo-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFiles(root, {
    '.public-export/allowlist.json': allowlist(),
    'docs/public.md': 'public\n',
    'server/app.js': 'export const value = 1;\n',
    ...files,
  });
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

function commit(root, files, message = 'head') {
  writeFiles(root, files);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function pullEvent(baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), overrides = {}) {
  const event = {
    repository: { full_name: repository },
    pull_request: {
      number: 81,
      base: { ref: 'main', sha: baseSha, repo: { full_name: repository } },
      head: { ref: 'feature', sha: headSha, repo: { full_name: repository } },
    },
  };
  return Object.assign(event, overrides);
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startGitea({
  initialComments = [],
  identity = 'punchpilot-actions',
  redirectUser = false,
  malformedUser = false,
  oversizedUser = false,
  delayUserMs = 0,
  readbackBody = null,
  readbackPullUrl = null,
} = {}) {
  const state = {
    comments: initialComments.map((entry) => ({ ...entry })),
    calls: [],
    nextId: Math.max(100, ...initialComments.map((entry) => entry.id + 1)),
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.calls.push({ method: request.method, path: `${url.pathname}${url.search}` });
    if (request.headers.authorization !== 'token test-token') {
      json(response, 401, { message: 'unauthorized' });
      return;
    }
    if (url.pathname === '/api/v1/user') {
      if (delayUserMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayUserMs));
      }
      if (redirectUser) {
        response.writeHead(302, { Location: '/api/v1/redirected' });
        response.end();
      } else if (malformedUser) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{not-json');
      } else if (oversizedUser) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(`{"login":"${'x'.repeat(1024 * 1024)}"}`);
      } else {
        json(response, 200, { login: identity });
      }
      return;
    }
    const listMatch = url.pathname.match(
      /^\/api\/v1\/repos\/test-owner\/test-repository\/issues\/81\/comments$/,
    );
    if (listMatch && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit'));
      const page = Number(url.searchParams.get('page'));
      json(response, 200, state.comments.slice((page - 1) * limit, page * limit));
      return;
    }
    if (listMatch && request.method === 'POST') {
      const payload = JSON.parse(await requestBody(request));
      const created = {
        id: state.nextId,
        body: payload.body,
        user: { login: identity },
        issue_url: '',
        pull_request_url: `${state.origin}/test-owner/test-repository/pulls/81`,
        created_at: '2026-08-27T01:00:00Z',
        updated_at: '2026-08-27T01:00:00Z',
      };
      state.nextId += 1;
      state.comments.push(created);
      json(response, 201, created);
      return;
    }
    const itemMatch = url.pathname.match(
      /^\/api\/v1\/repos\/test-owner\/test-repository\/issues\/comments\/(\d+)$/,
    );
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      const comment = state.comments.find((entry) => entry.id === id);
      if (!comment) {
        json(response, 404, { message: 'not found' });
        return;
      }
      if (request.method === 'PATCH') {
        const payload = JSON.parse(await requestBody(request));
        comment.body = payload.body;
        comment.updated_at = '2026-08-27T02:00:00Z';
        json(response, 200, comment);
        return;
      }
      if (request.method === 'GET') {
        json(response, 200, {
          ...comment,
          ...(readbackBody === null ? {} : { body: readbackBody }),
          ...(readbackPullUrl === null ? {} : { pull_request_url: readbackPullUrl }),
        });
        return;
      }
    }
    json(response, 404, { message: 'unexpected test route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  state.origin = `http://127.0.0.1:${address.port}`;
  state.apiBase = `${state.origin}/api/v1`;
  return state;
}

function existingComment({
  id,
  login = 'someone-else',
  body = `${COMMENT_MARKER}\nold`,
  updatedAt = '2026-08-27T00:00:00Z',
}) {
  return {
    id,
    body,
    user: { login },
    issue_url: '',
    pull_request_url: 'placeholder',
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('public export drift comparison', () => {
  it('reports a path added under an included prefix using exact base and head policies', () => {
    const fixture = createRepository();
    const head = commit(fixture.root, { 'server/internal/runbook.md': 'internal operations\n' });
    const result = computeExportDrift({
      repoRoot: fixture.root,
      event: pullEvent(fixture.base, head),
      expectedRepository: repository,
    });

    expect(result.added).toEqual(['server/internal/runbook.md']);
    expect(result.removed).toEqual([]);
    const body = formatDriftComment(result);
    expect(body).toContain('Membership changed: **yes**');
    expect(body).toContain('server/internal/runbook.md');
    expect(body).toContain(CONTRACT_LIMIT);
  });

  it('uses the base policy when a head policy excludes an existing path', () => {
    const fixture = createRepository();
    const head = commit(fixture.root, {
      '.public-export/allowlist.json': allowlist({
        include: ['.public-export/', 'server/'],
        exclude: ['docs/'],
      }),
    }, 'exclude docs');
    const result = computeExportDrift({
      repoRoot: fixture.root,
      event: pullEvent(fixture.base, head),
      expectedRepository: repository,
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['docs/public.md']);
  });

  it('does not describe content-only changes as path membership drift', () => {
    const fixture = createRepository();
    const head = commit(fixture.root, { 'server/app.js': 'export const value = 2;\n' });
    const result = computeExportDrift({
      repoRoot: fixture.root,
      event: pullEvent(fixture.base, head),
      expectedRepository: repository,
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.basePathsetSha256).toBe(result.headPathsetSha256);
    expect(formatDriftComment(result)).toContain('Membership changed: **no**');
  });

  it('fails closed with the exporter error for an unlisted top-level path', () => {
    const fixture = createRepository();
    const head = commit(fixture.root, { 'ops/deploy.md': 'private deployment\n' });
    expect(() => computeExportDrift({
      repoRoot: fixture.root,
      event: pullEvent(fixture.base, head),
      expectedRepository: repository,
    })).toThrow(/ops\/deploy\.md/);
  });

  it('requires the checkout to be the exact event head', () => {
    const fixture = createRepository();
    expect(() => computeExportDrift({
      repoRoot: fixture.root,
      event: pullEvent(fixture.base, 'c'.repeat(40)),
      expectedRepository: repository,
    })).toThrow(/checked-out HEAD/);
  });

  it('rejects a base commit that is not an ancestor of the event head', () => {
    const fixture = createRepository();
    const advancedBase = commit(fixture.root, { 'docs/base-only.md': 'base only\n' });
    git(fixture.root, 'checkout', '-q', '-b', 'feature', fixture.base);
    const head = commit(fixture.root, { 'server/head-only.js': 'export const head = true;\n' });

    expect(() => computeExportDrift({
      repoRoot: fixture.root,
      event: pullEvent(advancedBase, head),
      expectedRepository: repository,
    })).toThrow(/base\.sha must be an ancestor/);
  });

  it('renders hostile Git path characters as inert escaped text', () => {
    const body = formatDriftComment({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      basePathsetSha256: 'c'.repeat(64),
      headPathsetSha256: 'd'.repeat(64),
      added: ['docs/<script>`x`.md'],
      removed: [],
    });
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('`x`');
    expect(body).toContain('\\u003cscript\\u003e\\u0060x\\u0060.md');
  });
});

describe('pull request event admission', () => {
  it('accepts a same-repository main-target pull request', () => {
    expect(validatePullRequestEvent(pullEvent(), { expectedRepository: repository })).toEqual({
      repository,
      pullNumber: 81,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
  });

  it.each([
    ['fork', () => {
      const event = pullEvent();
      event.pull_request.head.repo.full_name = 'attacker/fork';
      return event;
    }],
    ['wrong target', () => {
      const event = pullEvent();
      event.pull_request.base.ref = 'release';
      return event;
    }],
    ['malformed SHA', () => {
      const event = pullEvent();
      event.pull_request.head.sha = 'HEAD';
      return event;
    }],
    ['wrong repository', () => pullEvent('a'.repeat(40), 'b'.repeat(40), {
      repository: { full_name: 'other/repository' },
    })],
  ])('rejects %s events', (_name, eventFactory) => {
    expect(() => validatePullRequestEvent(eventFactory(), {
      expectedRepository: repository,
    })).toThrow();
  });

  it('writes the deterministic unavailable report when compute fails', () => {
    const root = temporaryDirectory('pp-export-drift-cli-');
    const eventPath = path.join(root, 'event.json');
    const outputPath = path.join(root, 'report.md');
    fs.writeFileSync(eventPath, '{}\n');
    const result = spawnSync(process.execPath, [
      scriptPath,
      'compute',
      '--event', eventPath,
      '--output', outputPath,
      '--expected-repository', repository,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('report unavailable');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(UNAVAILABLE_BODY);
  });
});

describe('idempotent Gitea comment upsert', () => {
  it('creates once and then updates the same owned marker comment', async () => {
    const api = await startGitea();
    const body = `${COMMENT_MARKER}\n\nfirst report\n`;
    const first = await upsertDriftComment({
      apiBase: api.apiBase,
      token: 'test-token',
      event: pullEvent(),
      expectedRepository: repository,
      body,
    });
    const second = await upsertDriftComment({
      apiBase: api.apiBase,
      token: 'test-token',
      event: pullEvent(),
      expectedRepository: repository,
      body: `${COMMENT_MARKER}\n\nsecond report\n`,
    });

    expect(first).toMatchObject({ action: 'created', commentId: 100 });
    expect(second).toMatchObject({ action: 'updated', commentId: 100 });
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(api.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('paginates and ignores a marker planted by another author', async () => {
    const fillers = Array.from({ length: 50 }, (_, index) => existingComment({
      id: index + 1,
      body: `ordinary ${index}`,
    }));
    fillers.push(existingComment({
      id: 51,
      updatedAt: '2026-08-27T03:00:00Z',
    }));
    fillers.push(existingComment({
      id: 52,
      login: 'punchpilot-actions',
      updatedAt: '2026-08-27T01:00:00Z',
    }));
    const api = await startGitea({ initialComments: fillers });
    for (const comment of api.comments) {
      comment.pull_request_url = `${api.origin}/test-owner/test-repository/pulls/81`;
    }
    const result = await upsertDriftComment({
      apiBase: api.apiBase,
      token: 'test-token',
      event: pullEvent(),
      expectedRepository: repository,
      body: `${COMMENT_MARKER}\nnew\n`,
    });

    expect(result).toMatchObject({ action: 'updated', commentId: 52 });
    expect(api.calls).toContainEqual({
      method: 'GET',
      path: '/api/v1/repos/test-owner/test-repository/issues/81/comments?limit=50&page=2',
    });
    expect(api.comments.find((entry) => entry.id === 51).body).toBe(`${COMMENT_MARKER}\nold`);
  });

  it('rejects a publish body without the owned marker before any API request', async () => {
    const api = await startGitea();
    await expect(upsertDriftComment({
      apiBase: api.apiBase,
      token: 'test-token',
      event: pullEvent(),
      expectedRepository: repository,
      body: 'unmarked report\n',
    })).rejects.toThrow(/must start with the public export drift marker/);
    expect(api.calls).toEqual([]);
  });

  it('updates the newest duplicate owned marker and warns without deleting', async () => {
    const comments = [
      existingComment({ id: 3, login: 'punchpilot-actions', updatedAt: '2026-08-27T01:00:00Z' }),
      existingComment({ id: 4, login: 'punchpilot-actions', updatedAt: '2026-08-27T02:00:00Z' }),
    ];
    const api = await startGitea({ initialComments: comments });
    for (const comment of api.comments) {
      comment.pull_request_url = `${api.origin}/test-owner/test-repository/pulls/81`;
    }
    const warnings = [];
    const result = await upsertDriftComment({
      apiBase: api.apiBase,
      token: 'test-token',
      event: pullEvent(),
      expectedRepository: repository,
      body: `${COMMENT_MARKER}\nnew\n`,
      warn: (message) => warnings.push(message),
    });

    expect(result.commentId).toBe(4);
    expect(warnings).toEqual(['duplicate owned public export drift comments: 3, 4']);
    expect(api.comments).toHaveLength(2);
  });

  it('rejects a readback that does not exactly match the requested body', async () => {
    const api = await startGitea({ readbackBody: `${COMMENT_MARKER}\ntampered\n` });
    await expect(upsertDriftComment({
      apiBase: api.apiBase,
      token: 'test-token',
      event: pullEvent(),
      expectedRepository: repository,
      body: `${COMMENT_MARKER}\nexpected\n`,
    })).rejects.toThrow(/readback did not match/);
  });

  it('rejects a readback targeting another pull request', async () => {
    const api = await startGitea({ readbackPullUrl: 'https://example.invalid/other/repo/pulls/9' });
    await expect(upsertDriftComment({
      apiBase: api.apiBase,
      token: 'test-token',
      event: pullEvent(),
      expectedRepository: repository,
      body: `${COMMENT_MARKER}\nexpected\n`,
    })).rejects.toThrow(/different repository or pull request/);
  });
});

describe('bounded Gitea API client', () => {
  it('fails before a request when the token is missing', async () => {
    const api = await startGitea();
    await expect(giteaJsonRequest({
      apiBase: api.apiBase,
      token: '',
      apiPath: '/user',
    })).rejects.toThrow(/GITEA_TOKEN/);
    expect(api.calls).toEqual([]);
  });

  it('rejects redirects', async () => {
    const api = await startGitea({ redirectUser: true });
    await expect(giteaJsonRequest({
      apiBase: api.apiBase,
      token: 'test-token',
      apiPath: '/user',
    })).rejects.toThrow(/request failed/);
  });

  it('aborts requests that exceed the configured timeout', async () => {
    const api = await startGitea({ delayUserMs: 100 });
    await expect(giteaJsonRequest({
      apiBase: api.apiBase,
      token: 'test-token',
      apiPath: '/user',
      timeoutMs: 10,
    })).rejects.toThrow(/timed out/);
  });

  it('rejects malformed and oversized JSON responses', async () => {
    const malformed = await startGitea({ malformedUser: true });
    await expect(giteaJsonRequest({
      apiBase: malformed.apiBase,
      token: 'test-token',
      apiPath: '/user',
    })).rejects.toThrow(/malformed JSON/);

    const oversized = await startGitea({ oversizedUser: true });
    await expect(giteaJsonRequest({
      apiBase: oversized.apiBase,
      token: 'test-token',
      apiPath: '/user',
    })).rejects.toThrow(/bounded response size/);
  });

  it('rejects non-success status and invalid API coordinates', async () => {
    const api = await startGitea();
    await expect(giteaJsonRequest({
      apiBase: api.apiBase,
      token: 'wrong-token',
      apiPath: '/user',
    })).rejects.toThrow(/HTTP 401/);
    await expect(giteaJsonRequest({
      apiBase: 'https://token@example.invalid/api/v1',
      token: 'test-token',
      apiPath: '/user',
    })).rejects.toThrow(/uncredentialed/);
  });
});
