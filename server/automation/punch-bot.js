import { chromium } from "playwright";
import chalk from "chalk";
import path from "path";
import { getSetting } from "../db.js";
import { FREEE_STATE, FREEE_ERROR_MESSAGES } from "../constants.js";
import {
  ACTION_SELECTORS,
  APPROVAL_TYPE_MAP,
  SCREENSHOTS_DIR,
} from "./constants.js";
import { getCredentials } from "./utils.js";

export class PunchBot {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async init() {
    this.browser = await chromium.launch({ headless: true, slowMo: 100 });
    this.page = await this.browser.newPage();
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  async login() {
    const creds = getCredentials();
    if (!creds.username || !creds.password) {
      const err = new Error("freee credentials not configured");
      err.code = "WEB_CREDENTIALS_NOT_CONFIGURED";
      throw err;
    }

    const url = "https://p.secure.freee.co.jp/";
    console.log(chalk.blue(`[Bot] Navigating to ${url}...`));
    await this.page.goto(url);

    await this.page.fill("input[name='loginId']", creds.username);
    await this.page.fill("input[name='password']", creds.password);
    await this.page.click("button[type='submit']");

    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 15000 });
      await this.page.waitForTimeout(3000);
    } catch {
      /* timeout ok */
    }

    // Detect login failure — freee shows error messages on the login page
    const currentUrl = this.page.url();
    const bodyText = await this.page
      .evaluate(() => document.body.innerText.substring(0, 2000))
      .catch(() => "");

    // Check for common login failure indicators
    const loginFailed =
      currentUrl.includes("/login") ||
      currentUrl.includes("/session") ||
      bodyText.includes("ログインできませんでした") ||
      bodyText.includes("メールアドレスまたはパスワードが正しくありません") ||
      bodyText.includes("ログイン情報が正しくありません") ||
      bodyText.includes("アカウントがロック") ||
      bodyText.includes("Invalid login") ||
      bodyText.includes("incorrect password");

    if (loginFailed) {
      // Take debug screenshot
      const debugPath = path.join(
        SCREENSHOTS_DIR,
        `login-failed-${Date.now()}.png`,
      );
      await this.page.screenshot({ path: debugPath }).catch(() => {});
      console.log(
        chalk.red(`[Bot] Login failed. Debug screenshot: ${debugPath}`),
      );

      const err = new Error(
        `freee Web login failed — credentials may be incorrect or expired. ` +
          `Please update your freee login credentials in Settings. ` +
          `Page: ${bodyText.substring(0, 150)}`,
      );
      err.code = "WEB_LOGIN_FAILED";
      err.debugScreenshot = debugPath;
      throw err;
    }

    console.log(chalk.green("[Bot] Login completed"));

    // Ensure we're on the correct company
    await this.ensureCompany();

    return true;
  }

  /**
   * Ensure the browser is on the configured company.
   * freee may default to a different company after login.
   * Reads oauth_company_name from DB and switches if needed.
   */
  async ensureCompany() {
    const targetCompany = getSetting("oauth_company_name");
    if (!targetCompany) return; // no target configured

    // Check current company by reading the sidebar text
    const bodyText = await this.page
      .evaluate(() => document.body.innerText.substring(0, 2000))
      .catch(() => "");

    if (bodyText.includes(targetCompany)) {
      console.log(chalk.green(`[Bot] Already on company: ${targetCompany}`));
      return;
    }

    console.log(
      chalk.yellow(
        `[Bot] Not on ${targetCompany}, attempting company switch...`,
      ),
    );

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
    let clicked = false;
    for (const name of otherCompanyNames) {
      const companyBtn = this.page.locator(`text=${name}`).first();
      if ((await companyBtn.count()) > 0) {
        console.log(
          chalk.blue(`[Bot] Clicking "${name}" to open company switcher...`),
        );
        await companyBtn.click();
        await this.page.waitForTimeout(2000);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      console.log(chalk.yellow("[Bot] Could not find company switcher button"));
      return;
    }

    // Now click the target company in the dropdown
    const targetBtn = this.page.locator(`text=${targetCompany}`).first();
    if ((await targetBtn.count()) > 0) {
      console.log(chalk.blue(`[Bot] Switching to "${targetCompany}"...`));
      await targetBtn.click();
      await this.page.waitForTimeout(5000);
      console.log(chalk.green(`[Bot] Switched to ${targetCompany}`));
    } else {
      console.log(
        chalk.red(`[Bot] "${targetCompany}" not found in company dropdown`),
      );
    }
  }

  /** Detect current state by checking which buttons are visible/enabled */
  async detectState() {
    await this.page.waitForTimeout(2000);

    const checks = {};
    for (const [key, sel] of Object.entries(ACTION_SELECTORS)) {
      const el = await this.page.$(sel);
      checks[key] = el ? await el.isEnabled().catch(() => false) : false;
    }

    console.log(chalk.blue(`[Bot] Buttons enabled: ${JSON.stringify(checks)}`));

    if (checks.break_end) return FREEE_STATE.ON_BREAK;
    if (checks.checkout || checks.break_start) return FREEE_STATE.WORKING;
    if (checks.checkin) return FREEE_STATE.NOT_CHECKED_IN;
    return FREEE_STATE.CHECKED_OUT;
  }

  /** Click a specific button and take before/after screenshots */
  async clickAction(actionType, timestamp) {
    const selector = ACTION_SELECTORS[actionType];
    const beforePath = path.join(
      SCREENSHOTS_DIR,
      `${actionType}-before-${timestamp}.png`,
    );
    const afterPath = path.join(
      SCREENSHOTS_DIR,
      `${actionType}-after-${timestamp}.png`,
    );

    await this.page.waitForSelector(selector, {
      state: "visible",
      timeout: 10000,
    });
    await this.page.screenshot({ path: beforePath });

    const el = this.page.locator(selector);
    if (!(await el.isEnabled()))
      throw new Error(`Button ${actionType} is not enabled`);

    try {
      await this.page.click(selector, { timeout: 10000 });
    } catch {
      await this.page.click(selector, { force: true });
    }

    await this.page.waitForTimeout(3000);
    await this.page.screenshot({ path: afterPath });

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
    { finalWaitMs = 3000, useLocationHref = false } = {},
  ) {
    const currentUrl = this.page.url();
    const baseUrl = "https://p.secure.freee.co.jp/approval_requests";
    if (!currentUrl.startsWith(baseUrl)) {
      await this.page.goto(baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await this.page.waitForTimeout(3000);
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
    await this.page.waitForTimeout(finalWaitMs);
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
        chalk.yellow(
          `[Bot] Not loaded yet, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})...`,
        ),
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
    // Not found — take debug screenshot and throw
    const debugPath = path.join(
      SCREENSHOTS_DIR,
      `${debugPrefix}-debug-${Date.now()}.png`,
    );
    await this.page.screenshot({ path: debugPath }).catch(() => {});
    console.log(chalk.red(`[Bot] Debug screenshot: ${debugPath}`));
    const bodySnippet = await this.page
      .evaluate(() => document.body.innerText.substring(0, 500))
      .catch(() => "");
    throw new Error(
      `Element not found after ${maxAttempts} attempts. Page: ${bodySnippet.substring(0, 200)}`,
    );
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
        const p = path.join(SCREENSHOTS_DIR, `${prefix}-before-${ts}.png`);
        await this.page.screenshot({ path: p });
        return p;
      },
      after: async () => {
        const p = path.join(SCREENSHOTS_DIR, `${prefix}-after-${ts}.png`);
        await this.page.screenshot({ path: p });
        return p;
      },
    };
  }

  /**
   * Check page body for freee error indicators after form submission.
   * @param {{ extraIndicators?: string[] }} options
   * @returns {Promise<{ success: boolean, error?: string, bodyText: string }>}
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
      const pattern = indicators.map((i) => `${i}.{0,100}`).join("|");
      const errorDetail =
        bodyText.match(new RegExp(`(${pattern})`))?.[0] ||
        "Unknown form error";
      return { success: false, error: errorDetail, bodyText };
    }
    return { success: true, bodyText };
  }
}
