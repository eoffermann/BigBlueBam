// Who of a set of people cannot open a policy's Beacon article (spec 3.6): can_access per person,
// fail closed. Used by the attestations list ("N people can't open this policy") and by the
// policy.attested fix draft. No env or database import, so the unit tests and the fix drafting
// can use it without booting the service.

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
