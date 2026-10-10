import cron from 'node-cron';
import { timeToMinutes, minutesToTime } from '../shared/date-time.js';
import { resolveBreakTimes } from '../shared/schedule-policy.js';
import {
  getAllConfig,
  getSetting,
  insertLog,
  getDailySchedule,
  setDailySchedule,
  markDailyScheduleExecuted,
  updateDailyScheduleStatus,
  cleanOldSchedules,
  cleanExpiredLeaveStrategyCache,
  cleanOldAsyncTasks,
  currentExecutionLogIdentityKey,
} from './db.js';
import { executeAction, detectCurrentState, detectWebNonWorkingStatus, determineActionsForToday, hasApiCredentials, isDebugMode, FREEE_STATE, getConnectionMode } from './automation/index.js';
import { FreeeApiClient, FREEE_AUTH_ERROR_CODES, isOAuthAuthBroken } from './freee-api.js';
import {
  currentAutomationIdentityKey,
  isWebAccountVerified,
} from './automation/identity.js';
import { isHolidayOrWeekend, getTodayString } from './holiday.js';
import { msUntilTimeInTz, getTimezone } from './timezone.js';
import {
  getWorkRecordNonWorkingDayStatus,
  workRecordMatchesDate,
} from './work-record-status.js';
import { safeErrorMetadata } from './logger.js';
import { withAccountOperation } from './account-operation.js';
import { normalizeAutomationErrorCode } from './automation-diagnostics.js';

const AUTH_TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
const STATE_RETRY_DELAYS_MS = [60_000, 180_000, 300_000];
const NON_WORKING_RECHECK_BUFFER_MS = 60_000;
const SCHEDULE_CANCELLATION_CODES = new Set([
  'SCHEDULE_GENERATION_STALE',
  'SCHEDULE_DATE_STALE',
  'SCHEDULE_IDENTITY_CHANGED',
  'SCHEDULE_MASTER_DISABLED',
  'SCHEDULE_ACTION_DISABLED',
]);

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomTimeBetween(start, end) {
  return minutesToTime(randomInt(timeToMinutes(start), timeToMinutes(end)));
}

function resultErrorCode(result) {
  return result?.errorCode || result?.error_code || null;
}

function isAuthRequiredResult(result) {
  return resultErrorCode(result) === FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED;
}

function isAuthTransientResult(result) {
  return resultErrorCode(result) === FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT;
}

function isWebNonWorkingDayResult(result) {
  return resultErrorCode(result) === 'WEB_NON_WORKING_DAY_CONFIRMED';
}

function isWebGuardUnavailableResult(result) {
  return result?.guardUnavailable === true;
}

function isScheduledCancellationResult(result) {
  return result?.status === 'skipped' &&
    result?.error === 'scheduled_action_cancelled' &&
    SCHEDULE_CANCELLATION_CODES.has(resultErrorCode(result));
}

function isScheduleDateStaleResult(result) {
  return resultErrorCode(result) === 'SCHEDULE_DATE_STALE';
}

function isRetryableStateSkip(actionType, result) {
  const state = result?.detectedState;
  return (
    (actionType === 'checkout' && state === FREEE_STATE.ON_BREAK) ||
    (actionType === 'break_end' && state === FREEE_STATE.WORKING) ||
    (actionType === 'break_start' && state === FREEE_STATE.NOT_CHECKED_IN)
  );
}

function isApiOAuthAuthBroken() {
  return getConnectionMode() === 'api' && isOAuthAuthBroken();
}

function captureManualOperationIdentity() {
  const usesOAuth = getConnectionMode() === 'api';
  return Object.freeze({
    automationIdentityKey: currentAutomationIdentityKey(),
    executionLogIdentityKey: currentExecutionLogIdentityKey(),
    companyId: usesOAuth ? getSetting('oauth_company_id') || '' : '',
    companyName: usesOAuth
      ? getSetting('oauth_company_name') || ''
      : getSetting('web_company_name') || '',
  });
}

function settledWithin(promise, timeoutMs) {
  const settled = Promise.resolve(promise).then(
    () => true,
    () => true,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return settled;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    settled.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export class Scheduler {
  constructor() {
    this.dailyCronJob = null;
    this.timers = {};
    this.todaySchedule = {};
    this.skippedActions = new Set(); // Actions skipped due to smart startup
    this.terminalActions = new Set(); // Actions already completed or irreversibly skipped today
    this.startupAnalysis = null; // Last startup analysis result
    this.smartSkipLoggedForDate = null;
    this.activeIdentityKey = 'legacy';
    this.lifecycleGeneration = 0;
    this.initializationTail = Promise.resolve();
    this.inFlightRuns = new Set();
    this.inFlightRunMetadata = new Map();
    this.runIdleWaiters = new Set();
    this.shutdownRequested = false;
    this.shutdownPromise = null;
    this.cancelledMutationRetries = new Map();
    this.cancellationReconciliationRequested = false;
    this.cancellationReconciliationPromise = null;
  }

  initialize({ skipPastNewTimes = false } = {}) {
    if (this.shutdownRequested) {
      const error = new Error('The scheduler is shutting down.');
      error.code = 'SCHEDULER_SHUTTING_DOWN';
      return Promise.reject(error);
    }

    const generation = ++this.lifecycleGeneration;
    this.stopRuntime();
    const previousInitialization = this.initializationTail;
    const initialization = previousInitialization
      .catch(() => {})
      .then(async () => {
        if (!this.lifecycleIsCurrent(generation)) return false;
        this.stopRuntime();

        this.dailyCronJob = cron.schedule('1 0 * * *', () => {
          if (!this.lifecycleIsCurrent(generation)) return;
          void this.trackRun(this.runDailyResolution(generation)).catch((error) => {
            console.error('[Scheduler] Daily resolution failed', safeErrorMetadata(error));
          });
        }, { timezone: getTimezone() });

        await this.resolveAndScheduleToday(generation, skipPastNewTimes);
        if (!this.lifecycleIsCurrent(generation)) return false;
        console.log('[Scheduler] Initialized');
        return true;
      });
    this.initializationTail = initialization;
    return initialization;
  }

  async runDailyResolution(generation) {
    if (!this.lifecycleIsCurrent(generation)) return;
    console.log('[Scheduler] Daily resolution triggered');
    cleanOldSchedules(30);
    cleanExpiredLeaveStrategyCache();
    cleanOldAsyncTasks(2);
    this.skippedActions.clear();
    this.startupAnalysis = null;
    this.smartSkipLoggedForDate = null;
    await this.resolveAndScheduleToday(generation);
  }

  async resolveAndScheduleToday(expectedGeneration = this.lifecycleGeneration, skipPastNewTimes = false) {
    if (!this.lifecycleIsCurrent(expectedGeneration)) return;
    this.clearTodayTimers();
    this.todaySchedule = {};
    this.skippedActions.clear();
    this.terminalActions.clear();
    this.smartSkipLoggedForDate = null;

    const today = getTodayString();
    const identityKey = currentAutomationIdentityKey();
    this.activeIdentityKey = identityKey;
    const context = this.createScheduleContext(
      today,
      identityKey,
      expectedGeneration,
    );
    const existingSchedule = getDailySchedule(today, identityKey);
    const configs = getAllConfig();

    const startConfig = configs.find(cfg => cfg.action_type === 'break_start' && cfg.enabled);
    const endConfig = configs.find(cfg => cfg.action_type === 'break_end' && cfg.enabled);
    const breakPair = startConfig && endConfig ? resolveBreakTimes(startConfig, endConfig, {
      start: existingSchedule.find(row => row.action_type === 'break_start')?.resolved_time,
      end: existingSchedule.find(row => row.action_type === 'break_end')?.resolved_time,
    }) : undefined;

    // Resolve times for all actions
    for (const cfg of configs) {
      if (!cfg.enabled) continue;

      const existing = existingSchedule.find((s) => s.action_type === cfg.action_type);
      let resolvedTime;

      if (existing) {
        resolvedTime = existing.resolved_time;
        if (existing.executed) {
          this.terminalActions.add(cfg.action_type);
          this.skippedActions.add(cfg.action_type);
        }
      } else {
        resolvedTime = cfg.mode === 'random'
          ? randomTimeBetween(cfg.window_start, cfg.window_end)
          : cfg.fixed_time;

        if (cfg.action_type === 'break_start' && breakPair) resolvedTime = breakPair.start;
        if (cfg.action_type === 'break_end' && breakPair) resolvedTime = breakPair.end;

        setDailySchedule(today, cfg.action_type, resolvedTime, identityKey);
      }

      let pauseCode = null;
      try {
        const delay = msUntilTimeInTz(resolvedTime);
        if (delay <= 0 && ((!existing && skipPastNewTimes) || existing?.last_error === 'SCHEDULE_WINDOW_PAST')) pauseCode = 'SCHEDULE_WINDOW_PAST';
      } catch (error) {
        if (error?.code !== 'SCHEDULE_TIME_NONEXISTENT') throw error;
        pauseCode = error.code;
      }
      if (breakPair === null && ['break_start', 'break_end'].includes(cfg.action_type) && !existing?.executed) {
        pauseCode = 'BREAK_WINDOW_INCOMPATIBLE';
      }
      if (pauseCode && !existing?.executed) {
        this.terminalActions.add(cfg.action_type);
        this.skippedActions.add(cfg.action_type);
        // Configuration cannot overwrite evidence from an attempted action.
        if (!existing || (existing.attempts === 0 && ['pending', 'paused_configuration'].includes(existing.last_status))) {
          updateDailyScheduleStatus(today, cfg.action_type, 'paused_configuration', pauseCode, false, identityKey);
          insertLog({ action_type: cfg.action_type, scheduled_time: resolvedTime, status: 'skipped',
            trigger_type: 'scheduler', error_message: pauseCode, error_code: pauseCode, failure_stage: 'schedule_resolution' });
        }
      }
      this.todaySchedule[cfg.action_type] = resolvedTime;
    }
    this.pruneCancelledMutationRetries(
      today,
      identityKey,
      new Set(Object.keys(this.todaySchedule)),
    );

    const calendarStatus = await this.getTodayCalendarStatus(today);
    if (!this.scheduleContextIsCurrent(context)) return;
    if (calendarStatus.isNonWorkingDay) {
      const status = { reason: 'Holiday or weekend', code: 'calendar_holiday' };
      this.skipTodayForNonWorkingDay(today, status, 'holiday');
      console.log('[Scheduler] Today is a holiday/weekend - no actions scheduled');
      return;
    }
    if (calendarStatus.verificationFailed) {
      const reason = 'Automatic actions are paused because the holiday guard could not be verified.';
      this.pauseTodayForGuardUnavailable(today, reason);
      this.scheduleNonWorkingDayRecheck(today, expectedGeneration);
      insertLog({
        action_type: 'daily_resolution',
        scheduled_time: null,
        status: 'skipped',
        trigger_type: 'scheduler',
        error_message: reason,
        error_code: calendarStatus.errorCode || 'HOLIDAY_DATA_UNAVAILABLE',
        failure_stage: 'calendar_guard',
      });
      return;
    }

    // Smart startup: detect current freee state and decide what to schedule
    if (getSetting('auto_checkin_enabled') === '1') {
      if (
        getConnectionMode() === 'browser' &&
        !isDebugMode() &&
        !isWebAccountVerified()
      ) {
        this.clearCancelledMutationRetries(today, identityKey);
        const reason = 'Automatic actions are paused until the freee Web employee identity is verified.';
        this.pauseTodayForGuardUnavailable(
          today,
          reason,
          'identity_unverified',
          'web_identity_unverified',
        );
        insertLog({
          action_type: 'daily_resolution',
          scheduled_time: null,
          status: 'skipped',
          trigger_type: 'scheduler',
          error_message: reason,
          error_code: 'WEB_EMPLOYEE_BINDING_REQUIRED',
          failure_stage: 'identity_binding',
        });
        console.warn('[Scheduler] freee Web employee identity is not verified; no actions scheduled');
        return;
      }
      const nonWorkingStatus = await this.getTodayNonWorkingStatus(today);
      if (!this.scheduleContextIsCurrent(context)) return;
      if (nonWorkingStatus.isNonWorkingDay) {
        this.skipTodayForNonWorkingDay(today, nonWorkingStatus);
        console.log(`[Scheduler] Today is a freee non-working day - no actions scheduled (${nonWorkingStatus.reason})`);
        console.log('[Scheduler] Today\'s schedule:', this.todaySchedule);
        return;
      }
      if (nonWorkingStatus.verificationFailed) {
        const reason = 'Automatic actions are paused because the non-working-day guard could not be verified.';
        this.pauseTodayForGuardUnavailable(today, reason);
        this.scheduleNonWorkingDayRecheck(today, expectedGeneration);
        insertLog({
          action_type: 'daily_resolution',
          scheduled_time: null,
          status: 'skipped',
          trigger_type: 'scheduler',
          error_message: reason,
          error_code: nonWorkingStatus.errorCode || 'WORK_RECORD_GUARD_UNAVAILABLE',
          failure_stage: 'work_record_guard',
        });
        return;
      }

      await this.smartSchedule(0, context);
    } else {
      this.clearCancelledMutationRetries(today, identityKey);
      console.log('[Scheduler] Auto-checkin OFF - times resolved but not scheduling');
      this.startupAnalysis = { state: 'disabled', reason: 'Auto check-in is disabled' };
    }

    console.log('[Scheduler] Today\'s schedule:', this.todaySchedule);
  }

  /**
   * Smart startup: detect state and decide which actions to run.
   *
   * Retry strategy (two-tier):
   *   Tier 1 — Rapid retry: 3 attempts × 30s (handles transient token refresh failures)
   *   Tier 2 — Pre-checkin fallback: if still unknown after Tier 1, schedule ONE retry
   *            15 minutes before the checkin window. This handles cases where the API
   *            is down at 00:01 but recovers by morning (e.g., overnight token expiry,
   *            freee maintenance windows).
   *
   * This ensures we never permanently give up before the user's actual work day starts.
   */
  async smartSchedule(
    retryCount = 0,
    context = this.createScheduleContext(),
  ) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 30_000; // 30 seconds
    const PRE_CHECKIN_BUFFER_MIN = 15; // retry 15min before checkin window

    if (
      !this.scheduleContextIsCurrent(context)
    ) return;
    const currentState = await detectCurrentState();
    if (!this.scheduleContextIsCurrent(context)) return;
    const punchTimes = await this._fetchTodayPunchTimes();
    if (!this.scheduleContextIsCurrent(context)) return;
    this.reconcileRepeatableTerminalActions(
      currentState,
      punchTimes,
      context.date,
    );
    const plan = this.preserveTerminalActions(
      determineActionsForToday(currentState, this.todaySchedule, punchTimes),
    );

    this.startupAnalysis = {
      state: currentState,
      reason: plan.reason,
      execute: plan.execute,
      skip: plan.skip,
      immediate: plan.immediateActions,
      authRequired: isApiOAuthAuthBroken(),
    };

    console.log(`[Scheduler] State: ${currentState} -> ${plan.reason}`);

    if (currentState === FREEE_STATE.UNKNOWN && isApiOAuthAuthBroken()) {
      console.warn('[Scheduler] OAuth authorization requires re-authorization; skipping retry loop and pausing today');
      this.recordSmartScheduleSkip(plan, context);
      return;
    }

    // --- Tier 1: Rapid retry (3×30s) ---
    if (currentState === FREEE_STATE.UNKNOWN && retryCount < MAX_RETRIES) {
      const attempt = retryCount + 1;
      console.log(`[Scheduler] Unknown state — rapid retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`);
      this.startupAnalysis.retrying = true;
      this.startupAnalysis.retryAttempt = attempt;
      this.startupAnalysis.retryMax = MAX_RETRIES;
      this.timers._smartRetry = setTimeout(() => {
        delete this.timers._smartRetry;
        if (!this.scheduleContextIsCurrent(context)) return;
        this.skippedActions = new Set(this.terminalActions);
        this.clearTodayTimers();
        void this.trackRun(
          this.smartSchedule(attempt, context),
        ).catch((error) => {
          console.error('[Scheduler] Smart retry failed', safeErrorMetadata(error));
        });
      }, RETRY_DELAY_MS);
      return;
    }

    // --- Tier 2: Pre-checkin fallback ---
    // If still unknown after all rapid retries AND checkin time is in the future,
    // schedule one final retry 15min before checkin so we don't miss the entire day.
    if (currentState === FREEE_STATE.UNKNOWN && retryCount >= MAX_RETRIES) {
      const checkinTime = this.todaySchedule.checkin;
      if (checkinTime && !this.terminalActions.has('checkin')) {
        const msUntilCheckin = msUntilTimeInTz(checkinTime);
        const fallbackMs = msUntilCheckin - PRE_CHECKIN_BUFFER_MIN * 60 * 1000;

        if (fallbackMs > 60_000) { // at least 1 min in the future
          const fallbackMin = Math.round(fallbackMs / 60_000);
          console.log(`[Scheduler] All rapid retries failed. Scheduling pre-checkin fallback in ${fallbackMin}min (${PRE_CHECKIN_BUFFER_MIN}min before ${checkinTime})`);
          this.startupAnalysis.preCheckinFallback = true;
          this.startupAnalysis.fallbackTime = checkinTime;
          this.startupAnalysis.reason = `Unknown state — will retry ${PRE_CHECKIN_BUFFER_MIN}min before checkin (${checkinTime})`;
          this.timers._preCheckinRetry = setTimeout(() => {
            delete this.timers._preCheckinRetry;
            if (!this.scheduleContextIsCurrent(context)) return;
            console.log(`[Scheduler] Pre-checkin fallback triggered (${PRE_CHECKIN_BUFFER_MIN}min before ${checkinTime})`);
            this.skippedActions = new Set(this.terminalActions);
            this.clearTodayTimers();
            // Pass MAX_RETRIES + 1 so we don't loop back into Tier 2 again
            void this.trackRun(
              this.smartSchedule(
                MAX_RETRIES + 1,
                context,
              ),
            ).catch((error) => {
              console.error('[Scheduler] Pre-checkin retry failed', safeErrorMetadata(error));
            });
          }, fallbackMs);
          return;
        }
        // Fallback time already passed — fall through to normal scheduling
        console.log(`[Scheduler] Pre-checkin fallback time already passed, proceeding with current state`);
      }
    }

    if (currentState === FREEE_STATE.UNKNOWN && plan.execute.length === 0) {
      this.recordSmartScheduleSkip(plan, context);
    }

    // Mark skipped actions
    for (const act of plan.skip) {
      this.skippedActions.add(act);
    }

    // Execute immediate actions (e.g., end overdue break)
    for (const act of plan.immediateActions || []) {
      if (!this.scheduleContextIsCurrent(context)) return;
      this.consumeCancelledMutationRetry(
        context.date,
        act,
        context.identityKey,
      );
      console.log(`[Scheduler] Immediate action: ${act}`);
      await this.runAction(
        act,
        'immediate',
        context,
      );
    }

    // Schedule future actions
    for (const [actionType, timeStr] of Object.entries(this.todaySchedule)) {
      if (this.skippedActions.has(actionType)) {
        this.consumeCancelledMutationRetry(
          context.date,
          actionType,
          context.identityKey,
        );
        console.log(`[Scheduler] ${actionType} at ${timeStr} skipped (smart startup)`);
        continue;
      }
      if (!plan.execute.includes(actionType)) {
        this.consumeCancelledMutationRetry(
          context.date,
          actionType,
          context.identityKey,
        );
        continue;
      }

      const ms = msUntilTimeInTz(timeStr);
      if (ms <= 0) {
        const cancelledMutationRetry = this.consumeCancelledMutationRetry(
          context.date,
          actionType,
          context.identityKey,
        );
        if (cancelledMutationRetry) {
          console.log(`[Scheduler] Retrying ${actionType} after a cancelled pre-dispatch mutation`);
          await this.runAction(
            actionType,
            timeStr,
            context,
          );
          if (!this.scheduleContextIsCurrent(context)) return;
        } else if (
          actionType === 'checkin' &&
          !this.hasPriorScheduledActionRun(context)
        ) {
          // The state-derived plan includes a past check-in only inside its
          // startup grace window. Execute it now instead of discarding it as
          // an ordinary past-due action after a restart. A previous scheduler
          // run must settle first so generation replacement cannot duplicate
          // a mutation that is still crossing its final authorization gate.
          console.log(`[Scheduler] Running checkin within the startup grace window (scheduled: ${timeStr})`);
          await this.runAction(
            actionType,
            timeStr,
            context,
          );
          if (!this.scheduleContextIsCurrent(context)) return;
        } else if (actionType === 'checkin') {
          console.log('[Scheduler] Checkin grace execution deferred while a previous scheduler run is still settling');
        } else {
          console.log(`[Scheduler] ${actionType} at ${timeStr} already passed, skipping`);
        }
        continue;
      }

      this.consumeCancelledMutationRetry(
        context.date,
        actionType,
        context.identityKey,
      );
      console.log(`[Scheduler] Scheduling ${actionType} at ${timeStr} (in ${Math.round(ms / 60000)} min)`);
      this.replaceTimer(actionType, setTimeout(() => {
        this.removeTimer(actionType);
        if (!this.scheduleContextIsCurrent(context)) return;
        void this.runAction(
          actionType,
          timeStr,
          context,
        ).catch((error) => {
          console.error('[Scheduler] Scheduled action failed', safeErrorMetadata(error));
        });
      }, ms));
    }
  }

  runAction(
    actionType,
    scheduledTime,
    context = this.createScheduleContext(),
  ) {
    if (!this.lifecycleIsCurrent(context.generation)) return Promise.resolve();
    return this.trackRun(
      this.runActionAttempt(
        actionType,
        scheduledTime,
        0,
        context,
      ),
      {
        kind: 'scheduled_action',
        actionType,
        generation: context.generation,
        date: context.date,
      },
    );
  }

  async runActionAttempt(
    actionType,
    scheduledTime,
    attempt,
    context = this.createScheduleContext(),
  ) {
    const today = context.date;
    if (!this.actionContextIsCurrent(context, actionType)) return;

    // Check master toggle
    if (getSetting('auto_checkin_enabled') !== '1') {
      console.log(`[Scheduler] Auto disabled, skipping ${actionType}`);
      insertLog({
        action_type: actionType,
        scheduled_time: scheduledTime,
        status: 'skipped',
        trigger_type: 'scheduled',
        error_message: 'Auto check-in disabled',
        error_code: 'SCHEDULE_MASTER_DISABLED',
        failure_stage: 'authorization',
      });
      this.markTerminalAction(today, actionType, 'skipped', 'Auto check-in disabled');
      return;
    }

    // Check holiday again (in case a custom holiday was added mid-day)
    const calendarStatus = await this.getTodayCalendarStatus(today);
    if (!this.actionContextIsCurrent(context, actionType)) return;
    if (calendarStatus.isNonWorkingDay) {
      console.log(`[Scheduler] Holiday, skipping ${actionType}`);
      insertLog({
        action_type: actionType,
        scheduled_time: scheduledTime,
        status: 'skipped',
        trigger_type: 'scheduled',
        error_message: 'Holiday or weekend',
        error_code: 'CALENDAR_NON_WORKING_DAY_CONFIRMED',
        failure_stage: 'calendar_guard',
      });
      this.cancelTodayTimers('calendar_holiday');
      this.skipTodayForNonWorkingDay(
        today,
        { reason: 'Holiday or weekend', code: 'calendar_holiday' },
        'holiday',
      );
      return;
    }
    if (calendarStatus.verificationFailed) {
      const reason = 'Automatic action paused because the holiday guard could not be verified.';
      console.warn('[Scheduler] Holiday guard unavailable; pausing automatic actions');
      insertLog({
        action_type: actionType,
        scheduled_time: scheduledTime,
        status: 'skipped',
        trigger_type: 'scheduled',
        error_message: reason,
        error_code: calendarStatus.errorCode || 'HOLIDAY_DATA_UNAVAILABLE',
        failure_stage: 'calendar_guard',
      });
      updateDailyScheduleStatus(today, actionType, 'guard_unavailable', reason, true, context.identityKey);
      this.cancelTodayTimers('holiday_guard_unavailable');
      return;
    }

    if (getConnectionMode() === 'api' && hasApiCredentials()) {
      const nonWorkingStatus = await this.getTodayNonWorkingStatus(today);
      if (!this.actionContextIsCurrent(context, actionType)) return;
      if (nonWorkingStatus.isNonWorkingDay) {
        console.log(`[Scheduler] freee non-working day, skipping ${actionType}: ${nonWorkingStatus.reason}`);
        insertLog({
          action_type: actionType,
          scheduled_time: scheduledTime,
          status: 'skipped',
          trigger_type: 'scheduled',
          error_message: nonWorkingStatus.reason,
          error_code: 'NON_WORKING_DAY_CONFIRMED',
          failure_stage: 'work_record_guard',
        });
        this.cancelTodayTimers('freee_non_working_day');
        this.skipTodayForNonWorkingDay(today, nonWorkingStatus);
        return;
      }
      if (nonWorkingStatus.verificationFailed) {
        const reason = 'Automatic action paused because the non-working-day guard could not be verified.';
        if (
          nonWorkingStatus.errorCode === FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT &&
          attempt < AUTH_TRANSIENT_RETRY_DELAYS_MS.length
        ) {
          this.scheduleAuthTransientRetry(
            actionType,
            scheduledTime,
            attempt,
            reason,
            context,
          );
          return;
        }

        const status = nonWorkingStatus.errorCode === FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED
          ? 'auth_required'
          : 'guard_unavailable';
        console.warn('[Scheduler] Non-working-day guard unavailable; pausing automatic actions');
        insertLog({
          action_type: actionType,
          scheduled_time: scheduledTime,
          status: 'skipped',
          trigger_type: 'scheduled',
          error_message: reason,
          error_code: nonWorkingStatus.errorCode || 'WORK_RECORD_GUARD_UNAVAILABLE',
          failure_stage: 'work_record_guard',
        });
        updateDailyScheduleStatus(today, actionType, status, reason, true, context.identityKey);
        this.cancelTodayTimers(status);
        return;
      }
    }

    if (isApiOAuthAuthBroken()) {
      const reason = getSetting('oauth_auth_broken_reason') || 'OAuth authorization requires re-authorization. Automatic punching is paused.';
      console.warn(`[Scheduler] OAuth authorization is broken, pausing scheduled actions: ${reason}`);
      insertLog({
        action_type: actionType,
        scheduled_time: scheduledTime,
        status: 'skipped',
        trigger_type: 'scheduled',
        error_message: reason,
        error_code: FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED,
        failure_stage: 'authorization',
      });
      updateDailyScheduleStatus(today, actionType, 'auth_required', reason, true, context.identityKey);
      this.cancelTodayTimers('auth_required');
      return;
    }

    console.log(`[Scheduler] Executing ${actionType} (scheduled: ${scheduledTime})`);
    const result = await executeAction(actionType, {
      expectedIdentityKey: context.identityKey,
      expectedDate: context.date,
      mutationAuthorizationGuard: () => this.assertScheduledMutationAuthorized(
        actionType,
        context,
      ),
    });
    if (!this.identityIsCurrent(context.identityKey)) {
      updateDailyScheduleStatus(
        today,
        actionType,
        'identity_changed',
        'Automation identity changed while the action was running; verify freee before retrying.',
        true,
        context.identityKey,
      );
      return;
    }

    insertLog({
      action_type: actionType,
      scheduled_time: scheduledTime,
      status: result.status,
      trigger_type: 'scheduled',
      error_message: result.error || null,
      screenshot_before: result.screenshotBefore || null,
      screenshot_after: result.screenshotAfter || null,
      duration_ms: result.durationMs,
      error_code: resultErrorCode(result),
      failure_stage: result.failureStage || null,
    });

    if (isScheduledCancellationResult(result)) {
      if (isScheduleDateStaleResult(result)) {
        this.handleStaleScheduleDate(context, actionType);
        return;
      }
      updateDailyScheduleStatus(
        today,
        actionType,
        'cancelled',
        result.error,
        false,
        context.identityKey,
      );
      this.rememberCancelledMutationRetry(today, actionType, context.identityKey);
      this.requestCancellationReconciliation();
      return;
    } else if (isWebNonWorkingDayResult(result)) {
      this.cancelTodayTimers('web_non_working_day');
      this.skipTodayForNonWorkingDay(today, {
        reason: result.nonWorkingReason || 'freee Web marks the date as a non-working day',
        code: result.nonWorkingDayCode || 'web_non_working_day',
      });
    } else if (isWebGuardUnavailableResult(result)) {
      const reason = 'Automatic action paused because the Web non-working-day guard could not be verified.';
      this.pauseTodayForGuardUnavailable(
        today,
        reason,
        'guard_unavailable',
        'web_guard_unavailable',
        actionType,
      );
    } else if (result.status === 'success') {
      this.markTerminalAction(today, actionType, 'success', null);
    } else if (result.status === 'skipped') {
      if (isRetryableStateSkip(actionType, result) && attempt < STATE_RETRY_DELAYS_MS.length) {
        this.scheduleStateRetry(
          actionType,
          scheduledTime,
          attempt,
          result.error || 'Attendance state is not ready for this action.',
          context,
        );
      } else if (isRetryableStateSkip(actionType, result)) {
        updateDailyScheduleStatus(
          today,
          actionType,
          'waiting_for_valid_state',
          result.error || null,
          true,
          context.identityKey,
        );
      } else {
        this.markTerminalAction(today, actionType, 'skipped', result.error || null);
      }
    } else if (isAuthRequiredResult(result)) {
      updateDailyScheduleStatus(today, actionType, 'auth_required', result.error || null, true, context.identityKey);
      this.cancelTodayTimers('auth_required');
    } else if (isAuthTransientResult(result)) {
      if (attempt < AUTH_TRANSIENT_RETRY_DELAYS_MS.length) {
        this.scheduleAuthTransientRetry(
          actionType,
          scheduledTime,
          attempt,
          result.error || 'Transient OAuth refresh failure',
          context,
        );
      } else {
        const reason = `${result.error || 'Token refresh failed'} The authorization was not marked invalid because the failure is transient.`;
        updateDailyScheduleStatus(today, actionType, 'transient_failure', reason, true, context.identityKey);
      }
    } else if (result.status === 'failure') {
      updateDailyScheduleStatus(today, actionType, 'failure', result.error || null, true, context.identityKey);
    }

    // After any successful action, re-evaluate the plan so Dashboard reflects reality.
    if (
      result.status === 'success' &&
      this.scheduleContextIsCurrent(context)
    ) {
      await this.refreshPlanForCurrentState(`scheduled ${actionType}`);
    }

    console.log(`[Scheduler] ${actionType} -> ${result.status}`);
  }

  scheduleAuthTransientRetry(
    actionType,
    scheduledTime,
    attempt,
    error,
    context = this.createScheduleContext(),
  ) {
    if (!this.actionContextIsCurrent(context, actionType)) return;
    const today = context.date;
    const delayMs = AUTH_TRANSIENT_RETRY_DELAYS_MS[attempt];
    const retryKey = `${actionType}:retry`;
    updateDailyScheduleStatus(today, actionType, 'retrying', error, true, context.identityKey);
    console.warn(`[Scheduler] Transient OAuth failure for ${actionType}; retry ${attempt + 1}/${AUTH_TRANSIENT_RETRY_DELAYS_MS.length} in ${Math.round(delayMs / 1000)}s`);
    this.replaceTimer(retryKey, setTimeout(() => {
      this.removeTimer(retryKey);
      if (!this.lifecycleIsCurrent(context.generation)) return;
      void this.trackRun(
        this.runActionAttempt(
          actionType,
          scheduledTime,
          attempt + 1,
          context,
        ),
        {
          kind: 'scheduled_action',
          actionType,
          generation: context.generation,
          date: context.date,
        },
      ).catch((retryError) => {
        console.error('[Scheduler] OAuth retry failed', safeErrorMetadata(retryError));
      });
    }, delayMs));
  }

  scheduleStateRetry(
    actionType,
    scheduledTime,
    attempt,
    error,
    context = this.createScheduleContext(),
  ) {
    if (!this.actionContextIsCurrent(context, actionType)) return;
    const today = context.date;
    const delayMs = STATE_RETRY_DELAYS_MS[attempt];
    const retryKey = `${actionType}:state-retry`;
    updateDailyScheduleStatus(
      today,
      actionType,
      'waiting_for_valid_state',
      error,
      true,
      context.identityKey,
    );
    this.replaceTimer(retryKey, setTimeout(() => {
      this.removeTimer(retryKey);
      if (!this.lifecycleIsCurrent(context.generation)) return;
      void this.trackRun(
        this.runActionAttempt(
          actionType,
          scheduledTime,
          attempt + 1,
          context,
        ),
        {
          kind: 'scheduled_action',
          actionType,
          generation: context.generation,
          date: context.date,
        },
      ).catch((retryError) => {
        console.error('[Scheduler] State retry failed', safeErrorMetadata(retryError));
      });
    }, delayMs));
  }

  cancelTodayTimers(reason) {
    for (const timer of Object.values(this.timers)) {
      clearTimeout(timer);
    }
    this.timers = {};
    console.warn(`[Scheduler] Cancelled today's pending timers (${reason})`);
  }

  recordSmartScheduleSkip(plan, context = this.createScheduleContext()) {
    const today = context.date;
    if (this.smartSkipLoggedForDate === today) return;
    this.smartSkipLoggedForDate = today;

    const authReason = getSetting('oauth_auth_broken_reason') || '';
    const apiAuthBroken = isApiOAuthAuthBroken();
    const reason = apiAuthBroken
      ? authReason || 'OAuth authorization requires re-authorization. Automatic punching is paused.'
      : 'Attendance state could not be determined after retries. No automatic actions were scheduled.';

    insertLog({
      action_type: 'daily_resolution',
      scheduled_time: null,
      status: 'skipped',
      trigger_type: 'scheduler',
      error_message: reason,
      error_code: apiAuthBroken
        ? FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED
        : 'ATTENDANCE_STATE_UNCONFIRMED',
      failure_stage: apiAuthBroken ? 'authorization' : 'state_read',
    });

    const status = apiAuthBroken ? 'auth_required' : 'skipped_unknown';
    for (const act of plan.skip || []) {
      updateDailyScheduleStatus(today, act, status, reason, false, context.identityKey);
    }
  }

  async getTodayNonWorkingStatus(today) {
    if (isDebugMode()) {
      return {
        isNonWorkingDay: false,
        reason: null,
        code: null,
        verificationFailed: false,
      };
    }

    try {
      if (getConnectionMode() === 'browser') {
        const status = await detectWebNonWorkingStatus(today);
        if (status?.confirmed !== true) {
          const error = new Error('freee Web work-record status could not be confirmed.');
          error.code = 'WORK_RECORD_UNCONFIRMED';
          throw error;
        }
        return {
          ...status,
          verificationFailed: false,
        };
      }
      if (!hasApiCredentials()) {
        const error = new Error('No non-working-day data source is configured.');
        error.code = 'WORK_RECORD_GUARD_UNAVAILABLE';
        throw error;
      }
      const client = new FreeeApiClient();
      const record = await client.getWorkRecord(today);
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        !workRecordMatchesDate(record, today)
      ) {
        const error = new Error('freee work record response could not be confirmed.');
        error.code = 'WORK_RECORD_UNCONFIRMED';
        throw error;
      }
      const status = getWorkRecordNonWorkingDayStatus(record);
      if (!status.confirmed) {
        const error = new Error('freee work record fields could not be confirmed.');
        error.code = 'WORK_RECORD_UNCONFIRMED';
        throw error;
      }
      return {
        ...status,
        verificationFailed: false,
      };
    } catch (e) {
      console.warn('[Scheduler] Failed to verify freee work record status');
      return {
        isNonWorkingDay: false,
        reason: null,
        code: null,
        verificationFailed: true,
        errorCode: normalizeAutomationErrorCode(e?.code) ||
          'WORK_RECORD_GUARD_UNAVAILABLE',
      };
    }
  }

  async getTodayCalendarStatus(today) {
    try {
      return {
        isNonWorkingDay: await isHolidayOrWeekend(today),
        verificationFailed: false,
        errorCode: null,
      };
    } catch (error) {
      console.warn('[Scheduler] Failed to verify holiday status', safeErrorMetadata(error));
      return {
        isNonWorkingDay: false,
        verificationFailed: true,
        errorCode: 'HOLIDAY_DATA_UNAVAILABLE',
      };
    }
  }

  skipTodayForNonWorkingDay(today, status, state = 'leave') {
    this.clearCancelledMutationRetries(today, this.activeIdentityKey);
    const allActions = this.getScheduledActionTypes(today);
    this.startupAnalysis = {
      state,
      reason: `${status.reason} - all actions skipped`,
      execute: [],
      skip: allActions,
      immediate: [],
      nonWorkingDayCode: status.code,
    };

    for (const act of allActions) {
      if (this.terminalActions.has(act)) {
        this.skippedActions.add(act);
      } else {
        this.markReverifiableNonWorkingDaySkip(today, act, status.reason);
      }
    }

    insertLog({
      action_type: 'daily_resolution',
      scheduled_time: null,
      status: 'skipped',
      trigger_type: 'scheduler',
      error_message: status.reason,
      error_code: 'NON_WORKING_DAY_CONFIRMED',
      failure_stage: 'work_record_guard',
    });
    this.scheduleNonWorkingDayRecheck(today);
  }

  scheduleNonWorkingDayRecheck(
    today,
    expectedGeneration = this.lifecycleGeneration,
  ) {
    const checkinTime = this.todaySchedule.checkin;
    if (!checkinTime || this.terminalActions.has('checkin') || today !== getTodayString()) return;
    const delayMs = msUntilTimeInTz(checkinTime) - NON_WORKING_RECHECK_BUFFER_MS;
    if (delayMs <= 0) return;

    this.replaceTimer('_nonWorkingRecheck', setTimeout(() => {
      this.removeTimer('_nonWorkingRecheck');
      if (!this.lifecycleIsCurrent(expectedGeneration)) return;
      void this.trackRun(this.resolveAndScheduleToday(expectedGeneration)).catch((error) => {
        console.error('[Scheduler] Non-working-day recheck failed', safeErrorMetadata(error));
      });
    }, delayMs));
  }

  getScheduledActionTypes(today) {
    const persistedActions = getDailySchedule(today, this.activeIdentityKey)
      .map((row) => row.action_type)
      .filter(Boolean);
    return [...new Set([
      ...Object.keys(this.todaySchedule),
      ...persistedActions,
    ])];
  }

  pauseTodayForGuardUnavailable(
    today,
    reason,
    status = 'guard_unavailable',
    timerReason = status,
    attemptedActionType = null,
  ) {
    this.clearCancelledMutationRetries(today, this.activeIdentityKey);
    const rows = new Map(
      getDailySchedule(today, this.activeIdentityKey).map((row) => [row.action_type, row]),
    );
    const allActions = this.getScheduledActionTypes(today);
    this.startupAnalysis = {
      state: status,
      reason,
      execute: [],
      skip: allActions,
      immediate: [],
      guardUnavailable: true,
    };

    for (const act of allActions) {
      const row = rows.get(act);
      if (this.terminalActions.has(act) || row?.executed) {
        this.skippedActions.add(act);
        continue;
      }
      updateDailyScheduleStatus(
        today,
        act,
        status,
        reason,
        act === attemptedActionType,
        this.activeIdentityKey,
      );
      this.skippedActions.add(act);
    }
    this.cancelTodayTimers(timerReason);
  }

  triggerManual(actionType) {
    if (this.shutdownRequested) {
      return Promise.resolve({
        status: 'failure',
        error: 'scheduler_shutting_down',
        errorCode: 'SCHEDULER_SHUTTING_DOWN',
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: 0,
      });
    }
    return this.trackRun(this.triggerManualOperation(actionType));
  }

  async triggerManualOperation(actionType) {
    console.log(`[Scheduler] Manual trigger: ${actionType}`);
    const operationIdentity = captureManualOperationIdentity();
    const result = await executeAction(actionType, {
      expectedIdentityKey: operationIdentity.automationIdentityKey,
    });

    insertLog({
      action_type: actionType,
      scheduled_time: null,
      status: result.status,
      trigger_type: 'manual',
      error_message: result.error || null,
      screenshot_before: result.screenshotBefore || null,
      screenshot_after: result.screenshotAfter || null,
      duration_ms: result.durationMs,
      error_code: resultErrorCode(result),
      failure_stage: result.failureStage || null,
      identity_key: operationIdentity.executionLogIdentityKey,
      company_id: operationIdentity.companyId,
      company_name: operationIdentity.companyName,
    });

    // After any successful action, re-evaluate the plan so Dashboard reflects reality.
    // This cancels timers for actions that are no longer valid (e.g., break_start after checkout)
    // and updates skippedActions/startupAnalysis.
    if (result.status === 'success') {
      await this.refreshPlanForCurrentState(`manual ${actionType}`);
    }

    return result;
  }

  /**
   * Re-detect state and re-evaluate the plan after an action completes.
   * This ensures:
   * - startupAnalysis.state reflects the real current state
   * - skippedActions is updated (e.g., after checkout, skip break_start/break_end)
   * - Future timers for now-invalid actions are cancelled
   * - next_action in Dashboard stays consistent with the actual state
   */
  async refreshPlanForCurrentState(trigger) {
    try {
      const updatedState = await detectCurrentState();
      const punchTimes = await this._fetchTodayPunchTimes();
      this.reconcileRepeatableTerminalActions(updatedState, punchTimes);
      const plan = this.preserveTerminalActions(
        determineActionsForToday(updatedState, this.todaySchedule, punchTimes),
      );

      this.startupAnalysis = {
        ...this.startupAnalysis,
        state: updatedState,
        reason: `Updated after ${trigger}`,
        execute: plan.execute,
        skip: plan.skip,
      };

      // Update skippedActions: merge newly-skipped actions
      for (const act of plan.skip) {
        if (!this.skippedActions.has(act)) {
          this.skippedActions.add(act);
          // Cancel timer for this action if it was scheduled
          const timer = this.removeTimer(act);
          if (timer) {
            clearTimeout(timer);
            console.log(`[Scheduler] Cancelled timer for ${act} (now skipped after ${trigger})`);
          }
        }
      }

      console.log(`[Scheduler] Plan refreshed after ${trigger}: state=${updatedState}, skip=[${plan.skip}], execute=[${plan.execute}]`);
    } catch (e) {
      console.warn(
        '[Scheduler] Failed to refresh plan',
        { trigger, error: safeErrorMetadata(e) },
      );
    }
  }

  /** Fetch identity-bound punch history, or null when it cannot be confirmed. */
  async _fetchTodayPunchTimes() {
    if (isDebugMode()) return [];
    if (getConnectionMode() !== 'api' || !hasApiCredentials()) return null;
    try {
      const client = new FreeeApiClient();
      const punchTimes = await client.getTodayTimeClocks();
      return Array.isArray(punchTimes) ? punchTimes : null;
    } catch (e) {
      console.warn(
        '[Scheduler] Failed to fetch punch times',
        safeErrorMetadata(e),
      );
      return null;
    }
  }

  getTodaySchedule() {
    return { ...this.todaySchedule };
  }

  getStartupAnalysis() {
    return this.startupAnalysis;
  }

  getSkippedActions() {
    return [...this.skippedActions];
  }

  reconcileRepeatableTerminalActions(
    currentState,
    punchTimes,
    scheduleDate = getTodayString(),
  ) {
    if (
      !Array.isArray(punchTimes) ||
      !this.terminalActions.has('checkout') ||
      ![FREEE_STATE.WORKING, FREEE_STATE.ON_BREAK].includes(currentState)
    ) {
      return;
    }

    let lastCheckinIndex = -1;
    let lastCheckoutIndex = -1;
    for (const [index, punch] of (punchTimes || []).entries()) {
      if (punch?.type === 'checkin') lastCheckinIndex = index;
      if (punch?.type === 'checkout') lastCheckoutIndex = index;
    }

    if (lastCheckoutIndex >= 0 && lastCheckinIndex > lastCheckoutIndex) {
      const resolvedTime = this.todaySchedule.checkout;
      if (!resolvedTime) return;

      setDailySchedule(scheduleDate, 'checkout', resolvedTime, this.activeIdentityKey);
      this.terminalActions.delete('checkout');
      this.skippedActions.delete('checkout');
    }
  }

  preserveTerminalActions(plan) {
    const terminal = this.terminalActions;
    return {
      ...plan,
      execute: (plan.execute || []).filter((action) => !terminal.has(action)),
      immediateActions: (plan.immediateActions || []).filter((action) => !terminal.has(action)),
      skip: [...new Set([...(plan.skip || []), ...terminal])],
    };
  }

  markTerminalAction(today, actionType, status, error) {
    markDailyScheduleExecuted(today, actionType, status, error, this.activeIdentityKey);
    this.terminalActions.add(actionType);
    this.skippedActions.add(actionType);
  }

  markReverifiableNonWorkingDaySkip(today, actionType, error) {
    const row = getDailySchedule(today, this.activeIdentityKey)
      .find((candidate) => candidate.action_type === actionType);
    if (this.terminalActions.has(actionType) || row?.executed) {
      this.terminalActions.add(actionType);
      this.skippedActions.add(actionType);
      return;
    }

    updateDailyScheduleStatus(today, actionType, 'skipped', error, false, this.activeIdentityKey);
    this.skippedActions.add(actionType);
  }

  clearTodayTimers() {
    for (const timer of Object.values(this.timers)) {
      clearTimeout(timer);
    }
    this.timers = {};
  }

  replaceTimer(key, timer) {
    const previous = this.removeTimer(key);
    if (previous) clearTimeout(previous);
    Reflect.set(this.timers, key, timer);
  }

  removeTimer(key) {
    const timer = Reflect.get(this.timers, key);
    Reflect.deleteProperty(this.timers, key);
    return timer;
  }

  trackRun(operation, metadata = null) {
    const tracked = Promise.resolve(operation);
    this.inFlightRuns.add(tracked);
    if (metadata) this.inFlightRunMetadata.set(tracked, metadata);
    const cleanup = () => {
      this.inFlightRuns.delete(tracked);
      this.inFlightRunMetadata.delete(tracked);
      if (this.inFlightRuns.size === 0) {
        for (const resolve of this.runIdleWaiters) resolve(true);
        this.runIdleWaiters.clear();
      }
    };
    tracked.then(cleanup, cleanup);
    return tracked;
  }

  hasPriorScheduledActionRun(context) {
    return [...this.inFlightRunMetadata.values()].some((metadata) => (
      metadata.kind === 'scheduled_action' &&
      (
        metadata.generation !== context.generation ||
        metadata.date !== context.date
      )
    ));
  }

  waitForRunsIdle(timeoutMs = 20_000) {
    if (this.inFlightRuns.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer;
      const finish = (idle) => {
        if (timer) clearTimeout(timer);
        this.runIdleWaiters.delete(finish);
        resolve(idle);
      };
      this.runIdleWaiters.add(finish);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
      }
    });
  }

  lifecycleIsCurrent(expectedGeneration) {
    return (
      !this.shutdownRequested &&
      expectedGeneration === this.lifecycleGeneration
    );
  }

  createScheduleContext(
    date = getTodayString(),
    identityKey = this.activeIdentityKey,
    generation = this.lifecycleGeneration,
  ) {
    return Object.freeze({ date, identityKey, generation });
  }

  scheduleContextIsCurrent(context) {
    return (
      this.lifecycleIsCurrent(context.generation) &&
      context.date === getTodayString() &&
      this.identityIsCurrent(context.identityKey)
    );
  }

  actionContextIsCurrent(context, actionType) {
    if (!this.lifecycleIsCurrent(context.generation)) return false;
    if (context.date !== getTodayString()) {
      this.handleStaleScheduleDate(context, actionType);
      return false;
    }
    if (!this.identityIsCurrent(context.identityKey)) {
      updateDailyScheduleStatus(
        context.date,
        actionType,
        'identity_changed',
        'Automation identity changed before execution.',
        false,
        context.identityKey,
      );
      return false;
    }
    return true;
  }

  handleStaleScheduleDate(context, actionType) {
    const reason = 'Scheduled date changed before execution.';
    updateDailyScheduleStatus(
      context.date,
      actionType,
      'date_changed',
      reason,
      false,
      context.identityKey,
    );
    this.clearCancelledMutationRetries(context.date, context.identityKey);
    this.requestCancellationReconciliation();
  }

  assertScheduledMutationAuthorized(
    actionType,
    context = this.createScheduleContext(),
  ) {
    const reject = (code, message) => {
      const error = new Error(message);
      error.code = code;
      throw error;
    };
    if (!this.lifecycleIsCurrent(context.generation)) {
      reject('SCHEDULE_GENERATION_STALE', 'The scheduler generation changed before mutation.');
    }
    if (context.date !== getTodayString()) {
      reject('SCHEDULE_DATE_STALE', 'The scheduled date changed before mutation.');
    }
    if (!this.identityIsCurrent(context.identityKey)) {
      reject('SCHEDULE_IDENTITY_CHANGED', 'The automation identity changed before mutation.');
    }
    if (getSetting('auto_checkin_enabled') !== '1') {
      reject('SCHEDULE_MASTER_DISABLED', 'Automatic attendance is disabled.');
    }
    const config = getAllConfig().find((entry) => entry.action_type === actionType);
    if (!config?.enabled) {
      reject('SCHEDULE_ACTION_DISABLED', 'The scheduled action is disabled.');
    }
    return true;
  }

  stopRuntime() {
    if (this.dailyCronJob) {
      this.dailyCronJob.stop();
      this.dailyCronJob = null;
    }
    this.clearTodayTimers();
    this.todaySchedule = {};
    this.skippedActions.clear();
    this.terminalActions.clear();
  }

  stopAll() {
    this.lifecycleGeneration += 1;
    this.stopRuntime();
  }

  shutdown(timeoutMs = 20_000) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.lifecycleGeneration += 1;
    this.stopRuntime();
    const initialization = this.initializationTail;
    const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Date.now() + timeoutMs
      : Number.POSITIVE_INFINITY;

    this.shutdownPromise = (async () => {
      const remainingForInitialization = Number.isFinite(deadline)
        ? Math.max(1, deadline - Date.now())
        : timeoutMs;
      const initializationSettled = await settledWithin(
        initialization,
        remainingForInitialization,
      );
      this.stopRuntime();
      const remainingForRuns = Number.isFinite(deadline)
        ? Math.max(1, deadline - Date.now())
        : timeoutMs;
      const runsIdle = await this.waitForRunsIdle(remainingForRuns);
      return initializationSettled && runsIdle;
    })();
    return this.shutdownPromise;
  }

  identityIsCurrent(expectedIdentityKey) {
    return (
      expectedIdentityKey === this.activeIdentityKey &&
      expectedIdentityKey === currentAutomationIdentityKey()
    );
  }

  getActiveIdentityKey() {
    return this.activeIdentityKey;
  }

  cancelledMutationRetryKey(date, actionType, identityKey) {
    return `${date}\0${identityKey}\0${actionType}`;
  }

  rememberCancelledMutationRetry(date, actionType, identityKey) {
    const key = this.cancelledMutationRetryKey(date, actionType, identityKey);
    this.cancelledMutationRetries.set(key, { date, actionType, identityKey });
  }

  consumeCancelledMutationRetry(date, actionType, identityKey) {
    return this.cancelledMutationRetries.delete(
      this.cancelledMutationRetryKey(date, actionType, identityKey),
    );
  }

  clearCancelledMutationRetries(date, identityKey) {
    for (const [key, retry] of this.cancelledMutationRetries) {
      if (retry.date === date && retry.identityKey === identityKey) {
        this.cancelledMutationRetries.delete(key);
      }
    }
  }

  pruneCancelledMutationRetries(date, identityKey, allowedActions) {
    for (const [key, retry] of this.cancelledMutationRetries) {
      if (
        retry.date !== date ||
        retry.identityKey !== identityKey ||
        !allowedActions.has(retry.actionType)
      ) {
        this.cancelledMutationRetries.delete(key);
      }
    }
  }

  requestCancellationReconciliation() {
    if (this.shutdownRequested) return;
    this.cancellationReconciliationRequested = true;
    if (this.cancellationReconciliationPromise) return;

    this.cancellationReconciliationPromise = (async () => {
      while (this.cancellationReconciliationRequested && !this.shutdownRequested) {
        this.cancellationReconciliationRequested = false;
        try {
          await withAccountOperation(() => undefined);
          if (this.shutdownRequested) return;
          await this.initialize();
        } catch (error) {
          console.error(
            '[Scheduler] Cancelled action reconciliation failed',
            safeErrorMetadata(error),
          );
        }
      }
    })().finally(() => {
      this.cancellationReconciliationPromise = null;
      if (this.cancellationReconciliationRequested && !this.shutdownRequested) {
        this.requestCancellationReconciliation();
      }
    });
  }
}

export const scheduler = new Scheduler();
