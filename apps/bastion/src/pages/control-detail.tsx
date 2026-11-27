import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { ExceptionRow } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { hiddenItemsSentence } from '@/lib/wording';
import {
  useAcknowledgeDrift,
  useCheckControlNow,
  useCheckEvidenceHistory,
  useControl,
  useControlEvidence,
  useCoverage,
  useDrift,
  useExceptions,
  useFixDrafts,
  useGaps,
  useProposeException,
} from '@/hooks/use-bastion';

// Control detail (spec 6.1): the effective state in words ("Not met, risk accepted" names the
// owner and the expiry), requirement chips, the evidence timeline, exceptions, fixes, the Bam
// task, Check now, and Accept this as a risk. Plain language: no ids, keys or hashes (spec 6.2).

const OUTCOME_WORDS: Record<string, string> = { pass: 'Proven', fail: 'Not met', unprovable: "Can't prove yet" };

// The refs the probes cite (migration 0279) plus app entities, in words.
const ENTITY_WORDS: Record<string, string> = {
  api_key: 'API key',
  user: 'person',
  github_pr_event: 'code change',
  'blip.tracked_app': 'app',
  'bursar.vendor': 'supplier',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A check's earlier results, behind "Earlier results" (#403). The Evidence list shows each check
 * once, with its newest result; every evaluation run's copy stays one click away here.
 */
function CheckHistory({ controlId, assertionId, latestId }: { controlId: string; assertionId: string; latestId: string }) {
  const [open, setOpen] = useState(false);
  const history = useCheckEvidenceHistory(controlId, assertionId, open);
  const earlier = (history.data?.data ?? []).filter((h) => h.id !== latestId);
  return (
    <div className="mt-1">
      <button type="button" className="text-xs text-primary-700 dark:text-primary-300 hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide earlier results' : 'Earlier results'}
      </button>
      {open &&
        (history.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : earlier.length === 0 ? (
          <p className="text-xs text-zinc-500">No earlier results for this check.</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400" data-testid="check-history">
            {earlier.map((h) => (
              <li key={h.id}>
                {OUTCOME_WORDS[h.outcome]} · {formatDate(h.created_at)}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function activeRisk(exceptions: ExceptionRow[]): ExceptionRow | null {
  return exceptions.filter((e) => e.status === 'active').sort((a, b) => a.expires_at.localeCompare(b.expires_at))[0] ?? null;
}

function AcceptRiskForm({ controlId, onDone }: { controlId: string; onDone: () => void }) {
  const control = useControl(controlId);
  const evidence = useControlEvidence(controlId);
  const propose = useProposeException();
  const [scope, setScope] = useState<'entity' | 'assertion'>('entity');
  const [assertionId, setAssertionId] = useState('');
  const [item, setItem] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [until, setUntil] = useState(plusDays(30));
  const checks = (control.data?.data.assertions ?? []).filter((a) => a.review_status === 'confirmed');
  const failing = (evidence.data?.data ?? []).filter((s) => s.outcome === 'fail');
  const items = failing.flatMap((s) =>
    (s.cited_items ?? s.cited_refs.map((r) => ({ ...r, label: null }))).map((r) => ({ ...r, assertion_id: s.assertion_id })),
  );
  const uniqueItems = items.filter((r, i) => items.findIndex((x) => x.entity_id === r.entity_id) === i);
  const max = scope === 'entity' ? 365 : 90;

  return (
    <form
      className="space-y-3 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const picked = uniqueItems[Number(item)];
        propose.mutate(
          {
            control_id: controlId,
            scope,
            assertion_id: scope === 'assertion' ? assertionId : (picked?.assertion_id ?? null),
            cited_entity_type: scope === 'entity' ? (picked?.entity_type ?? null) : null,
            cited_entity_id: scope === 'entity' ? (picked?.entity_id ?? null) : null,
            reason: reason.trim(),
            compensating_note: note.trim() || null,
            expires_on: until,
          },
          { onSuccess: onDone },
        );
      }}
    >
      <p className="text-sm font-semibold">Accept this as a risk</p>
      <p className="text-xs text-zinc-500">
        Someone other than you approves it in the Review queue. It still counts under Not met, and it runs out on the date you pick.
      </p>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" checked={scope === 'entity'} onChange={() => setScope('entity')} /> One item (up to a year)
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={scope === 'assertion'} onChange={() => setScope('assertion')} /> A whole check (up to 90 days)
        </label>
      </div>
      {scope === 'entity' ? (
        uniqueItems.length === 0 ? (
          <p className="text-xs text-amber-700">There is no failing item you can see on this control. Pick a whole check instead.</p>
        ) : (
          <select aria-label="Item" className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm" value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">Pick the item</option>
            {uniqueItems.map((r, i) => (
              <option key={r.entity_id} value={String(i)}>
                {r.label ?? `Failing ${ENTITY_WORDS[r.entity_type] ?? 'item'} ${i + 1}`}
              </option>
            ))}
          </select>
        )
      ) : (
        <select aria-label="Check" className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm" value={assertionId} onChange={(e) => setAssertionId(e.target.value)}>
          <option value="">Pick the check</option>
          {checks.map((a) => (
            <option key={a.id} value={a.id}>
              {a.plain_statement}
            </option>
          ))}
        </select>
      )}
      <textarea aria-label="Why is this risk acceptable?" placeholder="Why is this risk acceptable?" className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
      <input aria-label="What do you do instead? (optional)" placeholder="What do you do instead? (optional)" className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
      <label className="flex items-center gap-2 text-sm">
        Accepted until
        <input type="date" aria-label="Accepted until" min={plusDays(1)} max={plusDays(max)} value={until} onChange={(e) => setUntil(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1" />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!reason.trim() || propose.isPending || (scope === 'entity' ? item === '' : !assertionId)}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white disabled:opacity-50"
        >
          Send for approval
        </button>
        <button type="button" className="px-3 py-1.5 rounded-lg text-sm border border-zinc-300 dark:border-zinc-700" onClick={onDone}>
          Cancel
        </button>
      </div>
      {propose.error && <p className="text-xs text-red-600">{friendlyError(propose.error)}</p>}
    </form>
  );
}

export function ControlDetailPage({ controlId, onNavigate }: { controlId: string; onNavigate: (path: string) => void }) {
  const control = useControl(controlId);
  const coverage = useCoverage({});
  const evidence = useControlEvidence(controlId);
  const exceptions = useExceptions({ control_id: controlId });
  const canReadFixes = useCan('bastion.fix.read');
  const fixes = useFixDrafts({ control_id: controlId }, canReadFixes);
  const drift = useDrift({ control_id: controlId });
  const gaps = useGaps({ control_id: controlId });
  const checkNow = useCheckControlNow();
  const ack = useAcknowledgeDrift();
  const canRun = useCan('bastion.evaluation.run');
  const canPropose = useCan('bastion.exception.propose');
  const canAck = useCan('bastion.drift.acknowledge');
  const [accepting, setAccepting] = useState(false);

  if (control.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }
  if (control.error || !control.data) {
    return <p className="p-8 text-sm text-red-600">{control.error ? friendlyError(control.error) : 'This control could not be loaded.'}</p>;
  }
  const c = control.data.data;
  const row = coverage.data?.data.find((r) => r.control_id === controlId);
  const risk = activeRisk(exceptions.data?.data ?? []);
  const checks = c.assertions.filter((a) => a.review_status === 'confirmed');
  const statementOf = (id: string) => checks.find((a) => a.id === id)?.plain_statement ?? 'A check';
  const task = (drift.data?.data ?? []).find((d) => d.bam_task_human_id);

  return (
    <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
      <button type="button" className="flex items-center gap-1 text-sm text-zinc-600 hover:underline" onClick={() => onNavigate('/controls')}>
        <ArrowLeft className="h-4 w-4" /> Controls
      </button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{c.title}</h1>
          {c.plain_summary && <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{c.plain_summary}</p>}
          <div className="mt-2 flex flex-wrap gap-1">
            {c.requirements.map((r) => (
              <span key={r.id} className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs text-zinc-700 dark:text-zinc-300">
                {r.ref_code}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          {canRun && (
            <button
              type="button"
              disabled={checkNow.isPending}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
              onClick={() => checkNow.mutate(controlId)}
            >
              {checkNow.isPending ? 'Checking...' : 'Check now'}
            </button>
          )}
          {canPropose && !accepting && (
            <button type="button" className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white" onClick={() => setAccepting(true)}>
              Accept this as a risk
            </button>
          )}
        </div>
      </div>
      {checkNow.isSuccess && <p className="text-xs text-zinc-600">Checking now. The result shows here in a minute or two.</p>}
      {checkNow.error && <p className="text-xs text-red-600">{friendlyError(checkNow.error)}</p>}

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4" data-testid="control-state">
        <p className="text-lg font-semibold" data-testid="control-state-words">
          {row?.state_words ?? 'Not set up yet'}
        </p>
        {row?.reason_words && <p className="text-sm text-zinc-600 dark:text-zinc-400">{row.reason_words}</p>}
        {risk && (
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1" data-testid="risk-accepted">
            Risk accepted until {formatDate(risk.expires_at)}
            {risk.owner_name ? `. Owner: ${risk.owner_name}` : ''}
            {risk.approval_label ? ` (${risk.approval_label})` : risk.decided_by_name ? `. Approved by ${risk.decided_by_name}` : ''}. {risk.reason}
          </p>
        )}
        {row?.owner_name && !risk && <p className="text-xs text-zinc-500 mt-1">Owner: {row.owner_name}</p>}
        {task && (
          <p className="text-xs text-zinc-600 mt-1">
            Task:{' '}
            <a className="text-primary-700 dark:text-primary-400 hover:underline" href={`/b3/tasks/ref/${task.bam_task_human_id}`}>
              {task.bam_task_human_id}
            </a>{' '}
            ({task.task_words.toLowerCase()})
          </p>
        )}
      </div>

      {accepting && <AcceptRiskForm controlId={controlId} onDone={() => setAccepting(false)} />}

      {(gaps.data?.data.length ?? 0) > 0 && (
        <section className="space-y-1">
          <h2 className="text-sm font-semibold">What needs doing</h2>
          <ul className="text-sm list-disc pl-5">
            {(gaps.data?.data ?? []).map((g) => (
              <li key={g.id}>
                {g.gap_words}
                {g.fix_words ? ` (${g.fix_words.toLowerCase()})` : ''}
              </li>
            ))}
          </ul>
          <button type="button" className="text-xs text-primary-700 dark:text-primary-400 hover:underline" onClick={() => onNavigate('/gaps')}>
            Draft a fix in What to fix first
          </button>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Evidence</h2>
        {(evidence.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">Nothing has been checked yet. The nightly check fills this in, or use Check now.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4" data-testid="evidence-timeline">
            {(evidence.data?.data ?? []).map((s) => (
              <li key={s.id} className="py-2 text-sm">
                <span className="font-medium">{OUTCOME_WORDS[s.outcome]}</span> · {formatDate(s.created_at)} · {statementOf(s.assertion_id)}
                <CheckHistory controlId={controlId} assertionId={s.assertion_id} latestId={s.id} />
                {s.explanation && <p className="text-xs text-zinc-600 dark:text-zinc-400">{s.explanation}</p>}
                {(s.cited_labels?.length ?? 0) > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1" data-testid="cited-chips">
                    {(s.cited_labels ?? []).map((l) => (
                      <span key={l} className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs">
                        {l}
                      </span>
                    ))}
                  </div>
                )}
                {hiddenItemsSentence(s.hidden_citation_count) && (
                  <p className="text-xs text-zinc-500" data-testid="hidden-citations">
                    {hiddenItemsSentence(s.hidden_citation_count)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Accepted risks</h2>
        {(exceptions.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">None.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {(exceptions.data?.data ?? []).map((e) => (
              <li key={e.id}>
                {e.status === 'active' ? 'Accepted' : e.status === 'proposed' ? 'Waiting for approval' : e.status === 'expired' ? 'Ran out' : 'Not approved'} ·{' '}
                {e.scope === 'entity' ? 'one item' : 'a whole check'} until {formatDate(e.expires_at)} · {e.reason}
                {e.approval_label ? ` (${e.approval_label})` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canReadFixes && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Fixes</h2>
          {(fixes.data?.data.length ?? 0) === 0 ? (
            <p className="text-sm text-zinc-500">No fixes drafted.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {(fixes.data?.data ?? []).map((f) => (
                <li key={f.id}>
                  {f.title} · {f.status === 'proposed' ? 'waiting for a decision' : f.status.replace('_', ' ')}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">When it got worse</h2>
        {(drift.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">No changes for the worse.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 text-sm">
            {(drift.data?.data ?? []).map((d) => (
              <li key={d.id} className="py-2 flex items-center justify-between gap-3">
                <span>
                  {formatDate(d.detected_at)}: {d.from_words} to {d.to_words} ({d.reason_words}). {d.task_words}
                  {d.bam_task_human_id ? ` ${d.bam_task_human_id}` : ''}.
                </span>
                {d.acknowledged_at ? (
                  <span className="text-xs text-zinc-500">Seen by {d.acknowledged_by_name ?? 'someone'}</span>
                ) : (
                  canAck && (
                    <button type="button" className="text-xs text-primary-700 dark:text-primary-400 hover:underline" onClick={() => ack.mutate(d.id)}>
                      Acknowledge
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
        {ack.error && <p className="text-xs text-red-600">{friendlyError(ack.error)}</p>}
      </section>
    </div>
  );
}
