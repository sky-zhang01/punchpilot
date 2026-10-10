import { Router } from 'express';
import { parseExternalId } from '../freee-values.js';
import { isDateString } from '../../shared/date-time.js';
import {
  getLogsByDate,
  getLogsPaginated,
  getLogById,
  getCalendarData,
  currentExecutionLogIdentityKey,
} from '../db.js';
import { getTodayString } from '../holiday.js';

const router = Router();
const LOG_STATUSES = new Set(['success', 'failure', 'skipped']);

function positiveInteger(value, fallback = null) {
  return value == null ? fallback : parseExternalId(value);
}

function calendarDate(value) {
  return isDateString(value) ? value : null;
}

/**
 * GET /api/logs - Paginated log query
 * Query params: date, date_from, date_to, action_type, status, search, page, limit
 */
router.get('/', (req, res) => {
  const {
    date,
    date_from,
    date_to,
    action_type,
    status,
    search,
    page,
    limit,
  } = req.query;
  const parsedPage = positiveInteger(page, 1);
  const parsedLimit = positiveInteger(limit, 20);
  const parsedDate = date == null ? null : calendarDate(date);
  const parsedDateFrom = date_from == null ? null : calendarDate(date_from);
  const parsedDateTo = date_to == null ? null : calendarDate(date_to);
  if (
    parsedPage == null ||
    parsedLimit == null ||
    parsedLimit > 100 ||
    (date != null && !parsedDate) ||
    (date_from != null && !parsedDateFrom) ||
    (date_to != null && !parsedDateTo) ||
    (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) ||
    (date != null && (date_from != null || date_to != null)) ||
    (action_type != null && (typeof action_type !== 'string' || action_type.length > 64)) ||
    (status != null && (typeof status !== 'string' || !LOG_STATUSES.has(status))) ||
    (search != null && (typeof search !== 'string' || search.length > 100))
  ) {
    return res.status(400).json({ error: 'Invalid log query' });
  }
  const result = getLogsPaginated({
    date: parsedDate,
    date_from: parsedDateFrom,
    date_to: parsedDateTo,
    action_type,
    status,
    search: typeof search === 'string' ? search.trim() : null,
    identity_key: currentExecutionLogIdentityKey(),
    page: parsedPage,
    limit: parsedLimit,
  });
  res.json(result);
});

/**
 * GET /api/logs/today - Today's logs
 */
router.get('/today', (req, res) => {
  const today = getTodayString();
  const logs = getLogsByDate(today, currentExecutionLogIdentityKey());
  res.json({ date: today, logs });
});

/**
 * GET /api/logs/calendar - Calendar view aggregation
 * Query params: year, month
 */
router.get('/calendar', (req, res) => {
  const { year, month } = req.query;
  const parsedYear = positiveInteger(year);
  const parsedMonth = positiveInteger(month);
  if (!parsedYear || parsedYear < 2000 || parsedYear > 2100 || !parsedMonth || parsedMonth > 12) {
    return res.status(400).json({ error: 'valid year and month are required' });
  }
  const data = getCalendarData(
    parsedYear,
    parsedMonth,
    currentExecutionLogIdentityKey(),
  );
  res.json(data);
});

/**
 * GET /api/logs/:id - Single log entry
 */
router.get('/:id', (req, res) => {
  const id = positiveInteger(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid log ID' });
  const log = getLogById(id, currentExecutionLogIdentityKey());
  if (!log) {
    return res.status(404).json({ error: 'Log not found' });
  }
  res.json(log);
});

export default router;
