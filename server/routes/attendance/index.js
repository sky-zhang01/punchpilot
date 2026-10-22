import { Router } from "express";
import recordsRouter from "./records.js";
import batchRouter from "./batch.js";
import approvalRouter from "./approval.js";
import leaveRouter from "./leave.js";
import batchOperationsRouter from "./batch-operations.js";

// Case-sensitive like the app router (app.js), so path variants cannot reach a handler.
const router = Router({ caseSensitive: true });

router.use(recordsRouter);
router.use(batchRouter);
router.use(approvalRouter);
router.use(leaveRouter);
router.use(batchOperationsRouter);

export default router;
