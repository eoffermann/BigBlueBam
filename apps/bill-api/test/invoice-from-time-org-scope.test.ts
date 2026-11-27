import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// createInvoiceFromTimeEntries takes project_id and time_entry_ids from the
// caller. tasks and time_entries carry no org column, so unless the project is
// resolved inside the caller's org and the entry queries join projects on
// org_id, a caller can bill another org's time entries and read their task
// titles, member names and hours off the invoice.

const { selectCalls } = vi.hoisted(() => ({
  selectCalls: [] as Array<{ where: unknown[]; result: unknown[] }>,
}));
const queue: unknown[][] = [];

vi.mock('../src/db/index.js', () => ({
  db: {
    select: () => {
      const call = { where: [] as unknown[], result: queue.shift() ?? [] };
      selectCalls.push(call);
      const obj: Record<string, unknown> = {};
      obj.from = () => obj;
      obj.innerJoin = () => obj;
      obj.leftJoin = () => obj;
      obj.where = (cond: unknown) => {
        call.where.push(cond);
        return obj;
      };
      obj.limit = async () => call.result;
      obj.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(call.result).then(res, rej);
      return obj;
    },
  },
  connection: { end: vi.fn() },
}));
vi.mock('../src/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));

import { createInvoiceFromTimeEntries } from '../src/services/invoice.service.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000010';
const FOREIGN_ENTRY = '00000000-0000-4000-8000-0000000000ee';
const dialect = new PgDialect();

beforeEach(() => {
  selectCalls.length = 0;
  queue.length = 0;
});

describe('createInvoiceFromTimeEntries org scoping', () => {
  it('404s a project outside the caller org before reading any time entries', async () => {
    queue.push([]); // project lookup: not in this org
    await expect(
      createInvoiceFromTimeEntries(
        { project_id: PROJECT, time_entry_ids: [FOREIGN_ENTRY] } as never,
        ORG,
        'u1',
      ),
    ).rejects.toMatchObject({ message: 'Project not found' });
    expect(selectCalls).toHaveLength(1);
  });

  it('filters explicit time-entry ids by the caller org', async () => {
    queue.push([{ id: PROJECT }], []); // project found, then no entries survive the org filter
    await expect(
      createInvoiceFromTimeEntries(
        { project_id: PROJECT, time_entry_ids: [FOREIGN_ENTRY] } as never,
        ORG,
        'u1',
      ),
    ).rejects.toThrow(/No time entries found/);
    const entryQuery = dialect.sqlToQuery(selectCalls[1]!.where[0] as SQL);
    expect(entryQuery.sql).toContain('"org_id"');
    expect(entryQuery.params).toContain(ORG);
  });

  it('filters the date-range path by the caller org too', async () => {
    queue.push([{ id: PROJECT }], []);
    await expect(
      createInvoiceFromTimeEntries(
        { project_id: PROJECT, date_from: '2026-01-01', date_to: '2026-01-31' } as never,
        ORG,
        'u1',
      ),
    ).rejects.toThrow(/No time entries found/);
    const entryQuery = dialect.sqlToQuery(selectCalls[1]!.where[0] as SQL);
    expect(entryQuery.params).toContain(ORG);
  });
});
