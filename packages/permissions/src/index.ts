// Public API. The Fastify plugin lives here; the resolver and cache are
// re-exported for service-layer consumers (e.g. apps/api fetches the
// PermissionContext from postgres and calls resolve() directly to mint
// the cached payload).

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  KEY_PROJECT_RESTRICTED,
  checkKeyProjectAccess,
  isKeyProjectRestricted,
  keyProjectAllowsRequest,
} from '@bigbluebam/auth-core';

import { resolve, can } from './resolver.js';
import { PermissionsCache, CACHE_KEYS, DEFAULT_TTL_SECONDS, INVALIDATION_CHANNELS } from './cache.js';
import type {
  AccountGroupMembership,
  AccountPermissionRow,
  AuthSubject,
  Decision,
  PermissionContext,
  PermissionScope,
  ResolveResult,
  ScopeType,
} from './types.js';

export {
  resolve,
  can,
  PermissionsCache,
  CACHE_KEYS,
  DEFAULT_TTL_SECONDS,
  INVALIDATION_CHANNELS,
};
export type {
  AccountGroupMembership,
  AccountPermissionRow,
  AuthSubject,
  Decision,
  PermissionContext,
  PermissionScope,
  ResolveResult,
  ScopeType,
};

export {
  PERMISSIONS,
  PERMISSIONS_BY_ID,
  ALWAYS_PERMITTED,
  TOOL_TO_PERMISSION,
  ROUTE_TO_PERMISSION,
  type PermissionId,
  type PermissionMeta,
} from './generated/permissions.js';

// ─────────────────────────────────────────────────────────────────────
// Fastify plugin: requireCan(permissionId) middleware
// ─────────────────────────────────────────────────────────────────────
//
// Wave A wires this in at default-off (mode='off') so behavior is
// unchanged. Wave B flips it to 'warn' (dual-read with divergence log).
// Wave C flips it to 'on' (new resolver is canonical).
//
// The plugin expects a contextLoader to be supplied by the host app —
// apps/api implements one that fetches the PermissionContext from
// postgres + cache. Other apps either reuse this loader by calling
// /b3/api/permissions/context (proxied) or implement their own.

export type EnforcementMode = 'off' | 'warn' | 'on';

export interface PermissionsPluginOptions {
  mode: EnforcementMode;
  /** Loads (and caches) the PermissionContext for the current request. */
  contextLoader: (request: FastifyRequest) => Promise<PermissionContext | null>;
  /** Pulls the scope out of the request — typically reads X-Org-Id / params. */
  scopeLoader?: (request: FastifyRequest) => PermissionScope;
  /**
   * Reports a divergence between the legacy gate and the new resolver.
   * Wave B uses this to populate the SuperUser dashboard. The legacy
   * decision is supplied by route handlers via request.legacyDecision
   * before the gate fires; if absent, no divergence is reported.
   */
  reportDivergence?: (event: {
    permission_id: string;
    request: FastifyRequest;
    legacy: Decision | undefined;
    resolved: ResolveResult;
  }) => void;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Result of the most recent permission check on this request. */
    permissionsResolution?: ResolveResult;
    /**
     * Optional legacy-gate decision a route handler set just before
     * calling requireCan. Wave B reads this for divergence telemetry.
     */
    legacyPermissionDecision?: Decision;
  }
}

// ─────────────────────────────────────────────────────────────────────
// API key project restriction (#352)
// ─────────────────────────────────────────────────────────────────────
//
// An API key minted with project_ids may act only inside those projects. The rule is
// @bigbluebam/auth-core's; requireCan and canResolve apply it in EVERY enforcement mode,
// including 'off' and 'warn', because it is a property of the credential, not of the role
// matrix being rolled out. A check whose project is unknown (org-wide or non-project
// permission) refuses a restricted key: the restriction fails closed.

/** 403 when a project-restricted key is outside its projects; undefined when admitted. */
function enforceKeyProject(
  request: FastifyRequest,
  reply: FastifyReply,
  permissionId: string,
  projectId: string | null | undefined,
) {
  if (!isKeyProjectRestricted(request) || checkKeyProjectAccess(request, projectId)) return undefined;
  return reply.code(403).send({
    error: {
      code: KEY_PROJECT_RESTRICTED,
      message: `This API key is restricted to specific projects and cannot use ${permissionId} here`,
      details: [{ permission_id: permissionId, project_id: projectId ?? null }],
    },
  });
}

export const permissionsPlugin = fp<PermissionsPluginOptions>(
  async (fastify: FastifyInstance, opts) => {
    const projectOf = (request: FastifyRequest, scope?: PermissionScope) =>
      (scope ?? (opts.scopeLoader ? opts.scopeLoader(request) : { org_id: null })).project_id ?? null;

    if (opts.mode === 'off') {
      // Wave A default. requireCan still mounts but every role check resolves
      // to ALLOW so the plugin acts as a measurement-only no-op until
      // mode flips to 'warn' or 'on'. The API key project restriction (#352)
      // still applies.
      fastify.decorate('requireCan', (permissionId: string) => {
        return async (request: FastifyRequest, reply: FastifyReply) =>
          enforceKeyProject(request, reply, permissionId, projectOf(request));
      });
      fastify.decorate(
        'canResolve',
        async (request: FastifyRequest, _permissionId: string, scope?: PermissionScope) =>
          keyProjectAllowsRequest(request, projectOf(request, scope)),
      );
      return;
    }

    fastify.decorate(
      'requireCan',
      (permissionId: string) =>
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
          const refused = enforceKeyProject(request, reply, permissionId, projectOf(request));
          if (refused) return refused;
          const ctx = await opts.contextLoader(request);

          // Warn mode is 100% non-blocking: if context can't load (e.g.
          // unauthenticated request reaching a route that doesn't require
          // auth, or contextLoader returning null), record nothing and
          // return. The legacy gate is canonical at this stage.
          if (!ctx) {
            if (opts.mode === 'on') {
              return reply.code(401).send({
                error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
              });
            }
            return;
          }
          const scope = opts.scopeLoader
            ? opts.scopeLoader(request)
            : { org_id: null };
          const result = resolve(ctx, permissionId, scope);
          request.permissionsResolution = result;

          if (opts.mode === 'warn') {
            // Don't enforce; just log if a legacy decision was supplied.
            if (opts.reportDivergence) {
              opts.reportDivergence({
                permission_id: permissionId,
                request,
                legacy: request.legacyPermissionDecision,
                resolved: result,
              });
            }
            return;
          }

          // mode === 'on'
          if (result.decision === 'deny') {
            // Return the reply so Fastify knows the response is done; otherwise
            // a stray FST_ERR_REP_ALREADY_SENT warning fires when the route's
            // own handler runs after this preHandler.
            return reply.code(403).send({
              error: {
                code: 'PERMISSION_DENIED',
                message: `Permission denied: ${permissionId}`,
                details: [{ permission_id: permissionId, reason: result.reason }],
              },
            });
          }
        },
    );

    fastify.decorate(
      'canResolve',
      async (
        request: FastifyRequest,
        permissionId: string,
        scope?: PermissionScope,
      ): Promise<boolean> => {
        const finalScope = scope ?? (opts.scopeLoader ? opts.scopeLoader(request) : { org_id: null });
        if (!keyProjectAllowsRequest(request, finalScope.project_id)) return false;
        const ctx = await opts.contextLoader(request);
        if (!ctx) return false;
        return can(ctx, permissionId, finalScope);
      },
    );
  },
  {
    name: '@bigbluebam/permissions',
    fastify: '5.x',
  },
);

declare module 'fastify' {
  interface FastifyInstance {
    requireCan(
      permissionId: string,
    ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    canResolve(
      request: FastifyRequest,
      permissionId: string,
      scope?: PermissionScope,
    ): Promise<boolean>;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Satellite plugin: HTTP-backed requireCan
// ─────────────────────────────────────────────────────────────────────
//
// Wave D Phase 3. Satellite apis (banter, bond, etc.) don't carry their
// own permissions DB schemas; instead they POST to apps/api's
// /internal/permissions/dual-read endpoint, which loads the context,
// runs the resolver, and writes the divergence row.
//
// Mirrors the MCP wrapper pattern from apps/mcp-server/src/lib/register
// -tool.ts:checkPermissionViaResolver — same endpoint, same internal-
// secret auth, same pass-through-on-error semantics.

export interface HttpPermissionsPluginOptions {
  mode: EnforcementMode;
  /** apps/api internal URL, e.g. 'http://api:4000'. */
  apiInternalUrl: string;
  /** Shared INTERNAL_SERVICE_SECRET. */
  internalSecret: string;
  /** Pull `user_id` and (optional) `org_id` out of the request. */
  getCaller: (request: FastifyRequest) => { user_id: string | null; org_id?: string | null };
  /** Optional: extract project_id for project-scoped checks. */
  getProjectId?: (request: FastifyRequest) => string | null;
  /**
   * What to do when the resolver returns no usable decision: a non-2xx response, a
   * malformed body, or a thrown fetch (connection refused, DNS failure, timeout).
   *
   * `'allow'` (the DEFAULT, and the historical behavior of this plugin) passes the
   * request through to the route handler. Every satellite that sits behind a legacy
   * `requireAuth` plus org-role gate relies on that gate as the real boundary, so a
   * resolver outage degrades to the pre-permissions posture rather than to a
   * suite-wide outage.
   *
   * `'deny'` returns 403 instead. Set this on any app where `requireCan` is the ONLY
   * gate in front of the data, because there `'allow'` turns a resolver outage into a
   * grant. burn-api is the first such app: it fronts per-person compensation and
   * per-client margin with no legacy role gate behind it (issue #89).
   */
  onUnknown?: 'allow' | 'deny';
  /** Resolver round-trip budget in ms; see HttpResolverOptions.timeoutMs (issue #183). */
  timeoutMs?: number;
}

export interface HttpResolverOptions {
  /** apps/api internal URL, e.g. 'http://api:4000'. */
  apiInternalUrl: string;
  /** Shared INTERNAL_SERVICE_SECRET. */
  internalSecret: string;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Budget for one resolver round trip (request plus response body), in ms
   * (issue #183). Past it the decision is 'unknown', which each caller maps
   * through its own onUnknown (fail closed under 'deny'). Defaults to
   * BBB_PERMISSIONS_RESOLVER_TIMEOUT_MS when set, else 3000.
   */
  timeoutMs?: number;
}

/** Default resolver budget when neither the option nor the env var is set. */
export const DEFAULT_RESOLVER_TIMEOUT_MS = 3000;

function resolverTimeoutMs(opts: HttpResolverOptions): number {
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) return opts.timeoutMs;
  const fromEnv = Number(process.env.BBB_PERMISSIONS_RESOLVER_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RESOLVER_TIMEOUT_MS;
}

/**
 * One POST to apps/api's /internal/permissions/dual-read. This is the single
 * place a satellite asks the resolver for a decision: the HTTP plugin's
 * requireCan and non-HTTP surfaces (the Bureau WebSocket hub, issue #166) both
 * call it, so a REST route and its realtime twin cannot disagree on how a
 * decision is fetched. 'unknown' means no usable answer (non-2xx, malformed
 * body, a thrown fetch, or no answer within the timeout); each caller decides
 * what unknown means for it.
 *
 * Issue #183: the round trip is bounded. Without a deadline, an api that
 * accepts the connection but never answers held the caller for undici's
 * defaults (minutes). The abort signal cancels the request, and the race below
 * settles even if a fetch implementation ignores the signal.
 */
export async function resolveViaHttp(
  opts: HttpResolverOptions,
  userId: string,
  permissionId: string,
  scope: { org_id: string | null; project_id: string | null },
  logger?: { warn: (obj: object, msg: string) => void },
): Promise<'allow' | 'deny' | 'unknown'> {
  const timeoutMs = resolverTimeoutMs(opts);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`permissions resolver did not answer within ${timeoutMs} ms`);
      err.name = 'TimeoutError';
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  const roundTrip = (async (): Promise<'allow' | 'deny' | 'unknown'> => {
    const res = await (opts.fetchImpl ?? fetch)(
      opts.apiInternalUrl.replace(/\/$/, '') + '/internal/permissions/dual-read',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': opts.internalSecret,
        },
        body: JSON.stringify({
          user_id: userId,
          permission_id: permissionId,
          agent_policy_decision: 'allow',
          scope,
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { data?: { decision?: string } };
    const d = json?.data?.decision;
    if (d === 'allow' || d === 'deny') return d;
    return 'unknown';
  })();
  // A late rejection from the abandoned round trip must not surface as unhandled.
  roundTrip.catch(() => undefined);
  try {
    return await Promise.race([roundTrip, deadline]);
  } catch (err) {
    logger?.warn({ err, permissionId, timeout_ms: timeoutMs }, 'permissions: resolver POST failed');
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

export interface HttpPermissionCheckerOptions extends HttpResolverOptions {
  mode: EnforcementMode;
  /** Same meaning as HttpPermissionsPluginOptions.onUnknown. */
  onUnknown: 'allow' | 'deny';
  /** How long one decision is reused, per (user, org, permission). Default 30s. */
  cacheTtlMs?: number;
  /** Most decisions kept; past it the least recently used entry is evicted. Default 5000. */
  maxCacheEntries?: number;
  /** Test seam for the cache clock. */
  now?: () => number;
}

/**
 * A boolean permission probe for code paths with no Fastify request/reply,
 * e.g. WebSocket frames. Applies the same enforcement mode semantics as
 * requireCan: 'off' and 'warn' always allow ('warn' still calls the resolver
 * so divergence is recorded), 'on' allows only an explicit allow (or unknown
 * under onUnknown: 'allow'). Decisions are memoized briefly so a chatty
 * socket does not POST to the api on every frame.
 *
 * Issue #183: concurrent misses for the same (user, org, permission) share one
 * in-flight POST, so a stalled api sees one request per key rather than one per
 * frame; and the cache evicts its least recently used entry at the size cap
 * instead of dropping every cached decision at once.
 */
export function createHttpPermissionChecker(opts: HttpPermissionCheckerOptions) {
  const ttl = opts.cacheTtlMs ?? 30_000;
  const maxEntries = Math.max(1, opts.maxCacheEntries ?? 5000);
  const now = opts.now ?? Date.now;
  // Map iteration order is insertion order; a hit is re-inserted, so the first
  // key is always the least recently used one.
  const cache = new Map<string, { allowed: boolean; expires: number }>();
  const inFlight = new Map<string, Promise<'allow' | 'deny' | 'unknown'>>();

  function remember(key: string, allowed: boolean): void {
    cache.delete(key);
    cache.set(key, { allowed, expires: now() + ttl });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return async function check(
    caller: { user_id: string; org_id: string | null },
    permissionId: string,
    logger?: { warn: (obj: object, msg: string) => void },
  ): Promise<boolean> {
    if (opts.mode === 'off') return true;
    const key = `${caller.user_id}|${caller.org_id ?? ''}|${permissionId}`;
    const hit = cache.get(key);
    if (hit) {
      if (hit.expires > now()) {
        cache.delete(key);
        cache.set(key, hit);
        return hit.allowed;
      }
      cache.delete(key);
    }
    let pending = inFlight.get(key);
    if (!pending) {
      pending = resolveViaHttp(
        opts,
        caller.user_id,
        permissionId,
        { org_id: caller.org_id, project_id: null },
        logger,
      ).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const decision = await pending;
    if (opts.mode === 'warn') return true;
    const allowed = decision === 'allow' || (decision === 'unknown' && opts.onUnknown === 'allow');
    // Do not pin a transient resolver failure for the whole TTL.
    if (decision !== 'unknown') remember(key, allowed);
    return allowed;
  };
}

export const httpPermissionsPlugin = fp<HttpPermissionsPluginOptions>(
  async (fastify: FastifyInstance, opts) => {
    const projectOf = (request: FastifyRequest) => (opts.getProjectId ? opts.getProjectId(request) : null);

    if (opts.mode === 'off') {
      // Role checks are off; the API key project restriction (#352) still applies.
      fastify.decorate('requireCan', (permissionId: string) => {
        return async (request: FastifyRequest, reply: FastifyReply) =>
          enforceKeyProject(request, reply, permissionId, projectOf(request));
      });
      fastify.decorate(
        'canResolve',
        async (request: FastifyRequest, _permissionId: string, scope?: PermissionScope) =>
          keyProjectAllowsRequest(request, scope ? scope.project_id : projectOf(request)),
      );
      return;
    }

    // Default 'allow' preserves the historical pass-through-on-error behavior for the
    // 21 satellites that do not pass this option.
    const onUnknown: 'allow' | 'deny' = opts.onUnknown ?? 'allow';

    async function callResolver(
      userId: string,
      permissionId: string,
      scope: { org_id: string | null; project_id: string | null },
      logger: { warn: (obj: object, msg: string) => void },
    ): Promise<'allow' | 'deny' | 'unknown'> {
      return resolveViaHttp(opts, userId, permissionId, scope, {
        warn: (obj, _msg) =>
          logger.warn(
            { ...obj, on_unknown: onUnknown },
            onUnknown === 'deny'
              ? 'httpPermissionsPlugin: resolver POST failed; failing closed'
              : 'httpPermissionsPlugin: resolver POST failed; pass-through',
          ),
      });
    }

    fastify.decorate(
      'requireCan',
      (permissionId: string) =>
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
          const refused = enforceKeyProject(request, reply, permissionId, projectOf(request));
          if (refused) return refused;
          const caller = opts.getCaller(request);
          // Unauthenticated → can't resolve. In 'on' mode the legacy
          // requireAuth gate should have already rejected; if it didn't,
          // fail closed.
          if (!caller.user_id) {
            if (opts.mode === 'on') {
              return reply.code(401).send({
                error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
              });
            }
            return;
          }
          const scope = {
            org_id: caller.org_id ?? null,
            project_id: opts.getProjectId ? opts.getProjectId(request) : null,
          };
          const decision = await callResolver(caller.user_id, permissionId, scope, request.log as { warn: (obj: object, msg: string) => void });
          if (opts.mode === 'warn') return; // resolver call already recorded divergence
          // 'unknown' means the resolver gave us no usable answer. Under
          // onUnknown: 'deny' that is a 403, not a pass: see the option docs.
          if (decision === 'deny' || (decision === 'unknown' && onUnknown === 'deny')) {
            // Return the reply so Fastify knows the response is done; otherwise
            // a stray FST_ERR_REP_ALREADY_SENT warning fires when the route's
            // own handler runs after this preHandler.
            return reply.code(403).send({
              error: {
                code: 'PERMISSION_DENIED',
                message: `Permission denied: ${permissionId}`,
                details: [{ permission_id: permissionId }],
              },
            });
          }
        },
    );

    fastify.decorate(
      'canResolve',
      async (
        request: FastifyRequest,
        _permissionId: string,
        scope?: PermissionScope,
      ): Promise<boolean> => {
        // The HTTP plugin doesn't expose a synchronous probe today. Callers
        // that need this can either issue a full requireCan check or query
        // the api directly. For Wave D satellites this isn't on a hot path.
        // The API key project restriction (#352) is still answered here.
        return keyProjectAllowsRequest(request, scope ? scope.project_id : projectOf(request));
      },
    );
  },
  {
    name: '@bigbluebam/permissions:http',
    fastify: '5.x',
  },
);

/** Telemetry-only wrapper for routes that had no legacy gate.
 *  Wave E.E note: dualReadGate has been removed — Waves E.A/E.B replaced
 *  every call site with bare `fastify.requireCan(...)`. */
export function shadowOnly(permission: string): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function shadowHandler(request: FastifyRequest, _reply: FastifyReply) {
    request.legacyPermissionDecision = 'allow';
    const fi = request.server as FastifyInstance;
    // Telemetry only — must NEVER block the request. The previous
    // implementation delegated to requireCan(), whose deny path SENDS a
    // 403 reply (it does not throw), so every "shadow" gate silently
    // became enforcing for any permission the matrix resolves to deny
    // (e.g. bam.org_member.list for plain members → empty DM rosters).
    // canResolve is the pure decision probe: it never touches the reply.
    if (typeof fi.canResolve !== 'function') return;
    try {
      const allowed = await fi.canResolve(request, permission);
      if (!allowed) {
        request.log.warn(
          { permission },
          'shadowOnly: resolver would deny (telemetry only, not enforced)',
        );
      }
    } catch (err) {
      request.log.warn({ err, permission }, 'shadowOnly: resolver threw');
    }
  };
}
