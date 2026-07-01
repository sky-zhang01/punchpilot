import { Router } from "express";
import { insertLog } from "../../db.js";
import { FREEE_ERROR_MESSAGES } from "../../constants.js";
import { FreeeApiClient } from "../../freee-api.js";
import {
  withdrawApprovalRequestWeb,
  hasWebCredentials,
  submitMonthlyAttendanceClosingWeb,
} from "../../automation/index.js";
import {
  log,
  sanitizeError,
  toTimeOnly,
  requireOAuth,
  findAttendanceRouteIds,
  findAttendanceRouteId,
  TYPE_TO_ENDPOINT,
  TYPE_TO_RESPONSE_KEY,
} from "./utils.js";

const router = Router();

function monthlyClosingScheduledTime(year, month) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function isMonthlyClosingAlreadySubmitted(err) {
  return err.message?.includes(
    FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED,
  );
}

function requiresMonthlyClosingWebFallback(err) {
  return (
    err.message?.includes("役職") ||
    err.message?.includes("部門") ||
    err.message?.includes("Webから申請")
  );
}

// ===================================================================
//  Approval Requests — individual operations (kept for single-use)
// ===================================================================

/**
 * GET /api/attendance/approval-routes - Get available approval flow routes
 */
router.get("/approval-routes", async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const data = await client.apiRequest(
      "GET",
      `/approval_flow_routes?company_id=${companyId}`,
    );

    const routes = data.approval_flow_routes || [];
    const attendanceRoute = routes.find(
      (r) => r.usages && r.usages.includes("AttendanceWorkflow"),
    );

    res.json({
      routes,
      attendance_route_id: attendanceRoute ? attendanceRoute.id : null,
      attendance_route_name: attendanceRoute ? attendanceRoute.name : null,
    });
  } catch (err) {
    log.error(`Failed to fetch approval routes: ${err.message}`);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

/**
 * POST /api/attendance/approval/monthly - Submit monthly attendance closing request
 * Body: { year, month }
 */
router.post("/approval/monthly", async (req, res) => {
  const { year, month } = req.body;
  if (!year || !month) {
    return res.status(400).json({ error: "year and month are required" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const routeId = await findAttendanceRouteId(client, companyId);

    log.info(
      `Submitting monthly attendance closing for ${year}-${String(month).padStart(2, "0")} (route=${routeId})`,
    );

    const body = {
      company_id: parseInt(companyId, 10),
      target_year: parseInt(year, 10),
      target_month: parseInt(month, 10),
    };
    if (routeId) body.approval_flow_route_id = routeId;

    const result = await client.apiRequest(
      "POST",
      "/approval_requests/monthly_attendances",
      body,
    );

    log.info("Monthly attendance closing request submitted");

    try {
      insertLog({
        action_type: "monthly_closing",
        scheduled_time: monthlyClosingScheduledTime(year, month),
        status: "success",
        trigger_type: "manual",
      });
    } catch (logErr) {
      /* ignore */
    }

    res.json({ success: true, result });
  } catch (err) {
    log.error(`Monthly closing API failed: ${err.message}`);

    if (isMonthlyClosingAlreadySubmitted(err)) {
      log.info("Monthly attendance closing already submitted");
      try {
        insertLog({
          action_type: "monthly_closing",
          scheduled_time: monthlyClosingScheduledTime(year, month),
          status: "success",
          trigger_type: "manual",
        });
      } catch (logErr) {
        /* ignore */
      }
      return res.json({
        success: true,
        alreadySubmitted: true,
        via: "api",
      });
    }

    // freee returns 400 when the company's approval flow requires dept/role routing —
    // the API cannot handle it and instructs us to use the web form instead.
    const needsWebFallback = requiresMonthlyClosingWebFallback(err);

    if (needsWebFallback && !hasWebCredentials()) {
      try {
        insertLog({
          action_type: "monthly_closing",
          scheduled_time: monthlyClosingScheduledTime(year, month),
          status: "failure",
          trigger_type: "manual",
          error_message: "Web credentials are required for monthly closing.",
        });
      } catch (logErr) {
        /* ignore */
      }
      return res.status(400).json({
        error:
          "Web credentials are required because freee requires monthly closing from the web form.",
        code: "WEB_CREDENTIALS_REQUIRED",
      });
    }

    if (needsWebFallback) {
      log.info(
        "Monthly closing: API rejected (dept/role routing required), falling back to Playwright web form",
      );
      try {
        const webResult = await submitMonthlyAttendanceClosingWeb(year, month);
        if (webResult.success) {
          try {
            insertLog({
              action_type: "monthly_closing",
              scheduled_time: monthlyClosingScheduledTime(year, month),
              status: "success",
              trigger_type: "manual",
            });
          } catch (logErr) {
            /* ignore */
          }
          return res.json({ success: true, via: "web", result: webResult });
        }
        // Web fallback also failed — fall through to error response
        log.error(`Monthly closing web fallback failed: ${webResult.error}`);
        try {
          insertLog({
            action_type: "monthly_closing",
            scheduled_time: monthlyClosingScheduledTime(year, month),
            status: "failure",
            trigger_type: "manual",
            error_message: String(webResult.error || "web fallback failed").substring(
              0,
              300,
            ),
          });
        } catch (logErr) {
          /* ignore */
        }
        if (webResult.error === "web_credentials_invalid") {
          return res.status(401).json({
            error: "Web credentials are invalid. Update freee web credentials.",
            code: "WEB_CREDENTIALS_INVALID",
          });
        }
        return res.status(500).json({
          error: sanitizeError(new Error(webResult.error || "web fallback failed")),
          code: "WEB_FALLBACK_FAILED",
        });
      } catch (webErr) {
        log.error(`Monthly closing web fallback threw: ${webErr.message}`);
      }
    }

    try {
      insertLog({
        action_type: "monthly_closing",
        scheduled_time: monthlyClosingScheduledTime(year, month),
        status: "failure",
        trigger_type: "manual",
        error_message: err.message?.substring(0, 300),
      });
    } catch (logErr) {
      /* ignore */
    }

    const status =
      err.message.includes("403") || err.message.includes("402") ? 403 : 500;
    res.status(status).json({ error: sanitizeError(err) });
  }
});

/**
 * POST /api/attendance/approval/work-time - Submit single work time correction request
 * Body: { date, clock_in_at, clock_out_at, break_records, reason }
 */
router.post("/approval/work-time", async (req, res) => {
  const { date, clock_in_at, clock_out_at, break_records, reason } = req.body;
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const {
      primaryRouteId,
      fallbackRouteId,
      primaryRouteUserId,
      primaryRouteNeedsApprover,
    } = await findAttendanceRouteIds(client, companyId);
    const routeId = primaryRouteId || fallbackRouteId;

    log.info(
      `Submitting work time correction for ${date} (route=${routeId}, needsApprover=${primaryRouteNeedsApprover})`,
    );

    const body = {
      company_id: parseInt(companyId, 10),
      target_date: date,
    };
    if (routeId) body.approval_flow_route_id = routeId;

    // Some routes require specifying an approver (e.g. "承認者を指定" type)
    if (primaryRouteNeedsApprover && routeId === primaryRouteId) {
      if (primaryRouteUserId) {
        body.approver_id = primaryRouteUserId;
      } else {
        // Fall back to self (admin users can self-approve)
        try {
          const me = await client.apiRequest("GET", "/users/me");
          body.approver_id = me.id;
        } catch {
          /* ignore */
        }
      }
    }

    // Approval API uses work_records array with time-only "HH:MM" format
    if (clock_in_at || clock_out_at) {
      const workRecord = {};
      if (clock_in_at) workRecord.clock_in_at = toTimeOnly(clock_in_at);
      if (clock_out_at) workRecord.clock_out_at = toTimeOnly(clock_out_at);
      body.work_records = [workRecord];
    }
    if (break_records && break_records.length > 0) {
      body.break_records = break_records.map((br) => ({
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

    const requestId = result?.work_time?.id || result?.id || null;
    log.info(`Work time correction request submitted (id=${requestId})`);

    try {
      insertLog({
        action_type: "approval_submitted",
        scheduled_time: date,
        status: "success",
        trigger_type: "manual",
        error_message: `id=${requestId}`,
      });
    } catch (logErr) {
      /* ignore log failures */
    }

    res.json({ success: true, id: requestId, result });
  } catch (err) {
    log.error(`Work time correction failed: ${err.message}`);

    try {
      insertLog({
        action_type: "approval_submitted",
        scheduled_time: req.body.date,
        status: "failure",
        trigger_type: "manual",
        error_message: err.message?.substring(0, 300),
      });
    } catch (logErr) {
      /* ignore log failures */
    }

    const status =
      err.message.includes("403") || err.message.includes("402") ? 403 : 500;
    res.status(status).json({ error: sanitizeError(err) });
  }
});

// ===================================================================
//  Approval Request Tracking — list, view, withdraw
// ===================================================================

/**
 * GET /api/attendance/approval-requests - Fetch approval requests across all 5 types
 * Query: year, month (calendar month)
 * Returns: { requests: [{ id, type, status, target_date, ..., comment, created_at }] }
 *
 * Queries freee API across 5 approval request types:
 *   work_times, paid_holidays, overtime_works, special_holidays, monthly_attendances
 * For each type, queries across statuses: in_progress (pending), approved, feedback (rejected)
 */
router.get("/approval-requests", async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) {
    return res.status(400).json({ error: "year and month are required" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;

    const allRequests = [];
    const statuses = ["in_progress", "approved", "feedback"];

    // All 5 approval request types to query
    const approvalTypes = [
      { endpoint: "work_times", type: "WorkTime", responseKey: "work_times" },
      {
        endpoint: "paid_holidays",
        type: "PaidHoliday",
        responseKey: "paid_holidays",
      },
      {
        endpoint: "overtime_works",
        type: "OvertimeWork",
        responseKey: "overtime_works",
      },
      {
        endpoint: "special_holidays",
        type: "SpecialHoliday",
        responseKey: "special_holidays",
      },
      {
        endpoint: "monthly_attendances",
        type: "MonthlyAttendance",
        responseKey: "monthly_attendances",
      },
    ];

    for (const approvalType of approvalTypes) {
      for (const status of statuses) {
        try {
          const data = await client.apiRequest(
            "GET",
            `/approval_requests/${approvalType.endpoint}?company_id=${companyId}&status=${status}`,
          );
          // freee API returns the type-specific array (e.g., work_times, paid_holidays)
          const requests =
            data[approvalType.responseKey] || data.approval_requests || [];
          for (const req of requests) {
            // Filter to target month
            if (req.target_date && req.target_date.startsWith(monthPrefix)) {
              const entry = {
                id: req.id,
                type: approvalType.type,
                status: req.status || status,
                target_date: req.target_date,
                comment: req.comment || "",
                request_number: req.application_number
                  ? String(req.application_number)
                  : null,
                created_at: req.issue_date || null,
              };

              // Type-specific fields
              if (approvalType.type === "WorkTime") {
                entry.work_records = (req.work_records || []).map((wr) => ({
                  clock_in_at: wr.clock_in_at || null,
                  clock_out_at: wr.clock_out_at || null,
                }));
                entry.break_records = (req.break_records || []).map((br) => ({
                  clock_in_at: br.clock_in_at || null,
                  clock_out_at: br.clock_out_at || null,
                }));
              } else if (approvalType.type === "PaidHoliday") {
                entry.holiday_type = req.holiday_type || "full";
                entry.start_time = req.start_time || null;
                entry.end_time = req.end_time || null;
              } else if (approvalType.type === "OvertimeWork") {
                entry.start_time = req.start_time || null;
                entry.end_time = req.end_time || null;
              }

              allRequests.push(entry);
            }
          }
        } catch (err) {
          // 403/402 means plan restriction — silently skip
          const errMsg = err.message || "";
          if (errMsg.includes("403") || errMsg.includes("402")) {
            log.debug(
              `${approvalType.endpoint}/${status}: plan restricted, skipping`,
            );
          } else {
            log.warn(
              `Failed to fetch ${approvalType.endpoint} with status=${status}: ${errMsg.substring(0, 100)}`,
            );
          }
        }
      }
    }

    log.info(
      `Fetched ${allRequests.length} approval requests for ${monthPrefix}`,
    );
    res.json({ requests: allRequests });
  } catch (err) {
    log.error(`Failed to fetch approval requests: ${err.message}`);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

/**
 * DELETE /api/attendance/approval-requests/:id - Withdraw/cancel an approval request
 * Query: type (optional) — 'WorkTime' | 'PaidHoliday' | 'OvertimeWork' | 'SpecialHoliday' | 'MonthlyAttendance'
 *        Defaults to 'WorkTime' for backward compatibility.
 *
 * freee API behavior:
 *   - DELETE only works for draft/pending requests, NOT in_progress ones
 *   - For in_progress requests, use POST /actions with { approval_action: 'cancel' }
 *   - We try cancel first, then fall back to DELETE
 */
router.delete("/approval-requests/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid request ID" });
  }
  const requestType = req.query.type || "WorkTime";

  const endpoint = TYPE_TO_ENDPOINT[requestType];
  if (!endpoint) {
    return res.status(400).json({
      error: `Invalid type. Valid: ${Object.keys(TYPE_TO_ENDPOINT).join(", ")}`,
    });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const responseKey = TYPE_TO_RESPONSE_KEY[requestType];

    // First, try to get the request details to know its current state
    let requestData;
    try {
      requestData = await client.apiRequest(
        "GET",
        `/approval_requests/${endpoint}/${id}?company_id=${companyId}`,
      );
    } catch {
      /* ignore, proceed with cancel attempt */
    }

    const detail = requestData?.[responseKey] || requestData;
    const currentStep = detail?.current_step_id;
    const currentRound = detail?.current_round || 1;

    // Try cancel action first (works for in_progress requests)
    try {
      const cancelBody = {
        approval_action: "cancel",
        target_round: currentRound,
        target_step_id: currentStep,
      };
      await client.apiRequest(
        "POST",
        `/approval_requests/${endpoint}/${id}/actions?company_id=${companyId}`,
        cancelBody,
      );
      log.info(`Approval request ${id} (${requestType}) cancelled via action`);
      return res.json({
        success: true,
        id: parseInt(id, 10),
        type: requestType,
        method: "cancel",
      });
    } catch (cancelErr) {
      log.info(
        `Cancel action failed for ${id} (${requestType}): ${cancelErr.message}, trying DELETE...`,
      );
    }

    // Fallback 2: try DELETE (works for draft/pending requests)
    try {
      await client.apiRequest(
        "DELETE",
        `/approval_requests/${endpoint}/${id}?company_id=${companyId}`,
      );
      log.info(`Approval request ${id} (${requestType}) withdrawn via DELETE`);
      return res.json({
        success: true,
        id: parseInt(id, 10),
        type: requestType,
        method: "delete",
      });
    } catch (deleteErr) {
      log.info(
        `DELETE also failed for ${id} (${requestType}): ${deleteErr.message}, trying Playwright web fallback...`,
      );
    }

    // Fallback 3: Playwright web automation (取下げ button on freee web)
    // This handles cases where API fails due to dept/position routing restrictions
    if (hasWebCredentials()) {
      try {
        const webResult = await withdrawApprovalRequestWeb(requestType, id);
        if (webResult.success) {
          log.info(
            `Approval request ${id} (${requestType}) withdrawn via Playwright web`,
          );
          return res.json({
            success: true,
            id: parseInt(id, 10),
            type: requestType,
            method: "web_withdraw",
          });
        }
        log.warn(`Playwright withdrawal failed for ${id}: ${webResult.error}`);
      } catch (webErr) {
        log.error(`Playwright withdrawal error for ${id}: ${webErr.message}`);
      }
    } else {
      log.warn(
        `Cannot fallback to Playwright — web credentials not configured`,
      );
    }

    // All methods exhausted
    log.error(`All withdrawal methods failed for ${id} (${requestType})`);
    res.status(500).json({
      error:
        "Failed to withdraw approval request via API and web automation. Please withdraw manually on freee.",
    });
  } catch (err) {
    log.error(
      `Failed to withdraw approval request ${id} (${requestType}): ${err.message}`,
    );
    res.status(500).json({
      error: "Failed to withdraw approval request. Please try again.",
    });
  }
});

export default router;
