import { describe, expect, it } from 'vitest';
import { mapWorkRecordForClient } from '../server/routes/attendance/records.js';

describe('attendance record client mapping', () => {
  it('exposes current-schema full-day paid leave as a non-working day', () => {
    expect(mapWorkRecordForClient({
      date: '2026-05-18',
      normal_work_mins: 480,
      paid_holidays: [{ type: 'full', days: 1, mins: 480 }],
      break_records: [],
    })).toMatchObject({
      paid_holiday: 1,
      has_leave: true,
      is_non_working_day: true,
      non_working_day_code: 'paid_holiday',
    });
  });

  it('keeps partial leave visible without treating it as a full-day punch skip', () => {
    expect(mapWorkRecordForClient({
      date: '2026-05-19',
      normal_work_mins: 480,
      is_absence: false,
      special_holiday: 0,
      half_special_holiday_mins: 0,
      hourly_special_holiday_mins: 0,
      paid_holidays: [{ type: 'half', days: 0.5, mins: 240 }],
      day_pattern: 'normal_day',
      schedule_pattern: '',
      clock_in_at: null,
      clock_out_at: null,
      work_record_segments: [],
      break_records: [],
    })).toMatchObject({
      paid_holiday: 0.5,
      has_leave: true,
      is_non_working_day: false,
      non_working_day_code: null,
    });
  });

  it('marks schedule-pattern records with malformed break data unconfirmed', () => {
    expect(mapWorkRecordForClient({
      date: '2026-05-20',
      day_pattern: 'normal_day',
      schedule_pattern: 'substitute_holiday',
      break_records: { invalid: true },
    })).toMatchObject({
      schedule_pattern: 'substitute_holiday',
      has_leave: false,
      is_non_working_day: false,
      non_working_day_code: 'work_record_unconfirmed',
      break_records: [],
    });
  });
});
