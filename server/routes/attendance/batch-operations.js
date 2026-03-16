import { Router } from "express";
import { getSetting, setSetting, insertLog } from "../../db.js";
import { FreeeApiClient } from "../../freee-api.js";
import {
  withdrawApprovalRequestWeb,
  hasWebCredentials,
  scrapeEmployeeProfile,
} from "../../automation/index.js";
import {
  log,
  createTask,
  updateTask,
  sanitizeError,
  toTimeOnly,
  requireOAuth,
  findAttendanceRouteId,
  TYPE_TO_ENDPOINT,
  TYPE_TO_RESPONSE_KEY,
} from "./utils.js";

const router = Router();

// ===================================================================
//  Employee Info
// ===================================================================

/**
 * GET /api/attendance/employee-info - Get employee info from freee
 * Returns whatever data is accessible with current permissions
 */
router.get("/employee-info", async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    // /users/me always works
    const userInfo = await client.apiRequest("GET", "/users/me");
    const company = (userInfo.companies || []).find(
      (c) => String(c.id) === String(companyId),
    );

    const result = {
      user_id: userInfo.id,
      employee_id: parseInt(employeeId, 10),
      company_id: parseInt(companyId, 10),
      company_name: company ? company.name : null,
      display_name: company ? company.display_name : null,
      role: company ? company.role : null,
      // Fields from /employees/{id} — requires elevated permissions
      num: null,
      entry_date: null,
      retire_date: null,
      employment_type: null,
      title: null,
      birth_date: null,
    };

    // Try to get detailed employee info (may fail with self_only role)
    try {
      const empData = await client.apiRequest(
        "GET",
        `/employees/${employeeId}?company_id=${companyId}&year=${new Date().getFullYear()}&month=${new Date().getMonth() + 1}`,
      );
      if (empData) {
        result.num = empData.num || null;
        result.entry_date = empData.entry_date || null;
        result.retire_date = empData.retire_date || null;
        result.birth_date = empData.birth_date || null;
        if (empData.profile_rule) {
          result.employment_type = empData.profile_rule.employment_type || null;
          result.title = empData.profile_rule.title || null;
        }
      }
    } catch (empErr) {
      log.info(
        `Employee detail API not accessible (role=${result.role}): ${empErr.message.substring(0, 100)}`,
      );

      // Fallback: try to use cached data or web scraping
      const forceRefresh = req.query.force === "true";
      const cacheDate = getSetting("employee_info_cache_date");
      const cacheData = getSetting("employee_info_cache");
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

      if (!forceRefresh && cacheDate === currentMonth && cacheData) {
        // Use cached data
        try {
          const cached = JSON.parse(cacheData);
          result.name = cached.name || null;
          result.department = cached.department || null;
          result.position = cached.position || null;
          result.employment_type = cached.employment_type || null;
          result.entry_date = cached.entry_date || null;
          result.num = cached.employee_num || null;
          result.data_source = "cache";
          log.info("Using cached employee info from web scraping");
        } catch {
          /* ignore parse errors */
        }
      } else if (hasWebCredentials()) {
        // Try web scraping
        try {
          log.info(
            `Attempting employee info web scraping (employeeId=${employeeId})`,
          );
          const webInfo = await scrapeEmployeeProfile(employeeId);
          if (webInfo) {
            result.name = webInfo.name || null;
            result.department = webInfo.department || null;
            result.position = webInfo.position || null;
            result.employment_type = webInfo.employment_type || null;
            result.entry_date = webInfo.entry_date || null;
            result.num = webInfo.employee_num || null;
            result.data_source = "web";

            // Cache the result
            setSetting("employee_info_cache", JSON.stringify(webInfo));
            setSetting("employee_info_cache_date", currentMonth);
            log.info("Employee info scraped from web and cached");
          }
        } catch (webErr) {
          log.warn(
            `Employee info web scraping failed: ${webErr.message.substring(0, 100)}`,
          );
        }
      }
    }

    res.json(result);
  } catch (err) {
    log.error(`Failed to fetch employee info: ${err.message}`);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ===================================================================
//  Legacy Batch Work-Time (backward compat)
// ===================================================================

// Keep legacy batch-work-time endpoint for backward compatibility
router.post("/approval/batch-work-time", async (req, res) => {
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
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const routeId = await findAttendanceRouteId(client, companyId);

    log.info(
      `Legacy batch-work-time: ${entries.length} entries (route=${routeId})`,
    );

    const results = [];
    for (const entry of entries) {
      try {
        const body = {
          company_id: parseInt(companyId, 10),
          target_date: entry.date,
        };
        if (routeId) body.approval_flow_route_id = routeId;
        // Approval API: work_records + break_records with time-only "HH:MM"
        if (entry.clock_in_at || entry.clock_out_at) {
          const workRecord = {};
          if (entry.clock_in_at)
            workRecord.clock_in_at = toTimeOnly(entry.clock_in_at);
          if (entry.clock_out_at)
            workRecord.clock_out_at = toTimeOnly(entry.clock_out_at);
          body.work_records = [workRecord];
        }
        if (entry.break_records && entry.break_records.length > 0) {
          body.break_records = entry.break_records.map((br) => ({
            clock_in_at: toTimeOnly(br.clock_in_at),
            clock_out_at: toTimeOnly(br.clock_out_at),
          }));
        }
        if (reason) body.comment = reason;

        const result = await client.apiRequest(
          "POST",
          "/approval_requests/work_times",
          body,
        );
        results.push({
          date: entry.date,
          success: true,
          id: result.id || null,
        });
      } catch (err) {
        results.push({ date: entry.date, success: false, error: err.message });
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    res.json({ success: failed === 0, results, succeeded, failed });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ===================================================================
//  Batch Withdraw, Approve, and Incoming Requests
// ===================================================================

/**
 * POST /api/attendance/batch-withdraw - Withdraw multiple approval requests
 *
 * Body: {
 *   requests: [{ id: number, type: string }, ...]
 * }
 *
 * Uses cancel action → DELETE → Playwright web fallback (same as single withdraw).
 */
router.post("/batch-withdraw", async (req, res) => {
  const { requests } = req.body;
  if (!requests || !Array.isArray(requests) || requests.length === 0) {
    return res.status(400).json({ error: "requests array is required" });
  }
  if (requests.length > 50) {
    return res.status(400).json({ error: "Maximum 50 requests per batch" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  log.info(`Batch withdraw: ${requests.length} requests`);

  // Return task_id immediately, process in background
  const taskId = createTask("batch_withdraw");
  res.json({ task_id: taskId, status: "running" });

  (async () => {
    const results = [];
    let client;
    try {
      client = new FreeeApiClient();
      await client.ensureValidToken();
    } catch (err) {
      updateTask(taskId, {
        status: "failed",
        error: "OAuth token error. Please reconfigure OAuth.",
      });
      return;
    }

    for (const request of requests) {
      const { id, type } = request;
      const endpoint = TYPE_TO_ENDPOINT[type];
      if (!endpoint) {
        results.push({
          id,
          type,
          success: false,
          error: `Invalid type: ${type}`,
        });
        continue;
      }

      let succeeded = false;
      let method = null;

      // 1) Try cancel action
      try {
        const responseKey = TYPE_TO_RESPONSE_KEY[type];
        let requestData;
        try {
          requestData = await client.apiRequest(
            "GET",
            `/approval_requests/${endpoint}/${id}?company_id=${companyId}`,
          );
        } catch {
          /* ignore */
        }

        const detail = requestData?.[responseKey] || requestData;
        const currentStep = detail?.current_step_id;
        const currentRound = detail?.current_round || 1;

        await client.apiRequest(
          "POST",
          `/approval_requests/${endpoint}/${id}/actions?company_id=${companyId}`,
          {
            approval_action: "cancel",
            target_round: currentRound,
            target_step_id: currentStep,
          },
        );
        succeeded = true;
        method = "cancel";
      } catch (cancelErr) {
        log.info(
          `Batch withdraw: cancel failed for ${id} (${type}): ${cancelErr.message?.substring(0, 80)}`,
        );
      }

      // 2) Try DELETE
      if (!succeeded) {
        try {
          await client.apiRequest(
            "DELETE",
            `/approval_requests/${endpoint}/${id}?company_id=${companyId}`,
          );
          succeeded = true;
          method = "delete";
        } catch (deleteErr) {
          log.info(
            `Batch withdraw: DELETE failed for ${id} (${type}): ${deleteErr.message?.substring(0, 80)}`,
          );
        }
      }

      // 3) Playwright web fallback
      if (!succeeded && hasWebCredentials()) {
        try {
          const webResult = await withdrawApprovalRequestWeb(type, id);
          if (webResult.success) {
            succeeded = true;
            method = "web_withdraw";
          }
        } catch (webErr) {
          log.error(
            `Batch withdraw: web fallback failed for ${id}: ${webErr.message}`,
          );
        }
      }

      results.push({
        id,
        type,
        success: succeeded,
        method: method || "failed",
      });
      await new Promise((r) => setTimeout(r, 300));
    }

    const succeededCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;
    log.info(
      `Batch withdraw complete: ${succeededCount} succeeded, ${failedCount} failed`,
    );
    updateTask(taskId, {
      status: "completed",
      success: failedCount === 0,
      results,
      succeeded: succeededCount,
      failed: failedCount,
    });
  })();
});

/**
 * POST /api/attendance/batch-approve - Batch approve or reject approval requests
 *
 * Body: {
 *   requests: [{ id: number, type: string, action: 'approve' | 'feedback' }, ...]
 * }
 *
 * 'approve' → approve, 'feedback' → reject/send back
 */
router.post("/batch-approve", async (req, res) => {
  const { requests } = req.body;
  if (!requests || !Array.isArray(requests) || requests.length === 0) {
    return res.status(400).json({ error: "requests array is required" });
  }
  if (requests.length > 50) {
    return res.status(400).json({ error: "Maximum 50 requests per batch" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  log.info(`Batch approve: ${requests.length} requests`);

  let client;
  try {
    client = new FreeeApiClient();
    await client.ensureValidToken();
  } catch (err) {
    return res
      .status(500)
      .json({ error: "OAuth token error. Please reconfigure OAuth." });
  }

  const results = [];

  for (const request of requests) {
    const { id, type, action } = request;
    const endpoint = TYPE_TO_ENDPOINT[type];

    if (!endpoint) {
      results.push({
        id,
        type,
        success: false,
        error: `Invalid type: ${type}`,
      });
      continue;
    }
    if (!["approve", "feedback"].includes(action)) {
      results.push({
        id,
        type,
        success: false,
        error: `Invalid action: ${action}. Must be 'approve' or 'feedback'`,
      });
      continue;
    }

    try {
      // Get current step/round info
      const responseKey = TYPE_TO_RESPONSE_KEY[type];
      let requestData;
      try {
        requestData = await client.apiRequest(
          "GET",
          `/approval_requests/${endpoint}/${id}?company_id=${companyId}`,
        );
      } catch {
        /* ignore */
      }

      const detail = requestData?.[responseKey] || requestData;
      const currentStep = detail?.current_step_id;
      const currentRound = detail?.current_round || 1;

      const body = {
        approval_action: action,
        target_round: currentRound,
        target_step_id: currentStep,
      };

      await client.apiRequest(
        "POST",
        `/approval_requests/${endpoint}/${id}/actions?company_id=${companyId}`,
        body,
      );

      results.push({ id, type, action, success: true });
      log.info(`Batch approve: ${action} succeeded for ${id} (${type})`);
    } catch (err) {
      results.push({
        id,
        type,
        action,
        success: false,
        error: err.message?.substring(0, 120),
      });
      log.error(
        `Batch approve: ${action} failed for ${id} (${type}): ${err.message?.substring(0, 120)}`,
      );
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  const succeededCount = results.filter((r) => r.success).length;
  const failedCount = results.filter((r) => !r.success).length;
  log.info(
    `Batch approve complete: ${succeededCount} succeeded, ${failedCount} failed`,
  );
  res.json({
    success: failedCount === 0,
    results,
    succeeded: succeededCount,
    failed: failedCount,
  });
});

/**
 * GET /api/attendance/incoming-requests - Get approval requests pending the current user's approval
 *
 * Query: year, month
 *
 * Returns requests across all leave/work-time types where current user is the approver.
 */
router.get("/incoming-requests", async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) {
    return res
      .status(400)
      .json({ error: "year and month are required query parameters" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    // Get current user info to find their user ID
    let currentUserId;
    try {
      const me = await client.apiRequest("GET", "/users/me");
      currentUserId = me.id;
    } catch (err) {
      log.error(`Could not determine current user: ${err.message}`);
      return res.status(500).json({
        error:
          "Could not determine current user. Please check OAuth configuration.",
      });
    }

    const allRequests = [];

    for (const [type, endpoint] of Object.entries(TYPE_TO_ENDPOINT)) {
      try {
        // Get in_progress requests for this type
        const data = await client.apiRequest(
          "GET",
          `/approval_requests/${endpoint}?company_id=${companyId}&status=in_progress`,
        );

        const responseKey = `${TYPE_TO_RESPONSE_KEY[type]}s`; // plural
        const requests = data?.[responseKey] || data || [];

        if (!Array.isArray(requests)) continue;

        for (const req of requests) {
          // Filter: only include requests where current user is an approver on the current step
          const approvers = req.approvers || req.current_step_approvers || [];
          const isMyApproval = approvers.some(
            (a) => a.id === currentUserId || a.user_id === currentUserId,
          );

          // Also check approval_steps for more detailed matching
          const steps =
            req.approval_flow_route?.usage_steps || req.approval_steps || [];
          const currentStepId = req.current_step_id;
          const currentStepApprovers = steps
            .filter((s) => s.id === currentStepId)
            .flatMap((s) => s.approvers || []);
          const isMyStep = currentStepApprovers.some(
            (a) => a.id === currentUserId || a.user_id === currentUserId,
          );

          if (isMyApproval || isMyStep || approvers.length === 0) {
            allRequests.push({
              id: req.id,
              type,
              status: req.status || "in_progress",
              target_date: req.target_date,
              applicant:
                req.applicant?.display_name || req.applicant_name || "-",
              applicant_id: req.applicant?.id || req.applicant_id,
              comment: req.comment,
              created_at: req.created_at,
              current_round: req.current_round,
              current_step_id: req.current_step_id,
            });
          }
        }
      } catch (err) {
        log.warn(
          `incoming-requests: failed to fetch ${type}: ${err.message?.substring(0, 80)}`,
        );
      }
    }

    // Sort by created_at descending
    allRequests.sort((a, b) =>
      (b.created_at || "").localeCompare(a.created_at || ""),
    );

    log.info(
      `incoming-requests: found ${allRequests.length} requests for user ${currentUserId}`,
    );
    res.json({ requests: allRequests, count: allRequests.length });
  } catch (err) {
    log.error(`incoming-requests error: ${err.message}`);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

export default router;
