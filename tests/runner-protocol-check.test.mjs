import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../.gitea/scripts/runner-protocol-check.mjs', import.meta.url));
const sourceAvailable = fs.existsSync(entry);
const sourcePolicyAvailable = fs.existsSync(new URL('../.public-export/allowlist.json', import.meta.url));
const repositoryDeclarations = sourceAvailable
  ? [...fs.readFileSync(entry, 'utf8').matchAll(/^const SOURCE_REPOSITORY = '([^'\n]+)';$/gm)] : [];
if (sourceAvailable && (repositoryDeclarations.length !== 1 ||
  !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repositoryDeclarations[0][1]))) {
  throw new Error('The trusted source must declare exactly one repository identity.');
}
const repository = repositoryDeclarations[0]?.[1];
const [repositoryOwner, repositoryName] = repository?.split('/') ?? [];
const server = 'http://127.0.0.1:3000';
const cache = 'http://127.0.0.2:8088/';

describe('native runner protocol source boundary', () => {
  it('keeps the source-only entry and export policy availability coherent', () => {
    expect(sourceAvailable).toBe(sourcePolicyAvailable);
  });

  if (sourceAvailable) {
    let directory;
    let checkout;
    let head;
    let env;
    let verifyCacheResult;
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    function git(args) {
      const result = spawnSync('git', args, { cwd: checkout, env: baseEnv, encoding: 'utf8', timeout: 30000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    }
    function invoke(overrides = {}, operation = 'produce') {
      fs.writeFileSync(env.GITHUB_ENV, '');
      fs.writeFileSync(env.GITHUB_OUTPUT, '');
      return spawnSync(process.execPath, [entry, operation], {
        cwd: checkout, env: { ...baseEnv, ...env, ...overrides }, encoding: 'utf8', timeout: 30000,
      });
    }
    function scratchDirectories() {
      return fs.readdirSync(directory).filter((name) => name.startsWith('punchpilot-runner-protocol.'));
    }
    function rejects(overrides, message) {
      const result = invoke(overrides);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(message);
      expect(scratchDirectories()).toEqual([]);
      expect(fs.readFileSync(env.GITHUB_ENV, 'utf8')).toBe('');
      expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('');
      return result;
    }
    beforeAll(async () => {
      ({ verifyCacheResult } = await import(new URL('../.gitea/scripts/runner-protocol-check.mjs', import.meta.url)));
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-protocol-test-'));
      checkout = path.join(directory, 'checkout');
      fs.mkdirSync(checkout);
      git(['-c', 'init.defaultBranch=main', 'init', '-q']);
      git(['-c', 'user.name=Protocol Fixture', '-c', 'user.email=protocol@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'fixture']);
      git(['remote', 'add', 'origin', `${server}/${repository}`]);
      head = git(['rev-parse', 'HEAD']);
      const eventPath = path.join(directory, 'event.json');
      fs.writeFileSync(eventPath, JSON.stringify({ repository: { full_name: repository }, pull_request: {
        head: { sha: head, repo: { full_name: repository } }, base: { repo: { full_name: repository } },
      } }));
      env = {
        GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '16000', GITHUB_RUN_ATTEMPT: '2',
        GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_SERVER_URL: server, GITHUB_API_URL: `${server}/api/v1`,
        GITEA_ACTIONS: 'true', GITEA_ACTIONS_RUNNER_VERSION: 'v3.4.1',
        ACTIONS_RUNTIME_TOKEN: 'fixture', ACTIONS_CACHE_SERVICE_V2: 'true',
        ACTIONS_CACHE_URL: cache, ACTIONS_RESULTS_URL: cache,
        RUNNER_TEMP: directory, GITHUB_ENV: path.join(directory, 'env'), GITHUB_OUTPUT: path.join(directory, 'output'),
      };
    });
    afterAll(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

    const copyName = '[1/1] COPY proof.bin /proof.bin';
    const copyDigest = `sha256:${'a'.repeat(64)}`;
    const otherDigest = `sha256:${'b'.repeat(64)}`;
    const started = '2026-10-05T00:00:00Z';
    const completed = '2026-10-05T00:00:01Z';
    const proofBytes = Buffer.alloc(2048, 42);
    function cacheProgress(cached = true) {
      return [
        { vertexes: [{ digest: copyDigest, name: copyName }] },
        { vertexes: [{ digest: copyDigest, name: copyName, started, cached }] },
        { vertexes: [{ digest: copyDigest, name: copyName, started }] },
        { vertexes: [{ digest: copyDigest, name: copyName, started, completed }] },
      ];
    }
    const progressLog = updates => updates.map(update => JSON.stringify(update)).join('\n');

    it.each([false, true])('preserves a cache-load event across materialization updates (reverse=%s)', (reverse) => {
      const updates = cacheProgress();
      if (reverse) updates.reverse();
      expect(() => verifyCacheResult(progressLog(updates), proofBytes, proofBytes)).not.toThrow();
    });

    it.each([
      ['numeric offsets', '2026-10-05T09:00:00+09:00', '2026-10-04T20:00:01-04:00'],
      ['nanosecond precision', '2026-10-05T00:00:00.000000001Z', '2026-10-05T00:00:00.000000002Z'],
      ['equal instants across offsets', '2026-10-05T09:00:00.123456789+09:00', '2026-10-05T00:00:00.123456789Z'],
      ['lowercase separators', '2026-10-05t00:00:00z', '2026-10-05t00:00:01z'],
      ['leap-year date', '2024-02-29T00:00:00Z', '2024-02-29T00:00:01Z'],
    ])('accepts valid COPY timestamps with %s', (_, start, finish) => {
      const vertex = { digest: copyDigest, name: copyName, cached: true, started: start, completed: finish };
      expect(() => verifyCacheResult(progressLog([{ vertexes: [vertex] }]), proofBytes, proofBytes)).not.toThrow();
    });

    it.each([false, true])('allows separate materialization starts and optional fields (reverse=%s)', (reverse) => {
      const updates = [...cacheProgress(),
        { vertexes: [{ digest: copyDigest, started: '2026-10-05T00:00:02.123456789Z' }] },
        { vertexes: [{ digest: copyDigest, completed: '2026-10-05T00:00:03.123456789Z' }] },
        { vertexes: [{ digest: copyDigest, started: '2026-10-05T00:00:02Z', completed: '2026-10-05T00:00:03Z' }] },
      ];
      if (reverse) updates.reverse();
      expect(() => verifyCacheResult(progressLog(updates), proofBytes, proofBytes)).not.toThrow();
    });

    it.each(['started', 'completed'])('validates every present COPY %s, including later uncached updates', (field) => {
      for (const value of ['2026', 'not-a-time', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z',
        '2026-00-01T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-00T00:00:00Z', '2026-04-31T00:00:00Z',
        '2026-10-05T24:00:00Z', '2026-10-05T00:60:00Z', '2026-10-05T00:00:60Z',
        '2026-10-05T00:00:00+24:00', '2026-10-05T00:00:00+00:60', '2026-10-05T00:00:00',
        '2026-10-05T00:00:00.1234567890Z', '2026-10-05T00:00:00Z ', '', null, 0, true]) {
        const updates = [...cacheProgress(), { vertexes: [{ digest: copyDigest, [field]: value }] }];
        expect(() => verifyCacheResult(progressLog(updates), proofBytes, proofBytes), `${field}=${JSON.stringify(value)}`).toThrow();
      }
    });

    it.each([
      ['whole second', '2026-10-05T00:00:01Z', '2026-10-05T00:00:00Z'],
      ['same-millisecond nanoseconds', '2026-10-05T00:00:00.000000002Z', '2026-10-05T00:00:00.000000001Z'],
      ['different offsets', '2026-10-05T09:00:01+09:00', '2026-10-04T20:00:00-04:00'],
    ])('rejects a same-update completion before its start by %s', (_, start, finish) => {
      const vertex = { digest: copyDigest, started: start, completed: finish };
      expect(() => verifyCacheResult(progressLog([...cacheProgress(), { vertexes: [vertex] }]), proofBytes, proofBytes)).toThrow('completion precedes');
    });

    it.each([
      ['no cached event', cacheProgress(false)],
      ['unrelated cached vertex', [...cacheProgress(false), { vertexes: [{
        digest: otherDigest, name: 'unrelated', started, completed, cached: true,
      }] }]],
      ['no COPY vertex', [{ vertexes: [{ digest: otherDigest, name: 'unrelated', started, completed, cached: true }] }]],
      ['multiple COPY digests', [...cacheProgress(), { vertexes: [{
        digest: otherDigest, name: copyName, started, completed, cached: true,
      }] }]],
      ['error before cache hit', [{ vertexes: [{ digest: copyDigest, name: copyName, error: 'failed' }] }, ...cacheProgress()]],
      ['error after cache hit', [...cacheProgress(), { vertexes: [{ digest: copyDigest, name: copyName, error: 'failed' }] }]],
      ['conflicting vertex name', [...cacheProgress(), { vertexes: [{ digest: copyDigest, name: 'unrelated' }] }]],
      ['missing completion', cacheProgress().slice(0, -1)],
      ['invalid cached timestamp', [{ vertexes: [{ digest: copyDigest, name: copyName, started: 'invalid', completed, cached: true }] }]],
      ['invalid completion timestamp', [{ vertexes: [{ digest: copyDigest, name: copyName, started, completed: 'invalid', cached: true }] }]],
      ['invalid cached flag', [{ vertexes: [{ digest: copyDigest, name: copyName, started, completed, cached: 'true' }] }]],
      ['invalid vertex digest', [{ vertexes: [{ digest: 'invalid', name: copyName, started, completed, cached: true }] }]],
    ])('rejects %s without treating a successful build as a cache hit', (_, updates) => {
      expect(() => verifyCacheResult(progressLog(updates), proofBytes, proofBytes)).toThrow();
    });

    it.each(['', '{}', 'null', '[]', '{broken}', '{"vertexes":{}}', '{"vertexes":[null]}'])('rejects malformed or empty raw progress %j', (log) => {
      expect(() => verifyCacheResult(log, proofBytes, proofBytes)).toThrow();
    });

    it('requires exact exported bytes even after a real cache-load event', () => {
      expect(() => verifyCacheResult(progressLog(cacheProgress()), Buffer.alloc(2048), proofBytes)).toThrow();
    });

    it.each(['cached', 'cached-nanoseconds', 'uncached-mtime', 'wrong-bytes', 'invalid-time',
      'year-time', 'later-invalid-time', 'invalid-calendar', 'inverted-nanoseconds'])('checks %s through the actual import CLI and output tar', (scenario) => {
      const produced = invoke();
      expect(produced.status, produced.stderr).toBe(0);
      const manifest = JSON.parse(produced.stdout);
      const emitted = Object.fromEntries(fs.readFileSync(env.GITHUB_ENV, 'utf8').trim().split('\n').map(line => {
        const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
      }));
      const scratch = emitted.PROTOCOL_DIR;
      try {
        const fixture = path.join(scratch, 'fixture');
        const bin = path.join(fixture, 'bin');
        const output = path.join(fixture, 'exported');
        fs.mkdirSync(bin, { recursive: true });
        fs.mkdirSync(output);
        const proof = fs.readFileSync(path.join(scratch, 'artifact', 'proof.bin'));
        const exported = scenario === 'wrong-bytes' ? Buffer.from(proof) : proof;
        if (scenario === 'wrong-bytes') exported[0] ^= 1;
        fs.writeFileSync(path.join(output, 'proof.bin'), exported);
        const updates = cacheProgress(scenario !== 'uncached-mtime');
        if (scenario === 'invalid-time') updates[1].vertexes[0].started = 'invalid';
        if (scenario === 'year-time') updates[1].vertexes[0].started = '2026';
        if (scenario === 'later-invalid-time') updates.push({ vertexes: [{ digest: copyDigest, started: 'not-a-time' }] });
        if (scenario === 'invalid-calendar') updates.push({ vertexes: [{ digest: copyDigest, completed: '2026-02-30T00:00:00Z' }] });
        if (scenario === 'cached-nanoseconds' || scenario === 'inverted-nanoseconds') updates.push({ vertexes: [{
          digest: copyDigest, started: '2026-10-05T09:00:00.000000002+09:00',
          completed: `2026-10-05T00:00:00.00000000${scenario === 'cached-nanoseconds' ? '3' : '1'}Z`,
        }] });
        if (scenario === 'uncached-mtime') fs.utimesSync(path.join(scratch, 'context', 'proof.bin'), 1, 1);
        const progress = path.join(fixture, 'progress.jsonl');
        const calls = path.join(fixture, 'calls.jsonl');
        fs.writeFileSync(progress, progressLog(updates));
        fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROTOCOL_FIXTURE_CALLS, JSON.stringify(args) + '\n');
if (args[0] !== 'buildx') process.exit(91);
if (args[1] === 'du') process.exit(0);
if (args[1] !== 'build' || !args.includes('--progress=rawjson') ||
    !args.includes('--cache-from') || !args.includes('type=gha,version=2,scope=' + process.env.CACHE_SCOPE)) process.exit(92);
const output = args[args.indexOf('--output') + 1];
if (!output.startsWith('type=tar,dest=')) process.exit(93);
const result = spawnSync('tar', ['-cf', output.slice('type=tar,dest='.length), '-C', process.env.PROTOCOL_FIXTURE_EXPORTED, 'proof.bin']);
if (result.status !== 0) process.exit(94);
process.stderr.write(fs.readFileSync(process.env.PROTOCOL_FIXTURE_PROGRESS));
`, { mode: 0o700 });
        const result = invoke({
          ...emitted, PROTOCOL_STAGE: 'consume', PROTOCOL_BUILDER: 'pp-protocol-consume-16000-2',
          PROOF_SHA256: manifest.sha256,
          PATH: `${bin}${path.delimiter}${baseEnv.PATH}`,
          PROTOCOL_FIXTURE_PROGRESS: progress, PROTOCOL_FIXTURE_EXPORTED: output, PROTOCOL_FIXTURE_CALLS: calls,
        }, 'import');
        const accepted = scenario === 'cached' || scenario === 'cached-nanoseconds';
        expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
        const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(commands.map(args => args[1])).toEqual(['du', 'build']);
        expect(commands[1]).toContain('--progress=rawjson');
        if (accepted) {
          expect(JSON.parse(result.stdout.trim())).toMatchObject({ cacheHit: true, exportedBytes: 2048, sha256: manifest.sha256 });
        } else {
          expect(result.stdout).not.toContain('"cacheHit":true');
        }
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    });

    it('produces bound synthetic proof using the actual native source and separate cache origins', () => {
      const result = invoke();
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(result.stdout);
      expect(manifest).toMatchObject({ head, runner: 'v3.4.1', bytes: 2048, scope: `runner-protocol-16000-2-${head}` });
      const emitted = Object.fromEntries(fs.readFileSync(env.GITHUB_ENV, 'utf8').trim().split('\n').map((line) => {
        const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
      }));
      const proof = fs.readFileSync(path.join(emitted.PROTOCOL_DIR, 'artifact', 'proof.bin'));
      expect(proof.length).toBe(2048);
      expect(createHash('sha256').update(proof).digest('hex')).toBe(manifest.sha256);
      expect(fs.readdirSync(path.join(emitted.PROTOCOL_DIR, 'artifact')).sort()).toEqual(['manifest.json', 'proof.bin']);
      expect(result.stdout).not.toContain(env.ACTIONS_RUNTIME_TOKEN);
      fs.rmSync(emitted.PROTOCOL_DIR, { recursive: true });
    });

    it('accepts an exact HTTPS checkout without fixing the source hostname', () => {
      const url = 'https://source.example.invalid';
      git(['remote', 'set-url', 'origin', `${url}/${repository}.git`]);
      try {
        const result = invoke({ GITHUB_SERVER_URL: `${url}/`, GITHUB_API_URL: `${url}/api/v1` });
        expect(result.status, result.stderr).toBe(0);
        for (const name of scratchDirectories()) fs.rmSync(path.join(directory, name), { recursive: true });
      } finally { git(['remote', 'set-url', 'origin', `${server}/${repository}`]); }
    });

    it.each([
      ['server host', { GITHUB_SERVER_URL: 'http://other.example.invalid:3000' }],
      ['API host', { GITHUB_API_URL: 'http://other.example.invalid:3000/api/v1' }],
      ['API port', { GITHUB_API_URL: 'http://127.0.0.1:3001/api/v1' }],
      ['API protocol', { GITHUB_API_URL: 'https://127.0.0.1:3000/api/v1' }],
    ])('rejects a different %s', (_, overrides) => {
      rejects(overrides, 'source server and API origins differ');
    });

    it('rejects replacing both source URLs while keeping a different actual checkout', () => {
      rejects({ GITHUB_SERVER_URL: 'https://other.example.invalid', GITHUB_API_URL: 'https://other.example.invalid/api/v1' },
        'source server differs from the checked-out origin');
    });

    it.each([`http://127.0.0.1:3001/${repository}`, `${server}/Other/${repositoryName}`, `${server}/${repository}/`,
      `${server}/${repositoryOwner}/other`, `${server}/${repositoryOwner}/x/../${repositoryName}`])('rejects an unexpected checkout URL %s', (url) => {
      git(['remote', 'set-url', 'origin', url]);
      try { rejects({}, 'runtime URL'); }
      finally { git(['remote', 'set-url', 'origin', `${server}/${repository}`]); }
    });

    it('rejects multiple checkout origins instead of selecting an unrelated last URL', () => {
      git(['config', '--add', 'remote.origin.url', `https://other.example.invalid/${repository}`]);
      try { rejects({}, 'checkout must have exactly one origin URL'); }
      finally { git(['config', '--unset-all', 'remote.origin.url']); git(['remote', 'set-url', 'origin', `${server}/${repository}`]); }
    });

    it.each(['', '\n', '\n\n'])('rejects an additional blank checkout origin %j', (value) => {
      git(['config', '--add', 'remote.origin.url', value]);
      try { rejects({}, 'checkout must have exactly one origin URL'); }
      finally {
        git(['config', '--unset-all', 'remote.origin.url']);
        git(['remote', 'set-url', 'origin', `${server}/${repository}`]);
        for (const name of scratchDirectories()) fs.rmSync(path.join(directory, name), { recursive: true });
      }
    });

    it('rejects several empty checkout origin fields', () => {
      git(['config', '--add', 'remote.origin.url', '']);
      git(['config', '--add', 'remote.origin.url', '']);
      try { rejects({}, 'checkout must have exactly one origin URL'); }
      finally { git(['config', '--unset-all', 'remote.origin.url']); git(['remote', 'set-url', 'origin', `${server}/${repository}`]); }
    });

    it.each([' ', '\n'])('rejects checkout origin whitespace without trimming %j', (value) => {
      const url = value === ' ' ? `${value}${server}/${repository}` : `${server}/${repository}${value}`;
      git(['remote', 'set-url', 'origin', url]);
      try { rejects({}, 'runtime URL'); }
      finally {
        git(['remote', 'set-url', 'origin', `${server}/${repository}`]);
        for (const name of scratchDirectories()) fs.rmSync(path.join(directory, name), { recursive: true });
      }
    });

    it('rejects embedded newlines inside a single checkout origin field', () => {
      git(['remote', 'set-url', 'origin', `${server}/${repository}\n${server}/${repository}`]);
      try { rejects({}, 'runtime URL'); }
      finally { git(['remote', 'set-url', 'origin', `${server}/${repository}`]); }
    });

    it('rejects credentials, queries and fragments on the checked-out origin without disclosing them', () => {
      const sentinel = 'checkout-sensitive-fixture';
      for (const url of [`http://user:${sentinel}@127.0.0.1:3000/${repository}`,
        `${server}/${repository}?key=${sentinel}`, `${server}/${repository}#${sentinel}`,
        `http://@127.0.0.1:3000/${repository}`]) {
        git(['remote', 'set-url', 'origin', url]);
        try {
          const result = rejects({}, 'runtime URL');
          expect(result.stdout + result.stderr).not.toContain(sentinel);
        } finally { git(['remote', 'set-url', 'origin', `${server}/${repository}`]); }
      }
    });

    it('rejects different cache and results origins', () => {
      rejects({ ACTIONS_RESULTS_URL: 'http://127.0.0.3:8088/' }, 'cache and results origins differ');
    });

    it.each(['GITHUB_SERVER_URL', 'GITHUB_API_URL', 'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL'])('rejects prohibited components in %s without disclosing them', (name) => {
      const sentinel = 'protocol-sensitive-fixture';
      const original = env[name];
      const parsed = new URL(original);
      const invalid = [`${parsed.protocol}//user:${sentinel}@${parsed.host}${parsed.pathname}`,
        `${parsed.protocol}//@${parsed.host}${parsed.pathname}`,
        `${original}?key=${sentinel}`, `${original}#${sentinel}`, `${original}?`, `${original}#`,
        `not-an-absolute-url-${sentinel}`, `${original}\\${sentinel}`, `${original}\n${sentinel}`];
      for (const value of invalid) {
        const result = rejects({ [name]: value }, 'runtime URL');
        expect(result.stdout + result.stderr).not.toContain(sentinel);
      }
    });

    it.each([
      ['GITHUB_SERVER_URL', `${server}/wrong`], ['GITHUB_API_URL', `${server}/api/v2`],
      ['GITHUB_API_URL', `${server}/api/v1/`], ['GITHUB_API_URL', `${server}/other/../api/v1`],
      ['ACTIONS_CACHE_URL', `${cache}wrong`], ['ACTIONS_RESULTS_URL', `${cache}wrong/../`],
      ['GITHUB_SERVER_URL', 'file:///'], ['ACTIONS_CACHE_URL', 'ftp://127.0.0.2:8088/'],
    ])('rejects unexpected %s path or protocol %s', (name, value) => {
      rejects({ [name]: value }, 'runtime URL');
    });

    it('preserves native-runtime and cache-v2 admission', () => {
      for (const overrides of [{ GITEA_ACTIONS: 'false' }, { GITEA_ACTIONS_RUNNER_VERSION: '' },
        { ACTIONS_RUNTIME_TOKEN: '' }, { ACTIONS_CACHE_SERVICE_V2: 'false' }]) {
        const result = invoke(overrides);
        expect(result.status).toBe(1);
        expect(scratchDirectories()).toEqual([]);
      }
    });

    it('preserves exact producer head, scope and artifact admission before consumer scratch', () => {
      const scope = `runner-protocol-16000-2-${head}`;
      const proof = { PROOF_HEAD: head, CACHE_SCOPE: scope, ARTIFACT_NAME: scope, PROOF_SHA256: 'a'.repeat(64) };
      for (const overrides of [{ PROOF_HEAD: 'b'.repeat(40) }, { CACHE_SCOPE: 'wrong' },
        { ARTIFACT_NAME: 'wrong' }, { PROOF_SHA256: 'wrong' }]) {
        const result = invoke({ ...proof, ...overrides }, 'consume');
        expect(result.status).toBe(1);
        expect(scratchDirectories()).toEqual([]);
      }
    });
  }
});
