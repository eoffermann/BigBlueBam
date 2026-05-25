#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Platform seeder - populates everything other seeders depend on.
 *
 * The `create-admin` CLI gives us one owner user, one org, and one
 * membership row. Every Bond/Bolt/Beacon/Banter/Helpdesk/etc. seeder needs
 * more than that: named users to attribute authorship to, projects to
 * reference, phases/states so tasks have somewhere to live, and sprints
 * for burndown/velocity demos.
 *
 * Covers items 1 and 9 of the SEEDING_RECOVERY_PLAN.md gap analysis:
 *   - 6 named users with deterministic credentials
 *   - 2 projects per org (Mage, Internal) with canonical phases + task states
 *   - 2 sprints per project (1 active + 1 completed)
 *   - 15 tasks spread across phases/priorities/assignees
 *   - 3 activity_log rows
 *   - 1 read + 1 read_write API key (token printed once, tagged [SEED-API-KEY])
 *   - 1 OAuth user link stub for Alice (P2 migration 0119)
 *   - 1 rotated API key predecessor/successor pair for Bob (P2 migration 0117)
 *
 * Idempotent. Re-running is safe: every insert is gated on SELECT .. LIMIT 1
 * or ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   DATABASE_URL=... SEED_ORG_SLUG=mage-inc node scripts/seed-platform.mjs
 */

import postgres from 'postgres';
import crypto from 'node:crypto';
import argon2 from 'argon2';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/bigbluebam';

const sql = postgres(DATABASE_URL, { max: 2 });

const DEFAULT_PASSWORD = 'dev-password-change-me';

// Built-in permission-group UUIDs seeded by migration 0146. The per-org role
// dropped off `users` / `organization_memberships` in migration 0159 and now
// lives in `account_group_memberships → permission_groups.legacy_role`.
// Mirrors the constant in apps/api/src/cli.ts + services/role-resolver.ts.
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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function dateOnly(d) {
  return d.toISOString().split('T')[0];
}

// ─── users ────────────────────────────────────────────────────────────────

async function ensureUser(orgId, spec) {
  const groupId = BUILTIN_GROUP_IDS[spec.role];
  if (!groupId) {
    throw new Error(`Unknown role for ${spec.email}: ${spec.role}`);
  }

  const [existing] = await sql`
    SELECT id, email FROM users WHERE email = ${spec.email} LIMIT 1
  `;
  if (existing) {
    // Make sure the user is a member of the target org. This handles the
    // case where a platform seed ran earlier against a different org.
    await sql`
      INSERT INTO organization_memberships (user_id, org_id, is_default)
      VALUES (${existing.id}, ${orgId}, false)
      ON CONFLICT (user_id, org_id) DO NOTHING
    `;
    await sql`
      INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id)
      VALUES (${existing.id}, ${groupId}, 'org', ${orgId})
      ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE
        SET group_id = EXCLUDED.group_id,
            detached_at = NULL,
            detached_by = NULL
    `;
    return { id: existing.id, email: existing.email, role: spec.role, isNew: false };
  }

  const passwordHash = await argon2.hash(DEFAULT_PASSWORD);
  const [user] = await sql`
    INSERT INTO users (org_id, email, display_name, password_hash, is_superuser)
    VALUES (${orgId}, ${spec.email}, ${spec.displayName}, ${passwordHash}, false)
    RETURNING id, email
  `;
  await sql`
    INSERT INTO organization_memberships (user_id, org_id, is_default)
    VALUES (${user.id}, ${orgId}, true)
    ON CONFLICT (user_id, org_id) DO NOTHING
  `;
  await sql`
    INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id)
    VALUES (${user.id}, ${groupId}, 'org', ${orgId})
    ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE
      SET group_id = EXCLUDED.group_id,
          detached_at = NULL,
          detached_by = NULL
  `;
  return { id: user.id, email: user.email, role: spec.role, isNew: true };
}

// ─── projects ─────────────────────────────────────────────────────────────

async function ensureProject(orgId, creatorId, spec) {
  const [existing] = await sql`
    SELECT id, name, slug FROM projects
    WHERE org_id = ${orgId} AND slug = ${spec.slug}
    LIMIT 1
  `;
  if (existing) return { ...existing, isNew: false };

  const [project] = await sql`
    INSERT INTO projects (org_id, name, slug, description, icon, color, task_id_prefix, created_by)
    VALUES (
      ${orgId}, ${spec.name}, ${spec.slug}, ${spec.description},
      ${spec.icon}, ${spec.color}, ${spec.prefix}, ${creatorId}
    )
    RETURNING id, name, slug
  `;
  return { ...project, isNew: true };
}

const CANONICAL_PHASES = [
  { name: 'Backlog', position: 1, is_start: true, is_terminal: false, color: '#94a3b8' },
  { name: 'Planning', position: 2, is_start: false, is_terminal: false, color: '#6366f1' },
  { name: 'In Progress', position: 3, is_start: false, is_terminal: false, color: '#0ea5e9' },
  { name: 'Review', position: 4, is_start: false, is_terminal: false, color: '#f59e0b' },
  { name: 'Done', position: 5, is_start: false, is_terminal: true, color: '#10b981' },
];

const CANONICAL_STATES = [
  { name: 'Open', category: 'open', position: 1, is_default: true, is_closed: false, color: '#64748b' },
  { name: 'In Progress', category: 'in_progress', position: 2, is_default: false, is_closed: false, color: '#0ea5e9' },
  { name: 'Blocked', category: 'blocked', position: 3, is_default: false, is_closed: false, color: '#ef4444' },
  { name: 'Done', category: 'done', position: 4, is_default: false, is_closed: true, color: '#10b981' },
];

async function ensurePhases(projectId) {
  const existing = await sql`SELECT id, name, position FROM phases WHERE project_id = ${projectId}`;
  if (existing.length >= CANONICAL_PHASES.length) return existing;

  const phases = [];
  for (const p of CANONICAL_PHASES) {
    const [found] = await sql`
      SELECT id, name, position FROM phases
      WHERE project_id = ${projectId} AND name = ${p.name}
      LIMIT 1
    `;
    if (found) {
      phases.push(found);
      continue;
    }
    const [row] = await sql`
      INSERT INTO phases (project_id, name, color, position, is_start, is_terminal)
      VALUES (${projectId}, ${p.name}, ${p.color}, ${p.position}, ${p.is_start}, ${p.is_terminal})
      RETURNING id, name, position
    `;
    phases.push(row);
  }
  return phases;
}

async function ensureTaskStates(projectId) {
  const existing = await sql`
    SELECT id, name, category, is_default FROM task_states WHERE project_id = ${projectId}
  `;
  if (existing.length >= CANONICAL_STATES.length) return existing;

  const states = [];
  for (const s of CANONICAL_STATES) {
    const [found] = await sql`
      SELECT id, name, category, is_default FROM task_states
      WHERE project_id = ${projectId} AND name = ${s.name}
      LIMIT 1
    `;
    if (found) {
      states.push(found);
      continue;
    }
    const [row] = await sql`
      INSERT INTO task_states (project_id, name, color, category, position, is_default, is_closed)
      VALUES (${projectId}, ${s.name}, ${s.color}, ${s.category}, ${s.position}, ${s.is_default}, ${s.is_closed})
      RETURNING id, name, category, is_default
    `;
    states.push(row);
  }
  return states;
}

// ─── sprints ──────────────────────────────────────────────────────────────

async function ensureSprints(projectId) {
  const existing = await sql`SELECT id, name, status FROM sprints WHERE project_id = ${projectId}`;
  const byName = new Map(existing.map((r) => [r.name, r]));

  const specs = [
    {
      name: 'Sprint 1 (current)',
      goal: 'Ship the current increment of seeded work',
      start_date: dateOnly(daysAgo(7)),
      end_date: dateOnly(daysFromNow(7)),
      status: 'active',
    },
    {
      name: 'Sprint 0 (closed)',
      goal: 'Retrospective demo sprint',
      start_date: dateOnly(daysAgo(21)),
      end_date: dateOnly(daysAgo(7)),
      status: 'completed',
    },
  ];

  const out = [];
  for (const spec of specs) {
    if (byName.has(spec.name)) {
      out.push(byName.get(spec.name));
      continue;
    }
    const [row] = await sql`
      INSERT INTO sprints (project_id, name, goal, start_date, end_date, status)
      VALUES (${projectId}, ${spec.name}, ${spec.goal}, ${spec.start_date}, ${spec.end_date}, ${spec.status})
      RETURNING id, name, status
    `;
    out.push(row);
  }
  return out;
}

// ─── tasks ────────────────────────────────────────────────────────────────

async function seedTasks(project, phases, states, sprints, users, reporterId) {
  const existing = await sql`
    SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = ${project.id}
  `;
  if (existing[0].n >= 8) {
    // Already seeded enough tasks for this project; skip to keep this
    // script idempotent.
    return { inserted: 0, existing: existing[0].n };
  }

  const phaseByName = new Map(phases.map((p) => [p.name, p]));
  const defaultState = states.find((s) => s.is_default) ?? states[0];
  const blockedState = states.find((s) => s.category === 'blocked') ?? defaultState;
  const doneState = states.find((s) => s.category === 'done') ?? defaultState;

  const activeSprint = sprints.find((s) => s.status === 'active');
  const completedSprint = sprints.find((s) => s.status === 'completed');

  // Distribute the 15-task minimum across both projects. Mage gets 10,
  // Internal gets 5, which gives a nice showcase on the more public
  // project and fills the "Internal" project enough to not look empty.
  const isMage = project.slug === 'mage';
  const count = isMage ? 10 : 5;
  const priorities = ['low', 'medium', 'high', 'urgent'];
  const phaseSeq = ['Backlog', 'Planning', 'In Progress', 'Review', 'Done'];

  let inserted = 0;
  for (let i = 0; i < count; i++) {
    const phaseName = phaseSeq[i % phaseSeq.length];
    const phase = phaseByName.get(phaseName) ?? phases[0];
    const priority = priorities[i % priorities.length];
    const assignee = users[i % users.length];
    const isBlocked = i === 3; // first slot is phase=Review by index; keep 1 blocked
    const hasCustom = i === 1;
    const isHighPriorityFlagged = i === 7 || i === 2;
    const state =
      phaseName === 'Done' ? doneState : isBlocked ? blockedState : defaultState;

    const humanId = `${project.task_id_prefix ?? project.prefix ?? 'TSK'}-${100 + i}`;

    // Pre-check idempotency by (project_id, human_id). The seeded IDs are
    // deterministic so re-running the seeder is a no-op for this pair.
    const [existingTask] = await sql`
      SELECT id FROM tasks
      WHERE project_id = ${project.id} AND human_id = ${humanId}
      LIMIT 1
    `;
    if (existingTask) continue;

    const customFields = hasCustom
      ? { risk_level: 'medium', customer_segment: 'enterprise', est_revenue_usd: 45000 }
      : {};

    // 1 task (the 4th) lives in the completed sprint to show a sprint
    // that already ended with real work attached. Others go on the
    // active sprint if their phase is not 'Done'.
    let sprintId = null;
    if (i === 4 && completedSprint) sprintId = completedSprint.id;
    else if (phaseName !== 'Done' && activeSprint) sprintId = activeSprint.id;

    await sql`
      INSERT INTO tasks (
        project_id, human_id, title, description,
        phase_id, state_id, sprint_id, assignee_id, reporter_id,
        priority, is_blocked, custom_fields, position
      ) VALUES (
        ${project.id}, ${humanId},
        ${`Seeded task ${i + 1} for ${project.name}`},
        ${`Demo content for ${humanId}. ${isHighPriorityFlagged ? 'Flagged as high priority.' : ''}`.trim()},
        ${phase.id}, ${state.id}, ${sprintId}, ${assignee.id}, ${reporterId},
        ${priority}, ${isBlocked}, ${sql.json(customFields)}, ${i * 1024.0}
      )
    `;
    inserted++;
  }

  // Bump task_id_sequence on the project so the next human-created task
  // picks up where we left off.
  if (inserted > 0) {
    await sql`
      UPDATE projects
      SET task_id_sequence = GREATEST(task_id_sequence, ${100 + count - 1})
      WHERE id = ${project.id}
    `;
  }

  return { inserted, existing: existing[0].n };
}

// ─── activity_log ─────────────────────────────────────────────────────────

async function seedActivity(orgId, projectId, actors) {
  const [existing] = await sql`
    SELECT COUNT(*)::int AS n FROM activity_log WHERE project_id = ${projectId}
  `;
  if (existing.n >= 3) return 0;

  const entries = [
    { action: 'project.created', details: { source: 'seed-platform' } },
    { action: 'task.created', details: { count: 15 } },
    { action: 'sprint.started', details: { sprint_name: 'Sprint 1 (current)' } },
  ];

  let inserted = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const actor = actors[i % actors.length];
    await sql`
      INSERT INTO activity_log (project_id, actor_id, action, details)
      VALUES (${projectId}, ${actor.id}, ${e.action}, ${sql.json(e.details)})
    `;
    inserted++;
  }
  return inserted;
}

// ─── api keys + rotation ──────────────────────────────────────────────────

async function mintApiKey(orgId, userId, name, scope, opts = {}) {
  const rnd = crypto.randomBytes(32).toString('base64url');
  const fullToken = `bbam_${rnd}`;
  const keyPrefix = fullToken.slice(0, 8);
  const keyHash = await argon2.hash(fullToken);

  const [key] = await sql`
    INSERT INTO api_keys (
      user_id, org_id, name, key_hash, key_prefix, scope,
      expires_at, rotated_at, rotation_grace_expires_at, predecessor_id
    ) VALUES (
      ${userId}, ${orgId}, ${name}, ${keyHash}, ${keyPrefix}, ${scope},
      ${opts.expiresAt ?? null}, ${opts.rotatedAt ?? null},
      ${opts.rotationGraceExpiresAt ?? null}, ${opts.predecessorId ?? null}
    )
    RETURNING id, name, key_prefix
  `;
  return { ...key, fullToken };
}

async function seedApiKeys(orgId, users) {
  // Idempotency: if we already have seeded keys by name, skip.
  const admin = users.find((u) => u.email === 'admin@example.com');
  const bob = users.find((u) => u.email === 'bob@example.com');
  if (!admin || !bob) return { readKey: null, rwKey: null, bobPredecessor: null, bobSuccessor: null };

  const existing = await sql`
    SELECT name FROM api_keys
    WHERE org_id = ${orgId}
      AND name IN ('seed:read', 'seed:read_write', 'seed:bob-predecessor', 'seed:bob-successor')
  `;
  const existingNames = new Set(existing.map((r) => r.name));

  let readKey = null;
  let rwKey = null;
  let bobPredecessor = null;
  let bobSuccessor = null;

  if (!existingNames.has('seed:read')) {
    readKey = await mintApiKey(orgId, admin.id, 'seed:read', 'read');
    console.log(`[SEED-API-KEY] scope=read name=seed:read token=${readKey.fullToken}`);
  }
  if (!existingNames.has('seed:read_write')) {
    rwKey = await mintApiKey(orgId, admin.id, 'seed:read_write', 'read_write');
    console.log(`[SEED-API-KEY] scope=read_write name=seed:read_write token=${rwKey.fullToken}`);
  }

  // Rotation predecessor / successor pair for Bob. The predecessor is
  // marked rotated_at = now() with a 7-day grace window; the successor
  // points at the predecessor via predecessor_id. This exercises the
  // wave 1.A rotation columns from migration 0117.
  if (!existingNames.has('seed:bob-predecessor')) {
    bobPredecessor = await mintApiKey(orgId, bob.id, 'seed:bob-predecessor', 'read_write', {
      rotatedAt: new Date(),
      rotationGraceExpiresAt: daysFromNow(7),
    });
    console.log(
      `[SEED-API-KEY] scope=read_write name=seed:bob-predecessor (ROTATED, grace 7d) token=${bobPredecessor.fullToken}`,
    );
  }
  if (!existingNames.has('seed:bob-successor')) {
    // Look up the predecessor id if we just minted it or it already
    // existed from a prior run.
    const [pred] = bobPredecessor
      ? [{ id: bobPredecessor.id }]
      : await sql`
          SELECT id FROM api_keys
          WHERE org_id = ${orgId} AND name = 'seed:bob-predecessor'
          LIMIT 1
        `;
    if (pred) {
      bobSuccessor = await mintApiKey(orgId, bob.id, 'seed:bob-successor', 'read_write', {
        predecessorId: pred.id,
      });
      console.log(
        `[SEED-API-KEY] scope=read_write name=seed:bob-successor (predecessor=${pred.id}) token=${bobSuccessor.fullToken}`,
      );
    }
  }

  return { readKey, rwKey, bobPredecessor, bobSuccessor };
}

// ─── OAuth user link stub ─────────────────────────────────────────────────

async function seedOauthLinkForAlice(users) {
  const alice = users.find((u) => u.email === 'alice@example.com');
  if (!alice) return 0;

  const [existing] = await sql`
    SELECT id FROM oauth_user_links
    WHERE user_id = ${alice.id} AND provider_name = 'github'
    LIMIT 1
  `;
  if (existing) return 0;

  await sql`
    INSERT INTO oauth_user_links (
      user_id, provider_name, external_id, external_email, external_login, last_sync_at
    ) VALUES (
      ${alice.id}, 'github', 'seed-alice-github-91823746', 'alice@github.example', 'alice-ghub', now()
    )
    ON CONFLICT (provider_name, external_id) DO NOTHING
  `;
  return 1;
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Platform seed: connecting...');

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
  console.log(`Platform seed: org "${org.name}" (${org.slug}) ${org.id}`);

  // ── Users ───────────────────────────────────────────────────────────────
  const userSpecs = [
    { email: 'alice@example.com', displayName: 'Alice Admin', role: 'admin' },
    { email: 'bob@example.com', displayName: 'Bob Member', role: 'member' },
    { email: 'carol@example.com', displayName: 'Carol Contributor', role: 'member' },
    { email: 'dave@example.com', displayName: 'Dave Dev', role: 'member' },
    { email: 'eve@example.com', displayName: 'Eve Viewer', role: 'viewer' },
    { email: 'frank@example.com', displayName: 'Frank Feature', role: 'member' },
  ];

  let newUsers = 0;
  const createdUsers = [];
  for (const spec of userSpecs) {
    const u = await ensureUser(org.id, spec);
    if (u.isNew) {
      newUsers++;
      console.log(`  + user ${spec.email} (${spec.role})`);
    }
    createdUsers.push(u);
  }

  // Pull every user in the org, including the pre-existing admin, for the
  // round-robin assignment pool.
  const allUsersRows = await sql`
    SELECT u.id, u.email, u.display_name
    FROM users u
    JOIN organization_memberships m ON m.user_id = u.id
    WHERE m.org_id = ${org.id} AND u.is_active = true
    ORDER BY m.joined_at
  `;
  const users = allUsersRows.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
  }));
  console.log(`  total active users in org: ${users.length}`);

  // The admin from create-admin is the canonical reporter / creator.
  // Wave E.F: org role lives in account_group_memberships → permission_groups,
  // identified by the fixed owner group UUID (seeded by migration 0146).
  const [adminUser] = await sql`
    SELECT u.id FROM users u
    JOIN organization_memberships m ON m.user_id = u.id
    JOIN account_group_memberships agm
      ON agm.user_id = u.id
     AND agm.scope_type = 'org'
     AND agm.scope_id = ${org.id}
    WHERE m.org_id = ${org.id} AND agm.group_id = ${BUILTIN_GROUP_IDS.owner}
    ORDER BY m.joined_at
    LIMIT 1
  `;
  const creatorId = adminUser?.id ?? users[0].id;

  // ── Projects ────────────────────────────────────────────────────────────
  const projectSpecs = [
    {
      name: 'Mage',
      slug: 'mage',
      description: 'Primary demo project for cross-app seed scenarios.',
      icon: '\u{1F9D9}',
      color: '#6366f1',
      prefix: 'MAGE',
    },
    {
      name: 'Internal',
      slug: 'internal',
      description: 'Internal housekeeping tasks, ops work, docs.',
      icon: '\u{1F6E0}',
      color: '#0ea5e9',
      prefix: 'INT',
    },
  ];

  const projects = [];
  for (const spec of projectSpecs) {
    const p = await ensureProject(org.id, creatorId, spec);
    projects.push({ ...p, prefix: spec.prefix });
    if (p.isNew) console.log(`  + project ${p.slug} (${p.name})`);
  }

  // ── Enroll every org user as a member of every project ────────────────
  // Without this, Bam's listProjects uses an inner-join on
  // project_memberships and returns "No projects yet" for anyone who
  // hasn't been explicitly added. For a demo environment we want every
  // seeded user to see every seeded project, plus the admin who was
  // created by cli.js create-admin.
  const [adminByEmail] = await sql`
    SELECT id FROM users WHERE email = 'admin@example.com' LIMIT 1
  `;
  const memberIds = new Set(users.map((u) => u.id));
  if (adminByEmail?.id) memberIds.add(adminByEmail.id);
  let membershipsInserted = 0;
  for (const p of projects) {
    for (const uid of memberIds) {
      const res = await sql`
        INSERT INTO project_memberships (project_id, user_id, role)
        VALUES (${p.id}, ${uid}, 'admin')
        ON CONFLICT (project_id, user_id) DO NOTHING
        RETURNING id
      `;
      if (res.length > 0) membershipsInserted++;
    }
  }
  if (membershipsInserted > 0) {
    console.log(`  + ${membershipsInserted} project_memberships`);
  }

  // ── Phases, states, sprints, tasks per project ─────────────────────────
  let totalTasksInserted = 0;
  for (const project of projects) {
    const phases = await ensurePhases(project.id);
    const states = await ensureTaskStates(project.id);
    const sprints = await ensureSprints(project.id);
    const { inserted } = await seedTasks(project, phases, states, sprints, users, creatorId);
    totalTasksInserted += inserted;
    console.log(`  project "${project.name}": phases=${phases.length} states=${states.length} sprints=${sprints.length} tasks+=${inserted}`);
  }

  // ── activity_log ───────────────────────────────────────────────────────
  const mage = projects.find((p) => p.slug === 'mage');
  let activityInserted = 0;
  if (mage) activityInserted = await seedActivity(org.id, mage.id, users);

  // ── API keys + rotation ────────────────────────────────────────────────
  await seedApiKeys(org.id, users);

  // ── OAuth user link stub for Alice ─────────────────────────────────────
  const oauthLinks = await seedOauthLinkForAlice(users);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('');
  console.log('─── Platform seed summary ────────────────────────────────');
  console.log(`  new users inserted:   ${newUsers}`);
  console.log(`  projects:             ${projects.length}`);
  console.log(`  tasks inserted:       ${totalTasksInserted}`);
  console.log(`  activity_log rows:    ${activityInserted}`);
  console.log(`  oauth_user_links (+): ${oauthLinks}`);
  console.log('─────────────────────────────────────────────────────────');

  await sql.end({ timeout: 2 });
}

main().catch(async (err) => {
  console.error('Platform seed FATAL:', err instanceof Error ? err.stack ?? err.message : err);
  try {
    await sql.end({ timeout: 2 });
  } catch {
    // ignore
  }
  process.exit(1);
});
