/**
 * Canonical publishBoltEvent for all BigBlueBam services.
 *
 * Fire-and-forget: never throws, never blocks the caller. If Bolt ingest is
 * unreachable the error is swallowed so the originating operation is not
 * affected.
 *
 * Event naming convention: pass the bare event name (e.g. `deal.rotting`,
 * not `bond.deal.rotting`) and supply the `source` app name as a separate
 * argument. The Bolt drift guard rejects prefixed event strings.
 *
 * Env lookup falls back across several keys so the single module works in
 * every service: BOLT_API_INTERNAL_URL is the canonical name, but the older
 * BOLT_API_URL is accepted for compatibility. INTERNAL_SERVICE_SECRET is
 * required for auth; empty string is allowed and sent as-is, and the 401 that
 * ingest returns is logged as a warning naming the variable (#248). Every
 * service that calls this must be given the variable in docker-compose.yml and
 * in scripts/deploy/shared/services.mjs (scripts/lib/internal-secret-wiring.test.mjs).
 */

export type BoltActorType = 'user' | 'agent' | 'system';

function resolveBoltUrl(): string {
  const envObj = (typeof process !== 'undefined' && process.env) || {};
  return (
    envObj.BOLT_API_INTERNAL_URL ||
    envObj.BOLT_API_URL ||
    'http://bolt-api:4006'
  );
}

function resolveInternalSecret(): string {
  const envObj = (typeof process !== 'undefined' && process.env) || {};
  return envObj.INTERNAL_SERVICE_SECRET || '';
}

/** Default publish timeout (issue #125). Override with BOLT_PUBLISH_TIMEOUT_MS. */
export const BOLT_PUBLISH_TIMEOUT_DEFAULT_MS = 5000;

/**
 * Upper bound on how long publishBoltEvent waits for bolt-api. Without it, a
 * bolt-api that accepts the connection and then hangs blocks every awaiting
 * caller (request handlers, worker jobs past their lease, sweep loops).
 */
export function resolveBoltPublishTimeoutMs(): number {
  const envObj = (typeof process !== 'undefined' && process.env) || {};
  const raw = Number(envObj.BOLT_PUBLISH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : BOLT_PUBLISH_TIMEOUT_DEFAULT_MS;
}

function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function publishBoltEvent(
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
  orgId: string,
  actorId?: string,
  actorType?: BoltActorType,
): Promise<void> {
  // Fire-and-forget over the one place the ingest request is built (issue #200). Never
  // throws, so the source operation is not broken if Bolt is down. A timeout is logged
  // because it means bolt-api is accepting connections but not answering.
  const outcome = await publishBoltEventChecked(eventType, source, payload, orgId, actorId, actorType);
  if (outcome.timedOut) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'publishBoltEvent timed out; event dropped',
        event_type: eventType,
        source,
        org_id: orgId,
        timeout_ms: outcome.timeoutMs,
      }),
    );
  } else if (outcome.status === 401) {
    // #248: a 401 here is a deployment fault, not a transient one: this service was not given
    // INTERNAL_SERVICE_SECRET (or was given a different one), so every event it publishes is
    // dropped. Say so, instead of swallowing it like a network blip.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'publishBoltEvent refused by bolt-api (401); check INTERNAL_SERVICE_SECRET on this service; event dropped',
        event_type: eventType,
        source,
        org_id: orgId,
        internal_service_secret_set: resolveInternalSecret().length > 0,
      }),
    );
  }
}

/** What publishBoltEventChecked reports: `ok` only for a 2xx from bolt-api ingest. */
export interface BoltPublishOutcome {
  ok: boolean;
  status: number | null;
  error?: string;
  /** True when the call was cut off by the publish timeout (bolt-api connected but silent). */
  timedOut?: boolean;
  /** The timeout that applied, reported with `timedOut`. */
  timeoutMs?: number;
}

/**
 * The same positional call as publishBoltEvent, for callers that own a durable retry (an
 * outbox): it never throws, but it reports whether bolt-api accepted the event, so the caller
 * can back off and retry instead of losing the event. The ONLY place the ingest request is
 * built: publishBoltEvent is a wrapper over it. check-bolt-catalog.mjs scans literal calls to
 * both (scripts/lib/bolt-publish-calls.mjs).
 */
export async function publishBoltEventChecked(
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
  orgId: string,
  actorId?: string,
  actorType?: BoltActorType,
): Promise<BoltPublishOutcome> {
  const timeoutMs = resolveBoltPublishTimeoutMs();
  try {
    const resolvedActorType: BoltActorType = actorType ?? (actorId ? 'user' : 'system');
    const res = await fetch(`${resolveBoltUrl()}/v1/events/ingest`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': resolveInternalSecret(),
      },
      body: JSON.stringify({
        event_type: eventType,
        source,
        payload,
        org_id: orgId,
        actor_id: actorId,
        actor_type: resolvedActorType,
      }),
    });
    // Drain the body so the connection is released; a hung body read is bounded by the same signal.
    await res.arrayBuffer().catch(() => undefined);
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `bolt-api ingest returned ${res.status}` };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { ok: false, status: null, error: `bolt-api ingest timed out after ${timeoutMs} ms`, timedOut: true, timeoutMs };
    }
    return { ok: false, status: null, error: (err as Error).message };
  }
}
