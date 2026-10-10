import fs from "fs";
import { AUTOMATION_QUEUE_TIMEOUT_MS as DEFAULT_QUEUE_TIMEOUT_MS } from "../runtime-config.js";
import path from "path";
import { SCREENSHOTS_DIR } from "../paths.js";
import { FREEE_STATE, FREEE_ERROR_MESSAGES } from "../constants.js";

// Re-export for convenience
export { FREEE_STATE, FREEE_ERROR_MESSAGES };

export { SCREENSHOTS_DIR };

export function shouldCaptureScreenshot(kind = "routine", env = process.env) {
  const mode = String(env.BROWSER_SCREENSHOTS || "off").toLowerCase();
  return mode === "all" || (mode === "errors" && kind === "error");
}

const SCREENSHOT_IDENTITY_PATTERN = /^log-v1:[a-f0-9]{64}$/;
const GENERATED_SCREENSHOT_PATTERN =
  /^[A-Za-z0-9_-]{1,114}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.png$/;
const LEGACY_ISO_SCREENSHOT_PATTERN =
  /^(?:[A-Za-z0-9_-]{1,104}-(?:before|after)|error-(?:checkin|checkout|break_start|break_end))-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/;
const LEGACY_EPOCH_SCREENSHOT_PATTERN =
  /^(?:login-failed|verify|[A-Za-z0-9_-]{1,104}-debug)-\d{13}\.png$/;
const LEGACY_FORM_EPOCH_SCREENSHOT_PATTERN =
  /^(?:web-correction-debug-\d{4}-\d{2}-\d{2}|leave-debug-[A-Za-z][A-Za-z0-9_-]{0,63}-\d{4}-\d{2}-\d{2}|withdraw-debug-[A-Za-z][A-Za-z0-9_-]{0,63}-[1-9]\d{0,18}|monthly-closing-(?:debug|before|after)-\d{4}-(?:[1-9]|1[0-2]))-\d{13}\.png$/;
export const SCREENSHOT_ROOT_MARKER = ".punchpilot-screenshots-v1";
const SCREENSHOT_ROOT_MARKER_CONTENT = "PunchPilot screenshot root v1\n";

export function isScreenshotIdentityKey(identityKey) {
  return typeof identityKey === "string" &&
    SCREENSHOT_IDENTITY_PATTERN.test(identityKey);
}

export function isGeneratedScreenshotFilename(filename) {
  return typeof filename === "string" &&
    filename.length <= 160 &&
    GENERATED_SCREENSHOT_PATTERN.test(filename);
}

export function isRecognizedScreenshotFilename(filename) {
  return isGeneratedScreenshotFilename(filename) || (
    typeof filename === "string" &&
    filename.length <= 160 &&
    (
      LEGACY_ISO_SCREENSHOT_PATTERN.test(filename) ||
      LEGACY_EPOCH_SCREENSHOT_PATTERN.test(filename) ||
      LEGACY_FORM_EPOCH_SCREENSHOT_PATTERN.test(filename)
    )
  );
}

export function screenshotIdentityDirectory(
  identityKey,
  directory = SCREENSHOTS_DIR,
) {
  if (!isScreenshotIdentityKey(identityKey)) {
    const error = new Error("A valid screenshot identity is required");
    error.code = "SCREENSHOT_IDENTITY_INVALID";
    throw error;
  }
  const root = path.resolve(directory); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- Operator-selected diagnostics root is verified as a private owned directory before use.
  const identityDirectory = path.resolve(root, identityKey); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- identityKey must match the fixed log-v1 digest format and the canonical parent is checked below.
  if (path.dirname(identityDirectory) !== root) {
    throw new Error("Invalid screenshot identity path");
  }
  return identityDirectory;
}

export function safeScreenshotPath(
  prefix,
  stage,
  now = Date.now(),
  identityKey,
) {
  const safePrefix = String(prefix || "capture")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "capture";
  const safeStage = String(stage || "capture")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "capture";
  const timestamp = new Date(now)
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "");
  const identityDirectory = screenshotIdentityDirectory(identityKey);
  const output = path.resolve( // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- directory and filename components are independently allowlisted and the canonical parent is checked below.
    identityDirectory, // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- Produced only by screenshotIdentityDirectory after digest validation and canonical-parent enforcement.
    `${safePrefix}-${safeStage}-${timestamp}.png`,
  );
  if (path.dirname(output) !== identityDirectory) {
    throw new Error("Invalid screenshot path");
  }
  return output;
}

function unsafeScreenshotDirectory(message = "Screenshot directory is unsafe") {
  const error = new Error(message);
  error.code = "SCREENSHOT_DIRECTORY_UNSAFE";
  return error;
}

function assertOwnedScreenshotDirectory(
  directory,
  { create = false, allowReadPermissions = false } = {},
) {
  const root = path.resolve(directory); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- operator-controlled diagnostics root, followed by ownership and no-symlink checks.
  // The resolved path is accepted only after no-symlink, owner, and mode checks below.
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const metadata = fs.lstatSync(root);
  const currentUid = process.getuid?.();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (currentUid != null && metadata.uid !== currentUid) ||
    (metadata.mode & 0o022) !== 0 ||
    (!allowReadPermissions && (metadata.mode & 0o077) !== 0)
  ) {
    throw unsafeScreenshotDirectory(
      "Screenshot directory is not a trusted private directory",
    );
  }
  return root;
}

function tightenScreenshotDirectory(directory) {
  // The directory has already passed owner, type, and no-write-sharing checks.
  fs.chmodSync(directory, 0o700);
  return assertOwnedScreenshotDirectory(directory);
}

function assertGeneratedScreenshotFile(file, filename, allowLegacy = false) {
  // The caller derives file from a validated parent and a direct readdir entry.
  const metadata = fs.lstatSync(file);
  if (
    !(allowLegacy
      ? isRecognizedScreenshotFilename(filename)
      : isGeneratedScreenshotFilename(filename)) ||
    metadata.isSymbolicLink() ||
    !metadata.isFile()
  ) {
    throw unsafeScreenshotDirectory(
      "Unrecognized content prevents claiming the screenshot directory",
    );
  }
}

function assertClaimableScreenshotRoot(root) {
  const identityDirectories = [];
  // root has already passed private-directory verification.
  for (const name of fs.readdirSync(root)) {
    const entry = path.resolve(root, name); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name is a direct readdir entry and its canonical parent is checked below.
    if (path.dirname(entry) !== root) throw unsafeScreenshotDirectory();
    const metadata = fs.lstatSync(entry);
    if (
      !metadata.isSymbolicLink() &&
      metadata.isDirectory() &&
      isScreenshotIdentityKey(name)
    ) {
      assertOwnedScreenshotDirectory(entry, { allowReadPermissions: true });
      for (const childName of fs.readdirSync(entry)) {
        const child = path.resolve(entry, childName); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- childName is a direct readdir entry and its canonical parent is checked below.
        if (path.dirname(child) !== entry) throw unsafeScreenshotDirectory();
        assertGeneratedScreenshotFile(child, childName, true);
      }
      identityDirectories.push(entry);
      continue;
    }
    assertGeneratedScreenshotFile(entry, name, true);
  }
  for (const identityDirectory of identityDirectories) {
    tightenScreenshotDirectory(identityDirectory);
  }
  tightenScreenshotDirectory(root);
}

function assertScreenshotRootMarker(root) {
  const marker = path.resolve(root, SCREENSHOT_ROOT_MARKER); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- marker is a fixed filename and its canonical parent is checked below.
  if (path.dirname(marker) !== root) throw unsafeScreenshotDirectory();
  let descriptor = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    // The fixed child is opened without following a final symbolic link.
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | noFollow);
    const metadata = fs.fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (currentUid != null && metadata.uid !== currentUid) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw unsafeScreenshotDirectory("Screenshot directory marker is invalid");
    }
    // descriptor was opened with O_NOFOLLOW and validated with fstat above.
    if (fs.readFileSync(descriptor, "utf8") !== SCREENSHOT_ROOT_MARKER_CONTENT) {
      throw unsafeScreenshotDirectory("Screenshot directory marker is invalid");
    }
  } catch (error) {
    if (error?.code === "SCREENSHOT_DIRECTORY_UNSAFE") throw error;
    throw unsafeScreenshotDirectory("Screenshot directory marker is invalid");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function ensureClaimedScreenshotRoot(directory) {
  const root = assertOwnedScreenshotDirectory(directory, {
    create: true,
    allowReadPermissions: true,
  });
  const marker = path.resolve(root, SCREENSHOT_ROOT_MARKER); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- marker is a fixed filename under the validated root.
  if (fs.existsSync(marker)) {
    assertScreenshotRootMarker(root);
    return tightenScreenshotDirectory(root);
  }

  assertClaimableScreenshotRoot(root);
  try {
    // The fixed marker is created only after validating every existing root entry.
    fs.writeFileSync(marker, SCREENSHOT_ROOT_MARKER_CONTENT, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assertScreenshotRootMarker(root);
  return root;
}

export function ensureScreenshotsDir(
  directory = SCREENSHOTS_DIR,
  identityKey = null,
) {
  const root = ensureClaimedScreenshotRoot(directory);
  if (identityKey === null) return root;
  return tightenScreenshotDirectory(assertOwnedScreenshotDirectory(
    screenshotIdentityDirectory(identityKey, root),
    { create: true, allowReadPermissions: true },
  ));
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
const idleWaiters = new Set();

function notifyAutomationIdle() {
  if (isRunning || runQueue.length > 0) return;
  for (const finish of idleWaiters) finish(true);
  idleWaiters.clear();
}

export function acquireLock(timeoutMs = DEFAULT_QUEUE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!isRunning) {
      isRunning = true;
      resolve();
    } else {
      const entry = { resolve, reject, timer: null };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const index = runQueue.indexOf(entry);
          if (index !== -1) runQueue.splice(index, 1);
          const error = new Error("Browser automation queue timed out");
          error.code = "AUTOMATION_QUEUE_TIMEOUT";
          reject(error);
        }, timeoutMs);
        entry.timer.unref?.();
      }
      runQueue.push(entry);
    }
  });
}

export function releaseLock() {
  if (runQueue.length > 0) {
    const next = runQueue.shift();
    if (next.timer) clearTimeout(next.timer);
    next.resolve();
  } else {
    isRunning = false;
    notifyAutomationIdle();
  }
}

export function waitForAutomationIdle(timeoutMs = 20_000) {
  if (!isRunning && runQueue.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (idle) => {
      if (timer) clearTimeout(timer);
      idleWaiters.delete(finish);
      resolve(idle);
    };
    idleWaiters.add(finish);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    }
  });
}
