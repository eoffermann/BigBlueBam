import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import type { BasisDefinition } from '@bigbluebam/shared';
import { canAccessEntity } from '../lib/can-access.client.js';

// Possibly-related-activity plane (spec 2.1 / 2.3). Separate from and ranked below
// the certified drivers: a per-viewer, access-scoped list of concrete cross-app
// events that MIGHT have contributed to a metric move. Sourced from the platform's
// v_activity_unified view, restricted to the metric's related_apps neighborhood and
// the compared window, then filtered through can_access so a viewer only ever sees
// activity on entities they are allowed to see. Never cached (it is per-viewer).
//
// This is a correlation AID, not causation: it makes no claim that the listed
// activity caused the change, only that it happened in the same window on related
// entities the viewer can access.

export interface CorrelationItem {
  source_app: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string | null;
  created_at: string;
}

interface Row {
  source_app: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string | null;
  created_at: string;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function buildCorrelation(
  orgId: string,
  def: BasisDefinition,
  period: { from: string; to: string },
  askerUserId: string | undefined,
  relatedApps: string[],
  limit = 8,
): Promise<CorrelationItem[]> {
  // No asker -> no access-scoped list can be built (fail closed).
  if (!askerUserId) return [];

  // The correlation neighborhood: the metric's own source product plus any
  // explicitly-registered related_apps. Empty neighborhood -> nothing to correlate.
  const apps = Array.from(new Set([def.source_product, ...relatedApps].filter(Boolean)));
  if (apps.length === 0) return [];

  // Pull recent candidate activity in the compared window from the neighborhood,
  // newest first, capped so a busy org cannot stampede the can_access preflight.
  const candidates = rows<Row>(
    await db.execute(sql`
      SELECT source_app, entity_type, entity_id::text AS entity_id, action,
             actor_id::text AS actor_id, created_at
      FROM v_activity_unified
      WHERE organization_id = ${orgId}
        AND source_app = ANY(${apps})
        AND created_at >= ${period.from}::timestamptz
        AND created_at <= ${period.to}::timestamptz
      ORDER BY created_at DESC
      LIMIT 60
    `),
  );

  // Access-scope each candidate; keep only what the asker can see. Bounded fan-out.
  const out: CorrelationItem[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < candidates.length && out.length < limit; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const checked = await Promise.all(
      batch.map(async (r) => ({
        r,
        ok: r.entity_id ? await canAccessEntity(askerUserId, r.entity_type, r.entity_id) : false,
      })),
    );
    for (const c of checked) {
      if (c.ok && out.length < limit) {
        out.push({
          source_app: c.r.source_app,
          entity_type: c.r.entity_type,
          entity_id: c.r.entity_id,
          action: c.r.action,
          actor_id: c.r.actor_id,
          created_at: c.r.created_at,
        });
      }
    }
  }
  return out;
}
