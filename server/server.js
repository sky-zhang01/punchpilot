import './env.js';
import { parseMilliseconds } from './runtime-config.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from './app.js';
import { initDatabase } from './db.js';
import { scheduler } from './scheduler.js';
import { getTimezone, todayStringInTz, currentTimeInTz } from './timezone.js';
import logger, { safeErrorMetadata } from './logger.js';
import { automationRuntime } from './automation/runtime.js';
import {
  ensureScreenshotsDir,
  isRecognizedScreenshotFilename,
  isScreenshotIdentityKey,
  SCREENSHOTS_DIR,
  waitForAutomationIdle,
} from './automation/constants.js';
import { waitForAsyncTasksIdle } from './async-tasks.js';
import {
  beginAccountOperationShutdown,
  waitForAccountOperationsIdle,
} from './account-operation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

const log = logger.child('Server');
const PORT = process.env.PORT || 8681;
const SHUTDOWN_GRACE_MS = parseMilliseconds(process.env.SHUTDOWN_GRACE_MS, 'SHUTDOWN_GRACE_MS', 510_000);
const SHUTDOWN_FORCE_EXIT_BUFFER_MS = 15_000;
let httpServer = null;
let shutdownPromise = null;

function completionWithin(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value !== false);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

async function shutdown(signal, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  const forcedExitCode = exitCode === 0 ? 1 : exitCode;
  const hardExitTimer = setTimeout(() => {
    log.error('Hard shutdown deadline expired; terminating the process');
    httpServer?.closeAllConnections?.();
    process.exit(forcedExitCode);
  }, SHUTDOWN_GRACE_MS + SHUTDOWN_FORCE_EXIT_BUFFER_MS);
  shutdownPromise = (async () => {
    log.info(`Received ${signal}; shutting down`);

    beginAccountOperationShutdown();
    const schedulerDrain = scheduler.shutdown(SHUTDOWN_GRACE_MS);
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;

    let forced = false;
    if (httpServer?.listening) {
      const httpClosed = new Promise((resolve) => httpServer.close(() => resolve(true)));
      const serverDrained = await completionWithin(
        httpClosed,
        Math.max(1, deadline - Date.now()),
      );
      forced = !serverDrained;
      if (!serverDrained) httpServer.closeAllConnections?.();
    }

    const remainingMs = Math.max(1, deadline - Date.now());
    const schedulerIdle = await completionWithin(schedulerDrain, remainingMs);
    const drainBudgetMs = Math.max(1, deadline - Date.now());
    const [automationIdle, accountIdle, tasksIdle] = await Promise.all([
      waitForAutomationIdle(drainBudgetMs),
      waitForAccountOperationsIdle(drainBudgetMs),
      waitForAsyncTasksIdle(drainBudgetMs),
    ]);
    forced ||= !schedulerIdle || !automationIdle || !accountIdle || !tasksIdle;

    if (forced) {
      log.warn('Shutdown grace period expired; closing remaining connections');
      httpServer?.closeAllConnections?.();
    }

    const browserClosed = await completionWithin(
      automationRuntime.close(),
      SHUTDOWN_FORCE_EXIT_BUFFER_MS,
    );
    forced ||= !browserClosed;
    if (!browserClosed) {
      log.warn('Browser runtime did not close before the hard shutdown deadline');
    }

    if (forced) {
      const forceSettleMs = 15_000;
      await Promise.all([
        scheduler.waitForRunsIdle(forceSettleMs),
        waitForAutomationIdle(forceSettleMs),
        waitForAccountOperationsIdle(forceSettleMs),
        waitForAsyncTasksIdle(forceSettleMs),
      ]);
    }

    clearTimeout(hardExitTimer);
    process.exit(forced ? forcedExitCode : exitCode);
  })();
  return shutdownPromise;
}

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled Rejection', {
    reason: reason instanceof Error
      ? safeErrorMetadata(reason)
      : { type: typeof reason },
  });
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught Exception', { error: safeErrorMetadata(err) });
  void shutdown('uncaughtException', 1);
});

process.on('punchpilot:automation-unrecoverable', (error) => {
  log.error('Browser runtime became unrecoverable', {
    error: safeErrorMetadata(error),
  });
  void shutdown('automationRuntimeFailure', 1);
});

// Initialize database
log.info('Initializing database...');
try {
  initDatabase();
} catch (error) {
  log.error('Database initialization failed', { error: safeErrorMetadata(error) });
  process.exit(1);
}

// Start scheduler
log.info('Starting scheduler...');
try {
  await scheduler.initialize();
} catch (err) {
  log.error('Scheduler initialization failed', { error: safeErrorMetadata(err) });
  await shutdown('schedulerInitializationFailure', 1);
}

// Screenshot auto-cleanup: delete files older than 7 days
function cleanOldScreenshots(daysToKeep = 7) {
  const configuredDir = path.resolve(SCREENSHOTS_DIR);
  if (!fs.existsSync(configuredDir)) return;
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    const dir = ensureScreenshotsDir(configuredDir);
    const rootMetadata = fs.lstatSync(dir);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      log.warn('Screenshot cleanup skipped an unsafe directory');
      return;
    }
    const removeOldFiles = (directory) => {
      // The caller supplies only the validated root or a strict identity child.
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- Both values come from a validated directory and its direct readdir entries; lstat prevents link following.
        try {
          // Entries are inspected without following links before deletion.
          const stat = fs.lstatSync(file);
          if (
            isRecognizedScreenshotFilename(name) &&
            !stat.isSymbolicLink() &&
            stat.isFile() &&
            stat.mtimeMs < cutoff
          ) {
            fs.rmSync(file);
            removed++;
          }
        } catch {}
      }
    };
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      try {
        const stat = fs.lstatSync(entry);
        if (
          isRecognizedScreenshotFilename(name) &&
          !stat.isSymbolicLink() &&
          stat.isFile() &&
          stat.mtimeMs < cutoff
        ) {
          fs.rmSync(entry);
          removed++;
        } else if (
          !stat.isSymbolicLink() &&
          stat.isDirectory() &&
          isScreenshotIdentityKey(name)
        ) {
          removeOldFiles(entry);
        }
      } catch {}
    }
    if (removed > 0) log.info(`Cleaned ${removed} screenshot(s) older than ${daysToKeep} days`);
  } catch (error) {
    log.warn('Screenshot cleanup skipped', {
      code: error?.code || 'SCREENSHOT_CLEANUP_FAILED',
    });
  }
}

// Run cleanup on startup and every 24 hours
cleanOldScreenshots();
setInterval(() => cleanOldScreenshots(), 24 * 60 * 60 * 1000).unref();

process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('SIGINT', () => void shutdown('SIGINT', 0));

// Start Express server
httpServer = app.listen(PORT, '0.0.0.0', () => {
  const tz = getTimezone();
  log.info(`PunchPilot v${pkg.version} running on http://0.0.0.0:${PORT}`);
  log.info(`Dashboard: http://localhost:${PORT}`);
  log.info(`Timezone: ${tz} (${todayStringInTz()} ${currentTimeInTz()})`);
  log.info(`System TZ env: ${process.env.TZ || '(not set, using Intl: ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')'}`);
});
