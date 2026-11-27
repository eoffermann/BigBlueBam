import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Closable, trackedClass, WorkerRegistry } from './worker-registry.js';

/**
 * #315: graceful shutdown closes EVERY BullMQ worker. The hand-kept list in worker.ts missed the
 * registerBastionSweep / registerBursarSweep / registerBurnSweep workers and a dozen named ones;
 * workers now record themselves at construction, and these tests keep it that way.
 */

const SRC = join(__dirname, '..');
const WORKER = readFileSync(join(SRC, 'worker.ts'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return f.endsWith('.ts') && !f.endsWith('.test.ts') ? [p] : [];
  });
}

class FakeWorker implements Closable {
  closes: Array<boolean | undefined> = [];
  constructor(
    readonly name: string,
    private readonly hangs = false,
  ) {}
  async close(force?: boolean): Promise<void> {
    this.closes.push(force);
    if (this.hangs && !force) await new Promise(() => undefined);
  }
}

describe('worker registry (#315)', () => {
  it('records every instance at construction, including ones built inside helpers and never returned', async () => {
    const registry = new WorkerRegistry();
    const Tracked = trackedClass(FakeWorker, registry);
    const named = new Tracked('email');
    const helper = () => {
      // Like registerBastionSweep: the worker lives only in a local.
      const w = new Tracked('bastion-outbox-drain');
      return void w;
    };
    helper();
    expect(registry.all().map((w) => (w as FakeWorker).name)).toEqual(['email', 'bastion-outbox-drain']);
    expect(await registry.closeAll(1000)).toEqual({ closed: 2, forced: 0 });
    expect(named.closes).toEqual([undefined]);
    expect((registry.all()[1] as FakeWorker).closes).toEqual([undefined]);
  });

  it('force-closes a worker whose job outlives the shutdown deadline, so shutdown is bounded', async () => {
    const registry = new WorkerRegistry();
    const Tracked = trackedClass(FakeWorker, registry);
    new Tracked('quick');
    const stuck = new Tracked('bastion-export-packet', true);
    const t0 = Date.now();
    expect(await registry.closeAll(50)).toEqual({ closed: 1, forced: 1 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(stuck.closes).toEqual([undefined, true]);
  });
});

describe('worker.ts shutdown wiring (#315)', () => {
  it('no source file builds a Worker from bullmq directly (only the registry does)', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('lib', 'worker-registry.ts')))
      .filter((f) => /import\s*\{[^}]*\bWorker\b[^}]*\}\s*from\s*['"]bullmq['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    expect(WORKER).toMatch(/import \{[^}]*\bWorker\b[^}]*\} from '\.\/lib\/worker-registry\.js'/);
  });

  it('shutdown closes the registry before the DB pool and Redis, and keeps no hand-kept list', () => {
    const body = WORKER.slice(WORKER.indexOf('async function shutdown('));
    const close = body.indexOf('workerRegistry.closeAll(');
    expect(close).toBeGreaterThan(0);
    expect(close).toBeLessThan(body.indexOf('closeDb()'));
    expect(close).toBeLessThan(body.indexOf('redis.disconnect()'));
    expect(WORKER).not.toMatch(/const workers = \[/);
  });
});
