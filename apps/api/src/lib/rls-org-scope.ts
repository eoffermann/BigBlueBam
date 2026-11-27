/**
 * Route-level org binding for requests that have no signed-in user (#338).
 *
 * The rls plugin binds app.current_org_id from request.user. Server-to-server
 * and webhook routes have no request.user, so under BBB_RLS_ENFORCE=1 they read
 * nothing from org-gated tables and every org-gated write fails its policy.
 * Such a route declares where its org comes from:
 *
 *   fastify.post('/tasks', { config: { rlsOrgScope: orgOfProjectIn('body', 'project_id') }, ... })
 *
 * and the rls plugin (enforce mode only) calls the resolver and binds the
 * result on the request's reserved connection exactly as it does for a signed-in
 * user. The route's own auth guard still runs and still decides whether the
 * request is allowed; the resolver only reads the org id its payload names, and
 * an unresolvable payload binds nothing, so the route sees no org rows (fail
 * closed). Under the advisory default the resolver is never called.
 *
 * Work that is not a whole route (creating an org, a token-authenticated feed)
 * binds per operation with runInOrgScope in db/index.ts instead.
 *
 * projects and tasks are org-gated, so their owning org is read through the
 * SECURITY DEFINER functions from migration 0325.
 */
import type { FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';

export type RlsOrgResolver = (request: FastifyRequest) => Promise<string | null>;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Where an unauthenticated request's org comes from (#338). See lib/rls-org-scope.ts. */
    rlsOrgScope?: RlsOrgResolver;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Source = 'body' | 'params';

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as T[];
}

/** A uuid read from request.body / request.params at a dotted path, else null. */
export function uuidAt(request: FastifyRequest, source: Source, path: string): string | null {
  let cur: unknown = source === 'body' ? request.body : request.params;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && UUID_RE.test(cur) ? cur : null;
}

/** The org that owns a project (definer lookup; the project row itself is org-gated). */
export async function orgOfProject(projectId: string): Promise<string | null> {
  const raw = await db.execute(sql`SELECT rls_org_of_project(${projectId}::uuid) AS org_id`);
  return rowsOf<{ org_id: string | null }>(raw)[0]?.org_id ?? null;
}

/** The org that owns a task, through its project. */
export async function orgOfTask(taskId: string): Promise<string | null> {
  const raw = await db.execute(sql`SELECT rls_org_of_task(${taskId}::uuid) AS org_id`);
  return rowsOf<{ org_id: string | null }>(raw)[0]?.org_id ?? null;
}

/** A user's home org (users is not org-gated). */
export async function homeOrgOfUser(userId: string): Promise<string | null> {
  const [row] = await db.select({ org_id: users.org_id }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.org_id ?? null;
}

/** The org id named directly in the payload. */
export function orgIdIn(source: Source, path = 'org_id'): RlsOrgResolver {
  return async (request) => uuidAt(request, source, path);
}

/** The org that owns the project the payload names. */
export function orgOfProjectIn(source: Source, path: string): RlsOrgResolver {
  return async (request) => {
    const id = uuidAt(request, source, path);
    return id ? orgOfProject(id) : null;
  };
}

/** The org that owns the task the payload names. */
export function orgOfTaskIn(source: Source, path: string): RlsOrgResolver {
  return async (request) => {
    const id = uuidAt(request, source, path);
    return id ? orgOfTask(id) : null;
  };
}

/** The home org of the user the payload names. */
export function homeOrgOfUserIn(source: Source, path: string): RlsOrgResolver {
  return async (request) => {
    const id = uuidAt(request, source, path);
    return id ? homeOrgOfUser(id) : null;
  };
}

/** The first resolver that yields an org. */
export function firstOrg(...resolvers: RlsOrgResolver[]): RlsOrgResolver {
  return async (request) => {
    for (const r of resolvers) {
      const org = await r(request);
      if (org) return org;
    }
    return null;
  };
}
