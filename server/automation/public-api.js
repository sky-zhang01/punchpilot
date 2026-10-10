import {
  assertOAuthCompanyIdentity,
  assertOAuthIdentityBinding,
  FreeeApiClient,
  FREEE_API_ERROR_CODES,
  FREEE_AUTH_ERROR_CODES,
  getAuthorizedOAuthCompanies,
} from "../freee-api.js";
import { FREEE_STATE } from "../constants.js";
import { todayStringInTz } from "../timezone.js";
import {
  getWorkRecordLeaveCoverage,
  getWorkRecordNonWorkingDayStatus,
} from "../work-record-status.js";
import { safeErrorMetadata } from "../logger.js";
import { currentExecutionLogIdentityKey } from "../db.js";
import {
  annotateAutomationFailureStage,
  automationFailureStage,
  normalizeAutomationErrorCode,
  normalizeAutomationFailureStage,
} from "../automation-diagnostics.js";
import { ACTION_LABELS, acquireLock, releaseLock } from "./constants.js";
import { getCredentials, getConnectionMode, getWebCompanyName, hasApiCredentials, hasCredentials, isDebugMode, hasWebCredentials } from "./utils.js";
import { PunchBot } from "./punch-bot.js";
import { AUTOMATION_OPERATION_TIMEOUT_MS, withDeadline } from "./runtime.js";
import {
  readWebWorkRecord,
  rereadWebWorkRecord,
  readWebEmployeeIdentity,
  returnToWebTimeClockPage,
  WEB_NON_WORKING_DAY_CONFIRMED,
  WEB_WORK_RECORD_ERROR_CODES,
} from "./web-work-record.js";
import {
  submitWorkTimeCorrection,
  scrapeEmployeeInfo,
  submitLeaveRequest as submitLeaveRequestForm,
  withdrawApprovalRequest,
  submitMonthlyClosingWeb,
} from "./forms.js";
import { mockDetectState, mockExecuteAction } from "./mock.js";
import { isActionValidForState } from "./scheduling.js";
import {
  acquireAccountOperation,
  beginAccountOperationShutdown,
  releaseAccountOperation,
} from "../account-operation.js";
import {
  assertWebAccountBinding,
  captureAutomationOperationBinding,
  captureWebAccountBinding,
} from "./identity.js";

// ─── Bot lifecycle wrapper ────────────────────────────────

function webCompanyIdentityError(cause = null) {
  const error = new Error('The freee Web account could not be bound to the selected OAuth company.');
  error.code = 'WEB_COMPANY_IDENTITY_UNCONFIRMED';
  if (cause) error.cause = cause;
  return error;
}

function webCompanyBindingRequiredError() {
  const error = new Error('Web automation requires an explicit company binding policy.');
  error.code = 'WEB_COMPANY_BINDING_REQUIRED';
  return error;
}

function webEmployeeBindingRequiredError() {
  const error = new Error('Web automation requires a verified employee binding.');
  error.code = 'WEB_EMPLOYEE_BINDING_REQUIRED';
  return error;
}

function confirmedWebNonWorkingStatus(record) {
  const status = getWorkRecordNonWorkingDayStatus(record);
  if (!status.confirmed) {
    const error = new Error('freee Web work-record fields are unsupported.');
    error.code = WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED;
    throw error;
  }
  return status;
}

function webLeaveRecordDisposition(type, record) {
  const status = confirmedWebNonWorkingStatus(record);
  if (status.isNonWorkingDay && status.code !== 'non_working_day_pattern') {
    const requestedLeaveAlreadyExists =
      (type === 'Absence' && status.code === 'absence') ||
      (type === 'SpecialHoliday' && status.code === 'special_holiday') ||
      (type === 'PaidHoliday' &&
        ['paid_holiday', 'paid_holiday_minutes'].includes(status.code));
    if (requestedLeaveAlreadyExists) {
      return { skip: true, reason: 'already_non_working_day' };
    }
    const error = new Error(
      'An existing leave entry requires confirmation in freee Web.',
    );
    error.code = 'WEB_EXISTING_LEAVE_REQUIRES_CONFIRMATION';
    throw error;
  }
  if (getWorkRecordLeaveCoverage(record).hasAnyLeave) {
    const error = new Error(
      'An existing leave entry requires confirmation in freee Web.',
    );
    error.code = 'WEB_EXISTING_LEAVE_REQUIRES_CONFIRMATION';
    throw error;
  }
  return { skip: false };
}

const SCHEDULE_CANCELLATION_CODES = new Set([
  'SCHEDULE_GENERATION_STALE',
  'SCHEDULE_DATE_STALE',
  'SCHEDULE_IDENTITY_CHANGED',
  'SCHEDULE_MASTER_DISABLED',
  'SCHEDULE_ACTION_DISABLED',
]);

function scheduledCancellationResult(
  error,
  durationMs = 0,
  failureStage = 'authorization',
) {
  if (!SCHEDULE_CANCELLATION_CODES.has(error?.code)) return null;
  return {
    status: 'skipped',
    screenshotBefore: null,
    screenshotAfter: null,
    durationMs,
    error: 'scheduled_action_cancelled',
    errorCode: error.code,
    failureStage: normalizeAutomationFailureStage(failureStage),
  };
}

async function evaluateMutationAuthorization(authorizationGuard, durationMs = 0) {
  if (typeof authorizationGuard !== 'function') return null;
  try {
    await authorizationGuard();
    return null;
  } catch (error) {
    return scheduledCancellationResult(error, durationMs) || {
      status: 'failure',
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs,
      error: 'automation_authorization_failed',
      errorCode: normalizeAutomationErrorCode(error?.code) ||
        'AUTOMATION_AUTHORIZATION_FAILED',
      failureStage: 'authorization',
    };
  }
}

function resolveApiWebCompanyBinding(expectedCompany) {
  if (expectedCompany === undefined) throw webCompanyBindingRequiredError();
  if (expectedCompany?.kind === 'web') {
    const webBinding = assertWebAccountBinding(expectedCompany.webBinding);
    if (!webBinding.companyName) {
      const error = new Error('An exact freee Web company name is required.');
      error.code = 'WEB_COMPANY_TARGET_REQUIRED';
      throw error;
    }
    if (!webBinding.employeeId) throw webEmployeeBindingRequiredError();
    return { kind: 'web', companyName: webBinding.companyName, webBinding };
  }
  const webBinding = captureWebAccountBinding();
  if (!webBinding.companyName) {
    const error = new Error('An exact freee Web company name is required.');
    error.code = 'WEB_COMPANY_TARGET_REQUIRED';
    throw error;
  }
  if (expectedCompany === null) {
    if (!webBinding.employeeId) throw webEmployeeBindingRequiredError();
    return { kind: 'web', companyName: webBinding.companyName, webBinding };
  }
  try {
    if (!expectedCompany || typeof expectedCompany !== 'object' || Array.isArray(expectedCompany)) {
      throw webCompanyIdentityError();
    }
    const identity = {
      companyId: String(expectedCompany.companyId ?? '').trim(),
      employeeId: String(expectedCompany.employeeId ?? '').trim(),
      companyName: typeof expectedCompany.companyName === 'string'
        ? expectedCompany.companyName.trim()
        : '',
      generation: String(expectedCompany.generation ?? '').trim(),
    };
    const currentIdentity = assertOAuthIdentityBinding(identity);
    const targetName = getWebCompanyName();
    const exactNameMatches = getAuthorizedOAuthCompanies().filter(
      (company) => typeof company?.name === 'string' &&
        company.name.trim() === identity.companyName,
    );
    const selected = exactNameMatches[0];
    if (
      !identity.companyName ||
      currentIdentity.companyId !== identity.companyId ||
      currentIdentity.employeeId !== identity.employeeId ||
      currentIdentity.companyName !== identity.companyName ||
      targetName !== identity.companyName ||
      exactNameMatches.length !== 1 ||
      String(selected?.id ?? '').trim() !== identity.companyId ||
      String(selected?.employee_id ?? '').trim() !== identity.employeeId
    ) {
      throw webCompanyIdentityError();
    }
    return { ...identity, kind: 'api-web', webBinding };
  } catch (error) {
    if (error?.code === 'WEB_COMPANY_IDENTITY_UNCONFIRMED') throw error;
    throw webCompanyIdentityError(error);
  }
}

function assertApiWebCompanyBindingCurrent(binding, employeeId) {
  try {
    assertOAuthIdentityBinding(binding);
    const currentIdentity = assertOAuthCompanyIdentity({
      employee_id: employeeId,
      name: binding.companyName,
    });
    if (
      currentIdentity.companyId !== binding.companyId ||
      currentIdentity.employeeId !== binding.employeeId
    ) {
      throw webCompanyIdentityError();
    }
    return currentIdentity;
  } catch (error) {
    if (error?.code === 'WEB_COMPANY_IDENTITY_UNCONFIRMED') throw error;
    throw webCompanyIdentityError(error);
  }
}

function webMutationIntent(companyBinding) {
  return {
    employeeId: companyBinding.webBinding.employeeId,
    companyId: companyBinding.kind === 'api-web'
      ? companyBinding.companyId
      : null,
  };
}

/**
 * Wraps the acquireLock → PunchBot → init → login → actionFn → cleanup → releaseLock lifecycle.
 * Handles stable Web login error-code propagation.
 *
 * @param {(bot: PunchBot, signal: AbortSignal) => Promise<T>} actionFn
 * @returns {Promise<T>}
 */
async function withPunchBot(
  actionFn,
  expectedCompany,
  mutationAuthorizationGuard = null,
) {
  let stage = 'queue';
  try {
    await acquireLock();
  } catch (error) {
    throw annotateAutomationFailureStage(error, stage);
  }

  let bot = null;
  let operationError = null;
  let cleanupError = null;
  try {
    stage = 'identity_binding';
    const companyBinding = resolveApiWebCompanyBinding(expectedCompany);
    stage = 'browser_init';
    bot = new PunchBot({
      screenshotIdentityKey: currentExecutionLogIdentityKey(),
    });
    return await withDeadline(async (signal) => {
      const markStage = (nextStage) => {
        stage = normalizeAutomationFailureStage(nextStage);
      };
      const abortCleanup = () => {
        void bot.cleanup().catch(() => {});
      };
      signal.addEventListener('abort', abortCleanup, { once: true });
      try {
        markStage('browser_init');
        signal.throwIfAborted();
        await bot.init(signal);
        markStage('login');
        signal.throwIfAborted();
        try {
          await bot.login(companyBinding.companyName);
        } catch (loginErr) {
          if (
            loginErr.code === "WEB_LOGIN_FAILED" ||
            loginErr.code === "WEB_CREDENTIALS_NOT_CONFIGURED" ||
            loginErr.code === "WEB_LOGIN_INTERACTION_REQUIRED" ||
            loginErr.code === "WEB_LOGIN_UNCONFIRMED" ||
            loginErr.code === "WEB_LOGIN_ORIGIN_UNTRUSTED" ||
            loginErr.code === "WEB_NAVIGATION_ORIGIN_BLOCKED" ||
            loginErr.code === "WEB_NAVIGATION_GUARD_UNAVAILABLE"
          ) {
            const err = new Error(`Web login failed: ${loginErr.message}`);
            err.code = loginErr.code;
            throw err;
          }
          throw loginErr;
        }
        markStage('employee_identity');
        signal.throwIfAborted();
        assertWebAccountBinding(companyBinding.webBinding);
        if (companyBinding.kind === 'api-web' || companyBinding.kind === 'web') {
          try {
            const webIdentity = await readWebEmployeeIdentity(bot.page);
            if (companyBinding.kind === 'api-web') {
              assertApiWebCompanyBindingCurrent(companyBinding, webIdentity.employeeId);
            } else if (webIdentity.employeeId !== companyBinding.webBinding.employeeId) {
              throw webCompanyIdentityError();
            }
          } catch (error) {
            if (error?.code === 'WEB_COMPANY_IDENTITY_UNCONFIRMED') throw error;
            throw webCompanyIdentityError(error);
          }
          await returnToWebTimeClockPage(bot.page);
        }
        markStage('company_binding');
        await bot.ensureCompany(companyBinding.companyName);
        bot.setPreMutationGuard(async () => {
          assertWebAccountBinding(companyBinding.webBinding);
          if (companyBinding.kind === 'api-web') {
            assertApiWebCompanyBindingCurrent(companyBinding, companyBinding.employeeId);
          }
          await bot.assertCompanyActive(companyBinding.companyName);
        }, mutationAuthorizationGuard);
        markStage('operation');
        signal.throwIfAborted();
        return await actionFn(bot, signal, companyBinding, markStage);
      } finally {
        signal.removeEventListener('abort', abortCleanup);
      }
    }, AUTOMATION_OPERATION_TIMEOUT_MS, {
      onTimeout: () => bot.cleanup(),
    });
  } catch (error) {
    operationError = annotateAutomationFailureStage(error, stage);
    throw operationError;
  } finally {
    if (bot) {
      try {
        await bot.cleanup();
      } catch (error) {
        cleanupError = annotateAutomationFailureStage(error, 'cleanup');
      }
      if (bot.runtime.isUnrecoverable()) {
        const fatalError = bot.runtime.getUnrecoverableError() || cleanupError;
        beginAccountOperationShutdown();
        process.emit('punchpilot:automation-unrecoverable', fatalError);
      }
    }
    releaseLock();
    if (cleanupError && operationError) {
      console.warn('[Bot] Cleanup also failed', safeErrorMetadata(cleanupError));
    } else if (cleanupError) {
      throw cleanupError;
    }
  }
}

function classifyWebLoginError(error) {
  if (error?.code === "WEB_LOGIN_INTERACTION_REQUIRED") {
    return "web_login_interaction_required";
  }
  if (
    error?.code === "WEB_LOGIN_FAILED" ||
    error?.code === "WEB_CREDENTIALS_NOT_CONFIGURED"
  ) {
    return "web_credentials_invalid";
  }
  if (error?.code === "WEB_LOGIN_UNCONFIRMED") {
    return "web_login_unconfirmed";
  }
  if (error?.code === "WEB_LOGIN_ORIGIN_UNTRUSTED") {
    return "web_login_origin_untrusted";
  }
  if (error?.code === "WEB_NAVIGATION_ORIGIN_BLOCKED") {
    return "web_navigation_origin_blocked";
  }
  if (error?.code === "WEB_NAVIGATION_GUARD_UNAVAILABLE") {
    return "web_navigation_guard_unavailable";
  }
  return null;
}

function stableWebAutomationFailure(error) {
  const code = normalizeAutomationErrorCode(error?.code) ||
    "WEB_AUTOMATION_FAILED";
  const messages = {
    WEB_CREDENTIALS_NOT_CONFIGURED: "web_credentials_required",
    WEB_LOGIN_FAILED: "web_credentials_invalid",
    WEB_LOGIN_INTERACTION_REQUIRED: "web_login_interaction_required",
    WEB_LOGIN_UNCONFIRMED: "web_login_unconfirmed",
    WEB_LOGIN_ORIGIN_UNTRUSTED: "web_login_origin_untrusted",
    WEB_NAVIGATION_ORIGIN_BLOCKED: "web_navigation_origin_blocked",
    WEB_NAVIGATION_GUARD_UNAVAILABLE: "web_navigation_guard_unavailable",
    WEB_MUTATION_ORIGIN_UNTRUSTED: "web_mutation_origin_untrusted",
    WEB_MUTATION_REQUEST_UNTRUSTED: "web_mutation_request_untrusted",
    WEB_MUTATION_REQUEST_VALIDATOR_ASYNC: "web_mutation_dispatch_guard_unavailable",
    WEB_MUTATION_DISPATCH_GUARD_UNAVAILABLE: "web_mutation_dispatch_guard_unavailable",
    WEB_MUTATION_DISPATCH_GUARD_ASYNC: "web_mutation_dispatch_guard_unavailable",
    AUTOMATION_IDENTITY_CHANGED: "automation_identity_changed_before_mutation",
    WEB_COMPANY_TARGET_REQUIRED: "web_company_target_required",
    WEB_COMPANY_SELECTION_UNCONFIRMED: "web_company_selection_unconfirmed",
    WEB_COMPANY_IDENTITY_UNCONFIRMED: "web_company_identity_unconfirmed",
    WEB_ACCOUNT_IDENTITY_CHANGED: "web_account_identity_changed_outcome_unknown",
    WEB_COMPANY_BINDING_REQUIRED: "web_company_binding_required",
    WEB_EMPLOYEE_BINDING_REQUIRED: "web_employee_binding_required",
    WEB_ACTION_CONFIRMATION_UNAVAILABLE: "web_action_confirmation_unavailable",
    WEB_FORM_TARGET_MISMATCH: "web_form_target_mismatch",
    WEB_FORM_TYPE_UNSUPPORTED: "web_form_type_unsupported",
    WEB_APPROVER_SELECTION_REQUIRED: "web_approver_selection_required",
    WEB_FORM_SUBMISSION_REJECTED: "web_form_submission_rejected",
    WEB_FORM_SUBMISSION_UNCONFIRMED: "web_form_submission_unconfirmed",
    AUTOMATION_OPERATION_TIMEOUT: "web_automation_outcome_unknown",
    AUTOMATION_RUNTIME_UNRECOVERABLE: "web_automation_outcome_unknown",
    AUTOMATION_QUEUE_TIMEOUT: "web_automation_queue_timeout",
    ATTENDANCE_STATE_UNCONFIRMED: "attendance_state_unconfirmed",
    [WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED]: "web_leave_guard_unavailable",
    [WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED]: "web_leave_guard_unavailable",
    [WEB_WORK_RECORD_ERROR_CODES.RESPONSE_TOO_LARGE]: "web_leave_guard_unavailable",
  };
  return {
    code,
    message: messages[code] || "web_automation_failed",
  };
}

function stableApiAutomationFailure(error) {
  const code = normalizeAutomationErrorCode(error?.code) ||
    "API_ACTION_FAILED";
  const messages = {
    [FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED]: "oauth_reauthorization_required",
    [FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT]: "oauth_refresh_temporarily_unavailable",
    [FREEE_API_ERROR_CODES.PERMISSION_DENIED]: "api_permission_denied",
    [FREEE_API_ERROR_CODES.RATE_LIMITED]: "api_rate_limited",
    [FREEE_API_ERROR_CODES.API_TRANSIENT]: "api_temporarily_unavailable",
    ATTENDANCE_STATE_UNCONFIRMED: "attendance_state_unconfirmed",
    AUTOMATION_QUEUE_TIMEOUT: "automation_queue_timeout",
    ACCOUNT_OPERATION_QUEUE_TIMEOUT: "account_operation_queue_timeout",
    AUTOMATION_IDENTITY_CHANGED: "automation_identity_changed_before_mutation",
    [FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED]: "oauth_identity_changed_outcome_unknown",
  };
  return { code, message: messages[code] || "api_action_failed" };
}

function webMutationFailureStage(error) {
  if (
    error?.code === 'WEB_COMPANY_TARGET_REQUIRED' ||
    error?.code === 'WEB_COMPANY_SELECTION_UNCONFIRMED' ||
    error?.code === 'WEB_COMPANY_IDENTITY_UNCONFIRMED'
  ) {
    return 'company_binding';
  }
  if (
    error?.code === 'WEB_ACCOUNT_IDENTITY_CHANGED' ||
    error?.code === 'AUTOMATION_IDENTITY_CHANGED'
  ) {
    return 'identity_binding';
  }
  return 'mutation';
}

// ─── Public API ───────────────────────────────────────────

/** Detect current freee attendance state */
export async function detectCurrentState() {
  if (isDebugMode()) {
    const s = mockDetectState();
    console.log(`[MOCK] State: ${s}`);
    return s;
  }

  if (!hasCredentials()) return FREEE_STATE.UNKNOWN;

  // API state detection is read-only and does not take the write mutex.
  if (getConnectionMode() === "api") {
    try {
      const client = new FreeeApiClient();
      return await client.detectState();
    } catch (e) {
      console.error(`[API] detectState failed: ${JSON.stringify(safeErrorMetadata(e))}`);
      return FREEE_STATE.UNKNOWN;
    }
  }

  // Browser mode — Playwright with mutex
  try {
    return await withPunchBot((bot) => bot.detectState(), null);
  } catch (e) {
    console.error(`[Bot] detectState failed: ${JSON.stringify(safeErrorMetadata(e))}`);
    return FREEE_STATE.UNKNOWN;
  }
}

export async function detectWebNonWorkingStatus(date = todayStringInTz()) {
  if (!hasWebCredentials()) {
    const error = new Error('freee Web credentials are not configured.');
    error.code = 'WEB_CREDENTIALS_NOT_CONFIGURED';
    throw error;
  }
  return withPunchBot(async (bot) => {
    const record = await readWebWorkRecord(bot.page, date);
    return confirmedWebNonWorkingStatus(record);
  }, null);
}

/** Execute a check-in/check-out action */
export async function executeAction(
  actionType,
  {
    expectedIdentityKey = null,
    expectedDate = null,
    mutationAuthorizationGuard = null,
  } = {},
) {
  try {
    await acquireAccountOperation();
  } catch (error) {
    return {
      status: "failure",
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 0,
      error: "account_operation_queue_timeout",
      errorCode: normalizeAutomationErrorCode(error?.code) ||
        "ACCOUNT_OPERATION_QUEUE_TIMEOUT",
      failureStage: "account_queue",
    };
  }

  try {
  const operationBinding = captureAutomationOperationBinding();
  const browserMode = operationBinding.mode === "browser";
  const webGuardRequired = browserMode;
  if (
    expectedIdentityKey !== null &&
    expectedIdentityKey !== operationBinding.identityKey
  ) {
    return {
      status: "failure",
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 0,
      error: "automation_identity_changed_before_mutation",
      errorCode: "AUTOMATION_IDENTITY_CHANGED",
      failureStage: "identity_binding",
    };
  }
  const initialAuthorization = await evaluateMutationAuthorization(
    mutationAuthorizationGuard,
  );
  if (initialAuthorization) return initialAuthorization;
  if (operationBinding.debugMode) return mockExecuteAction(actionType);

  if (!hasCredentials()) {
    return {
      status: "failure",
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 0,
      error: browserMode
        ? "web_credentials_required"
        : "oauth_credentials_required",
      errorCode: browserMode
        ? "WEB_CREDENTIALS_NOT_CONFIGURED"
        : "AUTH_REQUIRED",
      failureStage: "credentials",
      ...(webGuardRequired ? { guardUnavailable: true } : {}),
    };
  }

  // API writes share the automation mutex with Web writes to prevent duplicate punches.
  if (operationBinding.mode === "api") {
    const start = Date.now();
    try {
      await acquireLock();
    } catch (error) {
      const failure = stableApiAutomationFailure(error);
      return {
        status: "failure",
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: Date.now() - start,
        error: failure.message,
        errorCode: failure.code,
        failureStage: "queue",
      };
    }
    let apiStage = "state_read";
    try {
      const client = new FreeeApiClient();

      // Pre-flight state check
      const state = await client.detectState();
      if (state === FREEE_STATE.UNKNOWN) {
        const error = new Error("Attendance state could not be confirmed.");
        error.code = "ATTENDANCE_STATE_UNCONFIRMED";
        throw error;
      }
      const valid = isActionValidForState(actionType, state);
      if (!valid.ok) {
        console.log(
          `[API] Skipping ${actionType}: ${valid.reason}`,
        );
        return {
          status: "skipped",
          screenshotBefore: null,
          screenshotAfter: null,
          durationMs: Date.now() - start,
          error: valid.reason,
          detectedState: state,
        };
      }

      apiStage = "authorization";
      const finalAuthorization = await evaluateMutationAuthorization(
        mutationAuthorizationGuard,
        Date.now() - start,
      );
      if (finalAuthorization) return finalAuthorization;
      apiStage = "mutation";
      const result = await client.executeClockAction(actionType, {
        mutationAuthorizationGuard,
      });
      result.durationMs = Date.now() - start;
      console.log(
        `[API] ${ACTION_LABELS[actionType]} completed in ${result.durationMs}ms`,
      );
      return result;
    } catch (error) {
      const cancellation = scheduledCancellationResult(
        error,
        Date.now() - start,
        "authorization",
      );
      if (cancellation) return cancellation;
      const failure = stableApiAutomationFailure(error);
      console.error(`[API] ${actionType} failed: ${JSON.stringify(safeErrorMetadata(error))}`);
      return {
        status: "failure",
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: Date.now() - start,
        error: failure.message,
        errorCode: failure.code,
        failureStage: normalizeAutomationFailureStage(apiStage),
      };
    } finally {
      releaseLock();
    }
  }

  // Browser mode — Playwright with mutex
  const start = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const targetDate = expectedDate || todayStringInTz();
  let webGuardVerified = !webGuardRequired;

  try {
    return await withPunchBot(async (bot, _signal, companyBinding, markStage) => {
      if (webGuardRequired) {
        markStage("work_record_guard");
        const record = await readWebWorkRecord(bot.page, targetDate);
        const nonWorking = confirmedWebNonWorkingStatus(record);
        if (nonWorking.isNonWorkingDay) {
          return {
            status: "skipped",
            screenshotBefore: null,
            screenshotAfter: null,
            durationMs: Date.now() - start,
            error: "non_working_day",
            errorCode: WEB_NON_WORKING_DAY_CONFIRMED,
            nonWorkingDayCode: nonWorking.code,
            nonWorkingReason: nonWorking.reason,
          };
        }
        webGuardVerified = true;
        await returnToWebTimeClockPage(bot.page);
        await bot.assertCompanyActive();
      }

      // Pre-flight state check
      markStage("state_read");
      const state = await bot.detectState();
      if (state === FREEE_STATE.UNKNOWN) {
        const error = new Error("Attendance state could not be confirmed.");
        error.code = "ATTENDANCE_STATE_UNCONFIRMED";
        throw error;
      }
      const valid = isActionValidForState(actionType, state);
      if (!valid.ok) {
        console.log(
          `[Bot] Skipping ${actionType}: ${valid.reason}`,
        );
        return {
          status: "skipped",
          screenshotBefore: null,
          screenshotAfter: null,
          durationMs: Date.now() - start,
          error: valid.reason,
          detectedState: state,
        };
      }

      try {
        markStage("mutation");
        const result = await bot.clickAction(actionType, ts, {
          employeeId: companyBinding.webBinding.employeeId,
          companyId: companyBinding.kind === 'api-web'
            ? companyBinding.companyId
            : null,
          date: targetDate,
        });
        console.log(
          `[Bot] ${ACTION_LABELS[actionType]} completed`,
        );
        return {
          status: "success",
          ...result,
          durationMs: Date.now() - start,
          error: null,
          detectedState: state,
        };
      } catch (clickError) {
        const cancellation = scheduledCancellationResult(
          clickError,
          Date.now() - start,
          "authorization",
        );
        if (cancellation) return cancellation;
        // Try to capture error screenshot while bot is still alive
        let screenshotAfter = null;
        try {
          if (bot.page) {
            screenshotAfter = await bot.captureScreenshot(
              `error-${actionType}-${ts}`,
              "after",
              "error",
            );
          }
        } catch {}
        const failure = stableWebAutomationFailure(clickError);
        return {
          status: "failure",
          screenshotBefore: null,
          screenshotAfter,
          durationMs: Date.now() - start,
          error: failure.message,
          errorCode: failure.code,
          failureStage: webMutationFailureStage(clickError),
        };
      }
    }, null, mutationAuthorizationGuard);
  } catch (error) {
    const failure = stableWebAutomationFailure(error);
    console.error(`[Bot] ${actionType} failed: ${failure.code}`);
    return {
      status: "failure",
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: Date.now() - start,
      error: failure.message,
      errorCode: failure.code,
      failureStage: automationFailureStage(error),
      ...(webGuardRequired && !webGuardVerified
        ? { guardUnavailable: true }
      : {}),
    };
  }
  } finally {
    releaseAccountOperation();
  }
}

/**
 * Submit work time corrections via freee Web (Playwright).
 * Used as Strategy 4 fallback when all API strategies fail.
 *
 * @param {Array} entries — [{ date, clock_in_at, clock_out_at, break_records? }]
 * @param {string} [reason] — 申請理由
 * @returns {Array<{ date, success, error?, method }>}
 */
export async function submitWebCorrections(entries, reason, expectedCompany) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    return entries.map((e) => ({
      date: e.date,
      success: false,
      error: "web_credentials_required",
      method: "web_correction",
    }));
  }

  const results = [];

  const parseTime = (isoStr) => {
    if (!isoStr) return null;
    const match = isoStr.match(/T(\d{2}):(\d{2})/);
    return match
      ? { hour: parseInt(match[1], 10), min: parseInt(match[2], 10) }
      : null;
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const clockIn = parseTime(entry.clock_in_at);
    const clockOut = parseTime(entry.clock_out_at);
    if (!clockIn || !clockOut) {
      results.push({
        date: entry.date,
        success: false,
        error: "Missing clock_in or clock_out time",
        method: "web_correction",
      });
      continue;
    }

    const times = {
      clockInHour: clockIn.hour,
      clockInMin: clockIn.min,
      clockOutHour: clockOut.hour,
      clockOutMin: clockOut.min,
    };
    if (entry.break_records?.length > 0) {
      const bStart = parseTime(entry.break_records[0].clock_in_at);
      const bEnd = parseTime(entry.break_records[0].clock_out_at);
      if (bStart && bEnd) {
        times.breakStartHour = bStart.hour;
        times.breakStartMin = bStart.min;
        times.breakEndHour = bEnd.hour;
        times.breakEndMin = bEnd.min;
      }
    }

    try {
      const result = await withPunchBot(async (bot, signal, companyBinding) => {
        signal.throwIfAborted();
        const submitted = await submitWorkTimeCorrection(
          bot,
          entry.date,
          times,
          reason || "打刻漏れのため修正",
          webMutationIntent(companyBinding),
        );
        signal.throwIfAborted();
        return submitted;
      }, expectedCompany);
      results.push({
        date: entry.date,
        success: result.success,
        error: result.error || null,
        method: "web_correction",
      });
    } catch (err) {
      const failure = stableWebAutomationFailure(err);
      const errorCode = classifyWebLoginError(err) || failure.message;
      console.error(`[Bot] Web correction failed: ${failure.code}`);
      results.push({
        date: entry.date,
        success: false,
        error: errorCode,
        method: "web_correction",
      });

      if (
        classifyWebLoginError(err) ||
        err?.code === "AUTOMATION_OPERATION_TIMEOUT" ||
        err?.code === "AUTOMATION_QUEUE_TIMEOUT"
      ) {
        const remainingError = err?.code === "AUTOMATION_OPERATION_TIMEOUT"
          ? "web_automation_paused_after_unconfirmed_outcome"
          : errorCode;
        for (const remaining of entries.slice(index + 1)) {
          results.push({
            date: remaining.date,
            success: false,
            error: remainingError,
            method: "web_correction",
          });
        }
        break;
      }
    }

    if (index < entries.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}

/**
 * Scrape employee profile info from freee Web.
 * @param {string|number} employeeId
 * @returns {object} Employee info
 */
export async function scrapeEmployeeProfile(employeeId) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    throw new Error("freee Web credentials not configured");
  }

  return withPunchBot((bot) => scrapeEmployeeInfo(bot, employeeId), null);
}

/**
 * Submit a leave request via freee Web (Playwright).
 * @param {string} type — 'PaidHoliday' | 'SpecialHoliday' | 'Absence' | 'HolidayWork'
 * @param {string} date — YYYY-MM-DD
 * @param {object} options — { reason?: string, startTime?: string, endTime?: string }
 * @returns {{ success: boolean, error?: string }}
 */
export async function submitLeaveRequest(type, date, options = {}, expectedCompany) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    throw new Error("freee Web credentials not configured");
  }

  return withPunchBot(async (bot, _signal, companyBinding) => {
    const record = await readWebWorkRecord(bot.page, date);
    const initialDisposition = webLeaveRecordDisposition(type, record);
    if (initialDisposition.skip) {
      return {
        success: true,
        skipped: true,
        reason: initialDisposition.reason,
        guard: 'verified',
      };
    }
    await returnToWebTimeClockPage(bot.page);
    await bot.ensureCompany();
    let finalDisposition = null;
    const submitted = await submitLeaveRequestForm(
      bot,
      type,
      date,
      options,
      async () => {
        const currentRecord = await rereadWebWorkRecord(
          bot.page,
          date,
          companyBinding.webBinding.employeeId,
        );
        finalDisposition = webLeaveRecordDisposition(type, currentRecord);
        return finalDisposition;
      },
      {
        employeeId: companyBinding.webBinding.employeeId,
        companyId: companyBinding.kind === 'api-web'
          ? companyBinding.companyId
          : null,
      },
    );
    if (
      !finalDisposition ||
      (submitted?.skipped === true) !== (finalDisposition.skip === true)
    ) {
      const error = new Error(
        'The Web leave pre-submit guard outcome could not be confirmed.',
      );
      error.code = WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED;
      throw error;
    }
    return { ...submitted, guard: 'verified' };
  }, expectedCompany);
}

/**
 * Withdraw an approval request via freee Web (Playwright).
 * Used as fallback when API withdrawal fails (e.g., companies with
 * dept/position-based approval routing that the API cannot handle).
 *
 * @param {string} type — 'PaidHoliday' | 'WorkTime' | 'OvertimeWork' etc.
 * @param {string|number} requestId — freee approval request ID
 * @returns {{ success: boolean, error?: string }}
 */
export async function withdrawApprovalRequestWeb(type, requestId, expectedCompany) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    return { success: false, error: "web_credentials_required" };
  }

  try {
    return await withPunchBot(
      (bot, _signal, companyBinding) => withdrawApprovalRequest(
        bot,
        type,
        requestId,
        webMutationIntent(companyBinding),
      ),
      expectedCompany,
    );
  } catch (err) {
    const loginError = classifyWebLoginError(err);
    if (loginError) return { success: false, error: loginError };
    const failure = stableWebAutomationFailure(err);
    console.error(`[Bot] Web withdrawal failed: ${failure.code}`);
    return { success: false, error: failure.message, errorCode: failure.code };
  }
}

/**
 * Submit monthly attendance closing via freee Web form.
 * Fallback for companies with dept/role-based approval routing where the API
 * returns 400: "役職、部門を利用する申請はWebから申請してください".
 *
 * @param {number|string} year — e.g. 2026
 * @param {number|string} month — e.g. 2
 * @returns {{ success: boolean, screenshotBefore?: string, screenshotAfter?: string, error?: string }}
 */
export async function submitMonthlyAttendanceClosingWeb(year, month, expectedCompany) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    return { success: false, error: "web_credentials_required" };
  }

  try {
    return await withPunchBot(
      (bot, _signal, companyBinding) => submitMonthlyClosingWeb(
        bot,
        year,
        month,
        webMutationIntent(companyBinding),
      ),
      expectedCompany,
    );
  } catch (err) {
    const loginError = classifyWebLoginError(err);
    if (loginError) return { success: false, error: loginError };
    const failure = stableWebAutomationFailure(err);
    console.error(`[Bot] Monthly closing Web submission failed: ${failure.code}`);
    return { success: false, error: failure.message, errorCode: failure.code };
  }
}
