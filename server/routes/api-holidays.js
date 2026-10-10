import { Router } from 'express';
import { isDateString as isCalendarDate } from '../../shared/date-time.js';
import { parseExternalId } from '../freee-values.js';
import { nowInTz } from '../timezone.js';
import { addCustomHoliday, deleteCustomHoliday } from '../db.js';
import { getHolidaysForMonth, getHolidaysForYear, fetchNationalHolidays, getAvailableYears, getCnWorkdays } from '../holiday.js';
import logger, { safeErrorMetadata } from '../logger.js';
import { scheduler } from '../scheduler.js';
import { withAccountOperation } from '../account-operation.js';

const log = logger.child('Holidays');

const router = Router();

const SUPPORTED_COUNTRIES = ['jp', 'cn'];

async function mutateCalendarConfiguration(operation) {
  scheduler.stopAll();
  try {
    const result = await withAccountOperation(operation);
    await scheduler.initialize();
    return result;
  } catch (error) {
    await scheduler.initialize().catch((schedulerError) => {
      log.error('Scheduler recovery failed after calendar update error', {
        error: safeErrorMetadata(schedulerError),
      });
    });
    throw error;
  }
}

function parseYear(value) {
  if (!/^\d{4}$/.test(String(value || ''))) return null;
  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : null;
}

function parseMonth(value) {
  if (!/^(?:[1-9]|1[0-2])$/.test(String(value || ''))) return null;
  return Number(value);
}


/**
 * GET /api/holidays - Get holidays (national + custom)
 * Query params: year (required), month (optional)
 */
router.get('/', async (req, res) => {
  const { year, month, country } = req.query;

  const parsedYear = parseYear(year);
  const parsedMonth = month == null ? null : parseMonth(month);
  if (!parsedYear || (month != null && !parsedMonth)) {
    return res.status(400).json({ error: 'valid year and month are required' });
  }

  const countryCode = country || 'jp';
  if (!SUPPORTED_COUNTRIES.includes(countryCode)) {
    return res.status(400).json({ error: `Unsupported country: ${countryCode}` });
  }

  try {
    let holidays;
    if (month) {
      holidays = await getHolidaysForMonth(parsedYear, parsedMonth, countryCode);
    } else {
      holidays = await getHolidaysForYear(parsedYear, countryCode);
    }
    res.json(holidays);
  } catch (error) {
    log.error('Failed to fetch holidays', { error: safeErrorMetadata(error) });
    res.status(500).json({ error: 'Failed to fetch holidays' });
  }
});

/**
 * GET /api/holidays/national - Get cached national holidays
 */
router.get('/national', async (req, res) => {
  try {
    const holidays = await fetchNationalHolidays();
    res.json(holidays);
  } catch (error) {
    log.error('Failed to fetch national holidays', { error: safeErrorMetadata(error) });
    res.status(500).json({ error: 'Failed to fetch national holidays' });
  }
});

/**
 * GET /api/holidays/available-years - Get years that have holiday data
 * Query params: country (optional, defaults to 'jp')
 * Returns: { years: [2020, 2021, ..., 2027] }
 */
router.get('/available-years', async (req, res) => {
  const { country } = req.query;
  const countryCode = country || 'jp';
  if (!SUPPORTED_COUNTRIES.includes(countryCode)) {
    return res.status(400).json({ error: `Unsupported country: ${countryCode}` });
  }

  try {
    const allYears = await getAvailableYears(countryCode);
    // Filter: show from (currentYear - 1) to the latest available year
    const currentYear = nowInTz().year;
    const years = allYears.filter(y => y >= currentYear - 1);
    res.json({ years, country: countryCode });
  } catch (error) {
    log.error('Failed to fetch available years', { error: safeErrorMetadata(error) });
    res.status(500).json({ error: 'Failed to fetch available years' });
  }
});

/**
 * GET /api/holidays/cn-workdays - Get Chinese 调休 (makeup workday) dates
 * These are weekends designated as working days during holiday periods.
 * Query params: year (required)
 * Returns: { workdays: [{ date: "YYYY-MM-DD", name: "..." }, ...] }
 */
router.get('/cn-workdays', async (req, res) => {
  const { year } = req.query;

  const parsedYear = parseYear(year);
  if (!parsedYear) {
    return res.status(400).json({ error: 'valid year is required' });
  }

  try {
    const y = parsedYear;
    // Ensure CN data is fetched first (populates workday cache as side effect)
    await fetchNationalHolidays('cn', y);
    const workdays = getCnWorkdays(y);
    const result = Object.entries(workdays).map(([date, name]) => ({ date, name }));
    result.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ workdays: result, year: y });
  } catch (error) {
    log.error('Failed to fetch CN workdays', { error: safeErrorMetadata(error) });
    res.status(500).json({ error: 'Failed to fetch CN workdays' });
  }
});

/**
 * POST /api/holidays/custom - Add a custom holiday
 * Body: { date: "YYYY-MM-DD", description: "string" }
 */
router.post('/custom', async (req, res) => {
  const { date, description } = req.body;

  if (!date || !isCalendarDate(date)) {
    return res.status(400).json({ error: 'date is required in YYYY-MM-DD format' });
  }
  if (
    description != null &&
    (typeof description !== 'string' || description.length > 200)
  ) {
    return res.status(400).json({ error: 'description must be 200 characters or less' });
  }
  const normalizedDescription = description || '';

  try {
    const result = await mutateCalendarConfiguration(() =>
      addCustomHoliday(date, normalizedDescription));
    res.json({ id: result.lastInsertRowid, date, description: normalizedDescription });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Holiday already exists for this date' });
    }
    log.error('Failed to add custom holiday', { error: safeErrorMetadata(error) });
    res.status(500).json({ error: 'Failed to add custom holiday' });
  }
});

/**
 * DELETE /api/holidays/custom/:id - Delete a custom holiday
 */
router.delete('/custom/:id', async (req, res) => {
  if (!parseExternalId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid holiday ID' });
  }
  const result = await mutateCalendarConfiguration(() =>
    deleteCustomHoliday(parseExternalId(req.params.id)));
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Holiday not found' });
  }
  res.json({ success: true });
});

export default router;
