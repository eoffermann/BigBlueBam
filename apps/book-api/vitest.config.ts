import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CI runners sometimes blow through the default timeouts on first-test-in-file
    // import cost (drizzle + peer-app-stubs can take multiple seconds), which
    // surfaced as "Hook timed out in 10000ms" on the DB-backed book-api suites.
    // Mirror the other *-api packages' config.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globals: true,
    environment: 'node',
  },
});
