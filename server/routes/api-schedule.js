import { Router } from 'express';
import { ACTION_TYPES as VALID_ACTIONS } from '../../shared/schedule-policy.js';
import { todayStringInTz } from '../timezone.js';
import { scheduler } from '../scheduler.js';
import logger, { safeErrorMetadata } from '../logger.js';

const router = Router();
const log = logger.child('Schedule');


/**
 * GET /api/schedule - Get today's resolved schedule
 */
router.get('/', (req, res) => {
  const schedule = scheduler.getTodaySchedule();
  res.json({ date: todayStringInTz(), schedule });
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
    log.error('Manual trigger failed', { error: safeErrorMetadata(error) });
    res.status(500).json({
      error: 'Manual attendance action failed',
      code: error?.code || 'MANUAL_ACTION_FAILED',
    });
  }
});

export default router;
