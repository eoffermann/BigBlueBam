import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as reviewLinkService from '../services/review-link.service.js';
import * as binMedia from '../lib/bin-media.js';
import { NotFoundError, GoneError, ForbiddenError } from '../services/errors.js';
import { broadcastToVersion } from '../lib/broadcast.js';
import { REVIEW_TOKEN_HEADER } from '../lib/review-token.js';

// Public guest-review surface. NO auth: the review token is the sole credential.
// Mounted under /v1/public so the existing /bay/api/ nginx proxy serves it with
// no new public route. Tokens are 48 hex chars (unguessable) and stored only as
// a SHA-256 (#122). They never appear in a path or query string, so they stay
// out of access logs and Referer headers: the JSON routes take the token in the
// X-Bay-Review-Token header, and media takes a short-lived ticket. A per-route
// rate limit adds defense in depth.

const guestCommentSchema = z.object({
  body: z.string().min(1).max(5000),
  guest_name: z.string().min(1).max(120),
  anchor: z.record(z.unknown()).optional(),
});

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof GoneError) {
    return reply.status(410).send({
      error: { code: 'GONE', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof ForbiddenError) {
    return reply.status(403).send({
      error: { code: 'FORBIDDEN', message: err.message, details: [], request_id: request.id },
    });
  }
  throw err;
}

/** The review token from its header ('' when absent, which the service rejects as not found). */
function reviewToken(request: FastifyRequest): string {
  const raw = request.headers[REVIEW_TOKEN_HEADER];
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
}

function variantOf(q: unknown): binMedia.ServeVariant {
  const v = (q as { variant?: string })?.variant;
  return v === 'proxy' || v === 'poster' ? v : 'original';
}

export default async function publicReviewRoutes(fastify: FastifyInstance) {
  // A tighter limit than the global one for the unauthenticated surface.
  const rateLimit = { max: 120, timeWindow: 60_000 };

  // GET /public/review: the read-only review bundle (no media bytes). The
  // token comes in the X-Bay-Review-Token header, never the path (#122).
  fastify.get(
    '/public/review',
    { config: { rateLimit } },
    async (request, reply) => {
      try {
        const review = await reviewLinkService.getPublicReviewByToken(reviewToken(request));
        return reply.send({ data: review });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /public/review/media?ticket=...&variant=proxy|poster: stream the bytes.
  // A media element cannot send headers, so it carries the short-lived media
  // ticket from the bundle (lib/review-token.ts), never the link token.
  fastify.get<{ Querystring: { ticket?: string; variant?: string } }>(
    '/public/review/media',
    { config: { rateLimit } },
    async (request, reply) => {
      try {
        // The link's own org scopes every bin_assets read below.
        const resolved = await reviewLinkService.resolveTicketBinAsset(request.query.ticket);
        if (!resolved) throw new NotFoundError('No media for this review');
        const { binAssetId, orgId } = resolved;
        const variant = variantOf(request.query);

        const rangeHeader = (request.headers.range as string | undefined) ?? '';
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (m && binMedia.hasRangeSupport()) {
          const info = await binMedia.statBinMedia(binAssetId, orgId, variant);
          if (!info) throw new NotFoundError('Media not available');
          const total = info.total;
          let start = m[1] ? Number(m[1]) : 0;
          let end = m[2] ? Number(m[2]) : total - 1;
          if (Number.isNaN(start) || start < 0) start = 0;
          if (Number.isNaN(end) || end > total - 1) end = total - 1;
          if (start > end) {
            reply.header('Content-Range', `bytes */${total}`);
            return reply.status(416).send();
          }
          const r = await binMedia.rangeBinMedia(binAssetId, orgId, variant, start, end);
          if (!r) throw new NotFoundError('Media not available');
          reply.header('Content-Type', r.contentType);
          reply.header('Content-Length', r.size);
          reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
          reply.header('Accept-Ranges', 'bytes');
          return reply.status(206).send(r.stream);
        }

        const r = await binMedia.streamBinMedia(binAssetId, orgId, variant);
        if (!r) throw new NotFoundError('Media not available');
        reply.header('Content-Type', r.contentType);
        reply.header('Content-Length', r.size);
        reply.header('Accept-Ranges', 'bytes');
        return reply.send(r.stream);
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /public/review/comments: guest comment (if the link allows it)
  fastify.post(
    '/public/review/comments',
    { config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (request, reply) => {
      const body = guestCommentSchema.parse(request.body);
      try {
        const annotation = await reviewLinkService.addGuestComment(reviewToken(request), body);
        // Members watching this version see the guest comment appear live.
        await broadcastToVersion(fastify.redis, annotation.version_id, {
          type: 'bay.annotation.created',
          version_id: annotation.version_id,
          annotation_id: annotation.id,
        });
        return reply.status(201).send({ data: annotation });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
