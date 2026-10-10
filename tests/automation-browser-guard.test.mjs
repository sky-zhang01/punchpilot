import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectionMode: 'browser',
  apiCredentials: false,
  credentials: true,
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  botInit: vi.fn(),
  botLogin: vi.fn(),
  botCleanup: vi.fn(),
  botEnsureCompany: vi.fn(),
  botAssertCompanyActive: vi.fn(),
  botDetectState: vi.fn(),
  botClickAction: vi.fn(),
  botCaptureScreenshot: vi.fn(),
  botSetPreMutationGuard: vi.fn(),
  readWebWorkRecord: vi.fn(),
  rereadWebWorkRecord: vi.fn(),
  returnToWebTimeClockPage: vi.fn(),
  submitWorkTimeCorrection: vi.fn(),
  submitLeaveRequestForm: vi.fn(),
  oauthIdentity: {
    companyId: '123',
    employeeId: '456',
    companyName: 'Example Corp',
    generation: '1',
  },
  authorizedCompanies: [{ id: 123, employee_id: 456, name: 'Example Corp' }],
  webCompanyName: 'Example Corp',
  webBinding: {
    companyName: 'Example Corp',
    employeeId: '456',
    generation: '1',
    fingerprint: 'v1:synthetic-web-account',
  },
  assertWebAccountBinding: vi.fn(),
  assertOAuthCompanyIdentity: vi.fn(),
  assertOAuthIdentityBinding: vi.fn(),
  readWebEmployeeIdentity: vi.fn(),
  installedGuard: null,
  installedAuthorizationGuard: null,
}));

vi.mock('../server/constants.js', () => ({
  FREEE_STATE: {
    NOT_CHECKED_IN: 'not_checked_in',
    WORKING: 'working',
    ON_BREAK: 'on_break',
    CHECKED_OUT: 'checked_out',
    UNKNOWN: 'unknown',
  },
}));

vi.mock('../server/freee-api.js', () => ({
  assertOAuthCompanyIdentity: mocks.assertOAuthCompanyIdentity,
  assertOAuthIdentityBinding: mocks.assertOAuthIdentityBinding,
  getAuthorizedOAuthCompanies: () => mocks.authorizedCompanies,
  FREEE_AUTH_ERROR_CODES: {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    AUTH_TRANSIENT: 'AUTH_TRANSIENT',
  },
  FREEE_API_ERROR_CODES: {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    RATE_LIMITED: 'RATE_LIMITED',
    API_TRANSIENT: 'API_TRANSIENT',
  },
  FreeeApiClient: class {},
}));

vi.mock('../server/logger.js', () => ({
  safeErrorMetadata: (error) => ({ name: error?.name || 'Error', code: error?.code }),
}));

vi.mock('../server/db.js', () => ({
  currentExecutionLogIdentityKey: () => `log-v1:${'a'.repeat(64)}`,
}));

vi.mock('../server/automation/constants.js', () => ({
  ACTION_LABELS: { checkin: 'Check-in' },
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));

vi.mock('../server/automation/utils.js', () => ({
  getCredentials: () => ({ username: 'synthetic', password: 'synthetic' }),
  getConnectionMode: () => mocks.connectionMode,
  getWebCompanyName: () => mocks.webCompanyName,
  hasApiCredentials: () => mocks.apiCredentials,
  hasCredentials: () => mocks.credentials,
  hasWebCredentials: () => mocks.credentials,
  isDebugMode: () => false,
}));

vi.mock('../server/automation/punch-bot.js', () => ({
  PunchBot: class {
    constructor() {
      this.page = { synthetic: true };
      this.runtime = {
        isUnrecoverable: () => false,
        getUnrecoverableError: () => null,
      };
    }

    init(signal) { return mocks.botInit(signal); }
    login(targetCompany) { return mocks.botLogin(targetCompany); }
    cleanup() { return mocks.botCleanup(); }
    ensureCompany(targetCompany) { return mocks.botEnsureCompany(targetCompany); }
    assertCompanyActive(targetCompany) { return mocks.botAssertCompanyActive(targetCompany); }
    detectState() { return mocks.botDetectState(); }
    clickAction(actionType, timestamp, expectedIntent) {
      return mocks.botClickAction(actionType, timestamp, expectedIntent);
    }
    captureScreenshot(...args) { return mocks.botCaptureScreenshot(...args); }
    setPreMutationGuard(guard, authorizationGuard) {
      return mocks.botSetPreMutationGuard(guard, authorizationGuard);
    }
  },
}));

vi.mock('../server/automation/runtime.js', () => ({
  AUTOMATION_OPERATION_TIMEOUT_MS: 1_000,
  withDeadline: (operation) => operation(new AbortController().signal),
}));

vi.mock('../server/automation/identity.js', () => ({
  captureAutomationOperationBinding: () => ({
    mode: mocks.connectionMode,
    debugMode: false,
    identityKey: `v1:synthetic-${mocks.connectionMode}-identity`,
  }),
  captureWebAccountBinding: () => ({ ...mocks.webBinding }),
  assertWebAccountBinding: mocks.assertWebAccountBinding,
}));

vi.mock('../server/automation/web-work-record.js', () => ({
  readWebWorkRecord: mocks.readWebWorkRecord,
  rereadWebWorkRecord: mocks.rereadWebWorkRecord,
  readWebEmployeeIdentity: mocks.readWebEmployeeIdentity,
  returnToWebTimeClockPage: mocks.returnToWebTimeClockPage,
  WEB_NON_WORKING_DAY_CONFIRMED: 'WEB_NON_WORKING_DAY_CONFIRMED',
  WEB_WORK_RECORD_ERROR_CODES: {
    UNCONFIRMED: 'WEB_WORK_RECORD_UNCONFIRMED',
    SCHEMA_UNSUPPORTED: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED',
    RESPONSE_TOO_LARGE: 'WEB_WORK_RECORD_RESPONSE_TOO_LARGE',
  },
}));

vi.mock('../server/automation/forms.js', () => ({
  submitWorkTimeCorrection: mocks.submitWorkTimeCorrection,
  scrapeEmployeeInfo: vi.fn(),
  submitLeaveRequest: mocks.submitLeaveRequestForm,
  withdrawApprovalRequest: vi.fn(),
  submitMonthlyClosingWeb: vi.fn(),
}));

vi.mock('../server/automation/mock.js', () => ({
  mockDetectState: vi.fn(),
  mockExecuteAction: vi.fn(),
}));

vi.mock('../server/automation/scheduling.js', () => ({
  isActionValidForState: () => ({ ok: true }),
}));

const {
  executeAction,
  submitLeaveRequest,
  submitWebCorrections,
} = await import('../server/automation/public-api.js');

function normalWebRecord(overrides = {}) {
  return {
    date: '2026-05-25',
    is_absence: false,
    paid_holiday: 0,
    paid_holidays: [],
    special_holiday: 0,
    normal_work_mins_by_paid_holiday: 0,
    half_paid_holiday_mins: 0,
    hourly_paid_holiday_mins: 0,
    half_special_holiday_mins: 0,
    hourly_special_holiday_mins: 0,
    normal_work_mins: 480,
    day_pattern: 'normal_day',
    schedule_pattern: '',
    clock_in_at: null,
    clock_out_at: null,
    break_records: [],
    work_record_segments: [],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.connectionMode = 'browser';
  mocks.apiCredentials = false;
  mocks.credentials = true;
  mocks.acquireLock.mockReset().mockResolvedValue(undefined);
  mocks.releaseLock.mockReset();
  mocks.botInit.mockReset().mockResolvedValue(undefined);
  mocks.botLogin.mockReset().mockResolvedValue(undefined);
  mocks.botCleanup.mockReset().mockResolvedValue(undefined);
  mocks.botEnsureCompany.mockReset().mockResolvedValue(undefined);
  mocks.botAssertCompanyActive.mockReset().mockResolvedValue(undefined);
  mocks.botDetectState.mockReset().mockResolvedValue('not_checked_in');
  mocks.botClickAction.mockReset().mockResolvedValue({
    screenshotBefore: null,
    screenshotAfter: null,
  });
  mocks.botCaptureScreenshot.mockReset().mockResolvedValue(null);
  mocks.installedGuard = null;
  mocks.installedAuthorizationGuard = null;
  mocks.botSetPreMutationGuard.mockReset().mockImplementation((guard, authorizationGuard) => {
    mocks.installedGuard = guard;
    mocks.installedAuthorizationGuard = authorizationGuard;
  });
  mocks.readWebWorkRecord.mockReset().mockResolvedValue(normalWebRecord());
  mocks.rereadWebWorkRecord.mockReset().mockResolvedValue(normalWebRecord());
  mocks.returnToWebTimeClockPage.mockReset().mockResolvedValue(undefined);
  mocks.submitWorkTimeCorrection.mockReset().mockResolvedValue({ success: true });
  mocks.submitLeaveRequestForm.mockReset().mockImplementation(
    async (_bot, _type, _date, _options, preSubmitGuard) => {
      const guardResult = await preSubmitGuard();
      return guardResult?.skip
        ? { success: true, skipped: true, reason: guardResult.reason }
        : { success: true };
    },
  );
  mocks.oauthIdentity = {
    companyId: '123',
    employeeId: '456',
    companyName: 'Example Corp',
    generation: '1',
  };
  mocks.authorizedCompanies = [{ id: 123, employee_id: 456, name: 'Example Corp' }];
  mocks.webCompanyName = 'Example Corp';
  mocks.webBinding = {
    companyName: 'Example Corp',
    employeeId: '456',
    generation: '1',
    fingerprint: 'v1:synthetic-web-account',
  };
  mocks.assertWebAccountBinding.mockReset().mockImplementation((binding) => {
    if (binding.fingerprint !== mocks.webBinding.fingerprint) {
      throw Object.assign(new Error('synthetic Web account changed'), {
        code: 'WEB_ACCOUNT_IDENTITY_CHANGED',
      });
    }
    return { ...mocks.webBinding };
  });
  mocks.assertOAuthCompanyIdentity.mockReset().mockImplementation((actual = null) => {
    if (
      actual &&
      (String(actual.employee_id) !== mocks.oauthIdentity.employeeId ||
        actual.name !== mocks.oauthIdentity.companyName)
    ) {
      throw Object.assign(new Error('synthetic company mismatch'), {
        code: 'OAUTH_COMPANY_IDENTITY_MISMATCH',
      });
    }
    return mocks.oauthIdentity;
  });
  mocks.assertOAuthIdentityBinding.mockReset().mockImplementation((binding) => {
    if (
      !binding ||
      binding.companyId !== mocks.oauthIdentity.companyId ||
      binding.employeeId !== mocks.oauthIdentity.employeeId ||
      binding.companyName !== mocks.oauthIdentity.companyName ||
      binding.generation !== mocks.oauthIdentity.generation
    ) {
      throw Object.assign(new Error('synthetic OAuth identity changed'), {
        code: 'OAUTH_IDENTITY_CHANGED',
      });
    }
    return { ...mocks.oauthIdentity };
  });
  mocks.readWebEmployeeIdentity.mockReset().mockResolvedValue({ employeeId: '456' });
});

describe('Web correction batch scheduling', () => {
  it('releases the automation lock between correction entries', async () => {
    vi.useFakeTimers();
    try {
      const operation = submitWebCorrections([
        {
          date: '2026-05-18',
          clock_in_at: '2026-05-18T09:00:00+09:00',
          clock_out_at: '2026-05-18T18:00:00+09:00',
        },
        {
          date: '2026-05-19',
          clock_in_at: '2026-05-19T09:00:00+09:00',
          clock_out_at: '2026-05-19T18:00:00+09:00',
        },
      ], undefined, null);

      await vi.runAllTimersAsync();
      await expect(operation).resolves.toHaveLength(2);
      expect(mocks.acquireLock).toHaveBeenCalledTimes(2);
      expect(mocks.releaseLock).toHaveBeenCalledTimes(2);
      expect(mocks.submitWorkTimeCorrection).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('API to Web company identity binding', () => {
  beforeEach(() => {
    mocks.connectionMode = 'api';
    mocks.apiCredentials = true;
  });

  const correction = {
    date: '2026-05-18',
    clock_in_at: '2026-05-18T09:00:00+09:00',
    clock_out_at: '2026-05-18T18:00:00+09:00',
  };

  it('binds the exact OAuth company name and Web employee before opening a form', async () => {
    const [result] = await submitWebCorrections([correction], undefined, {
      ...mocks.oauthIdentity,
    });

    expect(result.success).toBe(true);
    expect(mocks.botLogin).toHaveBeenCalledWith('Example Corp');
    expect(mocks.readWebEmployeeIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.botEnsureCompany).toHaveBeenCalledWith('Example Corp');
    expect(mocks.botSetPreMutationGuard).toHaveBeenCalledTimes(1);
    expect(mocks.submitWorkTimeCorrection).toHaveBeenCalledTimes(1);
    expect(mocks.submitWorkTimeCorrection).toHaveBeenCalledWith(
      expect.anything(),
      correction.date,
      expect.objectContaining({
        clockInHour: 9,
        clockOutHour: 18,
      }),
      '打刻漏れのため修正',
      { employeeId: '456', companyId: '123' },
    );
    await expect(mocks.installedGuard()).resolves.toBeUndefined();
    expect(mocks.botAssertCompanyActive).toHaveBeenCalledWith('Example Corp');
    expect(mocks.botEnsureCompany).toHaveBeenCalledTimes(1);
  });

  it('blocks the form when the Web employee differs from OAuth', async () => {
    mocks.readWebEmployeeIdentity.mockResolvedValue({ employeeId: '999' });

    const [result] = await submitWebCorrections([correction], undefined, {
      ...mocks.oauthIdentity,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'web_company_identity_unconfirmed',
    });
    expect(mocks.submitWorkTimeCorrection).not.toHaveBeenCalled();
  });

  it('blocks ambiguous duplicate company names before launching the browser', async () => {
    mocks.authorizedCompanies = [
      { id: 123, employee_id: 456, name: 'Example Corp' },
      { id: 789, employee_id: 987, name: 'Example Corp' },
    ];

    const [result] = await submitWebCorrections([correction], undefined, {
      ...mocks.oauthIdentity,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'web_company_identity_unconfirmed',
    });
    expect(mocks.botInit).not.toHaveBeenCalled();
    expect(mocks.submitWorkTimeCorrection).not.toHaveBeenCalled();
  });

  it('requires an explicit binding even if the global connection mode says API', async () => {
    const [result] = await submitWebCorrections([correction]);

    expect(result).toMatchObject({
      success: false,
      error: 'web_company_binding_required',
    });
    expect(mocks.botInit).not.toHaveBeenCalled();
  });

  it('keeps the OAuth snapshot binding when the global connection mode changes', async () => {
    mocks.connectionMode = 'browser';

    const [result] = await submitWebCorrections([correction], undefined, {
      ...mocks.oauthIdentity,
    });

    expect(result.success).toBe(true);
    expect(mocks.readWebEmployeeIdentity).toHaveBeenCalledTimes(1);
  });

  it('rejects an OAuth selection change through the installed pre-mutation guard', async () => {
    const expectedCompany = { ...mocks.oauthIdentity };
    const [result] = await submitWebCorrections(
      [correction],
      undefined,
      expectedCompany,
    );
    expect(result.success).toBe(true);
    expect(typeof mocks.installedGuard).toBe('function');

    mocks.oauthIdentity = {
      companyId: '789',
      employeeId: '987',
      companyName: 'Other Corp',
      generation: '2',
    };

    await expect(mocks.installedGuard()).rejects.toMatchObject({
      code: 'WEB_COMPANY_IDENTITY_UNCONFIRMED',
    });
    expect(mocks.botAssertCompanyActive).not.toHaveBeenCalled();
  });
});

describe('Browser-only pre-mutation leave guard', () => {
  it('fails closed before launching the browser when no employee is bound', async () => {
    mocks.webBinding.employeeId = '';

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'web_employee_binding_required',
      errorCode: 'WEB_EMPLOYEE_BINDING_REQUIRED',
      failureStage: 'identity_binding',
    });
    expect(mocks.botInit).not.toHaveBeenCalled();
    expect(mocks.botClickAction).not.toHaveBeenCalled();
  });

  it('blocks a different Web employee before reading or mutating attendance', async () => {
    mocks.readWebEmployeeIdentity.mockResolvedValue({ employeeId: '999' });

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'web_company_identity_unconfirmed',
      errorCode: 'WEB_COMPANY_IDENTITY_UNCONFIRMED',
      failureStage: 'employee_identity',
    });
    expect(mocks.readWebWorkRecord).not.toHaveBeenCalled();
    expect(mocks.botClickAction).not.toHaveBeenCalled();
  });

  it('returns a confirmed non-working result without reaching the punch button', async () => {
    mocks.readWebWorkRecord.mockResolvedValue(normalWebRecord({
      paid_holiday: 1,
      paid_holidays: [{ type: 'full', days: 0, mins: 0 }],
    }));

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'skipped',
      errorCode: 'WEB_NON_WORKING_DAY_CONFIRMED',
      nonWorkingDayCode: 'paid_holiday',
    });
    expect(mocks.returnToWebTimeClockPage).toHaveBeenCalledTimes(1);
    expect(mocks.readWebEmployeeIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.botInit).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.botClickAction).not.toHaveBeenCalled();
  });

  it('uses the scheduler-bound date for the Web guard and mutation intent', async () => {
    await expect(executeAction('checkin', {
      expectedDate: '2026-05-24',
    })).resolves.toMatchObject({ status: 'success' });

    expect(mocks.readWebWorkRecord).toHaveBeenCalledWith(
      expect.anything(),
      '2026-05-24',
    );
    expect(mocks.botClickAction).toHaveBeenCalledWith(
      'checkin',
      expect.any(String),
      expect.objectContaining({ date: '2026-05-24' }),
    );
  });

  it('marks schema failure as guard-unavailable before any mutation', async () => {
    mocks.readWebWorkRecord.mockRejectedValue(Object.assign(
      new Error('synthetic private schema detail'),
      { code: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED' },
    ));

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'web_leave_guard_unavailable',
      errorCode: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED',
      failureStage: 'work_record_guard',
      guardUnavailable: true,
    });
    expect(mocks.botClickAction).not.toHaveBeenCalled();
    expect(mocks.botCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a normalized Web record has an unknown day pattern', async () => {
    mocks.readWebWorkRecord.mockResolvedValue(normalWebRecord({
      day_pattern: 'future_freee_day_pattern',
    }));

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'web_leave_guard_unavailable',
      errorCode: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED',
      failureStage: 'work_record_guard',
      guardUnavailable: true,
    });
    expect(mocks.botClickAction).not.toHaveBeenCalled();
  });

  it('marks login failure as guard-unavailable when no read API exists', async () => {
    mocks.botLogin.mockRejectedValue(Object.assign(
      new Error('synthetic login detail'),
      { code: 'WEB_LOGIN_FAILED' },
    ));

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'web_credentials_invalid',
      errorCode: 'WEB_LOGIN_FAILED',
      failureStage: 'login',
      guardUnavailable: true,
    });
    expect(mocks.readWebWorkRecord).not.toHaveBeenCalled();
    expect(mocks.botClickAction).not.toHaveBeenCalled();
  });

  it('does not misclassify a post-guard punch failure as guard-unavailable', async () => {
    mocks.botClickAction.mockRejectedValue(Object.assign(
      new Error('synthetic confirmation detail'),
      { code: 'WEB_ACTION_CONFIRMATION_UNAVAILABLE' },
    ));

    const result = await executeAction('checkin');

    expect(result).toMatchObject({
      status: 'failure',
      error: 'web_action_confirmation_unavailable',
      errorCode: 'WEB_ACTION_CONFIRMATION_UNAVAILABLE',
      failureStage: 'mutation',
    });
    expect(result.guardUnavailable).not.toBe(true);
    expect(mocks.returnToWebTimeClockPage).toHaveBeenCalledTimes(2);
    expect(mocks.botEnsureCompany).toHaveBeenCalledTimes(1);
    expect(mocks.botAssertCompanyActive).toHaveBeenCalledTimes(1);
    expect(mocks.botClickAction).toHaveBeenCalledTimes(1);
    expect(mocks.botClickAction).toHaveBeenCalledWith(
      'checkin',
      expect.any(String),
      {
        employeeId: '456',
        companyId: null,
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    );
  });

  it('classifies a final account-binding rejection before mutation', async () => {
    mocks.botClickAction.mockRejectedValue(Object.assign(
      new Error('synthetic account changed'),
      { code: 'WEB_ACCOUNT_IDENTITY_CHANGED' },
    ));

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      errorCode: 'WEB_ACCOUNT_IDENTITY_CHANGED',
      failureStage: 'identity_binding',
    });
  });

  it('preserves the login diagnosis when cleanup also fails', async () => {
    mocks.botLogin.mockRejectedValue(Object.assign(
      new Error('synthetic login detail'),
      { code: 'WEB_LOGIN_FAILED' },
    ));
    mocks.botCleanup.mockRejectedValue(Object.assign(
      new Error('synthetic cleanup detail'),
      { code: 'AUTOMATION_RUNTIME_UNRECOVERABLE' },
    ));

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'web_credentials_invalid',
      errorCode: 'WEB_LOGIN_FAILED',
      failureStage: 'login',
    });
    expect(mocks.botCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup as the stage when the operation itself succeeded', async () => {
    mocks.botCleanup.mockRejectedValue(Object.assign(
      new Error('synthetic cleanup detail'),
      { code: 'AUTOMATION_RUNTIME_UNRECOVERABLE' },
    ));

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      errorCode: 'AUTOMATION_RUNTIME_UNRECOVERABLE',
      failureStage: 'cleanup',
    });
    expect(mocks.botClickAction).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('runs the scheduler authorization check after asynchronous company verification', async () => {
    const order = [];
    const authorizationGuard = vi.fn(() => {
      order.push('authorization');
    });
    mocks.botAssertCompanyActive.mockImplementation(async () => {
      order.push('company:start');
      await Promise.resolve();
      order.push('company:end');
    });

    await expect(executeAction('checkin', {
      mutationAuthorizationGuard: authorizationGuard,
    })).resolves.toMatchObject({ status: 'success' });
    expect(typeof mocks.installedGuard).toBe('function');

    order.length = 0;
    authorizationGuard.mockClear();
    await expect(mocks.installedGuard()).resolves.toBeUndefined();
    expect(typeof mocks.installedAuthorizationGuard).toBe('function');
    expect(() => mocks.installedAuthorizationGuard()).not.toThrow();
    expect(order).toEqual(['company:start', 'company:end', 'authorization']);
    expect(authorizationGuard).toHaveBeenCalledTimes(1);
  });
});

describe('Browser leave request record guard', () => {
  function expectedWebCompany() {
    return { kind: 'web', webBinding: { ...mocks.webBinding } };
  }

  it('binds an API-backed Web leave request to the selected company and employee', async () => {
    await expect(submitLeaveRequest(
      'PaidHoliday',
      '2026-05-25',
      {},
      { ...mocks.oauthIdentity },
    )).resolves.toMatchObject({ success: true, guard: 'verified' });

    expect(mocks.submitLeaveRequestForm).toHaveBeenCalledWith(
      expect.anything(),
      'PaidHoliday',
      '2026-05-25',
      {},
      expect.any(Function),
      { employeeId: '456', companyId: '123' },
    );
  });

  it.each(['HolidayWork', 'OvertimeWork'])(
    'does not misclassify a scheduled holiday as an existing leave for %s',
    async (type) => {
      const holidayRecord = normalWebRecord({ day_pattern: 'legal_holiday' });
      mocks.readWebWorkRecord.mockResolvedValue(holidayRecord);
      mocks.rereadWebWorkRecord.mockResolvedValue(holidayRecord);

      await expect(submitLeaveRequest(
        type,
        '2026-05-25',
        type === 'OvertimeWork'
          ? { startTime: '18:00', endTime: '20:00' }
          : {},
        expectedWebCompany(),
      )).resolves.toMatchObject({ success: true, guard: 'verified' });
      expect(mocks.submitLeaveRequestForm).toHaveBeenCalledOnce();
      expect(mocks.submitLeaveRequestForm).toHaveBeenCalledWith(
        expect.anything(),
        type,
        '2026-05-25',
        expect.any(Object),
        expect.any(Function),
        { employeeId: '456', companyId: null },
      );
      expect(mocks.rereadWebWorkRecord).toHaveBeenCalledWith(
        expect.anything(),
        '2026-05-25',
        '456',
      );
    },
  );

  it('stops before mutation when the final recheck observes an existing leave', async () => {
    mocks.readWebWorkRecord.mockResolvedValue(normalWebRecord());
    mocks.rereadWebWorkRecord.mockResolvedValue(normalWebRecord({
      paid_holiday: 1,
      paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
    }));

    await expect(submitLeaveRequest(
      'PaidHoliday',
      '2026-05-25',
      {},
      expectedWebCompany(),
    )).resolves.toMatchObject({
      success: true,
      skipped: true,
      guard: 'verified',
    });
    expect(mocks.rereadWebWorkRecord).toHaveBeenCalledOnce();
  });

  it('fails closed when the final work-record recheck is unavailable', async () => {
    mocks.rereadWebWorkRecord.mockRejectedValue(Object.assign(
      new Error('synthetic private recheck detail'),
      { code: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED' },
    ));

    await expect(submitLeaveRequest(
      'PaidHoliday',
      '2026-05-25',
      {},
      expectedWebCompany(),
    )).rejects.toMatchObject({ code: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED' });
  });

  it('rejects a form adapter that returns without running the final guard', async () => {
    mocks.submitLeaveRequestForm.mockResolvedValue({ success: true });

    await expect(submitLeaveRequest(
      'PaidHoliday',
      '2026-05-25',
      {},
      expectedWebCompany(),
    )).rejects.toMatchObject({ code: 'WEB_WORK_RECORD_UNCONFIRMED' });
    expect(mocks.rereadWebWorkRecord).not.toHaveBeenCalled();
  });
});
