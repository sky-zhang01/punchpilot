import { Router } from "express";
import recordsRouter from "./records.js";
import batchRouter from "./batch.js";
import approvalRouter from "./approval.js";
import leaveRouter from "./leave.js";
import batchOperationsRouter from "./batch-operations.js";

const router = Router();

router.use(recordsRouter);
router.use(batchRouter);
router.use(approvalRouter);
router.use(leaveRouter);
router.use(batchOperationsRouter);

export default router;
