// The subset of the authed user the service layer needs for per-viewer access decisions
// (spec 2.5). isAdmin gates the owner/admin read floors and the org-admin project-scope
// override.
export interface Viewer {
  id: string;
  org_id: string;
  role: string;
  is_superuser: boolean;
}

export function isAdminViewer(v: Viewer): boolean {
  return v.is_superuser === true || v.role === 'owner' || v.role === 'admin';
}

// Platform actor_type values reused on agent_proposals.proposer_kind and decider kind.
export type ActorKind = 'human' | 'agent' | 'service';

// The Bulwark System service-account user (spec 2.4 / 7). Used as the actor_id on direct
// agent_proposals inserts (proposer_kind='agent') so the HITL choke point has a real actor.
export const BULWARK_SYSTEM_USER_ID = '00000000-0000-0000-0000-0000000000b2';

// Proposal subject/action strings (spec 2.2 / 4.5).
export const BULWARK_NOTICE_SUBJECT = 'bulwark.notice_draft';
export const BULWARK_CHASE_SUBJECT = 'bulwark.compliance_chase';
export const BULWARK_SEND_NOTICE_ACTION = 'bulwark.send_notice';
export const BULWARK_CHASE_ACTION = 'bulwark.chase_compliance_doc';
