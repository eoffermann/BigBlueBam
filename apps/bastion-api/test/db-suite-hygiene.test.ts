import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import workspace, { DB_HOOK_TIMEOUT_MS, DB_TEST_TIMEOUT_MS } from '../vitest.workspace.js';

// #320: the DB-backed suites run in parallel against ONE database. A test that does DDL on a shared
// table while other files write it races on the catalog ("tuple concurrently updated" failed the
// #241 and MAX_RESUMES cases) and queues every other file's statements behind its lock (hook
// timeouts elsewhere). Faults are injected as rows (test/db/fault-injection.ts), and the timeouts
// live in one place (vitest.workspace.ts).

const dbDir = join(__dirname, 'db');
const DDL = /\b(CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION)|DROP\s+(TRIGGER|FUNCTION)|ALTER\s+TABLE|LOCK\s+TABLE|TRUNCATE)\b/i;
const ALLOWED = new Set(['fault-injection.ts', 'global-setup.ts']);

describe('DB-backed suite hygiene (#320)', () => {
  const files = readdirSync(dbDir).filter((n) => n.endsWith('.ts') && !ALLOWED.has(n));

  it('no DB test does DDL on a shared table while other files run (faults are rows, installed once)', () => {
    const offenders = files.flatMap((n) =>
      readFileSync(join(dbDir, n), 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        // A statement in a test that asserts the database REFUSES it (immutability.test.ts) is not DDL that runs.
        .filter(({ line }) => DDL.test(line) && !/is rejected|attempt\(sql/.test(line))
        .map(({ line, i }) => `${n}:${i + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no DB test sets its own timeouts; the db project carries one generous budget and the fault setup', () => {
    expect(files.filter((n) => /vi\.setConfig\(/.test(readFileSync(join(dbDir, n), 'utf8')))).toEqual([]);
    const db = (workspace as Array<{ test?: { name?: string; testTimeout?: number; hookTimeout?: number; globalSetup?: string[] } }>).find((p) => p.test?.name === 'db');
    expect(db?.test).toMatchObject({ testTimeout: DB_TEST_TIMEOUT_MS, hookTimeout: DB_HOOK_TIMEOUT_MS, globalSetup: ['test/db/global-setup.ts'] });
    expect(DB_HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });
});
