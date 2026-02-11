import { getSetting, setSetting, getCustomHolidays } from './db.js';
import { todayStringInTz, currentDayInTz } from './timezone.js';

// Holiday API endpoints by country
// JP: single file with all years
// CN: per-year file from NateScarlet/holiday-cn
const JP_API_URL = 'https://holidays-jp.github.io/api/v1/date.json';
const CN_API_URL = (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;

/**
 * Fetch national holidays for a country+year, with daily caching.
 * Returns: { "YYYY-MM-DD": "Holiday Name", ... }
 */
export async function fetchNationalHolidays(country = 'jp', year = null) {
  // Resolve year for cache key
  const resolvedYear = year || new Date().getFullYear();
  const cacheKey = `holiday_cache_${country}_${resolvedYear}`;
  const cacheDateKey = `holiday_cache_date_${country}_${resolvedYear}`;
  const cacheDate = getSetting(cacheDateKey);
  const today = todayStringInTz();

  // Return cached data if still valid (same day)
  if (cacheDate === today) {
    try {
      const cached = getSetting(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // Cache corrupted, re-fetch
    }
  }

  try {
    if (country === 'jp') {
      return await fetchJpHolidays(resolvedYear, cacheKey, cacheDateKey, today);
    } else if (country === 'cn') {
      return await fetchCnHolidays(resolvedYear, cacheKey, cacheDateKey, today);
    }
    return {};
  } catch (error) {
    console.error(`[Holiday] Failed to fetch ${country}/${resolvedYear} holidays: ${error.message}, using cache`);
    const cached = getSetting(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch { return {}; }
    }
    return {};
  }
}

/**
 * Fetch Japanese holidays: { "YYYY-MM-DD": "名前", ... }
 * JP API returns ALL years in a single file, we filter by year.
 */
async function fetchJpHolidays(year, cacheKey, cacheDateKey, today) {
  const response = await fetch(JP_API_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const allData = await response.json();

  // Filter to requested year only
  const prefix = `${year}-`;
  const data = {};
  for (const [date, name] of Object.entries(allData)) {
    if (date.startsWith(prefix)) {
      data[date] = name;
    }
  }

  setSetting(cacheDateKey, today);
  setSetting(cacheKey, JSON.stringify(data));
  console.log(`[Holiday] Fetched ${Object.keys(data).length} JP national holidays for ${year}`);
  return data;
}

/**
 * Fetch Chinese holidays from NateScarlet/holiday-cn (per-year JSON files)
 * Source format: { year: 2025, days: [{ date: "YYYY-MM-DD", name: "...", isOffDay: true/false }, ...] }
 * We convert to: { "YYYY-MM-DD": "名前", ... } (same as JP format, only off-days)
 * Also caches 调休 workdays (isOffDay=false) separately for weekend override logic.
 */
async function fetchCnHolidays(year, cacheKey, cacheDateKey, today) {
  const url = CN_API_URL(year);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const raw = await response.json();

  const data = {};       // holidays (isOffDay=true)
  const workdays = {};   // 调休 workdays (isOffDay=false) — weekends that are working days
  if (raw.days && Array.isArray(raw.days)) {
    for (const day of raw.days) {
      if (day.isOffDay) {
        data[day.date] = day.name;
      } else {
        workdays[day.date] = day.name;
      }
    }
  }

  setSetting(cacheDateKey, today);
  setSetting(cacheKey, JSON.stringify(data));
  // Cache workdays separately
  const workdayCacheKey = `holiday_cache_cn_workdays_${year}`;
  setSetting(workdayCacheKey, JSON.stringify(workdays));
  console.log(`[Holiday] Fetched ${Object.keys(data).length} CN holidays + ${Object.keys(workdays).length} 调休 workdays for ${year}`);
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
    try { return JSON.parse(cached); } catch { return {}; }
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
  const cacheDateKey = `holiday_available_years_date_${country}`;
  const cacheDate = getSetting(cacheDateKey);
  const today = todayStringInTz();

  // Return cached data if still valid (same day)
  if (cacheDate === today) {
    try {
      const cached = getSetting(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* re-fetch */ }
  }

  try {
    let years = [];

    if (country === 'jp') {
      // JP API returns ALL years in a single file — extract unique years
      const response = await fetch(JP_API_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const allData = await response.json();
      const yearSet = new Set();
      for (const date of Object.keys(allData)) {
        const y = parseInt(date.substring(0, 4), 10);
        if (!isNaN(y)) yearSet.add(y);
      }
      years = [...yearSet].sort((a, b) => a - b);
    } else if (country === 'cn') {
      // CN has per-year files — probe from 2007 to current+2
      const currentYear = new Date().getFullYear();
      const probeYears = [];
      for (let y = 2007; y <= currentYear + 2; y++) {
        probeYears.push(y);
      }
      // Probe in parallel (with small batches to avoid overwhelming)
      const results = await Promise.allSettled(
        probeYears.map(async (y) => {
          const url = CN_API_URL(y);
          const resp = await fetch(url, { method: 'HEAD' });
          return resp.ok ? y : null;
        })
      );
      years = results
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => a - b);
    }

    // Cache the result
    setSetting(cacheDateKey, today);
    setSetting(cacheKey, JSON.stringify(years));
    console.log(`[Holiday] Available years for ${country}: ${years.join(', ')}`);
    return years;
  } catch (error) {
    console.error(`[Holiday] Failed to detect available years for ${country}: ${error.message}`);
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
