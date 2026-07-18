import { and, desc, eq, lt } from 'drizzle-orm';
import type { BraidCandidate } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { braidMatchCandidates } from '../db/schema/index.js';

// Review-queue reads (spec 5.1). braid.candidate.read is admin-tier by default, so the
// evidence value-refs (which are refs like "id_a#email", not raw PII) are returned as
// stored. TODO(M6): per-caller re-hydration of evidence refs for granted non-admins.

type CandidateRow = typeof braidMatchCandidates.$inferSelect;

function toCandidate(row: CandidateRow): BraidCandidate {
  return {
    id: row.id,
    profile_a_id: row.profile_a_id,
    profile_b_id: row.profile_b_id,
    score: Number(row.score),
    evidence: row.evidence as BraidCandidate['evidence'],
    rationale: row.rationale,
    status: row.status as BraidCandidate['status'],
    proposal_id: row.proposal_id,
    created_at: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString(),
  };
}

export interface ListCandidatesQuery {
  status?: string;
  limit: number;
  cursor?: string;
}

export async function listCandidates(
  orgId: string,
  query: ListCandidatesQuery,
): Promise<{ data: BraidCandidate[]; next_cursor: string | null }> {
  const conds = [eq(braidMatchCandidates.organization_id, orgId)];
  conds.push(eq(braidMatchCandidates.status, query.status ?? 'pending'));
  if (query.cursor) conds.push(lt(braidMatchCandidates.created_at, new Date(query.cursor)));

  const rows = await db
    .select()
    .from(braidMatchCandidates)
    .where(and(...conds))
    .orderBy(desc(braidMatchCandidates.score), desc(braidMatchCandidates.created_at))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const nextCursor =
    rows.length > query.limit
      ? (page[page.length - 1]!.created_at instanceof Date
          ? (page[page.length - 1]!.created_at as Date)
          : new Date(page[page.length - 1]!.created_at)
        ).toISOString()
      : null;

  return { data: page.map(toCandidate), next_cursor: nextCursor };
}

export async function getCandidate(orgId: string, id: string): Promise<BraidCandidate | null> {
  const [row] = await db
    .select()
    .from(braidMatchCandidates)
    .where(and(eq(braidMatchCandidates.id, id), eq(braidMatchCandidates.organization_id, orgId)))
    .limit(1);
  return row ? toCandidate(row) : null;
}
