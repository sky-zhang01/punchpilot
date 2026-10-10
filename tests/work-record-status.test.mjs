import { describe, expect, it } from 'vitest';
import {
  getWorkRecordLeaveCoverage,
  getWorkRecordNonWorkingDayStatus,
  hasWorkRecordClockTimes,
  workRecordMatchesDate,
} from '../server/work-record-status.js';

describe('work record non-working day status', () => {
  it('treats full-day paid holiday as a non-working day', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      date: '2026-05-18',
      paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
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
      paid_holidays: [
        { type: 'half', days: 0.5, mins: 240 },
        { type: 'hourly', days: 0, mins: 240 },
      ],
      normal_work_mins: 480,
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'paid_holiday_minutes',
    });
  });

  it('does not treat half-day paid holiday as a full-day skip', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      date: '2026-05-18',
      paid_holidays: [{ type: 'half', days: 0.5, mins: 240 }],
      normal_work_mins: 480,
    });

    expect(status.isNonWorkingDay).toBe(false);
  });

  it.each([
    {},
    { date: '2026-05-18' },
    { normal_work_mins: 480, paid_holidays: [] },
    { paid_holidays: 'schema-drift' },
    { paid_holidays: [{ type: 'full', days: 'one', mins: 0 }] },
    { normal_work_mins: -1 },
    { is_absence: 'true' },
    { work_record_segments: [{ clock_in_at: 930 }] },
  ])('marks malformed status-bearing work records unconfirmed: %j', (record) => {
    expect(getWorkRecordNonWorkingDayStatus(record)).toMatchObject({
      confirmed: false,
      isNonWorkingDay: false,
      code: 'work_record_unconfirmed',
    });
  });

  it('confirms a working day only from a complete current response shape', () => {
    expect(getWorkRecordNonWorkingDayStatus({
      normal_work_mins: 480,
      is_absence: false,
      special_holiday: 0,
      half_special_holiday_mins: 0,
      hourly_special_holiday_mins: 0,
      paid_holidays: [],
      day_pattern: 'normal_day',
      schedule_pattern: '',
      clock_in_at: null,
      clock_out_at: null,
      work_record_segments: [],
      break_records: [],
    })).toMatchObject({
      confirmed: true,
      isNonWorkingDay: false,
      code: null,
    });
  });

  it('reports partial paid and special leave coverage without treating it as absent', () => {
    expect(
      getWorkRecordLeaveCoverage({
        paid_holidays: [{ type: 'hourly', days: 0, mins: 60 }],
      }),
    ).toEqual({
      hasPaidLeave: true,
      hasSpecialLeave: false,
      hasAnyLeave: true,
    });
    expect(
      getWorkRecordLeaveCoverage({ half_special_holiday_mins: 240 }),
    ).toEqual({
      hasPaidLeave: false,
      hasSpecialLeave: true,
      hasAnyLeave: true,
    });
  });

  it('treats absence and special holiday as non-working days', () => {
    expect(getWorkRecordNonWorkingDayStatus({ is_absence: true })).toMatchObject({
      isNonWorkingDay: true,
      code: 'absence',
    });
    expect(getWorkRecordNonWorkingDayStatus({ special_holiday: 1 })).toMatchObject({
      isNonWorkingDay: true,
      code: 'special_holiday',
    });
  });

  it('combines paid leave entries that together cover a full day', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      normal_work_mins: 480,
      paid_holidays: [
        { type: 'morning_off', days: 0.5, mins: 240 },
        { type: 'afternoon_off', days: 0.5, mins: 240 },
      ],
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'paid_holiday',
    });
  });

  it('does not treat a half-day special holiday as a full-day skip', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      normal_work_mins: 480,
      special_holiday: 0.5,
      half_special_holiday_mins: 240,
    });

    expect(status.isNonWorkingDay).toBe(false);
  });

  it('combines paid and special leave coverage across the full work day', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      normal_work_mins: 480,
      paid_holidays: [{ type: 'half', days: 0.5, mins: 240 }],
      special_holiday: 0.5,
      half_special_holiday_mins: 240,
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'combined_full_day_leave',
    });
  });

  it('does not combine partial leave that leaves working time uncovered', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      normal_work_mins: 480,
      paid_holidays: [{ type: 'hourly', days: 0, mins: 60 }],
      half_special_holiday_mins: 240,
    });

    expect(status.isNonWorkingDay).toBe(false);
  });

  it('keeps compatibility with the legacy aggregate paid-leave fields', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      normal_work_mins: 480,
      normal_work_mins_by_paid_holiday: 480,
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'paid_holiday_minutes',
    });
  });

  it('keeps company non-working day patterns from scheduling punches', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      day_pattern: 'prescribed_holiday',
      clock_in_at: null,
      clock_out_at: null,
      work_record_segments: [],
      break_records: [],
    });

    expect(status).toMatchObject({
      isNonWorkingDay: true,
      code: 'non_working_day_pattern',
    });
  });

  it('recognizes current schedule_pattern non-working days', () => {
    for (const schedulePattern of [
      'substitute_holiday',
      'compensatory_holiday',
      'special_holiday',
    ]) {
      expect(
        getWorkRecordNonWorkingDayStatus({
          day_pattern: 'normal_day',
          schedule_pattern: schedulePattern,
          clock_in_at: null,
          clock_out_at: null,
          work_record_segments: [],
          break_records: [],
        }),
      ).toMatchObject({
        isNonWorkingDay: true,
        code: 'non_working_day_pattern',
      });
    }
  });

  it('does not skip when a company holiday pattern already has clock records', () => {
    const status = getWorkRecordNonWorkingDayStatus({
      day_pattern: 'prescribed_holiday',
      clock_in_at: '2026-05-18T09:30:00+09:00',
    });

    expect(status.isNonWorkingDay).toBe(false);
  });

  it('detects clock data in current multi-segment work records', () => {
    expect(
      hasWorkRecordClockTimes({
        work_record_segments: [
          {
            clock_in_at: '2026-05-18 09:30:00',
            clock_out_at: '2026-05-18 18:00:00',
          },
        ],
      }),
    ).toBe(true);
  });

  it('accepts only the requested date in date and date-time response forms', () => {
    expect(workRecordMatchesDate({ date: '2026-05-18' }, '2026-05-18')).toBe(true);
    expect(
      workRecordMatchesDate(
        { date: '2026-05-18T00:00:00+09:00' },
        '2026-05-18',
      ),
    ).toBe(true);
    expect(workRecordMatchesDate({ date: '2026-05-180' }, '2026-05-18')).toBe(false);
    expect(workRecordMatchesDate({ date: '2026-05-19' }, '2026-05-18')).toBe(false);
  });
});
