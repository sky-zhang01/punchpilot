import { describe, expect, it } from 'vitest';
import { getWorkRecordNonWorkingDayStatus } from '../server/work-record-status.js';

describe('work record non-working day status', () => {
  it('treats full-day paid holiday as a non-working day', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      date: '2026-05-18',
      paid_holiday: 1,
      normal_work_mins: 480,
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'paid_holiday',
    });
  });

  it('treats paid holiday minutes covering normal work as a non-working day', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      date: '2026-05-18',
      paid_holiday: 0,
      normal_work_mins: 480,
      normal_work_mins_by_paid_holiday: 480,
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'paid_holiday_minutes',
    });
  });

  it('does not treat half-day paid holiday as a full-day skip', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      date: '2026-05-18',
      paid_holiday: 0.5,
      normal_work_mins: 480,
      normal_work_mins_by_paid_holiday: 240,
    });

    expect(status.isNonWorkingDay).toBe(false);
  });

  it('treats absence and special holiday as non-working days', () => {
    expect(getWorkRecordNonWorkingDayStatus({ is_absence: true })).toMatchObject({
      isNonWorkingDay: true,
      code: 'absence',
    });
    expect(getWorkRecordNonWorkingDayStatus({ special_holiday: true })).toMatchObject({
      isNonWorkingDay: true,
      code: 'special_holiday',
    });
  });

  it('keeps company non-working day patterns from scheduling punches', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      day_pattern: 'prescribed_holiday',
      clock_in_at: null,
      clock_out_at: null,
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'non_working_day_pattern',
    });
  });

  it('does not skip when a company holiday pattern already has clock records', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      day_pattern: 'prescribed_holiday',
      clock_in_at: '2026-05-18T09:30:00+09:00',
    });

    expect(status.isNonWorkingDay).toBe(false);
  });
});
