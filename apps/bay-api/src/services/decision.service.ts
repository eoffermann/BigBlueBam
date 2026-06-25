import { eq, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bayReviewDecisions } from '../db/schema/index.js';
import { getVersion } from './version.service.js';
import { ConflictError } from './errors.js';

const DECISIONS = new Set(['approved', 'rejected', 'changes_requested', 'pending']);

export interface SetDecisionInput {
  decision: 'approved' | 'rejected' | 'changes_requested' | 'pending';
  comment?: string | null;
}

export async function listDecisions(versionId: string, orgId: string) {
  // Org-scope via the version resolver (joins through bay_assets).
  await getVersion(versionId, orgId);
  return db
    .select()
    .from(bayReviewDecisions)
    .where(eq(bayReviewDecisions.version_id, versionId))
    .orderBy(asc(bayReviewDecisions.created_at));
}

/**
 * Upsert the caller's review decision for a version. One decision per reviewer
 * per version (unique (version_id, reviewer_id)): a reviewer changing their
 * mind updates the existing row rather than appending a new one.
 */
export async function setDecision(
  versionId: string,
  orgId: string,
  reviewerId: string,
  input: SetDecisionInput,
) {
  if (!DECISIONS.has(input.decision)) {
    throw new ConflictError(`Unsupported decision: ${input.decision}`);
  }
  await getVersion(versionId, orgId);
  const rows = await db
    .insert(bayReviewDecisions)
    .values({
      version_id: versionId,
      reviewer_id: reviewerId,
      decision: input.decision,
      comment: input.comment ?? null,
    })
    .onConflictDoUpdate({
      target: [bayReviewDecisions.version_id, bayReviewDecisions.reviewer_id],
      set: {
        decision: input.decision,
        comment: input.comment ?? null,
        updated_at: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}
