import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { env } from '../env.js';

// Internal transactional-send transport (Bulwark spec D6 / reuse ledger line 710). Legally
// required contract notices and compliance chases are TRANSACTIONAL: they must reach the
// counterparty regardless of any marketing unsubscribe. This route is the platform's
// transactional entry point owned by Blast:
//
//   1. It is guarded by INTERNAL_SERVICE_SECRET and fails CLOSED when that secret is empty
//      (an empty-vs-empty compare would authorize an unauthenticated caller).
//   2. It resolves the deterministic recipient (a bond.contact/bond.company entity ref, or a
//      literal email) to an address using the shared DB - the same bond tables the campaign
//      send path reads - and fails closed (422) when no address resolves.
//   3. It enqueues the platform `email` queue (worker-owned SMTP), which NEVER consults
//      `blast_unsubscribes` (that filter lives only in the campaign blast-send path), so the
//      transactional flag is honored by construction.
//
// It intentionally does NOT create a blast campaign, touch suppression, or send SMTP in-process.

const recipientSchema = z.union([
  z.object({ email: z.string().email() }),
  z.object({
    type: z.enum(['bond.contact', 'bond.company']),
    id: z.string().uuid(),
  }),
]);

const transactionalSendSchema = z.object({
  org_id: z.string().uuid(),
  recipient: recipientSchema,
  subject: z.string().min(1).max(998),
  // Callers render markdown; we send it as the text body and a minimal HTML wrapper so the
  // worker email job (which requires `html`) has a body without Blast owning a template engine.
  body_markdown: z.string().min(1),
  transactional: z.literal(true).optional(),
  source_app: z.string().max(32).optional(),
});

let emailQueue: Queue | null = null;
let emailConnection: IORedis | null = null;
function getEmailQueue(): Queue {
  if (!emailQueue) {
    emailConnection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    emailQueue = new Queue('email', { connection: emailConnection });
  }
  return emailQueue;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// Fail-closed internal guard: reject unconditionally when the sole secret is empty.
function requireInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
  const configured = env.INTERNAL_SERVICE_SECRET;
  const provided = request.headers['x-internal-secret'];
  const ok =
    !!configured &&
    typeof provided === 'string' &&
    provided.length === configured.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
  if (!ok) {
    reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing X-Internal-Secret header',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}

// Resolve a recipient entity ref (or literal email) to an address. Company -> the first
// associated contact carrying an email. Returns null when nothing resolves (fail closed).
async function resolveRecipientEmail(
  orgId: string,
  recipient: z.infer<typeof recipientSchema>,
): Promise<string | null> {
  if ('email' in recipient) return recipient.email;
  if (recipient.type === 'bond.contact') {
    const res = await db.execute(sql`
      SELECT email FROM bond_contacts
       WHERE organization_id = ${orgId} AND id = ${recipient.id} AND email IS NOT NULL
       LIMIT 1
    `);
    return rows<{ email: string }>(res)[0]?.email ?? null;
  }
  // bond.company: pick the first associated contact with an email.
  const res = await db.execute(sql`
    SELECT c.email
      FROM bond_contacts c
      JOIN bond_contact_companies cc ON cc.contact_id = c.id
     WHERE cc.company_id = ${recipient.id}
       AND c.organization_id = ${orgId}
       AND c.email IS NOT NULL
     ORDER BY c.created_at
     LIMIT 1
  `);
  return rows<{ email: string }>(res)[0]?.email ?? null;
}

export default async function internalRoutes(fastify: FastifyInstance) {
  fastify.post('/internal/transactional-send', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = transactionalSendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid transactional-send request',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
          request_id: request.id,
        },
      });
    }
    const { org_id, recipient, subject, body_markdown, source_app } = parsed.data;
    const to = await resolveRecipientEmail(org_id, recipient);
    if (!to) {
      // Fail closed: an unresolved recipient is a hard error the caller annotates (SN1).
      return reply.status(422).send({
        error: {
          code: 'RECIPIENT_UNRESOLVED',
          message: 'Could not resolve a deliverable email for the recipient',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Minimal HTML wrapper so the worker email job has an html body; the markdown is the source
    // of truth and rides as the text part.
    const html = `<div style="white-space:pre-wrap;font-family:system-ui,sans-serif">${escapeHtml(body_markdown)}</div>`;
    await getEmailQueue().add(
      'transactional',
      { to, subject, html, text: body_markdown, org_id },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
      },
    );
    request.log.info(
      { org_id, source_app: source_app ?? 'bulwark', to_domain: to.split('@')[1] ?? '?' },
      'blast transactional-send enqueued (bypasses suppression, D6)',
    );
    return reply.status(202).send({ data: { accepted: true, transactional: true } });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
