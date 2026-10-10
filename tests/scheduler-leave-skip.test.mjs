import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workRecord: null,
  workRecordError: null,
  workRecordDate: null,
  apiCredentials: true,
  webNonWorkingStatus: null,
  webNonWorkingError: null,
  todayPunchTimes: [],
  connectionMode: 'api',
  detectCurrentState: vi.fn(),
  executeAction: vi.fn(),
  determineActionsForToday: vi.fn(),
  isHolidayOrWeekend: vi.fn(),
}));

const FREEE_STATE = {
  NOT_CHECKED_IN: 'not_checked_in',
  WORKING: 'working',
  ON_BREAK: 'on_break',
  CHECKED_OUT: 'checked_out',
  UNKNOWN: 'unknown',
};

vi.mock('../server/holiday.js', () => ({
  getTodayString: () => '2026-05-18',
  isHolidayOrWeekend: mocks.isHolidayOrWeekend,
}));

vi.mock('../server/timezone.js', () => ({
  msUntilTimeInTz: () => 60_000,
  getTimezone: () => 'Asia/Tokyo',
}));

vi.mock('../server/automation/index.js', () => ({
  FREEE_STATE,
  detectCurrentState: mocks.detectCurrentState,
  executeAction: mocks.executeAction,
  detectWebNonWorkingStatus: async () => {
    if (mocks.webNonWorkingError) throw mocks.webNonWorkingError;
    return mocks.webNonWorkingStatus;
  },
  determineActionsForToday: mocks.determineActionsForToday,
  hasApiCredentials: () => mocks.apiCredentials,
  isDebugMode: () => false,
  getConnectionMode: () => mocks.connectionMode,
}));

vi.mock('../server/freee-api.js', () => ({
  FREEE_AUTH_ERROR_CODES: {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    AUTH_TRANSIENT: 'AUTH_TRANSIENT',
  },
  isOAuthAuthBroken: () => false,
  markOAuthAuthBroken: vi.fn(),
  FreeeApiClient: class {
    async getWorkRecord(date) {
      mocks.workRecordDate = date;
      if (mocks.workRecordError) throw mocks.workRecordError;
      return mocks.workRecord;
    }

    async getTodayTimeClocks() {
      return mocks.todayPunchTimes;
    }
  },
}));

const {
  initDatabase,
  getDb,
  getDailySchedule: getDailyScheduleForIdentity,
  markDailyScheduleExecuted: markDailyScheduleExecutedForIdentity,
  setDailySchedule: setDailyScheduleForIdentity,
  setSetting,
  setSettingsAtomically,
} = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { currentAutomationIdentityKey } = await import(
  '../server/automation/identity.js'
);
const { scheduler } = await import('../server/scheduler.js');

function getDailySchedule(date) {
  return getDailyScheduleForIdentity(date, currentAutomationIdentityKey());
}

function setDailySchedule(date, actionType, resolvedTime) {
  return setDailyScheduleForIdentity(
    date,
    actionType,
    resolvedTime,
    currentAutomationIdentityKey(),
  );
}

function markDailyScheduleExecuted(date, actionType, status, error) {
  return markDailyScheduleExecutedForIdentity(
    date,
    actionType,
    status,
    error,
    currentAutomationIdentityKey(),
  );
}

function resetScheduleConfig() {
  const db = getDb();
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'checkin'").run('09:50');
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'break_start'").run('12:05');
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'break_end'").run('13:35');
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'checkout'").run('19:24');
}

function confirmedWorkingRecord(overrides = {}) {
  return {
    date: '2026-05-18',
    normal_work_mins: 480,
    is_absence: false,
    special_holiday: 0,
    half_special_holiday_mins: 0,
    hourly_special_holiday_mins: 0,
    paid_holidays: [],
    day_pattern: 'normal_day',
    schedule_pattern: '',
    clock_in_at: null,
    clock_out_at: null,
    work_record_segments: [],
    break_records: [],
    ...overrides,
  };
}

beforeEach(() => {
  initDatabase();
  const db = getDb();
  db.prepare('DELETE FROM daily_schedule').run();
  db.prepare('DELETE FROM execution_log').run();
  resetScheduleConfig();
  setSetting('auto_checkin_enabled', '1');
  setSetting('debug_mode', '0');
  setSetting('oauth_configured', '1');
  setSetting('connection_mode', 'api');
  setSettingsAtomically([
    ['freee_configured', '1'],
    ['freee_username_encrypted', encrypt('synthetic-web-user')],
    ['freee_password_encrypted', encrypt('synthetic-web-password')],
    ['web_company_name', 'Synthetic Web Company'],
    ['web_employee_id_encrypted', encrypt('1001')],
    ['web_identity_generation', '1'],
  ]);

  scheduler.stopAll();
  scheduler.activeIdentityKey = currentAutomationIdentityKey();
  scheduler.skippedActions.clear();
  scheduler.startupAnalysis = null;

  mocks.workRecord = null;
  mocks.workRecordError = null;
  mocks.workRecordDate = null;
  mocks.connectionMode = 'api';
  mocks.apiCredentials = true;
  mocks.webNonWorkingStatus = null;
  mocks.webNonWorkingError = null;
  mocks.todayPunchTimes = [];
  mocks.detectCurrentState.mockReset();
  mocks.executeAction.mockReset();
  mocks.determineActionsForToday.mockReset();
  mocks.isHolidayOrWeekend.mockResolvedValue(false);
});

describe('scheduler leave-day guard', () => {
  it('skips all automatic actions when freee work_record has approved full-day leave', async () => {
    mocks.workRecord = {
      date: '2026-05-18',
      paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
      normal_work_mins: 480,
    };

    await scheduler.resolveAndScheduleToday();

    expect(mocks.workRecordDate).toBe('2026-05-18');
    expect(mocks.detectCurrentState).not.toHaveBeenCalled();
    expect(mocks.determineActionsForToday).not.toHaveBeenCalled();

    expect(scheduler.getStartupAnalysis()).toMatchObject({
      state: 'leave',
      skip: ['checkin', 'checkout', 'break_start', 'break_end'],
      execute: [],
      nonWorkingDayCode: 'paid_holiday',
    });

    const rows = getDailySchedule('2026-05-18');
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.executed === 0)).toBe(true);
    expect(rows.every((row) => row.last_status === 'skipped')).toBe(true);

    const logs = getDb()
      .prepare('SELECT * FROM execution_log ORDER BY id')
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action_type: 'daily_resolution',
      status: 'skipped',
      trigger_type: 'scheduler',
    });
  });

  it('rechecks leave status immediately before a scheduled action executes', async () => {
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    mocks.workRecord = {
      date: '2026-05-18',
      normal_work_mins: 480,
      paid_holidays: [
        { type: 'half', days: 0.5, mins: 240 },
        { type: 'hourly', days: 0, mins: 240 },
      ],
    };

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.executeAction).not.toHaveBeenCalled();
    const [row] = getDailySchedule('2026-05-18');
    expect(row).toMatchObject({
      action_type: 'checkin',
      executed: 0,
      last_status: 'skipped',
    });
  });

  it('uses the integrated Web guard instead of an unrelated OAuth company in Browser mode', async () => {
    mocks.connectionMode = 'browser';
    setSetting('connection_mode', 'browser');
    scheduler.activeIdentityKey = currentAutomationIdentityKey();
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    mocks.workRecord = {
      date: '2026-05-18',
      paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
      normal_work_mins: 480,
    };
    mocks.executeAction.mockResolvedValue({
      status: 'skipped',
      error: 'non_working_day',
      errorCode: 'WEB_NON_WORKING_DAY_CONFIRMED',
      nonWorkingDayCode: 'paid_holiday',
      nonWorkingReason: 'freee Web marks the date as full-day paid holiday',
    });

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.workRecordDate).toBeNull();
    expect(mocks.executeAction).toHaveBeenCalledWith(
      'checkin',
      expect.objectContaining({
        expectedIdentityKey: scheduler.getActiveIdentityKey(),
        expectedDate: '2026-05-18',
        mutationAuthorizationGuard: expect.any(Function),
      }),
    );
    expect(getDailySchedule('2026-05-18')[0]).toMatchObject({
      executed: 0,
      last_status: 'skipped',
    });
  });

  it('uses the Web work-record guard at startup when OAuth read access is unavailable', async () => {
    mocks.connectionMode = 'browser';
    mocks.apiCredentials = false;
    mocks.webNonWorkingStatus = {
      confirmed: true,
      isNonWorkingDay: true,
      reason: 'freee Web marks the date as full-day paid holiday',
      code: 'paid_holiday',
    };
    setSetting('connection_mode', 'browser');
    setSetting('oauth_configured', '0');

    await scheduler.resolveAndScheduleToday();

    expect(mocks.workRecordDate).toBeNull();
    expect(scheduler.getStartupAnalysis()).toMatchObject({
      state: 'leave',
      nonWorkingDayCode: 'paid_holiday',
    });
  });

  it('does not schedule Browser actions when startup leave status is unconfirmed', async () => {
    mocks.connectionMode = 'browser';
    mocks.apiCredentials = false;
    mocks.webNonWorkingStatus = {
      confirmed: false,
      isNonWorkingDay: false,
      reason: null,
      code: 'work_record_unconfirmed',
    };
    setSetting('connection_mode', 'browser');
    setSetting('oauth_configured', '0');

    await scheduler.resolveAndScheduleToday();

    expect(mocks.detectCurrentState).not.toHaveBeenCalled();
    expect(mocks.determineActionsForToday).not.toHaveBeenCalled();
    expect(scheduler.timers).toEqual({});
    expect(scheduler.getStartupAnalysis()).toMatchObject({
      state: 'guard_unavailable',
      execute: [],
      guardUnavailable: true,
    });
    expect(getDailySchedule('2026-05-18').every((row) =>
      row.executed === 0 && row.last_status === 'guard_unavailable')).toBe(true);
  });

  it('stops remaining Browser-only actions after the integrated Web guard confirms leave', async () => {
    mocks.connectionMode = 'browser';
    mocks.apiCredentials = false;
    setSetting('connection_mode', 'browser');
    setSetting('oauth_configured', '0');
    scheduler.activeIdentityKey = currentAutomationIdentityKey();
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    mocks.executeAction.mockResolvedValue({
      status: 'skipped',
      error: 'non_working_day',
      errorCode: 'WEB_NON_WORKING_DAY_CONFIRMED',
      nonWorkingDayCode: 'paid_holiday',
      nonWorkingReason: 'freee Web marks the date as full-day paid holiday',
    });

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.workRecordDate).toBeNull();
    expect(getDailySchedule('2026-05-18')[0]).toMatchObject({
      executed: 0,
      last_status: 'skipped',
    });
  });

  it('pauses every pending Browser-only action when the integrated guard fails before mutation', async () => {
    mocks.connectionMode = 'browser';
    mocks.apiCredentials = false;
    setSetting('connection_mode', 'browser');
    setSetting('oauth_configured', '0');
    scheduler.activeIdentityKey = currentAutomationIdentityKey();
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    setDailySchedule('2026-05-18', 'checkout', '19:24');
    scheduler.timers.checkout = setTimeout(() => {}, 60_000);
    mocks.executeAction.mockResolvedValue({
      status: 'failure',
      error: 'web_credentials_invalid',
      errorCode: 'WEB_LOGIN_FAILED',
      guardUnavailable: true,
    });

    await scheduler.runAction('checkin', '09:50');

    const rows = getDailySchedule('2026-05-18');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.executed === 0)).toBe(true);
    expect(rows.every((row) => row.last_status === 'guard_unavailable')).toBe(true);
    expect(rows.find((row) => row.action_type === 'checkin').attempts).toBe(1);
    expect(rows.find((row) => row.action_type === 'checkout').attempts).toBe(0);
    expect(scheduler.timers).toEqual({});
  });

  it('fails closed before a scheduled action when an available guard cannot be read', async () => {
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    mocks.workRecordError = Object.assign(new Error('synthetic upstream detail'), {
      code: 'PERMISSION_DENIED',
    });

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.executeAction).not.toHaveBeenCalled();
    const [row] = getDailySchedule('2026-05-18');
    expect(row).toMatchObject({
      executed: 0,
      last_status: 'guard_unavailable',
    });
    expect(row.last_error).not.toContain('synthetic upstream detail');
  });

  it('fails closed when freee returns a work record for the wrong date', async () => {
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    mocks.workRecord = {
      date: '2026-05-17',
      normal_work_mins: 480,
      paid_holidays: [],
    };

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(getDailySchedule('2026-05-18')[0]).toMatchObject({
      executed: 0,
      last_status: 'guard_unavailable',
    });
  });

  it('fails closed when freee returns malformed leave fields for the right date', async () => {
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    mocks.workRecord = {
      date: '2026-05-18',
      normal_work_mins: 480,
      paid_holidays: 'schema-drift',
    };

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(getDailySchedule('2026-05-18')[0]).toMatchObject({
      executed: 0,
      last_status: 'guard_unavailable',
    });
  });

  it('preserves terminal schedule rows and resolved times across restart', async () => {
    setDailySchedule('2026-05-18', 'checkin', '09:57');
    markDailyScheduleExecuted('2026-05-18', 'checkin', 'success', null);
    mocks.workRecord = confirmedWorkingRecord();
    mocks.detectCurrentState.mockResolvedValue(FREEE_STATE.WORKING);
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkin', 'break_start', 'break_end', 'checkout'],
      skip: [],
      immediateActions: [],
      reason: 'synthetic restart plan',
    });

    await scheduler.resolveAndScheduleToday();

    const checkin = getDailySchedule('2026-05-18')
      .find((row) => row.action_type === 'checkin');
    expect(checkin).toMatchObject({
      resolved_time: '09:57',
      executed: 1,
      last_status: 'success',
    });
    expect(scheduler.getStartupAnalysis().execute).not.toContain('checkin');
    expect(scheduler.getStartupAnalysis().skip).toContain('checkin');
  });

  it('reopens checkout only when the latest punch sequence proves a new work occurrence', async () => {
    setDailySchedule('2026-05-18', 'checkout', '19:24');
    markDailyScheduleExecuted('2026-05-18', 'checkout', 'success', null);
    mocks.workRecord = confirmedWorkingRecord();
    mocks.todayPunchTimes = [
      { type: 'checkin', time: '09:00' },
      { type: 'checkout', time: '11:00' },
      { type: 'checkin', time: '13:00' },
    ];
    mocks.detectCurrentState.mockResolvedValue(FREEE_STATE.WORKING);
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkout'],
      skip: ['checkin', 'break_start', 'break_end'],
      immediateActions: [],
      reason: 'synthetic second work occurrence',
    });

    await scheduler.resolveAndScheduleToday();

    expect(scheduler.getStartupAnalysis().execute).toContain('checkout');
    expect(scheduler.getStartupAnalysis().skip).not.toContain('checkout');
    expect(scheduler.getSkippedActions()).not.toContain('checkout');
    expect(scheduler.timers.checkout).toBeDefined();
    expect(getDailySchedule('2026-05-18')
      .find((row) => row.action_type === 'checkout')).toMatchObject({
      executed: 0,
      last_status: 'pending',
    });
  });

  it('keeps a successful checkout terminal without a later checkin occurrence', async () => {
    setDailySchedule('2026-05-18', 'checkout', '19:24');
    markDailyScheduleExecuted('2026-05-18', 'checkout', 'success', null);
    mocks.workRecord = confirmedWorkingRecord();
    mocks.todayPunchTimes = [
      { type: 'checkin', time: '09:00' },
      { type: 'checkout', time: '11:00' },
    ];
    mocks.detectCurrentState.mockResolvedValue(FREEE_STATE.WORKING);
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkout'],
      skip: ['checkin', 'break_start', 'break_end'],
      immediateActions: [],
      reason: 'synthetic inconsistent state',
    });

    await scheduler.resolveAndScheduleToday();

    expect(scheduler.getStartupAnalysis().execute).not.toContain('checkout');
    expect(scheduler.getStartupAnalysis().skip).toContain('checkout');
    expect(scheduler.getSkippedActions()).toContain('checkout');
    expect(scheduler.timers.checkout).toBeUndefined();
    expect(getDailySchedule('2026-05-18')
      .find((row) => row.action_type === 'checkout')).toMatchObject({
      executed: 1,
      last_status: 'success',
    });
  });

  it('can schedule future actions after approved leave is withdrawn and reinitialized', async () => {
    mocks.workRecord = {
      date: '2026-05-18',
      normal_work_mins: 480,
      paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
    };
    await scheduler.resolveAndScheduleToday();

    expect(getDailySchedule('2026-05-18').every((row) => row.executed === 0)).toBe(true);

    mocks.workRecord = confirmedWorkingRecord();
    mocks.detectCurrentState.mockResolvedValue(FREEE_STATE.WORKING);
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkout'],
      skip: ['checkin', 'break_start', 'break_end'],
      immediateActions: [],
      reason: 'leave withdrawn',
    });

    await scheduler.resolveAndScheduleToday();

    expect(scheduler.getStartupAnalysis().execute).toContain('checkout');
    expect(scheduler.timers.checkout).toBeDefined();
    expect(getDailySchedule('2026-05-18')
      .find((row) => row.action_type === 'checkout').executed).toBe(0);
  });

  it('does not overwrite a completed action when leave is detected later', async () => {
    setDailySchedule('2026-05-18', 'checkin', '09:57');
    markDailyScheduleExecuted('2026-05-18', 'checkin', 'success', null);
    mocks.workRecord = {
      date: '2026-05-18',
      normal_work_mins: 480,
      paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
    };

    await scheduler.resolveAndScheduleToday();

    const rows = getDailySchedule('2026-05-18');
    expect(rows.find((row) => row.action_type === 'checkin')).toMatchObject({
      resolved_time: '09:57',
      executed: 1,
      last_status: 'success',
    });
    expect(rows
      .filter((row) => row.action_type !== 'checkin')
      .every((row) => row.executed === 0 && row.last_status === 'skipped'))
      .toBe(true);
  });

  it('records calendar holidays as re-verifiable schedule rows', async () => {
    mocks.isHolidayOrWeekend.mockResolvedValue(true);

    await scheduler.resolveAndScheduleToday();

    expect(mocks.detectCurrentState).not.toHaveBeenCalled();
    expect(getDailySchedule('2026-05-18')
      .every((row) => row.executed === 0 && row.last_status === 'skipped'))
      .toBe(true);
    expect(scheduler.getStartupAnalysis()).toMatchObject({
      state: 'holiday',
      nonWorkingDayCode: 'calendar_holiday',
    });
  });

  it('can schedule future actions after a custom holiday is withdrawn and reinitialized', async () => {
    mocks.isHolidayOrWeekend.mockResolvedValueOnce(true).mockResolvedValue(false);
    await scheduler.resolveAndScheduleToday();

    expect(getDailySchedule('2026-05-18').every((row) => row.executed === 0)).toBe(true);

    mocks.workRecord = confirmedWorkingRecord();
    mocks.detectCurrentState.mockResolvedValue(FREEE_STATE.WORKING);
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkout'],
      skip: ['checkin', 'break_start', 'break_end'],
      immediateActions: [],
      reason: 'custom holiday withdrawn',
    });

    await scheduler.resolveAndScheduleToday();

    expect(scheduler.getStartupAnalysis().execute).toContain('checkout');
    expect(scheduler.timers.checkout).toBeDefined();
    expect(getDailySchedule('2026-05-18')
      .find((row) => row.action_type === 'checkout').executed).toBe(0);
  });

  it('fails closed before a scheduled action when holiday data is unavailable', async () => {
    setDailySchedule('2026-05-18', 'checkin', '09:50');
    mocks.isHolidayOrWeekend.mockRejectedValue(
      Object.assign(new Error('synthetic holiday provider detail'), {
        code: 'HOLIDAY_DATA_UNAVAILABLE',
      }),
    );

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(getDailySchedule('2026-05-18')[0]).toMatchObject({
      executed: 0,
      last_status: 'guard_unavailable',
    });
    expect(getDailySchedule('2026-05-18')[0].last_error)
      .not.toContain('synthetic holiday provider detail');
  });
});
