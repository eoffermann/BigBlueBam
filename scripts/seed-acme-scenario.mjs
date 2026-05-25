#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Acme lead-to-delivery cross-app scenario.
 *
 * Threads one end-to-end story through every major surface so a human
 * tester can click through 9 apps and see them light up with related
 * data. Each step looks up its prerequisites by name/slug and skips the
 * app gracefully if the required table is missing.
 *
 * Every seeded row is tagged with `SCENARIO = 'acme-lead-to-delivery'`
 * either in its notes/description column or via metadata.scenario so
 * cleanup and re-seeding is trivial.
 *
 * Ordering of steps:
 *   1. Bond   - Acme Corp company, primary contact, negotiation deal
 *   2. Bolt   - Stale-deal automation that creates a Bam task on rot
 *   3. Bam    - MAGE-201 "Draft Acme MSA" task cross-linked to the deal
 *   4. Book   - "Acme kickoff call" event tomorrow 10:00 UTC
 *   5. Brief  - "Acme MSA Draft v1" in an "Acme" folder
 *   6. Bill   - Acme client + INV-2026-0042 draft with one line item
 *   7. Helpdesk - Ticket from ellen@acme.example about signing the MSA PDF
 *   8. Banter - Message in #sales referencing the Bond deal
 *   9. Beacon - "How to close Acme-tier deals" entry with comment + attachment
 *
 * Idempotent: every step pre-checks via SELECT .. LIMIT 1 or ON CONFLICT
 * DO NOTHING, and never DELETEs.
 *
 * Usage:
 *   DATABASE_URL=... SEED_ORG_SLUG=mage-inc node scripts/seed-acme-scenario.mjs
 */

import postgres from 'postgres';
import crypto from 'node:crypto';

const SCENARIO = 'acme-lead-to-delivery';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/bigbluebam';

const sql = postgres(DATABASE_URL, { max: 2 });

// Built-in permission-group UUIDs seeded by migration 0146. The per-org role
// dropped off `users` / `organization_memberships` in migration 0159 and now
// lives in `account_group_memberships → permission_groups.legacy_role`.
// Mirrors the constant in apps/api/src/cli.ts + services/role-resolver.ts +
// scripts/seed-platform.mjs.
const BUILTIN_GROUP_IDS = {
  owner: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  guest: '55555555-5555-4555-8555-555555555555',
};

// ─── helpers ──────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID();
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

async function tableExists(name) {
  const rows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function safeStep(label, fn) {
  try {
    const result = await fn();
    if (result?.skipped) {
      console.log(`  SKIP ${label}: ${result.reason ?? 'prereq missing'}`);
    } else if (result?.existed) {
      console.log(`  OK   ${label}: already seeded (${result.note ?? ''})`.trim());
    } else {
      console.log(`  OK   ${label}${result?.note ? `: ${result.note}` : ''}`);
    }
    return result ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL ${label}: ${msg}`);
    return { failed: true, error: msg };
  }
}

// ─── step 1: Bond ─────────────────────────────────────────────────────────

async function seedBond(ctx) {
  if (!(await tableExists('bond_companies')) || !(await tableExists('bond_deals'))) {
    return { skipped: true, reason: 'bond tables missing' };
  }

  const { orgId, adminId } = ctx;

  // Ensure a default pipeline + stages. The Bond app creates these on org
  // setup in production; in a freshly-wiped dev stack they may not exist
  // yet if seed-bond.sql has not run. Create minimal fallbacks so the
  // scenario is self-contained.
  let [pipeline] = await sql`
    SELECT id, name FROM bond_pipelines
    WHERE organization_id = ${orgId}
    ORDER BY is_default DESC, created_at
    LIMIT 1
  `;
  if (!pipeline) {
    [pipeline] = await sql`
      INSERT INTO bond_pipelines (organization_id, name, description, is_default, created_by)
      VALUES (${orgId}, 'Sales', ${`Default pipeline (${SCENARIO})`}, true, ${adminId})
      RETURNING id, name
    `;
  }

  let [negotiateStage] = await sql`
    SELECT id, name FROM bond_pipeline_stages
    WHERE pipeline_id = ${pipeline.id} AND lower(name) = 'negotiation'
    LIMIT 1
  `;
  if (!negotiateStage) {
    // Create a minimal five-stage pipeline if nothing is there.
    const stages = [
      { name: 'Prospect', sort_order: 0, stage_type: 'active', probability_pct: 10, rotting_days: 14 },
      { name: 'Qualified', sort_order: 1, stage_type: 'active', probability_pct: 25, rotting_days: 14 },
      { name: 'Proposal', sort_order: 2, stage_type: 'active', probability_pct: 50, rotting_days: 14 },
      { name: 'Negotiation', sort_order: 3, stage_type: 'active', probability_pct: 75, rotting_days: 14 },
      { name: 'Closed Won', sort_order: 4, stage_type: 'won', probability_pct: 100, rotting_days: null },
    ];
    for (const s of stages) {
      await sql`
        INSERT INTO bond_pipeline_stages (
          pipeline_id, name, sort_order, stage_type, probability_pct, rotting_days
        ) VALUES (
          ${pipeline.id}, ${s.name}, ${s.sort_order}, ${s.stage_type}, ${s.probability_pct}, ${s.rotting_days}
        )
      `;
    }
    [negotiateStage] = await sql`
      SELECT id, name FROM bond_pipeline_stages
      WHERE pipeline_id = ${pipeline.id} AND lower(name) = 'negotiation'
      LIMIT 1
    `;
  }

  // Company
  let [company] = await sql`
    SELECT id FROM bond_companies
    WHERE organization_id = ${orgId} AND name = 'Acme Corp' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!company) {
    [company] = await sql`
      INSERT INTO bond_companies (
        organization_id, name, domain, industry, website,
        custom_fields, owner_id, created_by
      ) VALUES (
        ${orgId}, 'Acme Corp', 'acme.example', 'Manufacturing', 'https://acme.example',
        ${sql.json({ scenario: SCENARIO })},
        ${adminId}, ${adminId}
      )
      RETURNING id
    `;
  }

  // Contact
  let [contact] = await sql`
    SELECT id FROM bond_contacts
    WHERE organization_id = ${orgId} AND email = 'ellen@acme.example' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!contact) {
    [contact] = await sql`
      INSERT INTO bond_contacts (
        organization_id, first_name, last_name, email, title,
        lifecycle_stage, lead_source, lead_score, custom_fields, owner_id, created_by
      ) VALUES (
        ${orgId}, 'Ellen', 'Ames', 'ellen@acme.example', 'VP Operations',
        'opportunity', 'referral', 78, ${sql.json({ scenario: SCENARIO })},
        ${adminId}, ${adminId}
      )
      RETURNING id
    `;
  }

  // Deal
  let [deal] = await sql`
    SELECT id, name, stage_id FROM bond_deals
    WHERE organization_id = ${orgId} AND name = 'Acme Corp enterprise contract' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!deal) {
    [deal] = await sql`
      INSERT INTO bond_deals (
        organization_id, pipeline_id, stage_id, name, description,
        value, currency, expected_close_date, probability_pct,
        owner_id, company_id, custom_fields, created_by
      ) VALUES (
        ${orgId}, ${pipeline.id}, ${negotiateStage.id},
        'Acme Corp enterprise contract',
        ${`Acme is evaluating the enterprise tier. ${SCENARIO}.`},
        120000, 'USD', ${daysFromNow(21).toISOString().split('T')[0]}, 75,
        ${adminId}, ${company.id}, ${sql.json({ scenario: SCENARIO })},
        ${adminId}
      )
      RETURNING id, name, stage_id
    `;

    // Join contact <-> deal
    await sql`
      INSERT INTO bond_deal_contacts (deal_id, contact_id, role)
      VALUES (${deal.id}, ${contact.id}, 'primary')
      ON CONFLICT DO NOTHING
    `;
  }

  // Record an import-mapping row so the `bond_import_mappings` surface has
  // at least one demo row. Represents the Acme contact having originally
  // landed via an imaginary `express-interest` form submission that the
  // Bond import pipeline wired to this contact.
  if (await tableExists('bond_import_mappings')) {
    await sql`
      INSERT INTO bond_import_mappings (
        organization_id, source_system, source_id, bond_entity_type, bond_entity_id
      )
      VALUES (
        ${orgId}, 'express-interest', 'acme-ellen-ames-2026-04-01',
        'contact', ${contact.id}
      )
      ON CONFLICT (organization_id, source_system, source_id) DO NOTHING
    `;
  }

  return {
    pipelineId: pipeline.id,
    stageId: deal.stage_id ?? negotiateStage.id,
    companyId: company.id,
    contactId: contact.id,
    dealId: deal.id,
    dealName: deal.name,
    note: `deal=${deal.id}`,
  };
}

// ─── step 2: Bolt ─────────────────────────────────────────────────────────

async function seedBolt(ctx) {
  if (!(await tableExists('bolt_automations'))) {
    return { skipped: true, reason: 'bolt_automations missing' };
  }

  const { orgId, adminId, mageProjectId } = ctx;

  const [existing] = await sql`
    SELECT id FROM bolt_automations
    WHERE org_id = ${orgId} AND name = 'Stale deal auto-task'
    LIMIT 1
  `;
  if (existing) {
    return { automationId: existing.id, existed: true, note: `automation=${existing.id}` };
  }

  const [automation] = await sql`
    INSERT INTO bolt_automations (
      org_id, project_id, name, description, enabled,
      trigger_source, trigger_event, created_by
    ) VALUES (
      ${orgId}, ${mageProjectId ?? null},
      'Stale deal auto-task',
      ${`Creates a Bam task to follow up when a Bond deal rots (${SCENARIO}).`},
      true,
      'bond', 'deal.rotting',
      ${adminId}
    )
    RETURNING id
  `;

  // Action - call bam.task.create via MCP with a templated title.
  if (await tableExists('bolt_actions')) {
    await sql`
      INSERT INTO bolt_actions (
        automation_id, sort_order, mcp_tool, parameters, on_error
      ) VALUES (
        ${automation.id}, 0, 'bam.task.create',
        ${sql.json({
          title: 'Follow up on {{deal.name}}',
          project_id: mageProjectId ?? null,
          priority: 'high',
          description: `Auto-created by Bolt. Deal has not moved in too long. ${SCENARIO}.`,
        })},
        'stop'
      )
    `;
  }

  return { automationId: automation.id, note: `automation=${automation.id}` };
}

// ─── step 3: Bam ──────────────────────────────────────────────────────────

async function seedBam(ctx) {
  const { mageProjectId, adminId, dealId } = ctx;
  if (!mageProjectId) return { skipped: true, reason: 'Mage project missing' };

  const humanId = 'MAGE-201';
  const [existing] = await sql`
    SELECT id FROM tasks
    WHERE project_id = ${mageProjectId} AND human_id = ${humanId}
    LIMIT 1
  `;
  if (existing) return { taskId: existing.id, existed: true, note: `task=${humanId}` };

  // Pick a default phase + state (first of each for the project).
  const [phase] = await sql`
    SELECT id FROM phases
    WHERE project_id = ${mageProjectId}
    ORDER BY position LIMIT 1
  `;
  const [state] = await sql`
    SELECT id FROM task_states
    WHERE project_id = ${mageProjectId} AND is_default = true
    LIMIT 1
  `;

  // Tasks don't have a bond_deal_id column, so the cross-link lives in
  // custom_fields.bond_deal_id where UI and MCP tools can discover it.
  const customFields = {
    scenario: SCENARIO,
    bond_deal_id: dealId ?? null,
    source: 'seed-acme-scenario',
  };

  const [task] = await sql`
    INSERT INTO tasks (
      project_id, human_id, title, description,
      phase_id, state_id, assignee_id, reporter_id,
      priority, custom_fields
    ) VALUES (
      ${mageProjectId}, ${humanId},
      'Draft Acme MSA',
      ${`Draft the Master Service Agreement for Acme Corp. Linked to Bond deal ${dealId ?? '(unknown)'}. ${SCENARIO}.`},
      ${phase?.id ?? null}, ${state?.id ?? null}, ${adminId}, ${adminId},
      'high', ${sql.json(customFields)}
    )
    RETURNING id
  `;

  // Bump human-id sequence so the next manual task picks up after 201.
  await sql`
    UPDATE projects SET task_id_sequence = GREATEST(task_id_sequence, 201)
    WHERE id = ${mageProjectId}
  `;

  return { taskId: task.id, humanId, note: `task=${humanId}` };
}

// ─── step 4: Book ─────────────────────────────────────────────────────────

async function seedBook(ctx) {
  if (!(await tableExists('book_calendars')) || !(await tableExists('book_events'))) {
    return { skipped: true, reason: 'book tables missing' };
  }

  const { orgId, adminId, contactId, taskId } = ctx;

  // Ensure a calendar for the admin to hang the event off.
  let [calendar] = await sql`
    SELECT id FROM book_calendars
    WHERE organization_id = ${orgId} AND owner_user_id = ${adminId}
    ORDER BY is_default DESC, created_at
    LIMIT 1
  `;
  if (!calendar) {
    [calendar] = await sql`
      INSERT INTO book_calendars (
        organization_id, owner_user_id, name, description, calendar_type, is_default
      ) VALUES (
        ${orgId}, ${adminId}, 'Admin', 'Primary admin calendar', 'personal', true
      )
      RETURNING id
    `;
  }

  // Event tomorrow 10:00 UTC, 30-minute window.
  const startAt = daysFromNow(1);
  startAt.setUTCHours(10, 0, 0, 0);
  const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

  const [existing] = await sql`
    SELECT id FROM book_events
    WHERE calendar_id = ${calendar.id} AND title = 'Acme kickoff call'
    LIMIT 1
  `;
  if (existing) return { eventId: existing.id, existed: true, note: `event=${existing.id}` };

  const [event] = await sql`
    INSERT INTO book_events (
      calendar_id, organization_id, title, description, location,
      start_at, end_at, timezone, status, visibility,
      linked_entity_type, linked_entity_id, created_by
    ) VALUES (
      ${calendar.id}, ${orgId}, 'Acme kickoff call',
      ${`Kickoff discussion with Acme. ${SCENARIO}.`},
      'Video call',
      ${startAt}, ${endAt}, 'UTC', 'confirmed', 'busy',
      ${taskId ? 'bam_task' : null}, ${taskId ?? null}, ${adminId}
    )
    RETURNING id
  `;

  // Attendees: admin as organizer + Ellen as external + Alice as internal
  const [alice] = await sql`
    SELECT id, email, display_name FROM users WHERE email = 'alice@example.com' LIMIT 1
  `;

  await sql`
    INSERT INTO book_event_attendees (event_id, email, name, response_status, is_organizer)
    VALUES (${event.id}, ${ctx.adminEmail ?? 'admin@example.com'}, 'Admin', 'accepted', true)
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO book_event_attendees (event_id, email, name, response_status, is_organizer)
    VALUES (${event.id}, 'ellen@acme.example', 'Ellen Ames', 'needs_action', false)
    ON CONFLICT DO NOTHING
  `;
  if (alice) {
    await sql`
      INSERT INTO book_event_attendees (event_id, user_id, email, name, response_status, is_organizer)
      VALUES (${event.id}, ${alice.id}, ${alice.email}, ${alice.display_name}, 'accepted', false)
      ON CONFLICT DO NOTHING
    `;
  }

  return { eventId: event.id, note: `event=${event.id}` };
}

// ─── step 5: Brief ────────────────────────────────────────────────────────

async function seedBrief(ctx) {
  if (!(await tableExists('brief_documents')) || !(await tableExists('brief_folders'))) {
    return { skipped: true, reason: 'brief tables missing' };
  }

  const { orgId, adminId, mageProjectId } = ctx;

  // Folder
  let [folder] = await sql`
    SELECT id FROM brief_folders
    WHERE org_id = ${orgId} AND slug = 'acme'
    LIMIT 1
  `;
  if (!folder) {
    [folder] = await sql`
      INSERT INTO brief_folders (
        org_id, project_id, name, slug, sort_order, created_by
      ) VALUES (
        ${orgId}, ${mageProjectId ?? null}, 'Acme', 'acme', 0, ${adminId}
      )
      RETURNING id
    `;
  }

  const slug = `acme-msa-draft-v1-${orgId.slice(0, 8)}`;
  const [existing] = await sql`
    SELECT id FROM brief_documents WHERE slug = ${slug} LIMIT 1
  `;
  if (existing) return { documentId: existing.id, existed: true, note: `document=${existing.id}` };

  const [doc] = await sql`
    INSERT INTO brief_documents (
      org_id, project_id, folder_id, title, slug,
      plain_text, status, visibility, created_by
    ) VALUES (
      ${orgId}, ${mageProjectId ?? null}, ${folder.id},
      'Acme MSA Draft v1', ${slug},
      ${`Draft MSA for Acme Corp. Section 1. Parties. Section 2. Scope. (${SCENARIO})`},
      'draft', 'project', ${adminId}
    )
    RETURNING id
  `;

  return { documentId: doc.id, folderId: folder.id, note: `document=${doc.id}` };
}

// ─── step 6: Bill ─────────────────────────────────────────────────────────

async function seedBill(ctx) {
  if (!(await tableExists('bill_clients')) || !(await tableExists('bill_invoices'))) {
    return { skipped: true, reason: 'bill tables missing' };
  }

  const { orgId, adminId, companyId, dealId } = ctx;

  // Client
  let [client] = await sql`
    SELECT id FROM bill_clients
    WHERE organization_id = ${orgId} AND name = 'Acme Corp'
    LIMIT 1
  `;
  if (!client) {
    [client] = await sql`
      INSERT INTO bill_clients (
        organization_id, name, email, bond_company_id, default_payment_terms_days, created_by
      ) VALUES (
        ${orgId}, 'Acme Corp', 'billing@acme.example', ${companyId ?? null}, 30, ${adminId}
      )
      RETURNING id
    `;
  }

  const invoiceNumber = 'INV-2026-0042';
  const [existing] = await sql`
    SELECT id FROM bill_invoices
    WHERE organization_id = ${orgId} AND invoice_number = ${invoiceNumber}
    LIMIT 1
  `;
  if (existing) return { invoiceId: existing.id, existed: true, note: `invoice=${invoiceNumber}` };

  const subtotal = 12000000; // $120,000 in cents
  const [invoice] = await sql`
    INSERT INTO bill_invoices (
      organization_id, client_id, invoice_number, invoice_date, due_date, status,
      subtotal, total, currency,
      to_name, to_email, payment_terms_days, notes, bond_deal_id, created_by
    ) VALUES (
      ${orgId}, ${client.id}, ${invoiceNumber},
      ${daysFromNow(0).toISOString().split('T')[0]},
      ${daysFromNow(30).toISOString().split('T')[0]},
      'draft',
      ${subtotal}, ${subtotal}, 'USD',
      'Acme Corp', 'billing@acme.example', 30,
      ${`${SCENARIO} draft invoice`}, ${dealId ?? null}, ${adminId}
    )
    RETURNING id
  `;

  await sql`
    INSERT INTO bill_line_items (
      invoice_id, sort_order, description, quantity, unit, unit_price, amount
    ) VALUES (
      ${invoice.id}, 0, 'Enterprise license annual fee',
      1, 'each', ${subtotal}, ${subtotal}
    )
  `;

  return { invoiceId: invoice.id, clientId: client.id, note: `invoice=${invoiceNumber}` };
}

// ─── step 7: Helpdesk ─────────────────────────────────────────────────────

async function seedHelpdesk(ctx) {
  if (!(await tableExists('helpdesk_users')) || !(await tableExists('tickets'))) {
    return { skipped: true, reason: 'helpdesk tables missing' };
  }

  const { orgId, taskId, mageProjectId } = ctx;

  // Ellen needs a helpdesk_users row to submit a ticket.
  let [hdUser] = await sql`
    SELECT id FROM helpdesk_users
    WHERE email = 'ellen@acme.example' AND (org_id = ${orgId} OR org_id IS NULL)
    ORDER BY org_id NULLS LAST
    LIMIT 1
  `;
  if (!hdUser) {
    // Minimal password hash - the scenario never needs to log this user
    // in. Using a random argon2-looking string so the column constraint
    // is satisfied without any real auth value.
    const placeholderHash = `$argon2id$v=19$m=65536,t=3,p=4$${crypto.randomBytes(16).toString('base64url')}$${crypto.randomBytes(32).toString('base64url')}`;
    [hdUser] = await sql`
      INSERT INTO helpdesk_users (
        org_id, email, display_name, password_hash, email_verified
      ) VALUES (
        ${orgId}, 'ellen@acme.example', 'Ellen Ames', ${placeholderHash}, true
      )
      RETURNING id
    `;
  }

  const subject = 'Cannot sign MSA PDF';
  const [existing] = await sql`
    SELECT id FROM tickets WHERE helpdesk_user_id = ${hdUser.id} AND subject = ${subject} LIMIT 1
  `;
  if (existing) return { ticketId: existing.id, existed: true, note: `ticket=${existing.id}` };

  const [ticket] = await sql`
    INSERT INTO tickets (
      helpdesk_user_id, task_id, project_id, subject, description, status, priority, category
    ) VALUES (
      ${hdUser.id}, ${taskId ?? null}, ${mageProjectId ?? null},
      ${subject},
      ${`Ellen from Acme Corp cannot sign the MSA PDF her browser keeps rejecting the signature field. ${SCENARIO}.`},
      'open', 'high', 'account'
    )
    RETURNING id
  `;

  return { ticketId: ticket.id, helpdeskUserId: hdUser.id, note: `ticket=${ticket.id}` };
}

// ─── step 8: Banter ───────────────────────────────────────────────────────

async function seedBanter(ctx) {
  if (!(await tableExists('banter_channels')) || !(await tableExists('banter_messages'))) {
    return { skipped: true, reason: 'banter tables missing' };
  }

  const { orgId, adminId, dealId } = ctx;

  let [channel] = await sql`
    SELECT id FROM banter_channels WHERE org_id = ${orgId} AND slug = 'sales' LIMIT 1
  `;
  if (!channel) {
    [channel] = await sql`
      INSERT INTO banter_channels (
        org_id, name, display_name, slug, type, topic, description, created_by, is_default
      ) VALUES (
        ${orgId}, 'sales', 'sales', 'sales', 'public',
        'Sales team channel',
        ${`Sales team channel for deal discussion (${SCENARIO}).`},
        ${adminId}, false
      )
      ON CONFLICT (org_id, slug) DO NOTHING
      RETURNING id
    `;
  }

  // Ensure the admin is a member so realtime clients show the channel.
  if (channel) {
    await sql`
      INSERT INTO banter_channel_memberships (channel_id, user_id, role)
      VALUES (${channel.id}, ${adminId}, 'owner')
      ON CONFLICT (channel_id, user_id) DO NOTHING
    `;
  } else {
    // Re-fetch: the ON CONFLICT path above can leave RETURNING empty.
    [channel] = await sql`
      SELECT id FROM banter_channels WHERE org_id = ${orgId} AND slug = 'sales' LIMIT 1
    `;
  }
  if (!channel) return { skipped: true, reason: 'failed to create sales channel' };

  // Idempotency check: use a scenario-tagged marker string in content_plain.
  const marker = `[${SCENARIO}] deal=${dealId ?? 'none'}`;
  const [existing] = await sql`
    SELECT id FROM banter_messages
    WHERE channel_id = ${channel.id} AND content_plain LIKE ${`%${marker}%`}
    LIMIT 1
  `;
  if (existing) return { channelId: channel.id, messageId: existing.id, existed: true, note: `message=${existing.id}` };

  const content = `Acme Corp negotiation moving. See Bond deal ${dealId ?? '(none)'}. ${marker}`;
  const [message] = await sql`
    INSERT INTO banter_messages (
      channel_id, author_id, content, content_plain, content_format,
      metadata, edit_permission
    ) VALUES (
      ${channel.id}, ${adminId}, ${content}, ${content}, 'text',
      ${sql.json({ scenario: SCENARIO, bond_deal_id: dealId ?? null })},
      'own'
    )
    RETURNING id
  `;

  // Update channel message_count / last_message_at to match the new row.
  await sql`
    UPDATE banter_channels
    SET message_count = message_count + 1,
        last_message_at = now(),
        last_message_preview = ${content.slice(0, 200)}
    WHERE id = ${channel.id}
  `;

  return { channelId: channel.id, messageId: message.id, note: `message=${message.id}` };
}

// ─── step 9: Beacon ───────────────────────────────────────────────────────

async function seedBeacon(ctx) {
  if (!(await tableExists('beacon_entries'))) {
    return { skipped: true, reason: 'beacon tables missing' };
  }

  const { orgId, adminId, mageProjectId } = ctx;

  const slug = `acme-tier-deals-playbook-${orgId.slice(0, 8)}`;
  const [existingEntry] = await sql`SELECT id FROM beacon_entries WHERE slug = ${slug} LIMIT 1`;
  let entryId;

  if (existingEntry) {
    entryId = existingEntry.id;
  } else {
    const [entry] = await sql`
      INSERT INTO beacon_entries (
        slug, title, summary, body_markdown, body_html, version, status, visibility,
        created_by, owned_by, project_id, organization_id, expires_at, metadata
      ) VALUES (
        ${slug},
        'How to close Acme-tier deals',
        'Playbook for negotiating and closing enterprise deals like Acme Corp.',
        ${`# Acme-tier playbook\n\n1. Qualify buyer pains.\n2. Send template MSA.\n3. Schedule kickoff call.\n\nScenario: ${SCENARIO}.`},
        ${`<h1>Acme-tier playbook</h1><ol><li>Qualify buyer pains.</li><li>Send template MSA.</li><li>Schedule kickoff call.</li></ol><p>Scenario: ${SCENARIO}.</p>`},
        1, 'Active', 'Organization',
        ${adminId}, ${adminId}, ${mageProjectId ?? null}, ${orgId},
        ${daysFromNow(365)},
        ${sql.json({ scenario: SCENARIO })}
      )
      RETURNING id
    `;
    entryId = entry.id;
  }

  // Comment (migration 0079)
  let commentInserted = 0;
  if (await tableExists('beacon_comments')) {
    const [existingComment] = await sql`
      SELECT id FROM beacon_comments
      WHERE beacon_id = ${entryId} AND author_id = ${adminId} AND body_markdown LIKE ${`%${SCENARIO}%`}
      LIMIT 1
    `;
    if (!existingComment) {
      await sql`
        INSERT INTO beacon_comments (beacon_id, author_id, body_markdown, body_html)
        VALUES (
          ${entryId}, ${adminId},
          ${`add example negotiation emails (${SCENARIO})`},
          ${`<p>add example negotiation emails (${SCENARIO})</p>`}
        )
      `;
      commentInserted = 1;
    }
  }

  // Attachment stub (migration 0080) - storage_key points at a MinIO
  // object the tester would upload manually; no bytes are pushed here.
  let attachmentInserted = 0;
  if (await tableExists('beacon_attachments')) {
    const filename = 'acme-playbook.pdf';
    const [existingAttachment] = await sql`
      SELECT id FROM beacon_attachments
      WHERE beacon_id = ${entryId} AND filename = ${filename}
      LIMIT 1
    `;
    if (!existingAttachment) {
      await sql`
        INSERT INTO beacon_attachments (
          beacon_id, filename, content_type, size_bytes, storage_key, uploaded_by
        ) VALUES (
          ${entryId}, ${filename}, 'application/pdf', 12345,
          ${`beacon-attachments/${entryId}/${filename}`},
          ${adminId}
        )
        ON CONFLICT DO NOTHING
      `;
      attachmentInserted = 1;
    }
  }

  return {
    entryId,
    commentInserted,
    attachmentInserted,
    note: `entry=${entryId} +comment=${commentInserted} +attachment=${attachmentInserted}`,
  };
}

// ─── step 6.5: Platform approval.requested ────────────────────────────────

async function seedApproval(ctx) {
  const { orgId, adminId } = ctx;

  // Resolve the approver. Prefer alice@example.com if she is a member of
  // the target org; otherwise fall back to the admin (self-approval).
  const users = await sql`
    SELECT u.id, u.display_name, u.email
    FROM users u
    JOIN organization_memberships m ON m.user_id = u.id
    WHERE m.org_id = ${orgId}
    ORDER BY m.joined_at
  `;
  const alice = users.find((u) => u.email === 'alice@example.com');
  const approver = alice ?? users.find((u) => u.id === adminId) ?? users[0];
  if (!approver) {
    return { skipped: true, reason: 'no org members to approve' };
  }

  // Route discovery: publishBoltEvent in @bigbluebam/shared reads
  // BOLT_API_INTERNAL_URL / BOLT_API_URL (seed sidecar has the former
  // set from docker-compose). INTERNAL_SERVICE_SECRET must be present
  // for Bolt ingest to accept the event.
  const boltUrl =
    process.env.BOLT_API_INTERNAL_URL ??
    process.env.BOLT_API_URL ??
    'http://bolt-api:4006';
  const secret = process.env.INTERNAL_SERVICE_SECRET ?? '';

  const payload = {
    approval_id: `acme-approval-${ctx.invoiceId ?? 'scenario'}`,
    subject_type: 'bill.invoice',
    subject_id: ctx.invoiceId ?? null,
    approver: {
      id: approver.id,
      name: approver.display_name,
      email: approver.email,
    },
    body:
      `Please approve the Acme MSA invoice INV-2026-0042 (Acme Corp enterprise contract). ${SCENARIO}.`,
    url: '/bill/invoices/INV-2026-0042',
    requester: { id: adminId },
  };

  try {
    const res = await fetch(`${boltUrl}/v1/events/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify({
        event_type: 'approval.requested',
        source: 'platform',
        payload,
        org_id: orgId,
        actor_id: adminId,
        actor_type: 'user',
      }),
    });
    if (!res.ok) {
      return {
        skipped: true,
        reason: `bolt-api /v1/events/ingest returned ${res.status}`,
      };
    }
    return { note: `approver=${approver.email}` };
  } catch (err) {
    return {
      skipped: true,
      reason: `bolt ingest unreachable: ${err instanceof Error ? err.message : err}`,
    };
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Acme scenario seed: tag="${SCENARIO}"`);

  const orgSlug =
    process.env.SEED_ORG_SLUG ??
    process.argv.find((a) => a.startsWith('--org-slug='))?.split('=')[1];

  const [org] = orgSlug
    ? await sql`SELECT id, name, slug FROM organizations WHERE slug = ${orgSlug} LIMIT 1`
    : await sql`SELECT id, name, slug FROM organizations ORDER BY created_at LIMIT 1`;

  if (!org) {
    console.error('No org found, run create-admin first');
    process.exit(1);
  }
  console.log(`Acme scenario seed: org "${org.name}" (${org.slug}) ${org.id}`);

  // Admin user (reporter + owner for everything). Wave E.F: org role lives
  // in account_group_memberships → permission_groups, identified by the
  // fixed owner group UUID (seeded by migration 0146).
  const [admin] = await sql`
    SELECT u.id, u.email FROM users u
    JOIN account_group_memberships agm
      ON agm.user_id = u.id
     AND agm.scope_type = 'org'
     AND agm.scope_id = ${org.id}
    WHERE u.org_id = ${org.id} AND agm.group_id = ${BUILTIN_GROUP_IDS.owner}
    ORDER BY u.created_at LIMIT 1
  `;
  if (!admin) {
    console.error('No owner user found. Run seed-platform first.');
    process.exit(1);
  }

  // Mage project (optional; scenario still threads but steps that need
  // it will mark themselves skipped).
  const [mage] = await sql`
    SELECT id FROM projects WHERE org_id = ${org.id} AND slug = 'mage' LIMIT 1
  `;

  const ctx = {
    orgId: org.id,
    adminId: admin.id,
    adminEmail: admin.email,
    mageProjectId: mage?.id ?? null,
  };

  // Step 1 - Bond
  const bond = await safeStep('1. Bond (company/contact/deal)', () => seedBond(ctx));
  ctx.dealId = bond.dealId;
  ctx.companyId = bond.companyId;
  ctx.contactId = bond.contactId;

  // Step 2 - Bolt
  await safeStep('2. Bolt (stale-deal automation)', () => seedBolt(ctx));

  // Step 3 - Bam
  const bam = await safeStep('3. Bam (MAGE-201 task)', () => seedBam(ctx));
  ctx.taskId = bam.taskId;

  // Step 4 - Book
  await safeStep('4. Book (Acme kickoff call)', () => seedBook(ctx));

  // Step 5 - Brief
  await safeStep('5. Brief (Acme MSA Draft v1)', () => seedBrief(ctx));

  // Step 6 - Bill
  const bill = await safeStep('6. Bill (INV-2026-0042)', () => seedBill(ctx));
  ctx.invoiceId = bill?.invoiceId ?? null;

  // Step 6.5 - Approval request (emits approval.requested for the Bill
  // invoice, routed to Alice as the approver). This exercises the
  // Banter approval-DM Bolt template end-to-end: the event arrives in
  // bolt-api, the template matches, and if a matching Banter DM
  // automation is enabled it fires a DM to Alice. Best-effort only;
  // failures here do not break the scenario.
  await safeStep('6.5. Platform (approval.requested for MSA invoice)', () =>
    seedApproval(ctx),
  );

  // Step 7 - Helpdesk
  await safeStep('7. Helpdesk (Cannot sign MSA PDF)', () => seedHelpdesk(ctx));

  // Step 8 - Banter
  await safeStep('8. Banter (#sales message)', () => seedBanter(ctx));

  // Step 9 - Beacon
  await safeStep('9. Beacon (Acme playbook + comment + attachment)', () => seedBeacon(ctx));

  console.log('');
  console.log(`Acme scenario seed done. Every row tagged "${SCENARIO}" in notes/description/metadata.`);

  await sql.end({ timeout: 2 });
}

main().catch(async (err) => {
  console.error('Acme scenario FATAL:', err instanceof Error ? err.stack ?? err.message : err);
  try {
    await sql.end({ timeout: 2 });
  } catch {
    // ignore
  }
  process.exit(1);
});
