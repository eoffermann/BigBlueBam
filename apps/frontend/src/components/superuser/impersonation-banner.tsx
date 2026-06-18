import { useMutation } from '@tanstack/react-query';
import { UserCog, X } from 'lucide-react';
import { getImpersonation, clearImpersonation } from '@/lib/impersonation';
import { superuserUsersApi } from '@/lib/api/superuser-users';

/**
 * Global banner shown while a SuperUser is impersonating another user. Reads the
 * client-side impersonation state (localStorage); renders nothing for normal
 * sessions. "Stop impersonating" ends the server session and reloads back into
 * the SuperUser's own account. It clears + reloads even if the stop call errors,
 * so the operator can never get stuck in an impersonated view.
 */
export function ImpersonationBanner() {
  const state = getImpersonation();
  const stop = useMutation({
    mutationFn: () => superuserUsersApi.stopImpersonation(),
    onSettled: () => {
      clearImpersonation();
      window.location.href = '/b3/';
    },
  });

  if (!state) return null;

  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-sm font-medium text-amber-950">
      <UserCog className="h-4 w-4 flex-shrink-0" />
      <span>
        Viewing as <strong>{state.display_name}</strong> — you are impersonating this user.
      </span>
      <button
        type="button"
        onClick={() => stop.mutate()}
        disabled={stop.isPending}
        className="inline-flex items-center gap-1 rounded-md bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20 disabled:opacity-60"
      >
        {stop.isPending ? (
          'Stopping…'
        ) : (
          <>
            <X className="h-3.5 w-3.5" /> Stop impersonating
          </>
        )}
      </button>
    </div>
  );
}
