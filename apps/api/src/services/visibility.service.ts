import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { projects } from '../db/schema/projects.js';
import { tasks } from '../db/schema/tasks.js';
import { sprints } from '../db/schema/sprints.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { resolveUserOrgRole } from './role-resolver.js';
import {
  helpdeskTicketsStub,
  bondDealsStub,
  bondContactsStub,
  bondCompaniesStub,
  briefDocumentsStub,
  briefCollaboratorsStub,
  beaconEntriesStub,
  blueprintDiagramsStub,
  blueprintNodesStub,
  banterChannelsStub,
  banterMessagesStub,
  banterChannelMembershipsStub,
  bearingGoalsStub,
  bearingKeyResultsStub,
  boardsStub,
  boardCollaboratorsStub,
  bookEventsStub,
  billInvoicesStub,
  blankFormsStub,
  boltAutomationsStub,
  binAssetsStub,
  binFoldersStub,
  bayAssetsStub,
  blipTrackedAppsStub,
  blipSavedViewsStub,
  billClientsStub,
  bookEventAttendeesStub,
  braidProfilesStub,
  braidIdentitiesStub,
  bulwarkContractsStub,
  bulwarkObligationsStub,
  bulwarkNoticeDeadlinesStub,
  burnEngagementsStub,
  burnEngagementProjectsStub,
  burnDeliverablesStub,
  billExpensesStub,
  bursarVendorsStub,
  bursarRequestsStub,
  bursarOffersStub,
  bursarAwardsStub,
  bursarMismatchesStub,
} from '../db/schema/peer-app-stubs/index.js';

/**
 * Visibility preflight service (AGENTIC_TODO §11, Wave 2).
 *
 * Decides whether a given asker user can see a given entity BEFORE an
 * agent surfaces it in a shared channel / reply. This intentionally
 * mirrors, but does not reuse, the per-app visibility predicates. An
 * agent running under its own service-account key reads the agent's
 * visibility, not the asker's, so the RLS / per-app filters in the
 * request pipeline are insufficient.
 *
 * Semantics:
 *  - Returns `{ allowed: true, reason: 'ok' }` when the asker can see
 *     the entity.
 *  - Returns `{ allowed: false, reason: '<specific>' }` otherwise.
 *  - `not_found` is returned both when the entity genuinely does not
 *     exist AND when the asker cannot see it for a cross-org reason
 *     that would leak existence (e.g. the entity lives in a different
 *     org). For within-org denials (no project membership, private
 *     document, owner gate) the reason is specific.
 *
 * Callers should treat every non-'ok' reason as "do not surface",
 * and should use the specific reason only for telemetry and for
 * deciding whether to escalate to a human asker.
 */

export type VisibilityEntityType =
  | 'bam.task'
  | 'bam.project'
  | 'bam.sprint'
  | 'helpdesk.ticket'
  | 'bond.deal'
  | 'bond.contact'
  | 'bond.company'
  | 'brief.document'
  | 'beacon.entry'
  | 'blueprint.diagram'
  | 'blueprint.node'
  // Banter Feed entity-type registration (banter-feed-design-document.md §16)
  | 'banter.message'
  | 'banter.channel'
  | 'bearing.goal'
  | 'bearing.kr'
  | 'board.board'
  | 'book.event'
  | 'bill.invoice'
  | 'blank.form'
  | 'bolt.rule'
  | 'bin.asset'
  | 'bin.folder'
  | 'bay.asset'
  // Blip telemetry entity-type registration (BigBlueBam_Blip_Design_Document.md §2)
  | 'blip.tracked_app'
  | 'blip.saved_view'
  // Braid person-source + golden-profile registration (APP_DESIGN_braid.md §2.5)
  | 'bill.client'
  | 'book.event_attendee'
  | 'braid.profile'
  | 'braid.identity'
  // Bulwark contract-obligation-monitor registration (APP_DESIGN_bulwark.md §2.5)
  | 'bulwark.contract'
  | 'bulwark.obligation'
  | 'bulwark.deadline'
  // Burn margin/envelope-attribution monitor registration (APP_DESIGN_burn.md 2.4 point 4)
  | 'burn.engagement'
  | 'burn.deliverable'
  // Bursar absence-detection / bid-leveling registration (APP_DESIGN_bursar.md §16.3).
  // bill.expense was missing platform-wide (only bill.invoice + bill.client existed), so
  // under treat-non-ok-as-deny every Bursar drift citation of an expense silently dropped.
  | 'bill.expense'
  | 'bursar.vendor'
  | 'bursar.request'
  | 'bursar.offer'
  | 'bursar.award'
  | 'bursar.mismatch';

export const SUPPORTED_ENTITY_TYPES: readonly VisibilityEntityType[] = [
  'bam.task',
  'bam.project',
  'bam.sprint',
  'helpdesk.ticket',
  'bond.deal',
  'bond.contact',
  'bond.company',
  'brief.document',
  'beacon.entry',
  'blueprint.diagram',
  'blueprint.node',
  // Banter Feed entity-type registration (banter-feed-design-document.md §16)
  'banter.message',
  'banter.channel',
  'bearing.goal',
  'bearing.kr',
  'board.board',
  'book.event',
  'bill.invoice',
  'blank.form',
  'bolt.rule',
  'bin.asset',
  'bin.folder',
  'bay.asset',
  // Blip telemetry entity-type registration (BigBlueBam_Blip_Design_Document.md §2)
  'blip.tracked_app',
  'blip.saved_view',
  // Braid person-source + golden-profile registration (APP_DESIGN_braid.md §2.5)
  'bill.client',
  'book.event_attendee',
  'braid.profile',
  'braid.identity',
  // Bulwark contract-obligation-monitor registration (APP_DESIGN_bulwark.md §2.5)
  'bulwark.contract',
  'bulwark.obligation',
  'bulwark.deadline',
  // Burn margin/envelope-attribution monitor registration (APP_DESIGN_burn.md 2.4 point 4)
  'burn.engagement',
  'burn.deliverable',
  // Bursar absence-detection / bid-leveling registration (APP_DESIGN_bursar.md §16.3)
  'bill.expense',
  'bursar.vendor',
  'bursar.request',
  'bursar.offer',
  'bursar.award',
  'bursar.mismatch',
] as const;

export type PreflightReason =
  | 'ok'
  | 'not_found'
  | 'cross_org'
  | 'not_project_member'
  | 'private_document_no_collaborator'
  | 'bond_restricted_role_not_owner'
  | 'beacon_private_not_owner'
  | 'beacon_project_not_member'
  | 'banter_not_channel_member'
  | 'board_private_no_collaborator'
  | 'bin_private_not_owner'
  | 'unsupported_entity_type';

export interface PreflightResult {
  allowed: boolean;
  reason: PreflightReason;
  entity_org_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AskerContext {
  id: string;
  org_id: string;
  role: string;
  is_superuser: boolean;
}

async function loadAsker(askerUserId: string): Promise<AskerContext | null> {
  const rows = await db
    .select({
      id: users.id,
      org_id: users.org_id,
      is_superuser: users.is_superuser,
    })
    .from(users)
    .where(eq(users.id, askerUserId))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  // Wave E.F: role is resolved from the user's home-org group membership.
  const role = (await resolveUserOrgRole(row.id, row.org_id)) ?? 'member';
  return {
    id: row.id,
    org_id: row.org_id,
    role,
    is_superuser: row.is_superuser,
  };
}

function isOrgAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

async function isProjectMember(
  projectId: string,
  askerUserId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.project_id, projectId),
        eq(projectMemberships.user_id, askerUserId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function getUserProjectIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.user_id, userId));
  return rows.map((r) => r.project_id);
}

// ---------------------------------------------------------------------------
// bam.project / bam.task / bam.sprint
// ---------------------------------------------------------------------------

async function preflightBamProject(
  asker: AskerContext,
  projectId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({ id: projects.id, org_id: projects.org_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const project = rows[0];
  if (!project) return { allowed: false, reason: 'not_found' };
  if (project.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' }; // cross-org - do not disclose
  }

  // Org admins/owners can see any project in their own org.
  if (isOrgAdmin(asker.role)) {
    return { allowed: true, reason: 'ok', entity_org_id: project.org_id };
  }

  const member = await isProjectMember(project.id, asker.id);
  if (!member) {
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: project.org_id,
    };
  }
  return { allowed: true, reason: 'ok', entity_org_id: project.org_id };
}

async function preflightBamTask(
  asker: AskerContext,
  taskId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: tasks.id,
      project_id: tasks.project_id,
      org_id: projects.org_id,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.project_id))
    .where(eq(tasks.id, taskId))
    .limit(1);

  const task = rows[0];
  if (!task) return { allowed: false, reason: 'not_found' };
  if (task.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (isOrgAdmin(asker.role)) {
    return { allowed: true, reason: 'ok', entity_org_id: task.org_id };
  }

  const member = await isProjectMember(task.project_id, asker.id);
  if (!member) {
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: task.org_id,
    };
  }
  return { allowed: true, reason: 'ok', entity_org_id: task.org_id };
}

async function preflightBamSprint(
  asker: AskerContext,
  sprintId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: sprints.id,
      project_id: sprints.project_id,
      org_id: projects.org_id,
    })
    .from(sprints)
    .innerJoin(projects, eq(projects.id, sprints.project_id))
    .where(eq(sprints.id, sprintId))
    .limit(1);

  const sprint = rows[0];
  if (!sprint) return { allowed: false, reason: 'not_found' };
  if (sprint.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (isOrgAdmin(asker.role)) {
    return { allowed: true, reason: 'ok', entity_org_id: sprint.org_id };
  }

  const member = await isProjectMember(sprint.project_id, asker.id);
  if (!member) {
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: sprint.org_id,
    };
  }
  return { allowed: true, reason: 'ok', entity_org_id: sprint.org_id };
}

// ---------------------------------------------------------------------------
// helpdesk.ticket
// ---------------------------------------------------------------------------
//
// A helpdesk ticket lives in an org via its associated project (when set) or
// via its helpdesk_user's home org. Ticket table itself has no org_id column
// (as of Wave 2) - we treat project membership as the canonical gate when
// project_id is set, and fall back to "any authed user in the asker's org"
// when project_id IS NULL (customer-originated ticket, no triage yet).

async function preflightHelpdeskTicket(
  asker: AskerContext,
  ticketId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: helpdeskTicketsStub.id,
      project_id: helpdeskTicketsStub.project_id,
    })
    .from(helpdeskTicketsStub)
    .where(eq(helpdeskTicketsStub.id, ticketId))
    .limit(1);

  const ticket = rows[0];
  if (!ticket) return { allowed: false, reason: 'not_found' };

  // No project association - fall back to "must be in the same org as the
  // helpdesk user's home org". In Wave 2 we approximate this by allowing any
  // authenticated caller within the Bam org, since tickets without a
  // project_id are by definition inbound customer tickets that the whole
  // support team can see. Cross-org isolation is enforced downstream by the
  // helpdesk-api's own filters; we err on the side of letting visibility
  // look "reachable" for triage agents.
  if (!ticket.project_id) {
    return { allowed: true, reason: 'ok', entity_org_id: asker.org_id };
  }

  // project_id is set: normal project-membership gate.
  const projectRows = await db
    .select({ id: projects.id, org_id: projects.org_id })
    .from(projects)
    .where(eq(projects.id, ticket.project_id))
    .limit(1);

  const project = projectRows[0];
  if (!project) return { allowed: false, reason: 'not_found' };
  if (project.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (isOrgAdmin(asker.role)) {
    return { allowed: true, reason: 'ok', entity_org_id: project.org_id };
  }

  const member = await isProjectMember(project.id, asker.id);
  if (!member) {
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: project.org_id,
    };
  }
  return { allowed: true, reason: 'ok', entity_org_id: project.org_id };
}

// ---------------------------------------------------------------------------
// bond.deal / bond.contact / bond.company
// ---------------------------------------------------------------------------
//
// Bond rule (mirroring the STRICTER list-endpoint filter - see pre-existing
// inconsistency noted in visibility-tools docs):
//  - Same-org is required.
//  - Role owner/admin: visible if same org.
//  - Role member/viewer: visible if same org AND owner_id === asker.id.
//     (bond.company has no owner_id, so only the org match gates it.)

function isBondRestrictedRole(role: string): boolean {
  return role === 'member' || role === 'viewer' || role === 'guest';
}

async function preflightBondDeal(
  asker: AskerContext,
  dealId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bondDealsStub.id,
      organization_id: bondDealsStub.organization_id,
      owner_id: bondDealsStub.owner_id,
      deleted_at: bondDealsStub.deleted_at,
    })
    .from(bondDealsStub)
    .where(eq(bondDealsStub.id, dealId))
    .limit(1);

  const deal = rows[0];
  if (!deal || deal.deleted_at) return { allowed: false, reason: 'not_found' };
  if (deal.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (isBondRestrictedRole(asker.role) && deal.owner_id !== asker.id) {
    return {
      allowed: false,
      reason: 'bond_restricted_role_not_owner',
      entity_org_id: deal.organization_id,
    };
  }
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: deal.organization_id,
  };
}

async function preflightBondContact(
  asker: AskerContext,
  contactId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bondContactsStub.id,
      organization_id: bondContactsStub.organization_id,
      owner_id: bondContactsStub.owner_id,
      deleted_at: bondContactsStub.deleted_at,
    })
    .from(bondContactsStub)
    .where(eq(bondContactsStub.id, contactId))
    .limit(1);

  const contact = rows[0];
  if (!contact || contact.deleted_at) {
    return { allowed: false, reason: 'not_found' };
  }
  if (contact.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (isBondRestrictedRole(asker.role) && contact.owner_id !== asker.id) {
    return {
      allowed: false,
      reason: 'bond_restricted_role_not_owner',
      entity_org_id: contact.organization_id,
    };
  }
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: contact.organization_id,
  };
}

async function preflightBondCompany(
  asker: AskerContext,
  companyId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bondCompaniesStub.id,
      organization_id: bondCompaniesStub.organization_id,
      deleted_at: bondCompaniesStub.deleted_at,
    })
    .from(bondCompaniesStub)
    .where(eq(bondCompaniesStub.id, companyId))
    .limit(1);

  const company = rows[0];
  if (!company || company.deleted_at) {
    return { allowed: false, reason: 'not_found' };
  }
  if (company.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  // Companies have no owner_id: org match is the entire rule.
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: company.organization_id,
  };
}

// ---------------------------------------------------------------------------
// brief.document
// ---------------------------------------------------------------------------
//
// Mirrors apps/brief-api/src/services/document.service.ts :: documentVisibilityPredicate:
//  - visibility='organization': any org member.
//  - visibility='private':      creator or explicit collaborator.
//  - visibility='project':      creator, collaborator, or project member.

async function preflightBriefDocument(
  asker: AskerContext,
  documentId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: briefDocumentsStub.id,
      org_id: briefDocumentsStub.org_id,
      project_id: briefDocumentsStub.project_id,
      created_by: briefDocumentsStub.created_by,
      visibility: briefDocumentsStub.visibility,
    })
    .from(briefDocumentsStub)
    .where(eq(briefDocumentsStub.id, documentId))
    .limit(1);

  const doc = rows[0];
  if (!doc) return { allowed: false, reason: 'not_found' };
  if (doc.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (doc.visibility === 'organization') {
    return { allowed: true, reason: 'ok', entity_org_id: doc.org_id };
  }

  if (doc.created_by === asker.id) {
    return { allowed: true, reason: 'ok', entity_org_id: doc.org_id };
  }

  // Check collaborator link.
  const collabRows = await db
    .select({ id: briefCollaboratorsStub.id })
    .from(briefCollaboratorsStub)
    .where(
      and(
        eq(briefCollaboratorsStub.document_id, doc.id),
        eq(briefCollaboratorsStub.user_id, asker.id),
      ),
    )
    .limit(1);
  const isCollaborator = collabRows.length > 0;

  if (doc.visibility === 'private') {
    if (isCollaborator) {
      return { allowed: true, reason: 'ok', entity_org_id: doc.org_id };
    }
    return {
      allowed: false,
      reason: 'private_document_no_collaborator',
      entity_org_id: doc.org_id,
    };
  }

  // visibility === 'project'
  if (isCollaborator) {
    return { allowed: true, reason: 'ok', entity_org_id: doc.org_id };
  }
  if (doc.project_id) {
    const member = await isProjectMember(doc.project_id, asker.id);
    if (member) {
      return { allowed: true, reason: 'ok', entity_org_id: doc.org_id };
    }
  }
  return {
    allowed: false,
    reason: 'not_project_member',
    entity_org_id: doc.org_id,
  };
}

// ---------------------------------------------------------------------------
// beacon.entry
// ---------------------------------------------------------------------------
//
// Mirrors apps/beacon-api/src/services/graph.service.ts visibility filter:
//  - visibility='Organization': any org member.
//  - visibility='Private':      owned_by or created_by.
//  - visibility='Project':      owned_by, created_by, or project member.
//  - visibility='Public' is allowed (rarely used, same-org gate still applies
//     since we do not support cross-tenant public beacons in Wave 2).

async function preflightBeaconEntry(
  asker: AskerContext,
  entryId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: beaconEntriesStub.id,
      organization_id: beaconEntriesStub.organization_id,
      project_id: beaconEntriesStub.project_id,
      created_by: beaconEntriesStub.created_by,
      owned_by: beaconEntriesStub.owned_by,
      visibility: beaconEntriesStub.visibility,
    })
    .from(beaconEntriesStub)
    .where(eq(beaconEntriesStub.id, entryId))
    .limit(1);

  const entry = rows[0];
  if (!entry) return { allowed: false, reason: 'not_found' };
  if (entry.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (entry.visibility === 'Organization' || entry.visibility === 'Public') {
    return {
      allowed: true,
      reason: 'ok',
      entity_org_id: entry.organization_id,
    };
  }

  if (entry.visibility === 'Private') {
    if (entry.owned_by === asker.id || entry.created_by === asker.id) {
      return {
        allowed: true,
        reason: 'ok',
        entity_org_id: entry.organization_id,
      };
    }
    return {
      allowed: false,
      reason: 'beacon_private_not_owner',
      entity_org_id: entry.organization_id,
    };
  }

  // visibility === 'Project'
  if (entry.owned_by === asker.id || entry.created_by === asker.id) {
    return {
      allowed: true,
      reason: 'ok',
      entity_org_id: entry.organization_id,
    };
  }
  if (entry.project_id) {
    const member = await isProjectMember(entry.project_id, asker.id);
    if (member) {
      return {
        allowed: true,
        reason: 'ok',
        entity_org_id: entry.organization_id,
      };
    }
  }
  return {
    allowed: false,
    reason: 'beacon_project_not_member',
    entity_org_id: entry.organization_id,
  };
}

// ---------------------------------------------------------------------------
// blueprint.diagram / blueprint.node
// ---------------------------------------------------------------------------
//
// MVP scope (intentional): blueprint diagrams enforce org match only at the
// cross-app preflight layer. The full per-diagram rule set
// (visibility=private + collaborators, visibility=project + project membership,
// visibility=organization for any org member) is enforced authoritatively by
// blueprint-api's diagram.service::assertCanRead at the request boundary.
// We mirror only the org-id gate here so an agent surfacing a diagram link
// from a different org is silently filtered out (returns not_found), while
// within-org references stay visible. The richer rules will be backfilled
// when the stub expands to track per-collaborator rows.
//
// blueprint.node is a thin wrapper around blueprint.diagram: a node is
// reachable iff its parent diagram is.

async function preflightBlueprintDiagram(
  asker: AskerContext,
  diagramId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: blueprintDiagramsStub.id,
      org_id: blueprintDiagramsStub.org_id,
    })
    .from(blueprintDiagramsStub)
    .where(eq(blueprintDiagramsStub.id, diagramId))
    .limit(1);

  const diagram = rows[0];
  if (!diagram) return { allowed: false, reason: 'not_found' };
  if (diagram.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: diagram.org_id };
}

async function preflightBlueprintNode(
  asker: AskerContext,
  nodeId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: blueprintNodesStub.id,
      diagram_id: blueprintNodesStub.diagram_id,
      org_id: blueprintDiagramsStub.org_id,
    })
    .from(blueprintNodesStub)
    .innerJoin(
      blueprintDiagramsStub,
      eq(blueprintDiagramsStub.id, blueprintNodesStub.diagram_id),
    )
    .where(eq(blueprintNodesStub.id, nodeId))
    .limit(1);

  const node = rows[0];
  if (!node) return { allowed: false, reason: 'not_found' };
  if (node.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: node.org_id };
}

// ===========================================================================
// Banter Feed entity-type registration (banter-feed-design-document.md §16)
// ===========================================================================
// These branches let the Feed's can_access gate (§4.1) admit entities from the
// rest of the suite. Without them, those sources deny-by-default and the
// cross-app half of the feed is dark.

// ---------------------------------------------------------------------------
// banter.channel / banter.message
// ---------------------------------------------------------------------------
//
// Mirrors apps/banter-api/src/middleware/channel-auth.ts :: requireChannelMember:
//  - cross-org → not_found (do not leak existence).
//  - archived channel → not_found for non-SuperUsers (archived channels are
//     invisible to members; SuperUsers bypass to inspect/un-archive).
//  - SuperUsers bypass the membership requirement entirely.
//  - PUBLIC channels are org-readable: any member of the org may read them
//     without joining (the read-gate and this preflight allow it; the Feed
//     surfaces them, gated by the followed/unfollowed subscription). Membership
//     is only required for PRIVATE channels (non-members get not_found).
//  - NB: org admins/owners who are NOT channel members are NOT elevated for
//     ADMIN actions (the P2-15 finding: requireChannelAdmin still needs a real
//     admin/owner membership), so we deliberately do NOT apply a generic
//     isOrgAdmin bypass here.
//
// A banter.message inherits its parent channel's access (and must not be
// soft-deleted).

interface BanterChannelRow {
  id: string;
  org_id: string;
  type: string;
  is_archived: boolean;
}

async function banterChannelAccess(
  asker: AskerContext,
  channel: BanterChannelRow,
): Promise<PreflightResult> {
  if (channel.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  // SuperUsers bypass membership and the archived gate.
  if (asker.is_superuser) {
    return { allowed: true, reason: 'ok', entity_org_id: channel.org_id };
  }
  if (channel.is_archived) {
    return { allowed: false, reason: 'not_found' };
  }

  const memberRows = await db
    .select({ id: banterChannelMembershipsStub.id })
    .from(banterChannelMembershipsStub)
    .where(
      and(
        eq(banterChannelMembershipsStub.channel_id, channel.id),
        eq(banterChannelMembershipsStub.user_id, asker.id),
      ),
    )
    .limit(1);

  if (memberRows.length > 0) {
    return { allowed: true, reason: 'ok', entity_org_id: channel.org_id };
  }

  // Non-member. PUBLIC channels are org-readable: any member of the org (the
  // org match is already established above) may read them, so the Feed can
  // surface and the reader can open them. Private/DM channels still return
  // not_found (leak-safe) to non-members.
  if (channel.type === 'public') {
    return { allowed: true, reason: 'ok', entity_org_id: channel.org_id };
  }
  return { allowed: false, reason: 'not_found' };
}

async function preflightBanterChannel(
  asker: AskerContext,
  channelId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: banterChannelsStub.id,
      org_id: banterChannelsStub.org_id,
      type: banterChannelsStub.type,
      is_archived: banterChannelsStub.is_archived,
    })
    .from(banterChannelsStub)
    .where(eq(banterChannelsStub.id, channelId))
    .limit(1);

  const channel = rows[0];
  if (!channel) return { allowed: false, reason: 'not_found' };
  return banterChannelAccess(asker, channel);
}

async function preflightBanterMessage(
  asker: AskerContext,
  messageId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: banterMessagesStub.id,
      is_deleted: banterMessagesStub.is_deleted,
      channel_id: banterChannelsStub.id,
      org_id: banterChannelsStub.org_id,
      type: banterChannelsStub.type,
      is_archived: banterChannelsStub.is_archived,
    })
    .from(banterMessagesStub)
    .innerJoin(
      banterChannelsStub,
      eq(banterChannelsStub.id, banterMessagesStub.channel_id),
    )
    .where(eq(banterMessagesStub.id, messageId))
    .limit(1);

  const msg = rows[0];
  if (!msg || msg.is_deleted) return { allowed: false, reason: 'not_found' };
  return banterChannelAccess(asker, {
    id: msg.channel_id,
    org_id: msg.org_id,
    type: msg.type,
    is_archived: msg.is_archived,
  });
}

// ---------------------------------------------------------------------------
// bearing.goal / bearing.kr
// ---------------------------------------------------------------------------
//
// Bearing has no per-goal visibility enum: apps/bearing-api/src/middleware/
// authorize.ts gates reads on org match only, so any org member can read any
// goal in their org. A key result inherits its parent goal's visibility.

async function preflightBearingGoal(
  asker: AskerContext,
  goalId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bearingGoalsStub.id,
      organization_id: bearingGoalsStub.organization_id,
    })
    .from(bearingGoalsStub)
    .where(eq(bearingGoalsStub.id, goalId))
    .limit(1);

  const goal = rows[0];
  if (!goal) return { allowed: false, reason: 'not_found' };
  if (goal.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: goal.organization_id };
}

async function preflightBearingKr(
  asker: AskerContext,
  krId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bearingKeyResultsStub.id,
      organization_id: bearingGoalsStub.organization_id,
    })
    .from(bearingKeyResultsStub)
    .innerJoin(
      bearingGoalsStub,
      eq(bearingGoalsStub.id, bearingKeyResultsStub.goal_id),
    )
    .where(eq(bearingKeyResultsStub.id, krId))
    .limit(1);

  const kr = rows[0];
  if (!kr) return { allowed: false, reason: 'not_found' };
  if (kr.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: kr.organization_id };
}

// ---------------------------------------------------------------------------
// board.board
// ---------------------------------------------------------------------------
//
// Mirrors apps/board-api/src/services/board.service.ts :: visibilityFilter:
//  - visibility='organization': any org member.
//  - visibility='private':      creator or explicit collaborator (NO org-admin
//     bypass, matching brief.document private semantics).
//  - visibility='project':      creator, collaborator, or project member.
// Archive is a list-hiding state, not an access gate: an early contributor can
// still open an archived board, so archived_at does not deny here.

async function preflightBoardBoard(
  asker: AskerContext,
  boardId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: boardsStub.id,
      org_id: boardsStub.organization_id,
      project_id: boardsStub.project_id,
      created_by: boardsStub.created_by,
      visibility: boardsStub.visibility,
    })
    .from(boardsStub)
    .where(eq(boardsStub.id, boardId))
    .limit(1);

  const board = rows[0];
  if (!board) return { allowed: false, reason: 'not_found' };
  if (board.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (board.visibility === 'organization') {
    return { allowed: true, reason: 'ok', entity_org_id: board.org_id };
  }
  if (board.created_by === asker.id) {
    return { allowed: true, reason: 'ok', entity_org_id: board.org_id };
  }

  const collabRows = await db
    .select({ id: boardCollaboratorsStub.id })
    .from(boardCollaboratorsStub)
    .where(
      and(
        eq(boardCollaboratorsStub.board_id, board.id),
        eq(boardCollaboratorsStub.user_id, asker.id),
      ),
    )
    .limit(1);
  const isCollaborator = collabRows.length > 0;

  if (board.visibility === 'private') {
    if (isCollaborator) {
      return { allowed: true, reason: 'ok', entity_org_id: board.org_id };
    }
    return {
      allowed: false,
      reason: 'board_private_no_collaborator',
      entity_org_id: board.org_id,
    };
  }

  // visibility === 'project'
  if (isCollaborator) {
    return { allowed: true, reason: 'ok', entity_org_id: board.org_id };
  }
  if (board.project_id) {
    const member = await isProjectMember(board.project_id, asker.id);
    if (member) {
      return { allowed: true, reason: 'ok', entity_org_id: board.org_id };
    }
  }
  return {
    allowed: false,
    reason: 'not_project_member',
    entity_org_id: board.org_id,
  };
}

// ---------------------------------------------------------------------------
// book.event
// ---------------------------------------------------------------------------
//
// book_events.visibility is a free/busy status, not a privacy enum. The list
// route scopes on org, so any org member can read any event in their org
// (creator and attendees are subsets). Org match is the entire gate.

async function preflightBookEvent(
  asker: AskerContext,
  eventId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bookEventsStub.id,
      organization_id: bookEventsStub.organization_id,
    })
    .from(bookEventsStub)
    .where(eq(bookEventsStub.id, eventId))
    .limit(1);

  const event = rows[0];
  if (!event) return { allowed: false, reason: 'not_found' };
  if (event.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: event.organization_id };
}

// ---------------------------------------------------------------------------
// bill.invoice
// ---------------------------------------------------------------------------
//
// No per-invoice visibility enum: any org member can read any invoice in their
// org. Org match is the entire rule.

async function preflightBillInvoice(
  asker: AskerContext,
  invoiceId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: billInvoicesStub.id,
      organization_id: billInvoicesStub.organization_id,
    })
    .from(billInvoicesStub)
    .where(eq(billInvoicesStub.id, invoiceId))
    .limit(1);

  const invoice = rows[0];
  if (!invoice) return { allowed: false, reason: 'not_found' };
  if (invoice.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: invoice.organization_id,
  };
}

// ---------------------------------------------------------------------------
// blank.form
// ---------------------------------------------------------------------------
//
// Mirrors apps/blank-api/src/services/form.service.ts visibility enforcement:
//  - visibility='public': readable by anyone (within the org for our purposes).
//  - visibility='org':    any org member.
//  - visibility='project': project member when project_id is set, else org.

async function preflightBlankForm(
  asker: AskerContext,
  formId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: blankFormsStub.id,
      organization_id: blankFormsStub.organization_id,
      project_id: blankFormsStub.project_id,
      visibility: blankFormsStub.visibility,
    })
    .from(blankFormsStub)
    .where(eq(blankFormsStub.id, formId))
    .limit(1);

  const form = rows[0];
  if (!form) return { allowed: false, reason: 'not_found' };
  if (form.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (form.visibility === 'public' || form.visibility === 'org') {
    return { allowed: true, reason: 'ok', entity_org_id: form.organization_id };
  }

  // visibility === 'project'
  if (isOrgAdmin(asker.role)) {
    return { allowed: true, reason: 'ok', entity_org_id: form.organization_id };
  }
  if (form.project_id) {
    const member = await isProjectMember(form.project_id, asker.id);
    if (member) {
      return {
        allowed: true,
        reason: 'ok',
        entity_org_id: form.organization_id,
      };
    }
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: form.organization_id,
    };
  }
  // 'project' visibility with no project set behaves as org-visible.
  return { allowed: true, reason: 'ok', entity_org_id: form.organization_id };
}

// ---------------------------------------------------------------------------
// bolt.rule
// ---------------------------------------------------------------------------
//
// Bolt automations are org-level infrastructure with no per-rule visibility
// enum: any org member can read any rule in their org. Note the org column is
// org_id (not organization_id).

async function preflightBoltRule(
  asker: AskerContext,
  ruleId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: boltAutomationsStub.id,
      org_id: boltAutomationsStub.org_id,
    })
    .from(boltAutomationsStub)
    .where(eq(boltAutomationsStub.id, ruleId))
    .limit(1);

  const rule = rows[0];
  if (!rule) return { allowed: false, reason: 'not_found' };
  if (rule.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: rule.org_id };
}

// ---------------------------------------------------------------------------
// bin.asset
// ---------------------------------------------------------------------------
//
// Mirrors Bin master §9.4:
//  - org-scoped: a different org is not_found (do not leak existence).
//  - visibility='private': owner (created_by) only — no org-admin bypass.
//  - if project_id is set: project member, or org admin/owner.
//  - otherwise (organization): any org member.

async function preflightBinAsset(
  asker: AskerContext,
  assetId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: binAssetsStub.id,
      org_id: binAssetsStub.org_id,
      project_id: binAssetsStub.project_id,
      created_by: binAssetsStub.created_by,
      visibility: binAssetsStub.visibility,
    })
    .from(binAssetsStub)
    .where(eq(binAssetsStub.id, assetId))
    .limit(1);

  const asset = rows[0];
  if (!asset) return { allowed: false, reason: 'not_found' };
  if (asset.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (asset.visibility === 'private') {
    if (asset.created_by === asker.id) {
      return { allowed: true, reason: 'ok', entity_org_id: asset.org_id };
    }
    return {
      allowed: false,
      reason: 'bin_private_not_owner',
      entity_org_id: asset.org_id,
    };
  }

  if (asset.project_id) {
    if (isOrgAdmin(asker.role)) {
      return { allowed: true, reason: 'ok', entity_org_id: asset.org_id };
    }
    const member = await isProjectMember(asset.project_id, asker.id);
    if (member) {
      return { allowed: true, reason: 'ok', entity_org_id: asset.org_id };
    }
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: asset.org_id,
    };
  }

  // visibility === 'organization' (or any non-private with no project).
  return { allowed: true, reason: 'ok', entity_org_id: asset.org_id };
}

// ---------------------------------------------------------------------------
// bin.folder
// ---------------------------------------------------------------------------
//
// Folders have no per-folder visibility enum (Bin master §9.4: a folder
// inherits the parent folder/project rule). Enforce org match + the same
// project gate as an asset; org admin/owner override on project-scoped folders.

async function preflightBinFolder(
  asker: AskerContext,
  folderId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: binFoldersStub.id,
      org_id: binFoldersStub.org_id,
      project_id: binFoldersStub.project_id,
    })
    .from(binFoldersStub)
    .where(eq(binFoldersStub.id, folderId))
    .limit(1);

  const folder = rows[0];
  if (!folder) return { allowed: false, reason: 'not_found' };
  if (folder.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (folder.project_id) {
    if (isOrgAdmin(asker.role)) {
      return { allowed: true, reason: 'ok', entity_org_id: folder.org_id };
    }
    const member = await isProjectMember(folder.project_id, asker.id);
    if (member) {
      return { allowed: true, reason: 'ok', entity_org_id: folder.org_id };
    }
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: folder.org_id,
    };
  }

  return { allowed: true, reason: 'ok', entity_org_id: folder.org_id };
}

// ---------------------------------------------------------------------------
// bay.asset
// ---------------------------------------------------------------------------
//
// Bay review assets have no per-asset visibility enum (BAY-3: review layer over
// Bin). Enforce org match + the same project gate as a Bin folder; org
// admin/owner override on project-scoped assets. Annotations/decisions/versions
// inherit this rule through their parent asset.

async function preflightBayAsset(
  asker: AskerContext,
  assetId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bayAssetsStub.id,
      org_id: bayAssetsStub.org_id,
      project_id: bayAssetsStub.project_id,
    })
    .from(bayAssetsStub)
    .where(eq(bayAssetsStub.id, assetId))
    .limit(1);

  const asset = rows[0];
  if (!asset) return { allowed: false, reason: 'not_found' };
  if (asset.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }

  if (asset.project_id) {
    if (isOrgAdmin(asker.role)) {
      return { allowed: true, reason: 'ok', entity_org_id: asset.org_id };
    }
    const member = await isProjectMember(asset.project_id, asker.id);
    if (member) {
      return { allowed: true, reason: 'ok', entity_org_id: asset.org_id };
    }
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: asset.org_id,
    };
  }

  return { allowed: true, reason: 'ok', entity_org_id: asset.org_id };
}

// ---------------------------------------------------------------------------
// blip.tracked_app / blip.saved_view
// ---------------------------------------------------------------------------
//
// Blip telemetry (BigBlueBam_Blip_Design_Document.md §2). The tracked_app is
// the gating entity: it has no per-app visibility enum, so org match is the
// entire rule (entries inherit it, the same way Bin assets gate through their
// container rather than registering one entity per object). A saved_view gates
// through its parent tracked_app — joined via tracked_app_id — and is reachable
// iff that parent tracked_app is reachable (the org match on the parent).

async function preflightBlipTrackedApp(
  asker: AskerContext,
  trackedAppId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: blipTrackedAppsStub.id,
      org_id: blipTrackedAppsStub.org_id,
    })
    .from(blipTrackedAppsStub)
    .where(eq(blipTrackedAppsStub.id, trackedAppId))
    .limit(1);

  const app = rows[0];
  if (!app) return { allowed: false, reason: 'not_found' };
  if (app.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: app.org_id };
}

async function preflightBlipSavedView(
  asker: AskerContext,
  savedViewId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: blipSavedViewsStub.id,
      org_id: blipTrackedAppsStub.org_id,
    })
    .from(blipSavedViewsStub)
    .innerJoin(
      blipTrackedAppsStub,
      eq(blipTrackedAppsStub.id, blipSavedViewsStub.tracked_app_id),
    )
    .where(eq(blipSavedViewsStub.id, savedViewId))
    .limit(1);

  const view = rows[0];
  if (!view) return { allowed: false, reason: 'not_found' };
  if (view.org_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: true, reason: 'ok', entity_org_id: view.org_id };
}

// ---------------------------------------------------------------------------
// bill.client (Braid person source)
// ---------------------------------------------------------------------------
//
// Mirrors bill.invoice: no per-client visibility enum, so any org member can
// read any client in their org. Org match is the entire rule.

async function preflightBillClient(
  asker: AskerContext,
  clientId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: billClientsStub.id,
      organization_id: billClientsStub.organization_id,
    })
    .from(billClientsStub)
    .where(eq(billClientsStub.id, clientId))
    .limit(1);

  const client = rows[0];
  if (!client) return { allowed: false, reason: 'not_found' };
  if (client.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: client.organization_id,
  };
}

// ---------------------------------------------------------------------------
// book.event_attendee (Braid person source)
// ---------------------------------------------------------------------------
//
// The attendee row carries no organization_id; org is derived through its
// parent book_events (joined via event_id), mirroring preflightBookEvent's
// org gate. Any org member can read any event (and therefore its attendees)
// in their org.

async function preflightBookEventAttendee(
  asker: AskerContext,
  attendeeId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bookEventAttendeesStub.id,
      organization_id: bookEventsStub.organization_id,
    })
    .from(bookEventAttendeesStub)
    .innerJoin(
      bookEventsStub,
      eq(bookEventsStub.id, bookEventAttendeesStub.event_id),
    )
    .where(eq(bookEventAttendeesStub.id, attendeeId))
    .limit(1);

  const attendee = rows[0];
  if (!attendee) return { allowed: false, reason: 'not_found' };
  if (attendee.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: attendee.organization_id,
  };
}

// ---------------------------------------------------------------------------
// braid.profile (golden record)
// ---------------------------------------------------------------------------
//
// Org-match on braid_profiles.organization_id. can_access is the coarse org
// gate; the deep per-viewer PII re-assembly happens in braid-api's route
// layer (spec §2.5), not here.

async function preflightBraidProfile(
  asker: AskerContext,
  profileId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: braidProfilesStub.id,
      organization_id: braidProfilesStub.organization_id,
    })
    .from(braidProfilesStub)
    .where(eq(braidProfilesStub.id, profileId))
    .limit(1);

  const profile = rows[0];
  if (!profile) return { allowed: false, reason: 'not_found' };
  if (profile.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: profile.organization_id,
  };
}

// ---------------------------------------------------------------------------
// braid.identity (source-record membership atom)
// ---------------------------------------------------------------------------
//
// braid_identities carries its own organization_id, so org match is a direct
// column check. We still join to the parent braid_profiles so a dangling
// identity (profile deleted out from under it) fails closed as not_found.

async function preflightBraidIdentity(
  asker: AskerContext,
  identityId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: braidIdentitiesStub.id,
      organization_id: braidProfilesStub.organization_id,
    })
    .from(braidIdentitiesStub)
    .innerJoin(
      braidProfilesStub,
      eq(braidProfilesStub.id, braidIdentitiesStub.profile_id),
    )
    .where(eq(braidIdentitiesStub.id, identityId))
    .limit(1);

  const identity = rows[0];
  if (!identity) return { allowed: false, reason: 'not_found' };
  if (identity.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return {
    allowed: true,
    reason: 'ok',
    entity_org_id: identity.organization_id,
  };
}

// ---------------------------------------------------------------------------
// bulwark.contract / bulwark.obligation / bulwark.deadline
// ---------------------------------------------------------------------------
//
// Bulwark's ledger is project-scoped through the owning contract's project_id
// (spec §2.5): org-admins see any contract in their org; other members must be
// a member of the contract's project. A null-project contract has no project
// to join, so it falls back to an org-membership check (still org-scoped,
// never owner/admin-only, spec SK3) - which for a same-org asker is simply
// "allowed". Obligations and deadlines carry a contract_id and inherit the
// contract's project scope via an inner join; a dangling child (contract gone)
// fails closed as not_found.

async function gateByContractScope(
  asker: AskerContext,
  contractOrgId: string,
  contractProjectId: string | null,
): Promise<PreflightResult> {
  if (contractOrgId !== asker.org_id) {
    return { allowed: false, reason: 'not_found' }; // cross-org - do not disclose
  }
  // Org admins/owners see any contract in their own org.
  if (isOrgAdmin(asker.role)) {
    return { allowed: true, reason: 'ok', entity_org_id: contractOrgId };
  }
  // No-project contract (SK3): org-membership is the gate. A same-org asker is
  // by definition an org member, so allow.
  if (!contractProjectId) {
    return { allowed: true, reason: 'ok', entity_org_id: contractOrgId };
  }
  // project_id is set: normal project-membership gate.
  const member = await isProjectMember(contractProjectId, asker.id);
  if (!member) {
    return {
      allowed: false,
      reason: 'not_project_member',
      entity_org_id: contractOrgId,
    };
  }
  return { allowed: true, reason: 'ok', entity_org_id: contractOrgId };
}

async function preflightBulwarkContract(
  asker: AskerContext,
  contractId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bulwarkContractsStub.id,
      organization_id: bulwarkContractsStub.organization_id,
      project_id: bulwarkContractsStub.project_id,
    })
    .from(bulwarkContractsStub)
    .where(eq(bulwarkContractsStub.id, contractId))
    .limit(1);

  const contract = rows[0];
  if (!contract) return { allowed: false, reason: 'not_found' };
  return gateByContractScope(
    asker,
    contract.organization_id,
    contract.project_id,
  );
}

async function preflightBulwarkObligation(
  asker: AskerContext,
  obligationId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bulwarkObligationsStub.id,
      organization_id: bulwarkContractsStub.organization_id,
      project_id: bulwarkContractsStub.project_id,
    })
    .from(bulwarkObligationsStub)
    .innerJoin(
      bulwarkContractsStub,
      eq(bulwarkContractsStub.id, bulwarkObligationsStub.contract_id),
    )
    .where(eq(bulwarkObligationsStub.id, obligationId))
    .limit(1);

  const obligation = rows[0];
  if (!obligation) return { allowed: false, reason: 'not_found' };
  return gateByContractScope(
    asker,
    obligation.organization_id,
    obligation.project_id,
  );
}

async function preflightBulwarkDeadline(
  asker: AskerContext,
  deadlineId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: bulwarkNoticeDeadlinesStub.id,
      organization_id: bulwarkContractsStub.organization_id,
      project_id: bulwarkContractsStub.project_id,
    })
    .from(bulwarkNoticeDeadlinesStub)
    .innerJoin(
      bulwarkContractsStub,
      eq(bulwarkContractsStub.id, bulwarkNoticeDeadlinesStub.contract_id),
    )
    .where(eq(bulwarkNoticeDeadlinesStub.id, deadlineId))
    .limit(1);

  const deadline = rows[0];
  if (!deadline) return { allowed: false, reason: 'not_found' };
  return gateByContractScope(
    asker,
    deadline.organization_id,
    deadline.project_id,
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Decide whether `askerUserId` is allowed to see `(entityType, entityId)`.
 *
 * Never throws on "not found" or "forbidden" - those are represented in the
 * returned PreflightResult. Throws only for unexpected infra failures (db
 * down, stub column drift, etc.) that the caller should treat as a 5xx.
 *
 * RLS note: the Bam role may have BYPASSRLS off (BBB_RLS_ENFORCE=1), in
 * which case peer-app SELECTs still work because our stubs carry no
 * org-scoped policies of their own; we enforce the org match in-code.
 * The `app.current_org_id` GUC is left at whatever the caller's request
 * pipeline set it to. If the caller's org differs from the asker's org
 * (e.g. a SuperUser preflighting on behalf of a user in a different org),
 * the preflight logic still enforces asker.org_id === entity.org_id via
 * plain WHERE clauses, so RLS is not load-bearing for correctness here.
 */
export async function preflightAccess(
  askerUserId: string,
  entityType: string,
  entityId: string,
): Promise<PreflightResult> {
  const asker = await loadAsker(askerUserId);
  if (!asker) return { allowed: false, reason: 'not_found' };

  switch (entityType) {
    case 'bam.task':
      return preflightBamTask(asker, entityId);
    case 'bam.project':
      return preflightBamProject(asker, entityId);
    case 'bam.sprint':
      return preflightBamSprint(asker, entityId);
    case 'helpdesk.ticket':
      return preflightHelpdeskTicket(asker, entityId);
    case 'bond.deal':
      return preflightBondDeal(asker, entityId);
    case 'bond.contact':
      return preflightBondContact(asker, entityId);
    case 'bond.company':
      return preflightBondCompany(asker, entityId);
    case 'brief.document':
      return preflightBriefDocument(asker, entityId);
    case 'beacon.entry':
      return preflightBeaconEntry(asker, entityId);
    case 'blueprint.diagram':
      return preflightBlueprintDiagram(asker, entityId);
    case 'blueprint.node':
      return preflightBlueprintNode(asker, entityId);
    // Banter Feed entity-type registration (banter-feed-design-document.md §16)
    case 'banter.message':
      return preflightBanterMessage(asker, entityId);
    case 'banter.channel':
      return preflightBanterChannel(asker, entityId);
    case 'bearing.goal':
      return preflightBearingGoal(asker, entityId);
    case 'bearing.kr':
      return preflightBearingKr(asker, entityId);
    case 'board.board':
      return preflightBoardBoard(asker, entityId);
    case 'book.event':
      return preflightBookEvent(asker, entityId);
    case 'bill.invoice':
      return preflightBillInvoice(asker, entityId);
    case 'blank.form':
      return preflightBlankForm(asker, entityId);
    case 'bolt.rule':
      return preflightBoltRule(asker, entityId);
    case 'bay.asset':
      return preflightBayAsset(asker, entityId);
    case 'bin.asset':
      return preflightBinAsset(asker, entityId);
    case 'bin.folder':
      return preflightBinFolder(asker, entityId);
    // Blip telemetry entity-type registration (BigBlueBam_Blip_Design_Document.md §2)
    case 'blip.tracked_app':
      return preflightBlipTrackedApp(asker, entityId);
    case 'blip.saved_view':
      return preflightBlipSavedView(asker, entityId);
    // Braid person-source + golden-profile registration (APP_DESIGN_braid.md §2.5)
    case 'bill.client':
      return preflightBillClient(asker, entityId);
    case 'book.event_attendee':
      return preflightBookEventAttendee(asker, entityId);
    case 'braid.profile':
      return preflightBraidProfile(asker, entityId);
    case 'braid.identity':
      return preflightBraidIdentity(asker, entityId);
    // Bulwark contract-obligation-monitor registration (APP_DESIGN_bulwark.md §2.5)
    case 'bulwark.contract':
      return preflightBulwarkContract(asker, entityId);
    case 'bulwark.obligation':
      return preflightBulwarkObligation(asker, entityId);
    case 'bulwark.deadline':
      return preflightBulwarkDeadline(asker, entityId);
    // Burn margin/envelope-attribution monitor registration (APP_DESIGN_burn.md 2.4 point 4)
    case 'burn.engagement':
      return preflightBurnEngagement(asker, entityId);
    case 'burn.deliverable':
      return preflightBurnDeliverable(asker, entityId);
    // Bursar absence-detection / bid-leveling registration (APP_DESIGN_bursar.md §16.3)
    case 'bill.expense':
      return preflightBillExpense(asker, entityId);
    case 'bursar.vendor':
      return preflightBursarVendor(asker, entityId);
    case 'bursar.request':
      return preflightBursarRequest(asker, entityId);
    case 'bursar.offer':
      return preflightBursarOffer(asker, entityId);
    case 'bursar.award':
      return preflightBursarAward(asker, entityId);
    case 'bursar.mismatch':
      return preflightBursarMismatch(asker, entityId);
    default:
      return { allowed: false, reason: 'unsupported_entity_type' };
  }
}

// ---------------------------------------------------------------------------
// Exports for testing only
// ---------------------------------------------------------------------------
// These are not part of the public surface but are useful to unit-test the
// individual branches without going through the dispatch table.

/**
 * Burn engagement preflight (APP_DESIGN_burn.md 2.4 points 4 and 6).
 *
 * DELIBERATELY NOT gateByContractScope. Burn engagements have no project_id
 * column; a chain reaches projects only through burn_engagement_projects. The
 * Bulwark helper treats a null project as "org membership is the gate", and
 * Burn's equivalent state -- a chain linked to zero projects -- is defined by
 * spec 3.1 as burn.financials.read_all-only. Reusing the helper would make the
 * least-scoped chains the most widely readable ones.
 *
 * Org admins pass. Everyone else must be a member of at least one LINKED
 * project. An empty link set denies, with no fallback.
 */
async function preflightBurnEngagement(
  asker: AskerContext,
  engagementId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      id: burnEngagementsStub.id,
      organization_id: burnEngagementsStub.organization_id,
    })
    .from(burnEngagementsStub)
    .where(eq(burnEngagementsStub.id, engagementId))
    .limit(1);

  const engagement = rows[0];
  if (!engagement) return { allowed: false, reason: 'not_found' };
  if (engagement.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' }; // cross-org - do not disclose
  }
  if (isOrgAdmin(asker.role)) {
    return { allowed: true, reason: 'ok', entity_org_id: engagement.organization_id };
  }

  const linked = await db
    .select({ project_id: burnEngagementProjectsStub.project_id })
    .from(burnEngagementProjectsStub)
    .where(eq(burnEngagementProjectsStub.engagement_id, engagementId));

  // No null/empty fallback: a zero-project chain denies for every non-admin.
  for (const link of linked) {
    if (await isProjectMember(link.project_id, asker.id)) {
      return { allowed: true, reason: 'ok', entity_org_id: engagement.organization_id };
    }
  }
  return {
    allowed: false,
    reason: 'not_project_member',
    entity_org_id: engagement.organization_id,
  };
}

/** Deliverables inherit the parent engagement's scope; a dangling row denies. */
async function preflightBurnDeliverable(
  asker: AskerContext,
  deliverableId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({
      engagement_id: burnDeliverablesStub.engagement_id,
      organization_id: burnDeliverablesStub.organization_id,
    })
    .from(burnDeliverablesStub)
    .where(eq(burnDeliverablesStub.id, deliverableId))
    .limit(1);

  const deliverable = rows[0];
  if (!deliverable) return { allowed: false, reason: 'not_found' };
  if (deliverable.organization_id !== asker.org_id) {
    return { allowed: false, reason: 'not_found' };
  }
  return preflightBurnEngagement(asker, deliverable.engagement_id);
}

// ---------------------------------------------------------------------------
// bill.expense + bursar.* (APP_DESIGN_bursar.md §16.3)
// ---------------------------------------------------------------------------
//
// Every one of these rows is org-scoped by organization_id with no per-row
// visibility enum, so org match is the entire rule (mirrors bill.invoice). A
// cross-org row denies as not_found so its existence is never disclosed. The
// financial FLOORING that Bursar applies on top of read access is a bursar-api
// serializer concern (viewer-caps.ts), not a can_access concern; can_access
// answers only "may this asker see that this row exists".

/** bill.expense: org membership is the entire rule (mirrors bill.invoice). */
async function preflightBillExpense(
  asker: AskerContext,
  expenseId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({ id: billExpensesStub.id, organization_id: billExpensesStub.organization_id })
    .from(billExpensesStub)
    .where(eq(billExpensesStub.id, expenseId))
    .limit(1);
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'not_found' };
  if (row.organization_id !== asker.org_id) return { allowed: false, reason: 'not_found' };
  return { allowed: true, reason: 'ok', entity_org_id: row.organization_id };
}

/** bursar.vendor: org membership is the entire rule. */
async function preflightBursarVendor(
  asker: AskerContext,
  vendorId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({ id: bursarVendorsStub.id, organization_id: bursarVendorsStub.organization_id })
    .from(bursarVendorsStub)
    .where(eq(bursarVendorsStub.id, vendorId))
    .limit(1);
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'not_found' };
  if (row.organization_id !== asker.org_id) return { allowed: false, reason: 'not_found' };
  return { allowed: true, reason: 'ok', entity_org_id: row.organization_id };
}

/** bursar.request: org membership is the entire rule. */
async function preflightBursarRequest(
  asker: AskerContext,
  requestId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({ id: bursarRequestsStub.id, organization_id: bursarRequestsStub.organization_id })
    .from(bursarRequestsStub)
    .where(eq(bursarRequestsStub.id, requestId))
    .limit(1);
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'not_found' };
  if (row.organization_id !== asker.org_id) return { allowed: false, reason: 'not_found' };
  return { allowed: true, reason: 'ok', entity_org_id: row.organization_id };
}

/** bursar.offer: org membership is the entire rule. (Seal state is a bursar-api serializer concern.) */
async function preflightBursarOffer(
  asker: AskerContext,
  offerId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({ id: bursarOffersStub.id, organization_id: bursarOffersStub.organization_id })
    .from(bursarOffersStub)
    .where(eq(bursarOffersStub.id, offerId))
    .limit(1);
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'not_found' };
  if (row.organization_id !== asker.org_id) return { allowed: false, reason: 'not_found' };
  return { allowed: true, reason: 'ok', entity_org_id: row.organization_id };
}

/** bursar.award: org membership is the entire rule. */
async function preflightBursarAward(
  asker: AskerContext,
  awardId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({ id: bursarAwardsStub.id, organization_id: bursarAwardsStub.organization_id })
    .from(bursarAwardsStub)
    .where(eq(bursarAwardsStub.id, awardId))
    .limit(1);
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'not_found' };
  if (row.organization_id !== asker.org_id) return { allowed: false, reason: 'not_found' };
  return { allowed: true, reason: 'ok', entity_org_id: row.organization_id };
}

/** bursar.mismatch: org membership is the entire rule. */
async function preflightBursarMismatch(
  asker: AskerContext,
  mismatchId: string,
): Promise<PreflightResult> {
  const rows = await db
    .select({ id: bursarMismatchesStub.id, organization_id: bursarMismatchesStub.organization_id })
    .from(bursarMismatchesStub)
    .where(eq(bursarMismatchesStub.id, mismatchId))
    .limit(1);
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'not_found' };
  if (row.organization_id !== asker.org_id) return { allowed: false, reason: 'not_found' };
  return { allowed: true, reason: 'ok', entity_org_id: row.organization_id };
}

export const __test__ = {
  preflightBurnEngagement,
  preflightBurnDeliverable,
  loadAsker,
  isOrgAdmin,
  isProjectMember,
  getUserProjectIds,
  preflightBamProject,
  preflightBamTask,
  preflightBamSprint,
  preflightHelpdeskTicket,
  preflightBondDeal,
  preflightBondContact,
  preflightBondCompany,
  preflightBriefDocument,
  preflightBeaconEntry,
  preflightBlueprintDiagram,
  preflightBlueprintNode,
  preflightBanterChannel,
  preflightBanterMessage,
  preflightBearingGoal,
  preflightBearingKr,
  preflightBoardBoard,
  preflightBookEvent,
  preflightBillInvoice,
  preflightBlankForm,
  preflightBoltRule,
  preflightBinAsset,
  preflightBinFolder,
  preflightBlipTrackedApp,
  preflightBlipSavedView,
  preflightBillClient,
  preflightBookEventAttendee,
  preflightBraidProfile,
  preflightBraidIdentity,
};
