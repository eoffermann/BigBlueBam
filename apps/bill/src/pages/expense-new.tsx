import { useState } from 'react';
import { useCreateExpense } from '@/hooks/use-expenses';
import { BurnGateNotice } from '@/components/burn-gate-notice';

interface Props {
  onNavigate: (path: string) => void;
}

export function ExpenseNewPage({ onNavigate }: Props) {
  const createExpense = useCreateExpense();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(0);
  const [category, setCategory] = useState('');
  const [vendor, setVendor] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]!);
  const [billable, setBillable] = useState(false);

  const handleSubmit = async () => {
    if (!description || amount <= 0) return;
    await createExpense.mutateAsync({
      description,
      amount,
      category: category || undefined,
      vendor: vendor || undefined,
      expense_date: expenseDate,
      billable,
    });
    onNavigate('/expenses');
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">New Expense</h1>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            placeholder="What was this expense for?"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Amount (cents)</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              min={0}
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Date</label>
            <input
              type="date"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            >
              <option value="">Select category...</option>
              <option value="software">Software</option>
              <option value="travel">Travel</option>
              <option value="hardware">Hardware</option>
              <option value="contractor">Contractor</option>
              <option value="office">Office</option>
              <option value="meals">Meals</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Vendor</label>
            <input
              type="text"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              placeholder="Vendor name..."
            />
          </div>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">Billable to client</span>
        </label>

        {/* Burn pre-transaction gate advisory (Burn spec 7.8) */}
        <BurnGateNotice
          amount={amount}
          billable={billable}
          title={description || undefined}
          description={description || undefined}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSubmit}
          disabled={createExpense.isPending}
          className="rounded-lg bg-green-600 text-white px-6 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50"
        >
          Submit Expense
        </button>
        <button
          onClick={() => onNavigate('/expenses')}
          className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-6 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
