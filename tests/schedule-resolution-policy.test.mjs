import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initDatabase, getDb, setSetting, updateConfig, getDailySchedule, markDailyScheduleExecuted, updateDailyScheduleStatus } from '../server/db.js';
import { Scheduler, scheduler as sharedScheduler } from '../server/scheduler.js';
import configRouter from '../server/routes/api-config.js';
import { currentAutomationIdentityKey } from '../server/automation/identity.js';
import { todayStringInTz } from '../server/timezone.js';

let scheduler;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
  vi.stubEnv('TZ', 'Asia/Tokyo');
  initDatabase();
  getDb().prepare('DELETE FROM daily_schedule').run();
  setSetting('auto_checkin_enabled', '0');
  for (const action of ['checkin', 'checkout', 'break_start', 'break_end']) updateConfig(action, { enabled: 0 });
  scheduler = new Scheduler();
  scheduler.getTodayCalendarStatus = async () => ({ isNonWorkingDay: false, verificationFailed: false });
});
afterEach(() => { scheduler.stopAll(); sharedScheduler.stopAll(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('jointly resolves break windows without moving a completed start', async () => {
  updateConfig('break_start', { enabled: 1, mode: 'fixed', fixed_time: '12:50' });
  updateConfig('break_end', { enabled: 1, mode: 'random', window_start: '13:50', window_end: '14:00' });
  await scheduler.resolveAndScheduleToday();
  const identity = currentAutomationIdentityKey();
  markDailyScheduleExecuted(todayStringInTz(), 'break_start', 'success', null, identity);
  updateConfig('break_end', { window_start: '13:00', window_end: '13:20' });
  await scheduler.resolveAndScheduleToday();
  const rows = getDailySchedule(todayStringInTz(), identity);
  expect(rows.find(row => row.action_type === 'break_start')).toMatchObject({ resolved_time: '12:50', executed: 1 });
  expect(rows.find(row => row.action_type === 'break_end')).toMatchObject({ last_status: 'paused_configuration', attempts: 0, executed: 0 });
  expect(scheduler.skippedActions.has('break_end')).toBe(true);
});

it('persists a past reconfiguration pause and allows a later corrected time', async () => {
  updateConfig('checkin', { enabled: 1, mode: 'fixed', fixed_time: '09:00' });
  await scheduler.resolveAndScheduleToday(0, true);
  const identity = currentAutomationIdentityKey();
  expect(getDailySchedule(todayStringInTz(), identity)[0]).toMatchObject({ last_status: 'paused_configuration', attempts: 0 });
  await scheduler.resolveAndScheduleToday();
  expect(scheduler.skippedActions.has('checkin')).toBe(true);
  updateConfig('checkin', { fixed_time: '11:00' });
  await scheduler.resolveAndScheduleToday();
  expect(getDailySchedule(todayStringInTz(), identity)[0]).toMatchObject({ resolved_time: '11:00', last_status: 'pending' });
  expect(scheduler.skippedActions.has('checkin')).toBe(false);
});

it('preserves an attempted unknown result when a later break configuration is incompatible', async () => {
  updateConfig('break_start', { enabled: 1, mode: 'fixed', fixed_time: '12:50' });
  updateConfig('break_end', { enabled: 1, mode: 'fixed', fixed_time: '13:50' });
  await scheduler.resolveAndScheduleToday();
  const identity = currentAutomationIdentityKey();
  updateDailyScheduleStatus(todayStringInTz(), 'break_start', 'identity_changed', 'Verify unknown result', true, identity);
  updateConfig('break_end', { fixed_time: '13:20' });
  await scheduler.resolveAndScheduleToday();
  expect(getDailySchedule(todayStringInTz(), identity).find(row => row.action_type === 'break_start'))
    .toMatchObject({ attempts: 1, executed: 0, last_status: 'identity_changed', last_error: 'Verify unknown result' });
  expect(scheduler.skippedActions.has('break_start')).toBe(true);
});

it('isolates a nonexistent DST wall time without failing the entire day', async () => {
  vi.stubEnv('TZ', 'America/New_York');
  vi.setSystemTime(new Date('2026-03-08T06:00:00Z'));
  updateConfig('checkin', { enabled: 1, mode: 'fixed', fixed_time: '02:30' });
  updateConfig('checkout', { enabled: 1, mode: 'fixed', fixed_time: '18:00' });
  await expect(scheduler.resolveAndScheduleToday()).resolves.toBeUndefined();
  expect(scheduler.skippedActions.has('checkin')).toBe(true);
  expect(scheduler.skippedActions.has('checkout')).toBe(false);
  expect(getDailySchedule(todayStringInTz(), currentAutomationIdentityKey()).find(row => row.action_type === 'checkin'))
    .toMatchObject({ last_error: 'SCHEDULE_TIME_NONEXISTENT', last_status: 'paused_configuration', attempts: 0 });
});

it('does not recheck a nonexistent DST checkin on a non-working day', async () => {
  vi.stubEnv('TZ', 'America/New_York');
  vi.setSystemTime(new Date('2026-03-08T06:00:00Z'));
  updateConfig('checkin', { enabled: 1, mode: 'fixed', fixed_time: '02:30' });
  scheduler.getTodayCalendarStatus = async () => ({ isNonWorkingDay: true, verificationFailed: false, reason: 'Holiday' });
  await expect(scheduler.resolveAndScheduleToday()).resolves.toBeUndefined();
  expect(scheduler.timers._nonWorkingRecheck).toBeUndefined();
  expect(getDailySchedule(todayStringInTz(), currentAutomationIdentityKey())[0]).toMatchObject({ last_status: 'paused_configuration' });
});

it('allows disabling an incompatible saved break while refusing to enable the invalid pair', async () => {
  updateConfig('break_start', { enabled: 1, mode: 'fixed', fixed_time: '12:00' });
  updateConfig('break_end', { enabled: 1, mode: 'fixed', fixed_time: '14:00' });
  const handler = configRouter.stack.find(layer => layer.route?.path === '/:actionType' && layer.route.methods.put).route.stack[0].handle;
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const disabled = response();
  await handler({ params: { actionType: 'break_start' }, body: { enabled: false } }, disabled);
  expect(disabled.statusCode).toBe(200);
  expect(disabled.body.enabled).toBe(0);
  const enabled = response();
  await handler({ params: { actionType: 'break_start' }, body: { enabled: true } }, enabled);
  expect(enabled.statusCode).toBe(400);
});
