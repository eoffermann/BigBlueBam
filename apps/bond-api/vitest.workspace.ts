import { defineWorkspace } from 'vitest/config';
import { dbTestProjects } from '../../vitest.db-policy.mjs';

// Unit suites keep 60 s (CI runners sometimes blow through the 5 s default on first-test-in-file
// import cost: drizzle + peer-app-stubs can take multiple seconds); *.db.test.ts suites run under
// the workspace DB budget in vitest.db-policy.mjs (#385). Coverage stays in vitest.config.ts.
export default defineWorkspace(
  dbTestProjects({
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  }),
);
