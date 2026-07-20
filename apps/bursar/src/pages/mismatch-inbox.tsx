import { GitCompareArrows, Check, X, Flag } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { PageHeader, Card, LoadingState, EmptyState, Btn, Pill } from '@/components/primitives';
import { useMismatches, useResolveMismatch } from '@/hooks/use-bursar';
import type { MismatchRow } from '@/lib/api';
import { formatCents, formatDate } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

const SEVERITY_TONE: Record<string, Parameters<typeof Pill>[0]['tone']> = {
  high: 'red',
  medium: 'amber',
  low: 'zinc',
};

// A mismatch amount is EITHER quantified money OR the literal words "not quantified". It is never
// coerced to a number (spec 8 / UI rule): a null amount means the detector could not put a dollar
// figure on the drift, and rendering that as $0 would be a lie.
function amountText(m: MismatchRow): { text: string; quantified: boolean } {
  if (m.quantified === false || m.amount_minor == null) return { text: 'not quantified', quantified: false };
  return { text: formatCents(m.amount_minor, m.detail?.currency as string | undefined), quantified: true };
}

export function MismatchInboxPage({ onNavigate }: Props) {
  const canResolve = useCan('bursar.mismatch.resolve');
  const { data, isLoading, isError } = useMismatches(undefined, 'open');
  const resolve = useResolveMismatch();

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title="Mismatch Inbox"
        subtitle="Drift between what was awarded and what is being billed, ranked by severity. An amount the detector cannot value reads as text, never a number."
      />

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <EmptyState
          title="No mismatches"
          hint="The mismatch detectors have not raised anything, or the endpoint is not wired into the stack yet."
          icon={<GitCompareArrows className="h-8 w-8" />}
        />
      ) : (data?.data.length ?? 0) === 0 ? (
        <EmptyState title="Inbox clear" hint="No open mismatches." icon={<GitCompareArrows className="h-8 w-8" />} />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">Finding</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Detected</th>
                {canResolve && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data!.data.map((m) => {
                const amt = amountText(m);
                return (
                  <tr key={m.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <td className="px-4 py-2.5">
                      <Pill tone={SEVERITY_TONE[m.severity] ?? 'zinc'}>{m.severity}</Pill>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-zinc-800 dark:text-zinc-100">{m.summary ?? m.detector}</div>
                      <div className="text-xs text-zinc-400">
                        {m.detector}
                        {m.vendor_id && (
                          <>
                            {' / '}
                            <button className="text-primary-600 hover:underline" onClick={() => onNavigate(`/vendors/${m.vendor_id}`)}>
                              vendor
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      {amt.quantified ? (
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">{amt.text}</span>
                      ) : (
                        <span className="text-xs italic text-zinc-500">{amt.text}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs">{formatDate(m.detected_at ?? m.created_at)}</td>
                    {canResolve && (
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1 justify-end">
                          <Btn size="sm" title="Resolve" onClick={() => resolve.mutate({ id: m.id, action: 'resolve' })}>
                            <Check className="h-3.5 w-3.5" />
                          </Btn>
                          <Btn size="sm" variant="ghost" title="Dismiss" onClick={() => resolve.mutate({ id: m.id, action: 'dismiss' })}>
                            <X className="h-3.5 w-3.5" />
                          </Btn>
                          <Btn size="sm" variant="ghost" title="Mark wrong" onClick={() => resolve.mutate({ id: m.id, action: 'mark-wrong' })}>
                            <Flag className="h-3.5 w-3.5" />
                          </Btn>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
