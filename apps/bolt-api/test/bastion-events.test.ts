import { describe, expect, it } from 'vitest';
import { BASTION_EVENT_TYPES } from '@bigbluebam/shared';
import { getEventsBySource } from '../src/services/event-catalog.js';
import {
  BASTION_FEED_BINDINGS_KEY,
  BASTION_SUBSCRIPTION_COUNT,
  isBastionFeedCandidate,
  isBastionSubscribed,
} from '../src/services/bastion-subscriptions.js';

/**
 * Bastion spec 8.1: the catalog's bastionEvents set equals BASTION_EVENT_TYPES (so a name in code
 * and a name in the catalog cannot drift), and every payload is refs and scalars only.
 */
describe('Bastion events (spec 8.1)', () => {
  const events = getEventsBySource('bastion');

  it('BASTION_EVENT_TYPES equals the bastionEvents set in the catalog', () => {
    expect(events.map((e) => e.event_type).sort()).toEqual([...BASTION_EVENT_TYPES].sort());
    expect(events).toHaveLength(24);
  });

  it('every payload is refs and scalars: no names, emails, labels or free text', () => {
    const forbidden = /(^|[._])(name|email|label|title|body|text|content|summary_text|display_name)$/i;
    for (const ev of events) {
      for (const f of ev.payload_schema) {
        expect(f.name, `${ev.event_type}.${f.name}`).not.toMatch(forbidden);
        expect(['uuid', 'string', 'number', 'boolean']).toContain(f.type);
      }
      expect(ev.payload_schema.some((f) => f.name === 'org_id'), ev.event_type).toBe(true);
    }
  });
});

describe('Bastion dispatch subscriptions (spec 8.2)', () => {
  it('statically consumes only platform proposal.decided', () => {
    expect(BASTION_SUBSCRIPTION_COUNT).toBe(1);
    expect(isBastionSubscribed('platform', 'proposal.decided')).toBe(true);
    expect(isBastionSubscribed('bill', 'expense.created')).toBe(false);
  });

  it('never treats its own events as feed input, and keys feed bindings per org', () => {
    expect(isBastionFeedCandidate('bastion')).toBe(false);
    expect(isBastionFeedCandidate('bond')).toBe(true);
    expect(BASTION_FEED_BINDINGS_KEY('o1')).toBe('bastion:feed-bindings:o1');
  });
});
