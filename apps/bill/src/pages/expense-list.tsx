import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useExpenses, useApproveExpense, useRejectExpense, useReimburseExpense } from '@/hooks/use-expenses';
import { formatDate, formatCents, statusBadgeClass, cn } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

export function ExpenseListPage({ onNavigate }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data: expenses, isLoading } = useExpenses(statusFilter ? { status: statusFilter } : undefined);
  const approveExpense = useApproveExpense();
  const rejectExpense = useRejectExpense();
  const reimburseExpense = useReimburseExpense();

  const statuses = ['', 'pending', 'approved', 'rejected', 'reimbursed'];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Expenses</h1>
          <p className="text-sm text-zinc-500 mt-1">Track project expenses and receipts</p>
        </div>
        <button
          onClick={() => onNavigate('/expenses/new')}
          className="flex items-center gap-2 rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-700"
        >
          <Plus className="h-4 w-4" />
          New Expense
        </button>
      </div>

      <div className="flex items-center gap-2">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium transition-colors',
              statusFilter === s
                ? 'bg-green-600 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400',
            )}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Description</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Category</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Vendor</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Date</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Amount</th>
              <th className="text-center px-4 py-3 font-medium text-zinc-500">Status</th>
              <th className="text-center px-4 py-3 font-medium text-zinc-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="text-center py-12 text-zinc-400">Loading...</td></tr>
            ) : !expenses?.length ? (
              <tr><td colSpan={7} className="text-center py-12 text-zinc-400">No expenses yet.</td></tr>
            ) : (
              expenses.map((exp: any) => (
                <tr key={exp.id} className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                  <td className="px-4 py-3 font-medium">{exp.description}</td>
                  <td className="px-4 py-3 text-zinc-500">{exp.category || '—'}</td>
                  <td className="px-4 py-3 text-zinc-500">{exp.vendor || '—'}</td>
                  <td className="px-4 py-3 text-zinc-500">{formatDate(exp.expense_date)}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatCents(exp.amount)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', statusBadgeClass(exp.status))}>
                      {exp.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {exp.status === 'pending' && (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => approveExpense.mutate(exp.id)}
                          className="text-green-600 hover:text-green-700 text-xs font-medium"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => rejectExpense.mutate(exp.id)}
                          className="text-red-600 hover:text-red-700 text-xs font-medium"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                    {exp.status === 'approved' && (
                      <button
                        onClick={() => reimburseExpense.mutate(exp.id)}
                        disabled={reimburseExpense.isPending}
                        className="text-blue-600 hover:text-blue-700 text-xs font-medium disabled:opacity-50"
                      >
                        Mark reimbursed
                      </button>
                    )}
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
