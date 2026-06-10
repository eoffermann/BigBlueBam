import { useState } from 'react';
import {
  Link2,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  ExternalLink,
  Globe,
  LayoutDashboard,
  FileText,
  PenTool,
  LayoutGrid,
  Handshake,
  Headset,
  type LucideIcon,
} from 'lucide-react';
import type { TaskLink, TaskLinkInput } from '@bigbluebam/shared';
import { Button } from '@/components/common/button';

// CSV-import plan §4.2: the task-drawer Links section. Renders the task's
// `links` array (TaskLink[]) as rows with an owning-app/favicon-style icon,
// a title-or-hostname label, and an external-open affordance, plus add /
// inline-edit / remove controls. Persistence is delegated to the caller via
// `onChange`, which mirrors the existing drawer pattern of PATCHing the task
// with the full links array (links is already accepted by updateTask — we
// never touch the wire contract).

interface TaskLinksSectionProps {
  links: TaskLink[];
  /** Persist the full, replacement links array (sent as TaskLinkInput[]). */
  onChange: (links: TaskLinkInput[]) => void;
  /** When false, hide all mutation affordances (e.g. no edit permission). */
  editable?: boolean;
}

// Suite-internal path → owning app's launchpad icon. Order matters only in
// that each prefix is checked against the URL's pathname; the first hit wins.
// Anything not matching a suite prefix renders as a generic external link.
const SUITE_APP_ICONS: { prefix: string; icon: LucideIcon; label: string }[] = [
  { prefix: '/b3/', icon: LayoutDashboard, label: 'Bam' },
  { prefix: '/brief/', icon: FileText, label: 'Brief' },
  { prefix: '/blueprint/', icon: PenTool, label: 'Blueprint' },
  { prefix: '/board/', icon: LayoutGrid, label: 'Board' },
  { prefix: '/bond/', icon: Handshake, label: 'Bond' },
  { prefix: '/helpdesk/', icon: Headset, label: 'Helpdesk' },
];

interface ParsedUrl {
  hostname: string;
  pathname: string;
  isInternal: boolean;
}

function parseUrl(rawUrl: string): ParsedUrl | null {
  try {
    // Suite-internal links are stored either as absolute URLs on this origin
    // or (rarely) as root-relative paths. Resolve against the current origin
    // so a "/brief/…" path still parses and reports the right pathname.
    const u = new URL(rawUrl, window.location.origin);
    const isInternal = u.origin === window.location.origin;
    return { hostname: u.hostname, pathname: u.pathname, isInternal };
  } catch {
    return null;
  }
}

function iconForUrl(rawUrl: string): { Icon: LucideIcon; appLabel: string | null } {
  const parsed = parseUrl(rawUrl);
  if (parsed?.isInternal) {
    const match = SUITE_APP_ICONS.find((a) => parsed.pathname.startsWith(a.prefix));
    if (match) return { Icon: match.icon, appLabel: match.label };
  }
  return { Icon: Globe, appLabel: null };
}

/** Fallback display label when a link has no title: the hostname, or the raw URL. */
function displayLabel(link: TaskLink): string {
  if (link.title?.trim()) return link.title.trim();
  const parsed = parseUrl(link.url);
  if (parsed) {
    const match = SUITE_APP_ICONS.find((a) => parsed.isInternal && parsed.pathname.startsWith(a.prefix));
    if (match) return `${match.label}: ${parsed.pathname}`;
    return parsed.hostname || link.url;
  }
  return link.url;
}

/** Prepend https:// to a bare host the same way import link-parsing will. */
function normalizeInputUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Root-relative suite paths are kept as-is so internal links round-trip.
  if (trimmed.startsWith('/')) return trimmed;
  return `https://${trimmed}`;
}

function isValidLinkUrl(raw: string): boolean {
  const normalized = normalizeInputUrl(raw);
  if (!normalized) return false;
  if (normalized.startsWith('/')) return true;
  try {
    const u = new URL(normalized);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// The full set of links becomes the new wire payload. We send only the
// fields the input schema needs (url, title, id) so the server restamps
// added_at/added_by/title_source; existing ids are preserved so the server
// keeps their original stamps.
function toInput(links: TaskLink[]): TaskLinkInput[] {
  return links.map((l) => ({ id: l.id, url: l.url, title: l.title }));
}

export function TaskLinksSection({ links, onChange, editable = true }: TaskLinksSectionProps) {
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const resetAdd = () => {
    setAdding(false);
    setNewUrl('');
    setNewTitle('');
    setAddError(null);
  };

  const handleAdd = () => {
    if (!isValidLinkUrl(newUrl)) {
      setAddError('Enter a valid http(s) URL');
      return;
    }
    const url = normalizeInputUrl(newUrl);
    if (links.some((l) => l.url === url)) {
      setAddError('That link is already on this task');
      return;
    }
    const next: TaskLinkInput[] = [
      ...toInput(links),
      { url, title: newTitle.trim() || null },
    ];
    onChange(next);
    resetAdd();
  };

  const handleStartEdit = (link: TaskLink) => {
    setEditingId(link.id);
    setEditUrl(link.url);
    setEditTitle(link.title ?? '');
    setEditError(null);
  };

  const handleSaveEdit = () => {
    if (!editingId) return;
    if (!isValidLinkUrl(editUrl)) {
      setEditError('Enter a valid http(s) URL');
      return;
    }
    const url = normalizeInputUrl(editUrl);
    if (links.some((l) => l.url === url && l.id !== editingId)) {
      setEditError('That link is already on this task');
      return;
    }
    const next: TaskLinkInput[] = links.map((l) =>
      l.id === editingId ? { id: l.id, url, title: editTitle.trim() || null } : { id: l.id, url: l.url, title: l.title },
    );
    onChange(next);
    setEditingId(null);
    setEditError(null);
  };

  const handleRemove = (id: string) => {
    onChange(toInput(links.filter((l) => l.id !== id)));
    if (editingId === id) setEditingId(null);
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 flex items-center gap-1.5">
        <Link2 className="h-4 w-4" />
        Links
        {links.length > 0 && <span className="text-zinc-400">({links.length})</span>}
      </h3>

      {links.length > 0 && (
        <div className="space-y-2 mb-3">
          {links.map((link) => {
            const { Icon, appLabel } = iconForUrl(link.url);
            const isEditing = editingId === link.id;
            if (isEditing) {
              return (
                <div
                  key={link.id}
                  className="space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5 bg-zinc-50 dark:bg-zinc-800/40"
                >
                  <input
                    type="text"
                    autoFocus
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Title (optional)"
                    className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveEdit();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                  {editError && <p className="text-xs text-red-600 dark:text-red-400">{editError}</p>}
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSaveEdit}>
                      <Check className="h-3.5 w-3.5" />
                      Save
                    </Button>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={link.id}
                className="group flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
              >
                <Icon className="h-4 w-4 text-zinc-400 shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 truncate" title={link.title ?? link.url}>
                    {displayLabel(link)}
                  </p>
                  <p className="text-xs text-zinc-400 truncate" title={link.url}>
                    {appLabel ? `${appLabel} · ` : ''}
                    {link.url}
                    {link.title_source === 'fetched' && link.title == null ? ' · fetching title…' : ''}
                  </p>
                </div>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 rounded text-zinc-500 hover:text-primary-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  title="Open link"
                  aria-label={`Open ${displayLabel(link)} (opens in new tab)`}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
                {editable && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleStartEdit(link)}
                      className="p-1 rounded text-zinc-500 hover:text-primary-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      title="Edit link"
                      aria-label={`Edit ${displayLabel(link)}`}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(link.id)}
                      className="p-1 rounded text-zinc-500 hover:text-red-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      title="Remove link"
                      aria-label={`Remove ${displayLabel(link)}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editable &&
        (adding ? (
          <div className="space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5 bg-zinc-50 dark:bg-zinc-800/40">
            <input
              type="text"
              autoFocus
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://..."
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Title (optional)"
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
                if (e.key === 'Escape') resetAdd();
              }}
            />
            {addError && <p className="text-xs text-red-600 dark:text-red-400">{addError}</p>}
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={resetAdd}>
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button size="sm" disabled={!newUrl.trim()} onClick={handleAdd}>
                <Plus className="h-3.5 w-3.5" />
                Add Link
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-primary-600 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add a link
          </button>
        ))}
    </div>
  );
}
