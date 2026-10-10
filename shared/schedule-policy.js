import { timeToMinutes, minutesToTime } from './date-time.js';

export const ACTION_TYPES = Object.freeze(['checkin', 'checkout', 'break_start', 'break_end']);
export const MIN_BREAK_MINUTES = 60;
export const MAX_BREAK_MINUTES = 90;

/** @param {{mode:string, fixed_time:string, window_start:string, window_end:string}} config */
export function scheduleRange(config) {
  return config.mode === 'fixed'
    ? [timeToMinutes(config.fixed_time), timeToMinutes(config.fixed_time)]
    : [timeToMinutes(config.window_start), timeToMinutes(config.window_end)];
}

/** Both selected times stay inside their windows; existing times remain immutable.
 * @param {{mode:string, fixed_time:string, window_start:string, window_end:string}} startConfig
 * @param {{mode:string, fixed_time:string, window_start:string, window_end:string}} endConfig
 * @param {{start?:string, end?:string}} [existing] @param {() => number} [random]
 */
export function resolveBreakTimes(startConfig, endConfig, existing = {}, random = Math.random) {
  const [startMin, startMax] = existing.start
    ? [timeToMinutes(existing.start), timeToMinutes(existing.start)] : scheduleRange(startConfig);
  const [endMin, endMax] = existing.end
    ? [timeToMinutes(existing.end), timeToMinutes(existing.end)] : scheduleRange(endConfig);
  const lowerStart = Math.max(startMin, endMin - MAX_BREAK_MINUTES);
  const upperStart = Math.min(startMax, endMax - MIN_BREAK_MINUTES);
  if (lowerStart > upperStart) return null;
  const pick = (/** @type {number} */ min, /** @type {number} */ max) => min + Math.floor(random() * (max - min + 1));
  const start = pick(lowerStart, upperStart);
  const end = pick(Math.max(endMin, start + MIN_BREAK_MINUTES), Math.min(endMax, start + MAX_BREAK_MINUTES));
  return { start: minutesToTime(start), end: minutesToTime(end) };
}
