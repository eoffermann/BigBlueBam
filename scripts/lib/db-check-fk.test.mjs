// Issue #160: db:check compares foreign keys, so a Drizzle .references() the
// database does not enforce (the banter_message_attachments.message_id cascade
// lost to the 0124 partition conversion) fails CI instead of hiding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffForeignKeys, parseReferences } from '../db-check.mjs';

test('parseReferences reads the target and an explicit onDelete from a multi-line builder chain', () => {
  const chain = `    message_id: uuid('message_id')
      .notNull()
      .references(() => banterMessages.id, { onDelete: 'cascade' }),`;
  assert.deepEqual(parseReferences(chain), {
    refVar: 'banterMessages',
    refKey: 'id',
    onDelete: 'cascade',
    onDeleteExplicit: true,
  });
});

test('parseReferences: typed callback, no options means no action (not declared)', () => {
  assert.deepEqual(parseReferences(`parent_id: uuid('parent_id').references((): AnyPgColumn => tasks.id),`), {
    refVar: 'tasks',
    refKey: 'id',
    onDelete: 'no action',
    onDeleteExplicit: false,
  });
  assert.equal(parseReferences(`note: varchar('note', { length: 500 }),`), null);
});

test('parseReferences does not pick up the next column onDelete', () => {
  const chain = `owner_id: uuid('owner_id').references(() => users.id),
    // a comment mentioning onDelete: 'cascade' after the call`;
  assert.equal(parseReferences(chain).onDeleteExplicit, false);
});

const tables = new Map([
  ['banter_message_attachments', {}],
  ['bearing_goals', {}],
  ['tasks', {}],
  ['brief_folders', {}],
]);

test('a declared FK missing from the database is an error (the #160 drift)', () => {
  const declared = new Map([
    [
      'banter_message_attachments.message_id',
      { refTable: 'banter_messages', refColumn: 'id', onDelete: 'cascade', onDeleteExplicit: true, file: 'x.ts', line: 9 },
    ],
  ]);
  const { errors } = diffForeignKeys(declared, new Map(), tables);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /MISSING FOREIGN KEY in DB: banter_message_attachments\.message_id -> banter_messages\.id/);
});

test('an explicit onDelete that disagrees with the database is an error; an omitted one is a warning', () => {
  const live = new Map([
    ['bearing_goals.owner_id', { refTable: 'users', refColumn: 'id', onDelete: 'no action' }],
    ['tasks.sprint_id', { refTable: 'sprints', refColumn: 'id', onDelete: 'set null' }],
  ]);
  const declared = new Map([
    ['bearing_goals.owner_id', { refTable: 'users', refColumn: 'id', onDelete: 'set null', onDeleteExplicit: true }],
    ['tasks.sprint_id', { refTable: 'sprints', refColumn: 'id', onDelete: 'no action', onDeleteExplicit: false }],
  ]);
  const { errors, warnings } = diffForeignKeys(declared, live, tables);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bearing_goals\.owner_id/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tasks\.sprint_id/);
});

test('a database FK Drizzle leaves out is a warning; matching FKs report nothing', () => {
  const live = new Map([
    ['brief_folders.parent_id', { refTable: 'brief_folders', refColumn: 'id', onDelete: 'cascade' }],
    ['tasks.project_id', { refTable: 'projects', refColumn: 'id', onDelete: 'cascade' }],
    ['not_in_drizzle.x', { refTable: 'users', refColumn: 'id', onDelete: 'no action' }],
  ]);
  const declared = new Map([
    ['tasks.project_id', { refTable: 'projects', refColumn: 'id', onDelete: 'cascade', onDeleteExplicit: true }],
  ]);
  const { errors, warnings } = diffForeignKeys(declared, live, tables);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /UNDECLARED FOREIGN KEY in DB: brief_folders\.parent_id/);
});

test('a different referenced table is an error', () => {
  const live = new Map([['tasks.epic_id', { refTable: 'epics', refColumn: 'id', onDelete: 'set null' }]]);
  const declared = new Map([['tasks.epic_id', { refTable: 'tasks', refColumn: 'id', onDelete: 'set null', onDeleteExplicit: true }]]);
  assert.match(diffForeignKeys(declared, live, tables).errors[0], /TARGET MISMATCH/);
});
