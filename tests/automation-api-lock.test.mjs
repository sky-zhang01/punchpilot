import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  detectState: vi.fn(),
  executeClockAction: vi.fn(),
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
  FREEE_AUTH_ERROR_CODES: {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    AUTH_TRANSIENT: 'AUTH_TRANSIENT',
    IDENTITY_CHANGED: 'OAUTH_IDENTITY_CHANGED',
  },
  FREEE_API_ERROR_CODES: {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    RATE_LIMITED: 'RATE_LIMITED',
    API_TRANSIENT: 'API_TRANSIENT',
  },
  FreeeApiClient: class {
    detectState() {
      return mocks.detectState();
    }

    executeClockAction(actionType, options) {
      return mocks.executeClockAction(actionType, options);
    }
  },
}));

vi.mock('../server/logger.js', () => ({
  safeErrorMetadata: (error) => ({ name: error?.name || 'Error', code: error?.code }),
}));

vi.mock('../server/automation/constants.js', () => ({
  ACTION_LABELS: { checkin: 'Check-in' },
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));

vi.mock('../server/automation/utils.js', () => ({
  getCredentials: () => ({ username: '', password: '' }),
  getConnectionMode: () => 'api',
  hasApiCredentials: () => true,
  hasCredentials: () => true,
  hasWebCredentials: () => false,
  isDebugMode: () => false,
}));

vi.mock('../server/automation/punch-bot.js', () => ({ PunchBot: class {} }));
vi.mock('../server/automation/runtime.js', () => ({
  AUTOMATION_OPERATION_TIMEOUT_MS: 1_000,
  withDeadline: (operation) => operation(),
}));
vi.mock('../server/automation/identity.js', () => ({
  captureAutomationOperationBinding: () => ({
    mode: 'api',
    debugMode: false,
    identityKey: 'v1:synthetic-api-identity',
  }),
  captureWebAccountBinding: vi.fn(),
  assertWebAccountBinding: vi.fn(),
}));
vi.mock('../server/automation/web-work-record.js', () => ({
  readWebWorkRecord: vi.fn(),
  returnToWebTimeClockPage: vi.fn(),
  WEB_NON_WORKING_DAY_CONFIRMED: 'WEB_NON_WORKING_DAY_CONFIRMED',
  WEB_WORK_RECORD_ERROR_CODES: {
    UNCONFIRMED: 'WEB_WORK_RECORD_UNCONFIRMED',
    SCHEMA_UNSUPPORTED: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED',
    RESPONSE_TOO_LARGE: 'WEB_WORK_RECORD_RESPONSE_TOO_LARGE',
  },
}));
vi.mock('../server/automation/forms.js', () => ({
  submitWorkTimeCorrection: vi.fn(),
  scrapeEmployeeInfo: vi.fn(),
  submitLeaveRequest: vi.fn(),
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

const { executeAction } = await import('../server/automation/public-api.js');

beforeEach(() => {
  mocks.acquireLock.mockReset().mockResolvedValue(undefined);
  mocks.releaseLock.mockReset();
  mocks.detectState.mockReset().mockResolvedValue('working');
  mocks.executeClockAction.mockReset().mockImplementation(async (
    _actionType,
    { mutationAuthorizationGuard = null } = {},
  ) => {
    mutationAuthorizationGuard?.();
    return {
      status: 'success',
      screenshotBefore: null,
      screenshotAfter: null,
      error: null,
    };
  });
});

describe('API attendance write serialization', () => {
  it('holds the shared automation lock around an API punch', async () => {
    await expect(executeAction('checkin')).resolves.toMatchObject({ status: 'success' });

    expect(mocks.acquireLock).toHaveBeenCalledTimes(1);
    expect(mocks.executeClockAction).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
    expect(mocks.acquireLock.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.executeClockAction.mock.invocationCallOrder[0]);
    expect(mocks.executeClockAction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.releaseLock.mock.invocationCallOrder[0]);
  });

  it('releases the lock when the API action fails', async () => {
    mocks.executeClockAction.mockRejectedValue(
      Object.assign(new Error('synthetic upstream detail'), { code: 'API_TRANSIENT' }),
    );

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'api_temporarily_unavailable',
      errorCode: 'API_TRANSIENT',
    });
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('returns a stable failure when the queue deadline is exceeded', async () => {
    mocks.acquireLock.mockRejectedValue(
      Object.assign(new Error('synthetic queue detail'), { code: 'AUTOMATION_QUEUE_TIMEOUT' }),
    );

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'automation_queue_timeout',
      errorCode: 'AUTOMATION_QUEUE_TIMEOUT',
    });
    expect(mocks.executeClockAction).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('reports an OAuth identity race as an unknown write outcome', async () => {
    mocks.executeClockAction.mockRejectedValue(
      Object.assign(new Error('synthetic identity changed'), {
        code: 'OAUTH_IDENTITY_CHANGED',
      }),
    );

    await expect(executeAction('checkin')).resolves.toMatchObject({
      status: 'failure',
      error: 'oauth_identity_changed_outcome_unknown',
      errorCode: 'OAUTH_IDENTITY_CHANGED',
    });
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not start a queued action when the scheduler identity is stale', async () => {
    await expect(executeAction('checkin', {
      expectedIdentityKey: 'v1:synthetic-old-identity',
    })).resolves.toMatchObject({
      status: 'failure',
      error: 'automation_identity_changed_before_mutation',
      errorCode: 'AUTOMATION_IDENTITY_CHANGED',
    });
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(mocks.detectState).not.toHaveBeenCalled();
    expect(mocks.executeClockAction).not.toHaveBeenCalled();
  });

  it('rechecks scheduler authorization immediately before the API mutation', async () => {
    const mutationAuthorizationGuard = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('synthetic stale generation'), {
          code: 'SCHEDULE_GENERATION_STALE',
        });
      });

    await expect(executeAction('checkin', {
      mutationAuthorizationGuard,
    })).resolves.toMatchObject({
      status: 'skipped',
      error: 'scheduled_action_cancelled',
      errorCode: 'SCHEDULE_GENERATION_STALE',
    });
    expect(mutationAuthorizationGuard).toHaveBeenCalledTimes(3);
    expect(mocks.executeClockAction).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('maps a stale schedule date to a cancellation before taking the write lock', async () => {
    const mutationAuthorizationGuard = vi.fn(() => {
      throw Object.assign(new Error('synthetic stale date'), {
        code: 'SCHEDULE_DATE_STALE',
      });
    });

    await expect(executeAction('checkin', {
      expectedDate: '2026-07-11',
      mutationAuthorizationGuard,
    })).resolves.toMatchObject({
      status: 'skipped',
      error: 'scheduled_action_cancelled',
      errorCode: 'SCHEDULE_DATE_STALE',
    });
    expect(mutationAuthorizationGuard).toHaveBeenCalledTimes(1);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(mocks.executeClockAction).not.toHaveBeenCalled();
  });
});
