import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FREEE_API_ERROR_CODES,
  FreeeApiClient,
} from '../server/freee-api.js';
import { determineActionsForToday } from '../server/automation/scheduling.js';
import { FREEE_STATE } from '../server/constants.js';
import { getSetting, initDatabase, setSetting } from '../server/db.js';
import { todayStringInTz } from '../server/timezone.js';

const originalFetch = global.fetch;
const oauthSettingKeys = [
  'oauth_configured',
  'oauth_identity_generation',
  'oauth_company_id',
  'oauth_employee_id',
  'oauth_company_name',
  'oauth_companies',
  'oauth_auth_broken',
  'oauth_auth_broken_since',
  'oauth_auth_broken_reason',
];
const savedSettings = new Map();

beforeEach(() => {
  initDatabase();
  savedSettings.clear();
  for (const key of oauthSettingKeys) savedSettings.set(key, getSetting(key));
  setSetting('oauth_configured', '1');
  setSetting('oauth_identity_generation', '1');
  setSetting('oauth_company_id', '12345');
  setSetting('oauth_employee_id', '67890');
  setSetting('oauth_company_name', 'Example Company');
  setSetting('oauth_companies', JSON.stringify([{
    id: 12345,
    employee_id: 67890,
    name: 'Example Company',
    display_name: 'Example User',
  }]));
  setSetting('oauth_auth_broken', '0');
  setSetting('oauth_auth_broken_since', '');
  setSetting('oauth_auth_broken_reason', '');
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const [key, value] of savedSettings) setSetting(key, value ?? '');
  savedSettings.clear();
});

function clientWithToken() {
  const client = new FreeeApiClient();
  client.ensureValidToken = async () => 'synthetic-access-token';
  return client;
}

function respondWithJson(payload) {
  global.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Freee API privacy boundary', () => {
  it('classifies failures without reflecting an upstream response body', async () => {
    const marker = 'synthetic-upstream-private-marker';
    global.fetch = async () => new Response(JSON.stringify({ message: marker }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await clientWithToken()
      .apiRequest('GET', '/users/me')
      .catch(caught => caught);

    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.message).not.toContain(marker);
  });

  it('normalizes employee, date, and query identifiers in request logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    await clientWithToken().apiRequest(
      'GET',
      '/employees/synthetic-employee/work_records/2026-01-02?company_id=synthetic-company',
    );

    const output = log.mock.calls.flat().map(String).join('\n');
    expect(output).not.toContain('synthetic-employee');
    expect(output).not.toContain('synthetic-company');
    expect(output).toContain('/employees/:employee/work_records/:date');
  });

  it('does not return the raw clock API payload to callers', async () => {
    const client = clientWithToken();
    client.companyId = 'synthetic-company';
    client.employeeId = 'synthetic-employee';
    client.ensureUserInfo = async () => {};
    client.apiRequest = async () => ({ employee_time_clock: { id: 7, type: 'clock_in', date: '2026-07-12', private_note: 'marker' } });
    client.detectStateSnapshot = async () => ({
      state: 'not_checked_in',
      baseDate: '2026-07-12',
      availableTypes: ['clock_in'],
    });
    client.detectState = async () => 'working';

    const result = await client.executeClockAction('checkin');

    expect(result.status).toBe('success');
    expect(result).not.toHaveProperty('apiResponse');
  });

  it.each([
    null, {}, { employee_time_clock: { id: true, type: 'clock_in', date: '2026-07-12' } },
    { employee_time_clock: { id: 7, type: 'clock_out', date: '2026-07-12' } },
    { employee_time_clock: { id: 7, type: 'clock_in', date: '2026-07-11' } },
  ])('does not report an unconfirmed clock creation as success %#', async (payload) => {
    const client = clientWithToken();
    client.detectStateSnapshot = async () => ({ baseDate: '2026-07-12', availableTypes: ['clock_in'] });
    client.apiRequest = vi.fn().mockResolvedValue(payload);
    await expect(client.executeClockAction('checkin')).rejects.toMatchObject({ code: 'API_RESPONSE_UNCONFIRMED' });
    expect(client.apiRequest).toHaveBeenCalledTimes(1);
  });

  it('retains a confirmed synchronous creation when the display-state read is unavailable', async () => {
    const client = clientWithToken();
    client.detectStateSnapshot = async () => ({ baseDate: '2026-07-12', availableTypes: ['clock_out'] });
    client.apiRequest = vi.fn().mockResolvedValue({ employee_time_clock: { id: 7, type: 'clock_out', date: '2026-07-12' } });
    client.detectState = async () => { throw new Error('unavailable'); };
    await expect(client.executeClockAction('checkout')).resolves.toMatchObject({ status: 'success', detectedState: 'unknown' });
    expect(client.apiRequest).toHaveBeenCalledTimes(1);
  });

  it('requires the documented creation status without retrying an ambiguous response', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(clientWithToken().apiRequest('POST', '/employees/67890/time_clocks', { type: 'clock_in' }, { expectedStatus: 201 }))
      .rejects.toMatchObject({ code: 'API_RESPONSE_UNCONFIRMED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds history by business date and reads subsequent full pages', async () => {
    const today = todayStringInTz();
    const record = { type: 'clock_in', date: today, datetime: `${today}T09:00:00+09:00` };
    global.fetch = vi.fn(async url => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('from_date')).toBe(today);
      expect(parsed.searchParams.get('to_date')).toBe(today);
      return new Response(JSON.stringify(parsed.searchParams.get('offset') === '0' ? Array.from({ length: 100 }, (_, i) => ({ ...record, id: i + 1 })) : [{ ...record, id: 101 }]), { status: 200 });
    });
    await expect(clientWithToken().getTodayTimeClocks()).resolves.toHaveLength(101);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('classifies current Web-only combined leave errors without reflecting the body', async () => {
    const marker = 'synthetic-private-leave-marker';
    global.fetch = async () => new Response(JSON.stringify({
      errors: [{ messages: [`特別休暇が2つ登録されています。Webで確認してください。${marker}`] }],
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await clientWithToken()
      .apiRequest(
        'GET',
        '/employees/synthetic-employee/work_records/2026-01-02?company_id=synthetic-company',
      )
      .catch(caught => caught);

    expect(error.code).toBe('WEB_ONLY_LEAVE_COMBINATION');
    expect(error.message).not.toContain(marker);
  });

  it('does not classify department text outside approval endpoints as Web fallback', async () => {
    global.fetch = async () => new Response(JSON.stringify({
      message: '部門データを取得できません',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await clientWithToken()
      .apiRequest('GET', '/users/me')
      .catch(caught => caught);

    expect(error.code).toBe('API_ERROR_400');
  });

  it('marks malformed successful mutation responses as unconfirmed', async () => {
    global.fetch = async () => new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await clientWithToken()
      .apiRequest('PUT', '/employees/1/work_records/2026-01-02?company_id=2', {
        company_id: 2,
      })
      .catch(caught => caught);

    expect(error.code).toBe('API_RESPONSE_UNCONFIRMED');
    expect(error.message).not.toContain('not-json');
  });

  it('accepts a verified empty time clock history', async () => {
    respondWithJson([]);

    await expect(clientWithToken().getTodayTimeClocks()).resolves.toEqual([]);
  });

  it('maps a valid time clock history without exposing upstream-only fields', async () => {
    const today = todayStringInTz();
    const privateMarker = 'synthetic-time-clock-private-marker';
    const payload = [
      ['clock_out', '18:00'],
      ['clock_in', '09:00'],
      ['break_begin', '12:00'],
      ['break_end', '13:00'],
    ].map(([type, time], index) => ({
      id: index + 1,
      type,
      date: today,
      datetime: `${today}T${time}:00.000+09:00`,
      note: privateMarker,
    }));
    respondWithJson(payload);

    const result = await clientWithToken().getTodayTimeClocks();

    expect(result).toEqual([
      { type: 'checkin', time: '09:00', datetime: `${today}T09:00:00.000+09:00` },
      { type: 'break_start', time: '12:00', datetime: `${today}T12:00:00.000+09:00` },
      { type: 'break_end', time: '13:00', datetime: `${today}T13:00:00.000+09:00` },
      { type: 'checkout', time: '18:00', datetime: `${today}T18:00:00.000+09:00` },
    ]);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it.each([
    ['object', { private_marker: 'synthetic-time-clock-private-marker' }],
    ['null', null],
    ['string', 'synthetic-time-clock-private-marker'],
    [
      'wrapped object',
      { time_clocks: [{ private_marker: 'synthetic-time-clock-private-marker' }] },
    ],
  ])(
    'rejects a malformed %s time clock history with a sanitized error',
    async (_shape, payload) => {
      respondWithJson(payload);

      const error = await clientWithToken()
        .getTodayTimeClocks()
        .catch(caught => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED);
      expect(error.message).toBe('freee time clock history response could not be confirmed.');
      expect(error.message).not.toContain('synthetic-time-clock-private-marker');
      expect(error).not.toHaveProperty('cause');
    },
  );

  it('does not plan duplicate break actions when time clock history is malformed', async () => {
    const schedule = {
      checkin: '09:00',
      break_start: '12:00',
      break_end: '13:00',
      checkout: '18:00',
    };
    const verifiedEmptyPlan = determineActionsForToday(
      FREEE_STATE.WORKING,
      schedule,
      [],
      '10:00',
    );
    respondWithJson({ time_clocks: [] });
    const punchHistory = await clientWithToken()
      .getTodayTimeClocks()
      .catch(() => null);
    const malformedPlan = determineActionsForToday(
      FREEE_STATE.WORKING,
      schedule,
      punchHistory,
      '10:00',
    );

    expect(verifiedEmptyPlan.execute).toEqual(['break_start', 'break_end', 'checkout']);
    expect(malformedPlan.execute).toEqual(['checkout']);
    expect(malformedPlan.skip).toEqual(['checkin', 'break_start', 'break_end']);
    expect(malformedPlan.reason).toContain('Punch history unavailable');
  });

  it('accepts empty 204 responses from delete-style mutations', async () => {
    global.fetch = async () => new Response(null, { status: 204 });

    await expect(
      clientWithToken().apiRequest('DELETE', '/approval_requests/work_times/1'),
    ).resolves.toBeNull();
  });
});
