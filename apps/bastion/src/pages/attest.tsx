import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { getImpersonation } from '@bigbluebam/ui/impersonation-banner';
import { useCan } from '@bigbluebam/ui/use-can';
import { friendlyError } from '@/lib/errors';
import { useAttest, useMyAttestations, usePolicyBody } from '@/hooks/use-bastion';

// Policies to read (spec 6.1, 3.6): every member's own list. The text shown is exactly the saved
// Beacon version Bastion hashes; acknowledging sends that version and hash back, so what a person
// read is what is recorded. Only the person can acknowledge: the button is disabled while
// impersonating (spec 6.2) and the server refuses agents and API keys.

const IMPERSONATING_NOTE = 'You are viewing Bastion as another person. Only that person can acknowledge this.';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Reader({ policyId, onDone }: { policyId: string; onDone: () => void }) {
  const body = usePolicyBody(policyId);
  const attest = useAttest();
  const canSign = useCan('bastion.attestation.sign');
  const impersonating = getImpersonation() !== null;
  if (body.isLoading) return <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />;
  if (body.error) return <p className="text-sm text-amber-700">{friendlyError(body.error)}</p>;
  const b = body.data?.data;
  if (!b) return null;
  return (
    <div className="space-y-4" data-testid="policy-reader">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{b.title}</h2>
      {/* Rendered as plain text on purpose: no HTML from the article reaches the page. */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap max-h-[60vh] overflow-y-auto" data-testid="policy-body">
        {b.body_markdown}
      </div>
      {b.attested_at ? (
        <p className="flex items-center gap-2 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" /> You acknowledged this version on {formatDate(b.attested_at)}.
        </p>
      ) : !b.in_audience ? (
        <p className="text-sm text-zinc-600">This policy is not one you are asked to read.</p>
      ) : (
        canSign && (
          <div className="space-y-1">
            <button
              type="button"
              className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
              disabled={impersonating || attest.isPending}
              title={impersonating ? IMPERSONATING_NOTE : undefined}
              onClick={() => attest.mutate({ id: b.policy_id, beacon_version: b.beacon_version, body_sha256: b.body_sha256 }, { onSuccess: onDone })}
            >
              I have read and understood this
            </button>
            {impersonating && <p className="text-xs text-amber-700">{IMPERSONATING_NOTE}</p>}
          </div>
        )
      )}
      {attest.error && <p className="text-sm text-red-600">{friendlyError(attest.error)}</p>}
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">Technical details</summary>
        <p>Version {b.beacon_version}, saved {formatDate(b.saved_at)}</p>
        <p className="break-all">Content hash (SHA-256): {b.body_sha256}</p>
      </details>
    </div>
  );
}

export function AttestPage() {
  const q = useMyAttestations();
  const [reading, setReading] = useState<string | null>(null);
  const rows = q.data?.data ?? [];
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Policies to read</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Read each policy and confirm you understood it. Only you can do this for yourself.</p>
      </div>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />}
      {q.error && <p className="text-sm text-red-600">{friendlyError(q.error)}</p>}
      {!q.isLoading && rows.length === 0 && <p className="text-sm text-zinc-600 dark:text-zinc-400">Nothing to read right now. When your team links a policy, it shows up here.</p>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((r) => {
          // #285: a paused policy (its article removed, withdrawn or past review) has nothing to
          // read, so no button and no "next by" date: an action the server would refuse is hidden.
          // #296: `paused` without a state when the reader cannot open the article.
          const readable = !r.paused && (r.article_state ?? 'current') === 'current';
          return (
            <li key={r.policy_id} className="py-3 flex items-center justify-between gap-4" data-testid="to-read-row">
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.title}</p>
                <p className={`text-xs ${!readable ? 'text-zinc-600 dark:text-zinc-400' : r.due ? 'text-amber-700' : 'text-green-700'}`}>
                  {r.state_words}
                  {readable && !r.due && r.next_due_at ? ` · next by ${formatDate(r.next_due_at)}` : ''}
                </p>
              </div>
              {readable && (
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 dark:border-zinc-700"
                  onClick={() => setReading(reading === r.policy_id ? null : r.policy_id)}
                >
                  {reading === r.policy_id ? 'Close' : r.due ? 'Read it' : 'Read again'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {reading && <Reader key={reading} policyId={reading} onDone={() => undefined} />}
    </div>
  );
}
