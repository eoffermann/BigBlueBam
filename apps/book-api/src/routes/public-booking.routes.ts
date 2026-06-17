import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as bookingPageService from '../services/booking-page.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { enrichBooking, loadOrg } from '../lib/bolt-enrich.js';
import { env } from '../env.js';

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
      // Public booking is anonymous -- actor defaults to 'system'.
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

      // Auto-create Bond contact and/or Bam task based on booking page settings.
      // Both are best-effort: log and continue on failure.
      const page = await bookingPageService.getPublicBookingPage(request.params.slug);

      // Internal service-to-service auth: the shared INTERNAL_SERVICE_SECRET,
      // sent in the X-Internal-Service-Secret header. A public booking is
      // anonymous (no session / API key to forward), so the secret IS the
      // credential. The user-facing POST /v1/contacts is gated by requireAuth
      // and ignores this header — we target the secret-guarded internal route
      // instead, which carries explicit org + acting-user attribution.
      const internalHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (env.INTERNAL_SERVICE_SECRET) {
        internalHeaders['x-internal-service-secret'] = env.INTERNAL_SERVICE_SECRET;
      }

      if (page.auto_create_bond_contact !== false) {
        // Create or find a Bond contact by email (idempotent upsert). The
        // booking-page owner is the acting user — they own the calendar the
        // booking lands on.
        const bondBaseUrl = (env as unknown as Record<string, string | undefined>).BOND_API_INTERNAL_URL ?? 'http://bond-api:4009';
        fetch(`${bondBaseUrl}/v1/internal/contacts`, {
          method: 'POST',
          headers: internalHeaders,
          body: JSON.stringify({
            org_id: page.organization_id,
            acting_user_id: page.owner_user_id,
            email: body.email,
            first_name: body.name.split(' ')[0] ?? body.name,
            last_name: body.name.split(' ').slice(1).join(' ') || undefined,
            lead_source: 'booking_page',
            lifecycle_stage: 'lead',
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {
          // Best-effort: swallow errors
        });
      }

      if (page.auto_create_bam_task === true && page.bam_project_id) {
        // Create a task in the configured Bam project
        const bamBaseUrl = env.BBB_API_INTERNAL_URL;
        fetch(`${bamBaseUrl}/internal/helpdesk/tasks`, {
          method: 'POST',
          headers: internalHeaders,
          body: JSON.stringify({
            project_id: page.bam_project_id,
            title: `Follow up: ${event.title}`,
            description: `Booking by ${body.name} (${body.email}) on ${event.start_at}${body.notes ? `\n\nNotes: ${body.notes}` : ''}`,
            priority: 'medium',
            ticket_id: event.id, // reuse event ID as the linking ticket_id
            customer_email: body.email,
            customer_name: body.name,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {
          // Best-effort: swallow errors
        });
      }

      return reply.status(201).send({ data: event });
    },
  );
}
