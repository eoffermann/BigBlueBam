// Slack import abort: delete the messages, attachments and reactions an import created (#370).
//
// Kept free of env/storage imports so the DB-backed test can call it directly
// (test/message-referential-integrity.db.test.ts).
import { sql, type SQL } from 'drizzle-orm';

/** Anything with drizzle's execute: the db or a transaction. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export interface ImportContentCounts {
  messages: number;
  attachments: number;
  reactions: number;
}

function firstCount(result: unknown): number {
  const rows = Array.isArray(result)
    ? (result as { count?: number }[])
    : ((result as { rows?: { count?: number }[] })?.rows ?? []);
  return rows[0]?.count ?? 0;
}

/**
 * Delete what import `importId` created, three set-based statements:
 *
 *  1. its attachments and 2. its reactions first, so the counts report what the import created.
 *     Deleting the messages first made the banter_messages delete trigger remove them, and the
 *     later deletes always counted 0 (#370).
 *  3. its messages. The statement-level delete trigger (0362) then removes, in one statement per
 *     table, every remaining child of those messages (reactions people added after the import,
 *     pins, bookmarks, last-read pointers, reply links).
 *
 * Each predicate repeats `metadata ? 'slack_source'` so the partial slack_source indexes from
 * 0167 apply instead of a scan of every row (and every banter_messages partition).
 */
export async function deleteImportedContent(tx: SqlExecutor, importId: string): Promise<ImportContentCounts> {
  const attachments = await tx.execute(sql`
    WITH d AS (
      DELETE FROM banter_message_attachments
      WHERE metadata ? 'slack_source'
        AND metadata #>> '{slack_source,import_id}' = ${importId}
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM d
  `);
  const reactions = await tx.execute(sql`
    WITH d AS (
      DELETE FROM banter_message_reactions
      WHERE metadata ? 'slack_source'
        AND metadata #>> '{slack_source,import_id}' = ${importId}
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM d
  `);
  const messages = await tx.execute(sql`
    WITH d AS (
      DELETE FROM banter_messages
      WHERE metadata ? 'slack_source'
        AND metadata #>> '{slack_source,import_id}' = ${importId}
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM d
  `);
  return {
    messages: firstCount(messages),
    attachments: firstCount(attachments),
    reactions: firstCount(reactions),
  };
}
