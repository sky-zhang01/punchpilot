import { Router } from 'express';
import { loginHandler, logoutHandler, statusHandler, changePasswordHandler } from '../auth.js';

// Case-sensitive like the app router (app.js), so path variants cannot reach a handler.
const router = Router({ caseSensitive: true });

router.post('/login', loginHandler);
router.post('/logout', logoutHandler);
router.get('/status', statusHandler);
router.put('/password', changePasswordHandler);

export default router;
