import { checkpointTaskResult, beginTaskItem, updateTask, trackTaskPromise } from "../../async-tasks.js";
import { nowInTz } from "../../timezone.js";
import { parseExternalId as positiveInteger } from "../../freee-values.js";
import { Router } from "express";
import { FreeeApiClient } from "../../freee-api.js";
import {
  hasWebCredentials,
  withdrawApprovalRequestWeb,
} from "../../automation/index.js";
import {
  approveApprovalOperation,
  hasExplicitApprover,
  isCurrentApprover,
  unwrapApprovalDetail,
  withdrawApprovalOperation,
} from "./approval-operation-service.js";
import {
  approvalRequestInMonth,
  createApprovalMutationContext,
  fetchApprovalRequestPages,
  parseApprovalMutationContext,
  parseApprovalMonth,
} from "./approval-list-service.js";
import {
  TYPE_TO_ENDPOINT,
  approvalTypeEndpoint,
  captureOperationIdentity,
  acceptBatchTask,
  log,
  requireOAuth,
  sanitizeError,
} from "./utils.js";
import { withAccountOperation } from "../../account-operation.js";

const router = Router();
const MAX_BATCH_REQUESTS = 50;
const MAX_INCOMING_DETAIL_LOOKUPS = 50;
const INCOMING_DETAIL_CONCURRENCY = 4;

function normalizeOperationRequests(value, { requireAction = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "requests must be a non-empty array" };
  }
  if (value.length > MAX_BATCH_REQUESTS) {
    return { error: `Maximum ${MAX_BATCH_REQUESTS} requests per batch` };
  }

  const normalized = [];
  const keys = new Set();
  for (const request of value) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return { error: "Each request must be an object" };
    }
    const id = positiveInteger(request.id);
    if (!id) return { error: "Each request id must be a positive integer" };
    if (!approvalTypeEndpoint(request.type)) {
      return { error: "Each request type must be supported" };
    }
    if (requireAction && !["approve", "feedback"].includes(request.action)) {
      return { error: "Each action must be approve or feedback" };
    }
    const expected = requireAction
      ? parseApprovalMutationContext(request.expected)
      : null;
    if (requireAction && !expected) {
      return { error: "Each request must include a valid expected approval context" };
    }
    const key = `${request.type}:${id}`;
    if (keys.has(key)) return { error: "Duplicate approval requests are not allowed" };
    keys.add(key);
    normalized.push({
      id,
      type: request.type,
      ...(requireAction ? { action: request.action, expected } : {}),
    });
  }
  return { requests: normalized };
}

function stableText(value, maxLength, fallback = "-") {
  if (typeof value !== "string") return fallback;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
  return text || fallback;
}

function approvalRequestRange(detail) {
  if (typeof detail?.target_date === "string") {
    return parseApprovalMonth(
      detail.target_date.slice(0, 4),
      Number(detail.target_date.slice(5, 7)),
    );
  }
  return parseApprovalMonth(detail?.target_year, detail?.target_month);
}

async function mapWithConcurrency(values, concurrency, operation) {
  const pending = [...values];
  const results = [];
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (pending.length > 0) {
        const value = pending.shift();
        if (value === undefined) return;
        results.push(await operation(value));
      }
    },
  );
  await Promise.all(workers);
  return results;
}

router.get("/employee-info", async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();
    const userInfo = await client.apiRequest("GET", "/users/me");
    const company = (userInfo?.companies || []).find(
      (item) => String(item?.id) === companyId,
    );
    if (!company) {
      return res.status(409).json({
        error: "The selected company could not be confirmed for this OAuth user.",
      });
    }

    const result = {
      company_name: company.name || null,
      display_name: company.display_name || null,
      num: null,
      entry_date: null,
      employment_type: null,
      title: null,
      data_source: "oauth",
    };

    try {
      const now = nowInTz();
      const employee = await client.apiRequest(
        "GET",
        `/employees/${employeeId}?company_id=${companyId}&year=${now.year}&month=${now.month}`,
      );
      result.num = employee?.num || null;
      result.entry_date = employee?.entry_date || null;
      result.employment_type = employee?.profile_rule?.employment_type || null;
      result.title = employee?.profile_rule?.title || null;
      result.data_source = "employee_api";
    } catch (error) {
      log.info("Employee detail API was not available", {
        code: error?.code || "EMPLOYEE_DETAIL_UNAVAILABLE",
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: sanitizeError(error, "Employee information could not be loaded"),
    });
  }
});

router.post("/batch-withdraw", async (req, res) => {
  const normalized = normalizeOperationRequests(req.body?.requests);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const operationIdentity = captureOperationIdentity(oauth);

  const task = acceptBatchTask(res, "batch_withdraw", operationIdentity, normalized.requests.length);
  if (!task) return;

  const taskPromise = (async () => {
    try {
      const client = new FreeeApiClient({ identityBinding: oauth });
      await client.ensureValidToken();
      const me = await client.apiRequest("GET", "/users/me");
      const currentUserId = positiveInteger(me?.id);
      if (!currentUserId) {
        throw Object.assign(new Error("OAuth user could not be confirmed"), {
          code: "OAUTH_USER_UNCONFIRMED",
        });
      }
      for (const request of normalized.requests) {
        await withAccountOperation(async () => {
          beginTaskItem(task, request);
          const result = await withdrawApprovalOperation({
            client,
            companyId: oauth.companyId,
            currentUserId,
            ...request,
            webCredentialsAvailable: hasWebCredentials(),
            withdrawWeb: (type, requestId) =>
              withdrawApprovalRequestWeb(type, requestId, oauth),
          });
          checkpointTaskResult(task, result);
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      updateTask(task, { status: "completed" });
    } catch (error) {
      log.error("Batch withdrawal task failed", {
        code: error?.code || "BATCH_WITHDRAW_FAILED",
      });
      updateTask(task, {
        status: "failed",
        code: error?.code === "TASK_PERSISTENCE_FAILED" ? error.code : "BATCH_OPERATION_FAILED",
        error: "Batch withdrawal stopped before all requests were processed.",
      });
    }
  })();
  void trackTaskPromise(task, taskPromise);
});

router.post("/batch-approve", async (req, res) => {
  const normalized = normalizeOperationRequests(req.body?.requests, {
    requireAction: true,
  });
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const operationIdentity = captureOperationIdentity(oauth);

  const task = acceptBatchTask(res, "batch_approve", operationIdentity, normalized.requests.length);
  if (!task) return;

  const taskPromise = (async () => {
    try {
      const client = new FreeeApiClient({ identityBinding: oauth });
      await client.ensureValidToken();
      const me = await client.apiRequest("GET", "/users/me");
      const currentUserId = positiveInteger(me?.id);
      if (!currentUserId) {
        throw Object.assign(new Error("OAuth user could not be confirmed"), {
          code: "OAUTH_USER_UNCONFIRMED",
        });
      }

      const confirmUnspecifiedApprover = async ({ id, type, detail }) => {
        const range = approvalRequestRange(detail);
        if (!range) return false;
        const pageResult = await fetchApprovalRequestPages({
          client,
          companyId: oauth.companyId,
          type,
          status: "in_progress",
          range,
          approverId: currentUserId,
        });
        if (!pageResult.complete) return false;
        return pageResult.items.some((item) =>
          positiveInteger(item?.id) === positiveInteger(id) &&
          positiveInteger(item?.company_id) === Number(oauth.companyId) &&
          item?.status === "in_progress" &&
          approvalRequestInMonth(item, range) &&
          (isCurrentApprover(item, currentUserId) || !hasExplicitApprover(item)));
      };

      for (const request of normalized.requests) {
        await withAccountOperation(async () => {
          beginTaskItem(task, request);
          const result = await approveApprovalOperation({
            client,
            companyId: oauth.companyId,
            currentUserId,
            ...request,
            confirmUnspecifiedApprover,
          });
          checkpointTaskResult(task, result);
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      updateTask(task, { status: "completed" });
    } catch (error) {
      log.error("Batch approval task failed", {
        code: error?.code || "BATCH_APPROVAL_FAILED",
      });
      updateTask(task, {
        status: "failed",
        code: error?.code === "TASK_PERSISTENCE_FAILED" ? error.code : "BATCH_OPERATION_FAILED",
        error: "Batch approval stopped before all requests were processed.",
      });
    }
  })();
  void trackTaskPromise(task, taskPromise);
});

router.get("/incoming-requests", async (req, res) => {
  const range = parseApprovalMonth(req.query.year, req.query.month);
  if (!range) {
    return res.status(400).json({
      error: "year and month must identify a valid month",
    });
  }
  const oauth = requireOAuth(res);
  if (!oauth) return;

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();
    const me = await client.apiRequest("GET", "/users/me");
    const currentUserId = positiveInteger(me?.id);
    if (!currentUserId) {
      return res.status(503).json({ error: "The OAuth user could not be confirmed." });
    }

    const requestsByKey = new Map();
    const unavailableTypes = [];
    let detailLookupCount = 0;
    for (const type of Object.keys(TYPE_TO_ENDPOINT)) {
      let typeComplete = true;
      try {
        const pageResult = await fetchApprovalRequestPages({
          client,
          companyId: oauth.companyId,
          type,
          status: "in_progress",
          range,
          approverId: currentUserId,
        });
        typeComplete = pageResult.complete;
        const candidatesById = new Map();
        for (const item of pageResult.items) {
          const id = positiveInteger(item?.id);
          if (
            !id ||
            positiveInteger(item?.company_id) !== Number(oauth.companyId) ||
            item?.status !== "in_progress" ||
            !approvalRequestInMonth(item, range) ||
            (!isCurrentApprover(item, currentUserId) && hasExplicitApprover(item))
          ) {
            continue;
          }
          candidatesById.set(id, item);
        }

        const remainingLookups = Math.max(
          0,
          MAX_INCOMING_DETAIL_LOOKUPS - detailLookupCount,
        );
        const allCandidates = [...candidatesById.values()];
        if (allCandidates.length > remainingLookups) typeComplete = false;
        const candidates = allCandidates.slice(0, remainingLookups);
        detailLookupCount += candidates.length;
        const detailResults = await mapWithConcurrency(
          candidates,
          INCOMING_DETAIL_CONCURRENCY,
          async (item) => {
            const id = positiveInteger(item?.id);
            try {
              const response = await client.apiRequest(
                "GET",
                `/approval_requests/${approvalTypeEndpoint(type)}/${id}?company_id=${oauth.companyId}`,
              );
              return { id, detail: unwrapApprovalDetail(type, response) };
            } catch {
              return { id, detail: null };
            }
          },
        );

        for (const { id, detail } of detailResults) {
          if (
            !id ||
            positiveInteger(detail?.id) !== id ||
            positiveInteger(detail?.company_id) !== Number(oauth.companyId) ||
            detail?.status !== "in_progress" ||
            !approvalRequestInMonth(detail, range) ||
            (!isCurrentApprover(detail, currentUserId) && hasExplicitApprover(detail))
          ) {
            typeComplete = false;
            continue;
          }
          const approvalContext = createApprovalMutationContext({
            request: detail,
            companyId: oauth.companyId,
            currentUserId,
            type,
          });
          if (!approvalContext) {
            typeComplete = false;
            continue;
          }
          requestsByKey.set(`${type}:${id}`, {
            id,
            type,
            status: "in_progress",
            target_date:
              detail.target_date ||
              `${detail.target_year}-${String(detail.target_month).padStart(2, "0")}`,
            applicant: stableText(
              detail.applicant?.display_name || detail.applicant_name,
              100,
            ),
            comment:
              typeof detail.comment === "string"
                ? stableText(detail.comment, 255, "")
                : null,
            created_at: detail.created_at || detail.issue_date || null,
            approval_context: approvalContext,
          });
        }
      } catch (error) {
        typeComplete = false;
        log.warn("Incoming approval type could not be verified", {
          type,
          code: error?.code || "INCOMING_REQUEST_LOOKUP_FAILED",
        });
      }
      if (!typeComplete) unavailableTypes.push(type);
    }

    const requests = [...requestsByKey.values()].sort((a, b) =>
      (b.created_at || "").localeCompare(a.created_at || ""),
    );
    if (
      unavailableTypes.length === Object.keys(TYPE_TO_ENDPOINT).length &&
      requests.length === 0
    ) {
      return res.status(503).json({
        error: "Incoming approval requests could not be verified.",
      });
    }
    return res.json({
      requests,
      count: requests.length,
      complete: unavailableTypes.length === 0,
      unavailable_types: unavailableTypes,
    });
  } catch (error) {
    return res.status(500).json({
      error: sanitizeError(error, "Incoming approval requests could not be loaded"),
    });
  }
});

export default router;
