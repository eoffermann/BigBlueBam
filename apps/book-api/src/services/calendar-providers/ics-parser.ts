/**
 * Minimal, dependency-free RFC 5545 (iCalendar) VEVENT parser.
 *
 * Handles the subset Book needs to mirror an external feed: line unfolding,
 * UID / SUMMARY / DESCRIPTION / LOCATION / STATUS, and DTSTART / DTEND in the
 * three forms feeds use in the wild:
 *   - UTC:            DTSTART:20260617T140000Z
 *   - floating/local: DTSTART:20260617T140000          (treated as UTC)
 *   - all-day DATE:   DTSTART;VALUE=DATE:20260617
 * Plus value-text unescaping (\\, \, \; \n). TZID is parsed off the property
 * name but the offset is not resolved — local/TZID times are treated as UTC,
 * which is correct for UTC feeds and a documented best-effort for the rest
 * (the common case for the public holiday/team feeds this targets).
 */

import type { NormalizedEvent } from './types.js';

/** Unfold RFC 5545 folded lines: a CRLF (or LF) followed by a space/tab is a
 *  continuation of the previous line. */
function unfold(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out: string[] = [];
  for (const line of normalized.split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Split "DTSTART;TZID=Europe/London;VALUE=DATE-TIME:20260617T140000" into
 *  { name, params, value }. */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(';');
  const name = parts[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq !== -1) {
      params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
  }
  return { name, params, value };
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Parse an iCal date/date-time value into a JS Date + all-day flag. */
function parseIcalDate(value: string, params: Record<string, string>): { date: Date; allDay: boolean } | null {
  const isDate = params.VALUE === 'DATE' || /^\d{8}$/.test(value);
  if (isDate) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    // All-day: anchor at midnight UTC.
    const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
    return Number.isNaN(d.getTime()) ? null : { date: d, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  // Z (UTC) or no suffix (floating/TZID) — both treated as UTC. Resolving real
  // TZID offsets is a documented follow-up; UTC feeds (the common case) are exact.
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return Number.isNaN(d.getTime()) ? null : { date: d, allDay: false };
}

/**
 * Parse an .ics document into normalized events. Malformed VEVENTs (missing
 * UID, unparseable/zero-length time range) are skipped rather than throwing —
 * one bad event must not poison a whole feed sync.
 */
export function parseIcs(raw: string): NormalizedEvent[] {
  const lines = unfold(raw);
  const events: NormalizedEvent[] = [];

  let inEvent = false;
  let cur: Partial<{
    uid: string;
    summary: string;
    description: string;
    location: string;
    status: string;
    transp: string;
    dtstart: { date: Date; allDay: boolean };
    dtend: { date: Date; allDay: boolean };
  }> = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (cur.uid && cur.dtstart && cur.summary) {
        // Default DTEND when absent: all-day -> +1 day, timed -> +1 hour.
        let end = cur.dtend;
        if (!end) {
          const startMs = cur.dtstart.date.getTime();
          const delta = cur.dtstart.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
          end = { date: new Date(startMs + delta), allDay: cur.dtstart.allDay };
        }
        if (end.date.getTime() > cur.dtstart.date.getTime()) {
          const status = (cur.status ?? 'CONFIRMED').toUpperCase();
          events.push({
            externalId: cur.uid,
            title: cur.summary,
            startAt: cur.dtstart.date,
            endAt: end.date,
            allDay: cur.dtstart.allDay,
            description: cur.description,
            location: cur.location,
            visibility: cur.transp === 'TRANSPARENT' ? 'free' : 'busy',
            status:
              status === 'CANCELLED'
                ? 'cancelled'
                : status === 'TENTATIVE'
                  ? 'tentative'
                  : 'confirmed',
          });
        }
      }
      cur = {};
      continue;
    }
    if (!inEvent) continue;

    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    switch (name) {
      case 'UID':
        cur.uid = value.trim();
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(value).slice(0, 500);
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(value);
        break;
      case 'LOCATION':
        cur.location = unescapeText(value);
        break;
      case 'STATUS':
        cur.status = value.trim();
        break;
      case 'TRANSP':
        cur.transp = value.trim().toUpperCase();
        break;
      case 'DTSTART': {
        const d = parseIcalDate(value.trim(), params);
        if (d) cur.dtstart = d;
        break;
      }
      case 'DTEND': {
        const d = parseIcalDate(value.trim(), params);
        if (d) cur.dtend = d;
        break;
      }
      default:
        break;
    }
  }

  return events;
}
