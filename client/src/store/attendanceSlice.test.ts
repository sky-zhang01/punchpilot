import { describe, expect, it } from 'vitest';
import reducer, {
  fetchAttendance,
  fetchApprovalRequests,
  isAttendanceNonWorking,
  isMissingPunch,
  missingPunchContext,
  selectAllMissingDates,
  type AttendanceRecord,
} from './attendanceSlice';

function record(overrides: Partial<AttendanceRecord>): AttendanceRecord {
  return {
    date: '2026-05-18',
    clock_in: null,
    clock_out: null,
    day_pattern: 'normal_day',
    schedule_pattern: '',
    is_holiday: false,
    is_absence: false,
    is_editable: true,
    is_non_working_day: false,
    non_working_day_code: null,
    has_leave: false,
    total_work_mins: 480,
    total_overtime_mins: 0,
    lateness_mins: 0,
    early_leaving_mins: 0,
    paid_holiday: 0,
    note: '',
    break_records: [],
    ...overrides,
  };
}

describe('attendance non-working selection guard', () => {
  it('recognizes the normalized server guard fields', () => {
    expect(isAttendanceNonWorking(record({ is_non_working_day: true }))).toBe(true);
    expect(isAttendanceNonWorking(record({ is_absence: true }))).toBe(true);
    expect(isAttendanceNonWorking(record({ is_holiday: true }))).toBe(true);
    expect(isAttendanceNonWorking(record({}))).toBe(false);
  });

  it('does not bulk-select an approved full-day leave as a missing punch', () => {
    let state = reducer(undefined, { type: 'init' });
    state = reducer(state, { type: 'attendance/setYearMonth', payload: { year: 2026, month: 5 } });
    state = reducer(state, fetchAttendance.pending('request-id', { year: 2026, month: 5 }));
    state = reducer(state, fetchAttendance.fulfilled({
      records: [
        record({ date: '2026-05-18' }),
        record({
          date: '2026-05-19',
          has_leave: true,
          is_non_working_day: true,
          non_working_day_code: 'paid_holiday',
          paid_holiday: 1,
        }),
      ],
      summary: null,
      year: 2026,
      month: 5,
    }, 'request-id', { year: 2026, month: 5 }));

    state = reducer(state, selectAllMissingDates());

    expect(state.selectedDates).toEqual(['2026-05-18']);
  });

  it('retains approval requests with the same date and numeric id across resource types', () => {
    let state = reducer(undefined, { type: 'init' });
    state = reducer(state, { type: 'attendance/setYearMonth', payload: { year: 2026, month: 5 } });
    state = reducer(state, fetchApprovalRequests.pending('approval-request', { year: 2026, month: 5 }));
    state = reducer(state, fetchApprovalRequests.fulfilled([
      {
        id: 42,
        type: 'WorkTime',
        status: 'in_progress',
        target_date: '2026-05-18',
        work_records: [],
        break_records: [],
        comment: '',
        request_number: null,
        created_at: null,
      },
      {
        id: 42,
        type: 'PaidHoliday',
        status: 'approved',
        target_date: '2026-05-18',
        work_records: [],
        break_records: [],
        comment: '',
        request_number: null,
        created_at: null,
      },
    ], 'approval-request', { year: 2026, month: 5 }));

    expect(state.approvalRequests['2026-05-18'].map((request) => request.type))
      .toEqual(['WorkTime', 'PaidHoliday']);
  });

  it('ignores an attendance response for a month that is no longer selected', () => {
    let state = reducer(undefined, { type: 'init' });
    state = reducer(state, { type: 'attendance/setYearMonth', payload: { year: 2026, month: 5 } });
    state = reducer(state, fetchAttendance.pending('may-request', { year: 2026, month: 5 }));
    state = reducer(state, { type: 'attendance/setYearMonth', payload: { year: 2026, month: 6 } });
    state = reducer(state, fetchAttendance.fulfilled({
      records: [record({ date: '2026-05-18' })],
      summary: null,
      year: 2026,
      month: 5,
    }, 'may-request', { year: 2026, month: 5 }));

    expect(state.year).toBe(2026);
    expect(state.month).toBe(6);
    expect(state.records).toEqual({});
  });

  it('uses the same today gate for individual and bulk missing-punch selection', () => {
    const schedules = [{ action_type: 'checkin', mode: 'random' as const, fixed_time: '09:00', window_end: '10:00' }];
    const status = { timezone: 'Asia/Tokyo', attendance_state: 'not_checked_in' };
    const context = missingPunchContext(schedules, status, new Date('2026-05-19T00:30:00Z'));
    expect(isMissingPunch('2026-05-19', record({ date: '2026-05-19' }), [], context)).toBe(false);
    expect(isMissingPunch('2026-05-18', record({}), [], context)).toBe(true);
    const before = { ...reducer(undefined, { type: 'init' }), records: { '2026-05-18': record({}), '2026-05-19': record({ date: '2026-05-19' }) } };
    expect(reducer(before, selectAllMissingDates(context)).selectedDates).toEqual(['2026-05-18']);
    const afterWindow = missingPunchContext(schedules, status, new Date('2026-05-19T01:00:00Z'));
    expect(reducer(before, selectAllMissingDates(afterWindow)).selectedDates).toEqual(['2026-05-18', '2026-05-19']);
    const activity = missingPunchContext(schedules, { ...status, today_logs: [{ action_type: 'checkin', status: 'success' }] }, new Date('2026-05-19T02:00:00Z'));
    expect(reducer(before, selectAllMissingDates(activity)).selectedDates).toEqual(['2026-05-18']);
    const manualPunch = missingPunchContext(schedules, { ...status, attendance_state: 'working' }, new Date('2026-05-19T02:00:00Z'));
    expect(reducer(before, selectAllMissingDates(manualPunch)).selectedDates).toEqual(['2026-05-18']);
  });

  it('does not accept the previous identity even when the month still matches', () => {
    let state = reducer(undefined, { type: 'attendance/setYearMonth', payload: { year: 2026, month: 5 } });
    state = reducer(state, fetchAttendance.pending('old-account', { year: 2026, month: 5 }));
    state = reducer(state, { type: 'account/identityChanged' });
    state = reducer(state, fetchAttendance.fulfilled({ records: [record({})], summary: null, year: 2026, month: 5 }, 'old-account', { year: 2026, month: 5 }));
    expect(state.records).toEqual({});
  });
});
