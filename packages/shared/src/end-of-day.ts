// endOfDayInTz: the last instant of a calendar date in an IANA time zone.
//
// Bastion stores evidence expiry (`valid_until`) as an instant, but people pick a DATE ("valid
// until 2026-12-08"). The date means "through the end of that day where the organization works",
// so the stored instant is the last millisecond before the next local midnight. Computing it from
// a fixed UTC offset is wrong twice a year: across a DST change the day is 23 or 25 hours long.
// This helper is the one place that converts; the API, the expiry job and the SPA all call it.
//
// Pure (Intl only, no node imports), so it is safe in the browser-facing barrel.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (local = utc + offset). */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - wholeSeconds;
}

/** The UTC instant of local midnight at the START of the given local date in `timeZone`. */
export function startOfDayInTz(date: string, timeZone: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Not a calendar date: ${date}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Two passes: the offset at the guess can differ from the offset at the answer near a change.
  let t = guess - tzOffsetMs(new Date(guess), timeZone);
  t = guess - tzOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

/**
 * The last millisecond of `date` (YYYY-MM-DD) in `timeZone`: one millisecond before the next local
 * midnight. An unknown zone falls back to UTC rather than throwing.
 */
export function endOfDayInTz(date: string, timeZone: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Not a calendar date: ${date}`);
  let zone = timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const nextDate = next.toISOString().slice(0, 10);
  return new Date(startOfDayInTz(nextDate, zone).getTime() - 1);
}

/** The local calendar date (YYYY-MM-DD) of an instant in `timeZone` (UTC on a bad zone). */
export function localDateInTz(instant: Date, timeZone: string): string {
  let zone = timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
