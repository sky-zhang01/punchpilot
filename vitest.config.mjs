import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs,ts}'],
    exclude: ['tests/phase5-integration.test.mjs'],  // Standalone test, runs with: node tests/phase5-integration.test.mjs
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,  // Run test files sequentially (shared SQLite DB)
  },
});
