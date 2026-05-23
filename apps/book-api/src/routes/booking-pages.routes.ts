import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as bookingPageService from '../services/booking-page.service.js';

const createBookingPageSchema = z.object({
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  duration_minutes: z.number().int().min(5).max(480).optional(),
  buffer_before_min: z.number().int().min(0).max(60).optional(),
  buffer_after_min: z.number().int().min(0).max(60).optional(),
  max_advance_days: z.number().int().min(1).max(365).optional(),
  min_notice_hours: z.number().int().min(0).max(168).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo_url: z.string().url().optional(),
  confirmation_message: z.string().max(2000).optional(),
  redirect_url: z.string().url().optional(),
  auto_create_bond_contact: z.boolean().optional(),
  auto_create_bam_task: z.boolean().optional(),
  bam_project_id: z.string().uuid().optional(),
});

const updateBookingPageSchema = createBookingPageSchema.partial().extend({
  enabled: z.boolean().optional(),
});

export default async function bookingPageRoutes(fastify: FastifyInstance) {
  // GET /booking-pages
  fastify.get(
    '/booking-pages',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await bookingPageService.listBookingPages(
        request.user!.org_id,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  // POST /booking-pages
  fastify.post(
    '/booking-pages',
    { preHandler: [requireAuth, fastify.requireCan('book.booking_page.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = createBookingPageSchema.parse(request.body);
      const page = await bookingPageService.createBookingPage(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: page });
    },
  );

  // PATCH /booking-pages/:id
  fastify.patch<{ Params: { id: string } }>(
    '/booking-pages/:id',
    { preHandler: [requireAuth, fastify.requireCan('book.booking_page.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateBookingPageSchema.parse(request.body);
      const page = await bookingPageService.updateBookingPage(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: page });
    },
  );

  // DELETE /booking-pages/:id
  fastify.delete<{ Params: { id: string } }>(
    '/booking-pages/:id',
    { preHandler: [requireAuth, fastify.requireCan('book.booking_page.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await bookingPageService.deleteBookingPage(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: { deleted: true } });
    },
  );
}
