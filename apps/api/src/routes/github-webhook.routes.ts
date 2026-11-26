import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { githubIntegrations } from '../db/schema/github-integrations.js';
import { verifyGithubSignature, extractHookEvents } from '../services/github-integration.service.js';
import { processGithubDelivery, type GithubDeliveryEvent } from '../services/github-delivery.service.js';
import { enqueueGithubDeliveryRetry, githubDeliveryJobId } from '../services/github-delivery-queue.js';
import { requireInternalSecret } from '../lib/internal-secret.js';

/**
 * Phase 6: GitHub → Bam webhook ingest.
 *
 * GitHub POSTs events here with an X-Hub-Signature-256 header we must
 * verify using the per-integration webhook_secret BEFORE parsing or
 * trusting any field in the body. The content-type parser below keeps
 * the raw body around so HMAC verification sees the exact bytes GitHub
 * signed (re-serializing JSON would break the signature).
 *
 * We act on these event types:
 *   - ping                → store hook.events in github_integrations.subscribed_events
 *   - push                → parse commit messages, link to tasks
 *   - pull_request        → append to github_pr_events; on opened/merged, link +
 *                           optionally transition
 *   - pull_request_review → append to github_pr_events (Bastion change evidence)
 *
 * Anything else returns 204 (we acknowledge, but didn't do anything).
 *
 * Durability (issue #186): GitHub NEVER redelivers a failed delivery on its own ("Redeliver"
 * is a manual button nobody is told to press), so a 5xx here used to lose the delivery for
 * good: a merge missing from github_pr_events lets Bastion's change.merge_reviewed pass when
 * it should fail, and the task never moves. Once the signature is verified, the delivery is
 * applied inline by processGithubDelivery; if that throws, the verified delivery is spooled to
 * the github-delivery-retry queue and GitHub gets a 202. The worker replays it through
 * POST /internal/github/deliveries/process with exponential backoff. Only a failure BEFORE
 * verification (the integration lookup itself) or of the enqueue still answers 5xx.
 */

type RepoPayload = {
  repository?: { owner?: { login?: string; name?: string }; name?: string };
};

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

const processDeliverySchema = z.object({
  integration_id: z.string().uuid(),
  event: z.enum(['push', 'pull_request', 'pull_request_review']),
  delivery_id: z.string().max(128).nullable(),
  payload: z.unknown(),
  received_at: z.string().datetime({ offset: true }),
});

export default async function githubWebhookRoutes(fastify: FastifyInstance) {
  // We need the raw body bytes for HMAC verification — Fastify's
  // default JSON parser consumes and discards them. Instead of
  // globally overriding 'application/json' (which would affect every
  // other route), we use a preParsing hook scoped to this one route
  // via a custom config flag. The hook intercepts the incoming stream,
  // buffers it, stashes the raw bytes on the request, and replaces
  // the request's body stream with a fresh Readable so Fastify's
  // JSON parser still runs normally downstream.
  const { Readable } = await import('node:stream');

  fastify.post(
    '/webhooks/github',
    {
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks);
        (request as RawBodyRequest).rawBody = raw;
        return Readable.from(raw);
      },
    },
    async (request, reply) => {
      const event = (request.headers['x-github-event'] as string | undefined) ?? '';
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = (request as RawBodyRequest).rawBody ?? Buffer.from('');

      // We act on push, pull_request and pull_request_review (the last only
      // to record it in github_pr_events for Bastion's change-management
      // evidence), and on ping (to store hook.events). Everything else
      // (issues, stars, etc.) gets a quiet 204.
      const actionable =
        event === 'push' || event === 'pull_request' || event === 'pull_request_review';
      if (!actionable && event !== 'ping') {
        return reply.status(204).send();
      }

      const body = request.body as RepoPayload;
      const owner = body?.repository?.owner?.login ?? body?.repository?.owner?.name;
      const repoName = body?.repository?.name;
      if (!owner || !repoName) {
        return reply.status(204).send();
      }

      const [integration] = await db
        .select()
        .from(githubIntegrations)
        .where(
          and(
            eq(githubIntegrations.repo_owner, owner),
            eq(githubIntegrations.repo_name, repoName),
          ),
        )
        .limit(1);

      if (!integration) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'No GitHub integration configured for this repository',
            details: [],
            request_id: request.id,
          },
        });
      }

      // HMAC verification must happen AFTER we know the secret but
      // BEFORE we trust any field in the body. Using timingSafeEqual
      // inside verifyGithubSignature keeps this safe against timing
      // oracles.
      if (!verifyGithubSignature(rawBody, signature, integration.webhook_secret)) {
        return reply.status(401).send({
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Webhook signature verification failed',
            details: [],
            request_id: request.id,
          },
        });
      }

      // ping is the handshake. GitHub sends it when the webhook is created and
      // again on "Redeliver", carrying hook.events: the event list the webhook
      // is subscribed to. We store it (migration 0273) so Bastion can tell
      // "review events are not sent" apart from "unknown" (NULL).
      if (event === 'ping') {
        const events = extractHookEvents(request.body);
        if (events) {
          await db
            .update(githubIntegrations)
            .set({ subscribed_events: events, updated_at: new Date() })
            .where(eq(githubIntegrations.id, integration.id));
        }
        return reply.send({ data: { processed: 0, subscribed_events: events } });
      }

      if (!integration.enabled) {
        return reply.send({ data: { processed: 0 } });
      }

      const deliveryHeader = request.headers['x-github-delivery'];
      const deliveryId = typeof deliveryHeader === 'string' ? deliveryHeader : null;
      const receivedAt = new Date();

      try {
        const processed = await processGithubDelivery(
          integration,
          event as GithubDeliveryEvent,
          request.body,
          deliveryId,
          receivedAt,
        );
        return reply.send({ data: { processed } });
      } catch (err) {
        request.log.warn(
          { err, integration_id: integration.id, delivery_id: deliveryId, event },
          'github webhook: inline processing failed; spooling the verified delivery for retry',
        );
        // Rethrows (so GitHub shows a failed delivery) only if Redis also refuses the job.
        await enqueueGithubDeliveryRetry(
          {
            integration_id: integration.id,
            event: event as GithubDeliveryEvent,
            delivery_id: deliveryId,
            payload: request.body,
            received_at: receivedAt.toISOString(),
          },
          githubDeliveryJobId(integration.id, deliveryId, rawBody),
        );
        return reply.status(202).send({ data: { processed: 0, queued: true } });
      }
    },
  );

  // Server-to-server replay of a spooled delivery (worker job github-delivery-retry). The
  // payload was signature-verified when it arrived; this route is gated by
  // INTERNAL_SERVICE_SECRET. A 5xx makes BullMQ retry with backoff.
  fastify.post(
    '/internal/github/deliveries/process',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const parsed = processDeliverySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid delivery replay payload',
            details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
            request_id: request.id,
          },
        });
      }
      const job = parsed.data;
      const [integration] = await db
        .select()
        .from(githubIntegrations)
        .where(eq(githubIntegrations.id, job.integration_id))
        .limit(1);
      // A deleted or disabled integration drops the delivery, exactly as a live delivery
      // would be dropped; 200 so the job completes instead of retrying forever.
      if (!integration || !integration.enabled) {
        return reply.send({ data: { processed: 0, skipped: integration ? 'disabled' : 'integration_missing' } });
      }
      const processed = await processGithubDelivery(
        integration,
        job.event,
        job.payload,
        job.delivery_id,
        new Date(job.received_at),
      );
      return reply.send({ data: { processed } });
    },
  );
}
