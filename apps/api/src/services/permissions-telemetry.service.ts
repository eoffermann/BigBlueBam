// Wave B telemetry. The dual-read wrapper writes one row per request to
// a sample-route during the soak; the SuperUser dashboard reads grouped
// counts. Writes are fire-and-forget — a write failure must never cause
// the operator's actual request to fail, since the legacy gate is still
// canonical at this stage.

import type { Decision, ResolveResult, ScopeType } from '@bigbluebam/permissions';

/**
 * Loose pino-like logger surface. We accept fastify.log directly without
 * forcing the caller to bridge FastifyBaseLogger -> Logger (msgPrefix
 * mismatch in pino's BaseLogger constraint).
 */
interface LoggerLike {
  warn(obj: unknown, msg?: string): void;
}
import { db } from '../db/index.js';
import { permissionsDivergenceLog } from '../db/schema/index.js';

interface RecordDivergenceArgs {
  request_id?: string;
  user_id: string | null;
  org_id: string | null;
  permission_id: string;
  scope_type: ScopeType;
  scope_id: string | null;
  legacy_decision: Decision | 'unknown';
  resolved: ResolveResult;
  route_method: string | null;
  route_path: string | null;
  logger?: LoggerLike;
}

export async function recordDivergence(args: RecordDivergenceArgs): Promise<void> {
  const isDivergent =
    args.legacy_decision !== 'unknown' && args.legacy_decision !== args.resolved.decision;

  // Pino structured log line — operator-readable and grep-able even when
  // the DB write is silently dropped (e.g. table is read-only during a
  // maintenance window).
  if (isDivergent) {
    args.logger?.warn(
      {
        event: 'permissions.divergence',
        permission_id: args.permission_id,
        legacy: args.legacy_decision,
        resolved: args.resolved.decision,
        reason: args.resolved.reason,
        scope_type: args.scope_type,
        scope_id: args.scope_id,
        route: args.route_method && args.route_path ? `${args.route_method} ${args.route_path}` : null,
        user_id: args.user_id,
        request_id: args.request_id,
      },
      'permissions.divergence',
    );
  }

  try {
    await db.insert(permissionsDivergenceLog).values({
      request_id: args.request_id ?? null,
      user_id: args.user_id,
      org_id: args.org_id,
      permission_id: args.permission_id,
      scope_type: args.scope_type,
      scope_id: args.scope_id,
      legacy_decision: args.legacy_decision,
      resolved_decision: args.resolved.decision,
      resolved_reason: args.resolved.reason,
      route_method: args.route_method,
      route_path: args.route_path,
      is_divergent: isDivergent,
    });
  } catch (err) {
    args.logger?.warn({ err }, 'permissions-telemetry: failed to insert divergence row (best-effort)');
  }
}
