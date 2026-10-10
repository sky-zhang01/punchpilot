import { describe, expect, it } from 'vitest';
import { formatLogTimestamp, businessDate, businessMinutes } from './date-time';

describe('business dates and recorded log timestamps', () => {
  it('uses the configured timezone across UTC midnight independently of browser timezone', () => {
    const instant = new Date('2026-10-04T15:30:00Z');
    expect(businessDate('Asia/Tokyo', instant)).toBe('2026-10-05');
    expect(businessMinutes('Asia/Tokyo', instant)).toBe(30);
    expect(formatLogTimestamp(instant.toISOString(), 'Asia/Tokyo')).toEqual({ date: '2026-10-05', time: '00:30:00', hasTimezone: true });
  });
  it('never guesses an instant for historical no-offset timestamps', () => {
    expect(formatLogTimestamp('2026-10-04 23:05:12', 'America/New_York')).toEqual({ date: '2026-10-04', time: '23:05:12', hasTimezone: false });
  });
  it('uses actual DST offsets for timestamp display', () => {
    expect(formatLogTimestamp('2026-11-01T05:30:00Z', 'America/New_York').time).toBe('01:30:00');
    expect(formatLogTimestamp('2026-11-01T06:30:00Z', 'America/New_York').time).toBe('01:30:00');
  });
});
