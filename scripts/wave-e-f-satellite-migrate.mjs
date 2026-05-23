#!/usr/bin/env node
/**
 * Wave E.F satellite migration helper.
 *
 * For each satellite under apps/ that owns a bbb-refs.ts users + memberships
 * stub and an auth.ts plugin:
 *   1. Add accountGroupMemberships + permissionGroups stub tables to bbb-refs.ts
 *      (if not already present), remove the `role` column from users and
 *      organization_memberships.
 *   2. Update src/db/schema/index.ts to re-export the new stubs.
 *   3. Rewrite src/plugins/auth.ts to:
 *        - import the new stubs
 *        - drop `role: users.role` from every select() block
 *        - drop the `role` column from BaseUserRow
 *        - rewrite resolveOrgContext to join account_group_memberships +
 *          permission_groups for the per-org role
 *        - drop the `fallbackRole` parameter and pass through 'member' default
 *
 * Idempotent: re-running on an already-migrated tree is a no-op.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SATELLITES = [
  'bond-api',
  'bench-api',
  'book-api',
  'blast-api',
  'bill-api',
  'blank-api',
  'beacon-api',
  'bearing-api',
  'board-api',
  'bolt-api',
  'brief-api',
];

const PERMISSION_STUBS = `
// Wave E.F: per-action permissions group memberships, used to resolve role
// in the auth plugin. Full schema lives in apps/api.
export const permissionGroups = pgTable('permission_groups', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  scope_type: text('scope_type').notNull(),
  scope_id: uuid('scope_id'),
  is_builtin: boolean('is_builtin').default(false).notNull(),
  legacy_role: text('legacy_role'),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});

export const accountGroupMemberships = pgTable('account_group_memberships', {
  user_id: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  group_id: uuid('group_id')
    .notNull()
    .references(() => permissionGroups.id, { onDelete: 'restrict' }),
  scope_type: text('scope_type').notNull(),
  scope_id: uuid('scope_id'),
  detached_at: timestamp('detached_at', { withTimezone: true }),
  granted_at: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
});
`;

function updateBbbRefs(satellite) {
  const p = path.join(repoRoot, 'apps', satellite, 'src/db/schema/bbb-refs.ts');
  if (!fs.existsSync(p)) {
    console.log(`  skip: ${p} (not present)`);
    return false;
  }
  let src = fs.readFileSync(p, 'utf8');
  let changed = false;

  // Strip users.role column line (with the default value).
  const userRolePattern = /\s*role: varchar\('role', \{ length: 20 \}\)\.default\('member'\)\.notNull\(\),\n/g;
  const beforeUserStrip = src;
  src = src.replace(userRolePattern, '\n');
  if (src !== beforeUserStrip) changed = true;

  // If permissionGroups stub is not present yet, append it.
  if (!src.includes('permissionGroups')) {
    src += PERMISSION_STUBS;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(p, src);
    console.log(`  updated: ${p}`);
    return true;
  }
  console.log(`  unchanged: ${p}`);
  return false;
}

function updateIndex(satellite) {
  const p = path.join(repoRoot, 'apps', satellite, 'src/db/schema/index.ts');
  if (!fs.existsSync(p)) return false;
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes('permissionGroups') && src.includes('accountGroupMemberships')) {
    console.log(`  unchanged: ${p}`);
    return false;
  }
  // Add to the bbb-refs re-export block.
  src = src.replace(
    /(\}\s*from\s*'\.\/bbb-refs\.js';)/,
    `,\n  permissionGroups,\n  accountGroupMemberships,\n} from './bbb-refs.js';`,
  );
  // Some satellites use an `export { ... } from './bbb-refs.js'` pattern with a
  // single trailing brace before the from. The pattern above handles both
  // forms because the closing brace is consumed before the comma rewrite.
  // For safety, also remove duplicate trailing braces.
  src = src.replace(/\}\s*,\s*\n  permissionGroups/, ',\n  permissionGroups');
  fs.writeFileSync(p, src);
  console.log(`  updated: ${p}`);
  return true;
}

function updateAuth(satellite) {
  const p = path.join(repoRoot, 'apps', satellite, 'src/plugins/auth.ts');
  if (!fs.existsSync(p)) {
    console.log(`  skip: ${p} (not present)`);
    return false;
  }
  let src = fs.readFileSync(p, 'utf8');
  let changed = false;

  // Add accountGroupMemberships + permissionGroups to the import line.
  const importPattern = /import\s*\{\s*sessions,\s*users,\s*apiKeys,\s*organizationMemberships\s*\}\s*from\s*'\.\.\/db\/schema\/index\.js';/;
  if (importPattern.test(src) && !src.includes('accountGroupMemberships')) {
    src = src.replace(
      importPattern,
      `import {
  sessions,
  users,
  apiKeys,
  organizationMemberships,
  accountGroupMemberships,
  permissionGroups,
} from '../db/schema/index.js';`,
    );
    changed = true;
  }

  // Ensure 'and' is imported from drizzle-orm.
  if (!/\bimport\s*\{[^}]*\band\b[^}]*\}\s*from\s*'drizzle-orm'/.test(src)) {
    src = src.replace(
      /import\s*\{\s*eq\s*\}\s*from\s*'drizzle-orm';/,
      "import { and, eq } from 'drizzle-orm';",
    );
    changed = true;
  }

  // Drop `role: users.role,` rows.
  const beforeRoleStrip = src;
  src = src.replace(/\s*role: users\.role,\n/g, '\n');
  if (src !== beforeRoleStrip) changed = true;

  // Drop the `role: string;` field from BaseUserRow.
  src = src.replace(
    /(interface BaseUserRow \{[^}]*?)\s*role: string;\n/s,
    '$1\n',
  );

  // Drop fallbackRole parameter from resolveOrgContext.
  src = src.replace(
    /async function resolveOrgContext\(\s*userId: string,\s*fallbackOrgId: string,\s*fallbackRole: string,/,
    'async function resolveOrgContext(\n  userId: string,\n  fallbackOrgId: string,',
  );

  // Replace organizationMemberships.role read with leftJoin to permission_groups.
  src = src.replace(
    /const rows = await db\s*\.select\(\{\s*org_id: organizationMemberships\.org_id,\s*role: organizationMemberships\.role,\s*is_default: organizationMemberships\.is_default,\s*joined_at: organizationMemberships\.joined_at,\s*\}\)\s*\.from\(organizationMemberships\)\s*\.where\(eq\(organizationMemberships\.user_id, userId\)\);/,
    `const rows = await db
    .select({
      org_id: organizationMemberships.org_id,
      role: permissionGroups.legacy_role,
      is_default: organizationMemberships.is_default,
      joined_at: organizationMemberships.joined_at,
    })
    .from(organizationMemberships)
    .leftJoin(
      accountGroupMemberships,
      and(
        eq(accountGroupMemberships.user_id, organizationMemberships.user_id),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, organizationMemberships.org_id),
      ),
    )
    .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(eq(organizationMemberships.user_id, userId));`,
  );

  // Replace the fallback returns that referenced fallbackRole.
  src = src.replace(
    /memberships: \[\s*\{ org_id: fallbackOrgId, role: fallbackRole, is_default: true \},?\s*\],\s*activeOrgId: fallbackOrgId,\s*activeRole: fallbackRole,/g,
    `memberships: [{ org_id: fallbackOrgId, role: 'member', is_default: true }],
      activeOrgId: fallbackOrgId,
      activeRole: 'member',`,
  );

  // Replace `role: r.role,` (which was non-null pre-migration) with the
  // null-fallback version.
  src = src.replace(
    /role: r\.role,\n(\s*)is_default: r\.is_default,/g,
    `role: r.role ?? 'member',\n$1is_default: r.is_default,`,
  );

  // Drop the row.role passthrough in buildAuthUser.
  src = src.replace(
    /row\.role,\s*\n\s*requestedOrgId,/g,
    'requestedOrgId,',
  );

  // For banter-api's session-active variant: handle the same passthrough
  // pattern where row.role is followed by other args.
  src = src.replace(/    row\.role,\n/g, '');

  fs.writeFileSync(p, src);
  console.log(`  ${changed ? 'updated' : 'rewritten'}: ${p}`);
  return true;
}

console.log('Wave E.F satellite migration\n');
for (const sat of SATELLITES) {
  console.log(`\n=== ${sat} ===`);
  updateBbbRefs(sat);
  updateIndex(sat);
  updateAuth(sat);
}
console.log('\nDone.');
