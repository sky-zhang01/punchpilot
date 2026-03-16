import crypto from "crypto";
import {
  getSetting,
  getStrategyCache,
  setStrategyCache,
  getAsyncTask,
  createAsyncTask,
  updateAsyncTask,
  cleanOldAsyncTasks,
} from "../../db.js";
import logger from "../../logger.js";

const log = logger.child("Attendance");

// ===================================================================
//  Async Task Store — in-memory store for long-running batch tasks
//  Allows immediate HTTP response + client polling for results.
//  Tasks auto-expire after 30 minutes to prevent memory leaks.
// ===================================================================
const asyncTasks = new Map();
const TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes

function createTask(taskType = "batch") {
  const id = crypto.randomUUID();
  asyncTasks.set(id, { status: "running", createdAt: Date.now() });
  try { createAsyncTask(id, taskType); } catch { /* SQLite write failure is non-fatal */ }
  return id;
}

function updateTask(id, data) {
  const task = asyncTasks.get(id);
  if (task) Object.assign(task, data);
  // Persist final statuses to SQLite for crash recovery
  if (data.status === "completed" || data.status === "failed") {
    const summary = data.succeeded != null ? `${data.succeeded} succeeded, ${data.failed} failed` : null;
    try { updateAsyncTask(id, data.status, summary, data.error || null); } catch { /* non-fatal */ }
  }
}

function getTask(id) {
  const memTask = asyncTasks.get(id);
  if (memTask) return memTask;
  // Fall back to SQLite (survives server restarts)
  try {
    const dbTask = getAsyncTask(id);
    if (dbTask) return {
      status: dbTask.status,
      createdAt: dbTask.created_at,
      completedAt: dbTask.completed_at,
      resultSummary: dbTask.result_summary,
      error: dbTask.error_text,
    };
  } catch { /* SQLite read failure is non-fatal */ }
  return null;
}

// Periodically clean expired tasks (in-memory + SQLite)
setInterval(
  () => {
    const now = Date.now();
    for (const [id, task] of asyncTasks) {
      if (now - task.createdAt > TASK_TTL_MS) asyncTasks.delete(id);
    }
    try { cleanOldAsyncTasks(2); } catch { /* non-fatal */ }
  },
  5 * 60 * 1000,
);

/**
 * Sanitize error messages for client response.
 * Keeps freee API error messages (actionable for user) but strips internal details.
 */
function sanitizeError(err, context = "Operation failed") {
  const msg = err?.message || String(err);
  // Keep freee API errors (they contain actionable info like permission errors)
  if (
    msg.includes("freee") ||
    msg.includes("権限") ||
    msg.includes("認証") ||
    msg.includes("token") ||
    msg.includes("OAuth") ||
    msg.includes("expired") ||
    msg.includes("configured") ||
    msg.includes("balance") ||
    msg.includes("already")
  ) {
    // Strip file paths and stack traces
    return msg
      .replace(/\s*at\s+.*$/gm, "")
      .replace(/\/[^\s:]+\.(js|ts|mjs)/g, "")
      .trim();
  }
  // For unknown errors, return generic message
  log.error(`${context}: ${msg}`);
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
  const companyId = getSetting("oauth_company_id");
  const employeeId = getSetting("oauth_employee_id");
  if (!companyId) {
    res.status(400).json({
      error: "Company not selected. Go to Settings to select a company.",
      code: "COMPANY_NOT_SELECTED",
    });
    return null;
  }
  if (!employeeId) {
    res.status(400).json({
      error:
        "Employee record not found for this company. Please add an employee record in freee HR admin first.",
      code: "EMPLOYEE_NOT_FOUND",
    });
    return null;
  }
  return { companyId, employeeId };
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
    };
  } catch {
    return {
      primaryRouteId: null,
      fallbackRouteId: null,
      primaryRouteUserId: null,
      primaryRouteNeedsApprover: false,
    };
  }
}

// Backward compat wrapper — returns the best single route ID
async function findAttendanceRouteId(client, companyId) {
  const { primaryRouteId, fallbackRouteId } = await findAttendanceRouteIds(
    client,
    companyId,
  );
  return primaryRouteId || fallbackRouteId || null;
}

// Shared constants: Map freee approval request type → API endpoint path and response key
const TYPE_TO_ENDPOINT = {
  WorkTime: "work_times",
  PaidHoliday: "paid_holidays",
  OvertimeWork: "overtime_works",
  SpecialHoliday: "special_holidays",
  MonthlyAttendance: "monthly_attendances",
};

const TYPE_TO_RESPONSE_KEY = {
  WorkTime: "work_time",
  PaidHoliday: "paid_holiday",
  OvertimeWork: "overtime_work",
  SpecialHoliday: "special_holiday",
  MonthlyAttendance: "monthly_attendance",
};

export {
  log,
  asyncTasks,
  TASK_TTL_MS,
  createTask,
  updateTask,
  getTask,
  sanitizeError,
  toFreeeTime,
  toTimeOnly,
  requireOAuth,
  findAttendanceRouteIds,
  findAttendanceRouteId,
  TYPE_TO_ENDPOINT,
  TYPE_TO_RESPONSE_KEY,
};
