import type { BulwarkDeadlineRule, BulwarkRecurrenceInterval } from '@bigbluebam/shared';

// Timezone-anchored deadline arithmetic (spec §4 / THEME B). PURE and unit-testable: no DB,
// no clock reads beyond what the caller passes in.
//
// Bulwark computes a `due_at` as a pure function of (deadline_rule, the legal anchor time,
// the resolved timezone). The arithmetic happens in the CONTRACT's IANA timezone, not server
// local: "within five days" of a Friday-evening Pacific event is a Pacific calendar
// computation, and a business-days rule skips weekends (and optional holidays) in that zone.
// roll_forward moves a due date that lands on a non-business day forward to the next business
// day. grace_hours is added at the end.

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

// The wall-clock parts of an instant in a given IANA timezone.
export function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl can emit "24" for midnight; normalize to 0.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// The timezone offset (ms) at a given instant, from that zone's wall clock.
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

// Convert a wall-clock time in `timeZone` to the UTC instant. Standard two-pass offset
// resolution so a DST boundary near the target time is handled.
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let utc = guess - offset;
  // One correction pass (the offset at the guessed instant may differ across a DST edge).
  const offset2 = zoneOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    utc = guess - offset;
  }
  return new Date(utc);
}

// A yyyy-mm-dd string in a fixed calendar (no zone).
function ymd(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Add N calendar days to a (year, month, day), returning the same shape. Uses UTC math on a
// date-only value so it is DST-agnostic (calendar days, not 24h periods).
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const t = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const d = new Date(t);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// 0 = Sunday .. 6 = Saturday for a date-only value.
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isBusinessDay(
  year: number,
  month: number,
  day: number,
  holidays: ReadonlySet<string>,
): boolean {
  const dow = dayOfWeek(year, month, day);
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(ymd(year, month, day));
}

// Add N business days, skipping weekends and holidays.
function addBusinessDays(
  year: number,
  month: number,
  day: number,
  count: number,
  holidays: ReadonlySet<string>,
): { year: number; month: number; day: number } {
  let cur = { year, month, day };
  let remaining = count;
  const step = count >= 0 ? 1 : -1;
  remaining = Math.abs(remaining);
  while (remaining > 0) {
    cur = addCalendarDays(cur.year, cur.month, cur.day, step);
    if (isBusinessDay(cur.year, cur.month, cur.day, holidays)) remaining--;
  }
  return cur;
}

// Roll a date forward to the next business day if it lands on a weekend/holiday.
function rollForwardToBusinessDay(
  year: number,
  month: number,
  day: number,
  holidays: ReadonlySet<string>,
): { year: number; month: number; day: number } {
  let cur = { year, month, day };
  while (!isBusinessDay(cur.year, cur.month, cur.day, holidays)) {
    cur = addCalendarDays(cur.year, cur.month, cur.day, 1);
  }
  return cur;
}

export interface ComputeDueArgs {
  anchor: Date; // the resolved legal anchor instant (trigger_at | logged_at | manual | calendar)
  rule: BulwarkDeadlineRule;
  // Optional holiday calendar (yyyy-mm-dd strings) for business-day / roll-forward math.
  holidays?: ReadonlySet<string>;
}

export interface ComputeDueResult {
  due_at: Date;
  resolved_timezone: string;
}

// The core deterministic due-date computation (spec §4.2 step 5). Interprets the anchor in
// the rule's timezone, adds the offset in calendar or business days, applies roll_forward,
// and returns the due instant (end of the target day + grace_hours) as a UTC Date.
export function computeDueAt(args: ComputeDueArgs): ComputeDueResult {
  const { anchor, rule } = args;
  const tz = rule.timezone || 'UTC';
  const holidays = args.holidays ?? new Set<string>();

  // The anchor's calendar date in the resolved timezone.
  const p = partsInZone(anchor, tz);
  let target = { year: p.year, month: p.month, day: p.day };

  const offset = rule.offset_days ?? 0;
  if (rule.unit === 'business_days') {
    target = addBusinessDays(target.year, target.month, target.day, offset, holidays);
  } else {
    target = addCalendarDays(target.year, target.month, target.day, offset);
  }

  // roll_forward: a due date landing on a non-business day rolls to the next business day.
  // (For business_days the target is already a business day, so this is a no-op unless a
  // holiday set was supplied that the add already skipped.)
  if (rule.roll_forward !== false) {
    target = rollForwardToBusinessDay(target.year, target.month, target.day, holidays);
  }

  // Due at end-of-day (23:59:59) local, so "within N days" includes all of the Nth day.
  let due = zonedWallClockToUtc(target.year, target.month, target.day, 23, 59, 59, tz);
  const grace = rule.grace_hours ?? 0;
  if (grace) due = new Date(due.getTime() + grace * 3_600_000);

  return { due_at: due, resolved_timezone: tz };
}

// Advance a date-only anchor by one recurrence interval (spec §4.3 step 4 / DI6). Used by the
// radar to roll a recurring calendar obligation forward year N -> N+1 (etc).
export function nextRecurrenceDate(
  anchorYmd: string,
  interval: BulwarkRecurrenceInterval,
): string {
  const parts = anchorYmd.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const base = new Date(Date.UTC(y, m - 1, d));
  if (interval === 'annual') base.setUTCFullYear(base.getUTCFullYear() + 1);
  else if (interval === 'quarterly') base.setUTCMonth(base.getUTCMonth() + 3);
  else base.setUTCMonth(base.getUTCMonth() + 1);
  return ymd(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

// The anchor-date string (yyyy-mm-dd) of an instant in a zone, for calendar arm keys.
export function anchorDateInZone(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return ymd(p.year, p.month, p.day);
}
