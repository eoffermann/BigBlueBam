import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { projects } from './projects.js';
import { phases } from './phases.js';
import { users } from './users.js';
import { tasks } from './tasks.js';

export const githubIntegrations = pgTable(
  'github_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repo_owner: varchar('repo_owner', { length: 100 }).notNull(),
    repo_name: varchar('repo_name', { length: 200 }).notNull(),
    webhook_secret: text('webhook_secret').notNull(),
    transition_on_pr_open_phase_id: uuid('transition_on_pr_open_phase_id').references(
      () => phases.id,
      { onDelete: 'set null' },
    ),
    transition_on_pr_merged_phase_id: uuid('transition_on_pr_merged_phase_id').references(
      () => phases.id,
      { onDelete: 'set null' },
    ),
    enabled: boolean('enabled').default(true).notNull(),
    // hook.events from the most recent `ping` delivery (migration 0273). NULL means UNKNOWN
    // (the webhook predates 0273 and was never re-pinged), never "not subscribed"; Bastion's
    // change.merge_reviewed probe reads it.
    subscribed_events: text('subscribed_events').array(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('github_integrations_repo_unique').on(table.repo_owner, table.repo_name),
    index('idx_github_integrations_repo').on(table.repo_owner, table.repo_name),
  ],
);

/**
 * Append-only log of every pull_request and pull_request_review delivery from an integrated
 * repository, recorded whether or not the PR mentions a Bam task (migration 0273). It is the
 * source for Bastion's change-management probes (merge reviewed by a non-author, merge
 * traceable to a task). org_id is the integration's project org. A redelivery with the same
 * X-GitHub-Delivery id is a no-op (partial unique index on repo + delivery_id).
 */
export const githubPrEvents = pgTable(
  'github_pr_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    integration_id: uuid('integration_id').references(() => githubIntegrations.id, {
      onDelete: 'set null',
    }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    repo_owner: varchar('repo_owner', { length: 100 }).notNull(),
    repo_name: varchar('repo_name', { length: 200 }).notNull(),
    delivery_id: varchar('delivery_id', { length: 100 }),
    // pull_request | pull_request_review
    event_type: varchar('event_type', { length: 32 }).notNull(),
    action: varchar('action', { length: 32 }).notNull(),
    pr_number: integer('pr_number').notNull(),
    pr_title: text('pr_title'),
    pr_html_url: text('pr_html_url'),
    pr_author_login: varchar('pr_author_login', { length: 200 }),
    base_ref: varchar('base_ref', { length: 255 }),
    default_branch: varchar('default_branch', { length: 255 }),
    head_sha: varchar('head_sha', { length: 64 }),
    merged: boolean('merged').default(false).notNull(),
    merged_at: timestamp('merged_at', { withTimezone: true }),
    merged_by_login: varchar('merged_by_login', { length: 200 }),
    merge_commit_sha: varchar('merge_commit_sha', { length: 64 }),
    review_id: bigint('review_id', { mode: 'number' }),
    review_state: varchar('review_state', { length: 32 }),
    reviewer_login: varchar('reviewer_login', { length: 200 }),
    review_submitted_at: timestamp('review_submitted_at', { withTimezone: true }),
    review_commit_sha: varchar('review_commit_sha', { length: 64 }),
    task_refs: text('task_refs').array().default([]).notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_github_pr_events_org_repo_pr').on(
      table.org_id,
      table.repo_owner,
      table.repo_name,
      table.pr_number,
    ),
  ],
);

export const taskGithubRefs = pgTable(
  'task_github_refs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    task_id: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    ref_type: varchar('ref_type', { length: 20 }).notNull(),
    ref_id: varchar('ref_id', { length: 100 }).notNull(),
    ref_url: text('ref_url').notNull(),
    ref_title: text('ref_title'),
    author_name: varchar('author_name', { length: 200 }),
    status: varchar('status', { length: 50 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('task_github_refs_unique').on(table.task_id, table.ref_type, table.ref_id),
    index('idx_task_github_refs_task').on(table.task_id, table.created_at),
  ],
);
