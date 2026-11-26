import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Plus, ArrowUp, ArrowDown, Play, Flag } from 'lucide-react';
import type { ApiResponse } from '@bigbluebam/shared';
import { Dialog } from '@/components/common/dialog';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { api } from '@/lib/api';

interface Phase {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  color: string | null;
  position: number;
  wip_limit: number | null;
  is_start: boolean;
  is_terminal: boolean;
  created_at: string;
  updated_at: string;
}

interface PhaseManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

interface EditingState {
  [phaseId: string]: {
    name?: string;
    color?: string;
    wip_limit?: string;
    is_start?: boolean;
    is_terminal?: boolean;
  };
}

export function PhaseManager({ open, onOpenChange, projectId }: PhaseManagerProps) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#6366f1');
  const [editing, setEditing] = useState<EditingState>({});
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const { data: phasesRes } = useQuery({
    queryKey: ['phases', projectId],
    queryFn: () => api.get<{ data: Phase[] }>(`/projects/${projectId}/phases`),
    enabled: !!projectId && open,
  });
  const phases = phasesRes?.data ?? [];

  // Reset editing state when dialog closes
  useEffect(() => {
    if (!open) {
      setEditing({});
      setEditingNameId(null);
      setShowForm(false);
      setNewName('');
      setNewColor('#6366f1');
    }
  }, [open]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['phases', projectId] });
    queryClient.invalidateQueries({ queryKey: ['board'] });
  };

  const createPhase = useMutation({
    mutationFn: (data: { name: string; color?: string; position: number }) =>
      api.post<ApiResponse<Phase>>(`/projects/${projectId}/phases`, data),
    onSuccess: () => {
      invalidateAll();
      setNewName('');
      setNewColor('#6366f1');
      setShowForm(false);
    },
  });

  const updatePhase = useMutation({
    mutationFn: ({ phaseId, data }: { phaseId: string; data: Record<string, unknown> }) =>
      api.patch<ApiResponse<Phase>>(`/phases/${phaseId}`, data),
    onSuccess: () => invalidateAll(),
  });

  const deletePhase = useMutation({
    mutationFn: ({ phaseId, migrateTo }: { phaseId: string; migrateTo?: string }) => {
      const path = migrateTo ? `/phases/${phaseId}?migrate_to=${migrateTo}` : `/phases/${phaseId}`;
      return api.delete(path);
    },
    onSuccess: () => invalidateAll(),
  });

  const reorderPhases = useMutation({
    mutationFn: (phaseIds: string[]) =>
      api.post(`/projects/${projectId}/phases/reorder`, { phase_ids: phaseIds }),
    onSuccess: () => invalidateAll(),
  });

  const handleCreate = () => {
    if (!newName.trim()) return;
    const maxPosition = phases.length > 0 ? Math.max(...phases.map((p) => p.position)) : -1;
    createPhase.mutate({
      name: newName.trim(),
      color: newColor || undefined,
      position: maxPosition + 1,
    });
  };

  const handleDelete = (phase: Phase) => {
    const otherPhases = phases.filter((p) => p.id !== phase.id);
    const msg = `Delete phase "${phase.name}"?`;
    if (otherPhases.length > 0) {
      const migrateConfirm = confirm(
        `${msg}\n\nAny tasks in this phase will be moved to the first available phase. Continue?`,
      );
      if (!migrateConfirm) return;
      deletePhase.mutate({ phaseId: phase.id, migrateTo: otherPhases[0]!.id });
    } else {
      if (!confirm(`${msg}\n\nThis is the only phase. Tasks in it will be deleted. Continue?`)) return;
      deletePhase.mutate({ phaseId: phase.id });
    }
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const ids = phases.map((p) => p.id);
    [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
    reorderPhases.mutate(ids);
  };

  const handleMoveDown = (index: number) => {
    if (index === phases.length - 1) return;
    const ids = phases.map((p) => p.id);
    [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
    reorderPhases.mutate(ids);
  };

  const getEditValue = (phase: Phase) => editing[phase.id] ?? {};

  const setEditField = (phaseId: string, field: string, value: unknown) => {
    setEditing((prev) => ({
      ...prev,
      [phaseId]: { ...prev[phaseId], [field]: value },
    }));
  };

  const handleSaveField = async (phase: Phase, field: string) => {
    const edits = getEditValue(phase);
    const value = edits[field as keyof typeof edits];
    if (value === undefined) return;

    let data: Record<string, unknown> = {};
    if (field === 'name' && typeof value === 'string') {
      if (!value.trim() || value.trim() === phase.name) {
        setEditing((prev) => {
          const next = { ...prev };
          if (next[phase.id]) delete next[phase.id]!.name;
          return next;
        });
        setEditingNameId(null);
        return;
      }
      data = { name: value.trim() };
    } else if (field === 'color') {
      data = { color: value };
    } else if (field === 'wip_limit') {
      const num = value === '' ? null : Number.parseInt(value as string, 10);
      if (num !== null && isNaN(num)) return;
      data = { wip_limit: num };
    } else if (field === 'is_start' || field === 'is_terminal') {
      data = { [field]: value };
    }

    await updatePhase.mutateAsync({ phaseId: phase.id, data });
    setEditing((prev) => {
      const next = { ...prev };
      if (next[phase.id]) delete next[phase.id]![field as keyof typeof edits];
      return next;
    });
    if (field === 'name') setEditingNameId(null);
  };

  const handleToggle = (phase: Phase, field: 'is_start' | 'is_terminal') => {
    const newValue = !phase[field];
    updatePhase.mutate({ phaseId: phase.id, data: { [field]: newValue } });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Manage Phases"
      description="Add, edit, reorder, or remove board columns."
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {/* Phase list */}
        {phases.length > 0 ? (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {phases.map((phase, index) => {
              const edits = getEditValue(phase);
              return (
                <div
                  key={phase.id}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                >
                  {/* Reorder buttons */}
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <button
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0 || reorderPhases.isPending}
                      className="p-0.5 rounded text-zinc-500 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      title="Move up"
                      aria-label={`Move phase ${phase.name} up`}
                    >
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => handleMoveDown(index)}
                      disabled={index === phases.length - 1 || reorderPhases.isPending}
                      className="p-0.5 rounded text-zinc-500 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      title="Move down"
                      aria-label={`Move phase ${phase.name} down`}
                    >
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>

                  {/* Color swatch */}
                  <input
                    type="color"
                    value={edits.color ?? phase.color ?? '#a1a1aa'}
                    onChange={(e) => setEditField(phase.id, 'color', e.target.value)}
                    onBlur={() => handleSaveField(phase, 'color')}
                    className="h-7 w-7 rounded border border-zinc-300 dark:border-zinc-600 cursor-pointer shrink-0 p-0"
                    title="Phase color"
                  />

                  {/* Name - click to edit */}
                  {editingNameId === phase.id ? (
                    <input
                      type="text"
                      value={edits.name ?? phase.name}
                      onChange={(e) => setEditField(phase.id, 'name', e.target.value)}
                      onBlur={() => handleSaveField(phase, 'name')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveField(phase, 'name');
                        if (e.key === 'Escape') {
                          setEditing((prev) => {
                            const next = { ...prev };
                            if (next[phase.id]) delete next[phase.id]!.name;
                            return next;
                          });
                          setEditingNameId(null);
                        }
                      }}
                      autoFocus
                      className="flex-1 min-w-0 text-sm font-medium px-1.5 py-0.5 rounded border border-primary-400 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        setEditingNameId(phase.id);
                        setEditField(phase.id, 'name', phase.name);
                      }}
                      className="flex-1 min-w-0 text-left text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate hover:text-primary-600 dark:hover:text-primary-400 cursor-text"
                      title="Click to edit name"
                    >
                      {phase.name}
                    </button>
                  )}

                  {/* Position badge */}
                  <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums">
                    #{phase.position}
                  </span>

                  {/* WIP limit */}
                  <div className="shrink-0 w-16">
                    <input
                      type="number"
                      min={0}
                      placeholder="WIP"
                      value={edits.wip_limit ?? (phase.wip_limit !== null ? String(phase.wip_limit) : '')}
                      onChange={(e) => setEditField(phase.id, 'wip_limit', e.target.value)}
                      onBlur={() => handleSaveField(phase, 'wip_limit')}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveField(phase, 'wip_limit'); }}
                      className="w-full text-xs px-1.5 py-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-primary-500"
                      title="WIP limit (blank for unlimited)"
                    />
                  </div>

                  {/* is_start toggle */}
                  <button
                    onClick={() => handleToggle(phase, 'is_start')}
                    aria-pressed={phase.is_start}
                    aria-label={phase.is_start ? `Unset ${phase.name} as start phase` : `Set ${phase.name} as start phase`}
                    className={`p-1 rounded shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                      phase.is_start
                        ? 'text-green-600 bg-green-50 dark:bg-green-950'
                        : 'text-zinc-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-950'
                    }`}
                    title={phase.is_start ? 'Start phase (click to unset)' : 'Set as start phase'}
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>

                  {/* is_terminal toggle */}
                  <button
                    onClick={() => handleToggle(phase, 'is_terminal')}
                    aria-pressed={phase.is_terminal}
                    aria-label={phase.is_terminal ? `Unset ${phase.name} as terminal phase` : `Set ${phase.name} as terminal phase`}
                    className={`p-1 rounded shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                      phase.is_terminal
                        ? 'text-blue-600 bg-blue-50 dark:bg-blue-950'
                        : 'text-zinc-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950'
                    }`}
                    title={phase.is_terminal ? 'Terminal phase (click to unset)' : 'Set as terminal phase'}
                  >
                    <Flag className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(phase)}
                    disabled={deletePhase.isPending}
                    className="p-1 rounded text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    title="Delete phase"
                    aria-label={`Delete phase ${phase.name}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-zinc-400 py-2">No phases yet. Create one to get started.</p>
        )}

        {/* Legend */}
        <div className="flex gap-4 text-[11px] text-zinc-400 px-1">
          <span className="flex items-center gap-1">
            <Play className="h-3 w-3 text-green-500" /> Start
          </span>
          <span className="flex items-center gap-1">
            <Flag className="h-3 w-3 text-blue-500" /> Terminal
          </span>
        </div>

        {/* Create form */}
        {showForm ? (
          <div className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50 dark:bg-zinc-800/50">
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <Input
                  id="phase-name"
                  label="Phase Name"
                  placeholder="e.g. In Review"
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
                loading={createPhase.isPending}
                disabled={!newName.trim()}
              >
                Add Phase
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4" />
            Add Phase
          </Button>
        )}
      </div>
    </Dialog>
  );
}
