import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FREEE_STATE, FREEE_ERROR_MESSAGES } from "../constants.js";

// Re-export for convenience
export { FREEE_STATE, FREEE_ERROR_MESSAGES };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOTS_DIR =
  process.env.SCREENSHOTS_DIR ||
  path.resolve(__dirname, "..", "..", "screenshots");

// Ensure screenshots directory
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

export const ACTION_SELECTORS = {
  checkin: '[data-testid="出勤"]',
  checkout: '[data-testid="退勤"]',
  break_start: '[data-testid="休憩開始"]',
  break_end: '[data-testid="休憩終了"]',
};

export const ACTION_LABELS = {
  checkin: "Check-in (出勤)",
  checkout: "Check-out (退勤)",
  break_start: "Break Start (休憩開始)",
  break_end: "Break End (休憩終了)",
};

/** Approval request type map — short name → freee SPA type string */
export const APPROVAL_TYPE_MAP = {
  PaidHoliday: "ApprovalRequest::PaidHoliday",
  SpecialHoliday: "ApprovalRequest::SpecialHoliday",
  Absence: "ApprovalRequest::Absence",
  HolidayWork: "ApprovalRequest::HolidayWork",
  OvertimeWork: "ApprovalRequest::OvertimeWork",
  WorkTime: "ApprovalRequest::WorkTime",
  MonthlyAttendance: "ApprovalRequest::MonthlyAttendance",
};

// Mutex to prevent concurrent Playwright executions
let isRunning = false;
const runQueue = [];

export function acquireLock() {
  return new Promise((resolve) => {
    if (!isRunning) {
      isRunning = true;
      resolve();
    } else {
      runQueue.push(resolve);
    }
  });
}

export function releaseLock() {
  if (runQueue.length > 0) {
    runQueue.shift()();
  } else {
    isRunning = false;
  }
}
