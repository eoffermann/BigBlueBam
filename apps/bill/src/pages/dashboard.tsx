import { DollarSign, Clock, AlertCircle, FileText, TrendingUp } from 'lucide-react';
import { useInvoices } from '@/hooks/use-invoices';
import { useOverdue } from '@/hooks/use-reports';
import { formatCents, formatDate, statusBadgeClass, cn } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

function summarize(invoices: any[] | undefined) {
  const list = invoices ?? [];
  let outstanding = 0;
  let paid = 0;
  let draftCount = 0;

  for (const inv of list) {
    const total = Number(inv.total ?? 0);
    const amountPaid = Number(inv.amount_paid ?? 0);
    if (inv.status === 'draft') draftCount += 1;
    if (inv.status === 'paid') {
      paid += total;
    } else if (inv.status !== 'void' && inv.status !== 'draft' && inv.status !== 'written_off') {
      outstanding += Math.max(total - amountPaid, 0);
    }
  }

  return { outstanding, paid, draftCount };
}

export function DashboardPage({ onNavigate }: Props) {
  const { data: invoices, isLoading } = useInvoices();
  // "Overdue" is not a stored status — it is computed server-side from a past
  // due_date on an unpaid, finalized invoice (the /reports/overdue endpoint).
  const { data: overdue } = useOverdue();
  const stats = summarize(invoices);
  const overdueCount = (overdue ?? []).length;

  const recent = (invoices ?? []).slice(0, 8);

  const tiles = [
    {
      label: 'Outstanding',
      value: formatCents(stats.outstanding),
      icon: DollarSign,
      accent: 'text-green-600 bg-green-100 dark:bg-green-900/30',
      onClick: () => onNavigate('/'),
    },
    {
      label: 'Paid',
      value: formatCents(stats.paid),
      icon: TrendingUp,
      accent: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30',
      onClick: () => onNavigate('/'),
    },
    {
      label: 'Overdue',
      value: `${overdueCount}`,
      icon: AlertCircle,
      accent: 'text-red-600 bg-red-100 dark:bg-red-900/30',
      onClick: () => onNavigate('/invoices?status=overdue'),
    },
    {
      label: 'Drafts',
      value: `${stats.draftCount}`,
      icon: FileText,
      accent: 'text-zinc-600 bg-zinc-100 dark:bg-zinc-800',
      onClick: () => onNavigate('/'),
    },
  ];

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">Overview of invoicing activity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map((tile) => (
          <button
            key={tile.label}
            onClick={tile.onClick}
            className="text-left border border-zinc-200 dark:border-zinc-700 rounded-xl p-5 bg-white dark:bg-zinc-800/50 hover:border-green-300 dark:hover:border-green-700 transition-colors"
          >
            <div className="flex items-center justify-between mb-4">
              <div className={cn('inline-flex h-10 w-10 items-center justify-center rounded-lg', tile.accent)}>
                <tile.icon className="h-5 w-5" />
              </div>
              <span className="text-xs text-zinc-400 uppercase tracking-wider">{tile.label}</span>
            </div>
            <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              {isLoading ? '...' : tile.value}
            </div>
          </button>
        ))}
      </div>

      <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Recent activity</h2>
          </div>
          <button
            onClick={() => onNavigate('/')}
            className="text-xs text-green-600 hover:text-green-700"
          >
            View all invoices
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/30 border-b border-zinc-200 dark:border-zinc-700">
              <th className="text-left px-4 py-2 font-medium text-zinc-500">Number</th>
              <th className="text-left px-4 py-2 font-medium text-zinc-500">Client</th>
              <th className="text-left px-4 py-2 font-medium text-zinc-500">Date</th>
              <th className="text-right px-4 py-2 font-medium text-zinc-500">Total</th>
              <th className="text-center px-4 py-2 font-medium text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="text-center py-8 text-zinc-400">Loading...</td>
              </tr>
            ) : recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-8 text-zinc-400">No invoices yet.</td>
              </tr>
            ) : (
              recent.map((inv: any) => (
                <tr
                  key={inv.id}
                  onClick={() => onNavigate(`/invoices/${inv.id}`)}
                  className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 cursor-pointer"
                >
                  <td className="px-4 py-2 font-mono text-xs">{inv.invoice_number}</td>
                  <td className="px-4 py-2">{inv.to_name || '--'}</td>
                  <td className="px-4 py-2 text-zinc-500">{formatDate(inv.invoice_date)}</td>
                  <td className="px-4 py-2 text-right font-medium">{formatCents(inv.total)}</td>
                  <td className="px-4 py-2 text-center">
                    <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', statusBadgeClass(inv.status))}>
                      {inv.status?.replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
