import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Parent-expansion cascade (feat/timeline-interactive).
//
// expandParentsToEncompass fires a handful of small, well-shaped queries per
// hop (read child dates → read direct parents (legacy self-FK + join table) →
// read+widen each parent), then recurses upward. The rest of the suite mocks
// the db chain with brittle per-call `mockReturnValueOnce` sequencing, which
// does not survive a recursive, data-dependent walk. So instead of scripting
// call order we stand up a tiny STATEFUL fake db over an in-memory task graph
// and let the real cascade drive it. Reads reflect prior writes, exactly like
// Postgres, which is what makes the "cascade up / converge / terminate" cases
// meaningful.
// ---------------------------------------------------------------------------

type Task = {
  id: string;
  project_id: string;
  start_date: string | null;
  due_date: string | null;
  legacyParent: string | null; // tasks.parent_task_id
};

const { mockDb, ctx } = vi.hoisted(() => {
  // Shared, mutable graph the fake db reads/writes. Each test reseeds it.
  const ctx = {
    tasks: new Map<string, Task>(),
    links: [] as { task_id: string; parent_task_id: string }[],
  };

  // Pull the single column name + bound value out of a drizzle condition.
  // For eq(col, val) the queryChunks are [StringChunk, Column, StringChunk,
  // Param, StringChunk]; the Column carries `.name` (and no `.value`), the
  // Param carries the scalar `.value`.
  function extractWhere(cond: any): { colName?: string; val?: unknown } {
    const out: { colName?: string; val?: unknown } = {};
    for (const ch of cond?.queryChunks ?? []) {
      if (ch && typeof ch.name === 'string' && ch.value === undefined) {
        out.colName = ch.name;
      } else if (ch && ch.constructor && ch.constructor.name === 'Param') {
        out.val = ch.value;
      }
    }
    return out;
  }

  // A `.where(...)` result that is both awaitable (getDirectParentIds awaits it
  // directly) and chainable with `.limit(n)` (the date reads add LIMIT 1).
  function resolvable(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return {
      limit: () => Promise.resolve(rows),
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
  }

  const mockDb = {
    select(projection: Record<string, any>) {
      let table: string | undefined;
      return {
        from(t: any) {
          // Table objects expose their SQL name via drizzle's internal symbol;
          // fall back to scanning the projection's column for its table tag.
          table =
            (t && (t[Symbol.for('drizzle:Name')] as string)) ??
            undefined;
          return this;
        },
        where(cond: any) {
          const { colName, val } = extractWhere(cond);
          const projKeys = Object.keys(projection);
          // task_parent_links reads — direction depends on the bound column.
          if (table === 'task_parent_links') {
            if (colName === 'parent_task_id') {
              // children of `val` via the join table
              const rows = ctx.links
                .filter((l) => l.parent_task_id === val)
                .map((l) => ({ id: l.task_id }));
              return resolvable(rows);
            }
            // parents of `val` via the join table (bound on task_id)
            const rows = ctx.links
              .filter((l) => l.task_id === val)
              .map((l) => ({ id: l.parent_task_id }));
            return resolvable(rows);
          }
          // tasks reads.
          if (colName === 'parent_task_id') {
            // children of `val` via the legacy self-FK
            const rows = [...ctx.tasks.values()]
              .filter((t) => t.legacyParent === val)
              .map((t) => ({ id: t.id }));
            return resolvable(rows);
          }
          if (projKeys.includes('start_date')) {
            const t = ctx.tasks.get(val as string);
            return resolvable(t ? [{ start_date: t.start_date, due_date: t.due_date }] : []);
          }
          // {id: tasks.parent_task_id} — the legacy single-FK parent of `val`.
          const t = ctx.tasks.get(val as string);
          return resolvable(t ? [{ id: t.legacyParent }] : []);
        },
      };
    },
    update(_t: any) {
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(cond: any) {
              return {
                returning() {
                  const { val } = extractWhere(cond);
                  const t = ctx.tasks.get(val as string);
                  if (!t) return Promise.resolve([]);
                  if (vals.start_date !== undefined) t.start_date = vals.start_date as string;
                  if (vals.due_date !== undefined) t.due_date = vals.due_date as string;
                  return Promise.resolve([{ ...t }]);
                },
              };
            },
          };
        },
      };
    },
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  };

  return { mockDb, ctx };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/services/realtime.service.js', () => ({
  broadcastToProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/activity.service.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    PUBLIC_URL: 'http://localhost',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

// ---------- imports (after mocks) ----------
import { expandParentsToEncompass, shiftSubtreeDates } from '../src/services/task.service.js';
import { broadcastToProject } from '../src/services/realtime.service.js';

// ---------- helpers ----------
function task(
  id: string,
  start_date: string | null,
  due_date: string | null,
  legacyParent: string | null = null,
): Task {
  return { id, project_id: 'proj-1', start_date, due_date, legacyParent };
}

function seed(tasks: Task[], links: { task_id: string; parent_task_id: string }[] = []) {
  ctx.tasks = new Map(tasks.map((t) => [t.id, { ...t }]));
  ctx.links = links.map((l) => ({ ...l }));
}

const get = (id: string) => ctx.tasks.get(id)!;

// ---------- tests ----------
describe('expandParentsToEncompass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.tasks = new Map();
    ctx.links = [];
  });

  it('(a) widens a single parent on BOTH ends when the child extends past it', async () => {
    seed([
      task('P', '2026-06-10', '2026-06-20'),
      task('C', '2026-06-05', '2026-06-25', 'P'),
    ]);

    await expandParentsToEncompass('C', 'user-1');

    expect(get('P').start_date).toBe('2026-06-05'); // earlier start pulled in
    expect(get('P').due_date).toBe('2026-06-25'); // later due pushed out
    // the widened parent was broadcast (attributed to the actor)
    expect(broadcastToProject).toHaveBeenCalledWith(
      'proj-1',
      'task.updated',
      expect.objectContaining({ id: 'P' }),
      'user-1',
    );
  });

  it('(b) leaves the parent untouched when the child is already within it', async () => {
    seed([
      task('P', '2026-06-01', '2026-06-30'),
      task('C', '2026-06-10', '2026-06-20', 'P'),
    ]);

    await expandParentsToEncompass('C', 'user-1');

    expect(get('P').start_date).toBe('2026-06-01');
    expect(get('P').due_date).toBe('2026-06-30');
    expect(broadcastToProject).not.toHaveBeenCalled(); // no write, no broadcast
  });

  it('(c) populates a parent whose start/due are null from the child', async () => {
    seed([
      task('P', null, null),
      task('C', '2026-06-10', '2026-06-20', 'P'),
    ]);

    await expandParentsToEncompass('C', 'user-1');

    expect(get('P').start_date).toBe('2026-06-10');
    expect(get('P').due_date).toBe('2026-06-20');
  });

  it('(d) widens BOTH parents of a child with two parents (legacy + join table)', async () => {
    seed(
      [
        task('P1', '2026-06-10', '2026-06-15'),
        task('P2', '2026-06-12', '2026-06-18'),
        task('C', '2026-06-05', '2026-06-25', 'P1'), // P1 via legacy FK
      ],
      [{ task_id: 'C', parent_task_id: 'P2' }], // P2 via join table
    );

    await expandParentsToEncompass('C', 'user-1');

    expect(get('P1').start_date).toBe('2026-06-05');
    expect(get('P1').due_date).toBe('2026-06-25');
    expect(get('P2').start_date).toBe('2026-06-05');
    expect(get('P2').due_date).toBe('2026-06-25');
  });

  it('(e) cascades up a grandparent chain, widening only what must move', async () => {
    seed([
      task('G', '2026-06-08', '2026-06-22', null),
      task('P', '2026-06-06', '2026-06-24', 'G'),
      task('C', '2026-06-01', '2026-06-30', 'P'),
    ]);

    await expandParentsToEncompass('C', 'user-1');

    expect(get('P').start_date).toBe('2026-06-01');
    expect(get('P').due_date).toBe('2026-06-30');
    // and the change propagated one more level up to the grandparent
    expect(get('G').start_date).toBe('2026-06-01');
    expect(get('G').due_date).toBe('2026-06-30');
  });

  it('(f) terminates on self-loop and on a 2-cycle without infinite recursion', async () => {
    // self-loop: S is its own parent
    seed([task('S', '2026-06-10', '2026-06-20', 'S')]);
    await expect(expandParentsToEncompass('S', 'user-1')).resolves.toBeUndefined();
    expect(get('S').start_date).toBe('2026-06-10'); // unchanged; self is skipped

    // 2-cycle: A ↔ B. A carries dates, B is empty. Expansion converges.
    seed([
      task('A', '2026-06-01', '2026-06-10', 'B'),
      task('B', null, null, 'A'),
    ]);
    await expect(expandParentsToEncompass('A', 'user-1')).resolves.toBeUndefined();
    // B gets populated from A, then the walk stops (A already encompasses B).
    expect(get('B').start_date).toBe('2026-06-01');
    expect(get('B').due_date).toBe('2026-06-10');
    expect(get('A').start_date).toBe('2026-06-01');
    expect(get('A').due_date).toBe('2026-06-10');
  });
});

// ---------------------------------------------------------------------------
// Whole-bar MOVE (feat/timeline-move-children).
//
// shiftSubtreeDates walks DOWN the subtree (both parent models) and slides every
// descendant's set date bounds by a fixed day delta, so dragging a parent bar
// carries its children along. The root itself is excluded — it has already been
// moved by the edit that triggered the shift. A visited-set makes a diamond-
// reachable descendant shift exactly once (writes are absolute date reads +
// delta, so a double-visit would double-shift).
// ---------------------------------------------------------------------------
describe('shiftSubtreeDates (whole-bar move)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.tasks = new Map();
    ctx.links = [];
  });

  it('(g) slides every descendant by the delta; the root itself is untouched', async () => {
    seed([
      task('P', '2026-06-10', '2026-06-20'),
      task('C', '2026-06-05', '2026-06-25', 'P'),
      task('GC', '2026-06-06', '2026-06-08', 'C'),
    ]);

    await shiftSubtreeDates('P', 5, 'user-1');

    // root already moved by the caller — shift must not touch it again
    expect(get('P').start_date).toBe('2026-06-10');
    expect(get('P').due_date).toBe('2026-06-20');
    // direct child and grandchild both slide +5 days
    expect(get('C').start_date).toBe('2026-06-10');
    expect(get('C').due_date).toBe('2026-06-30');
    expect(get('GC').start_date).toBe('2026-06-11');
    expect(get('GC').due_date).toBe('2026-06-13');
  });

  it('(h) shifts backward on a negative delta', async () => {
    seed([
      task('P', '2026-06-10', '2026-06-20'),
      task('C', '2026-06-10', '2026-06-20', 'P'),
    ]);

    await shiftSubtreeDates('P', -3, 'user-1');

    expect(get('C').start_date).toBe('2026-06-07');
    expect(get('C').due_date).toBe('2026-06-17');
  });

  it('(i) shifts only the dates that are set; a null bound stays null', async () => {
    seed([
      task('P', '2026-06-10', '2026-06-20'),
      task('C', null, '2026-06-25', 'P'),
    ]);

    await shiftSubtreeDates('P', 5, 'user-1');

    expect(get('C').start_date).toBeNull();
    expect(get('C').due_date).toBe('2026-06-30');
  });

  it('(j) shifts a diamond-reachable descendant exactly once', async () => {
    // D is a child of B (legacy FK) AND C (join table); both B and C are
    // children of A. The visited-set must keep D from shifting twice.
    seed(
      [
        task('A', '2026-06-10', '2026-06-20'),
        task('B', '2026-06-10', '2026-06-12', 'A'),
        task('C', '2026-06-10', '2026-06-12', 'A'),
        task('D', '2026-06-11', '2026-06-11', 'B'),
      ],
      [{ task_id: 'D', parent_task_id: 'C' }],
    );

    await shiftSubtreeDates('A', 5, 'user-1');

    // +5 once, not +10
    expect(get('D').start_date).toBe('2026-06-16');
    expect(get('D').due_date).toBe('2026-06-16');
  });

  it('(k) a zero delta is a no-op (no writes, no broadcast)', async () => {
    seed([
      task('P', '2026-06-10', '2026-06-20'),
      task('C', '2026-06-10', '2026-06-20', 'P'),
    ]);

    await shiftSubtreeDates('P', 0, 'user-1');

    expect(get('C').start_date).toBe('2026-06-10');
    expect(get('C').due_date).toBe('2026-06-20');
    expect(broadcastToProject).not.toHaveBeenCalled();
  });

  it('(l) a null-dated descendant is skipped but its own children still shift', async () => {
    // P → M (no dates) → L (dated). M can't shift, but the walk must not stop
    // at M — L underneath it still slides.
    seed([
      task('P', '2026-06-10', '2026-06-20'),
      task('M', null, null, 'P'),
      task('L', '2026-06-12', '2026-06-14', 'M'),
    ]);

    await shiftSubtreeDates('P', 5, 'user-1');

    expect(get('M').start_date).toBeNull();
    expect(get('M').due_date).toBeNull();
    expect(get('L').start_date).toBe('2026-06-17');
    expect(get('L').due_date).toBe('2026-06-19');
  });
});
