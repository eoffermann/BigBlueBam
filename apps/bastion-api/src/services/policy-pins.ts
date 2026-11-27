// Linking a policy to a control (spec 3.6, M7): pin the control's two policy checks to it through
// the ordinary propose and revise services, so the checks land as `proposed` with the same
// validation, audit and confirmation as any other check. Kept apart from policies.service.ts
// because the assertion services use the drizzle pool (and so the service env).

import { sql } from 'drizzle-orm';
import type { DbTx } from '../db/index.js';
import { NotFoundError } from '../lib/errors.js';
import { runInOrgScope } from '../plugins/rls.js';
import * as assertions from './assertions.service.js';
import type { Viewer } from './types.js';

/** What a pin did: the control it pinned (null when there was none to pick) and the new proposals. */
export interface PinResult {
  control_id: string | null;
  proposed: string[];
}

/**
 * The control a policy linked without a named control proves (#387): the single active control
 * with live policy checks (policy.attested / policy.current, proposed or confirmed) none of which
 * is pinned to an active policy. Null when there is none, or more than one (then a person names it).
 */
export async function unpinnedPolicyControl(tx: DbTx, orgId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT a.control_id
      FROM bastion_assertions a
      JOIN bastion_controls c ON c.id = a.control_id AND c.organization_id = a.organization_id
     WHERE a.organization_id = ${orgId} AND c.lifecycle = 'active' AND a.kind = 'probe'
       AND a.probe_key IN ('policy.attested', 'policy.current') AND a.review_status IN ('proposed', 'confirmed')
     GROUP BY a.control_id
    HAVING bool_and(NOT EXISTS (
             SELECT 1 FROM bastion_policies p
              WHERE p.organization_id = a.organization_id AND p.status = 'active' AND p.id::text = a.params->>'policy_id'))
     LIMIT 2`)) as unknown as Array<{ control_id: string }>;
  return rows.length === 1 ? String(rows[0]?.control_id) : null;
}

const STATEMENTS: Record<'policy.attested' | 'policy.current', string> = {
  'policy.attested': 'Everyone required has acknowledged the current version of this policy.',
  'policy.current': 'This policy is active, shared with everyone and reviewed within the year.',
};

/**
 * When a policy is linked to a control, pin that control's two policy checks to it: a live check
 * not yet pinned to this policy is revised (a superseding proposal), a missing one is proposed.
 * Everything lands as `proposed` for a person to confirm. With no control named, the one control
 * whose policy checks are pinned to no active policy is the target (unpinnedPolicyControl).
 *
 * #393: choosing the control, reading its live checks and writing the proposals are ONE
 * transaction under one per-org lock, so two links at the same moment serialize: the second sees
 * the first's pins (the control is no longer unpinned, or its live checks are the first's
 * proposals) instead of both revising the same check and forking it. The control row is also held
 * FOR UPDATE, so it cannot be retired between the choice and the write. Re-running a pin for the
 * same policy and control is a no-op (a check already pinned to this policy is left alone).
 */
export async function pinPolicyChecks(viewer: Viewer, controlId: string | null, policyId: string): Promise<PinResult> {
  return runInOrgScope(viewer.org_id, (tx) => pinPolicyChecksIn(tx, viewer, controlId, policyId));
}

async function pinPolicyChecksIn(tx: DbTx, viewer: Viewer, controlId: string | null, policyId: string): Promise<PinResult> {
  // One policy pin at a time per org: the unnamed-control choice reads every control's checks, so
  // a per-control lock alone could not stop two links both choosing the same control.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bastion_policy_pin:${viewer.org_id}`}, 0))`);
  const target = controlId ?? (await unpinnedPolicyControl(tx, viewer.org_id));
  if (!target) return { control_id: null, proposed: [] };
  const locked = (await tx.execute(sql`
    SELECT id FROM bastion_controls
     WHERE organization_id = ${viewer.org_id} AND id = ${target} AND lifecycle = 'active'
       FOR UPDATE`)) as unknown as Array<{ id: string }>;
  if (!locked[0]) throw new NotFoundError('We could not find that control, or it was retired.');
  const live = (await tx.execute(sql`
    SELECT DISTINCT ON (probe_key) id, probe_key, params FROM bastion_assertions
     WHERE organization_id = ${viewer.org_id} AND control_id = ${target} AND kind = 'probe'
       AND probe_key IN ('policy.attested', 'policy.current') AND review_status IN ('proposed', 'confirmed')
     ORDER BY probe_key, created_at DESC`)) as unknown as Array<{ id: string; probe_key: string; params: unknown }>;
  const out: string[] = [];
  for (const key of ['policy.attested', 'policy.current'] as const) {
    const cur = live.find((r) => r.probe_key === key);
    if (cur && paramsOf(cur.params).policy_id === policyId) continue;
    const r = cur
      ? await assertions.reviseAssertionIn(tx, viewer, String(cur.id), { params: { policy_id: policyId } })
      : await assertions.proposeAssertionIn(tx, viewer, target, { kind: 'probe', probe_key: key, params: { policy_id: policyId }, plain_statement: STATEMENTS[key] });
    out.push(String((r.data as { id: string }).id));
  }
  return { control_id: target, proposed: out };
}

/** jsonb read through drizzle's raw execute arrives as text (db/index.ts); parse it either way. */
function paramsOf(params: unknown): { policy_id?: string } {
  if (typeof params === 'string') {
    try {
      return (JSON.parse(params) ?? {}) as { policy_id?: string };
    } catch {
      return {};
    }
  }
  return (params ?? {}) as { policy_id?: string };
}
