import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getSetting,
  initDatabase,
  setSettingsAtomically,
} from '../server/db.js';
import { encrypt } from '../server/crypto.js';
import { todayStringInTz } from '../server/timezone.js';
import {
  captureOAuthIdentityBinding,
  FreeeApiClient,
  FREEE_AUTH_ERROR_CODES,
} from '../server/freee-api.js';

const originalFetch = global.fetch;
const identities = {
  first: {
    companyId: '101',
    employeeId: '1001',
    companyName: 'Synthetic First Company',
  },
  second: {
    companyId: '202',
    employeeId: '2002',
    companyName: 'Synthetic Second Company',
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function selectIdentity(identity, generation) {
  const companies = Object.values(identities).map((candidate) => ({
    id: Number(candidate.companyId),
    employee_id: Number(candidate.employeeId),
    name: candidate.companyName,
    display_name: 'Synthetic Employee',
  }));
  setSettingsAtomically([
    ['oauth_client_id', 'synthetic-race-client'],
    ['oauth_client_secret_encrypted', encrypt('synthetic-race-client-secret')],
    ['oauth_access_token_encrypted', encrypt('synthetic-race-access-token')],
    ['oauth_refresh_token_encrypted', encrypt('synthetic-race-refresh-token')],
    ['oauth_token_expires_at', String(Math.floor(Date.now() / 1000) + 3600)],
    ['oauth_identity_generation', String(generation)],
    ['oauth_company_id', identity.companyId],
    ['oauth_employee_id', identity.employeeId],
    ['oauth_company_name', identity.companyName],
    ['oauth_companies', JSON.stringify(companies)],
    ['oauth_configured', '1'],
    ['oauth_auth_broken', '0'],
    ['oauth_auth_broken_since', ''],
    ['oauth_auth_broken_reason', ''],
  ]);
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  selectIdentity(identities.first, 1);
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OAuth identity binding across attendance mutations', () => {
  it('rejects a request-entry binding that became stale before dispatch', async () => {
    const binding = captureOAuthIdentityBinding();
    const client = new FreeeApiClient({ identityBinding: binding });
    global.fetch = vi.fn();

    selectIdentity(identities.second, 2);

    await expect(client.apiRequest(
      'POST',
      '/employees/1001/time_clocks',
      { company_id: 101, type: 'clock_in', base_date: '2026-05-18' },
    )).rejects.toMatchObject({
      code: FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a company switch after state detection and before the clock POST', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      available_types: ['clock_in'],
      base_date: todayStringInTz(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new FreeeApiClient();

    await expect(client.detectState()).resolves.toBe('not_checked_in');
    selectIdentity(identities.second, 2);

    await expect(client.executeClockAction('checkin')).rejects.toMatchObject({
      code: FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].method).toBe('GET');
  });

  it('rechecks scheduler authorization after the final state GET and before POST', async () => {
    const stateRequest = deferred();
    const stateResponse = deferred();
    let generationCurrent = true;
    global.fetch = vi.fn(async (_url, options) => {
      expect(options.method).toBe('GET');
      stateRequest.resolve();
      return stateResponse.promise;
    });
    const mutationAuthorizationGuard = vi.fn(() => {
      if (!generationCurrent) {
        throw Object.assign(new Error('synthetic stale generation'), {
          code: 'SCHEDULE_GENERATION_STALE',
        });
      }
    });
    const client = new FreeeApiClient();
    const pending = client.executeClockAction('checkin', {
      mutationAuthorizationGuard,
    });

    await stateRequest.promise;
    generationCurrent = false;
    stateResponse.resolve(new Response(JSON.stringify({
      available_types: ['clock_in'],
      base_date: todayStringInTz(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(pending).rejects.toMatchObject({
      code: 'SCHEDULE_GENERATION_STALE',
    });
    expect(mutationAuthorizationGuard).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rechecks scheduler authorization after a 401 token refresh before retrying POST', async () => {
    const refreshStarted = deferred();
    const refreshResponse = deferred();
    let generationCurrent = true;
    global.fetch = vi.fn(async () => {
      const call = global.fetch.mock.calls.length;
      if (call === 1) {
        return new Response(JSON.stringify({
          available_types: ['clock_in'],
          base_date: todayStringInTz(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call === 2) return new Response('unauthorized', { status: 401 });
      if (call === 3) {
        refreshStarted.resolve();
        return refreshResponse.promise;
      }
      throw new Error('unexpected fetch after lifecycle cancellation');
    });
    const mutationAuthorizationGuard = vi.fn(() => {
      if (!generationCurrent) {
        throw Object.assign(new Error('synthetic stale generation'), {
          code: 'SCHEDULE_GENERATION_STALE',
        });
      }
    });
    const client = new FreeeApiClient();
    const pending = client.executeClockAction('checkin', {
      mutationAuthorizationGuard,
    });

    await refreshStarted.promise;
    generationCurrent = false;
    refreshResponse.resolve(new Response(JSON.stringify({
      access_token: 'synthetic-refreshed-access-token',
      refresh_token: 'synthetic-refreshed-refresh-token',
      expires_in: 3600,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(pending).rejects.toMatchObject({
      code: 'SCHEDULE_GENERATION_STALE',
    });
    expect(mutationAuthorizationGuard).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('runs the scheduler guard before both attendance POST attempts after a 401', async () => {
    global.fetch = vi.fn(async (_url, options) => {
      const call = global.fetch.mock.calls.length;
      if (call === 1 || call === 5) {
        return new Response(JSON.stringify({
          available_types: call === 1 ? ['clock_in'] : ['clock_out'],
          base_date: todayStringInTz(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call === 2) return new Response('unauthorized', { status: 401 });
      if (call === 3) {
        return new Response(JSON.stringify({
          access_token: 'synthetic-retry-access-token',
          refresh_token: 'synthetic-retry-refresh-token',
          expires_in: 3600,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call === 4) return new Response(JSON.stringify({ employee_time_clock: { id: 7, type: 'clock_in', date: todayStringInTz() } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`unexpected fetch method ${options.method}`);
    });
    const mutationAuthorizationGuard = vi.fn();
    const client = new FreeeApiClient();

    await expect(client.executeClockAction('checkin', {
      mutationAuthorizationGuard,
    })).resolves.toMatchObject({ status: 'success' });

    expect(mutationAuthorizationGuard).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  it('rejects an asynchronous dispatch guard before making a request', async () => {
    global.fetch = vi.fn();
    const client = new FreeeApiClient();

    await expect(client.apiRequest(
      'POST',
      '/employees/1001/time_clocks',
      { company_id: 101, type: 'clock_in', base_date: '2026-05-18' },
      { beforeDispatch: async () => undefined },
    )).rejects.toMatchObject({
      code: 'API_DISPATCH_GUARD_ASYNC_UNSUPPORTED',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('runs the asynchronous precondition before the synchronous dispatch guard', async () => {
    const order = [];
    global.fetch = vi.fn(async () => {
      order.push('fetch');
      return new Response(null, { status: 204 });
    });
    const client = new FreeeApiClient();

    await expect(client.apiRequest(
      'POST',
      '/employees/1001/time_clocks',
      { company_id: 101, type: 'clock_in', base_date: '2026-05-18' },
      {
        beforeDispatchAsync: async () => {
          order.push('async-start');
          await Promise.resolve();
          order.push('async-end');
        },
        beforeDispatch: () => order.push('sync'),
      },
    )).resolves.toBeNull();
    expect(order).toEqual(['async-start', 'async-end', 'sync', 'fetch']);
  });

  it('reruns the asynchronous precondition before a 401 retry', async () => {
    global.fetch = vi.fn(async () => {
      const call = global.fetch.mock.calls.length;
      if (call === 1) return new Response('unauthorized', { status: 401 });
      if (call === 2) {
        return new Response(JSON.stringify({
          access_token: 'synthetic-retry-access-token',
          refresh_token: 'synthetic-retry-refresh-token',
          expires_in: 3600,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call === 3) return new Response(null, { status: 204 });
      throw new Error('unexpected fetch');
    });
    const beforeDispatchAsync = vi.fn(async () => {});
    const client = new FreeeApiClient();

    await expect(client.apiRequest(
      'POST',
      '/employees/1001/time_clocks',
      { company_id: 101, type: 'clock_in', base_date: '2026-05-18' },
      { beforeDispatchAsync },
    )).resolves.toBeNull();
    expect(beforeDispatchAsync).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('reports an unknown mutation outcome when identity changes after dispatch', async () => {
    const started = deferred();
    const response = deferred();
    global.fetch = vi.fn(async () => {
      started.resolve();
      return response.promise;
    });
    const client = new FreeeApiClient();
    const pending = client.apiRequest(
      'POST',
      '/employees/1001/time_clocks',
      { company_id: 101, type: 'clock_in', base_date: '2026-05-18' },
    );

    await started.promise;
    selectIdentity(identities.second, 2);
    response.resolve(new Response(null, { status: 204 }));

    await expect(pending).rejects.toMatchObject({
      code: FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not return a successful GET body after the selected identity changes', async () => {
    const jsonStarted = deferred();
    const body = deferred();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        jsonStarted.resolve();
        return body.promise;
      },
    }));
    const client = new FreeeApiClient();
    const pending = client.apiRequest('GET', '/users/me');

    await jsonStarted.promise;
    selectIdentity(identities.second, 2);
    body.resolve({ company: 'obsolete-company-payload' });

    await expect(pending).rejects.toMatchObject({
      code: FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED,
    });
  });

  it('does not let an obsolete 401 body mark a new identity as broken', async () => {
    const textStarted = deferred();
    const body = deferred();
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => {
        textStarted.resolve();
        return body.promise;
      },
    }));
    const client = new FreeeApiClient();
    const pending = client.apiRequest('GET', '/users/me');

    await textStarted.promise;
    selectIdentity(identities.second, 2);
    body.resolve('synthetic unauthorized response');

    await expect(pending).rejects.toMatchObject({
      code: FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED,
    });
    expect(getSetting('oauth_auth_broken')).toBe('0');
  });
});
