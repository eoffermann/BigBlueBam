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
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import type { apiKeys } from '../db/schema/api-keys.js';

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
