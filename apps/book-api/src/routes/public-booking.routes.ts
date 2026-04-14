import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as bookingPageService from '../services/booking-page.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { enrichBooking, loadOrg } from '../lib/bolt-enrich.js';

const slotsQuerySchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
});

const bookSchema = z.object({
  start_at: z.string().datetime(),
  name: z.string().min(1).max(200),
  email: z.string().email().max(255),
  notes: z.string().max(2000).optional(),
});

export default async function publicBookingRoutes(fastify: FastifyInstance) {
  // GET /meet/:slug — public booking page info
  fastify.get<{ Params: { slug: string } }>(
    '/meet/:slug',
    async (request, reply) => {
      const page = await bookingPageService.getPublicBookingPage(request.params.slug);
      return reply.send({ data: page });
    },
  );

  // GET /meet/:slug/slots — available time slots
  fastify.get<{ Params: { slug: string } }>(
    '/meet/:slug/slots',
    async (request, reply) => {
      const query = slotsQuerySchema.parse(request.query);
      const result = await bookingPageService.getPublicSlots(
        request.params.slug,
        query.start_date,
        query.end_date,
      );
      return reply.send(result);
    },
  );

  // POST /meet/:slug/book — book a time slot
  fastify.post<{ Params: { slug: string } }>(
    '/meet/:slug/book',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = bookSchema.parse(request.body);
      const event = await bookingPageService.bookSlot(
        request.params.slug,
        body.start_at,
        body.name,
        body.email,
        body.notes,
      );
      // Fire-and-forget enriched Bolt event (Phase B / Tier 1)
      // Public booking is anonymous — actor defaults to 'system'.
      Promise.all([enrichBooking(event.id), loadOrg(event.organization_id)])
        .then(([enriched, org]) => {
          publishBoltEvent(
            'booking.created',
            'book',
            {
              booking: enriched?.booking ?? {
                id: event.id,
                event_id: event.id,
                title: event.title,
                guest_name: body.name,
                guest_email: body.email,
              },
              booking_page: enriched?.booking_page ?? null,
              org,
            },
            event.organization_id,
            undefined,
            'system',
          );
        })
        .catch(() => {});
      return reply.status(201).send({ data: event });
    },
  );
}
