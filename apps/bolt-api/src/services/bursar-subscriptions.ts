/**
 * The Bursar dispatch subscription set (spec 16.2), split out with NO env import so the suite can
 * assert it directly. bursar-dispatch-hook.ts imports these; the hook itself pulls env for the
 * forward target.
 *
 * Bursar consumes bill expense events into spend and braid profile.merged to re-point the golden
 * braid_profile_id on its rows. invoice.paid and payment.recorded are DELIBERATELY EXCLUDED because
 * they are money-in signals (spec 16.2) and Bursar is a spend-side app.
 */
export const BURSAR_SUBSCRIPTIONS = new Set<string>([
  'bill:expense.created',
  'bill:expense.approved',
  'braid:profile.merged',
]);

/** True when bolt-api should forward this (source, event_type) to Bursar (spec 16.2). Pure; tested. */
export function isBursarSubscribed(source: string, eventType: string): boolean {
  return BURSAR_SUBSCRIPTIONS.has(`${source}:${eventType}`);
}

/** The subscription count assertion helper (3 hard subscriptions). */
export const BURSAR_SUBSCRIPTION_COUNT = BURSAR_SUBSCRIPTIONS.size;
