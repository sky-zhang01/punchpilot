import { getSetting, setSetting, getCustomHolidays } from './db.js';
import { todayStringInTz, currentDayInTz } from './timezone.js';
import { safeErrorMetadata } from './logger.js';

// Holiday API endpoints by country
// JP: single file with all years
// CN: per-year file from NateScarlet/holiday-cn
const JP_API_URL = 'https://holidays-jp.github.io/api/v1/date.json';
const CN_API_URL = (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOLIDAY_FETCH_TIMEOUT_MS = 10_000;
const HOLIDAY_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function fetchHolidayResource(url, options = {}) {
  if (
    options.signal ||
    typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function'
  ) {
    return fetch(url, options);
  }
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(HOLIDAY_FETCH_TIMEOUT_MS),
  });
}

function invalidHolidayData(reason) {
  const error = new Error(`Invalid holiday data: ${reason}`);
  error.code = 'HOLIDAY_PAYLOAD_INVALID';
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRequestedYear(year) {
  const normalized = Number(year);
  if (!Number.isInteger(normalized) || normalized < 1000 || normalized > 9999) {
    throw invalidHolidayData('requested year is invalid');
  }
  return normalized;
}

function validateHolidayDate(date, expectedYear = null) {
  if (typeof date !== 'string') throw invalidHolidayData('date must be a string');
  const match = HOLIDAY_DATE_PATTERN.exec(date);
  if (!match) throw invalidHolidayData('date must use YYYY-MM-DD');

  const dateYear = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(dateYear, month - 1, day));
  if (
    parsed.getUTCFullYear() !== dateYear ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw invalidHolidayData('date is not a real calendar date');
  }
  if (expectedYear !== null && dateYear !== expectedYear) {
    throw invalidHolidayData('date does not match requested year');
  }
  return dateYear;
}

function validateHolidayName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw invalidHolidayData('holiday name must be a non-empty string');
  }
}

function validateHolidayMap(value, year, { allowEmpty = false } = {}) {
  if (!isPlainObject(value)) throw invalidHolidayData('holiday map must be an object');
  const requestedYear = normalizeRequestedYear(year);
  const entries = Object.entries(value);
  if (!allowEmpty && entries.length === 0) {
    throw invalidHolidayData('requested year contains no holidays');
  }

  const validatedEntries = [];
  for (const [date, name] of entries) {
    validateHolidayDate(date, requestedYear);
    validateHolidayName(name);
    validatedEntries.push([date, name]);
  }
  return Object.fromEntries(validatedEntries);
}

function readValidHolidayCache(cacheKey, year) {
  const cached = getSetting(cacheKey);
  if (!cached) return null;
  try {
    return validateHolidayMap(JSON.parse(cached), year);
  } catch {
    return null;
  }
}

function validateJpHolidayPayload(raw, year) {
  if (!isPlainObject(raw)) throw invalidHolidayData('JP payload must be an object');
  const requestedYear = normalizeRequestedYear(year);
  const entries = Object.entries(raw);
  if (entries.length === 0) throw invalidHolidayData('JP payload is empty');

  const requestedYearEntries = [];
  for (const [date, name] of entries) {
    const dateYear = validateHolidayDate(date);
    validateHolidayName(name);
    if (dateYear === requestedYear) requestedYearEntries.push([date, name]);
  }
  return validateHolidayMap(Object.fromEntries(requestedYearEntries), requestedYear);
}

function validateCnHolidayPayload(raw, year) {
  if (!isPlainObject(raw)) throw invalidHolidayData('CN payload must be an object');
  const requestedYear = normalizeRequestedYear(year);
  if (!Number.isInteger(raw.year) || raw.year !== requestedYear) {
    throw invalidHolidayData('CN payload year does not match requested year');
  }
  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    throw invalidHolidayData('CN payload days must be a non-empty array');
  }

  const holidayEntries = [];
  const workdayEntries = [];
  const seenDates = new Set();
  for (const day of raw.days) {
    if (!isPlainObject(day)) throw invalidHolidayData('CN day must be an object');
    validateHolidayDate(day.date, requestedYear);
    validateHolidayName(day.name);
    if (typeof day.isOffDay !== 'boolean') {
      throw invalidHolidayData('CN isOffDay must be a boolean');
    }
    if (seenDates.has(day.date)) throw invalidHolidayData('CN payload contains duplicate dates');
    seenDates.add(day.date);
    if (day.isOffDay) {
      holidayEntries.push([day.date, day.name]);
    } else {
      workdayEntries.push([day.date, day.name]);
    }
  }

  return {
    data: validateHolidayMap(Object.fromEntries(holidayEntries), requestedYear),
    workdays: validateHolidayMap(
      Object.fromEntries(workdayEntries),
      requestedYear,
      { allowEmpty: true },
    ),
  };
}

/**
 * Compute smart TTL based on country and year relative to current date.
 * JP holidays are stable once published; CN holidays change more often
 * (especially late in the year when next year's schedule is announced).
 */
export function computeTtlMs(country, year) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12

  if (country === 'jp') {
    if (year <= currentYear) return 30 * DAY_MS;
    // Next year
    if (month >= 10) return 7 * DAY_MS;   // Oct-Dec: check weekly
    return 60 * DAY_MS;                    // Jan-Sep: check infrequently
  }
  // CN
  if (year <= currentYear) return 14 * DAY_MS;
  // Next year
  if (month >= 10) return 3 * DAY_MS;     // Oct-Dec: check frequently
  return 30 * DAY_MS;                      // Jan-Sep: monthly
}

/**
 * Fetch national holidays for a country+year, with smart TTL caching.
 * Returns: { "YYYY-MM-DD": "Holiday Name", ... }
 */
export async function fetchNationalHolidays(country = 'jp', year = null) {
  // Resolve year for cache key
  const resolvedYear = year || new Date().getFullYear();
  const cacheKey = `holiday_cache_${country}_${resolvedYear}`;
  const expiryKey = `holiday_cache_expires_${country}_${resolvedYear}`;
  const expiresAt = parseInt(getSetting(expiryKey) || '0', 10);

  // Return cached data if still valid
  if (Date.now() < expiresAt) {
    const cached = readValidHolidayCache(cacheKey, resolvedYear);
    if (cached) return cached;
  }

  try {
    if (country === 'jp') {
      return await fetchJpHolidays(resolvedYear, cacheKey, expiryKey, country);
    } else if (country === 'cn') {
      return await fetchCnHolidays(resolvedYear, cacheKey, expiryKey, country);
    }
    return {};
  } catch (error) {
    console.error(
      '[Holiday] Failed to fetch holidays; using cache',
      {
        country,
        year: resolvedYear,
        error: safeErrorMetadata(error),
      },
    );
    const cached = readValidHolidayCache(cacheKey, resolvedYear);
    if (cached) return cached;
    const unavailable = new Error('Holiday data could not be verified and no cache is available.');
    unavailable.code = 'HOLIDAY_DATA_UNAVAILABLE';
    unavailable.cause = error;
    throw unavailable;
  }
}

/**
 * Fetch Japanese holidays: { "YYYY-MM-DD": "名前", ... }
 * JP API returns ALL years in a single file, we filter by year.
 */
async function fetchJpHolidays(year, cacheKey, expiryKey, country) {
  const response = await fetchHolidayResource(JP_API_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const allData = await response.json();
  const data = validateJpHolidayPayload(allData, year);

  const ttlMs = computeTtlMs(country, year);
  setSetting(cacheKey, JSON.stringify(data));
  setSetting(expiryKey, String(Date.now() + ttlMs));
  console.log(`[Holiday] Fetched ${Object.keys(data).length} JP national holidays for ${year} (TTL: ${Math.round(ttlMs / DAY_MS)}d)`);
  return data;
}

/**
 * Fetch Chinese holidays from NateScarlet/holiday-cn (per-year JSON files)
 * Source format: { year: 2025, days: [{ date: "YYYY-MM-DD", name: "...", isOffDay: true/false }, ...] }
 * We convert to: { "YYYY-MM-DD": "名前", ... } (same as JP format, only off-days)
 * Also caches 调休 workdays (isOffDay=false) separately for weekend override logic.
 */
async function fetchCnHolidays(year, cacheKey, expiryKey, country) {
  const url = CN_API_URL(year);
  const response = await fetchHolidayResource(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.json();
  const { data, workdays } = validateCnHolidayPayload(raw, year);

  const ttlMs = computeTtlMs(country, year);
  setSetting(cacheKey, JSON.stringify(data));
  // Cache workdays separately
  const workdayCacheKey = `holiday_cache_cn_workdays_${year}`;
  setSetting(workdayCacheKey, JSON.stringify(workdays));
  setSetting(expiryKey, String(Date.now() + ttlMs));
  console.log(`[Holiday] Fetched ${Object.keys(data).length} CN holidays + ${Object.keys(workdays).length} 调休 workdays for ${year} (TTL: ${Math.round(ttlMs / DAY_MS)}d)`);
  return data;
}

/**
 * Get cached CN 调休 workdays for a given year.
 * Returns: { "YYYY-MM-DD": "Name", ... } — dates that are normally weekends but designated as workdays.
 */
export function getCnWorkdays(year) {
  const cacheKey = `holiday_cache_cn_workdays_${year}`;
  const cached = getSetting(cacheKey);
  if (cached) {
    try {
      return validateHolidayMap(JSON.parse(cached), year, { allowEmpty: true });
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Get today's date string in YYYY-MM-DD format (configured timezone)
 */
export function getTodayString() {
  return todayStringInTz();
}

/**
 * Check if a date is a holiday or weekend.
 * Uses holiday_skip_countries setting to determine which national holidays to check.
 * Handles CN 调休 (tiaoxiu): weekends designated as workdays are NOT skipped.
 */
export async function isHolidayOrWeekend(dateStr) {
  let day;
  if (dateStr) {
    const checkDate = new Date(dateStr + 'T00:00:00');
    day = checkDate.getDay();
  } else {
    day = currentDayInTz();
  }

  const ds = dateStr || getTodayString();
  const year = parseInt(ds.substring(0, 4), 10);
  const isWeekend = (day === 0 || day === 6);

  const skipCountries = (getSetting('holiday_skip_countries') || 'jp').split(',').map(c => c.trim());

  // If it's a weekend, check if CN 调休 workday overrides it
  if (isWeekend) {
    if (skipCountries.includes('cn')) {
      // Ensure CN data is fetched (populates workday cache as side effect)
      await fetchNationalHolidays('cn', year);
      const cnWorkdays = getCnWorkdays(year);
      if (cnWorkdays[ds]) {
        // This weekend day is a designated workday (调休) — do NOT skip
        return false;
      }
    }
    // Normal weekend — skip
    return true;
  }

  // Weekday: check national holidays for configured skip countries
  for (const country of skipCountries) {
    const nationals = await fetchNationalHolidays(country, year);
    if (nationals[ds]) return true;
  }

  // Custom holiday
  const customs = getCustomHolidays();
  if (customs.some((h) => h.date === ds)) return true;

  // Proactive next-year prefetch during Oct-Dec
  const currentYear = new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  if (month >= 10) {
    const nextYear = currentYear + 1;
    for (const country of skipCountries) {
      fetchNationalHolidays(country, nextYear).catch(() => {});
    }
  }

  return false;
}

/**
 * Get holidays for a specific month (for calendar view)
 * Returns: { national: [{date, name}], custom: [{date, description, id}] }
 */
export async function getHolidaysForMonth(year, month, country = 'jp') {
  const nationals = await fetchNationalHolidays(country, year);
  const customs = getCustomHolidays();
  const prefix = `${year}-${String(month).padStart(2, '0')}`;

  const national = [];
  for (const [date, name] of Object.entries(nationals)) {
    if (date.startsWith(prefix)) {
      national.push({ date, name });
    }
  }

  const custom = [];
  for (const h of customs) {
    if (h.date.startsWith(prefix)) {
      custom.push({ date: h.date, description: h.description, id: h.id });
    }
  }

  return { national, custom };
}

/**
 * Get available years for a given country's holiday data.
 * JP: Parse all years from the single JSON response.
 * CN: Probe years starting from 2007 (earliest known) until we get 404s.
 * Returns: number[] (sorted ascending)
 */
export async function getAvailableYears(country = 'jp') {
  const cacheKey = `holiday_available_years_${country}`;
  const expiryKey = `holiday_available_years_expires_${country}`;
  const expiresAt = parseInt(getSetting(expiryKey) || '0', 10);

  // Return cached data if still valid (7-day TTL)
  if (Date.now() < expiresAt) {
    try {
      const cached = getSetting(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* re-fetch */ }
  }

  try {
    let years = [];

    if (country === 'jp') {
      // JP API returns ALL years in a single file — extract unique years
      // Filter to >= currentYear - 1 to keep dropdown practical
      const response = await fetchHolidayResource(JP_API_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const allData = await response.json();
      const currentYear = new Date().getFullYear();
      const minYear = currentYear - 1;
      const yearSet = new Set();
      for (const date of Object.keys(allData)) {
        const y = parseInt(date.substring(0, 4), 10);
        if (!isNaN(y) && y >= minYear) yearSet.add(y);
      }
      years = [...yearSet].sort((a, b) => a - b);
    } else if (country === 'cn') {
      // CN has per-year files — probe from 2007 to current+2
      // Use GET (not HEAD) and validate actual data is non-empty to avoid
      // showing years with no real holiday data
      const currentYear = new Date().getFullYear();
      const minYear = currentYear - 1;
      const probeYears = [];
      for (let y = minYear; y <= currentYear + 2; y++) {
        probeYears.push(y);
      }
      const results = await Promise.allSettled(
        probeYears.map(async (y) => {
          const url = CN_API_URL(y);
          const resp = await fetchHolidayResource(url);
          if (!resp.ok) return null;
          const data = await resp.json();
          // Validate: must have non-empty days array
          if (data && Array.isArray(data.days) && data.days.length > 0) {
            return y;
          }
          return null;
        })
      );
      years = results
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => a - b);
    }

    // Cache the result (7-day TTL)
    setSetting(expiryKey, String(Date.now() + 7 * DAY_MS));
    setSetting(cacheKey, JSON.stringify(years));
    console.log(`[Holiday] Available years for ${country}: ${years.join(', ')}`);
    return years;
  } catch (error) {
    console.error(
      '[Holiday] Failed to detect available years',
      { country, error: safeErrorMetadata(error) },
    );
    // Return cached or fallback
    const cached = getSetting(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* fallback */ }
    }
    // Fallback: current-2 to current+1
    const cy = new Date().getFullYear();
    return [cy - 2, cy - 1, cy, cy + 1];
  }
}

/**
 * Get holidays for a specific year
 * Returns: { national: [{date, name}], custom: [{date, description, id}] }
 */
export async function getHolidaysForYear(year, country = 'jp') {
  const nationals = await fetchNationalHolidays(country, year);
  const customs = getCustomHolidays();
  const prefix = `${year}-`;

  const national = [];
  for (const [date, name] of Object.entries(nationals)) {
    if (date.startsWith(prefix)) {
      national.push({ date, name });
    }
  }
  national.sort((a, b) => a.date.localeCompare(b.date));

  const custom = [];
  for (const h of customs) {
    if (h.date.startsWith(prefix)) {
      custom.push({ date: h.date, description: h.description, id: h.id });
    }
  }
  custom.sort((a, b) => a.date.localeCompare(b.date));

  return { national, custom };
}
