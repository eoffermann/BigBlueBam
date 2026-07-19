import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { env } from '../env.js';

// Bulwark live-ingest dispatch (Bulwark spec §6). bolt-api is the event hub; every ingested
// event is checked against the receiving org's per-binding dispatch gate and, if admitted,
// POSTed to bulwark-api's durable inbox at /v1/internal/events (THEME G: container-internal
// target http://bulwark-api:4021, and the /v1 PREFIX IS REQUIRED - Braid once shipped a live
// 404 by dropping it).
//
// Fire-and-forget from the caller's perspective: a dropped dispatch is recovered for
// state-reflecting bindings by bulwark-state-reconcile, and for all bindings the durable inbox
// + the radar pending-drain make a successful POST durable. A genuinely transient binding lost
// on this hop is Open Question 1 (a bolt-api sending-end outbox is the future closure).
//
// The per-org gate `bulwark:bindings:<org_id>` is a CACHE over bulwark_obligations, rebuilt by
// bulwark-api at boot + on the state-reconcile cadence. We treat a MISSING gate key as
// fail-OPEN (forward) so a cold cache never silently drops every event; only a present gate
// that lacks this binding skips. The inbox dedups and only armed obligations match, so a
// spurious forward is cheap.

// The id-typed scoping fields we lift from an event payload into the inbox row's scope_fields.
// entity_filter.payload_path is allowlisted to these id-typed fields (SM1); the ingest service
// re-validates each value is uuid-shaped and drops non-conforming ones.
const SCOPE_PATHS = [
  'task.project_id',
  'task.id',
  'project.id',
  'project_id',
  'contract.id',
  'invoice.id',
  'invoice.project_id',
  'company.id',
  'deal.id',
] as const;

function nested(payload: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = payload;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function extractScopeFields(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of SCOPE_PATHS) {
    const v = nested(payload, path);
    if (typeof v === 'string' && v.length > 0) {
      out[path] = v;
      // Also key by the last segment so a filter authored against e.g. `project_id` resolves.
      const seg = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path;
      if (!(seg in out)) out[seg] = v;
    }
  }
  return out;
}

function bulwarkInternalUrl(): string {
  const fromEnv = (env.BULWARK_API_INTERNAL_URL ?? '').trim();
  return (fromEnv || 'http://bulwark-api:4021').replace(/\/+$/, '');
}

// Returns true when the org's gate admits (or is cold/missing). Never throws.
async function gateAdmits(
  redis: Redis,
  orgId: string,
  source: string,
  eventType: string,
): Promise<boolean> {
  try {
    const key = `bulwark:bindings:${orgId}`;
    const exists = await redis.exists(key);
    if (exists === 0) return true; // cold cache: fail open (bulwark-api rebuild self-heals)
    const member = await redis.sismember(key, `${source}:${eventType}`);
    return member === 1;
  } catch {
    return true; // Redis hiccup: fail open; the inbox + reconcile are the durability layers
  }
}

export async function dispatchToBulwark(
  redis: Redis,
  event: {
    orgId: string;
    eventId?: string;
    source: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
  logger: FastifyBaseLogger,
): Promise<void> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return; // fail-closed: bulwark /internal/events requires the shared secret

  if (!(await gateAdmits(redis, event.orgId, event.source, event.eventType))) return;

  // Prefer a stable upstream payload _event_id for inbox dedup; else the bolt event id.
  const payloadEventId =
    typeof event.payload._event_id === 'string' ? event.payload._event_id : undefined;
  const triggerAt =
    typeof event.payload.trigger_at === 'string'
      ? event.payload.trigger_at
      : typeof event.payload.occurred_at === 'string'
        ? (event.payload.occurred_at as string)
        : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${bulwarkInternalUrl()}/v1/internal/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify({
        org_id: event.orgId,
        source: event.source,
        event_type: event.eventType,
        bolt_event_id: event.eventId ?? null,
        source_idempotency_key: payloadEventId,
        logged_at: new Date().toISOString(),
        trigger_at: triggerAt,
        scope_fields: extractScopeFields(event.payload),
      }),
    });
  } catch {
    // Swallowed: bulwark-state-reconcile (state-reflecting bindings) + the durable inbox are the
    // recovery layers; a transient-only binding lost here is Open Question 1.
    void logger;
  } finally {
    clearTimeout(timer);
  }
}
