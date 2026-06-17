import { describe, it, expect } from 'vitest';
import { parseIcs } from '../src/services/calendar-providers/ics-parser.js';

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:event-1@example.com',
  'SUMMARY:Rescue Watch Alpha',
  'DESCRIPTION:First smoke event',
  'LOCATION:Lagoon',
  'DTSTART:20260620T180000Z',
  'DTEND:20260620T190000Z',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event-2@example.com',
  'SUMMARY:All Day Radio Window',
  'DTSTART;VALUE=DATE:20260621',
  'DTEND;VALUE=DATE:20260622',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcs', () => {
  it('parses a timed VEVENT with UTC DTSTART/DTEND', () => {
    const events = parseIcs(FEED);
    const ev = events.find((e) => e.externalId === 'event-1@example.com');
    expect(ev).toBeDefined();
    expect(ev!.title).toBe('Rescue Watch Alpha');
    expect(ev!.description).toBe('First smoke event');
    expect(ev!.location).toBe('Lagoon');
    expect(ev!.allDay).toBe(false);
    expect(ev!.startAt.toISOString()).toBe('2026-06-20T18:00:00.000Z');
    expect(ev!.endAt.toISOString()).toBe('2026-06-20T19:00:00.000Z');
    expect(ev!.status).toBe('confirmed');
  });

  it('parses an all-day VEVENT with VALUE=DATE', () => {
    const events = parseIcs(FEED);
    const ev = events.find((e) => e.externalId === 'event-2@example.com');
    expect(ev).toBeDefined();
    expect(ev!.allDay).toBe(true);
    expect(ev!.startAt.toISOString()).toBe('2026-06-21T00:00:00.000Z');
  });

  it('handles RFC 5545 folded lines', () => {
    const folded = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:folded@example.com',
      'SUMMARY:A very long title that is',
      '  folded across two lines',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(folded);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('A very long title that is folded across two lines');
  });

  it('unescapes text values (comma, semicolon, newline, backslash)', () => {
    const esc = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:esc@example.com',
      'SUMMARY:Lunch\\, then meeting\\; bring notes\\nand a pen',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(esc);
    expect(events[0]!.title).toBe('Lunch, then meeting; bring notes\nand a pen');
  });

  it('marks cancelled and tentative statuses', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:c@example.com',
      'SUMMARY:Cancelled one',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'STATUS:CANCELLED',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:t@example.com',
      'SUMMARY:Tentative one',
      'DTSTART:20260601T110000Z',
      'DTEND:20260601T120000Z',
      'STATUS:TENTATIVE',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(feed);
    expect(events.find((e) => e.externalId === 'c@example.com')!.status).toBe('cancelled');
    expect(events.find((e) => e.externalId === 't@example.com')!.status).toBe('tentative');
  });

  it('skips malformed VEVENTs (missing UID or summary) without throwing', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:No UID here',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:good@example.com',
      'SUMMARY:Valid',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(feed);
    expect(events).toHaveLength(1);
    expect(events[0]!.externalId).toBe('good@example.com');
  });

  it('defaults DTEND when absent (timed +1h, all-day +1d)', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:noend@example.com',
      'SUMMARY:No end',
      'DTSTART:20260601T090000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(feed);
    expect(events[0]!.endAt.toISOString()).toBe('2026-06-01T10:00:00.000Z');
  });
});
