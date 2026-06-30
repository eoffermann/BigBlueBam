/**
 * Tracked-app CRUD + lifecycle (Blip §3, §15). A tracked app is the unit of
 * control: it owns the collection on/off switch, the default rate limit, the
 * transform version, and is the gating entity for visibility. Every query is
 * org-scoped; lifecycle changes emit Bolt events on the `blip` source.
 */
import { and, eq, desc, sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { blipTrackedApps, blipFieldCatalog } from '../db/schema/index.js';
import { NotFoundError } from './errors.js';

export interface CreateAppInput {
  name: string;
  description?: string | null;
  project_id?: string | null;
  collection_enabled?: boolean;
  rate_limit?: Record<string, unknown> | null;
}

export interface UpdateAppInput {
  name?: string;
  description?: string | null;
  project_id?: string | null;
}

export async function createApp(input: CreateAppInput, orgId: string, userId: string) {
  const rows = await db
    .insert(blipTrackedApps)
    .values({
      org_id: orgId,
      name: input.name,
      description: input.description ?? null,
      project_id: input.project_id ?? null,
      collection_enabled: input.collection_enabled ?? true,
      rate_limit: input.rate_limit ?? null,
      owner_id: userId,
      created_by: userId,
    })
    .returning();
  const app = rows[0]!;
  void publishBoltEvent(
    'tracked_app.created',
    'blip',
    { tracked_app_id: app.id, name: app.name },
    orgId,
    userId,
  );
  return app;
}

export async function listApps(orgId: string) {
  return db
    .select()
    .from(blipTrackedApps)
    .where(eq(blipTrackedApps.org_id, orgId))
    .orderBy(desc(blipTrackedApps.created_at));
}

export async function getApp(id: string, orgId: string) {
  const rows = await db
    .select()
    .from(blipTrackedApps)
    .where(and(eq(blipTrackedApps.id, id), eq(blipTrackedApps.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Tracked app not found');
  return rows[0]!;
}

export async function updateApp(id: string, orgId: string, input: UpdateAppInput) {
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.project_id !== undefined) patch.project_id = input.project_id;
  const rows = await db
    .update(blipTrackedApps)
    .set(patch)
    .where(and(eq(blipTrackedApps.id, id), eq(blipTrackedApps.org_id, orgId)))
    .returning();
  if (rows.length === 0) throw new NotFoundError('Tracked app not found');
  return rows[0]!;
}

export async function deleteApp(id: string, orgId: string) {
  // Ensure the app exists in this org first (also gives a clean 404).
  await getApp(id, orgId);
  // Children (keys, transforms, field catalog, …) cascade via FK on_delete.
  await db
    .delete(blipTrackedApps)
    .where(and(eq(blipTrackedApps.id, id), eq(blipTrackedApps.org_id, orgId)));
  return { id, deleted: true };
}

/** Toggle collection on/off. Emits collection.started / collection.stopped. */
export async function setCollection(id: string, orgId: string, enabled: boolean, userId: string) {
  const rows = await db
    .update(blipTrackedApps)
    .set({ collection_enabled: enabled, updated_at: new Date() })
    .where(and(eq(blipTrackedApps.id, id), eq(blipTrackedApps.org_id, orgId)))
    .returning();
  if (rows.length === 0) throw new NotFoundError('Tracked app not found');
  const app = rows[0]!;
  void publishBoltEvent(
    enabled ? 'collection.started' : 'collection.stopped',
    'blip',
    { tracked_app_id: app.id, name: app.name },
    orgId,
    userId,
  );
  return app;
}

/** Set the app-default token-bucket params (Blip §11.1). */
export async function setRateLimit(
  id: string,
  orgId: string,
  rateLimit: Record<string, unknown> | null,
) {
  const rows = await db
    .update(blipTrackedApps)
    .set({ rate_limit: rateLimit, updated_at: new Date() })
    .where(and(eq(blipTrackedApps.id, id), eq(blipTrackedApps.org_id, orgId)))
    .returning();
  if (rows.length === 0) throw new NotFoundError('Tracked app not found');
  return rows[0]!;
}

/** Distinct observed report types for an app, from the field catalog (Blip §6). */
export async function listReportTypes(id: string, orgId: string): Promise<string[]> {
  await getApp(id, orgId);
  const rows = await db
    .selectDistinct({ report_type: blipFieldCatalog.report_type })
    .from(blipFieldCatalog)
    .where(and(eq(blipFieldCatalog.tracked_app_id, id), eq(blipFieldCatalog.org_id, orgId)))
    .orderBy(sql`report_type ASC`);
  return rows.map((r) => r.report_type);
}
