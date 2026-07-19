import type { FastifyBaseLogger } from 'fastify';
import { env } from '../env.js';

// Braid live-ingest dispatch (Braid design spec §6, IN3). bolt-api is the event hub; when a
// subscribed source event is ingested, POST a refs-only trigger to braid-api's
// /internal/events route, which enqueues a braid-match-on-ingest job. Fire-and-forget: any
// failure is swallowed because the nightly braid-rescan source-diff is the durable fallback,
// so a dropped dispatch degrades to next-day resolution, never a stuck watermark.
//
// Only the (source, event_type) pairs that actually emit a Bolt event today are wired here.
// bond.company / bill.client / book.event_attendee do NOT yet emit upsert events, so those
// source types rely entirely on the nightly rescan until their apps publish events
// (documented soft-dependency, spec §6 / §12 open question 1).

interface Subscription {
  source_type: string;
  // Extract the source row id from the event payload (nested shape).
  extractId: (payload: Record<string, unknown>) => string | null;
}

function nested(payload: Record<string, unknown>, path: string): string | null {
  const parts = path.split('.');
  let cur: unknown = payload;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

// key = `${source}:${event_type}`.
const SUBSCRIPTIONS: Record<string, Subscription> = {
  'bond:contact.upserted': {
    source_type: 'bond.contact',
    extractId: (p) => nested(p, 'contact.id'),
  },
  'helpdesk:user.upserted': {
    source_type: 'helpdesk.user',
    extractId: (p) => nested(p, 'helpdesk_user.id'),
  },
  // TODO(braid §6): add 'bond:company.upserted' -> bond.company, 'bill:client.created'/
  // 'client.updated' -> bill.client, and 'book:attendee.created' -> book.event_attendee once
  // those apps publish the corresponding Bolt events. Until then the nightly rescan covers them.
};

function braidInternalUrl(): string {
  const fromEnv = (process.env.BRAID_API_INTERNAL_URL ?? '').trim();
  return (fromEnv || 'http://braid-api:4020').replace(/\/+$/, '');
}

export async function dispatchToBraid(
  event: { orgId: string; source: string; eventType: string; payload: Record<string, unknown> },
  logger: FastifyBaseLogger,
): Promise<void> {
  const sub = SUBSCRIPTIONS[`${event.source}:${event.eventType}`];
  if (!sub) return;

  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return; // fail-closed: braid /internal/events requires the shared secret

  const sourceId = sub.extractId(event.payload);
  if (!sourceId) {
    logger.warn(
      { source: event.source, eventType: event.eventType },
      'braid-dispatch: could not extract source id from payload; skipping (rescan will catch it)',
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // braid-api registers its routes under the /v1 prefix, so the internal
    // ingest-trigger route is /v1/internal/events (verified live).
    await fetch(`${braidInternalUrl()}/v1/internal/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify({
        org_id: event.orgId,
        source_type: sub.source_type,
        source_id: sourceId,
      }),
    });
  } catch {
    // Swallowed: the nightly braid-rescan source-diff is the durable fallback (spec §6).
  } finally {
    clearTimeout(timer);
  }
}
