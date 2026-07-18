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
  boolean,
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

// ===========================================================================
// Banter Feed entity-type registration (docs/plans/banter-feed-design-document.md §16)
// ===========================================================================
// The Banter Feed surfaces entities from across the suite, and every cross-app
// entity passes can_access (the Wave 2 visibility preflight). These stubs add
// the columns the new preflight branches read. Same warning as above: minimal
// columns, kept in lockstep with the real physical schema, invisible to the
// drift guard.

// ---------------------------------------------------------------------------
// banter - channels, messages, channel memberships
// ---------------------------------------------------------------------------
// Real schemas: apps/banter-api/src/db/schema/{channels,messages,channel-memberships}.ts.
// A channel is readable iff it is a public channel in the same org OR the asker
// is a member. A message inherits its parent channel's visibility.
export const banterChannelsStub = pgTable(
  'banter_channels',
  {
    id: uuid('id').primaryKey(),
    org_id: uuid('org_id').notNull(),
    // 'public' | 'private' | 'dm' | 'group_dm'
    type: varchar('type', { length: 20 }).notNull(),
    is_archived: boolean('is_archived').notNull(),
  },
  (table) => [index('pas_banter_channels_org_idx').on(table.org_id)],
);

export const banterMessagesStub = pgTable(
  'banter_messages',
  {
    id: uuid('id').primaryKey(),
    channel_id: uuid('channel_id').notNull(),
    is_deleted: boolean('is_deleted').notNull(),
  },
  (table) => [index('pas_banter_messages_channel_idx').on(table.channel_id)],
);

export const banterChannelMembershipsStub = pgTable(
  'banter_channel_memberships',
  {
    id: uuid('id').primaryKey(),
    channel_id: uuid('channel_id').notNull(),
    user_id: uuid('user_id').notNull(),
  },
  (table) => [
    index('pas_banter_channel_memberships_lookup_idx').on(
      table.channel_id,
      table.user_id,
    ),
  ],
);

// ---------------------------------------------------------------------------
// bearing - goals, key results
// ---------------------------------------------------------------------------
// Real schemas: apps/bearing-api/src/db/schema/{bearing-goals,bearing-key-results}.ts.
// Bearing has no per-goal visibility enum: any org member can read any goal in
// their org (apps/bearing-api/src/middleware/authorize.ts gates on org match
// only). A KR inherits its parent goal's visibility (joined via goal_id).
export const bearingGoalsStub = pgTable('bearing_goals', {
  id: uuid('id').primaryKey(),
  organization_id: uuid('organization_id').notNull(),
});

export const bearingKeyResultsStub = pgTable('bearing_key_results', {
  id: uuid('id').primaryKey(),
  goal_id: uuid('goal_id').notNull(),
});

// ---------------------------------------------------------------------------
// board - boards, collaborators
// ---------------------------------------------------------------------------
// Real schemas: apps/board-api/src/db/schema/{boards,board-collaborators}.ts.
// Mirrors board.service.ts visibilityFilter:
//  - visibility='organization': any org member.
//  - visibility='private':      creator or explicit collaborator.
//  - visibility='project':      creator, collaborator, or project member.
// archived_at IS NOT NULL means the board is archived.
export const boardsStub = pgTable(
  'boards',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
    project_id: uuid('project_id'),
    created_by: uuid('created_by').notNull(),
    visibility: varchar('visibility', { length: 20 }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [index('pas_boards_org_idx').on(table.organization_id)],
);

export const boardCollaboratorsStub = pgTable(
  'board_collaborators',
  {
    id: uuid('id').primaryKey(),
    board_id: uuid('board_id').notNull(),
    user_id: uuid('user_id').notNull(),
  },
  (table) => [
    index('pas_board_collaborators_lookup_idx').on(table.board_id, table.user_id),
  ],
);

// ---------------------------------------------------------------------------
// book - events
// ---------------------------------------------------------------------------
// Real schema: apps/book-api/src/db/schema/book-events.ts.
// book_events.visibility is a free/busy STATUS (busy/free/tentative/oof), not a
// privacy enum. The list route scopes on org, so any org member can read any
// event in their org; creator and attendees are subsets of that. Org match is
// therefore the entire gate (no attendee join needed for the allow decision).
export const bookEventsStub = pgTable('book_events', {
  id: uuid('id').primaryKey(),
  organization_id: uuid('organization_id').notNull(),
});

// ---------------------------------------------------------------------------
// bill - invoices
// ---------------------------------------------------------------------------
// Real schema: apps/bill-api/src/db/schema/bill-invoices.ts. No per-invoice
// visibility enum: any org member can read any invoice (org-wide). Org match
// is the entire rule.
export const billInvoicesStub = pgTable('bill_invoices', {
  id: uuid('id').primaryKey(),
  organization_id: uuid('organization_id').notNull(),
});

// ---------------------------------------------------------------------------
// blank - forms
// ---------------------------------------------------------------------------
// Real schema: apps/blank-api/src/db/schema/blank-forms.ts.
// Mirrors form.service.ts visibility enforcement:
//  - visibility='public': anyone (within the org, for the preflight's purposes).
//  - visibility='org':    any org member.
//  - visibility='project': project member when project_id is set, else org member.
export const blankFormsStub = pgTable(
  'blank_forms',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
    project_id: uuid('project_id'),
    visibility: varchar('visibility', { length: 20 }).notNull(),
  },
  (table) => [index('pas_blank_forms_org_idx').on(table.organization_id)],
);

// ---------------------------------------------------------------------------
// bolt - automations (rules)
// ---------------------------------------------------------------------------
// Real schema: apps/bolt-api/src/db/schema/bolt-automations.ts. No per-rule
// visibility enum: automations are org-level infrastructure readable by any
// org member. Note the org column is org_id (not organization_id).
export const boltAutomationsStub = pgTable('bolt_automations', {
  id: uuid('id').primaryKey(),
  org_id: uuid('org_id').notNull(),
});

// ---------------------------------------------------------------------------
// bin - assets, folders
// ---------------------------------------------------------------------------
// Real schemas: apps/bin-api/src/db/schema/{bin-assets,bin-folders}.ts.
// Mirrors Bin master §9.4 visibility:
//  - bin.asset: org-scoped; if project_id set, project member or org admin/owner;
//    if visibility='private', owner (created_by) only.
//  - bin.folder: inherits the same project/private rule as an asset; org match
//    is the floor.
export const binAssetsStub = pgTable(
  'bin_assets',
  {
    id: uuid('id').primaryKey(),
    org_id: uuid('org_id').notNull(),
    project_id: uuid('project_id'),
    created_by: uuid('created_by').notNull(),
    visibility: varchar('visibility', { length: 20 }).notNull(),
  },
  (table) => [index('pas_bin_assets_org_idx').on(table.org_id)],
);

export const binFoldersStub = pgTable(
  'bin_folders',
  {
    id: uuid('id').primaryKey(),
    org_id: uuid('org_id').notNull(),
    project_id: uuid('project_id'),
    created_by: uuid('created_by').notNull(),
  },
  (table) => [index('pas_bin_folders_org_idx').on(table.org_id)],
);

// Bay review asset (no per-asset visibility enum; org match + project gate).
export const bayAssetsStub = pgTable(
  'bay_assets',
  {
    id: uuid('id').primaryKey(),
    org_id: uuid('org_id').notNull(),
    project_id: uuid('project_id'),
    created_by: uuid('created_by').notNull(),
  },
  (table) => [index('pas_bay_assets_org_idx').on(table.org_id)],
);

// ---------------------------------------------------------------------------
// blip - tracked apps, saved views
// ---------------------------------------------------------------------------
// Real schemas: apps/blip-api/src/db/schema/{blip-tracked-apps,blip-saved-views}.ts
// (docs/plans/BigBlueBam_Blip_Design_Document.md §2, §3, §7).
// blip.tracked_app is the gating entity: it is visible iff its org_id matches
// the asker's org (org match is the entire rule — entries and saved views all
// inherit it, mirroring how Bin assets gate through their container). A
// blip.saved_view gates through its parent tracked_app (joined via
// tracked_app_id); the org match on the tracked_app is the access decision.
export const blipTrackedAppsStub = pgTable(
  'blip_tracked_apps',
  {
    id: uuid('id').primaryKey(),
    org_id: uuid('org_id').notNull(),
  },
  (table) => [index('pas_blip_tracked_apps_org_idx').on(table.org_id)],
);

export const blipSavedViewsStub = pgTable(
  'blip_saved_views',
  {
    id: uuid('id').primaryKey(),
    org_id: uuid('org_id').notNull(),
    tracked_app_id: uuid('tracked_app_id').notNull(),
    owner_id: uuid('owner_id').notNull(),
    scope: varchar('scope', { length: 20 }).notNull(),
  },
  (table) => [index('pas_blip_saved_views_app_idx').on(table.tracked_app_id)],
);

// ===========================================================================
// Braid person-source + golden-profile entity-type registration
// (docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md §2.5).
// ===========================================================================
// Braid resolves customer identities across apps into golden profiles. Its
// read paths (timeline, evidence, resolve preflight) call can_access on the
// golden profile, its member identities, AND the underlying person-source
// records, so we stub those tables here. Same warning as above: minimal
// columns, kept in lockstep with the real physical schema, invisible to the
// drift guard.

// ---------------------------------------------------------------------------
// bill - clients
// ---------------------------------------------------------------------------
// Real schema: apps/bill-api/src/db/schema/bill-clients.ts. No per-client
// visibility enum: any org member can read any client in their org, mirroring
// bill.invoice. Org match is the entire rule.
export const billClientsStub = pgTable(
  'bill_clients',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
  },
  (table) => [index('pas_bill_clients_org_idx').on(table.organization_id)],
);

// ---------------------------------------------------------------------------
// book - event attendees
// ---------------------------------------------------------------------------
// Real schema: apps/book-api/src/db/schema/book-event-attendees.ts. The
// attendee row has NO organization_id of its own; org is derived through its
// parent book_events (joined via event_id), mirroring preflightBookEvent's
// org gate.
export const bookEventAttendeesStub = pgTable(
  'book_event_attendees',
  {
    id: uuid('id').primaryKey(),
    event_id: uuid('event_id').notNull(),
  },
  (table) => [index('pas_book_event_attendees_event_idx').on(table.event_id)],
);

// ---------------------------------------------------------------------------
// braid - profiles, identities
// ---------------------------------------------------------------------------
// Real schemas: apps/braid-api/src/db/schema/{braid-profiles,braid-identities}.ts.
// The golden profile (braid_profiles) is org-scoped: can_access is the coarse
// org gate, while the deep per-viewer PII filtering lives in braid-api's route
// layer (spec §2.5), not here. An identity (braid_identities) carries its own
// organization_id and a profile_id; either the direct org match or the parent
// profile's org match is the gate.
export const braidProfilesStub = pgTable(
  'braid_profiles',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
  },
  (table) => [index('pas_braid_profiles_org_idx').on(table.organization_id)],
);

export const braidIdentitiesStub = pgTable(
  'braid_identities',
  {
    id: uuid('id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
    profile_id: uuid('profile_id').notNull(),
  },
  (table) => [
    index('pas_braid_identities_org_idx').on(table.organization_id),
    index('pas_braid_identities_profile_idx').on(table.profile_id),
  ],
);
