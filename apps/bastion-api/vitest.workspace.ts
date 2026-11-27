import { defineWorkspace } from 'vitest/config';
import { DB_HOOK_TIMEOUT_MS, DB_TEST_TIMEOUT_MS } from '../../vitest.db-policy.mjs';

// The ONE place bastion-api's test projects live (#320). The DB-backed suites under test/db each
// used to set their own (vi.setConfig in 14 files, vitest's 10 s hook default in 5 more), and
// m3-services hit that 10 s hook ceiling in a full parallel run: seeding an org through the real
// migrations is slow on a loaded Windows host, and the first test in a file also pays the cold
// module load (beacon-api needed 300 s for it in the same session). A DB hook or test that is
// merely slow under load must not read as a failure; a hang still fails, after this budget. The
// budget itself is the workspace-wide one in vitest.db-policy.mjs (#385), re-exported here for
// test/db-suite-hygiene.test.ts.
export { DB_HOOK_TIMEOUT_MS, DB_TEST_TIMEOUT_MS };

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      include: ['test/**/*.test.ts'],
      exclude: ['test/db/**', '**/node_modules/**'],
      // permission-catalog.test.ts opens a database connection in a hook when DATABASE_URL is set.
      hookTimeout: 60_000,
    },
  },
  {
    test: {
      name: 'db',
      environment: 'node',
      include: ['test/db/**/*.test.ts'],
      // Installs the fault-injection triggers once, before any file runs (test/db/fault-injection.ts):
      // no test does DDL on a shared table while other files write it.
      globalSetup: ['test/db/global-setup.ts'],
      testTimeout: DB_TEST_TIMEOUT_MS,
      hookTimeout: DB_HOOK_TIMEOUT_MS,
    },
  },
]);
