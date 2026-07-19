import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bulwarkContracts, bulwarkWaiverRisks } from '../db/schema/index.js';
import { decodeCursor, encodeCursor, keysetOrder, keysetPredicate } from '../lib/pagination.js';
import { memberProjectIds } from '../lib/project-scope.js';
import { isAdminViewer, type Viewer } from './types.js';

const SEVERITY_RANK = sql`case ${bulwarkWaiverRisks.severity}
  when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end`;

async function waiverScope(viewer: Viewer): Promise<SQL | undefined> {
  const orgPred = eq(bulwarkWaiverRisks.organization_id, viewer.org_id);
  if (isAdminViewer(viewer)) return orgPred;
  const ids = await memberProjectIds(viewer.id);
  const projPred =
    ids.length === 0
      ? sql`${bulwarkContracts.project_id} IS NULL`
      : sql`(${bulwarkContracts.project_id} IS NULL OR ${bulwarkContracts.project_id} IN ${ids})`;
  return and(orgPred, projPred);
}

// Open waiver risks, project-scoped, sorted by severity desc then recency (spec 5.1).
export async function listWaiverRisks(
  viewer: Viewer,
  opts: { cursor?: string; limit: number; status?: string; contractId?: string },
) {
  const scope = await waiverScope(viewer);
  const cursor = decodeCursor(opts.cursor);
  const conds: (SQL | undefined)[] = [
    scope,
    keysetPredicate(bulwarkWaiverRisks.created_at, bulwarkWaiverRisks.id, cursor),
  ];
  conds.push(eq(bulwarkWaiverRisks.status, opts.status ?? 'open'));
  if (opts.contractId) conds.push(eq(bulwarkWaiverRisks.contract_id, opts.contractId));

  const rows = await db
    .select({ w: bulwarkWaiverRisks })
    .from(bulwarkWaiverRisks)
    .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkWaiverRisks.contract_id))
    .where(and(...conds.filter(Boolean).map((c) => c as SQL)))
    // sort=-severity (spec 5.1): highest severity first, then the created_at/id keyset.
    .orderBy(desc(SEVERITY_RANK), ...keysetOrder(bulwarkWaiverRisks.created_at, bulwarkWaiverRisks.id))
    .limit(opts.limit + 1);

  const flat = rows.map((r) => r.w);
  const hasMore = flat.length > opts.limit;
  const page = hasMore ? flat.slice(0, opts.limit) : flat;
  const last = page[page.length - 1];
  return {
    data: page,
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
