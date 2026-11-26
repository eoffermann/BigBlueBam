import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPublishCalls } from './bolt-publish-calls.mjs';

const catalog = {
  pairs: new Set(['bond:deal.rotting', 'bastion:control.drifted']),
  sources: new Set(['bond', 'bastion']),
  boltSources: new Set(['bond', 'bastion']),
};

test('catalogued literal calls pass for both publishers', () => {
  const src = `
    await publishBoltEvent('deal.rotting', 'bond', {}, orgId);
    await publishBoltEventChecked(
      "control.drifted",
      'bastion',
      payload,
      orgId,
    );`;
  assert.deepEqual(checkPublishCalls('f.ts', src, catalog), []);
});

test('publishBoltEventChecked with an unknown source is reported (#200)', () => {
  const v = checkPublishCalls('f.ts', "publishBoltEventChecked('x.y', 'nosuchsource', {}, o)", catalog);
  assert.equal(v.length, 1);
  assert.equal(v[0].callee, 'publishBoltEventChecked');
  assert.match(v[0].reason, /nosuchsource/);
});

test('publishBoltEventChecked with an uncatalogued pair or a source-prefixed name is reported', () => {
  const missing = checkPublishCalls('f.ts', "publishBoltEventChecked('deal.exploded', 'bond', {}, o)", catalog);
  assert.equal(missing.length, 1);
  assert.match(missing[0].reason, /not found in event-catalog/);
  const prefixed = checkPublishCalls('f.ts', "publishBoltEventChecked('bond.deal.rotting', 'bond', {}, o)", catalog);
  assert.equal(prefixed.length, 1);
  assert.match(prefixed[0].reason, /source-prefixed/);
});

test('dynamic calls, declarations and look-alike names are not checked', () => {
  const src = `
    export async function publishBoltEventChecked(eventType: string, source: string, payload, orgId) {}
    await publishBoltEvent(name, 'bond', {}, o);
    await publishBoltEventChecked(String(p.event_type), 'bastion', {}, o);
    await publishBoltEventsLater('deal.exploded', 'nosuchsource', {}, o);
    await xpublishBoltEvent('deal.exploded', 'nosuchsource', {}, o);`;
  assert.deepEqual(checkPublishCalls('f.ts', src, catalog), []);
});

test('the same uncatalogued literal is reported for publishBoltEvent too', () => {
  const v = checkPublishCalls('f.ts', "publishBoltEvent('deal.exploded', 'bond', {}, o)", catalog);
  assert.equal(v.length, 1);
  assert.equal(v[0].callee, 'publishBoltEvent');
});
