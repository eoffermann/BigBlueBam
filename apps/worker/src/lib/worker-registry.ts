// Every BullMQ Worker this process creates, recorded at construction (#315).
//
// The shutdown list in worker.ts used to be a hand-kept array, and it drifted: the
// registerBastionSweep / registerBursarSweep / registerBurnSweep helpers created workers in a
// local and never returned them, and a dozen named workers (Bulwark, Burn, Bursar, ...) were never
// added. On SIGTERM those kept fetching jobs and were cut off mid-job when the DB pool and Redis
// closed under them. worker.ts imports `Worker` from here instead of from bullmq, so a worker
// cannot exist without being closed on shutdown.

import { Worker as BullWorker } from 'bullmq';

/** The minimum a closable worker offers (BullMQ's Worker; a fake in the unit tests). */
export interface Closable {
  close(force?: boolean): Promise<void>;
}

/** A registry of closable workers, filled by the classes `trackedClass` returns. */
export class WorkerRegistry {
  private readonly items: Closable[] = [];

  add(w: Closable): void {
    this.items.push(w);
  }

  all(): readonly Closable[] {
    return this.items;
  }

  /**
   * Close every worker, waiting up to `deadlineMs` for their active jobs to finish, then force
   * close whatever is still open. Bounded below the container's stop grace period, so the DB pool
   * and Redis are closed only after every worker has stopped fetching, and a long job is handed to
   * BullMQ's stalled-job path instead of being SIGKILLed between closeDb and exit.
   */
  async closeAll(deadlineMs: number): Promise<{ closed: number; forced: number }> {
    const pending = new Set<Closable>(this.items);
    const graceful = Promise.allSettled(
      this.items.map(async (w) => {
        await w.close();
        pending.delete(w);
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), deadlineMs);
    });
    const outcome = await Promise.race([graceful.then(() => 'done' as const), deadline]);
    if (timer) clearTimeout(timer);
    const forced = outcome === 'deadline' ? [...pending] : [];
    await Promise.allSettled(forced.map((w) => w.close(true)));
    return { closed: this.items.length - forced.length, forced: forced.length };
  }
}

/** Subclass a worker class so every instance records itself in `registry` as it is built. */
// biome-ignore lint/suspicious/noExplicitAny: a mixin over any constructor signature.
export function trackedClass<T extends new (...args: any[]) => Closable>(Base: T, registry: WorkerRegistry): T {
  return class extends Base {
    // biome-ignore lint/suspicious/noExplicitAny: forwards the base constructor's arguments.
    constructor(...args: any[]) {
      super(...args);
      registry.add(this);
    }
  };
}

/** The process-wide registry worker.ts closes on SIGTERM. */
export const workerRegistry = new WorkerRegistry();

/** BullMQ's Worker, recorded in `workerRegistry` on construction. Same type and generics. */
export const Worker = trackedClass(BullWorker, workerRegistry) as typeof BullWorker;
