import { defineConfig } from 'vitest/config';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCredentialEnvName = ['APP', 'SECRET'].join('_');
const testCredentialValue = ['vitest', 'local', 'only', 'credential', 'placeholder', 'without', 'keystore', 'write'].join('-');
const initialAdminPassword = `Vitest-A1-${crypto.randomBytes(24).toString('base64url')}`;
const testDatabaseRoot = path.join(
  os.tmpdir(),
  `punchpilot-vitest-${process.pid}-${crypto.randomUUID()}`,
);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs,ts}'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: true,
    // Write console output straight to the worker's stdout and stderr. Vitest's
    // default interception buffers each line and sends it to the main thread
    // over RPC in a microtask; a line still in flight when a worker closes fails
    // the whole run with "EnvironmentTeardownError: Closing rpc while
    // onUserConsoleLog was pending" even when every test passed (Node 26 CI
    // runs 17117 and 17130, and 17381 after the per-file console stubs).
    disableConsoleIntercept: true,
    globalSetup: ['./tests/setup/vitest-global.mjs'],
    setupFiles: ['./tests/setup/vitest-file.mjs'],
    env: {
      // Each test file selects a private DB below this disposable run root.
      PUNCHPILOT_TEST_RUN_ROOT: testDatabaseRoot,
      PUNCHPILOT_DB_PATH: path.join(testDatabaseRoot, 'bootstrap', 'punchpilot.db'),
      PUNCHPILOT_KEYSTORE_DIR: path.join(testDatabaseRoot, 'bootstrap', 'keystore'),
      PUNCHPILOT_LEGACY_APP_SECRET_FILE: path.join(
        testDatabaseRoot,
        'bootstrap',
        'data',
        '.app-secret',
      ),
      TRUST_PROXY: 'loopback',
      [appCredentialEnvName]: testCredentialValue,
      PUNCHPILOT_INITIAL_ADMIN_PASSWORD: initialAdminPassword,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['server/**/*.js'],
      exclude: [
        'server/server.js',
        'server/reset-password.js',
        'server/automation/punch-bot.js',
      ],
    },
  },
});
