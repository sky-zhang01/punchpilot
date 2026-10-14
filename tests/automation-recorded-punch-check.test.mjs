import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  detectState: vi.fn(),
  executeClockAction: vi.fn(),
  isActionValidForState: vi.fn(),
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
  isActionValidForState: (...args) => mocks.isActionValidForState(...args),
}));

const { executeAction } = await import('../server/automation/public-api.js');

beforeEach(() => {
  mocks.acquireLock.mockReset().mockResolvedValue(undefined);
  mocks.releaseLock.mockReset();
  mocks.detectState.mockReset().mockResolvedValue('working');
  mocks.isActionValidForState.mockReset().mockReturnValue({ ok: true });
  mocks.executeClockAction.mockReset().mockResolvedValue({
    status: 'success',
    screenshotBefore: null,
    screenshotAfter: null,
    error: null,
  });
});

describe('punch-history check before a retried API punch', () => {
  it('reports success without sending when freee already has the punch', async () => {
    const recordedPunchCheck = vi.fn().mockResolvedValue('recorded');

    await expect(executeAction('checkout', { recordedPunchCheck })).resolves.toMatchObject({
      status: 'success',
      confirmedFromHistory: true,
      error: 'Confirmed in freee punch history after a temporary freee API failure.',
    });
    expect(mocks.executeClockAction).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('runs the check under the automation lock, before any punch is sent', async () => {
    const recordedPunchCheck = vi.fn().mockResolvedValue('not_recorded');

    await expect(executeAction('checkout', { recordedPunchCheck })).resolves.toMatchObject({ status: 'success' });

    expect(mocks.acquireLock.mock.invocationCallOrder[0])
      .toBeLessThan(recordedPunchCheck.mock.invocationCallOrder[0]);
    expect(recordedPunchCheck.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.executeClockAction.mock.invocationCallOrder[0]);
    expect(mocks.executeClockAction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.releaseLock.mock.invocationCallOrder[0]);
  });

  it('treats an unreadable history as a transient failure and sends nothing', async () => {
    const recordedPunchCheck = vi.fn().mockResolvedValue('unreadable');

    await expect(executeAction('checkout', { recordedPunchCheck })).resolves.toMatchObject({
      status: 'failure',
      errorCode: 'API_TRANSIENT',
      failureStage: 'state_read',
    });
    expect(mocks.executeClockAction).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('recognises a landed punch before the state check would skip it', async () => {
    // A break_end that landed leaves freee WORKING, where break_end is no longer valid.
    mocks.isActionValidForState.mockReturnValue({ ok: false, reason: 'Not on break' });
    const recordedPunchCheck = vi.fn().mockResolvedValue('recorded');

    await expect(executeAction('break_end', { recordedPunchCheck })).resolves.toMatchObject({
      status: 'success',
      confirmedFromHistory: true,
    });
    expect(mocks.isActionValidForState).not.toHaveBeenCalled();
  });

  it('does not read punch history on a first attempt', async () => {
    await expect(executeAction('checkin')).resolves.toMatchObject({ status: 'success' });
    expect(mocks.executeClockAction).toHaveBeenCalledTimes(1);
  });
});
