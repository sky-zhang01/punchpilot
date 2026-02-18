import cron from 'node-cron';
import {
  getAllConfig,
  getSetting,
  insertLog,
  getDailySchedule,
  setDailySchedule,
  markDailyScheduleExecuted,
  cleanOldSchedules,
  cleanExpiredLeaveStrategyCache,
} from './db.js';
import { executeAction, detectCurrentState, determineActionsForToday, hasCredentials, isDebugMode, FREEE_STATE } from './automation.js';
import { FreeeApiClient } from './freee-api.js';
import { isHolidayOrWeekend, getTodayString } from './holiday.js';
import { msUntilTimeInTz, getTimezone } from './timezone.js';

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

class Scheduler {
  constructor() {
    this.dailyCronJob = null;
    this.timers = {};
    this.todaySchedule = {};
    this.skippedActions = new Set(); // Actions skipped due to smart startup
    this.startupAnalysis = null; // Last startup analysis result
  }

  async initialize() {
    this.stopAll();

    // Daily resolution at 00:01
    this.dailyCronJob = cron.schedule('1 0 * * *', async () => {
      console.log('[Scheduler] Daily resolution triggered');
      cleanOldSchedules(30);
      cleanExpiredLeaveStrategyCache();
      this.skippedActions.clear();
      this.startupAnalysis = null;
      await this.resolveAndScheduleToday();
    });

    await this.resolveAndScheduleToday();
    console.log('[Scheduler] Initialized');
  }

  async resolveAndScheduleToday() {
    this.clearTodayTimers();

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

        // Lunch constraint
        if (cfg.action_type === 'break_end' && breakStartTime) {
          const diff = timeToMinutes(resolvedTime) - timeToMinutes(breakStartTime);
          if (diff > 60) {
            resolvedTime = minutesToTime(timeToMinutes(breakStartTime) + 60);
            console.log(`[Scheduler] Clamped break_end to ${resolvedTime} (60min limit)`);
          }
        }

        setDailySchedule(today, cfg.action_type, resolvedTime);
      }

      if (cfg.action_type === 'break_start') breakStartTime = resolvedTime;
      this.todaySchedule[cfg.action_type] = resolvedTime;
    }

    // Smart startup: detect current freee state and decide what to schedule
    if (getSetting('auto_checkin_enabled') === '1') {
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
    };

    console.log(`[Scheduler] State: ${currentState} -> ${plan.reason}`);

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
    const today = getTodayString();

    // Check master toggle
    if (getSetting('auto_checkin_enabled') !== '1') {
      console.log(`[Scheduler] Auto disabled, skipping ${actionType}`);
      insertLog({ action_type: actionType, scheduled_time: scheduledTime, status: 'skipped', trigger_type: 'scheduled', error_message: 'Auto check-in disabled' });
      markDailyScheduleExecuted(today, actionType);
      return;
    }

    // Check holiday again (in case a custom holiday was added mid-day)
    if (await isHolidayOrWeekend()) {
      console.log(`[Scheduler] Holiday, skipping ${actionType}`);
      insertLog({ action_type: actionType, scheduled_time: scheduledTime, status: 'skipped', trigger_type: 'scheduled', error_message: 'Holiday or weekend' });
      markDailyScheduleExecuted(today, actionType);
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

    markDailyScheduleExecuted(today, actionType);

    // After any successful action, re-evaluate the plan so Dashboard reflects reality.
    if (result.status === 'success') {
      await this.refreshPlanForCurrentState(`scheduled ${actionType}`);
    }

    console.log(`[Scheduler] ${actionType} -> ${result.status}`);
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
