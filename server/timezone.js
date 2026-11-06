/**
 * Timezone utility for PunchPilot
 *
 * All schedule calculations should use these helpers instead of raw `new Date()`.
 * This ensures correct behavior regardless of the host machine's timezone.
 *
 * Priority: TZ env > DB setting > default (Asia/Tokyo)
 *
 * For users in a different timezone than their company:
 *   - Set TZ=Asia/Tokyo in docker-compose.yml (already default)
 *   - Or set TZ=Asia/Tokyo in .env
 *   - All schedule times will be interpreted in Japan time
 */

import { getSetting } from "./db.js";

import { resolveTimezone, partsInTimezone, dateInTimezone, instantForLocalTime } from '../shared/date-time.js';

export function getTimezone() {
  let configured;
  try { configured = getSetting('app_timezone'); } catch { /* DB not initialized yet. */ }
  return resolveTimezone(process.env.TZ, configured);
}

/**
 * Get current time in the configured timezone as a Date-like object.
 * Returns { year, month, date, hours, minutes, seconds, day }
 *
 * @param {Date} [date=new Date()] - Date to convert (defaults to now; injectable for testing)
 */
export function nowInTz(date = new Date()) {
  return partsInTimezone(date, getTimezone());
}

/**
 * Get today's date string in YYYY-MM-DD format in the configured timezone.
 */
export function todayStringInTz() {
  return dateInTimezone(new Date(), getTimezone());
}

/**
 * Get current time as HH:MM in the configured timezone.
 */
export function currentTimeInTz() {
  const { hours, minutes } = nowInTz();
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Get the current day-of-week (0=Sunday) in the configured timezone.
 */
export function currentDayInTz() {
  return nowInTz().day;
}

/**
 * Calculate milliseconds from now until a target HH:MM time today (in configured TZ).
 * Returns negative if the time has already passed.
 */
export function msUntilTimeInTz(timeStr) {
  const now = new Date();
  const tz = getTimezone();
  return instantForLocalTime(dateInTimezone(now, tz), timeStr, tz, now).getTime() - now.getTime();
}
