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
 */
async function fetchCnHolidays(year, cacheKey, cacheDateKey, today) {
  const url = CN_API_URL(year);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const raw = await response.json();

  // Convert to { date: name } format, only include actual holidays (isOffDay=true)
  const data = {};
  if (raw.days && Array.isArray(raw.days)) {
    for (const day of raw.days) {
      if (day.isOffDay) {
        data[day.date] = day.name;
      }
    }
  }

  setSetting(cacheDateKey, today);
  setSetting(cacheKey, JSON.stringify(data));
  console.log(`[Holiday] Fetched ${Object.keys(data).length} CN national holidays for ${year}`);
  return data;
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
 */
export async function isHolidayOrWeekend(dateStr) {
  let day;
  if (dateStr) {
    const checkDate = new Date(dateStr + 'T00:00:00');
    day = checkDate.getDay();
  } else {
    day = currentDayInTz();
  }

  // Weekend
  if (day === 0 || day === 6) return true;

  const ds = dateStr || getTodayString();
  const year = parseInt(ds.substring(0, 4), 10);

  // Check national holidays for configured skip countries
  const skipCountries = (getSetting('holiday_skip_countries') || 'jp').split(',').map(c => c.trim());
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
