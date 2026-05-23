import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as calendarService from '../services/calendar.service.js';

const createCalendarSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  calendar_type: z.enum(['personal', 'team', 'project', 'booking']).optional(),
  timezone: z.string().max(50).optional(),
  project_id: z.string().uuid().optional(),
});

const updateCalendarSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().max(50).optional(),
});

const listQuerySchema = z.object({
  calendar_type: z.string().optional(),
});

export default async function calendarRoutes(fastify: FastifyInstance) {
  // GET /calendars
  fastify.get(
    '/calendars',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await calendarService.listCalendars({
        organization_id: request.user!.org_id,
        user_id: request.user!.id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /calendars
  fastify.post(
    '/calendars',
    { preHandler: [requireAuth, fastify.requireCan('book.calendar.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = createCalendarSchema.parse(request.body);
      const calendar = await calendarService.createCalendar(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: calendar });
    },
  );

  // PATCH /calendars/:id
  fastify.patch<{ Params: { id: string } }>(
    '/calendars/:id',
    { preHandler: [requireAuth, fastify.requireCan('book.calendar.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateCalendarSchema.parse(request.body);
      const calendar = await calendarService.updateCalendar(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: calendar });
    },
  );

  // DELETE /calendars/:id
  fastify.delete<{ Params: { id: string } }>(
    '/calendars/:id',
    { preHandler: [requireAuth, fastify.requireCan('book.calendar.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await calendarService.deleteCalendar(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );
}
