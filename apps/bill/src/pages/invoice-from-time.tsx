import { useState } from 'react';
import { Clock } from 'lucide-react';
import { useCreateInvoiceFromTime } from '@/hooks/use-invoices';
import { useBamProjects } from '@/hooks/use-approvals';
import { useClients } from '@/hooks/use-clients';

interface Props {
  onNavigate: (path: string) => void;
}

export function InvoiceFromTimePage({ onNavigate }: Props) {
  const [projectId, setProjectId] = useState('');
  const [clientId, setClientId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: projects } = useBamProjects();
  const { data: clients } = useClients();
  const createFromTime = useCreateInvoiceFromTime();

  const canSubmit = !!projectId && !!clientId && !!dateFrom && !!dateTo && !createFromTime.isPending;

  const handleGenerate = async () => {
    setError(null);
    if (!canSubmit) {
      setError('Pick a project, a billing client, and a date range first.');
      return;
    }
    try {
      const res = await createFromTime.mutateAsync({
        project_id: projectId,
        client_id: clientId,
        date_from: dateFrom,
        date_to: dateTo,
      });
      onNavigate(`/invoices/${res.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate invoice from time entries');
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-green-100 dark:bg-green-900/30 text-green-600">
          <Clock className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Invoice from Time Entries</h1>
          <p className="text-sm text-zinc-500">Generate an invoice from Bam time tracking data</p>
        </div>
      </div>

      <div className="bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 text-sm text-zinc-600 dark:text-zinc-300">
        Pick a Bam project and a date range. Every billable time entry on that project between the
        two dates is grouped by team member and task, priced with the configured billing rate, and
        added as line items on a new draft invoice. Each contributing user needs a billing rate
        configured for the project, or generation will fail.
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="bill-fromtime-project" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Project</label>
          <select
            id="bill-fromtime-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
          >
            <option value="">Select a project...</option>
            {(projects?.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor="bill-fromtime-client" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Bill to client</label>
          <select
            id="bill-fromtime-client"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
          >
            <option value="">Select a client...</option>
            {(clients ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label htmlFor="bill-fromtime-from" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Date From</label>
            <input
              id="bill-fromtime-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="bill-fromtime-to" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Date To</label>
            <input
              id="bill-fromtime-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/20 dark:border-red-800 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-4">
        <button
          onClick={handleGenerate}
          disabled={!canSubmit}
          className="rounded-lg bg-green-600 text-white px-6 py-2 text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {createFromTime.isPending ? 'Generating...' : 'Generate Invoice'}
        </button>
        <button
          onClick={() => onNavigate('/invoices/new')}
          className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-6 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
        >
          Create Manually Instead
        </button>
      </div>
    </div>
  );
}
