import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  ensureValidToken: vi.fn(),
  hasWebCredentials: vi.fn(),
  submitMonthlyAttendanceClosingWeb: vi.fn(),
}));

vi.mock('../server/freee-api.js', () => ({
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

  it('treats an already-submitted monthly closing API response as success', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return routeResponse();
      }
      throw new Error('API_ERROR_400: 既に月次勤怠締め申請が行われています');
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
      throw new Error('API_ERROR_400: 役職、部門を利用する申請はWebから申請してください');
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
    expect(mocks.submitMonthlyAttendanceClosingWeb).toHaveBeenCalledWith(2026, 5);
  });

  it('returns an actionable error when web monthly closing is required but credentials are missing', async () => {
    mocks.hasWebCredentials.mockReturnValue(false);
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/approval_flow_routes?company_id=12345') {
        return routeResponse();
      }
      throw new Error('API_ERROR_400: 役職、部門を利用する申請はWebから申請してください');
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
});
