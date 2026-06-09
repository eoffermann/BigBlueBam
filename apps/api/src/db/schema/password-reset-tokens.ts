import { pgTable, uuid, text, timestamp, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * One-time tokens for the "send password reset link" flow (B3 Frndo Launch).
 * Used both for admin-initiated password resets and for new-member onboarding
 * (where the invitation email contains a "set your password" link instead of
 * a temp password). The raw token is never stored — only a SHA-256 hash —
 * so a database leak does not yield usable reset links.
 *
 * Lifecycle:
 *   - mint: store hash, expires_at = now + TTL (default 60 min).
 *   - consume: look up by hash, require used_at IS NULL, require
 *     expires_at > now(); set used_at = now() inside the txn that writes
 *     the new password hash so the token cannot be reused.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull().unique(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    used_at: timestamp('used_at', { withTimezone: true }),
    created_by: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    purpose: text('purpose').notNull().default('reset'),
    ip_address: text('ip_address'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('password_reset_tokens_user_id_idx').on(table.user_id),
    index('password_reset_tokens_expires_at_idx').on(table.expires_at),
  ],
);
