import { describe, expect, it, vi } from 'vitest';
import { fetchApprovalRequestPages, parseApprovalMonth, createApprovalMutationContext } from '../server/routes/attendance/approval-list-service.js';
import { withdrawApprovalOperation } from '../server/routes/attendance/approval-operation-service.js';
import { listSpecialHolidayOptions } from '../server/routes/attendance/leave-service.js';

describe('external identifier boundaries', () => {
  it.each([true, [0], '', '00', '1e0'])(
    'does not coerce an approval round or month from %j', value => {
      expect(createApprovalMutationContext({ request: { id: 7, company_id: 123, current_round: value, current_step_id: 7 }, companyId: 123, currentUserId: 456, type: 'PaidHoliday' })).toBeNull();
      expect(parseApprovalMonth([2026], value)).toBeNull();
    },
  );
  it.each([true, [7], { valueOf: () => 7 }, '1e2', ' 7', '07'])(
    'rejects coercible upstream identifiers throughout the real callers: %j', async value => {
      const apiRequest = vi.fn();
      await expect(fetchApprovalRequestPages({ client: { apiRequest }, companyId: value, type: 'PaidHoliday', status: 'approved', range: parseApprovalMonth(2026, 5) }))
        .rejects.toMatchObject({ code: 'INVALID_APPROVAL_LIST_QUERY' });
      expect(apiRequest).not.toHaveBeenCalled();
      expect(await withdrawApprovalOperation({ client: { apiRequest }, companyId: 123, currentUserId: 456, id: value, type: 'PaidHoliday' }))
        .toMatchObject({ success: false, error: 'invalid_withdraw_request' });
      expect(apiRequest).not.toHaveBeenCalled();
      expect(createApprovalMutationContext({ request: { id: value, company_id: 123, current_round: 0, current_step_id: 7 }, companyId: 123, currentUserId: 456, type: 'PaidHoliday' })).toBeNull();
      await expect(listSpecialHolidayOptions({ apiRequest: vi.fn().mockResolvedValue({ employee_special_holidays: [{ special_holiday_setting_id: value, usage_day: 'full' }] }) }, { companyId: '123', employeeId: '456' }, '2026-05-18'))
        .rejects.toMatchObject({ code: 'API_RESPONSE_UNCONFIRMED' });
    },
  );
});
