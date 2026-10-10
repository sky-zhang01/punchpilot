import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  authenticateFreeeWeb: vi.fn(),
  readWebEmployeeIdentity: vi.fn(),
  ensureCompany: vi.fn(),
  withDeadline: vi.fn(),
  openContext: vi.fn(),
  closeContext: vi.fn(),
  closeBrowser: vi.fn(),
  invalidateSession: vi.fn(),
  runtimeUnrecoverable: false,
  runtimeError: null,
  schedulerStopAll: vi.fn(),
  schedulerInitialize: vi.fn(),
  page: {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
  },
  context: {
    newPage: vi.fn(),
  },
}));

vi.mock('../server/automation/constants.js', () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));

vi.mock('../server/automation/runtime.js', () => ({
  AUTOMATION_OPERATION_TIMEOUT_MS: 480_000,
  automationRuntime: {
    openContext: mocks.openContext,
    closeContext: mocks.closeContext,
    closeBrowser: mocks.closeBrowser,
    invalidateSession: mocks.invalidateSession,
    isUnrecoverable: () => mocks.runtimeUnrecoverable,
    getUnrecoverableError: () => mocks.runtimeError,
  },
  withDeadline: mocks.withDeadline,
}));

vi.mock('../server/automation/web-login.js', () => ({
  authenticateFreeeWeb: mocks.authenticateFreeeWeb,
}));

vi.mock('../server/automation/web-work-record.js', () => ({
  readWebEmployeeIdentity: mocks.readWebEmployeeIdentity,
}));

vi.mock('../server/automation/punch-bot.js', () => ({
  PunchBot: class {
    ensureCompany() {
      return mocks.ensureCompany();
    }
  },
}));

vi.mock('../server/scheduler.js', () => ({
  scheduler: {
    stopAll: mocks.schedulerStopAll,
    initialize: mocks.schedulerInitialize,
  },
}));

const {
  getSetting,
  initDatabase,
  setSettingsAtomically,
} = await import('../server/db.js');
const { decrypt, encrypt } = await import('../server/crypto.js');
const { default: configRouter } = await import('../server/routes/api-config.js');
const {
  acquireAccountOperation,
  releaseAccountOperation,
} = await import('../server/account-operation.js');

const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const replacementCredential = ['fixture', 'replacement', 'credential'].join('-');

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  setSettingsAtomically([
    ['connection_mode', 'browser'],
    ['freee_configured', '1'],
    ['freee_username_encrypted', encrypt('synthetic-user')],
    ['freee_password_encrypted', encrypt('synthetic-password')],
    ['web_company_name', 'Synthetic Company'],
    ['web_employee_id_encrypted', ''],
    ['web_identity_generation', '1'],
  ]);
  mocks.acquireLock.mockReset().mockResolvedValue(undefined);
  mocks.releaseLock.mockReset();
  mocks.authenticateFreeeWeb.mockReset().mockResolvedValue(undefined);
  mocks.readWebEmployeeIdentity.mockReset().mockResolvedValue({ employeeId: '456' });
  mocks.ensureCompany.mockReset().mockResolvedValue(undefined);
  mocks.withDeadline.mockReset().mockImplementation((operation) =>
    operation(new AbortController().signal));
  mocks.page.setDefaultTimeout.mockReset();
  mocks.page.setDefaultNavigationTimeout.mockReset();
  mocks.context.newPage.mockReset().mockResolvedValue(mocks.page);
  mocks.openContext.mockReset().mockResolvedValue(mocks.context);
  mocks.closeContext.mockReset().mockResolvedValue(undefined);
  mocks.closeBrowser.mockReset().mockResolvedValue(undefined);
  mocks.invalidateSession.mockReset();
  mocks.runtimeUnrecoverable = false;
  mocks.runtimeError = null;
  mocks.schedulerStopAll.mockReset();
  mocks.schedulerInitialize.mockReset().mockResolvedValue(undefined);
});

describe('freee Web employee verification', () => {
  it.each(['999', 'invalid'])('rejects an explicit environment employee that differs from the observed account (%s)', async (employeeId) => {
    vi.stubEnv('LOGIN_USERNAME', 'environment-user');
    vi.stubEnv('LOGIN_PASSWORD', 'environment-synthetic-password');
    vi.stubEnv('FREEE_COMPANY_NAME', 'Synthetic Company');
    vi.stubEnv('FREEE_EMPLOYEE_ID', employeeId);
    try {
      setSettingsAtomically([['freee_configured', '0'], ['freee_username_encrypted', ''], ['freee_password_encrypted', ''],
        ['web_company_name', ''], ['web_employee_id_encrypted', ''], ['web_verified_credential_digest', '']]);
      const response = await request(app).post('/api/config/verify-web-credentials');
      expect(response.body).toMatchObject({ valid: false, web_identity_verified: false });
      expect(getSetting('web_employee_id_encrypted')).toBe('');
      expect(getSetting('web_identity_generation')).toBe('1');
    } finally { vi.unstubAllEnvs(); }
  });

  it('persists only an encrypted binding and returns a boolean verification state', async () => {
    const before = await request(app).get('/api/config/account');
    expect(before.status).toBe(200);
    expect(before.body.web_identity_verified).toBe(false);

    const response = await request(app).post('/api/config/verify-web-credentials');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      valid: true,
      web_identity_verified: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('456');
    expect(getSetting('web_employee_id_encrypted')).not.toBe('456');
    expect(decrypt(getSetting('web_employee_id_encrypted'))).toBe('456');
    expect(getSetting('web_identity_generation')).toBe('2');
    expect(mocks.openContext).toHaveBeenCalledWith({
      useStoredSession: false,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.withDeadline).toHaveBeenCalledWith(
      expect.any(Function),
      480_000,
      { onTimeout: expect.any(Function) },
    );
    expect(mocks.closeContext).toHaveBeenCalledWith(mocks.context);
    expect(mocks.acquireLock).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerStopAll).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerInitialize).toHaveBeenCalledTimes(1);

    const after = await request(app).get('/api/config/account');
    expect(after.body.web_identity_verified).toBe(true);
    expect(JSON.stringify(after.body)).not.toContain('456');
  });

  it('does not establish an employee binding when login cannot be confirmed', async () => {
    mocks.authenticateFreeeWeb.mockRejectedValue(Object.assign(
      new Error('synthetic private login detail'),
      { code: 'WEB_LOGIN_FAILED' },
    ));
    mocks.closeContext.mockRejectedValue(Object.assign(
      new Error('synthetic private cleanup detail'),
      { code: 'UNREGISTERED_CLEANUP_CODE' },
    ));

    const response = await request(app).post('/api/config/verify-web-credentials');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      valid: false,
      web_identity_verified: false,
      code: 'WEB_LOGIN_FAILED',
    });
    expect(getSetting('web_employee_id_encrypted')).toBe('');
    expect(mocks.readWebEmployeeIdentity).not.toHaveBeenCalled();
    expect(mocks.closeContext).toHaveBeenCalledWith(mocks.context);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerInitialize).toHaveBeenCalledTimes(1);
  });

  it('collapses unregistered verification failures to a stable public code', async () => {
    mocks.authenticateFreeeWeb.mockRejectedValue(Object.assign(
      new Error('synthetic private verification detail'),
      { code: 'UNREGISTERED_VERIFICATION_CODE' },
    ));

    const response = await request(app).post('/api/config/verify-web-credentials');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      valid: false,
      web_identity_verified: false,
      code: 'WEB_AUTOMATION_FAILED',
    });
    expect(JSON.stringify(response.body)).not.toContain('UNREGISTERED_VERIFICATION_CODE');
    expect(JSON.stringify(response.body)).not.toContain('synthetic private verification detail');
  });

  it('returns the stable timeout code when the verification deadline expires', async () => {
    const timeoutError = Object.assign(
      new Error('synthetic timeout detail'),
      { code: 'AUTOMATION_OPERATION_TIMEOUT' },
    );
    mocks.withDeadline.mockImplementationOnce(async (
      _operation,
      _timeoutMs,
      { onTimeout },
    ) => {
      await onTimeout();
      throw timeoutError;
    });

    const response = await request(app).post('/api/config/verify-web-credentials');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      valid: false,
      web_identity_verified: false,
      code: 'AUTOMATION_OPERATION_TIMEOUT',
    });
    expect(JSON.stringify(response.body)).not.toContain('synthetic timeout detail');
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
    expect(mocks.closeContext).toHaveBeenCalledWith(null);
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('reads the credentials only after entering the account operation lock', async () => {
    await acquireAccountOperation();
    let released = false;
    try {
      mocks.authenticateFreeeWeb.mockImplementation(async (_page, credentials) => {
        mocks.readWebEmployeeIdentity.mockResolvedValue({
          employeeId: credentials.username === 'replacement-user' ? '789' : '456',
        });
      });
      const pendingResponse = request(app)
        .post('/api/config/verify-web-credentials')
        .then((response) => response);
      await vi.waitFor(() => {
        expect(mocks.schedulerStopAll).toHaveBeenCalledTimes(1);
      });
      setSettingsAtomically([
        ['freee_username_encrypted', encrypt('replacement-user')],
        ['freee_password_encrypted', encrypt(replacementCredential)],
        ['web_company_name', 'Replacement Company'],
        ['web_employee_id_encrypted', ''],
        ['web_identity_generation', '2'],
      ]);
      releaseAccountOperation();
      released = true;

      const response = await pendingResponse;
      expect(response.status).toBe(200);
      expect(mocks.authenticateFreeeWeb).toHaveBeenCalledWith(
        mocks.page,
        {
          username: 'replacement-user',
          password: replacementCredential,
        },
      );
      expect(decrypt(getSetting('web_employee_id_encrypted'))).toBe('789');
      expect(getSetting('web_identity_generation')).toBe('3');
    } finally {
      if (!released) releaseAccountOperation();
    }
  });
});
