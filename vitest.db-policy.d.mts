// Types for vitest.db-policy.mjs (#385).
export declare const DB_TEST_TIMEOUT_MS: number;
export declare const DB_HOOK_TIMEOUT_MS: number;
export declare const DB_TEST_INCLUDE: string[];
export interface DbTestProject {
  test: Record<string, unknown> & { name: string; include: string[]; exclude: string[] };
}
export declare function dbTestProjects(
  base?: Record<string, unknown>,
  opts?: { dbInclude?: string[]; db?: Record<string, unknown> },
): DbTestProject[];
