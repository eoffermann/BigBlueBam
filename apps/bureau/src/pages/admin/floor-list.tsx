/**
 * Admin floor list — the index for /admin/floors.
 *
 * Lands a user here when they hit the Admin → Floors sidebar entry.
 * They see every floor in the org (live occupancy counts), can edit
 * each one via the in-canvas editor at /admin/floors/:id, can spin up
 * a fresh floor with one click, and can archive floors they no longer
 * want surfaced on the member-side floor list.
 *
 * Permission gating mirrors floor-editor.tsx: org admins/owners and
 * SuperUsers. Anyone else gets a friendly access-denied panel —
 * better than letting them load the list and silently 403 on every
 * write.
 */

import { useState } from 'react';
import {
  useMutation,
  useQueryClient,
  useQuery,
} from '@tanstack/react-query';
import {
  Building2,
  DoorOpen,
  Loader2,
  Plus,
  Shield,
  Trash2,
  Pencil,
  Users,
  Archive,
  ArchiveRestore,
  AlertTriangle,
  X,
} from 'lucide-react';
import { api, BureauApiError } from '@/lib/api';
import { useAuthStore, type BureauUser } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}
function canEditFloors(user: BureauUser | null): boolean {
  if (!user) return false;
  if (user.is_superuser) return true;
  return roleLevel(user.role) >= roleLevel('admin');
}

interface AdminFloorRow {
  id: string;
  name: string;
  slug: string;
  background_url: string | null;
  position: number;
  is_default: boolean;
  occupancy: number;
  archived_at: string | null;
}

interface AdminFloorListResponse {
  data: AdminFloorRow[];
}

interface CreateFloorBody {
  name: string;
  slug?: string;
  building_id?: string | null;
  layout?: Record<string, unknown>;
}

interface AdminFloorListPageProps {
  onNavigate: (path: string) => void;
}

/** Build a URL-safe slug from a free-text name. Mirrors the suite's
 *  in-flight slug convention: lowercase ASCII alphanumerics + dashes.
 *  Server-side validation tightens this further; here we just need a
 *  reasonable default for the create dialog. */
function defaultSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function AdminFloorListPage({ onNavigate }: AdminFloorListPageProps) {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['bureau', 'admin', 'floors'],
    queryFn: async () => {
      // GET /floors returns archived rows too when the caller is an admin
      // — the bureau-api filters by archived_at for the member view but
      // the admin needs to see + unarchive them. If the API ever splits
      // these into separate routes we'd swap the endpoint here without
      // touching the rest of the page.
      const res = await api<AdminFloorListResponse>('/floors?include_archived=1');
      return res.data;
    },
    enabled: canEditFloors(user),
  });

  const createMutation = useMutation({
    mutationFn: async (body: CreateFloorBody) => {
      const res = await api<{ data: AdminFloorRow }>('/floors', {
        method: 'POST',
        body,
      });
      return res.data;
    },
    onSuccess: (row) => {
      setShowCreate(false);
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['bureau', 'admin', 'floors'] });
      queryClient.invalidateQueries({ queryKey: ['bureau', 'floors'] });
      onNavigate(`/admin/floors/${row.id}`);
    },
    onError: (err) => {
      const msg = err instanceof BureauApiError ? err.message : String(err);
      setErrorMessage(msg);
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (floorId: string) => {
      await api(`/floors/${floorId}`, { method: 'DELETE' });
      return floorId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bureau', 'admin', 'floors'] });
      queryClient.invalidateQueries({ queryKey: ['bureau', 'floors'] });
    },
    onError: (err) => {
      const msg = err instanceof BureauApiError ? err.message : String(err);
      setErrorMessage(msg);
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: async (floorId: string) => {
      await api(`/floors/${floorId}`, {
        method: 'PATCH',
        body: { archived_at: null },
      });
      return floorId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bureau', 'admin', 'floors'] });
      queryClient.invalidateQueries({ queryKey: ['bureau', 'floors'] });
    },
    onError: (err) => {
      const msg = err instanceof BureauApiError ? err.message : String(err);
      setErrorMessage(msg);
    },
  });

  if (!canEditFloors(user)) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-6 flex items-start gap-3">
          <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Floor administration requires admin or owner
            </h3>
            <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
              Ask the org owner to give you the admin role, or follow up via
              your SuperUser. You can still visit floors as a member from the
              regular Floors list.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (listQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (listQuery.error) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Failed to load floors: {(listQuery.error as Error).message}
          </div>
        </div>
      </div>
    );
  }

  const floors = listQuery.data ?? [];
  const liveFloors = floors.filter((f) => !f.archived_at);
  const archivedFloors = floors.filter((f) => f.archived_at);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            Admin · Floors
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Create new floors, edit room layouts, archive ones you don&apos;t
            want surfaced any more. Member-side floor list shows only the live
            ones.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New floor
        </button>
      </div>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300 flex-1">
            {errorMessage}
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-700 dark:text-red-300 hover:opacity-70"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {floors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <Building2 className="mx-auto h-10 w-10 text-zinc-400" />
          <h3 className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            No floors yet
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Click <span className="font-medium">New floor</span> above to
            create the first one. Bureau ships a seeded demo floor on first
            install, so this state usually only appears in fresh dev DBs.
          </p>
        </div>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500 mb-3">
              Live floors ({liveFloors.length})
            </h2>
            {liveFloors.length === 0 ? (
              <p className="text-sm text-zinc-500 italic">
                Every floor is archived. Restore one below or create a new one.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {liveFloors.map((f) => (
                  <FloorCard
                    key={f.id}
                    floor={f}
                    onEdit={() => onNavigate(`/admin/floors/${f.id}`)}
                    onPreview={() => onNavigate(`/floors/${f.id}`)}
                    onArchive={() => {
                      if (
                        window.confirm(
                          `Archive "${f.name}"? Members won't see it on the floor list any more; you can restore it later from this page.`,
                        )
                      ) {
                        archiveMutation.mutate(f.id);
                      }
                    }}
                    archiveBusy={archiveMutation.isPending}
                  />
                ))}
              </div>
            )}
          </section>

          {archivedFloors.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500 mb-3">
                Archived ({archivedFloors.length})
              </h2>
              <div className="space-y-2">
                {archivedFloors.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-2.5"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Archive className="h-4 w-4 text-zinc-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">
                          {f.name}
                        </p>
                        <p className="text-xs text-zinc-500 truncate">
                          {f.slug} · archived{' '}
                          {f.archived_at ? new Date(f.archived_at).toLocaleDateString() : ''}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => unarchiveMutation.mutate(f.id)}
                      disabled={unarchiveMutation.isPending}
                      className="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
                    >
                      <ArchiveRestore className="h-3.5 w-3.5" />
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {showCreate && (
        <CreateFloorDialog
          onCancel={() => setShowCreate(false)}
          onSubmit={(body) => createMutation.mutate(body)}
          busy={createMutation.isPending}
        />
      )}
    </div>
  );
}

interface FloorCardProps {
  floor: AdminFloorRow;
  onEdit: () => void;
  onPreview: () => void;
  onArchive: () => void;
  archiveBusy: boolean;
}

function FloorCard({ floor, onEdit, onPreview, onArchive, archiveBusy }: FloorCardProps) {
  return (
    <div className="group rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors flex flex-col">
      <button
        onClick={onEdit}
        className="text-left p-4 flex-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        <div className="flex items-center gap-2 mb-1">
          <Building2 className="h-4 w-4 text-zinc-400" />
          <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {floor.name}
          </span>
          {floor.is_default && (
            <span className="text-[10px] font-medium uppercase tracking-wide rounded bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400 px-1.5 py-0.5">
              default
            </span>
          )}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-500 truncate">
          {floor.slug}
        </div>
        <div className="flex items-center gap-3 mt-3 text-xs text-zinc-500 dark:text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" />
            {floor.occupancy} {floor.occupancy === 1 ? 'person' : 'people'}
          </span>
          {floor.background_url && (
            <span className="inline-flex items-center gap-1">
              <DoorOpen className="h-3 w-3" />
              has underlay
            </span>
          )}
        </div>
      </button>
      <div className="border-t border-zinc-200 dark:border-zinc-800 px-3 py-2 flex items-center gap-1 text-xs">
        <button
          onClick={onEdit}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-600 dark:text-zinc-400',
            'hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
          )}
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
        <button
          onClick={onPreview}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-600 dark:text-zinc-400',
            'hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
          )}
        >
          <DoorOpen className="h-3 w-3" />
          Preview as member
        </button>
        <button
          onClick={onArchive}
          disabled={archiveBusy}
          className={cn(
            'ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-red-600 dark:text-red-400',
            'hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-40',
          )}
        >
          <Trash2 className="h-3 w-3" />
          Archive
        </button>
      </div>
    </div>
  );
}

interface CreateFloorDialogProps {
  onCancel: () => void;
  onSubmit: (body: CreateFloorBody) => void;
  busy: boolean;
}

function CreateFloorDialog({ onCancel, onSubmit, busy }: CreateFloorDialogProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  const effectiveSlug = slugTouched ? slug : defaultSlug(name);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(defaultSlug(value));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit({
      name: trimmed,
      slug: effectiveSlug,
      layout: { rooms: [] },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-6"
      >
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            New floor
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          Starts empty. You&apos;ll drop in rooms with the canvas editor on the
          next screen.
        </p>
        <div className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
              autoFocus
              maxLength={120}
              placeholder="e.g. Engineering 3F"
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Slug
            </span>
            <input
              type="text"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              maxLength={140}
              pattern="[a-z0-9-]+"
              placeholder="auto-generated from name"
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <span className="block text-xs text-zinc-500 dark:text-zinc-500 mt-1">
              Used in the floor URL: /floors/<code>{effectiveSlug || '…'}</code>
            </span>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Create + open editor
          </button>
        </div>
      </form>
    </div>
  );
}
