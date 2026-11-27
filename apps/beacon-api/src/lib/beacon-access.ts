import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projectMemberships, projects } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// The one Beacon access rule (#299).
//
// Every Beacon entry write path asks this module what the caller may do with a
// row: the HTTP read and edit guards (middleware/authorize.ts), the Yjs
// co-editing socket (ws/auth.ts), the slug upsert (services/entry-upsert.service.ts,
// which also backs the beacon_upsert_by_slug MCP tool) and getBeacon. Before
// #299 the rule was hand-copied into three of those places and absent from the
// upsert, so any Member could overwrite a Private or admin-owned article by slug.
//
// Levels:
//   'none' - the caller cannot read the row. Callers answer 404 (or, on the
//            upsert, a neutral 409) so a Private row's existence never leaks.
//   'read' - the caller can read it but not edit it. Callers answer 403.
//   'edit' - the caller can read and edit it.
//
// Read:
//   - SuperUser: always.
//   - Org isolation: the row must belong to the caller's org.
//   - Public / Organization visibility: any org member.
//   - Project visibility: owner/creator, or a member of the row's project.
//   - Private visibility: owner/creator only.
// Edit (only ever granted on top of read):
//   - SuperUser: always.
//   - A project-scoped row (project_id set, any visibility) additionally needs
//     the editor to be its owner/creator or a member of the project, whatever
//     their org role.
//   - Admin / Owner org role: any row they can read.
//   - Anyone else: only rows they own (owned_by) or created (created_by).
//
// Edit requiring read is deliberate: an org admin used to be able to PUT a
// colleague's Private article they could not GET. The socket already refused
// that, so the HTTP guard now matches it.
// ---------------------------------------------------------------------------

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

export function isOrgAdminRole(role: string): boolean {
  return roleLevel(role) >= roleLevel('admin');
}

export interface BeaconAccessSubject {
  id: string;
  org_id: string;
  role: string;
  is_superuser?: boolean;
}

export interface BeaconAccessTarget {
  organization_id: string;
  project_id: string | null;
  owned_by: string;
  created_by: string;
  visibility: string;
}

export type BeaconAccessLevel = 'none' | 'read' | 'edit';

/** Anything with a `select` builder: the db handle or a transaction. */
type Executor = Pick<typeof db, 'select'>;

/**
 * The pure rule. `isProjectMember` is whether the subject belongs to the row's
 * project (ignored when the row has no project).
 */
export function beaconAccessLevel(
  subject: BeaconAccessSubject,
  beacon: BeaconAccessTarget,
  isProjectMember: boolean,
): BeaconAccessLevel {
  if (subject.is_superuser) return 'edit';
  if (beacon.organization_id !== subject.org_id) return 'none';

  const isOwnerOrCreator = beacon.owned_by === subject.id || beacon.created_by === subject.id;
  const member = beacon.project_id ? isProjectMember : false;

  let canRead: boolean;
  switch (beacon.visibility) {
    case 'Public':
    case 'Organization':
      canRead = true;
      break;
    case 'Project':
      canRead = isOwnerOrCreator || (beacon.project_id ? member : true);
      break;
    case 'Private':
      canRead = isOwnerOrCreator;
      break;
    default:
      canRead = false;
  }
  if (!canRead) return 'none';

  if (beacon.project_id && !isOwnerOrCreator && !member) return 'read';
  if (isOrgAdminRole(subject.role)) return 'edit';
  if (isOwnerOrCreator) return 'edit';
  return 'read';
}

/** Whether the subject is a member of the project. */
export async function isProjectMember(
  userId: string,
  projectId: string,
  executor: Executor = db,
): Promise<boolean> {
  const [membership] = await executor
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.project_id, projectId), eq(projectMemberships.user_id, userId)))
    .limit(1);
  return Boolean(membership);
}

/**
 * Resolve the subject's access level on a row, looking up project membership
 * only when the answer depends on it.
 */
export async function resolveBeaconAccess(
  subject: BeaconAccessSubject,
  beacon: BeaconAccessTarget,
  executor: Executor = db,
): Promise<BeaconAccessLevel> {
  const isOwnerOrCreator = beacon.owned_by === subject.id || beacon.created_by === subject.id;
  const needsMembership =
    !subject.is_superuser &&
    beacon.organization_id === subject.org_id &&
    Boolean(beacon.project_id) &&
    !isOwnerOrCreator;
  const member = needsMembership
    ? await isProjectMember(subject.id, beacon.project_id as string, executor)
    : false;
  return beaconAccessLevel(subject, beacon, member);
}

export class BeaconCreateDenied extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'BeaconCreateDenied';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * The create rule, shared by POST /beacons and the create branch of the slug
 * upsert. An entry with no project is an org-level entry any caller holding the
 * create permission may make. An entry filed under a project needs the project
 * to belong to the caller's org (404 otherwise, so another org's project ids are
 * not confirmed) and the caller to be a member of it or an org admin/owner
 * (403), the same membership the edit rule asks of a project-scoped row.
 */
export async function assertCanCreateBeacon(
  subject: BeaconAccessSubject,
  projectId: string | null | undefined,
  executor: Executor = db,
): Promise<void> {
  if (!projectId || subject.is_superuser) return;
  const [project] = await executor
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, subject.org_id)))
    .limit(1);
  if (!project) throw new BeaconCreateDenied('NOT_FOUND', 'Project not found', 404);
  if (isOrgAdminRole(subject.role)) return;
  if (!(await isProjectMember(subject.id, projectId, executor))) {
    throw new BeaconCreateDenied(
      'FORBIDDEN',
      'You must be a member of the project to file a beacon under it',
      403,
    );
  }
}
