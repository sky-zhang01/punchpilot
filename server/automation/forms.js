import { FREEE_ERROR_MESSAGES } from "../constants.js";
import { APPROVAL_TYPE_MAP } from "./constants.js";
import {
  assertApprovalMutationRequest,
  assertApprovalWithdrawalMutationRequest,
  assertMonthlyClosingMutationRequest,
} from "./mutation-intent.js";

const WEB_LEAVE_MUTATION_SKIPPED = "WEB_LEAVE_MUTATION_SKIPPED";

function approvalTypeFor(type) {
  return Object.entries(APPROVAL_TYPE_MAP)
    .find(([name]) => name === type)?.[1] || null;
}

async function assertMutationGuard(bot) {
  if (!bot || typeof bot.assertPreMutationGuard !== 'function') {
    const error = new Error('The Web mutation guard is unavailable.');
    error.code = 'WEB_COMPANY_IDENTITY_UNCONFIRMED';
    throw error;
  }
  await bot.assertPreMutationGuard();
}

async function guardedClick(bot, locator) {
  await assertMutationGuard(bot);
  await locator.click();
}

function requireMutationDispatchGuard(bot) {
  if (typeof bot?.dispatchGuardedMutation === "function") return;
  const error = new Error("The Web mutation dispatch guard is unavailable.");
  error.code = "WEB_MUTATION_DISPATCH_GUARD_UNAVAILABLE";
  throw error;
}

async function waitForSubmissionOutcome(
  bot,
  initialUrl,
  {
    successIndicators = [],
    acceptedIndicators = [],
    includeDefaultSuccessIndicators = true,
    targetConfirmed = false,
  } = {},
) {
  const knownSuccessIndicators = includeDefaultSuccessIndicators
    ? ["申請しました", "申請が完了", ...successIndicators]
    : successIndicators;
  const errorIndicators = [
    "エラー",
    "申請できませんでした",
  ];
  const terminalIndicators = [
    ...knownSuccessIndicators,
    ...errorIndicators,
    ...acceptedIndicators,
  ];
  await bot.page.waitForFunction(
    ({ url, expectedIndicators }) => {
      if (window.location.href !== url) {
        try {
          const current = new URL(window.location.href);
          const route = current.hash
            .replace(/^#\/?/, "")
            .split("?", 1)[0];
          const trustedRoute =
            current.origin === "https://p.secure.freee.co.jp" &&
            current.pathname === "/approval_requests" &&
            (/^requests\/?$/.test(route) ||
              /^requests\/[1-9]\d*\/?$/.test(route));
          if (!trustedRoute) return true;
        } catch {
          return true;
        }
      }
      const text = document.body.innerText;
      return expectedIndicators.some((indicator) => text.includes(indicator));
    },
    { url: initialUrl, expectedIndicators: terminalIndicators },
    { timeout: 15_000 },
  ).catch(() => {});

  const indicators = await bot.page.evaluate(
    ({ success, errors, accepted }) => {
      const text = document.body.innerText;
      return {
        successIndicator: success.some((indicator) => text.includes(indicator)),
        errorIndicator: errors.some((indicator) => text.includes(indicator)),
        acceptedIndicator: accepted.some((indicator) => text.includes(indicator)),
      };
    },
    {
      success: knownSuccessIndicators,
      errors: errorIndicators,
      accepted: acceptedIndicators,
    },
  ).catch(() => ({
    successIndicator: false,
    errorIndicator: false,
    acceptedIndicator: false,
  }));

  const finalUrl = bot.page.url();
  return {
    routeChanged: bot.page.url() !== initialUrl,
    targetConfirmed: Boolean(targetConfirmed),
    trustedRoute: isTrustedApprovalRequestRoute(finalUrl, initialUrl),
    ...indicators,
  };
}

export function assertSubmissionConfirmed(outcome, { allowAccepted = false } = {}) {
  if (outcome?.errorIndicator) {
    const error = new Error("freee Web rejected the form submission.");
    error.code = "WEB_FORM_SUBMISSION_REJECTED";
    throw error;
  }
  const hasTerminalEvidence =
    outcome?.successIndicator ||
    (allowAccepted && outcome?.acceptedIndicator);
  if (hasTerminalEvidence && outcome?.targetConfirmed && outcome?.trustedRoute) {
    return;
  }
  const error = new Error("freee Web form submission could not be confirmed.");
  error.code = "WEB_FORM_SUBMISSION_UNCONFIRMED";
  throw error;
}

function normalizeFormDate(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{4})[-/.\u5e74](\d{1,2})[-/.\u6708](\d{1,2})(?:\u65e5)?$/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function assertFormTargetDate(actual, expected) {
  if (normalizeFormDate(actual) === normalizeFormDate(expected)) return;
  const error = new Error("freee Web form target date could not be confirmed.");
  error.code = "WEB_FORM_TARGET_MISMATCH";
  throw error;
}

const APPROVAL_FORM_LABELS = Object.freeze({
  [APPROVAL_TYPE_MAP.PaidHoliday]: "有給休暇申請",
  [APPROVAL_TYPE_MAP.SpecialHoliday]: "特別休暇申請",
  [APPROVAL_TYPE_MAP.Absence]: "欠勤申請",
  [APPROVAL_TYPE_MAP.HolidayWork]: "休日出勤申請",
  [APPROVAL_TYPE_MAP.OvertimeWork]: "残業申請",
  [APPROVAL_TYPE_MAP.WorkTime]: "勤務時間修正申請",
});

function formTargetError(message = "freee Web form target could not be confirmed.") {
  const error = new Error(message);
  error.code = "WEB_FORM_TARGET_MISMATCH";
  return error;
}

function formFieldError() {
  const error = new Error("freee Web form fields could not be confirmed.");
  error.code = "WEB_FORM_FIELDS_UNCONFIRMED";
  return error;
}

function parseApprovalRequestFormRoute(actualUrl) {
  try {
    const url = new URL(actualUrl);
    const [route, query = ""] = url.hash.replace(/^#\/?/, "").split("?", 2);
    if (
      url.origin !== "https://p.secure.freee.co.jp" ||
      url.pathname !== "/approval_requests" ||
      !/^requests\/new\/?$/.test(route)
    ) return null;
    const params = new URLSearchParams(query);
    return {
      requestType: params.get("type"),
      targetDate: params.get("target_date"),
    };
  } catch {
    return null;
  }
}

export function assertApprovalFormTarget(observation, expectedType, expectedDate) {
  const routeTarget = parseApprovalRequestFormRoute(observation?.url);
  if (
    routeTarget?.requestType === expectedType &&
    normalizeFormDate(routeTarget?.targetDate) === normalizeFormDate(expectedDate) &&
    observation?.requestType === expectedType &&
    normalizeFormDate(observation?.date) === normalizeFormDate(expectedDate)
  ) return;
  throw formTargetError();
}

async function observeApprovalFormTarget(page, dateInput) {
  const requestType = await page.evaluate(({ labels }) => {
    const explicitSelectors = [
      "[data-approval-request-type]",
      '[name="approval_request_type"]',
      '[name="type"]',
    ];
    for (const selector of explicitSelectors) {
      const element = document.querySelector(selector);
      const value =
        element?.getAttribute("data-approval-request-type") ||
        element?.value ||
        element?.getAttribute("value");
      if (String(value || "").trim()) return String(value).trim();
    }
    const bodyText = document.body?.innerText || "";
    const matches = Object.entries(labels)
      .filter(([, label]) => bodyText.includes(label))
      .map(([type]) => type);
    return matches.length === 1 ? matches[0] : null;
  }, { kind: "approval-form-target", labels: APPROVAL_FORM_LABELS }).catch(() => null);
  const date = await dateInput.inputValue().catch(() => null);
  return { url: page.url(), requestType, date };
}

async function requireSingleFormField(locator) {
  if ((await locator.count()) !== 1) throw formFieldError();
  return locator;
}

async function assertFormFieldValue(locator, expected) {
  await requireSingleFormField(locator);
  const actual = await locator.inputValue().catch(() => null);
  if (String(actual ?? "").trim() !== String(expected ?? "").trim()) {
    throw formFieldError();
  }
}

async function fillAndConfirmFormField(bot, locator, value, { tab = false } = {}) {
  await requireSingleFormField(locator);
  await locator.click();
  await bot.page.waitForTimeout(200);
  await locator.fill(String(value));
  if (tab) await bot.page.keyboard.press("Tab");
  await bot.page.waitForTimeout(200);
  await assertFormFieldValue(locator, value);
}

function normalizeRenderedInteger(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,4})(?:年|月)?$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function assertMonthlyClosingTarget(observation, expectedYear, expectedMonth) {
  if (
    observation &&
    typeof observation === "object" &&
    observation.requestType === APPROVAL_TYPE_MAP.MonthlyAttendance &&
    normalizeRenderedInteger(observation.year) === Number(expectedYear) &&
    normalizeRenderedInteger(observation.month) === Number(expectedMonth)
  ) return;
  const error = new Error("freee Web monthly closing target could not be confirmed.");
  error.code = "WEB_FORM_TARGET_MISMATCH";
  throw error;
}

function isTrustedApprovalRequestRoute(actualUrl, initialUrl) {
  try {
    const url = new URL(actualUrl);
    const initial = new URL(initialUrl);
    const route = url.hash
      .replace(/^#\/?/, "")
      .split("?", 1)[0];
    const knownResultRoute =
      /^requests\/?$/.test(route) ||
      /^requests\/[1-9]\d*\/?$/.test(route);
    const unchangedFormRoute =
      /^requests\/new\/?$/.test(route) &&
      url.href === initial.href;
    return (
      url.origin === "https://p.secure.freee.co.jp" &&
      url.pathname === "/approval_requests" &&
      (knownResultRoute || unchangedFormRoute)
    );
  } catch {
    return false;
  }
}

async function observeMonthlyClosingTarget(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const isRendered = (element) => {
      if (element instanceof HTMLInputElement && element.type === "hidden") {
        return false;
      }
      const style = window.getComputedStyle(element);
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0;
    };
    const readValue = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element || !isRendered(element)) continue;
        const value =
          element.getAttribute("data-approval-request-type") ||
          element.value ||
          element.getAttribute("value") ||
          element.textContent;
        if (String(value || "").trim()) return String(value).trim();
      }
      return null;
    };

    const explicitType = readValue([
      "[data-approval-request-type]",
      '[name="approval_request_type"]',
      '[name="type"]',
    ]);
    const requestType = explicitType ||
      (/月次勤怠締め申請/.test(bodyText)
        ? "ApprovalRequest::MonthlyAttendance"
        : null);
    let year = readValue([
      "#approval-request-fields-target-year",
      '[name="target_year"]',
      '[name="targetYear"]',
      '[data-testid="target-year"]',
    ]);
    let month = readValue([
      "#approval-request-fields-target-month",
      '[name="target_month"]',
      '[name="targetMonth"]',
      '[data-testid="target-month"]',
    ]);

    if (!year || !month) {
      const match = bodyText.match(
        /(?:対象年月|対象月|申請年月|月次勤怠締め申請)[\s\S]{0,80}?(\d{4})\s*年\s*(\d{1,2})\s*月/,
      );
      year ||= match?.[1] || null;
      month ||= match?.[2] || null;
    }

    return { requestType, year, month };
  }, { kind: "monthly-closing-target" });
}

function assertMonthlyClosingRoute(actualUrl, expectedYear, expectedMonth) {
  try {
    const url = new URL(actualUrl);
    const [route, query = ""] = url.hash
      .replace(/^#\/?/, "")
      .split("?", 2);
    const params = new URLSearchParams(query);
    if (
      url.origin === "https://p.secure.freee.co.jp" &&
      url.pathname === "/approval_requests" &&
      /^requests\/new\/?$/.test(route) &&
      params.get("type") === APPROVAL_TYPE_MAP.MonthlyAttendance &&
      normalizeRenderedInteger(params.get("target_year")) ===
        Number(expectedYear) &&
      normalizeRenderedInteger(params.get("target_month")) ===
        Number(expectedMonth)
    ) {
      return;
    }
  } catch {}
  const error = new Error("freee Web monthly closing target could not be confirmed.");
  error.code = "WEB_FORM_TARGET_MISMATCH";
  throw error;
}

function parseApprovalRequestDetailUrl(actualUrl) {
  try {
    const url = new URL(actualUrl);
    if (
      url.origin !== "https://p.secure.freee.co.jp" ||
      url.pathname !== "/approval_requests"
    ) return null;
    const [route, query = ""] = url.hash.replace(/^#\/?/, "").split("?", 2);
    const match = route.match(/^requests\/([^/?#]+)\/?$/);
    if (!match) return null;
    return {
      requestId: decodeURIComponent(match[1]),
      requestType: new URLSearchParams(query).get("type"),
    };
  } catch {
    return null;
  }
}

export function assertWithdrawalTarget(
  observation,
  expectedRequestId,
  expectedRequestType,
  { requireAction = false } = {},
) {
  const routeTarget = parseApprovalRequestDetailUrl(observation?.url);
  const expectedId = String(expectedRequestId);
  let actionTarget = null;
  if (observation?.actionUrl != null) {
    try {
      actionTarget = parseApprovalRequestDetailUrl(
        new URL(observation.actionUrl, observation.url).href,
      );
    } catch {}
  }
  const matchesOptionalValue = (actual, expected) =>
    actual == null || String(actual) === String(expected);
  const matches =
    routeTarget?.requestId === expectedId &&
    routeTarget?.requestType === expectedRequestType &&
    matchesOptionalValue(observation?.domRequestId, expectedId) &&
    matchesOptionalValue(observation?.domRequestType, expectedRequestType) &&
    matchesOptionalValue(observation?.actionRequestId, expectedId) &&
    matchesOptionalValue(observation?.actionRequestType, expectedRequestType) &&
    (observation?.actionUrl == null ||
      (actionTarget?.requestId === expectedId &&
        actionTarget?.requestType === expectedRequestType)) &&
    (!requireAction || observation?.actionCount === 1);
  if (matches) return;

  const error = new Error("freee Web approval request target could not be confirmed.");
  error.code = "WEB_FORM_TARGET_MISMATCH";
  throw error;
}

async function observeWithdrawalTarget(page, action = null) {
  const domTarget = await page.evaluate(() => {
    const readValue = (selectors, attributes = []) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) continue;
        for (const attribute of attributes) {
          const value = element.getAttribute(attribute);
          if (value) return value;
        }
        if (element.value) return String(element.value);
      }
      return null;
    };
    return {
      domRequestId: readValue(
        ["[data-approval-request-id]", '[name="approval_request_id"]', '[name="request_id"]'],
        ["data-approval-request-id", "data-request-id"],
      ),
      domRequestType: readValue(
        ["[data-approval-request-type]", '[name="approval_request_type"]', '[name="type"]'],
        ["data-approval-request-type", "data-request-type"],
      ),
    };
  }, { kind: "approval-request-target" }).catch(() => ({
    domRequestId: null,
    domRequestType: null,
  }));
  const observation = { url: page.url(), ...domTarget };
  if (!action) return observation;

  observation.actionCount = await action.count();
  if (observation.actionCount !== 1) return observation;
  const targetAction = action.first();
  observation.actionRequestId =
    await targetAction.getAttribute("data-approval-request-id").catch(() => null) ||
    await targetAction.getAttribute("data-request-id").catch(() => null);
  observation.actionRequestType =
    await targetAction.getAttribute("data-approval-request-type").catch(() => null) ||
    await targetAction.getAttribute("data-request-type").catch(() => null);
  observation.actionUrl =
    await targetAction.getAttribute("href").catch(() => null) ||
    await targetAction.getAttribute("formaction").catch(() => null);
  return observation;
}

/**
 * Submit a work time correction via freee Web form (勤務時間修正申請).
 * This navigates directly to the correction form URL with the target date,
 * fills in times, and clicks submit.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string} date — YYYY-MM-DD
 * @param {object} times — { clockInHour, clockInMin, clockOutHour, clockOutMin, breakStartHour?, breakStartMin?, breakEndHour?, breakEndMin? }
 * @param {string} [reason] — 申請理由 text
 * @param {{ employeeId?: string|null, companyId?: string|null }} [expectedIntent]
 * @returns {{ success: boolean, error?: string }}
 */
export async function submitWorkTimeCorrection(
  bot,
  date,
  times,
  reason,
  expectedIntent = {},
) {
  const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=ApprovalRequest::WorkTime&target_date=${date}`;
  console.log("[Bot] Navigating to correction form");

  await bot.navigateToSpaForm(formUrl);

  // Wait for the form to render — try both selectors for forward-compatibility
  const dateInput = bot.page
    .locator("#approval-request-date-input, #approval-request-fields-date")
    .first();
  await bot.waitForElement(
    async () => (await dateInput.count()) > 0,
    formUrl,
    { debugPrefix: `web-correction-${date}` },
  );
  assertApprovalFormTarget(
    await observeApprovalFormTarget(bot.page, dateInput),
    APPROVAL_TYPE_MAP.WorkTime,
    date,
  );

  // Ensure "勤務時間を修正する" radio is selected (default, but be explicit)
  const modifyRadio = bot.page.locator(
    '[data-testid="clear-work-time-false"]',
  );
  await requireSingleFormField(modifyRadio);
  await guardedClick(bot, modifyRadio);
  await bot.page.waitForTimeout(300);
  if (!(await modifyRadio.isChecked().catch(() => false))) throw formFieldError();

  const requiredFields = [];

  // Helper: fill a combobox time input
  const fillTimeInput = async (id, value) => {
    const input = bot.page.locator(`#${id}`);
    const expected = String(value).padStart(2, "0");
    await fillAndConfirmFormField(bot, input, expected, { tab: true });
    requiredFields.push([input, expected]);
  };

  // Fill check-in time
  await fillTimeInput(
    "approval-request-fields-segment-clock-in-at-hour-0",
    times.clockInHour,
  );
  await fillTimeInput(
    "approval-request-fields-segment-clock-in-at-minute-0",
    times.clockInMin,
  );

  // Fill check-out time
  await fillTimeInput(
    "approval-request-fields-segment-clock-out-at-hour-0",
    times.clockOutHour,
  );
  await fillTimeInput(
    "approval-request-fields-segment-clock-out-at-minute-0",
    times.clockOutMin,
  );

  // Fill break times (if provided), or remove the default empty break row
  if (
    times.breakStartHour !== undefined &&
    times.breakEndHour !== undefined
  ) {
    await fillTimeInput(
      "approval-request-fields-break-clock-in-at-hour-0",
      times.breakStartHour,
    );
    await fillTimeInput(
      "approval-request-fields-break-clock-in-at-minute-0",
      times.breakStartMin,
    );
    await fillTimeInput(
      "approval-request-fields-break-clock-out-at-hour-0",
      times.breakEndHour,
    );
    await fillTimeInput(
      "approval-request-fields-break-clock-out-at-minute-0",
      times.breakEndMin,
    );
  } else {
    const breakInput = bot.page.locator(
      "#approval-request-fields-break-clock-in-at-hour-0",
    );
    const breakCount = await breakInput.count();
    if (breakCount > 1) throw formFieldError();
    if (breakCount === 1) {
      const breakDeleteBtn = bot.page.locator(
        '[data-testid="delete-break-0"], button[aria-label="休憩を削除"], button[aria-label="休憩削除"]',
      );
      await requireSingleFormField(breakDeleteBtn);
      await guardedClick(bot, breakDeleteBtn);
      await bot.page.waitForTimeout(300);
      if ((await breakInput.count()) !== 0) throw formFieldError();
    }
  }

  // Fill reason
  if (reason) {
    const reasonInput = bot.page.locator('[data-testid="申請理由"]');
    await fillAndConfirmFormField(bot, reasonInput, reason);
    requiredFields.push([reasonInput, reason]);
  }

  const approverInput = bot.page.locator("#approval-request-fields-approver_id");
  if (
    (await approverInput.count()) > 0 &&
    !(await approverInput.inputValue()).trim()
  ) {
    const error = new Error("freee Web requires an explicit approver selection.");
    error.code = "WEB_APPROVER_SELECTION_REQUIRED";
    throw error;
  }

  assertApprovalFormTarget(
    await observeApprovalFormTarget(bot.page, dateInput),
    APPROVAL_TYPE_MAP.WorkTime,
    date,
  );
  for (const [field, expected] of requiredFields) {
    await assertFormFieldValue(field, expected);
  }
  if (!(await modifyRadio.isChecked().catch(() => false))) throw formFieldError();

  const screenshots = bot.takeScreenshots(`web-correction-${date}`);
  const beforePath = await screenshots.before();

  // Click submit button
  console.log("[Bot] Submitting correction");
  const submitBtn = bot.page
    .locator('button[type="submit"]')
    .filter({ hasText: "申請" });
  if ((await submitBtn.count()) === 0) {
    throw new Error("Submit button not found");
  }
  const preSubmitUrl = bot.page.url();
  requireMutationDispatchGuard(bot);
  await bot.dispatchGuardedMutation(submitBtn, {
    validateRequest: (request) => assertApprovalMutationRequest(request, {
      requestType: APPROVAL_TYPE_MAP.WorkTime,
      date,
      employeeId: expectedIntent.employeeId ?? null,
      companyId: expectedIntent.companyId ?? null,
    }),
  });
  const submissionOutcome = await waitForSubmissionOutcome(bot, preSubmitUrl, {
    targetConfirmed: true,
  });

  const afterPath = await screenshots.after();

  // Check for errors
  const result = await bot.checkSubmitResult();
  if (!result.success) {
    console.log(
      `[Bot] Correction form error: ${result.error}`,
    );
    return {
      success: false,
      error: result.error,
      screenshotBefore: beforePath,
      screenshotAfter: afterPath,
    };
  }

  // If we're still on the same form URL, check for validation errors
  const postSubmitUrl = bot.page.url();
  if (postSubmitUrl.includes("requests/new")) {
    const hasError = await bot.page
      .locator('.vb-message--error, [role="alert"]')
      .count();
    if (hasError > 0) {
      const errorText = await bot.page
        .locator('.vb-message--error, [role="alert"]')
        .first()
        .textContent();
      return {
        success: false,
        error: errorText ? "freee form validation error" : "Validation error",
        screenshotBefore: beforePath,
        screenshotAfter: afterPath,
      };
    }
  }

  assertSubmissionConfirmed(submissionOutcome);

  console.log("[Bot] Correction submitted");
  return {
    success: true,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
  };
}

/**
 * Scrape employee profile information from freee Web.
 * Navigates to the profile page and extracts key fields.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string|number} employeeId — freee employee ID
 * @returns {object} Employee info: { name, department, position, employment_type, entry_date, employee_num, ... }
 */
export async function scrapeEmployeeInfo(bot, employeeId) {
  const profileUrl = `https://p.secure.freee.co.jp/employees/${employeeId}/profile`;
  console.log("[Bot] Navigating to employee profile");

  const waitForProfileContentOrRedirect = async () => {
    await bot.page.waitForFunction(
      () => {
        if (!window.location.href.includes("profile")) return true;
        const text = document.body.innerText;
        return ["氏名", "名前", "社員番号", "部門", "雇用形態"].some(
          (label) => text.includes(label),
        );
      },
      null,
      { timeout: 10_000 },
    ).catch(() => {});
  };

  // First try the newer URL format
  await bot.page.goto(profileUrl, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await waitForProfileContentOrRedirect();

  // If redirected to a different page, try the hash-based format
  if (!bot.page.url().includes("profile")) {
    const altUrl = `https://p.secure.freee.co.jp/employees#${employeeId}/profile`;
    console.log("[Bot] Trying alternative employee profile route");
    await bot.page.goto(altUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await waitForProfileContentOrRedirect();
  }

  // Extract employee info from the page
  const info = await bot.page.evaluate(() => {
    const result = {};
    const body = document.body.innerText;
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    // Try to find common profile field patterns
    // freee profile pages typically show fields in label-value pairs
    const getFieldValue = (labels) => {
      for (const label of labels) {
        const normalizedLabel = label.toLocaleLowerCase();
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!line.toLocaleLowerCase().startsWith(normalizedLabel)) continue;
          const suffix = line.slice(label.length);
          if (suffix && !/^[\s:：]/.test(suffix)) continue;
          const inlineValue = suffix.replace(/^[\s:：]+/, "").trim();
          if (inlineValue) return inlineValue;
          if (index + 1 < lines.length) return lines[index + 1];
        }
      }
      return null;
    };

    result.name = getFieldValue(["氏名", "名前", "Name"]);
    result.department = getFieldValue(["部門", "部署", "Department"]);
    result.position = getFieldValue(["役職", "Position", "Title"]);
    result.employment_type = getFieldValue(["雇用形態", "Employment"]);
    result.entry_date = getFieldValue(["入社日", "Entry Date", "入社年月日"]);
    result.employee_num = getFieldValue([
      "社員番号",
      "Employee Number",
      "Employee No",
    ]);

    // Also try to extract from structured elements
    const dts = document.querySelectorAll("dt, th, label");
    for (const dt of dts) {
      const text = dt.textContent.trim();
      const dd = dt.nextElementSibling;
      const value = dd ? dd.textContent.trim() : null;
      if (!value) continue;

      if (text.includes("氏名") || text.includes("名前"))
        result.name = result.name || value;
      if (text.includes("部門") || text.includes("部署"))
        result.department = result.department || value;
      if (text.includes("役職")) result.position = result.position || value;
      if (text.includes("雇用形態"))
        result.employment_type = result.employment_type || value;
      if (text.includes("入社日") || text.includes("入社年月日"))
        result.entry_date = result.entry_date || value;
      if (text.includes("社員番号"))
        result.employee_num = result.employee_num || value;
    }

    return result;
  });

  console.log("[Bot] Employee info loaded");
  return info;
}

/**
 * Submit a leave request via freee Web form.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string} type — e.g. 'PaidHoliday', 'SpecialHoliday', 'Absence', 'HolidayWork'
 * @param {string} date — YYYY-MM-DD
 * @param {object} options — { reason?: string, startTime?: string, endTime?: string }
 * @param {() => Promise<{ skip?: boolean, reason?: string }>} [preSubmitGuard]
 * @param {{ employeeId?: string|null, companyId?: string|null }} [expectedIntent]
 * @returns {{ success: boolean, error?: string, skipped?: boolean, reason?: string }}
 */
export async function submitLeaveRequest(
  bot,
  type,
  date,
  options = {},
  preSubmitGuard = null,
  expectedIntent = {},
) {
  const freeeType = approvalTypeFor(type);
  if (!freeeType) {
    const error = new Error("Unsupported freee Web approval request type.");
    error.code = "WEB_FORM_TYPE_UNSUPPORTED";
    throw error;
  }
  if (
    type === "SpecialHoliday" ||
    (type === "PaidHoliday" && options.holidayType && options.holidayType !== "full")
  ) {
    const error = new Error(
      "The requested leave fields cannot be confirmed in freee Web automation.",
    );
    error.code = "WEB_FORM_FIELDS_UNSUPPORTED";
    throw error;
  }
  const params = new URLSearchParams({ type: freeeType, target_date: date });
  const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?${params}`;
  console.log("[Bot] Navigating to leave request form");

  await bot.navigateToSpaForm(formUrl);

  // Wait for date input to appear
  const dateInput = bot.page.locator("#approval-request-fields-date");
  await bot.waitForElement(
    async () => (await dateInput.count()) > 0,
    formUrl,
    { debugPrefix: `leave-${type}-${date}` },
  );
  assertApprovalFormTarget(
    await observeApprovalFormTarget(bot.page, dateInput),
    freeeType,
    date,
  );

  const requiredFields = [];

  // Fill time fields if provided (for OvertimeWork, PaidHoliday half/hour)
  if (options.startTime) {
    const startInput = bot.page.locator(
      "#approval-request-fields-started-at",
    );
    await fillAndConfirmFormField(bot, startInput, options.startTime, { tab: true });
    requiredFields.push([startInput, options.startTime]);
  }
  if (options.endTime) {
    const endInput = bot.page.locator("#approval-request-fields-end-at");
    await fillAndConfirmFormField(bot, endInput, options.endTime, { tab: true });
    requiredFields.push([endInput, options.endTime]);
  }

  // Fill reason if provided
  if (options.reason) {
    const reasonInput = bot.page.locator('[data-testid="申請理由"]');
    await fillAndConfirmFormField(bot, reasonInput, options.reason);
    requiredFields.push([reasonInput, options.reason]);
  }

  // Select approval route if available
  const routeSelect = bot.page.locator("#approval-request-fields-route-id");
  if (options.routeId) {
    await requireSingleFormField(routeSelect);
    const selected = await routeSelect.selectOption(String(options.routeId));
    if (!selected.includes(String(options.routeId))) {
      const error = new Error("freee Web approval route selection could not be confirmed.");
      error.code = "WEB_APPROVER_SELECTION_REQUIRED";
      throw error;
    }
    await bot.page.waitForTimeout(300);
    requiredFields.push([routeSelect, String(options.routeId)]);
  }

  // Selecting an arbitrary first approver is unsafe. API-provided approver IDs
  // cannot be verified against this custom combobox without a stable DOM contract.
  if (options.approverId) {
    const error = new Error("freee Web approver selection could not be confirmed.");
    error.code = "WEB_APPROVER_SELECTION_REQUIRED";
    throw error;
  }

  assertApprovalFormTarget(
    await observeApprovalFormTarget(bot.page, dateInput),
    freeeType,
    date,
  );
  for (const [field, expected] of requiredFields) {
    await assertFormFieldValue(field, expected);
  }

  const screenshots = bot.takeScreenshots(`leave-${type}-${date}`);
  await screenshots.before();

  // Submit
  console.log(`[Bot] Submitting ${type} leave request`);
  const submitBtn = bot.page
    .locator('button[type="submit"]')
    .filter({ hasText: "申請" });
  if ((await submitBtn.count()) === 0) {
    throw new Error("Submit button not found");
  }
  const preSubmitUrl = bot.page.url();
  if (typeof preSubmitGuard !== 'function') {
    const error = new Error('The Web leave pre-submit guard is unavailable.');
    error.code = 'WEB_WORK_RECORD_UNCONFIRMED';
    throw error;
  }
  assertApprovalFormTarget(
    await observeApprovalFormTarget(bot.page, dateInput),
    freeeType,
    date,
  );
  for (const [field, expected] of requiredFields) {
    await assertFormFieldValue(field, expected);
  }
  requireMutationDispatchGuard(bot);
  try {
    await bot.dispatchGuardedMutation(submitBtn, {
      validateRequest: (request) => assertApprovalMutationRequest(request, {
        requestType: freeeType,
        date,
        employeeId: expectedIntent.employeeId ?? null,
        companyId: expectedIntent.companyId ?? null,
      }),
      beforeDispatch: async () => {
        const guardResult = await preSubmitGuard();
        if (guardResult?.skip === true) {
          const error = new Error("The leave request is no longer eligible for submission.");
          error.code = WEB_LEAVE_MUTATION_SKIPPED;
          error.disposition = {
            skip: true,
            reason: guardResult.reason || "already_non_working_day",
          };
          throw error;
        }
      },
    });
  } catch (error) {
    if (error?.code !== WEB_LEAVE_MUTATION_SKIPPED) throw error;
    return {
      success: true,
      skipped: true,
      reason: error.disposition.reason,
    };
  }
  const submissionOutcome = await waitForSubmissionOutcome(bot, preSubmitUrl, {
    targetConfirmed: true,
  });

  await screenshots.after();

  // Check for errors
  const result = await bot.checkSubmitResult();
  if (!result.success) {
    return { success: false, error: result.error };
  }

  assertSubmissionConfirmed(submissionOutcome);

  console.log(`[Bot] ${type} leave request submitted`);
  return { success: true };
}

/**
 * Withdraw (取下げ) an approval request via freee Web.
 * Navigates to the request detail page and clicks the withdraw button.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string} type — freee type e.g. 'PaidHoliday', 'WorkTime', 'OvertimeWork'
 * @param {string|number} requestId — freee approval request ID
 * @param {{ employeeId?: string|null, companyId?: string|null }} [expectedIntent]
 * @returns {{ success: boolean, error?: string }}
 */
export async function withdrawApprovalRequest(
  bot,
  type,
  requestId,
  expectedIntent = {},
) {
  const freeeType = approvalTypeFor(type);
  const normalizedRequestId = String(requestId || "").trim();
  if (!freeeType) {
    const error = new Error("Unsupported freee Web approval request type.");
    error.code = "WEB_FORM_TYPE_UNSUPPORTED";
    throw error;
  }
  if (!/^\d+$/.test(normalizedRequestId)) {
    const error = new Error("freee Web approval request target could not be confirmed.");
    error.code = "WEB_FORM_TARGET_MISMATCH";
    throw error;
  }
  const detailUrl = `https://p.secure.freee.co.jp/approval_requests#requests/${normalizedRequestId}?type=${encodeURIComponent(freeeType)}`;
  console.log("[Bot] Navigating to approval request detail");

  await bot.navigateToSpaForm(detailUrl, { useLocationHref: true });

  const withdrawBtn = bot.page
    .locator("button, a")
    .filter({ hasText: /^\s*(?:取り下げ|取下げ|取り下げる|取下げる)\s*$/ });

  // A rendered status may be present even when withdrawal is no longer available.
  await bot.waitForElement(
    async () => {
      if ((await withdrawBtn.count()) > 0) return true;
      const bodyText = await bot.page
        .evaluate(() => document.body.innerText.substring(0, 3000))
        .catch(() => "");
      return (
        bodyText.includes("取り下げ") ||
        bodyText.includes("取下げ") ||
        bodyText.includes("申請中") ||
        bodyText.includes("承認待ち")
      );
    },
    detailUrl,
    { debugPrefix: `withdraw-${type}-${requestId}` },
  );

  const preWithdrawTarget = await observeWithdrawalTarget(bot.page, withdrawBtn);
  if (preWithdrawTarget.actionCount > 0) {
    assertWithdrawalTarget(
      preWithdrawTarget,
      normalizedRequestId,
      freeeType,
      { requireAction: true },
    );
  } else {
    assertWithdrawalTarget(preWithdrawTarget, normalizedRequestId, freeeType);
  }

  const screenshots = bot.takeScreenshots(
    `withdraw-${type}-${requestId}`,
  );
  const beforePath = await screenshots.before();

  if ((await withdrawBtn.count()) === 0) {
    console.log("[Bot] Withdraw button not found");
    return {
      success: false,
      error: "Withdraw button (取下げ) not found on page",
      screenshotBefore: beforePath,
    };
  }

  console.log(`[Bot] Clicking withdraw button...`);
  const preWithdrawUrl = bot.page.url();
  const confirmBtn = bot.page
    .locator('[role="dialog"] button, [aria-modal="true"] button')
    .filter({ hasText: /^(OK|はい|確認|取り下げ(する|る)?|取下げ)$/ });
  requireMutationDispatchGuard(bot);
  await bot.dispatchGuardedMutation({
    click: async () => {
      await withdrawBtn.first().click();
      await confirmBtn.first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
      if ((await confirmBtn.count()) === 0) return;
      assertWithdrawalTarget(
        await observeWithdrawalTarget(bot.page, confirmBtn),
        normalizedRequestId,
        freeeType,
        { requireAction: true },
      );
      console.log(`[Bot] Clicking confirm button in dialog...`);
      await confirmBtn.first().click();
    },
  }, {
    validateRequest: (request) => assertApprovalWithdrawalMutationRequest(
      request,
      {
        requestId: normalizedRequestId,
        requestType: freeeType,
        employeeId: expectedIntent.employeeId ?? null,
        companyId: expectedIntent.companyId ?? null,
      },
    ),
  });
  const submissionOutcome = await waitForSubmissionOutcome(bot, preWithdrawUrl, {
    successIndicators: [
      "取り下げました",
      "取下げました",
      "取り下げ済み",
      "取下げ済み",
    ],
    includeDefaultSuccessIndicators: false,
  });

  const afterPath = await screenshots.after();

  // Check for errors (withdraw-specific indicators)
  const result = await bot.checkSubmitResult({
    extraIndicators: ["取り下げできません", "削除できない"],
  });
  if (!result.success) {
    console.log(`[Bot] Withdrawal failed: ${result.error}`);
    return {
      success: false,
      error: result.error,
      screenshotBefore: beforePath,
      screenshotAfter: afterPath,
    };
  }

  assertWithdrawalTarget(
    await observeWithdrawalTarget(bot.page),
    normalizedRequestId,
    freeeType,
  );
  submissionOutcome.targetConfirmed = true;
  assertSubmissionConfirmed(submissionOutcome);

  console.log("[Bot] Approval request withdrawn successfully");
  return {
    success: true,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
  };
}

/**
 * Submit monthly attendance closing via freee Web form (月次勤怠締め申請).
 * Used as fallback when API returns 400 for companies with dept/role-based routing
 * (役職、部門を利用する申請はWebから申請してください).
 *
 * The form is pre-populated from URL params (target_year, target_month) and the
 * user's department — only the "申請" submit button needs to be clicked.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {number|string} year — e.g. 2026
 * @param {number|string} month — e.g. 2
 * @param {{ employeeId?: string|null, companyId?: string|null }} [expectedIntent]
 * @returns {{ success: boolean, screenshotBefore: string, screenshotAfter: string }}
 */
export async function submitMonthlyClosingWeb(
  bot,
  year,
  month,
  expectedIntent = {},
) {
  const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=ApprovalRequest::MonthlyAttendance&target_year=${year}&target_month=${month}`;
  console.log("[Bot] Navigating to monthly closing form");

  await bot.navigateToSpaForm(formUrl);

  // Wait for the "申請" submit button to appear (form is pre-populated from URL params)
  const submitBtn = bot.page
    .locator("button.vb-button--appearancePrimary")
    .filter({ hasText: "申請" });
  await bot.waitForElement(
    async () => (await submitBtn.count()) > 0,
    formUrl,
    { debugPrefix: `monthly-closing-${year}-${month}` },
  );
  assertMonthlyClosingRoute(bot.page.url(), year, month);
  assertMonthlyClosingTarget(
    await observeMonthlyClosingTarget(bot.page),
    year,
    month,
  );

  const screenshots = bot.takeScreenshots(
    `monthly-closing-${year}-${month}`,
  );
  const beforePath = await screenshots.before();

  console.log("[Bot] Submitting monthly attendance closing");
  const preSubmitUrl = bot.page.url();
  requireMutationDispatchGuard(bot);
  await bot.dispatchGuardedMutation(submitBtn, {
    validateRequest: (request) => assertMonthlyClosingMutationRequest(request, {
      year,
      month,
      employeeId: expectedIntent.employeeId ?? null,
      companyId: expectedIntent.companyId ?? null,
    }),
  });
  const submissionOutcome = await waitForSubmissionOutcome(bot, preSubmitUrl, {
    acceptedIndicators: [FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED],
    targetConfirmed: true,
  });

  const afterPath = await screenshots.after();

  assertSubmissionConfirmed(submissionOutcome, { allowAccepted: true });

  if (submissionOutcome.acceptedIndicator) {
    console.log(
      "[Bot] Monthly closing already exists; treating as success",
    );
    return {
      success: true,
      alreadySubmitted: true,
      screenshotBefore: beforePath,
      screenshotAfter: afterPath,
    };
  }

  console.log("[Bot] Monthly closing submitted successfully");
  return {
    success: true,
    alreadySubmitted: false,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
  };
}
