import { z } from 'zod';

// Mirrors the route zod in apps/api/src/routes/epic.routes.ts.
export const createEpicSchema = z.object({
  name: z.string().max(255),
  description: z.string().optional(),
  color: z.string().max(7).optional(),
  start_date: z.string().optional(),
  target_date: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'closed']).default('open'),
});

export const updateEpicSchema = z.object({
  name: z.string().max(255).optional(),
  description: z.string().nullable().optional(),
  color: z.string().max(7).nullable().optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  status: z.enum(['open', 'in_progress', 'closed']).optional(),
});

export type CreateEpicInput = z.infer<typeof createEpicSchema>;
export type UpdateEpicInput = z.infer<typeof updateEpicSchema>;
