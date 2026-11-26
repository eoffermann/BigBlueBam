import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBastionEnqueues } from './bolt-bastion-enqueues.mjs';

const catalog = { pairs: new Set(['bastion:control.drifted', 'bastion:ledger.sealed']) };

test('a catalogued literal passes; the declaration is not a call', () => {
  const src = `
    export async function enqueueBastionEvent(eventType, payload, tx, opts) {}
    await enqueueBastionEvent('control.drifted', { a: 1 }, tx, { orgId });
    await enqueueBastionEvent(
      "ledger.sealed",
      {},
      tx,
      opts,
    );`;
  assert.deepEqual(checkBastionEnqueues('f.ts', src, catalog), []);
});

test('an uncatalogued name fails', () => {
  const v = checkBastionEnqueues('f.ts', "enqueueBastionEvent('control.exploded', {}, tx, o)", catalog);
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /control\.exploded/);
});

test('a dynamic name fails (it would evade the guard)', () => {
  for (const call of ['enqueueBastionEvent(name, {}, tx, o)', 'enqueueBastionEvent(`x.${y}`, {}, tx, o)', "enqueueBastionEvent('a' + b, {}, tx, o)"]) {
    const v = checkBastionEnqueues('f.ts', call, catalog);
    assert.equal(v.length, 1, call);
    assert.match(v[0].reason, /string-literal/);
  }
});

test('a longer identifier containing the name is ignored', () => {
  assert.deepEqual(checkBastionEnqueues('f.ts', "myenqueueBastionEvent('nope', {})", catalog), []);
});
