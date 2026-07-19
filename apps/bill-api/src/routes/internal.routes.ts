import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '../lib/internal-secret.js';
import * as rateService from '../services/rate.service.js';
import * as lineItemService from '../services/line-item.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { loadOrg } from '../lib/bolt-event-enrich.js';

/**
 * bill-api's service-to-service surface (Burn spec 9.2).
 *
 * Registered under { prefix: '/v1' }, so the live paths are /v1/internal/rates/resolve and
 * friends. Every route fails CLOSED on an empty INTERNAL_SERVICE_SECRET.
 *
 * ── WHY THESE EXIST ─────────────────────────────────────────────────────────────────
 *
 * Burn values every priced hour. If it reimplemented rate precedence, Burn's valuation and
 * Bill's own invoices would silently disagree about the SAME HOUR, which is the worst
 * possible failure for a margin product: two internally-consistent numbers that do not
 * match, with no way to tell which is right. So these routes DELEGATE to resolveRate()
 * rather than restating the algorithm. Bill's rate.service.ts remains the single
 * definition of precedence (user+project > user > project > org) and of the INCLUSIVE
 * effective_to bound (`gte(billRates.effective_to, date)`, i.e. a rate whose effective_to
 * IS the requested date still applies). Nothing here re-derives either.
 */

const resolveRateSchema = z.object({
  organization_id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional(),
  user_id: z.string().uuid().nullable().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

/**
 * The batch form. Burn's nightly revaluation pass reprices every unvalued work item in the
 * org; one HTTP round trip per work item would make a 40k-item pass 40k requests against
 * the service that also serves invoices. Capped so a caller cannot ask for an unbounded
 * fan-out in one request.
 */
const BATCH_MAX = 500;

const resolveRateBatchSchema = z.object({
  organization_id: z.string().uuid(),
  items: z
    .array(
      z.object({
        // Echoed back verbatim so the caller can correlate without relying on array order.
        ref: z.string().max(128).optional(),
        project_id: z.string().uuid().nullable().optional(),
        user_id: z.string().uuid().nullable().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(BATCH_MAX),
});

const internalLineItemSchema = z.object({
  organization_id: z.string().uuid(),
  /**
   * THE HUMAN AUTHORITY THIS WRITE ACTS UNDER (spec 2.4 point 11, 9.2).
   *
   * It arrives IN THE BODY and there is deliberately NO trusted X-Acting-User header
   * anywhere in this codebase. The platform pattern, established at
   * apps/bulwark-api/src/subscriptions/proposal-decided.ts:88, is that the calling service
   * first CHECKS the decider's permission via POST /internal/permissions/dual-read and only
   * then acts under the internal secret. A header would invert that: it would let anything
   * holding the shared secret assert an identity bill-api never verified, turning one
   * leaked secret into impersonation of every user in the org.
   *
   * This exists because Burn's change-order approval runs inside a `proposal.decided`
   * subscription where there is no session at all, and the resulting invoice line still
   * has to name the human who approved it.
   */
  acting_user_id: z.string().uuid(),
  description: z.string().min(1).max(1000),
  quantity: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  unit_price: z.number().int(),
  sort_order: z.number().int().optional(),
  time_entry_ids: z.array(z.string().uuid()).optional(),
  task_id: z.string().uuid().optional(),
});

function validationError(request: { id: string }, error: z.ZodError) {
  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      details: error.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })),
      request_id: request.id,
    },
  };
}

export default async function internalRoutes(fastify: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /internal/rates/resolve
  // ---------------------------------------------------------------------------
  fastify.post('/internal/rates/resolve', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;

    const parsed = resolveRateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(validationError(request, parsed.error));

    const { organization_id, project_id, user_id, date } = parsed.data;
    // Straight delegation. `scope` is returned so the caller can record WHICH tier matched
    // ('user+project' | 'user' | 'project' | 'organization' | 'none') for its audit trail.
    const result = await rateService.resolveRate(
      organization_id,
      project_id ?? undefined,
      user_id ?? undefined,
      date ?? undefined,
    );
    return reply.send({ data: result.data, scope: result.scope });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/rates/resolve-batch
  // ---------------------------------------------------------------------------
  fastify.post('/internal/rates/resolve-batch', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;

    const parsed = resolveRateBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(validationError(request, parsed.error));

    const { organization_id, items } = parsed.data;

    // Serial rather than Promise.all: these are cheap indexed lookups, and a 500-wide
    // parallel fan-out from a background revaluation pass would contend with the request
    // path of the service that also serves invoices. Bounded latency beats peak throughput
    // for a nightly job.
    const results: Array<{
      ref: string | null;
      project_id: string | null;
      user_id: string | null;
      date: string | null;
      data: unknown;
      scope: string;
    }> = [];

    for (const item of items) {
      const resolved = await rateService.resolveRate(
        organization_id,
        item.project_id ?? undefined,
        item.user_id ?? undefined,
        item.date ?? undefined,
      );
      results.push({
        ref: item.ref ?? null,
        project_id: item.project_id ?? null,
        user_id: item.user_id ?? null,
        date: item.date ?? null,
        data: resolved.data,
        scope: resolved.scope,
      });
    }

    return reply.send({ data: results, count: results.length });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/invoices/:id/line-items
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    '/internal/invoices/:id/line-items',
    async (request, reply) => {
      if (!requireInternalSecret(request, reply)) return reply;

      const parsed = internalLineItemSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(request, parsed.error));

      const { organization_id, acting_user_id, ...input } = parsed.data;

      const item = await lineItemService.addLineItem(
        request.params.id,
        organization_id,
        { ...input, acting_user_id },
      );

      // The authority is recorded on the row AND published, so it is auditable from either
      // end: the invoice itself, and the event stream a Bolt rule or a compliance review
      // reads. A row-only record would be invisible to everything downstream.
      const org = await loadOrg(organization_id);
      publishBoltEvent(
        'invoice.line_item_added',
        'bill',
        {
          invoice_id: request.params.id,
          line_item: {
            id: item.id,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_price,
            amount: item.amount,
          },
          acting_user_id,
          source: 'internal',
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        organization_id,
        acting_user_id,
      );

      return reply.status(201).send({ data: item });
    },
  );
}
