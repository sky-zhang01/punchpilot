import { Router } from "express";
import { getStrategyCache, setStrategyCache, insertLog } from "../../db.js";
import { FreeeApiClient } from "../../freee-api.js";
import {
  submitWebCorrections,
  hasWebCredentials,
} from "../../automation/index.js";
import {
  log,
  createTask,
  updateTask,
  getTask,
  sanitizeError,
  toFreeeTime,
  toTimeOnly,
  requireOAuth,
  findAttendanceRouteIds,
} from "./utils.js";

const router = Router();

// ===================================================================
//  Batch Operations — smart endpoint, auto-decides strategy per date
// ===================================================================

/**
 * POST /api/attendance/batch - Smart batch punch for multiple dates
 *
 * Body: {
 *   entries: [{ date, clock_in_at, clock_out_at, break_records?, is_editable? }],
 *   reason?: string  (used as comment when submitting approval requests)
 * }
 *
 * The server automatically decides per-date:
 *   - is_editable=true  → PUT /work_records (direct write, no approval)
 *   - is_editable=false → POST /approval_requests/work_times (needs approval)
 *   - No approval route → always try PUT regardless
 *
 * The frontend just sends dates + times. The backend handles the rest.
 * This is the user's one-click "batch punch" — they don't need to know
 * whether it's a direct write or an approval request.
 */
/**
 * GET /api/attendance/batch/status/:taskId - Poll async batch task status
 */
router.get("/batch/status/:taskId", (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({
      error: "Task not found. It may have expired or the server was restarted. Check the execution logs for results.",
      code: "TASK_NOT_FOUND",
    });
  }
  res.json(task);
});

router.post("/batch", async (req, res) => {
  const { entries, reason } = req.body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return res
      .status(400)
      .json({ error: "entries array is required and must not be empty" });
  }
  if (entries.length > 50) {
    return res
      .status(400)
      .json({ error: "Maximum 50 entries per batch request" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  // Return task_id immediately, process in background
  const taskId = createTask("batch_punch");
  res.json({ task_id: taskId, status: "running" });

  // Background processing (runs after response is sent)
  (async () => {
    try {
      const client = new FreeeApiClient();
      await client.ensureValidToken();

      // Probe once: does this company have approval workflows?
      const {
        primaryRouteId,
        fallbackRouteId,
        primaryRouteUserId,
        primaryRouteNeedsApprover,
      } = await findAttendanceRouteIds(client, companyId);
      const routeId = primaryRouteId || fallbackRouteId;
      const hasApproval = !!routeId;

      // Get current user ID for self-approval (needed when route requires approver specification)
      let selfUserId = null;
      if (primaryRouteNeedsApprover) {
        try {
          const me = await client.apiRequest("GET", "/users/me");
          selfUserId = me.id;
        } catch {
          /* ignore */
        }
      }

      // Helper: build the approval request body
      function buildApprovalBody(entry, useRouteId) {
        const body = {
          company_id: parseInt(companyId, 10),
          target_date: entry.date,
          approval_flow_route_id: useRouteId,
        };

        // Some routes require specifying an approver (e.g. "承認者を指定" type)
        // Use the route's configured user_id, or fall back to self (admin can self-approve)
        if (primaryRouteNeedsApprover && useRouteId === primaryRouteId) {
          body.approver_id = primaryRouteUserId || selfUserId;
        }

        // work_records: array of { clock_in_at, clock_out_at } in "HH:MM" format
        if (entry.clock_in_at || entry.clock_out_at) {
          const workRecord = {};
          if (entry.clock_in_at)
            workRecord.clock_in_at = toTimeOnly(entry.clock_in_at);
          if (entry.clock_out_at)
            workRecord.clock_out_at = toTimeOnly(entry.clock_out_at);
          body.work_records = [workRecord];
        }

        // break_records: top-level array of { clock_in_at, clock_out_at } in "HH:MM" format
        if (entry.break_records && entry.break_records.length > 0) {
          body.break_records = entry.break_records.map((br) => ({
            clock_in_at: toTimeOnly(br.clock_in_at),
            clock_out_at: toTimeOnly(br.clock_out_at),
          }));
        }

        if (reason) body.comment = reason;
        return body;
      }

      // Helper: submit one entry via approval request
      async function submitApproval(entry) {
        const body = buildApprovalBody(
          entry,
          primaryRouteId || fallbackRouteId,
        );
        return await client.apiRequest(
          "POST",
          "/approval_requests/work_times",
          body,
        );
      }

      // Helper: submit one entry via time_clocks (打刻 API)
      // Sends sequential clock_in → break_begin → break_end → clock_out punches.
      // For self_only users, datetime cannot be specified — only works for "now" punching.
      // Past dates will fail with permission error; we catch and give a clear message.
      async function submitTimeClock(entry) {
        const cid = parseInt(companyId, 10);
        const punches = [];

        if (entry.clock_in_at) {
          punches.push({
            type: "clock_in",
            datetime: toFreeeTime(entry.clock_in_at),
            base_date: entry.date,
          });
        }
        if (entry.break_records && entry.break_records.length > 0) {
          for (const br of entry.break_records) {
            if (br.clock_in_at)
              punches.push({
                type: "break_begin",
                datetime: toFreeeTime(br.clock_in_at),
                base_date: entry.date,
              });
            if (br.clock_out_at)
              punches.push({
                type: "break_end",
                datetime: toFreeeTime(br.clock_out_at),
                base_date: entry.date,
              });
          }
        }
        if (entry.clock_out_at) {
          punches.push({
            type: "clock_out",
            datetime: toFreeeTime(entry.clock_out_at),
            base_date: entry.date,
          });
        }

        for (const punch of punches) {
          await client.apiRequest(
            "POST",
            `/employees/${employeeId}/time_clocks`,
            { company_id: cid, ...punch },
          );
          await new Promise((r) => setTimeout(r, 200));
        }
        return { method: "time_clock", punches: punches.length };
      }

      // Track which strategies have failed at company level
      let approvalRouteBlocked = false;

      // Check strategy cache for this month
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const cachedStrategy = getStrategyCache(currentMonth);

      log.info(
        `Batch: ${entries.length} entries, approval=${hasApproval}${routeId ? ` (route=${routeId})` : ""}${cachedStrategy ? `, cached_best=${cachedStrategy.best_strategy}` : ""}`,
      );

      const results = [];
      let webFallbackEntries = []; // Entries that need Strategy 4 (web fallback)
      // Company-level strategy detection: once a strategy fails for company-wide reasons,
      // skip it for all remaining entries. Pre-seed from cache if available.
      let directDisabled = cachedStrategy ? !cachedStrategy.direct_ok : false;
      if (cachedStrategy && !cachedStrategy.approval_ok)
        approvalRouteBlocked = true;

      // FAST PATH: If cached best strategy is 'web', skip API strategies 1-3 entirely
      const skipApiStrategies = cachedStrategy?.best_strategy === "web";
      if (skipApiStrategies) {
        log.info(
          `Cached best=web → skipping API strategies 1-3, sending all ${entries.length} entries directly to Strategy 4`,
        );
        webFallbackEntries = [...entries];
      }

      // Process each entry with 3-tier auto-fallback (skipped if cached best=web):
      //   1. PUT /work_records (direct write) — fastest, no approval needed
      //   2. POST /approval_requests/work_times (approval) — needs approval route
      //   3. POST /time_clocks (clock punches) — last resort, simulates real-time clocking
      for (let i = 0; !skipApiStrategies && i < entries.length; i++) {
        const entry = entries[i];

        // Refresh token periodically for large batches to avoid expiry mid-operation
        if (i > 0 && i % 10 === 0) {
          try {
            await client.ensureValidToken();
          } catch (e) {
            log.warn(`Token refresh at entry ${i}: ${e.message}`);
          }
        }

        // Pre-check: skip entries where freee already has a clock_in record
        try {
          const existingRecord = await client.apiRequest(
            "GET",
            `/employees/${employeeId}/work_records/${entry.date}?company_id=${companyId}`,
          );
          if (existingRecord?.clock_in_at) {
            results.push({
              date: entry.date,
              success: true,
              method: "skipped",
              reason: "Already has clock_in in freee",
            });
            log.info(`[${entry.date}] Skipped: already has clock_in in freee`);
            continue;
          }
        } catch (e) {
          log.warn(
            `[${entry.date}] Pre-check failed (proceeding): ${e.message}`,
          );
        }

        let succeeded = false;
        const editable =
          entry.is_editable !== undefined ? entry.is_editable : true;

        // === Strategy 1: Direct PUT ===
        if (!directDisabled && (editable || !hasApproval)) {
          try {
            const body = { company_id: parseInt(companyId, 10) };
            if (entry.clock_in_at)
              body.clock_in_at = toFreeeTime(entry.clock_in_at);
            if (entry.clock_out_at)
              body.clock_out_at = toFreeeTime(entry.clock_out_at);
            if (entry.break_records && entry.break_records.length > 0) {
              body.break_records = entry.break_records.map((br) => ({
                clock_in_at: toFreeeTime(br.clock_in_at),
                clock_out_at: toFreeeTime(br.clock_out_at),
              }));
            }
            await client.apiRequest(
              "PUT",
              `/employees/${employeeId}/work_records/${entry.date}?company_id=${companyId}`,
              body,
            );
            results.push({ date: entry.date, success: true, method: "direct" });
            log.info(`[${entry.date}] Direct write succeeded`);
            succeeded = true;
          } catch (err) {
            const errMsg = err.message || "";
            if (errMsg.includes("勤怠修正") || errMsg.includes("無効")) {
              directDisabled = true;
              log.info(
                `[${entry.date}] Direct write disabled at company level, trying next strategy`,
              );
            } else {
              log.warn(
                `[${entry.date}] Direct write failed: ${errMsg.substring(0, 120)}`,
              );
            }
          }
        }

        // === Strategy 2: Approval request ===
        if (!succeeded && hasApproval && !approvalRouteBlocked) {
          try {
            const result = await submitApproval(entry);
            results.push({
              date: entry.date,
              success: true,
              method: "approval",
              id: result.id || null,
            });
            log.info(`[${entry.date}] Approval request succeeded`);
            succeeded = true;
          } catch (err) {
            const errMsg = err.message || "";
            if (errMsg.includes("役職") || errMsg.includes("部門")) {
              approvalRouteBlocked = true;
              log.info(
                `[${entry.date}] Approval route uses dept/position (unsupported by API), trying time_clocks`,
              );
            } else {
              log.warn(
                `[${entry.date}] Approval request failed: ${errMsg.substring(0, 120)}`,
              );
            }
          }
        }

        // === Strategy 3: Time clocks (打刻 API) ===
        if (!succeeded) {
          try {
            await submitTimeClock(entry);
            results.push({
              date: entry.date,
              success: true,
              method: "time_clock",
            });
            log.info(`[${entry.date}] Time clock punches succeeded`);
            succeeded = true;
          } catch (err) {
            const errMsg = err.message || "";
            // Collect for Strategy 4 (web fallback)
            webFallbackEntries.push(entry);
            log.warn(
              `[${entry.date}] API strategies 1-3 all failed. Last error: ${errMsg.substring(0, 150)}`,
            );
          }
        }

        await new Promise((r) => setTimeout(r, 200));
      }

      // === Strategy 4: Playwright Web fallback ===
      // Pre-check web fallback entries: skip any that already have clock_in in freee
      if (webFallbackEntries.length > 0) {
        const filteredWebEntries = [];
        for (const entry of webFallbackEntries) {
          try {
            const existingRecord = await client.apiRequest(
              "GET",
              `/employees/${employeeId}/work_records/${entry.date}?company_id=${companyId}`,
            );
            if (existingRecord?.clock_in_at) {
              results.push({
                date: entry.date,
                success: true,
                method: "skipped",
                reason: "Already has clock_in in freee",
              });
              log.info(
                `[${entry.date}] Web fallback skipped: already has clock_in in freee`,
              );
              continue;
            }
          } catch (e) {
            log.warn(
              `[${entry.date}] Web fallback pre-check failed (proceeding): ${e.message}`,
            );
          }
          filteredWebEntries.push(entry);
        }
        webFallbackEntries = filteredWebEntries;
      }

      // For entries where all API strategies failed, try submitting via freee Web form
      if (webFallbackEntries.length > 0 && hasWebCredentials()) {
        log.info(
          `Strategy 4: Attempting ${webFallbackEntries.length} entries via freee Web (Playwright)...`,
        );
        try {
          const webResults = await submitWebCorrections(
            webFallbackEntries,
            reason || "打刻漏れのため修正",
          );
          for (const wr of webResults) {
            results.push(wr);
            if (wr.success) {
              log.info(`[${wr.date}] Web correction succeeded`);
            } else {
              log.error(`[${wr.date}] Web correction failed: ${wr.error}`);
            }
          }
        } catch (err) {
          log.error(`Strategy 4 (Web) failed entirely: ${err.message}`);
          for (const entry of webFallbackEntries) {
            results.push({
              date: entry.date,
              success: false,
              method: "all_failed",
              error: `Web fallback error: ${err.message}`,
            });
          }
        }
      } else if (webFallbackEntries.length > 0) {
        // No web credentials — report as freee_web_required so frontend shows setup prompt
        log.warn(
          `Strategy 4 skipped: ${webFallbackEntries.length} entries need web credentials`,
        );
        for (const entry of webFallbackEntries) {
          results.push({
            date: entry.date,
            success: false,
            method: "all_failed",
            error: "web_credentials_required",
          });
        }
      }

      // Update strategy cache based on what we learned during this batch
      const methodsUsed = results.map((r) => r.method);
      const newCacheData = {
        direct_ok: !directDisabled,
        approval_ok: !approvalRouteBlocked && hasApproval,
        time_clock_ok:
          methodsUsed.includes("time_clock") ||
          (cachedStrategy ? !!cachedStrategy.time_clock_ok : true),
        best_strategy: directDisabled
          ? approvalRouteBlocked
            ? hasWebCredentials()
              ? "web"
              : "time_clock"
            : "approval"
          : "direct",
      };
      setStrategyCache(currentMonth, newCacheData);

      const succeededCount = results.filter((r) => r.success).length;
      const failedCount = results.filter((r) => !r.success).length;
      const methods = {};
      for (const r of results) {
        methods[r.method] = (methods[r.method] || 0) + 1;
      }
      log.info(
        `Batch complete: ${succeededCount}/${results.length} succeeded (${JSON.stringify(methods)})`,
      );

      // Log each batch result to execution_log for audit trail
      for (const r of results) {
        try {
          insertLog({
            action_type: "batch_correction",
            scheduled_time: r.date,
            status: r.success ? "success" : "failure",
            trigger_type: "batch",
            error_message: r.success
              ? `method=${r.method}`
              : `method=${r.method} | ${r.error || "Unknown error"}`,
          });
        } catch (logErr) {
          log.warn(
            `Failed to write batch log for ${r.date}: ${logErr.message}`,
          );
        }
      }

      // Include strategy info for frontend
      const webCredsInvalid = results.some(
        (r) => r.error === "web_credentials_invalid",
      );
      const strategyInfo = {
        direct_disabled: directDisabled,
        approval_route_blocked: approvalRouteBlocked,
        web_fallback_used: webFallbackEntries.length > 0 && hasWebCredentials(),
        web_credentials_configured: hasWebCredentials(),
        web_credentials_invalid: webCredsInvalid,
      };

      updateTask(taskId, {
        status: "completed",
        success: failedCount === 0,
        results,
        succeeded: succeededCount,
        failed: failedCount,
        strategy_info: strategyInfo,
      });
    } catch (err) {
      log.error(`Batch failed: ${err.message}`);
      updateTask(taskId, { status: "failed", error: sanitizeError(err) });
    }
  })();
});

export default router;
