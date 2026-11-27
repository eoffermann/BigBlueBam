/**
 * Issue #160: references into and out of the partitioned banter_messages table,
 * against a real migrated database (migration 0335).
 *
 * 0124 made banter_messages partitioned and its CASCADE drop removed every
 * foreign key on it, so deleting a message left orphan attachments, reactions,
 * pins and bookmarks. The references into banter_messages are now enforced by
 * triggers with the old ON DELETE behavior, and the references out of it are
 * real foreign keys again.
 *
 * Runs whenever DATABASE_URL points at a migrated database; skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;

const ORG = randomUUID();
const USER = randomUUID();
const CHANNEL = randomUUID();

describe.skipIf(!DATABASE_URL)('banter message referential integrity (#160, real DB)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 1, onnotice: () => {} });
    const slug = `refint-${ORG.slice(0, 8)}`;
    await sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, ${slug}, ${slug})`;
    await sql`INSERT INTO users (id, org_id, email, display_name) VALUES (${USER}, ${ORG}, ${`gilligan-${USER.slice(0, 8)}@refint.test`}, 'Gilligan')`;
    await sql`INSERT INTO banter_channels (id, org_id, name, slug, created_by) VALUES (${CHANNEL}, ${ORG}, 'lagoon', ${`lagoon-${CHANNEL.slice(0, 8)}`}, ${USER})`;
    await sql`INSERT INTO banter_channel_memberships (channel_id, user_id) VALUES (${CHANNEL}, ${USER})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM banter_channels WHERE id = ${CHANNEL}`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await sql`DELETE FROM organizations WHERE id = ${ORG}`;
    await sql.end({ timeout: 5 });
  });

  async function message(threadParent: string | null = null): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO banter_messages (channel_id, author_id, content, thread_parent_id)
      VALUES (${CHANNEL}, ${USER}, 'Rescue sighting', ${threadParent}) RETURNING id`;
    return row!.id;
  }

  async function count(table: string, column: string, id: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} = ${id}`;
    return row!.n;
  }

  it('deleting a message removes its attachments, reactions, pins and bookmarks and clears pointers to it', async () => {
    const msg = await message();
    const reply = await message(msg);
    await sql`INSERT INTO banter_message_attachments (message_id, uploader_id, filename, content_type, size_bytes, storage_key)
              VALUES (${msg}, ${USER}, 'map.png', 'image/png', 3, ${`k/${msg}`})`;
    await sql`INSERT INTO banter_message_reactions (message_id, user_id, emoji) VALUES (${msg}, ${USER}, 'palm')`;
    await sql`INSERT INTO banter_pins (channel_id, message_id, pinned_by) VALUES (${CHANNEL}, ${msg}, ${USER})`;
    await sql`INSERT INTO banter_bookmarks (user_id, message_id) VALUES (${USER}, ${msg})`;
    await sql`UPDATE banter_channel_memberships SET last_read_message_id = ${msg} WHERE channel_id = ${CHANNEL} AND user_id = ${USER}`;

    await sql`DELETE FROM banter_messages WHERE id = ${msg}`;

    expect(await count('banter_message_attachments', 'message_id', msg)).toBe(0);
    expect(await count('banter_message_reactions', 'message_id', msg)).toBe(0);
    expect(await count('banter_pins', 'message_id', msg)).toBe(0);
    expect(await count('banter_bookmarks', 'message_id', msg)).toBe(0);
    expect(await count('banter_channel_memberships', 'last_read_message_id', msg)).toBe(0);
    const [r] = await sql<{ thread_parent_id: string | null }[]>`SELECT thread_parent_id FROM banter_messages WHERE id = ${reply}`;
    expect(r!.thread_parent_id).toBeNull();
  });

  it('moving a message to another partition (created_at change) keeps its children', async () => {
    const msg = await message();
    await sql`INSERT INTO banter_message_reactions (message_id, user_id, emoji) VALUES (${msg}, ${USER}, 'coconut')`;
    await sql`UPDATE banter_messages SET created_at = created_at - interval '400 days' WHERE id = ${msg}`;
    expect(await count('banter_message_reactions', 'message_id', msg)).toBe(1);
  });

  it('rejects a child row for a message that does not exist with SQLSTATE 23503', async () => {
    const ghost = randomUUID();
    const err = await sql`INSERT INTO banter_message_attachments (message_id, uploader_id, filename, content_type, size_bytes, storage_key)
                          VALUES (${ghost}, ${USER}, 'x.png', 'image/png', 1, 'k/ghost')`.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23503');
    const err2 = await sql`UPDATE banter_channel_memberships SET last_read_message_id = ${ghost} WHERE channel_id = ${CHANNEL}`.catch(
      (e: unknown) => e,
    );
    expect((err2 as { code?: string }).code).toBe('23503');
  });

  it('banter_messages has real foreign keys to its channel and author again', async () => {
    const err = await sql`INSERT INTO banter_messages (channel_id, author_id, content) VALUES (${randomUUID()}, ${USER}, 'x')`.catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('23503');
    const msg = await message();
    const other = randomUUID();
    await sql`INSERT INTO banter_channels (id, org_id, name, slug, created_by) VALUES (${other}, ${ORG}, 'raft', ${`raft-${other.slice(0, 8)}`}, ${USER})`;
    await sql`UPDATE banter_messages SET channel_id = ${other} WHERE id = ${msg}`;
    await sql`DELETE FROM banter_channels WHERE id = ${other}`;
    expect(await count('banter_messages', 'id', msg)).toBe(0);
  });
});
