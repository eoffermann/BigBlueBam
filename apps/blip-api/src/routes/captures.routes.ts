/**
 * Blip capture URL route (Blip §23.2, §15). Mints a short-TTL presigned GET URL
 * for a stored screen capture (or its thumbnail). `:ref` is the object key,
 * either base64url-encoded or a raw (URL-encoded) key path. The key is verified
 * to live under the caller's org prefix before any URL is minted, so a ref can
 * never reach into another org's bucket namespace.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import { getDriver } from '../lib/storage.js';
import { ForbiddenError, ValidationError } from '../services/errors.js';

const PRESIGN_TTL_SEC = 900;

export default async function capturesRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { ref: string }; Querystring: { thumb?: string } }>(
    '/captures/:ref/url',
    { preHandler: [requireAuth, fastify.requireCan('blip.entry.read')] },
    async (request, reply) => {
      try {
        const prefix = `${request.user!.active_org_id}/blip/`;

        // Accept either a base64url-encoded key or a raw (URL-encoded) key path.
        let objectKey = '';
        try {
          objectKey = Buffer.from(request.params.ref, 'base64url').toString('utf8');
        } catch {
          objectKey = '';
        }
        if (!objectKey.startsWith(prefix)) {
          const decoded = (() => {
            try {
              return decodeURIComponent(request.params.ref);
            } catch {
              return request.params.ref;
            }
          })();
          if (decoded.startsWith(prefix)) objectKey = decoded;
        }
        if (!objectKey.startsWith(prefix)) {
          throw new ForbiddenError('Capture reference is not within your organization');
        }

        // Optional thumbnail variant: <index>.jpg -> <index>.thumb.jpg.
        if (request.query.thumb === '1' || request.query.thumb === 'true') {
          if (objectKey.endsWith('.jpg') && !objectKey.endsWith('.thumb.jpg')) {
            objectKey = `${objectKey.slice(0, -'.jpg'.length)}.thumb.jpg`;
          }
        }

        const driver = getDriver();
        if (!driver.presignGet) {
          throw new ValidationError('Storage driver does not support presigned URLs');
        }
        const url = await driver.presignGet(objectKey, PRESIGN_TTL_SEC);
        return reply.send({ data: { url, expires_in: PRESIGN_TTL_SEC } });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
