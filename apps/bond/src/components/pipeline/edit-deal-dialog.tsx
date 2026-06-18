import { useEffect, useState } from 'react';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Button } from '@/components/common/button';
import { useUpdateDeal, type Deal } from '@/hooks/use-deals';

interface EditDealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal: Deal;
  onSuccess?: () => void;
}

export function EditDealDialog({ open, onOpenChange, deal, onSuccess }: EditDealDialogProps) {
  const [name, setName] = useState(deal.name);
  const [description, setDescription] = useState(deal.description ?? '');
  const [value, setValue] = useState(deal.value != null ? String(deal.value / 100) : '');
  const [expectedClose, setExpectedClose] = useState(
    deal.expected_close_date ? deal.expected_close_date.slice(0, 10) : '',
  );
  const updateDeal = useUpdateDeal(deal.id);

  // Re-sync local state whenever the dialog is (re)opened for a deal.
  useEffect(() => {
    if (open) {
      setName(deal.name);
      setDescription(deal.description ?? '');
      setValue(deal.value != null ? String(deal.value / 100) : '');
      setExpectedClose(deal.expected_close_date ? deal.expected_close_date.slice(0, 10) : '');
    }
  }, [open, deal]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    await updateDeal.mutateAsync({
      name: name.trim(),
      description: description.trim() || undefined,
      value: value !== '' ? Math.round(Number.parseFloat(value) * 100) : undefined,
      expected_close_date: expectedClose || undefined,
    });

    onOpenChange(false);
    onSuccess?.();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Deal"
      description="Update the deal details."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Deal Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Input
          label="Value ($)"
          type="number"
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
          <Button type="submit" loading={updateDeal.isPending} disabled={!name.trim()}>
            Save Changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
