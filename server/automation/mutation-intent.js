const FREEE_WEB_ORIGIN = "https://p.secure.freee.co.jp";
const MAX_BODY_BYTES = 100 * 1024;
const MAX_BODY_DEPTH = 8;
const MAX_BODY_VALUES = 1024;

const TIME_CLOCK_PATHS = new Set([
  "/api/private/employee_portal/time_clocks",
  "/api/private/employees/time_clocks",
]);
const APPROVAL_MUTATION_PATHS = Object.freeze([
  /^\/(?:api\/private\/)?approval_requests(?:\/|$)/,
  /^\/api\/private\/employees\/approval_requests\/requests(?:\/|$)/,
]);

const ACTION_ALIASES = new Map([
  ["checkin", "clock_in"],
  ["clock_in", "clock_in"],
  ["checkout", "clock_out"],
  ["clock_out", "clock_out"],
  ["break_start", "break_begin"],
  ["break_begin", "break_begin"],
  ["break_end", "break_end"],
]);

const ACTION_KEYS = new Set([
  "action",
  "action_type",
  "clock_type",
  "time_clock_type",
  "type",
]);
const COMPANY_KEYS = new Set(["company_id"]);
const EMPLOYEE_KEYS = new Set(["employee_id"]);
const DATE_KEYS = new Set(["base_date", "date", "target_date"]);
const YEAR_KEYS = new Set(["target_year"]);
const MONTH_KEYS = new Set(["target_month"]);
const REQUEST_ID_KEYS = new Set(["approval_request_id", "id", "request_id"]);
const APPROVAL_TYPE_KEYS = new Set([
  "approval_request_type",
  "request_type",
  "type",
]);

function untrustedMutation(cause = null) {
  const error = new Error("The Web mutation request did not match the intended operation.");
  error.code = "WEB_MUTATION_REQUEST_UNTRUSTED";
  if (cause) error.cause = cause;
  return error;
}

function normalizeKey(value) {
  const parts = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[.[\]]+/)
    .filter(Boolean);
  return (parts.at(-1) || "").toLowerCase();
}

function scalarText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function appendValue(values, key, value, state) {
  const text = scalarText(value);
  if (text === null) return;
  state.count += 1;
  if (state.count > MAX_BODY_VALUES) throw untrustedMutation();
  const normalizedKey = normalizeKey(key);
  if (!values.has(normalizedKey)) values.set(normalizedKey, []);
  values.get(normalizedKey).push(text);
}

function flattenBody(value, values, state, path = "", depth = 0) {
  if (depth > MAX_BODY_DEPTH) throw untrustedMutation();
  if (Array.isArray(value)) {
    for (const item of value) flattenBody(item, values, state, path, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenBody(child, values, state, path ? `${path}.${key}` : key, depth + 1);
    }
    return;
  }
  appendValue(values, path, value, state);
}

function requestBodyBuffer(request, { required = true } = {}) {
  let body = null;
  try {
    body = request?.postDataBuffer?.() ?? null;
  } catch (cause) {
    throw untrustedMutation(cause);
  }
  if (body === null || body === undefined) {
    try {
      const text = request?.postData?.();
      body = typeof text === "string" ? Buffer.from(text, "utf8") : null;
    } catch (cause) {
      throw untrustedMutation(cause);
    }
  }
  if (body === null || body === undefined) {
    if (required) throw untrustedMutation();
    return null;
  }
  if (
    !Buffer.isBuffer(body) ||
    body.length > MAX_BODY_BYTES ||
    (required && body.length === 0)
  ) {
    throw untrustedMutation();
  }
  return body.length === 0 ? null : body;
}

function requestValues(
  request,
  url,
  { bodyRequired = true, valuesRequired = true } = {},
) {
  const body = requestBodyBuffer(request, { required: bodyRequired });
  const values = new Map();
  const state = { count: 0 };
  let parsed = null;
  if (body) {
    try {
      parsed = request?.postDataJSON?.() ?? null;
    } catch {
      // URL-encoded bodies are handled below.
    }
    if (parsed && typeof parsed === "object") {
      flattenBody(parsed, values, state);
    } else {
      const text = body.toString("utf8");
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") {
        flattenBody(parsed, values, state);
      } else {
        if (!text.includes("=")) throw untrustedMutation();
        for (const [key, value] of new URLSearchParams(text)) {
          appendValue(values, key, value, state);
        }
      }
    }
  }
  for (const [key, value] of url.searchParams) appendValue(values, key, value, state);
  if (valuesRequired && state.count === 0) throw untrustedMutation();
  return values;
}

function requestUrl(request) {
  try {
    return new URL(String(request?.url?.() || ""));
  } catch (cause) {
    throw untrustedMutation(cause);
  }
}

function assertMethod(request, expected) {
  if (request?.method?.() !== expected) throw untrustedMutation();
}

function isApprovalMutationPath(pathname) {
  return APPROVAL_MUTATION_PATHS.some((pattern) => pattern.test(pathname));
}

function distinctValues(values, keys, transform = (value) => value) {
  const matches = new Set();
  for (const key of keys) {
    for (const value of values.get(key) || []) {
      const normalized = transform(value);
      if (normalized) matches.add(normalized);
    }
  }
  return matches;
}

function matchingValues(values, keys) {
  const matches = [];
  for (const key of keys) matches.push(...(values.get(key) || []));
  return matches;
}

function assertExactNormalizedValue(values, keys, expected, transform) {
  const raw = matchingValues(values, keys);
  const normalized = raw.map(transform);
  if (
    raw.length === 0 ||
    normalized.some((value) => !value) ||
    new Set(normalized).size !== 1 ||
    normalized[0] !== expected
  ) {
    throw untrustedMutation();
  }
}

function normalizeId(value) {
  const text = String(value || "").trim();
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : "";
}

function assertBoundTarget(values, keys, expected, transform = (value) => value) {
  const raw = matchingValues(values, keys);
  if (raw.length === 0) return;
  if (expected === null || expected === undefined) throw untrustedMutation();
  const normalized = raw.map(transform);
  if (normalized.some((value) => !value)) throw untrustedMutation();
  const found = new Set(normalized);
  if (found.size > 1 || (found.size === 1 && !found.has(String(expected)))) {
    throw untrustedMutation();
  }
}

function assertIdentityTargets(values, { employeeId = null, companyId = null }) {
  if (employeeId !== null) {
    const normalized = normalizeId(employeeId);
    if (!normalized) throw untrustedMutation();
    assertBoundTarget(values, EMPLOYEE_KEYS, normalized, normalizeId);
  } else {
    assertBoundTarget(values, EMPLOYEE_KEYS, null, normalizeId);
  }
  if (companyId !== null) {
    const normalized = normalizeId(companyId);
    if (!normalized) throw untrustedMutation();
    assertBoundTarget(values, COMPANY_KEYS, normalized, normalizeId);
  } else {
    assertBoundTarget(values, COMPANY_KEYS, null, normalizeId);
  }
}

function normalizeYear(value) {
  const text = String(value || "").trim();
  return /^\d{4}$/.test(text) && Number(text) >= 2000 && Number(text) <= 2100
    ? text
    : "";
}

function normalizeMonth(value) {
  const text = String(value || "").trim();
  return /^(?:[1-9]|1[0-2])$/.test(text) ? String(Number(text)) : "";
}

function withdrawalPathId(pathname) {
  const match = pathname.match(
    /^\/(?:api\/private\/)?(?:employees\/)?approval_requests(?:\/requests)?\/([1-9]\d*)(?:\/(?:cancel|delete|withdraw))?\/?$/,
  );
  return match?.[1] || "";
}

export function assertTimeClockMutationRequest(
  request,
  { actionType, employeeId = null, companyId = null, date = null } = {},
) {
  assertMethod(request, "POST");
  const url = requestUrl(request);
  if (url.origin !== FREEE_WEB_ORIGIN || !TIME_CLOCK_PATHS.has(url.pathname)) {
    throw untrustedMutation();
  }
  const expectedAction = ACTION_ALIASES.get(String(actionType || "").toLowerCase());
  if (!expectedAction) throw untrustedMutation();
  const values = requestValues(request, url);
  const actionValues = matchingValues(values, ACTION_KEYS);
  const normalizedActions = actionValues.map((value) =>
    ACTION_ALIASES.get(String(value).trim().toLowerCase()) || "");
  if (normalizedActions.some((value) => !value)) throw untrustedMutation();
  const actions = new Set(normalizedActions);
  if (actions.size !== 1 || !actions.has(expectedAction)) throw untrustedMutation();
  assertIdentityTargets(values, { employeeId, companyId });
  if (date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw untrustedMutation();
    assertBoundTarget(values, DATE_KEYS, date);
  } else {
    assertBoundTarget(values, DATE_KEYS, null);
  }
  return true;
}

export function assertApprovalMutationRequest(
  request,
  { requestType, date, employeeId = null, companyId = null } = {},
) {
  assertMethod(request, "POST");
  const url = requestUrl(request);
  if (
    url.origin !== FREEE_WEB_ORIGIN ||
    !isApprovalMutationPath(url.pathname)
  ) {
    throw untrustedMutation();
  }
  if (
    typeof requestType !== "string" ||
    !/^ApprovalRequest::[A-Za-z]+$/.test(requestType) ||
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    throw untrustedMutation();
  }
  const values = requestValues(request, url);
  const types = distinctValues(values, APPROVAL_TYPE_KEYS);
  const dates = distinctValues(values, DATE_KEYS);
  if (types.size !== 1 || !types.has(requestType)) throw untrustedMutation();
  if (dates.size !== 1 || !dates.has(date)) throw untrustedMutation();
  assertIdentityTargets(values, { employeeId, companyId });
  return true;
}

export function assertMonthlyClosingMutationRequest(
  request,
  { year, month, employeeId = null, companyId = null } = {},
) {
  assertMethod(request, "POST");
  const url = requestUrl(request);
  if (
    url.origin !== FREEE_WEB_ORIGIN ||
    !isApprovalMutationPath(url.pathname)
  ) {
    throw untrustedMutation();
  }
  const expectedYear = normalizeYear(year);
  const expectedMonth = normalizeMonth(month);
  if (!expectedYear || !expectedMonth) throw untrustedMutation();
  const values = requestValues(request, url);
  const types = distinctValues(values, APPROVAL_TYPE_KEYS);
  if (
    types.size !== 1 ||
    !types.has("ApprovalRequest::MonthlyAttendance")
  ) {
    throw untrustedMutation();
  }
  assertExactNormalizedValue(values, YEAR_KEYS, expectedYear, normalizeYear);
  assertExactNormalizedValue(values, MONTH_KEYS, expectedMonth, normalizeMonth);
  assertIdentityTargets(values, { employeeId, companyId });
  return true;
}

export function assertApprovalWithdrawalMutationRequest(
  request,
  {
    requestId,
    requestType,
    employeeId = null,
    companyId = null,
  } = {},
) {
  assertMethod(request, "DELETE");
  const url = requestUrl(request);
  if (
    url.origin !== FREEE_WEB_ORIGIN ||
    !isApprovalMutationPath(url.pathname)
  ) {
    throw untrustedMutation();
  }
  const expectedId = normalizeId(requestId);
  if (
    !expectedId ||
    typeof requestType !== "string" ||
    !/^ApprovalRequest::[A-Za-z]+$/.test(requestType)
  ) {
    throw untrustedMutation();
  }
  const values = requestValues(request, url, {
    bodyRequired: false,
    valuesRequired: false,
  });
  const rawIds = matchingValues(values, REQUEST_ID_KEYS);
  const ids = new Set([
    withdrawalPathId(url.pathname),
    ...rawIds.map(normalizeId),
  ].filter(Boolean));
  if (
    rawIds.some((value) => !normalizeId(value)) ||
    ids.size !== 1 ||
    !ids.has(expectedId)
  ) {
    throw untrustedMutation();
  }
  const approvalTypes = new Set(
    matchingValues(values, APPROVAL_TYPE_KEYS)
      .filter((value) => /^ApprovalRequest::[A-Za-z]+$/.test(value)),
  );
  if (
    approvalTypes.size > 1 ||
    (approvalTypes.size === 1 && !approvalTypes.has(requestType))
  ) {
    throw untrustedMutation();
  }
  assertIdentityTargets(values, { employeeId, companyId });
  return true;
}
