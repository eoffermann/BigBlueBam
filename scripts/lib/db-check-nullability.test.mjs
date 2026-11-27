// Issue #359: db:check compares column nullability, so a Drizzle declaration that disagrees with
// the database (bearing_goals.owner_id was nullable in Drizzle, NOT NULL in the DB) fails CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainIsNotNull, compositePrimaryKeyKeys, diffNullability } from '../db-check.mjs';

test('chainIsNotNull reads .notNull(), .primaryKey() and serial builders, not comments', () => {
  assert.equal(chainIsNotNull(`owner_id: uuid('owner_id').references(() => users.id),`, 'uuid'), false);
  assert.equal(chainIsNotNull(`owner_id: uuid('owner_id').notNull().references(() => users.id),`, 'uuid'), true);
  assert.equal(
    chainIsNotNull(`body: text('body')\n      .default('')\n      .notNull(),`, 'text'),
    true,
  );
  assert.equal(chainIsNotNull(`id: uuid('id').primaryKey().defaultRandom(),`, 'uuid'), true);
  assert.equal(chainIsNotNull(`n: serial('n'),`, 'serial'), true);
  assert.equal(chainIsNotNull(`note: text('note'), // should this be .notNull()?`, 'text'), false);
});

test('compositePrimaryKeyKeys reads both primaryKey forms from the extra config', () => {
  const extra = `, (table) => ({
    pk: primaryKey({ columns: [table.group_id, table.user_id] }),
    idx: index('x').on(table.scope_id),
  }));`;
  assert.deepEqual([...compositePrimaryKeyKeys(extra)].sort(), ['group_id', 'user_id']);
  assert.deepEqual([...compositePrimaryKeyKeys(', (t) => [primaryKey(t.a, t.b)])')].sort(), ['a', 'b']);
  assert.deepEqual([...compositePrimaryKeyKeys(', (t) => [index("i").on(t.a)])')], []);
});

test('diffNullability reports both directions and every declaration of a table', () => {
  const db = new Map([
    ['bearing_goals', new Map([['owner_id', { nullable: false }], ['description', { nullable: true }]])],
    ['projects', new Map([['task_id_prefix', { nullable: true }]])],
  ]);
  const decls = [
    { table: 'bearing_goals', column: 'owner_id', notNull: false, file: 'apps/bearing-api/x.ts', line: 23 },
    { table: 'bearing_goals', column: 'description', notNull: false, file: 'apps/bearing-api/x.ts', line: 24 },
    { table: 'projects', column: 'task_id_prefix', notNull: false, file: 'apps/api/projects.ts', line: 17 },
    { table: 'projects', column: 'task_id_prefix', notNull: true, file: 'apps/x-api/bbb-refs.ts', line: 46 },
    { table: 'projects', column: 'gone', notNull: true, file: 'apps/api/projects.ts', line: 30 },
    { table: 'missing_table', column: 'x', notNull: true, file: 'y.ts', line: 1 },
  ];
  const out = diffNullability(decls, db);
  assert.equal(out.length, 2);
  assert.match(out[0], /^NULLABILITY MISMATCH: bearing_goals\.owner_id: Drizzle nullable, DB NOT NULL/);
  assert.match(out[0], /add \.notNull\(\)/);
  assert.match(out[1], /projects\.task_id_prefix: Drizzle NOT NULL, DB nullable\n {2}declared at: apps\/x-api\/bbb-refs\.ts:46/);
});
