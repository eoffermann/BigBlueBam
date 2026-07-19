// Public API. The Fastify plugin lives here; the resolver and cache are
// re-exported for service-layer consumers (e.g. apps/api fetches the
// PermissionContext from postgres and calls resolve() directly to mint
// the cached payload).

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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

export const permissionsPlugin = fp<PermissionsPluginOptions>(
  async (fastify: FastifyInstance, opts) => {
    if (opts.mode === 'off') {
      // Wave A default. requireCan still mounts but every check resolves
      // to ALLOW so the plugin acts as a measurement-only no-op until
      // mode flips to 'warn' or 'on'.
      fastify.decorate('requireCan', (_permissionId: string) => {
        return async (_request: FastifyRequest, _reply: FastifyReply) => {
          // no-op
        };
      });
      fastify.decorate('canResolve', async () => true);
      return;
    }

    fastify.decorate(
      'requireCan',
      (permissionId: string) =>
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
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
        const ctx = await opts.contextLoader(request);
        if (!ctx) return false;
        const finalScope = scope ?? (opts.scopeLoader ? opts.scopeLoader(request) : { org_id: null });
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
}

export const httpPermissionsPlugin = fp<HttpPermissionsPluginOptions>(
  async (fastify: FastifyInstance, opts) => {
    if (opts.mode === 'off') {
      fastify.decorate('requireCan', (_permissionId: string) => {
        return async (_request: FastifyRequest, _reply: FastifyReply) => {
          // no-op
        };
      });
      fastify.decorate('canResolve', async () => true);
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
      try {
        const res = await fetch(
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
          },
        );
        if (!res.ok) return 'unknown';
        const json = (await res.json()) as { data?: { decision?: string } };
        const d = json?.data?.decision;
        if (d === 'allow' || d === 'deny') return d;
        return 'unknown';
      } catch (err) {
        logger.warn(
          { err, permissionId, on_unknown: onUnknown },
          onUnknown === 'deny'
            ? 'httpPermissionsPlugin: resolver POST failed; failing closed'
            : 'httpPermissionsPlugin: resolver POST failed; pass-through',
        );
        return 'unknown';
      }
    }

    fastify.decorate(
      'requireCan',
      (permissionId: string) =>
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
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
        _request: FastifyRequest,
        _permissionId: string,
        _scope?: PermissionScope,
      ): Promise<boolean> => {
        // The HTTP plugin doesn't expose a synchronous probe today. Callers
        // that need this can either issue a full requireCan check or query
        // the api directly. For Wave D satellites this isn't on a hot path.
        return true;
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
