import { describe, it, expect } from 'vitest';
import { inferSchema, inferredToZod } from './inference.js';
import { parseAsset } from './index.js';

const field = (schema: ReturnType<typeof inferSchema>, key: string) =>
  schema.fields.find((f) => f.key === key)!;

describe('inferSchema', () => {
  it('infers integer / number / boolean / date / datetime', () => {
    const rows = [
      { i: '1', n: '1.5', b: 'true', d: '2026-01-02', dt: '2026-01-02T03:04:05Z' },
      { i: '2', n: '2.0', b: 'false', d: '2026-02-03', dt: '2026-02-03T06:07:08Z' },
    ];
    const s = inferSchema(rows, ['i', 'n', 'b', 'd', 'dt']);
    expect(field(s, 'i').type).toBe('integer');
    expect(field(s, 'n').type).toBe('number');
    expect(field(s, 'b').type).toBe('boolean');
    expect(field(s, 'd').type).toBe('date');
    expect(field(s, 'dt').type).toBe('datetime');
  });

  it('detects a low-cardinality column as an enum', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      status: i % 2 === 0 ? 'open' : 'closed',
    }));
    const s = inferSchema(rows, ['status']);
    const f = field(s, 'status');
    expect(f.type).toBe('enum');
    expect(f.enumValues).toEqual(['closed', 'open']);
  });

  it('marks nullable when any sampled value is empty', () => {
    const rows = [{ x: 'a' }, { x: '' }, { x: 'b' }];
    expect(field(inferSchema(rows, ['x']), 'x').nullable).toBe(true);
  });

  it('flags longtext for long or multiline strings', () => {
    const rows = [{ note: 'x'.repeat(200) }, { note: 'short' }];
    expect(field(inferSchema(rows, ['note']), 'note').longtext).toBe(true);
  });

  it('falls back to nullable string for an all-empty column', () => {
    const s = field(inferSchema([{ x: '' }, { x: null }], ['x']), 'x');
    expect(s.type).toBe('string');
    expect(s.nullable).toBe(true);
  });

  it('does not over-eagerly call high-cardinality strings enums', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ name: `name-${i}` }));
    expect(field(inferSchema(rows, ['name']), 'name').type).toBe('string');
  });
});

describe('inferredToZod', () => {
  it('builds a Zod object that validates a conforming row', () => {
    const rows = [{ id: '1', active: 'true' }];
    const schema = inferredToZod(inferSchema(rows, ['id', 'active']));
    const parsed = schema.parse({ id: '1', active: 'true' });
    expect(parsed).toEqual({ id: 1, active: true });
  });

  it('rejects a non-numeric value for an integer field', () => {
    const schema = inferredToZod(inferSchema([{ id: '1' }, { id: '2' }], ['id']));
    expect(schema.safeParse({ id: 'not-a-number' }).success).toBe(false);
  });
});

describe('parseAsset integration', () => {
  it('parses a CSV asset into a record shape with an inferable schema', () => {
    const parsed = parseAsset('id,role\n1,admin\n2,member\n3,admin', 'csv');
    expect(parsed.shape).toBe('record');
    expect(parsed.columns).toEqual(['id', 'role']);
    const schema = inferSchema(parsed.rows!, parsed.columns!);
    expect(field(schema, 'id').type).toBe('integer');
  });

  it('parses a nested JSON object into a tree shape', () => {
    const parsed = parseAsset('{"a":{"b":1}}', 'json');
    expect(parsed.shape).toBe('tree');
  });
});
