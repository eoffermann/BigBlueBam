import { useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronRight,
  Download,
  FileBox,
  Folder,
  FolderPlus,
  Inbox,
  Layers,
  Loader2,
  Plus,
  Tag,
  Upload,
  X,
} from 'lucide-react';
import {
  useAssets,
  useCreateFolder,
  useFolders,
  useTags,
  useUpdateAsset,
  useUploadAsset,
  type BinAsset,
  type BinFolder,
  type ScanStatus,
} from '@/hooks/use-bin';
import { api } from '@/lib/api';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';

interface AssetLibraryPageProps {
  onNavigate: (path: string) => void;
}

// The pseudo-selection for the folder panel: a real folder id, or one of the
// two synthetic scopes ("All assets" / "Root unfiled").
type FolderSelection = { kind: 'all' } | { kind: 'root' } | { kind: 'folder'; id: string };

const scanStatusStyles: Record<ScanStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  clean: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  infected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  skipped: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

function ScanBadge({ status }: { status: ScanStatus }) {
  return (
    <span
      className={cn(
        'inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize',
        scanStatusStyles[status] ?? scanStatusStyles.skipped,
      )}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Asset-kind classification — decides what a row click does.
// ---------------------------------------------------------------------------

type AssetKind = 'media' | 'structured' | 'other';

const STRUCTURED_EXTS = ['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml'];

function assetKind(asset: BinAsset): AssetKind {
  const ct = (asset.content_type ?? '').toLowerCase();
  if (ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/')) {
    return 'media';
  }
  if (/csv|json|yaml|ndjson/.test(ct)) {
    return 'structured';
  }
  const ext = asset.name.includes('.') ? asset.name.split('.').pop()?.toLowerCase() : undefined;
  if (ext && STRUCTURED_EXTS.includes(ext)) {
    return 'structured';
  }
  return 'other';
}

function DownloadButton({ asset }: { asset: BinAsset }) {
  const servable = asset.scan_status === 'clean' || asset.scan_status === 'skipped';
  if (!servable) {
    return (
      <span
        className="inline-flex items-center text-zinc-300 dark:text-zinc-600 cursor-not-allowed"
        title={`Not downloadable yet (scan status: ${asset.scan_status})`}
      >
        <Download className="h-4 w-4" />
      </span>
    );
  }
  return (
    <a
      href={api.rawUrl(`/v1/assets/${asset.id}/raw`)}
      download={asset.name}
      onClick={(e) => e.stopPropagation()}
      title={`Download ${asset.name}`}
      className="inline-flex items-center text-zinc-400 hover:text-primary-600 dark:hover:text-primary-400"
    >
      <Download className="h-4 w-4" />
    </a>
  );
}

// ---------------------------------------------------------------------------
// Folder tree (built client-side from the flat parent_id list).
// ---------------------------------------------------------------------------

interface FolderNode extends BinFolder {
  children: FolderNode[];
  depth: number;
}

function buildTree(folders: BinFolder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) {
    byId.set(f.id, { ...f, children: [], depth: 0 });
  }
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Assign depth + sort siblings alphabetically.
  const walk = (nodes: FolderNode[], depth: number) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) {
      n.depth = depth;
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return roots;
}

function flattenTree(roots: FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (nodes: FolderNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

// Path from the root down to the given folder, for breadcrumbs.
function folderPath(folders: BinFolder[], id: string): BinFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: BinFolder[] = [];
  let cur: BinFolder | undefined = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 100) {
    path.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return path;
}

function FolderPanel({
  flat,
  selection,
  onSelect,
  isLoading,
}: {
  flat: FolderNode[];
  selection: FolderSelection;
  onSelect: (sel: FolderSelection) => void;
  isLoading: boolean;
}) {
  const baseRow =
    'w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-left transition-colors';
  const active = 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300 font-medium';
  const idle = 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/60';

  return (
    <nav className="space-y-0.5">
      <button
        type="button"
        onClick={() => onSelect({ kind: 'all' })}
        className={cn(baseRow, selection.kind === 'all' ? active : idle)}
      >
        <Layers className="h-4 w-4 shrink-0" />
        <span className="truncate">All assets</span>
      </button>
      <button
        type="button"
        onClick={() => onSelect({ kind: 'root' })}
        className={cn(baseRow, selection.kind === 'root' ? active : idle)}
      >
        <Inbox className="h-4 w-4 shrink-0" />
        <span className="truncate">Root (unfiled)</span>
      </button>

      <div className="pt-2 mt-1 border-t border-zinc-100 dark:border-zinc-800">
        {isLoading ? (
          <div className="space-y-1 px-1 py-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 animate-pulse" />
            ))}
          </div>
        ) : flat.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-zinc-400">No folders yet.</p>
        ) : (
          flat.map((node) => {
            const isActive = selection.kind === 'folder' && selection.id === node.id;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelect({ kind: 'folder', id: node.id })}
                style={{ paddingLeft: `${0.625 + node.depth * 0.875}rem` }}
                className={cn(baseRow, isActive ? active : idle)}
                title={node.name}
              >
                <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                <span className="truncate">{node.name}</span>
              </button>
            );
          })
        )}
      </div>
    </nav>
  );
}

function TagChip({
  tag,
  active,
  onClick,
}: {
  tag: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
        active
          ? 'bg-primary-600 text-white'
          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700',
      )}
    >
      <Tag className="h-3 w-3" />
      {tag}
    </button>
  );
}

export function AssetLibraryPage({ onNavigate }: AssetLibraryPageProps) {
  const [selection, setSelection] = useState<FolderSelection>({ kind: 'all' });
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const foldersQuery = useFolders();
  const folders = foldersQuery.data?.data ?? [];
  const tree = useMemo(() => buildTree(folders), [folders]);
  const flat = useMemo(() => flattenTree(tree), [tree]);

  const tagsQuery = useTags();
  const tags = tagsQuery.data?.data ?? [];

  const createFolder = useCreateFolder();
  const updateAsset = useUpdateAsset();

  // Translate the panel selection into the `folder_id` query param.
  const folderParam =
    selection.kind === 'all' ? undefined : selection.kind === 'root' ? 'root' : selection.id;

  const { data, isLoading } = useAssets({
    folder_id: folderParam,
    tag: activeTag ?? undefined,
  });
  const assets = data?.data ?? [];

  const upload = useUploadAsset();
  const fileInput = useRef<HTMLInputElement>(null);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  // Breadcrumb segments for the current folder.
  const crumbs = selection.kind === 'folder' ? folderPath(folders, selection.id) : [];

  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const parent_id = selection.kind === 'folder' ? selection.id : null;
    createFolder.mutate(
      { name, parent_id },
      {
        onSuccess: () => {
          setNewFolderName('');
          setNewFolderOpen(false);
        },
      },
    );
  };

  // Move an asset to a folder (or root when value === ''). select onChange.
  const onMove = (asset: BinAsset, value: string) => {
    const folder_id = value === '' ? null : value;
    if (folder_id === asset.folder_id) return;
    updateAsset.mutate({ id: asset.id, patch: { folder_id } });
  };

  // Edit tags via a prefilled prompt; split on commas, trim, drop blanks.
  const onEditTags = (asset: BinAsset) => {
    const current = (asset.tags ?? []).join(', ');
    const next = window.prompt(`Tags for "${asset.name}" (comma-separated):`, current);
    if (next == null) return; // cancelled
    const parsed = Array.from(
      new Set(
        next
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    );
    updateAsset.mutate({ id: asset.id, patch: { tags: parsed } });
  };

  const onRowClick = (asset: BinAsset) => {
    const kind = assetKind(asset);
    if (kind === 'media') {
      // Bin is the file store; Bay is the review surface. Full-page hand-off.
      window.location.href = `/bay/review/${asset.id}`;
    } else if (kind === 'structured') {
      onNavigate(`/assets/${asset.id}`);
    }
    // 'other' → no-op (Download still works).
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Bin — Asset Library</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Browse files and datasets by folder. Open a media file to review it in Bay; open a
            structured file to view its data.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <input ref={fileInput} type="file" className="hidden" onChange={onPick} />
          <button
            type="button"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {upload.isPending ? 'Uploading…' : 'Upload file'}
          </button>
          {upload.isError && (
            <span className="text-xs text-red-500">
              {upload.error instanceof Error ? upload.error.message : 'Upload failed'}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)] gap-6">
        {/* Folder panel */}
        <aside className="md:sticky md:top-6 md:self-start">
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Folders
            </h2>
            <button
              type="button"
              onClick={() => setNewFolderOpen((v) => !v)}
              title="New folder"
              className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400"
            >
              <FolderPlus className="h-3.5 w-3.5" /> New
            </button>
          </div>

          {newFolderOpen && (
            <div className="mb-2 flex items-center gap-1.5">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitNewFolder();
                  else if (e.key === 'Escape') {
                    setNewFolderOpen(false);
                    setNewFolderName('');
                  }
                }}
                placeholder={
                  selection.kind === 'folder' ? 'Subfolder name…' : 'Folder name…'
                }
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary-500/30"
              />
              <button
                type="button"
                onClick={submitNewFolder}
                disabled={createFolder.isPending || !newFolderName.trim()}
                className="inline-flex items-center rounded-lg bg-primary-600 hover:bg-primary-700 text-white p-1.5 disabled:opacity-50"
                title="Create folder"
              >
                {createFolder.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </button>
            </div>
          )}
          {createFolder.isError && (
            <p className="mb-2 px-1 text-xs text-red-500">
              {createFolder.error instanceof Error ? createFolder.error.message : 'Could not create folder'}
            </p>
          )}

          <FolderPanel
            flat={flat}
            selection={selection}
            onSelect={setSelection}
            isLoading={foldersQuery.isLoading}
          />
        </aside>

        {/* Main column */}
        <div className="min-w-0">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 mb-3 text-sm text-zinc-500 dark:text-zinc-400 flex-wrap">
            <button
              type="button"
              onClick={() => setSelection({ kind: 'all' })}
              className="hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              {selection.kind === 'root' ? 'Root (unfiled)' : 'All assets'}
            </button>
            {crumbs.map((c, i) => (
              <span key={c.id} className="inline-flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" />
                <button
                  type="button"
                  onClick={() => setSelection({ kind: 'folder', id: c.id })}
                  className={cn(
                    i === crumbs.length - 1
                      ? 'font-medium text-zinc-800 dark:text-zinc-200'
                      : 'hover:text-zinc-800 dark:hover:text-zinc-200',
                  )}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>

          {/* Tag filter */}
          {(tags.length > 0 || activeTag) && (
            <div className="flex items-center gap-1.5 mb-4 flex-wrap">
              <span className="text-xs font-medium text-zinc-400 mr-0.5 inline-flex items-center gap-1">
                <Tag className="h-3.5 w-3.5" /> Tags:
              </span>
              {tags.map((t) => (
                <TagChip
                  key={t}
                  tag={t}
                  active={activeTag === t}
                  onClick={() => setActiveTag((cur) => (cur === t ? null : t))}
                />
              ))}
              {activeTag && (
                <button
                  type="button"
                  onClick={() => setActiveTag(null)}
                  className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                >
                  <X className="h-3 w-3" /> clear
                </button>
              )}
            </div>
          )}

          {isLoading ? (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-12 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 animate-pulse"
                />
              ))}
            </div>
          ) : assets.length === 0 ? (
            <div className="text-center py-16 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
              <Archive className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">No assets here</h3>
              <p className="text-sm text-zinc-500 mt-1">
                {activeTag
                  ? 'No assets match this tag. Clear the tag filter or pick another folder.'
                  : selection.kind === 'folder'
                    ? 'This folder is empty. Move assets here or upload a new file.'
                    : 'Use Upload file to add files or datasets — they will appear here.'}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 dark:bg-zinc-800/60 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Tags</th>
                    <th className="px-4 py-3 text-right">Size</th>
                    <th className="px-4 py-3">Scan status</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => {
                    const kind = assetKind(asset);
                    const clickable = kind === 'media' || kind === 'structured';
                    return (
                      <tr
                        key={asset.id}
                        onClick={clickable ? () => onRowClick(asset) : undefined}
                        className={cn(
                          'border-t border-zinc-100 dark:border-zinc-800 transition-colors',
                          clickable
                            ? 'hover:bg-primary-50/50 dark:hover:bg-primary-900/10 cursor-pointer'
                            : 'cursor-default',
                        )}
                        title={
                          kind === 'media'
                            ? 'Open in Bay for review'
                            : kind === 'structured'
                              ? 'Open data view'
                              : undefined
                        }
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <FileBox className="h-4 w-4 text-primary-500 shrink-0" />
                            <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                              {asset.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                          <code className="text-xs">{asset.content_type ?? '—'}</code>
                        </td>
                        <td className="px-4 py-3">
                          {asset.tags?.length ? (
                            <div className="flex flex-wrap gap-1 max-w-[14rem]">
                              {asset.tags.map((t) => (
                                <span
                                  key={t}
                                  className="inline-flex items-center gap-1 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 px-2 py-0.5 text-[11px] font-medium"
                                >
                                  <Tag className="h-2.5 w-2.5" />
                                  {t}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-zinc-300 dark:text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">
                          {formatBytes(asset.size)}
                        </td>
                        <td className="px-4 py-3">
                          <ScanBadge status={asset.scan_status} />
                        </td>
                        <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                          {formatRelativeTime(asset.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div
                            className="flex items-center justify-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <select
                              aria-label={`Move ${asset.name} to folder`}
                              title="Move to folder"
                              value={asset.folder_id ?? ''}
                              disabled={updateAsset.isPending}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => onMove(asset, e.target.value)}
                              className="max-w-[9rem] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-1.5 py-1 text-xs text-zinc-600 dark:text-zinc-300 outline-none focus:ring-2 focus:ring-primary-500/30 disabled:opacity-50"
                            >
                              <option value="">Root (unfiled)</option>
                              {flat.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {`${'  '.repeat(f.depth)}${f.name}`}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              title="Edit tags"
                              disabled={updateAsset.isPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                onEditTags(asset);
                              }}
                              className="inline-flex items-center text-zinc-400 hover:text-primary-600 dark:hover:text-primary-400 disabled:opacity-50"
                            >
                              <Tag className="h-4 w-4" />
                            </button>
                            <DownloadButton asset={asset} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {updateAsset.isError && (
            <p className="text-xs text-red-500 mt-2">
              {updateAsset.error instanceof Error ? updateAsset.error.message : 'Update failed'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
