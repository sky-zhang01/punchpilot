import { parseExternalId as positiveInteger } from "../../freee-values.js";
import {
  approvalTypeEndpoint,
  approvalTypeResponseKey,
} from "./utils.js";
import {
  createApprovalMutationContext,
  parseApprovalMutationContext,
} from "./approval-list-service.js";

const AMBIGUOUS_MUTATION_CODES = new Set([
  "API_TRANSIENT",
  "API_RESPONSE_UNCONFIRMED",
  "AUTH_TRANSIENT",
]);

const KNOWN_WEB_ERRORS = new Set([
  "WEB_CREDENTIALS_NOT_CONFIGURED",
  "WEB_LOGIN_FAILED",
  "WEB_LOGIN_INTERACTION_REQUIRED",
  "web_company_binding_required",
  "web_company_identity_unconfirmed",
  "web_company_selection_unconfirmed",
  "WEB_SUBMISSION_UNCONFIRMED",
]);

function stableCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallback;
}

function nonNegativeInteger(value) {
  return value === 0 || value === '0' ? 0 : positiveInteger(value);
}

function deterministicRejection(error) {
  const code = stableCode(error, "MUTATION_FAILED");
  if (AMBIGUOUS_MUTATION_CODES.has(code)) return false;
  return (
    code === "PERMISSION_DENIED" ||
    code === "WEB_FORM_REQUIRED" ||
    /^API_ERROR_4\d\d$/.test(code)
  );
}

function stage(stages, name, success, code = null) {
  stages.push({ stage: name, success, ...(code ? { code } : {}) });
}

function failure(id, type, stages, error, method = "blocked") {
  const unknown = error === "mutation_outcome_unconfirmed" ||
    (error === "web_withdraw_failed" &&
      ["WEB_WITHDRAW_FAILED", "WEB_SUBMISSION_UNCONFIRMED"].includes(stages.at(-1)?.code));
  return { id: positiveInteger(id), type, success: false, method, error, stages,
    ...(unknown ? { unknown: true } : {}) };
}

function detailPath(companyId, endpoint, id) {
  return `/approval_requests/${endpoint}/${id}?company_id=${companyId}`;
}

function actionPath(companyId, endpoint, id) {
  return `/approval_requests/${endpoint}/${id}/actions?company_id=${companyId}`;
}

export function unwrapApprovalDetail(type, response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return null;
  }
  const responseKey = approvalTypeResponseKey(type);
  if (!responseKey) return null;
  const detail = Object.hasOwn(response, responseKey)
    ? Reflect.get(response, responseKey)
    : response;
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail
    : null;
}

export function approvalStep(detail) {
  const currentStep = positiveInteger(detail?.current_step_id);
  const currentRound = nonNegativeInteger(detail?.current_round);
  return currentStep && currentRound !== null
    ? { currentStep, currentRound }
    : null;
}

function approverIds(detail) {
  const ids = new Set();
  const add = (value) => {
    const id = positiveInteger(value);
    if (id) ids.add(id);
  };

  for (const id of detail?.approver_ids || []) add(id);
  for (const approver of detail?.approvers || []) {
    add(approver?.id);
    add(approver?.user_id);
  }
  for (const approver of detail?.current_step_approvers || []) {
    add(approver?.id);
    add(approver?.user_id);
  }

  const steps =
    detail?.approval_flow_route?.usage_steps || detail?.approval_steps || [];
  const currentStepId = positiveInteger(detail?.current_step_id);
  for (const step of steps) {
    if (positiveInteger(step?.id) !== currentStepId) continue;
    for (const approver of step?.approvers || []) {
      add(approver?.id);
      add(approver?.user_id);
    }
  }
  return ids;
}

export function isCurrentApprover(detail, userId) {
  const currentUserId = positiveInteger(userId);
  return currentUserId ? approverIds(detail).has(currentUserId) : false;
}

export function hasExplicitApprover(detail) {
  return approverIds(detail).size > 0;
}

function verifiedDetail(detail, { id, companyId }) {
  if (!detail) return false;
  return (
    positiveInteger(detail.id) === positiveInteger(id) &&
    positiveInteger(detail.company_id) === positiveInteger(companyId)
  );
}

function actionLogCount(detail, action, currentUserId) {
  if (!Array.isArray(detail?.approval_flow_logs)) return 0;
  return detail.approval_flow_logs.filter((entry) =>
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.action === action &&
    nonNegativeInteger(entry.user_id) === nonNegativeInteger(currentUserId)
  ).length;
}

function actionOutcomeConfirmed({
  action,
  after,
  before,
  companyId,
  currentUserId,
  id,
}) {
  if (!verifiedDetail(after, { id, companyId })) return false;
  const logAdvanced = (logAction) =>
    actionLogCount(after, logAction, currentUserId) >
      actionLogCount(before, logAction, currentUserId);
  if (action === "cancel") {
    return after.status === "draft" && logAdvanced("cancel");
  }
  if (action === "feedback") {
    return (after.status === "feedback" && logAdvanced("feedback")) ||
      (after.status === "draft" && logAdvanced("cancel"));
  }
  return action === "approve" &&
    ["approved", "in_progress"].includes(after.status) &&
    logAdvanced("approve");
}

async function confirmActionOutcome({
  action,
  before,
  client,
  companyId,
  currentUserId,
  endpoint,
  id,
  response,
  type,
}) {
  const confirmation = (candidate) => actionOutcomeConfirmed({
    action,
    after: unwrapApprovalDetail(type, candidate),
    before,
    companyId,
    currentUserId,
    id,
  });
  if (confirmation(response)) return true;
  try {
    return confirmation(await client.apiRequest(
      "GET",
      detailPath(companyId, endpoint, id),
    ));
  } catch {
    return false;
  }
}

export async function withdrawApprovalOperation({
  client,
  companyId,
  currentUserId,
  id,
  type,
  webCredentialsAvailable,
  withdrawWeb,
}) {
  const stages = [];
  const endpoint = approvalTypeEndpoint(type);
  if (
    !endpoint ||
    !positiveInteger(id) ||
    !positiveInteger(companyId) ||
    !positiveInteger(currentUserId)
  ) {
    return failure(id, type, stages, "invalid_withdraw_request");
  }

  let detail = null;
  try {
    const response = await client.apiRequest(
      "GET",
      detailPath(companyId, endpoint, id),
    );
    detail = unwrapApprovalDetail(type, response);
    if (!verifiedDetail(detail, { id, companyId })) {
      stage(stages, "detail", false, "API_RESPONSE_UNCONFIRMED");
      detail = null;
    } else {
      stage(stages, "detail", true);
    }
  } catch (error) {
    const code = stableCode(error, "DETAIL_LOOKUP_FAILED");
    stage(stages, "detail", false, code);
    if (code === "API_ERROR_404") {
      return {
        id: Number(id),
        type,
        success: true,
        method: "already_absent",
        stages,
      };
    }
    return failure(id, type, stages, "approval_detail_unconfirmed");
  }

  if (!detail) {
    return failure(id, type, stages, "approval_detail_unconfirmed");
  }
  if (positiveInteger(detail.applicant_id) !== positiveInteger(currentUserId)) {
    stage(stages, "ownership", false, "APPROVAL_OWNERSHIP_UNCONFIRMED");
    return failure(id, type, stages, "approval_ownership_unconfirmed");
  }
  stage(stages, "ownership", true);

  if (detail.status === "approved") {
    stage(stages, "status", false, "APPROVAL_STATUS_NOT_WITHDRAWABLE");
    return failure(id, type, stages, "approval_status_not_withdrawable");
  }

  if (detail.status === "in_progress") {
    const step = approvalStep(detail);
    if (!step) {
      stage(stages, "cancel", false, "APPROVAL_STEP_UNCONFIRMED");
      return failure(id, type, stages, "approval_step_unconfirmed");
    }
    try {
      const response = await client.apiRequest(
        "POST",
        actionPath(companyId, endpoint, id),
        {
          company_id: Number(companyId),
          approval_action: "cancel",
          target_round: step.currentRound,
          target_step_id: step.currentStep,
        },
      );
      if (!await confirmActionOutcome({
        action: "cancel",
        before: detail,
        client,
        companyId,
        currentUserId,
        endpoint,
        id,
        response,
        type,
      })) {
        stage(stages, "cancel", false, "API_RESPONSE_UNCONFIRMED");
        return failure(
          id,
          type,
          stages,
          "mutation_outcome_unconfirmed",
          "cancel",
        );
      }
      stage(stages, "cancel", true);
      return { id: Number(id), type, success: true, method: "cancel", stages };
    } catch (error) {
      const code = stableCode(error, "CANCEL_FAILED");
      stage(stages, "cancel", false, code);
      if (!deterministicRejection(error)) {
        return failure(
          id,
          type,
          stages,
          AMBIGUOUS_MUTATION_CODES.has(code)
            ? "mutation_outcome_unconfirmed"
            : "withdraw_cancel_failed",
          "cancel",
        );
      }
      if (!webCredentialsAvailable) {
        return failure(id, type, stages, "withdraw_cancel_failed", "cancel");
      }
    }
  } else if (["draft", "feedback"].includes(detail.status)) {
    try {
      await client.apiRequest(
        "DELETE",
        detailPath(companyId, endpoint, id),
        null,
        { expectedStatus: 204 },
      );
      stage(stages, "delete", true);
      return { id: Number(id), type, success: true, method: "delete", stages };
    } catch (error) {
      const code = stableCode(error, "DELETE_FAILED");
      stage(stages, "delete", false, code);
      if (code === "API_ERROR_404") {
        return {
          id: Number(id),
          type,
          success: true,
          method: "already_absent",
          stages,
        };
      }
      if (!deterministicRejection(error)) {
        return failure(
          id,
          type,
          stages,
          AMBIGUOUS_MUTATION_CODES.has(code)
            ? "mutation_outcome_unconfirmed"
            : "withdraw_delete_failed",
          "delete",
        );
      }
      if (!webCredentialsAvailable) {
        return failure(id, type, stages, "withdraw_delete_failed", "delete");
      }
    }
  } else {
    stage(stages, "status", false, "APPROVAL_STATUS_UNCONFIRMED");
    return failure(id, type, stages, "approval_status_unconfirmed");
  }

  if (!webCredentialsAvailable) {
    stage(stages, "web", false, "WEB_CREDENTIALS_NOT_CONFIGURED");
    return failure(id, type, stages, "web_credentials_required", "web");
  }
  try {
    const result = await withdrawWeb(type, id);
    if (result?.success === true) {
      stage(stages, "web", true);
      return {
        id: Number(id),
        type,
        success: true,
        method: "web_withdraw",
        stages,
      };
    }
    const code = KNOWN_WEB_ERRORS.has(result?.error)
      ? result.error
      : "WEB_WITHDRAW_FAILED";
    stage(stages, "web", false, code);
  } catch (error) {
    const code = stableCode(error, "WEB_WITHDRAW_FAILED");
    stage(stages, "web", false, KNOWN_WEB_ERRORS.has(code) ? code : "WEB_WITHDRAW_FAILED");
  }
  return failure(id, type, stages, "web_withdraw_failed", "web");
}

export async function approveApprovalOperation({
  client,
  companyId,
  currentUserId,
  id,
  type,
  action,
  expected,
  confirmUnspecifiedApprover = null,
}) {
  const stages = [];
  const endpoint = approvalTypeEndpoint(type);
  const expectedContext = parseApprovalMutationContext(expected);
  if (
    !endpoint ||
    !positiveInteger(id) ||
    !positiveInteger(companyId) ||
    !positiveInteger(currentUserId) ||
    !["approve", "feedback"].includes(action) ||
    !expectedContext
  ) {
    return failure(id, type, stages, "invalid_approval_request");
  }

  const readDetail = async () => {
    const response = await client.apiRequest(
      "GET",
      detailPath(companyId, endpoint, id),
    );
    return unwrapApprovalDetail(type, response);
  };
  const matchesExpected = (context) =>
    context?.current_round === expectedContext.current_round &&
    context?.current_step_id === expectedContext.current_step_id &&
    context?.request_version === expectedContext.request_version;
  const versionConflict = () => {
    stage(stages, "version", false, "APPROVAL_VERSION_CONFLICT");
    return {
      ...failure(id, type, stages, "approval_version_conflict"),
      action,
    };
  };

  let detail;
  try {
    detail = await readDetail();
  } catch (error) {
    stage(stages, "detail", false, stableCode(error, "DETAIL_LOOKUP_FAILED"));
    return failure(id, type, stages, "approval_detail_unconfirmed");
  }
  if (!verifiedDetail(detail, { id, companyId })) {
    stage(stages, "detail", false, "APPROVAL_DETAIL_UNCONFIRMED");
    return failure(id, type, stages, "approval_detail_unconfirmed");
  }
  if (detail.status !== "in_progress") return versionConflict();

  let currentContext = createApprovalMutationContext({
    request: detail,
    companyId,
    currentUserId,
    type,
  });
  if (!currentContext) {
    stage(stages, "detail", false, "APPROVAL_STEP_UNCONFIRMED");
    return failure(id, type, stages, "approval_step_unconfirmed");
  }
  if (!matchesExpected(currentContext)) return versionConflict();

  let ownershipConfirmed = isCurrentApprover(detail, currentUserId);
  if (
    !ownershipConfirmed &&
    !hasExplicitApprover(detail) &&
    typeof confirmUnspecifiedApprover === "function"
  ) {
    try {
      ownershipConfirmed = await confirmUnspecifiedApprover({ id, type, detail });
    } catch {
      ownershipConfirmed = false;
    }
    if (ownershipConfirmed) {
      try {
        detail = await readDetail();
      } catch (error) {
        stage(stages, "detail", false, stableCode(error, "DETAIL_LOOKUP_FAILED"));
        return failure(id, type, stages, "approval_detail_unconfirmed");
      }
      if (!verifiedDetail(detail, { id, companyId })) {
        stage(stages, "detail", false, "APPROVAL_DETAIL_UNCONFIRMED");
        return failure(id, type, stages, "approval_detail_unconfirmed");
      }
      if (detail.status !== "in_progress") return versionConflict();
      currentContext = createApprovalMutationContext({
        request: detail,
        companyId,
        currentUserId,
        type,
      });
      if (!currentContext || !matchesExpected(currentContext)) {
        return versionConflict();
      }
      ownershipConfirmed =
        isCurrentApprover(detail, currentUserId) || !hasExplicitApprover(detail);
    }
  }
  if (!ownershipConfirmed) {
    stage(stages, "ownership", false, "APPROVAL_OWNERSHIP_UNCONFIRMED");
    return failure(id, type, stages, "approval_ownership_unconfirmed");
  }
  stage(stages, "detail", true);
  stage(stages, "ownership", true);
  stage(stages, "version", true);

  try {
    const response = await client.apiRequest(
      "POST",
      actionPath(companyId, endpoint, id),
      {
        company_id: Number(companyId),
        approval_action: action,
        target_round: currentContext.current_round,
        target_step_id: currentContext.current_step_id,
      },
    );
    if (!await confirmActionOutcome({
      action,
      before: detail,
      client,
      companyId,
      currentUserId,
      endpoint,
      id,
      response,
      type,
    })) {
      stage(stages, "action", false, "API_RESPONSE_UNCONFIRMED");
      return {
        ...failure(
          id,
          type,
          stages,
          "mutation_outcome_unconfirmed",
          "approval_action",
        ),
        action,
      };
    }
    stage(stages, "action", true);
    return {
      id: Number(id),
      type,
      action,
      success: true,
      method: "approval_action",
      stages,
    };
  } catch (error) {
    const code = stableCode(error, "APPROVAL_ACTION_FAILED");
    stage(stages, "action", false, code);
    return {
      ...failure(
        id,
        type,
        stages,
        AMBIGUOUS_MUTATION_CODES.has(code)
          ? "mutation_outcome_unconfirmed"
          : "approval_action_failed",
        "approval_action",
      ),
      action,
    };
  }
}
