/**
 * Unit tests for determineActionsForToday() — Smart Action Planning
 *
 * Tests the redesigned independent action evaluation logic that handles
 * all combinations of manual/automatic actions, work duration-based break
 * necessity (Japanese Labor Standards Act Art. 34), and edge cases.
 *
 * 14 use cases covering:
 * - Normal full-day automation (UC1)
 * - Early manual checkin (UC2)
 * - Manual checkout before break (UC3)
 * - Missed checkin window (UC4)
 * - Late manual checkin, short work (UC5)
 * - Late manual checkin, enough work (UC6)
 * - On break, normal (UC7)
 * - On break, overtime >60min (UC8)
 * - Manual break_start, auto break_end (UC9)
 * - All manual except checkout (UC10)
 * - Checked out state (UC11)
 * - Unknown state (UC12)
 * - Quick checkin-checkout (UC13)
 * - Re-checkin scenario (UC14)
 */

import { describe, it, expect } from 'vitest';
import { determineActionsForToday } from '../server/automation.js';

const FULL_SCHEDULE = {
  checkin: '09:00',
  break_start: '12:00',
  break_end: '13:00',
  checkout: '18:00',
};

describe('determineActionsForToday - Smart Action Planning', () => {

  // UC1: Normal full-day automation
  it('UC1: schedules all actions when not checked in and within checkin window', () => {
    const result = determineActionsForToday(
      'not_checked_in',
      FULL_SCHEDULE,
      [],          // no punch times
      '08:50'      // before checkin
    );
    expect(result.execute).toEqual(['checkin', 'break_start', 'break_end', 'checkout']);
    expect(result.skip).toEqual([]);
    expect(result.immediateActions).toEqual([]);
  });

  // UC2: User manually checked in early, remaining auto actions continue
  it('UC2: skips checkin, schedules break + checkout when already working (early manual checkin)', () => {
    const result = determineActionsForToday(
      'working',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '08:30' }],
      '08:50'
    );
    expect(result.execute).toEqual(['break_start', 'break_end', 'checkout']);
    expect(result.skip).toEqual(['checkin']);
    expect(result.immediateActions).toEqual([]);
    // expectedWork = 18:00 - 08:30 = 570min >= 361 → breakNeeded
    expect(result.reason).toContain('Scheduling');
  });

  // UC3: User manually checked out before break
  it('UC3: skips all actions when already checked out', () => {
    const result = determineActionsForToday(
      'checked_out',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '09:00' }, { type: 'checkout', time: '11:30' }],
      '11:35'
    );
    expect(result.execute).toEqual([]);
    expect(result.skip).toEqual(['checkin', 'break_start', 'break_end', 'checkout']);
    expect(result.immediateActions).toEqual([]);
  });

  // UC4: Checkin window passed, skip everything
  it('UC4: skips all when checkin window has passed (>5min late)', () => {
    const result = determineActionsForToday(
      'not_checked_in',
      FULL_SCHEDULE,
      [],
      '10:00'   // >5min past 09:00
    );
    expect(result.execute).toEqual([]);
    expect(result.skip).toEqual(['checkin', 'break_start', 'break_end', 'checkout']);
    expect(result.reason).toContain('Checkin window passed');
  });

  // UC5: Late manual checkin, work time short (<361min), no break needed
  it('UC5: skips break when expected work time < 361min (labor law: ≤6h = no break)', () => {
    const result = determineActionsForToday(
      'working',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '13:00' }],
      '13:05'
    );
    // expectedWork = 18:00 - 13:00 = 300min < 361 → breakNeeded = false
    expect(result.execute).toEqual(['checkout']);
    expect(result.skip).toEqual(['checkin', 'break_start', 'break_end']);
    expect(result.reason).toContain('361');
  });

  // UC6: Late manual checkin, work time sufficient (>=361min), break needed
  it('UC6: schedules break when expected work time >= 361min (labor law: >6h = break needed)', () => {
    const result = determineActionsForToday(
      'working',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '10:30' }],
      '10:35'
    );
    // expectedWork = 18:00 - 10:30 = 450min >= 361 → breakNeeded = true
    expect(result.execute).toEqual(['break_start', 'break_end', 'checkout']);
    expect(result.skip).toEqual(['checkin']);
  });

  // UC7: On break, break_end scheduled normally
  it('UC7: schedules break_end and checkout when on break (normal duration)', () => {
    const result = determineActionsForToday(
      'on_break',
      { ...FULL_SCHEDULE },
      [{ type: 'checkin', time: '09:00' }, { type: 'break_start', time: '12:05' }],
      '12:30'
    );
    expect(result.execute).toEqual(['break_end', 'checkout']);
    expect(result.skip).toEqual(['checkin', 'break_start']);
    expect(result.immediateActions).toEqual([]);
  });

  // UC8: On break, overtime >60min → immediate break_end
  it('UC8: triggers immediate break_end when break exceeds 60 minutes', () => {
    const result = determineActionsForToday(
      'on_break',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '09:00' }, { type: 'break_start', time: '11:00' }],
      '12:30'
    );
    // Break started at 11:00, now 12:30 → 90min > 60min
    expect(result.immediateActions).toEqual(['break_end']);
    expect(result.execute).toEqual(['checkout']);
    expect(result.skip).toEqual(['checkin', 'break_start']);
  });

  // UC9: User manually started break, auto break_end + checkout
  it('UC9: skips break_start (already done), schedules break_end and checkout', () => {
    const result = determineActionsForToday(
      'on_break',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '09:00' }, { type: 'break_start', time: '11:50' }],
      '12:00'
    );
    expect(result.execute).toEqual(['break_end', 'checkout']);
    expect(result.skip).toEqual(['checkin', 'break_start']);
    expect(result.immediateActions).toEqual([]);
  });

  // UC10: All manual except checkout
  it('UC10: only schedules checkout when checkin + break are all completed', () => {
    const result = determineActionsForToday(
      'working',
      { checkout: '18:00' },
      [
        { type: 'checkin', time: '08:30' },
        { type: 'break_start', time: '12:00' },
        { type: 'break_end', time: '12:45' },
      ],
      '12:50'
    );
    expect(result.execute).toEqual(['checkout']);
    expect(result.skip).toEqual(['checkin', 'break_start', 'break_end']);
  });

  // UC11: Checked out state (auto disabled handled by scheduler, not this function)
  it('UC11: skips everything when checked out', () => {
    const result = determineActionsForToday(
      'checked_out',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '09:00' }, { type: 'checkout', time: '18:00' }],
      '18:05'
    );
    expect(result.execute).toEqual([]);
    expect(result.skip).toEqual(['checkin', 'break_start', 'break_end', 'checkout']);
  });

  // UC12: Unknown state — skip all for safety
  it('UC12: skips all actions when state is unknown', () => {
    const result = determineActionsForToday(
      'unknown',
      FULL_SCHEDULE,
      [],
      '09:00'
    );
    // Unknown state: checkin window ok but state unknown → checkin skipped (not not_checked_in)
    // No checkin → no checkout; break not needed (no checkin); break_end not needed (no break_start)
    expect(result.execute).toEqual([]);
    expect(result.skip.length).toBe(4);
  });

  // UC13: Quick checkin-checkout (<1h work)
  it('UC13: skips everything after quick checkin and checkout', () => {
    const result = determineActionsForToday(
      'checked_out',
      FULL_SCHEDULE,
      [{ type: 'checkin', time: '09:00' }, { type: 'checkout', time: '09:30' }],
      '09:35'
    );
    expect(result.execute).toEqual([]);
    expect(result.skip).toEqual(['checkin', 'break_start', 'break_end', 'checkout']);
  });

  // UC14: Re-checkin scenario (checkout then checkin again)
  it('UC14: handles re-checkin by using last checkin time for work duration', () => {
    const result = determineActionsForToday(
      'working',
      FULL_SCHEDULE,
      [
        { type: 'checkin', time: '09:00' },
        { type: 'checkout', time: '10:00' },
        { type: 'checkin', time: '10:30' },
      ],
      '10:35'
    );
    // effectiveCheckin = 10:30 (last), expectedWork = 18:00 - 10:30 = 450min >= 361
    expect(result.execute).toEqual(['break_start', 'break_end', 'checkout']);
    expect(result.skip).toEqual(['checkin']);
  });

  // --- Edge case tests ---

  it('handles empty schedule gracefully', () => {
    const result = determineActionsForToday('not_checked_in', {}, [], '09:00');
    // No checkin time in schedule → checkin passes the window check (no time to compare)
    // but no checkout in schedule → expectedWorkMinutes = null → breakNeeded = false
    expect(result.skip).toContain('break_start');
    expect(result.skip).toContain('break_end');
  });

  it('backward compatible: works with only 2 arguments (old call signature)', () => {
    // When todayPunchTimes is not provided, defaults to []
    // This test uses a fixed time to avoid flaky results
    const result = determineActionsForToday('checked_out', FULL_SCHEDULE);
    expect(result.execute).toEqual([]);
    expect(result.skip).toEqual(['checkin', 'break_start', 'break_end', 'checkout']);
    expect(result.reason).toContain('checked out');
  });

  it('exactly 361min work triggers break', () => {
    // checkin at 12:00, checkout at 18:01 → 361min
    const schedule = { ...FULL_SCHEDULE, checkout: '18:01' };
    const result = determineActionsForToday(
      'working',
      schedule,
      [{ type: 'checkin', time: '12:00' }],
      '12:05'
    );
    // expectedWork = 18:01 - 12:00 = 361min = threshold → breakNeeded = true
    expect(result.execute).toContain('break_start');
    expect(result.execute).toContain('break_end');
  });

  it('exactly 360min work does NOT trigger break', () => {
    const schedule = { ...FULL_SCHEDULE, checkout: '18:00' };
    const result = determineActionsForToday(
      'working',
      schedule,
      [{ type: 'checkin', time: '12:00' }],
      '12:05'
    );
    // expectedWork = 18:00 - 12:00 = 360min < 361 → breakNeeded = false
    expect(result.skip).toContain('break_start');
    expect(result.skip).toContain('break_end');
    expect(result.execute).toEqual(['checkout']);
  });
});
