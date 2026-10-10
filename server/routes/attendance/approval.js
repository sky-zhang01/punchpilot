import { parseExternalId as positiveInteger } from "../../freee-values.js";
import { Router } from "express";
import { getSetting, insertLog } from "../../db.js";
import { FREEE_ERROR_MESSAGES } from "../../constants.js";
import {
  FREEE_API_ERROR_CODES,
  FreeeApiClient,
} from "../../freee-api.js";
import {
  withdrawApprovalRequestWeb,
  hasWebCredentials,
  submitMonthlyAttendanceClosingWeb,
} from "../../automation/index.js";
import {
  log,
  sanitizeError,
  requireOAuth,
  findAttendanceRouteIds,
  TYPE_TO_ENDPOINT,
  approvalTypeEndpoint,
} from "./utils.js";
import { safeErrorMetadata } from "../../logger.js";
import { withdrawApprovalOperation } from "./approval-operation-service.js";
import {
  approvalRequestInMonth,
  fetchApprovalRequestPages,
  parseApprovalMonth,
} from "./approval-list-service.js";
import { withAccountOperation } from "../../account-operation.js";

const router = Router();

function stableApprovalText(value, maxLength, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function monthlyClosingScheduledTime(year, month) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function parseMonthlyClosingTarget(rawYear, rawMonth) {
  const yearText = String(rawYear ?? "");
  const monthText = String(rawMonth ?? "");
  if (!/^\d{4}$/.test(yearText) || !/^(?:[1-9]|1[0-2])$/.test(monthText)) {
    return null;
  }

  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isSafeInteger(year) || year < 2000) return null;
  return { year, month };
}

function recordMonthlyClosing(year, month, status, errorMessage = null) {
  try {
    insertLog({
      action_type: "monthly_closing",
      scheduled_time: monthlyClosingScheduledTime(year, month),
      status,
      trigger_type: "manual",
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  } catch {
    // A logging failure must not change the submission result.
  }
}

function isMonthlyClosingAlreadySubmitted(err) {
  return (
    err?.code === FREEE_API_ERROR_CODES.MONTHLY_CLOSING_ALREADY_SUBMITTED ||
    err?.message?.includes(
      FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED,
    )
  );
}

function requiresMonthlyClosingWebFallback(err) {
  return (
    err?.code === FREEE_API_ERROR_CODES.WEB_FORM_REQUIRED ||
    err?.code === FREEE_API_ERROR_CODES.PERMISSION_DENIED ||
    err?.message?.includes("役職") ||
    err?.message?.includes("部門") ||
    err?.message?.includes("Webから申請")
  );
}

async function submitMonthlyClosingViaWeb(res, year, month, expectedCompany) {
  let webResult;
  try {
    webResult = await submitMonthlyAttendanceClosingWeb(year, month, expectedCompany);
  } catch {
    webResult = { success: false, error: "web_automation_failed" };
  }

  if (webResult.success) {
    recordMonthlyClosing(year, month, "success");
    return res.json({ success: true, via: "web" });
  }

  const stableError = String(webResult.error || "web_automation_failed");
  log.error(`Monthly closing Web submission failed: ${stableError}`);
  recordMonthlyClosing(year, month, "failure", stableError.substring(0, 100));

  if (stableError === "web_credentials_required") {
    return res.status(400).json({
      error: "Web credentials are required for monthly closing.",
      code: "WEB_CREDENTIALS_REQUIRED",
    });
  }
  if (stableError === "web_credentials_invalid") {
    return res.status(401).json({
      error: "Web credentials are invalid. Update freee web credentials.",
      code: "WEB_CREDENTIALS_INVALID",
    });
  }
  if (stableError === "web_login_interaction_required") {
    return res.status(409).json({
      error: "freee requires interactive Web login verification.",
      code: "WEB_LOGIN_INTERACTION_REQUIRED",
    });
  }
  if (stableError === "web_company_target_required") {
    return res.status(400).json({
      error: "Configure the exact freee company name before using Web automation.",
      code: "WEB_COMPANY_TARGET_REQUIRED",
    });
  }
  if (stableError === "web_company_selection_unconfirmed") {
    return res.status(409).json({
      error: "The configured freee company could not be confirmed.",
      code: "WEB_COMPANY_SELECTION_UNCONFIRMED",
    });
  }

  return res.status(502).json({
    error: "Monthly closing could not be confirmed from freee Web.",
    code: webResult.errorCode || "WEB_FALLBACK_FAILED",
  });
}

// ===================================================================
//  Approval Requests — individual operations (kept for single-use)
// ===================================================================

/**
 * POST /api/attendance/approval/monthly - Submit monthly attendance closing request
 * Body: { year, month }
 */
router.post("/approval/monthly", async (req, res) => {
  const target = parseMonthlyClosingTarget(req.body?.year, req.body?.month);
  if (!target) {
    return res.status(400).json({
      error: "year must be four digits and month must be between 1 and 12",
      code: "INVALID_MONTHLY_TARGET",
    });
  }
  const { year, month } = target;

  return withAccountOperation(async () => {

  if (getSetting("oauth_configured") !== "1") {
    if (!hasWebCredentials()) {
      return res.status(400).json({
        error: "OAuth or Web credentials are required for monthly closing.",
        code: "MONTHLY_CLOSING_CREDENTIALS_REQUIRED",
      });
    }
    return submitMonthlyClosingViaWeb(res, year, month, null);
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();

    const routeInfo = await findAttendanceRouteIds(client, companyId);
    const routeId = positiveInteger(
      routeInfo.primaryRouteId || routeInfo.fallbackRouteId,
    );
    const routeNeedsApprover =
      positiveInteger(routeInfo.primaryRouteId) === routeId &&
      routeInfo.primaryRouteNeedsApprover === true;
    const approverId = positiveInteger(routeInfo.primaryRouteUserId);

    if (!routeInfo.lookupVerified || !routeId || (routeNeedsApprover && !approverId)) {
      if (!hasWebCredentials()) {
        recordMonthlyClosing(
          year,
          month,
          "failure",
          "approval_route_unconfirmed",
        );
        return res.status(409).json({
          error:
            "The monthly closing approval route could not be confirmed. Configure freee Web credentials or review the route in freee.",
          code: "APPROVAL_ROUTE_UNCONFIRMED",
        });
      }
      return submitMonthlyClosingViaWeb(res, year, month, oauth);
    }

    log.info(
      `Submitting monthly attendance closing for ${year}-${String(month).padStart(2, "0")}`,
    );

    const body = {
      company_id: parseInt(companyId, 10),
      target_year: year,
      target_month: month,
    };
    body.approval_flow_route_id = routeId;
    if (approverId) body.approver_id = approverId;

    const result = await client.apiRequest(
      "POST",
      "/approval_requests/monthly_attendances",
      body,
    );

    const requestId = positiveInteger(
      result?.monthly_attendance?.id || result?.id,
    );
    if (!requestId) {
      recordMonthlyClosing(
        year,
        month,
        "failure",
        "api_response_unconfirmed",
      );
      return res.status(502).json({
        error:
          "The monthly closing may have been submitted. Check freee before retrying.",
        code: "API_RESPONSE_UNCONFIRMED",
      });
    }

    log.info("Monthly attendance closing request submitted");

    recordMonthlyClosing(year, month, "success");

    res.json({ success: true, via: "api", id: requestId });
  } catch (err) {
    log.error(
      `Monthly closing API failed: ${err?.code || "UNCLASSIFIED_API_ERROR"}`,
    );

    if (isMonthlyClosingAlreadySubmitted(err)) {
      log.info("Monthly attendance closing already submitted");
      recordMonthlyClosing(year, month, "success");
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
      recordMonthlyClosing(
        year,
        month,
        "failure",
        "web_credentials_required",
      );
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
      return submitMonthlyClosingViaWeb(res, year, month, oauth);
    }

    recordMonthlyClosing(
      year,
      month,
      "failure",
      String(err?.code || "api_action_failed").substring(0, 100),
    );

    const status =
      err?.code === FREEE_API_ERROR_CODES.PERMISSION_DENIED ||
      err?.message?.includes("403") ||
      err?.message?.includes("402")
        ? 403
        : 500;
    res.status(status).json({ error: sanitizeError(err) });
  }
  });
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
  const range = parseApprovalMonth(req.query.year, req.query.month);
  if (!range) {
    return res.status(400).json({
      error: "year and month must identify a valid month",
    });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();
    const me = await client.apiRequest("GET", "/users/me");
    const currentUserId = positiveInteger(me?.id);
    if (!currentUserId) {
      return res.status(503).json({ error: "The OAuth user could not be confirmed." });
    }

    const requestsByKey = new Map();
    const unavailableQueries = [];
    const statuses = ["in_progress", "approved", "feedback"];

    for (const type of Object.keys(TYPE_TO_ENDPOINT)) {
      for (const status of statuses) {
        try {
          const pageResult = await fetchApprovalRequestPages({
            client,
            companyId,
            type,
            status,
            range,
            applicantId: currentUserId,
          });
          if (!pageResult.complete) unavailableQueries.push(`${type}:${status}`);
          for (const item of pageResult.items) {
            const id = positiveInteger(item?.id);
            if (
              !id ||
              positiveInteger(item?.company_id) !== Number(companyId) ||
              positiveInteger(item?.applicant_id) !== currentUserId ||
              item?.status !== status ||
              !approvalRequestInMonth(item, range)
            ) {
              continue;
            }
            const entry = {
              id,
              type,
              status,
              target_date:
                item.target_date ||
                `${item.target_year}-${String(item.target_month).padStart(2, "0")}`,
              comment: stableApprovalText(item.comment, 255),
              request_number: positiveInteger(item.application_number)
                ? String(item.application_number)
                : null,
              created_at: item.issue_date || null,
            };

            if (type === "WorkTime") {
              entry.work_records = (item.work_records || []).slice(0, 20).map((record) => ({
                clock_in_at: record?.clock_in_at || null,
                clock_out_at: record?.clock_out_at || null,
              }));
              entry.break_records = (item.break_records || []).slice(0, 20).map((record) => ({
                clock_in_at: record?.clock_in_at || null,
                clock_out_at: record?.clock_out_at || null,
              }));
            } else if (type === "PaidHoliday") {
              entry.holiday_type = item.values?.[0]?.type || item.holiday_type || "full";
              entry.start_time = item.values?.[0]?.start_at || item.start_at || null;
              entry.end_time = item.values?.[0]?.end_at || item.end_at || null;
            } else if (type === "OvertimeWork") {
              entry.start_time = item.start_at || null;
              entry.end_time = item.end_at || null;
            }
            requestsByKey.set(`${type}:${id}`, entry);
          }
        } catch (err) {
          unavailableQueries.push(`${type}:${status}`);
          log.warn("Approval request query could not be verified", {
            type,
            requestStatus: status,
            code: err?.code || "APPROVAL_LIST_FAILED",
          });
        }
      }
    }

    const requests = [...requestsByKey.values()].sort((a, b) =>
      (b.created_at || "").localeCompare(a.created_at || ""),
    );
    if (
      unavailableQueries.length ===
        Object.keys(TYPE_TO_ENDPOINT).length * statuses.length &&
      requests.length === 0
    ) {
      return res.status(503).json({
        error: "Approval requests could not be verified.",
      });
    }
    return res.json({
      requests,
      complete: unavailableQueries.length === 0,
      unavailable_queries: unavailableQueries,
    });
  } catch (err) {
    log.error("Failed to fetch approval requests", {
      error: safeErrorMetadata(err),
    });
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
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({ error: "Invalid request ID" });
  }
  const requestType = req.query.type || "WorkTime";

  const endpoint = approvalTypeEndpoint(requestType);
  if (!endpoint) {
    return res.status(400).json({
      error: `Invalid type. Valid: ${Object.keys(TYPE_TO_ENDPOINT).join(", ")}`,
    });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();
    const me = await client.apiRequest("GET", "/users/me");
    const currentUserId = positiveInteger(me?.id);
    if (!currentUserId) {
      return res.status(503).json({
        error: "The OAuth user could not be confirmed.",
        code: "OAUTH_USER_UNCONFIRMED",
      });
    }
    const result = await withAccountOperation(() => withdrawApprovalOperation({
      client,
      companyId,
      currentUserId,
      id: Number(id),
      type: requestType,
      webCredentialsAvailable: hasWebCredentials(),
      withdrawWeb: (type, requestId) =>
        withdrawApprovalRequestWeb(type, requestId, oauth),
    }));
    if (result.success) return res.json(result);
    const status = result.error === "mutation_outcome_unconfirmed" ? 502 : 409;
    return res.status(status).json({
      error:
        result.error === "mutation_outcome_unconfirmed"
          ? "The withdrawal may have succeeded. Check freee before retrying."
          : "The approval request could not be withdrawn automatically.",
      code: result.error,
      stages: result.stages,
    });
  } catch (err) {
    log.error("Approval request withdrawal failed", {
      error: safeErrorMetadata(err),
    });
    res.status(500).json({
      error: "Failed to withdraw approval request. Please try again.",
    });
  }
});

export default router;
