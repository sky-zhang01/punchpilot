import {
  currentExecutionLogIdentityKey,
  getSetting,
} from "../../db.js";
import logger, { safeErrorMetadata } from "../../logger.js";
import {
  captureOAuthIdentityBinding,
  FREEE_AUTH_ERROR_CODES,
} from "../../freee-api.js";

import { createTask } from "../../async-tasks.js";

const log = logger.child("Attendance");

function captureOperationIdentity(oauth = null) {
  let companyId = "";
  let companyName = "";
  if (oauth) {
    const current = captureOAuthIdentityBinding();
    if (
      oauth.generation !== current.generation ||
      oauth.companyId !== current.companyId ||
      oauth.employeeId !== current.employeeId ||
      oauth.companyName !== current.companyName
    ) {
      const error = new Error(
        "The selected freee OAuth identity changed during the operation.",
      );
      error.code = FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED;
      throw error;
    }
    companyId = current.companyId;
    companyName = current.companyName;
  } else if ((getSetting("connection_mode") || "api") === "api") {
    companyId = getSetting("oauth_company_id") || "";
    companyName = getSetting("oauth_company_name") || "";
  } else {
    companyName = getSetting("web_company_name") || "";
  }

  return Object.freeze({
    identityKey: currentExecutionLogIdentityKey(),
    companyId,
    companyName,
  });
}

/** Admit only a durable task, then acknowledge the asynchronous request. */
function acceptBatchTask(res, taskType, identity, total) {
  try {
    const task = createTask(taskType, identity, total);
    res.json({ task_id: task.id, status: "running" });
    return task;
  } catch (error) {
    log.error("Batch admission failed", { error: safeErrorMetadata(error) });
    res.status(503).json({ error: "The task could not be saved. No operation was started.", code: "TASK_PERSISTENCE_FAILED" });
    return null;
  }
}

/**
 * Sanitize error messages for client response.
 * Keeps freee API error messages (actionable for user) but strips internal details.
 */
const CLIENT_ERROR_BY_CODE = {
  AUTH_REQUIRED: "OAuth authorization is required.",
  AUTH_TRANSIENT: "OAuth verification is temporarily unavailable.",
  PERMISSION_DENIED: "freee API permission was denied.",
  RATE_LIMITED: "freee API rate limit was reached. Try again later.",
  API_TRANSIENT: "freee API is temporarily unavailable.",
  API_RESPONSE_UNCONFIRMED: "The freee API result could not be confirmed.",
  MONTHLY_CLOSING_ALREADY_SUBMITTED:
    "Monthly attendance closing was already submitted.",
  WEB_ONLY_LEAVE_COMBINATION:
    "This leave combination must be confirmed in freee Web.",
  WEB_FORM_REQUIRED: "This operation must be completed through freee Web.",
  WEB_CREDENTIALS_NOT_CONFIGURED: "freee Web credentials are required.",
  WEB_LOGIN_FAILED: "freee Web credentials were rejected.",
  WEB_LOGIN_INTERACTION_REQUIRED:
    "freee Web requires interactive login verification.",
};

function sanitizeError(err, context = "Operation failed") {
  const clientMessage = CLIENT_ERROR_BY_CODE[err?.code];
  if (clientMessage) return clientMessage;
  log.error(context, { error: safeErrorMetadata(err) });
  return context;
}

/**
 * Convert ISO 8601 or any datetime string to freee API format: "YYYY-MM-DD HH:MM:SS"
 * Input examples: "2026-02-03T10:00:00+09:00", "2026-02-03T10:00:00"
 * Output: "2026-02-03 10:00:00"
 */
function toFreeeTime(isoStr, datePrefix) {
  if (!isoStr) return null;
  // Already in freee format "YYYY-MM-DD HH:MM:SS"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(isoStr)) return isoStr;
  // ISO 8601 → extract date and time parts
  const match = isoStr.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/,
  );
  if (match) {
    const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
    return `${match[1]} ${time}`;
  }
  // Time-only input "HH:MM" or "HH:MM:SS" — prepend date if provided
  if (datePrefix && /^\d{2}:\d{2}(:\d{2})?$/.test(isoStr)) {
    const time = isoStr.length === 5 ? `${isoStr}:00` : isoStr;
    return `${datePrefix} ${time}`;
  }
  return isoStr;
}

/**
 * Extract time-only portion "HH:MM" from any datetime format.
 * Used by the approval API which requires "HH:MM" or "HH:MM:SS" format.
 *
 * Input examples:
 *   "2026-02-03T10:00:00+09:00" → "10:00"
 *   "2026-02-03 10:00:00"       → "10:00"
 *   "10:00"                     → "10:00"
 *   "10:00:00"                  → "10:00"
 */
function toTimeOnly(isoStr) {
  if (!isoStr) return null;
  // Already time-only "HH:MM" or "HH:MM:SS"
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(isoStr)) return isoStr.substring(0, 5);
  // ISO 8601 or freee format — extract HH:MM
  const match = isoStr.match(/[T ](\d{2}:\d{2})/);
  if (match) return match[1];
  return isoStr;
}

/**
 * Helper: Validate OAuth is configured and return companyId + employeeId
 */
function requireOAuth(res) {
  if (getSetting("oauth_configured") !== "1") {
    res.status(400).json({
      error: "OAuth not configured. Go to Settings to configure API (OAuth2).",
    });
    return null;
  }
  try {
    return captureOAuthIdentityBinding();
  } catch (error) {
    if (error?.code === FREEE_AUTH_ERROR_CODES.COMPANY_SELECTION_REQUIRED) {
      res.status(400).json({
        error: "Company not selected. Go to Settings to select a company.",
        code: "COMPANY_NOT_SELECTED",
      });
      return null;
    }
    res.status(400).json({
      error: "Stored OAuth company or employee selection is invalid.",
      code: "OAUTH_ACCOUNT_SELECTION_INVALID",
    });
    return null;
  }
}

/**
 * Helper: Find approval routes for attendance workflow.
 * Returns { primaryRouteId, fallbackRouteId } where:
 *   - primaryRouteId: the AttendanceWorkflow-specific route (may use dept/position conditions)
 *   - fallbackRouteId: a system-defined route without dept/position conditions ("指定なし")
 *
 * Some companies configure AttendanceWorkflow routes with dept/position-based approvers,
 * which the freee API doesn't support (returns "役職、部門を利用する申請はWebから申請してください").
 * In that case, we fall back to the generic system route.
 */
async function findAttendanceRouteIds(client, companyId) {
  try {
    const data = await client.apiRequest(
      "GET",
      `/approval_flow_routes?company_id=${companyId}`,
    );
    const routes = data.approval_flow_routes || [];

    // Primary: route specifically configured for AttendanceWorkflow
    const attendanceRoute = routes.find(
      (r) => r.usages && r.usages.includes("AttendanceWorkflow"),
    );
    const primaryRouteId = attendanceRoute ? attendanceRoute.id : null;
    const primaryRouteUserId = attendanceRoute ? attendanceRoute.user_id : null;
    // Some routes require specifying an approver (e.g. "承認者を指定" type routes)
    const primaryRouteNeedsApprover = attendanceRoute
      ? (attendanceRoute.name || "").includes("指定") &&
        !attendanceRoute.user_id
      : false;

    // Fallback: system-defined route with no usage restrictions (typically "指定なし")
    const systemRoute = routes.find(
      (r) =>
        r.definition_system === true && (!r.usages || r.usages.length === 0),
    );
    const fallbackRouteId = systemRoute ? systemRoute.id : null;

    return {
      primaryRouteId,
      fallbackRouteId,
      primaryRouteUserId,
      primaryRouteNeedsApprover,
      lookupVerified: true,
      lookupErrorCode: null,
    };
  } catch (error) {
    return {
      primaryRouteId: null,
      fallbackRouteId: null,
      primaryRouteUserId: null,
      primaryRouteNeedsApprover: false,
      lookupVerified: false,
      lookupErrorCode: error?.code || "APPROVAL_ROUTE_LOOKUP_FAILED",
    };
  }
}

const APPROVAL_TYPE_DEFINITIONS = Object.freeze([
  Object.freeze({ type: "WorkTime", endpoint: "work_times", responseKey: "work_time" }),
  Object.freeze({ type: "PaidHoliday", endpoint: "paid_holidays", responseKey: "paid_holiday" }),
  Object.freeze({ type: "OvertimeWork", endpoint: "overtime_works", responseKey: "overtime_work" }),
  Object.freeze({ type: "SpecialHoliday", endpoint: "special_holidays", responseKey: "special_holiday" }),
  Object.freeze({ type: "MonthlyAttendance", endpoint: "monthly_attendances", responseKey: "monthly_attendance" }),
]);

// Read-only compatibility tables for callers that iterate supported types.
const TYPE_TO_ENDPOINT = Object.freeze(Object.fromEntries(
  APPROVAL_TYPE_DEFINITIONS.map(({ type, endpoint }) => [type, endpoint]),
));
const TYPE_TO_RESPONSE_KEY = Object.freeze(Object.fromEntries(
  APPROVAL_TYPE_DEFINITIONS.map(({ type, responseKey }) => [type, responseKey]),
));

function approvalTypeDefinition(type) {
  return APPROVAL_TYPE_DEFINITIONS.find((definition) => definition.type === type) || null;
}

function approvalTypeEndpoint(type) {
  return approvalTypeDefinition(type)?.endpoint || null;
}

function approvalTypeResponseKey(type) {
  return approvalTypeDefinition(type)?.responseKey || null;
}

export {
  log,
  captureOperationIdentity,
  acceptBatchTask,
  sanitizeError,
  toFreeeTime,
  toTimeOnly,
  requireOAuth,
  findAttendanceRouteIds,
  TYPE_TO_ENDPOINT,
  TYPE_TO_RESPONSE_KEY,
  approvalTypeEndpoint,
  approvalTypeResponseKey,
};
