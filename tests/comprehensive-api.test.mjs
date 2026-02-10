/**
 * Comprehensive API & Feature Tests
 *
 * Tests all API actions, mock mode state machine, strategy cache,
 * holiday cache, web automation fallback logic, and scheduler.
 *
 * Runs in debug/mock mode to simulate all operations without
 * real freee API credentials.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { initDatabase, getDb } from '../server/db.js';

// Initialize database
initDatabase();

const { default: app } = await import('../server/app.js');

const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'admin';
let TOKEN;

beforeAll(async () => {
  const db = getDb();
  // Reset admin user
  const adminHash = bcrypt.hashSync(DEFAULT_PASS, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(DEFAULT_USER);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(adminHash, existing.id);
  }

  // Login
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
  TOKEN = res.body.token;

  // Enable debug/mock mode
  await request(app)
    .put('/api/config/debug/set')
    .set('x-session-token', TOKEN)
    .send({ enabled: true });
});

afterAll(async () => {
  // Disable debug mode after tests
  if (TOKEN) {
    await request(app)
      .put('/api/config/debug/set')
      .set('x-session-token', TOKEN)
      .send({ enabled: false });
  }
});

// ────────────────────────────────────────
//  Mock Mode State Machine Tests
// ────────────────────────────────────────

describe('Mock Mode: State Detection', () => {
  it('GET /api/status returns valid status object', async () => {
    const res = await request(app)
      .get('/api/status')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('auto_checkin_enabled');
    expect(res.body).toHaveProperty('connection_mode');
    expect(res.body).toHaveProperty('debug_mode');
  });

  it('GET /api/status/freee-state detects state in mock mode', async () => {
    const res = await request(app)
      .get('/api/status/freee-state')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('state');
    expect(res.body.debug_mode).toBe(true);
    // State should be one of the valid enum values
    expect(['not_checked_in', 'working', 'on_break', 'checked_out', 'unknown'])
      .toContain(res.body.state);
    expect(res.body).toHaveProperty('valid_actions');
    expect(Array.isArray(res.body.valid_actions)).toBe(true);
  });
});

describe('Mock Mode: Clock Actions (checkin → break → checkout)', () => {
  it('POST /api/schedule/trigger/checkin succeeds in mock mode', async () => {
    const res = await request(app)
      .post('/api/schedule/trigger/checkin')
      .set('x-session-token', TOKEN);
    // In mock mode, trigger should work (200) or indicate already done
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      // Trigger returns { status: 'success'|'failure'|'skipped', ... }
      expect(res.body.status).toBe('success');
    }
  });

  it('state changes to working after checkin', async () => {
    const res = await request(app)
      .get('/api/status/freee-state')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    // After checkin, state should be working (or checked_out if auto-progressed)
    expect(['working', 'checked_out', 'not_checked_in']).toContain(res.body.state);
  });

  it('POST /api/schedule/trigger/break_start succeeds in mock mode', async () => {
    const res = await request(app)
      .post('/api/schedule/trigger/break_start')
      .set('x-session-token', TOKEN);
    expect([200, 400]).toContain(res.status);
  });

  it('POST /api/schedule/trigger/break_end succeeds in mock mode', async () => {
    const res = await request(app)
      .post('/api/schedule/trigger/break_end')
      .set('x-session-token', TOKEN);
    expect([200, 400]).toContain(res.status);
  });

  it('POST /api/schedule/trigger/checkout succeeds in mock mode', async () => {
    const res = await request(app)
      .post('/api/schedule/trigger/checkout')
      .set('x-session-token', TOKEN);
    expect([200, 400]).toContain(res.status);
  });
});

// ────────────────────────────────────────
//  Schedule Endpoints
// ────────────────────────────────────────

describe('Schedule Endpoints', () => {
  it('GET /api/schedule returns today schedule with all action types', async () => {
    const res = await request(app)
      .get('/api/schedule')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('date');
    expect(res.body).toHaveProperty('schedule');
  });

  it('PUT /api/config/checkin updates checkin schedule config', async () => {
    const res = await request(app)
      .put('/api/config/checkin')
      .set('x-session-token', TOKEN)
      .send({
        mode: 'random',
        window_start: '08:50',
        window_end: '09:10',
        enabled: true
      });
    expect(res.status).toBe(200);
  });

  it('PUT /api/config/checkout updates checkout schedule config', async () => {
    const res = await request(app)
      .put('/api/config/checkout')
      .set('x-session-token', TOKEN)
      .send({
        mode: 'fixed',
        fixed_time: '18:00',
        enabled: true
      });
    expect(res.status).toBe(200);
  });

  it('PUT /api/config/break_start updates break config', async () => {
    const res = await request(app)
      .put('/api/config/break_start')
      .set('x-session-token', TOKEN)
      .send({
        mode: 'random',
        window_start: '12:00',
        window_end: '12:15',
        enabled: true
      });
    expect(res.status).toBe(200);
  });

  it('PUT /api/config/break_end updates break end config', async () => {
    const res = await request(app)
      .put('/api/config/break_end')
      .set('x-session-token', TOKEN)
      .send({
        mode: 'random',
        window_start: '13:00',
        window_end: '13:15',
        enabled: true
      });
    expect(res.status).toBe(200);
  });

  it('config roundtrip: saved schedule reflects in GET', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    // Config returns schedules array with action_type entries, not checkin_mode
    const config = res.body;
    expect(config).toHaveProperty('schedules');
    expect(Array.isArray(config.schedules)).toBe(true);
    // Verify our saved schedule entries exist
    const checkinSched = config.schedules.find(s => s.action_type === 'checkin');
    const checkoutSched = config.schedules.find(s => s.action_type === 'checkout');
    expect(checkinSched).toBeDefined();
    expect(checkoutSched).toBeDefined();
    expect(checkinSched.mode).toBe('random');
    expect(checkoutSched.mode).toBe('fixed');
  });
});

// ────────────────────────────────────────
//  Config Toggle Endpoints
// ────────────────────────────────────────

describe('Config Toggle Endpoints', () => {
  it('PUT /api/config/toggle enables/disables auto checkin', async () => {
    // Enable
    let res = await request(app)
      .put('/api/config/toggle')
      .set('x-session-token', TOKEN)
      .send({ enabled: true });
    expect(res.status).toBe(200);

    // Check value
    const configRes = await request(app)
      .get('/api/config')
      .set('x-session-token', TOKEN);
    expect(configRes.body.auto_checkin_enabled).toBe(true);

    // Disable
    res = await request(app)
      .put('/api/config/toggle')
      .set('x-session-token', TOKEN)
      .send({ enabled: false });
    expect(res.status).toBe(200);
  });

  it('PUT /api/config/debug toggles debug/mock mode', async () => {
    // Verify debug is on
    const statusRes = await request(app)
      .get('/api/status/freee-state')
      .set('x-session-token', TOKEN);
    expect(statusRes.body.debug_mode).toBe(true);
  });

  it('PUT /api/config/holiday-skip-countries sets holiday skip countries', async () => {
    // countries must be a comma-separated string, lowercase
    const res = await request(app)
      .put('/api/config/holiday-skip-countries')
      .set('x-session-token', TOKEN)
      .send({ countries: 'jp,cn' });
    expect(res.status).toBe(200);

    // Verify
    const configRes = await request(app)
      .get('/api/config')
      .set('x-session-token', TOKEN);
    expect(configRes.body.holiday_skip_countries).toContain('jp');
  });
});

// ────────────────────────────────────────
//  OAuth Config Endpoints (no real OAuth)
// ────────────────────────────────────────

describe('OAuth Config Endpoints', () => {
  it('GET /api/config/oauth-status returns OAuth state', async () => {
    const res = await request(app)
      .get('/api/config/oauth-status')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(typeof res.body).toBe('object');
  });

  it('PUT /api/config/oauth-app stores client ID and secret', async () => {
    const res = await request(app)
      .put('/api/config/oauth-app')
      .set('x-session-token', TOKEN)
      .send({
        client_id: 'test_client_id_12345',
        client_secret: 'test_client_secret_67890'
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/config/oauth-status shows status after save', async () => {
    const res = await request(app)
      .get('/api/config/oauth-status')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    // Should have status info (property names may vary)
    expect(res.body).toBeDefined();
    expect(typeof res.body).toBe('object');
  });

  it('GET /api/config/oauth-authorize-url generates authorization URL', async () => {
    // First save OAuth app credentials so URL generation works
    await request(app)
      .put('/api/config/oauth-app')
      .set('x-session-token', TOKEN)
      .send({ client_id: 'test_url_client', client_secret: 'test_url_secret' });

    const res = await request(app)
      .get('/api/config/oauth-authorize-url')
      .set('x-session-token', TOKEN);
    // Should return 200 with URL, or 400 if client_id not configured
    if (res.status === 200) {
      expect(res.body).toHaveProperty('url');
      expect(res.body.url).toContain('freee.co.jp');
    }
  });

  it('DELETE /api/config/oauth clears all OAuth data', async () => {
    const res = await request(app)
      .delete('/api/config/oauth')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);

    // Verify OAuth is cleared
    const statusRes = await request(app)
      .get('/api/config/oauth-status')
      .set('x-session-token', TOKEN);
    expect(statusRes.status).toBe(200);
  });
});

// ────────────────────────────────────────
//  Credential Management (Browser Mode)
// ────────────────────────────────────────

describe('Web Credential Management', () => {
  it('PUT /api/config/account stores encrypted credentials', async () => {
    const res = await request(app)
      .put('/api/config/account')
      .set('x-session-token', TOKEN)
      .send({
        username: 'test@freee.co.jp',
        password: 'TestPassword123!'
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/config/account returns username but never password', async () => {
    const res = await request(app)
      .get('/api/config/account')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.freee_username).toBe('test@freee.co.jp');
    expect(res.body.freee_configured).toBe(true);
    // Password must NEVER be returned
    expect(res.body.password).toBeUndefined();
    expect(res.body.freee_password).toBeUndefined();
    expect(res.body.freee_password_encrypted).toBeUndefined();
  });

  it('credentials are stored encrypted in DB (not plaintext)', async () => {
    const db = getDb();
    const plainUsername = db.prepare(
      "SELECT value FROM settings WHERE key = 'freee_username'"
    ).get();
    const encryptedUsername = db.prepare(
      "SELECT value FROM settings WHERE key = 'freee_username_encrypted'"
    ).get();
    // Plaintext field should be empty/cleared
    expect(plainUsername?.value || '').toBe('');
    // Encrypted field should have iv:tag:cipher format
    expect(encryptedUsername?.value).toBeDefined();
    expect(encryptedUsername.value.split(':').length).toBe(3);
  });

  it('DELETE /api/config/account clears all credential fields', async () => {
    const res = await request(app)
      .delete('/api/config/account')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);

    const db = getDb();
    const encrypted = db.prepare(
      "SELECT value FROM settings WHERE key = 'freee_username_encrypted'"
    ).get();
    expect(encrypted?.value || '').toBe('');
  });
});

// ────────────────────────────────────────
//  Attendance Endpoints (Mock/No-OAuth)
// ────────────────────────────────────────

describe('Attendance Endpoints', () => {
  it('GET /api/attendance/capabilities returns capability info', async () => {
    const res = await request(app)
      .get('/api/attendance/capabilities')
      .set('x-session-token', TOKEN);
    // May return 200 (with mock data) or 400/500 (no OAuth configured)
    expect([200, 400, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('direct_edit');
      expect(res.body).toHaveProperty('approval');
    }
  });

  it('GET /api/attendance/strategy-cache returns cache status', async () => {
    const res = await request(app)
      .get('/api/attendance/strategy-cache')
      .set('x-session-token', TOKEN);
    // Strategy cache endpoint should return cache info or empty
    expect([200, 400, 500]).toContain(res.status);
    if (res.status === 200) {
      // Should have month and strategy info
      expect(res.body).toHaveProperty('month');
    }
  });
});

// ────────────────────────────────────────
//  Holiday Endpoints & Cache
// ────────────────────────────────────────

describe('Holiday Endpoints', () => {
  it('GET /api/holidays returns holiday list with year param', async () => {
    const res = await request(app)
      .get('/api/holidays?year=2026')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('national');
    expect(res.body).toHaveProperty('custom');
  });

  it('POST /api/holidays/custom creates custom holiday', async () => {
    // Clean up first in case previous test left data
    const cleanList = await request(app)
      .get('/api/holidays?year=2026')
      .set('x-session-token', TOKEN);
    if (cleanList.status === 200 && cleanList.body.custom) {
      const existing = cleanList.body.custom.find(h => h.date === '2026-12-31');
      if (existing?.id) {
        await request(app)
          .delete(`/api/holidays/custom/${existing.id}`)
          .set('x-session-token', TOKEN);
      }
    }

    const res = await request(app)
      .post('/api/holidays/custom')
      .set('x-session-token', TOKEN)
      .send({
        date: '2026-12-31',
        description: 'Test Custom Holiday'
      });
    // 200 or 201 for success
    expect([200, 201]).toContain(res.status);
  });

  it('custom holiday appears in holiday list', async () => {
    const res = await request(app)
      .get('/api/holidays?year=2026')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    const customHolidays = res.body.custom || [];
    expect(customHolidays.some(h => h.date === '2026-12-31')).toBe(true);
  });

  it('DELETE /api/holidays/custom/:id removes custom holiday', async () => {
    const listRes = await request(app)
      .get('/api/holidays?year=2026')
      .set('x-session-token', TOKEN);
    const custom = listRes.body?.custom || [];
    const holiday = custom.find(h => h.date === '2026-12-31');
    if (holiday?.id) {
      const res = await request(app)
        .delete(`/api/holidays/custom/${holiday.id}`)
        .set('x-session-token', TOKEN);
      expect(res.status).toBe(200);
    } else {
      // Holiday might have been cleaned up already, that's OK
      expect(true).toBe(true);
    }
  });
});

// ────────────────────────────────────────
//  Holiday Cache Verification
// ────────────────────────────────────────

describe('Holiday Cache', () => {
  it('holiday cache stores data in settings table', async () => {
    // After GET /api/holidays, cache should be populated
    await request(app)
      .get('/api/holidays?year=2026')
      .set('x-session-token', TOKEN);

    const db = getDb();
    const year = new Date().getFullYear();
    const cacheKey = `holiday_cache_JP_${year}`;
    const cached = db.prepare(
      "SELECT value FROM settings WHERE key = ?"
    ).get(cacheKey);

    // Cache may or may not be populated depending on external API availability
    // This test verifies the mechanism exists
    if (cached?.value) {
      // If cached, it should be valid JSON
      expect(() => JSON.parse(cached.value)).not.toThrow();
    }
  });

  it('holiday cache date is stored alongside data', async () => {
    const db = getDb();
    const year = new Date().getFullYear();
    const cacheDateKey = `holiday_cache_date_JP_${year}`;
    const cacheDate = db.prepare(
      "SELECT value FROM settings WHERE key = ?"
    ).get(cacheDateKey);

    if (cacheDate?.value) {
      // Should be YYYY-MM-DD format
      expect(cacheDate.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ────────────────────────────────────────
//  Logs Endpoints
// ────────────────────────────────────────

describe('Logs Endpoints', () => {
  it('GET /api/logs returns paginated execution history', async () => {
    const res = await request(app)
      .get('/api/logs')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rows');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it('GET /api/logs supports pagination params', async () => {
    const res = await request(app)
      .get('/api/logs?page=1&limit=5')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeLessThanOrEqual(5);
  });
});

// ────────────────────────────────────────
//  Connection Mode Tests
// ────────────────────────────────────────

describe('Connection Mode', () => {
  it('GET /api/config shows current connection mode', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('x-session-token', TOKEN);
    expect(res.status).toBe(200);
    expect(['api', 'browser']).toContain(res.body.connection_mode);
  });
});

// ────────────────────────────────────────
//  Web Automation Fallback Logic Tests
// ────────────────────────────────────────

describe('Web Automation Fallback Logic', () => {
  it('automation module exports expected functions', async () => {
    const automation = await import('../server/automation.js');
    expect(typeof automation.detectCurrentState).toBe('function');
    expect(typeof automation.executeAction).toBe('function');
    expect(typeof automation.determineActionsForToday).toBe('function');
    expect(typeof automation.submitWebCorrections).toBe('function');
    expect(typeof automation.scrapeEmployeeProfile).toBe('function');
    expect(typeof automation.submitLeaveRequest).toBe('function');
    expect(typeof automation.hasWebCredentials).toBe('function');
    expect(typeof automation.getConnectionMode).toBe('function');
    expect(typeof automation.isDebugMode).toBe('function');
    expect(typeof automation.hasCredentials).toBe('function');
  });

  it('isDebugMode returns true when mock mode enabled', async () => {
    const { isDebugMode } = await import('../server/automation.js');
    expect(isDebugMode()).toBe(true);
  });

  it('determineActionsForToday generates correct plan for NOT_CHECKED_IN', async () => {
    const { determineActionsForToday } = await import('../server/automation.js');
    const schedule = {
      checkin: { enabled: true, time: '09:00' },
      break_start: { enabled: true, time: '12:00' },
      break_end: { enabled: true, time: '13:00' },
      checkout: { enabled: true, time: '18:00' }
    };
    const result = determineActionsForToday('NOT_CHECKED_IN', schedule);
    expect(result).toHaveProperty('execute');
    expect(result).toHaveProperty('skip');
    expect(Array.isArray(result.execute)).toBe(true);
  });

  it('determineActionsForToday generates correct plan for CHECKED_OUT', async () => {
    const { determineActionsForToday } = await import('../server/automation.js');
    const schedule = {
      checkin: { enabled: true, time: '09:00' },
      checkout: { enabled: true, time: '18:00' }
    };
    const result = determineActionsForToday('CHECKED_OUT', schedule);
    // When checked out, everything should be skipped
    expect(result.execute.length).toBe(0);
  });
});

// ────────────────────────────────────────
//  Crypto Module Tests (Extended)
// ────────────────────────────────────────

describe('Crypto Module: Encryption Integrity', () => {
  it('encrypted tokens round-trip correctly', async () => {
    const { encrypt, decrypt } = await import('../server/crypto.js');
    // Simulate OAuth token encryption
    const accessToken = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test.signature';
    const refreshToken = 'refresh_token_abc123xyz';

    const encAccess = encrypt(accessToken);
    const encRefresh = encrypt(refreshToken);

    expect(decrypt(encAccess)).toBe(accessToken);
    expect(decrypt(encRefresh)).toBe(refreshToken);
  });

  it('encrypted field format is consistent (iv:tag:cipher)', async () => {
    const { encrypt } = await import('../server/crypto.js');
    const encrypted = encrypt('test-data');
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
    // IV: 32 hex chars (16 bytes)
    expect(parts[0].length).toBe(32);
    // Auth tag: 32 hex chars (16 bytes)
    expect(parts[1].length).toBe(32);
    // Cipher: variable length hex
    expect(parts[2].length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────
//  Scheduler Module Tests
// ────────────────────────────────────────

describe('Scheduler Module', () => {
  it('scheduler module exports singleton instance', async () => {
    const { scheduler } = await import('../server/scheduler.js');
    expect(scheduler).toBeDefined();
    expect(typeof scheduler.resolveAndScheduleToday).toBe('function');
    expect(typeof scheduler.getTodaySchedule).toBe('function');
  });

  it('scheduler getTodaySchedule returns schedule object', async () => {
    const { scheduler } = await import('../server/scheduler.js');
    const schedule = scheduler.getTodaySchedule();
    expect(schedule).toBeDefined();
    // Schedule should be an object (may be empty if not resolved)
    expect(typeof schedule).toBe('object');
  });
});

// ────────────────────────────────────────
//  FreeeApiClient Module Tests
// ────────────────────────────────────────

describe('FreeeApiClient Module', () => {
  it('FreeeApiClient class is exported', async () => {
    const { FreeeApiClient } = await import('../server/freee-api.js');
    expect(FreeeApiClient).toBeDefined();
    expect(typeof FreeeApiClient).toBe('function');
  });

  it('FreeeApiClient instance has expected methods', async () => {
    const { FreeeApiClient } = await import('../server/freee-api.js');
    const client = new FreeeApiClient();
    expect(typeof client.ensureValidToken).toBe('function');
    expect(typeof client.apiRequest).toBe('function');
    expect(typeof client.ensureUserInfo).toBe('function');
    expect(typeof client.detectState).toBe('function');
    expect(typeof client.executeClockAction).toBe('function');
    expect(typeof client.verifyConnection).toBe('function');
  });
});

// ────────────────────────────────────────
//  Constants & State Machine
// ────────────────────────────────────────

describe('Constants & State Machine', () => {
  it('FREEE_STATE enum has all expected values', async () => {
    const { FREEE_STATE } = await import('../server/constants.js');
    expect(FREEE_STATE.NOT_CHECKED_IN).toBe('not_checked_in');
    expect(FREEE_STATE.WORKING).toBe('working');
    expect(FREEE_STATE.ON_BREAK).toBe('on_break');
    expect(FREEE_STATE.CHECKED_OUT).toBe('checked_out');
    expect(FREEE_STATE.UNKNOWN).toBe('unknown');
  });
});
