import { describe, expect, it, vi } from 'vitest';
import {
  listSpecialHolidayOptions,
  submitLeaveForDate,
} from '../server/routes/attendance/leave-service.js';

const oauth = {
  companyId: '12345',
  employeeId: '67890',
  companyName: 'Example Corp',
  generation: '1',
};

describe('special holiday usage options', () => {
  it('aggregates every supported usage for the same setting', async () => {
    const client = {
      apiRequest: vi.fn().mockResolvedValue({
        employee_special_holidays: [
          {
            special_holiday_setting_id: 42,
            name: 'Family care',
            usage_day: 'half',
            num_days_and_hours_left: { days: 2, hours: 4 },
          },
          {
            special_holiday_setting_id: 42,
            name: 'Family care',
            usage_day: 'full',
            num_days_and_hours_left: { days: 2, hours: 4 },
          },
        ],
      }),
    };

    await expect(listSpecialHolidayOptions(client, oauth, '2026-05-12')).resolves.toEqual([{
      setting_id: 42,
      name: 'Family care',
      usage_day: null,
      usage_days: ['full', 'half'],
      remaining_days: 2,
      remaining_hours: 4,
    }]);
  });

  it('fails closed when the selected setting does not allow the requested usage', async () => {
    const client = {
      apiRequest: vi.fn(async (method, path) => {
        if (method === 'GET' && path.includes('/work_records/')) {
          return {
            date: '2026-05-12',
            is_editable: true,
            normal_work_mins: 480,
            is_absence: false,
            special_holiday: 0,
            half_special_holiday_mins: 0,
            hourly_special_holiday_mins: 0,
            day_pattern: 'normal_day',
            schedule_pattern: '',
            clock_in_at: null,
            clock_out_at: null,
            work_record_segments: [],
            break_records: [],
            paid_holidays: [],
          };
        }
        if (method === 'GET' && path.includes('/special_holidays?')) {
          return {
            employee_special_holidays: [{
              special_holiday_setting_id: 42,
              name: 'Full-day only',
              usage_day: 'full',
            }],
          };
        }
        throw new Error(`unexpected API request: ${method} ${path}`);
      }),
    };
    const result = await submitLeaveForDate({
      type: 'SpecialHoliday',
      date: '2026-05-12',
      reason: null,
      holidayType: 'hour',
      startTime: '09:00',
      endTime: '10:00',
      specialHolidaySettingId: 42,
    }, {
      client,
      oauth,
      ensureApiReady: vi.fn().mockResolvedValue(undefined),
      pendingApprovalStatus: vi.fn().mockResolvedValue({ supported: false, pending: false }),
      getRouteInfo: vi.fn(),
      webCredentialsAvailable: false,
      submitWeb: vi.fn(),
    });

    expect(result).toMatchObject({
      success: false,
      error: 'special_holiday_usage_unavailable',
      stages: expect.arrayContaining([{
        stage: 'special_leave_lookup',
        success: false,
        code: 'LEAVE_USAGE_UNAVAILABLE',
      }]),
    });
  });
});
