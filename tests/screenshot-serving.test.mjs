import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createSession,
  currentExecutionLogIdentityKey,
  deleteSession,
  getDb,
  getSetting,
  initDatabase,
  setSetting,
} from '../server/db.js';

const screenshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-screenshots-'));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-screenshot-target-'));
process.env.SCREENSHOTS_DIR = screenshotRoot;

initDatabase();
const { default: app } = await import('../server/app.js');
const { ensureScreenshotsDir } = await import('../server/automation/constants.js');

const sessionToken = ['screenshot', 'route', 'fixture'].join('-');
const originalSettings = new Map();

function selectIdentity(companyId, employeeId, companyName) {
  setSetting('connection_mode', 'api');
  setSetting('debug_mode', '0');
  setSetting('oauth_company_id', companyId);
  setSetting('oauth_employee_id', employeeId);
  setSetting('oauth_company_name', companyName);
}

function activeScreenshotDirectory() {
  return ensureScreenshotsDir(screenshotRoot, currentExecutionLogIdentityKey());
}

beforeAll(() => {
  for (const key of [
    'connection_mode',
    'debug_mode',
    'oauth_company_id',
    'oauth_employee_id',
    'oauth_company_name',
  ]) {
    originalSettings.set(key, getSetting(key));
  }
  const db = getDb();
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(user.id);
  createSession(sessionToken, user.id, new Date(Date.now() + 60_000).toISOString());
});

beforeEach(() => {
  selectIdentity('10101', '1001', 'Screenshot Fixture A');
});

afterAll(() => {
  for (const [key, value] of originalSettings) setSetting(key, value || '');
  deleteSession(sessionToken);
  fs.rmSync(screenshotRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
  delete process.env.SCREENSHOTS_DIR;
});

describe('authenticated screenshot serving', () => {
  it('serves a regular PNG with private no-store caching', async () => {
    const filename = 'capture-before-2026-07-12T00-00-00-000.png';
    fs.writeFileSync(
      path.join(activeScreenshotDirectory(), filename),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const res = await request(app)
      .get(`/screenshots/${filename}`)
      .set('x-session-token', sessionToken);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('does not follow a symbolic link out of the screenshot directory', async () => {
    const target = path.join(outsideRoot, 'outside.png');
    const filename = 'linked-before-2026-07-12T00-00-00-000.png';
    fs.writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.symlinkSync(target, path.join(activeScreenshotDirectory(), filename));

    const res = await request(app)
      .get(`/screenshots/${filename}`)
      .set('x-session-token', sessionToken);

    expect(res.status).toBe(404);
  });

  it('rejects non-PNG artifact names', async () => {
    const res = await request(app)
      .get('/screenshots/runtime.txt')
      .set('x-session-token', sessionToken);
    expect(res.status).toBe(404);
  });

  it('rejects encoded traversal outside the screenshot directory', async () => {
    const res = await request(app)
      .get('/screenshots/%2e%2e%2foutside.png')
      .set('x-session-token', sessionToken);
    expect(res.status).toBe(404);
  });

  it('does not serve a screenshot after the selected account changes', async () => {
    const filename = 'account-bound-before-2026-07-12T00-00-00-000.png';
    fs.writeFileSync(
      path.join(activeScreenshotDirectory(), filename),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    selectIdentity('20202', '2002', 'Screenshot Fixture B');
    const hidden = await request(app)
      .get(`/screenshots/${filename}`)
      .set('x-session-token', sessionToken);

    expect(hidden.status).toBe(404);
  });
});
