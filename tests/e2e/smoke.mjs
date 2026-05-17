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
  const logs = [];

  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PUNCHPILOT_DB_PATH: path.join(tempDir, 'punchpilot.db'),
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

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
      localStorage.setItem('pp-locale', 'en');
    });

    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('admin');
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

    await page.getByRole('heading', { name: 'Status' }).waitFor();
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByText('API Configuration (OAuth2)').waitFor();
    await page.goto(`${baseUrl}/logs`, { waitUntil: 'domcontentloaded' });
    await page.getByText('No logs found').waitFor();
  } catch (error) {
    console.error(processLogs());
    throw error;
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
