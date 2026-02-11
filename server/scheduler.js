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
import { executeAction, detectCurrentState, determineActionsForToday, FREEE_STATE } from './automation.js';
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
   * Smart startup: detect state and decide which actions to run
   */
  async smartSchedule() {
    const currentState = await detectCurrentState();
    const plan = determineActionsForToday(currentState, this.todaySchedule);

    this.startupAnalysis = {
      state: currentState,
      reason: plan.reason,
      execute: plan.execute,
      skip: plan.skip,
      immediate: plan.immediateActions,
    };

    console.log(`[Scheduler] State: ${currentState} -> ${plan.reason}`);

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

    return result;
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
