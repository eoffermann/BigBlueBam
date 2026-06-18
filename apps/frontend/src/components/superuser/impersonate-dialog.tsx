import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Dialog } from '@/components/common/dialog';
import { superuserUsersApi } from '@/lib/api/superuser-users';
import { setImpersonation } from '@/lib/impersonation';

/**
 * SuperUser impersonation dialog. Starts a time-limited impersonation session
 * (POST /v1/platform/impersonate) for the target user, then reloads into Bam as
 * that user. Shared by the legacy SuperUser people-detail page and the People
 * Manager detail page so there is one copy of the flow + its error handling.
 *
 * The caller is responsible for gating visibility to SuperUsers (and, ideally,
 * to active, non-SuperUser targets — the API also rejects impersonating
 * deactivated users and other SuperUsers, surfaced here as the mutation error).
 */
export interface ImpersonateTarget {
  id: string;
  display_name?: string | null;
  email: string;
}

export function ImpersonateDialog({
  user,
  onClose,
}: {
  user: ImpersonateTarget;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const impersonate = useMutation({
    mutationFn: () => superuserUsersApi.impersonate(user.id, reason.trim() || undefined),
    onSuccess: () => {
      // Persist the target so the api client echoes X-Impersonate-User on every
      // subsequent request, then reload into Bam as that user.
      setImpersonation({ user_id: user.id, display_name: user.display_name || user.email });
      window.location.href = '/b3/';
    },
  });
  const err = impersonate.error as Error | null;

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Impersonate user"
      description={`You will act as ${user.display_name || user.email} until you end the impersonation session.`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          impersonate.mutate();
        }}
        className="space-y-4"
      >
        <Input
          label="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Investigating support ticket #1234"
          autoFocus
        />
        {err && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
            {err.message}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={impersonate.isPending}>
            <LogIn className="h-4 w-4" /> Impersonate
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
