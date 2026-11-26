import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDriftBaseline, checkPayloadCalls, objectLiteralKeys, parsePayloadSchemas } from './bolt-payload-keys.mjs';

const CATALOG = `
const orgField: PayloadField = { name: 'org_id', type: 'uuid', description: 'Org' };
const common: PayloadField[] = [
  { name: 'deal.id', type: 'uuid', description: "the deal's id, with an apostrophe" },
  // a comment with an apostrophe: it's fine
];
const events: EventDefinition[] = [
  {
    source: 'bastion',
    event_type: 'questionnaire.drafted',
    description: 'x',
    payload_schema: [{ name: 'questionnaire_id', type: 'uuid', description: 'q' }, { name: 'high_count', type: 'number', description: 'h' }, orgField],
  },
  {
    source: 'bond',
    event_type: 'deal.rotting',
    description: 'y',
    payload_schema: [...common, { name: 'days', type: 'number', description: 'd' }],
  },
  {
    source: 'bond',
    event_type: 'deal.weird',
    description: 'z',
    payload_schema: buildFields('weird'),
  },
];`;

const schemas = parsePayloadSchemas(CATALOG);

test('reads inline fields, identifiers and spreads; an unreadable schema is unknown, not empty', () => {
  assert.deepEqual([...schemas.get('bastion:questionnaire.drafted')].sort(), ['high_count', 'org_id', 'questionnaire_id']);
  assert.deepEqual([...schemas.get('bond:deal.rotting')].sort(), ['days', 'deal.id']);
  assert.equal(schemas.get('bond:deal.weird'), null);
});

test('object-literal keys: shorthand, quoted, nested values, spreads and computed keys', () => {
  assert.deepEqual(objectLiteralKeys(`{ a, b: f(1, 2), 'c': { d: 1 }, ...rest, [k]: 2 }`), { keys: ['a', 'b', 'c'], open: true });
  assert.equal(objectLiteralKeys('payload'), null);
  assert.equal(objectLiteralKeys('{ a: 1 } as never'), null);
});

test('the #262 case: questionnaire.drafted sent with names the catalog does not declare', () => {
  const before = `await enqueueBastionEvent('questionnaire.drafted', { questionnaire_id: q.id, title: q.title, high: 1 }, tx, opts);`;
  const v = checkPayloadCalls('a.ts', before, schemas);
  assert.deepEqual(v.map((x) => x.driftKey).sort(), ['bastion:questionnaire.drafted:high', 'bastion:questionnaire.drafted:title']);
  const after = `await enqueueBastionEvent('questionnaire.drafted', { questionnaire_id: q.id, high_count: 1 }, tx, opts);`;
  assert.deepEqual(checkPayloadCalls('a.ts', after, schemas), []);
});

test('publishBoltEvent: a nested object is declared by its dotted children; dynamic payloads are skipped', () => {
  const ok = `publishBoltEvent('deal.rotting', 'bond', { deal: { id }, days: 3 }, orgId);`;
  assert.deepEqual(checkPayloadCalls('b.ts', ok, schemas), []);
  const bad = `publishBoltEvent(
    'deal.rotting',
    'bond',
    {
      // the stage, which the catalog never declared
      stage: s,
      days: 3,
    },
    orgId,
  );`;
  assert.deepEqual(checkPayloadCalls('b.ts', bad, schemas).map((x) => x.driftKey), ['bond:deal.rotting:stage']);
  assert.deepEqual(checkPayloadCalls('b.ts', `publishBoltEvent('deal.rotting', 'bond', payload, orgId);`, schemas), []);
  assert.deepEqual(checkPayloadCalls('b.ts', `publishBoltEvent('deal.weird', 'bond', { anything: 1 }, orgId);`, schemas), []);
});

test('the baseline hides known drift and reports entries that are no longer sent', () => {
  const v = checkPayloadCalls('b.ts', `publishBoltEvent('deal.rotting', 'bond', { stage: 1 }, o);`, schemas);
  const out = applyDriftBaseline(v, { 'bond:deal.rotting:stage': 1, 'bond:deal.rotting:gone': 2 }, 'baseline.json');
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /"bond:deal\.rotting:gone".*no longer sent/);
});

test('every Bastion publisher in the repo sends only declared keys (#262)', () => {
  const root = join(import.meta.dirname, '..', '..');
  const real = parsePayloadSchemas(readFileSync(join(root, 'apps/bolt-api/src/services/event-catalog.ts'), 'utf8'));
  for (const f of ['questionnaire-autofill.service.ts', 'questionnaires.service.ts', 'exceptions.service.ts', 'manual-evidence.service.ts', 'policies.service.ts', 'evidence-engines.ts', 'fixes.service.ts', 'compile-ai.service.ts']) {
    const text = readFileSync(join(root, 'apps/bastion-api/src/services', f), 'utf8');
    assert.deepEqual(checkPayloadCalls(f, text, real).map((x) => x.reason), [], f);
  }
});
