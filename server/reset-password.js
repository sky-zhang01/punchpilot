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
 *   - First login uses the configured password source, or a new generated password
 *
 * Usage:
 *   docker exec -it punchpilot node server/reset-password.js
 *
 * This is a security measure: if someone unauthorized has access to the Docker
 * container, a password reset alone is insufficient because the container stores
 * freee credentials, OAuth tokens, and encryption keys that could all be
 * compromised. A full wipe is the only safe response.
 */

import './env.js';
import path from 'path';
import fs from 'fs';
import { DB_PATH, KEYSTORE_DIR, LOG_DIR, SCREENSHOTS_DIR, LEGACY_SECRET_FILE, INITIAL_ADMIN_PASSWORD_FILE } from './paths.js';
import { createInterface } from 'readline';
import { isRecognizedScreenshotFilename, isScreenshotIdentityKey, SCREENSHOT_ROOT_MARKER } from './automation/constants.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const configuredInitialPassword = Boolean(process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD || process.env.PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE);

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function removePathNoFollow(target, { recursive = false } = {}) {
  let metadata;
  try {
    metadata = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  fs.rmSync(target, {
    recursive: recursive && metadata.isDirectory() && !metadata.isSymbolicLink(),
    force: true,
  });
  return true;
}

function assertResetContents(directory, screenshots = false) {
  if (!fs.existsSync(directory)) return;
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink()) return; // rm removes only the link itself.
  if (!metadata.isDirectory()) throw new Error('Reset target is not a directory');
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    const item = fs.lstatSync(entry);
    if (screenshots && isScreenshotIdentityKey(name) && item.isDirectory() && !item.isSymbolicLink()) {
      assertResetContents(entry, true);
    } else if (!(screenshots
      ? name === SCREENSHOT_ROOT_MARKER || isRecognizedScreenshotFilename(name)
      : name === 'punchpilot.log' || /^punchpilot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/.test(name)) || item.isDirectory()) {
      throw new Error('Unrelated content prevents resetting this directory');
    }
  }
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
  if (configuredInitialPassword) {
    console.log('  Configured initial administrator password sources remain in effect after reset.');
    console.log('  External password files are preserved outside the generated keystore password path.');
    console.log('  Rotate or remove external password configuration before restarting.');
  } else {
    console.log('  A new one-time administrator password will be generated after restart.');
    console.log('  Read it from the keystore, then change it at first login.');
  }
  console.log('');

  console.log('  Selected paths:', { database: DB_PATH, keystore: KEYSTORE_DIR, logs: LOG_DIR, screenshots: SCREENSHOTS_DIR, migratedKey: LEGACY_SECRET_FILE });

  const answer = await ask('  Type RESET to confirm factory reset: ');

  if (answer !== 'RESET') {
    console.log('\n  Cancelled. No changes were made.\n');
    rl.close();
    process.exit(0);
  }

  console.log('');
  console.log('  Destroying data...');
  for (const directory of [LOG_DIR, SCREENSHOTS_DIR]) {
    const protectedPaths = [DB_PATH, KEYSTORE_DIR, process.cwd(), import.meta.dirname];
    if (directory === path.parse(directory).root || protectedPaths.some(target => target === directory || target.startsWith(directory + path.sep))) {
      throw new Error('Refusing reset of a root or ancestor directory');
    }
  }

  const files = [DB_PATH, `${DB_PATH}-shm`, `${DB_PATH}-wal`, LEGACY_SECRET_FILE,
    path.join(KEYSTORE_DIR, '.app-secret'), INITIAL_ADMIN_PASSWORD_FILE];
  // Validate the complete selection before deleting any data.
  for (const target of [...files, LOG_DIR, SCREENSHOTS_DIR]) {
    for (let ancestor = path.dirname(target); ; ancestor = path.dirname(ancestor)) {
      try {
        const metadata = fs.lstatSync(ancestor);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Unsafe reset directory');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (ancestor === path.parse(ancestor).root) break;
    }
  }
  for (const file of files) {
    try {
      const metadata = fs.lstatSync(file);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error('Unsafe reset file');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  assertResetContents(LOG_DIR);
  assertResetContents(SCREENSHOTS_DIR, true);
  let destroyed = 0;
  for (const file of new Set(files)) {
    if (removePathNoFollow(file)) destroyed++;
  }

  // 4. Purge logs
  const logsDir = LOG_DIR;
  if (removePathNoFollow(logsDir, { recursive: true })) {
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    console.log('    \x1b[31m✗\x1b[0m Purged logs');
    destroyed++;
  }

  // 5. Purge screenshots
  if (removePathNoFollow(SCREENSHOTS_DIR, { recursive: true })) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true, mode: 0o700 });
    console.log('    \x1b[31m✗\x1b[0m Purged screenshots');
    destroyed++;
  }

  console.log('');
  if (destroyed > 0) {
    console.log(`  \x1b[32m✓ Factory reset complete.\x1b[0m ${destroyed} item(s) destroyed.`);
  } else {
    console.log('  \x1b[33m⚠ No data files found. Container may already be clean.\x1b[0m');
  }

  console.log('');
  console.log('  The container will now exit and restart automatically.');
  console.log(configuredInitialPassword
    ? '  Apply your intended external initial password configuration before restarting.'
    : '  Read the new one-time administrator password from the keystore.');
  console.log('');

  rl.close();

  // Exit with code 1 — Docker "restart: unless-stopped" will auto-restart the container.
  // On restart, server.js creates a fresh database and one-time administrator password.
  process.exit(1);
}

main().catch(() => {
  console.error('\n  Error: factory reset failed.\n');
  rl.close();
  process.exit(1);
});
