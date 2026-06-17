import { useState } from 'react';
import { Plus, Calendar, Loader2, MoreVertical, Play, CheckCircle2, Trash2, Pencil } from 'lucide-react';
import { usePeriods, useCreatePeriod, useUpdatePeriod, useDeletePeriod, useActivatePeriod, useCompletePeriod } from '@/hooks/usePeriods';
import { Button } from '@/components/common/button';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Badge } from '@/components/common/badge';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { formatDate, cn } from '@/lib/utils';
import type { BearingPeriod } from '@/stores/period.store';

interface PeriodListPageProps {
  onNavigate: (path: string) => void;
}

const periodTypes: Array<{ value: BearingPeriod['type']; label: string }> = [
  { value: 'quarter', label: 'Quarter' },
  { value: 'half', label: 'Half Year' },
  { value: 'year', label: 'Year' },
  { value: 'custom', label: 'Custom' },
];

const statusBadgeVariant: Record<string, 'default' | 'success' | 'info' | 'primary' | 'warning'> = {
  planning: 'default',
  active: 'success',
  completed: 'info',
  archived: 'default',
};

export function PeriodListPage({ onNavigate: _onNavigate }: PeriodListPageProps) {
  const { data, isLoading } = usePeriods();
  const periods = data?.data ?? [];
  const activateMutation = useActivatePeriod();
  const completeMutation = useCompletePeriod();
  const deleteMutation = useDeletePeriod();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState<BearingPeriod | null>(null);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Periods</h1>
          <p className="text-sm text-zinc-500 mt-1">Manage time periods for organizing goals and OKRs.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New Period
        </Button>
      </div>

      {/* Period table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : periods.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
          <Calendar className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">No periods yet</p>
          <p className="text-sm mt-1">Create your first period to start tracking goals.</p>
          <Button className="mt-4" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Create Period
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
                <th className="text-left px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-400">Name</th>
                <th className="text-left px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-400">Type</th>
                <th className="text-left px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-400">Date Range</th>
                <th className="text-left px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-400">Status</th>
                <th className="text-right px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-400">Goals</th>
                <th className="w-12 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr
                  key={period.id}
                  className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors"
                >
                  <td className="px-4 py-3">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{period.name}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-zinc-600 dark:text-zinc-400 capitalize">{period.type}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-zinc-600 dark:text-zinc-400">
                      {formatDate(period.start_date)} - {formatDate(period.end_date)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={statusBadgeVariant[period.status] ?? 'default'}>
                      {period.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-zinc-600 dark:text-zinc-400">{period.goal_count ?? 0}</span>
                  </td>
                  <td className="px-4 py-3">
                    <DropdownMenu
                      trigger={
                        <button className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors">
                          <MoreVertical className="h-4 w-4" />
                        </button>
                      }
                    >
                      <DropdownMenuItem onSelect={() => setEditingPeriod(period)}>
                        <Pencil className="h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      {period.status === 'planning' && (
                        <DropdownMenuItem onSelect={() => activateMutation.mutate(period.id)}>
                          <Play className="h-4 w-4" />
                          Activate
                        </DropdownMenuItem>
                      )}
                      {period.status === 'active' && (
                        <DropdownMenuItem onSelect={() => completeMutation.mutate(period.id)}>
                          <CheckCircle2 className="h-4 w-4" />
                          Complete
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        destructive
                        onSelect={() => {
                          if (window.confirm(`Delete period "${period.name}"?`)) {
                            deleteMutation.mutate(period.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <PeriodFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        period={null}
      />

      {/* Edit dialog */}
      {editingPeriod && (
        <PeriodFormDialog
          open={!!editingPeriod}
          onOpenChange={(open) => { if (!open) setEditingPeriod(null); }}
          period={editingPeriod}
        />
      )}
    </div>
  );
}

// ── Period Form Dialog ──

function PeriodFormDialog({
  open,
  onOpenChange,
  period,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  period: BearingPeriod | null;
}) {
  const createMutation = useCreatePeriod();
  const updateMutation = useUpdatePeriod();

  const [name, setName] = useState(period?.name ?? '');
  const [type, setType] = useState<BearingPeriod['type']>(period?.type ?? 'quarter');
  const [startDate, setStartDate] = useState(period?.start_date?.split('T')[0] ?? '');
  const [endDate, setEndDate] = useState(period?.end_date?.split('T')[0] ?? '');

  const isEditing = !!period;

  const handleSubmit = () => {
    if (!name.trim() || !startDate || !endDate) return;

    if (isEditing) {
      updateMutation.mutate(
        { id: period!.id, name: name.trim(), type, start_date: startDate, end_date: endDate },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createMutation.mutate(
        { name: name.trim(), type, start_date: startDate, end_date: endDate },
        { onSuccess: () => { onOpenChange(false); setName(''); setStartDate(''); setEndDate(''); } },
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? 'Edit Period' : 'Create Period'}
      description={isEditing ? 'Update period details.' : 'Define a new time period for goals.'}
    >
      <div className="space-y-4">
        <Input
          label="Name"
          placeholder="e.g., Q2 2026"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</label>
          <div className="flex gap-2">
            {periodTypes.map((pt) => (
              <button
                key={pt.value}
                onClick={() => setType(pt.value)}
                className={cn(
                  'px-3 py-1.5 text-sm rounded-lg border transition-colors',
                  type === pt.value
                    ? 'border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-300'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300',
                )}
              >
                {pt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Start Date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <Input
            label="End Date"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            loading={createMutation.isPending || updateMutation.isPending}
            disabled={!name.trim() || !startDate || !endDate}
          >
            {isEditing ? 'Save Changes' : 'Create Period'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
