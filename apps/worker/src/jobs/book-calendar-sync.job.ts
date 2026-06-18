/**
 * Book external-calendar sync sweep (Book task #63).
 *
 * Runs on a schedule and triggers the Book API's internal sync engine for every
 * external connection due for a refresh (ICS feeds today; Google/Outlook once
 * operator OAuth creds are configured). The actual fetch/parse/upsert work lives
 * in book-api (apps/book-api/src/services/external-sync.service.ts) so there is a
 * single engine shared by the user-initiated "Sync now" button and this sweep;
 * the worker just calls the internal route with the shared service secret.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface BookCalendarSyncJobData {
  /** Only sync connections last synced more than this many minutes ago. */
  stale_minutes?: number;
}

interface SyncResponse {
  data?: {
    synced: number;
    results: Array<{
      connection_id: string;
      status: string;
      imported: number;
      created: number;
      updated: number;
      removed: number;
      error: string | null;
    }>;
  };
}

export async function processBookCalendarSyncJob(
  job: Job<BookCalendarSyncJobData>,
  logger: Logger,
): Promise<void> {
  const bookApiUrl = (process.env.BOOK_API_INTERNAL_URL ?? 'http://book-api:4012').replace(/\/+$/, '');
  const secret = process.env.INTERNAL_SERVICE_SECRET;

  if (!secret) {
    logger.warn(
      { jobId: job.id },
      'book-calendar-sync: INTERNAL_SERVICE_SECRET not set — skipping sweep',
    );
    return;
  }

  const staleMinutes = job.data?.stale_minutes ?? 30;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(`${bookApiUrl}/v1/internal/connections/sync-due`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Secret': secret,
      },
      body: JSON.stringify({ stale_minutes: staleMinutes }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`book-calendar-sync sweep failed: HTTP ${res.status} ${text}`);
  }

  const body = (await res.json().catch(() => ({}))) as SyncResponse;
  const synced = body.data?.synced ?? 0;
  const totals = (body.data?.results ?? []).reduce(
    (acc, r) => {
      acc.imported += r.imported;
      acc.created += r.created;
      acc.updated += r.updated;
      acc.removed += r.removed;
      if (r.status === 'error') acc.errors++;
      return acc;
    },
    { imported: 0, created: 0, updated: 0, removed: 0, errors: 0 },
  );

  logger.info(
    { jobId: job.id, synced, ...totals },
    'book-calendar-sync: sweep complete',
  );
}
