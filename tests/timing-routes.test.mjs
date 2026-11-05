import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../server/logger.js';
import { getSetting, initDatabase, setSetting } from '../server/db.js';

const webMocks = vi.hoisted(() => ({
  submitMonthlyAttendanceClosingWeb: vi.fn(),
  withdrawApprovalRequestWeb: vi.fn(),
  hasWebCredentials: vi.fn(() => true),
}));

vi.mock('../server/automation/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...webMocks,
}));

const settingKeys = [
  'oauth_configured', 'oauth_identity_generation', 'oauth_company_id',
  'oauth_employee_id', 'oauth_company_name', 'oauth_companies',
  'oauth_auth_broken', 'oauth_access_token_encrypted', 'oauth_token_expires_at',
];
const originalFetch = global.fetch;
const saved = new Map();
let lines;
let app;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const timingLines = (name) =>
  lines.filter((l) => l.message.startsWith(`${name} `)).map((l) => l.message);

function expectClean(text) {
  for (const forbidden of [
    '12345', '67890', '7531', '2026', 'company_id', 'Fixture', 'fixture-token', '?',
  ]) {
    expect(text).not.toContain(forbidden);
  }
}

beforeEach(async () => {
  lines = [];
  vi.spyOn(logger, '_write').mockImplementation((level, module, message) => {
    if (module === 'Timing') lines.push({ level, message });
  });
  webMocks.submitMonthlyAttendanceClosingWeb.mockReset();
  webMocks.withdrawApprovalRequestWeb.mockReset();
  webMocks.hasWebCredentials.mockReturnValue(true);

  initDatabase();
  for (const key of settingKeys) saved.set(key, getSetting(key));
  const { encrypt } = await import('../server/crypto.js');
  setSetting('oauth_configured', '1');
  setSetting('oauth_identity_generation', '1');
  setSetting('oauth_company_id', '12345');
  setSetting('oauth_employee_id', '67890');
  setSetting('oauth_company_name', 'Fixture Secret Company');
  setSetting('oauth_companies', JSON.stringify([{
    id: 12345, employee_id: 67890, name: 'Fixture Secret Company', display_name: 'Fixture Person',
  }]));
  setSetting('oauth_auth_broken', '0');
  setSetting('oauth_access_token_encrypted', encrypt('fixture-token-value'));
  setSetting('oauth_token_expires_at', String(Date.now() + 3_600_000));

  const approval = (await import('../server/routes/attendance/approval.js')).default;
  const batch = (await import('../server/routes/attendance/batch.js')).default;
  const ops = (await import('../server/routes/attendance/batch-operations.js')).default;
  app = express();
  app.use(express.json());
  for (const router of [approval, batch, ops]) app.use('/api/attendance', router);
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of saved) setSetting(key, value ?? '');
  saved.clear();
  vi.restoreAllMocks();
});

describe('timing lines for instrumented routes', () => {
  it('monthly closing: API rejection falls back to the web form', async () => {
    global.fetch = vi.fn(async (url, init) => {
      const text = String(url);
      if (text.includes('/approval_flow_routes')) {
        return json({ approval_flow_routes: [{ id: 5, usages: ['AttendanceWorkflow'], name: 'x' }] });
      }
      if (init?.method === 'POST') return json({ message: 'Webから申請してください' }, 403);
      return json({});
    });
    webMocks.submitMonthlyAttendanceClosingWeb.mockResolvedValue({ success: true });

    await request(app).post('/api/attendance/approval/monthly').send({ year: 2026, month: 5 });

    const out = timingLines('monthly_closing');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('via=web');
    expect(out[0]).toContain('api_fallback=true');
    expect(out[0]).toMatch(/phases=[^ ]*account_op_wait:\d+/);
    expect(out[0]).toMatch(/api_attempt:\d+/);
    expect(out[0]).toMatch(/web_fallback:\d+/);
    expect(out[0]).toContain('http=');
    expectClean(out[0]);
  });

  it('monthly closing: unverified route goes straight to the web form', async () => {
    global.fetch = vi.fn(async () => json({}, 500));
    webMocks.submitMonthlyAttendanceClosingWeb.mockResolvedValue({ success: true });

    await request(app).post('/api/attendance/approval/monthly').send({ year: 2026, month: 5 });

    const out = timingLines('monthly_closing');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('via=web');
    expect(out[0]).not.toContain('api_fallback');
    expectClean(out[0]);
  });

  it('monthly closing: early validation failure writes no line', async () => {
    await request(app).post('/api/attendance/approval/monthly').send({ year: 'x' });
    expect(timingLines('monthly_closing')).toHaveLength(0);
  });

  it('withdraw: API path', async () => {
    global.fetch = vi.fn(async (url) => {
      const text = String(url);
      if (text.endsWith('/users/me')) return json({ id: 7531 });
      return json({}, 404);
    });
    await request(app).delete('/api/attendance/approval-requests/99887?type=WorkTime');
    const out = timingLines('approval_withdraw');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('path=api');
    expect(out[0]).toMatch(/account_op_wait:\d+/);
    expectClean(out[0]);
    expect(out[0]).not.toContain('99887');
  });

  it('withdraw: web path', async () => {
    global.fetch = vi.fn(async (url, init) => {
      const text = String(url);
      if (text.endsWith('/users/me')) return json({ id: 7531 });
      if (init?.method === 'DELETE') return json({}, 400);
      return json({ id: 99887, company_id: 12345, status: 'draft', applicant_id: 7531 });
    });
    webMocks.withdrawApprovalRequestWeb.mockResolvedValue({ success: true });
    await request(app).delete('/api/attendance/approval-requests/99887?type=WorkTime');
    const out = timingLines('approval_withdraw');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('path=web');
    expect(out[0]).toMatch(/web_withdraw:\d+/);
    expectClean(out[0]);
    expect(out[0]).not.toContain('99887');
  });

  it('employee info writes one clean line', async () => {
    global.fetch = vi.fn(async (url) => {
      const text = String(url);
      if (text.endsWith('/users/me')) {
        return json({ id: 7531, companies: [{ id: 12345, name: 'Fixture Secret Company' }] });
      }
      return json({ num: 'E-1', entry_date: '2020-01-01' });
    });
    const res = await request(app).get('/api/attendance/employee-info');
    expect(res.status).toBe(200);
    const out = timingLines('employee_info');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/employee_detail:\d+/);
    expectClean(out[0]);
  });

  it('batch punch writes one line with the entry count', async () => {
    global.fetch = vi.fn(async () => json({}, 500));
    const res = await request(app).post('/api/attendance/batch').send({
      entries: [{ date: '2026-05-18', clock_in_at: '2026-05-18T09:00:00', clock_out_at: '2026-05-18T18:00:00' }],
      reason: 'Fixture note',
    });
    expect(res.status).toBeLessThan(500);
    await vi.waitFor(() => expect(timingLines('batch_punch')).toHaveLength(1), { timeout: 5000 });
    const out = timingLines('batch_punch')[0];
    expect(out).toContain('entries=1');
    expectClean(out);
    expect(out).not.toContain('note');
  });
});
