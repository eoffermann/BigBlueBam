// A small Gilligan-themed world in a real, migrated database for bay-api route tests (#178):
// two orgs, an admin and a viewer in org A, a member of org B, sessions for each, and a
// 'read'-scope Bam API key for the org A admin. Every id is fresh per run, and teardown deletes
// exactly what was created, so the suite is safe against a shared CI database.
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type postgres from 'postgres';
import { builtinGroupIdForRole } from '@bigbluebam/db-stubs';

export interface World {
  orgA: string;
  orgB: string;
  skipper: string; // admin, org A
  gilligan: string; // viewer, org A
  howell: string; // member, org B
  sessions: { skipper: string; gilligan: string; howell: string };
  readKey: string; // bbam_ key, scope 'read', owned by skipper in org A
}

async function addUser(sql: postgres.Sql, orgId: string, name: string, role: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO users (id, org_id, email, display_name)
            VALUES (${id}, ${orgId}, ${`${name}-${id.slice(0, 8)}@gilligantravel.example`}, ${name})`;
  await sql`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES (${id}, ${orgId}, true)`;
  await sql`INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id)
            VALUES (${id}, ${builtinGroupIdForRole(role)}, 'org', ${orgId})`;
  return id;
}

async function addSession(sql: postgres.Sql, userId: string, orgId: string): Promise<string> {
  const id = randomBytes(24).toString('hex');
  await sql`INSERT INTO sessions (id, user_id, expires_at, active_org_id)
            VALUES (${id}, ${userId}, now() + interval '1 hour', ${orgId})`;
  return id;
}

export async function createWorld(sql: postgres.Sql): Promise<World> {
  const orgA = randomUUID();
  const orgB = randomUUID();
  for (const [id, name] of [
    [orgA, 'Minnow Charters'],
    [orgB, 'Howell Holdings'],
  ] as const) {
    await sql`INSERT INTO organizations (id, name, slug) VALUES (${id}, ${name}, ${`t178-${id.slice(0, 8)}`})`;
  }
  const skipper = await addUser(sql, orgA, 'Skipper', 'admin');
  const gilligan = await addUser(sql, orgA, 'Gilligan', 'viewer');
  const howell = await addUser(sql, orgB, 'Thurston Howell', 'member');

  const secret = randomBytes(18).toString('hex');
  const readKey = `bbam_${secret}`;
  await sql`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, scope)
            VALUES (${skipper}, ${orgA}, 'read-only test key', ${await argon2.hash(readKey, { type: argon2.argon2id })},
                    ${readKey.slice(0, 8)}, 'read')`;

  return {
    orgA,
    orgB,
    skipper,
    gilligan,
    howell,
    sessions: {
      skipper: await addSession(sql, skipper, orgA),
      gilligan: await addSession(sql, gilligan, orgA),
      howell: await addSession(sql, howell, orgB),
    },
    readKey,
  };
}

/** Delete everything createWorld (and the tests, through org cascade) made. */
export async function destroyWorld(sql: postgres.Sql, w: World): Promise<void> {
  const users = [w.skipper, w.gilligan, w.howell];
  const orgs = [w.orgA, w.orgB];
  // bay_* rows reference users without cascade; remove them by org first.
  await sql`DELETE FROM bay_review_decisions WHERE version_id IN (
              SELECT v.id FROM bay_asset_versions v JOIN bay_assets a ON a.id = v.asset_id WHERE a.org_id IN ${sql(orgs)})`;
  await sql`DELETE FROM bay_annotations WHERE version_id IN (
              SELECT v.id FROM bay_asset_versions v JOIN bay_assets a ON a.id = v.asset_id WHERE a.org_id IN ${sql(orgs)})`;
  await sql`DELETE FROM bay_review_links WHERE org_id IN ${sql(orgs)}`;
  await sql`UPDATE bay_assets SET current_version_id = NULL WHERE org_id IN ${sql(orgs)}`;
  await sql`DELETE FROM bay_asset_versions WHERE asset_id IN (SELECT id FROM bay_assets WHERE org_id IN ${sql(orgs)})`;
  await sql`DELETE FROM bay_assets WHERE org_id IN ${sql(orgs)}`;
  await sql`DELETE FROM api_keys WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM sessions WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM account_group_memberships WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM organization_memberships WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM users WHERE id IN ${sql(users)}`;
  await sql`DELETE FROM organizations WHERE id IN ${sql(orgs)}`;
}
