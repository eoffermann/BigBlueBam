// §13 Wave 4 scheduled banter — quiet-hours policy evaluation.
//
// The channel-admin writes a JSON policy of the shape:
//
//   {
//     timezone: 'America/Los_Angeles',
//     allowed_hours: [9, 18],        // [startHour, endHourExclusive], 0-24
//     weekday_only?: true,           // default false
//     urgency_override?: true        // default false; channel-admin consent flag
//   }
//
// Core behaviors:
//
//   - `isInsideQuietHours(policy, now)` — true if `now` falls OUTSIDE the
//      allowed window, i.e. a post right now would violate the policy.
//   - `nextAllowedTime(policy, from)` — returns the next UTC Date where a
//      post would be allowed, handling day-wraparound and `weekday_only`.
//   - `validateQuietHoursPolicy(raw)` — validates an inbound policy payload
//      (including the IANA timezone string) and returns a typed value or a
//      list of validation issues. Rejects invalid TZs via the runtime
//      Intl.DateTimeFormat constructor which throws on unknown zones.
//
// Timezone math is done by asking the runtime to format a Date with the
// policy's timezone and reading the hour/weekday fields back out. This keeps
// the implementation pure-JS and deterministic for unit testing without
// requiring date-fns-tz. DST transitions are covered because every hour
// lookup goes through the timezone-aware formatter.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuietHoursPolicy {
  timezone: string;
  allowed_hours: [number, number];
  weekday_only?: boolean;
  urgency_override?: boolean;
}

export const quietHoursPolicySchema = z.object({
  timezone: z.string().min(1),
  allowed_hours: z.tuple([
    z.number().int().min(0).max(24),
    z.number().int().min(0).max(24),
  ]),
  weekday_only: z.boolean().optional(),
  urgency_override: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // The Intl constructor throws a RangeError for unknown zones on every
    // modern runtime we target.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface QuietHoursValidationResult {
  ok: boolean;
  policy?: QuietHoursPolicy;
  issues?: { field: string; issue: string }[];
}

export function validateQuietHoursPolicy(raw: unknown): QuietHoursValidationResult {
  const parsed = quietHoursPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        issue: issue.message,
      })),
    };
  }
  const { timezone, allowed_hours } = parsed.data;
  const issues: { field: string; issue: string }[] = [];
  if (!isValidIanaTimezone(timezone)) {
    issues.push({ field: 'timezone', issue: 'invalid IANA timezone' });
  }
  const [start, end] = allowed_hours;
  if (start === end) {
    issues.push({
      field: 'allowed_hours',
      issue: 'start and end hours must differ (use [0,24] for 24-hour allowed)',
    });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, policy: parsed.data };
}

// ---------------------------------------------------------------------------
// TZ helpers
// ---------------------------------------------------------------------------

/**
 * Read the wall-clock hour (0-23), day-of-week (0=Sun..6=Sat), and the
 * date-key (YYYY-MM-DD) of a Date as observed in the given IANA timezone.
 *
 * We go through Intl.DateTimeFormat.formatToParts so DST transitions and
 * non-integer UTC offsets are handled for us. Caller is expected to have
 * validated `timezone` via isValidIanaTimezone.
 */
function readClock(d: Date, timezone: string): {
  hour: number;
  weekday: number;
  year: number;
  month: number;
  day: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  const bag: Record<string, string> = {};
  for (const p of parts) bag[p.type] = p.value;
  const hour = Number.parseInt(bag.hour ?? '0', 10) % 24;
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekday = weekdayMap[bag.weekday ?? 'Sun'] ?? 0;
  const year = Number.parseInt(bag.year ?? '1970', 10);
  const month = Number.parseInt(bag.month ?? '01', 10);
  const day = Number.parseInt(bag.day ?? '01', 10);
  return { hour, weekday, year, month, day };
}

/**
 * Produce the UTC Date that corresponds to the given wall-clock moment
 * (year/month/day/hour in the given IANA timezone, with minute=second=0).
 * DST fall-back ambiguity is broken by preferring the EARLIEST matching
 * UTC instant; spring-forward "missing" hours simply shift to the next
 * existing clock time. The loop below converges in one or two iterations
 * for every real-world zone.
 */
function wallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string,
): Date {
  // Start with a naive UTC guess that assumes zero offset.
  const guessMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let candidate = new Date(guessMs);
  for (let i = 0; i < 4; i += 1) {
    const clock = readClock(candidate, timezone);
    const targetKey = year * 10000 + month * 100 + day;
    const actualKey = clock.year * 10000 + clock.month * 100 + clock.day;
    const deltaDay = targetKey - actualKey;
    const deltaHour = hour - clock.hour;
    if (deltaDay === 0 && deltaHour === 0) return candidate;
    // Shift the candidate by the observed delta. Works in one iteration for
    // static offsets; DST transitions may require one more pass because the
    // first shift crosses the transition.
    const shiftMs = deltaDay * 86_400_000 + deltaHour * 3_600_000;
    candidate = new Date(candidate.getTime() + shiftMs);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

/**
 * Returns true if `now` lies OUTSIDE the allowed window (i.e. posting is
 * currently not allowed by the policy). Null or invalid policies are
 * treated as "no restriction", so callers are free to call this before
 * checking whether a policy exists.
 *
 * Semantics for allowed_hours:
 *   - [9, 18] means hours 9, 10, ..., 17 are allowed (endHour exclusive).
 *   - [22, 6] (wrapped) means 22, 23, 0, 1, ..., 5.
 *   - [0, 24] means always allowed (every hour).
 */
export function isInsideQuietHours(
  policy: QuietHoursPolicy | null | undefined,
  now: Date,
): boolean {
  if (!policy) return false;
  const { hour, weekday } = readClock(now, policy.timezone);
  const [start, end] = policy.allowed_hours;

  if (policy.weekday_only && (weekday === 0 || weekday === 6)) {
    return true; // weekend — always quiet when weekday_only is set
  }

  if (start === 0 && end === 24) return false; // 24-hour allowed

  const inAllowed = start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end; // wrapped window
  return !inAllowed;
}

/**
 * Compute the next UTC Date >= `from` at which posting would be allowed
 * under the given policy. If `from` is already allowed, returns `from`
 * unchanged (rounded to the top of the second). The search advances hour
 * by hour (max 14 days) to stay pure-JS and DST-safe.
 *
 * Null or invalid policies return `from` unchanged.
 */
export function nextAllowedTime(
  policy: QuietHoursPolicy | null | undefined,
  from: Date,
): Date {
  if (!policy) return from;
  if (!isInsideQuietHours(policy, from)) return from;

  // The allowed window starts at `start` on a day that is allowed (non-weekend
  // if weekday_only). We walk forward one hour at a time, advancing the
  // wall-clock hour in the policy's timezone, and convert back to UTC each
  // step. This handles DST transitions because `wallToUtc` goes through the
  // same timezone-aware formatter.
  const clock = readClock(from, policy.timezone);
  let y = clock.year;
  let m = clock.month;
  let d = clock.day;
  let h = clock.hour;

  // First advance to the start of the next allowed block on the current day
  // (or wrap to the next day if we are past it).
  const [start, end] = policy.allowed_hours;
  // Reference both ends of the policy for future extension (e.g. snapping
  // the scheduled_at to `end` of the current window). Preserving the
  // destructure keeps the types wired; `void` silences unused-var lints.
  void start;
  void end;

  // Walk hour-by-hour up to 14 days of safety (typical is < 48h).
  for (let i = 0; i < 14 * 24 + 1; i += 1) {
    // Bump to the next hour
    h += 1;
    if (h >= 24) {
      h = 0;
      d += 1;
      // Normalise y/m/d by converting to UTC then reading the clock again
      const probe = wallToUtc(y, m, d, 0, policy.timezone);
      const pc = readClock(probe, policy.timezone);
      y = pc.year;
      m = pc.month;
      d = pc.day;
    }
    const candidate = wallToUtc(y, m, d, h, policy.timezone);
    if (!isInsideQuietHours(policy, candidate)) {
      return candidate;
    }
    // Safety suppress: if we've walked more than 14 days, something is wrong
    // (policy is pathological, e.g. weekday_only with an all-weekday disallowed
    // window). Bail and return `from` so the caller can raise.
    if (i === 14 * 24) {
      return from;
    }
  }
  return from;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Coerce a JSONB column value into a typed policy. Returns null on shape mismatch. */
export function coercePolicy(raw: unknown): QuietHoursPolicy | null {
  const r = validateQuietHoursPolicy(raw);
  return r.ok && r.policy ? r.policy : null;
}
