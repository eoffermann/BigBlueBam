// Client-side impersonation state (SuperUser "act as" / masquerade).
//
// The Bam API activates impersonation per-request via the `X-Impersonate-User`
// header (verified against an active impersonation_sessions row created by
// POST /v1/platform/impersonate — see apps/api/src/plugins/auth.ts). So once a
// SuperUser starts a session, the browser must echo the target user id on every
// request and offer a way to stop. We persist the target here so the api client
// can attach the header and the banner can render + end the session.
//
// localStorage (not a cookie) because the header is read by JS, the value is
// non-sensitive (a user id the SU already chose), and it must survive the
// full-page reload that swaps the session into the impersonated view.

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
