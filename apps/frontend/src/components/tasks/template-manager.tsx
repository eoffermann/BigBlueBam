import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2, FileText } from 'lucide-react';
import { Dialog } from '@/components/common/dialog';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { api } from '@/lib/api';

interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  priority: string;
  story_points: number | null;
  label_ids: string[];
}

interface TemplateManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

const PRIORITY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

export function TemplateManager({ open, onOpenChange, projectId }: TemplateManagerProps) {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState('medium');
  const [newStoryPoints, setNewStoryPoints] = useState('');

  const { data: templatesRes, isLoading } = useQuery({
    queryKey: ['task-templates', projectId],
    queryFn: () =>
      api.get<{ data: TaskTemplate[] }>(`/projects/${projectId}/task-templates`),
    enabled: !!projectId && open,
  });
  const templates = templatesRes?.data ?? [];

  const createTemplate = useMutation({
    mutationFn: (data: { name: string; description: string; priority: string; story_points: number | null }) =>
      api.post(`/projects/${projectId}/task-templates`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-templates', projectId] });
      setShowCreateForm(false);
      resetForm();
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: (templateId: string) =>
      api.delete(`/projects/${projectId}/task-templates/${templateId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-templates', projectId] });
    },
  });

  const resetForm = () => {
    setNewName('');
    setNewDescription('');
    setNewPriority('medium');
    setNewStoryPoints('');
  };

  const handleCreate = () => {
    if (!newName.trim()) return;
    createTemplate.mutate({
      name: newName.trim(),
      description: newDescription.trim(),
      priority: newPriority,
      story_points: newStoryPoints ? Number.parseInt(newStoryPoints, 10) : null,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Task Templates"
      description="Create and manage reusable task templates."
    >
      <div className="space-y-4 min-h-[200px]">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
          </div>
        ) : (
          <>
            {/* Template list */}
            {templates.length > 0 ? (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700"
                  >
                    <FileText className="h-4 w-4 text-zinc-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {t.name}
                      </p>
                      {t.description && (
                        <p className="text-xs text-zinc-500 truncate">{t.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-zinc-400 capitalize">{t.priority}</span>
                        {t.story_points != null && (
                          <span className="text-xs text-zinc-400">{t.story_points} pts</span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteTemplate.mutate(t.id)}
                      disabled={deleteTemplate.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : !showCreateForm ? (
              <div className="text-center py-6">
                <FileText className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
                <p className="text-sm text-zinc-400">No templates yet</p>
              </div>
            ) : null}

            {/* Create form */}
            {showCreateForm ? (
              <div className="space-y-3 p-4 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
                <Input
                  id="template-name"
                  label="Template Name"
                  placeholder="e.g. Bug Report"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Description
                  </label>
                  <textarea
                    placeholder="Template description or default task description..."
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-y"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Priority"
                    options={PRIORITY_OPTIONS}
                    value={newPriority}
                    onValueChange={setNewPriority}
                  />
                  <Input
                    id="template-points"
                    label="Story Points"
                    type="number"
                    min={0}
                    placeholder="0"
                    value={newStoryPoints}
                    onChange={(e) => setNewStoryPoints(e.target.value)}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setShowCreateForm(false);
                      resetForm();
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleCreate}
                    loading={createTemplate.isPending}
                    disabled={!newName.trim()}
                  >
                    Create Template
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="secondary"
                onClick={() => setShowCreateForm(true)}
                className="w-full"
              >
                <Plus className="h-4 w-4" />
                New Template
              </Button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
