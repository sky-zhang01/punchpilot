import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cronJobs: [],
  identityKey: 'v1:synthetic-identity',
  executionLogIdentityKey: `log-v1:${'a'.repeat(64)}`,
  webIdentityVerified: true,
  connectionMode: 'api',
  settings: new Map(),
  configs: [],
  insertLog: vi.fn(),
  executeAction: vi.fn(),
  markDailyScheduleExecuted: vi.fn(),
  updateDailyScheduleStatus: vi.fn(),
  detectCurrentState: vi.fn(),
  determineActionsForToday: vi.fn(),
  detectWebNonWorkingStatus: vi.fn(),
  isHolidayOrWeekend: vi.fn(),
  msUntilTime: 60_000,
  todayDate: '2026-07-11',
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((expression, callback, options) => {
      const job = { expression, callback, options, stop: vi.fn() };
      mocks.cronJobs.push(job);
      return job;
    }),
  },
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
  currentExecutionLogIdentityKey: () => mocks.executionLogIdentityKey,
}));

vi.mock('../server/automation/index.js', () => ({
  executeAction: mocks.executeAction,
  detectCurrentState: mocks.detectCurrentState,
  detectWebNonWorkingStatus: mocks.detectWebNonWorkingStatus,
  determineActionsForToday: mocks.determineActionsForToday,
  hasApiCredentials: () => false,
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
  FreeeApiClient: class {},
}));

vi.mock('../server/automation/identity.js', () => ({
  currentAutomationIdentityKey: () => mocks.identityKey,
  isWebAccountVerified: () => mocks.webIdentityVerified,
}));

vi.mock('../server/holiday.js', () => ({
  isHolidayOrWeekend: mocks.isHolidayOrWeekend,
  getTodayString: () => mocks.todayDate,
}));

vi.mock('../server/timezone.js', () => ({
  msUntilTimeInTz: () => mocks.msUntilTime,
  getTimezone: () => 'Asia/Tokyo',
}));

vi.mock('../server/work-record-status.js', () => ({
  getWorkRecordNonWorkingDayStatus: vi.fn(),
  workRecordMatchesDate: vi.fn(),
}));

vi.mock('../server/logger.js', () => ({
  safeErrorMetadata: (error) => ({ code: error?.code || null }),
}));

const { Scheduler } = await import('../server/scheduler.js');
const {
  acquireAccountOperation,
  releaseAccountOperation,
} = await import('../server/account-operation.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function allowConfirmedBrowserScheduling() {
  mocks.connectionMode = 'browser';
  mocks.detectWebNonWorkingStatus.mockResolvedValue({
    confirmed: true,
    isNonWorkingDay: false,
    reason: null,
    code: null,
  });
}

beforeEach(() => {
  mocks.cronJobs.length = 0;
  mocks.identityKey = 'v1:synthetic-identity';
  mocks.executionLogIdentityKey = `log-v1:${'a'.repeat(64)}`;
  mocks.settings = new Map();
  mocks.configs = [];
  mocks.webIdentityVerified = true;
  mocks.connectionMode = 'api';
  mocks.msUntilTime = 60_000;
  mocks.todayDate = '2026-07-11';
  mocks.insertLog.mockReset();
  mocks.executeAction.mockReset();
  mocks.markDailyScheduleExecuted.mockReset();
  mocks.updateDailyScheduleStatus.mockReset();
  mocks.detectCurrentState.mockReset();
  mocks.determineActionsForToday.mockReset().mockReturnValue({
    execute: [],
    skip: [],
    immediateActions: [],
    reason: 'Synthetic schedule',
  });
  mocks.detectWebNonWorkingStatus.mockReset();
  mocks.isHolidayOrWeekend.mockReset().mockResolvedValue(false);
});

describe('scheduler lifecycle serialization', () => {
  it('binds the daily rollover cron to the configured application timezone', async () => {
    const scheduler = new Scheduler();
    vi.spyOn(scheduler, 'resolveAndScheduleToday').mockResolvedValue(undefined);

    await scheduler.initialize();

    expect(mocks.cronJobs[0]).toMatchObject({
      expression: '1 0 * * *',
      options: { timezone: 'Asia/Tokyo' },
    });
  });

  it('lets only the latest initialize generation remain active', async () => {
    const scheduler = new Scheduler();
    const firstResolution = deferred();
    const resolveToday = vi.spyOn(scheduler, 'resolveAndScheduleToday')
      .mockImplementationOnce(() => firstResolution.promise)
      .mockResolvedValueOnce(undefined);

    const firstInitialize = scheduler.initialize();
    await vi.waitFor(() => expect(mocks.cronJobs).toHaveLength(1));
    const firstJob = mocks.cronJobs[0];
    const secondInitialize = scheduler.initialize();

    expect(firstJob.stop).toHaveBeenCalledTimes(1);
    firstResolution.resolve();
    await expect(Promise.all([firstInitialize, secondInitialize])).resolves.toEqual([
      false,
      true,
    ]);

    expect(resolveToday).toHaveBeenCalledTimes(2);
    expect(mocks.cronJobs).toHaveLength(2);
    expect(scheduler.dailyCronJob).toBe(mocks.cronJobs[1]);
  });

  it('ignores a callback retained from an obsolete cron generation', async () => {
    const scheduler = new Scheduler();
    vi.spyOn(scheduler, 'resolveAndScheduleToday').mockResolvedValue(undefined);
    const dailyResolution = vi.spyOn(scheduler, 'runDailyResolution')
      .mockResolvedValue(undefined);

    await scheduler.initialize();
    const obsoleteCallback = mocks.cronJobs[0].callback;
    await scheduler.initialize();

    obsoleteCallback();
    await Promise.resolve();
    expect(dailyResolution).not.toHaveBeenCalled();

    mocks.cronJobs[1].callback();
    await vi.waitFor(() => expect(dailyResolution).toHaveBeenCalledTimes(1));
  });

  it('waits for an in-flight action before completing shutdown', async () => {
    const scheduler = new Scheduler();
    scheduler.activeIdentityKey = mocks.identityKey;
    const action = deferred();
    vi.spyOn(scheduler, 'runActionAttempt').mockReturnValue(action.promise);

    const running = scheduler.runAction('checkin', '09:50');
    let shutdownSettled = false;
    const shutdown = scheduler.shutdown(1_000).then((value) => {
      shutdownSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    action.resolve();
    await expect(running).resolves.toBeUndefined();
    await expect(shutdown).resolves.toBe(true);
  });

  it('keeps a manual action log bound to the initiating account', async () => {
    const scheduler = new Scheduler();
    const action = deferred();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    mocks.identityKey = 'v1:account-a';
    mocks.executionLogIdentityKey = `log-v1:${'a'.repeat(64)}`;
    mocks.settings.set('oauth_company_id', '101');
    mocks.settings.set('oauth_company_name', 'Account A');
    mocks.executeAction.mockReturnValue(action.promise);

    const running = scheduler.triggerManual('checkin');
    await vi.waitFor(() => expect(mocks.executeAction).toHaveBeenCalledTimes(1));

    mocks.identityKey = 'v1:account-b';
    mocks.executionLogIdentityKey = `log-v1:${'b'.repeat(64)}`;
    mocks.settings.set('oauth_company_id', '202');
    mocks.settings.set('oauth_company_name', 'Account B');
    action.resolve({
      status: 'success',
      screenshotBefore: null,
      screenshotAfter: '/screenshots/account-a-result.png',
      durationMs: 42,
      error: null,
    });

    await expect(running).resolves.toMatchObject({ status: 'success' });
    expect(mocks.executeAction).toHaveBeenCalledWith('checkin', {
      expectedIdentityKey: 'v1:account-a',
    });
    expect(mocks.insertLog).toHaveBeenCalledWith(expect.objectContaining({
      action_type: 'checkin',
      screenshot_after: '/screenshots/account-a-result.png',
      identity_key: `log-v1:${'a'.repeat(64)}`,
      company_id: '101',
      company_name: 'Account A',
    }));
  });

  it('persists bounded diagnostics for a manual action failure', async () => {
    const scheduler = new Scheduler();
    mocks.executeAction.mockResolvedValue({
      status: 'failure',
      error: 'web_credentials_invalid',
      errorCode: 'WEB_LOGIN_FAILED',
      failureStage: 'login',
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 41,
    });

    await expect(scheduler.triggerManual('checkin')).resolves.toMatchObject({
      status: 'failure',
    });
    expect(mocks.insertLog).toHaveBeenCalledWith(expect.objectContaining({
      action_type: 'checkin',
      error_code: 'WEB_LOGIN_FAILED',
      failure_stage: 'login',
    }));
  });

  it('stops runtime handles and rejects initialize after shutdown begins', async () => {
    const scheduler = new Scheduler();
    vi.spyOn(scheduler, 'resolveAndScheduleToday').mockResolvedValue(undefined);
    await scheduler.initialize();
    scheduler.timers.synthetic = setTimeout(() => {}, 60_000);

    await expect(scheduler.shutdown(1_000)).resolves.toBe(true);

    expect(mocks.cronJobs[0].stop).toHaveBeenCalledTimes(1);
    expect(scheduler.timers).toEqual({});
    await expect(scheduler.initialize()).rejects.toMatchObject({
      code: 'SCHEDULER_SHUTTING_DOWN',
    });
  });

  it('rejects a queued mutation after its scheduler generation is invalidated', () => {
    const scheduler = new Scheduler();
    scheduler.activeIdentityKey = mocks.identityKey;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{ action_type: 'checkin', enabled: 1 }];
    const generation = scheduler.lifecycleGeneration;
    const context = scheduler.createScheduleContext(
      mocks.todayDate,
      mocks.identityKey,
      generation,
    );

    scheduler.stopAll();

    expect(() => scheduler.assertScheduledMutationAuthorized(
      'checkin',
      context,
    )).toThrowError(expect.objectContaining({
      code: 'SCHEDULE_GENERATION_STALE',
    }));
  });

  it('rejects a mutation when its scheduled date is no longer current', () => {
    const scheduler = new Scheduler();
    scheduler.activeIdentityKey = mocks.identityKey;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{ action_type: 'checkin', enabled: 1 }];
    const context = scheduler.createScheduleContext();

    mocks.todayDate = '2026-07-12';

    expect(() => scheduler.assertScheduledMutationAuthorized(
      'checkin',
      context,
    )).toThrowError(expect.objectContaining({
      code: 'SCHEDULE_DATE_STALE',
    }));
  });

  it('does not execute or retry an old-date action after rollover', async () => {
    const scheduler = new Scheduler();
    scheduler.activeIdentityKey = mocks.identityKey;
    const reconcile = vi.spyOn(scheduler, 'requestCancellationReconciliation')
      .mockImplementation(() => {});
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{ action_type: 'checkin', enabled: 1 }];
    const context = scheduler.createScheduleContext();

    mocks.todayDate = '2026-07-12';
    await scheduler.runActionAttempt('checkin', '23:59', 0, context);

    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(mocks.updateDailyScheduleStatus).toHaveBeenCalledWith(
      '2026-07-11',
      'checkin',
      'date_changed',
      'Scheduled date changed before execution.',
      false,
      mocks.identityKey,
    );
    expect(scheduler.cancelledMutationRetries.size).toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('treats an in-flight action from a prior date as a prior scheduler run', () => {
    const scheduler = new Scheduler();
    const tracked = Promise.resolve();
    scheduler.inFlightRunMetadata.set(tracked, {
      kind: 'scheduled_action',
      actionType: 'checkin',
      generation: scheduler.lifecycleGeneration,
      date: '2026-07-11',
    });

    const currentContext = scheduler.createScheduleContext(
      '2026-07-12',
      mocks.identityKey,
      scheduler.lifecycleGeneration,
    );
    expect(scheduler.hasPriorScheduledActionRun(currentContext)).toBe(true);
  });

  it('cancels at the final authorization gate when the date rolls during execution', async () => {
    const scheduler = new Scheduler();
    scheduler.activeIdentityKey = mocks.identityKey;
    const reconcile = vi.spyOn(scheduler, 'requestCancellationReconciliation')
      .mockImplementation(() => {});
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{ action_type: 'checkin', enabled: 1 }];
    const context = scheduler.createScheduleContext();
    mocks.executeAction.mockImplementation(async (
      _actionType,
      { expectedDate, mutationAuthorizationGuard },
    ) => {
      expect(expectedDate).toBe('2026-07-11');
      mocks.todayDate = '2026-07-12';
      try {
        mutationAuthorizationGuard();
        throw new Error('expected the stale-date guard to reject');
      } catch (error) {
        return {
          status: 'skipped',
          error: 'scheduled_action_cancelled',
          errorCode: error.code,
          screenshotBefore: null,
          screenshotAfter: null,
          durationMs: 10,
        };
      }
    });

    await scheduler.runActionAttempt('checkin', '23:59', 0, context);

    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    expect(mocks.updateDailyScheduleStatus).toHaveBeenCalledWith(
      '2026-07-11',
      'checkin',
      'date_changed',
      'Scheduled date changed before execution.',
      false,
      mocks.identityKey,
    );
    expect(mocks.markDailyScheduleExecuted).not.toHaveBeenCalled();
    expect(scheduler.cancelledMutationRetries.size).toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('runs a just-past checkin retained by the startup grace plan', async () => {
    const scheduler = new Scheduler();
    allowConfirmedBrowserScheduling();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    mocks.msUntilTime = -1_000;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{
      action_type: 'checkin',
      enabled: 1,
      mode: 'fixed',
      fixed_time: '09:50',
      window_start: '09:40',
      window_end: '10:00',
    }];
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkin'],
      skip: [],
      immediateActions: [],
      reason: 'Check-in remains inside the startup grace window',
    });
    mocks.executeAction.mockResolvedValue({
      status: 'success',
      error: null,
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 30,
    });

    await scheduler.resolveAndScheduleToday();

    expect(mocks.executeAction).toHaveBeenCalledWith(
      'checkin',
      expect.objectContaining({ expectedIdentityKey: mocks.identityKey }),
    );
    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11',
      'checkin',
      'success',
      null,
      mocks.identityKey,
    );
  });

  it('pauses at resolution time when the holiday guard cannot be verified', async () => {
    const scheduler = new Scheduler();
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{
      action_type: 'checkin',
      enabled: 1,
      mode: 'fixed',
      fixed_time: '09:50',
      window_start: '09:40',
      window_end: '10:00',
    }];
    const error = new Error('holiday source unavailable');
    error.code = 'HOLIDAY_DATA_UNAVAILABLE';
    mocks.isHolidayOrWeekend.mockRejectedValueOnce(error);

    await scheduler.resolveAndScheduleToday();

    expect(mocks.detectCurrentState).not.toHaveBeenCalled();
    expect(mocks.updateDailyScheduleStatus).toHaveBeenCalledWith(
      '2026-07-11',
      'checkin',
      'guard_unavailable',
      expect.stringContaining('holiday guard could not be verified'),
      false,
      mocks.identityKey,
    );
    expect(mocks.insertLog).toHaveBeenCalledWith(expect.objectContaining({
      error_code: 'HOLIDAY_DATA_UNAVAILABLE',
      failure_stage: 'calendar_guard',
    }));
    expect(scheduler.getStartupAnalysis()).toMatchObject({
      state: 'guard_unavailable',
      execute: [],
      guardUnavailable: true,
    });
  });

  it('keeps a cancelled pre-dispatch action eligible for rescheduling', async () => {
    const scheduler = new Scheduler();
    vi.spyOn(scheduler, 'requestCancellationReconciliation')
      .mockImplementation(() => {});
    scheduler.activeIdentityKey = mocks.identityKey;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{ action_type: 'checkin', enabled: 1 }];
    mocks.executeAction.mockResolvedValueOnce({
      status: 'skipped',
      error: 'scheduled_action_cancelled',
      errorCode: 'SCHEDULE_GENERATION_STALE',
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 25,
    });

    await scheduler.runActionAttempt(
      'checkin',
      '09:50',
      0,
      scheduler.createScheduleContext(),
    );

    expect(mocks.markDailyScheduleExecuted).not.toHaveBeenCalled();
    expect(mocks.updateDailyScheduleStatus).toHaveBeenCalledWith(
      '2026-07-11',
      'checkin',
      'cancelled',
      'scheduled_action_cancelled',
      false,
      mocks.identityKey,
    );
    expect(scheduler.terminalActions.has('checkin')).toBe(false);
    expect(scheduler.skippedActions.has('checkin')).toBe(false);
  });

  it('retries a cancelled due action after persisting the retry intent', async () => {
    const scheduler = new Scheduler();
    allowConfirmedBrowserScheduling();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    scheduler.activeIdentityKey = mocks.identityKey;
    mocks.msUntilTime = -1_000;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{
      action_type: 'checkin',
      enabled: 1,
      mode: 'fixed',
      fixed_time: '09:50',
      window_start: '09:40',
      window_end: '10:00',
    }];
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkin'],
      skip: [],
      immediateActions: [],
      reason: 'Check-in remains due',
    });
    mocks.executeAction
      .mockResolvedValueOnce({
        status: 'skipped',
        error: 'scheduled_action_cancelled',
        errorCode: 'SCHEDULE_GENERATION_STALE',
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: 25,
      })
      .mockResolvedValueOnce({
        status: 'success',
        error: null,
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: 30,
      });

    await scheduler.runActionAttempt(
      'checkin',
      '09:50',
      0,
      scheduler.createScheduleContext(),
    );
    await vi.waitFor(() => expect(mocks.executeAction).toHaveBeenCalledTimes(2));
    await scheduler.initializationTail;

    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledWith(
      '2026-07-11',
      'checkin',
      'success',
      null,
      mocks.identityKey,
    );
    expect(scheduler.cancelledMutationRetries.size).toBe(0);
  });

  it('waits for the real account-operation queue before reconciling', async () => {
    const scheduler = new Scheduler();
    allowConfirmedBrowserScheduling();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    scheduler.activeIdentityKey = mocks.identityKey;
    mocks.msUntilTime = -1_000;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{
      action_type: 'checkin',
      enabled: 1,
      mode: 'fixed',
      fixed_time: '09:50',
      window_start: '09:40',
      window_end: '10:00',
    }];
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkin'],
      skip: [],
      immediateActions: [],
      reason: 'Check-in remains due',
    });
    mocks.executeAction
      .mockResolvedValueOnce({
        status: 'skipped',
        error: 'scheduled_action_cancelled',
        errorCode: 'SCHEDULE_GENERATION_STALE',
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: 25,
      })
      .mockResolvedValueOnce({
        status: 'success',
        error: null,
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: 30,
      });

    await acquireAccountOperation();
    try {
      await scheduler.runActionAttempt(
        'checkin',
        '09:50',
        0,
        scheduler.createScheduleContext(),
      );
      await Promise.resolve();
      expect(mocks.executeAction).toHaveBeenCalledTimes(1);
      expect(scheduler.cancelledMutationRetries.size).toBe(1);
    } finally {
      releaseAccountOperation();
    }

    await vi.waitFor(() => expect(mocks.executeAction).toHaveBeenCalledTimes(2));
    await scheduler.initializationTail;
    expect(scheduler.cancelledMutationRetries.size).toBe(0);
  });

  it('reconciles when initialization finishes before cancellation is persisted', async () => {
    const scheduler = new Scheduler();
    allowConfirmedBrowserScheduling();
    vi.spyOn(scheduler, 'refreshPlanForCurrentState').mockResolvedValue(undefined);
    scheduler.activeIdentityKey = mocks.identityKey;
    const firstAction = deferred();
    mocks.msUntilTime = -1_000;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{
      action_type: 'checkin',
      enabled: 1,
      mode: 'fixed',
      fixed_time: '09:50',
      window_start: '09:40',
      window_end: '10:00',
    }];
    mocks.detectCurrentState.mockResolvedValue('not_checked_in');
    mocks.determineActionsForToday.mockReturnValue({
      execute: ['checkin'],
      skip: [],
      immediateActions: [],
      reason: 'Check-in remains due',
    });
    mocks.executeAction
      .mockReturnValueOnce(firstAction.promise)
      .mockResolvedValueOnce({
        status: 'success',
        error: null,
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: 30,
      });
    const oldGeneration = scheduler.lifecycleGeneration;
    const oldContext = scheduler.createScheduleContext(
      mocks.todayDate,
      mocks.identityKey,
      oldGeneration,
    );
    const oldRun = scheduler.runAction(
      'checkin',
      '09:50',
      oldContext,
    );
    await vi.waitFor(() => expect(mocks.executeAction).toHaveBeenCalledTimes(1));

    await scheduler.initialize();
    expect(mocks.executeAction).toHaveBeenCalledTimes(1);
    firstAction.resolve({
      status: 'skipped',
      error: 'scheduled_action_cancelled',
      errorCode: 'SCHEDULE_GENERATION_STALE',
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 25,
    });
    await oldRun;
    await vi.waitFor(() => expect(mocks.executeAction).toHaveBeenCalledTimes(2));
    await scheduler.initializationTail;

    expect(mocks.markDailyScheduleExecuted).toHaveBeenCalledTimes(1);
    expect(scheduler.cancelledMutationRetries.size).toBe(0);
  });

  it('deduplicates and prunes cancellation retry intents by day and identity', () => {
    const scheduler = new Scheduler();
    scheduler.rememberCancelledMutationRetry(
      '2026-07-11',
      'checkin',
      'v1:account-a',
    );
    scheduler.rememberCancelledMutationRetry(
      '2026-07-11',
      'checkin',
      'v1:account-a',
    );
    scheduler.rememberCancelledMutationRetry(
      '2026-07-10',
      'checkin',
      'v1:account-a',
    );
    scheduler.rememberCancelledMutationRetry(
      '2026-07-11',
      'checkout',
      'v1:account-b',
    );

    expect(scheduler.cancelledMutationRetries.size).toBe(3);
    scheduler.pruneCancelledMutationRetries(
      '2026-07-11',
      'v1:account-a',
      new Set(['checkin']),
    );
    expect(scheduler.cancelledMutationRetries.size).toBe(1);
    expect(scheduler.consumeCancelledMutationRetry(
      '2026-07-11',
      'checkin',
      'v1:account-a',
    )).toBe(true);
    expect(scheduler.consumeCancelledMutationRetry(
      '2026-07-11',
      'checkin',
      'v1:account-a',
    )).toBe(false);
  });

  it('pauses browser schedules before state detection when employee identity is unverified', async () => {
    const scheduler = new Scheduler();
    mocks.connectionMode = 'browser';
    mocks.webIdentityVerified = false;
    mocks.settings.set('auto_checkin_enabled', '1');
    mocks.configs = [{
      action_type: 'checkin',
      enabled: 1,
      mode: 'fixed',
      fixed_time: '09:50',
      window_start: '09:40',
      window_end: '10:00',
    }];

    await scheduler.resolveAndScheduleToday();

    expect(mocks.detectCurrentState).not.toHaveBeenCalled();
    expect(mocks.detectWebNonWorkingStatus).not.toHaveBeenCalled();
    expect(mocks.updateDailyScheduleStatus).toHaveBeenCalledWith(
      '2026-07-11',
      'checkin',
      'identity_unverified',
      expect.stringContaining('employee identity is verified'),
      false,
      mocks.identityKey,
    );
    expect(mocks.insertLog).toHaveBeenCalledWith(expect.objectContaining({
      action_type: 'daily_resolution',
      status: 'skipped',
      error_code: 'WEB_EMPLOYEE_BINDING_REQUIRED',
      failure_stage: 'identity_binding',
    }));
    expect(scheduler.getStartupAnalysis()).toMatchObject({
      state: 'identity_unverified',
      execute: [],
      guardUnavailable: true,
    });
  });

  it('rechecks a reversible non-working-day decision before check-in', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new Scheduler();
      scheduler.activeIdentityKey = mocks.identityKey;
      scheduler.todaySchedule = { checkin: '09:50' };
      mocks.msUntilTime = 5 * 60_000;
      const resolution = vi.spyOn(scheduler, 'resolveAndScheduleToday')
        .mockResolvedValue(undefined);

      scheduler.skipTodayForNonWorkingDay('2026-07-11', {
        reason: 'Approved leave',
        code: 'paid_holiday_full',
      });

      expect(scheduler.timers._nonWorkingRecheck).toBeDefined();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(resolution).toHaveBeenCalledWith(scheduler.lifecycleGeneration);
    } finally {
      vi.useRealTimers();
    }
  });
});
