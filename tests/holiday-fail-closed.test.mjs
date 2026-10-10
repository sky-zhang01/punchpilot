import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { getDb, getSetting, initDatabase, setSetting } from '../server/db.js';
import { fetchNationalHolidays } from '../server/holiday.js';

const CURRENT_YEAR = 2026;
const ORIGINAL_SETTINGS = new Map();

function cacheKey(country, year = CURRENT_YEAR) {
  return `holiday_cache_${country}_${year}`;
}

function expiryKey(country, year = CURRENT_YEAR) {
  return `holiday_cache_expires_${country}_${year}`;
}

const TOUCHED_KEYS = [
  cacheKey('jp'),
  expiryKey('jp'),
  cacheKey('cn'),
  expiryKey('cn'),
  `holiday_cache_cn_workdays_${CURRENT_YEAR}`,
  cacheKey('jp', 2099),
  expiryKey('jp', 2099),
  cacheKey('jp', 2098),
  expiryKey('jp', 2098),
];

function resetCache(country, year = CURRENT_YEAR) {
  setSetting(cacheKey(country, year), '');
  setSetting(expiryKey(country, year), '0');
  if (country === 'cn') {
    setSetting(`holiday_cache_cn_workdays_${year}`, '');
  }
}

function stubJsonResponse(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })));
}

function stubJsonError(error) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => { throw error; },
  })));
}

async function expectUnavailable(country, payload, year = CURRENT_YEAR) {
  resetCache(country, year);
  stubJsonResponse(payload);

  await expect(fetchNationalHolidays(country, year)).rejects.toMatchObject({
    code: 'HOLIDAY_DATA_UNAVAILABLE',
  });
  expect(getSetting(cacheKey(country, year))).toBe('');
  expect(getSetting(expiryKey(country, year))).toBe('0');
}

beforeAll(() => {
  initDatabase();
  for (const key of TOUCHED_KEYS) {
    ORIGINAL_SETTINGS.set(key, getSetting(key));
  }
});

afterAll(() => {
  const deleteSetting = getDb().prepare('DELETE FROM settings WHERE key = ?');
  for (const [key, value] of ORIGINAL_SETTINGS) {
    if (value === null) {
      deleteSetting.run(key);
    } else {
      setSetting(key, value);
    }
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('holiday provider failure policy', () => {
  it('fails closed when the provider fails and no verified cache exists', async () => {
    resetCache('jp', 2099);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('synthetic provider detail'), {
        code: 'ECONNRESET',
      });
    }));

    const error = await fetchNationalHolidays('jp', 2099).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'HOLIDAY_DATA_UNAVAILABLE' });
    expect(error.message).not.toContain('synthetic provider detail');
  });

  it('fails closed when an HTTP 200 body is empty or malformed JSON', async () => {
    resetCache('jp', 2098);
    stubJsonError(new SyntaxError('Unexpected end of JSON input'));

    await expect(fetchNationalHolidays('jp', 2098)).rejects.toMatchObject({
      code: 'HOLIDAY_DATA_UNAVAILABLE',
    });
    expect(getSetting(cacheKey('jp', 2098))).toBe('');
    expect(getSetting(expiryKey('jp', 2098))).toBe('0');
  });

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a schema-drifted holiday value', { '2026-01-01': { name: '元日' } }],
    ['a malformed date', { '2026-02-30': '天皇誕生日' }],
    ['only out-of-year dates', { '2025-01-01': '元日' }],
  ])('fails closed for JP HTTP 200 payload with %s', async (_label, payload) => {
    await expectUnavailable('jp', payload);
  });

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['missing days', { year: CURRENT_YEAR }],
    ['empty days', { year: CURRENT_YEAR, days: [] }],
    ['a mismatched year', {
      year: CURRENT_YEAR - 1,
      days: [{ date: '2025-01-01', name: '元旦', isOffDay: true }],
    }],
    ['a malformed date', {
      year: CURRENT_YEAR,
      days: [{ date: '2026-02-30', name: '春节', isOffDay: true }],
    }],
    ['an out-of-year date', {
      year: CURRENT_YEAR,
      days: [{ date: '2025-12-31', name: '元旦', isOffDay: true }],
    }],
    ['a schema-drifted day', {
      year: CURRENT_YEAR,
      days: [{ date: '2026-01-01', name: '元旦', isOffDay: 'true' }],
    }],
    ['only workday entries', {
      year: CURRENT_YEAR,
      days: [{ date: '2026-01-04', name: '调休', isOffDay: false }],
    }],
  ])('fails closed for CN HTTP 200 payload with %s', async (_label, payload) => {
    await expectUnavailable('cn', payload);
  });

  it('accepts and caches a realistic JP current-year payload', async () => {
    resetCache('jp');
    stubJsonResponse({
      '2025-11-03': '文化の日',
      '2026-01-01': '元日',
      '2026-01-12': '成人の日',
      '2026-02-11': '建国記念の日',
    });

    const holidays = await fetchNationalHolidays('jp', CURRENT_YEAR);

    expect(holidays).toEqual({
      '2026-01-01': '元日',
      '2026-01-12': '成人の日',
      '2026-02-11': '建国記念の日',
    });
    expect(JSON.parse(getSetting(cacheKey('jp')))).toEqual(holidays);
    expect(Number(getSetting(expiryKey('jp')))).toBeGreaterThan(Date.now());
  });

  it('accepts and caches a realistic CN current-year payload', async () => {
    resetCache('cn');
    stubJsonResponse({
      $schema: 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/schema.json',
      year: CURRENT_YEAR,
      papers: ['https://www.gov.cn/zhengce/example'],
      days: [
        { name: '元旦', date: '2026-01-01', isOffDay: true },
        { name: '元旦', date: '2026-01-02', isOffDay: true },
        { name: '元旦', date: '2026-01-04', isOffDay: false },
      ],
    });

    const holidays = await fetchNationalHolidays('cn', CURRENT_YEAR);

    expect(holidays).toEqual({
      '2026-01-01': '元旦',
      '2026-01-02': '元旦',
    });
    expect(JSON.parse(getSetting(cacheKey('cn')))).toEqual(holidays);
    expect(JSON.parse(getSetting('holiday_cache_cn_workdays_2026'))).toEqual({
      '2026-01-04': '元旦',
    });
    expect(Number(getSetting(expiryKey('cn')))).toBeGreaterThan(Date.now());
  });

  it('uses a valid prior cache when a new payload fails validation', async () => {
    const cached = { '2026-01-01': '元日' };
    resetCache('jp');
    setSetting(cacheKey('jp'), JSON.stringify(cached));
    stubJsonResponse({});

    await expect(fetchNationalHolidays('jp', CURRENT_YEAR)).resolves.toEqual(cached);
    expect(getSetting(cacheKey('jp'))).toBe(JSON.stringify(cached));
  });

  it('rejects an invalid prior cache when a new payload fails validation', async () => {
    resetCache('jp');
    setSetting(cacheKey('jp'), '{}');
    stubJsonResponse({});

    await expect(fetchNationalHolidays('jp', CURRENT_YEAR)).rejects.toMatchObject({
      code: 'HOLIDAY_DATA_UNAVAILABLE',
    });
  });

  it('does not trust an unexpired cache with invalid data', async () => {
    resetCache('jp');
    setSetting(cacheKey('jp'), '{}');
    setSetting(expiryKey('jp'), String(Date.now() + 60_000));
    stubJsonResponse({});

    await expect(fetchNationalHolidays('jp', CURRENT_YEAR)).rejects.toMatchObject({
      code: 'HOLIDAY_DATA_UNAVAILABLE',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
