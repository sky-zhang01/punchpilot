import { Router } from 'express';
import { scheduler } from '../scheduler.js';

const router = Router();

const VALID_ACTIONS = ['checkin', 'checkout', 'break_start', 'break_end'];

/**
 * GET /api/schedule - Get today's resolved schedule
 */
router.get('/', (req, res) => {
  const schedule = scheduler.getTodaySchedule();
  res.json({ date: new Date().toISOString().split('T')[0], schedule });
});

/**
 * POST /api/trigger/:actionType - Manually trigger an action
 */
router.post('/trigger/:actionType', async (req, res) => {
  const { actionType } = req.params;

  if (!VALID_ACTIONS.includes(actionType)) {
    return res.status(400).json({
      error: `Invalid action type. Must be one of: ${VALID_ACTIONS.join(', ')}`,
    });
  }

  try {
    const result = await scheduler.triggerManual(actionType);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
