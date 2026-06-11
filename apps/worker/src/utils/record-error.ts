/**
 * Worker-side wrapper for inserting a row into the system_errors table
 * when a BullMQ job fails. Lets the SuperUser Console's Log Analysis
 * tab surface worker failures the same way it surfaces api 5xxs.
 *
 * Wired through the queue's 'failed' listener so the existing logger
 * call is preserved — this only ADDS the database row, it never
 * replaces the stdout log line ops may still grep on Railway.
 *
 * All writes are best-effort: a recorder that itself throws must never
 * compound a failure that was already in flight.
 */

import { sql } from 'drizzle-orm';
import { getDb } from './db.js';

const MAX_MESSAGE = 4000;
const MAX_STACK = 16000;
const MAX_ROUTE = 255;

function clip(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Insert a system_errors row for a worker job failure. Best-effort,
 * never throws.
 *
 * If the failing job attached job-specific context to the error (e.g.
 * the email job pins the resolved SMTP host/port/secure as
 * `err.smtp_context`), it's included in the payload so the SuperUser
 * Log Analysis tab can show it without re-running the failure.
 */
export async function recordWorkerError(opts: {
  queueName: string;
  jobId: string | number | undefined;
  jobName?: string;
  err: Error;
}): Promise<void> {
  try {
    const db = getDb();
    const errAny = opts.err as Error & {
      code?: string;
      smtp_context?: unknown;
      response?: string;
    };
    const payload: Record<string, unknown> = {
      queue: opts.queueName,
      job_id: opts.jobId ?? null,
      job_name: opts.jobName ?? null,
      name: opts.err.name,
    };
    if (errAny.smtp_context) payload.smtp_context = errAny.smtp_context;
    if (errAny.response) payload.server_response = errAny.response;

    await db.execute(sql`
      INSERT INTO system_errors (
        service, request_id, method, route, status_code,
        error_code, message, stack, payload
      ) VALUES (
        'worker',
        NULL,
        NULL,
        ${clip(`${opts.queueName}/${opts.jobName ?? 'job'}`, MAX_ROUTE)},
        NULL,
        ${clip(errAny.code ?? null, 80)},
        ${clip(opts.err.message ?? '(no message)', MAX_MESSAGE) ?? '(no message)'},
        ${clip(opts.err.stack ?? null, MAX_STACK)},
        ${JSON.stringify(payload)}::jsonb
      )
    `);
  } catch {
    /* swallow */
  }
}
