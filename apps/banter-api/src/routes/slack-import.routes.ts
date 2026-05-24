// Slack workspace import — admin endpoints for the Bam settings wizard.
//
// Six endpoints under /v1/admin/import/slack/, each gated by
// fastify.requireCan('banter.admin_import.*'). The data lives in this
// satellite (per docs/plans/slack-import-design.md §13 #4); the Bam
// frontend reaches us through the nginx /banter/api/ proxy.
//
// Flow:
//   POST   /v1/admin/import/slack/upload      multipart .zip → MinIO, fast-scan preview
//   GET    /v1/admin/import/slack/:id/preview return full users/channels for the wizard
//   POST   /v1/admin/import/slack/:id/start   persist mapping, enqueue worker job
//   GET    /v1/admin/import/slack/:id/status  poll the durable row
//   GET    /v1/admin/import/slack/            list recent imports for this org
//   DELETE /v1/admin/import/slack/:id         abort + cleanup
//
// See the design doc for the full UX flow (§1), schema (§4), idempotency
// rules (§7), and worker phases (§10).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { banterSlackImports } from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { logAudit } from '../services/audit.js';
import { env } from '../env.js';
import {
  buildPreview,
  downloadToTempfile,
  enqueueSlackImport,
  loadImportRow,
  publishAbortSignal,
  slackImportObjectKey,
  stashUpload,
  validateMapping,
  type MappingPayload,
  type SlackPreview,
} from '../services/slack-import.service.js';

// ── Schemas ────────────────────────────────────────────────────────

const userMappingEntrySchema = z.object({
  slack_user_id: z.string().min(1),
  action: z.enum(['auto_match', 'send_invite', 'stub', 'map_existing', 'skip']),
  target_user_id: z.string().uuid().nullable().optional(),
  // When action='send_invite', operator can defer the email send (UI checkbox).
  // Defaulting true means "fire the invite email immediately on import start";
  // false creates the stub + queues the invite_token but skips the email.
  send_email: z.boolean().optional(),
});

const channelMappingEntrySchema = z.object({
  slack_channel_id: z.string().min(1),
  action: z.enum(['import_new', 'merge_existing', 'skip']),
  target_channel_id: z.string().uuid().nullable().optional(),
  target_name: z.string().min(1).max(80).nullable().optional(),
});

const projectSelectionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('create_new'),
    name: z.string().min(1).max(255),
    key: z.string().min(1).max(50),
  }),
  z.object({
    mode: z.literal('use_existing'),
    project_id: z.string().uuid(),
  }),
]);

const optionsSchema = z.object({
  preserve_timestamps: z.boolean().default(true),
  import_attachments: z.boolean().default(true),
  import_reactions: z.boolean().default(true),
  import_pins: z.boolean().default(true),
  import_dms: z.boolean().default(false),
  notify_on_completion: z.boolean().default(false),
  dry_run: z.boolean().default(false),
  daily_message_rate_cap: z.number().int().positive().max(1_000_000).default(5000),
  slack_bearer_token: z.string().nullable().optional(),
});

const startBodySchema = z.object({
  project: projectSelectionSchema,
  users: z.array(userMappingEntrySchema).default([]),
  channels: z.array(channelMappingEntrySchema).default([]),
  options: optionsSchema.default({} as never),
});

const deleteQuerySchema = z.object({
  cleanup_stubs: z.preprocess((v) => {
    if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
    return Boolean(v);
  }, z.boolean()).default(false),
});

// ── Helpers ────────────────────────────────────────────────────────

function publicRowShape(row: Awaited<ReturnType<typeof loadImportRow>>) {
  if (!row) return null;
  // Mapping is omitted from poll responses (potentially many KB); the wizard
  // already has it, the worker reads it directly from the DB.
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    channel_group_id: row.channel_group_id,
    initiated_by: row.initiated_by,
    workspace_name: row.workspace_name,
    workspace_url: row.workspace_url,
    source_filename: row.source_filename,
    source_size_bytes: row.source_size_bytes,
    status: row.status,
    phase: row.phase,
    progress_total: row.progress_total,
    progress_done: row.progress_done,
    totals_imported: row.totals_imported,
    totals_skipped: row.totals_skipped,
    error_message: row.error_message,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Routes ─────────────────────────────────────────────────────────

export default async function slackImportRoutes(fastify: FastifyInstance) {
  // Multipart plugin — scoped to this register call so it doesn't conflict
  // with the file.routes.ts registration (Fastify allows duplicate registers
  // because both routes live in their own encapsulation contexts).
  await fastify.register(multipart, {
    limits: {
      fileSize: env.BANTER_SLACK_IMPORT_MAX_BYTES,
      files: 1,
    },
  });

  // POST /v1/admin/import/slack/upload — multipart upload
  fastify.post(
    '/v1/admin/import/slack/upload',
    {
      preHandler: [requireAuth, fastify.requireCan('banter.admin_import.create')],
    },
    async (request, reply) => {
      const user = request.user!;

      let file: Awaited<ReturnType<typeof request.file>>;
      try {
        file = await request.file();
      } catch (err) {
        // @fastify/multipart throws FST_ERR_REQ_FILE_TOO_LARGE when exceeded
        const message = err instanceof Error ? err.message : 'multipart parse failed';
        if (/too large/i.test(message)) {
          return reply.status(413).send({
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `Upload exceeds the configured limit (${env.BANTER_SLACK_IMPORT_MAX_BYTES} bytes)`,
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message,
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!file) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'No file provided',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Buffer the upload. Slack workspace exports can be up to ~5 GB;
      // streaming directly to MinIO would be preferable for memory but
      // we still need a copy for the preview unzip, and a temp file is
      // cleaner than a passthrough. For very large workspaces ops should
      // raise BANTER_SLACK_IMPORT_MAX_BYTES and ensure adequate node
      // memory (worker reads via stream-zip; this preview path does not).
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'failed to buffer upload';
        if (/file size limit|reached/i.test(message)) {
          return reply.status(413).send({
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `Upload exceeds the configured limit (${env.BANTER_SLACK_IMPORT_MAX_BYTES} bytes)`,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }

      if (buffer.length > env.BANTER_SLACK_IMPORT_MAX_BYTES) {
        return reply.status(413).send({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Upload exceeds the configured limit (${env.BANTER_SLACK_IMPORT_MAX_BYTES} bytes)`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const importId = randomUUID();
      const key = slackImportObjectKey(user.org_id, importId);

      try {
        await stashUpload(key, buffer, buffer.length, file.mimetype ?? 'application/zip');
      } catch (err) {
        request.log.error({ err, key }, 'slack-import: failed to stash upload');
        return reply.status(502).send({
          error: {
            code: 'STORAGE_ERROR',
            message: 'Failed to stash upload to object storage',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Fast-scan: write the buffer to a tempfile and read channels/users/etc.
      const tmpPath = `${process.env.TMPDIR ?? '/tmp'}/bbb-slack-import-${importId}.zip`;
      const { writeFile, rm } = await import('node:fs/promises');
      await writeFile(tmpPath, buffer);
      let preview: SlackPreview;
      try {
        preview = await buildPreview(tmpPath);
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => {});
        request.log.warn({ err }, 'slack-import: preview scan failed');
        return reply.status(400).send({
          error: {
            code: 'INVALID_SLACK_EXPORT',
            message: 'Uploaded file is not a valid Slack workspace export (.zip)',
            details: [],
            request_id: request.id,
          },
        });
      } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
      }

      // Insert the durable row with status='pending' and an empty mapping.
      const [row] = await db
        .insert(banterSlackImports)
        .values({
          org_id: user.org_id,
          initiated_by: user.id,
          workspace_name: preview.workspace_name,
          source_filename: file.filename ?? `${importId}.zip`,
          source_size_bytes: buffer.length,
          source_minio_key: key,
          mapping: {},
          status: 'pending',
          progress_total: preview.messages_estimated,
        })
        .returning();

      if (!row) {
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to persist slack import row',
            details: [],
            request_id: request.id,
          },
        });
      }

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.slack_import.uploaded',
        entity_type: 'banter_slack_import',
        entity_id: row.id,
        details: {
          source_filename: row.source_filename,
          source_size_bytes: row.source_size_bytes,
          channels_detected: preview.channels_detected,
          users_detected: preview.users_detected,
          messages_estimated: preview.messages_estimated,
        },
      }).catch(() => {});

      return reply.status(201).send({
        data: {
          import_id: row.id,
          preview: {
            channels_detected: preview.channels_detected,
            dms_detected: preview.dms_detected,
            users_detected: preview.users_detected,
            messages_estimated: preview.messages_estimated,
            workspace_name: preview.workspace_name,
          },
        },
      });
    },
  );

  // GET /v1/admin/import/slack/:id/preview — full users + channels list
  fastify.get(
    '/v1/admin/import/slack/:id/preview',
    {
      preHandler: [requireAuth, fastify.requireCan('banter.admin_import.status')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const row = await loadImportRow(user.org_id, id);
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Slack import not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const { path, cleanup } = await downloadToTempfile(row.source_minio_key);
      try {
        const preview = await buildPreview(path);
        return reply.send({
          data: {
            users: preview.users,
            channels: preview.channels,
            dms: preview.dms,
            mpims: preview.mpims,
          },
        });
      } finally {
        await cleanup();
      }
    },
  );

  // POST /v1/admin/import/slack/:id/start — persist mapping + enqueue
  fastify.post(
    '/v1/admin/import/slack/:id/start',
    {
      preHandler: [requireAuth, fastify.requireCan('banter.admin_import.create')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const parsed = startBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid start body',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const mapping: MappingPayload = {
        ...parsed.data,
        // Zod default() of an empty optionsSchema object returns the
        // schema's defaulted values, but TS doesn't see them as required —
        // re-apply with the parsed result to satisfy the MappingPayload type.
        options: parsed.data.options as MappingPayload['options'],
        users: parsed.data.users.map((u) => ({
          slack_user_id: u.slack_user_id,
          action: u.action,
          target_user_id: u.target_user_id ?? null,
          send_email: u.send_email,
        })),
        channels: parsed.data.channels.map((c) => ({
          slack_channel_id: c.slack_channel_id,
          action: c.action,
          target_channel_id: c.target_channel_id ?? null,
          target_name: c.target_name ?? null,
        })),
      };

      const row = await loadImportRow(user.org_id, id);
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Slack import not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      if (row.status !== 'pending') {
        return reply.status(409).send({
          error: {
            code: 'INVALID_STATE',
            message: `Slack import is in state '${row.status}'; only 'pending' imports can be started`,
            details: [],
            request_id: request.id,
          },
        });
      }

      // Re-scan to validate mapping coverage against the actual export.
      const { path, cleanup } = await downloadToTempfile(row.source_minio_key);
      let preview: SlackPreview;
      try {
        preview = await buildPreview(path);
      } finally {
        await cleanup();
      }

      const issues = validateMapping(preview, mapping);

      // Verify project ownership if mode=use_existing. Done via raw SQL so we
      // don't drag the full Bam projects schema into the satellite.
      if (mapping.project.mode === 'use_existing' && mapping.project.project_id) {
        const projectRows = await db.execute<{ id: string }>(sql`
          SELECT id FROM projects
          WHERE id = ${mapping.project.project_id} AND org_id = ${user.org_id}
          LIMIT 1
        `);
        const projectFound = Array.isArray(projectRows)
          ? projectRows.length > 0
          : ((projectRows as { rows?: unknown[] })?.rows?.length ?? 0) > 0;
        if (!projectFound) {
          issues.push({
            field: 'project.project_id',
            issue: 'project does not exist or is not in your organization',
          });
        }
      }

      // Verify merge targets and map targets belong to this org.
      const mergeTargets = mapping.channels
        .filter((c) => c.action === 'merge_existing' && c.target_channel_id)
        .map((c) => c.target_channel_id as string);
      if (mergeTargets.length > 0) {
        const channelsCheck = await db.execute<{ id: string }>(sql`
          SELECT id FROM banter_channels
          WHERE id = ANY(${mergeTargets}::uuid[]) AND org_id = ${user.org_id}
        `);
        const rows = Array.isArray(channelsCheck)
          ? channelsCheck
          : ((channelsCheck as { rows?: { id: string }[] })?.rows ?? []);
        const foundSet = new Set(rows.map((r) => r.id));
        for (const c of mapping.channels) {
          if (c.action === 'merge_existing' && c.target_channel_id && !foundSet.has(c.target_channel_id)) {
            issues.push({
              field: `channels[${c.slack_channel_id}].target_channel_id`,
              issue: 'target channel does not exist or is not in your organization',
            });
          }
        }
      }

      const mapTargets = mapping.users
        .filter((u) => u.action === 'map_existing' && u.target_user_id)
        .map((u) => u.target_user_id as string);
      if (mapTargets.length > 0) {
        const usersCheck = await db.execute<{ user_id: string }>(sql`
          SELECT user_id FROM organization_memberships
          WHERE user_id = ANY(${mapTargets}::uuid[]) AND org_id = ${user.org_id}
        `);
        const rows = Array.isArray(usersCheck)
          ? usersCheck
          : ((usersCheck as { rows?: { user_id: string }[] })?.rows ?? []);
        const foundSet = new Set(rows.map((r) => r.user_id));
        for (const u of mapping.users) {
          if (u.action === 'map_existing' && u.target_user_id && !foundSet.has(u.target_user_id)) {
            issues.push({
              field: `users[${u.slack_user_id}].target_user_id`,
              issue: 'target user is not a member of your organization',
            });
          }
        }
      }

      if (issues.length > 0) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Mapping payload failed validation',
            details: issues,
            request_id: request.id,
          },
        });
      }

      // Persist the mapping and flip to queued.
      await db
        .update(banterSlackImports)
        .set({
          mapping: mapping as unknown as Record<string, unknown>,
          status: 'queued',
          updated_at: new Date(),
        })
        .where(eq(banterSlackImports.id, id));

      const bullJobId = await enqueueSlackImport(id);

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.slack_import.started',
        entity_type: 'banter_slack_import',
        entity_id: id,
        details: {
          bullmq_job_id: bullJobId,
          project_mode: mapping.project.mode,
          user_mapping_count: mapping.users.length,
          channel_mapping_count: mapping.channels.length,
          options: mapping.options,
        },
      }).catch(() => {});

      return reply.status(202).send({
        data: {
          import_id: id,
          status: 'queued',
        },
      });
    },
  );

  // GET /v1/admin/import/slack/:id/status — poll the durable row
  fastify.get(
    '/v1/admin/import/slack/:id/status',
    {
      preHandler: [requireAuth, fastify.requireCan('banter.admin_import.status')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const row = await loadImportRow(user.org_id, id);
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Slack import not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: publicRowShape(row) });
    },
  );

  // GET /v1/admin/import/slack/ — paginated history
  fastify.get(
    '/v1/admin/import/slack/',
    {
      preHandler: [requireAuth, fastify.requireCan('banter.admin_import.status')],
    },
    async (request, reply) => {
      const user = request.user!;
      const rows = await db
        .select()
        .from(banterSlackImports)
        .where(eq(banterSlackImports.org_id, user.org_id))
        .orderBy(desc(banterSlackImports.created_at))
        .limit(50);
      const data = rows.map((r) =>
        publicRowShape({
          id: r.id,
          org_id: r.org_id,
          project_id: r.project_id,
          channel_group_id: r.channel_group_id,
          initiated_by: r.initiated_by,
          workspace_name: r.workspace_name,
          workspace_url: r.workspace_url,
          source_filename: r.source_filename,
          source_size_bytes: Number(r.source_size_bytes),
          source_minio_key: r.source_minio_key,
          mapping: (r.mapping as Record<string, unknown>) ?? {},
          status: r.status,
          phase: r.phase,
          progress_total: r.progress_total,
          progress_done: r.progress_done,
          totals_imported: (r.totals_imported as Record<string, unknown>) ?? {},
          totals_skipped: (r.totals_skipped as Record<string, unknown>) ?? {},
          error_message: r.error_message,
          started_at: r.started_at,
          completed_at: r.completed_at,
          created_at: r.created_at,
          updated_at: r.updated_at,
        }),
      );
      return reply.send({ data });
    },
  );

  // DELETE /v1/admin/import/slack/:id — abort + cleanup
  fastify.delete(
    '/v1/admin/import/slack/:id',
    {
      preHandler: [requireAuth, fastify.requireCan('banter.admin_import.abort')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const queryParsed = deleteQuerySchema.safeParse(request.query ?? {});
      if (!queryParsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: queryParsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const { cleanup_stubs } = queryParsed.data;

      const row = await loadImportRow(user.org_id, id);
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Slack import not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Signal the worker first so it can stop between batches before we
      // start deleting rows it might still be inserting into.
      await publishAbortSignal(id);

      const counts = {
        messages: 0,
        attachments: 0,
        reactions: 0,
        channels: 0,
        channel_groups: 0,
        stub_users: 0,
      };

      // Execute the cleanup inside a single transaction. Drizzle's
      // postgres-js adapter exposes transactions via db.transaction().
      await db.transaction(async (tx) => {
        await tx
          .update(banterSlackImports)
          .set({ status: 'aborted', updated_at: new Date() })
          .where(eq(banterSlackImports.id, id));

        // Delete messages, attachments, reactions tagged with this import.
        const delMessages = await tx.execute<{ count: number }>(sql`
          WITH d AS (
            DELETE FROM banter_messages
            WHERE metadata #>> '{slack_source,import_id}' = ${id}
            RETURNING 1
          )
          SELECT count(*)::int AS count FROM d
        `);
        const delAttachments = await tx.execute<{ count: number }>(sql`
          WITH d AS (
            DELETE FROM banter_message_attachments
            WHERE metadata #>> '{slack_source,import_id}' = ${id}
            RETURNING 1
          )
          SELECT count(*)::int AS count FROM d
        `);
        const delReactions = await tx.execute<{ count: number }>(sql`
          WITH d AS (
            DELETE FROM banter_message_reactions
            WHERE metadata #>> '{slack_source,import_id}' = ${id}
            RETURNING 1
          )
          SELECT count(*)::int AS count FROM d
        `);

        function firstCount(result: unknown): number {
          const rows = Array.isArray(result)
            ? (result as { count?: number }[])
            : ((result as { rows?: { count?: number }[] })?.rows ?? []);
          return rows[0]?.count ?? 0;
        }
        counts.messages = firstCount(delMessages);
        counts.attachments = firstCount(delAttachments);
        counts.reactions = firstCount(delReactions);

        // Delete channels created by this import (scoped to its group +
        // started_at floor). If channel_group_id is null the worker never
        // got far enough to create the group — nothing to delete.
        // postgres-js binds Dates fine in some paths but trips on the
        // sql tag here, so cast through ISO strings on the SQL side.
        const startedAtIso = (row.started_at ?? row.created_at).toISOString();
        if (row.channel_group_id) {
          const delChannels = await tx.execute<{ count: number }>(sql`
            WITH d AS (
              DELETE FROM banter_channels
              WHERE channel_group_id = ${row.channel_group_id}
                AND created_at >= ${startedAtIso}::timestamptz
              RETURNING 1
            )
            SELECT count(*)::int AS count FROM d
          `);
          counts.channels = firstCount(delChannels);

          const delGroups = await tx.execute<{ count: number }>(sql`
            WITH d AS (
              DELETE FROM banter_channel_groups
              WHERE id = ${row.channel_group_id}
              RETURNING 1
            )
            SELECT count(*)::int AS count FROM d
          `);
          counts.channel_groups = firstCount(delGroups);
        }

        if (cleanup_stubs) {
          // Only remove stubs minted by THIS import. Match on workspace +
          // import-time floor so a different import's stubs aren't touched.
          const delStubs = await tx.execute<{ count: number }>(sql`
            WITH d AS (
              DELETE FROM users
              WHERE (notification_prefs ->> 'slack_stub')::boolean IS TRUE
                AND (notification_prefs ->> 'imported_at')::timestamptz >= ${startedAtIso}::timestamptz
                AND notification_prefs ->> 'slack_workspace' = ${row.workspace_name}
                AND id IN (
                  SELECT user_id FROM organization_memberships
                  WHERE org_id = ${user.org_id}
                )
              RETURNING 1
            )
            SELECT count(*)::int AS count FROM d
          `);
          counts.stub_users = firstCount(delStubs);
        }
      });

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.slack_import.aborted',
        entity_type: 'banter_slack_import',
        entity_id: id,
        details: { cleanup_stubs, counts },
      }).catch(() => {});

      return reply.send({
        data: {
          aborted: true,
          deleted: counts,
        },
      });
    },
  );
}

// Silence unused-import warnings when the build extracts only certain
// helpers — Readable is referenced by request.file() typing in some
// @fastify/multipart versions.
void Readable;
