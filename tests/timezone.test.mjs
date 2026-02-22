/**
 * Regression tests for timezone.js — midnight hour boundary bug
 *
 * Bug (Linux/Docker): Intl.DateTimeFormat with `hour12: false` returns hour=24
 * at midnight instead of hour=0, because on Linux the default hourCycle is h24
 * rather than h23. This caused `curMin = 24*60+xx = 1440+` which falsely
 * triggered "Checkin window passed" at 00:xx JST on container startup.
 *
 * Fix: Use `hourCycle: 'h23'` explicitly (0–23, midnight = 0).
 *
 * Reference: Container logs 2026-02-18 15:44 UTC = 2026-02-19 00:44 JST
 *   [Scheduler] State: not_checked_in -> Checkin window passed - skipping today
 *   (checkin was 09:51, but curMin was 1484 because hours=24 on Linux)
 */

import { describe, it, expect, beforeAll } from 'vitest';

// 2026-02-18 15:00:00 UTC = 2026-02-19 00:00:00 JST (midnight)
const MIDNIGHT_JST = new Date('2026-02-18T15:00:00Z');
// 2026-02-18 15:44:00 UTC = 2026-02-19 00:44:00 JST (container startup time on Feb 19)
const STARTUP_JST = new Date('2026-02-18T15:44:00Z');
// 2026-02-19 00:51:00 UTC = 2026-02-19 09:51:00 JST (scheduled checkin time)
const CHECKIN_JST = new Date('2026-02-19T00:51:00Z');
// 2026-02-18 14:59:00 UTC = 2026-02-18 23:59:00 JST
const NEAR_MIDNIGHT_JST = new Date('2026-02-18T14:59:00Z');

const TZ = 'Asia/Tokyo';

/**
 * Parse hour from Intl.DateTimeFormat parts (helper for direct Intl tests)
 */
function parseHour(date, options) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...options }).formatToParts(date);
  return parseInt(parts.find((p) => p.type === 'hour')?.value ?? '-1');
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: Direct Intl.DateTimeFormat behavior tests (no project imports)
// These verify the fix at the Intl level and document the platform difference.
// ─────────────────────────────────────────────────────────────────────────────
describe('Intl.DateTimeFormat - midnight hour boundary', () => {
  it('hourCycle h23 returns 0 for midnight (not 24)', () => {
    const hour = parseHour(MIDNIGHT_JST, { hour: '2-digit', hourCycle: 'h23' });
    expect(hour).toBe(0);
  });

  it('hourCycle h23 returns 0 at 00:44 JST (startup scenario)', () => {
    const hour = parseHour(STARTUP_JST, { hour: '2-digit', hourCycle: 'h23' });
    expect(hour).toBe(0);
  });

  it('curMin at 00:44 JST with h23 is 44, not 1484', () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(STARTUP_JST);
    const hours = parseInt(parts.find((p) => p.type === 'hour')?.value);
    const minutes = parseInt(parts.find((p) => p.type === 'minute')?.value);
    const curMin = hours * 60 + minutes;
    // With bug (h24): curMin = 24*60+44 = 1484 > toMin('09:51')+5 = 596 → skips all
    // After fix (h23): curMin = 0*60+44 = 44 < 596 → correctly schedules actions
    expect(curMin).toBe(44);
    expect(curMin).toBeLessThan(596); // must NOT trigger "Checkin window passed"
  });

  it('hourCycle h23 returns 23 at 23:59 JST (not 0)', () => {
    const hour = parseHour(NEAR_MIDNIGHT_JST, { hour: '2-digit', hourCycle: 'h23' });
    expect(hour).toBe(23);
  });

  it('hourCycle h23 returns 9 at 09:51 JST (checkin time)', () => {
    const hour = parseHour(CHECKIN_JST, { hour: '2-digit', hourCycle: 'h23' });
    expect(hour).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: nowInTz() tests — requires process.env.TZ to avoid db.js load
// Set TZ env before dynamic import to short-circuit getTimezone() -> getSetting()
// ─────────────────────────────────────────────────────────────────────────────
describe('nowInTz() - midnight hour boundary fix', () => {
  let nowInTz;

  beforeAll(async () => {
    // Set TZ so getTimezone() returns early from process.env.TZ,
    // avoiding getSetting() -> db.js -> better-sqlite3 dependency
    process.env.TZ = 'Asia/Tokyo';
    ({ nowInTz } = await import('../server/timezone.js'));
  });

  it('returns hours=0 at midnight JST (not 24)', () => {
    const result = nowInTz(MIDNIGHT_JST);
    expect(result.hours).toBe(0);
    expect(result.minutes).toBe(0);
  });

  it('returns hours=0 at 00:44 JST (container startup scenario)', () => {
    const result = nowInTz(STARTUP_JST);
    expect(result.hours).toBe(0);
    expect(result.minutes).toBe(44);
    const curMin = result.hours * 60 + result.minutes;
    expect(curMin).toBe(44); // not 1484
  });

  it('returns correct date fields at midnight JST', () => {
    const result = nowInTz(MIDNIGHT_JST);
    // 2026-02-18 15:00:00 UTC = 2026-02-19 00:00:00 JST
    expect(result.year).toBe(2026);
    expect(result.month).toBe(2);
    expect(result.date).toBe(19);
  });

  it('returns correct weekday at midnight JST (Thursday = 4)', () => {
    // 2026-02-19 is Thursday
    const result = nowInTz(MIDNIGHT_JST);
    expect(result.day).toBe(4);
  });

  it('returns hours=23 at 23:59 JST', () => {
    const result = nowInTz(NEAR_MIDNIGHT_JST);
    expect(result.hours).toBe(23);
    expect(result.minutes).toBe(59);
  });

  it('hours is always in range 0-23 for all test cases', () => {
    for (const date of [MIDNIGHT_JST, STARTUP_JST, CHECKIN_JST, NEAR_MIDNIGHT_JST]) {
      const { hours } = nowInTz(date);
      expect(hours).toBeGreaterThanOrEqual(0);
      expect(hours).toBeLessThanOrEqual(23);
    }
  });
});
