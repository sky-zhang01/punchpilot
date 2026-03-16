import { FREEE_STATE } from "../constants.js";
import { nowInTz } from "../timezone.js";

/** Check if an action is valid for the current state */
export function isActionValidForState(actionType, state) {
  const rules = {
    checkin: { valid: [FREEE_STATE.NOT_CHECKED_IN] },
    checkout: { valid: [FREEE_STATE.WORKING] },
    break_start: { valid: [FREEE_STATE.WORKING] },
    break_end: { valid: [FREEE_STATE.ON_BREAK] },
  };

  const rule = rules[actionType];
  if (!rule) return { ok: false, reason: `Unknown action: ${actionType}` };
  if (rule.valid.includes(state)) return { ok: true };

  const reasons = {
    checkin: {
      [FREEE_STATE.WORKING]: "Already checked in",
      [FREEE_STATE.ON_BREAK]: "Already on break",
      [FREEE_STATE.CHECKED_OUT]: "Already checked out",
    },
    checkout: {
      [FREEE_STATE.NOT_CHECKED_IN]: "Not checked in",
      [FREEE_STATE.ON_BREAK]: "On break - end break first",
      [FREEE_STATE.CHECKED_OUT]: "Already checked out",
    },
    break_start: {
      [FREEE_STATE.NOT_CHECKED_IN]: "Not checked in",
      [FREEE_STATE.ON_BREAK]: "Already on break",
      [FREEE_STATE.CHECKED_OUT]: "Already checked out",
    },
    break_end: {
      [FREEE_STATE.NOT_CHECKED_IN]: "Not checked in",
      [FREEE_STATE.WORKING]: "Not on break",
      [FREEE_STATE.CHECKED_OUT]: "Already checked out",
    },
  };

  return {
    ok: false,
    reason:
      reasons[actionType]?.[state] ||
      `Invalid state ${state} for ${actionType}`,
  };
}

/**
 * Determine which actions should be scheduled today based on current state, schedule,
 * and actual punch records. Uses independent action evaluation instead of rigid state machine.
 *
 * Break necessity is based on Japanese Labor Standards Act Article 34 (労働基準法 第34条):
 *   - ≤6h work: no mandatory break
 *   - >6h work: break required (≥45min for ≤8h, ≥60min for >8h)
 * Threshold: expectedWorkMinutes >= 361 (6h1m) triggers break_start/break_end.
 *
 * freee's 雇用区分休憩 (auto break deduction) is a per-company optional setting,
 * NOT enabled by default, so PunchPilot must handle break punching independently.
 *
 * @param {string} currentState - 'not_checked_in'|'working'|'on_break'|'checked_out'|'unknown'
 * @param {Object} schedule - { checkin: 'HH:MM', break_start: 'HH:MM', break_end: 'HH:MM', checkout: 'HH:MM' }
 * @param {Array} todayPunchTimes - [{ type: 'checkin'|'checkout'|'break_start'|'break_end', time: 'HH:MM' }]
 * @param {string|null} currentTime - 'HH:MM' for testing (null = use real time via nowInTz)
 * @returns {{ execute: string[], skip: string[], immediateActions: string[], reason: string }}
 */
export function determineActionsForToday(
  currentState,
  schedule,
  todayPunchTimes = [],
  currentTime = null,
) {
  const toMin = (t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };

  // Use injected time for tests, or timezone-aware current time
  let curMin;
  if (currentTime) {
    curMin = toMin(currentTime);
  } else {
    const { hours, minutes } = nowInTz();
    curMin = hours * 60 + minutes;
  }

  const result = { skip: [], execute: [], immediateActions: [], reason: "" };
  const allActions = ["checkin", "break_start", "break_end", "checkout"];

  // --- Early return: unknown state → skip everything for safety ---
  if (currentState === FREEE_STATE.UNKNOWN) {
    result.skip = [...allActions];
    result.reason = `Unknown state (${currentState}), skipping all for safety`;
    return result;
  }

  // --- Step 1: Derive data from punch records ---

  // Actions already completed today (from freee time_clocks)
  const completedActions = new Set(todayPunchTimes.map((p) => p.type));

  // For re-checkin scenarios (checkout then checkin again), the effective state is
  // what matters — not historical completedActions. If currentState is 'working' but
  // checkout exists in records, the user has re-checked-in and checkout is no longer active.
  const isEffectivelyCheckedOut = currentState === FREEE_STATE.CHECKED_OUT;

  // Effective checkin time: last checkin record (supports re-checkin scenarios), or scheduled time
  const checkinRecords = todayPunchTimes.filter((p) => p.type === "checkin");
  const lastCheckinRecord =
    checkinRecords.length > 0
      ? checkinRecords[checkinRecords.length - 1]
      : null;
  const effectiveCheckinTime = lastCheckinRecord
    ? toMin(lastCheckinRecord.time)
    : schedule.checkin
      ? toMin(schedule.checkin)
      : null;

  // Is this person effectively checked in? (either completed a checkin, or about to be checked in)
  const hasCheckedIn = completedActions.has("checkin");

  // Expected work duration = scheduled checkout - effective checkin
  const checkoutMin = schedule.checkout ? toMin(schedule.checkout) : null;
  const expectedWorkMinutes =
    effectiveCheckinTime != null && checkoutMin != null
      ? checkoutMin - effectiveCheckinTime
      : null;

  // Break needed if expected work >= 361 minutes (>6h, per Japanese Labor Standards Act Art. 34)
  const BREAK_THRESHOLD_MINUTES = 361;
  const breakNeeded =
    expectedWorkMinutes != null &&
    expectedWorkMinutes >= BREAK_THRESHOLD_MINUTES;

  // --- Step 2: Independently evaluate each action ---

  // CHECKIN
  if (hasCheckedIn && currentState !== FREEE_STATE.NOT_CHECKED_IN) {
    // Already checked in (and state confirms it) → skip
    result.skip.push("checkin");
  } else if (currentState !== FREEE_STATE.NOT_CHECKED_IN) {
    // State is working/on_break/checked_out → no need to check in
    result.skip.push("checkin");
  } else if (schedule.checkin && curMin > toMin(schedule.checkin) + 5) {
    // Checkin window passed (>5min late) → skip to avoid late attendance record
    result.skip.push("checkin");
  } else {
    result.execute.push("checkin");
  }

  // Will checkin happen today? (either scheduled to execute, or already completed)
  const willBeCheckedIn = result.execute.includes("checkin") || hasCheckedIn;

  // BREAK_START
  if (completedActions.has("break_start")) {
    result.skip.push("break_start");
  } else if (isEffectivelyCheckedOut) {
    result.skip.push("break_start");
  } else if (!willBeCheckedIn) {
    // No checkin today → no break needed
    result.skip.push("break_start");
  } else if (!breakNeeded) {
    // Work duration < 6h1m → break not required by labor law
    result.skip.push("break_start");
  } else {
    result.execute.push("break_start");
  }

  // BREAK_END
  if (completedActions.has("break_end")) {
    result.skip.push("break_end");
  } else if (isEffectivelyCheckedOut) {
    result.skip.push("break_end");
  } else if (
    !result.execute.includes("break_start") &&
    !completedActions.has("break_start")
  ) {
    // No break_start planned or completed → no break_end needed
    result.skip.push("break_end");
  } else if (currentState === FREEE_STATE.ON_BREAK) {
    // Currently on break — check if overdue (>60min from actual break_start)
    const breakStartRecord = todayPunchTimes
      .filter((p) => p.type === "break_start")
      .pop();
    const actualBreakStartMin = breakStartRecord
      ? toMin(breakStartRecord.time)
      : null;
    if (actualBreakStartMin != null && curMin - actualBreakStartMin > 90) {
      // Break exceeded 90 minutes → end immediately
      result.immediateActions.push("break_end");
    } else {
      result.execute.push("break_end");
    }
  } else {
    result.execute.push("break_end");
  }

  // CHECKOUT
  if (isEffectivelyCheckedOut) {
    result.skip.push("checkout");
  } else if (!willBeCheckedIn) {
    // No checkin today → no checkout needed
    result.skip.push("checkout");
  } else {
    result.execute.push("checkout");
  }

  // --- Step 3: Generate reason ---
  const reasons = [];
  if (result.execute.length === 0 && result.immediateActions.length === 0) {
    if (currentState === FREEE_STATE.CHECKED_OUT) {
      reasons.push("Already checked out, nothing to do today");
    } else if (currentState === FREEE_STATE.UNKNOWN) {
      reasons.push(`Unknown state (${currentState}), skipping all for safety`);
    } else if (
      result.skip.includes("checkin") &&
      !completedActions.has("checkin")
    ) {
      reasons.push(
        "Checkin window passed - skipping today to avoid late record",
      );
    } else {
      reasons.push("All actions completed or skipped");
    }
  } else {
    if (completedActions.size > 0) {
      reasons.push(`Completed: [${[...completedActions].join(", ")}]`);
    }
    if (result.execute.length > 0) {
      reasons.push(`Scheduling: [${result.execute.join(", ")}]`);
    }
    if (result.immediateActions.length > 0) {
      reasons.push(`Immediate: [${result.immediateActions.join(", ")}]`);
    }
    if (!breakNeeded && expectedWorkMinutes != null) {
      reasons.push(
        `Break skipped (expected work ${expectedWorkMinutes}min < ${BREAK_THRESHOLD_MINUTES}min threshold)`,
      );
    }
  }
  result.reason = reasons.join(". ");

  return result;
}
