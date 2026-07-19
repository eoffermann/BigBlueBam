// Per-viewer visibility preflight client (AGENTIC_TODO §11).
//
// Every satellite service that serves cross-app data to a human asker MUST confirm the
// asker can actually see each cited source record before it renders or cites that record.
// The authoritative rules live in ONE place, apps/api/src/services/visibility.service.ts,
// behind the internal POST /internal/visibility/can-access route (service-secret auth).
// This module is the canonical CLIENT for that route.
//
// It was previously copy-pasted into basis-api, braid-api, and bulwark-api (three
// near-identical files that had already drifted apart in shape). Consolidated here for the
// same reason packages/storage consolidated the triplicated MinIO clients: a security
// primitive that is fail-closed in three separate copies is a primitive that will
// eventually be fail-OPEN in one of them. Do NOT re-fork this file into an app.
//
// SERVER-ONLY. This reads INTERNAL_SERVICE_SECRET from the process environment, so it must
// never reach a browser bundle. Exactly like bulwark-arm-key.ts, it is shipped as its own
// tsup entry + package.json subpath export and is deliberately NOT re-exported from
// src/index.ts, because a barrel re-export would drag it into every SPA build.
//
// ── FAIL-CLOSED CONTRACT (do not weaken) ────────────────────────────────────
// The ONLY result that grants access is an explicit `{"allowed": true}` in a 2xx response
// body. Every other outcome is a deny:
//   - missing / empty INTERNAL_SERVICE_SECRET (cannot authenticate, so cannot verify)
//   - non-2xx status (including 401/403/404/5xx)
//   - request timeout / abort
//   - transport error, unreachable upstream, or malformed JSON body
//   - a body whose `allowed` is anything other than boolean `true`
// A deny must never leak as an allow. Any future change here is a suite-wide security
// change: it silently re-grades visibility for basis, braid, bulwark, and every later
// consumer at once.

const DEFAULT_UPSTREAM_TIMEOUT_MS = 4000;

// Matches the identical `BBB_API_INTERNAL_URL` default in every consuming app's env.ts, so
// consolidating here is behaviour-preserving.
const DEFAULT_API_INTERNAL_URL = 'http://api:4000';

// Bounded fan-out: a large member list or decomposition must not stampede the preflight
// endpoint. Shared by preflightMany and by app-side wrappers built on it.
export const PREFLIGHT_CONCURRENCY = 8;

export interface VisibilityClientConfig {
  /** Base URL of the Bam API, e.g. http://api:4000. Trailing slashes are trimmed. */
  apiInternalUrl?: string;
  /** Shared internal-service secret. Absent or empty means fail closed. */
  internalServiceSecret?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Resolve effective config from an explicit override, falling back to the process
 * environment. Read at call time (not module load) so a test can set process.env and so
 * `dotenv/config` at the service entrypoint is always already applied.
 */
function resolveConfig(config?: VisibilityClientConfig) {
  return {
    apiInternalUrl:
      config?.apiInternalUrl ?? process.env.BBB_API_INTERNAL_URL ?? DEFAULT_API_INTERNAL_URL,
    internalServiceSecret: config?.internalServiceSecret ?? process.env.INTERNAL_SERVICE_SECRET,
    timeoutMs: config?.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
  };
}

/**
 * Ask the Bam API whether `askerUserId` may see `(entityType, entityId)`.
 *
 * Returns true ONLY on an explicit allow. See the fail-closed contract above: every other
 * outcome, including transport failure and a missing secret, returns false.
 */
export async function preflightAccess(
  askerUserId: string,
  entityType: string,
  entityId: string,
  config?: VisibilityClientConfig,
): Promise<boolean> {
  const { apiInternalUrl, internalServiceSecret, timeoutMs } = resolveConfig(config);
  if (!internalServiceSecret) return false; // no secret -> cannot verify -> fail closed

  const url = `${apiInternalUrl.replace(/\/+$/, '')}/internal/visibility/can-access`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalServiceSecret },
      body: JSON.stringify({
        asker_user_id: askerUserId,
        entity_type: entityType,
        entity_id: entityId,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { allowed?: boolean };
    return json.allowed === true;
  } catch {
    return false; // unreachable / aborted / malformed body -> fail closed
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Batched preflight for many ids of a SINGLE entity type. Returns the subset of
 * `entityIds` the asker may see; fail-closed, so anything not explicitly confirmed is
 * simply absent from the result.
 *
 * Ids are de-duplicated and fanned out at PREFLIGHT_CONCURRENCY at a time. Callers that
 * need per-entity-type batching group their ids by type and call this once per group.
 */
export async function preflightMany(
  askerUserId: string,
  entityType: string,
  entityIds: string[],
  config?: VisibilityClientConfig,
): Promise<Set<string>> {
  const visible = new Set<string>();
  const unique = [...new Set(entityIds)];
  for (let i = 0; i < unique.length; i += PREFLIGHT_CONCURRENCY) {
    const batch = unique.slice(i, i + PREFLIGHT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => ({
        id,
        ok: await preflightAccess(askerUserId, entityType, id, config),
      })),
    );
    for (const r of results) if (r.ok) visible.add(r.id);
  }
  return visible;
}
