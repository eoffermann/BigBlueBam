/**
 * Blip saved-view CRUD (Blip §7.2, §15). A view is a reusable filter/sort/column
 * spec over one (tracked_app, report_type). `scope` controls sharing: 'private'
 * is visible only to its owner, 'org' to anyone who can_access the app. Org-
 * shared edits require the owner or an admin. Every query is org-scoped.
 */
import { and, eq, or, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blipSavedViews } from '../db/schema/index.js';
import { getApp } from './app.service.js';
import { NotFoundError, ForbiddenError, ValidationError } from './errors.js';

const SCOPES = new Set(['private', 'org']);

export interface CreateViewInput {
  tracked_app_id: string;
  report_type: string;
  name: string;
  scope: string;
  spec: unknown;
  is_default?: boolean;
}

export interface UpdateViewInput {
  name?: string;
  scope?: string;
  spec?: unknown;
  is_default?: boolean;
}

export async function createView(orgId: string, userId: string, input: CreateViewInput) {
  if (!SCOPES.has(input.scope)) throw new ValidationError(`Invalid scope: ${input.scope}`);
  // Org-scope the parent app (throws NotFoundError when it is not in this org).
  await getApp(input.tracked_app_id, orgId);
  const rows = await db
    .insert(blipSavedViews)
    .values({
      org_id: orgId,
      tracked_app_id: input.tracked_app_id,
      report_type: input.report_type,
      name: input.name,
      owner_id: userId,
      scope: input.scope,
      is_default: input.is_default ?? false,
      spec: input.spec,
    })
    .returning();
  return rows[0]!;
}

/** List views for a (app, report_type) visible to the user: org-shared or owned. */
export async function listViews(appId: string, orgId: string, reportType: string, userId: string) {
  await getApp(appId, orgId);
  return db
    .select()
    .from(blipSavedViews)
    .where(
      and(
        eq(blipSavedViews.tracked_app_id, appId),
        eq(blipSavedViews.org_id, orgId),
        eq(blipSavedViews.report_type, reportType),
        or(eq(blipSavedViews.scope, 'org'), eq(blipSavedViews.owner_id, userId)),
      ),
    )
    .orderBy(desc(blipSavedViews.is_default), desc(blipSavedViews.updated_at));
}

async function getView(viewId: string, orgId: string) {
  const rows = await db
    .select()
    .from(blipSavedViews)
    .where(and(eq(blipSavedViews.id, viewId), eq(blipSavedViews.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('View not found');
  return rows[0]!;
}

/**
 * Edit a view. Only the owner or an admin may edit; this single rule also
 * satisfies "org-shared edits require owner/admin" since a non-owner non-admin
 * can never edit either a private or an org-shared view.
 */
export async function updateView(
  viewId: string,
  orgId: string,
  userId: string,
  isAdmin: boolean,
  input: UpdateViewInput,
) {
  const view = await getView(viewId, orgId);
  if (view.owner_id !== userId && !isAdmin) {
    throw new ForbiddenError('Only the view owner or an admin may edit this view');
  }
  if (input.scope !== undefined && !SCOPES.has(input.scope)) {
    throw new ValidationError(`Invalid scope: ${input.scope}`);
  }
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.scope !== undefined) patch.scope = input.scope;
  if (input.spec !== undefined) patch.spec = input.spec;
  if (input.is_default !== undefined) patch.is_default = input.is_default;
  const rows = await db
    .update(blipSavedViews)
    .set(patch)
    .where(and(eq(blipSavedViews.id, viewId), eq(blipSavedViews.org_id, orgId)))
    .returning();
  return rows[0]!;
}

/** Delete a view. Only the owner or an admin may delete. */
export async function deleteView(viewId: string, orgId: string, userId: string, isAdmin: boolean) {
  const view = await getView(viewId, orgId);
  if (view.owner_id !== userId && !isAdmin) {
    throw new ForbiddenError('Only the view owner or an admin may delete this view');
  }
  await db.delete(blipSavedViews).where(and(eq(blipSavedViews.id, viewId), eq(blipSavedViews.org_id, orgId)));
  return { id: viewId, deleted: true };
}
