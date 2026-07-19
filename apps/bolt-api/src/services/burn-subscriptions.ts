/**
 * The Burn dispatch subscription set (spec 8.3), split out with NO env import so the §12.1 suite
 * can assert it directly. burn-dispatch-hook.ts imports these; the hook itself pulls env for the
 * forward target.
 *
 * The 16 subscribed (source, event_type) pairs plus banter:message.posted (a 17th, conditional on
 * the per-org banter signal, gated by the per-org binding set).
 */
export const BURN_SUBSCRIPTIONS = new Set<string>([
  'bam:task.created',
  'bam:task.updated',
  'bam:task.moved',
  'bam:task.assigned',
  'bam:task.completed',
  'bam:sprint.completed',
  'helpdesk:ticket.created',
  'helpdesk:ticket.replied',
  'bill:invoice.created',
  'bill:invoice.finalized',
  'bill:recurring.invoice_generated',
  'bill:expense.created',
  'bill:expense.approved',
  'bill:rate.created',
  'bill:rate.updated',
  'bond:deal.won',
  'banter:message.posted',
]);

/** True when bolt-api should forward this (source, event_type) to Burn (spec 8.3). Pure; tested. */
export function isBurnSubscribed(source: string, eventType: string): boolean {
  return BURN_SUBSCRIPTIONS.has(`${source}:${eventType}`);
}

/** The subscription count assertion helper for §12.1 (16 + the conditional banter signal). */
export const BURN_SUBSCRIPTION_COUNT = BURN_SUBSCRIPTIONS.size;
