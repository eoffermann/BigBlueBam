import { useState } from 'react';
import { Coins, Trash2, Info } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { useCostRates, useCreateCostRate, useDeleteCostRate } from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, EmptyState, Btn } from '@/components/primitives';
import { formatCents, formatDate } from '@/lib/utils';

export function CostRatesPage() {
  const canRead = useCan('burn.costrate.read');
  const canWrite = useCan('burn.costrate.write');
  const rates = useCostRates(canRead);
  const create = useCreateCostRate();
  const del = useDeleteCostRate();
  const [showForm, setShowForm] = useState(false);

  if (!canRead) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <PageHeader title="Cost Rates" />
        <Card className="p-6 text-center">
          <p className="text-sm text-zinc-500">
            Cost rates are owner/admin only. They are the one place per-person compensation lives, so the
            screen is gated by both the permission and an in-route role guard.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader
        title="Cost Rates"
        subtitle="Effective-dated cost per person and project. This is the missing primitive that turns consumption into true margin."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setShowForm((s) => !s)}>
              <Coins className="h-4 w-4" /> Add rate
            </Btn>
          ) : undefined
        }
      />

      <Card className="mb-4 p-4 bg-primary-50 dark:bg-primary-900/10 border-primary-200 dark:border-primary-800">
        <div className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300">
          <Info className="h-4 w-4 text-primary-500 mt-0.5 shrink-0" />
          <p>
            Saving a rate enqueues <span className="font-mono text-xs">burn-revalue</span>: existing work items
            that had no cost are revalued in place, with zero re-classification. Margin is reported where a rate
            covers the hours; consumption is reported for the rest.
          </p>
        </div>
      </Card>

      {showForm && canWrite && (
        <CostRateForm
          onSubmit={(input) =>
            create.mutate(
              { ...input, currency: 'USD', rate_type: 'hourly' },
              { onSuccess: () => setShowForm(false) },
            )
          }
          pending={create.isPending}
          onCancel={() => setShowForm(false)}
        />
      )}

      {rates.isLoading ? (
        <LoadingState />
      ) : (rates.data?.data.length ?? 0) === 0 ? (
        <EmptyState
          title="No cost rates yet"
          hint="Until a cost rate covers the hours, the Portfolio Board reports contract consumption, not margin."
        />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Cost / hr</th>
                <th className="px-4 py-2 font-medium">Effective</th>
                <th className="px-4 py-2 font-medium">Note</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rates.data!.data.map((r) => (
                <tr key={r.id} className="border-b border-zinc-50 dark:border-zinc-800/60 last:border-0">
                  <td className="px-4 py-2.5 text-xs text-zinc-500">
                    {r.user_id ? `User ${r.user_id.slice(0, 8)}` : 'All users'}
                    {r.project_id ? ` · Project ${r.project_id.slice(0, 8)}` : ' · All projects'}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                    {formatCents(r.cost_amount, r.currency)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">
                    {formatDate(r.effective_from)} → {r.effective_to ? formatDate(r.effective_to) : 'open'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-400">{r.note ?? ''}</td>
                  <td className="px-4 py-2.5 text-right">
                    {canWrite && (
                      <button
                        onClick={() => del.mutate(r.id)}
                        className="text-zinc-300 hover:text-red-500"
                        title="Delete rate"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function CostRateForm({
  onSubmit,
  onCancel,
  pending,
}: {
  onSubmit: (input: {
    user_id?: string | null;
    project_id?: string | null;
    cost_amount: number;
    effective_from: string;
    effective_to?: string | null;
    note?: string | null;
  }) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [userId, setUserId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [cost, setCost] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().split('T')[0]!);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');

  const valid = cost !== '' && Number(cost) >= 0 && from !== '';

  return (
    <Card className="mb-4 p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="User ID (optional)">
          <input value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls} placeholder="uuid or blank for all" />
        </Field>
        <Field label="Project ID (optional)">
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls} placeholder="uuid or blank for all" />
        </Field>
        <Field label="Cost per hour (minor units / cents)">
          <input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} className={inputCls} placeholder="e.g. 8500" />
        </Field>
        <Field label="Effective from">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Effective to (inclusive, optional)">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Note (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Btn
          variant="primary"
          size="sm"
          disabled={!valid || pending}
          onClick={() =>
            onSubmit({
              user_id: userId || null,
              project_id: projectId || null,
              cost_amount: Number(cost),
              effective_from: from,
              effective_to: to || null,
              note: note || null,
            })
          }
        >
          Save rate
        </Btn>
        <Btn variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </Card>
  );
}

const inputCls =
  'w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
