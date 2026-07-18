import { sql, type SQL } from 'drizzle-orm';

// The ALL-KEYS transaction-scoped advisory lock helper (spec 4.2, hardened ST3-2).
//
// Create-or-attach and lazy resolve both mint a golden profile only while holding
// the advisory locks for EVERY present blocking key of the new identity. A single
// strongest-key lock is insufficient: two records sharing only phone but differing
// on email would take different locks and each mint a seed (the N-way bridging bug).
//
// For each present blocking key we derive one two-int advisory token:
//   pg_advisory_xact_lock(<class int4 = hash('email'|'phone')>, <int4 = hash(org:value)>)
// - The class int4 stops an email_norm colliding with a phone_norm in a single
//   token space.
// - The org namespace stops the same value in two different orgs contending globally.
// Tokens are acquired sorted by the FINAL numeric (class, key_hash) tuple so the
// acquisition order is deterministic and deadlock-free, IDENTICALLY in the worker
// and in the resolve path (both import this helper so they cannot diverge). It is
// NOT sorted by the raw normalized string, which would order differently from the
// hashed ints and could deadlock a worker against a resolve.
//
// Dependency-light on purpose: only drizzle's `sql` plus a minimal tx shape, so the
// BullMQ worker can import it without pulling in braid-api's db module.

// Minimal transaction surface: anything exposing drizzle's `execute(sql)`.
export interface AdvisoryLockTx {
  execute(query: SQL): Promise<unknown>;
}

// The blocking keys that gate profile creation. name_norm/domain are recall-only
// (they never block a mint) so they are intentionally excluded here.
export interface BlockingMatchKeys {
  email_norm?: string | null;
  phone_norm?: string | null;
}

const KEY_CLASSES: ReadonlyArray<{ field: keyof BlockingMatchKeys; cls: string }> = [
  { field: 'email_norm', cls: 'email' },
  { field: 'phone_norm', cls: 'phone' },
];

// FNV-1a 32-bit, returned as a signed int32 so it fits Postgres int4. Math.imul
// keeps the multiply in 32-bit space; `| 0` coerces to the signed range that
// pg_advisory_xact_lock(int4, int4) accepts.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

interface AdvisoryToken {
  classHash: number;
  keyHash: number;
}

export function deriveAdvisoryTokens(orgId: string, keys: BlockingMatchKeys): AdvisoryToken[] {
  const tokens: AdvisoryToken[] = [];
  for (const { field, cls } of KEY_CLASSES) {
    const value = keys[field];
    if (value == null || value === '') continue;
    tokens.push({ classHash: hash32(cls), keyHash: hash32(`${orgId}:${value}`) });
  }
  // Deterministic order: class first, then key hash. This is the global lock order
  // every caller must obey (all advisory key-locks first, then FOR UPDATE on rows).
  tokens.sort((a, b) => a.classHash - b.classHash || a.keyHash - b.keyHash);
  return tokens;
}

// Acquire pg_advisory_xact_lock for every present blocking key, in the deterministic
// (class, key_hash) order. Held until the surrounding transaction commits/rolls back.
export async function acquireIdentityLocks(
  tx: AdvisoryLockTx,
  orgId: string,
  matchKeys: BlockingMatchKeys,
): Promise<void> {
  for (const token of deriveAdvisoryTokens(orgId, matchKeys)) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${token.classHash}, ${token.keyHash})`);
  }
}

// A dedicated per-source-record lock for the resolve path (spec 5.1 / ST-r2-2).
// resolve mints a BARE singleton (no source read, so no blocking keys), so the
// all-keys lock above is a no-op there. This lock serializes concurrent resolves
// for the SAME (org, source_type, source_id) so two of them cannot each mint an
// orphan profile; the UNIQUE(org, source_type, source_id) on braid_identities is
// the ultimate guard, this just avoids the racing-mint churn cleanly.
export async function acquireResolveLock(
  tx: AdvisoryLockTx,
  orgId: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  const classHash = hash32('braid.resolve');
  const keyHash = hash32(`${orgId}:${sourceType}:${sourceId}`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${classHash}, ${keyHash})`);
}
