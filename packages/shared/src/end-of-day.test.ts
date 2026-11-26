import { describe, expect, it } from 'vitest';
import { endOfDayInTz, localDateInTz, startOfDayInTz } from './end-of-day.js';

// Spec 3.3 and 11.1: valid_until is the end of the chosen day in the org's time zone, correct
// across DST changes (a 23-hour and a 25-hour day).

describe('endOfDayInTz', () => {
  it('UTC is 23:59:59.999 on the same date', () => {
    expect(endOfDayInTz('2026-11-26', 'UTC').toISOString()).toBe('2026-11-26T23:59:59.999Z');
  });

  it('a fixed winter offset (New York, UTC-5)', () => {
    expect(endOfDayInTz('2026-01-15', 'America/New_York').toISOString()).toBe('2026-01-16T04:59:59.999Z');
  });

  it('the day clocks spring forward (New York, 2026-03-08 is 23 hours long)', () => {
    // Next midnight is EDT (UTC-4).
    expect(endOfDayInTz('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-09T03:59:59.999Z');
    const day = endOfDayInTz('2026-03-08', 'America/New_York').getTime() + 1 - startOfDayInTz('2026-03-08', 'America/New_York').getTime();
    expect(day).toBe(23 * 3_600_000);
  });

  it('the day clocks fall back (London, 2026-10-25 is 25 hours long)', () => {
    expect(endOfDayInTz('2026-10-25', 'Europe/London').toISOString()).toBe('2026-10-25T23:59:59.999Z');
    const day = endOfDayInTz('2026-10-25', 'Europe/London').getTime() + 1 - startOfDayInTz('2026-10-25', 'Europe/London').getTime();
    expect(day).toBe(25 * 3_600_000);
  });

  it('east of UTC across a year end (Pacific/Auckland, NZDT +13)', () => {
    expect(endOfDayInTz('2026-12-31', 'Pacific/Auckland').toISOString()).toBe('2026-12-31T10:59:59.999Z');
  });

  it('half-hour zones (India, +5:30)', () => {
    expect(endOfDayInTz('2026-06-01', 'Asia/Kolkata').toISOString()).toBe('2026-06-01T18:29:59.999Z');
  });

  it('an unknown zone falls back to UTC; a bad date throws', () => {
    expect(endOfDayInTz('2026-11-26', 'Not/AZone').toISOString()).toBe('2026-11-26T23:59:59.999Z');
    expect(() => endOfDayInTz('26/11/2026', 'UTC')).toThrow();
  });

  it('a skipped local midnight (DST starts AT midnight) still ends at the real day boundary (#221)', () => {
    // America/Havana 2026-03-08 00:00 -> 01:00 (UTC-5 -> UTC-4) at 05:00Z: Mar 7 runs until then.
    expect(endOfDayInTz('2026-03-07', 'America/Havana').toISOString()).toBe('2026-03-08T04:59:59.999Z');
    expect(startOfDayInTz('2026-03-08', 'America/Havana').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    // America/Santiago 2026-09-06 00:00 -> 01:00 (UTC-4 -> UTC-3) at 04:00Z.
    expect(endOfDayInTz('2026-09-05', 'America/Santiago').toISOString()).toBe('2026-09-06T03:59:59.999Z');
    // America/Santiago 2026-04-05 00:00 -> 2026-04-04 23:00 (UTC-3 -> UTC-4): Apr 4 is 25 hours.
    expect(endOfDayInTz('2026-04-04', 'America/Santiago').toISOString()).toBe('2026-04-05T03:59:59.999Z');
  });

  it('every day of 2026 ends where the next local date begins, in midnight-transition zones (#221)', () => {
    const zones = ['America/Havana', 'America/Santiago', 'Asia/Beirut', 'Africa/Cairo', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe'];
    for (const zone of zones) {
      for (let day = 0; day < 365; day++) {
        const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
        const next = new Date(Date.UTC(2026, 0, 2 + day)).toISOString().slice(0, 10);
        const end = endOfDayInTz(date, zone);
        expect(localDateInTz(end, zone), `${zone} ${date}`).toBe(date);
        expect(localDateInTz(new Date(end.getTime() + 1), zone), `${zone} ${date} +1ms`).toBe(next);
      }
    }
  });

  it('the instant reads back as the same local date', () => {
    for (const zone of ['UTC', 'America/New_York', 'Europe/London', 'Pacific/Auckland', 'Asia/Kolkata']) {
      expect(localDateInTz(endOfDayInTz('2026-03-08', zone), zone)).toBe('2026-03-08');
      expect(localDateInTz(new Date(endOfDayInTz('2026-03-08', zone).getTime() + 1), zone)).toBe('2026-03-09');
    }
  });
});
