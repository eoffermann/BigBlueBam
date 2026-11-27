import { defineWorkspace } from 'vitest/config';
import { dbTestProjects } from '../../vitest.db-policy.mjs';

// bay-api ran on vitest's 5 s default, so routes.db.test.ts timed out under load with no real
// failure (#385). Unit suites get the 60 s the other APIs use; *.db.test.ts suites run under the
// workspace DB budget in vitest.db-policy.mjs.
export default defineWorkspace(
  dbTestProjects({
    testTimeout: 60_000,
    hookTimeout: 60_000,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  }),
);
