import { describe, expect, it } from 'vitest';
import {
  LeaveValidationError,
  buildDirectLeaveBody,
  buildLeaveApprovalBody,
  canSubmitLeaveViaWeb,
  extractLeaveApprovalId,
  isValidDateString,
  normalizeBatchLeaveRequest,
  normalizeLeaveRequest,
} from '../server/routes/attendance/leave-policy.js';

const routeInfo = {
  primaryRouteId: 2468,
  fallbackRouteId: null,
  primaryRouteUserId: null,
  primaryRouteNeedsApprover: false,
  lookupVerified: true,
  lookupErrorCode: null,
};

describe('leave request validation', () => {
  it('normalizes current and legacy paid-leave type names', () => {
    expect(
      normalizeLeaveRequest({
        type: 'PaidHoliday',
        date: '2026-05-18',
        holiday_type: 'morning',
      }).holidayType,
    ).toBe('morning_off');
    expect(
      normalizeLeaveRequest({
        type: 'PaidHoliday',
        date: '2026-05-18',
        holiday_type: 'hourly',
        start_time: '10:00',
        end_time: '11:00',
      }).holidayType,
    ).toBe('hour');
  });

  it.each(['2026-02-30', '2026-13-01', 'not-a-date', '']) (
    'rejects invalid calendar date %s',
    (date) => {
      expect(isValidDateString(date)).toBe(false);
      expect(() =>
        normalizeLeaveRequest({ type: 'PaidHoliday', date }),
      ).toThrow(LeaveValidationError);
    },
  );

  it('requires paired times for half-day, hourly, and overtime requests', () => {
    expect(() =>
      normalizeLeaveRequest({
        type: 'PaidHoliday',
        date: '2026-05-18',
        holiday_type: 'half',
      }),
    ).toThrow('start_time and end_time are required');
    expect(() =>
      normalizeLeaveRequest({
        type: 'OvertimeWork',
        date: '2026-05-18',
        start_time: '18:00',
      }),
    ).toThrow('start_time and end_time must be provided together');
  });

  it('enforces freee comment length and positive setting identifiers', () => {
    expect(() =>
      normalizeLeaveRequest({
        type: 'PaidHoliday',
        date: '2026-05-18',
        reason: 'x'.repeat(256),
      }),
    ).toThrow('255 characters or less');
    expect(() =>
      normalizeLeaveRequest({
        type: 'SpecialHoliday',
        date: '2026-05-18',
        special_holiday_setting_id: -1,
      }),
    ).toThrow('positive integer');
  });

  it('rejects duplicate or oversized batch dates before processing', () => {
    expect(() =>
      normalizeBatchLeaveRequest({
        type: 'PaidHoliday',
        dates: ['2026-05-18', '2026-05-18'],
      }),
    ).toThrow('dates must be unique');
    expect(() =>
      normalizeBatchLeaveRequest({
        type: 'PaidHoliday',
        dates: Array.from({ length: 51 }, (_, index) =>
          `2026-06-${String(index + 1).padStart(2, '0')}`,
        ),
      }),
    ).toThrow('Maximum 50 dates');
  });
});

describe('freee leave request bodies', () => {
  it('uses the current values array for paid-leave approvals', () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
      holiday_type: 'hour',
      start_time: '10:00',
      end_time: '11:00',
      reason: 'Appointment',
    });

    expect(buildLeaveApprovalBody(request, '12345', routeInfo)).toEqual({
      company_id: 12345,
      target_date: '2026-05-18',
      approval_flow_route_id: 2468,
      comment: 'Appointment',
      values: [{ type: 'hourly', start_at: '10:00', end_at: '11:00' }],
    });
  });

  it('maps morning and afternoon names to the current approval schema', () => {
    const morning = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
      holiday_type: 'morning_off',
    });
    const afternoon = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-19',
      holiday_type: 'afternoon_off',
    });

    expect(buildLeaveApprovalBody(morning, '12345', routeInfo).values).toEqual([
      { type: 'morning' },
    ]);
    expect(buildLeaveApprovalBody(afternoon, '12345', routeInfo).values).toEqual([
      { type: 'afternoon' },
    ]);
  });

  it('uses paid_holidays for direct full-day updates and never direct-writes overtime', () => {
    const paid = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const overtime = normalizeLeaveRequest({
      type: 'OvertimeWork',
      date: '2026-05-18',
      start_time: '18:00',
      end_time: '20:00',
    });

    expect(buildDirectLeaveBody(paid, '12345')).toEqual({
      company_id: 12345,
      paid_holidays: [{ type: 'full' }],
    });
    expect(buildDirectLeaveBody(overtime, '12345')).toBeNull();
  });

  it('builds special leave with a verified setting and schema-specific type', () => {
    const request = normalizeLeaveRequest({
      type: 'SpecialHoliday',
      date: '2026-05-18',
      holiday_type: 'morning_off',
      special_holiday_setting_id: 1357,
    });

    expect(buildLeaveApprovalBody(request, '12345', routeInfo)).toEqual({
      company_id: 12345,
      target_date: '2026-05-18',
      approval_flow_route_id: 2468,
      special_holiday_setting_id: 1357,
      holiday_type: 'morning',
    });
  });

  it('refuses to guess an approver for a route that requires selection', () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    expect(() =>
      buildLeaveApprovalBody(request, '12345', {
        ...routeInfo,
        primaryRouteNeedsApprover: true,
      }),
    ).toThrow('selected in freee Web');
  });

  it('only permits Web fallback for fields the automation can verify', () => {
    expect(
      canSubmitLeaveViaWeb(
        normalizeLeaveRequest({ type: 'PaidHoliday', date: '2026-05-18' }),
      ),
    ).toBe(true);
    expect(
      canSubmitLeaveViaWeb(
        normalizeLeaveRequest({
          type: 'PaidHoliday',
          date: '2026-05-18',
          holiday_type: 'hour',
          start_time: '10:00',
          end_time: '11:00',
        }),
      ),
    ).toBe(false);
    expect(
      canSubmitLeaveViaWeb(
        normalizeLeaveRequest({ type: 'SpecialHoliday', date: '2026-05-18' }),
      ),
    ).toBe(false);
  });

  it('extracts only positive confirmed approval identifiers', () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    expect(extractLeaveApprovalId(request, { paid_holiday: { id: 9753 } })).toBe(9753);
    expect(extractLeaveApprovalId(request, { paid_holiday: {} })).toBeNull();
  });
});
