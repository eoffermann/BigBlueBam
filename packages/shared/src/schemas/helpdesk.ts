import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const HelpdeskTicketStatus = z.enum([
  'open',
  'in_progress',
  'waiting_on_customer',
  'resolved',
  'closed',
]);
export const HelpdeskTicketPriority = z.enum(['low', 'medium', 'high', 'critical']);
export const HelpdeskSettingsPriority = z.enum(['low', 'medium', 'high', 'critical']);

// ── Ticket schemas (customer-facing portal) ────────────────────────────
export const createHelpdeskTicketSchema = z.object({
  subject: z.string().min(1).max(500),
  description: z.string().min(1),
  category: z.string().max(100).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  idempotency_key: z.string().max(200).optional(),
});

export const createHelpdeskCustomerMessageSchema = z.object({
  body: z.string().min(1),
});

export const listHelpdeskTicketsQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  category: z.string().optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});

// ── Ticket schemas (agent side) ────────────────────────────────────────
export const updateHelpdeskTicketSchema = z.object({
  status: HelpdeskTicketStatus.optional(),
  priority: HelpdeskTicketPriority.optional(),
  category: z.string().max(100).optional(),
});

export const createHelpdeskAgentMessageSchema = z.object({
  body: z.string().min(1),
  is_internal: z.boolean().default(false),
  author_name: z.string().min(1).max(100).optional(),
  author_id: z.string().uuid().optional(),
});

// ── Auth schemas ───────────────────────────────────────────────────────
export const registerHelpdeskUserSchema = z.object({
  email: z.string().email().max(320),
  display_name: z.string().min(1).max(100),
  password: z.string().min(12).max(256),
});

export const loginHelpdeskUserSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const verifyHelpdeskEmailSchema = z.object({
  token: z.string().min(1),
});

// ── Settings schemas ───────────────────────────────────────────────────
export const updateHelpdeskSettingsSchema = z.object({
  require_email_verification: z.boolean().optional(),
  allowed_email_domains: z.array(z.string()).optional(),
  default_project_id: z.string().uuid().nullable().optional(),
  default_phase_id: z.string().uuid().nullable().optional(),
  default_priority: HelpdeskSettingsPriority.optional(),
  categories: z.array(z.string()).optional(),
  welcome_message: z.string().nullable().optional(),
  auto_close_days: z.number().int().min(0).optional(),
  notify_on_status_change: z.boolean().optional(),
  notify_on_agent_reply: z.boolean().optional(),
});
