// Who of a set of people cannot open a policy's Beacon article (spec 3.6): can_access per person,
// fail closed. Used by the attestations list ("N people can't open this policy") and by the
// policy.attested fix draft. No env or database import, so the unit tests and the fix drafting
// can use it without booting the service.

/** can_access(asker, entity_type, entity_id), fail closed. */
export type PolicyCanAccess = (askerUserId: string, entityType: string, entityId: string) => Promise<boolean>;

/** Parallel can_access calls when checking who can open an article. */
export const CAN_ACCESS_CONCURRENCY = 8;

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
