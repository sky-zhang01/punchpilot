import { Router } from 'express';
import { getLogsByDate, getLogsPaginated, getLogById, getCalendarData } from '../db.js';
import { getTodayString } from '../holiday.js';

const router = Router();

/**
 * GET /api/logs - Paginated log query
 * Query params: date, action_type, page, limit
 */
router.get('/', (req, res) => {
  const { date, action_type, page, limit } = req.query;
  const result = getLogsPaginated({
    date,
    action_type,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? Math.min(parseInt(limit, 10), 100) : 20,
  });
  res.json(result);
});

/**
 * GET /api/logs/today - Today's logs
 */
router.get('/today', (req, res) => {
  const today = getTodayString();
  const logs = getLogsByDate(today);
  res.json({ date: today, logs });
});

/**
 * GET /api/logs/calendar - Calendar view aggregation
 * Query params: year, month
 */
router.get('/calendar', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) {
    return res.status(400).json({ error: 'year and month are required' });
  }
  const data = getCalendarData(parseInt(year, 10), parseInt(month, 10));
  res.json(data);
});

/**
 * GET /api/logs/:id - Single log entry
 */
router.get('/:id', (req, res) => {
  const log = getLogById(parseInt(req.params.id, 10));
  if (!log) {
    return res.status(404).json({ error: 'Log not found' });
  }
  res.json(log);
});

export default router;
