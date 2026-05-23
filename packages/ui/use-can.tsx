/**
 * useCan / usePermissions — per-action permission hooks for BigBlueBam SPAs.
 *
 * Wave E.C of the permissions overhaul (docs/permissions-overhaul-plan.md
 * §Wave-D, "useCan in @bigbluebam/ui"). Replaces the ~100 inline
 * `user.role === 'admin'` / `is_superuser` JSX gates spread across 14
 * frontends with a single source-of-truth call:
 *
 *   const canInvite = useCan('bam.org_member.invite');
 *   {canInvite && <InviteButton />}
 *
 * The hook reads the materialized permission matrix served on /auth/me
 * (see apps/api/src/routes/auth.routes.ts -> computePermissionMatrix).
 * TanStack Query caches it in-memory for 5 minutes and refetches on
 * window focus; cross-tab invalidation rides on the same `perms:invalidate:*`
 * Redis pubsub the api uses to flush its server-side cache (the hook
 * observes that channel indirectly via the next /auth/me refetch when the
 * SPA's websocket reconnects).
 *
 * Deny-by-default semantics: until the matrix is loaded, useCan returns
 * `false`. This keeps unsafe buttons hidden during mount/refetch — better
 * a momentary UI flicker than a brief flash of "Delete Organization".
 *
 * Permission ids follow `<app>.<resource>.<verb>`; the canonical list is
 * exported from @bigbluebam/permissions as PERMISSIONS / PERMISSIONS_BY_ID.
 */

import { useQuery } from '@tanstack/react-query';
import {
  usePermissionsContext,
  type AuthMeResponseLike,
  type PermissionsFetcher,
} from './permissions-context';

export type PermissionMatrix = Record<string, boolean>;

export interface UseCanOptions {
  /**
   * Override the context-supplied fetcher. Useful for tests and one-off
   * call sites that don't have a Provider in scope. Production callers
   * should rely on the Provider so cache keys stay consistent.
   */
  fetcher?: PermissionsFetcher;
  /**
   * Namespace the TanStack Query cache entry. Defaults to the value the
   * Provider supplies or 'default'. Pass an explicit value when two
   * different fetchers share a single QueryClient.
   */
  queryScope?: string;
}

const DEFAULT_QUERY_SCOPE = 'default';
const STALE_TIME_MS = 5 * 60 * 1000; // 5 min, matches Redis ctx TTL

function permissionsQueryKey(scope: string): readonly unknown[] {
  return ['permissions', 'matrix', scope] as const;
}

function resolveFetcher(opts: UseCanOptions | undefined, ctxFetcher: PermissionsFetcher | undefined): PermissionsFetcher | null {
  if (opts?.fetcher) return opts.fetcher;
  if (ctxFetcher) return ctxFetcher;
  return null;
}

/**
 * Returns the full permission matrix. Most callers want `useCan(id)` instead;
 * this is for advanced cases (e.g. rendering a settings page that lists every
 * permission a user has).
 */
export function usePermissions(opts?: UseCanOptions): PermissionMatrix {
  const ctx = usePermissionsContext();
  const fetcher = resolveFetcher(opts, ctx?.fetcher);
  const scope = opts?.queryScope ?? ctx?.queryScope ?? DEFAULT_QUERY_SCOPE;

  const { data } = useQuery({
    queryKey: permissionsQueryKey(scope),
    enabled: fetcher != null,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PermissionMatrix> => {
      if (!fetcher) return {};
      const response: AuthMeResponseLike = await fetcher();
      const matrix = response?.data?.permissions;
      if (!matrix || typeof matrix !== 'object') return {};
      return matrix;
    },
  });

  return data ?? {};
}

/**
 * Returns `true` when the current user is allowed the named permission.
 * Deny-by-default while the matrix is loading (returns `false`).
 *
 * The hook intentionally does NOT throw on unknown permission ids — it
 * just returns `false`. This keeps the call sites' types simple and means
 * a typo in a permission id produces a hidden button rather than a
 * runtime crash. The Wave E.D codemod runs against the catalog so typos
 * are caught at codemod time.
 *
 * SuperUser bypass and the always-permitted core are baked into the
 * matrix server-side (the resolver short-circuits before the per-id
 * iteration), so the hook needs no special-casing for them.
 *
 * @example
 *   const canDeleteTask = useCan('bam.task.delete');
 *   if (canDeleteTask) return <DeleteButton />;
 */
export function useCan(permissionId: string, opts?: UseCanOptions): boolean {
  const matrix = usePermissions(opts);
  return matrix[permissionId] === true;
}
