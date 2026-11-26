/**
 * Issue #156: the attachment re-attach attack, against a real migrated database.
 *
 * Alice saw the key of a file posted in private channel #exec, then lost access to
 * #exec. She posts a message in a channel she can still post to, attaching that
 * key, hoping to download it through the channel-authorized attachment route.
 * claimAttachmentKeys must refuse that, and originalChannelForKey (the download
 * route's check) must point at #exec, never at her channel.
 *
 * Runs whenever DATABASE_URL points at a migrated database (the Test workflow's
 * Postgres service, or the compose stack); skips otherwise.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;

vi.mock('../src/env.js', () => ({ env: { DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused' } }));

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();
const MALLORY = randomUUID(); // org B
const EXEC = randomUUID(); // private channel, org A
const GENERAL = randomUUID(); // public channel, org A
const B_CHAN = randomUUID(); // org B channel

describe.skipIf(!DATABASE_URL)('banter upload grants (issue #156, real DB)', () => {
  let sql: postgres.Sql;
  let lib: typeof import('../src/lib/upload-grants.js');
  let dbMod: typeof import('../src/db/index.js');

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
    for (const [org, slug] of [
      [ORG_A, `grants-a-${ORG_A.slice(0, 8)}`],
      [ORG_B, `grants-b-${ORG_B.slice(0, 8)}`],
    ] as const) {
      await sql`INSERT INTO organizations (id, name, slug) VALUES (${org}, ${slug}, ${slug})`;
    }
    for (const [id, org, name] of [
      [ALICE, ORG_A, 'alice'],
      [BOB, ORG_A, 'bob'],
      [MALLORY, ORG_B, 'mallory'],
    ] as const) {
      await sql`INSERT INTO users (id, org_id, email, display_name) VALUES (${id}, ${org}, ${`${name}-${id.slice(0, 8)}@grants.test`}, ${name})`;
    }
    for (const [id, org, name] of [
      [EXEC, ORG_A, 'exec'],
      [GENERAL, ORG_A, 'general'],
      [B_CHAN, ORG_B, 'b-general'],
    ] as const) {
      await sql`INSERT INTO banter_channels (id, org_id, name, slug, created_by) VALUES (${id}, ${org}, ${name}, ${`${name}-${id.slice(0, 8)}`}, ${org === ORG_A ? BOB : MALLORY})`;
    }
    lib = await import('../src/lib/upload-grants.js');
    dbMod = await import('../src/db/index.js');
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM banter_upload_grants WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM banter_message_attachments WHERE uploader_id IN (${ALICE}, ${BOB}, ${MALLORY})`;
    await sql`DELETE FROM banter_messages WHERE channel_id IN (${EXEC}, ${GENERAL}, ${B_CHAN})`;
    await sql`DELETE FROM banter_channels WHERE id IN (${EXEC}, ${GENERAL}, ${B_CHAN})`;
    await sql`DELETE FROM users WHERE id IN (${ALICE}, ${BOB}, ${MALLORY})`;
    await sql`DELETE FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
    await sql.end({ timeout: 5 });
    await dbMod?.connection.end({ timeout: 5 });
  });

  /** Post a message with one attachment row the way message.routes does after a successful claim. */
  async function attach(channelId: string, authorId: string, key: string) {
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO banter_messages (channel_id, author_id, content) VALUES (${channelId}, ${authorId}, 'file') RETURNING id`;
    await sql`
      INSERT INTO banter_message_attachments (message_id, uploader_id, filename, content_type, size_bytes, storage_key)
      VALUES (${m!.id}, ${authorId}, 'f.pdf', 'application/pdf', 1, ${key})`;
  }

  it('the uploader can attach their own fresh upload once, in their org', async () => {
    const key = `banter/uploads/${randomUUID()}-minutes.pdf`;
    await lib.recordUploadGrant(key, ORG_A, BOB);

    const first = await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: BOB, channelId: EXEC });
    expect(first.ok).toBe(true);
    await attach(EXEC, BOB, key);

    // The grant is consumed: the same key cannot be claimed again for another channel.
    const again = await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: BOB, channelId: GENERAL });
    expect(again).toEqual({ ok: false, rejected: [key] });
  });

  it('refuses the re-attach attack: a key first posted in #exec cannot be attached in #general', async () => {
    const key = `banter/uploads/${randomUUID()}-board-minutes.pdf`;
    await lib.recordUploadGrant(key, ORG_A, BOB);
    expect((await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: BOB, channelId: EXEC })).ok).toBe(true);
    await attach(EXEC, BOB, key);

    // Alice (removed from #exec) tries to re-share the key in #general.
    const res = await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: ALICE, channelId: GENERAL });
    expect(res).toEqual({ ok: false, rejected: [key] });
    // And the download route's rule pins the key to #exec.
    expect(await lib.originalChannelForKey(key)).toBe(EXEC);
  });

  it('refuses a key across orgs, even with the grant still unconsumed', async () => {
    const key = `banter/uploads/${randomUUID()}-plan.pdf`;
    await lib.recordUploadGrant(key, ORG_A, BOB);
    const res = await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_B, userId: MALLORY, channelId: B_CHAN });
    expect(res).toEqual({ ok: false, rejected: [key] });
    // Bob's grant was not touched by the failed attempt.
    const left = await sql`SELECT 1 FROM banter_upload_grants WHERE storage_key = ${key}`;
    expect(left).toHaveLength(1);
  });

  it("refuses another user's unposted upload in the same org", async () => {
    const key = `banter/uploads/${randomUUID()}-draft.pdf`;
    await lib.recordUploadGrant(key, ORG_A, BOB);
    const res = await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: ALICE, channelId: GENERAL });
    expect(res.ok).toBe(false);
  });

  it('allows a legacy key (no grant) only in the channel it was originally attached in', async () => {
    const key = `banter/uploads/${randomUUID()}-legacy.png`;
    await attach(GENERAL, BOB, key); // posted before grants existed
    expect((await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: ALICE, channelId: GENERAL })).ok).toBe(true);
    expect((await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: ALICE, channelId: EXEC })).ok).toBe(false);
  });

  it('a failed claim gives back the grants it consumed for the other keys', async () => {
    const mine = `banter/uploads/${randomUUID()}-mine.pdf`;
    const stolen = `banter/uploads/${randomUUID()}-stolen.pdf`;
    await lib.recordUploadGrant(mine, ORG_A, ALICE);
    await attach(EXEC, BOB, stolen);
    const res = await lib.claimAttachmentKeys({ keys: [mine, stolen], orgId: ORG_A, userId: ALICE, channelId: GENERAL });
    expect(res).toEqual({ ok: false, rejected: [stolen] });
    expect(await sql`SELECT 1 FROM banter_upload_grants WHERE storage_key = ${mine}`).toHaveLength(1);
    // So Alice can still post her own file.
    expect((await lib.claimAttachmentKeys({ keys: [mine], orgId: ORG_A, userId: ALICE, channelId: GENERAL })).ok).toBe(true);
  });

  it('release() restores the grant when the message could not be written', async () => {
    const key = `banter/uploads/${randomUUID()}-retry.pdf`;
    await lib.recordUploadGrant(key, ORG_A, ALICE);
    const res = await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: ALICE, channelId: GENERAL });
    expect(res.ok).toBe(true);
    if (res.ok) await res.release();
    expect((await lib.claimAttachmentKeys({ keys: [key], orgId: ORG_A, userId: ALICE, channelId: GENERAL })).ok).toBe(true);
  });
});
