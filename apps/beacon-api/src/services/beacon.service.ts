import crypto from 'node:crypto';
import { eq, and, or, sql, asc, gt, inArray, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  beaconEntries,
  beaconVersions,
  beaconExpiryPolicies,
  projectMemberships,
  users,
  projects,
} from '../db/schema/index.js';
import { sanitizeHtml } from '../lib/sanitize.js';
import { beaconRefLookup } from '../lib/beacon-ref.js';
import { resolveBeaconAccess } from '../lib/beacon-access.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE/ILIKE metacharacters so user input is treated as literal text. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/**
 * Convert a title to a URL-friendly slug.
 * Rules: lowercase, replace non-alphanumeric with hyphens, collapse runs of
 * hyphens, trim leading/trailing hyphens, truncate to 200 chars.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

/**
 * Candidate slugs for a new beacon, in the order createBeacon tries them: the
 * clean slug first, then the clean slug with a random 8-char hex suffix.
 *
 * There is no pre-read: createBeacon inserts each candidate with
 * ON CONFLICT (organization_id, slug) DO NOTHING, the per-org unique key
 * (beacon_entries_org_slug_key, #246), and moves to the next candidate when the
 * insert returns no row. A probe-then-insert let two creates with the same title
 * both see the slug free and the second 500 on the unique key (#304).
 */
export function slugCandidate(title: string, attempt: number): string {
  const base = slugify(title);
  const suffix = crypto.randomBytes(4).toString('hex');
  if (!base) return `beacon-${suffix}`;
  return attempt === 0 ? base : `${base.slice(0, 247)}-${suffix}`;
}

/** Clean slug plus this many suffixed retries before createBeacon gives up. */
const CREATE_SLUG_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// Expiry policy resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective default_expiry_days for a beacon by walking the
 * policy hierarchy: Project → Organization → System.
 * Falls back to 90 days if no policy is found.
 */
async function resolveDefaultExpiryDays(
  orgId: string,
  projectId: string | null,
): Promise<number> {
  // Try project-level first
  if (projectId) {
    const [projectPolicy] = await db
      .select({ default_expiry_days: beaconExpiryPolicies.default_expiry_days })
      .from(beaconExpiryPolicies)
      .where(
        and(
          eq(beaconExpiryPolicies.scope, 'Project'),
          eq(beaconExpiryPolicies.project_id, projectId),
        ),
      )
      .limit(1);
    if (projectPolicy) return projectPolicy.default_expiry_days;
  }

  // Try org-level
  const [orgPolicy] = await db
    .select({ default_expiry_days: beaconExpiryPolicies.default_expiry_days })
    .from(beaconExpiryPolicies)
    .where(
      and(
        eq(beaconExpiryPolicies.scope, 'Organization'),
        eq(beaconExpiryPolicies.organization_id, orgId),
      ),
    )
    .limit(1);
  if (orgPolicy) return orgPolicy.default_expiry_days;

  // Try system-level
  const [sysPolicy] = await db
    .select({ default_expiry_days: beaconExpiryPolicies.default_expiry_days })
    .from(beaconExpiryPolicies)
    .where(eq(beaconExpiryPolicies.scope, 'System'))
    .limit(1);
  if (sysPolicy) return sysPolicy.default_expiry_days;

  return 90; // hard-coded fallback
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class BeaconError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'BeaconError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateBeaconInput {
  title: string;
  summary?: string | null;
  body_markdown: string;
  body_html?: string | null;
  visibility?: 'Public' | 'Organization' | 'Project' | 'Private';
  project_id?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createBeacon(
  data: CreateBeaconInput,
  userId: string,
  orgId: string,
) {
  const expiryDays = await resolveDefaultExpiryDays(orgId, data.project_id ?? null);
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  // One transaction (#304): the entry and its v1 beacon_versions snapshot commit
  // or roll back together, so no reader (Bastion's policy reader reads the
  // current version's frozen body from beacon_versions) ever sees an entry with
  // no v1. The slug is claimed by the insert itself, see slugCandidate.
  return db.transaction(async (tx) => {
    for (let attempt = 0; attempt < CREATE_SLUG_ATTEMPTS; attempt++) {
      const [beacon] = await tx
        .insert(beaconEntries)
        .values({
          slug: slugCandidate(data.title, attempt),
          title: data.title,
          summary: data.summary ?? null,
          body_markdown: data.body_markdown,
          body_html: data.body_html ? sanitizeHtml(data.body_html) : null,
          version: 1,
          status: 'Draft',
          visibility: data.visibility ?? 'Project',
          created_by: userId,
          owned_by: userId,
          project_id: data.project_id ?? null,
          organization_id: orgId,
          expires_at: expiresAt,
          metadata: data.metadata ?? {},
        })
        .onConflictDoNothing({ target: [beaconEntries.organization_id, beaconEntries.slug] })
        .returning();
      if (!beacon) continue; // slug taken in this org: try the next candidate

      await tx.insert(beaconVersions).values({
        beacon_id: beacon.id,
        version: 1,
        title: data.title,
        summary: data.summary ?? null,
        body_markdown: data.body_markdown,
        changed_by: userId,
        change_note: 'Initial version',
      });
      return beacon;
    }
    throw new BeaconError('CONFLICT', 'Could not allocate a unique slug for this beacon; try again', 409);
  });
}

export async function getBeacon(idOrSlug: string, userId: string, orgId: string) {
  const lookup = beaconRefLookup(idOrSlug, orgId);

  const [beacon] = await db
    .select()
    .from(beaconEntries)
    .where(and(lookup.where, eq(beaconEntries.organization_id, orgId)))
    .limit(1);

  if (!beacon) return null;

  // The shared read rule (lib/beacon-access.ts, #299). Read never depends on the
  // org role, so the least-privileged role is passed.
  const level = await resolveBeaconAccess({ id: userId, org_id: orgId, role: 'viewer' }, beacon);
  if (level === 'none') return null;

  return beacon;
}

export interface ListBeaconsFilters {
  orgId: string;
  userId: string;
  projectIds?: string[];
  status?: string;
  tags?: string[];
  visibilityMax?: string;
  expiresAfter?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export async function listBeacons(filters: ListBeaconsFilters) {
  const conditions = [eq(beaconEntries.organization_id, filters.orgId)];

  if (filters.projectIds && filters.projectIds.length > 0) {
    conditions.push(inArray(beaconEntries.project_id, filters.projectIds));
  }

  if (filters.status) {
    conditions.push(eq(beaconEntries.status, filters.status as any));
  }

  if (filters.expiresAfter) {
    conditions.push(gt(beaconEntries.expires_at, new Date(filters.expiresAfter)));
  }

  if (filters.search) {
    const escaped = escapeLike(filters.search);
    conditions.push(
      or(
        ilike(beaconEntries.title, `%${escaped}%`),
        ilike(beaconEntries.summary, `%${escaped}%`),
      )!,
    );
  }

  // Visibility enforcement:
  // - Private beacons: only visible to owner/creator
  // - Project beacons: only visible to project members (or owner/creator)
  const userProjectIds = await getUserProjectIds(filters.userId);
  const userProjectArray = [...userProjectIds];

  // Exclude beacons the user cannot see based on visibility rules:
  // Allow if: visibility is Public/Organization, OR
  //           visibility is Private and user is owner/creator, OR
  //           visibility is Project and (user is owner/creator OR user is a project member)
  conditions.push(
    or(
      // Public and Organization visibility — visible to all org members
      sql`${beaconEntries.visibility} IN ('Public', 'Organization')`,
      // Private — only owner/creator
      and(
        eq(beaconEntries.visibility, 'Private'),
        or(
          eq(beaconEntries.owned_by, filters.userId),
          eq(beaconEntries.created_by, filters.userId),
        ),
      ),
      // Project — owner/creator or project member
      and(
        eq(beaconEntries.visibility, 'Project'),
        or(
          eq(beaconEntries.owned_by, filters.userId),
          eq(beaconEntries.created_by, filters.userId),
          userProjectArray.length > 0
            ? inArray(beaconEntries.project_id, userProjectArray)
            : sql`FALSE`,
        ),
      ),
    )!,
  );

  const limit = Math.min(filters.limit ?? 50, 100);

  if (filters.cursor) {
    conditions.push(gt(beaconEntries.created_at, new Date(filters.cursor)));
  }

  const result = await db
    .select({
      beacon: beaconEntries,
      owner_name: users.display_name,
      project_name: projects.name,
    })
    .from(beaconEntries)
    .leftJoin(users, eq(users.id, beaconEntries.owned_by))
    .leftJoin(projects, eq(projects.id, beaconEntries.project_id))
    .where(and(...conditions))
    .orderBy(asc(beaconEntries.created_at))
    .limit(limit + 1);

  const hasMore = result.length > limit;
  const rows = hasMore ? result.slice(0, limit) : result;
  const data = rows.map((r) => ({
    ...r.beacon,
    owner_name: r.owner_name ?? null,
    project_name: r.project_name ?? null,
  }));
  const nextCursor =
    hasMore && rows.length > 0
      ? rows[rows.length - 1]!.beacon.created_at.toISOString()
      : null;

  return {
    data,
    meta: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export async function getStats(orgId: string) {
  const rows: any[] = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE expires_at IS NOT NULL
          AND expires_at > NOW()
          AND expires_at <= NOW() + INTERVAL '7 days'
      )::int AS at_risk,
      COUNT(*) FILTER (
        WHERE updated_at > NOW() - INTERVAL '7 days'
          OR last_verified_at > NOW() - INTERVAL '7 days'
      )::int AS recently_updated
    FROM beacon_entries
    WHERE organization_id = ${orgId}
      AND status IN ('Active', 'PendingReview', 'Draft')
  `);

  const row = rows[0] ?? { total: 0, at_risk: 0, recently_updated: 0 };
  return {
    total: row.total,
    at_risk: row.at_risk,
    recently_updated: row.recently_updated,
  };
}

export interface UpdateBeaconInput {
  title?: string;
  summary?: string | null;
  body_markdown?: string;
  body_html?: string | null;
  visibility?: 'Public' | 'Organization' | 'Project' | 'Private';
  metadata?: Record<string, unknown>;
  change_note?: string;
}

export async function updateBeacon(
  id: string,
  data: UpdateBeaconInput,
  userId: string,
  orgId: string,
) {
  const existing = await getBeaconById(id, orgId);
  if (!existing) throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);

  // `version = version + 1` in SQL under the UPDATE's row lock, and the snapshot taken from the
  // row the UPDATE returned, in one transaction (#280): two concurrent edits used to both write
  // existing.version + 1, the second then 500'd on the (beacon_id, version) unique key after its
  // entry update had landed, and the snapshot copied unchanged fields from a stale read.
  const updateValues: Record<string, unknown> = {
    version: sql`${beaconEntries.version} + 1`,
    updated_at: new Date(),
  };
  if (data.title !== undefined) updateValues.title = data.title;
  if (data.summary !== undefined) updateValues.summary = data.summary;
  if (data.body_markdown !== undefined) updateValues.body_markdown = data.body_markdown;
  if (data.body_html !== undefined) updateValues.body_html = data.body_html ? sanitizeHtml(data.body_html) : data.body_html;
  if (data.visibility !== undefined) updateValues.visibility = data.visibility;
  if (data.metadata !== undefined) updateValues.metadata = data.metadata;

  return db.transaction(async (tx) => {
    const [beacon] = await tx
      .update(beaconEntries)
      .set(updateValues)
      .where(and(eq(beaconEntries.id, id), eq(beaconEntries.organization_id, orgId)))
      .returning();
    if (!beacon) throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);

    await tx.insert(beaconVersions).values({
      beacon_id: id,
      version: beacon.version,
      title: beacon.title,
      summary: beacon.summary,
      body_markdown: beacon.body_markdown,
      changed_by: userId,
      change_note: data.change_note ?? null,
    });

    return beacon;
  });
}

export async function retireBeacon(id: string, _userId: string, orgId: string) {
  const existing = await getBeaconById(id, orgId);
  if (!existing) throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);

  if (existing.status === 'Retired') {
    throw new BeaconError('BAD_REQUEST', 'Beacon is already retired', 400);
  }

  const [beacon] = await db
    .update(beaconEntries)
    .set({
      status: 'Retired',
      retired_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(beaconEntries.id, id))
    .returning();

  return beacon!;
}

export async function publishBeacon(id: string, _userId: string, orgId: string) {
  const existing = await getBeaconById(id, orgId);
  if (!existing) throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);

  if (existing.status !== 'Draft') {
    throw new BeaconError(
      'INVALID_TRANSITION',
      `Cannot publish a beacon with status '${existing.status}'; must be Draft`,
    );
  }

  // Compute expires_at from policy on publish
  const expiryDays = await resolveDefaultExpiryDays(
    existing.organization_id,
    existing.project_id,
  );
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  const [beacon] = await db
    .update(beaconEntries)
    .set({
      status: 'Active',
      expires_at: expiresAt,
      updated_at: new Date(),
    })
    .where(eq(beaconEntries.id, id))
    .returning();

  return beacon!;
}

export async function restoreBeacon(id: string, _userId: string, orgId: string) {
  const existing = await getBeaconById(id, orgId);
  if (!existing) throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);

  if (existing.status !== 'Archived') {
    throw new BeaconError(
      'INVALID_TRANSITION',
      `Cannot restore a beacon with status '${existing.status}'; must be Archived`,
    );
  }

  const expiryDays = await resolveDefaultExpiryDays(
    existing.organization_id,
    existing.project_id,
  );
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  const [beacon] = await db
    .update(beaconEntries)
    .set({
      status: 'Active',
      expires_at: expiresAt,
      last_verified_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(beaconEntries.id, id))
    .returning();

  return beacon!;
}

// ---------------------------------------------------------------------------
// Project membership helper
// ---------------------------------------------------------------------------

/**
 * Return the set of project IDs the user is a member of.
 */
export async function getUserProjectIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.user_id, userId));
  return new Set(rows.map((r) => r.project_id));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function getBeaconById(id: string, orgId: string) {
  const [beacon] = await db
    .select()
    .from(beaconEntries)
    .where(and(eq(beaconEntries.id, id), eq(beaconEntries.organization_id, orgId)))
    .limit(1);
  return beacon ?? null;
}
