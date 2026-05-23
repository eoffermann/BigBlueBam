import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { requireBoardAccess, requireBoardEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as chatService from '../services/chat.service.js';

const sendMessageSchema = z.object({
  body: z.string().min(1).max(5000),
});

export default async function chatRoutes(fastify: FastifyInstance) {
  // GET /boards/:id/chat - List recent messages (limit 100)
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/chat',
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_chat.get')] },
    async (request, reply) => {
      const messages = await chatService.getMessages((request as any).board.id);
      return reply.send({ data: messages });
    },
  );

  // POST /boards/:id/chat - Send a message
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/chat',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_chat.create')] },
    async (request, reply) => {
      const { body } = sendMessageSchema.parse(request.body);
      const message = await chatService.sendMessage(
        (request as any).board.id,
        request.user!.id,
        body,
      );
      return reply.status(201).send({ data: message });
    },
  );
}
