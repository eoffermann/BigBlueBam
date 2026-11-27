// The one place every SPA's vitest setup takes its timing budget from (#391).
//
// Testing Library's findBy* / waitFor give up after asyncUtilTimeout, 1 s by default. Under
// parallel CI load the first render of a page (React Query fetch, Suspense, PermissionsProvider)
// can take several seconds, so a correct page fails with "Unable to find ..." (#384: every Bastion
// page suite failed 10/10 under 10x load). The test and hook budgets have to sit above that wait,
// or the 20 s wait is cut short by vitest's 5 s default.
//
// Each SPA's test/setup.ts calls applySpaTestDefaults({ configure, vi }) with its OWN
// @testing-library/react `configure` and vitest `vi`: the setting lives in module state of the
// copy the SPA's tests use, so it must be applied to that copy, not to one resolved from here.
// scripts/lib/spa-test-setup.test.mjs fails if an SPA's setup does not call it.

/** How long findBy* / waitFor keep polling before failing. */
export const SPA_ASYNC_UTIL_TIMEOUT_MS = 20_000;
/** Per-test and per-hook budget; must stay above SPA_ASYNC_UTIL_TIMEOUT_MS. */
export const SPA_TEST_TIMEOUT_MS = 60_000;

export interface SpaTestDeps {
  /** `configure` from @testing-library/react. */
  configure: (config: { asyncUtilTimeout: number }) => void;
  /** `vi` from vitest. */
  vi: { setConfig: (config: { testTimeout?: number; hookTimeout?: number }) => void };
}

export function applySpaTestDefaults({ configure, vi }: SpaTestDeps): void {
  configure({ asyncUtilTimeout: SPA_ASYNC_UTIL_TIMEOUT_MS });
  vi.setConfig({ testTimeout: SPA_TEST_TIMEOUT_MS, hookTimeout: SPA_TEST_TIMEOUT_MS });
}
