import { timeToMinutes, minutesToTime } from './date-time.js';

export const ACTION_TYPES = Object.freeze(['checkin', 'checkout', 'break_start', 'break_end']);
export const MIN_BREAK_MINUTES = 60;
export const DEFAULT_MAX_BREAK_MINUTES = 75;
// Installs that predate the configurable cap planned breaks of up to 90 minutes.
export const LEGACY_MAX_BREAK_MINUTES = 90;
export const MAX_BREAK_MINUTES_LIMIT = 180;
export const DEFAULT_MIN_NET_WORK_MINUTES = 480;
export const MIN_NET_WORK_MINUTES_LIMIT = 60;
export const MAX_NET_WORK_MINUTES_LIMIT = 960;
const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

/** @typedef {{action_type?:string, enabled?:number|boolean, mode:string, fixed_time:string, window_start:string, window_end:string}} ScheduleConfig */
/** @typedef {{minNetWorkMinutes:number, maxBreakMinutes:number}} WorkRules */

/** @param {unknown} value */
export function isValidMinNetWorkMinutes(value) {
  return Number.isInteger(value) && (value === 0 ||
    (/** @type {number} */ (value) >= MIN_NET_WORK_MINUTES_LIMIT && /** @type {number} */ (value) <= MAX_NET_WORK_MINUTES_LIMIT));
}

/** @param {unknown} value */
export function isValidMaxBreakMinutes(value) {
  return Number.isInteger(value) && /** @type {number} */ (value) >= MIN_BREAK_MINUTES &&
    /** @type {number} */ (value) <= MAX_BREAK_MINUTES_LIMIT;
}

/** Stored setting strings (or numbers) to rules; anything invalid falls back to the defaults.
 * @param {unknown} rawMinNet @param {unknown} rawMaxBreak @returns {WorkRules} */
export function normalizeWorkRules(rawMinNet, rawMaxBreak) {
  const toNumber = (/** @type {unknown} */ raw) => (typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw);
  const minNet = toNumber(rawMinNet);
  const maxBreak = toNumber(rawMaxBreak);
  return {
    minNetWorkMinutes: isValidMinNetWorkMinutes(minNet) ? /** @type {number} */ (minNet) : DEFAULT_MIN_NET_WORK_MINUTES,
    maxBreakMinutes: isValidMaxBreakMinutes(maxBreak) ? /** @type {number} */ (maxBreak) : DEFAULT_MAX_BREAK_MINUTES,
  };
}

/** @param {ScheduleConfig} config */
export function scheduleRange(config) {
  return config.mode === 'fixed'
    ? [timeToMinutes(config.fixed_time), timeToMinutes(config.fixed_time)]
    : [timeToMinutes(config.window_start), timeToMinutes(config.window_end)];
}

/** @param {ScheduleConfig} startConfig @param {ScheduleConfig} endConfig @param {{start?:string, end?:string}} existing */
function breakBounds(startConfig, endConfig, existing) {
  const [startMin, startMax] = existing.start
    ? [timeToMinutes(existing.start), timeToMinutes(existing.start)] : scheduleRange(startConfig);
  const [endMin, endMax] = existing.end
    ? [timeToMinutes(existing.end), timeToMinutes(existing.end)] : scheduleRange(endConfig);
  return { startMin, startMax, endMin, endMax };
}

const pickInRange = (/** @type {number} */ min, /** @type {number} */ max, /** @type {() => number} */ random) =>
  min + Math.floor(random() * (max - min + 1));

/** Both selected times stay inside their windows and the break lasts between
 * MIN_BREAK_MINUTES and the cap; existing times remain immutable.
 * @param {ScheduleConfig} startConfig
 * @param {ScheduleConfig} endConfig
 * @param {{start?:string, end?:string}} [existing] @param {() => number} [random]
 * @param {number} [maxBreak] Configured break cap in minutes.
 * @param {number} [durationCap] Extra upper bound on the break length (never raises the cap).
 */
export function resolveBreakTimes(
  startConfig,
  endConfig,
  existing = {},
  random = Math.random,
  maxBreak = DEFAULT_MAX_BREAK_MINUTES,
  durationCap = Infinity,
) {
  const { startMin, startMax, endMin, endMax } = breakBounds(startConfig, endConfig, existing);
  const maxDuration = Math.min(maxBreak, durationCap);
  const lowerStart = Math.max(startMin, endMin - maxDuration);
  const upperStart = Math.min(startMax, endMax - MIN_BREAK_MINUTES);
  if (lowerStart > upperStart) return null;
  const start = pickInRange(lowerStart, upperStart, random);
  const end = pickInRange(Math.max(endMin, start + MIN_BREAK_MINUTES), Math.min(endMax, start + maxDuration), random);
  return { start: minutesToTime(start), end: minutesToTime(end) };
}

/** Shortest break the windows can produce (assumes the windows are break-compatible).
 * @param {ScheduleConfig} startConfig @param {ScheduleConfig} endConfig @param {{start?:string, end?:string}} [existing] */
function shortestBreakMinutes(startConfig, endConfig, existing = {}) {
  const { startMax, endMin } = breakBounds(startConfig, endConfig, existing);
  return Math.max(MIN_BREAK_MINUTES, endMin - startMax);
}

/** @param {ScheduleConfig[]} configs @param {string} action */
const enabledConfig = (configs, action) => configs.find((cfg) => cfg.action_type === action && cfg.enabled);

/** True when the enabled break windows can produce a break within the cap (or breaks are off).
 * @param {ScheduleConfig[]} configs @param {number} maxBreak */
export function breakWindowsCompatible(configs, maxBreak) {
  const start = enabledConfig(configs, 'break_start');
  const end = enabledConfig(configs, 'break_end');
  if (!start || !end) return true;
  return resolveBreakTimes(start, end, {}, () => 0, maxBreak) !== null;
}

/** The minimum-net-work rule can be met inside the checkout window on every day:
 * the latest check-in, the shortest break and the minimum net work still end by the window end.
 * @param {ScheduleConfig[]} configs @param {WorkRules} rules */
export function workRulesFeasible(configs, rules) {
  if (!(rules.minNetWorkMinutes > 0)) return true;
  const checkin = enabledConfig(configs, 'checkin');
  const checkout = enabledConfig(configs, 'checkout');
  if (!checkin || !checkout) return true;
  const start = enabledConfig(configs, 'break_start');
  const end = enabledConfig(configs, 'break_end');
  const shortestBreak = start && end ? shortestBreakMinutes(start, end) : 0;
  return scheduleRange(checkin)[1] + shortestBreak + rules.minNetWorkMinutes <= scheduleRange(checkout)[1];
}

/**
 * Resolve the times still missing for one day. Existing times are returned untouched;
 * check-in and the break pair are drawn first, then check-out is derived so net work
 * reaches the minimum, without passing the check-out window end whenever the windows allow it.
 * When they do not, net work wins and check-out lands after the window end (never past 23:59).
 * @param {ScheduleConfig[]} configs
 * @param {Partial<Record<string, string>>} existing Times already stored for the day, by action type.
 * @param {WorkRules} rules @param {() => number} [random]
 * @returns {{times: Record<string, string>, breakPair: {start:string,end:string}|null|undefined}}
 *   breakPair is undefined when breaks are off and null when the windows cannot satisfy the break limits.
 */
export function resolveDailyTimes(configs, existing = {}, rules, random = Math.random) {
  const maxBreak = rules?.maxBreakMinutes ?? DEFAULT_MAX_BREAK_MINUTES;
  const minNet = rules?.minNetWorkMinutes ?? 0;
  /** @type {Record<string, string>} */
  const times = {};
  const draw = (/** @type {ScheduleConfig} */ cfg) => {
    const [min, max] = scheduleRange(cfg);
    return minutesToTime(pickInRange(min, max, random));
  };

  const checkinCfg = enabledConfig(configs, 'checkin');
  const checkoutCfg = enabledConfig(configs, 'checkout');
  const startCfg = enabledConfig(configs, 'break_start');
  const endCfg = enabledConfig(configs, 'break_end');

  if (checkinCfg) times.checkin = existing.checkin ?? draw(checkinCfg);
  const checkinMin = times.checkin ? timeToMinutes(times.checkin) : null;
  const checkoutEnd = checkoutCfg
    ? (existing.checkout ? timeToMinutes(existing.checkout) : scheduleRange(checkoutCfg)[1]) : null;

  /** @type {{start:string,end:string}|null|undefined} */
  let breakPair;
  if (startCfg && endCfg && existing.break_start && existing.break_end) {
    // A pair stored for today is the day's committed plan. A cap lowered since
    // (an upgrade from the 90 minute cap, or a settings change) applies to breaks
    // drawn from now on and to ending an overrunning break, not to this pair.
    // The caller passes only planned pairs; one no cap could ever have produced is not a plan.
    const length = timeToMinutes(existing.break_end) - timeToMinutes(existing.break_start);
    breakPair = length >= MIN_BREAK_MINUTES && length <= MAX_BREAK_MINUTES_LIMIT
      ? { start: existing.break_start, end: existing.break_end } : null;
    times.break_start = existing.break_start;
    times.break_end = existing.break_end;
  } else if (startCfg && endCfg) {
    const pairExisting = { start: existing.break_start, end: existing.break_end };
    let pairCap = maxBreak;
    let open = resolveBreakTimes(startCfg, endCfg, pairExisting, () => 0, pairCap);
    if (!open && existing.break_start) {
      // A start stored under an earlier, longer cap may need that cap to find its end.
      pairCap = Math.max(maxBreak, LEGACY_MAX_BREAK_MINUTES);
      open = resolveBreakTimes(startCfg, endCfg, pairExisting, () => 0, pairCap);
    }
    if (!open) {
      breakPair = null;
      times.break_start = existing.break_start ?? draw(startCfg);
      times.break_end = existing.break_end ?? draw(endCfg);
    } else {
      let cap = Infinity;
      if (minNet > 0 && checkinMin !== null && checkoutEnd !== null) {
        // Prefer a break that keeps the minimum net work inside the window; never go below the shortest feasible one.
        cap = Math.max(shortestBreakMinutes(startCfg, endCfg, pairExisting), checkoutEnd - checkinMin - minNet);
      }
      breakPair = resolveBreakTimes(startCfg, endCfg, pairExisting, random, pairCap, cap);
      times.break_start = breakPair?.start ?? open.start;
      times.break_end = breakPair?.end ?? open.end;
    }
  }

  if (checkoutCfg) {
    if (existing.checkout) {
      times.checkout = existing.checkout;
    } else {
      const [windowStart, windowEnd] = scheduleRange(checkoutCfg);
      // Only a planned pair is punched; a paused placeholder pair adds no break.
      const breakMinutes = breakPair
        ? timeToMinutes(breakPair.end) - timeToMinutes(breakPair.start) : 0;
      const needed = minNet > 0 && checkinMin !== null ? checkinMin + breakMinutes + minNet : 0;
      const lower = Math.max(windowStart, needed);
      times.checkout = minutesToTime(lower <= windowEnd
        ? pickInRange(lower, windowEnd, random)
        : Math.min(needed, LAST_MINUTE_OF_DAY));
    }
  }
  // A lone break action (its partner disabled) has no pair to satisfy; it is drawn on its own.
  for (const cfg of [startCfg, endCfg]) {
    if (cfg?.action_type && !times[cfg.action_type]) times[cfg.action_type] = existing[cfg.action_type] ?? draw(cfg);
  }
  return { times, breakPair };
}

/**
 * Earliest minute of the day at which net work reaches the minimum, from chronological punch records.
 * Net work of segments already closed by a check-out counts toward the minimum, so a re-checkin
 * only has to make up the rest. Returns null when it cannot be determined (rule off, no open
 * check-in, or an open break).
 * @param {{type:string, time:string}[]} records @param {number} minNetWorkMinutes
 */
export function earliestCompliantCheckoutMinute(records, minNetWorkMinutes) {
  if (!(minNetWorkMinutes > 0) || !Array.isArray(records)) return null;
  let closedNetWork = 0;
  /** @type {number|null} */
  let segmentStart = null;
  let segmentBreaks = 0;
  /** @type {number|null} */
  let openBreakStart = null;
  for (const record of records) {
    const minute = typeof record?.time === 'string' ? timeToMinutes(record.time) : null;
    if (minute === null) continue;
    if (record.type === 'checkin') {
      segmentStart = minute;
      segmentBreaks = 0;
      openBreakStart = null;
    } else if (record.type === 'break_start' && segmentStart !== null) {
      openBreakStart = minute;
    } else if (record.type === 'break_end' && openBreakStart !== null) {
      segmentBreaks += Math.max(0, minute - openBreakStart);
      openBreakStart = null;
    } else if (record.type === 'checkout' && segmentStart !== null) {
      closedNetWork += Math.max(0, minute - segmentStart - segmentBreaks);
      segmentStart = null;
      openBreakStart = null;
    }
  }
  if (segmentStart === null || openBreakStart !== null) return null;
  const remaining = Math.max(0, minNetWorkMinutes - closedNetWork);
  return Math.min(segmentStart + segmentBreaks + remaining, LAST_MINUTE_OF_DAY);
}
