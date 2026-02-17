import { Router } from 'express';
import { getSetting, getLogsByDate, getAllConfig } from '../db.js';
import { scheduler } from '../scheduler.js';
import { isHolidayOrWeekend, getTodayString } from '../holiday.js';
import { hasCredentials, isDebugMode, detectCurrentState, FREEE_STATE, getConnectionMode } from '../automation.js';
import { nowInTz, getTimezone } from '../timezone.js';
import { FreeeApiClient } from '../freee-api.js';

const router = Router();

/**
 * GET /api/status/freee-state - Detect current freee attendance state
 * Returns the live state by logging in and checking button visibility,
 * or mock state if mock mode is enabled.
 */
router.get('/freee-state', async (req, res) => {
  try {
    if (!isDebugMode() && !hasCredentials()) {
      return res.json({ state: FREEE_STATE.UNKNOWN, error: 'No credentials configured' });
    }
    const state = await detectCurrentState();

    // Map state to valid actions
    const validActions = {
      [FREEE_STATE.NOT_CHECKED_IN]: ['checkin'],
      [FREEE_STATE.WORKING]: ['break_start', 'checkout'],
      [FREEE_STATE.ON_BREAK]: ['break_end'],
      [FREEE_STATE.CHECKED_OUT]: [],
      [FREEE_STATE.UNKNOWN]: ['checkin', 'break_start', 'break_end', 'checkout'],
    };

    res.json({
      state,
      valid_actions: validActions[state] || [],
      debug_mode: isDebugMode(),
      connection_mode: getConnectionMode(),
    });
  } catch (e) {
    console.error('[Status] freee-state detection failed:', e.message);
    res.json({ state: FREEE_STATE.UNKNOWN, valid_actions: ['checkin', 'break_start', 'break_end', 'checkout'], error: e.message });
  }
});

/**
 * GET /api/status - Dashboard status data (enriched)
 */
router.get('/', async (req, res) => {
  const today = getTodayString();
  const autoEnabled = getSetting('auto_checkin_enabled') === '1';
  const debugMode = isDebugMode();
  const credentialsOk = hasCredentials();
  const freeeConfigured = getSetting('freee_configured') === '1';
  const todaySchedule = scheduler.getTodaySchedule();
  const currentCompanyId = getSetting('oauth_company_id') || '';
  const todayLogs = getLogsByDate(today, currentCompanyId);
  const configs = getAllConfig();
  const isHoliday = await isHolidayOrWeekend();
  const startupAnalysis = scheduler.getStartupAnalysis();
  const skippedActions = scheduler.getSkippedActions();

  // Determine next action (only from non-skipped scheduled actions)
  const { hours, minutes } = nowInTz();
  const currentMinutes = hours * 60 + minutes;
  let nextAction = null;

  for (const [actionType, timeStr] of Object.entries(todaySchedule)) {
    if (skippedActions.includes(actionType)) continue;
    const [h, m] = timeStr.split(':').map(Number);
    const actionMinutes = h * 60 + m;
    if (actionMinutes > currentMinutes) {
      if (!nextAction || actionMinutes < nextAction.minutes) {
        nextAction = { action_type: actionType, time: timeStr, minutes: actionMinutes };
      }
    }
  }

  if (nextAction) {
    delete nextAction.minutes;
    // Attach mode and window info for random mode display
    const cfg = configs.find((c) => c.action_type === nextAction.action_type);
    if (cfg) {
      nextAction.mode = cfg.mode;
      if (cfg.mode === 'random') {
        nextAction.window_start = cfg.window_start;
        nextAction.window_end = cfg.window_end;
      }
    }
  }

  // Fetch today's actual punch times from freee time_clocks API
  // This gives us real timestamps (e.g., checkin at 09:51) that work_records may not yet reflect
  let todayPunchTimes = [];
  if (credentialsOk && !debugMode) {
    try {
      const client = new FreeeApiClient();
      todayPunchTimes = await client.getTodayTimeClocks();
    } catch (e) {
      console.warn('[Status] Failed to fetch today time_clocks:', e.message?.substring(0, 100));
    }
  }

  res.json({
    auto_checkin_enabled: autoEnabled,
    debug_mode: debugMode,
    freee_configured: freeeConfigured,
    credentials_ok: credentialsOk,
    connection_mode: getConnectionMode(),
    current_date: today,
    timezone: getTimezone(),
    is_holiday: isHoliday,
    today_schedule: todaySchedule,
    today_logs: todayLogs,
    today_punch_times: todayPunchTimes,
    next_action: nextAction,
    startup_analysis: startupAnalysis,
    skipped_actions: skippedActions,
    configs,
  });
});

export default router;
