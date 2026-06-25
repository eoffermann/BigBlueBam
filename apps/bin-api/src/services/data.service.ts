// Bin structured-data editor service (Bin master §10/§11).
//
// The canonical artifact is always the immutable asset version (the native-format
// bytes). This service reads those bytes through @bigbluebam/structured-data,
// exposes them as records/tree, and writes edits back by minting a NEW immutable
// version (D-3) — never an in-place mutation. The agent-facing REST surface
// (read/patch/append/commit/comments) is fully deterministic; the live human
// co-editing layer (Yjs over /bin/ws) is a later increment that buffers into
// bin_data_sessions.yjs_state before committing through this same commit path.

import { and, eq, desc } from 'drizzle-orm';
import {
  parseAsset,
  encode,
  inferSchema,
  type Format,
  type Dialect,
  type InferredSchema,
} from '@bigbluebam/structured-data';
import { db } from '../db/index.js';
import { binAssets, binDataSessions, binDataSchemas, binDataComments } from '../db/schema/index.js';
import { readObject } from '../lib/storage.js';
import * as assetService from './asset.service.js';
import { NotFoundError, ConflictError } from './asset.service.js';

export { NotFoundError, ConflictError } from './asset.service.js';

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

type AssetRow = typeof binAssets.$inferSelect;

/** Resolve the structured-data Format from an asset's content-type/filename, or
 *  null when the asset is not a structured-data file the editor understands. */
export function detectFormat(asset: { content_type: string | null; name: string }): Format | null {
  const ct = (asset.content_type ?? '').toLowerCase();
  const name = (asset.name ?? '').toLowerCase();
  const ext = (re: RegExp) => re.test(name);
  if (ext(/\.(jsonl|ndjson)$/)) return 'jsonl';
  if (ext(/\.json$/)) return 'json';
  if (ext(/\.tsv$/)) return 'tsv';
  if (ext(/\.csv$/)) return 'csv';
  if (ext(/\.(ya?ml)$/)) return 'yaml';
  if (ct.includes('jsonl') || ct.includes('ndjson')) return 'jsonl';
  if (ct.includes('tab-separated')) return 'tsv';
  if (ct.includes('csv')) return 'csv';
  if (ct.includes('yaml') || ct.includes('yml')) return 'yaml';
  if (ct.includes('json')) return 'json';
  return null;
}

/** Load + parse an asset's current version. Gated on scan_status (§9.3): an
 *  unscanned/infected asset is never parsed. */
async function loadParsed(asset: AssetRow) {
  if (!asset.current_version_id || !asset.object_key) {
    throw new NotFoundError('Asset has no uploaded content yet');
  }
  if (asset.scan_status !== 'clean' && asset.scan_status !== 'skipped') {
    throw new ConflictError(`Asset is not readable (scan status: ${asset.scan_status})`);
  }
  const format = detectFormat(asset);
  if (!format) {
    throw new UnsupportedFormatError(`Asset "${asset.name}" is not a structured-data format`);
  }
  const buf = await readObject(asset.object_key);
  return parseAsset(buf.toString('utf8'), format);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ReadOptions {
  where?: Record<string, string>;
  columns?: string[];
  limit?: number;
  offset?: number;
}

export async function readData(assetId: string, orgId: string, opts: ReadOptions = {}) {
  const asset = await assetService.getAsset(assetId, orgId);
  const parsed = await loadParsed(asset as AssetRow);

  if (parsed.shape === 'tree') {
    return { shape: 'tree' as const, dialect: parsed.dialect, data: parsed.data };
  }

  const allColumns = parsed.columns ?? [];
  let rows = parsed.rows ?? [];

  // Equality filter across provided where keys (stringified compare).
  if (opts.where && Object.keys(opts.where).length > 0) {
    const where = opts.where;
    rows = rows.filter((r) =>
      Object.entries(where).every(([k, v]) => String(r[k] ?? '') === String(v)),
    );
  }

  const total = rows.length;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 1000;
  let page = rows.slice(offset, offset + limit);

  // Column projection.
  const columns = opts.columns?.length ? opts.columns.filter((c) => allColumns.includes(c)) : allColumns;
  if (opts.columns?.length) {
    page = page.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of columns) o[c] = r[c] ?? null;
      return o;
    });
  }

  const schema = inferSchema(parsed.rows ?? [], allColumns);
  return {
    shape: 'record' as const,
    dialect: parsed.dialect,
    columns,
    rows: page,
    total,
    offset,
    limit,
    schema,
  };
}

// ---------------------------------------------------------------------------
// Commit (mint a new immutable version from edited data)
// ---------------------------------------------------------------------------

/**
 * Encode `data` with the asset's dialect and store it as a new immutable version
 * via the proxied upload path. Structured-editor commits are trusted (server
 * re-serialization of already-clean structured text), so the new version is
 * marked `clean` immediately for read-after-write (D-8) rather than waiting on
 * the AV sweep.
 */
async function commitVersion(
  assetId: string,
  orgId: string,
  userId: string,
  data: unknown,
  dialect: Dialect,
  asset: AssetRow,
) {
  const text = encode(data, dialect);
  const result = await assetService.uploadVersionBytes(assetId, orgId, userId, Buffer.from(text, 'utf8'), {
    filename: asset.name,
    content_type: asset.content_type ?? 'application/octet-stream',
  });
  // Trusted derived artifact — mark clean now (only if still pending).
  await db
    .update(binAssets)
    .set({ scan_status: 'clean' })
    .where(and(eq(binAssets.id, assetId), eq(binAssets.scan_status, 'pending')));
  // Reflect the clean state in the returned asset (uploadVersionBytes captured
  // it as 'pending' before this flip), so the mutation response is accurate.
  if (result.asset && result.asset.scan_status === 'pending') {
    result.asset.scan_status = 'clean';
  }
  return result;
}

export interface RowPatch {
  /** 0-based index into the current row order. */
  index: number;
  /** Column -> new value. */
  set: Record<string, unknown>;
}

/** Apply cell patches to record-shaped data and commit a new version. */
export async function patchRows(
  assetId: string,
  orgId: string,
  userId: string,
  patches: RowPatch[],
) {
  const asset = (await assetService.getAsset(assetId, orgId)) as AssetRow;
  const parsed = await loadParsed(asset);
  if (parsed.shape !== 'record') {
    throw new ConflictError('patchRows is only valid for record-shaped assets');
  }
  const rows = (parsed.rows ?? []).map((r) => ({ ...r }));
  for (const p of patches) {
    if (p.index < 0 || p.index >= rows.length) {
      throw new ConflictError(`Row index ${p.index} is out of range (0..${rows.length - 1})`);
    }
    Object.assign(rows[p.index]!, p.set);
  }
  const result = await commitVersion(assetId, orgId, userId, rows, parsed.dialect, asset);
  return { version: result.version, asset: result.asset, row_count: rows.length };
}

/** Append rows to record-shaped data and commit a new version. */
export async function appendRows(
  assetId: string,
  orgId: string,
  userId: string,
  newRows: Record<string, unknown>[],
) {
  const asset = (await assetService.getAsset(assetId, orgId)) as AssetRow;
  const parsed = await loadParsed(asset);
  if (parsed.shape !== 'record') {
    throw new ConflictError('appendRows is only valid for record-shaped assets');
  }
  const rows = [...(parsed.rows ?? []), ...newRows];
  const result = await commitVersion(assetId, orgId, userId, rows, parsed.dialect, asset);
  return { version: result.version, asset: result.asset, row_count: rows.length, appended: newRows.length };
}

// ---------------------------------------------------------------------------
// Tree edits (path-based set on tree-shaped assets)
// ---------------------------------------------------------------------------

export interface TreePatch {
  /** Path to the value, e.g. ["passengers", 2, "vip"] or ["charter", "operator"]. */
  path: (string | number)[];
  /** New value. Strings are coerced to the existing leaf's type (number/boolean). */
  value?: unknown;
}

/** Coerce an incoming (usually string) value to the type of the value it replaces,
 *  so editing a number cell keeps it a number and a boolean stays a boolean. */
function coerceToExisting(existing: unknown, incoming: unknown): unknown {
  if (typeof incoming !== 'string') return incoming;
  if (typeof existing === 'number') {
    const n = Number(incoming);
    return incoming.trim() !== '' && !Number.isNaN(n) ? n : incoming;
  }
  if (typeof existing === 'boolean') {
    if (incoming === 'true') return true;
    if (incoming === 'false') return false;
    return incoming;
  }
  return incoming;
}

function setAtPath(root: unknown, path: (string | number)[], value: unknown): void {
  if (path.length === 0) throw new ConflictError('Empty path');
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]!;
    if (cur == null || typeof cur !== 'object') {
      throw new ConflictError(`Path segment "${String(key)}" does not exist`);
    }
    cur = (cur as Record<string | number, unknown>)[key as never];
  }
  if (cur == null || typeof cur !== 'object') {
    throw new ConflictError('Path does not resolve to a container');
  }
  const last = path[path.length - 1]!;
  const container = cur as Record<string | number, unknown>;
  const existing = container[last as never];
  if (existing === undefined && !(last in container)) {
    throw new ConflictError(`Path key "${String(last)}" does not exist`);
  }
  (container as Record<string | number, unknown>)[last as never] = coerceToExisting(existing, value);
}

/** Apply value-set patches to a tree-shaped asset and commit a new version. */
export async function patchTree(
  assetId: string,
  orgId: string,
  userId: string,
  patches: TreePatch[],
) {
  const asset = (await assetService.getAsset(assetId, orgId)) as AssetRow;
  const parsed = await loadParsed(asset);
  if (parsed.shape !== 'tree') {
    throw new ConflictError('patchTree is only valid for tree-shaped assets');
  }
  // Clone so a failed patch midway does not leave the in-memory tree half-edited.
  const tree = structuredClone(parsed.data);
  for (const p of patches) {
    setAtPath(tree, p.path, p.value);
  }
  const result = await commitVersion(assetId, orgId, userId, tree, parsed.dialect, asset);
  return { version: result.version, asset: result.asset };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function pinnedSchema(assetId: string): Promise<{ source: string; schema: unknown } | null> {
  const rows = await db
    .select()
    .from(binDataSchemas)
    .where(and(eq(binDataSchemas.asset_id, assetId), eq(binDataSchemas.source, 'pinned')))
    .limit(1);
  return rows[0] ? { source: 'pinned', schema: rows[0].schema_json } : null;
}

/**
 * Open or resume the single active editing session for an asset (branch 'main').
 * Seeds shape/dialect/schema from the current version. Returns the ws room the
 * live editor dials.
 */
export async function openSession(assetId: string, orgId: string) {
  const asset = (await assetService.getAsset(assetId, orgId)) as AssetRow;
  const parsed = await loadParsed(asset);

  const pinned = await pinnedSchema(assetId);
  const schemaSource: 'pinned' | 'inferred' = pinned ? 'pinned' : 'inferred';
  const schema: unknown =
    pinned?.schema ??
    (parsed.shape === 'record'
      ? (inferSchema(parsed.rows ?? [], parsed.columns ?? []) as InferredSchema)
      : null);

  const existing = await db
    .select()
    .from(binDataSessions)
    .where(and(eq(binDataSessions.asset_id, assetId), eq(binDataSessions.branch, 'main')))
    .limit(1);

  let session = existing[0];
  if (!session) {
    const inserted = await db
      .insert(binDataSessions)
      .values({
        asset_id: assetId,
        base_version_id: asset.current_version_id!,
        branch: 'main',
        shape: parsed.shape,
        dialect: parsed.dialect,
        schema_source: schemaSource,
        schema_json: (schema as object) ?? null,
      })
      .returning();
    session = inserted[0]!;
  }

  return {
    session_id: session.id,
    shape: parsed.shape,
    dialect: parsed.dialect,
    schema_source: schemaSource,
    schema,
    base_version_id: session.base_version_id,
    ws_room: `/bin/ws/${assetId}`,
  };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface CreateCommentInput {
  shape: 'record' | 'tree';
  anchor?: unknown;
  body: string;
  thread_parent_id?: string | null;
}

export async function createComment(
  assetId: string,
  orgId: string,
  userId: string,
  input: CreateCommentInput,
) {
  const asset = (await assetService.getAsset(assetId, orgId)) as AssetRow;
  const rows = await db
    .insert(binDataComments)
    .values({
      asset_id: assetId,
      version_id: asset.current_version_id ?? asset.id,
      shape: input.shape,
      anchor: (input.anchor ?? {}) as object,
      body: input.body,
      author_id: userId,
      thread_parent_id: input.thread_parent_id ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function listComments(assetId: string, orgId: string, includeResolved = false) {
  await assetService.getAsset(assetId, orgId); // org-scope guard
  const conds = [eq(binDataComments.asset_id, assetId)];
  if (!includeResolved) conds.push(eq(binDataComments.resolved, false));
  return db
    .select()
    .from(binDataComments)
    .where(and(...conds))
    .orderBy(desc(binDataComments.created_at));
}

export async function resolveComment(
  assetId: string,
  orgId: string,
  commentId: string,
  resolved: boolean,
) {
  await assetService.getAsset(assetId, orgId); // org-scope guard
  const rows = await db
    .update(binDataComments)
    .set({ resolved })
    .where(and(eq(binDataComments.id, commentId), eq(binDataComments.asset_id, assetId)))
    .returning();
  if (rows.length === 0) throw new NotFoundError('Comment not found');
  return rows[0]!;
}
