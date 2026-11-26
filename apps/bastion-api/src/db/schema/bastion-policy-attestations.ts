// Mirrors bastion_policy_attestations as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionPolicies } from './bastion-policies.js';
import { organizations } from './bbb-refs.js';

export const bastionPolicyAttestations = pgTable(
  'bastion_policy_attestations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    policy_id: uuid('policy_id').notNull().references(() => bastionPolicies.id, { onDelete: 'restrict' }),
    beacon_entry_id: uuid('beacon_entry_id').notNull(),
    beacon_version: integer('beacon_version').notNull(),
    body_sha256: varchar('body_sha256', { length: 64 }).notNull(),
    user_id: uuid('user_id').notNull(),
    attested_at: timestamp('attested_at', { withTimezone: true }).defaultNow().notNull(),
    personal_data_hmac: varchar('personal_data_hmac', { length: 64 }),
    pd_hmac_key_id: varchar('pd_hmac_key_id', { length: 64 }),
    ledger_seq: bigint('ledger_seq', { mode: 'number' }),
  },
);
