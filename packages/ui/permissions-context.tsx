/**
 * PermissionsProvider — fetcher context for the `useCan` hook.
 *
 * Each BigBlueBam SPA has its own API client (apps/frontend/src/lib/api.ts,
 * apps/banter/src/lib/api.ts, etc.) with its own base URL. Rather than
 * baking a specific client into @bigbluebam/ui, the host SPA passes its
 * `/auth/me` fetcher down through this Provider and `useCan` consumes it
 * via TanStack Query.
 *
 * Wire at the root of every SPA, inside the QueryClientProvider:
 *
 *   <QueryClientProvider client={queryClient}>
 *     <PermissionsProvider fetcher={fetchAuthMe}>
 *       <App />
 *     </PermissionsProvider>
 *   </QueryClientProvider>
 *
 * where `fetchAuthMe` is a function returning the parsed `{ data: { ... } }`
 * response of GET /auth/me (or the satellite's equivalent). Most apps will
 * reuse their existing api-client wrapper, e.g.:
 *
 *   const fetchAuthMe = () => api.get<{ data: AuthMeResponse }>('/auth/me');
 *
 * The hook is fetcher-agnostic on purpose so satellite SPAs (banter, bond,
 * beacon, ...) can point at their own auth/me endpoints without duplicating
 * the hook itself.
 */

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The shape `useCan` consumes from the fetcher. The full /auth/me response
 * has many more fields; the hook only reads `permissions`, but it tolerates
 * a missing/empty matrix (deny-by-default).
 */
export interface AuthMeResponseLike {
  data?: {
    permissions?: Record<string, boolean>;
    [key: string]: unknown;
  };
}

export type PermissionsFetcher = () => Promise<AuthMeResponseLike>;

export interface PermissionsContextValue {
  fetcher: PermissionsFetcher;
  /**
   * Cache key segment used to namespace TanStack Query entries across apps
   * that wire different fetchers in the same QueryClient. Defaults to
   * 'default'; pass e.g. 'banter' from a satellite SPA if you ever share a
   * QueryClient across SPAs in one bundle.
   */
  queryScope?: string;
}

const PermissionsContext = createContext<PermissionsContextValue | null>(null);

export interface PermissionsProviderProps {
  fetcher: PermissionsFetcher;
  queryScope?: string;
  children: ReactNode;
}

export function PermissionsProvider({
  fetcher,
  queryScope,
  children,
}: PermissionsProviderProps) {
  return (
    <PermissionsContext.Provider value={{ fetcher, queryScope }}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissionsContext(): PermissionsContextValue | null {
  return useContext(PermissionsContext);
}
