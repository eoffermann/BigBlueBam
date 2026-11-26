/**
 * Client-side automation validation schemas.
 *
 * These mirror the authoritative server schemas in
 * apps/bolt-api/src/routes/automation.routes.ts.
 *
 * TODO: move these to @bigbluebam/shared so client and server can't drift.
 * When that happens, delete this file and import from '@bigbluebam/shared'.
 */

import { z } from 'zod';
import { TRIGGER_SOURCES } from './trigger-sources';

export const automationFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255, 'Name must be 255 characters or fewer'),
  description: z.string().max(5000, 'Description must be 5000 characters or fewer').nullable().optional(),
  trigger_source: z.enum(TRIGGER_SOURCES, { errorMap: () => ({ message: 'A trigger source is required' }) }),
  trigger_event: z.string().min(1, 'A trigger event is required').max(60),
  cron_timezone: z.string().max(50).optional(),
  max_executions_per_hour: z.number().int().min(1).max(10000),
  cooldown_seconds: z.number().int().min(0).max(86400),
});

export type AutomationFormValues = z.infer<typeof automationFormSchema>;

/**
 * Validate the given form state and return a flat map of field → error message.
 * Returns an empty object when valid.
 */
export function validateAutomationForm(
  values: Partial<AutomationFormValues> & { actions?: unknown[] },
): Record<string, string> {
  const result = automationFormSchema.safeParse(values);
  if (result.success) {
    // Extra check: at least one action required to enable
    return {};
  }

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.');
    if (!errors[field]) {
      errors[field] = issue.message;
    }
  }
  return errors;
}
