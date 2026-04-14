/**
 * Re-exports canonical Bam table declarations from @bigbluebam/db-stubs.
 *
 * Wave 1.D of the 2026-04-13 push consolidated the 13 hand-maintained
 * `bbb-refs.ts` copies behind a single shared package. Adding a local
 * `pgTable(...)` declaration here will trip
 * `scripts/check-no-local-bbb-refs.mjs` in CI - update the canonical file
 * under `packages/db-stubs/src` instead, or annotate the override with
 * `// noqa: local-bbb-ref <reason>` if it is a transitional stub pointing
 * at a tracked Wave 2 fix.
 */
export * from '@bigbluebam/db-stubs';
