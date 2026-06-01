import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workRecord: null,
  workRecordDate: null,
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

vi.mock('../server/automation/index.js', () => ({
  FREEE_STATE,
  detectCurrentState: mocks.detectCurrentState,
  executeAction: mocks.executeAction,
  determineActionsForToday: mocks.determineActionsForToday,
  hasCredentials: () => true,
  isDebugMode: () => false,
  getConnectionMode: () => 'api',
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
      return mocks.workRecord;
    }
  },
}));

const {
  initDatabase,
  getDb,
  getDailySchedule,
  setDailySchedule,
  setSetting,
} = await import('../server/db.js');
const { scheduler } = await import('../server/scheduler.js');

function resetScheduleConfig() {
  const db = getDb();
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'checkin'").run('09:50');
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'break_start'").run('12:05');
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'break_end'").run('13:35');
  db.prepare("UPDATE config SET enabled = 1, mode = 'fixed', fixed_time = ? WHERE action_type = 'checkout'").run('19:24');
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

  scheduler.stopAll();
  scheduler.skippedActions.clear();
  scheduler.startupAnalysis = null;

  mocks.workRecord = null;
  mocks.workRecordDate = null;
  mocks.detectCurrentState.mockReset();
  mocks.executeAction.mockReset();
  mocks.determineActionsForToday.mockReset();
  mocks.isHolidayOrWeekend.mockResolvedValue(false);
});

describe('scheduler leave-day guard', () => {
  it('skips all automatic actions when freee work_record has approved full-day leave', async () => {
    mocks.workRecord = {
      date: '2026-05-18',
      paid_holiday: 1,
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
    expect(rows.every((row) => row.executed === 1)).toBe(true);
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
      normal_work_mins_by_paid_holiday: 480,
    };

    await scheduler.runAction('checkin', '09:50');

    expect(mocks.executeAction).not.toHaveBeenCalled();
    const [row] = getDailySchedule('2026-05-18');
    expect(row).toMatchObject({
      action_type: 'checkin',
      executed: 1,
      last_status: 'skipped',
    });
  });
});
