import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // testTimeout raised from 10000ms to 30000ms to give the db-mock
    // tests enough headroom under CI contention; dynamic-importing the
    // service modules inside each it() costs 2-3s cold. See
    // DECISIONS.md D-008d.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
