import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 30s per test — the db-mock tests dynamic-import service modules
    // inside each `it()` which can take 2-3 seconds cold in CI, leaving
    // no margin under the default 5000ms. Wave 2 Bench plan will rework
    // the mock plumbing so the timeout can come back down.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
