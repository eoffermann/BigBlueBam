import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyDriftBaseline, checkPayloadCalls, objectLiteralKeys, parsePayloadSchemas, publishedPayloads } from './bolt-payload-keys.mjs';

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

test('#316: a literal dotted payload key fails, even though it matches the dotted catalog name, and cannot be baselined', () => {
  const bad = `publishBoltEvent('deal.rotting', 'bond', { 'deal.id': d.id, days: 3 }, orgId);`;
  const v = checkPayloadCalls('b.ts', bad, schemas);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'dotted-key');
  assert.match(v[0].reason, /literal dotted payload key "deal\.id".*deal: \{ id: \.\.\. \}/);
  assert.equal(applyDriftBaseline(v, { [v[0].driftKey]: 316 }, 'baseline.json').filter((x) => x.kind === 'dotted-key').length, 1);
  // Checked for unknown schemas and for the Bastion outbox too.
  assert.equal(checkPayloadCalls('b.ts', `publishBoltEvent('deal.weird', 'bond', { 'org.id': o }, o);`, schemas).length, 1);
  assert.equal(checkPayloadCalls('a.ts', `enqueueBastionEvent('questionnaire.drafted', { questionnaire_id: q, 'org.id': o }, tx, opts);`, schemas).filter((x) => x.kind === 'dotted-key').length, 1);
  assert.deepEqual(checkPayloadCalls('b.ts', `publishBoltEvent('deal.rotting', 'bond', { deal: { id: d.id }, days: 3 }, orgId);`, schemas), []);
});

test('#316: no publisher in the repo sends a literal dotted payload key', () => {
  const root = join(import.meta.dirname, '..', '..');
  const found = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      if (['node_modules', 'dist', 'build', '__tests__'].includes(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts')) {
        found.push(...checkPayloadCalls(p, readFileSync(p, 'utf8'), new Map()).filter((x) => x.kind === 'dotted-key').map((x) => `${p}: ${x.reason}`));
      }
    }
  };
  walk(join(root, 'apps'));
  assert.deepEqual(found, []);
});

test('the baseline hides known drift and reports entries that are no longer sent', () => {
  const v = checkPayloadCalls('b.ts', `publishBoltEvent('deal.rotting', 'bond', { stage: 1 }, o);`, schemas);
  const out = applyDriftBaseline(v, { 'bond:deal.rotting:stage': 1, 'bond:deal.rotting:gone': 2 }, 'baseline.json');
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /"bond:deal\.rotting:gone".*no longer sent/);
});

// #289: the reverse direction for the shipped Bolt templates. A template condition or parameter
// that reads event.<key>... must read a key the event's publishers actually send, or the rule a
// person instantiates from it can never match (tpl_auto_assign_ticket read event.ticket.* while
// Helpdesk sent only flat ticket_id / priority).
test('every Bolt template reads payload keys its trigger event is published with', () => {
  const root = join(import.meta.dirname, '..', '..');
  const tpl = readFileSync(join(root, 'apps/bolt-api/src/services/template.service.ts'), 'utf8');
  const sent = new Map();
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      if (['node_modules', 'dist', 'build', '__tests__'].includes(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts')) {
        for (const c of publishedPayloads(readFileSync(p, 'utf8'))) {
          const k = `${c.source}:${c.eventName}`;
          if (!sent.has(k)) sent.set(k, { keys: new Set(), open: false });
          const e = sent.get(k);
          for (const key of c.keys) e.keys.add(key);
          e.open ||= c.open;
        }
      }
    }
  };
  walk(join(root, 'apps'));
  const blocks = tpl.split(/\bid: 'tpl_/).slice(1);
  let checked = 0;
  for (const b of blocks) {
    const id = /^([a-z_]+)'/.exec(b)?.[1];
    const source = /trigger_source: '([a-z_]+)'/.exec(b)?.[1];
    const event = /trigger_event: '([a-z0-9_.]+)'/.exec(b)?.[1];
    const e = sent.get(`${source}:${event}`);
    if (!e || e.open) continue; // no literal publisher found, or a spread payload: cannot tell
    for (const m of b.matchAll(/event\.([a-z_]+)/g)) {
      if (['actor', 'org'].includes(m[1])) continue; // added by the publisher's actor/org arguments on some sources
      checked += 1;
      assert.ok(e.keys.has(m[1]), `tpl_${id} reads event.${m[1]} but ${source}:${event} is published without "${m[1]}"`);
    }
  }
  assert.ok(checked > 0);
});

test('every Bastion publisher in the repo sends only declared keys (#262)', () => {
  const root = join(import.meta.dirname, '..', '..');
  const real = parsePayloadSchemas(readFileSync(join(root, 'apps/bolt-api/src/services/event-catalog.ts'), 'utf8'));
  for (const f of ['questionnaire-autofill.service.ts', 'questionnaires.service.ts', 'exceptions.service.ts', 'manual-evidence.service.ts', 'policies.service.ts', 'evidence-engines.ts', 'fixes.service.ts', 'compile-ai.service.ts']) {
    const text = readFileSync(join(root, 'apps/bastion-api/src/services', f), 'utf8');
    assert.deepEqual(checkPayloadCalls(f, text, real).map((x) => x.reason), [], f);
  }
});
