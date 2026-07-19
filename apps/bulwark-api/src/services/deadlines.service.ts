import { and, eq, lte, sql, type SQL } from 'drizzle-orm';
import type { BulwarkDischargeInput } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { bulwarkContracts, bulwarkNoticeDeadlines } from '../db/schema/index.js';
import { decodeCursor, encodeCursor, keysetOrder, keysetPredicate } from '../lib/pagination.js';
import { memberProjectIds } from '../lib/project-scope.js';
import { loadScopedContract } from './contracts.service.js';
import { isAdminViewer, type Viewer } from './types.js';
import { NotFoundError, ValidationFailure } from '../lib/errors.js';

type DeadlineRow = typeof bulwarkNoticeDeadlines.$inferSelect;

async function deadlineScope(viewer: Viewer): Promise<SQL | undefined> {
  const orgPred = eq(bulwarkNoticeDeadlines.organization_id, viewer.org_id);
  if (isAdminViewer(viewer)) return orgPred;
  const ids = await memberProjectIds(viewer.id);
  const projPred =
    ids.length === 0
      ? sql`${bulwarkContracts.project_id} IS NULL`
      : sql`(${bulwarkContracts.project_id} IS NULL OR ${bulwarkContracts.project_id} IN ${ids})`;
  return and(orgPred, projPred);
}

export interface ListDeadlinesOpts {
  cursor?: string;
  limit: number;
  status?: string;
  contractId?: string;
  dueBefore?: string;
  projectId?: string;
}

// Strip the notice_draft body for callers who do not hold bulwark.notice.draft (SK2). The
// route passes includeNoticeBody based on the caller's permission tier.
function projectDeadline(row: DeadlineRow, includeNoticeBody: boolean) {
  return {
    ...row,
    notice_draft: includeNoticeBody ? row.notice_draft : null,
  };
}

export async function listDeadlines(
  viewer: Viewer,
  opts: ListDeadlinesOpts,
  includeNoticeBody: boolean,
) {
  const scope = await deadlineScope(viewer);
  const cursor = decodeCursor(opts.cursor);
  const conds: (SQL | undefined)[] = [
    scope,
    keysetPredicate(bulwarkNoticeDeadlines.created_at, bulwarkNoticeDeadlines.id, cursor),
  ];
  if (opts.status) conds.push(eq(bulwarkNoticeDeadlines.status, opts.status));
  if (opts.contractId) conds.push(eq(bulwarkNoticeDeadlines.contract_id, opts.contractId));
  if (opts.projectId) conds.push(eq(bulwarkContracts.project_id, opts.projectId));
  if (opts.dueBefore) conds.push(lte(bulwarkNoticeDeadlines.due_at, new Date(opts.dueBefore)));

  const rows = await db
    .select({ d: bulwarkNoticeDeadlines })
    .from(bulwarkNoticeDeadlines)
    .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkNoticeDeadlines.contract_id))
    .where(and(...conds.filter(Boolean).map((c) => c as SQL)))
    .orderBy(...keysetOrder(bulwarkNoticeDeadlines.created_at, bulwarkNoticeDeadlines.id))
    .limit(opts.limit + 1);

  const flat = rows.map((r) => r.d);
  const hasMore = flat.length > opts.limit;
  const page = hasMore ? flat.slice(0, opts.limit) : flat;
  const last = page[page.length - 1];
  return {
    data: page.map((r) => projectDeadline(r, includeNoticeBody)),
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export async function loadScopedDeadline(viewer: Viewer, id: string): Promise<DeadlineRow> {
  const [row] = await db
    .select()
    .from(bulwarkNoticeDeadlines)
    .where(
      and(
        eq(bulwarkNoticeDeadlines.organization_id, viewer.org_id),
        eq(bulwarkNoticeDeadlines.id, id),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError('Deadline not found');
  await loadScopedContract(viewer, row.contract_id); // project-scope guard
  return row;
}

export async function getDeadline(viewer: Viewer, id: string, includeNoticeBody: boolean) {
  const row = await loadScopedDeadline(viewer, id);
  return projectDeadline(row, includeNoticeBody);
}

// Mark a deadline discharged or waived (spec 5.1). waive is destructive: the confirm token is
// enforced at the MCP tool layer; a light confirm flag guards the REST path.
export async function dischargeDeadline(
  viewer: Viewer,
  id: string,
  input: BulwarkDischargeInput,
): Promise<DeadlineRow> {
  const row = await loadScopedDeadline(viewer, id);
  if (input.outcome === 'waived' && input.confirm !== true)
    throw new ValidationFailure('Waiving a deadline requires confirm=true', 'CONFIRM_REQUIRED');
  if (row.status !== 'open')
    throw new ValidationFailure(`Deadline is already ${row.status}`, 'NOT_OPEN');

  const [updated] = await db
    .update(bulwarkNoticeDeadlines)
    .set({
      status: input.outcome,
      discharged_at: input.outcome === 'discharged' ? new Date() : null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(bulwarkNoticeDeadlines.organization_id, viewer.org_id),
        eq(bulwarkNoticeDeadlines.id, id),
        eq(bulwarkNoticeDeadlines.status, 'open'),
      ),
    )
    .returning();
  if (!updated) throw new ValidationFailure('Deadline was already decided', 'NOT_OPEN');
  return updated as DeadlineRow;
}
