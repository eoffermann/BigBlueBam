import { useState } from 'react';
import { Plus, Filter, Repeat, Play, Pause, Ban, Zap } from 'lucide-react';
import { useClients } from '@/hooks/use-clients';
import {
  useRecurringList,
  useCreateRecurring,
  usePauseRecurring,
  useResumeRecurring,
  useCancelRecurring,
  useGenerateRecurringNow,
  type RecurringLineItem,
} from '@/hooks/use-recurring';
import { formatCents, formatDateTime, cn } from '@/lib/utils';

const CADENCES = ['weekly', 'monthly', 'quarterly', 'annually'] as const;

function statusBadge(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    case 'paused':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'cancelled':
      return 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300';
    default:
      return 'bg-zinc-100 text-zinc-600';
  }
}

interface Props {
  onNavigate: (path: string) => void;
}

// onNavigate is part of the standard page contract; this list manages itself
// via the create dialog and inline actions, so it does not navigate away.
export function RecurringListPage(_props: Props) {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data: schedules, isLoading } = useRecurringList(
    statusFilter ? { status: statusFilter } : undefined,
  );
  const { data: clients } = useClients();
  const createRecurring = useCreateRecurring();
  const pauseRecurring = usePauseRecurring();
  const resumeRecurring = useResumeRecurring();
  const cancelRecurring = useCancelRecurring();
  const generateNow = useGenerateRecurringNow();

  const [showCreate, setShowCreate] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>('monthly');
  const [autoFinalize, setAutoFinalize] = useState(false);
  const [taxRate, setTaxRate] = useState(0);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().split('T')[0]!);
  const [endDate, setEndDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lineItems, setLineItems] = useState<RecurringLineItem[]>([
    { description: '', quantity: 1, unit_price: 0 },
  ]);

  const subtotal = lineItems.reduce((s, li) => s + (li.quantity ?? 1) * li.unit_price, 0);

  const resetForm = () => {
    setName('');
    setClientId('');
    setCadence('monthly');
    setAutoFinalize(false);
    setTaxRate(0);
    setStartDate(new Date().toISOString().split('T')[0]!);
    setEndDate('');
    setNotes('');
    setLineItems([{ description: '', quantity: 1, unit_price: 0 }]);
    setError(null);
  };

  const handleCreate = async () => {
    if (!clientId || !name) {
      setError('Pick a client and give the schedule a name.');
      return;
    }
    const items = lineItems.filter((li) => li.description && li.unit_price > 0);
    if (items.length === 0) {
      setError('Add at least one line item with a description and price.');
      return;
    }
    setError(null);
    try {
      await createRecurring.mutateAsync({
        client_id: clientId,
        name,
        cadence,
        auto_finalize: autoFinalize,
        tax_rate: taxRate,
        start_date: startDate,
        end_date: endDate || undefined,
        notes: notes || undefined,
        line_items: items,
      });
      setBanner(`Created recurring schedule "${name}".`);
      setShowCreate(false);
      resetForm();
      setTimeout(() => setBanner(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create schedule');
    }
  };

  const handleGenerateNow = async (id: string, schedName: string) => {
    try {
      const res = await generateNow.mutateAsync(id);
      const num = res?.data?.invoice_number ?? 'draft';
      setBanner(`Generated invoice ${num} from "${schedName}".`);
      setTimeout(() => setBanner(null), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate invoice');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Repeat className="h-6 w-6 text-green-600" />
            Recurring
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Subscription schedules that generate invoices automatically
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowCreate(true);
          }}
          className="flex items-center gap-2 rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Recurring Schedule
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-zinc-400" />
        {['', 'active', 'paused', 'cancelled'].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium transition-colors',
              statusFilter === s
                ? 'bg-green-600 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700',
            )}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {banner && (
        <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-800 px-4 py-2 text-sm text-green-700 dark:text-green-300">
          {banner}
        </div>
      )}

      {/* Table */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Name</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Cadence</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Next run</th>
              <th className="text-center px-4 py-3 font-medium text-zinc-500">Generated</th>
              <th className="text-center px-4 py-3 font-medium text-zinc-500">Mode</th>
              <th className="text-center px-4 py-3 font-medium text-zinc-500">Status</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-zinc-400">
                  Loading schedules...
                </td>
              </tr>
            ) : !schedules?.length ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-zinc-400">
                  No recurring schedules yet. Create one to bill a client on a cadence.
                </td>
              </tr>
            ) : (
              schedules.map((sch: any) => (
                <tr
                  key={sch.id}
                  className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">{sch.name}</td>
                  <td className="px-4 py-3 text-zinc-500 capitalize">{sch.cadence}</td>
                  <td className="px-4 py-3 text-zinc-500">{formatDateTime(sch.next_run_at)}</td>
                  <td className="px-4 py-3 text-center text-zinc-500">{sch.invoices_generated}</td>
                  <td className="px-4 py-3 text-center text-xs text-zinc-500">
                    {sch.auto_finalize ? 'Auto-finalize' : 'Draft'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={cn(
                        'px-2 py-0.5 rounded-full text-xs font-medium',
                        statusBadge(sch.status),
                      )}
                    >
                      {sch.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {sch.status !== 'cancelled' && (
                        <button
                          onClick={() => handleGenerateNow(sch.id, sch.name)}
                          disabled={generateNow.isPending}
                          title="Generate an invoice now"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-green-600 text-white text-xs hover:bg-green-700 disabled:opacity-50"
                        >
                          <Zap className="h-3 w-3" />
                          Generate now
                        </button>
                      )}
                      {sch.status === 'active' && (
                        <button
                          onClick={() => pauseRecurring.mutate(sch.id)}
                          title="Pause"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          <Pause className="h-3 w-3" />
                          Pause
                        </button>
                      )}
                      {sch.status === 'paused' && (
                        <button
                          onClick={() => resumeRecurring.mutate(sch.id)}
                          title="Resume"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          <Play className="h-3 w-3" />
                          Resume
                        </button>
                      )}
                      {sch.status !== 'cancelled' && (
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                `Cancel "${sch.name}"? This stops all future generation. Existing invoices are kept.`,
                              )
                            ) {
                              cancelRecurring.mutate(sch.id);
                            }
                          }}
                          title="Cancel"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-red-200 dark:border-red-900 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >
                          <Ban className="h-3 w-3" />
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {error && !showCreate && <p className="text-sm text-red-600">{error}</p>}

      {/* Create dialog */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              New Recurring Schedule
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="rec-name" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Schedule name
                </label>
                <input
                  id="rec-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme monthly retainer"
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rec-client" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Client
                </label>
                <select
                  id="rec-client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="">Select a client...</option>
                  {clients?.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rec-cadence" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Cadence
                </label>
                <select
                  id="rec-cadence"
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as (typeof CADENCES)[number])}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm capitalize"
                >
                  {CADENCES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rec-start" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Start date
                </label>
                <input
                  id="rec-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rec-end" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  End date (optional)
                </label>
                <input
                  id="rec-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rec-tax" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Tax rate (%)
                </label>
                <input
                  id="rec-tax"
                  type="number"
                  value={taxRate}
                  onChange={(e) => setTaxRate(Number(e.target.value))}
                  min={0}
                  max={100}
                  step={0.25}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={autoFinalize}
                onChange={(e) => setAutoFinalize(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300"
              />
              Auto-finalize generated invoices (assign a number and mark sent). Leave unchecked to
              generate drafts.
            </label>

            {/* Line items */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">Line items (template)</h4>
              <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
                      <th className="text-left px-3 py-2 font-medium text-zinc-500">Description</th>
                      <th className="text-right px-3 py-2 font-medium text-zinc-500 w-20">Qty</th>
                      <th className="text-right px-3 py-2 font-medium text-zinc-500 w-28">Unit price (cents)</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((li, idx) => (
                      <tr key={idx} className="border-b border-zinc-100 dark:border-zinc-800">
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={li.description}
                            onChange={(e) => {
                              const items = [...lineItems];
                              items[idx]!.description = e.target.value;
                              setLineItems(items);
                            }}
                            placeholder="Description..."
                            className="w-full bg-transparent border-0 outline-none"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            value={li.quantity}
                            onChange={(e) => {
                              const items = [...lineItems];
                              items[idx]!.quantity = Number(e.target.value);
                              setLineItems(items);
                            }}
                            min={0}
                            step={0.5}
                            className="w-16 text-right bg-transparent border-0 outline-none"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            value={li.unit_price}
                            onChange={(e) => {
                              const items = [...lineItems];
                              items[idx]!.unit_price = Number(e.target.value);
                              setLineItems(items);
                            }}
                            min={0}
                            className="w-24 text-right bg-transparent border-0 outline-none"
                          />
                        </td>
                        <td className="px-2 text-center">
                          <button
                            onClick={() => setLineItems(lineItems.filter((_, i) => i !== idx))}
                            className="text-red-400 hover:text-red-600 text-xs"
                          >
                            X
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setLineItems([...lineItems, { description: '', quantity: 1, unit_price: 0 }])}
                  className="text-sm text-green-600 hover:text-green-700 font-medium"
                >
                  + Add line item
                </button>
                <span className="text-sm text-zinc-500">
                  Subtotal: <span className="font-medium text-zinc-700 dark:text-zinc-200">{formatCents(subtotal)}</span>
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="rec-notes" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Notes (internal)
              </label>
              <textarea
                id="rec-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-100"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={createRecurring.isPending}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              >
                {createRecurring.isPending ? 'Creating...' : 'Create schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
