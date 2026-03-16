import chalk from "chalk";
import path from "path";
import { FreeeApiClient } from "../freee-api.js";
import { FREEE_STATE } from "../constants.js";
import { ACTION_LABELS, SCREENSHOTS_DIR, acquireLock, releaseLock } from "./constants.js";
import { getCredentials, getConnectionMode, hasCredentials, isDebugMode, hasWebCredentials } from "./utils.js";
import { PunchBot } from "./punch-bot.js";
import {
  submitWorkTimeCorrection,
  scrapeEmployeeInfo,
  submitLeaveRequest as submitLeaveRequestForm,
  withdrawApprovalRequest,
  submitMonthlyClosingWeb,
} from "./forms.js";
import { mockDetectState, mockExecuteAction } from "./mock.js";
import { isActionValidForState } from "./scheduling.js";

// ─── Bot lifecycle wrapper ────────────────────────────────

/**
 * Wraps the acquireLock → PunchBot → init → login → actionFn → cleanup → releaseLock lifecycle.
 * Handles login error code propagation (WEB_LOGIN_FAILED, WEB_CREDENTIALS_NOT_CONFIGURED).
 *
 * @param {(bot: PunchBot) => Promise<T>} actionFn — receives an initialized, logged-in bot
 * @returns {Promise<T>}
 */
async function withPunchBot(actionFn) {
  await acquireLock();
  const bot = new PunchBot();
  try {
    await bot.init();
    try {
      await bot.login();
    } catch (loginErr) {
      if (
        loginErr.code === "WEB_LOGIN_FAILED" ||
        loginErr.code === "WEB_CREDENTIALS_NOT_CONFIGURED"
      ) {
        const err = new Error(`Web login failed: ${loginErr.message}`);
        err.code = loginErr.code;
        throw err;
      }
      throw loginErr;
    }
    return await actionFn(bot);
  } finally {
    await bot.cleanup();
    releaseLock();
  }
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
  if (getConnectionMode() === "api") {
    try {
      const client = new FreeeApiClient();
      return await client.detectState();
    } catch (e) {
      console.error(chalk.red(`[API] detectState failed: ${e.message}`));
      return FREEE_STATE.UNKNOWN;
    }
  }

  // Browser mode — Playwright with mutex
  try {
    return await withPunchBot((bot) => bot.detectState());
  } catch (e) {
    console.error(chalk.red(`[Bot] detectState failed: ${e.message}`));
    return FREEE_STATE.UNKNOWN;
  }
}

/** Execute a check-in/check-out action */
export async function executeAction(actionType) {
  if (isDebugMode()) return mockExecuteAction(actionType);

  if (!hasCredentials()) {
    return {
      status: "failure",
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 0,
      error: "freee credentials not configured. Go to Settings.",
    };
  }

  // API mode — no browser/mutex needed
  if (getConnectionMode() === "api") {
    const start = Date.now();
    try {
      const client = new FreeeApiClient();

      // Pre-flight state check
      const state = await client.detectState();
      const valid = isActionValidForState(actionType, state);
      if (!valid.ok) {
        console.log(
          chalk.yellow(`[API] Skipping ${actionType}: ${valid.reason}`),
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

      const result = await client.executeClockAction(actionType);
      result.durationMs = Date.now() - start;
      console.log(
        chalk.green(
          `[API] ${ACTION_LABELS[actionType]} completed in ${result.durationMs}ms`,
        ),
      );
      return result;
    } catch (error) {
      console.error(chalk.red(`[API] ${actionType} failed: ${error.message}`));
      return {
        status: "failure",
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: Date.now() - start,
        error: error.message,
      };
    }
  }

  // Browser mode — Playwright with mutex
  const start = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  try {
    return await withPunchBot(async (bot) => {
      // Pre-flight state check
      const state = await bot.detectState();
      const valid = isActionValidForState(actionType, state);
      if (!valid.ok) {
        console.log(
          chalk.yellow(`[Bot] Skipping ${actionType}: ${valid.reason}`),
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
        const result = await bot.clickAction(actionType, ts);
        console.log(
          chalk.green(`[Bot] ${ACTION_LABELS[actionType]} completed`),
        );
        return {
          status: "success",
          ...result,
          durationMs: Date.now() - start,
          error: null,
          detectedState: state,
        };
      } catch (clickError) {
        // Try to capture error screenshot while bot is still alive
        let screenshotAfter = null;
        try {
          if (bot.page) {
            screenshotAfter = path.join(
              SCREENSHOTS_DIR,
              `error-${actionType}-${ts}.png`,
            );
            await bot.page.screenshot({ path: screenshotAfter });
          }
        } catch {}
        return {
          status: "failure",
          screenshotBefore: null,
          screenshotAfter,
          durationMs: Date.now() - start,
          error: clickError.message,
        };
      }
    });
  } catch (error) {
    console.error(chalk.red(`[Bot] ${actionType} failed: ${error.message}`));
    return {
      status: "failure",
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: Date.now() - start,
      error: error.message,
    };
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
export async function submitWebCorrections(entries, reason) {
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

  try {
    await withPunchBot(async (bot) => {
      for (const entry of entries) {
        try {
          const parseTime = (isoStr) => {
            if (!isoStr) return null;
            const match = isoStr.match(/T(\d{2}):(\d{2})/);
            return match
              ? { hour: parseInt(match[1], 10), min: parseInt(match[2], 10) }
              : null;
          };

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

          const result = await submitWorkTimeCorrection(
            bot,
            entry.date,
            times,
            reason || "打刻漏れのため修正",
          );
          results.push({
            date: entry.date,
            success: result.success,
            error: result.error || null,
            method: "web_correction",
          });

          await new Promise((r) => setTimeout(r, 1000));
        } catch (err) {
          console.error(
            chalk.red(
              `[Bot] Web correction failed for ${entry.date}: ${err.message}`,
            ),
          );
          results.push({
            date: entry.date,
            success: false,
            error: err.message,
            method: "web_correction",
          });
        }
      }
    });
  } catch (err) {
    // Login failures or session-level errors
    const errorCode =
      err.code === "WEB_LOGIN_FAILED" ||
      err.code === "WEB_CREDENTIALS_NOT_CONFIGURED"
        ? "web_credentials_invalid"
        : err.message;
    if (errorCode === "web_credentials_invalid") {
      console.error(chalk.red(`[Bot] Login failed: ${err.message}`));
    } else {
      console.error(
        chalk.red(`[Bot] Web correction session failed: ${err.message}`),
      );
    }
    for (const entry of entries) {
      if (!results.find((r) => r.date === entry.date)) {
        results.push({
          date: entry.date,
          success: false,
          error: errorCode,
          method: "web_correction",
        });
      }
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

  return withPunchBot((bot) => scrapeEmployeeInfo(bot, employeeId));
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
    throw new Error("freee Web credentials not configured");
  }

  return withPunchBot((bot) => submitLeaveRequestForm(bot, type, date, options));
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
    return { success: false, error: "web_credentials_required" };
  }

  try {
    return await withPunchBot((bot) =>
      withdrawApprovalRequest(bot, type, requestId),
    );
  } catch (err) {
    if (
      err.code === "WEB_LOGIN_FAILED" ||
      err.code === "WEB_CREDENTIALS_NOT_CONFIGURED"
    ) {
      return { success: false, error: "web_credentials_invalid" };
    }
    console.error(
      chalk.red(
        `[Bot] Web withdrawal failed for ${type}-${requestId}: ${err.message}`,
      ),
    );
    return { success: false, error: err.message };
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
export async function submitMonthlyAttendanceClosingWeb(year, month) {
  const creds = getCredentials();
  if (!creds.username || !creds.password) {
    return { success: false, error: "web_credentials_required" };
  }

  try {
    return await withPunchBot((bot) =>
      submitMonthlyClosingWeb(bot, year, month),
    );
  } catch (err) {
    if (
      err.code === "WEB_LOGIN_FAILED" ||
      err.code === "WEB_CREDENTIALS_NOT_CONFIGURED"
    ) {
      return { success: false, error: "web_credentials_invalid" };
    }
    console.error(
      chalk.red(
        `[Bot] Monthly closing web submission failed for ${year}-${month}: ${err.message}`,
      ),
    );
    return { success: false, error: err.message };
  }
}
