import { z } from 'zod';

// Helpdesk ticket, message, and SLA schemas.

export const HelpdeskTicketStatus = z.enum([
  'new',
  'open',
  'pending',
  'on_hold',
  'resolved',
  'closed',
]);
export const HelpdeskTicketPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export const HelpdeskTicketChannel = z.enum(['email', 'web', 'api', 'chat', 'phone']);

export const createHelpdeskTicketSchema = z.object({
  subject: z.string().min(1).max(500),
  description: z.string().max(50_000),
  priority: HelpdeskTicketPriority.default('normal'),
  channel: HelpdeskTicketChannel.default('web'),
  requester_email: z.string().email(),
  requester_name: z.string().max(255).optional(),
  assignee_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
});

export const updateHelpdeskTicketSchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  status: HelpdeskTicketStatus.optional(),
  priority: HelpdeskTicketPriority.optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
});

export const createHelpdeskMessageSchema = z.object({
  ticket_id: z.string().uuid(),
  body: z.string().min(1).max(50_000),
  is_internal: z.boolean().default(false),
});

export const helpdeskSlaConfigSchema = z.object({
  first_response_minutes: z.number().int().min(1),
  resolution_minutes: z.number().int().min(1),
});

/**
 * helpdesk-api's POST /helpdesk/internal/tickets body (#305): open a ticket for a requester (found
 * or created as a helpdesk user of the org by email), for sibling services with no helpdesk
 * session (Blank form routing). helpdesk-api parses with it; callers build their body as this type.
 */
export const helpdeskInternalTicketCreateSchema = z.object({
  org_id: z.string().uuid(),
  requester_email: z.string().email().max(320),
  requester_name: z.string().min(1).max(200).optional(),
  subject: z.string().min(1).max(500),
  description: z.string().min(1).max(50_000),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  category: z.string().max(100).optional(),
});

export type HelpdeskInternalTicketCreate = z.input<typeof helpdeskInternalTicketCreateSchema>;

export type CreateHelpdeskTicketInput = z.infer<typeof createHelpdeskTicketSchema>;
export type UpdateHelpdeskTicketInput = z.infer<typeof updateHelpdeskTicketSchema>;
export type CreateHelpdeskMessageInput = z.infer<typeof createHelpdeskMessageSchema>;
export type HelpdeskSlaConfig = z.infer<typeof helpdeskSlaConfigSchema>;
