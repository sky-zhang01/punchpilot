import { execFileSync, spawnSync } from 'node:child_process';
import {
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  inspectJavascriptModules,
} from '../scripts/ci/inspect-javascript-modules.mjs';
import { reviewedAdmission } from './helpers/publication-fixtures.mjs';
import { digest, jsonBytes } from '../scripts/ci/publication-contract.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(projectRoot, 'scripts', 'ci', 'mint-app-token.mjs');
const now = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const mintedCredential = ['synthetic', 'minted', 'credential'].join('-');
const scopeCredential = ['synthetic', 'scope', 'credential'].join('-');
const appendCredential = ['synthetic', 'append', 'credential'].join('-');
const baseEnv = {
  GITHUB_OUTPUT: '/mock/github-output',
  RELEASE_BOT_APP_ID: '123456',
  RELEASE_BOT_INSTALLATION_ID: '789012',
  RELEASE_BOT_PRIVATE_KEY: privateKeyPem,
};
let fixture;
let fixtureDirectory;
let changedPublication;
let changedAdmissionFile;

beforeAll(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mint-admission-'));
  const publicationRoot = path.join(fixtureDirectory, 'public');
  fs.mkdirSync(publicationRoot, { mode: 0o700 });
  const git = (args, input) => execFileSync('git', args, {
    cwd: publicationRoot, input, encoding: 'utf8',
  }).trim();
  git(['init', '--quiet']);
  const tree = git(['mktree'], '');
  const publicBase = git(['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture\n`);
  const tuple = {
    sourceCommit: '1'.repeat(40), exportedTree: tree, publicBase,
    version: 'v1.2.3', artifactSha256: '4'.repeat(64), policyHash: '5'.repeat(64),
  };
  const { admission, publication } = reviewedAdmission(tuple, { now });
  const admissionFile = path.join(fixtureDirectory, 'admission.json');
  fs.writeFileSync(admissionFile, `${JSON.stringify(admission)}\n`, { mode: 0o600 });
  fixture = { publicationRoot, publication, admissionFile };
  const blob = git(['hash-object', '-w', '--stdin'], 'name: synthetic workflow\n');
  const workflows = git(['mktree'], `100644 blob ${blob}\tci.yml\n`);
  const github = git(['mktree'], `040000 tree ${workflows}\tworkflows\n`);
  const changedTree = git(['mktree'], `040000 tree ${github}\t.github\n`);
  const changed = reviewedAdmission({ ...tuple, exportedTree: changedTree }, { changedWorkflows: true, now });
  changedPublication = changed.publication;
  changedAdmissionFile = path.join(fixtureDirectory, 'workflow-admission.json');
  fs.writeFileSync(changedAdmissionFile, jsonBytes(changed.admission), { mode: 0o600 });
});
afterAll(() => fs.rmSync(fixtureDirectory, { force: true, recursive: true }));

function githubResponse(overrides = {}) {
  return {
    permissions: { contents: 'write', metadata: 'read' },
    token: mintedCredential,
    ...overrides,
  };
}

function mockHttps(replies, events = []) {
  const calls = [];
  const request = vi.fn((options, callback) => {
    const outgoing = new EventEmitter();
    let body = '';
    outgoing.write = (chunk) => {
      body += chunk;
    };
    outgoing.end = () => {
      calls.push({ body, options });
      events.push(options.method);
      const reply = replies.shift();
      queueMicrotask(() => {
        if (reply?.hang) return;
        if (reply?.requestError) {
          outgoing.emit('error', reply.requestError);
          return;
        }
        const incoming = new EventEmitter();
        incoming.statusCode = reply?.statusCode ?? (options.method === 'GET' ? 401 : 201);
        incoming.setEncoding = vi.fn();
        callback(incoming);
        queueMicrotask(() => {
          const chunks = reply?.chunks
            ?? [typeof reply?.body === 'string'
              ? reply.body
              : JSON.stringify(reply?.body ?? githubResponse())];
          for (const chunk of chunks) incoming.emit('data', chunk);
          if (reply?.aborted) incoming.emit('aborted');
          else if (reply?.responseError) incoming.emit('error', reply.responseError);
          else incoming.emit('end');
        });
      });
    };
    outgoing.destroy = vi.fn();
    return outgoing;
  });
  return { calls, request };
}

function ioRecorder(events = []) {
  let output = 'existing=true\n';
  return {
    appendOutput(file, value) {
      events.push('append');
      expect(file).toBe(baseEnv.GITHUB_OUTPUT);
      output += value;
    },
    get output() {
      return output;
    },
    writeMask(value) {
      events.push('mask');
      expect(value).toMatch(/^::add-mask::[^\r\n]+\n$/);
    },
  };
}

async function loadMinter() {
  const module = await import('../scripts/ci/mint-app-token.mjs');
  return {
    ...module,
    mintAppToken: (options) => module.mintAppToken({ ...fixture, wait: async () => {}, ...options }),
    withAppToken: (options, operation) => module.withAppToken({ ...fixture, wait: async () => {}, ...options }, operation),
  };
}

describe('GitHub App installation-token minter', () => {
  it('revokes a scoped write token before returning its operation result', async () => {
    const events = [];
    const https = mockHttps([{}, { body: '', statusCode: 204 }], events);
    const appendOutput = vi.fn();
    const { withAppToken } = await loadMinter();
    const result = await withAppToken({
      env: baseEnv, now: () => now, request: https.request, appendOutput,
    }, async (token) => {
      expect(token).toBe(mintedCredential);
      events.push('write');
      return { submitted: true };
    });
    expect(result).toEqual({ submitted: true });
    expect(events).toEqual(['POST', 'write', 'DELETE', 'GET', 'GET', 'GET']);
    expect(appendOutput).not.toHaveBeenCalled();
    expect(https.calls[1].options.path).toBe('/installation/token');
    expect(https.calls[1].options.headers.authorization).toBe(`Bearer ${mintedCredential}`);
    for (const { options } of https.calls.slice(2)) {
      expect(options.path).toBe('/installation/repositories');
      expect(options.headers.authorization).toBe(`Bearer ${mintedCredential}`);
    }
  });

  it('revokes a scoped write token when its operation throws', async () => {
    const events = [];
    const https = mockHttps([{}, { body: '', statusCode: 204 }], events);
    const failure = new Error('synthetic publication transport failure');
    const { withAppToken } = await loadMinter();
    await expect(withAppToken({ env: baseEnv, now: () => now, request: https.request }, async () => {
      events.push('write');
      throw failure;
    })).rejects.toBe(failure);
    expect(events).toEqual(['POST', 'write', 'DELETE', 'GET', 'GET', 'GET']);
  });

  it.each([
    ['rejected revoke', [{ body: '', statusCode: 500 }]],
    ['unknown revocation', [{ body: '', statusCode: 204 }, { statusCode: 500 }]],
  ])('preserves the operation error when cleanup also has %s', async (_label, replies) => {
    const https = mockHttps([{}, ...replies]);
    const failure = new Error('synthetic publication transport failure');
    const { withAppToken } = await loadMinter();
    const error = await withAppToken({ env: baseEnv, now: () => now, request: https.request }, async () => {
      throw failure;
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('App token revocation failed');
    expect(error.cause).toBe(failure);
    expect(error.message).not.toContain(mintedCredential);
    expect(https.calls.map(({ options }) => options.method))
      .toEqual(replies.length === 1 ? ['POST', 'DELETE'] : ['POST', 'DELETE', 'GET']);
  });

  it('waits for three authenticated denials after delayed revocation', async () => {
    const replies = [{}, { body: '', statusCode: 204 }, { statusCode: 200 }];
    const https = mockHttps(replies);
    const wait = vi.fn(async () => {});
    const { withAppToken } = await loadMinter();
    await expect(withAppToken({ env: baseEnv, now: () => now, request: https.request, wait }, async () => 'done'))
      .resolves.toBe('done');
    expect(https.calls.map(({ options }) => options.method)).toEqual(['POST', 'DELETE', 'GET', 'GET', 'GET', 'GET']);
    expect(wait.mock.calls).toEqual([[1000], [1000], [1000]]);
  });

  it('resets consecutive denial evidence when the token is still accepted', async () => {
    const https = mockHttps([
      {}, { body: '', statusCode: 204 }, { statusCode: 401 }, { statusCode: 401 }, { statusCode: 200 },
    ]);
    const wait = vi.fn(async () => {});
    const { withAppToken } = await loadMinter();
    await withAppToken({ env: baseEnv, now: () => now, request: https.request, wait }, async () => 'done');
    expect(https.calls.filter(({ options }) => options.method === 'GET')).toHaveLength(6);
    expect(wait).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['forbidden verification', { statusCode: 403 }],
    ['failed verification', { statusCode: 500 }],
    ['lost verification', { requestError: new Error('synthetic verification response lost') }],
    ['timed-out verification', { hang: true }],
  ])('does not accept a DELETE acknowledgment with %s', async (_label, reply) => {
    const https = mockHttps([{}, { body: '', statusCode: 204 }, reply]);
    const { withAppToken } = await loadMinter();
    const error = await withAppToken({ env: baseEnv, now: () => now, request: https.request, timeoutMs: 10 },
      async () => 'success').catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('revocation');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).not.toContain(mintedCredential);
    expect(https.calls.map(({ options }) => options.method)).toEqual(['POST', 'DELETE', 'GET']);
  });

  it('fails within the verification deadline when the token remains accepted', async () => {
    const replies = [{}, { body: '', statusCode: 204 }];
    const https = mockHttps(replies);
    const request = (options, callback) => {
      if (options.method === 'GET') replies.push({ statusCode: 200 });
      return https.request(options, callback);
    };
    const { withAppToken } = await loadMinter();
    await expect(withAppToken({ env: baseEnv, now: () => now, request, timeoutMs: 10, wait: undefined },
      async () => 'success')).rejects.toThrow('revocation');
    expect(https.calls.filter(({ options }) => options.method === 'GET').length).toBeGreaterThan(0);
  });

  it.each([
    ['rejected revoke', { body: '', statusCode: 500 }],
    ['lost revoke response', { requestError: new Error('synthetic response lost') }],
  ])('does not return success after a %s', async (_label, revokeReply) => {
    const https = mockHttps([{}, revokeReply]);
    const { withAppToken } = await loadMinter();
    await expect(withAppToken({ env: baseEnv, now: () => now, request: https.request }, async () => 'success'))
      .rejects.toThrow('revocation');
    expect(https.calls.map(({ options }) => options.method)).toEqual(['POST', 'DELETE']);
  });

  it('does not run an operation when token admission fails', async () => {
    const https = mockHttps([]);
    const operation = vi.fn();
    const { withAppToken } = await loadMinter();
    await expect(withAppToken({ admissionFile: undefined, env: baseEnv, request: https.request }, operation))
      .rejects.toThrow('admission');
    expect(operation).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });

  it('rejects a missing operation before reading the App private key', async () => {
    const env = { ...baseEnv };
    const keyRead = vi.fn(() => privateKeyPem);
    Object.defineProperty(env, 'RELEASE_BOT_PRIVATE_KEY', { get: keyRead });
    const { withAppToken } = await loadMinter();
    await expect(withAppToken({ env }, null)).rejects.toThrow('operation');
    expect(keyRead).not.toHaveBeenCalled();
  });

  it('uses no third-party imports and reads the private key only from env', async () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const inspection = await inspectJavascriptModules(source, scriptPath);

    expect([...inspection.specifiers].sort()).toEqual([
      './publication-contract.mjs', 'node:crypto', 'node:https',
    ]);
    expect(inspection.dynamicImportPresent).toBe(false);
    expect(source).not.toContain('process.argv');
    expect(source).not.toMatch(/\breadFile(?:Sync)?\b/);
    expect(source.match(/RELEASE_BOT_PRIVATE_KEY/g)).toHaveLength(2);
    expect(source).toContain("required(env, 'RELEASE_BOT_PRIVATE_KEY'");
  });

  it('signs RS256 and exchanges a single-repository contents:write token', async () => {
    const events = [];
    const serialized = JSON.stringify(githubResponse());
    const https = mockHttps([{
      chunks: [serialized.slice(0, 30), serialized.slice(30)],
    }], events);
    const io = ioRecorder(events);
    const { mintAppToken } = await loadMinter();

    await mintAppToken({
      appendOutput: io.appendOutput,
      env: baseEnv,
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    });

    expect(https.calls).toHaveLength(1);
    const [{ body, options }] = https.calls;
    expect(options).toMatchObject({
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'PunchPilot release token minter',
        'x-github-api-version': '2026-03-10',
      },
      hostname: 'api.github.com',
      method: 'POST',
      path: '/app/installations/789012/access_tokens',
      port: 443,
    });
    expect(JSON.parse(body)).toEqual({
      repositories: ['punchpilot'],
      permissions: { contents: 'write' },
    });

    const jwt = options.headers.authorization.replace(/^Bearer /, '');
    const [encodedHeader, encodedClaims, encodedSignature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(encodedClaims, 'base64url'))).toEqual({
      exp: now + 480,
      iat: now - 60,
      iss: baseEnv.RELEASE_BOT_APP_ID,
    });
    expect(encodedSignature).not.toContain('=');
    expect(verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url'),
    )).toBe(true);
    expect(events).toEqual(['POST', 'mask', 'append']);
    expect(io.output).toBe(`existing=true\ntoken=${mintedCredential}\n`);
  });

  it('uses the production sink to append GITHUB_OUTPUT after masking', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mint-output-'));
    const output = path.join(root, 'github-output');
    fs.writeFileSync(output, 'existing=true\n');
    const events = [];
    const https = mockHttps([{}], events);
    const { mintAppToken } = await loadMinter();
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      events.push(value);
      return true;
    });

    try {
      await mintAppToken({
        env: { ...baseEnv, GITHUB_OUTPUT: output },
        now: () => now,
        request: https.request,
      });
      events.push('read');

      expect(events).toEqual([
        'POST',
        `::add-mask::${mintedCredential}\n`,
        'read',
      ]);
      expect(fs.readFileSync(output, 'utf8'))
        .toBe(`existing=true\ntoken=${mintedCredential}\n`);
    } finally {
      stdoutWrite.mockRestore();
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('accepts additional read-only permission metadata', async () => {
    const events = [];
    const https = mockHttps([{ body: githubResponse({
      permissions: { contents: 'write', issues: 'read', metadata: 'read' },
    }) }], events);
    const io = ioRecorder(events);
    const { mintAppToken } = await loadMinter();

    await mintAppToken({
      appendOutput: io.appendOutput,
      env: baseEnv,
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    });

    expect(events).toEqual(['POST', 'mask', 'append']);
    expect(https.calls).toHaveLength(1);
    expect(io.output).toContain(`token=${mintedCredential}\n`);
  });

  it.each([
    ['RELEASE_BOT_APP_ID', undefined],
    ['RELEASE_BOT_APP_ID', ' \t'],
    ['RELEASE_BOT_INSTALLATION_ID', undefined],
    ['RELEASE_BOT_INSTALLATION_ID', '\n'],
    ['RELEASE_BOT_PRIVATE_KEY', undefined],
    ['RELEASE_BOT_PRIVATE_KEY', '  '],
    ['GITHUB_OUTPUT', undefined],
    ['GITHUB_OUTPUT', '\t'],
  ])('fails before HTTPS when %s is missing or blank', async (name, value) => {
    const env = { ...baseEnv };
    if (value === undefined) delete env[name];
    else env[name] = value;
    const https = mockHttps([]);
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: io.appendOutput,
      env,
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    })).rejects.toThrow(name);
    expect(https.request).not.toHaveBeenCalled();
    expect(io.output).toBe('existing=true\n');
  });

  it.each([
    ['RELEASE_BOT_APP_ID', 'not-an-id'],
    ['RELEASE_BOT_INSTALLATION_ID', '../token'],
  ])('rejects an unsafe numeric identifier in %s', async (name, value) => {
    const https = mockHttps([]);
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: io.appendOutput,
      env: { ...baseEnv, [name]: value },
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    })).rejects.toThrow(name);
    expect(https.request).not.toHaveBeenCalled();
    expect(io.output).toBe('existing=true\n');
  });

  it.each([
    ['malformed PEM', 'not a private key'],
    ['non-RSA key', generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })],
  ])('rejects a %s without making a request', async (_label, key) => {
    const https = mockHttps([]);
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: io.appendOutput,
      env: { ...baseEnv, RELEASE_BOT_PRIVATE_KEY: key },
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    })).rejects.toThrow('RELEASE_BOT_PRIVATE_KEY');
    expect(https.request).not.toHaveBeenCalled();
    expect(io.output).toBe('existing=true\n');
  });

  it.each([
    ['transport failure', { requestError: new Error('offline') }],
    ['response abort', { aborted: true }],
    ['response stream failure', { responseError: new Error('reset') }],
    ['non-201 response', { body: { message: 'denied' }, statusCode: 403 }],
    ['malformed JSON', { body: '{broken' }],
  ])('fails closed on %s', async (_label, reply) => {
    const https = mockHttps([reply]);
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: io.appendOutput,
      env: baseEnv,
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    })).rejects.toThrow();
    expect(https.calls).toHaveLength(1);
    expect(io.output).toBe('existing=true\n');
  });

  it.each([
    ['missing token', { permissions: { contents: 'write', metadata: 'read' } }],
    ['blank token', githubResponse({ token: '  ' })],
    ['non-string token', githubResponse({ token: 42 })],
    ['newline token', githubResponse({ token: `${mintedCredential}\ninjection` })],
    ['NUL token', githubResponse({ token: `${mintedCredential}\0injection` })],
    ['tab token', githubResponse({ token: `${mintedCredential}\tinjection` })],
    ['escape token', githubResponse({ token: `${mintedCredential}\u001binjection` })],
  ])('rejects a 201 response with %s without using it', async (_label, body) => {
    const events = [];
    const https = mockHttps([{ body }], events);
    const io = ioRecorder(events);
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: io.appendOutput,
      env: baseEnv,
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    })).rejects.toThrow('token');
    expect(events).toEqual(['POST']);
    expect(https.calls).toHaveLength(1);
    expect(io.output).toBe('existing=true\n');
  });

  it.each([
    ['missing permissions', { token: scopeCredential }],
    ['null permissions', githubResponse({ permissions: null, token: scopeCredential })],
    ['array permissions', githubResponse({ permissions: [], token: scopeCredential })],
    ['contents:read', githubResponse({
      permissions: { contents: 'read', metadata: 'read' },
      token: scopeCredential,
    })],
    ['extra write', githubResponse({
      permissions: { contents: 'write', issues: 'write', metadata: 'read' },
      token: scopeCredential,
    })],
    ['extra admin', githubResponse({
      permissions: { administration: 'admin', contents: 'write', metadata: 'read' },
      token: scopeCredential,
    })],
    ['unknown level', githubResponse({
      permissions: { contents: 'write', metadata: 'read', workflows: 'unknown' },
      token: scopeCredential,
    })],
  ])('revokes and writes no output for %s', async (_label, body) => {
    const events = [];
    const https = mockHttps([{ body }, { body: '', statusCode: 204 }], events);
    const io = ioRecorder(events);
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: io.appendOutput,
      env: baseEnv,
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    })).rejects.toThrow('permission');
    expect(events).toEqual(['POST', 'mask', 'DELETE', 'GET', 'GET', 'GET']);
    expect(https.calls).toHaveLength(5);
    expect(https.calls[1]).toMatchObject({
      body: '',
      options: {
        headers: { authorization: `Bearer ${scopeCredential}` },
        hostname: 'api.github.com',
        method: 'DELETE',
        path: '/installation/token',
        port: 443,
      },
    });
    expect(io.output).toBe('existing=true\n');
  });

  it.each([
    ['revoke transport failure', { requestError: new Error('offline') }],
    ['revoke non-204 response', { body: { message: 'denied' }, statusCode: 500 }],
  ])('still fails closed when %s occurs', async (_label, revokeReply) => {
    const events = [];
    const https = mockHttps([
      { body: githubResponse({
        permissions: { contents: 'write', issues: 'write' },
        token: scopeCredential,
      }) },
      revokeReply,
    ], events);
    const io = ioRecorder(events);
    const { mintAppToken } = await loadMinter();

    const error = await mintAppToken({
      appendOutput: io.appendOutput,
      env: baseEnv,
      now: () => now,
      request: https.request,
      writeMask: io.writeMask,
    }).catch((caught) => caught);
    expect(error.message).toContain('permission');
    expect(error.message).toContain('token revocation also failed');
    expect(error.message).not.toContain(scopeCredential);
    expect(events).toEqual(['POST', 'mask', 'DELETE']);
    expect(io.output).toBe('existing=true\n');
  });

  it('times out a request that never returns', async () => {
    const https = mockHttps([{ hang: true }]);
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: io.appendOutput,
      env: baseEnv,
      now: () => now,
      request: https.request,
      timeoutMs: 5,
      writeMask: io.writeMask,
    })).rejects.toThrow('timed out');
    expect(https.calls).toHaveLength(1);
    expect(io.output).toBe('existing=true\n');
  });

  it('revokes when appending GITHUB_OUTPUT fails', async () => {
    const events = [];
    const https = mockHttps([
      { body: githubResponse({ token: appendCredential }) },
      { body: '', statusCode: 204 },
    ], events);
    const { mintAppToken } = await loadMinter();

    await expect(mintAppToken({
      appendOutput: () => {
        events.push('append');
        throw new Error('disk full');
      },
      env: baseEnv,
      now: () => now,
      request: https.request,
      writeMask: () => events.push('mask'),
    })).rejects.toThrow('GITHUB_OUTPUT');
    expect(events).toEqual(['POST', 'mask', 'append', 'DELETE', 'GET', 'GET', 'GET']);
  });

  it.each([false, true])('rejects standalone issuance with configured credentials=%s', (configured) => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ...(configured ? baseEnv : {}),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('publication token issuance is disabled');
    expect(result.stderr).not.toContain('token=');
  });

  it.each([
    ['contents', false, { contents: 'write' }],
    ['workflow-changing', true, { contents: 'write', workflows: 'write' }],
  ])('exchanges the admitted %s profile through a real local HTTP server', async (_profile, changed, permissions) => {
    const observed = [];
    const server = createServer((incoming, outgoing) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        observed.push({ method: incoming.method, path: incoming.url, body: JSON.parse(body) });
        outgoing.writeHead(201, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify(githubResponse({ permissions: { ...permissions, metadata: 'read' } })));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localRequest = (options, callback) => {
      expect(options.hostname).toBe('api.github.com');
      return httpRequest({ ...options, hostname: '127.0.0.1', port: server.address().port }, callback);
    };
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();
    try {
      await mintAppToken({
        publication: changed ? changedPublication : fixture.publication,
        admissionFile: changed ? changedAdmissionFile : fixture.admissionFile,
        env: baseEnv, now: () => now, request: localRequest,
        appendOutput: io.appendOutput, writeMask: io.writeMask,
      });
      expect(observed).toEqual([{
        method: 'POST', path: '/app/installations/789012/access_tokens',
        body: { repositories: ['punchpilot'], permissions },
      }]);
      expect(io.output).toContain(`token=${mintedCredential}\n`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('verifies delayed scoped-token revocation through a real local HTTP server', async () => {
    const observed = [];
    let verifications = 0;
    const server = createServer((incoming, outgoing) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        observed.push({ method: incoming.method, path: incoming.url });
        if (incoming.method === 'POST') {
          expect(JSON.parse(body).repositories).toEqual(['punchpilot']);
          outgoing.writeHead(201, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify(githubResponse()));
        } else {
          expect(incoming.headers.authorization).toBe(`Bearer ${mintedCredential}`);
          const status = incoming.method === 'DELETE' ? 204 : (++verifications === 1 ? 200 : 401);
          outgoing.writeHead(status);
          outgoing.end();
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localRequest = (options, callback) => httpRequest({
      ...options, hostname: '127.0.0.1', port: server.address().port,
    }, callback);
    const { withAppToken } = await loadMinter();
    try {
      await expect(withAppToken({ env: baseEnv, now: () => now, request: localRequest },
        async () => 'published')).resolves.toBe('published');
      expect(observed).toEqual([
        { method: 'POST', path: '/app/installations/789012/access_tokens' },
        { method: 'DELETE', path: '/installation/token' },
        ...Array.from({ length: 4 }, () => ({ method: 'GET', path: '/installation/repositories' })),
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([
    ['missing admission', { admissionFile: undefined }],
    ['missing publication root', { publicationRoot: undefined }],
    ['missing binding', { publication: undefined }],
    ['nonexistent base', { publication: () => ({ ...fixture.publication, publicBase: '9'.repeat(40) }) }],
    ['nonexistent tree', { publication: () => ({ ...fixture.publication, exportedTree: '9'.repeat(40) }) }],
    ['tree as base', { publication: () => ({ ...fixture.publication, publicBase: fixture.publication.exportedTree }) }],
    ['commit as tree', { publication: () => ({ ...fixture.publication, exportedTree: fixture.publication.publicBase }) }],
    ['workflow change without scoped approval', { publication: () => changedPublication }],
  ])('rejects %s before accessing the App private key', async (_label, override) => {
    const env = { ...baseEnv };
    const keyRead = vi.fn(() => privateKeyPem);
    Object.defineProperty(env, 'RELEASE_BOT_PRIVATE_KEY', { get: keyRead });
    const request = vi.fn();
    const { mintAppToken } = await loadMinter();
    const options = { ...override };
    if (typeof options.publication === 'function') options.publication = options.publication();
    await expect(mintAppToken({ ...options, env, now: () => now, request })).rejects.toThrow();
    expect(keyRead).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['expired approval', { expiresAt: now }],
    ['future approval', { issuedAt: now + 1 }],
    ['revoked approval', { revoked: true }],
    ['replayed source', { sourceCommit: '9'.repeat(40) }],
    ['replayed artifact', { artifactSha256: '9'.repeat(64) }],
    ['unapproved workflow scope', { permissions: { contents: 'write', workflows: 'write' } }],
  ])('rejects %s before accessing the App private key', async (_label, override) => {
    const admission = JSON.parse(fs.readFileSync(fixture.admissionFile, 'utf8'));
    const file = path.join(fixtureDirectory, `negative-${_label.replaceAll(' ', '-')}.json`);
    const rejectedAdmission = { ...admission, ...override };
    const bytes = jsonBytes(rejectedAdmission);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const env = { ...baseEnv };
    const keyRead = vi.fn(() => privateKeyPem);
    Object.defineProperty(env, 'RELEASE_BOT_PRIVATE_KEY', { get: keyRead });
    const request = vi.fn();
    const { mintAppToken } = await loadMinter();
    await expect(mintAppToken({ admissionFile: file,
      publication: { ...fixture.publication, admissionSha256: digest(bytes) },
      env, now: () => now, request })).rejects.toThrow();
    expect(keyRead).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('revokes unexpected workflow write permission on a contents-only token', async () => {
    const https = mockHttps([
      { body: githubResponse({ permissions: { contents: 'write', workflows: 'write' } }) },
      { body: '', statusCode: 204 },
    ]);
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();
    await expect(mintAppToken({ env: baseEnv, now: () => now, request: https.request,
      appendOutput: io.appendOutput, writeMask: io.writeMask })).rejects.toThrow(/permission/);
    expect(https.calls.map(({ options }) => options.method)).toEqual(['POST', 'DELETE', 'GET', 'GET', 'GET']);
    expect(io.output).toBe('existing=true\n');
  });

  it.each(['candidate-owned', 'world-readable', 'symlink', 'noncanonical'])(
    'rejects a %s admission before accessing the App private key', async (kind) => {
      const contents = fs.readFileSync(fixture.admissionFile);
      const file = path.join(kind === 'candidate-owned' ? fixture.publicationRoot : fixtureDirectory,
        `unsafe-${kind}.json`);
      if (kind === 'symlink') fs.symlinkSync(fixture.admissionFile, file);
      else fs.writeFileSync(file, kind === 'noncanonical' ? `${contents}\n` : contents,
        { mode: kind === 'world-readable' ? 0o644 : 0o600 });
      const env = { ...baseEnv };
      const keyRead = vi.fn(() => privateKeyPem);
      Object.defineProperty(env, 'RELEASE_BOT_PRIVATE_KEY', { get: keyRead });
      const request = vi.fn();
      const { mintAppToken } = await loadMinter();
      await expect(mintAppToken({ admissionFile: file, env, now: () => now, request })).rejects.toThrow();
      expect(keyRead).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('revokes a workflow-changing token when its required workflow permission is absent', async () => {
    const https = mockHttps([
      { body: githubResponse() }, { body: '', statusCode: 204 },
    ]);
    const io = ioRecorder();
    const { mintAppToken } = await loadMinter();
    await expect(mintAppToken({ publication: changedPublication,
      admissionFile: changedAdmissionFile, env: baseEnv, now: () => now, request: https.request,
      appendOutput: io.appendOutput, writeMask: io.writeMask })).rejects.toThrow(/permission/);
    expect(https.calls.map(({ options }) => options.method)).toEqual(['POST', 'DELETE', 'GET', 'GET', 'GET']);
    expect(io.output).toBe('existing=true\n');
  });

  it('returns the admitted token to the isolated publisher without an Actions output file', async () => {
    const env = { ...baseEnv };
    delete env.GITHUB_OUTPUT;
    const https = mockHttps([{}]);
    const { mintAppToken } = await loadMinter();
    const result = await mintAppToken({ env, now: () => now, request: https.request,
      appendOutput: null, writeMask: () => {} });
    expect(result).toEqual({ token: mintedCredential,
      permissions: { contents: 'write', metadata: 'read' } });
    expect(https.calls).toHaveLength(1);
  });

  it.each(['RELEASE_BOT_APP_ID', 'RELEASE_BOT_INSTALLATION_ID'])(
    'rejects another valid %s before accessing the private key', async (field) => {
      const env = { ...baseEnv, [field]: '42' };
      const keyRead = vi.fn(() => privateKeyPem);
      Object.defineProperty(env, 'RELEASE_BOT_PRIVATE_KEY', { get: keyRead });
      const request = vi.fn();
      const { mintAppToken } = await loadMinter();
      await expect(mintAppToken({ env, now: () => now, request })).rejects.toThrow(/identifiers/);
      expect(keyRead).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('rejects a valid changed-workflow candidate with only the contents profile before reading a private key', async () => {
    const { admission, publication } = reviewedAdmission(changedPublication, { now });
    const file = path.join(fixtureDirectory, 'missing-workflow-scope.json');
    fs.writeFileSync(file, jsonBytes(admission), { mode: 0o600 });
    const env = { ...baseEnv };
    const keyRead = vi.fn(() => privateKeyPem);
    Object.defineProperty(env, 'RELEASE_BOT_PRIVATE_KEY', { get: keyRead });
    const request = vi.fn();
    const { mintAppToken } = await loadMinter();
    await expect(mintAppToken({ publication, admissionFile: file, env,
      now: () => now, request })).rejects.toThrow(/scope/);
    expect(keyRead).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
