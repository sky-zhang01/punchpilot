import { dateInTimezone, partsInTimezone, resolveTimezone } from '../../../shared/date-time.js';

export function businessDate(timezone?: string, now = new Date()) {
  return dateInTimezone(now, resolveTimezone(undefined, timezone));
}
export function businessMinutes(timezone?: string, now = new Date()) {
  const parts = partsInTimezone(now, resolveTimezone(undefined, timezone));
  return parts.hours * 60 + parts.minutes;
}
export function formatLogTimestamp(value: string | null | undefined, timezone?: string) {
  if (!value) return { date: '-', time: '-', hasTimezone: false };
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  if (!hasTimezone) {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(value);
    return { date: match?.[1] || value, time: match?.[2] || value, hasTimezone: false };
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return { date: value, time: value, hasTimezone: true };
  const zone = resolveTimezone(undefined, timezone);
  const parts = partsInTimezone(instant, zone);
  return {
    date: dateInTimezone(instant, zone),
    time: [parts.hours, parts.minutes, parts.seconds].map(part => String(part).padStart(2, '0')).join(':'),
    hasTimezone: true,
  };
}
