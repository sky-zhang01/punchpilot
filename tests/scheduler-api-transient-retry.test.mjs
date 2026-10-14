import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identityKey: 'v1:synthetic-identity',
  connectionMode: 'api',
  settings: new Map(),
  configs: [],
  msUntil: new Map(),
  insertLog: vi.fn(),
  executeAction: vi.fn(),
  markDailyScheduleExecuted: vi.fn(),
  updateDailyScheduleStatus: vi.fn(),
  detectCurrentState: vi.fn(),
  determineActionsForToday: vi.fn(),
  detectWebNonWorkingStatus: vi.fn(),
  getWorkRecord: vi.fn(),
  getTodayTimeClocks: vi.fn(),
  todayDate: '2026-07-11',
}));

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })) },
}));

vi.mock('../server/db.js', () => ({
  getAllConfig: () => mocks.configs,
  getSetting: (key) => mocks.settings.get(key) || '0',
  insertLog: mocks.insertLog,
  getDailySchedule: () => [],
  setDailySchedule: vi.fn(),
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
  isDebugMode: () => false,
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
  FREEE_AUTH_ERROR_CODES: {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    AUTH_TRANSIENT: 'AUTH_TRANSIENT',
  },
  isOAuthAuthBroken: () => false,
  FreeeApiClient: class {
    getWorkRecord(date) { return mocks.getWorkRecord(date); }
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
  // Times without an explicit entry are far in the future.
  msUntilTimeInTz: (time) => (mocks.msUntil.has(time) ? mocks.msUntil.get(time) : 10 * 60 * 60 * 1000),
  getTimezone: () => 'Asia/Tokyo',
}));

vi.mock('../server/work-record-status.js', () => ({
  getWorkRecordNonWorkingDayStatus: () => ({
    confirmed: true,
    isNonWorkingDay: false,
    reason: null,
    code: null,
  }),
  workRecordMatchesDate: () => true,
}));

vi.mock('../server/logger.js', () => ({
  safeErrorMetadata: (error) => ({ code: error?.code || null }),
}));

const { Scheduler } = await import('../server/scheduler.js');
const { TRANSIENT_FREEE_API_ERROR_CODES } = await import('../server/automation-diagnostics.js');

const RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];

function failure(errorCode, failureStage = 'mutation') {
  return {
    status: 'failure',
    error: 'api_temporarily_unavailable',
    errorCode,
    failureStage,
    screenshotBefore: null,
    screenshotAfter: null,
    durationMs: 20,
  };
}

const success = {
  status: 'success',
  error: null,
  screenshotBefore: null,
  screenshotAfter: null,
  durationMs: 30,
};

// Mirrors executeAction's contract for `recordedPunchCheck`: it runs under the
// automation lock before anything is sent. `sent` counts punches actually sent.
let sent;
function executeWith(...results) {
  const queue = [...results];
  mocks.executeAction.mockImplementation(async (_actionType, options = {}) => {
    if (typeof options.recordedPunchCheck === 'function') {
      const recorded = await options.recordedPunchCheck();
      if (recorded === 'recorded') {
        return {
          ...success,
          error: 'Confirmed in freee punch history after a temporary freee API failure.',
          confirmedFromHistory: true,
        };
      }
      if (recorded !== 'not_recorded') return failure('API_TRANSIENT', 'state_read');
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next.status === 'success' || next.failureStage === 'mutation') sent += 1;
    return next;
  });
}

function newScheduler() {
  const scheduler = new Scheduler();
  scheduler.activeIdentityKey = mocks.identityKey;
  return scheduler;
}

// Fires due timers and waits for the scheduled runs they started.
async function advance(scheduler, ms) {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.all([...scheduler.inFlightRuns]);
}

function statusCalls(status) {
  return mocks.updateDailyScheduleStatus.mock.calls.filter((call) => call[2] === status);
}

function optionsOfCall(index) {
  return mocks.executeAction.mock.calls[index][1];
}

beforeEach(() => {
  vi.useFakeTimers();
  // 09:50 in Tokyo on the synthetic schedule date.
  vi.setSystemTime(new Date('2026-07-11T00:50:00Z'));
  sent = 0;
  mocks.connectionMode = 'api';
  mocks.todayDate = '2026-07-11';
  mocks.identityKey = 'v1:synthetic-identity';
  mocks.settings = new Map([['auto_checkin_enabled', '1']]);
  mocks.configs = [];
  mocks.msUntil = new Map();
  for (const mock of [
    mocks.insertLog,
    mocks.executeAction,
    mocks.markDailyScheduleExecuted,
    mocks.updateDailyScheduleStatus,
    mocks.detectCurrentState,
    mocks.determineActionsForToday,
    mocks.detectWebNonWorkingStatus,
    mocks.getWorkRecord,
    mocks.getTodayTimeClocks,
  ]) mock.mockReset();
  mocks.getWorkRecord.mockResolvedValue({ date: '2026-07-11' });
  mocks.getTodayTimeClocks.mockResolvedValue([]);
  mocks.detectCurrentState.mockResolvedValue('working');
  mocks.determineActionsForToday.mockReturnValue({ execute: [], skip: [], immediateActions: [] });
  mocks.detectWebNonWorkingStatus.mockResolvedValue({
    confirmed: true,
    isNonWorkingDay: false,
    reason: null,
    code: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduled punches after a transient freee API failure', () => {
  it('only treats codes that the freee client actually raises as transient', () => {
    const source = fs.readFileSync(path.resolve('server/freee-api.js'), 'utf8');
    const apiCodes = source.match(/export const FREEE_API_ERROR_CODES = \{([\s\S]*?)\};/)[1];
    for (const code of TRANSIENT_FREEE_API_ERROR_CODES) {
      if (code === 'ATTENDANCE_STATE_UNCONFIRMED') {
        // Raised as a literal when the requested clock type is no longer available.
        expect(source).toContain(`createFreeeError(\n        'The requested clock action is no longer available.',\n        '${code}',`);
      } else {
        expect(apiCodes, code).toContain(`${code}: '${code}',`);
      }
    }
  });

  it('retries the punch and checks punch history first', async () => {
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'), success);

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());

    // The check is now a closure that runs under the lock; on the first
    // attempt it finds no anchor and decides without reading punch history.
    expect(typeof optionsOfCall(0).recordedPunchCheck).toBe('function');
    expect(mocks.getTodayTimeClocks).not.toHaveBeenCalled();
    expect(statusCalls('retrying')).toHaveLength(1);
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();
    expect(mocks.markDailyScheduleExecuted).not.toHaveBeenCalled();

    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(typeof optionsOfCall(1).recordedPunchCheck).toBe('function');
    expect(mocks.getTodayTimeClocks).toHaveBeenCalled();
    expect(sent).toBe(2);
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkin', 'success', null, mocks.identityKey,
    );
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('does not send a punch again when freee already recorded it', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    executeWith(failure('API_RESPONSE_UNCONFIRMED'), success);
    // freee keeps clock_out available after a check-out, so a blind retry would punch twice.
    mocks.getTodayTimeClocks.mockResolvedValue([
      { type: 'checkin', time: '09:00', datetime: '2026-07-11T09:00:00+09:00' },
      { type: 'checkout', time: '09:50', datetime: '2026-07-11T09:50:02+09:00' },
    ]);

    await scheduler.runActionAttempt('checkout', '09:50', 0, scheduler.createScheduleContext());
    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(sent).toBe(1);
    expect(mocks.insertLog).toHaveBeenLastCalledWith(expect.objectContaining({
      action_type: 'checkout',
      status: 'success',
      error_message: 'Confirmed in freee punch history after a temporary freee API failure.',
    }));
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkout', 'success', null, mocks.identityKey,
    );
    expect(scheduler.refreshPlanForCurrentState).toHaveBeenCalledWith('scheduled checkout');
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('ignores punches recorded before the first failed attempt', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    executeWith(failure('API_TRANSIENT'), success);
    // An earlier check-out, two minutes before, that a later check-in re-opened.
    mocks.getTodayTimeClocks.mockResolvedValue([
      { type: 'checkout', time: '09:48', datetime: '2026-07-11T09:48:00+09:00' },
    ]);

    await scheduler.runActionAttempt('checkout', '09:50', 0, scheduler.createScheduleContext());
    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(sent).toBe(2);
  });

  it('waits for another retry when punch history cannot be read', async () => {
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'), success);
    mocks.getTodayTimeClocks
      .mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'API_TRANSIENT' }))
      .mockResolvedValue([]);

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());
    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(sent).toBe(1);
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();

    await advance(scheduler, RETRY_DELAYS_MS[1]);

    expect(sent).toBe(2);
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkin', 'success', null, mocks.identityKey,
    );
  });

  it('records a transient failure once the retries are used up', async () => {
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'));

    await scheduler.runActionAttempt('checkout', '09:50', 0, scheduler.createScheduleContext());
    for (const delay of RETRY_DELAYS_MS) await advance(scheduler, delay);

    expect(mocks.executeAction).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(statusCalls('retrying')).toHaveLength(RETRY_DELAYS_MS.length);
    const final = statusCalls('transient_failure');
    expect(final).toHaveLength(1);
    expect(final[0][3]).toContain('Retries stopped');
    expect(scheduler.timers['checkout:api-retry']).toBeUndefined();
    expect(scheduler.apiTransientRetries.size).toBe(0);
    expect(mocks.markDailyScheduleExecuted).not.toHaveBeenCalled();
  });

  it('stops retrying once the history read keeps failing through the last retry', async () => {
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'));
    mocks.getTodayTimeClocks.mockRejectedValue(Object.assign(new Error('down'), { code: 'API_TRANSIENT' }));

    await scheduler.runActionAttempt('checkout', '09:50', 0, scheduler.createScheduleContext());
    for (const delay of RETRY_DELAYS_MS) await advance(scheduler, delay);

    expect(sent).toBe(1);
    expect(statusCalls('transient_failure')).toHaveLength(1);
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('retries rate limits but not permanent API errors', async () => {
    const limited = newScheduler();
    executeWith(failure('RATE_LIMITED'));
    await limited.runActionAttempt('checkin', '09:50', 0, limited.createScheduleContext());
    expect(limited.timers['checkin:api-retry']).toBeDefined();

    mocks.updateDailyScheduleStatus.mockReset();
    const denied = newScheduler();
    executeWith(failure('PERMISSION_DENIED'));
    await denied.runActionAttempt('checkin', '09:50', 0, denied.createScheduleContext());
    expect(denied.timers['checkin:api-retry']).toBeUndefined();
    expect(statusCalls('failure')).toHaveLength(1);
    expect(denied.apiTransientRetries.size).toBe(0);
  });

  it('drops the punch-history anchor when a retry ends with a permanent error', async () => {
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'), failure('PERMISSION_DENIED'));

    await scheduler.runActionAttempt('checkout', '09:50', 0, scheduler.createScheduleContext());
    expect(scheduler.apiTransientRetries.size).toBe(1);
    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(statusCalls('failure')).toHaveLength(1);
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('counts API retries separately from OAuth retries', async () => {
    const scheduler = newScheduler();
    executeWith(
      { ...failure('AUTH_TRANSIENT', 'authorization') },
      failure('API_TRANSIENT'),
      success,
    );

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());
    await advance(scheduler, 30_000);
    expect(mocks.executeAction).toHaveBeenCalledTimes(2);

    // The first API retry waits one minute even though this is the third attempt.
    await advance(scheduler, RETRY_DELAYS_MS[0]);
    expect(mocks.executeAction).toHaveBeenCalledTimes(3);
  });

  it('keeps the OAuth retry budget after several API retries', async () => {
    const scheduler = newScheduler();
    executeWith(
      failure('API_TRANSIENT'),
      failure('API_TRANSIENT'),
      failure('API_TRANSIENT'),
      failure('API_TRANSIENT'),
      { ...failure('AUTH_TRANSIENT', 'authorization') },
      success,
    );

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());
    for (const delay of RETRY_DELAYS_MS.slice(0, 3)) await advance(scheduler, delay);
    expect(mocks.executeAction).toHaveBeenCalledTimes(4);
    await advance(scheduler, RETRY_DELAYS_MS[3]);
    expect(scheduler.timers['checkin:retry']).toBeDefined();
    await advance(scheduler, 30_000);

    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkin', 'success', null, mocks.identityKey,
    );
  });

  it('measures the deadline against the next action that is still planned', async () => {
    const scheduler = newScheduler();
    scheduler.todaySchedule = { checkin: '09:50', break_start: '09:51', checkout: '18:00' };
    scheduler.skippedActions.add('break_start');
    mocks.msUntil.set('09:51', 30_000);
    executeWith(failure('API_TRANSIENT'));

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());

    expect(scheduler.timers['checkin:api-retry']).toBeDefined();
  });

  it('keeps the anchor when a run from a replaced schedule fails', async () => {
    const scheduler = newScheduler();
    // The stale-generation failure now asks for a reconciliation pass; its
    // async re-initialisation is covered by the overlap test below.
    vi.spyOn(scheduler, 'requestCancellationReconciliation').mockImplementation(() => {});
    executeWith(failure('API_TRANSIENT'));

    await scheduler.runActionAttempt('checkout', '09:50', 0, scheduler.createScheduleContext());
    expect(scheduler.apiTransientRetries.size).toBe(1);

    // A settings save replaces the schedule while the retried request is in flight.
    mocks.executeAction.mockImplementationOnce(async () => {
      scheduler.lifecycleGeneration += 1;
      return failure('API_TRANSIENT');
    });
    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(scheduler.apiTransientRetries.size).toBe(1);
  });

  it('records the anchor when the first failure overlaps a generation change', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    const reconcile = vi.spyOn(scheduler, 'requestCancellationReconciliation').mockImplementation(() => {});
    const firstAttemptAt = Date.now();
    mocks.executeAction.mockImplementation(async () => {
      // A settings save calls stopAll() while the first request is in flight.
      scheduler.lifecycleGeneration += 1;
      return failure('API_TRANSIENT');
    });

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());

    expect(scheduler.apiTransientRetries.size).toBe(1);
    const anchor = scheduler.apiTransientRetries.get(
      scheduler.apiTransientRetryKey('2026-07-11', 'checkin', mocks.identityKey),
    );
    expect(anchor.firstAttemptAt).toBe(firstAttemptAt);
    expect(anchor.retries).toBe(0);
    expect(statusCalls('retrying')).toHaveLength(1);
    expect(scheduler.timers['checkin:api-retry']).toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // The schedule that replaced the failed generation picks the unresolved
    // retry back up.
    mocks.configs = [{ action_type: 'checkin', enabled: 1, mode: 'fixed', fixed_time: '09:40' }];
    mocks.msUntil.set('09:40', -10 * 60_000);
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({ execute: ['checkin'], skip: [], immediateActions: [] });
    executeWith(success);
    mocks.executeAction.mockClear();
    // The first request actually landed in freee while it looked unavailable.
    mocks.getTodayTimeClocks.mockResolvedValue([
      { type: 'checkin', time: '09:50', datetime: '2026-07-11T09:50:05+09:00' },
    ]);

    await scheduler.resolveAndScheduleToday();
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();
    await advance(scheduler, 0);

    // The retry carries the anchor, so it reads the punch history instead of
    // sending the same check-in again.
    expect(sent).toBe(0);
    expect(mocks.insertLog).toHaveBeenLastCalledWith(expect.objectContaining({
      action_type: 'checkin',
      status: 'success',
      error_message: 'Confirmed in freee punch history after a temporary freee API failure.',
    }));
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkin', 'success', null, mocks.identityKey,
    );
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('keeps no anchor and no reconciliation when the date changed mid-flight', async () => {
    const scheduler = newScheduler();
    const reconcile = vi.spyOn(scheduler, 'requestCancellationReconciliation').mockImplementation(() => {});
    mocks.executeAction.mockImplementation(async () => {
      mocks.todayDate = '2026-07-12';
      return failure('API_TRANSIENT');
    });

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());

    expect(scheduler.apiTransientRetries.size).toBe(0);
    expect(scheduler.timers['checkin:api-retry']).toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
    expect(statusCalls('transient_failure')).toHaveLength(0);
  });

  it('keeps no anchor and no reconciliation when the identity changed mid-flight', () => {
    const scheduler = newScheduler();
    const reconcile = vi.spyOn(scheduler, 'requestCancellationReconciliation').mockImplementation(() => {});
    const staleContext = scheduler.createScheduleContext(
      '2026-07-11',
      'v1:old-identity',
      scheduler.lifecycleGeneration,
    );

    const scheduled = scheduler.scheduleApiTransientRetry(
      'checkin', '09:50', 0, 'down', staleContext, Date.now(),
    );

    expect(scheduled).toBe(true);
    expect(scheduler.apiTransientRetries.size).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('checks punch history before a manual punch while a retry is pending', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    executeWith(success);

    await scheduler.triggerManual('checkout');
    // Without an anchor the closure passes the manual punch through untouched.
    expect(typeof optionsOfCall(0).recordedPunchCheck).toBe('function');
    expect(mocks.getTodayTimeClocks).not.toHaveBeenCalled();

    scheduler.apiTransientRetries.set(
      scheduler.apiTransientRetryKey('2026-07-11', 'checkout', mocks.identityKey),
      { date: '2026-07-11', identityKey: mocks.identityKey, actionType: 'checkout', firstAttemptAt: Date.now(), retries: 1 },
    );
    mocks.getTodayTimeClocks.mockResolvedValue([
      { type: 'checkout', time: '09:50', datetime: '2026-07-11T09:50:05+09:00' },
    ]);
    await expect(scheduler.triggerManual('checkout')).resolves.toMatchObject({
      status: 'success',
      confirmedFromHistory: true,
    });
    expect(sent).toBe(1);
  });

  it('honours an anchor that appears while a manual punch waits for the automation lock', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    let markQueued;
    const queuedOnLock = new Promise((resolve) => { markQueued = resolve; });
    let releaseLock;
    const lockHeld = new Promise((resolve) => { releaseLock = resolve; });
    mocks.executeAction.mockImplementation(async (_actionType, options = {}) => {
      // The manual punch queues behind a scheduled attempt that holds the lock.
      markQueued();
      await lockHeld;
      // That attempt fails with an unconfirmed response while the manual call
      // is still queued, registering the punch-history anchor only now.
      scheduler.apiTransientRetries.set(
        scheduler.apiTransientRetryKey('2026-07-11', 'checkout', mocks.identityKey),
        { date: '2026-07-11', identityKey: mocks.identityKey, actionType: 'checkout', firstAttemptAt: Date.now(), retries: 1 },
      );
      mocks.getTodayTimeClocks.mockResolvedValue([
        { type: 'checkout', time: '09:50', datetime: '2026-07-11T09:50:05+09:00' },
      ]);
      const recorded = await options.recordedPunchCheck();
      if (recorded === 'recorded') {
        return {
          ...success,
          error: 'Confirmed in freee punch history after a temporary freee API failure.',
          confirmedFromHistory: true,
        };
      }
      sent += 1;
      return success;
    });

    const manual = scheduler.triggerManual('checkout');
    await queuedOnLock;
    releaseLock();

    await expect(manual).resolves.toMatchObject({
      status: 'success',
      confirmedFromHistory: true,
    });
    expect(mocks.getTodayTimeClocks).toHaveBeenCalledTimes(1);
    expect(sent).toBe(0);
  });

  it('does not retry a check-in past the next scheduled action', async () => {
    const scheduler = newScheduler();
    scheduler.todaySchedule = { checkin: '09:50', break_start: '09:51', checkout: '18:00' };
    mocks.msUntil.set('09:51', 30_000);
    executeWith(failure('API_TRANSIENT'));

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());

    expect(scheduler.timers['checkin:api-retry']).toBeUndefined();
    const final = statusCalls('transient_failure');
    expect(final).toHaveLength(1);
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('gives up before sending when the next action came due while the retry waited', async () => {
    const scheduler = newScheduler();
    scheduler.todaySchedule = { checkin: '09:50', break_start: '09:51', checkout: '18:00' };
    // Enough room to arm the first retry (60s), but the break starts while it waits.
    mocks.msUntil.set('09:51', 120_000);
    executeWith(failure('API_TRANSIENT'), success);

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();

    mocks.msUntil.set('09:51', -1_000);
    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    const final = statusCalls('transient_failure');
    expect(final).toHaveLength(1);
    expect(final[0][1]).toBe('checkin');
    expect(final[0][3]).toContain('next scheduled action is already due');
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('retries the non-working-day check instead of pausing the whole day', async () => {
    const scheduler = newScheduler();
    const laterTimer = setTimeout(() => {}, 10 * 60 * 60 * 1000);
    scheduler.replaceTimer('checkout', laterTimer);
    mocks.getWorkRecord
      .mockRejectedValueOnce(Object.assign(new Error('503'), { code: 'API_TRANSIENT' }))
      .mockResolvedValue({ date: '2026-07-11' });
    executeWith(success);

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());

    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(scheduler.timers.checkout).toBe(laterTimer);
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();
    expect(statusCalls('guard_unavailable')).toHaveLength(0);

    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(sent).toBe(1);
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkin', 'success', null, mocks.identityKey,
    );
  });

  it('pauses the day as before when the non-working-day check never recovers', async () => {
    const scheduler = newScheduler();
    mocks.getWorkRecord.mockRejectedValue(Object.assign(new Error('503'), { code: 'API_TRANSIENT' }));

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());
    for (const delay of RETRY_DELAYS_MS) await advance(scheduler, delay);

    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(statusCalls('guard_unavailable')).toHaveLength(1);
    expect(scheduler.apiTransientRetries.size).toBe(0);
    expect(Object.keys(scheduler.timers)).toHaveLength(0);
  });

  it('settles a pending retry when a plan refresh shows the action is done', async () => {
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'));

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();

    // For example, the user punched in manually while freee recovered.
    mocks.determineActionsForToday.mockReturnValue({ execute: [], skip: ['checkin'], immediateActions: [] });
    await scheduler.refreshPlanForCurrentState('manual checkin');

    expect(scheduler.timers['checkin:api-retry']).toBeUndefined();
    expect(scheduler.apiTransientRetries.size).toBe(0);
    expect(statusCalls('skipped').at(-1)).toEqual([
      '2026-07-11', 'checkin', 'skipped', 'No longer needed after manual checkin.', false, mocks.identityKey,
    ]);

    await advance(scheduler, RETRY_DELAYS_MS[0]);
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
  });

  it('does not run a retry whose action was settled before the timer fired', async () => {
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'));

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());
    scheduler.skippedActions.add('checkin');
    await advance(scheduler, RETRY_DELAYS_MS[0]);

    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('starts a re-opened check-out without the earlier punch-history anchor', () => {
    const scheduler = newScheduler();
    scheduler.todaySchedule = { checkout: '18:00' };
    scheduler.terminalActions.add('checkout');
    scheduler.apiTransientRetries.set(
      scheduler.apiTransientRetryKey('2026-07-11', 'checkout', mocks.identityKey),
      { date: '2026-07-11', identityKey: mocks.identityKey, actionType: 'checkout', firstAttemptAt: 0, retries: 1 },
    );

    scheduler.reconcileRepeatableTerminalActions('working', [
      { type: 'checkout', time: '18:00', datetime: '2026-07-11T18:00:00+09:00' },
      { type: 'checkin', time: '18:30', datetime: '2026-07-11T18:30:00+09:00' },
    ], '2026-07-11');

    expect(scheduler.terminalActions.has('checkout')).toBe(false);
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('runs a pending retry again when the day is rescheduled', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    mocks.configs = [{ action_type: 'checkout', enabled: 1, mode: 'fixed', fixed_time: '09:45' }];
    mocks.msUntil.set('09:45', -5 * 60_000);
    mocks.determineActionsForToday.mockReturnValue({ execute: ['checkout'], skip: [], immediateActions: [] });
    executeWith(failure('API_TRANSIENT'), success);

    await scheduler.runActionAttempt('checkout', '09:45', 0, scheduler.createScheduleContext());
    expect(scheduler.timers['checkout:api-retry']).toBeDefined();

    // Saving settings re-resolves the day and clears every timer; the retry
    // is re-armed instead of running inline.
    await scheduler.resolveAndScheduleToday();
    expect(scheduler.timers['checkout:api-retry']).toBeDefined();
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);

    await advance(scheduler, 0);

    expect(mocks.executeAction).toHaveBeenCalledTimes(2);
    expect(typeof optionsOfCall(1).recordedPunchCheck).toBe('function');
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkout', 'success', null, mocks.identityKey,
    );
  });

  it('resumes a pending check-in on rescheduling even when the plan would skip it as late', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    mocks.configs = [{ action_type: 'checkin', enabled: 1, mode: 'fixed', fixed_time: '09:40' }];
    mocks.msUntil.set('09:40', -10 * 60_000);
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    // More than five minutes late: the state-derived plan skips the check-in.
    mocks.determineActionsForToday.mockReturnValue({ execute: [], skip: ['checkin'], immediateActions: [] });
    executeWith(failure('API_TRANSIENT'), success);

    await scheduler.runActionAttempt('checkin', '09:40', 0, scheduler.createScheduleContext());
    await scheduler.resolveAndScheduleToday();
    await advance(scheduler, 0);

    expect(mocks.executeAction).toHaveBeenCalledTimes(2);
    expect(typeof optionsOfCall(1).recordedPunchCheck).toBe('function');
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11', 'checkin', 'success', null, mocks.identityKey,
    );
  });

  it('re-arms a pending retry without running it inline during rescheduling', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    mocks.configs = [
      { action_type: 'checkin', enabled: 1, mode: 'fixed', fixed_time: '09:40' },
      { action_type: 'checkout', enabled: 1, mode: 'fixed', fixed_time: '09:55' },
    ];
    mocks.msUntil.set('09:40', -10 * 60_000);
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({ execute: ['checkin', 'checkout'], skip: [], immediateActions: [] });
    executeWith(failure('API_TRANSIENT'), success);

    // The retry is armed while the checkout is still comfortably away.
    await scheduler.runActionAttempt('checkin', '09:40', 0, scheduler.createScheduleContext());
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();

    // A settings save re-resolves the day when only a few seconds remain
    // before the checkout. The retry must not run inside the scheduling loop,
    // or the checkout would pass its time behind the account lock and be
    // dropped as "already passed".
    mocks.msUntil.set('09:55', 5_000);
    mocks.executeAction.mockClear();
    await scheduler.resolveAndScheduleToday();

    expect(scheduler.timers.checkout).toBeDefined();
    expect(scheduler.timers['checkin:api-retry']).toBeDefined();
    expect(mocks.executeAction).not.toHaveBeenCalled();

    await advance(scheduler, 0);

    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
  });

  it('does not send a re-armed check-in after the check-out it raced has run', async () => {
    const scheduler = newScheduler();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    mocks.configs = [
      { action_type: 'checkin', enabled: 1, mode: 'fixed', fixed_time: '09:40' },
      { action_type: 'checkout', enabled: 1, mode: 'fixed', fixed_time: '09:55' },
    ];
    mocks.msUntil.set('09:40', -10 * 60_000);
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({ execute: ['checkin', 'checkout'], skip: [], immediateActions: [] });
    executeWith(failure('API_TRANSIENT'));
    await scheduler.runActionAttempt('checkin', '09:40', 0, scheduler.createScheduleContext());

    // A settings save re-arms the check-in retry five seconds before check-out.
    mocks.msUntil.set('09:55', 5_000);
    await scheduler.resolveAndScheduleToday();
    mocks.executeAction.mockReset().mockImplementation(async (actionType) => (actionType === 'checkout'
      ? { status: 'skipped', error: 'Not checked in', detectedState: 'not_checked_in', screenshotBefore: null, screenshotAfter: null, durationMs: 5 }
      : success));

    // The retried check-in waits on a slow non-working-day check meanwhile.
    let releaseGuard;
    mocks.getWorkRecord.mockImplementationOnce(() => new Promise((resolve) => {
      releaseGuard = () => resolve({ date: '2026-07-11' });
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseGuard).toBeTypeOf('function');

    // Check-out comes due first and is skipped for good because nobody is checked in.
    mocks.msUntil.set('09:55', -1);
    await vi.advanceTimersByTimeAsync(5_000);
    const checkoutRun = [...scheduler.inFlightRunMetadata]
      .find(([, metadata]) => metadata?.actionType === 'checkout')?.[0];
    await checkoutRun;
    expect(mocks.executeAction).toHaveBeenCalledWith('checkout', expect.anything());
    expect(scheduler.terminalActions.has('checkout')).toBe(true);

    releaseGuard();
    await advance(scheduler, 0);

    expect(mocks.executeAction).not.toHaveBeenCalledWith('checkin', expect.anything());
    expect(statusCalls('transient_failure').at(-1)[1]).toBe('checkin');
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('ends a retry once a later action has run, whatever its scheduled time', () => {
    const scheduler = newScheduler();
    scheduler.todaySchedule = { checkin: '09:50', checkout: '18:00' };
    expect(scheduler.msUntilNextScheduledAction('checkin')).toBeGreaterThan(0);

    scheduler.terminalActions.add('checkout');
    scheduler.skippedActions.add('checkout');
    expect(scheduler.msUntilNextScheduledAction('checkin')).toBe(0);
  });

  it('ignores a later action that only the configuration pauses', () => {
    const scheduler = newScheduler();
    scheduler.todaySchedule = { checkin: '09:50', break_start: '09:51', checkout: '18:00' };
    mocks.msUntil.set('09:51', -60_000);
    for (const set of [scheduler.terminalActions, scheduler.skippedActions, scheduler.configurationPausedActions]) {
      set.add('break_start');
    }

    expect(scheduler.msUntilNextScheduledAction('checkin')).toBe(10 * 60 * 60 * 1000);
  });

  it('records a final status instead of resuming when the next action is already due', async () => {
    const scheduler = newScheduler();
    mocks.configs = [
      { action_type: 'checkin', enabled: 1, mode: 'fixed', fixed_time: '09:40' },
      { action_type: 'checkout', enabled: 1, mode: 'fixed', fixed_time: '09:45' },
    ];
    mocks.msUntil.set('09:40', -10 * 60_000);
    mocks.msUntil.set('09:45', -5 * 60_000);
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({ execute: ['checkout'], skip: [], immediateActions: [] });
    executeWith(failure('API_TRANSIENT'));
    scheduler.todaySchedule = { checkin: '09:40', checkout: '18:00' };

    await scheduler.runActionAttempt('checkin', '09:40', 0, scheduler.createScheduleContext());
    expect(scheduler.apiTransientRetries.size).toBe(1);
    mocks.executeAction.mockClear();

    await scheduler.resolveAndScheduleToday();

    // Neither the retry nor the check-in startup grace runs.
    expect(mocks.executeAction).not.toHaveBeenCalledWith('checkin', expect.anything());
    expect(statusCalls('transient_failure').at(-1)[1]).toBe('checkin');
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('keeps a plan-skipped action skipped when the next action is already due', async () => {
    const scheduler = newScheduler();
    mocks.configs = [
      { action_type: 'checkin', enabled: 1, mode: 'fixed', fixed_time: '09:40' },
      { action_type: 'checkout', enabled: 1, mode: 'fixed', fixed_time: '09:45' },
    ];
    mocks.msUntil.set('09:40', -10 * 60_000);
    mocks.msUntil.set('09:45', -5 * 60_000);
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    // More than five minutes late: the state-derived plan skips the check-in.
    mocks.determineActionsForToday.mockReturnValue({ execute: ['checkout'], skip: ['checkin'], immediateActions: [] });
    executeWith(failure('API_TRANSIENT'));
    scheduler.todaySchedule = { checkin: '09:40', checkout: '18:00' };

    await scheduler.runActionAttempt('checkin', '09:40', 0, scheduler.createScheduleContext());
    expect(scheduler.apiTransientRetries.size).toBe(1);
    mocks.executeAction.mockClear();

    await scheduler.resolveAndScheduleToday();

    // Neither the retry nor the check-in startup grace runs; the plan's skip
    // outlives the unresolved retry instead of becoming a failure.
    expect(mocks.executeAction).not.toHaveBeenCalled();
    const final = statusCalls('skipped').at(-1);
    expect(final.slice(0, 3)).toEqual(['2026-07-11', 'checkin', 'skipped']);
    expect(final[3]).toContain('next scheduled action is already due');
    expect(scheduler.skippedActions.has('checkin')).toBe(true);
    expect(scheduler.apiTransientRetries.size).toBe(0);
  });

  it('skips a past action on rescheduling when no retry is pending', async () => {
    const scheduler = newScheduler();
    mocks.configs = [{ action_type: 'checkout', enabled: 1, mode: 'fixed', fixed_time: '09:45' }];
    mocks.msUntil.set('09:45', -5 * 60_000);
    mocks.determineActionsForToday.mockReturnValue({ execute: ['checkout'], skip: [], immediateActions: [] });
    executeWith(success);

    await scheduler.resolveAndScheduleToday();

    expect(mocks.executeAction).not.toHaveBeenCalled();
  });

  it('keeps the existing failure handling for browser mode', async () => {
    mocks.connectionMode = 'browser';
    const scheduler = newScheduler();
    executeWith(failure('API_TRANSIENT'));

    await scheduler.runActionAttempt('checkin', '09:50', 0, scheduler.createScheduleContext());

    expect(scheduler.timers['checkin:api-retry']).toBeUndefined();
    expect(statusCalls('failure')).toHaveLength(1);
  });
});
