// Issue #160: db:check compares foreign keys, so a Drizzle .references() the
// database does not enforce (the banter_message_attachments.message_id cascade
// lost to the 0124 partition conversion) fails CI instead of hiding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffForeignKeys, mergeForeignKeyDeclarations, parseReferences, UNDECLARED_FK_ALLOWLIST } from '../db-check.mjs';

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

// Issue #360: 44 standing warnings hid new ones. Every DB FK is now declared in Drizzle or in a
// reviewed allowlist, a stub that omits onDelete cannot mask the owning schema, and the live
// db:check run reports 0 warnings.

test('an allowlisted undeclared FK is silent; a stale allowlist entry is an error', () => {
  const live = new Map([
    ['bench_widgets.basis_metric_id', { refTable: 'basis_metrics', refColumn: 'id', onDelete: 'set null' }],
    ['tasks.epic_id', { refTable: 'epics', refColumn: 'id', onDelete: 'set null' }],
  ]);
  const declared = new Map([['tasks.epic_id', { refTable: 'epics', refColumn: 'id', onDelete: 'set null', onDeleteExplicit: true }]]);
  const t = new Map([...tables, ['bench_widgets', {}]]);
  assert.deepEqual(diffForeignKeys(declared, live, t, { 'bench_widgets.basis_metric_id': 'cross-product' }), {
    errors: [],
    warnings: [],
  });
  const stale = diffForeignKeys(declared, live, t, {
    'bench_widgets.basis_metric_id': 'cross-product',
    'tasks.epic_id': 'now declared',
    'gone.fk': 'no longer in the DB',
  });
  assert.equal(stale.errors.length, 2);
  assert.match(stale.errors.join('\n'), /tasks\.epic_id .*Drizzle now declares it/);
  assert.match(stale.errors.join('\n'), /gone\.fk .*no such FK/);
});

test('every allowlist entry carries a reason', () => {
  for (const [key, reason] of Object.entries(UNDECLARED_FK_ALLOWLIST)) {
    assert.match(key, /^[a-z0-9_]+\.[a-z0-9_]+$/);
    assert.ok(typeof reason === 'string' && reason.length > 20, `${key} needs a reason`);
  }
});

test('an explicit onDelete wins over a stub that omits it, in either order', () => {
  const owner = { key: 'tasks.assignee_id', refTable: 'users', refColumn: 'id', onDelete: 'set null', onDeleteExplicit: true, file: 'api.ts', line: 1 };
  const stub = { key: 'tasks.assignee_id', refTable: 'users', refColumn: 'id', onDelete: 'no action', onDeleteExplicit: false, file: 'stub.ts', line: 2 };
  for (const order of [[owner, stub], [stub, owner]]) {
    const { declared, conflicts } = mergeForeignKeyDeclarations(order);
    assert.deepEqual(conflicts, []);
    assert.equal(declared.get('tasks.assignee_id').onDelete, 'set null');
  }
});

test('declarations that disagree on the target or an explicit onDelete conflict', () => {
  const a = { key: 'tasks.org_id', refTable: 'organizations', refColumn: 'id', onDelete: 'cascade', onDeleteExplicit: true, file: 'a.ts', line: 1 };
  const b = { ...a, onDelete: 'set null', file: 'b.ts' };
  const c = { ...a, refTable: 'users', onDeleteExplicit: false, file: 'c.ts' };
  const { conflicts } = mergeForeignKeyDeclarations([a, b, c]);
  assert.equal(conflicts.length, 2);
  assert.match(conflicts[0], /CONFLICTING FOREIGN KEY DECLARATIONS: tasks\.org_id/);
});
