// @bigbluebam/auth-core: the suite's ONE rule for bbam_ API keys and scope gates (#340).
//
// Every Fastify service in the suite (apps/api, the *-api satellites, helpdesk-api's admin
// guard) accepts a Bam API key as `Authorization: Bearer bbam_...` and gates routes with
// requireScope(). Each service used to carry its own copy of both. The copies drifted: the
// satellites had no rotation grace, no service-account prefix bucket (#40), no Argon2 throw
// guard, mostly no org pin (P2-8), and a requireScope that checked only the key's stored scope,
// so an admin-scope key outlived its holder's demotion (#336) everywhere except apps/api.
// The facts now live here, once:
//
//   - which scopes exist and how they order (API_KEY_SCOPES, scopeAtLeast)
//   - which org roles hold org-admin power (ORG_ADMIN_ROLES) and whose keys that caps
//     (keyRoleCapApplies)
//   - when a key row may authenticate at all (isApiKeyUsable: expiry and rotation grace, #343)
//   - how a token is matched to a key row and its owner (verifyApiKeyToken)
//   - which org a key confines its caller to (resolveKeyOrgPin)
//   - what requireScope(min) admits (requireScope)
//
// DB-driver agnostic, like @bigbluebam/permissions: this package imports no database client.
// A host hands it a store. sqlApiKeyStore() builds that store from the host's own drizzle
// `sql` tag and `db.execute`, so the candidate query text also lives here once. Argon2 is
// injected the same way (verifyHash) so this package carries no native dependency.
//
// scripts/lib/auth-core-single-source.test.mjs fails when a service defines its own
// requireScope or verifies api_keys.key_hash itself.
//
// Contracts that differ per service and are deliberately NOT forked here:
//   - helpdesk-api's admin guard (lib/admin-auth.ts) resolves its target org from X-Org-Slug
//     and lets reads through with any key scope. It still verifies the key with
//     verifyApiKeyToken, compares scopes with scopeAtLeast, and checks roles with
//     ORG_ADMIN_ROLES / keyRoleCapApplies from this module.
//   - helpdesk-api's per-agent X-Agent-Key (helpdesk_agent_api_keys) is a different credential
//     type with its own table and is not a bbam_ key; it is out of scope here.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_SCOPES } from '@bigbluebam/shared';

// ─────────────────────────────────────────────────────────────────────
// Scopes and roles
// ─────────────────────────────────────────────────────────────────────

/** API key scopes, weakest first. Declared once in @bigbluebam/shared (client and server). */
export { API_KEY_SCOPES };
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Position of a scope in API_KEY_SCOPES; -1 for anything unknown (which then satisfies nothing). */
export function scopeLevel(scope: string | null | undefined): number {
  return API_KEY_SCOPES.indexOf(scope as ApiKeyScope);
}

/** True when `have` is a known scope at least as strong as `need`. */
export function scopeAtLeast(have: string | null | undefined, need: ApiKeyScope): boolean {
  const level = scopeLevel(have);
  return level >= 0 && level >= scopeLevel(need);
}

/**
 * Org roles that hold org-admin privilege. requireScope('admin') checks it for sessions AND
 * API keys (an admin-scope key is only as strong as its holder's current role), and the api's
 * reconcileOrgApiKeys() uses it to downgrade a demoted user's admin keys.
 */
export const ORG_ADMIN_ROLES: ReadonlySet<string> = new Set(['admin', 'owner']);

export type UserKind = 'human' | 'agent' | 'service';

/**
 * Whether an API key's org-admin power is capped by its holder's org role. True for human
 * holders (and for an unknown kind, failing closed). Service/agent accounts are minted with role
 * 'member' and an owner-delegated scope and are governed by agent_policies; their key scope
 * stands on its own while a current org admin vouches for it. When the admin who created them
 * is demoted or removed, the api's reconcileOrgApiKeys() downgrades their admin keys (#342).
 */
export function keyRoleCapApplies(kind: string | null | undefined): boolean {
  return kind !== 'service' && kind !== 'agent';
}

// ─────────────────────────────────────────────────────────────────────
// Key usability: expiry and rotation grace (#343)
// ─────────────────────────────────────────────────────────────────────

export interface ApiKeyLifetime {
  expires_at: Date | string | null;
  rotated_at: Date | string | null;
  rotation_grace_expires_at: Date | string | null;
}

/**
 * Whether a key row may authenticate at `now`, independent of its secret.
 *
 *  - A key that has been rotated (superseded by a successor) authenticates only while its
 *    rotation grace window is open, whatever its own expires_at says. Rotation keeps the
 *    predecessor working so callers can roll over without downtime, and no longer: a
 *    superseded key with a NULL expires_at used to authenticate forever (#343). A rotated
 *    key with no grace timestamp is refused (fail closed).
 *  - Any other key authenticates until its expires_at (NULL means it does not expire).
 */
export function isApiKeyUsable(key: ApiKeyLifetime, now: Date = new Date()): boolean {
  if (key.rotated_at) {
    return !!key.rotation_grace_expires_at && new Date(key.rotation_grace_expires_at) > now;
  }
  return !key.expires_at || new Date(key.expires_at) >= now;
}

// ─────────────────────────────────────────────────────────────────────
// Token verification
// ─────────────────────────────────────────────────────────────────────

/** The owning user of a key, as every service's auth plugin needs it. */
export interface ApiKeyOwner {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string;
  is_active: boolean;
  is_superuser: boolean;
  kind: UserKind;
}

/** An api_keys row (the columns auth needs) joined to its owner. */
export interface ApiKeyRecord extends ApiKeyLifetime {
  id: string;
  user_id: string;
  org_id: string | null;
  scope: string;
  key_hash: string;
  project_ids: string[] | null;
}

export interface ApiKeyCandidate {
  apiKey: ApiKeyRecord;
  user: ApiKeyOwner;
}

/** Data access a host supplies. sqlApiKeyStore() builds one from drizzle's sql + db.execute. */
export interface ApiKeyStore {
  /** Keys whose 8-char key_prefix matches, joined to their owner, at most `limit` (<= 64). */
  findCandidates(prefix: string, limit: number): Promise<ApiKeyCandidate[]>;
  /** Argon2id verify. May throw on a malformed hash; the caller treats a throw as a mismatch. */
  verifyHash(hash: string, token: string): Promise<boolean>;
  /** Bump api_keys.last_used_at for a key that just authenticated. */
  touch(keyId: string): Promise<void>;
}

export interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

/** Service-account tokens are `bbam_svc_<random>`, so their 8-char prefix is always this. */
export const SVC_KEY_PREFIX = 'bbam_svc';
/** Fetch/verify ceiling for that shared bucket (#40). */
export const SVC_BUCKET_MAX = 64;
/** Fetch ceiling for any other prefix; more than MAX_VERIFY_CANDIDATES of them is suspicious. */
const PREFIX_FETCH_LIMIT = 10;
const MAX_VERIFY_CANDIDATES = 3;

/**
 * The suite's single rule for "does this bbam_ token authenticate, and as whom".
 *
 *  - Candidates are indexed by the 8-char key_prefix and Argon2id-verified.
 *  - #40: the 'bbam_svc' prefix is shared by every service-account key, so that bucket fetches
 *    and verifies up to SVC_BUCKET_MAX rows. For any other prefix, more than 3 candidates
 *    signals a forced-Argon2 attempt (P2-11) and the lookup collapses to the first candidate.
 *  - P2-10: the hash verify always runs before the expiry check, so expired and wrong keys cost
 *    the same wall time. A malformed stored hash counts as a failed verify instead of throwing.
 *  - isApiKeyUsable decides expiry and the rotation grace window.
 *  - The owning user must be active.
 *
 * The caller decides what the key may do (requireScope, resolveKeyOrgPin) and calls
 * store.touch() to bump last_used_at.
 */
export async function verifyApiKeyToken(
  token: string | null | undefined,
  store: Pick<ApiKeyStore, 'findCandidates' | 'verifyHash'>,
  log?: WarnLogger,
  now: () => Date = () => new Date(),
): Promise<ApiKeyCandidate | null> {
  if (!token) return null;
  const prefix = token.slice(0, 8);
  const isSvcBucket = prefix === SVC_KEY_PREFIX;

  const candidates = await store.findCandidates(prefix, isSvcBucket ? SVC_BUCKET_MAX : PREFIX_FETCH_LIMIT);
  if (candidates.length === 0) return null;

  const tooMany = !isSvcBucket && candidates.length > MAX_VERIFY_CANDIDATES;
  const verifyCandidates = tooMany ? candidates.slice(0, 1) : candidates;
  if (tooMany) {
    log?.warn(
      { prefix, candidate_count: candidates.length },
      'Suspicious number of API key candidates for prefix; limiting to first candidate',
    );
  } else if (isSvcBucket && candidates.length >= SVC_BUCKET_MAX) {
    // At the ceiling a valid key could fall outside the fetched window; the degenerate bucket
    // needs the prefix-lengthening follow-up (#40).
    log?.warn(
      { prefix, candidate_count: candidates.length },
      'Service-account prefix bucket hit SVC_BUCKET_MAX; some keys may not authenticate until prefixes are lengthened (#40 follow-up)',
    );
  }

  for (const candidate of verifyCandidates) {
    let valid = false;
    try {
      valid = await store.verifyHash(candidate.apiKey.key_hash, token);
    } catch (err) {
      log?.warn({ err, api_key_id: candidate.apiKey.id }, 'argon2.verify threw on api key candidate; treating as invalid');
    }
    if (!isApiKeyUsable(candidate.apiKey, now())) continue;
    if (valid && candidate.user.is_active) return candidate;
  }
  return null;
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(authorization: string | string[] | undefined): string | null {
  const h = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  return token.length > 0 ? token : null;
}

// ─────────────────────────────────────────────────────────────────────
// The SQL store (driver agnostic: the host passes its own sql tag and executor)
// ─────────────────────────────────────────────────────────────────────

export interface SqlApiKeyStoreDeps {
  /**
   * The host's drizzle `sql` template tag. Typed loosely so any drizzle version's tag fits;
   * it is only ever called as a tagged template with string and number values.
   */
  // biome-ignore lint/suspicious/noExplicitAny: accepts any drizzle sql tag signature
  sql: (strings: TemplateStringsArray, ...values: any[]) => unknown;
  /**
   * The host's `db.execute`, called only with what `sql` returned. Returns either a row array
   * or `{ rows }`. (`never` so a host's precisely typed executor fits without a cast.)
   */
  execute: (query: never) => Promise<unknown>;
  /** argon2.verify (the host's own argon2 dependency). */
  verifyHash: (hash: string, token: string) => Promise<boolean>;
}

function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] } | null)?.rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v as string);
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Map one joined candidate row (see sqlApiKeyStore) to an ApiKeyCandidate. Exported for tests. */
export function candidateFromRow(r: Record<string, unknown>): ApiKeyCandidate {
  const kind = str(r.owner_kind) as UserKind;
  return {
    apiKey: {
      id: str(r.id),
      user_id: str(r.user_id),
      org_id: (r.org_id as string | null | undefined) ?? null,
      scope: str(r.scope) || 'read',
      key_hash: str(r.key_hash),
      project_ids: (r.project_ids as string[] | null | undefined) ?? null,
      expires_at: toDate(r.expires_at),
      rotated_at: toDate(r.rotated_at),
      rotation_grace_expires_at: toDate(r.rotation_grace_expires_at),
    },
    user: {
      id: str(r.user_id),
      org_id: str(r.owner_org_id),
      email: str(r.owner_email),
      display_name: str(r.owner_display_name),
      avatar_url: (r.owner_avatar_url as string | null | undefined) ?? null,
      timezone: str(r.owner_timezone) || 'UTC',
      is_active: r.owner_is_active === true,
      is_superuser: r.owner_is_superuser === true,
      kind: kind === 'agent' || kind === 'service' ? kind : 'human',
    },
  };
}

/**
 * Build the ApiKeyStore every service uses, from the host's drizzle `sql` tag and `db.execute`.
 *
 * Candidates come through auth_api_key_candidates() (migration 0311, SECURITY DEFINER): a key
 * is matched before any org is known, so under BBB_RLS_ENFORCE=1 a plain read of the org-gated
 * api_keys table would see nothing (#105). users is not org-gated and is joined directly.
 */
export function sqlApiKeyStore(deps: SqlApiKeyStoreDeps): ApiKeyStore {
  const tag = deps.sql;
  const execute = deps.execute as (query: unknown) => Promise<unknown>;
  return {
    async findCandidates(prefix, limit) {
      const raw = await execute(tag`
        SELECT k.id, k.user_id, k.org_id, k.scope, k.key_hash, k.project_ids,
               k.expires_at, k.rotated_at, k.rotation_grace_expires_at,
               u.org_id AS owner_org_id, u.email AS owner_email,
               u.display_name AS owner_display_name, u.avatar_url AS owner_avatar_url,
               u.timezone AS owner_timezone, u.is_active AS owner_is_active,
               u.is_superuser AS owner_is_superuser, u.kind::text AS owner_kind
          FROM auth_api_key_candidates(${prefix}, ${Math.min(Math.max(limit, 1), SVC_BUCKET_MAX)}) k
          JOIN users u ON u.id = k.user_id`);
      return rowsOf(raw).map(candidateFromRow);
    },
    verifyHash: deps.verifyHash,
    async touch(keyId) {
      await execute(tag`SELECT auth_touch_api_key(${keyId}::uuid)`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Org pin (P2-8)
// ─────────────────────────────────────────────────────────────────────

/**
 * True when API-key auth must pin the request's org context to the key's own org. A key minted
 * in org A is handed to an integration on the understanding it is confined to org A; without
 * the pin its holder adds `X-Org-Id: <org B>` and acts in any org the USER belongs to.
 * SuperUser keys are exempt (they legitimately operate across orgs); a NULL-org key is not
 * pinned, so the pin never yields an undefined org.
 */
export function isApiKeyOrgPinned(apiKeyOrgId: string | null | undefined, isSuperuser: boolean): boolean {
  return Boolean(apiKeyOrgId) && !isSuperuser;
}

/**
 * The org and role a pinned key acts with: the key's org, and the holder's CURRENT role there.
 * A holder no longer in that org gets 'viewer', so losing membership strips role-derived
 * privilege (and requireScope('admin') then refuses an admin-scope key, #336). Null when the
 * key is not pinned.
 */
export function resolveKeyOrgPin(
  apiKeyOrgId: string | null | undefined,
  isSuperuser: boolean,
  memberships: ReadonlyArray<{ org_id: string; role: string }>,
): { orgId: string; role: string } | null {
  if (!isApiKeyOrgPinned(apiKeyOrgId, isSuperuser) || !apiKeyOrgId) return null;
  return { orgId: apiKeyOrgId, role: memberships.find((m) => m.org_id === apiKeyOrgId)?.role ?? 'viewer' };
}

/** The AuthUser fields the org pin rewrites. Every service's AuthUser satisfies it. */
export interface PinnableUser {
  org_id: string;
  active_org_id: string;
  role: string;
  is_superuser: boolean;
  org_memberships: ReadonlyArray<{ org_id: string; role: string }>;
}

/**
 * Apply the P2-8 org pin to an already-built AuthUser: a non-SuperUser key acts in its own org
 * with the holder's current role there (resolveKeyOrgPin). Returns the same object. Services
 * whose buildAuthUser takes no key org call this after it; callers should also drop the
 * request's X-Org-Id before building the user so a header naming another org is ignored rather
 * than probed (see the satellites' auth plugins).
 */
export function applyKeyOrgPin<U extends PinnableUser>(user: U, apiKeyOrgId: string | null | undefined): U {
  const pin = resolveKeyOrgPin(apiKeyOrgId, user.is_superuser, user.org_memberships);
  if (pin) {
    user.org_id = pin.orgId;
    user.active_org_id = pin.orgId;
    user.role = pin.role;
  }
  return user;
}

// ─────────────────────────────────────────────────────────────────────
// requireScope
// ─────────────────────────────────────────────────────────────────────

/** The request.user fields requireScope reads. Every service's AuthUser satisfies it. */
export interface ScopedUser {
  id: string;
  role: string;
  is_superuser: boolean;
  /** null for session auth; the key's scope for API-key auth. */
  api_key_scope: string | null;
  /** users.kind; only read for API-key auth (sessions are always role-gated). */
  kind?: string | null;
}

function sendError(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, details: [], request_id: request.id } });
}

/**
 * Route gate: the caller's credential must allow `minScope`.
 *
 *  - No user: 401.
 *  - SuperUsers always pass.
 *  - Session auth (no API key): 'read' and 'read_write' pass; 'admin' requires the caller's
 *    active-org role to be in ORG_ADMIN_ROLES. requireScope('admin') is the org-admin gate, and
 *    requireCan blocks nothing unless BBB_PERMISSIONS_ENFORCE=on, so without this any member,
 *    viewer or guest session passed every admin route.
 *  - API-key auth: the key's scope must be at least `minScope`, and for 'admin' a human
 *    holder's CURRENT org role must also be admin/owner (#336): a key's effective privilege is
 *    the intersection of its scope and its holder's role. Service/agent holders are exempt from
 *    the role cap (keyRoleCapApplies).
 *
 * Known limitation (P1-23): scope and role are read at auth time; a key revoked mid-request
 * stays valid until the request completes.
 */
export function requireScope(minScope: ApiKeyScope) {
  return async function checkScope(request: FastifyRequest, reply: FastifyReply) {
    const user = (request as unknown as { user?: ScopedUser | null }).user;
    if (!user) return sendError(request, reply, 401, 'UNAUTHORIZED', 'Authentication required');
    if (user.is_superuser) return;

    if (user.api_key_scope === null) {
      if (minScope === 'admin' && !ORG_ADMIN_ROLES.has(user.role)) {
        request.log.warn(
          { userId: user.id, role: user.role, path: request.url, method: request.method },
          'requireScope(admin): denied a non-admin session on an org-admin route',
        );
        return sendError(request, reply, 403, 'FORBIDDEN', 'Organization admin privileges required');
      }
      return;
    }

    if (!scopeAtLeast(user.api_key_scope, minScope)) {
      return sendError(request, reply, 403, 'FORBIDDEN', `API key requires '${minScope}' scope or higher`);
    }
    if (minScope === 'admin' && keyRoleCapApplies(user.kind) && !ORG_ADMIN_ROLES.has(user.role)) {
      request.log.warn(
        { userId: user.id, role: user.role, path: request.url, method: request.method },
        'requireScope(admin): denied an admin-scope API key whose holder is no longer an org admin',
      );
      return sendError(request, reply, 403, 'FORBIDDEN', 'Organization admin privileges required');
    }
  };
}
