import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, processLogs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start within 30s.\n${processLogs()}`);
}

async function main() {
  const distIndex = path.join(PROJECT_ROOT, 'client', 'dist', 'index.html');
  assert(fs.existsSync(distIndex), 'client/dist is missing. Run npm --prefix client run build before npm run test:e2e.');

  const port = await getFreePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-e2e-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrapPasswordFile = path.join(tempDir, 'keystore', 'initial-admin-password');
  const logs = [];

  fs.cpSync(path.join(PROJECT_ROOT, 'server'), path.join(tempDir, 'server'), {
    recursive: true,
  });
  fs.cpSync(path.join(PROJECT_ROOT, 'shared'), path.join(tempDir, 'shared'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'client'), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, 'client', 'dist'), path.join(tempDir, 'client', 'dist'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"module"}\n');
  fs.symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir');

  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: tempDir,
    env: {
      ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PLAYWRIGHT_BROWSERS_PATH']
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
      PORT: String(port),
      PUNCHPILOT_DB_PATH: path.join(tempDir, 'punchpilot.db'),
      PUNCHPILOT_KEYSTORE_DIR: path.join(tempDir, 'keystore'),
      PUNCHPILOT_LEGACY_APP_SECRET_FILE: path.join(tempDir, '.app-secret'),
      PUNCHPILOT_LOG_DIR: path.join(tempDir, 'logs'),
      SHUTDOWN_GRACE_MS: '1000',
      PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE: bootstrapPasswordFile,
      SCREENSHOTS_DIR: path.join(tempDir, 'screenshots'),
      APP_SECRET: `e2e-${crypto.randomBytes(24).toString('hex')}`,
      TZ: 'Asia/Tokyo',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));

  const processLogs = () => logs.join('').split('\n').slice(-80).join('\n');

  let browser;
  try {
    await waitForServer(baseUrl, processLogs);
    const bootstrapPassword = fs.readFileSync(bootstrapPasswordFile, 'utf8').trim();

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
      localStorage.setItem('pp-locale', 'en');
    });

    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill(bootstrapPassword);
    await Promise.all([
      page.waitForURL('**/change-password'),
      page.getByRole('button', { name: 'Sign In' }).click(),
    ]);

    const password = `E2ePass${crypto.randomInt(1000, 9999)}`;
    await page.getByLabel('New Username').fill('e2euser');
    await page.getByLabel('New Password').fill(password);
    await page.getByLabel('Confirm Password').fill(password);
    await Promise.all([
      page.waitForURL('**/dashboard'),
      page.getByRole('button', { name: 'Save & Continue' }).click(),
    ]);
    assert(!fs.existsSync(bootstrapPasswordFile), 'bootstrap password file was not removed');

    await page.getByRole('heading', { name: 'Status' }).waitFor();
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByText('API Configuration (OAuth2)').waitFor();
    const logsResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/logs';
    });
    await page.goto(`${baseUrl}/logs`, { waitUntil: 'domcontentloaded' });
    const logsResponse = await logsResponsePromise;
    assert(logsResponse.ok(), `logs API returned ${logsResponse.status()}`);
    const logsPayload = await logsResponse.json();
    assert(Array.isArray(logsPayload.rows), 'logs API response is missing rows');
    await page.getByRole('table').waitFor();
    if (logsPayload.rows.length === 0) {
      await page.getByText('No logs found').waitFor();
    } else {
      await page.locator('tbody tr.ant-table-row').first().waitFor();
    }
  } catch (error) {
    console.error(processLogs());
    throw error;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
