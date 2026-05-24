/**
 * Slack workspace -> Banter import worker (Agent C).
 *
 * Implements the phase machine from docs/plans/slack-import-design.md §10:
 *
 *   pending -> unpacking -> mapping_users -> creating_channel_group ->
 *   importing_channels -> importing_messages -> importing_files ->
 *   importing_reactions -> importing_pins -> reconciling -> done
 *
 * Cancellation: at every batch boundary the worker re-reads
 * banter_slack_imports.status; if it's 'aborted' a SlackImportCancelledError
 * is thrown so BullMQ marks the job failed. The actual row-deletion cleanup
 * runs in the banter-api DELETE handler — we never touch other-tenant data
 * from the worker.
 *
 * Resume: between phases (and between message batches) we update
 * banter_slack_imports.{phase, progress_total, progress_done} so a
 * resurrected worker can read the row and pick up roughly where it left
 * off. The strongest invariants are the per-row idempotency keys
 * (slack_source.import_id, slack_source.ts/slack_file_id/slack_reaction_id)
 * which make replay a no-op on already-imported rows.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { sql } from 'drizzle-orm';
import StreamZip from 'node-stream-zip';
import { Client as MinioClient } from 'minio';
import crypto from 'node:crypto';
import { getDb } from '../utils/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackImportJobData {
  import_id: string;
}

export class SlackImportCancelledError extends Error {
  constructor(importId: string) {
    super(`Slack import ${importId} was aborted`);
    this.name = 'SlackImportCancelledError';
  }
}

export type SlackImportPhase =
  | 'pending'
  | 'unpacking'
  | 'mapping_users'
  | 'creating_channel_group'
  | 'importing_channels'
  | 'importing_messages'
  | 'importing_files'
  | 'importing_reactions'
  | 'importing_pins'
  | 'reconciling'
  | 'done';

type UserMappingAction = 'auto_match' | 'invite' | 'stub' | 'map' | 'skip';
type ChannelMappingAction = 'new' | 'merge' | 'skip';

interface UserMappingEntry {
  slack_user_id: string;
  action: UserMappingAction;
  target_user_id?: string | null;
  slack_email?: string | null;
  slack_display_name?: string | null;
}

interface ChannelMappingEntry {
  slack_channel_id: string;
  slack_name: string;
  slack_type?: string | null;
  action: ChannelMappingAction;
  target_name?: string | null;
  target_type?: string | null;
  target_channel_id?: string | null;
  topic?: string | null;
  purpose?: string | null;
  creator_slack_id?: string | null;
  member_slack_ids?: string[] | null;
  is_dm?: boolean | null;
  is_mpim?: boolean | null;
}

interface ProjectChoice {
  mode: 'new' | 'existing';
  project_id?: string | null;
  project_name?: string | null;
  project_key?: string | null;
}

interface ImportOptions {
  preserve_timestamps?: boolean;
  import_attachments?: boolean;
  import_reactions?: boolean;
  import_pins?: boolean;
  import_dms?: boolean;
  notify_on_completion?: boolean;
  dry_run?: boolean;
  daily_message_rate_cap?: number;
  slack_bearer_token?: string | null;
}

interface ImportMapping {
  user_mapping: UserMappingEntry[];
  channel_mapping: ChannelMappingEntry[];
  project: ProjectChoice;
  options: ImportOptions;
}

interface ImportRow {
  id: string;
  org_id: string;
  project_id: string | null;
  channel_group_id: string | null;
  initiated_by: string;
  workspace_name: string;
  source_filename: string;
  source_size_bytes: string | number;
  source_minio_key: string;
  mapping: ImportMapping;
  status: string;
  phase: string | null;
  totals_imported: Record<string, number>;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; users?: string[]; count?: number }>;
  files?: Array<{
    id: string;
    name?: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
    is_external?: boolean;
  }>;
  edited?: { user?: string; ts?: string };
}

const MIGRATION_BOT_EMAIL = 'system+slack-migration@bigbluebam.internal';
const MIGRATION_BOT_DISPLAY = 'Slack Migration';

// Built-in permission group UUIDs (mirrored from
// apps/api/src/services/role-resolver.ts::BUILTIN_GROUP_IDS, seeded by
// migration 0146). Used to insert account_group_memberships rows for
// invite/stub users without depending on @bigbluebam/api.
const BUILTIN_GROUP_IDS = {
  owner: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  guest: '55555555-5555-4555-8555-555555555555',
} as const;

// Status pub-sub channel template (see §10 of the design doc).
const STATUS_CHANNEL = (id: string) => `banter:import:status:${id}`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function processSlackImportJob(
  job: Job<SlackImportJobData>,
  logger: Logger,
  deps: SlackImportDeps = {},
): Promise<void> {
  const { import_id } = job.data;
  const log = logger.child({ jobId: job.id, import_id });

  log.info('slack-import: job picked up');
  const row = await loadImportRow(import_id);
  if (!row) {
    log.warn('slack-import: row missing — nothing to do');
    return;
  }

  // If the operator aborted before the worker grabbed the job, exit cleanly.
  if (row.status === 'aborted' || row.status === 'failed' || row.status === 'done') {
    log.info({ status: row.status }, 'slack-import: row already terminal');
    return;
  }

  await markStarted(import_id);

  const ctx: ImportContext = {
    importId: import_id,
    row,
    logger: log,
    redis: deps.redis ?? getStatusPublisher(),
    minio: deps.minio ?? getMinioClient(),
    bucket: deps.bucket ?? process.env.S3_BUCKET ?? 'bigbluebam-uploads',
    emailQueue: deps.emailQueue ?? (getEmailQueue() as unknown as EmailQueueLike),
    slackToken: row.mapping?.options?.slack_bearer_token ?? null,
    options: row.mapping?.options ?? {},
    dryRun: Boolean(row.mapping?.options?.dry_run),
    cancelChecker: deps.cancelChecker,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
  };

  try {
    // -----------------------------------------------------------------
    // Phase 1 — unpack and parse archive structure
    // -----------------------------------------------------------------
    await advancePhase(ctx, 'unpacking', 0, 1);
    const archive = await openArchive(ctx);

    try {
      // -----------------------------------------------------------------
      // Phase 2 — map users (create stubs, queue invites, build cache)
      // -----------------------------------------------------------------
      await advancePhase(ctx, 'mapping_users', 0, row.mapping.user_mapping.length);
      const userMap = await mapUsers(ctx);

      // -----------------------------------------------------------------
      // Phase 3 — create channel group (+ optional new project)
      // -----------------------------------------------------------------
      await advancePhase(ctx, 'creating_channel_group', 0, 1);
      const { channelGroupId, projectId } = await createChannelGroup(ctx);

      // -----------------------------------------------------------------
      // Phase 4 — import channels (+ memberships)
      // -----------------------------------------------------------------
      const importableChannels = row.mapping.channel_mapping.filter(
        (c) => c.action !== 'skip' && (!isDmLike(c) || ctx.options.import_dms),
      );
      await advancePhase(ctx, 'importing_channels', 0, importableChannels.length);
      const channelMap = await importChannels(
        ctx,
        importableChannels,
        userMap,
        channelGroupId,
        projectId,
      );

      // -----------------------------------------------------------------
      // Phase 5 — import messages (two-pass: parents, then replies)
      // -----------------------------------------------------------------
      const estimateTotal = await countMessages(archive, importableChannels);
      await advancePhase(ctx, 'importing_messages', 0, estimateTotal);
      const messageMap = await importMessages(
        ctx,
        archive,
        importableChannels,
        userMap,
        channelMap,
      );

      // -----------------------------------------------------------------
      // Phase 6 — import files / attachments
      // -----------------------------------------------------------------
      if (ctx.options.import_attachments !== false) {
        await advancePhase(ctx, 'importing_files', 0, messageMap.size);
        await importFiles(ctx, archive, messageMap);
      }

      // -----------------------------------------------------------------
      // Phase 7 — import reactions
      // -----------------------------------------------------------------
      if (ctx.options.import_reactions !== false) {
        await advancePhase(ctx, 'importing_reactions', 0, messageMap.size);
        await importReactions(ctx, userMap, messageMap);
      }

      // -----------------------------------------------------------------
      // Phase 8 — import pins
      // -----------------------------------------------------------------
      if (ctx.options.import_pins !== false) {
        await advancePhase(ctx, 'importing_pins', 0, importableChannels.length);
        await importPins(ctx, importableChannels, channelMap, messageMap, userMap);
      }

      // -----------------------------------------------------------------
      // Phase 9 — reconcile counters, optional notifications
      // -----------------------------------------------------------------
      await advancePhase(ctx, 'reconciling', 0, 1);
      await reconcile(ctx, channelMap, userMap);

      // -----------------------------------------------------------------
      // Phase 10 — done
      // -----------------------------------------------------------------
      await markDone(ctx);
      log.info('slack-import: completed successfully');
    } finally {
      await archive.close().catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof SlackImportCancelledError) {
      log.info('slack-import: job cancelled by operator');
      // banter-api DELETE handler owns the row cleanup; we just exit.
      throw err;
    }
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'slack-import: job failed',
    );
    await markFailed(import_id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dependency injection (for tests)
// ---------------------------------------------------------------------------

type EmailQueueLike = { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> };

export interface SlackImportDeps {
  redis?: { publish: (channel: string, payload: string) => Promise<number> | number };
  minio?: MinioClient | null;
  bucket?: string;
  emailQueue?: EmailQueueLike;
  cancelChecker?: (importId: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

interface ImportContext {
  importId: string;
  row: ImportRow;
  logger: Logger;
  redis: SlackImportDeps['redis'];
  minio: MinioClient | null;
  bucket: string;
  emailQueue: EmailQueueLike;
  slackToken: string | null;
  options: ImportOptions;
  dryRun: boolean;
  cancelChecker?: (importId: string) => Promise<boolean>;
  fetchImpl: typeof fetch;
}

// ---------------------------------------------------------------------------
// Row state helpers
// ---------------------------------------------------------------------------

async function loadImportRow(importId: string): Promise<ImportRow | null> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT id, org_id, project_id, channel_group_id, initiated_by,
           workspace_name, source_filename, source_size_bytes, source_minio_key,
           mapping, status, phase, totals_imported
    FROM banter_slack_imports
    WHERE id = ${importId}
    LIMIT 1
  `);
  const rows = normalizeRows<ImportRow>(result);
  return rows[0] ?? null;
}

async function markStarted(importId: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE banter_slack_imports
    SET status = 'running',
        started_at = COALESCE(started_at, NOW()),
        updated_at = NOW()
    WHERE id = ${importId}
      AND status NOT IN ('done', 'aborted', 'failed')
  `);
}

async function markDone(ctx: ImportContext): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE banter_slack_imports
    SET status = 'done',
        phase = 'done',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${ctx.importId}
  `);
  await publishStatus(ctx, 'done', { progress_done: 1, progress_total: 1 });
}

async function markFailed(importId: string, errorMessage: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE banter_slack_imports
    SET status = 'failed',
        error_message = ${errorMessage.slice(0, 8000)},
        updated_at = NOW()
    WHERE id = ${importId}
      AND status NOT IN ('done', 'aborted', 'failed')
  `);
}

async function advancePhase(
  ctx: ImportContext,
  phase: SlackImportPhase,
  done: number,
  total: number,
): Promise<void> {
  await checkCancellation(ctx);
  const db = getDb();
  await db.execute(sql`
    UPDATE banter_slack_imports
    SET phase = ${phase},
        progress_done = ${done},
        progress_total = ${total},
        updated_at = NOW()
    WHERE id = ${ctx.importId}
  `);
  await publishStatus(ctx, phase, { progress_done: done, progress_total: total });
}

async function updateProgress(
  ctx: ImportContext,
  phase: SlackImportPhase,
  done: number,
  total: number,
): Promise<void> {
  await checkCancellation(ctx);
  const db = getDb();
  await db.execute(sql`
    UPDATE banter_slack_imports
    SET progress_done = ${done},
        progress_total = ${total},
        updated_at = NOW()
    WHERE id = ${ctx.importId}
  `);
  await publishStatus(ctx, phase, { progress_done: done, progress_total: total });
}

async function bumpTotal(
  ctx: ImportContext,
  key: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const db = getDb();
  await db.execute(sql`
    UPDATE banter_slack_imports
    SET totals_imported = COALESCE(totals_imported, '{}'::jsonb)
                          || jsonb_build_object(${key},
                              COALESCE((totals_imported->>${key})::int, 0) + ${delta}),
        updated_at = NOW()
    WHERE id = ${ctx.importId}
  `);
}

async function publishStatus(
  ctx: ImportContext,
  phase: SlackImportPhase,
  body: Record<string, unknown>,
): Promise<void> {
  if (!ctx.redis) return;
  try {
    await ctx.redis.publish(
      STATUS_CHANNEL(ctx.importId),
      JSON.stringify({
        import_id: ctx.importId,
        phase,
        ...body,
        at: new Date().toISOString(),
      }),
    );
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'slack-import: status publish failed (continuing)',
    );
  }
}

async function checkCancellation(ctx: ImportContext): Promise<void> {
  if (ctx.cancelChecker) {
    const cancelled = await ctx.cancelChecker(ctx.importId);
    if (cancelled) throw new SlackImportCancelledError(ctx.importId);
    return;
  }
  const db = getDb();
  const result = await db.execute(sql`
    SELECT status FROM banter_slack_imports WHERE id = ${ctx.importId} LIMIT 1
  `);
  const rows = normalizeRows<{ status: string }>(result);
  if (rows[0]?.status === 'aborted') {
    throw new SlackImportCancelledError(ctx.importId);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — unpacking
// ---------------------------------------------------------------------------

interface OpenedArchive {
  zip: StreamZip.StreamZipAsync;
  entries: { [name: string]: StreamZip.ZipEntry };
  filePath: string | null;
  close: () => Promise<void>;
}

async function openArchive(ctx: ImportContext): Promise<OpenedArchive> {
  // Download the .zip from MinIO into a tmp file. Streaming directly from an
  // in-memory buffer would force the whole archive into memory, which would
  // OOM on multi-gigabyte exports. node-stream-zip needs a real file or fd.
  if (!ctx.minio) {
    throw new Error('MinIO client not configured (S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY)');
  }

  const fsPromises = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpDir = await fsPromises.mkdtemp(
    path.join(process.env.TMPDIR ?? os.tmpdir(), 'slack-import-'),
  );
  const filePath = path.join(tmpDir, 'archive.zip');

  ctx.logger.info({ filePath, key: ctx.row.source_minio_key }, 'slack-import: downloading archive');
  const stream = await ctx.minio.getObject(ctx.bucket, ctx.row.source_minio_key);
  const fs = await import('node:fs');
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    stream.pipe(out);
  });

  const zip = new StreamZip.async({ file: filePath, storeEntries: true });
  const entries = await zip.entries();

  ctx.logger.info(
    { entryCount: Object.keys(entries).length },
    'slack-import: archive opened',
  );

  return {
    zip,
    entries,
    filePath,
    async close() {
      await zip.close().catch(() => undefined);
      await import('node:fs/promises').then((m) =>
        m.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — user mapping
// ---------------------------------------------------------------------------

type UserMap = Map<string, string>; // slack_user_id -> bam_user_id

async function mapUsers(ctx: ImportContext): Promise<UserMap> {
  const map: UserMap = new Map();
  const orgId = ctx.row.org_id;
  const mapping = ctx.row.mapping.user_mapping ?? [];
  let migrationBotId: string | null = null;

  let done = 0;
  for (const entry of mapping) {
    await checkCancellation(ctx);

    switch (entry.action) {
      case 'auto_match':
      case 'map': {
        if (entry.target_user_id) {
          map.set(entry.slack_user_id, entry.target_user_id);
        }
        break;
      }

      case 'invite':
      case 'stub': {
        // Idempotent stub/invite. Re-running the import must not produce
        // duplicate users. Lookup by email when present, else by display_name
        // tag in notification_prefs.
        const existing = await findExistingStub(orgId, entry);
        let userId: string;
        if (existing) {
          userId = existing.id;
        } else {
          userId = await createStubUser(ctx, entry);
        }

        // Ensure org membership + role group (idempotent upserts).
        await ensureMembership(
          orgId,
          userId,
          ctx.row.initiated_by,
          entry.action === 'invite'
            ? BUILTIN_GROUP_IDS.member
            : BUILTIN_GROUP_IDS.viewer,
        );

        // Fire the invite email exactly once per stub by looking at
        // notification_prefs.invite_sent_at. If a re-run hits an existing
        // invited stub the email is NOT re-queued.
        if (entry.action === 'invite' && entry.slack_email) {
          await maybeSendInvite(ctx, userId, entry.slack_email);
        }

        map.set(entry.slack_user_id, userId);
        break;
      }

      case 'skip': {
        if (!migrationBotId) {
          migrationBotId = await getOrCreateMigrationBot(orgId);
        }
        map.set(entry.slack_user_id, migrationBotId);
        break;
      }
    }

    done += 1;
    if (done % 25 === 0 || done === mapping.length) {
      await updateProgress(ctx, 'mapping_users', done, mapping.length);
    }
  }

  await bumpTotal(ctx, 'users', map.size);
  ctx.logger.info({ users: map.size }, 'slack-import: user mapping built');
  return map;
}

async function findExistingStub(
  orgId: string,
  entry: UserMappingEntry,
): Promise<{ id: string } | null> {
  const db = getDb();
  const email = entry.slack_email?.toLowerCase().trim();
  if (email) {
    // users.email is globally unique, but constrain to org-membership so a
    // re-import for org A doesn't bind a stub from org B by accident.
    const result = await db.execute(sql`
      SELECT u.id FROM users u
      INNER JOIN organization_memberships om ON om.user_id = u.id
      WHERE LOWER(u.email) = ${email}
        AND om.org_id = ${orgId}
      LIMIT 1
    `);
    const rows = normalizeRows<{ id: string }>(result);
    if (rows[0]) return rows[0];
  }
  // Fallback: find a previously-created slack stub for the same slack_user_id
  // within this org.
  const result = await db.execute(sql`
    SELECT u.id FROM users u
    INNER JOIN organization_memberships om ON om.user_id = u.id
    WHERE u.notification_prefs->>'slack_user_id' = ${entry.slack_user_id}
      AND u.notification_prefs->>'slack_stub' = 'true'
      AND om.org_id = ${orgId}
    LIMIT 1
  `);
  const rows = normalizeRows<{ id: string }>(result);
  return rows[0] ?? null;
}

async function createStubUser(
  ctx: ImportContext,
  entry: UserMappingEntry,
): Promise<string> {
  const db = getDb();
  // Generate the invite token up-front so the acceptance flow has something
  // to match against. If this isn't an invite path it stays unused.
  const inviteToken = crypto.randomBytes(16).toString('hex');
  const email =
    entry.slack_email?.toLowerCase().trim() ??
    `slack+${entry.slack_user_id.toLowerCase()}@stub.bigbluebam.internal`;
  const displayName = entry.slack_display_name ?? entry.slack_user_id;
  const prefs = {
    slack_stub: true,
    slack_user_id: entry.slack_user_id,
    slack_workspace: ctx.row.workspace_name,
    imported_at: new Date().toISOString(),
    invited_at: entry.action === 'invite' ? new Date().toISOString() : null,
    invite_token: entry.action === 'invite' ? inviteToken : null,
    invite_sent: false,
  };

  const result = await db.execute(sql`
    INSERT INTO users (
      org_id, email, display_name, password_hash,
      is_active, is_superuser, kind, notification_prefs
    )
    VALUES (
      ${ctx.row.org_id}, ${email}, ${displayName}, NULL,
      false, false, 'human', ${JSON.stringify(prefs)}::jsonb
    )
    ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `);
  const rows = normalizeRows<{ id: string }>(result);
  if (!rows[0]) throw new Error(`Failed to create stub user for ${entry.slack_user_id}`);
  return rows[0].id;
}

async function ensureMembership(
  orgId: string,
  userId: string,
  invitedBy: string,
  groupId: string,
): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    INSERT INTO organization_memberships (user_id, org_id, is_default, invited_by)
    VALUES (${userId}, ${orgId}, false, ${invitedBy})
    ON CONFLICT (user_id, org_id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id, granted_by)
    VALUES (${userId}, ${groupId}, 'org', ${orgId}, ${invitedBy})
    ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE
      SET group_id = EXCLUDED.group_id,
          granted_at = NOW(),
          detached_at = NULL,
          detached_by = NULL
  `);
}

async function maybeSendInvite(
  ctx: ImportContext,
  userId: string,
  email: string,
): Promise<void> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT notification_prefs FROM users WHERE id = ${userId} LIMIT 1
  `);
  const rows = normalizeRows<{ notification_prefs: Record<string, unknown> | null }>(result);
  const prefs = rows[0]?.notification_prefs ?? {};
  if (prefs.invite_sent === true) return; // already queued in an earlier run

  const inviteToken = (prefs.invite_token as string) ?? crypto.randomBytes(16).toString('hex');
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost';
  const acceptUrl = `${frontendUrl.replace(/\/$/, '')}/b3/accept-invite?token=${inviteToken}`;

  try {
    await ctx.emailQueue.add(
      'slack-import-invite',
      {
        to: email,
        subject: `You've been invited to ${ctx.row.workspace_name} on BigBlueBam`,
        html: renderInviteHtml(ctx.row.workspace_name, acceptUrl),
        text: renderInviteText(ctx.row.workspace_name, acceptUrl),
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      'slack-import: failed to enqueue invite email (continuing)',
    );
  }

  await db.execute(sql`
    UPDATE users
    SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb)
                              || jsonb_build_object(
                                  'invite_sent', true,
                                  'invite_token', ${inviteToken},
                                  'invited_at', ${new Date().toISOString()}
                                )
    WHERE id = ${userId}
  `);
}

function renderInviteHtml(workspaceName: string, acceptUrl: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;">
<h2>You've been invited to ${escapeHtml(workspaceName)}</h2>
<p>Your message history from Slack has been imported to BigBlueBam.
Click below to claim your account and pick up where you left off.</p>
<p><a href="${escapeHtml(acceptUrl)}"
  style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">
  Accept invitation</a></p>
<p>Or paste this link:<br/><code>${escapeHtml(acceptUrl)}</code></p>
</body></html>`;
}

function renderInviteText(workspaceName: string, acceptUrl: string): string {
  return `You've been invited to ${workspaceName} on BigBlueBam.
Your Slack message history has already been imported.

Accept: ${acceptUrl}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function getOrCreateMigrationBot(orgId: string): Promise<string> {
  const db = getDb();
  // The migration bot is a single platform-level user per org for now; we
  // key it by email so a re-import (and the next-import) reuse the same id.
  const email = `${MIGRATION_BOT_EMAIL}`;
  const found = await db.execute(sql`
    SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1
  `);
  const foundRows = normalizeRows<{ id: string }>(found);
  if (foundRows[0]) return foundRows[0].id;

  const created = await db.execute(sql`
    INSERT INTO users (org_id, email, display_name, password_hash,
                       is_active, is_superuser, kind, notification_prefs)
    VALUES (${orgId}, ${email}, ${MIGRATION_BOT_DISPLAY}, NULL,
            false, false, 'service',
            '{"slack_migration_bot": true}'::jsonb)
    ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `);
  const rows = normalizeRows<{ id: string }>(created);
  if (!rows[0]) throw new Error('Failed to create Slack migration bot user');
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Phase 3 — channel group
// ---------------------------------------------------------------------------

async function createChannelGroup(
  ctx: ImportContext,
): Promise<{ channelGroupId: string; projectId: string | null }> {
  const db = getDb();
  const project = ctx.row.mapping.project ?? { mode: 'existing', project_id: null };
  let projectId: string | null = project.project_id ?? ctx.row.project_id ?? null;

  if (project.mode === 'new' && project.project_name && !projectId) {
    // Create a fresh project. The minimum NOT NULLs on projects are
    // (org_id, name, key, owner_id) per apps/api/src/db/schema/projects.ts.
    const key =
      project.project_key?.toUpperCase().slice(0, 10) ??
      slugify(project.project_name).toUpperCase().slice(0, 10) ??
      'SLACK';
    const result = await db.execute(sql`
      INSERT INTO projects (org_id, name, key, owner_id)
      VALUES (${ctx.row.org_id}, ${project.project_name}, ${key}, ${ctx.row.initiated_by})
      ON CONFLICT (org_id, key) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `);
    const rows = normalizeRows<{ id: string }>(result);
    projectId = rows[0]?.id ?? null;
  }

  // If we already created the group in a prior run (resume), reuse it.
  if (ctx.row.channel_group_id) {
    return { channelGroupId: ctx.row.channel_group_id, projectId };
  }

  const groupName = `Slack: ${ctx.row.workspace_name} (${new Date().toISOString().slice(0, 10)})`;
  const result = await db.execute(sql`
    INSERT INTO banter_channel_groups (org_id, name, project_id, position)
    VALUES (
      ${ctx.row.org_id},
      ${groupName},
      ${projectId},
      COALESCE((SELECT MAX(position) FROM banter_channel_groups WHERE org_id = ${ctx.row.org_id}), 0) + 1
    )
    RETURNING id
  `);
  const rows = normalizeRows<{ id: string }>(result);
  const channelGroupId = rows[0]!.id;
  await db.execute(sql`
    UPDATE banter_slack_imports
    SET channel_group_id = ${channelGroupId},
        project_id = ${projectId},
        updated_at = NOW()
    WHERE id = ${ctx.importId}
  `);
  // Keep ctx.row in sync for downstream phases.
  ctx.row.channel_group_id = channelGroupId;
  ctx.row.project_id = projectId;
  return { channelGroupId, projectId };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isDmLike(c: ChannelMappingEntry): boolean {
  return Boolean(c.is_dm || c.is_mpim || c.slack_type === 'dm' || c.slack_type === 'mpim');
}

// ---------------------------------------------------------------------------
// Phase 4 — channels
// ---------------------------------------------------------------------------

type ChannelMap = Map<string, string>; // slack_channel_id -> bam_channel_id

async function importChannels(
  ctx: ImportContext,
  channels: ChannelMappingEntry[],
  userMap: UserMap,
  channelGroupId: string,
  projectId: string | null,
): Promise<ChannelMap> {
  const db = getDb();
  const map: ChannelMap = new Map();
  let done = 0;

  for (const c of channels) {
    await checkCancellation(ctx);
    let bamChannelId: string | null = null;

    if (c.action === 'merge' && c.target_channel_id) {
      bamChannelId = c.target_channel_id;
    } else if (c.action === 'new') {
      const baseName = c.target_name ?? c.slack_name;
      const slug = slugify(baseName);
      const channelType = mapChannelType(c);
      const createdBy = userMap.get(c.creator_slack_id ?? '') ?? ctx.row.initiated_by;

      // Slug uniqueness is per-org. On conflict we suffix with a short hash.
      const candidateSlugs = [slug, `${slug}-import`, `${slug}-${ctx.importId.slice(0, 6)}`];
      for (const candidate of candidateSlugs) {
        const result = await db.execute(sql`
          INSERT INTO banter_channels (
            org_id, name, slug, type, topic, description,
            channel_group_id, project_id, created_by
          )
          VALUES (
            ${ctx.row.org_id}, ${baseName}, ${candidate}, ${channelType},
            ${c.topic ?? null}, ${c.purpose ?? null},
            ${channelGroupId}, ${projectId}, ${createdBy}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `);
        const rows = normalizeRows<{ id: string }>(result);
        if (rows[0]) {
          bamChannelId = rows[0].id;
          break;
        }
      }

      // If every candidate slug collided, attempt a lookup by (org, slug)
      // for the first candidate — that lets a resumed run reuse the row.
      if (!bamChannelId) {
        const lookup = await db.execute(sql`
          SELECT id FROM banter_channels
          WHERE org_id = ${ctx.row.org_id}
            AND name = ${baseName}
            AND channel_group_id = ${channelGroupId}
          ORDER BY created_at DESC
          LIMIT 1
        `);
        const rows = normalizeRows<{ id: string }>(lookup);
        bamChannelId = rows[0]?.id ?? null;
      }
    }

    if (!bamChannelId) {
      ctx.logger.warn(
        { slack_channel_id: c.slack_channel_id, action: c.action },
        'slack-import: channel resolved to no bam channel id (skipping)',
      );
      continue;
    }

    // Memberships — every mapped Slack user that was a channel member.
    const memberSlackIds = c.member_slack_ids ?? [];
    for (const slackId of memberSlackIds) {
      const bamUserId = userMap.get(slackId);
      if (!bamUserId) continue;
      await db.execute(sql`
        INSERT INTO banter_channel_memberships (channel_id, user_id, role)
        VALUES (${bamChannelId}, ${bamUserId}, 'member')
        ON CONFLICT (channel_id, user_id) DO NOTHING
      `);
    }

    map.set(c.slack_channel_id, bamChannelId);
    done += 1;
    await updateProgress(ctx, 'importing_channels', done, channels.length);
  }

  await bumpTotal(ctx, 'channels', map.size);
  return map;
}

function mapChannelType(c: ChannelMappingEntry): string {
  if (c.target_type) return c.target_type;
  if (c.is_dm || c.slack_type === 'dm') return 'dm';
  if (c.is_mpim || c.slack_type === 'mpim') return 'group_dm';
  if (c.slack_type === 'private_channel' || c.slack_type === 'group') return 'private';
  return 'public';
}

// ---------------------------------------------------------------------------
// Phase 5 — messages (two-pass for thread reconciliation)
// ---------------------------------------------------------------------------

interface MessageRecord {
  bamId: string;
  channelId: string;
  files?: SlackMessage['files'];
  reactions?: SlackMessage['reactions'];
}

type MessageMap = Map<string, MessageRecord>; // slack_ts -> record

async function countMessages(
  archive: OpenedArchive,
  channels: ChannelMappingEntry[],
): Promise<number> {
  let total = 0;
  for (const c of channels) {
    for (const entry of channelDayFiles(archive, c.slack_name)) {
      try {
        const text = (await archive.zip.entryData(entry)).toString('utf8');
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) total += arr.length;
      } catch {
        // Counting is best-effort.
      }
    }
  }
  return total;
}

function* channelDayFiles(
  archive: OpenedArchive,
  channelName: string,
): Generator<StreamZip.ZipEntry> {
  const prefix = `${channelName}/`;
  for (const name of Object.keys(archive.entries)) {
    const entry = archive.entries[name]!;
    if (entry.isDirectory) continue;
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith('.json')) continue;
    yield entry;
  }
}

async function importMessages(
  ctx: ImportContext,
  archive: OpenedArchive,
  channels: ChannelMappingEntry[],
  userMap: UserMap,
  channelMap: ChannelMap,
): Promise<MessageMap> {
  const db = getDb();
  const messageMap: MessageMap = new Map();
  let done = 0;
  let total = 0;
  for (const c of channels) total += await countChannelMessages(archive, c);

  const rateCap = ctx.options.daily_message_rate_cap ?? 5000;
  const batchSize = 500;
  let imported = 0;
  const startedAt = Date.now();

  // PASS 1: parents (and non-thread messages) in chronological order.
  // PASS 2: replies, looking up their parent's new id via messageMap or DB.
  for (let pass = 1; pass <= 2; pass++) {
    for (const c of channels) {
      const bamChannelId = channelMap.get(c.slack_channel_id);
      if (!bamChannelId) continue;
      const dayFiles = Array.from(channelDayFiles(archive, c.slack_name)).sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      for (const entry of dayFiles) {
        await checkCancellation(ctx);
        const text = (await archive.zip.entryData(entry)).toString('utf8');
        let messages: SlackMessage[] = [];
        try {
          messages = JSON.parse(text) as SlackMessage[];
        } catch {
          ctx.logger.warn({ name: entry.name }, 'slack-import: failed to parse day file');
          continue;
        }
        if (!Array.isArray(messages)) continue;

        const filtered = messages.filter((m) => {
          const isReply = m.thread_ts && m.thread_ts !== m.ts;
          return pass === 1 ? !isReply : isReply;
        });

        for (let i = 0; i < filtered.length; i += batchSize) {
          const slice = filtered.slice(i, i + batchSize);

          // Rate cap: only throttle once we have already pushed
          // `daily_message_rate_cap` messages in this run. Below the cap
          // we run at full speed; above it we sleep just enough to spread
          // the remainder across the rest of the daily window. This keeps
          // small fixture imports fast and only kicks in for genuinely
          // huge workspaces.
          if (rateCap > 0 && imported >= rateCap) {
            const elapsedMs = Date.now() - startedAt;
            const dayMs = 24 * 60 * 60 * 1000;
            if (elapsedMs < dayMs) {
              const sleepMs = Math.min(60_000, (dayMs - elapsedMs) / Math.max(1, rateCap));
              if (sleepMs > 0) await sleep(sleepMs);
            }
          }

          for (const m of slice) {
            if (!m.ts) continue;
            // Idempotency: skip if an in-memory record exists OR if a row
            // with the same (import_id, ts) already exists in the DB.
            if (messageMap.has(m.ts)) continue;
            const dbHit = await lookupExistingMessage(ctx.importId, m.ts);
            if (dbHit) {
              messageMap.set(m.ts, { bamId: dbHit, channelId: bamChannelId });
              continue;
            }

            const authorId =
              (m.user && userMap.get(m.user)) ?? (await ensureBotAuthor(ctx, m));
            if (!authorId) continue;

            let parentBamId: string | null = null;
            if (pass === 2 && m.thread_ts && m.thread_ts !== m.ts) {
              parentBamId =
                messageMap.get(m.thread_ts)?.bamId ??
                (await lookupExistingMessage(ctx.importId, m.thread_ts));
              if (!parentBamId) {
                // Parent missing — drop the reply rather than orphan it.
                ctx.logger.warn(
                  { reply_ts: m.ts, parent_ts: m.thread_ts },
                  'slack-import: reply parent missing (skipping)',
                );
                continue;
              }
            }

            const content = sanitizeBody(m.text ?? '');
            const createdAt = ctx.options.preserve_timestamps === false
              ? new Date().toISOString()
              : slackTsToIso(m.ts);
            const slackMeta = {
              slack_source: {
                import_id: ctx.importId,
                workspace: ctx.row.workspace_name,
                channel: c.slack_name,
                ts: m.ts,
                ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
                ...(m.user && !userMap.has(m.user)
                  ? { original_author_name: m.user }
                  : {}),
              },
            };

            const inserted = await db.execute(sql`
              INSERT INTO banter_messages (
                channel_id, author_id, thread_parent_id,
                content, content_plain, content_format,
                created_at, metadata
              )
              VALUES (
                ${bamChannelId}, ${authorId}, ${parentBamId},
                ${content}, ${stripHtml(content)}, 'plain',
                ${createdAt}, ${JSON.stringify(slackMeta)}::jsonb
              )
              RETURNING id
            `);
            const rows = normalizeRows<{ id: string }>(inserted);
            const bamId = rows[0]?.id;
            if (bamId) {
              messageMap.set(m.ts, {
                bamId,
                channelId: bamChannelId,
                files: m.files,
                reactions: m.reactions,
              });
              imported += 1;
              done += 1;
            }
          }

          if (done % 100 === 0 || done === total) {
            await updateProgress(ctx, 'importing_messages', done, Math.max(total, done));
          }
        }
      }
    }
  }

  await bumpTotal(ctx, 'messages', imported);
  ctx.logger.info({ imported }, 'slack-import: messages imported');
  return messageMap;
}

async function countChannelMessages(
  archive: OpenedArchive,
  c: ChannelMappingEntry,
): Promise<number> {
  let total = 0;
  for (const entry of channelDayFiles(archive, c.slack_name)) {
    try {
      const data = (await archive.zip.entryData(entry)).toString('utf8');
      const arr = JSON.parse(data);
      if (Array.isArray(arr)) total += arr.length;
    } catch {
      /* ignore */
    }
  }
  return total;
}

async function lookupExistingMessage(
  importId: string,
  ts: string,
): Promise<string | null> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT id FROM banter_messages
    WHERE metadata->'slack_source'->>'import_id' = ${importId}
      AND metadata->'slack_source'->>'ts' = ${ts}
    LIMIT 1
  `);
  const rows = normalizeRows<{ id: string }>(result);
  return rows[0]?.id ?? null;
}

async function ensureBotAuthor(
  ctx: ImportContext,
  m: SlackMessage,
): Promise<string | null> {
  // Messages with no `user` (e.g. bot posts) get the migration bot as author.
  if (m.user) return null; // handled by userMap, but undefined here means unmapped
  return getOrCreateMigrationBot(ctx.row.org_id);
}

function slackTsToIso(ts: string): string {
  const secs = Number(ts.split('.')[0]);
  if (!Number.isFinite(secs)) return new Date().toISOString();
  return new Date(secs * 1000).toISOString();
}

function sanitizeBody(text: string): string {
  return text.slice(0, 100_000);
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Phase 6 — files / attachments
// ---------------------------------------------------------------------------

async function importFiles(
  ctx: ImportContext,
  archive: OpenedArchive,
  messageMap: MessageMap,
): Promise<void> {
  const db = getDb();
  let done = 0;
  let attachmentsImported = 0;

  for (const [, record] of messageMap) {
    await checkCancellation(ctx);
    if (!record.files || record.files.length === 0) {
      done += 1;
      continue;
    }

    for (const file of record.files) {
      // Idempotency lookup via unique partial index (metadata.slack_source.import_id + slack_file_id).
      const lookup = await db.execute(sql`
        SELECT id FROM banter_message_attachments
        WHERE metadata->'slack_source'->>'import_id' = ${ctx.importId}
          AND metadata->'slack_source'->>'slack_file_id' = ${file.id}
        LIMIT 1
      `);
      if (normalizeRows<{ id: string }>(lookup).length > 0) continue;

      const filename = file.name ?? file.title ?? 'unnamed';
      const mime = file.mimetype ?? 'application/octet-stream';
      const size = typeof file.size === 'number' ? file.size : 0;

      // Look for a local file inside the archive at the conventional
      // "files/<id>/<filename>" or "<channel>/files/<id>/<filename>" path.
      const localKey = findLocalFileEntry(archive, file.id);
      const slackMeta = {
        slack_source: {
          import_id: ctx.importId,
          slack_file_id: file.id,
        },
      };

      let storageKey: string | null = null;
      let isStub = true;
      let originalUrl = file.url_private_download ?? file.url_private ?? null;

      if (localKey) {
        const buffer = await archive.zip.entryData(localKey);
        storageKey = `attachments/${ctx.row.org_id}/slack-imports/${ctx.importId}/${file.id}`;
        if (ctx.minio) {
          await ctx.minio.putObject(ctx.bucket, storageKey, buffer, buffer.length, {
            'Content-Type': mime,
          });
          isStub = false;
        }
      } else if (originalUrl && ctx.slackToken) {
        try {
          const buf = await downloadSlackUrl(ctx, originalUrl);
          if (buf) {
            storageKey = `attachments/${ctx.row.org_id}/slack-imports/${ctx.importId}/${file.id}`;
            if (ctx.minio) {
              await ctx.minio.putObject(
                ctx.bucket,
                storageKey,
                buf,
                buf.length,
                { 'Content-Type': mime },
              );
              isStub = false;
            }
          }
        } catch (err) {
          ctx.logger.warn(
            { err: err instanceof Error ? err.message : String(err), fileId: file.id },
            'slack-import: file download failed (stubbing)',
          );
        }
      }

      await db.execute(sql`
        INSERT INTO banter_message_attachments (
          message_id, uploader_id, filename, content_type, size_bytes,
          storage_key, is_stub, original_url, metadata
        )
        VALUES (
          ${record.bamId},
          ${ctx.row.initiated_by},
          ${filename},
          ${mime},
          ${size},
          ${storageKey ?? `stub:${file.id}`},
          ${isStub},
          ${originalUrl},
          ${JSON.stringify(slackMeta)}::jsonb
        )
        ON CONFLICT DO NOTHING
      `);
      attachmentsImported += 1;
    }

    done += 1;
    if (done % 50 === 0 || done === messageMap.size) {
      await updateProgress(ctx, 'importing_files', done, messageMap.size);
    }
  }

  await bumpTotal(ctx, 'files', attachmentsImported);
}

function findLocalFileEntry(
  archive: OpenedArchive,
  fileId: string,
): StreamZip.ZipEntry | null {
  // Slack corporate exports stash files under various paths; just look for
  // the file id as a path segment.
  for (const name of Object.keys(archive.entries)) {
    const entry = archive.entries[name]!;
    if (entry.isDirectory) continue;
    if (!name.includes(`/${fileId}/`) && !name.endsWith(`/${fileId}`)) continue;
    return entry;
  }
  return null;
}

async function downloadSlackUrl(
  ctx: ImportContext,
  url: string,
): Promise<Buffer | null> {
  if (!ctx.slackToken) return null;
  const resp = await ctx.fetchImpl(url, {
    headers: { Authorization: `Bearer ${ctx.slackToken}` },
  });
  if (!resp.ok) return null;
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

// ---------------------------------------------------------------------------
// Phase 7 — reactions
// ---------------------------------------------------------------------------

async function importReactions(
  ctx: ImportContext,
  userMap: UserMap,
  messageMap: MessageMap,
): Promise<void> {
  const db = getDb();
  let done = 0;
  let imported = 0;

  for (const [ts, record] of messageMap) {
    await checkCancellation(ctx);
    if (!record.reactions || record.reactions.length === 0) {
      done += 1;
      continue;
    }

    const counts: Record<string, number> = {};
    for (const r of record.reactions) {
      const emoji = `:${r.name}:`;
      const users = r.users ?? [];
      let added = 0;
      for (const slackUserId of users) {
        const bamUserId = userMap.get(slackUserId);
        if (!bamUserId) continue;
        const reactionKey = `${ts}:${r.name}:${slackUserId}`;
        const slackMeta = {
          slack_source: {
            import_id: ctx.importId,
            slack_reaction_id: reactionKey,
          },
        };
        await db.execute(sql`
          INSERT INTO banter_message_reactions (message_id, user_id, emoji, metadata)
          VALUES (${record.bamId}, ${bamUserId}, ${emoji}, ${JSON.stringify(slackMeta)}::jsonb)
          ON CONFLICT (message_id, user_id, emoji) DO NOTHING
        `);
        added += 1;
        imported += 1;
      }
      if (added > 0) counts[emoji] = (counts[emoji] ?? 0) + added;
    }

    if (Object.keys(counts).length > 0) {
      await db.execute(sql`
        UPDATE banter_messages
        SET reaction_counts = ${JSON.stringify(counts)}::jsonb
        WHERE id = ${record.bamId}
      `);
    }

    done += 1;
    if (done % 50 === 0 || done === messageMap.size) {
      await updateProgress(ctx, 'importing_reactions', done, messageMap.size);
    }
  }

  await bumpTotal(ctx, 'reactions', imported);
}

// ---------------------------------------------------------------------------
// Phase 8 — pins
// ---------------------------------------------------------------------------

async function importPins(
  ctx: ImportContext,
  channels: ChannelMappingEntry[],
  channelMap: ChannelMap,
  messageMap: MessageMap,
  userMap: UserMap,
): Promise<void> {
  const db = getDb();
  let pinned = 0;
  // Pins live on the channel metadata in channels.json (parsed by the upload
  // preview into mapping.channel_mapping); the per-channel mapping rows may
  // carry an optional `pins[]` of ts strings. If absent, this phase is a
  // no-op.
  let done = 0;
  for (const c of channels) {
    await checkCancellation(ctx);
    const bamChannelId = channelMap.get(c.slack_channel_id);
    if (!bamChannelId) {
      done += 1;
      continue;
    }
    const pins = ((c as unknown as { pins?: Array<string | { id?: string; ts?: string; user?: string }> }).pins) ?? [];
    for (const p of pins) {
      const ts = typeof p === 'string' ? p : p.ts ?? p.id;
      if (!ts) continue;
      const record = messageMap.get(ts);
      if (!record) continue;
      const pinnedBy =
        (typeof p !== 'string' && p.user && userMap.get(p.user)) ?? ctx.row.initiated_by;
      await db.execute(sql`
        INSERT INTO banter_pins (channel_id, message_id, pinned_by)
        VALUES (${bamChannelId}, ${record.bamId}, ${pinnedBy})
        ON CONFLICT (channel_id, message_id) DO NOTHING
      `);
      pinned += 1;
    }
    done += 1;
    await updateProgress(ctx, 'importing_pins', done, channels.length);
  }
  await bumpTotal(ctx, 'pins', pinned);
}

// ---------------------------------------------------------------------------
// Phase 9 — reconcile counters + notifications
// ---------------------------------------------------------------------------

async function reconcile(
  ctx: ImportContext,
  channelMap: ChannelMap,
  userMap: UserMap,
): Promise<void> {
  const db = getDb();
  for (const bamChannelId of channelMap.values()) {
    await db.execute(sql`
      UPDATE banter_channels c
      SET
        last_message_at = sub.last_at,
        last_message_preview = sub.preview,
        message_count = sub.cnt,
        member_count = (SELECT COUNT(*) FROM banter_channel_memberships WHERE channel_id = c.id)
      FROM (
        SELECT channel_id,
               MAX(created_at) AS last_at,
               LEFT(MAX(content_plain), 200) AS preview,
               COUNT(*) AS cnt
        FROM banter_messages
        WHERE channel_id = ${bamChannelId}
        GROUP BY channel_id
      ) sub
      WHERE c.id = ${bamChannelId}
    `);

    // Bump reply_count for thread parents based on actual rows.
    await db.execute(sql`
      UPDATE banter_messages parent
      SET reply_count = sub.cnt,
          last_reply_at = sub.last_at
      FROM (
        SELECT thread_parent_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
        FROM banter_messages
        WHERE channel_id = ${bamChannelId}
          AND thread_parent_id IS NOT NULL
        GROUP BY thread_parent_id
      ) sub
      WHERE parent.id = sub.thread_parent_id
    `);
  }

  if (ctx.options.notify_on_completion) {
    for (const bamUserId of userMap.values()) {
      try {
        await db.execute(sql`
          INSERT INTO notifications (user_id, type, title, body)
          VALUES (${bamUserId}, 'slack_import_complete',
                  ${`Slack import complete: ${ctx.row.workspace_name}`},
                  ${`${channelMap.size} channels imported into your organization.`})
        `);
      } catch (err) {
        ctx.logger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'slack-import: notification insert failed (continuing)',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared singletons (lazy)
// ---------------------------------------------------------------------------

let cachedRedis: IORedis | null = null;
function getStatusPublisher(): { publish: (channel: string, payload: string) => Promise<number> } {
  if (!cachedRedis) {
    cachedRedis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
  }
  return {
    publish: (channel: string, payload: string) => cachedRedis!.publish(channel, payload),
  };
}

let cachedEmailQueue: Queue | null = null;
function getEmailQueue(): Queue {
  if (!cachedEmailQueue) {
    const conn = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    cachedEmailQueue = new Queue('email', { connection: conn });
  }
  return cachedEmailQueue;
}

let cachedMinio: MinioClient | null = null;
function getMinioClient(): MinioClient | null {
  if (cachedMinio) return cachedMinio;
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  if (!endpoint || !accessKey || !secretKey) return null;
  try {
    const url = new URL(endpoint);
    cachedMinio = new MinioClient({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      useSSL: url.protocol === 'https:',
      accessKey,
      secretKey,
    });
    return cachedMinio;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Drizzle row normalization (postgres-js returns array-like; some adapters
// return { rows }).
// ---------------------------------------------------------------------------
function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const r = (result as { rows?: unknown[] }).rows;
    return (r ?? []) as T[];
  }
  return [];
}
