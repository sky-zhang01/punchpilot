import cron from 'node-cron';
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
} from './db.js';
import { executeAction, detectCurrentState, determineActionsForToday, hasCredentials, isDebugMode, FREEE_STATE, getConnectionMode } from './automation/index.js';
import { FreeeApiClient, FREEE_AUTH_ERROR_CODES, isOAuthAuthBroken, markOAuthAuthBroken } from './freee-api.js';
import { isHolidayOrWeekend, getTodayString } from './holiday.js';
import { msUntilTimeInTz, getTimezone } from './timezone.js';
import { getWorkRecordNonWorkingDayStatus } from './work-record-status.js';

const AUTH_TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

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

function isApiOAuthAuthBroken() {
  return getConnectionMode() === 'api' && isOAuthAuthBroken();
}

class Scheduler {
  constructor() {
    this.dailyCronJob = null;
    this.timers = {};
    this.todaySchedule = {};
    this.skippedActions = new Set(); // Actions skipped due to smart startup
    this.startupAnalysis = null; // Last startup analysis result
    this.smartSkipLoggedForDate = null;
  }

  async initialize() {
    this.stopAll();

    // Daily resolution at 00:01
    this.dailyCronJob = cron.schedule('1 0 * * *', async () => {
      console.log('[Scheduler] Daily resolution triggered');
      cleanOldSchedules(30);
      cleanExpiredLeaveStrategyCache();
      cleanOldAsyncTasks(2);
      this.skippedActions.clear();
      this.startupAnalysis = null;
      this.smartSkipLoggedForDate = null;
      await this.resolveAndScheduleToday();
    });

    await this.resolveAndScheduleToday();
    console.log('[Scheduler] Initialized');
  }

  async resolveAndScheduleToday() {
    this.clearTodayTimers();
    this.smartSkipLoggedForDate = null;

    const today = getTodayString();

    // Check holiday/weekend first
    if (await isHolidayOrWeekend()) {
      console.log('[Scheduler] Today is a holiday/weekend - no actions scheduled');
      this.startupAnalysis = { state: 'holiday', reason: 'Holiday or weekend - all actions skipped' };
      return;
    }

    const existingSchedule = getDailySchedule(today);
    const configs = getAllConfig();

    let breakStartTime = null;

    // Resolve times for all actions
    for (const cfg of configs) {
      if (!cfg.enabled) continue;

      const existing = existingSchedule.find((s) => s.action_type === cfg.action_type && !s.executed);
      let resolvedTime;

      if (existing) {
        resolvedTime = existing.resolved_time;
      } else {
        resolvedTime = cfg.mode === 'random'
          ? randomTimeBetween(cfg.window_start, cfg.window_end)
          : cfg.fixed_time;

        // Lunch constraint: break must be 60-90 minutes
        if (cfg.action_type === 'break_end' && breakStartTime) {
          const diff = timeToMinutes(resolvedTime) - timeToMinutes(breakStartTime);
          if (diff < 60) {
            resolvedTime = minutesToTime(timeToMinutes(breakStartTime) + 60);
            console.log(`[Scheduler] Clamped break_end to ${resolvedTime} (min 60min from ${breakStartTime})`);
          } else if (diff > 90) {
            resolvedTime = minutesToTime(timeToMinutes(breakStartTime) + 90);
            console.log(`[Scheduler] Clamped break_end to ${resolvedTime} (max 90min from ${breakStartTime})`);
          }
        }

        setDailySchedule(today, cfg.action_type, resolvedTime);
      }

      if (cfg.action_type === 'break_start') breakStartTime = resolvedTime;
      this.todaySchedule[cfg.action_type] = resolvedTime;
    }

    // Smart startup: detect current freee state and decide what to schedule
    if (getSetting('auto_checkin_enabled') === '1') {
      const nonWorkingStatus = await this.getTodayNonWorkingStatus(today);
      if (nonWorkingStatus.isNonWorkingDay) {
        this.skipTodayForNonWorkingDay(today, nonWorkingStatus);
        console.log(`[Scheduler] Today is a freee non-working day - no actions scheduled (${nonWorkingStatus.reason})`);
        console.log('[Scheduler] Today\'s schedule:', this.todaySchedule);
        return;
      }

      await this.smartSchedule();
    } else {
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
  async smartSchedule(retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 30_000; // 30 seconds
    const PRE_CHECKIN_BUFFER_MIN = 15; // retry 15min before checkin window

    const currentState = await detectCurrentState();
    const punchTimes = await this._fetchTodayPunchTimes();
    const plan = determineActionsForToday(currentState, this.todaySchedule, punchTimes);

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
      this.recordSmartScheduleSkip(plan);
      return;
    }

    // --- Tier 1: Rapid retry (3×30s) ---
    if (currentState === FREEE_STATE.UNKNOWN && retryCount < MAX_RETRIES) {
      const attempt = retryCount + 1;
      console.log(`[Scheduler] Unknown state — rapid retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`);
      this.startupAnalysis.retrying = true;
      this.startupAnalysis.retryAttempt = attempt;
      this.startupAnalysis.retryMax = MAX_RETRIES;
      this.timers._smartRetry = setTimeout(async () => {
        this.skippedActions.clear();
        this.clearTodayTimers();
        await this.smartSchedule(attempt);
      }, RETRY_DELAY_MS);
      return;
    }

    // --- Tier 2: Pre-checkin fallback ---
    // If still unknown after all rapid retries AND checkin time is in the future,
    // schedule one final retry 15min before checkin so we don't miss the entire day.
    if (currentState === FREEE_STATE.UNKNOWN && retryCount >= MAX_RETRIES) {
      const checkinTime = this.todaySchedule.checkin;
      if (checkinTime) {
        const msUntilCheckin = msUntilTimeInTz(checkinTime);
        const fallbackMs = msUntilCheckin - PRE_CHECKIN_BUFFER_MIN * 60 * 1000;

        if (fallbackMs > 60_000) { // at least 1 min in the future
          const fallbackMin = Math.round(fallbackMs / 60_000);
          console.log(`[Scheduler] All rapid retries failed. Scheduling pre-checkin fallback in ${fallbackMin}min (${PRE_CHECKIN_BUFFER_MIN}min before ${checkinTime})`);
          this.startupAnalysis.preCheckinFallback = true;
          this.startupAnalysis.fallbackTime = checkinTime;
          this.startupAnalysis.reason = `Unknown state — will retry ${PRE_CHECKIN_BUFFER_MIN}min before checkin (${checkinTime})`;
          this.timers._preCheckinRetry = setTimeout(async () => {
            console.log(`[Scheduler] Pre-checkin fallback triggered (${PRE_CHECKIN_BUFFER_MIN}min before ${checkinTime})`);
            this.skippedActions.clear();
            this.clearTodayTimers();
            // Pass MAX_RETRIES + 1 so we don't loop back into Tier 2 again
            await this.smartSchedule(MAX_RETRIES + 1);
          }, fallbackMs);
          return;
        }
        // Fallback time already passed — fall through to normal scheduling
        console.log(`[Scheduler] Pre-checkin fallback time already passed, proceeding with current state`);
      }
    }

    if (currentState === FREEE_STATE.UNKNOWN && plan.execute.length === 0) {
      this.recordSmartScheduleSkip(plan);
    }

    // Mark skipped actions
    for (const act of plan.skip) {
      this.skippedActions.add(act);
    }

    // Execute immediate actions (e.g., end overdue break)
    for (const act of plan.immediateActions || []) {
      console.log(`[Scheduler] Immediate action: ${act}`);
      await this.runAction(act, 'immediate');
    }

    // Schedule future actions
    for (const [actionType, timeStr] of Object.entries(this.todaySchedule)) {
      if (this.skippedActions.has(actionType)) {
        console.log(`[Scheduler] ${actionType} at ${timeStr} skipped (smart startup)`);
        continue;
      }
      if (!plan.execute.includes(actionType)) continue;

      const ms = msUntilTimeInTz(timeStr);
      if (ms <= 0) {
        console.log(`[Scheduler] ${actionType} at ${timeStr} already passed, skipping`);
        continue;
      }

      console.log(`[Scheduler] Scheduling ${actionType} at ${timeStr} (in ${Math.round(ms / 60000)} min)`);
      this.timers[actionType] = setTimeout(async () => {
        await this.runAction(actionType, timeStr);
      }, ms);
    }
  }

  async runAction(actionType, scheduledTime) {
    return this.runActionAttempt(actionType, scheduledTime, 0);
  }

  async runActionAttempt(actionType, scheduledTime, attempt) {
    const today = getTodayString();

    // Check master toggle
    if (getSetting('auto_checkin_enabled') !== '1') {
      console.log(`[Scheduler] Auto disabled, skipping ${actionType}`);
      insertLog({ action_type: actionType, scheduled_time: scheduledTime, status: 'skipped', trigger_type: 'scheduled', error_message: 'Auto check-in disabled' });
      markDailyScheduleExecuted(today, actionType, 'skipped', 'Auto check-in disabled');
      return;
    }

    // Check holiday again (in case a custom holiday was added mid-day)
    if (await isHolidayOrWeekend()) {
      console.log(`[Scheduler] Holiday, skipping ${actionType}`);
      insertLog({ action_type: actionType, scheduled_time: scheduledTime, status: 'skipped', trigger_type: 'scheduled', error_message: 'Holiday or weekend' });
      markDailyScheduleExecuted(today, actionType, 'skipped', 'Holiday or weekend');
      return;
    }

    const nonWorkingStatus = await this.getTodayNonWorkingStatus(today);
    if (nonWorkingStatus.isNonWorkingDay) {
      console.log(`[Scheduler] freee non-working day, skipping ${actionType}: ${nonWorkingStatus.reason}`);
      insertLog({ action_type: actionType, scheduled_time: scheduledTime, status: 'skipped', trigger_type: 'scheduled', error_message: nonWorkingStatus.reason });
      markDailyScheduleExecuted(today, actionType, 'skipped', nonWorkingStatus.reason);
      return;
    }

    if (isApiOAuthAuthBroken()) {
      const reason = getSetting('oauth_auth_broken_reason') || 'OAuth authorization requires re-authorization. Automatic punching is paused.';
      console.warn(`[Scheduler] OAuth authorization is broken, pausing scheduled actions: ${reason}`);
      insertLog({ action_type: actionType, scheduled_time: scheduledTime, status: 'skipped', trigger_type: 'scheduled', error_message: reason });
      updateDailyScheduleStatus(today, actionType, 'auth_required', reason, true);
      this.cancelTodayTimers('auth_required');
      return;
    }

    console.log(`[Scheduler] Executing ${actionType} (scheduled: ${scheduledTime})`);
    const result = await executeAction(actionType);

    insertLog({
      action_type: actionType,
      scheduled_time: scheduledTime,
      status: result.status,
      trigger_type: 'scheduled',
      error_message: result.error || null,
      screenshot_before: result.screenshotBefore || null,
      screenshot_after: result.screenshotAfter || null,
      duration_ms: result.durationMs,
    });

    if (result.status === 'success') {
      markDailyScheduleExecuted(today, actionType, 'success', null);
    } else if (result.status === 'skipped') {
      markDailyScheduleExecuted(today, actionType, 'skipped', result.error || null);
    } else if (isAuthRequiredResult(result)) {
      updateDailyScheduleStatus(today, actionType, 'auth_required', result.error || null, true);
      this.cancelTodayTimers('auth_required');
    } else if (isAuthTransientResult(result)) {
      if (attempt < AUTH_TRANSIENT_RETRY_DELAYS_MS.length) {
        this.scheduleAuthTransientRetry(actionType, scheduledTime, attempt, result.error || 'Transient OAuth refresh failure');
      } else {
        const reason = `${result.error || 'Token refresh failed'} Automatic punching is paused until re-authorization.`;
        markOAuthAuthBroken(reason);
        updateDailyScheduleStatus(today, actionType, 'auth_required', reason, true);
        this.cancelTodayTimers('auth_transient_exhausted');
      }
    } else if (result.status === 'failure') {
      updateDailyScheduleStatus(today, actionType, 'failure', result.error || null, true);
    }

    // After any successful action, re-evaluate the plan so Dashboard reflects reality.
    if (result.status === 'success') {
      await this.refreshPlanForCurrentState(`scheduled ${actionType}`);
    }

    console.log(`[Scheduler] ${actionType} -> ${result.status}`);
  }

  scheduleAuthTransientRetry(actionType, scheduledTime, attempt, error) {
    const today = getTodayString();
    const delayMs = AUTH_TRANSIENT_RETRY_DELAYS_MS[attempt];
    const retryKey = `${actionType}:retry`;
    if (this.timers[retryKey]) clearTimeout(this.timers[retryKey]);
    updateDailyScheduleStatus(today, actionType, 'retrying', error, true);
    console.warn(`[Scheduler] Transient OAuth failure for ${actionType}; retry ${attempt + 1}/${AUTH_TRANSIENT_RETRY_DELAYS_MS.length} in ${Math.round(delayMs / 1000)}s`);
    this.timers[retryKey] = setTimeout(async () => {
      delete this.timers[retryKey];
      await this.runActionAttempt(actionType, scheduledTime, attempt + 1);
    }, delayMs);
  }

  cancelTodayTimers(reason) {
    for (const [key, timer] of Object.entries(this.timers)) {
      clearTimeout(timer);
      delete this.timers[key];
    }
    console.warn(`[Scheduler] Cancelled today's pending timers (${reason})`);
  }

  recordSmartScheduleSkip(plan) {
    const today = getTodayString();
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
    });

    const status = apiAuthBroken ? 'auth_required' : 'skipped_unknown';
    for (const act of plan.skip || []) {
      updateDailyScheduleStatus(today, act, status, reason);
    }
  }

  async getTodayNonWorkingStatus(today) {
    if (!hasCredentials() || isDebugMode() || getConnectionMode() !== 'api') {
      return { isNonWorkingDay: false, reason: null, code: null };
    }

    try {
      const client = new FreeeApiClient();
      const record = await client.getWorkRecord(today);
      return getWorkRecordNonWorkingDayStatus(record);
    } catch (e) {
      console.warn('[Scheduler] Failed to check freee work record status:', e.message?.substring(0, 100));
      return { isNonWorkingDay: false, reason: null, code: null };
    }
  }

  skipTodayForNonWorkingDay(today, status) {
    const allActions = Object.keys(this.todaySchedule);
    this.startupAnalysis = {
      state: 'leave',
      reason: `${status.reason} - all actions skipped`,
      execute: [],
      skip: allActions,
      immediate: [],
      nonWorkingDayCode: status.code,
    };

    for (const act of allActions) {
      this.skippedActions.add(act);
      markDailyScheduleExecuted(today, act, 'skipped', status.reason);
    }

    insertLog({
      action_type: 'daily_resolution',
      scheduled_time: null,
      status: 'skipped',
      trigger_type: 'scheduler',
      error_message: status.reason,
    });
  }

  async triggerManual(actionType) {
    console.log(`[Scheduler] Manual trigger: ${actionType}`);
    const result = await executeAction(actionType);

    insertLog({
      action_type: actionType,
      scheduled_time: null,
      status: result.status,
      trigger_type: 'manual',
      error_message: result.error || null,
      screenshot_before: result.screenshotBefore || null,
      screenshot_after: result.screenshotAfter || null,
      duration_ms: result.durationMs,
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
      const plan = determineActionsForToday(updatedState, this.todaySchedule, punchTimes);

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
          if (this.timers[act]) {
            clearTimeout(this.timers[act]);
            delete this.timers[act];
            console.log(`[Scheduler] Cancelled timer for ${act} (now skipped after ${trigger})`);
          }
        }
      }

      console.log(`[Scheduler] Plan refreshed after ${trigger}: state=${updatedState}, skip=[${plan.skip}], execute=[${plan.execute}]`);
    } catch (e) {
      console.warn(`[Scheduler] Failed to refresh plan after ${trigger}:`, e.message);
    }
  }

  /**
   * Fetch today's punch times from freee time_clocks API.
   * Returns [] if credentials unavailable, debug mode, or API error.
   */
  async _fetchTodayPunchTimes() {
    if (!hasCredentials() || isDebugMode()) return [];
    try {
      const client = new FreeeApiClient();
      return await client.getTodayTimeClocks();
    } catch (e) {
      console.warn('[Scheduler] Failed to fetch punch times:', e.message?.substring(0, 100));
      return [];
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

  clearTodayTimers() {
    for (const timer of Object.values(this.timers)) {
      clearTimeout(timer);
    }
    this.timers = {};
  }

  stopAll() {
    if (this.dailyCronJob) {
      this.dailyCronJob.stop();
      this.dailyCronJob = null;
    }
    this.clearTodayTimers();
    this.todaySchedule = {};
  }
}

export const scheduler = new Scheduler();
