/**
 * Issue #160: references into and out of the partitioned banter_messages table,
 * against a real migrated database (migration 0335).
 *
 * 0124 made banter_messages partitioned and its CASCADE drop removed every
 * foreign key on it, so deleting a message left orphan attachments, reactions,
 * pins and bookmarks. The references into banter_messages are now enforced by
 * triggers with the old ON DELETE behavior, and the references out of it are
 * real foreign keys again. 0361 makes the insert side lock the message like a
 * foreign key (#368); 0362 makes the delete side one indexed set-based
 * statement per table (#370).
 *
 * Runs whenever DATABASE_URL points at a migrated database; skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { deleteImportedContent } from '../src/services/slack-import-abort.js';

const DATABASE_URL = process.env.DATABASE_URL;

const ORG = randomUUID();
const USER = randomUUID();
const CHANNEL = randomUUID();

describe.skipIf(!DATABASE_URL)('banter message referential integrity (#160, real DB)', () => {
  let sql: postgres.Sql;
  // A second session, for the concurrent insert/delete cases (#368).
  let other: postgres.Sql;

  beforeAll(async () => {
    // Two connections: the concurrency cases reserve one and probe pg_stat_activity on the other.
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
    other = postgres(DATABASE_URL as string, { max: 1, onnotice: () => {} });
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
    await other.end({ timeout: 5 });
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

  // ── #368: the insert-side check locks the message like a foreign key does ──

  /** Wait until `settled()` or the backend `pid` is blocked on a lock; true when it blocked. */
  async function blocksOnLock(pid: number, settled: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (settled()) return false;
      const [row] = await sql<{ w: string | null }[]>`SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = ${pid}`;
      if (row?.w === 'Lock') return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`backend ${pid} neither finished nor blocked within 20 s`);
  }

  it('a child inserted while its message is deleted never commits as an orphan (#368)', async () => {
    const msg = await message();
    const [{ pid }] = (await other<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`) as [{ pid: number }];
    const inserter = await sql.reserve();
    await inserter`BEGIN`;
    await inserter`INSERT INTO banter_message_reactions (message_id, user_id, emoji) VALUES (${msg}, ${USER}, 'raft')`;
    let deleted = false;
    const deleting = other`DELETE FROM banter_messages WHERE id = ${msg}`.then(() => {
      deleted = true;
    });
    // The delete waits on the inserter's FOR KEY SHARE lock instead of racing past it.
    const deleteWaited = await blocksOnLock(pid, () => deleted);
    await inserter`COMMIT`;
    inserter.release();
    await deleting;
    expect(deleteWaited).toBe(true);
    expect(await count('banter_message_reactions', 'message_id', msg)).toBe(0);
  });

  it('a child inserted while a delete of its message is in flight fails with 23503 (#368)', async () => {
    const msg = await message();
    const deleter = await other.reserve();
    await deleter`BEGIN`;
    await deleter`DELETE FROM banter_messages WHERE id = ${msg}`;
    const inserter = await sql.reserve();
    const [{ pid }] = (await inserter<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`) as [{ pid: number }];
    let settled = false;
    const inserting = inserter`INSERT INTO banter_message_reactions (message_id, user_id, emoji) VALUES (${msg}, ${USER}, 'coconut')`
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    const insertWaited = await blocksOnLock(pid, () => settled);
    await deleter`COMMIT`;
    deleter.release();
    const err = (await inserting) as { code?: string } | undefined;
    inserter.release();
    expect(insertWaited).toBe(true);
    expect(err?.code).toBe('23503');
    expect(await count('banter_message_reactions', 'message_id', msg)).toBe(0);
  });

  it('a reply under a message that does not exist fails with 23503 (#368)', async () => {
    const err = await message(randomUUID()).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23503');
  });

  // ── #370: the delete side is set-based and indexed ──

  it('cleans up after deletes with one statement-level trigger, not a per-row one (#370)', async () => {
    const rows = await sql<{ action_orientation: string }[]>`
      SELECT action_orientation FROM information_schema.triggers
      WHERE event_object_table = 'banter_messages' AND event_manipulation = 'DELETE'`;
    expect(rows.map((r) => r.action_orientation)).toEqual(['STATEMENT']);
  });

  it('every column the delete cleanup joins on leads an index (#370)', async () => {
    const leading = async (table: string, column: string) => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = ${table}::regclass AND a.attname = ${column}`;
      return row!.n;
    };
    expect(await leading('banter_message_attachments', 'message_id')).toBeGreaterThan(0);
    expect(await leading('banter_message_reactions', 'message_id')).toBeGreaterThan(0);
    expect(await leading('banter_pins', 'message_id')).toBeGreaterThan(0);
    expect(await leading('banter_bookmarks', 'message_id')).toBeGreaterThan(0);
    expect(await leading('banter_channel_memberships', 'last_read_message_id')).toBeGreaterThan(0);
    expect(await leading('banter_messages', 'thread_parent_id')).toBeGreaterThan(0);
  });

  it('a bulk delete removes the children of every deleted message (#370)', async () => {
    const tag = randomUUID();
    const ids = (
      await sql<{ id: string }[]>`
        INSERT INTO banter_messages (channel_id, author_id, content, metadata)
        SELECT ${CHANNEL}, ${USER}, 'Daily Coconut Count ' || g, jsonb_build_object('bulk', ${tag}::text)
        FROM generate_series(1, 300) g RETURNING id`
    ).map((r) => r.id);
    await sql`INSERT INTO banter_message_reactions (message_id, user_id, emoji) SELECT unnest(${ids}::uuid[]), ${USER}, 'shell'`;
    await sql`INSERT INTO banter_pins (channel_id, message_id, pinned_by) SELECT ${CHANNEL}, unnest(${ids.slice(0, 50)}::uuid[]), ${USER}`;
    await sql`INSERT INTO banter_bookmarks (user_id, message_id) SELECT ${USER}, unnest(${ids.slice(0, 50)}::uuid[])`;
    const reply = await message(ids[7]!);
    await sql`UPDATE banter_channel_memberships SET last_read_message_id = ${ids[9]!} WHERE channel_id = ${CHANNEL} AND user_id = ${USER}`;

    await sql`DELETE FROM banter_messages WHERE metadata ->> 'bulk' = ${tag}`;

    const [left] = await sql<{ r: number; p: number; b: number }[]>`
      SELECT (SELECT count(*)::int FROM banter_message_reactions WHERE message_id = ANY(${ids}::uuid[])) AS r,
             (SELECT count(*)::int FROM banter_pins WHERE message_id = ANY(${ids}::uuid[])) AS p,
             (SELECT count(*)::int FROM banter_bookmarks WHERE message_id = ANY(${ids}::uuid[])) AS b`;
    expect(left).toEqual({ r: 0, p: 0, b: 0 });
    expect(await count('banter_channel_memberships', 'last_read_message_id', ids[9]!)).toBe(0);
    const [r] = await sql<{ thread_parent_id: string | null }[]>`SELECT thread_parent_id FROM banter_messages WHERE id = ${reply}`;
    expect(r!.thread_parent_id).toBeNull();
  });

  it('deleting a channel (FK cascade to its messages) still removes the messages\' children (#370)', async () => {
    const raft = randomUUID();
    await sql`INSERT INTO banter_channels (id, org_id, name, slug, created_by) VALUES (${raft}, ${ORG}, 'raft2', ${`raft2-${raft.slice(0, 8)}`}, ${USER})`;
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO banter_messages (channel_id, author_id, content) VALUES (${raft}, ${USER}, 'SOS') RETURNING id`;
    await sql`INSERT INTO banter_message_reactions (message_id, user_id, emoji) VALUES (${m!.id}, ${USER}, 'flare')`;
    await sql`DELETE FROM banter_channels WHERE id = ${raft}`;
    expect(await count('banter_message_reactions', 'message_id', m!.id)).toBe(0);
  });

  it('Slack import abort counts the attachments and reactions it removes (#370)', async () => {
    const importId = randomUUID();
    // sql.json: this raw client would JSON-encode a JSON.stringify'd string a second time.
    const meta = (extra: Record<string, string>) => sql.json({ slack_source: { import_id: importId, ...extra } });
    const msgs: string[] = [];
    for (const ts of ['1.1', '1.2', '1.3']) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO banter_messages (channel_id, author_id, content, metadata)
        VALUES (${CHANNEL}, ${USER}, 'Castaway Rescue Request', ${meta({ ts })}::jsonb) RETURNING id`;
      msgs.push(row!.id);
    }
    for (const [i, fileId] of ['F1', 'F2'].entries()) {
      await sql`INSERT INTO banter_message_attachments (message_id, uploader_id, filename, content_type, size_bytes, storage_key, metadata)
                VALUES (${msgs[i]!}, ${USER}, 'chart.png', 'image/png', 1, ${`k/${importId}/${fileId}`}, ${meta({ slack_file_id: fileId })}::jsonb)`;
    }
    for (const [i, rid] of ['R1', 'R2', 'R3'].entries()) {
      await sql`INSERT INTO banter_message_reactions (message_id, user_id, emoji, metadata)
                VALUES (${msgs[i]!}, ${USER}, ${`e${i}`}, ${meta({ slack_reaction_id: rid })}::jsonb)`;
    }
    // A reaction someone added after the import: not the import's, but it goes with its message.
    await sql`INSERT INTO banter_message_reactions (message_id, user_id, emoji) VALUES (${msgs[0]!}, ${USER}, 'later')`;

    const db = drizzle(sql);
    const counts = await db.transaction((tx) => deleteImportedContent(tx, importId));

    expect(counts).toEqual({ messages: 3, attachments: 2, reactions: 3 });
    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM banter_message_reactions WHERE message_id = ANY(${msgs}::uuid[])`;
    expect(left!.n).toBe(0);
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
