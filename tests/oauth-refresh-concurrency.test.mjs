import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSetting,
  initDatabase,
  setSettingsAtomically,
} from '../server/db.js';
import { decrypt, encrypt } from '../server/crypto.js';
import { FreeeApiClient } from '../server/freee-api.js';

const originalFetch = global.fetch;
const reauthorizedAccess = ['fixture', 'reauthorized', 'access'].join('-');
const reauthorizedRefresh = ['fixture', 'reauthorized', 'refresh'].join('-');
const nextGenerationAccess = ['fixture', 'next', 'generation', 'access'].join('-');
const nextGenerationRefresh = ['fixture', 'next', 'generation', 'refresh'].join('-');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tokenResponse(accessToken, refreshToken, expiresIn = 3600) {
  return new Response(JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function seedTokenGeneration({
  accessToken = 'old-access',
  refreshToken = 'old-refresh',
  expiresAt = '0',
} = {}) {
  setSettingsAtomically([
    ['oauth_client_id', 'refresh-client'],
    ['oauth_client_secret_encrypted', encrypt('refresh-client-secret')],
    ['oauth_access_token_encrypted', encrypt(accessToken)],
    ['oauth_refresh_token_encrypted', encrypt(refreshToken)],
    ['oauth_token_expires_at', expiresAt],
    ['oauth_auth_broken', '0'],
    ['oauth_auth_broken_since', ''],
    ['oauth_auth_broken_reason', ''],
  ]);
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  global.fetch = originalFetch;
  seedTokenGeneration();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OAuth token refresh concurrency', () => {
  it('shares one refresh request across concurrent client instances', async () => {
    const started = deferred();
    const response = deferred();
    global.fetch = vi.fn(async () => {
      started.resolve();
      return response.promise;
    });

    const pending = [
      new FreeeApiClient().ensureValidToken(),
      new FreeeApiClient().ensureValidToken(),
      new FreeeApiClient().ensureValidToken(),
    ];

    await started.promise;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    response.resolve(tokenResponse('rotated-access', 'rotated-refresh'));

    await expect(Promise.all(pending)).resolves.toEqual([
      'rotated-access',
      'rotated-access',
      'rotated-access',
    ]);
    expect(decrypt(getSetting('oauth_access_token_encrypted'))).toBe('rotated-access');
    expect(decrypt(getSetting('oauth_refresh_token_encrypted'))).toBe('rotated-refresh');
    expect(Number(getSetting('oauth_token_expires_at'))).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
  });

  it('does not overwrite a newer authorization when an old refresh succeeds late', async () => {
    const started = deferred();
    const response = deferred();
    global.fetch = vi.fn(async () => {
      started.resolve();
      return response.promise;
    });

    const pending = new FreeeApiClient().ensureValidToken();
    await started.promise;

    seedTokenGeneration({
      accessToken: reauthorizedAccess,
      refreshToken: reauthorizedRefresh,
      expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
    });
    response.resolve(tokenResponse('late-old-access', 'late-old-refresh'));

    await expect(pending).resolves.toBe(reauthorizedAccess);
    expect(decrypt(getSetting('oauth_access_token_encrypted')))
      .toBe(reauthorizedAccess);
    expect(decrypt(getSetting('oauth_refresh_token_encrypted')))
      .toBe(reauthorizedRefresh);
  });

  it('ignores invalid_grant from an obsolete refresh-token generation', async () => {
    const started = deferred();
    const response = deferred();
    global.fetch = vi.fn(async () => {
      started.resolve();
      return response.promise;
    });

    const pending = new FreeeApiClient().ensureValidToken();
    await started.promise;

    seedTokenGeneration({
      accessToken: nextGenerationAccess,
      refreshToken: nextGenerationRefresh,
      expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
    });
    response.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(pending).resolves.toBe(nextGenerationAccess);
    expect(getSetting('oauth_auth_broken')).toBe('0');
    expect(decrypt(getSetting('oauth_refresh_token_encrypted'))).toBe(
      nextGenerationRefresh,
    );
  });

  it('marks invalid_grant only while its refresh-token generation is current', async () => {
    global.fetch = vi.fn(async () => new Response('invalid_grant', { status: 401 }));

    await expect(new FreeeApiClient().ensureValidToken()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(getSetting('oauth_auth_broken')).toBe('1');
  });

  it('does not persist the auth breaker for other token endpoint failures', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_client',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(new FreeeApiClient().ensureValidToken()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(getSetting('oauth_auth_broken')).toBe('0');
  });
});
