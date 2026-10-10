import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../server/crypto.js';
import { getDb, initDatabase, setSetting } from '../server/db.js';
import { waitForAsyncTasksIdle } from '../server/async-tasks.js';
import batchOperationsRouter from '../server/routes/attendance/batch-operations.js';
import batchRouter from '../server/routes/attendance/batch.js';

beforeEach(() => {
  initDatabase();
  getDb().prepare('DELETE FROM async_tasks').run();
  for (const [key, value] of Object.entries({
    connection_mode: 'api', oauth_configured: '1', oauth_identity_generation: '1',
    oauth_company_id: '12345', oauth_employee_id: '67890', oauth_company_name: 'Synthetic Company',
    oauth_companies: JSON.stringify([{ id: 12345, employee_id: 67890, name: 'Synthetic Company' }]),
    oauth_access_token_encrypted: encrypt('synthetic-access-token'),
    oauth_token_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    oauth_auth_broken: '0',
  })) setSetting(key, value);
});

afterEach(async () => {
  await waitForAsyncTasksIdle(2000);
  vi.unstubAllGlobals();
});

describe('durable task HTTP outcome confirmation', () => {
  it.each([204, 202, 200, 201, 404])('persists the verified withdrawal outcome for HTTP %i', async (status) => {
    const upstream = vi.fn(async (url, options) => {
      const pathname = new URL(url).pathname;
      if (options.method === 'GET' && pathname.endsWith('/users/me')) {
        return Response.json({ id: 8642 });
      }
      if (options.method === 'GET' && pathname.endsWith('/approval_requests/paid_holidays/9753')) {
        return Response.json({ paid_holiday: {
          id: 9753, company_id: 12345, applicant_id: 8642, status: 'draft',
        } });
      }
      if (options.method === 'DELETE' && pathname.endsWith('/approval_requests/paid_holidays/9753')) {
        return new Response(status === 204 ? null : JSON.stringify({ accepted: true }), { status });
      }
      throw new Error('Unexpected upstream operation');
    });
    vi.stubGlobal('fetch', upstream);
    const app = express();
    app.use(express.json());
    app.use('/api/attendance', batchOperationsRouter, batchRouter);
    const admitted = await request(app).post('/api/attendance/batch-withdraw')
      .send({ requests: [{ id: 9753, type: 'PaidHoliday' }] }).expect(200);
    expect(admitted.body.status).toBe('running');
    await expect(waitForAsyncTasksIdle(2000)).resolves.toBe(true);
    const response = await request(app)
      .get(`/api/attendance/batch/status/${admitted.body.task_id}`).expect(200);
    const confirmed = status === 204 || status === 404;
    expect(response.body).toMatchObject({
      status: 'completed', success: confirmed, total: 1, processed: 1,
      succeeded: confirmed ? 1 : 0, failed: 0, unknown: confirmed ? 0 : 1,
    });
    if (!confirmed) expect(response.body.results[0]).toMatchObject({
      success: false, unknown: true, error: 'mutation_outcome_unconfirmed',
    });
    const saved = getDb().prepare('SELECT result_json FROM async_tasks WHERE id=?')
      .get(admitted.body.task_id);
    expect(JSON.parse(saved.result_json).results).toEqual(response.body.results);
    expect(upstream.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET', 'DELETE']);
  });
});
