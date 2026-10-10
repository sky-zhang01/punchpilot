import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  ensureValidToken: vi.fn(),
  hasWebCredentials: vi.fn(),
  withdrawWeb: vi.fn(),
  monthlyWeb: vi.fn(),
  oauthBinding: {
    companyId: '12345',
    employeeId: '67890',
    companyName: 'Example Corp',
    generation: '1',
  },
}));

vi.mock('../server/freee-api.js', () => ({
  FREEE_AUTH_ERROR_CODES: {
    COMPANY_SELECTION_REQUIRED: 'OAUTH_COMPANY_SELECTION_REQUIRED',
  },
  FREEE_API_ERROR_CODES: {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    API_TRANSIENT: 'API_TRANSIENT',
    API_RESPONSE_UNCONFIRMED: 'API_RESPONSE_UNCONFIRMED',
    MONTHLY_CLOSING_ALREADY_SUBMITTED: 'MONTHLY_CLOSING_ALREADY_SUBMITTED',
    WEB_FORM_REQUIRED: 'WEB_FORM_REQUIRED',
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
  hasWebCredentials: mocks.hasWebCredentials,
  withdrawApprovalRequestWeb: mocks.withdrawWeb,
  submitMonthlyAttendanceClosingWeb: mocks.monthlyWeb,
}));

const { getDb, initDatabase, setSetting } = await import('../server/db.js');
const { default: approvalRouter } = await import(
  '../server/routes/attendance/approval.js'
);
const { default: batchOperationsRouter } = await import(
  '../server/routes/attendance/batch-operations.js'
);
const { createApprovalMutationContext } = await import(
  '../server/routes/attendance/approval-list-service.js'
);
const { getTask, waitForAsyncTasksIdle } = await import('../server/async-tasks.js');

const RESPONSE_KEYS = {
  work_times: 'work_time',
  paid_holidays: 'paid_holiday',
  overtime_works: 'overtime_work',
  special_holidays: 'special_holiday',
  monthly_attendances: 'monthly_attendance',
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/attendance/batch/status/:taskId', (req, res) => {
    const task = getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json(task);
  });
  app.use('/api/attendance', approvalRouter);
  app.use('/api/attendance', batchOperationsRouter);
  return app;
}

function approvalDetail(type = 'PaidHoliday', overrides = {}) {
  const key = {
    PaidHoliday: 'paid_holiday',
    WorkTime: 'work_time',
  }[type];
  return {
    [key]: {
      id: 9753,
      company_id: 12345,
      applicant_id: 7531,
      approver_ids: [8642],
      status: 'in_progress',
      current_round: 1,
      current_step_id: 2468,
      target_date: '2026-05-18',
      ...overrides,
    },
  };
}

function approvalActionRequest({
  action = 'approve',
  detailOverrides = {},
  expectedOverrides = {},
} = {}) {
  const detail = approvalDetail('PaidHoliday', detailOverrides).paid_holiday;
  const context = createApprovalMutationContext({
    request: detail,
    companyId: mocks.oauthBinding.companyId,
    currentUserId: 8642,
    type: 'PaidHoliday',
  });
  return {
    id: detail.id,
    type: 'PaidHoliday',
    action,
    expected: { ...context, ...expectedOverrides },
  };
}

function approvalActionResponse(action = 'approve', overrides = {}) {
  return approvalDetail('PaidHoliday', {
    status: action === 'cancel' ? 'draft' : action === 'feedback' ? 'feedback' : 'approved',
    approval_flow_logs: [{ user_id: 8642, action }],
    ...overrides,
  });
}

function approvalListItem(overrides = {}) {
  const detail = approvalDetail('PaidHoliday', overrides).paid_holiday;
  const {
    current_round: _currentRound,
    current_step_id: _currentStepId,
    ...listItem
  } = detail;
  return listItem;
}

async function waitForTask(app, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/attendance/batch/status/${taskId}`);
    if (response.body.status !== 'running') return response.body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('approval task did not finish');
}

beforeEach(() => {
  initDatabase();
  getDb().prepare('DELETE FROM async_tasks').run();
  setSetting('oauth_configured', '1');
  setSetting('oauth_company_id', '12345');
  setSetting('oauth_employee_id', '67890');
  setSetting('oauth_company_name', 'Example Corp');

  mocks.apiRequest.mockReset();
  mocks.ensureValidToken.mockReset().mockResolvedValue('synthetic-access');
  mocks.hasWebCredentials.mockReset().mockReturnValue(true);
  mocks.withdrawWeb.mockReset().mockResolvedValue({ success: true });
  mocks.monthlyWeb.mockReset().mockResolvedValue({ success: true });
});

describe('approval mutation routes', () => {
  it.each([true, [9753], { id: 9753 }, '9e3', ' 9753', '09753'])(
    'rejects coercible request ids before any upstream call: %j', async (id) => {
      const response = await request(createApp()).post('/api/attendance/batch-withdraw')
        .send({ requests: [{ id, type: 'PaidHoliday' }] });
      expect(response.status).toBe(400);
      expect(mocks.ensureValidToken).not.toHaveBeenCalled();
      expect(mocks.apiRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['withdraw', 'approve'])('does not admit %s without a durable task', async (operation) => {
    getDb().exec("CREATE TEMP TRIGGER reject_task BEFORE INSERT ON async_tasks BEGIN SELECT RAISE(ABORT,'synthetic admission'); END");
    try {
      const response = await request(createApp()).post(`/api/attendance/batch-${operation}`)
        .send({ requests: [operation === 'approve' ? approvalActionRequest() : { id: 9753, type: 'PaidHoliday' }] });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('TASK_PERSISTENCE_FAILED');
      expect(mocks.apiRequest).not.toHaveBeenCalled();
    } finally { getDb().exec('DROP TRIGGER reject_task'); }
  });

  it.each(['withdraw', 'approve'])('checkpoints each %s and stops after a failed second checkpoint', async (operation) => {
    const requests = [9753, 9754, 9755].map(id => ({
      id, type: 'PaidHoliday', ...(operation === 'approve' ? {
        action: 'approve', expected: createApprovalMutationContext({
          request: approvalDetail('PaidHoliday', { id, applicant_id: 8642 }).paid_holiday,
          companyId: 12345, currentUserId: 8642, type: 'PaidHoliday',
        }),
      } : {}),
    }));
    mocks.apiRequest.mockImplementation(async (method, path, body) => {
      if (path === '/users/me') return { id: 8642 };
      const id = Number(path.match(/paid_holidays\/(\d+)/)?.[1]);
      if (method === 'GET') return approvalDetail('PaidHoliday', { id, applicant_id: 8642 });
      if (method === 'POST') return approvalActionResponse(body.approval_action, { id, applicant_id: 8642 });
      throw new Error('unexpected fixture operation');
    });
    getDb().exec("CREATE TEMP TRIGGER reject_second_result BEFORE UPDATE OF result_json ON async_tasks WHEN json_array_length(NEW.result_json,'$.results')=2 BEGIN SELECT RAISE(ABORT,'synthetic checkpoint'); END");
    try {
      const app = createApp();
      const accepted = await request(app).post(`/api/attendance/batch-${operation}`).send({ requests });
      expect(accepted.status).toBe(200);
      await expect(waitForAsyncTasksIdle(2000)).resolves.toBe(true);
      const task = getTask(accepted.body.task_id);
      expect(task).toMatchObject({ status: 'failed', total: 3, processed: 2, succeeded: 1, failed: 0, unknown: 1, partial: true });
      expect(task.results[0]).toMatchObject({ id: 9753, success: true });
      expect(task.results[1]).toMatchObject({ id: 9754, success: false, unknown: true });
      expect(mocks.apiRequest.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2);
      initDatabase();
      expect(getTask(accepted.body.task_id)).toEqual(task);
    } finally { getDb().exec('DROP TRIGGER reject_second_result'); }
  });

  it('rejects malformed batch approval input before OAuth calls', async () => {
    const response = await request(createApp())
      .post('/api/attendance/batch-approve')
      .send({ requests: [{ id: '../1', type: 'PaidHoliday', action: 'approve' }] });

    expect(response.status).toBe(400);
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'rejects inherited object property names at the batch route: %s',
    async (type) => {
      const response = await request(createApp())
        .post('/api/attendance/batch-approve')
        .send({ requests: [{ id: 9753, type, action: 'approve' }] });

      expect(response.status).toBe(400);
      expect(mocks.apiRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing expected context', { id: 9753, type: 'PaidHoliday', action: 'approve' }],
    ['missing expected step', approvalActionRequest({
      expectedOverrides: { current_step_id: undefined },
    })],
    ['malformed expected step', approvalActionRequest({
      expectedOverrides: { current_step_id: '2468' },
    })],
  ])('rejects %s before OAuth calls', async (_label, body) => {
    const response = await request(createApp())
      .post('/api/attendance/batch-approve')
      .send({ requests: [body] });

    expect(response.status).toBe(400);
    expect(mocks.ensureValidToken).not.toHaveBeenCalled();
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it('rejects inherited object property names at the single withdrawal route', async () => {
    const response = await request(createApp())
      .delete('/api/attendance/approval-requests/9753')
      .query({ type: 'constructor' });

    expect(response.status).toBe(400);
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it('rechecks current user and ownership before a complete approval action', async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({ id: 8642 })
      .mockResolvedValueOnce(approvalDetail())
      .mockResolvedValueOnce(approvalActionResponse());
    const app = createApp();
    const started = await request(app)
      .post('/api/attendance/batch-approve')
      .send({ requests: [approvalActionRequest()] });
    const result = await waitForTask(app, started.body.task_id);

    expect(result).toMatchObject({
      status: 'completed',
      success: true,
      succeeded: 1,
      failed: 0,
    });
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      3,
      'POST',
      '/approval_requests/paid_holidays/9753/actions?company_id=12345',
      {
        company_id: 12345,
        approval_action: 'approve',
        target_round: 1,
        target_step_id: 2468,
      },
    );
  });

  it('confirms an unspecified approver through the scoped list before mutation', async () => {
    const unspecified = approvalDetail('PaidHoliday', { approver_ids: [] }).paid_holiday;
    mocks.apiRequest
      .mockResolvedValueOnce({ id: 8642 })
      .mockResolvedValueOnce({ paid_holiday: unspecified })
      .mockResolvedValueOnce({ paid_holidays: [unspecified] })
      .mockResolvedValueOnce({ paid_holiday: unspecified })
      .mockResolvedValueOnce(approvalActionResponse());
    const app = createApp();

    const started = await request(app)
      .post('/api/attendance/batch-approve')
      .send({
        requests: [approvalActionRequest({
          detailOverrides: { approver_ids: [] },
        })],
      });
    const result = await waitForTask(app, started.body.task_id);

    expect(result).toMatchObject({ status: 'completed', success: true });
    const scopedListPath = mocks.apiRequest.mock.calls[2][1];
    const query = new URL(`https://example.invalid${scopedListPath}`).searchParams;
    expect(query.get('approver_id')).toBe('8642');
    expect(query.get('start_target_date')).toBe('2026-05-01');
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      5,
      'POST',
      '/approval_requests/paid_holidays/9753/actions?company_id=12345',
      expect.objectContaining({ approval_action: 'approve' }),
    );
  });

  it('rejects a stale observed step without issuing an approval action', async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({ id: 8642 })
      .mockResolvedValueOnce(approvalDetail('PaidHoliday', {
        current_step_id: 3579,
      }));
    const app = createApp();

    const started = await request(app)
      .post('/api/attendance/batch-approve')
      .send({ requests: [approvalActionRequest()] });
    const result = await waitForTask(app, started.body.task_id);

    expect(result).toMatchObject({
      status: 'completed',
      success: false,
      succeeded: 0,
      failed: 1,
      results: [{ error: 'approval_version_conflict' }],
    });
    expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
    expect(mocks.apiRequest.mock.calls.some(([method]) => method === 'POST')).toBe(false);
  });

  it('does not DELETE or use Web after an ambiguous cancel response', async () => {
    const error = Object.assign(new Error('synthetic timeout'), {
      code: 'API_TRANSIENT',
    });
    mocks.apiRequest
      .mockResolvedValueOnce({ id: 7531 })
      .mockResolvedValueOnce(approvalDetail())
      .mockRejectedValueOnce(error);

    const response = await request(createApp())
      .delete('/api/attendance/approval-requests/9753')
      .query({ type: 'PaidHoliday' });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('mutation_outcome_unconfirmed');
    expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
    expect(mocks.withdrawWeb).not.toHaveBeenCalled();
  });

  it('passes the request-entry OAuth snapshot to a deterministic Web withdrawal fallback', async () => {
    const error = Object.assign(new Error('synthetic deterministic rejection'), {
      code: 'PERMISSION_DENIED',
    });
    mocks.apiRequest
      .mockResolvedValueOnce({ id: 7531 })
      .mockResolvedValueOnce(approvalDetail())
      .mockRejectedValueOnce(error);

    const response = await request(createApp())
      .delete('/api/attendance/approval-requests/9753')
      .query({ type: 'PaidHoliday' });

    expect(response.status).toBe(200);
    expect(mocks.withdrawWeb).toHaveBeenCalledWith('PaidHoliday', 9753, {
      companyId: '12345',
      employeeId: '67890',
      companyName: 'Example Corp',
      generation: '1',
    });
  });

  it('keeps the same OAuth snapshot in an asynchronous batch withdrawal fallback', async () => {
    const error = Object.assign(new Error('synthetic deterministic rejection'), {
      code: 'PERMISSION_DENIED',
    });
    mocks.apiRequest
      .mockResolvedValueOnce({ id: 7531 })
      .mockResolvedValueOnce(approvalDetail())
      .mockRejectedValueOnce(error);
    const app = createApp();

    const started = await request(app)
      .post('/api/attendance/batch-withdraw')
      .send({ requests: [{ id: 9753, type: 'PaidHoliday' }] });
    const result = await waitForTask(app, started.body.task_id);

    expect(result).toMatchObject({ status: 'completed', success: true });
    expect(mocks.withdrawWeb).toHaveBeenCalledWith('PaidHoliday', 9753, {
      companyId: '12345',
      employeeId: '67890',
      companyName: 'Example Corp',
      generation: '1',
    });
  });
});

describe('approval list routes', () => {
  it('binds every personal request query to current applicant and month', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      const endpoint = path.match(/^\/approval_requests\/([^?]+)/)?.[1];
      const singular = RESPONSE_KEYS[endpoint];
      if (!singular) throw new Error(`unexpected API call: ${method} ${path}`);
      const params = new URL(`https://example.invalid${path}`).searchParams;
      const plural = `${singular}s`;
      if (
        endpoint === 'paid_holidays' &&
        params.get('status') === 'approved'
      ) {
        return {
          [plural]: [
            approvalDetail('PaidHoliday', {
              applicant_id: 8642,
              status: 'approved',
            }).paid_holiday,
          ],
        };
      }
      return { [plural]: [] };
    });

    const response = await request(createApp())
      .get('/api/attendance/approval-requests')
      .query({ year: 2026, month: 5 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ complete: true });
    expect(response.body.requests).toHaveLength(1);
    const listPaths = mocks.apiRequest.mock.calls
      .filter(([method, path]) => method === 'GET' && path.includes('/approval_requests/'))
      .map(([, path]) => path);
    expect(listPaths).toHaveLength(15);
    for (const path of listPaths) {
      const query = new URL(`https://example.invalid${path}`).searchParams;
      expect(query.get('applicant_id')).toBe('8642');
      expect(query.get('start_target_date')).toBe('2026-05-01');
      expect(query.get('end_target_date')).toBe('2026-05-31');
    }
  });

  it('binds incoming queries to current approver and keeps unspecified-route records', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      const detailMatch = path.match(
        /^\/approval_requests\/([^/]+)\/([1-9]\d*)\?company_id=12345$/,
      );
      if (detailMatch) {
        const [, endpoint, idText] = detailMatch;
        if (endpoint !== 'paid_holidays') {
          throw new Error(`unexpected detail API call: ${method} ${path}`);
        }
        const id = Number(idText);
        return approvalDetail('PaidHoliday', {
          id,
          ...(id === 9754 ? { approver_ids: [] } : {}),
        });
      }
      const endpoint = path.match(/^\/approval_requests\/([^/?]+)\?/)?.[1];
      const singular = RESPONSE_KEYS[endpoint];
      if (!singular) throw new Error(`unexpected API call: ${method} ${path}`);
      const plural = `${singular}s`;
      if (endpoint === 'paid_holidays') {
        return {
          [plural]: [
            approvalListItem(),
            approvalListItem({
              id: 9754,
              approver_ids: [],
            }),
          ],
        };
      }
      return { [plural]: [] };
    });

    const response = await request(createApp())
      .get('/api/attendance/incoming-requests')
      .query({ year: 2026, month: 5 });

    expect(response.status).toBe(200);
    expect(response.body.requests.map((item) => item.id)).toEqual([9753, 9754]);
    for (const item of response.body.requests) {
      expect(item.approval_context).toMatchObject({
        current_round: 1,
        current_step_id: 2468,
        request_version: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/),
      });
    }
    for (const [, path] of mocks.apiRequest.mock.calls.filter(
      ([method, path]) =>
        method === 'GET' && /^\/approval_requests\/[^/?]+\?/.test(path),
    )) {
      expect(new URL(`https://example.invalid${path}`).searchParams.get('approver_id'))
        .toBe('8642');
    }
    const detailPaths = mocks.apiRequest.mock.calls
      .filter(([method, path]) =>
        method === 'GET' && /^\/approval_requests\/[^/]+\/[1-9]\d*\?/.test(path),
      )
      .map(([, path]) => path);
    expect(detailPaths).toEqual([
      '/approval_requests/paid_holidays/9753?company_id=12345',
      '/approval_requests/paid_holidays/9754?company_id=12345',
    ]);
  });

  it('marks an incoming type incomplete when its detail lacks a current step', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (path === '/approval_requests/paid_holidays/9753?company_id=12345') {
        return approvalDetail('PaidHoliday', { current_step_id: null });
      }
      const endpoint = path.match(/^\/approval_requests\/([^/?]+)\?/)?.[1];
      const singular = RESPONSE_KEYS[endpoint];
      if (!singular) throw new Error(`unexpected API call: ${method} ${path}`);
      return {
        [`${singular}s`]: endpoint === 'paid_holidays'
          ? [approvalListItem()]
          : [],
      };
    });

    const response = await request(createApp())
      .get('/api/attendance/incoming-requests')
      .query({ year: 2026, month: 5 });

    expect(response.status).toBe(200);
    expect(response.body.requests).toEqual([]);
    expect(response.body.complete).toBe(false);
    expect(response.body.unavailable_types).toContain('PaidHoliday');
  });
});

describe('employee information minimization', () => {
  it('does not return account ids, role, birth date, or retirement date', async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({
        id: 8642,
        companies: [
          {
            id: 12345,
            name: 'Synthetic company',
            display_name: 'Synthetic user',
            role: 'company_admin',
          },
        ],
      })
      .mockResolvedValueOnce({
        num: 'S-001',
        entry_date: '2020-01-01',
        birth_date: '1990-01-01',
        retire_date: null,
        profile_rule: { employment_type: 'employee', title: 'Engineer' },
      });

    const response = await request(createApp()).get('/api/attendance/employee-info');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      company_name: 'Synthetic company',
      display_name: 'Synthetic user',
      num: 'S-001',
      entry_date: '2020-01-01',
      employment_type: 'employee',
      title: 'Engineer',
      data_source: 'employee_api',
    });
  });
});
