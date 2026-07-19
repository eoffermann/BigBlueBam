import { and, eq, sql, type SQL } from 'drizzle-orm';
import type {
  BulwarkCreateContractInput,
  BulwarkUpdateContractInput,
} from '@bigbluebam/shared';
import { db } from '../db/index.js';
import {
  bulwarkContracts,
  bulwarkObligations,
  bulwarkNoticeDeadlines,
  entityLinks,
} from '../db/schema/index.js';
import {
  decodeCursor,
  encodeCursor,
  keysetOrder,
  keysetPredicate,
} from '../lib/pagination.js';
import { orgAndProjectScope, canAccessContractProject } from '../lib/project-scope.js';
import { resolveCounterpartyGoldenId } from '../lib/braid-resolve.client.js';
import { enqueueExtraction } from '../lib/queue.js';
import { getSettings } from './settings.service.js';
import { NotFoundError, ProjectScopeError } from '../lib/errors.js';
import type { Viewer } from './types.js';

type ContractRow = typeof bulwarkContracts.$inferSelect;

export interface ListContractsOpts {
  cursor?: string;
  limit: number;
  status?: string;
  projectId?: string;
}

export async function listContracts(viewer: Viewer, opts: ListContractsOpts) {
  const scope = await orgAndProjectScope(
    viewer,
    bulwarkContracts.organization_id,
    bulwarkContracts.project_id,
  );
  const cursor = decodeCursor(opts.cursor);
  const conds: (SQL | undefined)[] = [
    scope,
    keysetPredicate(bulwarkContracts.created_at, bulwarkContracts.id, cursor),
  ];
  if (opts.status) conds.push(eq(bulwarkContracts.status, opts.status));
  if (opts.projectId) conds.push(eq(bulwarkContracts.project_id, opts.projectId));

  const rows = await db
    .select()
    .from(bulwarkContracts)
    .where(and(...conds.filter(Boolean).map((c) => c as SQL)))
    .orderBy(...keysetOrder(bulwarkContracts.created_at, bulwarkContracts.id))
    .limit(opts.limit + 1);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return {
    data: page,
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

// Load a contract in the caller's org, applying the write/detail project-scope guard. Throws
// NotFoundError when absent OR the viewer cannot see the owning project (never leak
// existence).
export async function loadScopedContract(viewer: Viewer, id: string): Promise<ContractRow> {
  const [row] = await db
    .select()
    .from(bulwarkContracts)
    .where(and(eq(bulwarkContracts.organization_id, viewer.org_id), eq(bulwarkContracts.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError('Contract not found');
  if (!(await canAccessContractProject(viewer, row.project_id)))
    throw new NotFoundError('Contract not found');
  return row;
}

export async function getContractWithRollup(viewer: Viewer, id: string) {
  const contract = await loadScopedContract(viewer, id);
  const [obligationRollup] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where ${bulwarkObligations.review_status} = 'pending_review')::int`,
      armed: sql<number>`count(*) filter (where ${bulwarkObligations.is_armed})::int`,
    })
    .from(bulwarkObligations)
    .where(eq(bulwarkObligations.contract_id, id));
  const [deadlineRollup] = await db
    .select({
      open: sql<number>`count(*) filter (where ${bulwarkNoticeDeadlines.status} = 'open')::int`,
      missed: sql<number>`count(*) filter (where ${bulwarkNoticeDeadlines.status} = 'missed')::int`,
    })
    .from(bulwarkNoticeDeadlines)
    .where(eq(bulwarkNoticeDeadlines.contract_id, id));
  const obligations = await db
    .select()
    .from(bulwarkObligations)
    .where(eq(bulwarkObligations.contract_id, id))
    .orderBy(bulwarkObligations.created_at);
  return {
    ...contract,
    obligations,
    rollup: {
      obligations: obligationRollup ?? { total: 0, pending: 0, armed: 0 },
      deadlines: deadlineRollup ?? { open: 0, missed: 0 },
    },
  };
}

// List obligations for one contract (project-scoped via the parent).
export async function listContractObligations(viewer: Viewer, contractId: string) {
  await loadScopedContract(viewer, contractId);
  return db
    .select()
    .from(bulwarkObligations)
    .where(eq(bulwarkObligations.contract_id, contractId))
    .orderBy(bulwarkObligations.created_at);
}

async function upsertEntityLink(
  orgId: string,
  contractId: string,
  dstType: string,
  dstId: string,
  createdBy: string,
  linkKind: 'related_to' | 'references' = 'related_to',
): Promise<void> {
  await db
    .insert(entityLinks)
    .values({
      org_id: orgId,
      src_type: 'bulwark.contract',
      src_id: contractId,
      dst_type: dstType,
      dst_id: dstId,
      link_kind: linkKind,
      created_by: createdBy,
    })
    .onConflictDoNothing();
}

// Register a contract from a Bin asset. The Bin can_access preflight (S3) happens in the
// route BEFORE this is called. Counterparty resolution via Braid (IN7) is a soft dependency:
// on failure it degrades to the raw bond.company id and the create still succeeds.
export async function createContract(
  viewer: Viewer,
  input: BulwarkCreateContractInput,
): Promise<ContractRow> {
  const settings = await getSettings(viewer.org_id);
  const timezone = input.timezone ?? settings.default_timezone;

  // Braid soft dependency: attempt to unify the counterparty, but never fail the create.
  if (input.counterparty_type && input.counterparty_id) {
    await resolveCounterpartyGoldenId({
      orgId: viewer.org_id,
      sourceType: input.counterparty_type,
      sourceId: input.counterparty_id,
      askerUserId: viewer.id,
    }).catch(() => null);
  }

  const [row] = await db
    .insert(bulwarkContracts)
    .values({
      organization_id: viewer.org_id,
      project_id: input.project_id ?? null,
      title: input.title,
      contract_kind: input.contract_kind,
      supersedes_contract_id: input.supersedes_contract_id ?? null,
      timezone,
      jurisdiction: input.jurisdiction ?? null,
      bin_asset_id: input.bin_asset_id,
      counterparty_type: input.counterparty_type ?? null,
      counterparty_id: input.counterparty_id ?? null,
      effective_date: input.effective_date ?? null,
      expiry_date: input.expiry_date ?? null,
      status: 'draft',
      extraction_status: 'pending',
      created_by: viewer.id,
    })
    .returning();
  const contract = row as ContractRow;

  await upsertEntityLink(
    viewer.org_id,
    contract.id,
    'bin.asset',
    contract.bin_asset_id,
    viewer.id,
    'references',
  );
  if (contract.counterparty_type && contract.counterparty_id) {
    await upsertEntityLink(
      viewer.org_id,
      contract.id,
      contract.counterparty_type,
      contract.counterparty_id,
      viewer.id,
    );
  }

  await enqueueExtraction({ org_id: viewer.org_id, contract_id: contract.id });
  return contract;
}

export async function updateContract(
  viewer: Viewer,
  id: string,
  input: BulwarkUpdateContractInput,
): Promise<ContractRow> {
  const contract = await loadScopedContract(viewer, id);
  // If the caller is moving the contract to a different project, they must be able to act on
  // the CURRENT project (already checked by loadScopedContract) AND the target project.
  if (input.project_id !== undefined && input.project_id !== contract.project_id) {
    if (!(await canAccessContractProject(viewer, input.project_id ?? null)))
      throw new ProjectScopeError('Not a member of the target project');
  }
  const patch: Record<string, unknown> = { updated_at: new Date() };
  for (const k of [
    'title',
    'timezone',
    'jurisdiction',
    'project_id',
    'counterparty_type',
    'counterparty_id',
    'effective_date',
    'expiry_date',
    'status',
  ] as const) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  const [row] = await db
    .update(bulwarkContracts)
    .set(patch)
    .where(and(eq(bulwarkContracts.organization_id, viewer.org_id), eq(bulwarkContracts.id, id)))
    .returning();
  return row as ContractRow;
}

// Delete a tracked contract (not the Bin asset). Cascades obligations and deadlines via the
// FK ON DELETE CASCADE. Owner/admin floor + confirm token enforced at the route/MCP layer.
export async function deleteContract(viewer: Viewer, id: string): Promise<void> {
  await loadScopedContract(viewer, id);
  await db
    .delete(bulwarkContracts)
    .where(and(eq(bulwarkContracts.organization_id, viewer.org_id), eq(bulwarkContracts.id, id)));
}

// Re-run extraction. Hash-skip is conditional and evaluated in the worker (ST6); here we
// just re-enqueue after the Bin preflight (done in the route).
export async function reExtract(viewer: Viewer, id: string): Promise<ContractRow> {
  const contract = await loadScopedContract(viewer, id);
  await enqueueExtraction({ org_id: viewer.org_id, contract_id: contract.id });
  return contract;
}
