import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireLock,
  ensureScreenshotsDir,
  isGeneratedScreenshotFilename,
  releaseLock,
  safeScreenshotPath,
  shouldCaptureScreenshot,
  waitForAutomationIdle,
} from '../server/automation/constants.js';
import {
  AutomationRuntime,
  MAX_AUTOMATION_OPERATION_TIMEOUT_MS,
  chromiumProcessEnv,
  parseChromiumSandbox,
  parseAutomationOperationTimeout,
  withDeadline,
} from '../server/automation/runtime.js';

function createFakeBrowser() {
  const contexts = [];
  const listeners = new Map();
  const browser = {
    close: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async (options) => {
      const context = {
        close: vi.fn(async () => {}),
        route: vi.fn(async () => {}),
        storageState: vi.fn(async () => ({ cookies: [{ name: 'session' }], origins: [] })),
      };
      contexts.push({ context, options });
      return context;
    }),
    on: vi.fn((event, listener) => listeners.set(event, listener)),
  };
  return {
    browser,
    contexts,
    emit(event) {
      listeners.get(event)?.();
    },
  };
}

afterEach(() => {
  releaseLock();
  vi.restoreAllMocks();
});

describe('automation mutex', () => {
  it('bounds queued callers without allowing concurrent work', async () => {
    await acquireLock();

    await expect(acquireLock(10)).rejects.toMatchObject({
      code: 'AUTOMATION_QUEUE_TIMEOUT',
    });

    releaseLock();
    await expect(acquireLock(50)).resolves.toBeUndefined();
  });

  it('lets shutdown wait for the active automation mutation to release its lock', async () => {
    await acquireLock();
    const idle = waitForAutomationIdle(100);

    releaseLock();

    await expect(idle).resolves.toBe(true);
  });

  it('reports an expired drain without stealing the active lock', async () => {
    await acquireLock();

    await expect(waitForAutomationIdle(10)).resolves.toBe(false);
    releaseLock();
    await expect(waitForAutomationIdle(10)).resolves.toBe(true);
  });
});

describe('AutomationRuntime', () => {
  it('rejects operation deadlines outside the measured security bound', () => {
    expect(parseAutomationOperationTimeout()).toBe(
      MAX_AUTOMATION_OPERATION_TIMEOUT_MS,
    );
    expect(parseAutomationOperationTimeout('120000')).toBe(120_000);
    for (const value of ['0', '120s', '480001', '-1']) {
      expect(() => parseAutomationOperationTimeout(value)).toThrow(
        /must be an integer between 1 and 480000/,
      );
    }
  });

  it('reuses one browser process and restores only in-memory session state', async () => {
    const { browser, contexts } = createFakeBrowser();
    const launch = vi.fn(async () => browser);
    const runtime = new AutomationRuntime({
      launch,
      idleTimeoutMs: 60_000,
      sessionTtlMs: 60_000,
    });

    const first = await runtime.openContext();
    expect(contexts[0].context.route).toHaveBeenCalledOnce();
    expect(contexts[0].context.route).toHaveBeenCalledWith(
      '**/*',
      expect.any(Function),
    );
    expect(contexts[0].options.storageState).toBeUndefined();
    expect(contexts[0].options.serviceWorkers).toBe('block');
    await runtime.rememberSession(first);
    await runtime.closeContext(first);

    const second = await runtime.openContext();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({
      headless: true,
      chromiumSandbox: false,
      timeout: 30_000,
      args: ['--disable-gpu', '--disable-software-rasterizer'],
      env: chromiumProcessEnv(),
    });
    expect(contexts[1].options.storageState).toEqual({
      cookies: [{ name: 'session' }],
      origins: [],
    });

    await runtime.closeContext(second);
    await runtime.close();
  });

  it('closes a context that cannot install the navigation guard', async () => {
    const guardError = Object.assign(new Error('synthetic guard failure'), {
      code: 'WEB_NAVIGATION_GUARD_UNAVAILABLE',
    });
    const context = {
      close: vi.fn(async () => {}),
      route: vi.fn(async () => { throw guardError; }),
    };
    const browser = {
      close: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
      on: vi.fn(),
    };
    const runtime = new AutomationRuntime({
      launch: vi.fn(async () => browser),
      closeTimeoutMs: 100,
    });

    await expect(runtime.openContext()).rejects.toBe(guardError);
    expect(context.close).toHaveBeenCalledOnce();
    expect(runtime.activeContexts.size).toBe(0);
    await runtime.close();
  });

  it('closes a context that resolves after its operation was aborted', async () => {
    const { browser } = createFakeBrowser();
    let releaseContext;
    const deferredContext = new Promise((resolve) => {
      releaseContext = resolve;
    });
    const context = {
      close: vi.fn(async () => {}),
      route: vi.fn(async () => {}),
    };
    browser.newContext.mockImplementation(async () => {
      await deferredContext;
      return context;
    });
    const runtime = new AutomationRuntime({
      launch: vi.fn(async () => browser),
      closeTimeoutMs: 100,
    });
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error('synthetic timeout'), {
      code: 'AUTOMATION_OPERATION_TIMEOUT',
    });

    const pendingContext = runtime.openContext({ signal: controller.signal });
    await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalledOnce());
    controller.abort(timeoutError);
    releaseContext();

    await expect(pendingContext).rejects.toBe(timeoutError);
    expect(context.close).toHaveBeenCalledOnce();
    expect(runtime.activeContexts.size).toBe(0);
    await runtime.close();
  });

  it('enables Chromium sandboxing only from an explicit valid setting', async () => {
    expect(parseChromiumSandbox()).toBe(false);
    expect(parseChromiumSandbox('true')).toBe(true);
    expect(parseChromiumSandbox('off')).toBe(false);
    expect(() => parseChromiumSandbox('sometimes')).toThrow(
      'CHROMIUM_SANDBOX must be true or false',
    );

    const { browser } = createFakeBrowser();
    const launch = vi.fn(async () => browser);
    const runtime = new AutomationRuntime({ launch, chromiumSandbox: true });
    await runtime.getBrowser();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      chromiumSandbox: true,
    }));
    await runtime.close();
  });

  it('passes only browser runtime variables to the Chromium child process', () => {
    expect(chromiumProcessEnv({
      APP_SECRET: 'synthetic-secret',
      HOME: '/tmp/synthetic-home',
      LANG: 'ja_JP.UTF-8',
      LOGIN_PASSWORD: 'synthetic-password',
      OAUTH_REFRESH_TOKEN: 'synthetic-token',
      PATH: '/usr/bin',
      TZ: 'Asia/Tokyo',
    })).toEqual({
      HOME: '/tmp/synthetic-home',
      LANG: 'ja_JP.UTF-8',
      PATH: '/usr/bin',
      TZ: 'Asia/Tokyo',
    });
  });

  it('can open a credential-verification context without cached auth', async () => {
    const { browser, contexts } = createFakeBrowser();
    const runtime = new AutomationRuntime({
      launch: vi.fn(async () => browser),
      idleTimeoutMs: 60_000,
      sessionTtlMs: 60_000,
    });

    const first = await runtime.openContext();
    await runtime.rememberSession(first);
    await runtime.closeContext(first);

    const verification = await runtime.openContext({ useStoredSession: false });
    expect(contexts[1].options.storageState).toBeUndefined();
    await runtime.closeContext(verification);
    await runtime.close();
  });

  it('does not let an old context restore a session after invalidation', async () => {
    const { browser, contexts } = createFakeBrowser();
    const runtime = new AutomationRuntime({
      launch: vi.fn(async () => browser),
      idleTimeoutMs: 60_000,
      sessionTtlMs: 60_000,
    });
    let resolveStorageState;
    const storageState = new Promise((resolve) => {
      resolveStorageState = resolve;
    });
    const first = await runtime.openContext();
    contexts[0].context.storageState.mockReturnValue(storageState);

    const pendingRemember = runtime.rememberSession(first);
    runtime.invalidateSession();
    resolveStorageState({
      cookies: [{ name: 'obsolete-session' }],
      origins: [],
    });

    await expect(pendingRemember).resolves.toBe(false);
    await runtime.closeContext(first);
    const second = await runtime.openContext();
    expect(contexts[1].options.storageState).toBeUndefined();
    await runtime.closeContext(second);
    await runtime.close();
  });

  it('does not relabel a context created from stale storage as the new session epoch', async () => {
    const { browser, contexts } = createFakeBrowser();
    let releaseContext;
    const deferredContext = new Promise((resolve) => {
      releaseContext = resolve;
    });
    browser.newContext
      .mockImplementationOnce(async (options) => {
        const context = {
          close: vi.fn(async () => {}),
          route: vi.fn(async () => {}),
          storageState: vi.fn(async () => ({
            cookies: [{ name: 'obsolete-session' }],
            origins: [],
          })),
        };
        contexts.push({ context, options });
        await deferredContext;
        return context;
      });
    const runtime = new AutomationRuntime({
      launch: vi.fn(async () => browser),
      idleTimeoutMs: 60_000,
      sessionTtlMs: 60_000,
    });

    const pendingContext = runtime.openContext();
    await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalledTimes(1));
    runtime.invalidateSession();
    releaseContext();
    const staleContext = await pendingContext;

    await expect(runtime.rememberSession(staleContext)).resolves.toBe(false);
    await runtime.closeContext(staleContext);
    await runtime.openContext();
    expect(contexts[1].options.storageState).toBeUndefined();
    await runtime.close();
  });

  it('ignores a stale disconnect event after launching a replacement browser', async () => {
    const first = createFakeBrowser();
    const second = createFakeBrowser();
    const launch = vi.fn()
      .mockResolvedValueOnce(first.browser)
      .mockResolvedValueOnce(second.browser);
    const runtime = new AutomationRuntime({
      launch,
      idleTimeoutMs: 60_000,
      sessionTtlMs: 60_000,
    });

    await expect(runtime.getBrowser()).resolves.toBe(first.browser);
    await runtime.closeBrowser();
    await expect(runtime.getBrowser()).resolves.toBe(second.browser);

    first.emit('disconnected');

    await expect(runtime.getBrowser()).resolves.toBe(second.browser);
    expect(launch).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it('launches a replacement after the current browser disconnects', async () => {
    const first = createFakeBrowser();
    const second = createFakeBrowser();
    const launch = vi.fn()
      .mockResolvedValueOnce(first.browser)
      .mockResolvedValueOnce(second.browser);
    const runtime = new AutomationRuntime({
      launch,
      idleTimeoutMs: 60_000,
      sessionTtlMs: 60_000,
    });

    await expect(runtime.getBrowser()).resolves.toBe(first.browser);
    first.emit('disconnected');

    await expect(runtime.getBrowser()).resolves.toBe(second.browser);
    expect(launch).toHaveBeenCalledTimes(2);
    await runtime.close();
  });
});

describe('automation deadlines and screenshots', () => {
  it('fails a hung operation with a stable error code', async () => {
    let observedSignal;
    await expect(
      withDeadline((signal) => {
        observedSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }, 10),
    ).rejects.toMatchObject({ code: 'AUTOMATION_OPERATION_TIMEOUT' });
    expect(observedSignal.aborted).toBe(true);
    expect(observedSignal.reason).toMatchObject({ code: 'AUTOMATION_OPERATION_TIMEOUT' });
  });

  it('waits for bounded browser cleanup instead of a hung operation promise', async () => {
    let releaseCleanup;
    let rejected = false;
    const cleanup = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    const pending = withDeadline(
      () => new Promise(() => {}),
      5,
      { onTimeout: () => cleanup, cleanupTimeoutMs: 100 },
    ).catch((error) => {
      rejected = true;
      throw error;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejected).toBe(false);
    releaseCleanup();
    await expect(pending).rejects.toMatchObject({
      code: 'AUTOMATION_OPERATION_TIMEOUT',
    });
  });

  it('poisons the runtime if neither a context nor its browser can close', async () => {
    const { browser } = createFakeBrowser();
    browser.close.mockImplementation(() => new Promise(() => {}));
    browser.newContext.mockImplementation(async () => ({
      close: vi.fn(() => new Promise(() => {})),
      route: vi.fn(async () => {}),
      storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    }));
    const runtime = new AutomationRuntime({
      launch: vi.fn(async () => browser),
      closeTimeoutMs: 5,
    });
    const context = await runtime.openContext();

    await expect(runtime.closeContext(context)).rejects.toMatchObject({
      code: 'AUTOMATION_RUNTIME_UNRECOVERABLE',
    });
    expect(runtime.isUnrecoverable()).toBe(true);
    await expect(runtime.getBrowser()).rejects.toMatchObject({
      code: 'AUTOMATION_RUNTIME_UNRECOVERABLE',
    });
  });

  it('keeps screenshots off by default and sanitizes opt-in filenames', () => {
    expect(shouldCaptureScreenshot('error', {})).toBe(false);
    expect(shouldCaptureScreenshot('routine', { BROWSER_SCREENSHOTS: 'errors' })).toBe(false);
    expect(shouldCaptureScreenshot('error', { BROWSER_SCREENSHOTS: 'errors' })).toBe(true);

    const screenshotIdentity = `log-v1:${'a'.repeat(64)}`;
    const screenshotPath = safeScreenshotPath(
      '../request/123',
      'after',
      0,
      screenshotIdentity,
    );
    expect(screenshotPath).not.toContain('..');
    expect(screenshotPath).toMatch(/request-123-after-1970-01-01T00-00-00-000\.png$/);
    expect(isGeneratedScreenshotFilename(path.basename(screenshotPath))).toBe(true);
    expect(isGeneratedScreenshotFilename('unrelated-old.png')).toBe(false);
    expect(path.dirname(screenshotPath)).toBe(
      path.join(path.dirname(path.dirname(screenshotPath)), screenshotIdentity),
    );
  });

  it('creates a private screenshot directory and rejects a symlink target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-screenshots-'));
    const privateDir = path.join(root, 'private');
    const targetDir = path.join(root, 'target');
    const linkedDir = path.join(root, 'linked');
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkedDir);

    expect(ensureScreenshotsDir(privateDir)).toBe(privateDir);
    expect(fs.statSync(privateDir).mode & 0o777).toBe(0o700);
    const identity = `log-v1:${'b'.repeat(64)}`;
    const identityDir = ensureScreenshotsDir(privateDir, identity);
    expect(identityDir).toBe(path.join(privateDir, identity));
    expect(fs.statSync(identityDir).mode & 0o777).toBe(0o700);
    expect(() => ensureScreenshotsDir(linkedDir)).toThrow(
      'Screenshot directory is not a trusted private directory',
    );

    fs.rmSync(root, { recursive: true, force: true });
  });
});
