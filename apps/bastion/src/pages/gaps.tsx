import { useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { GapRow } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { useDismissGap, useGaps, useProposeFix, useSummary } from '@/hooks/use-bastion';

// What to fix first (spec 6.1, 2.3): the ranked gap list, "Quick wins" (risk per unit of effort),
// the org-level "checks are stale" row, and "Accepted risks" (never a gap). Drafting a fix files a
// proposal a person decides in the Review queue.

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function GapItem({ g, onNavigate }: { g: GapRow; onNavigate: (path: string) => void }) {
  const canDraft = useCan('bastion.fix.draft');
  const canDismiss = useCan('bastion.gap.dismiss');
  const propose = useProposeFix();
  const dismiss = useDismissGap();
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const error = propose.error ?? dismiss.error;

  return (
    <li className="py-3 space-y-2" data-testid="gap-row">
      <div className="flex items-start justify-between gap-4">
        <div>
          <button type="button" className="text-sm font-medium text-primary-700 dark:text-primary-400 hover:underline text-left" onClick={() => onNavigate(`/controls/${g.control_id}`)}>
            {g.control_title}
          </button>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {g.gap_words}
            {g.owner_name ? ` · Owner: ${g.owner_name}` : ''}
            {g.fix_words ? ` · Fix: ${g.fix_words}` : ' · Needs whoever runs this installation'}
          </p>
          {g.assertion_statement && <p className="text-xs text-zinc-500 mt-0.5">{g.assertion_statement}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {g.status === 'proposed' ? (
            <button type="button" className="text-xs text-amber-700 dark:text-amber-400 hover:underline" onClick={() => onNavigate('/review')}>
              Fix drafted, waiting for a decision
            </button>
          ) : (
            <>
              {canDraft && g.fix_template && (
                <button
                  type="button"
                  disabled={propose.isPending}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
                  onClick={() => propose.mutate(g.id, { onSuccess: () => onNavigate('/review') })}
                >
                  {propose.isPending ? 'Drafting...' : 'Draft the fix'}
                </button>
              )}
              {canDismiss && (
                <button type="button" className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 dark:border-zinc-700" onClick={() => setDismissing((v) => !v)}>
                  Dismiss
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {dismissing && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) dismiss.mutate({ id: g.id, reason: reason.trim() }, { onSuccess: () => setDismissing(false) });
          }}
        >
          <input
            aria-label="Why does this not need fixing?"
            placeholder="Why does this not need fixing?"
            className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" disabled={!reason.trim() || dismiss.isPending} className="px-3 py-1 rounded-md text-sm bg-zinc-800 text-white disabled:opacity-50">
            Dismiss gap
          </button>
        </form>
      )}
      {error && <p className="text-xs text-red-600">{friendlyError(error)}</p>}
    </li>
  );
}

export function GapsPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [sort, setSort] = useState<'risk' | 'quick_wins'>('risk');
  const [frameworkId, setFrameworkId] = useState('');
  const summary = useSummary({ framework_id: frameworkId || undefined });
  const gaps = useGaps({ sort, framework_id: frameworkId || undefined });
  const frameworks = summary.data?.data.frameworks ?? [];

  return (
    <div className="max-w-5xl mx-auto px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">What to fix first</h1>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-sm">
            {(['risk', 'quick_wins'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sort === s}
                className={sort === s ? 'px-3 py-1 bg-primary-600 text-white' : 'px-3 py-1'}
                onClick={() => setSort(s)}
              >
                {s === 'risk' ? 'Biggest risks' : 'Quick wins'}
              </button>
            ))}
          </div>
          <select
            aria-label="Framework"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={frameworkId}
            onChange={(e) => setFrameworkId(e.target.value)}
          >
            <option value="">All frameworks</option>
            {frameworks.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {gaps.isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      )}
      {gaps.error && <p className="text-sm text-red-600">{friendlyError(gaps.error)}</p>}
      {gaps.data && (
        <>
          {gaps.data.stale && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200" data-testid="stale-row">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              {gaps.data.stale.message}
            </div>
          )}
          {gaps.data.data.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center text-sm text-zinc-700 dark:text-zinc-300">
              Nothing to fix right now. Bastion re-ranks this list after every nightly check.
            </div>
          ) : (
            <ol className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4" data-testid="gap-list">
              {gaps.data.data.map((g) => (
                <GapItem key={g.id} g={g} onNavigate={onNavigate} />
              ))}
            </ol>
          )}

          <section className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              <ShieldCheck className="h-4 w-4" /> Accepted risks ({gaps.data.accepted_risks.length})
            </h2>
            <p className="text-xs text-zinc-500">These still count under Not met. They are listed here so nobody forgets when they run out.</p>
            {gaps.data.accepted_risks.length > 0 && (
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4" data-testid="accepted-risks">
                {gaps.data.accepted_risks.map((r) => (
                  <li key={r.id} className="py-3 text-sm">
                    <button type="button" className="font-medium text-primary-700 dark:text-primary-400 hover:underline" onClick={() => onNavigate(`/controls/${r.control_id}`)}>
                      {r.control_title}
                    </button>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      Not met, risk accepted until {formatDate(r.expires_at)}
                      {r.owner_name ? ` · Owner: ${r.owner_name}` : ''}
                      {r.approval_label ? ` · ${r.approval_label}` : r.approved_by_name ? ` · Approved by ${r.approved_by_name}` : ''}
                    </p>
                    <p className="text-xs text-zinc-500">{r.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
