import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { organizations } from './db/schema/organizations.js';
import { users } from './db/schema/users.js';
import { organizationMemberships } from './db/schema/organization-memberships.js';
import { apiKeys } from './db/schema/api-keys.js';
import { agentPolicies } from './db/schema/agent-policies.js';
import { accountGroupMemberships } from './db/schema/permissions.js';
import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';

// Wave E.F: fixed UUIDs of the five built-in permission groups (seeded by
// migration 0146). Used by cli.ts to upsert account_group_memberships
// rows when creating users, replacing the dropped users.role and
// organization_memberships.role columns.
const BUILTIN_GROUP_IDS: Record<string, string> = {
  owner: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  guest: '55555555-5555-4555-8555-555555555555',
};

// Local reference to the helpdesk_agent_api_keys table (owned by the
// helpdesk-api app) — duplicated here rather than imported so cli.js
// has no cross-app build dependency. HB-28 + HB-49.
const helpdeskAgentApiKeys = pgTable('helpdesk_agent_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  bbb_user_id: uuid('bbb_user_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  key_hash: text('key_hash').notNull(),
  key_prefix: varchar('key_prefix', { length: 8 }).notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
});

const VALID_ROLES = ['owner', 'admin', 'member', 'viewer', 'guest'] as const;
const VALID_SCOPES = ['read', 'read_write', 'admin'] as const;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/** Slugs reserved by SPA route segments (Helpdesk, platform, etc). */
const RESERVED_ORG_SLUGS = new Set([
  'login', 'register', 'verify', 'tickets',
  'admin', 'api', 'auth', 'health', 'mcp',
  'files', 'static', 'assets',
]);

function printUsage() {
  console.log(`
BigBlueBam CLI

Usage:
  cli <command> [options]

Commands:
  create-admin       Create a new organization with an owner user (+ optional SuperUser)
  create-user        Create a user inside an EXISTING organization with any role
  grant-superuser    Promote an existing user to SuperUser by email
  revoke-superuser   Remove SuperUser privileges from a user by email
  create-api-key     Issue an API key for a user (for agentic / programmatic access)
  create-service-account     Create a locked service-account user + bbam_svc_ API key
  create-helpdesk-agent-key  Issue a per-agent helpdesk API key (HB-28 + HB-49)
  revoke-api-key     Revoke a Bam API key by its key_prefix (hard delete)
  revoke-helpdesk-agent-key  Revoke a helpdesk agent API key by its key_prefix (soft by default)
  list-orgs          List all organizations (id, slug, name) — helper for other commands

Common user roles:       owner, admin, member, viewer, guest
Common API key scopes:   read, read_write, admin

Examples:

  # Bootstrap: create a new org + owner user
  cli create-admin --email admin@example.com --password <pw> --name "Admin" --org "Acme Inc"

  # Bootstrap + make them a platform SuperUser
  cli create-admin --email you@co.com --password <pw> --name "You" --org "Acme" --superuser

  # Promote an existing user to SuperUser (no new org)
  cli grant-superuser --email you@co.com

  # Add a regular member to an existing org
  cli create-user --email alice@co.com --password <pw> --name "Alice" \\
      --org-slug acme --role member

  # Add a watch-only viewer (useful for read-only agents or observers)
  cli create-user --email viewer-bot@co.com --password <pw> --name "Watcher" \\
      --org-slug acme --role viewer

  # Issue a read-only API key for an agent (prints the key ONCE — store it)
  # --org-slug pins the key to exactly one org even if the user joins others.
  cli create-api-key --email viewer-bot@co.com --name "dashboard-bot" --scope read \\
      --org-slug acme

  # Issue a scoped read-write key restricted to one project, 90 day expiry
  cli create-api-key --email alice@co.com --name "ci-bot" --scope read_write \\
      --org-slug acme --project-id <uuid> --expires-days 90

  # Create a locked service account for internal service-to-service calls
  # (e.g. mcp-server's /tools/call route). Prints the bbam_svc_ token ONCE.
  cli create-service-account --name "mcp-internal" --org-slug acme

  # Mint a per-agent helpdesk API key for a Bam employee (printed ONCE)
  cli create-helpdesk-agent-key --email agent@co.com --name "agent-mbp" \\
      --expires-days 365

  # Revoke a Bam API key by its prefix (user's token is destroyed)
  cli revoke-api-key --prefix bbam_abc

  # Soft-revoke a helpdesk agent key (row kept with revoked_at set)
  cli revoke-helpdesk-agent-key --prefix hdag_xyz

  # Hard-delete (emergencies)
  cli revoke-helpdesk-agent-key --prefix hdag_xyz --hard
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const booleanFlags = new Set(['superuser', 'hard', 'force']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        result[key] = 'true';
      } else if (i + 1 < args.length) {
        result[key] = args[i + 1]!;
        i++;
      }
    }
  }
  return result;
}

function getDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required');
    process.exit(1);
  }
  const client = postgres(databaseUrl, { max: 1 });
  return { db: drizzle(client), client };
}

function requireFlags(flags: Record<string, string>, required: string[]): void {
  const missing = required.filter((k) => !flags[k]);
  if (missing.length > 0) {
    console.error(`Error: required flag(s) missing: ${missing.map((f) => `--${f}`).join(', ')}`);
    process.exit(1);
  }
}

async function createAdmin(flags: Record<string, string>) {
  requireFlags(flags, ['email', 'password', 'name', 'org']);
  const { email, password, name, org: orgName } = flags;
  const isSuperuser = flags.superuser === 'true';

  if (password!.length < 12) {
    console.error('Error: password must be at least 12 characters');
    process.exit(1);
  }

  const { db, client } = getDb();
  try {
    const passwordHash = await argon2.hash(password!);
    const orgSlug = slugify(orgName!);

    if (RESERVED_ORG_SLUGS.has(orgSlug)) {
      console.error(`Error: slug "${orgSlug}" is reserved. Choose a different org name.`);
      process.exit(1);
    }

    const [org] = await db
      .insert(organizations)
      .values({ name: orgName!, slug: orgSlug })
      .returning();

    const [user] = await db
      .insert(users)
      .values({
        org_id: org!.id,
        email: email!,
        display_name: name!,
        password_hash: passwordHash,
        is_superuser: isSuperuser,
      })
      .returning();

    await db.insert(organizationMemberships).values({
      user_id: user!.id,
      org_id: org!.id,
      is_default: true,
    });
    // Wave E.F: role lives in account_group_memberships.
    await db
      .insert(accountGroupMemberships)
      .values({
        user_id: user!.id,
        group_id: BUILTIN_GROUP_IDS.owner!,
        scope_type: 'org',
        scope_id: org!.id,
      })
      .onConflictDoUpdate({
        target: [
          accountGroupMemberships.user_id,
          accountGroupMemberships.scope_type,
          accountGroupMemberships.scope_id,
        ],
        set: { group_id: BUILTIN_GROUP_IDS.owner! },
      });

    console.log('Admin user created successfully:');
    console.log(`  User ID:   ${user!.id}`);
    console.log(`  Email:     ${user!.email}`);
    console.log(`  Org ID:    ${org!.id}`);
    console.log(`  Org Slug:  ${org!.slug}`);
    if (isSuperuser) console.log(`  SuperUser: yes`);
  } finally {
    await client.end();
  }
}

async function createUser(flags: Record<string, string>) {
  requireFlags(flags, ['email', 'password', 'name']);
  const { email, password, name } = flags;
  const role = flags.role ?? 'member';
  const orgSlug = flags['org-slug'];
  const orgId = flags['org-id'];

  if (password!.length < 12) {
    console.error('Error: password must be at least 12 characters');
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    console.error(`Error: --role must be one of ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }
  if (!orgSlug && !orgId) {
    console.error('Error: provide either --org-slug or --org-id');
    process.exit(1);
  }

  const { db, client } = getDb();
  try {
    const [org] = orgId
      ? await db.select().from(organizations).where(eq(organizations.id, orgId!)).limit(1)
      : await db.select().from(organizations).where(eq(organizations.slug, orgSlug!)).limit(1);

    if (!org) {
      console.error(`Error: organization not found (${orgId ? `id=${orgId}` : `slug=${orgSlug}`})`);
      console.error('Hint: run `cli list-orgs` to see available organizations');
      process.exit(1);
    }

    const passwordHash = await argon2.hash(password!);
    const [user] = await db
      .insert(users)
      .values({
        org_id: org.id,
        email: email!,
        display_name: name!,
        password_hash: passwordHash,
        is_superuser: false,
      })
      .returning();

    await db.insert(organizationMemberships).values({
      user_id: user!.id,
      org_id: org.id,
      is_default: true,
    });
    // Wave E.F: role lives in account_group_memberships.
    const groupId = BUILTIN_GROUP_IDS[role];
    if (!groupId) {
      console.error(`Error: no built-in group for role "${role}"`);
      process.exit(1);
    }
    await db
      .insert(accountGroupMemberships)
      .values({
        user_id: user!.id,
        group_id: groupId,
        scope_type: 'org',
        scope_id: org.id,
      })
      .onConflictDoUpdate({
        target: [
          accountGroupMemberships.user_id,
          accountGroupMemberships.scope_type,
          accountGroupMemberships.scope_id,
        ],
        set: { group_id: groupId },
      });

    console.log('User created successfully:');
    console.log(`  User ID:  ${user!.id}`);
    console.log(`  Email:    ${user!.email}`);
    console.log(`  Role:     ${role}`);
    console.log(`  Org:      ${org.name} (${org.slug})`);
  } finally {
    await client.end();
  }
}

async function setSuperuser(flags: Record<string, string>, value: boolean) {
  requireFlags(flags, ['email']);
  const { db, client } = getDb();
  try {
    const result = await db
      .update(users)
      .set({ is_superuser: value })
      .where(eq(users.email, flags.email!))
      .returning({ id: users.id, email: users.email });

    if (result.length === 0) {
      console.error(`Error: no user found with email ${flags.email}`);
      process.exit(1);
    }
    console.log(`${value ? 'Granted' : 'Revoked'} SuperUser on ${result[0]!.email} (${result[0]!.id})`);
  } finally {
    await client.end();
  }
}

async function createApiKey(flags: Record<string, string>) {
  requireFlags(flags, ['email', 'name', 'scope']);
  const { email, name, scope } = flags;
  const projectId = flags['project-id'];
  const expiresDaysStr = flags['expires-days'];
  const orgSlug = flags['org-slug'];
  const orgIdFlag = flags['org-id'];

  if (!VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
    console.error(`Error: --scope must be one of ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }
  if (!orgSlug && !orgIdFlag) {
    console.error('Error: provide either --org-slug or --org-id (P2-8: API keys must be bound to one org)');
    process.exit(1);
  }

  const { db, client } = getDb();
  try {
    const [user] = await db.select().from(users).where(eq(users.email, email!)).limit(1);
    if (!user) {
      console.error(`Error: no user found with email ${email}`);
      process.exit(1);
    }

    // Resolve the target org by slug or id.
    const [org] = orgIdFlag
      ? await db.select().from(organizations).where(eq(organizations.id, orgIdFlag!)).limit(1)
      : await db.select().from(organizations).where(eq(organizations.slug, orgSlug!)).limit(1);
    if (!org) {
      console.error(
        `Error: organization not found (${orgIdFlag ? `id=${orgIdFlag}` : `slug=${orgSlug}`})`,
      );
      console.error('Hint: run `cli list-orgs` to see available organizations');
      process.exit(1);
    }

    // Verify the user is actually a member of that org — don't let operators
    // mint keys for orgs the user has no business accessing.
    const membership = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.user_id, user.id),
          eq(organizationMemberships.org_id, org.id),
        ),
      )
      .limit(1);
    if (membership.length === 0) {
      console.error(
        `Error: user ${user.email} is not a member of org "${org.slug}" — cannot issue a key scoped to that org`,
      );
      process.exit(1);
    }

    // Token format: bbam_<base64url 32 bytes>. The auth plugin slices the
    // first 8 characters as the lookup prefix (apps/api/src/plugins/auth.ts)
    // so we store exactly 8 characters in key_prefix to match.
    const randomToken = randomBytes(32).toString('base64url');
    const fullToken = `bbam_${randomToken}`;
    const prefix = fullToken.slice(0, 8);
    const keyHash = await argon2.hash(fullToken);

    const expiresAt = expiresDaysStr
      ? new Date(Date.now() + Number(expiresDaysStr) * 24 * 60 * 60 * 1000)
      : null;

    const [key] = await db
      .insert(apiKeys)
      .values({
        user_id: user.id,
        org_id: org.id,
        name: name!,
        key_hash: keyHash,
        key_prefix: prefix,
        scope,
        project_ids: projectId ? [projectId] : null,
        expires_at: expiresAt,
      })
      .returning({ id: apiKeys.id, name: apiKeys.name });

    console.log('API key created successfully:');
    console.log(`  Key ID:    ${key!.id}`);
    console.log(`  Name:      ${key!.name}`);
    console.log(`  User:      ${user.email}`);
    console.log(`  Org:       ${org.name} (${org.slug})`);
    console.log(`  Scope:     ${scope}`);
    if (projectId) console.log(`  Project:   ${projectId}`);
    if (expiresAt) console.log(`  Expires:   ${expiresAt.toISOString()}`);
    console.log('');
    console.log('  ── Store this token NOW — it will not be shown again ──');
    console.log(`  Token:     ${fullToken}`);
    console.log('');
    console.log(`  Use in requests as:  Authorization: Bearer ${fullToken}`);
  } finally {
    await client.end();
  }
}

/**
 * Create a locked service-account user and a bbam_svc_ prefixed API key.
 *
 * Service accounts are used for internal service-to-service calls where
 * there is no real human actor. They share the same users/api_keys tables
 * as normal users but with:
 *   - a placeholder email under @system.local
 *   - an argon2id hash of a random string nobody knows (effectively
 *     password-locked; the account cannot log in via /auth/login)
 *   - role 'member' in its home org
 *   - an API key with prefix `bbam_svc_` (9 chars; auth.ts slices the first
 *     8 so `bbam_svc` is the lookup prefix which is safe and distinct from
 *     the generic `bbam_` key prefix)
 *
 * The caller provides --name (required) and either --org-slug or --org-id.
 */
async function createServiceAccount(flags: Record<string, string>) {
  requireFlags(flags, ['name']);
  const { name } = flags;
  const orgSlug = flags['org-slug'];
  const orgIdFlag = flags['org-id'];
  const scope = flags.scope ?? 'read_write';

  if (!orgSlug && !orgIdFlag) {
    console.error('Error: provide either --org-slug or --org-id');
    process.exit(1);
  }
  if (!VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
    console.error(`Error: --scope must be one of ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }

  const safeName = slugify(name!);
  if (!safeName) {
    console.error('Error: --name must slugify to a non-empty identifier');
    process.exit(1);
  }

  const { db, client } = getDb();
  try {
    const [org] = orgIdFlag
      ? await db.select().from(organizations).where(eq(organizations.id, orgIdFlag!)).limit(1)
      : await db.select().from(organizations).where(eq(organizations.slug, orgSlug!)).limit(1);
    if (!org) {
      console.error(
        `Error: organization not found (${orgIdFlag ? `id=${orgIdFlag}` : `slug=${orgSlug}`})`,
      );
      process.exit(1);
    }

    // Build a deterministic placeholder email so re-running the command is
    // idempotent at the directory level (we still create a new API key each
    // run, but the user row is reused if present).
    const email = `svc+${safeName}-${org.slug}@system.local`;

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      // Lock the account with an argon2id hash of a random 32-byte token
      // that we immediately discard. No one knows the password, so login
      // via /auth/login is impossible.
      const lockedPassword = randomBytes(32).toString('base64url');
      const passwordHash = await argon2.hash(lockedPassword);

      [user] = await db
        .insert(users)
        .values({
          org_id: org.id,
          email,
          display_name: `svc:${name}`,
          password_hash: passwordHash,
          is_superuser: false,
          kind: 'service',
        })
        .returning();

      await db.insert(organizationMemberships).values({
        user_id: user!.id,
        org_id: org.id,
        is_default: true,
      });
      // Wave E.F: role lives in account_group_memberships.
      await db
        .insert(accountGroupMemberships)
        .values({
          user_id: user!.id,
          group_id: BUILTIN_GROUP_IDS.member!,
          scope_type: 'org',
          scope_id: org.id,
        })
        .onConflictDoNothing();

      // Permissive §15 policy so the first tool call doesn't fail-closed.
      // Migration 0139 backfilled existing service accounts; new ones
      // minted via this CLI need their row inserted here.
      await db.insert(agentPolicies).values({
        agent_user_id: user!.id,
        org_id: org.id,
        enabled: true,
        allowed_tools: ['*'],
        channel_subscriptions: [],
        updated_by: user!.id,
      });
    }

    // Mint the API key with the bbam_svc_ prefix.
    // auth.ts slices the first 8 chars as key_prefix, so the stored prefix
    // will be exactly 'bbam_svc' which is distinct from the generic 'bbam_xxx'
    // human API keys. The rest of the token is base64url entropy.
    const randomToken = randomBytes(32).toString('base64url');
    const fullToken = `bbam_svc_${randomToken}`;
    const prefix = fullToken.slice(0, 8);
    const keyHash = await argon2.hash(fullToken);

    const [key] = await db
      .insert(apiKeys)
      .values({
        user_id: user!.id,
        org_id: org.id,
        name: `${name} (service account)`,
        key_hash: keyHash,
        key_prefix: prefix,
        scope,
        project_ids: null,
        expires_at: null,
      })
      .returning({ id: apiKeys.id, name: apiKeys.name });

    console.log('Service account created successfully:');
    console.log(`  User ID:    ${user!.id}`);
    console.log(`  Email:      ${email}`);
    console.log(`  Org:        ${org.name} (${org.slug})`);
    console.log(`  Key ID:     ${key!.id}`);
    console.log(`  Scope:      ${scope}`);
    console.log('');
    console.log('  [Store this token NOW, it will not be shown again]');
    console.log(`  Token:      ${fullToken}`);
    console.log('');
    console.log('  Set MCP_INTERNAL_API_TOKEN to this value on mcp-server.');
  } finally {
    await client.end();
  }
}

async function createHelpdeskAgentKey(flags: Record<string, string>) {
  requireFlags(flags, ['email', 'name']);
  const { email, name } = flags;
  const expiresDaysStr = flags['expires-days'];

  const { db, client } = getDb();
  try {
    const [user] = await db.select().from(users).where(eq(users.email, email!)).limit(1);
    if (!user) {
      console.error(`Error: no Bam user found with email ${email}`);
      console.error('Hint: helpdesk agent keys are tied to Bam employee accounts. Create the user with `cli create-user` first.');
      process.exit(1);
    }

    // Token format: hdag_<base64url 32 bytes>. The prefix `hdag_` is
    // distinct from the main bbam_ API keys and from any Bearer JWTs
    // used on customer-facing helpdesk routes, making it obvious at a
    // glance which kind of credential a leaked token is. The auth
    // middleware slices the first 8 characters as the lookup prefix
    // (see apps/helpdesk-api/src/routes/agent.routes.ts), matching the
    // 8-char key_prefix column.
    const randomToken = randomBytes(32).toString('base64url');
    const fullToken = `hdag_${randomToken}`;
    const prefix = fullToken.slice(0, 8);
    const keyHash = await argon2.hash(fullToken);

    const expiresAt = expiresDaysStr
      ? new Date(Date.now() + Number(expiresDaysStr) * 24 * 60 * 60 * 1000)
      : null;

    const [key] = await db
      .insert(helpdeskAgentApiKeys)
      .values({
        bbb_user_id: user.id,
        name: name!,
        key_hash: keyHash,
        key_prefix: prefix,
        expires_at: expiresAt,
      })
      .returning({ id: helpdeskAgentApiKeys.id, name: helpdeskAgentApiKeys.name });

    console.log('Helpdesk agent API key created successfully:');
    console.log(`  Key ID:    ${key!.id}`);
    console.log(`  Name:      ${key!.name}`);
    console.log(`  Agent:     ${user.email}`);
    if (expiresAt) console.log(`  Expires:   ${expiresAt.toISOString()}`);
    console.log('');
    console.log('  ── Store this token NOW — it will not be shown again ──');
    console.log(`  Token:     ${fullToken}`);
    console.log('');
    console.log(`  Use in requests as:  X-Agent-Key: ${fullToken}`);
  } finally {
    await client.end();
  }
}

async function revokeApiKey(flags: Record<string, string>) {
  requireFlags(flags, ['prefix']);
  const { prefix } = flags;
  const idFlag = flags.id;

  const { db, client } = getDb();
  try {
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        user_id: apiKeys.user_id,
        user_email: users.email,
      })
      .from(apiKeys)
      .leftJoin(users, eq(apiKeys.user_id, users.id))
      .where(eq(apiKeys.key_prefix, prefix!));

    if (rows.length === 0) {
      console.error(`Error: no API key found with prefix "${prefix}"`);
      process.exit(1);
    }

    if (rows.length > 1 && !idFlag) {
      console.error(`Error: prefix "${prefix}" matches ${rows.length} keys. Re-run with --id <uuid> to pick one:`);
      for (const r of rows) {
        console.error(`  ${r.id}  name="${r.name}"  user=${r.user_email ?? '(deleted user)'}`);
      }
      process.exit(1);
    }

    const target = idFlag ? rows.find((r) => r.id === idFlag) : rows[0];
    if (!target) {
      console.error(`Error: --id ${idFlag} does not match any of the keys with prefix "${prefix}"`);
      process.exit(1);
    }

    await db.delete(apiKeys).where(eq(apiKeys.id, target.id));

    console.log('API key revoked (deleted):');
    console.log(`  Key ID:    ${target.id}`);
    console.log(`  Name:      ${target.name}`);
    console.log(`  User:      ${target.user_email ?? '(deleted user)'}`);
  } finally {
    await client.end();
  }
}

async function revokeHelpdeskAgentKey(flags: Record<string, string>) {
  requireFlags(flags, ['prefix']);
  const { prefix } = flags;
  const idFlag = flags.id;
  const hard = flags.hard === 'true' || flags.force === 'true';

  const { db, client } = getDb();
  try {
    const rows = await db
      .select({
        id: helpdeskAgentApiKeys.id,
        name: helpdeskAgentApiKeys.name,
        bbb_user_id: helpdeskAgentApiKeys.bbb_user_id,
        revoked_at: helpdeskAgentApiKeys.revoked_at,
        display_name: users.display_name,
        user_email: users.email,
      })
      .from(helpdeskAgentApiKeys)
      .leftJoin(users, eq(helpdeskAgentApiKeys.bbb_user_id, users.id))
      .where(eq(helpdeskAgentApiKeys.key_prefix, prefix!));

    if (rows.length === 0) {
      console.error(`Error: no helpdesk agent key found with prefix "${prefix}"`);
      process.exit(1);
    }

    if (rows.length > 1 && !idFlag) {
      console.error(`Error: prefix "${prefix}" matches ${rows.length} keys. Re-run with --id <uuid> to pick one:`);
      for (const r of rows) {
        console.error(`  ${r.id}  name="${r.name}"  agent=${r.display_name ?? '(deleted)'} <${r.user_email ?? '?'}>`);
      }
      process.exit(1);
    }

    const target = idFlag ? rows.find((r) => r.id === idFlag) : rows[0];
    if (!target) {
      console.error(`Error: --id ${idFlag} does not match any of the keys with prefix "${prefix}"`);
      process.exit(1);
    }

    if (hard) {
      await db.delete(helpdeskAgentApiKeys).where(eq(helpdeskAgentApiKeys.id, target.id));
      console.log('Helpdesk agent API key HARD-deleted:');
    } else {
      if (target.revoked_at) {
        console.log(`Note: key already soft-revoked at ${target.revoked_at.toISOString()} — updating timestamp.`);
      }
      await db
        .update(helpdeskAgentApiKeys)
        .set({ revoked_at: sql`now()` })
        .where(eq(helpdeskAgentApiKeys.id, target.id));
      console.log('Helpdesk agent API key soft-revoked (revoked_at set):');
    }
    console.log(`  Key ID:       ${target.id}`);
    console.log(`  Name:         ${target.name}`);
    console.log(`  Bam user ID:  ${target.bbb_user_id}`);
    console.log(`  Agent:        ${target.display_name ?? '(deleted user)'} <${target.user_email ?? '?'}>`);
  } finally {
    await client.end();
  }
}

async function listOrgs() {
  const { db, client } = getDb();
  try {
    const rows = await db
      .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .orderBy(organizations.name);

    if (rows.length === 0) {
      console.log('(no organizations)');
      return;
    }
    console.log(`Organizations (${rows.length}):`);
    for (const r of rows) {
      console.log(`  ${r.slug.padEnd(30)} ${r.id}  ${r.name}`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  const flags = parseArgs(args.slice(1));

  try {
    switch (command) {
      case 'create-admin':
        await createAdmin(flags);
        break;
      case 'create-user':
        await createUser(flags);
        break;
      case 'grant-superuser':
        await setSuperuser(flags, true);
        break;
      case 'revoke-superuser':
        await setSuperuser(flags, false);
        break;
      case 'create-api-key':
        await createApiKey(flags);
        break;
      case 'create-service-account':
        await createServiceAccount(flags);
        break;
      case 'create-helpdesk-agent-key':
        await createHelpdeskAgentKey(flags);
        break;
      case 'revoke-api-key':
        await revokeApiKey(flags);
        break;
      case 'revoke-helpdesk-agent-key':
        await revokeHelpdeskAgentKey(flags);
        break;
      case 'list-orgs':
        await listOrgs();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error('Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('CLI error:', err);
  process.exit(1);
});
