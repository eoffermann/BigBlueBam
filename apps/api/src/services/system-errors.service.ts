/**
 * Insert a row into system_errors whenever any service hits a 5xx.
 *
 * Wired into the shared @bigbluebam/logging createErrorHandler via the
 * `recordError` hook on the api side; satellite services that adopt
 * this can pass their own version of recordSystemError too.
 *
 * All inputs are clipped to safe sizes so a noisy error path can't blow
 * up the table. The whole call is wrapped in try/catch — logging must
 * never crash a request that was already failing.
 */

import { db } from '../db/index.js';
import { systemErrors } from '../db/schema/system-errors.js';
import type { ErrorRecorderContext } from '@bigbluebam/logging';

const MAX_MESSAGE_LEN = 4000;
const MAX_STACK_LEN = 16000;
const MAX_ROUTE_LEN = 255;

function clip(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

export async function recordSystemError(
  err: Error,
  ctx: ErrorRecorderContext,
): Promise<void> {
  try {
    await db.insert(systemErrors).values({
      service: ctx.service.slice(0, 40),
      request_id: clip(ctx.request_id, 80),
      user_id: ctx.user_id ?? null,
      org_id: ctx.org_id ?? null,
      method: clip(ctx.method ?? null, 10),
      route: clip(ctx.route ?? null, MAX_ROUTE_LEN),
      status_code: ctx.status_code,
      error_code:
        clip(
          (err as unknown as { code?: string }).code ?? null,
          80,
        ) ?? null,
      message: clip(err.message ?? '(no message)', MAX_MESSAGE_LEN) ?? '(no message)',
      stack: clip(err.stack ?? null, MAX_STACK_LEN),
      payload: { internal_error_id: ctx.internal_error_id, name: err.name },
    });
  } catch {
    /* swallow */
  }
}
