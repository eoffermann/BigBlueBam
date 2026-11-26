import { useState } from 'react';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Button } from '@/components/common/button';
import { useCreateDeal } from '@/hooks/use-deals';

interface CreateDealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelineId: string;
  stageId: string;
  onSuccess?: (dealId: string) => void;
}

export function CreateDealDialog({ open, onOpenChange, pipelineId, stageId, onSuccess }: CreateDealDialogProps) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [expectedClose, setExpectedClose] = useState('');
  const createDeal = useCreateDeal();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const result = await createDeal.mutateAsync({
      name: name.trim(),
      pipeline_id: pipelineId,
      stage_id: stageId,
      value: value ? Math.round(Number.parseFloat(value) * 100) : undefined,
      expected_close_date: expectedClose || undefined,
    });

    setName('');
    setValue('');
    setExpectedClose('');
    onOpenChange(false);
    onSuccess?.(result.data.id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create Deal"
      description="Add a new deal to the pipeline."
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
        <Input
          label="Expected Close Date"
          type="date"
          value={expectedClose}
          onChange={(e) => setExpectedClose(e.target.value)}
        />
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={createDeal.isPending} disabled={!name.trim()}>
            Create Deal
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
