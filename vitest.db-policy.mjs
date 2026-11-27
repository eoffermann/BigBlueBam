// The ONE place the workspace's DB-backed test timeouts live (#385, generalizing bastion-api's #320).
//
// A suite that talks to a real Postgres (a `*.db.test.ts` file, or bastion-api's test/db/) pays for
// seeding through the real schema and for the first test's cold module load. On a loaded Windows
// host or CI runner that takes far longer than vitest's 5 s default (bay-api's routes.db.test.ts
// timed out there with no real failure). A DB test or hook that is merely slow under load must not
// read as a failure; a genuine hang still fails, after this budget.
//
// Every package with DB-backed suites builds its vitest projects through dbTestProjects() (or, for
// a hand-written workspace, imports the two constants). scripts/lib/db-test-timeout-policy.test.mjs
// fails if a package has a DB suite without adopting this module.

export const DB_TEST_TIMEOUT_MS = 300_000;
export const DB_HOOK_TIMEOUT_MS = 300_000;

/** The file patterns that mark a suite as DB-backed: `*.db.test.ts`, or anything under test/db/. */
export const DB_TEST_INCLUDE = ['test/**/*.db.test.ts', 'test/db/**/*.test.ts'];

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

/**
 * Split a package's tests into a `unit` project (its existing options, minus the DB suites) and a
 * `db` project (the same options, only the DB suites, under the DB budget). Pass the package's
 * existing `test` options as `base`; root-only options such as `coverage` stay on the root config.
 * The DB budget always wins over anything in `base` or `db`, so a package cannot quietly lower it.
 *
 * @param {Record<string, unknown>} [base]
 * @param {{ dbInclude?: string[]; db?: Record<string, unknown> }} [opts]
 */
export function dbTestProjects(base = {}, { dbInclude = DB_TEST_INCLUDE, db = {} } = {}) {
  const include = /** @type {string[] | undefined} */ (base.include) ?? ['test/**/*.test.ts'];
  const exclude = /** @type {string[] | undefined} */ (base.exclude) ?? DEFAULT_EXCLUDE;
  return [
    { test: { ...base, name: 'unit', include, exclude: [...exclude, ...dbInclude] } },
    {
      test: {
        ...base,
        ...db,
        name: 'db',
        include: dbInclude,
        exclude,
        testTimeout: DB_TEST_TIMEOUT_MS,
        hookTimeout: DB_HOOK_TIMEOUT_MS,
      },
    },
  ];
}
