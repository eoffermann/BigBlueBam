import { useEffect, useState } from 'react';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Button } from '@/components/common/button';
import { useCloseDealLost } from '@/hooks/use-deals';

interface LoseDealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  onSuccess?: () => void;
}

export function LoseDealDialog({ open, onOpenChange, dealId, onSuccess }: LoseDealDialogProps) {
  const [closeReason, setCloseReason] = useState('');
  const [lostToCompetitor, setLostToCompetitor] = useState('');
  const closeDealLost = useCloseDealLost();

  useEffect(() => {
    if (open) {
      setCloseReason('');
      setLostToCompetitor('');
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    await closeDealLost.mutateAsync({
      dealId,
      close_reason: closeReason.trim() || undefined,
      lost_to_competitor: lostToCompetitor.trim() || undefined,
    });

    onOpenChange(false);
    onSuccess?.();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark Deal as Lost"
      description="Record why this deal was lost so it shows in reporting."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Reason"
          placeholder="e.g., Budget cut, chose a competitor, timing"
          value={closeReason}
          onChange={(e) => setCloseReason(e.target.value)}
          autoFocus
        />
        <Input
          label="Lost to Competitor (optional)"
          placeholder="e.g., Acme Rival Inc."
          value={lostToCompetitor}
          onChange={(e) => setLostToCompetitor(e.target.value)}
        />
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={closeDealLost.isPending}>
            Mark as Lost
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
