import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  bursarListQuerySchema,
  bursarOfferCreateSchema,
  bursarOfferUploadSchema,
  bursarUnsealOfferSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as offers from '../services/offers.service.js';

// Offer ingest + read routes (spec 11, M4). Per-route permission metadata is authored inline via
// fastify.requireCan (M9 walks it): reads use bursar.offer.read; structural writes + delete use
// bursar.offer.write; the multipart ingest uses bursar.offer.ingest; unseal is FLOORED and
// confirm-required (bursar.offer.unseal). Under the fail-closed boot invariant these deny for
// non-SuperUsers from M1 through M8 (dev + Playwright run as Skipper, a SuperUser). Every read is
// projected through the shared seal predicate in the service, then the financial floor here.
export default async function offerRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // ── List offers for a request ────────────────────────────────────────────────
  fastify.get(
    '/requests/:id/offers',
    { preHandler: [requireAuth, can('bursar.offer.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const q = request.query as { cursor?: string; limit?: string };
      const parsed = bursarListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      try {
        const result = await offers.listOffers(viewerOf(request), id, { cursor: q.cursor, limit });
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Create an offer under a request ──────────────────────────────────────────
  fastify.post(
    '/requests/:id/offers',
    { preHandler: [requireAuth, can('bursar.offer.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarOfferCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const viewer = viewerOf(request);
        const asker = askerViewer(request);
        const result = await offers.createOffer(viewer, id, parsed.data, asker?.id ?? viewer.id);
        reply.status(201);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Ingest / (re)attach + parse (multipart or JSON) ──────────────────────────
  // The document byte source is a Bin asset (access-checked and version-pinned, §5.8) or inline
  // source text. A multipart file part, when present, is read as the inline document, bounded by
  // MAX_DOC_BYTES: a file over the limit yields a 413 mapped to "this file is larger than 20MB"
  // (the global nginx client_max_body_size is deliberately NOT raised for one app's worst case).
  fastify.post(
    '/offers/:id/upload',
    { preHandler: [requireAuth, can('bursar.offer.ingest')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = await readUploadBody(request, reply);
      if (body === undefined) return reply; // a 413/400 was already sent
      const parsed = bursarOfferUploadSchema.safeParse(body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const viewer = viewerOf(request);
        const asker = askerViewer(request);
        const result = await offers.uploadOffer(viewer, id, parsed.data, asker?.id ?? viewer.id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Read one offer ───────────────────────────────────────────────────────────
  fastify.get(
    '/offers/:id',
    { preHandler: [requireAuth, can('bursar.offer.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await offers.getOffer(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Read parsed lines ─────────────────────────────────────────────────────────
  fastify.get(
    '/offers/:id/lines',
    { preHandler: [requireAuth, can('bursar.offer.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await offers.getOfferLines(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Reparse ────────────────────────────────────────────────────────────────────
  fastify.post(
    '/offers/:id/reparse',
    { preHandler: [requireAuth, can('bursar.offer.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await offers.reparseOffer(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Unseal (floored, confirm-required) ───────────────────────────────────────
  fastify.post(
    '/offers/:id/unseal',
    { preHandler: [requireAuth, can('bursar.offer.unseal')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarUnsealOfferSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await offers.unsealOffer(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Delete ─────────────────────────────────────────────────────────────────────
  fastify.delete(
    '/offers/:id',
    { preHandler: [requireAuth, can('bursar.offer.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await offers.deleteOffer(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}

/**
 * Resolve the upload body from either a multipart form (a file part becomes inline source_text,
 * bounded by MAX_DOC_BYTES) or a JSON body. Returns the plain object to validate, or `undefined`
 * after having already sent a 413/400. Multipart handling degrades gracefully when the plugin is
 * absent: a non-multipart request falls through to request.body.
 */
async function readUploadBody(
  request: FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<Record<string, unknown> | undefined> {
  const isMultipart =
    typeof (request as { isMultipart?: () => boolean }).isMultipart === 'function' &&
    (request as { isMultipart: () => boolean }).isMultipart();
  if (!isMultipart) {
    return (request.body ?? {}) as Record<string, unknown>;
  }
  // Multipart: collect fields + an optional file part.
  const out: Record<string, unknown> = {};
  try {
    const parts = (request as unknown as { parts: () => AsyncIterableIterator<UploadPart> }).parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        // @fastify/multipart flags truncation when the fileSize limit is exceeded.
        if (part.file.truncated) {
          reply.status(413).send({
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'this file is larger than 20MB',
              details: [],
              request_id: request.id,
            },
          });
          return undefined;
        }
        out.source_text = Buffer.concat(chunks).toString('utf8');
      } else {
        out[part.fieldname] = part.value;
      }
    }
  } catch {
    return (request.body ?? {}) as Record<string, unknown>;
  }
  return out;
}

interface UploadPart {
  type: 'file' | 'field';
  fieldname: string;
  value?: string;
  file: AsyncIterable<Buffer> & { truncated: boolean };
}
