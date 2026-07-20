import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { env } from '../env.js';
import { BURSAR_SUBSCRIPTIONS, isBursarSubscribed, BURSAR_SUBSCRIPTION_COUNT } from './bursar-subscriptions.js';

// Re-export the pure subscription helpers (tests import them from the pure module to avoid env).
export { isBursarSubscribed, BURSAR_SUBSCRIPTION_COUNT };

/**
 * Bursar live-ingest dispatch (Bursar spec 16.2). bolt-api is the event hub; every ingested event
 * that Bursar subscribes to is checked against the receiving org's per-binding gate and, if
 * admitted, POSTed to bursar-api's durable inbox at /v1/internal/events (container-internal target
 * http://bursar-api:4023, and the /v1 PREFIX IS REQUIRED - the Bulwark and Braid cycles both
 * shipped a live 404 by dropping it).
 *
 * Bursar consumes bill expense.created / expense.approved into spend and braid profile.merged to
 * re-point braid_profile_id on its rows. invoice.paid / payment.recorded are excluded as money-in.
 *
 * Fire-and-forget: a dropped dispatch is recovered because every subscribed event corresponds to a
 * persistent source row that Bursar's reconcile passes re-observe, converging on the same live row.
 *
 * The per-org gate `bursar:bindings:<org_id>` is an ADVISORY cache over the durable bursar settings
 * shape. A MISSING gate key is fail-OPEN (forward) so a cold cache never silently drops every event;
 * only a present gate that lacks this binding skips. The durable inbox dedups on
 * (org, source_idempotency_key), so a spurious forward is cheap. It must NOT be hardened into a
 * two-phase commit (same warning the bulwark/burn gates carry).
 */

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

function bursarInternalUrl(): string {
  const fromEnv = (env.BURSAR_API_INTERNAL_URL ?? '').trim();
  return (fromEnv || 'http://bursar-api:4023').replace(/\/+$/, '');
}

// Returns true when the org's gate admits (or is cold/missing). Never throws.
async function gateAdmits(redis: Redis, orgId: string, source: string, eventType: string): Promise<boolean> {
  try {
    const key = `bursar:bindings:${orgId}`;
    const exists = await redis.exists(key);
    if (exists === 0) return true; // cold cache: fail open (bursar-api rebuild self-heals)
    const member = await redis.sismember(key, `${source}:${eventType}`);
    return member === 1;
  } catch {
    return true; // Redis hiccup: fail open; the inbox + reconcile are the durability layers
  }
}

export async function dispatchToBursar(
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
  // Only the subscribed types (spec 16.2). A chatty type an org does not bind is dropped here.
  if (!BURSAR_SUBSCRIPTIONS.has(`${event.source}:${event.eventType}`)) return;

  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return; // fail-closed: bursar /internal/events requires the shared secret

  if (!(await gateAdmits(redis, event.orgId, event.source, event.eventType))) return;

  const payloadEventId = typeof event.payload._event_id === 'string' ? event.payload._event_id : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${bursarInternalUrl()}/v1/internal/events`, {
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
    // Swallowed: Bursar's reconcile passes + the durable inbox are the recovery layers.
    void logger;
  } finally {
    clearTimeout(timer);
  }
}
