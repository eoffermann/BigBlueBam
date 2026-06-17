import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import * as externalSyncService from '../services/external-sync.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { env } from '../env.js';

const connectIcsSchema = z.object({
  feed_url: z.string().min(1),
  name: z.string().max(255).optional(),
  calendar_id: z.string().uuid().optional(),
});

const connectOAuthSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  external_calendar_id: z.string(),
  sync_direction: z.enum(['inbound', 'outbound', 'both']).optional(),
  calendar_id: z.string().uuid().optional(),
});

function oauthUnavailable(provider: 'google' | 'microsoft'): { configured: boolean; message: string } {
  const configured =
    provider === 'google'
      ? !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET
      : !!env.MICROSOFT_CLIENT_ID && !!env.MICROSOFT_CLIENT_SECRET;
  const label = provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
  return {
    configured,
    message: configured
      ? `${label} OAuth credentials are configured, but the consent flow is not yet wired. Use an ICS feed URL in the meantime.`
      : `${label} sync requires operator-supplied OAuth credentials (${
          provider === 'google' ? 'GOOGLE_CLIENT_ID/SECRET' : 'MICROSOFT_CLIENT_ID/SECRET'
        }). Use an ICS feed URL in the meantime.`,
  };
}

export default async function connectionRoutes(fastify: FastifyInstance) {
  // GET /connections
  fastify.get('/connections', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = await externalSyncService.listConnections(request.user!.id);
    return reply.send(result);
  });

  // POST /connections/ics — the no-secret, fully-working provider path.
  fastify.post('/connections/ics', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = connectIcsSchema.parse(request.body);
    const connection = await externalSyncService.createIcsConnection(
      request.user!.id,
      request.user!.org_id,
      body,
    );
    return reply.status(201).send({ data: connection });
  });

  // POST /connections/google — gated on operator OAuth creds.
  fastify.post('/connections/google', { preHandler: [requireAuth] }, async (request, reply) => {
    const info = oauthUnavailable('google');
    if (!info.configured) {
      return reply.status(501).send({
        error: { code: 'PROVIDER_NOT_CONFIGURED', message: info.message, details: [], request_id: request.id },
      });
    }
    const body = connectOAuthSchema.parse(request.body);
    const connection = await externalSyncService.createOAuthConnection(
      request.user!.id,
      'google',
      body.access_token,
      body.refresh_token,
      body.external_calendar_id,
      body.sync_direction,
      body.calendar_id,
    );
    return reply.status(201).send({ data: connection });
  });

  // POST /connections/microsoft — gated on operator OAuth creds.
  fastify.post('/connections/microsoft', { preHandler: [requireAuth] }, async (request, reply) => {
    const info = oauthUnavailable('microsoft');
    if (!info.configured) {
      return reply.status(501).send({
        error: { code: 'PROVIDER_NOT_CONFIGURED', message: info.message, details: [], request_id: request.id },
      });
    }
    const body = connectOAuthSchema.parse(request.body);
    const connection = await externalSyncService.createOAuthConnection(
      request.user!.id,
      'microsoft',
      body.access_token,
      body.refresh_token,
      body.external_calendar_id,
      body.sync_direction,
      body.calendar_id,
    );
    return reply.status(201).send({ data: connection });
  });

  // DELETE /connections/:id
  fastify.delete<{ Params: { id: string } }>(
    '/connections/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await externalSyncService.deleteConnection(request.params.id, request.user!.id);
      return reply.send({ data: result });
    },
  );

  // POST /connections/:id/sync — run the engine inline, return the result.
  fastify.post<{ Params: { id: string } }>(
    '/connections/:id/sync',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await externalSyncService.forceSync(request.params.id, request.user!.id);

      // Emit a Bolt event so automations can react to a completed sync.
      try {
        publishBoltEvent(
          'connection.synced',
          'book',
          {
            connection: {
              id: result.connection_id,
              provider: 'ics',
              user_id: request.user!.id,
              status: result.status,
            },
            result: {
              imported: result.imported,
              created: result.created,
              updated: result.updated,
              removed: result.removed,
            },
          },
          request.user!.org_id,
        );
      } catch {
        // Best-effort — a Bolt publish failure must not fail the sync response.
      }

      return reply.send({ data: result });
    },
  );
}
