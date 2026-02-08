#!/usr/bin/env node

/**
 * PunchPilot Factory Reset Tool
 *
 * DANGER: This completely destroys ALL data and returns the container
 * to its initial state. After reset:
 *   - Database (users, settings, credentials, tokens) is deleted
 *   - Encryption key (.app-secret) is deleted — all encrypted data becomes unrecoverable
 *   - Logs and screenshots are purged
 *   - Container restarts automatically (Docker restart policy)
 *   - First login: admin/admin → forced password change
 *
 * Usage:
 *   docker exec -it punchpilot node server/reset-password.js
 *
 * This is a security measure: if someone unauthorized has access to the Docker
 * container, a password reset alone is insufficient because the container stores
 * freee credentials, OAuth tokens, and encryption keys that could all be
 * compromised. A full wipe is the only safe response.
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const KEYSTORE_DIR = path.resolve(__dirname, '..', 'keystore');
const SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'screenshots');

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log('');
  console.log('\x1b[31m╔═══════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[31m║         PunchPilot Factory Reset                      ║\x1b[0m');
  console.log('\x1b[31m╚═══════════════════════════════════════════════════════╝\x1b[0m');
  console.log('');
  console.log('\x1b[33m  WARNING: This will permanently destroy ALL data:\x1b[0m');
  console.log('');
  console.log('    - User accounts and passwords');
  console.log('    - freee login credentials');
  console.log('    - OAuth tokens and client secrets');
  console.log('    - Encryption key (makes any backup unrecoverable)');
  console.log('    - Schedule configuration');
  console.log('    - Execution logs');
  console.log('    - Screenshots');
  console.log('');
  console.log('  After reset, the container will restart automatically.');
  console.log('  You can log in with: \x1b[36madmin / admin\x1b[0m');
  console.log('  You will be required to set a new username and password.');
  console.log('');

  const answer = await ask('  Type RESET to confirm factory reset: ');

  if (answer !== 'RESET') {
    console.log('\n  Cancelled. No changes were made.\n');
    rl.close();
    process.exit(0);
  }

  console.log('');
  console.log('  Destroying data...');

  let destroyed = 0;

  // 1. Delete database files
  const dbFiles = ['punchpilot.db', 'punchpilot.db-shm', 'punchpilot.db-wal'];
  for (const f of dbFiles) {
    const fp = path.join(DATA_DIR, f);
    if (fs.existsSync(fp)) {
      fs.rmSync(fp, { force: true });
      console.log(`    \x1b[31m✗\x1b[0m Deleted ${f}`);
      destroyed++;
    }
  }

  // 2. Delete encryption key from legacy location (data/)
  const oldSecretPath = path.join(DATA_DIR, '.app-secret');
  if (fs.existsSync(oldSecretPath)) {
    fs.writeFileSync(oldSecretPath, crypto.randomBytes(64).toString('hex'));
    fs.rmSync(oldSecretPath, { force: true });
    console.log('    \x1b[31m✗\x1b[0m Deleted .app-secret from data/ (legacy)');
    destroyed++;
  }

  // 3. Delete encryption key from keystore/ (secure overwrite then delete)
  if (fs.existsSync(KEYSTORE_DIR)) {
    try {
      const keystoreFiles = fs.readdirSync(KEYSTORE_DIR);
      for (const f of keystoreFiles) {
        const fp = path.join(KEYSTORE_DIR, f);
        try {
          fs.writeFileSync(fp, crypto.randomBytes(64).toString('hex'));
          fs.rmSync(fp, { force: true });
        } catch {}
      }
      if (keystoreFiles.length > 0) {
        console.log(`    \x1b[31m✗\x1b[0m Destroyed ${keystoreFiles.length} keystore file(s) (secure wipe)`);
        destroyed += keystoreFiles.length;
      }
    } catch {}
  }

  // 4. Purge logs
  const logsDir = path.join(DATA_DIR, 'logs');
  if (fs.existsSync(logsDir)) {
    try {
      const logFiles = fs.readdirSync(logsDir);
      for (const f of logFiles) {
        fs.rmSync(path.join(logsDir, f), { force: true });
      }
      if (logFiles.length > 0) {
        console.log(`    \x1b[31m✗\x1b[0m Purged ${logFiles.length} log file(s)`);
        destroyed += logFiles.length;
      }
    } catch {
      // ignore errors reading logs dir
    }
  }

  // 5. Purge screenshots
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    try {
      fs.rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      console.log('    \x1b[31m✗\x1b[0m Purged screenshots');
      destroyed++;
    } catch {
      // ignore
    }
  }

  console.log('');
  if (destroyed > 0) {
    console.log(`  \x1b[32m✓ Factory reset complete.\x1b[0m ${destroyed} item(s) destroyed.`);
  } else {
    console.log('  \x1b[33m⚠ No data files found. Container may already be clean.\x1b[0m');
  }

  console.log('');
  console.log('  The container will now exit and restart automatically.');
  console.log('  Log in with: \x1b[36madmin / admin\x1b[0m');
  console.log('');

  rl.close();

  // Exit with code 1 — Docker "restart: unless-stopped" will auto-restart the container.
  // On restart, server.js → initDatabase() creates a fresh database with admin/admin.
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  rl.close();
  process.exit(1);
});
