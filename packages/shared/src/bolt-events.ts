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
 * required for auth; empty string is allowed and sent as-is (ingest returns
 * 401 which is then swallowed by the outer try/catch).
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
  const timeoutMs = resolveBoltPublishTimeoutMs();
  try {
    const resolvedActorType: BoltActorType =
      actorType ?? (actorId ? 'user' : 'system');
    const url = `${resolveBoltUrl()}/v1/events/ingest`;
    const res = await fetch(url, {
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
    // Drain the body so the connection is released; a hung body read is bounded by
    // the same signal.
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    // Fire-and-forget. Do not break the source operation if Bolt is down. A timeout is
    // logged because it means bolt-api is accepting connections but not answering.
    if (isTimeoutError(err)) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'publishBoltEvent timed out; event dropped',
          event_type: eventType,
          source,
          org_id: orgId,
          timeout_ms: timeoutMs,
        }),
      );
    }
  }
}
