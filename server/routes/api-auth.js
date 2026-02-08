import { Router } from 'express';
import { loginHandler, logoutHandler, statusHandler, changePasswordHandler } from '../auth.js';

const router = Router();

router.post('/login', loginHandler);
router.post('/logout', logoutHandler);
router.get('/status', statusHandler);
router.put('/password', changePasswordHandler);

export default router;
