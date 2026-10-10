import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeLeaveRequest } from '../server/routes/attendance/leave-policy.js';
import { submitLeaveForDate } from '../server/routes/attendance/leave-service.js';

const oauth = { companyId: '12345', employeeId: '67890' };
const routeInfo = {
  primaryRouteId: 2468,
  fallbackRouteId: null,
  primaryRouteUserId: null,
  primaryRouteNeedsApprover: false,
  lookupVerified: true,
  lookupErrorCode: null,
};

function emptyRecord(date = '2026-05-18', overrides = {}) {
  return {
    date,
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
    ...overrides,
  };
}

function createContext({
  oauthValue = oauth,
  routeValue = routeInfo,
  webCredentialsAvailable = true,
  pendingStatusHook = 'default',
  finalRecordHook = 'default',
} = {}) {
  const responseMock = vi.fn();
  let insideBeforeDispatch = false;
  const apiRequest = vi.fn(async (method, path, body, options = {}) => {
    if (
      insideBeforeDispatch &&
      method === 'GET' &&
      path.includes('/work_records/') &&
      finalRecordHook !== null
    ) {
      const date = path.match(/\/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1];
      return typeof finalRecordHook === 'function'
        ? finalRecordHook({ method, path, body, options })
        : emptyRecord(date);
    }
    if (typeof options?.beforeDispatchAsync === 'function') {
      insideBeforeDispatch = true;
      try {
        await options.beforeDispatchAsync();
      } finally {
        insideBeforeDispatch = false;
      }
    }
    return responseMock(method, path, body, options);
  });
  for (const method of [
    'mockImplementation',
    'mockRejectedValue',
    'mockRejectedValueOnce',
    'mockResolvedValue',
    'mockResolvedValueOnce',
  ]) {
    apiRequest[method] = (...args) => {
      responseMock[method](...args);
      return apiRequest;
    };
  }
  const submitWeb = vi.fn().mockResolvedValue({
    success: true,
    guard: 'verified',
  });
  const pendingApprovalStatus = pendingStatusHook === null
    ? undefined
    : typeof pendingStatusHook === 'function'
      ? vi.fn(pendingStatusHook)
      : vi.fn(async (request) => ({
        supported: ['PaidHoliday', 'SpecialHoliday', 'OvertimeWork'].includes(
          request.type,
        ),
        pending: false,
      }));
  return {
    apiRequest,
    responseMock,
    submitWeb,
    context: {
      oauth: oauthValue,
      client: oauthValue ? { apiRequest } : null,
      webCredentialsAvailable,
      submitWeb,
      ensureApiReady: vi.fn().mockResolvedValue('synthetic-access'),
      getRouteInfo: vi.fn().mockResolvedValue(routeValue),
      ...(pendingApprovalStatus ? { pendingApprovalStatus } : {}),
    },
  };
}

function apiError(code) {
  const error = new Error('synthetic upstream failure');
  error.code = code;
  return error;
}

const pendingResponseKeys = {
  PaidHoliday: 'paid_holidays',
  SpecialHoliday: 'special_holidays',
  OvertimeWork: 'overtime_works',
};

function pendingResponse(type, rows = []) {
  return { [pendingResponseKeys[type]]: rows };
}

function pendingRow(date = '2026-05-18', overrides = {}) {
  return {
    id: 9753,
    company_id: 12345,
    applicant_id: 8642,
    status: 'in_progress',
    target_date: date,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('leave submission state machine', () => {
  it('prefers a confirmed approval route and sends the current paid-leave body', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
      holiday_type: 'morning_off',
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({ paid_holiday: { id: 9753 } });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: true,
      method: 'approval',
      id: 9753,
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/approval_requests/paid_holidays',
      {
        company_id: 12345,
        target_date: '2026-05-18',
        approval_flow_route_id: 2468,
        values: [{ type: 'morning' }],
      },
      expect.objectContaining({ beforeDispatchAsync: expect.any(Function) }),
    );
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('uses a current direct body only when route absence and the record are verified', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest } = createContext({
      routeValue: { ...routeInfo, primaryRouteId: null },
    });
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(
        emptyRecord('2026-05-18', {
          normal_work_mins: 480,
          paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
        }),
      );

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({ success: true, method: 'direct' });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      'PUT',
      '/employees/67890/work_records/2026-05-18?company_id=12345',
      { company_id: 12345, paid_holidays: [{ type: 'full' }] },
      expect.objectContaining({ beforeDispatchAsync: expect.any(Function) }),
    );
  });

  it('blocks an approval POST when leave appears during the final precondition', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest, responseMock } = createContext({
      finalRecordHook: () => emptyRecord('2026-05-18', {
        paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
      }),
    });
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({ paid_holiday: { id: 9753 } });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: true,
      method: 'skipped',
      reason: 'already_non_working_day',
    });
    expect(responseMock).toHaveBeenCalledTimes(1);
    expect(result.stages).toContainEqual(expect.objectContaining({
      stage: 'mutation_precheck',
      code: 'ALREADY_NON_WORKING_DAY',
    }));
  });

  it('blocks a direct PUT when clock data appears during the final precondition', async () => {
    const request = normalizeLeaveRequest({
      type: 'Absence',
      date: '2026-05-18',
    });
    const { context, apiRequest, responseMock } = createContext({
      pendingStatusHook: null,
      finalRecordHook: () => emptyRecord('2026-05-18', {
        clock_in_at: '2026-05-18T09:00:00+09:00',
      }),
    });
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({});

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      method: 'direct',
      error: 'direct_write_not_safe',
    });
    expect(responseMock).toHaveBeenCalledTimes(1);
  });

  it('blocks an approval POST when a pending request appears at dispatch time', async () => {
    let checks = 0;
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest, responseMock } = createContext({
      pendingStatusHook: async () => ({
        supported: true,
        pending: ++checks >= 2,
      }),
    });
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({ paid_holiday: { id: 9753 } });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: true,
      method: 'skipped',
      reason: 'already_pending_approval',
    });
    expect(responseMock).toHaveBeenCalledTimes(1);
    expect(checks).toBe(2);
  });

  it.each([
    {
      type: 'PaidHoliday',
      request: { type: 'PaidHoliday', date: '2026-05-18' },
      record: {
        normal_work_mins: 480,
        paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
      },
    },
    {
      type: 'SpecialHoliday',
      request: {
        type: 'SpecialHoliday',
        date: '2026-05-18',
        special_holiday_setting_id: 1357,
      },
      record: {
        normal_work_mins: 480,
        special_holiday: 1,
        special_holiday_setting_id: 1357,
      },
    },
    {
      type: 'Absence',
      request: { type: 'Absence', date: '2026-05-18' },
      record: { is_absence: true },
    },
  ])('skips an existing full-day $type only for the same requested type', async ({ request: input, record }) => {
    const request = normalizeLeaveRequest(input);
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest.mockResolvedValueOnce(
      emptyRecord('2026-05-18', record),
    );

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: true,
      method: 'skipped',
      reason: 'already_non_working_day',
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('does not treat another special-leave setting as an idempotent match', async () => {
    const request = normalizeLeaveRequest({
      type: 'SpecialHoliday',
      date: '2026-05-18',
      special_holiday_setting_id: 222,
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest.mockResolvedValueOnce(emptyRecord('2026-05-18', {
      normal_work_mins: 480,
      special_holiday: 1,
      special_holiday_setting_id: 111,
    }));

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      error: 'existing_leave_requires_web_confirmation',
    });
    expect(result).not.toMatchObject({ method: 'skipped' });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'special leave over paid leave',
      request: {
        type: 'SpecialHoliday',
        date: '2026-05-18',
        special_holiday_setting_id: 1357,
      },
      record: {
        normal_work_mins: 480,
        paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
      },
    },
    {
      label: 'absence over special leave',
      request: { type: 'Absence', date: '2026-05-18' },
      record: { normal_work_mins: 480, special_holiday: 1 },
    },
    {
      label: 'holiday work over paid leave',
      request: { type: 'HolidayWork', date: '2026-05-18' },
      record: {
        normal_work_mins: 480,
        paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
      },
    },
    {
      label: 'overtime over absence',
      request: {
        type: 'OvertimeWork',
        date: '2026-05-18',
        start_time: '18:00',
        end_time: '20:00',
      },
      record: { is_absence: true },
    },
  ])('does not report cross-type non-working state as idempotent: $label', async ({ request: input, record }) => {
    const request = normalizeLeaveRequest(input);
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest.mockResolvedValueOnce(emptyRecord('2026-05-18', record));

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      error: 'existing_leave_requires_web_confirmation',
    });
    expect(result).not.toMatchObject({ method: 'skipped' });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('submits holiday work on a scheduled non-working day instead of silently skipping it', async () => {
    const request = normalizeLeaveRequest({
      type: 'HolidayWork',
      date: '2026-05-18',
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest.mockResolvedValue(
      emptyRecord('2026-05-18', { day_pattern: 'legal_holiday' }),
    );

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({ success: true, method: 'web' });
    expect(result).not.toMatchObject({ method: 'skipped' });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(submitWeb).toHaveBeenCalledOnce();
  });

  it('submits overtime on a scheduled non-working day instead of silently skipping it', async () => {
    const request = normalizeLeaveRequest({
      type: 'OvertimeWork',
      date: '2026-05-18',
      start_time: '18:00',
      end_time: '20:00',
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest
      .mockResolvedValueOnce(
        emptyRecord('2026-05-18', { day_pattern: 'legal_holiday' }),
      )
      .mockResolvedValueOnce({ overtime_work: { id: 9753 } });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({ success: true, method: 'approval', id: 9753 });
    expect(result).not.toMatchObject({ method: 'skipped' });
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('blocks duplicate cross-channel submission when partial leave already exists', async () => {
    const request = normalizeLeaveRequest({
      type: 'SpecialHoliday',
      date: '2026-05-18',
      special_holiday_setting_id: 1357,
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest.mockResolvedValueOnce(
      emptyRecord('2026-05-18', {
        normal_work_mins: 480,
        paid_holidays: [{ type: 'half', days: 0.5, mins: 240 }],
      }),
    );

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      error: 'existing_leave_requires_web_confirmation',
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it.each(['API_TRANSIENT', 'API_RESPONSE_UNCONFIRMED']) (
    'stops after ambiguous approval failure %s',
    async (code) => {
      const request = normalizeLeaveRequest({
        type: 'PaidHoliday',
        date: '2026-05-18',
      });
      const { context, apiRequest, submitWeb } = createContext();
      apiRequest
        .mockResolvedValueOnce(emptyRecord())
        .mockRejectedValueOnce(apiError(code));

      const result = await submitLeaveForDate(request, context);

      expect(result).toMatchObject({
        success: false,
        method: 'approval',
        error: 'mutation_outcome_unconfirmed',
      });
      expect(submitWeb).not.toHaveBeenCalled();
    },
  );

  it.each(['WEB_FORM_REQUIRED', 'PERMISSION_DENIED'])(
    'rechecks work record and pending approval before allowlisted Web fallback %s',
    async (code) => {
      const request = normalizeLeaveRequest({
        type: 'PaidHoliday',
        date: '2026-05-18',
      });
      const { context, apiRequest, submitWeb } = createContext({
        pendingStatusHook: null,
      });
      let workRecordReads = 0;
      apiRequest.mockImplementation(async (method, path) => {
        if (method === 'GET' && path.includes('/work_records/')) {
          workRecordReads += 1;
          return emptyRecord();
        }
        if (method === 'POST' && path === '/approval_requests/paid_holidays') {
          throw apiError(code);
        }
        if (method === 'GET' && path === '/users/me') return { id: 8642 };
        if (method === 'GET' && path.startsWith('/approval_requests/paid_holidays?')) {
          return pendingResponse('PaidHoliday');
        }
        throw new Error(`unexpected API call: ${method} ${path}`);
      });

      const result = await submitLeaveForDate(request, context);

      expect(result).toMatchObject({
        success: true,
        method: 'web',
        guard: 'verified',
      });
      expect(workRecordReads).toBe(2);
      expect(apiRequest).toHaveBeenCalledWith('GET', '/users/me');
      expect(
        apiRequest.mock.calls.some(
          ([method, path]) =>
            method === 'GET' &&
            path.startsWith('/approval_requests/paid_holidays?') &&
            new URL(`https://example.invalid${path}`).searchParams.get('status') ===
              'in_progress',
        ),
      ).toBe(true);
      expect(submitWeb).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'API_ERROR_408',
    'API_ERROR_409',
    'API_ERROR_422',
    'API_ERROR_400',
    'API_ERROR_499',
    'RATE_LIMITED',
    'UNCLASSIFIED_REJECTION',
    'DIRECT_EDIT_DISABLED',
  ])('does not fall back to Web after non-allowlisted approval failure %s', async (code) => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockRejectedValueOnce(apiError(code));

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      method: 'approval',
      error: 'approval_request_failed',
    });
    expect(apiRequest).toHaveBeenCalledTimes(3);
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it.each([
    'API_ERROR_408',
    'API_ERROR_409',
    'API_ERROR_422',
    'API_ERROR_499',
    'WEB_FORM_REQUIRED',
  ])('does not fall back to Web after non-allowlisted direct failure %s', async (code) => {
    const request = normalizeLeaveRequest({
      type: 'Absence',
      date: '2026-05-18',
    });
    const { context, apiRequest, submitWeb } = createContext({
      pendingStatusHook: null,
    });
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockRejectedValueOnce(apiError(code));

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      method: 'direct',
      error: 'direct_write_failed',
    });
    expect(apiRequest).toHaveBeenCalledTimes(3);
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it.each(['DIRECT_EDIT_DISABLED', 'PERMISSION_DENIED'])(
    'allows direct-to-Web fallback only for direct allowlist code %s',
    async (code) => {
      const request = normalizeLeaveRequest({
        type: 'Absence',
        date: '2026-05-18',
      });
      const { context, apiRequest, submitWeb } = createContext();
      let workRecordReads = 0;
      apiRequest.mockImplementation(async (method, path) => {
        if (method === 'GET' && path.includes('/work_records/')) {
          workRecordReads += 1;
          return emptyRecord();
        }
        if (method === 'PUT' && path.includes('/work_records/')) {
          throw apiError(code);
        }
        throw new Error(`unexpected API call: ${method} ${path}`);
      });

      const result = await submitLeaveForDate(request, context);

      expect(result).toMatchObject({ success: true, method: 'web' });
      expect(workRecordReads).toBe(2);
      expect(submitWeb).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      type: 'PaidHoliday',
      request: { type: 'PaidHoliday', date: '2026-05-18' },
      endpoint: 'paid_holidays',
    },
    {
      type: 'OvertimeWork',
      request: {
        type: 'OvertimeWork',
        date: '2026-05-18',
        start_time: '18:00',
        end_time: '20:00',
      },
      endpoint: 'overtime_works',
    },
  ])('does not submit Web fallback when same-date $type approval is pending', async ({ type, request: input, endpoint }) => {
    const request = normalizeLeaveRequest(input);
    const { context, apiRequest, submitWeb } = createContext({
      pendingStatusHook: null,
    });
    apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.includes('/work_records/')) return emptyRecord();
      if (method === 'POST' && path === `/approval_requests/${endpoint}`) {
        throw apiError('WEB_FORM_REQUIRED');
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith(`/approval_requests/${endpoint}?`)) {
        return pendingResponse(type, [pendingRow()]);
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: true,
      method: 'skipped',
      reason: 'already_pending_approval',
    });
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('fails closed when pending approval status cannot be confirmed', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest, submitWeb } = createContext({
      pendingStatusHook: null,
    });
    apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.includes('/work_records/')) return emptyRecord();
      if (method === 'POST' && path === '/approval_requests/paid_holidays') {
        throw apiError('WEB_FORM_REQUIRED');
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/paid_holidays?')) {
        throw apiError('API_TRANSIENT');
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      method: 'blocked',
      error: 'work_record_precheck_failed',
    });
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('does not fall back when a successful approval response has no request id', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({ paid_holiday: {} });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      method: 'approval_unconfirmed',
      error: 'mutation_outcome_unconfirmed',
    });
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('allows explicit Web-only mode only after the Web guard is verified', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, submitWeb } = createContext({ oauthValue: null });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: true,
      method: 'web',
      guard: 'verified',
    });
    expect(result.stages).toContainEqual({
      stage: 'api_precheck',
      success: false,
      code: 'API_GUARD_UNAVAILABLE',
    });
    expect(result.stages).toContainEqual({
      stage: 'web_precheck',
      success: true,
    });
    expect(submitWeb).toHaveBeenCalledOnce();
  });

  it('fails closed when a Web adapter reports success without guard evidence', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
    });
    const { context, submitWeb } = createContext({ oauthValue: null });
    submitWeb.mockResolvedValue({ success: true });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      method: 'web',
      error: 'work_record_precheck_failed',
    });
    expect(result.stages).toContainEqual({
      stage: 'web_precheck',
      success: false,
      code: 'WEB_LEAVE_GUARD_UNCONFIRMED',
    });
  });

  it('does not attempt a direct write unless freee explicitly marks the record editable', async () => {
    const request = normalizeLeaveRequest({
      type: 'Absence',
      date: '2026-05-18',
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest
      .mockResolvedValueOnce(emptyRecord('2026-05-18', { is_editable: undefined }))
      .mockResolvedValueOnce(emptyRecord('2026-05-18', { is_editable: undefined }));

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({ success: true, method: 'web' });
    expect(
      apiRequest.mock.calls.some(([method]) => method === 'PUT'),
    ).toBe(false);
    expect(submitWeb).toHaveBeenCalledOnce();
  });

  it('fails closed for a Web subtype whose fields cannot be verified', async () => {
    const request = normalizeLeaveRequest({
      type: 'PaidHoliday',
      date: '2026-05-18',
      holiday_type: 'hour',
      start_time: '10:00',
      end_time: '11:00',
    });
    const { context, submitWeb } = createContext({ oauthValue: null });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      method: 'web',
      error: 'web_form_fields_unsupported',
    });
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it('auto-selects one verified special-leave setting', async () => {
    const request = normalizeLeaveRequest({
      type: 'SpecialHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest } = createContext();
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({
        employee_special_holidays: [
          {
            special_holiday_setting_id: 1357,
            name: 'Synthetic leave',
            usage_day: 'full',
          },
        ],
      })
      .mockResolvedValueOnce({ special_holiday: { id: 8642 } });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({ success: true, method: 'approval', id: 8642 });
    expect(apiRequest).toHaveBeenNthCalledWith(
      3,
      'POST',
      '/approval_requests/special_holidays',
      expect.objectContaining({
        special_holiday_setting_id: 1357,
        holiday_type: 'full',
      }),
      expect.objectContaining({ beforeDispatchAsync: expect.any(Function) }),
    );
  });

  it('requires an explicit setting when multiple special leaves are available', async () => {
    const request = normalizeLeaveRequest({
      type: 'SpecialHoliday',
      date: '2026-05-18',
    });
    const { context, apiRequest, submitWeb } = createContext();
    apiRequest
      .mockResolvedValueOnce(emptyRecord())
      .mockResolvedValueOnce({
        employee_special_holidays: [
          { special_holiday_setting_id: 1357, name: 'Synthetic A', usage_day: 'full' },
          { special_holiday_setting_id: 2468, name: 'Synthetic B', usage_day: 'full' },
        ],
      });

    const result = await submitLeaveForDate(request, context);

    expect(result).toMatchObject({
      success: false,
      error: 'special_holiday_setting_required',
    });
    expect(submitWeb).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'future_unit'])(
    'fails closed when a special-leave usage unit is unconfirmed: %s',
    async (usageDay) => {
      const request = normalizeLeaveRequest({
        type: 'SpecialHoliday',
        date: '2026-05-18',
      });
      const { context, apiRequest, submitWeb } = createContext();
      apiRequest
        .mockResolvedValueOnce(emptyRecord())
        .mockResolvedValueOnce({
          employee_special_holidays: [{
            special_holiday_setting_id: 1357,
            name: 'Synthetic leave',
            usage_day: usageDay,
          }],
        });

      const result = await submitLeaveForDate(request, context);

      expect(result).toMatchObject({
        success: false,
        error: 'special_holiday_lookup_failed',
      });
      expect(result.stages).toContainEqual(expect.objectContaining({
        stage: 'special_leave_lookup',
        success: false,
        code: 'API_RESPONSE_UNCONFIRMED',
      }));
      expect(submitWeb).not.toHaveBeenCalled();
    },
  );
});
