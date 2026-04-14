import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // testTimeout raised from the 5000ms default. Wave 0 CI exposed that
    // db-mock tests dynamic-import their service modules inside each it(),
    // which can cost 2-3 seconds cold on a runner and leave no margin at
    // 5000ms. 30000ms gives a 10x safety buffer. Wave 2 plans will rework
    // the mock plumbing so this override can come back out. See
    // DECISIONS.md D-008d.
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: true,
  },
});
