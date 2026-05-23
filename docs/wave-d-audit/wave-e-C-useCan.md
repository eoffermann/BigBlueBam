# Wave E.C — `useCan` hook for SPA permission gates

Status: shipped (Wave E.C). Owners of SPA codemod work (Wave E.D) read this
to understand the contract before touching any JSX.

## Why this exists

Wave D ended with the per-action resolver enforcing on the server but every
SPA still gating UI on `user.role === 'admin'` or `user.is_superuser`.
Those checks were fine before per-action permissions existed — they're not
fine now. A user with the new `bam.org_member.invite` permission granted
via a custom group will fail the inline `role === 'admin'` check and have
the Invite button hidden, even though the server would accept the call.

`useCan(permission_id)` replaces those checks with a query against the
materialized permission matrix the API ships on `/auth/me`.

## Hook API

Imports:

```ts
import { useCan, usePermissions, type PermissionMatrix } from '@bigbluebam/ui/use-can';
import { PermissionsProvider, type PermissionsFetcher } from '@bigbluebam/ui/permissions-context';
```

Signatures:

```ts
function useCan(permissionId: string, opts?: UseCanOptions): boolean;
function usePermissions(opts?: UseCanOptions): PermissionMatrix;

interface UseCanOptions {
  /** Override the context-supplied fetcher (mostly for tests). */
  fetcher?: PermissionsFetcher;
  /** Namespace the TanStack Query cache entry. Default: 'default'. */
  queryScope?: string;
}

type PermissionsFetcher = () => Promise<{
  data?: { permissions?: Record<string, boolean>; [key: string]: unknown };
}>;
```

Behavior:

- Reads the per-(user, active_org) matrix shipped on `/auth/me`. Empty/
  missing matrix → every `useCan` returns `false` (deny-by-default while
  the matrix is loading or unavailable). Prefer a momentary hidden button
  over flashing a privileged action that the server would reject.
- Cached via TanStack Query (`queryKey: ['permissions', 'matrix', scope]`,
  `staleTime: 5 min`, `refetchOnWindowFocus: true`). The TTL matches the
  server-side `perms:matrix:<user_id>:<org_id>` Redis cache so they expire
  together.
- Unknown / typo'd permission ids return `false`, never throw. Catch typos
  at codemod time (Wave E.D walks the catalog and asserts every id exists
  in `@bigbluebam/permissions`'s `PERMISSIONS_BY_ID`).
- SuperUser bypass and always-permitted-core handling are baked into the
  matrix server-side (the resolver short-circuits before iteration). The
  hook does NOT special-case `is_superuser` — the matrix already reflects
  it.

## Wiring the Provider

Every SPA must wrap its tree in `<PermissionsProvider>` inside the
`QueryClientProvider`. The Provider takes a single `fetcher` callback that
returns the parsed `/auth/me` response. For most SPAs this is a one-line
reuse of the existing api-client wrapper:

```tsx
// apps/frontend/src/main.tsx (example wiring)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import { api } from './lib/api';

const queryClient = new QueryClient();

// Reuses the SPA's existing api client. The response shape matches
// AuthMeResponseLike out of the box (api returns { data: { ... } }).
const fetchAuthMe = () => api.get<{ data: { permissions?: Record<string, boolean> } }>('/auth/me');

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <PermissionsProvider fetcher={fetchAuthMe}>
      <App />
    </PermissionsProvider>
  </QueryClientProvider>,
);
```

Satellite SPAs (banter, beacon, bond, ...) call their own auth/me through
their own api client — drop the satellite's fetcher in here exactly the
same way. The hook is fetcher-agnostic on purpose so each SPA can point at
its own backend (banter-api, beacon-api, ...).

The auth store can stay as-is; the hook deliberately does NOT read
`useAuthStore` because that would couple the shared package to a
SPA-specific store. The matrix is a separate concern from the user record.

## Migration recipe

Permission ids follow `<app>.<resource>.<verb>` — the same names emitted by
the action manifest and re-exported as `PERMISSIONS` /
`PERMISSIONS_BY_ID` from `@bigbluebam/permissions`. The list lives in
`packages/permissions/src/generated/permissions.ts` (1047 entries across
17 apps).

### Pattern 1: simple role check

```tsx
// Before
if (user.role === 'admin' || user.role === 'owner') {
  return <InviteMemberButton />;
}

// After
const canInvite = useCan('bam.org_member.invite');
if (canInvite) {
  return <InviteMemberButton />;
}
```

### Pattern 2: inline JSX guard

```tsx
// Before
{user.role !== 'viewer' && <CreateTaskButton />}

// After
const canCreateTask = useCan('bam.task.create');
{canCreateTask && <CreateTaskButton />}
```

### Pattern 3: multiple actions on one screen

```tsx
// Before (one role check shadowing several actions)
const canManage = user.role === 'admin' || user.role === 'owner';
return (
  <>
    {canManage && <EditButton />}
    {canManage && <DeleteButton />}
    {canManage && <ArchiveButton />}
  </>
);

// After — each action gets its own permission id, no more lumping
const canUpdate = useCan('bam.project.update');
const canDelete = useCan('bam.project.delete');
const canArchive = useCan('bam.project.archive');
return (
  <>
    {canUpdate && <EditButton />}
    {canDelete && <DeleteButton />}
    {canArchive && <ArchiveButton />}
  </>
);
```

### Pattern 4: finding the right permission id

Open `packages/permissions/src/generated/permissions.ts`, search for the
resource (e.g. `task`), and pick the matching verb. If your action doesn't
map cleanly to a single permission, it's a sign the permission catalog
should grow — file a follow-up rather than reusing a near-miss id. The
catalog is the contract the resolver and the matrix agree on; reusing a
wrong id will be silently wrong both client-side AND server-side.

## What stays as-is

- `is_superuser` checks in JSX (e.g. `if (user.is_superuser) { ... }`).
  SuperUser is a global bypass flag, not a permission — the matrix
  already reflects it (every entry resolves true), so technically the
  hook would work, but the legacy `is_superuser` JSX checks are typically
  for *labelling* ("you are viewing as SuperUser") rather than *gating*
  access. Wave E.D decides per call site whether to replace those.
- The `role` field on the auth response. Wave E.F drops the legacy column
  once every SPA has migrated off it.
- The auth store. The matrix is fetched separately and lives in
  TanStack Query, not Zustand. Existing `useAuthStore` consumers keep
  working unchanged.

## Cache invalidation

The hook refetches on:

- Window focus (TanStack Query default at `refetchOnWindowFocus: true`).
- Manual `queryClient.invalidateQueries({ queryKey: ['permissions', 'matrix'] })`.
- A 5-minute stale time triggering a background refetch.

The server-side `perms:matrix:<user_id>:<org_id>` Redis cache shares
invalidation with the resolver context cache: when a permission editor
writes to `account_permissions` or `permission_group_defaults`, it
publishes `perms:invalidate:user:<id>` and the API drops both caches.
Refetch-on-focus is sufficient to pick up the new matrix on the next user
interaction; an explicit websocket-driven invalidation can be added later
if 5-min staleness becomes a problem in practice.

## File locations

- Hook + types: `packages/ui/use-can.tsx`
- Provider + context: `packages/ui/permissions-context.tsx`
- Backend matrix builder: `apps/api/src/services/permissions.service.ts`
  (`computePermissionMatrix`)
- `/auth/me` augmentation: `apps/api/src/routes/auth.routes.ts`
- Canonical permission ids: `packages/permissions/src/generated/permissions.ts`
