/**
 * Upload grants: who may attach a Banter upload key to a message (issue #156).
 *
 * The attachment download route authorizes on the attachment ROW (the caller must
 * be able to read the row's channel), and rows are created by whoever posts a
 * message. Before this module, a poster could attach ANY banter/uploads/ key, so a
 * key someone had seen once (before being removed from a private channel, or in
 * another org) could be re-attached in a channel they can still post to and
 * downloaded again, defeating revocation and org isolation.
 *
 * Now:
 *  - POST /v1/files/upload and /v1/files/presigned-upload record a grant (key, org,
 *    uploader) in banter_upload_grants.
 *  - Posting a message CLAIMS each key: it deletes the poster's own unexpired grant
 *    in the poster's org. A key is attachable once, by its uploader.
 *  - A key with no grant is accepted only when its ORIGINAL attachment (the oldest
 *    row for that key) is in the same channel: re-sharing within the audience that
 *    can already read it. That keeps legacy keys (uploaded before grants existed)
 *    working where they belong, and nowhere else.
 *  - The download route applies the same original-channel rule
 *    (originalChannelForKey), so a row re-attached elsewhere before this fix
 *    cannot be served either.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** How long an uploaded-but-not-yet-posted key stays attachable. */
export const UPLOAD_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  return ((result as { rows?: Row[] })?.rows ?? []) as Row[];
}

/** Record that `storageKey` was issued to `uploaderId` in `orgId`. */
export async function recordUploadGrant(storageKey: string, orgId: string, uploaderId: string): Promise<void> {
  // ISO string + explicit cast: postgres-js rejects a raw Date bound through drizzle's sql``.
  const expiresAt = new Date(Date.now() + UPLOAD_GRANT_TTL_MS).toISOString();
  await db.execute(sql`
    INSERT INTO banter_upload_grants (storage_key, org_id, uploader_id, expires_at)
    VALUES (${storageKey}, ${orgId}, ${uploaderId}, ${expiresAt}::timestamptz)
    ON CONFLICT (storage_key) DO NOTHING
  `);
  // Opportunistic cleanup of this uploader's long-expired, never-posted grants,
  // so the table stays bounded without a sweeper job.
  await db.execute(sql`
    DELETE FROM banter_upload_grants
    WHERE uploader_id = ${uploaderId} AND expires_at < now() - interval '1 day'
  `);
}

/** Anything that can run raw SQL: the pool (`db`) or a transaction handle. */
export type SqlExecutor = Pick<typeof db, 'execute'>;

/** The channel of the oldest attachment row for each key (its original posting). */
export async function originalChannels(keys: string[], executor: SqlExecutor = db): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const res = await executor.execute(sql`
    SELECT DISTINCT ON (a.storage_key) a.storage_key, m.channel_id
    FROM banter_message_attachments a
    JOIN banter_messages m ON m.id = a.message_id
    WHERE a.storage_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
    ORDER BY a.storage_key, a.created_at ASC, a.id ASC
  `);
  for (const r of rowsOf(res)) out.set(String(r.storage_key), String(r.channel_id));
  return out;
}

export async function originalChannelForKey(key: string): Promise<string | null> {
  return (await originalChannels([key])).get(key) ?? null;
}

export type ClaimResult = { ok: true } | { ok: false; rejected: string[] };

/**
 * Claim `keys` for a message `userId` is posting in `channelId` (org `orgId`).
 *
 * Issue #168: run this on the SAME transaction (`tx`) that inserts the message and
 * its attachment rows. The grant DELETE then commits only together with those
 * rows: any failure, a crash, or a dropped connection before commit rolls the
 * claim back, so there is no compensating release() to forget or lose. On a
 * rejection the caller must abort (roll back) the transaction, which restores any
 * grant this call consumed; `rejected` lists the keys the poster may not attach.
 */
export async function claimAttachmentKeys(
  params: {
    keys: string[];
    orgId: string;
    userId: string;
    channelId: string;
  },
  tx: SqlExecutor,
): Promise<ClaimResult> {
  const keys = [...new Set(params.keys)];
  if (keys.length === 0) return { ok: true };

  const claimedRes = await tx.execute(sql`
    DELETE FROM banter_upload_grants
    WHERE storage_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
      AND org_id = ${params.orgId}
      AND uploader_id = ${params.userId}
      AND expires_at > now()
    RETURNING storage_key, org_id, uploader_id, created_at, expires_at
  `);
  const claimedKeys = new Set(rowsOf(claimedRes).map((r) => String(r.storage_key)));

  const unclaimed = keys.filter((k) => !claimedKeys.has(k));
  if (unclaimed.length > 0) {
    const origins = await originalChannels(unclaimed, tx);
    const rejected = unclaimed.filter((k) => origins.get(k) !== params.channelId);
    if (rejected.length > 0) return { ok: false, rejected };
  }
  return { ok: true };
}
