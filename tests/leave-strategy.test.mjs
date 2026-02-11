/**
 * Leave Request Strategy & Cache Tests
 *
 * Covers:
 * - UT-01~06: canUseS1Direct for all leave types
 * - UT-07: getLeaveStrategyCacheKey format
 * - UT-08~09: cleanExpiredLeaveStrategyCache
 * - UT-16~17: LeaveRequestModal canSubmit logic (time validation)
 * - IT-11: Cross-month cache isolation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// --- canUseS1Direct logic (extracted from api-attendance.js) ---

const LEAVE_DIRECT_WRITE_TYPES = ['PaidHoliday', 'SpecialHoliday', 'Absence', 'OvertimeWork'];

function canUseS1Direct(type, holidayType) {
  if (type === 'PaidHoliday') {
    return (holidayType || 'full') === 'full';
  }
  return LEAVE_DIRECT_WRITE_TYPES.includes(type);
}

function getLeaveStrategyCacheKey(month, type) {
  return `leave_strategy_${month}_${type}`;
}

describe('canUseS1Direct', () => {
  it('UT-01: PaidHoliday full → true', () => {
    expect(canUseS1Direct('PaidHoliday', 'full')).toBe(true);
  });

  it('UT-01: PaidHoliday undefined (defaults to full) → true', () => {
    expect(canUseS1Direct('PaidHoliday', undefined)).toBe(true);
  });

  it('UT-02: PaidHoliday half → false', () => {
    expect(canUseS1Direct('PaidHoliday', 'half')).toBe(false);
  });

  it('UT-02: PaidHoliday morning_off → false', () => {
    expect(canUseS1Direct('PaidHoliday', 'morning_off')).toBe(false);
  });

  it('UT-02: PaidHoliday afternoon_off → false', () => {
    expect(canUseS1Direct('PaidHoliday', 'afternoon_off')).toBe(false);
  });

  it('UT-03: PaidHoliday hour → false', () => {
    expect(canUseS1Direct('PaidHoliday', 'hour')).toBe(false);
  });

  it('UT-04: OvertimeWork → true', () => {
    expect(canUseS1Direct('OvertimeWork')).toBe(true);
  });

  it('UT-05: SpecialHoliday → true', () => {
    expect(canUseS1Direct('SpecialHoliday')).toBe(true);
  });

  it('UT-06: Absence → true', () => {
    expect(canUseS1Direct('Absence')).toBe(true);
  });

  it('unknown type → false', () => {
    expect(canUseS1Direct('SomeInvalidType')).toBe(false);
  });
});

describe('getLeaveStrategyCacheKey', () => {
  it('UT-07: formats correctly', () => {
    expect(getLeaveStrategyCacheKey('2026-02', 'PaidHoliday'))
      .toBe('leave_strategy_2026-02_PaidHoliday');
  });

  it('UT-07: OvertimeWork format', () => {
    expect(getLeaveStrategyCacheKey('2026-03', 'OvertimeWork'))
      .toBe('leave_strategy_2026-03_OvertimeWork');
  });
});

describe('cleanExpiredLeaveStrategyCache', () => {
  let db, getSetting, setSetting;

  // Reproduce the function from db.js
  function cleanExpiredLeaveStrategyCache(currentMonth) {
    const prefix = 'leave_strategy_';
    const rows = db.prepare('SELECT key FROM settings WHERE key LIKE ?').all(`${prefix}%`);
    let deleted = 0;
    for (const row of rows) {
      const month = row.key.substring(prefix.length, prefix.length + 7);
      if (month < currentMonth) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(row.key);
        deleted++;
      }
    }
    return deleted;
  }

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-leave-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

    getSetting = (key) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    };
    setSetting = (key, value) => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    };
  });

  afterAll(() => {
    db.close();
  });

  it('UT-08: deletes old month cache, keeps current month', () => {
    // Set up: Jan cache (old), Feb cache (current)
    setSetting('leave_strategy_2026-01_PaidHoliday', 'direct');
    setSetting('leave_strategy_2026-01_OvertimeWork', 'approval');
    setSetting('leave_strategy_2026-02_PaidHoliday', 'direct');
    setSetting('leave_strategy_2026-02_SpecialHoliday', 'web');

    const deleted = cleanExpiredLeaveStrategyCache('2026-02');
    expect(deleted).toBe(2);

    // Old month entries deleted
    expect(getSetting('leave_strategy_2026-01_PaidHoliday')).toBeNull();
    expect(getSetting('leave_strategy_2026-01_OvertimeWork')).toBeNull();

    // Current month entries preserved
    expect(getSetting('leave_strategy_2026-02_PaidHoliday')).toBe('direct');
    expect(getSetting('leave_strategy_2026-02_SpecialHoliday')).toBe('web');
  });

  it('UT-09: returns 0 when no old cache exists', () => {
    // Only current month entries exist
    const deleted = cleanExpiredLeaveStrategyCache('2026-02');
    expect(deleted).toBe(0);
  });

  it('IT-11: cross-month isolation - different months are independent', () => {
    // Add March cache
    setSetting('leave_strategy_2026-03_PaidHoliday', 'approval');

    // Clean with current=March: Feb should be deleted, March kept
    const deleted = cleanExpiredLeaveStrategyCache('2026-03');
    expect(deleted).toBe(2); // Feb entries
    expect(getSetting('leave_strategy_2026-02_PaidHoliday')).toBeNull();
    expect(getSetting('leave_strategy_2026-03_PaidHoliday')).toBe('approval');
  });
});

describe('LeaveRequestModal canSubmit validation logic', () => {
  // Extract the canSubmit logic from the React component (updated: half also needs times)
  function canSubmit(date, type, holidayType, startTime, endTime) {
    const needsTimeInputs = type === 'OvertimeWork' ||
      (type === 'PaidHoliday' && (holidayType === 'half' || holidayType === 'hour'));
    return !!(date && type && (!needsTimeInputs || (startTime && endTime)));
  }

  it('UT-16: OvertimeWork without times → false', () => {
    expect(canSubmit('2026-02-10', 'OvertimeWork', undefined, null, null)).toBe(false);
  });

  it('UT-16: OvertimeWork with both times → true', () => {
    expect(canSubmit('2026-02-10', 'OvertimeWork', undefined, '18:00', '21:00')).toBe(true);
  });

  it('UT-16: OvertimeWork with only start time → false', () => {
    expect(canSubmit('2026-02-10', 'OvertimeWork', undefined, '18:00', null)).toBe(false);
  });

  it('UT-17: PaidHoliday hour without times → false', () => {
    expect(canSubmit('2026-02-10', 'PaidHoliday', 'hour', null, null)).toBe(false);
  });

  it('UT-17: PaidHoliday hour with both times → true', () => {
    expect(canSubmit('2026-02-10', 'PaidHoliday', 'hour', '10:00', '12:00')).toBe(true);
  });

  it('PaidHoliday full without times → true (times not needed)', () => {
    expect(canSubmit('2026-02-10', 'PaidHoliday', 'full', null, null)).toBe(true);
  });

  it('PaidHoliday half without times → false (times required for half)', () => {
    expect(canSubmit('2026-02-10', 'PaidHoliday', 'half', null, null)).toBe(false);
  });

  it('PaidHoliday half with times → true', () => {
    expect(canSubmit('2026-02-10', 'PaidHoliday', 'half', '09:00', '13:00')).toBe(true);
  });

  it('SpecialHoliday without times → true', () => {
    expect(canSubmit('2026-02-10', 'SpecialHoliday', undefined, null, null)).toBe(true);
  });

  it('no date → false', () => {
    expect(canSubmit(null, 'PaidHoliday', 'full', null, null)).toBe(false);
  });

  it('no type → false', () => {
    expect(canSubmit('2026-02-10', '', 'full', null, null)).toBe(false);
  });
});

describe('Strategy cache key isolation', () => {
  let db;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cache-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  });

  afterAll(() => {
    db.close();
  });

  it('different types in same month have separate cache entries', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'leave_strategy_2026-02_PaidHoliday', 'direct'
    );
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'leave_strategy_2026-02_OvertimeWork', 'approval'
    );

    const ph = db.prepare('SELECT value FROM settings WHERE key = ?').get('leave_strategy_2026-02_PaidHoliday');
    const ot = db.prepare('SELECT value FROM settings WHERE key = ?').get('leave_strategy_2026-02_OvertimeWork');

    expect(ph.value).toBe('direct');
    expect(ot.value).toBe('approval');
  });

  it('same type in different months have separate cache entries', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'leave_strategy_2026-02_PaidHoliday', 'direct'
    );
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'leave_strategy_2026-03_PaidHoliday', 'web'
    );

    const feb = db.prepare('SELECT value FROM settings WHERE key = ?').get('leave_strategy_2026-02_PaidHoliday');
    const mar = db.prepare('SELECT value FROM settings WHERE key = ?').get('leave_strategy_2026-03_PaidHoliday');

    expect(feb.value).toBe('direct');
    expect(mar.value).toBe('web');
  });
});
