/**
 * Canonical SuperUser impersonation banner + state, shared across every
 * BigBlueBam SPA. Imported via the same alias as the other shared components:
 *   '@bigbluebam/ui/impersonation-banner'
 *
 * Why shared/universal: impersonation is activated PER REQUEST by the
 * `X-Impersonate-User` header (verified server-side against an active
 * impersonation_sessions row — see apps/api/src/plugins/auth.ts). Every SPA is
 * served on the same browser origin, so the `bbb-impersonation` localStorage key
 * is shared. Each app therefore (a) echoes the header on every request via
 * `impersonateHeader()` so the API swaps to the target there too, and (b) mounts
 * <ImpersonationBanner/> once in its layout so the operator always sees they're
 * impersonating and can get out — from ANY app, not just Bam.
 *
 * Stop is intentionally self-contained: it POSTs straight to the Bam api
 * (/b3/api/v1/platform/stop-impersonation, reachable from any same-origin app)
 * and clears + reloads even if that call errors, so the operator can never be
 * trapped in an impersonated view.
 */

import { useState } from 'react';
import { UserCog, X } from 'lucide-react';

const KEY = 'bbb-impersonation';

export interface ImpersonationState {
  user_id: string;
  display_name: string;
}

export function getImpersonation(): ImpersonationState | null {
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonationState;
    return parsed && typeof parsed.user_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function setImpersonation(state: ImpersonationState): void {
  try {
    window.localStorage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Non-fatal: without storage, impersonation simply won't activate.
  }
}

export function clearImpersonation(): void {
  try {
    window.localStorage?.removeItem(KEY);
  } catch {
    // Non-fatal.
  }
}

/**
 * Request headers an api client should merge in so impersonation takes effect
 * in this app. Returns {} for normal sessions, so it's inert unless an "act as"
 * session is active.
 */
export function impersonateHeader(): Record<string, string> {
  const state = getImpersonation();
  return state ? { 'X-Impersonate-User': state.user_id } : {};
}

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function ImpersonationBanner() {
  const state = getImpersonation();
  const [stopping, setStopping] = useState(false);
  if (!state) return null;

  const stop = async () => {
    setStopping(true);
    try {
      const csrf = readCsrfToken();
      await fetch('/b3/api/v1/platform/stop-impersonation', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Impersonate-User': state.user_id,
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
      });
    } catch {
      // Ignore — we still clear + reload so the operator is never trapped.
    } finally {
      clearImpersonation();
      // Send the operator back to Bam as themselves.
      window.location.href = '/b3/';
    }
  };

  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-sm font-medium text-amber-950">
      <UserCog className="h-4 w-4 flex-shrink-0" />
      <span>
        Viewing as <strong>{state.display_name}</strong> — you are impersonating this user.
      </span>
      <button
        type="button"
        onClick={stop}
        disabled={stopping}
        className="inline-flex items-center gap-1 rounded-md bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20 disabled:opacity-60"
      >
        {stopping ? (
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
