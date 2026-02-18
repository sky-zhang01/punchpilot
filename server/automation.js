import { chromium } from 'playwright';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSetting } from './db.js';
import { decrypt } from './crypto.js';
import { FreeeApiClient } from './freee-api.js';
import { FREEE_STATE } from './constants.js';
import { nowInTz } from './timezone.js';

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
    // freee uses #approval-request-date-input for the date field (role="combobox" text input).
    // Try both selectors for forward-compatibility in case freee changes the ID again.
    const dateInput = this.page.locator('#approval-request-date-input, #approval-request-fields-date').first();
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

  /**
   * Withdraw (取下げ) an approval request via freee Web.
   * Navigates to the request detail page and clicks the withdraw button.
   *
   * @param {string} type — freee type e.g. 'PaidHoliday', 'WorkTime', 'OvertimeWork'
   * @param {string|number} requestId — freee approval request ID
   * @returns {{ success: boolean, error?: string }}
   */
  async withdrawApprovalRequest(type, requestId) {
    // Map type to freee URL type format
    const typeMap = {
      PaidHoliday: 'ApprovalRequest::PaidHoliday',
      SpecialHoliday: 'ApprovalRequest::SpecialHoliday',
      Absence: 'ApprovalRequest::Absence',
      HolidayWork: 'ApprovalRequest::HolidayWork',
      OvertimeWork: 'ApprovalRequest::OvertimeWork',
      WorkTime: 'ApprovalRequest::WorkTime',
      MonthlyAttendance: 'ApprovalRequest::MonthlyAttendance',
    };

    const freeeType = typeMap[type] || `ApprovalRequest::${type}`;
    // freee SPA URL format: #requests/{id}?type=ApprovalRequest::Type
    const detailUrl = `https://p.secure.freee.co.jp/approval_requests#requests/${requestId}?type=${encodeURIComponent(freeeType)}`;
    console.log(chalk.blue(`[Bot] Navigating to approval request detail: ${detailUrl}`));

    // Navigate to the approval requests base first (SPA needs to load)
    const currentUrl = this.page.url();
    const baseUrl = 'https://p.secure.freee.co.jp/approval_requests';
    if (!currentUrl.startsWith(baseUrl)) {
      await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.page.waitForTimeout(3000);
    }
    // Navigate to detail via hash change
    await this.page.evaluate((url) => { window.location.href = url; }, detailUrl);
    await this.page.waitForTimeout(4000);

    // Wait for the detail page to load — look for the withdraw button or request info
    let pageLoaded = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const bodyText = await this.page.evaluate(() => document.body.innerText.substring(0, 3000)).catch(() => '');
      // Check if the request detail is shown
      if (bodyText.includes('取り下げ') || bodyText.includes('取下げ') || bodyText.includes('申請中') || bodyText.includes('承認待ち')) {
        pageLoaded = true;
        break;
      }
      const waitMs = 2000 + attempt * 1500;
      console.log(chalk.yellow(`[Bot] Request detail not loaded yet, waiting ${waitMs}ms (attempt ${attempt + 1}/5)...`));
      await this.page.waitForTimeout(waitMs);
      if (attempt === 2) {
        await this.page.evaluate((url) => { window.location.hash = url.split('#')[1]; }, detailUrl);
        await this.page.waitForTimeout(2000);
      }
    }

    if (!pageLoaded) {
      const debugPath = path.join(SCREENSHOTS_DIR, `withdraw-debug-${type}-${requestId}-${Date.now()}.png`);
      await this.page.screenshot({ path: debugPath }).catch(() => {});
      const bodySnippet = await this.page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
      throw new Error(`Request detail page did not load. Page: ${bodySnippet.substring(0, 200)}`);
    }

    // Screenshot before withdraw
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const beforePath = path.join(SCREENSHOTS_DIR, `withdraw-${type}-${requestId}-before-${ts}.png`);
    await this.page.screenshot({ path: beforePath });

    // Find and click the 取下げ button
    // freee may render it as "取り下げ" or "取下げ" depending on the page version
    let withdrawBtn = this.page.locator('button').filter({ hasText: '取り下げ' });
    if ((await withdrawBtn.count()) === 0) {
      withdrawBtn = this.page.locator('button').filter({ hasText: '取下げ' });
    }
    if ((await withdrawBtn.count()) === 0) {
      // Try broader search — might be a link or anchor
      withdrawBtn = this.page.locator('a, button').filter({ hasText: /取り?下げ/ });
    }

    if ((await withdrawBtn.count()) === 0) {
      const bodyText = await this.page.evaluate(() => document.body.innerText.substring(0, 2000)).catch(() => '');
      console.log(chalk.red(`[Bot] Withdraw button not found. Page text: ${bodyText.substring(0, 300)}`));
      return { success: false, error: 'Withdraw button (取下げ) not found on page', screenshotBefore: beforePath };
    }

    console.log(chalk.blue(`[Bot] Clicking withdraw button...`));
    await withdrawBtn.first().click();
    await this.page.waitForTimeout(2000);

    // Handle confirmation dialog (freee shows a confirmation modal/dialog)
    const confirmBtn = this.page.locator('button').filter({ hasText: /^(OK|はい|確認|取り下げ(する|る)?|取下げ)$/ });
    if ((await confirmBtn.count()) > 0) {
      console.log(chalk.blue(`[Bot] Clicking confirm button in dialog...`));
      await confirmBtn.first().click();
      await this.page.waitForTimeout(3000);
    }

    // Screenshot after withdraw
    const afterPath = path.join(SCREENSHOTS_DIR, `withdraw-${type}-${requestId}-after-${ts}.png`);
    await this.page.screenshot({ path: afterPath });

    // Check for success
    const postText = await this.page.evaluate(() => document.body.innerText.substring(0, 2000)).catch(() => '');
    if (postText.includes('エラー') || postText.includes('取り下げできません') || postText.includes('削除できない')) {
      const errorDetail = postText.match(/(エラー.{0,100}|取り下げできません.{0,80}|削除できない.{0,80})/)?.[0] || 'Unknown withdrawal error';
      console.log(chalk.red(`[Bot] Withdrawal failed: ${errorDetail}`));
      return { success: false, error: errorDetail, screenshotBefore: beforePath, screenshotAfter: afterPath };
    }

    console.log(chalk.green(`[Bot] Approval request ${type}-${requestId} withdrawn successfully`));
    return { success: true, screenshotBefore: beforePath, screenshotAfter: afterPath };
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
 * Withdraw an approval request via freee Web (Playwright).
 * Used as fallback when API withdrawal fails (e.g., companies with
 * dept/position-based approval routing that the API cannot handle).
 *
 * @param {string} type — 'PaidHoliday' | 'WorkTime' | 'OvertimeWork' etc.
 * @param {string|number} requestId — freee approval request ID
 * @returns {{ success: boolean, error?: string }}
 */
export async function withdrawApprovalRequestWeb(type, requestId) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    return { success: false, error: 'web_credentials_required' };
  }

  await acquireLock();
  const bot = new FreeeBot();
  try {
    await bot.init();

    try {
      await bot.login();
    } catch (loginErr) {
      if (loginErr.code === 'WEB_LOGIN_FAILED' || loginErr.code === 'WEB_CREDENTIALS_NOT_CONFIGURED') {
        return { success: false, error: 'web_credentials_invalid' };
      }
      throw loginErr;
    }

    return await bot.withdrawApprovalRequest(type, requestId);
  } catch (err) {
    console.error(chalk.red(`[Bot] Web withdrawal failed for ${type}-${requestId}: ${err.message}`));
    return { success: false, error: err.message };
  } finally {
    await bot.cleanup();
    releaseLock();
  }
}

/**
 * Determine which actions should be scheduled today based on current state, schedule,
 * and actual punch records. Uses independent action evaluation instead of rigid state machine.
 *
 * Break necessity is based on Japanese Labor Standards Act Article 34 (労働基準法 第34条):
 *   - ≤6h work: no mandatory break
 *   - >6h work: break required (≥45min for ≤8h, ≥60min for >8h)
 * Threshold: expectedWorkMinutes >= 361 (6h1m) triggers break_start/break_end.
 *
 * freee's 雇用区分休憩 (auto break deduction) is a per-company optional setting,
 * NOT enabled by default, so PunchPilot must handle break punching independently.
 *
 * @param {string} currentState - 'not_checked_in'|'working'|'on_break'|'checked_out'|'unknown'
 * @param {Object} schedule - { checkin: 'HH:MM', break_start: 'HH:MM', break_end: 'HH:MM', checkout: 'HH:MM' }
 * @param {Array} todayPunchTimes - [{ type: 'checkin'|'checkout'|'break_start'|'break_end', time: 'HH:MM' }]
 * @param {string|null} currentTime - 'HH:MM' for testing (null = use real time via nowInTz)
 * @returns {{ execute: string[], skip: string[], immediateActions: string[], reason: string }}
 */
export function determineActionsForToday(currentState, schedule, todayPunchTimes = [], currentTime = null) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  // Use injected time for tests, or timezone-aware current time
  let curMin;
  if (currentTime) {
    curMin = toMin(currentTime);
  } else {
    const { hours, minutes } = nowInTz();
    curMin = hours * 60 + minutes;
  }

  const result = { skip: [], execute: [], immediateActions: [], reason: '' };
  const allActions = ['checkin', 'break_start', 'break_end', 'checkout'];

  // --- Early return: unknown state → skip everything for safety ---
  if (currentState === FREEE_STATE.UNKNOWN) {
    result.skip = [...allActions];
    result.reason = `Unknown state (${currentState}), skipping all for safety`;
    return result;
  }

  // --- Step 1: Derive data from punch records ---

  // Actions already completed today (from freee time_clocks)
  const completedActions = new Set(todayPunchTimes.map(p => p.type));

  // For re-checkin scenarios (checkout then checkin again), the effective state is
  // what matters — not historical completedActions. If currentState is 'working' but
  // checkout exists in records, the user has re-checked-in and checkout is no longer active.
  const isEffectivelyCheckedOut = currentState === FREEE_STATE.CHECKED_OUT;

  // Effective checkin time: last checkin record (supports re-checkin scenarios), or scheduled time
  const checkinRecords = todayPunchTimes.filter(p => p.type === 'checkin');
  const lastCheckinRecord = checkinRecords.length > 0 ? checkinRecords[checkinRecords.length - 1] : null;
  const effectiveCheckinTime = lastCheckinRecord
    ? toMin(lastCheckinRecord.time)
    : (schedule.checkin ? toMin(schedule.checkin) : null);

  // Is this person effectively checked in? (either completed a checkin, or about to be checked in)
  const hasCheckedIn = completedActions.has('checkin');

  // Expected work duration = scheduled checkout - effective checkin
  const checkoutMin = schedule.checkout ? toMin(schedule.checkout) : null;
  const expectedWorkMinutes = (effectiveCheckinTime != null && checkoutMin != null)
    ? checkoutMin - effectiveCheckinTime
    : null;

  // Break needed if expected work >= 361 minutes (>6h, per Japanese Labor Standards Act Art. 34)
  const BREAK_THRESHOLD_MINUTES = 361;
  const breakNeeded = expectedWorkMinutes != null && expectedWorkMinutes >= BREAK_THRESHOLD_MINUTES;

  // --- Step 2: Independently evaluate each action ---

  // CHECKIN
  if (hasCheckedIn && currentState !== FREEE_STATE.NOT_CHECKED_IN) {
    // Already checked in (and state confirms it) → skip
    result.skip.push('checkin');
  } else if (currentState !== FREEE_STATE.NOT_CHECKED_IN) {
    // State is working/on_break/checked_out → no need to check in
    result.skip.push('checkin');
  } else if (schedule.checkin && curMin > toMin(schedule.checkin) + 5) {
    // Checkin window passed (>5min late) → skip to avoid late attendance record
    result.skip.push('checkin');
  } else {
    result.execute.push('checkin');
  }

  // Will checkin happen today? (either scheduled to execute, or already completed)
  const willBeCheckedIn = result.execute.includes('checkin') || hasCheckedIn;

  // BREAK_START
  if (completedActions.has('break_start')) {
    result.skip.push('break_start');
  } else if (isEffectivelyCheckedOut) {
    result.skip.push('break_start');
  } else if (!willBeCheckedIn) {
    // No checkin today → no break needed
    result.skip.push('break_start');
  } else if (!breakNeeded) {
    // Work duration < 6h1m → break not required by labor law
    result.skip.push('break_start');
  } else {
    result.execute.push('break_start');
  }

  // BREAK_END
  if (completedActions.has('break_end')) {
    result.skip.push('break_end');
  } else if (isEffectivelyCheckedOut) {
    result.skip.push('break_end');
  } else if (!result.execute.includes('break_start') && !completedActions.has('break_start')) {
    // No break_start planned or completed → no break_end needed
    result.skip.push('break_end');
  } else if (currentState === FREEE_STATE.ON_BREAK) {
    // Currently on break — check if overdue (>60min from actual break_start)
    const breakStartRecord = todayPunchTimes.filter(p => p.type === 'break_start').pop();
    const actualBreakStartMin = breakStartRecord ? toMin(breakStartRecord.time) : null;
    if (actualBreakStartMin != null && curMin - actualBreakStartMin > 60) {
      // Break exceeded 60 minutes → end immediately
      result.immediateActions.push('break_end');
    } else {
      result.execute.push('break_end');
    }
  } else {
    result.execute.push('break_end');
  }

  // CHECKOUT
  if (isEffectivelyCheckedOut) {
    result.skip.push('checkout');
  } else if (!willBeCheckedIn) {
    // No checkin today → no checkout needed
    result.skip.push('checkout');
  } else {
    result.execute.push('checkout');
  }

  // --- Step 3: Generate reason ---
  const reasons = [];
  if (result.execute.length === 0 && result.immediateActions.length === 0) {
    if (currentState === FREEE_STATE.CHECKED_OUT) {
      reasons.push('Already checked out, nothing to do today');
    } else if (currentState === FREEE_STATE.UNKNOWN) {
      reasons.push(`Unknown state (${currentState}), skipping all for safety`);
    } else if (result.skip.includes('checkin') && !completedActions.has('checkin')) {
      reasons.push('Checkin window passed - skipping today to avoid late record');
    } else {
      reasons.push('All actions completed or skipped');
    }
  } else {
    if (completedActions.size > 0) {
      reasons.push(`Completed: [${[...completedActions].join(', ')}]`);
    }
    if (result.execute.length > 0) {
      reasons.push(`Scheduling: [${result.execute.join(', ')}]`);
    }
    if (result.immediateActions.length > 0) {
      reasons.push(`Immediate: [${result.immediateActions.join(', ')}]`);
    }
    if (!breakNeeded && expectedWorkMinutes != null) {
      reasons.push(`Break skipped (expected work ${expectedWorkMinutes}min < ${BREAK_THRESHOLD_MINUTES}min threshold)`);
    }
  }
  result.reason = reasons.join('. ');

  return result;
}
