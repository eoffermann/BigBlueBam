import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getImpersonation } from '@bigbluebam/ui/impersonation-banner';
import { useCan } from '@bigbluebam/ui/use-can';
import type { ExceptionRow, FixDraftRow } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth.store';
import { useDecideException, useDecideFix, useExceptions, useFixDrafts, useManualEvidence, useMarkFixApplied, useSetup } from '@/hooks/use-bastion';

// Review queue (spec 6.1): fix and exception decisions are made HERE, by a signed-in person who is
// not impersonating (spec 2.8). The queue also points at proposed checks (Setup), evidence
// waiting for a second person, and stuck scans (Evidence locker). Low-confidence answers and
// auditor requests join at M8 and M9.

const IMPERSONATING_NOTE = 'You are viewing Bastion as another person. Only that person can decide this.';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function FixCard({ d, onNavigate }: { d: FixDraftRow; onNavigate: (path: string) => void }) {
  const userId = useAuthStore((s) => s.user?.id);
  const canDecide = useCan('bastion.fix.decide');
  const canControlWrite = useCan('bastion.control.write');
  const decide = useDecideFix();
  const impersonating = getImpersonation() !== null;
  const mayDecide = canDecide && (canControlWrite || d.owner_user_id === userId);
  const rule = (d.payload?.bolt_rule as { actions?: Array<{ mcp_tool: string }> } | undefined) ?? undefined;

  return (
    <li className="py-4 space-y-2" data-testid="fix-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{d.title}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {d.template_words}
            {d.control_title ? ' for ' : ''}
            {d.control_id && (
              <button type="button" className="text-primary-700 dark:text-primary-400 hover:underline" onClick={() => onNavigate(`/controls/${d.control_id}`)}>
                {d.control_title}
              </button>
            )}
            {d.created_by_name ? ` · drafted by ${d.created_by_name}${d.created_by_kind === 'agent' ? ' (an AI agent)' : ''}` : ''}
            {d.proposal_expires_at ? ` · decide by ${formatDate(d.proposal_expires_at)}` : ''}
          </p>
        </div>
        {mayDecide ? (
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              disabled={impersonating || decide.isPending}
              title={impersonating ? IMPERSONATING_NOTE : undefined}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
              onClick={() => decide.mutate({ id: d.id, decision: 'approve' })}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={impersonating || decide.isPending}
              title={impersonating ? IMPERSONATING_NOTE : undefined}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
              onClick={() => decide.mutate({ id: d.id, decision: 'reject' })}
            >
              Reject
            </button>
          </div>
        ) : (
          <p className="text-xs text-zinc-500 shrink-0">{d.owner_name ? `${d.owner_name} decides this` : 'The control owner decides this'}</p>
        )}
      </div>
      {d.body_markdown && <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-line">{d.body_markdown}</p>}
      {rule?.actions && (
        <p className="text-xs text-zinc-500">
          Approving lets you create this automation in Bolt, turned off. It only {rule.actions.map((a) => (a.mcp_tool === 'create_task' ? 'creates a task in the Compliance project' : 'posts in a Banter channel')).join(' and ')}.
        </p>
      )}
      {d.hidden_citation_count > 0 && <p className="text-xs text-zinc-500">{d.hidden_citation_count} cited item(s) are hidden because you cannot see them.</p>}
      {impersonating && mayDecide && <p className="text-xs text-amber-700">{IMPERSONATING_NOTE}</p>}
      {decide.error && <p className="text-xs text-red-600">{friendlyError(decide.error)}</p>}
    </li>
  );
}

function ExceptionCard({ e, onNavigate }: { e: ExceptionRow; onNavigate: (path: string) => void }) {
  const userId = useAuthStore((s) => s.user?.id);
  const canApprove = useCan('bastion.exception.approve');
  const decide = useDecideException();
  const impersonating = getImpersonation() !== null;
  const own = e.proposed_by === userId;

  return (
    <li className="py-4 space-y-2" data-testid="exception-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Accept a risk on{' '}
            <button type="button" className="text-primary-700 dark:text-primary-400 hover:underline" onClick={() => onNavigate(`/controls/${e.control_id}`)}>
              {e.control_title}
            </button>
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {e.scope === 'entity' ? 'One item' : 'A whole check'} until {formatDate(e.expires_at)}
            {e.proposed_by_name ? ` · proposed by ${e.proposed_by_name}` : ''}
            {e.owner_name ? ` · Owner: ${e.owner_name}` : ''}
          </p>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1">{e.reason}</p>
          {e.compensating_note && <p className="text-xs text-zinc-500">What we do instead: {e.compensating_note}</p>}
        </div>
        {canApprove && (
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              disabled={impersonating || decide.isPending}
              title={impersonating ? IMPERSONATING_NOTE : own ? 'Someone else has to approve what you proposed, unless your team has fewer than three people.' : undefined}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
              onClick={() => decide.mutate({ id: e.id, decision: 'approve' })}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={impersonating || decide.isPending}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
              onClick={() => decide.mutate({ id: e.id, decision: 'reject' })}
            >
              Reject
            </button>
          </div>
        )}
      </div>
      {own && <p className="text-xs text-zinc-500">You proposed this. Someone else has to approve it, unless your team has fewer than three people.</p>}
      {impersonating && canApprove && <p className="text-xs text-amber-700">{IMPERSONATING_NOTE}</p>}
      {decide.error && <p className="text-xs text-red-600">{friendlyError(decide.error)}</p>}
    </li>
  );
}

function AppliedCard({ d }: { d: FixDraftRow }) {
  const canMark = useCan('bastion.fix.mark_applied');
  const mark = useMarkFixApplied();
  const [ruleId, setRuleId] = useState('');
  const kind = d.template === 'bolt_rule' ? 'bolt.rule' : d.template === 'policy_draft' ? 'beacon.entry' : null;
  if (!canMark) return null;
  return (
    <li className="py-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm text-zinc-900 dark:text-zinc-100">{d.title}</p>
        <p className="text-xs text-zinc-500">Approved{d.decided_by_name ? ` by ${d.decided_by_name}` : ''}. Mark it as done once it is in place.</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          mark.mutate({ id: d.id, ...(kind && ruleId.trim() ? { applied_entity_type: kind, applied_entity_id: ruleId.trim() } : {}) });
        }}
      >
        {kind && (
          <input
            aria-label={kind === 'bolt.rule' ? 'Bolt automation id (optional)' : 'Beacon article id (optional)'}
            placeholder={kind === 'bolt.rule' ? 'Bolt automation id (optional)' : 'Beacon article id (optional)'}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs w-64"
            value={ruleId}
            onChange={(ev) => setRuleId(ev.target.value)}
          />
        )}
        <button type="submit" disabled={mark.isPending} className="px-3 py-1 rounded-md text-xs bg-zinc-800 text-white disabled:opacity-50">
          Mark as done
        </button>
      </form>
      {mark.error && <p className="w-full text-xs text-red-600">{friendlyError(mark.error)}</p>}
    </li>
  );
}

export function ReviewPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const canReadFixes = useCan('bastion.fix.read');
  const fixes = useFixDrafts({ status: 'proposed' }, canReadFixes);
  const approved = useFixDrafts({ status: 'approved' }, canReadFixes);
  const exceptions = useExceptions({ status: 'proposed' });
  const setup = useSetup();
  const pendingEvidence = useManualEvidence({ status: 'active' });
  const stuck = useManualEvidence({ stuck: true });

  const proposedChecks = setup.data?.data.steps.review.waiting ?? 0;
  const waitingReview = (pendingEvidence.data?.data ?? []).filter((e) => e.links.some((l) => l.review_verdict === 'pending')).length;
  const stuckCount = stuck.data?.data.length ?? 0;

  if (fixes.isLoading || exceptions.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-8 py-8 space-y-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Review queue</h1>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Fixes waiting for a decision ({fixes.data?.data.length ?? 0})</h2>
        {fixes.error && <p className="text-sm text-red-600">{friendlyError(fixes.error)}</p>}
        {(fixes.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">Nothing to decide. Draft a fix from What to fix first.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4" data-testid="fix-queue">
            {fixes.data!.data.map((d) => (
              <FixCard key={d.id} d={d} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Accepted risks waiting for a decision ({exceptions.data?.data.length ?? 0})</h2>
        {exceptions.error && <p className="text-sm text-red-600">{friendlyError(exceptions.error)}</p>}
        {(exceptions.data?.data.length ?? 0) > 0 && (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4" data-testid="exception-queue">
            {exceptions.data!.data.map((e) => (
              <ExceptionCard key={e.id} e={e} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </section>

      {(approved.data?.data.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Approved fixes to finish ({approved.data!.data.length})</h2>
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4">
            {approved.data!.data.map((d) => (
              <AppliedCard key={d.id} d={d} />
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-1 text-sm">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Also waiting</h2>
        <button type="button" className="block text-primary-700 dark:text-primary-400 hover:underline" onClick={() => onNavigate('/setup')}>
          Proposed checks to confirm: {proposedChecks}
        </button>
        <button type="button" className="block text-primary-700 dark:text-primary-400 hover:underline" onClick={() => onNavigate('/evidence')}>
          Evidence waiting for a second person: {waitingReview}
        </button>
        <button type="button" className="block text-primary-700 dark:text-primary-400 hover:underline" onClick={() => onNavigate('/evidence')}>
          Uploads stuck waiting for a virus scan: {stuckCount}
        </button>
      </section>
    </div>
  );
}
