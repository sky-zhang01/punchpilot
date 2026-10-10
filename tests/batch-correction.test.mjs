import express from 'express';
import { once } from 'node:events';
import { createServer } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  ensureValidToken: vi.fn(),
  hasWebCredentials: vi.fn(),
  submitWebCorrections: vi.fn(),
  accountOperationAcquire: null,
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
  API_RESPONSE_UNCONFIRMED: 'API_RESPONSE_UNCONFIRMED',
  DIRECT_EDIT_DISABLED: 'DIRECT_EDIT_DISABLED',
  MONTHLY_CLOSING_ALREADY_SUBMITTED: 'MONTHLY_CLOSING_ALREADY_SUBMITTED',
  WEB_ONLY_LEAVE_COMBINATION: 'WEB_ONLY_LEAVE_COMBINATION',
  WEB_FORM_REQUIRED: 'WEB_FORM_REQUIRED',
};

const EXPECTED_COMPANY = {
  ...mocks.oauthBinding,
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
      try {
        return await mocks.apiRequest(method, path, body);
      } catch (error) {
        const wasUnhandledFixtureCall = /^unexpected (?:API call|mutation):/.test(
          error?.message || '',
        );
        if (wasUnhandledFixtureCall && method === 'GET' && path === '/users/me') {
          return { id: 8642 };
        }
        if (
          wasUnhandledFixtureCall &&
          method === 'GET' &&
          path.startsWith('/approval_requests/work_times?')
        ) {
          return { work_times: [] };
        }
        throw error;
      }
    }
  },
}));

vi.mock('../server/automation/index.js', () => ({
  hasWebCredentials: mocks.hasWebCredentials,
  submitWebCorrections: mocks.submitWebCorrections,
}));

vi.mock('../server/account-operation.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    acquireAccountOperation: (...args) =>
      mocks.accountOperationAcquire
        ? mocks.accountOperationAcquire(actual.acquireAccountOperation, ...args)
        : actual.acquireAccountOperation(...args),
  };
});

const {
  currentExecutionLogIdentityKey,
  getDb,
  getStrategyCache,
  initDatabase,
  setSetting,
  setStrategyCache,
} = await import('../server/db.js');
const { default: batchRouter } = await import(
  '../server/routes/attendance/batch.js'
);
const {
  getTask,
  waitForAsyncTasksIdle,
} = await import('../server/async-tasks.js');
const {
  acquireAccountOperation,
  releaseAccountOperation,
} = await import('../server/account-operation.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', batchRouter);
  return app;
}

function entry(date = '2026-05-18', overrides = {}) {
  return {
    date,
    clock_in_at: `${date}T09:30:00+09:00`,
    clock_out_at: `${date}T18:00:00+09:00`,
    ...overrides,
  };
}

function routeResponse(routes = [{ id: 2468, usages: ['AttendanceWorkflow'] }]) {
  return { approval_flow_routes: routes };
}

function emptyRecord(date, editable = true) {
  return {
    date,
    is_editable: editable,
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

function apiError(code) {
  const error = new Error('synthetic upstream failure');
  error.code = code;
  return error;
}

function pendingWorkTime(date = '2026-05-18', overrides = {}) {
  return {
    id: 9753,
    company_id: 12345,
    applicant_id: 8642,
    status: 'in_progress',
    target_date: date,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function accountShutdownError() {
  return Object.assign(
    new Error('The account operation service is shutting down.'),
    { code: 'ACCOUNT_OPERATION_SHUTTING_DOWN' },
  );
}

function batchLogs() {
  return getDb()
    .prepare(`
      SELECT scheduled_time, status, error_message, identity_key, company_id, company_name
      FROM execution_log
      WHERE action_type = 'batch_correction'
      ORDER BY id
    `)
    .all();
}

function currentBatchTask() {
  const tasks = getDb().prepare('SELECT id FROM async_tasks').all();
  expect(tasks).toHaveLength(1);
  return getTask(tasks[0].id);
}

async function waitForTask(app, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/attendance/batch/status/${taskId}`);
    expect(response.status).toBe(200);
    if (response.body.status === 'completed') return response.body;
    if (response.body.status === 'failed') {
      throw new Error(`batch task failed: ${response.body.error || 'unknown error'}`);
    }
    expect(response.body.status).toBe('running');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('batch task did not finish');
}

async function withListeningApp(app, operation) {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await operation(server);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function submitAndWait(app, body) {
  return withListeningApp(app, async (server) => {
    const started = await request(server).post('/api/attendance/batch').send(body);
    expect(started.status).toBe(200);
    expect(started.body.task_id).toEqual(expect.any(String));
    return waitForTask(server, started.body.task_id);
  });
}

beforeEach(() => {
  initDatabase();
  getDb().prepare('DELETE FROM async_tasks').run();
  getDb().prepare('DELETE FROM strategy_cache').run();
  getDb().prepare('DELETE FROM execution_log').run();
  setSetting('oauth_configured', '1');
  setSetting('oauth_company_id', '12345');
  setSetting('oauth_employee_id', '67890');
  setSetting('oauth_company_name', 'Example Corp');
  setSetting('connection_mode', 'api');
  setSetting('debug_mode', '0');
  Object.assign(mocks.oauthBinding, EXPECTED_COMPANY);

  mocks.apiRequest.mockReset();
  mocks.ensureValidToken.mockReset();
  mocks.hasWebCredentials.mockReset();
  mocks.submitWebCorrections.mockReset();
  mocks.accountOperationAcquire = null;

  mocks.ensureValidToken.mockResolvedValue('synthetic-access');
  mocks.hasWebCredentials.mockReturnValue(true);
  mocks.submitWebCorrections.mockResolvedValue([]);
  mocks.apiRequest.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
      return routeResponse();
    }
    if (method === 'GET' && path === '/users/me') return { id: 8642 };
    if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
      return { work_times: [] };
    }
    if (method === 'GET' && path.includes('/work_records/')) {
      const date = path.match(/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1];
      return emptyRecord(date);
    }
    if (method === 'PUT' && path.includes('/work_records/')) {
      const date = path.match(/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1];
      return { work_record: { date, ...body } };
    }
    throw new Error(`unexpected API call: ${method} ${path}`);
  });
});

afterEach(async () => {
  expect(await waitForAsyncTasksIdle(5_000)).toBe(true);
});

describe('batch correction route', () => {
  it('preserves an explicit unknown Web outcome separately from a confirmed rejection', async () => {
    const base = mocks.apiRequest.getMockImplementation();
    mocks.apiRequest.mockImplementation(async (method, path, body) => {
      if (path.startsWith('/approval_flow_routes?')) return routeResponse([]);
      if (method === 'GET' && path.includes('/work_records/')) return emptyRecord('2026-05-18', false);
      return base(method, path, body);
    });
    mocks.submitWebCorrections.mockResolvedValue([{ date: '2026-05-18', success: false, error: 'web_automation_outcome_unknown' }]);
    const result = await submitAndWait(createApp(), { entries: [entry()] });
    expect(result).toMatchObject({ status: 'completed', success: false, failed: 0, unknown: 1 });
    expect(result.results[0]).toMatchObject({ unknown: true, error: 'web_automation_outcome_unknown' });
  });

  it('rejects failed durable admission before any correction call', async () => {
    getDb().exec("CREATE TEMP TRIGGER reject_task BEFORE INSERT ON async_tasks BEGIN SELECT RAISE(ABORT,'synthetic admission'); END");
    try {
      const response = await request(createApp()).post('/api/attendance/batch').send({ entries: [entry()] });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('TASK_PERSISTENCE_FAILED');
      expect(mocks.apiRequest).not.toHaveBeenCalled();
      expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
    } finally { getDb().exec('DROP TRIGGER reject_task'); }
  });

  it('checkpoints each item before the next acquire and writes no duplicate final logs', async () => {
    const app = createApp();
    let acquireCount = 0;
    let checkpointBeforeSecond;
    mocks.accountOperationAcquire = (acquire, ...args) => {
      acquireCount += 1;
      if (acquireCount === 2) {
        checkpointBeforeSecond = {
          logs: batchLogs(),
          task: currentBatchTask(),
        };
      }
      return acquire(...args);
    };

    const { started, result } = await withListeningApp(app, async (server) => {
      const started = await request(server).post('/api/attendance/batch').send({
        entries: [entry('2026-05-18'), entry('2026-05-19')],
      });
      expect(started.status).toBe(200);
      expect(started.body.task_id).toEqual(expect.any(String));
      return {
        started,
        result: await waitForTask(server, started.body.task_id),
      };
    });

    expect(checkpointBeforeSecond).toMatchObject({
      logs: [{
        scheduled_time: '2026-05-18',
        status: 'success',
        identity_key: currentExecutionLogIdentityKey(),
        company_id: '12345',
        company_name: 'Example Corp',
      }],
      task: {
        status: 'running',
        processed: 1,
        total: 2,
        succeeded: 1,
        failed: 0,
        results: [
          { date: '2026-05-18', success: true, method: 'direct' },
        ],
      },
    });
    expect(checkpointBeforeSecond.logs[0].error_message).toContain(
      `task_id=${started.body.task_id}`,
    );
    expect(result).toMatchObject({
      status: 'completed',
      success: true,
      processed: 2,
      total: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(batchLogs()).toEqual([
      expect.objectContaining({
        scheduled_time: '2026-05-18',
        status: 'success',
      }),
      expect.objectContaining({
        scheduled_time: '2026-05-19',
        status: 'success',
      }),
    ]);
    expect(batchLogs().every((row) =>
      row.error_message.includes(`task_id=${started.body.task_id}`),
    )).toBe(true);
  });

  it('keeps first-success durability and restart readback when shutdown rejects the next acquire', async () => {
    const app = createApp();
    let acquireCount = 0;
    let checkpointBeforeShutdown;
    mocks.accountOperationAcquire = (acquire, ...args) => {
      acquireCount += 1;
      if (acquireCount === 2) {
        checkpointBeforeShutdown = {
          logs: batchLogs(),
          task: currentBatchTask(),
        };
        return Promise.reject(accountShutdownError());
      }
      return acquire(...args);
    };

    const started = await request(app).post('/api/attendance/batch').send({
      entries: [entry('2026-05-18'), entry('2026-05-19')],
    });
    await expect(waitForAsyncTasksIdle(2_000)).resolves.toBe(true);

    expect(checkpointBeforeShutdown).toMatchObject({
      logs: [{
        scheduled_time: '2026-05-18',
        status: 'success',
        identity_key: currentExecutionLogIdentityKey(),
        company_id: '12345',
        company_name: 'Example Corp',
      }],
      task: {
        status: 'running',
        processed: 1,
        total: 2,
        succeeded: 1,
        failed: 0,
        results: [
          { date: '2026-05-18', success: true, method: 'direct' },
        ],
      },
    });
    const failed = await request(app)
      .get(`/api/attendance/batch/status/${started.body.task_id}`);
    expect(failed.body).toMatchObject({
      status: 'failed',
      processed: 1,
      total: 2,
      succeeded: 1,
      failed: 0,
      partial: true,
      results: [
        { date: '2026-05-18', success: true, method: 'direct' },
      ],
    });

    const persistedTask = getDb()
      .prepare('SELECT * FROM async_tasks WHERE id = ?')
      .get(started.body.task_id);
    expect(persistedTask).toMatchObject({
      identity_key: currentExecutionLogIdentityKey(),
      company_id: '12345',
      company_name: 'Example Corp',
      status: 'failed',
    });
    expect(batchLogs()).toHaveLength(1);
    expect(batchLogs()[0].error_message).toContain(
      `task_id=${started.body.task_id}`,
    );

    initDatabase();
    const restartedReadback = await request(app)
      .get(`/api/attendance/batch/status/${started.body.task_id}`);
    expect(restartedReadback.body).toMatchObject({
      status: 'failed',
      results: [{ date: '2026-05-18', success: true, method: 'direct' }],
      succeeded: 1, failed: 0, total: 2, partial: true,
    });
  });

  it('persists an outcome-unknown item before shutdown rejects the next acquire', async () => {
    const app = createApp();
    let acquireCount = 0;
    let checkpointBeforeShutdown;
    mocks.accountOperationAcquire = (acquire, ...args) => {
      acquireCount += 1;
      if (acquireCount === 2) {
        checkpointBeforeShutdown = {
          logs: batchLogs(),
          task: currentBatchTask(),
        };
        return Promise.reject(accountShutdownError());
      }
      return acquire(...args);
    };
    const baseApiImplementation = mocks.apiRequest.getMockImplementation();
    mocks.apiRequest.mockImplementation(async (method, path, body) => {
      if (method === 'PUT' && path.includes('/work_records/2026-05-18')) {
        throw apiError(FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED);
      }
      return baseApiImplementation(method, path, body);
    });

    const started = await request(app).post('/api/attendance/batch').send({
      entries: [entry('2026-05-18'), entry('2026-05-19')],
    });
    await expect(waitForAsyncTasksIdle(2_000)).resolves.toBe(true);

    expect(checkpointBeforeShutdown).toMatchObject({
      logs: [{
        scheduled_time: '2026-05-18',
        status: 'failure',
        identity_key: currentExecutionLogIdentityKey(),
        company_id: '12345',
        company_name: 'Example Corp',
      }],
      task: {
        status: 'running',
        processed: 1,
        total: 2,
        succeeded: 0,
        failed: 0,
        unknown: 1,
        results: [{
          date: '2026-05-18',
          success: false,
          method: 'direct_unconfirmed',
          error: 'mutation_outcome_unconfirmed',
      unknown: true,
        }],
      },
    });
    expect(checkpointBeforeShutdown.logs[0].error_message).toContain(
      `task_id=${started.body.task_id} | method=direct_unconfirmed | mutation_outcome_unconfirmed`,
    );
    const failed = await request(app)
      .get(`/api/attendance/batch/status/${started.body.task_id}`);
    expect(failed.body).toMatchObject({
      status: 'failed',
      processed: 1,
      total: 2,
      succeeded: 0,
      failed: 0,
      unknown: 1,
      partial: true,
      results: [{
        date: '2026-05-18',
        success: false,
        method: 'direct_unconfirmed',
        error: 'mutation_outcome_unconfirmed',
      unknown: true,
      }],
    });
    expect(batchLogs()).toHaveLength(1);
  });

  it('stops before the next item when its audit checkpoint cannot be persisted', async () => {
    const app = createApp();
    getDb().exec(`
      CREATE TEMP TRIGGER fail_batch_correction_checkpoint
      BEFORE INSERT ON execution_log
      WHEN NEW.action_type = 'batch_correction'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic checkpoint failure');
      END
    `);

    try {
      const started = await request(app).post('/api/attendance/batch').send({
        entries: [entry('2026-05-18'), entry('2026-05-19')],
      });
      await expect(waitForAsyncTasksIdle(2_000)).resolves.toBe(true);

      const failed = await request(app)
        .get(`/api/attendance/batch/status/${started.body.task_id}`);
      expect(failed.body).toMatchObject({
        status: 'failed',
        processed: 1,
        total: 2,
        succeeded: 0,
        failed: 0,
        unknown: 1,
        partial: true,
        results: [
          { date: '2026-05-18', success: false, unknown: true, error: 'mutation_outcome_unconfirmed' },
        ],
      });
      const mutatedDates = mocks.apiRequest.mock.calls
        .filter(([method, path]) => method === 'PUT' && path.includes('/work_records/'))
        .map(([, path]) => path.match(/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1]);
      expect(mutatedDates).toEqual(['2026-05-18']);
      expect(batchLogs()).toEqual([]);
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_batch_correction_checkpoint');
    }
  });

  it('uses one atomic work_record_segments update and never time_clocks', async () => {
    const app = createApp();
    const result = await submitAndWait(app, { entries: [entry()] });

    expect(result).toMatchObject({
      status: 'completed',
      success: true,
      succeeded: 1,
      failed: 0,
    });
    expect(result.results).toEqual([
      { date: '2026-05-18', success: true, method: 'direct' },
    ]);
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      'PUT',
      '/employees/67890/work_records/2026-05-18?company_id=12345',
      {
        company_id: 12345,
        work_record_segments: [
          {
            clock_in_at: '2026-05-18 09:30:00',
            clock_out_at: '2026-05-18 18:00:00',
          },
        ],
      },
    );
    expect(
      mocks.apiRequest.mock.calls.some(([, path]) => path.includes('/time_clocks')),
    ).toBe(false);
  });

  it('uses a verified approval route when the confirmed record is not editable', async () => {
    mocks.apiRequest.mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'POST' && path === '/approval_requests/work_times') {
        return { work_time: { id: 9753, ...body } };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      { date: '2026-05-18', success: true, method: 'approval', id: 9753 },
    ]);
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      'POST',
      '/approval_requests/work_times',
      expect.objectContaining({
        company_id: 12345,
        approval_flow_route_id: 2468,
      }),
    );
  });

  it('does not attempt a direct write when editability is absent', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse([]);
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        const record = emptyRecord('2026-05-18');
        delete record.is_editable;
        return record;
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        return { work_times: [] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });
    mocks.submitWebCorrections.mockResolvedValue([
      { date: '2026-05-18', success: true, method: 'web_correction' },
    ]);

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      { date: '2026-05-18', success: true, method: 'web_correction' },
    ]);
    expect(
      mocks.apiRequest.mock.calls.some(([method]) => method === 'PUT'),
    ).toBe(false);
  });

  it('does not guess a self-approver when the route requires explicit selection', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse([
          { id: 2468, name: '指定 route', usages: ['AttendanceWorkflow'] },
        ]);
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        return { work_times: [] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });
    mocks.submitWebCorrections.mockResolvedValue([
      { date: '2026-05-18', success: true },
    ]);

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      { date: '2026-05-18', success: true, method: 'web_correction' },
    ]);
    expect(
      mocks.apiRequest.mock.calls.some(
        ([method, path]) => method === 'POST' && path.includes('/approval_requests/'),
      ),
    ).toBe(false);
    expect(
      mocks.apiRequest.mock.calls.some(
        ([method, path]) => method === 'GET' && path === '/users/me',
      ),
    ).toBe(true);
  });

  it('stops when an approval response has no confirmed request id', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'POST' && path === '/approval_requests/work_times') {
        return { work_time: {} };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: false,
        method: 'approval_unconfirmed',
        error: 'mutation_outcome_unconfirmed',
      unknown: true,
      },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it('fails closed when neither the direct response nor a re-read confirms the update', async () => {
    let workRecordReads = 0;
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        workRecordReads += 1;
        return emptyRecord('2026-05-18', true);
      }
      if (method === 'PUT' && path.includes('/work_records/')) return {};
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(workRecordReads).toBe(2);
    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: false,
        method: 'direct_unconfirmed',
        error: 'mutation_outcome_unconfirmed',
      unknown: true,
      },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it('does not confirm a direct update from a matching record for another date', async () => {
    let workRecordReads = 0;
    const wrongDateRecord = {
      date: '2026-05-19',
      work_record_segments: [{
        clock_in_at: '2026-05-19 09:30:00',
        clock_out_at: '2026-05-19 18:00:00',
      }],
      break_records: [],
    };
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        workRecordReads += 1;
        return workRecordReads === 1
          ? emptyRecord('2026-05-18', true)
          : wrongDateRecord;
      }
      if (method === 'PUT' && path.includes('/work_records/')) {
        return wrongDateRecord;
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([{
      date: '2026-05-18',
      success: false,
      method: 'direct_unconfirmed',
      error: 'mutation_outcome_unconfirmed',
      unknown: true,
    }]);
  });

  it('does not confirm a direct update that contains an extra work segment', async () => {
    let workRecordReads = 0;
    const multiSegmentRecord = {
      date: '2026-05-18',
      work_record_segments: [
        {
          clock_in_at: '2026-05-18 09:30:00',
          clock_out_at: '2026-05-18 18:00:00',
        },
        {
          clock_in_at: '2026-05-18 19:00:00',
          clock_out_at: '2026-05-18 20:00:00',
        },
      ],
      break_records: [],
    };
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        workRecordReads += 1;
        return workRecordReads === 1
          ? emptyRecord('2026-05-18', true)
          : multiSegmentRecord;
      }
      if (method === 'PUT' && path.includes('/work_records/')) {
        return multiSegmentRecord;
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([{
      date: '2026-05-18',
      success: false,
      method: 'direct_unconfirmed',
      error: 'mutation_outcome_unconfirmed',
      unknown: true,
    }]);
  });

  it('skips a date whose confirmed work record is full-day paid leave', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return {
          ...emptyRecord('2026-05-18'),
          normal_work_mins: 480,
          paid_holidays: [{ type: 'full', days: 1, mins: 0 }],
        };
      }
      throw new Error(`unexpected mutation: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: true,
        method: 'skipped',
        reason: 'already_non_working_day',
      },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it('stops after an unconfirmed direct mutation instead of creating a duplicate fallback', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18');
      }
      if (method === 'PUT' && path.includes('/work_records/')) {
        const error = new Error('synthetic response parse failure');
        error.code = FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED;
        throw error;
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: false,
        method: 'direct_unconfirmed',
        error: 'mutation_outcome_unconfirmed',
      unknown: true,
      },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
    expect(
      mocks.apiRequest.mock.calls.some(
        ([method, path]) => method === 'POST' && path.includes('/approval_requests/'),
      ),
    ).toBe(false);
  });

  it.each([
    'API_ERROR_408',
    'API_ERROR_409',
    'API_ERROR_422',
    'API_ERROR_400',
    'API_ERROR_499',
    'RATE_LIMITED',
    'UNCLASSIFIED_REJECTION',
    'DIRECT_EDIT_DISABLED',
  ])('does not Web-fallback after non-allowlisted approval failure %s', async (code) => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'POST' && path === '/approval_requests/work_times') {
        throw apiError(code);
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: false,
        method: 'approval_failed',
        error: 'api_fallback_not_allowed',
      },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it.each([
    'API_ERROR_408',
    'API_ERROR_409',
    'API_ERROR_422',
    'API_ERROR_499',
    'WEB_FORM_REQUIRED',
  ])('does not continue to approval or Web after non-allowlisted direct failure %s', async (code) => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', true);
      }
      if (method === 'PUT' && path.includes('/work_records/')) {
        throw apiError(code);
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: false,
        method: 'direct_failed',
        error: 'api_fallback_not_allowed',
      },
    ]);
    expect(
      mocks.apiRequest.mock.calls.some(
        ([method, path]) =>
          method === 'POST' && path === '/approval_requests/work_times',
      ),
    ).toBe(false);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it.each(['DIRECT_EDIT_DISABLED', 'PERMISSION_DENIED'])(
    'allows direct-to-Web fallback only for direct allowlist code %s',
    async (code) => {
      mocks.apiRequest.mockImplementation(async (method, path) => {
        if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
          return routeResponse([]);
        }
        if (method === 'GET' && path.includes('/work_records/')) {
          return emptyRecord('2026-05-18', true);
        }
        if (method === 'PUT' && path.includes('/work_records/')) {
          throw apiError(code);
        }
        if (method === 'GET' && path === '/users/me') return { id: 8642 };
        if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
          return { work_times: [] };
        }
        throw new Error(`unexpected API call: ${method} ${path}`);
      });
      mocks.submitWebCorrections.mockResolvedValue([
        { date: '2026-05-18', success: true },
      ]);

      const result = await submitAndWait(createApp(), { entries: [entry()] });

      expect(result.results).toEqual([
        { date: '2026-05-18', success: true, method: 'web_correction' },
      ]);
      expect(mocks.submitWebCorrections).toHaveBeenCalledOnce();
      expect(mocks.submitWebCorrections.mock.calls[0][2]).toEqual(EXPECTED_COMPANY);
    },
  );

  it('checks same-date pending WorkTime before an allowlisted Web fallback', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'POST' && path === '/approval_requests/work_times') {
        throw apiError('WEB_FORM_REQUIRED');
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        return { work_times: [pendingWorkTime()] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: true,
        method: 'skipped',
        reason: 'already_pending_approval',
      },
    ]);
    expect(
      mocks.apiRequest.mock.calls.some(
        ([method, path]) =>
          method === 'GET' &&
          path.startsWith('/approval_requests/work_times?') &&
          new URL(`https://example.invalid${path}`).searchParams.get('status') ===
            'in_progress',
      ),
    ).toBe(true);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it('fails closed when pending WorkTime cannot be confirmed', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'POST' && path === '/approval_requests/work_times') {
        throw apiError('WEB_FORM_REQUIRED');
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        throw apiError('API_TRANSIENT');
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: false,
        method: 'pending_precheck_failed',
        error: 'pending_approval_unconfirmed',
      },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it('uses Web after an allowlisted rejection when no same-date WorkTime is pending', async () => {
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse();
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'POST' && path === '/approval_requests/work_times') {
        throw apiError('WEB_FORM_REQUIRED');
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        return { work_times: [pendingWorkTime('2026-05-19')] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });
    mocks.submitWebCorrections.mockResolvedValue([
      { date: '2026-05-18', success: true },
    ]);

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      { date: '2026-05-18', success: true, method: 'web_correction' },
    ]);
    expect(mocks.submitWebCorrections).toHaveBeenCalledOnce();
    expect(mocks.submitWebCorrections.mock.calls[0][2]).toEqual(EXPECTED_COMPANY);
  });

  it('does not let a stale best=web cache bypass current API eligibility', async () => {
    const currentMonth = new Date().toISOString().slice(0, 7);
    setStrategyCache(currentMonth, {
      direct_ok: false,
      approval_ok: false,
      time_clock_ok: false,
      best_strategy: 'web',
    });

    const result = await submitAndWait(createApp(), { entries: [entry()] });

    expect(result.results).toEqual([
      { date: '2026-05-18', success: true, method: 'direct' },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it('does not silently drop extra break records when only Web fallback is available', async () => {
    const currentMonth = new Date().toISOString().slice(0, 7);
    setStrategyCache(currentMonth, {
      direct_ok: false,
      approval_ok: false,
      time_clock_ok: false,
      best_strategy: 'web',
    });
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse([]);
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        return emptyRecord('2026-05-18', false);
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        return { work_times: [] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });
    const correction = entry('2026-05-18', {
      break_records: [
        {
          clock_in_at: '2026-05-18T12:00:00+09:00',
          clock_out_at: '2026-05-18T12:30:00+09:00',
        },
        {
          clock_in_at: '2026-05-18T15:00:00+09:00',
          clock_out_at: '2026-05-18T15:15:00+09:00',
        },
      ],
    });

    const result = await submitAndWait(createApp(), { entries: [correction] });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: false,
        method: 'web_unsupported',
        error: 'web_multiple_breaks_unsupported',
      },
    ]);
    expect(mocks.submitWebCorrections).not.toHaveBeenCalled();
  });

  it('returns one fail-closed result for every Web entry omitted by automation', async () => {
    const currentMonth = new Date().toISOString().slice(0, 7);
    setStrategyCache(currentMonth, {
      direct_ok: false,
      approval_ok: false,
      time_clock_ok: false,
      best_strategy: 'web',
    });
    mocks.submitWebCorrections.mockResolvedValue([
      { date: '2026-05-18', success: true, method: 'web_correction' },
    ]);
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse([]);
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        const date = path.match(/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1];
        return emptyRecord(date, false);
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        return { work_times: [] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });

    const result = await submitAndWait(createApp(), {
      entries: [entry('2026-05-18'), entry('2026-05-19')],
    });

    expect(result.results).toEqual([
      {
        date: '2026-05-18',
        success: true,
        method: 'web_correction',
      },
      {
        date: '2026-05-19',
        success: false,
        method: 'web_correction',
        error: 'web_result_unconfirmed',
        unknown: true,
      },
    ]);
  });

  it('releases the account lock between Web fallback dates', async () => {
    const firstWebStarted = deferred();
    const firstWebResult = deferred();
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse([]);
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        const date = path.match(/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1];
        return emptyRecord(date, false);
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        return { work_times: [] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });
    mocks.submitWebCorrections.mockImplementation(async ([correction]) => {
      if (correction.date === '2026-05-18') {
        firstWebStarted.resolve();
        return firstWebResult.promise;
      }
      return [{ date: correction.date, success: true }];
    });

    const result = await withListeningApp(createApp(), async (server) => {
      const started = await request(server).post('/api/attendance/batch').send({
        entries: [entry('2026-05-18'), entry('2026-05-19')],
      });
      const taskResult = waitForTask(server, started.body.task_id);
      await firstWebStarted.promise;
      const interleavedOperation = acquireAccountOperation();
      firstWebResult.resolve([{ date: '2026-05-18', success: true }]);
      await interleavedOperation;

      try {
        expect(mocks.submitWebCorrections).toHaveBeenCalledTimes(1);
      } finally {
        releaseAccountOperation();
      }
      return taskResult;
    });
    expect(result).toMatchObject({
      status: 'completed',
      success: true,
      succeeded: 2,
    });
    expect(mocks.submitWebCorrections).toHaveBeenCalledTimes(2);
  });

  it('refreshes pending WorkTime state inside each per-date lock', async () => {
    let pendingLookupCount = 0;
    mocks.apiRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path.startsWith('/approval_flow_routes?')) {
        return routeResponse([]);
      }
      if (method === 'GET' && path.includes('/work_records/')) {
        const date = path.match(/work_records\/(\d{4}-\d{2}-\d{2})/)?.[1];
        return emptyRecord(date, false);
      }
      if (method === 'GET' && path === '/users/me') return { id: 8642 };
      if (method === 'GET' && path.startsWith('/approval_requests/work_times?')) {
        pendingLookupCount += 1;
        return pendingLookupCount === 4
          ? { work_times: [pendingWorkTime('2026-05-19')] }
          : { work_times: [] };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });
    mocks.submitWebCorrections.mockImplementation(async ([correction]) => ([{
      date: correction.date,
      success: true,
    }]));

    const result = await submitAndWait(createApp(), {
      entries: [entry('2026-05-18'), entry('2026-05-19')],
    });

    expect(pendingLookupCount).toBe(4);
    expect(mocks.submitWebCorrections).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([
      { date: '2026-05-18', success: true, method: 'web_correction' },
      {
        date: '2026-05-19',
        success: true,
        method: 'skipped',
        reason: 'already_pending_approval',
      },
    ]);
  });

  it('keeps a running task, cache, and logs bound to the initiating account', async () => {
    const app = createApp();
    const workRecordStarted = deferred();
    const workRecordResult = deferred();
    const baseApiImplementation = mocks.apiRequest.getMockImplementation();
    let blocked = false;
    mocks.apiRequest.mockImplementation(async (method, path, body) => {
      if (!blocked && method === 'GET' && path.includes('/work_records/')) {
        blocked = true;
        workRecordStarted.resolve();
        return workRecordResult.promise;
      }
      return baseApiImplementation(method, path, body);
    });

    const accountAKey = currentExecutionLogIdentityKey();
    const started = await request(app)
      .post('/api/attendance/batch')
      .send({ entries: [entry()] });
    expect(started.status).toBe(200);
    await workRecordStarted.promise;

    Object.assign(mocks.oauthBinding, {
      companyId: '22222',
      employeeId: '33333',
      companyName: 'Other Corp',
      generation: '2',
    });
    setSetting('oauth_company_id', '22222');
    setSetting('oauth_employee_id', '33333');
    setSetting('oauth_company_name', 'Other Corp');
    const accountBKey = currentExecutionLogIdentityKey();
    expect(accountBKey).not.toBe(accountAKey);

    const hiddenWhileRunning = await request(app)
      .get(`/api/attendance/batch/status/${started.body.task_id}`);
    expect(hiddenWhileRunning.status).toBe(404);

    workRecordResult.resolve(emptyRecord('2026-05-18'));
    await expect(waitForAsyncTasksIdle(2_000)).resolves.toBe(true);

    const hiddenAfterCompletion = await request(app)
      .get(`/api/attendance/batch/status/${started.body.task_id}`);
    expect(hiddenAfterCompletion.status).toBe(404);
    expect(getStrategyCache(new Date().toISOString().slice(0, 7))).toBeNull();

    const persistedTask = getDb()
      .prepare('SELECT * FROM async_tasks WHERE id = ?')
      .get(started.body.task_id);
    const executionLog = getDb()
      .prepare("SELECT * FROM execution_log WHERE action_type = 'batch_correction' ORDER BY id DESC LIMIT 1")
      .get();
    expect(persistedTask).toMatchObject({
      identity_key: accountAKey,
      company_id: '12345',
      company_name: 'Example Corp',
      status: 'completed',
    });
    expect(executionLog).toMatchObject({
      identity_key: accountAKey,
      company_id: '12345',
      company_name: 'Example Corp',
      status: 'success',
    });

    Object.assign(mocks.oauthBinding, EXPECTED_COMPANY);
    setSetting('oauth_company_id', '12345');
    setSetting('oauth_employee_id', '67890');
    setSetting('oauth_company_name', 'Example Corp');
    const visible = await request(app)
      .get(`/api/attendance/batch/status/${started.body.task_id}`);
    expect(visible.status).toBe(200);
    expect(visible.body).not.toHaveProperty('identity');
    expect(getStrategyCache(
      new Date().toISOString().slice(0, 7),
      accountAKey,
    )).not.toBeNull();
  });

  it.each([
    {
      entries: [entry('2026-02-30')],
      expected: 'Each entry must have a unique valid date',
    },
    {
      entries: [{ date: '2026-05-18', clock_in_at: '09:30' }],
      expected: 'Each entry must contain clock_in_at and clock_out_at',
    },
    {
      entries: [entry('2026-05-18', {
        break_records: [{
          clock_in_at: '2026-05-18T08:00:00+09:00',
          clock_out_at: '2026-05-18T09:00:00+09:00',
        }],
      })],
      expected: 'Break records must be ordered, non-overlapping, and inside work time',
    },
  ])('rejects invalid correction input before OAuth or API calls', async ({ entries, expected }) => {
    const response = await request(createApp())
      .post('/api/attendance/batch')
      .send({ entries });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(expected);
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it('enforces the current freee 255-character approval comment limit', async () => {
    const response = await request(createApp())
      .post('/api/attendance/batch')
      .send({ entries: [entry()], reason: 'x'.repeat(256) });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('reason must be 255 characters or less');
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });
});
