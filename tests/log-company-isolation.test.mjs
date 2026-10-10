import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createSession,
  deleteSession,
  getDb,
  getSetting,
  initDatabase,
  insertLog,
  setSetting,
} from '../server/db.js';
import { encrypt } from '../server/crypto.js';

initDatabase();
const { default: app } = await import('../server/app.js');

const sessionToken = ['log', 'scope', 'fixture'].join('-');
const originalSettings = new Map();

beforeAll(() => {
  for (const key of [
    'connection_mode',
    'debug_mode',
    'oauth_company_id',
    'oauth_company_name',
    'oauth_employee_id',
    'oauth_identity_generation',
    'freee_configured',
    'freee_username_encrypted',
    'freee_password_encrypted',
    'web_company_name',
    'web_employee_id_encrypted',
    'web_identity_generation',
  ]) {
    originalSettings.set(key, getSetting(key));
  }
  const user = getDb().prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  getDb().prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(user.id);
  createSession(sessionToken, user.id, new Date(Date.now() + 60_000).toISOString());
});

afterAll(() => {
  getDb().prepare("DELETE FROM execution_log WHERE trigger_type = 'scope_fixture'").run();
  for (const [key, value] of originalSettings) setSetting(key, value || '');
  deleteSession(sessionToken);
});

describe('execution log company isolation', () => {
  it('returns and resolves only logs for the active OAuth company', async () => {
    setSetting('connection_mode', 'api');
    setSetting('debug_mode', '0');
    setSetting('oauth_company_id', '10101');
    setSetting('oauth_employee_id', '1001');
    setSetting('oauth_company_name', 'Fixture A');
    setSetting('oauth_identity_generation', '99');
    const visible = insertLog({
      action_type: 'scope_visible',
      status: 'success',
      trigger_type: 'scope_fixture',
    });
    setSetting('oauth_company_id', '20202');
    setSetting('oauth_employee_id', '2002');
    setSetting('oauth_company_name', 'Fixture B');
    setSetting('oauth_identity_generation', '2');
    const hidden = insertLog({
      action_type: 'scope_hidden',
      status: 'success',
      trigger_type: 'scope_fixture',
    });
    setSetting('oauth_company_id', '10101');
    setSetting('oauth_employee_id', '1001');
    setSetting('oauth_company_name', 'Fixture A');
    setSetting('oauth_identity_generation', '1');

    const list = await request(app)
      .get('/api/logs?limit=100')
      .set('x-session-token', sessionToken);
    const hiddenDetail = await request(app)
      .get(`/api/logs/${hidden.lastInsertRowid}`)
      .set('x-session-token', sessionToken);
    const visibleDetail = await request(app)
      .get(`/api/logs/${visible.lastInsertRowid}`)
      .set('x-session-token', sessionToken);

    expect(list.status).toBe(200);
    expect(list.body.rows.some((row) => row.action_type === 'scope_visible')).toBe(true);
    expect(list.body.rows.some((row) => row.action_type === 'scope_hidden')).toBe(false);
    expect(hiddenDetail.status).toBe(404);
    expect(visibleDetail.status).toBe(200);
  });

  it('keeps browser-mode logs in an explicit identity scope', async () => {
    setSetting('connection_mode', 'api');
    setSetting('debug_mode', '0');
    setSetting('oauth_company_id', '10101');
    setSetting('oauth_employee_id', '1001');
    setSetting('oauth_company_name', 'Fixture A');
    setSetting('oauth_identity_generation', '1');
    const oauthLog = insertLog({
      action_type: 'oauth_scope',
      status: 'success',
      trigger_type: 'scope_fixture',
    });

    setSetting('connection_mode', 'browser');
    setSetting('freee_configured', '1');
    setSetting('freee_password_encrypted', encrypt('synthetic-password'));
    setSetting('freee_username_encrypted', encrypt('synthetic-browser-credential'));
    setSetting('web_company_name', 'Browser Fixture');
    setSetting('web_employee_id_encrypted', encrypt('3003'));
    setSetting('web_identity_generation', '3');

    const inserted = insertLog({
      action_type: 'browser_scope',
      status: 'success',
      trigger_type: 'scope_fixture',
    });
    const row = getDb()
      .prepare('SELECT company_id, company_name, identity_key FROM execution_log WHERE id = ?')
      .get(inserted.lastInsertRowid);
    setSetting('freee_username_encrypted', encrypt('synthetic-browser-credential'));
    setSetting('web_employee_id_encrypted', encrypt('3003'));
    setSetting('web_identity_generation', '4');
    const list = await request(app)
      .get('/api/logs?limit=100')
      .set('x-session-token', sessionToken);
    const oauthDetail = await request(app)
      .get(`/api/logs/${oauthLog.lastInsertRowid}`)
      .set('x-session-token', sessionToken);
    const browserDetail = await request(app)
      .get(`/api/logs/${inserted.lastInsertRowid}`)
      .set('x-session-token', sessionToken);

    expect(row.company_id).toBe('');
    expect(row.company_name).toBe('Browser Fixture');
    expect(row.identity_key).toMatch(/^log-v1:[a-f0-9]{64}$/);
    expect(list.body.rows.some((entry) => entry.action_type === 'browser_scope')).toBe(true);
    expect(list.body.rows.some((entry) => entry.action_type === 'oauth_scope')).toBe(false);
    expect(oauthDetail.status).toBe(404);
    expect(browserDetail.status).toBe(200);

    setSetting('freee_username_encrypted', encrypt('other-browser-credential'));
    setSetting('web_identity_generation', '5');
    const credentialSwitchedList = await request(app)
      .get('/api/logs?limit=100')
      .set('x-session-token', sessionToken);
    const credentialSwitchedDetail = await request(app)
      .get(`/api/logs/${inserted.lastInsertRowid}`)
      .set('x-session-token', sessionToken);

    expect(
      credentialSwitchedList.body.rows.some(
        (entry) => entry.action_type === 'browser_scope',
      ),
    ).toBe(false);
    expect(credentialSwitchedDetail.status).toBe(404);

    setSetting('freee_username_encrypted', encrypt('synthetic-browser-credential'));
    setSetting('web_employee_id_encrypted', encrypt('4004'));
    setSetting('web_identity_generation', '6');
    const switchedList = await request(app)
      .get('/api/logs?limit=100')
      .set('x-session-token', sessionToken);
    const switchedDetail = await request(app)
      .get(`/api/logs/${inserted.lastInsertRowid}`)
      .set('x-session-token', sessionToken);

    expect(switchedList.body.rows.some((entry) => entry.action_type === 'browser_scope')).toBe(false);
    expect(switchedDetail.status).toBe(404);
  });

  it('persists only bounded diagnostic codes and stages', async () => {
    setSetting('connection_mode', 'api');
    setSetting('debug_mode', '0');
    setSetting('oauth_company_id', '10101');
    setSetting('oauth_employee_id', '1001');
    setSetting('oauth_company_name', 'Fixture A');
    setSetting('oauth_identity_generation', '1');

    const valid = insertLog({
      action_type: 'diagnostic_valid',
      status: 'failure',
      trigger_type: 'scope_fixture',
      error_message: 'web_credentials_invalid',
      error_code: 'WEB_LOGIN_FAILED',
      failure_stage: 'login',
    });
    const invalid = insertLog({
      action_type: 'diagnostic_invalid',
      status: 'failure',
      trigger_type: 'scope_fixture',
      error_message: 'web_automation_failed',
      error_code: 'UNREGISTERED_ERROR_CODE',
      failure_stage: 'unregistered-stage-value',
    });

    const validDetail = await request(app)
      .get(`/api/logs/${valid.lastInsertRowid}`)
      .set('x-session-token', sessionToken);
    const invalidDetail = await request(app)
      .get(`/api/logs/${invalid.lastInsertRowid}`)
      .set('x-session-token', sessionToken);
    getDb().prepare(
      "UPDATE execution_log SET executed_at = '2026-07-12 09:50:00', business_date = NULL WHERE id = ?",
    ).run(valid.lastInsertRowid);
    const filtered = await request(app)
      .get('/api/logs?date_from=2026-07-12&date_to=2026-07-12&status=failure&search=WEB_LOGIN_FAILED')
      .set('x-session-token', sessionToken);
    const reverseRange = await request(app)
      .get('/api/logs?date_from=2026-07-13&date_to=2026-07-12')
      .set('x-session-token', sessionToken);
    const invalidStatus = await request(app)
      .get('/api/logs?status=private')
      .set('x-session-token', sessionToken);

    expect(validDetail.status).toBe(200);
    expect(validDetail.body).toMatchObject({
      error_code: 'WEB_LOGIN_FAILED',
      failure_stage: 'login',
    });
    expect(invalidDetail.status).toBe(200);
    expect(invalidDetail.body.error_code).toBeNull();
    expect(invalidDetail.body.failure_stage).toBeNull();
    expect(JSON.stringify(invalidDetail.body)).not.toContain('UNREGISTERED_ERROR_CODE');
    expect(JSON.stringify(invalidDetail.body)).not.toContain('unregistered-stage-value');
    expect(filtered.status).toBe(200);
    expect(filtered.body.rows.map((row) => row.id)).toEqual([
      Number(valid.lastInsertRowid),
    ]);
    expect(reverseRange.status).toBe(400);
    expect(invalidStatus.status).toBe(400);
  });

  it('preserves verified browser logs when credentials move between storage sources', async () => {
    const environment = {
      LOGIN_USERNAME: process.env.LOGIN_USERNAME,
      LOGIN_PASSWORD: process.env.LOGIN_PASSWORD,
      FREEE_EMPLOYEE_ID: process.env.FREEE_EMPLOYEE_ID,
    };

    setSetting('connection_mode', 'browser');
    setSetting('debug_mode', '0');
    setSetting('freee_configured', '1');
    setSetting('freee_password_encrypted', encrypt('synthetic-password'));
    setSetting('freee_username_encrypted', encrypt('storage-migration-user'));
    setSetting('web_company_name', 'Storage Migration Fixture');
    setSetting('web_employee_id_encrypted', encrypt('5005'));
    setSetting('web_identity_generation', '7');
    const inserted = insertLog({
      action_type: 'browser_storage_migration_scope',
      status: 'success',
      trigger_type: 'scope_fixture',
    });

    try {
      process.env.LOGIN_USERNAME = 'storage-migration-user';
      process.env.LOGIN_PASSWORD = 'synthetic-password';
      process.env.FREEE_EMPLOYEE_ID = '5005';
      setSetting('freee_configured', '0');
      setSetting('freee_username_encrypted', '');
      setSetting('freee_password_encrypted', '');
      setSetting('web_identity_generation', '8');

      const list = await request(app)
        .get('/api/logs?limit=100')
        .set('x-session-token', sessionToken);
      const detail = await request(app)
        .get(`/api/logs/${inserted.lastInsertRowid}`)
        .set('x-session-token', sessionToken);

      expect(
        list.body.rows.some(
          (entry) => entry.action_type === 'browser_storage_migration_scope',
        ),
      ).toBe(true);
      expect(detail.status).toBe(200);
    } finally {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
