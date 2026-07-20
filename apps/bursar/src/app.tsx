import { ShoppingCart } from 'lucide-react';
import { RequestScopePage } from './pages/request-scope';

/**
 * M0 scaffold shell + the M3 Scope Tree editor route.
 *
 * The full shell (sidebar, top bar with the shared Launchpad / org switcher / notifications bell /
 * Help Center, and the Matrix, Diff, review queue, and settings pages) arrives in M6. For now a
 * minimal path router serves the Scope Tree editor at /bursar/requests/:id, which is enough to
 * drive the M3 API (derive, review citations, apply library, promote rivals, confirm).
 */

// Matches /bursar/requests/<uuid-ish> and captures the id.
const REQUEST_SCOPE_RE = /\/bursar\/requests\/([0-9a-fA-F-]{8,})\/?$/;

function ScaffoldShell() {
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
          Open a request at <code>/bursar/requests/&lt;id&gt;</code> to derive and confirm its scope tree.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const match = REQUEST_SCOPE_RE.exec(window.location.pathname);
  if (match) return <RequestScopePage requestId={match[1]!} />;
  return <ScaffoldShell />;
}
