import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { binFolders } from '../db/schema/index.js';

export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface CreateFolderInput {
  name: string;
  project_id?: string | null;
  parent_id?: string | null;
}

export async function listFolders(
  orgId: string,
  opts: { parent_id?: string | null; project_id?: string } = {},
) {
  const conditions = [eq(binFolders.org_id, orgId)];
  if (opts.parent_id === null) {
    conditions.push(isNull(binFolders.parent_id));
  } else if (typeof opts.parent_id === 'string') {
    conditions.push(eq(binFolders.parent_id, opts.parent_id));
  }
  if (opts.project_id) {
    conditions.push(eq(binFolders.project_id, opts.project_id));
  }
  return db
    .select()
    .from(binFolders)
    .where(and(...conditions))
    .orderBy(binFolders.name);
}

export async function getFolder(id: string, orgId: string) {
  const rows = await db
    .select()
    .from(binFolders)
    .where(and(eq(binFolders.id, id), eq(binFolders.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Folder not found');
  return rows[0]!;
}

export async function createFolder(input: CreateFolderInput, orgId: string, userId: string) {
  // Validate parent belongs to the same org if given.
  if (input.parent_id) {
    await getFolder(input.parent_id, orgId);
  }
  const rows = await db
    .insert(binFolders)
    .values({
      org_id: orgId,
      project_id: input.project_id ?? null,
      parent_id: input.parent_id ?? null,
      name: input.name,
      created_by: userId,
    })
    .returning();
  return rows[0]!;
}

export async function updateFolder(
  id: string,
  orgId: string,
  patch: { name?: string; parent_id?: string | null; project_id?: string | null },
) {
  await getFolder(id, orgId);
  if (patch.parent_id) {
    if (patch.parent_id === id) {
      throw new Error('A folder cannot be its own parent');
    }
    await getFolder(patch.parent_id, orgId);
  }
  const rows = await db
    .update(binFolders)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.parent_id !== undefined ? { parent_id: patch.parent_id } : {}),
      ...(patch.project_id !== undefined ? { project_id: patch.project_id } : {}),
    })
    .where(and(eq(binFolders.id, id), eq(binFolders.org_id, orgId)))
    .returning();
  if (rows.length === 0) throw new NotFoundError('Folder not found');
  return rows[0]!;
}

export async function deleteFolder(id: string, orgId: string) {
  const rows = await db
    .delete(binFolders)
    .where(and(eq(binFolders.id, id), eq(binFolders.org_id, orgId)))
    .returning({ id: binFolders.id });
  if (rows.length === 0) throw new NotFoundError('Folder not found');
}
