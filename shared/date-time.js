/** @param {unknown} value */
export function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** @param {unknown} value */
export function isTimeString(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** @param {string} value */
export function timeToMinutes(value) {
  if (!isTimeString(value)) throw new RangeError('Time must be HH:mm');
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/** @param {number} value */
export function minutesToTime(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 1440) throw new RangeError('Time is outside the day');
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** @param {string | undefined | null} envTZ @param {string | undefined | null} settingTZ */
export function resolveTimezone(envTZ, settingTZ) {
  const timezone = envTZ || settingTZ || 'Asia/Tokyo';
  // Invalid operator configuration must be visible, never silently use host time.
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  return timezone;
}

/** @param {Date} date @param {string} timezone */
export function partsInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const get = (/** @type {Intl.DateTimeFormatPartTypes} */ type) => parts.find(p => p.type === type)?.value || '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { year: Number(get('year')), month: Number(get('month')), date: Number(get('day')),
    hours: Number(get('hour')), minutes: Number(get('minute')), seconds: Number(get('second')),
    day: days.indexOf(get('weekday')) };
}

/** @param {Date} date @param {string} timezone */
export function dateInTimezone(date, timezone) {
  const p = partsInTimezone(date, timezone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.date).padStart(2, '0')}`;
}

/** Resolve a wall time using actual timezone offsets, including DST gaps/folds.
 * @param {string} date @param {string} time @param {string} timezone @param {Date} [now]
 */
export function instantForLocalTime(date, time, timezone, now = new Date()) {
  if (!isDateString(date) || !isTimeString(time)) throw new RangeError('Invalid local date or time');
  const nominal = Date.parse(`${date}T${time}:00.000Z`);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = nominal + hours * 3600000;
    const p = partsInTimezone(new Date(probe), timezone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.date, p.hours, p.minutes, p.seconds) - probe);
  }
  const matches = [...offsets].map(offset => nominal - offset).filter(instant => {
    const p = partsInTimezone(new Date(instant), timezone);
    return dateInTimezone(new Date(instant), timezone) === date &&
      p.hours * 60 + p.minutes === timeToMinutes(time);
  }).sort((a, b) => a - b);
  if (matches.length === 0) {
    const error = new RangeError('Scheduled wall time does not exist in the configured timezone');
    Object.assign(error, { code: 'SCHEDULE_TIME_NONEXISTENT' });
    throw error;
  }
  return new Date(matches.find(instant => instant >= now.getTime()) ?? matches[matches.length - 1]);
}
