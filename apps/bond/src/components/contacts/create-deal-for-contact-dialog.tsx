import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Button } from '@/components/common/button';
import { Select } from '@/components/common/select';
import { useCreateDeal, useAddDealContact } from '@/hooks/use-deals';
import { usePipelines, type Pipeline } from '@/hooks/use-pipelines';

interface CreateDealForContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  /** Pre-fill company association from the contact, when known. */
  companyId?: string | null;
  onSuccess?: (dealId: string) => void;
}

function firstActiveStageId(pipeline: Pipeline | undefined): string {
  if (!pipeline) return '';
  const stages = [...pipeline.stages].sort((a, b) => a.sort_order - b.sort_order);
  const active = stages.find((s) => s.stage_type === 'active');
  return (active ?? stages[0])?.id ?? '';
}

export function CreateDealForContactDialog({
  open,
  onOpenChange,
  contactId,
  companyId,
  onSuccess,
}: CreateDealForContactDialogProps) {
  const { data: pipelinesData, isLoading: pipelinesLoading } = usePipelines();
  const pipelines = useMemo(() => pipelinesData?.data ?? [], [pipelinesData]);

  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const createDeal = useCreateDeal();
  const addDealContact = useAddDealContact();

  // Default the pipeline selection to the org default (or the first pipeline).
  useEffect(() => {
    const def = pipelines.find((p) => p.is_default) ?? pipelines[0];
    if (open && def) {
      setPipelineId((prev) => prev || def.id);
    }
    if (!open) {
      setName('');
      setValue('');
      setPipelineId('');
    }
  }, [open, pipelines]);

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const stageId = firstActiveStageId(selectedPipeline);

  const pending = createDeal.isPending || addDealContact.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !pipelineId || !stageId) return;

    const result = await createDeal.mutateAsync({
      name: name.trim(),
      pipeline_id: pipelineId,
      stage_id: stageId,
      value: value ? Math.round(Number.parseFloat(value) * 100) : undefined,
      company_id: companyId ?? undefined,
    });

    // Associate the new deal with the contact this dialog was opened from.
    await addDealContact.mutateAsync({ dealId: result.data.id, contactId });

    onOpenChange(false);
    onSuccess?.(result.data.id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create Deal"
      description="Add a new deal linked to this contact."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Deal Name"
          placeholder="e.g., Acme Corp - Enterprise Plan"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <Input
          label="Value ($)"
          type="number"
          placeholder="e.g., 25000"
          min="0"
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Select
          label="Pipeline"
          value={pipelineId}
          onValueChange={setPipelineId}
          options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
          placeholder={pipelinesLoading ? 'Loading...' : 'Select pipeline...'}
        />
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={pending} disabled={!name.trim() || !pipelineId || !stageId}>
            Create Deal
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
