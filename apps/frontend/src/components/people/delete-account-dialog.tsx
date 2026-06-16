import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Dialog } from '@/components/common/dialog';

interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown in the title/copy ("Delete <label>?"). */
  userLabel: string;
  /**
   * The exact string the operator must type to arm the Delete button. We use
   * the account's email — it's unique, unambiguous, and on-screen, so typing it
   * is a deliberate confirmation rather than a reflexive click.
   */
  confirmPhrase: string;
  /**
   * Performs the soft-delete. The caller injects org scoping (X-Org-Id) so this
   * dialog is reusable across the roster and the detail page. `reason` is the
   * optional audit-log note.
   */
  onConfirm: (reason: string | undefined) => Promise<unknown>;
  /** Called after a successful delete (parent navigates / invalidates). */
  onDeleted?: () => void;
}

/**
 * Soft-delete confirmation with a typed verification phrase (plan §1).
 *
 * The Delete button stays disabled until the operator types the account's email
 * exactly, guarding the most destructive, account-level action behind more than
 * a single click. Shared by the People Manager roster row and the detail-page
 * Danger zone so the gesture is identical in both places.
 */
export function DeleteAccountDialog({
  open,
  onOpenChange,
  userLabel,
  confirmPhrase,
  onConfirm,
  onDeleted,
}: DeleteAccountDialogProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');

  const del = useMutation({
    mutationFn: () => onConfirm(reason.trim() || undefined),
    onSuccess: () => {
      onOpenChange(false);
      onDeleted?.();
      // Defer the field reset so it doesn't flash during the close animation.
      window.setTimeout(() => {
        setReason('');
        setTyped('');
        del.reset();
      }, 200);
    },
  });

  const close = () => {
    onOpenChange(false);
    window.setTimeout(() => {
      setReason('');
      setTyped('');
      del.reset();
    }, 200);
  };

  const matched = typed.trim() === confirmPhrase;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={`Delete ${userLabel}?`}
      description="This soft-deletes the account across every org, revokes its sessions and API keys, and frees the email for a fresh invite. Authored content is preserved. It cannot be undone."
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="delete-account-confirm"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            Type <span className="font-mono font-semibold text-red-700 dark:text-red-300">{confirmPhrase}</span> to confirm
          </label>
          <Input
            id="delete-account-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmPhrase}
            autoComplete="off"
            autoFocus
          />
        </div>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Reason (optional — recorded in the audit log)"
          className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white px-2.5 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-950 dark:text-zinc-100"
        />

        {del.isError && (
          <p className="text-xs text-red-600">{(del.error as Error)?.message ?? 'Delete failed'}</p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            disabled={!matched}
            onClick={() => del.mutate()}
          >
            <Trash2 className="h-4 w-4" /> Delete account
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
