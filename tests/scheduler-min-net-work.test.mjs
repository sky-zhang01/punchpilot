import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeToMinutes } from '../shared/date-time.js';

const mocks = vi.hoisted(() => ({
  identityKey: 'v1:synthetic-identity',
  connectionMode: 'api',
  debugMode: false,
  settings: new Map(),
  configs: [],
  msUntil: new Map(),
  insertLog: vi.fn(),
  executeAction: vi.fn(),
  setDailySchedule: vi.fn(),
  markDailyScheduleExecuted: vi.fn(),
  updateDailyScheduleStatus: vi.fn(),
  detectCurrentState: vi.fn(),
  determineActionsForToday: vi.fn(),
  detectWebNonWorkingStatus: vi.fn(),
  getTodayTimeClocks: vi.fn(),
  todayDate: '2026-07-11',
  dailySchedule: [],
}));

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })) },
}));

vi.mock('../server/db.js', () => ({
  getAllConfig: () => mocks.configs,
  getSetting: (key) => mocks.settings.get(key) || '0',
  insertLog: mocks.insertLog,
  getDailySchedule: () => mocks.dailySchedule,
  setDailySchedule: mocks.setDailySchedule,
  markDailyScheduleExecuted: mocks.markDailyScheduleExecuted,
  updateDailyScheduleStatus: mocks.updateDailyScheduleStatus,
  cleanOldSchedules: vi.fn(),
  cleanExpiredLeaveStrategyCache: vi.fn(),
  cleanOldAsyncTasks: vi.fn(),
  currentExecutionLogIdentityKey: () => `log-v1:${'a'.repeat(64)}`,
}));

vi.mock('../server/automation/index.js', () => ({
  executeAction: mocks.executeAction,
  detectCurrentState: mocks.detectCurrentState,
  detectWebNonWorkingStatus: mocks.detectWebNonWorkingStatus,
  determineActionsForToday: mocks.determineActionsForToday,
  hasApiCredentials: () => true,
  isDebugMode: () => mocks.debugMode,
  FREEE_STATE: {
    NOT_CHECKED_IN: 'not_checked_in',
    WORKING: 'working',
    ON_BREAK: 'on_break',
    CHECKED_OUT: 'checked_out',
    UNKNOWN: 'unknown',
  },
  getConnectionMode: () => mocks.connectionMode,
}));

vi.mock('../server/freee-api.js', () => ({
  FREEE_AUTH_ERROR_CODES: { AUTH_REQUIRED: 'AUTH_REQUIRED', AUTH_TRANSIENT: 'AUTH_TRANSIENT' },
  isOAuthAuthBroken: () => false,
  FreeeApiClient: class {
    getWorkRecord() { return Promise.resolve({ date: '2026-07-11' }); }
    getTodayTimeClocks() { return mocks.getTodayTimeClocks(); }
  },
}));

vi.mock('../server/automation/identity.js', () => ({
  currentAutomationIdentityKey: () => mocks.identityKey,
  isWebAccountVerified: () => true,
}));

vi.mock('../server/holiday.js', () => ({
  isHolidayOrWeekend: vi.fn().mockResolvedValue(false),
  getTodayString: () => mocks.todayDate,
}));

vi.mock('../server/timezone.js', () => ({
  // A time without an explicit entry is far in the future.
  msUntilTimeInTz: (time) => (mocks.msUntil.has(time) ? mocks.msUntil.get(time) : 10 * 60 * 60 * 1000),
  getTimezone: () => 'Asia/Tokyo',
}));

vi.mock('../server/work-record-status.js', () => ({
  getWorkRecordNonWorkingDayStatus: () => ({ confirmed: true, isNonWorkingDay: false, reason: null, code: null }),
  workRecordMatchesDate: () => true,
}));

vi.mock('../server/logger.js', () => ({
  safeErrorMetadata: (error) => ({ code: error?.code || null }),
}));

const { Scheduler } = await import('../server/scheduler.js');

const success = { status: 'success', error: null, screenshotBefore: null, screenshotAfter: null, durationMs: 30 };

// 09:59 checkin, 79 minute break: 480 minutes of net work are reached at 19:18.
const SHORT_DAY = [
  { type: 'checkin', time: '09:59' },
  { type: 'break_start', time: '12:33' },
  { type: 'break_end', time: '13:52' },
];

function newScheduler() {
  const scheduler = new Scheduler();
  scheduler.activeIdentityKey = mocks.identityKey;
  scheduler.todaySchedule = { checkin: '09:59', break_start: '12:33', break_end: '13:52', checkout: '19:16' };
  return scheduler;
}

async function fireCheckout(scheduler) {
  await scheduler.runActionAttempt('checkout', '19:16', 0, scheduler.createScheduleContext());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-11T10:16:00Z'));
  mocks.connectionMode = 'api';
  mocks.debugMode = false;
  mocks.todayDate = '2026-07-11';
  mocks.identityKey = 'v1:synthetic-identity';
  mocks.settings = new Map([['auto_checkin_enabled', '1'], ['min_net_work_minutes', '480'], ['max_break_minutes', '75']]);
  mocks.configs = [];
  mocks.dailySchedule = [];
  mocks.msUntil = new Map();
  for (const mock of [
    mocks.insertLog, mocks.executeAction, mocks.setDailySchedule, mocks.markDailyScheduleExecuted,
    mocks.updateDailyScheduleStatus, mocks.detectCurrentState, mocks.determineActionsForToday,
    mocks.detectWebNonWorkingStatus, mocks.getTodayTimeClocks,
  ]) mock.mockReset();
  mocks.getTodayTimeClocks.mockResolvedValue(SHORT_DAY);
  mocks.executeAction.mockResolvedValue(success);
  mocks.detectCurrentState.mockResolvedValue('working');
  mocks.determineActionsForToday.mockReturnValue({ execute: [], skip: [], immediateActions: [] });
  mocks.detectWebNonWorkingStatus.mockResolvedValue({ confirmed: true, isNonWorkingDay: false, reason: null, code: null });
  // 19:18 is two minutes away.
  mocks.msUntil.set('19:18', 120_000);
});

afterEach(() => { vi.useRealTimers(); });

describe('scheduled checkout below the minimum net work', () => {
  it('re-arms the checkout at the earliest compliant minute and sends no punch', async () => {
    const scheduler = newScheduler();

    await fireCheckout(scheduler);

    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(scheduler.todaySchedule.checkout).toBe('19:18');
    expect(mocks.setDailySchedule).toHaveBeenCalledWith('2026-07-11', 'checkout', '19:18', mocks.identityKey);
    expect(scheduler.timers.checkout).toBeDefined();
    expect(mocks.insertLog).not.toHaveBeenCalled();
    expect(mocks.markDailyScheduleExecuted).not.toHaveBeenCalled();
    expect(mocks.updateDailyScheduleStatus).not.toHaveBeenCalled();
    expect(scheduler.skippedActions.has('checkout')).toBe(false);
    expect(scheduler.terminalActions.has('checkout')).toBe(false);

    mocks.msUntil.set('19:18', -1);
    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.all([...scheduler.inFlightRuns]);

    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(mocks.executeAction.mock.calls[0][0]).toBe('checkout');
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith('2026-07-11', 'checkout', 'success', null, mocks.identityKey);
  });

  it('punches at once when net work is already reached', async () => {
    const scheduler = newScheduler();
    mocks.msUntil.set('19:18', -1);
    await fireCheckout(scheduler);
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
  });

  it('punches as before when punch history cannot be read', async () => {
    const scheduler = newScheduler();
    mocks.getTodayTimeClocks.mockRejectedValue(new Error('unavailable'));
    await fireCheckout(scheduler);
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
  });

  it('punches as before without a checkin record, with an open break, or with empty history', async () => {
    for (const history of [[], [{ type: 'break_start', time: '12:00' }, { type: 'break_end', time: '13:00' }],
      [{ type: 'checkin', time: '09:59' }, { type: 'break_start', time: '12:33' }]]) {
      mocks.executeAction.mockClear();
      mocks.getTodayTimeClocks.mockResolvedValue(history);
      await fireCheckout(newScheduler());
      expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    }
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
  });

  it('punches as before in mock mode, where history is empty and never read', async () => {
    mocks.debugMode = true;
    await fireCheckout(newScheduler());
    expect(mocks.getTodayTimeClocks).not.toHaveBeenCalled();
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
  });

  it('punches as before when the minimum is off, without reading history', async () => {
    mocks.settings.set('min_net_work_minutes', '0');
    // A failed punch ends the run without the plan refresh, which reads history itself.
    mocks.executeAction.mockResolvedValue({ status: 'failure', error: 'permanent', errorCode: 'SYNTHETIC' });
    await fireCheckout(newScheduler());
    expect(mocks.getTodayTimeClocks).not.toHaveBeenCalled();
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
  });

  it('never postpones other scheduled actions', async () => {
    const scheduler = newScheduler();
    mocks.executeAction.mockResolvedValue({ status: 'failure', error: 'permanent', errorCode: 'SYNTHETIC' });
    await scheduler.runActionAttempt('break_end', '13:52', 0, scheduler.createScheduleContext());
    expect(mocks.getTodayTimeClocks).not.toHaveBeenCalled();
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
  });

  it('leaves a manual checkout untouched even when net work is below the minimum', async () => {
    const scheduler = newScheduler();
    const result = await scheduler.triggerManual('checkout');
    expect(result.status).toBe('success');
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(mocks.executeAction.mock.calls[0][0]).toBe('checkout');
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
    expect(scheduler.todaySchedule.checkout).toBe('19:16');
  });

  it('does not postpone a retry that carries a punch-history anchor', async () => {
    const scheduler = newScheduler();
    const context = scheduler.createScheduleContext();
    scheduler.apiTransientRetries.set(
      scheduler.apiTransientRetryKey(context.date, 'checkout', context.identityKey),
      { firstAttemptAt: Date.now() },
    );
    await scheduler.runActionAttempt('checkout', '19:16', 1, context);
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
  });

  it('caps the postponement at 23:59 for a very late checkin', async () => {
    const scheduler = newScheduler();
    mocks.getTodayTimeClocks.mockResolvedValue([{ type: 'checkin', time: '20:00' }]);
    mocks.msUntil.set('23:59', 60_000);
    await fireCheckout(scheduler);
    expect(scheduler.todaySchedule.checkout).toBe('23:59');
    expect(mocks.executeAction).not.toHaveBeenCalled();
  });
  it('stops without punching when the schedule is replaced while history is read', async () => {
    const scheduler = newScheduler();
    mocks.getTodayTimeClocks.mockImplementation(async () => {
      // A settings save re-initializes the scheduler during the read.
      scheduler.lifecycleGeneration += 1;
      return SHORT_DAY;
    });
    await fireCheckout(scheduler);
    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
    expect(mocks.updateDailyScheduleStatus).not.toHaveBeenCalled();
    expect(scheduler.timers.checkout).toBeUndefined();
  });
});

describe('re-resolving a day planned under the old 90 minute cap', () => {
  it('keeps a stored 79 minute break running instead of pausing it', async () => {
    const window = (action_type, start, end) =>
      ({ action_type, enabled: 1, mode: 'random', fixed_time: start, window_start: start, window_end: end });
    mocks.configs = [
      window('checkin', '09:50', '10:00'),
      window('checkout', '19:15', '20:00'),
      window('break_start', '12:00', '13:00'),
      window('break_end', '13:00', '14:00'),
    ];
    const row = (action_type, resolved_time, executed = 0) =>
      ({ action_type, resolved_time, executed, last_status: executed ? 'success' : 'pending', attempts: 0, last_error: null });
    mocks.dailySchedule = [
      row('checkin', '09:59', 1),
      row('break_start', '12:33', 1),
      row('break_end', '13:52'),
      row('checkout', '19:16'),
    ];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    expect(scheduler.todaySchedule).toMatchObject({ break_start: '12:33', break_end: '13:52' });
    expect(scheduler.configurationPausedActions.has('break_end')).toBe(false);
    expect(scheduler.terminalActions.has('break_end')).toBe(false);
    const pauseCodes = mocks.updateDailyScheduleStatus.mock.calls.map((call) => call[3]);
    expect(pauseCodes).not.toContain('BREAK_WINDOW_INCOMPATIBLE');
    expect(mocks.insertLog.mock.calls.map(([entry]) => entry.error_code)).not.toContain('BREAK_WINDOW_INCOMPATIBLE');
  });
});

describe('re-resolving break rows paused as incompatible', () => {
  const window = (action_type, start, end) =>
    ({ action_type, enabled: 1, mode: 'random', fixed_time: start, window_start: start, window_end: end });
  const fixedAt = (action_type, time) =>
    ({ action_type, enabled: 1, mode: 'fixed', fixed_time: time, window_start: time, window_end: time });
  const pausedRow = (action_type, resolved_time) => ({ action_type, resolved_time, executed: 0,
    last_status: 'paused_configuration', attempts: 0, last_error: 'BREAK_WINDOW_INCOMPATIBLE' });
  const pauseCodesFor = (action) => mocks.updateDailyScheduleStatus.mock.calls
    .filter((call) => call[1] === action).map((call) => call[3]);

  for (const [name, start, end] of [['a 150 minute pair', '12:00', '14:30'], ['an end before the start', '14:00', '12:00']]) {
    it(`pauses the placeholder pair again instead of arming it: ${name}`, async () => {
      mocks.configs = [window('checkin', '09:50', '10:00'), window('checkout', '19:15', '20:00'),
        fixedAt('break_start', start), fixedAt('break_end', end)];
      mocks.dailySchedule = [pausedRow('break_start', start), pausedRow('break_end', end)];
      const scheduler = newScheduler();
      await scheduler.resolveAndScheduleToday();

      for (const action of ['break_start', 'break_end']) {
        expect(scheduler.configurationPausedActions.has(action)).toBe(true);
        expect(scheduler.terminalActions.has(action)).toBe(true);
        expect(pauseCodesFor(action)).toContain('BREAK_WINDOW_INCOMPATIBLE');
        expect(scheduler.timers[action]).toBeUndefined();
      }
    });
  }

  it('replaces the placeholder pair with a planned one once the windows allow a break', async () => {
    mocks.configs = [window('checkin', '09:50', '10:00'), window('checkout', '19:15', '20:00'),
      window('break_start', '12:00', '13:00'), window('break_end', '13:00', '14:00')];
    mocks.dailySchedule = [pausedRow('break_start', '12:00'), pausedRow('break_end', '14:30')];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    const start = scheduler.todaySchedule.break_start;
    const end = scheduler.todaySchedule.break_end;
    const length = (Number(end.slice(0, 2)) * 60 + Number(end.slice(3))) - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3)));
    expect(end).not.toBe('14:30');
    expect(length).toBeGreaterThanOrEqual(60);
    expect(length).toBeLessThanOrEqual(75);
    expect(mocks.setDailySchedule).toHaveBeenCalledWith('2026-07-11', 'break_start', start, mocks.identityKey);
    expect(mocks.setDailySchedule).toHaveBeenCalledWith('2026-07-11', 'break_end', end, mocks.identityKey);
    expect(scheduler.configurationPausedActions.has('break_start')).toBe(false);
    expect(scheduler.configurationPausedActions.has('break_end')).toBe(false);
  });
});

describe('placeholder break rows across an unknown freee state and a restart', () => {
  const window = (action_type, start, end) =>
    ({ action_type, enabled: 1, mode: 'random', fixed_time: start, window_start: start, window_end: end });
  const fixedAt = (action_type, time) =>
    ({ action_type, enabled: 1, mode: 'fixed', fixed_time: time, window_start: time, window_end: time });
  const pausedRow = (action_type, resolved_time) => ({ action_type, resolved_time, executed: 0,
    last_status: 'paused_configuration', attempts: 0, last_error: 'BREAK_WINDOW_INCOMPATIBLE' });

  it('keeps the pause status and never arms the placeholder pair after the unknown-state skip', async () => {
    // Fixed break windows 12:00/13:40 cannot form a break under the 75 minute
    // cap; the stored pair is a 100 minute placeholder, not a plan.
    mocks.configs = [window('checkin', '09:50', '10:00'), window('checkout', '19:15', '20:00'),
      fixedAt('break_start', '12:00'), fixedAt('break_end', '13:40')];
    mocks.dailySchedule = [pausedRow('break_start', '12:00'), pausedRow('break_end', '13:40')];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();
    expect(scheduler.configurationPausedActions.has('break_start')).toBe(true);
    expect(scheduler.configurationPausedActions.has('break_end')).toBe(true);

    // The freee state stays unknown: the whole day's plan is recorded as skipped.
    mocks.updateDailyScheduleStatus.mockClear();
    scheduler.recordSmartScheduleSkip(
      { execute: [], skip: ['checkin', 'break_start', 'break_end', 'checkout'], immediateActions: [] },
      scheduler.createScheduleContext(),
    );
    expect(mocks.updateDailyScheduleStatus.mock.calls
      .filter((call) => ['break_start', 'break_end'].includes(call[1]))).toEqual([]);

    // Re-resolve with the rows as the database holds them after those writes.
    for (const call of mocks.updateDailyScheduleStatus.mock.calls) {
      const row = mocks.dailySchedule.find((candidate) => candidate.action_type === call[1]);
      if (row) {
        row.last_status = call[2];
        row.last_error = call[3];
        if (call[4]) row.attempts += 1;
      }
    }
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkin', 'break_start', 'break_end', 'checkout'], skip: [], immediateActions: [],
    });
    const restarted = newScheduler();
    await restarted.resolveAndScheduleToday();

    for (const action of ['break_start', 'break_end']) {
      expect(restarted.configurationPausedActions.has(action)).toBe(true);
      expect(restarted.terminalActions.has(action)).toBe(true);
      expect(restarted.timers[action]).toBeUndefined();
    }
  });
});

describe('the stored checkout when the punched break pair changes', () => {
  const window = (action_type, start, end) =>
    ({ action_type, enabled: 1, mode: 'random', fixed_time: start, window_start: start, window_end: end });
  const fixedAt = (action_type, time) =>
    ({ action_type, enabled: 1, mode: 'fixed', fixed_time: time, window_start: time, window_end: time });
  const pausedRow = (action_type, resolved_time) => ({ action_type, resolved_time, executed: 0,
    last_status: 'paused_configuration', attempts: 0, last_error: 'BREAK_WINDOW_INCOMPATIBLE' });
  const plannedRow = (action_type, resolved_time) => ({ action_type, resolved_time, executed: 0,
    last_status: 'pending', attempts: 0, last_error: null });
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

  it('moves an unexecuted checkout later when a placeholder pair becomes the plan', async () => {
    mocks.configs = [fixedAt('checkin', '10:00'), window('checkout', '18:00', '20:00'),
      window('break_start', '12:00', '13:00'), window('break_end', '13:00', '14:00')];
    mocks.dailySchedule = [
      { action_type: 'checkin', resolved_time: '10:00', executed: 1, last_status: 'success', attempts: 1, last_error: null },
      { action_type: 'checkout', resolved_time: '18:00', executed: 0, last_status: 'pending', attempts: 0, last_error: null },
      pausedRow('break_start', '12:00'), pausedRow('break_end', '14:30'),
    ];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    const checkout = scheduler.todaySchedule.checkout;
    const breakMinutes = minutes(scheduler.todaySchedule.break_end) - minutes(scheduler.todaySchedule.break_start);
    expect(breakMinutes).toBeGreaterThanOrEqual(60);
    expect(minutes(checkout)).toBeGreaterThan(minutes('18:00'));
    // 10:00 + the newly planned break + 480 minutes of net work.
    expect(minutes(checkout)).toBe(minutes('10:00') + breakMinutes + 480);
    expect(mocks.setDailySchedule).toHaveBeenCalledWith('2026-07-11', 'checkout', checkout, mocks.identityKey);
  });

  it('caps the moved checkout at 23:59', async () => {
    mocks.configs = [fixedAt('checkin', '16:00'), window('checkout', '18:00', '20:00'),
      fixedAt('break_start', '17:00'), fixedAt('break_end', '18:00')];
    mocks.dailySchedule = [
      { action_type: 'checkin', resolved_time: '16:00', executed: 1, last_status: 'success', attempts: 1, last_error: null },
      { action_type: 'checkout', resolved_time: '18:00', executed: 0, last_status: 'pending', attempts: 0, last_error: null },
      pausedRow('break_start', '17:00'), pausedRow('break_end', '18:30'),
    ];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    // 16:00 + 60 minutes + 480 minutes would be 01:00 the next day.
    expect(scheduler.todaySchedule.checkout).toBe('23:59');
    expect(mocks.setDailySchedule).toHaveBeenCalledWith('2026-07-11', 'checkout', '23:59', mocks.identityKey);
  });

  it('leaves the stored checkout alone on a plain restart where the pair did not change', async () => {
    mocks.configs = [fixedAt('checkin', '10:00'), window('checkout', '18:00', '20:00'),
      window('break_start', '12:00', '13:00'), window('break_end', '13:00', '14:00')];
    mocks.dailySchedule = [
      { action_type: 'checkin', resolved_time: '10:00', executed: 1, last_status: 'success', attempts: 1, last_error: null },
      plannedRow('break_start', '12:24'), plannedRow('break_end', '13:24'),
      { action_type: 'checkout', resolved_time: '19:00', executed: 0, last_status: 'pending', attempts: 0, last_error: null },
    ];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    expect(scheduler.todaySchedule).toMatchObject({ break_start: '12:24', break_end: '13:24', checkout: '19:00' });
    expect(mocks.setDailySchedule.mock.calls.filter((call) => call[1] === 'checkout')).toEqual([]);
  });
});

describe('stored break pairs across a cap change', () => {
  const window = (action_type, start, end) =>
    ({ action_type, enabled: 1, mode: 'random', fixed_time: start, window_start: start, window_end: end });
  const fixedAt = (action_type, time) =>
    ({ action_type, enabled: 1, mode: 'fixed', fixed_time: time, window_start: time, window_end: time });
  const row = (action_type, resolved_time, last_status = 'pending', last_error = null) =>
    ({ action_type, resolved_time, executed: 0, last_status, attempts: 0, last_error });
  const pauseCodesFor = (action) => mocks.updateDailyScheduleStatus.mock.calls
    .filter((call) => call[1] === action).map((call) => call[3]);
  const storedTimesFor = (action) => mocks.setDailySchedule.mock.calls
    .filter((call) => call[1] === action).map((call) => call[2]);

  it('moves check-out later when a placeholder pair comes back as a plan at the same times', async () => {
    // 80 minute fixed break: paused under a 75 minute cap, a plan once the cap is 90.
    mocks.settings.set('max_break_minutes', '90');
    mocks.configs = [fixedAt('checkin', '10:00'), window('checkout', '18:00', '20:00'),
      fixedAt('break_start', '12:00'), fixedAt('break_end', '13:20')];
    mocks.dailySchedule = [
      row('checkin', '10:00'),
      row('break_start', '12:00', 'paused_configuration', 'BREAK_WINDOW_INCOMPATIBLE'),
      row('break_end', '13:20', 'paused_configuration', 'BREAK_WINDOW_INCOMPATIBLE'),
      // Derived without a break while the pair was paused.
      row('checkout', '18:00'),
    ];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    expect(scheduler.todaySchedule).toMatchObject({ break_start: '12:00', break_end: '13:20' });
    expect(scheduler.configurationPausedActions.has('break_start')).toBe(false);
    expect(scheduler.configurationPausedActions.has('break_end')).toBe(false);
    // 10:00 + 80 minutes + 480 minutes
    expect(scheduler.todaySchedule.checkout).toBe('19:20');
    expect(storedTimesFor('checkout')).toEqual(['19:20']);
  });

  it('keeps an untouched pair planned under a higher cap after the cap is lowered', async () => {
    // A 105 minute break planned under a 120 minute cap; the cap is now 75.
    mocks.configs = [fixedAt('checkin', '10:00'), window('checkout', '18:00', '20:00'),
      fixedAt('break_start', '12:00'), fixedAt('break_end', '13:45')];
    mocks.dailySchedule = [row('checkin', '10:00'), row('break_start', '12:00'), row('break_end', '13:45'),
      row('checkout', '19:45')];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    expect(scheduler.todaySchedule).toMatchObject({ break_start: '12:00', break_end: '13:45', checkout: '19:45' });
    for (const action of ['break_start', 'break_end']) {
      expect(scheduler.configurationPausedActions.has(action)).toBe(false);
      expect(pauseCodesFor(action)).not.toContain('BREAK_WINDOW_INCOMPATIBLE');
    }
    expect(mocks.setDailySchedule).not.toHaveBeenCalled();
  });

  it('keeps a long plan whose rows an unknown-state skip rewrote after the cap is lowered', async () => {
    // 105 minute break planned under a 120 minute cap; the unknown-state skip
    // rewrote both rows, then the cap dropped to 75 and the windows allow nothing shorter.
    mocks.configs = [fixedAt('checkin', '10:00'), window('checkout', '18:00', '20:00'),
      fixedAt('break_start', '12:00'), fixedAt('break_end', '13:45')];
    mocks.dailySchedule = [row('checkin', '10:00'),
      row('break_start', '12:00', 'skipped_unknown', 'Attendance state could not be determined'),
      row('break_end', '13:45', 'skipped_unknown', 'Attendance state could not be determined'),
      row('checkout', '19:45')];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    expect(scheduler.todaySchedule).toMatchObject({ break_start: '12:00', break_end: '13:45', checkout: '19:45' });
    for (const action of ['break_start', 'break_end']) {
      expect(scheduler.configurationPausedActions.has(action)).toBe(false);
      expect(pauseCodesFor(action)).not.toContain('BREAK_WINDOW_INCOMPATIBLE');
    }
  });

  it('draws again an unstarted pair no cap could produce', async () => {
    mocks.configs = [fixedAt('checkin', '10:00'), window('checkout', '19:00', '20:00'),
      window('break_start', '12:00', '13:00'), window('break_end', '13:00', '14:00')];
    mocks.dailySchedule = [row('checkin', '10:00'), row('break_start', '10:00', 'skipped_unknown', 'x'),
      row('break_end', '14:00', 'skipped_unknown', 'x'), row('checkout', '19:30')];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    const length = timeToMinutes(scheduler.todaySchedule.break_end) - timeToMinutes(scheduler.todaySchedule.break_start);
    expect(length).toBeGreaterThanOrEqual(60);
    expect(length).toBeLessThanOrEqual(75);
    expect(storedTimesFor('break_start')).toEqual([scheduler.todaySchedule.break_start]);
  });
  it('keeps a placeholder end paused next to a break that already started, until a valid end exists', async () => {
    // break_start ran at 12:28; the end window was then edited to 14:56 (148 minutes, over a 110 cap).
    mocks.settings.set('max_break_minutes', '110');
    mocks.configs = [fixedAt('checkin', '08:38'), fixedAt('checkout', '19:08'),
      fixedAt('break_start', '12:28'), fixedAt('break_end', '14:56')];
    const started = { ...row('break_start', '12:28'), executed: 1, attempts: 1, last_status: 'success' };
    mocks.dailySchedule = [{ ...row('checkin', '08:38'), executed: 1, attempts: 1, last_status: 'success' }, started,
      row('break_end', '14:56', 'paused_configuration', 'BREAK_WINDOW_INCOMPATIBLE'), row('checkout', '19:08')];
    const restarted = newScheduler();
    await restarted.resolveAndScheduleToday();
    expect(restarted.configurationPausedActions.has('break_end')).toBe(true);
    expect(restarted.terminalActions.has('break_end')).toBe(true);
    expect(restarted.timers.break_end).toBeUndefined();

    // A cap that allows the 148 minute break turns the same end into a plan.
    mocks.settings.set('max_break_minutes', '150');
    const raised = newScheduler();
    await raised.resolveAndScheduleToday();
    expect(raised.configurationPausedActions.has('break_end')).toBe(false);
    expect(raised.todaySchedule.break_end).toBe('14:56');
  });
  it('moves check-out later when a placeholder end beside a started break becomes the plan at the same time', async () => {
    // Check-in 09:00 and break start 12:00 ran; the 14:30 end did not fit the cap and was paused.
    mocks.settings.set('max_break_minutes', '150');
    mocks.configs = [fixedAt('checkin', '09:00'), window('checkout', '18:00', '21:00'),
      fixedAt('break_start', '12:00'), fixedAt('break_end', '14:30')];
    mocks.dailySchedule = [
      { ...row('checkin', '09:00'), executed: 1, attempts: 1, last_status: 'success' },
      { ...row('break_start', '12:00'), executed: 1, attempts: 1, last_status: 'success' },
      row('break_end', '14:30', 'paused_configuration', 'BREAK_WINDOW_INCOMPATIBLE'),
      row('checkout', '18:00'),
    ];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    expect(scheduler.todaySchedule.break_end).toBe('14:30');
    expect(scheduler.configurationPausedActions.has('break_end')).toBe(false);
    // 09:00 + 150 minutes + 480 minutes; the stored 18:00 left 390 minutes of net work.
    expect(scheduler.todaySchedule.checkout).toBe('19:30');
    expect(storedTimesFor('checkout')).toEqual(['19:30']);
  });
  it('moves a short check-out an older version drew on its own later on the upgrade day (the 10/29 plan)', async () => {
    mocks.configs = [window('checkin', '09:50', '10:00'), window('checkout', '19:15', '20:00'),
      window('break_start', '12:00', '13:00'), window('break_end', '13:00', '14:00')];
    mocks.dailySchedule = [row('checkin', '09:59'), row('break_start', '12:33'), row('break_end', '13:52'),
      row('checkout', '19:16')];
    const scheduler = newScheduler();
    await scheduler.resolveAndScheduleToday();

    // 09:59 + 79 minutes + 480 minutes; the 79 minute break stays the plan under the 75 cap.
    expect(scheduler.todaySchedule).toMatchObject({ checkin: '09:59', break_start: '12:33', break_end: '13:52', checkout: '19:18' });
    expect(storedTimesFor('checkout')).toEqual(['19:18']);
    expect(storedTimesFor('break_start')).toEqual([]);
  });
});
