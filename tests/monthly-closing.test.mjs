import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  ensureValidToken: vi.fn(),
  hasWebCredentials: vi.fn(),
  submitMonthlyAttendanceClosingWeb: vi.fn(),
  oauthBinding: {
    companyId: '12345',
    employeeId: '67890',
    companyName: 'Example Corp',
    generation: '1',
  },
}));

const FREEE_API_ERROR_CODES = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  API_TRANSIENT: 'API_TRANSIENT',
  MONTHLY_CLOSING_ALREADY_SUBMITTED: 'MONTHLY_CLOSING_ALREADY_SUBMITTED',
  WEB_FORM_REQUIRED: 'WEB_FORM_REQUIRED',
};

vi.mock('../server/freee-api.js', () => ({
  FREEE_API_ERROR_CODES,
  FREEE_AUTH_ERROR_CODES: {
    COMPANY_SELECTION_REQUIRED: 'OAUTH_COMPANY_SELECTION_REQUIRED',
  },
  captureOAuthIdentityBinding: () => Object.freeze({ ...mocks.oauthBinding }),
  FreeeApiClient: class {
    async ensureValidToken() {
      return mocks.ensureValidToken();
    }

    async apiRequest(method, path, body) {
      return mocks.apiRequest(method, path, body);
    }
  },
}));

vi.mock('../server/automation/index.js', () => ({
  withdrawApprovalRequestWeb: vi.fn(),
  hasWebCredentials: mocks.hasWebCredentials,
  submitMonthlyAttendanceClosingWeb: mocks.submitMonthlyAttendanceClosingWeb,
}));

const { initDatabase, getDb, setSetting } = await import('../server/db.js');
const { default: approvalRouter } = await import('../server/routes/attendance/approval.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', approvalRouter);
  return app;
}

function seedOAuth() {
  setSetting('oauth_configured', '1');
  setSetting('oauth_company_id', '12345');
  setSetting('oauth_employee_id', '67890');
  setSetting('oauth_company_name', 'Example Corp');
}

function routeResponse() {
  return {
    approval_flow_routes: [
      {
        id: 2468,
        usages: ['AttendanceWorkflow'],
      },
    ],
  };
}

beforeEach(() => {
  initDatabase();
  getDb().prepare('DELETE FROM execution_log').run();
  seedOAuth();

  mocks.apiRequest.mockReset();
  mocks.ensureValidToken.mockReset();
  mocks.hasWebCredentials.mockReset();
  mocks.submitMonthlyAttendanceClosingWeb.mockReset();

  mocks.ensureValidToken.mockResolvedValue('unit-test-access');
  mocks.hasWebCredentials.mockReturnValue(true);
});

describe('monthly attendance closing route', () => {
  it.each([
    [{ year: 2026, month: 0 }],
    [{ year: 2026, month: 13 }],
    [{ year: '2026x', month: 5 }],
    [{ year: 1999, month: 5 }],
    [{ year: 2026, month: '05x' }],
  ])('rejects an invalid monthly target: %j', async (body) => {
    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTHLY_TARGET');
    expect(mocks.apiRequest).not.toHaveBeenCalled();
    expect(mocks.submitMonthlyAttendanceClosingWeb).not.toHaveBeenCalled();
  });

  it('submits monthly closing with target_year and target_month payload', async () => {
    mocks.apiRequest.mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return routeResponse();
      }
      if (method === 'POST' && path === '/approval_requests/monthly_attendances') {
        return { monthly_attendance: { id: 1001, ...body } };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      'POST',
      '/approval_requests/monthly_attendances',
      {
        company_id: 12345,
        target_year: 2026,
        target_month: 5,
        approval_flow_route_id: 2468,
      },
    );
    expect(mocks.submitMonthlyAttendanceClosingWeb).not.toHaveBeenCalled();
  });

  it('includes a confirmed route approver when freee requires one', async () => {
    mocks.apiRequest.mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return {
          approval_flow_routes: [
            {
              id: 2468,
              name: '指定 route',
              usages: ['AttendanceWorkflow'],
              user_id: 8642,
            },
          ],
        };
      }
      if (method === 'POST' && path === '/approval_requests/monthly_attendances') {
        return { monthly_attendance: { id: 1001, ...body } };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(200);
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      'POST',
      '/approval_requests/monthly_attendances',
      expect.objectContaining({ approver_id: 8642 }),
    );
  });

  it('does not send an invalid API request when no route can be confirmed', async () => {
    mocks.hasWebCredentials.mockReturnValue(false);
    mocks.apiRequest.mockResolvedValueOnce({ approval_flow_routes: [] });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPROVAL_ROUTE_UNCONFIRMED');
    expect(
      mocks.apiRequest.mock.calls.some(([method]) => method === 'POST'),
    ).toBe(false);
  });

  it('stops when a successful API response has no confirmed request id', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return routeResponse();
      }
      if (method === 'POST') return { monthly_attendance: {} };
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('API_RESPONSE_UNCONFIRMED');
    expect(mocks.submitMonthlyAttendanceClosingWeb).not.toHaveBeenCalled();
  });

  it('treats an already-submitted monthly closing API response as success', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return routeResponse();
      }
      const error = new Error('Monthly closing already submitted');
      error.code = FREEE_API_ERROR_CODES.MONTHLY_CLOSING_ALREADY_SUBMITTED;
      throw error;
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      alreadySubmitted: true,
      via: 'api',
    });
    expect(mocks.submitMonthlyAttendanceClosingWeb).not.toHaveBeenCalled();
  });

  it('falls back to web submission when freee requires web monthly closing', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return routeResponse();
      }
      const error = new Error('Monthly closing requires the Web form');
      error.code = FREEE_API_ERROR_CODES.WEB_FORM_REQUIRED;
      throw error;
    });
    mocks.submitMonthlyAttendanceClosingWeb.mockResolvedValue({
      success: true,
      alreadySubmitted: false,
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      via: 'web',
    });
    expect(mocks.submitMonthlyAttendanceClosingWeb).toHaveBeenCalledWith(2026, 5, {
      companyId: '12345',
      employeeId: '67890',
      companyName: 'Example Corp',
      generation: '1',
    });
  });

  it('returns an actionable error when web monthly closing is required but credentials are missing', async () => {
    mocks.hasWebCredentials.mockReturnValue(false);
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return routeResponse();
      }
      const error = new Error('Monthly closing requires the Web form');
      error.code = FREEE_API_ERROR_CODES.WEB_FORM_REQUIRED;
      throw error;
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'WEB_CREDENTIALS_REQUIRED',
    });
    expect(mocks.submitMonthlyAttendanceClosingWeb).not.toHaveBeenCalled();
  });

  it('submits directly through Web automation when OAuth is unavailable', async () => {
    setSetting('oauth_configured', '0');
    mocks.submitMonthlyAttendanceClosingWeb.mockResolvedValue({
      success: true,
      alreadySubmitted: false,
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, via: 'web' });
    expect(mocks.apiRequest).not.toHaveBeenCalled();
    expect(mocks.ensureValidToken).not.toHaveBeenCalled();
    expect(mocks.submitMonthlyAttendanceClosingWeb).toHaveBeenCalledWith(2026, 5, null);
  });

  it('fails closed when neither OAuth nor Web credentials are available', async () => {
    setSetting('oauth_configured', '0');
    mocks.hasWebCredentials.mockReturnValue(false);

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MONTHLY_CLOSING_CREDENTIALS_REQUIRED');
    expect(mocks.apiRequest).not.toHaveBeenCalled();
    expect(mocks.submitMonthlyAttendanceClosingWeb).not.toHaveBeenCalled();
  });

  it('returns an actionable error when a Web-only account has no company target', async () => {
    setSetting('oauth_configured', '0');
    mocks.submitMonthlyAttendanceClosingWeb.mockResolvedValue({
      success: false,
      error: 'web_company_target_required',
      errorCode: 'WEB_COMPANY_TARGET_REQUIRED',
    });

    const res = await request(createApp())
      .post('/api/attendance/approval/monthly')
      .send({ year: 2026, month: 5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEB_COMPANY_TARGET_REQUIRED');
  });
});
