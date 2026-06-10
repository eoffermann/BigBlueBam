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
import {
  inferCustomFieldType,
  serializeCustomFieldMappings,
} from '@/components/import/custom-field-infer';
import { buildErrorReportCsv, parseImportErrors } from '@/components/import/error-report';

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

describe('inferCustomFieldType', () => {
  const col = (values: string[]) => values.map((v) => ({ Cell: v }));

  it('infers number for all-numeric columns (incl. $, %, commas)', () => {
    expect(inferCustomFieldType(col(['$1,200', '85%', '-3.5', '42']), 'Cell')).toBe('number');
  });

  it('infers date for ISO / locale / word dates', () => {
    expect(inferCustomFieldType(col(['2026-06-09', '2026/1/1']), 'Cell')).toBe('date');
    expect(inferCustomFieldType(col(['03/04/2026', '12/25/2026']), 'Cell')).toBe('date');
    expect(inferCustomFieldType(col(['June 9, 2026', 'Jan 1, 2025']), 'Cell')).toBe('date');
  });

  it('infers checkbox for all TRUE/FALSE-ish values', () => {
    expect(inferCustomFieldType(col(['TRUE', 'false', 'yes', 'no', 'x', '1', '0']), 'Cell')).toBe(
      'checkbox',
    );
  });

  it('infers multi_select for low-cardinality comma lists', () => {
    expect(
      inferCustomFieldType(col(['A,B', 'B,C', 'A,C', 'A,B,C']), 'Cell'),
    ).toBe('multi_select');
  });

  it('infers select for a small repeated distinct set', () => {
    expect(
      inferCustomFieldType(col(['High', 'Low', 'High', 'Medium', 'Low', 'High']), 'Cell'),
    ).toBe('select');
  });

  it('falls back to text for high-cardinality free text', () => {
    expect(
      inferCustomFieldType(col(['alpha', 'beta', 'gamma', 'delta', 'epsilon']), 'Cell'),
    ).toBe('text');
  });

  it('ignores empty cells and infers text for an all-empty column', () => {
    expect(inferCustomFieldType(col(['', '   ', '']), 'Cell')).toBe('text');
  });

  it('samples at most sampleLimit non-empty cells', () => {
    // First two are numeric, the rest (beyond the limit) are text. With limit=2
    // only the numerics are sampled → number.
    const rows = col(['1', '2', 'text', 'more text']);
    expect(inferCustomFieldType(rows, 'Cell', 2)).toBe('number');
  });
});

describe('serializeCustomFieldMappings', () => {
  it('serializes configs, dropping blank field names', () => {
    const out = serializeCustomFieldMappings([
      { column: 'Cost', field_name: '  QA Cost ', field_type: 'number', create_if_missing: true },
      { column: 'Junk', field_name: '   ', field_type: 'text', create_if_missing: true },
    ]);
    expect(out).toEqual([
      { column: 'Cost', field_name: 'QA Cost', field_type: 'number', create_if_missing: true },
    ]);
  });
});

describe('buildErrorReportCsv', () => {
  it('emits row, reason, and original data columns with RFC-4180 quoting', () => {
    const csv = buildErrorReportCsv(
      [{ row: 3, reason: 'missing title', data: { Feature: 'a, b', Notes: 'has "quote"' } }],
      ['Feature', 'Notes'],
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('row,reason,Feature,Notes');
    expect(lines[1]).toBe('3,missing title,"a, b","has ""quote"""');
  });

  it('emits only row + reason when no data is attached', () => {
    const csv = buildErrorReportCsv([{ row: 0, reason: 'oops' }]);
    expect(csv.split('\r\n')).toEqual(['row,reason', '0,oops']);
  });
});

describe('parseImportErrors', () => {
  it('extracts the leading row number, defaulting to 0 when absent', () => {
    expect(parseImportErrors(['Row 5: missing title', 'fatal: no phases'])).toEqual([
      { row: 5, reason: 'Row 5: missing title' },
      { row: 0, reason: 'fatal: no phases' },
    ]);
  });
});
