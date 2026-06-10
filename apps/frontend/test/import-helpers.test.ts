import { describe, it, expect } from 'vitest';
import {
  serializeValueMap,
  seedPriorityGuesses,
  seedPhaseGuesses,
  PASSTHROUGH,
  LEAVE_UNSET,
} from '@/components/import/value-map-editor';
import { serializeLinkMappings } from '@/components/import/links-mapping-panel';
import { normalizeSheet, distinctColumnValues } from '@/components/import/csv-parse';

describe('serializeValueMap', () => {
  it('maps concrete values, drops passthrough, nulls leave-unset', () => {
    const out = serializeValueMap({
      P0: 'critical',
      P1: 'high',
      P4: LEAVE_UNSET,
      Weird: PASSTHROUGH,
    });
    expect(out).toEqual({ P0: 'critical', P1: 'high', P4: null });
    expect('Weird' in out).toBe(false);
  });

  it('returns empty object when everything is passthrough', () => {
    expect(serializeValueMap({ a: PASSTHROUGH, b: PASSTHROUGH })).toEqual({});
  });
});

describe('seedPriorityGuesses', () => {
  it('maps P0..P4 and named priorities', () => {
    const seeded = seedPriorityGuesses([
      { value: 'P0' },
      { value: 'P1' },
      { value: 'P2' },
      { value: 'P3' },
      { value: 'P4' },
      { value: 'Highest' },
      { value: 'Lowest' },
      { value: 'banana' },
    ]);
    expect(seeded.P0).toBe('critical');
    expect(seeded.P1).toBe('high');
    expect(seeded.P2).toBe('medium');
    expect(seeded.P3).toBe('low');
    expect(seeded.P4).toBe(LEAVE_UNSET);
    expect(seeded.Highest).toBe('critical');
    expect(seeded.Lowest).toBe('low');
    expect(seeded.banana).toBe(PASSTHROUGH);
  });

  it('is case-insensitive after trim', () => {
    const seeded = seedPriorityGuesses([{ value: '  HIGH  ' }]);
    expect(seeded['  HIGH  ']).toBe('high');
  });
});

describe('seedPhaseGuesses', () => {
  it('exact case-insensitive match to an existing phase, else passthrough', () => {
    const seeded = seedPhaseGuesses(
      [{ value: 'in progress' }, { value: 'Backlog' }, { value: 'WIP' }],
      [{ value: 'In Progress' }, { value: 'Backlog' }],
    );
    expect(seeded['in progress']).toBe('In Progress');
    expect(seeded.Backlog).toBe('Backlog');
    expect(seeded.WIP).toBe(PASSTHROUGH);
  });
});

describe('serializeLinkMappings', () => {
  it('emits one entry per column, label trimmed to null when empty', () => {
    const out = serializeLinkMappings(
      ['Spec Doc', 'Design'],
      {
        'Spec Doc': { column: 'Spec Doc', label: '  Spec  ', fetch_title: false },
        Design: { column: 'Design', label: '', fetch_title: true },
      },
    );
    expect(out).toEqual([
      { column: 'Spec Doc', label: 'Spec', fetch_title: false },
      { column: 'Design', label: null, fetch_title: true },
    ]);
  });

  it('defaults missing config to label:null, fetch_title:false', () => {
    expect(serializeLinkMappings(['X'], {})).toEqual([
      { column: 'X', label: null, fetch_title: false },
    ]);
  });
});

describe('normalizeSheet', () => {
  it('drops a leading blank column (empty header + all cells empty)', () => {
    const out = normalizeSheet({
      headers: ['', 'Feature', 'Status'],
      rows: [
        { '': '', Feature: 'Login', Status: 'WIP' },
        { '': '', Feature: 'Signup', Status: 'Done' },
      ],
    });
    expect(out.headers).toEqual(['Feature', 'Status']);
    expect(out.rows).toEqual([
      { Feature: 'Login', Status: 'WIP' },
      { Feature: 'Signup', Status: 'Done' },
    ]);
  });

  it('keeps an empty-header column that has data', () => {
    const out = normalizeSheet({
      headers: ['', 'Feature'],
      rows: [{ '': 'x', Feature: 'Login' }],
    });
    expect(out.headers).toContain('Feature');
    expect(out.headers).toHaveLength(2);
  });

  it('drops fully-empty rows', () => {
    const out = normalizeSheet({
      headers: ['Feature'],
      rows: [{ Feature: 'Login' }, { Feature: '   ' }, { Feature: 'Signup' }],
    });
    expect(out.rows).toEqual([{ Feature: 'Login' }, { Feature: 'Signup' }]);
  });

  it('de-dupes repeated headers as "Name (2)"', () => {
    const out = normalizeSheet({
      headers: ['Name', 'Name'],
      rows: [{ Name: 'a' }],
    });
    expect(out.headers).toEqual(['Name', 'Name (2)']);
  });
});

describe('distinctColumnValues', () => {
  it('counts distinct trimmed non-empty values, sorted by count desc', () => {
    const out = distinctColumnValues(
      [
        { Prio: 'P1' },
        { Prio: ' P1 ' },
        { Prio: 'P0' },
        { Prio: '' },
        { Prio: 'P0' },
        { Prio: 'P0' },
      ],
      'Prio',
    );
    expect(out).toEqual([
      { value: 'P0', count: 3 },
      { value: 'P1', count: 2 },
    ]);
  });
});
