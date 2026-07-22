/**
 * SuperUser Console - database backup/restore (Backup app, Platform scope).
 *
 *   GET    /superuser/backups              list backups (+ restore history)
 *   POST   /superuser/backups              trigger a whole-database backup now
 *   GET    /superuser/backups/:id/download stream the pg_dump archive
 *   DELETE /superuser/backups/:id          delete a backup (row + object)
 *   POST   /superuser/backups/:id/restore  restore (requires the typed phrase)
 *   GET    /superuser/restores             restore run history
 *
 * SuperUser-only (mirrors superuser-logs.routes.ts). Restore is destructive:
 * it requires the caller to type the exact per-backup confirmation phrase.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';
import * as backupService from '../services/backup.service.js';

function requireSuperuser(
  request: { user: { is_superuser?: boolean } | null },
  reply: FastifyReply,
  requestId: string,
): FastifyReply | null {
  if (!request.user || request.user.is_superuser !== true) {
    return reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'SuperUser access required', details: [], request_id: requestId },
    });
  }
  return null;
}

function withPhrase(b: backupService.BackupRow) {
  return { ...b, restore_confirmation: backupService.restoreConfirmationPhrase(b.id) };
}

const restoreBody = z.object({ confirmation_phrase: z.string().min(1).max(200) });

export default async function superuserBackupsRoutes(fastify: FastifyInstance) {
  // ── GET /superuser/backups ────────────────────────────────────────
  fastify.get('/superuser/backups', { preHandler: [requireAuth] }, async (request, reply) => {
    const guard = requireSuperuser(request, reply, request.id);
    if (guard) return guard;
    const [backups, restores] = await Promise.all([
      backupService.listBackups(100, 0),
      backupService.listRestores(50),
    ]);
    return reply.send({ data: { backups: backups.map(withPhrase), restores } });
  });

  // ── POST /superuser/backups (trigger now) ─────────────────────────
  fastify.post('/superuser/backups', { preHandler: [requireAuth] }, async (request, reply) => {
    const guard = requireSuperuser(request, reply, request.id);
    if (guard) return guard;
    const userId = request.user!.id;
    const backup = await backupService.createBackup(userId);
    if (!backup) {
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create backup', details: [], request_id: request.id },
      });
    }
    await logSuperuserAction({
      superuserId: userId,
      action: 'trigger_database_backup',
      targetType: 'backup',
      targetId: backup.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? undefined,
    });
    return reply.status(202).send({ data: withPhrase(backup) });
  });

  // ── GET /superuser/backups/:id/download ───────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/superuser/backups/:id/download',
    { preHandler: [requireAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const guard = requireSuperuser(request, reply, request.id);
      if (guard) return guard;
      const result = await backupService.getBackupStream(request.params.id);
      if (!result) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Backup not found or not completed', details: [], request_id: request.id },
        });
      }
      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'download_database_backup',
        targetType: 'backup',
        targetId: request.params.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? undefined,
      });
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
      reply.header('Content-Length', String(result.size));
      return reply.send(result.stream);
    },
  );

  // ── DELETE /superuser/backups/:id ─────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/superuser/backups/:id',
    { preHandler: [requireAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const guard = requireSuperuser(request, reply, request.id);
      if (guard) return guard;
      const ok = await backupService.deleteBackup(request.params.id);
      if (!ok) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Backup not found', details: [], request_id: request.id },
        });
      }
      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'delete_database_backup',
        targetType: 'backup',
        targetId: request.params.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? undefined,
      });
      return reply.send({ data: { id: request.params.id, deleted: true } });
    },
  );

  // ── POST /superuser/backups/:id/restore (DESTRUCTIVE) ─────────────
  fastify.post<{ Params: { id: string } }>(
    '/superuser/backups/:id/restore',
    { preHandler: [requireAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const guard = requireSuperuser(request, reply, request.id);
      if (guard) return guard;
      const parsed = restoreBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'confirmation_phrase is required',
            details: parsed.error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })),
            request_id: request.id,
          },
        });
      }
      const result = await backupService.requestRestore(
        request.params.id,
        request.user!.id,
        parsed.data.confirmation_phrase,
      );
      if (!result.ok) {
        const status = result.reason === 'phrase_mismatch' ? 400 : 409;
        const message =
          result.reason === 'phrase_mismatch'
            ? 'Confirmation phrase does not match. Restore not started.'
            : 'This backup cannot be restored (not completed or archive missing).';
        return reply.status(status).send({
          error: { code: result.reason.toUpperCase(), message, details: [], request_id: request.id },
        });
      }
      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'restore_database_backup',
        targetType: 'backup',
        targetId: request.params.id,
        details: { restore_id: result.restoreId },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? undefined,
      });
      return reply.status(202).send({ data: { restore_id: result.restoreId, status: 'pending' } });
    },
  );

  // ── GET /superuser/restores ───────────────────────────────────────
  fastify.get('/superuser/restores', { preHandler: [requireAuth] }, async (request, reply) => {
    const guard = requireSuperuser(request, reply, request.id);
    if (guard) return guard;
    return reply.send({ data: await backupService.listRestores(100) });
  });
}
