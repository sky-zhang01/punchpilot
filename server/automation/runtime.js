import { chromium } from "playwright";
import { parseMilliseconds } from "../runtime-config.js";
import { installFreeeWebNavigationGuard } from "./web-login.js";

export function parseChromiumSandbox(value) {
  if (value == null || String(value).trim() === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("CHROMIUM_SANDBOX must be true or false");
}

const DEFAULT_IDLE_TIMEOUT_MS = parseMilliseconds(
  process.env.BROWSER_IDLE_TIMEOUT_MS,
  "BROWSER_IDLE_TIMEOUT_MS",
  5 * 60 * 1000,
);
const DEFAULT_SESSION_TTL_MS = parseMilliseconds(
  process.env.BROWSER_SESSION_TTL_MS,
  "BROWSER_SESSION_TTL_MS",
  8 * 60 * 60 * 1000,
);
const DEFAULT_CLOSE_TIMEOUT_MS = parseMilliseconds(
  process.env.BROWSER_CLOSE_TIMEOUT_MS,
  "BROWSER_CLOSE_TIMEOUT_MS",
  15_000,
);
export const MAX_AUTOMATION_OPERATION_TIMEOUT_MS = 8 * 60 * 1000;

export function parseAutomationOperationTimeout(value) {
  return parseMilliseconds(value, 'AUTOMATION_OPERATION_TIMEOUT_MS',
    MAX_AUTOMATION_OPERATION_TIMEOUT_MS, MAX_AUTOMATION_OPERATION_TIMEOUT_MS);
}

export const AUTOMATION_OPERATION_TIMEOUT_MS = parseAutomationOperationTimeout(
  process.env.AUTOMATION_OPERATION_TIMEOUT_MS,
);
const DEFAULT_CHROMIUM_SANDBOX = parseChromiumSandbox(
  process.env.CHROMIUM_SANDBOX,
);

export function chromiumProcessEnv(source = process.env) {
  const selected = {
    DBUS_SESSION_BUS_ADDRESS: source.DBUS_SESSION_BUS_ADDRESS,
    DISPLAY: source.DISPLAY,
    FONTCONFIG_PATH: source.FONTCONFIG_PATH,
    HOME: source.HOME,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    LC_CTYPE: source.LC_CTYPE,
    LD_LIBRARY_PATH: source.LD_LIBRARY_PATH,
    PATH: source.PATH,
    TEMP: source.TEMP,
    TMP: source.TMP,
    TMPDIR: source.TMPDIR,
    TZ: source.TZ,
    WAYLAND_DISPLAY: source.WAYLAND_DISPLAY,
    XAUTHORITY: source.XAUTHORITY,
    XDG_CACHE_HOME: source.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
    XDG_DATA_HOME: source.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR,
  };
  return Object.fromEntries(
    Object.entries(selected)
      .filter(([, value]) => typeof value === "string" && value !== ""),
  );
}

function completionWithin(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(promise).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: "fulfilled", value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ status: "rejected", error });
      },
    );
  });
}

function unrecoverableRuntimeError(cause = null) {
  const error = new Error("The browser runtime could not be terminated safely.");
  error.code = "AUTOMATION_RUNTIME_UNRECOVERABLE";
  if (cause) error.cause = cause;
  return error;
}

export class AutomationRuntime {
  constructor({
    launch = (options) => chromium.launch(options),
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    chromiumSandbox = DEFAULT_CHROMIUM_SANDBOX,
  } = {}) {
    this.launch = launch;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sessionTtlMs = sessionTtlMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.chromiumSandbox = chromiumSandbox === true;
    this.browserPromise = null;
    this.activeContexts = new Set();
    this.idleTimer = null;
    this.sessionState = null;
    this.sessionExpiresAt = 0;
    this.sessionEpoch = 0;
    this.contextSessionEpochs = new WeakMap();
    this.unrecoverable = null;
  }

  async getBrowser() {
    if (this.unrecoverable) throw this.unrecoverable;
    this.cancelIdleClose();
    if (!this.browserPromise) {
      let browserPromise;
      browserPromise = Promise.resolve()
        .then(() => this.launch({
          headless: true,
          chromiumSandbox: this.chromiumSandbox,
          timeout: 30_000,
          args: ["--disable-gpu", "--disable-software-rasterizer"],
          env: chromiumProcessEnv(),
        }))
        .then((browser) => {
          browser.on?.("disconnected", () => {
            if (this.browserPromise === browserPromise) {
              this.browserPromise = null;
            }
          });
          return browser;
        })
        .catch((error) => {
          if (this.browserPromise === browserPromise) {
            this.browserPromise = null;
          }
          throw error;
        });
      this.browserPromise = browserPromise;
    }
    return this.browserPromise;
  }

  validSessionState() {
    if (!this.sessionState || Date.now() >= this.sessionExpiresAt) {
      this.invalidateSession();
      return null;
    }
    return structuredClone(this.sessionState);
  }

  async openContext({ useStoredSession = true, signal = null } = {}) {
    signal?.throwIfAborted();
    const browser = await this.getBrowser();
    try {
      signal?.throwIfAborted();
    } catch (error) {
      this.scheduleIdleClose();
      throw error;
    }
    const options = { serviceWorkers: "block" };
    const storageState = useStoredSession ? this.validSessionState() : null;
    if (storageState) options.storageState = storageState;
    const contextSessionEpoch = this.sessionEpoch;

    let context;
    try {
      context = await browser.newContext(options);
    } catch (error) {
      this.scheduleIdleClose();
      throw error;
    }
    try {
      signal?.throwIfAborted();
      await installFreeeWebNavigationGuard(context);
      signal?.throwIfAborted();
    } catch (error) {
      const closed = await completionWithin(
        Promise.resolve().then(() => context.close()),
        this.closeTimeoutMs,
      );
      if (closed.status !== "fulfilled") {
        throw this.markUnrecoverable(closed.error || error);
      }
      this.scheduleIdleClose();
      throw error;
    }
    this.activeContexts.add(context);
    this.contextSessionEpochs.set(context, contextSessionEpoch);
    return context;
  }

  async rememberSession(context) {
    const contextEpoch = this.contextSessionEpochs.get(context);
    if (contextEpoch === undefined || !this.activeContexts.has(context)) {
      return false;
    }
    const state = await context.storageState();
    if (
      contextEpoch !== this.sessionEpoch ||
      !this.activeContexts.has(context)
    ) {
      return false;
    }
    this.sessionState = structuredClone(state);
    this.sessionExpiresAt = Date.now() + this.sessionTtlMs;
    return true;
  }

  invalidateSession() {
    this.sessionEpoch += 1;
    this.sessionState = null;
    this.sessionExpiresAt = 0;
  }

  async closeContext(context) {
    if (!context || !this.activeContexts.delete(context)) return true;
    this.contextSessionEpochs.delete(context);
    const contextClose = await completionWithin(
      Promise.resolve().then(() => context.close()),
      this.closeTimeoutMs,
    );
    if (contextClose.status === "fulfilled") {
      this.scheduleIdleClose();
      return true;
    }

    try {
      await this.closeBrowser();
      return true;
    } catch (error) {
      throw this.markUnrecoverable(contextClose.error || error);
    }
  }

  cancelIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleClose() {
    this.cancelIdleClose();
    if (this.activeContexts.size > 0 || !this.browserPromise) return;
    this.idleTimer = setTimeout(() => {
      this.closeBrowser().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async closeBrowser() {
    this.cancelIdleClose();
    const browserPromise = this.browserPromise;
    this.browserPromise = null;
    if (!browserPromise) return true;
    const launched = await completionWithin(browserPromise, this.closeTimeoutMs);
    if (launched.status === "rejected") return true;
    if (launched.status !== "fulfilled") {
      browserPromise.then((browser) => browser?.close?.()).catch(() => {});
      throw this.markUnrecoverable(launched.error);
    }
    const browser = launched.value;
    if (browser?.isConnected?.() === false) return true;
    const closed = await completionWithin(
      Promise.resolve().then(() => browser?.close?.()),
      this.closeTimeoutMs,
    );
    if (closed.status !== "fulfilled") {
      throw this.markUnrecoverable(closed.error);
    }
    return true;
  }

  markUnrecoverable(cause = null) {
    if (!this.unrecoverable) {
      this.unrecoverable = unrecoverableRuntimeError(cause);
      this.invalidateSession();
    }
    return this.unrecoverable;
  }

  isUnrecoverable() {
    return this.unrecoverable !== null;
  }

  getUnrecoverableError() {
    return this.unrecoverable;
  }

  async close() {
    this.invalidateSession();
    const contexts = [...this.activeContexts];
    const results = await Promise.allSettled(
      contexts.map((context) => this.closeContext(context)),
    );
    try {
      await this.closeBrowser();
    } catch (error) {
      results.push({ status: "rejected", reason: error });
    }
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw this.markUnrecoverable(failed.reason);
    if (this.unrecoverable) throw this.unrecoverable;
  }
}

export async function withDeadline(
  operation,
  timeoutMs = AUTOMATION_OPERATION_TIMEOUT_MS,
  { onTimeout = null, cleanupTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS * 3 } = {},
) {
  const controller = new AbortController();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation(controller.signal);

  let timer;
  let timeoutError = null;
  const timedOut = Symbol("timed-out");
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      const error = new Error("Browser automation operation timed out");
      error.code = "AUTOMATION_OPERATION_TIMEOUT";
      timeoutError = error;
      controller.abort(error);
      resolve(timedOut);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([operationPromise, timeout]);
    if (outcome !== timedOut) return outcome;

    operationPromise.catch(() => {});
    if (typeof onTimeout === "function") {
      const cleanup = await completionWithin(
        Promise.resolve().then(() => onTimeout(timeoutError)),
        cleanupTimeoutMs,
      );
      if (cleanup.status !== "fulfilled") {
        throw unrecoverableRuntimeError(cleanup.error || timeoutError);
      }
    }
    throw timeoutError;
  } finally {
    clearTimeout(timer);
  }
}

export const automationRuntime = new AutomationRuntime();
