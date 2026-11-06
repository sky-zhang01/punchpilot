import { parseExternalId as positiveInteger } from "../../freee-values.js";
import {
  getWorkRecordLeaveCoverage,
  getWorkRecordNonWorkingDayStatus,
  hasWorkRecordClockTimes,
  workRecordMatchesDate,
} from "../../work-record-status.js";
import {
  LEAVE_APPROVAL_ENDPOINTS,
  LeaveValidationError,
  buildDirectLeaveBody,
  buildLeaveApprovalBody,
  canSubmitLeaveViaWeb,
  extractLeaveApprovalId,
  leaveWebOptions,
} from "./leave-policy.js";
import {
  fetchApprovalRequestPages,
  parseApprovalMonth,
} from "./approval-list-service.js";
import { withAccountOperation } from "../../account-operation.js";

const AMBIGUOUS_MUTATION_CODES = new Set([
  "API_TRANSIENT",
  "API_RESPONSE_UNCONFIRMED",
  "AUTH_TRANSIENT",
  "OAUTH_IDENTITY_CHANGED",
]);

const WEB_CONFIRMATION_CODES = new Set([
  "WEB_ONLY_LEAVE_COMBINATION",
]);

const APPROVAL_WEB_FALLBACK_CODES = new Set([
  "PERMISSION_DENIED",
  "WEB_FORM_REQUIRED",
]);

const DIRECT_WEB_FALLBACK_CODES = new Set([
  "DIRECT_EDIT_DISABLED",
  "PERMISSION_DENIED",
]);

const KNOWN_WEB_ERRORS = new Set([
  "WEB_CREDENTIALS_NOT_CONFIGURED",
  "WEB_LOGIN_FAILED",
  "WEB_LOGIN_INTERACTION_REQUIRED",
  "WEB_FORM_TYPE_UNSUPPORTED",
  "WEB_FORM_FIELDS_UNSUPPORTED",
  "WEB_APPROVER_SELECTION_REQUIRED",
  "WEB_COMPANY_BINDING_REQUIRED",
  "WEB_COMPANY_IDENTITY_UNCONFIRMED",
  "WEB_COMPANY_SELECTION_UNCONFIRMED",
  "WEB_ACCOUNT_IDENTITY_CHANGED",
  "WEB_MUTATION_ORIGIN_UNTRUSTED",
  "WEB_MUTATION_REQUEST_UNTRUSTED",
  "WEB_MUTATION_REQUEST_VALIDATOR_ASYNC",
  "WEB_MUTATION_DISPATCH_GUARD_UNAVAILABLE",
  "WEB_MUTATION_DISPATCH_GUARD_ASYNC",
  "WEB_EXISTING_LEAVE_REQUIRES_CONFIRMATION",
  "WEB_FORM_SUBMISSION_UNCONFIRMED",
  "WEB_SUBMISSION_UNCONFIRMED",
]);

const WEB_PRECHECK_ERRORS = new Set([
  "WEB_WORK_RECORD_UNCONFIRMED",
  "WEB_WORK_RECORD_SCHEMA_UNSUPPORTED",
  "WEB_WORK_RECORD_RESPONSE_TOO_LARGE",
]);

function stage(stages, name, success, code = null) {
  stages.push({ stage: name, success, ...(code ? { code } : {}) });
}

function stableCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallback;
}

function failure(request, stages, error, method = "blocked") {
  const unknown = error === "mutation_outcome_unconfirmed" ||
    (error === "web_submission_failed" &&
      ["WEB_SUBMISSION_FAILED", "WEB_FORM_SUBMISSION_UNCONFIRMED", "WEB_SUBMISSION_UNCONFIRMED"].includes(stages.at(-1)?.code));
  return {
    success: false,
    type: request.type,
    date: request.date,
    method,
    error,
    ...(unknown ? { unknown: true } : {}),
    stages,
  };
}

function skipped(request, stages, reason) {
  return {
    success: true,
    type: request.type,
    date: request.date,
    method: "skipped",
    skipped: true,
    reason,
    stages,
  };
}

function workRecordPath(oauth, date) {
  return `/employees/${oauth.employeeId}/work_records/${date}?company_id=${oauth.companyId}`;
}

async function readWorkRecord(request, context) {
  const record = await context.client.apiRequest(
    "GET",
    workRecordPath(context.oauth, request.date),
  );
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    const error = new Error("freee work record response was not confirmed");
    error.code = "API_RESPONSE_UNCONFIRMED";
    throw error;
  }
  if (!workRecordMatchesDate(record, request.date)) {
    const error = new Error("freee work record date did not match");
    error.code = "API_RESPONSE_UNCONFIRMED";
    throw error;
  }
  if (!getWorkRecordNonWorkingDayStatus(record).confirmed) {
    const error = new Error("freee work record fields were not confirmed");
    error.code = "API_RESPONSE_UNCONFIRMED";
    throw error;
  }
  return record;
}

function inspectExistingRecord(request, record, stages) {
  const nonWorking = getWorkRecordNonWorkingDayStatus(record);
  if (nonWorking.isNonWorkingDay) {
    if (requestedDirectLeaveConfirmed(request, record)) {
      stage(stages, "precheck", true, "ALREADY_NON_WORKING_DAY");
      return skipped(request, stages, "already_non_working_day");
    }
    if (nonWorking.code !== "non_working_day_pattern") {
      stage(stages, "precheck", false, "EXISTING_NON_WORKING_DAY_CONFLICT");
      return failure(
        request,
        stages,
        "existing_leave_requires_web_confirmation",
      );
    }
  }
  const coverage = getWorkRecordLeaveCoverage(record);
  if (
    ["PaidHoliday", "SpecialHoliday"].includes(request.type) &&
    coverage.hasAnyLeave
  ) {
    stage(stages, "precheck", false, "EXISTING_PARTIAL_LEAVE");
    return failure(
      request,
      stages,
      "existing_leave_requires_web_confirmation",
    );
  }
  stage(stages, "precheck", true);
  return null;
}

function shouldTryWebAfterMutationError(error, allowlist) {
  const code = stableCode(error, "MUTATION_REJECTED");
  return allowlist.has(code);
}

function requestedDirectLeaveConfirmed(request, record) {
  const status = getWorkRecordNonWorkingDayStatus(record);
  if (!status.confirmed || !status.isNonWorkingDay) return false;
  if (request.type === "Absence") return status.code === "absence";
  if (request.type === "SpecialHoliday") {
    return request.holidayType === "full" &&
      status.code === "special_holiday" &&
      positiveInteger(record.special_holiday_setting_id) ===
        request.specialHolidaySettingId;
  }
  if (request.type === "PaidHoliday") {
    return request.holidayType === "full" &&
      ["paid_holiday", "paid_holiday_minutes"].includes(status.code);
  }
  return false;
}

async function pendingApprovalStatus(request, context) {
  if (typeof context.pendingApprovalStatus === "function") {
    return context.pendingApprovalStatus(request);
  }
  if (!LEAVE_APPROVAL_ENDPOINTS[request.type]) {
    return { supported: false, pending: false };
  }

  const me = await context.client.apiRequest("GET", "/users/me");
  const applicantId = positiveInteger(me?.id);
  const companyId = positiveInteger(context.oauth.companyId);
  const range = parseApprovalMonth(
    request.date.slice(0, 4),
    Number(request.date.slice(5, 7)),
  );
  if (!applicantId || !companyId || !range) {
    const error = new Error("Pending approval query identity was not confirmed");
    error.code = "API_RESPONSE_UNCONFIRMED";
    throw error;
  }

  const result = await fetchApprovalRequestPages({
    client: context.client,
    companyId,
    type: request.type,
    status: "in_progress",
    range,
    applicantId,
  });
  if (!result.complete) {
    const error = new Error("Pending approval query was incomplete");
    error.code = "API_RESPONSE_UNCONFIRMED";
    throw error;
  }

  for (const item of result.items) {
    if (item?.target_date !== request.date) continue;
    if (
      !positiveInteger(item.id) ||
      positiveInteger(item.company_id) !== companyId ||
      positiveInteger(item.applicant_id) !== applicantId ||
      item.status !== "in_progress"
    ) {
      const error = new Error("Pending approval response was not confirmed");
      error.code = "API_RESPONSE_UNCONFIRMED";
      throw error;
    }
    return { supported: true, pending: true };
  }
  return { supported: true, pending: false };
}

export async function listSpecialHolidayOptions(client, oauth, date) {
  const data = await client.apiRequest(
    "GET",
    `/employees/${oauth.employeeId}/special_holidays?company_id=${oauth.companyId}&date=${date}`,
  );
  if (!data || !Array.isArray(data.employee_special_holidays)) {
    const error = new Error("freee special holiday response was not confirmed");
    error.code = "API_RESPONSE_UNCONFIRMED";
    throw error;
  }
  const rows = data.employee_special_holidays;
  const options = new Map();
  for (const row of rows) {
    const settingId = positiveInteger(row?.special_holiday_setting_id);
    const usageDay = row?.usage_day;
    if (
      !Number.isSafeInteger(settingId) ||
      settingId <= 0 ||
      !["full", "half", "hour"].includes(usageDay)
    ) {
      const error = new Error("freee special holiday response was not confirmed");
      error.code = "API_RESPONSE_UNCONFIRMED";
      throw error;
    }
    if (!options.has(settingId)) {
      options.set(settingId, {
        setting_id: settingId,
        name: String(row?.name || row?.type_name || "Special holiday")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, 100),
        usage_days: [],
        remaining_days: Number.isFinite(Number(row?.num_days_and_hours_left?.days))
          ? Number(row.num_days_and_hours_left.days)
          : null,
        remaining_hours: Number.isFinite(Number(row?.num_days_and_hours_left?.hours))
          ? Number(row.num_days_and_hours_left.hours)
          : null,
      });
    }
    const option = options.get(settingId);
    if (usageDay && !option.usage_days.includes(usageDay)) {
      option.usage_days.push(usageDay);
    }
  }
  const usageOrder = ["full", "half", "hour"];
  return [...options.values()].map((option) => {
    const usageDays = usageOrder.filter((usageDay) =>
      option.usage_days.includes(usageDay));
    return {
      ...option,
      usage_day: usageDays.length === 1 ? usageDays[0] : null,
      usage_days: usageDays,
    };
  });
}

function specialHolidayUsageDay(holidayType) {
  if (["morning_off", "afternoon_off", "half"].includes(holidayType)) {
    return "half";
  }
  return ["full", "hour"].includes(holidayType) ? holidayType : null;
}

function specialHolidayOptionAllows(option, request) {
  const usageDays = Array.isArray(option?.usage_days) ? option.usage_days : [];
  const requestedUsageDay = specialHolidayUsageDay(request.holidayType);
  return Boolean(
    requestedUsageDay &&
    usageDays.length > 0 &&
    usageDays.includes(requestedUsageDay),
  );
}

async function resolveSpecialHolidaySetting(request, context, stages) {
  if (request.type !== "SpecialHoliday") return request;
  let options;
  try {
    options = await listSpecialHolidayOptions(
      context.client,
      context.oauth,
      request.date,
    );
  } catch (error) {
    stage(
      stages,
      "special_leave_lookup",
      false,
      stableCode(error, "SPECIAL_LEAVE_LOOKUP_FAILED"),
    );
    return null;
  }
  if (request.specialHolidaySettingId) {
    const selectedOption = options.find(
      (option) => option.setting_id === request.specialHolidaySettingId,
    );
    if (!selectedOption) {
      stage(stages, "special_leave_lookup", false, "LEAVE_SETTING_UNAVAILABLE");
      return null;
    }
    if (!specialHolidayOptionAllows(selectedOption, request)) {
      stage(stages, "special_leave_lookup", false, "LEAVE_USAGE_UNAVAILABLE");
      return null;
    }
    stage(stages, "special_leave_lookup", true);
    return request;
  }
  if (options.length !== 1) {
    stage(stages, "special_leave_lookup", false, "LEAVE_SETTING_REQUIRED");
    return null;
  }
  if (!specialHolidayOptionAllows(options[0], request)) {
    stage(stages, "special_leave_lookup", false, "LEAVE_USAGE_UNAVAILABLE");
    return null;
  }
  stage(stages, "special_leave_lookup", true);
  return { ...request, specialHolidaySettingId: options[0].setting_id };
}

async function submitViaWeb(request, context, stages) {
  if (!context.webCredentialsAvailable) {
    stage(stages, "web", false, "WEB_CREDENTIALS_NOT_CONFIGURED");
    return failure(request, stages, "web_credentials_required", "web");
  }
  if (!canSubmitLeaveViaWeb(request)) {
    stage(stages, "web", false, "WEB_FORM_FIELDS_UNSUPPORTED");
    return failure(
      request,
      stages,
      "web_form_fields_unsupported",
      "web",
    );
  }

  if (context.oauth) {
    try {
      const currentRecord = await readWorkRecord(request, context);
      const existing = inspectExistingRecord(request, currentRecord, stages);
      if (existing) return existing;
    } catch (error) {
      stage(
        stages,
        "web_precheck",
        false,
        stableCode(error, "WORK_RECORD_PRECHECK_FAILED"),
      );
      return failure(request, stages, "work_record_precheck_failed", "web");
    }

    try {
      const pending = await pendingApprovalStatus(request, context);
      if (pending.supported) {
        stage(
          stages,
          "pending_precheck",
          true,
          pending.pending ? "ALREADY_PENDING_APPROVAL" : null,
        );
      }
      if (pending.pending) {
        return skipped(request, stages, "already_pending_approval");
      }
    } catch (error) {
      stage(
        stages,
        "pending_precheck",
        false,
        stableCode(error, "PENDING_APPROVAL_PRECHECK_FAILED"),
      );
      return failure(request, stages, "work_record_precheck_failed", "web");
    }
  }

  try {
    const result = await context.submitWeb(
      request.type,
      request.date,
      leaveWebOptions(request),
    );
    if (result?.guard !== "verified") {
      stage(stages, "web_precheck", false, "WEB_LEAVE_GUARD_UNCONFIRMED");
      return failure(request, stages, "work_record_precheck_failed", "web");
    }
    if (result?.skipped === true) {
      stage(stages, "web_precheck", true, "ALREADY_NON_WORKING_DAY");
      return skipped(
        request,
        stages,
        result.reason || "already_non_working_day",
      );
    }
    stage(stages, "web_precheck", true);
    if (result?.success !== true) {
      const code = KNOWN_WEB_ERRORS.has(result?.error)
        ? result.error
        : "WEB_SUBMISSION_FAILED";
      stage(stages, "web", false, code);
      return failure(request, stages, "web_submission_failed", "web");
    }
    stage(stages, "web", true);
    return {
      success: true,
      type: request.type,
      date: request.date,
      method: "web",
      guard: "verified",
      stages,
    };
  } catch (error) {
    const code = stableCode(error, "WEB_SUBMISSION_FAILED");
    if (code === "WEB_EXISTING_LEAVE_REQUIRES_CONFIRMATION") {
      stage(stages, "web_precheck", false, code);
      return failure(
        request,
        stages,
        "existing_leave_requires_web_confirmation",
        "web",
      );
    }
    if (WEB_PRECHECK_ERRORS.has(code)) {
      stage(stages, "web_precheck", false, code);
      return failure(request, stages, "work_record_precheck_failed", "web");
    }
    stage(stages, "web", false, KNOWN_WEB_ERRORS.has(code) ? code : "WEB_SUBMISSION_FAILED");
    return failure(request, stages, "web_submission_failed", "web");
  }
}

async function finalMutationPrecondition(request, context, { direct = false } = {}) {
  let record;
  try {
    record = await readWorkRecord(request, context);
  } catch (error) {
    return {
      ok: false,
      kind: "failure",
      code: stableCode(error, "WORK_RECORD_PRECHECK_FAILED"),
      error: "work_record_precheck_failed",
    };
  }

  const localStages = [];
  const existing = inspectExistingRecord(request, record, localStages);
  if (existing) {
    return existing.skipped === true
      ? {
          ok: false,
          kind: "skipped",
          code: localStages.at(-1)?.code || "ALREADY_NON_WORKING_DAY",
          reason: existing.reason || "already_non_working_day",
        }
      : {
          ok: false,
          kind: "failure",
          code: localStages.at(-1)?.code || "EXISTING_NON_WORKING_DAY_CONFLICT",
          error: existing.error || "existing_leave_requires_web_confirmation",
        };
  }

  try {
    const pending = await pendingApprovalStatus(request, context);
    if (pending.pending) {
      return {
        ok: false,
        kind: "skipped",
        code: "ALREADY_PENDING_APPROVAL",
        reason: "already_pending_approval",
      };
    }
  } catch (error) {
    return {
      ok: false,
      kind: "failure",
      code: stableCode(error, "PENDING_APPROVAL_PRECHECK_FAILED"),
      error: "work_record_precheck_failed",
    };
  }

  if (direct && (record.is_editable !== true || hasWorkRecordClockTimes(record))) {
    return {
      ok: false,
      kind: "failure",
      code: "DIRECT_WRITE_NOT_SAFE",
      error: "direct_write_not_safe",
    };
  }
  return { ok: true, record };
}

function blockedPreconditionError() {
  const error = new Error("The leave mutation precondition is no longer satisfied.");
  error.code = "LEAVE_MUTATION_PRECONDITION_BLOCKED";
  return error;
}

function terminalPreconditionResult(request, stages, precondition, method) {
  stage(
    stages,
    "mutation_precheck",
    precondition.kind === "skipped",
    precondition.code,
  );
  if (precondition.kind === "skipped") {
    return skipped(request, stages, precondition.reason);
  }
  return failure(request, stages, precondition.error, method);
}

async function submitLeaveForDateExclusive(originalRequest, context) {
  const stages = [];
  let request = originalRequest;
  let record = null;

  if (!context.oauth) {
    stage(stages, "api_precheck", false, "API_GUARD_UNAVAILABLE");
    return submitViaWeb(request, context, stages);
  }

  try {
    await context.ensureApiReady();
    record = await readWorkRecord(request, context);
  } catch (error) {
    const code = stableCode(error, "WORK_RECORD_PRECHECK_FAILED");
    stage(stages, "precheck", false, code);
    return failure(
      request,
      stages,
      WEB_CONFIRMATION_CODES.has(code)
        ? "web_confirmation_required"
        : "work_record_precheck_failed",
    );
  }

  const existing = inspectExistingRecord(request, record, stages);
  if (existing) return existing;

  try {
    const pending = await pendingApprovalStatus(request, context);
    if (pending.supported) {
      stage(
        stages,
        "pending_precheck",
        true,
        pending.pending ? "ALREADY_PENDING_APPROVAL" : null,
      );
    }
    if (pending.pending) {
      return skipped(request, stages, "already_pending_approval");
    }
  } catch (error) {
    stage(
      stages,
      "pending_precheck",
      false,
      stableCode(error, "PENDING_APPROVAL_PRECHECK_FAILED"),
    );
    return failure(request, stages, "work_record_precheck_failed");
  }

  request = await resolveSpecialHolidaySetting(request, context, stages);
  if (!request) {
    const resolutionCode = stages.at(-1)?.code;
    return failure(
      originalRequest,
      stages,
      resolutionCode === "LEAVE_USAGE_UNAVAILABLE"
        ? "special_holiday_usage_unavailable"
        : ["LEAVE_SETTING_REQUIRED", "LEAVE_SETTING_UNAVAILABLE"].includes(
            resolutionCode,
          )
          ? "special_holiday_setting_required"
          : "special_holiday_lookup_failed",
    );
  }

  const approvalEndpoint = LEAVE_APPROVAL_ENDPOINTS[request.type];
  let routeInfo = null;
  if (approvalEndpoint) {
    routeInfo = await context.getRouteInfo();
    if (!routeInfo.lookupVerified) {
      stage(
        stages,
        "approval_route",
        false,
        routeInfo.lookupErrorCode || "APPROVAL_ROUTE_LOOKUP_FAILED",
      );
      return failure(request, stages, "approval_request_failed", "approval");
    }
    stage(
      stages,
      "approval_route",
      true,
      routeInfo.primaryRouteId || routeInfo.fallbackRouteId
        ? null
        : "APPROVAL_ROUTE_NOT_FOUND",
    );
  }

  if (approvalEndpoint && (routeInfo.primaryRouteId || routeInfo.fallbackRouteId)) {
    let body;
    try {
      body = buildLeaveApprovalBody(request, context.oauth.companyId, routeInfo);
    } catch (error) {
      if (!(error instanceof LeaveValidationError)) throw error;
      stage(stages, "approval", false, error.code);
      if (error.code === "APPROVER_SELECTION_REQUIRED") {
        return submitViaWeb(request, context, stages);
      }
      return failure(request, stages, "approval_request_failed", "approval");
    }

    let dispatchPrecondition = null;
    try {
      const response = await context.client.apiRequest(
        "POST",
        `/approval_requests/${approvalEndpoint}`,
        body,
        {
          beforeDispatchAsync: async () => {
            dispatchPrecondition = await finalMutationPrecondition(request, context);
            if (!dispatchPrecondition.ok) throw blockedPreconditionError();
          },
        },
      );
      stage(stages, "mutation_precheck", true);
      const requestId = extractLeaveApprovalId(request, response);
      if (!requestId) {
        stage(stages, "approval", false, "API_RESPONSE_UNCONFIRMED");
        return failure(
          request,
          stages,
          "mutation_outcome_unconfirmed",
          "approval_unconfirmed",
        );
      }
      stage(stages, "approval", true);
      return {
        success: true,
        type: request.type,
        date: request.date,
        method: "approval",
        id: requestId,
        stages,
      };
    } catch (error) {
      if (dispatchPrecondition && !dispatchPrecondition.ok) {
        return terminalPreconditionResult(
          request,
          stages,
          dispatchPrecondition,
          "approval",
        );
      }
      const code = stableCode(error, "APPROVAL_REQUEST_FAILED");
      stage(stages, "approval", false, code);
      if (WEB_CONFIRMATION_CODES.has(code)) {
        return failure(request, stages, "web_confirmation_required", "approval");
      }
      if (!shouldTryWebAfterMutationError(error, APPROVAL_WEB_FALLBACK_CODES)) {
        return failure(
          request,
          stages,
          AMBIGUOUS_MUTATION_CODES.has(code)
            ? "mutation_outcome_unconfirmed"
            : "approval_request_failed",
          "approval",
        );
      }
    }
  }

  const directBody = buildDirectLeaveBody(request, context.oauth.companyId);
  const approvalRouteAbsent =
    !approvalEndpoint ||
    (routeInfo?.lookupVerified &&
      !routeInfo.primaryRouteId &&
      !routeInfo.fallbackRouteId);
  if (
    directBody &&
    approvalRouteAbsent &&
    record.is_editable === true &&
    !hasWorkRecordClockTimes(record)
  ) {
    let dispatchPrecondition = null;
    try {
      await context.client.apiRequest(
        "PUT",
        workRecordPath(context.oauth, request.date),
        directBody,
        {
          beforeDispatchAsync: async () => {
            dispatchPrecondition = await finalMutationPrecondition(
              request,
              context,
              { direct: true },
            );
            if (!dispatchPrecondition.ok) throw blockedPreconditionError();
          },
        },
      );
      stage(stages, "mutation_precheck", true);
      const confirmedRecord = await readWorkRecord(request, context);
      if (!requestedDirectLeaveConfirmed(request, confirmedRecord)) {
        stage(stages, "direct", false, "API_RESPONSE_UNCONFIRMED");
        return failure(
          request,
          stages,
          "mutation_outcome_unconfirmed",
          "direct_unconfirmed",
        );
      }
      stage(stages, "direct", true);
      return {
        success: true,
        type: request.type,
        date: request.date,
        method: "direct",
        stages,
      };
    } catch (error) {
      if (dispatchPrecondition && !dispatchPrecondition.ok) {
        return terminalPreconditionResult(
          request,
          stages,
          dispatchPrecondition,
          "direct",
        );
      }
      const code = stableCode(error, "DIRECT_WRITE_FAILED");
      stage(stages, "direct", false, code);
      if (!shouldTryWebAfterMutationError(error, DIRECT_WEB_FALLBACK_CODES)) {
        return failure(
          request,
          stages,
          AMBIGUOUS_MUTATION_CODES.has(code)
            ? "mutation_outcome_unconfirmed"
            : "direct_write_failed",
          "direct",
        );
      }
    }
  } else if (directBody) {
    stage(stages, "direct", false, "DIRECT_WRITE_NOT_SAFE");
  }

  return submitViaWeb(request, context, stages);
}

export async function submitLeaveForDate(originalRequest, context) {
  return withAccountOperation(() => {
    context.beforeOperation?.(originalRequest);
    return submitLeaveForDateExclusive(originalRequest, context);
  });
}
