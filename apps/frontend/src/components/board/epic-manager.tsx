import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Plus } from 'lucide-react';
import type { ApiResponse, PaginatedResponse } from '@bigbluebam/shared';
import { Dialog } from '@/components/common/dialog';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { DatePicker } from '@/components/common/date-picker';
import { api } from '@/lib/api';

interface Epic {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  color: string | null;
  target_date: string | null;
  status: string;
  task_count: number;
  created_at: string;
}

interface EpicManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Navigate to an epic's detail page (closes the dialog first). */
  onOpenEpic?: (epicId: string) => void;
}

export function EpicManager({ open, onOpenChange, projectId, onOpenEpic }: EpicManagerProps) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [targetDate, setTargetDate] = useState('');

  const { data: epicsRes } = useQuery({
    queryKey: ['epics', projectId],
    queryFn: () => api.get<PaginatedResponse<Epic>>(`/projects/${projectId}/epics`),
    enabled: !!projectId && open,
  });
  const epics = epicsRes?.data ?? [];

  const createEpic = useMutation({
    mutationFn: (data: { name: string; description?: string; color?: string; target_date?: string }) =>
      api.post<ApiResponse<Epic>>(`/projects/${projectId}/epics`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics', projectId] });
      setName('');
      setDescription('');
      setColor('#6366f1');
      setTargetDate('');
      setShowForm(false);
    },
  });

  const deleteEpic = useMutation({
    mutationFn: (epicId: string) => api.delete(`/epics/${epicId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics', projectId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const handleCreate = () => {
    if (!name.trim()) return;
    createEpic.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      color: color || undefined,
      target_date: targetDate || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Manage Epics" description="Create and manage epics for this project." className="max-w-xl">
      <div className="space-y-4">
        {/* Epic list */}
        {epics.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {epics.map((epic) => (
              <div
                key={epic.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
              >
                {onOpenEpic ? (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenEpic(epic.id);
                    }}
                    className="flex items-center gap-2.5 min-w-0 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 group"
                    title={`Open ${epic.name}`}
                  >
                    <span
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: epic.color ?? '#a1a1aa' }}
                    />
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate group-hover:text-primary-600 group-hover:underline">
                      {epic.name}
                    </span>
                    <span className="text-xs text-zinc-400 shrink-0">
                      {epic.task_count} task{epic.task_count !== 1 ? 's' : ''}
                    </span>
                  </button>
                ) : (
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: epic.color ?? '#a1a1aa' }}
                    />
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                      {epic.name}
                    </span>
                    <span className="text-xs text-zinc-400 shrink-0">
                      {epic.task_count} task{epic.task_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => {
                    if (confirm(`Delete epic "${epic.name}"? Tasks will be unlinked but not deleted.`)) {
                      deleteEpic.mutate(epic.id);
                    }
                  }}
                  className="p-1 rounded text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  title="Delete epic"
                  aria-label={`Delete epic ${epic.name}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-400 py-2">No epics yet. Create one to group related tasks.</p>
        )}

        {/* Create form */}
        {showForm ? (
          <div className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50 dark:bg-zinc-800/50">
            <Input
              id="epic-name"
              label="Name"
              placeholder="Epic name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              id="epic-description"
              label="Description"
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Color</label>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-9 w-12 rounded border border-zinc-300 dark:border-zinc-600 cursor-pointer"
                />
              </div>
              <div className="flex-1">
                <DatePicker
                  label="Target Date"
                  value={targetDate}
                  onChange={(val) => setTargetDate(val)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleCreate}
                loading={createEpic.isPending}
                disabled={!name.trim()}
              >
                Create Epic
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4" />
            Create Epic
          </Button>
        )}
      </div>
    </Dialog>
  );
}
