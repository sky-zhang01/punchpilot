#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { request as defaultRequest } from 'node:https';
import {
  assertAdmission, OID, readPrivateJson, SHA256, VERSION, workflowChanges,
} from './publication-contract.mjs';

const API = {
  hostname: 'api.github.com',
  port: 443,
};
const API_VERSION = '2026-03-10';
const REPOSITORY = 'punchpilot';
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(env, name, { preserve = false } = {}) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return preserve ? value : value.trim();
}

function requiredId(env, name) {
  const value = required(env, name);
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive decimal identifier`);
  }
  return value;
}

function appJwt(appId, pem, now) {
  let key;
  try {
    key = createPrivateKey(pem);
    if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw new Error('RELEASE_BOT_PRIVATE_KEY must be a valid RSA private key');
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ exp: now + 480, iat: now - 60, iss: appId }),
  ].join('.');
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
}

function call(request, { authorization, body, method, path }, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = () => settle(reject, new Error('GitHub API request failed'));
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${authorization}`,
      'user-agent': 'PunchPilot release token minter',
      'x-github-api-version': API_VERSION,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const outgoing = request({ ...API, headers, method, path }, (incoming) => {
      let responseBody = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        responseBody += chunk;
      });
      incoming.on('aborted', fail);
      incoming.on('close', fail);
      incoming.on('error', fail);
      incoming.on('end', () => settle(resolve, {
        body: responseBody,
        statusCode: incoming.statusCode,
      }));
    });
    outgoing.on('error', fail);
    timer = setTimeout(() => {
      settle(reject, new Error('GitHub API request timed out'));
      outgoing.destroy?.();
    }, timeoutMs);
    if (payload) outgoing.write(payload);
    outgoing.end();
  });
}

async function revoke(request, token, timeoutMs, wait) {
  const deadline = Date.now() + timeoutMs;
  const response = await call(request, {
    authorization: token,
    method: 'DELETE',
    path: '/installation/token',
  }, timeoutMs);
  if (response.statusCode !== 204) throw new Error('GitHub token revoke failed');
  let denials = 0;
  while (Date.now() < deadline) {
    const verification = await call(request, {
      authorization: token,
      method: 'GET',
      path: '/installation/repositories',
    }, deadline - Date.now());
    if (verification.statusCode === 401) denials += 1;
    else if (verification.statusCode === 200) denials = 0;
    else throw new Error('GitHub token revocation verification failed');
    if (denials === 3) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await wait(Math.min(1000, remaining));
  }
  throw new Error('GitHub token revocation verification timed out');
}

function safePermissions(permissions, expected) {
  return permissions !== null
    && !Array.isArray(permissions)
    && typeof permissions === 'object'
    && Object.entries(expected).every(([name, level]) => permissions[name] === level)
    && Object.entries(permissions).every(
      ([name, level]) => expected[name] === level || level === 'read',
    );
}

function defaultAppendOutput(file, value) {
  // The private key remains environment-only; this sink stores only the admitted token.
  process.getBuiltinModule('node:fs').appendFileSync(file, value, 'utf8');
}

export async function mintAppToken({
  admissionFile,
  appendOutput = defaultAppendOutput,
  env = process.env,
  now = () => Math.floor(Date.now() / 1000),
  publication,
  publicationRoot,
  request = defaultRequest,
  timeoutMs = 15_000,
  wait = defaultWait,
  writeMask = (value) => process.stdout.write(value),
} = {}) {
  if (typeof publicationRoot !== 'string' || !publicationRoot ||
      typeof admissionFile !== 'string' || !admissionFile || !publication ||
      !['sourceCommit', 'exportedTree', 'publicBase'].every((key) => OID.test(publication[key])) ||
      !VERSION.test(publication.version) ||
      !['artifactSha256', 'policyHash'].every((key) => SHA256.test(publication[key]))) {
    throw new Error('trusted publication binding and external admission are required');
  }
  const currentTime = now();
  const admission = readPrivateJson(admissionFile, publicationRoot);
  const permissions = assertAdmission(admission,
    publication, currentTime, workflowChanges(publicationRoot, publication.publicBase, publication.exportedTree));
  const appId = requiredId(env, 'RELEASE_BOT_APP_ID');
  const installationId = requiredId(env, 'RELEASE_BOT_INSTALLATION_ID');
  if (appId !== String(admission.receipts.platform.appId) ||
      installationId !== String(admission.receipts.platform.installationId)) {
    throw new Error('GitHub App and installation identifiers must match the admitted bot identity');
  }
  const privateKey = required(env, 'RELEASE_BOT_PRIVATE_KEY', { preserve: true });
  if (appendOutput !== null && typeof appendOutput !== 'function') {
    throw new Error('token output sink must be a function or null');
  }
  const output = appendOutput === null ? null : required(env, 'GITHUB_OUTPUT');
  const jwt = appJwt(appId, privateKey, currentTime);
  const response = await call(request, {
    authorization: jwt,
    body: {
      repositories: [REPOSITORY],
      permissions,
    },
    method: 'POST',
    path: `/app/installations/${installationId}/access_tokens`,
  }, timeoutMs);
  if (response.statusCode !== 201) {
    throw new Error(`GitHub token request returned HTTP ${response.statusCode ?? 'unknown'}`);
  }

  let result;
  try {
    result = JSON.parse(response.body);
  } catch {
    throw new Error('GitHub token response was not valid JSON');
  }
  const token = result?.token;
  if (
    typeof token !== 'string'
    || token.trim() === ''
    || token.trim() !== token
    || /[\x00-\x1f\x7f]/.test(token)
  ) {
    throw new Error('GitHub token response did not contain a safe token');
  }

  try {
    writeMask(`::add-mask::${token}\n`);
    if (!safePermissions(result.permissions, permissions)) {
      throw new Error('GitHub token permission readback was not least privilege');
    }
    try {
      if (appendOutput !== null) appendOutput(output, `token=${token}\n`);
    } catch {
      throw new Error('Could not write GITHUB_OUTPUT');
    }
  } catch (error) {
    try {
      await revoke(request, token, timeoutMs, wait);
    } catch {
      throw new Error(`${error.message}; token revocation also failed`);
    }
    throw error;
  }
  return { token, permissions: result.permissions };
}

export async function withAppToken(options, operation) {
  if (typeof operation !== 'function') throw new Error('token operation must be a function');
  const { token } = await mintAppToken({ ...options, appendOutput: null, writeMask: () => {} });
  let operationError;
  try {
    return await operation(token);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await revoke(options?.request ?? defaultRequest, token, options?.timeoutMs ?? 15_000,
        options?.wait ?? defaultWait);
    } catch (error) {
      throw new Error('App token revocation failed', { cause: operationError ?? error });
    }
  }
}

if (import.meta.main) {
  console.error('Standalone publication token issuance is disabled; use withAppToken.');
  process.exitCode = 1;
}
