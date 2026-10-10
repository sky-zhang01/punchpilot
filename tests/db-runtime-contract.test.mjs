import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, getDb, getSetting, setSetting, getConfigByAction, updateConfig, setDailySchedule, getDailySchedule, insertLog, currentExecutionLogIdentityKey, getLogsByDate, getLogsPaginated, getCalendarData } from '../server/db.js';

beforeEach(() => { initDatabase(); getDb().prepare('DELETE FROM daily_schedule').run(); getDb().prepare('DELETE FROM execution_log').run(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('database business contracts', () => {
  it('never overwrites saved holiday and API-only checkout settings on repeated startup', () => {
    setSetting('holiday_skip_countries', 'jp,cn');
    setSetting('freee_configured', '0');
    updateConfig('checkout', { mode: 'fixed', fixed_time: '18:12' });
    initDatabase(); initDatabase();
    expect(getSetting('holiday_skip_countries')).toBe('jp,cn');
    expect(getConfigByAction('checkout')).toMatchObject({ mode: 'fixed', fixed_time: '18:12' });
  });

  it('invalidates only current/future, unattempted plans when effective time rules change', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T01:00:00Z')); vi.stubEnv('TZ', 'Asia/Tokyo');
    updateConfig('checkin', { mode: 'fixed', fixed_time: '10:00' });
    for (const date of ['2026-10-03', '2026-10-04', '2026-10-05']) setDailySchedule(date, 'checkin', '10:00', 'account-a');
    setDailySchedule('2026-10-04', 'checkout', '18:00', 'account-a');
    setDailySchedule('2026-10-04', 'checkin', '10:00', 'account-b');
    getDb().prepare("UPDATE daily_schedule SET attempts=1,last_status='unknown' WHERE identity_key='account-b'").run();
    updateConfig('checkin', { enabled: 0, window_end: '10:10', fixed_time: '10:00' });
    expect(getDailySchedule('2026-10-04', 'account-a')).toHaveLength(2);
    updateConfig('checkin', { fixed_time: '11:00' });
    expect(getDailySchedule('2026-10-03', 'account-a')).toHaveLength(1);
    expect(getDailySchedule('2026-10-04', 'account-a').map(x => x.action_type)).toEqual(['checkout']);
    expect(getDailySchedule('2026-10-05', 'account-a')).toEqual([]);
    expect(getDailySchedule('2026-10-04', 'account-b')[0]).toMatchObject({ resolved_time: '10:00', attempts: 1, last_status: 'unknown' });
  });

  it('invalidates the coupled pending break without modifying an executed anchor', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T01:00:00Z')); vi.stubEnv('TZ', 'Asia/Tokyo');
    updateConfig('break_start', { mode: 'fixed', fixed_time: '12:00' });
    setDailySchedule('2026-10-04', 'break_start', '12:00', 'account-a');
    setDailySchedule('2026-10-04', 'break_end', '13:00', 'account-a');
    getDb().prepare("UPDATE daily_schedule SET executed=1,last_status='executed' WHERE action_type='break_start'").run();
    updateConfig('break_start', { fixed_time: '12:10' });
    expect(getDailySchedule('2026-10-04', 'account-a')).toMatchObject([{ action_type: 'break_start', resolved_time: '12:00', executed: 1 }]);
  });

  it('allows effective configuration repairs to clear only unattempted current/future pauses', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T01:00:00Z')); vi.stubEnv('TZ', 'Asia/Tokyo');
    updateConfig('checkout', { mode: 'fixed', fixed_time: '09:00' });
    for (const date of ['2026-10-03', '2026-10-04', '2026-10-05']) setDailySchedule(date, 'checkout', '09:00', 'account-a');
    setDailySchedule('2026-10-04', 'checkout', '09:00', 'account-b');
    getDb().prepare("UPDATE daily_schedule SET last_status='paused_configuration',last_error='SCHEDULE_TIME_PASSED'").run();
    getDb().prepare("UPDATE daily_schedule SET attempts=1 WHERE identity_key='account-b'").run();
    updateConfig('checkout', { enabled: 0, window_end: '18:30' });
    expect(getDailySchedule('2026-10-04', 'account-a')[0]).toMatchObject({ executed: 0, attempts: 0, last_status: 'paused_configuration' });
    updateConfig('checkout', { fixed_time: '19:00' });
    expect(getDailySchedule('2026-10-04', 'account-a')).toEqual([]);
    expect(getDailySchedule('2026-10-05', 'account-a')).toEqual([]);
    expect(getDailySchedule('2026-10-03', 'account-a')[0].last_status).toBe('paused_configuration');
    expect(getDailySchedule('2026-10-04', 'account-b')[0]).toMatchObject({ attempts: 1, last_status: 'paused_configuration' });
  });

  it('orders appended logs and pages consistently across historical local and UTC timestamps', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T15:01:00Z')); vi.stubEnv('TZ', 'Asia/Tokyo');
    const identity = currentExecutionLogIdentityKey();
    const historical = getDb().prepare("INSERT INTO execution_log (action_type,status,executed_at,identity_key) VALUES ('checkin','success','2026-10-04 00:00:00',?)").run(identity);
    const first = insertLog({ action_type: 'break_start', status: 'success' });
    const second = insertLog({ action_type: 'break_end', status: 'success' });
    const expectedIds = [second.lastInsertRowid, first.lastInsertRowid, historical.lastInsertRowid];
    const storedRows = getDb().prepare('SELECT * FROM execution_log ORDER BY id').all();

    expect(getLogsByDate('2026-10-04', identity).map(row => row.id)).toEqual(expectedIds);
    const pages = expectedIds.map((_, index) => getLogsPaginated({
      identity_key: identity, date_from: '2026-10-03', date_to: '2026-10-04', page: index + 1, limit: 1,
    }));
    expect(pages.flatMap(page => page.rows.map(row => row.id))).toEqual(expectedIds);
    expect(pages.map(page => [page.total, page.totalPages])).toEqual([[3, 3], [3, 3], [3, 3]]);
    expect(getLogsPaginated({ identity_key: identity }).rows.map(row => row.id)).toEqual(expectedIds);
    expect(getDb().prepare('SELECT * FROM execution_log ORDER BY id').all()).toEqual(storedRows);
  });

  it('stores UTC instants and a configured business date while preserving historical labels', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T15:30:00Z')); vi.stubEnv('TZ', 'Asia/Tokyo');
    const identity = currentExecutionLogIdentityKey();
    insertLog({ action_type: 'checkin', status: 'success' });
    getDb().prepare("INSERT INTO execution_log (action_type,status,executed_at,identity_key) VALUES ('checkout','success','2026-10-03 23:00:00',?)").run(identity);
    expect(getLogsByDate('2026-10-04', identity)).toMatchObject([{ executed_at: '2026-10-03T15:30:00.000Z', business_date: '2026-10-04' }]);
    expect(getLogsByDate('2026-10-03', identity)).toHaveLength(1);
    expect(getLogsPaginated({ date: '2026-10-04', identity_key: identity }).total).toBe(1);
    expect(getCalendarData(2026, 10, identity).map(x => x.date)).toEqual(['2026-10-03', '2026-10-04']);
  });
});
