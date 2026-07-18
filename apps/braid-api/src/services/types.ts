import type { z } from 'zod';
import type {
  braidSetSurvivorshipRuleSchema,
  braidUpdateSettingsSchema,
  braidResolveInputSchema,
} from '@bigbluebam/shared';

// The subset of the authed user the service layer needs to make per-viewer access
// decisions (spec 2.5). isAdmin gates the full profile READ tier and email_suppressed.
export interface Viewer {
  id: string;
  org_id: string;
  role: string;
  is_superuser: boolean;
}

export function isAdminViewer(v: Viewer): boolean {
  return v.is_superuser === true || v.role === 'owner' || v.role === 'admin';
}

export type BraidSetSurvivorshipRuleInput = z.infer<typeof braidSetSurvivorshipRuleSchema>;
export type BraidUpdateSettingsInput = z.infer<typeof braidUpdateSettingsSchema>;
export type BraidResolveInput = z.infer<typeof braidResolveInputSchema>;

// The Braid System service-account user (seeded in migration 0230). Used as
// decided_by for decision_kind='auto' and as the actor for direct agent_proposals
// inserts (spec 2.2).
export const BRAID_SYSTEM_USER_ID = '00000000-0000-0000-0000-0000000000b1';

// Platform actor_type values reused on braid_merge_decisions.decided_by_kind.
export type ActorKind = 'human' | 'agent' | 'service';
