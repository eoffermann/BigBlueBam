import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { env } from '../env.js';

/**
 * Burn live-ingest dispatch (Burn spec 8.3). bolt-api is the event hub; every ingested event that
 * Burn subscribes to is checked against the receiving org's per-binding gate and, if admitted,
 * POSTed to burn-api's durable inbox at /v1/internal/events (container-internal target
 * http://burn-api:4022, and the /v1 PREFIX IS REQUIRED - the Bulwark and Braid cycles both shipped
 * a live 404 by dropping it).
 *
 * Fire-and-forget: a dropped dispatch is recovered because every subscribed event corresponds to a
 * persistent source row and Burn's three reconcile passes (spec 2.3.2C / 8.3) re-observe it,
 * converging on the same live work-item row. Burn does not depend on a bolt-api sending-end outbox.
 *
 * The per-org gate `burn:bindings:<org_id>` is an ADVISORY cache over the durable burn_org_settings
 * shape (the gate.service.ts pattern the spec cites). A MISSING gate key is fail-OPEN (forward) so
 * a cold cache never silently drops every event; only a present gate that lacks this binding skips.
 * The durable inbox dedups on (org, source_idempotency_key), so a spurious forward is cheap. It
 * must NOT be hardened into a two-phase commit (same warning the bulwark gate carries).
 */

// The 16 subscribed (source, event_type) pairs (spec 8.3). banter:message.posted is a 17th,
// conditional on the per-org banter signal being enabled, gated by the per-org binding set.
const SUBSCRIPTIONS = new Set<string>([
  'bam:task.created',
  'bam:task.updated',
  'bam:task.moved',
  'bam:task.assigned',
  'bam:task.completed',
  'bam:sprint.completed',
  'helpdesk:ticket.created',
  'helpdesk:ticket.replied',
  'bill:invoice.created',
  'bill:invoice.finalized',
  'bill:recurring.invoice_generated',
  'bill:expense.created',
  'bill:expense.approved',
  'bill:rate.created',
  'bill:rate.updated',
  'bond:deal.won',
  // Conditional (spec 8.3): forwarded only when the org has the banter signal enabled, which the
  // per-org binding set expresses. Kept in the allowlist so a bound org receives it.
  'banter:message.posted',
]);

const SCOPE_PATHS = [
  'task.project_id',
  'task.id',
  'project.id',
  'project_id',
  'expense.id',
  'invoice.id',
  'invoice.project_id',
  'rate.id',
  'company.id',
  'deal.id',
  'actor.id',
] as const;

function nested(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const p of path.split('.')) {
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
      const seg = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path;
      if (!(seg in out)) out[seg] = v;
    }
  }
  if (typeof payload._event_id === 'string') out._event_id = payload._event_id;
  return out;
}

function burnInternalUrl(): string {
  const fromEnv = (env.BURN_API_INTERNAL_URL ?? '').trim();
  return (fromEnv || 'http://burn-api:4022').replace(/\/+$/, '');
}

// Returns true when the org's gate admits (or is cold/missing). Never throws.
async function gateAdmits(redis: Redis, orgId: string, source: string, eventType: string): Promise<boolean> {
  try {
    const key = `burn:bindings:${orgId}`;
    const exists = await redis.exists(key);
    if (exists === 0) return true; // cold cache: fail open (burn-api rebuild self-heals)
    const member = await redis.sismember(key, `${source}:${eventType}`);
    return member === 1;
  } catch {
    return true; // Redis hiccup: fail open; the inbox + reconcile are the durability layers
  }
}

export async function dispatchToBurn(
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
  // Only the subscribed types (spec 8.3). A chatty type an org does not bind is dropped here.
  if (!SUBSCRIPTIONS.has(`${event.source}:${event.eventType}`)) return;

  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return; // fail-closed: burn /internal/events requires the shared secret

  if (!(await gateAdmits(redis, event.orgId, event.source, event.eventType))) return;

  const payloadEventId = typeof event.payload._event_id === 'string' ? event.payload._event_id : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${burnInternalUrl()}/v1/internal/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify({
        organization_id: event.orgId,
        event: event.eventType,
        source: event.source,
        event_id: payloadEventId ?? event.eventId ?? null,
        payload: { ...event.payload, ...extractScopeFields(event.payload) },
      }),
    });
  } catch {
    // Swallowed: Burn's reconcile passes + the durable inbox are the recovery layers.
    void logger;
  } finally {
    clearTimeout(timer);
  }
}
