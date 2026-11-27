import { defineWorkspace } from 'vitest/config';
import { dbTestProjects } from '../../vitest.db-policy.mjs';

// Unit suites keep 60 s (CI runners sometimes blow through a 10 s ceiling on first-test-in-file
// module-graph load, especially since this suite pulls in the full Qdrant-adapter import chain);
// the test/db/ suites run under the workspace DB budget in vitest.db-policy.mjs (#385). Coverage
// stays in vitest.config.ts.
export default defineWorkspace(
  dbTestProjects({
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  }),
);
