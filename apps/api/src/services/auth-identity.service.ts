/**
 * Identity lookups that run BEFORE the request's org is known (#105).
 *
 * Authentication is what establishes the org: the auth preHandler reads the
 * credential, the user's memberships and roles, and only then can the rls
 * plugin bind app.current_org_id. Under BBB_RLS_ENFORCE=1 those tables are
 * org-gated, so plain queries at this point return zero rows and every valid
 * cookie or API key looks unauthenticated. These reads therefore go through
 * the SECURITY DEFINER functions in migration 0311, keyed by the credential
 * (API key prefix, then Argon2 in the caller) or by the already-authenticated
 * user id. Every pre-auth identity read in the api (auth plugin, iCal feed key
 * auth, login) uses this module, so the fact "identity is resolved without an
 * org context" lives in one place.
 *
 * Under the default advisory posture the functions return exactly what the
 * old direct queries did.
 */
import { inArray, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import type { apiKeys } from '../db/schema/api-keys.js';
import { users } from '../db/schema/users.js';

export type ApiKeyRow = typeof apiKeys.$inferSelect;

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as T[];
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v as string);
}

/** api_keys rows whose key_prefix matches (at most `limit`, capped at 64). */
export async function findApiKeyCandidates(prefix: string, limit: number): Promise<ApiKeyRow[]> {
  const raw = await db.execute(sql`SELECT * FROM auth_api_key_candidates(${prefix}, ${limit})`);
  return rowsOf<Record<string, unknown>>(raw).map((r) => ({
    ...(r as unknown as ApiKeyRow),
    expires_at: toDate(r.expires_at),
    created_at: toDate(r.created_at) as Date,
    last_used_at: toDate(r.last_used_at),
    rotated_at: toDate(r.rotated_at),
    rotation_grace_expires_at: toDate(r.rotation_grace_expires_at),
  }));
}

/** Bump api_keys.last_used_at for a key that just authenticated. */
export async function touchApiKey(keyId: string): Promise<void> {
  await db.execute(sql`SELECT auth_touch_api_key(${keyId}::uuid)`);
}

/**
 * Whether a key row may authenticate at `now`, independent of its secret.
 * A key past expires_at is refused unless it was rotated and its rotation
 * grace window is still open: rotation keeps the predecessor working so
 * callers can roll over without downtime.
 */
export function isApiKeyUsable(
  key: Pick<ApiKeyRow, 'expires_at' | 'rotated_at' | 'rotation_grace_expires_at'>,
  now: Date = new Date(),
): boolean {
  if (!key.expires_at || new Date(key.expires_at) >= now) return true;
  return !!key.rotated_at && !!key.rotation_grace_expires_at && new Date(key.rotation_grace_expires_at) > now;
}

export interface ApiKeyOwner {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string;
  is_active: boolean;
  is_superuser: boolean;
  kind: (typeof users.$inferSelect)['kind'];
}

export interface VerifiedApiKey {
  apiKey: ApiKeyRow;
  user: ApiKeyOwner;
}

interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

/** Service-account tokens are `bbam_svc_<random>`, so their 8-char prefix is always this. */
const SVC_KEY_PREFIX = 'bbam_svc';
/** Fetch/verify ceiling for that shared bucket (#40). */
const SVC_BUCKET_MAX = 64;

/**
 * The api's single rule for "does this bbam_ token authenticate, and as whom".
 * Used by the auth plugin (Bearer) and the iCal feed (?token=), so the two can
 * never disagree about expiry, rotation grace, the DoS cap or owner state.
 *
 *  - Candidates are indexed by the 8-char key_prefix (through the #105 identity
 *    function, since the org is not known yet) and Argon2id-verified.
 *  - #40: the 'bbam_svc' prefix is shared by every service-account key, so that
 *    bucket fetches and verifies up to SVC_BUCKET_MAX rows. For any other prefix
 *    more than 3 candidates signals a forced-Argon2 attempt (P2-11) and the
 *    lookup collapses to the first candidate.
 *  - P2-10: argon2.verify always runs before the expiry check, so expired and
 *    wrong keys cost the same wall time. A malformed stored hash counts as a
 *    failed verify instead of throwing.
 *  - isApiKeyUsable decides expiry and the rotation grace window.
 *  - The owning user must exist and be active.
 *
 * The caller decides what the key may do (scope, org pinning) and bumps
 * last_used_at via touchApiKey.
 */
export async function verifyApiKeyToken(token: string, log?: WarnLogger): Promise<VerifiedApiKey | null> {
  if (!token) return null;
  const prefix = token.slice(0, 8);
  const isSvcBucket = prefix === SVC_KEY_PREFIX;

  const keyRows = await findApiKeyCandidates(prefix, isSvcBucket ? SVC_BUCKET_MAX : 10);
  if (keyRows.length === 0) return null;

  // users is not org-gated; the owners are joined in here.
  const ownerRows: ApiKeyOwner[] = await db
    .select({
      id: users.id,
      org_id: users.org_id,
      email: users.email,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
      timezone: users.timezone,
      is_active: users.is_active,
      is_superuser: users.is_superuser,
      kind: users.kind,
    })
    .from(users)
    .where(inArray(users.id, [...new Set(keyRows.map((k) => k.user_id))]));
  const ownerById = new Map(ownerRows.map((u) => [u.id, u]));
  const candidates = keyRows.flatMap((apiKey) => {
    const user = ownerById.get(apiKey.user_id);
    return user ? [{ apiKey, user }] : [];
  });

  const verifyCandidates = !isSvcBucket && candidates.length > 3 ? candidates.slice(0, 1) : candidates;
  if (!isSvcBucket && candidates.length > 3) {
    log?.warn(
      { prefix, candidate_count: candidates.length },
      'Suspicious number of API key candidates for prefix; limiting to first candidate',
    );
  } else if (isSvcBucket && candidates.length >= SVC_BUCKET_MAX) {
    // At the ceiling a valid key could fall outside the fetched window; the
    // degenerate bucket needs the prefix-lengthening follow-up (#40).
    log?.warn(
      { prefix, candidate_count: candidates.length },
      'Service-account prefix bucket hit SVC_BUCKET_MAX; some keys may not authenticate until prefixes are lengthened (#40 follow-up)',
    );
  }

  for (const candidate of verifyCandidates) {
    let valid = false;
    try {
      valid = await argon2.verify(candidate.apiKey.key_hash, token);
    } catch (err) {
      log?.warn({ err, api_key_id: candidate.apiKey.id }, 'argon2.verify threw on api key candidate; treating as invalid');
    }
    if (!isApiKeyUsable(candidate.apiKey)) continue;
    if (valid && candidate.user.is_active) return candidate;
  }
  return null;
}

export interface LiveMembershipRow {
  org_id: string;
  is_default: boolean;
  joined_at: Date;
}

/** The user's memberships in live (not soft-deleted) orgs. */
export async function loadLiveMemberships(userId: string): Promise<LiveMembershipRow[]> {
  const raw = await db.execute(sql`SELECT org_id, is_default, joined_at FROM auth_user_live_memberships(${userId}::uuid)`);
  return rowsOf<Record<string, unknown>>(raw).map((r) => ({
    org_id: String(r.org_id),
    is_default: r.is_default === true,
    joined_at: toDate(r.joined_at) as Date,
  }));
}

/** org_id -> legacy role for every org the user is grouped into. */
export async function loadOrgRoles(userId: string): Promise<Map<string, string>> {
  const raw = await db.execute(sql`SELECT org_id, legacy_role FROM auth_user_org_roles(${userId}::uuid)`);
  const out = new Map<string, string>();
  for (const r of rowsOf<{ org_id: string; legacy_role: string }>(raw)) out.set(String(r.org_id), r.legacy_role);
  return out;
}

/** True when the org exists and is not soft-deleted. */
export async function isLiveOrg(orgId: string): Promise<boolean> {
  const raw = await db.execute(sql`SELECT auth_org_is_live(${orgId}::uuid) AS live`);
  return rowsOf<{ live: boolean }>(raw)[0]?.live === true;
}
