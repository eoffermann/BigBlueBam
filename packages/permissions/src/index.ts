// Public API. The Fastify plugin lives here; the resolver and cache are
// re-exported for service-layer consumers (e.g. apps/api fetches the
// PermissionContext from postgres and calls resolve() directly to mint
// the cached payload).

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { resolve, can } from './resolver.js';
import { PermissionsCache, CACHE_KEYS, DEFAULT_TTL_SECONDS } from './cache.js';
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
              reply.code(401).send({
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
            reply.code(403).send({
              error: {
                code: 'PERMISSION_DENIED',
                message: `Permission denied: ${permissionId}`,
                details: [{ permission_id: permissionId, reason: result.reason }],
              },
            });
            return;
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
