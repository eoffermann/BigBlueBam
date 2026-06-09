// Password-reset token service. Owns the mint/consume lifecycle for the
// "Send password reset link" feature (B3 Frndo Launch) and the matching
// invitation-onboarding flow (a new member receives a link to set their
// own password instead of a temp password in cleartext).
//
// Tokens are 32-byte (256-bit) cryptographically-random values, encoded
// as base64url for URL safety. Only their SHA-256 hash is stored — the
// raw token lives just long enough to be emailed and clicked.

import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { sessions } from '../db/schema/sessions.js';
import { passwordResetTokens } from '../db/schema/password-reset-tokens.js';

export const DEFAULT_TTL_MINUTES = 60;

/** A token was not found, was already consumed, or is past its expiry. */
export class PasswordResetTokenInvalidError extends Error {
  public readonly code: 'INVALID_TOKEN' | 'EXPIRED' | 'ALREADY_USED';
  constructor(code: 'INVALID_TOKEN' | 'EXPIRED' | 'ALREADY_USED', message: string) {
    super(message);
    this.code = code;
    this.name = 'PasswordResetTokenInvalidError';
  }
}

/** The user the token resolves to no longer exists. */
export class PasswordResetUserMissingError extends Error {
  constructor() {
    super('User no longer exists');
    this.name = 'PasswordResetUserMissingError';
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function ttlMinutesFromEnv(): number {
  const raw = process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES;
  if (!raw) return DEFAULT_TTL_MINUTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 60 * 24 * 14) return DEFAULT_TTL_MINUTES;
  return n;
}

export interface MintTokenOpts {
  userId: string;
  createdBy?: string | null;
  ipAddress?: string | null;
  /** 'reset' (default) for password reset, 'invite' for first-time onboarding. */
  purpose?: 'reset' | 'invite';
  /** Override TTL in minutes (capped 14 days). */
  ttlMinutes?: number;
}

export interface MintedToken {
  /** Raw token. Goes in the URL once; never stored. */
  token: string;
  expiresAt: Date;
  purpose: 'reset' | 'invite';
}

/**
 * Mint a one-time token. Caller is responsible for actually emailing the
 * resulting URL to the user — this function only persists state.
 */
export async function mintToken(opts: MintTokenOpts): Promise<MintedToken> {
  const ttl = opts.ttlMinutes ?? ttlMinutesFromEnv();
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  const purpose = opts.purpose ?? 'reset';
  // 32 random bytes → 43 base64url characters, ~256 bits of entropy.
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);

  await db.insert(passwordResetTokens).values({
    user_id: opts.userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_by: opts.createdBy ?? null,
    ip_address: opts.ipAddress ?? null,
    purpose,
  });

  return { token, expiresAt, purpose };
}

export interface ConsumeTokenOpts {
  token: string;
  newPassword: string;
}

export interface ConsumedToken {
  userId: string;
  email: string;
  /** What the token was minted for — drives the success-page copy. */
  purpose: 'reset' | 'invite';
}

/**
 * Consume a token: validate it, hash the new password, write both the
 * password update and the used_at marker in a single transaction, and
 * invalidate every active session for the user (any stolen cookie must
 * die at the same instant the password does).
 *
 * Throws PasswordResetTokenInvalidError on a missing/expired/used token
 * so the route handler can map to a stable HTTP status without leaking
 * which of the three branches failed.
 */
export async function consumeToken(opts: ConsumeTokenOpts): Promise<ConsumedToken> {
  if (opts.newPassword.length < 12) {
    throw new PasswordResetTokenInvalidError(
      'INVALID_TOKEN',
      'Password must be at least 12 characters',
    );
  }
  const tokenHash = hashToken(opts.token);

  // Read outside the transaction so we can return a precise error code
  // (expired vs already-used vs not-found) without forcing the transaction
  // to roll back for a normal user mistake.
  const [tokenRow] = await db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.token_hash, tokenHash))
    .limit(1);

  if (!tokenRow) {
    throw new PasswordResetTokenInvalidError('INVALID_TOKEN', 'Invalid reset link');
  }
  if (tokenRow.used_at) {
    throw new PasswordResetTokenInvalidError(
      'ALREADY_USED',
      'This reset link has already been used',
    );
  }
  if (tokenRow.expires_at.getTime() <= Date.now()) {
    throw new PasswordResetTokenInvalidError(
      'EXPIRED',
      'This reset link has expired. Request a new one.',
    );
  }

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, tokenRow.user_id))
    .limit(1);
  if (!user) throw new PasswordResetUserMissingError();

  const passwordHash = await argon2.hash(opts.newPassword);

  await db.transaction(async (tx) => {
    // Stamp used_at with an extra `used_at IS NULL` clause so concurrent
    // clicks on the same link cannot both succeed. If two requests race,
    // the second one's UPDATE returns zero rows and we treat it as a
    // double-use error.
    const updated = await tx
      .update(passwordResetTokens)
      .set({ used_at: new Date() })
      .where(
        and(
          eq(passwordResetTokens.id, tokenRow.id),
          isNull(passwordResetTokens.used_at),
        ),
      )
      .returning({ id: passwordResetTokens.id });

    if (updated.length === 0) {
      throw new PasswordResetTokenInvalidError(
        'ALREADY_USED',
        'This reset link has already been used',
      );
    }

    await tx
      .update(users)
      .set({
        password_hash: passwordHash,
        force_password_change: false,
        updated_at: new Date(),
      })
      .where(eq(users.id, user.id));

    // Kill every session for the user — both for the reset path (a stolen
    // cookie should not outlive the password it was issued under) and the
    // invite path (the user has never logged in before, so there are no
    // legitimate sessions to preserve).
    await tx.delete(sessions).where(eq(sessions.user_id, user.id));
  });

  return { userId: user.id, email: user.email, purpose: tokenRow.purpose as 'reset' | 'invite' };
}

/** Best-effort cleanup of expired or already-used tokens. Cheap to call. */
export async function purgeStaleTokens(): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM password_reset_tokens
        WHERE expires_at < now() - interval '7 days'
           OR used_at < now() - interval '7 days'`,
  );
  // postgres-js returns `{ count }` on a delete; null-coalesce just in case.
  return (result as unknown as { count?: number }).count ?? 0;
}
