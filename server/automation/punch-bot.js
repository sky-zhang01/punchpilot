import fs from "fs";
import path from "path";
import { getSetting } from "../db.js";
import { FREEE_STATE, FREEE_ERROR_MESSAGES } from "../constants.js";
import {
  ACTION_SELECTORS,
  APPROVAL_TYPE_MAP,
  ensureScreenshotsDir,
  safeScreenshotPath,
  shouldCaptureScreenshot,
} from "./constants.js";
import { automationRuntime } from "./runtime.js";
import { getCredentials, getWebCompanyName } from "./utils.js";
import {
  assertAllowedFreeeWebUrl,
  authenticateFreeeWeb,
} from "./web-login.js";
import { assertTimeClockMutationRequest } from "./mutation-intent.js";

const EXPECTED_STATE_AFTER_ACTION = {
  checkin: [FREEE_STATE.WORKING],
  checkout: [FREEE_STATE.CHECKED_OUT, FREEE_STATE.NOT_CHECKED_IN],
  break_start: [FREEE_STATE.ON_BREAK],
  break_end: [FREEE_STATE.WORKING],
};

function automationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mutationDispatchUnavailable(cause = null) {
  const error = automationError(
    "WEB_MUTATION_DISPATCH_GUARD_UNAVAILABLE",
    "The Web mutation could not be guarded at dispatch time.",
  );
  if (cause) error.cause = cause;
  return error;
}

function exactTextPattern(value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*$`); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- every regexp metacharacter is escaped before interpolation.
}

async function locatorIsVisible(locator) {
  return (await locator.count()) > 0 && locator.isVisible().catch(() => false);
}

const mutationDispatchUrlMatcher = () => true;
const SAFE_REQUEST_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function installMutationDispatchGuard(
  page,
  { validateRequest, beforeDispatch, atDispatch },
) {
  if (typeof page?.route !== "function") throw mutationDispatchUnavailable();
  if (
    typeof validateRequest !== "function" ||
    typeof beforeDispatch !== "function" ||
    typeof atDispatch !== "function"
  ) {
    throw mutationDispatchUnavailable();
  }

  const activeRoutes = new Set();
  let closed = false;
  let mutationClaimed = false;
  let decisionSettled = false;
  let resolveDecision;
  const decision = new Promise((resolve) => {
    resolveDecision = resolve;
  });
  const settle = (value) => {
    if (decisionSettled) return;
    decisionSettled = true;
    resolveDecision(value);
  };
  const deny = async (route, error) => {
    closed = true;
    if (route) activeRoutes.add(route);
    settle({ authorized: false, error });
    const routes = [...activeRoutes];
    activeRoutes.clear();
    await Promise.all(routes.map(async (candidate) => {
      try {
        await Promise.resolve(candidate.abort("blockedbyclient"));
      } catch {}
    }));
  };

  const handler = async (route, request) => {
    const method = request?.method?.();
    if (SAFE_REQUEST_METHODS.has(method)) {
      await Promise.resolve(route.continue()).catch(() => {});
      return;
    }

    activeRoutes.add(route);
    if (
      closed ||
      mutationClaimed
    ) {
      await deny(
        route,
        closed
          ? mutationDispatchUnavailable()
          : automationError(
            "WEB_MUTATION_REQUEST_UNTRUSTED",
            "An unexpected request reached the Web mutation guard.",
          ),
      );
      return;
    }

    try {
      const validation = validateRequest(request);
      if (validation && typeof validation.then === "function") {
        throw automationError(
          "WEB_MUTATION_REQUEST_VALIDATOR_ASYNC",
          "The Web mutation request validator must be synchronous.",
        );
      }
      // JavaScript execution is single-threaded here. Claiming before the
      // first await prevents a second mutation from passing the same guard.
      mutationClaimed = true;
      await beforeDispatch(request);
    } catch (error) {
      await deny(
        route,
        error instanceof Error ? error : mutationDispatchUnavailable(),
      );
      return;
    }
    if (closed) {
      await deny(route, mutationDispatchUnavailable());
      return;
    }

    try {
      // atDispatch must stay synchronous so route.continue() follows the
      // final scheduler authorization check without another async boundary.
      atDispatch();
      activeRoutes.delete(route);
      const continuation = route.continue();
      settle({ authorized: true, error: null, request });
      await Promise.resolve(continuation).catch(() => {});
    } catch (error) {
      await deny(
        route,
        error instanceof Error ? error : mutationDispatchUnavailable(),
      );
    }
  };

  let registration;
  try {
    registration = await page.route(mutationDispatchUrlMatcher, handler);
  } catch (error) {
    throw mutationDispatchUnavailable(error);
  }
  const disposeRoute = typeof registration?.dispose === "function"
    ? () => registration.dispose()
    : typeof page.unroute === "function"
      ? () => page.unroute(mutationDispatchUrlMatcher, handler)
      : null;
  if (!disposeRoute) {
    throw mutationDispatchUnavailable();
  }

  const cancel = async (error = mutationDispatchUnavailable()) => {
    closed = true;
    if (!decisionSettled) await deny(null, error);
  };
  return {
    decision,
    cancel,
    async dispose() {
      await cancel();
      await Promise.resolve(disposeRoute()).catch(() => {});
    },
  };
}

export class PunchBot {
  constructor({ runtime = automationRuntime, screenshotIdentityKey = null } = {}) {
    this.runtime = runtime;
    this.screenshotIdentityKey = screenshotIdentityKey;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.preMutationGuard = null;
    this.mutationAuthorizationGuard = null;
    this.cleanupPromise = null;
  }

  async init(signal = null) {
    let context = null;
    const abortInitialization = () => {
      const cleanup = context
        ? this.runtime.closeContext(context)
        : this.runtime.closeBrowser();
      void Promise.resolve(cleanup).catch(() => {});
    };
    signal?.addEventListener("abort", abortInitialization, { once: true });
    try {
      context = await this.runtime.openContext({ signal });
      signal?.throwIfAborted();
      this.context = context;
      this.browser = context.browser?.() || null;
      const page = await context.newPage();
      signal?.throwIfAborted();
      this.page = page;
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(20_000);
      signal?.throwIfAborted();
    } catch (error) {
      if (this.context === context) {
        this.context = null;
        this.browser = null;
        this.page = null;
      }
      await this.runtime.closeContext(context);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortInitialization);
    }
  }

  async cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    const context = this.context;
    this.context = null;
    this.browser = null;
    this.page = null;
    this.preMutationGuard = null;
    this.mutationAuthorizationGuard = null;
    this.cleanupPromise = this.runtime.closeContext(context);
    try {
      await this.cleanupPromise;
    } finally {
      this.cleanupPromise = null;
    }
  }

  setPreMutationGuard(guard, mutationAuthorizationGuard = null) {
    if (typeof guard !== 'function') {
      throw new TypeError('pre-mutation guard must be a function');
    }
    if (
      mutationAuthorizationGuard !== null &&
      typeof mutationAuthorizationGuard !== 'function'
    ) {
      throw new TypeError('mutation authorization guard must be a function');
    }
    this.preMutationGuard = guard;
    this.mutationAuthorizationGuard = mutationAuthorizationGuard;
  }

  async assertPreMutationGuard() {
    assertAllowedFreeeWebUrl(this.page?.url?.(), {
      applicationOnly: true,
      code: "WEB_MUTATION_ORIGIN_UNTRUSTED",
    });
    if (this.preMutationGuard) await this.preMutationGuard();
  }

  assertMutationDispatchAuthorized() {
    assertAllowedFreeeWebUrl(this.page?.url?.(), {
      applicationOnly: true,
      code: "WEB_MUTATION_ORIGIN_UNTRUSTED",
    });
    if (!this.mutationAuthorizationGuard) return;
    const result = this.mutationAuthorizationGuard();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      throw automationError(
        "WEB_MUTATION_DISPATCH_GUARD_ASYNC",
        "The final attendance authorization guard must be synchronous.",
      );
    }
  }

  async dispatchGuardedMutation(
    locator,
    {
      validateRequest,
      beforeDispatch = null,
      responsePredicate = null,
      timeoutMs = 10_000,
    } = {},
  ) {
    if (!locator || typeof locator.click !== "function") {
      throw mutationDispatchUnavailable();
    }
    if (typeof validateRequest !== "function") {
      throw mutationDispatchUnavailable();
    }
    if (
      beforeDispatch !== null &&
      typeof beforeDispatch !== "function"
    ) {
      throw mutationDispatchUnavailable();
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw mutationDispatchUnavailable();
    }

    await this.assertPreMutationGuard();
    this.assertMutationDispatchAuthorized();
    const dispatchGuard = await installMutationDispatchGuard(this.page, {
      validateRequest,
      beforeDispatch: async (request) => {
        await this.assertPreMutationGuard();
        if (beforeDispatch) await beforeDispatch(request);
      },
      atDispatch: () => this.assertMutationDispatchAuthorized(),
    });
    const responsePromise = typeof responsePredicate === "function"
      ? this.page.waitForResponse(responsePredicate, { timeout: timeoutMs }).catch(() => null)
      : null;
    const responseUnavailableDecision = responsePromise
      ? responsePromise.then((response) => response === null
        ? {
            authorized: false,
            error: mutationDispatchUnavailable(),
            timedOut: true,
          }
        : new Promise(() => {}))
      : new Promise(() => {});
    let timeoutId;
    const timeoutDecision = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({
        authorized: false,
        error: mutationDispatchUnavailable(),
        timedOut: true,
      }), timeoutMs);
    });

    try {
      // A state-changing click is never retried. A click may report an
      // ambiguous UI failure after the guarded request was already dispatched.
      const clickPromise = locator.click({ timeout: timeoutMs }).then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
      const decision = await Promise.race([
        dispatchGuard.decision,
        timeoutDecision,
        responseUnavailableDecision,
      ]);
      if (decision.timedOut) await dispatchGuard.cancel(decision.error);
      const clickOutcome = await clickPromise;
      if (!decision.authorized) throw decision.error;
      const response = responsePromise ? await responsePromise : null;
      return {
        request: decision.request || null,
        response,
        clickError: clickOutcome.error,
      };
    } finally {
      clearTimeout(timeoutId);
      await dispatchGuard.dispose();
    }
  }

  async login(targetCompany = getWebCompanyName()) {
    const creds = getCredentials();
    if (!creds.username || !creds.password) {
      const err = new Error("freee credentials not configured");
      err.code = "WEB_CREDENTIALS_NOT_CONFIGURED";
      throw err;
    }

    try {
      console.log("[Bot] Opening freee Web");
      const result = await authenticateFreeeWeb(this.page, creds);
      console.log(result.restored
          ? "[Bot] Restored an existing Web session"
          : "[Bot] Login completed");

      await this.ensureCompany(targetCompany);
      await this.runtime.rememberSession(this.context);
      return true;
    } catch (error) {
      this.runtime.invalidateSession();
      throw error;
    }
  }

  /**
   * Ensure the browser is on the configured company.
   * freee may default to a different company after login.
   * Uses only the explicitly configured Web target for the active account.
   */
  async ensureCompany(targetCompany = getWebCompanyName()) {
    if (!targetCompany) {
      throw automationError(
        "WEB_COMPANY_TARGET_REQUIRED",
        "A target freee company must be configured before Web automation.",
      );
    }

    const headerControls = this.page
      .locator("header")
      .locator("button, a, [role='button']");
    const targetPattern = exactTextPattern(targetCompany);
    const activeTarget = headerControls.filter({ hasText: targetPattern }).first();
    if (await locatorIsVisible(activeTarget)) {
      console.log('[Bot] Configured company is already active');
      return;
    }

    console.log('[Bot] Attempting company switch');

    // Try to find and click the company name in the sidebar to open the dropdown
    // freee shows the current company name as a clickable element
    const companiesData = getSetting("oauth_companies");
    let otherCompanyNames = [];
    try {
      const companies = JSON.parse(companiesData || "[]");
      otherCompanyNames = companies
        .filter((c) => c.name !== targetCompany)
        .map((c) => c.name);
    } catch {
      /* ignore */
    }

    // Click the current company name (could be any of the other companies)
    let switcher = null;
    for (const name of otherCompanyNames) {
      const candidate = headerControls.filter({ hasText: name }).first();
      if (await locatorIsVisible(candidate)) {
        switcher = candidate;
        break;
      }
    }

    if (!switcher) {
      const genericSwitcher = headerControls
        .filter({ hasText: /事業所|会社/ })
        .first();
      if (await locatorIsVisible(genericSwitcher)) switcher = genericSwitcher;
    }

    if (!switcher) {
      throw automationError(
        "WEB_COMPANY_SELECTION_UNCONFIRMED",
        "The configured freee company could not be confirmed before automation.",
      );
    }

    console.log('[Bot] Opening company switcher');
    await switcher.click();

    // Now click the target company in the dropdown
    const targetBtn = this.page
      .locator("a, button, li, [role='menuitem'], [role='option']")
      .filter({ hasText: targetPattern })
      .first();
    await targetBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (!(await locatorIsVisible(targetBtn))) {
      throw automationError(
        "WEB_COMPANY_SELECTION_UNCONFIRMED",
        "The configured freee company was not available in the company switcher.",
      );
    }

    console.log('[Bot] Selecting configured company');
    await targetBtn.click();
    await activeTarget.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await this.page
      .waitForSelector(Object.values(ACTION_SELECTORS).join(', '), {
        state: 'attached',
        timeout: 10_000,
      })
      .catch(() => {});

    if (!(await locatorIsVisible(activeTarget))) {
      throw automationError(
        "WEB_COMPANY_SELECTION_UNCONFIRMED",
        "The configured freee company could not be confirmed after selection.",
      );
    }
    console.log('[Bot] Configured company selected');
  }

  async assertCompanyActive(targetCompany = getWebCompanyName()) {
    if (!targetCompany) {
      throw automationError(
        'WEB_COMPANY_TARGET_REQUIRED',
        'A target freee company must be configured before Web automation.',
      );
    }
    const activeTarget = this.page
      .locator('header')
      .locator("button, a, [role='button']")
      .filter({ hasText: exactTextPattern(targetCompany) })
      .first();
    if (!(await locatorIsVisible(activeTarget))) {
      throw automationError(
        'WEB_COMPANY_SELECTION_UNCONFIRMED',
        'The configured freee company is no longer active.',
      );
    }
  }

  /** Detect current state by checking which buttons are visible/enabled */
  async detectState() {
    await this.page
      .waitForSelector(Object.values(ACTION_SELECTORS).join(", "), {
        state: "attached",
        timeout: 10_000,
      })
      .catch(() => {});

    const checks = {};
    for (const [key, sel] of Object.entries(ACTION_SELECTORS)) {
      const locator = this.page.locator(sel).first();
      checks[key] =
        (await locatorIsVisible(locator)) &&
        (await locator.isEnabled().catch(() => false));
    }

    console.log(`[Bot] Buttons enabled: ${JSON.stringify(checks)}`);

    if (checks.break_end) return FREEE_STATE.ON_BREAK;
    if (checks.checkout || checks.break_start) return FREEE_STATE.WORKING;
    if (checks.checkin) return FREEE_STATE.NOT_CHECKED_IN;
    return FREEE_STATE.UNKNOWN;
  }

  /** Click a specific button and take before/after screenshots */
  async clickAction(actionType, timestamp, expectedIntent = {}) {
    const selector = ACTION_SELECTORS[actionType];

    await this.page.waitForSelector(selector, {
      state: "visible",
      timeout: 10000,
    });
    const beforePath = await this.captureScreenshot(
      `${actionType}-${timestamp}`,
      "before",
      "routine",
    );

    const el = this.page.locator(selector);
    if (!(await el.isEnabled()))
      throw new Error(`Button ${actionType} is not enabled`);

    const validateRequest = (request) => assertTimeClockMutationRequest(request, {
      actionType,
      ...expectedIntent,
    });
    const { response: mutationResponse } = await this.dispatchGuardedMutation(el, {
      validateRequest,
      responsePredicate: (response) => {
        try {
          validateRequest(response.request());
          return true;
        } catch {
          return false;
        }
      },
      timeoutMs: 10_000,
    });
    if (!mutationResponse?.ok()) {
      throw automationError(
        "WEB_ACTION_CONFIRMATION_UNAVAILABLE",
        "freee Web did not confirm the attendance write.",
      );
    }

    const expectedSelectors = {
      checkin: [ACTION_SELECTORS.checkout, ACTION_SELECTORS.break_start],
      checkout: [ACTION_SELECTORS.checkin],
      break_start: [ACTION_SELECTORS.break_end],
      break_end: [ACTION_SELECTORS.checkout, ACTION_SELECTORS.break_start],
    }[actionType] || [];
    await this.page
      .waitForFunction(
        ({ targetSelector, nextSelectors, allowTargetAbsence }) => {
          const button = document.querySelector(targetSelector);
          const targetUnavailable =
            !button ||
            button.disabled ||
            button.getAttribute("aria-disabled") === "true";
          const nextActionAvailable = nextSelectors.some((nextSelector) => {
            const next = document.querySelector(nextSelector);
            return next && !next.disabled && next.getAttribute("aria-disabled") !== "true";
          });
          return nextActionAvailable || (allowTargetAbsence && targetUnavailable);
        },
        {
          targetSelector: selector,
          nextSelectors: expectedSelectors,
          allowTargetAbsence: actionType === "checkout",
        },
        { timeout: 10_000 },
      )
      .catch(() => {});

    let postState = await this.detectState();
    if (actionType === "checkout" && postState === FREEE_STATE.UNKNOWN) {
      postState = FREEE_STATE.CHECKED_OUT;
    }
    if (!EXPECTED_STATE_AFTER_ACTION[actionType]?.includes(postState)) {
      throw automationError(
        "WEB_ACTION_CONFIRMATION_UNAVAILABLE",
        "freee Web did not expose the expected state after the attendance action.",
      );
    }
    const afterPath = await this.captureScreenshot(
      `${actionType}-${timestamp}`,
      "after",
      "routine",
    );

    return { screenshotBefore: beforePath, screenshotAfter: afterPath };
  }

  // ─── DRY Helpers ──────────────────────────────────────────

  /**
   * Navigate to a freee SPA hash-routed URL.
   * Goes to the approval_requests base URL first (if not already there),
   * then navigates to the target hash route.
   *
   * @param {string} targetUrl — full URL with hash route
   * @param {{ finalWaitMs?: number, useLocationHref?: boolean }} options
   */
  async navigateToSpaForm(
    targetUrl,
    { finalWaitMs = 0, useLocationHref = false } = {},
  ) {
    assertAllowedFreeeWebUrl(targetUrl, {
      applicationOnly: true,
      code: "WEB_NAVIGATION_ORIGIN_BLOCKED",
    });
    const currentUrl = this.page.url();
    const baseUrl = "https://p.secure.freee.co.jp/approval_requests";
    if (!currentUrl.startsWith(baseUrl)) {
      await this.page.goto(baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
    }
    if (useLocationHref) {
      await this.page.evaluate(
        (url) => {
          window.location.href = url;
        },
        targetUrl,
      );
    } else {
      await this.page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
    }
    if (finalWaitMs > 0) await this.page.waitForTimeout(finalWaitMs);
  }

  /**
   * Wait for a form/page element with exponential backoff + SPA hash nudge on attempt 3.
   * Returns true if found, throws with debug screenshot if not.
   *
   * @param {() => Promise<boolean>} checkFn — async function returning true when element is found
   * @param {string} targetUrl — SPA URL (used for hash nudge)
   * @param {{ maxAttempts?: number, baseDelay?: number, delayIncrement?: number, debugPrefix?: string }} options
   * @returns {Promise<true>}
   */
  async waitForElement(
    checkFn,
    targetUrl,
    {
      maxAttempts = 5,
      baseDelay = 2000,
      delayIncrement = 1500,
      debugPrefix = "element",
    } = {},
  ) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (await checkFn()) return true;
      const waitMs = baseDelay + attempt * delayIncrement;
      console.log(
        `[Bot] Not loaded yet, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})...`,
      );
      await this.page.waitForTimeout(waitMs);
      if (attempt === 2) {
        await this.page.evaluate(
          (url) => {
            window.location.hash = url.split("#")[1];
          },
          targetUrl,
        );
        await this.page.waitForTimeout(2000);
      }
    }
    const debugPath = await this.captureScreenshot(debugPrefix, "debug", "error");
    if (debugPath) console.log(`[Bot] Debug screenshot: ${debugPath}`);
    throw new Error(`Element not found after ${maxAttempts} attempts`);
  }

  async captureScreenshot(prefix, stage, kind = "routine") {
    if (!shouldCaptureScreenshot(kind)) return null;
    if (!this.screenshotIdentityKey) {
      throw automationError(
        "SCREENSHOT_IDENTITY_UNBOUND",
        "Screenshot capture requires an operation-bound account identity.",
      );
    }
    ensureScreenshotsDir(undefined, this.screenshotIdentityKey);
    const output = safeScreenshotPath(
      prefix,
      stage,
      Date.now(),
      this.screenshotIdentityKey,
    );
    if (fs.existsSync(output)) {
      throw automationError(
        "SCREENSHOT_PATH_COLLISION",
        "Screenshot output path already exists.",
      );
    }
    await this.page.screenshot({ path: output });
    const metadata = fs.lstatSync(output);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fs.rmSync(output, { force: true });
      throw automationError(
        "SCREENSHOT_OUTPUT_UNSAFE",
        "Screenshot output was not a regular file.",
      );
    }
    fs.chmodSync(output, 0o600);
    return `/screenshots/${encodeURIComponent(path.basename(output))}`;
  }

  /**
   * Returns { before(), after() } screenshot helpers with consistent naming.
   * @param {string} prefix — screenshot file prefix
   * @returns {{ before: () => Promise<string>, after: () => Promise<string> }}
   */
  takeScreenshots(prefix) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return {
      before: async () => {
        return this.captureScreenshot(`${prefix}-${ts}`, "before", "routine");
      },
      after: async () => {
        return this.captureScreenshot(`${prefix}-${ts}`, "after", "routine");
      },
    };
  }

  /**
   * Check page body for freee error indicators after form submission.
   * @param {{ extraIndicators?: string[] }} options
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async checkSubmitResult({ extraIndicators = [] } = {}) {
    const bodyText = await this.page.evaluate(() =>
      document.body.innerText.substring(0, 2000),
    );
    const indicators = [
      "エラー",
      "入力してください",
      "申請できませんでした",
      "指定してください",
      "修正してください",
      ...extraIndicators,
    ];
    const found = indicators.find((ind) => bodyText.includes(ind));
    if (found) {
      return {
        success: false,
        error: `freee form rejected submission: ${found}`,
      };
    }
    return { success: true };
  }
}
