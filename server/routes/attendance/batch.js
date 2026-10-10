import { parseExternalId as positiveInteger } from "../../freee-values.js";
import { Router } from "express";
import { getStrategyCache, setStrategyCache } from "../../db.js";
import { beginTaskItem, clearTaskItem, checkpointTaskResult, updateTask, getTask, trackTaskPromise } from "../../async-tasks.js";
import { isDateString } from "../../../shared/date-time.js";
import { todayStringInTz } from "../../timezone.js";
import {
  FREEE_API_ERROR_CODES,
  FreeeApiClient,
} from "../../freee-api.js";
import { safeErrorMetadata } from "../../logger.js";
import {
  getWorkRecordNonWorkingDayStatus,
  hasWorkRecordClockTimes,
  workRecordMatchesDate,
} from "../../work-record-status.js";
import {
  submitWebCorrections,
  hasWebCredentials,
} from "../../automation/index.js";
import {
  log,
  captureOperationIdentity,
  acceptBatchTask,
  sanitizeError,
  toFreeeTime,
  toTimeOnly,
  requireOAuth,
  findAttendanceRouteIds,
} from "./utils.js";
import {
  fetchApprovalRequestPages,
  parseApprovalMonth,
} from "./approval-list-service.js";
import {
  acquireAccountOperation,
  releaseAccountOperation,
} from "../../account-operation.js";

const router = Router();

const DIRECT_WEB_FALLBACK_ERROR_CODES = new Set([
  FREEE_API_ERROR_CODES.DIRECT_EDIT_DISABLED,
  FREEE_API_ERROR_CODES.PERMISSION_DENIED,
]);

const APPROVAL_WEB_FALLBACK_ERROR_CODES = new Set([
  FREEE_API_ERROR_CODES.PERMISSION_DENIED,
  FREEE_API_ERROR_CODES.WEB_FORM_REQUIRED,
]);

const UNKNOWN_WEB_RESULT_CODES = new Set([
  "web_result_unconfirmed", "web_form_submission_unconfirmed",
  "web_account_identity_changed_outcome_unknown", "web_automation_outcome_unknown",
  "web_automation_failed", "web_automation_paused_after_unconfirmed_outcome",
]);

function isValidEntryTime(value, date) {
  if (typeof value !== "string") return false;
  const normalized = toFreeeTime(value, date);
  const match = normalized?.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  );
  return !!match &&
    match[1] === date &&
    Number(match[2]) <= 23 &&
    Number(match[3]) <= 59 &&
    Number(match[4]) <= 59;
}

function entryTimeSeconds(value, date) {
  const normalized = toFreeeTime(value, date);
  const match = normalized?.match(/ (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function evaluateExistingRecord(record, date) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !workRecordMatchesDate(record, date)
  ) {
    return { confirmed: false, blocked: false, reason: null, editable: false };
  }

  const nonWorkingStatus = getWorkRecordNonWorkingDayStatus(record);
  if (!nonWorkingStatus.confirmed) {
    return { confirmed: false, blocked: false, reason: null, editable: false };
  }
  if (nonWorkingStatus.isNonWorkingDay) {
    return {
      confirmed: true,
      blocked: true,
      reason: "already_non_working_day",
      editable: false,
    };
  }
  if (hasWorkRecordClockTimes(record)) {
    return {
      confirmed: true,
      blocked: true,
      reason: "already_has_work_record",
      editable: false,
    };
  }
  return {
    confirmed: true,
    blocked: false,
    reason: null,
    editable: record.is_editable === true,
  };
}

function isMutationOutcomeUnconfirmed(error) {
  return (
    error?.code === FREEE_API_ERROR_CODES.API_TRANSIENT ||
    error?.code === FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED ||
    error?.code === "OAUTH_IDENTITY_CHANGED"
  );
}

function allowsWebFallback(error, allowlist) {
  return allowlist.has(error?.code);
}

function stableWebCorrectionError(value) {
  const error = String(value || "");
  return /^web_[a-z0-9_]{1,64}$/.test(error)
    ? error
    : "web_form_rejected";
}

function workRecordMatchesEntry(record, entry) {
  const value = record?.work_record || record;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !workRecordMatchesDate(value, entry?.date)
  ) {
    return false;
  }

  const segmentArrays = [
    value.employee_work_record_segments,
    value.work_record_segments,
  ].filter(Array.isArray);
  if (segmentArrays.length > 1) return false;

  let segment;
  if (segmentArrays.length === 1) {
    if (segmentArrays[0].length !== 1) return false;
    [segment] = segmentArrays[0];
  } else {
    if (value.clock_in_at === undefined || value.clock_out_at === undefined) {
      return false;
    }
    segment = value;
  }
  if (
    toTimeOnly(segment?.clock_in_at) !== toTimeOnly(entry.clock_in_at) ||
    toTimeOnly(segment?.clock_out_at) !== toTimeOnly(entry.clock_out_at)
  ) {
    return false;
  }
  const expectedBreaks = entry.break_records || [];
  const actualBreaks = Array.isArray(value.break_records) ? value.break_records : [];
  if (actualBreaks.length !== expectedBreaks.length) return false;
  return expectedBreaks.every(
    (expected, index) =>
      toTimeOnly(actualBreaks[index]?.clock_in_at) ===
        toTimeOnly(expected.clock_in_at) &&
      toTimeOnly(actualBreaks[index]?.clock_out_at) ===
        toTimeOnly(expected.clock_out_at),
  );
}

function validateBatchEntries(entries) {
  const dates = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "Each entry must be an object";
    }
    if (!isDateString(entry.date) || dates.has(entry.date)) {
      return "Each entry must have a unique valid date";
    }
    dates.add(entry.date);
    if (entry.is_editable !== undefined && typeof entry.is_editable !== "boolean") {
      return "is_editable must be boolean";
    }
    if (entry.clock_in_at === undefined || entry.clock_out_at === undefined) {
      return "Each entry must contain clock_in_at and clock_out_at";
    }
    if (
      (entry.clock_in_at !== undefined && !isValidEntryTime(entry.clock_in_at, entry.date)) ||
      (entry.clock_out_at !== undefined && !isValidEntryTime(entry.clock_out_at, entry.date))
    ) {
      return "Each supplied work time must be valid";
    }
    const clockIn = entryTimeSeconds(entry.clock_in_at, entry.date);
    const clockOut = entryTimeSeconds(entry.clock_out_at, entry.date);
    if (clockIn === null || clockOut === null || clockOut <= clockIn) {
      return "clock_out_at must be after clock_in_at";
    }
    if (entry.break_records !== undefined && !Array.isArray(entry.break_records)) {
      return "break_records must be an array";
    }
    if (entry.break_records?.length > 20) {
      return "break_records must contain at most 20 entries";
    }
    let previousBreakEnd = null;
    for (const record of entry.break_records || []) {
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        !isValidEntryTime(record.clock_in_at, entry.date) ||
        !isValidEntryTime(record.clock_out_at, entry.date)
      ) {
        return "Each break record must contain valid start and end times";
      }
      const breakStart = entryTimeSeconds(record.clock_in_at, entry.date);
      const breakEnd = entryTimeSeconds(record.clock_out_at, entry.date);
      if (
        breakStart === null ||
        breakEnd === null ||
        breakStart < clockIn ||
        breakEnd > clockOut ||
        breakEnd <= breakStart ||
        (previousBreakEnd !== null && breakStart < previousBreakEnd)
      ) {
        return "Break records must be ordered, non-overlapping, and inside work time";
      }
      previousBreakEnd = breakEnd;
    }
  }
  return null;
}

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
 *   - confirmed editable record → PUT /work_records (direct write)
 *   - confirmed non-editable record → POST /approval_requests/work_times
 *   - unavailable atomic API path → verified freee Web form fallback
 *
 * The frontend just sends dates + times. The backend handles the rest.
 * This is the user's one-click "batch punch" — they don't need to know
 * whether it's a direct write or an approval request.
 */
/**
 * GET /api/attendance/batch/status/:taskId - Poll async batch task status
 */
router.get("/batch/status/:taskId", (req, res) => {
  let task;
  try { task = getTask(req.params.taskId); } catch {
    return res.status(503).json({ error: "Task status could not be read. Try checking again.", code: "TASK_PERSISTENCE_FAILED" });
  }
  if (!task) {
    return res.status(404).json({
      error: "Task not found for the selected account, or its result has expired. Check freee and the execution logs before retrying.",
      code: "TASK_NOT_FOUND",
    });
  }
  res.json(task);
});

router.post("/batch", async (req, res) => {
  const { entries, reason } = req.body || {};

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
  const validationError = validateBatchEntries(entries);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 255)) {
    return res.status(400).json({ error: "reason must be 255 characters or less" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;
  const operationIdentity = captureOperationIdentity(oauth);

  // Return task_id immediately, process in background
  const task = acceptBatchTask(res, "batch_punch", operationIdentity, entries.length);
  if (!task) return;
  const taskId = task.id;

  // Background processing (runs after response is sent)
  const taskPromise = (async () => {
    function checkpointResult(result) {
      checkpointTaskResult(task, result, {
        action_type: "batch_correction",
        scheduled_time: result.date,
        status: result.success ? "success" : "failure",
        trigger_type: "batch",
        error_message: result.success
          ? `task_id=${taskId} | method=${result.method}`
          : `task_id=${taskId} | method=${result.method} | ${result.error || "operation_failed"}`,
      });
    }

    try {
      const client = new FreeeApiClient({ identityBinding: oauth });
      await client.ensureValidToken();

      // Probe once: does this company have approval workflows?
      const {
        primaryRouteId,
        fallbackRouteId,
        primaryRouteUserId,
        primaryRouteNeedsApprover,
        lookupVerified: approvalRouteLookupVerified,
      } = await findAttendanceRouteIds(client, companyId);
      const primaryId = positiveInteger(primaryRouteId);
      const fallbackId = positiveInteger(fallbackRouteId);
      const routeId = primaryId || fallbackId;
      const hasApproval = !!routeId;
      const configuredApproverId = positiveInteger(primaryRouteUserId);
      const approvalRouteUsable =
        hasApproval &&
        !(
          routeId === primaryId &&
          primaryRouteNeedsApprover &&
          !configuredApproverId
        );

      // Helper: build the approval request body
      function buildApprovalBody(entry, useRouteId) {
        const body = {
          company_id: parseInt(companyId, 10),
          target_date: entry.date,
          approval_flow_route_id: useRouteId,
        };

        // Some routes require specifying an approver (e.g. "承認者を指定" type)
        // Use only the approver explicitly supplied by the verified route.
        if (primaryRouteNeedsApprover && useRouteId === primaryId) {
          body.approver_id = configuredApproverId;
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

      async function precheckEntry(entry) {
        try {
          const existingRecord = await client.apiRequest(
            "GET",
            `/employees/${employeeId}/work_records/${entry.date}?company_id=${companyId}`,
          );
          return evaluateExistingRecord(existingRecord, entry.date);
        } catch (error) {
          log.warn(`[${entry.date}] Existing record could not be confirmed`, {
            error: safeErrorMetadata(error),
          });
          return {
            confirmed: false,
            blocked: false,
            reason: null,
            editable: false,
          };
        }
      }

      let applicantIdPromise = null;

      async function currentApplicantId() {
        if (!applicantIdPromise) {
          applicantIdPromise = client
            .apiRequest("GET", "/users/me")
            .then((me) => {
              const id = positiveInteger(me?.id);
              if (!id) {
                const error = new Error("OAuth user could not be confirmed");
                error.code = FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED;
                throw error;
              }
              return id;
            });
        }
        return applicantIdPromise;
      }

      async function pendingWorkTimeDates(date) {
        const applicantId = await currentApplicantId();
        const company = positiveInteger(companyId);
        const range = parseApprovalMonth(
          date.slice(0, 4),
          Number(date.slice(5, 7)),
        );
        if (!company || !range) {
          const error = new Error("Pending WorkTime query was not confirmed");
          error.code = FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED;
          throw error;
        }
        const pageResult = await fetchApprovalRequestPages({
          client,
          companyId: company,
          type: "WorkTime",
          status: "in_progress",
          range,
          applicantId,
        });
        if (!pageResult.complete) {
          const error = new Error("Pending WorkTime query was incomplete");
          error.code = FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED;
          throw error;
        }

        const dates = new Set();
        for (const item of pageResult.items) {
          if (
            !positiveInteger(item?.id) ||
            positiveInteger(item?.company_id) !== company ||
            positiveInteger(item?.applicant_id) !== applicantId ||
            item?.status !== "in_progress" ||
            typeof item?.target_date !== "string" ||
            !item.target_date.startsWith(`${range.prefix}-`)
          ) {
            const error = new Error("Pending WorkTime response was not confirmed");
            error.code = FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED;
            throw error;
          }
          dates.add(item.target_date);
        }
        return dates;
      }

      // Helper: submit one entry via approval request
      async function submitApproval(entry) {
        const body = buildApprovalBody(entry, routeId);
        return await client.apiRequest(
          "POST",
          "/approval_requests/work_times",
          body,
        );
      }

      // Track which strategies have failed at company level
      let approvalRouteBlocked = hasApproval && !approvalRouteUsable;

      // Check strategy cache for this month
      const currentMonth = todayStringInTz().slice(0, 7);
      const cachedStrategy = getStrategyCache(
        currentMonth,
        operationIdentity.identityKey,
      );
      const cachedBestStrategy = ["direct", "approval", "web"].includes(
        cachedStrategy?.best_strategy,
      )
        ? cachedStrategy.best_strategy
        : null;

      log.info(
        `Batch: ${entries.length} entries, approval=${hasApproval}${cachedBestStrategy ? `, cached_hint=${cachedBestStrategy}` : ""}`,
      );

      let webFallbackEntries = []; // Entries that need Strategy 4 (web fallback)
      // Company-level strategy detection: once a strategy fails for company-wide reasons,
      // skip it for remaining entries only after a current, allowlisted rejection.
      let directDisabled = false;

      // Process each entry with atomic API strategies:
      //   1. PUT /work_records (direct write) — fastest, no approval needed
      //   2. POST /approval_requests/work_times (approval) — needs approval route
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        // Refresh token periodically for large batches to avoid expiry mid-operation
        if (i > 0 && i % 10 === 0) {
          try {
            await client.ensureValidToken();
          } catch (e) {
            log.warn(`Token refresh failed at entry ${i}`, {
              error: safeErrorMetadata(e),
            });
          }
        }

        await acquireAccountOperation();
        try {
        const precheck = await precheckEntry(entry);
        if (!precheck.confirmed) {
          checkpointResult({
            date: entry.date,
            success: false,
            method: "precheck_failed",
            error: "existing_record_unconfirmed",
          });
          continue;
        }
        if (precheck.blocked) {
          checkpointResult({
            date: entry.date,
            success: true,
            method: "skipped",
            reason: precheck.reason,
          });
          log.info(`[${entry.date}] Skipped because freee already has protected data`);
          continue;
        }

        let pendingDatesForEntry;
        try {
          pendingDatesForEntry = await pendingWorkTimeDates(entry.date);
        } catch (error) {
          checkpointResult({
            date: entry.date,
            success: false,
            method: "pending_precheck_failed",
            error: "pending_approval_unconfirmed",
          });
          log.warn(`[${entry.date}] Pending WorkTime could not be confirmed`, {
            error: safeErrorMetadata(error),
          });
          continue;
        }
        if (pendingDatesForEntry.has(entry.date)) {
          checkpointResult({
            date: entry.date,
            success: true,
            method: "skipped",
            reason: "already_pending_approval",
          });
          continue;
        }

        let succeeded = false;
        let outcomeUnconfirmed = false;
        let fallbackBlocked = false;
        let webFallbackCode = null;

        // === Strategy 1: Direct PUT ===
        if (
          !directDisabled &&
          precheck.editable
        ) {
          try {
            const body = {
              company_id: parseInt(companyId, 10),
              work_record_segments: [
                {
                  clock_in_at: toFreeeTime(entry.clock_in_at, entry.date),
                  clock_out_at: toFreeeTime(entry.clock_out_at, entry.date),
                },
              ],
            };
            if (entry.break_records && entry.break_records.length > 0) {
              body.break_records = entry.break_records.map((br) => ({
                clock_in_at: toFreeeTime(br.clock_in_at, entry.date),
                clock_out_at: toFreeeTime(br.clock_out_at, entry.date),
              }));
            }
            beginTaskItem(task, { date: entry.date });
            const directResult = await client.apiRequest(
              "PUT",
              `/employees/${employeeId}/work_records/${entry.date}?company_id=${companyId}`,
              body,
            );
            let directConfirmed = workRecordMatchesEntry(directResult, entry);
            if (!directConfirmed) {
              const confirmedRecord = await client.apiRequest(
                "GET",
                `/employees/${employeeId}/work_records/${entry.date}?company_id=${companyId}`,
              );
              directConfirmed = workRecordMatchesEntry(confirmedRecord, entry);
            }
            if (!directConfirmed) {
              const error = new Error("Direct work-record update could not be confirmed");
              error.code = FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED;
              throw error;
            }
            checkpointResult({ date: entry.date, success: true, method: "direct" });
            log.info(`[${entry.date}] Direct write succeeded`);
            succeeded = true;
          } catch (err) {
            if (["TASK_PERSISTENCE_FAILED", "TASK_STATE_INVALID"].includes(err?.code)) throw err;
            if (isMutationOutcomeUnconfirmed(err)) {
              outcomeUnconfirmed = true;
              checkpointResult({
                date: entry.date,
                success: false,
                method: "direct_unconfirmed",
                error: "mutation_outcome_unconfirmed",
                unknown: true,
              });
              log.warn(`[${entry.date}] Direct write outcome is unconfirmed`, {
                error: safeErrorMetadata(err),
              });
            } else if (allowsWebFallback(err, DIRECT_WEB_FALLBACK_ERROR_CODES)) {
              webFallbackCode = err.code;
              if (err.code === FREEE_API_ERROR_CODES.DIRECT_EDIT_DISABLED) {
                directDisabled = true;
              }
              log.info(
                `[${entry.date}] Direct write rejected with allowlisted code ${err.code}`,
              );
            } else {
              fallbackBlocked = true;
              checkpointResult({
                date: entry.date,
                success: false,
                method: "direct_failed",
                error: "api_fallback_not_allowed",
              });
              log.warn(`[${entry.date}] Direct write failed`, {
                error: safeErrorMetadata(err),
              });
            }
          }
        }

        // === Strategy 2: Approval request ===
        if (
          !succeeded &&
          !outcomeUnconfirmed &&
          !fallbackBlocked &&
          hasApproval &&
          approvalRouteUsable &&
          approvalRouteLookupVerified &&
          !approvalRouteBlocked
        ) {
          try {
            beginTaskItem(task, { date: entry.date });
            const result = await submitApproval(entry);
            const requestId = positiveInteger(result?.id || result?.work_time?.id);
            if (!requestId) {
              outcomeUnconfirmed = true;
              checkpointResult({
                date: entry.date,
                success: false,
                method: "approval_unconfirmed",
                error: "mutation_outcome_unconfirmed",
                unknown: true,
              });
              log.warn(`[${entry.date}] Approval response had no confirmed request ID`);
            } else {
              checkpointResult({
                date: entry.date,
                success: true,
                method: "approval",
                id: requestId,
              });
              log.info(`[${entry.date}] Approval request succeeded`);
              pendingDatesForEntry.add(entry.date);
              succeeded = true;
            }
          } catch (err) {
            if (["TASK_PERSISTENCE_FAILED", "TASK_STATE_INVALID"].includes(err?.code)) throw err;
            if (isMutationOutcomeUnconfirmed(err)) {
              outcomeUnconfirmed = true;
              checkpointResult({
                date: entry.date,
                success: false,
                method: "approval_unconfirmed",
                error: "mutation_outcome_unconfirmed",
                unknown: true,
              });
              log.warn(`[${entry.date}] Approval submission is unconfirmed`, {
                error: safeErrorMetadata(err),
              });
            } else if (allowsWebFallback(err, APPROVAL_WEB_FALLBACK_ERROR_CODES)) {
              webFallbackCode = err.code;
              if (err.code === FREEE_API_ERROR_CODES.WEB_FORM_REQUIRED) {
                approvalRouteBlocked = true;
              }
              log.info(
                `[${entry.date}] Approval rejected with allowlisted code ${err.code}`,
              );
            } else {
              fallbackBlocked = true;
              checkpointResult({
                date: entry.date,
                success: false,
                method: "approval_failed",
                error: "api_fallback_not_allowed",
              });
              log.warn(`[${entry.date}] Approval request failed`, {
                error: safeErrorMetadata(err),
              });
            }
          }
        }

        // Sequential time-clock writes are intentionally excluded here: a partial
        // failure cannot be rolled back and is unsafe for historical corrections.
        if (!succeeded && !outcomeUnconfirmed && !fallbackBlocked) {
          const noAtomicApiPath =
            approvalRouteLookupVerified &&
            (!precheck.editable || directDisabled) &&
            (!hasApproval || !approvalRouteUsable || approvalRouteBlocked);
          if (!webFallbackCode && noAtomicApiPath) {
            webFallbackCode = "ATOMIC_API_UNAVAILABLE";
          }
          if (webFallbackCode) {
            clearTaskItem(task);
            webFallbackEntries.push(entry);
            log.info(
              `[${entry.date}] Queued for Web fallback after ${webFallbackCode}`,
            );
          } else {
            checkpointResult({
              date: entry.date,
              success: false,
              method: "api_unavailable",
              error: "api_fallback_not_allowed",
            });
          }
        }

        } finally {
          releaseAccountOperation();
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // === Strategy 4: Playwright Web fallback ===
      let webFallbackAttempted = false;
      for (const entry of webFallbackEntries) {
        await acquireAccountOperation();
        try {
          const precheck = await precheckEntry(entry);
          if (!precheck.confirmed) {
            checkpointResult({
              date: entry.date,
              success: false,
              method: "precheck_failed",
              error: "existing_record_unconfirmed",
            });
            continue;
          }
          if (precheck.blocked) {
            checkpointResult({
              date: entry.date,
              success: true,
              method: "skipped",
              reason: precheck.reason,
            });
            continue;
          }
          if ((entry.break_records || []).length > 1) {
            checkpointResult({
              date: entry.date,
              success: false,
              method: "web_unsupported",
              error: "web_multiple_breaks_unsupported",
            });
            continue;
          }

          try {
            const pendingDates = await pendingWorkTimeDates(entry.date);
            if (pendingDates.has(entry.date)) {
              checkpointResult({
                date: entry.date,
                success: true,
                method: "skipped",
                reason: "already_pending_approval",
              });
              continue;
            }
          } catch (error) {
            log.warn(`[${entry.date}] Pending WorkTime could not be confirmed`, {
              error: safeErrorMetadata(error),
            });
            checkpointResult({
              date: entry.date,
              success: false,
              method: "pending_precheck_failed",
              error: "pending_approval_unconfirmed",
            });
            continue;
          }

          if (!hasWebCredentials()) {
            log.warn(`[${entry.date}] Web correction requires configured credentials`);
            checkpointResult({
              date: entry.date,
              success: false,
              method: "all_failed",
              error: "web_credentials_required",
            });
            continue;
          }

          webFallbackAttempted = true;
          log.info(`[${entry.date}] Attempting correction via freee Web`);
          try {
            beginTaskItem(task, { date: entry.date });
            const webResults = await submitWebCorrections(
              [entry],
              reason || "打刻漏れのため修正",
              oauth,
            );
            const rows = Array.isArray(webResults) ? webResults : [];
            const confirmed = rows.length === 1 && rows[0]?.date === entry.date
              ? rows[0]
              : null;
            const webResult = confirmed
              ? {
                  date: entry.date,
                  success: confirmed.success === true,
                  method: "web_correction",
                  ...(confirmed.success === true
                    ? {}
                    : { error: stableWebCorrectionError(confirmed.error) }),
                }
              : {
                  date: entry.date,
                  success: false,
                  method: "web_correction",
                  error: "web_result_unconfirmed",
                  unknown: true,
                };
            if (!webResult.success && UNKNOWN_WEB_RESULT_CODES.has(webResult.error)) webResult.unknown = true;
            checkpointResult(webResult);
            log[webResult.success ? "info" : "error"](
              `[${entry.date}] Web correction ${webResult.success ? "succeeded" : "failed"}`,
              webResult.success ? undefined : { errorCode: webResult.error },
            );
          } catch (err) {
            if (["TASK_PERSISTENCE_FAILED", "TASK_STATE_INVALID"].includes(err?.code)) throw err;
            log.error(`[${entry.date}] Web correction failed`, {
              error: safeErrorMetadata(err),
            });
            checkpointResult({
              date: entry.date,
              success: false,
              method: "all_failed",
              error: "web_automation_failed",
              unknown: true,
            });
          }
        } finally {
          releaseAccountOperation();
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Update strategy cache based on what we learned during this batch
      const newCacheData = {
        direct_ok: !directDisabled,
        approval_ok:
          approvalRouteLookupVerified && !approvalRouteBlocked && hasApproval,
        time_clock_ok: false,
        best_strategy: !directDisabled
          ? "direct"
          : approvalRouteLookupVerified && !approvalRouteBlocked && hasApproval
            ? "approval"
            : "web",
      };
      if (approvalRouteLookupVerified) {
        setStrategyCache(
          currentMonth,
          newCacheData,
          operationIdentity.identityKey,
        );
      }

      const { results, succeeded: succeededCount } = getTask(taskId, operationIdentity.identityKey);
      const methods = {};
      for (const r of results) {
        methods[r.method] = (methods[r.method] || 0) + 1;
      }
      log.info(
        `Batch complete: ${succeededCount}/${results.length} succeeded (${JSON.stringify(methods)})`,
      );

      // Include strategy info for frontend
      const webCredsInvalid = results.some(
        (r) => r.error === "web_credentials_invalid",
      );
      const strategyInfo = {
        direct_disabled: directDisabled,
        approval_route_blocked: approvalRouteBlocked,
        approval_route_verified: approvalRouteLookupVerified,
        web_fallback_used: webFallbackAttempted,
        web_credentials_configured: hasWebCredentials(),
        web_credentials_invalid: webCredsInvalid,
      };

      updateTask(task, {
        status: "completed",
        strategy_info: strategyInfo,
      });
    } catch (err) {
      log.error("Batch failed", { error: safeErrorMetadata(err) });
      updateTask(task, {
        status: "failed",
        code: err?.code === "TASK_PERSISTENCE_FAILED" ? err.code : "BATCH_CORRECTION_FAILED",
        error: sanitizeError(
          err,
          "Batch correction stopped before all entries were processed.",
        ),
      });
    }
  })();
  void trackTaskPromise(task, taskPromise);
});

export default router;
