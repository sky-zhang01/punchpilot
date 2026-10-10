import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identity: 'A',
  holidayCalls: 0,
  switchMode: 'none',
  detectCurrentState: vi.fn(),
  apiConfigured: false,
  punchTimes: [],
  todaySchedule: {},
}));

vi.mock('../server/db.js', () => ({
  currentExecutionLogIdentityKey: () => `log-${mocks.identity}`,
  getSetting: (key) => ({
    auto_checkin_enabled: '1',
    freee_configured: '1',
    oauth_auth_broken: '0',
  })[key] || '',
  getLogsByDate: (_date, identityKey) => [{ action_type: identityKey }],
  getAllConfig: () => [],
  getDailySchedule: (_date, identityKey) => [{ identity_key: identityKey }],
}));

vi.mock('../server/scheduler.js', () => ({
  scheduler: {
    getTodaySchedule: () => mocks.todaySchedule,
    getActiveIdentityKey: () => `automation-${mocks.identity}`,
    getStartupAnalysis: () => null,
    getSkippedActions: () => [],
  },
}));

vi.mock('../server/holiday.js', () => ({
  getTodayString: () => '2026-07-12',
  isHolidayOrWeekend: async () => {
    mocks.holidayCalls += 1;
    if (mocks.switchMode === 'once' && mocks.holidayCalls === 1) {
      mocks.identity = 'B';
    } else if (mocks.switchMode === 'always') {
      mocks.identity = String.fromCharCode(mocks.identity.charCodeAt(0) + 1);
    }
    return false;
  },
}));

vi.mock('../server/automation/index.js', () => ({
  hasApiCredentials: () => mocks.apiConfigured,
  hasCredentials: () => true,
  isDebugMode: () => false,
  detectCurrentState: mocks.detectCurrentState,
  FREEE_STATE: { UNKNOWN: 'unknown' },
  getConnectionMode: () => 'api',
}));

vi.mock('../server/automation/identity.js', () => ({
  currentAutomationIdentityKey: () => `automation-${mocks.identity}`,
}));

vi.mock('../server/timezone.js', () => ({
  nowInTz: () => ({ hours: 0, minutes: 0 }),
  getTimezone: () => 'Asia/Tokyo',
}));

vi.mock('../server/freee-api.js', () => ({
  FreeeApiClient: class { async getTodayTimeClocks() { return mocks.punchTimes; } },
}));

vi.mock('../server/logger.js', () => ({
  default: {
    child: () => ({ error: vi.fn(), warn: vi.fn() }),
  },
  safeErrorMetadata: () => ({}),
}));

const { default: statusRouter } = await import('../server/routes/api-status.js');
const app = express();
app.use('/api/status', statusRouter);

beforeEach(() => {
  mocks.identity = 'A';
  mocks.holidayCalls = 0;
  mocks.switchMode = 'none';
  mocks.detectCurrentState.mockReset();
  mocks.apiConfigured = false;
  mocks.punchTimes = [];
  mocks.todaySchedule = {};
});

describe('freee state diagnostics', () => {
  it('does not expose unregistered internal error codes', async () => {
    mocks.detectCurrentState.mockRejectedValue(Object.assign(
      new Error('synthetic private state detail'),
      { code: 'UNREGISTERED_STATE_CODE' },
    ));

    const response = await request(app).get('/api/status/freee-state');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      state: 'unknown',
      valid_actions: [],
      error: 'attendance_state_unconfirmed',
      error_code: 'ATTENDANCE_STATE_UNCONFIRMED',
    });
    expect(JSON.stringify(response.body)).not.toContain('UNREGISTERED_STATE_CODE');
    expect(JSON.stringify(response.body)).not.toContain('synthetic private state detail');
  });
});

describe('dashboard status identity snapshot', () => {
  it.each([
    ['checkin', 'working'], ['break_start', 'on_break'], ['break_end', 'working'], ['checkout', 'checked_out'],
  ])('uses the latest %s for the displayed state and next action', async (type, expected) => {
    mocks.apiConfigured = true;
    mocks.punchTimes = [{ type, time: '09:00', datetime: '2026-07-12T09:00:00+09:00' }];
    mocks.todaySchedule = { checkout: '18:00' };
    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body.attendance_state).toBe(expected);
    if (type === 'checkout') expect(response.body.next_action).toBeNull();
    else expect(response.body.next_action.action_type).toBe('checkout');
  });

  it('rebuilds the whole snapshot after an account switch', async () => {
    mocks.switchMode = 'once';

    const response = await request(app).get('/api/status');

    expect(response.status).toBe(200);
    expect(response.body.today_logs).toEqual([{ action_type: 'log-B' }]);
    expect(response.body.today_schedule_status).toEqual([
      { identity_key: 'automation-B' },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('log-A');
    expect(mocks.holidayCalls).toBe(2);
  });

  it('returns no snapshot when the identity keeps changing', async () => {
    mocks.switchMode = 'always';

    const response = await request(app).get('/api/status');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'status_identity_changed',
      code: 'STATUS_IDENTITY_CHANGED',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/log-[A-Z]/);
    expect(mocks.holidayCalls).toBe(2);
  });
});
