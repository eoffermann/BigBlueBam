/**
 * Peer-app schema stubs (AGENTIC_TODO §11, Wave 2).
 *
 * WARNING: cross-app coupling point.
 * -----------------------------------------------------------------
 * The Bam api historically does not import schema from peer apps
 * (bond-api, brief-api, beacon-api, helpdesk-api). The visibility
 * preflight service needs to look up peer-app entities to decide
 * whether an asker can see them, so we declare minimal Drizzle
 * stubs here that match the physical Postgres tables.
 *
 * Pattern mirrors apps/bond-api/src/db/schema/bbb-refs.ts which
 * does the same thing in reverse (bond declaring stubs for the
 * Bam tables it needs).
 *
 * Keep the column set MINIMAL: only the fields visibility.service.ts
 * reads. Any drift from the real physical schema will surface as a
 * runtime error; the drift guard (pnpm db:check) will NOT catch it
 * because these stubs deliberately shadow existing tables.
 *
 * When the peer app's schema changes in a way that affects a column
 * listed here, update this file in lockstep.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// helpdesk - tickets
// ---------------------------------------------------------------------------
// Real schema: apps/helpdesk-api/src/db/schema/tickets.ts
// We only need id, project_id, helpdesk_user_id for visibility.
export const helpdeskTicketsStub = pgTable('tickets', {
  id: uuid('id').primaryKey(),
  project_id: uuid('project_id'),
  helpdesk_user_id: uuid('helpdesk_user_id'),
});

// ---------------------------------------------------------------------------
// bond - deals, contacts, companies
// ---------------------------------------------------------------------------
// Real schema: apps/bond-api/src/db/schema/bond-deals.ts etc.
// The Bam users table is NOT duplicated here - we read it from the
// existing users schema since org_id / role already live on it.
export const bondDealsStub = pgTable(
  'bond_deals',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
    owner_id: uuid('owner_id'),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('pas_bond_deals_org_idx').on(table.organization_id)],
);

export const bondContactsStub = pgTable(
  'bond_contacts',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
    owner_id: uuid('owner_id'),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('pas_bond_contacts_org_idx').on(table.organization_id)],
);

export const bondCompaniesStub = pgTable(
  'bond_companies',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('pas_bond_companies_org_idx').on(table.organization_id)],
);

// ---------------------------------------------------------------------------
// brief - documents, collaborators
// ---------------------------------------------------------------------------
// Real schema: apps/brief-api/src/db/schema/brief-documents.ts.
// We need id, org_id, project_id, created_by, visibility for the
// visibility predicate that mirrors document.service.ts.
export const briefDocumentsStub = pgTable('brief_documents', {
  id: uuid('id').primaryKey(),
  org_id: uuid('org_id').notNull(),
  project_id: uuid('project_id'),
  created_by: uuid('created_by').notNull(),
  visibility: varchar('visibility', { length: 30 }).notNull(),
});

export const briefCollaboratorsStub = pgTable('brief_collaborators', {
  id: uuid('id').primaryKey(),
  document_id: uuid('document_id').notNull(),
  user_id: uuid('user_id').notNull(),
});

// ---------------------------------------------------------------------------
// beacon - entries
// ---------------------------------------------------------------------------
// Real schema: apps/beacon-api/src/db/schema/beacon-entries.ts.
// We need id, organization_id, project_id, created_by, owned_by, visibility.
export const beaconEntriesStub = pgTable('beacon_entries', {
  id: uuid('id').primaryKey(),
  organization_id: uuid('organization_id').notNull(),
  project_id: uuid('project_id'),
  created_by: uuid('created_by').notNull(),
  owned_by: uuid('owned_by').notNull(),
  visibility: varchar('visibility', { length: 30 }).notNull(),
});

// ---------------------------------------------------------------------------
// §17 Wave 4 attachments: peer-app attachment tables
// ---------------------------------------------------------------------------
// Real schemas:
//   - apps/helpdesk-api/src/db/schema/helpdesk-ticket-attachments.ts
//   - apps/beacon-api/src/db/schema/beacon-attachments.ts
//
// The Bam attachments table is declared directly in
// apps/api/src/db/schema/attachments.ts and is NOT stubbed here since Bam
// owns it. Brief has no attachment table today.
//
// These stubs only carry the columns the federated attachment-meta
// dispatcher reads (services/attachment-meta.service.ts). Keep them
// minimal; beacon_attachments has no scanner columns in its current
// schema, so the dispatcher surfaces scan_status='pending' for beacon
// rows. Helpdesk has scan_status, scan_error, scanned_at but NO
// scan_signature column, so that is left as null.

export const helpdeskTicketAttachmentsStub = pgTable(
  'helpdesk_ticket_attachments',
  {
    id: uuid('id').primaryKey(),
    ticket_id: uuid('ticket_id').notNull(),
    uploaded_by: uuid('uploaded_by').notNull(),
    filename: varchar('filename', { length: 512 }).notNull(),
    content_type: varchar('content_type', { length: 128 }).notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storage_key: varchar('storage_key', { length: 1024 }).notNull(),
    scan_status: varchar('scan_status', { length: 50 }).notNull(),
    scan_error: text('scan_error'),
    scanned_at: timestamp('scanned_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('pas_helpdesk_ticket_attachments_ticket_idx').on(table.ticket_id),
  ],
);

export const beaconAttachmentsStub = pgTable(
  'beacon_attachments',
  {
    id: uuid('id').primaryKey(),
    beacon_id: uuid('beacon_id').notNull(),
    uploaded_by: uuid('uploaded_by').notNull(),
    filename: varchar('filename', { length: 512 }).notNull(),
    content_type: varchar('content_type', { length: 128 }).notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storage_key: varchar('storage_key', { length: 1024 }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('pas_beacon_attachments_beacon_idx').on(table.beacon_id),
  ],
);

// ---------------------------------------------------------------------------
// blueprint - diagrams, nodes
// ---------------------------------------------------------------------------
// Real schemas:
//   - apps/blueprint-api/src/db/schema/blueprint-diagrams.ts
//   - apps/blueprint-api/src/db/schema/blueprint-nodes.ts
//
// MVP scope: visibility preflight only enforces org match. Per-diagram
// rules (project/private + collab) live in blueprint-api's diagram.service
// (assertCanRead) and will be backfilled here when the per-app stub
// expands beyond the columns needed for cross-app surfacing. Until then
// the visibility predicate is intentionally permissive within an org so
// agents authoring cross-product references do not silently drop links
// to legitimate diagrams.

export const blueprintDiagramsStub = pgTable('blueprint_diagrams', {
  id: uuid('id').primaryKey(),
  org_id: uuid('org_id').notNull(),
  project_id: uuid('project_id'),
  created_by: uuid('created_by'),
  visibility: varchar('visibility', { length: 16 }).notNull(),
});

export const blueprintNodesStub = pgTable('blueprint_nodes', {
  id: uuid('id').primaryKey(),
  diagram_id: uuid('diagram_id').notNull(),
});
