import { sql, type SQL } from 'drizzle-orm';

// ALL-KEYS transaction-scoped advisory lock helper for the Braid engine (spec 4.2,
// ST3-2). This is a byte-faithful reimplementation of
// apps/braid-api/src/lib/advisory-lock.ts. It is copied (not imported) because the
// worker follows the established no-cross-api-import convention (see blast-send.job.ts
// and agent-webhook-dispatch.job.ts local stubs). The algorithm MUST stay identical to
// braid-api's so a worker-minted lock token contends with a resolve-path token for the
// same (org, key): FNV-1a 32-bit hash, class int4 = hash('email'|'phone'), key int4 =
// hash(org:value), acquired sorted by the final (class, key) tuple. Keep the two in
// sync: any change here must land in apps/braid-api/src/lib/advisory-lock.ts too.

export interface AdvisoryLockTx {
  execute(query: SQL): Promise<unknown>;
}

export interface BlockingMatchKeys {
  email_norm?: string | null;
  phone_norm?: string | null;
}

const KEY_CLASSES: ReadonlyArray<{ field: keyof BlockingMatchKeys; cls: string }> = [
  { field: 'email_norm', cls: 'email' },
  { field: 'phone_norm', cls: 'phone' },
];

// FNV-1a 32-bit, returned as a signed int32 so it fits Postgres int4.
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
