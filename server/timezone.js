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

import { getSetting } from './db.js';

const DEFAULT_TZ = 'Asia/Tokyo';

/**
 * Get the configured timezone string.
 * Priority: TZ env > DB setting 'app_timezone' > default Asia/Tokyo
 */
export function getTimezone() {
  return process.env.TZ || getSetting('app_timezone') || DEFAULT_TZ;
}

/**
 * Get current time in the configured timezone as a Date-like object.
 * Returns { year, month, date, hours, minutes, seconds, day }
 */
export function nowInTz() {
  const tz = getTimezone();
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';

  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

  return {
    year: parseInt(get('year')),
    month: parseInt(get('month')),
    date: parseInt(get('day')),
    hours: parseInt(get('hour')),
    minutes: parseInt(get('minute')),
    seconds: parseInt(get('second')),
    day: dayMap[get('weekday')] ?? new Date().getDay(),
  };
}

/**
 * Get today's date string in YYYY-MM-DD format in the configured timezone.
 */
export function todayStringInTz() {
  const { year, month, date } = nowInTz();
  return `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

/**
 * Get current time as HH:MM in the configured timezone.
 */
export function currentTimeInTz() {
  const { hours, minutes } = nowInTz();
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
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
  const { hours, minutes, seconds } = nowInTz();
  const [targetH, targetM] = timeStr.split(':').map(Number);

  const nowMinutesTotal = hours * 60 + minutes;
  const targetMinutesTotal = targetH * 60 + targetM;

  // Difference in minutes, then subtract elapsed seconds in current minute
  const diffMinutes = targetMinutesTotal - nowMinutesTotal;
  const diffMs = diffMinutes * 60 * 1000 - seconds * 1000;

  return diffMs;
}
