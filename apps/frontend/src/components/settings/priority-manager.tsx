/**
 * Per-org priority manager. Drop-in for Settings → Tasks. Mirrors
 * board/phase-manager.tsx in shape so the UX is consistent: per-row
 * color picker, click-to-rename, position arrows, default-toggle,
 * delete-with-migration-prompt. Backed by the hooks in
 * use-priorities.ts.
 */
import { useState, useEffect } from 'react';
import { Trash2, Plus, ArrowUp, ArrowDown, Star } from 'lucide-react';
import { Dialog } from '@/components/common/dialog';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import {
  usePriorities,
  useCreatePriority,
  useUpdatePriority,
  useDeletePriority,
  useReorderPriorities,
  type Priority,
} from '@/hooks/use-priorities';

interface PriorityManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface EditDraft {
  name?: string;
  color?: string;
}

export function PriorityManager({ open, onOpenChange }: PriorityManagerProps) {
  const { data: prioritiesRes } = usePriorities();
  const createPriority = useCreatePriority();
  const updatePriority = useUpdatePriority();
  const deletePriority = useDeletePriority();
  const reorderPriorities = useReorderPriorities();

  const priorities = (prioritiesRes?.data ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);

  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#eab308');
  const [edits, setEdits] = useState<Record<string, EditDraft>>({});
  const [editingNameId, setEditingNameId] = useState<string | null>(null);

  // Reset transient state every time the dialog closes so reopening
  // doesn't carry over an aborted rename.
  useEffect(() => {
    if (!open) {
      setShowForm(false);
      setNewName('');
      setNewColor('#eab308');
      setEdits({});
      setEditingNameId(null);
    }
  }, [open]);

  const setEditField = (id: string, field: keyof EditDraft, value: string) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));

  const clearEditField = (id: string, field: keyof EditDraft) =>
    setEdits((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id]![field];
        if (Object.keys(next[id]!).length === 0) delete next[id];
      }
      return next;
    });

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    const maxPosition = priorities.length > 0
      ? Math.max(...priorities.map((p) => p.position))
      : -1;
    createPriority.mutate(
      { name, color: newColor, position: maxPosition + 1 },
      {
        onSuccess: () => {
          setNewName('');
          setNewColor('#eab308');
          setShowForm(false);
        },
      },
    );
  };

  const handleSaveName = (row: Priority) => {
    const value = edits[row.id]?.name;
    if (!value || !value.trim() || value.trim() === row.name) {
      clearEditField(row.id, 'name');
      setEditingNameId(null);
      return;
    }
    updatePriority.mutate(
      { id: row.id, data: { name: value.trim() } },
      { onSuccess: () => { clearEditField(row.id, 'name'); setEditingNameId(null); } },
    );
  };

  const handleSaveColor = (row: Priority) => {
    const value = edits[row.id]?.color;
    if (!value || value === row.color) {
      clearEditField(row.id, 'color');
      return;
    }
    updatePriority.mutate(
      { id: row.id, data: { color: value } },
      { onSuccess: () => clearEditField(row.id, 'color') },
    );
  };

  const handleToggleDefault = (row: Priority) => {
    if (row.is_default) return; // can't un-set without picking a replacement
    updatePriority.mutate({ id: row.id, data: { is_default: true } });
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const ids = priorities.map((p) => p.id);
    [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
    reorderPriorities.mutate(ids);
  };

  const handleMoveDown = (index: number) => {
    if (index === priorities.length - 1) return;
    const ids = priorities.map((p) => p.id);
    [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
    reorderPriorities.mutate(ids);
  };

  const handleDelete = (row: Priority) => {
    if (row.is_default) {
      alert('Set a different priority as the default before deleting this one.');
      return;
    }
    const alternatives = priorities.filter((p) => p.id !== row.id);
    if (alternatives.length === 0) {
      alert('At least one priority must remain.');
      return;
    }
    // First attempt: no migrate_to. The API tells us how many tasks
    // need re-pointing, and we then prompt the user for the
    // destination.
    deletePriority.mutate(
      { id: row.id },
      {
        onError: (err: unknown) => {
          // Tasks reference the priority — prompt to choose a
          // migration target. The shape of the error response is the
          // standard envelope from the API.
          const errObj = err as { status?: number; body?: { error?: { code?: string; message?: string } } };
          if (errObj?.status === 409 && errObj?.body?.error?.code === 'MIGRATION_REQUIRED') {
            const labels = alternatives
              .map((p, i) => `${i + 1}. ${p.name} (${p.value})`)
              .join('\n');
            const raw = prompt(
              `${errObj.body.error.message}\n\nEnter the number of the priority to redirect them to:\n${labels}`,
            );
            const idx = raw ? parseInt(raw, 10) - 1 : -1;
            if (idx < 0 || idx >= alternatives.length) return;
            deletePriority.mutate({ id: row.id, migrate_to: alternatives[idx]!.value });
            return;
          }
          alert(errObj?.body?.error?.message ?? 'Could not delete priority');
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Manage Priorities"
      description="Configure the task priorities available across this organization."
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {priorities.length > 0 ? (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {priorities.map((row, index) => {
              const draft = edits[row.id] ?? {};
              const isRenaming = editingNameId === row.id;
              return (
                <div
                  key={row.id}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                >
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <button
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0 || reorderPriorities.isPending}
                      className="p-0.5 rounded text-zinc-500 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      title="Move up"
                      aria-label={`Move priority ${row.name} up`}
                    >
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => handleMoveDown(index)}
                      disabled={index === priorities.length - 1 || reorderPriorities.isPending}
                      className="p-0.5 rounded text-zinc-500 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      title="Move down"
                      aria-label={`Move priority ${row.name} down`}
                    >
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>

                  <input
                    type="color"
                    value={draft.color ?? row.color}
                    onChange={(e) => setEditField(row.id, 'color', e.target.value)}
                    onBlur={() => handleSaveColor(row)}
                    className="h-7 w-7 rounded border border-zinc-300 dark:border-zinc-600 cursor-pointer shrink-0 p-0"
                    title="Priority color"
                  />

                  {isRenaming ? (
                    <input
                      type="text"
                      value={draft.name ?? row.name}
                      onChange={(e) => setEditField(row.id, 'name', e.target.value)}
                      onBlur={() => handleSaveName(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveName(row);
                        if (e.key === 'Escape') {
                          clearEditField(row.id, 'name');
                          setEditingNameId(null);
                        }
                      }}
                      autoFocus
                      className="flex-1 min-w-0 text-sm font-medium px-1.5 py-0.5 rounded border border-primary-400 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    />
                  ) : (
                    <button
                      onClick={() => { setEditingNameId(row.id); setEditField(row.id, 'name', row.name); }}
                      className="flex-1 min-w-0 text-left text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate hover:text-primary-600 dark:hover:text-primary-400 cursor-text"
                      title="Click to edit name"
                    >
                      {row.name}
                    </button>
                  )}

                  <span
                    className="text-[10px] text-zinc-400 shrink-0 tabular-nums font-mono"
                    title={`Stored value: ${row.value}`}
                  >
                    {row.value}
                  </span>

                  <button
                    onClick={() => handleToggleDefault(row)}
                    aria-pressed={row.is_default}
                    aria-label={row.is_default ? `${row.name} is the default priority` : `Set ${row.name} as default priority`}
                    className={`p-1 rounded shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                      row.is_default
                        ? 'text-yellow-500 bg-yellow-50 dark:bg-yellow-950'
                        : 'text-zinc-500 hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-950'
                    }`}
                    title={row.is_default ? 'Default priority for new tasks' : 'Make default'}
                  >
                    <Star className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>

                  <button
                    onClick={() => handleDelete(row)}
                    disabled={deletePriority.isPending || row.is_default}
                    className="p-1 rounded text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-30 disabled:cursor-not-allowed"
                    title={row.is_default ? 'Cannot delete the default priority' : 'Delete priority'}
                    aria-label={`Delete priority ${row.name}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-zinc-400 py-2">No priorities yet.</p>
        )}

        <div className="flex gap-4 text-[11px] text-zinc-400 px-1">
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3 text-yellow-500" /> Default for new tasks
          </span>
        </div>

        {showForm ? (
          <div className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50 dark:bg-zinc-800/50">
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <Input
                  id="priority-name"
                  label="Priority Name"
                  placeholder="e.g. Blocker"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Color</label>
                <input
                  type="color"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="h-9 w-12 rounded border border-zinc-300 dark:border-zinc-600 cursor-pointer"
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
                loading={createPriority.isPending}
                disabled={!newName.trim()}
              >
                Add Priority
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4" />
            Add Priority
          </Button>
        )}
      </div>
    </Dialog>
  );
}
