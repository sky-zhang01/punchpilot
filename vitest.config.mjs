import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs,ts}'],
    exclude: ['tests/phase5-integration.test.mjs'],  // Standalone test, runs with: node tests/phase5-integration.test.mjs
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,  // Run test files sequentially (shared SQLite DB)
    env: {
      // Use a separate test DB to avoid overwriting production data
      PUNCHPILOT_DB_PATH: path.resolve(__dirname, 'data', 'punchpilot-test.db'),
    },
  },
});
