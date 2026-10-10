import { describe, expect, it, vi } from 'vitest';
import {
  isWebWorkRecordResponse,
  normalizeWebWorkRecordPayload,
  readWebEmployeeIdentity,
  readWebWorkRecord,
  rereadWebWorkRecord,
  WEB_WORK_RECORD_ERROR_CODES,
} from '../server/automation/web-work-record.js';
import { getWorkRecordNonWorkingDayStatus } from '../server/work-record-status.js';

function privateRecord(overrides = {}) {
  return {
    date: '2026-05-25',
    absence_f: false,
    paid_holiday: 0,
    paid_holidays: [],
    special_holiday: 0,
    normal_work_mins: 480,
    normal_work_mins_by_paid_holiday: 0,
    hourly_paid_holiday_mins: 0,
    day_pattern: 'normal_day',
    schedule_pattern: null,
    clock_in_at: null,
    clock_out_at: null,
    break_records: [],
    employee_work_record_segments: [],
    ...overrides,
  };
}

describe('freee Web work-record normalization', () => {
  it('normalizes the observed private full-day paid-leave schema', () => {
    const record = normalizeWebWorkRecordPayload({
      work_records: [privateRecord({
        normal_work_mins: 0,
        paid_holiday: 1,
        paid_holidays: [{ type: 'paid_holiday_full', days: 0, mins: 0 }],
      })],
    }, '2026-05-25');

    expect(record).toMatchObject({
      date: '2026-05-25',
      paid_holiday: 1,
      paid_holidays: [{ type: 'full', days: 0, mins: 0 }],
      is_absence: false,
    });
    expect(getWorkRecordNonWorkingDayStatus(record)).toMatchObject({
      isNonWorkingDay: true,
      code: 'paid_holiday',
    });
  });

  it('normalizes absence and schedule-pattern fields without retaining the payload', () => {
    const record = normalizeWebWorkRecordPayload({
      work_records: [privateRecord({
        absence_f: true,
        schedule_pattern: 'substitute_holiday',
        private_profile: { should_not_escape: true },
      })],
    }, '2026-05-25');

    expect(record.is_absence).toBe(true);
    expect(record.schedule_pattern).toBe('substitute_holiday');
    expect(record).not.toHaveProperty('private_profile');
  });

  it('fails closed when the date or leave fields cannot be confirmed', () => {
    expect(() => normalizeWebWorkRecordPayload({
      work_records: [privateRecord({ date: '2026-05-24' })],
    }, '2026-05-25')).toThrowError(expect.objectContaining({
      code: WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
    }));

    const missingLeaveSchema = privateRecord();
    delete missingLeaveSchema.paid_holidays;
    expect(() => normalizeWebWorkRecordPayload({
      work_records: [missingLeaveSchema],
    }, '2026-05-25')).toThrowError(expect.objectContaining({
      code: WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED,
    }));
  });

  it('fails closed when leave-relevant values drift from the observed schema', () => {
    for (const overrides of [
      { paid_holiday: '1' },
      { paid_holidays: [{ type: 'paid_holiday_full', days: '0', mins: 0 }] },
      { paid_holidays: [{ type: 'future_private_type', days: 0, mins: 0 }] },
      { absence_f: 'false' },
      { schedule_pattern: { type: 'substitute_holiday' } },
    ]) {
      expect(() => normalizeWebWorkRecordPayload({
        work_records: [privateRecord(overrides)],
      }, '2026-05-25')).toThrowError(expect.objectContaining({
        code: WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED,
      }));
    }
  });

  it('accepts only the exact same-origin GET work-record response family', () => {
    const response = (url, method = 'GET') => ({
      url: () => url,
      request: () => ({ method: () => method }),
    });

    expect(isWebWorkRecordResponse(response(
      'https://p.secure.freee.co.jp/api/p/employees/work_records/123/2026/6',
    ))).toBe(true);
    expect(isWebWorkRecordResponse(response(
      'https://example.invalid/api/p/employees/work_records/123/2026/6',
    ))).toBe(false);
    expect(isWebWorkRecordResponse(response(
      'https://p.secure.freee.co.jp/api/p/employees/work_records/123/2026/6',
      'POST',
    ))).toBe(false);
    expect(isWebWorkRecordResponse(response(
      'https://p.secure.freee.co.jp/api/p/employees/work_records/not-an-id/2026/6',
    ))).toBe(false);
    expect(isWebWorkRecordResponse(response(
      'https://p.secure.freee.co.jp/api/p/employees/work_records/123/2026/6/extra',
    ))).toBe(false);
  });

  it('returns a stable guard error when navigation and response observation fail', async () => {
    const locator = {
      filter() { return this; },
      first() { return this; },
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(false),
    };
    const page = {
      waitForResponse: vi.fn().mockRejectedValue(new Error('synthetic response failure')),
      locator: vi.fn(() => locator),
      goto: vi.fn().mockRejectedValue(new Error('synthetic navigation failure')),
    };

    await expect(readWebWorkRecord(page, '2026-05-25')).rejects.toMatchObject({
      code: WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
    });
  });

  it('derives the active Web employee only from a successful exact-origin work-record response', async () => {
    const response = {
      url: () => 'https://p.secure.freee.co.jp/api/p/employees/work_records/98765/2026/5',
      request: () => ({ method: () => 'GET' }),
      ok: () => true,
    };
    const locator = {
      filter() { return this; },
      first() { return this; },
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(false),
    };
    const page = {
      waitForResponse: vi.fn().mockResolvedValue(response),
      locator: vi.fn(() => locator),
      goto: vi.fn().mockResolvedValue(undefined),
    };

    await expect(readWebEmployeeIdentity(page)).resolves.toEqual({ employeeId: '98765' });
  });

  it('fails closed when the Web identity response is unsuccessful', async () => {
    const response = {
      url: () => 'https://p.secure.freee.co.jp/api/p/employees/work_records/98765/2026/5',
      request: () => ({ method: () => 'GET' }),
      ok: () => false,
    };
    const locator = {
      filter() { return this; },
      first() { return this; },
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(false),
    };
    const page = {
      waitForResponse: vi.fn().mockResolvedValue(response),
      locator: vi.fn(() => locator),
      goto: vi.fn().mockResolvedValue(undefined),
    };

    await expect(readWebEmployeeIdentity(page)).rejects.toMatchObject({
      code: WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
    });
  });

  it('rechecks the exact employee month through the browser request context', async () => {
    const payload = Buffer.from(JSON.stringify({
      work_records: [privateRecord()],
    }));
    const response = {
      url: () => 'https://p.secure.freee.co.jp/api/p/employees/work_records/98765/2026/5',
      ok: () => true,
      headers: () => ({ 'content-length': String(payload.length) }),
      body: vi.fn().mockResolvedValue(payload),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const get = vi.fn().mockResolvedValue(response);
    const page = { context: () => ({ request: { get } }) };

    await expect(
      rereadWebWorkRecord(page, '2026-05-25', '98765'),
    ).resolves.toMatchObject({ date: '2026-05-25', is_absence: false });
    expect(get).toHaveBeenCalledWith(
      'https://p.secure.freee.co.jp/api/p/employees/work_records/98765/2026/5',
      expect.objectContaining({ failOnStatusCode: false, timeout: 15_000 }),
    );
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it('rejects a recheck redirected away from the exact work-record endpoint', async () => {
    const response = {
      url: () => 'https://accounts.secure.freee.co.jp/login',
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      context: () => ({ request: { get: vi.fn().mockResolvedValue(response) } }),
    };

    await expect(
      rereadWebWorkRecord(page, '2026-05-25', '98765'),
    ).rejects.toMatchObject({ code: WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED });
    expect(response.dispose).toHaveBeenCalledOnce();
  });
});
