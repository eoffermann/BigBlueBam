import { describe, expect, it } from 'vitest';
import { suiteLinkId, suiteLinkRef } from './suite-links.js';

const ID = '0b5e0000-0000-4000-8000-00000000b001';

describe('suiteLinkRef (#232, #239)', () => {
  it('bin: the asset page, a ?asset= link, or a bare id', () => {
    expect(suiteLinkRef(`https://bigbluebam.example/bin/assets/${ID}`, 'bin')).toEqual({ id: ID });
    expect(suiteLinkRef(`https://host/bin/?asset=${ID}`, 'bin')).toEqual({ id: ID });
    expect(suiteLinkRef(ID.toUpperCase(), 'bin')).toEqual({ id: ID });
    expect(suiteLinkRef(`https://host/bolt/automations/${ID}`, 'bin')).toBeNull();
  });

  it('bolt: an automation link (with or without /executions) or a bare id', () => {
    expect(suiteLinkRef(`https://bigbluebam.example/bolt/automations/${ID}`, 'bolt')).toEqual({ id: ID });
    expect(suiteLinkRef(`/bolt/automations/${ID}/executions?x=1#y`, 'bolt')).toEqual({ id: ID });
    expect(suiteLinkRef(ID, 'bolt')).toEqual({ id: ID });
    for (const bad of ['', 'not a link', 'https://host/bolt/automations/new', 'https://host/bolt/executions/abc', `https://host/beacon/${ID}`]) {
      expect(suiteLinkRef(bad, 'bolt'), bad).toBeNull();
    }
  });

  it('beacon: the slug link Beacon shows, the id link, the edit page, or a bare id', () => {
    expect(suiteLinkRef('https://bigbluebam.example/beacon/island-information-security-policy', 'beacon')).toEqual({
      slug: 'island-information-security-policy',
    });
    expect(suiteLinkRef('/beacon/island-information-security-policy/edit', 'beacon')).toEqual({ slug: 'island-information-security-policy' });
    expect(suiteLinkRef(`https://example.test/beacon/${ID.toUpperCase()}?x=1`, 'beacon')).toEqual({ id: ID });
    expect(suiteLinkRef(ID, 'beacon')).toEqual({ id: ID });
    for (const bad of ['', 'not a link', 'island-information-security-policy', 'https://host/beacon/search', 'https://host/beacon/', 'https://host/beacon/a b!']) {
      expect(suiteLinkRef(bad, 'beacon'), bad).toBeNull();
    }
  });

  it('suiteLinkId answers ids only', () => {
    expect(suiteLinkId(`/beacon/${ID}`, 'beacon')).toBe(ID);
    expect(suiteLinkId('/beacon/some-slug', 'beacon')).toBeNull();
  });
});
