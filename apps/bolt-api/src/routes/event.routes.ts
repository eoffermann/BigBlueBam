import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { getAllEvents, getEventsBySource, getAvailableActions } from '../services/event-catalog.js';

const VALID_SOURCES = new Set([
  'bam',
  'banter',
  'beacon',
  'brief',
  'helpdesk',
  'schedule',
  'bond',
  'blast',
  'board',
  'bench',
  'bearing',
  'bill',
  'book',
  'blank',
]);

export default async function eventRoutes(fastify: FastifyInstance) {
  // GET /events — Full event catalog
  fastify.get(
    '/events',
    { preHandler: [requireAuth, shadowOnly('bolt.event.list')] },
    async (_request, reply) => {
      const events = getAllEvents();
      return reply.send({ data: events });
    },
  );

  // GET /events/:source — Events for a specific source
  fastify.get<{ Params: { source: string } }>(
    '/events/:source',
    { preHandler: [requireAuth, shadowOnly('bolt.event.get')] },
    async (request, reply) => {
      const { source } = request.params;
      if (!VALID_SOURCES.has(source)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `Invalid source: ${source}. Valid sources: ${[...VALID_SOURCES].join(', ')}`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const events = getEventsBySource(source);
      return reply.send({ data: events });
    },
  );

  // GET /actions — List all MCP tools usable as actions
  fastify.get(
    '/actions',
    { preHandler: [requireAuth, shadowOnly('bolt.action.list')] },
    async (_request, reply) => {
      const actions = getAvailableActions();
      return reply.send({ data: actions });
    },
  );
}
