import { Router } from 'express';
import {
  currentExecutionLogIdentityKey,
  getSetting,
  getLogsByDate,
  getAllConfig,
  getDailySchedule,
} from '../db.js';
import { scheduler } from '../scheduler.js';
import { isHolidayOrWeekend, getTodayString } from '../holiday.js';
import { hasApiCredentials, hasCredentials, isDebugMode, detectCurrentState, FREEE_STATE, getConnectionMode } from '../automation/index.js';
import { nowInTz, getTimezone } from '../timezone.js';
import { FreeeApiClient } from '../freee-api.js';
import { currentAutomationIdentityKey } from '../automation/identity.js';
import logger, { safeErrorMetadata } from '../logger.js';
import { normalizeAutomationErrorCode } from '../automation-diagnostics.js';

const router = Router();
const log = logger.child('Status');
const STATUS_SNAPSHOT_ATTEMPTS = 2;

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
      [FREEE_STATE.UNKNOWN]: [],
    };

    res.json({
      state,
      valid_actions: validActions[state] || [],
      debug_mode: isDebugMode(),
      connection_mode: getConnectionMode(),
    });
  } catch (e) {
    log.error('freee-state detection failed', { error: safeErrorMetadata(e) });
    res.json({
      state: FREEE_STATE.UNKNOWN,
      valid_actions: [],
      error: 'attendance_state_unconfirmed',
      error_code: normalizeAutomationErrorCode(e?.code) || 'ATTENDANCE_STATE_UNCONFIRMED',
    });
  }
});

/**
 * GET /api/status - Dashboard status data (enriched)
 */
async function buildStatusSnapshot(binding, includeSchedulerState) {
  const today = getTodayString();
  const autoEnabled = getSetting('auto_checkin_enabled') === '1';
  const debugMode = isDebugMode();
  const credentialsOk = hasCredentials();
  const freeeConfigured = getSetting('freee_configured') === '1';
  const todaySchedule = includeSchedulerState ? scheduler.getTodaySchedule() : {};
  const todayScheduleStatus = includeSchedulerState
    ? getDailySchedule(today, binding.automationIdentityKey)
    : [];
  const todayLogs = getLogsByDate(today, binding.logIdentityKey);
  const configs = getAllConfig();
  let isHoliday = false;
  let calendarGuardVerified = true;
  try {
    isHoliday = await isHolidayOrWeekend();
  } catch (error) {
    calendarGuardVerified = false;
    log.warn('Holiday status could not be verified', {
      error: safeErrorMetadata(error),
    });
  }
  const startupAnalysis = includeSchedulerState ? scheduler.getStartupAnalysis() : null;
  const skippedActions = includeSchedulerState ? scheduler.getSkippedActions() : [];
  const authBroken = getConnectionMode() === 'api' && getSetting('oauth_auth_broken') === '1';

  // Fetch today's actual punch times from freee time_clocks API
  // This gives us real timestamps (e.g., checkin at 09:51) that work_records may not yet reflect
  let todayPunchTimes = [];
  if (hasApiCredentials() && !debugMode) {
    try {
      const client = new FreeeApiClient();
      todayPunchTimes = await client.getTodayTimeClocks();
    } catch (e) {
      log.warn('Failed to fetch today time_clocks', {
        error: safeErrorMetadata(e),
      });
    }
  }

  // One state snapshot drives both the displayed state and the next action.
  let derivedState = startupAnalysis?.state || 'unknown';
  if (todayPunchTimes.length > 0) {
    const lastType = todayPunchTimes[todayPunchTimes.length - 1].type;
    if (lastType === 'checkout') derivedState = 'checked_out';
    else if (lastType === 'break_start') derivedState = 'on_break';
    else if (lastType === 'break_end' || lastType === 'checkin') derivedState = 'working';
  }

  // Determine next action — only from non-skipped scheduled actions that are still
  // in the future AND valid for the derived state.
  const { hours, minutes } = nowInTz();
  const currentMinutes = hours * 60 + minutes;
  let nextAction = null;

  // If already checked out or holiday, no next actions
  if (derivedState !== 'checked_out' && derivedState !== 'holiday') {
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

  return {
    auto_checkin_enabled: autoEnabled,
    debug_mode: debugMode,
    freee_configured: freeeConfigured,
    credentials_ok: credentialsOk,
    connection_mode: getConnectionMode(),
    current_date: today,
    timezone: getTimezone(),
    is_holiday: isHoliday,
    calendar_guard_verified: calendarGuardVerified,
    today_schedule: todaySchedule,
    today_schedule_status: todayScheduleStatus,
    today_logs: todayLogs,
    today_punch_times: todayPunchTimes,
    attendance_state: derivedState,
    next_action: nextAction,
    startup_analysis: startupAnalysis,
    skipped_actions: skippedActions,
    auth_status: {
      broken: authBroken,
      since: getSetting('oauth_auth_broken_since') || '',
      reason: getSetting('oauth_auth_broken_reason') || '',
      last_error: getSetting('oauth_auth_broken_reason') || '',
    },
    configs,
  };
}

function captureStatusBinding() {
  return Object.freeze({
    logIdentityKey: currentExecutionLogIdentityKey(),
    automationIdentityKey: currentAutomationIdentityKey(),
  });
}

function statusBindingIsCurrent(binding, includeSchedulerState) {
  return binding.logIdentityKey === currentExecutionLogIdentityKey() &&
    binding.automationIdentityKey === currentAutomationIdentityKey() &&
    (!includeSchedulerState ||
      binding.automationIdentityKey === scheduler.getActiveIdentityKey());
}

router.get('/', async (req, res) => {
  for (let attempt = 0; attempt < STATUS_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const binding = captureStatusBinding();
    const includeSchedulerState =
      binding.automationIdentityKey === scheduler.getActiveIdentityKey();
    const snapshot = await buildStatusSnapshot(binding, includeSchedulerState);
    if (statusBindingIsCurrent(binding, includeSchedulerState)) return res.json(snapshot);
  }
  return res.status(409).json({
    error: 'status_identity_changed',
    code: 'STATUS_IDENTITY_CHANGED',
  });
});

export default router;
