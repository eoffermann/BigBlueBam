import { z } from 'zod';

/**
 * Optimistic stale-write guard (the suite-wide 409 convention).
 *
 * A client that read a record holds its `updated_at`. Sending that value back on
 * a PATCH/PUT as `expected_updated_at` asks the server to reject the write with
 * HTTP 409 if the row changed since the client loaded it. Clients that OMIT the
 * field keep the prior last-write-wins behavior, so adopting this is fully
 * backward-compatible: existing callers are unaffected.
 *
 * See docs/plans/synchronous-presence-rollout-by-app.md (Item 1).
 */

/** Error `code` returned (HTTP 409) when the guard trips. */
export const STALE_WRITE_CODE = 'STALE_WRITE';

/**
 * Spread into a PATCH/PUT body schema to accept the optional guard token.
 * The value is intentionally a loose string (not z.datetime) so an odd but
 * valid serialization never 400s; `isStaleWrite` does the real comparison and
 * treats anything unparseable as "no guard".
 */
export const staleWriteFields = {
  expected_updated_at: z.string().optional(),
} as const;

/** Standalone schema for parsing just the guard field off a request body. */
export const staleWriteSchema = z.object(staleWriteFields);

/**
 * True only when `expected` was provided AND does not match the row's current
 * `updated_at` (compared at millisecond precision). Returns false when `expected`
 * is absent or unparseable, so callers degrade safely to last-write-wins.
 */
export function isStaleWrite(
  expected: string | undefined | null,
  actual: Date | string | null | undefined,
): boolean {
  if (!expected || actual == null) return false;
  const e = new Date(expected).getTime();
  const a = new Date(actual).getTime();
  if (Number.isNaN(e) || Number.isNaN(a)) return false;
  return e !== a;
}

/**
 * Build the standard 409 stale-write error envelope. `currentUpdatedAt` lets the
 * client offer "reload" or "overwrite" (resend with this value).
 */
export function staleWriteError(requestId: string, currentUpdatedAt: Date | string | null) {
  const current =
    currentUpdatedAt instanceof Date ? currentUpdatedAt.toISOString() : currentUpdatedAt;
  return {
    error: {
      code: STALE_WRITE_CODE,
      message: 'This record changed since you loaded it. Reload to see the latest, or resend to overwrite.',
      details: [{ field: 'expected_updated_at', issue: 'stale' }],
      request_id: requestId,
    },
    current_updated_at: current,
  };
}
