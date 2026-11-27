// Who of a set of people cannot open a policy's Beacon article (spec 3.6): can_access per person,
// fail closed. Used by the attestations list ("N people can't open this policy") and by the
// policy.attested fix draft. No env or database import, so the unit tests and the fix drafting
// can use it without booting the service.

import type { BastionPolicyArticleState } from '@bigbluebam/shared';

/**
 * The linked Beacon article's state (#244), as bastion_probe_policy_attested_v2 reports it. Only
 * `current` can be read and acknowledged; for the rest nobody is due, nobody is nudged, and the
 * owner is told why. The union lives in @bigbluebam/shared (#285) so the SPA and MCP share it.
 */
export type ArticleState = BastionPolicyArticleState;

/**
 * What the owner is told when the article cannot be acknowledged. A policy's article cannot be
 * swapped (PATCH /policies/:id has no beacon_entry_id), so the advice names the real buttons on
 * the Policies page: "Link a Beacon article" for a new policy, then "Retire" on this one (#285).
 */
export const ARTICLE_PROBLEM: Record<Exclude<ArticleState, 'current'>, string> = {
  missing:
    'This Beacon article was removed, so nobody can read or acknowledge it. To keep asking people to read a policy, use "Link a Beacon article" to add the replacement, then "Retire" this one.',
  retired:
    'This article was withdrawn (retired or archived) in Beacon, so nobody is asked to read it and acknowledgements are paused. Restore it in Beacon, or use "Link a Beacon article" to add the replacement and then "Retire" this one.',
  expired: 'This article is past its review date in Beacon, so acknowledgements are paused until its owner reviews it in Beacon.',
};

/** What a reader sees on "Policies to read" for each state (#285): never "being updated" when it is not. */
export const ARTICLE_READER_WORDS: Record<Exclude<ArticleState, 'current'>, string> = {
  missing: "This policy's article was removed. Nothing to do.",
  retired: 'This policy was withdrawn. Nothing to do.',
  expired: 'Paused while its owner reviews it. Nothing to do for now.',
};

/**
 * What a reader who cannot open the article sees for a paused policy (#296): nothing to do, and
 * nothing about whether Beacon retired, expired or deleted an article they may not see.
 */
export const ARTICLE_PAUSED_NEUTRAL_WORDS = 'Nothing to do for now.';

/** The article state from a loaded row (the same rule as the v2 probe). */
export function articleStateOf(p: { entry_status: string | null; version: number | null; expires_at: string | Date | null }, asOf: Date): ArticleState {
  if (p.entry_status === null || p.version === null) return 'missing';
  if (p.entry_status === 'Retired' || p.entry_status === 'Archived') return 'retired';
  if (p.entry_status === 'Expired' || (p.expires_at !== null && new Date(p.expires_at).getTime() < asOf.getTime())) return 'expired';
  return 'current';
}

/** A probe summary's article_state; anything unknown reads as current (v1 snapshots). */
export function articleStateFromSummary(summary: Record<string, unknown> | null | undefined): ArticleState {
  const s = summary?.article_state;
  return s === 'missing' || s === 'retired' || s === 'expired' ? s : 'current';
}

/** can_access(asker, entity_type, entity_id), fail closed. */
export type PolicyCanAccess = (askerUserId: string, entityType: string, entityId: string) => Promise<boolean>;

/** Parallel can_access calls when checking who can open an article. */
export const CAN_ACCESS_CONCURRENCY = 8;

/**
 * Which of these Beacon articles one person may open (can_access, fail closed), in batches. The
 * policy lists show an article's live title and Beacon dates only for these (#236).
 */
export async function entriesOpenTo(canAccess: PolicyCanAccess, userId: string, entryIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(entryIds)];
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += CAN_ACCESS_CONCURRENCY) {
    const batch = unique.slice(i, i + CAN_ACCESS_CONCURRENCY);
    const ok = await Promise.all(batch.map((e) => canAccess(userId, 'beacon.entry', e).catch(() => false)));
    batch.forEach((e, k) => {
      if (ok[k]) out.add(e);
    });
  }
  return out;
}

export async function cannotOpen(canAccess: PolicyCanAccess, entryId: string, userIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < userIds.length; i += CAN_ACCESS_CONCURRENCY) {
    const batch = userIds.slice(i, i + CAN_ACCESS_CONCURRENCY);
    const ok = await Promise.all(batch.map((u) => canAccess(u, 'beacon.entry', entryId).catch(() => false)));
    batch.forEach((u, k) => {
      if (!ok[k]) out.push(u);
    });
  }
  return out;
}
