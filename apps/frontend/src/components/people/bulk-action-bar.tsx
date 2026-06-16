import { useCallback, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';

/**
 * Shared bulk-action primitive (People Manager v2 — plan §7 / §12).
 *
 * Both the legacy People page (`pages/people/index.tsx`) and the SuperUser
 * people list (`pages/superuser/people-list.tsx`) carried near-identical
 * `runBulk` engines plus a duplicated floating toolbar + progress toast. This
 * module lifts that pattern into ONE reusable place:
 *
 *   - `useBulkRun<T>()`  — a parallel, bounded, per-row-resilient fan-out hook
 *                          that captures succeeded / failed / skipped and feeds
 *                          a live progress toast.
 *   - `<BulkActionBar>`  — the presentational floating toolbar (caller supplies
 *                          its verb buttons via `children`).
 *   - `<BulkProgressToast>` — the live progress toast (mounted by
 *                          `<BulkActionBar>` automatically).
 *
 * The hook is intentionally generic: the caller decides how to identify a row
 * (`getId` / `getName`), whether to pre-skip a row (`skip`), and what async
 * mutation to run (`action`). That keeps the org-scoping + caps-gating logic in
 * the page (where the org context lives) while the resilience/progress
 * machinery is shared.
 */

export interface BulkSkip {
  id: string;
  name: string;
  /** Short machine-ish reason, e.g. 'self', 'rank', 'caps', 'noop'. */
  reason: string;
}

export interface BulkFailure {
  id: string;
  name: string;
  reason: string;
}

export interface BulkProgress {
  label: string;
  done: number;
  total: number;
  succeeded: number;
  failed: BulkFailure[];
  skipped: BulkSkip[];
  finished: boolean;
}

/** Bound the number of in-flight mutations so a 200-row bulk doesn't open 200
 *  sockets at once. The old per-page engines used an unbounded `Promise.all`;
 *  this keeps the same wall-clock for small selections but is gentler at scale. */
const DEFAULT_CONCURRENCY = 8;

/** Run `tasks` with at most `limit` in flight at a time. Settles all of them. */
async function runBounded(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      if (task) await task();
    }
  };
  const n = Math.min(Math.max(1, limit), tasks.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
}

export interface RunBulkOptions<T> {
  /** Human label shown in the toast, e.g. "Disabling", "Changing role to admin". */
  label: string;
  /** The rows to act on (already filtered to the selection by the caller). */
  targets: T[];
  /** The async mutation to run for one row. Throw to record a per-row failure. */
  action: (target: T) => Promise<unknown>;
  /**
   * Pre-flight skip check. Return a reason string to SKIP the row (counted as
   * skipped, never attempted); return `null` to run it. This is where the
   * caller folds in self-skip, rank-skip, caps-skip, and no-op filtering.
   */
  skip?: (target: T) => string | null;
  /** Max in-flight mutations (default 8). */
  concurrency?: number;
}

export interface UseBulkRunResult<T> {
  /** The live progress record, or `null` when no bulk run is active. */
  progress: BulkProgress | null;
  /** Dismiss the toast. */
  dismiss: () => void;
  /**
   * Fan `action` out across `targets`, skipping per `skip`, capturing
   * succeeded / failed / skipped, and driving the progress toast. Resolves
   * once every runnable row has settled. `onSettled` (if given) fires after
   * the run completes — use it to invalidate queries / clear selection.
   */
  runBulk: (options: RunBulkOptions<T>, onSettled?: () => void) => Promise<BulkProgress>;
}

/**
 * The shared fan-out hook. Generic over the row type `T` so it serves both the
 * single-org `PersonListItem` rows and the multi-org `ScopedPerson` rows.
 *
 * @param getId   stable id for a row (used for de-dup keys in the toast lists)
 * @param getName display label for a row (shown in skipped/failed lists)
 */
export function useBulkRun<T>(
  getId: (target: T) => string,
  getName: (target: T) => string,
): UseBulkRunResult<T> {
  const [progress, setProgress] = useState<BulkProgress | null>(null);

  const dismiss = useCallback(() => setProgress(null), []);

  const runBulk = useCallback(
    async (options: RunBulkOptions<T>, onSettled?: () => void): Promise<BulkProgress> => {
      const { label, targets, action, skip, concurrency = DEFAULT_CONCURRENCY } = options;

      const skipped: BulkSkip[] = [];
      const runnable: T[] = [];
      for (const t of targets) {
        const reason = skip?.(t) ?? null;
        if (reason) {
          skipped.push({ id: getId(t), name: getName(t), reason });
          continue;
        }
        runnable.push(t);
      }

      const total = runnable.length;
      const failed: BulkFailure[] = [];
      let done = 0;
      let succeeded = 0;

      const initial: BulkProgress = {
        label,
        done: 0,
        total,
        succeeded: 0,
        failed: [],
        skipped,
        finished: total === 0,
      };
      setProgress(initial);

      if (total === 0) {
        onSettled?.();
        return initial;
      }

      await runBounded(
        runnable.map((t) => async () => {
          try {
            await action(t);
            succeeded += 1;
          } catch (err) {
            failed.push({
              id: getId(t),
              name: getName(t),
              reason: (err as Error)?.message ?? 'failed',
            });
          } finally {
            done += 1;
            setProgress((prev) =>
              prev
                ? {
                    ...prev,
                    done,
                    succeeded,
                    failed: [...failed],
                    finished: done === total,
                  }
                : prev,
            );
          }
        }),
        concurrency,
      );

      onSettled?.();
      return {
        label,
        done: total,
        total,
        succeeded,
        failed,
        skipped,
        finished: true,
      };
    },
    [getId, getName],
  );

  return { progress, dismiss, runBulk };
}

interface BulkActionBarProps {
  /** Number of selected rows (drives the count pill + auto show/hide). */
  selectedCount: number;
  /** The verb buttons / dropdowns. */
  children: ReactNode;
  /** Clear the current selection. */
  onClear: () => void;
  /** Live progress to surface in the toast (pass `useBulkRun().progress`). */
  progress: BulkProgress | null;
  /** Dismiss the toast (pass `useBulkRun().dismiss`). */
  onDismissProgress: () => void;
}

/**
 * Floating bulk-action toolbar + live progress toast. Renders nothing when
 * `selectedCount` is 0 and no progress toast is showing. Lifted verbatim
 * (styling-wise) from the duplicated copies on the two People pages so the UX
 * is pixel-identical everywhere.
 */
export function BulkActionBar({
  selectedCount,
  children,
  onClear,
  progress,
  onDismissProgress,
}: BulkActionBarProps) {
  return (
    <>
      <AnimatePresence>
        {selectedCount > 0 && (
          <motion.div
            key="bulk-toolbar"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[min(calc(100vw-2rem),56rem)] max-w-4xl"
          >
            <div className="flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 shadow-lg shadow-zinc-900/10 dark:shadow-black/40">
              <span className="inline-flex items-center rounded-full bg-primary-100 dark:bg-primary-900/40 px-2.5 py-0.5 text-xs font-medium text-primary-700 dark:text-primary-300 tabular-nums">
                {selectedCount} selected
              </span>

              {children}

              <div className="flex-1" />
              <button
                type="button"
                onClick={onClear}
                className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                Clear selection
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <BulkProgressToast progress={progress} onDismiss={onDismissProgress} />
    </>
  );
}

interface BulkProgressToastProps {
  progress: BulkProgress | null;
  onDismiss: () => void;
}

/** The live progress toast: a determinate bar while running, then a
 *  succeeded / failed / skipped tally with per-row detail lists. */
export function BulkProgressToast({ progress, onDismiss }: BulkProgressToastProps) {
  return (
    <AnimatePresence>
      {progress && (
        <motion.div
          key="bulk-progress"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="fixed bottom-24 right-6 z-50 w-80 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {progress.finished
                ? 'Done'
                : `${progress.label} ${progress.done} of ${progress.total}…`}
            </div>
            <button
              type="button"
              onClick={onDismiss}
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="px-4 py-3 space-y-2 text-xs text-zinc-600 dark:text-zinc-300">
            {!progress.finished && progress.total > 0 && (
              <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-primary-500 transition-all"
                  style={{
                    width: `${Math.round((progress.done / progress.total) * 100)}%`,
                  }}
                />
              </div>
            )}
            {progress.finished && (
              <>
                <div>
                  {progress.succeeded} succeeded
                  {progress.failed.length > 0 && `, ${progress.failed.length} failed`}
                  {progress.skipped.length > 0 && `, ${progress.skipped.length} skipped`}
                </div>
                {progress.failed.length > 0 && (
                  <ul className="space-y-0.5 text-red-600 dark:text-red-400 max-h-24 overflow-auto">
                    {progress.failed.map((f) => (
                      <li key={`f-${f.id}`}>
                        {f.name}: {f.reason}
                      </li>
                    ))}
                  </ul>
                )}
                {progress.skipped.length > 0 && (
                  <ul className="space-y-0.5 text-zinc-500 max-h-24 overflow-auto">
                    {progress.skipped.map((s) => (
                      <li key={`s-${s.id}`}>
                        {s.name}: skipped ({s.reason})
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
