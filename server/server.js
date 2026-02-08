import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from './app.js';
import { initDatabase } from './db.js';
import { scheduler } from './scheduler.js';
import { getTimezone, todayStringInTz, currentTimeInTz } from './timezone.js';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = logger.child('Server');
const PORT = process.env.PORT || 8681;

// Global error handlers to prevent server crashes
process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection', { reason: String(reason) });
  // Do NOT exit — keep the server running
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught Exception', { error: err.message, stack: err.stack });
  // Do NOT exit — keep the server running
});

// Initialize database
log.info('Initializing database...');
initDatabase();

// Start scheduler
log.info('Starting scheduler...');
try {
  await scheduler.initialize();
} catch (err) {
  log.error('Scheduler initialization failed', { error: err.message });
  log.warn('Server will continue without scheduler');
}

// Screenshot auto-cleanup: delete files older than 7 days
function cleanOldScreenshots(daysToKeep = 7) {
  const dir = path.resolve(__dirname, '..', 'screenshots');
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.rmSync(fp);
          removed++;
        }
      } catch {}
    }
    if (removed > 0) log.info(`Cleaned ${removed} screenshot(s) older than ${daysToKeep} days`);
  } catch {}
}

// Run cleanup on startup and every 24 hours
cleanOldScreenshots();
setInterval(() => cleanOldScreenshots(), 24 * 60 * 60 * 1000);

// Start Express server
app.listen(PORT, '0.0.0.0', () => {
  const tz = getTimezone();
  log.info(`PunchPilot v0.3.0 running on http://0.0.0.0:${PORT}`);
  log.info(`Dashboard: http://localhost:${PORT}`);
  log.info(`Timezone: ${tz} (${todayStringInTz()} ${currentTimeInTz()})`);
  log.info(`System TZ env: ${process.env.TZ || '(not set, using Intl: ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')'}`);
});
