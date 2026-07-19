import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  agentProposals,
  bulwarkComplianceDocs,
  bulwarkNoticeDeadlines,
} from '../db/schema/index.js';
import { env } from '../env.js';
import {
  approveAndSendNotice,
  executeSendNotice,
  approveAndSendChase,
  executeSendChase,
} from '../services/send.service.js';
import {
  BULWARK_SEND_NOTICE_ACTION,
  BULWARK_CHASE_ACTION,
} from '../services/types.js';

// The proposal.decided subscription (spec 2.2 / 2.4 / 5.4), mirroring braid-api.
//
// TRANSPORT: Bolt is an ingest hub, not a fan-out bus, so delivery is via the internal route
// POST /internal/proposal-decided (guarded by INTERNAL_SERVICE_SECRET), which bolt-api will
// POST for matching proposal.decided events. The handler is idempotent (the send executors are
// CAS-guarded), so at-least-once delivery is safe.
//
// Because register-tool.ts returns allowed:true for caller.kind==='human', the human-decider
// path must be INDEPENDENTLY permission-checked here: the decider is re-run through the §15
// bulwark.* kill switch AND asserted to hold the send permission BEFORE any truth flip. Any
// non-2xx or transport error fails closed (the draft is left for the reconcile sweep).

export interface ProposalDecidedEnvelope {
  event_type?: string;
  actor_id?: string;
  actor_type?: string; // 'user' | 'agent' | 'system'
  org_id?: string;
  payload: {
    proposal: {
      id: string;
      proposed_action: string;
      decision: 'approve' | 'reject' | 'request_revision';
      decision_reason?: string | null;
      approver_id?: string | null;
      actor_id?: string | null;
    };
    org?: { id?: string };
  };
}

export type ProposalDecidedResult =
  | { status: 'ignored'; reason: string }
  | { status: 'noop'; reason: string }
  | { status: 'sent'; subject_id: string }
  | { status: 'rejected'; subject_id: string };

async function deciderPassesKillSwitch(deciderId: string, tool: string): Promise<boolean> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return false;
  const url =
    `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/v1/agent-policies/` +
    `${encodeURIComponent(deciderId)}/check?tool=${encodeURIComponent(tool)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { allowed?: boolean } };
    return json.data?.allowed === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function deciderHoldsPermission(
  deciderId: string,
  orgId: string,
  permissionId: string,
): Promise<boolean> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return false;
  const url = `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/permissions/dual-read`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
        user_id: deciderId,
        permission_id: permissionId,
        agent_policy_decision: 'allow',
        scope: { org_id: orgId, project_id: null },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { decision?: string } };
    return json.data?.decision === 'allow';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleProposalDecided(
  envelope: ProposalDecidedEnvelope,
): Promise<ProposalDecidedResult> {
  const proposal = envelope.payload?.proposal;
  if (!proposal?.id) return { status: 'ignored', reason: 'no proposal in payload' };

  const isNotice = proposal.proposed_action === BULWARK_SEND_NOTICE_ACTION;
  const isChase = proposal.proposed_action === BULWARK_CHASE_ACTION;
  if (!isNotice && !isChase) return { status: 'ignored', reason: 'not a bulwark proposal' };

  const orgId = envelope.payload.org?.id ?? envelope.org_id;
  if (!orgId) return { status: 'ignored', reason: 'no org id' };

  // Re-SELECT the authoritative proposal (status + refs-only payload).
  const [prow] = await db
    .select({
      status: agentProposals.status,
      approver_id: agentProposals.approver_id,
      payload: agentProposals.proposed_payload,
    })
    .from(agentProposals)
    .where(eq(agentProposals.id, proposal.id))
    .limit(1);
  if (!prow) return { status: 'ignored', reason: 'proposal row missing' };

  const payload = (prow.payload ?? {}) as { bulwark_draft_id?: string };
  const draftId = payload.bulwark_draft_id;
  if (!draftId) return { status: 'ignored', reason: 'no draft id in payload' };

  const decision = proposal.decision;
  if (decision === 'request_revision') return { status: 'noop', reason: 'request_revision' };

  if (decision === 'approve' && prow.status !== 'approved')
    return { status: 'noop', reason: `status is ${prow.status}, not approved` };
  if (decision === 'reject' && prow.status !== 'rejected')
    return { status: 'noop', reason: `status is ${prow.status}, not rejected` };

  const decider = envelope.actor_id ?? proposal.actor_id ?? prow.approver_id ?? proposal.approver_id;
  if (!decider) return { status: 'noop', reason: 'no decider actor resolvable' };

  if (decision === 'reject') {
    if (isNotice) {
      await db
        .update(bulwarkNoticeDeadlines)
        .set({ notice_status: 'discarded', updated_at: new Date() })
        .where(eq(bulwarkNoticeDeadlines.id, draftId));
    } else {
      await db
        .update(bulwarkComplianceDocs)
        .set({ chase_status: 'none', chase_proposal_id: null, updated_at: new Date() })
        .where(eq(bulwarkComplianceDocs.id, draftId));
    }
    return { status: 'rejected', subject_id: draftId };
  }

  // approve: fail-closed decider checks BEFORE any send (spec 2.4).
  const sendTool = isNotice ? 'bulwark_draft_notice' : 'bulwark_chase_compliance';
  const sendPerm = isNotice ? 'bulwark.notice.draft' : 'bulwark.compliance.chase';
  const [killOk, holdsPerm] = await Promise.all([
    deciderPassesKillSwitch(decider, sendTool),
    deciderHoldsPermission(decider, orgId, sendPerm),
  ]);
  if (!killOk || !holdsPerm)
    return { status: 'noop', reason: 'decider failed policy/permission check; left pending' };

  if (isNotice) {
    // The subscription drives the CAS: move drafted/approved -> sent through the canonical
    // executor (the approve-and-send REST path and this echo converge on one CAS win).
    await approveAndSendNotice(orgId, draftId, decider).catch(async () => {
      await executeSendNotice(orgId, draftId, decider).catch(() => {});
    });
  } else {
    await approveAndSendChase(orgId, draftId, decider).catch(async () => {
      await executeSendChase(orgId, draftId, decider).catch(() => {});
    });
  }
  return { status: 'sent', subject_id: draftId };
}
