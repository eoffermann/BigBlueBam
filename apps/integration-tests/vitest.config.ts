import { defineConfig } from 'vitest/config';

// Wave 3 integration test harness (scaffold).
//
// This package exists so Wave 4 CI work has a concrete target to wire up.
// It does NOT currently run against a live docker compose stack. Every
// service client used in src/tests/ is mocked in-process using a simple
// fetch-style stub so the smoke test can exercise the Bam -> Bond -> Bolt
// -> Beacon routing fan-out without any containers running.
//
// When Wave 4 flips the live-stack switch, point fixtures/stack.fixture.ts
// at a real compose file and let Vitest drive it sequentially.

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests are inherently serial; do not parallelize.
    sequence: {
      concurrent: false,
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
