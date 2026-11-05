import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../server/logger.js';
import {
  addPhase,
  hasTimingContext,
  recordFreeeCall,
  recordTokenRefresh,
  runTimed,
  setTimingTag,
  startPhase,
  timePhase,
} from '../server/timing.js';
import { FreeeApiClient } from '../server/freee-api.js';
import { getSetting, initDatabase, setSetting } from '../server/db.js';

let lines;
beforeEach(() => {
  lines = [];
  vi.spyOn(logger, '_write').mockImplementation((level, module, message) => {
    if (module === 'Timing') lines.push({ level, message });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('timing helper', () => {
  it('writes exactly one info line with total, phases and tags', async () => {
    const result = await runTimed('demo_op', async () => {
      await timePhase('first', () => sleep(5));
      const end = startPhase('second');
      await sleep(5);
      end();
      end();
      addPhase('third', 7.4);
      setTimingTag('via', 'api');
      setTimingTag('hit', true);
      return 42;
    });
    expect(result).toBe(42);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('INFO');
    expect(lines[0].message).toMatch(
      /^demo_op total=\d+ms via=api hit=true phases=first:\d+,second:\d+,third:7 freee_calls=0$/,
    );
  });

  it('aggregates freee calls by sanitized template and status class', async () => {
    await runTimed('calls', async () => {
      recordFreeeCall({ method: 'GET', path: '/users/me', status: 200, ms: 100 });
      recordFreeeCall({ method: 'GET', path: '/users/me', status: 200, ms: 300 });
      recordFreeeCall({
        method: 'GET',
        path: '/employees/123456/work_records/2026-05-18?company_id=99',
        status: 404,
        ms: 50,
      });
      recordFreeeCall({ method: 'POST', path: '/x', status: 0, ms: 10 });
      recordTokenRefresh(25);
    });
    const line = lines[0].message;
    expect(line).toContain('freee_calls=4');
    expect(line).toContain('freee_total=460ms');
    expect(line).toContain('freee_max=300ms');
    expect(line).toContain('GET:/users/me:2xx*2');
    expect(line).toContain('GET:/employees/:id/work_records/:id:4xx*1');
    expect(line).toContain('POST:/x:err*1');
    expect(line).toContain('token_refresh=1x/25ms');
    expect(line).toContain('token_refresh:25');
    expect(line).not.toMatch(/123456|2026|company_id|\?/);
  });

  it('keeps parallel operations isolated', async () => {
    await Promise.all([
      runTimed('op_a', async () => {
        await sleep(5);
        recordFreeeCall({ method: 'GET', path: '/a', status: 200, ms: 1 });
        await timePhase('pa', () => sleep(5));
      }),
      runTimed('op_b', async () => {
        recordFreeeCall({ method: 'GET', path: '/b', status: 500, ms: 2 });
        recordFreeeCall({ method: 'GET', path: '/b', status: 500, ms: 2 });
        await timePhase('pb', () => sleep(2));
      }),
    ]);
    const a = lines.find((l) => l.message.startsWith('op_a '));
    const b = lines.find((l) => l.message.startsWith('op_b '));
    expect(lines).toHaveLength(2);
    expect(a.message).toContain('freee_calls=1');
    expect(a.message).toContain('pa:');
    expect(a.message).not.toContain('pb:');
    expect(b.message).toContain('freee_calls=2');
    expect(b.message).not.toContain('pa:');
  });

  it('nested operations log their own line and the parent still counts calls', async () => {
    await runTimed('outer', async () => {
      await runTimed('inner', async () => {
        recordFreeeCall({ method: 'GET', path: '/n', status: 200, ms: 1 });
      });
      recordFreeeCall({ method: 'GET', path: '/m', status: 200, ms: 1 });
    });
    expect(lines).toHaveLength(2);
    expect(lines[0].message).toMatch(/^inner .*freee_calls=1/);
    expect(lines[1].message).toMatch(/^outer .*freee_calls=2/);
  });

  it('logs a safe error code and rethrows', async () => {
    const failure = Object.assign(new Error('secret person@example.com'), {
      code: 'SOME_CODE',
    });
    await expect(runTimed('failing', async () => { throw failure; })).rejects.toBe(failure);
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toContain('error=SOME_CODE');
    expect(lines[0].message).not.toContain('person@example.com');
  });

  it('rejects unsafe phase names and tag values', async () => {
    await runTimed('safe', async () => {
      addPhase('bad name with spaces', 5);
      setTimingTag('note', 'person@example.com');
      setTimingTag('ok', 'fine_value');
    });
    expect(lines[0].message).not.toContain('bad name');
    expect(lines[0].message).not.toContain('person@');
    expect(lines[0].message).toContain('ok=fine_value');
  });

  it('is a no-op without an active context', async () => {
    expect(hasTimingContext()).toBe(false);
    expect(await timePhase('x', async () => 'value')).toBe('value');
    addPhase('x', 5);
    setTimingTag('a', 'b');
    recordFreeeCall({ method: 'GET', path: '/x', status: 200, ms: 1 });
    recordTokenRefresh(5);
    startPhase('x')();
    expect(lines).toHaveLength(0);
  });

  it('does not throw when the logger fails', async () => {
    logger._write.mockImplementation(() => { throw new Error('disk full'); });
    await expect(runTimed('quiet', async () => 'done')).resolves.toBe('done');
  });
});

describe('timing privacy through the approval routes', () => {
  const originalFetch = global.fetch;
  const settingKeys = [
    'oauth_configured', 'oauth_identity_generation', 'oauth_company_id',
    'oauth_employee_id', 'oauth_company_name', 'oauth_companies',
    'oauth_auth_broken', 'oauth_access_token_encrypted', 'oauth_token_expires_at',
  ];
  const saved = new Map();

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of saved) setSetting(key, value ?? '');
    saved.clear();
  });

  it('never logs ids, dates, names, comments or query strings', async () => {
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

    global.fetch = vi.fn(async (url) => {
      const text = String(url);
      const body = text.endsWith('/users/me')
        ? { id: 7531, companies: [{ id: 12345 }] }
        : { approval_requests: [], total_count: 0 };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const { default: approvalRouter } = await import(
      '../server/routes/attendance/approval.js'
    );
    const app = express();
    app.use(express.json());
    app.use('/api/attendance', approvalRouter);
    const response = await request(app).get(
      '/api/attendance/approval-requests?year=2026&month=5',
    );
    expect(response.status).toBeLessThan(600);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const joined = lines.map((l) => l.message).join('\n');
    expect(joined).toMatch(/^approval_list total=\d+ms /);
    expect(joined).toContain('http=');
    expect(joined).toMatch(/freee_calls=[1-9]/);
    expect(joined).toContain('GET:/users/me:2xx*1');
    for (const forbidden of [
      '12345', '67890', '7531', '2026', '2026-05', 'company_id', 'Fixture',
      'fixture-token', '?', 'year=', 'month=',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });
});
