// Client-side impersonation state (SuperUser "act as" / masquerade).
//
// Canonical implementation lives in @bigbluebam/ui/impersonation-banner so the
// localStorage key + shape are shared across every SPA (impersonation activates
// per-request via X-Impersonate-User; the key is shared because all apps are on
// one origin). This module just re-exports so existing Bam imports of
// '@/lib/impersonation' keep working against the single source of truth.
export {
  getImpersonation,
  setImpersonation,
  clearImpersonation,
  impersonateHeader,
  type ImpersonationState,
} from '@bigbluebam/ui/impersonation-banner';
