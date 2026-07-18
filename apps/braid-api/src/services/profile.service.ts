import { and, desc, eq, lt, or, inArray } from 'drizzle-orm';
import type { BraidProfile, BraidIdentity } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { braidProfiles, braidIdentities, braidMergeDecisions } from '../db/schema/index.js';
import { preflightMany } from '../lib/can-access.client.js';
import { isAdminViewer, type Viewer } from './types.js';

// Per-viewer read assembly (spec 2.1 plane 2 / 2.5). The cached PII columns on
// braid_profiles are an INTERNAL worker cache; every scalar and attribute served to
// a caller is re-derived from ONLY the member identities that pass preflightAccess.
// The source_type string doubles as the can_access entity_type.

type ProfileRow = typeof braidProfiles.$inferSelect;
type IdentityRow = typeof braidIdentities.$inferSelect;

interface AttributeProvenance {
  value: unknown;
  source_identity_id?: string;
  source_app?: string;
  rule?: string;
}

const NAME_KEYS = ['display_name', 'name'];
const EMAIL_KEYS = ['primary_email', 'email'];
const PHONE_KEYS = ['primary_phone', 'phone'];

function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function firstScalar(attrs: Record<string, AttributeProvenance>, keys: string[]): string | null {
  for (const k of keys) {
    const a = attrs[k];
    if (a && a.value != null && a.value !== '') return String(a.value);
  }
  return null;
}

// Compute the set of identity ids the viewer may see, batched one preflight query
// per source_type (spec 2.1). Admins bypass (they hold the admin-tier read).
async function visibleIdentityIds(viewer: Viewer, identities: IdentityRow[]): Promise<Set<string>> {
  if (isAdminViewer(viewer)) return new Set(identities.map((i) => i.id));
  const byType = new Map<string, IdentityRow[]>();
  for (const i of identities) {
    const arr = byType.get(i.source_type) ?? [];
    arr.push(i);
    byType.set(i.source_type, arr);
  }
  const visible = new Set<string>();
  for (const [sourceType, rows] of byType) {
    const okSourceIds = await preflightMany(
      viewer.id,
      sourceType,
      rows.map((r) => r.source_id),
    );
    for (const r of rows) if (okSourceIds.has(r.source_id)) visible.add(r.id);
  }
  return visible;
}

function assembleProfile(
  profile: ProfileRow,
  identities: IdentityRow[],
  visibleIds: Set<string>,
  admin: boolean,
): BraidProfile {
  const visibleMembers = identities.filter((i) => visibleIds.has(i.id));

  // Drop any attribute whose winning source member is not visible. A manual_pin has
  // no source_identity_id (admin-configured, not member PII) so it is retained.
  const rawAttrs = (profile.attributes as Record<string, AttributeProvenance>) ?? {};
  const attrs: Record<string, AttributeProvenance> = {};
  for (const [field, prov] of Object.entries(rawAttrs)) {
    if (!prov.source_identity_id || visibleIds.has(prov.source_identity_id)) attrs[field] = prov;
  }

  const confidences = visibleMembers
    .map((m) => (m.link_confidence == null ? null : Number(m.link_confidence)))
    .filter((n): n is number => n != null && !Number.isNaN(n));
  const confidence = confidences.length > 0 ? Math.min(...confidences) : null;

  const companyAttr = attrs.company_profile_id;

  return {
    id: profile.id,
    organization_id: profile.organization_id,
    kind: profile.kind as BraidProfile['kind'],
    display_name: firstScalar(attrs, NAME_KEYS),
    primary_email: firstScalar(attrs, EMAIL_KEYS),
    primary_phone: firstScalar(attrs, PHONE_KEYS),
    // email_suppressed is admin-only on read (no Blast visibility gate, S-r2-3).
    email_suppressed: admin ? profile.email_suppressed : null,
    company_profile_id:
      companyAttr && companyAttr.value != null ? String(companyAttr.value) : null,
    attributes: attrs,
    identity_count: visibleMembers.length,
    confidence,
    status: profile.status as BraidProfile['status'],
    merged_into_id: profile.merged_into_id,
    created_at: iso(profile.created_at),
    updated_at: iso(profile.updated_at),
  };
}

export async function getProfileForViewer(
  orgId: string,
  profileId: string,
  viewer: Viewer,
): Promise<BraidProfile | null> {
  const [profile] = await db
    .select()
    .from(braidProfiles)
    .where(and(eq(braidProfiles.id, profileId), eq(braidProfiles.organization_id, orgId)))
    .limit(1);
  if (!profile) return null;
  const identities = await db
    .select()
    .from(braidIdentities)
    .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, profileId)));
  const visibleIds = await visibleIdentityIds(viewer, identities);
  return assembleProfile(profile, identities, visibleIds, isAdminViewer(viewer));
}

export interface ListProfilesQuery {
  cursor?: string;
  limit: number;
  kind?: string;
  status?: string;
}

export async function listProfiles(
  orgId: string,
  viewer: Viewer,
  query: ListProfilesQuery,
): Promise<{ data: BraidProfile[]; next_cursor: string | null }> {
  const admin = isAdminViewer(viewer);
  const conds = [eq(braidProfiles.organization_id, orgId)];
  if (query.status) conds.push(eq(braidProfiles.status, query.status));
  else conds.push(eq(braidProfiles.status, 'active'));
  if (query.kind) conds.push(eq(braidProfiles.kind, query.kind));
  if (query.cursor) conds.push(lt(braidProfiles.created_at, new Date(query.cursor)));

  const rows = await db
    .select()
    .from(braidProfiles)
    .where(and(...conds))
    .orderBy(desc(braidProfiles.created_at))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const nextCursor = rows.length > query.limit ? iso(page[page.length - 1]!.created_at) : null;

  const out: BraidProfile[] = [];
  for (const profile of page) {
    if (admin) {
      // Admin holds the full read tier; assemble from the cached columns without a
      // preflight fan-out.
      out.push(assembleProfileAdminCache(profile));
    } else {
      const identities = await db
        .select()
        .from(braidIdentities)
        .where(
          and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, profile.id)),
        );
      const visibleIds = await visibleIdentityIds(viewer, identities);
      out.push(assembleProfile(profile, identities, visibleIds, false));
    }
  }
  return { data: out, next_cursor: nextCursor };
}

// Fast path for admins: the cached columns already reflect the full survivorship.
function assembleProfileAdminCache(profile: ProfileRow): BraidProfile {
  return {
    id: profile.id,
    organization_id: profile.organization_id,
    kind: profile.kind as BraidProfile['kind'],
    display_name: profile.display_name,
    primary_email: profile.primary_email,
    primary_phone: profile.primary_phone,
    email_suppressed: profile.email_suppressed,
    company_profile_id: profile.company_profile_id,
    attributes: (profile.attributes as Record<string, AttributeProvenance>) ?? {},
    identity_count: profile.identity_count,
    confidence: profile.confidence == null ? null : Number(profile.confidence),
    status: profile.status as BraidProfile['status'],
    merged_into_id: profile.merged_into_id,
    created_at: iso(profile.created_at),
    updated_at: iso(profile.updated_at),
  };
}

export async function listIdentitiesForViewer(
  orgId: string,
  profileId: string,
  viewer: Viewer,
  limit: number,
): Promise<BraidIdentity[]> {
  const identities = await db
    .select()
    .from(braidIdentities)
    .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, profileId)))
    .limit(limit);
  const visibleIds = await visibleIdentityIds(viewer, identities);
  // Non-admin: denied rows are dropped ENTIRELY (no masked stub, S3).
  return identities
    .filter((i) => visibleIds.has(i.id))
    .map((i) => ({
      id: i.id,
      profile_id: i.profile_id,
      source_type: i.source_type as BraidIdentity['source_type'],
      source_id: i.source_id,
      match_keys: (i.match_keys as Record<string, unknown>) ?? {},
      link_confidence: i.link_confidence == null ? null : Number(i.link_confidence),
      link_kind: i.link_kind as BraidIdentity['link_kind'],
      linked_at: iso(i.linked_at),
    }));
}

export interface TimelineRow {
  kind: 'member_linked';
  source_type: string;
  source_id: string;
  link_kind: string;
  at: string;
}

// Cross-app timeline (spec 5.1). Fail-closed: a row is included only if it is tied to
// a member identity the caller passed preflightAccess on. For M4 the timeline is the
// member-attach history (member rows); richer v_activity_unified / bolt_recent_events
// enrichment is deferred.
// TODO(M6): join v_activity_unified + bolt_recent_events for the visible members.
export async function timelineForViewer(
  orgId: string,
  profileId: string,
  viewer: Viewer,
): Promise<TimelineRow[]> {
  const identities = await db
    .select()
    .from(braidIdentities)
    .where(and(eq(braidIdentities.organization_id, orgId), eq(braidIdentities.profile_id, profileId)))
    .orderBy(desc(braidIdentities.linked_at));
  const visibleIds = await visibleIdentityIds(viewer, identities);
  return identities
    .filter((i) => visibleIds.has(i.id))
    .map((i) => ({
      kind: 'member_linked' as const,
      source_type: i.source_type,
      source_id: i.source_id,
      link_kind: i.link_kind,
      at: iso(i.linked_at),
    }));
}

export interface DecisionView {
  id: string;
  decision_kind: string;
  surviving_profile_id: string | null;
  absorbed_profile_id: string | null;
  affected_identity_ids: string[];
  reverses_decision_id: string | null;
  score_at_decision: number | null;
  decided_by: string;
  decided_by_kind: string;
  reason: string | null;
  created_at: string;
}

// Merge/split audit history (spec 5.1). Admin-tier. Each decision's
// affected_identity_ids and absorbed_profile_id are filtered through the same
// batched preflight as the member list, dropping unmappable ids fail-closed so the
// array length cannot defeat identity_count suppression (S3-1).
export async function decisionsForViewer(
  orgId: string,
  profileId: string,
  viewer: Viewer,
): Promise<DecisionView[]> {
  const rows = await db
    .select()
    .from(braidMergeDecisions)
    .where(
      and(
        eq(braidMergeDecisions.organization_id, orgId),
        or(
          eq(braidMergeDecisions.surviving_profile_id, profileId),
          eq(braidMergeDecisions.absorbed_profile_id, profileId),
        ),
      ),
    )
    .orderBy(desc(braidMergeDecisions.created_at));

  const admin = isAdminViewer(viewer);

  // Gather every affected identity id across the decisions to preflight once.
  let allowedIds: Set<string> | null = null;
  if (!admin) {
    const ids = new Set<string>();
    for (const r of rows) {
      for (const id of (r.affected_identity_ids as string[] | null) ?? []) ids.add(id);
    }
    const idList = [...ids];
    if (idList.length > 0) {
      const idents = await db
        .select()
        .from(braidIdentities)
        .where(and(eq(braidIdentities.organization_id, orgId), inArray(braidIdentities.id, idList)));
      allowedIds = await visibleIdentityIds(viewer, idents);
    } else {
      allowedIds = new Set();
    }
  }

  return rows.map((r) => {
    const affected = ((r.affected_identity_ids as string[] | null) ?? []).filter(
      (id) => admin || allowedIds!.has(id),
    );
    return {
      id: r.id,
      decision_kind: r.decision_kind,
      surviving_profile_id: r.surviving_profile_id,
      absorbed_profile_id: r.absorbed_profile_id,
      affected_identity_ids: affected,
      reverses_decision_id: r.reverses_decision_id,
      score_at_decision: r.score_at_decision == null ? null : Number(r.score_at_decision),
      decided_by: r.decided_by,
      decided_by_kind: r.decided_by_kind,
      reason: r.reason,
      created_at: iso(r.created_at),
    };
  });
}
