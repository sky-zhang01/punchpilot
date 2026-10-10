import { parseExternalId as positiveInteger } from "../../freee-values.js";
import { createHash } from "node:crypto";
import {
  approvalTypeEndpoint,
  approvalTypeResponseKey,
} from "./utils.js";

const PAGE_SIZE = 100;
const MAX_REQUESTS_PER_QUERY = 1000;
const APPROVAL_VERSION_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const MAX_APPROVAL_VERSION_BYTES = 256 * 1024;
const MAX_APPROVAL_VERSION_DEPTH = 64;

function nonNegativeInteger(value) {
  return value === 0 || value === '0' ? 0 : positiveInteger(value);
}

function strictNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalJson(value, depth = 0, ancestors = new Set()) {
  if (depth > MAX_APPROVAL_VERSION_DEPTH) throw new TypeError("approval detail is too deep");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("approval detail has a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) throw new TypeError("approval detail is cyclic");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) =>
        canonicalJson(entry, depth + 1, ancestors) ?? "null").join(",")}]`;
    }
    const entries = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = canonicalJson(Reflect.get(value, key), depth + 1, ancestors);
      if (serialized !== undefined) {
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function approvalRequestVersion(request, company, actor, type) {
  try {
    const canonical = canonicalJson(request);
    if (
      typeof canonical !== "string" ||
      Buffer.byteLength(canonical, "utf8") > MAX_APPROVAL_VERSION_BYTES
    ) {
      return null;
    }
    const digest = createHash("sha256")
      .update("approval-context-v1\0")
      .update(String(company))
      .update("\0")
      .update(String(actor))
      .update("\0")
      .update(type)
      .update("\0")
      .update(canonical)
      .digest("base64url");
    return `v1.${digest}`;
  } catch {
    return null;
  }
}

export function parseApprovalMutationContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const currentRound = strictNonNegativeInteger(value.current_round);
  const currentStepId = Number.isSafeInteger(value.current_step_id) &&
    value.current_step_id > 0
    ? value.current_step_id
    : null;
  const requestVersion = value.request_version;
  if (
    currentRound === null ||
    !currentStepId ||
    typeof requestVersion !== "string" ||
    !APPROVAL_VERSION_PATTERN.test(requestVersion)
  ) {
    return null;
  }
  return {
    current_round: currentRound,
    current_step_id: currentStepId,
    request_version: requestVersion,
  };
}

export function createApprovalMutationContext({
  request,
  companyId,
  currentUserId,
  type,
}) {
  const company = positiveInteger(companyId);
  const actor = positiveInteger(currentUserId);
  const requestId = positiveInteger(request?.id);
  const requestCompany = positiveInteger(request?.company_id);
  const currentRound = nonNegativeInteger(request?.current_round);
  const currentStepId = positiveInteger(request?.current_step_id);
  const requestVersion = approvalRequestVersion(request, company, actor, type);
  if (
    !approvalTypeEndpoint(type) ||
    !company ||
    !actor ||
    !requestId ||
    requestCompany !== company ||
    currentRound === null ||
    !currentStepId ||
    !requestVersion
  ) {
    return null;
  }

  return {
    current_round: currentRound,
    current_step_id: currentStepId,
    request_version: requestVersion,
  };
}

export function parseApprovalMonth(yearValue, monthValue) {
  if (!['string', 'number'].includes(typeof yearValue) || !['string', 'number'].includes(typeof monthValue)) return null;
  if (!/^\d{4}$/.test(String(yearValue || ""))) return null;
  if (!/^(?:[1-9]|1[0-2])$/.test(String(monthValue || ""))) return null;
  const year = Number(yearValue);
  const month = Number(monthValue);
  if (year < 2000 || year > 2100) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  return {
    year,
    month,
    prefix,
    startDate: `${prefix}-01`,
    endDate: `${prefix}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function approvalRequestInMonth(request, range) {
  if (typeof request?.target_date === "string") {
    return request.target_date.startsWith(`${range.prefix}-`);
  }
  return (
    Number(request?.target_year) === range.year &&
    Number(request?.target_month) === range.month
  );
}

function responseItems(type, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const responseKey = approvalTypeResponseKey(type);
  if (!responseKey) return null;
  const key = `${responseKey}s`;
  if (!Object.hasOwn(data, key)) return null;
  const value = Reflect.get(data, key);
  return Array.isArray(value) ? value : null;
}

export async function fetchApprovalRequestPages({
  client,
  companyId,
  type,
  status,
  range,
  applicantId = null,
  approverId = null,
}) {
  const endpoint = approvalTypeEndpoint(type);
  const company = positiveInteger(companyId);
  if (
    !endpoint ||
    !company ||
    !["draft", "in_progress", "approved", "feedback"].includes(status) ||
    !range
  ) {
    const error = new Error("Approval list query is invalid");
    error.code = "INVALID_APPROVAL_LIST_QUERY";
    throw error;
  }
  const applicant = applicantId == null ? null : positiveInteger(applicantId);
  const approver = approverId == null ? null : positiveInteger(approverId);
  if (applicantId != null && !applicant) {
    const error = new Error("Applicant could not be confirmed");
    error.code = "INVALID_APPROVAL_LIST_QUERY";
    throw error;
  }
  if (approverId != null && !approver) {
    const error = new Error("Approver could not be confirmed");
    error.code = "INVALID_APPROVAL_LIST_QUERY";
    throw error;
  }

  const items = [];
  let complete = true;
  for (let offset = 0; offset < MAX_REQUESTS_PER_QUERY; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      company_id: String(company),
      status,
      start_target_date: range.startDate,
      end_target_date: range.endDate,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (applicant) params.set("applicant_id", String(applicant));
    if (approver) params.set("approver_id", String(approver));

    const data = await client.apiRequest(
      "GET",
      `/approval_requests/${endpoint}?${params}`,
    );
    const page = responseItems(type, data);
    if (!page) {
      const error = new Error("Approval list response was not confirmed");
      error.code = "API_RESPONSE_UNCONFIRMED";
      throw error;
    }
    items.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (offset + PAGE_SIZE >= MAX_REQUESTS_PER_QUERY) complete = false;
  }
  return { items, complete };
}
