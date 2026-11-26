import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULED_JOB_RETENTION, withRetention } from './job-retention.js';

const SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** The full argument text of every upsertJobScheduler(...) call in `src`. */
function schedulerCalls(src: string): string[] {
  const calls: string[] = [];
  const needle = 'upsertJobScheduler(';
  let at = src.indexOf(needle);
  while (at >= 0) {
    const open = at + needle.length;
    let depth = 0;
    let quote: string | null = null;
    let j = open;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
      if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; continue; }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      }
    }
    calls.push(src.slice(open, j));
    at = src.indexOf(needle, j);
  }
  return calls;
}

describe('withRetention', () => {
  it('adds bounded completed/failed history to a job template', () => {
    expect(withRetention({ name: 'tick', data: {} })).toEqual({
      name: 'tick',
      data: {},
      opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } },
    });
  });

  it('keeps explicit template options, which win over the defaults', () => {
    const t = withRetention({ name: 'tick', data: {}, opts: { attempts: 3, removeOnComplete: 10 } });
    expect(t.opts).toEqual({ ...SCHEDULED_JOB_RETENTION, attempts: 3, removeOnComplete: 10 });
  });
});

describe('every job scheduler keeps a bounded history', () => {
  // Unbounded finished-job records filled a 256 MB Redis in five days.
  const calls = tsFiles(SRC).flatMap((file) =>
    schedulerCalls(readFileSync(file, 'utf8')).map((args) => ({ file, args })),
  );

  it('finds the scheduler registrations', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(calls.map((c, i) => [i, c] as const))('call %i wraps its job template in withRetention', (_i, c) => {
    expect(c.args, `${c.file}: upsertJobScheduler(${c.args.slice(0, 80)}...)`).toContain('withRetention(');
  });
});
