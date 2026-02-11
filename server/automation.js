import { chromium } from 'playwright';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSetting } from './db.js';
import { decrypt } from './crypto.js';
import { FreeeApiClient } from './freee-api.js';
import { FREEE_STATE } from './constants.js';

// Re-export for consumers that import from automation.js
export { FREEE_STATE };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || path.resolve(__dirname, '..', 'screenshots');

// Ensure screenshots directory
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Mutex to prevent concurrent Playwright executions
let isRunning = false;
const runQueue = [];

function acquireLock() {
  return new Promise((resolve) => {
    if (!isRunning) {
      isRunning = true;
      resolve();
    } else {
      runQueue.push(resolve);
    }
  });
}

function releaseLock() {
  if (runQueue.length > 0) {
    runQueue.shift()();
  } else {
    isRunning = false;
  }
}

const ACTION_SELECTORS = {
  checkin: '[data-testid="出勤"]',
  checkout: '[data-testid="退勤"]',
  break_start: '[data-testid="休憩開始"]',
  break_end: '[data-testid="休憩終了"]',
};

const ACTION_LABELS = {
  checkin: 'Check-in (出勤)',
  checkout: 'Check-out (退勤)',
  break_start: 'Break Start (休憩開始)',
  break_end: 'Break End (休憩終了)',
};

/**
 * Get freee login credentials (GUI config takes priority over env)
 */
function getCredentials() {
  const dbUsernameEnc = getSetting('freee_username_encrypted');
  const dbPasswordEnc = getSetting('freee_password_encrypted');

  if (dbUsernameEnc && dbPasswordEnc) {
    const username = decrypt(dbUsernameEnc);
    const password = decrypt(dbPasswordEnc);
    if (username && password) {
      return { username, password };
    }
  }

  // Fallback to environment variables
  return {
    username: process.env.LOGIN_USERNAME || '',
    password: process.env.LOGIN_PASSWORD || '',
  };
}

/** Get the active connection mode — always 'api' now (browser mode disabled) */
export function getConnectionMode() {
  return getSetting('connection_mode') || 'api';
}

/** Check if credentials are configured — API (OAuth) only */
export function hasCredentials() {
  return getSetting('oauth_configured') === '1';
}

/** Check if debug/mock mode is enabled */
export function isDebugMode() {
  return getSetting('debug_mode') === '1';
}

// ─── Real Playwright automation ───────────────────────────

class FreeeBot {
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
      const err = new Error('freee credentials not configured');
      err.code = 'WEB_CREDENTIALS_NOT_CONFIGURED';
      throw err;
    }

    const url = 'https://p.secure.freee.co.jp/';
    console.log(chalk.blue(`[Bot] Navigating to ${url}...`));
    await this.page.goto(url);

    await this.page.fill("input[name='loginId']", creds.username);
    await this.page.fill("input[name='password']", creds.password);
    await this.page.click("button[type='submit']");

    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await this.page.waitForTimeout(3000);
    } catch {
      /* timeout ok */
    }

    // Detect login failure — freee shows error messages on the login page
    const currentUrl = this.page.url();
    const bodyText = await this.page.evaluate(() => document.body.innerText.substring(0, 2000)).catch(() => '');

    // Check for common login failure indicators
    const loginFailed =
      currentUrl.includes('/login') ||
      currentUrl.includes('/session') ||
      bodyText.includes('ログインできませんでした') ||
      bodyText.includes('メールアドレスまたはパスワードが正しくありません') ||
      bodyText.includes('ログイン情報が正しくありません') ||
      bodyText.includes('アカウントがロック') ||
      bodyText.includes('Invalid login') ||
      bodyText.includes('incorrect password');

    if (loginFailed) {
      // Take debug screenshot
      const debugPath = path.join(SCREENSHOTS_DIR, `login-failed-${Date.now()}.png`);
      await this.page.screenshot({ path: debugPath }).catch(() => {});
      console.log(chalk.red(`[Bot] Login failed. Debug screenshot: ${debugPath}`));

      const err = new Error(
        `freee Web login failed — credentials may be incorrect or expired. ` +
        `Please update your freee login credentials in Settings. ` +
        `Page: ${bodyText.substring(0, 150)}`
      );
      err.code = 'WEB_LOGIN_FAILED';
      err.debugScreenshot = debugPath;
      throw err;
    }

    console.log(chalk.green('[Bot] Login completed'));

    // Ensure we're on the correct company (テスト事業所 vs GCU)
    await this.ensureCompany();

    return true;
  }

  /**
   * Ensure the browser is on the configured company.
   * freee may default to a different company after login (e.g., 株式会社GCU).
   * Reads oauth_company_name from DB and switches if needed.
   */
  async ensureCompany() {
    const targetCompany = getSetting('oauth_company_name');
    if (!targetCompany) return; // no target configured

    // Check current company by reading the sidebar text
    const bodyText = await this.page.evaluate(() => document.body.innerText.substring(0, 2000)).catch(() => '');

    if (bodyText.includes(targetCompany)) {
      console.log(chalk.green(`[Bot] Already on company: ${targetCompany}`));
      return;
    }

    console.log(chalk.yellow(`[Bot] Not on ${targetCompany}, attempting company switch...`));

    // Try to find and click the company name in the sidebar to open the dropdown
    // freee shows the current company name as a clickable element
    const companiesData = getSetting('oauth_companies');
    let otherCompanyNames = [];
    try {
      const companies = JSON.parse(companiesData || '[]');
      otherCompanyNames = companies.filter(c => c.name !== targetCompany).map(c => c.name);
    } catch { /* ignore */ }

    // Click the current company name (could be any of the other companies)
    let clicked = false;
    for (const name of otherCompanyNames) {
      const companyBtn = this.page.locator(`text=${name}`).first();
      if ((await companyBtn.count()) > 0) {
        console.log(chalk.blue(`[Bot] Clicking "${name}" to open company switcher...`));
        await companyBtn.click();
        await this.page.waitForTimeout(2000);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      console.log(chalk.yellow('[Bot] Could not find company switcher button'));
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
      console.log(chalk.red(`[Bot] "${targetCompany}" not found in company dropdown`));
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
    const beforePath = path.join(SCREENSHOTS_DIR, `${actionType}-before-${timestamp}.png`);
    const afterPath = path.join(SCREENSHOTS_DIR, `${actionType}-after-${timestamp}.png`);

    await this.page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
    await this.page.screenshot({ path: beforePath });

    const el = this.page.locator(selector);
    if (!(await el.isEnabled())) throw new Error(`Button ${actionType} is not enabled`);

    try {
      await this.page.click(selector, { timeout: 10000 });
    } catch {
      await this.page.click(selector, { force: true });
    }

    await this.page.waitForTimeout(3000);
    await this.page.screenshot({ path: afterPath });

    return { screenshotBefore: beforePath, screenshotAfter: afterPath };
  }

  /**
   * Submit a work time correction via freee Web form (勤務時間修正申請).
   * This navigates directly to the correction form URL with the target date,
   * fills in times, and clicks submit.
   *
   * @param {string} date — YYYY-MM-DD
   * @param {object} times — { clockInHour, clockInMin, clockOutHour, clockOutMin, breakStartHour?, breakStartMin?, breakEndHour?, breakEndMin? }
   * @param {string} [reason] — 申請理由 text
   * @returns {{ success: boolean, error?: string }}
   */
  async submitWorkTimeCorrection(date, times, reason) {
    const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=ApprovalRequest::WorkTime&target_date=${date}`;
    console.log(chalk.blue(`[Bot] Navigating to correction form: ${formUrl}`));

    // freee uses SPA hash routing — navigate to the base path first, then handle hash
    const currentUrl = this.page.url();
    const baseUrl = 'https://p.secure.freee.co.jp/approval_requests';
    if (!currentUrl.startsWith(baseUrl)) {
      // Full navigation needed — go to base URL first
      await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.page.waitForTimeout(3000);
    }
    // Navigate to the hash route (SPA internal routing)
    await this.page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    // Wait for the form to render (SPA React rendering) — retry with exponential backoff
    // Note: freee updated their selector from #approval-request-date-input to #approval-request-fields-date
    const dateInput = this.page.locator('#approval-request-fields-date');
    let formLoaded = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((await dateInput.count()) > 0) {
        formLoaded = true;
        break;
      }
      const waitMs = 2000 + attempt * 1500;  // 2s, 3.5s, 5s, 6.5s, 8s
      console.log(chalk.yellow(`[Bot] Form not loaded yet, waiting ${waitMs}ms (attempt ${attempt + 1}/5)...`));
      await this.page.waitForTimeout(waitMs);
      // Try re-navigating the hash on later attempts (SPA may need a nudge)
      if (attempt === 2) {
        await this.page.evaluate((url) => { window.location.hash = url.split('#')[1]; }, formUrl);
        await this.page.waitForTimeout(2000);
      }
    }
    if (!formLoaded) {
      // Take a debug screenshot before failing
      const debugPath = path.join(SCREENSHOTS_DIR, `web-correction-debug-${date}-${Date.now()}.png`);
      await this.page.screenshot({ path: debugPath }).catch(() => {});
      console.log(chalk.red(`[Bot] Debug screenshot: ${debugPath}`));
      const bodySnippet = await this.page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
      throw new Error(`Correction form did not load — date input not found after 5 attempts. Page content: ${bodySnippet.substring(0, 200)}`);
    }
    const dateValue = await dateInput.inputValue();
    if (dateValue !== date) {
      console.log(chalk.yellow(`[Bot] Date mismatch: expected ${date}, got ${dateValue}`));
    }

    // Ensure "勤務時間を修正する" radio is selected (default, but be explicit)
    const modifyRadio = this.page.locator('[data-testid="clear-work-time-false"]');
    if ((await modifyRadio.count()) > 0) {
      await modifyRadio.click();
      await this.page.waitForTimeout(300);
    }

    // Helper: fill a combobox time input
    const fillTimeInput = async (id, value) => {
      const input = this.page.locator(`#${id}`);
      if ((await input.count()) === 0) {
        throw new Error(`Time input #${id} not found`);
      }
      await input.click();
      await this.page.waitForTimeout(200);
      await input.fill(String(value).padStart(2, '0'));
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Tab');
      await this.page.waitForTimeout(200);
    };

    // Fill check-in time
    await fillTimeInput('approval-request-fields-segment-clock-in-at-hour-0', times.clockInHour);
    await fillTimeInput('approval-request-fields-segment-clock-in-at-minute-0', times.clockInMin);

    // Fill check-out time
    await fillTimeInput('approval-request-fields-segment-clock-out-at-hour-0', times.clockOutHour);
    await fillTimeInput('approval-request-fields-segment-clock-out-at-minute-0', times.clockOutMin);

    // Fill break times (if provided), or remove the default empty break row
    if (times.breakStartHour !== undefined && times.breakEndHour !== undefined) {
      await fillTimeInput('approval-request-fields-break-clock-in-at-hour-0', times.breakStartHour);
      await fillTimeInput('approval-request-fields-break-clock-in-at-minute-0', times.breakStartMin);
      await fillTimeInput('approval-request-fields-break-clock-out-at-hour-0', times.breakEndHour);
      await fillTimeInput('approval-request-fields-break-clock-out-at-minute-0', times.breakEndMin);
    } else {
      // No break data — remove the default empty break row (freee adds one by default)
      // The delete button is near the break time inputs (trash icon button)
      try {
        const breakDeleteBtn = this.page.locator('button[aria-label*="削除"], button[aria-label*="休憩"]').first();
        if ((await breakDeleteBtn.count()) > 0) {
          await breakDeleteBtn.click();
          await this.page.waitForTimeout(300);
          console.log(chalk.blue('[Bot] Removed empty break row'));
        } else {
          // Fallback: find the trash icon button near break fields
          const breakSection = this.page.locator('#approval-request-fields-break-clock-in-at-hour-0');
          if ((await breakSection.count()) > 0) {
            // The delete button is a sibling in the same row — find it by proximity
            const trashBtn = this.page.locator('button:has(svg)').filter({ has: this.page.locator('path[d*="M6"]') })
              .or(this.page.locator('[data-testid*="delete"], [data-testid*="remove"]'));
            // Try a simpler approach: look for any button near the break fields
            const rowBtns = await this.page.evaluate(() => {
              const breakInput = document.getElementById('approval-request-fields-break-clock-in-at-hour-0');
              if (!breakInput) return null;
              // Walk up to find the row container
              let row = breakInput;
              for (let i = 0; i < 10 && row.parentElement; i++) {
                row = row.parentElement;
                const btns = row.querySelectorAll('button');
                if (btns.length > 0) {
                  // Find the delete/trash button (usually last button with an SVG icon)
                  for (const btn of btns) {
                    const svg = btn.querySelector('svg');
                    if (svg && !btn.textContent?.trim()) {
                      btn.click();
                      return 'clicked';
                    }
                  }
                }
              }
              return null;
            });
            if (rowBtns === 'clicked') {
              await this.page.waitForTimeout(300);
              console.log(chalk.blue('[Bot] Removed empty break row (via JS)'));
            }
          }
        }
      } catch (breakErr) {
        console.log(chalk.yellow(`[Bot] Could not remove empty break row: ${breakErr.message}`));
      }
    }

    // Fill reason
    if (reason) {
      const reasonInput = this.page.locator('[data-testid="申請理由"]');
      if ((await reasonInput.count()) > 0) {
        await reasonInput.click();
        await this.page.waitForTimeout(200);
        await reasonInput.fill(reason);
        await this.page.waitForTimeout(200);
      }
    }

    // Select approver — freee uses vibes vb-comboBox (not <select>)
    // Input: id="approval-request-fields-approver_id", placeholder="選択してください"
    // The listbox options are covered by adjacent combobox overlays, so we use
    // page.evaluate() to programmatically click instead of Playwright .click()
    try {
      const approverInput = this.page.locator('#approval-request-fields-approver_id');
      if ((await approverInput.count()) > 0) {
        const currentVal = await approverInput.inputValue();
        if (!currentVal) {
          // Scroll the approver input into view first
          await approverInput.scrollIntoViewIfNeeded();
          await this.page.waitForTimeout(300);

          // Click the input to open the dropdown
          await approverInput.click();
          await this.page.waitForTimeout(800);

          // Get the listbox ID and select the first option via JS (bypasses overlay interception)
          const approverName = await this.page.evaluate(() => {
            const input = document.getElementById('approval-request-fields-approver_id');
            if (!input) return null;
            const listboxId = input.getAttribute('aria-controls');
            if (!listboxId) return null;
            const listbox = document.getElementById(listboxId);
            if (!listbox) return null;
            const firstOption = listbox.querySelector('[role="option"]');
            if (!firstOption) return null;
            const name = firstOption.textContent?.trim();
            // Dispatch click event directly on the option element
            firstOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            firstOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            firstOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return name;
          });

          await this.page.waitForTimeout(500);

          if (approverName) {
            // Verify the input now has a value
            const newVal = await approverInput.inputValue();
            if (newVal) {
              console.log(chalk.green(`[Bot] Selected approver: ${approverName} (confirmed: ${newVal})`));
            } else {
              // If dispatchEvent didn't trigger React state update, try keyboard approach
              console.log(chalk.yellow(`[Bot] Click dispatch didn't set value, trying keyboard...`));
              await approverInput.click();
              await this.page.waitForTimeout(500);
              await this.page.keyboard.press('ArrowDown');
              await this.page.waitForTimeout(200);
              await this.page.keyboard.press('Enter');
              await this.page.waitForTimeout(500);
              const retryVal = await approverInput.inputValue();
              console.log(chalk.green(`[Bot] Approver after keyboard: "${retryVal}"`));
            }
          } else {
            console.log(chalk.yellow('[Bot] No approver options found in listbox'));
          }
        } else {
          console.log(chalk.green(`[Bot] Approver already selected: ${currentVal}`));
        }
      } else {
        console.log(chalk.yellow('[Bot] Approver input #approval-request-fields-approver_id not found'));
      }
    } catch (approverErr) {
      console.log(chalk.yellow(`[Bot] Approver selection error: ${approverErr.message}`));
    }

    // Screenshot before submit
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const beforePath = path.join(SCREENSHOTS_DIR, `web-correction-${date}-before-${ts}.png`);
    await this.page.screenshot({ path: beforePath });

    // Click submit button
    console.log(chalk.blue(`[Bot] Submitting correction for ${date}...`));
    const submitBtn = this.page.locator('button[type="submit"]').filter({ hasText: '申請' });
    if ((await submitBtn.count()) === 0) {
      throw new Error('Submit button not found');
    }
    await submitBtn.click();
    await this.page.waitForTimeout(5000);

    // Screenshot after submit
    const afterPath = path.join(SCREENSHOTS_DIR, `web-correction-${date}-after-${ts}.png`);
    await this.page.screenshot({ path: afterPath });

    // Check for success — after successful submit, the page navigates to the request list
    // or shows a success message
    const postSubmitUrl = this.page.url();
    const bodyText = await this.page.evaluate(() => document.body.innerText.substring(0, 2000));

    // Check for error indicators
    if (
      bodyText.includes('エラー') ||
      bodyText.includes('入力してください') ||
      bodyText.includes('申請できませんでした') ||
      bodyText.includes('指定してください') ||
      bodyText.includes('修正してください')
    ) {
      const errorDetail = bodyText.match(
        /(エラー.{0,100}|入力してください.{0,50}|申請できませんでした.{0,80}|承認者を指定してください.{0,30})/
      )?.[0] || 'Unknown form error';
      console.log(chalk.red(`[Bot] Correction form error for ${date}: ${errorDetail}`));
      return { success: false, error: errorDetail, screenshotBefore: beforePath, screenshotAfter: afterPath };
    }

    // If we're still on the same form URL, something may have gone wrong
    if (postSubmitUrl.includes('requests/new')) {
      // Check if there's a validation error shown
      const hasError = await this.page.locator('.vb-message--error, [role="alert"]').count();
      if (hasError > 0) {
        const errorText = await this.page.locator('.vb-message--error, [role="alert"]').first().textContent();
        return { success: false, error: errorText || 'Validation error', screenshotBefore: beforePath, screenshotAfter: afterPath };
      }
    }

    console.log(chalk.green(`[Bot] Correction submitted for ${date}`));
    return { success: true, screenshotBefore: beforePath, screenshotAfter: afterPath };
  }

  /**
   * Scrape employee profile information from freee Web.
   * Navigates to the profile page and extracts key fields.
   *
   * @param {string|number} employeeId — freee employee ID
   * @returns {object} Employee info: { name, department, position, employment_type, entry_date, employee_num, ... }
   */
  async scrapeEmployeeInfo(employeeId) {
    const profileUrl = `https://p.secure.freee.co.jp/employees/${employeeId}/profile`;
    console.log(chalk.blue(`[Bot] Navigating to employee profile: ${profileUrl}`));

    // First try the newer URL format
    await this.page.goto(profileUrl);
    await this.page.waitForTimeout(4000);

    // If redirected to a different page, try the hash-based format
    if (!this.page.url().includes('profile')) {
      const altUrl = `https://p.secure.freee.co.jp/employees#${employeeId}/profile`;
      console.log(chalk.blue(`[Bot] Trying alternative URL: ${altUrl}`));
      await this.page.goto(altUrl);
      await this.page.waitForTimeout(4000);
    }

    // Extract employee info from the page
    const info = await this.page.evaluate(() => {
      const result = {};
      const body = document.body.innerText;

      // Try to find common profile field patterns
      // freee profile pages typically show fields in label-value pairs
      const getFieldValue = (labels) => {
        for (const label of labels) {
          // Look for patterns like "姓名\nValue" or label in a dd/dt structure
          const regex = new RegExp(`${label}[\\s:：]*([^\\n]+)`, 'i');
          const match = body.match(regex);
          if (match) return match[1].trim();
        }
        return null;
      };

      result.name = getFieldValue(['氏名', '名前', 'Name']);
      result.department = getFieldValue(['部門', '部署', 'Department']);
      result.position = getFieldValue(['役職', 'Position', 'Title']);
      result.employment_type = getFieldValue(['雇用形態', 'Employment']);
      result.entry_date = getFieldValue(['入社日', 'Entry Date', '入社年月日']);
      result.employee_num = getFieldValue(['社員番号', 'Employee Number', 'Employee No']);

      // Also try to extract from structured elements
      const dts = document.querySelectorAll('dt, th, label');
      for (const dt of dts) {
        const text = dt.textContent.trim();
        const dd = dt.nextElementSibling;
        const value = dd ? dd.textContent.trim() : null;
        if (!value) continue;

        if (text.includes('氏名') || text.includes('名前')) result.name = result.name || value;
        if (text.includes('部門') || text.includes('部署')) result.department = result.department || value;
        if (text.includes('役職')) result.position = result.position || value;
        if (text.includes('雇用形態')) result.employment_type = result.employment_type || value;
        if (text.includes('入社日') || text.includes('入社年月日')) result.entry_date = result.entry_date || value;
        if (text.includes('社員番号')) result.employee_num = result.employee_num || value;
      }

      return result;
    });

    console.log(chalk.green(`[Bot] Employee info scraped: ${JSON.stringify(info)}`));
    return info;
  }

  /**
   * Submit a leave request via freee Web form.
   *
   * @param {string} type — e.g. 'PaidHoliday', 'SpecialHoliday', 'Absence', 'HolidayWork'
   * @param {string} date — YYYY-MM-DD
   * @param {object} options — { halfDay?: boolean, reason?: string }
   * @returns {{ success: boolean, error?: string }}
   */
  async submitLeaveRequest(type, date, options = {}) {
    const typeMap = {
      PaidHoliday: 'ApprovalRequest::PaidHoliday',
      SpecialHoliday: 'ApprovalRequest::SpecialHoliday',
      Absence: 'ApprovalRequest::Absence',
      HolidayWork: 'ApprovalRequest::HolidayWork',
      OvertimeWork: 'ApprovalRequest::OvertimeWork',
    };

    const freeeType = typeMap[type] || `ApprovalRequest::${type}`;
    const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=${freeeType}&target_date=${date}`;
    console.log(chalk.blue(`[Bot] Navigating to leave request form: ${formUrl}`));

    // freee uses SPA hash routing — navigate to the base path first, then handle hash
    const currentUrl = this.page.url();
    const baseUrl = 'https://p.secure.freee.co.jp/approval_requests';
    if (!currentUrl.startsWith(baseUrl)) {
      await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.page.waitForTimeout(3000);
    }
    await this.page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this.page.waitForTimeout(4000);

    // Verify the form loaded (freee updated selector from #approval-request-date-input)
    const dateInput = this.page.locator('#approval-request-fields-date');
    let formLoaded = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((await dateInput.count()) > 0) {
        formLoaded = true;
        break;
      }
      const waitMs = 2000 + attempt * 1500;
      console.log(chalk.yellow(`[Bot] Leave form not loaded yet, waiting ${waitMs}ms (attempt ${attempt + 1}/5)...`));
      await this.page.waitForTimeout(waitMs);
      if (attempt === 2) {
        await this.page.evaluate((url) => { window.location.hash = url.split('#')[1]; }, formUrl);
        await this.page.waitForTimeout(2000);
      }
    }
    if (!formLoaded) {
      const debugPath = path.join(SCREENSHOTS_DIR, `leave-debug-${type}-${date}-${Date.now()}.png`);
      await this.page.screenshot({ path: debugPath }).catch(() => {});
      const bodySnippet = await this.page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
      throw new Error(`Leave form did not load — date input not found after 5 attempts. Page content: ${bodySnippet.substring(0, 200)}`);
    }

    // Fill time fields if provided (for OvertimeWork, PaidHoliday half/hour)
    if (options.startTime) {
      const startInput = this.page.locator('#approval-request-fields-started-at');
      if ((await startInput.count()) > 0) {
        await startInput.click();
        await this.page.waitForTimeout(200);
        await startInput.fill(options.startTime);
        await this.page.keyboard.press('Tab');
        await this.page.waitForTimeout(200);
      }
    }
    if (options.endTime) {
      const endInput = this.page.locator('#approval-request-fields-end-at');
      if ((await endInput.count()) > 0) {
        await endInput.click();
        await this.page.waitForTimeout(200);
        await endInput.fill(options.endTime);
        await this.page.keyboard.press('Tab');
        await this.page.waitForTimeout(200);
      }
    }

    // Fill reason if provided
    if (options.reason) {
      const reasonInput = this.page.locator('[data-testid="申請理由"]');
      if ((await reasonInput.count()) > 0) {
        await reasonInput.click();
        await this.page.waitForTimeout(200);
        await reasonInput.fill(options.reason);
        await this.page.waitForTimeout(200);
      }
    }

    // Select approval route if available
    const routeSelect = this.page.locator('#approval-request-fields-route-id');
    if ((await routeSelect.count()) > 0 && options.routeId) {
      await routeSelect.selectOption(String(options.routeId));
      await this.page.waitForTimeout(300);
    }

    // Select approver if needed
    if (options.approverId) {
      const approverInput = this.page.locator('#approval-request-fields-approver_id');
      if ((await approverInput.count()) > 0) {
        await approverInput.click();
        await this.page.waitForTimeout(500);
        await approverInput.fill('');
        await this.page.waitForTimeout(500);
        // Select first option from the dropdown
        const listboxId = await approverInput.getAttribute('aria-controls');
        if (listboxId) {
          const firstOption = this.page.locator(`#${listboxId} [role="option"]`).first();
          if ((await firstOption.count()) > 0) {
            await firstOption.click();
            await this.page.waitForTimeout(300);
          }
        }
      }
    }

    // Screenshot before submit
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const beforePath = path.join(SCREENSHOTS_DIR, `leave-${type}-${date}-before-${ts}.png`);
    await this.page.screenshot({ path: beforePath });

    // Submit
    console.log(chalk.blue(`[Bot] Submitting ${type} leave for ${date}...`));
    const submitBtn = this.page.locator('button[type="submit"]').filter({ hasText: '申請' });
    if ((await submitBtn.count()) === 0) {
      throw new Error('Submit button not found');
    }
    await submitBtn.click();
    await this.page.waitForTimeout(5000);

    // Screenshot after submit
    const afterPath = path.join(SCREENSHOTS_DIR, `leave-${type}-${date}-after-${ts}.png`);
    await this.page.screenshot({ path: afterPath });

    // Check for errors
    const bodyText = await this.page.evaluate(() => document.body.innerText.substring(0, 2000));
    if (bodyText.includes('エラー') || bodyText.includes('入力してください')) {
      const errorDetail = bodyText.match(/(エラー.{0,100}|入力してください.{0,50})/)?.[0] || 'Unknown form error';
      return { success: false, error: errorDetail };
    }

    console.log(chalk.green(`[Bot] Leave request submitted: ${type} for ${date}`));
    return { success: true };
  }
}

// ─── Mock mode ────────────────────────────────────────────

// In-memory mock state for the session
let mockState = FREEE_STATE.NOT_CHECKED_IN;
let mockStateDate = '';

function resetMockStateIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (mockStateDate !== today) {
    mockState = FREEE_STATE.NOT_CHECKED_IN;
    mockStateDate = today;
  }
}

function mockDetectState() {
  resetMockStateIfNewDay();
  return mockState;
}

function mockTransition(actionType) {
  resetMockStateIfNewDay();
  switch (actionType) {
    case 'checkin':
      mockState = FREEE_STATE.WORKING;
      break;
    case 'break_start':
      mockState = FREEE_STATE.ON_BREAK;
      break;
    case 'break_end':
      mockState = FREEE_STATE.WORKING;
      break;
    case 'checkout':
      mockState = FREEE_STATE.CHECKED_OUT;
      break;
  }
}

async function mockExecuteAction(actionType) {
  console.log(chalk.yellow(`[MOCK] Simulating ${ACTION_LABELS[actionType]}`));
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));

  // Validate transition
  const valid = isActionValidForState(actionType, mockDetectState());
  if (!valid.ok) {
    return { status: 'skipped', screenshotBefore: null, screenshotAfter: null, durationMs: 100, error: valid.reason, mock: true, detectedState: mockDetectState() };
  }

  mockTransition(actionType);
  console.log(chalk.green(`[MOCK] ${ACTION_LABELS[actionType]} done -> state=${mockState}`));

  return { status: 'success', screenshotBefore: null, screenshotAfter: null, durationMs: Math.floor(300 + Math.random() * 1500), error: null, mock: true, detectedState: mockState };
}

// ─── Public API ───────────────────────────────────────────

/** Detect current freee attendance state */
export async function detectCurrentState() {
  if (isDebugMode()) {
    const s = mockDetectState();
    console.log(chalk.yellow(`[MOCK] State: ${s}`));
    return s;
  }

  if (!hasCredentials()) return FREEE_STATE.UNKNOWN;

  // API mode — no browser/mutex needed
  if (getConnectionMode() === 'api') {
    try {
      const client = new FreeeApiClient();
      return await client.detectState();
    } catch (e) {
      console.error(chalk.red(`[API] detectState failed: ${e.message}`));
      return FREEE_STATE.UNKNOWN;
    }
  }

  // Browser mode — Playwright with mutex
  await acquireLock();
  const bot = new FreeeBot();
  try {
    await bot.init();
    await bot.login();
    return await bot.detectState();
  } catch (e) {
    console.error(chalk.red(`[Bot] detectState failed: ${e.message}`));
    return FREEE_STATE.UNKNOWN;
  } finally {
    await bot.cleanup();
    releaseLock();
  }
}

/** Execute a check-in/check-out action */
export async function executeAction(actionType) {
  if (isDebugMode()) return mockExecuteAction(actionType);

  if (!hasCredentials()) {
    return { status: 'failure', screenshotBefore: null, screenshotAfter: null, durationMs: 0, error: 'freee credentials not configured. Go to Settings.' };
  }

  // API mode — no browser/mutex needed
  if (getConnectionMode() === 'api') {
    const start = Date.now();
    try {
      const client = new FreeeApiClient();

      // Pre-flight state check
      const state = await client.detectState();
      const valid = isActionValidForState(actionType, state);
      if (!valid.ok) {
        console.log(chalk.yellow(`[API] Skipping ${actionType}: ${valid.reason}`));
        return { status: 'skipped', screenshotBefore: null, screenshotAfter: null, durationMs: Date.now() - start, error: valid.reason, detectedState: state };
      }

      const result = await client.executeClockAction(actionType);
      result.durationMs = Date.now() - start;
      console.log(chalk.green(`[API] ${ACTION_LABELS[actionType]} completed in ${result.durationMs}ms`));
      return result;
    } catch (error) {
      console.error(chalk.red(`[API] ${actionType} failed: ${error.message}`));
      return { status: 'failure', screenshotBefore: null, screenshotAfter: null, durationMs: Date.now() - start, error: error.message };
    }
  }

  // Browser mode — Playwright with mutex
  await acquireLock();
  const start = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bot = new FreeeBot();

  try {
    await bot.init();
    await bot.login();

    // Pre-flight state check
    const state = await bot.detectState();
    const valid = isActionValidForState(actionType, state);
    if (!valid.ok) {
      console.log(chalk.yellow(`[Bot] Skipping ${actionType}: ${valid.reason}`));
      return { status: 'skipped', screenshotBefore: null, screenshotAfter: null, durationMs: Date.now() - start, error: valid.reason, detectedState: state };
    }

    const result = await bot.clickAction(actionType, ts);
    console.log(chalk.green(`[Bot] ${ACTION_LABELS[actionType]} completed`));
    return { status: 'success', ...result, durationMs: Date.now() - start, error: null, detectedState: state };
  } catch (error) {
    console.error(chalk.red(`[Bot] ${actionType} failed: ${error.message}`));
    let screenshotAfter = null;
    try {
      if (bot.page) {
        screenshotAfter = path.join(SCREENSHOTS_DIR, `error-${actionType}-${ts}.png`);
        await bot.page.screenshot({ path: screenshotAfter });
      }
    } catch {}
    return { status: 'failure', screenshotBefore: null, screenshotAfter, durationMs: Date.now() - start, error: error.message };
  } finally {
    await bot.cleanup();
    releaseLock();
  }
}

/** Check if an action is valid for the current state */
function isActionValidForState(actionType, state) {
  const rules = {
    checkin: { valid: [FREEE_STATE.NOT_CHECKED_IN] },
    checkout: { valid: [FREEE_STATE.WORKING] },
    break_start: { valid: [FREEE_STATE.WORKING] },
    break_end: { valid: [FREEE_STATE.ON_BREAK] },
  };

  const rule = rules[actionType];
  if (!rule) return { ok: false, reason: `Unknown action: ${actionType}` };
  if (rule.valid.includes(state)) return { ok: true };

  const reasons = {
    checkin: { [FREEE_STATE.WORKING]: 'Already checked in', [FREEE_STATE.ON_BREAK]: 'Already on break', [FREEE_STATE.CHECKED_OUT]: 'Already checked out' },
    checkout: { [FREEE_STATE.NOT_CHECKED_IN]: 'Not checked in', [FREEE_STATE.ON_BREAK]: 'On break - end break first', [FREEE_STATE.CHECKED_OUT]: 'Already checked out' },
    break_start: { [FREEE_STATE.NOT_CHECKED_IN]: 'Not checked in', [FREEE_STATE.ON_BREAK]: 'Already on break', [FREEE_STATE.CHECKED_OUT]: 'Already checked out' },
    break_end: { [FREEE_STATE.NOT_CHECKED_IN]: 'Not checked in', [FREEE_STATE.WORKING]: 'Not on break', [FREEE_STATE.CHECKED_OUT]: 'Already checked out' },
  };

  return { ok: false, reason: reasons[actionType]?.[state] || `Invalid state ${state} for ${actionType}` };
}

/**
 * Submit work time corrections via freee Web (Playwright).
 * Used as Strategy 4 fallback when all API strategies fail.
 *
 * @param {Array} entries — [{ date, clock_in_at, clock_out_at, break_records? }]
 * @param {string} [reason] — 申請理由
 * @returns {Array<{ date, success, error?, method }>}
 */
export async function submitWebCorrections(entries, reason) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    return entries.map(e => ({
      date: e.date,
      success: false,
      error: 'web_credentials_required',
      method: 'web_correction',
    }));
  }

  await acquireLock();
  const bot = new FreeeBot();
  const results = [];

  try {
    await bot.init();

    // Attempt login — catch credential-specific failures
    try {
      await bot.login();
    } catch (loginErr) {
      if (loginErr.code === 'WEB_LOGIN_FAILED' || loginErr.code === 'WEB_CREDENTIALS_NOT_CONFIGURED') {
        // Return a distinguishable error code for all entries
        console.error(chalk.red(`[Bot] Login failed (${loginErr.code}): ${loginErr.message}`));
        await bot.cleanup();
        releaseLock();
        return entries.map(e => ({
          date: e.date,
          success: false,
          error: 'web_credentials_invalid',
          method: 'web_correction',
        }));
      }
      throw loginErr;  // Re-throw non-credential errors
    }

    for (const entry of entries) {
      try {
        // Parse times from ISO 8601 strings (e.g. "2026-02-03T10:00:00+09:00")
        const parseTime = (isoStr) => {
          if (!isoStr) return null;
          const match = isoStr.match(/T(\d{2}):(\d{2})/);
          return match ? { hour: parseInt(match[1], 10), min: parseInt(match[2], 10) } : null;
        };

        const clockIn = parseTime(entry.clock_in_at);
        const clockOut = parseTime(entry.clock_out_at);

        if (!clockIn || !clockOut) {
          results.push({ date: entry.date, success: false, error: 'Missing clock_in or clock_out time', method: 'web_correction' });
          continue;
        }

        const times = {
          clockInHour: clockIn.hour,
          clockInMin: clockIn.min,
          clockOutHour: clockOut.hour,
          clockOutMin: clockOut.min,
        };

        // Add break times if present
        if (entry.break_records && entry.break_records.length > 0) {
          const br = entry.break_records[0];
          const bStart = parseTime(br.clock_in_at);
          const bEnd = parseTime(br.clock_out_at);
          if (bStart && bEnd) {
            times.breakStartHour = bStart.hour;
            times.breakStartMin = bStart.min;
            times.breakEndHour = bEnd.hour;
            times.breakEndMin = bEnd.min;
          }
        }

        const result = await bot.submitWorkTimeCorrection(entry.date, times, reason || '打刻漏れのため修正');
        results.push({
          date: entry.date,
          success: result.success,
          error: result.error || null,
          method: 'web_correction',
        });

        // Short delay between submissions to avoid being rate-limited
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error(chalk.red(`[Bot] Web correction failed for ${entry.date}: ${err.message}`));
        results.push({
          date: entry.date,
          success: false,
          error: err.message,
          method: 'web_correction',
        });
      }
    }
  } catch (err) {
    console.error(chalk.red(`[Bot] Web correction session failed: ${err.message}`));
    // Return failures for any remaining entries
    for (const entry of entries) {
      if (!results.find(r => r.date === entry.date)) {
        results.push({ date: entry.date, success: false, error: err.message, method: 'web_correction' });
      }
    }
  } finally {
    await bot.cleanup();
    releaseLock();
  }

  return results;
}

/** Check if freee Web credentials are configured */
export function hasWebCredentials() {
  const creds = getCredentials();
  return !!(creds.username && creds.password);
}

/**
 * Scrape employee profile info from freee Web.
 * @param {string|number} employeeId
 * @returns {object} Employee info
 */
export async function scrapeEmployeeProfile(employeeId) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    throw new Error('freee Web credentials not configured');
  }

  await acquireLock();
  const bot = new FreeeBot();
  try {
    await bot.init();
    await bot.login();
    return await bot.scrapeEmployeeInfo(employeeId);
  } finally {
    await bot.cleanup();
    releaseLock();
  }
}

/**
 * Submit a leave request via freee Web (Playwright).
 * @param {string} type — 'PaidHoliday' | 'SpecialHoliday' | 'Absence' | 'HolidayWork'
 * @param {string} date — YYYY-MM-DD
 * @param {object} options — { reason?: string }
 * @returns {{ success: boolean, error?: string }}
 */
export async function submitLeaveRequest(type, date, options = {}) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    throw new Error('freee Web credentials not configured');
  }

  await acquireLock();
  const bot = new FreeeBot();
  try {
    await bot.init();
    await bot.login();
    return await bot.submitLeaveRequest(type, date, options);
  } finally {
    await bot.cleanup();
    releaseLock();
  }
}

/**
 * Determine which actions should be scheduled today based on current state and time
 */
export function determineActionsForToday(currentState, schedule) {
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes();
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  const result = { skip: [], execute: [], immediateActions: [], reason: '' };

  switch (currentState) {
    case FREEE_STATE.NOT_CHECKED_IN: {
      const ct = schedule.checkin;
      if (ct && curMin <= toMin(ct) + 5) {
        result.execute = ['checkin', 'break_start', 'break_end', 'checkout'];
        result.reason = 'Within checkin window, full day scheduled';
      } else {
        result.skip = ['checkin', 'break_start', 'break_end', 'checkout'];
        result.reason = 'Checkin window passed - skipping today to avoid late record';
      }
      break;
    }
    case FREEE_STATE.WORKING: {
      result.skip.push('checkin');
      const bst = schedule.break_start;
      if (bst && curMin > toMin(bst) + 5) {
        result.skip.push('break_start', 'break_end');
        result.reason = 'Lunch time passed, only checkout scheduled';
      } else {
        result.execute.push('break_start', 'break_end');
      }
      result.execute.push('checkout');
      if (!result.reason) result.reason = 'Checked in, scheduling remaining actions';
      break;
    }
    case FREEE_STATE.ON_BREAK: {
      result.skip.push('checkin', 'break_start');
      const bst = schedule.break_start;
      if (bst && curMin - toMin(bst) > 60) {
        result.immediateActions.push('break_end');
        result.reason = 'Break > 60min! Ending immediately + checkout';
      } else {
        result.execute.push('break_end');
        result.reason = 'On break, scheduling break end + checkout';
      }
      result.execute.push('checkout');
      break;
    }
    case FREEE_STATE.CHECKED_OUT: {
      result.skip = ['checkin', 'break_start', 'break_end', 'checkout'];
      result.reason = 'Already checked out, nothing to do today';
      break;
    }
    default: {
      result.skip = ['checkin', 'break_start', 'break_end', 'checkout'];
      result.reason = `Unknown state (${currentState}), skipping all for safety`;
    }
  }

  return result;
}
