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
 * The bbam_ key rule itself (candidate query, DoS caps, expiry and rotation
 * grace, owner state) is @bigbluebam/auth-core's verifyApiKeyToken, the one
 * every service in the suite uses (#340). This module binds it to the api's db.
 *
 * Under the default advisory posture the functions return exactly what the
 * old direct queries did.
 */
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  sqlApiKeyStore,
  sqlOrgContextStore,
  verifyApiKeyToken as verifyWithStore,
  type ApiKeyCandidate,
  type ApiKeyOwner,
  type LiveMembershipRow,
  type WarnLogger,
} from '@bigbluebam/auth-core';
import { db } from '../db/index.js';

export { isApiKeyUsable } from '@bigbluebam/auth-core';
export type { ApiKeyOwner };
export type VerifiedApiKey = ApiKeyCandidate;

/** The api's binding of the shared key store: its own db.execute and argon2. */
export const apiKeyStore = sqlApiKeyStore({
  sql,
  execute: (query) => db.execute(query),
  verifyHash: (hash, token) => argon2.verify(hash, token),
});
/** Bump api_keys.last_used_at for a key that just authenticated. */
export async function touchApiKey(keyId: string): Promise<void> {
  await apiKeyStore.touch(keyId);
}

/**
 * The api's single rule for "does this bbam_ token authenticate, and as whom":
 * @bigbluebam/auth-core's verifyApiKeyToken over the api's db. Used by the auth
 * plugin (Bearer) and the iCal feed (?token=), so the two can never disagree.
 * The caller decides what the key may do (scope, org pinning) and bumps
 * last_used_at via touchApiKey.
 */
export async function verifyApiKeyToken(token: string, log?: WarnLogger): Promise<VerifiedApiKey | null> {
  return verifyWithStore(token, apiKeyStore, log);
}

export type { LiveMembershipRow };

/**
 * The api's binding of the shared org-context store (#350). The membership, role and
 * org-liveness reads (and the soft-deleted-org rule they carry) are @bigbluebam/auth-core's,
 * the same ones every satellite service uses.
 */
export const orgContextStore = sqlOrgContextStore({ sql, execute: (query) => db.execute(query) });

/** The user's memberships in live (not soft-deleted) orgs. */
export function loadLiveMemberships(userId: string): Promise<LiveMembershipRow[]> {
  return orgContextStore.loadLiveMemberships(userId);
}

/** True when the org exists and is not soft-deleted. */
export function isLiveOrg(orgId: string): Promise<boolean> {
  return orgContextStore.isLiveOrg(orgId);
}
