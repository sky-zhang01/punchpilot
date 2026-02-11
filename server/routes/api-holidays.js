import { Router } from 'express';
import { addCustomHoliday, deleteCustomHoliday } from '../db.js';
import { getHolidaysForMonth, getHolidaysForYear, fetchNationalHolidays, getAvailableYears, getCnWorkdays } from '../holiday.js';
import logger from '../logger.js';

const log = logger.child('Holidays');

const router = Router();

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const SUPPORTED_COUNTRIES = ['jp', 'cn'];

/**
 * GET /api/holidays - Get holidays (national + custom)
 * Query params: year (required), month (optional)
 */
router.get('/', async (req, res) => {
  const { year, month, country } = req.query;

  if (!year) {
    return res.status(400).json({ error: 'year is required' });
  }

  const countryCode = country || 'jp';
  if (!SUPPORTED_COUNTRIES.includes(countryCode)) {
    return res.status(400).json({ error: `Unsupported country: ${countryCode}` });
  }

  try {
    let holidays;
    if (month) {
      holidays = await getHolidaysForMonth(parseInt(year, 10), parseInt(month, 10), countryCode);
    } else {
      holidays = await getHolidaysForYear(parseInt(year, 10), countryCode);
    }
    res.json(holidays);
  } catch (error) {
    log.error(`Failed to fetch holidays: ${error.message}`);
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
    log.error(`Failed to fetch national holidays: ${error.message}`);
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
    const currentYear = new Date().getFullYear();
    const years = allYears.filter(y => y >= currentYear - 1);
    res.json({ years, country: countryCode });
  } catch (error) {
    log.error(`Failed to fetch available years: ${error.message}`);
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

  if (!year) {
    return res.status(400).json({ error: 'year is required' });
  }

  try {
    const y = parseInt(year, 10);
    // Ensure CN data is fetched first (populates workday cache as side effect)
    await fetchNationalHolidays('cn', y);
    const workdays = getCnWorkdays(y);
    const result = Object.entries(workdays).map(([date, name]) => ({ date, name }));
    result.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ workdays: result, year: y });
  } catch (error) {
    log.error(`Failed to fetch CN workdays: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch CN workdays' });
  }
});

/**
 * POST /api/holidays/custom - Add a custom holiday
 * Body: { date: "YYYY-MM-DD", description: "string" }
 */
router.post('/custom', (req, res) => {
  const { date, description } = req.body;

  if (!date || !DATE_REGEX.test(date)) {
    return res.status(400).json({ error: 'date is required in YYYY-MM-DD format' });
  }

  try {
    const result = addCustomHoliday(date, description || '');
    res.json({ id: result.lastInsertRowid, date, description: description || '' });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Holiday already exists for this date' });
    }
    log.error(`Failed to add custom holiday: ${error.message}`);
    res.status(500).json({ error: 'Failed to add custom holiday' });
  }
});

/**
 * DELETE /api/holidays/custom/:id - Delete a custom holiday
 */
router.delete('/custom/:id', (req, res) => {
  const result = deleteCustomHoliday(parseInt(req.params.id, 10));
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Holiday not found' });
  }
  res.json({ success: true });
});

export default router;
