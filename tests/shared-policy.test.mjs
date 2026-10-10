import { describe, expect, it } from 'vitest';
import { dateInTimezone, isDateString, isTimeString, instantForLocalTime } from '../shared/date-time.js';
import { resolveBreakTimes } from '../shared/schedule-policy.js';
import { parseExternalId } from '../server/freee-values.js';
import { isEditableWorkRecord } from '../server/work-record-status.js';

describe('business dates and external value boundaries', () => {
  it('labels a single instant using the business timezone', () => {
    const instant = new Date('2026-01-31T16:00:00Z');
    expect(dateInTimezone(instant, 'Asia/Tokyo')).toBe('2026-02-01');
    expect(dateInTimezone(instant, 'America/New_York')).toBe('2026-01-31');
  });
  it('uses elapsed instants across DST and rejects a nonexistent wall time', () => {
    const now = new Date('2026-03-08T06:30:00Z');
    expect(instantForLocalTime('2026-03-08', '03:30', 'America/New_York', now).getTime() - now.getTime()).toBe(3600000);
    expect(() => instantForLocalTime('2026-03-08', '02:30', 'America/New_York', now)).toThrow(/does not exist/);
    expect(instantForLocalTime('2026-11-01', '01:30', 'America/New_York', new Date('2026-11-01T06:00:00Z')).toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });
  it('rejects coercion, invalid calendar dates and prototype identifiers', () => {
    for (const value of [true, ['7'], {}, '1e2', '007', ' 7 ', 1.5, Number.MAX_SAFE_INTEGER + 1, 'constructor']) expect(parseExternalId(value)).toBeNull();
    expect(parseExternalId('7')).toBe(7);
    expect(parseExternalId(7)).toBe(7);
    expect(isDateString('2026-02-29')).toBe(false);
    expect(isDateString('2028-02-29')).toBe(true);
    expect(isTimeString(['09:00'])).toBe(false);
    expect(isTimeString('24:00')).toBe(false);
  });
  it('requires explicit editability for the requested record', () => {
    for (const record of [{}, { date: '2026-10-04' }, { date: '2026-10-03', is_editable: true }, { date: '2026-10-04', is_editable: 1 }]) expect(isEditableWorkRecord(record, '2026-10-04')).toBe(false);
    expect(isEditableWorkRecord({ date: '2026-10-04T00:00:00+09:00', is_editable: true }, '2026-10-04')).toBe(true);
  });
});

describe('joint break selection', () => {
  const config = (start, end) => ({ mode: 'random', window_start: start, window_end: end, fixed_time: start });
  it('chooses a feasible start instead of clamping the end outside its window', () => {
    expect(resolveBreakTimes(config('12:00', '12:50'), config('13:00', '13:20'), {}, () => 0.999)).toEqual({ start: '12:20', end: '13:20' });
  });
  it('preserves an executed start, refusing an incompatible new end window', () => {
    expect(resolveBreakTimes(config('12:00', '12:50'), config('13:00', '13:20'), { start: '12:50' })).toBeNull();
    expect(resolveBreakTimes(config('12:00', '12:50'), config('13:00', '14:00'), { start: '12:50' }, () => 0)).toEqual({ start: '12:50', end: '13:50' });
  });
});
