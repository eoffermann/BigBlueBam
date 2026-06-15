import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PRIORITIES } from '@bigbluebam/shared';
import { usePriorityMap } from '@/hooks/use-priorities';
import type { Phase } from '@bigbluebam/shared';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Button } from '@/components/common/button';
import { Select } from '@/components/common/select';
import { DatePicker } from '@/components/common/date-picker';
import { RichTextEditor } from '@/components/common/rich-text-editor';
import { api } from '@/lib/api';

const createTaskFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  phase_id: z.string().uuid('Select a phase'),
  priority: z.enum(PRIORITIES).optional(),
  story_points: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? undefined : Number(val)),
    z.number().int().positive().optional(),
  ),
  description: z.string().optional(),
  assignee_id: z.string().optional(),
  due_date: z.string().optional(),
  label_ids: z.array(z.string()).optional(),
});

type CreateTaskFormValues = z.infer<typeof createTaskFormSchema>;

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phases: Phase[];
  defaultPhaseId?: string;
  onSubmit: (data: CreateTaskFormValues) => void;
  isLoading?: boolean;
  members?: { id: string; display_name: string }[];
  labels?: { id: string; name: string; color: string }[];
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  phases,
  defaultPhaseId,
  onSubmit,
  isLoading,
  members = [],
  labels = [],
}: CreateTaskDialogProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<CreateTaskFormValues>({
    // z.preprocess(...) widens story_points' input type to unknown, so
    // zodResolver's inferred Resolver shape doesn't match useForm's
    // TFieldValues. Cast through any; the runtime resolver is correct,
    // it's purely a generic-alignment issue.
    // biome-ignore lint/suspicious/noExplicitAny: see comment above
    resolver: zodResolver(createTaskFormSchema) as any,
    defaultValues: {
      title: '',
      phase_id: defaultPhaseId ?? '',
      priority: 'medium',
      description: '',
      assignee_id: undefined,
      due_date: undefined,
      label_ids: [],
    },
  });

  // Update phase_id when defaultPhaseId changes (e.g., clicking + on a column)
  useEffect(() => {
    if (defaultPhaseId && open) {
      setValue('phase_id', defaultPhaseId);
    }
  }, [defaultPhaseId, open, setValue]);

  const phaseOptions = phases.map((p) => ({ value: p.id, label: p.name }));
  const { ordered: priorityRows } = usePriorityMap();
  const priorityOptions = priorityRows.map((p) => ({
    value: p.value,
    label: p.name,
  }));

  const memberOptions = [
    { value: '__none__', label: 'Unassigned' },
    ...members.map((m) => ({ value: m.id, label: m.display_name })),
  ];

  const handleFormSubmit = (data: CreateTaskFormValues) => {
    // Clean assignee_id sentinel
    if (data.assignee_id === '__none__') {
      data.assignee_id = undefined;
    }
    onSubmit(data);
    reset();
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  };

  const selectedLabelIds = watch('label_ids') ?? [];

  const toggleLabel = (labelId: string) => {
    const current = selectedLabelIds;
    if (current.includes(labelId)) {
      setValue('label_ids', current.filter((id) => id !== labelId));
    } else {
      setValue('label_ids', [...current, labelId]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} title="Create Task" description="Add a new task to the board.">
      <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4">
        <Input
          id="title"
          label="Title"
          placeholder="What needs to be done?"
          error={errors.title?.message}
          {...register('title')}
          autoFocus
        />

        <Select
          label="Phase"
          options={phaseOptions}
          value={watch('phase_id')}
          onValueChange={(val) => setValue('phase_id', val)}
          error={errors.phase_id?.message}
        />

        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Priority"
            options={priorityOptions}
            value={watch('priority') ?? 'medium'}
            onValueChange={(val) => setValue('priority', val as CreateTaskFormValues['priority'])}
          />
          <Input
            id="story_points"
            label="Story Points"
            type="number"
            min={1}
            placeholder="0"
            error={errors.story_points?.message}
            {...register('story_points')}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Assignee picker */}
          {members.length > 0 && (
            <Select
              label="Assignee"
              options={memberOptions}
              value={watch('assignee_id') ?? '__none__'}
              onValueChange={(val) => setValue('assignee_id', val)}
            />
          )}

          {/* Due date */}
          <DatePicker
            id="due_date"
            label="Due Date"
            value={watch('due_date') ?? ''}
            onChange={(val) => setValue('due_date', val || undefined)}
          />
        </div>

        {/* Labels multi-select */}
        {labels.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Labels</label>
            <div className="flex flex-wrap gap-2">
              {labels.map((label) => {
                const isSelected = selectedLabelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => toggleLabel(label.id)}
                    aria-pressed={isSelected}
                    aria-label={`${isSelected ? 'Remove' : 'Add'} label ${label.name}`}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                      isSelected
                        ? 'border-transparent ring-2 ring-primary-500 ring-offset-1'
                        : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300'
                    }`}
                    style={{
                      backgroundColor: `${label.color}20`,
                      color: label.color,
                    }}
                  >
                    {label.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Description
          </label>
          <RichTextEditor
            value={watch('description') ?? ''}
            onChange={(val) => setValue('description', val)}
            placeholder="Add a description..."
            minRows={3}
            onImageUpload={async (file) => {
              const formData = new FormData();
              formData.append('file', file);
              const res = await api.upload<{ url: string }>('/upload', formData);
              return res.url ?? (res as unknown as { data: { url: string } }).data?.url ?? '';
            }}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={isLoading}>
            Create Task
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
