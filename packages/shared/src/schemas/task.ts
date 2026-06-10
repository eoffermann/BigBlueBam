import { z } from 'zod';
import { PRIORITIES } from '../constants/index.js';
import { uuidSchema, isoDateSchema } from './common.js';

// http(s)-only URL: the URL constructor (z.string().url()) also accepts
// javascript:, data:, file:, etc., which would become a stored-XSS primitive
// the moment the §4.2 UI renders an "open" link. Restrict to http/https.
const httpUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u.trim()), {
    message: 'URL must be http(s)',
  });

// CSV-import plan Phase 0 (§4.1): canonical stored shape of one task link.
// Cap of 50 links per task and URL de-dupe are enforced in the API service.
export const taskLinkSchema = z.object({
  id: z.string().uuid(),
  url: httpUrlSchema,
  title: z.string().max(500).nullable(), // null = "untitled / pending fetch"
  title_source: z.enum(['user', 'fetched', 'none']).default('none'),
  added_at: z.string().datetime(),
  added_by: z.string().uuid().nullable(),
});

export type TaskLink = z.infer<typeof taskLinkSchema>;

// Wire shape for create/update: clients send url (+ optional title); the
// service stamps id / added_at / added_by and derives title_source. Fully
// stamped links (round-tripped from a GET) are accepted unchanged.
// Note: id / title_source / added_at / added_by are accepted on the wire for
// round-trips but are NOT trusted — the API service restamps them server-side
// (added_by = actor, added_at = now) unless the link id matches one already
// stored on the task. See normalizeTaskLinks.
export const taskLinkInputSchema = z.object({
  url: httpUrlSchema,
  title: z.string().max(500).nullable().optional(),
  id: uuidSchema.optional(),
  title_source: z.enum(['user', 'fetched', 'none']).optional(),
  added_at: z.string().datetime().optional(),
  added_by: uuidSchema.nullable().optional(),
});

export type TaskLinkInput = z.infer<typeof taskLinkInputSchema>;

export const createTaskSchema = z.object({
  title: z.string().max(500),
  description: z.string().optional(),
  phase_id: uuidSchema,
  state_id: uuidSchema.optional(),
  sprint_id: uuidSchema.nullable().optional(),
  assignee_id: uuidSchema.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  story_points: z.number().int().positive().nullable().optional(),
  time_estimate_minutes: z.number().int().positive().nullable().optional(),
  start_date: isoDateSchema.nullable().optional(),
  due_date: isoDateSchema.nullable().optional(),
  label_ids: z.array(uuidSchema).optional(),
  epic_id: uuidSchema.nullable().optional(),
  parent_task_id: uuidSchema.nullable().optional(),
  custom_fields: z.record(z.unknown()).optional(),
  links: z.array(taskLinkInputSchema).optional(),
});

export const updateTaskSchema = createTaskSchema.partial();

export const moveTaskSchema = z.object({
  phase_id: uuidSchema,
  position: z.number(),
  sprint_id: uuidSchema.nullable().optional(),
});

export const bulkUpdateSchema = z.object({
  task_ids: z.array(uuidSchema).max(100),
  operation: z.enum(['update', 'move', 'delete']),
  fields: z.record(z.unknown()).optional(),
});
