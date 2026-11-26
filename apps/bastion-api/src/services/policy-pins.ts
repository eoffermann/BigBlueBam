// Linking a policy to a control (spec 3.6, M7): pin the control's two policy checks to it through
// the ordinary propose and revise services, so the checks land as `proposed` with the same
// validation, audit and confirmation as any other check. Kept apart from policies.service.ts
// because the assertion services use the drizzle pool (and so the service env).

import { type EngineDeps, orgTx } from '../engine/context.js';
import * as assertions from './assertions.service.js';
import type { Viewer } from './types.js';

/**
 * When a policy is linked to a control, pin that control's two policy checks to it: a live check
 * not yet pinned to this policy is revised (a superseding proposal), a missing one is proposed.
 * Everything lands as `proposed` for a person to confirm.
 */
export async function pinPolicyChecks(sql: EngineDeps['sql'], viewer: Viewer, controlId: string, policyId: string): Promise<string[]> {
  const out: string[] = [];
  const live = await orgTx(sql, viewer.org_id, (tx) => tx`
    SELECT DISTINCT ON (probe_key) id, probe_key, params FROM bastion_assertions
     WHERE organization_id = ${viewer.org_id} AND control_id = ${controlId} AND kind = 'probe'
       AND probe_key IN ('policy.attested', 'policy.current') AND review_status IN ('proposed', 'confirmed')
     ORDER BY probe_key, created_at DESC`);
  const statements: Record<string, string> = {
    'policy.attested': 'Everyone required has acknowledged the current version of this policy.',
    'policy.current': 'This policy is active, shared with everyone and reviewed within the year.',
  };
  for (const key of ['policy.attested', 'policy.current'] as const) {
    const cur = live.find((r) => r.probe_key === key);
    if (cur && (cur.params as { policy_id?: string } | null)?.policy_id === policyId) continue;
    const r = cur
      ? await assertions.reviseAssertion(viewer, String(cur.id), { params: { policy_id: policyId } })
      : await assertions.proposeAssertion(viewer, controlId, { kind: 'probe', probe_key: key, params: { policy_id: policyId }, plain_statement: statements[key] as string });
    out.push(String((r.data as { id: string }).id));
  }
  return out;
}
