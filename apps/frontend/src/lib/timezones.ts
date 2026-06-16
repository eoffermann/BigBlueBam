/**
 * Curated, globally-distributed timezone list for the profile Timezone picker.
 *
 * Stored values are IANA zone identifiers (DST-aware, e.g. `America/Los_Angeles`)
 * — the `users.timezone` column is `varchar(50)` and the profile PATCH validates
 * `z.string().max(50)`, so every value here fits. The default is `UTC`.
 *
 * Coverage is deliberately global: northern AND southern hemispheres, far east
 * AND far west, including the half-hour offsets that matter (India, Iran). The
 * list is sorted by standard-time UTC offset so the dropdown reads top-to-bottom
 * from the date line west (−11:00) round to the date line east (+13:00), and
 * each label shows the offset next to a recognizable city.
 *
 * Offsets are STANDARD-time (winter) offsets; the label is a stable hint, not a
 * live clock — actual conversions use the IANA value and honor DST.
 */

interface TimezoneEntry {
  /** IANA zone id stored on the user. */
  value: string;
  /** Recognizable city/place shown after the offset. */
  city: string;
  /** Standard-time offset from UTC, in minutes. Used only for sorting + label. */
  offsetMinutes: number;
}

/** Source rows (order here doesn't matter — we sort by offset below). */
const ENTRIES: TimezoneEntry[] = [
  { value: 'Pacific/Pago_Pago', city: 'Pago Pago', offsetMinutes: -11 * 60 },
  { value: 'Pacific/Honolulu', city: 'Honolulu', offsetMinutes: -10 * 60 },
  { value: 'America/Anchorage', city: 'Anchorage', offsetMinutes: -9 * 60 },
  { value: 'America/Los_Angeles', city: 'Los Angeles', offsetMinutes: -8 * 60 },
  { value: 'America/Tijuana', city: 'Tijuana', offsetMinutes: -8 * 60 },
  { value: 'America/Denver', city: 'Denver', offsetMinutes: -7 * 60 },
  { value: 'America/Phoenix', city: 'Phoenix', offsetMinutes: -7 * 60 },
  { value: 'America/Chicago', city: 'Chicago', offsetMinutes: -6 * 60 },
  { value: 'America/Mexico_City', city: 'Mexico City', offsetMinutes: -6 * 60 },
  { value: 'America/New_York', city: 'New York', offsetMinutes: -5 * 60 },
  { value: 'America/Bogota', city: 'Bogotá', offsetMinutes: -5 * 60 },
  { value: 'America/Halifax', city: 'Halifax', offsetMinutes: -4 * 60 },
  { value: 'America/Santiago', city: 'Santiago', offsetMinutes: -4 * 60 },
  { value: 'America/Sao_Paulo', city: 'São Paulo', offsetMinutes: -3 * 60 },
  { value: 'America/Argentina/Buenos_Aires', city: 'Buenos Aires', offsetMinutes: -3 * 60 },
  { value: 'Atlantic/South_Georgia', city: 'South Georgia', offsetMinutes: -2 * 60 },
  { value: 'Atlantic/Azores', city: 'Azores', offsetMinutes: -1 * 60 },
  { value: 'Atlantic/Cape_Verde', city: 'Cape Verde', offsetMinutes: -1 * 60 },
  { value: 'UTC', city: 'UTC', offsetMinutes: 0 },
  { value: 'Europe/London', city: 'London', offsetMinutes: 0 },
  { value: 'Atlantic/Reykjavik', city: 'Reykjavík', offsetMinutes: 0 },
  { value: 'Europe/Paris', city: 'Paris', offsetMinutes: 60 },
  { value: 'Europe/Berlin', city: 'Berlin', offsetMinutes: 60 },
  { value: 'Africa/Lagos', city: 'Lagos', offsetMinutes: 60 },
  { value: 'Europe/Athens', city: 'Athens', offsetMinutes: 2 * 60 },
  { value: 'Africa/Cairo', city: 'Cairo', offsetMinutes: 2 * 60 },
  { value: 'Africa/Johannesburg', city: 'Johannesburg', offsetMinutes: 2 * 60 },
  { value: 'Europe/Moscow', city: 'Moscow', offsetMinutes: 3 * 60 },
  { value: 'Africa/Nairobi', city: 'Nairobi', offsetMinutes: 3 * 60 },
  { value: 'Asia/Tehran', city: 'Tehran', offsetMinutes: 3 * 60 + 30 },
  { value: 'Asia/Dubai', city: 'Dubai', offsetMinutes: 4 * 60 },
  { value: 'Asia/Karachi', city: 'Karachi', offsetMinutes: 5 * 60 },
  { value: 'Asia/Kolkata', city: 'Kolkata', offsetMinutes: 5 * 60 + 30 },
  { value: 'Asia/Dhaka', city: 'Dhaka', offsetMinutes: 6 * 60 },
  { value: 'Asia/Bangkok', city: 'Bangkok', offsetMinutes: 7 * 60 },
  { value: 'Asia/Jakarta', city: 'Jakarta', offsetMinutes: 7 * 60 },
  { value: 'Asia/Shanghai', city: 'Shanghai', offsetMinutes: 8 * 60 },
  { value: 'Asia/Singapore', city: 'Singapore', offsetMinutes: 8 * 60 },
  { value: 'Australia/Perth', city: 'Perth', offsetMinutes: 8 * 60 },
  { value: 'Asia/Tokyo', city: 'Tokyo', offsetMinutes: 9 * 60 },
  { value: 'Asia/Seoul', city: 'Seoul', offsetMinutes: 9 * 60 },
  { value: 'Australia/Adelaide', city: 'Adelaide', offsetMinutes: 9 * 60 + 30 },
  { value: 'Australia/Sydney', city: 'Sydney', offsetMinutes: 10 * 60 },
  { value: 'Australia/Brisbane', city: 'Brisbane', offsetMinutes: 10 * 60 },
  { value: 'Pacific/Guam', city: 'Guam', offsetMinutes: 10 * 60 },
  { value: 'Pacific/Noumea', city: 'Nouméa', offsetMinutes: 11 * 60 },
  { value: 'Pacific/Auckland', city: 'Auckland', offsetMinutes: 12 * 60 },
  { value: 'Pacific/Fiji', city: 'Fiji', offsetMinutes: 12 * 60 },
  { value: 'Pacific/Tongatapu', city: "Nuku'alofa", offsetMinutes: 13 * 60 },
];

/** Render minutes-from-UTC as a `UTC±HH:MM` string. */
function offsetLabel(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${h}:${m}`;
}

export interface TimezoneOption {
  value: string;
  label: string;
}

/**
 * The base option list, sorted by UTC offset ascending. Within a shared offset,
 * `UTC` floats to the front of its group; everything else is alphabetical by
 * label. Computed once at module load.
 */
export const TIMEZONE_OPTIONS: TimezoneOption[] = ENTRIES.slice()
  .sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    if (a.value === 'UTC') return -1;
    if (b.value === 'UTC') return 1;
    return a.city.localeCompare(b.city);
  })
  .map((e) => ({ value: e.value, label: `(${offsetLabel(e.offsetMinutes)}) ${e.city}` }));

/**
 * Options for a given current value. If the stored timezone isn't one of the
 * curated zones (legacy free-text, or a zone we don't list), prepend it as a
 * one-off option so the Select still shows it and editing it stays lossless.
 */
export function timezoneSelectOptions(current?: string | null): TimezoneOption[] {
  if (!current || TIMEZONE_OPTIONS.some((o) => o.value === current)) {
    return TIMEZONE_OPTIONS;
  }
  return [{ value: current, label: current }, ...TIMEZONE_OPTIONS];
}
