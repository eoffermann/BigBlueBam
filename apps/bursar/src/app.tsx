import { ShoppingCart } from 'lucide-react';

/**
 * M0 SCAFFOLD SHELL.
 *
 * This exists so `/bursar/` serves a real document rather than a white screen the moment the
 * nginx blocks and the frontend image land. The full shell (sidebar, top bar with the shared
 * Launchpad / org switcher / notifications bell / Help Center, and the Matrix, Diff, review
 * queue, and settings pages) arrives in later milestones alongside the routes that feed it.
 */
export function App() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto w-14 h-14 rounded-xl bg-primary-600 flex items-center justify-center">
          <ShoppingCart className="w-7 h-7 text-white" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Bursar</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Vendor-side procurement: exclusion diffing, scope coverage, and the spend baseline.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          Scaffold is live. The application shell is under construction.
        </p>
      </div>
    </div>
  );
}
