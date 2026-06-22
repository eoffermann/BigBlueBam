import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // First-test-in-file import cost on CI-sized runners sometimes blows
    // through the default 5s limit (dashboard.service.ts pulls in the full
    // drizzle schema + cache service + utils graph). Bump to 30s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
