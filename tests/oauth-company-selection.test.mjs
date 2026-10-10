import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  createSession,
  deleteSession,
  getDb,
  getSetting,
  initDatabase,
  setSettingsAtomically,
} from '../server/db.js';
import { decrypt, encrypt } from '../server/crypto.js';
import {
  FreeeApiClient,
  assertOAuthCompanyIdentity,
} from '../server/freee-api.js';

initDatabase();

const { default: app } = await import('../server/app.js');
const { scheduler } = await import('../server/scheduler.js');
const {
  acquireAccountOperation,
  releaseAccountOperation,
} = await import('../server/account-operation.js');

const originalFetch = global.fetch;
const sessionToken = ['fixture', 'company', 'session', 'value'].join('-');
const rejectedCallbackAccess = ['fixture', 'rejected', 'callback', 'access'].join('-');
const rejectedCallbackRefresh = ['fixture', 'rejected', 'callback', 'refresh'].join('-');
const companies = [
  {
    id: 101,
    employee_id: 1001,
    name: 'First Company',
    display_name: 'First Employee',
  },
  {
    id: 202,
    employee_id: 2002,
    name: 'Second Company',
    display_name: 'Second Employee',
  },
];

function resetOAuthState() {
  setSettingsAtomically([
    ['oauth_client_id', 'company-client'],
    ['oauth_client_secret_encrypted', encrypt('company-client-secret')],
    ['oauth_access_token_encrypted', encrypt('company-access')],
    ['oauth_refresh_token_encrypted', encrypt('company-refresh')],
    ['oauth_token_expires_at', String(Math.floor(Date.now() / 1000) + 3600)],
    ['oauth_state', ''],
    ['oauth_state_issued_at', '0'],
    ['oauth_state_generation', ''],
    ['oauth_identity_generation', '0'],
    ['oauth_company_id', ''],
    ['oauth_employee_id', ''],
    ['oauth_company_name', ''],
    ['oauth_companies', JSON.stringify(companies)],
    ['oauth_user_display_name', ''],
    ['oauth_employee_num', ''],
    ['oauth_configured', '0'],
    ['oauth_auth_broken', '0'],
    ['oauth_auth_broken_since', ''],
    ['oauth_auth_broken_reason', ''],
  ]);
}

beforeAll(() => {
  const db = getDb();
  db.prepare(`
    INSERT INTO users (username, password_hash, must_change_password)
    VALUES (?, ?, 0)
    ON CONFLICT(username) DO UPDATE SET must_change_password = 0
  `).run('oauth-company-test-user', 'unused-test-hash');
});

beforeEach(() => {
  resetOAuthState();
  deleteSession(sessionToken);
  const user = getDb()
    .prepare('SELECT id FROM users WHERE username = ?')
    .get('oauth-company-test-user');
  createSession(
    sessionToken,
    user.id,
    new Date(Date.now() + 60_000).toISOString(),
  );
  global.fetch = originalFetch;
  vi.spyOn(scheduler, 'initialize').mockResolvedValue();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OAuth company selection state', () => {
  it('preserves the active authorization while reauthorization is pending', async () => {
    setSettingsAtomically([
      ['oauth_company_id', '101'],
      ['oauth_employee_id', '1001'],
      ['oauth_company_name', 'First Company'],
      ['oauth_employee_num', 'OLD-EMPLOYEE'],
      ['oauth_configured', '1'],
    ]);

    const response = await request(app)
      .post('/api/config/oauth-authorize-url')
      .set('x-session-token', sessionToken);

    expect(response.status).toBe(200);
    expect(decrypt(getSetting('oauth_access_token_encrypted'))).toBe('company-access');
    expect(decrypt(getSetting('oauth_refresh_token_encrypted'))).toBe('company-refresh');
    expect(getSetting('oauth_company_id')).toBe('101');
    expect(getSetting('oauth_employee_id')).toBe('1001');
    expect(getSetting('oauth_company_name')).toBe('First Company');
    expect(getSetting('oauth_employee_num')).toBe('OLD-EMPLOYEE');
    expect(getSetting('oauth_companies')).toBe(JSON.stringify(companies));
    expect(getSetting('oauth_configured')).toBe('1');
    expect(getSetting('oauth_state')).toMatch(/^[a-f0-9]{64}$/);
    expect(getSetting('oauth_state_generation')).toMatch(/^0:[a-f0-9]{32}$/);
    expect(getSetting('oauth_identity_generation')).toBe('0');
    expect(scheduler.initialize).not.toHaveBeenCalled();
  });

  it('keeps the active authorization when the user cancels reauthorization', async () => {
    setSettingsAtomically([
      ['oauth_company_id', '101'],
      ['oauth_employee_id', '1001'],
      ['oauth_company_name', 'First Company'],
      ['oauth_employee_num', 'OLD-EMPLOYEE'],
      ['oauth_configured', '1'],
    ]);
    const authorize = await request(app)
      .post('/api/config/oauth-authorize-url')
      .set('x-session-token', sessionToken);
    const state = new URL(authorize.body.url).searchParams.get('state');

    const callback = await request(app)
      .get('/api/config/oauth-callback')
      .query({ error: 'access_denied', state });

    expect(callback.status).toBe(200);
    expect(callback.text).toContain('data-oauth-result="error"');
    expect(decrypt(getSetting('oauth_access_token_encrypted'))).toBe('company-access');
    expect(decrypt(getSetting('oauth_refresh_token_encrypted'))).toBe('company-refresh');
    expect(getSetting('oauth_company_id')).toBe('101');
    expect(getSetting('oauth_employee_id')).toBe('1001');
    expect(getSetting('oauth_configured')).toBe('1');
    expect(getSetting('oauth_state')).toBe('');
    expect(getSetting('oauth_state_issued_at')).toBe('0');
    expect(getSetting('oauth_state_generation')).toBe('');
    expect(scheduler.initialize).not.toHaveBeenCalled();
  });

  it('does not let an older authorization callback consume a newer state', async () => {
    const first = await request(app)
      .post('/api/config/oauth-authorize-url')
      .set('x-session-token', sessionToken);
    const firstState = new URL(first.body.url).searchParams.get('state');
    const second = await request(app)
      .post('/api/config/oauth-authorize-url')
      .set('x-session-token', sessionToken);
    const secondState = new URL(second.body.url).searchParams.get('state');
    const secondGeneration = getSetting('oauth_state_generation');
    global.fetch = vi.fn();

    const staleCallback = await request(app)
      .get('/api/config/oauth-callback')
      .query({ code: 'stale-code', state: firstState });

    expect(staleCallback.status).toBe(200);
    expect(staleCallback.text).toContain('data-oauth-result="error"');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(getSetting('oauth_state')).toBe(secondState);
    expect(getSetting('oauth_state_generation')).toBe(secondGeneration);
  });

  it('stores a new authorization atomically but remains not ready without selection', async () => {
    const authorize = await request(app)
      .post('/api/config/oauth-authorize-url')
      .set('x-session-token', sessionToken);
    const state = new URL(authorize.body.url).searchParams.get('state');

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/public_api/token')) {
        return new Response(JSON.stringify({
          access_token: 'callback-access',
          refresh_token: 'callback-refresh',
          expires_in: 3600,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        display_name: 'OAuth User',
        companies,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const callback = await request(app)
      .get('/api/config/oauth-callback')
      .query({ code: 'authorization-code', state });

    expect(callback.status).toBe(200);
    expect(callback.text).toContain('data-oauth-result="success"');
    expect(decrypt(getSetting('oauth_access_token_encrypted'))).toBe('callback-access');
    expect(decrypt(getSetting('oauth_refresh_token_encrypted'))).toBe('callback-refresh');
    expect(getSetting('oauth_company_id')).toBe('');
    expect(getSetting('oauth_employee_id')).toBe('');
    expect(getSetting('oauth_configured')).toBe('0');
    expect(scheduler.initialize).toHaveBeenCalledTimes(1);

    const status = await request(app)
      .get('/api/config/oauth-status')
      .set('x-session-token', sessionToken);
    expect(status.body.configured).toBe(false);
    expect(status.body.authorization_version).toBe('1');
    expect(status.body.needs_company_selection).toBe(true);
    expect(status.body.companies).toHaveLength(2);
  });

  it.each([
    [
      'duplicate company ids',
      [companies[0], { ...companies[1], id: companies[0].id }],
    ],
    [
      'a missing employee identity',
      [{ ...companies[0], employee_id: null }],
    ],
  ])('rejects an OAuth callback containing %s', async (_label, callbackCompanies) => {
    const authorize = await request(app)
      .post('/api/config/oauth-authorize-url')
      .set('x-session-token', sessionToken);
    const state = new URL(authorize.body.url).searchParams.get('state');
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/public_api/token')) {
        return new Response(JSON.stringify({
          access_token: rejectedCallbackAccess,
          refresh_token: rejectedCallbackRefresh,
          expires_in: 3600,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ companies: callbackCompanies }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const callback = await request(app)
      .get('/api/config/oauth-callback')
      .query({ code: 'authorization-code', state });

    expect(callback.status).toBe(200);
    expect(callback.text).toContain('data-oauth-result="error"');
    expect(decrypt(getSetting('oauth_access_token_encrypted'))).toBe('company-access');
    expect(getSetting('oauth_companies')).toBe(JSON.stringify(companies));
    expect(scheduler.initialize).not.toHaveBeenCalled();
  });

  it('becomes ready only after selecting a valid authorized company', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      num: 'EMP-202',
      display_name: 'Second Employee',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const invalid = await request(app)
      .put('/api/config/oauth-select-company')
      .set('x-session-token', sessionToken)
      .send({ company_id: 999 });
    expect(invalid.status).toBe(400);
    expect(getSetting('oauth_configured')).toBe('0');
    expect(scheduler.initialize).toHaveBeenCalledTimes(1);

    const selected = await request(app)
      .put('/api/config/oauth-select-company')
      .set('x-session-token', sessionToken)
      .send({ company_id: 202 });

    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      company_id: '202',
      employee_id: '2002',
      company_name: 'Second Company',
    });
    expect(getSetting('oauth_configured')).toBe('1');
    expect(assertOAuthCompanyIdentity()).toMatchObject({
      companyId: '202',
      employeeId: '2002',
      companyName: 'Second Company',
    });
    expect(scheduler.initialize).toHaveBeenCalledTimes(2);
  });

  it('rejects an authorized company without a valid employee identity', async () => {
    setSettingsAtomically([
      ['oauth_companies', JSON.stringify([{
        id: 303,
        employee_id: null,
        name: 'No Employee Company',
      }])],
    ]);

    const response = await request(app)
      .put('/api/config/oauth-select-company')
      .set('x-session-token', sessionToken)
      .send({ company_id: 303 });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.code).toBe('OAUTH_COMPANY_SELECTION_INVALID');
    expect(getSetting('oauth_configured')).toBe('0');
  });

  it('rejects a duplicate company identity in stored authorization data', async () => {
    setSettingsAtomically([
      ['oauth_companies', JSON.stringify([
        companies[0],
        { ...companies[0], display_name: 'Duplicate Employee' },
      ])],
    ]);

    const response = await request(app)
      .put('/api/config/oauth-select-company')
      .set('x-session-token', sessionToken)
      .send({ company_id: 101 });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('OAUTH_COMPANY_SELECTION_INVALID');
    expect(getSetting('oauth_configured')).toBe('0');
  });

  it('validates the authorized company only after entering the account lock', async () => {
    await acquireAccountOperation();
    let released = false;
    try {
      const pendingResponse = request(app)
        .put('/api/config/oauth-select-company')
        .set('x-session-token', sessionToken)
        .send({ company_id: 202 })
        .then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 20));
      setSettingsAtomically([
        ['oauth_companies', JSON.stringify([companies[0]])],
      ]);
      releaseAccountOperation();
      released = true;

      const response = await pendingResponse;
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Company not found in authorized companies');
      expect(getSetting('oauth_company_id')).toBe('');
      expect(getSetting('oauth_configured')).toBe('0');
    } finally {
      if (!released) releaseAccountOperation();
    }
  });
});

describe('OAuth company identity assertions', () => {
  it('does not infer the first authorized company when no selection exists', async () => {
    const client = new FreeeApiClient();
    client.apiRequest = vi.fn();

    await expect(client.ensureUserInfo()).rejects.toMatchObject({
      code: 'OAUTH_COMPANY_SELECTION_REQUIRED',
    });
    expect(client.apiRequest).not.toHaveBeenCalled();
    expect(getSetting('oauth_company_id')).toBe('');
    expect(getSetting('oauth_employee_id')).toBe('');
  });

  it('verifies the explicitly selected company instead of companies[0]', async () => {
    setSettingsAtomically([
      ['oauth_company_id', '202'],
      ['oauth_employee_id', '2002'],
      ['oauth_company_name', 'Second Company'],
      ['oauth_configured', '1'],
    ]);
    const client = new FreeeApiClient();
    client.ensureValidToken = vi.fn().mockResolvedValue('company-access');
    client.apiRequest = vi.fn().mockResolvedValue({
      display_name: 'OAuth User',
      companies,
    });

    await expect(client.verifyConnection()).resolves.toMatchObject({
      company_id: '202',
      employee_id: '2002',
    });
    expect(assertOAuthCompanyIdentity({ name: 'Second Company' })).toMatchObject({
      companyId: '202',
    });
    expect(() => assertOAuthCompanyIdentity({ name: 'First Company' })).toThrowError(
      expect.objectContaining({ code: 'OAUTH_COMPANY_IDENTITY_MISMATCH' }),
    );
  });

  it('rejects duplicate selected identities in stored and upstream company lists', async () => {
    setSettingsAtomically([
      ['oauth_company_id', '202'],
      ['oauth_employee_id', '2002'],
      ['oauth_company_name', 'Second Company'],
      ['oauth_configured', '1'],
      ['oauth_companies', JSON.stringify([
        ...companies,
        { ...companies[1], display_name: 'Duplicate Employee' },
      ])],
    ]);
    expect(() => assertOAuthCompanyIdentity()).toThrowError(
      expect.objectContaining({ code: 'OAUTH_COMPANY_SELECTION_INVALID' }),
    );

    setSettingsAtomically([
      ['oauth_companies', JSON.stringify(companies)],
    ]);
    const client = new FreeeApiClient();
    client.ensureValidToken = vi.fn().mockResolvedValue('company-access');
    client.apiRequest = vi.fn().mockResolvedValue({
      companies: [...companies, { ...companies[1] }],
    });
    await expect(client.verifyConnection()).rejects.toMatchObject({
      code: 'OAUTH_COMPANY_IDENTITY_MISMATCH',
    });
  });
});
