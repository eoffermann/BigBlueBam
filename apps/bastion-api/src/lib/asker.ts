// `asker_user_id` on detail-bearing reads (spec 2.8, 5.4; #217): when an agent reads for a person,
// the answer is the INTERSECTION of what the bearer and the asker may see. It narrows, never
// widens (the bursar-tools.ts rule). A malformed value is refused rather than ignored, so a typo
// never silently returns the bearer's wider view.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function askerUserIdOf(query: unknown): string | 'invalid' | null {
  const raw = (query as { asker_user_id?: unknown } | undefined)?.asker_user_id;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) return 'invalid';
  return raw.toLowerCase();
}
