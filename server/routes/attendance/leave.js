import { checkpointTaskResult, beginTaskItem, updateTask, trackTaskPromise } from "../../async-tasks.js";
import { isEditableWorkRecord } from "../../work-record-status.js";
import { Router } from "express";
import {
  getSetting,
  getStrategyCache,
  insertLog,
  setStrategyCache,
} from "../../db.js";
import {
  captureOAuthIdentityBinding,
  FreeeApiClient,
} from "../../freee-api.js";
import { todayStringInTz } from "../../timezone.js";
import {
  hasWebCredentials,
  submitLeaveRequest as submitLeaveRequestWeb,
} from "../../automation/index.js";
import { captureWebAccountBinding } from "../../automation/identity.js";
import {
  LeaveValidationError,
  isValidDateString,
  normalizeBatchLeaveRequest,
  normalizeLeaveRequest,
} from "./leave-policy.js";
import {
  listSpecialHolidayOptions,
  submitLeaveForDate,
} from "./leave-service.js";
import {
  captureOperationIdentity,
  acceptBatchTask,
  findAttendanceRouteIds,
  log,
  requireOAuth,
  sanitizeError,
} from "./utils.js";

const router = Router();

const CLIENT_ERROR_MESSAGES = Object.freeze({
  approval_request_failed: "The leave approval request was rejected.",
  direct_write_failed: "The leave record could not be updated.",
  existing_leave_requires_web_confirmation:
    "Existing leave on this date must be reviewed in freee Web.",
  mutation_outcome_unconfirmed:
    "The previous write may have succeeded. Check freee before retrying.",
  special_holiday_setting_required:
    "Select an available special holiday setting.",
  special_holiday_lookup_failed:
    "The available special holiday settings could not be verified.",
  web_confirmation_required: "This leave combination must be reviewed in freee Web.",
  web_credentials_required: "freee Web credentials are required.",
  web_form_fields_unsupported:
    "This leave subtype must be submitted directly in freee Web.",
  web_submission_failed: "The freee Web submission could not be confirmed.",
  work_record_precheck_failed:
    "The target work record could not be verified. No request was submitted.",
});

function optionalOAuth() {
  if (getSetting("oauth_configured") !== "1") return null;
  try {
    return captureOAuthIdentityBinding();
  } catch {
    const error = new LeaveValidationError(
      "Stored OAuth company or employee selection is invalid",
      "OAUTH_ACCOUNT_SELECTION_INVALID",
    );
    throw error;
  }
}

function captureExpectedWebCompany(oauth) {
  if (oauth) return oauth;
  return Object.freeze({
    kind: "web",
    webBinding: captureWebAccountBinding(),
  });
}

function createSubmissionContext(oauth, expectedWebCompany) {
  const client = oauth
    ? new FreeeApiClient({ identityBinding: oauth })
    : null;
  let apiReadyPromise = null;
  let routeInfoPromise = null;
  return {
    oauth,
    client,
    webCredentialsAvailable: hasWebCredentials(),
    submitWeb: (type, date, options) =>
      submitLeaveRequestWeb(type, date, options, expectedWebCompany),
    ensureApiReady() {
      if (!apiReadyPromise) apiReadyPromise = client.ensureValidToken();
      return apiReadyPromise;
    },
    getRouteInfo() {
      if (!routeInfoPromise) {
        routeInfoPromise = findAttendanceRouteIds(client, oauth.companyId);
      }
      return routeInfoPromise;
    },
  };
}

function logLeaveResult(result, triggerType, operationIdentity) {
  try {
    insertLog({
      action_type: "leave_request",
      scheduled_time: result.date,
      status: result.success ? "success" : "failure",
      trigger_type: triggerType,
      error_message: result.success
        ? `type=${result.type} method=${result.method}`
        : `type=${result.type} method=${result.method} code=${result.error}`,
      identity_key: operationIdentity.identityKey,
      company_id: operationIdentity.companyId,
      company_name: operationIdentity.companyName,
    });
  } catch {
    // Execution logging must not change the request outcome.
  }
}

function failureStatus(code) {
  if (
    [
      "existing_leave_requires_web_confirmation",
      "special_holiday_setting_required",
      "web_confirmation_required",
      "web_credentials_required",
      "web_form_fields_unsupported",
    ].includes(code)
  ) {
    return 409;
  }
  if (code === "work_record_precheck_failed") return 503;
  return 502;
}

function clientFailure(result) {
  return {
    error: CLIENT_ERROR_MESSAGES[result.error] || "Leave request failed.",
    code: result.error,
    method: result.method,
    stages: result.stages,
  };
}

// Probe the correction strategies that do not mutate attendance data.
router.post("/detect-strategy", async (req, res) => {
  const { force } = req.body || {};
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;
  const operationIdentity = captureOperationIdentity(oauth);
  const now = new Date();
  const today = todayStringInTz(now);
  const currentMonth = today.slice(0, 7);

  if (!force) {
    const cached = getStrategyCache(currentMonth, operationIdentity.identityKey);
    if (cached) {
      const bestStrategy = ["direct", "approval", "web"].includes(
        cached.best_strategy,
      )
        ? cached.best_strategy
        : "web";
      return res.json({
        month: currentMonth,
        direct_ok: !!cached.direct_ok,
        approval_ok: !!cached.approval_ok,
        time_clock_ok: false,
        best_strategy: bestStrategy,
        detected_at: cached.detected_at,
        cached: true,
        web_credentials_configured: hasWebCredentials(),
      });
    }
  }

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();
    let directOk = false;
    let approvalOk = false;

    try {
      const record = await client.apiRequest(
        "GET",
        `/employees/${employeeId}/work_records/${today}?company_id=${companyId}`,
      );
      directOk = isEditableWorkRecord(record, today);
    } catch (error) {
      log.info("Strategy probe could not verify direct work-record editing", {
        code: error?.code || "DIRECT_PROBE_FAILED",
      });
    }

    const routeInfo = await findAttendanceRouteIds(client, companyId);
    approvalOk =
      routeInfo.lookupVerified &&
      !!(routeInfo.primaryRouteId || routeInfo.fallbackRouteId);
    const bestStrategy = directOk ? "direct" : approvalOk ? "approval" : "web";

    setStrategyCache(
      currentMonth,
      {
        direct_ok: directOk,
        approval_ok: approvalOk,
        time_clock_ok: false,
        best_strategy: bestStrategy,
      },
      operationIdentity.identityKey,
    );

    return res.json({
      month: currentMonth,
      direct_ok: directOk,
      approval_ok: approvalOk,
      time_clock_ok: false,
      best_strategy: bestStrategy,
      detected_at: new Date().toISOString(),
      cached: false,
      web_credentials_configured: hasWebCredentials(),
    });
  } catch (error) {
    return res.status(500).json({
      error: sanitizeError(error, "Strategy detection failed"),
    });
  }
});

router.get("/strategy-cache", (req, res) => {
  const currentMonth = todayStringInTz().slice(0, 7);
  const cached = getStrategyCache(currentMonth);
  const bestStrategy = ["direct", "approval", "web"].includes(
    cached?.best_strategy,
  )
    ? cached.best_strategy
    : "web";
  return res.json({
    month: currentMonth,
    cached: !!cached,
    ...(cached
      ? {
          direct_ok: !!cached.direct_ok,
          approval_ok: !!cached.approval_ok,
          time_clock_ok: false,
          best_strategy: bestStrategy,
          detected_at: cached.detected_at,
        }
      : {}),
    web_credentials_configured: hasWebCredentials(),
  });
});

router.get("/special-holiday-options", async (req, res) => {
  const date = req.query.date;
  if (!isValidDateString(date)) {
    return res.status(400).json({ error: "date must be a valid YYYY-MM-DD date" });
  }
  const oauth = requireOAuth(res);
  if (!oauth) return;
  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();
    const options = await listSpecialHolidayOptions(client, oauth, date);
    return res.json({ date, options });
  } catch (error) {
    return res.status(503).json({
      error: sanitizeError(error, "Special holiday settings could not be loaded"),
    });
  }
});

router.post("/leave-request", async (req, res) => {
  let request;
  let oauth;
  let expectedWebCompany;
  let operationIdentity;
  try {
    request = normalizeLeaveRequest(req.body);
    oauth = optionalOAuth();
    expectedWebCompany = captureExpectedWebCompany(oauth);
    operationIdentity = captureOperationIdentity(oauth);
  } catch (error) {
    if (error instanceof LeaveValidationError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const result = await submitLeaveForDate(
    request,
    createSubmissionContext(oauth, expectedWebCompany),
  );
  logLeaveResult(result, "manual", operationIdentity);
  if (result.success) return res.json(result);
  return res.status(failureStatus(result.error)).json(clientFailure(result));
});

router.post("/batch-leave-request", async (req, res) => {
  let requests;
  let oauth;
  let expectedWebCompany;
  let operationIdentity;
  try {
    requests = normalizeBatchLeaveRequest(req.body);
    oauth = optionalOAuth();
    expectedWebCompany = captureExpectedWebCompany(oauth);
    operationIdentity = captureOperationIdentity(oauth);
  } catch (error) {
    if (error instanceof LeaveValidationError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const task = acceptBatchTask(res, "batch_leave", operationIdentity, requests.length);
  if (!task) return;

  const taskPromise = (async () => {
    const context = createSubmissionContext(oauth, expectedWebCompany);
    context.beforeOperation = (request) => beginTaskItem(task, { date: request.date, type: request.type });
    try {
      for (const request of requests) {
        const result = await submitLeaveForDate(request, context);
        checkpointTaskResult(task, result, {
          action_type: "leave_request", scheduled_time: result.date,
          status: result.success ? "success" : "failure", trigger_type: "batch",
          error_message: `task_id=${task.id} | type=${result.type} method=${result.method}${result.error ? ` code=${result.error}` : ""}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      updateTask(task, { status: "completed" });
    } catch (error) {
      log.error("Batch leave task failed", { code: error?.code || "BATCH_LEAVE_FAILED" });
      updateTask(task, {
        status: "failed", code: error?.code === "TASK_PERSISTENCE_FAILED" ? error.code : "BATCH_LEAVE_FAILED",
        error: "Batch leave request stopped before all dates were processed.",
      });
    }
  })();
  void trackTaskPromise(task, taskPromise);
});

export default router;
