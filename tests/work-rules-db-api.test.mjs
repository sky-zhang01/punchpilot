import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllConfig, getDb, getSetting, initDatabase, setSetting, updateConfig } from '../server/db.js';
import { Scheduler, scheduler as sharedScheduler } from '../server/scheduler.js';
import { currentAutomationIdentityKey } from '../server/automation/identity.js';
import { getDailySchedule } from '../server/db.js';
import { timeToMinutes } from '../shared/date-time.js';
import configRouter from '../server/routes/api-config.js';

// These tests drive the scheduler, which logs every planning step, and they assert on the
// stored plans, never on log text. On CI the last of those lines could still be in flight to
// the Vitest main thread when the worker closed, failing the run with EnvironmentTeardownError
// although every test passed. Keep the output off that channel for the whole file.
for (const method of ['log', 'warn', 'error']) vi.spyOn(console, method).mockImplementation(() => {});

const ACTIONS = ['checkin', 'checkout', 'break_start', 'break_end'];

function applyConfigs(configs) {
  for (const [action, values] of Object.entries(configs)) updateConfig(action, { enabled: 1, ...values });
}
const random = (window_start, window_end) => ({ mode: 'random', window_start, window_end });
const fixedAt = (fixed_time) => ({ mode: 'fixed', fixed_time });

function seedFresh() {
  getDb().prepare('DELETE FROM settings WHERE key IN (?, ?)').run('min_net_work_minutes', 'max_break_minutes');
}

const OWNER = {
  checkin: random('09:50', '10:00'),
  break_start: random('12:00', '13:00'),
  break_end: random('13:00', '14:00'),
  checkout: random('19:15', '20:30'),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
  initDatabase();
  setSetting('auto_checkin_enabled', '0');
  getDb().prepare('DELETE FROM daily_schedule').run();
});
afterEach(() => { sharedScheduler.stopAll(); vi.useRealTimers(); });

describe('work rule settings seeding', () => {
  it('seeds 480 and 75 for the owner configuration', () => {
    applyConfigs(OWNER);
    seedFresh();
    initDatabase();
    expect(getSetting('min_net_work_minutes')).toBe('480');
    expect(getSetting('max_break_minutes')).toBe('75');
  });

  it('keeps the old 90 minute cap when the break windows need it', () => {
    applyConfigs({ ...OWNER, break_start: fixedAt('12:00'), break_end: fixedAt('13:30') });
    seedFresh();
    initDatabase();
    expect(getSetting('max_break_minutes')).toBe('90');
    expect(getSetting('min_net_work_minutes')).toBe('480');
  });

  it('leaves the net work rule off when part-time windows could never meet it', () => {
    applyConfigs({ checkin: random('09:00', '09:10'), checkout: random('15:00', '15:30'),
      break_start: random('12:00', '12:10'), break_end: random('13:00', '13:10') });
    seedFresh();
    initDatabase();
    expect(getSetting('max_break_minutes')).toBe('75');
    expect(getSetting('min_net_work_minutes')).toBe('0');
  });

  it('never overwrites stored values', () => {
    setSetting('min_net_work_minutes', '300');
    setSetting('max_break_minutes', '100');
    initDatabase();
    expect(getSetting('min_net_work_minutes')).toBe('300');
    expect(getSetting('max_break_minutes')).toBe('100');
  });

  it('seeds only the missing key, using the stored cap for the feasibility check', () => {
    applyConfigs({ ...OWNER, break_start: fixedAt('12:00'), break_end: fixedAt('13:30') });
    setSetting('max_break_minutes', '90');
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('min_net_work_minutes');
    initDatabase();
    expect(getSetting('min_net_work_minutes')).toBe('480');
    expect(getSetting('max_break_minutes')).toBe('90');
  });
});

function handlerFor(path, method) {
  return configRouter.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function call(path, method, req) {
  const res = response();
  await handlerFor(path, method)({ params: {}, body: {}, ...req }, res);
  return res;
}
const putRules = (body) => call('/work-rules', 'put', { body });
const putAction = (actionType, body) => call('/:actionType', 'put', { params: { actionType }, body });

describe('PUT /api/config/work-rules', () => {
  beforeEach(() => {
    for (const action of ACTIONS) updateConfig(action, { enabled: 0 });
    applyConfigs(OWNER);
    setSetting('min_net_work_minutes', '480');
    setSetting('max_break_minutes', '75');
  });

  it('is declared before the generic action route so it is reachable', () => {
    const paths = configRouter.stack.filter((layer) => layer.route?.methods.put).map((layer) => layer.route.path);
    expect(paths.indexOf('/work-rules')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/work-rules')).toBeLessThan(paths.indexOf('/:actionType'));
  });

  it('stores valid rules and returns them as numbers', async () => {
    const res = await putRules({ min_net_work_minutes: 450, max_break_minutes: 80 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ min_net_work_minutes: 450, max_break_minutes: 80 });
    expect(getSetting('min_net_work_minutes')).toBe('450');
    expect(getSetting('max_break_minutes')).toBe('80');
    const config = await call('/', 'get', {});
    expect(config.body).toMatchObject({ min_net_work_minutes: 450, max_break_minutes: 80 });
  });

  it('allows 0 to switch the minimum off', async () => {
    expect((await putRules({ min_net_work_minutes: 0, max_break_minutes: 75 })).statusCode).toBe(200);
    expect(getSetting('min_net_work_minutes')).toBe('0');
  });

  it('rejects out-of-range, non-integer and non-numeric values without storing anything', async () => {
    for (const body of [
      { min_net_work_minutes: 59, max_break_minutes: 75 },
      { min_net_work_minutes: 961, max_break_minutes: 75 },
      { min_net_work_minutes: 480.5, max_break_minutes: 75 },
      { min_net_work_minutes: '480', max_break_minutes: 75 },
      { min_net_work_minutes: 480 },
      { min_net_work_minutes: 480, max_break_minutes: 59 },
      { min_net_work_minutes: 480, max_break_minutes: 181 },
      { min_net_work_minutes: 480, max_break_minutes: null },
      undefined,
    ]) {
      const res = await putRules(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toMatch(/must be/);
    }
    expect(getSetting('min_net_work_minutes')).toBe('480');
    expect(getSetting('max_break_minutes')).toBe('75');
  });

  it('rejects a cap the saved break windows cannot meet', async () => {
    applyConfigs({ break_start: fixedAt('12:00'), break_end: fixedAt('13:30') });
    const res = await putRules({ min_net_work_minutes: 480, max_break_minutes: 75 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Break windows must allow at least 60 minutes and at most 75 minutes/);
    expect((await putRules({ min_net_work_minutes: 480, max_break_minutes: 90 })).statusCode).toBe(200);
  });

  it('rejects a minimum the saved windows cannot guarantee', async () => {
    const res = await putRules({ min_net_work_minutes: 700, max_break_minutes: 75 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cannot guarantee 700 minutes/);
    expect(getSetting('min_net_work_minutes')).toBe('480');
  });
});

describe('PUT /api/config/:actionType keeps the work rules satisfiable', () => {
  beforeEach(() => {
    for (const action of ACTIONS) updateConfig(action, { enabled: 0 });
    applyConfigs(OWNER);
    setSetting('min_net_work_minutes', '480');
    setSetting('max_break_minutes', '75');
  });

  it('rejects a checkout window that ends too early', async () => {
    const res = await putAction('checkout', { window_start: '18:00', window_end: '18:30' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cannot guarantee 480 minutes/);
    expect(getAllConfig().find((cfg) => cfg.action_type === 'checkout').window_end).toBe('20:30');
  });

  it('rejects a later check-in window that no longer fits', async () => {
    expect((await putAction('checkin', { window_start: '13:00', window_end: '14:00' })).statusCode).toBe(400);
  });

  it('rejects break windows beyond the current cap, using the stored maximum', async () => {
    const res = await putAction('break_end', { mode: 'fixed', fixed_time: '14:30' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at most 75 minutes/);
    setSetting('max_break_minutes', '90');
    expect((await putAction('break_start', { mode: 'fixed', fixed_time: '12:30' })).statusCode).toBe(200);
  });

  it('accepts a compatible change, and any change while the minimum is off', async () => {
    expect((await putAction('checkout', { window_start: '19:30', window_end: '20:00' })).statusCode).toBe(200);
    setSetting('min_net_work_minutes', '0');
    expect((await putAction('checkout', { window_start: '12:00', window_end: '12:30' })).statusCode).toBe(200);
  });

  it('considers enabled toggles: enabling checkout under an infeasible setup is refused', async () => {
    updateConfig('checkout', { window_start: '12:00', window_end: '12:30', enabled: 0 });
    expect((await putAction('checkout', { enabled: true })).statusCode).toBe(400);
    expect((await putAction('checkin', { enabled: false })).statusCode).toBe(200);
  });
});

describe('PUT /api/config/:actionType does not block edits over a pre-existing problem', () => {
  beforeEach(() => {
    for (const action of ACTIONS) updateConfig(action, { enabled: 0 });
    applyConfigs({ ...OWNER, break_start: fixedAt('12:00'), break_end: fixedAt('12:45') });
    setSetting('min_net_work_minutes', '480');
    setSetting('max_break_minutes', '90');
  });

  it('lets check-in and check-out be edited while the break pair is already incompatible', async () => {
    expect((await putAction('checkin', { window_start: '09:40', window_end: '09:50' })).statusCode).toBe(200);
    expect((await putAction('checkout', { window_start: '19:30', window_end: '20:00' })).statusCode).toBe(200);
  });

  it('still validates a break edit, and still refuses a break edit that stays incompatible', async () => {
    expect((await putAction('break_end', { mode: 'fixed', fixed_time: '12:50' })).statusCode).toBe(400);
    expect((await putAction('break_end', { mode: 'fixed', fixed_time: '13:15' })).statusCode).toBe(200);
  });
});

describe('daily planning through the scheduler', () => {
  it('stores times that satisfy the break cap and the minimum net work, and keeps them on re-resolution', async () => {
    const minutes = (rows, action) => timeToMinutes(rows.find((row) => row.action_type === action).resolved_time);
    for (const action of ACTIONS) updateConfig(action, { enabled: 0 });
    applyConfigs({ ...OWNER, checkout: random('19:15', '20:00') });
    setSetting('min_net_work_minutes', '480');
    setSetting('max_break_minutes', '75');
    const scheduler = new Scheduler();
    scheduler.getTodayCalendarStatus = async () => ({ isNonWorkingDay: false, verificationFailed: false });
    try {
      for (let day = 0; day < 40; day += 1) {
        getDb().prepare('DELETE FROM daily_schedule').run();
        await scheduler.resolveAndScheduleToday();
        const rows = getDailySchedule('2026-10-05', currentAutomationIdentityKey());
        expect(rows).toHaveLength(4);
        const length = minutes(rows, 'break_end') - minutes(rows, 'break_start');
        expect(length).toBeGreaterThanOrEqual(60);
        expect(length).toBeLessThanOrEqual(75);
        expect(minutes(rows, 'checkout') - minutes(rows, 'checkin') - length).toBeGreaterThanOrEqual(480);
        expect(minutes(rows, 'checkout')).toBeLessThanOrEqual(timeToMinutes('20:00'));
        const before = rows.map((row) => row.resolved_time);
        await scheduler.resolveAndScheduleToday();
        expect(getDailySchedule('2026-10-05', currentAutomationIdentityKey()).map((row) => row.resolved_time)).toEqual(before);
      }
    } finally {
      scheduler.stopAll();
    }
  });
});

describe('legacy break placeholder cleanup', () => {
  const insert = (date, identity, action, time, executed = 0, attempts = 0, status = 'pending') =>
    getDb().prepare(`INSERT OR REPLACE INTO daily_schedule (date, identity_key, action_type, resolved_time,
      executed, last_status, attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(date, identity, action, time, executed, status, attempts);
  const rowsFor = (date, identity) => getDb()
    .prepare('SELECT action_type, resolved_time FROM daily_schedule WHERE date = ? AND identity_key = ? ORDER BY action_type')
    .all(date, identity);

  it('removes unstarted pairs longer than 90 minutes once and keeps everything else', () => {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('legacy_break_placeholders_cleared');
    // An overwritten placeholder from an older version: 100 minutes, never run.
    insert('2026-10-05', 'id-a', 'break_start', '12:00', 0, 0, 'skipped_unknown');
    insert('2026-10-05', 'id-a', 'break_end', '13:40', 0, 0, 'skipped_unknown');
    insert('2026-10-05', 'id-a', 'checkout', '19:30');
    // A real 79 minute plan and a started long pair stay.
    insert('2026-10-05', 'id-b', 'break_start', '12:33');
    insert('2026-10-05', 'id-b', 'break_end', '13:52');
    insert('2026-10-05', 'id-c', 'break_start', '12:00', 1, 1, 'success');
    insert('2026-10-05', 'id-c', 'break_end', '13:40');
    initDatabase();

    expect(rowsFor('2026-10-05', 'id-a')).toEqual([{ action_type: 'checkout', resolved_time: '19:30' }]);
    expect(rowsFor('2026-10-05', 'id-b')).toHaveLength(2);
    expect(rowsFor('2026-10-05', 'id-c')).toHaveLength(2);
    expect(getSetting('legacy_break_placeholders_cleared')).toBe('1');

    // Later long plans under a higher cap are never touched again.
    insert('2026-10-05', 'id-d', 'break_start', '12:00');
    insert('2026-10-05', 'id-d', 'break_end', '13:45');
    initDatabase();
    expect(rowsFor('2026-10-05', 'id-d')).toHaveLength(2);
  });
});
