import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  ensureValidToken: vi.fn(),
  hasWebCredentials: vi.fn(),
  submitLeaveRequest: vi.fn(),
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
  submitLeaveRequest: mocks.submitLeaveRequest,
}));

const { getDb, initDatabase, setSetting } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { assertWebAccountBinding } = await import(
  '../server/automation/identity.js'
);
const { default: leaveRouter } = await import(
  '../server/routes/attendance/leave.js'
);
const { getTask, waitForAsyncTasksIdle } = await import(
  '../server/async-tasks.js'
);

function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/attendance/batch/status/:taskId', (req, res) => {
    const task = getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json(task);
  });
  app.use('/api/attendance', leaveRouter);
  return app;
}

function emptyRecord(date) {
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
  };
}

function selectWebIdentity(username, employeeId, companyName, generation) {
  setSetting('connection_mode', 'browser');
  setSetting('oauth_configured', '0');
  setSetting('freee_configured', '1');
  setSetting('freee_username_encrypted', encrypt(username));
  setSetting('freee_password_encrypted', encrypt('synthetic-password'));
  setSetting('web_employee_id_encrypted', encrypt(employeeId));
  setSetting('web_company_name', companyName);
  setSetting('web_identity_generation', generation);
}

async function waitForTask(app, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/attendance/batch/status/${taskId}`);
    expect(response.status, response.text).toBe(200);
    expect(['running', 'completed', 'failed', 'interrupted'], response.text).toContain(response.body.status);
    if (response.body.status !== 'running') return response.body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('leave task did not finish');
}

beforeEach(() => {
  initDatabase();
  getDb().prepare('DELETE FROM execution_log').run();
  setSetting('connection_mode', 'api');
  setSetting('debug_mode', '0');
  setSetting('oauth_configured', '1');
  setSetting('oauth_company_id', '12345');
  setSetting('oauth_employee_id', '67890');
  setSetting('oauth_company_name', 'Example Corp');
  setSetting('freee_configured', '0');
  setSetting('freee_username_encrypted', '');
  setSetting('freee_password_encrypted', '');
  setSetting('web_employee_id_encrypted', '');
  setSetting('web_company_name', '');
  setSetting('web_identity_generation', '0');

  Object.assign(mocks.oauthBinding, {
    companyId: '12345',
    employeeId: '67890',
    companyName: 'Example Corp',
    generation: '1',
  });

  mocks.apiRequest.mockReset();
  mocks.ensureValidToken.mockReset();
  mocks.hasWebCredentials.mockReset();
  mocks.submitLeaveRequest.mockReset();

  mocks.ensureValidToken.mockResolvedValue('synthetic-access');
  mocks.hasWebCredentials.mockReturnValue(true);
  mocks.submitLeaveRequest.mockResolvedValue({ success: true, guard: 'verified' });
  mocks.apiRequest.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path.includes('/work_records/')) {
      const date = path.match(/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1];
      return emptyRecord(date);
    }
    if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
      return {
        approval_flow_routes: [{ id: 2468, usages: ['AttendanceWorkflow'] }],
      };
    }
    if (method === 'GET' && path === '/users/me') return { id: 8642 };
    if (method === 'GET' && path.startsWith('/approval_requests/paid_holidays?')) {
      return { paid_holidays: [] };
    }
    if (method === 'POST' && path === '/approval_requests/paid_holidays') {
      return { paid_holiday: { id: body.target_date.endsWith('18') ? 9753 : 9754 } };
    }
    throw new Error(`unexpected API call: ${method} ${path}`);
  });
});

describe('leave request routes', () => {
  it('does not acknowledge a batch when task admission fails', async () => {
    getDb().exec("CREATE TEMP TRIGGER reject_task BEFORE INSERT ON async_tasks BEGIN SELECT RAISE(ABORT,'synthetic admission'); END");
    try {
      const response = await request(createApp()).post('/api/attendance/batch-leave-request')
        .send({ type: 'PaidHoliday', dates: ['2026-05-18'] });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('TASK_PERSISTENCE_FAILED');
      expect(mocks.apiRequest).not.toHaveBeenCalled();
      expect(mocks.submitLeaveRequest).not.toHaveBeenCalled();
    } finally { getDb().exec('DROP TRIGGER reject_task'); }
  });

  it('retains each leave result and stops after an audit checkpoint failure', async () => {
    getDb().exec("CREATE TEMP TRIGGER reject_second_leave BEFORE INSERT ON execution_log WHEN NEW.action_type='leave_request' AND NEW.scheduled_time='2026-05-19' BEGIN SELECT RAISE(ABORT,'synthetic checkpoint'); END");
    try {
      const app = createApp();
      const accepted = await request(app).post('/api/attendance/batch-leave-request')
        .send({ type: 'PaidHoliday', dates: ['2026-05-18', '2026-05-19', '2026-05-20'] });
      await expect(waitForAsyncTasksIdle(2000)).resolves.toBe(true);
      const task = getTask(accepted.body.task_id);
      expect(task).toMatchObject({ status: 'failed', total: 3, processed: 2, succeeded: 1, failed: 0, unknown: 1, partial: true });
      expect(task.results[0]).toMatchObject({ date: '2026-05-18', success: true });
      expect(task.results[1]).toMatchObject({ date: '2026-05-19', success: false, unknown: true });
      expect(mocks.apiRequest.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2);
      const logs = getDb().prepare("SELECT * FROM execution_log WHERE action_type='leave_request'").all();
      expect(logs).toHaveLength(1);
      expect(logs[0].error_message).toContain(`task_id=${task.taskId}`);
      initDatabase();
      expect(getTask(accepted.body.task_id)).toEqual(task);
    } finally { getDb().exec('DROP TRIGGER reject_second_leave'); }
  });

  it('never advertises direct editing for an unconfirmed empty record', async () => {
    mocks.apiRequest.mockResolvedValue({});
    const response = await request(createApp()).post('/api/attendance/detect-strategy').send({ force: true });
    expect(response.status).toBe(200);
    expect(response.body.direct_ok).toBe(false);
  });

  it('uses the Tokyo calendar date for strategy probes near UTC midnight', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-12T15:30:00.000Z'));
      const response = await request(createApp())
        .post('/api/attendance/detect-strategy')
        .send({ force: true });

      expect(response.status).toBe(200);
      expect(mocks.apiRequest).toHaveBeenCalledWith(
        'GET',
        '/employees/67890/work_records/2026-07-13?company_id=12345',
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid input before OAuth or upstream calls', async () => {
    const response = await request(createApp())
      .post('/api/attendance/leave-request')
      .send({ type: 'PaidHoliday', date: '2026-02-30' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_LEAVE_REQUEST');
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it('submits a current-schema paid leave approval through the real route', async () => {
    const response = await request(createApp())
      .post('/api/attendance/leave-request')
      .send({
        type: 'PaidHoliday',
        date: '2026-05-18',
        holiday_type: 'afternoon_off',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      method: 'approval',
      id: 9753,
    });
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      'POST',
      '/approval_requests/paid_holidays',
      {
        company_id: 12345,
        target_date: '2026-05-18',
        approval_flow_route_id: 2468,
        values: [{ type: 'afternoon' }],
      },
    );
  });

  it('keeps explicit Web-only operation after its Web guard is verified', async () => {
    selectWebIdentity(
      'browser-only@example.test',
      '3003',
      'Browser Fixture',
      '7',
    );

    const response = await request(createApp())
      .post('/api/attendance/leave-request')
      .send({ type: 'PaidHoliday', date: '2026-05-18' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      method: 'web',
      guard: 'verified',
    });
    expect(mocks.submitLeaveRequest).toHaveBeenCalledOnce();
    expect(mocks.submitLeaveRequest.mock.calls[0][3]).toMatchObject({
      kind: 'web',
      webBinding: {
        companyName: 'Browser Fixture',
        employeeId: '3003',
        generation: '7',
        fingerprint: expect.stringMatching(/^v1:[a-f0-9]{64}$/),
      },
    });
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it('passes the request-entry OAuth snapshot to an allowlisted Web fallback', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18');
      }
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return {
          approval_flow_routes: [{ id: 2468, usages: ['AttendanceWorkflow'] }],
        };
      }
      if (method === 'POST' && path === '/approval_requests/paid_holidays') {
        throw Object.assign(new Error('synthetic deterministic rejection'), {
          code: 'PERMISSION_DENIED',
        });
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/paid_holidays?')) {
        return { paid_holidays: [] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const response = await request(createApp())
      .post('/api/attendance/leave-request')
      .send({ type: 'PaidHoliday', date: '2026-05-18' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, method: 'web' });
    expect(mocks.submitLeaveRequest).toHaveBeenCalledWith(
      'PaidHoliday',
      '2026-05-18',
      expect.any(Object),
      {
        companyId: '12345',
        employeeId: '67890',
        companyName: 'Example Corp',
        generation: '1',
      },
    );
  });

  it('reuses one verified approval route across a batch and keeps one result per date', async () => {
    const app = createApp();
    const started = await request(app)
      .post('/api/attendance/batch-leave-request')
      .send({
        type: 'PaidHoliday',
        dates: ['2026-05-18', '2026-05-19'],
      });

    expect(started.status).toBe(200);
    const result = await waitForTask(app, started.body.task_id);

    expect(result).toMatchObject({
      status: 'completed',
      success: true,
      total: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(result.results.map(entry => entry.date)).toEqual([
      '2026-05-18',
      '2026-05-19',
    ]);
    expect(
      mocks.apiRequest.mock.calls.filter(
        ([method, path]) => method === 'GET' && path.startsWith('/approval_flow_routes?'),
      ),
    ).toHaveLength(1);
  });

  it('freezes one Browser account binding across every date in a batch', async () => {
    const accountA = [
      'browser-a@example.test',
      '3003',
      'Browser Fixture',
      '11',
    ];
    const accountB = [
      'browser-b@example.test',
      '4004',
      'Other Browser Fixture',
      '12',
    ];
    selectWebIdentity(...accountA);
    let confirmedWrites = 0;
    mocks.submitLeaveRequest.mockImplementation(
      async (type, date, options, expectedCompany) => {
        expect(type).toBe('PaidHoliday');
        expect(options).toEqual(expect.any(Object));
        assertWebAccountBinding(expectedCompany.webBinding);
        confirmedWrites += 1;
        if (date === '2026-05-18') selectWebIdentity(...accountB);
        return { success: true, guard: 'verified' };
      },
    );

    const app = createApp();
    const started = await request(app)
      .post('/api/attendance/batch-leave-request')
      .send({
        type: 'PaidHoliday',
        dates: ['2026-05-18', '2026-05-19'],
      });

    expect(started.status).toBe(200);
    await expect(waitForAsyncTasksIdle(5_000)).resolves.toBe(true);
    selectWebIdentity(...accountA);
    const result = await waitForTask(app, started.body.task_id);

    expect(result).toMatchObject({
      status: 'completed',
      success: false,
      total: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(result.results[0]).toMatchObject({
      date: '2026-05-18',
      success: true,
      method: 'web',
    });
    expect(result.results[1]).toMatchObject({
      date: '2026-05-19',
      success: false,
      method: 'web',
      error: 'web_submission_failed',
      stages: expect.arrayContaining([
        {
          stage: 'web',
          success: false,
          code: 'WEB_ACCOUNT_IDENTITY_CHANGED',
        },
      ]),
    });
    expect(confirmedWrites).toBe(1);
    expect(mocks.submitLeaveRequest.mock.calls[0][3]).toBe(
      mocks.submitLeaveRequest.mock.calls[1][3],
    );
  });

  it('returns only bounded special-leave option fields', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.includes('/special_holidays?')) {
        return {
          employee_special_holidays: [
            {
              id: 9999,
              company_id: 12345,
              employee_id: 67890,
              special_holiday_setting_id: 1357,
              name: 'Synthetic leave',
              usage_day: 'full',
              num_days_and_hours_left: { days: 2, hours: 0 },
              internal_note: 'must not be returned',
            },
          ],
        };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const response = await request(createApp())
      .get('/api/attendance/special-holiday-options')
      .query({ date: '2026-05-18' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      date: '2026-05-18',
      options: [
        {
          setting_id: 1357,
          name: 'Synthetic leave',
          usage_day: 'full',
          usage_days: ['full'],
          remaining_days: 2,
          remaining_hours: 0,
        },
      ],
    });
  });
});
