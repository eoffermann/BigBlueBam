import { defineWorkspace } from 'vitest/config';
import { dbTestProjects } from '../../vitest.db-policy.mjs';

// Unit suites keep 60 s (first-test-in-file import cost on CI-sized runners: dashboard.service.ts
// pulls in the full drizzle schema + cache service + utils graph); the test/db/ suites run under
// the workspace DB budget in vitest.db-policy.mjs (#385). Coverage stays in vitest.config.ts.
export default defineWorkspace(
  dbTestProjects({
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  }),
);
