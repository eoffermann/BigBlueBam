import { eq, and, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { organizations } from '../db/schema/organizations.js';
import { users } from '../db/schema/users.js';
import { sessions } from '../db/schema/sessions.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { setUserOrgRole } from './role-resolver.js';
import { env } from '../env.js';
import type { BootstrapInput, RegisterInput, UpdateProfileInput } from '@bigbluebam/shared';

export type LoginFailureReason =
  | 'user_not_found'
  | 'invalid_password'
  | 'account_disabled'
  | 'account_locked'
  | 'unverified_email';

export interface SessionMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
}

function truncateUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  return ua.length > 512 ? ua.slice(0, 512) : ua;
}

// Precomputed dummy Argon2id hash used to equalize wall-clock time in login()
// when the supplied email does not correspond to a real user, preventing
// timing-based email enumeration. Lazily initialized once per process.
let dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(nanoid(32));
  }
  return dummyHashPromise;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * Slugs that collide with SPA route segments across the platform.
 * Helpdesk uses path-based routing under /:slug/, so these would
 * shadow its login/register/verify/tickets pages.  Other apps may
 * add reserved segments here as needed.
 */
const RESERVED_ORG_SLUGS = new Set([
  'login',
  'register',
  'verify',
  'tickets',
  'admin',
  'api',
  'auth',
  'health',
  'mcp',
  'files',
  'static',
  'assets',
]);

/**
 * Count non-sentinel SuperUsers. The migration-time sentinel at
 * `system-bootstrap@bigbluebam.internal` has password_hash '!' (unloginable);
 * we exclude it so a fresh DB correctly reports zero real SuperUsers.
 */
export async function countRealSuperusers(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.is_superuser, true),
        sql`${users.password_hash} IS DISTINCT FROM '!'`,
      ),
    );
  return row?.count ?? 0;
}

export class BootstrapAlreadyCompleteError extends Error {
  constructor() {
    super('A SuperUser already exists. Bootstrap is not available.');
    this.name = 'BootstrapAlreadyCompleteError';
  }
}

/**
 * First-run bootstrap. Creates the very first real SuperUser, org, and
 * membership atomically. Refuses if a real SuperUser already exists
 * (the sentinel does not count).
 */
export async function bootstrap(data: BootstrapInput, meta?: SessionMetadata) {
  const existingCount = await countRealSuperusers();
  if (existingCount > 0) {
    throw new BootstrapAlreadyCompleteError();
  }

  const passwordHash = await argon2.hash(data.password);
  const orgSlug = slugify(data.org_name);

  if (RESERVED_ORG_SLUGS.has(orgSlug)) {
    throw new Error(
      `The organization name "${data.org_name}" produces a reserved slug ("${orgSlug}"). ` +
      'Please choose a different organization name.',
    );
  }

  const result = await db.transaction(async (tx) => {
    // Re-check inside the transaction to close the race between two
    // simultaneous bootstrap attempts.
    const [txCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(
        and(
          eq(users.is_superuser, true),
          sql`${users.password_hash} IS DISTINCT FROM '!'`,
        ),
      );
    if ((txCount?.count ?? 0) > 0) {
      throw new BootstrapAlreadyCompleteError();
    }

    const [org] = await tx
      .insert(organizations)
      .values({
        name: data.org_name,
        slug: orgSlug,
      })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({
        org_id: org!.id,
        email: data.email,
        display_name: data.display_name,
        password_hash: passwordHash,
        is_superuser: true,
      })
      .returning();

    await tx.insert(organizationMemberships).values({
      user_id: user!.id,
      org_id: org!.id,
      is_default: true,
    });
    // Wave E.F: role is stored in account_group_memberships.
    await setUserOrgRole(user!.id, org!.id, 'owner', {}, tx);

    const session = await createSessionInTx(tx, user!.id, meta);

    return { org: org!, user: user!, session };
  });

  return result;
}

export async function register(data: RegisterInput, meta?: SessionMetadata) {
  const passwordHash = await argon2.hash(data.password);
  const orgSlug = slugify(data.org_name);

  if (RESERVED_ORG_SLUGS.has(orgSlug)) {
    throw new Error(
      `The organization name "${data.org_name}" produces a reserved slug ("${orgSlug}"). ` +
      'Please choose a different organization name.',
    );
  }

  const result = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        name: data.org_name,
        slug: orgSlug,
      })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({
        org_id: org!.id,
        email: data.email,
        display_name: data.display_name,
        password_hash: passwordHash,
      })
      .returning();

    await tx.insert(organizationMemberships).values({
      user_id: user!.id,
      org_id: org!.id,
      is_default: true,
    });
    // Wave E.F: role lives in account_group_memberships.
    await setUserOrgRole(user!.id, org!.id, 'owner', {}, tx);

    const session = await createSessionInTx(tx, user!.id, meta);

    return { org: org!, user: user!, session };
  });

  return result;
}

export async function login(
  email: string,
  password: string,
  _totpCode?: string,
  meta?: SessionMetadata,
) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !user.password_hash) {
    // Burn the same amount of CPU as a real argon2.verify() would, so that
    // response time cannot be used to distinguish "user does not exist" from
    // "user exists but password is wrong" (email enumeration defense).
    const dummyHash = await getDummyPasswordHash();
    await argon2.verify(dummyHash, password);
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password', 401, 'user_not_found');
  }

  if (!user.is_active) {
    throw new AuthError('ACCOUNT_DISABLED', 'Account is disabled', 401, 'account_disabled');
  }

  const valid = await argon2.verify(user.password_hash, password);
  if (!valid) {
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password', 401, 'invalid_password');
  }

  const session = await createSession(user.id, meta);

  // Update last_seen_at
  await db
    .update(users)
    .set({ last_seen_at: new Date() })
    .where(eq(users.id, user.id));

  return { user, session };
}

export async function logout(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Persist an `active_org_id` on the given session. Used by /auth/switch-org
 * to record which org the user has asked to operate in — the auth plugin
 * reads this on every subsequent request and scopes the request to that
 * org (subject to membership verification).
 *
 * Pass `null` to clear it (revert to the user's default-membership org).
 */
export async function setSessionActiveOrgId(sessionId: string, orgId: string | null) {
  await db
    .update(sessions)
    .set({ active_org_id: orgId })
    .where(eq(sessions.id, sessionId));
}

export async function createSession(userId: string, meta?: SessionMetadata) {
  const sessionId = nanoid(48);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);

  const [session] = await db
    .insert(sessions)
    .values({
      id: sessionId,
      user_id: userId,
      expires_at: expiresAt,
      data: {},
      ip_address: meta?.ipAddress ?? null,
      user_agent: truncateUserAgent(meta?.userAgent ?? null),
    })
    .returning();

  return session!;
}

async function createSessionInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  meta?: SessionMetadata,
) {
  const sessionId = nanoid(48);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);

  const [session] = await tx
    .insert(sessions)
    .values({
      id: sessionId,
      user_id: userId,
      expires_at: expiresAt,
      data: {},
      ip_address: meta?.ipAddress ?? null,
      user_agent: truncateUserAgent(meta?.userAgent ?? null),
    })
    .returning();

  return session!;
}

export async function getUserById(userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

export async function updateProfile(userId: string, data: UpdateProfileInput) {
  const [user] = await db
    .update(users)
    .set({
      ...data,
      updated_at: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  return user ?? null;
}

export class AuthError extends Error {
  code: string;
  statusCode: number;
  failureReason: LoginFailureReason | null;

  constructor(
    code: string,
    message: string,
    statusCode = 401,
    failureReason: LoginFailureReason | null = null,
  ) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode = statusCode;
    this.failureReason = failureReason;
  }
}
